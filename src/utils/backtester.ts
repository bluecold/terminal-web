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
  klines: Kline[],
  klinesMacro: Kline[],
  interval: string,
  symbol?: string
): BacktestResult {
  const evalWindow = interval === '5m' ? 150 : interval === '1h' ? 100 : 60;
  const forwardWindow = interval === '5m' ? 576 : interval === '1h' ? 72 : 15;
  const cooldownPeriod = interval === '5m' ? 24 : interval === '1h' ? 12 : 5;
  const macroDuration = interval === '5m' ? 3600 : 86400;

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
    neutrals: 0,
    label: `datos insuficientes`,
    forwardLabel: interval === '5m' ? '48 hs max' : interval === '1h' ? '3 días max' : '15 días max',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true
  };

  if (!klines || klines.length < evalWindow + 20) return fallbackResult;
  if (!klinesMacro || klinesMacro.length < 200) return fallbackResult;

  const latestEvalIdx = klines.length - 1;
  const oldestEvalIdx = Math.max(20, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let neutrals = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;

  let nextAllowedIdx = 0;

  const closes = klines.map(k => k.close);
  const rsiSeries = calculateRSISeries(closes, 14);
  const stSeries = calculateSupertrendSeries(klines, 10, 3);

  const closesMacro = klinesMacro.map(k => k.close);
  const ema200MacroSeries = calculateEMA(closesMacro, 200);

  // Optimized VWAP Series
  const vwapSeries = calculateVWAPSeries(klines, interval, symbol);

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      neutrals++;
      continue;
    }

    const curr = klines[i];

    let macroEma200 = NaN;
    let lastClosedMacroClose = NaN;
    for (let h = klinesMacro.length - 1; h >= 0; h--) {
      const endTime = klinesMacro[h].time + macroDuration;
      if (endTime <= curr.time) {
        macroEma200 = ema200MacroSeries[h];
        lastClosedMacroClose = klinesMacro[h].close;
        break;
      }
    }

    if (isNaN(macroEma200) || isNaN(lastClosedMacroClose)) {
      neutrals++;
      continue;
    }

    const isTrendUp = lastClosedMacroClose > macroEma200;
    const isTrendDown = lastClosedMacroClose < macroEma200;

    const rsi = rsiSeries[i];
    const stVal = stSeries[i].value;
    const stDir = stSeries[i].direction;
    const prevStDir = stSeries[i - 1].direction;

    const isSupertrendFlipGreen = stDir === 'UP' && prevStDir === 'DOWN';
    const isSupertrendFlipRed = stDir === 'DOWN' && prevStDir === 'UP';

    const vwap = vwapSeries[i];

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if (isTrendUp && isSupertrendFlipGreen && curr.close > vwap && rsi >= 40 && rsi <= 70) {
      signal = 'BUY';
    } else if (isTrendDown && isSupertrendFlipRed && curr.close < vwap && rsi >= 30 && rsi <= 60) {
      signal = 'SELL';
    }

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    totalSignals++;

    const entry = curr.close;
    let stopLoss = signal === 'BUY' ? Math.max(stVal, vwap) : Math.min(stVal, vwap);
    const minStopDist = entry * 0.002;
    if (signal === 'BUY') {
      if (entry - stopLoss < minStopDist) {
        stopLoss = entry - minStopDist;
      }
    } else {
      if (stopLoss - entry < minStopDist) {
        stopLoss = entry + minStopDist;
      }
    }

    let tradeOutcome: 'win' | 'loss' | 'timeout' = 'timeout';
    let exitPrice = entry;
    let exitIdx = i;

    for (let f = i + 1; f <= i + forwardWindow && f < klines.length; f++) {
      const k = klines[f];
      const rsiF = rsiSeries[f];
      const stDirF = stSeries[f].direction;

      if (signal === 'BUY') {
        if (k.low <= stopLoss) {
          tradeOutcome = 'loss';
          exitPrice = stopLoss;
          exitIdx = f;
          break;
        }
        if (stDirF === 'DOWN' || rsiF >= 75) {
          tradeOutcome = 'win';
          exitPrice = k.close;
          exitIdx = f;
          break;
        }
      } else {
        if (k.high >= stopLoss) {
          tradeOutcome = 'loss';
          exitPrice = stopLoss;
          exitIdx = f;
          break;
        }
        if (stDirF === 'UP' || rsiF <= 25) {
          tradeOutcome = 'win';
          exitPrice = k.close;
          exitIdx = f;
          break;
        }
      }
    }

    if (tradeOutcome === 'timeout') {
      const lastIdx = Math.min(i + forwardWindow, klines.length - 1);
      exitPrice = klines[lastIdx].close;
      exitIdx = lastIdx;
    }

    const pnlPct = signal === 'BUY'
      ? (exitPrice - entry) / entry * 100
      : (entry - exitPrice) / entry * 100;

    if (tradeOutcome === 'win') {
      wins++;
      totalGainPct += pnlPct;
    } else if (tradeOutcome === 'loss') {
      losses++;
      totalLossPct += Math.abs(pnlPct);
    } else {
      timeouts++;
      if (pnlPct > 0) {
        totalGainPct += pnlPct;
      } else {
        totalLossPct += Math.abs(pnlPct);
      }
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
    label: `últimas ${actualWindow} velas (${interval})`,
    forwardLabel: interval === '5m' ? '48 hs max' : interval === '1h' ? '3 días max' : '15 días max',
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
    let s2 = 0;
    if      (rsi < cfg.rsiOversold)   s2 += 1;
    else if (rsi > cfg.rsiOverbought) s2 -= 1;
    else if (rsi > 50)                s2 += 1;
    else                              s2 -= 1;

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

    const w1 = s1 * weights.trend;
    const w2 = s2 * weights.rsi;
    const w3 = s3 * weights.bollinger;
    const w4 = s4 * weights.volume;
    const w5 = s5 * weights.candle;
    const totalScore = w1 + w2 + w3 + w4 + w5;

    const maxTrend = cfg.emaMajor ? 2 : 1;
    const maxPossible = (maxTrend * weights.trend) + weights.rsi + weights.bollinger + weights.volume + weights.candle;
    const threshold = maxPossible * 0.5;

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if      (totalScore >=  threshold) signal = 'BUY';
    else if (totalScore <= -threshold) signal = 'SELL';

    signals[i] = signal;
  }

  return signals;
}

