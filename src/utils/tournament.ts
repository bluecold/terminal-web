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
 * Evaluates candidates using a progressive confidence model:
 * - Requires a minimum number of resolved trades per timeframe for HIGH confidence
 * - Applies a sigmoid penalty curve based on sample size
 * - Computes a composite score: (PF * 0.45 + Expectancy * 0.35 + WinRate * 0.20) * sampleConfidence
 * - Falls back to LIMITED confidence if minimum sample isn't met but PF >= 1.0
 * - Yields NONE only when no strategy is profitable (PF >= 1.0 with >= 3 trades)
 */
export function evaluateStrategyTournament(
  candidates: StrategyCandidate[],
  timeframe: string
): TournamentResult {
  if (candidates.length === 0) {
    return {
      bestStrategy: 'NONE',
      strategyLabel: 'Sin Estrategia',
      confidence: 'NONE',
      compositeScore: 0,
      profitFactor: 0,
      reasoning: 'Sin candidatos para evaluar',
    };
  }

  // Target minimum resolved trades for HIGH confidence
  const minHighResolved = timeframe === '5m' ? 8 : timeframe === '1h' ? 5 : 4;
  const idealMin = Math.round(minHighResolved * 1.5);

  // Helper to calculate composite score with sigmoid sample penalty
  const calcScore = (c: StrategyCandidate): number => {
    // Sigmoid curve centered at idealMin
    const sampleConfidence = 1 / (1 + Math.exp(-(c.resolved - idealMin) / 2.5));
    // Base performance score
    const baseScore = c.profitFactor * 0.45 + Math.max(0, c.expectancy) * 0.35 + c.winRate * 0.20;
    return baseScore * sampleConfidence;
  };

  // 1. Check for HIGH confidence candidates (meets minHighResolved and PF >= 1.25)
  const highCandidates = candidates
    .filter(c => c.resolved >= minHighResolved && c.profitFactor >= 1.25)
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

  // 2. Check for LIMITED confidence candidates (meets at least 3 resolved trades and PF >= 1.0)
  const limitedCandidates = candidates
    .filter(c => c.resolved >= 3 && c.profitFactor >= 1.0)
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

  // 3. Fallback: If no candidate has PF >= 1.0 with >= 3 trades, market has no statistical edge
  // Sort all candidates by PF to know the best among negative ones for logging
  const sortedAll = [...candidates].sort((a, b) => b.profitFactor - a.profitFactor);
  const bestNeg = sortedAll[0];

  return {
    bestStrategy: 'NONE',
    strategyLabel: 'Sin Ventaja',
    confidence: 'NONE',
    compositeScore: 0,
    profitFactor: bestNeg ? bestNeg.profitFactor : 0,
    reasoning: `Sin ventaja estadística en ${timeframe.toUpperCase()} (Mejor PF: ${bestNeg ? bestNeg.profitFactor.toFixed(2) : '0.00'})`,
  };
}
