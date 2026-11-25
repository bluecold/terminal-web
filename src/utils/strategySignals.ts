/**
 * Live single-bar signal wrappers for the six engines, plus the MTF context caches.
 * Kept apart from indicators.ts so the dependency is one-way:
 * indicators (math, calendar) ← strategyEvaluators (build*Context / evaluate*At) ← strategySignals.
 */
import type { Kline } from '../services/api';
import { getKlinesFingerprint } from './klineFingerprint';
import {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  type ScoringResult,
  type StandardVotingResult,
  type VCMESniperResult,
  type MultifractalMTFSignalResult,
} from './indicators';
import {
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
  evaluateMFLSAt,
  type ConfluenciaEvaluationResult,
  type VCMESniperContext,
  type MultifractalMTFContext,
  type MFLSEvaluationResult,
} from './strategyEvaluators';

export function calculateExperimentalSignal(
  klines: Kline[],
  interval: string = '1h',
  symbolOrIsCrypto?: string | boolean
): ConfluenciaEvaluationResult {
  const ctx = buildConfluenciaContext(klines, interval, symbolOrIsCrypto);
  return evaluateConfluenciaAt(ctx, klines ? klines.length - 1 : 0);
}

export function calculateScoringSignal(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  effectivePriceOrSymbol?: number | string | boolean,
  symbolOrIsCryptoParam?: string | boolean
): ScoringResult {
  let effectivePrice: number | undefined;
  let symbolOrIsCrypto: string | boolean | undefined;

  if (typeof effectivePriceOrSymbol === 'number') {
    effectivePrice = effectivePriceOrSymbol;
    symbolOrIsCrypto = symbolOrIsCryptoParam;
  } else {
    symbolOrIsCrypto = effectivePriceOrSymbol;
  }

  const ctx = buildScoringContext(klines, interval, weights, symbolOrIsCrypto);
  return evaluateScoringAt(ctx, klines ? klines.length - 1 : 0, effectivePrice);
}

export function calculateStandardVoting(klines: Kline[]): StandardVotingResult {
  const ctx = buildStandardVotingContext(klines);
  return evaluateStandardVotingAt(ctx, klines ? klines.length - 1 : 0);
}

// ─── LRU Cache for MTF Contexts (VCME & Multifractal) ──────────────────────
interface CachedContextEntry<T> {
  fingerprint: string;
  context: T;
}

const MAX_MTF_CONTEXT_CACHE_SIZE = 100;
const vcmeContextCache = new Map<string, CachedContextEntry<VCMESniperContext>>();
const multifractalContextCache = new Map<string, CachedContextEntry<MultifractalMTFContext>>();

export function clearMTFContextCache(): void {
  vcmeContextCache.clear();
  multifractalContextCache.clear();
}

export function getCachedVCMESniperContext(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo'
): VCMESniperContext {
  const cacheKey = `${symbol ?? 'DEFAULT'}_${style}_${triggerMode}`;
  const fp = getKlinesFingerprint([klines5m, klines1h, klines1d]);
  const cached = vcmeContextCache.get(cacheKey);

  if (cached && cached.fingerprint === fp) {
    // LRU touch
    vcmeContextCache.delete(cacheKey);
    vcmeContextCache.set(cacheKey, cached);
    return cached.context;
  }

  const context = buildVCMESniperContext(klines5m, klines1h, klines1d, symbol, style, triggerMode);

  if (vcmeContextCache.has(cacheKey)) {
    vcmeContextCache.delete(cacheKey);
  } else if (vcmeContextCache.size >= MAX_MTF_CONTEXT_CACHE_SIZE) {
    const oldestKey = vcmeContextCache.keys().next().value;
    if (oldestKey) vcmeContextCache.delete(oldestKey);
  }
  vcmeContextCache.set(cacheKey, { fingerprint: fp, context });
  return context;
}

export function getCachedMultifractalMTFContext(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  _symbol: string = 'ASSET'
): MultifractalMTFContext {
  const cacheKey = _symbol || 'ASSET';
  const fp = getKlinesFingerprint([klines5m, klines1h, klines1d]);
  const cached = multifractalContextCache.get(cacheKey);

  if (cached && cached.fingerprint === fp) {
    // LRU touch
    multifractalContextCache.delete(cacheKey);
    multifractalContextCache.set(cacheKey, cached);
    return cached.context;
  }

  const context = buildMultifractalMTFContext(klines5m, klines1h, klines1d, _symbol);

  if (multifractalContextCache.has(cacheKey)) {
    multifractalContextCache.delete(cacheKey);
  } else if (multifractalContextCache.size >= MAX_MTF_CONTEXT_CACHE_SIZE) {
    const oldestKey = multifractalContextCache.keys().next().value;
    if (oldestKey) multifractalContextCache.delete(oldestKey);
  }
  multifractalContextCache.set(cacheKey, { fingerprint: fp, context });
  return context;
}

export function calculateVCMESniperSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  _recentWinRate?: number,
  _recentProfitFactor?: number | null,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo',
  executionPrice?: number
): VCMESniperResult {
  const ctx = getCachedVCMESniperContext(klines5m, klines1h, klines1d, symbol, style, triggerMode);
  return evaluateVCMESniperAt(ctx, klines5m ? klines5m.length - 1 : 0, executionPrice);
}

export function calculateMultifractalMTFSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  _symbol: string = 'ASSET',
  executionPrice?: number
): MultifractalMTFSignalResult {
  const ctx = getCachedMultifractalMTFContext(klines5m, klines1h, klines1d, _symbol);
  return evaluateMultifractalMTFAt(ctx, klines5m ? klines5m.length - 1 : 0, executionPrice);
}

export function calculateMFLSSignal(
  klines5m: Kline[],
  symbolOrIsCrypto: string | boolean = 'ASSET',
  executionPrice?: number
): MFLSEvaluationResult {
  const ctx = buildMFLSContext(klines5m, symbolOrIsCrypto);
  return evaluateMFLSAt(ctx, klines5m ? klines5m.length - 1 : 0, executionPrice);
}
