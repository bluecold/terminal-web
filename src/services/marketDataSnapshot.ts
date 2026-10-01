import type { Kline } from './api';

// Metadata follows the cached array, not the time at which a consumer reads it.
// Weak keys avoid retaining discarded datasets or serializing per-candle metadata.
const snapshotTimes = new WeakMap<readonly Kline[], number>();

export function stampKlineSnapshot(klines: Kline[], asOfMs: number): Kline[] {
  snapshotTimes.set(klines, asOfMs);
  return klines;
}

export function getKlineSnapshotTime(klines: readonly Kline[]): number {
  let asOfMs = snapshotTimes.get(klines);
  if (asOfMs === undefined) {
    // External/unversioned datasets are fresh on first delivery only. Reusing
    // that array later cannot turn its provisional OHLC into a final close.
    asOfMs = Date.now();
    snapshotTimes.set(klines, asOfMs);
  }
  return Math.min(asOfMs, Date.now());
}
