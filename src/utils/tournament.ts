export type ConfidenceLevel = 'HIGH' | 'LIMITED' | 'NONE';

export interface StrategyCandidate {
  key: 'standard' | 'confluencia' | 'scoring' | 'multitemporal' | 'multifractal';
  label: string;
  profitFactor: number;
  expectancy: number;
  winRate: number;
  resolved: number;
  forwardWindow?: number;
}

export interface TournamentResult {
  bestStrategy: StrategyCandidate['key'] | 'NONE';
  strategyLabel: string;
  confidence: ConfidenceLevel;
  compositeScore: number;
  profitFactor: number;
  reasoning: string;
}

/**
 * Evaluates candidates using a balanced progressive confidence model:
 * - Requires minimum resolved trades per timeframe for HIGH confidence
 * - Applies a sigmoid penalty curve based on sample size
 * - Normalizes Expectancy by Time Horizon (Square-root of time volatility scaling: base window = 6 candles)
 * - Applies Bayesian sample-aware capping on Profit Factor to prevent single-trade singularities (PF 99.9 -> 5.0)
 * - Computes a composite score: (cappedPF * 0.45 + normalizedExpScore * 0.35 + winRate * 0.20) * sampleConfidence
 * - Falls back to LIMITED confidence if minimum sample isn't met but PF >= 0.95
 * - Yields the best relative strategy even when confidence is NONE so intraday signals aren't silenced
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
      profitFactor: 0,
      reasoning: 'Sin candidatos para evaluar',
    };
  }

  // Target minimum resolved trades for HIGH confidence
  const minHighResolved = timeframe === '5m' ? 12 : timeframe === '1h' ? 6 : 4;
  const idealMin = Math.round(minHighResolved * 1.5);

  // Helper to calculate composite score with sample-aware PF and horizon-normalized expectancy
  const calcScore = (c: StrategyCandidate): number => {
    // Sigmoid sample confidence based on total evaluated trades
    const sampleConfidence = 1 / (1 + Math.exp(-(c.resolved - idealMin) / 2.5));
    
    // Bayesian sample-aware PF ceiling: a sample of N trades cannot claim infinity / 5.0 PF
    const maxAttainablePF = Math.min(5.0, 1.0 + Math.max(0, c.resolved) * 0.5);
    // If PF was 99.9 (zero losses) or excessively high on small N, regularize with Laplace prior
    const rawPF = c.profitFactor >= 99.0 ? (c.expectancy > 0 ? (1.0 + Math.min(c.expectancy, 4.0)) : 1.0) : c.profitFactor;
    const cappedPF = Math.min(Math.max(0, rawPF), maxAttainablePF);

    // Horizon-normalized expectancy (Square-root of time volatility scaling: base window = 6 candles)
    const horizon = c.forwardWindow && c.forwardWindow > 0 ? c.forwardWindow : (
      c.key === 'multitemporal' ? (timeframe === '1h' ? 48 : 72) :
      c.key === 'multifractal' ? 12 : 6
    );
    const timeScalingFactor = Math.sqrt(horizon / 6);
    const normalizedExpectancy = c.expectancy / timeScalingFactor;

    // Smooth bounded mapping for normalized expectancy: maps [0, +inf) to [0, 3.0]
    const normalizedExpScore = Math.max(0, Math.tanh(Math.max(0, normalizedExpectancy) / 0.75)) * 3.0;

    const baseScore = (cappedPF * 0.45) + (normalizedExpScore * 0.35) + (c.winRate * 0.20);
    return baseScore * sampleConfidence;
  };

  // 1. Check for HIGH confidence candidates (meets minHighResolved and PF >= 1.15)
  const highCandidates = candidates
    .filter(c => c.resolved >= minHighResolved && c.profitFactor >= 1.15)
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .sort((a, b) => b.score - a.score);

  if (highCandidates.length > 0) {
    const winner = highCandidates[0].candidate;
    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence: 'HIGH',
      compositeScore: highCandidates[0].score,
      profitFactor: winner.profitFactor,
      reasoning: `${winner.label} (PF ${winner.profitFactor.toFixed(2)}, ${winner.resolved} trades)`,
    };
  }

  // 2. Check for LIMITED confidence candidates (meets at least 1 resolved trade and PF >= 0.95, requiring 1.15 if resolved === 1)
  const limitedCandidates = candidates
    .filter(c => c.resolved >= 1 && c.profitFactor >= (c.resolved === 1 ? 1.15 : 0.95))
    .map(c => ({ candidate: c, score: calcScore(c) }))
    .sort((a, b) => b.score - a.score);

  if (limitedCandidates.length > 0) {
    const winner = limitedCandidates[0].candidate;
    return {
      bestStrategy: winner.key,
      strategyLabel: winner.label,
      confidence: 'LIMITED',
      compositeScore: limitedCandidates[0].score,
      profitFactor: winner.profitFactor,
      reasoning: `${winner.label} — Muestra limitada (${winner.resolved}/${minHighResolved} trades, PF ${winner.profitFactor.toFixed(2)})`,
    };
  }

  // 3. Fallback: Select best relative strategy using calcScore so signals are not silently swallowed
  const sortedAll = [...candidates].sort((a, b) => {
    const scoreA = calcScore(a);
    const scoreB = calcScore(b);
    return scoreB - scoreA;
  });
  const fallback = sortedAll[0] || candidates[0];

  return {
    bestStrategy: fallback.key,
    strategyLabel: fallback.label,
    confidence: 'NONE',
    compositeScore: 0,
    profitFactor: fallback.profitFactor,
    reasoning: `${fallback.label} (PF ${fallback.profitFactor.toFixed(2)})`,
  };
}
