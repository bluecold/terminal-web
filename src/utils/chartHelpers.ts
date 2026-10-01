import type { Kline } from '../services/api';
import { TickMarkType, type Time } from 'lightweight-charts';

/**
 * Validates whether incoming chart data is an incremental update vs a full historical mutation.
 * Returns true only if:
 * 1. Both datasets exist and have bars.
 * 2. Data starts at the exact same timestamp.
 * 3. Length has not shrunk and grew by at most 1 bar.
 * 4. All historical bars before the tail are identical across time, open, high, low, close, and volume.
 * 5. The old tail keeps its timestamp; an appended bar is strictly newer.
 */
export function isChartDataIncremental(
  prevData: Kline[] | null | undefined,
  nextData: Kline[] | null | undefined
): boolean {
  if (!prevData || prevData.length === 0 || !nextData || nextData.length === 0) {
    return false;
  }
  if (nextData.length < prevData.length || nextData.length > prevData.length + 1) {
    return false;
  }
  if (nextData[0].time !== prevData[0].time) {
    return false;
  }

  // A longer array may contain a historical insertion, not a newly opened bar.
  // Chart finalizes nextData[oldLength - 1] using update(), which may only
  // replace the series' latest timestamp or append a strictly newer one.
  const oldTailIndex = prevData.length - 1;
  const oldTailTime = prevData[oldTailIndex].time;
  if (!Number.isFinite(oldTailTime) || nextData[oldTailIndex].time !== oldTailTime) {
    return false;
  }
  if (nextData.length > prevData.length) {
    const appendedTime = nextData[nextData.length - 1].time;
    if (!Number.isFinite(appendedTime) || appendedTime <= oldTailTime) return false;
  }

  const checkLimit = Math.min(prevData.length - 1, nextData.length - 1);
  for (let i = 0; i < checkLimit; i++) {
    const p = prevData[i];
    const d = nextData[i];
    if (
      d.time !== p.time ||
      d.open !== p.open ||
      d.high !== p.high ||
      d.low !== p.low ||
      d.close !== p.close ||
      d.volume !== p.volume
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Formats timeScale tick marks using the user's local timezone instead of UTC.
 * Aligns the horizontal X-axis labels with the crosshair time tooltip and local clock.
 */
export function formatLocalTickMark(
  time: Time | number,
  tickMarkType: TickMarkType,
  locale: string = ''
): string | null {
  let date: Date;
  if (typeof time === 'number') {
    date = new Date(time * 1000);
  } else if (typeof time === 'string') {
    date = new Date(time);
  } else if (time && typeof time === 'object' && 'year' in time) {
    date = new Date(time.year, time.month - 1, time.day);
  } else {
    return null;
  }

  if (isNaN(date.getTime())) return null;

  const loc = locale || undefined;
  switch (tickMarkType) {
    case TickMarkType.Year:
      return date.toLocaleDateString(loc, { year: 'numeric' });
    case TickMarkType.Month:
      return date.toLocaleDateString(loc, { month: 'short' });
    case TickMarkType.DayOfMonth:
      return date.toLocaleDateString(loc, { day: 'numeric' });
    case TickMarkType.Time:
      return date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
    case TickMarkType.TimeWithSeconds:
      return date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    default:
      return null;
  }
}
