import type { Kline } from '../services/api';
import type { ConfidenceLevel } from './tournament';

export type AlertStatus = 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'EXPIRED';

export interface AuditAlertItem {
  id: string;
  symbol: string;
  interval: string;
  signal: string;             // 'BUY' | 'SELL' | 'STRONG BUY' | 'STRONG SELL'
  time: string;
  pf: number;
  strategy: string;
  confidence?: ConfidenceLevel;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  status: AlertStatus;
  realizedR: number;          // Risk multiplier: +1.5R, +2.5R, -1.0R, etc.
  pnlPercent: number;         // Floating or final PnL %
  timestamp: number;          // Unix ms timestamp when alert was fired
}

export interface SessionStats {
  total: number;
  wins: number;
  losses: number;
  openCount: number;
  winRate: number;            // Percentage 0-100
  totalR: number;             // Sum of net R earned
}

/**
 * Calculates stop loss, TP1, and TP2 targets based on interval & direction.
 */
export function calculateAlertLevels(
  signal: string,
  entryPrice: number,
  interval: string
): { stopLoss: number; takeProfit1: number; takeProfit2: number } {
  const isBuy = signal.includes('BUY');
  
  // Percentages per timeframe
  let stopPct = 0.006; // 0.6% for 5m
  if (interval === '1h') {
    stopPct = 0.018;   // 1.8% for 1h
  } else if (interval === '1d') {
    stopPct = 0.035;   // 3.5% for 1d
  }

  const tp1Pct = stopPct * 1.5; // 1:1.5 R:R
  const tp2Pct = stopPct * 2.5; // 1:2.5 R:R

  if (isBuy) {
    return {
      stopLoss: Number((entryPrice * (1 - stopPct)).toFixed(4)),
      takeProfit1: Number((entryPrice * (1 + tp1Pct)).toFixed(4)),
      takeProfit2: Number((entryPrice * (1 + tp2Pct)).toFixed(4)),
    };
  } else {
    return {
      stopLoss: Number((entryPrice * (1 + stopPct)).toFixed(4)),
      takeProfit1: Number((entryPrice * (1 - tp1Pct)).toFixed(4)),
      takeProfit2: Number((entryPrice * (1 - tp2Pct)).toFixed(4)),
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

/**
 * Evaluates open alerts against latest klines for each symbol.
 * Updates alert status (TP1_HIT, TP2_HIT, SL_HIT, EXPIRED) and floating PnL.
 */
export function updateAlertsOutcome(
  alerts: AuditAlertItem[],
  klinesBySymbol: Record<string, Kline[]>
): AuditAlertItem[] {
  return alerts.map(alert => {
    // Only process OPEN alerts or alerts needing PnL update
    const symbolKlines = klinesBySymbol[alert.symbol];
    if (!symbolKlines || symbolKlines.length === 0) return alert;

    const latestCandle = symbolKlines[symbolKlines.length - 1];
    const latestPrice = latestCandle.close;
    const isBuy = alert.signal.includes('BUY');

    // Calculate current floating PnL %
    const pnlPercent = isBuy
      ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 100
      : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 100;

    if (alert.status !== 'OPEN') {
      return { ...alert, pnlPercent: Number(pnlPercent.toFixed(2)) };
    }

    // Evaluate candles that arrived after alert timestamp
    const futureCandles = symbolKlines.filter(k => k.time * 1000 >= alert.timestamp);
    const candlesToEvaluate = futureCandles.length > 0 ? futureCandles : [latestCandle];

    let newStatus: AlertStatus = 'OPEN';
    let realizedR = 0;

    for (const candle of candlesToEvaluate) {
      if (isBuy) {
        // SL check first (conservative OHLC evaluation)
        if (candle.low <= alert.stopLoss) {
          // If TP1 was already hit in an earlier candle, lock in TP1_HIT instead of overwriting with SL_HIT
          if (newStatus !== 'TP1_HIT') {
            newStatus = 'SL_HIT';
            realizedR = -1.0;
            break;
          }
        }
        if (candle.high >= alert.takeProfit2) {
          newStatus = 'TP2_HIT';
          realizedR = 2.5;
          break;
        }
        if (candle.high >= alert.takeProfit1) {
          newStatus = 'TP1_HIT';
          realizedR = 1.5;
          // Continue evaluating to see if TP2 is reached later
        }
      } else {
        // Sell signal
        if (candle.high >= alert.stopLoss) {
          if (newStatus !== 'TP1_HIT') {
            newStatus = 'SL_HIT';
            realizedR = -1.0;
            break;
          }
        }
        if (candle.low <= alert.takeProfit2) {
          newStatus = 'TP2_HIT';
          realizedR = 2.5;
          break;
        }
        if (candle.low <= alert.takeProfit1) {
          newStatus = 'TP1_HIT';
          realizedR = 1.5;
        }
      }
    }

    // Check expiration (if 24 candles passed without SL or TP)
    if (newStatus === 'OPEN' && candlesToEvaluate.length >= 24) {
      newStatus = 'EXPIRED';
      // Compute realized R based on current PnL vs initial risk %
      const riskPct = Math.abs((alert.stopLoss - alert.entryPrice) / alert.entryPrice);
      realizedR = riskPct > 0 ? Number(((pnlPercent / 100) / riskPct).toFixed(2)) : 0;
    }

    return {
      ...alert,
      status: newStatus,
      realizedR: newStatus === 'OPEN' ? (realizedR > 0 ? realizedR : 0) : realizedR,
      pnlPercent: Number(pnlPercent.toFixed(2)),
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
    return { total: 0, wins: 0, losses: 0, openCount: 0, winRate: 0, totalR: 0 };
  }

  let wins = 0;
  let losses = 0;
  let openCount = 0;
  let totalR = 0;

  targetAlerts.forEach(alert => {
    if (alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
      wins++;
      totalR += alert.realizedR;
    } else if (alert.status === 'SL_HIT') {
      losses++;
      totalR += alert.realizedR; // -1.0
    } else if (alert.status === 'EXPIRED') {
      if (alert.realizedR >= 0) wins++;
      else losses++;
      totalR += alert.realizedR;
    } else {
      openCount++;
    }
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
  };
}
