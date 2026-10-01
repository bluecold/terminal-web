import type { AuditAlertItem, AlertStatus } from './alertTracker';
import { getEasternTime } from './indicators';

/**
 * Long-lived archive of resolved alerts and the weekly performance report built from it.
 *
 * The live alert log is trimmed to 100 entries and 7 days, which is too short to judge an engine
 * with real alerts. The archive keeps a compact copy of every resolved alert (90 days) so the
 * report can measure realized R by strategy, time slot, first alert of the day, alert latency and
 * the trader's real execution versus the alert price.
 */

export const ALERT_ARCHIVE_STORAGE_KEY = 'terminal_alert_archive';
const ARCHIVE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const ARCHIVE_MAX_ENTRIES = 3000;
const ACTIVE_STATUSES = new Set<AlertStatus>(['OPEN', 'TP1_HIT', 'TP2_HIT']);

export type ArchivedAlert = Pick<AuditAlertItem,
  'id' | 'symbol' | 'interval' | 'signal' | 'strategy' | 'strategyKey' | 'alertType' | 'confidence'
  | 'entryPrice' | 'stopLoss' | 'status' | 'realizedR' | 'timestamp' | 'candleTimestamp'
  | 'alertLatencySec' | 'userFillPrice' | 'userFillTime'>;

export function toArchivedAlert(a: AuditAlertItem): ArchivedAlert {
  return {
    id: a.id, symbol: a.symbol, interval: a.interval, signal: a.signal, strategy: a.strategy,
    strategyKey: a.strategyKey, alertType: a.alertType, confidence: a.confidence,
    entryPrice: a.entryPrice, stopLoss: a.stopLoss, status: a.status, realizedR: a.realizedR,
    timestamp: a.timestamp, candleTimestamp: a.candleTimestamp, alertLatencySec: a.alertLatencySec,
    userFillPrice: a.userFillPrice, userFillTime: a.userFillTime,
  };
}

/** Upserts resolved alerts from the live log into the archive, pruning by age and size. */
export function mergeIntoAlertArchive(
  archive: ArchivedAlert[],
  alerts: AuditAlertItem[],
  nowMs: number = Date.now()
): ArchivedAlert[] {
  const byId = new Map(archive.map(a => [a.id, a]));
  for (const alert of alerts) {
    if (ACTIVE_STATUSES.has(alert.status)) continue;
    byId.set(alert.id, toArchivedAlert(alert));
  }
  return [...byId.values()]
    .filter(a => typeof a.timestamp === 'number' && nowMs - a.timestamp <= ARCHIVE_MAX_AGE_MS)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ARCHIVE_MAX_ENTRIES);
}

export function loadAlertArchive(storage: Pick<Storage, 'getItem'> = localStorage): ArchivedAlert[] {
  try {
    const parsed = JSON.parse(storage.getItem(ALERT_ARCHIVE_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(a => a && typeof a.id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveAlertArchive(archive: ArchivedAlert[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(ALERT_ARCHIVE_STORAGE_KEY, JSON.stringify(archive));
  } catch (e) {
    console.error('Error saving alert archive to local storage', e);
  }
}

export function intervalToSeconds(interval: string): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 300;
  const n = Number(match[1]);
  return match[2] === 'm' ? n * 60 : match[2] === 'h' ? n * 3600 : n * 86400;
}

/** Seconds from the trigger candle close to the alert emission (undefined without a candle). */
export function computeAlertLatencySec(candleTimestampSec: number, interval: string, emittedAtMs: number): number | undefined {
  if (!(candleTimestampSec > 0)) return undefined;
  const closeMs = (candleTimestampSec + intervalToSeconds(interval)) * 1000;
  return Math.max(0, Math.round((emittedAtMs - closeMs) / 1000));
}

/**
 * Execution cost of the trader's fill versus the alert entry, in R of the alert's own risk.
 * Positive = the trader paid more than the alert price (worse fill).
 */
export function computeExecutionCostR(alert: Pick<ArchivedAlert, 'signal' | 'entryPrice' | 'stopLoss' | 'userFillPrice'>): number | undefined {
  const risk = Math.abs(alert.entryPrice - alert.stopLoss);
  if (!(alert.userFillPrice && alert.userFillPrice > 0) || !(risk > 0)) return undefined;
  const dir = alert.signal.includes('SELL') ? -1 : 1;
  return dir * (alert.userFillPrice - alert.entryPrice) / risk;
}

export interface ReportBucket {
  n: number;
  wins: number;
  losses: number;
  totalR: number;
  avgR: number;
}

export const REPORT_TIME_SLOTS = ['09:30–10:00', '10:00–11:00', '11:00–14:00', '14:00–16:00', 'Fuera de sesión'] as const;
export type ReportTimeSlot = typeof REPORT_TIME_SLOTS[number];

export interface AlertPerformanceReport {
  fromMs: number;
  toMs: number;
  primary: ReportBucket;
  byStrategy: Record<string, ReportBucket>;          // all alerts, by strategy label (informational included)
  bySlot: Record<ReportTimeSlot, ReportBucket>;     // primary alerts only
  firstOfDay: ReportBucket;                          // first primary alert of each ET day across the watchlist
  laterInDay: ReportBucket;
  latency: { n: number; avgSec: number; maxSec: number; over60s: number };
  execution: { n: number; avgCostR: number; adjustedAvgR: number };
}

function emptyBucket(): ReportBucket {
  return { n: 0, wins: 0, losses: 0, totalR: 0, avgR: 0 };
}

function addToBucket(bucket: ReportBucket, r: number): void {
  bucket.n++;
  if (r > 0.05) bucket.wins++;
  else if (r < -0.05) bucket.losses++;
  bucket.totalR += r;
  bucket.avgR = bucket.totalR / bucket.n;
}

export function getReportTimeSlot(candleTimestampSec: number): ReportTimeSlot {
  const m = getEasternTime(candleTimestampSec * 1000).minuteOfDay;
  if (m >= 570 && m < 600) return '09:30–10:00';
  if (m >= 600 && m < 660) return '10:00–11:00';
  if (m >= 660 && m < 840) return '11:00–14:00';
  if (m >= 840 && m < 960) return '14:00–16:00';
  return 'Fuera de sesión';
}

function etDayKey(candleTimestampSec: number): string {
  const et = getEasternTime(candleTimestampSec * 1000);
  return `${et.year}-${et.month}-${et.day}`;
}

/** Builds the performance report over resolved alerts emitted in the last `days` days. */
export function buildAlertPerformanceReport(
  alerts: ArchivedAlert[],
  nowMs: number = Date.now(),
  days: number = 7
): AlertPerformanceReport {
  const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
  const resolved = alerts.filter(a => !ACTIVE_STATUSES.has(a.status) && a.timestamp >= fromMs && a.timestamp <= nowMs && Number.isFinite(a.realizedR));
  const primaryAlerts = resolved.filter(a => (a.alertType ?? 'PRIMARY') === 'PRIMARY');

  const report: AlertPerformanceReport = {
    fromMs,
    toMs: nowMs,
    primary: emptyBucket(),
    byStrategy: {},
    bySlot: Object.fromEntries(REPORT_TIME_SLOTS.map(s => [s, emptyBucket()])) as Record<ReportTimeSlot, ReportBucket>,
    firstOfDay: emptyBucket(),
    laterInDay: emptyBucket(),
    latency: { n: 0, avgSec: 0, maxSec: 0, over60s: 0 },
    execution: { n: 0, avgCostR: 0, adjustedAvgR: 0 },
  };

  for (const a of resolved) {
    addToBucket(report.byStrategy[a.strategy] ??= emptyBucket(), a.realizedR);
  }

  const firstCandleByDay = new Map<string, number>();
  for (const a of primaryAlerts) {
    if (!a.candleTimestamp) continue;
    const day = etDayKey(a.candleTimestamp);
    const prev = firstCandleByDay.get(day);
    if (prev === undefined || a.candleTimestamp < prev) firstCandleByDay.set(day, a.candleTimestamp);
  }

  let latencySum = 0;
  let costSum = 0;
  let adjustedSum = 0;
  for (const a of primaryAlerts) {
    addToBucket(report.primary, a.realizedR);
    if (a.candleTimestamp) {
      addToBucket(report.bySlot[getReportTimeSlot(a.candleTimestamp)], a.realizedR);
      const isFirst = firstCandleByDay.get(etDayKey(a.candleTimestamp)) === a.candleTimestamp;
      addToBucket(isFirst ? report.firstOfDay : report.laterInDay, a.realizedR);
    }
    if (a.alertLatencySec !== undefined && Number.isFinite(a.alertLatencySec)) {
      report.latency.n++;
      latencySum += a.alertLatencySec;
      report.latency.maxSec = Math.max(report.latency.maxSec, a.alertLatencySec);
      if (a.alertLatencySec > 60) report.latency.over60s++;
    }
    const cost = computeExecutionCostR(a);
    if (cost !== undefined) {
      report.execution.n++;
      costSum += cost;
      adjustedSum += a.realizedR - cost;
    }
  }
  if (report.latency.n > 0) report.latency.avgSec = latencySum / report.latency.n;
  if (report.execution.n > 0) {
    report.execution.avgCostR = costSum / report.execution.n;
    report.execution.adjustedAvgR = adjustedSum / report.execution.n;
  }
  return report;
}
