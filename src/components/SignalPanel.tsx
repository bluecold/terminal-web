import { useMemo, useState, useEffect } from 'react';
import { calculateRSI, calculateMACD, calculateBollingerBands, calculateExperimentalSignal, calculateScoringSignal, type ScoringWeights, DEFAULT_WEIGHTS } from '../utils/indicators';
import { backtestStandard, backtestConfluencia, backtestScoring, getTrendFilter } from '../utils/backtester';
import { fetchNews } from '../services/api';
import type { NewsItem, Kline } from '../services/api';
import BacktestCard from './BacktestCard';

interface SignalPanelProps {
  symbol: string;
  closes: number[];
  volume: number;
  klines: Kline[];
  interval: string;
}

export default function SignalPanel({ symbol, closes, volume, klines, interval }: SignalPanelProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);
  
  // Custom Scoring Weights state
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [showWeightsConfig, setShowWeightsConfig] = useState(false);

  useEffect(() => {
    const loadNews = async () => {
      setLoadingNews(true);
      const data = await fetchNews(symbol);
      setNews(data);
      setLoadingNews(false);
    };
    loadNews();
  }, [symbol]);
  
  const rsi  = useMemo(() => calculateRSI(closes), [closes]);
  const macd  = useMemo(() => calculateMACD(closes), [closes]);
  const bb    = useMemo(() => calculateBollingerBands(closes), [closes]);
  const exp   = useMemo(() => calculateExperimentalSignal(klines, interval), [klines, interval]);
  const score = useMemo(() => calculateScoringSignal(klines, interval, weights), [klines, interval, weights]);

  // ── Backtest results (heavy computation, memoized) ──────────────────────
  const btStandard    = useMemo(() => klines.length > 20 ? backtestStandard(klines, interval)    : null, [klines, interval]);
  const btConfluencia = useMemo(() => klines.length > 20 ? backtestConfluencia(klines, interval) : null, [klines, interval]);
  const btScoring     = useMemo(() => klines.length > 20 ? backtestScoring(klines, interval, weights) : null, [klines, interval, weights]);
  
  // Volume signal simple heuristic
  const volumeSignal = volume > 0 ? (closes.length > 2 && volume > closes[closes.length - 2] * 1.5 ? 'BUY' : 'NEUTRAL') : 'NEUTRAL';
  
  const indicators = [
    { name: 'RSI (14)', value: rsi.value, signal: rsi.signal, color: rsi.signal === 'BUY' ? 'var(--accent-green)' : rsi.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-primary)' },
    { name: 'MACD (12,26,9)', value: macd.value, signal: macd.signal, color: macd.signal === 'BUY' ? 'var(--accent-green)' : macd.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-primary)' },
    { name: 'Bollinger Bands', value: bb.current.toFixed(2), signal: bb.signal, color: bb.signal === 'BUY' ? 'var(--accent-green)' : bb.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-primary)' },
    { name: 'Volume', value: volume > 1000000 ? (volume/1000000).toFixed(1) + 'M' : volume.toFixed(0), signal: volumeSignal, color: volumeSignal === 'BUY' ? 'var(--accent-green)' : 'var(--text-primary)' },
  ];

  // Overall signal based on votes
  let buyVotes = 0;
  let sellVotes = 0;
  indicators.forEach(ind => {
    if (ind.signal === 'BUY') buyVotes++;
    if (ind.signal === 'SELL') sellVotes++;
  });

  let rawSignal = 'NEUTRAL';
  if (buyVotes >= 2 && sellVotes === 0) {
    rawSignal = 'STRONG BUY';
  } else if (buyVotes > sellVotes) {
    rawSignal = 'BUY';
  } else if (sellVotes >= 2 && buyVotes === 0) {
    rawSignal = 'STRONG SELL';
  } else if (sellVotes > buyVotes) {
    rawSignal = 'SELL';
  }

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

  let overallColorGlow = 'rgba(255, 255, 255, 0.01)';
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
      }}>
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
