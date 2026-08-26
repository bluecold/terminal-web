import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, RefreshCw, ArrowUpDown, ChevronUp, ChevronDown, Eye, AlertTriangle, ShieldCheck, Zap } from 'lucide-react';
import { fetchKlines } from '../services/api';
import {
  calculateStandardVoting,
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateBollingerBandsSeries,
  calculateBollingerVolatilityStatus,
} from '../utils/indicators';
import {
  backtestStandard,
  backtestConfluencia,
  backtestScoring,
  backtestMultitemporal,
  backtestMultifractalMTF,
  getTrendFilter
} from '../utils/backtester';
import { formatSmartPrice } from '../utils/formatters';
import { evaluateStrategyTournament, type StrategyCandidate, type ConfidenceLevel } from '../utils/tournament';

export interface RadarRowData {
  symbol: string;
  name: string;
  isCrypto: boolean;
  price: number;
  changePercent: number;
  signal5m: string;
  signal1h: string;
  signal1d: string;
  overallSignal: string;
  isFullConfluence: boolean;
  confluenceType: 'BUY_3' | 'SELL_3' | 'PARTIAL' | 'NEUTRAL';
  confluenceScore: number;
  qveStrategy: string;
  qveProfitFactor: number;
  qveConfidence: ConfidenceLevel;
  rvol: number;
  volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL';
  bbWidthPercent: number;
  loading: boolean;
  isOffline?: boolean;
  offlineReason?: string;
}

export type RadarFilter = 'all' | 'confluence' | 'squeeze' | 'rvol' | 'active';
export type SortColumn = 'symbol' | 'price' | 'changePercent' | 'qveProfitFactor' | 'rvol' | 'bbWidthPercent' | 'confluenceScore';

interface MarketRadarProps {
  watchlistSymbols: string[];
  currentAsset: string;
  onSelectAsset: (symbol: string) => void;
  onNavigateToChart: (symbol: string) => void;
  activeSignals?: Record<string, string>;
  executionStyle?: 'dayTrading' | 'swing';
  triggerMode?: 'agresivo' | 'conservador';
}

const PRESET_POOLS: Record<string, string[]> = {
  crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'NEARUSDT', 'SUIUSDT', 'LINKUSDT'],
  tech: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD'],
  growth: ['PLTR', 'COIN', 'MSTR', 'MARA', 'ARM', 'SMCI', 'HUT', 'SATL'],
  macro: ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'USO', 'TLT'],
};

export default function MarketRadar({
  watchlistSymbols,
  currentAsset: _currentAsset,
  onSelectAsset,
  onNavigateToChart,
  activeSignals = {},
  executionStyle = 'dayTrading',
  triggerMode = 'agresivo',
}: MarketRadarProps) {
  const [activePreset, setActivePreset] = useState<'watchlist' | 'crypto' | 'tech' | 'growth' | 'macro'>('watchlist');
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<SortColumn>('changePercent');
  const [sortAsc, setSortAsc] = useState(false);
  const [radarData, setRadarData] = useState<Record<string, RadarRowData>>({});
  const [isScanning, setIsScanning] = useState(false);
  const isMountedRef = useRef(true);

  // Circuit breaker: track consecutive errors per symbol to avoid repeated failing requests (10 min backoff)
  const failureMapRef = useRef<Map<string, { count: number; lastFailed: number }>>(new Map());

  // Smart calculation cache: avoid recalculating 55 backtests if candles & profile haven't changed
  const calcCacheRef = useRef<Map<string, { hash: string; data: RadarRowData }>>(new Map());

  const symbolsToScan = useMemo(() => {
    if (activePreset === 'watchlist') {
      return watchlistSymbols.length > 0 ? watchlistSymbols : ['BTCUSDT', 'ETHUSDT', 'TSLA', 'MSFT'];
    }
    return PRESET_POOLS[activePreset] || [];
  }, [activePreset, watchlistSymbols]);

  // Scan single symbol multitemporal data
  const scanSymbol = async (symbol: string, forceFresh: boolean = false): Promise<RadarRowData> => {
    const isCrypto = symbol.endsWith('USDT') || symbol.endsWith('BTC');

    // 1. Circuit breaker check
    const failInfo = failureMapRef.current.get(symbol);
    if (!forceFresh && failInfo && failInfo.count >= 2 && Date.now() - failInfo.lastFailed < 10 * 60 * 1000) {
      return {
        symbol,
        name: symbol,
        isCrypto,
        price: 0,
        changePercent: 0,
        signal5m: 'OFFLINE',
        signal1h: 'OFFLINE',
        signal1d: 'OFFLINE',
        overallSignal: 'NEUTRAL',
        isFullConfluence: false,
        confluenceType: 'NEUTRAL',
        confluenceScore: 0,
        qveStrategy: 'Standard',
        qveProfitFactor: 1.0,
        qveConfidence: 'NONE',
        rvol: 1.0,
        volatilityStatus: 'NORMAL',
        bbWidthPercent: 0,
        loading: false,
        isOffline: true,
        offlineReason: 'Pausado por fallos continuos de API (10 min backoff)',
      };
    }

    try {
      const [k5m, k1h, k1d] = await Promise.all([
        fetchKlines(symbol, '5m'),
        fetchKlines(symbol, '1h'),
        fetchKlines(symbol, '1d'),
      ]);

      if (k5m.length === 0 && k1h.length === 0 && k1d.length === 0) {
        const prevCount = failureMapRef.current.get(symbol)?.count || 0;
        failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: Date.now() });

        return {
          symbol,
          name: symbol,
          isCrypto,
          price: 0,
          changePercent: 0,
          signal5m: 'SIN DATOS',
          signal1h: 'SIN DATOS',
          signal1d: 'SIN DATOS',
          overallSignal: 'NEUTRAL',
          isFullConfluence: false,
          confluenceType: 'NEUTRAL',
          confluenceScore: 0,
          qveStrategy: 'Standard',
          qveProfitFactor: 1.0,
          qveConfidence: 'NONE',
          rvol: 1.0,
          volatilityStatus: 'NORMAL',
          bbWidthPercent: 0,
          loading: false,
          isOffline: true,
          offlineReason: 'Sin datos disponibles para este ticker',
        };
      }

      // Success: reset failure count
      failureMapRef.current.delete(symbol);

      // Latest price & daily change
      let price = 0;
      let changePercent = 0;
      if (k1d.length >= 2) {
        const latest = k1d[k1d.length - 1];
        const prev = k1d[k1d.length - 2];
        price = latest.close;
        changePercent = prev.close > 0 ? ((price - prev.close) / prev.close) * 100 : 0;
      } else if (k5m.length > 0) {
        price = k5m[k5m.length - 1].close;
      }

      const closed5m = k5m.length > 1 ? k5m.slice(0, -1) : k5m;
      const closed1h = k1h.length > 1 ? k1h.slice(0, -1) : k1h;
      const closed1d = k1d.length > 1 ? k1d.slice(0, -1) : k1d;

      // Smart cache check by candle timestamps and user profile
      const last5mTime = closed5m.length > 0 ? closed5m[closed5m.length - 1].time : 0;
      const last1hTime = closed1h.length > 0 ? closed1h[closed1h.length - 1].time : 0;
      const last1dTime = closed1d.length > 0 ? closed1d[closed1d.length - 1].time : 0;
      const cacheHash = `${symbol}_${last5mTime}_${last1hTime}_${last1dTime}_${executionStyle}_${triggerMode}`;

      if (!forceFresh) {
        const cached = calcCacheRef.current.get(symbol);
        if (cached && cached.hash === cacheHash) {
          return {
            ...cached.data,
            price,
            changePercent,
            loading: false,
          };
        }
      }

      // ── 1. Multitemporal Signals & Weighted Confluence ────────
      const voting5m = closed5m.length >= 35 ? calculateStandardVoting(closed5m) : null;
      const voting1h = closed1h.length >= 35 ? calculateStandardVoting(closed1h) : null;
      const voting1d = closed1d.length >= 30 ? calculateStandardVoting(closed1d) : null;

      const sig5m = voting5m ? voting5m.rawSignal : 'NEUTRAL';
      const sig1h = voting1h ? voting1h.rawSignal : 'NEUTRAL';
      const sig1d = voting1d ? voting1d.rawSignal : 'NEUTRAL';

      const isBuy5m = sig5m.includes('BUY');
      const isBuy1h = sig1h.includes('BUY');
      const isBuy1d = sig1d.includes('BUY');

      const isSell5m = sig5m.includes('SELL');
      const isSell1h = sig1h.includes('SELL');
      const isSell1d = sig1d.includes('SELL');

      // Helper to assign signal score (-1.0 to +1.0)
      const getSigScore = (sig: string) => {
        if (sig === 'STRONG BUY') return 1.0;
        if (sig === 'BUY') return 0.6;
        if (sig === 'STRONG SELL') return -1.0;
        if (sig === 'SELL') return -0.6;
        return 0;
      };

      const score5m = getSigScore(sig5m);
      const score1h = getSigScore(sig1h);
      const score1d = getSigScore(sig1d);

      // Weighted multitemporal score (1D: 45%, 1H: 35%, 5m: 20%)
      const weightedScore = (score1d * 0.45) + (score1h * 0.35) + (score5m * 0.20);
      const confluenceScore = Math.round(Math.abs(weightedScore) * 100);

      let isFullConfluence = false;
      let confluenceType: 'BUY_3' | 'SELL_3' | 'PARTIAL' | 'NEUTRAL' = 'NEUTRAL';

      if ((isBuy5m && isBuy1h && isBuy1d) || weightedScore >= 0.70) {
        isFullConfluence = true;
        confluenceType = 'BUY_3';
      } else if ((isSell5m && isSell1h && isSell1d) || weightedScore <= -0.70) {
        isFullConfluence = true;
        confluenceType = 'SELL_3';
      } else if ((isBuy5m && isBuy1h) || (isSell5m && isSell1h) || Math.abs(weightedScore) >= 0.40) {
        confluenceType = 'PARTIAL';
      }

      // ── 2. QVE Tournament & Overall Signal (Synced with Profile) ──
      const triggerKlines = executionStyle === 'swing' ? closed1h : closed5m;

      const btStd = closed5m.length > 20 ? backtestStandard(closed5m, '5m', symbol) : null;
      const btConf = closed5m.length > 20 ? backtestConfluencia(closed5m, '5m', symbol) : null;
      const btScore = closed5m.length > 20 ? backtestScoring(closed5m, '5m', undefined, symbol) : null;
      const btMulti = triggerKlines.length >= 30 && closed1h.length >= 60 && closed1d.length >= 30
        ? backtestMultitemporal(triggerKlines, closed1h, closed1d, '5m', symbol, executionStyle, triggerMode)
        : null;
      const btMF = closed5m.length >= 30 ? backtestMultifractalMTF(closed5m, closed1h, closed1d, '5m', symbol) : null;

      const candidates: StrategyCandidate[] = [
        { key: 'standard', label: 'Estándar', profitFactor: btStd ? btStd.profitFactor : 1.0, expectancy: btStd ? btStd.expectancy : 0, winRate: btStd ? btStd.winRate : 0.5, resolved: btStd ? (btStd.totalSignals > 0 ? btStd.totalSignals : btStd.wins + btStd.losses) : 0, forwardWindow: 6 },
        { key: 'confluencia', label: 'Confluencia', profitFactor: btConf ? btConf.profitFactor : 1.0, expectancy: btConf ? btConf.expectancy : 0, winRate: btConf ? btConf.winRate : 0.5, resolved: btConf ? (btConf.totalSignals > 0 ? btConf.totalSignals : btConf.wins + btConf.losses) : 0, forwardWindow: 6 },
        { key: 'scoring', label: 'Scoring', profitFactor: btScore ? btScore.profitFactor : 1.0, expectancy: btScore ? btScore.expectancy : 0, winRate: btScore ? btScore.winRate : 0.5, resolved: btScore ? (btScore.totalSignals > 0 ? btScore.totalSignals : btScore.wins + btScore.losses) : 0, forwardWindow: 6 },
        { key: 'multitemporal', label: 'VCME Sniper', profitFactor: btMulti ? btMulti.profitFactor : 1.0, expectancy: btMulti ? btMulti.expectancy : 0, winRate: btMulti ? btMulti.winRate : 0.5, resolved: btMulti ? (btMulti.totalSignals > 0 ? btMulti.totalSignals : btMulti.wins + btMulti.losses) : 0, forwardWindow: executionStyle === 'swing' ? 48 : 72 },
        { key: 'multifractal', label: 'Multifractal MTF', profitFactor: btMF ? btMF.profitFactor : 1.0, expectancy: btMF ? btMF.expectancy : 0, winRate: btMF ? btMF.winRate : 0.5, resolved: btMF ? (btMF.totalSignals > 0 ? btMF.totalSignals : btMF.wins + btMF.losses) : 0, forwardWindow: 12 },
      ];

      const tourney = evaluateStrategyTournament(candidates, '5m');
      let overallSig = 'NEUTRAL';

      if (tourney.bestStrategy === 'confluencia') {
        overallSig = calculateExperimentalSignal(closed5m, '5m').signal;
      } else if (tourney.bestStrategy === 'scoring') {
        overallSig = calculateScoringSignal(closed5m, '5m').signal;
      } else if (tourney.bestStrategy === 'multitemporal' && btMulti) {
        overallSig = calculateVCMESniperSignal(triggerKlines, closed1h, closed1d, symbol, btMulti.winRate, btMulti.profitFactor, executionStyle, triggerMode).signal;
      } else if (tourney.bestStrategy === 'multifractal') {
        overallSig = calculateMultifractalMTFSignal(closed5m, closed1h, closed1d, symbol).signal;
      } else {
        overallSig = sig5m;
      }

      if (tourney.bestStrategy !== 'multitemporal' && tourney.bestStrategy !== 'multifractal') {
        const closes5m = closed5m.map(k => k.close);
        const trend = getTrendFilter(closes5m);
        if (trend === 'UP' && (overallSig === 'SELL' || overallSig === 'STRONG SELL')) {
          overallSig = 'NEUTRAL';
        } else if (trend === 'DOWN' && (overallSig === 'BUY' || overallSig === 'STRONG BUY')) {
          overallSig = 'NEUTRAL';
        }
      }

      // ── 3. RVOL (Rolling 20-bar Volume SMA excluding trigger candle) & Bollinger Volatility ──
      let rvol = 1.0;
      if (closed5m.length >= 21) {
        const lastVol = closed5m[closed5m.length - 1].volume;
        const vol20 = closed5m.slice(-21, -1).map(k => k.volume);
        const volAvg = vol20.reduce((a, b) => a + b, 0) / 20;
        if (volAvg > 0) {
          rvol = Number((lastVol / volAvg).toFixed(2));
        }
      }

      let volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL' = 'NORMAL';
      let bbWidthPercent = 0;

      if (closed5m.length >= 20) {
        const bbSeries = calculateBollingerBandsSeries(closed5m, 20, 2);
        if (bbSeries.length > 0) {
          const volStatus = calculateBollingerVolatilityStatus(bbSeries, 50);
          volatilityStatus = volStatus.status;
          bbWidthPercent = volStatus.widthPercent;
        }
      }

      const rowResult: RadarRowData = {
        symbol,
        name: symbol,
        isCrypto,
        price,
        changePercent,
        signal5m: sig5m,
        signal1h: sig1h,
        signal1d: sig1d,
        overallSignal: overallSig,
        isFullConfluence,
        confluenceType,
        confluenceScore,
        qveStrategy: tourney.strategyLabel,
        qveProfitFactor: tourney.profitFactor,
        qveConfidence: tourney.confidence,
        rvol,
        volatilityStatus,
        bbWidthPercent,
        loading: false,
        isOffline: false,
      };

      calcCacheRef.current.set(symbol, { hash: cacheHash, data: rowResult });
      return rowResult;
    } catch (e) {
      console.error(`Error scanning radar for ${symbol}`, e);
      const prevCount = failureMapRef.current.get(symbol)?.count || 0;
      failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: Date.now() });

      return {
        symbol,
        name: symbol,
        isCrypto,
        price: 0,
        changePercent: 0,
        signal5m: 'ERROR',
        signal1h: 'ERROR',
        signal1d: 'ERROR',
        overallSignal: 'NEUTRAL',
        isFullConfluence: false,
        confluenceType: 'NEUTRAL',
        confluenceScore: 0,
        qveStrategy: 'Standard',
        qveProfitFactor: 1.0,
        qveConfidence: 'NONE',
        rvol: 1.0,
        volatilityStatus: 'NORMAL',
        bbWidthPercent: 0,
        loading: false,
        isOffline: true,
        offlineReason: 'Error al consultar datos de mercado',
      };
    }
  };

  // Run batch scan with concurrency limit and micro-pauses
  const runFullScan = async () => {
    if (isScanning) return;
    setIsScanning(true);

    // Initial placeholder state for missing symbols
    setRadarData(prev => {
      const next = { ...prev };
      symbolsToScan.forEach(sym => {
        if (!next[sym]) {
          next[sym] = {
            symbol: sym,
            name: sym,
            isCrypto: sym.endsWith('USDT') || sym.endsWith('BTC'),
            price: 0,
            changePercent: 0,
            signal5m: '...',
            signal1h: '...',
            signal1d: '...',
            overallSignal: '...',
            isFullConfluence: false,
            confluenceType: 'NEUTRAL',
            confluenceScore: 0,
            qveStrategy: '...',
            qveProfitFactor: 0,
            qveConfidence: 'NONE',
            rvol: 1.0,
            volatilityStatus: 'NORMAL',
            bbWidthPercent: 0,
            loading: true,
          };
        } else {
          next[sym] = { ...next[sym], loading: true };
        }
      });
      return next;
    });

    const batchSize = 3;
    for (let i = 0; i < symbolsToScan.length; i += batchSize) {
      if (!isMountedRef.current) break;
      const batch = symbolsToScan.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(sym => scanSymbol(sym)));
      if (isMountedRef.current) {
        setRadarData(prev => {
          const next = { ...prev };
          results.forEach(res => {
            next[res.symbol] = res;
          });
          return next;
        });
      }
      // Micro-pause (yield to event loop) to ensure 60 FPS UI responsiveness
      if (i + batchSize < symbolsToScan.length) {
        await new Promise(resolve => setTimeout(resolve, 35));
      }
    }

    if (isMountedRef.current) {
      setIsScanning(false);
    }
  };

  // Manual retry for a single symbol
  const handleRetrySymbol = async (e: React.MouseEvent, sym: string) => {
    e.stopPropagation();
    failureMapRef.current.delete(sym);
    calcCacheRef.current.delete(sym);
    setRadarData(prev => ({
      ...prev,
      [sym]: { ...(prev[sym] || { symbol: sym }), loading: true } as RadarRowData
    }));
    const res = await scanSymbol(sym, true);
    if (isMountedRef.current) {
      setRadarData(prev => ({ ...prev, [sym]: res }));
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data fetch on preset or profile change */
    runFullScan();
    const timer = setInterval(runFullScan, 60000);
    return () => {
      isMountedRef.current = false;
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsToScan, executionStyle, triggerMode]);

  // Filter & Sort table items
  const processedRows = useMemo(() => {
    const all = symbolsToScan.map(sym => radarData[sym] || {
      symbol: sym,
      name: sym,
      isCrypto: sym.endsWith('USDT') || sym.endsWith('BTC'),
      price: 0,
      changePercent: 0,
      signal5m: '...',
      signal1h: '...',
      signal1d: '...',
      overallSignal: '...',
      isFullConfluence: false,
      confluenceType: 'NEUTRAL' as const,
      confluenceScore: 0,
      qveStrategy: '...',
      qveProfitFactor: 0,
      qveConfidence: 'NONE' as ConfidenceLevel,
      rvol: 1.0,
      volatilityStatus: 'NORMAL' as const,
      bbWidthPercent: 0,
      loading: true,
    });

    // 1. Text Search
    let filtered = all;
    if (searchQuery.trim()) {
      const q = searchQuery.toUpperCase().trim();
      filtered = filtered.filter(r => r.symbol.toUpperCase().includes(q));
    }

    // 2. Quick Filter
    if (activeFilter === 'confluence') {
      filtered = filtered.filter(r => r.isFullConfluence);
    } else if (activeFilter === 'squeeze') {
      filtered = filtered.filter(r => r.volatilityStatus === 'SQUEEZE');
    } else if (activeFilter === 'rvol') {
      filtered = filtered.filter(r => r.rvol >= 1.5);
    } else if (activeFilter === 'active') {
      filtered = filtered.filter(r => r.overallSignal.includes('BUY') || r.overallSignal.includes('SELL') || Boolean(activeSignals[r.symbol]));
    }

    // 3. Sorting
    return [...filtered].sort((a, b) => {
      const valA: string | number = a[sortCol] ?? 0;
      const valB: string | number = b[sortCol] ?? 0;

      if (typeof valA === 'string') {
        return sortAsc ? valA.localeCompare(valB as string) : (valB as string).localeCompare(valA);
      }
      return sortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [symbolsToScan, radarData, searchQuery, activeFilter, sortCol, sortAsc, activeSignals]);

  const handleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortAsc(prev => !prev);
    } else {
      setSortCol(col);
      setSortAsc(false);
    }
  };

  const formatP = (val: number) => {
    if (!val) return '—';
    return formatSmartPrice(val);
  };

  return (
    <div className="radar-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '16px', gap: '14px', boxSizing: 'border-box', overflowY: 'auto' }}>
      
      {/* ── Top Header Controls & Preset Selector ─────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        
        {/* Preset Selector */}
        <div style={{ display: 'flex', gap: '6px', background: 'rgba(0, 0, 0, 0.3)', padding: '4px', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          {[
            { id: 'watchlist', label: 'Mi Watchlist', icon: '⭐' },
            { id: 'crypto', label: 'Top Cripto Volátiles', icon: '🪙' },
            { id: 'tech', label: 'Mega Tech', icon: '💻' },
            { id: 'growth', label: 'Growth & High Beta', icon: '🚀' },
            { id: 'macro', label: 'Índices & Futuros', icon: '🏛️' },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => setActivePreset(p.id as 'watchlist' | 'crypto' | 'tech' | 'growth' | 'macro')}
              style={{
                background: activePreset === p.id ? 'var(--accent-blue)' : 'transparent',
                color: activePreset === p.id ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '0.75rem',
                fontWeight: activePreset === p.id ? '700' : '500',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>{p.icon}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </div>

        {/* Profile Badge & Refresh Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Active Profile Sync Indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '0.68rem',
            color: 'var(--accent-blue)',
            fontWeight: '600'
          }}>
            <Zap size={12} />
            <span>Perfil: {executionStyle === 'swing' ? 'Swing (1H)' : 'Intradía (5m)'} · {triggerMode === 'conservador' ? 'Conservador' : 'Agresivo'}</span>
          </div>

          <button
            onClick={runFullScan}
            disabled={isScanning}
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-color)',
              color: isScanning ? 'var(--accent-blue)' : 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '0.72rem',
              fontWeight: '600',
              cursor: isScanning ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s',
            }}
            title="Escanear nuevamente todos los activos del universo"
          >
            <RefreshCw size={13} className={isScanning ? 'radar-spin' : ''} />
            <span>{isScanning ? 'ESCANEANDO...' : 'ACTUALIZAR RADAR'}</span>
          </button>
        </div>
      </div>

      {/* ── Search & Filter Chips ─────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        
        {/* Filter Chips */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {[
            { id: 'all', label: 'Todos' },
            { id: 'confluence', label: '🔥 Confluencia MTF' },
            { id: 'squeeze', label: '🟡 Squeeze Adaptativo' },
            { id: 'rvol', label: '📈 Alto RVOL (ToD ≥1.5x)' },
            { id: 'active', label: '🎯 Señales Activas' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setActiveFilter(f.id as RadarFilter)}
              style={{
                background: activeFilter === f.id ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${activeFilter === f.id ? 'var(--accent-blue)' : 'var(--border-color)'}`,
                color: activeFilter === f.id ? 'var(--accent-blue)' : 'var(--text-secondary)',
                padding: '4px 10px',
                borderRadius: '16px',
                fontSize: '0.68rem',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={14} color="var(--text-secondary)" style={{ position: 'absolute', left: '10px' }} />
          <input
            type="text"
            placeholder="Filtrar por ticker..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid var(--border-color)',
              color: '#fff',
              padding: '6px 10px 6px 30px',
              borderRadius: '6px',
              fontSize: '0.72rem',
              outline: 'none',
              fontFamily: 'var(--font-mono)',
              width: '160px',
            }}
          />
        </div>
      </div>

      {/* ── Quantitative Screener Table ────────────────────────── */}
      <div style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius-md)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: '400px',
      }}>
        <div style={{ overflowX: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.72rem' }}>
            <thead>
              <tr style={{ background: 'rgba(0, 0, 0, 0.25)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('symbol')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>ACTIVO</span>
                    {sortCol === 'symbol' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('price')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>PRECIO</span>
                    {sortCol === 'price' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('changePercent')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>VAR. 24H</span>
                    {sortCol === 'changePercent' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('confluenceScore')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>CONFLUENCIA MTF (5m · 1h · 1d)</span>
                    {sortCol === 'confluenceScore' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('qveProfitFactor')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>ESTRATEGIA LÍDER QVE</span>
                    {sortCol === 'qveProfitFactor' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('rvol')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>RVOL (ToD)</span>
                    {sortCol === 'rvol' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('bbWidthPercent')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>VOLATILIDAD (BB)</span>
                    {sortCol === 'bbWidthPercent' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', textAlign: 'right' }}>ACCIONES</th>
              </tr>
            </thead>
            <tbody>
              {processedRows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No se encontraron activos que coincidan con los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                processedRows.map(row => {
                  const isPositive = row.changePercent >= 0;
                  const isBuy = row.overallSignal.includes('BUY');
                  const isSell = row.overallSignal.includes('SELL');
                  const activeSig = activeSignals[row.symbol];

                  return (
                    <tr
                      key={row.symbol}
                      style={{
                        borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                        transition: 'background-color 0.15s ease',
                        cursor: row.isOffline ? 'default' : 'pointer',
                        opacity: row.isOffline ? 0.7 : 1,
                      }}
                      className="radar-row"
                      onClick={() => {
                        if (!row.isOffline) {
                          onSelectAsset(row.symbol);
                          onNavigateToChart(row.symbol);
                        }
                      }}
                    >
                      {/* 1. Symbol & Market Tag */}
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: '800', color: '#fff', fontSize: '0.82rem' }}>
                            {row.symbol}
                          </span>
                          <span style={{
                            fontSize: '0.55rem',
                            fontWeight: '700',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            background: row.isCrypto ? 'rgba(234, 179, 8, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                            color: row.isCrypto ? '#eab308' : 'var(--accent-blue)',
                            border: `1px solid ${row.isCrypto ? 'rgba(234, 179, 8, 0.25)' : 'rgba(59, 130, 246, 0.25)'}`,
                          }}>
                            {row.isCrypto ? 'CRIPTO' : 'STOCK'}
                          </span>
                          {row.isOffline && (
                            <span
                              title={row.offlineReason || 'Sin conexión o datos'}
                              style={{
                                fontSize: '0.52rem',
                                fontWeight: '700',
                                padding: '1px 4px',
                                borderRadius: '3px',
                                background: 'rgba(239, 68, 68, 0.15)',
                                color: 'var(--accent-red)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px',
                              }}
                            >
                              <AlertTriangle size={10} />
                              <span>OFFLINE</span>
                            </span>
                          )}
                          {activeSig && (
                            <span style={{
                              fontSize: '0.52rem',
                              fontWeight: '800',
                              padding: '1px 4px',
                              borderRadius: '3px',
                              background: activeSig.includes('BUY') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)',
                              color: activeSig.includes('BUY') ? 'var(--accent-green)' : 'var(--accent-red)',
                            }}>
                              {activeSig}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 2. Price */}
                      <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: '600', color: 'var(--text-primary)' }}>
                        {row.loading ? <span className="radar-skeleton">Cargando...</span> : row.isOffline ? '—' : formatP(row.price)}
                      </td>

                      {/* 3. 24h Change % */}
                      <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: '700' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">—</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <span style={{ color: isPositive ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                            {isPositive ? '+' : ''}{row.changePercent.toFixed(2)}%
                          </span>
                        )}
                      </td>

                      {/* 4. MTF Confluence Matrix */}
                      <td style={{ padding: '12px 14px' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">Evaluando confluencia...</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{row.offlineReason || 'Sin datos'}</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {/* 5m */}
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: '700',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: row.signal5m.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal5m.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                              color: row.signal5m.includes('BUY') ? 'var(--accent-green)' : row.signal5m.includes('SELL') ? 'var(--accent-red)' : 'var(--text-muted)',
                              border: '1px solid rgba(255, 255, 255, 0.05)',
                            }}>
                              5m: {row.signal5m.includes('BUY') ? 'BUY' : row.signal5m.includes('SELL') ? 'SELL' : '—'}
                            </span>

                            {/* 1h */}
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: '700',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: row.signal1h.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal1h.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                              color: row.signal1h.includes('BUY') ? 'var(--accent-green)' : row.signal1h.includes('SELL') ? 'var(--accent-red)' : 'var(--text-muted)',
                              border: '1px solid rgba(255, 255, 255, 0.05)',
                            }}>
                              1h: {row.signal1h.includes('BUY') ? 'BUY' : row.signal1h.includes('SELL') ? 'SELL' : '—'}
                            </span>

                            {/* 1d */}
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: '700',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: row.signal1d.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal1d.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                              color: row.signal1d.includes('BUY') ? 'var(--accent-green)' : row.signal1d.includes('SELL') ? 'var(--accent-red)' : 'var(--text-muted)',
                              border: '1px solid rgba(255, 255, 255, 0.05)',
                            }}>
                              1d: {row.signal1d.includes('BUY') ? 'BUY' : row.signal1d.includes('SELL') ? 'SELL' : '—'}
                            </span>

                            {row.isFullConfluence && (
                              <span style={{
                                fontSize: '0.58rem',
                                fontWeight: '800',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: row.confluenceType === 'BUY_3' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)',
                                color: row.confluenceType === 'BUY_3' ? 'var(--accent-green)' : 'var(--accent-red)',
                                border: `1px solid ${row.confluenceType === 'BUY_3' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)'}`,
                              }}>
                                🎯 3/3 ({row.confluenceScore}%)
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* 5. QVE Leader Strategy */}
                      <td style={{ padding: '12px 14px' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">—</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>
                              {row.qveStrategy}
                            </span>
                            <span style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.62rem',
                              color: row.qveProfitFactor >= 1.3 ? 'var(--accent-green)' : 'var(--text-secondary)',
                              fontWeight: '700',
                            }}>
                              PF {row.qveProfitFactor.toFixed(1)}
                            </span>
                            {row.qveConfidence === 'HIGH' && (
                              <span title="Alta Confianza (Muestra representativa)">
                                <ShieldCheck size={12} color="var(--accent-green)" />
                              </span>
                            )}
                            {row.qveConfidence === 'LIMITED' && <span title="Muestra Limitada">⚠️</span>}
                          </div>
                        )}
                      </td>

                      {/* 6. RVOL Volume Surge (Time-of-Day) */}
                      <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">—</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <span style={{
                            fontWeight: '700',
                            color: row.rvol >= 2.0 ? 'var(--accent-red)' : row.rvol >= 1.5 ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                          }}>
                            {row.rvol}x {row.rvol >= 2.0 ? '🔥' : row.rvol >= 1.5 ? '⚡' : ''}
                          </span>
                        )}
                      </td>

                      {/* 7. Volatility Status (BB Adaptive Percentile) */}
                      <td style={{ padding: '12px 14px' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">—</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <span style={{
                            fontSize: '0.6rem',
                            fontWeight: '700',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: row.volatilityStatus === 'SQUEEZE'
                              ? 'rgba(234, 179, 8, 0.15)'
                              : row.volatilityStatus === 'EXPANSION'
                                ? 'rgba(59, 130, 246, 0.15)'
                                : 'rgba(255, 255, 255, 0.03)',
                            color: row.volatilityStatus === 'SQUEEZE'
                              ? '#eab308'
                              : row.volatilityStatus === 'EXPANSION'
                                ? 'var(--accent-blue)'
                                : 'var(--text-muted)',
                            border: `1px solid ${row.volatilityStatus === 'SQUEEZE' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.06)'}`,
                          }}>
                            {row.volatilityStatus === 'SQUEEZE' ? '🟡 SQUEEZE' : row.volatilityStatus === 'EXPANSION' ? '⚡ EXPANSIÓN' : 'NORMAL'}
                          </span>
                        )}
                      </td>

                      {/* 8. Action Buttons */}
                      <td style={{ padding: '12px 14px', textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                          {row.isOffline ? (
                            <button
                              onClick={(e) => handleRetrySymbol(e, row.symbol)}
                              style={{
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid var(--border-color)',
                                color: 'var(--text-secondary)',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                fontSize: '0.62rem',
                                fontWeight: '700',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                transition: 'all 0.2s',
                              }}
                              title="Reintentar consultar este activo"
                            >
                              <RefreshCw size={10} />
                              <span>REINTENTAR</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                onSelectAsset(row.symbol);
                                onNavigateToChart(row.symbol);
                              }}
                              style={{
                                background: isBuy ? 'rgba(16, 185, 129, 0.12)' : isSell ? 'rgba(244, 63, 94, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                border: `1px solid ${isBuy ? 'rgba(16, 185, 129, 0.3)' : isSell ? 'rgba(244, 63, 94, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`,
                                color: isBuy ? 'var(--accent-green)' : isSell ? 'var(--accent-red)' : 'var(--accent-blue)',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                fontSize: '0.62rem',
                                fontWeight: '700',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                transition: 'all 0.2s',
                              }}
                              title="Abrir en Gráfico de TradingView"
                            >
                              <Eye size={11} />
                              <span>GRÁFICO</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
