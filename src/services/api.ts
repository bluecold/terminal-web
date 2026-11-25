import { getKlineSnapshotTime, stampKlineSnapshot } from './marketDataSnapshot';
import { isCryptoAsset } from '../utils/indicators';
import {
  buildEarningsEvent,
  getEarningsCalendarDateKeys,
  parseNasdaqEarningsRows,
  parseZacksEarningsDate,
  type EarningsEvent,
  type EarningsTiming,
  type ZacksEarningsDate,
} from '../utils/marketEvents';

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Request Deduplication & In-Memory Cache Layer ────────────────────────────
interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

const apiCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

const KLINE_TTL_MS = 25000; // 25s default TTL for 5m intraday klines
const TICKER_SUMMARY_TTL_MS = 30000; // 30s TTL for ticker summaries
const NEWS_TTL_MS = 300000; // 5 min TTL for news
const EXTRA_INFO_TTL_MS = 3600000; // 1 hour TTL for Zacks / Fundamental data

export function getKlineTtlMs(interval: string): number {
  if (interval === '1d' || interval === '1wk') return 600000; // 10 min TTL for daily/weekly klines
  if (interval === '1h' || interval === '4h') return 120000; // 2 min TTL for hourly klines
  return KLINE_TTL_MS; // 25s TTL for intraday 5m klines
}

/**
 * Candle period after which a cached intraday kline snapshot is stale: a snapshot taken before a
 * candle boundary still sees the just-closed candle as forming, so it must not be reused after it.
 */
export function getKlineCacheBoundaryMs(interval: string): number | undefined {
  const match = /^(\d+)m$/.exec(interval);
  return match ? Number(match[1]) * 60_000 : undefined;
}

async function fetchWithDeduplication<T>(
  cacheKey: string,
  ttlMs: number,
  fetchFn: () => Promise<T>,
  boundaryMs?: number
): Promise<T> {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);
  const samePeriod = !cached || !boundaryMs || Math.floor(cached.timestamp / boundaryMs) === Math.floor(now / boundaryMs);
  if (cached && now - cached.timestamp < ttlMs && samePeriod) {
    return cached.data as T;
  }

  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey) as Promise<T>;
  }

  const promise = (async () => {
    try {
      const data = await fetchFn();
      if (data !== null && data !== undefined && (!Array.isArray(data) || data.length > 0)) {
        apiCache.set(cacheKey, { timestamp: Date.now(), data });
      }
      return data;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  return promise;
}

/**
 * Rigorously validates, sanitizes, geometrizes, deduplicates, and sorts OHLCV candles:
 * - All OHLC and time values must be finite and strictly positive (> 0).
 * - Enforces geometric bounds: high >= max(open, close), low <= min(open, close).
 * - Volume must be finite and non-negative (defaults to 0 if missing/invalid).
 * - Deduplicates timestamps and enforces strictly ascending chronological order.
 */
export function sanitizeKlines(rawKlines: Kline[]): Kline[] {
  if (!Array.isArray(rawKlines) || rawKlines.length === 0) return [];

  const seenTimes = new Set<number>();
  const valid: Kline[] = [];

  for (let i = 0; i < rawKlines.length; i++) {
    const k = rawKlines[i];
    if (!k) continue;

    const t = typeof k.time === 'number' ? k.time : Number(k.time);
    const o = typeof k.open === 'number' ? k.open : Number(k.open);
    const h = typeof k.high === 'number' ? k.high : Number(k.high);
    const l = typeof k.low === 'number' ? k.low : Number(k.low);
    const c = typeof k.close === 'number' ? k.close : Number(k.close);
    const v = typeof k.volume === 'number' ? k.volume : Number(k.volume);

    if (
      Number.isFinite(t) && t > 0 &&
      Number.isFinite(o) && o > 0 &&
      Number.isFinite(h) && h > 0 &&
      Number.isFinite(l) && l > 0 &&
      Number.isFinite(c) && c > 0
    ) {
      if (!seenTimes.has(t)) {
        seenTimes.add(t);
        const trueHigh = Math.max(h, o, c);
        const trueLow = Math.min(l, o, c);
        const trueVol = Number.isFinite(v) && v >= 0 ? v : 0;

        valid.push({
          time: t,
          open: o,
          high: trueHigh,
          low: trueLow,
          close: c,
          volume: trueVol,
        });
      }
    }
  }

  valid.sort((a, b) => a.time - b.time);
  return valid;
}

const YAHOO_INTRADAY_STEP_SEC: Record<string, number> = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '60m': 3600, '90m': 5400, '1h': 3600 };

/**
 * During the regular session Yahoo appends a live quote point stamped with the last trade time
 * (e.g. 09:36:51, volume 0) after the forming bar. Left as its own bar it makes the forming bar look
 * closed to getConfirmedClosedKlines, and gives trackers off-grid bars whose real candle is never
 * observed closing. Fold every off-grid point into the bar whose span contains it (bar grid anchored
 * on the previous bar, so 09:30-anchored 1h bars stay aligned); daily points merge by session date.
 */
export function normalizeYahooKlines(klines: Kline[], interval: string): Kline[] {
  if (klines.length < 2) return klines;
  const step = YAHOO_INTRADAY_STEP_SEC[interval];
  const isDaily = interval === '1d';
  if (!step && !isDaily) return klines;

  // US session dates: every regular-session timestamp is 13:30–21:00 UTC, so a fixed −5h shift
  // yields the New York calendar date in both EST and EDT.
  const sessionDate = (t: number) => Math.floor((t - 5 * 3600) / 86400);
  const out: Kline[] = [{ ...klines[0] }];
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const prev = out[out.length - 1];
    const delta = k.time - prev.time;
    const sameBar = step ? delta < step : delta < 20 * 3600 && sessionDate(k.time) === sessionDate(prev.time);
    if (sameBar) {
      prev.high = Math.max(prev.high, k.high);
      prev.low = Math.min(prev.low, k.low);
      prev.close = k.close;
      prev.volume += k.volume;
    } else if (step && delta % step !== 0) {
      out.push({ ...k, time: prev.time + Math.floor(delta / step) * step });
    } else {
      out.push({ ...k });
    }
  }
  return out;
}

export function resampleKlines(klines: Kline[], targetIntervalSec: number): Kline[] {
  if (!klines || klines.length === 0) return [];
  const buckets = new Map<number, Kline[]>();
  for (const k of klines) {
    const bucketTime = Math.floor(k.time / targetIntervalSec) * targetIntervalSec;
    const list = buckets.get(bucketTime);
    if (!list) buckets.set(bucketTime, [k]);
    else list.push(k);
  }
  const result: Kline[] = [];
  for (const [time, group] of buckets.entries()) {
    result.push({
      time,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((acc, g) => acc + (g.volume || 0), 0)
    });
  }
  return result.sort((a, b) => a.time - b.time);
}

export async function fetchBinanceKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  const cacheKey = `binance_klines_${symbol}_${interval}`;
  return fetchWithDeduplication(cacheKey, getKlineTtlMs(interval), async () => {
    const snapshotTime = Date.now();
    try {
      // 1. Fetch primary batch of up to 1000 candles
      const url1 = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
      const response1 = await fetch(url1);
      if (!response1.ok) {
        console.error(`Binance API error: ${response1.status} ${response1.statusText} for ${symbol} ${interval}`);
        return [];
      }
      const data1 = await response1.json() as Array<Array<string | number>>;
      if (!Array.isArray(data1) || data1.length === 0) return [];

      let combinedRaw = data1;

      // 2. For 5m intraday, paginate up to 4 batches (up to 4000 candles total ~14 days 24/7)
      // to ensure sufficient statistical sample size for low-frequency models (VCME Sniper, Multifractal)
      if (interval === '5m' && data1.length >= 800) {
        const maxPages = 4;
        let oldestTimeMs = Number(combinedRaw[0][0]);
        for (let page = 2; page <= maxPages; page++) {
          if (!Number.isFinite(oldestTimeMs) || oldestTimeMs <= 0) break;
          const urlPage = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${oldestTimeMs - 1}`;
          try {
            const respPage = await fetch(urlPage);
            if (!respPage.ok) break;
            const dataPage = await respPage.json() as Array<Array<string | number>>;
            if (!Array.isArray(dataPage) || dataPage.length === 0) break;
            combinedRaw = [...dataPage, ...combinedRaw];
            oldestTimeMs = Number(dataPage[0][0]);
            if (dataPage.length < 800) break;
          } catch (errPage) {
            console.warn(`Could not fetch 5m page ${page} for ${symbol}:`, errPage);
            break;
          }
        }
      }

      const rawKlines: Kline[] = combinedRaw.map(item => ({
        time: (item[0] as number) / 1000,
        open: parseFloat(item[1] as string),
        high: parseFloat(item[2] as string),
        low: parseFloat(item[3] as string),
        close: parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string)
      }));

      return stampKlineSnapshot(sanitizeKlines(rawKlines), snapshotTime);
    } catch (error) {
      console.error("Error fetching data from Binance", error);
      return [];
    }
  }, getKlineCacheBoundaryMs(interval));
}

/**
 * Executes a fetch against the Yahoo Finance proxy with a single retry for transient
 * gateway errors (500, 502, 503, 504) or network interruptions.
 */
export async function fetchYahooWithRetry(url: string, retries: number = 1, delayMs: number = 250): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
      if (resp.status < 500 && resp.status !== 429) return resp;
      if (attempt === retries) return resp;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
  }
  return fetch(url);
}

export async function fetchYahooKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  // Yahoo does not provide native 4h candles; construct from 1h candles
  if (interval === '4h') {
    const klines1h = await fetchYahooKlines(symbol, '1h');
    return stampKlineSnapshot(resampleKlines(klines1h, 14400), getKlineSnapshotTime(klines1h));
  }

  const cacheKey = `yahoo_klines_${symbol}_${interval}`;
  return fetchWithDeduplication(cacheKey, getKlineTtlMs(interval), async () => {
    const snapshotTime = Date.now();
    try {
      // Convert interval to a valid range for Yahoo — wider ranges to support backtesting (300+ candles)
      // Note: Yahoo 1h interval is capped at 730 calendar days. Using '2y' respects this cap natively
      // across all tickers (including recently listed ones like IBIT, FBTC, RDDT) without triggering
      // the 422 Unprocessable Entity error that '730d' causes (since Yahoo resolves '730d' to 730 trading days).
      let range = '2y'; // 1h default: up to 2 years (~3500 hourly candles for US stocks/crypto)
      if (interval === '1d') range = '2y';  // ~500 daily candles
      if (interval === '1wk') range = '5y';
      if (interval === '5m' || interval === '15m' || interval === '30m' || interval === '90m') range = '60d';
      
      let response = await fetchYahooWithRetry(`/api/yahoo/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
      // Fallback: if '2y' is rejected for an ultra-short-lived or exotic symbol, gracefully retry with '1y'
      if (!response.ok && range === '2y' && interval === '1h') {
        range = '1y';
        response = await fetchYahooWithRetry(`/api/yahoo/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
      }
      if (!response.ok) {
        console.error(`Yahoo Finance API error: ${response.status} ${response.statusText} for ${symbol} ${interval}`);
        return [];
      }
      const data = await response.json();
      
      const result = data.chart?.result?.[0];
      if (!result) return [];
      
      const timestamps = result.timestamp;
      const quote = result.indicators.quote?.[0];
      
      if (!timestamps || !quote) return [];
      
      const rawKlines: Kline[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        rawKlines.push({
          time: timestamps[i],
          open: quote.open ? quote.open[i] : NaN,
          high: quote.high ? quote.high[i] : NaN,
          low: quote.low ? quote.low[i] : NaN,
          close: quote.close ? quote.close[i] : NaN,
          volume: quote.volume ? quote.volume[i] : 0
        });
      }

      const klines = normalizeYahooKlines(sanitizeKlines(rawKlines), interval);

      // Pre-populate ticker summary cache if fetching daily klines
      if (interval === '1d' && klines.length >= 1) {
        const latest = klines[klines.length - 1];
        const prev = klines.length >= 2 ? klines[klines.length - 2] : latest;
        const price = latest.close;
        const prevClose = prev.close;
        const change = price - prevClose;
        const changePercent = prevClose ? (change / prevClose) * 100 : 0;
        apiCache.set(`summary_${symbol}`, {
          timestamp: Date.now(),
          data: {
            symbol,
            name: symbol,
            price,
            change,
            changePercent
          }
        });
      }

      return stampKlineSnapshot(klines, snapshotTime);
    } catch (error) {
      console.error("Error fetching data from Yahoo", error);
      return [];
    }
  }, getKlineCacheBoundaryMs(interval));
}

export async function fetchKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  if (isCryptoAsset(symbol)) {
    return fetchBinanceKlines(symbol, interval);
  } else {
    return fetchYahooKlines(symbol, interval);
  }
}

export interface NewsItem {
  title: string;
  source: string;
  time: string;
  url: string;
}

interface YahooNewsItem {
  title?: string;
  publisher?: string;
  providerPublishTime: number;
  link?: string;
}

export async function fetchNews(symbol: string): Promise<NewsItem[]> {
  const cacheKey = `news_${symbol}`;
  return fetchWithDeduplication(cacheKey, NEWS_TTL_MS, async () => {
    try {
      let searchSymbol = symbol;
      if (isCryptoAsset(symbol)) searchSymbol = symbol.replace(/(USDT|BUSD|USDC|FDUSD)$/, '-USD');
      
      const response = await fetchYahooWithRetry(`/api/yahoo/v1/finance/search?q=${searchSymbol}`);
      const data = await response.json();
      
      if (!data || !data.news || !Array.isArray(data.news)) return [];
      
      return (data.news as YahooNewsItem[]).slice(0, 3).map((item) => {
        const date = new Date(item.providerPublishTime * 1000);
        const timeStr = isNaN(date.getTime()) 
          ? "00:00" 
          : `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        
        return {
          title: item.title || "",
          source: item.publisher || "Yahoo Finance",
          time: timeStr,
          url: item.link || ""
        };
      });
    } catch (error) {
      console.error("Error fetching news", error);
      return [];
    }
  });
}

const ZACKS_BATCH_SIZE = 40;

async function fetchZacksEarningsDates(symbols: string[]): Promise<Record<string, ZacksEarningsDate | null>> {
  const out: Record<string, ZacksEarningsDate | null> = {};
  const missing: string[] = [];
  for (const symbol of symbols) {
    const cached = apiCache.get(`earnings_date_${symbol}`) as CacheEntry<ZacksEarningsDate | null> | undefined;
    if (cached && Date.now() - cached.timestamp < EXTRA_INFO_TTL_MS) out[symbol] = cached.data;
    else missing.push(symbol);
  }
  for (let i = 0; i < missing.length; i += ZACKS_BATCH_SIZE) {
    const batch = missing.slice(i, i + ZACKS_BATCH_SIZE);
    const data = await fetchWithDeduplication(`earnings_zacks_${batch.join(',')}`, EXTRA_INFO_TTL_MS, async () => {
      try {
        const response = await fetch(`/api/zacks/index?t=${batch.join(',')}&cb=${Date.now()}`);
        if (!response.ok) throw new Error(`Zacks responded with status ${response.status}`);
        return await response.json() as Record<string, Parameters<typeof parseZacksEarningsDate>[0]>;
      } catch (error) {
        console.warn('Zacks earnings dates fetch failed', error);
        return null;
      }
    });
    if (!data) continue;
    for (const symbol of batch) {
      out[symbol] = parseZacksEarningsDate(data[symbol]);
      apiCache.set(`earnings_date_${symbol}`, { timestamp: Date.now(), data: out[symbol] });
    }
  }
  return out;
}

async function fetchNasdaqEarningsDay(dateKey: string): Promise<Record<string, EarningsTiming> | null> {
  return fetchWithDeduplication(`earnings_nasdaq_${dateKey}`, EXTRA_INFO_TTL_MS, async () => {
    try {
      const response = await fetch(`/api/nasdaq/api/calendar/earnings?date=${dateKey}`);
      if (!response.ok) throw new Error(`Nasdaq responded with status ${response.status}`);
      const data = await response.json();
      return parseNasdaqEarningsRows(data?.data?.rows);
    } catch (error) {
      console.warn(`Nasdaq earnings calendar fetch failed for ${dateKey}`, error);
      return null;
    }
  });
}

/** Next earnings report per symbol. Without the Nasdaq calendar the dates still work, with unknown timing. */
export async function fetchEarningsCalendar(symbols: string[]): Promise<Record<string, EarningsEvent>> {
  const eligible = [...new Set(symbols.map(s => s.toUpperCase()))].filter(s => !isCryptoAsset(s) && /^[A-Z][A-Z.-]{0,6}$/.test(s));
  if (eligible.length === 0) return {};

  const nowMs = Date.now();
  const dateKeys = getEarningsCalendarDateKeys(nowMs);
  const [zacks, days] = await Promise.all([
    fetchZacksEarningsDates(eligible),
    Promise.all(dateKeys.map(fetchNasdaqEarningsDay)),
  ]);
  const calendars: Record<string, Record<string, EarningsTiming>> = {};
  dateKeys.forEach((key, i) => { calendars[key] = days[i] ?? {}; });

  const out: Record<string, EarningsEvent> = {};
  for (const symbol of eligible) {
    const event = buildEarningsEvent(symbol, zacks[symbol] ?? null, calendars, nowMs);
    if (event) out[symbol] = event;
  }
  return out;
}

export interface TickerSummary {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

export async function fetchTickerSummary(symbol: string, prettyName: string): Promise<TickerSummary | null> {
  const cacheKey = `summary_${symbol}`;
  const now = Date.now();

  // 1. Check if summary is already in memory cache
  const cached = apiCache.get(cacheKey);
  if (cached && now - cached.timestamp < TICKER_SUMMARY_TTL_MS && cached.data) {
    return { ...(cached.data as TickerSummary), name: prettyName };
  }

  // 2. Check if daily klines for this symbol were recently fetched by Scanner/Chart
  const cachedYahooKlines = apiCache.get(`yahoo_klines_${symbol}_1d`);
  const cachedBinanceKlines = apiCache.get(`binance_klines_${symbol}_1d`);
  const cachedKlinesEntry = cachedYahooKlines || cachedBinanceKlines;
  if (cachedKlinesEntry && now - cachedKlinesEntry.timestamp < TICKER_SUMMARY_TTL_MS) {
    const klines = cachedKlinesEntry.data as Kline[];
    if (klines && klines.length >= 1) {
      const latest = klines[klines.length - 1];
      const prev = klines.length >= 2 ? klines[klines.length - 2] : latest;
      const price = latest.close;
      const prevClose = prev.close;
      const change = price - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;
      const summary: TickerSummary = {
        symbol,
        name: prettyName,
        price,
        change,
        changePercent
      };
      apiCache.set(cacheKey, { timestamp: now, data: summary });
      return summary;
    }
  }

  // 3. Otherwise fetch via deduplicated network request
  return fetchWithDeduplication(cacheKey, TICKER_SUMMARY_TTL_MS, async () => {
    try {
      const response = await fetchYahooWithRetry(`/api/yahoo/v8/finance/chart/${symbol}?range=1d&interval=1d`);
      const data = await response.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (!meta) return null;

      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
      const change = price - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;

      return {
        symbol,
        name: prettyName,
        price,
        change,
        changePercent
      };
    } catch (e) {
      console.error(`Error fetching ticker summary for ${symbol}`, e);
      return null;
    }
  });
}

export interface StockExtraInfo {
  recommendationMean: number | null;
  recommendationKey: string | null;
  targetMeanPrice: number | null;
  currentPrice: number | null;
  beta: number | null;
  zacksRankText?: string | null;
  source?: 'zacks' | 'yahoo' | 'both' | null;
}

export async function fetchZacksRank(symbol: string): Promise<StockExtraInfo | null> {
  const upperSymbol = symbol.toUpperCase();
  const cacheKey = `zacks_${upperSymbol}`;
  return fetchWithDeduplication(cacheKey, EXTRA_INFO_TTL_MS, async () => {
    try {
      const response = await fetch(`/api/zacks/index?t=${upperSymbol}&cb=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`Zacks responded with status ${response.status}`);
      }
      const data = await response.json();
      const info = data[upperSymbol];
      if (!info) return null;

      // Map zacks_rank string ("1" to "5") to numeric representation
      const recMean = info.zacks_rank ? parseFloat(info.zacks_rank) : null;
      
      // Map text to key
      let recKey: string | null = null;
      if (info.zacks_rank_text) {
        const text = info.zacks_rank_text.toLowerCase();
        if (text.includes('strong buy')) recKey = 'strong_buy';
        else if (text.includes('strong sell')) recKey = 'strong_sell';
        else if (text.includes('buy')) recKey = 'buy';
        else if (text.includes('sell')) recKey = 'sell';
        else if (text.includes('hold')) recKey = 'hold';
      }

      const betaVal = info.source?.sungard?.volatility ? parseFloat(info.source.sungard.volatility) : null;
      const priceVal = info.source?.sungard?.close ? parseFloat(info.source.sungard.close) : (info.last ? parseFloat(info.last) : null);

      return {
        recommendationMean: recMean,
        recommendationKey: recKey,
        targetMeanPrice: null,
        currentPrice: priceVal,
        beta: betaVal,
        zacksRankText: info.zacks_rank_text || null,
        source: 'zacks'
      };
    } catch (error) {
      console.warn(`Zacks Rank fetch failed for ${symbol}:`, error);
      return null;
    }
  });
}

export async function fetchStockExtraInfo(symbol: string): Promise<StockExtraInfo | null> {
  if (isCryptoAsset(symbol)) {
    return null;
  }
  const cacheKey = `stock_extra_${symbol}`;
  return fetchWithDeduplication(cacheKey, EXTRA_INFO_TTL_MS, async () => {
    try {
      // 1. Fetch Zacks Rank data
      const zacksInfo = await fetchZacksRank(symbol);

      // 2. Fetch Yahoo data for target price
      let yahooTargetPrice: number | null = null;
      try {
        const response = await fetchYahooWithRetry(`/api/yahoo/v10/finance/quoteSummary/${symbol}?modules=financialData`);
        if (response.ok) {
          const data = await response.json();
          const result = data.quoteSummary?.result?.[0];
          if (result && result.financialData) {
            yahooTargetPrice = result.financialData.targetMeanPrice?.raw ?? null;
          }
        }
      } catch (e) {
        console.warn(`Yahoo Finance target price fetch failed for ${symbol}:`, e);
      }

      if (zacksInfo) {
        return {
          ...zacksInfo,
          targetMeanPrice: yahooTargetPrice,
          source: yahooTargetPrice ? 'both' : 'zacks'
        };
      }

      // Fallback to Yahoo if Zacks fails but Yahoo succeeds
      if (yahooTargetPrice) {
        let beta: number | null = null;
        try {
          const response = await fetchYahooWithRetry(`/api/yahoo/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics`);
          if (response.ok) {
            const data = await response.json();
            const result = data.quoteSummary?.result?.[0];
            if (result && result.defaultKeyStatistics) {
              beta = result.defaultKeyStatistics.beta?.raw ?? null;
            }
          }
        } catch (e) {
          console.warn(`Yahoo Finance beta fetch failed for ${symbol}:`, e);
        }

        return {
          recommendationMean: null,
          recommendationKey: null,
          targetMeanPrice: yahooTargetPrice,
          currentPrice: null,
          beta: beta,
          source: 'yahoo'
        };
      }

      return null;
    } catch (error) {
      console.warn(`All fundamental data sources failed or were blocked for ${symbol}:`, error);
      return null;
    }
  });
}

export interface CryptoExtraInfo {
  value: number;
  classification: string;
  timestamp: number;
}

export async function fetchCryptoFearAndGreed(): Promise<CryptoExtraInfo | null> {
  const cacheKey = `crypto_fng`;
  return fetchWithDeduplication(cacheKey, 600000, async () => {
    try {
      const response = await fetch(`https://api.alternative.me/fng/?limit=1&t=${Date.now()}`);
      const data = await response.json();
      const fngData = data.data?.[0];
      if (!fngData) return null;

      return {
        value: parseInt(fngData.value) || 50,
        classification: fngData.value_classification || "Neutral",
        timestamp: parseInt(fngData.timestamp) || Date.now() / 1000
      };
    } catch (error) {
      console.error("Error fetching crypto fear and greed", error);
      return null;
    }
  });
}
