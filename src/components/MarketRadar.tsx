import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, RefreshCw, ArrowUpDown, ChevronUp, ChevronDown, Eye, AlertTriangle, ShieldCheck, Zap } from 'lucide-react';
import { fetchKlines, type Kline } from '../services/api';
import {
  calculateStandardVoting,
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateBollingerBandsSeries,
  calculateBollingerVolatilityStatus,
  getConfirmedClosedKlines,
  calculateTimeOfDayRVOL,
  getEffectiveExecutionPrice,
  type ScoringWeights,
} from '../utils/indicators';
import { formatSmartPrice } from '../utils/formatters';
import { runQVESelection, type ConfidenceLevel } from '../utils/tournament';

// Clock helper to isolate Date.now() access from component render body
function getNowTimestamp(): number {
  return Date.now();
}

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
  confluenceType: 'BUY_3' | 'SELL_3' | 'BUY_2' | 'SELL_2' | 'PARTIAL' | 'NEUTRAL';
  confluenceScore: number;
  qveStrategy: string;
  qveProfitFactor: number | null;
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
  scoringWeights?: ScoringWeights;
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
  scoringWeights,
}: MarketRadarProps) {
  const [activePreset, setActivePreset] = useState<'watchlist' | 'crypto' | 'tech' | 'growth' | 'macro'>('watchlist');
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<SortColumn>('changePercent');
  const [sortAsc, setSortAsc] = useState(false);
  const [radarData, setRadarData] = useState<Record<string, RadarRowData>>({});
  const [isScanning, setIsScanning] = useState(false);
  const isScanningRef = useRef(false);
  const scanGenerationRef = useRef(0);
  const isMountedRef = useRef(true);

  // Circuit breaker: track consecutive errors per symbol to avoid repeated failing requests (10 min backoff)
  const failureMapRef = useRef<Map<string, { count: number; lastFailed: number }>>(new Map());

  // Smart calculation cache: cache heavy QVE tournament and multi-timeframe analytics, but always recalculate live signals with current price
  interface CachedRadarAnalytics {
    hash: string;
    sig5m: string;
    sig1h: string;
    sig1d: string;
    confluenceScore: number;
    isFullConfluence: boolean;
    confluenceType: 'BUY_3' | 'SELL_3' | 'BUY_2' | 'SELL_2' | 'PARTIAL' | 'NEUTRAL';
    qve: ReturnType<typeof runQVESelection>;
    rvol: number;
    volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL';
    bbWidthPercent: number;
  }
  const calcCacheRef = useRef<Map<string, CachedRadarAnalytics>>(new Map());

  const getKlinesFingerprint = (klines: Kline[]) => {
    if (!klines || klines.length === 0) return '0';
    const last = klines[klines.length - 1];
    return `${klines.length}_${last.time}_${last.close}_${last.high}_${last.low}_${last.volume}`;
  };

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
    if (!forceFresh && failInfo && failInfo.count >= 2 && getNowTimestamp() - failInfo.lastFailed < 10 * 60 * 1000) {
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
        failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: getNowTimestamp() });

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

      const closed5m = getConfirmedClosedKlines(k5m, '5m', symbol);
      const closed1h = getConfirmedClosedKlines(k1h, '1h', symbol);
      const closed1d = getConfirmedClosedKlines(k1d, '1d', symbol);

      // Smart cache check using robust OHLCV candle fingerprints, user profile, and scoring weights
      const fp5m = getKlinesFingerprint(closed5m);
      const fp1h = getKlinesFingerprint(closed1h);
      const fp1d = getKlinesFingerprint(closed1d);
      const wKey = scoringWeights ? `${scoringWeights.trend}_${scoringWeights.rsi}_${scoringWeights.bollinger}_${scoringWeights.volume}_${scoringWeights.candle}` : 'default';
      const cacheHash = `${symbol}_${fp5m}_${fp1h}_${fp1d}_${executionStyle}_${triggerMode}_${wKey}`;

      let analytics: CachedRadarAnalytics;
      const cached = !forceFresh ? calcCacheRef.current.get(symbol) : undefined;

      if (cached && cached.hash === cacheHash) {
        analytics = cached;
      } else {
        // ── 1. Multitemporal Signals & Weighted Confluence ────────
        const voting5m = closed5m.length >= 35 ? calculateStandardVoting(closed5m) : null;
        const voting1h = closed1h.length >= 35 ? calculateStandardVoting(closed1h) : null;
        const voting1d = closed1d.length >= 30 ? calculateStandardVoting(closed1d) : null;

        const sig5m = voting5m ? voting5m.signal : 'NEUTRAL';
        const sig1h = voting1h ? voting1h.signal : 'NEUTRAL';
        const sig1d = voting1d ? voting1d.signal : 'NEUTRAL';

        const isBuy5m = sig5m.includes('BUY');
        const isBuy1h = sig1h.includes('BUY');
        const isBuy1d = sig1d.includes('BUY');

        const isSell5m = sig5m.includes('SELL');
        const isSell1h = sig1h.includes('SELL');
        const isSell1d = sig1d.includes('SELL');

        // Helper to assign signal score (-1.0 to +1.0)
        const getSigScore = (voting: typeof voting5m) => {
          if (!voting || voting.signal === 'NEUTRAL') return 0;
          const isBuy = voting.signal.includes('BUY');
          const isStrong = voting.rawSignal.includes('STRONG') || (isBuy ? voting.buyVotes >= 4 : voting.sellVotes >= 4);
          if (isBuy) return isStrong ? 1.0 : 0.8;
          return isStrong ? -1.0 : -0.8;
        };

        const score5m = getSigScore(voting5m);
        const score1h = getSigScore(voting1h);
        const score1d = getSigScore(voting1d);

        // Weighted Multi-Timeframe Score: 5m (50%), 1h (30%), 1d (20%)
        const weightedScore = (score5m * 0.50) + (score1h * 0.30) + (score1d * 0.20);
        const confluenceScore = Number((Math.abs(weightedScore) * 100).toFixed(0));

        const buyCount = (isBuy5m ? 1 : 0) + (isBuy1h ? 1 : 0) + (isBuy1d ? 1 : 0);
        const sellCount = (isSell5m ? 1 : 0) + (isSell1h ? 1 : 0) + (isSell1d ? 1 : 0);

        let isFullConfluence = false;
        let confluenceType: 'BUY_3' | 'SELL_3' | 'BUY_2' | 'SELL_2' | 'PARTIAL' | 'NEUTRAL' = 'NEUTRAL';

        if (buyCount === 3) {
          isFullConfluence = true;
          confluenceType = 'BUY_3';
        } else if (sellCount === 3) {
          isFullConfluence = true;
          confluenceType = 'SELL_3';
        } else if (buyCount === 2) {
          confluenceType = 'BUY_2';
        } else if (sellCount === 2) {
          confluenceType = 'SELL_2';
        } else if (confluenceScore >= 40) {
          confluenceType = 'PARTIAL';
        }

        // ── 2. QVE Tournament (Synced with Profile & Weights) ──
        const qve = runQVESelection({
          symbol,
          data5m: closed5m,
          data1h: closed1h,
          data1d: closed1d,
          executionStyle,
          triggerMode,
          scoringWeights,
        });

        // ── 3. RVOL & Bollinger Volatility ──
        const rvol = closed5m.length > 0 ? calculateTimeOfDayRVOL(closed5m, closed5m.length - 1, 10, 300) : 1.0;

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

        analytics = {
          hash: cacheHash,
          sig5m,
          sig1h,
          sig1d,
          confluenceScore,
          isFullConfluence,
          confluenceType,
          qve,
          rvol,
          volatilityStatus,
          bbWidthPercent,
        };

        calcCacheRef.current.set(symbol, analytics);
      }

      // ── Always Recalculate Live Execution Price & Final Signal with Real-time Quote ──
      const triggerRaw = executionStyle === 'swing' ? k1h : k5m;
      const triggerEntryPrice = getEffectiveExecutionPrice(triggerRaw, analytics.qve.triggerKlines);
      const mfEntryPrice = getEffectiveExecutionPrice(k5m, closed5m);

      let overallSig = 'NEUTRAL';
      if (analytics.qve.bestStrategy === 'NONE') {
        overallSig = 'NEUTRAL';
      } else if (analytics.qve.bestStrategy === 'confluencia') {
        overallSig = calculateExperimentalSignal(analytics.qve.triggerKlines, analytics.qve.targetInterval).signal;
      } else if (analytics.qve.bestStrategy === 'scoring') {
        overallSig = calculateScoringSignal(analytics.qve.triggerKlines, analytics.qve.targetInterval, scoringWeights).signal;
      } else if (analytics.qve.bestStrategy === 'multitemporal') {
        overallSig = calculateVCMESniperSignal(
          analytics.qve.triggerKlines,
          closed1h,
          closed1d,
          symbol,
          analytics.qve.winRate,
          analytics.qve.profitFactor,
          executionStyle,
          triggerMode,
          triggerEntryPrice
        ).signal;
      } else if (analytics.qve.bestStrategy === 'multifractal') {
        overallSig = calculateMultifractalMTFSignal(closed5m, closed1h, closed1d, symbol, mfEntryPrice).signal;
      } else {
        overallSig = calculateStandardVoting(analytics.qve.triggerKlines).signal;
      }

      const rowResult: RadarRowData = {
        symbol,
        name: symbol,
        isCrypto,
        price,
        changePercent,
        signal5m: analytics.sig5m,
        signal1h: analytics.sig1h,
        signal1d: analytics.sig1d,
        overallSignal: overallSig,
        isFullConfluence: analytics.isFullConfluence,
        confluenceType: analytics.confluenceType,
        confluenceScore: analytics.confluenceScore,
        qveStrategy: analytics.qve.strategyLabel,
        qveProfitFactor: analytics.qve.profitFactor,
        qveConfidence: analytics.qve.confidence,
        rvol: analytics.rvol,
        volatilityStatus: analytics.volatilityStatus,
        bbWidthPercent: analytics.bbWidthPercent,
        loading: false,
        isOffline: false,
      };

      return rowResult;
    } catch (e) {
      console.error(`Error scanning radar for ${symbol}`, e);
      const prevCount = failureMapRef.current.get(symbol)?.count || 0;
      failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: getNowTimestamp() });

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

  // Run batch scan with concurrency limit, generation guard, and micro-pauses
  const runFullScan = async () => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;
    setIsScanning(true);

    const currentGen = ++scanGenerationRef.current;

    try {
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
        if (!isMountedRef.current || scanGenerationRef.current !== currentGen) break;
        const batch = symbolsToScan.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(sym => scanSymbol(sym)));
        if (isMountedRef.current && scanGenerationRef.current === currentGen) {
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
    } finally {
      if (scanGenerationRef.current === currentGen) {
        isScanningRef.current = false;
        if (isMountedRef.current) {
          setIsScanning(false);
        }
      }
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
    runFullScan();
    const timer = setInterval(runFullScan, 60000);
    const genRef = scanGenerationRef;
    const scanRef = isScanningRef;
    const mountedRef = isMountedRef;
    return () => {
      mountedRef.current = false;
      genRef.current++;
      scanRef.current = false;
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsToScan, executionStyle, triggerMode, scoringWeights]);

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
      qveProfitFactor: null,
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
      filtered = filtered.filter(r => (r.qveConfidence !== 'NONE' && (r.overallSignal.includes('BUY') || r.overallSignal.includes('SELL'))) || Boolean(activeSignals[r.symbol]));
    }

    // 3. Sorting
    return [...filtered].sort((a, b) => {
      const rawA = a[sortCol];
      const rawB = b[sortCol];

      if (typeof rawA === 'string' || typeof rawB === 'string') {
        const valA = String(rawA ?? '');
        const valB = String(rawB ?? '');
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }

      const numA = rawA === null || rawA === undefined ? -Infinity : Number(rawA);
      const numB = rawB === null || rawB === undefined ? -Infinity : Number(rawB);
      return sortAsc ? numA - numB : numB - numA;
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

                            {row.confluenceType === 'BUY_3' && (
                              <span style={{
                                fontSize: '0.58rem',
                                fontWeight: '800',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'rgba(16, 185, 129, 0.25)',
                                color: 'var(--accent-green)',
                                border: '1px solid rgba(16, 185, 129, 0.4)',
                              }}>
                                🎯 3/3 ({row.confluenceScore}%)
                              </span>
                            )}
                            {row.confluenceType === 'SELL_3' && (
                              <span style={{
                                fontSize: '0.58rem',
                                fontWeight: '800',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'rgba(244, 63, 94, 0.25)',
                                color: 'var(--accent-red)',
                                border: '1px solid rgba(244, 63, 94, 0.4)',
                              }}>
                                🎯 3/3 ({row.confluenceScore}%)
                              </span>
                            )}
                            {row.confluenceType === 'BUY_2' && (
                              <span style={{
                                fontSize: '0.58rem',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'rgba(59, 130, 246, 0.15)',
                                color: 'var(--accent-blue)',
                                border: '1px solid rgba(59, 130, 246, 0.3)',
                              }}>
                                ⚡ 2/3 ({row.confluenceScore}%)
                              </span>
                            )}
                            {row.confluenceType === 'SELL_2' && (
                              <span style={{
                                fontSize: '0.58rem',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'rgba(234, 179, 8, 0.15)',
                                color: '#eab308',
                                border: '1px solid rgba(234, 179, 8, 0.3)',
                              }}>
                                ⚡ 2/3 ({row.confluenceScore}%)
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
                              color: row.qveProfitFactor === null || row.qveProfitFactor >= 1.3 ? 'var(--accent-green)' : 'var(--text-secondary)',
                              fontWeight: '700',
                            }}>
                              {row.qveProfitFactor !== null ? `PF ${row.qveProfitFactor.toFixed(1)}` : 'PF N/D'}
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
