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
    <div style={{ padding: '16px 0', overflowY: 'auto' }}>
      {assets.map((asset) => (
        <div 
          key={asset.symbol}
          onClick={() => onSelectAsset(asset.symbol)}
          style={{
            padding: '12px 16px',
            cursor: 'pointer',
            backgroundColor: currentAsset === asset.symbol ? 'var(--bg-panel-hover)' : 'transparent',
            borderLeft: currentAsset === asset.symbol ? '3px solid var(--accent-blue)' : '3px solid transparent',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            transition: 'background-color 0.2s',
            position: 'relative',
          }}
          className="watchlist-item"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg-panel-hover)';
            const removeBtn = e.currentTarget.querySelector('.remove-btn') as HTMLElement;
            if (removeBtn) removeBtn.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            if (currentAsset !== asset.symbol) {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
            const removeBtn = e.currentTarget.querySelector('.remove-btn') as HTMLElement;
            if (removeBtn) removeBtn.style.opacity = '0';
          }}
        >
          <div>
            <div style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{asset.symbol}</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{asset.name}</div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div>
              <div style={{ color: 'var(--text-primary)' }}>{asset.price !== '...' && !asset.price.includes(',') && parseFloat(asset.price) < 10 ? `$${asset.price}` : asset.price}</div>
              <div style={{ 
                fontSize: '0.8rem', 
                color: asset.change.startsWith('+') ? 'var(--accent-green)' : (asset.change.startsWith('-') ? 'var(--accent-red)' : 'var(--text-secondary)')
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
                transition: 'opacity 0.2s',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Remove from Watchlist"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
