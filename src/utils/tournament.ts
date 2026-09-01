import type { Kline } from '../services/api';
import {
  type DirectionalStats,
  type RegimeStats,
  type WalkForwardResult,
  type BacktestResult,
  createFallbackBacktestResult,
  backtestStandard,
  backtestConfluencia,
  backtestScoring,
  backtestMultitemporal,
  backtestMultifractalMTF,
} from './backtester';
import { getConfirmedClosedKlines, type ScoringWeights } from './indicators';

export type ConfidenceLevel = 'HIGH' | 'LIMITED' | 'NONE';

export interface StrategyCandidate {
  key: 'standard' | 'confluencia' | 'scoring' | 'multitemporal' | 'multifractal';
  label: string;
  profitFactor: number | null;
  expectancyR?: number;         // Expected R per trade (primary)
  expectancyPerHour?: number;   // Expected R per hour of capital exposure (primary)
  winRate: number;
  resolved: number;
  totalSignals?: number;
  forwardWindow?: number;
  avgExposureHours?: number;
  maxDrawdownR?: number;
  maxLossStreak?: number;
  sortinoRatio?: number | null;
  longStats?: DirectionalStats;
  shortStats?: DirectionalStats;
  regimeStats?: RegimeStats;
  walkForward?: WalkForwardResult;
}

export interface TournamentResult {
  bestStrategy: StrategyCandidate['key'] | 'NONE';
  strategyLabel: string;
  confidence: ConfidenceLevel;
  compositeScore: number;
  profitFactor: number | null;
  expectancyR: number;
  expectancyPerHour: number;
  maxDrawdownR?: number;
  sortinoRatio?: number | null;
  walkForward?: WalkForwardResult;
  longStats?: DirectionalStats;
  shortStats?: DirectionalStats;
  reasoning: string;
}

/**
 * Evaluates candidates using an R-multiple, capital exposure, downside risk and Walk-Forward validated model:
 * - Normalizes performance by R per trade (E[R]) and velocity (R per hour of exposure)
 * - Penalizes excessive drawdowns (MDD > 3.0R) and boosts high Sortino ratio systems
 * - Enforces Walk-Forward validation: requires In-Sample (70%) and Out-of-Sample (30%) consistency (WF != FAIL for HIGH confidence)
 * - Treats zero-loss samples (PF = null / undefined / 99.9) as undefined (PF N/D), preventing single-trade singularities
 * - Applies a sample-size sigmoid penalty curve to balance statistical significance
 * - Selects the most capital-efficient, risk-adjusted and out-of-sample robust strategy
 */
export function evaluateStrategyTournament(
  candidates: StrategyCandidate[],
  timeframe: string
): TournamentResult {
  if (candidates.length === 0) {
    return {
      bestStrategy: 'standard',
      strategyLabel: 'Standard',
      confidence: 'NONE',
      compositeScore: 0,
      profitFactor: null,
      expectancyR: 0,
      expectancyPerHour: 0,
      maxDrawdownR: 0,
      sortinoRatio: null,
      reasoning: 'Sin candidatos para evaluar',
    };
  }

  // Target minimum resolved trades for HIGH and LIMITED confidence
  const minHighResolved = timeframe === '5m' ? 12 : timeframe === '1h' ? 6 : 4;
  const minLimitedResolved = timeframe === '5m' ? 3 : timeframe === '1h' ? 3 : 2;
  const idealMin = Math.round(minHighResolved * 1.5);

  // Helper to extract duration and normalized R metrics for ranking (using In-Sample if available)
  const getMetrics = (c: StrategyCandidate, useInSample: boolean = false) => {
    const hasIS = useInSample && c.walkForward && c.walkForward.inSample && c.walkForward.inSample.signals > 0;
    const expR = hasIS ? c.walkForward!.inSample.expectancyR : (c.expectancyR ?? 0);
    const resolved = hasIS ? (c.walkForward!.inSample.wins + c.walkForward!.inSample.losses) : c.resolved;
    const profitFactor = hasIS ? c.walkForward!.inSample.profitFactor : c.profitFactor;
    const winRate = hasIS ? c.walkForward!.inSample.winRate : c.winRate;
    const maxDrawdownR = hasIS ? c.walkForward!.inSample.maxDrawdownR : (c.maxDrawdownR ?? 0);

    const candleHours = timeframe === '5m' ? (5 / 60) : timeframe === '1h' ? 1.0 : 24.0;
    const baseCandles = 6;
    const baseHours = baseCandles * candleHours; // 0.5h on 5m, 6h on 1h, 6d on 1d

    let exposureHours = c.avgExposureHours;
    if (exposureHours === undefined || exposureHours <= 0) {
      const defaultCandles = c.forwardWindow && c.forwardWindow > 0 ? c.forwardWindow : (
        c.key === 'multitemporal' ? (timeframe === '1h' ? 48 : 72) :
        c.key === 'multifractal' ? 12 : 6
      );
      exposureHours = defaultCandles * candleHours;
    }

    // Square-root time normalization: factor = sqrt(max(1.0, exposureHours / baseHours))
    // Standard diffusion: returns scale with t, volatility/risk with sqrt(t)
    const timeFactor = Math.sqrt(Math.max(1.0, exposureHours / baseHours));
    const timeNormExpR = expR / timeFactor;

    const expPerHour = c.expectancyPerHour !== undefined
      ? c.expectancyPerHour
      : (exposureHours > 0 ? expR / exposureHours : expR);

    return { expR, exposureHours, expPerHour, timeFactor, timeNormExpR, resolved, profitFactor, winRate, maxDrawdownR };
  };

  // Helper to calculate composite score normalized by R, square-root time, downside risk
  // Evaluated strictly on In-Sample (or full sample if no split) without OOS contamination (purely blind OOS)
  const calcScore = (c: StrategyCandidate): number => {
    const { expR, timeNormExpR, resolved, profitFactor, winRate, maxDrawdownR } = getMetrics(c, true);

    // Sigmoid sample confidence based on evaluated trades
    const sampleConfidence = 1 / (1 + Math.exp(-(resolved - idealMin) / 2.5));

    // Bayesian sample-aware PF ceiling
    const maxAttainablePF = Math.min(5.0, 1.0 + Math.max(0, resolved) * 0.4);

    // Handle zero-loss undefined PF (null / >= 99.0)
    let rawPF: number;
    if (profitFactor === null || !Number.isFinite(profitFactor) || profitFactor >= 99.0) {
      if (resolved >= minHighResolved) {
        // Robust sample without losses (Laplace regularization)
        rawPF = Math.min(5.0, 1.0 + Math.max(0, expR) * 2.0);
      } else {
        // Small sample with 0 losses: treat as unproven / low prior
        rawPF = Math.min(1.5, 1.0 + Math.max(0, expR) * 0.3);
      }
    } else {
      rawPF = profitFactor;
    }
    const cappedPF = Math.min(Math.max(0, rawPF), maxAttainablePF);

    // Bounded score mappings with square-root time scaling
    const expRScore = Math.max(0, Math.tanh(Math.max(0, expR) / 0.5)) * 3.0;
    const timeNormScore = Math.max(0, Math.tanh(Math.max(0, timeNormExpR) / 0.35)) * 2.5;
    const pfScore = Math.min(2.5, cappedPF * 0.5);
    const wrScore = winRate * 2.0;

    // Risk penalty for severe drawdown (> 3.0R)
    const ddPenalty = Math.exp(-Math.max(0, maxDrawdownR - 3.0) / 4.0);

    // Sortino quality adjustment (bonus for consistent positive downside, penalty for negative)
    let sortinoMultiplier = 1.0;
    if (c.sortinoRatio !== null && c.sortinoRatio !== undefined && c.sortinoRatio > 0) {
      sortinoMultiplier = 1.0 + Math.min(0.20, c.sortinoRatio * 0.05);
    } else if (c.sortinoRatio !== null && c.sortinoRatio !== undefined && c.sortinoRatio < 0) {
      sortinoMultiplier = Math.max(0.70, 1.0 + c.sortinoRatio * 0.10);
    }

    // Notice: OOS is completely excluded from score calculation to avoid data leakage.
    // OOS is used strictly downstream as a blind gatekeeper for HIGH confidence certification!
    const baseScore = ((expRScore * 0.35) + (timeNormScore * 0.25) + (pfScore * 0.25) + (wrScore * 0.15)) * ddPenalty * sortinoMultiplier;
    return baseScore * sampleConfidence;
  };

  // 1. Check for HIGH confidence candidates:
  // - In-Sample robust edge: resolved >= minHighResolved, PF >= 1.25, expR > 0
  // - Blind Out-of-Sample Certification: c.walkForward.status === 'PASS' (OOS confirms positive edge in blind validation)
  const highCandidates = candidates
    .filter(c => {
      const isMetrics = getMetrics(c, true);
      const pfOk = isMetrics.profitFactor === null || !Number.isFinite(isMetrics.profitFactor) || isMetrics.profitFactor >= 99.0
        ? true
        : isMetrics.profitFactor >= 1.25;
      const wfOk = !c.walkForward || c.walkForward.status === 'PASS';
      return c.resolved >= minHighResolved && pfOk && isMetrics.expR > 0 && wfOk;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .sort((a, b) => b.score - a.score);

  if (highCandidates.length > 0) {
    const winner = highCandidates[0].candidate;
    const { expR, expPerHour } = getMetrics(winner);
    const pfStr = winner.profitFactor !== null && Number.isFinite(winner.profitFactor) && winner.profitFactor < 99.0
      ? `PF ${winner.profitFactor.toFixed(2)}`
      : 'PF N/D';

    const riskInfo = winner.maxDrawdownR !== undefined && winner.maxDrawdownR > 0
      ? `, MDD ${winner.maxDrawdownR.toFixed(1)}R`
      : '';
    const sortinoInfo = winner.sortinoRatio !== null && winner.sortinoRatio !== undefined
      ? `, Sortino ${winner.sortinoRatio.toFixed(1)}`
      : '';
    const wfInfo = winner.walkForward && winner.walkForward.status === 'PASS' && winner.walkForward.outOfSample.signals > 0
      ? `, WF OOS ${winner.walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${winner.walkForward.outOfSample.expectancyR.toFixed(2)}R`
      : '';

    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence: 'HIGH',
      compositeScore: highCandidates[0].score,
      profitFactor: winner.profitFactor,
      expectancyR: Number(expR.toFixed(3)),
      expectancyPerHour: Number(expPerHour.toFixed(3)),
      maxDrawdownR: winner.maxDrawdownR,
      sortinoRatio: winner.sortinoRatio,
      walkForward: winner.walkForward,
      longStats: winner.longStats,
      shortStats: winner.shortStats,
      reasoning: `${winner.label} (E[R] ${expR > 0 ? '+' : ''}${expR.toFixed(2)}R, ${expPerHour.toFixed(2)}R/h, ${pfStr}${sortinoInfo}${riskInfo}${wfInfo}, ${winner.resolved} trades)`,
    };
  }

  // 2. Check for LIMITED confidence candidates (minimum sample minLimitedResolved, positive expectancy, and WF not FAIL)
  const limitedCandidates = candidates
    .filter(c => {
      const { expR } = getMetrics(c);
      if (c.resolved < minLimitedResolved) return false;
      if (expR <= 0) return false;
      // Strict rejection: A strategy that failed Out-of-Sample is completely disqualified from alerts
      if (c.walkForward && c.walkForward.status === 'FAIL') return false;
      if (c.profitFactor === null || !Number.isFinite(c.profitFactor) || c.profitFactor >= 99.0) {
        return true;
      }
      return c.profitFactor >= 1.0;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .sort((a, b) => b.score - a.score);

  if (limitedCandidates.length > 0) {
    const winner = limitedCandidates[0].candidate;
    const { expR, expPerHour } = getMetrics(winner);
    const pfStr = winner.profitFactor !== null && Number.isFinite(winner.profitFactor) && winner.profitFactor < 99.0
      ? `PF ${winner.profitFactor.toFixed(2)}`
      : 'PF N/D';
    const wfOosNote = winner.walkForward?.status === 'INSUFFICIENT_OOS' && winner.resolved >= minHighResolved
      ? ` · Muestra OOS reducida (${winner.walkForward.outOfSample.signals} trades)`
      : winner.walkForward?.status === 'NO_OOS_TRADES' && winner.resolved >= minHighResolved
      ? ' · Sin trades en OOS'
      : '';

    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence: 'LIMITED',
      compositeScore: limitedCandidates[0].score,
      profitFactor: winner.profitFactor,
      expectancyR: Number(expR.toFixed(3)),
      expectancyPerHour: Number(expPerHour.toFixed(3)),
      maxDrawdownR: winner.maxDrawdownR,
      sortinoRatio: winner.sortinoRatio,
      walkForward: winner.walkForward,
      longStats: winner.longStats,
      shortStats: winner.shortStats,
      reasoning: `${winner.label} — Muestra limitada (${winner.resolved}/${minHighResolved} trades, E[R] ${expR > 0 ? '+' : ''}${expR.toFixed(2)}R, ${pfStr}${wfOosNote})`,
    };
  }

  // 3. Fallback: No candidate qualifies with positive edge or reliable sample
  return {
    bestStrategy: 'NONE',
    strategyLabel: 'Sin Estrategia (Flat)',
    confidence: 'NONE',
    compositeScore: 0,
    profitFactor: null,
    expectancyR: 0,
    expectancyPerHour: 0,
    maxDrawdownR: undefined,
    sortinoRatio: null,
    walkForward: undefined,
    reasoning: 'Sin ventaja estadística demostrada o muestra insuficiente (<3 trades) — Permanecer FLAT (Sin trades)',
  };
}

export interface QVEAssetContext {
  symbol: string;
  data5m: Kline[];
  data1h: Kline[];
  data1d: Kline[];
  executionStyle?: 'dayTrading' | 'swing';
  triggerMode?: 'agresivo' | 'conservador';
  targetInterval?: string;
  scoringWeights?: ScoringWeights;
}

export interface QVESelectionResult {
  bestStrategy: StrategyCandidate['key'] | 'NONE';
  strategyLabel: string;
  confidence: ConfidenceLevel;
  profitFactor: number | null;
  winRate: number;
  expectancyR: number;
  expectancyPerHour: number;
  tournament: TournamentResult;
  candidates: StrategyCandidate[];
  targetInterval: string;
  triggerKlines: Kline[];
  closed5m: Kline[];
  closed1h: Kline[];
  closed1d: Kline[];
  btMulti: BacktestResult;
  btStd: BacktestResult | null;
  btConf: BacktestResult | null;
  btScore: BacktestResult | null;
  btMF: BacktestResult | null;
}

/**
 * Canonical unified strategy selector for an asset and trading profile.
 * Homogeneously evaluates all 5 quantitative engines under target execution horizon.
 */
export function runQVESelection(ctx: QVEAssetContext): QVESelectionResult {
  const { symbol, data5m, data1h, data1d, executionStyle = 'dayTrading', triggerMode = 'agresivo', scoringWeights } = ctx;

  const rawTargetInterval = ctx.targetInterval || (executionStyle === 'swing' ? '1h' : '5m');

  const closed5m = getConfirmedClosedKlines(data5m || [], '5m', symbol);
  const closed1h = getConfirmedClosedKlines(data1h || [], '1h', symbol);
  const closed1d = getConfirmedClosedKlines(data1d || [], '1d', symbol);

  // Exact resolution of trigger series matching the targetInterval
  let triggerKlines: Kline[];
  let evalInterval: string;

  if (rawTargetInterval === '1d') {
    triggerKlines = closed1d;
    evalInterval = '1d';
  } else if (rawTargetInterval === '1h' || executionStyle === 'swing') {
    triggerKlines = closed1h;
    evalInterval = '1h';
  } else {
    triggerKlines = closed5m;
    evalInterval = '5m';
  }

  const btStd = triggerKlines.length > 20 ? backtestStandard(triggerKlines, evalInterval, symbol) : null;
  const btConf = triggerKlines.length > 20 ? backtestConfluencia(triggerKlines, evalInterval, symbol) : null;
  const btScore = triggerKlines.length > 20 ? backtestScoring(triggerKlines, evalInterval, scoringWeights, symbol) : null;

  // Multi-temporal engines (VCME Sniper & Multifractal MTF) always evaluate on their native MTF trigger series:
  const vcmeTrigger = executionStyle === 'swing' ? closed1h : closed5m;
  const vcmeInterval = executionStyle === 'swing' ? '1h' : '5m';

  let btMulti: BacktestResult;
  if (evalInterval === '1d') {
    btMulti = createFallbackBacktestResult('no aplicable en 1D', 'N/A');
  } else if (vcmeTrigger.length >= 30 && closed1h.length >= 60 && closed1d.length >= 30) {
    btMulti = backtestMultitemporal(vcmeTrigger, closed1h, closed1d, vcmeInterval, symbol, executionStyle, triggerMode);
  } else {
    btMulti = createFallbackBacktestResult('datos insuficientes', executionStyle === 'swing' ? '48 hs max (Swing)' : '6 hs max (Intradía)');
  }

  let btMF: BacktestResult;
  if (evalInterval === '1d' || evalInterval === '1h') {
    btMF = createFallbackBacktestResult('no aplicable fuera de 5m', 'N/A');
  } else if (closed5m.length >= 30 && closed1h.length >= 60 && closed1d.length >= 30) {
    btMF = backtestMultifractalMTF(closed5m, closed1h, closed1d, '5m', symbol);
  } else {
    btMF = createFallbackBacktestResult('datos insuficientes', '12 velas (1 hs max)');
  }

  const candidates: StrategyCandidate[] = [
    {
      key: 'standard',
      label: 'Estándar',
      profitFactor: btStd ? btStd.profitFactor : null,
      expectancyR: btStd ? btStd.expectancyR : 0,
      expectancyPerHour: btStd ? btStd.expectancyPerHour : 0,
      avgExposureHours: btStd ? btStd.avgExposureHours : 0,
      winRate: btStd ? btStd.winRate : 0.5,
      resolved: btStd ? (btStd.totalSignals > 0 ? btStd.totalSignals : btStd.wins + btStd.losses) : 0,
      maxDrawdownR: btStd?.maxDrawdownR,
      sortinoRatio: btStd?.sortinoRatio,
      maxLossStreak: btStd?.maxLossStreak,
      longStats: btStd?.longStats,
      shortStats: btStd?.shortStats,
      regimeStats: btStd?.regimeStats,
      walkForward: btStd?.walkForward,
      forwardWindow: 6,
    },
    {
      key: 'confluencia',
      label: 'Confluencia',
      profitFactor: btConf ? btConf.profitFactor : null,
      expectancyR: btConf ? btConf.expectancyR : 0,
      expectancyPerHour: btConf ? btConf.expectancyPerHour : 0,
      avgExposureHours: btConf ? btConf.avgExposureHours : 0,
      winRate: btConf ? btConf.winRate : 0.5,
      resolved: btConf ? (btConf.totalSignals > 0 ? btConf.totalSignals : btConf.wins + btConf.losses) : 0,
      maxDrawdownR: btConf?.maxDrawdownR,
      sortinoRatio: btConf?.sortinoRatio,
      maxLossStreak: btConf?.maxLossStreak,
      longStats: btConf?.longStats,
      shortStats: btConf?.shortStats,
      regimeStats: btConf?.regimeStats,
      walkForward: btConf?.walkForward,
      forwardWindow: 6,
    },
    {
      key: 'scoring',
      label: 'Scoring',
      profitFactor: btScore ? btScore.profitFactor : null,
      expectancyR: btScore ? btScore.expectancyR : 0,
      expectancyPerHour: btScore ? btScore.expectancyPerHour : 0,
      avgExposureHours: btScore ? btScore.avgExposureHours : 0,
      winRate: btScore ? btScore.winRate : 0.5,
      resolved: btScore ? (btScore.totalSignals > 0 ? btScore.totalSignals : btScore.wins + btScore.losses) : 0,
      maxDrawdownR: btScore?.maxDrawdownR,
      sortinoRatio: btScore?.sortinoRatio,
      maxLossStreak: btScore?.maxLossStreak,
      longStats: btScore?.longStats,
      shortStats: btScore?.shortStats,
      regimeStats: btScore?.regimeStats,
      walkForward: btScore?.walkForward,
      forwardWindow: 6,
    },
    {
      key: 'multitemporal',
      label: 'VCME Sniper',
      profitFactor: btMulti.profitFactor,
      expectancyR: btMulti.expectancyR,
      expectancyPerHour: btMulti.expectancyPerHour,
      avgExposureHours: btMulti.avgExposureHours,
      winRate: btMulti.winRate,
      resolved: btMulti.totalSignals > 0 ? btMulti.totalSignals : btMulti.wins + btMulti.losses,
      maxDrawdownR: btMulti?.maxDrawdownR,
      sortinoRatio: btMulti?.sortinoRatio,
      maxLossStreak: btMulti?.maxLossStreak,
      longStats: btMulti?.longStats,
      shortStats: btMulti?.shortStats,
      regimeStats: btMulti?.regimeStats,
      walkForward: btMulti?.walkForward,
      forwardWindow: executionStyle === 'swing' ? 48 : 72,
    },
    {
      key: 'multifractal',
      label: 'Multifractal MTF',
      profitFactor: btMF.profitFactor,
      expectancyR: btMF.expectancyR,
      expectancyPerHour: btMF.expectancyPerHour,
      avgExposureHours: btMF.avgExposureHours,
      winRate: btMF.winRate,
      resolved: btMF.totalSignals > 0 ? btMF.totalSignals : btMF.wins + btMF.losses,
      maxDrawdownR: btMF?.maxDrawdownR,
      sortinoRatio: btMF?.sortinoRatio,
      maxLossStreak: btMF?.maxLossStreak,
      longStats: btMF?.longStats,
      shortStats: btMF?.shortStats,
      regimeStats: btMF?.regimeStats,
      walkForward: btMF?.walkForward,
      forwardWindow: 12,
    },
  ];

  const tournament = evaluateStrategyTournament(candidates, evalInterval);
  const bestStrategy = tournament.bestStrategy;
  const strategyLabel = tournament.strategyLabel;
  const bestCandidate = candidates.find(c => c.key === bestStrategy);
  const bestWinRate = bestCandidate ? bestCandidate.winRate : btMulti.winRate;

  return {
    bestStrategy,
    strategyLabel,
    confidence: tournament.confidence,
    profitFactor: tournament.profitFactor,
    winRate: bestWinRate,
    expectancyR: tournament.expectancyR,
    expectancyPerHour: tournament.expectancyPerHour,
    tournament,
    candidates,
    targetInterval: evalInterval,
    triggerKlines,
    closed5m,
    closed1h,
    closed1d,
    btMulti,
    btStd,
    btConf,
    btScore,
    btMF,
  };
}

/**
 * Validates whether a generated BUY/SELL signal possesses a positive historical directional expectancy.
 * Neutralizes signals if the strategy has a negative expectancy in that direction over a statistically
 * meaningful sample (default: >= 3 trades).
 */
export function sanitizeSignalWithDirectionalEdge(
  rawSignal: string,
  longStats?: { signals: number; expectancyR: number },
  shortStats?: { signals: number; expectancyR: number },
  minTrades: number = 3
): 'BUY' | 'SELL' | 'NEUTRAL' {
  if (!rawSignal || rawSignal === 'NEUTRAL') return 'NEUTRAL';
  const isBuy = rawSignal.includes('BUY');
  const isSell = rawSignal.includes('SELL');

  if (isBuy && longStats && longStats.signals >= minTrades && longStats.expectancyR < 0) {
    return 'NEUTRAL';
  }
  if (isSell && shortStats && shortStats.signals >= minTrades && shortStats.expectancyR < 0) {
    return 'NEUTRAL';
  }
  return isBuy ? 'BUY' : isSell ? 'SELL' : 'NEUTRAL';
}

