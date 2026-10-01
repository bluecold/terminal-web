import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isChartDataIncremental, formatLocalTickMark } from '../chartHelpers';
import { TickMarkType } from 'lightweight-charts';
import type { Kline } from '../../services/api';
import ErrorBoundary from '../../components/ErrorBoundary';

const bar = (time: number, close = 100): Kline => ({ time, open: 100, high: 102, low: 99, close, volume: 10 });

test('historical insertion before the last candle requires setData, not update', () => {
  assert.equal(isChartDataIncremental([bar(1000), bar(1600)], [bar(1000), bar(1300), bar(1600)]), false);
});

test('same-length tail timestamp changes require full replacement in either direction', () => {
  for (const changedTime of [1300, 1900]) {
    assert.equal(isChartDataIncremental([bar(1000), bar(1600)], [bar(1000), bar(changedTime)]), false);
  }
});

test('a valid append can finalize the old tail and update only nondecreasing timestamps', () => {
  const old = [bar(1000), bar(1300)];
  const next = [bar(1000), bar(1300, 101), bar(1600)];
  assert.equal(isChartDataIncremental(old, next), true);
  assert.equal(next.at(-2)!.time, old.at(-1)!.time);
  assert.ok(next.at(-1)!.time > next.at(-2)!.time);
});

test('repeated snapshots and forming-candle price updates remain incremental', () => {
  const old = [bar(1000), bar(1300)];
  assert.equal(isChartDataIncremental(old, old.map(k => ({ ...k }))), true);
  assert.equal(isChartDataIncremental(old, [bar(1000), bar(1300, 101)]), true);
});

test('duplicate, backward and nonfinite appended timestamps are never incremental', () => {
  for (const invalidTime of [1000, 1300, NaN, Infinity]) {
    assert.equal(isChartDataIncremental([bar(1000), bar(1300)], [bar(1000), bar(1300), bar(invalidTime)]), false);
  }
});

test('history replacement, rolling windows and multi-bar appends use full replacement', () => {
  const old = [bar(1000), bar(1300), bar(1600)];
  for (const next of [
    [bar(1000, 101), bar(1300), bar(1600)],
    [bar(1300), bar(1600), bar(1900)],
    [bar(1000), bar(1300)],
    [...old, bar(1900), bar(2200)],
    [],
  ]) assert.equal(isChartDataIncremental(old, next), false);
  assert.equal(isChartDataIncremental(undefined, old), false);
});

test('single-bar history can be revised at the same time or extended without backward updates', () => {
  assert.equal(isChartDataIncremental([bar(1000)], [bar(1000, 101)]), true);
  assert.equal(isChartDataIncremental([bar(1000)], [bar(1000), bar(1300)]), true);
  assert.equal(isChartDataIncremental([bar(1000)], [bar(700), bar(1000)]), false);
});

test('tail insertion regression holds across 200 different history sizes', () => {
  for (let size = 2; size <= 201; size++) {
    const previous = Array.from({ length: size }, (_, i) => bar(1000 + i * 300));
    const incoming = [...previous.slice(0, -1), bar(previous.at(-1)!.time - 150), previous.at(-1)!];
    assert.equal(isChartDataIncremental(previous, incoming), false, `history size ${size}`);
  }
});

test('error recovery reloads once without accessing or erasing browser storage', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let reloads = 0;
  const denyStorageAccess = () => { throw new Error('Recovery must not access storage'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { reload: () => { reloads++; } }, get localStorage() { return denyStorageAccess(); },
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denyStorageAccess });
  try {
    const boundary = new ErrorBoundary({ children: null });
    boundary.handleReload();
    assert.equal(reloads, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('fallback shows the actual exception and safe recovery, not an invented cache diagnosis', () => {
  const boundary = new ErrorBoundary({ children: null });
  boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('Cannot update oldest data <test>'));
  const html = renderToStaticMarkup(boundary.render());
  assert.ok(html.includes('Cannot update oldest data &lt;test&gt;'));
  assert.ok(html.includes('Recargar sin borrar datos'));
  assert.ok(!html.includes('versión previa'));
  assert.ok(!html.includes('Restablecer Caché'));
});

test('formatLocalTickMark: formats tick marks in user local timezone instead of UTC projection', () => {
  const sampleTime = 1726416000; // 2024-09-15 16:00:00 UTC
  const expectedDate = new Date(sampleTime * 1000);
  const expectedTimeStr = expectedDate.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  const expectedDayStr = expectedDate.toLocaleDateString([], { day: 'numeric' });
  const expectedYearStr = expectedDate.toLocaleDateString([], { year: 'numeric' });

  // 1. Time (HH:mm)
  assert.equal(formatLocalTickMark(sampleTime, TickMarkType.Time), expectedTimeStr);

  // 2. DayOfMonth (e.g. "15")
  assert.equal(formatLocalTickMark(sampleTime, TickMarkType.DayOfMonth), expectedDayStr);

  // 3. Year (e.g. "2024")
  assert.equal(formatLocalTickMark(sampleTime, TickMarkType.Year), expectedYearStr);

  // 4. Invalid timestamps return null safely
  assert.equal(formatLocalTickMark(NaN as unknown as number, TickMarkType.Time), null);
});
