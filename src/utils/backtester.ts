import type { Kline } from '../services/api';
import {
  calculateEMA,
  calculateATR,
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
  calculateTimeOfDayVolumeAvg
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
        evalWindow: 150,
        forwardWindow: 6,
        forwardLabel: '6 velas (30 min)',
        fallbackThreshold: 0.010,
        atrMultiplier: 1.5,
        targetMultiplier: 1.5,
      };
    case '1d':
      return {
        evalWindow: 60,
        forwardWindow: 3,
        forwardLabel: '3 velas (3 días)',
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
      };
    case '1h':
    default:
      return {
        evalWindow: 100,
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

function getAdaptiveThreshold(klines: Kline[], atrMultiplier: number, fallback: number): number {
  if (klines.length < 15) return fallback;

  const atr = calculateATR(klines, 14);
  const lastClose = klines[klines.length - 1].close;

  if (atr <= 0 || lastClose <= 0) return fallback;

  const atrPct = atr / lastClose;
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

  // Sample last 20 candles for gaps
  for (let i = Math.max(1, klines.length - 20); i < klines.length; i++) {
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
  const entry = klines[entryIdx].close;

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
      if (low <= stop)    return { result: 'loss', pnlPct: -stopThreshold * 100 };
      if (high >= target) return { result: 'win',  pnlPct: targetThreshold * 100 };
    } else {
      if (high >= stop)  return { result: 'loss', pnlPct: -stopThreshold * 100 };
      if (low <= target) return { result: 'win',  pnlPct: targetThreshold * 100 };
    }
  }

  // Timeout: calculate actual P&L at end of window
  const lastIdx = Math.min(entryIdx + forwardWindow, klines.length - 1);
  const exitPrice = klines[lastIdx].close;
  const rawPnl = signal === 'BUY'
    ? (exitPrice - entry) / entry * 100
    : (entry - exitPrice) / entry * 100;

  return { result: 'timeout', pnlPct: rawPnl };
}

// ─── Public API (Optimized O(n)) ────────────────────────────────────────────

export function backtestStandard(klines: Kline[], interval: string): BacktestResult {
  const signals = computeStandardSignalsSeries(klines);
  return runBacktestGenericOptimized(klines, interval, signals);
}

export function backtestConfluencia(klines: Kline[], interval: string): BacktestResult {
  const signals = computeConfluenciaSignalsSeries(klines, interval);
  return runBacktestGenericOptimized(klines, interval, signals);
}

export function backtestScoring(klines: Kline[], interval: string, weights?: ScoringWeights): BacktestResult {
  const signals = computeScoringSignalsSeries(klines, interval, weights);
  return runBacktestGenericOptimized(klines, interval, signals);
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
  const evalWindow = 150;
  const forwardWindow = style === 'swing' ? 48 : 576; // ~48 hours of candles
  const cooldownPeriod = style === 'swing' ? 2 : 24;  // 2 hours cooldown between signals

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
    neutrals: 0,
    label: `datos insuficientes`,
    forwardLabel: '48 hs max',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true
  };

  if (!klines5m || klines5m.length < evalWindow + 30) return fallbackResult;
  if (!klines1h || klines1h.length < 60) return fallbackResult;
  if (!klines1d || klines1d.length < 210) return fallbackResult;

  // ── Pre-calculate all series O(n) ─────────────────────────────────────
  // 1D series
  const closes1d = klines1d.map(k => k.close);
  const ema200_1d = calculateEMA(closes1d, 200);
  const ema50_1d = calculateEMA(closes1d, 50);
  const adxData1d = calculateADXSeries(klines1d, 14);

  // 1H series
  const closes1h = klines1h.map(k => k.close);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema20_1h = calculateEMA(closes1h, 20);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
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

  const latestEvalIdx = klines5m.length - 1;
  const oldestEvalIdx = Math.max(30, latestEvalIdx - evalWindow + 1);

  // B3 fix: Pre-compute Support/Resistance with a rolling window of 100 candles
  // to avoid O(n²) klines5m.slice(0, i+1) inside the main loop.
  // We compute S/R at regular intervals (every 12 candles = ~1 hour for 5m) and cache.
  const srCacheInterval = 12;
  const srCache: Map<number, { nearestSupport: number; nearestResistance: number }> = new Map();
  for (let idx = oldestEvalIdx; idx <= klines5m.length - 1; idx += srCacheInterval) {
    const windowStart = Math.max(0, idx - 100);
    const windowSlice = klines5m.slice(windowStart, idx + 1);
    const sr = calculateSupportResistance(windowSlice, klines5m[idx].close);
    srCache.set(idx, { nearestSupport: sr.nearestSupport, nearestResistance: sr.nearestResistance });
  }
  // Helper: get nearest cached S/R for any index
  const getCachedSR = (idx: number) => {
    // Find the closest cached index at or before idx
    const cacheIdx = Math.floor(idx / srCacheInterval) * srCacheInterval;
    const cached = srCache.get(cacheIdx);
    if (cached) return cached;
    // Fallback: check the previous cache slot
    const prevCacheIdx = cacheIdx - srCacheInterval;
    return srCache.get(prevCacheIdx) || { nearestSupport: 0, nearestResistance: 0 };
  };

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let neutrals = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;
  let nextAllowedIdx = 0;

  // Track completed trades for Meta-learning
  const completedTrades: { win: boolean; gain: number }[] = [];

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      neutrals++;
      continue;
    }

    const curr = klines5m[i];
    const prev = klines5m[i - 1];

    // ── LAYER 1: Daily Bias 1D ───────────────────────────────────────────
    let idx1d = -1;
    for (let d = klines1d.length - 1; d >= 0; d--) {
      const endTime1d = klines1d[d].time + 86400;
      if (endTime1d <= curr.time) {
        idx1d = d;
        break;
      }
    }
    if (idx1d < 205) { neutrals++; continue; }

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

    // ── LAYER 2: 1H Setup (Stateless State Machine) ─────────────────────
    let idx1h = -1;
    for (let h = klines1h.length - 1; h >= 0; h--) {
      const endTime1h = klines1h[h].time + 3600;
      if (endTime1h <= curr.time) {
        idx1h = h;
        break;
      }
    }
    if (idx1h < 50) { neutrals++; continue; }

    const close1h = closes1h[idx1h];
    const rsiVal1h = rsiSeries1h[idx1h];
    const atrVal1h = atrSeries1h[idx1h];
    const vwapVal1h = vwapSeries1h[idx1h];
    const atrSma1h = atrSma1hArr[idx1h] || 1;
    const macdHist1h = macdData1h.histogram[idx1h];
    const macdHistPrev1h = idx1h > 0 ? macdData1h.histogram[idx1h - 1] : NaN;

    if (isNaN(vwapVal1h) || isNaN(rsiVal1h) || isNaN(atrVal1h)) {
      neutrals++; continue;
    }

    const isSetupLongCandle = (hIdx: number) => {
      const hist = macdData1h.histogram[hIdx];
      const prevHist = macdData1h.histogram[hIdx - 1];
      return (
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
      return (
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
    for (let offset = 0; offset < 3; offset++) {
      const hIdx = idx1h - offset;
      if (hIdx < 1) break;
      if (isInvalidatedLong(hIdx)) break;
      if (isSetupLongCandle(hIdx)) {
        setupArmedLong = true;
        break;
      }
    }

    let setupArmedShort = false;
    for (let offset = 0; offset < 3; offset++) {
      const hIdx = idx1h - offset;
      if (hIdx < 1) break;
      if (isInvalidatedShort(hIdx)) break;
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

    // ── CONFLUENCE SCORING ───────────────────────────────────────────────
    const getConfluenceScore = (dir: 'LONG' | 'SHORT') => {
      let pt = 0;
      const isLong = dir === 'LONG';
      
      const activeBias = isLong ? bias1D === 'ALCISTA' : bias1D === 'BAJISTA';
      if (activeBias) pt += 2;

      if (lastAdx1d > 25) pt += 1;

      if (volCurr5m / volAvg5m >= 2.0) pt += 2;

      const activeVwap1h = isLong ? close1h > vwapVal1h : close1h < vwapVal1h;
      if (activeVwap1h) pt += 1;

      const activeMacd1h = isLong ? (macdHist1h > 0 && macdHist1h > macdHistPrev1h) : (macdHist1h < 0 && macdHist1h < macdHistPrev1h);
      if (activeMacd1h) pt += 1;

      if (squeezePrev) pt += 1;

      const srLevel = getCachedSR(i);
      const distSupport = srLevel.nearestSupport > 0 ? (curr.close - srLevel.nearestSupport) / curr.close : Infinity;
      const distResist = srLevel.nearestResistance > 0 ? (srLevel.nearestResistance - curr.close) / curr.close : Infinity;
      const nearLevel = isLong ? distSupport < 0.005 : distResist < 0.005;
      
      let donchianHigh = -Infinity;
      let donchianLow = Infinity;
      const donStart = Math.max(0, idx1d - 20);
      for (let d = donStart; d <= idx1d; d++) {
        if (klines1d[d].high > donchianHigh) donchianHigh = klines1d[d].high;
        if (klines1d[d].low < donchianLow) donchianLow = klines1d[d].low;
      }
      const nearDonchian = isLong ? Math.abs(curr.close - donchianLow) / curr.close < 0.01 : Math.abs(curr.close - donchianHigh) / curr.close < 0.01;
      
      if (nearLevel || nearDonchian) pt += 1;

      return pt;
    };

    const scoreLong = getConfluenceScore('LONG');
    const scoreShort = getConfluenceScore('SHORT');

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
        const gateVol = rvol >= 1.5;
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
                              volCurr5m / volAvg5m >= 1.5 &&
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
                               (vol5m[i - 1] / volSma5m[i - 1]) >= 2.0 &&
                               (prev.close - bbSeries5m[bbIdx - 1].upper) <= 1.0 * atrSeries5m[i - 1];

      condBreakoutLong = squeezePrev && breakoutLongPrev && curr.low > orb.high;

      const breakoutShortPrev = prevOrb.isActive &&
                                prev.close < prevOrb.low - 0.10 * atrSeries5m[i - 1] &&
                                bbIdx > 0 && prev.close < bbSeries5m[bbIdx - 1].lower &&
                                (vol5m[i - 1] / volSma5m[i - 1]) >= 2.0 &&
                                (bbSeries5m[bbIdx - 1].lower - prev.close) <= 1.0 * atrSeries5m[i - 1];

      condBreakoutShort = squeezePrev && breakoutShortPrev && curr.high < orb.low;
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

    // ── QUALITY FILTERS ──────────────────────────────────────────────────
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

    const qualityLong = (curr.close - vwap5m) <= 2.0 * atr5m &&
                        candleBodyRatio(curr) >= 0.4 &&
                        closePosition(curr) >= 0.60 &&
                        upperWickRatio(curr) <= 0.25 &&
                        minutesSinceOpen >= 15 &&
                        volCurr5m / volAvg5m < 8.0;

    const qualityShort = (vwap5m - curr.close) <= 2.0 * atr5m &&
                         candleBodyRatio(curr) >= 0.4 &&
                         closePosition(curr) <= 0.40 &&
                         lowerWickRatio(curr) <= 0.25 &&
                         minutesSinceOpen >= 15 &&
                         volCurr5m / volAvg5m < 8.0;

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

    const baseScore = signal === 'BUY' ? scoreLong : (signal === 'SELL' ? scoreShort : Math.max(scoreLong, scoreShort));
    const finalScorePercent = Math.round((baseScore / 9) * 100);

    let requiredThreshold = 44; // score >= 4
    if (atrVal1h > 1.2 * atrSma1h) requiredThreshold = 33; // score >= 3
    else if (atrVal1h < 0.8 * atrSma1h) requiredThreshold = 55; // score >= 5

    // Grade Confidence
    let confidence: 'ALTA' | 'MODERADA' | 'DESCARTAR' = 'DESCARTAR';
    if (finalScorePercent >= 70) {
      confidence = 'ALTA';
    } else if (finalScorePercent >= requiredThreshold) {
      confidence = 'MODERADA';
    }

    if (signal !== 'NEUTRAL' && confidence === 'DESCARTAR') {
      signal = 'NEUTRAL';
    }

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    // ── RISK & POSITION CONFIG ───────────────────────────────────────────
    const entry = curr.close;
    let stopLoss = 0;
    
    // Swing style SL lookback is 5 bars, Day Trading is 10 bars
    const lookbackS = Math.max(0, i - (style === 'swing' ? 5 : 10));
    let swingLow = Infinity;
    let swingHigh = -Infinity;
    for (let s = lookbackS; s < i; s++) {
      if (klines5m[s].low < swingLow) swingLow = klines5m[s].low;
      if (klines5m[s].high > swingHigh) swingHigh = klines5m[s].high;
    }

    const atrMult = style === 'swing' ? 1.0 : 1.5;
    const tp1Mult = style === 'swing' ? 2.0 : 1.5;
    const tp2Mult = style === 'swing' ? 4.0 : 2.5;
    const tp3Mult = style === 'swing' ? 5.0 : 3.5;

    if (signal === 'BUY') {
      const slATR = entry - atrMult * atr5m;
      const slStruct = swingLow - 0.25 * atr5m;
      
      stopLoss = Math.min(slATR, slStruct);
      let risk = entry - stopLoss;
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry - minRisk;
        risk = minRisk;
      }

      const riskPercent = risk / entry;
      const maxAllowedRisk = style === 'swing' ? 0.035 : 0.012;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        neutrals++;
        continue;
      }
    } else {
      const slATR = entry + atrMult * atr5m;
      const slStruct = swingHigh + 0.25 * atr5m;
      
      stopLoss = Math.max(slATR, slStruct);
      let risk = stopLoss - entry;
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry + minRisk;
        risk = minRisk;
      }

      const riskPercent = risk / entry;
      const maxAllowedRisk = style === 'swing' ? 0.035 : 0.012;
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

      if (k.high > highestHigh) highestHigh = k.high;
      if (k.low < lowestLow) lowestLow = k.low;

      // Time Stop: 12 candles
      if (!tp1Hit && (f - i) >= 12) {
        const currentPnl = signal === 'BUY' ? (k.close - entry) : (entry - k.close);
        if (currentPnl < 0.5 * risk) {
          pnlPct = (currentPnl / entry) * 100;
          tradeOutcome = 'timeout';
          exitIdx = f;
          break;
        }
      }

      // Emergency Exit
      const isLongEmergency = k.close < vwapSeries5m[f] && k.close < ema21_5m[f];
      const isShortEmergency = k.close > vwapSeries5m[f] && k.close > ema21_5m[f];

      if (signal === 'BUY') {
        if (isLongEmergency) {
          const tp1P = tp1Hit ? 0.50 * ((tp1 - entry) / entry * 100) : 0;
          const tp2P = tp2Hit ? 0.25 * ((tp2 - entry) / entry * 100) : 0;
          let leftWeight = 1.0;
          if (tp1Hit) leftWeight -= 0.50;
          if (tp2Hit) leftWeight -= 0.25;
          const remainingP = leftWeight * ((k.close - entry) / entry * 100);
          pnlPct = tp1P + tp2P + remainingP;
          tradeOutcome = 'timeout';
          exitIdx = f;
          break;
        }

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
        if (isShortEmergency) {
          const tp1P = tp1Hit ? 0.50 * ((entry - tp1) / entry * 100) : 0;
          const tp2P = tp2Hit ? 0.25 * ((entry - tp2) / entry * 100) : 0;
          let leftWeight = 1.0;
          if (tp1Hit) leftWeight -= 0.50;
          if (tp2Hit) leftWeight -= 0.25;
          const remainingP = leftWeight * ((entry - k.close) / entry * 100);
          pnlPct = tp1P + tp2P + remainingP;
          tradeOutcome = 'timeout';
          exitIdx = f;
          break;
        }

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


    // B2+B4 fix: Properly classify timeouts. Marginal P&L (< 0.3%) on timeout
    // should not inflate WinRate — count as timeout instead of win.
    if (tradeOutcome === 'win') {
      wins++;
      totalGainPct += pnlPct;
      completedTrades.push({ win: true, gain: pnlPct });
    } else if (tradeOutcome === 'timeout') {
      timeouts++;
      if (pnlPct >= 0.3) {
        // Meaningful positive outcome despite timeout — count as win
        wins++;
        totalGainPct += pnlPct;
        completedTrades.push({ win: true, gain: pnlPct });
      } else if (pnlPct <= -0.3) {
        // Meaningful negative outcome — count as loss
        losses++;
        totalLossPct += Math.abs(pnlPct);
        completedTrades.push({ win: false, gain: pnlPct });
      } else {
        // Marginal P&L (between -0.3% and +0.3%) — true timeout, don't distort stats
        completedTrades.push({ win: false, gain: pnlPct });
      }
    } else {
      // tradeOutcome === 'loss'
      losses++;
      totalLossPct += Math.abs(pnlPct);
      completedTrades.push({ win: false, gain: pnlPct });
    }

    nextAllowedIdx = exitIdx + cooldownPeriod;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? totalGainPct / totalLossPct : (totalGainPct > 0 ? 99.9 : 0);

  const avgWinPct = wins > 0 ? totalGainPct / wins : 0;
  const avgLossPct = losses > 0 ? totalLossPct / losses : 0;
  const expectancy = resolved > 0 ? (winRate * avgWinPct) - ((1 - winRate) * avgLossPct) : 0;

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
    label: `últimas ${actualWindow} velas (${style === 'swing' ? '1h' : '5m'})`,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '48 hs max (Intradía)',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: style === 'swing' ? 2.0 : 1.5,
    insufficient: false
  };
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

  const threshold = getAdaptiveThreshold(klines, params.atrMultiplier, params.fallbackThreshold);
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

    totalSignals++;
    const outcome = evaluateOutcome(klines, i, signal, forwardWindow, threshold, targetThreshold);

    if (outcome.result === 'win') {
      wins++;
      totalGainPct += outcome.pnlPct;
    } else if (outcome.result === 'loss') {
      losses++;
      totalLossPct += Math.abs(outcome.pnlPct);
    } else {
      timeouts++;
    }

    nextAllowedIdx = i + forwardWindow + 1;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? totalGainPct / totalLossPct : (totalGainPct > 0 ? Infinity : 0);

  const avgWinPct = wins > 0 ? totalGainPct / wins : 0;
  const avgLossPct = losses > 0 ? totalLossPct / losses : 0;
  const expectancy = resolved > 0 ? (winRate * avgWinPct) - ((1 - winRate) * avgLossPct) : 0;

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
      const rvolThreshold = rawSignal.includes('BUY') ? 1.2 : 0.8;
      const voteMargin = Math.abs(buyVotes - sellVotes);
      const effectiveRvolThreshold = voteMargin < 2 ? Math.max(rvolThreshold, 1.5) : rvolThreshold;
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

    const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > e9;
    const bullish_candle = hammer || engulf === 1 || strongBullish;
    const bearish_candle = engulf === -1;

    const is_buy = curr.close > vw && e9 > e20 && curr.volume > vAvg && bullish_candle && bRatio >= 0.4;
    const is_sell = curr.close < vw && e9 < e20 && curr.volume > vAvg && (bearish_candle || curr.close < e20) && bRatio >= 0.4;

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

  // Pre-calculate Support/Resistance cache to optimize backtest performance O(n)
  const srCacheInterval = 12;
  const srCache: Map<number, { nearestSupport: number; nearestResistance: number }> = new Map();
  for (let idx = 59; idx < length; idx += srCacheInterval) {
    const windowStart = Math.max(0, idx - 100);
    const windowSlice = klines.slice(windowStart, idx + 1);
    const sr = calculateSupportResistance(windowSlice, klines[idx].close);
    srCache.set(idx, { nearestSupport: sr.nearestSupport, nearestResistance: sr.nearestResistance });
  }
  const getCachedSR = (idx: number) => {
    const cacheIdx = Math.floor(idx / srCacheInterval) * srCacheInterval;
    const cached = srCache.get(cacheIdx);
    if (cached) return cached;
    const prevCacheIdx = cacheIdx - srCacheInterval;
    return srCache.get(prevCacheIdx) || { nearestSupport: 0, nearestResistance: 0 };
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
      if (rsiSlopeVal >= 0)           s2 += 1;
    } else {
      if (rsiSlopeVal <= 0)           s2 -= 1;
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
    let s5 = 0;
    if (pctBody < 0.3) {
      s5 = 0;
    } else {
      if      (body > 0 && pctBody > 0.5) s5 += 1;
      else if (body > 0)                  s5 += 1;
      else if (body < 0 && pctBody > 0.5) s5 -= 1;
      else if (body < 0)                  s5 -= 1;
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

