import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MACRO_EVENTS,
  buildAlertEventNotice,
  buildEarningsEvent,
  getEarningsCalendarDateKeys,
  getEarningsNotice,
  getMacroNotice,
  getNextMacroEvent,
  getPreviousTradingDateKey,
  parseNasdaqEarningsRows,
  parseZacksEarningsDate,
  type EarningsEvent,
} from '../marketEvents';

// Monday 2026-11-02, 10:00 ET (EST, UTC-5)
const MON = Date.parse('2026-11-02T15:00:00Z');
const event = (over: Partial<EarningsEvent>): EarningsEvent => ({ dateKey: null, isConfirmed: true, timing: 'UNKNOWN', lastSessionAfterClose: false, ...over });

test('Zacks: confirmed date wins and expected epoch is read as a UTC day', () => {
  assert.deepEqual(parseZacksEarningsDate({ confirmed_reporting_date: '11/03/2026', expected_reporting_date: '1793664000' }), { dateKey: '2026-11-03', isConfirmed: true });
  assert.deepEqual(parseZacksEarningsDate({ confirmed_reporting_date: '', expected_reporting_date: '1802304000' }), { dateKey: '2027-02-11', isConfirmed: false });
  assert.equal(parseZacksEarningsDate({ confirmed_reporting_date: '', expected_reporting_date: '' }), null);
  assert.equal(parseZacksEarningsDate(undefined), null);
});

test('Nasdaq rows map to session timing', () => {
  assert.deepEqual(parseNasdaqEarningsRows([
    { symbol: 'AAPL', time: 'time-after-hours' }, { symbol: 'hut', time: 'time-pre-market' }, { symbol: 'X', time: 'time-not-supplied' }, {},
  ]), { AAPL: 'AMC', HUT: 'BMO', X: 'UNKNOWN' });
  assert.deepEqual(parseNasdaqEarningsRows(null), {});
});

test('Trading-day navigation skips weekends and NYSE holidays', () => {
  assert.equal(getPreviousTradingDateKey('2026-11-02'), '2026-10-30');
  assert.equal(getPreviousTradingDateKey('2026-11-27'), '2026-11-25'); // Thanksgiving
  const keys = getEarningsCalendarDateKeys(MON);
  assert.equal(keys[0], '2026-10-30');
  assert.equal(keys[1], '2026-11-02');
  assert.ok(!keys.includes('2026-11-07') && keys.includes('2026-11-09'));
});

test('buildEarningsEvent combines the Zacks date with the Nasdaq timing', () => {
  const calendars = { '2026-11-03': { AMD: 'AMC' as const } };
  assert.deepEqual(buildEarningsEvent('AMD', { dateKey: '2026-11-03', isConfirmed: true }, calendars, MON),
    { dateKey: '2026-11-03', isConfirmed: true, timing: 'AMC', lastSessionAfterClose: false });
  assert.deepEqual(buildEarningsEvent('NVDA', { dateKey: '2026-11-17', isConfirmed: true }, calendars, MON),
    { dateKey: '2026-11-17', isConfirmed: true, timing: 'UNKNOWN', lastSessionAfterClose: false });
});

test('buildEarningsEvent keeps the report of today after Zacks rolled to next quarter', () => {
  const calendars = { '2026-11-02': { PLTR: 'BMO' as const } };
  const rolled = { dateKey: '2027-02-11', isConfirmed: false };
  assert.deepEqual(buildEarningsEvent('PLTR', rolled, calendars, MON), { dateKey: '2026-11-02', isConfirmed: false, timing: 'BMO', lastSessionAfterClose: false });
  // A confirmed future date is not overridden by the list of today
  assert.equal(buildEarningsEvent('PLTR', { dateKey: '2026-11-05', isConfirmed: true }, calendars, MON)?.dateKey, '2026-11-05');
});

test('buildEarningsEvent flags the reaction session and drops past or absent dates', () => {
  const calendars = { '2026-10-30': { COIN: 'AMC' as const, XOM: 'BMO' as const } };
  const coin = buildEarningsEvent('COIN', { dateKey: '2027-02-11', isConfirmed: false }, calendars, MON);
  assert.equal(coin?.lastSessionAfterClose, true);
  assert.equal(buildEarningsEvent('XOM', { dateKey: '2026-10-30', isConfirmed: true }, calendars, MON), null);
  assert.equal(buildEarningsEvent('SPY', null, {}, MON), null);
});

test('Earnings notice distinguishes pre-market, after-close and unknown today', () => {
  const today = '2026-11-02';
  assert.equal(getEarningsNotice(event({ dateKey: today, timing: 'BMO' }), MON)?.label, 'BALANCE HOY · PRE');
  assert.equal(getEarningsNotice(event({ dateKey: today, timing: 'BMO' }), MON)?.tone, 'danger');
  assert.equal(getEarningsNotice(event({ dateKey: today, timing: 'AMC' }), MON)?.label, 'BALANCE HOY · CIERRE');
  assert.equal(getEarningsNotice(event({ dateKey: today, timing: 'AMC' }), MON)?.tone, 'warning');
  assert.equal(getEarningsNotice(event({ dateKey: today }), MON)?.label, 'BALANCE HOY');
  assert.equal(getEarningsNotice(event({ dateKey: today, timing: 'AMC', isConfirmed: false }), MON)?.label, '~BALANCE HOY · CIERRE');
  assert.match(getEarningsNotice(event({ dateKey: today, isConfirmed: false }), MON)?.title ?? '', /estimada/);
});

test('Earnings notice for the next session warns about overnight only when it can gap', () => {
  const pre = getEarningsNotice(event({ dateKey: '2026-11-03', timing: 'BMO' }), MON);
  assert.equal(pre?.label, 'BALANCE MAÑANA · PRE');
  assert.equal(pre?.tone, 'warning');
  const close = getEarningsNotice(event({ dateKey: '2026-11-03', timing: 'AMC' }), MON);
  assert.equal(close?.tone, 'info');
  // Friday → Monday is the next session but not "tomorrow"
  const friday = Date.parse('2026-10-30T15:00:00Z');
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-02', timing: 'BMO' }), friday)?.label, 'BALANCE LUN · PRE');
});

test('Earnings notice covers the week, then goes silent', () => {
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-05', timing: 'BMO' }), MON)?.label, 'BALANCE JUE 5 · PRE');
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-09' }), MON)?.label, 'BALANCE LUN 9');
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-10' }), MON), null);
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-01' }), MON), null);
  assert.equal(getEarningsNotice(null, MON), null);
});

test('Reaction session is shown, and a report today takes precedence', () => {
  assert.equal(getEarningsNotice(event({ lastSessionAfterClose: true, dateKey: '2027-02-11', isConfirmed: false }), MON)?.label, 'POST-BALANCE');
  assert.equal(getEarningsNotice(event({ lastSessionAfterClose: true, dateKey: '2026-11-02', timing: 'BMO' }), MON)?.label, 'BALANCE HOY · PRE');
});

test('The ET date is used near midnight, not the UTC or local date', () => {
  const lateEt = Date.parse('2026-11-03T03:00:00Z'); // Still Nov 2, 22:00 ET
  assert.equal(getEarningsNotice(event({ dateKey: '2026-11-02', timing: 'AMC' }), lateEt)?.label, 'BALANCE HOY · CIERRE');
});

test('Macro table matches the official 2026 schedule', () => {
  const dates = (kind: string) => MACRO_EVENTS.filter(e => e.kind === kind && e.date.startsWith('2026')).map(e => e.date.slice(5));
  assert.deepEqual(dates('FOMC'), ['01-28', '03-18', '04-29', '06-17', '07-29', '09-16', '10-28', '12-09']);
  assert.deepEqual(dates('CPI'), ['01-13', '02-13', '03-11', '04-10', '05-12', '06-10', '07-14', '08-12', '09-11', '10-14', '11-10', '12-10']);
  assert.ok(MACRO_EVENTS.every((e, i) => i === 0 || MACRO_EVENTS[i - 1].date < e.date));
});

test('Macro notice covers today and the next session only', () => {
  const nov10 = Date.parse('2026-11-10T15:00:00Z');
  const nov9 = Date.parse('2026-11-09T15:00:00Z');
  const fomc = Date.parse('2026-12-09T15:00:00Z');
  assert.equal(getMacroNotice(nov10)?.label, 'CPI HOY');
  assert.equal(getMacroNotice(nov9)?.label, 'CPI MAÑANA');
  assert.equal(getMacroNotice(MON), null);
  assert.equal(getMacroNotice(fomc)?.label, 'FOMC HOY');
  assert.equal(getMacroNotice(fomc)?.tone, 'danger');
  assert.equal(getNextMacroEvent(MON)?.date, '2026-11-10');
  assert.equal(getNextMacroEvent(MON)?.daysLeft, 8);
  assert.equal(getNextMacroEvent(Date.parse('2027-02-01T15:00:00Z')), null);
});

test('Alert snapshot joins both notices and is empty on a quiet day', () => {
  const nov10 = Date.parse('2026-11-10T15:00:00Z');
  assert.equal(buildAlertEventNotice(event({ dateKey: '2026-11-10', timing: 'AMC' }), nov10), 'BALANCE HOY · CIERRE · CPI HOY');
  assert.equal(buildAlertEventNotice(null, MON), undefined);
});
