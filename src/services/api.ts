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

const KLINE_TTL_MS = 25000; // 25s TTL for klines (prevents duplicates inside same 60s scan cycle)
const TICKER_SUMMARY_TTL_MS = 30000; // 30s TTL for ticker summaries
const NEWS_TTL_MS = 300000; // 5 min TTL for news
const EXTRA_INFO_TTL_MS = 3600000; // 1 hour TTL for Zacks / Fundamental data

async function fetchWithDeduplication<T>(
  cacheKey: string,
  ttlMs: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);
  if (cached && now - cached.timestamp < ttlMs) {
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

export async function fetchBinanceKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  const cacheKey = `binance_klines_${symbol}_${interval}`;
  return fetchWithDeduplication(cacheKey, KLINE_TTL_MS, async () => {
    try {
      // VCME day-trading needs a complete 48-hour forward window plus an
      // evaluation sample. Binance permits up to 1000 candles per request.
      const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`);
      if (!response.ok) {
        console.error(`Binance API error: ${response.status} ${response.statusText} for ${symbol} ${interval}`);
        return [];
      }
      const data = await response.json() as Array<Array<string | number>>;
      
      return data.map((item) => ({
        time: (item[0] as number) / 1000, // lightweight-charts expects seconds
        open: parseFloat(item[1] as string),
        high: parseFloat(item[2] as string),
        low: parseFloat(item[3] as string),
        close: parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string)
      }));
    } catch (error) {
      console.error("Error fetching data from Binance", error);
      return [];
    }
  });
}

export async function fetchYahooKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  const cacheKey = `yahoo_klines_${symbol}_${interval}`;
  return fetchWithDeduplication(cacheKey, KLINE_TTL_MS, async () => {
    try {
      // Convert interval to a valid range for Yahoo — wider ranges to support backtesting (300+ candles)
      let range = '3mo';  // 1h default: ~2000 hourly candles, we use 300
      if (interval === '1d') range = '2y';  // ~500 daily candles
      if (interval === '1wk') range = '5y';
      if (interval === '5m') range = '60d';
      
      const response = await fetch(`/api/yahoo/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
      if (!response.ok) {
        console.error(`Yahoo Finance API error: ${response.status} ${response.statusText} for ${symbol} ${interval}`);
        return [];
      }
      const data = await response.json();
      
      const result = data.chart?.result?.[0];
      if (!result) return [];
      
      const timestamps = result.timestamp;
      const quote = result.indicators.quote[0];
      
      if (!timestamps || !quote) return [];
      
      const klines: Kline[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (quote.open[i] !== null && quote.open[i] !== undefined) {
          klines.push({
            time: timestamps[i],
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
            volume: quote.volume[i] || 0
          });
        }
      }

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

      return klines;
    } catch (error) {
      console.error("Error fetching data from Yahoo", error);
      return [];
    }
  });
}

export async function fetchKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  if (symbol.endsWith('USDT') || symbol.endsWith('BTC')) {
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
      if (symbol.endsWith('USDT')) searchSymbol = symbol.replace('USDT', '-USD');
      
      const response = await fetch(`/api/yahoo/v1/finance/search?q=${searchSymbol}`);
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

export async function fetchEarningsDate(symbol: string): Promise<number | null> {
  if (symbol.endsWith('USDT') || symbol.endsWith('BTC')) {
    return null; // Crypto doesn't have corporate earnings reports
  }
  const cacheKey = `earnings_${symbol}`;
  return fetchWithDeduplication(cacheKey, EXTRA_INFO_TTL_MS, async () => {
    try {
      const response = await fetch(`/api/yahoo/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`);
      const data = await response.json();
      const earningsTimestamp = data.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
      return earningsTimestamp || null;
    } catch (error) {
      console.error("Error fetching earnings date", error);
      return null;
    }
  });
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
      const response = await fetch(`/api/yahoo/v8/finance/chart/${symbol}?range=1d&interval=1d`);
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
  if (symbol.endsWith('USDT') || symbol.endsWith('BTC')) {
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
        const response = await fetch(`/api/yahoo/v10/finance/quoteSummary/${symbol}?modules=financialData`);
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
          const response = await fetch(`/api/yahoo/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics`);
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

