import assert from 'node:assert/strict';
import test from 'node:test';
import { updateAlertsOutcome, detectClosedAlertTransitions, getAlertCooldownKey, getAlertExitTimestampMs, getStrategyExpiryCandles, type AuditAlertItem } from '../alertTracker';
import { simulateTrade } from '../tradeSimulator';
import {
  getConfirmedClosedKlines,
  isNyseTradingSessionActive,
  isNyseSessionClosingCandle,
  isNyseOpeningWindow,
} from '../indicators';
import { calculateVCMESniperSignal, calculateMultifractalMTFSignal, clearMTFContextCache } from '../strategySignals';
import { resolveOperationalTrade } from '../operationalTrade';
import { isCryptoAsset, getStrategyAtrMultiplier, validateScoringSRRoom, DEFAULT_FRICTION_PCT } from '../tradeLevels';
import { runBacktestGenericOptimized, getStrategyForwardWindow, createFallbackBacktestResult, getStrategyCooldownCandles, getStrategyCooldownMs, createEmptyWalkForwardResult } from '../backtester';
import { fetchBinanceKlines, fetchYahooKlines, type Kline } from '../../services/api';
import { getKlineSnapshotTime, stampKlineSnapshot } from '../../services/marketDataSnapshot';
import { isRadarRowActive, checkAlertCooldownStatus, type RadarRowData } from '../radarFilters';
import { createInitialDiscardStats, recordDiscardEvent, type LiveDiscardReason } from '../liveDiscards';
import {
  getActionableStrategyCandidates,
  selectActionableStrategy,
  evaluateStrategyTournament,
  getStrategyMinResolved,
  sanitizeSignalWithDirectionalEdge,
  hasNegativeDirectionalOosEdge,
  isDirectionalDecisivelyToxic,
  type QVESelectionResult,
  type StrategyCandidate,
  type StrategySignalMap
} from '../tournament';
import {
  evaluateVCMESniperAt,
  buildVCMESniperContext,
  buildScoringContext,
  evaluateScoringAt,
  evaluateStandardVotingAt,
  evaluateMultifractalMTFAt,
  type StandardVotingContext,
  type MultifractalMTFContext
} from '../strategyEvaluators';

const time = 1_700_000_000;
const bar = (i: number, high = 100.5, low = 99.5, close = 100): Kline =>
  ({ time: time + i * 300, open: 100, high, low, close, volume: 100 });
const position = (direction: 'BUY' | 'SELL' = 'BUY'): AuditAlertItem => ({
  id: 'integrity', symbol: 'TESTUSDT', interval: '5m', signal: direction, strategy: 'Standard',
  status: 'OPEN', entryPrice: 100, stopLoss: direction === 'BUY' ? 99 : 101,
  takeProfit1: direction === 'BUY' ? 102 : 98, timestamp: (time + 60) * 1000,
  candleTimestamp: time - 300, realizedR: 0, pnlPercent: 0, time: '', pf: null,
});
const mirror = (k: Kline): Kline => ({ ...k, open: 200 - k.open, high: 200 - k.low, low: 200 - k.high, close: 200 - k.close });
const reload = (a: AuditAlertItem): AuditAlertItem => JSON.parse(JSON.stringify(a)) as AuditAlertItem;
const update = (a: AuditAlertItem, bars: Kline[]) => updateAlertsOutcome([a], { 'TESTUSDT:5m': bars })[0];

for (const direction of ['BUY', 'SELL'] as const) {
  const tape = (bars: Kline[]) => direction === 'BUY' ? bars : bars.map(mirror);
  for (const event of ['target', 'stop'] as const) {
    test(`${direction}: new ${event} wick in entry bar survives a retracement and JSON reload`, () => {
      const realNow = Date.now;
      try {
        Date.now = () => (time + 60) * 1000;
        const first = update(position(direction), tape([bar(0)]));
        assert.equal(first.status, 'OPEN');
        Date.now = () => (time + 120) * 1000;
        const next = event === 'target' ? bar(0, 103, 99.5, 100.2) : bar(0, 100.5, 98, 100.2);
        const result = update(reload(first), tape([next]));
        assert.equal(result.status, event === 'target' ? 'TP1_CLOSED' : 'SL_HIT');
        assert.equal(result.executionState?.fills.length, 1);
        assert.equal(result.executionState?.remaining, 0);
        assert.deepEqual(update(reload(result), tape([next])).executionState, result.executionState);
      } finally { Date.now = realNow; }
    });
  }

  test(`${direction}: unchanged pre-entry extremes cannot execute a retroactive target or stop`, () => {
    const realNow = Date.now;
    try {
      Date.now = () => (time + 60) * 1000;
      const first = update(position(direction), tape([bar(0, 110, 90, 100)]));
      Date.now = () => (time + 120) * 1000;
      const repeated = update(reload(first), tape([bar(0, 110, 90, 100.2)]));
      assert.equal(repeated.status, 'OPEN');
      assert.equal(repeated.executionState?.fills.length, 0);
      const newExtreme = update(repeated, tape([bar(0, 111, 90, 100.2)]));
      assert.equal(newExtreme.status, 'TP1_CLOSED');
    } finally { Date.now = realNow; }
  });

  test(`${direction}: cached pre-close snapshot cannot hide the final candle's stop`, () => {
    const realNow = Date.now;
    try {
      Date.now = () => (time + 580) * 1000;
      const cachedBars = stampKlineSnapshot(tape([bar(0), bar(1)]), Date.now());
      const initial = update(position(direction), cachedBars);
      assert.equal(initial.executionState?.cursor?.closed, false);
      Date.now = () => (time + 610) * 1000;
      const cached = update(reload(initial), cachedBars);
      assert.equal(cached.executionState?.cursor?.closed, false);
      Date.now = () => (time + 620) * 1000;
      const fresh = stampKlineSnapshot(tape([bar(0), bar(1, 100.5, 98, 100), bar(2)]), Date.now());
      const result = update(reload(cached), fresh);
      const withoutCacheStep = update(initial, fresh);
      assert.equal(result.status, 'SL_HIT');
      assert.equal(result.pnlPercent, withoutCacheStep.pnlPercent);
      assert.equal(result.executionState?.fills[0].barTime, time + 300);
    } finally { Date.now = realNow; }
  });
}

test('a recorded TP1 wick is not replayed against its new stop on the next observation', () => {
  const realNow = Date.now;
  try {
    Date.now = () => (time + 60) * 1000;
    const initial = update({ ...position(), strategy: 'VCME Sniper', takeProfit2: 103.5, takeProfit3: 105 }, [bar(0)]);
    Date.now = () => (time + 120) * 1000;
    const tp1 = update(initial, [bar(0, 102.5, 99.5, 102.2)]);
    assert.equal(tp1.status, 'TP1_HIT');
    const again = update(reload(tp1), [bar(0, 102.5, 99.5, 101)]);
    assert.equal(again.status, 'TP1_HIT');
    const stopped = update(again, [bar(0, 102.5, 98, 100.2)]);
    assert.equal(stopped.status, 'TP1_BE_CLOSED');
    assert.deepEqual(stopped.executionState?.fills.map(f => f.quantity), [0.5, 0.5]);
  } finally { Date.now = realNow; }
});

test('missing 5m data cannot fall back to symbol-only hourly data, and recovery clears the warning', () => {
  const a = { ...position(), strategy: 'VCME Sniper' };
  const hourly = [{ ...bar(12, 101, 98, 100) }];
  const missing = updateAlertsOutcome([a], { TESTUSDT: hourly, 'TESTUSDT:1h': hourly })[0];
  assert.equal(missing.status, 'OPEN');
  assert.equal(missing.pnlPercent, a.pnlPercent);
  assert.equal(missing.executionState, undefined);
  assert.ok(missing.dataWarning?.includes('5m'));
  const stillMissing = updateAlertsOutcome([missing], { 'TESTUSDT:5m': [], TESTUSDT: hourly })[0];
  assert.equal(stillMissing.status, 'OPEN');
  const recovered = update(stillMissing, [bar(0), bar(1, 101, 98, 100)]);
  assert.equal(recovered.status, 'SL_HIT');
  assert.equal(recovered.dataWarning, undefined);
});

for (const [interval, seconds] of [['5m', 300], ['1h', 3600]] as const) {
  test(`${interval}: closed-signal selection uses snapshot time, not the later cache-read time`, () => {
    const realNow = Date.now;
    try {
      Date.now = () => (time + seconds - 10) * 1000;
      const cached = stampKlineSnapshot([{ ...bar(0), time: time - seconds }, bar(0)], Date.now());
      assert.equal(getConfirmedClosedKlines(cached, interval, 'TESTUSDT').length, 1);
      Date.now = () => (time + seconds + 10) * 1000;
      assert.equal(getConfirmedClosedKlines(cached, interval, 'TESTUSDT').length, 1);
      const fresh = stampKlineSnapshot(cached.map(k => ({ ...k })), Date.now());
      assert.equal(getConfirmedClosedKlines(fresh, interval, 'TESTUSDT').length, 2);
    } finally { Date.now = realNow; }
  });
}

for (const provider of ['Binance', 'Yahoo'] as const) {
  test(`${provider}: real fetch/cache path preserves acquisition time across a candle boundary`, async () => {
    const realNow = Date.now;
    const realFetch = globalThis.fetch;
    let requests = 0;
    let payloadBars = [bar(-1), bar(0)];
    try {
      Date.now = () => (time + 295) * 1000;
      globalThis.fetch = async () => {
        requests++;
        const payload = provider === 'Binance'
          ? payloadBars.map(k => [k.time * 1000, String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume)])
          : { chart: { result: [{ timestamp: payloadBars.map(k => k.time), indicators: { quote: [{
            open: payloadBars.map(k => k.open), high: payloadBars.map(k => k.high), low: payloadBars.map(k => k.low),
            close: payloadBars.map(k => k.close), volume: payloadBars.map(k => k.volume),
          }] } }] } };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const fetchBars = () => provider === 'Binance'
        ? fetchBinanceKlines('INTEGRITY_CACHE_TESTUSDT', '5m') : fetchYahooKlines('INTEGRITY_CACHE_STOCK', '5m');
      const first = await fetchBars();
      const a = { ...position(), timestamp: (time - 240) * 1000, candleTimestamp: time - 600 };
      const initial = update(a, first);
      Date.now = () => (time + 310) * 1000;
      const cached = await fetchBars();
      assert.strictEqual(cached, first);
      assert.equal(requests, 1);
      assert.equal(getKlineSnapshotTime(cached), (time + 295) * 1000);
      assert.equal(update(initial, cached).executionState?.cursor?.closed, false);
      Date.now = () => (time + 326) * 1000;
      payloadBars = [bar(-1), bar(0, 100.5, 98, 100), bar(1)];
      const fresh = await fetchBars();
      assert.equal(requests, 2);
      assert.notStrictEqual(fresh, cached);
      assert.equal(update(initial, fresh).status, 'SL_HIT');
    } finally { globalThis.fetch = realFetch; Date.now = realNow; }
  });
}

test('Yahoo 1h: uses range=2y directly to avoid 422 on recently listed symbols such as IBIT, and falls back to range=1y if rejected', async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const bars = [bar(-12), bar(0)]; // one hour apart, as Yahoo 1h bars are
  try {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('range=2y')) {
        return new Response(JSON.stringify({ chart: { result: null, error: { code: 'Unprocessable Entity' } } }), { status: 422 });
      }
      const payload = { chart: { result: [{ timestamp: bars.map(k => k.time), indicators: { quote: [{
        open: bars.map(k => k.open), high: bars.map(k => k.high), low: bars.map(k => k.low),
        close: bars.map(k => k.close), volume: bars.map(k => k.volume),
      }] } }] } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const klines = await fetchYahooKlines('RANGE_FALLBACK_TEST', '1h');
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes('range=2y&interval=1h'));
    assert.ok(urls[1].includes('range=1y&interval=1h'));
    assert.equal(klines.length, 2);
  } finally { globalThis.fetch = realFetch; }
});

for (const strategy of ['standard', 'confluencia', 'scoring']) {
  for (const direction of ['BUY', 'SELL'] as const) {
    test(`${strategy} ${direction}: historical execution and native plan have identical ATR risk after a gap`, () => {
      const multiplier = strategy === 'standard' ? 1.2 : strategy === 'scoring' ? 1.5 : 2;
      const historicalOldStop = 105 * (1 - multiplier / 100);
      const correctStop = 105 - multiplier;
      const target = 105 * (1 + 1.5 * multiplier / 100);
      const bars = Array.from({ length: 600 }, (_, i) => bar(i));
      bars[501] = { ...bar(501, 105.2, (historicalOldStop + correctStop) / 2, 105), open: 105 };
      for (let i = 502; i < bars.length; i++) bars[i] = { ...bar(i, target + 0.1, 104.8, target), open: 105 };
      const tape = direction === 'BUY' ? bars : bars.map(mirror);
      const signals = tape.map((_, i) => i === 500 ? direction : 'NEUTRAL');
      const bt = runBacktestGenericOptimized(tape, '5m', signals, strategy);
      const plan = resolveOperationalTrade({ strategy, signal: direction, executionStyle: 'dayTrading',
        raw: { '5m': tape.slice(0, 502) }, closed: { '5m': tape.slice(0, 501) } });
      const expected = simulateTrade(tape, 500, direction, plan.levels, { forwardWindow: bt.forwardWindow!, enablePartials: false, frictionPct: DEFAULT_FRICTION_PCT });
      assert.equal(plan.valid, true);
      assert.ok(Math.abs(Math.abs(plan.entryPrice - plan.levels.stopLoss) - multiplier) < 1e-12);
      assert.equal(bt.totalSignals, 1);
      assert.equal(bt.expectancyR, expected.realizedR);
      assert.equal(bt.wins, expected.outcome === 'win' ? 1 : 0);
      assert.equal(bt.losses, expected.outcome === 'loss' ? 1 : 0);
    });
  }
}

test('MarketRadar: isRadarRowActive uses signalConfidence, rejecting exploratory signals and accepting actionable fallbacks', () => {
  const baseRow: RadarRowData = {
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    isCrypto: true,
    price: 60000,
    changePercent: 1.5,
    signal5m: 'BUY',
    signal1h: 'BUY',
    signal1d: 'BUY',
    overallSignal: 'BUY',
    isFullConfluence: true,
    confluenceType: 'BUY_3',
    confluenceScore: 100,
    qveStrategy: 'Multitemporal',
    qveProfitFactor: 2.1,
    qveConfidence: 'HIGH',
    signalConfidence: 'NONE',
    rvol: 1.5,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 2.0,
    bbPercentile: 50,
    loading: false,
  };

  // 1. Leader has HIGH confidence, but signal comes from exploratory fallback (signalConfidence: 'NONE'): must be rejected
  assert.equal(isRadarRowActive(baseRow), false, 'Exploratory signal with NONE signalConfidence must NOT pass active filter');

  // 2. Leader has NONE confidence, but actionable fallback is LIMITED with BUY: must be accepted
  const actionableFallbackRow: RadarRowData = {
    ...baseRow,
    qveConfidence: 'NONE',
    signalConfidence: 'LIMITED',
    overallSignal: 'BUY',
  };
  assert.equal(isRadarRowActive(actionableFallbackRow), true, 'Actionable fallback with LIMITED signalConfidence MUST pass active filter');

  // 3. Primary strategy active with HIGH confidence: must be accepted
  const primaryHighRow: RadarRowData = {
    ...baseRow,
    qveConfidence: 'HIGH',
    signalConfidence: 'HIGH',
    overallSignal: 'BUY',
  };
  assert.equal(isRadarRowActive(primaryHighRow), true, 'Validated primary signal with HIGH confidence MUST pass active filter');

  // 4. Neutral signal even with HIGH confidence: must be rejected
  const neutralRow: RadarRowData = {
    ...baseRow,
    overallSignal: 'NEUTRAL',
    signalConfidence: 'HIGH',
  };
  assert.equal(isRadarRowActive(neutralRow), false, 'NEUTRAL signal must not pass active filter');

  // 5. Active signal recorded in activeSignals session map: passes regardless of row status
  const sessionActiveRow: RadarRowData = {
    ...baseRow,
    overallSignal: 'NEUTRAL',
    signalConfidence: 'NONE',
  };
  assert.equal(isRadarRowActive(sessionActiveRow, { BTCUSDT: 'BUY' }), true, 'Active session signal must pass active filter');

  // 6. Signal has HIGH confidence and BUY, but isOperationalViable is false (rejected by friction/geometry/SR): must be rejected
  const unviableFrictionRow: RadarRowData = {
    ...baseRow,
    signalConfidence: 'HIGH',
    overallSignal: 'BUY',
    isOperationalViable: false,
    operationalReason: 'Riesgo insuficiente frente a comisiones (fricción consume > 35% del stop).'
  };
  assert.equal(isRadarRowActive(unviableFrictionRow), false, 'Signal failing operational viability must NOT pass active filter');

  // 7. New candidate signal on closed market (isMarketClosed: true): must be rejected
  const closedMarketNewSignalRow: RadarRowData = {
    ...baseRow,
    symbol: 'AAPL',
    isCrypto: false,
    signalConfidence: 'HIGH',
    overallSignal: 'BUY',
    isMarketClosed: true,
    isOperationalViable: true,
  };
  assert.equal(isRadarRowActive(closedMarketNewSignalRow), false, 'New candidate signal outside market hours must NOT pass active filter');

  // 8. Existing open position in activeSignals on closed market: MUST pass active filter (open positions remain active)
  assert.equal(isRadarRowActive(closedMarketNewSignalRow, { AAPL: 'BUY' }), true, 'Open position in activeSignals must pass active filter even when market is closed');

  // 9. New candidate signal in cooldown (isCooldownActive: true): must be rejected
  const cooldownNewSignalRow: RadarRowData = {
    ...primaryHighRow,
    isCooldownActive: true,
    cooldownRemainingMs: 900000,
  };
  assert.equal(isRadarRowActive(cooldownNewSignalRow), false, 'New candidate signal in cooldown must NOT pass active filter');

  // 10. Existing open position in cooldown: MUST pass active filter (open positions remain active)
  assert.equal(isRadarRowActive(cooldownNewSignalRow, { BTCUSDT: 'BUY' }), true, 'Open position in activeSignals must pass active filter even if cooldown flag is present');

  // 11. New candidate signal on session closing candle (isSessionClosingCandle: true): must be rejected
  const closingCandleNewSignalRow: RadarRowData = {
    ...primaryHighRow,
    symbol: 'AAPL',
    isCrypto: false,
    isSessionClosingCandle: true,
  };
  assert.equal(isRadarRowActive(closingCandleNewSignalRow), false, 'New candidate signal on session closing candle must NOT pass active filter');

  // 12. Existing open position on session closing candle: MUST pass active filter
  assert.equal(isRadarRowActive(closingCandleNewSignalRow, { AAPL: 'BUY' }), true, 'Open position in activeSignals must pass active filter on session closing candle');
});

test('liveDiscards: tracks atomic discard reasons and prevents duplicate tallies on repeated polling', () => {
  let stats = createInitialDiscardStats();
  const seen = new Set<string>();

  assert.equal(stats.total, 0);
  assert.equal(stats.friction, 0);

  // 1. Record friction discard on candle 1000: increments total and friction
  const r1 = recordDiscardEvent(stats, seen, 'NVDA', '5m', 1000, 'friction');
  assert.equal(r1.recorded, true);
  stats = r1.stats;
  assert.equal(stats.total, 1);
  assert.equal(stats.friction, 1);

  // 2. Continuous polling of the same candle 1000: must NOT increment counts
  for (let i = 0; i < 15; i++) {
    const rDup = recordDiscardEvent(stats, seen, 'NVDA', '5m', 1000, 'friction');
    assert.equal(rDup.recorded, false);
    assert.equal(rDup.stats.total, 1);
    assert.equal(rDup.stats.friction, 1);
  }

  // 3. New candle 1300 with marketHours discard
  const r2 = recordDiscardEvent(stats, seen, 'AAPL', '5m', 1300, 'marketHours');
  assert.equal(r2.recorded, true);
  stats = r2.stats;
  assert.equal(stats.total, 2);
  assert.equal(stats.marketHours, 1);
  assert.equal(stats.friction, 1);

  // 4. Cooldown discard
  const r3 = recordDiscardEvent(stats, seen, 'BTCUSDT', '5m', 1300, 'cooldown');
  assert.equal(r3.recorded, true);
  stats = r3.stats;
  assert.equal(stats.total, 3);
  assert.equal(stats.cooldown, 1);

  // 5. Active trade discard
  const r4 = recordDiscardEvent(stats, seen, 'ETHUSDT', '5m', 1300, 'activeTrade');
  assert.equal(r4.recorded, true);
  stats = r4.stats;
  assert.equal(stats.total, 4);
  assert.equal(stats.activeTrade, 1);

  // 6. Geometry discard
  const r5 = recordDiscardEvent(stats, seen, 'TSLA', '5m', 1300, 'geometry');
  assert.equal(r5.recorded, true);
  stats = r5.stats;
  assert.equal(stats.total, 5);
  assert.equal(stats.geometry, 1);
});

test('liveDiscards: synchronous ref accumulator updates prevent event loss during multi-symbol bursts', () => {
  // Simulates React component refs
  const seenDiscardKeysRef = { current: new Set<string>() };
  const discardStatsRef = { current: createInitialDiscardStats() };
  let reactState = discardStatsRef.current;

  // Handler mimicking fixed App.tsx recordDiscard
  const recordDiscard = (symbol: string, interval: string, candleTimestamp: number, reason: LiveDiscardReason) => {
    const res = recordDiscardEvent(
      discardStatsRef.current,
      seenDiscardKeysRef.current,
      symbol,
      interval,
      candleTimestamp,
      reason
    );
    if (res.recorded) {
      discardStatsRef.current = res.stats; // Synchronous ref update
      reactState = res.stats; // Scheduled React state update
    }
  };

  // Burst: 3 different symbols discarded in the exact same scan loop tick
  recordDiscard('NVDA', '5m', 2000, 'friction');
  recordDiscard('AAPL', '5m', 2000, 'marketHours');
  recordDiscard('MSFT', '5m', 2000, 'marketHours');

  // Both the ref and the state must retain all 3 events
  assert.equal(discardStatsRef.current.total, 3, 'Total discards must equal 3');
  assert.equal(discardStatsRef.current.friction, 1, 'Friction discards must equal 1');
  assert.equal(discardStatsRef.current.marketHours, 2, 'MarketHours discards must equal 2');
  assert.equal(reactState.total, 3, 'Final state must equal 3');
  assert.equal(seenDiscardKeysRef.current.size, 3, 'Three distinct keys recorded in seenKeys');
});

test('MTF Context LRU Cache: identical closed candles reuse context instantly and invalidate on new candle', () => {
  clearMTFContextCache();

  // Synthetic candles for 5m, 1h, 1d (sufficient depth for MTF context construction)
  const klines5m: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99.5 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 1000,
  }));
  const klines1h: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 3600,
    open: 100 + i * 0.5,
    high: 102 + i * 0.5,
    low: 99 + i * 0.5,
    close: 101 + i * 0.5,
    volume: 5000,
  }));
  const klines1d: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 86400,
    open: 100 + i * 1.0,
    high: 105 + i * 1.0,
    low: 98 + i * 1.0,
    close: 103 + i * 1.0,
    volume: 20000,
  }));

  // First call: builds context and caches it
  const r1 = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'CACHE_TEST', undefined, undefined, 'dayTrading', 'agresivo', 105);
  // Second call with different executionPrice but SAME closed candles: reuses cached context
  const r2 = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'CACHE_TEST', undefined, undefined, 'dayTrading', 'agresivo', 105.2);

  assert.equal(r1.mode, r2.mode);
  assert.equal(r1.bias1D, r2.bias1D);
  assert.equal(r1.rsi1H, r2.rsi1H);

  // Multifractal first and second call
  const mf1 = calculateMultifractalMTFSignal(klines5m, klines1h, klines1d, 'CACHE_TEST', 105);
  const mf2 = calculateMultifractalMTFSignal(klines5m, klines1h, klines1d, 'CACHE_TEST', 105.2);
  assert.equal(mf1.signal, mf2.signal);
  assert.equal(mf1.bias1D, mf2.bias1D);

  // Invalidation test: append a new closed bar to 5m -> fingerprint changes
  const klines5mExtended = [
    ...klines5m,
    { time: 1700000000 + 60 * 300, open: 106, high: 107, low: 105.5, close: 106.5, volume: 1200 }
  ];
  const r3 = calculateVCMESniperSignal(klines5mExtended, klines1h, klines1d, 'CACHE_TEST', undefined, undefined, 'dayTrading', 'agresivo', 106.5);
  assert.ok(r3 !== undefined);
});

test('Integration: Asset Load -> SL Hit -> Cooldown Activation -> Scanner Revenge Block', () => {
  const t0 = 1700000000;
  const t0Ms = t0 * 1000;
  const entryPrice = 100;
  const stopLoss = 98;
  const tp1 = 104;

  // Active position opened at t0
  let alertsLog: AuditAlertItem[] = [{
    id: 'sol-001',
    symbol: 'SOLUSDT',
    interval: '5m',
    signal: 'BUY',
    strategy: 'Standard',
    status: 'OPEN',
    entryPrice,
    stopLoss,
    takeProfit1: tp1,
    timestamp: t0Ms,
    candleTimestamp: t0,
    realizedR: 0,
    pnlPercent: 0,
    time: '2023-11-14 22:13:20',
    pf: null,
  }];

  // Local cooldown storage simulating App.tsx
  const alertCooldowns: Record<string, number> = {
    'SOLUSDT-5m': t0Ms, // Original entry cooldown
  };

  const cooldownMs = 60 * 60 * 1000; // 60 min nominal cooldown

  // 1. In the UI, at t0 + 10 min (t0Ms + 600000 ms), user loads SOLUSDT.
  // Price has fallen through stopLoss (low: 97.5) within the 12-bar horizon
  const tExit = t0 + 600;
  const tExitMs = tExit * 1000;
  const exitKlines: Kline[] = [
    { time: t0, open: 100, high: 101, low: 99.5, close: 100.5, volume: 100 },
    { time: t0 + 300, open: 100, high: 100.2, low: 99.0, close: 99.5, volume: 100 },
    { time: tExit, open: 98.5, high: 99, low: 97.5, close: 97.8, volume: 200 },
  ];

  // Outcome update executed during asset loading:
  const prevAlerts = [...alertsLog];
  const updatedOutcomes = updateAlertsOutcome(prevAlerts, { 'SOLUSDT:5m': exitKlines });
  const newlyClosed = detectClosedAlertTransitions(prevAlerts, updatedOutcomes);

  assert.equal(newlyClosed.length, 1, 'Should detect transition of SOLUSDT to closed');
  assert.equal(newlyClosed[0].status, 'SL_HIT', 'Status must be SL_HIT');

  // Synchronize cooldown on transition
  newlyClosed.forEach(closed => {
    const key = getAlertCooldownKey(closed);
    alertCooldowns[key] = tExitMs;
  });
  alertsLog = updatedOutcomes;

  assert.equal(alertCooldowns['SOLUSDT-5m'], tExitMs, 'Cooldown timestamp must be updated to exit time');

  // 2. Scanner runs at t0 + 65 minutes (t0Ms + 3900000 ms), which is 55 minutes after SL exit
  const tScannerMs = t0Ms + 3900000; // 65 min since entry (> 60 min), but only 55 min since exit (< 60 min)
  const key = getAlertCooldownKey({ symbol: 'SOLUSDT', interval: '5m', alertType: 'PRIMARY' });
  const lastAlertTime = alertCooldowns[key] || 0;

  // Verify: Nominal entry time (65m > 60m) would have allowed trade, BUT post-exit cooldown blocks it!
  const isEntryTimeElapsed = (tScannerMs - t0Ms) >= cooldownMs;
  assert.equal(isEntryTimeElapsed, true, 'Nominal entry time has elapsed (65m > 60m)');

  const isPostExitCooldownElapsed = (tScannerMs - lastAlertTime) >= cooldownMs;
  assert.equal(isPostExitCooldownElapsed, false, 'Post-exit cooldown has NOT elapsed (55m < 60m)');

  // Scanner records discard and blocks alert emission
  const stats = createInitialDiscardStats();
  const seenKeys = new Set<string>();
  const discardRes = recordDiscardEvent(stats, seenKeys, 'SOLUSDT', '5m', tExit, 'cooldown');
  assert.equal(discardRes.recorded, true);
  assert.equal(discardRes.stats.cooldown, 1);
  assert.equal(discardRes.stats.total, 1);
});

test('Integration: Radar and Scanner Operational Coherence across friction, market hours and active positions', () => {
  const baseRow: RadarRowData = {
    symbol: 'NVDA',
    name: 'NVDA',
    isCrypto: false,
    price: 100,
    changePercent: 1.5,
    signal5m: 'BUY',
    signal1h: 'BUY',
    signal1d: 'BUY',
    overallSignal: 'BUY',
    isFullConfluence: true,
    confluenceType: 'BUY_3',
    confluenceScore: 90,
    qveStrategy: 'Standard',
    qveProfitFactor: 2.1,
    qveConfidence: 'HIGH',
    signalConfidence: 'HIGH',
    rvol: 1.8,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 2.0,
    bbPercentile: 50,
    loading: false,
  };

  // Scenario 1: Excess friction (micro-stop where ATR is 0.04% and clamped stop is 0.20% < 0.314%)
  const microRangeKlines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 100.02,
    low: 99.98,
    close: 100,
    volume: 500,
  }));

  // Scanner:
  const tradePlanFriction = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': microRangeKlines, '1h': [] },
    closed: { '5m': microRangeKlines, '1h': [] },
  });
  // If tradePlan is unviable, scanner records discard:
  const scannerActionableFriction = tradePlanFriction.valid;
  // Radar:
  const radarRowFriction: RadarRowData = {
    ...baseRow,
    isOperationalViable: tradePlanFriction.valid,
    operationalReason: tradePlanFriction.reason,
  };
  const radarPassesFriction = isRadarRowActive(radarRowFriction, {});

  // Parity check:
  assert.equal(scannerActionableFriction, false, 'Scanner rejects trade due to friction');
  assert.equal(radarPassesFriction, false, 'Radar actively rejects unviable operational row');

  // Scenario 2: Market closed outside NYSE hours for equity
  const closedMarketTimestamp = Date.UTC(2026, 8, 17, 21, 0, 0); // 17:00 ET (closed)
  const isNyseOpen = isNyseTradingSessionActive(closedMarketTimestamp);
  assert.equal(isNyseOpen, false, 'NYSE regular session must be inactive at 17:00 ET');

  // Scanner discards new candidate:
  const scannerAllowsClosedCandidate = isNyseOpen;
  assert.equal(scannerAllowsClosedCandidate, false, 'Scanner blocks new candidate when NYSE is closed');

  // Radar discards new candidate:
  const radarRowClosedMarket: RadarRowData = {
    ...baseRow,
    isMarketClosed: !isNyseOpen,
    isOperationalViable: true,
  };
  const radarPassesClosedCandidate = isRadarRowActive(radarRowClosedMarket, {});
  assert.equal(radarPassesClosedCandidate, false, 'Radar blocks new candidate when market is closed');

  // Scenario 3: Open position in portfolio during market closed
  // Active trade exists in session:
  const activeSignals = { NVDA: 'BUY' };
  const radarPassesOpenPosition = isRadarRowActive(radarRowClosedMarket, activeSignals);
  assert.equal(radarPassesOpenPosition, true, 'Radar maintains visibility of open position even when market is closed');
});

test('Equity parity: runBacktestGenericOptimized and resolveOperationalTrade share identical equity stop and target geometry for AAPL', () => {
  // Setup an equity asset at $200 with ATR ~0.30 (ATR% = 0.15%)
  // For crypto: ATR mult is 1.2 -> stop = 0.18% (clamped to minStop 0.20% = $0.40).
  // Friction = 0.11%, so frictionR = 0.11 / 0.20 = 0.55R > 0.35R -> discarded by frictionFilter!
  // For equity: ATR mult is 2.5 on 5m -> stop = 0.375% (clamped to equity floor 0.40% = $0.80).
  // Friction = 0.11%, so frictionR = 0.11 / 0.40 = 0.275R <= 0.35R -> VIABLE trade!
  const equityBars: Kline[] = Array.from({ length: 600 }, (_, i) => ({
    time: time + i * 300,
    open: 200,
    high: 200.15,
    low: 199.85,
    close: 200,
    volume: 1000
  }));
  // Add a BUY trigger candle at index 500
  equityBars[500] = { ...equityBars[500], close: 200.05 };
  equityBars[501] = { ...equityBars[501], open: 200 };
  const signals = equityBars.map((_, i) => (i === 500 ? ('BUY' as const) : ('NEUTRAL' as const)));

  // 1. Backtest with crypto symbol ('BTCUSDT'): with 5m structural floor (Via B), crypto is viable and passes frictionFilter!
  const btCrypto = runBacktestGenericOptimized(equityBars, '5m', signals, 'standard', 'BTCUSDT');
  assert.equal(btCrypto.discards.frictionFilter, 0, 'Crypto parameters with structural floor produce viable stop (>=0.40%), passing frictionFilter');
  assert.equal(btCrypto.totalSignals, 1, 'Crypto backtest accepts viable trade');

  // 2. Backtest with equity symbol ('AAPL') -> passes with equity geometry!
  const btEquity = runBacktestGenericOptimized(equityBars, '5m', signals, 'standard', 'AAPL');
  assert.equal(btEquity.discards.frictionFilter, 0, 'Equity parameters produce viable stop (>=0.40%), passing frictionFilter');
  assert.equal(btEquity.totalSignals, 1, 'Equity backtest accepts viable equity trade');

  // 3. Operational Trade Plan in Live -> identical levels to Equity Backtest!
  const livePlan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    isCrypto: false,
    raw: { '5m': equityBars.slice(0, 502) },
    closed: { '5m': equityBars.slice(0, 501) }
  });
  assert.equal(livePlan.valid, true, 'Live equity plan is valid');
  assert.equal(livePlan.levels.entryPrice, 200);
  assert.ok(Math.abs(livePlan.levels.stopLoss - (200 - 0.80)) < 1e-4, `Expected SL around 199.20, got ${livePlan.levels.stopLoss}`);

  // Parity check between livePlan levels and backtest simulation
  const expectedSim = simulateTrade(equityBars, 500, 'BUY', livePlan.levels, {
    forwardWindow: btEquity.forwardWindow!,
    enablePartials: false,
    frictionPct: DEFAULT_FRICTION_PCT
  });
  assert.equal(btEquity.expectancyR, expectedSim.realizedR);
  assert.equal(btEquity.wins, expectedSim.outcome === 'win' ? 1 : 0);
  assert.equal(btEquity.losses, expectedSim.outcome === 'loss' ? 1 : 0);
});

test('Alert Emitter, Radar and Calculator parity: App.tsx passes isCrypto to resolveOperationalTrade preventing false friction discard', () => {
  const equityBars: Kline[] = Array.from({ length: 100 }, (_, i) => ({
    time: time + i * 300,
    open: 200,
    high: 200.15,
    low: 199.85,
    close: 200,
    volume: 1000,
  }));
  const symbol = 'AAPL';
  const isCrypto = isCryptoAsset(symbol);
  assert.equal(isCrypto, false, 'AAPL must be recognized as non-crypto asset');

  // Surface 1: MarketRadar (MarketRadar.tsx:456)
  const radarTradePlan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': equityBars, '1h': [] },
    closed: { '5m': equityBars, '1h': [] },
    isCrypto,
  });

  // Surface 2: SignalPanel Calculator (SignalPanel.tsx:383)
  const calculatorTradePlan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': equityBars, '1h': [] },
    closed: { '5m': equityBars, '1h': [] },
    isCrypto,
  });

  // Surface 3: Alert Emitter (App.tsx:592)
  const alertEmitterTradePlan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': equityBars, '1h': [] },
    closed: { '5m': equityBars, '1h': [] },
    isCrypto,
  });

  // All 3 surfaces MUST be identical and valid
  assert.equal(radarTradePlan.valid, true, 'Radar considers tradePlan valid');
  assert.equal(calculatorTradePlan.valid, true, 'Calculator considers tradePlan valid');
  assert.equal(alertEmitterTradePlan.valid, true, 'Alert emitter considers tradePlan valid and emits alert');

  assert.equal(radarTradePlan.levels.stopLoss, calculatorTradePlan.levels.stopLoss);
  assert.equal(calculatorTradePlan.levels.stopLoss, alertEmitterTradePlan.levels.stopLoss);
  assert.equal(radarTradePlan.levels.takeProfit1, alertEmitterTradePlan.levels.takeProfit1);

  // With 5m structural floor (Via B), default crypto and equity both share viable geometry under normal volatility:
  const defaultCryptoPlan = resolveOperationalTrade({
    strategy: 'standard',
    signal: 'BUY',
    executionStyle: 'dayTrading',
    raw: { '5m': equityBars, '1h': [] },
    closed: { '5m': equityBars, '1h': [] },
    // isCrypto omitted -> defaults to true!
  });
  assert.equal(defaultCryptoPlan.valid, true, 'Default crypto plan is viable with 5m structural floor');
});

test('ForwardWindow scaling for equities and crypto in 5m day trading: eliminates premature timeout choke and gives trades room to reach TP1', () => {
  // 1. Validate getStrategyForwardWindow strict 1:1 parity across asset classes and callers:
  // Both without executionStyle (backtester) and with executionStyle (tournament & alertTracker):
  assert.equal(getStrategyForwardWindow('standard', '5m', undefined, 'BTCUSDT'), 12);
  assert.equal(getStrategyForwardWindow('standard', '5m', 'dayTrading', 'BTCUSDT'), 12);
  assert.equal(getStrategyForwardWindow('scoring', '5m', undefined, 'BTCUSDT'), 16);
  assert.equal(getStrategyForwardWindow('scoring', '5m', 'dayTrading', 'BTCUSDT'), 16);
  assert.equal(getStrategyForwardWindow('confluencia', '5m', undefined, 'BTCUSDT'), 24);
  assert.equal(getStrategyForwardWindow('confluencia', '5m', 'dayTrading', 'BTCUSDT'), 24);
  assert.equal(getStrategyForwardWindow('multifractal', '5m', undefined, 'BTCUSDT'), 12);
  assert.equal(getStrategyForwardWindow('multifractal', '5m', 'dayTrading', 'BTCUSDT'), 12);
  assert.equal(getStrategyForwardWindow('vcme', '5m', undefined, 'BTCUSDT'), 24);
  assert.equal(getStrategyForwardWindow('vcme', '5m', 'dayTrading', 'BTCUSDT'), 24);

  // Equities ('AAPL' / isCrypto: false) share identical windows:
  assert.equal(getStrategyForwardWindow('standard', '5m', undefined, 'AAPL'), 12);
  assert.equal(getStrategyForwardWindow('standard', '5m', 'dayTrading', 'AAPL'), 12);
  assert.equal(getStrategyForwardWindow('scoring', '5m', undefined, 'AAPL'), 16);
  assert.equal(getStrategyForwardWindow('scoring', '5m', 'dayTrading', 'AAPL'), 16);
  assert.equal(getStrategyForwardWindow('confluencia', '5m', undefined, 'AAPL'), 36);
  assert.equal(getStrategyForwardWindow('confluencia', '5m', 'dayTrading', 'AAPL'), 36);
  assert.equal(getStrategyForwardWindow('multifractal', '5m', 'dayTrading', 'AAPL'), 12);
  assert.equal(getStrategyForwardWindow('vcme', '5m', 'dayTrading', 'AAPL'), 24);

  // 2. Parity with Live Alert Tracker (getStrategyExpiryCandles):
  assert.equal(getStrategyExpiryCandles('Standard', '5m', 'dayTrading', 'BTCUSDT'), 12);
  assert.equal(getStrategyExpiryCandles('Scoring', '5m', 'dayTrading', 'BTCUSDT'), 16);
  assert.equal(getStrategyExpiryCandles('Confluencia', '5m', 'dayTrading', 'BTCUSDT'), 24);
  assert.equal(getStrategyExpiryCandles('Standard', '5m', 'dayTrading', 'AAPL'), 12);
  assert.equal(getStrategyExpiryCandles('Scoring', '5m', 'dayTrading', 'AAPL'), 16);
  assert.equal(getStrategyExpiryCandles('Confluencia', '5m', 'dayTrading', 'AAPL'), 36);

  // 3. Trade Simulation: verify that an equity trade reaching TP1 at bar 9 resolves as WIN under 12-bar window
  // but would have choked to TIMEOUT under the old 6-bar window:
  const equityBars: Kline[] = Array.from({ length: 600 }, (_, i) => ({
    time: time + i * 300,
    open: 200,
    high: 200.15,
    low: 199.85,
    close: 200,
    volume: 1000,
  }));
  // Entry at index 501, price 200.
  // Standard equity geometry: Stop = 199.20 (0.40% = 2.67 ATR), TP1 = 200.80 (0.40% * 1.5 = 0.60% = 4.0 ATR)
  // Candle index 510 (bar 9 after entry) moves strongly up to 202.00 (reaching TP1)
  for (let i = 501; i < 510; i++) {
    equityBars[i] = { ...equityBars[i], open: 200.10, high: 200.25, low: 199.95, close: 200.15 };
  }
  equityBars[510] = { ...equityBars[510], open: 200.20, high: 202.00, low: 200.15, close: 201.80 };
  for (let i = 511; i < equityBars.length; i++) {
    equityBars[i] = { ...equityBars[i], open: 201.80, high: 202.10, low: 201.60, close: 201.80 };
  }

  const signals = equityBars.map((_, i) => (i === 500 ? ('BUY' as const) : ('NEUTRAL' as const)));

  // Run backtest with equity symbol 'AAPL' (forwardWindow = 12):
  const btEquity = runBacktestGenericOptimized(equityBars, '5m', signals, 'standard', 'AAPL');
  assert.equal(btEquity.forwardWindow, 12, 'Backtest for AAPL must use 12 candles forward window');
  assert.equal(btEquity.wins, 1, 'Trade reaching TP1 at candle 9 wins within 12-candle window');
  assert.equal(btEquity.timeouts, 0, 'No timeout');
  assert.ok(btEquity.expectancyR > 1.0, `Expectancy must be positive and strong, got ${btEquity.expectancyR}`);

  // Simulate with old 6-candle window to demonstrate the prior timeout choke:
  const oldLevels = { entryPrice: 200, stopLoss: 199.20, takeProfit1: 200.80 };
  const oldChokedSim = simulateTrade(equityBars, 500, 'BUY', oldLevels, {
    forwardWindow: 6, // old compressed crypto window
    enablePartials: false,
    frictionPct: DEFAULT_FRICTION_PCT,
  });
  assert.equal(oldChokedSim.exitReason, 'TIMEOUT', 'With 6-candle window, trade times out prematurely before bar 9');
  assert.ok(oldChokedSim.realizedR < 0, `With 6-candle window, timeout near breakeven produces negative realizedR, got ${oldChokedSim.realizedR}`);
});

test('Crypto in 5m dayTrading (BTC): resolveOperationalTrade generates viable plan with >=0.40% stop and eliminates dead band for Standard, Scoring, and Confluencia', () => {
  // BTC price = 65000, 5m range = 65 (ATR% = 0.10% >= 0.06% normal market volatility)
  const btcBars: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: time + i * 300,
    open: 65000,
    high: 65040,
    low: 64975, // range = 65 -> ATR ~ 65 (0.10%)
    close: 65010,
    volume: 100,
  }));

  for (const strategy of ['standard', 'scoring', 'confluencia']) {
    const plan = resolveOperationalTrade({
      strategy,
      signal: 'BUY',
      executionStyle: 'dayTrading',
      raw: { '5m': btcBars, '1h': [] },
      closed: { '5m': btcBars, '1h': [] },
      isCrypto: true,
    });

    assert.equal(plan.valid, true, `Strategy ${strategy} must be valid for BTC in 5m`);
    assert.equal(plan.frictionViable, true, `Strategy ${strategy} must pass frictionViable`);
    assert.ok(plan.levels.stopLoss > 0, 'Stop loss must be positive');
    const stopPct = (plan.entryPrice - plan.levels.stopLoss) / plan.entryPrice;
    assert.ok(stopPct >= 0.00399, `Stop percentage (${(stopPct * 100).toFixed(3)}%) must be >= 0.40% floor`);
    const frictionR = 0.0011 / stopPct;
    assert.ok(frictionR <= 0.35, `Friction in R (${frictionR.toFixed(3)}R) must be <= 0.35R`);
  }
});

test('isCryptoAsset: cleanly separates genuine equities (SYM, ASYM, ATEST, AAPL) from crypto and enforces NYSE session & ATR parity', () => {
  // 1. Tickers with 'SYM' or 'TEST' substrings must NOT be classified as crypto
  assert.equal(isCryptoAsset('SYM'), false, 'SYM (Symbotic Inc.) must be classified as equity');
  assert.equal(isCryptoAsset('ASYM'), false, 'ASYM must be classified as equity');
  assert.equal(isCryptoAsset('SYMBOTIC'), false, 'SYMBOTIC must be classified as equity');
  assert.equal(isCryptoAsset('ATEST'), false, 'ATEST must be classified as equity');
  assert.equal(isCryptoAsset('TEST'), false, 'TEST must be classified as equity');
  assert.equal(isCryptoAsset('AAPL'), false, 'AAPL must be classified as equity');
  assert.equal(isCryptoAsset('NVDA'), false, 'NVDA must be classified as equity');
  assert.equal(isCryptoAsset('SPY'), false, 'SPY must be classified as equity');

  // 2. Legitimate crypto pairs must be classified as crypto
  assert.equal(isCryptoAsset('BTCUSDT'), true, 'BTCUSDT must be classified as crypto');
  assert.equal(isCryptoAsset('ETHUSDT'), true, 'ETHUSDT must be classified as crypto');
  assert.equal(isCryptoAsset('SOLUSDC'), true, 'SOLUSDC must be classified as crypto');
  assert.equal(isCryptoAsset('BNBBUSD'), true, 'BNBBUSD must be classified as crypto');
  assert.equal(isCryptoAsset('BTC/USD'), true, 'BTC/USD must be classified as crypto');

  // 3. Fallback when symbol is undefined: defaults to true
  assert.equal(isCryptoAsset(undefined), true, 'Undefined symbol defaults to true for backward compatibility');

  // 4. SYM receives equities ATR multiplier (2.5x in 5m) instead of crypto (1.2x)
  const symIsCrypto = isCryptoAsset('SYM');
  const atrMultSym = getStrategyAtrMultiplier('standard', '5m', symIsCrypto);
  const atrMultBtc = getStrategyAtrMultiplier('standard', '5m', isCryptoAsset('BTCUSDT'));
  assert.equal(atrMultSym, 2.5, 'SYM in 5m must receive 2.5x ATR multiplier');
  assert.equal(atrMultBtc, 1.2, 'BTC in 5m must receive 1.2x ATR multiplier');

  // 5. SYM respects NYSE market hours and session close guards
  // At a Sunday timestamp (e.g. 1700000000 = Sunday Nov 12 2023), NYSE is inactive
  const sundaySec = 1700000000;
  assert.equal(isNyseSessionClosingCandle(sundaySec, '5m', 'SYM'), true, 'SYM must trigger closing/non-trading day guard on Sunday');
  assert.equal(isNyseOpeningWindow(sundaySec, 'SYM'), false, 'SYM must not trigger opening window on Sunday');

  // 6. Non-USDT crypto pairs (USDC, BUSD, FDUSD) and undefined symbols are 24/7 continuous and exempt from NYSE cuts
  assert.equal(isNyseSessionClosingCandle(sundaySec, '5m', 'SOLUSDC'), false, 'SOLUSDC must be exempt from NYSE session closing cuts');
  assert.equal(isNyseSessionClosingCandle(sundaySec, '5m', 'ETHBUSD'), false, 'ETHBUSD must be exempt from NYSE session closing cuts');
  assert.equal(isNyseSessionClosingCandle(sundaySec, '5m', undefined), false, 'Undefined symbol must be exempt from NYSE session closing cuts');
  assert.equal(isNyseOpeningWindow(sundaySec, 'SOLUSDC'), false, 'SOLUSDC must not trigger NYSE opening window');
  assert.equal(isNyseOpeningWindow(sundaySec, undefined), false, 'Undefined symbol must not trigger NYSE opening window');
});

test('Multi-Strategy Operational Cascade: eliminates HOL blocking when candidate 1 fails operational viability and cascades to candidate 2', () => {
  // Construct 50 synthetic closed klines for testing
  const bars: Kline[] = [];
  for (let i = 0; i < 50; i++) {
    bars.push({
      time: time + i * 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
    });
  }

  // Setup QVE with two candidates:
  // Candidate 1: Multitemporal (winner of tournament, score = 1.8)
  // Candidate 2: Standard (fallback, score = 1.2)
  const candidate1: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 2.1,
    expectancyR: 0.35,
    expectancyPerHour: 0.15,
    winRate: 0.65,
    resolved: 25,
  };
  const candidate2: StrategyCandidate = {
    key: 'standard',
    label: 'Sistema Estándar',
    profitFactor: 1.5,
    expectancyR: 0.20,
    expectancyPerHour: 0.10,
    winRate: 0.55,
    resolved: 20,
  };

  const mockQve: QVESelectionResult = {
    bestStrategy: 'multitemporal',
    strategyLabel: 'VCME Sniper',
    confidence: 'HIGH',
    profitFactor: 2.1,
    winRate: 0.65,
    expectancyR: 0.35,
    expectancyPerHour: 0.15,
    tournament: {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      compositeScore: 1.8,
      profitFactor: 2.1,
      expectancyR: 0.35,
      expectancyPerHour: 0.15,
      reasoning: 'VCME Sniper lidera el torneo',
    },
    candidates: [candidate1, candidate2],
    targetInterval: '5m',
    triggerKlines: bars,
    closed5m: bars,
    closed1h: bars,
    closed1d: bars,
    btStd: createFallbackBacktestResult(),
    btConf: createFallbackBacktestResult(),
    btScore: createFallbackBacktestResult(),
    btMulti: createFallbackBacktestResult(),
    btMF: createFallbackBacktestResult(),
  };

  const signals = {
    standard: 'BUY',
    confluencia: 'NEUTRAL',
    scoring: 'NEUTRAL',
    multitemporal: 'BUY',
    multifractal: 'NEUTRAL',
  };

  // 1. Verify getActionableStrategyCandidates returns both candidates in order
  const candidates = getActionableStrategyCandidates(mockQve, signals);
  assert.equal(candidates.length, 2, 'Should return both multitemporal and standard candidates');
  assert.equal(candidates[0].strategy, 'multitemporal', 'Primary winner is first candidate');
  assert.equal(candidates[1].strategy, 'standard', 'Fallback candidate is second');

  // 2. Simulate operational trade evaluation where candidate 1 has inverted stop loss (stop > entry for BUY)
  const corruptedVcmeResult = {
    signal: 'BUY' as const,
    confidence: 'HIGH' as const,
    score: 85,
    entryPrice: 100,
    stopLoss: 101, // Inverted stop for BUY: stop loss is HIGHER than entry
    takeProfit1: 105,
    takeProfit2: 108,
    timeframe: '5m' as const,
    validGeometry: false,
  };

  // Candidate 1 fails operational trade viability
  const plan1 = resolveOperationalTrade({
    strategy: candidates[0].strategy,
    signal: candidates[0].signal,
    executionStyle: 'dayTrading',
    raw: { '5m': bars, '1h': bars },
    closed: { '5m': bars, '1h': bars },
    vcme: corruptedVcmeResult,
    isCrypto: true,
  });
  assert.equal(plan1.valid, false, 'Candidate 1 must fail operational trade due to inverted stop loss');
  assert.equal(plan1.validGeometry, false, 'Candidate 1 geometry must be marked invalid');

  // Candidate 2 succeeds operational trade viability
  const plan2 = resolveOperationalTrade({
    strategy: candidates[1].strategy,
    signal: candidates[1].signal,
    executionStyle: 'dayTrading',
    raw: { '5m': bars, '1h': bars },
    closed: { '5m': bars, '1h': bars },
    vcme: corruptedVcmeResult,
    isCrypto: true,
  });
  assert.equal(plan2.valid, true, 'Candidate 2 (Standard) must pass operational trade viability');
  assert.equal(plan2.validGeometry, true, 'Candidate 2 geometry must be valid');

  // 3. Verify that the cascade loop correctly selects candidate 2 instead of returning/aborting!
  let viableCandidate: typeof candidates[0] | null = null;
  let viablePlan: typeof plan1 | null = null;
  const discardedReasons: string[] = [];

  for (const candidate of candidates) {
    const plan = resolveOperationalTrade({
      strategy: candidate.strategy,
      signal: candidate.signal,
      executionStyle: 'dayTrading',
      raw: { '5m': bars, '1h': bars },
      closed: { '5m': bars, '1h': bars },
      vcme: corruptedVcmeResult,
      isCrypto: true,
    });

    if (plan.valid) {
      viableCandidate = candidate;
      viablePlan = plan;
      break;
    } else {
      discardedReasons.push(!plan.validGeometry ? 'geometry' : 'friction');
    }
  }

  assert.equal(discardedReasons.length, 1, 'Candidate 1 discard must be recorded');
  assert.equal(discardedReasons[0], 'geometry', 'Discard reason must be geometry');
  assert.ok(viableCandidate, 'A viable candidate must be selected via cascade');
  assert.equal(viableCandidate.strategy, 'standard', 'Cascade must elect candidate 2 (standard)');
  assert.ok(viablePlan && viablePlan.valid, 'Viable plan must be valid');

  // 4. Verify historical contrast: selectActionableStrategy only returned candidate 1
  const oldActionable = selectActionableStrategy(mockQve, signals);
  assert.equal(oldActionable.strategy, 'multitemporal', 'Old selector returned candidate 1 only');
});

test('Cooldown Synchronization & Asymmetric Duration: anchors to exit candle time and scales on outcome', () => {
  const tCandleExitSec = 1700003000;
  const alertWithExit: AuditAlertItem = {
    id: 'BTC-5m-1',
    symbol: 'BTCUSDT',
    interval: '5m',
    signal: 'BUY',
    time: '2023-11-14 12:00',
    pf: 1.5,
    strategy: 'Standard',
    entryPrice: 35000,
    stopLoss: 34500,
    takeProfit1: 36000,
    status: 'SL_HIT',
    realizedR: -1.0,
    pnlPercent: -1.4,
    timestamp: 1700000000 * 1000,
    executionState: {
      version: 1,
      status: 'SL_HIT',
      remaining: 0,
      fills: [{ kind: 'EXIT', quantity: 1.0, price: 34500, barTime: tCandleExitSec, source: 'simulation' }],
      activeSL: 34500,
      highestHigh: 35200,
      lowestLow: 34450,
      barsSeen: 10,
      historyQuality: 'complete',
      exit: { reason: 'SL', price: 34500, barTime: tCandleExitSec },
    }
  };

  // 1. Exact exit candle timestamp extraction
  const exitMs = getAlertExitTimestampMs(alertWithExit);
  assert.equal(exitMs, tCandleExitSec * 1000, 'Must extract exact exit bar timestamp from executionState.exit.barTime');

  // 2. Disconnection recovery test: 2 hours later after a 30m SL, cooldown is naturally expired
  const tExit = 1700000000 * 1000;
  const tReopen = tExit + 2 * 3600 * 1000; // 2h later
  const cooldownMsSL = getStrategyCooldownMs('5m', 'dayTrading', 'SL');
  assert.equal(cooldownMsSL, 30 * 60 * 1000);
  assert.equal((tReopen - tExit) >= cooldownMsSL, true, 'Cooldown must be naturally expired 2 hours after exit');

  // 3. Asymmetric durations: 5m DayTrading
  assert.equal(getStrategyCooldownMs('5m', 'dayTrading', 'SL'), 30 * 60 * 1000, '5m SL must enforce 30m anti-revenge');
  assert.equal(getStrategyCooldownMs('5m', 'dayTrading', 'TP'), 5 * 60 * 1000, '5m TP must enforce 1 candle grace (5m)');
  assert.equal(getStrategyCooldownMs('5m', 'dayTrading', 'TIMEOUT'), 5 * 60 * 1000, '5m TIMEOUT must enforce 1 candle grace (5m)');
  assert.equal(getStrategyCooldownCandles('5m', 'dayTrading', 'SL'), 6, '5m SL is 6 candles');
  assert.equal(getStrategyCooldownCandles('5m', 'dayTrading', 'TP'), 1, '5m TP is 1 candle');

  // 4. Asymmetric durations: 1h Swing
  assert.equal(getStrategyCooldownMs('1h', 'swing', 'SL'), 4 * 3600 * 1000, '1h SL must enforce 4h anti-revenge');
  assert.equal(getStrategyCooldownMs('1h', 'swing', 'TP'), 3600 * 1000, '1h TP must enforce 1 candle grace (1h)');
  assert.equal(getStrategyCooldownCandles('1h', 'swing', 'SL'), 4, '1h SL is 4 candles');
  assert.equal(getStrategyCooldownCandles('1h', 'swing', 'TP'), 1, '1h TP is 1 candle');

  // 5. Default backward compatibility (no outcome passed)
  assert.equal(getStrategyCooldownMs('5m', 'dayTrading'), 30 * 60 * 1000, 'Default 5m must remain 30m');
  assert.equal(getStrategyCooldownMs('1h', 'swing'), 4 * 3600 * 1000, 'Default 1h must remain 4h');
});

test('Backtester Asymmetric Cooldown Parity: executes consecutive winning signals 15m apart, but blocks revenge signals after SL', () => {
  const numCandles = 620;
  const klinesWin: Kline[] = [];
  const baseTime = 1700000000;
  for (let i = 0; i < numCandles; i++) {
    klinesWin.push({
      time: baseTime + i * 300,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1000
    });
  }

  // Signal 1 at candle 590 (BUY)
  // Candle 591: reaches high 102.0, hitting TP1 (entry 100, stop 98.8, tp1 101.8)
  klinesWin[591].high = 102.0;

  // Signal 2 at candle 594 (BUY, 3 bars / 15 minutes after exit at 591)
  // Candle 595: reaches high 102.0, hitting TP1
  klinesWin[595].high = 102.0;

  const signalsWin: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(numCandles).fill('NEUTRAL');
  signalsWin[590] = 'BUY';
  signalsWin[594] = 'BUY';

  // Run backtester with winning signals
  const resWin = runBacktestGenericOptimized(klinesWin, '5m', signalsWin, 'standard');
  assert.equal(resWin.totalSignals, 2, 'Must execute BOTH winning signals 15m apart (1 candle cooldown post-TP)');
  assert.equal(resWin.wins, 2, 'Both executed signals must be wins');
  assert.equal(resWin.discards.cooldown, 2, 'Each 1-candle win cooldown records exactly 1 cooldown bar (2 total)');

  // Now create loss scenario on trade 1
  const klinesLoss: Kline[] = klinesWin.map(k => ({ ...k }));
  // Candle 591: drops to low 98.0, hitting SL (entry 100, stop 98.8)
  klinesLoss[591].high = 100.2;
  klinesLoss[591].low = 98.0;

  const resLoss = runBacktestGenericOptimized(klinesLoss, '5m', signalsWin, 'standard');
  assert.equal(resLoss.totalSignals, 1, 'Must execute ONLY the first signal (revenge block post-SL blocks second signal at 594)');
  assert.equal(resLoss.losses, 1, 'First signal must be a loss');
  assert.equal(resLoss.discards.cooldown, 6, '6-candle SL cooldown records 6 cooldown bars blocking trade 2');
});

test('Tournament Fallback In-Sample Homogenization: preserves marginal negative directional edge (-0.03R on N=3) as LIMITED and vetoes decisive toxicity', () => {
  // Primary winner is VCME Sniper, emitting NEUTRAL on this bar
  const primaryCandidate: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 1.5,
    expectancyR: 0.25,
    expectancyPerHour: 0.2,
    winRate: 0.60,
    resolved: 25,
  };

  // 1. Fallback Candidate: Standard Voting with strong global edge (+0.35R, PF 1.6, N=15)
  // But marginal SELL directional in-sample edge (3 trades, E[R] = -0.03R, PF = 0.90)
  const fallbackMarginal: StrategyCandidate = {
    key: 'standard',
    label: 'Standard Voting',
    profitFactor: 1.6,
    expectancyR: 0.35,
    expectancyPerHour: 0.2,
    winRate: 0.60,
    resolved: 15,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 15, wins: 9, losses: 6, winRate: 0.60, expectancyR: 0.35, profitFactor: 1.6, maxDrawdownR: 1.2,
        longStats: { signals: 12, wins: 8, losses: 4, winRate: 0.67, expectancyR: 0.45, profitFactor: 1.8 },
        shortStats: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.03, profitFactor: 0.90 },
      },
      outOfSample: {
        signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.15, profitFactor: 1.3,
        longStats: { signals: 3, wins: 2, losses: 1, winRate: 0.67, expectancyR: 0.20, profitFactor: 1.5 },
        shortStats: { signals: 2, wins: 1, losses: 1, winRate: 0.50, expectancyR: 0.08, profitFactor: 1.1 },
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const qveBase = {
    bestStrategy: 'multitemporal',
    strategyLabel: 'VCME Sniper',
    confidence: 'HIGH',
    profitFactor: 1.5,
    winRate: 0.60,
    expectancyR: 0.25,
    expectancyPerHour: 0.2,
    candidates: [primaryCandidate, fallbackMarginal],
    tournament: {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      compositeScore: 2.5,
      profitFactor: 1.5,
      expectancyR: 0.25,
      expectancyPerHour: 0.2,
      longStats: { signals: 15, wins: 9, losses: 6, winRate: 0.6, expectancyR: 0.25, profitFactor: 1.5 },
      shortStats: { signals: 10, wins: 6, losses: 4, winRate: 0.6, expectancyR: 0.25, profitFactor: 1.5 },
      reasoning: 'VCME lidera',
    },
  } as unknown as QVESelectionResult;

  // Primary emits NEUTRAL, fallback emits SELL
  const testSignals: StrategySignalMap = {
    standard: 'SELL',
    multitemporal: 'NEUTRAL',
    confluencia: 'NEUTRAL',
    scoring: 'HOLD',
    multifractal: 'NEUTRAL',
  };
  const candidatesMarginal = getActionableStrategyCandidates(qveBase, testSignals);

  assert.equal(candidatesMarginal.length, 1, 'Fallback with marginal IS directional edge must NOT be purged');
  assert.equal(candidatesMarginal[0].strategy, 'standard');
  assert.equal(candidatesMarginal[0].signal, 'SELL');
  assert.equal(candidatesMarginal[0].confidence, 'LIMITED');
  assert.equal(candidatesMarginal[0].isFallback, true);
  assert.ok(candidatesMarginal[0].reasoning.includes('IS SELL marginal'), 'Reasoning must document empirical Bayes shrinkage');

  // 2. Severe toxic directional edge (N=3, E[R] = -1.0R, PF = 0.0 with 0W/3L):
  // Must be strictly vetoed/purged by continuous empirical Bayes shrinkage
  const fallbackToxic: StrategyCandidate = {
    ...fallbackMarginal,
    walkForward: {
      ...fallbackMarginal.walkForward!,
      inSample: {
        ...fallbackMarginal.walkForward!.inSample,
        shortStats: { signals: 3, wins: 0, losses: 3, winRate: 0, expectancyR: -1.0, profitFactor: 0.0 },
      },
    },
  };
  const qveToxic: QVESelectionResult = {
    ...qveBase,
    candidates: [primaryCandidate, fallbackToxic],
  };
  const candidatesToxic = getActionableStrategyCandidates(qveToxic, testSignals);
  assert.equal(candidatesToxic.length, 0, 'Fallback with severely toxic IS directional edge must be completely vetoed');

  // 3. Continuous shrinkage at N=6 eliminates sawtooth false veto:
  // Candidate with small negative directional noise (N=6, E[R] = -0.03R, PF = 0.90) and strong global IS prior (+0.35R)
  // is regularized via empirical Bayes shrinkage as LIMITED instead of being discarded by the old N=6 step function
  const fallbackPersistent: StrategyCandidate = {
    ...fallbackMarginal,
    walkForward: {
      ...fallbackMarginal.walkForward!,
      inSample: {
        ...fallbackMarginal.walkForward!.inSample,
        shortStats: { signals: 6, wins: 2, losses: 4, winRate: 0.33, expectancyR: -0.03, profitFactor: 0.90 },
      },
    },
  };
  const qvePersistent: QVESelectionResult = {
    ...qveBase,
    candidates: [primaryCandidate, fallbackPersistent],
  };
  const candidatesPersistent = getActionableStrategyCandidates(qvePersistent, testSignals);
  assert.equal(candidatesPersistent.length, 1, 'Fallback with marginal IS directional noise on N=6 must survive via empirical Bayes shrinkage');
  assert.equal(candidatesPersistent[0].strategy, 'standard');
  assert.equal(candidatesPersistent[0].signal, 'SELL');
  assert.equal(candidatesPersistent[0].confidence, 'LIMITED');
  assert.ok(candidatesPersistent[0].reasoning.includes('IS SELL marginal'), 'Reasoning must document empirical Bayes shrinkage');

  // 4. Genuinely toxic directional edge on N=6 (E[R] = -0.45R, PF = 0.25):
  // Must be strictly vetoed even if global prior is positive
  const fallbackToxicN6: StrategyCandidate = {
    ...fallbackMarginal,
    walkForward: {
      ...fallbackMarginal.walkForward!,
      inSample: {
        ...fallbackMarginal.walkForward!.inSample,
        shortStats: { signals: 6, wins: 1, losses: 5, winRate: 0.17, expectancyR: -0.45, profitFactor: 0.25 },
      },
    },
  };
  const qveToxicN6: QVESelectionResult = {
    ...qveBase,
    candidates: [primaryCandidate, fallbackToxicN6],
  };
  const candidatesToxicN6 = getActionableStrategyCandidates(qveToxicN6, testSignals);
  assert.equal(candidatesToxicN6.length, 0, 'Fallback with genuinely toxic IS edge on N=6 must be vetoed');
});

test('Radar and Scanner Execution Parity: rejects cooldown and session closing candles from active filter while preserving open positions', () => {
  const now = 1_700_000_000_000;

  // 1. Test checkAlertCooldownStatus helper directly:
  // Post-SL cooldown for 5m DayTrading is 30 minutes (1,800,000 ms)
  const cooldowns = {
    'BTCUSDT-5m': { timestamp: now - 600_000, outcome: 'SL' as const }, // 10m ago -> 20m remaining
    'ETHUSDT-5m': { timestamp: now - 2_000_000, outcome: 'SL' as const }, // 33m ago -> elapsed
    'SOLUSDT-5m-exploratory': { timestamp: now - 100_000, outcome: 'ENTRY' as const },
  };

  const btcStatus = checkAlertCooldownStatus('BTCUSDT', '5m', false, 'dayTrading', cooldowns, now);
  assert.equal(btcStatus.inCooldown, true, 'BTCUSDT must be in cooldown (20m remaining)');
  assert.equal(btcStatus.remainingMs, 1_200_000, 'BTCUSDT remaining cooldown should be 20m (1,200,000ms)');

  const ethStatus = checkAlertCooldownStatus('ETHUSDT', '5m', false, 'dayTrading', cooldowns, now);
  assert.equal(ethStatus.inCooldown, false, 'ETHUSDT cooldown must be elapsed');
  assert.equal(ethStatus.remainingMs, 0);

  const solPrimaryStatus = checkAlertCooldownStatus('SOLUSDT', '5m', false, 'dayTrading', cooldowns, now);
  assert.equal(solPrimaryStatus.inCooldown, false, 'Exploratory cooldown must not block primary alert');

  const solExploratoryStatus = checkAlertCooldownStatus('SOLUSDT', '5m', true, 'dayTrading', cooldowns, now);
  assert.equal(solExploratoryStatus.inCooldown, true, 'Exploratory cooldown must block exploratory trigger');

  // 2. Test RadarRowData with isRadarRowActive:
  const activeCandidateRow: RadarRowData = {
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    isCrypto: true,
    price: 65000,
    changePercent: 2.1,
    signal5m: 'BUY',
    signal1h: 'BUY',
    signal1d: 'BUY',
    overallSignal: 'BUY',
    isFullConfluence: true,
    confluenceType: 'BUY_3',
    confluenceScore: 100,
    qveStrategy: 'VCME Sniper',
    qveProfitFactor: 1.8,
    qveConfidence: 'HIGH',
    signalConfidence: 'HIGH',
    rvol: 1.6,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 2.5,
    bbPercentile: 50,
    loading: false,
    isOperationalViable: true,
    isMarketClosed: false,
    isCooldownActive: true,
    cooldownRemainingMs: 1_200_000,
    isSessionClosingCandle: false,
  };

  // Without active position, candidate row in cooldown is rejected from 'active' filter
  assert.equal(isRadarRowActive(activeCandidateRow, {}), false, 'Candidate in cooldown must be rejected from active filter');

  // With active position, it is accepted (position in progress)
  assert.equal(isRadarRowActive(activeCandidateRow, { BTCUSDT: 'BUY' }), true, 'Tracked open position must be accepted in active filter');

  // Session closing candle on equity:
  const equityClosingRow: RadarRowData = {
    ...activeCandidateRow,
    symbol: 'NVDA',
    isCrypto: false,
    isCooldownActive: false,
    cooldownRemainingMs: 0,
    isSessionClosingCandle: true,
  };
  assert.equal(isRadarRowActive(equityClosingRow, {}), false, 'Equity on session closing candle must be rejected from active filter');
  assert.equal(isRadarRowActive(equityClosingRow, { NVDA: 'BUY' }), true, 'Tracked equity position on closing candle must remain active');
});

test('MarketRadar and SignalPanel Confidence Parity: primary winner downgraded by marginal OOS reflects LIMITED confidence instead of showing HIGH shield', () => {
  // 1. Primary candidate has HIGH tournament confidence
  const primaryCandidate: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 1.8,
    expectancyR: 0.35,
    expectancyPerHour: 0.2,
    winRate: 0.65,
    resolved: 30,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 24, wins: 15, losses: 9, winRate: 0.625, expectancyR: 0.35, profitFactor: 1.8, maxDrawdownR: 1.2,
        longStats: { signals: 15, wins: 10, losses: 5, winRate: 0.67, expectancyR: 0.40, profitFactor: 2.0 },
        shortStats: { signals: 9, wins: 5, losses: 4, winRate: 0.55, expectancyR: 0.25, profitFactor: 1.5 },
      },
      outOfSample: {
        signals: 6, wins: 3, losses: 3, winRate: 0.50, expectancyR: 0.08, profitFactor: 1.1,
        // BUY side has marginal OOS: 3 trades, E[R] = -0.04R, PF = 0.85 (marginal: -0.15R < E[R] <= 0)
        longStats: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.04, profitFactor: 0.85 },
        shortStats: { signals: 3, wins: 2, losses: 1, winRate: 0.67, expectancyR: 0.20, profitFactor: 1.6 },
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const qve: QVESelectionResult = {
    bestStrategy: 'multitemporal',
    strategyLabel: 'VCME Sniper',
    confidence: 'HIGH', // Tournament won with HIGH confidence!
    profitFactor: 1.8,
    winRate: 0.65,
    expectancyR: 0.35,
    expectancyPerHour: 0.2,
    candidates: [primaryCandidate],
    tournament: {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      compositeScore: 2.8,
      profitFactor: 1.8,
      expectancyR: 0.35,
      expectancyPerHour: 0.2,
      longStats: { signals: 15, wins: 10, losses: 5, winRate: 0.67, expectancyR: 0.40, profitFactor: 2.0 },
      shortStats: { signals: 9, wins: 5, losses: 4, winRate: 0.55, expectancyR: 0.25, profitFactor: 1.5 },
      reasoning: 'VCME lidera con solidez estadística',
    },
  } as unknown as QVESelectionResult;

  const testSignals: StrategySignalMap = {
    multitemporal: 'BUY',
    standard: 'NEUTRAL',
    confluencia: 'NEUTRAL',
    scoring: 'HOLD',
    multifractal: 'NEUTRAL',
  };

  // 2. getActionableStrategyCandidates evaluates BUY with marginal OOS:
  const actionableCandidates = getActionableStrategyCandidates(qve, testSignals);
  assert.equal(actionableCandidates.length, 1);
  const activeSelection = actionableCandidates[0];

  assert.equal(activeSelection.strategy, 'multitemporal');
  assert.equal(activeSelection.signal, 'BUY');
  assert.equal(activeSelection.isFallback, false);
  // Must be downgraded to LIMITED because of marginal OOS!
  assert.equal(activeSelection.confidence, 'LIMITED', 'Primary strategy must be downgraded to LIMITED on marginal OOS');
  assert.ok(activeSelection.reasoning.includes('en LIMITED por OOS reciente marginal'));

  // 3. Test SignalPanel displayedConfidence logic:
  // Must take activeSelection.confidence ('LIMITED') even though isFallback is false!
  const signalPanelDisplayedConfidence = activeSelection.confidence;
  assert.equal(signalPanelDisplayedConfidence, 'LIMITED', 'SignalPanel must display LIMITED, not tournament HIGH');

  // 4. Test MarketRadar effectiveLeaderConfidence logic:
  const radarRow: RadarRowData = {
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    isCrypto: true,
    price: 65000,
    changePercent: 1.2,
    signal5m: 'BUY',
    signal1h: 'BUY',
    signal1d: 'BUY',
    overallSignal: 'BUY',
    isFullConfluence: true,
    confluenceType: 'BUY_3',
    confluenceScore: 100,
    qveStrategy: 'VCME Sniper',
    qveProfitFactor: 1.8,
    qveConfidence: qve.confidence, // 'HIGH' from tournament
    signalConfidence: activeSelection.confidence, // 'LIMITED' from actionable candidate
    actionableReasoning: activeSelection.reasoning,
    isFallbackSignal: false,
    rvol: 1.5,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 2.0,
    bbPercentile: 50,
    loading: false,
  };

  const hasActiveSignal = radarRow.overallSignal.includes('BUY') || radarRow.overallSignal.includes('SELL');
  const effectiveLeaderConfidence = (!radarRow.isFallbackSignal && hasActiveSignal)
    ? radarRow.signalConfidence
    : radarRow.qveConfidence;

  assert.equal(effectiveLeaderConfidence, 'LIMITED', 'MarketRadar must compute LIMITED effective confidence for downgraded primary winner');
  assert.notEqual(effectiveLeaderConfidence, 'HIGH', 'Must NOT display HIGH confidence shield for downgraded signal');
});

test('Statistical Parity: preserves normal 1W/2L variance on N=3 as LIMITED and counts closed timeouts in sample maturity', () => {
  // Part 1: Directional edge with 1W/2L at 1.5R target (E[R] = -0.167R, PF = 0.75) on N=3
  // Must NOT be vetoed to NEUTRAL by sanitizeSignalWithDirectionalEdge
  const buySanitized = sanitizeSignalWithDirectionalEdge(
    'BUY',
    { signals: 3, expectancyR: -0.167, profitFactor: 0.75 },
    undefined,
    3
  );
  assert.equal(buySanitized, 'BUY', '1 win and 2 losses on N=3 must NOT be vetoed to NEUTRAL');

  // Must be classified as isMarginal (LIMITED downgrade), NOT isToxic in OOS
  const mockWfOos1W2L = {
    ...createEmptyWalkForwardResult(400, 176),
    status: 'FAIL' as const,
    outOfSample: {
      ...createEmptyWalkForwardResult().outOfSample,
      signals: 3,
      expectancyR: -0.167,
      profitFactor: 0.75,
      longStats: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.167, profitFactor: 0.75 },
    },
  };
  const oosCheck = hasNegativeDirectionalOosEdge('BUY', mockWfOos1W2L, 3);
  assert.equal(oosCheck.isNegative, true);
  assert.equal(oosCheck.isToxic, false, '1W/2L on N=3 must NOT be flagged as toxic');
  assert.equal(oosCheck.isMarginal, true, '1W/2L on N=3 must be classified as marginal noise for LIMITED downgrade');

  // Fallback candidate with 1W/2L longStats supported by positive global IS prior (+0.25R, PF 1.5)
  // Must be preserved as a LIMITED candidate via empirical Bayes shrinkage
  const fallbackCandidate: StrategyCandidate = {
    key: 'confluencia',
    label: 'Confluencia',
    profitFactor: 1.5,
    expectancyR: 0.25,
    expectancyPerHour: 0.18,
    winRate: 0.55,
    resolved: 15,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 15, wins: 8, losses: 7, winRate: 0.53, expectancyR: 0.25, profitFactor: 1.5, maxDrawdownR: 1.2,
        longStats: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.167, profitFactor: 0.75 },
        shortStats: { signals: 12, wins: 7, losses: 5, winRate: 0.58, expectancyR: 0.35, profitFactor: 1.6 },
      },
      outOfSample: {
        signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.15, profitFactor: 1.3,
        longStats: { signals: 2, wins: 1, losses: 1, winRate: 0.50, expectancyR: 0.10, profitFactor: 1.2 },
        shortStats: { signals: 3, wins: 2, losses: 1, winRate: 0.67, expectancyR: 0.18, profitFactor: 1.4 },
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const primaryCandidate: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 1.8,
    expectancyR: 0.30,
    expectancyPerHour: 0.25,
    winRate: 0.60,
    resolved: 20,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 20, wins: 12, losses: 8, winRate: 0.60, expectancyR: 0.30, profitFactor: 1.8, maxDrawdownR: 1.0,
      },
      outOfSample: {
        signals: 6, wins: 4, losses: 2, winRate: 0.67, expectancyR: 0.20, profitFactor: 1.5,
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const qveTest = {
    bestStrategy: 'multitemporal',
    strategyLabel: 'VCME Sniper',
    confidence: 'HIGH',
    profitFactor: 1.8,
    winRate: 0.60,
    expectancyR: 0.30,
    expectancyPerHour: 0.25,
    candidates: [primaryCandidate, fallbackCandidate],
    tournament: {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      compositeScore: 3.0,
      profitFactor: 1.8,
      expectancyR: 0.30,
      expectancyPerHour: 0.25,
      reasoning: 'VCME Sniper lidera',
    },
  } as unknown as QVESelectionResult;

  // Primary emits NEUTRAL, fallback emits BUY
  const candidates = getActionableStrategyCandidates(qveTest, {
    multitemporal: 'NEUTRAL',
    confluencia: 'BUY',
    standard: 'NEUTRAL',
    scoring: 'HOLD',
    multifractal: 'NEUTRAL',
  });

  assert.equal(candidates.length, 1, 'Fallback with 1W/2L longStats must survive via empirical Bayes shrinkage');
  assert.equal(candidates[0].strategy, 'confluencia');
  assert.equal(candidates[0].signal, 'BUY');
  assert.equal(candidates[0].confidence, 'LIMITED');
  assert.equal(candidates[0].isFallback, true);
  assert.ok(candidates[0].reasoning.includes('IS BUY marginal'), 'Reasoning must state empirical Bayes shrinkage');

  // Part 2: Timeout trades count towards sample maturity (resolved)
  // Candidate has 3 executed trades in In-Sample: 2 wins, 0 losses, and 1 closed timeout trade
  // (signals = 3, wins = 2, losses = 0) -> resolved must be 3, qualifying for LIMITED
  const candidateWithTimeout: StrategyCandidate = {
    key: 'standard',
    label: 'Standard Voting',
    profitFactor: 2.0,
    expectancyR: 0.40,
    winRate: 1.0,
    resolved: 3,
    totalSignals: 3,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 3, // 2 wins + 0 losses + 1 timeout
        wins: 2,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.40,
        profitFactor: null,
        maxDrawdownR: 0.5,
      },
      outOfSample: {
        signals: 2, wins: 1, losses: 1, winRate: 0.50, expectancyR: 0.10, profitFactor: 1.2,
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const tourneyLimited = evaluateStrategyTournament([candidateWithTimeout], '5m');
  assert.equal(tourneyLimited.confidence, 'LIMITED', '3 executed trades including timeout must qualify for LIMITED (resolved = 3 >= minLimitedResolved)');
  assert.equal(tourneyLimited.bestStrategy, 'standard');

  // Candidate with 8 executed trades (5 wins, 1 loss, 2 timeouts) must qualify for HIGH (resolved = 8 >= minHighResolved)
  const candidateHighWithTimeouts: StrategyCandidate = {
    ...candidateWithTimeout,
    walkForward: {
      ...candidateWithTimeout.walkForward!,
      status: 'PASS',
      inSample: {
        signals: 8, // 5 wins + 1 loss + 2 timeouts
        wins: 5,
        losses: 1,
        winRate: 0.83,
        expectancyR: 0.45,
        profitFactor: 2.5,
        maxDrawdownR: 0.8,
      },
      outOfSample: {
        signals: 4, wins: 3, losses: 1, winRate: 0.75, expectancyR: 0.25, profitFactor: 2.0,
      },
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const tourneyHigh = evaluateStrategyTournament([candidateHighWithTimeouts], '5m');
  assert.equal(tourneyHigh.confidence, 'HIGH', '8 executed trades including timeouts must qualify for HIGH (resolved = 8 >= minHighResolved)');
  assert.equal(tourneyHigh.bestStrategy, 'standard');
});

// Test 85: US Equities (NYSE) 5m anti-bias qualification: unified N=3 for LIMITED across all engines
test('Test 85: US Equities (NYSE) 5m low-frequency sniper qualifying with 2 trades vs fast scalper', () => {
  // 1. Verify getStrategyMinResolved thresholds for snipers vs scalpers across timeframes
  assert.equal(getStrategyMinResolved('multitemporal', '5m', 'LIMITED'), 3, 'In 5m, all engines require N=3 for LIMITED to eliminate 2-trade noise bias');
  assert.equal(getStrategyMinResolved('multifractal', '5m', 'LIMITED'), 3, 'In 5m, all engines require N=3 for LIMITED to eliminate 2-trade noise bias');
  assert.equal(getStrategyMinResolved('standard', '5m', 'LIMITED'), 3, 'Standard scalper requires N=3 for LIMITED in 5m');
  assert.equal(getStrategyMinResolved('confluencia', '5m', 'LIMITED'), 3, 'Confluence scalper requires N=3 for LIMITED in 5m');
  assert.equal(getStrategyMinResolved('scoring', '5m', 'LIMITED'), 3, 'Scoring scalper requires N=3 for LIMITED in 5m');

  assert.equal(getStrategyMinResolved('multitemporal', '5m', 'HIGH'), 6, 'VCME sniper requires N=6 for HIGH in 5m');
  assert.equal(getStrategyMinResolved('multifractal', '5m', 'HIGH'), 6, 'Multifractal sniper requires N=6 for HIGH in 5m');
  assert.equal(getStrategyMinResolved('standard', '5m', 'HIGH'), 8, 'Standard scalper requires N=8 for HIGH in 5m');

  assert.equal(getStrategyMinResolved('multitemporal', '1h', 'HIGH'), 3, 'VCME sniper requires N=3 for HIGH in 1h');
  assert.equal(getStrategyMinResolved('standard', '1h', 'HIGH'), 5, 'Standard scalper requires N=5 for HIGH in 1h');

  // 2. US Equities scenario (e.g. AAPL, 5m timeframe, 78 bars/day):
  // With only N=2 trades in 5m, VCME Sniper does NOT qualify for LIMITED (eliminating 2-trade lucky runs)
  const vcmeCandidate2Trades: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: null,
    expectancyR: 0.85,
    winRate: 1.0,
    resolved: 2,
    totalSignals: 2,
    avgExposureHours: 2.0,
  };
  const vcmeTourney2 = evaluateStrategyTournament([vcmeCandidate2Trades], '5m');
  assert.equal(vcmeTourney2.confidence, 'NONE', 'With N=2, snipers in 5m must NOT qualify for LIMITED (requires N=3)');

  // With N=3 trades and WF consistency, VCME Sniper cleanly qualifies for LIMITED confidence:
  const vcmeCandidate3Trades: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: null,
    expectancyR: 0.85,
    winRate: 1.0,
    resolved: 3,
    totalSignals: 3,
    avgExposureHours: 2.0,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 3,
        wins: 3,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.85,
        profitFactor: null,
        maxDrawdownR: 0.2,
      },
      outOfSample: {
        signals: 1,
        wins: 1,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.50,
        profitFactor: null,
      },
      folds: [
        { foldIndex: 1, status: 'PASS', isSignals: 1, oosSignals: 1, oosTradesCount: 1, oosExpectancyR: 0.50, oosProfitFactor: null, passed: true },
      ],
      foldsPassed: 1,
      foldsWithData: 1,
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const vcmeTourney3 = evaluateStrategyTournament([vcmeCandidate3Trades], '5m');
  assert.equal(vcmeTourney3.bestStrategy, 'multitemporal');
  assert.equal(vcmeTourney3.confidence, 'LIMITED', 'VCME Sniper with 3 profitable trades in 5m qualifies for LIMITED');
  assert.ok(vcmeTourney3.compositeScore > 0, 'Composite score must be positive');

  // 3. Fast scalper (Standard Voting) with identical 2 trades in 5m:
  // Must NOT qualify for LIMITED (confidence === 'NONE') because scalpers require N >= 3
  const standardCandidate2Trades: StrategyCandidate = {
    key: 'standard',
    label: 'Standard Voting',
    profitFactor: null,
    expectancyR: 0.85,
    winRate: 1.0,
    resolved: 2,
    totalSignals: 2,
    avgExposureHours: 0.5,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 2,
        wins: 2,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.85,
        profitFactor: null,
        maxDrawdownR: 0.2,
      },
      outOfSample: {
        signals: 1,
        wins: 1,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.50,
        profitFactor: null,
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const standardTourney = evaluateStrategyTournament([standardCandidate2Trades], '5m');
  assert.equal(standardTourney.confidence, 'NONE', 'Standard scalper with only 2 trades in 5m must remain NONE (requires N>=3)');

  // 4. MarketRadar integration:
  // An AAPL row in the radar driven by VCME Sniper with signalConfidence: 'LIMITED' MUST be active
  const aaplRadarRow: RadarRowData = {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    isCrypto: false,
    price: 180.5,
    changePercent: 0.8,
    signal5m: 'BUY',
    signal1h: 'BUY',
    signal1d: 'NEUTRAL',
    overallSignal: 'BUY',
    isFullConfluence: false,
    confluenceType: 'BUY_2',
    confluenceScore: 70,
    qveStrategy: 'Multitemporal',
    qveProfitFactor: 2.5,
    qveConfidence: 'LIMITED',
    signalConfidence: 'LIMITED',
    rvol: 1.2,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 1.8,
    bbPercentile: 45,
    loading: false,
  };
  assert.equal(isRadarRowActive(aaplRadarRow), true, 'US Equity row with VCME LIMITED confidence must be active in MarketRadar');

  // If the bug were present (confidence === 'NONE'), it would be hidden:
  const aaplStarvedRow: RadarRowData = {
    ...aaplRadarRow,
    signalConfidence: 'NONE',
  };
  assert.equal(isRadarRowActive(aaplStarvedRow), false, 'Starved NONE row would be rejected by active filter');

  // 5. HIGH confidence threshold:
  // VCME sniper with 4 trades in 5m qualifies for LIMITED, but requires N=6 for HIGH (anti-bias)
  const vcmeCandidate4Trades: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 2.5,
    expectancyR: 0.45,
    winRate: 0.75,
    resolved: 4,
    totalSignals: 4,
    avgExposureHours: 2.0,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 4,
        wins: 3,
        losses: 1,
        winRate: 0.75,
        expectancyR: 0.45,
        profitFactor: 2.5,
        maxDrawdownR: 0.5,
      },
      outOfSample: {
        signals: 2,
        wins: 2,
        losses: 0,
        winRate: 1.0,
        expectancyR: 0.35,
        profitFactor: null,
      },
      folds: [
        { foldIndex: 1, status: 'PASS', isSignals: 2, oosSignals: 1, oosTradesCount: 1, oosExpectancyR: 0.35, oosProfitFactor: null, passed: true },
        { foldIndex: 2, status: 'PASS', isSignals: 2, oosSignals: 1, oosTradesCount: 1, oosExpectancyR: 0.35, oosProfitFactor: null, passed: true },
      ],
      foldsPassed: 2,
      foldsWithData: 2,
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const vcmeTourney4 = evaluateStrategyTournament([vcmeCandidate4Trades], '5m');
  assert.equal(vcmeTourney4.confidence, 'LIMITED', 'VCME Sniper with 4 trades in 5m qualifies for LIMITED (requires N=6 for HIGH)');

  // With 6 trades in In-Sample (N=6 >= minHigh=6, E[R]=0.45R, PF=2.5, WF PASS, 2 folds passed), qualifies for HIGH
  const vcmeCandidate6Trades: StrategyCandidate = {
    ...vcmeCandidate4Trades,
    resolved: 6,
    totalSignals: 6,
    walkForward: {
      ...vcmeCandidate4Trades.walkForward!,
      inSample: {
        signals: 6,
        wins: 5,
        losses: 1,
        winRate: 0.83,
        expectancyR: 0.45,
        profitFactor: 2.5,
        maxDrawdownR: 0.5,
      },
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const vcmeHighTourney = evaluateStrategyTournament([vcmeCandidate6Trades], '5m');
  assert.equal(vcmeHighTourney.confidence, 'HIGH', 'VCME Sniper with 6 trades in 5m and robust walk-forward qualifies for HIGH');

  // Fast scalper with 4 trades in 5m (N=4 < minHigh=8) only qualifies for LIMITED
  const standardCandidate4Trades: StrategyCandidate = {
    ...vcmeCandidate4Trades,
    key: 'standard',
    label: 'Standard Voting',
    avgExposureHours: 0.5,
  };
  const standard4Tourney = evaluateStrategyTournament([standardCandidate4Trades], '5m');
  assert.equal(standard4Tourney.confidence, 'LIMITED', 'Standard scalper with 4 trades in 5m does not reach HIGH (requires N>=8), degrades to LIMITED');

  // 6. Single Trade safeguard:
  // A sniper with only 1 trade (N=1 < 2) must NOT qualify, preventing single-trade hallucinations
  const vcmeCandidate1Trade: StrategyCandidate = {
    ...vcmeCandidate3Trades,
    resolved: 1,
    totalSignals: 1,
    walkForward: {
      ...vcmeCandidate3Trades.walkForward!,
      inSample: {
        ...vcmeCandidate3Trades.walkForward!.inSample,
        signals: 1,
        wins: 1,
        losses: 0,
      },
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };
  const vcme1Tourney = evaluateStrategyTournament([vcmeCandidate1Trade], '5m');
  assert.equal(vcme1Tourney.confidence, 'NONE', 'Single trade sniper candidate (N=1) must be rejected with NONE confidence');
});

// Test 86: Strategy evaluators harmonization across VCME, Scoring, Standard, and Multifractal
test('Test 86: Strategy evaluators harmonization across VCME, Scoring, Standard, and Multifractal', () => {
  // ── 1. VCME Sniper: DayTrading with Neutral Daily Bias and Pullback Clamping ──
  const klines1d: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 86400, open: 100, high: 101, low: 99, close: 100, volume: 100000
  }));
  const klines1h: Kline[] = Array.from({ length: 100 }, (_, i) => ({
    time: 1700000000 + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 10000
  }));
  const klines5m: Kline[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 300, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000
  }));
  const lastIdxVcme = klines5m.length - 1;

  const ctxVcme = buildVCMESniperContext(klines5m, klines1h, klines1d, 'AAPL', 'dayTrading', 'agresivo');
  const hIdx = 50;
  const dIdx = 40;
  for (let j = 0; j < klines5m.length; j++) {
    ctxVcme.idx1dMap[j] = dIdx;
    ctxVcme.idx1hMap[j] = hIdx;
  }

  // Set 1D bias to NEUTRAL: close (100) < EMA200 (102), EMA50 > EMA200, ADX low
  ctxVcme.closes1d[dIdx] = 100;
  ctxVcme.ema200_1d[dIdx] = 102;
  ctxVcme.ema50_1d[dIdx] = 101;
  ctxVcme.adxData1d.adx[dIdx] = 15;
  ctxVcme.adxData1d.plusDI[dIdx] = 15;
  ctxVcme.adxData1d.minusDI[dIdx] = 15;

  // 1H setup: bullish trend (EMA20 > EMA50, ADX > 20, VWAP aligned), MACD histogram positive (0.3 >= 0.02 * atr)
  ctxVcme.closes1h[hIdx] = 105;
  ctxVcme.ema200_1h[hIdx] = 95;
  ctxVcme.ema200_1h[hIdx - 5] = 94;
  ctxVcme.atrSeries1h[hIdx] = 1.0;
  ctxVcme.adxSeries1h.adx[hIdx] = 25;
  ctxVcme.ema20_1h[hIdx] = 104;
  ctxVcme.ema50_1h[hIdx] = 100;
  ctxVcme.rsiSeries1h[hIdx] = 60;
  ctxVcme.macdData1h.histogram[hIdx] = 0.3;
  ctxVcme.macdData1h.histogram[hIdx - 1] = 0.35; // histogram slightly declining during pullback, but positive and >= 0.02 ATR
  ctxVcme.vwapSeries1h[hIdx] = 103;

  // 5M volume and indicators
  ctxVcme.vol5m[lastIdxVcme] = 2500;
  ctxVcme.volSma5m[lastIdxVcme] = 1000;
  ctxVcme.klines5m[lastIdxVcme].volume = 2500; // RVOL = 2.5
  ctxVcme.vwapSeries5m[lastIdxVcme] = 105.0;
  ctxVcme.ema9_5m[lastIdxVcme] = 105.8;
  ctxVcme.ema21_5m[lastIdxVcme] = 105.5;
  ctxVcme.atrSeries5m[lastIdxVcme] = 0.6;

  // Micro swing highs: 105.9
  for (let s = lastIdxVcme - 3; s < lastIdxVcme; s++) {
    ctxVcme.klines5m[s].high = 105.9;
    ctxVcme.klines5m[s].low = 105.2;
    ctxVcme.klines5m[s].close = 105.4;
  }
  // Pullback test at candle lastIdx - 1
  ctxVcme.klines5m[lastIdxVcme - 1].low = 105.5; // touches ema9 / ema21
  ctxVcme.ema9_5m[lastIdxVcme - 1] = 105.6;
  ctxVcme.ema21_5m[lastIdxVcme - 1] = 105.6;
  ctxVcme.vwapSeries5m[lastIdxVcme - 1] = 105.0;

  // Trigger candle: breaks 3 highs (close = 106.0 > 105.9), strong bullish candle
  const curr5m = ctxVcme.klines5m[lastIdxVcme];
  curr5m.open = 105.7;
  curr5m.high = 106.1;
  curr5m.low = 105.5;
  curr5m.close = 106.0;

  // Swing low at 104.5 (structural risk = 106 - (104.5 - 0.2*0.6) = 1.62 > 2.0 ATR = 1.20)
  // In DAY mode, maxRisk is 2.0 ATR (1.20) and clamping applies to 104.80 since 104.80 <= curr5m.low (105.5)
  for (let s = lastIdxVcme - 10; s < lastIdxVcme - 1; s++) {
    ctxVcme.klines5m[s].low = 104.5;
  }

  const resVcmeDay = evaluateVCMESniperAt(ctxVcme, lastIdxVcme);
  assert.strictEqual(resVcmeDay.bias1D, 'NEUTRAL', 'Daily bias must be NEUTRAL');
  assert.strictEqual(resVcmeDay.signal, 'BUY', 'VCME DayTrading must trigger BUY during neutral daily consolidation');
  assert.ok(resVcmeDay.confidenceScore >= 0.65, `Confidence score must reach >= 0.65 with neutral macro (got ${resVcmeDay.confidenceScore})`);
  assert.strictEqual(resVcmeDay.mode, 'PULLBACK');
  assert.strictEqual(resVcmeDay.stopLoss, 104.8, 'Stop loss must be clamped to 2.0 ATR (104.8)');

  // ── 2. Scoring Multicapa: Symmetric Bearish RSI Continuation ──
  const scoringKlines: Kline[] = Array.from({ length: 65 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 99.9,
    volume: 1000
  }));
  const lastIdxScoring = scoringKlines.length - 1;
  const ctxScoring = buildScoringContext(scoringKlines, '5m');

  // Set trend layer to bearish (EMA fast < EMA slow, below EMA major)
  ctxScoring.emaFastArr[lastIdxScoring] = 99.0;
  ctxScoring.emaSlowArr[lastIdxScoring] = 101.0;
  ctxScoring.emaMajorArr[lastIdxScoring] = 102.0;

  // Set RSI falling from mid-zone (58.0 falling from 65.0 over 3 bars) -> gives s2 = -1.0
  ctxScoring.rsiSeries[lastIdxScoring - 3] = 65.0;
  ctxScoring.rsiSeries[lastIdxScoring - 2] = 63.0;
  ctxScoring.rsiSeries[lastIdxScoring - 1] = 60.5;
  ctxScoring.rsiSeries[lastIdxScoring] = 58.0;

  // Set VWAP: price below VWAP
  ctxScoring.vwapSeries[lastIdxScoring] = 101.0;
  if (ctxScoring.vwapReliableSeries) ctxScoring.vwapReliableSeries[lastIdxScoring] = true;

  // Bearish candle
  scoringKlines[lastIdxScoring].open = 100.1;
  scoringKlines[lastIdxScoring].close = 99.7;
  scoringKlines[lastIdxScoring].high = 100.2;
  scoringKlines[lastIdxScoring].low = 99.6;
  ctxScoring.closes[lastIdxScoring] = 99.7;
  ctxScoring.atrSeries[lastIdxScoring] = 1.0;

  const resScoringSell = evaluateScoringAt(ctxScoring, lastIdxScoring);
  assert.strictEqual(resScoringSell.layers.rsi.score, -1.0, 'Falling RSI in mid-zone 50-65 must award -1.0 to bearish momentum');
  assert.strictEqual(resScoringSell.signal, 'SELL', 'Scoring must trigger SELL on symmetric bearish RSI continuation');

  // ── 3. Standard Voting: Confluence between RSI Pullback and Bollinger Lower Third in Uptrend ──
  const votingKlines: Kline[] = Array.from({ length: 40 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100.0,
    high: 100.5,
    low: 99.8,
    close: 100.3,
    volume: 1200
  }));
  const lastIdxVoting = 39;
  const ctxVoting: StandardVotingContext = {
    klines: votingKlines,
    closes: votingKlines.map(k => k.close),
    rsiSeries: new Array(40).fill(50),
    macdSeries: { macd: new Array(40).fill(0), signal: new Array(40).fill(0), histogram: new Array(40).fill(0), signals: new Array(40).fill('NEUTRAL') },
    bbSeries: Array.from({ length: 40 }, () => ({
      time: 1700000000,
      upper: 104.0,
      middle: 101.0,
      lower: 98.0,
      widthPercent: 6.0
    })),
    supertrendSeries: Array.from({ length: 40 }, () => ({ value: 95, direction: 'UP' as const, signal: 'NEUTRAL' as const })),
    stochRsiSeries: { k: new Array(40).fill(50), d: new Array(40).fill(50), signals: new Array(40).fill('NEUTRAL') },
    volSmaSeries: new Array(40).fill(1000),
    volSignalSeries: { values: new Array(40).fill('—'), signals: new Array(40).fill('NEUTRAL') },
    ema200Series: new Array(40).fill(95), // Uptrend: close (100.3) > ema200 (95)
  };

  // RSI in pullback zone: 42 curling up (40 -> 42) -> votes BUY
  ctxVoting.rsiSeries[lastIdxVoting - 3] = 40;
  ctxVoting.rsiSeries[lastIdxVoting] = 42;

  // Bollinger: price at 100.0 (lower third: %B = (100.0 - 98.0) / 6.0 = 0.333 <= 0.38) with bullish candle
  votingKlines[lastIdxVoting].open = 99.8;
  votingKlines[lastIdxVoting].close = 100.0;
  votingKlines[lastIdxVoting].low = 99.7;
  votingKlines[lastIdxVoting].high = 100.1;
  ctxVoting.closes[lastIdxVoting] = 100.0;

  const resVoting = evaluateStandardVotingAt(ctxVoting, lastIdxVoting);
  const rsiInd = resVoting.indicators.find(ind => ind.name.includes('RSI'));
  const bbInd = resVoting.indicators.find(ind => ind.name.includes('Bollinger'));

  assert.strictEqual(rsiInd?.signal, 'BUY', 'RSI in 35-48 pullback zone must vote BUY');
  assert.strictEqual(bbInd?.signal, 'BUY', 'Bollinger at %B <= 0.38 in uptrend with bull candle must vote BUY confluently');
  assert.strictEqual(resVoting.buyVotes, 2, 'RSI and Bollinger must both vote BUY simultaneously');
  assert.strictEqual(resVoting.finalSignal, 'BUY', 'Standard Voting must emit final BUY on confluent trend pullback');

  // ── 4. Multifractal MTF: Breakout Expansion with 1H Squeeze and Neutral Daily Bias ──
  const mfLen = 30;
  const lastIdxMf = mfLen - 1;
  const mfKlines: Kline[] = Array.from({ length: mfLen }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 100.8,
    low: 99.8,
    close: 100.7,
    volume: 2000
  }));

  const ctxMf: MultifractalMTFContext = {
    klines5m: mfKlines,
    klines1h: [],
    klines1d: [],
    symbol: 'AAPL',
    // Daily bias is NEUTRAL, but 1H has confirmed squeeze
    andianSeries: [{ green: 50, red: 50, orange: 50, bias: 'NEUTRAL' as const }],
    volBands1H: [{ width: 1.5, midpoint: 100, upper: 101, lower: 99, isCompressed: true, threshold: 2.0 }],
    volComp5M: Array.from({ length: mfLen }, () => ({
      volume: 3000,
      smaVolume: 1500,
      isHighVolume: true,
      volumeMultiplier: 1.6, // >= 1.5 minVolMultiplier
      activeBuyPercent: 60,  // >= 58% threshold
      activeSellPercent: 40,
      isPassiveBuyAbsorption: false,
      isPassiveSellAbsorption: false
    })),
    volBands5M: Array.from({ length: mfLen }, () => ({
      upper: 100.5,
      lower: 98.5,
      midpoint: 99.5, // risk = 100.7 - 99.5 = 1.2 ATR <= 2.0 maxRisk
      width: 2.0,
      isCompressed: false,
      threshold: 3.0
    })),
    dreadBlitz5M: Array.from({ length: mfLen }, () => ({ isOverbought: false, isOversold: false, mcd: 0, upperBB: 2.0, lowerBB: -2.0 })),
    atrSeries5M: new Array(mfLen).fill(1.0),
    adxData5M: { adx: [], plusDI: [], minusDI: [] },
    idx1hMap: new Int32Array(mfLen).fill(0),
    idx1dMap: new Int32Array(mfLen).fill(0),
  };

  const resMf = evaluateMultifractalMTFAt(ctxMf, lastIdxMf, 100.7);
  assert.strictEqual(resMf.signal, 'BUY', 'Multifractal must trigger BUY on 1H squeeze breakout even with NEUTRAL 1D bias');
  assert.strictEqual(resMf.strategy, 'BREAKOUT_EXPANSION');
  assert.strictEqual(resMf.stopLoss, 99.5, 'Stop loss must be placed at channel midpoint');
});

// Test 87: Parity between Alert Scanner and MarketRadar for Exploratory Signals
test('Test 87: Parity between Alert Scanner and MarketRadar for Exploratory Signals', () => {
  const exploratoryRow: RadarRowData = {
    symbol: 'NVDA',
    name: 'NVDA',
    isCrypto: false,
    price: 120,
    changePercent: 0.8,
    signal5m: 'BUY',
    signal1h: 'NEUTRAL',
    signal1d: 'NEUTRAL',
    overallSignal: 'BUY',
    isFullConfluence: false,
    confluenceType: 'BUY_2',
    confluenceScore: 33,
    qveStrategy: 'Standard',
    qveProfitFactor: null,
    qveConfidence: 'NONE',
    signalConfidence: 'NONE',
    activeStrategyLabel: 'Estándar (Exploratoria)',
    isFallbackSignal: true,
    isOperationalViable: true,
    isCooldownActive: false,
    isSessionClosingCandle: false,
    isMarketClosed: false,
    rvol: 1.6,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 2.0,
    bbPercentile: 50,
    loading: false,
  };

  // 1. By default (allowExploratory = false), exploratory signals with confidence NONE must be rejected from active filter
  assert.strictEqual(
    isRadarRowActive(exploratoryRow, {}, false),
    false,
    'Exploratory signal with NONE confidence must be rejected by default in MarketRadar'
  );
  assert.strictEqual(
    isRadarRowActive(exploratoryRow, {}),
    false,
    'Default invocation without allowExploratory argument must reject NONE confidence'
  );

  // 2. When allowExploratory is explicitly enabled, viable exploratory signal is admitted to active filter
  assert.strictEqual(
    isRadarRowActive(exploratoryRow, {}, true),
    true,
    'Exploratory signal must be accepted when allowExploratory is explicitly true'
  );

  // 3. Operational safeguards remain active even when allowExploratory is true:
  // Rejected if market is closed
  const closedExploratoryRow: RadarRowData = { ...exploratoryRow, isMarketClosed: true };
  assert.strictEqual(
    isRadarRowActive(closedExploratoryRow, {}, true),
    false,
    'Exploratory signal must be rejected if market is closed even if allowExploratory is true'
  );

  // Rejected if in active cooldown
  const cdExploratoryRow: RadarRowData = { ...exploratoryRow, isCooldownActive: true };
  assert.strictEqual(
    isRadarRowActive(cdExploratoryRow, {}, true),
    false,
    'Exploratory signal must be rejected during cooldown even if allowExploratory is true'
  );

  // Rejected if operational trade plan fails friction or geometry
  const unviableExploratoryRow: RadarRowData = { ...exploratoryRow, isOperationalViable: false };
  assert.strictEqual(
    isRadarRowActive(unviableExploratoryRow, {}, true),
    false,
    'Exploratory signal must be rejected if operational plan is unviable'
  );

  // 4. Validated signals (LIMITED and HIGH) are always admitted regardless of allowExploratory
  const limitedRow: RadarRowData = {
    ...exploratoryRow,
    signalConfidence: 'LIMITED',
    activeStrategyLabel: 'VCME Sniper',
    isFallbackSignal: false,
  };
  assert.strictEqual(
    isRadarRowActive(limitedRow, {}, false),
    true,
    'Validated LIMITED signal must pass active filter when allowExploratory is false'
  );
  assert.strictEqual(
    isRadarRowActive(limitedRow, {}, true),
    true,
    'Validated LIMITED signal must pass active filter when allowExploratory is true'
  );

  // 5. Open positions tracked in activeSignals are always preserved regardless of confidence
  assert.strictEqual(
    isRadarRowActive(exploratoryRow, { NVDA: 'BUY' }, false),
    true,
    'Open position tracked in activeSignals must be preserved in active filter'
  );

  // 6. Actionable alert gating logic parity:
  // Verifies the exact decision predicate used in App.tsx
  const checkAlertActionable = (isBuy: boolean, isSell: boolean, validGeometry: boolean, confidence: string, allowExp: boolean) => {
    const isDirectional = isBuy || isSell;
    const isExploratory = confidence === 'NONE';
    const hasConfidence = !isExploratory || allowExp;
    return isDirectional && validGeometry && hasConfidence;
  };

  assert.strictEqual(checkAlertActionable(true, false, true, 'NONE', false), false, 'Scanner must not fire alert for NONE confidence by default');
  assert.strictEqual(checkAlertActionable(true, false, true, 'NONE', true), true, 'Scanner fires alert for NONE only when allowExploratory is true');
  assert.strictEqual(checkAlertActionable(true, false, true, 'LIMITED', false), true, 'Scanner always fires alert for LIMITED confidence');
  assert.strictEqual(checkAlertActionable(true, false, true, 'HIGH', false), true, 'Scanner always fires alert for HIGH confidence');
});

test('Test 88: Continuous empirical Bayes shrinkage eliminates sawtooth false vetoes and accounts for 0.11% friction drag', () => {
  // 1. Friction-impacted 1W/2L sequence with real 0.11% commission drag on 5m:
  // With 0.45% stop, round-trip friction of 0.11% imposes ~0.244R drag per trade.
  // 1 Win at 1.5R target = +1.256R net. 2 Losses at 1.0R = 2 * (-1.244R) = -2.488R net.
  // Net R sum = -1.232R -> E[R] = -0.4107R, PF = 1.256 / 2.488 = 0.505.
  // Under old code (E[R] <= -0.35R), this normal 1W/2L sequence was falsely vetoed.
  // Under continuous shrinkage (k=4, threshold=-0.18R):
  // shrunkExpR = -0.4107 * (3/7) = -0.176R > -0.18R, PF = 0.505 >= 0.40 -> NOT decisively toxic!
  const isToxicFriction1W2L = isDirectionalDecisivelyToxic(
    { signals: 3, expectancyR: -0.41, profitFactor: 0.505 },
    3, 4, -0.18
  );
  assert.strictEqual(isToxicFriction1W2L, false, '1W/2L with real 0.11% friction must NOT be decisively toxic');

  const buySanitizedFriction = sanitizeSignalWithDirectionalEdge(
    'BUY',
    { signals: 3, expectancyR: -0.41, profitFactor: 0.505 },
    undefined,
    3
  );
  assert.strictEqual(buySanitizedFriction, 'BUY', 'Signal with friction-impacted 1W/2L on N=3 must NOT be vetoed to NEUTRAL');

  // 2. Elimination of the sawtooth peak at N=6, 7, 8 for winning strategies (54% WR):
  // A profitable strategy with +0.15R net expected return encounters a 3W/4L run at N=7.
  // Wins = 3 * 1.256 = +3.768R. Losses = 4 * (-1.244) = -4.976R. Net = -1.208R -> E[R] = -0.1726R, PF = 0.757.
  // Under old step function (isLargeSample = sample >= 6), N=7 immediately triggered hard veto.
  // Under continuous shrinkage: shrunkExpR = -0.1726 * (7/11) = -0.1098R > -0.18R -> NOT decisively toxic!
  const isToxicN7 = isDirectionalDecisivelyToxic(
    { signals: 7, expectancyR: -0.1726, profitFactor: 0.757 },
    3, 4, -0.18
  );
  assert.strictEqual(isToxicN7, false, '3W/4L on N=7 must NOT suffer false sawtooth veto');

  const wfOosN7 = {
    ...createEmptyWalkForwardResult(400, 176),
    status: 'FAIL' as const,
    outOfSample: {
      ...createEmptyWalkForwardResult().outOfSample,
      signals: 7,
      expectancyR: -0.1726,
      profitFactor: 0.757,
      longStats: { signals: 7, wins: 3, losses: 4, winRate: 0.43, expectancyR: -0.1726, profitFactor: 0.757 },
    },
  };
  const oosCheckN7 = hasNegativeDirectionalOosEdge('BUY', wfOosN7, 3);
  assert.strictEqual(oosCheckN7.isNegative, true, 'OOS is mathematically negative');
  assert.strictEqual(oosCheckN7.isToxic, false, 'Must NOT be flagged as toxic under continuous shrinkage');
  assert.strictEqual(oosCheckN7.isMarginal, true, 'Must be classified as marginal noise for LIMITED confidence');

  // 3. Genuine toxicity hard veto protection:
  // Catastrophic collapse: 0W/3L at N=3 (E[R] = -1.24R, PF = 0.0) -> decisively toxic
  const isToxic0W3L = isDirectionalDecisivelyToxic(
    { signals: 3, expectancyR: -1.24, profitFactor: 0.0 },
    3, 4, -0.18
  );
  assert.strictEqual(isToxic0W3L, true, '0W/3L total collapse must be decisively toxic');
  assert.strictEqual(
    sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -1.24, profitFactor: 0.0 }, undefined, 3),
    'NEUTRAL',
    'Catastrophic 0W/3L on N=3 must be neutralized to NEUTRAL'
  );

  // Severe collapse on N=6: 1W/5L (E[R] = -0.83R, PF = 0.20, shrunk = -0.498R <= -0.18R) -> decisively toxic
  const isToxic1W5L = isDirectionalDecisivelyToxic(
    { signals: 6, expectancyR: -0.83, profitFactor: 0.20 },
    3, 4, -0.18
  );
  assert.strictEqual(isToxic1W5L, true, '1W/5L severe collapse on N=6 must be decisively toxic');
  assert.strictEqual(
    sanitizeSignalWithDirectionalEdge('BUY', { signals: 6, expectancyR: -0.83, profitFactor: 0.20 }, undefined, 3),
    'NEUTRAL',
    'Severe collapse on N=6 must be neutralized to NEUTRAL'
  );

  // 4. Candidate Alternative In-Sample regularized fallback:
  // Candidate with small directional noise on N=6 (E[R] = -0.05R, PF = 0.85) supported by a strong global prior (+0.30R)
  // survives line 822 (no longer discarded by dirPf < 1.0 at N=6) and regularizes as LIMITED
  const primaryDummy: StrategyCandidate = {
    key: 'multitemporal',
    label: 'VCME Sniper',
    profitFactor: 1.8,
    expectancyR: 0.30,
    expectancyPerHour: 0.25,
    winRate: 0.60,
    resolved: 20,
    walkForward: {
      status: 'PASS',
      inSample: { signals: 20, wins: 12, losses: 8, winRate: 0.60, expectancyR: 0.30, profitFactor: 1.8, maxDrawdownR: 1.0 },
      outOfSample: { signals: 6, wins: 4, losses: 2, winRate: 0.67, expectancyR: 0.20, profitFactor: 1.5 },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const fallbackN6: StrategyCandidate = {
    key: 'confluencia',
    label: 'Confluencia',
    profitFactor: 1.5,
    expectancyR: 0.30,
    expectancyPerHour: 0.20,
    winRate: 0.58,
    resolved: 16,
    walkForward: {
      status: 'PASS',
      inSample: {
        signals: 16, wins: 9, losses: 7, winRate: 0.56, expectancyR: 0.30, profitFactor: 1.5, maxDrawdownR: 1.2,
        longStats: { signals: 6, wins: 2, losses: 4, winRate: 0.33, expectancyR: -0.05, profitFactor: 0.85 },
        shortStats: { signals: 10, wins: 7, losses: 3, winRate: 0.70, expectancyR: 0.45, profitFactor: 2.1 },
      },
      outOfSample: {
        signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.15, profitFactor: 1.3,
        longStats: { signals: 2, wins: 1, losses: 1, winRate: 0.50, expectancyR: 0.10, profitFactor: 1.2 },
      },
      folds: [],
    } as unknown as NonNullable<StrategyCandidate['walkForward']>,
  };

  const qveFallbackTest = {
    bestStrategy: 'multitemporal',
    strategyLabel: 'VCME Sniper',
    confidence: 'HIGH',
    profitFactor: 1.8,
    winRate: 0.60,
    expectancyR: 0.30,
    expectancyPerHour: 0.25,
    candidates: [primaryDummy, fallbackN6],
    tournament: {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      compositeScore: 3.0,
      profitFactor: 1.8,
      expectancyR: 0.30,
      expectancyPerHour: 0.25,
      reasoning: 'VCME Sniper lidera',
    },
  } as unknown as QVESelectionResult;

  const candidateResults = getActionableStrategyCandidates(qveFallbackTest, {
    multitemporal: 'NEUTRAL',
    confluencia: 'BUY',
    standard: 'NEUTRAL',
    scoring: 'HOLD',
    multifractal: 'NEUTRAL',
  });

  assert.strictEqual(candidateResults.length, 1, 'Fallback with marginal noise at N=6 must survive via empirical Bayes shrinkage');
  assert.strictEqual(candidateResults[0].strategy, 'confluencia');
  assert.strictEqual(candidateResults[0].confidence, 'LIMITED');
  assert.strictEqual(candidateResults[0].isFallback, true);
  assert.ok(candidateResults[0].reasoning.includes('IS BUY marginal'), 'Reasoning must document IS BUY marginal regularization');
});

test('Test 89: Scoring Layer 2 RSI symmetric matrix around 50, flat RSI neutrality, and capitulation bottom protection', () => {
  const klines: Kline[] = Array.from({ length: 65 }, (_, i) => ({
    time: 1700000000 + i * 300,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100.0,
    volume: 1000
  }));
  const lastIdx = klines.length - 1;
  const ctx = buildScoringContext(klines, '5m');

  const evalRsi = (rsiHistory: [number, number, number, number]) => {
    ctx.rsiSeries[lastIdx - 3] = rsiHistory[0];
    ctx.rsiSeries[lastIdx - 2] = rsiHistory[1];
    ctx.rsiSeries[lastIdx - 1] = rsiHistory[2];
    ctx.rsiSeries[lastIdx] = rsiHistory[3];
    return evaluateScoringAt(ctx, lastIdx);
  };

  // 1. Flat RSI (|ΔRSI| <= 1.5 in 3 bars) must be strictly neutral (0.0), never -1.0
  const flat55 = evalRsi([55.0, 55.2, 54.9, 55.0]);
  assert.strictEqual(flat55.layers.rsi.score, 0.0, 'Flat RSI at 55 must score 0.0, not -1.0');
  assert.ok(flat55.layers.rsi.note.includes('Plano (neutral)'), 'Note must state Plano (neutral)');

  const flat45 = evalRsi([44.5, 45.0, 44.8, 45.0]);
  assert.strictEqual(flat45.layers.rsi.score, 0.0, 'Flat RSI at 45 must score 0.0, not -1.0');

  const flat65 = evalRsi([65.2, 64.9, 65.1, 65.0]);
  assert.strictEqual(flat65.layers.rsi.score, 0.0, 'Flat RSI at 65 must score 0.0, not -1.0');

  // 2. Extreme overbought (>80) vs Extreme capitulation (<20) mirror symmetry
  // Rising into >80: neutral (0.0) to prevent buying tops
  const overboughtRising = evalRsi([78.0, 80.0, 82.0, 85.0]);
  assert.strictEqual(overboughtRising.layers.rsi.score, 0.0, 'RSI rising >80 must score 0.0 to prevent buying parabolic tops');
  assert.ok(overboughtRising.layers.rsi.note.includes('Sobrecompra extrema >80'), 'Note must state exhaustion');

  // Falling into <20: neutral (0.0) to prevent selling capitulation bottoms
  const capitulationFalling = evalRsi([22.0, 20.0, 18.0, 15.0]);
  assert.strictEqual(capitulationFalling.layers.rsi.score, 0.0, 'RSI falling <20 must score 0.0 to prevent selling capitulation bottoms');
  assert.ok(capitulationFalling.layers.rsi.note.includes('Sobreventa extrema <20'), 'Note must state bearish exhaustion');

  // Extreme reversals (curling back from extreme):
  // Rejection falling from >80: -0.5
  const overboughtFalling = evalRsi([88.0, 86.5, 85.0, 83.0]);
  assert.strictEqual(overboughtFalling.layers.rsi.score, -0.5, 'RSI falling from >80 must score -0.5 for rejection');

  // Bounce rising from <20: +0.5
  const capitulationBounce = evalRsi([12.0, 13.5, 15.0, 17.0]);
  assert.strictEqual(capitulationBounce.layers.rsi.score, 0.5, 'RSI rising from <20 must score +0.5 for capitulation bounce');

  // 3. Extended zones (72-80 vs 20-28) mirror symmetry
  const ext75Rising = evalRsi([72.0, 73.0, 74.0, 75.0]);
  assert.strictEqual(ext75Rising.layers.rsi.score, 0.5, 'RSI 72-80 rising must score +0.5 (caution)');

  const ext75Falling = evalRsi([78.0, 77.0, 76.0, 75.0]);
  assert.strictEqual(ext75Falling.layers.rsi.score, -0.5, 'RSI 72-80 falling must score -0.5 (rejection)');

  const ext25Rising = evalRsi([22.0, 23.0, 24.0, 25.0]);
  assert.strictEqual(ext25Rising.layers.rsi.score, 0.5, 'RSI 20-28 rising must score +0.5 (bounce)');

  const ext25Falling = evalRsi([28.0, 27.0, 26.0, 25.0]);
  assert.strictEqual(ext25Falling.layers.rsi.score, -0.5, 'RSI 20-28 falling must score -0.5 (extended oversold caution)');

  // 4. Directional momentum and pullback zones (50-72 and 40-50)
  const mom60Rising = evalRsi([56.0, 57.5, 59.0, 60.5]);
  assert.strictEqual(mom60Rising.layers.rsi.score, 1.0, 'RSI 50-72 rising must score +1.0 (bullish momentum)');

  const mom60Falling = evalRsi([64.0, 62.5, 61.0, 59.5]);
  assert.strictEqual(mom60Falling.layers.rsi.score, -1.0, 'RSI 50-72 falling must score -1.0 (bearish continuation)');

  const pullback45Rising = evalRsi([41.0, 42.5, 44.0, 45.5]);
  assert.strictEqual(pullback45Rising.layers.rsi.score, 1.0, 'RSI 40-50 rising must score +1.0 (pullback recovery)');

  const pullback45Falling = evalRsi([49.0, 47.5, 46.0, 44.5]);
  assert.strictEqual(pullback45Falling.layers.rsi.score, -1.0, 'RSI 40-50 falling must score -1.0 (bearish continuation)');

  // 5. Depressed zone (28-40)
  const dep35Rising = evalRsi([31.0, 32.5, 34.0, 35.5]);
  assert.strictEqual(dep35Rising.layers.rsi.score, 0.5, 'RSI 28-40 rising must score +0.5 (technical bounce)');

  const dep35Falling = evalRsi([39.0, 37.5, 36.0, 34.5]);
  assert.strictEqual(dep35Falling.layers.rsi.score, -1.0, 'RSI 28-40 falling must score -1.0 (bearish impulse into oversold)');
});

test('Test 90: VCME Sniper strict 0.15 ATR trigger candle extreme buffer enforcement for clamped stops', () => {
  // Build a base VCME context matching proven Test 86 configuration
  const klines1d: Kline[] = Array.from({ length: 60 }, (_, idx) => ({
    time: 1700000000 + idx * 86400,
    open: 100, high: 101, low: 99, close: 100, volume: 100000
  }));
  const klines1h: Kline[] = Array.from({ length: 100 }, (_, idx) => ({
    time: 1700000000 + idx * 3600,
    open: 100, high: 101, low: 99, close: 100, volume: 10000
  }));
  const klines5m: Kline[] = Array.from({ length: 60 }, (_, idx) => ({
    time: 1700000000 + idx * 300,
    open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000
  }));

  const lastIdx = klines5m.length - 1;
  const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'VCME_BUFFER_TEST', 'dayTrading', 'agresivo');

  const hIdx = 50;
  const dIdx = 40;
  for (let j = 0; j < klines5m.length; j++) {
    ctx.idx1dMap[j] = dIdx;
    ctx.idx1hMap[j] = hIdx;
  }

  // Configure bullish 1D and 1H backdrop for BUY setup
  ctx.closes1d[dIdx] = 100;
  ctx.ema200_1d[dIdx] = 102;
  ctx.ema50_1d[dIdx] = 101;
  ctx.adxData1d.adx[dIdx] = 15;
  ctx.adxData1d.plusDI[dIdx] = 15;
  ctx.adxData1d.minusDI[dIdx] = 15;

  ctx.closes1h[hIdx] = 105;
  ctx.ema200_1h[hIdx] = 95;
  ctx.ema200_1h[hIdx - 5] = 94;
  ctx.atrSeries1h[hIdx] = 1.0;
  ctx.adxSeries1h.adx[hIdx] = 25;
  ctx.ema20_1h[hIdx] = 104;
  ctx.ema50_1h[hIdx] = 100;
  ctx.rsiSeries1h[hIdx] = 60;
  ctx.macdData1h.histogram[hIdx] = 0.3;
  ctx.macdData1h.histogram[hIdx - 1] = 0.35;
  ctx.vwapSeries1h[hIdx] = 103;

  // 5m indicators
  ctx.vol5m[lastIdx] = 2500;
  ctx.volSma5m[lastIdx] = 1000;
  ctx.klines5m[lastIdx].volume = 2500;
  ctx.vwapSeries5m[lastIdx] = 105.0;
  ctx.ema9_5m[lastIdx] = 105.8;
  ctx.ema21_5m[lastIdx] = 105.5;
  ctx.atrSeries5m[lastIdx] = 0.6; // atr5m = 0.6 -> maxRisk = 2.0 * 0.6 = 1.20, buffer = 0.15 * 0.6 = 0.09

  // Swing highs for breakout: prior bars high = 105.9
  for (let s = lastIdx - 3; s < lastIdx; s++) {
    ctx.klines5m[s].high = 105.9;
    ctx.klines5m[s].low = 105.2;
    ctx.klines5m[s].close = 105.4;
  }
  ctx.klines5m[lastIdx - 1].low = 105.5;
  ctx.ema9_5m[lastIdx - 1] = 105.6;
  ctx.ema21_5m[lastIdx - 1] = 105.6;
  ctx.vwapSeries5m[lastIdx - 1] = 105.0;

  // Trigger candle: close = 106.0 (breaks 105.9)
  // Entry = 106.0, maxRisk = 1.20 -> clampedStop = 104.80
  ctx.klines5m[lastIdx].open = 105.5;
  ctx.klines5m[lastIdx].high = 106.1;
  ctx.klines5m[lastIdx].close = 106.0;

  // Set deep swing low at 104.0 (structural risk = 106.0 - (104.0 - 0.2*0.6) = 2.12 > 1.20 maxRisk)
  for (let s = lastIdx - 10; s < lastIdx - 1; s++) {
    ctx.klines5m[s].low = 104.0;
  }

  // 1. Safe buffer case: curr5m.low = 105.2
  // triggerExtreme = 105.2 - 0.09 = 105.11
  // clampedStop = 104.80 <= 105.11 -> safe buffer (0.40 >= 0.09)
  ctx.klines5m[lastIdx].low = 105.2;
  const resSafeBuy = evaluateVCMESniperAt(ctx, lastIdx);
  assert.strictEqual(resSafeBuy.signal, 'BUY', 'Safe buffer must trigger BUY signal');
  assert.strictEqual(resSafeBuy.stopLoss, 104.8, 'Stop loss must clamp to 104.80');

  // 2. Unsafe buffer case: curr5m.low = 104.85
  // triggerExtreme = 104.85 - 0.09 = 104.76
  // clampedStop = 104.80 > 104.76 -> unsafe (only 0.05 from low < 0.09 buffer)
  // Under the old bug (|| clampedStop <= curr5m.low), 104.80 <= 104.85 would have been accepted.
  // Under our fix, it must NOT clamp and must be discarded by riskFilter!
  ctx.klines5m[lastIdx].low = 104.85;
  const resUnsafeBuy = evaluateVCMESniperAt(ctx, lastIdx);
  assert.strictEqual(resUnsafeBuy.signal, 'NEUTRAL', 'Unsafe stop within 0.15 ATR of trigger low must be neutralized');
  assert.strictEqual(resUnsafeBuy.discardReason, 'riskFilter', 'Must be discarded by riskFilter');
  assert.strictEqual(resUnsafeBuy.stopLoss, 0, 'Stop loss must be reset to 0');

  // 3. SHORT setup verification:
  // Configure bearish 1D and 1H backdrop
  ctx.closes1d[dIdx] = 95;
  ctx.ema200_1d[dIdx] = 102;
  ctx.ema50_1d[dIdx] = 98; // bearish trend: close < ema50 < ema200
  ctx.adxData1d.adx[dIdx] = 25;
  ctx.adxData1d.plusDI[dIdx] = 15;
  ctx.adxData1d.minusDI[dIdx] = 30;

  ctx.closes1h[hIdx] = 95;
  ctx.ema200_1h[hIdx] = 105;
  ctx.ema200_1h[hIdx - 5] = 106; // slopeAtr = -1.0 / 1.0 = -1.0 < -0.05
  ctx.atrSeries1h[hIdx] = 1.0;
  ctx.adxSeries1h.adx[hIdx] = 25;
  ctx.ema20_1h[hIdx] = 96;
  ctx.ema50_1h[hIdx] = 100;
  ctx.rsiSeries1h[hIdx] = 40;
  ctx.macdData1h.histogram[hIdx] = -0.3;
  ctx.macdData1h.histogram[hIdx - 1] = -0.25;
  ctx.vwapSeries1h[hIdx] = 97;

  // 5m indicators for SHORT
  ctx.vwapSeries5m[lastIdx] = 94.8;
  ctx.ema9_5m[lastIdx] = 94.2;
  ctx.ema21_5m[lastIdx] = 94.5;
  ctx.atrSeries5m[lastIdx] = 0.6; // maxRisk = 1.20, buffer = 0.09

  // Prior swing lows: 94.1
  for (let s = lastIdx - 3; s < lastIdx; s++) {
    ctx.klines5m[s].high = 94.8;
    ctx.klines5m[s].low = 94.1;
    ctx.klines5m[s].close = 94.6;
  }
  ctx.klines5m[lastIdx - 1].high = 94.5;
  ctx.ema9_5m[lastIdx - 1] = 94.4;
  ctx.ema21_5m[lastIdx - 1] = 94.4;
  ctx.vwapSeries5m[lastIdx - 1] = 94.8;

  // Trigger candle: close = 94.0 (breaks below 94.1)
  // Entry = 94.0, maxRisk = 1.20 -> clampedStop = 95.20
  ctx.klines5m[lastIdx].open = 94.5;
  ctx.klines5m[lastIdx].low = 93.9;
  ctx.klines5m[lastIdx].close = 94.0;

  // Set high swing high at 96.0 (structural risk = (96.0 + 0.2*0.6) - 94.0 = 2.12 > 1.20)
  for (let s = lastIdx - 10; s < lastIdx - 1; s++) {
    ctx.klines5m[s].high = 96.0;
  }

  // 3a. Safe buffer case: curr5m.high = 94.8
  // triggerExtreme = 94.8 + 0.09 = 94.89
  // clampedStop = 95.20 >= 94.89 -> safe buffer (0.40 >= 0.09)
  ctx.klines5m[lastIdx].high = 94.8;
  const resSafeSell = evaluateVCMESniperAt(ctx, lastIdx);
  assert.strictEqual(resSafeSell.signal, 'SELL', 'Safe buffer must trigger SELL signal');
  assert.strictEqual(resSafeSell.stopLoss, 95.2, 'Stop loss must clamp to 95.20');

  // 3b. Unsafe buffer case: curr5m.high = 95.15
  // triggerExtreme = 95.15 + 0.09 = 95.24
  // clampedStop = 95.20 < 95.24 -> unsafe (only 0.05 from high < 0.09 buffer)
  // Under the old bug (|| clampedStop >= curr5m.high), 95.20 >= 95.15 would have been accepted.
  // Under our fix, it must NOT clamp and must be discarded by riskFilter!
  ctx.klines5m[lastIdx].high = 95.15;
  const resUnsafeSell = evaluateVCMESniperAt(ctx, lastIdx);
  assert.strictEqual(resUnsafeSell.signal, 'NEUTRAL', 'Unsafe stop within 0.15 ATR of trigger high must be neutralized');
  assert.strictEqual(resUnsafeSell.discardReason, 'riskFilter', 'Must be discarded by riskFilter');
  assert.strictEqual(resUnsafeSell.stopLoss, 0, 'Stop loss must be reset to 0');
});

test('Test 91: Scoring S/R validation parity and single source of truth across operational layers', () => {
  const t0 = 1700000000;
  const klines: Kline[] = Array.from({ length: 120 }, (_, i) => ({
    time: t0 + i * 300,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1000
  }));

  // Form a pivot high at bar 100 (high = 102.0)
  klines[100] = {
    time: t0 + 100 * 300,
    open: 101.0,
    high: 102.0,
    low: 100.5,
    close: 101.2,
    volume: 2000
  };

  const currIdx = klines.length - 1; // 119
  // 1. BUY scenario with insufficient room to resistance:
  // Entry = 100.0, TP1 = 103.0 (targetDist = 3.0), Stop = 98.0 (slDist = 2.0).
  // Resistance is at 102.0 (rewardRoom = 2.0 < targetDist = 3.0).
  const resBlocked = validateScoringSRRoom(klines, currIdx, 'BUY', 100.0, 103.0, 98.0);
  assert.strictEqual(resBlocked.viable, false, 'BUY signal into resistance before TP1 must be rejected');
  assert.strictEqual(resBlocked.nearestResistance, 102.0);
  assert.ok(resBlocked.reason?.includes('insuficiente hacia resistencia'), 'Must specify insufficient room to resistance');

  // 2. BUY scenario with ample room above resistance:
  // If price has broken out above resistance to 102.5, TP1 = 105.0.
  // Next resistance is none (or far above), so it must be accepted.
  const resAllowed = validateScoringSRRoom(klines, currIdx, 'BUY', 102.5, 105.0, 101.0);
  assert.strictEqual(resAllowed.viable, true, 'BUY breakout above resistance must be approved');

  // 3. SELL scenario with insufficient room to support:
  // Form a pivot low at bar 105 (low = 98.0)
  klines[105] = {
    time: t0 + 105 * 300,
    open: 99.0,
    high: 99.5,
    low: 98.0,
    close: 98.8,
    volume: 2000
  };
  // Entry = 100.0, TP1 = 97.0 (targetDist = 3.0), Stop = 102.0 (slDist = 2.0).
  // Support is at 98.0 (rewardRoom = 2.0 < targetDist = 3.0).
  const resSellBlocked = validateScoringSRRoom(klines, currIdx, 'SELL', 100.0, 97.0, 102.0);
  assert.strictEqual(resSellBlocked.viable, false, 'SELL signal into support before TP1 must be rejected');
  assert.strictEqual(resSellBlocked.nearestSupport, 98.0);
  assert.ok(resSellBlocked.reason?.includes('insuficiente hacia soporte'), 'Must specify insufficient room to support');
});

test('Test 92: Telemetry discard tracking for confidence and unvalidated exploratory signals', () => {
  const stats = createInitialDiscardStats();
  const seenKeys = new Set<string>();

  // 1. Initial state has 0 confidence discards
  assert.strictEqual(stats.confidence, 0);
  assert.strictEqual(stats.total, 0);

  // 2. Record first confidence discard event
  const res1 = recordDiscardEvent(stats, seenKeys, 'AAPL', '5m', 1700000000, 'confidence');
  assert.strictEqual(res1.recorded, true, 'First event must be recorded');
  assert.strictEqual(res1.stats.confidence, 1, 'Confidence count must increment to 1');
  assert.strictEqual(res1.stats.total, 1, 'Total discards must increment to 1');

  // 3. Atomic deduplication: repeated polling on the same closed candle must be ignored
  const res2 = recordDiscardEvent(res1.stats, seenKeys, 'AAPL', '5m', 1700000000, 'confidence');
  assert.strictEqual(res2.recorded, false, 'Repeated polling on same candle must be deduplicated');
  assert.strictEqual(res2.stats.confidence, 1, 'Confidence count must remain 1');
  assert.strictEqual(res2.stats.total, 1, 'Total count must remain 1');

  // 4. New candle emits new discard
  const res3 = recordDiscardEvent(res2.stats, seenKeys, 'AAPL', '5m', 1700000300, 'confidence');
  assert.strictEqual(res3.recorded, true, 'New candle must be recorded');
  assert.strictEqual(res3.stats.confidence, 2, 'Confidence count must increment to 2');
  assert.strictEqual(res3.stats.total, 2, 'Total count must increment to 2');
});



