export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchBinanceKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=300`);
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
}

export async function fetchYahooKlines(symbol: string, interval: string = '1h'): Promise<Kline[]> {
  try {
    // Convert interval to a valid range for Yahoo — wider ranges to support backtesting (300+ candles)
    let range = '3mo';  // 1h default: ~2000 hourly candles, we use 300
    if (interval === '1d') range = '2y';  // ~500 daily candles
    if (interval === '1wk') range = '5y';
    if (interval === '5m') range = '5d';  // ~1344 5m candles max from Yahoo
    
    const response = await fetch(`/api/yahoo/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
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
    
    return klines;
  } catch (error) {
    console.error("Error fetching data from Yahoo", error);
    return [];
  }
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
  try {
    let searchSymbol = symbol;
    if (symbol.endsWith('USDT')) searchSymbol = symbol.replace('USDT', '-USD');
    
    // Fetch Yahoo Finance news JSON through the local Vite proxy to avoid CORS and rate limits
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
}
