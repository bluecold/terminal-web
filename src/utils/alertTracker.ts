import type { Kline } from '../services/api';
import type { ConfidenceLevel } from './tournament';
import { calculateVWAPSeries, calculateEMA, calculateATRSeries } from './indicators';

export type AlertStatus = 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'TP2_CLOSED' | 'SL_HIT' | 'TP1_BE_CLOSED' | 'EXPIRED';

export interface AuditAlertItem {
  id: string;
  symbol: string;
  interval: string;
  signal: string;             // 'BUY' | 'SELL' | 'STRONG BUY' | 'STRONG SELL'
  time: string;
  pf: number;
  strategy: string;
  executionStyle?: 'dayTrading' | 'swing';
  confidence?: ConfidenceLevel;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  status: AlertStatus;
  realizedR: number;          // Risk multiplier: +1.5R, +2.5R, -1.0R, etc.
  pnlPercent: number;         // Floating or final PnL %
  timestamp: number;          // Unix ms timestamp when alert was fired
  candleTimestamp?: number;   // Unix seconds timestamp of the closed candle that triggered the alert
  dedupKey?: string;          // Canonical deduplication signature
}

export interface FiredAlertRegistryEntry {
  key: string;
  symbol: string;
  interval: string;
  candleTimestamp: number;
  strategy: string;
  signal: string;
  firedAt: number;
}

export interface StrategyBreakdown {
  wins: number;
  losses: number;
  openCount: number;
  totalR: number;
}

export interface SessionStats {
  total: number;
  wins: number;
  losses: number;
  openCount: number;
  winRate: number;            // Percentage 0-100
  totalR: number;             // Sum of net R earned
  byStrategy: Record<string, StrategyBreakdown>;
}

/**
 * Calculates stop loss, TP1, and TP2 targets based on interval & direction.
 * Exact 1:1 mathematical synchronization with backtester.ts getParams & getAdaptiveThreshold.
 */
export function calculateAlertLevels(
  signal: string,
  entryPrice: number,
  interval: string,
  atr?: number
): { stopLoss: number; takeProfit1: number; takeProfit2: number } {
  const isBuy = signal.includes('BUY');
  
  // Parity with backtester.ts getParams:
  const atrMultiplier = interval === '1d' ? 1.0 : 1.2;
  const fallbackThreshold = interval === '1d' ? 0.015 : interval === '1h' ? 0.012 : 0.008;
  
  let stopPct = fallbackThreshold;
  if (atr && atr > 0 && entryPrice > 0) {
    const atrPct = atr / entryPrice;
    stopPct = atrPct * atrMultiplier;
  }
  // Clamp to [0.2%, 8%] exactly as getAdaptiveThreshold in backtester.ts:119
  stopPct = Math.max(0.002, Math.min(0.08, stopPct));

  const targetPct = stopPct * 1.5; // Single objective at +1.5R (targetMultiplier: 1.5)

  if (isBuy) {
    const sl = entryPrice * (1 - stopPct);
    const tp = entryPrice * (1 + targetPct);
    return {
      stopLoss: sl,
      takeProfit1: tp,
      takeProfit2: tp, // Single target parity
    };
  } else {
    const sl = entryPrice * (1 + stopPct);
    const tp = entryPrice * (1 - targetPct);
    return {
      stopLoss: sl,
      takeProfit1: tp,
      takeProfit2: tp, // Single target parity
    };
  }
}

/**
 * Checks whether an alert timestamp is from the current calendar day (local time).
 */
export function isAlertFromToday(timestamp: number): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function getIntervalDurationSec(interval: string): number {
  switch (interval?.toLowerCase()) {
    case '1m': return 60;
    case '3m': return 180;
    case '5m': return 300;
    case '15m': return 900;
    case '30m': return 1800;
    case '1h': return 3600;
    case '2h': return 7200;
    case '4h': return 14400;
    case '6h': return 21600;
    case '8h': return 28800;
    case '12h': return 43200;
    case '1d': return 86400;
    case '3d': return 259200;
    case '1w': return 604800;
    default: return 300;
  }
}

/**
 * Returns the exact forward horizon (number of candles) matching the strategy's backtested window.
 * - VCME Day Trading (5m): 72 candles = 6 hours
 * - VCME Swing (1h): 48 candles = 48 hours
 * - Multifractal MTF (5m): 12 candles = 1 hour
 * - Standard / Confluencia / Scoring: 6 candles (5m), 4 candles (1h), 3 candles (1d)
 */
export function getStrategyExpiryCandles(
  strategy?: string,
  interval?: string,
  executionStyle?: 'dayTrading' | 'swing'
): number {
  const isMultifractal = strategy?.includes('Multifractal');
  const isVCME = strategy?.includes('VCME') || strategy?.includes('Multitemporal');

  if (isMultifractal) return 12; // 12 candles 5m = 1 hour forward window
  
  if (isVCME) {
    if (executionStyle === 'swing' || interval === '1h') return 48; // 48 candles 1h = 48 hours
    return 72; // 72 candles 5m = 6 hours (Intraday forward window)
  }

  switch (interval?.toLowerCase()) {
    case '5m': return 6;
    case '1h': return 4;
    case '1d': return 3;
    default: return 24;
  }
}

/**
 * Evaluates open alerts against latest klines for each symbol.
 * Updates alert status (TP1_HIT, TP2_HIT, SL_HIT, TP1_BE_CLOSED, EXPIRED) and floating PnL.
 */
export function updateAlertsOutcome(
  alerts: AuditAlertItem[],
  klinesBySymbol: Record<string, Kline[]>
): AuditAlertItem[] {
  return alerts.map(alert => {
    // If the alert is already closed in a terminal state, freeze its outcome and realized PnL
    if (alert.status === 'TP2_CLOSED' || alert.status === 'SL_HIT' || alert.status === 'TP1_BE_CLOSED' || alert.status === 'EXPIRED') {
      return alert;
    }
    const isVCME = alert.strategy?.includes('VCME') || alert.strategy?.includes('Multitemporal');

    // Lookup klines using specific symbol:interval key first, falling back to symbol
    const key = `${alert.symbol}:${alert.interval}`;
    const symbolKlines = klinesBySymbol[key] || klinesBySymbol[alert.symbol];
    if (!symbolKlines || symbolKlines.length === 0) return alert;

    const latestCandle = symbolKlines[symbolKlines.length - 1];
    const latestPrice = latestCandle.close;
    const isBuy = alert.signal.includes('BUY');

    const durationSec = getIntervalDurationSec(alert.interval);
    const nowMs = Date.now();

    // A candle is confirmed closed only if its close boundary has passed in time
    const isCandleClosed = (k: Kline) => (k.time + durationSec) * 1000 <= nowMs;

    // Filter only CLOSED candles that finished AFTER the alert was fired
    const candlesToEvaluate = symbolKlines.filter(k => {
      const isAfterAlert = alert.candleTimestamp && alert.candleTimestamp > 0
        ? k.time > alert.candleTimestamp
        : (k.time + durationSec) * 1000 > alert.timestamp;

      return isAfterAlert && isCandleClosed(k);
    });

    const isMultifractal = alert.strategy?.includes('Multifractal');
    const isDayTrading = alert.interval === '5m' || alert.interval === '1m' || alert.interval === '3m';

    // Strictly causal deterministic evaluation: Always replay forward chronologically from inception
    let currentStatus: AlertStatus = 'OPEN';
    let realizedR = 0;
    let currentPnl = 0;

    const initialRiskDist = Math.abs(alert.entryPrice - alert.stopLoss);
    const initialRiskPct = alert.entryPrice > 0 ? initialRiskDist / alert.entryPrice : 0.02;
    const r1 = initialRiskDist > 0 ? Math.abs(alert.takeProfit1 - alert.entryPrice) / initialRiskDist : 1.5;
    const r2 = initialRiskDist > 0 ? Math.abs(alert.takeProfit2 - alert.entryPrice) / initialRiskDist : 2.5;
    const tp3 = isBuy ? alert.entryPrice + 5.0 * initialRiskDist : alert.entryPrice - 5.0 * initialRiskDist;
    let activeSL = alert.stopLoss;
    let highestHigh = alert.entryPrice;
    let lowestLow = alert.entryPrice;

    // Pre-calculate indicators for VCME exits
    let vwapSeries: number[] = [];
    let ema21Series: number[] = [];
    let ema9Series: number[] = [];
    let atrSeries: number[] = [];

    if (isVCME && symbolKlines.length > 0) {
      const closes = symbolKlines.map(k => k.close);
      vwapSeries = calculateVWAPSeries(symbolKlines, alert.executionStyle === 'swing' ? '1h' : '5m', alert.symbol);
      ema21Series = calculateEMA(closes, 21);
      ema9Series = calculateEMA(closes, 9);
      atrSeries = calculateATRSeries(symbolKlines, 14);
    }

    const candleIndexMap = new Map<number, number>();
    for (let i = 0; i < symbolKlines.length; i++) {
      candleIndexMap.set(symbolKlines[i].time, i);
    }

    const maxExpiryCandles = getStrategyExpiryCandles(alert.strategy, alert.interval, alert.executionStyle);

    for (let candleIdx = 0; candleIdx < candlesToEvaluate.length; candleIdx++) {
      if (candleIdx >= maxExpiryCandles) {
        break; // Reached maximum horizon
      }

      const candle = candlesToEvaluate[candleIdx];
      const candleCount = candleIdx + 1;
      if (candle.high > highestHigh) highestHigh = candle.high;
      if (candle.low < lowestLow) lowestLow = candle.low;

      const fullIdx = candleIndexMap.get(candle.time) ?? -1;
      const currentVwap = fullIdx >= 0 && vwapSeries[fullIdx] !== undefined ? vwapSeries[fullIdx] : 0;
      const currentEma21 = fullIdx >= 0 && ema21Series[fullIdx] !== undefined ? ema21Series[fullIdx] : 0;
      const currentEma9 = fullIdx >= 0 && ema9Series[fullIdx] !== undefined ? ema9Series[fullIdx] : 0;
      const currentATR = fullIdx >= 0 && atrSeries[fullIdx] !== undefined && !isNaN(atrSeries[fullIdx]) ? atrSeries[fullIdx] : (initialRiskDist / 1.5);

      // ── 1. Strategy-Specific Early Exit Checks ─────────────────────────────
      // A. VCME Inactivity Time-Stop: 8 candles (40 min) for Day Trading if TP1 not hit and PnL < 0.5R
      if (isVCME && isDayTrading && alert.executionStyle !== 'swing' && currentStatus === 'OPEN' && candleCount >= 8) {
        const currentGain = isBuy ? candle.close - alert.entryPrice : alert.entryPrice - candle.close;
        if (currentGain < 0.5 * initialRiskDist) {
          const diffPct = (currentGain / alert.entryPrice) * 100;
          currentPnl = Number(diffPct.toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : 0;
          currentStatus = 'EXPIRED';
          break;
        }
      }

      // B. Multifractal Early Invalidation: in candles 1..3, if adverse move > 0.5R, cut loss early
      if (isMultifractal && isDayTrading && currentStatus === 'OPEN' && candleCount <= 3) {
        const adverseDiff = isBuy ? alert.entryPrice - candle.close : candle.close - alert.entryPrice;
        if (adverseDiff > 0.5 * initialRiskDist) {
          const lossPct = -Number(((adverseDiff / alert.entryPrice) * 100).toFixed(2));
          currentPnl = lossPct;
          realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : -0.5;
          currentStatus = 'SL_HIT';
          break;
        }
      }

      // C. VCME Emergency Exit (VWAP + EMA21 breach)
      const isLongEmergency = isBuy && isVCME && currentVwap > 0 && currentEma21 > 0 && candle.close < currentVwap && candle.close < currentEma21;
      const isShortEmergency = !isBuy && isVCME && currentVwap > 0 && currentEma21 > 0 && candle.close > currentVwap && candle.close > currentEma21;

      if (isLongEmergency || isShortEmergency) {
        const isLong = isBuy;
        const tp1P = (currentStatus === 'TP1_HIT' || currentStatus === 'TP2_HIT')
          ? 0.50 * (isLong ? (alert.takeProfit1 - alert.entryPrice) : (alert.entryPrice - alert.takeProfit1)) / alert.entryPrice * 100
          : 0;
        const tp2P = currentStatus === 'TP2_HIT'
          ? 0.25 * (isLong ? (alert.takeProfit2 - alert.entryPrice) : (alert.entryPrice - alert.takeProfit2)) / alert.entryPrice * 100
          : 0;
        const leftWeight = 1 - (currentStatus !== 'OPEN' ? 0.50 : 0) - (currentStatus === 'TP2_HIT' ? 0.25 : 0);
        const openPortionPnl = (isLong ? (candle.close - alert.entryPrice) : (alert.entryPrice - candle.close)) / alert.entryPrice * 100;
        currentPnl = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : -0.5;
        currentStatus = 'EXPIRED';
        break;
      }

      // ── 2. Target & Stop Loss Evaluation ──────────────────────────────────
      if (isBuy) {
        // Stop Loss Check
        if (candle.low <= activeSL) {
          if (currentStatus === 'TP2_HIT') {
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 25;
            const trailingGain = ((activeSL - alert.entryPrice) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + trailingGain).toFixed(2));
            realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * ((activeSL - alert.entryPrice) / initialRiskDist)).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          } else if (currentStatus === 'TP1_HIT') {
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            currentPnl = Number(tp1Gain.toFixed(2));
            realizedR = Number((0.50 * r1).toFixed(2));
            currentStatus = 'TP1_BE_CLOSED';
            break;
          } else {
            currentStatus = 'SL_HIT';
            currentPnl = -Number((initialRiskPct * 100).toFixed(2));
            realizedR = -1.0;
            break;
          }
        }

        // VCME Runner Exit after TP2 (Chandelier Trailing or EMA9 or TP3)
        if (isVCME && currentStatus === 'TP2_HIT') {
          const chandelierSL = highestHigh - 2.5 * currentATR;
          if (candle.close <= chandelierSL || (!isNaN(currentEma9) && currentEma9 > 0 && candle.close < currentEma9)) {
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 25;
            const runnerGain = ((candle.close - alert.entryPrice) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
            realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          } else if (candle.high >= tp3) {
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 25;
            const tp3Gain = ((tp3 - alert.entryPrice) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
            realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * 5.0).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          }
        }

        // TP2 Check
        if (candle.high >= alert.takeProfit2 && currentStatus !== 'TP2_HIT') {
          if (isVCME) {
            currentStatus = 'TP2_HIT';
            activeSL = alert.takeProfit1;
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 25;
            const runnerFloating = ((candle.close - alert.entryPrice) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
            const runnerFloatingR = initialRiskDist > 0 ? 0.25 * ((candle.close - alert.entryPrice) / initialRiskDist) : 0.25 * r2;
            realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
          } else {
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 50;
            currentPnl = Number((tp1Gain + tp2Gain).toFixed(2));
            realizedR = Number(((r1 + r2) / 2).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          }
        }

        // TP1 Check
        if (currentStatus === 'OPEN' && candle.high >= alert.takeProfit1) {
          currentStatus = 'TP1_HIT';
          activeSL = alert.entryPrice;
          const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
          const openFloating = ((candle.close - alert.entryPrice) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + openFloating).toFixed(2));
          realizedR = Number((0.50 * r1).toFixed(2));
        }
      } else {
        // Sell signal
        if (candle.high >= activeSL) {
          if (currentStatus === 'TP2_HIT') {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 25;
            const trailingGain = ((alert.entryPrice - activeSL) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + trailingGain).toFixed(2));
            realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * ((alert.entryPrice - activeSL) / initialRiskDist)).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          } else if (currentStatus === 'TP1_HIT') {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            currentPnl = Number(tp1Gain.toFixed(2));
            realizedR = Number((0.50 * r1).toFixed(2));
            currentStatus = 'TP1_BE_CLOSED';
            break;
          } else {
            currentStatus = 'SL_HIT';
            currentPnl = -Number((initialRiskPct * 100).toFixed(2));
            realizedR = -1.0;
            break;
          }
        }

        // VCME Runner Exit after TP2 (Chandelier Trailing or EMA9 or TP3)
        if (isVCME && currentStatus === 'TP2_HIT') {
          const chandelierSL = lowestLow + 2.5 * currentATR;
          if (candle.close >= chandelierSL || (!isNaN(currentEma9) && currentEma9 > 0 && candle.close > currentEma9)) {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 25;
            const runnerGain = ((alert.entryPrice - candle.close) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
            realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          } else if (candle.low <= tp3) {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 25;
            const tp3Gain = ((alert.entryPrice - tp3) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
            realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * 5.0).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          }
        }

        if (candle.low <= alert.takeProfit2 && currentStatus !== 'TP2_HIT') {
          if (isVCME) {
            currentStatus = 'TP2_HIT';
            activeSL = alert.takeProfit1;
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 25;
            const runnerFloating = ((alert.entryPrice - candle.close) / alert.entryPrice) * 25;
            currentPnl = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
            const runnerFloatingR = initialRiskDist > 0 ? 0.25 * ((alert.entryPrice - candle.close) / initialRiskDist) : 0.25 * r2;
            realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
          } else {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 50;
            currentPnl = Number((tp1Gain + tp2Gain).toFixed(2));
            realizedR = Number(((r1 + r2) / 2).toFixed(2));
            currentStatus = 'TP2_CLOSED';
            break;
          }
        }

        if (currentStatus === 'OPEN' && candle.low <= alert.takeProfit1) {
          currentStatus = 'TP1_HIT';
          activeSL = alert.entryPrice;
          const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
          const openFloating = ((alert.entryPrice - candle.close) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + openFloating).toFixed(2));
          realizedR = Number((0.50 * r1).toFixed(2));
        }
      }
    }

    // Expiration check based on unified strategy horizon
    const intervalMs = durationSec * 1000;
    const expiryTime = alert.timestamp + maxExpiryCandles * intervalMs;
    const isExpiredByTime = latestCandle.time * 1000 >= expiryTime;
    const isExpiredByCount = candlesToEvaluate.length >= maxExpiryCandles;

    if ((currentStatus === 'OPEN' || currentStatus === 'TP1_HIT' || (isVCME && currentStatus === 'TP2_HIT')) && (isExpiredByTime || isExpiredByCount)) {
      const exitPrice = latestPrice;
      const isLong = isBuy;
      const tp1P = (currentStatus === 'TP1_HIT' || currentStatus === 'TP2_HIT')
        ? 0.50 * (isLong ? (alert.takeProfit1 - alert.entryPrice) : (alert.entryPrice - alert.takeProfit1)) / alert.entryPrice * 100
        : 0;
      const tp2P = currentStatus === 'TP2_HIT'
        ? 0.25 * (isLong ? (alert.takeProfit2 - alert.entryPrice) : (alert.entryPrice - alert.takeProfit2)) / alert.entryPrice * 100
        : 0;
      const leftWeight = 1 - (currentStatus !== 'OPEN' ? 0.50 : 0) - (currentStatus === 'TP2_HIT' ? 0.25 : 0);
      const openPortionPnl = (isLong ? (exitPrice - alert.entryPrice) : (alert.entryPrice - exitPrice)) / alert.entryPrice * 100;
      currentPnl = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
      realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : 0;
      currentStatus = 'EXPIRED';
    }

    // If still actively floating (OPEN, TP1_HIT, or VCME TP2_HIT), compute current floating PnL
    if (currentStatus === 'OPEN') {
      const floatingPnl = isBuy
        ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 100
        : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 100;
      currentPnl = Number(floatingPnl.toFixed(2));
    } else if (currentStatus === 'TP1_HIT') {
      const tp1Gain = isBuy
        ? ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50
        : ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
      const openFloating = isBuy
        ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 50
        : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 50;
      currentPnl = Number((tp1Gain + openFloating).toFixed(2));
    } else if (currentStatus === 'TP2_HIT' && isVCME) {
      const tp1Gain = isBuy
        ? ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50
        : ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
      const tp2Gain = isBuy
        ? ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 25
        : ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 25;
      const runnerFloating = isBuy
        ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 25
        : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 25;
      currentPnl = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
      const runnerFloatingR = initialRiskDist > 0 ? 0.25 * ((isBuy ? latestPrice - alert.entryPrice : alert.entryPrice - latestPrice) / initialRiskDist) : 0.25 * r2;
      realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
    }

    return {
      ...alert,
      status: currentStatus,
      realizedR,
      pnlPercent: currentPnl,
    };
  });
}

/**
 * Calculates session summary metrics for the header bar.
 * By default filters alerts for the current calendar day ("HOY").
 */
export function calculateSessionStats(alerts: AuditAlertItem[], filterTodayOnly: boolean = true): SessionStats {
  const targetAlerts = filterTodayOnly
    ? alerts.filter(a => isAlertFromToday(a.timestamp))
    : alerts;

  if (targetAlerts.length === 0) {
    return { total: 0, wins: 0, losses: 0, openCount: 0, winRate: 0, totalR: 0, byStrategy: {} };
  }

  let wins = 0;
  let losses = 0;
  let openCount = 0;
  let totalR = 0;
  const byStrategy: Record<string, StrategyBreakdown> = {};

  targetAlerts.forEach(alert => {
    const strat = alert.strategy || 'Standard';
    if (!byStrategy[strat]) {
      byStrategy[strat] = { wins: 0, losses: 0, openCount: 0, totalR: 0 };
    }
    const stratObj = byStrategy[strat];

    if (alert.status === 'TP2_CLOSED' || alert.status === 'TP1_BE_CLOSED') {
      wins++;
      totalR += alert.realizedR;
      stratObj.wins++;
      stratObj.totalR += alert.realizedR;
    } else if (alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
      openCount++;
      stratObj.openCount++;
    } else if (alert.status === 'SL_HIT') {
      losses++;
      totalR += alert.realizedR; // -1.0
      stratObj.losses++;
      stratObj.totalR += alert.realizedR;
    } else if (alert.status === 'EXPIRED') {
      if (alert.realizedR >= 0) {
        wins++;
        stratObj.wins++;
      } else {
        losses++;
        stratObj.losses++;
      }
      totalR += alert.realizedR;
      stratObj.totalR += alert.realizedR;
    } else {
      openCount++;
      stratObj.openCount++;
    }
  });

  Object.keys(byStrategy).forEach(key => {
    byStrategy[key].totalR = Number(byStrategy[key].totalR.toFixed(1));
  });

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number(((wins / resolved) * 100).toFixed(1)) : 0;

  return {
    total: targetAlerts.length,
    wins,
    losses,
    openCount,
    winRate,
    totalR: Number(totalR.toFixed(1)),
    byStrategy,
  };
}

// ─── Atomic Candle Alert Deduplication Registry ────────────────────────────

export const REGISTRY_STORAGE_KEY = 'terminal_fired_alerts_registry';
let inMemoryRegistry: Record<string, FiredAlertRegistryEntry> = {};

function safeGetStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Fallback if storage access is restricted or in Node.js
  }
  return null;
}

/**
 * Generates an immutable canonical deduplication key for a candle alert.
 */
export function generateCandleAlertKey(
  symbol: string,
  interval: string,
  candleTimestamp: number,
  strategy: string,
  signal: string
): string {
  const normSymbol = (symbol || '').toUpperCase().trim();
  const normInterval = (interval || '').toLowerCase().trim();
  const normStrat = (strategy || '').toLowerCase().trim();
  const normSignal = (signal || '').toUpperCase().trim();
  return `${normSymbol}:${normInterval}:${candleTimestamp}:${normStrat}:${normSignal}`;
}

/**
 * Retrieves the fired alerts registry from localStorage or memory cache.
 */
export function getFiredAlertsRegistry(): Record<string, FiredAlertRegistryEntry> {
  const storage = safeGetStorage();
  if (storage) {
    try {
      const data = storage.getItem(REGISTRY_STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
          inMemoryRegistry = parsed;
          return inMemoryRegistry;
        }
      }
    } catch (e) {
      console.error('Error reading fired alerts registry from localStorage', e);
    }
  }
  return inMemoryRegistry;
}

/**
 * Checks if an alert has already fired for a specific closed candle timestamp.
 */
export function isCandleAlertFired(
  symbol: string,
  interval: string,
  candleTimestamp: number,
  strategy: string,
  signal?: string
): boolean {
  if (!candleTimestamp || candleTimestamp <= 0) return false;
  const registry = getFiredAlertsRegistry();
  
  if (signal) {
    const key = generateCandleAlertKey(symbol, interval, candleTimestamp, strategy, signal);
    if (registry[key]) return true;
  }

  // Also check if an alert for the same symbol, interval, and exact candle timestamp was already registered
  const normSymbol = (symbol || '').toUpperCase().trim();
  const normInterval = (interval || '').toLowerCase().trim();
  const normStrat = (strategy || '').toLowerCase().trim();
  const prefix = `${normSymbol}:${normInterval}:${candleTimestamp}:`;

  for (const k in registry) {
    if (k.startsWith(prefix)) {
      const entry = registry[k];
      if (entry && (entry.strategy.toLowerCase() === normStrat || (signal && entry.signal === signal))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Registers an alert emission in the persistent deduplication registry.
 */
export function registerFiredCandleAlert(entry: {
  symbol: string;
  interval: string;
  candleTimestamp: number;
  strategy: string;
  signal: string;
  firedAt?: number;
}): string {
  const firedAt = entry.firedAt || Date.now();
  const key = generateCandleAlertKey(
    entry.symbol,
    entry.interval,
    entry.candleTimestamp,
    entry.strategy,
    entry.signal
  );

  const registry = getFiredAlertsRegistry();
  registry[key] = {
    key,
    symbol: (entry.symbol || '').toUpperCase().trim(),
    interval: (entry.interval || '').toLowerCase().trim(),
    candleTimestamp: entry.candleTimestamp,
    strategy: entry.strategy,
    signal: entry.signal,
    firedAt
  };

  inMemoryRegistry = registry;
  const storage = safeGetStorage();
  if (storage) {
    try {
      storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(registry));
    } catch (e) {
      console.error('Error saving fired alerts registry to localStorage', e);
    }
  }
  return key;
}

/**
 * Prunes entries older than maxAgeDays (default 7 days) from the registry.
 */
export function pruneFiredAlertsRegistry(maxAgeDays: number = 7): number {
  const registry = getFiredAlertsRegistry();
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let prunedCount = 0;

  const newRegistry: Record<string, FiredAlertRegistryEntry> = {};
  for (const k in registry) {
    const item = registry[k];
    if (item && typeof item.firedAt === 'number' && item.firedAt >= cutoffTime) {
      newRegistry[k] = item;
    } else {
      prunedCount++;
    }
  }

  inMemoryRegistry = newRegistry;
  const storage = safeGetStorage();
  if (storage) {
    try {
      storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(newRegistry));
    } catch (e) {
      console.error('Error saving pruned registry to localStorage', e);
    }
  }
  return prunedCount;
}

/**
 * Clears all registry entries (used during full log reset or testing).
 */
export function clearFiredAlertsRegistry(): void {
  inMemoryRegistry = {};
  const storage = safeGetStorage();
  if (storage) {
    try {
      storage.removeItem(REGISTRY_STORAGE_KEY);
    } catch (e) {
      console.error('Error clearing fired alerts registry from localStorage', e);
    }
  }
}
