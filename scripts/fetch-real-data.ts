/**
 * scripts/fetch-real-data.ts
 *
 * Downloads and caches ~60 days of genuine 5m candles for the 15-stock watchlist
 * from Yahoo Finance via the local Vite dev server proxy (http://localhost:5173/api/yahoo)
 * or directly via query1.finance.yahoo.com.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { sanitizeKlines } from '../src/services/api';

export const WATCHLIST_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN',
  'GOOGL', 'META', 'AMD', 'SPY', 'QQQ',
  'INTC', 'NFLX', 'BABA', 'PLTR', 'JPM'
];

const CACHE_DIR = path.resolve(process.cwd(), 'scratch/watchlist-5m');

export function getCachedKlines(symbol: string): Kline[] | null {
  const filePath = path.join(CACHE_DIR, `${symbol}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps: number[] = result.timestamp;
    const quote = result.indicators?.quote?.[0];
    if (!timestamps || !quote) return null;

    const rawKlines: Kline[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      rawKlines.push({
        time: timestamps[i],
        open: quote.open ? quote.open[i] : NaN,
        high: quote.high ? quote.high[i] : NaN,
        low: quote.low ? quote.low[i] : NaN,
        close: quote.close ? quote.close[i] : NaN,
        volume: quote.volume ? quote.volume[i] : 0,
      });
    }
    const sanitized = sanitizeKlines(rawKlines);
    // Discard final candle if downloaded in mid-formation (non-aligned timestamp or partial interval)
    if (sanitized.length > 1) {
      const last = sanitized[sanitized.length - 1];
      const prev = sanitized[sanitized.length - 2];
      if (last.time % 300 !== 0 || (last.time - prev.time < 300)) {
        sanitized.pop();
      }
    }
    return sanitized;
  } catch (err) {
    console.error(`Error reading cached klines for ${symbol}:`, err);
    return null;
  }
}

export async function fetchAndCacheSymbol(symbol: string): Promise<Kline[]> {
  const cached = getCachedKlines(symbol);
  if (cached && cached.length > 500) {
    return cached;
  }

  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const filePath = path.join(CACHE_DIR, `${symbol}.json`);
  const urls = [
    `http://localhost:5173/api/yahoo/v8/finance/chart/${symbol}?range=60d&interval=5m`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=60d&interval=5m`
  ];

  let rawText = '';
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (res.ok) {
        rawText = await res.text();
        if (rawText.length > 1000) break;
      }
    } catch {
      // try next
    }
  }

  if (!rawText || rawText.length < 1000) {
    throw new Error(`Failed to fetch 60d 5m data for ${symbol}`);
  }

  fs.writeFileSync(filePath, rawText, 'utf-8');
  const parsed = getCachedKlines(symbol);
  if (!parsed || parsed.length === 0) {
    throw new Error(`Failed to parse candles for ${symbol}`);
  }
  return parsed;
}

export async function loadWatchlistRealData(): Promise<Map<string, Kline[]>> {
  const map = new Map<string, Kline[]>();
  console.log(`[Data] Loading real 60-day 5m data for ${WATCHLIST_SYMBOLS.length} US equities...`);
  for (const sym of WATCHLIST_SYMBOLS) {
    try {
      const klines = await fetchAndCacheSymbol(sym);
      map.set(sym, klines);
      console.log(`  ✓ ${sym.padEnd(5)}: ${klines.length} velas reales (del ${new Date(klines[0].time * 1000).toISOString().slice(0, 10)} al ${new Date(klines[klines.length - 1].time * 1000).toISOString().slice(0, 10)})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${sym}: ${msg}`);
    }
  }
  return map;
}

if (process.argv[1]?.includes('fetch-real-data')) {
  loadWatchlistRealData().then(() => console.log('[Data] Descarga completada.'));
}
