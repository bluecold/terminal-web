import assert from 'node:assert/strict';
import test from 'node:test';
import { updateAlertsOutcome, type AuditAlertItem } from '../alertTracker';
import { simulateTrade } from '../tradeSimulator';
import type { Kline } from '../../services/api';
import { resolveOperationalTrade } from '../operationalTrade';
import { calculateAlertLevels } from '../tradeLevels';
import { evaluateMultifractalMTFAt, evaluateStandardVotingAt, getVCMETargetMultipliers, type StandardVotingContext } from '../strategyEvaluators';
import type { TradeExecutionState } from '../tradeSimulator';
import { getStrategyCooldownCandles, getStrategyCooldownMs, getStrategyForwardWindow } from '../backtester';

const time = 1_700_000_000;
const bar = (offset: number, open: number, high: number, low: number, close: number): Kline =>
  ({ time: time + offset * 300, open, high, low, close, volume: 100 });
const alert = (): AuditAlertItem => ({
  id: 'regression', symbol: 'TESTUSDT', interval: '5m', executionStyle: 'dayTrading',
  strategy: 'VCME Sniper', signal: 'BUY', status: 'OPEN', entryPrice: 100, stopLoss: 99,
  takeProfit1: 102, takeProfit2: 103.5, takeProfit3: 105, timestamp: time * 1000 + 60_000,
  candleTimestamp: time - 300, realizedR: 0, pnlPercent: 0, time: '', pf: null,
});
const update = (a: AuditAlertItem, bars: Kline[]) => updateAlertsOutcome([a], { 'TESTUSDT:5m': bars })[0];
const mirror = (k: Kline): Kline => ({ ...k, open: 200 - k.open, high: 200 - k.low, low: 200 - k.high, close: 200 - k.close });

for (const direction of ['BUY', 'SELL'] as const) {
  const position = (): AuditAlertItem => direction === 'BUY' ? alert() : {
    ...alert(), signal: 'SELL', stopLoss: 101, takeProfit1: 98, takeProfit2: 96.5, takeProfit3: 95,
  };
  const tape = (bars: Kline[]) => direction === 'BUY' ? bars : bars.map(mirror);
  test(`${direction}: replay and JSON reload cannot close on a pre-TP1 candle`, () => {
    const bars = tape([bar(0, 100, 100.2, 99.2, 99.5), bar(1, 100.5, 102.3, 100.2, 102.2)]);
    const first = update(position(), bars);
    assert.equal(first.status, 'TP1_HIT');
    const again = update(JSON.parse(JSON.stringify(first)) as AuditAlertItem, bars);
    assert.equal(again.status, first.status);
    assert.equal(again.pnlPercent, first.pnlPercent);
    assert.equal(again.realizedR, first.realizedR);
  });

  test(`${direction}: same-candle adverse move cannot erase an observed partial`, () => {
    const now = Date.now;
    Date.now = () => time * 1000 + 150_000;
    try {
      const first = update(position(), tape([bar(0, 100, 102.3, 99.2, 102.2)]));
      assert.equal(first.status, 'TP1_HIT');
      const next = update(first, tape([bar(0, 100, 102.3, 98.4, 98.5)]));
      assert.equal(next.status, 'TP1_BE_CLOSED');
      assert.ok(next.pnlPercent > -0.5, 'Only the remaining half may be stopped');
    } finally { Date.now = now; }
  });
}

test('tracker honors a persisted TP3 different from the default', () => {
  const a = { ...alert(), stopLoss: 90, takeProfit1: 102, takeProfit2: 110, takeProfit3: 115 };
  const result = update(a, [bar(0, 100, 116, 99, 116)]);
  assert.equal(result.status, 'TP2_CLOSED');
  assert.equal(result.pnlPercent, 7.14);
});

test('none disables trailing while chandelier retains its exit policy', () => {
  const levels = { entryPrice: 100, stopLoss: 90, takeProfit1: 102, takeProfit2: 110, takeProfit3: 150 };
  const bars = [bar(-1, 100, 100, 100, 100), bar(0, 100, 120, 99, 111)];
  const policy = { forwardWindow: 72, enablePartials: 'vcme-runner' as const, atrSeries: [2, 2], floatingClosePrice: 111 };
  assert.equal(simulateTrade(bars, 0, 'BUY', levels, { ...policy, trailingStop: 'none' }).status, 'TP2_HIT');
  assert.equal(simulateTrade(bars, 0, 'BUY', levels, { ...policy, trailingStop: 'chandelier' }).status, 'TP2_CLOSED');
});

test('a finalized historical revision cannot insert a fill into a checkpoint', () => {
  const bars = [bar(0, 100, 102.3, 99.2, 102.2)];
  const first = update(alert(), bars);
  const revised = update(first, [bar(0, 100, 106, 98, 98.5)]);
  assert.equal(revised.status, first.status);
  assert.deepEqual(revised.executionState?.fills, first.executionState?.fills);
});

for (const direction of ['BUY', 'SELL'] as const) {
  test(`${direction}: batch equals sequential checkpoints across 40 deterministic paths`, () => {
    for (let seed = 1; seed <= 40; seed++) {
      let random = seed;
      const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
      let price = 100;
      const bars = [bar(-1, 100, 100, 100, 100)];
      for (let i = 0; i < 20; i++) {
        const open = price + (next() - 0.5) * 0.8;
        price = open + (next() - 0.35) * 2;
        bars.push(bar(i, open, Math.max(open, price) + next(), Math.min(open, price) - next(), price));
      }
      const tape = direction === 'BUY' ? bars : bars.map(mirror);
      const levels = direction === 'BUY' ? alert() : { ...alert(), stopLoss: 101, takeProfit1: 98, takeProfit2: 96.5, takeProfit3: 95 };
      const policy = { forwardWindow: 10, enablePartials: 'vcme-runner' as const, trailingStop: 'none' as const };
      const batch = simulateTrade(tape, 0, direction, levels, { ...policy, floatingClosePrice: tape.at(-1)!.close });
      let checkpoint: TradeExecutionState | undefined;
      let sequential = batch;
      for (let count = 2; count <= tape.length; count++) {
        const prefix = tape.slice(0, count);
        sequential = simulateTrade(prefix, 0, direction, levels, { ...policy, executionState: checkpoint, floatingClosePrice: prefix.at(-1)!.close });
        checkpoint = JSON.parse(JSON.stringify(sequential.executionState)) as TradeExecutionState;
        const repeated = simulateTrade(prefix, 0, direction, levels, { ...policy, executionState: checkpoint, floatingClosePrice: prefix.at(-1)!.close });
        assert.equal(repeated.status, sequential.status);
        assert.equal(repeated.pnlPct, sequential.pnlPct);
        assert.ok(Math.abs(checkpoint.remaining + checkpoint.fills.reduce((sum, fill) => sum + fill.quantity, 0) - 1) < 1e-12);
        assert.deepEqual(repeated.executionState.fills, sequential.executionState.fills);
      }
      assert.equal(sequential.status, batch.status, `seed ${seed}`);
      assert.equal(sequential.pnlPct, batch.pnlPct, `seed ${seed}`);
      assert.equal(sequential.realizedR, batch.realizedR, `seed ${seed}`);
      assert.deepEqual(sequential.executionState.fills, batch.executionState.fills, `seed ${seed}`);
    }
  });
}

test('truncated rolling history preserves elapsed bars and expires at the original horizon', () => {
  const levels = { entryPrice: 100, stopLoss: 90, takeProfit1: 120 };
  const policy = { forwardWindow: 3, floatingClosePrice: 101 };
  const first = simulateTrade([bar(-1, 100, 100, 100, 100), bar(0, 100, 101.5, 99.5, 101), bar(1, 101, 101.5, 100.5, 101)], 0, 'BUY', levels, policy);
  const end = simulateTrade([bar(-1, 100, 100, 100, 100), bar(2, 101, 102, 100.5, 101)], 0, 'BUY', levels, { ...policy, executionState: first.executionState });
  assert.equal(end.status, 'EXPIRED');
  assert.equal(end.executionState.barsSeen, 3);
});

test('session and emergency exits still apply to resumed partials', () => {
  const levels = { entryPrice: 100, stopLoss: 90, takeProfit1: 102, takeProfit2: 110 };
  const initial = [bar(-1, 100, 100, 100, 100), bar(0, 100, 103.5, 100, 103)];
  const base = { forwardWindow: 72, enablePartials: 'vcme-runner' as const, floatingClosePrice: 103 };
  const first = simulateTrade(initial, 0, 'BUY', levels, base);
  const gap = simulateTrade([...initial, bar(200, 95, 151, 94, 150)], 0, 'BUY', levels, {
    ...base, executionState: first.executionState, sessionGapCutoff: true, stepSec: 300,
  });
  assert.equal(gap.exitReason, 'SESSION_GAP');
  assert.equal(gap.pnlPct, 2.37);
  const emergency = simulateTrade([...initial, bar(1, 103, 104, 101, 101.5)], 0, 'BUY', levels, {
    ...base, executionState: first.executionState, emergencyExitFn: k => k.close < 102,
  });
  assert.equal(emergency.exitReason, 'EMERGENCY_EXIT');
  assert.equal(emergency.executionState.remaining, 0);
});

test('closed-candle logic runs once when the same forming bar becomes final', () => {
  const levels = { entryPrice: 100, stopLoss: 90, takeProfit1: 120 };
  const bars = [bar(-1, 100, 100, 100, 100), bar(0, 100, 101, 99.5, 100)];
  const policy = { forwardWindow: 1, floatingClosePrice: 100 };
  const forming = simulateTrade(bars, 0, 'BUY', levels, { ...policy, isCandleClosed: () => false });
  assert.equal(forming.status, 'OPEN');
  const closed = simulateTrade(bars, 0, 'BUY', levels, { ...policy, executionState: forming.executionState, isCandleClosed: () => true });
  assert.equal(closed.status, 'EXPIRED');
  assert.equal(closed.executionState.barsSeen, 1);
});

test('an older observation cannot move a checkpoint backwards', () => {
  const tape = [bar(-1, 100, 100, 100, 100), bar(0, 100, 102.3, 99.2, 102.2)];
  const policy = { forwardWindow: 72, enablePartials: 'vcme-runner' as const, floatingClosePrice: 102.2, observedAtMs: 2000 };
  const first = simulateTrade(tape, 0, 'BUY', alert(), policy);
  const stale = simulateTrade([tape[0], bar(0, 100, 106, 98, 98.5)], 0, 'BUY', alert(), {
    ...policy, observedAtMs: 1000, floatingClosePrice: 98.5, executionState: first.executionState,
  });
  assert.equal(stale.pnlPct, first.pnlPct);
  assert.deepEqual(stale.executionState, first.executionState);
});

for (const direction of ['BUY', 'SELL'] as const) {
  test(`${direction}: TP2 inside a forming bar preserves 75% already executed on a deep reversal`, () => {
    const tape = (bars: Kline[]) => direction === 'BUY' ? bars : bars.map(mirror);
    const levels = direction === 'BUY' ? alert() : { ...alert(), stopLoss: 101, takeProfit1: 98, takeProfit2: 96.5, takeProfit3: 95 };
    const initial = tape([bar(-1, 100, 100, 100, 100), bar(0, 100, 103.8, 99.2, 103.6)]);
    const policy = { forwardWindow: 72, enablePartials: 'vcme-runner' as const, isCandleClosed: () => false, floatingClosePrice: initial[1].close };
    const first = simulateTrade(initial, 0, direction, levels, policy);
    assert.equal(first.status, 'TP2_HIT');
    assert.equal(first.executionState.remaining, 0.25);
    const next = simulateTrade(tape([bar(-1, 100, 100, 100, 100), bar(0, 100, 103.8, 98, 98.5)]), 0, direction, levels,
      { ...policy, executionState: first.executionState });
    assert.equal(next.status, 'TP2_CLOSED');
    assert.deepEqual(next.executionState.fills.slice(0, 2), first.executionState.fills);
    assert.equal(next.executionState.fills[2].quantity, 0.25);
    assert.equal(next.executionState.remaining, 0);
  });

  test(`${direction}: the TP2 stop cannot act on the earlier bar between TP1 and TP2`, () => {
    const tape = [bar(0, 100, 102.3, 99.2, 102.2), bar(1, 102.2, 102.5, 100.5, 101), bar(2, 101, 104, 100.5, 103.8)];
    const position = direction === 'BUY' ? alert() : { ...alert(), signal: 'SELL', stopLoss: 101, takeProfit1: 98, takeProfit2: 96.5, takeProfit3: 95 };
    const bars = direction === 'BUY' ? tape : tape.map(mirror);
    const first = update(position, bars);
    assert.equal(first.status, 'TP2_HIT');
    const again = update(JSON.parse(JSON.stringify(first)) as AuditAlertItem, bars);
    assert.equal(again.status, 'TP2_HIT');
    assert.equal(again.pnlPercent, first.pnlPercent);
    assert.deepEqual(again.executionState?.fills, first.executionState?.fills);
  });
}

test('legacy partials without dates migrate at the current quote, not on pre-TP extremes', () => {
  const bars = [bar(0, 100, 100.2, 98, 99.5), bar(1, 100.5, 102.3, 100.2, 102.2)];
  const first = update({ ...alert(), status: 'TP1_HIT' }, bars);
  assert.equal(first.status, 'TP1_HIT');
  assert.equal(first.tp1Time, undefined, 'Never substitute the signal timestamp for a fill timestamp');
  assert.equal(first.executionState?.fills[0].source, 'legacy');
  assert.equal(first.executionState?.historyQuality, 'legacy');
  assert.ok(first.executionWarning);
  const again = update(JSON.parse(JSON.stringify(first)) as AuditAlertItem, bars);
  assert.equal(again.status, first.status);
  assert.equal(again.pnlPercent, first.pnlPercent);
});

test('legacy TP2 with only TP1 dated does not apply the TP2 stop between the two fills', () => {
  const first = update({ ...alert(), status: 'TP2_HIT', tp1Time: time, activeSL: 102 }, [
    bar(0, 100, 102.3, 99.2, 102.2), bar(1, 102.2, 102.5, 100.5, 101), bar(2, 101, 104, 100.5, 103.8),
  ]);
  assert.equal(first.status, 'TP2_HIT');
  assert.equal(first.tp2Time, undefined);
  assert.equal(first.executionState?.remaining, 0.25);
});

const closedNative = Array.from({ length: 30 }, (_,i) => bar(i, 100, 100.5, 99.5, 100));
test('scanner/calculator share the native execution quote and reject inverted geometry', () => {
  const input = { strategy: 'multitemporal', signal: 'BUY', executionStyle: 'swing' as const,
    raw: { '1h': [...closedNative, bar(30, 100, 106, 99, 105)] }, closed: { '1h': closedNative },
    vcme: { signal: 'BUY', stopLoss: 104, takeProfit1: 107, takeProfit2: 108.5, takeProfit3: 110 } };
  const plan = resolveOperationalTrade(input);
  assert.equal(plan.entryPrice, 105);
  assert.equal(plan.levels.stopLoss, 104);
  assert.equal(plan.interval, '1h');
  assert.equal(plan.valid, true);
  const bad = resolveOperationalTrade({ ...input, vcme: { ...input.vcme, stopLoss: 106 } });
  assert.equal(bad.valid, false);
  assert.equal(bad.riskDistance, 0);
});

for (const strategy of ['standard', 'confluencia', 'scoring']) {
  test(`${strategy}: operational geometry uses its own ATR multiplier`, () => {
    const plan = resolveOperationalTrade({ strategy, signal: 'BUY', executionStyle: 'dayTrading', raw: { '5m': closedNative }, closed: { '5m': closedNative } });
    assert.equal(plan.valid, true);
    assert.deepEqual(plan.levels, { entryPrice: 100, ...calculateAlertLevels('BUY', 100, '5m', 1, strategy) });
  });
}

test('scoring: resolveOperationalTrade rejects BUY into resistance when entryPrice leaves insufficient R:R', () => {
  // Create 65 bars with a clear pivot high at 103 on bar 50
  const klines = Array.from({ length: 65 }, (_, i) => {
    if (i === 50) return bar(i, 100, 103, 99, 100);
    return bar(i, 100, 100.5, 99.5, 100);
  });
  // Raw forming candle has current price 101.50 -> entryPrice = 101.50
  // Nearest resistance is at 103, distance = 1.50, but TP1 is 103.77 (targetDist 2.27 > 1.50)
  const rawWithGap = [...klines, bar(65, 101.5, 102, 101, 101.5)];
  const plan = resolveOperationalTrade({
    strategy: 'scoring',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': rawWithGap },
    closed: { '5m': klines }
  });
  assert.equal(plan.valid, false, 'Trade should be rejected due to insufficient room to resistance');
  assert.equal(plan.srViable, false);
  assert.match(plan.reason, /insuficiente hacia resistencia/);

  // But if price breaks out above resistance (entryPrice = 103.50), it is allowed
  const rawBreakout = [...klines, bar(65, 103.5, 104, 103, 103.5)];
  const planBreakout = resolveOperationalTrade({
    strategy: 'scoring',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': rawBreakout },
    closed: { '5m': klines }
  });
  assert.equal(planBreakout.valid, true, 'Breakout trade past resistance should be approved');
  assert.equal(planBreakout.srViable, true);
});

test('Multifractal stays native 5m in Swing and publishes only its executed target', () => {
  const plan = resolveOperationalTrade({ strategy: 'multifractal', signal: 'BUY', executionStyle: 'swing',
    raw: { '5m': closedNative }, closed: { '5m': closedNative }, multifractal: { signal: 'BUY', stopLoss: 99 } });
  assert.equal(plan.interval, '5m');
  assert.equal(plan.levels.takeProfit1, 101.5);
  assert.equal(plan.levels.takeProfit2, undefined);
  assert.equal(resolveOperationalTrade({ strategy: 'NONE', signal: 'NEUTRAL', executionStyle: 'swing', raw: {}, closed: {} }).valid, false);
});

test('BUY equity: alert created at session close crossing weekend gap exits EXPIRED with R=0 and no false SL hit', () => {
  const fridayCloseTime = 1_700_000_000;
  const mondayOpenTime = fridayCloseTime + 65 * 3600; // Weekend gap of 65 hours
  const stockAlert: AuditAlertItem = {
    id: 'stock-gap-buy', symbol: 'AAPL', interval: '5m', executionStyle: 'dayTrading',
    strategy: 'VCME Sniper', signal: 'BUY', status: 'OPEN', entryPrice: 100, stopLoss: 98,
    takeProfit1: 104, takeProfit2: 106, takeProfit3: 108, timestamp: fridayCloseTime * 1000 + 30_000,
    candleTimestamp: fridayCloseTime, realizedR: 0, pnlPercent: 0, time: '', pf: null,
  };

  // Monday opens with a 3% gap down to 97 (below stopLoss 98)
  const mondayBars: Kline[] = [
    { time: mondayOpenTime, open: 97, high: 97.5, low: 96.5, close: 97, volume: 5000 },
    { time: mondayOpenTime + 300, open: 97, high: 97.8, low: 96.9, close: 97.5, volume: 3000 },
  ];

  const updated = updateAlertsOutcome([stockAlert], { 'AAPL:5m': mondayBars })[0];
  assert.equal(updated.status, 'EXPIRED');
  assert.equal(updated.realizedR, 0);
  assert.equal(updated.pnlPercent, 0);
  assert.ok(updated.executionWarning?.includes('Alerta no ejecutada'));
});

test('SELL equity: alert created at session close crossing weekend gap exits EXPIRED with R=0 and no false SL hit', () => {
  const fridayCloseTime = 1_700_000_000;
  const mondayOpenTime = fridayCloseTime + 65 * 3600;
  const stockAlert: AuditAlertItem = {
    id: 'stock-gap-sell', symbol: 'TSLA', interval: '5m', executionStyle: 'dayTrading',
    strategy: 'VCME Sniper', signal: 'SELL', status: 'OPEN', entryPrice: 100, stopLoss: 102,
    takeProfit1: 96, takeProfit2: 94, takeProfit3: 92, timestamp: fridayCloseTime * 1000 + 30_000,
    candleTimestamp: fridayCloseTime, realizedR: 0, pnlPercent: 0, time: '', pf: null,
  };

  // Monday opens with a 3% gap up to 103 (above stopLoss 102)
  const mondayBars: Kline[] = [
    { time: mondayOpenTime, open: 103, high: 104, low: 102.5, close: 103.5, volume: 5000 },
    { time: mondayOpenTime + 300, open: 103.5, high: 104, low: 103, close: 103.2, volume: 3000 },
  ];

  const updated = updateAlertsOutcome([stockAlert], { 'TSLA:5m': mondayBars })[0];
  assert.equal(updated.status, 'EXPIRED');
  assert.equal(updated.realizedR, 0);
  assert.equal(updated.pnlPercent, 0);
  assert.ok(updated.executionWarning?.includes('Alerta no ejecutada'));
});

test('equities in 5m dayTrading: resolveOperationalTrade generates viable plan with >=0.40% stop and passes friction', () => {
  // Normal 5m equity volatility (e.g. AAPL at $200 with ATR ~$0.20 -> 0.10%)
  const klines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 200,
    high: 200.15,
    low: 199.95,
    close: 200.05,
    volume: 5000,
  }));

  const plan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': klines },
    closed: { '5m': klines },
    isCrypto: false,
  });

  assert.equal(plan.valid, true, 'Normal 5m equity volatility must be operationally viable');
  assert.equal(plan.frictionViable, true, 'Must pass friction filter with nominal 0.11% fees');
  assert.ok(plan.riskDistance >= 0.00399, `Stop risk must be >= 0.40% floor (got ${(plan.riskDistance * 100).toFixed(2)}%)`);
  assert.ok(plan.levels.stopLoss < 200, 'Stop loss must be below entry for BUY');
  assert.ok(plan.levels.takeProfit1 > 200, 'Take profit must be above entry for BUY');
});

test('equities with dead-flat volatility (ATR < 0.06%): resolveOperationalTrade rejects due to excessive friction', () => {
  // Dead-flat stock (range 0.04 on price 100 -> ATR 0.04% < 0.06%)
  const microRangeKlines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 100.02,
    low: 99.98,
    close: 100,
    volume: 500,
  }));

  const plan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': microRangeKlines },
    closed: { '5m': microRangeKlines },
    isCrypto: false,
  });

  assert.equal(plan.valid, false, 'Micro-range flat stock must be rejected as unviable');
  assert.equal(plan.frictionViable, false, 'Friction filter must reject dead flat micro-stop');
  assert.ok(plan.reason.includes('fricción') || plan.reason.includes('comisiones'));
});

test('Multifractal MTF BREAKOUT_EXPANSION enforces structural midpoint stop and clean riskFilter discard', () => {
  const len = 25;
  const klines5m: Kline[] = Array.from({ length: len }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 101,
    low: 99.5,
    close: 100.8, // close > upper (100.5)
    volume: 3000,
  }));
  const lastIdx = len - 1;
  const volComp5M = Array.from({ length: len }, () => ({
    volume: 3000,
    smaVolume: 1500,
    isHighVolume: true,
    volumeMultiplier: 2.0,
    activeBuyPercent: 75,
    activeSellPercent: 25,
    isPassiveBuyAbsorption: false,
    isPassiveSellAbsorption: false,
  }));
  const atrSeries5M = new Array(len).fill(1.0);
  const dreadBlitz5M = Array.from({ length: len }, () => ({ isOverbought: false, isOversold: false, mcd: 0, upperBB: 2.0, lowerBB: -2.0 }));

  const baseCtx = {
    klines5m,
    klines1h: [],
    klines1d: [],
    symbol: 'AAPL',
    andianSeries: [{ green: 60, red: 40, orange: 50, bias: 'BULLISH' as const }],
    volBands1H: [{ width: 2, midpoint: 100, upper: 101, lower: 99, isCompressed: true, threshold: 3 }],
    volComp5M,
    dreadBlitz5M,
    atrSeries5M,
    adxData5M: { adx: [], plusDI: [], minusDI: [] },
    idx1hMap: new Int32Array(len).fill(0),
    idx1dMap: new Int32Array(len).fill(0),
  };

  // Scenario A: Band with midpoint 98.4 on price 100.8 -> distance 2.4 ATR (> 2.0 maxRisk)
  // Must cleanly discard as riskFilter without placing an arbitrary, unhedged stop inside the channel
  const wideBands = Array.from({ length: len }, () => ({
    upper: 100.5, lower: 96.3, midpoint: 98.4, width: 4.2, isCompressed: false, threshold: 5.0,
  }));
  const resWide = evaluateMultifractalMTFAt({ ...baseCtx, volBands5M: wideBands }, lastIdx, 100.8);
  assert.strictEqual(resWide.signal, 'NEUTRAL', 'Must discard trade when structural midpoint exceeds 2.0 ATR');
  assert.strictEqual(resWide.discardReason, 'riskFilter', 'Discard reason must be riskFilter');

  // Scenario B: Band with midpoint 99.2 on price 100.8 -> distance 1.6 ATR (<= 2.0 maxRisk)
  // Must emit BUY and place stopLoss exactly at the channel midpoint (99.20)
  const validBands = Array.from({ length: len }, () => ({
    upper: 100.5, lower: 97.9, midpoint: 99.2, width: 2.6, isCompressed: false, threshold: 5.0,
  }));
  const resValid = evaluateMultifractalMTFAt({ ...baseCtx, volBands5M: validBands }, lastIdx, 100.8);
  assert.strictEqual(resValid.signal, 'BUY', 'Must emit BUY when structural midpoint is within risk bounds');
  assert.strictEqual(resValid.strategy, 'BREAKOUT_EXPANSION');
  assert.strictEqual(resValid.stopLoss, 99.2, 'Stop loss must be placed exactly at channel midpoint');
});

test('Standard Voting: permits confluent mean-reversion BUY below EMA200 and preserves breakout in uptrend', () => {
  const len = 40;
  const lastIdx = 39;
  const klines: Kline[] = Array.from({ length: len }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 94.8,
    high: 95.5,
    low: 94.5,
    close: 95.2, // closePosition = (95.2 - 94.5) / 1.0 = 0.70 >= 0.45
    volume: 1500, // rvol = 1500 / 1000 = 1.5 >= 0.90
  }));

  // 1. Scenario A: Deep oversold dip below EMA200 (EMA200 = 100, close = 95.2)
  // RSI < 30 and curling up (22 -> 25)
  const rsiSeries = new Array(len).fill(50);
  rsiSeries[lastIdx - 3] = 22;
  rsiSeries[lastIdx] = 25;

  // Bollinger lower band pierced (lower = 96.0, close = 95.2 < 96.0)
  const bbSeries = Array.from({ length: len }, (_, i) => ({
    time: 1700000000 + i * 300,
    upper: 102,
    middle: 98,
    lower: 96.0,
    widthPercent: 6.0,
  }));

  const ctxOversold: StandardVotingContext = {
    klines,
    closes: klines.map(k => k.close),
    rsiSeries,
    macdSeries: { macd: new Array(len).fill(0), signal: new Array(len).fill(0), histogram: new Array(len).fill(0), signals: new Array(len).fill('NEUTRAL') },
    bbSeries,
    supertrendSeries: Array.from({ length: len }, () => ({ value: 100, direction: 'UP' as const, signal: 'NEUTRAL' as const })),
    stochRsiSeries: { k: new Array(len).fill(15), d: new Array(len).fill(15), signals: new Array(len).fill('NEUTRAL') },
    volSmaSeries: new Array(len).fill(1000),
    volSignalSeries: { values: new Array(len).fill('—'), signals: new Array(len).fill('NEUTRAL') },
    ema200Series: new Array(len).fill(100), // close (95.2) < EMA200 (100) -> trend is DOWN
  };

  const resOversold = evaluateStandardVotingAt(ctxOversold, lastIdx);
  assert.strictEqual(resOversold.buyVotes, 2, 'RSI (<30) and BB (<lower) must both vote BUY');
  assert.strictEqual(resOversold.sellVotes, 0);
  assert.strictEqual(resOversold.rawSignal, 'BUY', 'Margin of 2 with RVOL 1.5 and cp 0.70 must emit BUY');
  assert.strictEqual(resOversold.finalSignal, 'BUY', 'Confluent oversold reversal (RSI+BB) must NOT be vetoed by EMA200 gate');

  // 2. Scenario B: Uptrend Breakout (close = 105 > EMA200 = 95, close > bb.upper = 104 with RVOL = 1.5)
  // Bollinger Band must NOT vote SELL when walking bands in uptrend with volume
  const klinesBreakout = klines.map(k => ({ ...k, open: 104.2, high: 105.5, low: 104.0, close: 105.0, volume: 1500 }));
  const ctxBreakout: StandardVotingContext = {
    ...ctxOversold,
    klines: klinesBreakout,
    closes: klinesBreakout.map(k => k.close),
    ema200Series: new Array(len).fill(95), // close (105) > EMA200 (95) -> trend is UP
    bbSeries: Array.from({ length: len }, (_, i) => ({
      time: 1700000000 + i * 300,
      upper: 104.0,
      middle: 100,
      lower: 96.0,
      widthPercent: 8.0,
    })),
    // MACD and Supertrend vote BUY
    macdSeries: { macd: new Array(len).fill(0), signal: new Array(len).fill(0), histogram: new Array(len).fill(0), signals: new Array(len).fill('BUY') },
    supertrendSeries: Array.from({ length: len }, (_, i) => ({
      value: i === lastIdx ? 98 : 102,
      direction: (i === lastIdx ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
      signal: (i === lastIdx ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    })),
  };
  // Breakout RSI is 65 (healthy momentum)
  ctxBreakout.rsiSeries = new Array(len).fill(65);

  const resBreakout = evaluateStandardVotingAt(ctxBreakout, lastIdx);
  const bbInd = resBreakout.indicators.find(i => i.name === 'Bollinger Bands');
  assert.strictEqual(bbInd?.signal, 'NEUTRAL', 'Bollinger must NOT vote SELL during high-volume uptrend breakout');
  assert.strictEqual(resBreakout.finalSignal, 'BUY', 'Uptrend breakout with MACD + Supertrend must emit BUY cleanly');
});

test('VCME DayTrading time stop: gives trade 18 bars (90 min) and does not choke at bar 8', () => {
  const alertTime = 1700000000000;
  const vcmeAlert: AuditAlertItem = {
    id: 'vcme-day-timestop',
    symbol: 'NVDA',
    interval: '5m',
    executionStyle: 'dayTrading',
    signal: 'BUY',
    time: '10:00',
    pf: 2.0,
    strategy: 'VCME Sniper',
    entryPrice: 100,
    stopLoss: 98,
    takeProfit1: 104,
    takeProfit2: 107,
    takeProfit3: 110,
    status: 'OPEN',
    realizedR: 0,
    pnlPercent: 0,
    timestamp: alertTime
  };

  // 12 bars (1 hour): previously choked at bar 8 (40 min).
  // Under calibrated 18-bar (90 min) policy, it must remain OPEN.
  const bars12: Kline[] = Array.from({ length: 12 }, (_, i) => ({
    time: 1700000000 + (i + 1) * 300,
    open: 100.1,
    high: 100.5,
    low: 99.8,
    close: 100.2, // stagnant (< 0.5R = 101)
    volume: 500,
  }));

  const res12 = updateAlertsOutcome([vcmeAlert], { 'NVDA:5m': bars12 });
  assert.strictEqual(res12[0].status, 'OPEN', 'VCME DayTrading must remain OPEN at 12 bars (1 hour), well past previous 8-bar cutoff');

  // 18 bars (90 min): reaches calibrated time-stop and exits cleanly
  const bars18: Kline[] = Array.from({ length: 18 }, (_, i) => ({
    time: 1700000000 + (i + 1) * 300,
    open: 100.1,
    high: 100.5,
    low: 99.8,
    close: 100.2,
    volume: 500,
  }));

  const res18 = updateAlertsOutcome([vcmeAlert], { 'NVDA:5m': bars18 });
  assert.strictEqual(res18[0].status, 'EXPIRED', 'VCME DayTrading must exit as EXPIRED at bar 18 (90 min)');
  assert.strictEqual(res18[0].executionState?.exit?.reason, 'TIME_STOP', 'Exit reason must be TIME_STOP');
});

test('VCME DayTrading: calibrated 24-bar (2h) forwardWindow and 6-bar (30m) cooldown parity', () => {
  // 1. Verify canonical helpers
  assert.strictEqual(getStrategyForwardWindow('vcme', '5m', 'dayTrading'), 24, 'VCME Day Trading forward window must be 24 bars (2 hours)');
  assert.strictEqual(getStrategyCooldownCandles('5m'), 6, '5m dayTrading cooldown must be 6 bars (30 min)');
  assert.strictEqual(getStrategyCooldownMs('5m'), 1800000, '5m dayTrading cooldown ms must be 30 minutes');

  // 2. Alert with positive progress (>= 0.5R, so Time-Stop at bar 18 is not triggered)
  // Must run up to bar 24 (2 hours) and then expire on maximum strategy horizon
  const alertTime = 1700000000000;
  const runnerAlert: AuditAlertItem = {
    id: 'vcme-day-horizon-24',
    symbol: 'AAPL',
    interval: '5m',
    executionStyle: 'dayTrading',
    signal: 'BUY',
    time: '10:00',
    pf: 2.2,
    strategy: 'VCME Sniper',
    entryPrice: 100,
    stopLoss: 98,       // 2R risk = 2
    takeProfit1: 104,   // +2R
    takeProfit2: 107,
    takeProfit3: 110,
    status: 'OPEN',
    realizedR: 0,
    pnlPercent: 0,
    timestamp: alertTime
  };

  // 23 bars hovering at 101.2 (+0.6R, > 0.5R, so Time-Stop inactive)
  const bars23: Kline[] = Array.from({ length: 23 }, (_, i) => ({
    time: 1700000000 + (i + 1) * 300,
    open: 101.0,
    high: 101.5,
    low: 100.8,
    close: 101.2,
    volume: 500,
  }));
  const res23 = updateAlertsOutcome([runnerAlert], { 'AAPL:5m': bars23 });
  assert.strictEqual(res23[0].status, 'OPEN', 'At bar 23 (115 min) trade must still be OPEN');

  // 24 bars: reaches calibrated 2-hour forwardWindow and expires cleanly
  const bars24: Kline[] = Array.from({ length: 24 }, (_, i) => ({
    time: 1700000000 + (i + 1) * 300,
    open: 101.0,
    high: 101.5,
    low: 100.8,
    close: 101.2,
    volume: 500,
  }));
  const res24 = updateAlertsOutcome([runnerAlert], { 'AAPL:5m': bars24 });
  assert.strictEqual(res24[0].status, 'EXPIRED', 'At bar 24 (2 hours) trade must expire by TIMEOUT');
  assert.strictEqual(res24[0].executionState?.exit?.reason, 'TIMEOUT', 'Exit reason must be TIMEOUT');
});

test('VCME Sniper: DayTrading calibrates targets to 1.20R / 2.0R / 3.0R while Swing preserves 2.0R / 3.5R / 5.0R', () => {
  const dayMultipliers = getVCMETargetMultipliers('DAY');
  assert.strictEqual(dayMultipliers.tp1Mult, 1.20, 'DayTrading TP1 must be 1.20R');
  assert.strictEqual(dayMultipliers.tp2Mult, 2.0, 'DayTrading TP2 must be calibrated to 2.0R to match 24-candle window');
  assert.strictEqual(dayMultipliers.tp3Mult, 3.0, 'DayTrading TP3 must be calibrated to 3.0R');

  const swingMultipliers = getVCMETargetMultipliers('SWING');
  assert.strictEqual(swingMultipliers.tp1Mult, 2.0, 'Swing TP1 must be 2.0R');
  assert.strictEqual(swingMultipliers.tp2Mult, 3.5, 'Swing TP2 must be 3.5R');
  assert.strictEqual(swingMultipliers.tp3Mult, 5.0, 'Swing TP3 must be 5.0R');

  // Verify that an active VCME Day alert executes all 3 targets in order and yields +1.85R:
  const entry = 100;
  const sl = 98; // initialRisk = 2.0 (2.0%)
  const risk = entry - sl;
  const tp1 = entry + dayMultipliers.tp1Mult * risk; // 102.4 (+1.20R)
  const tp2 = entry + dayMultipliers.tp2Mult * risk; // 104.0 (+2.0R)
  const tp3 = entry + dayMultipliers.tp3Mult * risk; // 106.0 (+3.0R)

  const alertItem: AuditAlertItem = {
    id: 'vcme-calibrated-runner',
    symbol: 'AAPL',
    interval: '5m',
    signal: 'BUY',
    status: 'OPEN',
    strategy: 'VCME Sniper',
    entryPrice: entry,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    time: '10:00',
    timestamp: 1700000000000,
    pf: null,
    pnlPercent: 0,
    realizedR: 0,
  };

  const forwardBars: Kline[] = [
    { time: 1700000300, open: 100, high: 103.0, low: 100, close: 102.8, volume: 1000 },
    { time: 1700000600, open: 102.8, high: 104.5, low: 102.5, close: 104.2, volume: 1000 },
    { time: 1700000900, open: 104.2, high: 106.5, low: 103.8, close: 106.2, volume: 1000 },
  ];

  const res = updateAlertsOutcome([alertItem], { 'AAPL:5m': forwardBars });
  assert.strictEqual(res[0].status, 'TP2_CLOSED', 'Alert hitting TP1, TP2, TP3 must resolve as TP2_CLOSED');
  assert.strictEqual(res[0].executionState?.exit?.reason, 'TP3', 'Exit reason must be TP3');
  
  const fills = res[0].executionState?.fills;
  assert.strictEqual(fills?.length, 3, 'Must register 3 fills');
  assert.strictEqual(fills[0].kind, 'TP1');
  assert.strictEqual(fills[0].quantity, 0.5, 'TP1 must fill 50%');
  assert.strictEqual(fills[1].kind, 'TP2');
  assert.strictEqual(fills[1].quantity, 0.25, 'TP2 must fill 25%');
  assert.strictEqual(fills[2].kind, 'TP3');
  assert.strictEqual(fills[2].quantity, 0.25, 'TP3 must fill remaining 25%');

  // Total gross R: 0.50 * 1.20R + 0.25 * 2.0R + 0.25 * 3.0R = 0.60 + 0.50 + 0.75 = +1.85R
  // Accounting for 0.11% exit friction, realizedR is ~1.79R:
  assert.ok(res[0].realizedR > 1.75, `Realized R (${res[0].realizedR}) must exceed +1.75R`);
});

test('calculateAlertLevels: decouples minEquityFloorPct (0.40%) from minClampPct (0.20%) preventing silent floor collapse', () => {
  const entry = 100;
  const atr = 0.10; // ATR% = 0.10% (normal volatility in 5m equities >= 0.06%)
  // Standard on 5m equities has 2.5x ATR multiplier -> 0.10% * 2.5 = 0.25% stop.
  
  // 1. Without options: applies default equity structural floor (0.40% = 0.004) -> stop = 99.60
  const defaultLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'standard', { isCrypto: false });
  assert.strictEqual(Number((entry - defaultLevels.stopLoss).toFixed(4)), 0.40, 'Default equity floor must be 0.40% (stop at 99.60)');

  // 2. Caller sets minClampPct: 0.001 (or legacy minStopPct: 0.001) for numerical sanity:
  // MUST NOT affect or collapse the 0.40% equity structural floor!
  const clampedOptionLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'standard', { isCrypto: false, minClampPct: 0.001 });
  assert.strictEqual(Number((entry - clampedOptionLevels.stopLoss).toFixed(4)), 0.40, 'minClampPct must NOT reduce the 0.40% equity floor');

  const legacyOptionLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'standard', { isCrypto: false, minStopPct: 0.001 });
  assert.strictEqual(Number((entry - legacyOptionLevels.stopLoss).toFixed(4)), 0.40, 'legacy minStopPct must NOT reduce the 0.40% equity floor');

  // 3. Caller explicitly customizes minEquityFloorPct (e.g. 0.50% = 0.005):
  const customEquityLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'standard', { isCrypto: false, minEquityFloorPct: 0.005 });
  assert.strictEqual(Number((entry - customEquityLevels.stopLoss).toFixed(4)), 0.50, 'minEquityFloorPct must explicitly customize the equity floor to 0.50%');
});




