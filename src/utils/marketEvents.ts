import { getEasternTime, isNyseHoliday } from './indicators';

/**
 * Scheduled catalysts shown next to a symbol. Purely informational: nothing here blocks or filters
 * an alert, because no event filter has been validated out of sample.
 */
export type EarningsTiming = 'BMO' | 'AMC' | 'UNKNOWN';

export interface EarningsEvent {
  dateKey: string | null;          // YYYY-MM-DD (ET) of the next report
  isConfirmed: boolean;
  timing: EarningsTiming;
  lastSessionAfterClose: boolean;  // Reported after the previous close: this session trades the reaction
}

export interface EventNotice {
  label: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
}

export const EARNINGS_NOTICE_WINDOW_DAYS = 7;

// Official schedules: federalreserve.gov/monetarypolicy/fomccalendars.htm (decision day) and
// bls.gov/schedule/2026/home.htm. Extend them when the next year's calendars are reviewed.
export const MACRO_EVENTS = [
  { date: '2026-01-13', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-01-28', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-02-13', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-03-11', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-03-18', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-04-10', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-04-29', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-05-12', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-06-10', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-06-17', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-07-14', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-07-29', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-08-12', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-09-11', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-09-16', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-10-14', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-10-28', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-11-10', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2026-12-09', kind: 'FOMC', title: 'Decisión de Tasas FOMC' },
  { date: '2026-12-10', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
  { date: '2027-01-13', kind: 'CPI', title: 'IPC de EEUU (CPI)' },
] as const;

const WEEKDAYS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
const DAY_MS = 86_400_000;

const keyToUtcMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
const utcMsToKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function getEasternDateKey(nowMs: number = Date.now()): string {
  const et = getEasternTime(nowMs);
  return `${et.year}-${String(et.month).padStart(2, '0')}-${String(et.day).padStart(2, '0')}`;
}

function shiftToTradingDay(key: string, step: 1 | -1): string {
  let ms = keyToUtcMs(key);
  for (let i = 0; i < 10; i++) {
    ms += step * DAY_MS;
    const d = new Date(ms);
    if (!isNyseHoliday(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) break;
  }
  return utcMsToKey(ms);
}

export const getNextTradingDateKey = (key: string) => shiftToTradingDay(key, 1);
export const getPreviousTradingDateKey = (key: string) => shiftToTradingDay(key, -1);

export function getDaysUntil(key: string, nowMs: number = Date.now()): number {
  return Math.round((keyToUtcMs(key) - keyToUtcMs(getEasternDateKey(nowMs))) / DAY_MS);
}

/** Trading days whose after-the-fact or upcoming calendars are needed to build the notices. */
export function getEarningsCalendarDateKeys(nowMs: number = Date.now()): string[] {
  const today = getEasternDateKey(nowMs);
  const keys = [getPreviousTradingDateKey(today)];
  const lastMs = keyToUtcMs(today) + EARNINGS_NOTICE_WINDOW_DAYS * DAY_MS;
  for (let ms = keyToUtcMs(today); ms <= lastMs; ms += DAY_MS) {
    const d = new Date(ms);
    if (!isNyseHoliday(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) keys.push(utcMsToKey(ms));
  }
  return keys;
}

// ── Source parsing ───────────────────────────────────────────────────────────

export interface ZacksEarningsDate {
  dateKey: string;
  isConfirmed: boolean;
}

/** confirmed_reporting_date is MM/DD/YYYY; expected_reporting_date is epoch seconds at 00:00 UTC of that day. */
export function parseZacksEarningsDate(info: { confirmed_reporting_date?: unknown; expected_reporting_date?: unknown } | null | undefined): ZacksEarningsDate | null {
  const confirmed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(info?.confirmed_reporting_date ?? '').trim());
  if (confirmed) return { dateKey: `${confirmed[3]}-${confirmed[1]}-${confirmed[2]}`, isConfirmed: true };
  const expected = Number(info?.expected_reporting_date);
  if (Number.isFinite(expected) && expected > 0) return { dateKey: utcMsToKey(expected * 1000), isConfirmed: false };
  return null;
}

export function parseNasdaqEarningsRows(rows: unknown): Record<string, EarningsTiming> {
  const out: Record<string, EarningsTiming> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows as { symbol?: unknown; time?: unknown }[]) {
    if (typeof row?.symbol !== 'string') continue;
    out[row.symbol.toUpperCase()] = row.time === 'time-pre-market' ? 'BMO' : row.time === 'time-after-hours' ? 'AMC' : 'UNKNOWN';
  }
  return out;
}

/**
 * Zacks gives the date of the next report and Nasdaq the session timing. Once a company reports, Zacks
 * rolls to an unconfirmed estimate of the following quarter, so Nasdaq's list for today prevails over
 * anything that is not a confirmed date.
 */
export function buildEarningsEvent(
  symbol: string,
  zacks: ZacksEarningsDate | null,
  calendars: Record<string, Record<string, EarningsTiming>>,
  nowMs: number = Date.now()
): EarningsEvent | null {
  const today = getEasternDateKey(nowMs);
  const upper = symbol.toUpperCase();
  const lastSessionAfterClose = calendars[getPreviousTradingDateKey(today)]?.[upper] === 'AMC';
  const upcoming = zacks && zacks.dateKey >= today ? zacks : null;
  const listedToday = calendars[today]?.[upper];

  let dateKey = upcoming?.dateKey ?? null;
  let isConfirmed = upcoming?.isConfirmed ?? false;
  if (listedToday && !isConfirmed) {
    dateKey = today;
    isConfirmed = false;
  }
  if (!dateKey && !lastSessionAfterClose) return null;

  return { dateKey, isConfirmed, timing: (dateKey && calendars[dateKey]?.[upper]) || 'UNKNOWN', lastSessionAfterClose };
}

// ── Notices ──────────────────────────────────────────────────────────────────

const TIMING_SUFFIX: Record<EarningsTiming, string> = { BMO: ' · PRE', AMC: ' · CIERRE', UNKNOWN: '' };

export function getEarningsNotice(event: EarningsEvent | null | undefined, nowMs: number = Date.now()): EventNotice | null {
  if (!event) return null;
  const today = getEasternDateKey(nowMs);
  const mark = event.isConfirmed ? '' : '~';
  const estimateNote = event.isConfirmed ? '' : ' Fecha estimada, sin confirmar.';

  if (event.dateKey === today) {
    if (event.timing === 'BMO') {
      return { label: `${mark}BALANCE HOY${TIMING_SUFFIX.BMO}`, tone: 'danger', title: `Presenta hoy antes de la apertura: la sesión opera la reacción al balance.${estimateNote}` };
    }
    if (event.timing === 'AMC') {
      return { label: `${mark}BALANCE HOY${TIMING_SUFFIX.AMC}`, tone: 'warning', title: `Presenta hoy tras el cierre: quien mantenga la posición pasadas las 16:00 ET queda expuesto al hueco.${estimateNote}` };
    }
    return { label: `${mark}BALANCE HOY`, tone: 'danger', title: `Presenta hoy, sin horario informado: puede ser antes de la apertura o tras el cierre.${estimateNote}` };
  }

  if (event.lastSessionAfterClose) {
    return { label: 'POST-BALANCE', tone: 'danger', title: 'Presentó balance tras el último cierre: esta sesión opera la reacción.' };
  }

  if (!event.dateKey) return null;
  const days = getDaysUntil(event.dateKey, nowMs);
  if (days < 0 || days > EARNINGS_NOTICE_WINDOW_DAYS) return null;

  const weekday = WEEKDAYS[new Date(keyToUtcMs(event.dateKey)).getUTCDay()];
  if (event.dateKey === getNextTradingDateKey(today)) {
    const when = days === 1 ? 'MAÑANA' : weekday;
    if (event.timing === 'AMC') {
      return { label: `${mark}BALANCE ${when}${TIMING_SUFFIX.AMC}`, tone: 'info', title: `Presenta la próxima sesión tras el cierre.${estimateNote}` };
    }
    return { label: `${mark}BALANCE ${when}${TIMING_SUFFIX[event.timing]}`, tone: 'warning', title: `Presenta la próxima sesión${event.timing === 'BMO' ? ' antes de la apertura' : ', sin horario informado'}: mantener la posición de un día a otro la expone al hueco.${estimateNote}` };
  }
  const dayOfMonth = Number(event.dateKey.slice(8));
  return { label: `${mark}BALANCE ${weekday} ${dayOfMonth}${TIMING_SUFFIX[event.timing]}`, tone: 'info', title: `Presenta en ${days} días.${estimateNote}` };
}

export function getNextMacroEvent(nowMs: number = Date.now()) {
  const today = getEasternDateKey(nowMs);
  const event = MACRO_EVENTS.find(e => e.date >= today);
  return event ? { ...event, daysLeft: getDaysUntil(event.date, nowMs) } : null;
}

export function getMacroNotice(nowMs: number = Date.now()): EventNotice | null {
  const today = getEasternDateKey(nowMs);
  const event = MACRO_EVENTS.find(e => e.date >= today);
  if (!event) return null;
  const detail = event.kind === 'CPI' ? 'Se publica a las 08:30 ET, antes de la apertura.' : 'Decisión a las 14:00 ET, en plena sesión.';
  if (event.date === today) return { label: `${event.kind} HOY`, tone: event.kind === 'FOMC' ? 'danger' : 'warning', title: `${event.title}. ${detail}` };
  if (event.date === getNextTradingDateKey(today)) {
    const days = getDaysUntil(event.date, nowMs);
    const when = days === 1 ? 'MAÑANA' : WEEKDAYS[new Date(keyToUtcMs(event.date)).getUTCDay()];
    return { label: `${event.kind} ${when}`, tone: 'info', title: `${event.title}, próxima sesión. ${detail}` };
  }
  return null;
}

/** Snapshot stored on an alert: a stale "BALANCE HOY" must not be recomputed on a later day. */
export function buildAlertEventNotice(event: EarningsEvent | null | undefined, nowMs: number = Date.now()): string | undefined {
  const labels = [getEarningsNotice(event, nowMs), getMacroNotice(nowMs)].filter(Boolean).map(n => n!.label);
  return labels.length > 0 ? labels.join(' · ') : undefined;
}
