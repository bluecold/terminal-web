import assert from 'node:assert';
import test, { describe } from 'node:test';
import type { Kline } from '../../services/api';
import { calculateFractalPivotsSeries, isMFLSSessionWindow } from '../indicators';
import { calculateMFLSSignal } from '../strategySignals';
import { buildMFLSContext, evaluateMFLSAt } from '../strategyEvaluators';
import { resolveOperationalTrade } from '../operationalTrade';
import { backtestMFLS, getStrategyForwardWindow, getStrategySignalWarmup } from '../backtester';
import { updateAlertsOutcome, type AuditAlertItem } from '../alertTracker';
import { simulateTrade, type TradeLevels } from '../tradeSimulator';
import { stampKlineSnapshot } from '../../services/marketDataSnapshot';
import { runQVESelection, getActionableStrategyCandidates, getInformationalStrategyCandidates } from '../tournament';
import { DEFAULT_FRICTION_PCT } from '../tradeLevels';

function makeSyntheticCandles(count: number, startPrice: number = 100, step: number = 0.1): Kline[] {
  const klines: Kline[] = [];
  const baseTimeSec = Math.floor(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000); // Wednesday 10:00 AM EDT (in NYSE session)
  let p = startPrice;

  for (let i = 0; i < count; i++) {
    const o = p;
    const c = p + step;
    const h = Math.max(o, c) + 0.3;
    const l = Math.min(o, c) - 0.3;
    const v = 5000;
    klines.push({
      time: baseTimeSec + i * 300,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    });
    p = c;
  }
  return klines;
}

function buildConfirmedMFLSTestCandles(): { klines: Kline[]; triggerIdx: number; support: number; sweepLow: number } {
  const klines = makeSyntheticCandles(90, 105, 0);

  // Deep drop into bar 45: price drops from 105 to 88
  for (let i = 35; i <= 44; i++) {
    klines[i].close = 105 - (i - 34) * 1.6;
    klines[i].open = klines[i].close + 0.5;
    klines[i].high = klines[i].open + 0.3;
    klines[i].low = klines[i].close - 0.3;
  }

  // Bar 45: Pivot low = 88.0
  klines[45].low = 88.0;
  klines[45].open = 89.0;
  klines[45].close = 88.5;
  klines[45].high = 89.5;

  // Bounce from bar 46 to 52 up to 93.0
  for (let i = 46; i <= 52; i++) {
    klines[i].close = 88.5 + (i - 45) * 0.7;
    klines[i].open = klines[i].close - 0.2;
    klines[i].high = klines[i].close + 0.3;
    klines[i].low = klines[i].open - 0.2;
  }

  // Imbalance descent into bar 57: 93.0 down to 88.3
  klines[53].open = 93.0; klines[53].close = 92.0; klines[53].high = 93.2; klines[53].low = 91.8;
  klines[54].open = 92.0; klines[54].close = 90.5; klines[54].high = 92.1; klines[54].low = 90.3;
  klines[55].open = 90.5; klines[55].close = 89.5; klines[55].high = 90.6; klines[55].low = 89.3;
  klines[56].open = 89.5; klines[56].close = 88.7; klines[56].high = 89.6; klines[56].low = 88.5;
  klines[57].open = 88.7; klines[57].close = 88.3; klines[57].high = 88.8; klines[57].low = 88.1;

  // Bar 58: Sweeps 88.0 with low = 87.70, reclaims strongly with close = 88.80
  klines[58].open = 88.3;
  klines[58].low = 87.70;
  klines[58].high = 89.0;
  klines[58].close = 88.80;
  klines[58].volume = 8000;

  // Forward bars (59 to 89) rally up to hit TP1 and TP2
  for (let i = 59; i < 90; i++) {
    const barP = 88.80 + (i - 58) * 0.45;
    klines[i].open = i === 59 ? 88.80 : barP - 0.1;
    klines[i].high = barP + 0.5;
    klines[i].low = barP - 0.2;
    klines[i].close = barP + 0.3;
    klines[i].volume = 5000;
  }

  return { klines, triggerIdx: 58, support: 88.0, sweepLow: 87.70 };
}

describe('Strategy #6: MACD Failure & Liquidity Sweep (MFLS)', () => {
  test('calculateFractalPivotsSeries enforces strict 2-candle confirmation with zero lookahead bias', () => {
    const klines = makeSyntheticCandles(15, 100, 0);
    // Candle 5: Peak high
    klines[5].high = 110;
    klines[5].close = 108;
    klines[4].high = 105;
    klines[3].high = 104;
    klines[6].high = 105;
    klines[7].high = 104;

    // Candle 9: Trough low
    klines[9].low = 90;
    klines[9].close = 92;
    klines[8].low = 95;
    klines[7].low = 96;
    klines[10].low = 95;
    klines[11].low = 96;

    const pivots = calculateFractalPivotsSeries(klines, 10);

    assert.notStrictEqual(pivots.swingHighs[5], 110, 'Fractal high 110 cannot be visible at bar 5');
    assert.notStrictEqual(pivots.swingHighs[6], 110, 'Fractal high 110 cannot be visible at bar 6');
    assert.strictEqual(pivots.swingHighs[7], 110, 'Fractal high at index 5 must be confirmed at bar 7 (i - 2)');
    assert.strictEqual(pivots.swingHighs[8], 110, 'Confirmed high must persist on subsequent bars');

    assert.notStrictEqual(pivots.swingLows[9], 90, 'Fractal low 90 cannot be visible at bar 9');
    assert.notStrictEqual(pivots.swingLows[10], 90, 'Fractal low 90 cannot be visible at bar 10');
    assert.strictEqual(pivots.swingLows[11], 90, 'Fractal low at index 9 must be confirmed at bar 11 (i - 2)');
  });

  test('MFLS detects Liquidity Sweep and Reclaim on Close for BUY', () => {
    const { klines, triggerIdx, support, sweepLow } = buildConfirmedMFLSTestCandles();
    const ctx = buildMFLSContext(klines, 'AAPL');
    const evalRes = evaluateMFLSAt(ctx, triggerIdx, 88.80);

    assert.strictEqual(evalRes.signal, 'BUY', 'Bar 58 must emit confirmed BUY signal');
    assert.strictEqual(evalRes.sweepPrice, sweepLow, 'Bar 58 sweepPrice must match candle low');
    assert.strictEqual(evalRes.pivotReference, support, 'Pivot reference must match confirmed pivot low');
    assert.strictEqual(evalRes.isReclaim, true, 'Bar 58 must be recognized as a reclaim on close');

    const liveSig = calculateMFLSSignal(klines.slice(0, triggerIdx + 1), 'AAPL', 88.80);
    assert.strictEqual(liveSig.signal, 'BUY');
    assert.strictEqual(liveSig.sweepPrice, evalRes.sweepPrice);
    assert.strictEqual(liveSig.isReclaim, evalRes.isReclaim);
  });

  test('Observation 2: MFLS rejects entry when live execution price invalidates the reclaim or pierces the sweep low', () => {
    const { klines, triggerIdx } = buildConfirmedMFLSTestCandles();
    const ctx = buildMFLSContext(klines, 'AAPL');

    // Valid trigger: at 88.80 (above support 88.0)
    const validRes = evaluateMFLSAt(ctx, triggerIdx, 88.80);
    assert.strictEqual(validRes.signal, 'BUY', 'Valid trigger price must emit BUY');

    // Case 1: Live price drops below the swept low (87.70), e.g. 87.60
    const belowSweepRes = evaluateMFLSAt(ctx, triggerIdx, 87.60);
    assert.strictEqual(belowSweepRes.signal, 'NEUTRAL', 'Live price <= sweep low must invalidate the setup');
    assert.strictEqual(belowSweepRes.discardReason, 'riskFilter');
    assert.ok(belowSweepRes.reasoning.includes('invalidado por precio'), 'Reasoning must state invalidation by price');

    // Case 2: Live price drops below the reclaimed support (88.0), e.g. 87.90
    const belowSupportRes = evaluateMFLSAt(ctx, triggerIdx, 87.90);
    assert.strictEqual(belowSupportRes.signal, 'NEUTRAL', 'Live price < support must invalidate the reclaim');
    assert.strictEqual(belowSupportRes.discardReason, 'riskFilter');

    // Case 3: Live price escapes excessively (> 1.8 ATR above support), e.g. 96.0
    const escapedRes = evaluateMFLSAt(ctx, triggerIdx, 96.0);
    assert.strictEqual(escapedRes.signal, 'NEUTRAL', 'Chasing price with excessive slippage must be rejected');
    assert.strictEqual(escapedRes.discardReason, 'riskFilter');
  });

  test('Observation 6 & 3: MFLS enforces anti-friction stop loss floor >= 0.40% on confirmed BUY signal against 0.11% friction', () => {
    const { klines, triggerIdx } = buildConfirmedMFLSTestCandles();
    const entryPrice = 88.80;
    const ctx = buildMFLSContext(klines, 'AAPL');
    const evalRes = evaluateMFLSAt(ctx, triggerIdx, entryPrice);

    // Verify signal is actually BUY, not NEUTRAL!
    assert.strictEqual(evalRes.signal, 'BUY', 'Evaluation must yield an actual BUY signal');
    assert.ok(evalRes.stopLoss > 0, 'Stop loss must be strictly positive');
    assert.ok(evalRes.stopLoss < entryPrice, 'Stop loss must be below entry price');

    // Stop loss distance must satisfy at least entryPrice * 0.0040 (0.40%)
    const minFloorDistance = entryPrice * 0.0040;
    const actualDistance = entryPrice - evalRes.stopLoss;

    assert.ok(
      actualDistance >= minFloorDistance * 0.999,
      `Stop loss distance (${actualDistance.toFixed(4)}) must meet or exceed 0.40% anti-friction floor (${minFloorDistance.toFixed(4)})`
    );

    // Verify roundtrip friction percentage of R with 0.08% commission + 0.03% slippage = 0.11% total
    const frictionR = 0.0011 / (actualDistance / entryPrice);
    assert.ok(
      frictionR <= 0.35,
      `Friction ${frictionR.toFixed(3)}R must be strictly <= 0.35R threshold`
    );
  });

  test('Observation 5: MFLS requires hasImbalance AND macdDivergence and dynamically describes confluence in reasoning', () => {
    const { klines, triggerIdx } = buildConfirmedMFLSTestCandles();
    const ctx = buildMFLSContext(klines, 'AAPL');
    const evalRes = evaluateMFLSAt(ctx, triggerIdx, 88.80);

    assert.strictEqual(evalRes.signal, 'BUY');
    assert.strictEqual(evalRes.hasImbalance, true, 'Imbalance must be verified');
    assert.strictEqual(evalRes.macdDivergence, true, 'MACD divergence must be verified');

    // Dynamic reasoning check
    assert.ok(
      evalRes.reasoning.includes('confluencia de fallo de MACD y divergencia RSI') ||
      evalRes.reasoning.includes('fallo de MACD confirmado'),
      `Reasoning must dynamically report the exact triggered divergences, got: ${evalRes.reasoning}`
    );
  });

  test('Observation 4: isMFLSSessionWindow restricts trading strictly to 09:45–15:30 EST', () => {
    // Wednesday July 15, 2026
    const baseDayUtc = Date.UTC(2026, 6, 15, 0, 0, 0); // Midnight UTC (EDT = UTC-4)
    const time0930 = baseDayUtc + (13 * 3600 + 30 * 60) * 1000;
    const time0944 = baseDayUtc + (13 * 3600 + 44 * 60) * 1000;
    const time0945 = baseDayUtc + (13 * 3600 + 45 * 60) * 1000;
    const time1030 = baseDayUtc + (14 * 3600 + 30 * 60) * 1000;
    const time1529 = baseDayUtc + (19 * 3600 + 29 * 60) * 1000;
    const time1530 = baseDayUtc + (19 * 3600 + 30 * 60) * 1000;
    const time1545 = baseDayUtc + (19 * 3600 + 45 * 60) * 1000;

    assert.strictEqual(isMFLSSessionWindow(time0930), false, '09:30 must be blocked in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time0944), false, '09:44 must be blocked in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time0945), true, '09:45 must be allowed in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time1030), true, '10:30 must be allowed in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time1529), true, '15:29 must be allowed in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time1530), false, '15:30 must be blocked in MFLS');
    assert.strictEqual(isMFLSSessionWindow(time1545), false, '15:45 must be blocked in MFLS');
  });

  test('resolveOperationalTrade cleanly constructs native MFLS trade plan', () => {
    const klines5m = makeSyntheticCandles(60, 150, 0.02);
    const plan = resolveOperationalTrade({
      strategy: 'mfls',
      signal: 'BUY',
      executionStyle: 'dayTrading',
      raw: { '5m': klines5m, '1h': [] },
      closed: { '5m': klines5m, '1h': [] },
      mfls: {
        signal: 'BUY',
        stopLoss: 147.0,
        takeProfit1: 154.7,
        takeProfit2: 158.2,
      },
      isCrypto: false,
    });

    assert.strictEqual(plan.valid, true, 'Operational trade plan must be valid');
    assert.strictEqual(plan.interval, '5m', 'MFLS must operate strictly on 5m interval');
    assert.ok(plan.levels.stopLoss < plan.entryPrice, 'Stop loss must be below entry price');
    assert.ok(plan.levels.takeProfit1 > plan.entryPrice, 'TP1 must be above entry price');
    assert.ok((plan.levels.takeProfit2 ?? 0) > plan.levels.takeProfit1, 'TP2 must be above TP1');
    assert.strictEqual(plan.validGeometry, true, 'Risk geometry must be strictly valid');
  });

  test('backtester metadata and forwardWindow canonical routing align for MFLS', () => {
    const fw = getStrategyForwardWindow('mfls', '5m', 'dayTrading');
    assert.strictEqual(fw, 24, 'MFLS forward window must be 24 bars (120 min) in 5m day trading');

    const warmup = getStrategySignalWarmup('mfls');
    assert.strictEqual(warmup, 30, 'MFLS warmup must be 30 bars for EMA/MACD stability');
  });

  test('Observation 6: backtestMFLS runs full simulation with two-tier scaling, 8-bar time stop, 0.08% friction, and verified trades', () => {
    const { klines } = buildConfirmedMFLSTestCandles();

    const bt = backtestMFLS(klines, '5m', 'AAPL');
    assert.strictEqual(bt.insufficient, false, 'Backtest must NOT return datos insuficientes');
    assert.strictEqual(bt.forwardWindow, 24, 'Forward window must be 24 bars');
    assert.ok(bt.totalSignals > 0, `Backtest must identify and simulate MFLS signals (got ${bt.totalSignals})`);
    assert.ok(bt.wins > 0, 'Backtest should execute the winning trade');
    assert.strictEqual(bt.winRate, 1.0, 'Single winning setup must yield 100% win rate');
    assert.ok(bt.expectancyR > 0, 'Expectancy R must be positive');
  });

  test('Observation 1: alertTracker and simulateTrade execute identical 2-tier exits without 5R phantom TP3', () => {
    const { klines, triggerIdx } = buildConfirmedMFLSTestCandles();
    const ctx = buildMFLSContext(klines, 'AAPL');
    const evalRes = evaluateMFLSAt(ctx, triggerIdx, 88.80);

    const levels: TradeLevels = {
      entryPrice: 88.80,
      stopLoss: evalRes.stopLoss,
      takeProfit1: evalRes.takeProfit1,
      takeProfit2: evalRes.takeProfit2,
    };

    // 1. Simulate trade with backtester engine
    const sim = simulateTrade(klines, triggerIdx, 'BUY', levels, {
      forwardWindow: 24,
      enablePartials: 'two-tier',
      timeStopBars: 16,
      timeStopMinR: 0.4,
      earlyAdverseCutoffBars: 3,
      earlyAdverseCutoffR: 0.5,
      frictionPct: DEFAULT_FRICTION_PCT,
      frictionModel: 'proportional',
    });

    // 2. Track alert in alertTracker
    const alertItem: AuditAlertItem = {
      id: 'test-mfls-parity',
      symbol: 'AAPL',
      interval: '5m',
      signal: 'BUY',
      time: '10:00',
      pf: null,
      strategy: 'MFLS (Reversión)',
      strategyKey: 'mfls',
      entryPrice: 88.80,
      stopLoss: evalRes.stopLoss,
      takeProfit1: evalRes.takeProfit1,
      takeProfit2: evalRes.takeProfit2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: klines[triggerIdx].time * 1000,
      candleTimestamp: klines[triggerIdx].time,
      executionStyle: 'dayTrading',
    };

    stampKlineSnapshot(klines, (klines[klines.length - 1].time + 300) * 1000);
    const updatedAlerts = updateAlertsOutcome([alertItem], { 'AAPL:5m': klines });
    const liveAlert = updatedAlerts[0];

    // Assert parity: both must register TP2_CLOSED without waiting for a phantom 5R TP3!
    assert.strictEqual(sim.status, 'TP2_CLOSED', 'simulateTrade must close at TP2 under two-tier scaling');
    assert.strictEqual(liveAlert.status, 'TP2_CLOSED', 'alertTracker must close at TP2 under two-tier scaling');
    assert.strictEqual(sim.realizedR, liveAlert.realizedR, 'Realized R must be exactly identical between tracker and backtester');
  });

  test('runQVESelection and getActionableStrategyCandidates integrate MFLS in 5m DayTrading tournament', () => {
    const klines5m = makeSyntheticCandles(80, 100, 0.01);
    const klines1h = makeSyntheticCandles(40, 100, 0.05);
    const klines1d = makeSyntheticCandles(30, 100, 0.2);
    const signals = {
      standard: 'NEUTRAL',
      confluencia: 'NEUTRAL',
      scoring: 'NEUTRAL',
      multitemporal: 'NEUTRAL',
      multifractal: 'NEUTRAL',
      mfls: 'BUY',
    };
    const withPositiveMfls = (symbol: string) => {
      const qve = runQVESelection({ symbol, data5m: klines5m, data1h: klines1h, data1d: klines1d, executionStyle: 'dayTrading' });
      const mflsCandidate = qve.candidates.find(c => c.key === 'mfls');
      assert.ok(mflsCandidate !== undefined, 'MFLS candidate must be present in DayTrading tournament');
      assert.strictEqual(mflsCandidate?.label, 'MFLS (Reversión)');
      mflsCandidate.expectancyR = 0.42;
      mflsCandidate.profitFactor = 2.1;
      mflsCandidate.resolved = 5;
      mflsCandidate.walkForward = undefined;
      return qve;
    };

    // Crypto 5m: MFLS keeps competing and is queued when it emits an actionable signal
    const cryptoQueue = getActionableStrategyCandidates(withPositiveMfls('BTCUSDT'), signals);
    const mflsInQueue = cryptoQueue.find(c => c.strategy === 'mfls');
    assert.ok(mflsInQueue !== undefined, 'MFLS must be queued when emitting actionable BUY signal');
    assert.strictEqual(mflsInQueue?.signal, 'BUY');

    // 5m equities: MFLS is informational — never in the actionable queue, always tracked as exploratory
    const equityQve = withPositiveMfls('MSFT');
    assert.strictEqual(getActionableStrategyCandidates(equityQve, signals).some(c => c.strategy === 'mfls'), false);
    const informational = getInformationalStrategyCandidates(equityQve, signals);
    assert.strictEqual(informational.length, 1);
    assert.strictEqual(informational[0].strategy, 'mfls');
    assert.strictEqual(informational[0].strategyLabel, 'MFLS (Reversión) (Informativa)');
    assert.strictEqual(informational[0].confidence, 'NONE');
  });
});
