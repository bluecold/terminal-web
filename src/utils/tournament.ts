export type ConfidenceLevel = 'HIGH' | 'LIMITED' | 'NONE';

export interface StrategyCandidate {
  key: 'standard' | 'confluencia' | 'scoring' | 'multitemporal' | 'multifractal';
  label: string;
  profitFactor: number;
  expectancy: number;
  winRate: number;
  resolved: number;
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
 * - Computes a composite score: (PF * 0.45 + Expectancy * 0.35 + WinRate * 0.20) * sampleConfidence
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

  // Helper to calculate composite score with sigmoid sample penalty
  const calcScore = (c: StrategyCandidate): number => {
    const sampleConfidence = 1 / (1 + Math.exp(-(c.resolved - idealMin) / 2.5));
    const cappedPF = Math.min(c.profitFactor, 5.0);
    const baseScore = cappedPF * 0.45 + Math.max(0, c.expectancy) * 0.35 + c.winRate * 0.20;
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

  // 3. Fallback: Select best relative strategy so signals are not silently swallowed
  const sortedAll = [...candidates].sort((a, b) => {
    const scoreA = (a.profitFactor * 0.5) + (a.winRate * 0.5);
    const scoreB = (b.profitFactor * 0.5) + (b.winRate * 0.5);
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
