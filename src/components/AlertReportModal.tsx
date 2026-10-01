import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  buildAlertPerformanceReport,
  REPORT_TIME_SLOTS,
  type ArchivedAlert,
  type ReportBucket,
} from '../utils/alertReport';

interface AlertReportModalProps {
  alerts: ArchivedAlert[];
  onClose: () => void;
}

const PERIODS = [7, 14, 30] as const;

function formatR(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
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

export default function AlertReportModal({ alerts, onClose }: AlertReportModalProps) {
  const [days, setDays] = useState<number>(7);
  // The report window is anchored to the moment it is opened
  const [nowMs] = useState(() => Date.now());
  const report = useMemo(() => buildAlertPerformanceReport(alerts, nowMs, days), [alerts, nowMs, days]);

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
        background: 'rgba(5, 7, 12, 0.88)',
        backdropFilter: 'blur(8px)',
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

              <Section
                title="POR FRANJA HORARIA (ET)"
                note="La ventaja medida en 60 días se concentra antes de las 10:00 ET; de 10:00 a 11:00 rondaba el empate."
              >
                <BucketTable rows={REPORT_TIME_SLOTS.filter(s => report.bySlot[s].n > 0).map(s => ({ label: s, bucket: report.bySlot[s] }))} />
              </Section>

              <Section
                title="PRIMERA ALERTA DEL DÍA"
                note="Primera alerta principal de cada sesión en toda la watchlist, contra el resto. En 60 días las primeras rindieron +0,15R y las siguientes cerca de 0."
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
                note="La ventaja de Confluencia cae con la demora: ~0R a 1 minuto, −0,05R a 2 y −0,08R a 3. El costo de ejecución sale del precio que cargás en cada alerta (positivo = pagaste peor que el precio de la alerta)."
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
                Con pocas semanas de datos, diferencias menores a ±0,1R pueden ser azar.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
