import assert from 'node:assert/strict';
import test from 'node:test';
import type { Kline } from '../../services/api';
import { buildConfluenciaContext, evaluateConfluenciaAt } from '../strategyEvaluators';
import { computeConfluenciaSignalsSeries } from '../backtester';
import { getEasternTime } from '../indicators';

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

// 2026-09-28 14:00–16:00 ET, then 2026-09-29 from the 09:30 ET open (index 24)
const prevSession = zigzag(Date.UTC(2026, 8, 28, 18, 0) / 1000, 24, 100);
const uptrend = [...prevSession, ...zigzag(Date.UTC(2026, 8, 29, 13, 30) / 1000, 66, prevSession[prevSession.length - 1].close)];
const idxAt = (klines: Kline[], hourEt: number, minuteEt: number) =>
  klines.findIndex(k => k.time === Date.UTC(2026, 8, 29, hourEt + 4, minuteEt) / 1000);
const I0930 = idxAt(uptrend, 9, 30);
const I0935 = idxAt(uptrend, 9, 35);
const I0940 = idxAt(uptrend, 9, 40);
const I1055 = idxAt(uptrend, 10, 55);
const I1100 = idxAt(uptrend, 11, 0);

// Same series with the 11:00 ET candle forced bullish, to test the window boundary on a valid setup
const boundary = uptrend.map((k, i) => (i === I1100
  ? { ...k, open: uptrend[i - 1].close, close: uptrend[i - 1].close + 0.12, high: uptrend[i - 1].close + 0.14, low: uptrend[i - 1].close - 0.02 }
  : k));

// Mirror image of the uptrend (same geometry, falling prices)
const mirror = (klines: Kline[]): Kline[] => klines.map(k => ({ ...k, open: 200 - k.open, close: 200 - k.close, high: 200 - k.low, low: 200 - k.high }));
const downtrend = mirror(uptrend);

const equityCtx = (klines: Kline[] = uptrend) => buildConfluenciaContext(klines, '5m', 'MSFT');

test('Confluencia 5m equities: window opens with the 09:35 ET candle and closes before 11:00 ET', () => {
  const ctx = equityCtx(boundary);
  // Neutralize VWAP gating so the session window is the only rule under test
  for (const i of [I0930, I0935, I1055, I1100]) {
    assert.ok(boundary[i].close > boundary[i].open, 'precondition: bullish candle');
    ctx.vwapReliable![i] = false;
  }
  assert.equal(evaluateConfluenciaAt(ctx, I0930).signal, 'NEUTRAL', '09:30 opening candle is excluded');
  assert.equal(evaluateConfluenciaAt(ctx, I0935).signal, 'BUY');
  assert.equal(evaluateConfluenciaAt(ctx, I1055).signal, 'BUY', 'last candle of the window (closes 11:00)');
  assert.equal(evaluateConfluenciaAt(ctx, I1100).signal, 'NEUTRAL');
});

test('Confluencia: the session window only applies to 5m equities', () => {
  const hourly = buildConfluenciaContext(boundary, '1h', 'MSFT');
  hourly.vwapReliable![I1100] = false;
  assert.equal(evaluateConfluenciaAt(hourly, I1100).signal, 'BUY');
});

test('Confluencia: SELL is the exact mirror of BUY', () => {
  assert.equal(evaluateConfluenciaAt(equityCtx(), I0940).signal, 'BUY');
  assert.equal(evaluateConfluenciaAt(equityCtx(downtrend), I0940).signal, 'SELL');
});

test('Confluencia: requires candle volume >= 80% of the 20-candle average', () => {
  const withVolume = (volume: number) => {
    const klines = uptrend.map((k, i) => (i === I0940 ? { ...k, volume } : k));
    return evaluateConfluenciaAt(equityCtx(klines), I0940).signal;
  };
  assert.equal(withVolume(9_000), 'BUY');
  assert.equal(withVolume(7_000), 'NEUTRAL');
});

test('Confluencia: price on the right side of VWAP and no more than 2.2 ATR away from it', () => {
  const at = (vwapOffsetAtr: number) => {
    const ctx = equityCtx();
    ctx.vwapReliable![I0940] = true;
    ctx.vwap[I0940] = uptrend[I0940].close - vwapOffsetAtr * ctx.atr[I0940];
    return evaluateConfluenciaAt(ctx, I0940).signal;
  };
  assert.equal(at(1.0), 'BUY');
  assert.equal(at(-0.1), 'NEUTRAL', 'BUY below VWAP');
  assert.equal(at(3.0), 'NEUTRAL', 'overextended from VWAP');
});

test('Confluencia: requires EMA 9 above EMA 20 for BUY', () => {
  const ctx = equityCtx();
  ctx.ema9[I0940] = ctx.ema20[I0940] - 0.01;
  assert.equal(evaluateConfluenciaAt(ctx, I0940).signal, 'NEUTRAL');
});

test('Confluencia: rejects a bullish candle closing in the lower half (long upper wick)', () => {
  const klines = uptrend.map((k, i) => (i === I0940 ? { ...k, close: k.open + 0.01, high: k.open + 0.5, low: k.open - 0.02 } : k));
  assert.equal(evaluateConfluenciaAt(equityCtx(klines), I0940).signal, 'NEUTRAL');
});

test('Confluencia 5m: stop at max(0.40%, 2 ATR) from the close', () => {
  const ctx = equityCtx();
  const buy = evaluateConfluenciaAt(ctx, I0940);
  const close = uptrend[I0940].close;
  const stopPct = Math.max(0.004, (2 * ctx.atr[I0940]) / close);
  assert.ok(Math.abs(buy.stopLoss - close * (1 - stopPct)) < 1e-9);

  const sellCtx = equityCtx(downtrend);
  const sell = evaluateConfluenciaAt(sellCtx, I0940);
  const sellClose = downtrend[I0940].close;
  const sellStopPct = Math.max(0.004, (2 * sellCtx.atr[I0940]) / sellClose);
  assert.ok(Math.abs(sell.stopLoss - sellClose * (1 + sellStopPct)) < 1e-9);
});

test('Confluencia backtest series: every 5m equity signal falls inside 09:35–11:00 ET', () => {
  const signals = computeConfluenciaSignalsSeries(uptrend, '5m', 'MSFT');
  const fired = signals.map((s, i) => [s, i] as const).filter(([s]) => s !== 'NEUTRAL');
  assert.ok(fired.length > 0, 'the series must produce signals for the property to be meaningful');
  for (const [, i] of fired) {
    const minute = getEasternTime(uptrend[i].time * 1000).minuteOfDay;
    assert.ok(minute >= 575 && minute < 660, `signal at minute ${minute}`);
  }
});
