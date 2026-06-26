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

  return (
    <div className="signal-panel-content" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '24px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      
      {/* Main Signal */}
      <div style={{ 
        backgroundColor: 'var(--bg-dark)', 
        border: '1px solid var(--border-color)',
        padding: '16px',
        textAlign: 'center',
        borderRadius: '4px'
      }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '8px' }}>
          OVERALL SIGNAL FOR {symbol}
        </div>
        <div style={{ 
          color: overallColor, 
          fontSize: '1.5rem', 
          fontWeight: 'bold',
          letterSpacing: '2px'
        }}>
          {closes.length === 0 ? 'WAITING...' : overallSignal}
        </div>
        {isFiltered && (
          <div style={{ 
            color: 'var(--accent-blue)', 
            fontSize: '0.75rem', 
            marginTop: '8px',
            borderTop: '1px dashed var(--border-color)',
            paddingTop: '8px',
            lineHeight: '1.3',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px'
          }}>
            <span>⚠️</span> <span>{filterReason}</span>
          </div>
        )}
      </div>

      {/* ── BACKTEST SECTION ─────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel-hover)',
        border: '1px solid var(--border-color)',
        padding: '12px',
        borderRadius: '4px',
        position: 'relative',
      }}>
        <div style={{ position: 'absolute', top: '-8px', left: '10px', background: 'var(--bg-panel)', padding: '0 6px' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: 'bold', letterSpacing: '0.5px' }}>
            BACKTEST HISTÓRICO
          </span>
        </div>

        <div style={{ marginTop: '4px', marginBottom: '10px', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
          Aciertos sobre señales pasadas · ±1.5% umbral
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <BacktestCard name="Standard (RSI+MACD+BB)" result={btStandard} />
          <BacktestCard name="Signal 1 · Confluencia" result={btConfluencia} />
          <BacktestCard name="Signal 2 · Scoring" result={btScoring} />
        </div>
      </div>

      {/* ── BETA Box ────────────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel-hover)',
        border: '1px solid var(--border-color)',
        padding: '12px',
        borderRadius: '4px',
        position: 'relative'
      }}>
        <div style={{ position: 'absolute', top: '-8px', right: '8px', background: 'var(--accent-blue)', color: '#fff', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>BETA</div>

        {/* ── Signal 1: Confluencia ────────────────── */}
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '8px', fontWeight: 'bold', letterSpacing: '0.5px' }}>SIGNAL 1 · CONFLUENCIA (EMA+VWAP+VELAS)</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.85rem' }}>Señal:</span>
          <span style={{ color: exp.signal === 'BUY' ? 'var(--accent-green)' : exp.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-secondary)', fontWeight: 'bold' }}>
            {klines.length > 0 ? exp.signal : 'WAITING...'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.85rem' }}>Stop Loss:</span>
          <span style={{ color: 'var(--text-primary)', fontSize: '0.85rem' }}>
            {exp.stopLoss > 0 ? `$${exp.stopLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem' }}>Volumen:</span>
          <span style={{ color: exp.validVolume ? 'var(--accent-green)' : 'var(--text-secondary)', fontSize: '0.85rem' }}>
            {exp.validVolume ? 'VÁLIDO' : 'BAJO'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
          <span style={{ fontSize: '0.85rem' }}>Cruce EMA 9/20:</span>
          {klines.length > 0 ? (() => {
            const c = exp.emaCrossover;
            if (c.type === 'NONE') {
              return <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Sin cruce reciente</span>;
            }
            const isBull = c.type === 'BULLISH';
            const color  = isBull ? 'var(--accent-green)' : 'var(--accent-red)';
            const icon   = isBull ? '▲' : '▼';
            const label  = isBull ? 'ALCISTA' : 'BAJISTA';
            const when   = c.barsAgo === 0 ? 'esta vela' : `hace ${c.barsAgo} vela${c.barsAgo > 1 ? 's' : ''}`;
            return (
              <span style={{ color, fontSize: '0.85rem', fontWeight: 'bold' }}>
                {icon} {label} <span style={{ fontWeight: 'normal', color: 'var(--text-secondary)' }}>({when})</span>
              </span>
            );
          })() : <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>-</span>}
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px dashed var(--border-color)', margin: '10px 0' }} />

        {/* ── Signal 2: Scoring Multicapa ──────────── */}
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '8px', fontWeight: 'bold', letterSpacing: '0.5px' }}>SIGNAL 2 · SCORING MULTICAPA (5 CAPAS)</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '0.85rem' }}>Señal:</span>
          <span style={{ color: score.signal === 'BUY' ? 'var(--accent-green)' : score.signal === 'SELL' ? 'var(--accent-red)' : 'var(--text-secondary)', fontWeight: 'bold' }}>
            {klines.length > 0 ? score.signal : 'WAITING...'}
          </span>
        </div>

        {/* Score bar -max to +max */}
        <div style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '3px' }}>
            <span>-{score.threshold}</span>
            <span>Score: {score.score > 0 ? '+' : ''}{score.score}</span>
            <span>+{score.threshold}</span>
          </div>
          <div style={{ height: '6px', borderRadius: '3px', background: 'var(--bg-dark)', position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute', top: 0, height: '100%', borderRadius: '3px',
              width: `${score.threshold > 0 ? Math.min(100, (Math.abs(score.score) / score.threshold) * 50) : 0}%`,
              left: score.score >= 0 ? '50%' : `${50 - (score.threshold > 0 ? Math.min(50, (Math.abs(score.score) / score.threshold) * 50) : 0)}%`,
              background: score.signal === 'BUY' ? 'var(--accent-green)' : score.signal === 'SELL' ? 'var(--accent-red)' : 'var(--accent-blue)',
              transition: 'width 0.4s ease'
            }} />
            <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'var(--border-color)' }} />
          </div>
        </div>

        {/* Dynamic Weight Configuration Expandable Panel */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px', marginBottom: '8px' }}>
          <button 
            onClick={() => setShowWeightsConfig(prev => !prev)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent-blue)',
              fontSize: '0.7rem',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: '2px 0'
            }}
          >
            {showWeightsConfig ? 'Ocultar Config. Pesos' : 'Ajustar Pesos de Capas'}
          </button>
        </div>

        {showWeightsConfig && (
          <div style={{
            backgroundColor: 'var(--bg-dark)',
            border: '1px solid var(--border-color)',
            borderRadius: '4px',
            padding: '10px',
            marginBottom: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
              <span>CAPA</span>
              <span>PESO</span>
            </div>
            {(['trend','rsi','bollinger','volume','candle'] as const).map(layer => {
              const labels: Record<string, string> = { trend: 'Tendencia (EMA)', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela' };
              return (
                <div key={layer} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                    <span style={{ color: 'var(--text-primary)' }}>{labels[layer]}</span>
                    <span style={{ color: 'var(--accent-blue)', fontWeight: 'bold' }}>{weights[layer].toFixed(1)}</span>
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
                  padding: '2px 6px',
                  borderRadius: '2px',
                  cursor: 'pointer'
                }}
              >
                Resetear
              </button>
            </div>
          </div>
        )}

        {/* Layer breakdown */}
        {(['trend','rsi','bollinger','volume','candle'] as const).map(layer => {
          const l = score.layers[layer];
          const icon = l.score > 0 ? '▲' : l.score < 0 ? '▼' : '─';
          const col  = l.score > 0 ? 'var(--accent-green)' : l.score < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
          const labels: Record<string, string> = { trend: 'Tendencia', rsi: 'RSI', bollinger: 'Bollinger', volume: 'Volumen', candle: 'Vela' };
          const weight = weights[layer];
          return (
            <div key={layer} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '4px', fontSize: '0.75rem' }}>
              <span style={{ color: col, fontWeight: 'bold', minWidth: '48px', display: 'inline-flex', alignItems: 'center' }}>
                <span>{icon}{l.score > 0 ? '+' : ''}{l.score}</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '3px' }}>
                  ({weight.toFixed(1)}x)
                </span>
              </span>
              <div>
                <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{labels[layer]}: </span>
                <span style={{ color: 'var(--text-secondary)' }}>{l.note}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Indicators List */}
      <div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
          TECHNICAL INDICATORS
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {indicators.map(ind => (
            <div key={ind.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ color: 'var(--text-primary)' }}>{ind.name}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{closes.length > 0 ? ind.value : '-'}</div>
              </div>
              <div style={{ 
                color: ind.color, 
                fontWeight: 'bold',
                padding: '2px 6px',
                border: `1px solid ${ind.color}`,
                borderRadius: '2px',
                fontSize: '0.7rem'
              }}>
                {closes.length > 0 ? ind.signal : '-'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* News Feed */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: '16px' }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
          LATEST NEWS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.85rem' }}>
          {loadingNews ? (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '16px 0' }}>Loading news...</div>
          ) : news.length > 0 ? (
            news.map((item, index) => (
              <a key={index} href={item.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'block' }}>
                <div style={{ color: 'var(--accent-blue)', marginBottom: '4px', lineHeight: '1.3' }}>{item.time} - {item.title}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{item.source}</div>
              </a>
            ))
          ) : (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '16px 0' }}>No recent news</div>
          )}
        </div>
      </div>

    </div>
  );
}
