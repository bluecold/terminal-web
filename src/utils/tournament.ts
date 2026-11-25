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
  backtestMFLS,
  getStrategyForwardWindow,
} from './backtester';
import { getConfirmedClosedKlines, calculateADXSeries, calculateRegimeSeriesWithHysteresis, isCryptoAsset, type ScoringWeights } from './indicators';

export type ConfidenceLevel = 'HIGH' | 'LIMITED' | 'NONE';

export interface StrategyCandidate {
  key: 'standard' | 'confluencia' | 'scoring' | 'multitemporal' | 'multifractal' | 'mfls';
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
  frictionDiscards?: number;
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
  currentRegime?: 'trending' | 'ranging';
  reasoning: string;
}

// Empirical cross-sectional watchlist priors for 5m equities (derived from 45-stock / 60-day real data under 0.14% friction):
export const WATCHLIST_5M_PRIORS: Record<string, number> = {
  mfls: -0.35,
  standard: -0.25,
  scoring: -0.28,
  vcme: -0.28,
  multitemporal: -0.28,
  multifractal: -0.19,
  confluencia: -0.10,
};

/**
 * Engines that are informational-only on 5m equities. Measured on the 21-symbol watchlist over 60 days
 * net of 0.11% commission + 0.03% slippage, only Confluencia was positive on this profile
 * (Standard -0.13R, Scoring -0.23R, VCME -0.26R, Multifractal -0.29R, MFLS -0.31R). Its +0.06R did not
 * hold out of sample (2026-09-25 → 10-14 and 49 unseen symbols: ≈ 0R after its ATR guard), so it stays
 * the alerting engine as the least-bad one, not as a validated edge. These engines stay
 * computed, backtested and visible, but never win the tournament nor emit PRIMARY alerts there.
 */
export const INFORMATIONAL_STRATEGIES_5M_EQUITY: ReadonlySet<StrategyCandidate['key']> = new Set<StrategyCandidate['key']>([
  'standard', 'scoring', 'multitemporal', 'multifractal', 'mfls',
]);

export function isInformationalStrategy(
  strategyKey: string,
  targetInterval: string | undefined,
  isCrypto: boolean | undefined
): boolean {
  return targetInterval === '5m' && isCrypto === false
    && INFORMATIONAL_STRATEGIES_5M_EQUITY.has(strategyKey as StrategyCandidate['key']);
}

// Target minimum In-Sample resolved trades for HIGH and LIMITED confidence
export function getStrategyMinResolved(
  strategyKey: StrategyCandidate['key'] | string,
  timeframe: string,
  level: 'HIGH' | 'LIMITED'
): number {
  const isSniper = strategyKey === 'multitemporal' || strategyKey === 'multifractal' || strategyKey === 'vcme' || strategyKey === 'mfls';
  if (level === 'LIMITED') {
    if (timeframe === '1d') return 2;
    // In 5m intraday, all strategies require at least 3 resolved trades to qualify for LIMITED.
    // Prevents lucky 2-trade random runs from hijacking the tournament over proven systems like Confluencia.
    if (timeframe === '5m') return 3;
    if (isSniper) return 2;
    return 3;
  }
  // level === 'HIGH'
  if (timeframe === '1d') return 5;
  if (timeframe === '1h') return isSniper ? 3 : 5;
  // 5m: snipers require at least 6 trades for HIGH (up from 4), scalpers 8
  return isSniper ? 6 : 8;
}

/**
 * Canonical continuous out-of-sample Bayesian modulation:
 * - Replaces brittle categorical tags ('FAIL' when E[R]=+0.05R was penalizing with 0.50).
 * - Monotonically rewards positive out-of-sample evidence (range 0.85 to 1.15).
 * - Neutral baseline for unobserved OOS (0.75).
 * - Penalizes real negative edge (0.70 down to 0.35 for decisive toxicity).
 * - Shared across primary tournament ranking (calcScore) and fallback evaluation (getActionableStrategyCandidates).
 */
export function calculateContinuousOosMultiplier(
  wf?: WalkForwardResult,
  dirStats?: DirectionalStats
): { multiplier: number; note: string } {
  if (!wf) {
    return { multiplier: 1.0, note: 'sin datos de walk-forward' };
  }

  const oos = dirStats && dirStats.signals > 0 ? dirStats : wf.outOfSample;
  if (!oos || oos.signals === 0 || wf.status === 'NO_OOS_TRADES') {
    return { multiplier: 0.75, note: 'sin operaciones OOS; confianza limitada por muestra' };
  }

  const isDirectional = Boolean(dirStats && dirStats.signals > 0);
  const oosPfOk = oos.profitFactor === null || !Number.isFinite(oos.profitFactor) || oos.profitFactor >= 1.0;

  // When directional stats are supplied, evaluate directional status rather than aggregate status
  const effectiveStatus: 'PASS' | 'INSUFFICIENT_OOS' | 'FAIL' = isDirectional
    ? (oos.signals < 3 ? 'INSUFFICIENT_OOS' : (oos.expectancyR >= 0.10 && oosPfOk ? 'PASS' : 'FAIL'))
    : wf.status;

  if (effectiveStatus === 'PASS') {
    return {
      multiplier: 1.15,
      note: `Walk-Forward aprobado (+${oos.expectancyR.toFixed(2)}R OOS en ${oos.signals} ops)`,
    };
  }

  if (effectiveStatus === 'INSUFFICIENT_OOS') {
    if (oos.signals > 0 && oos.expectancyR > 0) {
      return {
        multiplier: 0.90,
        note: `OOS positivo con muestra reducida (+${oos.expectancyR.toFixed(2)}R)`,
      };
    }
    return {
      multiplier: 0.70,
      note: `muestra reducida no concluyente (${oos.signals} ${oos.signals === 1 ? 'trade' : 'trades'}, ${oos.expectancyR >= 0 ? '+' : ''}${oos.expectancyR.toFixed(2)}R)`,
    };
  }

  // effectiveStatus === 'FAIL'
  // When an engine was positive in OOS (e.g. +0.05R) but missed the +0.10R HIGH hurdle,
  // it is rewarded (0.82-0.88), ranking strictly above untested engines (0.75).
  if (oos.expectancyR >= 0) {
    const boost = Math.min(0.06, oos.expectancyR * 0.6);
    return {
      multiplier: Number((0.82 + boost).toFixed(2)),
      note: `OOS marginal positivo (+${oos.expectancyR.toFixed(2)}R, PF ${oos.profitFactor?.toFixed(2) ?? 'N/D'})`,
    };
  }

  // Negative OOS under FAIL:
  const isToxic = oos.expectancyR < -0.15 || (oos.profitFactor !== null && oos.profitFactor < 0.70) || oos.signals >= 6;
  if (isToxic) {
    return {
      multiplier: 0.35,
      note: `OOS tóxico (${oos.expectancyR.toFixed(2)}R en ${oos.signals} ops, PF ${oos.profitFactor?.toFixed(2) ?? 'N/D'})`,
    };
  }

  return {
    multiplier: 0.65,
    note: `OOS marginal tolerado (${oos.expectancyR.toFixed(2)}R, PF ${oos.profitFactor?.toFixed(2) ?? 'N/D'})`,
  };
}

/**
 * Evaluates candidates using an R-multiple, capital exposure, downside risk and Walk-Forward validated model:
 * - Normalizes performance by R per trade (E[R]) and velocity (R per hour of exposure)
 * - Penalizes excessive drawdowns (MDD > 2.5R) and boosts high Sortino ratio systems
 * - Enforces Walk-Forward validation: requires In-Sample (70%) and Out-of-Sample (30%) consistency (WF != FAIL for HIGH confidence)
 * - Treats zero-loss samples (PF = null / undefined / 99.9) as undefined (PF N/D), preventing single-trade singularities
 * - Regularizes sample size via monotonic Bayesian Shrinkage with watchlist-level cross-sectional priors
 * - Conditions strategy selection and scoring on current market regime with hysteresis (trending ADX >= 26 vs ranging ADX <= 22)
 */
export function evaluateStrategyTournament(
  inputCandidates: StrategyCandidate[],
  timeframe: string,
  currentRegime?: 'trending' | 'ranging',
  isCrypto: boolean = true
): TournamentResult {
  // Informational engines (5m equities) never compete for the win.
  const candidates = inputCandidates.filter(c => !isInformationalStrategy(c.key, timeframe, isCrypto));
  if (candidates.length === 0) {
    return {
      bestStrategy: 'NONE',
      strategyLabel: 'Sin Estrategia (Flat)',
      confidence: 'NONE',
      compositeScore: 0,
      profitFactor: null,
      expectancyR: 0,
      expectancyPerHour: 0,
      maxDrawdownR: 0,
      sortinoRatio: null,
      currentRegime,
      reasoning: 'Sin candidatos para evaluar',
    };
  }


  // Helper to extract duration and normalized R metrics for ranking (using In-Sample if available)
  const getMetrics = (c: StrategyCandidate, useInSample: boolean = false) => {
    const hasIS = useInSample && Boolean(c.walkForward && c.walkForward.inSample);
    const is = hasIS ? c.walkForward!.inSample : undefined;

    const expR = is ? is.expectancyR : (c.expectancyR ?? 0);
    const resolved = is
      ? (is.signals > 0 ? is.signals : is.wins + is.losses)
      : (c.totalSignals && c.totalSignals > 0 ? c.totalSignals : c.resolved);
    const profitFactor = is ? is.profitFactor : c.profitFactor;
    const winRate = is ? is.winRate : c.winRate;
    const maxDrawdownR = is ? is.maxDrawdownR : (c.maxDrawdownR ?? 0);
    const sortinoRatio = is && is.sortinoRatio !== undefined ? is.sortinoRatio : (c.sortinoRatio ?? null);
    const regimeStats = is && is.regimeStats !== undefined ? is.regimeStats : c.regimeStats;
    const longStats = is && is.longStats !== undefined ? is.longStats : c.longStats;
    const shortStats = is && is.shortStats !== undefined ? is.shortStats : c.shortStats;

    const candleHours = timeframe === '5m' ? (5 / 60) : timeframe === '1h' ? 1.0 : 24.0;
    // On 5m, use 12 candles (1 hour) as base holding duration for intraday day trading,
    // eliminating the artificial 40% penalty against 24-candle momentum engines like Confluencia.
    const baseCandles = timeframe === '5m' ? 12 : 6;
    const baseHours = baseCandles * candleHours; // 1.0h on 5m, 6h on 1h, 6d on 1d

    let exposureHours = is?.avgExposureHours ?? c.avgExposureHours;
    if (exposureHours === undefined || exposureHours <= 0) {
      const defaultCandles = c.forwardWindow && c.forwardWindow > 0 ? c.forwardWindow : (
        c.key === 'multitemporal' ? (timeframe === '1h' ? 48 : 24) :
        c.key === 'multifractal' ? 12 : 6
      );
      exposureHours = defaultCandles * candleHours;
    }

    // Sub-diffusive time scaling (power 0.35): balances trade payoff vs holding duration
    const timeFactor = Math.pow(Math.max(1.0, exposureHours / baseHours), 0.35);
    const timeNormExpR = expR / timeFactor;

    const expPerHour = c.expectancyPerHour !== undefined
      ? c.expectancyPerHour
      : (exposureHours > 0 ? expR / exposureHours : expR);

    return {
      expR,
      exposureHours,
      expPerHour,
      timeFactor,
      timeNormExpR,
      resolved,
      profitFactor,
      winRate,
      maxDrawdownR,
      sortinoRatio,
      regimeStats,
      longStats,
      shortStats,
    };
  };

  // Multiplicity deflation factor (White's Reality Check / Bonferroni adjustment):
  // Deflates score when selecting the maximum of K competing candidate models
  const activeCandidatesCount = candidates.filter(c => getMetrics(c, true).resolved >= getStrategyMinResolved(c.key, timeframe, 'LIMITED')).length;
  const multiplicityFactor = 1 / Math.sqrt(1 + 0.10 * Math.max(0, activeCandidatesCount - 1));

  // Helper to compute Bayesian-shrunk time-normalized score strictly from In-Sample data
  const calcScore = (candidate: StrategyCandidate): number => {
    const { expR, resolved, timeFactor, maxDrawdownR, sortinoRatio, regimeStats } = getMetrics(candidate, true);
    if (expR <= 0) return 0;

    // 1. Empirical Bayesian Shrinkage with conservative neutral prior (H0: E[R] = 0):
    // Shrinks noisy small samples towards 0 rather than letting 2 lucky trades crown an engine,
    // while preserving verified positive expectancy for sample sizes N >= 3 without artificial negative offset.
    const isSniper = candidate.key === 'multitemporal' || candidate.key === 'multifractal' || candidate.key === 'mfls';
    const n0 = isSniper
      ? (timeframe === '5m' ? 4 : (timeframe === '1h' ? 3 : 2))
      : (timeframe === '5m' ? 6 : (timeframe === '1h' ? 5 : 4));
    const shrinkage = resolved / (resolved + n0);
    const shrunkExpR = expR * shrinkage;

    // 2. Time normalization: scales trade edge by duration factor (purely In-Sample)
    const timeNormScore = shrunkExpR / timeFactor;

    // 3. Risk penalty for severe drawdown (> 2.5R) (purely In-Sample)
    const ddPenalty = Math.exp(-Math.max(0, maxDrawdownR - 2.5) / 3.0);

    // 4. Sortino quality adjustment (downside risk asymmetry, purely In-Sample)
    let sortinoMultiplier = 1.0;
    if (sortinoRatio !== null && sortinoRatio !== undefined && sortinoRatio > 0) {
      sortinoMultiplier = 1.0 + Math.min(0.20, sortinoRatio * 0.05);
    } else if (sortinoRatio !== null && sortinoRatio !== undefined && sortinoRatio < 0) {
      sortinoMultiplier = Math.max(0.70, 1.0 + sortinoRatio * 0.10);
    }

    // 5. Regime-specific Bayesian modulation (purely In-Sample):
    let regimeMultiplier = 1.0;
    if (currentRegime && regimeStats) {
      const stats = currentRegime === 'trending' ? regimeStats.trending : regimeStats.ranging;
      if (stats && stats.signals > 0) {
        const regimeShrink = stats.signals / (stats.signals + 4);
        const shrunkRegimeExpR = stats.expectancyR * regimeShrink;
        regimeMultiplier = Math.max(0.70, Math.min(1.30, 1.0 + Math.tanh(shrunkRegimeExpR * 0.40) * 0.25));
      }
    }

    // 6. Walk-Forward OOS Continuous Bayesian Modulation:
    // Replaces brittle categorical tags (e.g. status='FAIL' when E[R]=+0.05R was penalizing with 0.50)
    // with smooth empirical Bayes shrinkage. Positive OOS is monotonically rewarded and never below 0.85.
    const oosMultiplier = calculateContinuousOosMultiplier(candidate.walkForward).multiplier;

    return timeNormScore * ddPenalty * sortinoMultiplier * regimeMultiplier * multiplicityFactor * oosMultiplier;
  };

  // Helper to check if a candidate's regime performance is decisively toxic under Bayesian uncertainty
  // Replaces the brittle step-function (N>=3 && E[R]<0) with an empirical Bayes toxicity threshold (-0.15R shrunk)
  const isRegimeDecisivelyToxic = (regimeStats?: RegimeStats): boolean => {
    if (!currentRegime || !regimeStats) return false;
    const stats = currentRegime === 'trending' ? regimeStats.trending : regimeStats.ranging;
    if (!stats || stats.signals < 3) return false;
    const regimeShrink = stats.signals / (stats.signals + 4);
    const shrunkRegimeExpR = stats.expectancyR * regimeShrink;
    return shrunkRegimeExpR < -0.15;
  };

  // 1. Check for HIGH confidence candidates:
  const highCandidates = candidates
    .filter(c => {
      const isMetrics = getMetrics(c, true);
      const minHigh = getStrategyMinResolved(c.key, timeframe, 'HIGH');
      const pfOk = isMetrics.profitFactor === null || !Number.isFinite(isMetrics.profitFactor) || isMetrics.profitFactor >= 99.0
        ? true
        : isMetrics.profitFactor >= 1.25;
      const wfOk = !c.walkForward || c.walkForward.status === 'PASS';
      const regimeOk = !isRegimeDecisivelyToxic(isMetrics.regimeStats);

      return isMetrics.resolved >= minHigh && pfOk && isMetrics.expR > 0 && wfOk && regimeOk;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (highCandidates.length > 0) {
    const winnerItem = highCandidates[0];
    const winner = winnerItem.candidate;
    const winnerScore = winnerItem.score;
    const isMetrics = getMetrics(winner, true);

    // ── Multiplicity Selection-of-Maximum Bias Gate ──
    // When evaluating K competing engines, selecting the maximum estimator inflates observed edge.
    // Hurdle 1: Absolute deflated expectancy hurdle for HIGH certification.
    // Evaluated strictly on deflated quality expectancy in R per trade (independent of duration / timeFactor
    // and un-inflated by ordinal utility multipliers like Sortino, Regime, or OOS boosts)
    // so that fast scalps and longer setups face a uniform, genuine standard of statistical edge.
    const isWinnerSniper = winner.key === 'multitemporal' || winner.key === 'multifractal' || winner.key === 'mfls';
    const n0 = isWinnerSniper
      ? (timeframe === '5m' ? 6 : (timeframe === '1h' ? 3 : 2))
      : (timeframe === '5m' ? 8 : (timeframe === '1h' ? 5 : 4));
    const shrinkage = isMetrics.resolved / (isMetrics.resolved + n0);
    const is5mEquity = timeframe === '5m' && isCrypto === false;
    const winnerPriorExpR = is5mEquity ? (WATCHLIST_5M_PRIORS[winner.key] ?? -0.25) : 0;
    const shrunkExpR = isMetrics.expR * shrinkage;
    const ddPenalty = Math.exp(-Math.max(0, isMetrics.maxDrawdownR - 2.5) / 3.0);
    const deflatedQualityExpR = shrunkExpR * multiplicityFactor * ddPenalty;
    const minHighDeflatedHurdle = 0.040; // +0.04R genuine deflated quality edge per trade
    const passesAbsoluteHurdle = deflatedQualityExpR >= minHighDeflatedHurdle;

    // Hurdle 2: Decisive separation margin over the runner-up under multiplicity.
    // If K >= 3 active candidates compete and multiple candidates pass HIGH criteria,
    // the winner must separate from the runner-up by a margin scaling with K.
    // If within noise, selection-of-maximum implies winner was chosen by luck -> degrade HIGH to LIMITED.
    let passesSeparationMargin = true;
    let multiplicityNote = '';
    if (activeCandidatesCount >= 3 && highCandidates.length >= 2) {
      const runnerUpScore = highCandidates[1].score;
      const marginRequired = 0.025 * Math.min(4, activeCandidatesCount - 1); // e.g. 5% for K=3, 7.5% for K=4, 10% for K=5
      if (runnerUpScore > 0 && winnerScore < runnerUpScore * (1 + marginRequired)) {
        passesSeparationMargin = false;
        const actualMarginPct = ((winnerScore / runnerUpScore - 1) * 100).toFixed(1);
        const reqMarginPct = (marginRequired * 100).toFixed(1);
        multiplicityNote = ` · Margen sobre 2º (${highCandidates[1].candidate.label}) insuficiente (${actualMarginPct}% vs ${reqMarginPct}% req bajo K=${activeCandidatesCount}) → Degradado a LIMITED`;
      }
    }

    if (!passesAbsoluteHurdle) {
      multiplicityNote += ` · Score deflactado (${deflatedQualityExpR.toFixed(3)}R < ${minHighDeflatedHurdle.toFixed(3)}R) insuficiente bajo multiplicidad K=${activeCandidatesCount} → Degradado a LIMITED`;
    }

    // Hurdle 3: Multi-Fold Walk-Forward consistency gate.
    // Differentiates between negative evidence (FAIL) and absence of evidence (NO_DATA / empty fold).
    // An empty fold (0 trades due to long cycle or purged straddlers) does not constitute failure.
    // Gate requires foldsPassed >= min(2, foldsWithData).
    // When foldsWithData >= 2, at least 2 folds must pass (at most 1 failure).
    // When foldsWithData === 1, that single fold must pass and no fold may have failed.
    let passesFoldsGate = true;
    if (winner.walkForward?.folds && winner.walkForward.folds.length > 0) {
      const folds = winner.walkForward.folds;
      const foldsPassed = winner.walkForward.foldsPassed ?? 0;
      const foldsWithData = winner.walkForward.foldsWithData ?? (
        folds.filter(f => f.status !== 'NO_DATA' && ((f.oosTradesCount ?? 0) > 0 || f.passed)).length
      );
      const effectiveFoldsWithData = Math.max(foldsPassed, foldsWithData);
      const minFoldsRequired = Math.min(2, effectiveFoldsWithData);

      if (effectiveFoldsWithData === 0) {
        // Zero empirical data across all temporal sub-folds: cannot certify HIGH without fold evidence
        passesFoldsGate = false;
        multiplicityNote += ` · Folds Walk-Forward sin operaciones (0/${folds.length} con datos) → Degradado a LIMITED`;
      } else if (foldsPassed < minFoldsRequired) {
        passesFoldsGate = false;
        multiplicityNote += ` · Folds Walk-Forward insuficientes (${foldsPassed}/${folds.length} aprobados, mín ${minFoldsRequired} req) → Degradado a LIMITED`;
      }
    }

    // Hurdle 4: Cross-sectional watchlist prior consistency gate (for 5m equities).
    // In noisy short timeframes (5m), strategies with negative universe priors (< 0)
    // require at least 20 resolved trades on this individual symbol to award HIGH confidence.
    // If resolved < 20, confidence is degraded to LIMITED (alert remains fully active for the trader).
    let passesWatchlistGate = true;
    if (is5mEquity && winnerPriorExpR < 0 && isMetrics.resolved < 20) {
      passesWatchlistGate = false;
      multiplicityNote += ` · Muestra local (${isMetrics.resolved}/20) insuficiente para superar prior transversal negativo (${winnerPriorExpR.toFixed(2)}R) → Degradado a LIMITED`;
    }

    const confidence: 'HIGH' | 'LIMITED' = (passesAbsoluteHurdle && passesSeparationMargin && passesFoldsGate && passesWatchlistGate) ? 'HIGH' : 'LIMITED';

    const pfStr = isMetrics.profitFactor !== null && Number.isFinite(isMetrics.profitFactor) && isMetrics.profitFactor < 99.0
      ? `PF ${isMetrics.profitFactor.toFixed(2)}`
      : 'PF N/D';

    const isMDD = winner.walkForward?.inSample?.maxDrawdownR ?? winner.maxDrawdownR;
    const riskInfo = isMDD !== undefined && isMDD > 0
      ? `, MDD ${isMDD.toFixed(1)}R`
      : '';
    const isSortino = winner.walkForward?.inSample?.sortinoRatio ?? winner.sortinoRatio;
    const sortinoInfo = isSortino !== null && isSortino !== undefined
      ? `, Sortino ${isSortino.toFixed(1)}`
      : '';
    const foldsNote = winner.walkForward?.foldsPassed !== undefined
      ? `, ${winner.walkForward.foldsPassed}/${winner.walkForward.folds?.length ?? 3} folds`
      : '';
    const wfInfo = winner.walkForward && winner.walkForward.status === 'PASS' && winner.walkForward.outOfSample.signals > 0
      ? `, WF OOS ${winner.walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${winner.walkForward.outOfSample.expectancyR.toFixed(2)}R${foldsNote}`
      : '';
    const regimeInfo = currentRegime
      ? ` · ${currentRegime === 'trending' ? '🔥 Tendencia (Histéresis ≥26/≤22)' : '💤 Rango (Histéresis ≤22/≥26)'}`
      : '';

    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence,
      compositeScore: winnerScore,
      profitFactor: isMetrics.profitFactor,
      expectancyR: Number(isMetrics.expR.toFixed(3)),
      expectancyPerHour: Number(isMetrics.expPerHour.toFixed(3)),
      maxDrawdownR: isMDD,
      sortinoRatio: isSortino,
      walkForward: winner.walkForward,
      longStats: winner.walkForward?.inSample?.longStats ?? winner.longStats,
      shortStats: winner.walkForward?.inSample?.shortStats ?? winner.shortStats,
      currentRegime,
      reasoning: confidence === 'HIGH'
        ? `${winner.label} (IS: ${isMetrics.resolved} trades, E[R] ${isMetrics.expR > 0 ? '+' : ''}${isMetrics.expR.toFixed(2)}R, ${isMetrics.expPerHour.toFixed(2)}R/h, ${pfStr}${sortinoInfo}${riskInfo}${wfInfo}${regimeInfo})`
        : `${winner.label} — Filtro de multiplicidad (IS: ${isMetrics.resolved} trades, E[R] ${isMetrics.expR > 0 ? '+' : ''}${isMetrics.expR.toFixed(2)}R, ${pfStr}${multiplicityNote}${regimeInfo})`,
    };
  }

  // 2. Check for LIMITED confidence candidates:
  const limitedCandidates = candidates
    .filter(c => {
      const isMetrics = getMetrics(c, true);
      const minLimited = getStrategyMinResolved(c.key, timeframe, 'LIMITED');
      if (isMetrics.resolved < minLimited) return false;
      if (isMetrics.expR <= 0) return false;

      // Disqualify if genuinely toxic regime
      if (isRegimeDecisivelyToxic(isMetrics.regimeStats)) {
        return false;
      }

      // Check Walk-Forward FAIL: disqualify only if genuinely toxic out-of-sample
      if (c.walkForward && c.walkForward.status === 'FAIL') {
        const oos = c.walkForward.outOfSample;
        const oosPfOk = oos.profitFactor === null || oos.profitFactor >= 0.75;
        const foldsWithData = c.walkForward.folds?.filter(fold => fold.status !== 'NO_DATA') ?? [];
        const nonNegativeFolds = foldsWithData.filter(fold => fold.oosExpectancyR >= 0).length;
        const hasNonNegativeFolds = foldsWithData.length === 0 || nonNegativeFolds > 0;

        // Disqualify if genuinely toxic OOS (< -0.25R) or severe PF collapse (< 0.75) with no positive folds
        if (oos.expectancyR < -0.25 || (!oosPfOk && !hasNonNegativeFolds)) {
          return false;
        }
      }

      // Minimum profit factor requirement: must be >= 1.0 (or infinite/null for 0 loss)
      if (isMetrics.profitFactor !== null && Number.isFinite(isMetrics.profitFactor) && isMetrics.profitFactor < 99.0 && isMetrics.profitFactor < 1.0) {
        return false;
      }

      return true;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (limitedCandidates.length > 0) {
    const winner = limitedCandidates[0].candidate;
    const isMetrics = getMetrics(winner, true);
    const fullMetrics = getMetrics(winner, false);
    const effExpR = isMetrics.expR > 0 ? isMetrics.expR : fullMetrics.expR;
    const effPf = isMetrics.profitFactor ?? fullMetrics.profitFactor;
    const effResolved = Math.max(isMetrics.resolved, fullMetrics.resolved);
    const winnerMinHigh = getStrategyMinResolved(winner.key, timeframe, 'HIGH');
    const pfStr = effPf !== null && Number.isFinite(effPf) && effPf < 99.0
      ? `PF ${effPf.toFixed(2)}`
      : 'PF N/D';
    const wfOosNote = winner.walkForward?.status === 'INSUFFICIENT_OOS' && effResolved >= winnerMinHigh
      ? ` · Muestra OOS reducida (${winner.walkForward.outOfSample.signals} trades)`
      : winner.walkForward?.status === 'NO_OOS_TRADES' && effResolved >= winnerMinHigh
      ? ' · Sin trades en OOS'
      : winner.walkForward?.status === 'FAIL'
      ? ` · OOS marginal (${winner.walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${winner.walkForward.outOfSample.expectancyR.toFixed(2)}R)`
      : '';
    const frictionNote = (winner.frictionDiscards ?? 0) > 0
      ? ` · ${winner.frictionDiscards} descartadas por micro-stop (<0.31%)`
      : '';
    const regimeInfo = currentRegime
      ? ` · ${currentRegime === 'trending' ? '🔥 Tendencia (Histéresis ≥26/≤22)' : '💤 Rango (Histéresis ≤22/≥26)'}`
      : '';

    const isMDD = winner.walkForward?.inSample?.maxDrawdownR ?? winner.maxDrawdownR;
    const isSortino = winner.walkForward?.inSample?.sortinoRatio ?? winner.sortinoRatio;

    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence: 'LIMITED',
      compositeScore: limitedCandidates[0].score,
      profitFactor: effPf,
      expectancyR: Number(effExpR.toFixed(3)),
      expectancyPerHour: Number(isMetrics.expPerHour.toFixed(3)),
      maxDrawdownR: isMDD,
      sortinoRatio: isSortino,
      walkForward: winner.walkForward,
      longStats: winner.walkForward?.inSample?.longStats ?? winner.longStats,
      shortStats: winner.walkForward?.inSample?.shortStats ?? winner.shortStats,
      currentRegime,
      reasoning: `${winner.label} — Muestra limitada (${isMetrics.resolved}/${winnerMinHigh} trades IS, E[R] ${effExpR > 0 ? '+' : ''}${effExpR.toFixed(2)}R, ${pfStr}${wfOosNote}${frictionNote}${regimeInfo})`,
    };
  }

  // 3. Fallback: No candidate qualifies with positive edge or reliable sample
  const totalFrictionDiscards = candidates.reduce((acc, c) => acc + (c.frictionDiscards ?? 0), 0);
  const frictionNote = totalFrictionDiscards > 0
    ? ` (${totalFrictionDiscards} señales filtradas por micro-stop <0.31% comisiones)`
    : '';

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
    currentRegime,
    reasoning: `Sin ventaja estadística demostrada o muestra insuficiente (<3 trades)${frictionNote} — Permanecer FLAT (Sin trades)`,
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
  currentRegime?: 'trending' | 'ranging';
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
  btMFLS?: BacktestResult | null;
  symbol?: string;
  isCrypto?: boolean;
}

export type StrategySignalMap = Partial<Record<StrategyCandidate['key'], string>>;

export interface ActionableStrategySelection {
  strategy: StrategyCandidate['key'] | 'NONE';
  strategyLabel: string;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: ConfidenceLevel;
  profitFactor: number | null;
  winRate: number;
  longStats?: DirectionalStats;
  shortStats?: DirectionalStats;
  isFallback: boolean;
  reasoning: string;
}

/**
 * Canonical unified strategy selector for an asset and trading profile.
 * Homogeneously evaluates all 5 quantitative engines under target execution horizon.
 */
export function runQVESelection(ctx: QVEAssetContext): QVESelectionResult {
  const { symbol, data5m, data1h, data1d, executionStyle = 'dayTrading', triggerMode = 'agresivo', scoringWeights } = ctx;
  const isCrypto = isCryptoAsset(symbol);

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

  let btMFLS: BacktestResult | null = null;
  if (evalInterval === '1d' || evalInterval === '1h') {
    btMFLS = createFallbackBacktestResult('no aplicable fuera de 5m', 'N/A');
  } else if (closed5m.length >= 30) {
    btMFLS = backtestMFLS(closed5m, '5m', symbol);
  } else {
    btMFLS = createFallbackBacktestResult('datos insuficientes', '18 velas (1.5 hs max)');
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
      forwardWindow: getStrategyForwardWindow('standard', evalInterval, executionStyle, symbol),
      frictionDiscards: btStd?.discards?.frictionFilter ?? 0,
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
      forwardWindow: getStrategyForwardWindow('confluencia', evalInterval, executionStyle, symbol),
      frictionDiscards: btConf?.discards?.frictionFilter ?? 0,
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
      forwardWindow: getStrategyForwardWindow('scoring', evalInterval, executionStyle, symbol),
      frictionDiscards: btScore?.discards?.frictionFilter ?? 0,
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
      forwardWindow: getStrategyForwardWindow('multitemporal', evalInterval, executionStyle, symbol),
      frictionDiscards: btMulti?.discards?.frictionFilter ?? 0,
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
      forwardWindow: getStrategyForwardWindow('multifractal', evalInterval, executionStyle, symbol),
      frictionDiscards: btMF?.discards?.frictionFilter ?? 0,
    },
    {
      key: 'mfls',
      label: 'MFLS (Reversión)',
      profitFactor: btMFLS ? btMFLS.profitFactor : null,
      expectancyR: btMFLS ? btMFLS.expectancyR : 0,
      expectancyPerHour: btMFLS ? btMFLS.expectancyPerHour : 0,
      avgExposureHours: btMFLS ? btMFLS.avgExposureHours : 0,
      winRate: btMFLS ? btMFLS.winRate : 0.5,
      resolved: btMFLS ? (btMFLS.totalSignals > 0 ? btMFLS.totalSignals : btMFLS.wins + btMFLS.losses) : 0,
      maxDrawdownR: btMFLS?.maxDrawdownR,
      sortinoRatio: btMFLS?.sortinoRatio,
      maxLossStreak: btMFLS?.maxLossStreak,
      longStats: btMFLS?.longStats,
      shortStats: btMFLS?.shortStats,
      regimeStats: btMFLS?.regimeStats,
      walkForward: btMFLS?.walkForward,
      forwardWindow: getStrategyForwardWindow('mfls', evalInterval, executionStyle, symbol),
      frictionDiscards: btMFLS?.discards?.frictionFilter ?? 0,
    },
  ];

  // ── Detect current market regime on confirmed trigger candles (with Hysteresis) ────
  let currentRegime: 'trending' | 'ranging' | undefined = undefined;
  if (triggerKlines && triggerKlines.length >= 28) {
    const adxSeries = calculateADXSeries(triggerKlines, 14);
    if (adxSeries.adx.length > 0) {
      const regimeSeries = calculateRegimeSeriesWithHysteresis(adxSeries.adx, 26.0, 22.0);
      currentRegime = regimeSeries[regimeSeries.length - 1];
    }
  }

  const tournament = evaluateStrategyTournament(candidates, evalInterval, currentRegime, isCrypto);
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
    currentRegime,
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
    btMFLS,
    symbol,
    isCrypto: isCryptoAsset(symbol),
  };
}

/**
 * Chooses the best strategy that is actionable on the current closed candle.
 *
 * The tournament remains the primary selector. When its winner is currently
 * NEUTRAL, a secondary candidate may emit a LIMITED alert only when it keeps
 * positive In-Sample edge and has no negative Out-of-Sample evidence. A
 * marginal WF failure (positive OOS edge below the +0.10R HIGH hurdle) is
 * therefore distinguished from a genuinely losing validation period.
 */
function normalizeSignal(value?: string): 'BUY' | 'SELL' | 'NEUTRAL' {
  if (!value) return 'NEUTRAL';
  if (value.includes('BUY')) return 'BUY';
  if (value.includes('SELL')) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Returns all strategies that have an active, validated trade signal on the current closed candle,
 * sorted in strict priority order:
 * 1. Primary tournament winner (if it emits an actionable signal and passes OOS directional edge)
 * 2. Secondary fallback candidates with positive In-Sample edge and non-toxic Out-of-Sample evidence,
 *    sorted by their edge/sample/OOS/drawdown score descending.
 */
export function getActionableStrategyCandidates(
  qve: QVESelectionResult,
  signals: StrategySignalMap
): ActionableStrategySelection[] {
  const assetIsCrypto = qve.isCrypto !== undefined ? qve.isCrypto : isCryptoAsset(qve.symbol);
  if (qve.targetInterval === '5m' && !assetIsCrypto) {
    return getEquity5mActionableCandidates(qve, signals);
  }

  const candidates: ActionableStrategySelection[] = [];

  const primary = qve.candidates.find(candidate => candidate.key === qve.bestStrategy);
  if (primary) {
    const isPrimarySniper = primary.key === 'multitemporal' || primary.key === 'multifractal' || primary.key === 'mfls';
    const primaryMinSample = (qve.targetInterval === '1d' || isPrimarySniper) ? 2 : 3;
    const rawPrimarySignal = normalizeSignal(signals[primary.key]);
    let primarySignal = sanitizeSignalWithDirectionalEdge(
      rawPrimarySignal,
      qve.tournament.longStats,
      qve.tournament.shortStats,
      primaryMinSample
    );

    // Symmetric Directional OOS Validation:
    let primaryConfidence = qve.confidence;
    let primaryReasoning = qve.tournament.reasoning;
    if (primarySignal !== 'NEUTRAL') {
      const oosCheck = hasNegativeDirectionalOosEdge(primarySignal, primary.walkForward, primaryMinSample);
      if (oosCheck.isToxic && oosCheck.oosDir) {
        primarySignal = 'NEUTRAL';
      } else if (oosCheck.isMarginal && oosCheck.oosDir) {
        primaryConfidence = 'LIMITED';
        primaryReasoning = `${primary.label} (${primarySignal}) en LIMITED por OOS reciente marginal (${oosCheck.oosDir.signals} trades, E[R] ${oosCheck.oosDir.expectancyR.toFixed(2)}R, PF ${oosCheck.oosDir.profitFactor?.toFixed(2) ?? 'N/D'})`;
      }
    }

    if (primarySignal !== 'NEUTRAL') {
      candidates.push({
        strategy: primary.key,
        strategyLabel: primary.label,
        signal: primarySignal,
        confidence: primaryConfidence,
        profitFactor: qve.profitFactor,
        winRate: primary.winRate,
        longStats: qve.tournament.longStats,
        shortStats: qve.tournament.shortStats,
        isFallback: false,
        reasoning: primaryReasoning,
      });
    }
  }

  const fallbacks = qve.candidates.flatMap(candidate => {
    if (candidate.key === qve.bestStrategy) return [];

    const rawSignal = normalizeSignal(signals[candidate.key]);
    if (rawSignal === 'NEUTRAL') return [];

    const isSniper = candidate.key === 'multitemporal' || candidate.key === 'multifractal' || candidate.key === 'mfls';
    const minSample = (qve.targetInterval === '1d' || isSniper) ? 2 : 3;
    const minHighSample = isSniper
      ? (qve.targetInterval === '5m' ? 4 : 3)
      : (qve.targetInterval === '5m' ? 8 : 5);

    const wf = candidate.walkForward;
    const stats = wf?.inSample;
    const maxDrawdownR = stats?.maxDrawdownR ?? candidate.maxDrawdownR ?? 0;
    const longStats = stats?.longStats ?? candidate.longStats;
    const shortStats = stats?.shortStats ?? candidate.shortStats;
    const directionalStats = rawSignal === 'BUY' ? longStats : shortStats;

    const globalSample = stats?.signals ?? candidate.resolved;
    const globalExpR = stats?.expectancyR ?? candidate.expectancyR ?? 0;
    const globalPf = stats?.profitFactor ?? candidate.profitFactor;

    // 1. Regime check:
    const currentRegimeStats = qve.currentRegime && stats?.regimeStats
      ? (qve.currentRegime === 'trending' ? stats.regimeStats.trending : stats.regimeStats.ranging)
      : undefined;
    if (currentRegimeStats && currentRegimeStats.signals >= 3) {
      const regimeShrink = currentRegimeStats.signals / (currentRegimeStats.signals + 4);
      if (currentRegimeStats.expectancyR * regimeShrink < -0.15) return [];
    }

    // In 5m equities day trading, Standard Voting is retired from active fallback alert generation
    // (retained as exploratory/informative only in UI) to eliminate -0.24R drag.
    const isCrypto = qve.isCrypto !== undefined ? qve.isCrypto : isCryptoAsset(qve.symbol);
    if (qve.targetInterval === '5m' && !isCrypto && candidate.key === 'standard') {
      return [];
    }

    // 2. Directional In-Sample Validation (symmetric with primary winner):
    const signal = sanitizeSignalWithDirectionalEdge(rawSignal, longStats, shortStats, minSample);
    if (signal === 'NEUTRAL') return [];

    const dirSample = directionalStats?.signals ?? 0;
    const hasDirectionalSample = dirSample >= minSample;
    const dirExpR = directionalStats?.expectancyR ?? 0;
    const dirPf = directionalStats?.profitFactor ?? null;

    // Reject decisively toxic directional edge (continuous empirical Bayes shrinkage):
    if (hasDirectionalSample && isDirectionalDecisivelyToxic(directionalStats, minSample, 4, -0.18)) {
      return [];
    }

    let effectiveExpR = 0;
    let sample = 0;
    let profitFactor = dirPf;
    let isMarginalDirectional = false;

    if (hasDirectionalSample) {
      if (dirExpR > 0 && (dirPf === null || !Number.isFinite(dirPf) || dirPf >= 1.0)) {
        // Clear positive directional edge:
        effectiveExpR = dirExpR;
        sample = dirSample;
        profitFactor = dirPf;
      } else if (globalExpR > 0 && globalSample >= minSample && (globalPf === null || !Number.isFinite(globalPf) || globalPf >= 1.0)) {
        // Marginal directional noise on small sample (-0.35R < dirExpR <= 0 on 3 <= N < 6)
        // Supported by a demonstrably profitable global in-sample prior:
        const kPrior = minSample;
        effectiveExpR = (dirSample / (dirSample + kPrior)) * dirExpR + (kPrior / (dirSample + kPrior)) * globalExpR;
        sample = dirSample;
        profitFactor = dirPf;
        isMarginalDirectional = true;
      } else {
        // Directional edge is not positive, and candidate lacks positive global prior
        return [];
      }
    } else {
      // No directional sample yet: evaluate on candidate's global in-sample edge
      if (globalSample < minSample || globalExpR <= 0) return [];
      if (globalPf !== null && Number.isFinite(globalPf) && globalPf < 1.0) return [];
      effectiveExpR = globalExpR;
      sample = globalSample;
      profitFactor = globalPf;
    }

    if (effectiveExpR <= 0 || sample < minSample) return [];

    const oosCheck = hasNegativeDirectionalOosEdge(rawSignal, wf, minSample);
    if (oosCheck.isToxic) return [];
    const oosDirectional = oosCheck.oosDir;
    const hasOosDirectionalSample = (oosDirectional?.signals ?? 0) >= minSample;

    const oosEval = calculateContinuousOosMultiplier(wf, hasOosDirectionalSample ? oosDirectional : undefined);
    const oosMultiplier = oosEval.multiplier;
    let validationNote = oosEval.note;

    if (wf?.status === 'FAIL') {
      const oos = (hasOosDirectionalSample && oosDirectional) ? oosDirectional : wf.outOfSample;
      const oosPfOk = oos.profitFactor === null || !Number.isFinite(oos.profitFactor) || oos.profitFactor >= 1.0;
      const foldsWithData = wf.folds?.filter(fold => fold.status !== 'NO_DATA') ?? [];
      const nonNegativeFolds = foldsWithData.filter(fold => fold.oosExpectancyR >= 0).length;
      const hasNonNegativeFolds = foldsWithData.length === 0 || nonNegativeFolds > 0;

      if (oos.expectancyR <= 0 || !oosPfOk || (!hasOosDirectionalSample && !hasNonNegativeFolds)) {
        return [];
      }
    }

    const sampleShrink = sample / (sample + minHighSample);
    const drawdownPenalty = Math.exp(-Math.max(0, maxDrawdownR - 2.5) / 3.0);
    const dirPenalty = isMarginalDirectional ? 0.75 : 1.0;
    const score = effectiveExpR * sampleShrink * oosMultiplier * drawdownPenalty * dirPenalty;
    if (score <= 0) return [];

    if (isMarginalDirectional && directionalStats) {
      validationNote += `; IS ${rawSignal} marginal (${directionalStats.expectancyR.toFixed(2)}R) encogido a +${effectiveExpR.toFixed(2)}R`;
    }

    return [{
      candidate,
      signal,
      score,
      profitFactor,
      longStats,
      shortStats,
      validationNote,
    }];
  }).sort((a, b) => b.score - a.score);

  for (const item of fallbacks) {
    candidates.push({
      strategy: item.candidate.key,
      strategyLabel: item.candidate.label,
      signal: item.signal,
      confidence: 'LIMITED',
      profitFactor: item.profitFactor,
      winRate: item.candidate.winRate,
      longStats: item.longStats,
      shortStats: item.shortStats,
      isFallback: true,
      reasoning: `${item.candidate.label} activa como alternativa LIMITED: ${item.validationNote}`,
    });
  }

  return candidates;
}

/**
 * 5m equities: Confluencia is the only actionable engine. Its edge is validated on the pooled watchlist
 * (per-symbol samples of ~25 trades per direction are noise, and the per-symbol veto did not improve
 * out-of-sample quality), so only a decisively toxic history on this symbol and direction
 * (>= 8 trades, shrunk E[R] <= -0.18R or PF < 0.40) blocks the alert.
 */
function getEquity5mActionableCandidates(
  qve: QVESelectionResult,
  signals: StrategySignalMap
): ActionableStrategySelection[] {
  const conf = qve.candidates.find(c => c.key === 'confluencia');
  const signal = normalizeSignal(signals.confluencia);
  if (!conf || signal === 'NEUTRAL') return [];

  const directionalStats = signal === 'BUY' ? conf.longStats : conf.shortStats;
  if (isDirectionalDecisivelyToxic(directionalStats, 8, 4, -0.18)) return [];

  const isWinner = qve.bestStrategy === 'confluencia';
  return [{
    strategy: 'confluencia',
    strategyLabel: conf.label,
    signal,
    confidence: isWinner && qve.confidence === 'HIGH' ? 'HIGH' : 'LIMITED',
    profitFactor: isWinner ? qve.profitFactor : conf.profitFactor,
    winRate: conf.winRate,
    longStats: conf.longStats,
    shortStats: conf.shortStats,
    isFallback: !isWinner,
    reasoning: isWinner
      ? qve.tournament.reasoning
      : `Confluencia (${signal}) en 5m (09:35–11:00 ET, ATR ≥ 0,5%): entrada técnica sin ventaja neta comprobada fuera de muestra; sin veto por historial individual del papel`,
  }];
}

/**
 * Informational engines with an active signal on the current closed candle (5m equities only),
 * labelled "(Informativa)" with confidence NONE so they are tracked as exploratory alerts and never
 * as PRIMARY ones. Raw signals are kept unfiltered so the trader can evaluate each engine as-is.
 */
export function getInformationalStrategyCandidates(
  qve: QVESelectionResult,
  signals: StrategySignalMap
): ActionableStrategySelection[] {
  const assetIsCrypto = qve.isCrypto !== undefined ? qve.isCrypto : isCryptoAsset(qve.symbol);
  return qve.candidates
    .filter(c => isInformationalStrategy(c.key, qve.targetInterval, assetIsCrypto))
    .map(c => ({ candidate: c, signal: normalizeSignal(signals[c.key]) }))
    .filter(item => item.signal !== 'NEUTRAL')
    .sort((a, b) => (b.candidate.expectancyR ?? 0) - (a.candidate.expectancyR ?? 0))
    .map(({ candidate, signal }) => ({
      strategy: candidate.key,
      strategyLabel: `${candidate.label} (Informativa)`,
      signal,
      confidence: 'NONE' as const,
      profitFactor: candidate.profitFactor,
      winRate: candidate.winRate,
      longStats: candidate.longStats,
      shortStats: candidate.shortStats,
      isFallback: true,
      reasoning: `${candidate.label} (${signal}) — señal informativa: sin ventaja neta validada en acciones 5m, no genera alertas principales`,
    }));
}

export interface TournamentLeader {
  strategyKey: StrategyCandidate['key'] | 'NONE';
  label: string;
  confidence: ConfidenceLevel;
  profitFactor: number | null;
  reasoning: string;
}

/**
 * Leader to display in MarketRadar and SignalPanel, consistent with what the scanner can alert.
 * On 5m equities Confluencia alerts on every symbol from pooled watchlist evidence, so it is the
 * leader even when the per-symbol tournament stays FLAT, unless its history on this symbol is
 * decisively toxic (then only the other direction, or none, can alert). Elsewhere the tournament
 * winner is shown as is.
 */
export function resolveTournamentLeader(qve: QVESelectionResult): TournamentLeader {
  const tournamentLeader: TournamentLeader = {
    strategyKey: qve.bestStrategy,
    label: qve.strategyLabel,
    confidence: qve.confidence,
    profitFactor: qve.profitFactor,
    reasoning: qve.tournament.reasoning,
  };
  const assetIsCrypto = qve.isCrypto !== undefined ? qve.isCrypto : isCryptoAsset(qve.symbol);
  const conf = qve.candidates.find(c => c.key === 'confluencia');
  if (qve.targetInterval !== '5m' || assetIsCrypto || !conf) return tournamentLeader;

  const buyVetoed = isDirectionalDecisivelyToxic(conf.longStats, 8, 4, -0.18);
  const sellVetoed = isDirectionalDecisivelyToxic(conf.shortStats, 8, 4, -0.18);
  const ownHistory = `Historial propio del papel: ${qve.tournament.reasoning}`;
  if (buyVetoed && sellVetoed) {
    return {
      strategyKey: 'NONE',
      label: 'Confluencia vetada',
      confidence: 'NONE',
      profitFactor: conf.profitFactor,
      reasoning: `Confluencia no alerta en este papel: historia claramente tóxica en compras y en ventas (≥ 8 operaciones). ${ownHistory}`,
    };
  }
  const isWinner = qve.bestStrategy === 'confluencia';
  const onlyDirection = buyVetoed ? 'SELL' : sellVetoed ? 'BUY' : null;
  return {
    strategyKey: 'confluencia',
    label: onlyDirection ? `Confluencia · solo ${onlyDirection}` : conf.label,
    confidence: isWinner && qve.confidence === 'HIGH' ? 'HIGH' : 'LIMITED',
    profitFactor: isWinner ? qve.profitFactor : conf.profitFactor,
    reasoning: `Confluencia en acciones 5m (09:35–11:00 ET, ATR ≥ 0,5%): entrada técnica sin ventaja neta comprobada fuera de muestra`
      + (onlyDirection ? `; ${onlyDirection === 'SELL' ? 'compras' : 'ventas'} vetadas por historia tóxica en este papel` : '')
      + `. ${ownHistory}`,
  };
}

/**
 * Canonical candidate queue shared by the live scanner (App), MarketRadar and SignalPanel, in strict
 * priority order: actionable candidates, then the Standard exploratory fallback (never on 5m equities),
 * then the informational engines (5m equities only).
 */
export function buildStrategyCandidateQueue(
  qve: QVESelectionResult,
  signals: StrategySignalMap
): ActionableStrategySelection[] {
  const queue = getActionableStrategyCandidates(qve, signals);
  if (!queue.some(c => c.strategy === 'standard')) {
    const fallback = resolveStandardExploratoryFallback(qve, signals.standard);
    if (fallback !== 'NEUTRAL') {
      queue.push({
        strategy: 'standard',
        strategyLabel: 'Estándar (Exploratoria)',
        signal: fallback,
        confidence: 'NONE',
        profitFactor: null,
        winRate: 0,
        isFallback: true,
        reasoning: 'Señal técnica activa vía Estándar (sin ventaja estadística demostrada)',
      });
    }
  }
  queue.push(...getInformationalStrategyCandidates(qve, signals));
  return queue;
}

export interface CandidatePlanResult<P> {
  candidate: ActionableStrategySelection;
  plan: P;
}

export interface CandidateCascadeResult<P> {
  viable: CandidatePlanResult<P> | null;          // First directional candidate with a valid operational plan
  firstRejected: CandidatePlanResult<P> | null;   // First directional candidate whose plan was rejected
  rejected: CandidatePlanResult<P>[];             // Rejected candidates evaluated before the viable one
}

/**
 * Walks the queue in priority order and stops at the first directional candidate whose operational
 * plan is valid (friction, geometry, room to S/R). Non-directional candidates are skipped.
 */
export function resolveCandidateCascade<P extends { valid: boolean }>(
  queue: ActionableStrategySelection[],
  planFor: (candidate: ActionableStrategySelection) => P
): CandidateCascadeResult<P> {
  const rejected: CandidatePlanResult<P>[] = [];
  for (const candidate of queue) {
    if (!candidate.signal.includes('BUY') && !candidate.signal.includes('SELL')) continue;
    const plan = planFor(candidate);
    if (plan.valid) return { viable: { candidate, plan }, firstRejected: rejected[0] ?? null, rejected };
    rejected.push({ candidate, plan });
  }
  return { viable: null, firstRejected: rejected[0] ?? null, rejected };
}

/**
 * Chooses the best strategy that is actionable on the current closed candle.
 * Returns the highest-priority candidate from getActionableStrategyCandidates,
 * or a NONE object if no candidate has an actionable signal with positive edge.
 */
export function selectActionableStrategy(
  qve: QVESelectionResult,
  signals: StrategySignalMap
): ActionableStrategySelection {
  const candidates = getActionableStrategyCandidates(qve, signals);
  if (candidates.length > 0) {
    return candidates[0];
  }

  const primary = qve.candidates.find(candidate => candidate.key === qve.bestStrategy);
  let reasoning = primary
    ? `${primary.label} es la ganadora del torneo, pero su señal actual es NEUTRAL y no hay alternativa validada activa`
    : qve.tournament.reasoning;

  if (primary) {
    const rawSignal = normalizeSignal(signals[primary.key]);
    if (rawSignal !== 'NEUTRAL') {
      const isPrimarySniper = primary.key === 'multitemporal' || primary.key === 'multifractal';
      const primaryMinSample = (qve.targetInterval === '1d' || isPrimarySniper) ? 2 : 3;
      const oosCheck = hasNegativeDirectionalOosEdge(rawSignal, primary.walkForward, primaryMinSample);
      if (oosCheck.isToxic && oosCheck.oosDir) {
        reasoning = `${primary.label} (${rawSignal}) neutralizada por OOS reciente negativo (${oosCheck.oosDir.signals} trades, E[R] ${oosCheck.oosDir.expectancyR.toFixed(2)}R, PF ${oosCheck.oosDir.profitFactor?.toFixed(2) ?? '0.00'}) y no hay alternativa validada activa`;
      }
    }
  }

  return {
    strategy: 'NONE',
    strategyLabel: 'Sin Estrategia Accionable',
    signal: 'NEUTRAL',
    confidence: 'NONE',
    profitFactor: null,
    winRate: 0,
    isFallback: false,
    reasoning,
  };
}

export interface DirectionalOosCheck {
  isNegative: boolean;
  isToxic: boolean;
  isMarginal: boolean;
  oosDir?: DirectionalStats;
}

/**
 * Evaluates whether a directional sample is decisively toxic using continuous empirical Bayes shrinkage.
 * Eliminates artificial step-function thresholds (e.g. -0.35R vs -0.15R) and the N=6 sawtooth jump,
 * accounting for real execution friction (0.11% round-trip) and small-sample variance.
 *
 * Formula:
 *   shrunkExpR = expectancyR * (N / (N + kShrink))  [where kShrink = 4]
 *
 * A sample is decisively toxic (hard veto) if:
 *   - shrunkExpR <= toxicThreshold (-0.20R), OR
 *   - profitFactor is severely collapsed (< 0.40)
 */
export function isDirectionalDecisivelyToxic(
  stats?: { signals: number; expectancyR: number; profitFactor?: number | null },
  minTrades: number = 3,
  kShrink: number = 4,
  toxicThreshold: number = -0.18
): boolean {
  if (!stats || stats.signals < minTrades) return false;
  const n = stats.signals;
  const shrink = n / (n + kShrink);
  const shrunkExpR = stats.expectancyR * shrink;
  const isSeverePf = stats.profitFactor !== undefined &&
    stats.profitFactor !== null &&
    Number.isFinite(stats.profitFactor) &&
    stats.profitFactor < 0.40;
  return shrunkExpR <= toxicThreshold || isSeverePf;
}

/**
 * Evaluates whether a directional signal has negative statistical edge in Out-of-Sample testing.
 * Differentiates between decisive toxicity (shrunk E[R] <= -0.20R or PF < 0.40) which hard-vetoes the signal,
 * and marginal negative noise (shrunk E[R] > -0.20R) which degrades confidence to LIMITED.
 */
export function hasNegativeDirectionalOosEdge(
  rawSignal: 'BUY' | 'SELL' | 'NEUTRAL',
  wf?: StrategyCandidate['walkForward'],
  minSample: number = 3
): DirectionalOosCheck {
  if (rawSignal === 'NEUTRAL' || !wf) return { isNegative: false, isToxic: false, isMarginal: false };
  const oosDir = rawSignal === 'BUY'
    ? wf.outOfSample.longStats
    : wf.outOfSample.shortStats;
  const sample = oosDir?.signals ?? 0;
  if (sample < minSample || !oosDir) return { isNegative: false, isToxic: false, isMarginal: false, oosDir };

  const expR = oosDir.expectancyR;
  const pf = oosDir.profitFactor;
  const pfOk = pf === null || !Number.isFinite(pf) || pf >= 1.0;
  const isNegative = expR <= 0 || !pfOk;

  if (!isNegative) {
    return { isNegative: false, isToxic: false, isMarginal: false, oosDir };
  }

  // Decisive toxicity evaluated via continuous empirical Bayes shrinkage (k=4, threshold=-0.18R, PF < 0.40).
  // Marginal negative edge (shrunk E[R] > -0.18R) degrades confidence to LIMITED rather than hard veto.
  const isToxic = isDirectionalDecisivelyToxic(oosDir, minSample, 4, -0.18);
  const isMarginal = !isToxic;

  return { isNegative, isToxic, isMarginal, oosDir };
}

/**
 * Validates whether a generated BUY/SELL signal possesses a viable historical directional expectancy.
 * Neutralizes signals if the strategy has decisively negative expectancy in that direction
 * using continuous empirical Bayes shrinkage (shrunk E[R] <= -0.20R or PF < 0.40).
 * Marginal negative noise (shrunk E[R] > -0.20R) is preserved to allow confidence downgrade to LIMITED.
 */
export function sanitizeSignalWithDirectionalEdge(
  rawSignal: string,
  longStats?: { signals: number; expectancyR: number; profitFactor?: number | null },
  shortStats?: { signals: number; expectancyR: number; profitFactor?: number | null },
  minTrades: number = 3
): 'BUY' | 'SELL' | 'NEUTRAL' {
  if (!rawSignal || rawSignal === 'NEUTRAL') return 'NEUTRAL';
  const isBuy = rawSignal.includes('BUY');
  const isSell = rawSignal.includes('SELL');

  if (isBuy && isDirectionalDecisivelyToxic(longStats, minTrades, 4, -0.18)) {
    return 'NEUTRAL';
  }
  if (isSell && isDirectionalDecisivelyToxic(shortStats, minTrades, 4, -0.18)) {
    return 'NEUTRAL';
  }
  return isBuy ? 'BUY' : isSell ? 'SELL' : 'NEUTRAL';
}

/**
 * Resolves the Standard Voting exploratory fallback signal, ensuring it does not
 * contradict its own directional backtest history (e.g. negative expectancy with >= 3 trades).
 */
export function resolveStandardExploratoryFallback(
  qve?: QVESelectionResult | null,
  rawStdSignal?: string
): 'BUY' | 'SELL' | 'NEUTRAL' {
  if (!rawStdSignal || rawStdSignal === 'NEUTRAL' || !qve) return 'NEUTRAL';
  // In 5m equities day trading, Standard Voting is retired from active exploratory fallback
  // due to persistent negative net edge (-0.24R), preserving capital for validated engines.
  const isCrypto = qve.isCrypto !== undefined ? qve.isCrypto : isCryptoAsset(qve.symbol);
  if (qve.targetInterval === '5m' && !isCrypto) {
    return 'NEUTRAL';
  }
  const stdCandidate = qve.candidates?.find(c => c.key === 'standard');
  const longStats = stdCandidate?.longStats ?? qve.btStd?.longStats;
  const shortStats = stdCandidate?.shortStats ?? qve.btStd?.shortStats;
  return sanitizeSignalWithDirectionalEdge(rawStdSignal, longStats, shortStats, 3);
}
