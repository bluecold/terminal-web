import assert from 'node:assert/strict';
import test from 'node:test';
import type { Kline } from '../../services/api';
import { getKlineCacheBoundaryMs } from '../../services/api';
import { buildConfluenciaContext, evaluateConfluenciaAt } from '../strategyEvaluators';
import {
  evaluateStrategyTournament,
  getActionableStrategyCandidates,
  getInformationalStrategyCandidates,
  isInformationalStrategy,
  runQVESelection,
  type QVESelectionResult,
  type StrategyCandidate,
} from '../tournament';
import { getMsUntilNextAlignedScan } from '../scanSchedule';
import {
  buildAlertPerformanceReport,
  computeAlertLatencySec,
  computeExecutionCostR,
  mergeIntoAlertArchive,
  toArchivedAlert,
  type ArchivedAlert,
} from '../alertReport';
import type { AuditAlertItem } from '../alertTracker';
import { acquireScannerLeadership } from '../scannerLeadership';

// Zig-zag uptrend: four +0.12 candles and one -0.08 candle per cycle, constant volume.
function zigzag(startSec: number, n: number, p0: number): Kline[] {
  const out: Kline[] = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    const up = i % 5 !== 3;
    const open = p;
    const close = up ? p + 0.12 : p - 0.08;
    out.push({ time: startSec + i * 300, open, high: Math.max(open, close) + 0.02, low: Math.min(open, close) - 0.02, close, volume: 10_000 });
    p = close;
  }
  return out;
}

// 2026-09-28 14:00–16:00 ET, then 2026-09-29 from the 09:30 ET open
// Base price 15 keeps ATR(14) around 0.7–0.9% of the price, above the 0.5% volatility guard
const prevSession = zigzag(Date.UTC(2026, 8, 28, 18, 0) / 1000, 24, 15);
const session = zigzag(Date.UTC(2026, 8, 29, 13, 30) / 1000, 66, prevSession[prevSession.length - 1].close);
const klines = [...prevSession, ...session];
const MORNING_IDX = 26;   // 09:40 ET candle
const AFTERNOON_IDX = 85; // 14:35 ET candle (former ADX >= 25 afternoon window)

test('Confluencia 5m equities: signals only in the 09:35–11:00 ET opening window', () => {
  const ctx = buildConfluenciaContext(klines, '5m', 'MSFT');
  assert.equal(evaluateConfluenciaAt(ctx, MORNING_IDX).signal, 'BUY');

  // Neutralize VWAP gating so the only remaining difference is the session window; ADX is strong (trend)
  ctx.vwapReliable![AFTERNOON_IDX] = false;
  assert.ok((ctx.adx?.adx?.[AFTERNOON_IDX] ?? 0) >= 25);
  assert.equal(evaluateConfluenciaAt(ctx, AFTERNOON_IDX).signal, 'NEUTRAL');

  // Crypto has no session guard: the same candle still emits
  const cryptoCtx = buildConfluenciaContext(klines, '5m', 'BTCUSDT');
  cryptoCtx.vwapReliable![AFTERNOON_IDX] = false;
  assert.equal(evaluateConfluenciaAt(cryptoCtx, AFTERNOON_IDX).signal, 'BUY');
});

const candidate = (key: StrategyCandidate['key'], expectancyR: number, profitFactor: number): StrategyCandidate => ({
  key, label: key, profitFactor, expectancyR, winRate: 0.55, resolved: 40, maxDrawdownR: 1.5,
});

test('Tournament: informational engines never win on 5m equities, but still compete on crypto', () => {
  const candidates = [candidate('standard', 0.5, 2.0), candidate('multitemporal', 0.45, 1.9), candidate('confluencia', 0.1, 1.3)];
  assert.equal(evaluateStrategyTournament(candidates, '5m', undefined, false).bestStrategy, 'confluencia');
  assert.equal(evaluateStrategyTournament(candidates, '5m', undefined, true).bestStrategy, 'standard');
  assert.equal(evaluateStrategyTournament(candidates.slice(0, 2), '5m', undefined, false).bestStrategy, 'NONE');
  assert.equal(evaluateStrategyTournament(candidates, '1h', undefined, false).bestStrategy, 'standard');

  assert.equal(isInformationalStrategy('scoring', '5m', false), true);
  assert.equal(isInformationalStrategy('confluencia', '5m', false), false);
  assert.equal(isInformationalStrategy('scoring', '5m', true), false);
  assert.equal(isInformationalStrategy('scoring', '1h', false), false);
});

function equityQve(confluenciaLong: { signals: number; expectancyR: number; profitFactor: number | null }): QVESelectionResult {
  const base = runQVESelection({ symbol: 'MSFT', data5m: klines, data1h: [], data1d: [] });
  const conf: StrategyCandidate = {
    ...candidate('confluencia', -0.02, 0.95),
    longStats: { ...confluenciaLong, wins: 0, losses: 0, winRate: 0 },
  };
  return { ...base, bestStrategy: 'NONE', confidence: 'NONE', candidates: [conf, candidate('scoring', -0.2, 0.7), candidate('mfls', -0.3, 0.6)] };
}

test('5m equities: Confluencia alerts without per-symbol veto unless its history is decisively toxic', () => {
  const signals = { confluencia: 'BUY', scoring: 'SELL', mfls: 'BUY' };

  const noisy = getActionableStrategyCandidates(equityQve({ signals: 10, expectancyR: -0.05, profitFactor: 0.9 }), signals);
  assert.equal(noisy.length, 1);
  assert.equal(noisy[0].strategy, 'confluencia');
  assert.equal(noisy[0].signal, 'BUY');
  assert.equal(noisy[0].confidence, 'LIMITED');

  const toxic = getActionableStrategyCandidates(equityQve({ signals: 12, expectancyR: -0.5, profitFactor: 0.3 }), signals);
  assert.equal(toxic.length, 0);

  const smallToxicSample = getActionableStrategyCandidates(equityQve({ signals: 5, expectancyR: -0.8, profitFactor: 0.2 }), signals);
  assert.equal(smallToxicSample.length, 1, 'fewer than 8 trades is not enough evidence to veto');

  const informational = getInformationalStrategyCandidates(equityQve({ signals: 10, expectancyR: 0, profitFactor: null }), signals);
  assert.deepEqual(informational.map(c => [c.strategy, c.signal, c.confidence]), [['scoring', 'SELL', 'NONE'], ['mfls', 'BUY', 'NONE']]);
  assert.ok(informational.every(c => c.strategyLabel.endsWith('(Informativa)')));
});

test('Scanner runs a few seconds after each minute boundary', () => {
  const minute = Date.UTC(2026, 8, 29, 14, 0, 0);
  assert.equal(getMsUntilNextAlignedScan(minute), 8_000);
  assert.equal(getMsUntilNextAlignedScan(minute + 8_000), 60_000);
  assert.equal(getMsUntilNextAlignedScan(minute + 30_000), 38_000);
  assert.equal(getKlineCacheBoundaryMs('5m'), 300_000);
  assert.equal(getKlineCacheBoundaryMs('1h'), undefined);
});

const alert = (over: Partial<AuditAlertItem>): AuditAlertItem => ({
  id: over.id ?? 'a', symbol: 'MSFT', interval: '5m', signal: 'BUY', time: '', pf: null, strategy: 'Confluencia',
  entryPrice: 100, stopLoss: 99, takeProfit1: 101.5, status: 'SL_HIT', realizedR: -1, pnlPercent: -1,
  timestamp: Date.UTC(2026, 8, 29, 13, 45, 20), candleTimestamp: Date.UTC(2026, 8, 29, 13, 40) / 1000, alertType: 'PRIMARY',
  ...over,
});

test('Alert report: latency, execution cost, first alert of the day and archive', () => {
  const candle = Date.UTC(2026, 8, 29, 13, 40) / 1000;
  assert.equal(computeAlertLatencySec(candle, '5m', (candle + 300) * 1000 + 12_400), 12);
  assert.equal(computeAlertLatencySec(0, '5m', Date.now()), undefined);
  assert.ok(Math.abs(computeExecutionCostR({ signal: 'BUY', entryPrice: 100, stopLoss: 99, userFillPrice: 100.2 })! - 0.2) < 1e-9);
  assert.ok(Math.abs(computeExecutionCostR({ signal: 'SELL', entryPrice: 100, stopLoss: 101, userFillPrice: 99.9 })! - 0.1) < 1e-9);

  const now = Date.UTC(2026, 8, 30, 21, 0);
  const archive = mergeIntoAlertArchive([], [
    alert({ id: 'first', realizedR: 1.5, status: 'TP1_CLOSED', alertLatencySec: 10, userFillPrice: 100.1 }),
    alert({ id: 'later', realizedR: -1, candleTimestamp: Date.UTC(2026, 8, 29, 14, 20) / 1000, alertLatencySec: 70 }),
    alert({ id: 'info', strategy: 'VCME Sniper (Informativa)', alertType: 'EXPLORATORY', realizedR: 0.5, status: 'EXPIRED' }),
    alert({ id: 'open', status: 'OPEN' }),
  ], now);
  assert.deepEqual(archive.map(a => a.id).sort(), ['first', 'info', 'later']);

  const report = buildAlertPerformanceReport(archive as ArchivedAlert[], now, 7);
  assert.equal(report.primary.n, 2);
  assert.equal(report.firstOfDay.n, 1);
  assert.equal(report.firstOfDay.totalR, 1.5);
  assert.equal(report.laterInDay.totalR, -1);
  assert.equal(report.bySlot['09:30–10:00'].n, 1);
  assert.equal(report.bySlot['10:00–11:00'].n, 1);
  assert.equal(report.byStrategy['VCME Sniper (Informativa)'].n, 1);
  assert.equal(report.latency.over60s, 1);
  assert.equal(report.execution.n, 1);
  assert.ok(Math.abs(report.execution.avgCostR - 0.1) < 1e-9);
});

test('Alert report: day as the unit, clustered interval, best/worst day and rule-version filter', () => {
  const now = Date.UTC(2026, 10, 6, 21, 0);
  const at = (day: number, minute: number) => Date.UTC(2026, 10, day, 14, minute) / 1000;
  const mk = (id: string, day: number, minute: number, realizedR: number, appVersion?: string) => toArchivedAlert(alert({
    id, realizedR, appVersion, candleTimestamp: at(day, minute), timestamp: (at(day, minute) + 310) * 1000,
    status: realizedR > 0 ? 'TP1_CLOSED' : 'SL_HIT',
  }));
  const archive = [
    mk('a1', 3, 35, -1), mk('a2', 3, 40, -1),
    mk('b1', 4, 35, -1, 'v2026.11.4.2'),
    mk('c1', 5, 35, 1.5, 'v2026.11.10.1'), mk('c2', 5, 40, 1.5, 'v2026.11.10.1'), mk('c3', 5, 45, 1.5, 'v2026.11.10.1'),
  ];

  const report = buildAlertPerformanceReport(archive, now, 7);
  assert.deepEqual(report.byDay.days.map(d => [d.day, d.bucket.n, d.bucket.totalR]), [['2026-11-05', 3, 4.5], ['2026-11-04', 1, -1], ['2026-11-03', 2, -2]]);
  assert.equal(report.byDay.bestDay?.day, '2026-11-05');
  assert.equal(report.byDay.avgRWithoutBestDay, -1);
  assert.equal(report.byDay.worstDay?.day, '2026-11-03');
  assert.equal(report.byDay.avgRWithoutWorstDay, 0.875);
  // mean 0.25; day residuals -2.5, -1.25, 3.75 → se = sqrt(1.5 × 21.875) / 6; t(2 df) = 4.303
  assert.ok(Math.abs(report.byDay.ci95HalfWidth! - 4.303 * Math.sqrt(1.5 * 21.875) / 6) < 1e-9);
  // Numeric ordering: v2026.11.10.1 is newer than v2026.11.4.2
  assert.deepEqual(report.versions, ['v2026.11.10.1', 'v2026.11.4.2']);
  assert.equal(report.unversioned, 2);

  const filtered = buildAlertPerformanceReport(archive, now, 7, { minVersion: 'v2026.11.4.2' });
  assert.equal(filtered.primary.n, 4);
  assert.deepEqual(filtered.versions, report.versions);
  assert.equal(buildAlertPerformanceReport(archive, now, 7, { minVersion: 'v2026.11.10.1' }).primary.n, 3);

  // Fewer than 3 days: no interval; a single day: no best/worst comparison
  const twoDays = buildAlertPerformanceReport(archive.slice(0, 3), now, 7);
  assert.equal(twoDays.byDay.ci95HalfWidth, undefined);
  assert.equal(twoDays.byDay.bestDay?.day, '2026-11-04');
  assert.equal(buildAlertPerformanceReport(archive.slice(0, 2), now, 7).byDay.bestDay, undefined);
});

test('Alert archive keeps one alert per candle, strategy and direction', () => {
  const now = Date.UTC(2026, 9, 6, 21, 0);
  const candle = Date.UTC(2026, 9, 6, 13, 35) / 1000;
  const first = alert({ id: 'HUT-5m-1', symbol: 'HUT', candleTimestamp: candle, timestamp: candle * 1000 + 300_000 + 20_000 });
  const second = alert({ id: 'HUT-5m-2', symbol: 'HUT', candleTimestamp: candle, timestamp: first.timestamp + 73 });

  // Duplicate emission from a second scanner (e.g. another tab), in either order and in an already-stored archive
  assert.deepEqual(mergeIntoAlertArchive([], [first, second], now).map(a => a.id), ['HUT-5m-1']);
  assert.deepEqual(mergeIntoAlertArchive([], [second, first], now).map(a => a.id), ['HUT-5m-1']);
  const stored = [toArchivedAlert(second), toArchivedAlert(first)];
  assert.deepEqual(mergeIntoAlertArchive(stored, [], now).map(a => a.id), ['HUT-5m-1']);

  // The same alert still updates in place
  const updated = mergeIntoAlertArchive([toArchivedAlert(first)], [{ ...first, status: 'TP1_CLOSED', realizedR: 1.4 }], now);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].realizedR, 1.4);

  // Other direction, strategy or candle are distinct alerts
  const distinct = mergeIntoAlertArchive([], [
    first,
    alert({ id: 'sell', symbol: 'HUT', candleTimestamp: candle, signal: 'SELL' }),
    alert({ id: 'std', symbol: 'HUT', candleTimestamp: candle, strategy: 'Estándar (Informativa)' }),
    alert({ id: 'next', symbol: 'HUT', candleTimestamp: candle + 300 }),
  ], now);
  assert.equal(distinct.length, 4);
});

test('Only one tab holds the scanner lock; the next tab takes over when it is released', async () => {
  const queue: (() => Promise<void>)[] = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length) await queue.shift()!();
    running = false;
  };
  const locks = { request: (_name: string, cb: () => Promise<void>) => { queue.push(cb); void pump(); return Promise.resolve(); } };
  const flush = () => new Promise(r => setTimeout(r, 0));

  const leaders: string[] = [];
  const releaseA = acquireScannerLeadership(() => leaders.push('A'), locks);
  acquireScannerLeadership(() => leaders.push('B'), locks);
  await flush();
  assert.deepEqual(leaders, ['A']);
  releaseA();
  await flush();
  assert.deepEqual(leaders, ['A', 'B']);

  const fallback: string[] = [];
  acquireScannerLeadership(() => fallback.push('no-locks'), undefined);
  assert.deepEqual(fallback, ['no-locks']);
});
