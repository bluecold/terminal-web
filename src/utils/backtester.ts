import type { Kline } from '../services/api';
import { simulateTrade, type TradeLevels } from './tradeSimulator';
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
  checkBullishDivergence,
  checkBearishDivergence,
  candleBodyRatio,
  closePosition,
  upperWickRatio,
  lowerWickRatio,
  calculateRevolutionVolatilityBand,
  calculateVolumeComposition,
  calculateAndianOscillator,
  calculateDreadBlitz,
  isNyseOpeningWindow
} from './indicators';

// ─── Result Interface ──────────────────────────────────────────────────────

export interface DiscardBreakdown {
  cooldown: number;                 // En período de enfriamiento post-operación
  sessionGap: number;               // Descartado por ventana de apertura NYSE / corte de sesión
  insufficientData: number;          // Warmup/barras insuficientes para calcular indicadores
  regimeFilter: number;              // Filtro macro no superado (ADX < 20, slope <= 0, RSI fuera de rango)
  noSetup: number;                   // Sin patrón técnico / señal NEUTRAL
  setupExpiredOrInvalidated: number; // Setup de 3h expiró o perdió VWAP/EMA21 antes del trigger
  volumeFilter: number;              // RVOL insuficiente (< 0.9x o < 1.1x)
  candleAnatomy: number;             // Anatomía desfavorable (Close Position / mechas)
  riskFilter: number;                // Riesgo fuera de bandas permitidas (minRisk / maxRisk)
}

export function createEmptyDiscards(): DiscardBreakdown {
  return {
    cooldown: 0,
    sessionGap: 0,
    insufficientData: 0,
    regimeFilter: 0,
    noSetup: 0,
    setupExpiredOrInvalidated: 0,
    volumeFilter: 0,
    candleAnatomy: 0,
    riskFilter: 0,
  };
}

export interface DirectionalStats {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
}

export interface RegimeStats {
  trending: { signals: number; wins: number; losses: number; winRate: number; expectancyR: number }; // ADX > 25
  ranging:  { signals: number; wins: number; losses: number; winRate: number; expectancyR: number }; // ADX <= 25
}

export interface RecordedTrade {
  dir: 'BUY' | 'SELL';
  realizedR: number;
  pnlPct: number;
  adxAtEntry?: number;
  outcome: 'win' | 'loss' | 'neutral' | 'timeout';
  entryIdx?: number;
}

export interface SplitStats {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
}

export interface WalkForwardResult {
  isWindow: number;          // In-Sample window candle count (70%)
  oosWindow: number;         // Out-of-Sample window candle count (30%)
  inSample: SplitStats;      // Performance in historical 70%
  outOfSample: SplitStats;   // Performance in validation 30%
  passed: boolean;           // True if OOS E[R] >= 0 or no trades
  status: 'PASS' | 'FAIL' | 'NO_OOS_TRADES';
}

export function createEmptyDirectionalStats(): DirectionalStats {
  return { signals: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0, profitFactor: null };
}

export function createEmptyRegimeStats(): RegimeStats {
  return {
    trending: { signals: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0 },
    ranging:  { signals: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0 },
  };
}

export function createEmptySplitStats(): SplitStats {
  return { signals: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0, profitFactor: null, maxDrawdownR: 0 };
}

export function createEmptyWalkForwardResult(isWindow: number = 0, oosWindow: number = 0): WalkForwardResult {
  return {
    isWindow,
    oosWindow,
    inSample: createEmptySplitStats(),
    outOfSample: createEmptySplitStats(),
    passed: true,
    status: 'NO_OOS_TRADES',
  };
}

function calculateSplitStats(trades: RecordedTrade[]): SplitStats {
  if (trades.length === 0) return createEmptySplitStats();

  let wins = 0;
  let losses = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalR = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;

  for (const trade of trades) {
    totalR += trade.realizedR;
    cumR += trade.realizedR;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDrawdownR) maxDrawdownR = dd;

    if (trade.outcome === 'win') {
      wins++;
    } else if (trade.outcome === 'loss') {
      losses++;
    }

    if (trade.pnlPct > 0) {
      totalGainPct += trade.pnlPct;
    } else if (trade.pnlPct < 0) {
      totalLossPct += Math.abs(trade.pnlPct);
    }
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(2)) : 0;
  const expectancyR = trades.length > 0 ? Number((totalR / trades.length).toFixed(3)) : 0;
  const profitFactor = totalLossPct > 0 ? Number((totalGainPct / totalLossPct).toFixed(2)) : (totalGainPct > 0 ? null : 1.0);

  return {
    signals: trades.length,
    wins,
    losses,
    winRate,
    expectancyR,
    profitFactor,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
  };
}

export function calculateWalkForward(
  trades: RecordedTrade[],
  oldestIdx: number,
  latestIdx: number,
  splitRatio: number = 0.70,
  minOosTrades: number = 5
): WalkForwardResult {
  const totalCandles = Math.max(1, latestIdx - oldestIdx + 1);
  const isWindow = Math.round(totalCandles * splitRatio);
  const oosWindow = Math.max(0, totalCandles - isWindow);
  const splitIdx = oldestIdx + isWindow;

  const isTrades = trades.filter(t => t.entryIdx !== undefined && t.entryIdx < splitIdx);
  const oosTrades = trades.filter(t => t.entryIdx !== undefined && t.entryIdx >= splitIdx);

  const inSample = calculateSplitStats(isTrades);
  const outOfSample = calculateSplitStats(oosTrades);

  let passed = false;
  let status: 'PASS' | 'FAIL' | 'NO_OOS_TRADES' = 'NO_OOS_TRADES';

  if (oosTrades.length === 0) {
    status = 'NO_OOS_TRADES';
    passed = false;
  } else if (oosTrades.length < minOosTrades) {
    // If the few OOS trades are already net negative, mark as FAIL
    if (outOfSample.expectancyR < 0 || (outOfSample.profitFactor !== null && outOfSample.profitFactor < 1.0)) {
      status = 'FAIL';
      passed = false;
    } else {
      // Insufficient sample to statistically validate out-of-sample edge
      status = 'NO_OOS_TRADES';
      passed = false;
    }
  } else if (outOfSample.expectancyR >= 0 && (outOfSample.profitFactor === null || outOfSample.profitFactor >= 1.0)) {
    status = 'PASS';
    passed = true;
  } else {
    status = 'FAIL';
    passed = false;
  }

  return {
    isWindow,
    oosWindow,
    inSample,
    outOfSample,
    passed,
    status,
  };
}

export interface RiskMetricsResult {
  maxDrawdownR: number;
  maxLossStreak: number;
  sortinoRatio: number | null;
  longStats: DirectionalStats;
  shortStats: DirectionalStats;
  regimeStats: RegimeStats;
}

export function calculateRiskMetrics(trades: RecordedTrade[]): RiskMetricsResult {
  if (trades.length === 0) {
    return {
      maxDrawdownR: 0,
      maxLossStreak: 0,
      sortinoRatio: null,
      longStats: createEmptyDirectionalStats(),
      shortStats: createEmptyDirectionalStats(),
      regimeStats: createEmptyRegimeStats(),
    };
  }

  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let currentLossStreak = 0;
  let maxLossStreak = 0;
  let downsideSumSq = 0;
  let totalR = 0;

  let longSignals = 0, longWins = 0, longLosses = 0, longGainPct = 0, longLossPct = 0, longTotalR = 0;
  let shortSignals = 0, shortWins = 0, shortLosses = 0, shortGainPct = 0, shortLossPct = 0, shortTotalR = 0;

  let trendSignals = 0, trendWins = 0, trendLosses = 0, trendTotalR = 0;
  let rangeSignals = 0, rangeWins = 0, rangeLosses = 0, rangeTotalR = 0;

  for (const trade of trades) {
    totalR += trade.realizedR;
    cumR += trade.realizedR;
    if (cumR > peakR) {
      peakR = cumR;
    }
    const dd = peakR - cumR;
    if (dd > maxDrawdownR) {
      maxDrawdownR = dd;
    }

    if (trade.realizedR < 0) {
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) {
        maxLossStreak = currentLossStreak;
      }
      downsideSumSq += Math.pow(Math.abs(trade.realizedR), 2);
    } else {
      currentLossStreak = 0;
    }

    if (trade.dir === 'BUY') {
      longSignals++;
      longTotalR += trade.realizedR;
      if (trade.realizedR > 0) {
        longWins++;
        longGainPct += trade.pnlPct;
      } else if (trade.realizedR < 0) {
        longLosses++;
        longLossPct += Math.abs(trade.pnlPct);
      }
    } else if (trade.dir === 'SELL') {
      shortSignals++;
      shortTotalR += trade.realizedR;
      if (trade.realizedR > 0) {
        shortWins++;
        shortGainPct += trade.pnlPct;
      } else if (trade.realizedR < 0) {
        shortLosses++;
        shortLossPct += Math.abs(trade.pnlPct);
      }
    }

    const adx = trade.adxAtEntry;
    const isTrending = (adx !== undefined && !isNaN(adx)) ? adx > 25 : false;
    if (isTrending) {
      trendSignals++;
      trendTotalR += trade.realizedR;
      if (trade.realizedR > 0) trendWins++;
      else if (trade.realizedR < 0) trendLosses++;
    } else {
      rangeSignals++;
      rangeTotalR += trade.realizedR;
      if (trade.realizedR > 0) rangeWins++;
      else if (trade.realizedR < 0) rangeLosses++;
    }
  }

  let sortinoRatio: number | null = null;
  if (downsideSumSq > 0 && trades.length > 0) {
    const downsideDev = Math.sqrt(downsideSumSq / trades.length);
    const meanR = totalR / trades.length;
    if (downsideDev > 0) {
      sortinoRatio = Number((meanR / downsideDev).toFixed(2));
    }
  }

  const longResolved = longWins + longLosses;
  const longWR = longResolved > 0 ? Number((longWins / longResolved).toFixed(2)) : 0;
  const longExpR = longSignals > 0 ? Number((longTotalR / longSignals).toFixed(3)) : 0;
  const longPF = longLossPct > 0 ? Number((longGainPct / longLossPct).toFixed(2)) : (longGainPct > 0 ? null : 1.0);

  const shortResolved = shortWins + shortLosses;
  const shortWR = shortResolved > 0 ? Number((shortWins / shortResolved).toFixed(2)) : 0;
  const shortExpR = shortSignals > 0 ? Number((shortTotalR / shortSignals).toFixed(3)) : 0;
  const shortPF = shortLossPct > 0 ? Number((shortGainPct / shortLossPct).toFixed(2)) : (shortGainPct > 0 ? null : 1.0);

  const trendResolved = trendWins + trendLosses;
  const trendWR = trendResolved > 0 ? Number((trendWins / trendResolved).toFixed(2)) : 0;
  const trendExpR = trendSignals > 0 ? Number((trendTotalR / trendSignals).toFixed(3)) : 0;

  const rangeResolved = rangeWins + rangeLosses;
  const rangeWR = rangeResolved > 0 ? Number((rangeWins / rangeResolved).toFixed(2)) : 0;
  const rangeExpR = rangeSignals > 0 ? Number((rangeTotalR / rangeSignals).toFixed(3)) : 0;

  return {
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    maxLossStreak,
    sortinoRatio,
    longStats: {
      signals: longSignals,
      wins: longWins,
      losses: longLosses,
      winRate: longWR,
      expectancyR: longExpR,
      profitFactor: longPF,
    },
    shortStats: {
      signals: shortSignals,
      wins: shortWins,
      losses: shortLosses,
      winRate: shortWR,
      expectancyR: shortExpR,
      profitFactor: shortPF,
    },
    regimeStats: {
      trending: {
        signals: trendSignals,
        wins: trendWins,
        losses: trendLosses,
        winRate: trendWR,
        expectancyR: trendExpR,
      },
      ranging: {
        signals: rangeSignals,
        wins: rangeWins,
        losses: rangeLosses,
        winRate: rangeWR,
        expectancyR: rangeExpR,
      },
    },
  };
}

export function createFallbackBacktestResult(
  label: string = 'datos insuficientes',
  forwardLabel: string = 'ventana 6 velas'
): BacktestResult {
  return {
    totalSignals: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    winRate: 0,
    resolutionRate: 0,
    profitFactor: null,
    expectancy: 0,
    expectancyR: 0,
    expectancyPerHour: 0,
    avgExposureHours: 0,
    avgDurationCandles: 0,
    maxDrawdownR: 0,
    maxLossStreak: 0,
    sortinoRatio: null,
    longStats: createEmptyDirectionalStats(),
    shortStats: createEmptyDirectionalStats(),
    regimeStats: createEmptyRegimeStats(),
    walkForward: createEmptyWalkForwardResult(),
    neutrals: 0,
    discards: createEmptyDiscards(),
    label,
    forwardLabel,
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true,
  };
}

export interface BacktestResult {
  totalSignals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;              // wins / resolved (wins + losses) — trades that reached an outcome
  resolutionRate: number;       // resolved / totalSignals — what % of signals reached target or stop
  profitFactor: number | null;  // total gains / total losses (>1 = profitable, null when losses = 0)
  expectancy: number;           // expected % gain per trade
  expectancyR: number;          // expected R per trade
  expectancyPerHour: number;    // expected R per hour of capital exposure
  avgExposureHours: number;     // average trade duration in hours
  avgDurationCandles: number;   // average trade duration in candles
  maxDrawdownR: number;         // maximum peak-to-trough drawdown in R units
  maxLossStreak: number;        // maximum consecutive losing trades
  sortinoRatio: number | null;  // downside risk-adjusted return (E[R] / downside_dev)
  longStats: DirectionalStats;  // statistics for BUY (Long) signals
  shortStats: DirectionalStats; // statistics for SELL (Short) signals
  regimeStats: RegimeStats;     // statistics by regime (ADX > 25 vs ADX <= 25)
  walkForward?: WalkForwardResult; // In-Sample (70%) vs Out-of-Sample (30%) validation
  neutrals: number;             // skipped NEUTRAL candles (sum of all discards)
  discards: DiscardBreakdown;   // Granular discard breakdown for diagnostics
  label: string;                // e.g. "últimas 150 velas"
  forwardLabel: string;         // e.g. "ventana 6 velas (30 min)"
  threshold: number;            // stop loss threshold used (adaptive)
  targetThreshold: number;      // take profit threshold (threshold × targetMultiplier)
  targetMultiplier: number;     // risk/reward ratio (e.g. 1.5 = 1:1.5 R:R)
  insufficient: boolean;        // true if not enough data
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
  cooldownPeriod: number;      // 2h/24 candles for 5m, 4h/4 candles for 1h, 3d/3 candles for 1d
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
        cooldownPeriod: 24,            // 2 hours = 24 candles of 5m (matches AI_CONTEXT.md & App.tsx)
      };
    case '1d':
      return {
        evalWindow: 60,                // 60 days
        forwardWindow: 3,
        forwardLabel: '3 velas (3 días)',
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
        cooldownPeriod: 3,             // 3 days
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
        cooldownPeriod: 4,             // 4 hours = 4 candles of 1h
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
  realizedR: number;
  durationCandles: number;
}

function evaluateOutcome(
  klines: Kline[],
  entryIdx: number,
  signal: 'BUY' | 'SELL',
  forwardWindow: number,
  stopThreshold: number,
  targetThreshold: number
): TradeOutcome {
  const nextIdx = entryIdx + 1 < klines.length ? entryIdx + 1 : entryIdx;
  const entry = klines[nextIdx].open || klines[entryIdx].close;
  const levels: TradeLevels = {
    entryPrice: entry,
    stopLoss: signal === 'BUY' ? entry * (1 - stopThreshold) : entry * (1 + stopThreshold),
    takeProfit1: signal === 'BUY' ? entry * (1 + targetThreshold) : entry * (1 - targetThreshold)
  };
  const sim = simulateTrade(klines, entryIdx, signal, levels, {
    forwardWindow,
    enablePartials: false,
    frictionPct: 0.08
  });
  return {
    result: sim.outcome,
    pnlPct: sim.pnlPct,
    realizedR: sim.realizedR,
    durationCandles: Math.max(1, sim.exitIdx - entryIdx)
  };
}

// ─── Cache Layer for Backtesting Performance ──────────────────────────────
const backtestCache = new Map<string, { fingerprint: string; result: BacktestResult }>();

function getKlinesFingerprint(seriesList: (Kline[] | undefined)[]): string {
  let fp = '';
  for (let i = 0; i < seriesList.length; i++) {
    const s = seriesList[i];
    if (s && s.length > 0) {
      const last = s[s.length - 1];
      const prev = s.length > 1 ? s[s.length - 2] : null;
      const lastOhlcv = `${last.time}_${last.open}_${last.high}_${last.low}_${last.close}_${last.volume}`;
      const prevMetrics = prev ? `${prev.close}_${prev.volume}` : '0_0';
      fp += `${s.length}_${lastOhlcv}_${prevMetrics}|`;
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
  const evalWindow = style === 'swing' ? 168 : 576;
  const stepSec = klines5m.length > 1 ? (klines5m[1].time - klines5m[0].time) : (style === 'swing' ? 3600 : 300);
  const forwardWindow = style === 'swing'
    ? (stepSec === 300 ? 576 : 48)  // 576 x 5m = 48h OR 48 x 1h = 48h
    : 72;                            // 72 x 5m = 6h (Intradía)
  const cooldownHours = style === 'swing' ? 4 : 2;
  const candlesPerHour = Math.max(1, Math.round(3600 / (stepSec || 300)));
  const cooldownPeriod = cooldownHours * candlesPerHour;  // 4h cooldown for Swing, 2h for DayTrading
  const isSessionBased = hasSessionGaps(klines5m, tf);

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, profitFactor: null, expectancy: 0,
    expectancyR: 0, expectancyPerHour: 0, avgExposureHours: 0, avgDurationCandles: 0,
    maxDrawdownR: 0, maxLossStreak: 0, sortinoRatio: null,
    longStats: createEmptyDirectionalStats(),
    shortStats: createEmptyDirectionalStats(),
    regimeStats: createEmptyRegimeStats(),
    walkForward: createEmptyWalkForwardResult(),
    neutrals: 0,
    discards: createEmptyDiscards(),
    label: `datos insuficientes`,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '6 hs max (Intradía)',
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
  const ema200_1d = closes1d.length >= 200 ? calculateEMA(closes1d, 200) : new Array(closes1d.length).fill(NaN);
  const ema50_1d = closes1d.length >= 50 ? calculateEMA(closes1d, 50) : new Array(closes1d.length).fill(NaN);
  const adxData1d = calculateADXSeries(klines1d, 14);

  // 1H series
  const closes1h = klines1h.map(k => k.close);
  const ema200_1h = closes1h.length >= 200 ? calculateEMA(closes1h, 200) : new Array(closes1h.length).fill(NaN);
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
  for (let i = 20; i < vol5m.length; i++) {
    volSma5m[i] = volSum5m / 20; // Trailing 20 bars (i-20 to i-1), strictly excluding candle i
    volSum5m = volSum5m - vol5m[i - 20] + vol5m[i]; // Update sum including candle i for the next index
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
  const discards = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
  let nextAllowedIdx = 0;
  const recordedTrades: RecordedTrade[] = [];

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

  // ── Pre-calculate Session Boundaries & Opening Range Map O(N) ───────
  const sessionStartMap = new Int32Array(klines5m.length);
  const openingRangeMap: Array<{ high: number; low: number; isActive: boolean }> = new Array(klines5m.length);
  let curStart = 0;
  let curHigh = -Infinity;
  let curLow = Infinity;
  let curCount = 0;
  const isCryptoAsset = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
  const offsetSec = isCryptoAsset ? 0 : 18000;
  const expectedStepSec = tf === '5m' ? 300 : 3600;

  for (let i = 0; i < klines5m.length; i++) {
    const isNew = i === 0 || (isSessionBased
      ? (klines5m[i].time - klines5m[i - 1].time > expectedStepSec * 3)
      : (Math.floor((klines5m[i].time - offsetSec) / 86400) !== Math.floor((klines5m[i - 1].time - offsetSec) / 86400)));

    if (isNew) {
      curStart = i;
      curHigh = -Infinity;
      curLow = Infinity;
      curCount = 0;
    }
    sessionStartMap[i] = curStart;

    if (curCount < 6) {
      if (klines5m[i].high > curHigh) curHigh = klines5m[i].high;
      if (klines5m[i].low < curLow) curLow = klines5m[i].low;
      curCount++;
    }

    openingRangeMap[i] = (i - curStart >= 6)
      ? { high: curHigh, low: curLow, isActive: true }
      : { high: 0, low: 0, isActive: false };
  }

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && isNearSessionEnd(klines5m, i, tf, 6)) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const curr = klines5m[i];
    const prev = klines5m[i - 1];

    // ── LAYER 1: Daily Bias 1D ───────────────────────────────────────────
    const idx1d = idx1dMap[i];
    if (idx1d < 50) { discards.insufficientData++; neutrals++; continue; } // EMA50(1D) needs 50 bars to converge

    const lastEma200_1d = ema200_1d[idx1d];
    const lastEma50_1d = ema50_1d[idx1d];
    const lastClose1d = closes1d[idx1d];

    const lastAdx1d = adxData1d.adx[idx1d];
    const lastPlusDI1d = adxData1d.plusDI[idx1d];
    const lastMinusDI1d = adxData1d.minusDI[idx1d];

    if (isNaN(lastAdx1d) || isNaN(lastEma50_1d)) { discards.insufficientData++; neutrals++; continue; }

    const lastEma200Ref = !isNaN(lastEma200_1d) ? lastEma200_1d : lastEma50_1d;
    const hasDailyTrend = !isNaN(lastEma200Ref) && !isNaN(lastEma50_1d) && !isNaN(lastAdx1d);
    let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
    if (hasDailyTrend) {
      const bias_long = lastClose1d > lastEma200Ref && (isNaN(lastEma200_1d) ? true : lastEma50_1d > lastEma200_1d) && lastAdx1d > 20 && lastPlusDI1d > lastMinusDI1d;
      const bias_short = lastClose1d < lastEma200Ref && (isNaN(lastEma200_1d) ? true : lastEma50_1d < lastEma200_1d) && lastAdx1d > 20 && lastMinusDI1d > lastPlusDI1d;

      if (bias_long) bias1D = 'ALCISTA';
      else if (bias_short) bias1D = 'BAJISTA';
    }

    // ── LAYER 2: 1H Setup (Stateless State Machine + ADX/EMA200 Slope Regime) ──
    const idx1h = idx1hMap[i];
    if (idx1h < 50) { discards.insufficientData++; neutrals++; continue; }

    const rsiVal1h = rsiSeries1h[idx1h];
    const atrVal1h = atrSeries1h[idx1h];
    const vwapVal1h = vwapSeries1h[idx1h];
    const macdHist1h = macdData1h.histogram[idx1h];
    const macdHistPrev1h = idx1h > 0 ? macdData1h.histogram[idx1h - 1] : NaN;

    if (isNaN(vwapVal1h) || isNaN(rsiVal1h) || isNaN(atrVal1h)) {
      discards.insufficientData++;
      neutrals++;
      continue;
    }

    const isSetupLongCandle = (hIdx: number) => {
      const hist = macdData1h.histogram[hIdx];
      const prevHist = macdData1h.histogram[hIdx - 1];
      const ema200Val = !isNaN(ema200_1h[hIdx]) ? ema200_1h[hIdx] : ema50_1h[hIdx];
      const ema200Prev5 = hIdx >= 5 ? (!isNaN(ema200_1h[hIdx - 5]) ? ema200_1h[hIdx - 5] : ema50_1h[hIdx - 5]) : ema200Val;
      const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
      const adxVal = adxSeries1h.adx[hIdx];
      const regimeOkLong = adxVal > 20 && slope > 0;

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
      const ema200Val = !isNaN(ema200_1h[hIdx]) ? ema200_1h[hIdx] : ema50_1h[hIdx];
      const ema200Prev5 = hIdx >= 5 ? (!isNaN(ema200_1h[hIdx - 5]) ? ema200_1h[hIdx - 5] : ema50_1h[hIdx - 5]) : ema200Val;
      const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
      const adxVal = adxSeries1h.adx[hIdx];
      const regimeOkShort = adxVal > 20 && slope < 0;

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
    if (!bb) { discards.insufficientData++; neutrals++; continue; }

    const vwap5m = vwapSeries5m[i];
    const ema9Val = ema9_5m[i];
    const ema21Val = ema21_5m[i];
    const rsi5m = rsiSeries5m[i];
    const atr5m = atrSeries5m[i];
    const volCurr5m = vol5m[i];
    
    // Rolling Volume SMA-20 RVOL O(1) with strict zero guard
    const volAvg5m = volSma5m[i] > 0 ? volSma5m[i] : (volCurr5m || 1);
    const rvol = volAvg5m > 0 ? volCurr5m / volAvg5m : 1.0;

    if (isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema21Val) || isNaN(rsi5m) || isNaN(atr5m)) {
      discards.insufficientData++; neutrals++; continue;
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
      const rvol = (volSma5m[idx] && volSma5m[idx] > 0) ? k.volume / volSma5m[idx] : 1.0;

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
      if (idx < 10) return false;
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
      if (idx < 10) return false;
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
                             rvol >= 1.5 &&
                             curr.close > vwap5m;

    const minPrevLow3 = Math.min(klines5m[i - 1].low, klines5m[i - 2].low, klines5m[i - 3].low);
    const condPullbackShort = triggerMode === 'agresivo' &&
                              (hasPullbackShort(i) || hasPullbackShort(i - 1) || hasPullbackShort(i - 2)) &&
                              curr.close < minPrevLow3 &&
                              curr.close < curr.open &&
                              rvol >= 1.8 &&
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
      const orb = openingRangeMap[i];
      const prevOrb = i > 0 ? openingRangeMap[i - 1] : orb;

      const rvolBreakoutLong = (volSma5m[i - 1] && volSma5m[i - 1] > 0) ? vol5m[i - 1] / volSma5m[i - 1] : 1.0;
      const breakoutLongPrev = prevOrb.isActive &&
                               prev.close > prevOrb.high + 0.10 * atrSeries5m[i - 1] &&
                               bbIdx > 0 && prev.close > bbSeries5m[bbIdx - 1].upper &&
                               rvolBreakoutLong >= 1.5 &&
                               (prev.close - bbSeries5m[bbIdx - 1].upper) <= 1.0 * atrSeries5m[i - 1];

      // Bug #1 fix: changed curr.low > orb.high to curr.close > orb.high.
      // Requiring the candle LOW to be above the ORB is nearly impossible in practice.
      condBreakoutLong = squeezePrev && breakoutLongPrev && curr.close > orb.high;

      const rvolBreakoutShort = (volSma5m[i - 1] && volSma5m[i - 1] > 0) ? vol5m[i - 1] / volSma5m[i - 1] : 1.0;
      const breakoutShortPrev = prevOrb.isActive &&
                                prev.close < prevOrb.low - 0.10 * atrSeries5m[i - 1] &&
                                bbIdx > 0 && prev.close < bbSeries5m[bbIdx - 1].lower &&
                                rvolBreakoutShort >= 1.8 &&
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
      const sessionStartIdx = sessionStartMap[i];
      const unitMinutes = style === 'swing' ? 60 : 5;
      return (i - sessionStartIdx + (style === 'swing' ? 1 : 0)) * unitMinutes;
    })();

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
    const distRatio = Math.abs(curr.close - ema21Val) / (atr5m || 1);
    const distScore = 0.15 * Math.max(0, 1.0 - Math.abs(distRatio - 0.5) / 1.0);
    const vwapScore = 0.10 * (signal === 'BUY' ? (curr.close > vwap5m ? 1 : 0) : (curr.close < vwap5m ? 1 : 0));
    const confidenceScore = Number((volScore + macroScore + macdScore + distScore + vwapScore).toFixed(2));

    if (signal !== 'NEUTRAL' && confidenceScore < 0.65) {
      signal = 'NEUTRAL';
    }

    if (signal === 'NEUTRAL') {
      if (!setupArmedLong && !setupArmedShort) {
        discards.regimeFilter++;
      } else if (rvol < (isCryptoAsset ? 1.5 : 1.2)) {
        discards.volumeFilter++;
      } else if (upperWickRatio(curr) > 0.35 || lowerWickRatio(curr) > 0.35 || candleBodyRatio(curr) < 0.3) {
        discards.candleAnatomy++;
      } else {
        discards.noSetup++;
      }
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
        discards.riskFilter++;
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
        discards.riskFilter++;
        neutrals++;
        continue;
      }
    } else {
      const slATR = entry + atrMultShort * atr5m;
      const slStruct = swingHigh > 0 ? (swingHigh + 0.20 * atr5m) : slATR;
      stopLoss = Math.max(slATR, slStruct);
      let risk = stopLoss - entry;
      if (risk <= 0) {
        discards.riskFilter++;
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
        discards.riskFilter++;
        neutrals++;
        continue;
      }
    }

    const risk = Math.abs(entry - stopLoss);
    const tp1 = signal === 'BUY' ? entry + risk * tp1Mult : entry - risk * tp1Mult;
    const tp2 = signal === 'BUY' ? entry + risk * tp2Mult : entry - risk * tp2Mult;
    const tp3 = signal === 'BUY' ? entry + risk * tp3Mult : entry - risk * tp3Mult;

    totalSignals++;

    const levels: TradeLevels = {
      entryPrice: entry,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3
    };

    const sim = simulateTrade(klines5m, i, signal, levels, {
      forwardWindow,
      enablePartials: true,
      moveSlToBreakevenOnTp1: true,
      timeStopBars: tradeType === 'DAY' ? 8 : 0,
      trailingStop: 'chandelier',
      emergencyExitFn: (k, idx, dir) => {
        return dir === 'BUY'
          ? (k.close < vwapSeries5m[idx] && k.close < ema21_5m[idx])
          : (k.close > vwapSeries5m[idx] && k.close > ema21_5m[idx]);
      },
      sessionGapCutoff: isSessionBased,
      stepSec,
      atrSeries: atrSeries5m,
      ema9Series: ema9_5m,
      frictionPct: 0.08
    });

    totalRealizedR += sim.realizedR;
    totalDurationCandles += Math.max(1, sim.exitIdx - i);

    const adxVal = idx1h >= 0 && idx1h < adxSeries1h.adx.length ? adxSeries1h.adx[idx1h] : undefined;
    recordedTrades.push({
      dir: signal as 'BUY' | 'SELL',
      realizedR: sim.realizedR,
      pnlPct: sim.pnlPct,
      adxAtEntry: (adxVal !== undefined && !isNaN(adxVal)) ? adxVal : undefined,
      outcome: sim.outcome,
      entryIdx: i,
    });

    if (sim.outcome === 'win') {
      wins++;
    } else if (sim.outcome === 'loss') {
      losses++;
    } else {
      timeouts++;
    }

    if (sim.pnlPct > 0) {
      totalGainPct += sim.pnlPct;
    } else if (sim.pnlPct < 0) {
      totalLossPct += Math.abs(sim.pnlPct);
    }

    nextAllowedIdx = sim.exitIdx + cooldownPeriod;
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? Number((totalGainPct / totalLossPct).toFixed(2)) : null;

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const candleHours = style === 'swing' ? (stepSec === 300 ? 5 / 60 : 1.0) : 5 / 60;
  const avgExposureHours = Number((avgDurationCandles * candleHours).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const minOosTrades = style === 'swing' ? 3 : 5;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades);

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor,
    expectancy: Number(expectancy.toFixed(3)),
    expectancyR,
    expectancyPerHour,
    avgExposureHours,
    avgDurationCandles,
    ...riskMetrics,
    walkForward,
    neutrals,
    discards,
    label: `últimas ${actualWindow} velas (${style === 'swing' ? '1h' : '5m'})`,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '6 hs max (Intradía)',
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
      winRate: 0, resolutionRate: 0, profitFactor: null, expectancy: 0,
      expectancyR: 0, expectancyPerHour: 0, avgExposureHours: 0, avgDurationCandles: 0,
      maxDrawdownR: 0, maxLossStreak: 0, sortinoRatio: null,
      longStats: createEmptyDirectionalStats(),
      shortStats: createEmptyDirectionalStats(),
      regimeStats: createEmptyRegimeStats(),
      walkForward: createEmptyWalkForwardResult(),
      neutrals: 0,
      discards: createEmptyDiscards(),
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

  const adxSeries  = calculateADXSeries(klines, 14);
  const recordedTrades: RecordedTrade[] = [];

  let totalSignals = 0;
  let wins         = 0;
  let losses       = 0;
  let timeouts     = 0;
  let neutrals     = 0;
  const discards   = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;

  let nextAllowedIdx = 0;

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && (interval === '5m' || interval === '1h')) {
      if (isNearSessionEnd(klines, i, interval, forwardWindow)) {
        discards.sessionGap++;
        neutrals++;
        continue;
      }
    }

    const signal = signals[i] || 'NEUTRAL';

    if (signal === 'NEUTRAL') {
      discards.noSetup++;
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

    totalRealizedR += outcome.realizedR;
    totalDurationCandles += outcome.durationCandles;

    const adxVal = (i >= 0 && i < adxSeries.adx.length) ? adxSeries.adx[i] : undefined;
    recordedTrades.push({
      dir: signal as 'BUY' | 'SELL',
      realizedR: outcome.realizedR,
      pnlPct: outcome.pnlPct,
      adxAtEntry: (adxVal !== undefined && !isNaN(adxVal)) ? adxVal : undefined,
      outcome: outcome.result,
      entryIdx: i,
    });

    if (outcome.result === 'win') {
      wins++;
    } else if (outcome.result === 'loss') {
      losses++;
    } else {
      timeouts++;
    }

    if (outcome.pnlPct > 0) {
      totalGainPct += outcome.pnlPct;
    } else if (outcome.pnlPct < 0) {
      totalLossPct += Math.abs(outcome.pnlPct);
    }

    nextAllowedIdx = i + Math.max(forwardWindow + 1, params.cooldownPeriod);
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;
  const profitFactor = totalLossPct > 0 ? Number((totalGainPct / totalLossPct).toFixed(2)) : null;

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const candleHours = interval === '5m' ? (5 / 60) : interval === '1h' ? 1.0 : 24.0;
  const avgExposureHours = Number((avgDurationCandles * candleHours).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const minOosTrades = interval === '1h' ? 3 : interval === '1d' ? 2 : 5;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades);

  return {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor,
    expectancy: Number(expectancy.toFixed(3)),
    expectancyR,
    expectancyPerHour,
    avgExposureHours,
    avgDurationCandles,
    ...riskMetrics,
    walkForward,
    neutrals,
    discards,
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

  // Cache at aligned checkpoints (interval = 5, matching 5-bar pivot confirmation).
  // Queries use the most recent checkpoint at or before the evaluated candle, avoiding look-ahead bias.
  const srCacheInterval = 5;
  const srCache: Map<number, { nearestSupport: number; nearestResistance: number }> = new Map();
  const startIdx = Math.max(0, Math.floor(55 / srCacheInterval) * srCacheInterval);
  for (let idx = startIdx; idx < length; idx += srCacheInterval) {
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
    winRate: 0, resolutionRate: 0, profitFactor: null, expectancy: 0,
    expectancyR: 0, expectancyPerHour: 0, avgExposureHours: 0, avgDurationCandles: 0,
    maxDrawdownR: 0, maxLossStreak: 0, sortinoRatio: null,
    longStats: createEmptyDirectionalStats(),
    shortStats: createEmptyDirectionalStats(),
    regimeStats: createEmptyRegimeStats(),
    walkForward: createEmptyWalkForwardResult(),
    neutrals: 0,
    discards: createEmptyDiscards(),
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
  const adxData5M = calculateADXSeries(klines5m, 14);
  const atrSeries5M = calculateATRSeries(klines5m, 14);
  const recordedTrades: RecordedTrade[] = [];

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let neutrals = 0;
  const discards = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
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
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && isNearSessionEnd(klines5m, i, '5m', forwardWindow)) {
      discards.sessionGap++;
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
      discards.insufficientData++;
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
      discards.noSetup++;
      neutrals++;
      continue;
    }

    // Realistic execution: entry at next open
    const nextIdx = i + 1 < klines5m.length ? i + 1 : i;
    const entryPrice = klines5m[nextIdx].open || curr.close;

    // Risk validation and bounding (minRisk / maxRisk and strict directional check)
    const atr5m = (i >= 0 && i < atrSeries5M.length && !isNaN(atrSeries5M[i]) && atrSeries5M[i] > 0)
      ? atrSeries5M[i]
      : (entryPrice * 0.005);
    const minRisk = 0.8 * atr5m;
    const maxRisk = 2.0 * atr5m;
    const maxAllowedRiskPct = 0.025; // 2.5% max risk for 12-candle horizon

    let risk = signal === 'BUY' ? entryPrice - stopLossPrice : stopLossPrice - entryPrice;
    const isValidDirectionalRisk = signal === 'BUY' ? stopLossPrice < entryPrice : stopLossPrice > entryPrice;

    // Reject zero-risk, inverted SL or degenerated setups BEFORE incrementing totalSignals
    if (!isValidDirectionalRisk || risk <= 0) {
      discards.riskFilter++;
      neutrals++;
      continue;
    }

    // Enforce minimum risk floor to prevent immediate noise stop-outs
    if (risk < minRisk) {
      stopLossPrice = signal === 'BUY' ? entryPrice - minRisk : entryPrice + minRisk;
      risk = minRisk;
    }

    // Reject setups where stop is too wide for a 12-candle scalp
    const riskPercent = risk / entryPrice;
    if (risk > maxRisk || riskPercent > maxAllowedRiskPct) {
      discards.riskFilter++;
      neutrals++;
      continue;
    }

    totalSignals++;
    lastSignalIdx = i;

    const takeProfitPrice = signal === 'BUY'
      ? entryPrice + risk * 1.5
      : entryPrice - risk * 1.5;

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: stopLossPrice,
      takeProfit1: takeProfitPrice
    };

    const sim = simulateTrade(klines5m, i, signal, levels, {
      forwardWindow: 12,
      enablePartials: false,
      earlyAdverseCutoffBars: 3,
      earlyAdverseCutoffR: 0.5,
      frictionPct: 0.08
    });

    totalRealizedR += sim.realizedR;
    totalDurationCandles += Math.max(1, sim.exitIdx - i);

    const adxVal = (i >= 0 && i < adxData5M.adx.length) ? adxData5M.adx[i] : undefined;
    recordedTrades.push({
      dir: signal as 'BUY' | 'SELL',
      realizedR: sim.realizedR,
      pnlPct: sim.pnlPct,
      adxAtEntry: (adxVal !== undefined && !isNaN(adxVal)) ? adxVal : undefined,
      outcome: sim.outcome,
      entryIdx: i,
    });

    if (sim.outcome === 'win') {
      wins++;
    } else if (sim.outcome === 'loss') {
      losses++;
    } else {
      timeouts++;
    }

    if (sim.pnlPct > 0) {
      totalGainPct += sim.pnlPct;
    } else if (sim.pnlPct < 0) {
      totalLossPct += Math.abs(sim.pnlPct);
    }
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number((resolved / totalSignals).toFixed(3)) : 0;
  const profitFactor = totalLossPct > 0 ? Number((totalGainPct / totalLossPct).toFixed(2)) : null;
  const expectancy = totalSignals > 0 ? Number(((totalGainPct - totalLossPct) / totalSignals).toFixed(3)) : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const avgExposureHours = Number((avgDurationCandles * (5 / 60)).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, 5);

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor,
    expectancy,
    expectancyR,
    expectancyPerHour,
    avgExposureHours,
    avgDurationCandles,
    ...riskMetrics,
    walkForward,
    neutrals,
    discards,
    label: `últimas ${evalWindow} velas (5m)`,
    forwardLabel: '12 velas (1 hs max)',
    threshold: 0.01,
    targetThreshold: 0.015,
    targetMultiplier: 1.5,
    insufficient: false
  };

  return setBacktestCache(cacheKey, klines5m, res, [klines1h, klines1d]);
}
