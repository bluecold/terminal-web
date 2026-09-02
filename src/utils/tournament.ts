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
import { getConfirmedClosedKlines, calculateADXSeries, calculateRegimeSeriesWithHysteresis, type ScoringWeights } from './indicators';

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
  currentRegime?: 'trending' | 'ranging';
  reasoning: string;
}

/**
 * Evaluates candidates using an R-multiple, capital exposure, downside risk and Walk-Forward validated model:
 * - Normalizes performance by R per trade (E[R]) and velocity (R per hour of exposure)
 * - Penalizes excessive drawdowns (MDD > 2.5R) and boosts high Sortino ratio systems
 * - Enforces Walk-Forward validation: requires In-Sample (70%) and Out-of-Sample (30%) consistency (WF != FAIL for HIGH confidence)
 * - Treats zero-loss samples (PF = null / undefined / 99.9) as undefined (PF N/D), preventing single-trade singularities
 * - Regularizes sample size via monotonic Bayesian Shrinkage
 * - Conditions strategy selection and scoring on current market regime with hysteresis (trending ADX >= 26 vs ranging ADX <= 22)
 */
export function evaluateStrategyTournament(
  candidates: StrategyCandidate[],
  timeframe: string,
  currentRegime?: 'trending' | 'ranging'
): TournamentResult {
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

  // Target minimum In-Sample resolved trades for HIGH and LIMITED confidence
  const minHighResolved = timeframe === '5m' ? 8 : timeframe === '1h' ? 5 : 3;
  const minLimitedResolved = timeframe === '5m' ? 3 : timeframe === '1h' ? 3 : 2;

  // Helper to extract duration and normalized R metrics for ranking (using In-Sample if available)
  const getMetrics = (c: StrategyCandidate, useInSample: boolean = false) => {
    const hasIS = useInSample && Boolean(c.walkForward && c.walkForward.inSample);
    const is = hasIS ? c.walkForward!.inSample : undefined;

    const expR = is ? is.expectancyR : (c.expectancyR ?? 0);
    const resolved = is ? (is.wins + is.losses) : c.resolved;
    const profitFactor = is ? is.profitFactor : c.profitFactor;
    const winRate = is ? is.winRate : c.winRate;
    const maxDrawdownR = is ? is.maxDrawdownR : (c.maxDrawdownR ?? 0);
    const sortinoRatio = is && is.sortinoRatio !== undefined ? is.sortinoRatio : (c.sortinoRatio ?? null);
    const regimeStats = is && is.regimeStats !== undefined ? is.regimeStats : c.regimeStats;
    const longStats = is && is.longStats !== undefined ? is.longStats : c.longStats;
    const shortStats = is && is.shortStats !== undefined ? is.shortStats : c.shortStats;

    const candleHours = timeframe === '5m' ? (5 / 60) : timeframe === '1h' ? 1.0 : 24.0;
    const baseCandles = 6;
    const baseHours = baseCandles * candleHours; // 0.5h on 5m, 6h on 1h, 6d on 1d

    let exposureHours = is?.avgExposureHours ?? c.avgExposureHours;
    if (exposureHours === undefined || exposureHours <= 0) {
      const defaultCandles = c.forwardWindow && c.forwardWindow > 0 ? c.forwardWindow : (
        c.key === 'multitemporal' ? (timeframe === '1h' ? 48 : 72) :
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
  const activeCandidatesCount = candidates.filter(c => getMetrics(c, true).resolved >= minLimitedResolved).length;
  const multiplicityFactor = 1 / Math.sqrt(1 + 0.10 * Math.max(0, activeCandidatesCount - 1));

  // Helper to compute Bayesian-shrunk time-normalized score strictly from In-Sample data
  const calcScore = (candidate: StrategyCandidate): number => {
    const { expR, resolved, timeFactor, maxDrawdownR, sortinoRatio, regimeStats } = getMetrics(candidate, true);

    // 1. Empirical Bayesian Shrinkage towards null prior (E[R] = 0):
    // Prior uncertainty factor N0: skeptical market baseline requiring sample proof
    // Shrunk E[R] scales monotonically and smoothly with sample size N without artificial step functions
    const n0 = timeframe === '5m' ? 8 : timeframe === '1h' ? 5 : 3;
    const shrinkage = resolved / (resolved + n0);
    const shrunkExpR = Math.max(0, expR) * shrinkage;

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

    return timeNormScore * ddPenalty * sortinoMultiplier * regimeMultiplier * multiplicityFactor;
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
      const pfOk = isMetrics.profitFactor === null || !Number.isFinite(isMetrics.profitFactor) || isMetrics.profitFactor >= 99.0
        ? true
        : isMetrics.profitFactor >= 1.25;
      const wfOk = !c.walkForward || c.walkForward.status === 'PASS';
      const regimeOk = !isRegimeDecisivelyToxic(isMetrics.regimeStats);

      return isMetrics.resolved >= minHighResolved && pfOk && isMetrics.expR > 0 && wfOk && regimeOk;
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
    // Evaluated on deflated quality expectancy (R per trade, independent of duration / timeFactor)
    // so that fast scalps (e.g. Standard, 1.5h) and longer setups (e.g. VCME Sniper, 7h) face
    // an identical, uniform certification standard of statistical edge.
    const deflatedQualityExpR = winnerScore * isMetrics.timeFactor;
    const minHighDeflatedHurdle = 0.040; // +0.04R quality edge per trade
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
    // If multi-fold diagnostics exist, candidate must validate on at least 2 progressive folds (foldsPassed >= 2).
    let passesFoldsGate = true;
    if (winner.walkForward?.folds && winner.walkForward.folds.length > 0) {
      const foldsPassed = winner.walkForward.foldsPassed ?? 0;
      if (foldsPassed < 2) {
        passesFoldsGate = false;
        multiplicityNote += ` · Folds Walk-Forward insuficientes (${foldsPassed}/${winner.walkForward.folds.length} aprobados, mín 2 req) → Degradado a LIMITED`;
      }
    }

    const confidence: 'HIGH' | 'LIMITED' = (passesAbsoluteHurdle && passesSeparationMargin && passesFoldsGate) ? 'HIGH' : 'LIMITED';

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
      if (isMetrics.resolved < minLimitedResolved) return false;
      if (isMetrics.expR <= 0) return false;
      if (c.walkForward && c.walkForward.status === 'FAIL') return false;

      if (isRegimeDecisivelyToxic(isMetrics.regimeStats)) {
        return false;
      }

      if (isMetrics.profitFactor === null || !Number.isFinite(isMetrics.profitFactor) || isMetrics.profitFactor >= 99.0) {
        return true;
      }
      return isMetrics.profitFactor >= 1.0;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (limitedCandidates.length > 0) {
    const winner = limitedCandidates[0].candidate;
    const isMetrics = getMetrics(winner, true);
    const pfStr = isMetrics.profitFactor !== null && Number.isFinite(isMetrics.profitFactor) && isMetrics.profitFactor < 99.0
      ? `PF ${isMetrics.profitFactor.toFixed(2)}`
      : 'PF N/D';
    const wfOosNote = winner.walkForward?.status === 'INSUFFICIENT_OOS' && isMetrics.resolved >= minHighResolved
      ? ` · Muestra OOS reducida (${winner.walkForward.outOfSample.signals} trades)`
      : winner.walkForward?.status === 'NO_OOS_TRADES' && isMetrics.resolved >= minHighResolved
      ? ' · Sin trades en OOS'
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
      profitFactor: isMetrics.profitFactor,
      expectancyR: Number(isMetrics.expR.toFixed(3)),
      expectancyPerHour: Number(isMetrics.expPerHour.toFixed(3)),
      maxDrawdownR: isMDD,
      sortinoRatio: isSortino,
      walkForward: winner.walkForward,
      longStats: winner.walkForward?.inSample?.longStats ?? winner.longStats,
      shortStats: winner.walkForward?.inSample?.shortStats ?? winner.shortStats,
      currentRegime,
      reasoning: `${winner.label} — Muestra limitada (${isMetrics.resolved}/${minHighResolved} trades IS, E[R] ${isMetrics.expR > 0 ? '+' : ''}${isMetrics.expR.toFixed(2)}R, ${pfStr}${wfOosNote}${regimeInfo})`,
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
    currentRegime,
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

  // ── Detect current market regime on confirmed trigger candles (with Hysteresis) ────
  let currentRegime: 'trending' | 'ranging' | undefined = undefined;
  if (triggerKlines && triggerKlines.length >= 28) {
    const adxSeries = calculateADXSeries(triggerKlines, 14);
    if (adxSeries.adx.length > 0) {
      const regimeSeries = calculateRegimeSeriesWithHysteresis(adxSeries.adx, 26.0, 22.0);
      currentRegime = regimeSeries[regimeSeries.length - 1];
    }
  }

  const tournament = evaluateStrategyTournament(candidates, evalInterval, currentRegime);
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

