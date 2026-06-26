import { useState, useEffect } from 'react';
import './App.css';
import { Search } from 'lucide-react';
import Chart from './components/Chart';
import Watchlist from './components/Watchlist';
import SignalPanel from './components/SignalPanel';
import { fetchKlines } from './services/api';
import type { Kline } from './services/api';

function App() {
  const [currentAsset, setCurrentAsset] = useState(() => {
    return localStorage.getItem('terminal_current_asset') || 'BTCUSDT';
  });
  const [interval, setTimeInterval] = useState(() => {
    return localStorage.getItem('terminal_time_interval') || '1h';
  });
  const [showBB, setShowBB] = useState(() => {
    return localStorage.getItem('terminal_show_bb') === 'true';
  });
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>(() => {
    const saved = localStorage.getItem('terminal_watchlist');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.sort((a, b) => a.localeCompare(b));
        }
      } catch (e) {
        console.error('Error parsing watchlist from local storage', e);
      }
    }
    return ['BTCUSDT', 'ETHUSDT', 'TSLA', 'MSFT', 'HUT', 'SATL'].sort((a, b) => a.localeCompare(b));
  });
  const [klines, setKlines] = useState<Kline[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      setLoading(true);
      const data = await fetchKlines(currentAsset, interval);
      if (isMounted) {
        setKlines(data);
        setLoading(false);
      }
    };
    loadData();

    const pollInterval = setInterval(async () => {
      try {
        const data = await fetchKlines(currentAsset, interval);
        if (isMounted) setKlines(data);
      } catch (e) {
        console.error('Error auto-updating chart data', e);
      }
    }, 60000);

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  }, [currentAsset, interval]);

  useEffect(() => {
    localStorage.setItem('terminal_watchlist', JSON.stringify(watchlistSymbols));
  }, [watchlistSymbols]);

  useEffect(() => {
    localStorage.setItem('terminal_current_asset', currentAsset);
  }, [currentAsset]);

  useEffect(() => {
    localStorage.setItem('terminal_time_interval', interval);
  }, [interval]);

  useEffect(() => {
    localStorage.setItem('terminal_show_bb', showBB ? 'true' : 'false');
  }, [showBB]);

  const latestClose = klines.length > 0 ? klines[klines.length - 1].close : 0;
  const latestVolume = klines.length > 0 ? (klines.slice().reverse().find(k => k.volume > 0)?.volume || 0) : 0;
  const closes = klines.map(k => k.close);

  const isCurrentInWatchlist = watchlistSymbols.includes(currentAsset);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="logo">TERMINAL LITE</div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '8px' }} />
            <input 
              type="text" 
              className="asset-search" 
              placeholder="Search ticker..." 
              value={currentAsset}
              onChange={(e) => setCurrentAsset(e.target.value.toUpperCase())}
              style={{ paddingLeft: '28px' }}
            />
            <button 
              onClick={() => {
                if (isCurrentInWatchlist) {
                  setWatchlistSymbols(prev => prev.filter(s => s !== currentAsset));
                } else {
                  setWatchlistSymbols(prev => [...prev, currentAsset].sort((a, b) => a.localeCompare(b)));
                }
              }}
              style={{ 
                marginLeft: '8px', 
                background: 'transparent', 
                border: `1px solid ${isCurrentInWatchlist ? 'var(--border-color)' : 'var(--accent-blue)'}`, 
                color: isCurrentInWatchlist ? 'var(--text-secondary)' : 'var(--accent-blue)',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                fontWeight: 'bold',
                transition: 'all 0.2s',
              }}
              title={isCurrentInWatchlist ? "Remove from Watchlist" : "Add to Watchlist"}
            >
              {isCurrentInWatchlist ? 'REMOVE' : 'ADD'}
            </button>
          </div>
        </div>
        <div className="top-bar-right">
          <div className="status-indicator">
            <div className="dot"></div>
            <span>{loading ? 'FETCHING...' : 'CONNECTED (LIVE)'}</span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Left Sidebar - Watchlist */}
        <aside className="sidebar-left">
          <div className="panel-header">WATCHLIST</div>
          <Watchlist 
            symbols={watchlistSymbols}
            onSelectAsset={setCurrentAsset} 
            currentAsset={currentAsset} 
            onRemoveAsset={(sym) => setWatchlistSymbols(prev => prev.filter(s => s !== sym))}
          />
        </aside>

        {/* Center - Chart & Indicators */}
        <main className="chart-area">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              {currentAsset} - <span style={{ color: 'var(--text-secondary)' }}>{interval.toUpperCase()} CHART</span>
              {latestClose > 0 && <span style={{ marginLeft: '16px', color: 'var(--accent-blue)' }}>${latestClose.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button 
                onClick={() => setShowBB(prev => !prev)}
                style={{
                  backgroundColor: showBB ? 'var(--accent-blue)' : 'var(--bg-panel)',
                  color: showBB ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: showBB ? 'bold' : 'normal',
                  marginRight: '8px',
                  transition: 'all 0.2s',
                }}
                title="Mostrar/Ocultar Bandas de Bollinger"
              >
                BB
              </button>
              <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-color)', marginRight: '8px' }}></div>
              {['1d', '1h', '5m'].map(t => (
                <button 
                  key={t}
                  onClick={() => setTimeInterval(t)}
                  style={{
                    backgroundColor: interval === t ? 'var(--accent-blue)' : 'var(--bg-panel)',
                    color: interval === t ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: interval === t ? 'bold' : 'normal',
                  }}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-container">
            {klines.length > 0 && <Chart data={klines} showBB={showBB} symbol={currentAsset} interval={interval} />}
          </div>
        </main>

        {/* Right Sidebar - Signals & News */}
        <aside className="sidebar-right">
          <div className="panel-header">AI SIGNAL & INDICATORS</div>
          <SignalPanel symbol={currentAsset} closes={closes} volume={latestVolume} klines={klines} interval={interval} />
        </aside>
      </div>
    </div>
  );
}

export default App;
