import type { BacktestResult } from '../utils/backtester';

interface BacktestCardProps {
  name: string;
  result: BacktestResult | null; // null = computing
}

function getColor(winRate: number, totalSignals: number): string {
  if (totalSignals < 3) return 'var(--text-secondary)';
  if (winRate >= 0.6)   return 'var(--accent-green)';
  if (winRate >= 0.4)   return '#f0a500'; // amber
  return 'var(--accent-red)';
}

function getRatingLabel(profitFactor: number | null, resolved: number): string {
  if (resolved < 3) return '— sin datos';
  if (profitFactor === null) return resolved >= 5 ? '★ 100% Win (0 pérdidas)' : '— Sin pérdidas';
  if (profitFactor >= 2.0)  return '★ Excelente';
  if (profitFactor >= 1.3)  return '↑ Bueno';
  if (profitFactor >= 0.8)  return '~ Regular';
  return '↓ Pobre';
}

export default function BacktestCard({ name, result }: BacktestCardProps) {
  const isLoading = result === null;
  const isInsufficient = result?.insufficient ?? false;

  const winRate           = result?.winRate ?? 0;
  const totalSignals      = result?.totalSignals ?? 0;
  const wins              = result?.wins ?? 0;
  const losses            = result?.losses ?? 0;
  const timeouts          = result?.timeouts ?? 0;
  const resolved          = wins + losses;
  const pf                = result?.profitFactor ?? null;
  const expectancyR       = result?.expectancyR ?? (result?.expectancy ? result.expectancy / 1.0 : 0);
  const expectancyPerHour = result?.expectancyPerHour ?? 0;
  const maxDrawdownR      = result?.maxDrawdownR ?? 0;
  const maxLossStreak     = result?.maxLossStreak ?? 0;
  const sortinoRatio      = result?.sortinoRatio ?? null;
  const longStats         = result?.longStats;
  const shortStats        = result?.shortStats;
  const regimeStats       = result?.regimeStats;
  const walkForward       = result?.walkForward;
  const barColor          = getColor(winRate, resolved);
  const barPct            = Math.round(winRate * 100);
  const rating            = getRatingLabel(pf, resolved);
  const lowConfidence     = !isInsufficient && totalSignals > 0 && resolved < 5;

  let ratingBg = 'rgba(255, 255, 255, 0.02)';
  if (resolved >= 3) {
    if (pf === null || pf >= 1.3) ratingBg = 'rgba(16, 185, 129, 0.1)';
    else if (pf >= 0.8) ratingBg = 'rgba(245, 158, 11, 0.1)';
    else ratingBg = 'rgba(244, 63, 94, 0.1)';
  }

  const exitBreakdown = result?.exitBreakdown;
  const exitTooltip = exitBreakdown ? [
    exitBreakdown.targetHits > 0 ? `Target TP: ${exitBreakdown.targetHits}` : null,
    exitBreakdown.stopLossHits > 0 ? `Stop Loss: ${exitBreakdown.stopLossHits}` : null,
    exitBreakdown.timeStops > 0 ? `Time-Stop: ${exitBreakdown.timeStops}` : null,
    exitBreakdown.emergencyExits > 0 ? `Salida Emergencia: ${exitBreakdown.emergencyExits}` : null,
    exitBreakdown.expirations > 0 ? `Expirados: ${exitBreakdown.expirations}` : null,
    exitBreakdown.breakevenExits > 0 ? `Breakeven Runner: ${exitBreakdown.breakevenExits}` : null,
  ].filter(Boolean).join(' · ') : '';

  const discardsTooltip = result?.discards ? [
    result.discards.regimeFilter > 0 ? `Régimen: ${result.discards.regimeFilter}` : null,
    result.discards.noSetup > 0 ? `Sin Setup: ${result.discards.noSetup}` : null,
    result.discards.volumeFilter > 0 ? `Volumen: ${result.discards.volumeFilter}` : null,
    result.discards.candleAnatomy > 0 ? `Anatomía: ${result.discards.candleAnatomy}` : null,
    result.discards.riskFilter > 0 ? `Riesgo: ${result.discards.riskFilter}` : null,
    result.discards.cooldown > 0 ? `Cooldown: ${result.discards.cooldown}` : null,
    result.discards.sessionGap > 0 ? `Sesión/Apertura: ${result.discards.sessionGap}` : null,
    result.discards.insufficientData > 0 ? `Datos: ${result.discards.insufficientData}` : null,
  ].filter(Boolean).join(' · ') : '';

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
          <div 
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}
            title={`Económico: ${wins} Ganadores (R > 0) · ${losses} Perdedores (R < 0)${exitTooltip ? `\nEstructural: ${exitTooltip}` : ''}${discardsTooltip ? `\nDescartes: ${discardsTooltip}` : ''}`}
          >
            <span style={{ color: barColor, fontWeight: '700', fontSize: '0.85rem' }}>
              {barPct}%
            </span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>
              <span style={{ color: 'var(--accent-green)' }}>{wins}✓</span> <span style={{ color: 'var(--accent-red)' }}>{losses}✗</span> {timeouts > 0 ? <span style={{ color: 'var(--text-muted)' }} title={`Expiraciones: ${timeouts} trades alcanzaron el fin de ventana sin TP/SL`}>{timeouts}~</span> : ''}
            </span>
            <span style={{ color: 'var(--text-muted)' }} title={`Resueltos: ${resolved} / Señales: ${totalSignals}${exitTooltip ? `\nEstructural: ${exitTooltip}` : ''}${discardsTooltip ? `\nDescartes: ${discardsTooltip}` : ''}`}>
              {resolved}/{totalSignals}
            </span>
          </div>

          {/* Metrics row 1: Profit Factor + Expectancy R + Hourly velocity */}
          {resolved >= 3 && (
            <>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.65rem',
                fontFamily: 'var(--font-mono)',
                padding: '4px 8px',
                background: 'rgba(0,0,0,0.15)',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
              }}>
                <span style={{ color: 'var(--text-secondary)' }} title={pf === null ? 'Sin pérdidas registradas en la muestra (indefinido)' : `Profit Factor: ${pf.toFixed(2)}`}>
                  PF: <span style={{ color: pf === null || pf >= 1.3 ? 'var(--accent-green)' : pf >= 0.8 ? '#f0a500' : 'var(--accent-red)', fontWeight: '600' }}>
                    {pf !== null ? pf.toFixed(2) : 'N/D'}
                  </span>
                </span>
                <span style={{ color: 'var(--text-secondary)' }} title="Expectancy en R-múltiplos por trade">
                  E[R]: <span style={{ color: expectancyR > 0 ? 'var(--accent-green)' : expectancyR < 0 ? 'var(--accent-red)' : 'var(--text-primary)', fontWeight: '600' }}>
                    {expectancyR > 0 ? '+' : ''}{expectancyR.toFixed(2)}R
                  </span>
                </span>
                <span style={{ color: 'var(--text-secondary)' }} title={`Velocidad de capital: ${expectancyPerHour > 0 ? '+' : ''}${expectancyPerHour.toFixed(2)} R por hora de exposición`}>
                  R/h: <span style={{ fontWeight: '600', color: expectancyPerHour > 0 ? 'var(--accent-green)' : expectancyPerHour < 0 ? 'var(--accent-red)' : 'var(--text-primary)' }}>
                    {expectancyPerHour > 0 ? '+' : ''}{expectancyPerHour.toFixed(2)}
                  </span>
                </span>
              </div>

              {/* Metrics row 2: Max Drawdown in R + Max Loss Streak + Sortino */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.62rem',
                fontFamily: 'var(--font-mono)',
                padding: '3px 8px',
                background: 'rgba(0,0,0,0.10)',
                borderRadius: '4px',
                border: '1px solid rgba(255, 255, 255, 0.04)',
                color: 'var(--text-secondary)'
              }}>
                <span title="Max Drawdown en múltiplos de riesgo (profundidad de caída en R)">
                  MDD: <span style={{ color: maxDrawdownR <= 2.0 ? 'var(--accent-green)' : maxDrawdownR <= 4.0 ? '#f0a500' : 'var(--accent-red)', fontWeight: '600' }}>
                    {maxDrawdownR.toFixed(1)}R
                  </span>
                </span>
                <span title="Racha máxima de operaciones perdedoras consecutivas">
                  Racha ✗: <span style={{ color: maxLossStreak <= 2 ? 'var(--accent-green)' : maxLossStreak <= 4 ? '#f0a500' : 'var(--accent-red)', fontWeight: '600' }}>
                    {maxLossStreak}
                  </span>
                </span>
                <span title="Sortino Ratio sobre serie de R (retorno ajustado por volatilidad bajista)">
                  Sortino: <span style={{ color: sortinoRatio === null ? 'var(--accent-green)' : sortinoRatio >= 1.5 ? 'var(--accent-green)' : sortinoRatio >= 0.8 ? '#f0a500' : 'var(--accent-red)', fontWeight: '600' }}>
                    {sortinoRatio !== null ? sortinoRatio.toFixed(2) : 'N/D'}
                  </span>
                </span>
              </div>

              {/* Directional & Regime breakdown */}
              {((longStats && longStats.signals > 0) || (shortStats && shortStats.signals > 0)) && (
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.58rem',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  padding: '2px 4px',
                  gap: '4px',
                  flexWrap: 'wrap'
                }}>
                  {longStats && longStats.signals > 0 && (
                    <span title={`LONG: ${longStats.wins}W / ${longStats.losses}L · E[R]: ${longStats.expectancyR > 0 ? '+' : ''}${longStats.expectancyR.toFixed(2)}R`}>
                      ▲ L: <span style={{ color: longStats.winRate >= 0.55 ? 'var(--accent-green)' : 'var(--text-secondary)', fontWeight: '600' }}>{Math.round(longStats.winRate * 100)}%</span> ({longStats.signals})
                    </span>
                  )}
                  {shortStats && shortStats.signals > 0 && (
                    <span title={`SHORT: ${shortStats.wins}W / ${shortStats.losses}L · E[R]: ${shortStats.expectancyR > 0 ? '+' : ''}${shortStats.expectancyR.toFixed(2)}R`}>
                      ▼ S: <span style={{ color: shortStats.winRate >= 0.55 ? 'var(--accent-green)' : 'var(--text-secondary)', fontWeight: '600' }}>{Math.round(shortStats.winRate * 100)}%</span> ({shortStats.signals})
                    </span>
                  )}
                  {regimeStats && regimeStats.trending.signals > 0 && (
                    <span title={`Régimen Tendencial (Histéresis: entrada ≥26 / salida ≤22): ${regimeStats.trending.signals} trades · WR: ${Math.round(regimeStats.trending.winRate * 100)}% · E[R]: ${regimeStats.trending.expectancyR > 0 ? '+' : ''}${regimeStats.trending.expectancyR.toFixed(2)}R`}>
                      ⚡ Tendencia: <span style={{ color: regimeStats.trending.expectancyR > 0 ? 'var(--accent-green)' : 'var(--text-muted)', fontWeight: '600' }}>{regimeStats.trending.expectancyR > 0 ? '+' : ''}{regimeStats.trending.expectancyR.toFixed(2)}R</span>
                    </span>
                  )}
                </div>
              )}

              {/* Walk-Forward Validation Badge */}
              {walkForward && (
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.60rem',
                  fontFamily: 'var(--font-mono)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  background: walkForward.status === 'PASS'
                    ? 'rgba(16, 185, 129, 0.08)'
                    : walkForward.status === 'FAIL'
                    ? 'rgba(244, 63, 94, 0.08)'
                    : walkForward.status === 'INSUFFICIENT_OOS'
                    ? 'rgba(245, 158, 11, 0.08)'
                    : 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${
                    walkForward.status === 'PASS'
                      ? 'rgba(16, 185, 129, 0.2)'
                      : walkForward.status === 'FAIL'
                      ? 'rgba(244, 63, 94, 0.2)'
                      : walkForward.status === 'INSUFFICIENT_OOS'
                      ? 'rgba(245, 158, 11, 0.2)'
                      : 'rgba(255, 255, 255, 0.05)'
                  }`,
                }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Walk-Forward (70/30):
                  </span>
                  <span style={{
                    fontWeight: '700',
                    color: walkForward.status === 'PASS'
                      ? 'var(--accent-green)'
                      : walkForward.status === 'FAIL'
                      ? 'var(--accent-red)'
                      : walkForward.status === 'INSUFFICIENT_OOS'
                      ? 'var(--accent-yellow)'
                      : 'var(--text-muted)'
                  }} title={`In-Sample (70%): ${walkForward.inSample.signals} trades (E[R] ${walkForward.inSample.expectancyR > 0 ? '+' : ''}${walkForward.inSample.expectancyR.toFixed(2)}R) · Out-of-Sample (30%): ${walkForward.outOfSample.signals} trades (E[R] ${walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${walkForward.outOfSample.expectancyR.toFixed(2)}R)`}>
                    {walkForward.status === 'PASS'
                      ? `✓ OOS ${walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${walkForward.outOfSample.expectancyR.toFixed(2)}R (${walkForward.outOfSample.wins}W/${walkForward.outOfSample.losses}L)`
                      : walkForward.status === 'FAIL'
                      ? `✗ OOS ${walkForward.outOfSample.expectancyR.toFixed(2)}R (${walkForward.outOfSample.wins}W/${walkForward.outOfSample.losses}L)`
                      : walkForward.status === 'INSUFFICIENT_OOS'
                      ? `~ OOS ${walkForward.outOfSample.expectancyR > 0 ? '+' : ''}${walkForward.outOfSample.expectancyR.toFixed(2)}R (${walkForward.outOfSample.signals} ${walkForward.outOfSample.signals === 1 ? 'trade' : 'trades'})`
                      : '~ Sin trades OOS'}
                  </span>
                </div>
              )}
            </>
          )}

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

          {/* Zero signals diagnostic row */}
          {totalSignals === 0 && !isInsufficient && (
            <div style={{ 
              fontSize: '0.62rem', 
              color: 'var(--text-muted)', 
              marginTop: '2px',
              padding: '4px 8px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              fontFamily: 'var(--font-mono)'
            }} title={discardsTooltip}>
              0 señales {discardsTooltip ? `(${discardsTooltip})` : ''}
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
            {result!.label} · ventana {result!.forwardLabel} · SL ±{(result!.threshold * 100).toFixed(1)}% · TP ±{(result!.targetThreshold * 100).toFixed(1)}% · R:R 1:{result!.targetMultiplier}
          </div>
        </>
      )}
    </div>
  );
}
