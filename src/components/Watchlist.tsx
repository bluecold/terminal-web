import { useState, useEffect, useRef } from 'react';
import { fetchTickerSummary } from '../services/api';
import { X } from 'lucide-react';

interface WatchlistProps {
  symbols: string[];
  onSelectAsset: (asset: string) => void;
  onRemoveAsset: (asset: string) => void;
  currentAsset: string;
}

interface AssetData {
  symbol: string;
  price: string;
  change: string;
}

export default function Watchlist({ symbols, onSelectAsset, onRemoveAsset, currentAsset }: WatchlistProps) {
  const [assets, setAssets] = useState<AssetData[]>([]);
  const assetsRef = useRef<AssetData[]>([]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    let isMounted = true;

    const fetchPrices = async () => {
      const sortedSymbols = [...symbols].sort((a, b) => a.localeCompare(b));

      // Seed with existing data immediately to avoid blank flicker
      const seeded: AssetData[] = sortedSymbols.map(sym => {
        const existing = assetsRef.current.find(a => a.symbol === sym);
        return existing || { symbol: sym, price: '...', change: '...' };
      });
      if (isMounted) setAssets([...seeded]);

      // Fetch all symbols in parallel using the lightweight ticker endpoint
      await Promise.all(
        sortedSymbols.map(async (sym, idx) => {
          try {
            // For crypto use the Binance klines fallback (fetchTickerSummary is Yahoo-only)
            if (sym.endsWith('USDT') || sym.endsWith('BTC')) {
              const { fetchKlines } = await import('../services/api');
              const klines = await fetchKlines(sym, '1d');
              if (!isMounted) return;
              if (klines.length >= 2) {
                const latest = klines[klines.length - 1];
                const prev   = klines[klines.length - 2];
                const pct    = ((latest.close - prev.close) / prev.close) * 100;
                seeded[idx] = {
                  symbol: sym,
                  price: latest.close >= 1000
                    ? latest.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : latest.close.toFixed(2),
                  change: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
                };
              }
            } else {
              // Stocks/ETFs/Futures: use the lightweight summary endpoint
              const summary = await fetchTickerSummary(sym, sym);
              if (!isMounted) return;
              if (summary) {
                seeded[idx] = {
                  symbol: sym,
                  price: summary.price >= 1000
                    ? summary.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : summary.price.toFixed(2),
                  change: `${summary.changePercent >= 0 ? '+' : ''}${summary.changePercent.toFixed(2)}%`
                };
              }
            }
            if (isMounted) setAssets([...seeded]);
          } catch (e) {
            console.error('Error fetching watchlist data for', sym, e);
          }
        })
      );
    };

    fetchPrices();
    const intervalId = setInterval(fetchPrices, 60000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [symbols]);

  return (
    <div style={{ padding: '12px 0', overflowY: 'auto' }}>
      {assets.map((asset) => {
        const isCurrent = currentAsset === asset.symbol;
        const changeIsPositive = asset.change.startsWith('+');
        const changeIsNegative = asset.change.startsWith('-');
        
        return (
          <div 
            key={asset.symbol}
            onClick={() => onSelectAsset(asset.symbol)}
            style={{
              padding: '12px 20px',
              cursor: 'pointer',
              backgroundColor: isCurrent ? 'var(--bg-panel-hover)' : 'transparent',
              borderLeft: isCurrent ? '4px solid var(--accent-blue)' : '4px solid transparent',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              transition: 'var(--transition-smooth)',
              position: 'relative',
              boxShadow: isCurrent ? 'inset 0 0 10px rgba(59, 130, 246, 0.05)' : 'none',
              marginBottom: '2px',
            }}
            className="watchlist-item"
            onMouseEnter={(e) => {
              if (!isCurrent) {
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
              }
              const removeBtn = e.currentTarget.querySelector('.remove-btn') as HTMLElement;
              if (removeBtn) removeBtn.style.opacity = '0.7';
            }}
            onMouseLeave={(e) => {
              if (!isCurrent) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
              const removeBtn = e.currentTarget.querySelector('.remove-btn') as HTMLElement;
              if (removeBtn) removeBtn.style.opacity = '0';
            }}
          >
            <div>
              <div style={{ 
                fontWeight: '700', 
                color: isCurrent ? 'var(--text-primary)' : 'rgba(243, 244, 246, 0.85)',
                fontSize: '0.9rem',
                letterSpacing: '0.5px'
              }}>{asset.symbol}</div>
            </div>
            <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div>
                <div style={{ 
                  color: 'var(--text-primary)', 
                  fontWeight: '600', 
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.85rem'
                }}>
                  {asset.price !== '...' && !asset.price.includes(',') && parseFloat(asset.price) < 10 ? `$${asset.price}` : asset.price}
                </div>
                <div style={{ 
                  fontSize: '0.75rem', 
                  fontFamily: 'var(--font-mono)',
                  fontWeight: '500',
                  color: changeIsPositive ? 'var(--accent-green)' : (changeIsNegative ? 'var(--accent-red)' : 'var(--text-muted)'),
                  marginTop: '2px'
                }}>
                  {asset.change}
                </div>
              </div>
              <button
                className="remove-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveAsset(asset.symbol);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-red)',
                  cursor: 'pointer',
                  opacity: 0,
                  transition: 'opacity 0.2s, transform 0.2s',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'scale(1.2)';
                  e.currentTarget.style.color = '#fff';
                  e.currentTarget.style.backgroundColor = 'var(--accent-red)';
                  e.currentTarget.style.borderRadius = '50%';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                  e.currentTarget.style.color = 'var(--accent-red)';
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                title="Remove from Watchlist"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
