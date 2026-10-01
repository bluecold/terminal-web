import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import './App.css';
import { Search, LayoutGrid, LineChart } from 'lucide-react';
import Chart from './components/Chart';
import Watchlist from './components/Watchlist';
import SignalPanel from './components/SignalPanel';
import MarketRadar from './components/MarketRadar';
import { fetchKlines, fetchEarningsDate } from './services/api';
import MarketTicker from './components/MarketTicker';
import HelpModal from './components/HelpModal';
import AlertReportModal from './components/AlertReportModal';
import type { Kline } from './services/api';
import { calculateStandardVoting, calculateExperimentalSignal, calculateScoringSignal, calculateVCMESniperSignal, calculateMultifractalMTFSignal, calculateMFLSSignal, getConfirmedClosedKlines, getEffectiveExecutionPrice, isNyseTradingSessionActive, DEFAULT_WEIGHTS, type ScoringWeights } from './utils/indicators';
import { resolveOperationalTrade } from './utils/operationalTrade';
import { isCryptoAsset } from './utils/tradeLevels';
import { runQVESelection, selectActionableStrategy, buildStrategyCandidateQueue, resolveCandidateCascade, resolveStandardExploratoryFallback } from './utils/tournament';
import { evaluateAlertEmission } from './utils/alertEmission';
import { APP_VERSION } from './version';
import { getMsUntilNextAlignedScan } from './utils/scanSchedule';
import { computeAlertLatencySec, computeExecutionCostR, loadAlertArchive, mergeIntoAlertArchive, saveAlertArchive, type ArchivedAlert } from './utils/alertReport';
import {
  updateAlertsOutcome,
  calculateSessionStats,
  isCandleAlertFired,
  registerFiredCandleAlert,
  pruneFiredAlertsRegistry,
  clearFiredAlertsRegistry,
  generateCandleAlertKey,
  trimAlertsPreservingActive,
  detectClosedAlertTransitions,
  getAlertCooldownKey,
  getAlertExitTimestampMs,
  type AuditAlertItem
} from './utils/alertTracker';
import {
  type LiveDiscardReason,
  type LiveDiscardStats,
  DISCARD_REASON_LABELS,
  loadDiscardStats,
  createInitialDiscardStats,
  recordDiscardEvent,
  clearDiscardStats,
} from './utils/liveDiscards';
import { formatSmartPrice } from './utils/formatters';
import type { AlertOverlay } from './components/Chart';
import type { AlertCooldownRecord } from './utils/radarFilters';

function loadSavedAlertCooldowns(): Record<string, number | AlertCooldownRecord> {
  try {
    const saved = localStorage.getItem('terminal_alert_cooldowns');
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.error('Error parsing alert cooldowns from local storage', e);
  }
  return {};
}

function App() {
  const [alertsLog, setAlertsLog] = useState<AuditAlertItem[]>(() => {
    const saved = localStorage.getItem('terminal_alerts_log');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          return parsed.filter(item => item && (
            item.status === 'OPEN' || item.status === 'TP1_HIT' || item.status === 'TP2_HIT' ||
            (typeof item.timestamp === 'number' && item.timestamp > sevenDaysAgo)
          ));
        }
      } catch (e) {
        console.error('Error parsing alerts log from local storage', e);
      }
    }
    return [];
  });
  const [selectedAlertOverlay, setSelectedAlertOverlay] = useState<AlertOverlay | null>(null);
  const alertsLogRef = useRef<AuditAlertItem[]>(alertsLog);
  useEffect(() => {
    alertsLogRef.current = alertsLog;
  }, [alertsLog]);

  // Resolved alerts are archived (90 days) for the performance report, independent of the
  // 100-entry / 7-day live log and of the LIMPIAR button.
  useEffect(() => {
    saveAlertArchive(mergeIntoAlertArchive(loadAlertArchive(), alertsLog));
  }, [alertsLog]);

  const recordUserFill = useCallback((alertId: string, price: number | undefined) => {
    setAlertsLog(prev => {
      const next = prev.map(a => a.id === alertId
        ? { ...a, userFillPrice: price, userFillTime: price !== undefined ? Date.now() : undefined }
        : a);
      try {
        localStorage.setItem('terminal_alerts_log', JSON.stringify(next));
      } catch (e) {
        console.error('Error saving terminal_alerts_log to local storage', e);
      }
      return next;
    });
  }, []);

  const openAlertReport = () => {
    setReportAlerts(mergeIntoAlertArchive(loadAlertArchive(), alertsLogRef.current));
  };

  const toggleInformationalAlerts = () => {
    setLogInformationalAlerts(prev => {
      localStorage.setItem('terminal_exploratory_alerts', prev ? 'false' : 'true');
      return !prev;
    });
  };

  const [discardStats, setDiscardStats] = useState<LiveDiscardStats>(() => loadDiscardStats());
  const seenDiscardKeysRef = useRef<Set<string>>(new Set());
  const discardStatsRef = useRef<LiveDiscardStats>(discardStats);
  useEffect(() => {
    discardStatsRef.current = discardStats;
  }, [discardStats]);

  const recordDiscard = (symbol: string, interval: string, candleTimestamp: number, reason: LiveDiscardReason) => {
    const res = recordDiscardEvent(discardStatsRef.current, seenDiscardKeysRef.current, symbol, interval, candleTimestamp, reason);
    if (res.recorded) {
      discardStatsRef.current = res.stats;
      setDiscardStats(res.stats);
    }
  };

  // Cooldown for notifications/logging per symbol and timeframe (persisted in localStorage)
  const alertCooldownsRef = useRef<Record<string, number | AlertCooldownRecord>>(loadSavedAlertCooldowns());
  const [alertCooldowns, setAlertCooldownsState] = useState<Record<string, number | AlertCooldownRecord>>(loadSavedAlertCooldowns);

  const setAlertCooldown = useCallback((key: string, timestamp: number, outcome?: 'SL' | 'TP' | 'TIMEOUT' | 'ENTRY' | string) => {
    alertCooldownsRef.current[key] = { timestamp, outcome };
    try {
      localStorage.setItem('terminal_alert_cooldowns', JSON.stringify(alertCooldownsRef.current));
    } catch (e) {
      console.error('Error saving alert cooldowns to local storage', e);
    }
    setAlertCooldownsState({ ...alertCooldownsRef.current });
  }, []);

  /**
   * Centralized alert outcome evaluator and post-exit cooldown synchronizer.
   * Ensures that any transition from active ('OPEN', 'TP1_HIT', 'TP2_HIT') to terminal
   * ('SL_HIT', 'TP1_BE_CLOSED', 'TP3_HIT', etc.) triggers post-exit cooldown immediately,
   * regardless of whether it was triggered by asset loading, symbol scan, or the global loop.
   * Anchors cooldown start to the authentic candle exit timestamp (getAlertExitTimestampMs)
   * eliminating artificial lockout after browser/app reconnections.
   */
  const syncAlertOutcomesAndCooldowns = useCallback((
    prevAlerts: AuditAlertItem[],
    klinesMap: Record<string, Kline[]>,
    targetSymbol?: string
  ): AuditAlertItem[] => {
    const toUpdate = targetSymbol
      ? prevAlerts.filter(a => a.symbol === targetSymbol)
      : prevAlerts;
    const updates = new Map(updateAlertsOutcome(toUpdate, klinesMap).map(a => [a.id, a]));
    const updated = trimAlertsPreservingActive(prevAlerts.map(a => updates.get(a.id) ?? a), 100);

    const newlyClosed = detectClosedAlertTransitions(prevAlerts, updates);
    if (newlyClosed.length > 0) {
      newlyClosed.forEach(closed => {
        const exitKey = getAlertCooldownKey(closed);
        const exitTimestamp = getAlertExitTimestampMs(closed);
        const isLoss = closed.status === 'SL_HIT' || closed.realizedR < -0.05;
        const isTimeout = closed.status === 'EXPIRED' || closed.executionState?.exit?.reason === 'TIMEOUT';
        const outcome = isLoss ? 'SL' : isTimeout ? 'TIMEOUT' : 'TP';
        setAlertCooldown(exitKey, exitTimestamp, outcome);
      });
    }

    // In live day trading on session-based equities:
    // If the regular NYSE trading session is closed for the day (!isNyseTradingSessionActive(Date.now()))
    // and an alert is an intraday day trading equity position still marked OPEN or TP1_HIT:
    // square it off cleanly as EXPIRED so that positions never remain open overnight or over the weekend.
    const isNyseActive = isNyseTradingSessionActive(Date.now());
    const finalAlerts = isNyseActive
      ? updated
      : updated.map(alert => {
          const isCrypto = isCryptoAsset(alert.symbol);
          const isDayTrade = alert.interval === '5m' || alert.interval === '1m' || alert.interval === '3m';
          const isSwingVCME = (alert.strategyKey === 'multitemporal' || alert.strategy?.includes('VCME')) && alert.executionStyle === 'swing';
          if (!isCrypto && isDayTrade && !isSwingVCME && (alert.status === 'OPEN' || alert.status === 'TP1_HIT')) {
            return {
              ...alert,
              status: 'EXPIRED' as const,
              executionWarning: 'Posición intradía cerrada al cierre de sesión regular (16:00 ET).'
            };
          }
          return alert;
        });

    try {
      localStorage.setItem('terminal_alerts_log', JSON.stringify(finalAlerts));
    } catch (e) {
      console.error('Error saving terminal_alerts_log to local storage', e);
    }

    return finalAlerts;
  }, [setAlertCooldown]);

  const [mainView, setMainView] = useState<'chart' | 'radar'>('chart');
  const [currentAsset, setCurrentAsset] = useState(() => {
    return localStorage.getItem('terminal_current_asset') || 'BTCUSDT';
  });
  const [searchVal, setSearchVal] = useState(currentAsset);

  const activeSignals = useMemo(() => {
    const map: Record<string, string> = {};
    alertsLog.forEach(alert => {
      if (alert.status === 'OPEN' || alert.status === 'TP1_HIT' || alert.status === 'TP2_HIT') {
        map[alert.symbol] = alert.signal;
      }
    });
    return map;
  }, [alertsLog]);
  
  // Sync search input when currentAsset changes from external sources (e.g. watchlist click)
  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync of controlled input */
  useEffect(() => {
    setSearchVal(currentAsset);
  }, [currentAsset]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const [interval, setTimeInterval] = useState(() => {
    return localStorage.getItem('terminal_time_interval') || '1h';
  });
  const [showBB, setShowBB] = useState(() => {
    return localStorage.getItem('terminal_show_bb') === 'true';
  });
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>(() => {
    const saved = localStorage.getItem('terminal_watchlist');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.sort((a, b) => a.localeCompare(b));
        }
      } catch (e) {
        console.error('Error parsing watchlist from local storage', e);
      }
    }
    return ['BTCUSDT', 'ETHUSDT', 'TSLA', 'MSFT', 'HUT', 'SATL'].sort((a, b) => a.localeCompare(b));
  });
  const [klines, setKlines] = useState<Kline[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [reportAlerts, setReportAlerts] = useState<ArchivedAlert[] | null>(null);
  // Opt-in logging of informational/exploratory signals (tracked separately, never notified unless
  // 'terminal_exploratory_notifications' is also enabled).
  const [logInformationalAlerts, setLogInformationalAlerts] = useState(() => localStorage.getItem('terminal_exploratory_alerts') === 'true');

  const [executionStyle, setExecutionStyle] = useState<'dayTrading' | 'swing'>(() => {
    return (localStorage.getItem('terminal_execution_style') as 'dayTrading' | 'swing') || 'dayTrading';
  });
  const [triggerMode, setTriggerMode] = useState<'agresivo' | 'conservador'>(() => {
    return (localStorage.getItem('terminal_trigger_mode') as 'agresivo' | 'conservador') || 'agresivo';
  });

  useEffect(() => {
    localStorage.setItem('terminal_execution_style', executionStyle);
  }, [executionStyle]);

  useEffect(() => {
    localStorage.setItem('terminal_trigger_mode', triggerMode);
  }, [triggerMode]);

  // Global custom scoring weights with persistent localStorage sync
  const [scoringWeights, setScoringWeights] = useState<ScoringWeights>(() => {
    try {
      const saved = localStorage.getItem('terminal_scoring_weights');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // ignore JSON parse error
    }
    return DEFAULT_WEIGHTS;
  });

  useEffect(() => {
    try {
      localStorage.setItem('terminal_scoring_weights', JSON.stringify(scoringWeights));
    } catch {
      // ignore
    }
  }, [scoringWeights]);

  // Prune expired fired alerts registry entries on mount (older than 7 days)
  useEffect(() => {
    pruneFiredAlertsRegistry(7);
  }, []);

  // ── Confluence Matrix & Earnings Events States ───────────────────────────
  const [confluenceSignals, setConfluenceSignals] = useState<Record<string, string>>({ '5m': '...', '1h': '...', '1d': '...' });
  const [allKlines, setAllKlines] = useState<Record<string, Kline[]>>({ '5m': [], '1h': [], '1d': [] });
  const [earningsDate, setEarningsDate] = useState<number | null>(null);

  const computeOverallSignal = (data: Kline[], tf: string, allData?: Record<string, Kline[]>): string => {
    if (data.length < 35) return 'WAITING...';

    const data5m = allData ? (allData['5m'] || []) : (tf === '5m' ? data : []);
    const data1h = allData ? (allData['1h'] || []) : (tf === '1h' ? data : []);
    const data1d = allData ? (allData['1d'] || []) : (tf === '1d' ? data : []);

    const qve = runQVESelection({
      symbol: currentAsset,
      data5m,
      data1h,
      data1d,
      executionStyle,
      triggerMode,
      targetInterval: tf,
      scoringWeights,
    });

    const triggerKlines = allData ? qve.triggerKlines : data;
    const raw5m = allData ? (allData['5m'] || []) : (tf === '5m' ? data : []);
    const triggerRaw = allData
      ? (executionStyle === 'swing' ? (allData['1h'] || []) : raw5m)
      : data;
    const triggerEntryPrice = getEffectiveExecutionPrice(triggerRaw, triggerKlines);
    const mfEntryPrice = getEffectiveExecutionPrice(raw5m, qve.closed5m);
    const actionable = selectActionableStrategy(qve, {
      standard: calculateStandardVoting(triggerKlines).signal,
      confluencia: calculateExperimentalSignal(triggerKlines, qve.targetInterval, currentAsset).signal,
      scoring: calculateScoringSignal(triggerKlines, qve.targetInterval, scoringWeights, triggerEntryPrice, currentAsset).signal,
      multitemporal: allData
        ? calculateVCMESniperSignal(triggerKlines, qve.closed1h, qve.closed1d, currentAsset, qve.btMulti.winRate, qve.btMulti.profitFactor, executionStyle, triggerMode, triggerEntryPrice).signal
        : 'NEUTRAL',
      multifractal: allData
        ? calculateMultifractalMTFSignal(qve.closed5m, qve.closed1h, qve.closed1d, currentAsset, mfEntryPrice).signal
        : 'NEUTRAL',
      mfls: allData
        ? calculateMFLSSignal(qve.closed5m, currentAsset, mfEntryPrice).signal
        : 'NEUTRAL',
    });

    if (actionable.signal !== 'NEUTRAL') {
      return actionable.signal;
    }
    const stdFallback = calculateStandardVoting(triggerKlines).signal;
    return resolveStandardExploratoryFallback(qve, stdFallback);
  };

  const sessionStats = useMemo(() => calculateSessionStats(alertsLog), [alertsLog]);

  // 1. Effect to load all timeframe data and earnings date on asset change
  useEffect(() => {
    let isMounted = true;
    
    const loadExtraData = async () => {
      setLoading(true);
      setConfluenceSignals({ '5m': '...', '1h': '...', '1d': '...' });
      setEarningsDate(null);
      setAllKlines({ '5m': [], '1h': [], '1d': [] });

      if (!isCryptoAsset(currentAsset)) {
        fetchEarningsDate(currentAsset).then(date => {
          if (isMounted) setEarningsDate(date);
        });
      }

      const timeframes = ['5m', '1h', '1d'];
      const fetchedKlines: Record<string, Kline[]> = {};

      await Promise.all(timeframes.map(async (tf) => {
        try {
          const data = await fetchKlines(currentAsset, tf);
          fetchedKlines[tf] = data;
        } catch (e) {
          console.error(`Error fetching klines for ${tf}`, e);
          fetchedKlines[tf] = [];
        }
      }));

      if (!isMounted) return;

      setAllKlines(fetchedKlines);
      if (fetchedKlines[interval]) {
        setKlines(fetchedKlines[interval]);
      }
      setLoading(false);

      // Update outcome for any open alerts using newly loaded klines with exact timeframe mapping
      const klinesMap: Record<string, Kline[]> = {
        [`${currentAsset}:${interval}`]: fetchedKlines[interval] || [],
      };
      timeframes.forEach((tf) => {
        if (fetchedKlines[tf] && fetchedKlines[tf].length > 0) {
          klinesMap[`${currentAsset}:${tf}`] = fetchedKlines[tf];
        }
      });
      setAlertsLog(prev => syncAlertOutcomesAndCooldowns(prev, klinesMap, currentAsset));

      timeframes.forEach((tf) => {
        const data = fetchedKlines[tf] || [];
        if (data.length >= 35) {
          const closedData = getConfirmedClosedKlines(data, tf, currentAsset);
          const signal = computeOverallSignal(closedData, tf, fetchedKlines);
          setConfluenceSignals(prev => ({ ...prev, [tf]: signal }));
        } else {
          setConfluenceSignals(prev => ({ ...prev, [tf]: 'SIN DATOS' }));
        }
      });
    };

    loadExtraData();

    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- computeOverallSignal is stable (reads state via closures), adding it would cause infinite loops
  }, [currentAsset]);

  // 2. Effect to change active timeframe from memory (no network request!)
  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync: klines is also updated by polling, cannot be derived with useMemo */
  useEffect(() => {
    if (allKlines[interval] && allKlines[interval].length > 0) {
      setKlines(allKlines[interval]);
    }
  }, [interval, allKlines]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 3. Effect for real-time polling updates only on the active asset + interval
  useEffect(() => {
    let isMounted = true;

    const pollInterval = setInterval(async () => {
      try {
        const data = await fetchKlines(currentAsset, interval);
        if (isMounted) {
          setKlines(data);
          // Fix #5: use the functional form of setAllKlines so that `prev` is always
          // the current state, not the stale closure value captured when the effect ran.
          // This prevents computing the confluence signal with outdated 1h/1d klines.
          setAllKlines(prev => {
            const updatedAllKlines = { ...prev, [interval]: data };
            if (data.length >= 35) {
              const closedData = getConfirmedClosedKlines(data, interval, currentAsset);
              const signal = computeOverallSignal(closedData, interval, updatedAllKlines);
              setConfluenceSignals(cs => ({ ...cs, [interval]: signal }));
            }
            return updatedAllKlines;
          });
        }
      } catch (e) {
        console.error('Error auto-updating active chart data', e);
      }
    }, 60000);

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- computeOverallSignal is intentionally excluded (stable function, would cause loops)
  }, [currentAsset, interval]);

  useEffect(() => {
    if (klines.length >= 35) {
      const closedData = getConfirmedClosedKlines(klines, interval, currentAsset);
      const signal = computeOverallSignal(closedData, interval, allKlines);
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- intentional re-evaluation on mode toggle */
      setConfluenceSignals(cs => ({ ...cs, [interval]: signal }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- computeOverallSignal and klines are intentionally managed to avoid cascading updates
  }, [executionStyle, triggerMode]);



  useEffect(() => {
    localStorage.setItem('terminal_watchlist', JSON.stringify(watchlistSymbols));
  }, [watchlistSymbols]);

  useEffect(() => {
    localStorage.setItem('terminal_current_asset', currentAsset);
  }, [currentAsset]);

  useEffect(() => {
    localStorage.setItem('terminal_time_interval', interval);
  }, [interval]);

  useEffect(() => {
    localStorage.setItem('terminal_show_bb', showBB ? 'true' : 'false');
  }, [showBB]);

  // ── Browser Notifications & Watchlist Background Scanner ─────────────────
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    return localStorage.getItem('terminal_notifications_enabled') === 'true';
  });

  const toggleNotifications = async () => {
    if (!notificationsEnabled) {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          setNotificationsEnabled(true);
          localStorage.setItem('terminal_notifications_enabled', 'true');
          new Notification("🔔 Alertas de Watchlist Activas", {
            body: `Recibirás alertas en segundo plano cuando cambien las señales en ${interval.toUpperCase()}.`,
          });
        } else {
          alert('Permiso de notificación denegado. Habilítalo en los ajustes del navegador.');
        }
      } else {
        alert('Este navegador no soporta notificaciones de escritorio.');
      }
    } else {
      setNotificationsEnabled(false);
      localStorage.setItem('terminal_notifications_enabled', 'false');
    }
  };

  // Keep track of the last known signals for all scanned symbols (watchlist + active)
  const lastSignalsRef = useRef<Record<string, string>>({});


  // Timestamp of the last completed scanner run (task #4)
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);

  // Avoid overlapping scans when a full watchlist pass takes longer than the
  // scheduler interval, and keep network concurrency below provider limits.
  const scannerRunningRef = useRef(false);
  // A scan requested while another is running is replayed right after it, so a candle close
  // is never skipped until the next minute.
  const scanPendingRef = useRef(false);
  const maxConcurrentSymbolScans = 4;

  useEffect(() => {
    let isMounted = true;

    const checkAllSignals = async () => {
      if (scannerRunningRef.current) {
        scanPendingRef.current = true;
        return;
      }

      scannerRunningRef.current = true;
      try {
      const activeAlertSymbols = alertsLogRef.current
        .filter(a => a.status === 'OPEN' || a.status === 'TP1_HIT' || a.status === 'TP2_HIT')
        .map(a => a.symbol);
      const symbolsToScan = Array.from(new Set([...watchlistSymbols, currentAsset, ...activeAlertSymbols]));
      const scannedKlinesMap: Record<string, Kline[]> = {};

      for (let batchStart = 0; batchStart < symbolsToScan.length; batchStart += maxConcurrentSymbolScans) {
        const batch = symbolsToScan.slice(batchStart, batchStart + maxConcurrentSymbolScans);
        await Promise.all(batch.map(async (symbol) => {
        try {
          // MTF engines always require their native 5m, 1h and 1d inputs.
          // The active chart timeframe is fetched too when it is distinct.
          const trackedIntervals = alertsLogRef.current
            .filter(a => a.symbol === symbol && (a.status === 'OPEN' || a.status === 'TP1_HIT' || a.status === 'TP2_HIT'))
            .map(a => a.interval);
          const requestedTimeframes = Array.from(new Set([interval, '5m', '1h', '1d', ...trackedIntervals]));
          const responses = await Promise.all(requestedTimeframes.map(async (timeframe) => [
            timeframe,
            await fetchKlines(symbol, timeframe)
          ] as const));
          const dataByTimeframe = Object.fromEntries(responses) as Record<string, Kline[]>;
          const data5m = dataByTimeframe['5m'] || [];
          const data1h = dataByTimeframe['1h'] || [];
          const data1d = dataByTimeframe['1d'] || [];

          const activeHorizon = executionStyle === 'swing' ? '1h' : '5m';
          const scanTargetKlines = activeHorizon === '1h' ? data1h : data5m;

          if (!isMounted) return;
          for (const [timeframe, candles] of responses) {
            if (candles.length > 0) scannedKlinesMap[`${symbol}:${timeframe}`] = candles;
          }
          if (scanTargetKlines.length < 35) return;

          // ── Determine best strategy using QVE (backed by fast FNV-1a backtest caching) ──
          const now = Date.now();
          const isCrypto = isCryptoAsset(symbol);
          const qve = runQVESelection({
            symbol,
            data5m,
            data1h,
            data1d,
            executionStyle,
            triggerMode,
            scoringWeights,
          });

          let bestStrategy = qve.bestStrategy;
          let strategyLabel = qve.strategyLabel;
          let bestPF = qve.profitFactor;
          let bestConfidence = qve.confidence;
          const btMulti = qve.btMulti;

          // ── Calculate signals using each engine's authentic native timeframe & data ──
          const closed5m = getConfirmedClosedKlines(data5m, '5m', symbol);
          const closed1h = getConfirmedClosedKlines(data1h, '1h', symbol);
          const closed1d = getConfirmedClosedKlines(data1d, '1d', symbol);

          const entryPrice5m = getEffectiveExecutionPrice(data5m, closed5m);
          const entryPrice1h = getEffectiveExecutionPrice(data1h, closed1h);

          // Native horizon routing
          const vcmeHorizon = executionStyle === 'swing' ? '1h' : '5m';
          const vcmeClosedKlines = vcmeHorizon === '1h' ? closed1h : closed5m;
          const vcmeEntryPrice = vcmeHorizon === '1h' ? entryPrice1h : entryPrice5m;

          const genericHorizon = activeHorizon; // '1h' for swing, '5m' for dayTrading
          const genericClosedKlines = genericHorizon === '1h' ? closed1h : closed5m;

          // 1. Evaluate Multifractal (strictly native 5m execution with 1H and 1D context)
          const allMfResult = calculateMultifractalMTFSignal(
            closed5m,
            closed1h,
            closed1d,
            symbol,
            entryPrice5m
          );

          // 2. Evaluate MFLS (strictly native 5m execution)
          const allMflsResult = calculateMFLSSignal(
            closed5m,
            symbol,
            entryPrice5m
          );

          // 3. Evaluate VCME Sniper on its native horizon
          const allVcmeResult = calculateVCMESniperSignal(
            vcmeClosedKlines,
            closed1h,
            closed1d,
            symbol,
            btMulti.winRate,
            btMulti.profitFactor,
            executionStyle,
            triggerMode,
            vcmeEntryPrice
          );

          // 4. Evaluate Generic strategies on their native activeHorizon
          const standardResult = calculateStandardVoting(genericClosedKlines);
          const confluenciaResult = calculateExperimentalSignal(genericClosedKlines, genericHorizon, isCrypto);
          const scoringResult = calculateScoringSignal(genericClosedKlines, genericHorizon, scoringWeights, isCrypto);

          // 5. Multi-Strategy Actionable Selection & Cascade (shared with MarketRadar and SignalPanel)
          const strategySignals = {
            standard: standardResult.signal,
            confluencia: confluenciaResult.signal,
            scoring: scoringResult.signal,
            multitemporal: allVcmeResult.signal,
            multifractal: allMfResult.signal,
            mfls: allMflsResult.signal,
          };
          const candidateQueue = buildStrategyCandidateQueue(qve, strategySignals);

          // Iterate through candidates in strict order of statistical priority. A candidate that fails
          // operational viability (friction > 0.35R, inverted geometry, no room to S/R) is recorded as a
          // telemetry discard and the cascade moves on to the next one.
          const cascade = resolveCandidateCascade(candidateQueue, candidate => resolveOperationalTrade({
            strategy: candidate.strategy,
            signal: candidate.signal,
            executionStyle,
            raw: { '5m': data5m, '1h': data1h },
            closed: { '5m': closed5m, '1h': closed1h },
            vcme: allVcmeResult,
            multifractal: allMfResult,
            mfls: allMflsResult,
            isCrypto,
          }));
          for (const { plan } of cascade.rejected) {
            const trigger = plan.signalKlines.length > 0 ? plan.signalKlines[plan.signalKlines.length - 1] : null;
            recordDiscard(symbol, plan.interval, trigger ? trigger.time : 0, !plan.validGeometry ? 'geometry' : 'friction');
          }

          if (!cascade.viable) {
            // No operationally viable strategy found across all candidates
            const defaultActionable = selectActionableStrategy(qve, strategySignals);
            bestStrategy = 'NONE';
            strategyLabel = defaultActionable.strategyLabel;
            bestPF = null;
            bestConfidence = 'NONE';
            const defaultInterval = executionStyle === 'dayTrading' ? '5m' : '1h';
            lastSignalsRef.current[`${symbol}-${defaultInterval}`] = 'NEUTRAL';
            return;
          }

          const viableCandidate = cascade.viable.candidate;
          const tradePlan = cascade.viable.plan;
          bestStrategy = viableCandidate.strategy;
          strategyLabel = viableCandidate.strategyLabel;
          bestPF = viableCandidate.profitFactor;
          bestConfidence = viableCandidate.confidence;
          const overallSignal = viableCandidate.signal;
          const signalConfidence = bestStrategy === 'multitemporal' ? allVcmeResult.confidence : '';
          const { interval: signalInterval, signalKlines, entryPrice, levels } = tradePlan;
          const signalKey = `${symbol}-${signalInterval}`;

          // Identify closed trigger candle timestamp for persistent atomic deduplication & telemetry
          const triggerCandle = signalKlines.length > 0 ? signalKlines[signalKlines.length - 1] : null;
          const candleTimestamp = triggerCandle ? triggerCandle.time : 0;

          // Emission gates (shared pure logic): exploratory opt-in, open position, NYSE session,
          // session-closing candle, atomic candle deduplication and persistent cooldown.
          const emission = evaluateAlertEmission({
            symbol,
            interval: signalInterval,
            signal: overallSignal,
            strategyKey: bestStrategy,
            strategyLabel,
            confidence: bestConfidence,
            executionStyle,
            isCrypto,
            candleTimestamp,
            nowMs: now,
            validGeometry: tradePlan.valid,
            allowExploratoryAlerts: localStorage.getItem('terminal_exploratory_alerts') === 'true'
              || localStorage.getItem('terminal_exploratory_notifications') === 'true',
            activeAlerts: alertsLogRef.current,
            alreadyFiredForCandle: candleTimestamp > 0 && isCandleAlertFired(symbol, signalInterval, candleTimestamp, strategyLabel, overallSignal),
            cooldowns: alertCooldownsRef.current,
          });
          emission.discards.forEach(reason => recordDiscard(symbol, signalInterval, candleTimestamp, reason));
          const isExploratoryAlert = emission.isExploratory;
          const cooldownKey = getAlertCooldownKey({ symbol, interval: signalInterval, alertType: isExploratoryAlert ? 'EXPLORATORY' : 'PRIMARY' });

          if (emission.emit) {
            // Set alert cooldown timestamp with persistence
            setAlertCooldown(cooldownKey, now, 'ENTRY');

              const desktopNotificationsEnabled = localStorage.getItem('terminal_notifications_enabled') === 'true'
                && ('Notification' in window) && Notification.permission === 'granted';

              // Logging exploratory/informational alerts and notifying them are separate opt-ins
              const allowExploratoryNotifications = localStorage.getItem('terminal_exploratory_notifications') === 'true';

              if (desktopNotificationsEnabled && (!isExploratoryAlert || allowExploratoryNotifications)) {
                const confidenceTag = isExploratoryAlert
                  ? ' 🔬 [Exploratoria / Sin Ventaja]'
                  : bestConfidence === 'LIMITED'
                    ? ' ⚠️ [Muestra Limitada]'
                    : ' 🎯 [Validada]';
                const confidenceString = bestStrategy === 'multitemporal' && signalConfidence ? ` [Confianza: ${signalConfidence}]` : '';

                const hasDistinctTP2 = levels.takeProfit2 !== undefined && levels.takeProfit2 !== levels.takeProfit1;
                const levelInfo = hasDistinctTP2
                  ? `Entry: ${formatSmartPrice(entryPrice)} | SL: ${formatSmartPrice(levels.stopLoss)} | TP1: ${formatSmartPrice(levels.takeProfit1)} | TP2: ${formatSmartPrice(levels.takeProfit2)}`
                  : `Entry: ${formatSmartPrice(entryPrice)} | SL: ${formatSmartPrice(levels.stopLoss)} | TP: ${formatSmartPrice(levels.takeProfit1)} (+1.5R)`;

                const pfNotice = bestPF !== null ? `PF ${bestPF.toFixed(1)}` : 'PF N/D';
                const notifTitle = isExploratoryAlert
                  ? `🔬 Exploratoria en ${symbol} (${signalInterval.toUpperCase()})${confidenceTag}`
                  : `🚨 Señal en ${symbol} (${signalInterval.toUpperCase()})${confidenceTag}${confidenceString}`;

                new Notification(notifTitle, {
                  body: `${overallSignal} · vía ${strategyLabel} (${pfNotice})\n${levelInfo}`,
                  tag: `${symbol}-${signalInterval}`,
                });
              }

            const timeString = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const dedupKey = candleTimestamp > 0
              ? generateCandleAlertKey(symbol, signalInterval, candleTimestamp, strategyLabel, overallSignal)
              : `${symbol}-${signalInterval}-${now}`;

            const newAlert: AuditAlertItem = {
              id: `${symbol}-${signalInterval}-${Date.now()}`,
              symbol,
              interval: signalInterval,
              signal: overallSignal,
              time: timeString,
              pf: bestPF,
              strategy: strategyLabel,
              strategyKey: bestStrategy,
              executionStyle,
              confidence: bestConfidence,
              entryPrice,
              stopLoss: levels.stopLoss,
              takeProfit1: levels.takeProfit1,
              takeProfit2: levels.takeProfit2,
              takeProfit3: levels.takeProfit3,
              status: 'OPEN',
              realizedR: 0,
              pnlPercent: 0,
              timestamp: now,
              candleTimestamp: candleTimestamp > 0 ? candleTimestamp : undefined,
              dedupKey,
              alertType: isExploratoryAlert ? 'EXPLORATORY' : 'PRIMARY',
              alertLatencySec: computeAlertLatencySec(candleTimestamp, signalInterval, now),
            };

            // Register in persistent atomic deduplication registry
            if (candleTimestamp > 0) {
              registerFiredCandleAlert({
                symbol,
                interval: signalInterval,
                candleTimestamp,
                strategy: strategyLabel,
                strategyKey: bestStrategy,
                signal: overallSignal,
                firedAt: now,
              });
            }

            setAlertsLog(prev => {
              // If there is an existing alert on the same candle:
              // If existing is EXPLORATORY and newAlert is PRIMARY, promote/replace it with the higher-conviction signal!
              const existingIdx = prev.findIndex(a => {
                if (a.dedupKey && newAlert.dedupKey && a.dedupKey === newAlert.dedupKey) return true;
                if (a.symbol === symbol && a.interval === signalInterval && a.candleTimestamp && candleTimestamp > 0 && a.candleTimestamp === candleTimestamp) return true;
                if (a.id === newAlert.id) return true;
                return false;
              });

              let filteredPrev = prev;
              if (existingIdx !== -1) {
                const existing = prev[existingIdx];
                if (existing.alertType === 'EXPLORATORY' && newAlert.alertType === 'PRIMARY') {
                  filteredPrev = prev.filter((_, idx) => idx !== existingIdx);
                } else {
                  return prev; // True duplicate
                }
              }

              const nextAlerts = [newAlert, ...filteredPrev];
              return syncAlertOutcomesAndCooldowns(nextAlerts, scannedKlinesMap, symbol);
            });
          }

          lastSignalsRef.current[signalKey] = overallSignal;
        } catch (e) {
          console.error(`Error scanning background signal for ${symbol}`, e);
        }
        }));
      }

      // task #3: update last scan timestamp and alert outcomes after every full pass
      if (isMounted) {
        setLastScanTime(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        setAlertsLog(prev => syncAlertOutcomesAndCooldowns(prev, scannedKlinesMap));
      }
      } finally {
        scannerRunningRef.current = false;
        if (scanPendingRef.current && isMounted) {
          scanPendingRef.current = false;
          setTimeout(checkAllSignals, 0);
        }
      }
    };

    // Scan a few seconds after every minute boundary (aligned with candle closes) instead of a
    // free-running 60s interval: a 5m close is evaluated within seconds, not up to a minute later.
    checkAllSignals();
    let alignedTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAlignedScan = () => {
      alignedTimer = setTimeout(() => {
        if (!isMounted) return;
        checkAllSignals();
        scheduleAlignedScan();
      }, getMsUntilNextAlignedScan(Date.now()));
    };
    scheduleAlignedScan();

    // Fix 2: Throttling recovery — run scanner immediately when tab regains focus
    const handleVisibilityChange = () => {
      if (!document.hidden && isMounted) {
        checkAllSignals();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      lastSignalsRef.current = {};
      scanPendingRef.current = false;
      if (alignedTimer) clearTimeout(alignedTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // Include executionStyle, triggerMode, scoringWeights, and memoized callbacks
  }, [watchlistSymbols, currentAsset, interval, executionStyle, triggerMode, scoringWeights, syncAlertOutcomesAndCooldowns, setAlertCooldown]);

  const latestClose = klines.length > 0 ? klines[klines.length - 1].close : 0;
  const latestVolume = useMemo(() => {
    for (let i = klines.length - 1; i >= 0; i--) {
      if (klines[i].volume > 0) return klines[i].volume;
    }
    return 0;
  }, [klines]);
  const closes = useMemo(() => klines.map(k => k.close), [klines]);

  const isCurrentInWatchlist = watchlistSymbols.includes(currentAsset);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="top-bar">
        <div className="top-bar-left">
          <button
            onClick={() => setShowHelp(true)}
            title="Abrir guía de la aplicación"
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <div className="logo">TERMINAL LITE</div>
            <span style={{
              fontSize: '0.6rem', fontWeight: '700', color: 'var(--accent-blue)',
              background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)',
              borderRadius: '50%', width: '16px', height: '16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: 0.7, transition: 'opacity 0.2s',
              lineHeight: 1,
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
            >?</span>
          </button>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '8px' }} />
            <input 
              type="text" 
              className="asset-search" 
              placeholder="Search ticker..." 
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setCurrentAsset(searchVal);
                }
              }}
              style={{ paddingLeft: '28px' }}
            />
            <button 
              onClick={() => {
                if (isCurrentInWatchlist) {
                  setWatchlistSymbols(prev => prev.filter(s => s !== currentAsset));
                } else {
                  setWatchlistSymbols(prev => [...prev, currentAsset].sort((a, b) => a.localeCompare(b)));
                }
              }}
              style={{ 
                marginLeft: '8px', 
                background: 'transparent', 
                border: `1px solid ${isCurrentInWatchlist ? 'var(--border-color)' : 'var(--accent-blue)'}`, 
                color: isCurrentInWatchlist ? 'var(--text-secondary)' : 'var(--accent-blue)',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                fontWeight: 'bold',
                transition: 'all 0.2s',
              }}
              title={isCurrentInWatchlist ? "Remove from Watchlist" : "Add to Watchlist"}
            >
              {isCurrentInWatchlist ? 'REMOVE' : 'ADD'}
            </button>
          </div>
        </div>
        <MarketTicker />
        <div className="top-bar-right" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
          <div className="status-indicator">
            <div className="dot"></div>
            <span>{loading ? 'FETCHING...' : 'CONNECTED (LIVE)'}</span>
          </div>
          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', opacity: 0.7 }}>
            {APP_VERSION}
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Left Sidebar - Watchlist & Alert History */}
        <aside className="sidebar-left">
          <div style={{ flex: 1.3, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="panel-header">WATCHLIST</div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              <Watchlist 
                symbols={watchlistSymbols}
                onSelectAsset={(sym) => {
                  setCurrentAsset(sym);
                  setMainView('chart');
                }} 
                currentAsset={currentAsset} 
                onRemoveAsset={(sym) => setWatchlistSymbols(prev => prev.filter(s => s !== sym))}
                activeSignals={activeSignals}
              />
            </div>
          </div>
          
          <div style={{ height: '1px', backgroundColor: 'var(--border-color)' }} />
          
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span>HISTORIAL DE ALERTAS</span>
                {/* task #3: last scanner run timestamp */}
                {lastScanTime && notificationsEnabled && (
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: '400' }}>
                    Última revisión: {lastScanTime}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button
                onClick={toggleInformationalAlerts}
                title={logInformationalAlerts
                  ? 'Registrando señales informativas (Estándar, Scoring, VCME, Multifractal, MFLS) sin notificarlas. Click para dejar de registrarlas.'
                  : 'Registrar las señales informativas para evaluarlas con resultados reales (no notifican ni bloquean las alertas principales).'}
                style={{
                  background: logInformationalAlerts ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                  border: `1px solid ${logInformationalAlerts ? 'rgba(168, 85, 247, 0.4)' : 'var(--border-color)'}`,
                  color: logInformationalAlerts ? '#c084fc' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  whiteSpace: 'nowrap',
                }}
              >
                🔬 {logInformationalAlerts ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={openAlertReport}
                title="Informe de alertas reales por estrategia, franja horaria, demora y ejecución"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                }}
              >
                INFORME
              </button>
              {(alertsLog.length > 0 || discardStats.total > 0) && (
                <button
                  onClick={() => {
                    setAlertsLog([]);
                    localStorage.removeItem('terminal_alerts_log');
                    clearFiredAlertsRegistry();
                    clearDiscardStats();
                    const initial = createInitialDiscardStats();
                    discardStatsRef.current = initial;
                    setDiscardStats(initial);
                    seenDiscardKeysRef.current.clear();
                  }}
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: '9px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontWeight: 'bold',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.color = 'var(--accent-red)';
                    e.currentTarget.style.borderColor = 'rgba(244, 63, 94, 0.2)';
                    e.currentTarget.style.backgroundColor = 'rgba(244, 63, 94, 0.05)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.color = 'var(--text-muted)';
                    e.currentTarget.style.borderColor = 'var(--border-color)';
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.03)';
                  }}
                >
                  LIMPIAR
                </button>
              )}
              </div>
            </div>

            <div style={{ 
              flex: 1, 
              overflowY: 'auto', 
              padding: '10px 14px', 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '8px', 
              minHeight: 0 
            }}>
              {/* Session Performance Executive Summary */}
              {(alertsLog.length > 0 || discardStats.total > 0) && (
                <div style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--border-radius-sm)',
                  padding: '6px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '0.65rem',
                  position: 'relative'
                }}>
                  {/* Top row: Core operational performance */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', position: 'relative' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {/* HOY badge with global strategy breakdown tooltip */}
                      <div className="stats-badge-wrapper">
                        <span style={{ color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>HOY</span>
                        <div className="stats-tooltip">
                          <div style={{ fontWeight: '800', color: '#fff', marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px', fontSize: '0.62rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>📊 RENDIMIENTO HOY</span>
                            <span style={{ color: 'var(--accent-blue)' }}>{sessionStats.winRate}% WR</span>
                          </div>
                          {Object.keys(sessionStats.byStrategy || {}).length === 0 ? (
                            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.58rem' }}>Sin alertas validadas hoy</div>
                          ) : (
                            Object.entries(sessionStats.byStrategy).map(([strat, data]) => {
                              const winDetail = (data.tpWins ?? 0) > 0 && (data.expWins ?? 0) > 0
                                ? `${data.tpWins} TP · ${data.expWins} EXP+`
                                : (data.expWins ?? 0) > 0
                                  ? `${data.expWins} EXP+`
                                  : `${data.wins} TP`;
                              const lossDetail = (data.slLosses ?? 0) > 0 && (data.expLosses ?? 0) > 0
                                ? `${data.slLosses} SL · ${data.expLosses} EXP-`
                                : (data.expLosses ?? 0) > 0
                                  ? `${data.expLosses} EXP-`
                                  : `${data.losses} SL`;
                              return (
                                <div key={strat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.58rem', padding: '2px 0', gap: '8px' }}>
                                  <span style={{ color: 'var(--text-secondary)', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{strat}</span>
                                  <div style={{ display: 'flex', gap: '6px', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                    <span style={{ color: 'var(--accent-green)' }}>{winDetail}</span>
                                    <span style={{ color: 'var(--accent-red)' }}>{lossDetail}</span>
                                    <span style={{ color: data.totalR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '700' }}>
                                      {data.totalR >= 0 ? `+${data.totalR}R` : `${data.totalR}R`}
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          )}
                          {sessionStats.exploratory && sessionStats.exploratory.total > 0 && (
                            <div style={{ marginTop: '6px', paddingTop: '4px', borderTop: '1px dashed rgba(255,255,255,0.15)', fontSize: '0.58rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', gap: '6px' }}>
                              <span style={{ whiteSpace: 'nowrap' }}>🔬 Exploratorias ({sessionStats.exploratory.total})</span>
                              <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                {(sessionStats.exploratory.tpWins ?? 0) > 0 && (sessionStats.exploratory.expWins ?? 0) > 0
                                  ? `${sessionStats.exploratory.tpWins} TP · ${sessionStats.exploratory.expWins} EXP+`
                                  : (sessionStats.exploratory.expWins ?? 0) > 0
                                    ? `${sessionStats.exploratory.expWins} EXP+`
                                    : `${sessionStats.exploratory.wins} TP`} · {(sessionStats.exploratory.slLosses ?? 0) > 0 && (sessionStats.exploratory.expLosses ?? 0) > 0
                                  ? `${sessionStats.exploratory.slLosses} SL · ${sessionStats.exploratory.expLosses} EXP-`
                                  : (sessionStats.exploratory.expLosses ?? 0) > 0
                                    ? `${sessionStats.exploratory.expLosses} EXP-`
                                    : `${sessionStats.exploratory.losses} SL`} ({sessionStats.exploratory.totalR >= 0 ? `+${sessionStats.exploratory.totalR}` : sessionStats.exploratory.totalR}R)
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* TP Badge with TP / EXP+ breakdown tooltip */}
                      <div className="stats-badge-wrapper">
                        <span style={{ color: 'var(--accent-green)', fontWeight: '700', whiteSpace: 'nowrap' }}>
                          {(sessionStats.tpWins ?? 0) > 0 && (sessionStats.expWins ?? 0) > 0
                            ? `${sessionStats.tpWins} TP · ${sessionStats.expWins} EXP+ ✅`
                            : (sessionStats.expWins ?? 0) > 0
                              ? `${sessionStats.expWins} EXP+ ✅`
                              : `${sessionStats.wins} TP ✅`}
                        </span>
                        <div className="stats-tooltip">
                          <div style={{ fontWeight: '800', color: 'var(--accent-green)', marginBottom: '6px', borderBottom: '1px solid rgba(16, 185, 129, 0.25)', paddingBottom: '4px', fontSize: '0.62rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>🎯 ACIERTOS POR ESTRATEGIA</span>
                            <span style={{ fontSize: '0.55rem', opacity: 0.85, fontFamily: 'var(--font-mono)' }}>(TP / EXP+)</span>
                          </div>
                          {Object.entries(sessionStats.byStrategy || {}).filter(([_, d]) => d.wins > 0).length === 0 ? (
                            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.58rem' }}>Sin aciertos hoy</div>
                          ) : (
                            Object.entries(sessionStats.byStrategy)
                              .filter(([_, d]) => d.wins > 0)
                              .map(([strat, data]) => {
                                const detail = (data.tpWins ?? 0) > 0 && (data.expWins ?? 0) > 0
                                  ? `${data.tpWins} TP · ${data.expWins} EXP+`
                                  : (data.expWins ?? 0) > 0
                                    ? `${data.expWins} EXP+`
                                    : `${data.wins} TP`;
                                return (
                                  <div key={strat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.58rem', padding: '2px 0', gap: '8px' }}>
                                    <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{strat}</span>
                                    <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                      {detail} ({data.totalR >= 0 ? `+${data.totalR}R` : `${data.totalR}R`})
                                    </span>
                                  </div>
                                );
                              })
                          )}
                        </div>
                      </div>

                      {/* SL Badge with SL / EXP- breakdown tooltip */}
                      <div className="stats-badge-wrapper">
                        <span style={{ color: 'var(--accent-red)', fontWeight: '700', whiteSpace: 'nowrap' }}>
                          {(sessionStats.slLosses ?? 0) > 0 && (sessionStats.expLosses ?? 0) > 0
                            ? `${sessionStats.slLosses} SL · ${sessionStats.expLosses} EXP- ❌`
                            : (sessionStats.expLosses ?? 0) > 0
                              ? `${sessionStats.expLosses} EXP- ❌`
                              : `${sessionStats.losses} SL ❌`}
                        </span>
                        <div className="stats-tooltip">
                          <div style={{ fontWeight: '800', color: 'var(--accent-red)', marginBottom: '6px', borderBottom: '1px solid rgba(244, 63, 94, 0.25)', paddingBottom: '4px', fontSize: '0.62rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>⚠️ FALLOS POR ESTRATEGIA</span>
                            <span style={{ fontSize: '0.55rem', opacity: 0.85, fontFamily: 'var(--font-mono)' }}>(SL / EXP-)</span>
                          </div>
                          {Object.entries(sessionStats.byStrategy || {}).filter(([_, d]) => d.losses > 0).length === 0 ? (
                            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.58rem' }}>Sin fallos hoy</div>
                          ) : (
                            Object.entries(sessionStats.byStrategy)
                              .filter(([_, d]) => d.losses > 0)
                              .map(([strat, data]) => {
                                const detail = (data.slLosses ?? 0) > 0 && (data.expLosses ?? 0) > 0
                                  ? `${data.slLosses} SL · ${data.expLosses} EXP-`
                                  : (data.expLosses ?? 0) > 0
                                    ? `${data.expLosses} EXP-`
                                    : `${data.losses} SL`;
                                return (
                                  <div key={strat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.58rem', padding: '2px 0', gap: '8px' }}>
                                    <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{strat}</span>
                                    <span style={{ color: 'var(--accent-red)', fontWeight: '700', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                      {detail} ({data.totalR >= 0 ? `+${data.totalR}R` : `${data.totalR}R`})
                                    </span>
                                  </div>
                                );
                              })
                          )}
                        </div>
                      </div>

                      {sessionStats.openCount > 0 && (
                        <span style={{ color: 'var(--accent-blue)', fontWeight: '700', whiteSpace: 'nowrap' }}>{sessionStats.openCount} ⏳</span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: '5px', alignItems: 'center', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--text-muted)' }}>WR <strong style={{ color: '#fff' }}>{sessionStats.winRate}%</strong></span>
                      <span style={{
                        color: sessionStats.totalR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                        fontWeight: '800',
                        backgroundColor: sessionStats.totalR >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                        border: `1px solid ${sessionStats.totalR >= 0 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
                        padding: '1px 4px',
                        borderRadius: '4px'
                      }}>
                        {sessionStats.totalR >= 0 ? `+${sessionStats.totalR}R` : `${sessionStats.totalR}R`}
                      </span>
                    </div>
                  </div>

                  {/* Bottom row: Live Telemetry Discards Pill with inline counts & full dropdown tooltip */}
                  {discardStats.total > 0 && (
                    <div style={{
                      borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                      paddingTop: '4px',
                      width: '100%',
                      position: 'relative'
                    }}>
                      <div className="stats-badge-wrapper" style={{ width: '100%' }}>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          width: '100%',
                          padding: '3px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(245, 158, 11, 0.08)',
                          border: '1px solid rgba(245, 158, 11, 0.22)',
                          color: '#fbbf24',
                          fontSize: '0.62rem',
                          cursor: 'pointer',
                          boxSizing: 'border-box'
                        }}>
                          <span style={{ fontWeight: '700', display: 'inline-flex', alignItems: 'center', gap: '3px', whiteSpace: 'nowrap' }}>
                            🛡️ {discardStats.total} descartes
                          </span>
                          <span style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.58rem',
                            color: 'rgba(255, 255, 255, 0.75)',
                            display: 'inline-flex',
                            gap: '4px',
                            whiteSpace: 'nowrap'
                          }}>
                            {discardStats.friction > 0 && <span title="Fricción comisiones">⚡{discardStats.friction}</span>}
                            {discardStats.marketHours > 0 && <span title="Horario / Sesión">🕒{discardStats.marketHours}</span>}
                            {discardStats.cooldown > 0 && <span title="Cooldown">⏱️{discardStats.cooldown}</span>}
                            {discardStats.activeTrade > 0 && <span title="Posición ya abierta">⏳{discardStats.activeTrade}</span>}
                            {discardStats.geometry > 0 && <span title="Geometría">📐{discardStats.geometry}</span>}
                          </span>
                        </div>

                        {/* Tooltip positioned inside container bounds */}
                        <div className="stats-tooltip">
                          <div style={{
                            fontWeight: '800',
                            color: '#fbbf24',
                            marginBottom: '6px',
                            borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
                            paddingBottom: '4px',
                            fontSize: '0.62rem',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}>
                            <span>🛡️ SEÑALES FILTRADAS HOY</span>
                            <span style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>{discardStats.total} total</span>
                          </div>
                          {(['friction', 'marketHours', 'cooldown', 'activeTrade', 'geometry', 'confidence'] as LiveDiscardReason[]).map(reason => {
                            const count = discardStats[reason];
                            const meta = DISCARD_REASON_LABELS[reason];
                            return (
                              <div
                                key={reason}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  fontSize: '0.58rem',
                                  padding: '2px 0',
                                  opacity: count > 0 ? 1 : 0.4
                                }}
                              >
                                <span style={{ color: 'var(--text-secondary)' }}>{meta.icon} {meta.short}</span>
                                <span style={{
                                  color: count > 0 ? '#fff' : 'var(--text-muted)',
                                  fontWeight: count > 0 ? '800' : '500',
                                  fontFamily: 'var(--font-mono)'
                                }}>
                                  {count}
                                </span>
                              </div>
                            );
                          })}
                          <div style={{
                            marginTop: '6px',
                            paddingTop: '4px',
                            borderTop: '1px dashed rgba(255,255,255,0.15)',
                            fontSize: '0.52rem',
                            color: 'var(--text-muted)',
                            lineHeight: '1.25'
                          }}>
                            Filtros de protección: descartan señales con riesgo menor a 0.314% (fricción &gt; 35%), fuera de horario, cooldown o posición abierta.
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {alertsLog.length === 0 ? (
                <div style={{ 
                  fontSize: '0.75rem', 
                  color: 'var(--text-muted)', 
                  textAlign: 'center', 
                  marginTop: '24px', 
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span style={{ fontStyle: 'italic' }}>Sin alertas recientes.</span>
                  {discardStats.total > 0 && (
                    <span style={{ fontSize: '0.64rem', color: 'var(--text-secondary)', maxWidth: '280px' }}>
                      🛡️ <strong>{discardStats.total}</strong> señales técnicas filtradas hoy por control de riesgo y fricción.
                    </span>
                  )}
                </div>
              ) : (
                alertsLog.map((alert) => {
                  const isBuy = alert.signal.includes('BUY');
                  const signalColor = isBuy ? 'var(--accent-green)' : 'var(--accent-red)';
                  const signalBg = isBuy ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';
                  const isStrong = alert.signal.includes('STRONG');

                  const riskDist = Math.abs(alert.entryPrice - alert.stopLoss);
                  const r1 = riskDist > 0 ? Math.abs(alert.takeProfit1 - alert.entryPrice) / riskDist : 1.5;

                  let statusLabel = 'EN VIVO';
                  let statusBg = 'rgba(59, 130, 246, 0.15)';
                  let statusColor = 'var(--accent-blue)';

                  if (alert.status === 'TP1_CLOSED') {
                    const rVal = alert.realizedR || 0;
                    statusLabel = `TP1 (+${rVal > 0 ? rVal.toFixed(2) : r1.toFixed(2)}R) ✅`;
                    statusBg = 'rgba(16, 185, 129, 0.2)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'TP2_CLOSED') {
                    const rVal = alert.realizedR || 0;
                    statusLabel = `TP2 (+${rVal > 0 ? rVal.toFixed(2) : '2.00'}R) ✅`;
                    statusBg = 'rgba(16, 185, 129, 0.2)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'TP2_HIT') {
                    const rVal = alert.realizedR || 0;
                    statusLabel = `TP2 Runner (+${rVal > 0 ? rVal.toFixed(2) : '1.38'}R) 🏃`;
                    statusBg = 'rgba(16, 185, 129, 0.15)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'TP1_BE_CLOSED') {
                    const rVal = alert.realizedR || 0;
                    statusLabel = `TP1/BE (+${rVal > 0 ? rVal.toFixed(2) : (0.5 * r1).toFixed(2)}R) ✅`;
                    statusBg = 'rgba(16, 185, 129, 0.15)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'TP1_HIT') {
                    statusLabel = `TP1 (+${r1.toFixed(1)}R) 🎯`;
                    statusBg = 'rgba(16, 185, 129, 0.15)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'SL_HIT') {
                    statusLabel = 'SL (-1.0R) ❌';
                    statusBg = 'rgba(244, 63, 94, 0.18)';
                    statusColor = 'var(--accent-red)';
                  } else if (alert.status === 'EXPIRED') {
                    const rVal = alert.realizedR || 0;
                    const rFormatted = `${rVal >= 0 ? '+' : ''}${rVal.toFixed(2)}R`;
                    if (rVal > 0.05) {
                      statusLabel = `EXP (${rFormatted}) ⏱️`;
                      statusBg = 'rgba(16, 185, 129, 0.15)';
                      statusColor = 'var(--accent-green)';
                    } else if (rVal < -0.05) {
                      statusLabel = `EXP (${rFormatted}) ⏱️`;
                      statusBg = 'rgba(244, 63, 94, 0.15)';
                      statusColor = 'var(--accent-red)';
                    } else {
                      statusLabel = `EXP (${rFormatted})`;
                      statusBg = 'rgba(255, 255, 255, 0.06)';
                      statusColor = 'var(--text-muted)';
                    }
                  } else {
                    const pnl = alert.pnlPercent ?? 0;
                    const pnlText = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`;
                    statusLabel = `⏳ ${pnlText}`;
                  }

                  const borderGlow = isStrong 
                    ? `1px solid ${isBuy ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`
                    : '1px solid var(--border-color)';
                  
                  return (
                    <div 
                      key={alert.id}
                      onClick={() => {
                        if (!alert.symbol) return;
                        setCurrentAsset(alert.symbol);
                        setMainView('chart');
                        setTimeInterval(alert.interval || '5m');
                        if (alert.entryPrice && alert.stopLoss && alert.takeProfit1) {
                          setSelectedAlertOverlay({
                            entryPrice: alert.entryPrice,
                            stopLoss: alert.stopLoss,
                            takeProfit1: alert.takeProfit1,
                            takeProfit2: alert.takeProfit2,
                            takeProfit3: alert.takeProfit3,
                            signal: alert.signal || 'BUY',
                          });
                        }
                      }}
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.01)',
                        border: borderGlow,
                        borderRadius: 'var(--border-radius-sm)',
                        padding: '8px 10px',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        transition: 'all 0.2s',
                        boxShadow: isStrong ? `0 0 8px ${isBuy ? 'rgba(16, 185, 129, 0.05)' : 'rgba(244, 63, 94, 0.05)'}` : 'none'
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.03)';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.01)';
                        e.currentTarget.style.borderColor = isStrong 
                          ? (isBuy ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)')
                          : 'var(--border-color)';
                      }}
                      title={`Click para abrir gráfico con líneas Entry/SL/TP de ${alert.symbol} (${(alert.interval || '').toUpperCase()})`}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {alert.symbol} <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '500' }}>({(alert.interval || '').toUpperCase()})</span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{
                            fontSize: '0.58rem',
                            fontWeight: '800',
                            color: statusColor,
                            backgroundColor: statusBg,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            fontFamily: 'var(--font-mono)'
                          }}>
                            {statusLabel}
                          </span>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {alert.time}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.65rem' }}>
                        <span style={{ 
                          color: signalColor, 
                          fontWeight: '800', 
                          padding: '1px 5px', 
                          backgroundColor: signalBg, 
                          borderRadius: '3px',
                          fontSize: '0.6rem',
                          letterSpacing: '0.5px'
                        }}>
                          {alert.signal}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                          {alert.strategy} · <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{alert.pf !== null && alert.pf !== undefined ? `PF ${alert.pf.toFixed(1)}` : 'PF N/D'}</span>
                        </span>
                      </div>
                      
                      {/* Entry, SL and TP Targets */}
                      {(alert.executionWarning || alert.dataWarning) && (
                        <div role="note" style={{ color: '#eab308', fontSize: '0.65rem', marginTop: '4px' }}>
                          {[alert.executionWarning, alert.dataWarning].filter(Boolean).join(' ')}
                        </div>
                      )}
                      {alert.entryPrice > 0 && (
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '0.6rem',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          borderTop: '1px dashed rgba(255, 255, 255, 0.06)',
                          paddingTop: '3px',
                          marginTop: '2px'
                        }}>
                          <span>In: <strong style={{ color: '#fff' }}>{formatSmartPrice(alert.entryPrice)}</strong></span>
                          <span>SL: <span style={{ color: 'var(--accent-red)' }}>{formatSmartPrice(alert.stopLoss)}</span></span>
                          {alert.takeProfit2 !== undefined && alert.takeProfit2 !== alert.takeProfit1 ? (
                            <>
                              <span>TP1: <span style={{ color: 'var(--accent-green)' }}>{formatSmartPrice(alert.takeProfit1)}</span></span>
                              <span>TP2: <span style={{ color: 'var(--accent-green)' }}>{formatSmartPrice(alert.takeProfit2)}</span></span>
                            </>
                          ) : (
                            <span>TP: <span style={{ color: 'var(--accent-green)' }}>{formatSmartPrice(alert.takeProfit1)}</span></span>
                          )}
                        </div>
                      )}
                      {alert.entryPrice > 0 && (alert.alertType ?? 'PRIMARY') === 'PRIMARY' && (() => {
                        const costR = computeExecutionCostR(alert);
                        return (
                          <div
                            onClick={e => e.stopPropagation()}
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                          >
                            <span title="Precio al que ejecutaste esta alerta, para medir el costo real de ejecución en el informe">Mi entrada:</span>
                            <input
                              key={`${alert.id}-${alert.userFillPrice ?? ''}`}
                              type="number"
                              step="any"
                              min="0"
                              defaultValue={alert.userFillPrice ?? ''}
                              placeholder={formatSmartPrice(alert.entryPrice)}
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                              onBlur={e => {
                                const value = parseFloat(e.currentTarget.value);
                                const next = Number.isFinite(value) && value > 0 ? value : undefined;
                                if (next !== alert.userFillPrice) recordUserFill(alert.id, next);
                              }}
                              style={{
                                width: '74px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-color)',
                                borderRadius: '3px', color: '#fff', fontSize: '0.6rem', fontFamily: 'var(--font-mono)', padding: '1px 4px',
                              }}
                            />
                            {alert.alertLatencySec !== undefined && (
                              <span title="Segundos entre el cierre de la vela y la emisión de la alerta" style={{ color: alert.alertLatencySec > 60 ? '#eab308' : 'var(--text-muted)' }}>
                                ⏱ {alert.alertLatencySec}s
                              </span>
                            )}
                            {costR !== undefined && (
                              <span style={{ color: costR > 0 ? 'var(--accent-red)' : 'var(--accent-green)', fontWeight: 700 }}>
                                {costR > 0 ? `−${costR.toFixed(2)}R ejec.` : `+${Math.abs(costR).toFixed(2)}R ejec.`}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* Center - Chart & Market Radar */}
        <main className="chart-area" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              {/* Main View Switcher */}
              <div style={{ display: 'flex', gap: '4px', background: 'rgba(0, 0, 0, 0.3)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <button
                  className={`view-toggle-btn ${mainView === 'chart' ? 'active' : ''}`}
                  onClick={() => setMainView('chart')}
                  title="Vista de gráfico individual"
                >
                  <LineChart size={13} />
                  <span>GRÁFICO</span>
                </button>
                <button
                  className={`view-toggle-btn ${mainView === 'radar' ? 'active' : ''}`}
                  onClick={() => setMainView('radar')}
                  title="Radar multi-activo en tiempo real"
                >
                  <LayoutGrid size={13} />
                  <span>RADAR</span>
                </button>
              </div>

              {mainView === 'chart' ? (
                <div>
                  {currentAsset} - <span style={{ color: 'var(--text-secondary)' }}>{interval.toUpperCase()} CHART</span>
                  {latestClose > 0 && <span style={{ marginLeft: '14px', color: 'var(--accent-blue)', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(latestClose)}</span>}
                </div>
              ) : (
                <div style={{ fontSize: '0.78rem', fontWeight: '800', color: 'var(--text-primary)', letterSpacing: '0.5px' }}>
                  RADAR MULTI-ACTIVO EN VIVO
                </div>
              )}
            </div>

            {mainView === 'chart' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button 
                  onClick={() => setShowBB(prev => !prev)}
                  style={{
                    backgroundColor: showBB ? 'var(--accent-blue)' : 'var(--bg-panel)',
                    color: showBB ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: showBB ? 'bold' : 'normal',
                    marginRight: '8px',
                    transition: 'all 0.2s',
                  }}
                  title="Mostrar/Ocultar Bandas de Bollinger"
                >
                  BB
                </button>
                <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-color)', marginRight: '8px' }}></div>
                {['5m', '1h', '1d'].map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setSelectedAlertOverlay(null);
                      setTimeInterval(t);
                    }}
                    style={{
                      backgroundColor: interval === t ? 'var(--accent-blue)' : 'var(--bg-panel)',
                      color: interval === t ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '4px',
                      padding: '4px 12px',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: interval === t ? 'bold' : 'normal',
                    }}
                  >
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chart-container" style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
            {mainView === 'chart' ? (
              klines.length > 0 && <Chart data={klines} showBB={showBB} symbol={currentAsset} interval={interval} activeAlertOverlay={selectedAlertOverlay} />
            ) : (
              <MarketRadar
                watchlistSymbols={watchlistSymbols}
                currentAsset={currentAsset}
                onSelectAsset={(sym) => setCurrentAsset(sym)}
                onNavigateToChart={(sym) => {
                  setCurrentAsset(sym);
                  setMainView('chart');
                }}
                activeSignals={activeSignals}
                alertCooldowns={alertCooldowns}
                executionStyle={executionStyle}
                triggerMode={triggerMode}
                scoringWeights={scoringWeights}
                allowExploratory={logInformationalAlerts || localStorage.getItem('terminal_exploratory_notifications') === 'true'}
              />
            )}
          </div>
        </main>

        {/* Right Sidebar - Signals & News */}
        <aside className="sidebar-right">
          <div className="panel-header">AI SIGNAL & INDICATORS</div>
          <SignalPanel 
            symbol={currentAsset} 
            closes={closes} 
            volume={latestVolume} 
            klines={klines} 
            interval={interval} 
            notificationsEnabled={notificationsEnabled}
            toggleNotifications={toggleNotifications}
            confluenceSignals={confluenceSignals}
            earningsDate={earningsDate}
            allKlines={allKlines}
            executionStyle={executionStyle}
            setExecutionStyle={setExecutionStyle}
            triggerMode={triggerMode}
            setTriggerMode={setTriggerMode}
            weights={scoringWeights}
            setWeights={setScoringWeights}
          />
        </aside>
      </div>

      {/* ── Help Modal ─────────────────────────────── */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {reportAlerts && <AlertReportModal alerts={reportAlerts} onClose={() => setReportAlerts(null)} />}
    </div>
  );
}

export default App;
