import { useMemo, useState, useEffect } from 'react';
import { calculateExperimentalSignal, calculateScoringSignal, calculateStandardVoting, calculateVCMESniperSignal, type VCMESniperResult, type ScoringWeights, DEFAULT_WEIGHTS } from '../utils/indicators';
import {
  backtestStandard,
  backtestConfluencia,
  backtestScoring,
  backtestMultitemporal,
  getTrendFilter
} from '../utils/backtester';
import { fetchNews, fetchStockExtraInfo, fetchCryptoFearAndGreed, type StockExtraInfo, type CryptoExtraInfo } from '../services/api';
import type { NewsItem, Kline } from '../services/api';
import { Bell, BellOff } from 'lucide-react';
import BacktestCard from './BacktestCard';

interface SignalPanelProps {
  symbol: string;
  closes: number[];
  volume: number;
  klines: Kline[];
  interval: string;
  notificationsEnabled: boolean;
  toggleNotifications: () => void;
  confluenceSignals: Record<string, string>;
  earningsDate: number | null;
  allKlines: Record<string, Kline[]>;
}

export default function SignalPanel({ 
  symbol, 
  closes, 
  klines, 
  interval, 
  notificationsEnabled, 
  toggleNotifications,
  confluenceSignals,
  earningsDate,
  allKlines
}: SignalPanelProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);
  
  // Custom Scoring Weights state
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [showWeightsConfig, setShowWeightsConfig] = useState(false);

  // ── Extra Info States & Effect ──────────────────────────────────────────
  const [stockInfo, setStockInfo] = useState<StockExtraInfo | null>(null);
  const [cryptoInfo, setCryptoInfo] = useState<CryptoExtraInfo | null>(null);
  const [loadingExtra, setLoadingExtra] = useState(false);

  useEffect(() => {
    const APP_VERSION = 'v2026.07.13.1';
    const cachedVersion = localStorage.getItem('terminal_app_version');
    if (cachedVersion !== APP_VERSION) {
      // Clear old terminal cache keys
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('terminal_extra_info_')) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem('terminal_app_version', APP_VERSION);
    }

    let isMounted = true;
    const cacheKey = `terminal_extra_info_${symbol}`;
    const cachedData = localStorage.getItem(cacheKey);
    const isCryptoSymbol = symbol.endsWith('USDT') || symbol.endsWith('BTC');

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        // Cache is valid for 24 hours (24 * 60 * 60 * 1000 ms)
        if (parsed && typeof parsed.timestamp === 'number' && Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
          if (isCryptoSymbol) {
            setCryptoInfo(parsed.data);
            setStockInfo(null);
          } else {
            setStockInfo(parsed.data);
            setCryptoInfo(null);
          }
          setLoadingExtra(false);
          return;
        }
      } catch (e) {
        console.error("Error parsing cached extra info", e);
      }
    }

    const loadExtraInfo = async () => {
      setLoadingExtra(true);
      try {
        if (isCryptoSymbol) {
          const data = await fetchCryptoFearAndGreed();
          if (isMounted) {
            if (data) {
              setCryptoInfo(data);
              setStockInfo(null);
              localStorage.setItem(cacheKey, JSON.stringify({
                timestamp: Date.now(),
                data
              }));
            } else {
              setCryptoInfo(null);
            }
          }
        } else {
          const data = await fetchStockExtraInfo(symbol);
          if (isMounted) {
            if (data) {
              setStockInfo(data);
              setCryptoInfo(null);
              localStorage.setItem(cacheKey, JSON.stringify({
                timestamp: Date.now(),
                data
              }));
            } else {
              setStockInfo(null);
            }
          }
        }
      } catch (err) {
        console.error("Error loading extra info in useEffect", err);
      } finally {
        if (isMounted) {
          setLoadingExtra(false);
        }
      }
    };

    loadExtraInfo();

    return () => {
      isMounted = false;
    };
  }, [symbol]);

  // ── Navigation & Accordion States ──────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'strategies' | 'calculator' | 'market'>('strategies');
  const [expandedStrategy, setExpandedStrategy] = useState<string | null>(null);

  // ── Risk & Position Calculator States ────────────────────────────────────
  const [capital, setCapital] = useState(() => {
    const saved = localStorage.getItem('terminal_risk_capital');
    return saved ? parseFloat(saved) : 10000;
  });
  const [riskPercent, setRiskPercent] = useState(() => {
    const saved = localStorage.getItem('terminal_risk_percent');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [leverage, setLeverage] = useState(() => {
    const saved = localStorage.getItem('terminal_risk_leverage');
    return saved ? parseInt(saved) : 1;
  });
  const [calcDirection, setCalcDirection] = useState<'BUY' | 'SELL'>('BUY');

  // Save changes to localStorage
  useEffect(() => {
    localStorage.setItem('terminal_risk_capital', capital.toString());
  }, [capital]);

  useEffect(() => {
    localStorage.setItem('terminal_risk_percent', riskPercent.toString());
  }, [riskPercent]);

  useEffect(() => {
    localStorage.setItem('terminal_risk_leverage', leverage.toString());
  }, [leverage]);

  // ── Curated Macro Events Registry for 2026 ────────────────────────────────
  const MACRO_EVENTS = useMemo(() => [
    { date: '2026-01-14', title: 'IPC de EEUU (CPI)' },
    { date: '2026-01-28', title: 'Decisión de Tasas FOMC' },
    { date: '2026-02-11', title: 'IPC de EEUU (CPI)' },
    { date: '2026-03-11', title: 'IPC de EEUU (CPI)' },
    { date: '2026-03-18', title: 'Decisión de Tasas FOMC' },
    { date: '2026-04-15', title: 'IPC de EEUU (CPI)' },
    { date: '2026-04-29', title: 'Decisión de Tasas FOMC' },
    { date: '2026-05-13', title: 'IPC de EEUU (CPI)' },
    { date: '2026-06-10', title: 'IPC de EEUU (CPI)' },
    { date: '2026-06-17', title: 'Decisión de Tasas FOMC' },
    { date: '2026-07-15', title: 'IPC de EEUU (CPI)' },
    { date: '2026-07-29', title: 'Decisión de Tasas FOMC' },
    { date: '2026-08-12', title: 'IPC de EEUU (CPI)' },
    { date: '2026-09-16', title: 'IPC de EEUU (CPI)' },
    { date: '2026-09-23', title: 'Decisión de Tasas FOMC' },
    { date: '2026-10-14', title: 'IPC de EEUU (CPI)' },
    { date: '2026-11-04', title: 'Decisión de Tasas FOMC' },
    { date: '2026-11-12', title: 'IPC de EEUU (CPI)' },
    { date: '2026-12-10', title: 'IPC de EEUU (CPI)' },
    { date: '2026-12-16', title: 'Decisión de Tasas FOMC' },
  ], []);

  const getNextMacroEvent = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const event of MACRO_EVENTS) {
      const eventDate = new Date(event.date + 'T00:00:00');
      if (eventDate >= today) {
        const diffTime = eventDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return { ...event, daysLeft: diffDays };
      }
    }
    return null;
  };

  const getEarningsInfo = () => {
    if (!earningsDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const date = new Date(earningsDate * 1000);
    const diffTime = date.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return {
      date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      daysLeft: diffDays
    };
  };

  useEffect(() => {
    const loadNews = async () => {
      setLoadingNews(true);
      const data = await fetchNews(symbol);
      setNews(data);
      setLoadingNews(false);
    };
    loadNews();
  }, [symbol]);
  
  // Closed candle confirmation: all indicators/signals should evaluate on closed candles (slice(0, -1))
  const closedKlines = useMemo(() => {
    return klines.length > 1 ? klines.slice(0, -1) : klines;
  }, [klines]);

  const closedCloses = useMemo(() => {
    return closes.length > 1 ? closes.slice(0, -1) : closes;
  }, [closes]);

  // Extract klines for the VCME Sniper 3-layer strategy
  const klines5m = useMemo(() => allKlines['5m'] || [], [allKlines]);
  const klines1h = useMemo(() => allKlines['1h'] || [], [allKlines]);
  const klines1d = useMemo(() => allKlines['1d'] || [], [allKlines]);

  // ── Unified Standard Voting (single source of truth) ────────────────────
  const voting   = useMemo(() => calculateStandardVoting(closedKlines), [closedKlines]);
  const indicators = voting.indicators;
  const { rawSignal } = voting;

  const exp        = useMemo(() => calculateExperimentalSignal(closedKlines, interval), [closedKlines, interval]);
  const score      = useMemo(() => calculateScoringSignal(closedKlines, interval, weights), [closedKlines, interval, weights]);
  const multi: VCMESniperResult = useMemo(() => calculateVCMESniperSignal(klines5m, klines1h, klines1d, symbol), [klines5m, klines1h, klines1d, symbol]);

  // ── Backtest results (heavy computation, memoized) ──────────────────────
  const btStandard    = useMemo(() => klines.length > 20 ? backtestStandard(klines, interval)    : null, [klines, interval]);
  const btConfluencia = useMemo(() => klines.length > 20 ? backtestConfluencia(klines, interval) : null, [klines, interval]);
  const btScoring     = useMemo(() => klines.length > 20 ? backtestScoring(klines, interval, weights) : null, [klines, interval, weights]);
  const btMultitemporal = useMemo(() => {
    return klines5m.length >= 30 && klines1h.length >= 60 && klines1d.length >= 210
      ? backtestMultitemporal(klines5m, klines1h, klines1d, '5m', symbol)
      : null;
  }, [klines5m, klines1h, klines1d, symbol]);

  // ── Strategy Tournament (Sync overall signal with App.tsx) ───────────────
  const bestStrategy = useMemo(() => {
    if (!btStandard || !btConfluencia || !btScoring) return 'standard';
    const candidates = [
      { key: 'standard',     pf: btStandard.profitFactor,  resolved: btStandard.wins + btStandard.losses },
      { key: 'confluencia',  pf: btConfluencia.profitFactor, resolved: btConfluencia.wins + btConfluencia.losses },
      { key: 'scoring',      pf: btScoring.profitFactor,     resolved: btScoring.wins + btScoring.losses },
      { key: 'multitemporal',pf: btMultitemporal ? btMultitemporal.profitFactor : 0, resolved: btMultitemporal ? btMultitemporal.wins + btMultitemporal.losses : 0 },
    ];
    
    const minResolved = interval === '5m' ? 5 : interval === '1h' ? 4 : 3;
    const viable = candidates.filter(s => s.resolved >= minResolved).sort((a, b) => b.pf - a.pf);
    if (viable.length > 0) return viable[0].key;
    return [...candidates].sort((a, b) => b.pf - a.pf)[0].key;
  }, [btStandard, btConfluencia, btScoring, btMultitemporal, interval]);

  // Synchronize expanded strategy with the best strategy when it changes
  useEffect(() => {
    if (bestStrategy) {
      setExpandedStrategy(bestStrategy);
    }
  }, [bestStrategy]);

  const rawOverallSignal = useMemo(() => {
    if (bestStrategy === 'confluencia') return exp.signal;
    if (bestStrategy === 'scoring') return score.signal;
    if (bestStrategy === 'multitemporal') return multi.signal;
    return rawSignal;
  }, [bestStrategy, exp.signal, score.signal, multi.signal, rawSignal]);

  const trend = useMemo(() => getTrendFilter(closedCloses), [closedCloses]);
  let overallSignal = rawOverallSignal;
  let overallColor = 'var(--text-primary)';
  let isFiltered = false;
  let filterReason = '';

  if (bestStrategy !== 'multitemporal') {
    if (trend === 'UP' && (rawOverallSignal === 'SELL' || rawOverallSignal === 'STRONG SELL')) {
      overallSignal = 'NEUTRAL';
      overallColor = 'var(--text-secondary)';
      isFiltered = true;
      filterReason = 'Señal de VENTA bloqueada por tendencia alcista macro (EMA 200)';
    } else if (trend === 'DOWN' && (rawOverallSignal === 'BUY' || rawOverallSignal === 'STRONG BUY')) {
      overallSignal = 'NEUTRAL';
      overallColor = 'var(--text-secondary)';
      isFiltered = true;
      filterReason = 'Señal de COMPRA bloqueada por tendencia bajista macro (EMA 200)';
    }
  }

  if (overallSignal.includes('BUY')) {
    overallColor = 'var(--accent-green)';
  } else if (overallSignal.includes('SELL')) {
    overallColor = 'var(--accent-red)';
  } else if (overallSignal === 'NEUTRAL' || overallSignal === 'HOLD') {
    overallColor = 'var(--text-secondary)';
  }

  let overallColorGlow = 'none';
  let overallBorder = 'var(--border-color)';
  let overallBg = 'linear-gradient(135deg, rgba(255, 255, 255, 0.01) 0%, rgba(0, 0, 0, 0.1) 100%)';
  if (!isFiltered && closes.length > 0) {
    if (overallSignal.includes('BUY')) {
      overallColorGlow = '0 0 20px rgba(16, 185, 129, 0.12)';
      overallBorder = 'rgba(16, 185, 129, 0.25)';
      overallBg = 'linear-gradient(135deg, rgba(16, 185, 129, 0.06) 0%, rgba(16, 185, 129, 0.01) 100%)';
    } else if (overallSignal.includes('SELL')) {
      overallColorGlow = '0 0 20px rgba(244, 63, 94, 0.12)';
      overallBorder = 'rgba(244, 63, 94, 0.25)';
      overallBg = 'linear-gradient(135deg, rgba(244, 63, 94, 0.06) 0%, rgba(244, 63, 94, 0.01) 100%)';
    }
  }

  // Automatically sync calculator direction with the active overallSignal
  useEffect(() => {
    const timer = setTimeout(() => {
      if (overallSignal.includes('BUY')) {
        setCalcDirection('BUY');
      } else if (overallSignal.includes('SELL')) {
        setCalcDirection('SELL');
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [overallSignal]);

  const isCrypto = symbol.endsWith('USDT') || symbol.endsWith('BTC');
  const entryPrice = closes.length > 0 ? closes[closes.length - 1] : 0;

  // Calculate stop/target percentage based on active backtest thresholds, fallback to default if not calculated yet
  const activeSlPct = btStandard ? btStandard.threshold : 0.015;
  const activeTpPct = btStandard ? btStandard.targetThreshold : 0.0225;

  let slPrice = 0;
  let tpPrice = 0;

  if (bestStrategy === 'multitemporal' && multi.stopLoss > 0 && multi.signal === calcDirection) {
    slPrice = multi.stopLoss;
    tpPrice = multi.takeProfit1;
  } else {
    slPrice = calcDirection === 'BUY' ? entryPrice * (1 - activeSlPct) : entryPrice * (1 + activeSlPct);
    tpPrice = calcDirection === 'BUY' ? entryPrice * (1 + activeTpPct) : entryPrice * (1 - activeTpPct);
  }

  const slPct = entryPrice > 0 ? Math.abs(entryPrice - slPrice) / entryPrice : activeSlPct;
  const tpPct = entryPrice > 0 ? Math.abs(entryPrice - tpPrice) / entryPrice : activeTpPct;

  const riskUSD = capital * (riskPercent / 100);
  const priceDiff = Math.abs(entryPrice - slPrice);
  
  const positionUnits = priceDiff > 0 ? riskUSD / priceDiff : 0;
  const totalPositionValue = positionUnits * entryPrice;
  const requiredMargin = totalPositionValue / (isCrypto ? leverage : 1);
  return (
    <div className="signal-panel-content" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '24px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      
      {/* Main Signal */}
      <div style={{ 
        background: overallBg, 
        border: `1px solid ${overallBorder}`,
        boxShadow: overallColorGlow,
        padding: '20px 16px',
        textAlign: 'center',
        borderRadius: 'var(--border-radius-md)',
        transition: 'var(--transition-smooth)',
        position: 'relative'
      }}>
        {/* Toggle Notification Button */}
        <button
          onClick={toggleNotifications}
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            background: 'transparent',
            color: notificationsEnabled ? 'var(--accent-blue)' : 'var(--text-muted)',
            cursor: 'pointer',
            padding: '6px',
            borderRadius: '50%',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${notificationsEnabled ? 'rgba(0, 229, 255, 0.25)' : 'rgba(255, 255, 255, 0.05)'}`,
            boxShadow: notificationsEnabled ? '0 0 10px rgba(0, 229, 255, 0.15)' : 'none',
            backgroundColor: notificationsEnabled ? 'rgba(0, 229, 255, 0.03)' : 'rgba(255, 255, 255, 0.01)'
          }}
          title={notificationsEnabled ? "Notificaciones activadas (clic para desactivar)" : "Activar notificaciones de escritorio"}
        >
          {notificationsEnabled ? (
            <Bell size={14} color="var(--accent-blue)" style={{ filter: 'drop-shadow(0 0 4px var(--accent-blue))' }} />
          ) : (
            <BellOff size={14} color="var(--text-muted)" />
          )}
        </button>

        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '8px' }}>
          OVERALL SIGNAL FOR {symbol}
        </div>
        <div style={{ 
          color: overallColor, 
          fontSize: '1.75rem', 
          fontWeight: '800',
          letterSpacing: '3px',
          textShadow: overallSignal.includes('NEUTRAL') ? 'none' : `0 0 10px ${overallColor}`
        }}>
          {closes.length === 0 ? 'WAITING...' : overallSignal}
        </div>
        {isFiltered && (
          <div style={{ 
            color: 'var(--accent-blue)', 
            fontSize: '0.75rem', 
            marginTop: '12px',
            borderTop: '1px dashed var(--border-color)',
            paddingTop: '10px',
            lineHeight: '1.4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}>
            <span>⚠️</span> <span>{filterReason}</span>
          </div>
        )}
      </div>

      {/* ── CONFLUENCE MATRIX ─────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        padding: '16px 14px 14px 14px',
        borderRadius: 'var(--border-radius-md)',
        position: 'relative',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
            CONFLUENCIA MULTITEMPORAL
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          {['5m', '1h', '1d'].map(tf => {
            const sig = confluenceSignals[tf] || '...';
            const isBuy = sig.includes('BUY');
            const isSell = sig.includes('SELL');
            
            const badgeBg = isBuy 
              ? 'rgba(16, 185, 129, 0.08)' 
              : isSell 
                ? 'rgba(244, 63, 94, 0.08)' 
                : 'rgba(255, 255, 255, 0.02)';
            const badgeColor = isBuy 
              ? 'var(--accent-green)' 
              : isSell 
                ? 'var(--accent-red)' 
                : 'var(--text-secondary)';
            const borderStyle = isBuy 
              ? '1px solid rgba(16, 185, 129, 0.2)' 
              : isSell 
                ? '1px solid rgba(244, 63, 94, 0.2)' 
                : '1px solid var(--border-color)';
                
            return (
              <div 
                key={tf} 
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  gap: '4px',
                  padding: '8px 4px',
                  background: 'rgba(0, 0, 0, 0.15)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px'
                }}
              >
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>{tf.toUpperCase()}</span>
                <span style={{ 
                  fontSize: '0.7rem', 
                  fontWeight: '800', 
                  color: badgeColor, 
                  backgroundColor: badgeBg,
                  border: borderStyle,
                  padding: '2px 8px',
                  borderRadius: '4px',
                  textAlign: 'center',
                  minWidth: '60px'
                }}>
                  {sig === 'NEUTRAL' ? 'NEUTRO' : sig}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {/* ── TAB SELECTION ─────────────────────────── */}
      <div className="sp-tab-container">
        <button 
          className={`sp-tab-button ${activeTab === 'strategies' ? 'active' : ''}`}
          onClick={() => setActiveTab('strategies')}
        >
          Estrategias
        </button>
        <button 
          className={`sp-tab-button ${activeTab === 'calculator' ? 'active' : ''}`}
          onClick={() => setActiveTab('calculator')}
        >
          Calculadora
        </button>
        <button 
          className={`sp-tab-button ${activeTab === 'market' ? 'active' : ''}`}
          onClick={() => setActiveTab('market')}
        >
          Mercado
        </button>
      </div>

      {/* ── TAB CONTENT: STRATEGIES ───────────────────── */}
      {activeTab === 'strategies' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          
          {/* 1. Estrategia Standard */}
          {(() => {
            const id = 'standard';
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = rawSignal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const winRateText = btStandard && !btStandard.insufficient ? `${Math.round(btStandard.winRate * 100)}% WR` : '— WR';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Estándar</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(RSI+MACD+BB)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: 'var(--accent-blue-bg)', 
                        color: 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        LÍDER
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      color: sigColor, 
                      backgroundColor: sigBg,
                      border: `1px solid ${sigColor === 'var(--text-secondary)' ? 'rgba(255, 255, 255, 0.06)' : sigColor + '20'}`,
                      padding: '2px 8px',
                      borderRadius: '4px'
                    }}>
                      {closes.length === 0 ? 'WAITING...' : sig === 'NEUTRAL' ? 'NEUTRO' : sig}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                      {winRateText}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-strategy-card-content">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>RENDIMIENTO HISTÓRICO</div>
                        <BacktestCard name="Standard (RSI+MACD+BB)" result={btStandard} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>INDICADORES TÉCNICOS</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {indicators.map(ind => {
                            const hasData = closes.length > 0;
                            const signalBg = ind.signal === 'BUY' 
                              ? 'rgba(16, 185, 129, 0.08)' 
                              : ind.signal === 'SELL' 
                                ? 'rgba(244, 63, 94, 0.08)' 
                                : 'rgba(255,255,255,0.02)';
                            
                            return (
                              <div 
                                key={ind.name} 
                                style={{ 
                                  display: 'flex', 
                                  justifyContent: 'space-between', 
                                  alignItems: 'center',
                                  padding: '8px 10px',
                                  borderRadius: '6px',
                                  background: 'rgba(0, 0, 0, 0.12)',
                                  border: '1px solid var(--border-color)'
                                }}
                              >
                                <div>
                                  <div style={{ color: 'var(--text-primary)', fontSize: '0.75rem', fontWeight: '600' }}>{ind.name}</div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                                    {hasData ? ind.value : '-'}
                                  </div>
                                </div>
                                <div style={{ 
                                  color: ind.color, 
                                  fontWeight: '700',
                                  padding: '2px 8px',
                                  background: signalBg,
                                  border: `1px solid ${ind.color === 'var(--text-primary)' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.0)'}`,
                                  borderRadius: '12px',
                                  fontSize: '0.65rem',
                                  fontFamily: 'var(--font-mono)',
                                }}>
                                  {hasData ? ind.signal : '-'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 2. Estrategia Confluencia */}
          {(() => {
            const id = 'confluencia';
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = exp.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const winRateText = btConfluencia && !btConfluencia.insufficient ? `${Math.round(btConfluencia.winRate * 100)}% WR` : '— WR';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Confluencia</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(EMA+VWAP+Velas)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: 'var(--accent-blue-bg)', 
                        color: 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        LÍDER
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      color: sigColor, 
                      backgroundColor: sigBg,
                      border: `1px solid ${sigColor === 'var(--text-secondary)' ? 'rgba(255, 255, 255, 0.06)' : sigColor + '20'}`,
                      padding: '2px 8px',
                      borderRadius: '4px'
                    }}>
                      {closes.length === 0 ? 'WAITING...' : (sig as string) === 'NEUTRAL' || (sig as string) === 'HOLD' ? 'NEUTRO' : sig}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                      {winRateText}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-strategy-card-content">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>RENDIMIENTO HISTÓRICO</div>
                        <BacktestCard name="Signal 1 · Confluencia" result={btConfluencia} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>PARÁMETROS DE SEÑAL</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Señal Confluencia:</span>
                            <span style={{ 
                              color: exp.signal === 'BUY' ? 'var(--accent-green)' : exp.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-muted)', 
                              fontWeight: '700',
                              fontSize: '0.75rem'
                            }}>
                              {klines.length > 0 ? exp.signal : 'ESPERANDO...'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Stop Loss Recomendado:</span>
                            <span style={{ color: 'var(--text-primary)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
                              {exp.stopLoss > 0 ? `$${exp.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Filtro de Volumen:</span>
                            <span style={{ 
                              color: exp.validVolume ? 'var(--accent-green)' : 'var(--text-muted)', 
                              fontSize: '0.75rem',
                              fontWeight: '600',
                              background: exp.validVolume ? 'rgba(16, 185, 129, 0.08)' : 'transparent',
                              padding: exp.validVolume ? '2px 6px' : '0',
                              borderRadius: '4px'
                            }}>
                              {exp.validVolume ? 'VÁLIDO' : 'BAJO'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Cruce EMA 9/20:</span>
                            {klines.length > 0 ? (() => {
                              const c = exp.emaCrossover;
                              if (c.type === 'NONE') {
                                return <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Sin cruce</span>;
                              }
                              const isBull = c.type === 'BULLISH';
                              const color  = isBull ? 'var(--accent-green)' : 'var(--accent-red)';
                              const icon   = isBull ? '▲' : '▼';
                              const label  = isBull ? 'ALCISTA' : 'BAJISTA';
                              const when   = c.barsAgo === 0 ? 'esta vela' : `hace ${c.barsAgo} vela${c.barsAgo > 1 ? 's' : ''}`;
                              return (
                                <span style={{ color, fontSize: '0.75rem', fontWeight: '700' }}>
                                  {icon} {label} <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', fontSize: '0.7rem' }}>({when})</span>
                                </span>
                              );
                            })() : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>-</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 3. Estrategia Scoring */}
          {(() => {
            const id = 'scoring';
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = score.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const winRateText = btScoring && !btScoring.insufficient ? `${Math.round(btScoring.winRate * 100)}% WR` : '— WR';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Scoring</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(5 Capas)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: 'var(--accent-blue-bg)', 
                        color: 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        LÍDER
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      color: sigColor, 
                      backgroundColor: sigBg,
                      border: `1px solid ${sigColor === 'var(--text-secondary)' ? 'rgba(255, 255, 255, 0.06)' : sigColor + '20'}`,
                      padding: '2px 8px',
                      borderRadius: '4px'
                    }}>
                      {closes.length === 0 ? 'WAITING...' : (sig as string) === 'NEUTRAL' || (sig as string) === 'HOLD' ? 'NEUTRO' : sig}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                      {winRateText}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-strategy-card-content">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>RENDIMIENTO HISTÓRICO</div>
                        <BacktestCard name="Signal 2 · Scoring Multicapa" result={btScoring} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>SCORING DE MERCADO</div>
                        
                        <div style={{ background: 'rgba(0,0,0,0.12)', padding: '12px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '6px', fontFamily: 'var(--font-mono)' }}>
                            <span>-{score.threshold}</span>
                            <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>Score: {score.score > 0 ? '+' : ''}{score.score}</span>
                            <span>+{score.threshold}</span>
                          </div>
                          <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', position: 'relative', overflow: 'hidden' }}>
                            <div style={{
                              position: 'absolute', top: 0, height: '100%', borderRadius: '4px',
                              width: `${score.threshold > 0 ? Math.min(100, (Math.abs(score.score) / score.threshold) * 50) : 0}%`,
                              left: score.score >= 0 ? '50%' : `${50 - (score.threshold > 0 ? Math.min(50, (Math.abs(score.score) / score.threshold) * 50) : 0)}%`,
                              background: score.signal === 'BUY' ? 'var(--accent-green)' : score.signal === 'SELL' ? 'var(--accent-red)' : 'var(--accent-blue)',
                              transition: 'width 0.4s ease',
                              boxShadow: score.signal === 'BUY' ? '0 0 10px var(--accent-green)' : score.signal === 'SELL' ? '0 0 10px var(--accent-red)' : 'none'
                            }} />
                            <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255, 255, 255, 0.15)' }} />
                          </div>
                        </div>

                        {/* Weights Config */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
                          <button 
                            onClick={() => setShowWeightsConfig(prev => !prev)}
                            style={{
                              color: 'var(--accent-blue)',
                              fontSize: '0.65rem',
                              fontWeight: '600',
                              cursor: 'pointer',
                              padding: '3px 8px',
                              borderRadius: '12px',
                              border: '1px solid rgba(59, 130, 246, 0.15)',
                              background: 'rgba(59, 130, 246, 0.03)',
                            }}
                          >
                            {showWeightsConfig ? 'Ocultar Pesos ✕' : 'Ajustar Pesos ⚙️'}
                          </button>
                        </div>

                        {showWeightsConfig && (
                          <div style={{
                            backgroundColor: 'rgba(0, 0, 0, 0.2)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 'var(--border-radius-sm)',
                            padding: '10px',
                            marginBottom: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px'
                          }}>
                            <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: '800', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', display: 'flex', justifyContent: 'space-between', letterSpacing: '0.5px' }}>
                              <span>CAPA</span>
                              <span>PESO</span>
                            </div>
                            {(['trend','rsi','bollinger','volume','candle'] as const).map(layer => {
                              const labels: Record<string, string> = { trend: 'Tendencia (EMA)', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela' };
                              return (
                                <div key={layer} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>{labels[layer]}</span>
                                    <span style={{ color: 'var(--accent-blue)', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>{weights[layer].toFixed(1)}</span>
                                  </div>
                                  <input
                                    type="range"
                                    min="0"
                                    max="3"
                                    step="0.1"
                                    value={weights[layer]}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value);
                                      setWeights(prev => ({
                                        ...prev,
                                        [layer]: val
                                      }));
                                    }}
                                    style={{
                                      width: '100%',
                                      accentColor: 'var(--accent-blue)',
                                      height: '4px',
                                      cursor: 'pointer'
                                    }}
                                  />
                                </div>
                              );
                            })}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '2px' }}>
                              <button
                                onClick={() => setWeights(DEFAULT_WEIGHTS)}
                                style={{
                                  background: 'transparent',
                                  border: '1px solid var(--border-color)',
                                  color: 'var(--text-secondary)',
                                  fontSize: '0.6rem',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  cursor: 'pointer'
                                }}
                              >
                                Resetear
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Layer breakdown */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {(['trend','rsi','bollinger','volume','candle','structure'] as const).map(layer => {
                            const l = score.layers[layer];
                            if (!l) return null;
                            const icon = l.score > 0 ? '▲' : l.score < 0 ? '▼' : '─';
                            const col  = l.score > 0 ? 'var(--accent-green)' : l.score < 0 ? 'var(--accent-red)' : 'var(--text-muted)';
                            const bgCol = l.score > 0 ? 'rgba(16, 185, 129, 0.04)' : l.score < 0 ? 'rgba(244, 63, 94, 0.04)' : 'transparent';
                            const labels: Record<string, string> = { trend: 'Tendencia', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela', structure: 'Estructura S/R' };
                            const weight = layer === 'structure' ? 1.0 : weights[layer];
                            
                            return (
                              <div key={layer} style={{ 
                                display: 'flex', 
                                alignItems: 'flex-start', 
                                gap: '6px', 
                                fontSize: '0.7rem',
                                padding: '6px 8px',
                                borderRadius: '4px',
                                background: bgCol,
                                border: '1px solid ' + (l.score > 0 ? 'rgba(16, 185, 129, 0.08)' : l.score < 0 ? 'rgba(244, 63, 94, 0.08)' : 'transparent')
                              }}>
                                <span style={{ 
                                  color: col, 
                                  fontWeight: '700', 
                                  minWidth: '50px', 
                                  display: 'inline-flex', 
                                  alignItems: 'center',
                                  fontFamily: 'var(--font-mono)'
                                }}>
                                  <span>{icon}{l.score > 0 ? '+' : ''}{l.score}</span>
                                  <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '2px' }}>
                                    ({weight.toFixed(1)}x)
                                  </span>
                                </span>
                                <div style={{ flex: 1, lineHeight: '1.2' }}>
                                  <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>{labels[layer]}: </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{l.note}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 4. Estrategia VCME Sniper */}
          {(() => {
            const id = 'multitemporal';
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = multi.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const winRateText = btMultitemporal && !btMultitemporal.insufficient ? `${Math.round(btMultitemporal.winRate * 100)}% WR` : '— WR';
            const modeLabel = multi.mode === 'BREAKOUT' ? '🔥 RUPTURA' : multi.mode === 'REVERSAL' ? '🔄 REVERSIÓN' : '';
            
            const biasColor = multi.bias1D === 'ALCISTA' ? 'var(--accent-green)' : multi.bias1D === 'BAJISTA' ? 'var(--accent-red)' : 'var(--text-muted)';
            const momColor = multi.momentum1H === 'ALCISTA' ? 'var(--accent-green)' : multi.momentum1H === 'BAJISTA' ? 'var(--accent-red)' : 'var(--text-muted)';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>VCME Sniper</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(1D + 1H + 5m)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: 'var(--accent-blue-bg)', 
                        color: 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        LÍDER
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      color: sigColor, 
                      backgroundColor: sigBg,
                      border: `1px solid ${sigColor === 'var(--text-secondary)' ? 'rgba(255, 255, 255, 0.06)' : sigColor + '20'}`,
                      padding: '2px 8px',
                      borderRadius: '4px'
                    }}>
                      {closes.length === 0 ? 'WAITING...' : sig === 'NEUTRAL' ? 'NEUTRO' : `${sig} ${modeLabel}`}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                      {winRateText}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-strategy-card-content">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>RENDIMIENTO HISTÓRICO</div>
                        <BacktestCard name="VCME Sniper (1D+1H+5m)" result={btMultitemporal} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>SISTEMA DE 3 CAPAS</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                          {/* Layer 1: 1D Bias */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>📊 Bias 1D (EMA 200/50):</span>
                            <span style={{ color: biasColor, fontWeight: '700', fontSize: '0.75rem' }}>
                              {multi.bias1D === 'ALCISTA' ? '▲ ALCISTA' : multi.bias1D === 'BAJISTA' ? '▼ BAJISTA' : '─ NEUTRAL'}
                              <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', fontSize: '0.7rem', marginLeft: '4px' }}>
                                (${multi.ema200_1D})
                              </span>
                            </span>
                          </div>
                          {/* Layer 2: 1H Momentum */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>⚡ Momentum 1H (EMA50+MACD):</span>
                            <span style={{ color: momColor, fontWeight: '700', fontSize: '0.75rem' }}>
                              {multi.momentum1H === 'ALCISTA' ? '▲ ALCISTA' : multi.momentum1H === 'BAJISTA' ? '▼ BAJISTA' : '─ NEUTRAL'}
                            </span>
                          </div>
                          {/* ADX */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>📈 ADX 1H (Fuerza):</span>
                            <span style={{ 
                              color: multi.adx1H > 20 ? 'var(--accent-green)' : 'var(--accent-red)', 
                              fontWeight: '700', fontSize: '0.75rem' 
                            }}>
                              {multi.adx1H > 0 ? `${multi.adx1H} ${multi.adx1H > 20 ? '✓' : '✗ <20'}` : '-'}
                            </span>
                          </div>
                          {/* MACD Histogram Direction */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>📉 MACD Hist 1H:</span>
                            <span style={{ 
                              color: multi.macdHistDirection === 'CRECIENTE' ? 'var(--accent-green)' : multi.macdHistDirection === 'DECRECIENTE' ? 'var(--accent-red)' : 'var(--text-muted)', 
                              fontWeight: '700', fontSize: '0.75rem' 
                            }}>
                              {multi.macdHistDirection === 'CRECIENTE' ? '▲ CRECIENTE' : multi.macdHistDirection === 'DECRECIENTE' ? '▼ DECRECIENTE' : '─ PLANO'}
                            </span>
                          </div>
                          {/* RSI 1H */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>📊 RSI 1H:</span>
                            <span style={{ 
                              color: multi.rsi1H > 45 && multi.rsi1H < 75 ? 'var(--accent-green)' : 'var(--text-muted)', 
                              fontWeight: '700', fontSize: '0.75rem' 
                            }}>
                              {multi.rsi1H > 0 ? `${multi.rsi1H} ${multi.rsi1H > 45 && multi.rsi1H < 75 ? '(Sano)' : '(Extremo)'}` : '-'}
                            </span>
                          </div>
                          {/* Layer 3: 5m Trigger Detail */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>🎯 Gatillo 5m:</span>
                            <span style={{ 
                              color: multi.mode !== 'NONE' ? sigColor : 'var(--text-muted)', 
                              fontWeight: '700', fontSize: '0.7rem',
                              maxWidth: '55%', textAlign: 'right'
                            }}>
                              {multi.mode === 'BREAKOUT' ? '🔥 RUPTURA' : multi.mode === 'REVERSAL' ? '🔄 REVERSIÓN' : '— Esperando'}
                            </span>
                          </div>
                          {/* Trigger Detail */}
                          <div style={{ 
                            fontSize: '0.68rem', color: 'var(--text-muted)', 
                            borderTop: '1px solid var(--border-color)', 
                            paddingTop: '6px', fontStyle: 'italic' 
                          }}>
                            {multi.triggerDetail}
                          </div>
                        </div>
                      </div>
                      {/* Risk Management Levels */}
                      {multi.signal !== 'NEUTRAL' && (
                        <div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>GESTIÓN DE RIESGO</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }}>🛑 Stop Loss:</span>
                              <span style={{ color: 'var(--accent-red)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>${multi.stopLoss}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>🎯 TP1 (1.5R — cerrar 50%):</span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>${multi.takeProfit1}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>🏆 TP2 (3.0R — EMA9 trail):</span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>${multi.takeProfit2}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-blue)' }}>⚖️ R:R Ratio:</span>
                              <span style={{ color: 'var(--accent-blue)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>1:{multi.riskRewardRatio}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* S/R Levels */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>S/R (5m):</span>
                        <span style={{ color: 'var(--text-primary)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                          {klines.length > 0 ? `S: $${multi.nearestSupport > 0 ? multi.nearestSupport.toFixed(2) : '-'} | R: $${multi.nearestResistance > 0 ? multi.nearestResistance.toFixed(2) : '-'}` : '-'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── TAB CONTENT: CALCULATOR ─────────────────── */}
      {activeTab === 'calculator' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          <div style={{
            backgroundColor: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            padding: '16px 14px',
            borderRadius: 'var(--border-radius-md)',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}>
            
            {/* Direction Selection & Parameter Sync Info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.25)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                <button
                  onClick={() => setCalcDirection('BUY')}
                  style={{
                    padding: '4px 12px',
                    fontSize: '0.7rem',
                    fontWeight: 'bold',
                    background: calcDirection === 'BUY' ? 'var(--accent-green)' : 'transparent',
                    color: calcDirection === 'BUY' ? '#fff' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  COMPRA
                </button>
                <button
                  onClick={() => setCalcDirection('SELL')}
                  style={{
                    padding: '4px 12px',
                    fontSize: '0.7rem',
                    fontWeight: 'bold',
                    background: calcDirection === 'SELL' ? 'var(--accent-red)' : 'transparent',
                    color: calcDirection === 'SELL' ? '#fff' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  VENTA
                </button>
              </div>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                SL/TP por ATR ({btStandard ? 'Standard' : 'Fijo'})
              </span>
            </div>

            {/* Inputs Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: isCrypto ? '1fr 1fr 1fr' : '1fr 1fr', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>CAPITAL ($)</label>
                <input 
                  type="number" 
                  value={capital} 
                  onChange={e => setCapital(Math.max(1, parseFloat(e.target.value) || 0))}
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    color: '#fff',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    outline: 'none',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>RIESGO (%)</label>
                <input 
                  type="number" 
                  step="0.1"
                  value={riskPercent} 
                  onChange={e => setRiskPercent(Math.max(0.1, parseFloat(e.target.value) || 0))}
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    color: '#fff',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    outline: 'none',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              {isCrypto && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>APALANC. (x)</label>
                  <input 
                    type="number" 
                    min="1"
                    max="50"
                    value={leverage} 
                    onChange={e => setLeverage(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '4px',
                      padding: '6px 8px',
                      color: '#fff',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      outline: 'none',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              )}
            </div>

            {/* Price Plan (SL & TP Levels) */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              background: 'rgba(0,0,0,0.2)', 
              padding: '10px 12px', 
              borderRadius: '6px', 
              border: '1px solid var(--border-color)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Entrada:</span>
                <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.75rem', marginTop: '2px' }}>
                  ${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--accent-red)' }}>Stop Loss (-{(slPct*100).toFixed(1)}%):</span>
                <div style={{ color: 'var(--accent-red)', fontWeight: 'bold', fontSize: '0.75rem', marginTop: '2px' }}>
                  ${slPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--accent-green)' }}>Target (+{(tpPct*100).toFixed(1)}%):</span>
                <div style={{ color: 'var(--accent-green)', fontWeight: 'bold', fontSize: '0.75rem', marginTop: '2px' }}>
                  ${tpPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: '10px' }}>
                <span style={{ color: 'var(--text-muted)' }}>R:R Ratio:</span>
                <div style={{ 
                  color: slPct > 0 && (tpPct / slPct) >= 1.5 ? 'var(--accent-green)' : 'var(--accent-red)', 
                  fontWeight: 'bold', 
                  fontSize: '0.75rem', 
                  marginTop: '2px' 
                }}>
                  {slPct > 0 ? `${(tpPct / slPct).toFixed(1)}:1` : 'N/A'} {slPct > 0 && (tpPct / slPct) >= 1.5 ? '✓' : '⚠️'}
                </div>
              </div>
            </div>

            {/* Sizing Outputs */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              padding: '10px 12px',
              background: 'linear-gradient(135deg, rgba(255,255,255,0.01) 0%, rgba(59,130,246,0.03) 100%)',
              border: '1px solid rgba(59, 130, 246, 0.12)',
              borderRadius: '6px',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>RIESGO EN USD:</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>
                  ${riskUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>TAMAÑO RECOMENDADO:</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>
                  {positionUnits >= 1000 ? positionUnits.toLocaleString(undefined, { maximumFractionDigits: 2 }) : positionUnits.toFixed(4)} {isCrypto ? symbol.replace('USDT', '') : 'Acciones'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>TAMAÑO EN USD:</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  ${totalPositionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>MARGEN NECESARIO:</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  ${requiredMargin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB CONTENT: MARKET ─────────────────────── */}
      {activeTab === 'market' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          {/* Métricas de Contexto (Complementary Info) */}
          {(() => {
            if (loadingExtra) {
              return (
                <div style={{
                  backgroundColor: 'var(--bg-panel)',
                  border: '1px solid var(--border-color)',
                  padding: '16px',
                  borderRadius: 'var(--border-radius-md)',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  animation: 'pulse 1.5s infinite'
                }}>
                  Cargando métricas de contexto...
                </div>
              );
            }

            const isCryptoSymbol = symbol.endsWith('USDT') || symbol.endsWith('BTC');

            if (isCryptoSymbol && cryptoInfo) {
              const value = cryptoInfo.value;
              const classification = cryptoInfo.classification;
              
              // Determine color based on Fear & Greed value
              let color = 'var(--text-secondary)';
              let bgGlow = 'none';
              if (value <= 25) {
                color = 'var(--accent-red)'; // Extreme Fear
                bgGlow = '0 0 10px rgba(244, 63, 94, 0.1)';
              } else if (value < 45) {
                color = '#f59e0b'; // Fear (orange)
              } else if (value <= 55) {
                color = 'var(--text-secondary)'; // Neutral
              } else if (value < 75) {
                color = 'var(--accent-green)'; // Greed
              } else {
                color = '#059669'; // Extreme Greed (darker green)
                bgGlow = '0 0 10px rgba(16, 185, 129, 0.1)';
              }

              return (
                <div style={{
                  backgroundColor: 'var(--bg-panel)',
                  border: '1px solid var(--border-color)',
                  padding: '16px 14px 14px 14px',
                  borderRadius: 'var(--border-radius-md)',
                  position: 'relative',
                  boxShadow: bgGlow || 'var(--shadow-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                      SENTIMIENTO DE MERCADO CRIPTO
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>F&G INDEX (GLOBAL)</span>
                      <span style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff' }}>
                        {value} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 'normal' }}>/ 100</span>
                      </span>
                    </div>
                    <span style={{ 
                      fontSize: '0.75rem', 
                      fontWeight: '800', 
                      padding: '4px 10px', 
                      borderRadius: '6px',
                      color: color,
                      backgroundColor: `${color}15`,
                      border: `1px solid ${color}30`,
                      letterSpacing: '0.5px',
                      textTransform: 'uppercase'
                    }}>
                      {classification === 'Greed' ? 'Codicia' : classification === 'Extreme Greed' ? 'Codicia Extrema' : classification === 'Fear' ? 'Miedo' : classification === 'Extreme Fear' ? 'Miedo Extremo' : 'Neutral'}
                    </span>
                  </div>

                  {/* Gradient Progress Bar */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'linear-gradient(to right, var(--accent-red) 0%, #f59e0b 50%, var(--accent-green) 100%)', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                      {/* Indicator Needle */}
                      <div style={{
                        position: 'absolute',
                        top: '-3px',
                        left: `${value}%`,
                        width: '4px',
                        height: '14px',
                        backgroundColor: '#fff',
                        borderRadius: '2px',
                        border: '1px solid #000',
                        boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                        transform: 'translateX(-50%)',
                        transition: 'left 0.8s cubic-bezier(0.25, 0.8, 0.25, 1)'
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      <span>MIEDO EXTREMO</span>
                      <span>NEUTRAL</span>
                      <span>CODICIA EXTREMA</span>
                    </div>
                  </div>
                </div>
              );
            }

            if (!isCryptoSymbol) {
              if (!stockInfo) {
                return (
                  <div style={{
                    backgroundColor: 'var(--bg-panel)',
                    border: '1px solid var(--border-color)',
                    padding: '20px 14px 18px 14px',
                    borderRadius: 'var(--border-radius-md)',
                    position: 'relative',
                    boxShadow: 'var(--shadow-sm)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}>
                    <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                        ZACKS RANK & FUNDAMENTALES
                      </span>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      padding: '10px 10px 4px 10px'
                    }}>
                      <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                      <span style={{ fontSize: '0.75rem', fontWeight: '500', lineHeight: '1.4', color: 'var(--text-secondary)' }}>
                        Datos de consenso y fundamentales no disponibles
                      </span>
                      <span style={{ fontSize: '0.65rem', lineHeight: '1.4' }}>
                        Los servicios de Zacks y Yahoo Finance han limitado las peticiones desde este servidor o no hay conexión a internet.
                      </span>
                    </div>
                  </div>
                );
              }

              const recMean = stockInfo.recommendationMean;
              const recColor = recMean !== null
                ? (recMean <= 2.0 ? 'var(--accent-green)' : recMean <= 3.5 ? 'var(--text-secondary)' : 'var(--accent-red)')
                : 'var(--text-secondary)';
              
              let recLabel = 'MANTENER';
              if (recMean !== null) {
                if (recMean <= 1.5) recLabel = 'FUERTE COMPRA';
                else if (recMean <= 2.5) recLabel = 'COMPRA';
                else if (recMean <= 3.5) recLabel = 'MANTENER';
                else if (recMean <= 4.5) recLabel = 'VENTA';
                else recLabel = 'FUERTE VENTA';
              }

              const target = stockInfo.targetMeanPrice;
              const beta = stockInfo.beta;

              // Calculate Upside
              let upsidePct = 0;
              if (target && entryPrice > 0) {
                upsidePct = ((target - entryPrice) / entryPrice) * 100;
              }

              return (
                <div style={{
                  backgroundColor: 'var(--bg-panel)',
                  border: '1px solid var(--border-color)',
                  padding: '16px 14px 14px 14px',
                  borderRadius: 'var(--border-radius-md)',
                  position: 'relative',
                  boxShadow: 'var(--shadow-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                      ZACKS RANK & FUNDAMENTALES
                    </span>
                  </div>

                  {/* Analyst Consensus Rating Scale */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>ZACKS RANK</span>
                      {recMean !== null && (
                        <span style={{ 
                          fontSize: '0.7rem', 
                          fontWeight: '800', 
                          padding: '2px 8px', 
                          borderRadius: '4px',
                          color: recColor,
                          backgroundColor: `${recColor}12`,
                          border: `1px solid ${recColor}25`
                        }}>
                          {recLabel} ({recMean})
                        </span>
                      )}
                    </div>

                    {recMean !== null ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ height: '8px', borderRadius: '4px', background: 'linear-gradient(to right, var(--accent-green) 0%, #a7f3d0 25%, var(--text-muted) 50%, #fca5a5 75%, var(--accent-red) 100%)', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                          {/* Rating Needle: maps 1.0 (left) to 5.0 (right) */}
                          <div style={{
                            position: 'absolute',
                            top: '-3px',
                            left: `${((recMean - 1) / 4) * 100}%`,
                            width: '4px',
                            height: '14px',
                            backgroundColor: '#fff',
                            borderRadius: '2px',
                            border: '1px solid #000',
                            boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                            transform: 'translateX(-50%)',
                            transition: 'left 0.8s cubic-bezier(0.25, 0.8, 0.25, 1)'
                          }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.55rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          <span>1.0 FUERTE COMPRA</span>
                          <span>3.0 MANTENER</span>
                          <span>5.0 FUERTE VENTA</span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Sin Zacks Rank disponible</div>
                    )}
                  </div>

                  <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '2px 0' }} />

                  {/* Target Price & Beta */}
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {/* Target Price & Beta Conditionally rendered */}
                    {target ? (
                      <>
                        <div style={{ 
                          flex: 1.2, 
                          padding: '8px 10px', 
                          background: 'rgba(0, 0, 0, 0.12)', 
                          border: '1px solid var(--border-color)', 
                          borderRadius: '6px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px'
                        }}>
                          <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>PRECIO OBJETIVO (YAHOO)</span>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                              ${target.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ 
                              fontSize: '0.65rem', 
                              fontWeight: 'bold', 
                              color: upsidePct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'
                            }}>
                              {upsidePct >= 0 ? '+' : ''}{upsidePct.toFixed(1)}% Upside
                            </span>
                          </div>
                        </div>

                        {/* Beta */}
                        <div style={{ 
                          flex: 0.8, 
                          padding: '8px 10px', 
                          background: 'rgba(0, 0, 0, 0.12)', 
                          border: '1px solid var(--border-color)', 
                          borderRadius: '6px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px'
                        }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>BETA (VOLATILIDAD)</span>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                              {beta !== null ? beta.toFixed(2) : 'N/A'}
                            </span>
                            {beta !== null && (
                              <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', lineHeight: '1.1' }} title={beta > 1 ? "Más volátil que el mercado" : "Menos volátil que el mercado"}>
                                {beta > 1 ? "📈 Alta" : beta < 1 ? "📉 Baja" : "Neutral"}
                              </span>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      /* Beta only, full width */
                      <div style={{ 
                        flex: 1, 
                        padding: '8px 10px', 
                        background: 'rgba(0, 0, 0, 0.12)', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px'
                      }}>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>BETA (VOLATILIDAD)</span>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                            {beta !== null ? beta.toFixed(2) : 'N/A'}
                          </span>
                          {beta !== null && (
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '1.1' }} title={beta > 1 ? "Más volátil que el mercado" : "Menos volátil que el mercado"}>
                              {beta > 1 ? "📈 Alta (más volátil que el mercado)" : beta < 1 ? "📉 Baja (menos volátil que el mercado)" : "Neutral"}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                </div>
              );
            }

            return null;
          })()}

          {/* Volatility Catalysts (Earnings & Macro events) */}
          {(() => {
            const nextMacro = getNextMacroEvent();
            const earningsInfo = getEarningsInfo();
            const hasEvents = nextMacro || earningsInfo;
            
            if (!hasEvents) return null;
            
            return (
              <div style={{
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-color)',
                padding: '16px 14px 14px 14px',
                borderRadius: 'var(--border-radius-md)',
                position: 'relative',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}>
                <div style={{ position: 'absolute', top: '-10px', left: '14px', background: 'var(--bg-dark)', padding: '0 8px', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
                    CATALIZADORES DE VOLATILIDAD
                  </span>
                </div>
                
                {earningsInfo && (
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    padding: '6px 10px',
                    background: earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.05)' : 'rgba(255, 255, 255, 0.01)',
                    border: `1px solid ${earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.2)' : 'var(--border-color)'}`,
                    borderRadius: '6px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>Reporte de Ganancias (Stock)</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{earningsInfo.date}</span>
                    </div>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      padding: '2px 8px', 
                      borderRadius: '4px',
                      color: earningsInfo.daysLeft <= 2 ? 'var(--accent-red)' : 'var(--accent-blue)',
                      backgroundColor: earningsInfo.daysLeft <= 2 ? 'rgba(244, 63, 94, 0.08)' : 'rgba(0, 229, 255, 0.08)'
                    }}>
                      {earningsInfo.daysLeft <= 0 ? 'Hoy' : earningsInfo.daysLeft === 1 ? 'Mañana' : `en ${earningsInfo.daysLeft} días`}
                    </span>
                  </div>
                )}
                
                {nextMacro && (
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    padding: '6px 10px',
                    background: nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.05)' : 'rgba(255, 255, 255, 0.01)',
                    border: `1px solid ${nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.2)' : 'var(--border-color)'}`,
                    borderRadius: '6px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>{nextMacro.title} (Macro 2026)</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{new Date(nextMacro.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </div>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: '800', 
                      padding: '2px 8px', 
                      borderRadius: '4px',
                      color: nextMacro.daysLeft <= 2 ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                      backgroundColor: nextMacro.daysLeft <= 2 ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.03)'
                    }}>
                      {nextMacro.daysLeft === 0 ? 'Hoy' : nextMacro.daysLeft === 1 ? 'Mañana' : `en ${nextMacro.daysLeft} días`}
                    </span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* News Feed */}
          <div style={{
            backgroundColor: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            padding: '16px',
            borderRadius: 'var(--border-radius-md)'
          }}>
            <div style={{ 
              color: 'var(--text-secondary)', 
              fontSize: '0.75rem', 
              fontWeight: '800', 
              letterSpacing: '1px', 
              marginBottom: '14px', 
              borderBottom: '1px solid var(--border-color)', 
              paddingBottom: '8px',
              textTransform: 'uppercase'
            }}>
              ÚLTIMAS NOTICIAS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {loadingNews ? (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>Cargando noticias...</div>
              ) : news.length > 0 ? (
                news.map((item, index) => (
                  <a 
                    key={index} 
                    href={item.url} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    style={{ 
                      textDecoration: 'none', 
                      display: 'block',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      background: 'rgba(255, 255, 255, 0.01)',
                      border: '1px solid rgba(255, 255, 255, 0.03)',
                      transition: 'var(--transition-smooth)',
                    }}
                    className="news-card"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(59, 130, 246, 0.03)';
                      e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.01)';
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.03)';
                    }}
                  >
                    <div style={{ 
                      color: 'var(--accent-blue)', 
                      marginBottom: '6px', 
                      lineHeight: '1.4', 
                      fontWeight: '600',
                      fontSize: '0.8rem'
                    }}>
                      {item.title}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                      <span>{item.source}</span>
                      <span>{item.time}</span>
                    </div>
                  </a>
                ))
              ) : (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>Sin noticias recientes</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
