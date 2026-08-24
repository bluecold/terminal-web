import type { Kline } from '../services/api';
import {
  calculateEMA,
  calculateRSISeries,
  calculateSupertrendSeries,
  calculateBollingerBandsSeries,
  calculateVWAPSeries,
  calculateMACDSeries,
  calculateStochRSISeries,
  calculateVolumeSignalSeries,
  isHammer,
  isEngulfing,
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  calculateRSISlope,
  calculateSupportResistance,
  calculateATRSeries,
  calculateADXSeries,
  getOpeningRange,
  checkBullishDivergence,
  checkBearishDivergence,
  candleBodyRatio,
  closePosition,
  upperWickRatio,
  lowerWickRatio,
  getSessionId,
  calculateTimeOfDayVolumeAvg,
  calculateRevolutionVolatilityBand,
  calculateVolumeComposition,
  calculateAndianOscillator,
  calculateDreadBlitz,
  isNyseOpeningWindow
} from './indicators';

// ─── Result Interface ──────────────────────────────────────────────────────

export interface BacktestResult {
  totalSignals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;          // wins / resolved (wins + losses) — trades that reached an outcome
  resolutionRate: number;   // resolved / totalSignals — what % of signals reached target or stop
  profitFactor: number;     // total gains / total losses (>1 = profitable)
  expectancy: number;       // expected % gain per trade
  neutrals: number;         // skipped NEUTRAL candles
  label: string;            // e.g. "últimas 150 velas"
  forwardLabel: string;     // e.g. "ventana 6 velas (30 min)"
  threshold: number;        // stop loss threshold used (adaptive)
  targetThreshold: number;  // take profit threshold (threshold × targetMultiplier)
  targetMultiplier: number; // risk/reward ratio (e.g. 1.5 = 1:1.5 R:R)
  insufficient: boolean;    // true if not enough data
}

// ─── Trend Filter ──────────────────────────────────────────────────────────

export function getTrendFilter(closes: number[]): 'UP' | 'DOWN' | 'NONE' {
  const period = 200;
  if (closes.length < period) return 'NONE';
  const ema = calculateEMA(closes, period);
  const lastEma = ema[ema.length - 1];
  const lastClose = closes[closes.length - 1];
  if (isNaN(lastEma)) return 'NONE';
  return lastClose > lastEma ? 'UP' : 'DOWN';
}

// ─── Timeframe Parameters ──────────────────────────────────────────────────

interface BacktestParams {
  evalWindow: number;
  forwardWindow: number;
  forwardLabel: string;
  fallbackThreshold: number;   // fallback if ATR can't be calculated
  atrMultiplier: number;       // ATR × this = stop threshold
  targetMultiplier: number;    // risk/reward: target = stop × this
}

function getParams(interval: string): BacktestParams {
  switch (interval) {
    case '5m':
      return {
        evalWindow: 576,               // 48 hours of 5m data
        forwardWindow: 6,
        forwardLabel: '6 velas (30 min)',
        fallbackThreshold: 0.008,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
      };
    case '1d':
      return {
        evalWindow: 60,                // 60 days
        forwardWindow: 3,
        forwardLabel: '3 velas (3 días)',
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
      };
    case '1h':
    default:
      return {
        evalWindow: 168,               // 7 days of 1h data
        forwardWindow: 4,
        forwardLabel: '4 velas (4 hs)',
        fallbackThreshold: 0.012,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
      };
  }
}

// ─── ATR-based Adaptive Threshold ──────────────────────────────────────────
// Computes threshold as a percentage of the close, scaled by ATR.
// This makes the backtest fair for both low-vol stocks (KO) and high-vol crypto (SOL).

function getAdaptiveThreshold(atr: number, close: number, atrMultiplier: number, fallback: number): number {
  if (!Number.isFinite(atr) || atr <= 0 || close <= 0) return fallback;

  const atrPct = atr / close;
  const threshold = atrPct * atrMultiplier;

  // Clamp to sane bounds: 0.2% minimum, 8% maximum
  return Math.max(0.002, Math.min(0.08, threshold));
}

// ─── Session Gap Detection (stocks vs crypto) ──────────────────────────────
// If consecutive klines have gaps significantly larger than expected,
// the asset trades in sessions (stocks). Crypto trades 24/7 with no gaps.

function hasSessionGaps(klines: Kline[], interval: string): boolean {
  if (klines.length < 10) return false;
  const expectedGapSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;

  // Scan full historical klines for session gaps
  for (let i = 1; i < klines.length; i++) {
    const gap = klines[i].time - klines[i - 1].time;
    if (gap > expectedGapSec * 3) return true; // Gap > 3× expected = session break
  }
  return false;
}

// Checks if a given candle is near the end of a trading session.
// We detect this by looking at whether the NEXT candle has a large time gap.
function isNearSessionEnd(klines: Kline[], idx: number, interval: string, forwardWindow: number): boolean {
  // Check if any of the forward candles have a session gap
  for (let f = idx + 1; f <= idx + forwardWindow && f < klines.length; f++) {
    const gap = klines[f].time - klines[f - 1].time;
    const expectedGapSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;
    if (gap > expectedGapSec * 3) return true;
  }
  return false;
}

// ─── Trade Outcome Evaluation ──────────────────────────────────────────────

interface TradeOutcome {
  result: 'win' | 'loss' | 'timeout';
  pnlPct: number; // percentage P&L of this trade
}

function evaluateOutcome(
  klines: Kline[],
  entryIdx: number,
  signal: 'BUY' | 'SELL',
  forwardWindow: number,
  stopThreshold: number,
  targetThreshold: number
): TradeOutcome {
  // Realistic execution: entry at next candle open + 0.08% friction (commission + slippage)
  const nextIdx = entryIdx + 1 < klines.length ? entryIdx + 1 : entryIdx;
  const entry = klines[nextIdx].open || klines[entryIdx].close;
  const frictionPct = 0.08;

  const target = signal === 'BUY'
    ? entry * (1 + targetThreshold)
    : entry * (1 - targetThreshold);
  const stop = signal === 'BUY'
    ? entry * (1 - stopThreshold)
    : entry * (1 + stopThreshold);

  for (let f = entryIdx + 1; f <= entryIdx + forwardWindow && f < klines.length; f++) {
    const { high, low } = klines[f];

    if (signal === 'BUY') {
      // Check stop first (pessimistic)
      if (low <= stop)    return { result: 'loss', pnlPct: -stopThreshold * 100 - frictionPct };
      if (high >= target) return { result: 'win',  pnlPct: targetThreshold * 100 - frictionPct };
    } else {
      if (high >= stop)  return { result: 'loss', pnlPct: -stopThreshold * 100 - frictionPct };
      if (low <= target) return { result: 'win',  pnlPct: targetThreshold * 100 - frictionPct };
    }
  }

  // Timeout: calculate actual P&L at end of window
  const lastIdx = Math.min(entryIdx + forwardWindow, klines.length - 1);
  const exitPrice = klines[lastIdx].close;
  const rawPnl = signal === 'BUY'
    ? (exitPrice - entry) / entry * 100
    : (entry - exitPrice) / entry * 100;

  return { result: 'timeout', pnlPct: rawPnl - frictionPct };
}

// ─── Cache Layer for Backtesting Performance ──────────────────────────────
const backtestCache = new Map<string, { fingerprint: string; result: BacktestResult }>();

function getKlinesFingerprint(seriesList: (Kline[] | undefined)[]): string {
  let fp = '';
  for (let i = 0; i < seriesList.length; i++) {
    const s = seriesList[i];
    if (s && s.length > 0) {
      fp += `${s[s.length - 1].time}_${s.length}|`;
    } else {
      fp += '0_0|';
    }
  }
  return fp;
}

function getBacktestCache(key: string, klines: Kline[], auxiliarySeries?: (Kline[] | undefined)[]): BacktestResult | null {
  if (!klines || klines.length === 0) return null;
  const cached = backtestCache.get(key);
  if (!cached) return null;

  const allSeries = auxiliarySeries ? [klines, ...auxiliarySeries] : [klines];
  const fp = getKlinesFingerprint(allSeries);
  if (cached.fingerprint === fp) {
    return cached.result;
  }
  return null;
}

function setBacktestCache(key: string, klines: Kline[], result: BacktestResult, auxiliarySeries?: (Kline[] | undefined)[]): BacktestResult {
  if (klines && klines.length > 0 && result) {
    if (backtestCache.size >= 250) {
      const oldestKey = backtestCache.keys().next().value;
      if (oldestKey) backtestCache.delete(oldestKey);
    }
    const allSeries = auxiliarySeries ? [klines, ...auxiliarySeries] : [klines];
    const fingerprint = getKlinesFingerprint(allSeries);
    backtestCache.set(key, { fingerprint, result });
  }
  return result;
}

// ─── Public API (Optimized O(n)) ────────────────────────────────────────────

export function backtestStandard(klines: Kline[], interval: string, symbol?: string): BacktestResult {
  const cacheKey = `standard:${symbol || 'any'}:${interval}`;
  const cached = getBacktestCache(cacheKey, klines);
  if (cached) return cached;
  const signals = computeStandardSignalsSeries(klines);
  const res = runBacktestGenericOptimized(klines, interval, signals);
  return setBacktestCache(cacheKey, klines, res);
}

export function backtestConfluencia(klines: Kline[], interval: string, symbol?: string): BacktestResult {
  const cacheKey = `confluencia:${symbol || 'any'}:${interval}`;
  const cached = getBacktestCache(cacheKey, klines);
  if (cached) return cached;
  const signals = computeConfluenciaSignalsSeries(klines, interval);
  const res = runBacktestGenericOptimized(klines, interval, signals);
  return setBacktestCache(cacheKey, klines, res);
}

export function backtestScoring(klines: Kline[], interval: string, weights?: ScoringWeights, symbol?: string): BacktestResult {
  const w = weights || DEFAULT_WEIGHTS;
  const weightsKey = `${w.trend}_${w.rsi}_${w.bollinger}_${w.volume}_${w.candle}`;
  const cacheKey = `scoring:${symbol || 'any'}:${interval}:${weightsKey}`;
  const cached = getBacktestCache(cacheKey, klines);
  if (cached) return cached;
  const signals = computeScoringSignalsSeries(klines, interval, weights);
  const res = runBacktestGenericOptimized(klines, interval, signals);
  return setBacktestCache(cacheKey, klines, res);
}

export function backtestMultitemporal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  _interval: string,
  symbol?: string,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo'
): BacktestResult {
  const cacheKey = `multitemporal:${symbol || 'any'}:${_interval}:${style}:${triggerMode}`;
  const cached = getBacktestCache(cacheKey, klines5m, [klines1h, klines1d]);
  if (cached) return cached;
  const tf = style === 'swing' ? '1h' : '5m';
  const evalWindow = 576;
  const stepSec = klines5m.length > 1 ? (klines5m[1].time - klines5m[0].time) : (style === 'swing' ? 3600 : 300);
  const forwardWindow = style === 'swing'
    ? (stepSec === 300 ? 576 : 48)  // 576 x 5m = 48h OR 48 x 1h = 48h
    : 288;                           // 288 x 5m = 24h
  const cooldownHours = style === 'swing' ? 4 : 2;
  const candlesPerHour = Math.max(1, Math.round(3600 / (stepSec || 300)));
  const cooldownPeriod = cooldownHours * candlesPerHour;  // 4h cooldown for Swing, 2h for DayTrading
  const isSessionBased = hasSessionGaps(klines5m, tf);

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
    neutrals: 0,
    label: `datos insuficientes`,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '24 hs max (Intradía)',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true
  };

  // Every evaluated trade needs its complete forward horizon.
  if (!klines5m || klines5m.length < evalWindow + forwardWindow) return fallbackResult;
  if (!klines1h || klines1h.length < 60) return fallbackResult;
  if (!klines1d || klines1d.length < 30) return fallbackResult;

  // ── Pre-calculate all series O(n) ─────────────────────────────────────
  // 1D series
  const closes1d = klines1d.map(k => k.close);
  const ema200_1d = closes1d.length >= 150 ? calculateEMA(closes1d, 200) : new Array(closes1d.length).fill(NaN);
  const ema50_1d = calculateEMA(closes1d, 50);
  const adxData1d = calculateADXSeries(klines1d, 14);

  // 1H series
  const closes1h = klines1h.map(k => k.close);
  const ema200_1h = calculateEMA(closes1h, Math.min(200, closes1h.length));
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema20_1h = calculateEMA(closes1h, 20);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
  const adxSeries1h = calculateADXSeries(klines1h, 14);
  const macdData1h = calculateMACDSeries(closes1h);
  const atrSeries1h = calculateATRSeries(klines1h, 14);
  const vwapSeries1h = calculateVWAPSeries(klines1h, '1h', symbol);

  // 5m series
  const closes5m = klines5m.map(k => k.close);
  const bbSeries5m = calculateBollingerBandsSeries(klines5m, 20, 2);
  const ema9_5m = calculateEMA(closes5m, 9);
  const ema21_5m = calculateEMA(closes5m, 21);
  const vwapSeries5m = calculateVWAPSeries(klines5m, style === 'swing' ? '1h' : '5m', symbol);
  const rsiSeries5m = calculateRSISeries(closes5m, 14);
  const atrSeries5m = calculateATRSeries(klines5m, 14);
  
  const vol5m = klines5m.map(k => k.volume);
  const volSma5m: number[] = new Array(klines5m.length).fill(0);
  let volSum5m = 0;
  for (let i = 0; i < Math.min(20, vol5m.length); i++) volSum5m += vol5m[i];
  if (vol5m.length >= 20) volSma5m[19] = volSum5m / 20;
  for (let i = 20; i < vol5m.length; i++) {
    volSum5m = volSum5m - vol5m[i - 20] + vol5m[i];
    volSma5m[i] = volSum5m / 20;
  }

  // Bollinger Band Width series for Squeeze (bbSeries5m is shorter by ~19)
  const bbWidth5m = bbSeries5m.map(b => b.middle > 0 ? (b.upper - b.lower) / b.middle * 100 : 0);

  // ATR SMA 50 for 1H Volatility Regime
  const atrSma1hArr = new Array(klines1h.length).fill(0);
  let atr1hSum = 0;
  for (let idx = 0; idx < Math.min(50, atrSeries1h.length); idx++) {
    atr1hSum += isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx];
  }
  if (atrSeries1h.length >= 50) atrSma1hArr[49] = atr1hSum / 50;
  for (let idx = 50; idx < atrSeries1h.length; idx++) {
    atr1hSum = atr1hSum - (isNaN(atrSeries1h[idx - 50]) ? 0 : atrSeries1h[idx - 50]) + (isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx]);
    atrSma1hArr[idx] = atr1hSum / 50;
  }

  const latestEvalIdx = klines5m.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(30, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let neutrals = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;
  let nextAllowedIdx = 0;

  // ── Pre-calculate 1D and 1H timestamp lookup maps O(N) ───────────────
  const idx1dMap = new Int32Array(klines5m.length);
  let dPtr = 0;
  for (let i = 0; i < klines5m.length; i++) {
    const t = klines5m[i].time;
    while (dPtr < klines1d.length && klines1d[dPtr].time + 86400 <= t) {
      dPtr++;
    }
    idx1dMap[i] = dPtr - 1;
  }

  const idx1hMap = new Int32Array(klines5m.length);
  let hPtr = 0;
  for (let i = 0; i < klines5m.length; i++) {
    const t = klines5m[i].time;
    while (hPtr < klines1h.length && klines1h[hPtr].time + 3600 <= t) {
      hPtr++;
    }
    idx1hMap[i] = hPtr - 1;
  }

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      neutrals++;
      continue;
    }

    if (isSessionBased && isNearSessionEnd(klines5m, i, tf, 6)) {
      neutrals++;
      continue;
    }

    const curr = klines5m[i];
    const prev = klines5m[i - 1];

    // ── LAYER 1: Daily Bias 1D ───────────────────────────────────────────
    const idx1d = idx1dMap[i];
    if (idx1d < 27) { neutrals++; continue; } // ADX(14) needs ~28 bars to converge

    const lastEma200_1d = ema200_1d[idx1d];
    const lastEma50_1d = ema50_1d[idx1d];
    const lastClose1d = closes1d[idx1d];

    const lastAdx1d = adxData1d.adx[idx1d];
    const lastPlusDI1d = adxData1d.plusDI[idx1d];
    const lastMinusDI1d = adxData1d.minusDI[idx1d];

    if (isNaN(lastEma200_1d) || isNaN(lastEma50_1d) || isNaN(lastAdx1d)) { neutrals++; continue; }

    let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
    const bias_long = lastClose1d > lastEma200_1d && lastEma50_1d > lastEma200_1d && lastAdx1d > 20 && lastPlusDI1d > lastMinusDI1d;
    const bias_short = lastClose1d < lastEma200_1d && lastEma50_1d < lastEma200_1d && lastAdx1d > 20 && lastMinusDI1d > lastPlusDI1d;

    if (bias_long) bias1D = 'ALCISTA';
    else if (bias_short) bias1D = 'BAJISTA';

    // ── LAYER 2: 1H Setup (Stateless State Machine + ADX/EMA200 Slope Regime) ──
    const idx1h = idx1hMap[i];
    if (idx1h < 50) { neutrals++; continue; }

    const rsiVal1h = rsiSeries1h[idx1h];
    const atrVal1h = atrSeries1h[idx1h];
    const vwapVal1h = vwapSeries1h[idx1h];
    const macdHist1h = macdData1h.histogram[idx1h];
    const macdHistPrev1h = idx1h > 0 ? macdData1h.histogram[idx1h - 1] : NaN;

    if (isNaN(vwapVal1h) || isNaN(rsiVal1h) || isNaN(atrVal1h)) {
      neutrals++; continue;
    }

    const isSetupLongCandle = (hIdx: number) => {
      const hist = macdData1h.histogram[hIdx];
      const prevHist = macdData1h.histogram[hIdx - 1];
      const ema200Val = ema200_1h[hIdx];
      const ema200Prev5 = hIdx >= 5 ? ema200_1h[hIdx - 5] : ema200Val;
      const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
      const adxVal = adxSeries1h.adx[hIdx];
      const regimeOkLong = adxVal > 20 && slope > 0.0005;

      return (
        regimeOkLong &&
        closes1h[hIdx] > vwapSeries1h[hIdx] &&
        ema20_1h[hIdx] > ema50_1h[hIdx] &&
        rsiSeries1h[hIdx] >= 50 && rsiSeries1h[hIdx] <= 70 &&
        hist > 0 &&
        hist > prevHist
      );
    };

    const isSetupShortCandle = (hIdx: number) => {
      const hist = macdData1h.histogram[hIdx];
      const prevHist = macdData1h.histogram[hIdx - 1];
      const ema200Val = ema200_1h[hIdx];
      const ema200Prev5 = hIdx >= 5 ? ema200_1h[hIdx - 5] : ema200Val;
      const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
      const adxVal = adxSeries1h.adx[hIdx];
      const regimeOkShort = adxVal > 20 && slope < -0.0005;

      return (
        regimeOkShort &&
        closes1h[hIdx] < vwapSeries1h[hIdx] &&
        ema20_1h[hIdx] < ema50_1h[hIdx] &&
        rsiSeries1h[hIdx] >= 30 && rsiSeries1h[hIdx] <= 50 &&
        hist < 0 &&
        hist < prevHist
      );
    };

    const isInvalidatedLong = (hIdx: number) => {
      return closes1h[hIdx] < vwapSeries1h[hIdx] || ema20_1h[hIdx] < ema50_1h[hIdx];
    };

    const isInvalidatedShort = (hIdx: number) => {
      return closes1h[hIdx] > vwapSeries1h[hIdx] || ema20_1h[hIdx] > ema50_1h[hIdx];
    };

    let setupArmedLong = false;
    // Bug #2 fix: changed `break` to `continue` on invalidation so that a single
    // invalidated 1H candle does not prevent checking the previous 2 hours.
    for (let offset = 0; offset < 3; offset++) {
      const hIdx = idx1h - offset;
      if (hIdx < 1) break;
      if (isInvalidatedLong(hIdx)) continue; // skip this candle, check older ones
      if (isSetupLongCandle(hIdx)) {
        setupArmedLong = true;
        break;
      }
    }

    let setupArmedShort = false;
    for (let offset = 0; offset < 3; offset++) {
      const hIdx = idx1h - offset;
      if (hIdx < 1) break;
      if (isInvalidatedShort(hIdx)) continue; // skip this candle, check older ones
      if (isSetupShortCandle(hIdx)) {
        setupArmedShort = true;
        break;
      }
    }

    // ── LAYER 3: Trigger Timeframe Indicators ──────────────────────────
    const bbIdx = i - 19;
    const bb = bbIdx >= 0 && bbIdx < bbSeries5m.length ? bbSeries5m[bbIdx] : null;
    if (!bb) { neutrals++; continue; }

    const vwap5m = vwapSeries5m[i];
    const ema9Val = ema9_5m[i];
    const ema21Val = ema21_5m[i];
    const rsi5m = rsiSeries5m[i];
    const atr5m = atrSeries5m[i];
    const volCurr5m = vol5m[i];
    
    // Seasonal Volume RVOL
    const volAvg5m = calculateTimeOfDayVolumeAvg(klines5m, i, 20);

    if (isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema21Val) || isNaN(rsi5m) || isNaN(atr5m)) {
      neutrals++; continue;
    }

    // Bollinger Band Width Squeeze (20th percentile)
    const last100Widths = bbWidth5m.slice(Math.max(0, bbIdx - 100), bbIdx + 1).filter(v => !isNaN(v)).sort((a, b) => a - b);
    const p20BBWidth = last100Widths.length > 0 ? last100Widths[Math.floor(last100Widths.length * 0.2)] : 0;
    const last20Widths = bbWidth5m.slice(Math.max(0, bbIdx - 20), bbIdx + 1);
    const squeezePrev = last20Widths.some(w => w < p20BBWidth);

    // ── TRIGGERS ─────────────────────────────────────────────────────────
    
    // Helper to check for a breakout at any historical index in backtester
    const checkBreakoutAtIdx = (idx: number, dir: 'LONG' | 'SHORT') => {
      if (idx < 20 || idx >= klines5m.length) return false;
      const k = klines5m[idx];
      const prevK = klines5m[idx - 1];
      const bbIndex = idx - 19;
      const b = bbIndex >= 0 && bbIndex < bbSeries5m.length ? bbSeries5m[bbIndex] : null;
      const prevB = (bbIndex - 1) >= 0 && (bbIndex - 1) < bbSeries5m.length ? bbSeries5m[bbIndex - 1] : null;
      const rsi = rsiSeries5m[idx];
      const vw = vwapSeries5m[idx];
      const rvol = k.volume / (volSma5m[idx] || 1);

      if (!b || !prevB || isNaN(rsi) || isNaN(vw)) return false;

      if (dir === 'LONG') {
        const gateVWAP = k.close > vw;
        const gateBreakout = k.close > b.upper && prevK.close <= prevB.upper;
        const gateVol = rvol >= 1.5;
        const gateRSI = rsi > 50 && rsi < 75;
        return gateVWAP && gateBreakout && gateVol && gateRSI;
      } else {
        const gateVWAP = k.close < vw;
        const gateBreakout = k.close < b.lower && prevK.close >= prevB.lower;
        const gateVol = rvol >= 1.8; // VCME v2.0 Asymmetry: 1.8x for SHORT
        const gateRSI = rsi < 50 && rsi > 25;
        return gateVWAP && gateBreakout && gateVol && gateRSI;
      }
    };

    // A. Pullback Trigger (Solo agresivo)
    const hasPullbackLong = (idx: number) => {
      if (idx < oldestEvalIdx) return false;
      const low = klines5m[idx].low;
      const e9 = ema9_5m[idx];
      const e21 = ema21_5m[idx];
      const vw = vwapSeries5m[idx];
      let swingLow10 = Infinity;
      for (let s = idx - 10; s < idx; s++) {
        if (klines5m[s].low < swingLow10) swingLow10 = klines5m[s].low;
      }
      return low <= Math.max(e9, e21, vw) && low > swingLow10;
    };

    const hasPullbackShort = (idx: number) => {
      if (idx < oldestEvalIdx) return false;
      const high = klines5m[idx].high;
      const e9 = ema9_5m[idx];
      const e21 = ema21_5m[idx];
      const vw = vwapSeries5m[idx];
      let swingHigh10 = -Infinity;
      for (let s = idx - 10; s < idx; s++) {
        if (klines5m[s].high > swingHigh10) swingHigh10 = klines5m[s].high;
      }
      return high >= Math.min(e9, e21, vw) && high < swingHigh10;
    };

    const maxPrevHigh3 = Math.max(klines5m[i - 1].high, klines5m[i - 2].high, klines5m[i - 3].high);
    const condPullbackLong = triggerMode === 'agresivo' &&
                             (hasPullbackLong(i) || hasPullbackLong(i - 1) || hasPullbackLong(i - 2)) &&
                             curr.close > maxPrevHigh3 &&
                             curr.close > curr.open &&
                             volCurr5m / volAvg5m >= 1.5 &&
                             curr.close > vwap5m;

    const minPrevLow3 = Math.min(klines5m[i - 1].low, klines5m[i - 2].low, klines5m[i - 3].low);
    const condPullbackShort = triggerMode === 'agresivo' &&
                              (hasPullbackShort(i) || hasPullbackShort(i - 1) || hasPullbackShort(i - 2)) &&
                              curr.close < minPrevLow3 &&
                              curr.close < curr.open &&
                              volCurr5m / volAvg5m >= 1.8 &&
                              curr.close < vwap5m;

    // B. Breakout Trigger
    let condBreakoutLong = false;
    let condBreakoutShort = false;

    if (triggerMode === 'conservador') {
      let recentBreakoutIdx = -1;
      for (let offset = 1; offset <= 5; offset++) {
        const idx = i - offset;
        if (checkBreakoutAtIdx(idx, 'LONG')) {
          recentBreakoutIdx = idx;
          break;
        }
      }

      if (recentBreakoutIdx !== -1) {
        const breakoutBB = bbSeries5m[recentBreakoutIdx - 19];
        if (breakoutBB) {
          const level = breakoutBB.upper;
          const retestSostenido = curr.low >= level * 0.998 && curr.close > level;
          if (retestSostenido) {
            condBreakoutLong = true;
          }
        }
      }

      let recentBreakdownIdx = -1;
      for (let offset = 1; offset <= 5; offset++) {
        const idx = i - offset;
        if (checkBreakoutAtIdx(idx, 'SHORT')) {
          recentBreakdownIdx = idx;
          break;
        }
      }

      if (recentBreakdownIdx !== -1) {
        const breakdownBB = bbSeries5m[recentBreakdownIdx - 19];
        if (breakdownBB) {
          const level = breakdownBB.lower;
          const retestSostenido = curr.high <= level * 1.002 && curr.close < level;
          if (retestSostenido) {
            condBreakoutShort = true;
          }
        }
      }
    } else {
      const orb = getOpeningRange(klines5m, i, style === 'swing' ? '1h' : '5m', symbol);
      const prevOrb = getOpeningRange(klines5m, i - 1, style === 'swing' ? '1h' : '5m', symbol);

      const breakoutLongPrev = prevOrb.isActive &&
                               prev.close > prevOrb.high + 0.10 * atrSeries5m[i - 1] &&
                               bbIdx > 0 && prev.close > bbSeries5m[bbIdx - 1].upper &&
                               (vol5m[i - 1] / volSma5m[i - 1]) >= 1.5 &&
                               (prev.close - bbSeries5m[bbIdx - 1].upper) <= 1.0 * atrSeries5m[i - 1];

      // Bug #1 fix: changed curr.low > orb.high to curr.close > orb.high.
      // Requiring the candle LOW to be above the ORB is nearly impossible in practice.
      condBreakoutLong = squeezePrev && breakoutLongPrev && curr.close > orb.high;

      const breakoutShortPrev = prevOrb.isActive &&
                                prev.close < prevOrb.low - 0.10 * atrSeries5m[i - 1] &&
                                bbIdx > 0 && prev.close < bbSeries5m[bbIdx - 1].lower &&
                                (vol5m[i - 1] / volSma5m[i - 1]) >= 1.8 &&
                                (bbSeries5m[bbIdx - 1].lower - prev.close) <= 1.0 * atrSeries5m[i - 1];

      // Bug #1 fix (symmetric): changed curr.high < orb.low to curr.close < orb.low.
      condBreakoutShort = squeezePrev && breakoutShortPrev && curr.close < orb.low;
    }

    // C. Mean Reversion Trigger
    const condMRLong = bias1D === 'NEUTRAL' &&
                       curr.close < bb.lower &&
                       rsi5m < 25 &&
                       checkBullishDivergence(klines5m, rsiSeries5m, i, 10) &&
                       curr.close > curr.open;

    const condMRShort = bias1D === 'NEUTRAL' &&
                        curr.close > bb.upper &&
                        rsi5m > 75 &&
                        checkBearishDivergence(klines5m, rsiSeries5m, i, 10) &&
                        curr.close < curr.open;

    // ── QUALITY FILTERS & VCME v2.0 CONFIDENCE SCORE ─────────────────────
    const minutesSinceOpen = (() => {
      const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
      if (isCrypto) return 60;
      let sessionStartIdx = i;
      const currentSession = getSessionId(curr, style === 'swing' ? '1h' : '5m', symbol);
      while (sessionStartIdx > 0 && getSessionId(klines5m[sessionStartIdx - 1], style === 'swing' ? '1h' : '5m', symbol) === currentSession) {
        sessionStartIdx--;
      }
      const unitMinutes = style === 'swing' ? 60 : 5;
      return (i - sessionStartIdx + (style === 'swing' ? 1 : 0)) * unitMinutes;
    })();

    const rvol = volAvg5m > 0 ? volCurr5m / volAvg5m : 1.0;
    const candleRange = curr.high - curr.low;
    const strengthCandleLong = candleRange > 0 ? (curr.close > curr.open) && ((curr.close - curr.low) > 0.60 * candleRange) : false;
    const strengthCandleShort = candleRange > 0 ? (curr.close < curr.open) && ((curr.high - curr.close) > 0.60 * candleRange) : false;

    const qualityLong = (curr.close - vwap5m) <= 2.0 * atr5m &&
                        candleBodyRatio(curr) >= 0.3 &&
                        strengthCandleLong &&
                        upperWickRatio(curr) <= 0.35 &&
                        minutesSinceOpen >= 5 &&
                        rvol < 8.0;

    const qualityShort = (vwap5m - curr.close) <= 2.0 * atr5m &&
                         candleBodyRatio(curr) >= 0.3 &&
                         strengthCandleShort &&
                         lowerWickRatio(curr) <= 0.35 &&
                         minutesSinceOpen >= 5 &&
                         rvol < 8.0;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    const triggerLong = (setupArmedLong && (condPullbackLong || condBreakoutLong)) && qualityLong;
    const triggerShort = (setupArmedShort && (condPullbackShort || condBreakoutShort)) && qualityShort;

    const triggerMRLong = condMRLong && qualityLong;
    const triggerMRShort = condMRShort && qualityShort;

    if (triggerLong || triggerMRLong) {
      signal = 'BUY';
    } else if (triggerShort || triggerMRShort) {
      signal = 'SELL';
    }

    // VCME v2.0 Continuous Confidence Score (0.0 to 1.0)
    const volScore = 0.30 * Math.min(rvol / 2.0, 1.0);
    const macroScore = 0.25 * (signal === 'BUY' ? (lastClose1d > lastEma200_1d ? 1 : 0) : (lastClose1d < lastEma200_1d ? 1 : 0));
    const macdScore = 0.20 * (signal === 'BUY' ? (macdHist1h > 0 ? 1 : 0) : (macdHist1h < 0 ? 1 : 0));
    const distScore = 0.15 * Math.min(Math.abs(curr.close - ema21Val) / (atr5m || 1), 1.0);
    const vwapScore = 0.10 * (signal === 'BUY' ? (curr.close > vwap5m ? 1 : 0) : (curr.close < vwap5m ? 1 : 0));
    const confidenceScore = Number((volScore + macroScore + macdScore + distScore + vwapScore).toFixed(2));

    if (signal !== 'NEUTRAL' && confidenceScore < 0.65) {
      signal = 'NEUTRAL';
    }

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    // Trade Type classification (DAY vs SWING)
    let tradeType: 'DAY' | 'SWING' = 'DAY';
    if (lastAdx1d > 30) {
      if ((signal === 'BUY' && macdHist1h > macdHistPrev1h) ||
          (signal === 'SELL' && macdHist1h < macdHistPrev1h)) {
        tradeType = 'SWING';
      }
    }

    // ── RISK & POSITION CONFIG (VCME v2.0 Asymmetric SL) ──────────────────
    const entry = i + 1 < klines5m.length ? klines5m[i + 1].open : curr.close;
    let stopLoss = 0;
    
    const lookbackS = Math.max(0, i - (tradeType === 'SWING' ? 5 : 10));
    let swingLow = Infinity;
    let swingHigh = -Infinity;
    for (let s = lookbackS; s < i; s++) {
      if (klines5m[s].low < swingLow) swingLow = klines5m[s].low;
      if (klines5m[s].high > swingHigh) swingHigh = klines5m[s].high;
    }

    const atrMultLong = 1.5;
    const atrMultShort = 1.8;
    const tp1Mult = 2.0;
    const tp2Mult = 3.5;
    const tp3Mult = 5.0;

    if (signal === 'BUY') {
      const slATR = entry - atrMultLong * atr5m;
      const slStruct = swingLow > 0 ? (swingLow - 0.20 * atr5m) : slATR;
      stopLoss = Math.min(slATR, slStruct);
      let risk = entry - stopLoss;
      if (risk <= 0) {
        neutrals++;
        continue;
      }
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry - minRisk;
        risk = minRisk;
      }

      const riskPercent = risk / entry;
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        neutrals++;
        continue;
      }
    } else {
      const slATR = entry + atrMultShort * atr5m;
      const slStruct = swingHigh > 0 ? (swingHigh + 0.20 * atr5m) : slATR;
      stopLoss = Math.max(slATR, slStruct);
      let risk = stopLoss - entry;
      if (risk <= 0) {
        neutrals++;
        continue;
      }
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry + minRisk;
        risk = minRisk;
      }

      const riskPercent = risk / entry;
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        neutrals++;
        continue;
      }
    }

    const risk = Math.abs(entry - stopLoss);
    const tp1 = signal === 'BUY' ? entry + risk * tp1Mult : entry - risk * tp1Mult;
    const tp2 = signal === 'BUY' ? entry + risk * tp2Mult : entry - risk * tp2Mult;
    const tp3 = signal === 'BUY' ? entry + risk * tp3Mult : entry - risk * tp3Mult;

    totalSignals++;

    // ── Simulate Multi-Target position ───────────────────────────────────
    let pnlPct = 0;
    let tradeOutcome: 'win' | 'loss' | 'timeout' = 'timeout';
    let exitIdx = i;
    
    let tp1Hit = false;
    let tp2Hit = false;
    let activeSL = stopLoss;
    let highestHigh = entry;
    let lowestLow = entry;

    for (let f = i + 1; f <= i + forwardWindow && f < klines5m.length; f++) {
      const k = klines5m[f];

      if (isSessionBased && f > i + 1) {
        const gap = klines5m[f].time - klines5m[f - 1].time;
        const expectedGapSec = tf === '5m' ? 300 : 3600;
        if (gap > expectedGapSec * 3) {
          // Intraday EOD exit before overnight session gap
          const exitPrice = klines5m[f - 1].close;
          const tp1P = tp1Hit ? 0.50 * (signal === 'BUY' ? (tp1 - entry) / entry * 100 : (entry - tp1) / entry * 100) : 0;
          const tp2P = tp2Hit ? 0.25 * (signal === 'BUY' ? (tp2 - entry) / entry * 100 : (entry - tp2) / entry * 100) : 0;
          const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit ? 0.25 : 0);
          const openPortionPnl = signal === 'BUY' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
          pnlPct = tp1P + tp2P + leftWeight * openPortionPnl;
          tradeOutcome = 'timeout';
          exitIdx = f - 1;
          break;
        }
      }

      if (k.high > highestHigh) highestHigh = k.high;
      if (k.low < lowestLow) lowestLow = k.low;

      const isLongEmergency = k.close < vwapSeries5m[f] && k.close < ema21_5m[f];
      const isShortEmergency = k.close > vwapSeries5m[f] && k.close > ema21_5m[f];

      if (signal === 'BUY') {
        // SL check
        if (k.low <= activeSL) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.25 * ((tp2 - entry) / entry * 100);
            const tp3P = 0.25 * ((activeSL - entry) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((tp1 - entry) / entry * 100);
            pnlPct = tp1P;
            tradeOutcome = 'win';
          } else {
            pnlPct = -risk / entry * 100;
            tradeOutcome = 'loss';
          }
          exitIdx = f;
          break;
        }

        // Time Stop for DAY trades: 8 candles (40 min)
        if (tradeType === 'DAY' && !tp1Hit && (f - i) >= 8) {
          const currentPnl = k.close - entry;
          if (currentPnl < 0.5 * risk) {
            pnlPct = (currentPnl / entry) * 100;
            tradeOutcome = 'timeout';
            exitIdx = f;
            break;
          }
        }

        if (isLongEmergency) {
          const tp1P = tp1Hit ? 0.50 * ((tp1 - entry) / entry * 100) : 0;
          const tp2P = tp2Hit ? 0.25 * ((tp2 - entry) / entry * 100) : 0;
          const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit ? 0.25 : 0);
          pnlPct = tp1P + tp2P + leftWeight * ((k.close - entry) / entry * 100);
          tradeOutcome = 'timeout';
          exitIdx = f;
          break;
        }

        // Target 1
        if (!tp1Hit && k.high >= tp1) {
          tp1Hit = true;
          activeSL = entry;
        }

        // Target 2
        if (tp1Hit && !tp2Hit && k.high >= tp2) {
          tp2Hit = true;
        }

        // Target 3: Trailing exit with Chandelier (highestHigh - 2.5 * ATR) or EMA 9
        if (tp2Hit) {
          const chandelierSL = highestHigh - 2.5 * atrSeries5m[f];
          const ema9Valf = ema9_5m[f];
          
          if (k.close <= chandelierSL || (!isNaN(ema9Valf) && k.close < ema9Valf)) {
            const tp1P = 0.50 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.25 * ((tp2 - entry) / entry * 100);
            const tp3P = 0.25 * ((k.close - entry) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          } else if (k.high >= tp3) {
            const tp1P = 0.50 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.25 * ((tp2 - entry) / entry * 100);
            const tp3P = 0.25 * ((tp3 - entry) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          }
        }
      } else {
        // SHORT
        if (k.high >= activeSL) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((entry - tp1) / entry * 100);
            const tp2P = 0.25 * ((entry - tp2) / entry * 100);
            const tp3P = 0.25 * ((entry - activeSL) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((entry - tp1) / entry * 100);
            pnlPct = tp1P;
            tradeOutcome = 'win';
          } else {
            pnlPct = -risk / entry * 100;
            tradeOutcome = 'loss';
          }
          exitIdx = f;
          break;
        }

        // Time Stop for DAY trades: 8 candles (40 min)
        if (tradeType === 'DAY' && !tp1Hit && (f - i) >= 8) {
          const currentPnl = entry - k.close;
          if (currentPnl < 0.5 * risk) {
            pnlPct = (currentPnl / entry) * 100;
            tradeOutcome = 'timeout';
            exitIdx = f;
            break;
          }
        }

        if (isShortEmergency) {
          const tp1P = tp1Hit ? 0.50 * ((entry - tp1) / entry * 100) : 0;
          const tp2P = tp2Hit ? 0.25 * ((entry - tp2) / entry * 100) : 0;
          const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit ? 0.25 : 0);
          pnlPct = tp1P + tp2P + leftWeight * ((entry - k.close) / entry * 100);
          tradeOutcome = 'timeout';
          exitIdx = f;
          break;
        }

        if (!tp1Hit && k.low <= tp1) {
          tp1Hit = true;
          activeSL = entry;
        }

        if (tp1Hit && !tp2Hit && k.low <= tp2) {
          tp2Hit = true;
        }

        if (tp2Hit) {
          const chandelierSL = lowestLow + 2.5 * atrSeries5m[f];
          const ema9Valf = ema9_5m[f];

          if (k.close >= chandelierSL || (!isNaN(ema9Valf) && k.close > ema9Valf)) {
            const tp1P = 0.50 * ((entry - tp1) / entry * 100);
            const tp2P = 0.25 * ((entry - tp2) / entry * 100);
            const tp3P = 0.25 * ((entry - k.close) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          } else if (k.low <= tp3) {
            const tp1P = 0.50 * ((entry - tp1) / entry * 100);
            const tp2P = 0.25 * ((entry - tp2) / entry * 100);
            const tp3P = 0.25 * ((entry - tp3) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          }
        }
      }
    }

    if (tradeOutcome === 'timeout' && pnlPct === 0) {
      const lastIdx = Math.min(i + forwardWindow, klines5m.length - 1);
      const exitPrice = klines5m[lastIdx].close;
      const tp1P = tp1Hit ? 0.50 * (signal === 'BUY' ? (tp1 - entry) / entry * 100 : (entry - tp1) / entry * 100) : 0;
      const tp2P = tp2Hit ? 0.25 * (signal === 'BUY' ? (tp2 - entry) / entry * 100 : (entry - tp2) / entry * 100) : 0;
      const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit ? 0.25 : 0);
      const openPortionPnl = signal === 'BUY' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
      pnlPct = tp1P + tp2P + leftWeight * openPortionPnl;
      exitIdx = lastIdx;
    }

    const frictionPct = 0.08;
    pnlPct -= frictionPct;

    if (tradeOutcome === 'win') {
      wins++;
      totalGainPct += Math.max(0, pnlPct);
    } else if (tradeOutcome === 'loss') {
      losses++;
      totalLossPct += Math.abs(pnlPct);
    } else {
      timeouts++;
      if (pnlPct > 0) {
        totalGainPct += pnlPct;
      } else if (pnlPct < 0) {
        totalLossPct += Math.abs(pnlPct);
      }
    }

    nextAllowedIdx = exitIdx + cooldownPeriod;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? totalGainPct / totalLossPct : (totalGainPct > 0 ? 99.9 : 0);

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor: Number(profitFactor === Infinity ? 99.9 : profitFactor.toFixed(2)),
    expectancy: Number(expectancy.toFixed(3)),
    neutrals,
    label: `últimas ${actualWindow} velas (${style === 'swing' ? '1h' : '5m'})`,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '24 hs max (Intradía)',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: style === 'swing' ? 2.0 : 1.5,
    insufficient: false
  };

  return setBacktestCache(cacheKey, klines5m, res, [klines1h, klines1d]);
}

// ==========================================
// SUPPORT OPTIMIZED BACKTEST CORE
// ==========================================

function runBacktestGenericOptimized(
  klines: Kline[],
  interval: string,
  signals: ('BUY' | 'SELL' | 'NEUTRAL')[]
): BacktestResult {
  const params = getParams(interval);
  const { evalWindow, forwardWindow, forwardLabel, targetMultiplier } = params;

  // Use the ATR available at each entry. Applying today's ATR to historical trades
  // leaks future volatility into the result.
  const atrSeries = calculateATRSeries(klines, 14);
  const latestAtr = atrSeries[atrSeries.length - 1];
  const threshold = getAdaptiveThreshold(latestAtr, klines[klines.length - 1].close, params.atrMultiplier, params.fallbackThreshold);
  const targetThreshold = threshold * targetMultiplier;

  const minCandles = evalWindow + forwardWindow;
  if (klines.length < minCandles) {
    return {
      totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
      winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
      neutrals: 0,
      label: `datos insuficientes (${klines.length} velas)`,
      forwardLabel,
      threshold,
      targetThreshold,
      targetMultiplier,
      insufficient: true,
    };
  }

  const isSessionBased = hasSessionGaps(klines, interval);
  const latestEvalIdx = klines.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(0, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins         = 0;
  let losses       = 0;
  let timeouts     = 0;
  let neutrals     = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;

  let nextAllowedIdx = 0;

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      neutrals++;
      continue;
    }

    if (isSessionBased && (interval === '5m' || interval === '1h')) {
      if (isNearSessionEnd(klines, i, interval, forwardWindow)) {
        neutrals++;
        continue;
      }
    }

    const signal = signals[i] || 'NEUTRAL';

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    const entryThreshold = getAdaptiveThreshold(
      atrSeries[i],
      klines[i].close,
      params.atrMultiplier,
      params.fallbackThreshold
    );
    const entryTargetThreshold = entryThreshold * targetMultiplier;

    totalSignals++;
    const outcome = evaluateOutcome(klines, i, signal, forwardWindow, entryThreshold, entryTargetThreshold);

    if (outcome.result === 'win') {
      wins++;
      totalGainPct += outcome.pnlPct;
    } else if (outcome.result === 'loss') {
      losses++;
      totalLossPct += Math.abs(outcome.pnlPct);
    } else {
      timeouts++;
      if (outcome.pnlPct > 0) {
        totalGainPct += outcome.pnlPct;
      } else if (outcome.pnlPct < 0) {
        totalLossPct += Math.abs(outcome.pnlPct);
      }
    }

    nextAllowedIdx = i + forwardWindow + 1;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? totalGainPct / totalLossPct : (totalGainPct > 0 ? Infinity : 0);

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;

  return {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor: Number(profitFactor === Infinity ? 99.9 : profitFactor.toFixed(2)),
    expectancy: Number(expectancy.toFixed(3)),
    neutrals,
    label: `últimas ${actualWindow} velas`,
    forwardLabel,
    threshold,
    targetThreshold,
    targetMultiplier,
    insufficient: false,
  };
}

export function computeStandardSignalsSeries(klines: Kline[]): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines.length;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 35) return signals;

  const closes = klines.map(k => k.close);

  const rsiSeries = calculateRSISeries(closes);
  const macdData = calculateMACDSeries(closes);
  const bbSeries = calculateBollingerBandsSeries(klines);
  const stSeries = calculateSupertrendSeries(klines);
  const stochRsiData = calculateStochRSISeries(closes);
  const volData = calculateVolumeSignalSeries(klines);
  const ema200 = calculateEMA(closes, 200);

  // Pre-compute RVOL series (sliding 20-bar volume average) for B1 fix
  const rvolSeries: number[] = new Array(length).fill(0);
  let volSumRvol = 0;
  for (let v = 0; v < Math.min(20, length); v++) volSumRvol += klines[v].volume;
  for (let v = 20; v < length; v++) {
    const avgV = volSumRvol / 20;
    rvolSeries[v] = avgV > 0 ? klines[v].volume / avgV : 0;
    volSumRvol = volSumRvol - klines[v - 20].volume + klines[v].volume;
  }

  for (let i = 34; i < length; i++) {
    const rsiVal = rsiSeries[i];
    const rsiSig = rsiVal < 30 ? 'BUY' : rsiVal > 70 ? 'SELL' : 'NEUTRAL';

    const macdSig = macdData.signals[i] || 'NEUTRAL';

    let bbSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if (i >= 19) {
      const bbItem = bbSeries[i - 19];
      if (bbItem) {
        if (closes[i] < bbItem.lower) bbSig = 'BUY';
        if (closes[i] > bbItem.upper) bbSig = 'SELL';
      }
    }

    let stSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    const flipLookback = 3;
    let recentFlip = false;
    for (let offset = 0; offset < flipLookback; offset++) {
      const idxCurr = i - offset;
      const idxPrev = idxCurr - 1;
      if (idxPrev < 9) break;
      if (stSeries[idxCurr].direction !== stSeries[idxPrev].direction) {
        recentFlip = true;
        break;
      }
    }
    if (recentFlip) {
      stSig = stSeries[i].direction === 'UP' ? 'BUY' : 'SELL';
    }

    const stochRsiSig = stochRsiData.signals[i] || 'NEUTRAL';
    const volSig = volData.signals[i] || 'NEUTRAL';

    let buyVotes = 0;
    let sellVotes = 0;

    const sigs = [rsiSig, macdSig, bbSig, stSig, stochRsiSig, volSig];
    sigs.forEach(s => {
      if (s === 'BUY') buyVotes++;
      if (s === 'SELL') sellVotes++;
    });

    let rawSignal = 'NEUTRAL';
    if (buyVotes >= 3 && sellVotes === 0) {
      rawSignal = 'STRONG BUY';
    } else if (buyVotes > sellVotes) {
      rawSignal = 'BUY';
    } else if (sellVotes >= 3 && buyVotes === 0) {
      rawSignal = 'STRONG SELL';
    } else if (sellVotes > buyVotes) {
      rawSignal = 'SELL';
    }

    // RVOL filter matching UI logic (B1 fix): asymmetric thresholds + weak consensus penalty
    if (rawSignal !== 'NEUTRAL' && i >= 20) {
      const rvol = rvolSeries[i];
      const rvolThreshold = rawSignal.includes('BUY') ? 0.9 : 0.6;
      const voteMargin = Math.abs(buyVotes - sellVotes);
      const effectiveRvolThreshold = voteMargin < 2 ? Math.max(rvolThreshold, 1.1) : rvolThreshold;
      if (rvol < effectiveRvolThreshold) {
        rawSignal = 'NEUTRAL';
      }
    }

    let finalSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if (rawSignal.includes('BUY')) finalSig = 'BUY';
    if (rawSignal.includes('SELL')) finalSig = 'SELL';

    const emaVal = ema200[i];
    if (!isNaN(emaVal)) {
      const trend = closes[i] > emaVal ? 'UP' : 'DOWN';
      if (trend === 'UP' && finalSig === 'SELL') finalSig = 'NEUTRAL';
      if (trend === 'DOWN' && finalSig === 'BUY') finalSig = 'NEUTRAL';
    }

    // Sync fix: closePosition filter added to match live calculateStandardVoting
    if (finalSig !== 'NEUTRAL') {
      const cp = closePosition(klines[i]);
      if (finalSig === 'BUY'  && cp < 0.45) finalSig = 'NEUTRAL';
      if (finalSig === 'SELL' && cp > 0.55) finalSig = 'NEUTRAL';
    }

    signals[i] = finalSig;
  }

  return signals;
}

export function computeConfluenciaSignalsSeries(klines: Kline[], interval: string = '1h'): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines.length;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 21) return signals;

  const closes = klines.map(k => k.close);

  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  const vwap = calculateVWAPSeries(klines, interval);
  // Sync fix: ATR series needed for anti-chasing filter (mirrors live calculateExperimentalSignal)
  const atrSeries = calculateATRSeries(klines, 14);

  const volSMA = new Array(length).fill(0);
  let sumVol = 0;
  for (let i = 0; i < 20; i++) {
    sumVol += klines[i].volume;
  }
  volSMA[19] = sumVol / 20;
  for (let i = 20; i < length; i++) {
    sumVol = sumVol - klines[i - 20].volume + klines[i].volume;
    volSMA[i] = sumVol / 20;
  }

  for (let i = 20; i < length; i++) {
    const curr = klines[i];
    const prev = klines[i - 1];

    const hammer = isHammer(curr);
    const engulf = isEngulfing(curr, prev);
    const bRatio = candleBodyRatio(curr);

    const e9 = ema9[i];
    const e20 = ema20[i];
    const vw = vwap[i];
    const vAvg = volSMA[i];
    const atr = atrSeries[i];

    // Sync fix: anti-chasing and closePosition filters added to match live signal
    const cp = closePosition(curr);
    const distVwapAtr = atr > 0 ? Math.abs(curr.close - vw) / atr : 0;
    const isNotOverextended = distVwapAtr <= 2.2;

    const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > e9;
    const bullish_candle = hammer || engulf === 1 || strongBullish;
    const bearish_candle = engulf === -1;

    const is_buy  = curr.close > vw && e9 > e20 && curr.volume >= vAvg * 0.8
                    && bullish_candle && bRatio >= 0.3 && isNotOverextended && cp >= 0.50;
    const is_sell = curr.close < vw && e9 < e20 && curr.volume >= vAvg * 0.8
                    && (bearish_candle || curr.close < e20) && bRatio >= 0.3 && isNotOverextended && cp <= 0.50;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if (is_buy) signal = 'BUY';
    else if (is_sell) signal = 'SELL';

    signals[i] = signal;
  }

  return signals;
}

const SCORING_CONFIG: Record<string, {
  emaFast: number;
  emaSlow: number;
  emaMajor: number | null;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  bbPeriod: number;
  useVwap: boolean;
  useObv: boolean;
}> = {
  '5m': { emaFast: 9, emaSlow: 21, emaMajor: null,  rsiPeriod: 7,  rsiOversold: 35, rsiOverbought: 65, bbPeriod: 20, useVwap: true,  useObv: false },
  '1h': { emaFast: 9, emaSlow: 21, emaMajor: 50,    rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65, bbPeriod: 20, useVwap: true,  useObv: false },
  '1d': { emaFast: 9, emaSlow: 21, emaMajor: 50,    rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, bbPeriod: 20, useVwap: false, useObv: true  },
};

export function computeScoringSignalsSeries(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines.length;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 60) return signals;

  const cfg = SCORING_CONFIG[interval] ?? SCORING_CONFIG['1h'];
  const closes = klines.map(k => k.close);

  const emaFastArr = calculateEMA(closes, cfg.emaFast);
  const emaSlowArr = calculateEMA(closes, cfg.emaSlow);
  const emaMajorArr = cfg.emaMajor ? calculateEMA(closes, cfg.emaMajor) : new Array(length).fill(NaN);
  const rsiSeries = calculateRSISeries(closes, cfg.rsiPeriod);
  const bbSeries = calculateBollingerBandsSeries(klines, cfg.bbPeriod);
  const vwapSeries = cfg.useVwap ? calculateVWAPSeries(klines, interval) : new Array(length).fill(0);
  const atrSeries = calculateATRSeries(klines, 14);

  let obvArr: number[] = [];
  let obvEMAArr: number[] = [];
  if (cfg.useObv) {
    obvArr = [0];
    for (let i = 1; i < length; i++) {
      if (closes[i] > closes[i - 1])      obvArr.push(obvArr[i - 1] + klines[i].volume);
      else if (closes[i] < closes[i - 1]) obvArr.push(obvArr[i - 1] - klines[i].volume);
      else                                obvArr.push(obvArr[i - 1]);
    }
    obvEMAArr = calculateEMA(obvArr, 10);
  }

  // Cache at aligned checkpoints. Queries use the most recent checkpoint at or
  // before the evaluated candle, so no future price data enters the S/R layer.
  const srCacheInterval = 1;
  const srCache: Map<number, { nearestSupport: number; nearestResistance: number }> = new Map();
  for (let idx = 0; idx < length; idx += srCacheInterval) {
    const windowStart = Math.max(0, idx - 100);
    const windowSlice = klines.slice(windowStart, idx + 1);
    const sr = calculateSupportResistance(windowSlice, klines[idx].close);
    srCache.set(idx, { nearestSupport: sr.nearestSupport, nearestResistance: sr.nearestResistance });
  }
  const getCachedSR = (idx: number) => {
    const cacheIdx = Math.floor(idx / srCacheInterval) * srCacheInterval;
    return srCache.get(cacheIdx) || { nearestSupport: 0, nearestResistance: 0 };
  };

  for (let i = 59; i < length; i++) {
    const curr = klines[i];
    const closeVal = closes[i];

    const ef = emaFastArr[i];
    const es = emaSlowArr[i];
    const em = emaMajorArr[i];

    let s1 = 0;
    if (ef > es)      s1 += 1;
    else if (ef < es) s1 -= 1;

    if (cfg.emaMajor && !isNaN(em)) {
      if (closeVal > em) s1 += 1;
      else               s1 -= 1;
    }

    const rsi = rsiSeries[i];
    const rsiSlopeVal = calculateRSISlope(rsiSeries, i, 3);
    let s2 = 0;
    if      (rsi < cfg.rsiOversold)   s2 += 1;
    else if (rsi > cfg.rsiOverbought) s2 -= 1;
    else if (rsi > 50) {
      // Sync fix: >= 0 matches live (slope flat = no momentum decay above 50, still bullish)
      if (rsiSlopeVal >= 0)           s2 += 1;
    } else {
      // Sync fix: changed <= 0 to < 0 to match live signal.
      // In the live version, slope=0 (flat) when RSI < 50 does NOT apply -1.
      // Only a clearly falling slope (< 0) is bearish.
      if (rsiSlopeVal < 0)            s2 -= 1;
    }

    let s3 = 0;
    const bbIdx = i - (cfg.bbPeriod - 1);
    const bb = bbSeries[bbIdx];
    if (bb) {
      const bandWidth = bb.upper - bb.lower;
      const pctB = bandWidth > 0 ? (closeVal - bb.lower) / bandWidth : 0.5;
      if      (closeVal <= bb.lower) s3 += 1;
      else if (closeVal >= bb.upper) s3 -= 1;
      else if (pctB < 0.2)           s3 += 1;
      else if (pctB > 0.8)           s3 -= 1;
    }

    let s4 = 0;
    if (cfg.useVwap) {
      const vwap = vwapSeries[i];
      const atr = atrSeries[i];
      const isChasing = atr > 0 && Math.abs(closeVal - vwap) > 2.0 * atr;
      if (isChasing) {
        s4 -= 1;
      } else {
        if (closeVal > vwap) s4 += 1;
        else                 s4 -= 1;
      }
    } else if (cfg.useObv) {
      const obvLast = obvArr[i];
      const obvEMA = obvEMAArr[i];
      if (obvLast > obvEMA) s4 += 1;
      else                  s4 -= 1;
    }

    const body = curr.close - curr.open;
    const range = curr.high - curr.low;
    const pctBody = range > 0 ? Math.abs(body) / range : 0;
    const uWick = upperWickRatio(curr);
    const lWick = lowerWickRatio(curr);
    let s5 = 0;
    if (pctBody < 0.3) {
      s5 = 0;
    } else {
      if      (body > 0 && pctBody > 0.5) s5 += 1;
      else if (body > 0)                  s5 += 1;
      else if (body < 0 && pctBody > 0.5) s5 -= 1;
      else if (body < 0)                  s5 -= 1;

      if (body > 0 && uWick > 0.25) { s5 -= 0.5; }
      else if (body < 0 && lWick > 0.25) { s5 += 0.5; }
    }

    // Layer 6 - Structure (Support / Resistance)
    const sr = getCachedSR(i);
    let s6 = 0;
    if (sr.nearestSupport > 0 || sr.nearestResistance > 0) {
      const distSupport = sr.nearestSupport > 0 ? (closeVal - sr.nearestSupport) / closeVal : Infinity;
      const distResist = sr.nearestResistance > 0 ? (sr.nearestResistance - closeVal) / closeVal : Infinity;
      const nearThreshold = 0.015;
      if (distSupport >= 0 && distSupport < nearThreshold && distSupport <= distResist) {
        s6 += 1;
      } else if (distResist >= 0 && distResist < nearThreshold && distResist < distSupport) {
        s6 -= 1;
      }
    }

    const w1 = s1 * weights.trend;
    const w2 = s2 * weights.rsi;
    const w3 = s3 * weights.bollinger;
    const w4 = s4 * weights.volume;
    const w5 = s5 * weights.candle;
    const w6 = s6 * 1.0;
    const totalScore = w1 + w2 + w3 + w4 + w5 + w6;

    const maxTrend = cfg.emaMajor ? 2 : 1;
    const maxPossible = (maxTrend * weights.trend) + weights.rsi + weights.bollinger + weights.volume + weights.candle + 1.0;
    const threshold = maxPossible * 0.5;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if      (totalScore >=  threshold) signal = 'BUY';
    else if (totalScore <= -threshold) signal = 'SELL';

    // R:R Validation
    if (signal !== 'NEUTRAL') {
      const atr = atrSeries[i];
      if (atr > 0) {
        const slDist = 1.5 * atr;
        if (signal === 'BUY' && sr.nearestResistance > 0) {
          const rewardRoom = sr.nearestResistance - closeVal;
          if (rewardRoom > 0 && rewardRoom < slDist * 1.5) {
            signal = 'NEUTRAL';
          }
        } else if (signal === 'SELL' && sr.nearestSupport > 0) {
          const rewardRoom = closeVal - sr.nearestSupport;
          if (rewardRoom > 0 && rewardRoom < slDist * 1.5) {
            signal = 'NEUTRAL';
          }
        }
      }
    }

    signals[i] = signal;
  }

  return signals;
}

// ─── Multifractal MTF Backtester ──────────────────────────────────────────

export function backtestMultifractalMTF(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  _interval: string = '5m',
  _symbol: string = 'ASSET'
): BacktestResult {
  const cacheKey = `multifractal:${_symbol || 'any'}:${_interval}`;
  const cached = getBacktestCache(cacheKey, klines5m, [klines1h, klines1d]);
  if (cached) return cached;
  const evalWindow = 576;
  const forwardWindow = 12; // 12 candles in 5m = 1 hour forward window
  const cooldownPeriod = 12; // Must be >= forwardWindow to prevent overlapping trades

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
    neutrals: 0,
    label: `últimas 576 velas (5m)`,
    forwardLabel: '12 velas (1 hs max)',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true
  };

  if (!klines5m || klines5m.length < evalWindow + forwardWindow) return fallbackResult;

  const isSessionBased = hasSessionGaps(klines5m, '5m');

  const hasValid1H = klines1h && klines1h.length >= 20;
  const hasValid1D = klines1d && klines1d.length >= 14;

  const volBands1H = hasValid1H ? calculateRevolutionVolatilityBand(klines1h) : [];
  const andian1D = hasValid1D ? calculateAndianOscillator(klines1d) : [];

  const volBands5M = calculateRevolutionVolatilityBand(klines5m);
  const volComp5M = calculateVolumeComposition(klines5m);
  const dreadBlitz5M = calculateDreadBlitz(klines5m);

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let neutrals = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;
  let lastSignalIdx = -cooldownPeriod - 1;

  const latestEvalIdx = klines5m.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(20, latestEvalIdx - evalWindow + 1);

  const idx1hMap = new Int32Array(klines5m.length);
  if (hasValid1H) {
    let hPtr = 0;
    for (let i = 0; i < klines5m.length; i++) {
      const t = klines5m[i].time;
      while (hPtr < klines1h.length && klines1h[hPtr].time + 3600 <= t) {
        hPtr++;
      }
      idx1hMap[i] = hPtr - 1;
    }
  }

  const idx1dMap = new Int32Array(klines5m.length);
  if (hasValid1D) {
    let dPtr = 0;
    for (let i = 0; i < klines5m.length; i++) {
      const t = klines5m[i].time;
      while (dPtr < klines1d.length && klines1d[dPtr].time + 86400 <= t) {
        dPtr++;
      }
      idx1dMap[i] = dPtr - 1;
    }
  }

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i - lastSignalIdx < cooldownPeriod) {
      neutrals++;
      continue;
    }

    if (isSessionBased && isNearSessionEnd(klines5m, i, '5m', forwardWindow)) {
      neutrals++;
      continue;
    }

    const curr = klines5m[i];
    const prev = klines5m[i - 1];

    let isCompressed1H = false;
    if (hasValid1H && volBands1H.length > 0) {
      const idx1h = idx1hMap[i];
      if (idx1h >= 0) {
        const startH = Math.max(0, idx1h - 3);
        for (let h = startH; h <= idx1h; h++) {
          if (volBands1H[h] && volBands1H[h].isCompressed) {
            isCompressed1H = true;
            break;
          }
        }
      }
    }

    let bias1D: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (hasValid1D && andian1D.length > 0) {
      const idx1d = idx1dMap[i];
      if (idx1d >= 0 && andian1D[idx1d]) {
        bias1D = andian1D[idx1d].bias;
      }
    }

    const band5M = volBands5M[i];
    const volComp = volComp5M[i];
    const dread = dreadBlitz5M[i];
    const prevDread = dreadBlitz5M[i - 1] || dread;

    if (!band5M || !volComp || !dread) {
      neutrals++;
      continue;
    }

    const isNyseOpening = isNyseOpeningWindow(curr.time, _symbol);
    const minVolMultiplier = isNyseOpening ? 2.5 : 1.5;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    let stopLossPrice = 0;

    if (bias1D === 'BULLISH' && isCompressed1H && curr.close > band5M.upper && volComp.volumeMultiplier >= minVolMultiplier && volComp.activeBuyPercent >= 65) {
      signal = 'BUY';
      stopLossPrice = band5M.midpoint;
    } else if (bias1D === 'BEARISH' && isCompressed1H && curr.close < band5M.lower && volComp.volumeMultiplier >= minVolMultiplier && volComp.activeSellPercent >= 65) {
      signal = 'SELL';
      stopLossPrice = band5M.midpoint;
    } else if (dread.isOversold && curr.low < prev.low && dread.mcd > prevDread.mcd && volComp.isPassiveBuyAbsorption) {
      signal = 'BUY';
      stopLossPrice = curr.low - (band5M.upper - band5M.lower) * 0.25;
    } else if (dread.isOverbought && curr.high > prev.high && dread.mcd < prevDread.mcd && volComp.isPassiveSellAbsorption) {
      signal = 'SELL';
      stopLossPrice = curr.high + (band5M.upper - band5M.lower) * 0.25;
    }

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    totalSignals++;
    lastSignalIdx = i;

    // Realistic execution: entry at next open + 0.08% friction
    const nextIdx = i + 1 < klines5m.length ? i + 1 : i;
    const entryPrice = klines5m[nextIdx].open || curr.close;
    const frictionPct = 0.08;
    const risk = Math.abs(entryPrice - stopLossPrice);
    const takeProfitPrice = signal === 'BUY'
      ? entryPrice + risk * 1.5
      : entryPrice - risk * 1.5;

    let outcome: 'WIN' | 'LOSS' | 'TIMEOUT' = 'TIMEOUT';

    for (let f = 1; f <= forwardWindow; f++) {
      const fIdx = i + f;
      if (fIdx >= klines5m.length) break;
      const fCandle = klines5m[fIdx];

      if (f <= 3) {
        const fBand = volBands5M[fIdx];
        if (fBand) {
          if (signal === 'BUY' && fCandle.close < fBand.midpoint) {
            outcome = 'LOSS';
            const lossPct = Math.abs((fCandle.close - entryPrice) / entryPrice * 100) + frictionPct;
            totalLossPct += lossPct;
            break;
          } else if (signal === 'SELL' && fCandle.close > fBand.midpoint) {
            outcome = 'LOSS';
            const lossPct = Math.abs((entryPrice - fCandle.close) / entryPrice * 100) + frictionPct;
            totalLossPct += lossPct;
            break;
          }
        }
      }

      if (signal === 'BUY') {
        if (fCandle.low <= stopLossPrice) {
          outcome = 'LOSS';
          const lossPct = Math.abs((stopLossPrice - entryPrice) / entryPrice * 100) + frictionPct;
          totalLossPct += lossPct;
          break;
        }
        if (fCandle.high >= takeProfitPrice) {
          outcome = 'WIN';
          const gainPct = Math.abs((takeProfitPrice - entryPrice) / entryPrice * 100) - frictionPct;
          totalGainPct += Math.max(0, gainPct);
          break;
        }
      } else {
        if (fCandle.high >= stopLossPrice) {
          outcome = 'LOSS';
          const lossPct = Math.abs((entryPrice - stopLossPrice) / entryPrice * 100) + frictionPct;
          totalLossPct += lossPct;
          break;
        }
        if (fCandle.low <= takeProfitPrice) {
          outcome = 'WIN';
          const gainPct = Math.abs((entryPrice - takeProfitPrice) / entryPrice * 100) - frictionPct;
          totalGainPct += Math.max(0, gainPct);
          break;
        }
      }
    }

    if (outcome === 'WIN') {
      wins++;
    } else if (outcome === 'LOSS') {
      losses++;
    } else {
      timeouts++;
      const lastIdx = Math.min(i + forwardWindow, klines5m.length - 1);
      const endPrice = klines5m[lastIdx].close;
      const timeoutPnl = (signal === 'BUY' ? (endPrice - entryPrice) / entryPrice : (entryPrice - endPrice) / entryPrice) * 100 - frictionPct;
      if (timeoutPnl > 0) {
        totalGainPct += timeoutPnl;
      } else if (timeoutPnl < 0) {
        totalLossPct += Math.abs(timeoutPnl);
      }
    }
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number((resolved / totalSignals).toFixed(3)) : 0;
  const profitFactor = totalLossPct > 0 ? Number((totalGainPct / totalLossPct).toFixed(2)) : (totalGainPct > 0 ? 99.9 : 0);
  const expectancy = totalSignals > 0 ? Number(((totalGainPct - totalLossPct) / totalSignals).toFixed(3)) : 0;

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor,
    expectancy,
    neutrals,
    label: `últimas ${evalWindow} velas (5m)`,
    forwardLabel: '12 velas (1 hs max)',
    threshold: 0.01,
    targetThreshold: 0.015,
    targetMultiplier: 1.5,
    insufficient: false
  };

  return setBacktestCache(cacheKey, klines5m, res, [klines1h, klines1d]);
}
