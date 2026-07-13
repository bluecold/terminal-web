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
  symbol?: string
): BacktestResult {
  const evalWindow = 150;
  const forwardWindow = 576; // ~48 hours of 5m candles
  const cooldownPeriod = 24;  // 2 hours cooldown between signals

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
  const ema20_1d = calculateEMA(closes1d, 20);

  // 1H series
  const closes1h = klines1h.map(k => k.close);
  const ema200_1h = calculateEMA(closes1h, 200);
  const ema20_1h = calculateEMA(closes1h, 20);
  const ema9_1h = calculateEMA(closes1h, 9);
  const ema21_1h = calculateEMA(closes1h, 21);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
  const atrSeries1h = calculateATRSeries(klines1h, 14);
  const vwapSeries1h = calculateVWAPSeries(klines1h, '1h', symbol);

  // Volume 1H SMA 20
  const vol1h = klines1h.map(k => k.volume);
  const volSma1h: number[] = new Array(klines1h.length).fill(0);
  let volSum1h = 0;
  for (let i = 0; i < Math.min(20, vol1h.length); i++) volSum1h += vol1h[i];
  if (vol1h.length >= 20) volSma1h[19] = volSum1h / 20;
  for (let i = 20; i < vol1h.length; i++) {
    volSum1h = volSum1h - vol1h[i - 20] + vol1h[i];
    volSma1h[i] = volSum1h / 20;
  }

  // 5m series
  const closes5m = klines5m.map(k => k.close);
  const bbSeries5m = calculateBollingerBandsSeries(klines5m, 20, 2);
  const ema9_5m = calculateEMA(closes5m, 9);
  const ema20_5m = calculateEMA(closes5m, 20);
  const vwapSeries5m = calculateVWAPSeries(klines5m, '5m', symbol);
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

  // Bollinger Band Width series for 5m Squeeze
  const bbWidth5m = bbSeries5m.map(b => b.middle > 0 ? (b.upper - b.lower) / b.middle * 100 : 0);
  const bbWidthAvg5m = new Array(klines5m.length).fill(0);
  let bbWidthSum = 0;
  const pSqueeze = 50;
  for (let idx = 0; idx < Math.min(pSqueeze, bbWidth5m.length); idx++) bbWidthSum += bbWidth5m[idx];
  if (bbWidth5m.length >= pSqueeze) bbWidthAvg5m[pSqueeze - 1] = bbWidthSum / pSqueeze;
  for (let idx = pSqueeze; idx < bbWidth5m.length; idx++) {
    bbWidthSum = bbWidthSum - bbWidth5m[idx - pSqueeze] + bbWidth5m[idx];
    bbWidthAvg5m[idx] = bbWidthSum / pSqueeze;
  }

  // ATR SMA 50 for 1H Regime
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
    const lastEma20_1d = ema20_1d[idx1d];
    const lastClose1d = closes1d[idx1d];
    if (isNaN(lastEma200_1d) || isNaN(lastEma50_1d) || isNaN(lastEma20_1d)) { neutrals++; continue; }

    let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
    if (lastClose1d > lastEma200_1d && lastEma20_1d > lastEma50_1d) {
      bias1D = 'ALCISTA';
    } else if (lastClose1d < lastEma200_1d && lastEma20_1d < lastEma50_1d) {
      bias1D = 'BAJISTA';
    }

    // ── LAYER 2: 1H Setup Pullback ──────────────────────────────────────────
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
    const ema200Val1h = ema200_1h[idx1h];
    const ema20Val1h = ema20_1h[idx1h];
    const ema9Val1h = ema9_1h[idx1h];
    const ema21Val1h = ema21_1h[idx1h];
    const rsiVal1h = rsiSeries1h[idx1h];
    const atrVal1h = atrSeries1h[idx1h];
    const vwapVal1h = vwapSeries1h[idx1h];
    const atrSma1h = atrSma1hArr[idx1h] || 1;

    if (isNaN(ema20Val1h) || isNaN(rsiVal1h) || isNaN(vwapVal1h) || isNaN(atrVal1h)) {
      neutrals++; continue;
    }

    const pullback1HLong = klines1h[idx1h].low <= ema20Val1h && close1h > vwapVal1h;
    const pullback1HShort = klines1h[idx1h].high >= ema20Val1h && close1h < vwapVal1h;

    let momentum1H: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
    if (pullback1HLong) momentum1H = 'ALCISTA';
    else if (pullback1HShort) momentum1H = 'BAJISTA';

    // ── LAYER 3: 5m Indicators ──────────────────────────────────────────
    const bb = bbSeries5m[i - 19];
    if (!bb) { neutrals++; continue; }

    const vwap5m = vwapSeries5m[i];
    const ema9Val = ema9_5m[i];
    const ema20Val = ema20_5m[i];
    const rsi5m = rsiSeries5m[i];
    const atr5m = atrSeries5m[i];
    const volCurr5m = vol5m[i];
    const volAvg5m = volSma5m[i];

    if (isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema20Val) || isNaN(rsi5m) || isNaN(atr5m)) {
      neutrals++; continue;
    }

    // 5m squeeze
    const prevBBWidth = bbWidth5m[i - 1];
    const prevBBWidthAvg = bbWidthAvg5m[i - 1];
    const isSqueeze = prevBBWidthAvg > 0 && prevBBWidth < 0.8 * prevBBWidthAvg;

    // ATR percentile 40 (last 100)
    const last100Atr5m = atrSeries5m.slice(Math.max(0, i - 100), i + 1).filter(v => !isNaN(v)).sort((a, b) => a - b);
    const atr40Percentile = last100Atr5m.length > 0 ? last100Atr5m[Math.floor(last100Atr5m.length * 0.4)] : 0;

    // Daily Range for active asset
    const last20Ranges = closes1d.slice(Math.max(0, idx1d - 20), idx1d + 1).map((c, idx) => {
      const kd = klines1d[Math.max(0, idx1d - 20) + idx];
      return c > 0 ? (kd.high - kd.low) / c * 100 : 0;
    });
    const avgDailyRange = last20Ranges.reduce((a, b) => a + b, 0) / Math.max(1, last20Ranges.length);

    // ── Running Winrate (Meta-learning) ──────────────────────────────────
    let recentWinRate = 0.50;
    let recentProfitFactor = 1.0;
    if (completedTrades.length > 0) {
      const last20Trades = completedTrades.slice(-20);
      const w = last20Trades.filter(t => t.win).length;
      recentWinRate = w / last20Trades.length;
      let gains = 0;
      let losses = 0;
      last20Trades.forEach(t => {
        if (t.win) gains += t.gain;
        else losses += Math.abs(t.gain);
      });
      recentProfitFactor = losses > 0 ? gains / losses : 1.5;
    }

    // ── ADAPTATIVE SCORING ───────────────────────────────────────────────
    const getScore = (dir: 'LONG' | 'SHORT') => {
      let score = 0;
      const isLong = dir === 'LONG';

      // A. Trend (30)
      score += (isLong ? lastClose1d > lastEma200_1d : lastClose1d < lastEma200_1d) ? 10 : 0;
      score += (isLong ? close1h > ema200Val1h : close1h < ema200Val1h) ? 8 : 0;
      score += (isLong ? ema9Val1h > ema21Val1h : ema9Val1h < ema21Val1h) ? 7 : 0;
      score += (isLong ? ema9Val > ema20Val : ema9Val < ema20Val) ? 5 : 0;

      // B. Momentum (25)
      const rsi5mInRange = isLong ? rsi5m > 32 && rsi5m < 48 : rsi5m > 52 && rsi5m < 68;
      score += rsi5mInRange ? 10 : 0;
      score += (isLong ? rsiVal1h > 50 : rsiVal1h < 50) ? 8 : 0;

      const percentB = bb.upper > bb.lower ? (curr.close - bb.lower) / (bb.upper - bb.lower) : 0.5;
      const pctBExtreme = isLong ? percentB < 0.12 : percentB > 0.88;
      score += pctBExtreme ? 7 : 0;

      // C. Volatility (20)
      score += (bbWidth5m[i] > 1.8) ? 8 : 0;
      const nearBand = isLong ? curr.close <= bb.lower * 1.003 : curr.close >= bb.upper * 0.997;
      score += nearBand ? 8 : 0;
      score += (atr5m > atr40Percentile) ? 4 : 0;

      // D. Volume (15)
      score += (volAvg5m > 0 && volCurr5m > 1.5 * volAvg5m) ? 8 : 0;
      score += (volAvg5m > 0 && volCurr5m > 1.8 * volAvg5m) ? 4 : 0;
      score += (isLong ? curr.close > vwap5m : curr.close < vwap5m) ? 3 : 0;

      // E. MTF Alignment (10)
      const activeBias = isLong ? bias1D === 'ALCISTA' : bias1D === 'BAJISTA';
      const activeMom = isLong ? momentum1H === 'ALCISTA' : momentum1H === 'BAJISTA';
      const activeTrigger = isLong ? (curr.close > prev.high && curr.close > vwap5m) : (curr.close < prev.low && curr.close < vwap5m);

      if (activeBias && activeMom && activeTrigger) score += 10;
      else if (activeMom && activeTrigger) score += 6;
      else if (activeTrigger) score += 3;

      if ((isLong ? bias1D === 'BAJISTA' : bias1D === 'ALCISTA') && (isLong ? momentum1H === 'BAJISTA' : momentum1H === 'ALCISTA')) {
        score -= 10;
      }

      return score;
    };

    const baseScoreLong = getScore('LONG');
    const baseScoreShort = getScore('SHORT');

    // Adapt factors
    let adaptiveFactor = 1.0;
    if (atrVal1h > 1.2 * atrSma1h) adaptiveFactor *= 1.15;
    else if (atrVal1h < 0.8 * atrSma1h) adaptiveFactor *= 0.82;

    if (avgDailyRange > 3.5) adaptiveFactor *= 1.12;
    else if (avgDailyRange < 1.2) adaptiveFactor *= 0.75;

    let perfMult = 1.0;
    if (recentWinRate > 0.68) perfMult += 0.12;
    else if (recentWinRate < 0.45) perfMult -= 0.18;
    if (recentProfitFactor > 1.8) perfMult += 0.08;
    adaptiveFactor *= Math.max(0.65, Math.min(1.25, perfMult));

    const finalScoreLong = Math.min(100, Math.max(0, Math.round(baseScoreLong * adaptiveFactor)));
    const finalScoreShort = Math.min(100, Math.max(0, Math.round(baseScoreShort * adaptiveFactor)));

    let requiredThreshold = 76;
    if (atrVal1h > 1.2 * atrSma1h) requiredThreshold = 72;
    else if (atrVal1h < 0.8 * atrSma1h) requiredThreshold = 82;

    // Triggers
    const isLongBias = bias1D === 'ALCISTA' && momentum1H === 'ALCISTA';
    const condBreakoutLong = curr.close > prev.high && curr.close > vwap5m;
    const condVolumeLong = volAvg5m > 0 && volCurr5m > 1.8 * volAvg5m;
    const condRsiLong = rsi5m > 40 && rsi5m < 68;
    const condStructureLong = curr.close > curr.open;
    const triggerLong = isLongBias && condBreakoutLong && condVolumeLong && isSqueeze && condRsiLong && condStructureLong;
    const condReversalLong = curr.low <= bb.lower && curr.close > bb.lower && curr.close > curr.open && volAvg5m > 0 && volCurr5m > 1.5 * volAvg5m;
    const triggerReversalLong = isLongBias && condReversalLong && rsi5m < 42;

    const isShortBias = bias1D === 'BAJISTA' && momentum1H === 'BAJISTA';
    const condBreakoutShort = curr.close < prev.low && curr.close < vwap5m;
    const condVolumeShort = volAvg5m > 0 && volCurr5m > 1.8 * volAvg5m;
    const condRsiShort = rsi5m > 32 && rsi5m < 60;
    const condStructureShort = curr.close < curr.open;
    const triggerShort = isShortBias && condBreakoutShort && condVolumeShort && isSqueeze && condRsiShort && condStructureShort;
    const condReversalShort = curr.high >= bb.upper && curr.close < bb.upper && curr.close < curr.open && volAvg5m > 0 && volCurr5m > 1.5 * volAvg5m;
    const triggerReversalShort = isShortBias && condReversalShort && rsi5m > 58;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if ((triggerLong || triggerReversalLong) && finalScoreLong >= requiredThreshold) {
      signal = 'BUY';
    } else if ((triggerShort || triggerReversalShort) && finalScoreShort >= requiredThreshold) {
      signal = 'SELL';
    }

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    // ── RISK LEVELS ──────────────────────────────────────────────────────
    const entry = curr.close;
    let stopLoss = 0;
    
    let swingLow5 = Infinity;
    let swingHigh5 = -Infinity;
    const lookbackS = Math.max(0, i - 5);
    for (let s = lookbackS; s <= i; s++) {
      if (klines5m[s].low < swingLow5) swingLow5 = klines5m[s].low;
      if (klines5m[s].high > swingHigh5) swingHigh5 = klines5m[s].high;
    }

    if (signal === 'BUY') {
      const slATR = entry - 1.35 * atr5m;
      const slStruct = swingLow5;
      const slVwap = vwap5m - 0.5 * atr5m;
      stopLoss = Math.max(slATR, slStruct, slVwap);
      const minDist = entry * 0.002;
      if (entry - stopLoss < minDist) stopLoss = entry - minDist;
    } else {
      const slATR = entry + 1.35 * atr5m;
      const slStruct = swingHigh5;
      const slVwap = vwap5m + 0.5 * atr5m;
      stopLoss = Math.min(slATR, slStruct, slVwap);
      const minDist = entry * 0.002;
      if (stopLoss - entry < minDist) stopLoss = entry + minDist;
    }

    const risk = Math.abs(entry - stopLoss);
    const tp1 = signal === 'BUY' ? entry + risk * 1.5 : entry - risk * 1.5;
    const tp2 = signal === 'BUY' ? entry + 1.0 * atrVal1h : entry - 1.0 * atrVal1h;
    const tp3 = signal === 'BUY' ? entry + risk * 2.5 : entry - risk * 2.5;

    totalSignals++;

    // ── Simulate Multi-Target position ───────────────────────────────────
    let pnlPct = 0;
    let tradeOutcome: 'win' | 'loss' | 'timeout' = 'timeout';
    let exitIdx = i;
    
    // Position shares
    let tp1Hit = false;
    let tp2Hit = false;
    let activeSL = stopLoss;

    for (let f = i + 1; f <= i + forwardWindow && f < klines5m.length; f++) {
      const k = klines5m[f];

      if (signal === 'BUY') {
        // SL check
        if (k.low <= activeSL) {
          if (tp2Hit) {
            // TP1 (40% at +1.5R), TP2 (35% at +1.0 ATR 1H), remaining 25% at Breakeven
            const tp1P = 0.40 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.35 * ((tp2 - entry) / entry * 100);
            pnlPct = tp1P + tp2P; // remaining 25% = 0%
            tradeOutcome = 'win';
          } else if (tp1Hit) {
            // TP1 (40% at +1.5R), remaining 60% at Breakeven
            pnlPct = 0.40 * ((tp1 - entry) / entry * 100);
            tradeOutcome = 'win';
          } else {
            // Full loss at original SL
            pnlPct = -risk / entry * 100;
            tradeOutcome = 'loss';
          }
          exitIdx = f;
          break;
        }

        // Target 1
        if (!tp1Hit && k.high >= tp1) {
          tp1Hit = true;
          activeSL = entry + 0.1 * atr5m; // Breakeven + minor buffer
        }

        // Target 2
        if (tp1Hit && !tp2Hit && k.high >= tp2) {
          tp2Hit = true;
        }

        // Target 3: Trailing exit with EMA 9 (or direct hit)
        if (tp2Hit) {
          const ema9Valf = ema9_5m[f];
          if (k.close < tp3 && !isNaN(ema9Valf) && k.close < ema9Valf) {
            const tp1P = 0.40 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.35 * ((tp2 - entry) / entry * 100);
            const tp3P = 0.25 * ((k.close - entry) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          } else if (k.high >= tp3) {
            const tp1P = 0.40 * ((tp1 - entry) / entry * 100);
            const tp2P = 0.35 * ((tp2 - entry) / entry * 100);
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
            const tp1P = 0.40 * ((entry - tp1) / entry * 100);
            const tp2P = 0.35 * ((entry - tp2) / entry * 100);
            pnlPct = tp1P + tp2P;
            tradeOutcome = 'win';
          } else if (tp1Hit) {
            pnlPct = 0.40 * ((entry - tp1) / entry * 100);
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
          activeSL = entry - 0.1 * atr5m;
        }

        if (tp1Hit && !tp2Hit && k.low <= tp2) {
          tp2Hit = true;
        }

        if (tp2Hit) {
          const ema9Valf = ema9_5m[f];
          if (k.close > tp3 && !isNaN(ema9Valf) && k.close > ema9Valf) {
            const tp1P = 0.40 * ((entry - tp1) / entry * 100);
            const tp2P = 0.35 * ((entry - tp2) / entry * 100);
            const tp3P = 0.25 * ((entry - k.close) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          } else if (k.low <= tp3) {
            const tp1P = 0.40 * ((entry - tp1) / entry * 100);
            const tp2P = 0.35 * ((entry - tp2) / entry * 100);
            const tp3P = 0.25 * ((entry - tp3) / entry * 100);
            pnlPct = tp1P + tp2P + tp3P;
            tradeOutcome = 'win';
            exitIdx = f;
            break;
          }
        }
      }
    }

    if (tradeOutcome === 'timeout') {
      const lastF = Math.min(i + forwardWindow, klines5m.length - 1);
      const exitPrice = klines5m[lastF].close;
      exitIdx = lastF;
      const tp1P = tp1Hit ? 0.40 * ((signal === 'BUY' ? tp1 - entry : entry - tp1) / entry * 100) : 0;
      const tp2P = tp2Hit ? 0.35 * ((signal === 'BUY' ? tp2 - entry : entry - tp2) / entry * 100) : 0;
      
      let leftWeight = 1.0;
      if (tp1Hit) leftWeight -= 0.40;
      if (tp2Hit) leftWeight -= 0.35;
      
      const tp3P = leftWeight * ((signal === 'BUY' ? exitPrice - entry : entry - exitPrice) / entry * 100);
      pnlPct = tp1P + tp2P + tp3P;
    }

    if (tradeOutcome === 'win' || (tradeOutcome === 'timeout' && pnlPct > 0)) {
      wins++;
      totalGainPct += pnlPct;
      completedTrades.push({ win: true, gain: pnlPct });
    } else {
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
    label: `últimas ${actualWindow} velas (5m)`,
    forwardLabel: '48 hs max',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
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

    const bullish_candle = hammer || engulf === 1;
    const bearish_candle = engulf === -1;

    const e9 = ema9[i];
    const e20 = ema20[i];
    const vw = vwap[i];
    const vAvg = volSMA[i];

    const is_buy = curr.close > vw && e9 > e20 && curr.volume > vAvg && bullish_candle;
    const is_sell = curr.close < vw && e9 < e20 && curr.volume > vAvg && (bearish_candle || curr.close < e20);

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
      if (closeVal > vwap) s4 += 1;
      else                 s4 -= 1;
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
    if      (body > 0 && pctBody > 0.5) s5 += 1;
    else if (body > 0)                  s5 += 1;
    else if (body < 0 && pctBody > 0.5) s5 -= 1;
    else if (body < 0)                  s5 -= 1;

    // Layer 6 - Structure (Support / Resistance)
    const sr = calculateSupportResistance(klines.slice(0, i + 1), closeVal);
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

