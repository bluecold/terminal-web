import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, RefreshCw, ArrowUpDown, ChevronUp, ChevronDown, Eye, AlertTriangle, ShieldCheck, Zap } from 'lucide-react';
import { fetchKlines } from '../services/api';
import {
  calculateBollingerBandsSeries,
  calculateBollingerVolatilityStatus,
  getConfirmedClosedKlines,
  calculateTimeOfDayRVOL,
  getEffectiveExecutionPrice,
  isNyseTradingSessionActive,
  isNyseSessionClosingCandle,
  type ScoringWeights,
} from '../utils/indicators';
import {
  calculateStandardVoting,
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateMFLSSignal,
} from '../utils/strategySignals';
import { formatSmartPrice } from '../utils/formatters';
import { runQVESelection, buildStrategyCandidateQueue, resolveCandidateCascade, resolveTournamentLeader, type ConfidenceLevel } from '../utils/tournament';
import { isExploratorySelection } from '../utils/alertEmission';
import { getMsUntilNextAlignedScan } from '../utils/scanSchedule';
import { getKlinesFingerprint } from '../utils/backtester';
import { resolveOperationalTrade } from '../utils/operationalTrade';
import { isCryptoAsset } from '../utils/tradeLevels';
import { getEarningsNotice } from '../utils/marketEvents';
import { useEarningsCalendar } from '../hooks/useEarningsCalendar';
import EventBadge from './EventBadge';
import {
  isRadarRowActive,
  checkAlertCooldownStatus,
  type RadarRowData,
  type RadarFilter,
  type SortColumn,
  type AlertCooldownRecord,
} from '../utils/radarFilters';

export type { RadarRowData, RadarFilter, SortColumn };

// Clock helper to isolate Date.now() access from component render body
function getNowTimestamp(): number {
  return Date.now();
}



interface MarketRadarProps {
  watchlistSymbols: string[];
  currentAsset: string;
  onSelectAsset: (symbol: string) => void;
  onNavigateToChart: (symbol: string) => void;
  activeSignals?: Record<string, string>;
  alertCooldowns?: Record<string, number | AlertCooldownRecord>;
  executionStyle?: 'dayTrading' | 'swing';
  triggerMode?: 'agresivo' | 'conservador';
  scoringWeights?: ScoringWeights;
  allowExploratory?: boolean;   // 🔬 opt-in: exploratory/informational signals count as active rows
}

const PRESET_POOLS: Record<string, string[]> = {
  crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'NEARUSDT', 'SUIUSDT', 'LINKUSDT'],
  tech: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD'],
  growth: ['PLTR', 'COIN', 'MSTR', 'MARA', 'ARM', 'SMCI', 'HUT', 'SATL'],
  macro: ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'USO', 'TLT'],
};

function createDefaultRadarRow(symbol: string, overrides: Partial<RadarRowData> = {}): RadarRowData {
  const isCrypto = isCryptoAsset(symbol);
  return {
    symbol,
    name: symbol,
    isCrypto,
    price: 0,
    changePercent: 0,
    signal5m: '...',
    signal1h: '...',
    signal1d: '...',
    overallSignal: 'NEUTRAL',
    isFullConfluence: false,
    confluenceType: 'NEUTRAL',
    confluenceScore: 0,
    qveStrategy: '...',
    qveProfitFactor: null,
    qveConfidence: 'NONE',
    signalConfidence: 'NONE',
    rvol: 1.0,
    volatilityStatus: 'NORMAL',
    bbWidthPercent: 0,
    bbPercentile: 50,
    loading: false,
    isOffline: false,
    isMarketClosed: false,
    hasPartialData: false,
    qveReasoning: '',
    activeStrategyLabel: undefined,
    isFallbackSignal: false,
    actionableReasoning: undefined,
    isOperationalViable: true,
    operationalReason: undefined,
    isCooldownActive: false,
    cooldownRemainingMs: 0,
    isSessionClosingCandle: false,
    ...overrides,
  };
}

export default function MarketRadar({
  watchlistSymbols,
  currentAsset: _currentAsset,
  onSelectAsset: _onSelectAsset,
  onNavigateToChart,
  activeSignals = {},
  alertCooldowns = {},
  executionStyle = 'dayTrading',
  triggerMode = 'agresivo',
  scoringWeights,
  allowExploratory = false,
}: MarketRadarProps) {
  const alertCooldownsPropRef = useRef(alertCooldowns);
  useEffect(() => {
    alertCooldownsPropRef.current = alertCooldowns;
  }, [alertCooldowns]);
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
    rawStd: string;
    confluenciaSignal: string;
    scoringSignal: string;
    rvol: number;
    volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL';
    bbWidthPercent: number;
    bbPercentile: number;
    confluenceWarning?: string;
    hasPartialData: boolean;
  }
  const calcCacheRef = useRef<Map<string, CachedRadarAnalytics>>(new Map());

  const symbolsToScan = useMemo(() => {
    if (activePreset === 'watchlist') {
      return watchlistSymbols.length > 0 ? watchlistSymbols : ['BTCUSDT', 'ETHUSDT', 'TSLA', 'MSFT'];
    }
    return PRESET_POOLS[activePreset] || [];
  }, [activePreset, watchlistSymbols]);
  const earningsEvents = useEarningsCalendar(symbolsToScan);

  // Scan single symbol multitemporal data
  const scanSymbol = async (symbol: string, forceFresh: boolean = false, targetGen?: number): Promise<RadarRowData> => {
    const isCrypto = isCryptoAsset(symbol);
    const isCurrentGen = () => isMountedRef.current && (targetGen === undefined || scanGenerationRef.current === targetGen);

    // 1. Circuit breaker check: reset consecutive error count if the 10-minute backoff has elapsed
    const failInfo = failureMapRef.current.get(symbol);
    if (failInfo && getNowTimestamp() - failInfo.lastFailed >= 10 * 60 * 1000) {
      failureMapRef.current.delete(symbol);
    } else if (!forceFresh && failInfo && failInfo.count >= 2) {
      return createDefaultRadarRow(symbol, {
        signal5m: 'OFFLINE',
        signal1h: 'OFFLINE',
        signal1d: 'OFFLINE',
        qveStrategy: 'Standard',
        isOffline: true,
        offlineReason: 'Pausado por fallos continuos de API (10 min backoff)',
      });
    }

    try {
      const [k5m, k1h, k1d] = await Promise.all([
        fetchKlines(symbol, '5m'),
        fetchKlines(symbol, '1h'),
        fetchKlines(symbol, '1d'),
      ]);

      if (!isCurrentGen()) {
        return createDefaultRadarRow(symbol, { overallSignal: '...' });
      }

      const isCompleteFailure = k5m.length === 0 && k1h.length === 0 && k1d.length === 0;
      const isPartialFailure = k5m.length === 0 || k1h.length === 0 || k1d.length === 0;

      if (isCompleteFailure) {
        if (isCurrentGen()) {
          const prevCount = failureMapRef.current.get(symbol)?.count || 0;
          failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: getNowTimestamp() });
        }

        return createDefaultRadarRow(symbol, {
          signal5m: 'SIN DATOS',
          signal1h: 'SIN DATOS',
          signal1d: 'SIN DATOS',
          qveStrategy: 'Standard',
          isOffline: true,
          offlineReason: 'Sin datos disponibles para este ticker',
        });
      }

      // Complete success (all timeframes available): reset failure count.
      // Partial failures (e.g. 5m empty from Yahoo but 1h/1d valid) neither increment the circuit breaker nor reset it.
      if (!isPartialFailure && isCurrentGen()) {
        failureMapRef.current.delete(symbol);
      }

      // Latest price & daily change (using fresh 25s 5m candle with prior day close baseline)
      let price = 0;
      let changePercent = 0;
      if (k5m.length > 0) {
        price = k5m[k5m.length - 1].close;
      } else if (k1d.length > 0) {
        price = k1d[k1d.length - 1].close;
      }

      if (price > 0 && k1d.length > 0) {
        const last1d = k1d[k1d.length - 1];
        const last5mTime = k5m.length > 0 ? k5m[k5m.length - 1].time : last1d.time;
        const isSameDay = Math.abs(last5mTime - last1d.time) < 86400;
        const prevDailyClose = (isSameDay && k1d.length >= 2)
          ? k1d[k1d.length - 2].close
          : last1d.close;
        if (prevDailyClose > 0) {
          changePercent = ((price - prevDailyClose) / prevDailyClose) * 100;
        }
      }

      // Market closed detection for equities / ETFs:
      // Canonical NYSE session calendar/hours plus data staleness guard (> 4 hours without bar)
      const nowMs = getNowTimestamp();
      const nowSec = Math.floor(nowMs / 1000);
      const latestDataTime = k5m.length > 0 ? k5m[k5m.length - 1].time : (k1d.length > 0 ? k1d[k1d.length - 1].time : nowSec);
      const isMarketClosed = !isCrypto && (!isNyseTradingSessionActive(nowMs) || (nowSec - latestDataTime > 14400));

      const closed5m = getConfirmedClosedKlines(k5m, '5m', symbol);
      const closed1h = getConfirmedClosedKlines(k1h, '1h', symbol);
      const closed1d = getConfirmedClosedKlines(k1d, '1d', symbol);

      // Smart cache check using robust FNV-1a OHLCV candle fingerprints, user profile, and scoring weights
      const klinesHash = getKlinesFingerprint([closed5m, closed1h, closed1d]);
      const wKey = scoringWeights ? `${scoringWeights.trend}_${scoringWeights.rsi}_${scoringWeights.bollinger}_${scoringWeights.volume}_${scoringWeights.candle}` : 'default';
      const cacheHash = `${symbol}_${klinesHash}_${executionStyle}_${triggerMode}_${wKey}`;

      let analytics: CachedRadarAnalytics;
      const cached = !forceFresh ? calcCacheRef.current.get(symbol) : undefined;

      if (cached && cached.hash === cacheHash) {
        analytics = cached;
      } else {
        // ── 1. Multitemporal Signals & Weighted Confluence ────────
        const voting5m = closed5m.length >= 35 ? calculateStandardVoting(closed5m) : null;
        const voting1h = closed1h.length >= 35 ? calculateStandardVoting(closed1h) : null;
        const voting1d = closed1d.length >= 35 ? calculateStandardVoting(closed1d) : null;

        const sig5m = voting5m ? voting5m.signal : (k5m.length === 0 ? 'SIN DATOS' : 'NEUTRAL');
        const sig1h = voting1h ? voting1h.signal : (k1h.length === 0 ? 'SIN DATOS' : 'NEUTRAL');
        const sig1d = voting1d ? voting1d.signal : (k1d.length === 0 ? 'SIN DATOS' : 'NEUTRAL');

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

        // Weighted Multi-Timeframe Score adapted to Profile:
        // - Day Trading: 5m (50%), 1h (30%), 1d (20%)
        // - Swing Trading: 1h (50%), 1d (35%), 5m (15%)
        const weightedScore = executionStyle === 'swing'
          ? (score1h * 0.50) + (score1d * 0.35) + (score5m * 0.15)
          : (score5m * 0.50) + (score1h * 0.30) + (score1d * 0.20);
        const confluenceScore = Number((Math.abs(weightedScore) * 100).toFixed(0));

        const buyCount = (isBuy5m ? 1 : 0) + (isBuy1h ? 1 : 0) + (isBuy1d ? 1 : 0);
        const sellCount = (isSell5m ? 1 : 0) + (isSell1h ? 1 : 0) + (isSell1d ? 1 : 0);

        let isFullConfluence = false;
        let confluenceType: 'BUY_3' | 'SELL_3' | 'BUY_2' | 'SELL_2' | 'PARTIAL' | 'NEUTRAL' = 'NEUTRAL';
        let confluenceWarning: string | undefined = undefined;

        if (buyCount === 3) {
          isFullConfluence = true;
          confluenceType = 'BUY_3';
        } else if (sellCount === 3) {
          isFullConfluence = true;
          confluenceType = 'SELL_3';
        } else if (buyCount === 2) {
          confluenceType = 'BUY_2';
          if (isSell1d) {
            confluenceWarning = 'Contratendencia: Diario 1D es bajista';
          }
        } else if (sellCount === 2) {
          confluenceType = 'SELL_2';
          if (isBuy1d) {
            confluenceWarning = 'Contratendencia: Diario 1D es alcista';
          }
        } else if (isPartialFailure) {
          confluenceType = 'PARTIAL';
        }

        if (isPartialFailure) {
          const missingTfs = [k5m.length === 0 && '5m', k1h.length === 0 && '1h', k1d.length === 0 && '1d'].filter(Boolean).join(', ');
          const partNote = `Datos parciales (falta ${missingTfs})`;
          confluenceWarning = confluenceWarning ? `${confluenceWarning} | ${partNote}` : partNote;
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

        // Pre-compute closed-candle strategy signals once inside cache
        const rawStd = calculateStandardVoting(qve.triggerKlines).signal;
        const confluenciaSignal = calculateExperimentalSignal(qve.triggerKlines, qve.targetInterval, isCrypto).signal;
        const scoringSignal = calculateScoringSignal(qve.triggerKlines, qve.targetInterval, scoringWeights, isCrypto).signal;

        // ── 3. Profile-Aware RVOL & Bollinger Volatility ──────────
        const tacticalKlines = executionStyle === 'swing' ? closed1h : closed5m;
        const stepSec = executionStyle === 'swing' ? 3600 : 300;
        const rvol = tacticalKlines.length > 0
          ? calculateTimeOfDayRVOL(tacticalKlines, tacticalKlines.length - 1, 10, stepSec)
          : 1.0;

        const volKlines = executionStyle === 'swing' ? closed1h : closed5m;
        let volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL' = 'NORMAL';
        let bbWidthPercent = 0;
        let bbPercentile = 50;

        if (volKlines.length >= 20) {
          const bbSeries = calculateBollingerBandsSeries(volKlines, 20, 2);
          if (bbSeries.length > 0) {
            const volStatus = calculateBollingerVolatilityStatus(bbSeries, 50);
            volatilityStatus = volStatus.status;
            bbWidthPercent = volStatus.widthPercent;
            bbPercentile = volStatus.percentile;
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
          confluenceWarning,
          hasPartialData: isPartialFailure,
          qve,
          rawStd,
          confluenciaSignal,
          scoringSignal,
          rvol,
          volatilityStatus,
          bbWidthPercent,
          bbPercentile,
        };

        if (isCurrentGen()) {
          calcCacheRef.current.set(symbol, analytics);
        }
      }

      // ── Always Recalculate Live Execution Price & Final Signal with Real-time Quote ──
      const triggerRaw = executionStyle === 'swing' ? k1h : k5m;
      const triggerEntryPrice = getEffectiveExecutionPrice(triggerRaw, analytics.qve.triggerKlines);
      const mfEntryPrice = getEffectiveExecutionPrice(k5m, closed5m);

      const vcmeRes = calculateVCMESniperSignal(
        analytics.qve.triggerKlines,
        closed1h,
        closed1d,
        symbol,
        analytics.qve.btMulti.winRate,
        analytics.qve.btMulti.profitFactor,
        executionStyle,
        triggerMode,
        triggerEntryPrice
      );
      const vcmeSignal = vcmeRes.signal;
      const multifractalRes = calculateMultifractalMTFSignal(
        closed5m,
        closed1h,
        closed1d,
        symbol,
        mfEntryPrice
      );
      const multifractalSignal = multifractalRes.signal;
      const mflsRes = calculateMFLSSignal(
        closed5m,
        symbol,
        mfEntryPrice
      );
      const mflsSignal = mflsRes.signal;
      const strategySignals = {
        standard: analytics.rawStd,
        confluencia: analytics.confluenciaSignal,
        scoring: analytics.scoringSignal,
        multitemporal: vcmeSignal,
        multifractal: multifractalSignal,
        mfls: mflsSignal,
      };
      // Same candidate queue and cascade as the App scanner (shared helpers in tournament.ts)
      const candidateQueue = buildStrategyCandidateQueue(analytics.qve, strategySignals);
      const cascade = resolveCandidateCascade(candidateQueue, candidate => {
        const signalInterval = (candidate.strategy === 'multifractal' || candidate.strategy === 'mfls') ? '5m' : executionStyle === 'swing' ? '1h' : '5m';
        const currentKlines = signalInterval === '1h' ? k1h : k5m;
        const closedData = signalInterval === '1h' ? closed1h : closed5m;
        return resolveOperationalTrade({
          strategy: candidate.strategy,
          signal: candidate.signal,
          executionStyle,
          raw: { [signalInterval]: currentKlines, '5m': k5m, '1h': k1h },
          closed: { [signalInterval]: closedData, '5m': closed5m, '1h': closed1h },
          vcme: candidate.strategy === 'multitemporal' ? vcmeRes : undefined,
          multifractal: candidate.strategy === 'multifractal' ? multifractalRes : undefined,
          mfls: candidate.strategy === 'mfls' ? mflsRes : undefined,
          isCrypto,
        });
      });
      const viableCandidate = cascade.viable?.candidate ?? null;
      // Leader shown in the row, consistent with what the scanner can alert (Confluencia on 5m equities)
      const leader = resolveTournamentLeader(analytics.qve);
      const firstRejectedCandidate = cascade.firstRejected;

      const activeCandidate = viableCandidate || firstRejectedCandidate?.candidate;
      const hasActionable = !!activeCandidate;
      let overallSig: string = activeCandidate ? activeCandidate.signal : 'NEUTRAL';
      if (overallSig === 'NEUTRAL' && analytics.hasPartialData) {
        const triggerMissing = executionStyle === 'swing' ? closed1h.length < 35 : closed5m.length < 35;
        if (triggerMissing) {
          overallSig = 'PARCIAL';
        }
      }

      const signalConfidence: ConfidenceLevel = (hasActionable && (overallSig.includes('BUY') || overallSig.includes('SELL')))
        ? (activeCandidate?.confidence ?? 'NONE')
        : 'NONE';

      const isFallbackSignal = activeCandidate ? activeCandidate.isFallback : false;
      const activeStrategyLabel = activeCandidate ? activeCandidate.strategyLabel : undefined;
      const actionableReasoning = activeCandidate ? activeCandidate.reasoning : undefined;

      const isOperationalViable = viableCandidate !== null;
      const operationalReason = viableCandidate ? undefined : firstRejectedCandidate?.plan.reason;

      const activeInterval = (activeCandidate?.strategy === 'multifractal' || activeCandidate?.strategy === 'mfls') ? '5m' : executionStyle === 'swing' ? '1h' : '5m';
      const triggerClosedKlines = activeInterval === '1h' ? closed1h : closed5m;
      const candleTimestamp = triggerClosedKlines.length > 0 ? triggerClosedKlines[triggerClosedKlines.length - 1].time : 0;

      const isSwingVCME = (activeCandidate?.strategy === 'multitemporal' || activeCandidate?.strategyLabel?.includes('VCME')) && executionStyle === 'swing';
      const isSessionClosingCandle = !isCrypto && !isSwingVCME && candleTimestamp > 0 && isNyseSessionClosingCandle(candleTimestamp, activeInterval, symbol);

      const isExploratory = activeCandidate ? isExploratorySelection(activeCandidate) : false;
      const cooldownStatus = checkAlertCooldownStatus(
        symbol,
        activeInterval,
        isExploratory ?? false,
        executionStyle,
        alertCooldownsPropRef.current,
        nowMs
      );
      const isCooldownActive = cooldownStatus.inCooldown;
      const cooldownRemainingMs = cooldownStatus.remainingMs;

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
        confluenceWarning: analytics.confluenceWarning,
        hasPartialData: analytics.hasPartialData,
        confluenceScore: analytics.confluenceScore,
        qveStrategy: leader.label,
        qveProfitFactor: leader.profitFactor,
        qveConfidence: leader.confidence,
        signalConfidence,
        qveReasoning: leader.reasoning,
        activeStrategyLabel,
        isFallbackSignal,
        actionableReasoning,
        isOperationalViable,
        operationalReason,
        isCooldownActive,
        cooldownRemainingMs,
        isSessionClosingCandle,
        rvol: analytics.rvol,
        volatilityStatus: analytics.volatilityStatus,
        bbWidthPercent: analytics.bbWidthPercent,
        bbPercentile: analytics.bbPercentile,
        loading: false,
        isOffline: false,
        isMarketClosed,
      };

      return rowResult;
    } catch (e) {
      if (isCurrentGen()) {
        console.error(`Error scanning radar for ${symbol}`, e);
        const prevCount = failureMapRef.current.get(symbol)?.count || 0;
        failureMapRef.current.set(symbol, { count: prevCount + 1, lastFailed: getNowTimestamp() });
      }

      return createDefaultRadarRow(symbol, {
        signal5m: 'ERROR',
        signal1h: 'ERROR',
        signal1d: 'ERROR',
        qveStrategy: 'Standard',
        isOffline: true,
        offlineReason: 'Error al consultar datos de mercado',
      });
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
            next[sym] = createDefaultRadarRow(sym, { loading: true, overallSignal: '...' });
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
        const results = await Promise.all(batch.map(sym => scanSymbol(sym, false, currentGen)));
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

  // Manual retry for a single symbol with generation guard
  const handleRetrySymbol = async (e: React.MouseEvent, sym: string) => {
    e.stopPropagation();
    const retryGen = scanGenerationRef.current;
    failureMapRef.current.delete(sym);
    calcCacheRef.current.delete(sym);
    setRadarData(prev => ({
      ...prev,
      [sym]: { ...(prev[sym] || { symbol: sym }), loading: true } as RadarRowData
    }));
    const res = await scanSymbol(sym, true, retryGen);
    if (isMountedRef.current && scanGenerationRef.current === retryGen) {
      setRadarData(prev => ({ ...prev, [sym]: res }));
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    runFullScan();
    // Same cadence as the alert scanner: a few seconds after every minute boundary (candle closes)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAlignedScan = () => {
      timer = setTimeout(() => {
        if (!isMountedRef.current) return;
        runFullScan();
        scheduleAlignedScan();
      }, getMsUntilNextAlignedScan(Date.now()));
    };
    scheduleAlignedScan();
    const genRef = scanGenerationRef;
    const scanRef = isScanningRef;
    const mountedRef = isMountedRef;
    return () => {
      mountedRef.current = false;
      genRef.current++;
      scanRef.current = false;
      if (timer) clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsToScan, executionStyle, triggerMode, scoringWeights]);

  // Filter & Sort table items
  const processedRows = useMemo(() => {
    const nowMs = getNowTimestamp();
    const all = symbolsToScan.map(sym => {
      const row = radarData[sym] || createDefaultRadarRow(sym, { loading: true, overallSignal: '...' });
      if (row.loading || row.isOffline) return row;
      const activeInterval = row.activeStrategyLabel?.includes('Multifractal') ? '5m' : executionStyle === 'swing' ? '1h' : '5m';
      const isExploratory = row.signalConfidence === 'NONE';
      const cdStatus = checkAlertCooldownStatus(
        row.symbol,
        activeInterval,
        isExploratory,
        executionStyle,
        alertCooldowns,
        nowMs
      );
      if (cdStatus.inCooldown !== row.isCooldownActive || (row.cooldownRemainingMs ?? 0) !== cdStatus.remainingMs) {
        return {
          ...row,
          isCooldownActive: cdStatus.inCooldown,
          cooldownRemainingMs: cdStatus.remainingMs,
        };
      }
      return row;
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
      filtered = filtered.filter(r => r.rvol >= 1.5 && !r.isMarketClosed);
    } else if (activeFilter === 'active') {
      filtered = filtered.filter(r => isRadarRowActive(r, activeSignals, allowExploratory));
    }

    // 3. Sorting (uses normalized bbPercentile when sorting volatility)
    return [...filtered].sort((a, b) => {
      const col = sortCol;
      const rawA = col === 'bbWidthPercent' ? a.bbPercentile : a[col];
      const rawB = col === 'bbWidthPercent' ? b.bbPercentile : b[col];

      if (typeof rawA === 'string' || typeof rawB === 'string') {
        const valA = String(rawA ?? '');
        const valB = String(rawB ?? '');
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }

      const numA = rawA === null || rawA === undefined ? -Infinity : Number(rawA);
      const numB = rawB === null || rawB === undefined ? -Infinity : Number(rawB);
      return sortAsc ? numA - numB : numB - numA;
    });
  }, [symbolsToScan, radarData, searchQuery, activeFilter, sortCol, sortAsc, activeSignals, alertCooldowns, executionStyle, allowExploratory]);

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
            { id: 'macro', label: 'Índices & ETFs', icon: '🏛️' },
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
            { id: 'confluence', label: '🔥 Alineación MTF' },
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
                    <span>VAR. DÍA</span>
                    {sortCol === 'changePercent' ? (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} opacity={0.4} />}
                  </div>
                </th>
                <th style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => handleSort('confluenceScore')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span title="Votación Estándar en 5m, 1h y 1d (no es la estrategia Confluencia). En acciones 5m es informativa: Estándar no tiene ventaja neta medida (−0,13R por alerta).">ALINEACIÓN ESTÁNDAR (5m · 1h · 1d)</span>
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
                    <span>VOLATILIDAD (BB %)</span>
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
                          onNavigateToChart(row.symbol);
                        }
                      }}
                    >
                      {/* 1. Symbol & Market Tag */}
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: '800', color: '#fff', fontSize: '0.82rem' }}>
                            {row.symbol}
                          </span>
                          <EventBadge notice={getEarningsNotice(earningsEvents[row.symbol.toUpperCase()])} />
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
                          {row.hasPartialData && !row.isOffline && (
                            <span
                              title={row.confluenceWarning || 'Datos parciales (algunas temporalidades sin datos)'}
                              style={{
                                fontSize: '0.52rem',
                                fontWeight: '700',
                                padding: '1px 4px',
                                borderRadius: '3px',
                                background: 'rgba(234, 179, 8, 0.15)',
                                color: '#eab308',
                                border: '1px solid rgba(234, 179, 8, 0.3)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px',
                              }}
                            >
                              <AlertTriangle size={10} />
                              <span>PARCIAL</span>
                            </span>
                          )}
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

                      {/* 4. MTF alignment matrix (Standard Voting on 5m · 1h · 1d) — informational on 5m equities */}
                      <td
                        style={{ padding: '12px 14px', opacity: !row.isCrypto && executionStyle === 'dayTrading' ? 0.6 : 1 }}
                        title={!row.isCrypto && executionStyle === 'dayTrading' ? 'Informativa en acciones 5m: alineación de la votación Estándar, sin ventaja neta medida. Las alertas las decide Confluencia.' : undefined}
                      >
                        {row.loading ? (
                          <span className="radar-skeleton">Evaluando alineación...</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{row.offlineReason || 'Sin datos'}</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {/* 5m */}
                            <span
                              title={row.signal5m === 'SIN DATOS' ? 'Temporalidad 5m sin datos' : undefined}
                              style={{
                                fontSize: '0.6rem',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: row.signal5m.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal5m.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : row.signal5m === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                                color: row.signal5m.includes('BUY') ? 'var(--accent-green)' : row.signal5m.includes('SELL') ? 'var(--accent-red)' : row.signal5m === 'SIN DATOS' ? '#eab308' : 'var(--text-muted)',
                                border: `1px solid ${row.signal5m === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                              }}
                            >
                              5m: {row.signal5m.includes('BUY') ? 'BUY' : row.signal5m.includes('SELL') ? 'SELL' : row.signal5m === 'SIN DATOS' ? 'N/D' : '—'}
                            </span>

                            {/* 1h */}
                            <span
                              title={row.signal1h === 'SIN DATOS' ? 'Temporalidad 1h sin datos' : undefined}
                              style={{
                                fontSize: '0.6rem',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: row.signal1h.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal1h.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : row.signal1h === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                                color: row.signal1h.includes('BUY') ? 'var(--accent-green)' : row.signal1h.includes('SELL') ? 'var(--accent-red)' : row.signal1h === 'SIN DATOS' ? '#eab308' : 'var(--text-muted)',
                                border: `1px solid ${row.signal1h === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                              }}
                            >
                              1h: {row.signal1h.includes('BUY') ? 'BUY' : row.signal1h.includes('SELL') ? 'SELL' : row.signal1h === 'SIN DATOS' ? 'N/D' : '—'}
                            </span>

                            {/* 1d */}
                            <span
                              title={row.signal1d === 'SIN DATOS' ? 'Temporalidad 1d sin datos' : undefined}
                              style={{
                                fontSize: '0.6rem',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: row.signal1d.includes('BUY') ? 'rgba(16, 185, 129, 0.15)' : row.signal1d.includes('SELL') ? 'rgba(244, 63, 94, 0.15)' : row.signal1d === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                                color: row.signal1d.includes('BUY') ? 'var(--accent-green)' : row.signal1d.includes('SELL') ? 'var(--accent-red)' : row.signal1d === 'SIN DATOS' ? '#eab308' : 'var(--text-muted)',
                                border: `1px solid ${row.signal1d === 'SIN DATOS' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                              }}
                            >
                              1d: {row.signal1d.includes('BUY') ? 'BUY' : row.signal1d.includes('SELL') ? 'SELL' : row.signal1d === 'SIN DATOS' ? 'N/D' : '—'}
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
                              <span
                                title={row.confluenceWarning ? `⚡ 2/3 (${row.confluenceWarning})` : '⚡ 2/3 Alineación alcista (Estándar)'}
                                style={{
                                  fontSize: '0.58rem',
                                  fontWeight: '700',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'rgba(59, 130, 246, 0.15)',
                                  color: 'var(--accent-blue)',
                                  border: '1px solid rgba(59, 130, 246, 0.3)',
                                  cursor: row.confluenceWarning ? 'help' : 'default',
                                }}
                              >
                                ⚡ 2/3 ({row.confluenceScore}%){row.confluenceWarning ? ' ⚠️' : ''}
                              </span>
                            )}
                            {row.confluenceType === 'SELL_2' && (
                              <span
                                title={row.confluenceWarning ? `⚡ 2/3 (${row.confluenceWarning})` : '⚡ 2/3 Alineación bajista (Estándar)'}
                                style={{
                                  fontSize: '0.58rem',
                                  fontWeight: '700',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'rgba(244, 63, 94, 0.15)',
                                  color: 'var(--accent-red)',
                                  border: '1px solid rgba(244, 63, 94, 0.3)',
                                  cursor: row.confluenceWarning ? 'help' : 'default',
                                }}
                              >
                                ⚡ 2/3 ({row.confluenceScore}%){row.confluenceWarning ? ' ⚠️' : ''}
                              </span>
                            )}
                            {row.confluenceType === 'PARTIAL' && (
                              <span
                                title={row.confluenceWarning || 'Datos parciales'}
                                style={{
                                  fontSize: '0.58rem',
                                  fontWeight: '700',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'rgba(234, 179, 8, 0.15)',
                                  color: '#eab308',
                                  border: '1px solid rgba(234, 179, 8, 0.3)',
                                  cursor: 'help',
                                }}
                              >
                                ⚠️ PARCIAL
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* 5. QVE Leader Strategy & Active Fallback Signal */}
                      <td style={{ padding: '10px 14px' }}>
                        {row.loading ? (
                          <span className="radar-skeleton">—</span>
                        ) : row.isOffline ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            {(() => {
                              const hasActiveSignal = row.overallSignal.includes('BUY') || row.overallSignal.includes('SELL');
                              const effectiveLeaderConfidence = (!row.isFallbackSignal && hasActiveSignal)
                                ? row.signalConfidence
                                : row.qveConfidence;
                              const titleText = (!row.isFallbackSignal && hasActiveSignal && row.actionableReasoning)
                                ? row.actionableReasoning
                                : (row.qveReasoning || (effectiveLeaderConfidence === 'HIGH' ? 'Backtest favorable (no validado fuera de muestra)' : 'Backtest con muestra limitada'));

                              return (
                                <div 
                                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }} 
                                  title={
                                    row.isOperationalViable === false && row.operationalReason
                                      ? `${row.qveReasoning || ''}\n\n⛔ Descartada por filtro operativo: ${row.operationalReason}`
                                      : (row.isFallbackSignal && row.activeStrategyLabel
                                          ? `Estrategia líder del torneo: ${row.qveStrategy} (${row.qveConfidence}, ${row.qveProfitFactor !== null ? `PF ${row.qveProfitFactor.toFixed(1)}` : 'PF N/D'})\n${row.qveReasoning}\n\n🚨 Señal ${row.overallSignal} activa vía alternativa (${row.signalConfidence}): ${row.activeStrategyLabel}\n${row.actionableReasoning || ''}`
                                          : titleText)
                                  }
                                >
                                  <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>
                                    {row.qveStrategy}
                                  </span>
                                  <span style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.62rem',
                                    color: row.qveProfitFactor !== null && row.qveProfitFactor >= 1.3
                                      ? 'var(--accent-green)'
                                      : (row.qveProfitFactor !== null && row.qveProfitFactor >= 1.0 ? 'var(--text-primary)' : 'var(--text-muted)'),
                                    fontWeight: '700',
                                  }}>
                                    {row.qveProfitFactor !== null ? `PF ${row.qveProfitFactor.toFixed(1)}` : 'PF —'}
                                  </span>
                                  {effectiveLeaderConfidence === 'HIGH' && (
                                    <span title={titleText}>
                                      <ShieldCheck size={12} color="var(--accent-green)" />
                                    </span>
                                  )}
                                  {effectiveLeaderConfidence === 'LIMITED' && <span title={titleText}>⚠️</span>}
                                </div>
                              );
                            })()}

                            {/* Secondary badge when active signal comes from a fallback alternative */}
                            {row.isFallbackSignal && row.activeStrategyLabel && (row.overallSignal.includes('BUY') || row.overallSignal.includes('SELL')) && (
                              <div
                                style={{
                                  fontSize: '0.58rem',
                                  fontWeight: '700',
                                  color: row.overallSignal.includes('BUY') ? 'var(--accent-green)' : 'var(--accent-red)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  lineHeight: 1.1,
                                }}
                                title={
                                  row.isOperationalViable === false && row.operationalReason
                                    ? `⛔ Inviable: ${row.operationalReason}`
                                    : (row.actionableReasoning || `Señal ${row.overallSignal} vía alternativa (${row.signalConfidence}): ${row.activeStrategyLabel}`)
                                }
                              >
                                <span style={{ opacity: 0.8 }}>⚡ Señal vía:</span>
                                <span style={{
                                  background: row.overallSignal.includes('BUY') ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  border: `1px solid ${row.overallSignal.includes('BUY') ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)'}`,
                                }}>
                                  {row.activeStrategyLabel} ({row.signalConfidence})
                                </span>
                              </div>
                            )}

                            {/* Execution readiness badges (Cooldown or Session Closing Candle) */}
                            {!activeSignals[row.symbol] && (row.overallSignal.includes('BUY') || row.overallSignal.includes('SELL')) && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
                                {row.isCooldownActive && (row.cooldownRemainingMs ?? 0) > 0 && (
                                  <span
                                    style={{
                                      fontSize: '0.58rem',
                                      fontWeight: '700',
                                      color: 'var(--accent-orange, #f97316)',
                                      background: 'rgba(249, 115, 22, 0.12)',
                                      padding: '1px 5px',
                                      borderRadius: '3px',
                                      border: '1px solid rgba(249, 115, 22, 0.25)',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '3px',
                                      width: 'fit-content',
                                    }}
                                    title={`Enfriamiento activo anti-revancha (${Math.ceil((row.cooldownRemainingMs ?? 0) / 60000)}m restantes). La terminal retiene la emisión para proteger el capital.`}
                                  >
                                    ⏳ Cooldown {Math.ceil((row.cooldownRemainingMs ?? 0) / 60000)}m
                                  </span>
                                )}
                                {row.isSessionClosingCandle && (
                                  <span
                                    style={{
                                      fontSize: '0.58rem',
                                      fontWeight: '700',
                                      color: 'var(--text-muted)',
                                      background: 'rgba(255, 255, 255, 0.05)',
                                      padding: '1px 5px',
                                      borderRadius: '3px',
                                      border: '1px solid rgba(255, 255, 255, 0.12)',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '3px',
                                      width: 'fit-content',
                                    }}
                                    title="Vela final de sesión regular en Wall Street. No se abren posiciones nuevas para evitar exposición a gaps nocturnos/de fin de semana."
                                  >
                                    🌙 Cierre Sesión
                                  </span>
                                )}
                              </div>
                            )}
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
                          <span
                            style={{
                              fontWeight: '700',
                              color: row.isMarketClosed
                                ? 'var(--text-muted)'
                                : (row.rvol >= 2.0 ? 'var(--accent-red)' : row.rvol >= 1.5 ? 'var(--accent-yellow)' : 'var(--text-secondary)'),
                            }}
                            title={row.isMarketClosed ? 'Mercado bursátil cerrado / Volumen del último cierre' : undefined}
                          >
                            {row.rvol}x {row.isMarketClosed ? '(Cierre)' : (row.rvol >= 2.0 ? '🔥' : row.rvol >= 1.5 ? '⚡' : '')}
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
                            {row.volatilityStatus === 'SQUEEZE'
                              ? `🟡 SQUEEZE (${row.bbPercentile}%)`
                              : row.volatilityStatus === 'EXPANSION'
                                ? `⚡ EXPANSIÓN (${row.bbPercentile}%)`
                                : `NORMAL (${row.bbPercentile}%)`}
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
                              title={
                                row.isOperationalViable === false && row.operationalReason
                                  ? `Abrir gráfico · Señal descartada por filtro operativo: ${row.operationalReason}`
                                  : ((isBuy || isSell) && row.activeStrategyLabel
                                      ? `Abrir gráfico · Señal ${row.overallSignal} vía ${row.activeStrategyLabel}${row.isFallbackSignal ? ' (Alternativa)' : ''}`
                                      : "Abrir en Gráfico de TradingView")
                              }
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
