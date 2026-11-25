import type { Kline } from '../services/api';
import { simulateTrade, type TradeLevels, type ExitReason } from './tradeSimulator';
import { calculateAlertLevels, getStrategyAtrMultiplier, isTradeFrictionViable, validateScoringSRRoom, isCryptoAsset, DEFAULT_FRICTION_PCT } from './tradeLevels';
export { getStrategyAtrMultiplier } from './tradeLevels';
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
  evaluateMultifractalMTFAt,
  buildMFLSContext,
  evaluateMFLSAt
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
  frictionFilter: number;            // Micro-stop donde comisiones + slippage exceden 0.35R (<0.31%)
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
    frictionFilter: 0,
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
  trending: { signals: number; wins: number; losses: number; winRate: number; expectancyR: number }; // ADX >= 26 (Hysteresis)
  ranging:  { signals: number; wins: number; losses: number; winRate: number; expectancyR: number }; // ADX <= 22 (Hysteresis)
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

export interface WalkForwardFold {
  fold: number;
  isWindow: number;
  oosWindow: number;
  oosTradesCount: number;
  oosExpectancyR: number;
  passed: boolean;
  status?: 'PASS' | 'FAIL' | 'NO_DATA';
}

export interface WalkForwardResult {
  isWindow: number;          // In-Sample window candle count (70%)
  oosWindow: number;         // Out-of-Sample window candle count (30%)
  inSample: SplitStats;      // Performance in historical 70%
  outOfSample: SplitStats;   // Performance in validation 30%
  purgedSignals?: number;    // Count of boundary-straddling trades purged from both partitions
  passed: boolean;           // True if OOS E[R] >= 0.10 and trades >= effectiveMinOos
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_OOS' | 'NO_OOS_TRADES';
  folds?: WalkForwardFold[]; // Multi-fold expanding anchored walk-forward validation (3 folds)
  foldsPassed?: number;
  foldsWithData?: number;
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
    passed: false,
    status: 'NO_OOS_TRADES',
  };
}

/**
 * Canonical calculation of Profit Factor based strictly on R-multiples:
 * - count === 0: null (no trades / insufficient data to state an edge)
 * - lossR > 0: totalGainR / totalLossR (finite ratio)
 * - lossR === 0 && gainR > 0: null (infinite PF / zero losses)
 * - lossR === 0 && gainR === 0 (and count > 0): 1.0 (exact breakeven with executed trades)
 */
export function calculateProfitFactor(gainR: number, lossR: number, count: number): number | null {
  if (count === 0) return null;
  if (lossR > 0) return Number((gainR / lossR).toFixed(2));
  if (gainR > 0) return null;
  return 1.0;
}

export function calculateSplitStats(
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
      totalGainR += trade.realizedR;
    } else if (trade.realizedR < 0) {
      totalLossR += Math.abs(trade.realizedR);
    }

    if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) {
      wins++;
    } else if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) {
      losses++;
    }

    const dur = trade.durationCandles ?? 6;
    totalCycleCandles += (dur + cooldownCandles);
  }

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(2)) : 0;
  const expectancyR = trades.length > 0 ? Number((totalR / trades.length).toFixed(3)) : 0;
  const profitFactor = calculateProfitFactor(totalGainR, totalLossR, trades.length);
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
  nominalCycleCandles?: number,
  candleHours: number = 5 / 60,
  cooldownCandles: number = 12
): WalkForwardResult {
  const totalCandles = Math.max(1, latestIdx - oldestIdx + 1);
  const isWindow = Math.round(totalCandles * splitRatio);
  const oosWindow = Math.max(0, totalCandles - isWindow);
  const splitIdx = oldestIdx + isWindow;

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

  // Calculate In-Sample average cycle length (holding duration + cooldown) strictly from In-Sample trades
  let isAvgCycle = 0;
  if (isTrades.length > 0) {
    let totalIsCycleCandles = 0;
    for (let j = 0; j < isTrades.length; j++) {
      const t = isTrades[j];
      const dur = t.durationCandles ?? (
        t.entryIdx !== undefined && t.exitIdx !== undefined
          ? Math.max(1, t.exitIdx - t.entryIdx)
          : 6
      );
      totalIsCycleCandles += (dur + cooldownCandles);
    }
    isAvgCycle = totalIsCycleCandles / isTrades.length;
  }

  // Physical capacity of the OOS window derived purely from In-Sample cycle time (or fallback nominal cycle)
  const cycleTime = isAvgCycle > 0 ? isAvgCycle : ((nominalCycleCandles && nominalCycleCandles > 0) ? nominalCycleCandles : 24);
  const oosCapacity = Math.max(1, Math.floor(oosWindow / cycleTime));
  // Scale requirement with window capacity while maintaining a strict floor of 3 trades (or minOosTrades if explicitly configured < 3)
  // and capping at the nominal minOosTrades target
  const effectiveMinOos = Math.min(minOosTrades, Math.max(Math.min(minOosTrades, 3), Math.floor(oosCapacity * 0.6)));

  const inSample = calculateSplitStats(isTrades, candleHours, cooldownCandles);
  const outOfSample = calculateSplitStats(oosTrades, candleHours, cooldownCandles);

  let passed = false;
  let status: 'PASS' | 'FAIL' | 'INSUFFICIENT_OOS' | 'NO_OOS_TRADES' = 'NO_OOS_TRADES';

  if (oosTrades.length === 0) {
    status = 'NO_OOS_TRADES';
    passed = false;
  } else if (oosTrades.length < effectiveMinOos) {
    // Insufficient OOS sample size (< effectiveMinOos) to statistically certify (PASS) or disqualify (FAIL).
    // Symmetrically marks INSUFFICIENT_OOS to prevent 1-2 trade Bernoulli noise from disqualifying strategies from LIMITED.
    status = 'INSUFFICIENT_OOS';
    passed = false;
  } else if (outOfSample.expectancyR >= 0.10 && (outOfSample.profitFactor === null || outOfSample.profitFactor >= 1.0)) {
    status = 'PASS';
    passed = true;
  } else {
    status = 'FAIL';
    passed = false;
  }

  // ── Multi-Fold Blind Walk-Forward (3 Disjoint Non-Overlapping Partitions strictly within OOS) ──
  // Partitions OOS into 3 non-overlapping sub-windows: [0, 0.33), [0.33, 0.67), [0.67, 1.00].
  // Ensures 100% temporal blindness vs In-Sample and mutual independence between folds
  // (fold3 ∩ fold2 ∩ fold1 = ∅, eliminating nesting redundancy where fold3 ⊇ fold2 ⊇ fold1).
  // Purges boundary straddlers that cross between disjoint folds.
  // Classifies each fold into 'PASS' (>= 1 trade & E[R] >= 0.10), 'FAIL' (trades present but underperforming),
  // or 'NO_DATA' (0 closed trades due to low event density or purged straddlers).
  // Differentiates absence of evidence from negative evidence.
  const folds: WalkForwardFold[] = [];
  let foldsPassed = 0;
  let foldsWithData = 0;
  const foldRanges = [
    { startFrac: 0.00, endFrac: 1 / 3 },
    { startFrac: 1 / 3, endFrac: 2 / 3 },
    { startFrac: 2 / 3, endFrac: 1.00 },
  ];

  for (let fIdx = 0; fIdx < foldRanges.length; fIdx++) {
    const { startFrac, endFrac } = foldRanges[fIdx];
    const fStartIdx = splitIdx + Math.floor(oosWindow * startFrac);
    const fEndIdx = fIdx === foldRanges.length - 1
      ? splitIdx + oosWindow - 1
      : splitIdx + Math.floor(oosWindow * endFrac) - 1;

    const fOosTrades: RecordedTrade[] = [];

    for (let j = 0; j < oosTrades.length; j++) {
      const t = oosTrades[j];
      const exec = t.executionIdx !== undefined ? t.executionIdx : t.entryIdx;
      const exit = t.exitIdx !== undefined ? t.exitIdx : (t.entryIdx !== undefined ? t.entryIdx + (t.durationCandles ?? 1) : undefined);
      if (exec === undefined) continue;

      // Disjoint fold validation:
      // Must execute within this fold's window [fStartIdx, fEndIdx]
      // Straddler purging: must exit on or before this fold's horizon fEndIdx
      if (exec >= fStartIdx && exec <= fEndIdx && exit !== undefined && exit <= fEndIdx) {
        fOosTrades.push(t);
      }
    }

    const fTradesCount = fOosTrades.length;
    let foldStatus: 'PASS' | 'FAIL' | 'NO_DATA' = 'NO_DATA';
    let fPassed = false;
    let foldExpR = 0;

    if (fTradesCount > 0) {
      foldsWithData++;
      const fOosStats = calculateSplitStats(fOosTrades, candleHours, cooldownCandles);
      foldExpR = fOosStats.expectancyR;
      if (foldExpR >= 0.10 && (fOosStats.profitFactor === null || fOosStats.profitFactor >= 1.0)) {
        fPassed = true;
        foldStatus = 'PASS';
        foldsPassed++;
      } else {
        foldStatus = 'FAIL';
      }
    }

    folds.push({
      fold: fIdx + 1,
      isWindow: splitIdx - oldestIdx,
      oosWindow: fEndIdx - fStartIdx + 1,
      oosTradesCount: fTradesCount,
      oosExpectancyR: foldExpR,
      passed: fPassed,
      status: foldStatus
    });
  }

  return {
    isWindow,
    oosWindow,
    inSample,
    outOfSample,
    purgedSignals,
    passed,
    status,
    folds,
    foldsPassed,
    foldsWithData,
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
      downsideSumSq += Math.pow(Math.abs(trade.realizedR), 2);
    }

    if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) {
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) {
        maxLossStreak = currentLossStreak;
      }
    } else if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) {
      currentLossStreak = 0;
    }

    if (trade.dir === 'BUY') {
      longSignals++;
      longTotalR += trade.realizedR;
      if (trade.realizedR > 0) {
        longGainR += trade.realizedR;
      } else if (trade.realizedR < 0) {
        longLossR += Math.abs(trade.realizedR);
      }
      if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) {
        longWins++;
      } else if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) {
        longLosses++;
      }
    } else if (trade.dir === 'SELL') {
      shortSignals++;
      shortTotalR += trade.realizedR;
      if (trade.realizedR > 0) {
        shortGainR += trade.realizedR;
      } else if (trade.realizedR < 0) {
        shortLossR += Math.abs(trade.realizedR);
      }
      if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) {
        shortWins++;
      } else if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) {
        shortLosses++;
      }
    }

    const isTrending = trade.regimeAtEntry !== undefined
      ? trade.regimeAtEntry === 'trending'
      : ((trade.adxAtEntry !== undefined && !isNaN(trade.adxAtEntry)) ? trade.adxAtEntry >= 26 : false);
    if (isTrending) {
      trendSignals++;
      trendTotalR += trade.realizedR;
      if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) trendWins++;
      else if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) trendLosses++;
    } else {
      rangeSignals++;
      rangeTotalR += trade.realizedR;
      if (trade.outcome === 'win' || (trade.outcome === undefined && trade.realizedR > 0.05)) rangeWins++;
      else if (trade.outcome === 'loss' || (trade.outcome === undefined && trade.realizedR < -0.05)) rangeLosses++;
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
  const longPF = calculateProfitFactor(longGainR, longLossR, longSignals);

  const shortResolved = shortWins + shortLosses;
  const shortWR = shortResolved > 0 ? Number((shortWins / shortResolved).toFixed(2)) : 0;
  const shortExpR = shortSignals > 0 ? Number((shortTotalR / shortSignals).toFixed(3)) : 0;
  const shortPF = calculateProfitFactor(shortGainR, shortLossR, shortSignals);

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
  forwardLabel: string = 'ventana 6 velas',
  forwardWindow?: number
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
    forwardWindow,
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
  regimeStats: RegimeStats;     // statistics by regime (Trending ADX >= 26 vs Ranging ADX <= 22)
  walkForward?: WalkForwardResult; // In-Sample (70%) vs Out-of-Sample (30%) validation
  neutrals: number;             // skipped NEUTRAL candles (sum of all discards)
  discards: DiscardBreakdown;   // Granular discard breakdown for diagnostics
  label: string;                // e.g. "últimas 150 velas"
  forwardWindow?: number;       // e.g. 10 (exact candles in forward evaluation window)
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
 * - Anti-Revenge Full Cooldown on SL / Entry (default):
 *   - 5m Intraday: 6 candles (30 min)
 *   - 1H Swing: 4 candles (4 hours)
 *   - 1D Position: 2 candles (2 days / 48 hours)
 * - Minimum Grace Cooldown on TP / Timeout:
 *   - 1 candle across all timeframes (prevents same-candle churn while unlocking pullbacks)
 */
export function getStrategyCooldownCandles(
  interval: string,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  outcome?: 'SL' | 'TP' | 'TIMEOUT' | 'ENTRY' | string
): number {
  if (outcome === 'TP' || outcome === 'TIMEOUT') {
    return 1; // 1 single candle grace period for winning targets or flat timeouts
  }
  if (interval === '5m') {
    return style === 'swing' ? 48 : 6; // 6 candles of 5m = 30 min (calibrated for intraday equities)
  }
  if (interval === '1h') {
    return 4; // 4 candles of 1h = 4 hours
  }
  if (interval === '1d') {
    return 2; // 2 candles of 1d = 2 days (48 hours)
  }
  return 6;
}

/**
 * Canonical Strategy Cooldown in Milliseconds (for Live alert throttle in App.tsx):
 * Supports asymmetric cooldowns: full anti-revenge period on SL/default, 1-candle grace period on TP/TIMEOUT.
 */
export function getStrategyCooldownMs(
  interval: string,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  outcome?: 'SL' | 'TP' | 'TIMEOUT' | 'ENTRY' | string
): number {
  if (outcome === 'TP' || outcome === 'TIMEOUT') {
    if (interval === '5m') return 5 * 60 * 1000;
    if (interval === '1h') return 3600 * 1000;
    if (interval === '1d') return 24 * 3600 * 1000;
    return 5 * 60 * 1000;
  }
  if (interval === '5m') {
    return style === 'swing' ? 4 * 3600 * 1000 : 30 * 60 * 1000; // 30 min for 5m DayTrading
  }
  if (interval === '1h') {
    return 4 * 3600 * 1000; // 4 hours for 1h Swing
  }
  if (interval === '1d') {
    return 48 * 3600 * 1000; // 48 hours for 1D Position
  }
  return 30 * 60 * 1000;
}

/**
 * Canonical Strategy Forward / Expiry Window in Candles:
 * Unifies the trade evaluation horizon between Backtesting, Tournament, and Live Alert Tracker.
 * - Multifractal MTF: 12 candles (5m = 1 hour)
 * - VCME Sniper: 24 candles (5m Day Trading = 2 hs) / 48 candles (1H Swing = 48 hs)
 * - Confluencia (2.0x ATR geometry): 20 candles (5m = 1h 40m), 7 candles (1h = 7 hs), 6 candles (1d = 6 días)
 * - Scoring (1.5x ATR geometry): 16 candles (5m = 1h 20m), 5 candles (1h = 5 hs), 5 candles (1d = 5 días)
 * - Standard (1.2x ATR crypto / 2.5x ATR equities): 12 candles (5m = 1h), 4 candles (1h = 4 hs), 3 candles (1d = 3 días)
 */
export function getStrategyForwardWindow(
  strategy?: string,
  interval: string = '5m',
  executionStyle?: 'dayTrading' | 'swing',
  _symbolOrIsCrypto?: string | boolean
): number {
  const normStrategy = (strategy ?? '').toLowerCase();
  const normTf = (interval ?? '5m').toLowerCase();
  const isCrypto = typeof _symbolOrIsCrypto === 'boolean'
    ? _symbolOrIsCrypto
    : (_symbolOrIsCrypto ? isCryptoAsset(_symbolOrIsCrypto) : true);

  if (normStrategy.includes('multifractal')) {
    return 12; // 12 candles 5m = 1 hour forward window
  }

  if (normStrategy.includes('mfls')) {
    return 24; // 24 candles 5m = 2.0 hours (allows liquidity sweep reversal to reach +0.37 ATR peak)
  }

  if (normStrategy.includes('vcme') || normStrategy.includes('multitemporal')) {
    if (executionStyle === 'swing' || normTf === '1h') return 48; // 48 candles 1h = 48 hours
    return 24; // 24 candles 5m = 2 hours (Intraday forward window)
  }

  const baseAtrMult = normTf === '1d' ? 1.0 : 1.2;
  const baseForward = normTf === '5m' ? 6 : (normTf === '1h' ? 4 : 3);

  // In 5m day trading (both equities and crypto), trades target a 1 to 3 hour holding period (12 to 36 candles),
  // giving the structural stop (>=0.40%) and target (>=0.60%) room to resolve with strict 1:1 parity:
  if (normTf === '5m') {
    if (normStrategy.includes('confluencia')) return isCrypto ? 24 : 36; // 36 candles = 3h for equities (matches trader's 45m-3h holding profile and 3h breakeven/edge), 24 candles = 2h for crypto
    if (normStrategy.includes('scoring')) return 16;     // 16 candles = 1h 20m
    return 12;                                          // 12 candles = 1h (Standard)
  }

  const isConfluencia = normStrategy.includes('confluencia');
  const isScoring = normStrategy.includes('scoring');

  const customAtrMult = isConfluencia ? 2.0 : (isScoring ? 1.5 : baseAtrMult);
  const scale = customAtrMult / baseAtrMult;

  return Math.round(baseForward * scale);
}

/**
 * Canonical warmup floor based on the earliest candle index where the strategy
 * produces valid, non-sterile signals and indicators (specifically ADX(14) which requires 29 bars):
 * - Standard Voting: index 199 (EMA200 macro trend filter maturity)
 * - Confluencia: index 30 (signals start at 20, but ADX(14) regime convergence requires 30)
 * - Scoring: index 59 (EMA50, S/R, BB 20)
 * - Generic/Other: index 30 (universal indicator floor for ADX(14) convergence)
 */
export function getStrategySignalWarmup(strategy?: string): number {
  const norm = (strategy || '').toLowerCase();
  if (norm.includes('scoring')) return 59;
  if (norm.includes('standard')) return 199;
  if (norm.includes('confluencia')) return 30;
  if (norm.includes('mfls')) return 30;
  return 30;
}

/**
 * History after which each engine's signal no longer depends on where the series starts
 * (recursive indicators converged). Measured with scripts/causality-analysis.ts on 30 real
 * symbols (Nov 2026): at the minimal floor 13% of Standard signals (EMA200), 34% of Scoring
 * signals and 3% of Confluencia signals differ from the full-history signal the live app sees;
 * at these values the residual is ≤ 2% (Scoring keeps ~6–9% S/R-checkpoint phase noise).
 */
export function getStrategyConvergedWarmup(strategy?: string): number {
  const norm = (strategy || '').toLowerCase();
  if (norm.includes('standard')) return 500;
  if (norm.includes('scoring')) return 100;
  if (norm.includes('confluencia')) return 59;
  if (norm.includes('multifractal')) return 59;
  if (norm.includes('mfls')) return 100;
  return 100; // VCME and others: EMA21 / ADX(14) on 5m
}

/**
 * Backtest warmup floor: the converged history when the series is long enough to afford it
 * (it costs at most 25% of the candles, e.g. 60 days of 5m), otherwise the minimal floor so short
 * series (≈500 daily candles, recently listed symbols) keep an evaluable window. Only changes
 * which early candles the backtest evaluates; live signals always use the full history.
 */
export function resolveBacktestWarmupFloor(
  strategy: string | undefined,
  totalCandles: number,
  opts: { interval?: string; isCrypto?: boolean } = {}
): number {
  const norm = (strategy || '').toLowerCase();
  const minimal = getStrategySignalWarmup(strategy);
  let converged = Math.max(minimal, getStrategyConvergedWarmup(strategy));
  // Crypto VWAP is anchored to the UTC day: the first partial day of the series has a wrong VWAP,
  // so VWAP engines on 5m crypto need one full day (288 candles) before their first evaluation.
  const usesVwap = norm.includes('confluencia') || norm.includes('scoring') || norm.includes('vcme');
  if (opts.isCrypto && opts.interval === '5m' && usesVwap) converged = Math.max(converged, 300);
  return totalCandles >= 4 * converged ? converged : minimal;
}

function getParams(
  interval: string,
  totalCandles?: number,
  forwardWindowParam?: number,
  warmupParam?: number
): BacktestParams {
  const baseForward = interval === '5m' ? 6 : (interval === '1h' ? 4 : 3);
  const forwardWindow = forwardWindowParam ?? baseForward;
  const warmup = warmupParam ?? 30;
  switch (interval) {
    case '5m': {
      const available = totalCandles ? Math.max(0, totalCandles - forwardWindow - warmup) : 576;
      const evalWindow = totalCandles && totalCandles <= 650
        ? Math.min(576, available)
        : Math.min(4680, Math.max(576, available));
      return {
        evalWindow,
        forwardWindow,
        forwardLabel: `${forwardWindow} velas (${forwardWindow * 5} min)`,
        fallbackThreshold: 0.008,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
        cooldownPeriod: getStrategyCooldownCandles('5m'), // 30 min = 6 candles of 5m (unified across all engines & Live)
      };
    }
    case '1d': {
      const evalWindow = totalCandles
        ? Math.min(120, Math.max(0, totalCandles - forwardWindow - warmup))
        : 60;
      return {
        evalWindow,
        forwardWindow,
        forwardLabel: `${forwardWindow} velas (${forwardWindow} días)`,
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
        cooldownPeriod: getStrategyCooldownCandles('1d'), // 2 days = 2 candles of 1d
      };
    }
    case '1h':
    default: {
      const evalWindow = totalCandles && totalCandles >= 550
        ? Math.min(720, totalCandles - forwardWindow - warmup)
        : (totalCandles && totalCandles >= 300
          ? Math.min(350, totalCandles - forwardWindow - warmup)
          : (totalCandles ? Math.min(168, Math.max(0, totalCandles - forwardWindow - warmup)) : 168));
      return {
        evalWindow,
        forwardWindow,
        forwardLabel: `${forwardWindow} velas (${forwardWindow} hs)`,
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

  // Clamp to sane bounds: 0.2% minimum, 8% maximum.
  // Note: stops below getMinViableStopPct() (~0.314%) are pruned downstream
  // by isTradeFrictionViable and recorded in discards.frictionFilter.
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

/**
 * Canonical helper: determines the candle duration in seconds (stepSec) cleanly.
 * Replaces fragile two-bar subtraction (klines[1].time - klines[0].time) which becomes
 * artificially huge if the first two bars cross an overnight or weekend session gap.
 */
export function getRobustCandleStepSec(klines?: Kline[], interval?: string, style?: 'dayTrading' | 'swing'): number {
  if (style === 'dayTrading' || interval === '5m') return 300;
  if (interval === '1h') return 3600;
  if (interval === '1d') return 86400;

  // Fallback for custom/unspecified intervals: take the minimum positive delta across initial bars (gap-immune)
  if (klines && klines.length > 1) {
    const sampleSize = Math.min(10, klines.length - 1);
    let minDiff = Infinity;
    for (let i = 0; i < sampleSize; i++) {
      const diff = klines[i + 1].time - klines[i].time;
      if (diff > 0 && diff < minDiff) {
        minDiff = diff;
      }
    }
    if (minDiff < Infinity) {
      if (minDiff <= 450) return 300;
      if (minDiff <= 1200) return 900;
      if (minDiff <= 5400) return 3600;
      if (minDiff <= 100000) return 86400;
    }
  }

  return style === 'swing' ? 3600 : 300;
}

/**
 * Test & Diagnostic Helper: checks if a given candle is near the end of a trading session.
 * In production backtests, session boundary management is unified on `sessionGapCutoff`
 * in simulateTrade (for intraday market close exits) and single-bar closing gap checks.
 */
export function isNearSessionEnd(klines: Kline[], idx: number, interval: string, forwardWindow: number): boolean {
  // Check if any of the forward candles have a session gap
  for (let f = idx + 1; f <= idx + forwardWindow && f < klines.length; f++) {
    const gap = klines[f].time - klines[f - 1].time;
    const expectedGapSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;
    if (gap > expectedGapSec * 3) return true;
  }
  return false;
}

/**
 * Canonical helper: checks if the execution candle (i + 1) crosses an overnight session gap.
 * When true, entering at i+1.open would execute post-gap with overnight exposure or inverted gap risk.
 * Used across runBacktestGenericOptimized, backtestMultitemporal, and backtestMultifractalMTF.
 */
export function isExecutionAcrossSessionGap(klines: Kline[], i: number, interval: string = '5m'): boolean {
  if (interval === '1d' || i + 1 >= klines.length) return false;
  const nextGap = klines[i + 1].time - klines[i].time;
  const expectedGapSec = interval === '5m' ? 300 : (interval === '1h' ? 3600 : 300);
  return nextGap > expectedGapSec * 3;
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
  levels: TradeLevels,
  policyOptions?: {
    sessionGapCutoff?: boolean;
    stepSec?: number;
  }
): TradeOutcome {
  const sim = simulateTrade(klines, entryIdx, signal, levels, {
    forwardWindow,
    enablePartials: false,
    frictionPct: DEFAULT_FRICTION_PCT,
    frictionModel: 'proportional',
    sessionGapCutoff: policyOptions?.sessionGapCutoff,
    stepSec: policyOptions?.stepSec
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

import { getKlinesFingerprint } from './klineFingerprint';
export { getKlinesFingerprint } from './klineFingerprint';

function getBacktestCache(key: string, klines: Kline[], auxiliarySeries?: (Kline[] | undefined)[]): BacktestResult | null {
  if (!klines || klines.length === 0) return null;
  const cached = backtestCache.get(key);
  if (!cached) return null;

  const allSeries = auxiliarySeries ? [klines, ...auxiliarySeries] : [klines];
  const fp = getKlinesFingerprint(allSeries);
  if (cached.fingerprint === fp) {
    // LRU touch: re-insert key to mark as most recently used
    backtestCache.delete(key);
    backtestCache.set(key, cached);
    return cached.result;
  }
  return null;
}

function setBacktestCache(key: string, klines: Kline[], result: BacktestResult, auxiliarySeries?: (Kline[] | undefined)[]): BacktestResult {
  if (klines && klines.length > 0 && result) {
    if (backtestCache.has(key)) {
      backtestCache.delete(key);
    } else if (backtestCache.size >= 250) {
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
  const res = runBacktestGenericOptimized(klines, interval, signals, 'standard', symbol);
  return setBacktestCache(cacheKey, klines, res);
}

export function backtestConfluencia(klines: Kline[], interval: string, symbol?: string): BacktestResult {
  const cacheKey = `confluencia:${symbol || 'any'}:${interval}`;
  const cached = getBacktestCache(cacheKey, klines);
  if (cached) return cached;
  const signals = computeConfluenciaSignalsSeries(klines, interval, symbol);
  // Confluencia is geometrically designed for stopLoss = close ± 2.0 * ATR
  const res = runBacktestGenericOptimized(klines, interval, signals, 'confluencia', symbol);
  return setBacktestCache(cacheKey, klines, res);
}

export function backtestScoring(
  klines: Kline[],
  interval: string,
  weights?: ScoringWeights,
  symbol?: string
): BacktestResult {
  const w = weights || DEFAULT_WEIGHTS;
  const weightsKey = `${w.trend}_${w.rsi}_${w.bollinger}_${w.volume}_${w.candle}`;
  const cacheKey = `scoring:${symbol || 'any'}:${interval}:${weightsKey}`;
  const cached = getBacktestCache(cacheKey, klines);
  if (cached) return cached;
  const signals = computeScoringSignalsSeries(klines, interval, weights, symbol);
  // Scoring evaluates and validates R:R against slDist = 1.5 * ATR
  const res = runBacktestGenericOptimized(klines, interval, signals, 'scoring', symbol);
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
  const stepSec = getRobustCandleStepSec(klines5m, _interval, style);
  const forwardWindow = style === 'swing'
    ? (stepSec === 300 ? 576 : 48)  // 576 x 5m = 48h OR 48 x 1h = 48h
    : 24;                            // 24 x 5m = 2h (Intradía)
  const evalWindow = style === 'swing'
    ? (klines5m.length >= 550 ? Math.min(720, klines5m.length - forwardWindow - 30) : (klines5m.length >= 300 ? Math.min(350, klines5m.length - forwardWindow - 20) : 168))
    : (klines5m.length <= 650 ? 576 : Math.min(4680, Math.max(576, klines5m.length - forwardWindow - 30)));
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
    forwardWindow,
    forwardLabel: style === 'swing' ? '48 hs max (Swing)' : '2 hs max (Intradía)',
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
  const warmupFloor = style === 'swing' ? 30 : resolveBacktestWarmupFloor('vcme', klines5m.length);
  const oldestEvalIdx = Math.max(warmupFloor, latestEvalIdx - evalWindow + 1);

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

    // In dayTrading sessions, allow trades to run normally and let sessionGapCutoff
    // in simulateTrade handle realistic market close / MOC exits at 16:00 ET.

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

    // In session-based dayTrading, do not enter across an overnight gap:
    if (isSessionBased && style === 'dayTrading' && isExecutionAcrossSessionGap(klines5m, i, '5m')) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: evalRes.stopLoss,
      takeProfit1: evalRes.takeProfit1,
      takeProfit2: evalRes.takeProfit2,
      takeProfit3: evalRes.takeProfit3
    };

    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
      discards.frictionFilter++;
      neutrals++;
      continue;
    }

    totalSignals++;

    const sim = simulateTrade(klines5m, i, evalRes.signal, levels, {
      forwardWindow,
      enablePartials: 'vcme-runner',
      moveSlToBreakevenOnTp1: true,
      timeStopBars: evalRes.tradeType === 'DAY' ? 18 : 0,
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
      frictionPct: DEFAULT_FRICTION_PCT,
      frictionModel: 'proportional'
    });

    totalRealizedR += sim.realizedR;
    const tradeDuration = Math.max(1, sim.exitIdx - i);
    totalDurationCandles += tradeDuration;
    const outcomeKey = sim.outcome === 'win' || sim.realizedR > 0
      ? 'TP'
      : sim.outcome === 'loss' || sim.realizedR < -0.05
        ? 'SL'
        : 'TIMEOUT';
    const tradeCooldown = getStrategyCooldownCandles(tf, style, outcomeKey);
    totalCycleCandles += tradeDuration + tradeCooldown;

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

    nextAllowedIdx = sim.exitIdx + tradeCooldown;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = calculateProfitFactor(totalGainR, totalLossR, totalSignals);

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
  const nominalCycle = style === 'swing' ? (48 + cooldownPeriod) : (6 + cooldownPeriod);
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades, nominalCycle, candleHours, cooldownPeriod);

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
    forwardWindow,
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

export function runBacktestGenericOptimized(
  klines: Kline[],
  interval: string,
  signals: ('BUY' | 'SELL' | 'NEUTRAL')[],
  strategyKey: string = 'standard',
  atrMultiplierOrSymbol?: number | string | boolean,
  symbolOrIsCryptoParam?: string | boolean
): BacktestResult {
  let customAtrMultiplier: number | undefined;
  let symbolOrIsCrypto: string | boolean | undefined;

  if (typeof atrMultiplierOrSymbol === 'number') {
    customAtrMultiplier = atrMultiplierOrSymbol;
    symbolOrIsCrypto = symbolOrIsCryptoParam;
  } else {
    symbolOrIsCrypto = atrMultiplierOrSymbol;
  }

  const isCrypto = typeof symbolOrIsCrypto === 'boolean'
    ? symbolOrIsCrypto
    : isCryptoAsset(symbolOrIsCrypto);

  // Canonical forwardWindow derived purely from getStrategyForwardWindow
  const forwardWindow = getStrategyForwardWindow(strategyKey, interval, undefined, isCrypto);
  const warmupFloor = resolveBacktestWarmupFloor(strategyKey, klines.length, { interval, isCrypto });
  const params = getParams(interval, klines.length, forwardWindow, warmupFloor);
  const atrMultiplier = customAtrMultiplier ?? getStrategyAtrMultiplier(strategyKey, interval, isCrypto);
  const { evalWindow, targetMultiplier, forwardLabel } = params;

  // Use the ATR available at each entry. Applying today's ATR to historical trades
  // leaks future volatility into the result.
  const atrSeries = calculateATRSeries(klines, 14);
  const latestAtr = atrSeries[atrSeries.length - 1];
  const threshold = getAdaptiveThreshold(latestAtr, klines[klines.length - 1].close, atrMultiplier, params.fallbackThreshold);
  const targetThreshold = threshold * targetMultiplier;
  const minCandles = interval === '5m'
    ? (klines.length <= 650 ? 50 : 576 + forwardWindow)
    : (interval === '1h' ? 172 : 60);
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
      forwardWindow,
      forwardLabel,
      threshold,
      targetThreshold,
      targetMultiplier,
      insufficient: true,
    };
  }

  const isSessionBased = hasSessionGaps(klines, interval);
  const latestEvalIdx = klines.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(warmupFloor, latestEvalIdx - evalWindow + 1);

  if (interval === '1d' && (latestEvalIdx < oldestEvalIdx || evalWindow <= 0)) {
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
      label: `datos insuficientes (${klines.length} velas para warmup ${warmupFloor})`,
      forwardWindow,
      forwardLabel,
      threshold,
      targetThreshold,
      targetMultiplier,
      insufficient: true,
    };
  }

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

    // In 5m and 1h with session boundaries (e.g. NYSE/NASDAQ), do NOT pre-discard bars near session end;
    // allow trades to evaluate normally (including closing hour momentum) and let sessionGapCutoff
    // in evaluateOutcome / simulateTrade realistically model market close / MOC exits at 16:00 ET.

    const signal = signals[i] || 'NEUTRAL';

    if (signal === 'NEUTRAL') {
      discards.noSetup++;
      neutrals++;
      continue;
    }

    // In session-based day trading (5m and 1h), do not enter across an overnight gap:
    // if the immediate next candle (execution candle i+1) is across a session gap, skip this single closing candle.
    if (isSessionBased && isExecutionAcrossSessionGap(klines, i, interval)) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const entryPrice = klines[i + 1].open || klines[i].close;
    // Same absolute ATR risk and clamps as live sizing, anchored to execution
    // price. Only the ATR of the closed signal candle is available at entry.
    const levels: TradeLevels = {
      entryPrice,
      ...calculateAlertLevels(signal, entryPrice, interval, atrSeries[i], strategyKey, { isCrypto }),
    };

    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
      discards.frictionFilter++;
      neutrals++;
      continue;
    }

    if (strategyKey === 'scoring') {
      const srValidation = validateScoringSRRoom(klines, i, signal, entryPrice, levels.takeProfit1, levels.stopLoss);
      if (!srValidation.viable) {
        discards.riskFilter++;
        neutrals++;
        continue;
      }
    }

    totalSignals++;
    const stepSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;
    const outcome = evaluateOutcome(
      klines,
      i,
      signal,
      forwardWindow,
      levels,
      {
        sessionGapCutoff: isSessionBased && (interval === '5m' || interval === '1h'),
        stepSec
      }
    );

    totalRealizedR += outcome.realizedR;
    totalDurationCandles += outcome.durationCandles;
    const outcomeKey = outcome.result === 'win' || outcome.realizedR > 0
      ? 'TP'
      : outcome.result === 'loss' || outcome.realizedR < -0.05
        ? 'SL'
        : 'TIMEOUT';
    const tradeCooldown = getStrategyCooldownCandles(interval, undefined, outcomeKey);
    totalCycleCandles += outcome.durationCandles + tradeCooldown;

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
    nextAllowedIdx = exitIdx + tradeCooldown;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = calculateProfitFactor(totalGainR, totalLossR, totalSignals);

  const expectancy = totalSignals > 0 ? (totalGainPct - totalLossPct) / totalSignals : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const candleHours = interval === '5m' ? (5 / 60) : interval === '1h' ? 1.0 : 24.0;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * candleHours).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const minOosTrades = interval === '5m' ? 5 : 3;
  const nominalCycle = forwardWindow + params.cooldownPeriod;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades, nominalCycle, candleHours, params.cooldownPeriod);

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
    forwardWindow,
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

export function computeConfluenciaSignalsSeries(
  klines: Kline[],
  interval: string = '1h',
  symbolOrIsCrypto?: string | boolean
): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines ? klines.length : 0;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 21) return signals;

  const ctx = buildConfluenciaContext(klines, interval, symbolOrIsCrypto);
  for (let i = 20; i < length; i++) {
    signals[i] = evaluateConfluenciaAt(ctx, i).signal;
  }
  return signals;
}

export function computeScoringSignalsSeries(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  symbolOrIsCrypto?: string | boolean
): ('BUY' | 'SELL' | 'NEUTRAL')[] {
  const length = klines ? klines.length : 0;
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
  if (length < 60) return signals;

  const ctx = buildScoringContext(klines, interval, weights, symbolOrIsCrypto);
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
  const evalWindow = klines5m.length <= 650
    ? Math.min(576, Math.max(0, klines5m.length - forwardWindow - 30))
    : Math.min(4680, Math.max(576, klines5m.length - forwardWindow - 30));
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
    forwardWindow,
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
  const oldestEvalIdx = Math.max(resolveBacktestWarmupFloor('multifractal', klines5m.length), latestEvalIdx - evalWindow + 1);

  const ctx = buildMultifractalMTFContext(klines5m, klines1h, klines1d, _symbol);
  const regimeSeries = calculateRegimeSeriesWithHysteresis(ctx.adxData5M.adx, 26.0, 22.0);

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    // Allow trades to evaluate normally across session close, letting sessionGapCutoff
    // in simulateTrade handle realistic market close / MOC exits at 16:00 ET.

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

    // In session-based 5m day trading, do not enter across an overnight gap:
    if (isSessionBased && isExecutionAcrossSessionGap(klines5m, i, '5m')) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const risk = Math.abs(entryPrice - evalRes.stopLoss);
    const takeProfitPrice = evalRes.signal === 'BUY'
      ? entryPrice + risk * 1.5
      : entryPrice - risk * 1.5;

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: evalRes.stopLoss,
      takeProfit1: takeProfitPrice
    };

    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
      discards.frictionFilter++;
      neutrals++;
      continue;
    }

    totalSignals++;

    const sim = simulateTrade(klines5m, i, evalRes.signal, levels, {
      forwardWindow: 12,
      enablePartials: false,
      earlyAdverseCutoffBars: 3,
      earlyAdverseCutoffR: 0.5,
      frictionPct: DEFAULT_FRICTION_PCT,
      frictionModel: 'proportional',
      sessionGapCutoff: isSessionBased,
      stepSec: 300
    });

    totalRealizedR += sim.realizedR;
    const tradeDuration = Math.max(1, sim.exitIdx - i);
    totalDurationCandles += tradeDuration;
    const outcomeKey = sim.outcome === 'win' || sim.realizedR > 0
      ? 'TP'
      : sim.outcome === 'loss' || sim.realizedR < -0.05
        ? 'SL'
        : 'TIMEOUT';
    const tradeCooldown = getStrategyCooldownCandles(_interval, undefined, outcomeKey);
    totalCycleCandles += tradeDuration + tradeCooldown;

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

    nextAllowedIdx = sim.exitIdx + tradeCooldown;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = calculateProfitFactor(totalGainR, totalLossR, totalSignals);
  const expectancy = totalSignals > 0 ? Number(((totalGainPct - totalLossPct) / totalSignals).toFixed(3)) : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * (5 / 60)).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const nominalCycle = 12 + cooldownPeriod;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, 5, nominalCycle, 5 / 60, cooldownPeriod);

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
    label: `últimas ${latestEvalIdx >= oldestEvalIdx ? (latestEvalIdx - oldestEvalIdx + 1) : evalWindow} velas (5m)`,
    forwardWindow,
    forwardLabel: '12 velas (1 hs max)',
    threshold: 0.01,
    targetThreshold: 0.015,
    targetMultiplier: 1.5,
    insufficient: false
  };

  return setBacktestCache(cacheKey, klines5m, res, [klines1h, klines1d]);
}

/**
 * Motor de Backtesting para Estrategia 6: MACD Failure & Liquidity Sweep (MFLS)
 * Calibrada específicamente para acciones en 5m, horizonte de 18 velas (1.5 hs) y fricción del 0.11%.
 */
export function backtestMFLS(
  klines5m: Kline[],
  _interval: string = '5m',
  _symbol: string = 'ASSET'
): BacktestResult {
  const isCrypto = isCryptoAsset(_symbol);
  const cacheKey = `mfls:${_interval}:${_symbol}`;
  const cached = getBacktestCache(cacheKey, klines5m);
  if (cached) return cached;

  const forwardWindow = getStrategyForwardWindow('mfls', _interval, 'dayTrading', _symbol);
  const forwardLabel = `${forwardWindow} velas (${(forwardWindow * 5) / 60} hs max)`;
  const warmup = resolveBacktestWarmupFloor('mfls', klines5m.length);
  const cooldownPeriod = getStrategyCooldownCandles('5m');
  const evalWindow = klines5m.length <= 650
    ? Math.min(576, Math.max(0, klines5m.length - forwardWindow - warmup))
    : Math.min(4680, Math.max(576, klines5m.length - forwardWindow - warmup));
  const minCandles = warmup + forwardWindow + 20;

  if (klines5m.length < minCandles) {
    const empty = createFallbackBacktestResult(`datos insuficientes (${klines5m.length} velas)`, forwardLabel, forwardWindow);
    return setBacktestCache(cacheKey, klines5m, empty);
  }

  const isSessionBased = !isCrypto || hasSessionGaps(klines5m, '5m');
  const discards = createEmptyDiscards();
  const recordedTrades: RecordedTrade[] = [];

  let totalSignals = 0;
  let wins = 0;
  let losses = 0;
  let neutrals = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;
  let totalGainR = 0;
  let totalLossR = 0;
  let totalRealizedR = 0;
  let totalDurationCandles = 0;
  let totalCycleCandles = 0;
  let nextAllowedIdx = 0;

  const latestEvalIdx = klines5m.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(warmup, latestEvalIdx - evalWindow + 1);

  const ctx = buildMFLSContext(klines5m, _symbol);
  const adxSeries = calculateADXSeries(klines5m, 14);
  const regimeSeries = calculateRegimeSeriesWithHysteresis(adxSeries.adx, 26.0, 22.0);

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    if (i < nextAllowedIdx) {
      discards.cooldown++;
      neutrals++;
      continue;
    }

    const nextIdx = i + 1 < klines5m.length ? i + 1 : i;
    const entryPrice = klines5m[nextIdx].open || klines5m[i].close;

    const evalRes = evaluateMFLSAt(ctx, i, entryPrice);

    if (evalRes.signal === 'NEUTRAL') {
      if (evalRes.discardReason) {
        discards[evalRes.discardReason]++;
      } else {
        discards.noSetup++;
      }
      neutrals++;
      continue;
    }

    if (isSessionBased && isExecutionAcrossSessionGap(klines5m, i, '5m')) {
      discards.sessionGap++;
      neutrals++;
      continue;
    }

    const levels: TradeLevels = {
      entryPrice,
      stopLoss: evalRes.stopLoss,
      takeProfit1: evalRes.takeProfit1,
      takeProfit2: evalRes.takeProfit2
    };

    // Frictional viability check (0.11% commission + 0.03% slippage = 0.14% total friction, min viable stop 0.40%)
    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss, DEFAULT_FRICTION_PCT)) {
      discards.frictionFilter++;
      neutrals++;
      continue;
    }

    totalSignals++;

    // Realistic trade simulation with 0.11% friction, two-tier targets, 24-bar window, 16-bar time-stop, and early adverse protection
    const sim = simulateTrade(klines5m, i, evalRes.signal, levels, {
      forwardWindow: getStrategyForwardWindow('mfls', _interval, 'dayTrading'),
      enablePartials: 'two-tier',
      earlyAdverseCutoffBars: 3,
      earlyAdverseCutoffR: 0.5,
      timeStopBars: 16,
      timeStopMinR: 0.4,
      frictionPct: DEFAULT_FRICTION_PCT,
      frictionModel: 'proportional',
      sessionGapCutoff: isSessionBased,
      stepSec: 300
    });

    totalRealizedR += sim.realizedR;
    const tradeDuration = Math.max(1, sim.exitIdx - i);
    totalDurationCandles += tradeDuration;
    const outcomeKey = sim.outcome === 'win' || sim.realizedR > 0
      ? 'TP'
      : sim.outcome === 'loss' || sim.realizedR < -0.05
        ? 'SL'
        : 'TIMEOUT';
    const tradeCooldown = getStrategyCooldownCandles(_interval, undefined, outcomeKey);
    totalCycleCandles += tradeDuration + tradeCooldown;

    const adxVal = (i >= 0 && i < adxSeries.adx.length) ? adxSeries.adx[i] : undefined;
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

    nextAllowedIdx = sim.exitIdx + tradeCooldown;
  }

  const exitBreakdown = calculateExitBreakdown(recordedTrades);
  const timeouts = exitBreakdown.expirations;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number((wins / resolved).toFixed(3)) : 0;
  const resolutionRate = totalSignals > 0 ? Number(((exitBreakdown.targetHits + exitBreakdown.stopLossHits) / totalSignals).toFixed(3)) : 0;
  const profitFactor = calculateProfitFactor(totalGainR, totalLossR, totalSignals);
  const expectancy = totalSignals > 0 ? Number(((totalGainPct - totalLossPct) / totalSignals).toFixed(3)) : 0;
  const avgDurationCandles = totalSignals > 0 ? Number((totalDurationCandles / totalSignals).toFixed(2)) : 0;
  const avgCycleCandles = totalSignals > 0 ? (totalCycleCandles / totalSignals) : 0;
  const avgExposureHours = Number((avgCycleCandles * (5 / 60)).toFixed(2));
  const expectancyR = totalSignals > 0 ? Number((totalRealizedR / totalSignals).toFixed(3)) : 0;
  const expectancyPerHour = avgExposureHours > 0 ? Number((expectancyR / avgExposureHours).toFixed(3)) : 0;
  const riskMetrics = calculateRiskMetrics(recordedTrades);
  const nominalCycle = forwardWindow + cooldownPeriod;
  const minOosTrades = 3;
  const walkForward = calculateWalkForward(recordedTrades, oldestEvalIdx, latestEvalIdx, 0.70, minOosTrades, nominalCycle, 5 / 60, cooldownPeriod);

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
    label: `últimas ${latestEvalIdx >= oldestEvalIdx ? (latestEvalIdx - oldestEvalIdx + 1) : evalWindow} velas (5m)`,
    forwardWindow,
    forwardLabel,
    threshold: 0.004,
    targetThreshold: 0.015,
    targetMultiplier: 1.75,
    insufficient: false
  };

  return setBacktestCache(cacheKey, klines5m, res);
}

