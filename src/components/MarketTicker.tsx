import { useEffect, useState } from 'react';
import { fetchTickerSummary } from '../services/api';
import type { TickerSummary } from '../services/api';

const TICKERS_TO_FETCH = [
  { symbol: 'ES=F', name: 'S&P Futures' },
  { symbol: 'YM=F', name: 'Dow Futures' },
  { symbol: 'NQ=F', name: 'Nasdaq Futures' },
  { symbol: 'RTY=F', name: 'Russell 2000' },
  { symbol: '^VIX', name: 'VIX' },
  { symbol: 'GC=F', name: 'Gold' },
  { symbol: 'CL=F', name: 'Crude Oil' },
  { symbol: 'BTC-USD', name: 'Bitcoin USD' },
];

export default function MarketTicker() {
  const [data, setData] = useState<TickerSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      const results = await Promise.all(
        TICKERS_TO_FETCH.map(t => fetchTickerSummary(t.symbol, t.name))
      );
      const validResults = results.filter((r): r is TickerSummary => r !== null);
      if (validResults.length > 0) {
        setData(validResults);
      }
    } catch (e) {
      console.error('Error fetching ticker summaries', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000); // Polling every 60 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading && data.length === 0) {
    return (
      <div className="ticker-wrapper">
        <div className="ticker-loading">Loading market indices...</div>
      </div>
    );
  }

  if (data.length === 0) return null;

  // Duplicate items to ensure a seamless scrolling effect
  const tickerItems = [...data, ...data, ...data]; // Triple items to guarantee enough width for scroll continuity

  return (
    <div className="ticker-wrapper">
      <div className="ticker-scroll">
        {tickerItems.map((item, idx) => {
          const isPositive = item.change >= 0;
          const formattedPrice = item.price.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const formattedChange = Math.abs(item.change).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const formattedPercent = item.changePercent.toFixed(2);

          return (
            <div key={`${item.symbol}-${idx}`} className="ticker-item">
              <span className="ticker-name">{item.name}</span>
              <span className="ticker-price">${formattedPrice}</span>
              <span className={`ticker-change ${isPositive ? 'positive' : 'negative'}`}>
                <span className="ticker-arrow">{isPositive ? '▲' : '▼'}</span>
                {isPositive ? '+' : '-'}{formattedChange} ({isPositive ? '+' : ''}{formattedPercent}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
