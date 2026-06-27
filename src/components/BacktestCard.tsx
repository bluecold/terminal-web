import type { BacktestResult } from '../utils/backtester';

interface BacktestCardProps {
  name: string;
  result: BacktestResult | null; // null = computing
}

function getColor(winRate: number, totalSignals: number): string {
  if (totalSignals < 5) return 'var(--text-secondary)';
  if (winRate >= 0.6)   return 'var(--accent-green)';
  if (winRate >= 0.4)   return '#f0a500'; // amber
  return 'var(--accent-red)';
}

function getRatingLabel(winRate: number, totalSignals: number): string {
  if (totalSignals < 5) return '— sin datos';
  if (winRate >= 0.65)  return '★ Excelente';
  if (winRate >= 0.55)  return '↑ Bueno';
  if (winRate >= 0.45)  return '~ Regular';
  return '↓ Pobre';
}

export default function BacktestCard({ name, result }: BacktestCardProps) {
  const isLoading = result === null;
  const isInsufficient = result?.insufficient ?? false;

  const winRate      = result?.winRate ?? 0;
  const totalSignals = result?.totalSignals ?? 0;
  const wins         = result?.wins ?? 0;
  const losses       = result?.losses ?? 0;
  const timeouts     = totalSignals - wins - losses;
  const barColor     = getColor(winRate, totalSignals);
  const barPct       = Math.round(winRate * 100);
  const rating       = getRatingLabel(winRate, totalSignals);
  const lowConfidence = !isInsufficient && totalSignals > 0 && totalSignals < 10;

  let ratingBg = 'rgba(255, 255, 255, 0.02)';
  if (totalSignals >= 5) {
    if (winRate >= 0.6) ratingBg = 'rgba(16, 185, 129, 0.1)';
    else if (winRate >= 0.4) ratingBg = 'rgba(245, 158, 11, 0.1)';
    else ratingBg = 'rgba(244, 63, 94, 0.1)';
  }

  return (
    <div style={{
      backgroundColor: 'rgba(255, 255, 255, 0.01)',
      border: '1px solid var(--border-color)',
      borderRadius: 'var(--border-radius-md)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      transition: 'var(--transition-smooth)'
    }}>

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: '600' }}>
          {name}
        </span>
        {!isLoading && !isInsufficient && (
          <span style={{ 
            fontSize: '0.65rem', 
            color: barColor, 
            fontWeight: '700',
            padding: '2px 8px',
            backgroundColor: ratingBg,
            borderRadius: '10px',
            border: `1px solid ${barColor === 'var(--text-secondary)' ? 'rgba(255,255,255,0.05)' : barColor + '20'}`
          }}>
            {rating}
          </span>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Calculando…</div>
      ) : isInsufficient ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {result!.label}
        </div>
      ) : (
        <>
          {/* Progress bar */}
          <div style={{ position: 'relative', height: '6px', borderRadius: '3px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              left: 0, top: 0, height: '100%',
              width: `${barPct}%`,
              background: barColor,
              borderRadius: '3px',
              transition: 'width 0.6s ease',
              boxShadow: barColor !== 'var(--text-secondary)' ? `0 0 8px ${barColor}` : 'none'
            }} />
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: barColor, fontWeight: '700', fontSize: '0.85rem' }}>
              {barPct}%
            </span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>
              <span style={{ color: 'var(--accent-green)' }}>{wins}✓</span> <span style={{ color: 'var(--accent-red)' }}>{losses}✗</span> {timeouts > 0 ? <span style={{ color: 'var(--text-muted)' }}>{timeouts}~</span> : ''}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              {totalSignals} señales
            </span>
          </div>

          {/* Low confidence warning */}
          {lowConfidence && (
            <div style={{ 
              fontSize: '0.65rem', 
              color: 'var(--accent-yellow)', 
              marginTop: '2px',
              padding: '4px 8px',
              background: 'rgba(245, 158, 11, 0.05)',
              border: '1px solid rgba(245, 158, 11, 0.1)',
              borderRadius: '4px'
            }}>
              ⚠ Pocas señales — baja confianza estadística
            </div>
          )}

          {/* Footer: window info */}
          <div style={{ 
            fontSize: '0.65rem', 
            color: 'var(--text-muted)', 
            borderTop: '1px solid var(--border-color)', 
            paddingTop: '6px', 
            marginTop: '2px',
            lineHeight: '1.3'
          }}>
            {result!.label} · ventana {result!.forwardLabel} · umbral ±{(result!.threshold * 100).toFixed(1)}%
          </div>
        </>
      )}
    </div>
  );
}
