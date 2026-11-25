import type { Kline } from '../services/api';
import { getKlineSnapshotTime } from '../services/marketDataSnapshot';
import type { ConfidenceLevel } from './tournament';
import { calculateVWAPSeries, calculateEMA, calculateATRSeries, isCryptoAsset } from './indicators';
import { simulateTrade, type TradeLevels, type ExitPolicy, type TradeExecutionState } from './tradeSimulator';
import { getStrategyForwardWindow } from './backtester';
import { DEFAULT_FRICTION_PCT } from './tradeLevels';

export type AlertStatus = 'OPEN' | 'TP1_HIT' | 'TP1_CLOSED' | 'TP2_HIT' | 'TP2_CLOSED' | 'SL_HIT' | 'TP1_BE_CLOSED' | 'EXPIRED';

export interface AuditAlertItem {
  id: string;
  symbol: string;
  interval: string;
  signal: string;             // 'BUY' | 'SELL' | 'STRONG BUY' | 'STRONG SELL'
  time: string;
  pf: number | null;
  strategy: string;
  strategyKey?: string;
  executionStyle?: 'dayTrading' | 'swing';
  confidence?: ConfidenceLevel;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number;
  takeProfit3?: number;
  status: AlertStatus;
  realizedR: number;          // Risk multiplier: +1.5R, +2.5R, -1.0R, etc.
  pnlPercent: number;         // Floating or final PnL %
  timestamp: number;          // Unix ms timestamp when alert was fired
  candleTimestamp?: number;   // Unix seconds timestamp of the closed candle that triggered the alert
  dedupKey?: string;          // Canonical deduplication signature
  alertType?: 'PRIMARY' | 'EXPLORATORY'; // Primary institutional alert vs exploratory fallback
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp1Time?: number;
  tp2Time?: number;
  activeSL?: number;
  partialFilledTime?: number;
  executionState?: TradeExecutionState;
  executionWarning?: string;
  dataWarning?: string;
  eventNotice?: string;       // Earnings/macro catalysts at emission time (snapshot, informational only)
  entryBarObservation?: { time: number; high: number; low: number };
  appVersion?: string;        // App version (rule set) that emitted the alert; absent before v2026.11.16.1
  alertLatencySec?: number;  // Seconds from the trigger candle close to the moment the alert was emitted
  userFillPrice?: number;     // Price at which the trader actually executed the alert (manual entry)
  userFillTime?: number;      // Unix ms timestamp when the trader recorded the fill
}

export interface FiredAlertRegistryEntry {
  key: string;
  symbol: string;
  interval: string;
  candleTimestamp: number;
  strategy: string;
  strategyKey?: string;
  signal: string;
  firedAt: number;
}

export interface StrategyBreakdown {
  wins: number;
  losses: number;
  openCount: number;
  totalR: number;
  tpWins?: number;
  expWins?: number;
  slLosses?: number;
  expLosses?: number;
}

export interface SessionStats {
  total: number;
  wins: number;
  losses: number;
  openCount: number;
  winRate: number;            // Percentage 0-100
  totalR: number;             // Sum of net R earned
  byStrategy: Record<string, StrategyBreakdown>;
  tpWins?: number;
  expWins?: number;
  slLosses?: number;
  expLosses?: number;
  exploratory?: {
    total: number;
    wins: number;
    losses: number;
    openCount: number;
    winRate: number;
    totalR: number;
    tpWins?: number;
    expWins?: number;
    slLosses?: number;
    expLosses?: number;
  };
}

/**
 * Calculates stop loss and TP1 target based on interval & direction (single target 1.5R).
 * Exact 1:1 mathematical synchronization with backtester.ts getParams & getAdaptiveThreshold.
 */
export { calculateAlertLevels } from './tradeLevels';

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
 * - VCME Day Trading (5m): 24 candles = 2 hours
 * - VCME Swing (1h): 48 candles = 48 hours
 * - Multifractal MTF (5m): 12 candles = 1 hour
 * - Confluencia (2.0x ATR): 10 candles (5m), 7 candles (1h), 6 candles (1d)
 * - Scoring (1.5x ATR): 8 candles (5m), 5 candles (1h), 5 candles (1d)
 * - Standard (1.2x ATR): 6 candles (5m), 4 candles (1h), 3 candles (1d)
 */
export function getStrategyExpiryCandles(
  strategy?: string,
  interval?: string,
  executionStyle?: 'dayTrading' | 'swing',
  symbolOrIsCrypto?: string | boolean
): number {
  return getStrategyForwardWindow(strategy, interval ?? '5m', executionStyle, symbolOrIsCrypto);
}

/**
 * Evaluates open alerts against latest klines for each symbol.
 * Updates alert status (TP1_HIT, TP2_HIT, SL_HIT, TP1_BE_CLOSED, EXPIRED) and floating PnL.
 */
export function updateAlertsOutcome(
  alerts: AuditAlertItem[],
  klinesBySymbol: Record<string, Kline[]>,
  options: {
    /** Regular NYSE session is over: close intraday equity positions at the last price with friction. */
    squareOffIntraday?: boolean;
  } = {}
): AuditAlertItem[] {
  interface IndicatorContext {
    vwapSeries: number[];
    ema21Series: number[];
    ema9Series: number[];
    atrSeries: number[];
    candleIndexMap: Map<number, number>;
  }
  const indicatorCache = new Map<string, IndicatorContext>();

  return alerts.map(alert => {
    // If the alert is already closed in a terminal state, freeze its outcome and realized PnL
    if (alert.status === 'TP2_CLOSED' || alert.status === 'TP1_CLOSED' || alert.status === 'SL_HIT' || alert.status === 'TP1_BE_CLOSED' || alert.status === 'EXPIRED') {
      return alert;
    }
    const isVCME = alert.strategy?.includes('VCME') || alert.strategy?.includes('Multitemporal');

    // Timeframe identity is mandatory. A symbol-only fallback may be a different
    // interval after a failed fetch or a change between Day Trading and Swing.
    const key = `${alert.symbol}:${alert.interval}`;
    const symbolKlines = klinesBySymbol[key];
    if (!symbolKlines || symbolKlines.length === 0) {
      return { ...alert, dataWarning: `Seguimiento pendiente: faltan datos de ${alert.symbol} ${alert.interval}.` };
    }

    const latestCandle = symbolKlines[symbolKlines.length - 1];
    const latestPrice = latestCandle.close;
    const isBuy = alert.signal.includes('BUY');

    const durationSec = getIntervalDurationSec(alert.interval);

    // Evaluate closure against the snapshot's acquisition time, not cache-read
    // time. A pre-close cached snapshot remains provisional after the boundary.
    const snapshotTime = getKlineSnapshotTime(symbolKlines);

    // Reject out-of-order or stale snapshots older than the alert's last processed observation
    if (alert.executionState?.lastObservationMs !== undefined && snapshotTime < alert.executionState.lastObservationMs) {
      return alert;
    }

    const isCandleClosed = (k: Kline) => (k.time + durationSec) * 1000 <= snapshotTime;

    // Checkpoints saved before feeds were grid-normalized may sit on an off-grid live quote
    // (e.g. 09:37:28). Re-anchor them to the containing bar as still forming, otherwise that bar
    // sorts before the cursor, is skipped, and its close (and the time stop) is never observed.
    let executionState = alert.executionState;
    const savedCursor = executionState?.cursor;
    if (executionState && savedCursor && !executionState.exit) {
      for (let i = symbolKlines.length - 1; i >= 0; i--) {
        const k = symbolKlines[i];
        if (k.time > savedCursor.bar.time) continue;
        if (k.time !== savedCursor.bar.time && savedCursor.bar.time < k.time + durationSec) {
          executionState = { ...executionState, cursor: { bar: { ...savedCursor.bar, time: k.time }, closed: false } };
        }
        break;
      }
    }

    // Sanitized feeds are sorted. A persisted cursor needs only its own bar and
    // new bars; indicators below still use full history for stable warmup.
    let evaluationStart = 0;
    const cursorTime = executionState?.cursor?.bar.time;
    if (cursorTime !== undefined) {
      let end = symbolKlines.length;
      while (evaluationStart < end) {
        const mid = (evaluationStart + end) >>> 1;
        if (symbolKlines[mid].time < cursorTime) evaluationStart = mid + 1;
        else end = mid;
      }
    }
    let entryBarObservation = alert.entryBarObservation;
    const candlesToEvaluate = symbolKlines.slice(evaluationStart).filter(k => {
      const isAfterAlert = alert.candleTimestamp && alert.candleTimestamp > 0
        ? k.time > alert.candleTimestamp
        : (k.time + durationSec) * 1000 > alert.timestamp;

      return isAfterAlert;
    }).map(k => {
      const candleStartMs = k.time * 1000;
      // If the alert was fired inside this candle (entry occurred mid-candle):
      // The position cannot retroactively trigger on pre-alert extremes that happened before alert.timestamp.
      // On first observation, exclude unknown pre-entry extremes. Afterwards
      // an extension beyond the raw observed range is provably new information.
      if (candleStartMs <= alert.timestamp) {
        const prior = entryBarObservation?.time === k.time ? entryBarObservation : undefined;
        entryBarObservation = {
          time: k.time, high: Math.max(prior?.high ?? k.high, k.high),
          low: Math.min(prior?.low ?? k.low, k.low),
        };
        return {
          ...k,
          open: alert.entryPrice,
          high: Math.max(alert.entryPrice, k.close, prior && k.high > prior.high ? k.high : -Infinity),
          low: Math.min(alert.entryPrice, k.close, prior && k.low < prior.low ? k.low : Infinity),
        };
      }
      // Candles fully after the entry candle preserve authentic OHLC
      return k;
    });

    const isMultifractal = alert.strategy?.includes('Multifractal');
    const isMFLS = alert.strategy?.includes('MFLS') || alert.strategyKey === 'mfls';
    const isDayTrading = alert.interval === '5m' || alert.interval === '1m' || alert.interval === '3m';

    const maxExpiryCandles = getStrategyExpiryCandles(alert.strategyKey ?? alert.strategy, alert.interval, alert.executionStyle, alert.symbol);

    // Pre-calculate / retrieve memoized indicators for VCME exits
    const cacheKey = `${key}:${alert.executionStyle ?? 'dayTrading'}:${isVCME ? 'vcme' : 'basic'}`;
    let indCtx = indicatorCache.get(cacheKey);
    if (!indCtx) {
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
      if (isVCME) {
        for (let i = 0; i < symbolKlines.length; i++) {
          candleIndexMap.set(symbolKlines[i].time, i);
        }
      }

      indCtx = { vwapSeries, ema21Series, ema9Series, atrSeries, candleIndexMap };
      indicatorCache.set(cacheKey, indCtx);
    }

    const { vwapSeries, ema21Series, ema9Series, atrSeries, candleIndexMap } = indCtx;

    const entryCandle: Kline = {
      time: alert.candleTimestamp || (Math.floor(alert.timestamp / 1000) - durationSec),
      open: alert.entryPrice,
      high: alert.entryPrice,
      low: alert.entryPrice,
      close: alert.entryPrice,
      volume: 0
    };
    const evalKlines = [entryCandle, ...candlesToEvaluate];

    const mappedAtrSeries = isVCME ? evalKlines.map(k => {
      const fi = candleIndexMap.get(k.time);
      return fi !== undefined && atrSeries[fi] && !isNaN(atrSeries[fi]) && atrSeries[fi] > 0
        ? atrSeries[fi]
        : Math.abs(alert.entryPrice - alert.stopLoss) / 1.5;
    }) : undefined;

    const mappedEma9Series = isVCME ? evalKlines.map(k => {
      const fi = candleIndexMap.get(k.time);
      return fi !== undefined && ema9Series[fi] ? ema9Series[fi] : NaN;
    }) : undefined;

    const levels: TradeLevels = {
      entryPrice: alert.entryPrice,
      stopLoss: alert.stopLoss,
      takeProfit1: alert.takeProfit1,
      takeProfit2: alert.takeProfit2,
      takeProfit3: alert.takeProfit3
    };

    const isCrypto = isCryptoAsset(alert.symbol);
    const isSessionBased = !isCrypto;

    const intervalMs = durationSec * 1000;
    // For 24/7 continuous crypto markets, wall-clock time aligns 1:1 with candle duration.
    // For session-based equities, leave undefined so weekends and overnight gaps do not falsely expire trades.
    const maxExpiryTimestampMs = isCrypto ? alert.timestamp + maxExpiryCandles * intervalMs : undefined;

    const isSwingVCME = isVCME && (alert.executionStyle === 'swing' || alert.strategy?.includes('Swing'));
    // Without a floating quote the engine closes any remaining position at the last observed bar,
    // charging slippage and commission like any other market exit.
    const squareOff = !!options.squareOffIntraday && isSessionBased && isDayTrading && !isSwingVCME;

    const wasTp1 = alert.tp1Hit ?? (alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT');
    const wasTp2 = alert.tp2Hit ?? (alert.status === 'TP2_HIT');
    const tp1Time = alert.tp1Time ?? alert.partialFilledTime;
    const tp2Time = alert.tp2Time;

    const policy: ExitPolicy = {
      forwardWindow: maxExpiryCandles,
      enablePartials: isVCME ? 'vcme-runner' : (isMFLS ? 'two-tier' : false),
      moveSlToBreakevenOnTp1: true,
      timeStopBars: (isVCME && isDayTrading && !isSwingVCME) ? 18 : (isMFLS ? 16 : 0),
      timeStopMinR: isMFLS ? 0.4 : 0.5,
      earlyAdverseCutoffBars: (isMultifractal && isDayTrading) ? 3 : (isMFLS ? 3 : 0),
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
      sessionGapCutoff: isSessionBased && !isSwingVCME && (isDayTrading || alert.interval === '1h'),
      stepSec: durationSec,
      atrSeries: mappedAtrSeries,
      ema9Series: mappedEma9Series,
      frictionPct: DEFAULT_FRICTION_PCT,
      frictionModel: 'proportional',
      floatingClosePrice: squareOff ? undefined : latestPrice,
      maxExpiryTimestampMs,
      isCandleClosed,
      executionState,
      observedAtMs: snapshotTime,
      initialState: {
        tp1Hit: wasTp1,
        tp2Hit: wasTp2,
        tp1Time,
        tp2Time,
        activeSL: alert.activeSL,
        currentStatus: alert.status
      }
    };

    // Unexecuted overnight / weekend gap guard:
    // If an intraday session-based alert's first evaluated real candle is already on the other side
    // of an overnight/weekend gap, the order could not have been executed during regular market hours.
    // Close the alert cleanly as unexecuted (EXPIRED) with realizedR = 0, avoiding spurious -10R+ gap SL hits.
    const isFirstCandleAcrossSessionGap = policy.sessionGapCutoff
      && !wasTp1 && !wasTp2
      && candlesToEvaluate.length > 0
      && (candlesToEvaluate[0].time - entryCandle.time > durationSec * 3)
      && (!executionState?.cursor || executionState.cursor.bar.time <= entryCandle.time);

    if (isFirstCandleAcrossSessionGap) {
      return {
        ...alert,
        status: 'EXPIRED',
        realizedR: 0,
        pnlPercent: 0,
        tp1Hit: false,
        tp2Hit: false,
        entryBarObservation,
        dataWarning: undefined,
        executionWarning: 'Alerta no ejecutada: cruza gap de sesión o fin de semana fuera de horario.'
      };
    }

    const sim = simulateTrade(evalKlines, 0, isBuy ? 'BUY' : 'SELL', levels, policy);

    return {
      ...alert,
      status: sim.status,
      realizedR: sim.realizedR,
      pnlPercent: sim.pnlPct,
      tp1Hit: sim.tp1Hit,
      tp2Hit: sim.tp2Hit,
      tp1Time: sim.tp1Time ?? alert.tp1Time,
      tp2Time: sim.tp2Time ?? alert.tp2Time,
      activeSL: sim.activeSL,
      partialFilledTime: sim.tp1Time ?? alert.partialFilledTime,
      executionState: sim.executionState,
      entryBarObservation,
      dataWarning: undefined,
      executionWarning: sim.executionState.historyQuality === 'legacy'
        ? 'Estado antiguo: parciales importados; la cronología previa puede estar incompleta.'
        : squareOff && sim.executionState.exit?.reason === 'TIMEOUT'
          ? 'Posición intradía cerrada al cierre de sesión regular (16:00 ET).' : undefined
    };
  });
}

/**
 * Detects whether an alert is exploratory (i.e. emitted during FLAT/no-edge tournament states).
 */
export function isExploratoryAlert(alert: AuditAlertItem): boolean {
  return (
    alert.alertType === 'EXPLORATORY' ||
    Boolean(alert.strategy && alert.strategy.includes('(Exploratoria)')) ||
    alert.confidence === 'NONE'
  );
}

/**
 * Calculates session summary metrics for the header bar.
 * By default filters alerts for the current calendar day ("HOY").
 * Segregates exploratory ("sin ventaja") alerts from validated ones to preserve track-record integrity.
 */
export function calculateSessionStats(alerts: AuditAlertItem[], filterTodayOnly: boolean = true): SessionStats {
  const targetAlerts = filterTodayOnly
    ? alerts.filter(a => isAlertFromToday(a.timestamp))
    : alerts;

  if (targetAlerts.length === 0) {
    return { total: 0, wins: 0, losses: 0, openCount: 0, winRate: 0, totalR: 0, tpWins: 0, expWins: 0, slLosses: 0, expLosses: 0, byStrategy: {} };
  }

  let wins = 0;
  let losses = 0;
  let openCount = 0;
  let totalR = 0;
  let validatedCount = 0;
  let tpWins = 0;
  let expWins = 0;
  let slLosses = 0;
  let expLosses = 0;
  const byStrategy: Record<string, StrategyBreakdown> = {};

  let exploratoryWins = 0;
  let exploratoryLosses = 0;
  let exploratoryOpenCount = 0;
  let exploratoryTotalR = 0;
  let exploratoryTotal = 0;
  let exploratoryTpWins = 0;
  let exploratoryExpWins = 0;
  let exploratorySlLosses = 0;
  let exploratoryExpLosses = 0;

  const SCRATCH_BAND = 0.05;

  targetAlerts.forEach(alert => {
    const isExp = isExploratoryAlert(alert);
    const strat = alert.strategy || 'Standard';
    const isExpired = alert.status === 'EXPIRED';

    if (isExp) {
      exploratoryTotal++;
      if (alert.status === 'OPEN' || alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
        exploratoryOpenCount++;
      } else {
        if (alert.realizedR > SCRATCH_BAND) {
          exploratoryWins++;
          if (isExpired) {
            exploratoryExpWins++;
          } else {
            exploratoryTpWins++;
          }
        } else if (alert.realizedR < -SCRATCH_BAND) {
          exploratoryLosses++;
          if (isExpired) {
            exploratoryExpLosses++;
          } else {
            exploratorySlLosses++;
          }
        }
        exploratoryTotalR += alert.realizedR;
      }
    } else {
      validatedCount++;
      if (!byStrategy[strat]) {
        byStrategy[strat] = { wins: 0, losses: 0, openCount: 0, totalR: 0, tpWins: 0, expWins: 0, slLosses: 0, expLosses: 0 };
      }
      const stratObj = byStrategy[strat];

      if (alert.status === 'OPEN' || alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
        openCount++;
        stratObj.openCount++;
      } else {
        // Economic outcome: strictly determined by realized R, matching institutional backtest scratch band
        if (alert.realizedR > SCRATCH_BAND) {
          wins++;
          stratObj.wins++;
          if (isExpired) {
            expWins++;
            stratObj.expWins = (stratObj.expWins || 0) + 1;
          } else {
            tpWins++;
            stratObj.tpWins = (stratObj.tpWins || 0) + 1;
          }
        } else if (alert.realizedR < -SCRATCH_BAND) {
          losses++;
          stratObj.losses++;
          if (isExpired) {
            expLosses++;
            stratObj.expLosses = (stratObj.expLosses || 0) + 1;
          } else {
            slLosses++;
            stratObj.slLosses = (stratObj.slLosses || 0) + 1;
          }
        }
        totalR += alert.realizedR;
        stratObj.totalR += alert.realizedR;
      }
    }
  });

  Object.keys(byStrategy).forEach(key => {
    byStrategy[key].totalR = Number(byStrategy[key].totalR.toFixed(1));
  });

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Number(((wins / resolved) * 100).toFixed(1)) : 0;

  const expResolved = exploratoryWins + exploratoryLosses;
  const expWinRate = expResolved > 0 ? Number(((exploratoryWins / expResolved) * 100).toFixed(1)) : 0;

  return {
    total: validatedCount,
    wins,
    losses,
    openCount,
    winRate,
    totalR: Number(totalR.toFixed(1)),
    tpWins,
    expWins,
    slLosses,
    expLosses,
    byStrategy,
    ...(exploratoryTotal > 0 ? {
      exploratory: {
        total: exploratoryTotal,
        wins: exploratoryWins,
        losses: exploratoryLosses,
        openCount: exploratoryOpenCount,
        winRate: expWinRate,
        totalR: Number(exploratoryTotalR.toFixed(1)),
        tpWins: exploratoryTpWins,
        expWins: exploratoryExpWins,
        slLosses: exploratorySlLosses,
        expLosses: exploratoryExpLosses,
      }
    } : {})
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
  strategyKey?: string;
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
    strategyKey: entry.strategyKey,
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

/**
 * Trims alerts log to maxTotal entries while preserving all active/unresolved positions
 * ('OPEN', 'TP1_HIT', 'TP2_HIT') regardless of age, pruning only resolved/closed historical trades.
 */
export function trimAlertsPreservingActive(alerts: AuditAlertItem[], maxTotal: number = 100): AuditAlertItem[] {
  if (alerts.length <= maxTotal) return alerts;
  const activeStatuses = new Set<AlertStatus>(['OPEN', 'TP1_HIT', 'TP2_HIT']);
  const activeAlerts = alerts.filter(a => activeStatuses.has(a.status));
  const closedAlerts = alerts.filter(a => !activeStatuses.has(a.status));

  const remainingSlots = Math.max(0, maxTotal - activeAlerts.length);
  const trimmedClosed = closedAlerts.slice(0, remainingSlots);
  const keptIds = new Set([...activeAlerts.map(a => a.id), ...trimmedClosed.map(a => a.id)]);
  return alerts.filter(a => keptIds.has(a.id));
}

/** Canonical cooldown key generator for alerts */
export function getAlertCooldownKey(alert: Pick<AuditAlertItem, 'symbol' | 'interval' | 'alertType'>): string {
  return alert.alertType === 'EXPLORATORY'
    ? `${alert.symbol}-${alert.interval}-exploratory`
    : `${alert.symbol}-${alert.interval}`;
}

/**
 * Extracts the authentic exit timestamp in milliseconds from a closed alert.
 * Anchors the cooldown to the real candle time of the exit event rather than Date.now(),
 * eliminating spurious post-exit blocks when reopening the app after a disconnection.
 */
export function getAlertExitTimestampMs(alert: Pick<AuditAlertItem, 'executionState' | 'candleTimestamp' | 'timestamp'>): number {
  if (alert.executionState?.exit?.barTime) {
    return alert.executionState.exit.barTime * 1000;
  }
  if (alert.executionState?.cursor?.bar?.time) {
    return alert.executionState.cursor.bar.time * 1000;
  }
  if (alert.executionState?.lastObservationMs) {
    return alert.executionState.lastObservationMs;
  }
  if (alert.candleTimestamp && alert.candleTimestamp > 0) {
    return alert.candleTimestamp * 1000;
  }
  return alert.timestamp || Date.now();
}

/**
 * Detects alerts that have transitioned from an active unresolved state
 * ('OPEN', 'TP1_HIT', 'TP2_HIT') to a terminal closed state
 * ('SL_HIT', 'TP1_CLOSED', 'TP2_CLOSED', 'TP1_BE_CLOSED', 'EXPIRED', etc.).
 * Used to synchronously trigger post-exit cooldowns across all update pathways.
 */
export function detectClosedAlertTransitions(
  prevAlerts: AuditAlertItem[],
  updatedAlerts: AuditAlertItem[] | Map<string, AuditAlertItem>
): AuditAlertItem[] {
  const activeStatuses = new Set<AlertStatus>(['OPEN', 'TP1_HIT', 'TP2_HIT']);
  const updatesMap = updatedAlerts instanceof Map
    ? updatedAlerts
    : new Map(updatedAlerts.map(a => [a.id, a]));

  const newlyClosed: AuditAlertItem[] = [];
  for (const prev of prevAlerts) {
    if (activeStatuses.has(prev.status)) {
      const next = updatesMap.get(prev.id);
      if (next && !activeStatuses.has(next.status)) {
        newlyClosed.push(next);
      }
    }
  }
  return newlyClosed;
}
