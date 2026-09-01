import type { Kline } from '../services/api';
import { simulateTrade, type TradeLevels, type ExitReason } from './tradeSimulator';
import {
  calculateATRSeries,
  calculateADXSeries,
  calculateRegimeSeriesWithHysteresis,
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  buildConfluenciaContext,
  evaluateConfluenciaAt,
  buildScoringContext,
  evaluateScoringAt,
  buildStandardVotingContext,
  evaluateStandardVotingAt,
  buildVCMESniperContext,
  evaluateVCMESniperAt,
  buildMultifractalMTFContext,
  evaluateMultifractalMTFAt
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

export interface StructuralExitBreakdown {
  targetHits: number;      // 'TP1' | 'TP2' | 'TP3'
  stopLossHits: number;    // 'SL'
  timeStops: number;       // 'TIME_STOP'
  emergencyExits: number;  // 'EMERGENCY_EXIT' | 'EARLY_ADVERSE' | 'SESSION_GAP'
  expirations: number;     // 'TIMEOUT' (horizonte alcanzado sin TP/SL)
  breakevenExits: number;  // 'TP1_BE'
}

export function createEmptyExitBreakdown(): StructuralExitBreakdown {
  return {
    targetHits: 0,
    stopLossHits: 0,
    timeStops: 0,
    emergencyExits: 0,
    expirations: 0,
    breakevenExits: 0,
  };
}

export function calculateExitBreakdown(trades: RecordedTrade[]): StructuralExitBreakdown {
  const breakdown = createEmptyExitBreakdown();
  for (const t of trades) {
    switch (t.exitReason) {
      case 'TP1':
      case 'TP2':
      case 'TP3':
        breakdown.targetHits++;
        break;
      case 'SL':
        breakdown.stopLossHits++;
        break;
      case 'TIME_STOP':
        breakdown.timeStops++;
        break;
      case 'EMERGENCY_EXIT':
      case 'EARLY_ADVERSE':
      case 'SESSION_GAP':
        breakdown.emergencyExits++;
        break;
      case 'TIMEOUT':
        breakdown.expirations++;
        break;
      case 'TP1_BE':
        breakdown.breakevenExits++;
        break;
      default:
        if (t.outcome === 'win') breakdown.targetHits++;
        else if (t.outcome === 'loss') breakdown.stopLossHits++;
        else breakdown.expirations++;
        break;
    }
  }
  return breakdown;
}

export interface RecordedTrade {
  dir: 'BUY' | 'SELL';
  realizedR: number;
  pnlPct: number;
  adxAtEntry?: number;
  regimeAtEntry?: 'trending' | 'ranging';
  outcome: 'win' | 'loss' | 'neutral' | 'timeout';
  exitReason?: ExitReason;
  entryIdx?: number;
  executionIdx?: number;
  exitIdx?: number;
  durationCandles?: number;
}

export interface SplitStats {
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  sortinoRatio?: number | null;
  avgExposureHours?: number;
  longStats?: DirectionalStats;
  shortStats?: DirectionalStats;
  regimeStats?: RegimeStats;
}

export interface WalkForwardResult {
  isWindow: number;          // In-Sample window candle count (70%)
  oosWindow: number;         // Out-of-Sample window candle count (30%)
  inSample: SplitStats;      // Performance in historical 70%
  outOfSample: SplitStats;   // Performance in validation 30%
  purgedSignals?: number;    // Count of boundary-straddling trades purged from both partitions
  passed: boolean;           // True if OOS E[R] >= 0 or no trades
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_OOS' | 'NO_OOS_TRADES';
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
  return {
    signals: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    expectancyR: 0,
    profitFactor: null,
    maxDrawdownR: 0,
    sortinoRatio: null,
    avgExposureHours: 0,
    longStats: createEmptyDirectionalStats(),
    shortStats: createEmptyDirectionalStats(),
    regimeStats: createEmptyRegimeStats(),
  };
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

function calculateSplitStats(
  trades: RecordedTrade[],
  candleHours: number = 5 / 60,
  cooldownCandles: number = 12
): SplitStats {
  if (trades.length === 0) return createEmptySplitStats();

  const riskMetrics = calculateRiskMetrics(trades);

  let wins = 0;
  let losses = 0;
  let totalGainR = 0;
  let totalLossR = 0;
  let totalR = 0;
  let totalCycleCandles = 0;

  for (const trade of trades) {
    totalR += trade.realizedR;
    if (trade.realizedR > 0) {
      wins++;
      totalGainR += trade.realizedR;
    } else if (trade.realizedR < 0) {
      losses++;
      totalLossR += Math.abs(trade.realizedR);
    }

    const dur = trade.durationCandles ?? 6;
    totalCycleCandles += (dur + cooldownCandles);
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(2)) : 0;
  const expectancyR = trades.length > 0 ? Number((totalR / trades.length).toFixed(3)) : 0;
  const profitFactor = totalLossR > 0 ? Number((totalGainR / totalLossR).toFixed(2)) : (totalGainR > 0 ? null : 1.0);
  const avgCycleCandles = trades.length > 0 ? totalCycleCandles / trades.length : 0;
  const avgExposureHours = Number((avgCycleCandles * candleHours).toFixed(2));

  return {
    signals: trades.length,
    wins,
    losses,
    winRate,
    expectancyR,
    profitFactor,
    maxDrawdownR: riskMetrics.maxDrawdownR,
    sortinoRatio: riskMetrics.sortinoRatio,
    avgExposureHours,
    longStats: riskMetrics.longStats,
    shortStats: riskMetrics.shortStats,
    regimeStats: riskMetrics.regimeStats,
  };
}

export function calculateWalkForward(
  trades: RecordedTrade[],
  oldestIdx: number,
  latestIdx: number,
  splitRatio: number = 0.70,
  minOosTrades: number = 5,
  avgCycleCandles?: number,
  candleHours: number = 5 / 60,
  cooldownCandles: number = 12
): WalkForwardResult {
  const totalCandles = Math.max(1, latestIdx - oldestIdx + 1);
  const isWindow = Math.round(totalCandles * splitRatio);
  const oosWindow = Math.max(0, totalCandles - isWindow);
  const splitIdx = oldestIdx + isWindow;

  // Calculate physical capacity of the OOS window based on average cycle time
  const cycleTime = (avgCycleCandles && avgCycleCandles > 0) ? avgCycleCandles : 24;
  const oosCapacity = Math.max(1, Math.floor(oosWindow / cycleTime));
  // Scale requirement with window capacity while maintaining a strict floor of 2 trades
  // and capping at the nominal minOosTrades target
  const effectiveMinOos = Math.min(minOosTrades, Math.max(2, Math.floor(oosCapacity * 0.6)));

  // Purged Partitioning:
  // - inSample: trades that execute and exit strictly before splitIdx
  // - outOfSample: trades that execute at or after splitIdx
  // - purged: trades that execute before splitIdx but close at or after splitIdx (straddling boundary)
  const isTrades: RecordedTrade[] = [];
  const oosTrades: RecordedTrade[] = [];
  let purgedSignals = 0;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const execIdx = t.executionIdx !== undefined
      ? t.executionIdx
      : (t.entryIdx !== undefined ? t.entryIdx : undefined);
    const exitIdx = t.exitIdx !== undefined
      ? t.exitIdx
      : (t.entryIdx !== undefined ? t.entryIdx + (t.durationCandles ?? 1) : undefined);

    if (execIdx === undefined) continue;

    if (execIdx >= splitIdx) {
      oosTrades.push(t);
    } else if (exitIdx !== undefined && exitIdx < splitIdx) {
      isTrades.push(t);
    } else {
      // Boundary straddler: entered before splitIdx but exits in OOS
      purgedSignals++;
    }
  }

  const inSample = calculateSplitStats(isTrades, candleHours, cooldownCandles);
  const outOfSample = calculateSplitStats(oosTrades, candleHours, cooldownCandles);

  let passed = false;
  let status: 'PASS' | 'FAIL' | 'INSUFFICIENT_OOS' | 'NO_OOS_TRADES' = 'NO_OOS_TRADES';

  if (oosTrades.length === 0) {
    status = 'NO_OOS_TRADES';
    passed = false;
  } else if (oosTrades.length < effectiveMinOos) {
    // If the few OOS trades are already net negative, mark as FAIL
    if (outOfSample.expectancyR < 0 || (outOfSample.profitFactor !== null && outOfSample.profitFactor < 1.0)) {
      status = 'FAIL';
      passed = false;
    } else {
      // Positive but sample size below threshold for full certification
      status = 'INSUFFICIENT_OOS';
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
    purgedSignals,
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

  let longSignals = 0, longWins = 0, longLosses = 0, longGainR = 0, longLossR = 0, longTotalR = 0;
  let shortSignals = 0, shortWins = 0, shortLosses = 0, shortGainR = 0, shortLossR = 0, shortTotalR = 0;

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
        longGainR += trade.realizedR;
      } else if (trade.realizedR < 0) {
        longLosses++;
        longLossR += Math.abs(trade.realizedR);
      }
    } else if (trade.dir === 'SELL') {
      shortSignals++;
      shortTotalR += trade.realizedR;
      if (trade.realizedR > 0) {
        shortWins++;
        shortGainR += trade.realizedR;
      } else if (trade.realizedR < 0) {
        shortLosses++;
        shortLossR += Math.abs(trade.realizedR);
      }
    }

    const isTrending = trade.regimeAtEntry !== undefined
      ? trade.regimeAtEntry === 'trending'
      : ((trade.adxAtEntry !== undefined && !isNaN(trade.adxAtEntry)) ? trade.adxAtEntry >= 26 : false);
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
  const longPF = longLossR > 0 ? Number((longGainR / longLossR).toFixed(2)) : (longGainR > 0 ? null : 1.0);

  const shortResolved = shortWins + shortLosses;
  const shortWR = shortResolved > 0 ? Number((shortWins / shortResolved).toFixed(2)) : 0;
  const shortExpR = shortSignals > 0 ? Number((shortTotalR / shortSignals).toFixed(3)) : 0;
  const shortPF = shortLossR > 0 ? Number((shortGainR / shortLossR).toFixed(2)) : (shortGainR > 0 ? null : 1.0);

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
    exitBreakdown: createEmptyExitBreakdown(),
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
  wins: number;                 // Economic wins (realizedR > 0 after friction)
  losses: number;               // Economic losses (realizedR < 0 after friction)
  timeouts: number;             // Expirations at forward horizon (exitBreakdown.expirations)
  winRate: number;              // wins / resolved (wins + losses) — economic win rate
  resolutionRate: number;       // (targetHits + stopLossHits) / totalSignals — % of setups reaching hard TP/SL
  exitBreakdown: StructuralExitBreakdown; // Granular structural exit reasons
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

// ─── Timeframe Parameters ──────────────────────────────────────────────────

interface BacktestParams {
  evalWindow: number;
  forwardWindow: number;
  forwardLabel: string;
  fallbackThreshold: number;   // fallback if ATR can't be calculated
  atrMultiplier: number;       // ATR × this = stop threshold
  targetMultiplier: number;    // risk/reward: target = stop × this
  cooldownPeriod: number;      // 1h/12 candles for 5m, 4h/4 candles for 1h, 2d/2 candles for 1d
}

/**
 * Canonical Strategy Cooldown in Candles:
 * - 5m Intraday: 12 candles (1 hour)
 * - 1H Swing: 4 candles (4 hours)
 * - 1D Position: 2 candles (2 days / 48 hours)
 */
export function getStrategyCooldownCandles(interval: string, style: 'dayTrading' | 'swing' = 'dayTrading'): number {
  if (interval === '5m') {
    return style === 'swing' ? 48 : 12; // 12 candles of 5m = 1 hour
  }
  if (interval === '1h') {
    return 4; // 4 candles of 1h = 4 hours
  }
  if (interval === '1d') {
    return 2; // 2 candles of 1d = 2 days (48 hours)
  }
  return 12;
}

/**
 * Canonical Strategy Cooldown in Milliseconds (for Live alert throttle in App.tsx)
 */
export function getStrategyCooldownMs(interval: string, style: 'dayTrading' | 'swing' = 'dayTrading'): number {
  if (interval === '5m') {
    return style === 'swing' ? 4 * 3600 * 1000 : 1 * 3600 * 1000; // 1 hour for 5m DayTrading
  }
  if (interval === '1h') {
    return 4 * 3600 * 1000; // 4 hours for 1h Swing
  }
  if (interval === '1d') {
    return 48 * 3600 * 1000; // 48 hours for 1D Position
  }
  return 1 * 3600 * 1000;
}

function getParams(interval: string, totalCandles?: number): BacktestParams {
  switch (interval) {
    case '5m': {
      const forwardWindow = 6;
      const warmup = 30;
      const evalWindow = totalCandles && totalCandles >= 1450
        ? Math.min(1400, totalCandles - forwardWindow - warmup)
        : 576;
      return {
        evalWindow,
        forwardWindow,
        forwardLabel: '6 velas (30 min)',
        fallbackThreshold: 0.008,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
        cooldownPeriod: getStrategyCooldownCandles('5m'), // 1 hour = 12 candles of 5m (unified across all engines & Live)
      };
    }
    case '1d': {
      const forwardWindow = 3;
      return {
        evalWindow: 60,                // 60 days
        forwardWindow,
        forwardLabel: '3 velas (3 días)',
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
        cooldownPeriod: getStrategyCooldownCandles('1d'), // 2 days = 2 candles of 1d
      };
    }
    case '1h':
    default: {
      const forwardWindow = 4;
      const evalWindow = totalCandles && totalCandles >= 550
        ? Math.min(720, totalCandles - forwardWindow - 30)
        : (totalCandles && totalCandles >= 300 ? Math.min(350, totalCandles - forwardWindow - 20) : 168);
      return {
        evalWindow,
        forwardWindow,
        forwardLabel: '4 velas (4 hs)',
        fallbackThreshold: 0.012,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
        cooldownPeriod: getStrategyCooldownCandles('1h'), // 4 hours = 4 candles of 1h
      };
    }
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
  exitIdx: number;
  exitReason: ExitReason;
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
    durationCandles: Math.max(1, sim.exitIdx - entryIdx),
    exitIdx: sim.exitIdx,
    exitReason: sim.exitReason
  };
}

// ─── Cache Layer for Backtesting Performance ──────────────────────────────
const backtestCache = new Map<string, { fingerprint: string; result: BacktestResult }>();

function getKlinesFingerprint(seriesList: (Kline[] | undefined)[]): string {
  let fp = '';
  for (let sIdx = 0; sIdx < seriesList.length; sIdx++) {
    const s = seriesList[sIdx];
    if (!s || s.length === 0) {
      fp += '0:0|';
      continue;
    }
    const len = s.length;
    // FNV-1a 32-bit offset basis
    let hash = 2166136261 >>> 0;
    const startIdx = Math.max(0, len - 1500);

    for (let i = startIdx; i < len; i++) {
      const k = s[i];
      hash = (hash ^ k.time) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ (Math.round(k.open * 100000) | 0)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ (Math.round(k.high * 100000) | 0)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ (Math.round(k.low * 100000) | 0)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ (Math.round(k.close * 100000) | 0)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ (Math.round(k.volume) | 0)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    const last = s[len - 1];
    fp += `${len}:${last.time}:${hash.toString(16)}|`;
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
  const stepSec = klines5m.length > 1 ? (klines5m[1].time - klines5m[0].time) : (style === 'swing' ? 3600 : 300);
  const forwardWindow = style === 'swing'
    ? (stepSec === 300 ? 576 : 48)  // 576 x 5m = 48h OR 48 x 1h = 48h
    : 72;                            // 72 x 5m = 6h (Intradía)
  const evalWindow = style === 'swing'
    ? (klines5m.length >= 550 ? Math.min(720, klines5m.length - forwardWindow - 30) : (klines5m.length >= 300 ? Math.min(350, klines5m.length - forwardWindow - 20) : 168))
    : (klines5m.length >= 1450 ? Math.min(1400, klines5m.length - forwardWindow - 30) : 576);
  const baseEvalWindow = style === 'swing' ? 168 : 576;
  const minRequiredCandles = baseEvalWindow + forwardWindow;
  const cooldownPeriod = getStrategyCooldownCandles(tf, style);
  const isSessionBased = hasSessionGaps(klines5m, tf);

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, exitBreakdown: createEmptyExitBreakdown(), profitFactor: null, expectancy: 0,
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
  if (!klines5m || klines5m.length < minRequiredCandles) return fallbackResult;
  if (!klines1h || klines1h.length < 60) return fallbackResult;
  if (!klines1d || klines1d.length < 30) return fallbackResult;

  const latestEvalIdx = klines5m.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(30, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let neutrals = 0;
  const discards = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalGainR = 0;
  let totalLossR = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
  let totalCycleCandles = 0;
  let nextAllowedIdx = 0;
  const recordedTrades: RecordedTrade[] = [];

  const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, symbol, style, triggerMode);
  const targetAdxArray = style === 'swing' ? ctx.adxSeries1h.adx : ctx.adxSeries5m.adx;
  const regimeSeries = calculateRegimeSeriesWithHysteresis(targetAdxArray, 26.0, 22.0);

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && style === 'dayTrading' && isNearSessionEnd(klines5m, i, tf, 6)) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const entryPrice = i + 1 < klines5m.length ? klines5m[i + 1].open : klines5m[i].close;
    const evalRes = evaluateVCMESniperAt(ctx, i, entryPrice);

    if (evalRes.signal === 'NEUTRAL') {
      if (evalRes.discardReason) {
        discards[evalRes.discardReason]++;
      } else {
        discards.noSetup++;
      }
      neutrals++;
      continue;
    }

    totalSignals++;

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: evalRes.stopLoss,
      takeProfit1: evalRes.takeProfit1,
      takeProfit2: evalRes.takeProfit2,
      takeProfit3: evalRes.takeProfit3
    };

    const sim = simulateTrade(klines5m, i, evalRes.signal, levels, {
      forwardWindow,
      enablePartials: 'vcme-runner',
      moveSlToBreakevenOnTp1: true,
      timeStopBars: evalRes.tradeType === 'DAY' ? 8 : 0,
      trailingStop: 'chandelier',
      emergencyExitFn: (k, idx, dir) => {
        return dir === 'BUY'
          ? (k.close < ctx.vwapSeries5m[idx] && k.close < ctx.ema21_5m[idx])
          : (k.close > ctx.vwapSeries5m[idx] && k.close > ctx.ema21_5m[idx]);
      },
      sessionGapCutoff: isSessionBased && style === 'dayTrading',
      stepSec,
      atrSeries: ctx.atrSeries5m,
      ema9Series: ctx.ema9_5m,
      frictionPct: 0.08
    });

    totalRealizedR += sim.realizedR;
    const tradeDuration = Math.max(1, sim.exitIdx - i);
    totalDurationCandles += tradeDuration;
    totalCycleCandles += tradeDuration + cooldownPeriod;

    const adxVal = style === 'swing'
      ? (evalRes.adx1H > 0 ? evalRes.adx1H : undefined)
      : ((ctx.adxSeries5m && i >= 0 && i < ctx.adxSeries5m.adx.length && !isNaN(ctx.adxSeries5m.adx[i]))
          ? ctx.adxSeries5m.adx[i]
          : (evalRes.adx1H > 0 ? evalRes.adx1H : undefined));
    const regimeVal = style === 'swing'
      ? (ctx.idx1hMap[i] >= 0 && ctx.idx1hMap[i] < regimeSeries.length ? regimeSeries[ctx.idx1hMap[i]] : undefined)
      : ((i >= 0 && i < regimeSeries.length) ? regimeSeries[i] : undefined);
    recordedTrades.push({
      dir: evalRes.signal as 'BUY' | 'SELL',
      realizedR: sim.realizedR,
      pnlPct: sim.pnlPct,
      adxAtEntry: adxVal,
      regimeAtEntry: regimeVal,
      outcome: sim.outcome,
      exitReason: sim.exitReason,
      entryIdx: i,
      executionIdx: i + 1,
      exitIdx: sim.exitIdx,
      durationCandles: tradeDuration,
    });

    if (sim.outcome === 'win') {
      wins++;
    } else if (sim.outcome === 'loss') {
      losses++;
    }

    if (sim.realizedR > 0) {
      totalGainR += sim.realizedR;
    } else if (sim.realizedR < 0) {
      totalLossR += Math.abs(sim.realizedR);
    }

    if (sim.pnlPct > 0) {
      totalGainPct += sim.pnlPct;
    } else if (sim.pnlPct < 0) {
      totalLossPct += Math.abs(sim.pnlPct);
    }

    nextAllowedIdx = sim.exitIdx + cooldownPeriod;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = totalLossR > 0 ? Number((totalGainR / totalLossR).toFixed(2)) : (totalGainR > 0 ? null : 1.0);

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const candleHours = style === 'swing' ? (stepSec === 300 ? 5 / 60 : 1.0) : 5 / 60;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * candleHours).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const minOosTrades = style === 'swing' ? 3 : 5;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades, avgCycleCandles, candleHours, cooldownPeriod);

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    exitBreakdown,
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
  const params = getParams(interval, klines.length);
  const { evalWindow, forwardWindow, forwardLabel, targetMultiplier } = params;

  // Use the ATR available at each entry. Applying today's ATR to historical trades
  // leaks future volatility into the result.
  const atrSeries = calculateATRSeries(klines, 14);
  const latestAtr = atrSeries[atrSeries.length - 1];
  const threshold = getAdaptiveThreshold(latestAtr, klines[klines.length - 1].close, params.atrMultiplier, params.fallbackThreshold);
  const targetThreshold = threshold * targetMultiplier;
  const baseEvalWindow = interval === '5m' ? 576 : interval === '1h' ? 168 : 60;
  const minCandles = baseEvalWindow + forwardWindow;
  if (klines.length < minCandles) {
    return {
      totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
      winRate: 0, resolutionRate: 0, exitBreakdown: createEmptyExitBreakdown(), profitFactor: null, expectancy: 0,
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
  const regimeSeries = calculateRegimeSeriesWithHysteresis(adxSeries.adx, 26.0, 22.0);
  const recordedTrades: RecordedTrade[] = [];

  let totalSignals = 0;
  let wins         = 0;
  let losses       = 0;
  let neutrals     = 0;
  const discards   = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalGainR   = 0;
  let totalLossR   = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
  let totalCycleCandles = 0;

  let nextAllowedIdx = 0;

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && interval === '5m') {
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
    totalCycleCandles += outcome.durationCandles + params.cooldownPeriod;

    const adxVal = (i >= 0 && i < adxSeries.adx.length) ? adxSeries.adx[i] : undefined;
    const regimeVal = (i >= 0 && i < regimeSeries.length) ? regimeSeries[i] : undefined;
    recordedTrades.push({
      dir: signal as 'BUY' | 'SELL',
      realizedR: outcome.realizedR,
      pnlPct: outcome.pnlPct,
      adxAtEntry: (adxVal !== undefined && !isNaN(adxVal)) ? adxVal : undefined,
      regimeAtEntry: regimeVal,
      outcome: outcome.result,
      exitReason: outcome.exitReason,
      entryIdx: i,
      executionIdx: i + 1,
      exitIdx: outcome.exitIdx,
      durationCandles: outcome.durationCandles,
    });

    if (outcome.result === 'win') {
      wins++;
    } else if (outcome.result === 'loss') {
      losses++;
    }

    if (outcome.realizedR > 0) {
      totalGainR += outcome.realizedR;
    } else if (outcome.realizedR < 0) {
      totalLossR += Math.abs(outcome.realizedR);
    }

    if (outcome.pnlPct > 0) {
      totalGainPct += outcome.pnlPct;
    } else if (outcome.pnlPct < 0) {
      totalLossPct += Math.abs(outcome.pnlPct);
    }

    const exitIdx = i + outcome.durationCandles;
    nextAllowedIdx = exitIdx + params.cooldownPeriod;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = totalLossR > 0 ? Number((totalGainR / totalLossR).toFixed(2)) : (totalGainR > 0 ? null : 1.0);

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const candleHours = interval === '5m' ? (5 / 60) : interval === '1h' ? 1.0 : 24.0;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * candleHours).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const minOosTrades = interval === '1h' ? 3 : interval === '1d' ? 2 : 5;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades, avgCycleCandles, candleHours, params.cooldownPeriod);

  return {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    exitBreakdown,
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
  const length = klines ? klines.length : 0;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 35) return signals;

  const ctx = buildStandardVotingContext(klines);
  for (let i = 34; i < length; i++) {
    signals[i] = evaluateStandardVotingAt(ctx, i).finalSignal;
  }
  return signals;
}

export function computeConfluenciaSignalsSeries(klines: Kline[], interval: string = '1h'): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines ? klines.length : 0;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 21) return signals;

  const ctx = buildConfluenciaContext(klines, interval);
  for (let i = 20; i < length; i++) {
    signals[i] = evaluateConfluenciaAt(ctx, i).signal;
  }
  return signals;
}

export function computeScoringSignalsSeries(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines ? klines.length : 0;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 60) return signals;

  const ctx = buildScoringContext(klines, interval, weights);
  for (let i = 59; i < length; i++) {
    const res = evaluateScoringAt(ctx, i);
    signals[i] = res.signal === 'HOLD' ? 'NEUTRAL' : res.signal;
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
  const forwardWindow = 12; // 12 candles in 5m = 1 hour forward window
  const cooldownPeriod = getStrategyCooldownCandles(_interval);
  const evalWindow = klines5m.length >= 1450 ? Math.min(1400, klines5m.length - forwardWindow - 30) : 576;
  const minRequiredCandles = 576 + forwardWindow;

  const fallbackResult: BacktestResult = {
    totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
    winRate: 0, resolutionRate: 0, exitBreakdown: createEmptyExitBreakdown(), profitFactor: null, expectancy: 0,
    expectancyR: 0, expectancyPerHour: 0, avgExposureHours: 0, avgDurationCandles: 0,
    maxDrawdownR: 0, maxLossStreak: 0, sortinoRatio: null,
    longStats: createEmptyDirectionalStats(),
    shortStats: createEmptyDirectionalStats(),
    regimeStats: createEmptyRegimeStats(),
    walkForward: createEmptyWalkForwardResult(),
    neutrals: 0,
    discards: createEmptyDiscards(),
    label: `últimas ${evalWindow} velas (5m)`,
    forwardLabel: '12 velas (1 hs max)',
    threshold: 0,
    targetThreshold: 0,
    targetMultiplier: 1.5,
    insufficient: true
  };

  if (!klines5m || klines5m.length < minRequiredCandles) return fallbackResult;

  const isSessionBased = hasSessionGaps(klines5m, '5m');
  const recordedTrades: RecordedTrade[] = [];

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let neutrals = 0;
  const discards = createEmptyDiscards();
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalGainR = 0;
  let totalLossR = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
  let totalCycleCandles = 0;
  let nextAllowedIdx = 0;

  const latestEvalIdx = klines5m.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(20, latestEvalIdx - evalWindow + 1);

  const ctx = buildMultifractalMTFContext(klines5m, klines1h, klines1d, _symbol);
  const regimeSeries = calculateRegimeSeriesWithHysteresis(ctx.adxData5M.adx, 26.0, 22.0);

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    if (isSessionBased && isNearSessionEnd(klines5m, i, '5m', forwardWindow)) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    // Realistic execution: entry at next open
    const nextIdx = i + 1 < klines5m.length ? i + 1 : i;
    const entryPrice = klines5m[nextIdx].open || klines5m[i].close;

    const evalRes = evaluateMultifractalMTFAt(ctx, i, entryPrice);

    if (evalRes.signal === 'NEUTRAL') {
      if (evalRes.discardReason) {
        discards[evalRes.discardReason]++;
      } else {
        discards.noSetup++;
      }
      neutrals++;
      continue;
    }

    totalSignals++;

    const risk = Math.abs(entryPrice - evalRes.stopLoss);
    const takeProfitPrice = evalRes.signal === 'BUY'
      ? entryPrice + risk * 1.5
      : entryPrice - risk * 1.5;

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: evalRes.stopLoss,
      takeProfit1: takeProfitPrice
    };

    const sim = simulateTrade(klines5m, i, evalRes.signal, levels, {
      forwardWindow: 12,
      enablePartials: false,
      earlyAdverseCutoffBars: 3,
      earlyAdverseCutoffR: 0.5,
      frictionPct: 0.08
    });

    totalRealizedR += sim.realizedR;
    const tradeDuration = Math.max(1, sim.exitIdx - i);
    totalDurationCandles += tradeDuration;
    totalCycleCandles += tradeDuration + cooldownPeriod;

    const adxVal = (i >= 0 && i < ctx.adxData5M.adx.length) ? ctx.adxData5M.adx[i] : undefined;
    const regimeVal = (i >= 0 && i < regimeSeries.length) ? regimeSeries[i] : undefined;
    recordedTrades.push({
      dir: evalRes.signal as 'BUY' | 'SELL',
      realizedR: sim.realizedR,
      pnlPct: sim.pnlPct,
      adxAtEntry: (adxVal !== undefined && !isNaN(adxVal)) ? adxVal : undefined,
      regimeAtEntry: regimeVal,
      outcome: sim.outcome,
      exitReason: sim.exitReason,
      entryIdx: i,
      executionIdx: i + 1,
      exitIdx: sim.exitIdx,
      durationCandles: tradeDuration,
    });

    if (sim.outcome === 'win') {
      wins++;
    } else if (sim.outcome === 'loss') {
      losses++;
    }

    if (sim.realizedR > 0) {
      totalGainR += sim.realizedR;
    } else if (sim.realizedR < 0) {
      totalLossR += Math.abs(sim.realizedR);
    }

    if (sim.pnlPct > 0) {
      totalGainPct += sim.pnlPct;
    } else if (sim.pnlPct < 0) {
      totalLossPct += Math.abs(sim.pnlPct);
    }

    nextAllowedIdx = sim.exitIdx + cooldownPeriod;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = totalLossR > 0 ? Number((totalGainR / totalLossR).toFixed(2)) : (totalGainR > 0 ? null : 1.0);
  const expectancy = totalSignals > 0 ? Number(((totalGainPct - totalLossPct) / totalSignals).toFixed(3)) : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * (5 / 60)).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, 5, avgCycleCandles, 5 / 60, cooldownPeriod);

  const res: BacktestResult = {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    exitBreakdown,
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
