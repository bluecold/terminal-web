import { useState, useEffect, useRef } from 'react';
import { fetchKlines } from '../services/api';
import { X } from 'lucide-react';

interface WatchlistProps {
  symbols: string[];
  onSelectAsset: (asset: string) => void;
  onRemoveAsset: (asset: string) => void;
  currentAsset: string;
}

interface AssetData {
  symbol: string;
  name: string;
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
      const updatedAssets: AssetData[] = sortedSymbols.map(sym => {
        // Maintain existing data if we have it to prevent flickering
        const existing = assetsRef.current.find(a => a.symbol === sym);
        return existing || { symbol: sym, name: sym, price: '...', change: '...' };
      });

      // Quick update to show new symbols immediately
      if (isMounted) setAssets([...updatedAssets]);

      const fetchPromises = updatedAssets.map(async (asset, idx) => {
        try {
          const klines = await fetchKlines(asset.symbol, '1d');
          if (klines.length >= 2) {
            const latest = klines[klines.length - 1];
            const prev = klines[klines.length - 2];
            const currentPrice = latest.close;
            const changePercent = ((currentPrice - prev.close) / prev.close) * 100;
            
            updatedAssets[idx] = {
              ...asset,
              price: currentPrice >= 1000 ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : currentPrice.toFixed(2),
              change: `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`
            };
            if (isMounted) setAssets([...updatedAssets]);
          }
        } catch (e) {
          console.error('Error fetching watchlist data for', asset.symbol, e);
        }
      });

      await Promise.all(fetchPromises);
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 60000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [symbols]); // Run when symbols array changes

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
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{asset.name}</div>
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
