import { useState, useEffect, useRef } from 'react';
import './App.css';
import { Search } from 'lucide-react';
import Chart from './components/Chart';
import Watchlist from './components/Watchlist';
import SignalPanel from './components/SignalPanel';
import { fetchKlines, fetchEarningsDate } from './services/api';
import MarketTicker from './components/MarketTicker';
import type { Kline } from './services/api';
import { calculateStandardVoting, calculateExperimentalSignal, calculateScoringSignal, calculateVCMESniperSignal } from './utils/indicators';
import { getTrendFilter, backtestStandard, backtestConfluencia, backtestScoring, backtestMultitemporal } from './utils/backtester';

interface AlertItem {
  id: string;
  symbol: string;
  interval: string;
  signal: string;
  time: string;
  pf: number;
  strategy: string;
}

function App() {
  const [alertsLog, setAlertsLog] = useState<AlertItem[]>(() => {
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
  const [currentAsset, setCurrentAsset] = useState(() => {
    return localStorage.getItem('terminal_current_asset') || 'BTCUSDT';
  });
  const [searchVal, setSearchVal] = useState(currentAsset);
  
  useEffect(() => {
    setSearchVal(currentAsset);
  }, [currentAsset]);

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

  // ── Confluence Matrix & Earnings Events States ───────────────────────────
  const [confluenceSignals, setConfluenceSignals] = useState<Record<string, string>>({ '5m': '...', '1h': '...', '1d': '...' });
  const [allKlines, setAllKlines] = useState<Record<string, Kline[]>>({ '5m': [], '1h': [], '1d': [] });
  const [earningsDate, setEarningsDate] = useState<number | null>(null);

  const computeOverallSignal = (data: Kline[], tf: string, allData?: Record<string, Kline[]>) => {
    if (data.length < 35) return 'WAITING...';

    const btStd = backtestStandard(data, tf);
    const btConf = backtestConfluencia(data, tf);
    const btScore = backtestScoring(data, tf);
    
    let btMulti = { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0, totalSignals: 0 };
    if (allData) {
      const kl5m = tf === '5m' ? data : (allData['5m'] || []);
      const kl1h = allData['1h'] || [];
      const kl1d = allData['1d'] || [];
      if (kl5m.length >= 30 && kl1h.length >= 60 && kl1d.length >= 210) {
        btMulti = backtestMultitemporal(kl5m, kl1h, kl1d, '5m', currentAsset);
      }
    }

    const candidates = [
      { key: 'standard',    pf: btStd.profitFactor,  resolved: btStd.wins + btStd.losses },
      { key: 'confluencia', pf: btConf.profitFactor, resolved: btConf.wins + btConf.losses },
      { key: 'scoring',     pf: btScore.profitFactor, resolved: btScore.wins + btScore.losses },
      { key: 'multitemporal',pf: btMulti.profitFactor, resolved: btMulti.wins + btMulti.losses },
    ];

    const minResolved = tf === '5m' ? 5 : tf === '1h' ? 4 : 3;
    const viable = candidates
      .filter(s => s.resolved >= minResolved)
      .sort((a, b) => b.pf - a.pf);

    let bestStrategy = 'standard';
    if (viable.length > 0) {
      bestStrategy = viable[0].key;
    } else {
      const sortedAll = [...candidates].sort((a, b) => b.pf - a.pf);
      bestStrategy = sortedAll[0].key;
    }

    let signal: string;
    if (bestStrategy === 'confluencia') {
      const result = calculateExperimentalSignal(data, tf);
      signal = result.signal;
    } else if (bestStrategy === 'scoring') {
      const result = calculateScoringSignal(data, tf);
      signal = result.signal;
    } else if (bestStrategy === 'multitemporal' && allData) {
      const kl5m = tf === '5m' ? data : (allData['5m'] || []);
      const kl1h = allData['1h'] || [];
      const kl1d = allData['1d'] || [];
      const result = calculateVCMESniperSignal(kl5m, kl1h, kl1d, currentAsset);
      signal = result.signal;
    } else {
      const voting = calculateStandardVoting(data);
      signal = voting.rawSignal;
    }

    if (bestStrategy !== 'multitemporal') {
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
  }, [currentAsset]);

  // 2. Effect to change active timeframe from memory (no network request!)
  useEffect(() => {
    if (allKlines[interval] && allKlines[interval].length > 0) {
      setKlines(allKlines[interval]);
    }
  }, [interval, allKlines]);

  // 3. Effect for real-time polling updates only on the active asset + interval
  useEffect(() => {
    let isMounted = true;

    const pollInterval = setInterval(async () => {
      try {
        const data = await fetchKlines(currentAsset, interval);
        if (isMounted) {
          setKlines(data);
          setAllKlines(prev => ({ ...prev, [interval]: data }));
          if (data.length >= 35) {
            const closedData = data.slice(0, -1);
            const updatedAllKlines = { ...allKlines, [interval]: data };
            const signal = computeOverallSignal(closedData, interval, updatedAllKlines);
            setConfluenceSignals(prev => ({ ...prev, [interval]: signal }));
          }
        }
      } catch (e) {
        console.error('Error auto-updating active chart data', e);
      }
    }, 60000);

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  }, [currentAsset, interval, allKlines]);



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
  const bestStrategyRef = useRef<Record<string, { strategy: string; pf: number; timestamp: number }>>({});

  // 2h Cooldown for notifications/logging per symbol and timeframe
  const alertCooldownsRef = useRef<Record<string, number>>({});

  // Reset caches on timeframe change to prevent false crossover notifications
  useEffect(() => {
    lastSignalsRef.current = {};
    bestStrategyRef.current = {};
    alertCooldownsRef.current = {};
  }, [interval]);

  useEffect(() => {
    let isMounted = true;

    const checkAllSignals = async () => {
      const enabled = localStorage.getItem('terminal_notifications_enabled') === 'true';
      if (!enabled) return;
      if (!('Notification' in window) || Notification.permission !== 'granted') return;

      const symbolsToScan = Array.from(new Set([...watchlistSymbols, currentAsset]));

      for (const symbol of symbolsToScan) {
        try {
          // Fetch current interval + 1h + 1d in parallel
          const [data, data1h, data1d] = await Promise.all([
            fetchKlines(symbol, interval),
            fetchKlines(symbol, '1h'),
            fetchKlines(symbol, '1d')
          ]);

          if (!isMounted) return;
          if (data.length < 35) continue;

          // ── Determine best strategy (cached for 5 minutes) ──────────────
          const now = Date.now();
          const cached = bestStrategyRef.current[symbol];
          let bestStrategy = 'none';
          let strategyLabel = '';
          let bestPF = 0;

          if (!cached || now - cached.timestamp > 5 * 60 * 1000) {
            const btStd  = backtestStandard(data, interval);
            const btConf = backtestConfluencia(data, interval);
            const btScore = backtestScoring(data, interval);

            let btMulti = { profitFactor: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0, totalSignals: 0 };
            if (data.length >= 30 && data1h.length >= 60 && data1d.length >= 210) {
              const kl5m = interval === '5m' ? data : data1h; // Use 5m data if available
              btMulti = backtestMultitemporal(kl5m, data1h, data1d, '5m', symbol);
            }

            const candidates = [
              { key: 'standard',    label: 'Standard',    pf: btStd.profitFactor,  resolved: btStd.wins + btStd.losses },
              { key: 'confluencia', label: 'Confluencia', pf: btConf.profitFactor, resolved: btConf.wins + btConf.losses },
              { key: 'scoring',     label: 'Scoring',     pf: btScore.profitFactor, resolved: btScore.wins + btScore.losses },
              { key: 'multitemporal', label: 'VCME Sniper', pf: btMulti.profitFactor, resolved: btMulti.wins + btMulti.losses },
            ];

            const minResolved = interval === '5m' ? 5 : interval === '1h' ? 4 : 3;
            const viable = candidates
              .filter(s => s.resolved >= minResolved && s.pf >= 1.3)
              .sort((a, b) => b.pf - a.pf);

            if (viable.length > 0) {
              bestStrategy = viable[0].key;
              strategyLabel = viable[0].label;
              bestPF = viable[0].pf;
            }

            bestStrategyRef.current[symbol] = { strategy: bestStrategy, pf: bestPF, timestamp: now };
          } else {
            bestStrategy = cached.strategy;
            bestPF = cached.pf;
            strategyLabel = bestStrategy === 'confluencia' ? 'Confluencia' : bestStrategy === 'scoring' ? 'Scoring' : bestStrategy === 'multitemporal' ? 'VCME Sniper' : 'Standard';
          }

          if (bestStrategy === 'none') {
            const voting = calculateStandardVoting(data);
            lastSignalsRef.current[symbol] = voting.rawSignal;
            continue;
          }

          // ── Calculate signal using the best strategy on CLOSED candles ──
          let overallSignal: string;
          const closedData = data.slice(0, -1);

          if (bestStrategy === 'confluencia') {
            const result = calculateExperimentalSignal(closedData, interval);
            overallSignal = result.signal;
          } else if (bestStrategy === 'scoring') {
            const result = calculateScoringSignal(closedData, interval);
            overallSignal = result.signal;
          } else if (bestStrategy === 'multitemporal') {
            const result = calculateVCMESniperSignal(
              closedData,
              data1h || await fetchKlines(symbol, '1h'),
              data1d || await fetchKlines(symbol, '1d'),
              symbol
            );
            overallSignal = result.signal;
          } else {
            const voting = calculateStandardVoting(closedData);
            overallSignal = voting.rawSignal;
          }

          if (bestStrategy !== 'multitemporal') {
            const closesList = closedData.map(k => k.close);
            const trend = getTrendFilter(closesList);
            if (trend === 'UP' && (overallSignal === 'SELL' || overallSignal === 'STRONG SELL')) {
              overallSignal = 'NEUTRAL';
            } else if (trend === 'DOWN' && (overallSignal === 'BUY' || overallSignal === 'STRONG BUY')) {
              overallSignal = 'NEUTRAL';
            }
          }

          // ── Check transition & handle Cooldown ──────────────────────────
          const prevSignal = lastSignalsRef.current[symbol];

          if (prevSignal && prevSignal !== overallSignal && (overallSignal.includes('BUY') || overallSignal.includes('SELL'))) {
            const lastAlertTime = alertCooldownsRef.current[`${symbol}-${interval}`] || 0;
            const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours
            
            if (now - lastAlertTime < cooldownMs) {
              // Skip alert but keep track of transition
              lastSignalsRef.current[symbol] = overallSignal;
              continue;
            }

            // Set alert cooldown timestamp
            alertCooldownsRef.current[`${symbol}-${interval}`] = now;

            new Notification(`🚨 Señal en ${symbol} (${interval.toUpperCase()})`, {
              body: `${overallSignal} · vía ${strategyLabel} (PF ${bestPF.toFixed(1)})`,
              tag: `${symbol}-${interval}`,
            });

            const timeString = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const newAlert: AlertItem = {
              id: `${symbol}-${interval}-${Date.now()}`,
              symbol,
              interval,
              signal: overallSignal,
              time: timeString,
              pf: bestPF,
              strategy: strategyLabel
            };

            setAlertsLog(prev => {
              const updated = [newAlert, ...prev].slice(0, 20);
              localStorage.setItem('terminal_alerts_log', JSON.stringify(updated));
              return updated;
            });
          }

          lastSignalsRef.current[symbol] = overallSignal;
        } catch (e) {
          console.error(`Error scanning background signal for ${symbol}`, e);
        }
      }
    };

    checkAllSignals();
    const intervalId = setInterval(checkAllSignals, 60000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [watchlistSymbols, currentAsset, interval]);

  const latestClose = klines.length > 0 ? klines[klines.length - 1].close : 0;
  const latestVolume = klines.length > 0 ? (klines.slice().reverse().find(k => k.volume > 0)?.volume || 0) : 0;
  const closes = klines.map(k => k.close);

  const isCurrentInWatchlist = watchlistSymbols.includes(currentAsset);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="logo">TERMINAL LITE</div>
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
              onBlur={() => {
                setCurrentAsset(searchVal);
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
            v2026.07.10.2
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
              <span>HISTORIAL DE ALERTAS</span>
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
                  const borderGlow = isStrong 
                    ? `1px solid ${isBuy ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`
                    : '1px solid var(--border-color)';
                  
                  return (
                    <div 
                      key={alert.id}
                      onClick={() => {
                        setCurrentAsset(alert.symbol);
                        setTimeInterval(alert.interval);
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
                      title={`Click para abrir gráfico de ${alert.symbol} en ${alert.interval.toUpperCase()}`}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {alert.symbol} <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '500' }}>({alert.interval.toUpperCase()})</span>
                        </span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {alert.time}
                        </span>
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
                          {alert.strategy} · <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>PF {alert.pf.toFixed(1)}</span>
                        </span>
                      </div>
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
              {['1d', '1h', '5m'].map(t => (
                <button 
                  key={t}
                  onClick={() => setTimeInterval(t)}
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
            {klines.length > 0 && <Chart data={klines} showBB={showBB} symbol={currentAsset} interval={interval} />}
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
          />
        </aside>
      </div>
    </div>
  );
}

export default App;
