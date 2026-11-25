import { useState, useEffect, useMemo, memo } from 'react';
import type { Kline } from '../services/api';
import type { VCMESniperResult, MultifractalMTFSignalResult, MFLSEvaluationResult } from '../utils/indicators';
import { resolveOperationalTrade } from '../utils/operationalTrade';
import { formatSmartPrice, formatSmartNumber } from '../utils/formatters';

interface PositionCalculatorProps {
  symbol: string;
  isCrypto: boolean;
  executionStyle: 'dayTrading' | 'swing';
  overallSignal: string;
  operationalStrategy: string;
  klines5m: Kline[];
  klines1h: Kline[];
  closedKlines5m: Kline[];
  closedKlines1h: Kline[];
  multi: VCMESniperResult;
  multifractal: MultifractalMTFSignalResult;
  mfls: MFLSEvaluationResult;
}

function PositionCalculator({
  symbol,
  isCrypto,
  executionStyle,
  overallSignal,
  operationalStrategy,
  klines5m,
  klines1h,
  closedKlines5m,
  closedKlines1h,
  multi,
  multifractal,
  mfls,
}: PositionCalculatorProps) {
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
  const [accountDrawdown, setAccountDrawdown] = useState(0); // in percent
  const [sameSectorPositions, setSameSectorPositions] = useState(0); // open correlated trades

  // Persist risk parameters in localStorage
  useEffect(() => {
    localStorage.setItem('terminal_risk_capital', capital.toString());
  }, [capital]);

  useEffect(() => {
    localStorage.setItem('terminal_risk_percent', riskPercent.toString());
  }, [riskPercent]);

  useEffect(() => {
    localStorage.setItem('terminal_risk_leverage', leverage.toString());
  }, [leverage]);

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

  const calculatorPlan = useMemo(() => resolveOperationalTrade({
    strategy: operationalStrategy,
    signal: calcDirection,
    executionStyle,
    raw: { '5m': klines5m, '1h': klines1h },
    closed: { '5m': closedKlines5m, '1h': closedKlines1h },
    vcme: multi,
    multifractal,
    mfls,
    isCrypto,
  }), [operationalStrategy, calcDirection, executionStyle, klines5m, klines1h, closedKlines5m, closedKlines1h, multi, multifractal, mfls, isCrypto]);

  const entryPrice = calculatorPlan.entryPrice;
  const slPrice = calculatorPlan.valid ? calculatorPlan.levels.stopLoss : 0;
  const tpPrice = calculatorPlan.valid ? calculatorPlan.levels.takeProfit1 : 0;
  const slPct = calculatorPlan.riskDistance;
  const tpPct = calculatorPlan.valid ? Math.abs(tpPrice - entryPrice) / entryPrice : 0;
  const maxRiskPerTrade = capital * (riskPercent / 100);
  const riskDistance = calculatorPlan.riskDistance;
  const basePositionUSD = calculatorPlan.valid && riskDistance > 0 ? maxRiskPerTrade / riskDistance : 0;

  let confidenceMultiplier = 1.0;
  let scoreTier = 'N/A';
  if (operationalStrategy === 'multitemporal') {
    const score = multi.score;
    if (score >= 90) { confidenceMultiplier = 1.65; scoreTier = 'ELITE'; }
    else if (score >= 82) { confidenceMultiplier = 1.35; scoreTier = 'HIGH'; }
    else if (score >= 76) { confidenceMultiplier = 1.10; scoreTier = 'GOOD'; }
    else if (score >= 70) { confidenceMultiplier = 0.75; scoreTier = 'MEDIUM'; }
    else { confidenceMultiplier = 0.40; scoreTier = 'LOW'; }
  }

  let volatilityMultiplier = 1.0;
  if (operationalStrategy === 'multitemporal') {
    const atrPct = multi.atrPercent;
    if (atrPct > 3.0) volatilityMultiplier = 0.70;
    else if (atrPct > 2.0) volatilityMultiplier = 0.85;
    else if (atrPct < 0.8) volatilityMultiplier = 1.25;
  }

  let healthMultiplier = 1.0;
  if (accountDrawdown > 15) healthMultiplier = 0.40;
  else if (accountDrawdown > 8) healthMultiplier = 0.65;
  else if (accountDrawdown > 3) healthMultiplier = 0.85;

  let correlationPenalty = 1.0;
  if (sameSectorPositions >= 3) correlationPenalty = 0.45;
  else if (sameSectorPositions === 2) correlationPenalty = 0.70;

  let totalPositionValue = basePositionUSD * confidenceMultiplier * volatilityMultiplier * healthMultiplier * correlationPenalty;
  
  // Hard limit: Max 25% of capital in one position
  totalPositionValue = Math.min(totalPositionValue, capital * 0.25);
  
  const positionUnits = entryPrice > 0 ? totalPositionValue / entryPrice : 0;
  const requiredMargin = totalPositionValue / (isCrypto ? leverage : 1);
  const riskUSD = totalPositionValue * riskDistance;

  return (
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
            Gestión Dinámica: {operationalStrategy === 'multitemporal' ? 'VCME Sniper v2' : 'Estándar'}
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
            <label style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>RIESGO BASE (%)</label>
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

        {/* Advanced Position Sizing Controls */}
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '10px',
          padding: '10px 12px',
          background: 'rgba(0, 0, 0, 0.15)',
          borderRadius: '6px',
          border: '1px solid var(--border-color)'
        }}>
          <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--accent-blue)', letterSpacing: '0.5px' }}>
            PARÁMETROS DE CUENTA & CONTROL DE RIESGO
          </div>
          
          {/* Account Drawdown Slider */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Drawdown de Cuenta:</span>
              <span style={{ color: accountDrawdown > 8 ? 'var(--accent-red)' : 'var(--text-primary)', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>
                {accountDrawdown}%
              </span>
            </div>
            <input 
              type="range"
              min="0"
              max="30"
              value={accountDrawdown}
              onChange={e => setAccountDrawdown(parseInt(e.target.value))}
              style={{
                width: '100%',
                height: '4px',
                borderRadius: '2px',
                background: 'rgba(255,255,255,0.1)',
                outline: 'none',
                cursor: 'pointer'
              }}
            />
          </div>

          {/* Correlation Positions Dropdown */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Posiciones correlacionadas abiertas:</span>
            <select 
              value={sameSectorPositions}
              onChange={e => setSameSectorPositions(parseInt(e.target.value))}
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-color)',
                color: '#fff',
                fontSize: '0.7rem',
                padding: '2px 6px',
                borderRadius: '4px',
                fontFamily: 'var(--font-mono)',
                outline: 'none'
              }}
            >
              <option value={0}>0 posiciones</option>
              <option value={1}>1 posición</option>
              <option value={2}>2 posiciones (Penaliz. 30%)</option>
              <option value={3}>3+ posiciones (Penaliz. 55%)</option>
            </select>
          </div>
        </div>

        {/* Price Plan (SL & TP Levels) */}
        <div style={{ fontSize: '0.75rem', color: calculatorPlan.valid ? 'var(--text-muted)' : '#eab308' }} role="status">
          {calculatorPlan.valid
            ? `${overallSignal.includes(calcDirection) ? 'Plan operativo' : 'Escenario manual (no es una alerta)'} ${calculatorPlan.interval.toUpperCase()} · precio de ejecución actual`
            : `${calculatorPlan.reason} Dimensionamiento desactivado.`}
        </div>
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
              {formatSmartPrice(entryPrice)}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--accent-red)' }}>Stop Loss (-{(slPct*100).toFixed(1)}%):</span>
            <div style={{ color: 'var(--accent-red)', fontWeight: 'bold', fontSize: '0.75rem', marginTop: '2px' }}>
              {formatSmartPrice(slPrice)}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--accent-green)' }}>Target 1 (+{(tpPct*100).toFixed(1)}%):</span>
            <div style={{ color: 'var(--accent-green)', fontWeight: 'bold', fontSize: '0.75rem', marginTop: '2px' }}>
              {formatSmartPrice(tpPrice)}
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

        {/* Sizing Multipliers Breakdown */}
        {operationalStrategy === 'multitemporal' && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '10px 12px',
            background: 'rgba(59, 130, 246, 0.03)',
            border: '1px solid rgba(59, 130, 246, 0.1)',
            borderRadius: '6px',
            fontSize: '0.7rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '4px', fontWeight: 'bold', color: 'var(--accent-blue)' }}>
              <span>Multiplicadores de Capital (VCME v2)</span>
              <span>Impacto</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)' }}>1. Factor Confianza ({scoreTier} - {multi.score} pts):</span>
              <span style={{ fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>{confidenceMultiplier.toFixed(2)}x</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)' }}>2. Factor Volatilidad (ATR 5m {multi.atrPercent}%):</span>
              <span style={{ fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>{volatilityMultiplier.toFixed(2)}x</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)' }}>3. Protección Drawdown ({accountDrawdown}%):</span>
              <span style={{ fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>{healthMultiplier.toFixed(2)}x</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)' }}>4. Penalización Correlación ({sameSectorPositions} open):</span>
              <span style={{ fontWeight: 'bold', color: '#fff', fontFamily: 'var(--font-mono)' }}>{correlationPenalty.toFixed(2)}x</span>
            </div>
          </div>
        )}

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
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>RIESGO NETO EN USD:</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>
              ${riskUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>TAMAÑO RECOMENDADO:</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>
              {positionUnits >= 1000 ? positionUnits.toLocaleString(undefined, { maximumFractionDigits: 2 }) : formatSmartNumber(positionUnits, 4)} {isCrypto ? symbol.replace('USDT', '') : 'Acciones'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px' }}>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>VALOR TOTAL DE POSICIÓN:</span>
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
  );
}

export default memo(PositionCalculator);
