// MFLS audit, revision 2. Synthetic cases verify fixes and document remaining defects.
// Run: npx tsx scripts/audit-mfls.ts. PENDING assertions describe current defects.
import assert from 'node:assert/strict';
import { calculateFractalPivotsSeries, isMFLSSessionWindow } from '../src/utils/indicators';
import { buildMFLSContext, evaluateMFLSAt } from '../src/utils/strategyEvaluators';
import { simulateTrade, type ExitPolicy, type TradeLevels, type TradeDirection } from '../src/utils/tradeSimulator';
import { updateAlertsOutcome, type AuditAlertItem } from '../src/utils/alertTracker';
import { resolveOperationalTrade } from '../src/utils/operationalTrade';
import { isTradeFrictionViable } from '../src/utils/tradeLevels';
import { stampKlineSnapshot } from '../src/services/marketDataSnapshot';
import type { Kline } from '../src/services/api';

const base = Date.UTC(2026, 6, 15, 14) / 1000;
const bars = (n: number): Kline[] => Array.from({ length: n }, (_, i) => ({
  time: base + i * 300, open: 100, high: 100.3, low: 99.7, close: 100, volume: 5000,
}));
function setup(direction: TradeDirection = 'BUY') {
  const ks = bars(60);
  ks[55] = { ...ks[55], high: 100.6, low: 99.7 };
  ks[59] = { ...ks[59], open: 100.1, high: 100.2, low: 99.3, close: 100 };
  const ctx = buildMFLSContext(ks, true);
  // Indicator injection isolates entry conditions, not their historical frequency.
  ctx.atrSeries[59] = 0.5;
  ctx.pivots.swingLows[59] = 99.5;
  ctx.pivots.swingLowIndices[59] = 45;
  ctx.pivots.swingHighs[59] = null;
  ctx.pivots.swingHighIndices[59] = null;
  ctx.macdData.macd[45] = -1;
  ctx.macdData.macd[58] = -0.7;
  ctx.macdData.macd[59] = -0.6;
  ctx.macdData.histogram[45] = -0.3;
  ctx.macdData.histogram[58] = -0.2;
  ctx.macdData.histogram[59] = -0.1;
  ctx.rsiSeries[45] = 30;
  ctx.rsiSeries[59] = 40;
  if (direction === 'SELL') {
    ctx.klines5m = ks.map(k => ({ ...k, open: 200 - k.open, close: 200 - k.close,
      high: 200 - k.low, low: 200 - k.high }));
    ctx.pivots.swingHighs[59] = 100.5;
    ctx.pivots.swingHighIndices[59] = 45;
    ctx.pivots.swingLows[59] = null;
    ctx.pivots.swingLowIndices[59] = null;
    ctx.macdData.macd = ctx.macdData.macd.map(v => -v);
    ctx.macdData.histogram = ctx.macdData.histogram.map(v => -v);
    ctx.rsiSeries = ctx.rsiSeries.map(v => 100 - v);
  }
  return ctx;
}
for (const direction of ['BUY', 'SELL'] as const) {
  const sign = direction === 'BUY' ? 1 : -1;
  const ctx = setup(direction);
  assert.equal(evaluateMFLSAt(ctx, 59, 100).signal, direction);
  assert.equal(evaluateMFLSAt(ctx, 59, 100 - sign * 0.8).signal, 'NEUTRAL');
  assert.equal(evaluateMFLSAt(ctx, 59, 100 + sign * 5).signal, 'NEUTRAL');
  const noMacd = setup(direction);
  noMacd.macdData.macd[59] = noMacd.macdData.macd[58] - sign;
  noMacd.macdData.histogram[59] = noMacd.macdData.histogram[58] - sign;
  assert.equal(evaluateMFLSAt(noMacd, 59, 100).signal, 'NEUTRAL');
  const noImbalance = setup(direction);
  noImbalance.klines5m[55] = { ...noImbalance.klines5m[55],
    open: 100 - sign * 0.25, close: 100 - sign * 0.25,
    high: direction === 'BUY' ? 99.8 : 100.4, low: direction === 'BUY' ? 99.6 : 100.2 };
  const missing = evaluateMFLSAt(noImbalance, 59, 100);
  assert.equal(missing.hasImbalance, false);
  assert.equal(missing.signal, 'NEUTRAL');
  const noRsi = setup(direction);
  noRsi.rsiSeries[59] = noRsi.rsiSeries[45];
  const optional = evaluateMFLSAt(noRsi, 59, 100);
  assert.equal(optional.signal, direction);
  assert.ok(!optional.reasoning.includes('divergencia RSI'));
}
console.log('FIXED: BUY/SELL invalidation, chasing, required MACD/imbalance and accurate optional RSI explanation.');

for (const [utc, expected] of [
  ['2026-07-15T13:35:00Z', false], ['2026-07-15T13:45:00Z', true],
  ['2026-07-15T19:30:00Z', false], ['2026-07-15T19:40:00Z', false],
  ['2026-01-15T14:45:00Z', true], ['2026-07-18T14:00:00Z', false],
  ['2026-11-27T17:25:00Z', true], ['2026-11-27T17:30:00Z', false],
] as const) assert.equal(isMFLSSessionWindow(Date.parse(utc)), expected, utc);
console.log('FIXED: session helper boundaries, winter/summer, weekend and early close.');

const boundary = setup();
boundary.isCrypto = false;
boundary.klines5m[59].time = Date.parse('2026-07-15T19:25:00Z') / 1000;
assert.equal(evaluateMFLSAt(boundary, 59, 100).signal, 'NEUTRAL');
assert.equal(evaluateMFLSAt(boundary, 59, 100).discardReason, 'sessionGap');
assert.equal(isMFLSSessionWindow((boundary.klines5m[59].time + 300) * 1000), false);
console.log('FIXED: 15:25 signal candle execution at 15:30 is properly rejected by MFLS session window.');

const floor = setup();
floor.atrSeries[59] = 0.3;
floor.klines5m[59] = { ...floor.klines5m[59], low: 99.85 };
floor.pivots.swingLows[59] = 99.9;
floor.klines5m[55].high = 100.5;
const floorResult = evaluateMFLSAt(floor, 59, 100);
assert.equal(floorResult.signal, 'BUY');
assert.ok(Math.abs(floorResult.stopLoss - 99.60) < 1e-9);
const plan = resolveOperationalTrade({
  strategy: 'mfls', signal: 'BUY', executionStyle: 'dayTrading',
  raw: { '5m': floor.klines5m }, closed: { '5m': floor.klines5m },
  mfls: floorResult, isCrypto: true,
});
assert.equal(plan.valid, true);
assert.equal(isTradeFrictionViable(100, floorResult.stopLoss, 0.11), true);
console.log('FIXED: 0.40% stop accepted by operational plan and passes backtest cost filter (0.14 / 0.40 = 0.35R <= 0.35R).');

// Mirrors the CURRENT policy inspected at backtestMFLS's simulateTrade call.
// It is deliberately explicit: production still duplicates the policy in the tracker.
const policy: ExitPolicy = { forwardWindow: 24, enablePartials: 'two-tier',
  earlyAdverseCutoffBars: 3, earlyAdverseCutoffR: 0.5,
  timeStopBars: 16, timeStopMinR: 0.4, frictionPct: 0.11,
  frictionModel: 'proportional', sessionGapCutoff: false, stepSec: 300 };
function compare(path: Kline[], direction: TradeDirection, expectedReason: string | undefined, partialReload = false) {
  const sign = direction === 'BUY' ? 1 : -1;
  const ks = sign === 1 ? path : path.map(k => ({ ...k, open: 200 - k.open,
    close: 200 - k.close, high: 200 - k.low, low: 200 - k.high }));
  const levels: TradeLevels = { entryPrice: 100, stopLoss: 100 - sign,
    takeProfit1: 100 + 1.75 * sign, takeProfit2: 100 + 3 * sign };
  const historical = simulateTrade(ks, 0, direction, levels, { ...policy, floatingClosePrice: ks.at(-1)!.close });
  let alert: AuditAlertItem = { id: 'audit', symbol: 'BTCUSDT', interval: '5m',
    signal: direction, time: '', pf: null, strategy: 'MFLS (Reversión)',
    ...levels, status: 'OPEN', realizedR: 0, pnlPercent: 0,
    timestamp: (base + 300) * 1000 - 1, candleTimestamp: base };
  if (partialReload) {
    const prefix = ks.slice(0, 2);
    stampKlineSnapshot(prefix, (prefix.at(-1)!.time + 300) * 1000);
    alert = updateAlertsOutcome([alert], { 'BTCUSDT:5m': prefix })[0];
    assert.equal(alert.status, 'TP1_HIT');
    alert = JSON.parse(JSON.stringify(alert));
  }
  stampKlineSnapshot(ks, (ks.at(-1)!.time + 300) * 1000);
  const live = updateAlertsOutcome([alert], { 'BTCUSDT:5m': ks })[0];
  assert.equal(historical.executionState?.exit?.reason, expectedReason);
  assert.equal(live.executionState?.exit?.reason, expectedReason);
  assert.equal(live.status, historical.status);
  assert.equal(live.realizedR, historical.realizedR);
  assert.ok(!live.executionState?.fills.some(fill => fill.kind === 'TP3'));
  return historical.realizedR;
}
for (const direction of ['BUY', 'SELL'] as const) {
  const target = bars(3);
  target[1] = { ...target[1], high: 102, low: 99.9, close: 101.8 };
  target[2] = { ...target[2], open: 101.8, high: 102, low: 99.8, close: 100 };
  const be = compare(target, direction, 'TP1_BE', true);
  const second = target.map(k => ({ ...k }));
  second[2] = { ...second[2], open: 101.8, high: 105.1, low: 101.7, close: 105 };
  const tp2 = compare(second, direction, 'TP2', true);
  const adverse = bars(3);
  adverse[1] = { ...adverse[1], high: 100.1, low: 99.3, close: 99.4 };
  compare(adverse, direction, 'EARLY_ADVERSE');
  compare(bars(17), direction, 'TIME_STOP');
  const aboveThreshold = bars(17).map((k, i) => i === 0 ? k :
    { ...k, open: 100.45, high: 100.6, low: 100.3, close: 100.45 });
  compare(aboveThreshold, direction, undefined);
  console.log('FIXED: execution parity including JSON resume', { direction, breakevenR: be, tp2R: tp2 });
}

const monotonic = bars(30).map((k, i) => ({ ...k, open: 100 - i, close: 100 - i,
  high: 100.3 - i, low: 99.7 - i }));
assert.equal(calculateFractalPivotsSeries(monotonic).swingLowIndices[29], null);
console.log('FIXED: a strictly falling series returns null instead of a non-fractal fallback pivot.');

const lowVol = setup();
lowVol.atrSeries[59] = 0.2;
lowVol.klines5m[59].close = 99.65;
const lowVolRes = evaluateMFLSAt(lowVol, 59, 99.65);
assert.equal(lowVolRes.discardReason, 'riskFilter');
assert.ok(lowVolRes.reasoning.includes('Barrido estructural demasiado profundo') || lowVolRes.reasoning.includes('2.5x ATR'));
console.log('FIXED: deep sweep telemetry clearly reports structural sweep too deep (stop > 2.5x ATR).');

const causalBars = bars(100).map((k, i) => {
  const price = 100 + Math.sin(i / 3);
  return { ...k, open: price, close: price, high: price + 0.3, low: price - 0.3 };
});
const fullContext = buildMFLSContext(causalBars, true);
for (let i = 30; i < causalBars.length; i++) {
  assert.deepEqual(evaluateMFLSAt(fullContext, i),
    evaluateMFLSAt(buildMFLSContext(causalBars.slice(0, i + 1), true), i));
}
console.log('PASS: 70 causal prefixes agree. No production files changed.');
