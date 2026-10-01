import type { Kline } from '../services/api';
import type { TradeLevels, TradeDirection } from './tradeSimulator';
import { calculateSupportResistance, isCryptoAsset } from './indicators';
import { formatSmartPrice } from './formatters';

export { isCryptoAsset };

/** Canonical ATR multiples, shared by backtesting, scanner and calculator. */
export function getStrategyAtrMultiplier(
  strategyKey: string = 'standard',
  interval: string = '5m',
  isCrypto: boolean = true
): number {
  const norm = strategyKey.toLowerCase();
  if (norm.includes('confluencia')) return 2.0;
  if (norm.includes('scoring')) return 1.5;
  if (interval.toLowerCase() === '1d') return 1.0;
  // For equities in intraday (5m) targeting 1-2h holding period, 2.5x ATR accommodates market noise
  if (!isCrypto && interval.toLowerCase() === '5m') return 2.5;
  return 1.2;
}

export interface CalculateAlertLevelsOptions {
  isCrypto?: boolean;
  /** Piso económico estructural en 5m contra comisiones de corretaje (default: 0.004 = 0.40%) */
  minStructuralFloorPct?: number;
  /** Alias legacy para minStructuralFloorPct */
  minEquityFloorPct?: number;
  /** Límite inferior absoluto de sanidad técnica universal (default: 0.002 = 0.20%) */
  minClampPct?: number;
  /** @deprecated Alias legacy para minClampPct */
  minStopPct?: number;
}

export function calculateAlertLevels(
  signal: string,
  entryPrice: number,
  interval: string,
  atr?: number,
  strategyKey?: string,
  options?: CalculateAlertLevelsOptions
): { stopLoss: number; takeProfit1: number; takeProfit2?: number } {
  const isBuy = signal.includes('BUY');
  const isCrypto = options?.isCrypto ?? true;
  
  // Parity with backtester.ts strategy-specific risk geometry:
  // Confluencia is designed with 2.0*ATR, Scoring with 1.5*ATR, Standard with 1.2*ATR (or 1.0 on 1d)
  // For equities in 5m day trading (1-2h holding period), 2.5*ATR captures the required intraday move.
  const atrMultiplier = getStrategyAtrMultiplier(strategyKey, interval, isCrypto);
  const fallbackThreshold = interval === '1d' ? 0.015 : interval === '1h' ? 0.012 : 0.008;
  
  let stopPct = fallbackThreshold;
  if (atr && atr > 0 && entryPrice > 0) {
    const atrPct = atr / entryPrice;
    stopPct = atrPct * atrMultiplier;

    // For intraday (5m) day trading with normal market volatility (atrPct >= 0.06%),
    // enforce a minimum structural floor (default 0.40%) to ensure viability under broker friction (0.14% / 0.40% = 0.35R <= 0.35R).
    // Applies to both crypto and equities to eliminate the dead band [0.20%, 0.3143%).
    if (interval.toLowerCase() === '5m' && atrPct >= 0.0006) {
      const structuralFloor = options?.minStructuralFloorPct ?? options?.minEquityFloorPct ?? 0.004;
      stopPct = Math.max(structuralFloor, stopPct);
    }
  }
  // Clamp to technical sanity bounds [0.2%, 8%]
  const clampFloor = options?.minClampPct ?? options?.minStopPct ?? 0.002;
  stopPct = Math.max(clampFloor, Math.min(0.08, stopPct));

  const targetPct = stopPct * 1.5; // Single objective at +1.5R (targetMultiplier: 1.5)

  if (isBuy) {
    const sl = entryPrice * (1 - stopPct);
    const tp = entryPrice * (1 + targetPct);
    return {
      stopLoss: sl,
      takeProfit1: tp,
    };
  } else {
    const sl = entryPrice * (1 + stopPct);
    const tp = entryPrice * (1 - targetPct);
    return {
      stopLoss: sl,
      takeProfit1: tp,
    };
  }
}

export function isValidTradeGeometry(signal: string, levels: TradeLevels): boolean {
  const direction: TradeDirection | undefined = signal.includes('BUY') ? 'BUY' : signal.includes('SELL') ? 'SELL' : undefined;
  if (!direction) return false;
  const sign = direction === 'BUY' ? 1 : -1;
  const { entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3 } = levels;
  if (![entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3].filter(v => v !== undefined).every(v => Number.isFinite(v) && v! > 0)) return false;
  if (sign * (entryPrice - stopLoss) <= 0 || sign * (takeProfit1 - entryPrice) <= 0) return false;
  if (takeProfit2 !== undefined && sign * (takeProfit2 - takeProfit1) <= 0) return false;
  if (takeProfit3 !== undefined && sign * (takeProfit3 - (takeProfit2 ?? takeProfit1)) <= 0) return false;
  return true;
}

export const DEFAULT_FRICTION_PCT = 0.11;
export const DEFAULT_SLIPPAGE_PCT = 0.03;
export const MAX_VIABLE_FRICTION_R = 0.35; // Friction (fees + slippage) cannot exceed 0.35R (35% of stop)

/** Returns the minimum stop percentage required for nominal friction to remain below maxFrictionR. */
export function getMinViableStopPct(
  frictionPct: number = DEFAULT_FRICTION_PCT,
  slippagePct: number = DEFAULT_SLIPPAGE_PCT,
  maxFrictionR: number = MAX_VIABLE_FRICTION_R
): number {
  if (maxFrictionR <= 0) return 0;
  return ((frictionPct + slippagePct) / 100) / maxFrictionR;
}

/**
 * Checks whether a trade's stop distance is wide enough that nominal frictions
 * (broker commissions + market slippage) do not consume an excessive portion of risk (R).
 * If total friction in R exceeds maxFrictionR (default 0.35R), the trade is economically unviable.
 */
export function isTradeFrictionViable(
  entryPrice: number,
  stopLoss: number,
  frictionPct: number = DEFAULT_FRICTION_PCT,
  slippagePct: number = DEFAULT_SLIPPAGE_PCT,
  maxFrictionR: number = MAX_VIABLE_FRICTION_R
): boolean {
  if (!entryPrice || entryPrice <= 0 || !stopLoss || stopLoss <= 0) return false;
  const stopDist = Math.abs(entryPrice - stopLoss);
  const stopPct = stopDist / entryPrice;
  if (stopPct <= 0) return false;
  const totalFrictionPct = (frictionPct + slippagePct) / 100;
  const frictionR = totalFrictionPct / stopPct;
  return frictionR <= maxFrictionR + 1e-5;
}

export const SCORING_SR_LOOKBACK_BARS = 100;

export interface ScoringSRValidationResult {
  viable: boolean;
  nearestResistance: number;
  nearestSupport: number;
  reason?: string;
}

/**
 * Validates whether there is sufficient reward room towards immediate support/resistance
 * before reaching Take Profit 1, using the canonical rolling lookback window (100 bars).
 * Shared by backtester.ts and operationalTrade.ts to ensure 1:1 live-to-backtest parity.
 */
export function validateScoringSRRoom(
  klines: Kline[],
  currentIndex: number,
  signal: string,
  entryPrice: number,
  takeProfit1: number,
  stopLoss?: number,
  lookbackBars: number = SCORING_SR_LOOKBACK_BARS
): ScoringSRValidationResult {
  const windowStart = Math.max(0, currentIndex - lookbackBars);
  const windowSlice = klines.slice(windowStart, currentIndex + 1);
  const sr = calculateSupportResistance(windowSlice, entryPrice, 5);
  const targetDist = Math.abs(takeProfit1 - entryPrice);
  const slDist = stopLoss ? Math.abs(entryPrice - stopLoss) : targetDist / 1.5;

  if (signal.includes('BUY') && sr.nearestResistance > entryPrice) {
    const rewardRoom = sr.nearestResistance - entryPrice;
    if (rewardRoom < targetDist) {
      return {
        viable: false,
        nearestResistance: sr.nearestResistance,
        nearestSupport: sr.nearestSupport,
        reason: `R:R ${(rewardRoom / (slDist || 1)).toFixed(1)}:1 insuficiente hacia resistencia (${formatSmartPrice(sr.nearestResistance)}) antes de TP1 (${formatSmartPrice(takeProfit1)})`
      };
    }
  } else if (signal.includes('SELL') && sr.nearestSupport > 0 && sr.nearestSupport < entryPrice) {
    const rewardRoom = entryPrice - sr.nearestSupport;
    if (rewardRoom < targetDist) {
      return {
        viable: false,
        nearestResistance: sr.nearestResistance,
        nearestSupport: sr.nearestSupport,
        reason: `R:R ${(rewardRoom / (slDist || 1)).toFixed(1)}:1 insuficiente hacia soporte (${formatSmartPrice(sr.nearestSupport)}) antes de TP1 (${formatSmartPrice(takeProfit1)})`
      };
    }
  }

  return {
    viable: true,
    nearestResistance: sr.nearestResistance,
    nearestSupport: sr.nearestSupport
  };
}
