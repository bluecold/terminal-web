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

  return (
    <div style={{
      backgroundColor: 'var(--bg-dark)',
      border: '1px solid var(--border-color)',
      borderRadius: '4px',
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }}>

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', fontWeight: 'bold' }}>
          {name}
        </span>
        {!isLoading && !isInsufficient && (
          <span style={{ fontSize: '0.7rem', color: barColor, fontWeight: 'bold' }}>
            {rating}
          </span>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Calculando…</div>
      ) : isInsufficient ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          {result!.label}
        </div>
      ) : (
        <>
          {/* Progress bar */}
          <div style={{ position: 'relative', height: '6px', borderRadius: '3px', background: 'var(--bg-panel)', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              left: 0, top: 0, height: '100%',
              width: `${barPct}%`,
              background: barColor,
              borderRadius: '3px',
              transition: 'width 0.6s ease',
            }} />
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
            <span style={{ color: barColor, fontWeight: 'bold', fontSize: '0.85rem' }}>
              {barPct}%
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {wins}✓ {losses}✗ {timeouts > 0 ? `${timeouts}~` : ''}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {totalSignals} señales
            </span>
          </div>

          {/* Low confidence warning */}
          {lowConfidence && (
            <div style={{ fontSize: '0.65rem', color: '#f0a500', marginTop: '2px' }}>
              ⚠ Pocas señales — baja confianza estadística
            </div>
          )}

          {/* Footer: window info */}
          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-color)', paddingTop: '4px', marginTop: '2px' }}>
            {result!.label} · ventana {result!.forwardLabel} · umbral ±{(result!.threshold * 100).toFixed(1)}%
          </div>
        </>
      )}
    </div>
  );
}
