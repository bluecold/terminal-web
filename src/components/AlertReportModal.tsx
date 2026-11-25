import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import {
  buildAlertPerformanceReport,
  buildAlertExport,
  parseAlertImport,
  REPORT_TIME_SLOTS,
  type ArchivedAlert,
  type ReportBucket,
} from '../utils/alertReport';
import type { AuditAlertItem } from '../utils/alertTracker';
import { APP_VERSION } from '../version';

interface AlertReportModalProps {
  alerts: ArchivedAlert[];
  /** Full live log (with targets and execution state), included in exports. */
  liveLog: AuditAlertItem[];
  /** Last archive persistence error, if any. */
  archiveError: string | null;
  /** Merges imported resolved alerts into the archive; resolves to the number of new alerts. */
  onImport: (entries: ArchivedAlert[]) => Promise<number>;
  onClose: () => void;
}

const backupButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)', borderRadius: '4px',
  padding: '2px 8px', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer',
};

const PERIODS = [7, 14, 30, 90] as const;

function formatR(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

/** YYYY-MM-DD → DD/MM */
function formatDay(day: string): string {
  const [, month, dayOfMonth] = day.split('-');
  return `${dayOfMonth}/${month}`;
}

function rColor(r: number): string {
  return r >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
}

function BucketRow({ label, bucket, muted }: { label: string; bucket: ReportBucket; muted?: boolean }) {
  const color = bucket.n === 0 ? 'var(--text-muted)' : bucket.avgR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  return (
    <tr style={{ opacity: muted ? 0.75 : 1 }}>
      <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>{label}</td>
      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{bucket.n}</td>
      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{bucket.n > 0 ? `${Math.round((bucket.wins / bucket.n) * 100)}%` : '—'}</td>
      <td style={{ padding: '4px 8px', textAlign: 'right', color, fontWeight: 700 }}>{bucket.n > 0 ? formatR(bucket.avgR) : '—'}</td>
      <td style={{ padding: '4px 8px', textAlign: 'right', color }}>{bucket.n > 0 ? formatR(bucket.totalR) : '—'}</td>
    </tr>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.5px', color: 'var(--text-muted)' }}>{title}</div>
      {children}
      {note && <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>{note}</div>}
    </div>
  );
}

function BucketTable({ rows }: { rows: { label: string; bucket: ReportBucket; muted?: boolean }[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
      <thead>
        <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
          <th style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600 }}></th>
          <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Alertas</th>
          <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Aciertos</th>
          <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>R medio</th>
          <th style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>R total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => <BucketRow key={row.label} {...row} />)}
      </tbody>
    </table>
  );
}

export default function AlertReportModal({ alerts, liveLog, archiveError, onImport, onClose }: AlertReportModalProps) {
  const [days, setDays] = useState<number>(7);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const handleExport = () => {
    const data = buildAlertExport(alerts, liveLog, APP_VERSION);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `terminal-alerts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupMessage({ kind: 'ok', text: `Exportadas ${alerts.length} alertas cerradas y ${liveLog.length} del log vivo.` });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const entries = parseAlertImport(JSON.parse(await file.text()));
      const added = await onImport(entries);
      setBackupMessage({
        kind: 'ok',
        text: added > 0
          ? `Importadas ${added} alertas nuevas (de ${entries.length} en el archivo; las de más de 90 días no entran al informe).`
          : `Sin alertas nuevas: las ${entries.length} del archivo ya estaban o tienen más de 90 días.`,
      });
    } catch (err) {
      setBackupMessage({ kind: 'error', text: `No se pudo importar: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setImporting(false);
    }
  };
  // The report window is anchored to the moment it is opened
  const [nowMs] = useState(() => Date.now());
  const [minVersion, setMinVersion] = useState<string>('');
  const report = useMemo(
    () => buildAlertPerformanceReport(alerts, nowMs, days, { minVersion: minVersion || undefined }),
    [alerts, nowMs, days, minVersion]
  );
  const { byDay } = report;
  const ci = byDay.ci95HalfWidth;
  const ciExcludesZero = ci !== undefined && Math.abs(report.primary.avgR) > ci;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const strategyRows = Object.entries(report.byStrategy)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([label, bucket]) => ({ label, bucket, muted: label.includes('(Informativa)') || label.includes('(Exploratoria)') }));

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(5, 7, 12, 0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '640px', maxHeight: '90vh',
          background: 'var(--bg-panel-solid)',
          border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 'var(--border-radius-lg)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>Informe de alertas reales</div>
            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Alertas cerradas · R neto de comisión según el seguimiento de la app
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {(report.versions.length > 0 || minVersion) && (
              <select
                value={minVersion}
                onChange={e => setMinVersion(e.target.value)}
                title={`Limita el informe a las alertas emitidas desde una versión de la app, para no mezclar reglas viejas con las actuales.${report.unversioned > 0 ? ` Hay ${report.unversioned} alertas del período anteriores a v2026.11.16.1, que no guardan versión.` : ''}`}
                style={{
                  background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '4px',
                  padding: '2px 4px', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer',
                }}
              >
                <option value="">Todas las reglas</option>
                {[...new Set([...report.versions, ...(minVersion ? [minVersion] : [])])].map(v => (
                  <option key={v} value={v}>Desde {v}</option>
                ))}
              </select>
            )}
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => setDays(p)}
                style={{
                  background: days === p ? 'var(--accent-blue)' : 'rgba(255,255,255,0.04)',
                  color: days === p ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '4px',
                  padding: '2px 8px', fontSize: '0.66rem', cursor: 'pointer', fontWeight: 700,
                }}
              >
                {p} días
              </button>
            ))}
            <button onClick={onClose} aria-label="Cerrar" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: '4px' }}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div style={{
          padding: '8px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '0.66rem',
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>RESPALDO</span>
          <button onClick={handleExport} style={backupButtonStyle} title="Descarga un .json con las alertas cerradas (90 días) y el log vivo completo">
            <Download size={12} /> Exportar
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={importing} style={backupButtonStyle} title="Agrega al informe las alertas cerradas de un respaldo (.json); no borra ni duplica las actuales">
            <Upload size={12} /> {importing ? 'Importando…' : 'Importar'}
          </button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleImportFile} style={{ display: 'none' }} />
          <span style={{ color: 'var(--text-muted)' }}>{alerts.length} alertas archivadas</span>
          {backupMessage && (
            <span style={{ color: backupMessage.kind === 'error' ? 'var(--accent-red)' : 'var(--accent-green)' }}>{backupMessage.text}</span>
          )}
          {archiveError && (
            <span style={{ color: 'var(--accent-red)', flexBasis: '100%' }}>
              ⚠ No se pudo guardar el archivo del informe ({archiveError}). Exportá un respaldo para no perder alertas.
            </span>
          )}
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {report.primary.n === 0 && strategyRows.length === 0 ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Todavía no hay alertas cerradas en este período.
            </div>
          ) : (
            <>
              <Section title="ALERTAS PRINCIPALES">
                <BucketTable rows={[{ label: 'Total', bucket: report.primary }]} />
              </Section>

              {byDay.days.length > 0 && (
                <Section
                  title="POR DÍA (ET) · ALERTAS PRINCIPALES"
                  note="Las alertas de un mismo día suelen moverse juntas (un solo movimiento del mercado dispara muchos papeles), así que la unidad de medida es el día, no la alerta. Si el intervalo incluye el 0, el resultado no se distingue del azar."
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                    <div>
                      R medio por alerta:{' '}
                      <strong style={{ color: rColor(report.primary.avgR) }}>{formatR(report.primary.avgR)}</strong>
                      {ci !== undefined ? (
                        <>
                          {' '}± {ci.toFixed(2)} <span style={{ color: 'var(--text-muted)' }}>(IC 95%, {byDay.days.length} días)</span>
                          {' · '}
                          <span style={{ color: ciExcludesZero ? rColor(report.primary.avgR) : '#eab308' }}>
                            {ciExcludesZero ? 'el intervalo no incluye el 0' : 'no se distingue del azar'}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}> · hacen falta al menos 3 días para estimar el intervalo</span>
                      )}
                    </div>
                    {byDay.bestDay && byDay.avgRWithoutBestDay !== undefined && (
                      <div>
                        Sin el mejor día <span style={{ color: 'var(--text-muted)' }}>({formatDay(byDay.bestDay.day)}: {formatR(byDay.bestDay.bucket.totalR)} en {byDay.bestDay.bucket.n} alertas)</span>:{' '}
                        <strong style={{ color: rColor(byDay.avgRWithoutBestDay) }}>{formatR(byDay.avgRWithoutBestDay)}</strong>
                      </div>
                    )}
                    {byDay.worstDay && byDay.avgRWithoutWorstDay !== undefined && (
                      <div>
                        Sin el peor día <span style={{ color: 'var(--text-muted)' }}>({formatDay(byDay.worstDay.day)}: {formatR(byDay.worstDay.bucket.totalR)} en {byDay.worstDay.bucket.n} alertas)</span>:{' '}
                        <strong style={{ color: rColor(byDay.avgRWithoutWorstDay) }}>{formatR(byDay.avgRWithoutWorstDay)}</strong>
                      </div>
                    )}
                  </div>
                  <div style={{ maxHeight: '170px', overflowY: 'auto' }}>
                    <BucketTable rows={byDay.days.map(d => ({ label: formatDay(d.day), bucket: d.bucket }))} />
                  </div>
                </Section>
              )}

              <Section
                title="POR FRANJA HORARIA (ET)"
                note="En la muestra de calibración (60 días) el mejor resultado estaba antes de las 10:00 ET, pero esa ventaja no se sostuvo fuera de muestra."
              >
                <BucketTable rows={REPORT_TIME_SLOTS.filter(s => report.bySlot[s].n > 0).map(s => ({ label: s, bucket: report.bySlot[s] }))} />
              </Section>

              <Section
                title="PRIMERA ALERTA DEL DÍA"
                note="Primera alerta principal de cada sesión en toda la watchlist, contra el resto. En la muestra de calibración (60 días) las primeras rindieron +0,15R y las siguientes cerca de 0; no está validado fuera de muestra."
              >
                <BucketTable rows={[
                  { label: 'Primera del día', bucket: report.firstOfDay },
                  { label: 'Resto', bucket: report.laterInDay },
                ]} />
              </Section>

              <Section
                title="POR ESTRATEGIA"
                note="Las informativas solo aparecen si activaste su registro (botón 🔬 del historial). No generan alertas principales."
              >
                <BucketTable rows={strategyRows} />
              </Section>

              <Section
                title="DEMORA Y EJECUCIÓN"
                note="La demora mide los segundos entre el cierre de la vela y la alerta. En la medición de noviembre de 2026, entrar más tarde no rindió peor que entrar en la vela de la señal. El costo de ejecución sale del precio que cargás en cada alerta (positivo = pagaste peor que el precio de la alerta)."
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                  <div>Demora media: <strong style={{ color: '#fff' }}>{report.latency.n > 0 ? `${Math.round(report.latency.avgSec)} s` : '—'}</strong></div>
                  <div>Demora máxima: <strong style={{ color: '#fff' }}>{report.latency.n > 0 ? `${report.latency.maxSec} s` : '—'}</strong></div>
                  <div>Alertas &gt; 60 s: <strong style={{ color: report.latency.over60s > 0 ? '#eab308' : '#fff' }}>{report.latency.n > 0 ? report.latency.over60s : '—'}</strong></div>
                  <div>Con precio cargado: <strong style={{ color: '#fff' }}>{report.execution.n}</strong></div>
                  <div>Costo medio: <strong style={{ color: report.execution.avgCostR > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>{report.execution.n > 0 ? formatR(report.execution.avgCostR) : '—'}</strong></div>
                  <div>R medio ajustado: <strong style={{ color: report.execution.adjustedAvgR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{report.execution.n > 0 ? formatR(report.execution.adjustedAvgR) : '—'}</strong></div>
                </div>
              </Section>

              <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.4, borderTop: '1px dashed rgba(255,255,255,0.1)', paddingTop: '10px' }}>
                En las ventas, el R equivale a vender y recomprar contra conservar la tenencia: si no se recompra en el día, cuenta la recompra al cierre de la sesión.
                Las tablas por franja y por estrategia cuentan alertas, no días: con pocas semanas de datos sus diferencias pueden ser azar.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
