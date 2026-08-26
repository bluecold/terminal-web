import type { DirectionalStats, RegimeStats, WalkForwardResult } from './backtester';

export type ConfidenceLevel = 'HIGH' | 'LIMITED' | 'NONE';

export interface StrategyCandidate {
  key: 'standard' | 'confluencia' | 'scoring' | 'multitemporal' | 'multifractal';
  label: string;
  profitFactor: number | null;
  expectancy?: number;          // Expected % per trade (legacy compatibility)
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

  // Target minimum resolved trades for HIGH confidence
  const minHighResolved = timeframe === '5m' ? 12 : timeframe === '1h' ? 6 : 4;
  const idealMin = Math.round(minHighResolved * 1.5);

  // Helper to extract duration and normalized R metrics
  const getMetrics = (c: StrategyCandidate) => {
    const expR = c.expectancyR !== undefined
      ? c.expectancyR
      : (c.expectancy !== undefined ? c.expectancy / 1.0 : 0);

    let exposureHours = c.avgExposureHours;
    if (exposureHours === undefined || exposureHours <= 0) {
      const defaultCandles = c.forwardWindow && c.forwardWindow > 0 ? c.forwardWindow : (
        c.key === 'multitemporal' ? (timeframe === '1h' ? 48 : 72) :
        c.key === 'multifractal' ? 12 : 6
      );
      const candleHours = timeframe === '5m' ? (5 / 60) : timeframe === '1h' ? 1.0 : 24.0;
      exposureHours = defaultCandles * candleHours;
    }

    const expPerHour = c.expectancyPerHour !== undefined
      ? c.expectancyPerHour
      : (exposureHours > 0 ? expR / exposureHours : expR);

    return { expR, exposureHours, expPerHour };
  };

  // Helper to calculate composite score normalized by R, velocity, downside risk and Walk-Forward
  const calcScore = (c: StrategyCandidate): number => {
    const { expR, expPerHour } = getMetrics(c);

    // Sigmoid sample confidence based on total evaluated trades
    const sampleConfidence = 1 / (1 + Math.exp(-(c.resolved - idealMin) / 2.5));

    // Bayesian sample-aware PF ceiling
    const maxAttainablePF = Math.min(5.0, 1.0 + Math.max(0, c.resolved) * 0.4);

    // Handle zero-loss undefined PF (null / >= 99.0)
    let rawPF: number;
    if (c.profitFactor === null || !Number.isFinite(c.profitFactor) || c.profitFactor >= 99.0) {
      if (c.resolved >= minHighResolved) {
        // Robust sample without losses (Laplace regularization)
        rawPF = Math.min(5.0, 1.0 + Math.max(0, expR) * 2.0);
      } else {
        // Small sample with 0 losses: treat as unproven / low prior
        rawPF = Math.min(1.5, 1.0 + Math.max(0, expR) * 0.3);
      }
    } else {
      rawPF = c.profitFactor;
    }
    const cappedPF = Math.min(Math.max(0, rawPF), maxAttainablePF);

    // Bounded score mappings
    const expRScore = Math.max(0, Math.tanh(Math.max(0, expR) / 0.5)) * 3.0;
    const velocityScore = Math.max(0, Math.tanh(Math.max(0, expPerHour) / 0.75)) * 2.5;
    const pfScore = Math.min(2.5, cappedPF * 0.5);
    const wrScore = c.winRate * 2.0;

    // Risk penalty for severe drawdown (> 3.0R)
    const mdd = c.maxDrawdownR ?? 0;
    const ddPenalty = Math.exp(-Math.max(0, mdd - 3.0) / 4.0);

    // Sortino quality adjustment (bonus for consistent positive downside, penalty for negative)
    let sortinoMultiplier = 1.0;
    if (c.sortinoRatio !== null && c.sortinoRatio !== undefined && c.sortinoRatio > 0) {
      sortinoMultiplier = 1.0 + Math.min(0.20, c.sortinoRatio * 0.05);
    } else if (c.sortinoRatio !== null && c.sortinoRatio !== undefined && c.sortinoRatio < 0) {
      sortinoMultiplier = Math.max(0.70, 1.0 + c.sortinoRatio * 0.10);
    }

    // Walk-Forward Out-of-Sample adjustment
    let wfMultiplier = 1.0;
    if (c.walkForward) {
      if (c.walkForward.status === 'PASS') {
        const oosExpR = c.walkForward.outOfSample.expectancyR;
        wfMultiplier = 1.0 + Math.min(0.15, Math.max(0, oosExpR) * 0.10);
      } else if (c.walkForward.status === 'FAIL') {
        wfMultiplier = 0.55; // Strict penalty for failing recent 30% validation
      } else if (c.walkForward.status === 'NO_OOS_TRADES') {
        wfMultiplier = 0.95; // Minor uncertainty penalty
      }
    }

    const baseScore = ((expRScore * 0.35) + (velocityScore * 0.25) + (pfScore * 0.25) + (wrScore * 0.15)) * ddPenalty * sortinoMultiplier * wfMultiplier;
    return baseScore * sampleConfidence;
  };

  // 1. Check for HIGH confidence candidates (meets minHighResolved, E[R] > 0, PF >= 1.15 or null with large N, AND WF != FAIL)
  const highCandidates = candidates
    .filter(c => {
      const { expR } = getMetrics(c);
      const pfOk = c.profitFactor === null ? c.resolved >= minHighResolved : c.profitFactor >= 1.15;
      const wfOk = !c.walkForward || c.walkForward.status !== 'FAIL';
      return c.resolved >= minHighResolved && pfOk && expR > 0 && wfOk;
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
      reasoning: `${winner.label} (E[R] ${expR > 0 ? '+' : ''}${expR.toFixed(2)}R, ${expPerHour.toFixed(2)}R/h, ${pfStr}${sortinoInfo}${riskInfo}${wfInfo}, ${winner.resolved} trades)`,
    };
  }

  // 2. Check for LIMITED confidence candidates (at least 1 resolved trade, expR > 0 or PF >= 0.95)
  const limitedCandidates = candidates
    .filter(c => {
      const { expR } = getMetrics(c);
      if (c.resolved < 1) return false;
      if (c.profitFactor === null || !Number.isFinite(c.profitFactor) || c.profitFactor >= 99.0) {
        return expR > 0;
      }
      return c.profitFactor >= (c.resolved === 1 ? 1.15 : 0.95) || expR > 0;
    })
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .sort((a, b) => b.score - a.score);

  if (limitedCandidates.length > 0) {
    const winner = limitedCandidates[0].candidate;
    const { expR, expPerHour } = getMetrics(winner);
    const pfStr = winner.profitFactor !== null && Number.isFinite(winner.profitFactor) && winner.profitFactor < 99.0
      ? `PF ${winner.profitFactor.toFixed(2)}`
      : 'PF N/D';
    const wfFailNote = winner.walkForward?.status === 'FAIL' ? ' · WF OOS falló' : '';

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
      reasoning: `${winner.label} — Muestra limitada (${winner.resolved}/${minHighResolved} trades, E[R] ${expR > 0 ? '+' : ''}${expR.toFixed(2)}R, ${pfStr}${wfFailNote})`,
    };
  }

  // 3. Fallback: Select best relative strategy using calcScore so signals are not silently swallowed
  const sortedAll = [...candidates].sort((a, b) => {
    const scoreA = calcScore(a);
    const scoreB = calcScore(b);
    return scoreB - scoreA;
  });
  const fallback = sortedAll[0] || candidates[0];
  const { expR, expPerHour } = getMetrics(fallback);
  const pfStr = fallback.profitFactor !== null && Number.isFinite(fallback.profitFactor) && fallback.profitFactor < 99.0
    ? `PF ${fallback.profitFactor.toFixed(2)}`
    : 'PF N/D';

  return {
    bestStrategy: fallback.key,
    strategyLabel: fallback.label,
    confidence: 'NONE',
    compositeScore: 0,
    profitFactor: fallback.profitFactor,
    expectancyR: Number(expR.toFixed(3)),
    expectancyPerHour: Number(expPerHour.toFixed(3)),
    maxDrawdownR: fallback.maxDrawdownR,
    sortinoRatio: fallback.sortinoRatio,
    walkForward: fallback.walkForward,
    reasoning: `${fallback.label} (${pfStr}, E[R] ${expR > 0 ? '+' : ''}${expR.toFixed(2)}R)`,
  };
}
