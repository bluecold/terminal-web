import { useMemo, useState, useEffect } from 'react';
import { calculateExperimentalSignal, calculateScoringSignal, calculateStandardVoting, type ScoringWeights, DEFAULT_WEIGHTS } from '../utils/indicators';
import { backtestStandard, backtestConfluencia, backtestScoring, getTrendFilter } from '../utils/backtester';
import { fetchNews } from '../services/api';
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
}

export default function SignalPanel({ 
  symbol, 
  closes, 
  klines, 
  interval, 
  notificationsEnabled, 
  toggleNotifications,
  confluenceSignals,
  earningsDate
}: SignalPanelProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);
  
  // Custom Scoring Weights state
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [showWeightsConfig, setShowWeightsConfig] = useState(false);

  // ── Risk & Position Calculator States ────────────────────────────────────
  const [calcOpen, setCalcOpen] = useState(true);
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
  
  // ── Unified Standard Voting (single source of truth) ────────────────────
  const voting   = useMemo(() => calculateStandardVoting(klines), [klines]);
  const indicators = voting.indicators;
  const { rawSignal } = voting;

  const exp        = useMemo(() => calculateExperimentalSignal(klines, interval), [klines, interval]);
  const score      = useMemo(() => calculateScoringSignal(klines, interval, weights), [klines, interval, weights]);

  // ── Backtest results (heavy computation, memoized) ──────────────────────
  const btStandard    = useMemo(() => klines.length > 20 ? backtestStandard(klines, interval)    : null, [klines, interval]);
  const btConfluencia = useMemo(() => klines.length > 20 ? backtestConfluencia(klines, interval) : null, [klines, interval]);
  const btScoring     = useMemo(() => klines.length > 20 ? backtestScoring(klines, interval, weights) : null, [klines, interval, weights]);


  const trend = useMemo(() => getTrendFilter(closes), [closes]);
  let overallSignal = rawSignal;
  let overallColor = 'var(--text-primary)';
  let isFiltered = false;
  let filterReason = '';

  if (trend === 'UP' && (rawSignal === 'SELL' || rawSignal === 'STRONG SELL')) {
    overallSignal = 'NEUTRAL';
    overallColor = 'var(--text-secondary)';
    isFiltered = true;
    filterReason = 'Señal de VENTA bloqueada por tendencia alcista macro (EMA 200)';
  } else if (trend === 'DOWN' && (rawSignal === 'BUY' || rawSignal === 'STRONG BUY')) {
    overallSignal = 'NEUTRAL';
    overallColor = 'var(--text-secondary)';
    isFiltered = true;
    filterReason = 'Señal de COMPRA bloqueada por tendencia bajista macro (EMA 200)';
  } else if (overallSignal.includes('BUY')) {
    overallColor = 'var(--accent-green)';
  } else if (overallSignal.includes('SELL')) {
    overallColor = 'var(--accent-red)';
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
  const slPct = btStandard ? btStandard.threshold : 0.015;
  const tpPct = btStandard ? btStandard.targetThreshold : 0.0225;

  const slPrice = calcDirection === 'BUY' ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const tpPrice = calcDirection === 'BUY' ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);

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

      {/* ── EVENT ALERTS PANEL ───────────────────────── */}
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

      {/* ── RISK CALCULATOR ─────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        padding: '16px 14px 14px 14px',
        borderRadius: 'var(--border-radius-md)',
        position: 'relative',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ 
          position: 'absolute', 
          top: '-10px', 
          left: '14px', 
          background: 'var(--bg-dark)', 
          padding: '0 8px', 
          borderRadius: '4px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: 'pointer'
        }}
        onClick={() => setCalcOpen(!calcOpen)}
        >
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px' }}>
            CALCULADORA DE RIESGO {calcOpen ? '▼' : '▶'}
          </span>
        </div>

        {calcOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '4px' }}>
            {/* Direction Selection & Parameter Sync Info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.25)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                <button
                  onClick={() => setCalcDirection('BUY')}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.65rem',
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
                    padding: '2px 8px',
                    fontSize: '0.65rem',
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
                <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>CAPITAL total ($)</label>
                <input 
                  type="number" 
                  value={capital} 
                  onChange={e => setCapital(Math.max(1, parseFloat(e.target.value) || 0))}
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '4px 6px',
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
                <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>RIESGO por trade (%)</label>
                <input 
                  type="number" 
                  step="0.1"
                  value={riskPercent} 
                  onChange={e => setRiskPercent(Math.max(0.1, parseFloat(e.target.value) || 0))}
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '4px 6px',
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
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold' }}>APALANCAMIENTO</label>
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
                      padding: '4px 6px',
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
              background: 'rgba(0,0,0,0.15)', 
              padding: '8px 10px', 
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
            </div>

            {/* Sizing Outputs */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              padding: '10px 12px',
              background: 'linear-gradient(135deg, rgba(255,255,255,0.01) 0%, rgba(0,229,255,0.02) 100%)',
              border: '1px solid rgba(0, 229, 255, 0.1)',
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
        )}
      </div>
      {/* ── BACKTEST SECTION ─────────────────────────── */}
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
            BACKTEST HISTÓRICO
          </span>
        </div>

        <div style={{ marginTop: '2px', marginBottom: '12px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Porcentaje de acierto en velas previas (objetivo ±1.5%)
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <BacktestCard name="Standard (RSI+MACD+BB)" result={btStandard} />
          <BacktestCard name="Signal 1 · Confluencia" result={btConfluencia} />
          <BacktestCard name="Signal 2 · Scoring" result={btScoring} />
        </div>
      </div>

      {/* ── BETA Box ────────────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        padding: '18px 16px 16px 16px',
        borderRadius: 'var(--border-radius-md)',
        position: 'relative',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ position: 'absolute', top: '-10px', right: '12px', background: 'var(--accent-blue)', color: '#fff', fontSize: '8px', padding: '2px 8px', borderRadius: '20px', fontWeight: '800', letterSpacing: '0.5px' }}>BETA</div>

        {/* ── Signal 1: Confluencia ────────────────── */}
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '10px', fontWeight: '800', letterSpacing: '0.8px' }}>SIGNAL 1 · CONFLUENCIA (EMA+VWAP+VELAS)</div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Señal:</span>
            <span style={{ 
              color: exp.signal === 'BUY' ? 'var(--accent-green)' : exp.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-muted)', 
              fontWeight: '700',
              fontSize: '0.85rem'
            }}>
              {klines.length > 0 ? exp.signal : 'WAITING...'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Stop Loss:</span>
            <span style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
              {exp.stopLoss > 0 ? `$${exp.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Volumen:</span>
            <span style={{ 
              color: exp.validVolume ? 'var(--accent-green)' : 'var(--text-muted)', 
              fontSize: '0.8rem',
              fontWeight: '600',
              background: exp.validVolume ? 'rgba(16, 185, 129, 0.08)' : 'transparent',
              padding: exp.validVolume ? '2px 6px' : '0',
              borderRadius: '4px'
            }}>
              {exp.validVolume ? 'VÁLIDO' : 'BAJO'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Cruce EMA 9/20:</span>
            {klines.length > 0 ? (() => {
              const c = exp.emaCrossover;
              if (c.type === 'NONE') {
                return <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin cruce</span>;
              }
              const isBull = c.type === 'BULLISH';
              const color  = isBull ? 'var(--accent-green)' : 'var(--accent-red)';
              const icon   = isBull ? '▲' : '▼';
              const label  = isBull ? 'ALCISTA' : 'BAJISTA';
              const when   = c.barsAgo === 0 ? 'esta vela' : `hace ${c.barsAgo} vela${c.barsAgo > 1 ? 's' : ''}`;
              return (
                <span style={{ color, fontSize: '0.8rem', fontWeight: '700' }}>
                  {icon} {label} <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', fontSize: '0.75rem' }}>({when})</span>
                </span>
              );
            })() : <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</span>}
          </div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px dashed var(--border-color)', margin: '14px 0' }} />

        {/* ── Signal 2: Scoring Multicapa ──────────── */}
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '10px', fontWeight: '800', letterSpacing: '0.8px' }}>SIGNAL 2 · SCORING MULTICAPA (5 CAPAS)</div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Señal:</span>
          <span style={{ color: score.signal === 'BUY' ? 'var(--accent-green)' : score.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-muted)', fontWeight: '700', fontSize: '0.85rem' }}>
            {klines.length > 0 ? score.signal : 'WAITING...'}
          </span>
        </div>

        {/* Score bar -max to +max */}
        <div style={{ marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
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

        {/* Dynamic Weight Configuration Expandable Panel */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
          <button 
            onClick={() => setShowWeightsConfig(prev => !prev)}
            style={{
              color: 'var(--accent-blue)',
              fontSize: '0.7rem',
              fontWeight: '600',
              cursor: 'pointer',
              textDecoration: 'none',
              padding: '2px 8px',
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
            padding: '12px',
            marginBottom: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px', display: 'flex', justifyContent: 'space-between', letterSpacing: '0.5px' }}>
              <span>CAPA</span>
              <span>PESO</span>
            </div>
            {(['trend','rsi','bollinger','volume','candle'] as const).map(layer => {
              const labels: Record<string, string> = { trend: 'Tendencia (EMA)', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela' };
              return (
                <div key={layer} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '4px' }}>
              <button
                onClick={() => setWeights(DEFAULT_WEIGHTS)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.65rem',
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
          {(['trend','rsi','bollinger','volume','candle'] as const).map(layer => {
            const l = score.layers[layer];
            const icon = l.score > 0 ? '▲' : l.score < 0 ? '▼' : '─';
            const col  = l.score > 0 ? 'var(--accent-green)' : l.score < 0 ? 'var(--accent-red)' : 'var(--text-muted)';
            const bgCol = l.score > 0 ? 'rgba(16, 185, 129, 0.05)' : l.score < 0 ? 'rgba(244, 63, 94, 0.05)' : 'transparent';
            const labels: Record<string, string> = { trend: 'Tendencia', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela' };
            const weight = weights[layer];
            return (
              <div key={layer} style={{ 
                display: 'flex', 
                alignItems: 'flex-start', 
                gap: '8px', 
                fontSize: '0.75rem',
                padding: '6px 8px',
                borderRadius: '4px',
                background: bgCol,
                border: '1px solid ' + (l.score > 0 ? 'rgba(16, 185, 129, 0.1)' : l.score < 0 ? 'rgba(244, 63, 94, 0.1)' : 'transparent')
              }}>
                <span style={{ 
                  color: col, 
                  fontWeight: '700', 
                  minWidth: '54px', 
                  display: 'inline-flex', 
                  alignItems: 'center',
                  fontFamily: 'var(--font-mono)'
                }}>
                  <span>{icon}{l.score > 0 ? '+' : ''}{l.score}</span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '3px' }}>
                    ({weight.toFixed(1)}x)
                  </span>
                </span>
                <div style={{ flex: 1, lineHeight: '1.3' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>{labels[layer]}: </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{l.note}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Indicators List */}
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
          TECHNICAL INDICATORS
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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
                  background: 'rgba(255, 255, 255, 0.01)',
                  border: '1px solid rgba(255, 255, 255, 0.03)'
                }}
              >
                <div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: '600' }}>{ind.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                    {hasData ? ind.value : '-'}
                  </div>
                </div>
                <div style={{ 
                  color: ind.color, 
                  fontWeight: '700',
                  padding: '4px 10px',
                  background: signalBg,
                  border: `1px solid ${ind.color === 'var(--text-primary)' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.0)'}`,
                  borderRadius: '12px',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {hasData ? ind.signal : '-'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

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
          LATEST NEWS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {loadingNews ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>Loading news...</div>
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
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0', fontSize: '0.8rem' }}>No recent news</div>
          )}
        </div>
      </div>
    </div>
  );
}
