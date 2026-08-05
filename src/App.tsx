import { useState, useEffect, useRef, useMemo } from 'react';
import './App.css';
import { Search } from 'lucide-react';
import Chart from './components/Chart';
import Watchlist from './components/Watchlist';
import SignalPanel from './components/SignalPanel';
import { fetchKlines, fetchEarningsDate } from './services/api';
import MarketTicker from './components/MarketTicker';
import HelpModal from './components/HelpModal';
import type { Kline } from './services/api';
import { calculateStandardVoting, calculateExperimentalSignal, calculateScoringSignal, calculateVCMESniperSignal, calculateMultifractalMTFSignal } from './utils/indicators';
import { getTrendFilter, backtestStandard, backtestConfluencia, backtestScoring, backtestMultitemporal, backtestMultifractalMTF } from './utils/backtester';
import { evaluateStrategyTournament, type StrategyCandidate, type ConfidenceLevel } from './utils/tournament';
import { calculateAlertLevels, updateAlertsOutcome, calculateSessionStats, type AuditAlertItem } from './utils/alertTracker';
import type { AlertOverlay } from './components/Chart';

function App() {
  const [alertsLog, setAlertsLog] = useState<AuditAlertItem[]>(() => {
    const saved = localStorage.getItem('terminal_alerts_log');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        console.error('Error parsing alerts log from local storage', e);
      }
    }
    return [];
  });
  const [selectedAlertOverlay, setSelectedAlertOverlay] = useState<AlertOverlay | null>(null);
  const [currentAsset, setCurrentAsset] = useState(() => {
    return localStorage.getItem('terminal_current_asset') || 'BTCUSDT';
  });
  const [searchVal, setSearchVal] = useState(currentAsset);
  
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

  // ── Confluence Matrix & Earnings Events States ───────────────────────────
  const [confluenceSignals, setConfluenceSignals] = useState<Record<string, string>>({ '5m': '...', '1h': '...', '1d': '...' });
  const [allKlines, setAllKlines] = useState<Record<string, Kline[]>>({ '5m': [], '1h': [], '1d': [] });
  const [earningsDate, setEarningsDate] = useState<number | null>(null);

  const computeOverallSignal = (data: Kline[], tf: string, allData?: Record<string, Kline[]>) => {
    if (data.length < 35) return 'WAITING...';

    const btStd  = backtestStandard(data, tf);
    const btConf = backtestConfluencia(data, tf);
    const btScore = backtestScoring(data, tf);

    let btMulti = { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0, totalSignals: 0 };
    let btMF    = { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0 };

    if (allData) {
      const kl5m = tf === '5m' ? data : (allData['5m'] || []).slice(0, -1);
      const kl1h = (allData['1h'] || []).slice(0, -1);
      const kl1d = (allData['1d'] || []).slice(0, -1);
      const triggerKlines = executionStyle === 'swing' ? kl1h : kl5m;
      if (triggerKlines.length >= 30 && kl1h.length >= 60 && kl1d.length >= 30) {
        btMulti = backtestMultitemporal(triggerKlines, kl1h, kl1d, '5m', currentAsset, executionStyle, triggerMode);
      }
      if (kl5m.length >= 30) {
        btMF = backtestMultifractalMTF(kl5m, kl1h, kl1d, '5m', currentAsset);
      }
    }

    const candidates: StrategyCandidate[] = [
      { key: 'standard',     label: 'Standard',        profitFactor: btStd.profitFactor,  expectancy: btStd.expectancy,  winRate: btStd.winRate,  resolved: btStd.wins + btStd.losses },
      { key: 'confluencia',  label: 'Confluencia',     profitFactor: btConf.profitFactor, expectancy: btConf.expectancy, winRate: btConf.winRate, resolved: btConf.wins + btConf.losses },
      { key: 'scoring',     label: 'Scoring',        profitFactor: btScore.profitFactor,expectancy: btScore.expectancy,winRate: btScore.winRate,resolved: btScore.wins + btScore.losses },
      { key: 'multitemporal',label: 'VCME Sniper',    profitFactor: btMulti.profitFactor,expectancy: btMulti.expectancy,winRate: btMulti.winRate,resolved: btMulti.wins + btMulti.losses },
      { key: 'multifractal', label: 'Multifractal MTF',profitFactor: btMF.profitFactor,   expectancy: btMF.expectancy,   winRate: btMF.winRate,   resolved: btMF.wins + btMF.losses },
    ];

    const tournament = evaluateStrategyTournament(candidates, tf);
    const bestStrategy = tournament.bestStrategy;

    if (bestStrategy === 'NONE') {
      return 'NEUTRAL';
    }

    let signal: string;
    if (bestStrategy === 'confluencia') {
      const result = calculateExperimentalSignal(data, tf);
      signal = result.signal;
    } else if (bestStrategy === 'scoring') {
      const result = calculateScoringSignal(data, tf);
      signal = result.signal;
    } else if (bestStrategy === 'multitemporal' && allData) {
      const kl5m = tf === '5m' ? data : (allData['5m'] || []).slice(0, -1);
      const kl1h = (allData['1h'] || []).slice(0, -1);
      const kl1d = (allData['1d'] || []).slice(0, -1);
      const triggerKlines = executionStyle === 'swing' ? kl1h : kl5m;
      const result = calculateVCMESniperSignal(triggerKlines, kl1h, kl1d, currentAsset, btMulti.winRate, btMulti.profitFactor, executionStyle, triggerMode);
      signal = result.signal;
    } else if (bestStrategy === 'multifractal' && allData) {
      const kl5m = tf === '5m' ? data : (allData['5m'] || []).slice(0, -1);
      const kl1h = (allData['1h'] || []).slice(0, -1);
      const kl1d = (allData['1d'] || []).slice(0, -1);
      const result = calculateMultifractalMTFSignal(kl5m, kl1h, kl1d, currentAsset);
      signal = result.signal;
    } else {
      const voting = calculateStandardVoting(data);
      signal = voting.rawSignal;
    }

    if (bestStrategy !== 'multitemporal' && bestStrategy !== 'multifractal') {
      const closes = data.map(k => k.close);
      const trend = getTrendFilter(closes);
      if (trend === 'UP' && (signal === 'SELL' || signal === 'STRONG SELL')) {
        signal = 'NEUTRAL';
      } else if (trend === 'DOWN' && (signal === 'BUY' || signal === 'STRONG BUY')) {
        signal = 'NEUTRAL';
      }
    }
    return signal;
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

      if (!currentAsset.endsWith('USDT') && !currentAsset.endsWith('BTC')) {
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

      // Update outcome for any open alerts using newly loaded klines
      setAlertsLog(prev => updateAlertsOutcome(prev, fetchedKlines));

      timeframes.forEach((tf) => {
        const data = fetchedKlines[tf] || [];
        if (data.length >= 35) {
          const closedData = data.slice(0, -1);
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
              const closedData = data.slice(0, -1);
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

  // Cache best strategy per symbol (refreshed every 5 minutes to avoid excessive backtest computation)
  const bestStrategyRef = useRef<Record<string, { strategy: string; pf: number; winRate?: number; confidence?: ConfidenceLevel; strategyLabel?: string; timestamp: number }>>({});

  // 2h Cooldown for notifications/logging per symbol and timeframe
  const alertCooldownsRef = useRef<Record<string, number>>({});

  // Timestamp of the last completed scanner run (task #4)
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);

  // Avoid overlapping scans when a full watchlist pass takes longer than the
  // scheduler interval, and keep network concurrency below provider limits.
  const scannerRunningRef = useRef(false);
  const maxConcurrentSymbolScans = 4;

  // Reset caches on timeframe change to prevent false crossover notifications
  useEffect(() => {
    lastSignalsRef.current = {};
    bestStrategyRef.current = {};
    alertCooldownsRef.current = {};
  }, [interval]);

  useEffect(() => {
    let isMounted = true;

    const checkAllSignals = async () => {
      if (scannerRunningRef.current) return;

      scannerRunningRef.current = true;
      try {
      const symbolsToScan = Array.from(new Set([...watchlistSymbols, currentAsset]));
      const scannedKlinesMap: Record<string, Kline[]> = {};

      for (let batchStart = 0; batchStart < symbolsToScan.length; batchStart += maxConcurrentSymbolScans) {
        const batch = symbolsToScan.slice(batchStart, batchStart + maxConcurrentSymbolScans);
        await Promise.all(batch.map(async (symbol) => {
        try {
          // MTF engines always require their native 5m, 1h and 1d inputs.
          // The active chart timeframe is fetched too when it is distinct.
          const requestedTimeframes = Array.from(new Set([interval, '5m', '1h', '1d']));
          const responses = await Promise.all(requestedTimeframes.map(async (timeframe) => [
            timeframe,
            await fetchKlines(symbol, timeframe)
          ] as const));
          const dataByTimeframe = Object.fromEntries(responses) as Record<string, Kline[]>;
          const data = dataByTimeframe[interval] || [];
          const data5m = dataByTimeframe['5m'] || [];
          const data1h = dataByTimeframe['1h'] || [];
          const data1d = dataByTimeframe['1d'] || [];

          if (!isMounted) return;
          if (data.length < 35) return;
          scannedKlinesMap[symbol] = data;

          // ── Determine best strategy (cached for 5 minutes) ──────────────
          const now = Date.now();
          const cached = bestStrategyRef.current[symbol];
          let bestStrategy: StrategyCandidate['key'] | 'NONE' = 'NONE';
          let strategyLabel = '';
          let bestPF = 0;
          let bestConfidence: ConfidenceLevel = 'NONE';
          let btMulti = { profitFactor: 1.0, wins: 0, losses: 0, winRate: 0.50, expectancy: 0, totalSignals: 0 };

          if (!cached || now - cached.timestamp > 5 * 60 * 1000) {
            const closedData = data.slice(0, -1);
            const closed5m = data5m.slice(0, -1);
            const closed1h = data1h.slice(0, -1);
            const closed1d = data1d.slice(0, -1);
            const btStd  = backtestStandard(closedData, interval);
            const btConf = backtestConfluencia(closedData, interval);
            const btScore = backtestScoring(closedData, interval);

            btMulti = { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0, totalSignals: 0 };
            if (closed5m.length >= 30 && closed1h.length >= 60 && closed1d.length >= 30) {
              const triggerKlines = executionStyle === 'swing' ? closed1h : closed5m;
              btMulti = backtestMultitemporal(triggerKlines, closed1h, closed1d, '5m', symbol, executionStyle, triggerMode);
            }

            const btMF = closed5m.length >= 30 ? backtestMultifractalMTF(closed5m, closed1h, closed1d, '5m', symbol) : { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0 };

            const candidates: StrategyCandidate[] = [
              { key: 'standard',     label: 'Standard',        profitFactor: btStd.profitFactor,  expectancy: btStd.expectancy,  winRate: btStd.winRate,  resolved: btStd.wins + btStd.losses },
              { key: 'confluencia',  label: 'Confluencia',     profitFactor: btConf.profitFactor, expectancy: btConf.expectancy, winRate: btConf.winRate, resolved: btConf.wins + btConf.losses },
              { key: 'scoring',     label: 'Scoring',        profitFactor: btScore.profitFactor,expectancy: btScore.expectancy,winRate: btScore.winRate,resolved: btScore.wins + btScore.losses },
              { key: 'multitemporal',label: 'VCME Sniper',    profitFactor: btMulti.profitFactor,expectancy: btMulti.expectancy,winRate: btMulti.winRate,resolved: btMulti.wins + btMulti.losses },
              { key: 'multifractal', label: 'Multifractal MTF',profitFactor: btMF.profitFactor,   expectancy: btMF.expectancy,   winRate: btMF.winRate,   resolved: btMF.wins + btMF.losses },
            ];

            const tournament = evaluateStrategyTournament(candidates, interval);
            bestStrategy = tournament.bestStrategy;
            strategyLabel = tournament.strategyLabel;
            bestPF = tournament.profitFactor;
            bestConfidence = tournament.confidence;

            const bestCandidate = candidates.find(c => c.key === bestStrategy);
            const bestWinRate = bestCandidate ? bestCandidate.winRate : btMulti.winRate;

            bestStrategyRef.current[symbol] = { strategy: bestStrategy, pf: bestPF, winRate: bestWinRate, confidence: bestConfidence, strategyLabel, timestamp: now };
          } else {
            bestStrategy = cached.strategy as StrategyCandidate['key'] | 'NONE';
            bestPF = cached.pf;
            bestConfidence = cached.confidence || 'HIGH';
            strategyLabel = cached.strategyLabel || (bestStrategy === 'confluencia' ? 'Confluencia' : bestStrategy === 'scoring' ? 'Scoring' : bestStrategy === 'multitemporal' ? 'VCME Sniper' : bestStrategy === 'multifractal' ? 'Multifractal MTF' : 'Standard');
            btMulti = { profitFactor: cached.pf, wins: 0, losses: 0, winRate: cached.winRate || 0.50, expectancy: 0, totalSignals: 0 };
          }

          // ── Calculate signal using the best strategy on CLOSED candles ──
          let overallSignal: string;
          let signalConfidence = '';
          const closedData = data.slice(0, -1);
          const closed5m = data5m.slice(0, -1);
          const closed1h = data1h.slice(0, -1);
          const closed1d = data1d.slice(0, -1);
          const signalInterval = bestStrategy === 'multifractal'
            ? '5m'
            : bestStrategy === 'multitemporal'
              ? (executionStyle === 'swing' ? '1h' : '5m')
              : interval;
          let signalKlines = closedData;

          if (bestStrategy === 'NONE') {
            overallSignal = 'NEUTRAL';
          } else if (bestStrategy === 'confluencia') {
            const result = calculateExperimentalSignal(closedData, interval);
            overallSignal = result.signal;
          } else if (bestStrategy === 'scoring') {
            const result = calculateScoringSignal(closedData, interval);
            overallSignal = result.signal;
          } else if (bestStrategy === 'multitemporal') {
            const triggerKlines = executionStyle === 'swing' ? closed1h : closed5m;
            const result = calculateVCMESniperSignal(
              triggerKlines,
              closed1h,
              closed1d,
              symbol,
              btMulti.winRate,
              btMulti.profitFactor,
              executionStyle,
              triggerMode
            );
            overallSignal = result.signal;
            signalConfidence = result.confidence;
            signalKlines = triggerKlines;
          } else if (bestStrategy === 'multifractal') {
            const result = calculateMultifractalMTFSignal(
              closed5m,
              closed1h,
              closed1d,
              symbol
            );
            overallSignal = result.signal;
            signalKlines = closed5m;
          } else {
            const voting = calculateStandardVoting(closedData);
            overallSignal = voting.rawSignal;
          }

          if (bestStrategy !== 'NONE' && bestStrategy !== 'multitemporal' && bestStrategy !== 'multifractal') {
            const closesList = closedData.map(k => k.close);
            const trend = getTrendFilter(closesList);
            if (trend === 'UP' && (overallSignal === 'SELL' || overallSignal === 'STRONG SELL')) {
              overallSignal = 'NEUTRAL';
            } else if (trend === 'DOWN' && (overallSignal === 'BUY' || overallSignal === 'STRONG BUY')) {
              overallSignal = 'NEUTRAL';
            }
          }

          // ── Check transition & handle Cooldown ──────────────────────────
          const signalKey = `${symbol}-${signalInterval}`;
          const prevSignal = lastSignalsRef.current[signalKey];
          const isActionableSignal = overallSignal.includes('BUY') || overallSignal.includes('SELL');

          // Fix 1: Cold Start — on first scan, fire alert immediately if signal is actionable
          const isFirstScan = prevSignal === undefined;
          const isTransition = prevSignal !== undefined && prevSignal !== overallSignal;

          if (isActionableSignal && (isFirstScan || isTransition)) {
            const lastAlertTime = alertCooldownsRef.current[`${symbol}-${signalInterval}`] || 0;
            const cooldownMs = signalInterval === '5m'
              ? 15 * 60 * 1000        // 15 min for 5m intraday day trading
              : signalInterval === '1h'
                ? 60 * 60 * 1000      // 1 hour for 1h swing trading
                : 12 * 60 * 60 * 1000; // 12 hours for 1d position trading
            
            if (now - lastAlertTime < cooldownMs) {
              // Skip alert but keep track of transition
              lastSignalsRef.current[signalKey] = overallSignal;
              return;
            }

            // Set alert cooldown timestamp
            alertCooldownsRef.current[`${symbol}-${signalInterval}`] = now;

            const desktopNotificationsEnabled = localStorage.getItem('terminal_notifications_enabled') === 'true'
              && ('Notification' in window) && Notification.permission === 'granted';

            if (desktopNotificationsEnabled) {
              const confidenceTag = bestConfidence === 'LIMITED'
                ? ' ⚠️ [Muestra Limitada]'
                : bestConfidence === 'NONE'
                  ? ' 🛡️ [Sin Ventaja]'
                  : '';
              const confidenceString = bestStrategy === 'multitemporal' && signalConfidence ? ` [Confianza: ${signalConfidence}]` : '';
              new Notification(`🚨 Señal en ${symbol} (${signalInterval.toUpperCase()})${confidenceTag}${confidenceString}`, {
                body: `${overallSignal} · vía ${strategyLabel} (PF ${bestPF.toFixed(1)})`,
                tag: `${symbol}-${signalInterval}`,
              });
            }

            const entryPrice = signalKlines.length > 0 ? signalKlines[signalKlines.length - 1].close : 0;
            const levels = calculateAlertLevels(overallSignal, entryPrice, signalInterval);
            const timeString = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

            const newAlert: AuditAlertItem = {
              id: `${symbol}-${signalInterval}-${Date.now()}`,
              symbol,
              interval: signalInterval,
              signal: overallSignal,
              time: timeString,
              pf: bestPF,
              strategy: strategyLabel,
              confidence: bestConfidence,
              entryPrice,
              stopLoss: levels.stopLoss,
              takeProfit1: levels.takeProfit1,
              takeProfit2: levels.takeProfit2,
              status: 'OPEN',
              realizedR: 0,
              pnlPercent: 0,
              timestamp: now,
            };

            setAlertsLog(prev => {
              const updated = updateAlertsOutcome([newAlert, ...prev], scannedKlinesMap).slice(0, 20);
              localStorage.setItem('terminal_alerts_log', JSON.stringify(updated));
              return updated;
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
        setAlertsLog(prev => {
          const updated = updateAlertsOutcome(prev, scannedKlinesMap);
          localStorage.setItem('terminal_alerts_log', JSON.stringify(updated));
          return updated;
        });
      }
      } finally {
        scannerRunningRef.current = false;
      }
    };

    checkAllSignals();
    const intervalId = setInterval(checkAllSignals, 60000);

    // Fix 2: Throttling recovery — run scanner immediately when tab regains focus
    const handleVisibilityChange = () => {
      if (!document.hidden && isMounted) {
        checkAllSignals();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // Fix 4: include executionStyle and triggerMode to avoid stale closures
  }, [watchlistSymbols, currentAsset, interval, executionStyle, triggerMode]);

  const latestClose = klines.length > 0 ? klines[klines.length - 1].close : 0;
  const latestVolume = klines.length > 0 ? (klines.slice().reverse().find(k => k.volume > 0)?.volume || 0) : 0;
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
            v2026.08.05.2
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
                onSelectAsset={setCurrentAsset} 
                currentAsset={currentAsset} 
                onRemoveAsset={(sym) => setWatchlistSymbols(prev => prev.filter(s => s !== sym))}
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
              {alertsLog.length > 0 && (
                <button
                  onClick={() => {
                    setAlertsLog([]);
                    localStorage.removeItem('terminal_alerts_log');
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
              {alertsLog.length > 0 && (
                <div style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--border-radius-sm)',
                  padding: '6px 10px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.65rem'
                }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>HOY</span>
                    <span style={{ color: 'var(--accent-green)', fontWeight: '700' }}>{sessionStats.wins} TP ✅</span>
                    <span style={{ color: 'var(--accent-red)', fontWeight: '700' }}>{sessionStats.losses} SL ❌</span>
                    {sessionStats.openCount > 0 && (
                      <span style={{ color: 'var(--accent-blue)', fontWeight: '700' }}>{sessionStats.openCount} ⏳</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>WR <strong style={{ color: '#fff' }}>{sessionStats.winRate}%</strong></span>
                    <span style={{
                      color: sessionStats.totalR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                      fontWeight: '800',
                      backgroundColor: sessionStats.totalR >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                      border: `1px solid ${sessionStats.totalR >= 0 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
                      padding: '1px 5px',
                      borderRadius: '4px'
                    }}>
                      {sessionStats.totalR >= 0 ? `+${sessionStats.totalR}R` : `${sessionStats.totalR}R`}
                    </span>
                  </div>
                </div>
              )}

              {alertsLog.length === 0 ? (
                <div style={{ 
                  fontSize: '0.75rem', 
                  color: 'var(--text-muted)', 
                  textAlign: 'center', 
                  marginTop: '24px', 
                  fontStyle: 'italic' 
                }}>
                  Sin alertas recientes.
                </div>
              ) : (
                alertsLog.map((alert) => {
                  const isBuy = alert.signal.includes('BUY');
                  const signalColor = isBuy ? 'var(--accent-green)' : 'var(--accent-red)';
                  const signalBg = isBuy ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';
                  const isStrong = alert.signal.includes('STRONG');

                  let statusLabel = 'EN VIVO';
                  let statusBg = 'rgba(59, 130, 246, 0.15)';
                  let statusColor = 'var(--accent-blue)';

                  if (alert.status === 'TP2_HIT') {
                    statusLabel = 'TP2 (+2.5R) ✅';
                    statusBg = 'rgba(16, 185, 129, 0.2)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'TP1_HIT') {
                    statusLabel = 'TP1 (+1.5R) ✅';
                    statusBg = 'rgba(16, 185, 129, 0.15)';
                    statusColor = 'var(--accent-green)';
                  } else if (alert.status === 'SL_HIT') {
                    statusLabel = 'SL (-1.0R) ❌';
                    statusBg = 'rgba(244, 63, 94, 0.18)';
                    statusColor = 'var(--accent-red)';
                  } else if (alert.status === 'EXPIRED') {
                    const rVal = alert.realizedR || 0;
                    statusLabel = `EXP (${rVal >= 0 ? '+' : ''}${rVal}R)`;
                    statusBg = 'rgba(255, 255, 255, 0.06)';
                    statusColor = 'var(--text-muted)';
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
                        setTimeInterval(alert.interval || '5m');
                        if (alert.entryPrice && alert.stopLoss && alert.takeProfit1) {
                          setSelectedAlertOverlay({
                            entryPrice: alert.entryPrice,
                            stopLoss: alert.stopLoss,
                            takeProfit1: alert.takeProfit1,
                            takeProfit2: alert.takeProfit2 || alert.takeProfit1,
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
                          {alert.strategy} · <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>PF {(alert.pf || 0).toFixed(1)}</span>
                        </span>
                      </div>
                      
                      {/* Entry, SL and TP Targets */}
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
                          <span>In: <strong style={{ color: '#fff' }}>${alert.entryPrice >= 1000 ? alert.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : alert.entryPrice.toFixed(2)}</strong></span>
                          <span>SL: <span style={{ color: 'var(--accent-red)' }}>${alert.stopLoss >= 1000 ? alert.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : alert.stopLoss.toFixed(2)}</span></span>
                          <span>TP: <span style={{ color: 'var(--accent-green)' }}>${alert.takeProfit1 >= 1000 ? alert.takeProfit1.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : alert.takeProfit1.toFixed(2)}</span></span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* Center - Chart & Indicators */}
        <main className="chart-area">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              {currentAsset} - <span style={{ color: 'var(--text-secondary)' }}>{interval.toUpperCase()} CHART</span>
              {latestClose > 0 && <span style={{ marginLeft: '16px', color: 'var(--accent-blue)' }}>${latestClose.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>}
            </div>
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
          </div>
          <div className="chart-container">
            {klines.length > 0 && <Chart data={klines} showBB={showBB} symbol={currentAsset} interval={interval} activeAlertOverlay={selectedAlertOverlay} />}
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
          />
        </aside>
      </div>

      {/* ── Help Modal ─────────────────────────────── */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default App;
