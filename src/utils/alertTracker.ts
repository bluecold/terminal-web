import type { Kline } from '../services/api';
import type { ConfidenceLevel } from './tournament';
import { calculateVWAPSeries, calculateEMA, calculateATRSeries } from './indicators';
import { simulateTrade, type TradeLevels, type ExitPolicy } from './tradeSimulator';
import { getStrategyForwardWindow } from './backtester';

export type AlertStatus = 'OPEN' | 'TP1_HIT' | 'TP1_CLOSED' | 'TP2_HIT' | 'TP2_CLOSED' | 'SL_HIT' | 'TP1_BE_CLOSED' | 'EXPIRED';

export interface AuditAlertItem {
  id: string;
  symbol: string;
  interval: string;
  signal: string;             // 'BUY' | 'SELL' | 'STRONG BUY' | 'STRONG SELL'
  time: string;
  pf: number | null;
  strategy: string;
  executionStyle?: 'dayTrading' | 'swing';
  confidence?: ConfidenceLevel;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number;
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
 * Calculates stop loss and TP1 target based on interval & direction (single target 1.5R).
 * Exact 1:1 mathematical synchronization with backtester.ts getParams & getAdaptiveThreshold.
 */
export function calculateAlertLevels(
  signal: string,
  entryPrice: number,
  interval: string,
  atr?: number,
  strategyKey?: string
): { stopLoss: number; takeProfit1: number; takeProfit2?: number } {
  const isBuy = signal.includes('BUY');
  
  // Parity with backtester.ts strategy-specific risk geometry:
  // Confluencia is designed with 2.0*ATR, Scoring with 1.5*ATR, Standard with 1.2*ATR (or 1.0 on 1d)
  let atrMultiplier = interval === '1d' ? 1.0 : 1.2;
  if (strategyKey === 'confluencia') {
    atrMultiplier = 2.0;
  } else if (strategyKey === 'scoring') {
    atrMultiplier = 1.5;
  }
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
 * Uses canonical getStrategyForwardWindow from backtester.ts to guarantee strict 1:1 Live/Backtest parity.
 * - VCME Day Trading (5m): 72 candles = 6 hours
 * - VCME Swing (1h): 48 candles = 48 hours
 * - Multifractal MTF (5m): 12 candles = 1 hour
 * - Confluencia (2.0x ATR): 10 candles (5m), 7 candles (1h), 6 candles (1d)
 * - Scoring (1.5x ATR): 8 candles (5m), 5 candles (1h), 5 candles (1d)
 * - Standard (1.2x ATR): 6 candles (5m), 4 candles (1h), 3 candles (1d)
 */
export function getStrategyExpiryCandles(
  strategy?: string,
  interval?: string,
  executionStyle?: 'dayTrading' | 'swing'
): number {
  return getStrategyForwardWindow(strategy, interval ?? '5m', executionStyle);
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
    if (alert.status === 'TP2_CLOSED' || alert.status === 'TP1_CLOSED' || alert.status === 'SL_HIT' || alert.status === 'TP1_BE_CLOSED' || alert.status === 'EXPIRED') {
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

    // Include all candles (closed and currently forming live candle) that occurred AFTER the alert was fired
    const candlesToEvaluate = symbolKlines.filter(k => {
      const isAfterAlert = alert.candleTimestamp && alert.candleTimestamp > 0
        ? k.time > alert.candleTimestamp
        : (k.time + durationSec) * 1000 > alert.timestamp;

      return isAfterAlert;
    }).map(k => {
      const candleStartMs = k.time * 1000;
      // If the alert was fired inside this candle (entry occurred mid-candle):
      // The position cannot retroactively trigger on pre-alert extremes that happened before alert.timestamp.
      // We bound the candle extremes to only what the market has reached since entry (from alert.entryPrice to k.close).
      if (candleStartMs <= alert.timestamp) {
        return {
          ...k,
          open: alert.entryPrice,
          high: Math.max(alert.entryPrice, k.close),
          low: Math.min(alert.entryPrice, k.close),
        };
      }
      // Candles fully after the entry candle preserve authentic OHLC
      return k;
    });

    const isMultifractal = alert.strategy?.includes('Multifractal');
    const isDayTrading = alert.interval === '5m' || alert.interval === '1m' || alert.interval === '3m';

    const maxExpiryCandles = getStrategyExpiryCandles(alert.strategy, alert.interval, alert.executionStyle);

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

    const entryCandle: Kline = {
      time: alert.candleTimestamp || (Math.floor(alert.timestamp / 1000) - durationSec),
      open: alert.entryPrice,
      high: alert.entryPrice,
      low: alert.entryPrice,
      close: alert.entryPrice,
      volume: 0
    };
    const evalKlines = [entryCandle, ...candlesToEvaluate];

    const mappedAtrSeries = evalKlines.map(k => {
      const fi = candleIndexMap.get(k.time);
      return fi !== undefined && atrSeries[fi] && !isNaN(atrSeries[fi]) && atrSeries[fi] > 0
        ? atrSeries[fi]
        : Math.abs(alert.entryPrice - alert.stopLoss) / 1.5;
    });

    const mappedEma9Series = evalKlines.map(k => {
      const fi = candleIndexMap.get(k.time);
      return fi !== undefined && ema9Series[fi] ? ema9Series[fi] : NaN;
    });

    const levels: TradeLevels = {
      entryPrice: alert.entryPrice,
      stopLoss: alert.stopLoss,
      takeProfit1: alert.takeProfit1,
      takeProfit2: alert.takeProfit2
    };

    const isCrypto = alert.symbol ? (alert.symbol.endsWith('USDT') || alert.symbol.endsWith('BTC')) : true;
    const isSessionBased = !isCrypto;

    const intervalMs = durationSec * 1000;
    // For 24/7 continuous crypto markets, wall-clock time aligns 1:1 with candle duration.
    // For session-based equities, leave undefined so weekends and overnight gaps do not falsely expire trades.
    const maxExpiryTimestampMs = isCrypto ? alert.timestamp + maxExpiryCandles * intervalMs : undefined;

    const policy: ExitPolicy = {
      forwardWindow: maxExpiryCandles,
      enablePartials: isVCME ? 'vcme-runner' : false,
      moveSlToBreakevenOnTp1: true,
      timeStopBars: (isVCME && isDayTrading && alert.executionStyle !== 'swing') ? 8 : 0,
      earlyAdverseCutoffBars: (isMultifractal && isDayTrading) ? 3 : 0,
      earlyAdverseCutoffR: 0.5,
      trailingStop: isVCME ? 'chandelier' : 'none',
      emergencyExitFn: isVCME ? (k, _idx, dir) => {
        const fi = candleIndexMap.get(k.time);
        if (fi === undefined) return false;
        const currentVwap = vwapSeries[fi] ?? 0;
        const currentEma21 = ema21Series[fi] ?? 0;
        if (currentVwap <= 0 || currentEma21 <= 0) return false;
        return dir === 'BUY'
          ? (k.close < currentVwap && k.close < currentEma21)
          : (k.close > currentVwap && k.close > currentEma21);
      } : undefined,
      sessionGapCutoff: isSessionBased && isDayTrading,
      stepSec: durationSec,
      atrSeries: mappedAtrSeries,
      ema9Series: mappedEma9Series,
      frictionPct: 0.08,
      floatingClosePrice: latestPrice,
      maxExpiryTimestampMs,
      isCandleClosed,
    };

    const sim = simulateTrade(evalKlines, 0, isBuy ? 'BUY' : 'SELL', levels, policy);

    return {
      ...alert,
      status: sim.status,
      realizedR: sim.realizedR,
      pnlPercent: sim.pnlPct
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

    if (alert.status === 'TP2_CLOSED' || alert.status === 'TP1_CLOSED' || alert.status === 'TP1_BE_CLOSED') {
      wins++;
      totalR += alert.realizedR;
      stratObj.wins++;
      stratObj.totalR += alert.realizedR;
    } else if (alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
      openCount++;
      stratObj.openCount++;
    } else if (alert.status === 'SL_HIT') {
      losses++;
      totalR += alert.realizedR;
      stratObj.losses++;
      stratObj.totalR += alert.realizedR;
    } else if (alert.status === 'EXPIRED') {
      if (alert.realizedR > 0) {
        wins++;
        stratObj.wins++;
      } else if (alert.realizedR < 0) {
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
    return Boolean(registry[key]);
  }

  // If no specific signal requested, check if ANY signal fired for THIS specific strategy
  const normSymbol = (symbol || '').toUpperCase().trim();
  const normInterval = (interval || '').toLowerCase().trim();
  const normStrat = (strategy || '').toLowerCase().trim();
  const prefix = `${normSymbol}:${normInterval}:${candleTimestamp}:${normStrat}:`;

  for (const k in registry) {
    if (k.startsWith(prefix)) {
      return true;
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
