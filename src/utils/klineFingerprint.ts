import type { Kline } from '../services/api';

const floatBuffer = new Float64Array(1);
const uintBuffer = new Uint32Array(floatBuffer.buffer);

export function mixFloat64(hash: number, val: number): number {
  floatBuffer[0] = val;
  hash = (hash ^ uintBuffer[0]) >>> 0;
  hash = Math.imul(hash, 16777619) >>> 0;
  hash = (hash ^ uintBuffer[1]) >>> 0;
  hash = Math.imul(hash, 16777619) >>> 0;
  return hash;
}

/**
 * Computes an FNV-1a 32-bit hash fingerprint for a list of OHLCV candle series.
 * Incorporates length, first/last candle times and closes, and full bar values.
 * Allows O(1) cache validation across multi-timeframe candle inputs.
 */
export function getKlinesFingerprint(seriesList: (Kline[] | undefined)[]): string {
  let fp = '';
  for (let sIdx = 0; sIdx < seriesList.length; sIdx++) {
    const s = seriesList[sIdx];
    if (!s || s.length === 0) {
      fp += '0:0|';
      continue;
    }
    const len = s.length;
    // FNV-1a 32-bit offset basis
    let hash = 2166136261 >>> 0;

    const first = s[0];
    const last = s[len - 1];
    hash = mixFloat64(hash, first.time);
    hash = mixFloat64(hash, first.close);
    hash = mixFloat64(hash, last.time);
    hash = mixFloat64(hash, last.close);

    for (let i = 0; i < len; i++) {
      const k = s[i];
      hash = (hash ^ k.time) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      hash = mixFloat64(hash, k.open);
      hash = mixFloat64(hash, k.high);
      hash = mixFloat64(hash, k.low);
      hash = mixFloat64(hash, k.close);
      hash = mixFloat64(hash, k.volume);
    }

    fp += `${len}:${last.time}:${hash.toString(16)}|`;
  }
  return fp;
}
