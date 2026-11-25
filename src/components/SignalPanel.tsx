import { useMemo, useState, useEffect } from 'react';
import { calculateExperimentalSignal, calculateScoringSignal, calculateStandardVoting, calculateVCMESniperSignal, calculateMultifractalMTFSignal, calculateMFLSSignal, getConfirmedClosedKlines, getEffectiveExecutionPrice, type VCMESniperResult, type MultifractalMTFSignalResult, type MFLSEvaluationResult, type ScoringWeights, DEFAULT_WEIGHTS } from '../utils/indicators';
import { runQVESelection, selectActionableStrategy, buildStrategyCandidateQueue, resolveCandidateCascade, resolveTournamentLeader, isInformationalStrategy } from '../utils/tournament';
import type { Kline } from '../services/api';
import { Bell, BellOff, FlaskConical, ShieldAlert, Target, Trophy, Info, ChevronUp, ChevronDown } from 'lucide-react';
import BacktestCard from './BacktestCard';
import { formatSmartPrice, formatSmartNumber } from '../utils/formatters';
import { resolveOperationalTrade } from '../utils/operationalTrade';
import { isCryptoAsset } from '../utils/tradeLevels';
import { CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT } from '../utils/strategyEvaluators';
import PositionCalculator from './PositionCalculator';
import MarketContextTab from './MarketContextTab';
import type { EarningsEvent } from '../utils/marketEvents';

interface SignalPanelProps {
  symbol: string;
  closes: number[];
  volume: number;
  klines: Kline[];
  interval: string;
  notificationsEnabled: boolean;
  toggleNotifications: () => void;
  confluenceSignals: Record<string, string>;
  earningsEvent: EarningsEvent | null;
  allKlines: Record<string, Kline[]>;
  executionStyle: 'dayTrading' | 'swing';
  setExecutionStyle: (s: 'dayTrading' | 'swing') => void;
  triggerMode: 'agresivo' | 'conservador';
  setTriggerMode: (m: 'agresivo' | 'conservador') => void;
  weights: ScoringWeights;
  setWeights: React.Dispatch<React.SetStateAction<ScoringWeights>>;
}

function InformationalBadge() {
  return (
    <span
      className="term-badge term-badge--purple"
      title="Sin ventaja neta validada en acciones 5m (60 días, 21 papeles): se muestra para que la evalúes, pero no compite en el torneo ni genera alertas principales. Activá el modo laboratorio en el historial para registrar sus señales."
    >
      INFORMATIVA
    </span>
  );
}

export default function SignalPanel({ 
  symbol, 
  closes, 
  klines, 
  interval, 
  notificationsEnabled, 
  toggleNotifications,
  confluenceSignals,
  earningsEvent,
  allKlines,
  executionStyle,
  setExecutionStyle,
  triggerMode,
  setTriggerMode,
  weights,
  setWeights,
}: SignalPanelProps) {
  const isCrypto = useMemo(() => isCryptoAsset(symbol), [symbol]);
  const [showWeightsConfig, setShowWeightsConfig] = useState(false);
  const [activeTab, setActiveTab] = useState<'strategies' | 'calculator' | 'market'>('strategies');
  const [expandedStrategy, setExpandedStrategy] = useState<string | null>(null);
  // Informational engines (no alerts, no tournament) stay collapsed behind one row unless the user opens them
  const [showInformational, setShowInformational] = useState<boolean>(() => {
    try { return localStorage.getItem('terminal_show_informational') === 'true'; } catch { return false; }
  });
  const toggleInformational = () => setShowInformational(prev => {
    try { localStorage.setItem('terminal_show_informational', String(!prev)); } catch { /* storage unavailable */ }
    return !prev;
  });

  // Closed candle confirmation: dynamically preserves confirmed closed candles without weekend/after-hours lag
  const closedKlines = useMemo(() => {
    return getConfirmedClosedKlines(klines, interval, symbol);
  }, [klines, interval, symbol]);

  // Extract klines for the VCME Sniper 3-layer strategy
  const klines5m = useMemo(() => allKlines['5m'] || [], [allKlines]);
  const klines1h = useMemo(() => allKlines['1h'] || [], [allKlines]);
  const klines1d = useMemo(() => allKlines['1d'] || [], [allKlines]);

  const closedKlines5m = useMemo(() => getConfirmedClosedKlines(klines5m, '5m', symbol), [klines5m, symbol]);
  const closedKlines1h = useMemo(() => getConfirmedClosedKlines(klines1h, '1h', symbol), [klines1h, symbol]);
  const closedKlines1d = useMemo(() => getConfirmedClosedKlines(klines1d, '1d', symbol), [klines1d, symbol]);

  // ── Strategy Tournament (Sync overall signal with App.tsx and MarketRadar.tsx) ───────────────
  const qveResult = useMemo(() => {
    return runQVESelection({
      symbol,
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle,
      triggerMode,
      scoringWeights: weights,
    });
  }, [symbol, klines5m, klines1h, klines1d, executionStyle, triggerMode, weights]);

  // Leader consistent with what the scanner can alert (Confluencia on 5m equities, tournament winner elsewhere)
  const leader = useMemo(() => resolveTournamentLeader(qveResult), [qveResult]);
  const bestStrategy = leader.strategyKey;
  const isInfo = (strategyKey: string) => isInformationalStrategy(strategyKey, qveResult.targetInterval, isCrypto);
  const hideInfo = (strategyKey: string) => isInfo(strategyKey) && !showInformational;

  // ── Unified Backtest Results (Sourced directly from QVE Tournament SSOT) ─────────────
  const btStandard      = qveResult.btStd;
  const btConfluencia   = qveResult.btConf;
  const btScoring       = qveResult.btScore;
  const btMultitemporal = qveResult.btMulti;
  const btMultifractal  = qveResult.btMF;
  const btMFLS          = qveResult.btMFLS;

  // ── Visual Technical Indicators (For current chart timeframe view) ────────────────────
  const votingVisual = useMemo(() => calculateStandardVoting(closedKlines), [closedKlines]);
  const indicators   = votingVisual.indicators;

  // ── Operational Strategy Signals (Evaluated on QVE trigger klines and target interval) ──
  const votingStrategy = useMemo(() => calculateStandardVoting(qveResult.triggerKlines), [qveResult.triggerKlines]);
  const rawSignal      = votingStrategy.rawSignal;
  const exp            = useMemo(() => calculateExperimentalSignal(qveResult.triggerKlines, qveResult.targetInterval, isCrypto), [qveResult.triggerKlines, qveResult.targetInterval, isCrypto]);
  const score          = useMemo(() => calculateScoringSignal(qveResult.triggerKlines, qveResult.targetInterval, weights, isCrypto), [qveResult.triggerKlines, qveResult.targetInterval, weights, isCrypto]);
  
  const multi: VCMESniperResult = useMemo(() => {
    const liveKlines = executionStyle === 'swing' ? klines1h : klines5m;
    const execPrice = getEffectiveExecutionPrice(liveKlines, qveResult.triggerKlines);
    return calculateVCMESniperSignal(
      qveResult.triggerKlines,
      closedKlines1h,
      closedKlines1d,
      symbol,
      btMultitemporal ? btMultitemporal.winRate : undefined,
      btMultitemporal ? btMultitemporal.profitFactor : undefined,
      executionStyle,
      triggerMode,
      execPrice
    );
  }, [klines5m, klines1h, qveResult.triggerKlines, closedKlines1h, closedKlines1d, symbol, btMultitemporal, executionStyle, triggerMode]);

  const multifractal: MultifractalMTFSignalResult = useMemo(() => {
    const execPrice = getEffectiveExecutionPrice(klines5m, closedKlines5m);
    return calculateMultifractalMTFSignal(closedKlines5m, closedKlines1h, closedKlines1d, symbol, execPrice);
  }, [closedKlines5m, closedKlines1h, closedKlines1d, klines5m, symbol]);

  const mfls: MFLSEvaluationResult = useMemo(() => {
    const execPrice = getEffectiveExecutionPrice(klines5m, closedKlines5m);
    return calculateMFLSSignal(closedKlines5m, symbol, execPrice);
  }, [closedKlines5m, klines5m, symbol]);

  const confluenciaPlan = useMemo(() => {
    const sig = exp.signal;
    if (!sig || sig === 'NEUTRAL') return null;
    return resolveOperationalTrade({
      strategy: 'confluencia',
      signal: sig,
      executionStyle,
      raw: { '5m': klines5m, '1h': klines1h },
      closed: { '5m': closedKlines5m, '1h': closedKlines1h },
      isCrypto,
    });
  }, [exp.signal, executionStyle, klines5m, klines1h, closedKlines5m, closedKlines1h, isCrypto]);

  // Synchronize expanded strategy with the best strategy when it changes
  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync: expandedStrategy tracks the auto-selected best strategy */
  useEffect(() => {
    if (bestStrategy && bestStrategy !== 'NONE') {
      setExpandedStrategy(bestStrategy);
    }
  }, [bestStrategy]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { operationalStrategy, overallSignal, displayedConfidence, displayedReasoning } = useMemo(() => {
    const strategySignals = {
      standard: votingStrategy.signal,
      confluencia: exp.signal,
      scoring: score.signal,
      multitemporal: multi.signal,
      multifractal: multifractal.signal,
      mfls: mfls.signal,
    };
    // Same candidate queue and cascade as the App scanner (shared helpers in tournament.ts)
    const cascade = resolveCandidateCascade(buildStrategyCandidateQueue(qveResult, strategySignals), candidate => resolveOperationalTrade({
      strategy: candidate.strategy,
      signal: candidate.signal,
      executionStyle,
      raw: { '5m': klines5m, '1h': klines1h },
      closed: { '5m': closedKlines5m, '1h': closedKlines1h },
      vcme: multi,
      multifractal,
      mfls,
      isCrypto,
    }));
    const viable = cascade.viable?.candidate ?? null;
    const firstRejected = cascade.firstRejected?.candidate ?? null;

    if (viable) {
      return {
        actionableSelection: viable,
        operationalStrategy: viable.strategy,
        overallSignal: viable.signal,
        displayedConfidence: viable.confidence,
        displayedReasoning: viable.reasoning,
      };
    }

    if (firstRejected) {
      return {
        actionableSelection: firstRejected,
        operationalStrategy: firstRejected.strategy,
        overallSignal: firstRejected.signal,
        displayedConfidence: firstRejected.confidence,
        displayedReasoning: firstRejected.reasoning,
      };
    }

    const defaultActionable = selectActionableStrategy(qveResult, strategySignals);

    return {
      actionableSelection: defaultActionable,
      operationalStrategy: bestStrategy,
      overallSignal: 'NEUTRAL' as const,
      displayedConfidence: leader.confidence,
      displayedReasoning: leader.reasoning,
    };
  }, [
    qveResult,
    votingStrategy.signal,
    exp.signal,
    score.signal,
    multi,
    multifractal,
    mfls,
    executionStyle,
    klines5m,
    klines1h,
    closedKlines5m,
    closedKlines1h,
    isCrypto,
    bestStrategy,
    leader.confidence,
    leader.reasoning,
  ]);

  let overallColor = 'var(--text-primary)';
  if (overallSignal.includes('BUY')) {
    overallColor = 'var(--accent-green)';
  } else if (overallSignal.includes('SELL')) {
    overallColor = 'var(--accent-red)';
  } else if (overallSignal === 'NEUTRAL') {
    overallColor = 'var(--text-secondary)';
  }

  let overallColorGlow = 'none';
  let overallBorder = 'var(--border-color)';
  let overallBg = 'linear-gradient(135deg, rgba(255, 255, 255, 0.01) 0%, rgba(0, 0, 0, 0.1) 100%)';
  if (closes.length > 0) {
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
        {closes.length > 0 && displayedReasoning && (
          <div style={{
            marginTop: '8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 10px',
            borderRadius: '12px',
            fontSize: '0.62rem',
            fontWeight: '700',
            background: displayedConfidence === 'HIGH' ? 'rgba(34, 197, 94, 0.12)' : displayedConfidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(255, 255, 255, 0.05)',
            border: `1px solid ${displayedConfidence === 'HIGH' ? 'rgba(34, 197, 94, 0.3)' : displayedConfidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
            color: displayedConfidence === 'HIGH' ? 'var(--accent-green)' : displayedConfidence === 'LIMITED' ? '#eab308' : 'var(--text-muted)'
          }}>
            <span title={isCrypto
              ? 'Resume el backtest reciente de este activo. En cripto no se validó fuera de muestra: no garantiza ventaja futura.'
              : 'Resume el backtest reciente de este papel. En acciones, ningún motor mostró ventaja fuera de muestra (5m: oct-2026; 1h: 2023–2026, incluso antes de costos).'}>
              {displayedConfidence === 'HIGH' ? '📊 Backtest favorable (no validado fuera de muestra)' :displayedConfidence === 'LIMITED' ? '⚠️ Backtest con muestra limitada' : '🛡️ Sin ventaja en el backtest'}
            </span>
            <span style={{ opacity: 0.85, fontWeight: '500' }}>· {displayedReasoning}</span>
          </div>
        )}
        {bestStrategy === 'standard' && votingStrategy.rawSignal !== 'NEUTRAL' && votingStrategy.signal === 'NEUTRAL' && (
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
            <span>⚠️</span> <span>Señal preliminar ({votingStrategy.rawSignal}) filtrada por confirmación interna (RVOL / EMA 200 / Anatomía)</span>
          </div>
        )}
      </div>

      {/* ── GLOBAL OPERATIONAL PROFILE SELECTOR ───────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        padding: '10px 14px',
        borderRadius: 'var(--border-radius-md)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '0.68rem', fontWeight: '800', color: 'var(--text-secondary)', letterSpacing: '0.5px' }}>
            PERFIL OPERATIVO GLOBAL
          </span>
          <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>
            {executionStyle === 'dayTrading' ? 'Torneo y Alertas en 5m (Intradía)' : 'Torneo y Alertas en 1H (Swing)'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.3)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
          <button
            onClick={() => setExecutionStyle('dayTrading')}
            style={{
              backgroundColor: executionStyle === 'dayTrading' ? 'var(--accent-blue)' : 'transparent',
              color: executionStyle === 'dayTrading' ? '#fff' : 'var(--text-secondary)',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: '0.65rem',
              fontWeight: '800',
              transition: 'all 0.2s'
            }}
            title="Escanear y alertar en velas de 5m para operaciones intradía rápidas"
          >
            ⚡ INTRADÍA (5M)
          </button>
          <button
            onClick={() => setExecutionStyle('swing')}
            style={{
              backgroundColor: executionStyle === 'swing' ? 'var(--accent-blue)' : 'transparent',
              color: executionStyle === 'swing' ? '#fff' : 'var(--text-secondary)',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: '0.65rem',
              fontWeight: '800',
              transition: 'all 0.2s'
            }}
            title="Escanear y alertar en velas de 1H para operaciones swing de días"
          >
            🌊 SWING (1H)
          </button>
        </div>
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
            if (hideInfo(id)) return null;
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = rawSignal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const resolvedCount = btStandard ? (btStandard.wins + btStandard.losses) : 0;
            const winRateText = btStandard && !btStandard.insufficient && resolvedCount > 0 
              ? `${Math.round(btStandard.winRate * 100)}% WR` 
              : '— WR';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Estándar</span>
                    {isInfo('standard') && <InformationalBadge />}
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(RSI+MACD+BB)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: leader.confidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-blue-bg)', 
                        color: leader.confidence === 'LIMITED' ? '#eab308' : 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: leader.confidence === 'LIMITED' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        {leader.confidence === 'LIMITED' ? 'LÍDER ⚠️' : 'LÍDER'}
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
            const resolvedCount = btConfluencia ? (btConfluencia.wins + btConfluencia.losses) : 0;
            const winRateText = btConfluencia && !btConfluencia.insufficient && resolvedCount > 0 
              ? `${Math.round(btConfluencia.winRate * 100)}% WR` 
              : '— WR';
            
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
                        background: leader.confidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-blue-bg)', 
                        color: leader.confidence === 'LIMITED' ? '#eab308' : 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: leader.confidence === 'LIMITED' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        {leader.confidence === 'LIMITED' ? 'LÍDER ⚠️' : 'LÍDER'}
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
                              {confluenciaPlan && confluenciaPlan.levels.stopLoss > 0
                                ? formatSmartPrice(confluenciaPlan.levels.stopLoss)
                                : (exp.stopLoss > 0 ? formatSmartPrice(exp.stopLoss) : '-')}
                            </span>
                          </div>
                          {confluenciaPlan && confluenciaPlan.levels.takeProfit1 > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Target Profit (1.5R):</span>
                              <span style={{ color: 'var(--accent-green)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
                                {formatSmartPrice(confluenciaPlan.levels.takeProfit1)}
                              </span>
                            </div>
                          )}
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
                          {!isCrypto && qveResult.targetInterval === '5m' && klines.length > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span
                                style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}
                                title="En acciones 5m, Confluencia solo opera si el ATR(14) de la vela es al menos 0,5% del precio. Con menos volatilidad, la comisión y el deslizamiento se comen demasiado del stop."
                              >
                                Volatilidad (ATR ≥ 0,5%):
                              </span>
                              <span style={{
                                color: (exp.atrPct ?? 0) >= CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT ? 'var(--accent-green)' : 'var(--accent-red)',
                                fontSize: '0.75rem',
                                fontWeight: '600',
                                fontFamily: 'var(--font-mono)'
                              }}>
                                {((exp.atrPct ?? 0) * 100).toFixed(2)}%{exp.lowVolatility ? ' · SEÑAL BLOQUEADA' : (exp.atrPct ?? 0) >= CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT ? '' : ' · INSUFICIENTE'}
                              </span>
                            </div>
                          )}
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
            if (hideInfo(id)) return null;
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = score.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const resolvedCount = btScoring ? (btScoring.wins + btScoring.losses) : 0;
            const winRateText = btScoring && !btScoring.insufficient && resolvedCount > 0 
              ? `${Math.round(btScoring.winRate * 100)}% WR` 
              : '— WR';
            
            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Scoring</span>
                    {isInfo('scoring') && <InformationalBadge />}
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(5 Capas)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: leader.confidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-blue-bg)', 
                        color: leader.confidence === 'LIMITED' ? '#eab308' : 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: leader.confidence === 'LIMITED' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        {leader.confidence === 'LIMITED' ? 'LÍDER ⚠️' : 'LÍDER'}
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
                            {showWeightsConfig ? 'Ocultar Pesos ✕' : 'Avanzado: Pesos ⚙️'}
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
                            <div style={{ fontSize: '0.6rem', color: '#eab308', lineHeight: 1.35 }}>
                              Ajuste avanzado. Ninguna combinación de pesos mostró ventaja medida; mover los pesos hasta que el backtest de un papel mejore es sobreajuste. Los pesos también cambian las señales y el torneo.
                            </div>
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
            if (hideInfo(id)) return null;
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = multi.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const resolvedCount = btMultitemporal ? (btMultitemporal.wins + btMultitemporal.losses) : 0;
            const winRateText = btMultitemporal && !btMultitemporal.insufficient && resolvedCount > 0 
              ? `${Math.round(btMultitemporal.winRate * 100)}% WR` 
              : '— WR';
            const modeLabel = multi.mode === 'BREAKOUT' ? '🔥 RUPTURA' : multi.mode === 'PULLBACK' ? '🎯 PULLBACK' : '';
            
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
                    {isInfo('multitemporal') && <InformationalBadge />}
                    {isRecommended && (
                      <span style={{ 
                        background: leader.confidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-blue-bg)', 
                        color: leader.confidence === 'LIMITED' ? '#eab308' : 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: leader.confidence === 'LIMITED' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        {leader.confidence === 'LIMITED' ? 'LÍDER ⚠️' : 'LÍDER'}
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
                    {sig !== 'NEUTRAL' && multi.confidence && (
                      <span
                        title="Puntaje interno del motor (0–100). Ordena los setups según sus propias reglas; no es una probabilidad de acierto ni está validado fuera de muestra."
                        style={{
                          fontSize: '0.55rem',
                          fontWeight: '800',
                          color: 'var(--text-secondary)',
                          backgroundColor: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          letterSpacing: '0.5px'
                        }}
                      >
                        PUNTAJE {multi.score}
                      </span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                      {winRateText}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-strategy-card-content">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      
                      {/* Selector de Modo de Gatillo VCME */}
                      <div style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--border-radius-sm)',
                        padding: '10px 12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Gatillo VCME:</span>
                          <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>
                            {triggerMode === 'agresivo' ? 'Disparo en vela de ruptura' : 'Confirmación por retest'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            onClick={() => setTriggerMode('agresivo')}
                            style={{
                              backgroundColor: triggerMode === 'agresivo' ? 'var(--accent-blue)' : 'rgba(0,0,0,0.3)',
                              color: triggerMode === 'agresivo' ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border-color)',
                              borderRadius: '4px',
                              padding: '3px 8px',
                              cursor: 'pointer',
                              fontSize: '0.65rem',
                              fontWeight: 'bold'
                            }}
                          >
                            Ruptura
                          </button>
                          <button
                            onClick={() => setTriggerMode('conservador')}
                            style={{
                              backgroundColor: triggerMode === 'conservador' ? 'var(--accent-blue)' : 'rgba(0,0,0,0.3)',
                              color: triggerMode === 'conservador' ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border-color)',
                              borderRadius: '4px',
                              padding: '3px 8px',
                              cursor: 'pointer',
                              fontSize: '0.65rem',
                              fontWeight: 'bold'
                            }}
                          >
                            Retest
                          </button>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>RENDIMIENTO HISTÓRICO</div>
                        <BacktestCard name={`VCME Sniper (${executionStyle === 'swing' ? 'Swing' : 'Intradía'})`} result={btMultitemporal} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>CONFLUENCIA & SCORING ADAPTATIVO</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(59, 130, 246, 0.04)', padding: '10px 12px', borderRadius: '6px', border: '1px solid rgba(59, 130, 246, 0.15)', marginBottom: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span
                              style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}
                              title="Ordena los setups según las reglas del propio motor; no es una probabilidad de acierto ni está validado fuera de muestra."
                            >
                              🎯 Puntaje interno del motor:
                            </span>
                            <span style={{ color: multi.score >= 76 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: '800', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                              {multi.score} / 100
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
                            <span style={{ color: 'var(--text-muted)' }}>Score Base: {multi.baseScore} pts</span>
                            <span style={{ color: 'var(--accent-blue)', fontWeight: 'bold' }}>Multiplicador: {multi.adaptiveFactor}x</span>
                          </div>
                          <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                            <div>🌍 Régimen: <span style={{ color: '#fff' }}>{multi.marketRegime}</span></div>
                            <div>📊 Perfil Volatilidad Activo: <span style={{ color: '#fff' }}>{multi.volatilityProfile}</span></div>
                            <div>🔄 Meta-Learning (Performance Reciente): <span style={{ color: '#fff' }}>{multi.recentPerfLabel}</span></div>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>SISTEMA DE 3 CAPAS</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                          {/* Layer 1: 1D Bias */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>📊 Trend 1D (Precio &gt; EMA200 &amp; EMA20 &gt; EMA50):</span>
                            <span style={{ color: biasColor, fontWeight: '700', fontSize: '0.75rem' }}>
                              {multi.bias1D === 'ALCISTA' ? '▲ ALCISTA' : multi.bias1D === 'BAJISTA' ? '▼ BAJISTA' : '─ NEUTRAL'}
                              <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', fontSize: '0.7rem', marginLeft: '4px' }}>
                                (${multi.ema200_1D})
                              </span>
                            </span>
                          </div>
                          {/* Layer 2: 1H Setup */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                             <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>⚡ Setup 1H (EMA20 &gt; EMA50 &amp; RSI Zona Sana):</span>
                            <span style={{ color: momColor, fontWeight: '700', fontSize: '0.75rem' }}>
                              {multi.momentum1H === 'ALCISTA' ? '▲ COMPRESION OK' : multi.momentum1H === 'BAJISTA' ? '▼ COMPRESION OK' : '─ INACTIVO'}
                            </span>
                          </div>
                          {/* Layer 3: Gatillo */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>🎯 Gatillo {executionStyle === 'swing' ? '1H' : '5m'} (Pullback/Ruptura):</span>
                            <span style={{ 
                              color: multi.mode !== 'NONE' ? sigColor : 'var(--text-muted)', 
                              fontWeight: '700', fontSize: '0.7rem',
                              maxWidth: '55%', textAlign: 'right'
                            }}>
                              {multi.mode === 'BREAKOUT' ? '🔥 RUPTURA' : multi.mode === 'PULLBACK' ? '🎯 PULLBACK' : '— Esperando'}
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
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '800', letterSpacing: '0.5px' }}>GESTIÓN DE RIESGO SUGERIDA (ATR)</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }}>🛑 Stop Loss:</span>
                              <span style={{ color: 'var(--accent-red)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multi.stopLoss)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>🎯 TP1 (2.0R — cerrar 50% + BE):</span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multi.takeProfit1)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>🏆 TP2 (3.5R — cerrar 25%):</span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multi.takeProfit2)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>🚀 TP3 (5.0R — 25% + trailing):</span>
                              <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multi.takeProfit3)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-blue)' }}>⚖️ R:R Ratio:</span>
                              <span style={{ color: 'var(--accent-blue)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>1:{formatSmartNumber(multi.riskRewardRatio, 1)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* S/R Levels */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>S/R ({executionStyle === 'swing' ? '1H' : '5m'}):</span>
                        <span style={{ color: 'var(--text-primary)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                          {klines.length > 0 ? `S: ${multi.nearestSupport > 0 ? formatSmartPrice(multi.nearestSupport) : '-'} | R: ${multi.nearestResistance > 0 ? formatSmartPrice(multi.nearestResistance) : '-'}` : '-'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 5. Estrategia Multifractal MTF Engine */}
          {(() => {
            const id = 'multifractal';
            if (hideInfo(id)) return null;
            const isExpanded = expandedStrategy === id;
            const isRecommended = bestStrategy === id;
            const sig = multifractal.signal;
            const sigColor = sig.includes('BUY') ? 'var(--accent-green)' : sig.includes('SELL') ? 'var(--accent-red)' : 'var(--text-secondary)';
            const sigBg = sig.includes('BUY') ? 'var(--accent-green-bg)' : sig.includes('SELL') ? 'var(--accent-red-bg)' : 'rgba(255,255,255,0.02)';
            const resolvedCount = btMultifractal ? (btMultifractal.wins + btMultifractal.losses) : 0;
            const winRateText = btMultifractal && !btMultifractal.insufficient && resolvedCount > 0 
              ? `${Math.round(btMultifractal.winRate * 100)}% WR` 
              : '— WR';
            const stratLabel = multifractal.strategy === 'BREAKOUT_EXPANSION' ? '⚡ RUPTURA EXPANSIÓN' : multifractal.strategy === 'MEAN_REVERSION' ? '🔄 REVERSIÓN MEDIA' : '';

            return (
              <div className={`sp-strategy-card ${isRecommended ? 'recommended' : ''}`}>
                <div 
                  className="sp-strategy-card-header" 
                  onClick={() => setExpandedStrategy(isExpanded ? null : id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff' }}>Multifractal MTF</span>
                    {isInfo('multifractal') && <InformationalBadge />}
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>(1D+1H+5M)</span>
                    {isRecommended && (
                      <span style={{ 
                        background: leader.confidence === 'LIMITED' ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-blue-bg)', 
                        color: leader.confidence === 'LIMITED' ? '#eab308' : 'var(--accent-blue)', 
                        fontSize: '0.55rem', 
                        padding: '1px 6px', 
                        borderRadius: '4px', 
                        fontWeight: '800', 
                        border: leader.confidence === 'LIMITED' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(59, 130, 246, 0.2)' 
                      }}>
                        {leader.confidence === 'LIMITED' ? 'LÍDER ⚠️' : 'LÍDER'}
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
                      {closes.length === 0 ? 'WAITING...' : sig === 'NEUTRAL' ? 'NEUTRO' : `${sig} ${stratLabel}`}
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
                        <BacktestCard name="Signal 5 · Multifractal MTF Engine" result={btMultifractal} />
                      </div>

                      {/* LAYER 1: Macro 1D — Andian Oscillator */}
                      <div style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>CAPA 1 · SESGO MACRO (1D ANDIAN)</div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Sesgo Direccional:</span>
                          <span style={{
                            fontWeight: '700',
                            padding: '1px 8px',
                            borderRadius: '4px',
                            color: multifractal.bias1D === 'BULLISH' ? 'var(--accent-green)' : multifractal.bias1D === 'BEARISH' ? 'var(--accent-red)' : 'var(--text-muted)',
                            backgroundColor: multifractal.bias1D === 'BULLISH' ? 'rgba(16, 185, 129, 0.08)' : multifractal.bias1D === 'BEARISH' ? 'rgba(244, 63, 94, 0.08)' : 'transparent',
                            border: `1px solid ${multifractal.bias1D === 'BULLISH' ? 'rgba(16, 185, 129, 0.2)' : multifractal.bias1D === 'BEARISH' ? 'rgba(244, 63, 94, 0.2)' : 'rgba(255,255,255,0.06)'}`
                          }}>
                            {multifractal.bias1D === 'BULLISH' ? '▲ ALCISTA' : multifractal.bias1D === 'BEARISH' ? '▼ BAJISTA' : '─ NEUTRAL'}
                          </span>
                        </div>

                        <div style={{ display: 'flex', gap: '6px' }}>
                          <div style={{ flex: 1, background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '6px 8px', textAlign: 'center' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: '2px' }}>GREEN</div>
                            <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}>{multifractal.andianGreen}</div>
                          </div>
                          <div style={{ flex: 1, background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '6px 8px', textAlign: 'center' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: '2px' }}>RED</div>
                            <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>{multifractal.andianRed}</div>
                          </div>
                          <div style={{ flex: 1, background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '6px 8px', textAlign: 'center' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: '2px' }}>ORANGE</div>
                            <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#f59e0b', fontFamily: 'var(--font-mono)' }}>{multifractal.andianOrange}</div>
                          </div>
                        </div>
                      </div>

                      {/* LAYER 2: Context 1H — Volatility Squeeze */}
                      <div style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>CAPA 2 · CONTEXTO VOLATILIDAD (1H)</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Revolution Band Squeeze:</span>
                          <span style={{
                            fontWeight: '700',
                            color: multifractal.isCompressed1H ? '#38bdf8' : 'var(--text-muted)'
                          }}>
                            {multifractal.isCompressed1H ? '⚡ COMPRIMIDO (P15)' : 'NORMAL'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Ancho de Canal:</span>
                          <span style={{ fontWeight: '600', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                            {multifractal.volatilityWidth1H}
                          </span>
                        </div>
                      </div>

                      {/* LAYER 3: Trigger 5M — Volume + Dread Blitz */}
                      <div style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>CAPA 3 · GATILLO (5M)</div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Dread Blitz MCD:</span>
                          <span style={{
                            fontWeight: '700',
                            fontFamily: 'var(--font-mono)',
                            color: multifractal.isOverbought5M ? 'var(--accent-red)' : multifractal.isOversold5M ? 'var(--accent-green)' : 'var(--text-primary)'
                          }}>
                            {multifractal.dreadBlitzMCD}
                            {multifractal.isOverbought5M && ' ⬆ SOBRECOMPRA'}
                            {multifractal.isOversold5M && ' ⬇ SOBREVENTA'}
                          </span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Vol. Multiplicador (vs SMA20):</span>
                          <span style={{
                            fontWeight: '700',
                            fontFamily: 'var(--font-mono)',
                            color: multifractal.volumeMultiplier5M >= 1.5 ? 'var(--accent-green)' : 'var(--text-muted)'
                          }}>
                            {multifractal.volumeMultiplier5M}x {multifractal.volumeMultiplier5M >= 1.5 ? '✓' : ''}
                          </span>
                        </div>

                        {/* Volume Composition Bar */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '3px' }}>
                            <span>Compra Activa: {multifractal.activeVolumePercent5M}%</span>
                            <span>Venta Activa: {(100 - multifractal.activeVolumePercent5M).toFixed(1)}%</span>
                          </div>
                          <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex' }}>
                            <div style={{
                              width: `${multifractal.activeVolumePercent5M}%`,
                              background: 'var(--accent-green)',
                              borderRadius: '3px 0 0 3px',
                              transition: 'width 0.4s ease'
                            }} />
                            <div style={{
                              flex: 1,
                              background: 'var(--accent-red)',
                              borderRadius: '0 3px 3px 0'
                            }} />
                          </div>
                        </div>
                      </div>

                      {/* Risk Management & Reasoning */}
                      {multifractal.signal !== 'NEUTRAL' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(0,0,0,0.12)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px', marginBottom: '2px' }}>GESTIÓN DE RIESGO E INVALIDACIÓN</div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Precio de Entrada:</span>
                            <span style={{ color: 'var(--text-primary)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multifractal.triggerPrice)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }}>🛑 Stop Loss:</span>
                            <span style={{ color: 'var(--accent-red)', fontWeight: '700', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(multifractal.stopLoss)}</span>
                          </div>
                          <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-secondary)',
                            fontStyle: 'italic',
                            lineHeight: '1.3',
                            padding: '6px 8px',
                            background: 'rgba(56, 189, 248, 0.04)',
                            border: '1px solid rgba(56, 189, 248, 0.1)',
                            borderRadius: '4px',
                            marginTop: '2px'
                          }}>
                            💡 {multifractal.reasoning}
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', lineHeight: '1.3', marginTop: '2px' }}>
                            ⚠️ Invalidación automática: si el cierre cae bajo el punto medio de la banda en las próximas 3 velas de 5m, la tesis de velocidad institucional queda anulada.
                          </div>
                        </div>
                      )}

                      {/* Reasoning when NEUTRAL */}
                      {multifractal.signal === 'NEUTRAL' && (
                        <div style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-muted)',
                          fontStyle: 'italic',
                          padding: '8px 10px',
                          background: 'rgba(0,0,0,0.1)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '6px',
                          lineHeight: '1.3'
                        }}>
                          {multifractal.reasoning}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 6. Estrategia MACD Failure & Liquidity Sweep (MFLS) */}
          {(() => {
            if (hideInfo('mfls')) return null;
            const isBest = bestStrategy === 'mfls';
            const cardSignal = mfls.signal;
            const sigColor = cardSignal === 'BUY' ? 'var(--accent-green)' : cardSignal === 'SELL' ? 'var(--accent-red)' : 'var(--text-secondary)';
            const isExpanded = expandedStrategy === 'mfls';

            return (
              <div style={{
                border: isBest ? '1px solid var(--accent-blue)' : '1px solid var(--border-color)',
                borderRadius: '8px',
                backgroundColor: 'var(--card-bg, rgba(255, 255, 255, 0.02))',
                overflow: 'hidden'
              }}>
                <div
                  onClick={() => setExpandedStrategy(isExpanded ? null : 'mfls')}
                  style={{
                    padding: '12px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    background: isBest ? 'rgba(0, 229, 255, 0.05)' : 'transparent'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '0.9rem' }}>🎯</span>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: '700', fontSize: '0.85rem' }}>MFLS (Reversión)</span>
                        {isInfo('mfls') && <InformationalBadge />}
                        {isBest && (
                          <span style={{
                            fontSize: '0.6rem',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: 'var(--accent-blue)',
                            color: '#000',
                            fontWeight: '800'
                          }}>
                            LÍDER
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Barrido de Liquidez &amp; Fallo de MACD (5m)
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      fontWeight: '800',
                      fontSize: '0.75rem',
                      color: sigColor,
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: cardSignal !== 'NEUTRAL' ? (cardSignal === 'BUY' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(244, 63, 94, 0.1)') : 'rgba(255, 255, 255, 0.05)'
                    }}>
                      {cardSignal}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {btMFLS && (
                      <BacktestCard
                        name="Signal 6 · MACD Failure & Liquidity Sweep (MFLS)"
                        result={btMFLS}
                      />
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {/* Sub-indicadores de MFLS */}
                      <div style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>ESTRUCTURA &amp; TRAMPA DE LIQUIDEZ</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Nivel Barrido:</span>
                          <span style={{ fontWeight: '600', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                            {mfls.pivotReference > 0 ? `$${formatSmartPrice(mfls.pivotReference)}` : 'Buscando pivote...'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Penetración / Reclaim:</span>
                          <span style={{
                            fontWeight: '700',
                            color: mfls.isReclaim
                              ? (mfls.signal === 'NEUTRAL'
                                ? 'var(--text-muted)'
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL' ? 'var(--accent-red)' : 'var(--accent-green)'))
                              : 'var(--text-muted)'
                          }}>
                            {mfls.isReclaim
                              ? (mfls.signal === 'NEUTRAL'
                                ? `Reclaim descartado (${(mfls.setupSide ?? mfls.signal) === 'SELL' ? '+' : '-'}${mfls.penetrationPct}%)`
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL'
                                  ? `⚡ Reclaim confirmado (+${mfls.penetrationPct}%)`
                                  : `⚡ Reclaim confirmado (-${mfls.penetrationPct}%)`))
                              : 'Normal'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Fallo MACD:</span>
                          <span style={{
                            fontWeight: '700',
                            color: mfls.macdDivergence
                              ? (mfls.signal === 'NEUTRAL'
                                ? 'var(--text-muted)'
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL' ? 'var(--accent-red)' : 'var(--accent-green)'))
                              : 'var(--text-muted)'
                          }}>
                            {mfls.macdDivergence
                              ? (mfls.signal === 'NEUTRAL'
                                ? 'Giro (Descartado)'
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL' ? '▼ GIRO BAJISTA CONFIRMADO' : '▲ GIRO ALCISTA CONFIRMADO'))
                              : 'Inactivo'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Divergencia RSI:</span>
                          <span style={{
                            fontWeight: '700',
                            color: mfls.rsiDivergence
                              ? (mfls.signal === 'NEUTRAL'
                                ? 'var(--text-muted)'
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL' ? 'var(--accent-red)' : 'var(--accent-green)'))
                              : 'var(--text-muted)'
                          }}>
                            {mfls.rsiDivergence
                              ? (mfls.signal === 'NEUTRAL'
                                ? 'Divergencia (Descartada)'
                                : ((mfls.setupSide ?? mfls.signal) === 'SELL' ? '▼ DIVERGENCIA BAJISTA ACTIVA' : '▲ DIVERGENCIA ACTIVA'))
                              : 'Sincronizado'}
                          </span>
                        </div>
                      </div>

                      {/* Niveles de Riesgo */}
                      {mfls.signal !== 'NEUTRAL' && (
                        <div style={{
                          backgroundColor: 'rgba(0, 0, 0, 0.15)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '6px',
                          padding: '10px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px'
                        }}>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: '800', letterSpacing: '0.5px' }}>GESTIÓN DE RIESGO (0.11% COMISIÓN)</div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><ShieldAlert size={13} /> Stop Loss:</span>
                            <span style={{ color: 'var(--accent-red)', fontWeight: '700', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(mfls.stopLoss)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Target size={13} /> TP1 (50% Ineficiencia / 1.75R):</span>
                            <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(mfls.takeProfit1)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Trophy size={13} /> TP2 (Runner 3.0R):</span>
                            <span style={{ color: 'var(--accent-green)', fontWeight: '700', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>{formatSmartPrice(mfls.takeProfit2)}</span>
                          </div>
                          <div style={{
                            fontSize: 'var(--text-xs)',
                            color: 'var(--text-secondary)',
                            lineHeight: '1.35',
                            padding: '6px 8px',
                            background: 'rgba(56, 189, 248, 0.04)',
                            border: '1px solid rgba(56, 189, 248, 0.1)',
                            borderRadius: '4px',
                            marginTop: '2px',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '6px'
                          }}>
                            <Info size={13} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--accent-blue)' }} />
                            <span>{mfls.reasoning}</span>
                          </div>
                        </div>
                      )}

                      {/* Reasoning when NEUTRAL */}
                      {mfls.signal === 'NEUTRAL' && (
                        <div style={{
                          fontSize: '0.72rem',
                          color: 'var(--text-secondary)',
                          padding: '8px 10px',
                          background: 'rgba(0,0,0,0.1)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '6px',
                          lineHeight: '1.35'
                        }}>
                          {mfls.reasoning}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Informational engines toggle (only where some engine is informational, i.e. 5m equities) */}
          {(() => {
            const infoSignals = [
              ['standard', rawSignal], ['scoring', score.signal], ['multitemporal', multi.signal],
              ['multifractal', multifractal.signal], ['mfls', mfls.signal],
            ].filter(([key]) => isInfo(key));
            if (infoSignals.length === 0) return null;
            const withSignal = infoSignals.filter(([, sig]) => sig.includes('BUY') || sig.includes('SELL')).length;
            return (
              <button
                onClick={toggleInformational}
                title="Estándar, Scoring, VCME, Multifractal y MFLS no generan alertas ni compiten en el torneo en acciones 5m. Quedan plegados para no distraer; abrilos si querés revisarlos."
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px', cursor: 'pointer',
                  background: 'rgba(168, 85, 247, 0.05)', border: '1px solid rgba(168, 85, 247, 0.25)',
                  color: '#c084fc', fontSize: 'var(--text-xs)', fontWeight: 700,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <FlaskConical size={13} />
                  {showInformational ? 'Ocultar' : 'Ver'} {infoSignals.length} motores informativos
                  {!showInformational && closes.length > 0 && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      · {withSignal === 0 ? 'ninguno con señal' : `${withSignal} con señal`}
                    </span>
                  )}
                </span>
                {showInformational ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            );
          })()}
        </div>
      )}

      {/* ── TAB CONTENT: CALCULATOR ─────────────────── */}
      {activeTab === 'calculator' && (
        <PositionCalculator
          symbol={symbol}
          isCrypto={isCrypto}
          executionStyle={executionStyle}
          overallSignal={overallSignal}
          operationalStrategy={operationalStrategy}
          klines5m={klines5m}
          klines1h={klines1h}
          closedKlines5m={closedKlines5m}
          closedKlines1h={closedKlines1h}
          multi={multi}
          multifractal={multifractal}
          mfls={mfls}
        />
      )}

      {/* ── TAB CONTENT: MARKET ─────────────────────── */}
      {activeTab === 'market' && (
        <MarketContextTab
          symbol={symbol}
          isCrypto={isCrypto}
          earningsEvent={earningsEvent}
          entryPrice={closes.length > 0 ? closes[closes.length - 1] : 0}
        />
      )}
    </div>
  );
}

