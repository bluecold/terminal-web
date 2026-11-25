import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchYahooKlines, normalizeYahooKlines, type Kline } from '../../services/api';
import { stampKlineSnapshot } from '../../services/marketDataSnapshot';
import { getConfirmedClosedKlines } from '../indicators';
import { getStrategyExpiryCandles, updateAlertsOutcome, type AuditAlertItem } from '../alertTracker';
import { DEFAULT_FRICTION_PCT } from '../tradeLevels';

// Wednesday 2026-10-07, regular session: 09:30 ET = 13:30 UTC.
const OPEN = Date.parse('2026-10-07T13:30:00Z') / 1000;
const at = (hhmm: string, sec = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return OPEN + ((h - 9) * 60 + (m - 30)) * 60 + sec;
};
const k = (time: number, close = 100, high = close + 0.2, low = close - 0.2, volume = 1000): Kline =>
  ({ time, open: close, high, low, close, volume });
// Yahoo's trailing live quote: stamped with the last trade time, volume 0.
const live = (time: number, price: number): Kline => ({ time, open: price, high: price, low: price, close: price, volume: 0 });

test('Yahoo 5m live quote is folded into the forming bar, so that bar is not treated as closed', () => {
  // Raw feed observed at 09:36:51 (as on 2026-10-07): closed 09:30, forming 09:35, live point 09:36:51.
  const raw = [k(at('09:30')), k(at('09:35'), 100.1), live(at('09:36', 51), 100.4)];
  const realNow = Date.now;
  try {
    Date.now = () => at('09:36', 51) * 1000;
    // Before the fix the live point alone was dropped and the half-formed 09:35 bar passed as closed.
    const unfixed = getConfirmedClosedKlines(stampKlineSnapshot(raw.map(b => ({ ...b })), at('09:36', 51) * 1000), '5m', 'AAPL');
    assert.equal(unfixed[unfixed.length - 1].time, at('09:35'));

    const normalized = normalizeYahooKlines(raw.map(b => ({ ...b })), '5m');
    assert.deepEqual(normalized.map(b => b.time), [at('09:30'), at('09:35')]);
    assert.equal(normalized[1].close, 100.4);
    assert.equal(normalized[1].high, 100.4);
    assert.equal(normalized[1].volume, 1000);
    const closed = getConfirmedClosedKlines(stampKlineSnapshot(normalized, at('09:36', 51) * 1000), '5m', 'AAPL');
    assert.equal(closed[closed.length - 1].time, at('09:30'));
  } finally { Date.now = realNow; }
});

test('Yahoo live quote without a forming bar is snapped to its bar start', () => {
  const normalized = normalizeYahooKlines([k(at('09:30')), live(at('09:36', 51), 100.4)], '5m');
  assert.deepEqual(normalized.map(b => b.time), [at('09:30'), at('09:35')]);
  // Overnight: the first live quote of the day lands on the 09:30 bar of the 15:55 grid.
  const prevDay = at('15:55') - 86400;
  assert.deepEqual(normalizeYahooKlines([k(prevDay), live(at('09:31', 20), 101)], '5m').map(b => b.time), [prevDay, at('09:30')]);
});

test('Yahoo 1h bars keep their 09:30 anchor and daily live quotes merge by session date', () => {
  const hourly = normalizeYahooKlines([k(at('09:30')), k(at('10:30')), live(at('11:10', 5), 101)], '1h');
  assert.deepEqual(hourly.map(b => b.time), [at('09:30'), at('10:30')]);
  assert.equal(hourly[1].close, 101);

  const daily = normalizeYahooKlines([k(OPEN - 86400), k(OPEN), live(at('15:45'), 102)], '1d');
  assert.deepEqual(daily.map(b => b.time), [OPEN - 86400, OPEN]);
  assert.equal(daily[1].close, 102);
  assert.deepEqual(normalizeYahooKlines([k(OPEN - 86400), k(OPEN)], '1d').map(b => b.time), [OPEN - 86400, OPEN]);
});

test('fetchYahooKlines returns grid-aligned bars when the payload carries a live quote', async () => {
  const realFetch = globalThis.fetch;
  const bars = [k(at('09:30')), k(at('09:35'), 100.1), live(at('09:36', 51), 100.4)];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ chart: { result: [{ timestamp: bars.map(b => b.time),
      indicators: { quote: [{ open: bars.map(b => b.open), high: bars.map(b => b.high), low: bars.map(b => b.low),
        close: bars.map(b => b.close), volume: bars.map(b => b.volume) }] } }] } }), { status: 200 });
    const klines = await fetchYahooKlines('LIVE_QUOTE_NORMALIZE_TEST', '5m');
    assert.deepEqual(klines.map(b => b.time), [at('09:30'), at('09:35')]);
    assert.equal(klines[1].close, 100.4);
  } finally { globalThis.fetch = realFetch; }
});

// Confluencia SELL like the live alerts: trigger 09:35, entry 09:40:08, SL 101.5, TP 97.75.
const sellAlert = (): AuditAlertItem => ({
  id: 'live-quote', symbol: 'AAPL', interval: '5m', signal: 'SELL', strategy: 'Confluencia', strategyKey: 'confluencia',
  executionStyle: 'dayTrading', status: 'OPEN', entryPrice: 100, stopLoss: 101.5, takeProfit1: 97.75,
  timestamp: at('09:40', 8) * 1000, candleTimestamp: at('09:35'), realizedR: 0, pnlPercent: 0, time: '', pf: null,
});
// Yahoo-like snapshot at `now`: closed bars from 09:30, the forming bar and the live quote, normalized as fetched.
const snapshot = (nowSec: number, priceAt: (barTime: number) => number = () => 100) => {
  const bars: Kline[] = [];
  for (let t = at('09:30'); t <= nowSec; t += 300) bars.push(k(t, priceAt(t), priceAt(t) + 0.2, priceAt(t) - 0.2));
  bars.push(live(nowSec, priceAt(Math.floor((nowSec - OPEN) / 300) * 300 + OPEN)));
  return stampKlineSnapshot(normalizeYahooKlines(bars, '5m'), nowSec * 1000);
};

test('Tracker observes bar closes on minute-by-minute live snapshots and applies the time stop', () => {
  const realNow = Date.now;
  try {
    let alert = sellAlert();
    for (let now = at('09:40', 8); now < at('16:00') && alert.status === 'OPEN'; now += 60) {
      Date.now = () => now * 1000;
      alert = updateAlertsOutcome([alert], { 'AAPL:5m': snapshot(now) })[0];
    }
    const window = getStrategyExpiryCandles('confluencia', '5m', 'dayTrading', 'AAPL');
    assert.equal(alert.status, 'EXPIRED');
    assert.equal(alert.executionState?.exit?.reason, 'TIMEOUT');
    assert.equal(alert.executionState?.barsSeen, window);
    assert.equal(alert.executionState?.exit?.barTime, at('09:40') + (window - 1) * 300);
  } finally { Date.now = realNow; }
});

test('Off-grid checkpoint saved before the fix is re-anchored and its bar extremes and close are observed', () => {
  const realNow = Date.now;
  try {
    // Checkpoint as persisted on 2026-10-07: cursor on the 09:41:30 live quote.
    Date.now = () => at('09:41', 30) * 1000;
    const offGrid = stampKlineSnapshot([k(at('09:30')), k(at('09:35')), k(at('09:40')), live(at('09:41', 30), 100)], at('09:41', 30) * 1000);
    const saved = updateAlertsOutcome([sellAlert()], { 'AAPL:5m': offGrid })[0];
    assert.equal(saved.executionState?.cursor?.bar.time, at('09:41', 30));

    // The 09:40 bar later spikes through the stop after the checkpoint; the 09:45 bar does not.
    Date.now = () => at('09:46', 8) * 1000;
    const bars = [k(at('09:30')), k(at('09:35')), k(at('09:40'), 100.5, 101.8, 99.9), k(at('09:45'))];
    const result = updateAlertsOutcome([JSON.parse(JSON.stringify(saved))], { 'AAPL:5m': stampKlineSnapshot(bars, at('09:46', 8) * 1000) })[0];
    assert.equal(result.status, 'SL_HIT');
    assert.equal(result.executionState?.exit?.barTime, at('09:40'));
  } finally { Date.now = realNow; }
});

test('Session square-off closes an open intraday equity position at the last price with its real R', () => {
  const realNow = Date.now;
  try {
    // Afternoon entry: the time stop cannot close it before 16:00, so only the square-off can.
    const entry: AuditAlertItem = { ...sellAlert(), timestamp: at('14:00', 8) * 1000, candleTimestamp: at('13:55') };
    assert.ok(at('14:00') + getStrategyExpiryCandles('confluencia', '5m', 'dayTrading', 'AAPL') * 300 > at('16:00'));
    // Price drifts to 99.0 for a SELL from 100 (stop 1.5 away): roughly +0.6R gross before costs.
    const priceAt = (t: number) => t >= at('15:00') ? 99 : 100;
    const lastBar = at('15:55');
    const bars = stampKlineSnapshot(Array.from({ length: (lastBar - at('09:30')) / 300 + 1 }, (_, i) => {
      const t = at('09:30') + i * 300;
      return k(t, priceAt(t), priceAt(t) + 0.2, priceAt(t) - 0.2);
    }), (lastBar + 600) * 1000);
    Date.now = () => (lastBar + 600) * 1000;

    const kept = updateAlertsOutcome([entry], { 'AAPL:5m': bars })[0];
    assert.equal(kept.status, 'OPEN');
    assert.equal(kept.realizedR, 0);

    const closed = updateAlertsOutcome([entry], { 'AAPL:5m': bars }, { squareOffIntraday: true })[0];
    assert.equal(closed.status, 'EXPIRED');
    assert.equal(closed.executionState?.exit?.barTime, lastBar);
    const exitPrice = 99 * (1 + 0.03 / 100);              // market exit with slippage against a SELL
    const net = (100 - exitPrice) / 100 * 100 - DEFAULT_FRICTION_PCT;
    assert.equal(closed.realizedR, Number((net / 1.5).toFixed(2)));
    assert.ok(closed.realizedR > 0.4);
  } finally { Date.now = realNow; }
});
