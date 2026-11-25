import { useEffect, useState, useCallback } from 'react';
import { Pause, Play } from 'lucide-react';
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

const STORAGE_KEY = 'terminal_ticker_animation_paused';

export default function MarketTicker() {
  const [data, setData] = useState<TickerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPageVisible, setIsPageVisible] = useState(() => !document.hidden);

  const [isPaused, setIsPaused] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) {
        return saved === 'true';
      }
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    } catch {
      // Safe fallback if localStorage or matchMedia is restricted
    }
    return false;
  });

  const togglePause = useCallback(() => {
    setIsPaused(prev => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Safe fallback
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      try {
        const results = await Promise.all(
          TICKERS_TO_FETCH.map(t => fetchTickerSummary(t.symbol, t.name))
        );
        const validResults = results.filter((r): r is TickerSummary => r !== null);
        if (isMounted && validResults.length > 0) {
          setData(validResults);
        }
      } catch (e) {
        console.error('Error fetching ticker summaries', e);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsPageVisible(visible);
      if (visible) {
        loadData();
      }
    };

    loadData();
    const interval = setInterval(() => {
      if (!document.hidden) {
        loadData();
      }
    }, 60000);

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  if (loading && data.length === 0) {
    return (
      <div className="ticker-container">
        <div className="ticker-wrapper">
          <div className="ticker-loading">Loading market indices...</div>
        </div>
      </div>
    );
  }

  if (data.length === 0) return null;

  // Duplicate items to ensure a seamless scrolling effect
  const tickerItems = [...data, ...data, ...data]; // Triple items to guarantee enough width for scroll continuity
  const isAnimationActive = !isPaused && isPageVisible;

  return (
    <div className="ticker-container">
      <button
        type="button"
        className={`ticker-toggle-btn ${isPaused ? 'is-paused' : ''}`}
        onClick={togglePause}
        title={isPaused ? "Reanudar animación del carrusel" : "Pausar animación del carrusel (ahorra GPU)"}
        aria-label={isPaused ? "Reanudar animación del carrusel" : "Pausar animación del carrusel (ahorra GPU)"}
        aria-pressed={isPaused}
      >
        {isPaused ? <Play size={10} fill="currentColor" /> : <Pause size={10} fill="currentColor" />}
        <span className="ticker-btn-label">{isPaused ? 'REANUDAR' : 'PAUSAR'}</span>
      </button>

      <div
        className={`ticker-wrapper ${isPaused ? 'is-paused' : ''}`}
        onClick={togglePause}
        title={isPaused ? "Haz clic para reanudar animación" : "Haz clic para pausar animación (ahorra GPU)"}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            togglePause();
          }
        }}
      >
        <div
          className={`ticker-scroll ${isPaused ? 'is-paused' : ''}`}
          style={{
            animationPlayState: isAnimationActive ? 'running' : 'paused',
            willChange: isPaused ? 'auto' : 'transform',
          }}
        >
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
    </div>
  );
}
