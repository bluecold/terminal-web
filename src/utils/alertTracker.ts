import type { Kline } from '../services/api';
import type { ConfidenceLevel } from './tournament';

export type AlertStatus = 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'TP1_BE_CLOSED' | 'EXPIRED';

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
 */
export function calculateAlertLevels(
  signal: string,
  entryPrice: number,
  interval: string,
  atr?: number
): { stopLoss: number; takeProfit1: number; takeProfit2: number } {
  const isBuy = signal.includes('BUY');
  
  // Dynamic ATR or percentage fallback per timeframe
  let stopPct = 0.006; // 0.6% for 5m
  if (atr && atr > 0 && entryPrice > 0) {
    stopPct = Math.max(0.003, (atr * 1.5) / entryPrice);
  } else if (interval === '1h') {
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
 * Updates alert status (TP1_HIT, TP2_HIT, SL_HIT, TP1_BE_CLOSED, EXPIRED) and floating PnL.
 */
export function updateAlertsOutcome(
  alerts: AuditAlertItem[],
  klinesBySymbol: Record<string, Kline[]>
): AuditAlertItem[] {
  return alerts.map(alert => {
    // If the alert is already closed (TP2_HIT, SL_HIT, TP1_BE_CLOSED, EXPIRED), freeze its outcome and realized PnL
    if (alert.status === 'TP2_HIT' || alert.status === 'SL_HIT' || alert.status === 'TP1_BE_CLOSED' || alert.status === 'EXPIRED') {
      return alert;
    }

    // Lookup klines using specific symbol:interval key first, falling back to symbol
    const key = `${alert.symbol}:${alert.interval}`;
    const symbolKlines = klinesBySymbol[key] || klinesBySymbol[alert.symbol];
    if (!symbolKlines || symbolKlines.length === 0) return alert;

    const latestCandle = symbolKlines[symbolKlines.length - 1];
    const latestPrice = latestCandle.close;
    const isBuy = alert.signal.includes('BUY');

    // Evaluate candles that arrived after alert timestamp
    const futureCandles = symbolKlines.filter(k => k.time * 1000 >= alert.timestamp);
    const candlesToEvaluate = futureCandles.length > 0 ? futureCandles : [latestCandle];

    let currentStatus: AlertStatus = alert.status;
    let realizedR = alert.realizedR || 0;
    let currentPnl = alert.pnlPercent;

    const initialRiskPct = Math.abs((alert.stopLoss - alert.entryPrice) / alert.entryPrice);
    let activeSL = currentStatus === 'TP1_HIT' ? alert.entryPrice : alert.stopLoss;

    for (const candle of candlesToEvaluate) {
      if (isBuy) {
        // 1. Check Stop Loss
        if (candle.low <= activeSL) {
          if (currentStatus === 'TP1_HIT') {
            // SL at Breakeven after TP1: lock in 0.50 * TP1 gain
            const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
            currentPnl = Number(tp1Gain.toFixed(2));
            realizedR = 1.0;
            currentStatus = 'TP1_BE_CLOSED';
            break;
          } else {
            currentStatus = 'SL_HIT';
            currentPnl = -Number((initialRiskPct * 100).toFixed(2));
            realizedR = -1.0;
            break;
          }
        }

        // 2. Check TP2
        if (candle.high >= alert.takeProfit2) {
          currentStatus = 'TP2_HIT';
          const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
          const tp2Gain = ((alert.takeProfit2 - alert.entryPrice) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + tp2Gain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number((((alert.takeProfit1 + alert.takeProfit2) / 2 - alert.entryPrice) / (alert.entryPrice * initialRiskPct)).toFixed(2)) : 2.5;
          break;
        }

        // 3. Check TP1
        if (currentStatus === 'OPEN' && candle.high >= alert.takeProfit1) {
          currentStatus = 'TP1_HIT';
          activeSL = alert.entryPrice; // Trailing SL to breakeven
          const tp1Gain = ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50;
          const openFloating = ((candle.close - alert.entryPrice) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + openFloating).toFixed(2));
          realizedR = 1.5;
        }
      } else {
        // Sell signal
        if (candle.high >= activeSL) {
          if (currentStatus === 'TP1_HIT') {
            const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
            currentPnl = Number(tp1Gain.toFixed(2));
            realizedR = 1.0;
            currentStatus = 'TP1_BE_CLOSED';
            break;
          } else {
            currentStatus = 'SL_HIT';
            currentPnl = -Number((initialRiskPct * 100).toFixed(2));
            realizedR = -1.0;
            break;
          }
        }

        if (candle.low <= alert.takeProfit2) {
          currentStatus = 'TP2_HIT';
          const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
          const tp2Gain = ((alert.entryPrice - alert.takeProfit2) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + tp2Gain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((alert.entryPrice - (alert.takeProfit1 + alert.takeProfit2) / 2) / (alert.entryPrice * initialRiskPct)).toFixed(2)) : 2.5;
          break;
        }

        if (currentStatus === 'OPEN' && candle.low <= alert.takeProfit1) {
          currentStatus = 'TP1_HIT';
          activeSL = alert.entryPrice;
          const tp1Gain = ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
          const openFloating = ((alert.entryPrice - candle.close) / alert.entryPrice) * 50;
          currentPnl = Number((tp1Gain + openFloating).toFixed(2));
          realizedR = 1.5;
        }
      }
    }

    // Expiration check (24 candles of alert timeframe without SL, TP2 or TP1_BE)
    const intervalMs = alert.interval === '1h' ? 3600000 : alert.interval === '1d' ? 86400000 : 300000;
    const expiryTime = alert.timestamp + 24 * intervalMs;
    const isExpiredByTime = latestCandle.time * 1000 >= expiryTime;

    if ((currentStatus === 'OPEN' || currentStatus === 'TP1_HIT') && isExpiredByTime) {
      if (currentStatus === 'TP1_HIT') {
        const tp1Gain = isBuy
          ? ((alert.takeProfit1 - alert.entryPrice) / alert.entryPrice) * 50
          : ((alert.entryPrice - alert.takeProfit1) / alert.entryPrice) * 50;
        const openFloating = isBuy
          ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 50
          : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 50;
        currentPnl = Number((tp1Gain + openFloating).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : 1.0;
      } else {
        const floatingPnl = isBuy
          ? ((latestPrice - alert.entryPrice) / alert.entryPrice) * 100
          : ((alert.entryPrice - latestPrice) / alert.entryPrice) * 100;
        currentPnl = Number(floatingPnl.toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((currentPnl / 100) / initialRiskPct).toFixed(2)) : 0;
      }
      currentStatus = 'EXPIRED';
    }

    // If still actively floating (OPEN or TP1_HIT), compute current floating PnL
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

    if (alert.status === 'TP2_HIT' || alert.status === 'TP1_BE_CLOSED') {
      wins++;
      totalR += alert.realizedR;
      stratObj.wins++;
      stratObj.totalR += alert.realizedR;
    } else if (alert.status === 'TP1_HIT') {
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
