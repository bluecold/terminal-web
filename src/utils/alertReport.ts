import { generateCandleAlertKey, type AuditAlertItem, type AlertStatus } from './alertTracker';
import { getEasternTime } from './indicators';

/**
 * Long-lived archive of resolved alerts and the weekly performance report built from it.
 *
 * The live alert log is trimmed to 100 entries and 7 days, which is too short to judge an engine
 * with real alerts. The archive keeps a compact copy of every resolved alert (90 days) so the
 * report can measure realized R by strategy, time slot, first alert of the day, alert latency and
 * the trader's real execution versus the alert price.
 */

/** Legacy localStorage key: the archive now lives in IndexedDB (alertArchiveStore.ts), this is the fallback. */
export const ALERT_ARCHIVE_STORAGE_KEY = 'terminal_alert_archive';
const ARCHIVE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// Safety bound only: the 90-day window is the real limit. The old 3000 cap was reached at ~42 closed
// alerts/day, silently shortening the "90 días" report to ~70 days. ~380 chars per entry → ~7.6 MB.
export const ARCHIVE_MAX_ENTRIES = 20000;
export const ACTIVE_STATUSES = new Set<AlertStatus>(['OPEN', 'TP1_HIT', 'TP2_HIT']);

export type ArchivedAlert = Pick<AuditAlertItem,
  'id' | 'symbol' | 'interval' | 'signal' | 'strategy' | 'strategyKey' | 'alertType' | 'confidence'
  | 'entryPrice' | 'stopLoss' | 'status' | 'realizedR' | 'timestamp' | 'candleTimestamp'
  | 'alertLatencySec' | 'userFillPrice' | 'userFillTime' | 'appVersion'>;

export function toArchivedAlert(a: AuditAlertItem): ArchivedAlert {
  return {
    id: a.id, symbol: a.symbol, interval: a.interval, signal: a.signal, strategy: a.strategy,
    strategyKey: a.strategyKey, alertType: a.alertType, confidence: a.confidence,
    entryPrice: a.entryPrice, stopLoss: a.stopLoss, status: a.status, realizedR: a.realizedR,
    timestamp: a.timestamp, candleTimestamp: a.candleTimestamp, alertLatencySec: a.alertLatencySec,
    userFillPrice: a.userFillPrice, userFillTime: a.userFillTime, appVersion: a.appVersion,
  };
}

/**
 * One alert per symbol, interval, candle, strategy and direction (same key as the live dedup registry).
 * Two scanners running at once (e.g. two open tabs) used to emit the same candle twice with distinct ids.
 */
function archiveLogicalKey(a: Pick<ArchivedAlert, 'id' | 'symbol' | 'interval' | 'candleTimestamp' | 'strategy' | 'signal'>): string {
  return a.candleTimestamp && a.candleTimestamp > 0
    ? generateCandleAlertKey(a.symbol, a.interval, a.candleTimestamp, a.strategy, a.signal)
    : `id:${a.id}`;
}

/**
 * Upserts archived entries (later lists win for the same alert id), keeping one entry per logical
 * alert and pruning by age and size. Shared by the live merge and by backup imports.
 */
export function mergeArchivedAlerts(
  lists: ArchivedAlert[][],
  nowMs: number = Date.now()
): ArchivedAlert[] {
  const arrays = lists;
  const byKey = new Map<string, ArchivedAlert>();
  const upsert = (entry: ArchivedAlert) => {
    const key = archiveLogicalKey(entry);
    const existing = byKey.get(key);
    // The same alert updates in place; a duplicate emission of the same candle keeps the first one
    if (!existing || existing.id === entry.id || entry.timestamp < existing.timestamp) byKey.set(key, entry);
  };
  arrays.forEach(list => list.forEach(upsert));
  return [...byKey.values()]
    .filter(a => typeof a.timestamp === 'number' && nowMs - a.timestamp <= ARCHIVE_MAX_AGE_MS)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ARCHIVE_MAX_ENTRIES);
}

/** Upserts resolved alerts from the live log into the archive, pruning by age, size and duplicates. */
export function mergeIntoAlertArchive(
  archive: ArchivedAlert[],
  alerts: AuditAlertItem[],
  nowMs: number = Date.now()
): ArchivedAlert[] {
  const resolved = alerts.filter(a => !ACTIVE_STATUSES.has(a.status)).map(toArchivedAlert);
  return mergeArchivedAlerts([archive, resolved], nowMs);
}

/** Identity of what the archive would receive from the live log: skip writes when nothing changed. */
export function archiveInputSignature(alerts: AuditAlertItem[]): string {
  return alerts
    .filter(a => !ACTIVE_STATUSES.has(a.status))
    .map(a => `${a.id}|${a.status}|${a.realizedR}|${a.userFillPrice ?? ''}`)
    .join(';');
}

function isArchivedAlertLike(a: unknown): a is ArchivedAlert {
  const x = a as Partial<ArchivedAlert> | null;
  return !!x && typeof x.id === 'string' && typeof x.symbol === 'string' && typeof x.status === 'string'
    && typeof x.timestamp === 'number' && Number.isFinite(x.realizedR);
}

export function loadAlertArchive(storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): ArchivedAlert[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(ALERT_ARCHIVE_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(a => a && typeof a.id === 'string') : [];
  } catch {
    return [];
  }
}

/** Saves the archive to localStorage (fallback store). Returns false when the browser refuses it (e.g. quota). */
export function saveAlertArchive(archive: ArchivedAlert[], storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(ALERT_ARCHIVE_STORAGE_KEY, JSON.stringify(archive));
    return true;
  } catch (e) {
    console.error('Error saving alert archive to local storage', e);
    return false;
  }
}

// ─── Backup export / import ────────────────────────────────────────────────

export const ALERT_EXPORT_FORMAT = 'terminal-lite-alerts';

export interface AlertExportFile {
  format: typeof ALERT_EXPORT_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  archive: ArchivedAlert[];      // resolved alerts (what the INFORME uses)
  liveLog: AuditAlertItem[];     // full live log, with targets and execution state
}

export function buildAlertExport(archive: ArchivedAlert[], liveLog: AuditAlertItem[], appVersion: string, nowMs: number = Date.now()): AlertExportFile {
  return {
    format: ALERT_EXPORT_FORMAT,
    formatVersion: 1,
    exportedAt: new Date(nowMs).toISOString(),
    appVersion,
    archive,
    liveLog,
  };
}

/**
 * Reads resolved alerts from a backup: this app's export, the older console-snippet export
 * ({ archive, liveLog }) or a bare array. Active alerts in a live log are skipped (they are still
 * being tracked); invalid entries are dropped. Throws when nothing in the file looks like alerts.
 */
export function parseAlertImport(data: unknown): ArchivedAlert[] {
  const obj = (data && typeof data === 'object' && !Array.isArray(data)) ? data as Record<string, unknown> : null;
  const archiveRaw: unknown[] = Array.isArray(data) ? data : Array.isArray(obj?.archive) ? obj!.archive as unknown[] : [];
  const liveRaw: unknown[] = Array.isArray(obj?.liveLog) ? obj!.liveLog as unknown[] : [];
  if (archiveRaw.length === 0 && liveRaw.length === 0) {
    throw new Error('El archivo no contiene alertas (se espera un export de TERMINAL LITE).');
  }
  const fromLive = liveRaw
    .filter((a): a is AuditAlertItem => isArchivedAlertLike(a) && !ACTIVE_STATUSES.has((a as AuditAlertItem).status))
    .map(toArchivedAlert);
  const fromArchive = archiveRaw.filter(isArchivedAlertLike).map(a => toArchivedAlert(a as unknown as AuditAlertItem));
  return [...fromArchive, ...fromLive];
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

export interface ReportDay {
  day: string;   // ET session day, YYYY-MM-DD
  bucket: ReportBucket;
}

/**
 * Primary alerts with the ET day as the unit. Alerts of the same day are strongly correlated
 * (one market move triggers many symbols), so the confidence interval is clustered by day.
 */
export interface ReportDayStats {
  days: ReportDay[];             // newest first
  ci95HalfWidth?: number;        // of the mean R per alert; undefined with fewer than 3 days
  bestDay?: ReportDay;           // by total R; undefined with fewer than 2 days
  avgRWithoutBestDay?: number;
  worstDay?: ReportDay;
  avgRWithoutWorstDay?: number;
}

export interface AlertReportOptions {
  /** Keep only alerts emitted by this app version or a later one (unversioned alerts are older). */
  minVersion?: string;
}

export interface AlertPerformanceReport {
  fromMs: number;
  toMs: number;
  versions: string[];            // app versions present in the window, newest first (before the version filter)
  unversioned: number;           // resolved alerts in the window emitted before versions were recorded
  byDay: ReportDayStats;
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
  return `${et.year}-${String(et.month).padStart(2, '0')}-${String(et.day).padStart(2, '0')}`;
}

/** Orders app versions (`vYYYY.MM.DD.N`) numerically, part by part. */
export function compareAppVersions(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Two-sided 95% Student t quantiles for 1..30 degrees of freedom
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

function buildDayStats(primaryAlerts: ArchivedAlert[]): ReportDayStats {
  const byDay = new Map<string, ReportBucket>();
  for (const a of primaryAlerts) {
    const day = etDayKey(a.candleTimestamp && a.candleTimestamp > 0 ? a.candleTimestamp : a.timestamp / 1000);
    let bucket = byDay.get(day);
    if (!bucket) byDay.set(day, bucket = emptyBucket());
    addToBucket(bucket, a.realizedR);
  }
  const days = [...byDay.entries()].map(([day, bucket]) => ({ day, bucket })).sort((a, b) => b.day.localeCompare(a.day));
  const stats: ReportDayStats = { days };
  const g = days.length;
  const n = primaryAlerts.length;
  if (g < 2) return stats;

  const totalR = days.reduce((sum, d) => sum + d.bucket.totalR, 0);
  const without = (d: ReportDay) => (totalR - d.bucket.totalR) / (n - d.bucket.n);
  stats.bestDay = days.reduce((best, d) => d.bucket.totalR > best.bucket.totalR ? d : best);
  stats.worstDay = days.reduce((worst, d) => d.bucket.totalR < worst.bucket.totalR ? d : worst);
  stats.avgRWithoutBestDay = without(stats.bestDay);
  stats.avgRWithoutWorstDay = without(stats.worstDay);

  if (g >= 3) {
    // Cluster-robust standard error of the mean R per alert, clusters = days
    const mean = totalR / n;
    const ss = days.reduce((sum, d) => sum + (d.bucket.totalR - mean * d.bucket.n) ** 2, 0);
    const se = Math.sqrt((g / (g - 1)) * ss) / n;
    stats.ci95HalfWidth = (T95[g - 2] ?? 1.96) * se;
  }
  return stats;
}

/** Builds the performance report over resolved alerts emitted in the last `days` days. */
export function buildAlertPerformanceReport(
  alerts: ArchivedAlert[],
  nowMs: number = Date.now(),
  days: number = 7,
  options: AlertReportOptions = {}
): AlertPerformanceReport {
  const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
  const inWindow = alerts.filter(a => !ACTIVE_STATUSES.has(a.status) && a.timestamp >= fromMs && a.timestamp <= nowMs && Number.isFinite(a.realizedR));
  const versions = [...new Set(inWindow.map(a => a.appVersion).filter((v): v is string => !!v))].sort((a, b) => compareAppVersions(b, a));
  const { minVersion } = options;
  const resolved = minVersion
    ? inWindow.filter(a => !!a.appVersion && compareAppVersions(a.appVersion, minVersion) >= 0)
    : inWindow;
  const primaryAlerts = resolved.filter(a => (a.alertType ?? 'PRIMARY') === 'PRIMARY');

  const report: AlertPerformanceReport = {
    fromMs,
    toMs: nowMs,
    versions,
    unversioned: inWindow.filter(a => !a.appVersion).length,
    byDay: buildDayStats(primaryAlerts),
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
