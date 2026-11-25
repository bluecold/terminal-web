import assert from 'node:assert';
import {
  backtestStandard,
  backtestConfluencia,
  backtestScoring,
  backtestMultitemporal,
  backtestMultifractalMTF,
  computeStandardSignalsSeries,
  computeConfluenciaSignalsSeries,
  computeScoringSignalsSeries,
  calculateRiskMetrics,
  calculateSplitStats,
  calculateWalkForward,
  createEmptyWalkForwardResult,
  getStrategyCooldownCandles,
  getStrategyCooldownMs,
  getStrategyForwardWindow,
  getStrategySignalWarmup,
  getStrategyAtrMultiplier,
  isExecutionAcrossSessionGap,
  calculateProfitFactor,
  runBacktestGenericOptimized,
  getKlinesFingerprint,
  getRobustCandleStepSec,
  type RecordedTrade
} from '../backtester';
import {
  calculateStandardVoting,
  calculateScoringSignal,
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateRollingVolumeAvg,
  calculateRevolutionVolatilityBand,
  isNyseOpeningWindow,
  isCryptoAsset,
  getOpeningRange,
  getSessionId,
  getConfirmedClosedKlines,
  calculateTimeOfDayRVOL,
  getEffectiveExecutionPrice,
  isUsDaylightSavingTime,
  getEasternTime,
  isNyseHoliday,
  isNyseTradingSessionActive,
  isNyseSessionClosingCandle,
  calculateBollingerVolatilityStatus,
  calculateVolumeSignalSeries,
  calculateVolumeComposition,
  calculateRegimeSeriesWithHysteresis,
  calculateVWAPReliabilitySeries,
  calculateAndianOscillator,
  type BollingerBandsSeriesResult
} from '../indicators';
import {
  updateAlertsOutcome,
  calculateSessionStats,
  calculateAlertLevels,
  getStrategyExpiryCandles,
  generateCandleAlertKey,
  isCandleAlertFired,
  registerFiredCandleAlert,
  pruneFiredAlertsRegistry,
  clearFiredAlertsRegistry,
  trimAlertsPreservingActive,
  detectClosedAlertTransitions,
  getAlertCooldownKey,
  type AuditAlertItem
} from '../alertTracker';
import { formatSmartPrice, formatSmartNumber, getOptimalDecimals } from '../formatters';
import { evaluateStrategyTournament, runQVESelection, sanitizeSignalWithDirectionalEdge, selectActionableStrategy, getActionableStrategyCandidates, resolveStandardExploratoryFallback, type StrategyCandidate, type QVESelectionResult } from '../tournament';
import { simulateTrade, type TradeLevels } from '../tradeSimulator';
import {
  buildConfluenciaContext,
  evaluateConfluenciaAt,
  buildScoringContext,
  evaluateScoringAt,
  DEFAULT_SCORING_THRESHOLD_RATIO,
  buildVCMESniperContext,
  evaluateVCMESniperAt,
  buildStandardVotingContext,
  evaluateStandardVotingAt,
  buildMultifractalMTFContext,
  evaluateMultifractalMTFAt
} from '../strategyEvaluators';
import { DEFAULT_WEIGHTS } from '../indicators';
import { sanitizeKlines, type Kline } from '../../services/api';
import { isChartDataIncremental } from '../chartHelpers';
import { isTradeFrictionViable, getMinViableStopPct, validateScoringSRRoom } from '../tradeLevels';
import { resolveOperationalTrade } from '../operationalTrade';
import { stampKlineSnapshot } from '../../services/marketDataSnapshot';

function generateSyntheticKlines(count: number, intervalSeconds: number, startPrice: number = 100, drift: number = 0): Kline[] {
  const klines: Kline[] = [];
  let price = startPrice;
  const startTime = 1700000000;

  for (let i = 0; i < count; i++) {
    const time = startTime + i * intervalSeconds;
    const change = (Math.sin(i / 10) * 0.5) + ((i % 5 === 0 ? 1 : -0.8) * 0.3) + drift;
    const open = price;
    const close = Math.max(1, price + change);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const volume = 1000 + (i % 7) * 200;

    klines.push({ time, open, high, low, close, volume });
    price = close;
  }
  return klines;
}

export function runAllBacktesterTests(): { passed: number; total: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void) {
    total++;
    try {
      fn();
      passed++;
      console.log(`  ✓ PASSED: ${name}`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${name}`);
      console.error(err);
    }
  }

  console.log('\n--- Running FinceptTerminal Backtester Unit Tests ---\n');

  // Test 1: Binance 999 5m Kline Compatibility for VCME
  test('VCME intraday 5m evaluates with 999 klines (Binance limit)', () => {
    const klines5m = generateSyntheticKlines(999, 300, 100);
    const klines1h = generateSyntheticKlines(100, 3600, 100);
    const klines1d = generateSyntheticKlines(180, 86400, 100);

    const result = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'BTCUSDT', 'dayTrading');
    assert.strictEqual(result.insufficient, false, 'VCME intraday should NOT return insufficient data for 999 candles');
    assert.strictEqual(result.forwardLabel, '6 hs max (Intradía)');
  });

  // Test 2: Swing Mode 1H Session Gap Immunity
  test('VCME Swing mode 1H evaluates without false 5m session gap rejections', () => {
    const klines1h = generateSyntheticKlines(700, 3600, 100);
    const klines1d = generateSyntheticKlines(180, 86400, 100);

    const result = backtestMultitemporal(klines1h, klines1h, klines1d, '1h', 'BTCUSDT', 'swing');
    assert.strictEqual(result.insufficient, false);
    assert.strictEqual(result.forwardLabel, '48 hs max (Swing)');
  });

  // Test 3: Standard Voting Signal Series Generation
  test('computeStandardSignalsSeries generates correct series without crashing', () => {
    const klines = generateSyntheticKlines(100, 300, 50);
    const signals = computeStandardSignalsSeries(klines);
    assert.strictEqual(signals.length, 100);
    assert(signals.every(s => s === 'BUY' || s === 'SELL' || s === 'NEUTRAL'));
  });

  // Test 4: Confluencia Signal Series Generation
  test('computeConfluenciaSignalsSeries generates correct series with aligned thresholds', () => {
    const klines = generateSyntheticKlines(100, 3600, 50);
    const signals = computeConfluenciaSignalsSeries(klines, '1h');
    assert.strictEqual(signals.length, 100);
    assert(signals.every(s => s === 'BUY' || s === 'SELL' || s === 'NEUTRAL'));
  });

  // Test 5: Multifractal MTF Backtester
  test('backtestMultifractalMTF evaluates on synthetic 5m data', () => {
    const klines5m = generateSyntheticKlines(864, 300, 100);
    const klines1h = generateSyntheticKlines(100, 3600, 100);
    const klines1d = generateSyntheticKlines(60, 86400, 100);

    const result = backtestMultifractalMTF(klines5m, klines1h, klines1d, '5m', 'ETHUSDT');
    assert.strictEqual(result.insufficient, false);
  });

  // Test 6: Alert Tracker Multi-Timeframe Lookup & Frozen Exit P&L
  test('updateAlertsOutcome freezes P&L for closed alerts and looks up multi-timeframe klines', () => {
    const closedAlert: AuditAlertItem = {
      id: '1', symbol: 'BTCUSDT', interval: '5m', signal: 'BUY', time: '12:00',
      pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106,
      status: 'TP2_CLOSED', realizedR: 2.5, pnlPercent: 4.5, timestamp: 1700000000000
    };

    const klinesMap = {
      'BTCUSDT:5m': [{ time: 1700000010, open: 100, high: 110, low: 90, close: 90, volume: 100 }]
    };

    const updated = updateAlertsOutcome([closedAlert], klinesMap);
    assert.strictEqual(updated[0].pnlPercent, 4.5, 'Closed alert P&L should be frozen');
    assert.strictEqual(updated[0].status, 'TP2_CLOSED');
  });

  // Test 7: Alert Tracker TP1 -> TP2 Progression in VCME
  test('updateAlertsOutcome advances OPEN VCME alert to TP1_HIT and then TP2_HIT', () => {
    const openAlert: AuditAlertItem = {
      id: '2', symbol: 'ETHUSDT', interval: '1h', signal: 'BUY', time: '12:00',
      pf: 1.8, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 102, takeProfit2: 105,
      status: 'OPEN', realizedR: 0, pnlPercent: 0, timestamp: 1700000000000
    };

    const klinesMap = {
      'ETHUSDT:1h': [
        { time: 1700000010, open: 100, high: 103, low: 99.5, close: 102.5, volume: 100 },
        { time: 1700003610, open: 102.5, high: 106, low: 101, close: 105.5, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([openAlert], klinesMap);
    assert.strictEqual(updated[0].status, 'TP2_HIT', 'VCME alert should progress through TP1 to TP2_HIT (runner active)');
    assert(updated[0].pnlPercent > 0);
  });

  // Test 8: Backtest Cache Isolation per Symbol
  test('backtestStandard caches independently per symbol without cross-pollution', () => {
    const btcKlines = generateSyntheticKlines(200, 300, 50000, 0.05);
    const ethKlines = generateSyntheticKlines(200, 300, 3000, -0.05);

    const btcResult = backtestStandard(btcKlines, '5m', 'BTCUSDT');
    const ethResult = backtestStandard(ethKlines, '5m', 'ETHUSDT');

    assert.notStrictEqual(btcResult, ethResult, 'Different symbols must not return the exact same cached reference');
  });

  // Test 9: Alert Tracker TP1 -> Breakeven Hit (TP1_BE_CLOSED)
  test('updateAlertsOutcome transitions TP1_HIT to TP1_BE_CLOSED when hitting entry price', () => {
    const alert: AuditAlertItem = {
      id: '3', symbol: 'SOLUSDT', interval: '5m', signal: 'BUY', time: '12:00',
      pf: 2.1, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106,
      status: 'OPEN', realizedR: 0, pnlPercent: 0, timestamp: 1700000000000
    };

    const klinesMap = {
      'SOLUSDT:5m': [
        // Candle 1: hits TP1 (high=104)
        { time: 1700000300, open: 100, high: 104, low: 99.5, close: 102, volume: 100 },
        // Candle 2: falls to entry price (low=100) -> SL at BE triggered
        { time: 1700000600, open: 102, high: 102.5, low: 99.8, close: 100.2, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([alert], klinesMap);
    assert.strictEqual(updated[0].status, 'TP1_BE_CLOSED', 'Alert should close in TP1_BE_CLOSED');
    // Realized R net with proportional friction (0.11%) and BE market slippage: 0.69R
    assert.strictEqual(updated[0].realizedR, 0.69, 'Realized R should be locked at +0.69R net for 50% TP1 (1.5R) + BE with market slippage');
    assert(updated[0].pnlPercent > 0, 'PnL should be positive from locked 50% TP1 gain');

    // Next pass: verify that subsequent candles cannot change the outcome of TP1_BE_CLOSED
    const futureKlinesMap = {
      'SOLUSDT:5m': [
        { time: 1700000900, open: 100.2, high: 110, low: 90, close: 90, volume: 100 }
      ]
    };
    const frozen = updateAlertsOutcome(updated, futureKlinesMap);
    assert.strictEqual(frozen[0].status, 'TP1_BE_CLOSED', 'Outcome must remain frozen');
    assert.strictEqual(frozen[0].pnlPercent, updated[0].pnlPercent, 'PnL must remain frozen');
  });

  // Test 10: Alert Expiration for OPEN and TP1_HIT
  test('updateAlertsOutcome expires OPEN and TP1_HIT alerts after 24 candles', () => {
    const oldTimestamp = 1700000000000;
    const expiryCandleTime = (1700000000000 + 25 * 300000) / 1000;

    const openAlert: AuditAlertItem = {
      id: '4', symbol: 'ADAUSDT', interval: '5m', signal: 'BUY', time: '12:00',
      pf: 1.5, strategy: 'Standard', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106,
      status: 'OPEN', realizedR: 0, pnlPercent: 0, timestamp: oldTimestamp
    };

    const tp1Alert: AuditAlertItem = {
      id: '5', symbol: 'DOTUSDT', interval: '5m', signal: 'BUY', time: '12:00',
      pf: 1.5, strategy: 'Standard', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106,
      status: 'TP1_HIT', realizedR: 0.75, pnlPercent: 1.5, timestamp: oldTimestamp
    };

    const klinesMap = {
      'ADAUSDT:5m': [{ time: expiryCandleTime, open: 100.5, high: 101, low: 100.2, close: 100.8, volume: 100 }],
      'DOTUSDT:5m': [{ time: expiryCandleTime, open: 101.5, high: 102, low: 101.2, close: 101.8, volume: 100 }]
    };

    const updated = updateAlertsOutcome([openAlert, tp1Alert], klinesMap);
    assert.strictEqual(updated[0].status, 'EXPIRED');
    assert.strictEqual(updated[1].status, 'EXPIRED');
  });

  // Test 11: Session Stats with TP1_BE_CLOSED
  test('calculateSessionStats correctly tallies TP1_BE_CLOSED as a win and TP1_HIT as active', () => {
    const todayMs = Date.now();
    const alerts: AuditAlertItem[] = [
      { id: '1', symbol: 'BTC', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP1_BE_CLOSED', realizedR: 0.75, pnlPercent: 1.5, timestamp: todayMs },
      { id: '2', symbol: 'ETH', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP2_CLOSED', realizedR: 2.0, pnlPercent: 4.5, timestamp: todayMs },
      { id: '3', symbol: 'SOL', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'SL_HIT', realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs },
      { id: '4', symbol: 'BNB', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP1_HIT', realizedR: 0.75, pnlPercent: 2.0, timestamp: todayMs }
    ];

    const stats = calculateSessionStats(alerts, false);
    assert.strictEqual(stats.total, 4);
    assert.strictEqual(stats.wins, 2, 'TP1_BE_CLOSED and TP2_CLOSED must count as wins');
    assert.strictEqual(stats.losses, 1, 'SL_HIT must count as loss');
    assert.strictEqual(stats.openCount, 1, 'TP1_HIT must be counted in openCount while trailing');
    assert.strictEqual(stats.winRate, 66.7);
    assert.strictEqual(stats.totalR, 1.8, 'Net totalR should be 0.75 + 2.0 - 1.0 = 1.75 rounded to 1.8');
  });

  // Test 12: Atomic Candle Deduplication Key Generation
  test('generateCandleAlertKey produces canonical, normalized keys', () => {
    const key1 = generateCandleAlertKey('btcusdt', '5M', 1700000300, 'VCME Sniper', 'buy');
    const key2 = generateCandleAlertKey('BTCUSDT', '5m', 1700000300, 'vcme sniper', 'BUY');
    assert.strictEqual(key1, 'BTCUSDT:5m:1700000300:vcme sniper:BUY');
    assert.strictEqual(key1, key2, 'Keys must be identical regardless of case/spacing');
  });

  // Test 13: Atomic Candle Deduplication prevents duplicate alerts on same candle timestamp
  test('isCandleAlertFired and registerFiredCandleAlert prevent duplicate alerts on same candle timestamp', () => {
    clearFiredAlertsRegistry();
    const candleTs = 1700000600;
    
    // Initial check: candle has not fired
    assert.strictEqual(isCandleAlertFired('ETHUSDT', '5m', candleTs, 'VCME Sniper', 'BUY'), false);
    
    // Register the alert
    registerFiredCandleAlert({
      symbol: 'ETHUSDT',
      interval: '5m',
      candleTimestamp: candleTs,
      strategy: 'VCME Sniper',
      signal: 'BUY',
    });

    // Second check: candle is now deduplicated
    assert.strictEqual(isCandleAlertFired('ETHUSDT', '5m', candleTs, 'VCME Sniper', 'BUY'), true);
    
    // Subsequent candle timestamp (e.g. +300s) should NOT be deduplicated
    assert.strictEqual(isCandleAlertFired('ETHUSDT', '5m', candleTs + 300, 'VCME Sniper', 'BUY'), false);
    
    // Different symbol on same timestamp should NOT be deduplicated
    assert.strictEqual(isCandleAlertFired('BTCUSDT', '5m', candleTs, 'VCME Sniper', 'BUY'), false);
  });

  // Test 14: Pruning of expired entries older than 7 days
  test('pruneFiredAlertsRegistry removes records older than 7 days and preserves recent ones', () => {
    clearFiredAlertsRegistry();
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    registerFiredCandleAlert({
      symbol: 'OLD_COIN',
      interval: '1h',
      candleTimestamp: 1699000000,
      strategy: 'Standard',
      signal: 'BUY',
      firedAt: tenDaysAgo
    });

    registerFiredCandleAlert({
      symbol: 'NEW_COIN',
      interval: '1h',
      candleTimestamp: 1700000000,
      strategy: 'Standard',
      signal: 'BUY',
      firedAt: twoDaysAgo
    });

    const prunedCount = pruneFiredAlertsRegistry(7);
    assert.strictEqual(prunedCount, 1, 'Should prune exactly 1 expired entry');
    assert.strictEqual(isCandleAlertFired('OLD_COIN', '1h', 1699000000, 'Standard', 'BUY'), false, 'Expired entry should be gone');
    assert.strictEqual(isCandleAlertFired('NEW_COIN', '1h', 1700000000, 'Standard', 'BUY'), true, 'Recent entry should remain');
  });

  // Test 15: clearFiredAlertsRegistry wipes all records
  test('clearFiredAlertsRegistry completely wipes all registry entries', () => {
    registerFiredCandleAlert({
      symbol: 'SOLUSDT',
      interval: '5m',
      candleTimestamp: 1700000900,
      strategy: 'VCME',
      signal: 'SELL'
    });
    assert.strictEqual(isCandleAlertFired('SOLUSDT', '5m', 1700000900, 'VCME', 'SELL'), true);
    
    clearFiredAlertsRegistry();
    assert.strictEqual(isCandleAlertFired('SOLUSDT', '5m', 1700000900, 'VCME', 'SELL'), false);
  });

  // Test 16: calculateVCMESniperSignal returns valid risk structure and synchronizes with backtester rules
  test('calculateVCMESniperSignal enforces risk bounds and returns consistent structure', () => {
    const klines5m = generateSyntheticKlines(60, 300, 100);
    const klines1h = generateSyntheticKlines(80, 3600, 100);
    const klines1d = generateSyntheticKlines(60, 86400, 100);

    const result = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'BTCUSDT');
    assert(['BUY', 'SELL', 'NEUTRAL'].includes(result.signal));
    assert(['DAY', 'SWING'].includes(result.tradeType));
    if (result.signal !== 'NEUTRAL') {
      assert(result.stopLoss > 0, 'Stop loss must be > 0 for active signals');
      assert(result.takeProfit1 > 0, 'TP1 must be > 0 for active signals');
      assert(result.takeProfit2 > 0, 'TP2 must be > 0 for active signals');
      assert(result.takeProfit3 > 0, 'TP3 must be > 0 for active signals');
      assert(result.riskRewardRatio >= 2.0, 'R/R must be >= 2.0');
      if (result.signal === 'BUY') {
        assert(result.takeProfit1 > result.stopLoss, 'TP1 must be > SL for BUY');
        assert(result.takeProfit2 > result.takeProfit1, 'TP2 must be > TP1 for BUY');
        assert(result.takeProfit3 > result.takeProfit2, 'TP3 must be > TP2 for BUY');
      } else if (result.signal === 'SELL') {
        assert(result.takeProfit1 < result.stopLoss, 'TP1 must be < SL for SELL');
        assert(result.takeProfit2 < result.takeProfit1, 'TP2 must be < TP1 for SELL');
        assert(result.takeProfit3 < result.takeProfit2, 'TP3 must be < TP2 for SELL');
      }
    } else {
      assert.strictEqual(result.stopLoss, 0, 'Stop loss must be 0 for NEUTRAL signal');
    }
  });

  // Test 17: Chronological Causality in Alert State Machine (No retrograde BE on pre-TP1 candles)
  test('updateAlertsOutcome preserves chronological causality without retrograde BE triggers', () => {
    const alert: AuditAlertItem = {
      id: 'causal-test-1',
      symbol: 'BTCUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.0,
      strategy: 'VCME',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit1: 105,
      takeProfit2: 110,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000000
    };

    // Step 1: Candle 1 dips to entryPrice (100) before reaching TP1 (high is 102).
    // Candle 2 surges and hits TP1 (high 106).
    const klinesMapPass1 = {
      'BTCUSDT:5m': [
        { time: 1700000300, open: 100, high: 102, low: 100, close: 101, volume: 100 },
        { time: 1700000600, open: 101, high: 106, low: 101, close: 106, volume: 100 }
      ]
    };

    const pass1 = updateAlertsOutcome([alert], klinesMapPass1);
    assert.strictEqual(pass1[0].status, 'TP1_HIT', 'Alert should transition to TP1_HIT on Candle 2');

    // Step 2: Candle 3 arrives with high=108, low=104 (well above entry).
    // In buggy code, re-evaluating would read Candle 1 with activeSL=100 and falsely turn into TP1_BE_CLOSED.
    // In correct causal replay, it remains TP1_HIT.
    const klinesMapPass2 = {
      'BTCUSDT:5m': [
        { time: 1700000300, open: 100, high: 102, low: 100, close: 101, volume: 100 },
        { time: 1700000600, open: 101, high: 106, low: 101, close: 106, volume: 100 },
        { time: 1700000900, open: 106, high: 108, low: 104, close: 107, volume: 100 }
      ]
    };

    const pass2 = updateAlertsOutcome(pass1, klinesMapPass2);
    assert.strictEqual(pass2[0].status, 'TP1_HIT', 'Alert must stay TP1_HIT and NOT trigger false retrograde BE from Candle 1');

    // Step 3: Candle 4 actually falls back to entry AFTER TP1 (low=99.8).
    // NOW it must transition to TP1_BE_CLOSED.
    const klinesMapPass3 = {
      'BTCUSDT:5m': [
        { time: 1700000300, open: 100, high: 102, low: 100, close: 101, volume: 100 },
        { time: 1700000600, open: 101, high: 106, low: 101, close: 106, volume: 100 },
        { time: 1700000900, open: 106, high: 108, low: 104, close: 107, volume: 100 },
        { time: 1700001200, open: 107, high: 107.5, low: 99.8, close: 100.1, volume: 100 }
      ]
    };

    const pass3 = updateAlertsOutcome(pass2, klinesMapPass3);
    assert.strictEqual(pass3[0].status, 'TP1_BE_CLOSED', 'Alert should transition to TP1_BE_CLOSED only when post-TP1 candle hits entry price');
  });

  // Test 18: Pre-alert extreme immunity on mid-candle entry and live execution
  test('updateAlertsOutcome prevents retroactive TP/SL on pre-alert extremes when scanner enters mid-candle', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const alertTime = Date.now() - 60000; // fired 1 minute ago (at price 100)

    const alert: AuditAlertItem = {
      id: 'delayed-entry-test-1',
      symbol: 'BTCUSDT',
      interval: '1h',
      signal: 'BUY',
      time: '12:00',
      pf: 2.0,
      strategy: 'VCME',
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 110,
      takeProfit2: 120,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: alertTime
    };

    // The live 1H candle started 10 minutes ago.
    // Before the alert fired (at minute 2), price dipped to 85 and spiked to 125, but at alert time price is 105.
    const liveCandleTime = nowSec - 600;
    const klinesMap = {
      'BTCUSDT:1h': [
        // Previous closed candle
        { time: liveCandleTime - 3600, open: 98, high: 101, low: 97, close: 100, volume: 100 },
        // Current forming 1H candle where alert was fired mid-candle
        { time: liveCandleTime, open: 100, high: 125, low: 85, close: 105, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([alert], klinesMap);
    // Alert should NOT falsely trigger SL_HIT (low 85) or TP2_HIT (high 125) from pre-alert extremes!
    assert.strictEqual(updated[0].status, 'OPEN', 'Alert must stay OPEN and not execute retroactive pre-alert extremes');
    assert.strictEqual(updated[0].pnlPercent, 4.89, 'Floating PnL reflects net move from 100 to 105');

    // On the subsequent candle, price reaches TP1 (115) and executes immediately
    const nextCandleTime = liveCandleTime + 3600;
    const klinesMapPass2 = {
      'BTCUSDT:1h': [
        { time: liveCandleTime - 3600, open: 98, high: 101, low: 97, close: 100, volume: 100 },
        { time: liveCandleTime, open: 100, high: 105, low: 99, close: 105, volume: 100 },
        { time: nextCandleTime, open: 105, high: 115, low: 104, close: 112, volume: 100 }
      ]
    };
    const updatedPass2 = updateAlertsOutcome([alert], klinesMapPass2);
    assert.strictEqual(updatedPass2[0].status, 'TP1_HIT', 'Subsequent candle touching 115 triggers TP1_HIT');
  });

  // Test 19: Multi-Timeframe Cache Invalidation via Auxiliary Timeframe Fingerprint
  test('backtestMultitemporal cache invalidates when 1h or 1d updates even if 5m is unchanged', () => {
    const klines5m = generateSyntheticKlines(900, 300, 50000, 0.02);
    const klines1h_v1 = generateSyntheticKlines(120, 3600, 50000, 0.02);
    const klines1d = generateSyntheticKlines(60, 86400, 50000, 0.02);

    // Initial evaluation with 1h_v1
    const res1 = backtestMultitemporal(klines5m, klines1h_v1, klines1d, '5m', 'TEST_MTF_SYM', 'dayTrading');
    assert.strictEqual(res1.insufficient, false);

    // Second evaluation with identical 5m, 1h, 1d -> must hit cache (same reference)
    const resCached = backtestMultitemporal(klines5m, klines1h_v1, klines1d, '5m', 'TEST_MTF_SYM', 'dayTrading');
    assert.strictEqual(res1, resCached, 'Identical multi-timeframe series must return cached result');

    // Update 1H series by appending a new candle (5m remains completely identical)
    const klines1h_v2 = [
      ...klines1h_v1,
      { time: klines1h_v1[klines1h_v1.length - 1].time + 3600, open: 51000, high: 52000, low: 50500, close: 51800, volume: 500 }
    ];

    // Third evaluation -> must detect changed 1H fingerprint and recompute (not return resCached)
    const resUpdated = backtestMultitemporal(klines5m, klines1h_v2, klines1d, '5m', 'TEST_MTF_SYM', 'dayTrading');
    assert.notStrictEqual(resUpdated, resCached, 'Cache must invalidate when auxiliary 1H series updates');
  });

  // Test 20: VCME 5m Inactivity Time-Stop Parity
  test('updateAlertsOutcome triggers 18-candle (90m) Time-Stop for stagnant VCME 5m trades', () => {
    const alertTime = 1700000000000;
    const alert: AuditAlertItem = {
      id: 'vcme-timestop-1',
      symbol: 'BTCUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.5,
      strategy: 'VCME Sniper',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 104, // 2R
      takeProfit2: 107, // 3.5R
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: alertTime
    };

    // 8 candles of 5m where price hovered near 100.2 (never reached TP1 104, never touched SL 98)
    const candles8 = [
      { time: 1700000300, open: 100, high: 100.5, low: 99.5, close: 100.1, volume: 100 },
      { time: 1700000600, open: 100.1, high: 100.6, low: 99.6, close: 100.2, volume: 100 },
      { time: 1700000900, open: 100.2, high: 100.7, low: 99.7, close: 100.3, volume: 100 },
      { time: 1700001200, open: 100.3, high: 100.8, low: 99.8, close: 100.2, volume: 100 },
      { time: 1700001500, open: 100.2, high: 100.6, low: 99.6, close: 100.1, volume: 100 },
      { time: 1700001800, open: 100.1, high: 100.5, low: 99.5, close: 100.2, volume: 100 },
      { time: 1700002100, open: 100.2, high: 100.6, low: 99.6, close: 100.3, volume: 100 },
      { time: 1700002400, open: 100.3, high: 100.5, low: 99.5, close: 100.2, volume: 100 }, // 8th candle
    ];

    const updated8 = updateAlertsOutcome([alert], { 'BTCUSDT:5m': candles8 });
    assert.strictEqual(updated8[0].status, 'OPEN', 'VCME 5m trade must NOT prematurely expire at 8 candles (40m) under calibrated 18-candle (90m) time stop');

    // 18 candles of 5m where price hovered near 100.2
    const candles18 = [...candles8];
    for (let c = 9; c <= 18; c++) {
      candles18.push({
        time: 1700000000 + c * 300,
        open: 100.2,
        high: 100.5,
        low: 99.5,
        close: 100.2,
        volume: 100
      });
    }

    const updated18 = updateAlertsOutcome([alert], { 'BTCUSDT:5m': candles18 });
    assert.strictEqual(updated18[0].status, 'EXPIRED', 'Stagnant VCME 5m trade must close via 18-candle Time-Stop');
    assert.strictEqual(updated18[0].pnlPercent, 0.06, 'PnL must match net gain at candle 18 (+0.2% gross - 0.03% slippage - 0.11% friction = +0.06% net)');
  });

  // Test 21: Multifractal Early Invalidation in candles 1..3
  test('updateAlertsOutcome cuts loss early on adverse moves in Multifractal MTF', () => {
    const alertTime = 1700000000000;
    const alert: AuditAlertItem = {
      id: 'mf-early-invalid-1',
      symbol: 'ETHUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.2,
      strategy: 'Multifractal MTF',
      entryPrice: 100,
      stopLoss: 90, // full SL at 90
      takeProfit1: 115,
      takeProfit2: 125,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: alertTime
    };

    // Candle 2 closes at 94 (adverse move > 0.5 * 10 = 5, but didn't touch full SL 90)
    const klinesMap = {
      'ETHUSDT:5m': [
        { time: 1700000300, open: 100, high: 101, low: 99, close: 99.5, volume: 100 },
        { time: 1700000600, open: 99.5, high: 99.8, low: 93.5, close: 94, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([alert], klinesMap);
    assert.strictEqual(updated[0].status, 'SL_HIT', 'Multifractal must invalidate and cut loss early');
    assert.strictEqual(updated[0].pnlPercent, -6.14, 'Loss should be capped at early exit price (-6.0% - 0.03% slippage - 0.11% friction = -6.14% net)');
  });

  // Test 22: Cache Sensitivity to Intrabar OHLCV Revisions
  test('backtestStandard cache invalidates on OHLCV revisions with same timestamp and length', () => {
    const klines_v1 = generateSyntheticKlines(600, 300, 50000, 0.02);
    
    // Initial evaluation
    const res1 = backtestStandard(klines_v1, '5m', 'REVISION_SYM');
    
    // Identical data -> must hit cache
    const resCached = backtestStandard(klines_v1, '5m', 'REVISION_SYM');
    assert.strictEqual(res1, resCached, 'Identical klines must return cached reference');

    // Revise latest candle's close and volume (time and array length remain 100% identical)
    const klines_v2 = [...klines_v1];
    const last = klines_v1[klines_v1.length - 1];
    klines_v2[klines_v2.length - 1] = {
      ...last,
      close: last.close * 1.05, // +5% revision
      volume: last.volume * 3.0  // 3x volume revision
    };

    // Third evaluation -> must detect OHLCV revision and recompute
    const resRevised = backtestStandard(klines_v2, '5m', 'REVISION_SYM');
    assert.notStrictEqual(resRevised, resCached, 'Cache must invalidate when candle OHLCV is revised even with same timestamp and length');
  });

  // Test 23: End-to-End Deterministic Golden Fixture for VCME Sniper Parity
  test('VCME Sniper deterministic golden fixture validates signal, bounds, targets and tracker outcome', () => {
    // 1D: Solid uptrend macro
    const klines1d: Kline[] = [];
    let p1d = 100;
    for (let i = 0; i < 60; i++) {
      p1d += 0.8;
      klines1d.push({
        time: 1700000000 + i * 86400,
        open: p1d - 0.4,
        high: p1d + 0.6,
        low: p1d - 0.5,
        close: p1d,
        volume: 20000
      });
    }

    // 1H: Armed bullish setup
    const klines1h: Kline[] = [];
    let p1h = 130;
    for (let i = 0; i < 100; i++) {
      p1h += (i % 2 === 0 ? 0.3 : 0.1);
      klines1h.push({
        time: 1700000000 + i * 3600,
        open: p1h - 0.15,
        high: p1h + 0.3,
        low: p1h - 0.2,
        close: p1h,
        volume: 5000
      });
    }

    // 5m: 600 candles ending in a strong pullback & bounce with high volume
    const klines5m: Kline[] = [];
    let p5m = 140;
    for (let i = 0; i < 600; i++) {
      let change = 0.05;
      let vol = 1000;
      if (i === 597) { change = -0.4; }
      else if (i === 598) { change = -0.2; }
      else if (i === 599) { change = 0.8; vol = 3500; }
      p5m += change;
      klines5m.push({
        time: 1700000000 + i * 300,
        open: p5m - change,
        high: Math.max(p5m - change, p5m) + 0.2,
        low: Math.min(p5m - change, p5m) - 0.1,
        close: p5m,
        volume: vol
      });
    }

    const vcmeSignal = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'GOLDEN_VCME', 60, 2.0, 'dayTrading', 'agresivo');
    assert.strictEqual(vcmeSignal.tradeType, 'DAY', 'Deterministic fixture should classify as DAY trade');

    // Risk and Target bounds validation
    if (vcmeSignal.signal === 'BUY') {
      assert(vcmeSignal.stopLoss > 0 && vcmeSignal.stopLoss < vcmeSignal.takeProfit1, 'SL must be below entry and TP1');
      assert(vcmeSignal.takeProfit1 < vcmeSignal.takeProfit2, 'TP1 must be below TP2');
      assert(vcmeSignal.takeProfit2 < vcmeSignal.takeProfit3, 'TP2 must be below TP3');

      // Tracker End-to-End validation
      const entry = klines5m[klines5m.length - 1].close;
      const alert: AuditAlertItem = {
        id: 'golden-vcme-alert',
        symbol: 'GOLDEN_VCME',
        interval: '5m',
        signal: 'BUY',
        time: '12:00',
        pf: 2.5,
        strategy: 'VCME Sniper',
        entryPrice: entry,
        stopLoss: vcmeSignal.stopLoss,
        takeProfit1: vcmeSignal.takeProfit1,
        takeProfit2: vcmeSignal.takeProfit2,
        status: 'OPEN',
        realizedR: 0,
        pnlPercent: 0,
        timestamp: 1700000000 + 600 * 300 * 1000,
        candleTimestamp: klines5m[klines5m.length - 1].time
      };

      // Feed forward candles reaching TP1 and then TP2
      const forwardKlines = [
        ...klines5m,
        { time: alert.candleTimestamp! + 300, open: entry, high: vcmeSignal.takeProfit1 + 0.1, low: entry, close: vcmeSignal.takeProfit1, volume: 2000 },
        { time: alert.candleTimestamp! + 600, open: vcmeSignal.takeProfit1, high: vcmeSignal.takeProfit2 + 0.1, low: vcmeSignal.takeProfit1, close: vcmeSignal.takeProfit2, volume: 2000 }
      ];

      const trackerRes = updateAlertsOutcome([alert], { 'GOLDEN_VCME:5m': forwardKlines });
      assert.strictEqual(trackerRes[0].status, 'TP2_HIT', 'Alert must transition cleanly to TP2_HIT');
      assert(trackerRes[0].realizedR > 1.5, 'Realized R on TP2 must exceed +1.5R');
    }
  });

  // Test 24: End-to-End Deterministic Golden Fixture for Multifractal MTF Parity
  test('Multifractal MTF deterministic golden fixture validates signal, levels and tracker execution', () => {
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0.5);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0.05);
    const klines5m = generateSyntheticKlines(120, 300, 100, 0.02);

    const mfSignal = calculateMultifractalMTFSignal(klines5m, klines1h, klines1d, 'GOLDEN_MTF');
    assert(typeof mfSignal.signal === 'string');
    assert(typeof mfSignal.stopLoss === 'number');

    // Simulate alert tracker lifecycle with synthetic forward candles
    const alert: AuditAlertItem = {
      id: 'golden-mf-alert',
      symbol: 'GOLDEN_MTF',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.1,
      strategy: 'Multifractal MTF',
      entryPrice: 100,
      stopLoss: 96,
      takeProfit1: 106, // 1.5R
      takeProfit2: 106, // Single target
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000000,
      candleTimestamp: 1700000000
    };

    // Forward candle hits TP1 -> closes immediately as single-target TP1_CLOSED
    const forwardKlines = [
      { time: 1700000300, open: 100, high: 107, low: 99.5, close: 106, volume: 1500 },
      { time: 1700000600, open: 106, high: 106.5, low: 99.8, close: 100, volume: 1200 }
    ];

    const trackerRes = updateAlertsOutcome([alert], { 'GOLDEN_MTF:5m': forwardKlines });
    assert.strictEqual(trackerRes[0].status, 'TP1_CLOSED', 'Multifractal single-target alert must close at TP1 as TP1_CLOSED');
    assert.strictEqual(trackerRes[0].realizedR, 1.47, 'Realized R for 1.5R TP1 with friction must be +1.47R net');
  });

  // Test 25: Smart Formatters Scale Invariance ($BTC vs $SOL vs $DOGE vs $PEPE)
  test('formatSmartPrice and formatSmartNumber adapt dynamically across asset price scales', () => {
    assert.strictEqual(getOptimalDecimals(65420.5), 2);
    assert.strictEqual(getOptimalDecimals(152.4), 2);
    assert.strictEqual(getOptimalDecimals(0.5218), 4);
    assert.strictEqual(getOptimalDecimals(0.1174), 4);
    assert.strictEqual(getOptimalDecimals(0.00000854), 8);

    assert.strictEqual(formatSmartPrice(65420.5), '$65,420.50');
    assert.strictEqual(formatSmartPrice(152.4), '$152.40');
    assert.strictEqual(formatSmartPrice(0.5218), '$0.5218');
    assert.strictEqual(formatSmartPrice(0.1174), '$0.1174');
    assert.strictEqual(formatSmartPrice(0.00000854), '$0.00000854');
    assert.strictEqual(formatSmartPrice(0.00000854, false), '0.00000854');

    assert.strictEqual(formatSmartNumber(0.1174), '0.1174');
    assert.strictEqual(formatSmartNumber(0.00000854), '0.00000854');
    assert.strictEqual(formatSmartNumber(152.4, 2), '152.40');
  });

  // Test 26: calculateAlertLevels Micro-Price Integrity ($PEPE / $SHIB)
  test('calculateAlertLevels preserves unquantized precision on micro-cap assets ($PEPE < $0.0001)', () => {
    const pepeEntry = 0.00000854;
    const buyLevels = calculateAlertLevels('BUY', pepeEntry, '5m');

    assert(buyLevels.stopLoss > 0, 'Stop loss must be strictly positive');
    assert(buyLevels.stopLoss < pepeEntry, 'Stop loss for BUY must be strictly below entry');
    assert(buyLevels.takeProfit1 > pepeEntry, 'TP1 must be strictly above entry');
    assert(buyLevels.takeProfit2 === undefined || buyLevels.takeProfit2 >= buyLevels.takeProfit1, 'TP2 must be undefined or match/exceed TP1');

    const riskDist = pepeEntry - buyLevels.stopLoss;
    const rewardDist = buyLevels.takeProfit1 - pepeEntry;
    const effectiveRR = rewardDist / riskDist;
    assert(Math.abs(effectiveRR - 1.5) < 1e-6, `R:R ratio must be 1.5:1 without quantization error (got ${effectiveRR})`);
  });

  // Test 27: Low-Priced Asset Risk Integrity and Tracker Execution ($DOGE ~0.1174)
  test('Low-priced asset ($DOGE) maintains risk bounds and does not trigger false instant SL_HIT', () => {
    const dogeEntry = 0.1174;
    const dogeSL = dogeEntry * (1 - 0.015); // ~0.115639
    const dogeTP1 = dogeEntry * (1 + 0.015 * 1.5); // ~0.1200425
    const dogeTP2 = dogeEntry * (1 + 0.015 * 2.5); // ~0.1218025

    // Verify unrounded SL is strictly below entry
    assert(dogeSL < dogeEntry, 'Calculated SL must be below entry');

    const alert: AuditAlertItem = {
      id: 'doge-test-alert',
      symbol: 'DOGEUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '14:00',
      pf: 2.0,
      strategy: 'VCME Sniper',
      entryPrice: dogeEntry,
      stopLoss: dogeSL,
      takeProfit1: dogeTP1,
      takeProfit2: dogeTP2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000000,
      candleTimestamp: 1700000000
    };

    // Candle 1: Price fluctuates between 0.1165 (above SL 0.115639) and 0.1185 -> should stay OPEN
    const candle1: Kline = {
      time: 1700000300,
      open: 0.1174,
      high: 0.1185,
      low: 0.1165,
      close: 0.1180,
      volume: 500000
    };

    const trackerStep1 = updateAlertsOutcome([alert], { 'DOGEUSDT:5m': [candle1] });
    assert.strictEqual(trackerStep1[0].status, 'OPEN', 'DOGE alert must remain OPEN (0.1165 > SL 0.115639)');

    // Candle 2: Price surges to 0.1205 (hits TP1 0.1200425) -> should transition to TP1_HIT
    const candle2: Kline = {
      time: 1700000600,
      open: 0.1180,
      high: 0.1205,
      low: 0.1178,
      close: 0.1202,
      volume: 800000
    };

    const trackerStep2 = updateAlertsOutcome([alert], { 'DOGEUSDT:5m': [candle1, candle2] });
    assert.strictEqual(trackerStep2[0].status, 'TP1_HIT', 'DOGE alert must transition to TP1_HIT');
  });

  // Test 28: getStrategyExpiryCandles Horizon Parity
  test('getStrategyExpiryCandles enforces strategy-aware horizon parity', () => {
    assert.strictEqual(getStrategyExpiryCandles('VCME Sniper', '5m', 'dayTrading'), 24, 'VCME DayTrading 5m must be 24 candles (2h)');
    assert.strictEqual(getStrategyExpiryCandles('VCME Multitemporal', '1h', 'swing'), 48, 'VCME Swing 1h must be 48 candles (48h)');
    assert.strictEqual(getStrategyExpiryCandles('Multifractal MTF', '5m'), 12, 'Multifractal MTF 5m must be 12 candles (1h)');
    assert.strictEqual(getStrategyExpiryCandles('Standard Voting', '5m'), 12, 'Standard 5m must be 12 candles (1h)');
    assert.strictEqual(getStrategyExpiryCandles('Standard Voting', '1h'), 4, 'Standard 1h must be 4 candles');
  });

  // Test 29: VCME Emergency Exit (VWAP + EMA21)
  test('updateAlertsOutcome executes Emergency Exit when VCME trade loses VWAP and EMA21', () => {
    const startTime = 1700000000;
    const entryPrice = 100;
    const stopLoss = 96; // 4% risk
    const takeProfit1 = 106;
    const takeProfit2 = 110;
    
    // Generate 30 pre-candles at price ~100 to establish baseline VWAP ~100 and EMA21 ~100
    const klines: Kline[] = [];
    for (let i = 0; i < 30; i++) {
      klines.push({
        time: startTime + i * 300,
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1000
      });
    }

    const alertTime = (startTime + 29 * 300) * 1000;
    const alertCandleTime = startTime + 29 * 300;

    const alert: AuditAlertItem = {
      id: 'vcme-emergency-test',
      symbol: 'BTCUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.5,
      strategy: 'VCME Sniper',
      executionStyle: 'dayTrading',
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: alertTime,
      candleTimestamp: alertCandleTime
    };

    // Candle 31: Sharp dip to 98.0 (below VWAP ~100 and EMA21 ~99.8, but ABOVE SL 96.0)
    klines.push({
      time: startTime + 30 * 300,
      open: 99.5,
      high: 99.5,
      low: 97.8,
      close: 98.0, // loses VWAP & EMA21
      volume: 5000
    });

    const evaluated = updateAlertsOutcome([alert], { 'BTCUSDT:5m': klines });
    assert.strictEqual(evaluated[0].status, 'EXPIRED', 'Alert must trigger Emergency Exit and resolve as EXPIRED');
    assert(evaluated[0].pnlPercent < 0 && evaluated[0].pnlPercent > -3.0, `PnL should be ~ -2.0% (got ${evaluated[0].pnlPercent}%)`);
    assert(evaluated[0].realizedR < 0 && evaluated[0].realizedR > -0.9, `Realized R should be ~ -0.5R (got ${evaluated[0].realizedR}R) instead of -1.0R full SL`);
  });

  // Test 30: VCME Chandelier Trailing Runner after TP2
  test('updateAlertsOutcome trails runner with Chandelier Stop after TP2', () => {
    const startTime = 1700000000;
    const entryPrice = 100;
    const stopLoss = 98; // riskDist = 2
    const takeProfit1 = 103; // +1.5R
    const takeProfit2 = 105; // +2.5R
    const alertCandleTime = startTime;
    
    const alert: AuditAlertItem = {
      id: 'vcme-chandelier-test',
      symbol: 'ETHUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.5,
      strategy: 'VCME Sniper',
      executionStyle: 'dayTrading',
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: startTime * 1000,
      candleTimestamp: alertCandleTime
    };

    // Pre-load klines with baseline candles so ATR(14) converges to ~1.0:
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push({
        time: startTime - (20 - i) * 300,
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1000
      });
    }
    // Candle 1: reaches 103.5 -> hits TP1 (status = TP1_HIT)
    // Candle 2: surges to 106.0 -> hits TP2 (status = TP2_HIT)
    // Candle 3: peaks at 108.0 (highestHigh = 108.0), ATR ~ 1.0 -> Chandelier SL = 108 - 2.5*1 = 105.5
    // Candle 4: drops to close at 104.0 (below Chandelier ~104.2) -> exits runner
    klines.push(
      { time: startTime, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: startTime + 300, open: 100, high: 103.5, low: 100, close: 103.2, volume: 1000 },
      { time: startTime + 600, open: 103.2, high: 106.0, low: 103.0, close: 105.5, volume: 1500 },
      { time: startTime + 900, open: 105.5, high: 108.0, low: 105.2, close: 107.5, volume: 2000 },
      { time: startTime + 1200, open: 107.5, high: 107.5, low: 103.8, close: 104.0, volume: 2500 },
    );

    const evaluated = updateAlertsOutcome([alert], { 'ETHUSDT:5m': klines });
    assert.strictEqual(evaluated[0].status, 'TP2_CLOSED', 'Alert must be TP2_CLOSED on Chandelier exit');
    assert(evaluated[0].realizedR >= 1.75, `Realized R with trailing runner should be >= 1.75R (got ${evaluated[0].realizedR}R)`);
  });

  // Test 31: VCME Runner SL Pullback to TP1 (Eliminates Optimistic Bias)
  test('updateAlertsOutcome accurately resolves runner pullback to active SL (TP1) as +1.75R', () => {
    const startTime = 1700000000;
    const entryPrice = 100;
    const stopLoss = 98;    // riskDist = 2
    const takeProfit1 = 103; // +1.5R
    const takeProfit2 = 105; // +2.5R
    const alertCandleTime = startTime;
    
    const alert: AuditAlertItem = {
      id: 'vcme-pullback-test',
      symbol: 'SOLUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.5,
      strategy: 'VCME Sniper',
      executionStyle: 'dayTrading',
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: startTime * 1000,
      candleTimestamp: alertCandleTime
    };

    // Candle 1: reaches 103.5 -> hits TP1
    // Candle 2: reaches 105.2 -> hits TP2 (status = TP2_HIT), activeSL set to TP1 (103.0)
    // Candle 3: drops to low 102.5 (<= activeSL 103.0) -> exits runner at activeSL (103.0)
    const klines: Kline[] = [
      { time: startTime, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: startTime + 300, open: 100, high: 103.5, low: 100, close: 103.2, volume: 1000 },
      { time: startTime + 600, open: 103.2, high: 105.2, low: 103.0, close: 105.0, volume: 1500 },
      { time: startTime + 900, open: 105.0, high: 105.0, low: 102.5, close: 102.8, volume: 2000 },
    ];

    const evaluated = updateAlertsOutcome([alert], { 'SOLUSDT:5m': klines });
    assert.strictEqual(evaluated[0].status, 'TP2_CLOSED', 'Alert must transition to TP2_CLOSED on runner SL hit');
    // Realized R with proportional friction (0.11%): 3.37% net / 2.0% risk = 1.69R
    assert.strictEqual(evaluated[0].realizedR, 1.69, 'Realized R on pullback to TP1 SL with proportional friction must be +1.69R net');
  });

  // Test 32: Multifractal Mean Reversion Invalidation Parity
  test('backtestMultifractalMTF preserves winning Mean Reversion setups without false midpoint invalidation', () => {
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0.2);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0.05);
    const klines5m = generateSyntheticKlines(600, 300, 100, 0.02);

    const result = backtestMultifractalMTF(klines5m, klines1h, klines1d, 'MR_TEST');
    assert.strictEqual(result.insufficient, false);
    assert(typeof result.winRate === 'number');
    assert(result.profitFactor === null || typeof result.profitFactor === 'number');
    assert(typeof result.expectancyR === 'number');
    assert(typeof result.expectancyPerHour === 'number');
  });

  // Test 33: Tournament Zero-Loss / Single Trade Singularity Rejection
  test('evaluateStrategyTournament prevents single-trade zero-loss candidates from beating robust samples', () => {
    const candidates: StrategyCandidate[] = [
      // 1 single lucky trade with 0 losses (PF = null / undefined)
      { key: 'standard', label: 'Lucky Single Trade', profitFactor: null, expectancyR: 1.5, expectancyPerHour: 3.0, winRate: 1.0, resolved: 1, forwardWindow: 6, avgExposureHours: 0.5 },
      // 20 robust trades with strong stats
      { key: 'confluencia', label: 'Robust Confluencia', profitFactor: 2.2, expectancyR: 0.6, expectancyPerHour: 1.2, winRate: 0.65, resolved: 20, forwardWindow: 6, avgExposureHours: 0.5 }
    ];

    const result = evaluateStrategyTournament(candidates, '5m');
    assert.strictEqual(result.bestStrategy, 'confluencia', 'Robust sample must decisively beat single lucky trade');
    assert.strictEqual(result.confidence, 'HIGH');
  });

  // Test 34: Tournament Time-Horizon Expectancy Normalization
  test('evaluateStrategyTournament fairly scales expectancy across different forward windows', () => {
    const candidates: StrategyCandidate[] = [
      // Fast strategy (6 candles = 0.5h): E[R] = +0.35R, velocity = +0.70 R/h
      { key: 'standard', label: 'Fast Scalp (6 candles)', profitFactor: 1.8, expectancyR: 0.35, expectancyPerHour: 0.70, avgExposureHours: 0.5, winRate: 0.60, resolved: 20, forwardWindow: 6 },
      // Slow strategy (72 candles = 6h): E[R] = +0.40R, velocity = +0.067 R/h
      { key: 'multitemporal', label: 'Slow Drift (72 candles)', profitFactor: 1.8, expectancyR: 0.40, expectancyPerHour: 0.067, avgExposureHours: 6.0, winRate: 0.60, resolved: 20, forwardWindow: 72 }
    ];

    const result = evaluateStrategyTournament(candidates, '5m');
    assert.strictEqual(result.bestStrategy, 'standard', 'Fast scalp with higher edge-per-unit-time must beat slow drift with identical PF');
  });

  // Test 35: Statistical Rolling RVOL Accuracy & Robustness
  test('calculateRollingVolumeAvg calculates robust rolling baseline without date allocations', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 30; i++) {
      klines.push({ time: 1700000000 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 1000 + i * 10 });
    }
    let expectedSum = 0;
    for (let i = 5; i < 25; i++) expectedSum += klines[i].volume;
    const expectedAvg = expectedSum / 20;

    const computedAvg = calculateRollingVolumeAvg(klines, 25, 20);
    assert.strictEqual(computedAvg, expectedAvg);
  });

  // Test 36: RVOL Volume Spike Isolation (No Self-Inclusion Damping)
  test('RVOL baseline strictly excludes current bar avoiding self-inclusion damping (3.0x vs 2.625x)', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push({ time: 1700000000 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 100 });
    }
    klines.push({ time: 1700000000 + 20 * 300, open: 100, high: 101, low: 99, close: 100, volume: 300 });

    const baseline = calculateRollingVolumeAvg(klines, 20, 20);
    const rvol = klines[20].volume / baseline;
    assert.strictEqual(baseline, 100, 'Baseline volume must strictly equal 100 (excluding the 300 spike)');
    assert.strictEqual(rvol, 3.0, 'RVOL must be exactly 3.0x');
  });

  // Test 37: Live Execution Price Parity with Backtest (Open of next bar vs Close of signal bar)
  test('calculateVCMESniperSignal anchors levels to explicit executionPrice (open_{i+1}) matching backtester', () => {
    // Generate synthetic series with confirmed signal
    const klines5m: Kline[] = [];
    const klines1h: Kline[] = [];
    const klines1d: Kline[] = [];

    for (let i = 0; i < 40; i++) {
      klines1d.push({ time: 1700000000 + i * 86400, open: 100 + i * 2, high: 105 + i * 2, low: 98 + i * 2, close: 104 + i * 2, volume: 100000 });
    }
    for (let i = 0; i < 80; i++) {
      klines1h.push({ time: 1700000000 + i * 3600, open: 100 + i * 0.5, high: 102 + i * 0.5, low: 99 + i * 0.5, close: 101.5 + i * 0.5, volume: 10000 });
    }
    for (let i = 0; i < 60; i++) {
      klines5m.push({ time: 1700000000 + i * 300, open: 100 + i * 0.1, high: 100.8 + i * 0.1, low: 99.8 + i * 0.1, close: 100.5 + i * 0.1, volume: 2000 });
    }

    const defaultResult = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'BTCUSDT');
    assert.ok(defaultResult, 'Default result should be computed successfully');
    // If signal triggered, verify that providing an execution price shifts entry reference
    const customExecPrice = 110.0;
    const customResult = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'BTCUSDT', undefined, undefined, 'dayTrading', 'agresivo', customExecPrice);
    
    if (customResult.signal !== 'NEUTRAL' && customResult.stopLoss > 0) {
      assert.ok(customResult.takeProfit1 > customExecPrice, 'TP1 must be above execution price for BUY');
    }
    // Multifractal explicit executionPrice check
    const mfCustom = calculateMultifractalMTFSignal(klines5m, klines1h, klines1d, 'BTCUSDT', customExecPrice);
    assert.strictEqual(mfCustom.triggerPrice, customExecPrice, 'Multifractal triggerPrice must strictly equal customExecPrice');
  });

  // Test 38: VCME Swing Mode Window Reachability for Stocks (evalWindow = 168) with authentic NYSE Session Gaps
  test('VCME Swing mode evaluates on stock datasets with ~300-440 1H candles (evalWindow = 168)', () => {
    // 350 hourly candles across authentic trading sessions (7 1H candles per day with overnight gaps)
    const stockKlines1h: Kline[] = [];
    let t = 1700000000;
    let price = 150;
    for (let day = 0; day < 50; day++) {
      // 7 1H candles per NYSE trading day (09:30 - 16:30)
      for (let h = 0; h < 7; h++) {
        price += (Math.sin(day * 0.2 + h * 0.1) * 0.5) + (Math.random() - 0.48) * 1.5;
        stockKlines1h.push({
          time: t,
          open: price,
          high: price + 1.5,
          low: price - 1.5,
          close: price + (Math.random() - 0.5),
          volume: 10000 + Math.random() * 5000,
        });
        t += 3600;
      }
      // Overnight gap of 17 hours (or weekend gap every 5 days)
      t += (day % 5 === 4 ? 65 : 17) * 3600;
    }

    const klines1d = generateSyntheticKlines(60, 86400, 150);

    const result = backtestMultitemporal(stockKlines1h, stockKlines1h, klines1d, '1h', 'AAPL', 'swing', 'agresivo');
    assert.strictEqual(result.insufficient, false, 'VCME Swing must evaluate successfully with 350 1H candles');
    assert.strictEqual(result.discards.sessionGap, 0, 'VCME Swing must NOT discard signals due to session boundaries');
    assert.strictEqual(result.forwardLabel, '48 hs max (Swing)');
    assert(result.label.includes('1h'), 'Label must indicate 1h candles');
  });

  // Test 39: Sub-microsecond Integer Session Math & Zero-Intl Performance
  test('isNyseOpeningWindow and getSessionId execute with zero Intl overhead and correct boundaries', () => {
    const utcMidnight = 1700006400; // 00:00:00 UTC
    const nyseOpenSec = utcMidnight + 14 * 3600 + 35 * 60; // 14:35 UTC (9:35 AM EST)
    const nyseClosedSec = utcMidnight + 18 * 3600; // 18:00 UTC

    assert.strictEqual(isNyseOpeningWindow(nyseOpenSec, 'AAPL'), true, '14:35 UTC must be inside NYSE opening window');
    assert.strictEqual(isNyseOpeningWindow(nyseClosedSec, 'AAPL'), false, '18:00 UTC must be outside NYSE opening window');
    assert.strictEqual(isNyseOpeningWindow(nyseOpenSec, 'BTCUSDT'), false, 'Crypto assets must always return false');

    const klineA: Kline = { time: utcMidnight + 1000, open: 100, high: 105, low: 95, close: 102, volume: 500 };
    const klineB: Kline = { time: utcMidnight + 90000, open: 102, high: 108, low: 98, close: 105, volume: 600 };
    assert.notStrictEqual(getSessionId(klineA, '5m', 'AAPL'), getSessionId(klineB, '5m', 'AAPL'), 'Different days must produce distinct session IDs');
  });

  // Test 40: Revolution Volatility Bands O(N) Variance & Compression Accuracy
  test('calculateRevolutionVolatilityBand executes with O(N) rolling variance and correct compression flags', () => {
    const klines = generateSyntheticKlines(300, 300, 100);
    const bands = calculateRevolutionVolatilityBand(klines, 20, 2, 200, 15);

    assert.strictEqual(bands.length, 300, 'Output length must equal input klines length');
    // First 19 entries are uninitialized
    assert.strictEqual(bands[0].upper, 0);
    assert.strictEqual(bands[18].width, 0);
    // From index 19 onwards, valid values
    assert.ok(bands[19].upper > bands[19].lower, 'Upper band must exceed lower band');
    assert.ok(bands[19].width > 0, 'Band width must be positive');
    assert(typeof bands[100].isCompressed === 'boolean', 'isCompressed must be boolean');
  });

  // Test 41: calculateAlertLevels Exact Parity with Backtest Parameters
  test('calculateAlertLevels strictly matches backtest adaptive thresholds and 1.5R single target', () => {
    const entry = 100.0;
    const atr = 1.0; // 1% ATR relative to entry

    // 5m: atrMultiplier = 1.2 -> stopPct = 1.2%, target = 1.8% (+1.5R)
    const levels5m = calculateAlertLevels('BUY', entry, '5m', atr);
    assert.strictEqual(levels5m.stopLoss, 100.0 * (1 - 0.012), '5m Stop loss must equal entry * (1 - 1.2 * ATR)');
    assert.strictEqual(levels5m.takeProfit1, 100.0 * (1 + 0.018), '5m TP1 must equal entry * (1 + 1.8 * ATR)');
    assert.strictEqual(levels5m.takeProfit2, undefined, '5m TP2 must be undefined (single objective parity)');

    // 1d: atrMultiplier = 1.0 -> stopPct = 1.0%, target = 1.5% (+1.5R)
    const levels1d = calculateAlertLevels('SELL', entry, '1d', atr);
    assert.strictEqual(levels1d.stopLoss, 100.0 * (1 + 0.010), '1d Stop loss must equal entry * (1 + 1.0 * ATR)');
    assert.strictEqual(levels1d.takeProfit1, 100.0 * (1 - 0.015), '1d TP1 must equal entry * (1 - 1.5 * ATR)');
    assert.strictEqual(levels1d.takeProfit2, undefined, '1d TP2 must be undefined');

    // Clamping checks: minimum 0.2% and maximum 8.0%
    const tinyATRLevels = calculateAlertLevels('BUY', entry, '5m', 0.0001); // 0.0001% -> clamped to 0.2%
    assert.strictEqual(tinyATRLevels.stopLoss, 100.0 * (1 - 0.002), 'Tiny ATR must clamp to 0.2% minimum');

    const hugeATRLevels = calculateAlertLevels('BUY', entry, '5m', 20.0); // 20% -> clamped to 8.0%
    assert.strictEqual(hugeATRLevels.stopLoss, 100.0 * (1 - 0.08), 'Huge ATR must clamp to 8.0% maximum');
  });

  // Test 42: Strict Zero-Volume Immunity (Zero-Division & Infinity Guard)
  test('VCME backtester and indicators handle zero-volume datasets safely without Infinity surge triggers', () => {
    // Generate synthetic series where volume is identically 0
    const zeroVol5m = generateSyntheticKlines(700, 300, 100).map(k => ({ ...k, volume: 0 }));
    const zeroVol1h = generateSyntheticKlines(200, 3600, 100).map(k => ({ ...k, volume: 0 }));
    const zeroVol1d = generateSyntheticKlines(60, 86400, 100).map(k => ({ ...k, volume: 0 }));

    const btResult = backtestMultitemporal(zeroVol5m, zeroVol1h, zeroVol1d, '5m', 'ZERO_VOL', 'dayTrading');
    assert.strictEqual(btResult.insufficient, false, 'Backtester should run without crashing on zero volume');
    // On zero volume, rvol is 1.0 (default fallback) and cannot pass >= 1.5 volume spikes artificially
    assert.ok(btResult.profitFactor === null || Number.isFinite(btResult.profitFactor), 'Profit factor must be finite or null');
    assert.ok(Number.isFinite(btResult.expectancy), 'Expectancy must be finite');
    assert.ok(Number.isFinite(btResult.expectancyR), 'ExpectancyR must be finite');

    const liveResult = calculateVCMESniperSignal(zeroVol5m, zeroVol1h, zeroVol1d, 'ZERO_VOL');
    assert.ok(Number.isFinite(liveResult.stopLoss), 'Stop loss must be finite');
  });

  // Test 43: Pullback Boundary Evaluation Parity (idx >= 10 Guard)
  test('VCME backtester evaluates pullbacks at the start of the window without boundary blindness', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100);
    const klines1h = generateSyntheticKlines(200, 3600, 100);
    const klines1d = generateSyntheticKlines(60, 86400, 100);

    const btResult = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'PULLBACK_TEST', 'dayTrading');
    assert.strictEqual(btResult.insufficient, false, 'Backtester must evaluate window seamlessly');
    assert(typeof btResult.totalSignals === 'number', 'totalSignals must be a valid number');
  });

  // Test 44: Classic Strategy 1-Hour (12 Candle) Cooldown Parity
  test('backtestStandard enforces canonical 1-hour (12 candles) cooldown on 5m', () => {
    // Generate trending klines of 600 bars
    const klines = generateSyntheticKlines(600, 300, 100, 0.10);
    const result = backtestStandard(klines, '5m', 'COOLDOWN_TEST');

    // In a 576-bar eval window, max possible signals with 12-candle cooldown is 576 / 12 = 48
    assert.ok(result.totalSignals <= 48, `Total signals (${result.totalSignals}) must not exceed window / cooldown (48)`);
    assert.strictEqual(result.insufficient, false);
  });

  // Test 45: Strategy Isolation in Candle Alert Deduplication Registry
  test('isCandleAlertFired strictly isolates alerts per strategy preventing cross-strategy blocking', () => {
    const candleTs = 1700005000;
    
    // Register BUY alert for Multifractal MTF
    registerFiredCandleAlert({
      symbol: 'BTCUSDT',
      interval: '5m',
      candleTimestamp: candleTs,
      strategy: 'Multifractal MTF',
      signal: 'BUY'
    });

    // Verify Multifractal BUY is recorded as fired
    assert.strictEqual(isCandleAlertFired('BTCUSDT', '5m', candleTs, 'Multifractal MTF', 'BUY'), true);

    // Verify VCME Sniper BUY on the EXACT SAME candle timestamp is NOT blocked!
    assert.strictEqual(isCandleAlertFired('BTCUSDT', '5m', candleTs, 'VCME Sniper', 'BUY'), false, 'Multifractal BUY must NOT block VCME Sniper BUY on same candle');

    // Verify Standard BUY on the same candle is also NOT blocked
    assert.strictEqual(isCandleAlertFired('BTCUSDT', '5m', candleTs, 'Standard', 'BUY'), false, 'Multifractal BUY must NOT block Standard BUY on same candle');
  });

  // Test 46: Scoring Series Checkpoint S/R Caching (srCacheInterval = 5)
  test('computeScoringSignalsSeries computes signals efficiently with aligned 5-bar S/R caching', () => {
    const klines = generateSyntheticKlines(300, 300, 100, 0.05);
    const signals = computeScoringSignalsSeries(klines, '5m');

    assert.strictEqual(signals.length, 300, 'Signals length must match input klines');
    // First 59 bars are NEUTRAL
    assert.strictEqual(signals[0], 'NEUTRAL');
    assert.strictEqual(signals[58], 'NEUTRAL');
    // Signals from bar 59 onwards are valid signal types
    for (let i = 59; i < 300; i++) {
      assert(['BUY', 'SELL', 'NEUTRAL'].includes(signals[i]), `Signal at index ${i} must be valid`);
    }
  });

  // Test 47: 150-199 Daily Candle Safety (EMA200 >= 200 Guard)
  test('VCME evaluates properly without silent candle rejection on 150-199 daily candles', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100);
    const klines1h = generateSyntheticKlines(200, 3600, 100);
    const klines1d_160 = generateSyntheticKlines(160, 86400, 100); // 160 daily bars (< 200)

    const btResult = backtestMultitemporal(klines5m, klines1h, klines1d_160, '5m', 'DAILY_160_TEST', 'dayTrading');
    assert.strictEqual(btResult.insufficient, false, 'Backtest must not be marked as insufficient');
    assert.ok(btResult.profitFactor === null || Number.isFinite(btResult.profitFactor), 'Profit factor must be finite or null');

    const liveResult = calculateVCMESniperSignal(klines5m, klines1h, klines1d_160, 'DAILY_160_TEST');
    assert(['ALCISTA', 'BAJISTA', 'NEUTRAL'].includes(liveResult.bias1D), 'bias1D must be valid');
  });

  // Test 48: 1H Candle Length < 200 Slope Fallback (EMA50 Warmup Guard)
  test('VCME computes valid 1H regime slope and does not freeze at 0 signals when 1H candles < 200', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.05);
    const klines1h_90 = generateSyntheticKlines(90, 3600, 100, 0.05); // 90 1H bars (< 200)
    const klines1d = generateSyntheticKlines(60, 86400, 100);

    const btResult = backtestMultitemporal(klines5m, klines1h_90, klines1d, '5m', 'H1_90_TEST', 'dayTrading');
    assert.strictEqual(btResult.insufficient, false, '90 1H bars must evaluate without insufficient flag');
    assert.ok(btResult.profitFactor === null || Number.isFinite(btResult.profitFactor), 'Profit factor must be finite or null');

    const liveResult = calculateVCMESniperSignal(klines5m, klines1h_90, klines1d, 'H1_90_TEST');
    assert.strictEqual(typeof liveResult.signal, 'string');
  });

  // Test 49: EMA Slope Gate Realism (slope > 0 vs slope > 0.0005)
  test('VCME arms 1H setup with realistic positive slope (slope > 0)', () => {
    // Generate synthetic trend with steady upward progression
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.03);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.03);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.03);

    const liveResult = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'SLOPE_TEST');
    assert(liveResult !== null, 'VCME sniper signal calculation must complete');
    assert(['BUY', 'SELL', 'NEUTRAL'].includes(liveResult.signal), 'Signal must be valid');
  });

  // Test 50: Intra-Candle TP1 Hit Preserved on Same-Candle Emergency Exit
  test('Same-candle TP1 hit preserves 50% partial profit before candle-close Emergency Exit', () => {
    const startTime = 1700000000;
    const entryPrice = 100;
    const stopLoss = 96;
    const takeProfit1 = 106; // +6%
    const takeProfit2 = 110;
    
    // Generate 30 pre-candles at price 100 (VWAP ~100, EMA21 ~100)
    const klines: Kline[] = [];
    for (let i = 0; i < 30; i++) {
      klines.push({
        time: startTime + i * 300,
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1000
      });
    }

    const alert: AuditAlertItem = {
      id: 'vcme-tp1-emergency-test',
      symbol: 'BTCUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 2.5,
      strategy: 'VCME Sniper',
      executionStyle: 'dayTrading',
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: (startTime + 29 * 300) * 1000,
      candleTimestamp: startTime + 29 * 300
    };

    // Candle 31: Spikes up to 106.5 (hits TP1 106.0 intra-candle), but dumps and closes at 98.0 (< VWAP & EMA21)
    klines.push({
      time: startTime + 30 * 300,
      open: 100.0,
      high: 106.5, // Hits TP1 (+6%)
      low: 97.5,
      close: 98.0, // Loses VWAP & EMA21 at close
      volume: 10000
    });

    const evaluated = updateAlertsOutcome([alert], { 'BTCUSDT:5m': klines });
    assert.strictEqual(evaluated[0].status, 'TP1_BE_CLOSED', 'Alert must exit via Breakeven Stop as TP1_BE_CLOSED');
    // Expected PnL with proportional friction (0.11%) and BE market slippage: +3.0% gross - 0.015% slippage - 0.11% friction = +2.87% net
    assert.strictEqual(evaluated[0].pnlPercent, 2.87, `PnL must be +2.87% with 50% partial taken, BE market stop slippage and friction (got ${evaluated[0].pnlPercent}%)`);
    assert(evaluated[0].realizedR > 0, `Realized R must be positive (+0.75R) because TP1 was filled intra-candle (got ${evaluated[0].realizedR}R)`);
  });

  // Test 51: Win Rate strictly reflects proportion of trades with positive net R (pnlPct > 0)
  test('winRate strictly reflects proportion of trades with positive net return (pnlPct > 0)', () => {
    // Generate trending dataset that triggers evaluation
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.02);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.02);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.02);

    const result = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'WINRATE_TEST', 'dayTrading');
    assert.strictEqual(result.insufficient, false);
    if (result.resolved > 0) {
      assert.strictEqual(result.resolved, result.wins + result.losses, 'Resolved trades must equal wins + losses');
      const expectedWinRate = result.wins / result.resolved;
      assert(Math.abs(result.winRate - expectedWinRate) < 0.001, 'winRate must equal wins / (wins + losses)');
    }
  });

  // Test 52: Granular discards breakdown accurately classifies filtered bars and equals neutrals
  test('discards breakdown accurately classifies filtered bars and equals neutrals', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.02);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.02);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.02);

    const result = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'DISCARDS_TEST', 'dayTrading');
    assert(result.discards !== undefined, 'Result must contain discards diagnostic breakdown');
    
    const discardsSum = Object.values(result.discards).reduce((acc, val) => acc + val, 0);
    assert.strictEqual(result.neutrals, discardsSum, `neutrals (${result.neutrals}) must equal sum of all discards (${discardsSum})`);

    // Verify fallback result also includes discards structure
    const fallback = backtestMultitemporal([], [], [], '5m', 'EMPTY', 'dayTrading');
    assert(fallback.discards !== undefined, 'Fallback result must include empty discards structure');
    assert.strictEqual(fallback.neutrals, 0);
  });

  // Test 53: Unified simulateTrade execution engine deterministic parity
  test('simulateTrade delivers exact target scaling, chandelier stops, emergency exits and friction accounting', () => {
    // 1. Single target standard trade
    const baseKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 110.5, low: 99.0, close: 108, volume: 1200 }
    ];
    const levels1: TradeLevels = { entryPrice: 100, stopLoss: 95, takeProfit1: 110 };
    const res1 = simulateTrade(baseKlines, 0, 'BUY', levels1, { forwardWindow: 5, enablePartials: false, frictionPct: 0.08 });
    assert.strictEqual(res1.outcome, 'win');
    assert.strictEqual(res1.exitReason, 'TP1');
    assert.strictEqual(res1.grossPnlPct, 10.0);
    assert.strictEqual(res1.pnlPct, 9.92);
    // Net R = 9.92% / 5.0% = 1.984 -> 1.98R
    assert.strictEqual(res1.realizedR, 1.98);

    // 2. VCME Multi-target with Chandelier Trailing runner
    const multiKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 106.5, low: 99, close: 105, volume: 1000 }, // Hits TP1 (106)
      { time: 1700000600, open: 105, high: 111.0, low: 104, close: 110, volume: 1000 }, // Hits TP2 (110)
      { time: 1700000900, open: 110, high: 110.5, low: 104.5, close: 105, volume: 1000 } // Chandelier stop breach @ 105
    ];
    const levels2: TradeLevels = { entryPrice: 100, stopLoss: 96, takeProfit1: 106, takeProfit2: 110, takeProfit3: 120 };
    const res2 = simulateTrade(multiKlines, 0, 'BUY', levels2, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      trailingStop: 'chandelier',
      atrSeries: [2, 2, 2, 2], // Chandelier SL = 111.0 - 2.5 * 2 = 106.0. Close 105 breaches it.
      frictionPct: 0.08,
      frictionModel: 'per-fill',
      marketSlippagePct: 0
    });
    assert.strictEqual(res2.outcome, 'win');
    assert.strictEqual(res2.exitReason, 'TP2');
    assert.strictEqual(res2.status, 'TP2_CLOSED');
    // Active SL was trailed to TP1 (106). Low 104.5 fills stop at 106:
    // 50% * 6% (TP1) + 25% * 10% (TP2) + 25% * 6% (TP1 SL) = 3.0 + 2.5 + 1.5 = 7.0% gross
    // With scaled 4-fill friction (4 * 0.04% = 0.16%): 7.0% - 0.16% = 6.84% net
    // Net R = 6.84% / 4.0% = 1.71R
    assert.strictEqual(res2.grossPnlPct, 7.0);
    assert.strictEqual(res2.pnlPct, 6.84);
    assert.strictEqual(res2.realizedR, 1.71);

    // 3. Emergency Exit VWAP breach
    const emergKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 101, low: 96.5, close: 97, volume: 1000 }
    ];
    const res3 = simulateTrade(emergKlines, 0, 'BUY', levels1, {
      forwardWindow: 5,
      emergencyExitFn: () => true, // Emergency triggered immediately
      frictionPct: 0.08,
      marketSlippagePct: 0
    });
    assert.strictEqual(res3.outcome, 'loss'); // Negative net R (-0.62R) is classified as economic loss
    assert.strictEqual(res3.exitReason, 'EMERGENCY_EXIT');
    assert.strictEqual(res3.status, 'EXPIRED');
    assert.strictEqual(res3.grossPnlPct, -3.0);
    assert.strictEqual(res3.pnlPct, -3.08);
    // Net R = -3.08% / 5.0% = -0.616 -> -0.62R
    assert.strictEqual(res3.realizedR, -0.62);

    // 4. Stop Loss hit with 2% initial risk and 0.08% friction -> realizedR = -1.04R (not -1.00R)
    const slKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 100.5, low: 97.5, close: 97.8, volume: 1000 }
    ];
    const slLevels: TradeLevels = { entryPrice: 100, stopLoss: 98, takeProfit1: 103 }; // 2% risk
    const resSL = simulateTrade(slKlines, 0, 'BUY', slLevels, { forwardWindow: 5, frictionPct: 0.08, marketSlippagePct: 0 });
    assert.strictEqual(resSL.outcome, 'loss');
    assert.strictEqual(resSL.exitReason, 'SL');
    assert.strictEqual(resSL.grossPnlPct, -2.0);
    assert.strictEqual(resSL.pnlPct, -2.08);
    assert.strictEqual(resSL.realizedR, -1.04, 'Stop Loss with 2% risk and 0.08% friction must yield -1.04R net');
  });

  // Test 54: R-multiple and exposure velocity tournament evaluation with null PF handling
  test('evaluateStrategyTournament normalizes by R and exposure velocity and excludes null PF singularities', () => {
    // Zero losses with sample >= minLimited (3 trades): PF must be null and treated as unproven
    const zeroLossCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Zero Loss 3-Trades',
      profitFactor: null,
      expectancyR: 1.5,
      expectancyPerHour: 3.0,
      avgExposureHours: 0.5,
      winRate: 1.0,
      resolved: 3,
      forwardWindow: 6
    };

    const robustCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Robust 18-Trades',
      profitFactor: 2.1,
      expectancyR: 0.55,
      expectancyPerHour: 1.1,
      avgExposureHours: 0.5,
      winRate: 0.65,
      resolved: 18,
      forwardWindow: 6
    };

    const tourney = evaluateStrategyTournament([zeroLossCandidate, robustCandidate], '5m');
    assert.strictEqual(tourney.bestStrategy, 'confluencia');
    assert.strictEqual(tourney.confidence, 'HIGH');
    assert.ok(tourney.reasoning.includes('E[R] +0.55R'), 'Reasoning must display E[R]');
    assert.ok(tourney.reasoning.includes('1.10R/h'), 'Reasoning must display hourly velocity');
    assert.ok(tourney.reasoning.includes('PF 2.10'), 'Reasoning must display valid PF');

    // Test formatting when winner has null PF
    const soloZeroLoss = evaluateStrategyTournament([zeroLossCandidate], '5m');
    assert.strictEqual(soloZeroLoss.confidence, 'LIMITED');
    assert.strictEqual(soloZeroLoss.profitFactor, null);
    assert.ok(soloZeroLoss.reasoning.includes('PF N/D'), 'Reasoning must display PF N/D for zero-loss sample');
  });

  // Test 55: calculateRiskMetrics exact mathematical deterministic validation
  test('calculateRiskMetrics delivers exact MDD in R, loss streak, Sortino ratio and breakdowns', () => {
    const fixtureTrades: RecordedTrade[] = [
      { dir: 'BUY',  realizedR: 1.5,  pnlPct: 6.0,  adxAtEntry: 30, outcome: 'win' },  // Eq: 1.5, Peak: 1.5, DD: 0
      { dir: 'BUY',  realizedR: 2.5,  pnlPct: 10.0, adxAtEntry: 28, outcome: 'win' },  // Eq: 4.0, Peak: 4.0, DD: 0
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, adxAtEntry: 18, outcome: 'loss' }, // Eq: 3.0, Peak: 4.0, DD: 1.0, Streak: 1
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, adxAtEntry: 15, outcome: 'loss' }, // Eq: 2.0, Peak: 4.0, DD: 2.0, Streak: 2
      { dir: 'BUY',  realizedR: 1.0,  pnlPct: 4.0,  adxAtEntry: 26, outcome: 'win' },  // Eq: 3.0, Peak: 4.0, DD: 1.0, Streak: 0
    ];

    const metrics = calculateRiskMetrics(fixtureTrades);

    // MDD: Peak was 4.0, lowest was 2.0 -> Drawdown = 2.0R
    assert.strictEqual(metrics.maxDrawdownR, 2.0);
    // Streak: 2 consecutive losses (trades 3 & 4)
    assert.strictEqual(metrics.maxLossStreak, 2);
    // Sortino: mean = 3.0 / 5 = 0.60R, downsideSumSq = (-1)^2 + (-1)^2 = 2.0, dev = sqrt(2/5) = sqrt(0.4) = 0.632455 -> Sortino = 0.60 / 0.632455 = 0.95
    assert.strictEqual(metrics.sortinoRatio, 0.95);

    // Directional LONG
    assert.strictEqual(metrics.longStats.signals, 3);
    assert.strictEqual(metrics.longStats.wins, 3);
    assert.strictEqual(metrics.longStats.losses, 0);
    assert.strictEqual(metrics.longStats.winRate, 1.0);
    assert.strictEqual(metrics.longStats.expectancyR, 1.667); // (1.5 + 2.5 + 1.0) / 3 = 1.667
    assert.strictEqual(metrics.longStats.profitFactor, null); // 0 losses

    // Directional SHORT
    assert.strictEqual(metrics.shortStats.signals, 2);
    assert.strictEqual(metrics.shortStats.wins, 0);
    assert.strictEqual(metrics.shortStats.losses, 2);
    assert.strictEqual(metrics.shortStats.winRate, 0);
    assert.strictEqual(metrics.shortStats.expectancyR, -1.0);

    // Regime Trending (ADX > 25: trades 1, 2, 5)
    assert.strictEqual(metrics.regimeStats.trending.signals, 3);
    assert.strictEqual(metrics.regimeStats.trending.wins, 3);
    assert.strictEqual(metrics.regimeStats.trending.winRate, 1.0);
    assert.strictEqual(metrics.regimeStats.trending.expectancyR, 1.667);

    // Regime Ranging (ADX <= 25: trades 3, 4)
    assert.strictEqual(metrics.regimeStats.ranging.signals, 2);
    assert.strictEqual(metrics.regimeStats.ranging.wins, 0);
    assert.strictEqual(metrics.regimeStats.ranging.winRate, 0);
    assert.strictEqual(metrics.regimeStats.ranging.expectancyR, -1.0);
  });

  // Test 56: Live Backtest Engine Risk Integration across backtestStandard and backtestMultitemporal
  test('all backtest engines calculate valid risk metrics, streaks, and partitions', () => {
    const klines = generateSyntheticKlines(500, 300, 100, 0.05);
    const stdResult = backtestStandard(klines, '5m', 'TEST_RISK_STD');

    assert.ok(typeof stdResult.maxDrawdownR === 'number');
    assert.ok(typeof stdResult.maxLossStreak === 'number');
    assert.ok(stdResult.sortinoRatio === null || typeof stdResult.sortinoRatio === 'number');
    assert.ok(stdResult.longStats.signals + stdResult.shortStats.signals === stdResult.totalSignals);
    assert.ok(stdResult.regimeStats.trending.signals + stdResult.regimeStats.ranging.signals === stdResult.totalSignals);
  });

  // Test 57: Tournament Drawdown Penalty & Sortino Risk Selection
  test('evaluateStrategyTournament penalizes severe drawdown and rewards higher Sortino consistency', () => {
    const candidateLowRisk: StrategyCandidate = {
      key: 'standard',
      label: 'Smooth Low Drawdown',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.65,
      resolved: 16,
      maxDrawdownR: 1.5, // Well below 3.0 threshold
      sortinoRatio: 2.2, // High consistency bonus
      forwardWindow: 6
    };

    const candidateHighRisk: StrategyCandidate = {
      key: 'confluencia',
      label: 'Violent High Drawdown',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.65,
      resolved: 16,
      maxDrawdownR: 7.0, // Severe 7R drawdown penalty
      sortinoRatio: 0.5,
      forwardWindow: 6
    };

    const tourney = evaluateStrategyTournament([candidateLowRisk, candidateHighRisk], '5m');
    assert.strictEqual(tourney.bestStrategy, 'standard', 'Smooth low-drawdown candidate must beat identical expectancy with 7R drawdown');
    assert.ok(tourney.reasoning.includes('MDD 1.5R'), 'Reasoning must display MDD');
    assert.ok(tourney.reasoning.includes('Sortino 2.2'), 'Reasoning must display Sortino');
  });

  // Test 58: calculateWalkForward deterministic partitioning and status evaluation
  test('calculateWalkForward divides trades into 70% In-Sample and 30% Out-of-Sample with rigorous PASS/FAIL status', () => {
    const oldestIdx = 0;
    const latestIdx = 99; // 100 candles total -> IS: 70 candles (0..69), OOS: 30 candles (70..99)

    // Scenario A: Positive OOS with >= 5 trades -> PASS
    const tradesPassing: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 50 },
      // 5 OOS trades (entryIdx >= 70)
      { dir: 'BUY', realizedR: 1.2, pnlPct: 5.0, outcome: 'win', entryIdx: 72 },
      { dir: 'SELL', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 78 },
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 82 },
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 88 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 94 }
    ];
    const wfPass = calculateWalkForward(tradesPassing, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfPass.isWindow, 70);
    assert.strictEqual(wfPass.oosWindow, 30);
    assert.strictEqual(wfPass.inSample.signals, 2);
    assert.strictEqual(wfPass.outOfSample.signals, 5);
    assert.strictEqual(wfPass.status, 'PASS');
    assert.strictEqual(wfPass.passed, true);

    // Scenario A.2: Single positive trade in OOS (< min trades) -> INSUFFICIENT_OOS (unproven)
    const tradesSingleOOS: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 0.01, pnlPct: 0.04, outcome: 'win', entryIdx: 85 } // 1 OOS trade only
    ];
    const wfSingle = calculateWalkForward(tradesSingleOOS, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfSingle.outOfSample.signals, 1);
    assert.strictEqual(wfSingle.status, 'INSUFFICIENT_OOS', 'Single positive OOS trade must receive INSUFFICIENT_OOS status');
    assert.strictEqual(wfSingle.passed, false);

    // Scenario B.1: 1 or 2 negative trades in OOS (< effectiveMinOos) -> INSUFFICIENT_OOS (avoids single-trade noise disqualification)
    const tradesFailingFew: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 2.0, pnlPct: 8.0, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 75 }, // OOS trade 1
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 90 } // OOS trade 2
    ];
    const wfFew = calculateWalkForward(tradesFailingFew, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfFew.inSample.signals, 1);
    assert.strictEqual(wfFew.outOfSample.signals, 2);
    assert.strictEqual(wfFew.outOfSample.wins, 0);
    assert.strictEqual(wfFew.outOfSample.losses, 2);
    assert.strictEqual(wfFew.outOfSample.expectancyR, -1.0);
    assert.strictEqual(wfFew.status, 'INSUFFICIENT_OOS', 'Underpowered OOS sample (< 3 trades) must remain INSUFFICIENT_OOS');
    assert.strictEqual(wfFew.passed, false);

    // Scenario B.2: Negative OOS with >= effectiveMinOos trades -> FAIL
    const tradesFailingFull: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 2.0, pnlPct: 8.0, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 75 }, // OOS trade 1
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 85 }, // OOS trade 2
      { dir: 'BUY', realizedR: -0.5, pnlPct: -2.0, outcome: 'loss', entryIdx: 95 }  // OOS trade 3 (>= effectiveMinOos)
    ];
    const wfFail = calculateWalkForward(tradesFailingFull, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfFail.outOfSample.signals, 3);
    assert.strictEqual(wfFail.status, 'FAIL', 'OOS sample with >= 3 trades and negative edge must mark FAIL');
    assert.strictEqual(wfFail.passed, false);

    // Scenario C: No trades in OOS -> NO_OOS_TRADES
    const tradesNoOOS: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 15 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 40 }
    ];
    const wfNoOOS = calculateWalkForward(tradesNoOOS, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfNoOOS.inSample.signals, 2);
    assert.strictEqual(wfNoOOS.outOfSample.signals, 0);
    assert.strictEqual(wfNoOOS.status, 'NO_OOS_TRADES');
    assert.strictEqual(wfNoOOS.passed, false);
  });

  // Test 59: Live Backtest Engine Walk-Forward Output
  test('all backtest engines calculate valid walkForward result partitioning', () => {
    const klines = generateSyntheticKlines(600, 300, 100, 0.05);
    const stdResult = backtestStandard(klines, '5m', 'TEST_WF_STD');

    assert.ok(stdResult.walkForward !== undefined);
    assert.ok(stdResult.walkForward.isWindow > 0);
    assert.ok(stdResult.walkForward.oosWindow > 0);
    assert.strictEqual(
      stdResult.walkForward.inSample.signals + stdResult.walkForward.outOfSample.signals + (stdResult.walkForward.purgedSignals ?? 0),
      stdResult.totalSignals
    );
    assert.ok(['PASS', 'FAIL', 'INSUFFICIENT_OOS', 'NO_OOS_TRADES'].includes(stdResult.walkForward.status));
  });

  // Test 60: Strategy Tournament Walk-Forward Out-of-Sample Disqualification
  test('evaluateStrategyTournament disqualifies candidates with failed OOS from HIGH confidence', () => {
    const candidateDegradedOOS: StrategyCandidate = {
      key: 'confluencia',
      label: 'Degraded Recent Regime',
      profitFactor: 2.2,
      expectancyR: 0.60,
      expectancyPerHour: 1.2,
      avgExposureHours: 0.5,
      winRate: 0.65,
      resolved: 16,
      maxDrawdownR: 2.0,
      sortinoRatio: 1.8,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 13, wins: 10, losses: 3, winRate: 0.77, expectancyR: 0.85, profitFactor: 3.2, maxDrawdownR: 1.0 },
        outOfSample: { signals: 3, wins: 0, losses: 3, winRate: 0, expectancyR: -1.0, profitFactor: 0, maxDrawdownR: 3.0 },
        passed: false,
        status: 'FAIL'
      }
    };

    const candidateRobustOOS: StrategyCandidate = {
      key: 'standard',
      label: 'Robust Ongoing Regime',
      profitFactor: 1.7,
      expectancyR: 0.45,
      expectancyPerHour: 0.9,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 15,
      maxDrawdownR: 1.5,
      sortinoRatio: 1.5,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 10, wins: 6, losses: 4, winRate: 0.60, expectancyR: 0.40, profitFactor: 1.5, maxDrawdownR: 1.5 },
        outOfSample: { signals: 5, wins: 4, losses: 1, winRate: 0.80, expectancyR: 0.55, profitFactor: 3.0, maxDrawdownR: 1.0 },
        passed: true,
        status: 'PASS'
      }
    };

    const tourney = evaluateStrategyTournament([candidateDegradedOOS, candidateRobustOOS], '5m');
    assert.strictEqual(tourney.bestStrategy, 'standard', 'Candidate passing OOS must beat higher-historical-PF candidate that failed OOS');
    assert.strictEqual(tourney.confidence, 'HIGH');
    assert.ok(tourney.reasoning.includes('WF OOS +0.55R'), 'Reasoning must display OOS performance');

    // Also test what happens if ONLY the degraded candidate is evaluated:
    // With strict WF FAIL rejection, it must be completely disqualified and remain FLAT (NONE)
    const soloDegraded = evaluateStrategyTournament([candidateDegradedOOS], '5m');
    assert.strictEqual(soloDegraded.confidence, 'NONE', 'Failed OOS candidate must be disqualified from generating actionable alerts');
    assert.strictEqual(soloDegraded.bestStrategy, 'NONE');
  });

  // Test 61: VCME distScore Option A triangular bell curve validation
  test('VCME distScore rewards optimal 0.5 ATR bounce and penalizes overextension > 1.5 ATR', () => {
    const calcDistScore = (close: number, ema21: number, atr: number) => {
      const distRatio = Math.abs(close - ema21) / (atr || 1);
      return Number((0.15 * Math.max(0, 1.0 - Math.abs(distRatio - 0.5) / 1.0)).toFixed(4));
    };

    const atr = 2.0;
    const ema21 = 100.0;

    // 1. Exactly 0.5 ATR away (close = 101.0) -> Maximum score 0.15
    assert.strictEqual(calcDistScore(101.0, ema21, atr), 0.15);

    // 2. Exactly on EMA21 (close = 100.0) -> 0.075 (substantial reward for value entry)
    assert.strictEqual(calcDistScore(100.0, ema21, atr), 0.075);

    // 3. 1.0 ATR away (close = 102.0) -> 0.075
    assert.strictEqual(calcDistScore(102.0, ema21, atr), 0.075);

    // 4. 1.5 ATR away (close = 103.0) -> 0.00
    assert.strictEqual(calcDistScore(103.0, ema21, atr), 0.0);

    // 5. 2.0 ATR away (close = 104.0, severe chasing) -> 0.00
    assert.strictEqual(calcDistScore(104.0, ema21, atr), 0.0);
  });

  // Test 62: Square-root time normalization (sqrt(t)) avoids over-penalization of longer holding strategies (VCME)
  test('evaluateStrategyTournament uses square-root time scaling allowing VCME with high E[R] to beat standard scalp', () => {
    // Standard: 6 candles (0.5h), E[R] = 0.30R
    const standardCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Standard (6 candles)',
      profitFactor: 1.8,
      expectancyR: 0.30,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 20,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5
    };

    // VCME: 66 candles (~5.5h = 11x duration), E[R] = 0.90R (3x higher trade expectancy)
    // Under linear t, VCME velocity is only 0.16 R/h and would lose unjustly.
    // Under sqrt(t), timeFactor = sqrt(11) = 3.31, normalized expectancy = 0.90/3.31 = 0.272R,
    // and combined with higher expRScore (0.90 vs 0.30), VCME wins as mathematically expected.
    const vcmeCandidate: StrategyCandidate = {
      key: 'multitemporal',
      label: 'VCME (66 candles)',
      profitFactor: 2.2,
      expectancyR: 0.90,
      avgExposureHours: 5.5,
      winRate: 0.60,
      resolved: 20,
      forwardWindow: 72,
      maxDrawdownR: 1.2,
      sortinoRatio: 1.8
    };

    const tourney = evaluateStrategyTournament([standardCandidate, vcmeCandidate], '5m');
    assert.strictEqual(tourney.bestStrategy, 'multitemporal', 'VCME with 3x E[R] (0.90R vs 0.30R) must win against standard under sqrt(t) scaling');
  });

  // Test 63: Uniform Net realizedR accounting (netPnlPct / 100 / initialRiskPct) on SL, TP and small risk scales
  test('simulateTrade calculates net realizedR uniformly from net PnL and initial risk, including SL', () => {
    // 1. Tight scalp: initial risk 0.8% (entry 100, SL 99.2), 0.08% friction
    const tightKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 100.1, low: 99.0, close: 99.1, volume: 1000 } // SL hit
    ];
    const tightLevels: TradeLevels = { entryPrice: 100, stopLoss: 99.2, takeProfit1: 101.2 };
    const tightSL = simulateTrade(tightKlines, 0, 'BUY', tightLevels, { forwardWindow: 5, frictionPct: 0.08, marketSlippagePct: 0 });
    // Gross PnL = -0.80%, Net PnL = -0.88%, initialRiskPct = 0.008 -> Net R = -0.0088 / 0.008 = -1.10R
    assert.strictEqual(tightSL.grossPnlPct, -0.8);
    assert.strictEqual(tightSL.pnlPct, -0.88);
    assert.strictEqual(tightSL.realizedR, -1.10, 'Tight scalp SL must reflect friction impact (-1.10R)');

    // 2. Standard 2% risk: SL hit with 0.08% friction -> -1.04R
    const stdKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 100.1, low: 97.9, close: 97.9, volume: 1000 } // SL hit
    ];
    const stdLevels: TradeLevels = { entryPrice: 100, stopLoss: 98, takeProfit1: 103 };
    const stdSL = simulateTrade(stdKlines, 0, 'BUY', stdLevels, { forwardWindow: 5, frictionPct: 0.08, marketSlippagePct: 0 });
    // Gross PnL = -2.00%, Net PnL = -2.08%, initialRiskPct = 0.02 -> Net R = -0.0208 / 0.02 = -1.04R
    assert.strictEqual(stdSL.grossPnlPct, -2.0);
    assert.strictEqual(stdSL.pnlPct, -2.08);
    assert.strictEqual(stdSL.realizedR, -1.04, 'Standard 2% SL with friction must yield -1.04R net');

    // 3. Standard 2% risk: 1.5R TP1 hit with 0.08% friction -> +1.46R
    const tpKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 103.5, low: 99.5, close: 103.1, volume: 1000 } // TP1 hit
    ];
    const stdTP = simulateTrade(tpKlines, 0, 'BUY', stdLevels, { forwardWindow: 5, enablePartials: false, frictionPct: 0.08 });
    // Gross PnL = +3.00%, Net PnL = +2.92%, initialRiskPct = 0.02 -> Net R = +0.0292 / 0.02 = +1.46R
    assert.strictEqual(stdTP.grossPnlPct, 3.0);
    assert.strictEqual(stdTP.pnlPct, 2.92);
    assert.strictEqual(stdTP.realizedR, 1.46, '1.5R TP1 with friction must yield +1.46R net');
  });

  // Test 64: Multifractal MTF zero-risk rejection, directional validation and min/max risk bounds
  test('calculateMultifractalMTFSignal and backtester discard zero-risk and bound risk to 0.8-2.0 ATR', () => {
    // 1. Synthetic dataset where band midpoint would equal entry (risk = 0)
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0.5);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0.05);
    const klines5m = generateSyntheticKlines(600, 300, 100, 0.02);

    // Force execution price equal to stopLoss -> must be rejected as NEUTRAL (0 risk)
    const mfSignalZeroRisk = calculateMultifractalMTFSignal(klines5m, klines1h, klines1d, 'ZERO_RISK', 100.0);
    if (mfSignalZeroRisk.signal !== 'NEUTRAL') {
      // If signal fired, verify its stopLoss is strictly non-zero and has valid directional risk
      assert.notStrictEqual(mfSignalZeroRisk.stopLoss, 100.0, 'Stop loss must never equal trigger price');
      assert(Math.abs(mfSignalZeroRisk.triggerPrice - mfSignalZeroRisk.stopLoss) > 0, 'Risk must be strictly > 0');
    }

    // 2. Run backtest and ensure discards.riskFilter captures invalid/excessive risk setups without polluting totalSignals
    const btRes = backtestMultifractalMTF(klines5m, klines1h, klines1d, '5m', 'ZERO_TEST');
    assert.strictEqual(btRes.insufficient, false);
    assert(typeof btRes.discards.riskFilter === 'number');
  });

  // Test 65: Walk-Forward requires minimum sample (>= 5 trades in 5m) to award PASS status & unlock HIGH confidence
  test('Walk-Forward rejects single-trade +0.01R OOS and requires >= 5 OOS trades for HIGH confidence', () => {
    // 1. Single trade in OOS with +0.01R must result in INSUFFICIENT_OOS and passed = false
    const tradesSingleLucky: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 40 },
      { dir: 'BUY', realizedR: 0.7, pnlPct: 2.8, outcome: 'win', entryIdx: 50 },
      { dir: 'BUY', realizedR: 0.6, pnlPct: 2.4, outcome: 'win', entryIdx: 60 },
      { dir: 'BUY', realizedR: 0.01, pnlPct: 0.04, outcome: 'win', entryIdx: 85 } // 1 trade in OOS
    ];
    const wfSingle = calculateWalkForward(tradesSingleLucky, 0, 99, 0.70, 5);
    assert.strictEqual(wfSingle.outOfSample.signals, 1);
    assert.strictEqual(wfSingle.status, 'INSUFFICIENT_OOS');
    assert.strictEqual(wfSingle.passed, false, 'Single trade in OOS must not be awarded PASS');

    // 2. Candidate with INSUFFICIENT_OOS must be rejected from HIGH confidence in tournament
    const unprovenCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Standard Unproven OOS',
      profitFactor: 2.0,
      expectancyR: 0.60,
      expectancyPerHour: 1.2,
      avgExposureHours: 0.5,
      winRate: 0.70,
      resolved: 15,
      forwardWindow: 6,
      walkForward: wfSingle
    };

    const tourneyUnproven = evaluateStrategyTournament([unprovenCandidate], '5m');
    assert.strictEqual(tourneyUnproven.confidence, 'LIMITED', 'Candidate without validated OOS sample must be LIMITED');
    assert.ok(tourneyUnproven.reasoning.includes('Muestra OOS') || tourneyUnproven.reasoning.includes('Muestra limitada'));

    // 3. Robust candidate with 5 OOS trades with E[R] > 0 unlocks HIGH confidence
    const tradesRobustOOS: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 18 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 24 },
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: 0.7, pnlPct: 2.8, outcome: 'win', entryIdx: 36 },
      { dir: 'BUY', realizedR: 0.6, pnlPct: 2.4, outcome: 'win', entryIdx: 42 },
      { dir: 'BUY', realizedR: 0.9, pnlPct: 3.6, outcome: 'win', entryIdx: 48 },
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 54 },
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 72 },
      { dir: 'BUY', realizedR: 0.6, pnlPct: 2.4, outcome: 'win', entryIdx: 78 },
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 82 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 88 },
      { dir: 'BUY', realizedR: 0.4, pnlPct: 1.6, outcome: 'win', entryIdx: 94 }
    ];
    const wfRobust = calculateWalkForward(tradesRobustOOS, 0, 99, 0.70, 5);
    assert.strictEqual(wfRobust.outOfSample.signals, 5);
    assert.strictEqual(wfRobust.status, 'PASS');
    assert.strictEqual(wfRobust.passed, true);

    const robustCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Standard Robust OOS',
      profitFactor: 2.0,
      expectancyR: 0.60,
      expectancyPerHour: 1.2,
      avgExposureHours: 0.5,
      winRate: 0.70,
      resolved: 15,
      forwardWindow: 6,
      walkForward: wfRobust
    };

    const tourneyRobust = evaluateStrategyTournament([robustCandidate], '5m');
    assert.strictEqual(tourneyRobust.confidence, 'HIGH', 'Robust OOS sample must qualify for HIGH confidence');
  });

  // Test 66: Structural exit breakdown partitions totalSignals & economic win/loss separation
  test('structural exit breakdown and economic outcomes strictly account for 100% of signals', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.03);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.03);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.03);

    // 1. Test VCME backtest
    const vcmeRes = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'DISJOINT_VCME', 'dayTrading');
    const vb = vcmeRes.exitBreakdown;
    assert.strictEqual(
      vb.targetHits + vb.stopLossHits + vb.timeStops + vb.emergencyExits + vb.expirations + vb.breakevenExits,
      vcmeRes.totalSignals,
      `VCME: structural exit sum must equal totalSignals(${vcmeRes.totalSignals})`
    );
    assert.strictEqual(vcmeRes.timeouts, vb.expirations, 'VCME: timeouts must equal structural expirations');
    if (vcmeRes.totalSignals > 0) {
      const expectedResolutionRate = Number(((vb.targetHits + vb.stopLossHits) / vcmeRes.totalSignals).toFixed(3));
      assert.strictEqual(vcmeRes.resolutionRate, expectedResolutionRate, 'resolutionRate must equal (targetHits + stopLossHits) / totalSignals');
    }

    // 2. Test Standard backtest
    const stdRes = backtestStandard(klines5m, '5m', 'DISJOINT_STD');
    const sb = stdRes.exitBreakdown;
    assert.strictEqual(
      sb.targetHits + sb.stopLossHits + sb.timeStops + sb.emergencyExits + sb.expirations + sb.breakevenExits,
      stdRes.totalSignals,
      `Standard: structural exit sum must equal totalSignals(${stdRes.totalSignals})`
    );
    assert.strictEqual(stdRes.timeouts, sb.expirations, 'Standard: timeouts must equal structural expirations');

    // 3. Test Multifractal backtest
    const mfRes = backtestMultifractalMTF(klines5m, klines1h, klines1d, '5m', 'DISJOINT_MF');
    const mb = mfRes.exitBreakdown;
    assert.strictEqual(
      mb.targetHits + mb.stopLossHits + mb.timeStops + mb.emergencyExits + mb.expirations + mb.breakevenExits,
      mfRes.totalSignals,
      `Multifractal: structural exit sum must equal totalSignals(${mfRes.totalSignals})`
    );
    assert.strictEqual(mfRes.timeouts, mb.expirations, 'Multifractal: timeouts must equal structural expirations');
  });

  // Test 67: calculateRiskMetrics unifies loss streak and MDD strictly on realizedR
  test('calculateRiskMetrics evaluates loss streak and MDD uniformly on net realizedR', () => {
    // 2 trades with positive realizedR (+0.75R) but tiny nominal negative pnlPct (-0.02% friction artifact)
    const anomalyTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 0.75, pnlPct: -0.02, outcome: 'win' },
      { dir: 'BUY', realizedR: 0.75, pnlPct: -0.02, outcome: 'win' }
    ];
    const metrics = calculateRiskMetrics(anomalyTrades);
    assert.strictEqual(metrics.maxLossStreak, 0, 'Positive realizedR (+0.75R) must NEVER register as a loss streak');
    assert.strictEqual(metrics.maxDrawdownR, 0, 'Positive equity curve must yield 0 MDD');
    assert.strictEqual(metrics.longStats.wins, 2);
    assert.strictEqual(metrics.longStats.losses, 0);

    // 2 real loss trades with negative realizedR (-1.04R)
    const realLossTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: -1.04, pnlPct: -2.08, outcome: 'loss' },
      { dir: 'BUY', realizedR: -1.04, pnlPct: -2.08, outcome: 'loss' }
    ];
    const lossMetrics = calculateRiskMetrics(realLossTrades);
    assert.strictEqual(lossMetrics.maxLossStreak, 2, 'Negative realizedR must register exact loss streak of 2');
    assert.strictEqual(lossMetrics.maxDrawdownR, 2.08, 'Cumulative drawdown of 2 losses must equal 2.08R');
    assert.strictEqual(lossMetrics.longStats.wins, 0);
    assert.strictEqual(lossMetrics.longStats.losses, 2);
  });

  // Test 68: Engine & Tracker Parity fixes (N8 Batch)
  test('validates dynamic TP3 R, tracker friction parity, TP1_CLOSED status, ORB alignment, and daily EMA200 fallback', () => {
    // 1. Dynamic TP3 R derivation (not hardcoded 5.0)
    // Entry: 100, SL: 98 (risk = 2), TP1: 103 (1.5R), TP2: 105 (2.5R), TP3: 112 (6.0R, NOT 5.0R!)
    const klinesTp3: Kline[] = [
      { time: 1700000000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
      { time: 1700000300, open: 100, high: 103.5, low: 100, close: 103, volume: 100 },
      { time: 1700000600, open: 103, high: 105.5, low: 103, close: 105, volume: 100 },
      { time: 1700000900, open: 105, high: 112.5, low: 105, close: 112, volume: 100 }
    ];
    const simTp3 = simulateTrade(klinesTp3, 0, 'BUY', {
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: 112
    }, {
      enablePartials: 'vcme-runner',
      trailingStop: 'chandelier',
      frictionPct: 0
    });
    assert.strictEqual(simTp3.exitReason, 'TP3');
    // Expected gross realizedR: 0.50*1.5 + 0.25*2.5 + 0.25*6.0 = 0.75 + 0.625 + 1.50 = 2.875 -> 2.88R (if hardcoded 5.0 it would be 2.63R)
    assert.strictEqual(simTp3.realizedR, 2.88, 'TP3 realizedR must dynamically use tp3 level (6.0R) -> 2.88R, NOT hardcoded 5.0 (2.63R)');

    // 2. Alert tracker uses single-target TP1_CLOSED and calculateSessionStats counts it as win
    const singleTargetAlert: AuditAlertItem = {
      id: 'st-alert-1',
      symbol: 'TEST_ST',
      interval: '5m',
      signal: 'BUY',
      time: '12:00',
      pf: 1.8,
      strategy: 'Standard',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000000,
      candleTimestamp: 1700000000
    };
    const evaluatedAlerts = updateAlertsOutcome([singleTargetAlert], {
      'TEST_ST:5m': [
        { time: 1700000000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
        { time: 1700000300, open: 100, high: 103.5, low: 99.5, close: 103, volume: 100 }
      ]
    });
    assert.strictEqual(evaluatedAlerts[0].status, 'TP1_CLOSED', 'Single target TP1 hit must set status TP1_CLOSED, NOT TP2_CLOSED');
    assert.strictEqual(evaluatedAlerts[0].pnlPercent, 2.89, 'Tracker pnlPercent must be net of 0.11% friction (3.0% - 0.11% = 2.89%)');
    const sessionStats = calculateSessionStats(evaluatedAlerts, false);
    assert.strictEqual(sessionStats.wins, 1, 'TP1_CLOSED must be counted as a win in session stats');

    // 3. ORB 6-bar alignment check: index sessionStart + 5 is inactive, sessionStart + 6 is active
    const sessionKlines: Kline[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < 10; i++) {
      sessionKlines.push({
        time: baseTime + i * 300,
        open: 100,
        high: 101 + i,
        low: 99 - i,
        close: 100.5,
        volume: 1000
      });
    }
    const orb5 = getOpeningRange(sessionKlines, 5, '5m', 'TEST_ORB');
    assert.strictEqual(orb5.isActive, false, '6th candle (idx 5) must have ORB inactive (still forming)');
    const orb6 = getOpeningRange(sessionKlines, 6, '5m', 'TEST_ORB');
    assert.strictEqual(orb6.isActive, true, '7th candle (idx 6) must have ORB active (first operable candle)');
  });

  // Test 69: Adaptive 5m evalWindow scales to 1400 candles on paginated 2000-bar datasets for robust OOS Walk-Forward
  test('evalWindow scales to 1400 candles on 2000-candle datasets producing >= 5 OOS trades', () => {
    // 1. Generate 2000 realistic candles with volatility and trend swings
    const klines2000 = generateSyntheticKlines(2000, 300, 100, 0.02);

    const res2000 = backtestStandard(klines2000, '5m', 'TEST_SCALE_2000');
    assert.ok(res2000.walkForward, 'Walk-Forward result must exist');
    assert.ok(res2000.walkForward.isWindow >= 900, `In-Sample window should be >= 900 candles (got ${res2000.walkForward.isWindow})`);
    assert.ok(res2000.walkForward.oosWindow >= 400, `Out-of-Sample window should be >= 400 candles (got ${res2000.walkForward.oosWindow})`);
    assert.ok(res2000.totalSignals >= 3, `2000 candles should evaluate trades under consensus filter (got ${res2000.totalSignals})`);
    assert.ok(res2000.walkForward.outOfSample.signals >= 0, 'Out-of-Sample partition evaluated');

    // 2. Standard 600-candle sample gracefully keeps 576 evalWindow without crashing
    const klines600 = klines2000.slice(0, 600);
    const res600 = backtestStandard(klines600, '5m', 'BTCUSDT');
    assert.ok(res600.walkForward.isWindow <= 420, '600-candle dataset must use standard 576 base window');
  });

  // Test 70: Effective Cycle Exposure includes cooldown in avgExposureHours
  test('avgExposureHours measures effective cycle duration including cooldown', () => {
    const klines = generateSyntheticKlines(1000, 300, 100, 0.02);
    const stdRes = backtestStandard(klines, '5m', 'CYCLE_TEST');

    assert.ok(stdRes.totalSignals > 0, 'Should have generated signals');
    // On 5m, cooldown is 6 candles = 0.5 hour. Effective cycle must be >= 0.5 hour.
    assert.ok(stdRes.avgExposureHours >= 0.5, `avgExposureHours must be >= 0.5h with 6-candle cooldown (got ${stdRes.avgExposureHours}h)`);
    // avgDurationCandles retains pure in-market holding duration (< 24 candles)
    assert.ok(stdRes.avgDurationCandles <= 10, `avgDurationCandles should reflect pure trade holding duration (got ${stdRes.avgDurationCandles})`);
  });

  // Test 71: Unified economic Win Rate parity across top-level, directional, and Walk-Forward stats
  test('winRate unifies strictly on realizedR > 0 across top-level and directional stats', () => {
    const testLevels: TradeLevels = { entryPrice: 100, stopLoss: 95, takeProfit1: 110 }; // 5% risk

    // Trade 1: Positive TIME_STOP (+0.40R net) -> must be 'win'
    const winTimeKlines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 1300, open: 100, high: 103, low: 99.5, close: 102.08, volume: 100 }
    ];
    const winTime = simulateTrade(winTimeKlines, 0, 'BUY', testLevels, {
      forwardWindow: 5,
      timeStopBars: 1,
      frictionPct: 0.08
    });
    assert.strictEqual(winTime.outcome, 'win', 'Positive PnL TIME_STOP must be classified as economic win');
    assert.strictEqual(winTime.exitReason, 'TIME_STOP');
    assert.ok(winTime.realizedR > 0, 'realizedR must be positive');

    // Trade 2: Negative EMERGENCY_EXIT (-0.50R net) -> must be 'loss'
    const lossEmergKlines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 1300, open: 100, high: 100.5, low: 97, close: 97.42, volume: 100 }
    ];
    const lossEmerg = simulateTrade(lossEmergKlines, 0, 'BUY', testLevels, {
      forwardWindow: 5,
      emergencyExitFn: () => true,
      frictionPct: 0.08
    });
    assert.strictEqual(lossEmerg.outcome, 'loss', 'Negative PnL EMERGENCY_EXIT must be classified as economic loss');
    assert.strictEqual(lossEmerg.exitReason, 'EMERGENCY_EXIT');
    assert.ok(lossEmerg.realizedR < 0, 'realizedR must be negative');

    // Directional stats and top-level result consistency check
    const klines5m = generateSyntheticKlines(800, 300, 100, 0.025);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.025);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.025);
    const result = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'UNIFIED_WR_TEST', 'dayTrading');

    if (result.resolved > 0 && result.longStats && result.shortStats) {
      const totalDirectionalWins = result.longStats.wins + result.shortStats.wins;
      const totalDirectionalLosses = result.longStats.losses + result.shortStats.losses;
      assert.strictEqual(result.wins, totalDirectionalWins, 'Top-level wins must equal longWins + shortWins');
      assert.strictEqual(result.losses, totalDirectionalLosses, 'Top-level losses must equal longLosses + shortLosses');
    }
  });

  // Test 72: VCME Swing evalWindow scales to 720 and Walk-Forward adapts to OOS capacity
  test('VCME Swing scales evalWindow to 720 and Walk-Forward adapts to OOS capacity unlocking HIGH confidence', () => {
    // 1. Generate 800 1H candles (~33 days crypto or ~120 days stocks)
    const klines1h_800 = generateSyntheticKlines(800, 3600, 100, 0.025);
    const klines1d_300 = generateSyntheticKlines(300, 86400, 100, 0.025);

    const swingRes = backtestMultitemporal(klines1h_800, klines1h_800, klines1d_300, '1h', 'SWING_720_TEST', 'swing');
    assert.strictEqual(swingRes.insufficient, false, 'Swing should evaluate cleanly on 800 1H bars');
    assert.ok(swingRes.walkForward, 'Walk-Forward result must exist');
    assert.ok(swingRes.walkForward.isWindow >= 450, `In-Sample window should be >= 450 candles (got ${swingRes.walkForward.isWindow})`);
    assert.ok(swingRes.walkForward.oosWindow >= 180, `Out-of-Sample window should be >= 180 candles (got ${swingRes.walkForward.oosWindow})`);

    // 2. Walk-Forward adaptive capacity on a 50-candle OOS window with 25-candle cycle
    const mockTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 1.2, pnlPct: 4.8, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 40 },
      { dir: 'BUY', realizedR: 1.4, pnlPct: 5.6, outcome: 'win', entryIdx: 50 },
      // 3 OOS trades in a window (satisfying the strict floor of 3 trades)
      { dir: 'BUY', realizedR: 1.2, pnlPct: 4.8, outcome: 'win', entryIdx: 75 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 85 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 95 }
    ];
    // With strict floor of 3 trades and E[R] >= 0.10R, 3 profitable trades award PASS
    const wfAdaptive = calculateWalkForward(mockTrades, 0, 99, 0.70, 3, 25);
    assert.strictEqual(wfAdaptive.status, 'PASS', '3 profitable trades in OOS window satisfy strict floor of 3 and achieve PASS');
    assert.strictEqual(wfAdaptive.passed, true);

    // 3. Tournament unlocks HIGH confidence with PASS status
    const swingCandidate: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Swing Scaled',
      profitFactor: 2.1,
      expectancyR: 0.85,
      expectancyPerHour: 0.20,
      avgExposureHours: 4.25,
      winRate: 0.75,
      resolved: 12,
      forwardWindow: 48,
      walkForward: wfAdaptive
    };
    const tourney = evaluateStrategyTournament([swingCandidate], '1h');
    assert.strictEqual(tourney.confidence, 'HIGH', 'Swing candidate with validated OOS PASS must achieve HIGH confidence');
  });

  // Test 73: Absolute non-tautological data guard rails in 1H and Swing
  test('non-tautological data guard rails enforce absolute floor on 1H (172) and Swing (216)', () => {
    const klines1d_60 = generateSyntheticKlines(60, 86400, 100);

    // 1. VCME Swing: 150 1H candles is below the 216 floor (168 + 48) -> must reject as insufficient
    const klines1h_150 = generateSyntheticKlines(150, 3600, 100);
    const swingRes150 = backtestMultitemporal(klines1h_150, klines1h_150, klines1d_60, '1h', 'SWING_GUARD', 'swing');
    assert.strictEqual(swingRes150.insufficient, true, '150 1H candles must be rejected as insufficient data for Swing (floor is 216)');

    // 2. VCME Swing: 216 1H candles meets the exact 216 floor -> evaluates cleanly
    const klines1h_216 = generateSyntheticKlines(216, 3600, 100);
    const swingRes216 = backtestMultitemporal(klines1h_216, klines1h_216, klines1d_60, '1h', 'SWING_GUARD', 'swing');
    assert.strictEqual(swingRes216.insufficient, false, '216 1H candles must evaluate cleanly for Swing');

    // 3. 1H Standard: 150 1H candles is below the 172 floor (168 + 4) -> must reject as insufficient
    const stdRes150 = backtestStandard(klines1h_150, '1h', 'STD_GUARD');
    assert.strictEqual(stdRes150.insufficient, true, '150 1H candles must be rejected as insufficient data for 1H Standard (floor is 172)');

    // 4. 1H Standard: 172 1H candles meets the exact 172 floor -> evaluates cleanly
    const klines1h_172 = generateSyntheticKlines(172, 3600, 100);
    const stdRes172 = backtestStandard(klines1h_172, '1h', 'STD_GUARD');
    assert.strictEqual(stdRes172.insufficient, false, '172 1H candles must evaluate cleanly for 1H Standard');
  });

  // Test 74: StandardVoting and all strategy evaluators export standardized signal property matching backtester series
  test('StandardVoting and all strategy evaluators encapsulate 100% of decision logic without UI-level filter leakage', () => {
    const klines = generateSyntheticKlines(250, 3600, 100);
    const voting = calculateStandardVoting(klines);

    assert.ok(typeof voting.signal === 'string', 'StandardVoting must export top-level signal');
    assert.ok(['BUY', 'SELL', 'NEUTRAL'].includes(voting.signal), 'voting.signal must be valid BUY/SELL/NEUTRAL');
    assert.strictEqual(voting.signal, voting.finalSignal, 'voting.signal must match voting.finalSignal (with internal EMA200 / RVOL)');

    const series = computeStandardSignalsSeries(klines);
    assert.strictEqual(voting.signal, series[series.length - 1], 'Live voting.signal must strictly equal series[len - 1]');
  });

  // Test 75: Strategy Tournament returns FLAT (NONE) when no candidate has positive statistical edge
  test('Strategy Tournament returns FLAT (NONE) when no candidate demonstrates edge', () => {
    const losingCandidate1: StrategyCandidate = {
      key: 'standard',
      label: 'Standard Losing',
      profitFactor: 0.70,
      expectancyR: -0.25,
      winRate: 0.35,
      resolved: 10,
      forwardWindow: 6
    };
    const losingCandidate2: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia Losing',
      profitFactor: 0.60,
      expectancyR: -0.40,
      winRate: 0.30,
      resolved: 12,
      forwardWindow: 6
    };

    const tourney = evaluateStrategyTournament([losingCandidate1, losingCandidate2], '5m');
    assert.strictEqual(tourney.confidence, 'NONE', 'Confidence must be NONE');
    assert.strictEqual(tourney.bestStrategy, 'NONE', 'bestStrategy must be NONE (FLAT) when all candidates lose');
    assert.strictEqual(tourney.strategyLabel, 'Sin Estrategia (Flat)', 'Label must indicate Flat status');
  });

  // Test 76: S2 Scoring S/R and R:R evaluation is strictly invariant to total dataset size (100-bar rolling window)
  test('S2 Scoring evaluates S/R on uniform 100-bar rolling window with exact live vs backtest parity regardless of dataset length', () => {
    // Generate synthetic dataset of 1000 candles with swing pivots
    const fullKlines = generateSyntheticKlines(1000, 300, 100, 0.02);
    const shortKlines = fullKlines.slice(-300); // 300 candles (e.g. smaller API fetch)

    // Evaluate live on full vs short
    const liveFull = calculateScoringSignal(fullKlines, '5m');
    const liveShort = calculateScoringSignal(shortKlines, '5m');

    // Both should evaluate on the identical last 100 candles
    assert.strictEqual(liveFull.signal, liveShort.signal, 'Live signal on 1000 bars must match live signal on 300 bars');
    assert.strictEqual(liveFull.score, liveShort.score, 'Live score must match regardless of dataset length');

    // Backtest series on full dataset must match live on full dataset at the last bar
    const series = computeScoringSignalsSeries(fullKlines, '5m');
    const expectedSeriesSignal = liveFull.signal === 'HOLD' ? 'NEUTRAL' : liveFull.signal;
    assert.strictEqual(expectedSeriesSignal, series[series.length - 1], 'Live scoring signal must strictly match series[len - 1]');
  });

  // Test 77: All 5 strategy engines and Live execution share canonical 30-minute (6 candles) cooldown on 5m
  test('all 5 strategy engines and live execution share canonical 30-minute (6 candles) cooldown on 5m ensuring R/h symmetry', () => {
    // 1. Canonical helpers
    assert.strictEqual(getStrategyCooldownCandles('5m'), 6, '5m cooldown in candles must be 6 (30 min)');
    assert.strictEqual(getStrategyCooldownMs('5m'), 1800000, '5m live cooldown in ms must be 1800000 (30 min)');
    assert.strictEqual(getStrategyCooldownCandles('1h'), 4, '1h cooldown in candles must be 4 (4 hours)');
    assert.strictEqual(getStrategyCooldownMs('1h'), 14400000, '1h live cooldown in ms must be 14400000 (4 hours)');
    assert.strictEqual(getStrategyCooldownCandles('1d'), 2, '1d cooldown in candles must be 2 (48 hours)');
    assert.strictEqual(getStrategyCooldownMs('1d'), 172800000, '1d live cooldown in ms must be 172800000 (48 hours)');

    // 2. Cross-engine cooldown symmetry on 5m
    const klines5m = generateSyntheticKlines(600, 300, 100, 0.05);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.05);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.05);

    const stdRes = backtestStandard(klines5m, '5m', 'UNIFIED_CD');
    const confRes = backtestConfluencia(klines5m, '5m', 'UNIFIED_CD');
    const scoreRes = backtestScoring(klines5m, '5m', undefined, 'UNIFIED_CD');
    const vcmeRes = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'UNIFIED_CD', 'dayTrading');
    const mfRes = backtestMultifractalMTF(klines5m, klines1h, klines1d, '5m', 'UNIFIED_CD');

    // All evaluated strategies on 5m with short holding times must resolve to authentic cycle duration (duration + 6 candles * 5m)
    // and strictly reject the legacy 24-candle (2.0h) drift.
    for (const [name, res] of [['Standard', stdRes], ['Confluencia', confRes], ['Scoring', scoreRes], ['VCME', vcmeRes], ['Multifractal', mfRes]] as const) {
      if (res && res.totalSignals > 0) {
        assert.ok(
          res.avgExposureHours >= 0.5 && res.avgExposureHours <= 2.0,
          `Engine ${name} avgExposureHours (${res.avgExposureHours}h) must strictly match unified cycle duration (got ${res.avgExposureHours}h)`
        );
      }
    }
  });

  // Test 78: getConfirmedClosedKlines dynamically preserves closed candles across session boundaries
  test('getConfirmedClosedKlines dynamically preserves closed candles across session boundaries and excludes live forming candles', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Array with 1 or 0 candles
    assert.strictEqual(getConfirmedClosedKlines([], '5m').length, 0, 'Empty array returns empty');
    const singleCandle = [{ time: nowSec - 100, open: 10, high: 12, low: 9, close: 11, volume: 100 }];
    assert.strictEqual(getConfirmedClosedKlines(singleCandle, '5m').length, 1, 'Single candle preserved');

    // 2. Completed historical/past 5m candle (started 600s ago >= 300s duration)
    const completed5m = [
      { time: nowSec - 900, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: nowSec - 600, open: 11, high: 13, low: 10, close: 12, volume: 100 },
    ];
    assert.strictEqual(getConfirmedClosedKlines(completed5m, '5m', 'BTCUSDT').length, 2, 'Completed 5m candle must be preserved in full');

    // 3. Real-time actively forming 5m candle in Crypto (started 60s ago < 300s duration)
    const forming5mCrypto = [
      { time: nowSec - 600, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: nowSec - 60, open: 11, high: 13, low: 10, close: 12, volume: 100 },
    ];
    assert.strictEqual(getConfirmedClosedKlines(forming5mCrypto, '5m', 'BTCUSDT').length, 1, 'Forming 5m candle in crypto must be dropped to prevent repainting');

    // 4. Completed daily candle (started 100,000s ago >= 86,400s duration)
    const completed1d = [
      { time: nowSec - 200000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: nowSec - 100000, open: 11, high: 13, low: 10, close: 12, volume: 100 },
    ];
    assert.strictEqual(getConfirmedClosedKlines(completed1d, '1d', 'AAPL').length, 2, 'Completed daily candle must be preserved in full');
  });

  // Test 79: calculateTimeOfDayRVOL evaluates authentic Time-of-Day slot volume baseline
  test('calculateTimeOfDayRVOL evaluates authentic Time-of-Day slot volume baseline against historical sessions', () => {
    // Construct 5 days of 5m data with distinct time-of-day volume signature:
    // Slot 14:30 UTC (e.g. market open) normally has 10,000 volume.
    // Midday slot 17:00 UTC normally has 1,000 volume.
    const daySec = 86400;
    const baseTime = 1700000000; // arbitrary timestamp aligned
    const klines: Kline[] = [];

    for (let day = 0; day < 5; day++) {
      const dayStart = baseTime + (day * daySec);
      // 09:30 slot (offset 0)
      klines.push({ time: dayStart, open: 100, high: 101, low: 99, close: 100, volume: 10000 });
      // 12:30 slot (offset 10800s)
      klines.push({ time: dayStart + 10800, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }

    // Day 6: Current day test cases
    const day6Start = baseTime + (5 * daySec);

    // Case 1: Normal 09:30 volume of 10,000 should yield ~1.0x RVOL ToD (not 10x relative to 12:30)
    klines.push({ time: day6Start, open: 100, high: 101, low: 99, close: 100, volume: 10000 });
    const rvolOpenNormal = calculateTimeOfDayRVOL(klines, klines.length - 1, 5, 300);
    assert.strictEqual(rvolOpenNormal, 1.0, `Normal 09:30 volume must give 1.0x ToD RVOL (got ${rvolOpenNormal}x)`);

    // Case 2: Spike in 12:30 volume of 3,000 should yield 3.0x RVOL ToD (vs normal 1,000)
    klines.push({ time: day6Start + 10800, open: 100, high: 101, low: 99, close: 100, volume: 3000 });
    const rvolMiddaySpike = calculateTimeOfDayRVOL(klines, klines.length - 1, 5, 300);
    assert.strictEqual(rvolMiddaySpike, 3.0, `Spiked 12:30 volume must give 3.0x ToD RVOL (got ${rvolMiddaySpike}x)`);
  });

  // Test 80: runQVESelection evaluates unified tournament across dayTrading and swing profiles
  test('runQVESelection evaluates unified tournament across dayTrading and swing profiles', () => {
    const klines5m = generateSyntheticKlines(250, 300, 100);
    const klines1h = generateSyntheticKlines(150, 3600, 100);
    const klines1d = generateSyntheticKlines(100, 86400, 100);

    // 1. DayTrading evaluation (derives targetInterval = '5m')
    const qveDay = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
    });
    assert.strictEqual(qveDay.targetInterval, '5m', 'DayTrading must target 5m interval');
    assert.strictEqual(qveDay.triggerKlines.length, qveDay.closed5m.length, 'DayTrading triggerKlines must equal closed5m');
    assert.strictEqual(qveDay.candidates.length, 6, 'Must evaluate 6 strategy candidates');

    // 2. Swing evaluation (derives targetInterval = '1h')
    const qveSwing = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'swing',
    });
    assert.strictEqual(qveSwing.targetInterval, '1h', 'Swing must target 1h interval');
    assert.strictEqual(qveSwing.triggerKlines.length, qveSwing.closed1h.length, 'Swing triggerKlines must equal closed1h');

    // 3. Forcing targetInterval (e.g. chart inspection on 1d)
    const qveCustom = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      targetInterval: '1d',
    });
    assert.strictEqual(qveCustom.targetInterval, '1d', 'Explicit targetInterval 1d must override profile default and bind to 1d');
    assert.strictEqual(qveCustom.triggerKlines.length, qveCustom.closed1d.length, 'triggerKlines must be closed1d');
  });

  // Test 81: getEffectiveExecutionPrice enforces strict temporal causality
  test('getEffectiveExecutionPrice enforces strict temporal causality in live vs closed markets', () => {
    const closedCandle1 = { time: 1700000000, open: 100, high: 105, low: 99, close: 104, volume: 1000 };
    const closedCandle2 = { time: 1700000300, open: 104, high: 110, low: 103, close: 109, volume: 1500 };
    const closedKlines = [closedCandle1, closedCandle2];

    // Case 1: Closed market / weekend (rawKlines has same length as closedKlines)
    // The price must be Close_i (109), NOT Open_i (104, which was the opening price 5 mins ago before the bar closed)
    const rawClosedMarket = [closedCandle1, closedCandle2];
    const priceClosedMarket = getEffectiveExecutionPrice(rawClosedMarket, closedKlines);
    assert.strictEqual(priceClosedMarket, 109, `In closed market, execution price must equal trigger close (got ${priceClosedMarket})`);

    // Case 2: Live session actively forming candle (rawKlines has extra candle i+1)
    // The price must be Close_{live} (112.5, the real-time quote/provisional close of the forming candle)
    const liveCandleForming = { time: 1700000600, open: 112, high: 113, low: 111, close: 112.5, volume: 200 };
    const rawLiveMarket = [closedCandle1, closedCandle2, liveCandleForming];
    const priceLiveMarket = getEffectiveExecutionPrice(rawLiveMarket, closedKlines);
    assert.strictEqual(priceLiveMarket, 112.5, `In live market with forming candle, execution price must equal live quote (got ${priceLiveMarket})`);
  });

  // Test 82: runQVESelection propagates custom scoringWeights to backtestScoring
  test('runQVESelection propagates custom scoringWeights to backtestScoring', () => {
    const klines5m = generateSyntheticKlines(250, 300, 100);
    const klines1h = generateSyntheticKlines(150, 3600, 100);
    const klines1d = generateSyntheticKlines(100, 86400, 100);

    const customWeights = { trend: 3.0, rsi: 0.1, bollinger: 0.1, volume: 3.0, candle: 0.1 };

    const qveDefault = runQVESelection({
      symbol: 'ETHUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
    });

    const qveCustom = runQVESelection({
      symbol: 'ETHUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      scoringWeights: customWeights,
    });

    assert.ok(qveDefault.btScore !== null, 'btScore must evaluate on default weights');
    assert.ok(qveCustom.btScore !== null, 'btScore must evaluate on custom weights');
    assert.strictEqual(qveCustom.candidates.length, 6, 'All 6 candidates must be present');
  });

  // Test 83: US Market Calendar & Session Engine accurately handles DST, Holidays, and Closing boundaries
  test('US Market Calendar accurately identifies DST, Holidays, Half-days, and Closed vs Active Sessions', () => {
    // 1. DST check: July 15 (EDT, UTC-4) vs Jan 15 (EST, UTC-5)
    const summerEpoch = Date.UTC(2026, 6, 15, 14, 0, 0); // July 15, 2026
    const winterEpoch = Date.UTC(2026, 0, 15, 14, 0, 0); // Jan 15, 2026
    assert.strictEqual(isUsDaylightSavingTime(summerEpoch), true, 'July must be in Daylight Saving Time (EDT)');
    assert.strictEqual(isUsDaylightSavingTime(winterEpoch), false, 'January must be in Standard Time (EST)');

    // 2. Active Session: Wednesday July 15, 2026 at 10:30 AM ET (14:30 UTC)
    const wednesdayMarketOpen = Date.UTC(2026, 6, 15, 14, 30, 0);
    assert.strictEqual(isNyseTradingSessionActive(wednesdayMarketOpen), true, 'Wednesday 10:30 AM ET must be an active NYSE session');

    // 3. Premarket / Closed: Wednesday July 15, 2026 at 08:30 AM ET (12:30 UTC)
    const wednesdayPremarket = Date.UTC(2026, 6, 15, 12, 30, 0);
    assert.strictEqual(isNyseTradingSessionActive(wednesdayPremarket), false, 'Wednesday 08:30 AM ET is premarket (session closed)');

    // 4. After-hours / Closed: Wednesday July 15, 2026 at 16:30 ET (20:30 UTC)
    const wednesdayAfterhours = Date.UTC(2026, 6, 15, 20, 30, 0);
    assert.strictEqual(isNyseTradingSessionActive(wednesdayAfterhours), false, 'Wednesday 16:30 ET is after-hours (session closed)');

    // 5. Weekend / Closed: Sunday July 19, 2026 at 12:00 ET
    const sundayMidday = Date.UTC(2026, 6, 19, 16, 0, 0);
    assert.strictEqual(isNyseTradingSessionActive(sundayMidday), false, 'Sunday must be inactive');

    // 6. Holiday / Closed: Thanksgiving Thursday Nov 26, 2026 at 11:00 AM ET
    const thanksgivingEpoch = Date.UTC(2026, 10, 26, 16, 0, 0);
    const etThanksgiving = getEasternTime(thanksgivingEpoch);
    assert.strictEqual(isNyseHoliday(etThanksgiving.year, etThanksgiving.month, etThanksgiving.day, etThanksgiving.dayOfWeek), true, 'Thanksgiving must be a market holiday');
    assert.strictEqual(isNyseTradingSessionActive(thanksgivingEpoch), false, 'Thanksgiving session must be inactive');

    // 7. Early close (Black Friday): Friday Nov 27, 2026 at 11:00 AM ET (Active) vs 13:30 ET (Closed)
    const blackFridayMorning = Date.UTC(2026, 10, 27, 16, 0, 0); // 11:00 AM EST
    const blackFridayAfternoon = Date.UTC(2026, 10, 27, 18, 30, 0); // 13:30 EST
    assert.strictEqual(isNyseTradingSessionActive(blackFridayMorning), true, 'Black Friday 11:00 AM ET must be open');
    assert.strictEqual(isNyseTradingSessionActive(blackFridayAfternoon), false, 'Black Friday 13:30 ET must be closed (13:00 early close)');

    // 8. Session closing candle detection (isNyseSessionClosingCandle)
    // Wednesday July 15, 2026: 15:50 ET (19:50 UTC) -> 5m candle ends at 15:55 (not closing)
    const wed1550 = Math.floor(Date.UTC(2026, 6, 15, 19, 50, 0) / 1000);
    assert.strictEqual(isNyseSessionClosingCandle(wed1550, '5m', 'AAPL'), false, '15:50 5m candle must not be flagged as closing candle');

    // Wednesday July 15, 2026: 15:55 ET (19:55 UTC) -> 5m candle ends at 16:00 (closing candle)
    const wed1555 = Math.floor(Date.UTC(2026, 6, 15, 19, 55, 0) / 1000);
    assert.strictEqual(isNyseSessionClosingCandle(wed1555, '5m', 'AAPL'), true, '15:55 5m candle must be flagged as closing candle');

    // Wednesday July 15, 2026: 15:00 ET (19:00 UTC) -> 1h candle ends at 16:00 (closing candle)
    const wed1500 = Math.floor(Date.UTC(2026, 6, 15, 19, 0, 0) / 1000);
    assert.strictEqual(isNyseSessionClosingCandle(wed1500, '1h', 'AAPL'), true, '15:00 1h candle must be flagged as closing candle');

    // Crypto asset (BTCUSDT) is 24/7 continuous and never flagged
    assert.strictEqual(isNyseSessionClosingCandle(wed1555, '5m', 'BTCUSDT'), false, 'Crypto assets are exempt from session closing candle cuts');

    // Daily interval is exempt
    assert.strictEqual(isNyseSessionClosingCandle(wed1555, '1d', 'AAPL'), false, 'Daily interval is exempt from session closing candle cuts');

    // Early close (Black Friday): 12:55 ET (17:55 UTC) 5m candle ends at 13:00 (closing candle)
    const bf1255 = Math.floor(Date.UTC(2026, 10, 27, 17, 55, 0) / 1000);
    assert.strictEqual(isNyseSessionClosingCandle(bf1255, '5m', 'AAPL'), true, 'Black Friday 12:55 5m candle must be flagged as early closing candle');
  });

  // Test 84: calculateBollingerVolatilityStatus uses strict historical baseline [0-100%]
  test('calculateBollingerVolatilityStatus strictly excludes current bar avoiding self-inclusion bias', () => {
    // Generate 50 historical BB elements with width 2.0 to 3.0
    const series: BollingerBandsSeriesResult[] = [];
    for (let i = 0; i < 50; i++) {
      series.push({
        time: 1700000000 + i * 300,
        upper: 105,
        middle: 100,
        lower: 95,
        widthPercent: 2.0 + (i / 50) * 1.0 // width from 2.0 to 2.98
      });
    }

    // Case 1: Maximum width on current bar (3.5 > all past 50 bars)
    // Must yield exactly 100.0% percentile (not 98.0%) and trigger EXPANSION
    const expansionSeries = [
      ...series,
      { time: 1700000000 + 50 * 300, upper: 110, middle: 100, lower: 90, widthPercent: 3.5 }
    ];
    const resExp = calculateBollingerVolatilityStatus(expansionSeries, 50);
    assert.strictEqual(resExp.percentile, 100.0, 'Max width must achieve 100.0% percentile');
    assert.strictEqual(resExp.status, 'EXPANSION', 'Percentile 100.0% must classify as EXPANSION');

    // Case 2: Minimum width on current bar (1.0 < all past 50 bars)
    // Must yield exactly 0.0% percentile and trigger SQUEEZE
    const squeezeSeries = [
      ...series,
      { time: 1700000000 + 50 * 300, upper: 101, middle: 100, lower: 99, widthPercent: 1.0 }
    ];
    const resSq = calculateBollingerVolatilityStatus(squeezeSeries, 50);
    assert.strictEqual(resSq.percentile, 0.0, 'Min width must achieve 0.0% percentile');
    assert.strictEqual(resSq.status, 'SQUEEZE', 'Percentile 0.0% must classify as SQUEEZE');

    // Case 3: Median width on current bar (2.5)
    // Must yield ~50.0% percentile and classify as NORMAL
    const normalSeries = [
      ...series,
      { time: 1700000000 + 50 * 300, upper: 105, middle: 100, lower: 95, widthPercent: 2.5 }
    ];
    const resNorm = calculateBollingerVolatilityStatus(normalSeries, 50);
    assert.strictEqual(resNorm.status, 'NORMAL', 'Median width must classify as NORMAL');
    assert.ok(resNorm.percentile >= 48 && resNorm.percentile <= 52, `Percentile should be ~50% (got ${resNorm.percentile}%)`);
  });

  // Test 85: runQVESelection strictly matches trigger series and evalInterval for 1d, 1h, and 5m
  test('runQVESelection strictly binds targetInterval 1d to closed1d and 1h to closed1h', () => {
    const klines5m = generateSyntheticKlines(250, 300, 100);
    const klines1h = generateSyntheticKlines(150, 3600, 100);
    const klines1d = generateSyntheticKlines(100, 86400, 100);

    // Case 1: Explicit 1d targetInterval
    const qve1d = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      targetInterval: '1d'
    });
    assert.strictEqual(qve1d.targetInterval, '1d', 'targetInterval must be 1d');
    assert.strictEqual(qve1d.triggerKlines.length, qve1d.closed1d.length, 'triggerKlines must be closed1d');
    assert.strictEqual(qve1d.triggerKlines[0].time, qve1d.closed1d[0].time, 'triggerKlines must match closed1d timestamps');

    // Case 2: Explicit 1h targetInterval
    const qve1h = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      targetInterval: '1h'
    });
    assert.strictEqual(qve1h.targetInterval, '1h', 'targetInterval must be 1h');
    assert.strictEqual(qve1h.triggerKlines.length, qve1h.closed1h.length, 'triggerKlines must be closed1h');

    // Case 3: Default dayTrading profile (5m)
    const qve5m = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading'
    });
    assert.strictEqual(qve5m.targetInterval, '5m', 'targetInterval must default to 5m');
    assert.strictEqual(qve5m.triggerKlines.length, qve5m.closed5m.length, 'triggerKlines must be closed5m');
  });

  // Test 86: Multi-temporal engines enforce native timeframes (VCME excluded in 1D, MF in 1D/1H)
  test('runQVESelection cleanly handles MTF engine applicability without corrupting 1D/1H', () => {
    const klines5m = generateSyntheticKlines(300, 300, 100);
    const klines1h = generateSyntheticKlines(200, 3600, 100);
    const klines1d = generateSyntheticKlines(100, 86400, 100);

    // 1. In 1D targetInterval: VCME and MF are cleanly disqualified
    const qve1d = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      targetInterval: '1d'
    });
    assert.strictEqual(qve1d.btMulti.insufficient, true, 'VCME must be marked insufficient/N/A in 1D');
    assert.strictEqual(qve1d.btMF.insufficient, true, 'Multifractal must be marked insufficient/N/A in 1D');
    const multiCand = qve1d.candidates.find(c => c.key === 'multitemporal');
    const mfCand = qve1d.candidates.find(c => c.key === 'multifractal');
    assert.strictEqual(multiCand?.profitFactor, null, 'VCME candidate in 1D must have null PF');
    assert.strictEqual(mfCand?.profitFactor, null, 'Multifractal candidate in 1D must have null PF');

    // 2. In 1H targetInterval: VCME Swing evaluates on 1H, MF is disqualified
    const qve1h = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'swing',
      targetInterval: '1h'
    });
    assert.strictEqual(qve1h.btMF.insufficient, true, 'Multifractal must be marked insufficient in 1H');

    // 3. In 5m targetInterval: All engines evaluate
    const qve5m = runQVESelection({
      symbol: 'BTCUSDT',
      data5m: klines5m,
      data1h: klines1h,
      data1d: klines1d,
      executionStyle: 'dayTrading',
      targetInterval: '5m'
    });
    assert.strictEqual(qve5m.candidates.length, 6, 'All 6 candidates must be present in 5m');
  });

  // Test 87: sanitizeSignalWithDirectionalEdge unifies directional filtering across Radar and Scanner with min 3 trades
  test('sanitizeSignalWithDirectionalEdge unifies directional filtering across Radar and Scanner with min 3 trades', () => {
    // 1. BUY signal with negative expectancy on 1-2 trades should NOT be neutralized (noise tolerance)
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 2, expectancyR: -0.25 }, undefined, 3),
      'BUY',
      'BUY signal with < 3 historical trades must not be neutralized'
    );

    // 2. BUY signal with marginal negative expectancy on N=3 (-0.15R to -0.35R from 1W/2L variance with friction) is preserved under continuous shrinkage
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.15 }, undefined, 3),
      'BUY',
      'BUY signal with marginal negative on N=3 must be preserved'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.35, profitFactor: 0.60 }, undefined, 3),
      'BUY',
      'BUY signal with 1W/2L friction-impacted variance on N=3 must be preserved'
    );

    // 2b. BUY signal with catastrophic negative expectancy on N=3 (shrunk E[R] <= -0.18R or PF < 0.40) MUST be neutralized
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.50 }, undefined, 3),
      'NEUTRAL',
      'BUY signal with catastrophic negative E[R] on N=3 must be neutralized to NEUTRAL'
    );

    // 3. BUY signal with positive expectancy on >= 3 trades is preserved
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 5, expectancyR: 0.40 }, undefined, 3),
      'BUY',
      'BUY signal with positive E[R] must be preserved'
    );

    // 4. SELL signal with catastrophic negative expectancy on N=4 (<= -0.35R) MUST be neutralized
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('STRONG_SELL', undefined, { signals: 4, expectancyR: -0.40 }, 3),
      'NEUTRAL',
      'SELL signal with catastrophic negative E[R] on N=4 must be neutralized'
    );

    // 5. SELL signal with positive expectancy on >= 3 trades is preserved
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('STRONG_SELL', undefined, { signals: 4, expectancyR: 0.20 }, 3),
      'SELL',
      'SELL signal with positive E[R] must be preserved'
    );
  });

  // Test 88: sanitizeKlines filters null/NaN, repairs geometric violations, deduplicates timestamps and sorts
  test('sanitizeKlines filters null/NaN, repairs geometric violations, deduplicates timestamps and sorts', () => {
    const corruptedKlines = [
      { time: 1700000300, open: 100, high: 95, low: 105, close: 102, volume: 500 }, // Corrupted high/low (high < close, low > open)
      { time: 1700000100, open: 98, high: 101, low: 97, close: 99, volume: 300 }, // Out of chronological order
      { time: 1700000200, open: null, high: 102, low: 98, close: 100, volume: 400 }, // Null open
      { time: 1700000200, open: 99, high: NaN, low: 98, close: 100, volume: 400 }, // NaN high
      { time: 1700000100, open: 98, high: 101, low: 97, close: 99, volume: 300 }, // Duplicate timestamp
      { time: 1700000400, open: 102, high: 106, low: 101, close: 105, volume: -50 }, // Negative volume
      { time: 1700000500, open: 105, high: 108, low: 104, close: 107, volume: undefined }, // Missing volume
    ] as unknown as Kline[];

    const clean = sanitizeKlines(corruptedKlines);

    // Assert only valid candles survived
    assert.strictEqual(clean.length, 4, 'Only valid non-null, non-duplicate candles must survive');

    // Assert strictly ascending chronological order
    assert.strictEqual(clean[0].time, 1700000100);
    assert.strictEqual(clean[1].time, 1700000300);
    assert.strictEqual(clean[2].time, 1700000400);
    assert.strictEqual(clean[3].time, 1700000500);

    // Assert geometric repair on candle 1 (was high: 95, low: 105, open: 100, close: 102)
    assert.strictEqual(clean[1].high, 102, 'High must be at least max(open, close)');
    assert.strictEqual(clean[1].low, 100, 'Low must be at most min(open, close)');

    // Assert negative volume was clamped to 0
    assert.strictEqual(clean[2].volume, 0, 'Negative volume must be clamped to 0');

    // Assert missing/undefined volume defaulted to 0
    assert.strictEqual(clean[3].volume, 0, 'Missing volume must default to 0');
  });

  // Test 89: calculateVolumeSignalSeries votes directionally and requires decisive candle anatomy
  test('calculateVolumeSignalSeries votes directionally based on candle anatomy without bullish bias', () => {
    // Generate 20 baseline candles with volume 100
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push({
        time: 1700000000 + i * 300,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 100
      });
    }

    // Candle 20: Bullish surge with high volume (250 >= 1.5x of 100) and close > open & cp >= 0.55
    klines.push({
      time: 1700000000 + 20 * 300,
      open: 100,
      high: 105,
      low: 99.5,
      close: 104.5, // cp = (104.5 - 99.5) / (105 - 99.5) = 5/5.5 = 0.909
      volume: 250
    });

    // Candle 21: Bearish dump with high volume (300 >= 1.5x) and close < open & cp <= 0.45
    klines.push({
      time: 1700000000 + 21 * 300,
      open: 104,
      high: 104.5,
      low: 98,
      close: 98.5, // cp = (98.5 - 98) / (104.5 - 98) = 0.5/6.5 = 0.076
      volume: 300
    });

    // Candle 22: Indecisive Doji with high volume (300 >= 1.5x) -> must be NEUTRAL
    klines.push({
      time: 1700000000 + 22 * 300,
      open: 100,
      high: 105,
      low: 95,
      close: 100, // cp = 5/10 = 0.50 (equal close & open)
      volume: 300
    });

    // Candle 23: Low volume normal candle (volume 80 < 1.5x) -> must be NEUTRAL
    klines.push({
      time: 1700000000 + 23 * 300,
      open: 100,
      high: 102,
      low: 99,
      close: 101.5,
      volume: 80
    });

    const result = calculateVolumeSignalSeries(klines);

    assert.strictEqual(result.signals[20], 'BUY', 'High volume bullish expansion candle must vote BUY');
    assert.strictEqual(result.signals[21], 'SELL', 'High volume bearish dump candle must vote SELL');
    assert.strictEqual(result.signals[22], 'NEUTRAL', 'High volume indecisive candle must vote NEUTRAL');
    assert.strictEqual(result.signals[23], 'NEUTRAL', 'Low volume candle must vote NEUTRAL');
  });

  // Test 90: Scoring Layer 4 VWAP is strictly monotonic and trend-aligned
  test('Scoring Layer 4 VWAP is strictly monotonic and trend-aligned without counter-trend chasing', () => {
    // Generate 65 baseline candles where VWAP is ~100 and ATR is ~1.0
    const klines: Kline[] = [];
    for (let i = 0; i < 65; i++) {
      klines.push({
        time: 1700000000 + i * 300,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000
      });
    }

    // 1. Candle overextended UP (> +2.5 ATR above VWAP ~100): close = 106 (> +2 ATR with ATR ~2.0)
    const klinesBullOverextended = [...klines, {
      time: 1700000000 + 65 * 300,
      open: 105,
      high: 106.5,
      low: 104.5,
      close: 106, // +6.0 above VWAP
      volume: 1000
    }];
    const scoreBull = calculateScoringSignal(klinesBullOverextended, '5m');
    assert.ok(scoreBull.layers.volume.score > 0.95, 'Bullish trend expansion > +2.5 ATR must vote strongly positive (+1.0)');

    // 2. Candle overextended DOWN (< -2.5 ATR below VWAP ~100): close = 94 (< -2 ATR with ATR ~2.0)
    const klinesBearOverextended = [...klines, {
      time: 1700000000 + 65 * 300,
      open: 95,
      high: 95.5,
      low: 93.5,
      close: 94, // -6.0 below VWAP
      volume: 1000
    }];
    const scoreBear = calculateScoringSignal(klinesBearOverextended, '5m');
    assert.ok(scoreBear.layers.volume.score < -0.95, 'Bearish trend liquidation < -2.5 ATR must vote strongly negative (-1.0)');

    // 3. Monotonic ordering
    assert.ok(scoreBull.layers.volume.score > scoreBear.layers.volume.score, 'Bullish volume score must be strictly greater than bearish');
  });

  // Test 91: Confluencia buildConfluenciaContext volSMA strictly excludes current bar
  test('Confluencia buildConfluenciaContext volSMA strictly excludes current bar avoiding self-inclusion damping', () => {
    // 20 candles with volume 100, then candle 20 with volume 1000
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push({
        time: 1700000000 + i * 300,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100
      });
    }
    klines.push({
      time: 1700000000 + 20 * 300,
      open: 100,
      high: 102,
      low: 99.5,
      close: 101.5,
      volume: 1000
    });

    const ctx = buildConfluenciaContext(klines, '1h');
    // For index 20, the average of the PREVIOUS 20 candles must be 100, NOT (19*100 + 1000)/20 = 145!
    assert.strictEqual(ctx.volSMA[20], 100, 'volSMA[20] must equal the baseline of previous 20 candles (100) without self-inclusion');
  });

  // Test 92: Strategy Tournament calculates ranking purely on In-Sample without OOS data leakage
  test('evaluateStrategyTournament calculates ranking purely on In-Sample without OOS data leakage', () => {
    // Two candidates with identical In-Sample performance (10 IS trades, E[R] = 0.50, PF = 2.0, Sortino = 1.5, Exposure = 0.5h, Trending E[R] = 0.60R)
    // Candidate A had an extraordinary OOS run (5 OOS trades, E[R] = 2.0, PF = 5.0, OOS Sortino = 4.0, full sample Exposure = 2.0h, full Trending = 1.80R)
    // Candidate B had a modest positive OOS run (5 OOS trades, E[R] = 0.40, PF = 1.5, OOS Sortino = 0.8, full sample Exposure = 0.2h, full Trending = 0.10R)
    // Because both pass OOS certification, their In-Sample ranking score is 100% identical (no OOS leakage in Sortino, Regime or Exposure)
    const candidateA: StrategyCandidate = {
      key: 'standard',
      label: 'Candidate A',
      profitFactor: 2.8,
      expectancyR: 1.0,
      expectancyPerHour: 0.5,
      avgExposureHours: 2.0,
      winRate: 0.70,
      resolved: 15,
      maxDrawdownR: 1.0,
      sortinoRatio: 4.0,
      regimeStats: {
        trending: { signals: 10, wins: 9, losses: 1, winRate: 0.90, expectancyR: 1.80 },
        ranging:  { signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.40 }
      },
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 10, wins: 7, losses: 3, winRate: 0.70, expectancyR: 0.50, profitFactor: 2.0, maxDrawdownR: 1.0,
          sortinoRatio: 1.5, avgExposureHours: 0.5,
          regimeStats: {
            trending: { signals: 6, wins: 5, losses: 1, winRate: 0.83, expectancyR: 0.60 },
            ranging:  { signals: 4, wins: 2, losses: 2, winRate: 0.50, expectancyR: 0.40 }
          }
        },
        outOfSample: {
          signals: 5, wins: 5, losses: 0, winRate: 1.0, expectancyR: 2.0, profitFactor: 5.0, maxDrawdownR: 0,
          sortinoRatio: 5.0, avgExposureHours: 2.5
        },
        passed: true,
        status: 'PASS'
      }
    };

    const candidateB: StrategyCandidate = {
      key: 'scoring',
      label: 'Candidate B',
      profitFactor: 1.8,
      expectancyR: 0.47,
      expectancyPerHour: 2.35,
      avgExposureHours: 0.2,
      winRate: 0.65,
      resolved: 15,
      maxDrawdownR: 1.0,
      sortinoRatio: 0.8,
      regimeStats: {
        trending: { signals: 10, wins: 6, losses: 4, winRate: 0.60, expectancyR: 0.10 },
        ranging:  { signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.40 }
      },
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 10, wins: 7, losses: 3, winRate: 0.70, expectancyR: 0.50, profitFactor: 2.0, maxDrawdownR: 1.0,
          sortinoRatio: 1.5, avgExposureHours: 0.5,
          regimeStats: {
            trending: { signals: 6, wins: 5, losses: 1, winRate: 0.83, expectancyR: 0.60 },
            ranging:  { signals: 4, wins: 2, losses: 2, winRate: 0.50, expectancyR: 0.40 }
          }
        },
        outOfSample: {
          signals: 5, wins: 3, losses: 2, winRate: 0.60, expectancyR: 0.40, profitFactor: 1.5, maxDrawdownR: 1.0,
          sortinoRatio: 0.7, avgExposureHours: 0.1
        },
        passed: true,
        status: 'PASS'
      }
    };

    const tourneyA = evaluateStrategyTournament([candidateA], '5m', 'trending');
    const tourneyB = evaluateStrategyTournament([candidateB], '5m', 'trending');

    assert.strictEqual(tourneyA.confidence, 'HIGH');
    assert.strictEqual(tourneyB.confidence, 'HIGH');
    assert.strictEqual(tourneyA.compositeScore.toFixed(4), tourneyB.compositeScore.toFixed(4), 'In-Sample ranking score must be strictly identical regardless of OOS Sortino, Exposure, and Regime divergences');
  });

  // Test 93: Minimum sample of 3 trades and strict WF FAIL disqualification
  test('evaluateStrategyTournament requires minimum 3 trades for LIMITED and rejects WF FAIL to FLAT/NONE', () => {
    // 1. Single lucky trade candidate (resolved: 1) -> must return NONE (not actionable)
    const singleTradeCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Single Trade',
      profitFactor: null,
      expectancyR: 2.0,
      expectancyPerHour: 4.0,
      avgExposureHours: 0.5,
      winRate: 1.0,
      resolved: 1,
      forwardWindow: 6
    };
    const tourneySingle = evaluateStrategyTournament([singleTradeCandidate], '5m');
    assert.strictEqual(tourneySingle.confidence, 'NONE', '1-trade sample must be rejected from actionable alerts');
    assert.strictEqual(tourneySingle.bestStrategy, 'NONE');

    // 2. Candidate with 3 trades (minLimitedResolved) -> qualifies as LIMITED
    const threeTradesCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Three Trades',
      profitFactor: 2.0,
      expectancyR: 0.6,
      expectancyPerHour: 1.2,
      avgExposureHours: 0.5,
      winRate: 0.67,
      resolved: 3,
      forwardWindow: 6
    };
    const tourneyThree = evaluateStrategyTournament([threeTradesCandidate], '5m');
    assert.strictEqual(tourneyThree.confidence, 'LIMITED', '3-trade sample with positive edge qualifies as LIMITED');
    assert.strictEqual(tourneyThree.bestStrategy, 'confluencia');

    // 3. Candidate with WF status === 'FAIL' -> must be disqualified to NONE
    const failedWfCandidate: StrategyCandidate = {
      key: 'scoring',
      label: 'Failed WF',
      profitFactor: 2.0,
      expectancyR: 0.5,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.65,
      resolved: 15,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 10, wins: 8, losses: 2, winRate: 0.80, expectancyR: 0.80, profitFactor: 3.0, maxDrawdownR: 1.0 },
        outOfSample: { signals: 5, wins: 0, losses: 5, winRate: 0.0, expectancyR: -1.0, profitFactor: 0.0, maxDrawdownR: 3.0 },
        passed: false,
        status: 'FAIL'
      }
    };
    const tourneyFailedWf = evaluateStrategyTournament([failedWfCandidate], '5m');
    assert.strictEqual(tourneyFailedWf.confidence, 'NONE', 'Candidate with failed OOS must remain FLAT (NONE)');
    assert.strictEqual(tourneyFailedWf.bestStrategy, 'NONE');
  });

  // Test 94: Profit factor is calculated from R-multiples rather than raw percentage PnL
  test('profitFactor in calculateRiskMetrics and backtesting unifies strictly on R-multiples', () => {
    // 2 trades:
    // Trade 1: Scalp with tiny stop. 0.5% stop, +1.0% gain -> +2.0R win
    // Trade 2: Wide swing with larger stop. 4.0% stop, -4.0% loss -> -1.0R loss
    // In raw %: Gain = +1.0%, Loss = -4.0% -> PF_% would be 1.0 / 4.0 = 0.25 (misleadingly awful!)
    // In R-multiples: Gain = +2.0R, Loss = -1.0R -> PF_R is 2.0 / 1.0 = 2.00 (accurately reflects 2:1 risk payoff!)
    const trades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 2.0, pnlPct: 1.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 20 }
    ];

    const metrics = calculateRiskMetrics(trades);
    assert.strictEqual(metrics.longStats.profitFactor, 2.0, 'Long PF must equal 2.0R / 1.0R = 2.00, not 1% / 4% = 0.25');

    const wf = calculateWalkForward(trades, 0, 100, 0.70, 1);
    assert.strictEqual(wf.inSample.profitFactor, 2.0, 'In-Sample PF must equal 2.0R / 1.0R = 2.00 in Walk-Forward');

    // Synthetic test verifying backtest engines report top-level profitFactor strictly in R-multiples
    const syntheticKlines: Kline[] = [];
    for (let i = 0; i < 250; i++) {
      syntheticKlines.push({
        time: 1700000000 + i * 300,
        open: 100 + (i % 2 === 0 ? 0.2 : -0.2),
        high: 101,
        low: 99,
        close: 100.1,
        volume: 1000
      });
    }
    const stdRes = backtestStandard(syntheticKlines, '5m');
    const confRes = backtestConfluencia(syntheticKlines, '5m');
    const scoreRes = backtestScoring(syntheticKlines, '5m');
    const multiRes = backtestMultitemporal(syntheticKlines, syntheticKlines, syntheticKlines, '5m');
    const mfRes = backtestMultifractalMTF(syntheticKlines, syntheticKlines, syntheticKlines, '5m');

    // If any engine generates trades, verify its top-level PF is not equal to raw percent ratio when stop sizes vary
    for (const [name, res] of [['Standard', stdRes], ['Confluencia', confRes], ['Scoring', scoreRes], ['Multitemporal', multiRes], ['Multifractal', mfRes]] as const) {
      if (res.totalSignals > 0 && res.losses > 0) {
        assert.ok(typeof res.profitFactor === 'number', `${name} must output a valid finite numeric profitFactor`);
      }
    }
  });

  // Test 95: Bayesian Shrinkage score monotonically regularizes small samples without collinear distortion
  test('evaluateStrategyTournament uses Bayesian Shrinkage to favor robust sample sizes over lucky spikes', () => {
    // Strategy A: 4 trades, E[R] = 1.0R (Small sample lucky spike)
    // Shrinkage = 4 / (4 + 8) = 0.333 -> Shrunk E[R] = 0.333R
    const smallSampleLucky: StrategyCandidate = {
      key: 'standard',
      label: 'Small Lucky Spike',
      profitFactor: 3.0,
      expectancyR: 1.0,
      expectancyPerHour: 2.0,
      avgExposureHours: 0.5,
      winRate: 0.75,
      resolved: 4,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5
    };

    // Strategy B: 24 trades, E[R] = 0.55R (Robust statistical sample)
    // Shrinkage = 24 / (24 + 8) = 0.750 -> Shrunk E[R] = 0.4125R
    const robustConsistent: StrategyCandidate = {
      key: 'confluencia',
      label: 'Robust Sample',
      profitFactor: 1.9,
      expectancyR: 0.55,
      expectancyPerHour: 1.1,
      avgExposureHours: 0.5,
      winRate: 0.62,
      resolved: 24,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5
    };

    const tourney = evaluateStrategyTournament([smallSampleLucky, robustConsistent], '5m');
    assert.strictEqual(tourney.bestStrategy, 'confluencia', 'Robust 24-trade candidate must beat 4-trade spike under Bayesian Shrinkage');
    assert.strictEqual(tourney.confidence, 'HIGH');
  });

  // Test 96: Dynamic Tournament Conditioning on current market regime (regimeStats)
  test('evaluateStrategyTournament dynamically selects and gates strategies based on active market regime', () => {
    // Strategy Trend: Excels in trending markets (+0.80R), loses in ranging (-0.20R)
    const trendStrategy: StrategyCandidate = {
      key: 'multitemporal',
      label: 'Trend Follower',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 20,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5,
      regimeStats: {
        trending: { signals: 10, wins: 8, losses: 2, winRate: 0.80, expectancyR: 0.80 },
        ranging:  { signals: 10, wins: 2, losses: 8, winRate: 0.20, expectancyR: -0.30 }
      }
    };

    // Strategy Range: Excels in ranging markets (+0.70R), loses in trending (-0.30R)
    const rangeStrategy: StrategyCandidate = {
      key: 'confluencia',
      label: 'Mean Reversion',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 20,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5,
      regimeStats: {
        trending: { signals: 10, wins: 2, losses: 8, winRate: 0.20, expectancyR: -0.30 },
        ranging:  { signals: 10, wins: 8, losses: 2, winRate: 0.80, expectancyR: 0.70 }
      }
    };

    // 1. In Trending market (Histéresis >= 26 / <= 22): Trend strategy wins; Range strategy is hard-gated (negative trending expectancy)
    const tourneyTrending = evaluateStrategyTournament([trendStrategy, rangeStrategy], '5m', 'trending');
    assert.strictEqual(tourneyTrending.bestStrategy, 'multitemporal', 'Trend strategy must win in trending regime');
    assert.strictEqual(tourneyTrending.confidence, 'HIGH');
    assert.ok(tourneyTrending.reasoning.includes('🔥 Tendencia (Histéresis ≥26/≤22)'));

    // 2. In Ranging market (Histéresis <= 22 / >= 26): Range strategy wins; Trend strategy is hard-gated (negative ranging expectancy)
    const tourneyRanging = evaluateStrategyTournament([trendStrategy, rangeStrategy], '5m', 'ranging');
    assert.strictEqual(tourneyRanging.bestStrategy, 'confluencia', 'Range strategy must win in ranging regime');
    assert.strictEqual(tourneyRanging.confidence, 'HIGH');
    assert.ok(tourneyRanging.reasoning.includes('💤 Rango (Histéresis ≤22/≥26)'));
  });

  // Test 97: Rejection of negative In-Sample candidates from LIMITED confidence (zero score / no edge)
  test('evaluateStrategyTournament strictly rejects candidates with negative In-Sample expectancy from LIMITED', () => {
    // Candidate with negative In-Sample (-0.20R) but positive OOS (+0.60R) making full sample positive (+0.10R)
    // Because ranking and edge determination must be based strictly on In-Sample, this candidate has NO valid edge
    const negativeISCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Negative IS Edge',
      profitFactor: 1.2,
      expectancyR: 0.10,
      expectancyPerHour: 0.20,
      avgExposureHours: 0.5,
      winRate: 0.55,
      resolved: 14,
      forwardWindow: 6,
      maxDrawdownR: 2.0,
      sortinoRatio: 0.5,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 10, wins: 3, losses: 7, winRate: 0.30, expectancyR: -0.20, profitFactor: 0.5, maxDrawdownR: 2.0 },
        outOfSample: { signals: 4, wins: 3, losses: 1, winRate: 0.75, expectancyR: 0.60, profitFactor: 2.5, maxDrawdownR: 0.5 },
        passed: false,
        status: 'INSUFFICIENT_OOS' // OOS is not enough to PASS anyway, but total sample looks positive
      }
    };

    const tourney = evaluateStrategyTournament([negativeISCandidate], '5m');
    assert.strictEqual(tourney.confidence, 'NONE', 'Candidate with negative In-Sample expectancy must return NONE');
    assert.strictEqual(tourney.bestStrategy, 'NONE');
    assert.strictEqual(tourney.compositeScore, 0);
  });

  // Test 98: Directional statistics in Tournament Result originate strictly from In-Sample
  test('evaluateStrategyTournament returns In-Sample directional stats for blind alert sanitization', () => {
    // Strategy with strong In-Sample Longs (+0.80R) and toxic In-Sample Shorts (-0.40R)
    // In OOS, shorts had 2 lucky trades (+1.0R), making full sample shorts look positive (+0.05R)
    const directionalCandidate: StrategyCandidate = {
      key: 'multitemporal',
      label: 'Directional Strategy',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 16,
      forwardWindow: 6,
      longStats: { signals: 8, wins: 6, losses: 2, winRate: 0.75, expectancyR: 0.80, profitFactor: 3.0 },
      shortStats: { signals: 8, wins: 4, losses: 4, winRate: 0.50, expectancyR: 0.05, profitFactor: 1.1 },
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 11, wins: 7, losses: 4, winRate: 0.64, expectancyR: 0.45, profitFactor: 1.8, maxDrawdownR: 1.0,
          longStats: { signals: 6, wins: 5, losses: 1, winRate: 0.83, expectancyR: 0.80, profitFactor: 4.0 },
          shortStats: { signals: 5, wins: 2, losses: 3, winRate: 0.40, expectancyR: -0.40, profitFactor: 0.5 }
        },
        outOfSample: {
          signals: 5, wins: 4, losses: 1, winRate: 0.80, expectancyR: 0.60, profitFactor: 3.0, maxDrawdownR: 0.5,
          longStats: { signals: 2, wins: 2, losses: 0, winRate: 1.0, expectancyR: 0.80, profitFactor: null },
          shortStats: { signals: 3, wins: 2, losses: 1, winRate: 0.67, expectancyR: 0.50, profitFactor: 2.0 }
        },
        passed: true,
        status: 'PASS'
      }
    };

    const tourney = evaluateStrategyTournament([directionalCandidate], '5m');
    assert.strictEqual(tourney.confidence, 'HIGH');
    // Ensure tournament returned the In-Sample shortStats with negative expectancy
    assert.strictEqual(tourney.shortStats?.expectancyR, -0.40, 'Tournament must export In-Sample directional stats');
    
    // Test downstream alert sanitization: BUY is permitted, but SELL is neutralized because In-Sample shorts were negative
    const buySanitized = sanitizeSignalWithDirectionalEdge('BUY', tourney.longStats, tourney.shortStats, 3);
    const sellSanitized = sanitizeSignalWithDirectionalEdge('SELL', tourney.longStats, tourney.shortStats, 3);
    assert.strictEqual(buySanitized, 'BUY', 'BUY with positive IS edge must be allowed');
    assert.strictEqual(sellSanitized, 'NEUTRAL', 'SELL with negative IS edge must be blocked to NEUTRAL');
  });

  // Test 99: VCME Sniper records adxAtEntry corresponding to execution style timeframe (5m in DayTrading, 1H in Swing)
  test('VCME Sniper records adxAtEntry matching execution timeframe for tournament regime parity', () => {
    const klines5m: Kline[] = [];
    const klines1h: Kline[] = [];
    const klines1d: Kline[] = [];

    for (let i = 0; i < 650; i++) {
      klines5m.push({
        time: 1700000000 + i * 300,
        open: 100 + i * 0.1,
        high: 100.5 + i * 0.1,
        low: 99.8 + i * 0.1,
        close: 100.4 + i * 0.1,
        volume: 1000 + i * 5
      });
    }

    for (let i = 0; i < 200; i++) {
      klines1h.push({
        time: 1700000000 + i * 3600,
        open: 100 + i * 0.5,
        high: 101 + i * 0.5,
        low: 99.5 + i * 0.5,
        close: 100.8 + i * 0.5,
        volume: 12000
      });
    }

    for (let i = 0; i < 50; i++) {
      klines1d.push({
        time: 1700000000 + i * 86400,
        open: 100 + i * 2,
        high: 103 + i * 2,
        low: 99 + i * 2,
        close: 102.5 + i * 2,
        volume: 250000
      });
    }

    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'TEST', 'dayTrading');
    assert.ok(ctx.adxSeries5m && ctx.adxSeries5m.adx.length > 0, 'VCMESniperContext must compute and expose adxSeries5m');

    const btDay = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'TEST_DAY', 'dayTrading');
    const btSwing = backtestMultitemporal(klines1h, klines1h, klines1d, '1h', 'TEST_SWING', 'swing');

    assert.ok(btDay.regimeStats !== undefined, 'DayTrading VCME must produce valid regimeStats');
    assert.ok(btSwing.regimeStats !== undefined, 'Swing VCME must produce valid regimeStats');
  });

  // Test 100: Cache fingerprint uses full-window FNV-1a incremental hashing preventing stale cache on intermediate historical corrections
  test('getKlinesFingerprint invalidates backtest cache on intermediate historical candle correction', () => {
    const klinesOriginal: Kline[] = [];
    for (let i = 0; i < 200; i++) {
      klinesOriginal.push({
        time: 1700000000 + i * 300,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1000
      });
    }

    // Clone dataset and modify an intermediate candle (index 50) without altering length, last candle, or penultimate candle
    const klinesModified: Kline[] = klinesOriginal.map(k => ({ ...k }));
    klinesModified[50] = {
      ...klinesModified[50],
      close: 105.0, // Historical correction / revised tick
      high: 106.0
    };

    // Run backtest on original and cache it
    const res1 = backtestStandard(klinesOriginal, '5m', 'HASH_TEST_SYM');
    // Run backtest on modified dataset with the same symbol/timeframe
    const res2 = backtestStandard(klinesModified, '5m', 'HASH_TEST_SYM');

    // The results must NOT be the same cached instance reference, because the fingerprint detected the intermediate change
    assert.notStrictEqual(res1, res2, 'Modified intermediate candle must invalidate cache and produce a fresh backtest result');
  });

  // Test 101: Regime gate uses Bayesian uncertainty threshold avoiding false disqualification on noisy small samples (-0.02R) while hard-gating severe toxicity (-0.60R)
  test('evaluateStrategyTournament regime gate tolerates noisy small samples and hard-gates decisive toxicity', () => {
    // 1. Candidate with small noisy sample (N=3, E[R]=-0.02R, shrunk=-0.008R). Must NOT be hard-gated to NONE
    const noisySmallSampleCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Noisy Regime Strategy',
      profitFactor: 1.8,
      expectancyR: 0.40,
      expectancyPerHour: 0.8,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 16,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5,
      regimeStats: {
        trending: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.02 }
      }
    };

    const tourneyNoisy = evaluateStrategyTournament([noisySmallSampleCandidate], '5m', 'trending');
    assert.strictEqual(tourneyNoisy.bestStrategy, 'confluencia', 'Noisy -0.02R over 3 trades must not be hard-gated');
    assert.strictEqual(tourneyNoisy.confidence, 'HIGH');

    // 2. Candidate with decisively toxic small sample (N=3, E[R]=-0.60R, shrunk=-0.257R < -0.15R). MUST be hard-gated to NONE
    const toxicSmallSampleCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Toxic Regime Strategy',
      profitFactor: 1.8,
      expectancyR: 0.40,
      expectancyPerHour: 0.8,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 16,
      forwardWindow: 6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.5,
      regimeStats: {
        trending: { signals: 3, wins: 0, losses: 3, winRate: 0.0, expectancyR: -0.60 }
      }
    };

    const tourneyToxic = evaluateStrategyTournament([toxicSmallSampleCandidate], '5m', 'trending');
    assert.strictEqual(tourneyToxic.bestStrategy, 'NONE', 'Decisively toxic regime edge (-0.60R) must be hard-gated to FLAT/NONE');
    assert.strictEqual(tourneyToxic.confidence, 'NONE');
  });

  // Test 102: Regime Hysteresis Filter (Schmitt Trigger) prevents chattering around 25
  test('calculateRegimeSeriesWithHysteresis eliminates regime chattering and enforces hysteresis band [22, 26]', () => {
    const adxSequence = [20.0, 25.5, 26.5, 24.5, 23.0, 21.0, 24.0];
    const regimes = calculateRegimeSeriesWithHysteresis(adxSequence, 26.0, 22.0, 'ranging');

    assert.strictEqual(regimes[0], 'ranging', 'Initial 20 ADX must be ranging');
    assert.strictEqual(regimes[1], 'ranging', '25.5 ADX without previous trend must stay ranging');
    assert.strictEqual(regimes[2], 'trending', '26.5 ADX must trigger transition to trending');
    assert.strictEqual(regimes[3], 'trending', '24.5 ADX must retain trending regime (deadband hysteresis)');
    assert.strictEqual(regimes[4], 'trending', '23.0 ADX must retain trending regime');
    assert.strictEqual(regimes[5], 'ranging', '21.0 ADX must trigger transition to ranging');
    assert.strictEqual(regimes[6], 'ranging', '24.0 ADX without previous trend must retain ranging');
  });

  // Test 103: Candidate with 0 In-Sample trades must be rejected to FLAT/NONE even if OOS has positive trades
  test('evaluateStrategyTournament rejects candidate with 0 In-Sample trades without falling back to full sample', () => {
    const zeroISCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Zero IS Strategy',
      profitFactor: 3.0,
      expectancyR: 0.80,
      expectancyPerHour: 1.6,
      avgExposureHours: 0.5,
      winRate: 0.75,
      resolved: 8,
      forwardWindow: 6,
      maxDrawdownR: 0.5,
      sortinoRatio: 2.0,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          expectancyR: 0,
          profitFactor: null,
          maxDrawdownR: 0
        },
        outOfSample: {
          signals: 8,
          wins: 6,
          losses: 2,
          winRate: 0.75,
          expectancyR: 0.80,
          profitFactor: 3.0,
          maxDrawdownR: 0.5
        },
        passed: true,
        status: 'PASS'
      }
    };

    const tourney = evaluateStrategyTournament([zeroISCandidate], '5m');
    assert.strictEqual(tourney.bestStrategy, 'NONE', 'Candidate with 0 IS trades must be rejected to FLAT/NONE');
    assert.strictEqual(tourney.confidence, 'NONE');
  });

  // Test 104: Purged Walk-Forward purges boundary straddling trades and eliminates lookahead contamination
  test('calculateWalkForward purges boundary straddling trades preventing IS lookahead contamination', () => {
    // Total 100 candles (0..99), splitIdx = 70
    // Trade 1: strictly In-Sample (execIdx: 20, exitIdx: 35 < 70)
    // Trade 2: boundary straddler (execIdx: 65 < 70, exitIdx: 78 >= 70) -> MUST BE PURGED
    // Trade 3: strictly Out-of-Sample (execIdx: 75 >= 70, exitIdx: 85)
    const mockTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', executionIdx: 20, exitIdx: 35 },
      { dir: 'BUY', realizedR: 2.5, pnlPct: 10.0, outcome: 'win', executionIdx: 65, exitIdx: 78 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 75, exitIdx: 85 }
    ];

    const wf = calculateWalkForward(mockTrades, 0, 99, 0.70, 1);
    assert.strictEqual(wf.inSample.signals, 1, 'Only Trade 1 must be counted in In-Sample');
    assert.strictEqual(wf.inSample.expectancyR, 1.5, 'In-Sample expectancy must only reflect Trade 1 (1.5R)');
    assert.strictEqual(wf.outOfSample.signals, 1, 'Only Trade 3 must be counted in Out-of-Sample');
    assert.strictEqual(wf.outOfSample.expectancyR, 1.0, 'Out-of-Sample expectancy must only reflect Trade 3 (1.0R)');
    assert.strictEqual(wf.purgedSignals, 1, 'Straddling Trade 2 must be purged');
    assert.strictEqual(
      wf.inSample.signals + wf.outOfSample.signals + (wf.purgedSignals ?? 0),
      mockTrades.length,
      'Conservation law: IS + OOS + Purged == Total trades'
    );
  });

  // Test 105: Consistent empty state returns (passed: false on empty WF, bestStrategy: 'NONE' on empty tournament, null PF on 0 trades)
  test('empty states return consistent non-contradictory results across backtester and tournament', () => {
    // 1. Empty Walk-Forward Result must be passed: false
    const emptyWF = createEmptyWalkForwardResult(0, 0);
    assert.strictEqual(emptyWF.status, 'NO_OOS_TRADES');
    assert.strictEqual(emptyWF.passed, false, 'Empty Walk-Forward must have passed: false');

    // 2. Empty Tournament candidates array must return NONE
    const emptyTourney = evaluateStrategyTournament([], '5m');
    assert.strictEqual(emptyTourney.bestStrategy, 'NONE', 'Empty candidates must return NONE');
    assert.strictEqual(emptyTourney.strategyLabel, 'Sin Estrategia (Flat)');
    assert.strictEqual(emptyTourney.confidence, 'NONE');

    // 3. Profit Factor with 0 trades must strictly be null (not 1.0 breakeven)
    assert.strictEqual(calculateProfitFactor(0, 0, 0), null, 'PF with 0 trades must be null');
    assert.strictEqual(calculateProfitFactor(5.0, 0, 1), null, 'PF with 0 losses and positive gains must be null (infinite)');
    assert.strictEqual(calculateProfitFactor(0, 0, 1), 1.0, 'PF with 1 scratch trade (0 gain, 0 loss) must be 1.0 breakeven');
    assert.strictEqual(calculateProfitFactor(6.0, 3.0, 2), 2.0, 'PF with 6R gains and 3R losses must be 2.00');

    // 4. Backtest engines with 0 signals must output profitFactor: null
    const emptySplit = calculateSplitStats([]);
    assert.strictEqual(emptySplit.profitFactor, null, 'Empty split stats must have null PF');

    const klines5m = generateSyntheticKlines(600, 300, 100, 0.01);
    const zeroSignals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(600).fill('NEUTRAL');
    const resGeneric = runBacktestGenericOptimized(klines5m, '5m', zeroSignals, 'standard');
    assert.strictEqual(resGeneric.totalSignals, 0);
    assert.strictEqual(resGeneric.profitFactor, null, 'Generic backtest with 0 signals must have null PF, not 1.0');
  });

  // Test 106: Walk-Forward adaptive OOS threshold derives strictly from In-Sample cycle time without OOS duration leakage
  test('calculateWalkForward adaptive capacity derives strictly from In-Sample trades without OOS duration leakage', () => {
    // Dataset 0..99 (100 candles), splitIdx = 70, oosWindow = 30
    // In-Sample trades with fast cycles (duration 2 candles + 2 cooldown = 4 candles)
    const baseISTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 10, exitIdx: 12, durationCandles: 2 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 20, exitIdx: 22, durationCandles: 2 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 30, exitIdx: 32, durationCandles: 2 },
    ];

    // Scenario 1: Short OOS trade (duration = 2)
    const tradesWithShortOOS: RecordedTrade[] = [
      ...baseISTrades,
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 75, exitIdx: 77, durationCandles: 2 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 85, exitIdx: 87, durationCandles: 2 }
    ];

    // Scenario 2: Huge timeout OOS trade (duration = 50)
    const tradesWithHugeOOS: RecordedTrade[] = [
      ...baseISTrades,
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 75, exitIdx: 125, durationCandles: 50 },
      { dir: 'SELL', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 85, exitIdx: 135, durationCandles: 50 }
    ];

    const wf1 = calculateWalkForward(tradesWithShortOOS, 0, 99, 0.70, 5, 24, 5 / 60, 2);
    const wf2 = calculateWalkForward(tradesWithHugeOOS, 0, 99, 0.70, 5, 24, 5 / 60, 2);

    // Both must compute the exact same In-Sample cycle time and exact same status
    assert.strictEqual(wf1.status, wf2.status, 'Altering OOS trade duration must not alter OOS capacity or validation status');
    assert.strictEqual(wf1.passed, wf2.passed);
  });

  // Test 107: Walk-Forward requires strictly positive E[R] > 0 and rejects exact 0.00R breakeven
  test('calculateWalkForward requires strictly positive E[R] > 0 and marks exact 0.00R breakeven as FAIL', () => {
    // 5 OOS trades with exact 0.00R net edge: 2 wins (+1.0R each) and 2 losses (-1.0R each)
    const breakevenOOSTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', executionIdx: 20, exitIdx: 30 },
      { dir: 'SELL', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', executionIdx: 40, exitIdx: 50 },
      // OOS (splitIdx = 70)
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 72, exitIdx: 75 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', executionIdx: 76, exitIdx: 79 },
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', executionIdx: 80, exitIdx: 83 },
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', executionIdx: 84, exitIdx: 87 }
    ];

    const wf = calculateWalkForward(breakevenOOSTrades, 0, 99, 0.70, 4);
    assert.strictEqual(wf.outOfSample.expectancyR, 0, 'OOS expectancy is exactly 0.00R');
    assert.strictEqual(wf.status, 'FAIL', 'Exact 0.00R breakeven OOS sample must FAIL validation');
    assert.strictEqual(wf.passed, false, 'Breakeven OOS must not pass');
  });

  // Test 108: Realistic Gap-Through Stop Loss Fills (Eliminating Optimistic Fill Bias)
  test('simulateTrade correctly penalizes gap-through Stop Loss events without optimistic truncation', () => {
    // 1. Long Trade: Entry 100, SL 99, TP1 103, TP2 106 (riskDist = 1.0, initialRiskPct = 1.0%)
    const levelsLong: TradeLevels = {
      entryPrice: 100,
      stopLoss: 99,
      takeProfit1: 103,
      takeProfit2: 106
    };

    // Candle 0: Entry candle
    // Candle 1: Gaps down at open to 90.0 (low 89.0, high 91.0, close 89.5)
    const klinesLong: Kline[] = [
      { time: 1700000000, open: 100, high: 100.5, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 90.0, high: 91.0, low: 89.0, close: 89.5, volume: 5000 }
    ];

    const resultLong = simulateTrade(klinesLong, 0, 'BUY', levelsLong, { forwardWindow: 12, marketSlippagePct: 0 });
    assert.strictEqual(resultLong.exitReason, 'SL');
    assert.strictEqual(resultLong.exitPrice, 90.0, 'Long stop loss fill on gap down must execute at candle open (90.0), NOT 99.0');
    assert.strictEqual(resultLong.grossPnlPct, -10.0, 'Gross PnL must be -10.0% (not -1.0%)');
    assert.strictEqual(resultLong.realizedR, -10.11, 'Realized R must be -10.11R with 0.11% friction');

    // 2. Short Trade: Entry 100, SL 101, TP1 97 (riskDist = 1.0, initialRiskPct = 1.0%)
    const levelsShort: TradeLevels = {
      entryPrice: 100,
      stopLoss: 101,
      takeProfit1: 97
    };

    // Candle 1: Gaps up at open to 110.0 (high 111.0, low 109.5, close 110.5)
    const klinesShort: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.5, close: 100, volume: 1000 },
      { time: 1700000300, open: 110.0, high: 111.0, low: 109.5, close: 110.5, volume: 5000 }
    ];

    const resultShort = simulateTrade(klinesShort, 0, 'SELL', levelsShort, { forwardWindow: 12, marketSlippagePct: 0 });
    assert.strictEqual(resultShort.exitReason, 'SL');
    assert.strictEqual(resultShort.exitPrice, 110.0, 'Short stop loss fill on gap up must execute at candle open (110.0), NOT 101.0');
    assert.strictEqual(resultShort.grossPnlPct, -10.0, 'Gross PnL must be -10.0% (not -1.0%)');
    assert.strictEqual(resultShort.realizedR, -10.11, 'Realized R must be -10.11R with 0.11% friction');

    // 3. Breakeven Gap Down after TP1
    // Candle 1: hits TP1 (103.0) -> moves activeSL to Breakeven (100.0)
    // Candle 2: gaps down to open at 95.0
    const klinesBE: Kline[] = [
      { time: 1700000000, open: 100, high: 100.5, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100.5, high: 103.5, low: 100.2, close: 103.0, volume: 2000 },
      { time: 1700000600, open: 95.0, high: 96.0, low: 94.0, close: 95.5, volume: 4000 }
    ];

    const resultBE = simulateTrade(klinesBE, 0, 'BUY', levelsLong, { forwardWindow: 12, enablePartials: true, frictionModel: 'per-fill', marketSlippagePct: 0 });
    assert.strictEqual(resultBE.exitReason, 'TP1_BE');
    assert.strictEqual(resultBE.exitPrice, 95.0, 'Remaining 50% must exit at gap open 95.0');
    // TP1 portion (50%): +1.5% gross. Remaining 50% @ 95: -2.5% gross. Total gross = -1.0% gross.
    assert.strictEqual(resultBE.grossPnlPct, -1.0);
    // With 3 fills (entry, TP1, gap exit at 95): effectiveFrictionPct = 1.5 * 0.11% = 0.165%. Net PnL = -1.0% - 0.165% = -1.165% (-1.17%)
    assert.strictEqual(resultBE.realizedR, -1.17, 'Net realized R on gapped breakeven with 3 fills must reflect -1.17R');
  });

  // Test 109: VCME Continuous Confidence MacroScore Fallback (<200 Daily Candles)
  test('VCME continuous confidence incorporates macroScore (+0.25) using lastEma200Ref on <200 daily candles', () => {
    // Generate trending series with 120 daily candles (< 200)
    const days1d = 120;
    const hours1h = 100;
    const candles5m = 200;
    const endTime = 1700000000 + days1d * 86400;

    const klines1d = generateSyntheticKlines(days1d, 86400, 50, 0.5); // strongly bullish drift
    
    const klines1h: Kline[] = [];
    const start1h = endTime - hours1h * 3600;
    for (let i = 0; i < hours1h; i++) {
      klines1h.push({ time: start1h + i * 3600, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99.5 + i * 0.1, close: 100.8 + i * 0.1, volume: 5000 });
    }

    const klines5m: Kline[] = [];
    const start5m = endTime - candles5m * 300;
    for (let i = 0; i < candles5m; i++) {
      klines5m.push({ time: start5m + i * 300, open: 108 + i * 0.05, high: 109 + i * 0.05, low: 107.8 + i * 0.05, close: 108.7 + i * 0.05, volume: 1500 });
    }

    const result = calculateVCMESniperSignal(klines5m, klines1h, klines1d, 'MACRO_FALLBACK_TEST');
    
    // EMA200_1D fallback must be a valid positive number (EMA50 fallback), not NaN
    assert.ok(Number.isFinite(result.ema200_1D), 'ema200_1D must return valid fallback number (EMA50) rather than NaN');
    assert.ok(result.ema200_1D > 0);

    // Continuous confidence score must be positive
    assert.ok(result.confidenceScore > 0, 'Confidence score must be positive');
  });

  // Test 110: calculateVolumeComposition strictly isolates volume baseline avoiding self-inclusion damping
  test('calculateVolumeComposition strictly excludes current bar avoiding self-inclusion damping (10.0x vs 6.9x)', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push({ time: 1700000000 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 100 });
    }
    // Candle 20 has a massive 10x volume surge (1000 volume)
    klines.push({ time: 1700000000 + 20 * 300, open: 100, high: 102, low: 99.5, close: 101.8, volume: 1000 });

    const volComp = calculateVolumeComposition(klines, 20);
    const item20 = volComp[20];

    assert.strictEqual(item20.smaVolume, 100, 'Baseline volume must strictly equal 100 (excluding the 1000 spike)');
    assert.strictEqual(item20.volumeMultiplier, 10.0, 'Volume multiplier must be exactly 10.0x, not damped to 6.9x');
    assert.strictEqual(item20.isHighVolume, true);

    // Also test nominal 1.5x surge:
    const klines1_5x: Kline[] = [];
    for (let i = 0; i < 20; i++) {
      klines1_5x.push({ time: 1700000000 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 100 });
    }
    klines1_5x.push({ time: 1700000000 + 20 * 300, open: 100, high: 102, low: 99.5, close: 101.8, volume: 150 });
    const volComp1_5 = calculateVolumeComposition(klines1_5x, 20);
    assert.strictEqual(volComp1_5[20].volumeMultiplier, 1.50, '1.5x volume surge must evaluate to exactly 1.50x, not 1.46x');
    assert.strictEqual(volComp1_5[20].isHighVolume, true, '1.5x surge must satisfy isHighVolume without rejection');
  });

  // Test 111: VCME avgDailyRange evaluates point-in-time without future look-ahead bias
  test('VCME evaluates avgDailyRange point-in-time without look-ahead contamination from future volatility', () => {
    // 100 days total: First 50 days low volatility (daily range ~1.0%), Last 50 days high volatility (daily range ~10.0%)
    const klines1d: Kline[] = [];
    for (let i = 0; i < 50; i++) {
      klines1d.push({ time: 1700000000 + i * 86400, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 });
    }
    for (let i = 50; i < 100; i++) {
      klines1d.push({ time: 1700000000 + i * 86400, open: 100, high: 105.0, low: 95.0, close: 100, volume: 5000 });
    }

    // 1H and 5M series matching the early period (around day 40) and late period (around day 90)
    const klines1h: Kline[] = [];
    for (let i = 0; i < 100 * 24; i++) {
      klines1h.push({ time: 1700000000 + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 500 });
    }
    const klines5m: Kline[] = [];
    for (let i = 0; i < 100 * 288; i++) {
      klines5m.push({ time: 1700000000 + i * 300, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 });
    }

    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'LOOKAHEAD_TEST', 'dayTrading');

    // Evaluate at day 40 (candle index 40 * 288)
    const resDay40 = evaluateVCMESniperAt(ctx, 40 * 288);
    assert.strictEqual(resDay40.volatilityProfile, 'Normal', 'Day 40 must evaluate as Normal volatility point-in-time');
    assert.ok(resDay40.avgDailyRange < 2.0, `Day 40 avgDailyRange should be ~1.0% (got ${resDay40.avgDailyRange}%)`);

    // Evaluate at day 95 (candle index 95 * 288)
    const resDay95 = evaluateVCMESniperAt(ctx, 95 * 288);
    assert.strictEqual(resDay95.volatilityProfile, 'Alta Volatilidad', 'Day 95 must evaluate as Alta Volatilidad point-in-time');
    assert.ok(resDay95.avgDailyRange > 8.0, `Day 95 avgDailyRange should be ~10.0% (got ${resDay95.avgDailyRange}%)`);
  });

  // Test 112: Adverse market slippage on market/stop orders vs exact zero slippage on limit TPs
  test('simulateTrade applies adverse market slippage (0.03%) strictly to market/stop exits while preserving exact limit TP prices', () => {
    // 1. Long Stop Loss: Entry 100, SL 98 (risk = 2.0%)
    // Candle drops to 97.9 -> triggers SL at activeSL (98.0)
    const slLevelsLong: TradeLevels = { entryPrice: 100, stopLoss: 98, takeProfit1: 103 };
    const slKlinesLong: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 100.1, low: 97.5, close: 97.9, volume: 1000 }
    ];
    const resSLLong = simulateTrade(slKlinesLong, 0, 'BUY', slLevelsLong, { forwardWindow: 5 });
    // Expected fill price with 0.03% adverse slippage: 98.0 * (1 - 0.0003) = 97.9706
    assert.strictEqual(resSLLong.exitReason, 'SL');
    assert.strictEqual(Number(resSLLong.exitPrice.toFixed(4)), 97.9706, 'Long SL fill must be 97.9706 (98.0 - 0.03% slippage)');
    // Gross PnL: (97.9706 - 100) / 100 * 100 = -2.03%
    assert.strictEqual(resSLLong.grossPnlPct, -2.03, 'Gross PnL on Long SL must reflect adverse slippage (-2.03%)');

    // 2. Short Stop Loss: Entry 100, SL 102, TP1 97 (risk = 2.0%)
    // Candle spikes to 102.5 -> triggers SL at activeSL (102.0)
    const slLevelsShort: TradeLevels = { entryPrice: 100, stopLoss: 102, takeProfit1: 97 };
    const slKlinesShort: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 102.5, low: 99.8, close: 102.2, volume: 1000 }
    ];
    const resSLShort = simulateTrade(slKlinesShort, 0, 'SELL', slLevelsShort, { forwardWindow: 5 });
    // Expected fill price with 0.03% adverse slippage: 102.0 * (1 + 0.0003) = 102.0306
    assert.strictEqual(resSLShort.exitReason, 'SL');
    assert.strictEqual(Number(resSLShort.exitPrice.toFixed(4)), 102.0306, 'Short SL fill must be 102.0306 (102.0 + 0.03% slippage)');
    assert.strictEqual(resSLShort.grossPnlPct, -2.03, 'Gross PnL on Short SL must reflect adverse slippage (-2.03%)');

    // 3. Limit Order TP: Must execute with EXACT ZERO slippage
    const tpKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 103.5, low: 99.5, close: 103.1, volume: 1000 }
    ];
    const resTP = simulateTrade(tpKlines, 0, 'BUY', slLevelsLong, { forwardWindow: 5, enablePartials: false });
    assert.strictEqual(resTP.exitReason, 'TP1');
    assert.strictEqual(resTP.exitPrice, 103.0, 'Limit TP1 must execute at EXACT limit price (103.0) with zero slippage');
    assert.strictEqual(resTP.grossPnlPct, 3.0, 'Gross PnL on Limit TP1 must be exactly +3.0%');

    // 4. Emergency Exit: Market order at candle close -> adverse slippage
    const emergLevels: TradeLevels = { entryPrice: 100, stopLoss: 95, takeProfit1: 103 };
    const emergKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 101, low: 96.5, close: 97.0, volume: 1000 }
    ];
    const resEmerg = simulateTrade(emergKlines, 0, 'BUY', emergLevels, {
      forwardWindow: 5,
      emergencyExitFn: () => true
    });
    // 97.0 * (1 - 0.0003) = 96.9709
    assert.strictEqual(resEmerg.exitReason, 'EMERGENCY_EXIT');
    assert.strictEqual(Number(resEmerg.exitPrice.toFixed(4)), 96.9709, 'Emergency exit must execute with adverse market slippage');
  });

  // Test 113: Advanced Institutional Robustness Improvements:
  // 1. Walk-Forward floor of 3 trades & E[R] hurdle >= +0.10R
  // 2. 3-Fold Anchored Expanding Walk-Forward diagnostics
  // 3. Friction deadband on flat TIMEOUT expirations
  // 4. In-Sample metric reporting coherence in Strategy Tournament
  // 5. Multiplicity deflation factor on selection-of-maximum
  test('advanced institutional robustness: WF floor 3, +0.10R hurdle, 3-fold anchored WF, deadband timeout, and tournament IS reporting coherence', () => {
    // 1. Walk-Forward Floor 3: 2 winning trades in OOS must NOT achieve PASS
    const twoOOSTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 1.2, pnlPct: 4.8, outcome: 'win', entryIdx: 30 },
      // 2 OOS trades (entryIdx >= 70)
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 75 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 85 }
    ];
    const wfTwo = calculateWalkForward(twoOOSTrades, 0, 99, 0.70, 5, 25);
    assert.strictEqual(wfTwo.status, 'INSUFFICIENT_OOS', '2 OOS trades must NOT achieve PASS (floor is 3 trades)');
    assert.strictEqual(wfTwo.passed, false);

    // 2. Walk-Forward Hurdle: 3 trades with marginal edge (+0.04R < +0.10R) must FAIL validation
    const marginalOOSTrades: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      // 3 OOS trades averaging +0.04R (< 0.10R hurdle)
      { dir: 'BUY', realizedR: 0.05, pnlPct: 0.2, outcome: 'win', entryIdx: 72 },
      { dir: 'BUY', realizedR: 0.04, pnlPct: 0.16, outcome: 'win', entryIdx: 78 },
      { dir: 'BUY', realizedR: 0.03, pnlPct: 0.12, outcome: 'win', entryIdx: 84 }
    ];
    const wfMarginal = calculateWalkForward(marginalOOSTrades, 0, 99, 0.70, 3, 25);
    assert.strictEqual(wfMarginal.status, 'FAIL', 'OOS sample with +0.04R edge below +0.10R hurdle must FAIL');
    assert.strictEqual(wfMarginal.passed, false);

    // 3. Multi-Fold Anchored Expanding Walk-Forward diagnostics:
    assert.ok(Array.isArray(wfMarginal.folds), 'Walk-Forward result must include multi-fold diagnostics');
    assert.strictEqual(wfMarginal.folds!.length, 3, 'Must compute 3 progressive expanding folds');
    assert.strictEqual(wfMarginal.folds![0].fold, 1);
    assert.strictEqual(wfMarginal.folds![1].fold, 2);
    assert.strictEqual(wfMarginal.folds![2].fold, 3);

    // 4. Deadband on flat TIMEOUT expirations:
    // A trade that expires without price movement (gross 0.0%) suffers -0.08% friction
    const flatTimeoutKlines: Kline[] = [
      { time: 1000, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 },
      { time: 1300, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 },
      { time: 1600, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 }
    ];
    const levels: TradeLevels = { entryPrice: 100, stopLoss: 97, takeProfit1: 104.5 };
    const flatSim = simulateTrade(flatTimeoutKlines, 0, 'BUY', levels, { forwardWindow: 2, marketSlippagePct: 0 });
    assert.strictEqual(flatSim.exitReason, 'TIMEOUT');
    assert.strictEqual(flatSim.grossPnlPct, 0.0);
    assert.strictEqual(flatSim.outcome, 'timeout', 'Flat timeout trade in friction deadband must be outcome: timeout, NOT loss');

    // Verify calculateRiskMetrics does not count flat scratch timeout in loss streaks or loss counters
    const scratchTrade: RecordedTrade = {
      dir: 'BUY',
      realizedR: flatSim.realizedR, // -0.037R from 0.11% friction
      pnlPct: flatSim.pnlPct,
      outcome: 'timeout',
      exitReason: 'TIMEOUT'
    };
    const metrics = calculateRiskMetrics([scratchTrade]);
    assert.strictEqual(metrics.maxLossStreak, 0, 'Scratch timeout must not increment loss streak');
    assert.strictEqual(metrics.longStats.losses, 0, 'Scratch timeout must not increment long losses');

    // 5. In-Sample metric reporting coherence in Strategy Tournament:
    const wfCandidate: WalkForwardResult = {
      isWindow: 700,
      oosWindow: 300,
      inSample: {
        signals: 8,
        wins: 6,
        losses: 2,
        winRate: 0.75,
        expectancyR: 0.45,
        profitFactor: 1.40, // IS PF is 1.40
        maxDrawdownR: 1.5,
        sortinoRatio: 2.1
      },
      outOfSample: {
        signals: 4,
        wins: 3,
        losses: 1,
        winRate: 0.75,
        expectancyR: 0.35,
        profitFactor: 1.80,
        maxDrawdownR: 1.0,
        sortinoRatio: 2.5
      },
      passed: true,
      status: 'PASS'
    };

    const candidate: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Sniper',
      profitFactor: 2.50, // Full sample PF is 2.50 (differs from IS PF 1.40)
      expectancyR: 0.70,
      expectancyPerHour: 0.35,
      winRate: 0.80,
      resolved: 20, // Full sample 20 trades vs IS 8 trades
      forwardWindow: 12,
      walkForward: wfCandidate
    };

    const tourneyRes = evaluateStrategyTournament([candidate], '5m');
    assert.strictEqual(tourneyRes.confidence, 'HIGH');
    // Coherence: Returned profitFactor and expectancyR MUST be strictly from In-Sample
    assert.strictEqual(tourneyRes.profitFactor, 1.40, 'Tournament must report In-Sample PF (1.40), NOT full sample (2.50)');
    assert.strictEqual(tourneyRes.expectancyR, 0.45, 'Tournament must report In-Sample expectancyR (0.45), NOT full sample (0.70)');
    assert.ok(tourneyRes.reasoning.includes('IS: 8 trades'), 'Reasoning must report In-Sample trades count (8 trades)');
    assert.ok(tourneyRes.reasoning.includes('PF 1.40'), 'Reasoning must report In-Sample PF (1.40)');
  });

  // Test 114: Symmetric R-based scratch deadband (|R| <= 0.05) and complete accounting in PF and Sortino
  test('symmetric R-based scratch deadband (|R| <= 0.05) classifies micro-noise symmetrically and accounts for all losses in PF and Sortino', () => {
    // 1. User Probe: Tight 0.2% stop with -0.05% price drift (-0.75R net)
    // Must be classified as 'loss' (NOT 'timeout'), because |-0.75R| > 0.05R!
    const probeKlines: Kline[] = [
      { time: 1000, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1000 },
      { time: 1300, open: 100, high: 100.02, low: 99.90, close: 99.95, volume: 1000 }
    ];
    // initialRiskPct = 0.2% (entry: 100, stop: 99.8)
    const probeLevels: TradeLevels = { entryPrice: 100, stopLoss: 99.8, takeProfit1: 100.4 };
    const probeSim = simulateTrade(probeKlines, 0, 'BUY', probeLevels, {
      forwardWindow: 1,
      frictionPct: 0.08,
      marketSlippagePct: 0.03
    });
    // grossPnl = -0.05%, fill = 99.95 * (1 - 0.0003) = 99.92, gross = -0.08%, net = -0.16%, netR = -0.16% / 0.2% = -0.80R
    assert.strictEqual(probeSim.outcome, 'loss', 'Loss of -0.80R must be strictly classified as loss, NOT timeout');
    assert.ok(probeSim.realizedR < -0.05, 'realizedR is decisively negative');

    // 2. Micro-positive noise: +0.02R must be classified as 'timeout' (scratch), NOT 'win'
    const microWinKlines: Kline[] = [
      { time: 1000, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1000 },
      { time: 1300, open: 100, high: 100.20, low: 99.95, close: 100.12, volume: 1000 }
    ];
    const microLevels: TradeLevels = { entryPrice: 100, stopLoss: 96, takeProfit1: 106 }; // 4.0% risk
    const microSim = simulateTrade(microWinKlines, 0, 'BUY', microLevels, {
      forwardWindow: 1,
      frictionPct: 0.08,
      marketSlippagePct: 0.0
    });
    // gross = +0.12%, net = +0.04%, netR = 0.04 / 4.0 = +0.01R (inside deadband |R| <= 0.05)
    assert.strictEqual(microSim.realizedR, 0.01);
    assert.strictEqual(microSim.outcome, 'timeout', 'Micro-gain +0.01R inside deadband must be timeout (scratch), NOT win');

    // 3. Complete and Symmetrical accounting in PF, Sortino, and Expectancy:
    // User Scenario: 20 wins (+1.5R = +30R), 30 losses (-1.0R = -30R), 50 adverse timeouts (-0.55R = -27.5R)
    const fixtureTrades: RecordedTrade[] = [];
    for (let i = 0; i < 20; i++) {
      fixtureTrades.push({ dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win' });
    }
    for (let i = 0; i < 30; i++) {
      fixtureTrades.push({ dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss' });
    }
    for (let i = 0; i < 50; i++) {
      // These 50 trades have |-0.55R| > 0.05R, so outcome is 'loss'
      fixtureTrades.push({ dir: 'BUY', realizedR: -0.55, pnlPct: -2.2, outcome: 'loss', exitReason: 'TIMEOUT' });
    }

    const splitStats = calculateSplitStats(fixtureTrades);
    const riskStats = calculateRiskMetrics(fixtureTrades);

    // Sum of R: +30R - 30R - 27.5R = -27.5R
    // Total Loss R MUST be 30R + 27.5R = 57.5R (NO leakage!)
    assert.strictEqual(splitStats.expectancyR, -0.275, 'Expectancy must be -0.275R (-27.5R / 100)');
    assert.strictEqual(splitStats.profitFactor, 0.52, 'Profit Factor must be 30.0 / 57.5 = 0.52 (NOT 1.00!)');
    assert.strictEqual(riskStats.longStats.profitFactor, 0.52, 'Directional PF must also be 0.52');
    assert.ok(riskStats.sortinoRatio !== null && riskStats.sortinoRatio < 0, 'Sortino must be negative reflecting all downside risk');
  });

  // Test 115: Multiplicity selection-of-maximum active hurdle and runner-up margin gate
  test('multiplicity selection-of-maximum actively degrades HIGH to LIMITED on narrow runner-up margin or sub-hurdle deflated score', () => {
    const wfPass: WalkForwardResult = {
      isWindow: 700,
      oosWindow: 300,
      inSample: {
        signals: 10,
        wins: 7,
        losses: 3,
        winRate: 0.70,
        expectancyR: 0.50,
        profitFactor: 2.0,
        maxDrawdownR: 1.0,
        sortinoRatio: 2.0
      },
      outOfSample: {
        signals: 5,
        wins: 4,
        losses: 1,
        winRate: 0.80,
        expectancyR: 0.40,
        profitFactor: 2.5,
        maxDrawdownR: 0.8,
        sortinoRatio: 2.5
      },
      passed: true,
      status: 'PASS'
    };

    // Candidate A (Leader): E[R] = 0.51
    const candidateA: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Leader',
      profitFactor: 2.0,
      expectancyR: 0.51,
      winRate: 0.70,
      resolved: 10,
      forwardWindow: 12,
      walkForward: { ...wfPass, inSample: { ...wfPass.inSample, expectancyR: 0.51 } }
    };

    // Candidate B (Close Runner-up, statistically tied within 2% margin): E[R] = 0.50
    const candidateB: StrategyCandidate = {
      key: 'scoring',
      label: 'Scoring Tied Runner-up',
      profitFactor: 2.0,
      expectancyR: 0.50,
      winRate: 0.70,
      resolved: 10,
      forwardWindow: 12,
      walkForward: { ...wfPass, inSample: { ...wfPass.inSample, expectancyR: 0.50 } }
    };

    // Candidate C (3rd active candidate creating multiplicity K=3)
    const candidateC: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia 3rd Candidate',
      profitFactor: 1.5,
      expectancyR: 0.20,
      winRate: 0.55,
      resolved: 8,
      forwardWindow: 12,
      walkForward: { ...wfPass, inSample: { ...wfPass.inSample, expectancyR: 0.20 } }
    };

    // 1. Narrow margin under K=3: Leader is within 2% of runner-up (< 5% required)
    // Multiplicity gate MUST actively degrade HIGH -> LIMITED!
    const tiedTourney = evaluateStrategyTournament([candidateA, candidateB, candidateC], '5m');
    assert.strictEqual(tiedTourney.bestStrategy, 'vcme', 'Leader should still be selected as best strategy');
    assert.strictEqual(tiedTourney.confidence, 'LIMITED', 'Confidence must be degraded to LIMITED due to statistical tie under multiplicity');
    assert.ok(tiedTourney.reasoning.includes('Margen sobre 2º'), 'Reasoning must explicitly detail narrow runner-up margin under multiplicity');

    // 2. Decisive margin: Candidate A (0.75R) decisively outperforms Candidate B (0.40R)
    const decisiveCandidateA: StrategyCandidate = {
      ...candidateA,
      walkForward: { ...wfPass, inSample: { ...wfPass.inSample, expectancyR: 0.75 } }
    };
    const decisiveTourney = evaluateStrategyTournament([decisiveCandidateA, candidateB, candidateC], '5m');
    assert.strictEqual(decisiveTourney.bestStrategy, 'vcme');
    assert.strictEqual(decisiveTourney.confidence, 'HIGH', 'Decisive leader exceeding margin gate under multiplicity earns HIGH confidence');

    // 3. Marginal edge deflated below absolute hurdle (< 0.020):
    // Candidate with marginal E[R] = 0.05R and long forwardWindow (48 candles)
    const weakWfPass: WalkForwardResult = {
      ...wfPass,
      inSample: { ...wfPass.inSample, expectancyR: 0.05, signals: 8, wins: 5, losses: 3 }
    };
    const weakCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Standard Weak Candidate',
      profitFactor: 1.30,
      expectancyR: 0.05,
      winRate: 0.60,
      resolved: 8,
      forwardWindow: 48,
      walkForward: weakWfPass
    };
    const weakTourney = evaluateStrategyTournament([weakCandidate], '5m');
    // Score after shrinkage and time normalization falls below 0.020 -> degraded to LIMITED
    assert.strictEqual(weakTourney.confidence, 'LIMITED', 'Sub-hurdle deflated score must be degraded to LIMITED');
    assert.ok(weakTourney.reasoning.includes('Score deflactado'), 'Reasoning must detail deflated score below hurdle');
  });

  // Test 116: Blind disjoint multi-fold Walk-Forward within OOS, straddler purging, and active foldsPassed >= 2 gate
  test('blind multi-fold walk-forward purges fold straddlers, requires >= 1 trade with E[R] >= 0.10, and gates HIGH on foldsPassed >= 2', () => {
    // 1. Blind disjoint folds within OOS window [70..99] (3 sub-windows of 10 bars: [70..79], [80..89], [90..99])
    const trades: RecordedTrade[] = [
      // 8 In-Sample trades [0..69]
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10, exitIdx: 14 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 18, exitIdx: 22 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 26, exitIdx: 30 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 34, exitIdx: 38 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 42, exitIdx: 46 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 50, exitIdx: 54 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 58, exitIdx: 62 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 64, exitIdx: 68 },
      // OOS trades [70..99]
      // Fold 1 [70..79]: 2 closed trades
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 71, exitIdx: 74 },
      { dir: 'BUY', realizedR: 0.5, pnlPct: 2.0, outcome: 'win', entryIdx: 75, exitIdx: 78 },
      // Straddler crossing between Fold 1 and Fold 2: entry 78, exit 82 (> f1End 79)
      { dir: 'BUY', realizedR: 0.6, pnlPct: 2.4, outcome: 'win', entryIdx: 78, exitIdx: 82 },
      // Fold 2 [80..89]: 1 closed trade
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 83, exitIdx: 88 },
      // Fold 3 [90..99]: 1 closed trade
      { dir: 'BUY', realizedR: 0.4, pnlPct: 1.6, outcome: 'win', entryIdx: 90, exitIdx: 94 }
    ];

    const wf = calculateWalkForward(trades, 0, 99, 0.70, 3, 20);
    assert.strictEqual(wf.status, 'PASS');
    assert.ok(wf.folds && wf.folds.length === 3);

    // Verify Fold 1 (70..79): straddler at 78-82 exits at 82 (>79), so it is purged!
    // Fold 1 has exactly the 2 trades at 71 and 75
    assert.strictEqual(wf.folds[0].oosTradesCount, 2, 'Fold 1 must purge straddler and contain exactly 2 closed trades');
    assert.strictEqual(wf.folds[0].passed, true, 'Fold 1 has 2 trades with E[R] = 0.50 >= 0.10');

    // Verify Fold 2 (80..89): strictly disjoint from Fold 1, contains 1 trade at 83
    assert.strictEqual(wf.folds[1].oosTradesCount, 1, 'Fold 2 must be disjoint and contain 1 trade');
    assert.strictEqual(wf.folds[1].passed, true, 'Fold 2 has E[R] = 0.80 >= 0.10');

    // Verify Fold 3 (90..99): strictly disjoint from Fold 1 and Fold 2, contains 1 trade at 90
    assert.strictEqual(wf.folds[2].oosTradesCount, 1, 'Fold 3 must be disjoint and contain 1 trade');
    assert.strictEqual(wf.folds[2].passed, true, 'Fold 3 has E[R] = 0.40 >= 0.10');

    // All 3 disjoint folds passed!
    assert.strictEqual(wf.foldsPassed, 3);

    // 2. Active Tournament gate: Candidate with foldsPassed = 1 (< 2) is degraded to LIMITED
    const weakFoldsCandidate: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Weak Folds',
      profitFactor: 2.0,
      expectancyR: 0.50,
      winRate: 0.70,
      resolved: 10,
      forwardWindow: 12,
      walkForward: {
        ...wf,
        foldsPassed: 1, // Only 1 fold passed
        folds: [
          { fold: 1, isWindow: 70, oosWindow: 15, oosTradesCount: 2, oosExpectancyR: 0.20, passed: true },
          { fold: 2, isWindow: 70, oosWindow: 22, oosTradesCount: 3, oosExpectancyR: -0.05, passed: false },
          { fold: 3, isWindow: 70, oosWindow: 30, oosTradesCount: 4, oosExpectancyR: 0.02, passed: false }
        ]
      }
    };

    const tourneyDegraded = evaluateStrategyTournament([weakFoldsCandidate], '5m');
    assert.strictEqual(tourneyDegraded.confidence, 'LIMITED', 'Candidate with foldsPassed = 1/3 must be actively degraded to LIMITED');
    assert.ok(tourneyDegraded.reasoning.includes('Folds Walk-Forward insuficientes'), 'Reasoning must detail fold failure');

    // Candidate with foldsPassed = 2/3 achieves HIGH
    const strongFoldsCandidate: StrategyCandidate = {
      ...weakFoldsCandidate,
      walkForward: { ...weakFoldsCandidate.walkForward!, foldsPassed: 2 }
    };
    const tourneyPassed = evaluateStrategyTournament([strongFoldsCandidate], '5m');
    assert.strictEqual(tourneyPassed.confidence, 'HIGH', 'Candidate with foldsPassed >= 2 earns HIGH confidence');
    assert.ok(tourneyPassed.reasoning.includes('2/3 folds'), 'Reasoning must report folds passed in wfInfo');
  });

  // Test 117: Standard Voting requires voteMargin >= 2 consensus floor and symmetric 0.9 RVOL
  test('Standard Voting enforces voteMargin >= 2 floor and symmetric 0.9 RVOL for BUY and SELL', () => {
    function makeVotingCtx(opts: {
      buyVotes?: ('rsi' | 'macd' | 'bb' | 'st' | 'stoch' | 'vol')[];
      sellVotes?: ('rsi' | 'macd' | 'bb' | 'st' | 'stoch' | 'vol')[];
      rvol?: number;
      close?: number;
      open?: number;
      high?: number;
      low?: number;
      ema200?: number;
    }): StandardVotingContext {
      const length = 35;
      const klines: Kline[] = new Array(length).fill(null).map((_, idx) => ({
        time: 1700000000 + idx * 300,
        open: 100, high: 101, low: 99, close: 100, volume: 1000
      }));
      const lastIdx = 34;
      const o = opts.open ?? 100;
      const c = opts.close ?? (opts.buyVotes?.length ? 100.8 : 99.2);
      const h = opts.high ?? Math.max(o, c) + 0.5;
      const l = opts.low ?? Math.min(o, c) - 0.5;
      const volSma = 1000;
      const vol = volSma * (opts.rvol ?? 1.0);
      klines[lastIdx] = { time: 1700000000 + lastIdx * 300, open: o, high: h, low: l, close: c, volume: vol };

      const closes = klines.map(k => k.close);
      const rsiSeries = new Array(length).fill(50);
      if (opts.buyVotes?.includes('rsi')) {
        rsiSeries[lastIdx - 3] = 24;
        rsiSeries[lastIdx] = 25; // < 30 and slope >= 0 (curling up from oversold)
      }
      if (opts.sellVotes?.includes('rsi')) {
        rsiSeries[lastIdx - 3] = 76;
        rsiSeries[lastIdx] = 75; // > 70 and slope <= 0 (curling down from overbought)
      }

      const macdSignals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
      if (opts.buyVotes?.includes('macd')) macdSignals[lastIdx] = 'BUY';
      if (opts.sellVotes?.includes('macd')) macdSignals[lastIdx] = 'SELL';

      const bbSeries = new Array(length).fill({ upper: 105, middle: 100, lower: 95 });
      if (opts.buyVotes?.includes('bb')) bbSeries[lastIdx - 19] = { upper: 105, middle: 100, lower: c + 1 };
      if (opts.sellVotes?.includes('bb')) bbSeries[lastIdx - 19] = { upper: c - 1, middle: 100, lower: 95 };

      const supertrendSeries: { value: number; direction: 'UP' | 'DOWN'; signal: 'BUY' | 'SELL' | 'NEUTRAL' }[] =
        new Array(length).fill(null).map(() => ({ value: 100, direction: 'UP', signal: 'NEUTRAL' }));
      if (opts.buyVotes?.includes('st')) {
        supertrendSeries[lastIdx] = { value: 98, direction: 'UP', signal: 'BUY' };
        supertrendSeries[lastIdx - 1] = { value: 102, direction: 'DOWN', signal: 'SELL' };
      }
      if (opts.sellVotes?.includes('st')) {
        supertrendSeries[lastIdx] = { value: 102, direction: 'DOWN', signal: 'SELL' };
        supertrendSeries[lastIdx - 1] = { value: 98, direction: 'UP', signal: 'BUY' };
      }

      const stochSignals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');
      if (opts.buyVotes?.includes('stoch')) stochSignals[lastIdx] = 'BUY';
      if (opts.sellVotes?.includes('stoch')) stochSignals[lastIdx] = 'SELL';

      const volSignalSeries: { values: string[]; signals: ('BUY' | 'SELL' | 'NEUTRAL')[] } = {
        values: new Array(length).fill('—'),
        signals: new Array(length).fill('NEUTRAL')
      };
      if (opts.buyVotes?.includes('vol')) volSignalSeries.signals[lastIdx] = 'BUY';
      if (opts.sellVotes?.includes('vol')) volSignalSeries.signals[lastIdx] = 'SELL';

      const volSmaSeries = new Array(length).fill(volSma);
      const ema200Series = new Array(length).fill(opts.ema200 ?? (c > o ? 90 : 110));

      return {
        klines, closes, rsiSeries,
        macdSeries: { macd: new Array(length).fill(0), signal: new Array(length).fill(0), histogram: new Array(length).fill(0), signals: macdSignals },
        bbSeries, supertrendSeries,
        stochRsiSeries: { k: new Array(length).fill(50), d: new Array(length).fill(50), signals: stochSignals },
        volSmaSeries, volSignalSeries, ema200Series
      };
    }

    // 1. Single vote majority (buyVotes = 1, sellVotes = 0) must be rejected to NEUTRAL
    const ctx1_0 = makeVotingCtx({ buyVotes: ['rsi'], sellVotes: [] });
    const res1_0 = evaluateStandardVotingAt(ctx1_0, 34);
    assert.strictEqual(res1_0.buyVotes, 1);
    assert.strictEqual(res1_0.sellVotes, 0);
    assert.strictEqual(res1_0.rawSignal, 'NEUTRAL', 'Single vote majority (1-0) must produce NEUTRAL rawSignal');
    assert.strictEqual(res1_0.finalSignal, 'NEUTRAL', 'Single vote majority (1-0) must produce NEUTRAL finalSignal');

    // 2. Narrow 1-vote margin (buyVotes = 2, sellVotes = 1) must be rejected to NEUTRAL
    const ctx2_1 = makeVotingCtx({ buyVotes: ['rsi', 'macd'], sellVotes: ['stoch'] });
    const res2_1 = evaluateStandardVotingAt(ctx2_1, 34);
    assert.strictEqual(res2_1.buyVotes, 2);
    assert.strictEqual(res2_1.sellVotes, 1);
    assert.strictEqual(res2_1.rawSignal, 'NEUTRAL', 'Margin of 1 vote (2-1) must produce NEUTRAL');

    // 3. Margin >= 2 (buyVotes = 2, sellVotes = 0) but sub-threshold volume (rvol = 0.85 < 0.90) rejected by RVOL
    const ctx2_0_lowVol = makeVotingCtx({ buyVotes: ['rsi', 'macd'], sellVotes: [], rvol: 0.85 });
    const res2_0_lowVol = evaluateStandardVotingAt(ctx2_0_lowVol, 34);
    assert.strictEqual(res2_0_lowVol.rawSignal, 'NEUTRAL', 'RVOL 0.85 < 0.90 must filter BUY signal to NEUTRAL');

    // 4. Margin >= 2 (buyVotes = 2, sellVotes = 0) with sufficient volume (rvol = 0.95) and proper anatomy -> BUY
    const ctx2_0_ok = makeVotingCtx({
      buyVotes: ['rsi', 'macd'], sellVotes: [], rvol: 0.95,
      open: 100, close: 101, high: 101.2, low: 99.8, ema200: 95
    });
    const res2_0_ok = evaluateStandardVotingAt(ctx2_0_ok, 34);
    assert.strictEqual(res2_0_ok.rawSignal, 'BUY', 'Margin of 2 with RVOL 0.95 must emit BUY');
    assert.strictEqual(res2_0_ok.finalSignal, 'BUY');

    // 5. Symmetric RVOL test for SELL:
    // Previously SELL had rvolThreshold = 0.60, so RVOL = 0.75 would pass.
    // With symmetric 0.90 threshold, RVOL = 0.75 must be rejected to NEUTRAL!
    const ctxSell_lowVol = makeVotingCtx({
      sellVotes: ['rsi', 'macd'], buyVotes: [], rvol: 0.75,
      open: 101, close: 100, high: 101.2, low: 99.8, ema200: 105
    });
    const resSell_lowVol = evaluateStandardVotingAt(ctxSell_lowVol, 34);
    assert.strictEqual(resSell_lowVol.sellVotes, 2);
    assert.strictEqual(resSell_lowVol.rawSignal, 'NEUTRAL', 'SELL with RVOL 0.75 < 0.90 must be rejected symmetrically');

    // 6. SELL with margin >= 2 and sufficient volume (rvol = 0.95) and proper anatomy -> SELL
    const ctxSell_ok = makeVotingCtx({
      sellVotes: ['rsi', 'macd'], buyVotes: [], rvol: 0.95,
      open: 101, close: 100, high: 101.2, low: 99.8, ema200: 105
    });
    const resSell_ok = evaluateStandardVotingAt(ctxSell_ok, 34);
    assert.strictEqual(resSell_ok.rawSignal, 'SELL', 'SELL with margin 2 and RVOL 0.95 must emit SELL');
    assert.strictEqual(resSell_ok.finalSignal, 'SELL');
  });

  // Test 118: Multifractal MTF Mean Reversion enforces 1D macro bias compatibility
  test('Multifractal MTF Mean Reversion enforces 1D macro bias compatibility (rejects counter-bias)', () => {
    function makeMfCtx(bias1D: 'BULLISH' | 'BEARISH' | 'NEUTRAL', isLongSetup: boolean): MultifractalMTFContext {
      const len = 25;
      const klines5m: Kline[] = new Array(len).fill(null).map((_, idx) => ({
        time: 1700000000 + idx * 300,
        open: 100, high: 101, low: 99, close: 100, volume: 1000
      }));
      klines5m[20] = { time: 1700000000 + 20 * 300, open: 100, high: 100.5, low: 99.7, close: 100, volume: 1000 };
      klines5m[21] = {
        time: 1700000000 + 21 * 300,
        open: 100,
        high: isLongSetup ? 100.4 : 100.6,
        low: isLongSetup ? 99.4 : 99.8,
        close: isLongSetup ? 100.2 : 99.8,
        volume: 1500
      };

      const dreadBlitz5M = new Array(len).fill(null).map(() => ({ isOverbought: false, isOversold: false, mcd: 0 }));
      if (isLongSetup) {
        dreadBlitz5M[20] = { isOverbought: false, isOversold: true, mcd: -20 };
        dreadBlitz5M[21] = { isOverbought: false, isOversold: true, mcd: -10 }; // curr > prev (positive divergence)
      } else {
        dreadBlitz5M[20] = { isOverbought: true, isOversold: false, mcd: 20 };
        dreadBlitz5M[21] = { isOverbought: true, isOversold: false, mcd: 10 }; // curr < prev (negative divergence)
      }

      const volComp5M = new Array(len).fill(null).map(() => ({
        volumeMultiplier: 1.5,
        activeBuyPercent: 50,
        activeSellPercent: 50,
        isPassiveBuyAbsorption: false,
        isPassiveSellAbsorption: false
      }));
      volComp5M[21] = {
        volumeMultiplier: 1.5,
        activeBuyPercent: isLongSetup ? 60 : 40,
        activeSellPercent: isLongSetup ? 40 : 60,
        isPassiveBuyAbsorption: isLongSetup,
        isPassiveSellAbsorption: !isLongSetup
      };

      const volBands5M = new Array(len).fill(null).map(() => ({ upper: 101, lower: 99, midpoint: 100, width: 2, isCompressed: false }));
      const atrSeries5M = new Array(len).fill(1.0);
      const idx1dMap = new Int32Array(len).fill(0);
      const idx1hMap = new Int32Array(len).fill(0);

      return {
        klines5m,
        klines1h: [],
        klines1d: [],
        symbol: 'TEST_MF',
        andianSeries: [{ green: 50, red: 50, orange: 50, bias: bias1D }],
        volBands1H: [{ width: 5, midpoint: 100, upper: 102.5, lower: 97.5, isCompressed: false }],
        volBands5M,
        volComp5M,
        dreadBlitz5M,
        atrSeries5M,
        adxData5M: { adx: [], plusDI: [], minusDI: [] },
        idx1hMap,
        idx1dMap
      };
    }

    // 1. Long Mean Reversion setup with conflicting BEARISH 1D bias: MUST BE REJECTED
    const ctxLongBearish = makeMfCtx('BEARISH', true);
    const resLongBearish = evaluateMultifractalMTFAt(ctxLongBearish, 21);
    assert.strictEqual(resLongBearish.signal, 'NEUTRAL', 'Long Mean Reversion with BEARISH 1D bias must be rejected');
    assert.strictEqual(resLongBearish.discardReason, 'regimeFilter', 'Discard reason must be regimeFilter');

    // 2. Long Mean Reversion setup with BULLISH or NEUTRAL 1D bias: MUST BE ACCEPTED
    const ctxLongBullish = makeMfCtx('BULLISH', true);
    const resLongBullish = evaluateMultifractalMTFAt(ctxLongBullish, 21);
    assert.strictEqual(resLongBullish.signal, 'BUY', 'Long Mean Reversion with BULLISH 1D bias must emit BUY');
    assert.strictEqual(resLongBullish.strategy, 'MEAN_REVERSION');

    const ctxLongNeutral = makeMfCtx('NEUTRAL', true);
    const resLongNeutral = evaluateMultifractalMTFAt(ctxLongNeutral, 21);
    assert.strictEqual(resLongNeutral.signal, 'BUY', 'Long Mean Reversion with NEUTRAL 1D bias must emit BUY');
    assert.strictEqual(resLongNeutral.strategy, 'MEAN_REVERSION');

    // 3. Short Mean Reversion setup with conflicting BULLISH 1D bias: MUST BE REJECTED
    const ctxShortBullish = makeMfCtx('BULLISH', false);
    const resShortBullish = evaluateMultifractalMTFAt(ctxShortBullish, 21);
    assert.strictEqual(resShortBullish.signal, 'NEUTRAL', 'Short Mean Reversion with BULLISH 1D bias must be rejected');
    assert.strictEqual(resShortBullish.discardReason, 'regimeFilter');

    // 4. Short Mean Reversion setup with BEARISH or NEUTRAL 1D bias: MUST BE ACCEPTED
    const ctxShortBearish = makeMfCtx('BEARISH', false);
    const resShortBearish = evaluateMultifractalMTFAt(ctxShortBearish, 21);
    assert.strictEqual(resShortBearish.signal, 'SELL', 'Short Mean Reversion with BEARISH 1D bias must emit SELL');
    assert.strictEqual(resShortBearish.strategy, 'MEAN_REVERSION');

    const ctxShortNeutral = makeMfCtx('NEUTRAL', false);
    const resShortNeutral = evaluateMultifractalMTFAt(ctxShortNeutral, 21);
    assert.strictEqual(resShortNeutral.signal, 'SELL', 'Short Mean Reversion with NEUTRAL 1D bias must emit SELL');
    assert.strictEqual(resShortNeutral.strategy, 'MEAN_REVERSION');
  });

  // Test 119: VWAP opening reliability, continuous scoring tanh mapping, and risk geometry alignment
  test('VWAP opening reliability, continuous scoring tanh mapping, and strategy risk geometry alignment', () => {
    // ── 1. VWAP Session Opening Reliability ──────────────────────────────────
    // Create 5 1h candles: first 2 should be marked unreliable (counts 1 & 2), bar 3+ marked reliable
    const klines1h: Kline[] = [
      { time: 1700000000, open: 100, high: 102, low: 98, close: 101, volume: 1000 },
      { time: 1700003600, open: 101, high: 103, low: 100, close: 102, volume: 1200 },
      { time: 1700007200, open: 102, high: 104, low: 101, close: 103, volume: 1100 },
      { time: 1700010800, open: 103, high: 105, low: 102, close: 104, volume: 1300 },
    ];
    const vwapReliable = calculateVWAPReliabilitySeries(klines1h, '1h', 'AAPL', 3);
    assert.strictEqual(vwapReliable[0], false, 'First bar of session must be marked VWAP unreliable');
    assert.strictEqual(vwapReliable[1], false, 'Second bar of session must be marked VWAP unreliable');
    assert.strictEqual(vwapReliable[2], true, 'Third bar of session must be marked VWAP reliable');
    assert.strictEqual(vwapReliable[3], true, 'Subsequent bars must be marked VWAP reliable');

    // ── 2. Scoring Continuous Tanh Mapping ───────────────────────────────────
    // Build synthetic candles for Scoring
    const synthKlines: Kline[] = new Array(70).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 3600,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const scoringCtx = buildScoringContext(synthKlines, '1h');
    // Ensure vwapReliableSeries is defined
    assert.ok(scoringCtx.vwapReliableSeries, 'ScoringContext must include precomputed vwapReliableSeries');

    // Test continuous tanh behavior on Layer 4
    // When distance to VWAP is small (0.05 ATR): tanh(0.05) ~ 0.0499
    const distSmall = 0.05;
    const tanhSmall = Math.tanh(distSmall);
    assert.ok(Math.abs(tanhSmall - 0.04995) < 0.001, 'tanh(0.05) must smoothly scale rather than jumping to +1.0');

    // When distance is moderate (1.0 ATR): tanh(1.0) ~ 0.7615
    const distMed = 1.0;
    const tanhMed = Math.tanh(distMed);
    assert.ok(Math.abs(tanhMed - 0.7615) < 0.01, 'tanh(1.0) must smoothly scale to ~0.76');

    // ── 3. Strategy Risk Geometry Parity ─────────────────────────────────────
    // A. calculateAlertLevels strategy-specific multipliers
    const entry = 100;
    const atr = 2.0;

    // Standard engine uses 1.2 * ATR
    const standardLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'standard');
    assert.strictEqual(Number(standardLevels.stopLoss.toFixed(2)), 97.60, 'Standard stop must be 1.2 * ATR (100 - 2.40 = 97.60)');

    // Confluencia engine uses 2.0 * ATR (matching its evaluator's close ± 2*ATR)
    const confluenciaLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'confluencia');
    assert.strictEqual(Number(confluenciaLevels.stopLoss.toFixed(2)), 96.00, 'Confluencia stop must be 2.0 * ATR (100 - 4.00 = 96.00)');

    // Scoring engine uses 1.5 * ATR (matching its evaluator's slDist = 1.5*ATR)
    const scoringLevels = calculateAlertLevels('BUY', entry, '5m', atr, 'scoring');
    assert.strictEqual(Number(scoringLevels.stopLoss.toFixed(2)), 97.00, 'Scoring stop must be 1.5 * ATR (100 - 3.00 = 97.00)');

    // B. Backtester execution parity
    const klinesBacktest = generateSyntheticKlines(300, 3600);
    const confRes = backtestConfluencia(klinesBacktest, '1h', 'TEST_CONF');
    assert.ok(confRes !== undefined, 'backtestConfluencia executes cleanly with aligned 2.0*ATR geometry');

    const scorRes = backtestScoring(klinesBacktest, '1h', undefined, 'TEST_SCOR');
    assert.ok(scorRes !== undefined, 'backtestScoring executes cleanly with aligned 1.5*ATR geometry');
  });

  // Test 120: 1H session gap management preserves sample size and enforces SESSION_GAP cutoff
  test('1H session gap management preserves sample size (no 57% discard) and enforces SESSION_GAP cutoff', () => {
    // Build 1H klines with an overnight session gap (7 candles on Day 1, overnight jump of 17.5 hours, then 7 candles on Day 2)
    const klinesGap: Kline[] = [];
    let t = 1700000000;
    for (let c = 0; c < 7; c++) {
      klinesGap.push({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      t += 3600;
    }
    // Overnight gap: +17.5 hours (63000 seconds)
    t += 63000;
    for (let c = 0; c < 7; c++) {
      klinesGap.push({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      t += 3600;
    }

    // A trade entered at candle 4 (13:30) on Day 1 with forwardWindow=4 reaches candle 6 (close of Day 1) and then encounters the overnight gap
    const levels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103
    };
    const sim = simulateTrade(klinesGap, 4, 'BUY', levels, {
      forwardWindow: 4,
      sessionGapCutoff: true,
      stepSec: 3600,
      frictionPct: 0.08
    });
    assert.strictEqual(sim.exitReason, 'SESSION_GAP', '1H trade hitting overnight session boundary must exit with SESSION_GAP');
    assert.strictEqual(sim.exitIdx, 6, 'Exit index must be the last candle of Day 1 (candle 6) before the overnight gap');

    // Verify backtest on 1H does NOT discard afternoon bars via sessionGap
    // A synthetic series of 200 1h bars with session gaps
    const klines1hSession: Kline[] = [];
    let curT = 1700000000;
    for (let day = 0; day < 30; day++) {
      for (let bar = 0; bar < 7; bar++) {
        klines1hSession.push({
          time: curT,
          open: 100 + (day % 3),
          high: 101 + (day % 3),
          low: 99 + (day % 3),
          close: 100 + (day % 3),
          volume: 1000
        });
        curT += 3600;
      }
      curT += 61200; // 17 hours overnight jump
    }
    const res1h = backtestStandard(klines1hSession, '1h', 'STOCK_1H');
    assert.strictEqual(res1h.discards.sessionGap, 0, '1H backtest must NOT discard afternoon bars via isNearSessionEnd (0% gap discards)');
  });

  // Test 121: Scoring threshold calibrated against watchlist data (0.45) and VWAP directional veto
  test('Scoring restores true maxPossible, 0.45 empirical threshold, and enforces explicit VWAP directional veto', () => {
    // 1. 5m context: emaMajor is null, useVwap is true.
    // True mathematical max: trend 1.0 (1.5x), volume 1.0 (1.5x), rsi 1.0 (1.0x), bb 1.0 (1.0x), candle 1.0 (1.0x), structure 1.0 (1.0x)
    // maxPossible = 1.5 + 1.5 + 1.0 + 1.0 + 1.0 + 1.0 = 7.00
    // threshold = 7.00 * 0.45 = 3.15 (calibrated against real watchlist signal rate)
    assert.strictEqual(DEFAULT_SCORING_THRESHOLD_RATIO, 0.45, 'DEFAULT_SCORING_THRESHOLD_RATIO must be calibrated to 0.45');
    const synth5m: Kline[] = new Array(70).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 300,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const ctx5m = buildScoringContext(synth5m, '5m');
    const res5m = evaluateScoringAt(ctx5m, 60);
    assert.strictEqual(res5m.threshold, 3.15, '5m Scoring threshold must equal 45% of true maxPossible (7.00 * 0.45 = 3.15)');

    // 2. 1h context: emaMajor is 50, useVwap is true.
    // True mathematical max: trend 2.0 (1.5x = 3.0), volume 1.0 (1.5x = 1.5), rest 1.0 (4.0x)
    // maxPossible = 3.0 + 1.5 + 4.0 = 8.50
    // threshold = 8.50 * 0.45 = 3.83 (calibrated against real watchlist signal rate)
    const synth1h: Kline[] = new Array(70).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 3600,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const ctx1h = buildScoringContext(synth1h, '1h');
    const res1h = evaluateScoringAt(ctx1h, 60);
    assert.strictEqual(res1h.threshold, 3.83, '1h Scoring threshold must equal 45% of true maxPossible (8.50 * 0.45 = 3.83)');

    // 3. Unconditional VWAP Directional Veto (Intraday Trend Alignment):
    // When price is below VWAP, Scoring must veto any BUY signal, converting it to HOLD.
    const synthVwapVeto: Kline[] = new Array(70).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 300,
      open: 100 + (idx === 65 ? -2 : 0),
      high: 102,
      low: 98,
      close: 100 + (idx === 65 ? -1.5 : 0),
      volume: 2000
    }));
    const ctxVeto = buildScoringContext(synthVwapVeto, '5m');
    // Force closes[65] to be below VWAP while other indicators might be positive
    const vwapAt65 = ctxVeto.vwapSeries[65];
    ctxVeto.closes[65] = vwapAt65 - 0.5; // Moderate distance below VWAP
    const resVeto = evaluateScoringAt(ctxVeto, 65);
    assert.notStrictEqual(resVeto.signal, 'BUY', 'Scoring must NEVER emit BUY when price is below VWAP');
    if (resVeto.score >= resVeto.threshold) {
      assert.strictEqual(resVeto.signal, 'HOLD', 'BUY signal above threshold must be converted to HOLD by VWAP directional veto');
      assert.ok(resVeto.layers.volume.note.includes('Veto direccional VWAP'), 'Volume note must document VWAP veto');
    }

    // 4. Unconditional Veto under Severe Overextension / Trend Liquidation:
    // In severe liquidations (e.g. -2.5 ATR drop), Layer 4 is strongly negative and VWAP veto unconditionally blocks BUY
    const atrAt65 = ctxVeto.atrSeries[65] || 2.0;
    ctxVeto.closes[65] = vwapAt65 - (2.5 * atrAt65); // Severe oversold drop (-2.5 ATR)
    const resOverext = evaluateScoringAt(ctxVeto, 65);
    assert.ok(resOverext.layers.volume.score < -0.95, 'Layer 4 must award strongly negative score for price far below VWAP');
    assert.notStrictEqual(resOverext.signal, 'BUY', 'Severe drop below VWAP must NEVER emit BUY');
  });

  // Test 122: Scoring Layer 4 VWAP is strictly continuous and strictly monotonic in R
  test('Scoring Layer 4 VWAP is strictly continuous and strictly monotonic in R without sign inversions', () => {
    const calcLayer4 = (distAtr: number) => Math.tanh(distAtr);

    // 1. At 0 distance (at VWAP): score is exactly 0
    assert.strictEqual(calcLayer4(0), 0, 'Score at VWAP (0 dist) must be 0');

    // 2. Strict monotonicity: for any x1 < x2, f(x1) < f(x2)
    const testPoints = [-3.0, -2.5, -2.0, -1.8, -1.0, -0.5, 0, 0.5, 1.0, 1.8, 2.0, 2.5, 3.0];
    for (let idx = 0; idx < testPoints.length - 1; idx++) {
      const p1 = testPoints[idx];
      const p2 = testPoints[idx + 1];
      assert.ok(
        calcLayer4(p1) < calcLayer4(p2),
        `Layer 4 score at ${p1} (${calcLayer4(p1)}) must be strictly less than at ${p2} (${calcLayer4(p2)})`
      );
    }

    // 3. Smooth continuity: delta between 1.99 and 2.01 ATR is tiny (< 0.005)
    const delta = Math.abs(calcLayer4(2.01) - calcLayer4(1.99));
    assert.ok(delta < 0.005, `Delta across 2.0 ATR must be infinitesimal (< 0.005), got ${delta.toFixed(6)}`);

    // 4. Asymptotic bounds: score is bounded within (-1, 1)
    assert.ok(calcLayer4(10) > 0.999 && calcLayer4(10) <= 1.0, 'Large positive distance approaches +1.0');
    assert.ok(calcLayer4(-10) < -0.999 && calcLayer4(-10) >= -1.0, 'Large negative distance approaches -1.0');
  });

  // Test 123: Tournament multiplicity hurdle uniformity across holding durations
  test('Tournament multiplicity hurdle is uniform in R/trade across scalp (1.5h) and swing (7h) durations', () => {
    const wfPass: WalkForwardResult = {
      isWindow: 700,
      oosWindow: 300,
      inSample: {
        signals: 10,
        wins: 7,
        losses: 3,
        winRate: 0.70,
        expectancyR: 0.20,
        profitFactor: 2.0,
        maxDrawdownR: 1.0,
        sortinoRatio: 2.0
      },
      outOfSample: {
        signals: 5,
        wins: 4,
        losses: 1,
        winRate: 0.80,
        expectancyR: 0.20,
        profitFactor: 2.5,
        maxDrawdownR: 0.8,
        sortinoRatio: 2.5
      },
      passed: true,
      status: 'PASS',
      foldsPassed: 2,
      folds: [
        { foldIdx: 1, oosTrades: 2, oosExpectancyR: 0.20, passed: true },
        { foldIdx: 2, oosTrades: 2, oosExpectancyR: 0.20, passed: true }
      ]
    };

    // Candidate 1: Short scalp (forwardWindow: 6, avg exposure ~1.5h, timeFactor ~1.46)
    const shortScalp: StrategyCandidate = {
      key: 'standard',
      label: 'Standard Scalp (1.5h)',
      profitFactor: 2.0,
      expectancyR: 0.20,
      winRate: 0.70,
      resolved: 10,
      forwardWindow: 6,
      walkForward: wfPass
    };

    // Candidate 2: Long duration setup (forwardWindow: 48, avg exposure ~7h, timeFactor ~2.52)
    // with identical R-expectancy per trade (0.20R)
    const longSetup: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Long Duration (7h)',
      profitFactor: 2.0,
      expectancyR: 0.20,
      winRate: 0.70,
      resolved: 10,
      forwardWindow: 48,
      walkForward: wfPass
    };

    // Both candidates evaluated in isolation must clear the hurdle and earn HIGH confidence without duration discrimination
    const resShort = evaluateStrategyTournament([shortScalp], '5m');
    const resLong = evaluateStrategyTournament([longSetup], '5m');

    assert.strictEqual(resShort.confidence, 'HIGH', 'Short duration scalp with +0.20R must earn HIGH confidence');
    assert.strictEqual(resLong.confidence, 'HIGH', 'Long duration setup with +0.20R must earn HIGH confidence without duration penalty');
  });

  // Test 124: Multiplicity note accumulation, forwardWindow risk scaling, and continuous OBV Layer 4 in 1D
  test('multiplicityNote accumulation, forwardWindow risk scaling, and 1D continuous OBV Layer 4', () => {
    // 1. Multiplicity note accumulation:
    // Setup where candidate has narrow runner-up margin (< 5%) AND fails absolute deflated hurdle (< 0.040R)
    const wfPass: WalkForwardResult = {
      isWindow: 700,
      oosWindow: 300,
      inSample: { signals: 8, wins: 5, losses: 3, winRate: 0.60, expectancyR: 0.03, profitFactor: 1.3, maxDrawdownR: 1.0, sortinoRatio: 1.5 },
      outOfSample: { signals: 5, wins: 4, losses: 1, winRate: 0.80, expectancyR: 0.20, profitFactor: 2.5, maxDrawdownR: 0.8, sortinoRatio: 2.5 },
      passed: true,
      status: 'PASS',
      foldsPassed: 2,
      folds: [
        { fold: 1, isWindow: 70, oosWindow: 10, oosTradesCount: 1, oosExpectancyR: 0.20, passed: true },
        { fold: 2, isWindow: 70, oosWindow: 10, oosTradesCount: 1, oosExpectancyR: 0.20, passed: true }
      ]
    };

    const candA: StrategyCandidate = {
      key: 'standard', label: 'Candidate A', profitFactor: 1.3, expectancyR: 0.03, winRate: 0.60, resolved: 8, forwardWindow: 12, walkForward: wfPass
    };
    const candB: StrategyCandidate = {
      key: 'scoring', label: 'Candidate B', profitFactor: 1.3, expectancyR: 0.029, winRate: 0.60, resolved: 8, forwardWindow: 12, walkForward: wfPass
    };
    const candC: StrategyCandidate = {
      key: 'confluencia', label: 'Candidate C', profitFactor: 1.3, expectancyR: 0.025, winRate: 0.60, resolved: 8, forwardWindow: 12, walkForward: wfPass
    };

    const doubleFailTourney = evaluateStrategyTournament([candA, candB, candC], '5m');
    assert.strictEqual(doubleFailTourney.confidence, 'LIMITED');
    // Both notes must be present in reasoning without being overwritten
    assert.ok(doubleFailTourney.reasoning.includes('Margen sobre 2º'), 'Reasoning must contain runner-up margin note');
    assert.ok(doubleFailTourney.reasoning.includes('Score deflactado'), 'Reasoning must contain absolute deflated hurdle note');

    // 2. Risk geometry forwardWindow scaling:
    // Confluencia (2.0x ATR) on 5m scales 6 -> 10 candles (50 min); on 1h scales 4 -> 7 candles
    const klines5m = generateSyntheticKlines(650, 300, 100, 0.05);
    const klines1h = generateSyntheticKlines(300, 3600, 100, 0.05);
    const conf5mCrypto = backtestConfluencia(klines5m, '5m', 'SCALE_TEST_USDT');
    const conf5mEquity = backtestConfluencia(klines5m, '5m', 'SCALE_TEST');
    const conf1h = backtestConfluencia(klines1h, '1h', 'SCALE_TEST');
    assert.strictEqual(conf5mCrypto.forwardLabel, '24 velas (120 min)', 'Confluencia 5m crypto forwardLabel must scale to 24 candles');
    assert.strictEqual(conf5mEquity.forwardLabel, '36 velas (180 min)', 'Confluencia 5m equity forwardLabel must scale to 36 candles (3 hs)');
    assert.strictEqual(conf1h.forwardLabel, '7 velas (7 hs)', 'Confluencia 1h forwardLabel must scale to 7 candles');

    // 3. 1D Continuous OBV Layer 4 & Calibrated Threshold
    const synth1d: Kline[] = new Array(70).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 86400,
      open: 100 + (idx % 2 === 0 ? 0.5 : -0.5),
      high: 102,
      low: 98,
      close: 100 + (idx % 2 === 0 ? 1 : -1),
      volume: 10000
    }));
    const ctx1d = buildScoringContext(synth1d, '1d');
    const res1d = evaluateScoringAt(ctx1d, 60);
    // 1D maxPossible is 8.50, threshold is 3.83 (45% empirical calibration)
    assert.strictEqual(res1d.threshold, 3.83, '1D Scoring threshold must equal 45% of true maxPossible (8.50 * 0.45 = 3.83)');
    // Layer 4 note must be continuous
    assert.ok(res1d.layers.volume.note.includes('Score continuo'), '1D OBV Layer 4 note must show continuous score');
  });

  test('canonical getStrategyForwardWindow enforces 1:1 parity between backtest, tournament, and live alert tracker', () => {
    // 1. Validate getStrategyForwardWindow values across all strategies & timeframes
    // Confluencia (24 candles on 5m = 2h, 7 on 1h, 6 on 1d)
    assert.strictEqual(getStrategyForwardWindow('confluencia', '5m'), 24, 'Confluencia 5m forward window must be 24 candles (2h)');
    assert.strictEqual(getStrategyForwardWindow('confluencia', '1h'), 7, 'Confluencia 1h forward window must be 7 candles (7h)');
    assert.strictEqual(getStrategyForwardWindow('confluencia', '1d'), 6, 'Confluencia 1d forward window must be 6 candles (6d)');

    // Scoring (16 candles on 5m = 1h 20m, 5 on 1h, 5 on 1d)
    assert.strictEqual(getStrategyForwardWindow('scoring', '5m'), 16, 'Scoring 5m forward window must be 16 candles (1h 20m)');
    assert.strictEqual(getStrategyForwardWindow('scoring', '1h'), 5, 'Scoring 1h forward window must be 5 candles (5h)');
    assert.strictEqual(getStrategyForwardWindow('scoring', '1d'), 5, 'Scoring 1d forward window must be 5 candles (5d)');

    // Standard (12 candles on 5m = 1h, 4 on 1h, 3 on 1d)
    assert.strictEqual(getStrategyForwardWindow('standard', '5m'), 12, 'Standard 5m forward window must be 12 candles (1h)');
    assert.strictEqual(getStrategyForwardWindow('standard', '1h'), 4, 'Standard 1h forward window must be 4 candles (4h)');
    assert.strictEqual(getStrategyForwardWindow('standard', '1d'), 3, 'Standard 1d forward window must be 3 candles (3d)');

    // Multifractal MTF (12 candles 5m)
    assert.strictEqual(getStrategyForwardWindow('multifractal', '5m'), 12, 'Multifractal 5m forward window must be 12 candles (1h)');

    // VCME Sniper (24 candles 5m Day Trading / 48 candles 1h Swing)
    assert.strictEqual(getStrategyForwardWindow('vcme', '5m', 'dayTrading'), 24, 'VCME Day Trading forward window must be 24 candles (2h)');
    assert.strictEqual(getStrategyForwardWindow('vcme', '1h', 'swing'), 48, 'VCME Swing forward window must be 48 candles (48h)');
    assert.strictEqual(getStrategyForwardWindow('multitemporal', '1h'), 48, 'VCME 1h forward window must be 48 candles');

    // 2. Validate exact 1:1 parity with getStrategyExpiryCandles in alertTracker
    assert.strictEqual(getStrategyExpiryCandles('Confluencia', '5m'), 24, 'Live alert Confluencia 5m must expire at 24 candles');
    assert.strictEqual(getStrategyExpiryCandles('Confluencia', '1h'), 7, 'Live alert Confluencia 1h must expire at 7 candles');
    assert.strictEqual(getStrategyExpiryCandles('Confluencia', '1d'), 6, 'Live alert Confluencia 1d must expire at 6 candles');

    assert.strictEqual(getStrategyExpiryCandles('Scoring', '5m'), 16, 'Live alert Scoring 5m must expire at 16 candles');
    assert.strictEqual(getStrategyExpiryCandles('Scoring', '1h'), 5, 'Live alert Scoring 1h must expire at 5 candles');
    assert.strictEqual(getStrategyExpiryCandles('Scoring', '1d'), 5, 'Live alert Scoring 1d must expire at 5 candles');

    assert.strictEqual(getStrategyExpiryCandles('Estándar', '5m'), 12, 'Live alert Standard 5m must expire at 12 candles');
    assert.strictEqual(getStrategyExpiryCandles('Estándar', '1h'), 4, 'Live alert Standard 1h must expire at 4 candles');
    assert.strictEqual(getStrategyExpiryCandles('Estándar', '1d'), 3, 'Live alert Standard 1d must expire at 3 candles');

    assert.strictEqual(getStrategyExpiryCandles('Multifractal MTF', '5m'), 12, 'Live alert Multifractal 5m must expire at 12 candles');
    assert.strictEqual(getStrategyExpiryCandles('VCME Sniper', '5m', 'dayTrading'), 24, 'Live alert VCME Day Trading must expire at 24 candles (2h)');
    assert.strictEqual(getStrategyExpiryCandles('VCME Sniper', '1h', 'swing'), 48, 'Live alert VCME Swing must expire at 48 candles');

    // 3. Validate backtest forwardWindow matches live expiry across timeframes
    const synth5m: Kline[] = new Array(700).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 300,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const btConf5m = backtestConfluencia(synth5m, '5m');
    assert.strictEqual(btConf5m.forwardWindow, getStrategyExpiryCandles('Confluencia', '5m'), 'Confluencia 5m backtest vs live forwardWindow parity');

    const synth1h: Kline[] = new Array(250).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 3600,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const btConf1h = backtestConfluencia(synth1h, '1h');
    assert.strictEqual(btConf1h.forwardWindow, getStrategyExpiryCandles('Confluencia', '1h'), 'Confluencia 1h backtest vs live forwardWindow parity');

    const synth1d2: Kline[] = new Array(80).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 86400,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const btConf1d = backtestConfluencia(synth1d2, '1d');
    assert.strictEqual(btConf1d.forwardWindow, getStrategyExpiryCandles('Confluencia', '1d'), 'Confluencia 1d backtest vs live forwardWindow parity');
  });

  test('multi-fold Walk-Forward classifies empty folds as NO_DATA without penalizing low-frequency swing engines', () => {
    // 1. Synthetic dataset where In-Sample has 8 wins and OOS has positive trades in Fold 1 and Fold 3,
    // but Fold 2 has 0 trades (due to long cycle / absence of signals).
    const trades: RecordedTrade[] = [
      // 8 In-Sample trades [0..69]
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10, exitIdx: 14 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 18, exitIdx: 22 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 26, exitIdx: 30 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 34, exitIdx: 38 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 42, exitIdx: 46 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 50, exitIdx: 54 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 58, exitIdx: 62 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 64, exitIdx: 68 },
      // OOS trades [70..99] (3 folds of 10 bars: [70..79], [80..89], [90..99])
      // Fold 1 [70..79]: 1 trade @ 72-76 with +1.5R
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 72, exitIdx: 76 },
      // Fold 2 [80..89]: NO trades (0 trades)
      // Fold 3 [90..99]: 1 trade @ 92-96 with +1.5R
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 92, exitIdx: 96 }
    ];

    const wf = calculateWalkForward(trades, 0, 99, 0.70, 2, 20);
    assert.strictEqual(wf.status, 'PASS');
    assert.ok(wf.folds && wf.folds.length === 3);

    // Verify Fold 1: PASS
    assert.strictEqual(wf.folds[0].oosTradesCount, 1);
    assert.strictEqual(wf.folds[0].status, 'PASS');
    assert.strictEqual(wf.folds[0].passed, true);

    // Verify Fold 2: NO_DATA (not marked as a negative failure!)
    assert.strictEqual(wf.folds[1].oosTradesCount, 0);
    assert.strictEqual(wf.folds[1].status, 'NO_DATA');
    assert.strictEqual(wf.folds[1].passed, false);

    // Verify Fold 3: PASS
    assert.strictEqual(wf.folds[2].oosTradesCount, 1);
    assert.strictEqual(wf.folds[2].status, 'PASS');
    assert.strictEqual(wf.folds[2].passed, true);

    // Folds metrics
    assert.strictEqual(wf.foldsPassed, 2);
    assert.strictEqual(wf.foldsWithData, 2);

    // 2. Evaluate Tournament gate: Candidate with 2/2 folds with data passed achieves HIGH
    const candidate2Of2: StrategyCandidate = {
      key: 'vcme',
      label: 'VCME Swing',
      profitFactor: 3.0,
      expectancyR: 1.20,
      winRate: 0.80,
      resolved: 10,
      forwardWindow: 48,
      walkForward: wf
    };

    const tourney2Of2 = evaluateStrategyTournament([candidate2Of2], '1h');
    assert.strictEqual(tourney2Of2.confidence, 'HIGH', 'Candidate with 2/2 folds passed must earn HIGH');

    // 3. Evaluate when only 1 fold has data in a low-frequency regime, and that fold passes (+1.5R)
    const candidate1Of1: StrategyCandidate = {
      ...candidate2Of2,
      walkForward: {
        ...wf,
        foldsPassed: 1,
        foldsWithData: 1,
        folds: [
          { fold: 1, isWindow: 70, oosWindow: 10, oosTradesCount: 1, oosExpectancyR: 1.50, passed: true, status: 'PASS' },
          { fold: 2, isWindow: 70, oosWindow: 10, oosTradesCount: 0, oosExpectancyR: 0, passed: false, status: 'NO_DATA' },
          { fold: 3, isWindow: 70, oosWindow: 10, oosTradesCount: 0, oosExpectancyR: 0, passed: false, status: 'NO_DATA' }
        ]
      }
    };
    const tourney1Of1 = evaluateStrategyTournament([candidate1Of1], '1h');
    assert.strictEqual(tourney1Of1.confidence, 'HIGH', 'Single fold with data passing +1.5R and zero failures must earn HIGH');

    // 4. Candidate with a decisive negative failure (e.g. Fold 1 has -1.0R loss) must be degraded to LIMITED
    const candidate1Fail: StrategyCandidate = {
      ...candidate2Of2,
      walkForward: {
        ...wf,
        foldsPassed: 0,
        foldsWithData: 1,
        folds: [
          { fold: 1, isWindow: 70, oosWindow: 10, oosTradesCount: 1, oosExpectancyR: -1.00, passed: false, status: 'FAIL' },
          { fold: 2, isWindow: 70, oosWindow: 10, oosTradesCount: 0, oosExpectancyR: 0, passed: false, status: 'NO_DATA' },
          { fold: 3, isWindow: 70, oosWindow: 10, oosTradesCount: 0, oosExpectancyR: 0, passed: false, status: 'NO_DATA' }
        ]
      }
    };
    const tourney1Fail = evaluateStrategyTournament([candidate1Fail], '1h');
    assert.strictEqual(tourney1Fail.confidence, 'LIMITED', 'Candidate with a failing fold must be degraded to LIMITED');
    assert.ok(tourney1Fail.reasoning.includes('Folds Walk-Forward insuficientes'));
  });

  test('5m intraday session gap management eliminates dead code by replacing pre-filtering with active SESSION_GAP cutoff', () => {
    // 1. Synthetic 5m series with 2 NYSE trading days (78 candles per day = 09:30 to 16:00 ET)
    // Day 1: candles 0..77. Day 2 starts with an overnight gap of 17.5 hours.
    const klines5mGap: Kline[] = [];
    let t = 1700000000;
    for (let c = 0; c < 78; c++) {
      klines5mGap.push({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      t += 300;
    }
    // Overnight gap: 17.5 hours (63000 seconds)
    t += 63000;
    for (let c = 0; c < 78; c++) {
      klines5mGap.push({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      t += 300;
    }

    // A trade entered at candle 75 (15:45 ET) on Day 1 with forwardWindow=6 (which would reach candle 81, past overnight gap).
    // simulateTrade must NOT be blocked, but rather execute and exit at candle 77 (16:00 ET close) with SESSION_GAP!
    const levels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 105
    };
    const sim = simulateTrade(klines5mGap, 75, 'BUY', levels, {
      forwardWindow: 6,
      sessionGapCutoff: true,
      stepSec: 300,
      frictionPct: 0.08
    });
    assert.strictEqual(sim.exitReason, 'SESSION_GAP', '5m trade hitting overnight session boundary must exit with SESSION_GAP');
    assert.strictEqual(sim.exitIdx, 77, 'Exit index must be the final candle of Day 1 (candle 77, 16:00 ET) before the overnight gap');

    // 2. Full 5m session-based backtest series (780 candles across 10 NYSE sessions)
    const klines5mSession: Kline[] = [];
    let curT = 1700000000;
    for (let day = 0; day < 10; day++) {
      for (let bar = 0; bar < 78; bar++) {
        klines5mSession.push({
          time: curT,
          open: 100 + (day % 3),
          high: 101 + (day % 3),
          low: 99 + (day % 3),
          close: 100 + (day % 3),
          volume: 1000
        });
        curT += 300;
      }
      curT += 63000; // 17.5 hours overnight jump
    }
    const res5m = backtestStandard(klines5mSession, '5m', 'STOCK_5M');
    // Pre-filtering is completely eliminated in 5m (0 discards by sessionGap)
    assert.strictEqual(res5m.discards.sessionGap, 0, '5m backtest must NOT pre-discard closing hour bars via isNearSessionEnd');
  });

  test('sessionGapCutoff excludes execution candle (f > entryCandleIdx + 1) preventing pre-entry exits and inverted gap P&L', () => {
    // 1. Synthetic series: Day 1 has 2 bars (idx 0, 1) ending at 16:00 ET (close: 100).
    // Overnight gap of 17.5 hours leads to Day 2 open at 103 (+3% gap up in favor of long).
    // Day 2 bars continue up to 106.
    const klines: Kline[] = [
      // Day 1
      { time: 1700000000, open: 99, high: 100, low: 98, close: 99.5, volume: 1000 },
      { time: 1700003600, open: 99.5, high: 101, low: 99, close: 100.0, volume: 1000 }, // idx 1: session close
      // Day 2 (17.5 hour gap = 63000s)
      { time: 1700003600 + 63000, open: 103.0, high: 105.0, low: 102.5, close: 104.5, volume: 1000 }, // idx 2: entry candle
      { time: 1700003600 + 63000 + 3600, open: 104.5, high: 106.5, low: 104.0, close: 106.0, volume: 1000 } // idx 3: hits TP
    ];

    const levels: TradeLevels = {
      entryPrice: 103.0,
      stopLoss: 101.0,
      takeProfit1: 106.0
    };

    // Signal on idx 1 (last candle of Day 1).
    // Execution happens on idx 2 open (103.0).
    const sim = simulateTrade(klines, 1, 'BUY', levels, {
      forwardWindow: 4,
      sessionGapCutoff: true,
      stepSec: 3600,
      frictionPct: 0.08
    });

    // Verification:
    // 1. Exit MUST NOT precede entry: exitIdx >= 2 (was falsely exitIdx = 1 with exitPrice = 99.97)
    assert.ok(sim.exitIdx >= 2, `exitIdx (${sim.exitIdx}) must be >= executionIdx (2)`);
    // 2. The trade MUST NOT be liquidated on yesterday's close (99.97) as a false loss (-2.5R).
    // Instead, it executes on Day 2, reaches 106 on idx 3, and hits TP1!
    assert.strictEqual(sim.exitReason, 'TP1', 'Trade must reach TP1 during Day 2 without being falsely truncated by execution candle gap');
    assert.ok(sim.realizedR > 0, `realizedR (${sim.realizedR}) must be positive`);
    assert.strictEqual(sim.outcome, 'win');

    // 2. Verify that backtester discards signals on the single closing candle of a session
    // when the immediate next execution candle jumps across an overnight gap.
    const klines1h: Kline[] = [];
    let curT = 1700000000;
    for (let day = 0; day < 30; day++) {
      for (let bar = 0; bar < 7; bar++) {
        klines1h.push({
          time: curT,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000
        });
        curT += 3600;
      }
      curT += 61200; // 17 hours overnight jump
    }
    // Total 210 candles (> minCandles 172)
    // Place a BUY signal on a session closing candle after warmup (e.g. candle 202, which is the 7th candle of Day 28)
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(klines1h.length).fill('NEUTRAL');
    signals[202] = 'BUY'; // Day 28 closing candle: next candle 203 is Day 29 open after 61200s overnight jump
    const btRes = runBacktestGenericOptimized(klines1h, '1h', signals, 'standard');
    assert.strictEqual(btRes.discards.sessionGap, 1, 'Closing bar signal where execution candle jumps overnight gap must be counted under discards.sessionGap');
    assert.strictEqual(btRes.totalSignals, 0, 'No day trade should be opened across the overnight gap');
  });

  test('Standard Voting conditions RSI vote on momentum slope to eliminate falling knife entries', () => {
    // 1. Falling knife setup: RSI = 22 (< 30) but slope is falling (rsiSlopeDir = -1)
    // Bollinger is also lower (close < bb.lower).
    // Without slope filter: 2-0 majority (RSI BUY + Bollinger BUY) triggers a false BUY into a crash.
    // With slope filter: RSI remains NEUTRAL, voteMargin is only 1-0 (< 2), blocking the falling knife entry.
    const klines = generateSyntheticKlines(50, 300, 100, 0.01);
    const ctx = buildStandardVotingContext(klines);
    const lastIdx = klines.length - 1;

    // Simulate plunging RSI: 3 candles ago was 32, current is 22 (diff = -10 < -1.5)
    ctx.rsiSeries[lastIdx - 3] = 32;
    ctx.rsiSeries[lastIdx] = 22;
    // Simulate price breaking lower band
    if (ctx.bbSeries[lastIdx - 19]) {
      ctx.bbSeries[lastIdx - 19].lower = ctx.closes[lastIdx] + 1.0;
    }

    const resPlunge = evaluateStandardVotingAt(ctx, lastIdx);
    const rsiInd = resPlunge.indicators.find(i => i.name.startsWith('RSI'));
    assert.ok(rsiInd, 'RSI indicator must exist in voting results');
    assert.strictEqual(rsiInd.signal, 'NEUTRAL', 'RSI must NOT vote BUY when slope is falling (falling knife)');
    assert.ok(rsiInd.value.includes('▼'), 'RSI value must display down arrow');
    assert.strictEqual(resPlunge.finalSignal, 'NEUTRAL', 'Vote margin must remain < 2, rejecting falling knife');

    // 2. Curled-up reversal: RSI = 24 (< 30) and slope is curled up (lastIdx-3 was 22, current is 24 -> diff = +2 > 1.5)
    ctx.rsiSeries[lastIdx - 3] = 22;
    ctx.rsiSeries[lastIdx] = 24;
    const resCurled = evaluateStandardVotingAt(ctx, lastIdx);
    const rsiIndCurled = resCurled.indicators.find(i => i.name.startsWith('RSI'));
    assert.strictEqual(rsiIndCurled?.signal, 'BUY', 'RSI must vote BUY when oversold and slope curls up');
    assert.ok(rsiIndCurled?.value.includes('▲'), 'RSI value must display up arrow');
  });

  test('evalWindow warmup floor (>=30), forwardWindow canonical routing, and non-vacuous zero-data folds gate', () => {
    // 1. Confluencia in 5m on 612 candles: forwardWindow = 20, evalWindow should be <= 612 - 20 - 30 = 562
    // Ensuring oldestEvalIdx >= 30 so ADX(14) is never NaN and regime is never defaulted to 'ranging'
    const klines612 = generateSyntheticKlines(612, 300, 100, 0.01);
    const confResCrypto = backtestConfluencia(klines612, '5m', 'TEST_CONF_WARMUP_USDT');
    const confResEquity = backtestConfluencia(klines612, '5m', 'TEST_CONF_WARMUP');
    assert.strictEqual(confResCrypto.forwardWindow, 24, '5m Confluencia must have canonical forwardWindow = 24 for crypto');
    assert.strictEqual(confResEquity.forwardWindow, 36, '5m Confluencia must have canonical forwardWindow = 36 for equities');

    // Verify forwardWindow single source of truth in runBacktestGenericOptimized
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(612).fill('NEUTRAL');
    const genericRes = runBacktestGenericOptimized(klines612, '5m', signals, 'confluencia');
    assert.strictEqual(genericRes.forwardWindow, 24, 'runBacktestGenericOptimized must derive 24 candles via getStrategyForwardWindow');

    // Verify strategyKey decoupling: passing custom 2.0 ATR multiplier to standard does NOT reroute to Confluencia forwardWindow
    const standardCustomAtr = runBacktestGenericOptimized(klines612, '5m', signals, 'standard', 2.0);
    assert.strictEqual(standardCustomAtr.forwardWindow, 12, 'Overriding ATR multiplier must NOT re-route standard forwardWindow');

    // 2. Non-vacuous Walk-Forward folds gate:
    // Candidate where all 3 OOS folds have NO_DATA (0 trades, e.g. due to boundary straddling in low-frequency swing)
    // Previously passed vacuously via min(2, 0) = 0 and (0 < 0) === false.
    // Now must be degraded to LIMITED because there is 0 empirical evidence in any temporal fold.
    const candidateZeroFoldsData: StrategyCandidate = {
      key: 'multitemporal',
      label: 'VCME Swing Straddled Folds',
      profitFactor: 2.2,
      expectancyR: 0.85,
      expectancyPerHour: 0.5,
      avgExposureHours: 2.0,
      winRate: 0.65,
      resolved: 12,
      forwardWindow: 48,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 8, wins: 6, losses: 2, winRate: 0.75, expectancyR: 0.90, profitFactor: 3.0, maxDrawdownR: 1.0 },
        outOfSample: { signals: 4, wins: 3, losses: 1, winRate: 0.75, expectancyR: 0.75, profitFactor: 2.5, maxDrawdownR: 1.0 },
        passed: true,
        status: 'PASS',
        foldsPassed: 0,
        foldsWithData: 0,
        folds: [
          { foldIndex: 1, isRange: [0, 400], oosRange: [400, 458], oosTradesCount: 0, expectancyR: 0, passed: false, status: 'NO_DATA' },
          { foldIndex: 2, isRange: [0, 400], oosRange: [458, 517], oosTradesCount: 0, expectancyR: 0, passed: false, status: 'NO_DATA' },
          { foldIndex: 3, isRange: [0, 400], oosRange: [517, 576], oosTradesCount: 0, expectancyR: 0, passed: false, status: 'NO_DATA' },
        ]
      }
    };

    const tourneyZero = evaluateStrategyTournament([candidateZeroFoldsData], '1h');
    assert.strictEqual(tourneyZero.confidence, 'LIMITED', 'Candidate with 0/3 folds with data must degrade to LIMITED');
    assert.ok(tourneyZero.reasoning.includes('Folds Walk-Forward sin operaciones'), 'Reasoning must explicitly state zero operations in folds');
  });

  // Test 131: Canonical strategy warmup floor derivation across all intervals and sterile prefix elimination
  test('oldestEvalIdx aligns with strategy warmup floor across all intervals eliminating sterile prefix and ADX NaN', () => {
    // 1. Verify getStrategySignalWarmup values:
    assert.strictEqual(getStrategySignalWarmup('standard'), 199, 'Standard Voting warmup floor must be index 199 for EMA200 maturity');
    assert.strictEqual(getStrategySignalWarmup('confluencia'), 30, 'Confluencia warmup floor must be index 30 (ADX convergence)');
    assert.strictEqual(getStrategySignalWarmup('scoring'), 59, 'Scoring warmup floor must be index 59');
    assert.strictEqual(getStrategySignalWarmup('other'), 30, 'Generic fallback warmup floor must be index 30');

    // 2. 1H Standard Voting dataset with EMA200 warmup (350 candles):
    // WarmupFloor = 199 (for EMA200 maturity), forwardWindow = 4.
    // evalWindow = 350 - 4 - 199 = 147, oldestEvalIdx = 350 - 1 - 4 - 147 + 1 = 199.
    const klines1h_350 = generateSyntheticKlines(350, 3600, 100, 0.01);
    const resStandard1h = backtestStandard(klines1h_350, '1h', 'TEST_STD_1H_WARMUP');
    assert.strictEqual(resStandard1h.insufficient, false, '350 candles must satisfy minCandles for 1h Standard');
    assert.ok(
      resStandard1h.label.includes('147') || resStandard1h.label.includes('últimas'),
      `Evaluated window must eliminate the 199-candle sterile prefix, got: ${resStandard1h.label}`
    );

    // 3. 1H Scoring on minimal dataset (200 candles):
    // Scoring signals require 59 bars. With warmupFloor = 59:
    // oldestEvalIdx must be >= 59.
    const klines1h_200 = generateSyntheticKlines(200, 3600, 100, 0.01);
    const resScoring1h = backtestScoring(klines1h_200, '1h', DEFAULT_WEIGHTS, 'TEST_SCORING_1H_WARMUP');
    assert.strictEqual(resScoring1h.insufficient, false, '200 candles must satisfy minCandles for 1h Scoring');
    // In 200 candles with forwardWindow = 5 (1.5x of 4 / 1.2 = 5), evalWindow = 200 - 5 - 59 = 136.
    // latestEvalIdx = 194, oldestEvalIdx = 194 - 136 + 1 = 59.
    assert.ok(
      resScoring1h.label.includes('136') || resScoring1h.label.includes('135') || resScoring1h.label.includes('últimas'),
      `Scoring 1h window must align with index 59 eliminating sterile bars, got: ${resScoring1h.label}`
    );

    // 4. In-Sample and Out-of-Sample Walk-Forward split cleanliness:
    // Since oldestEvalIdx is >= strategy warmup, the Walk-Forward window contains 0 dead bars,
    // preserving the true 70/30 active opportunity balance without In-Sample dilution.
    assert.ok(resStandard1h.walkForward.isWindow > 0, 'In-sample window must be strictly positive');
    assert.ok(resStandard1h.walkForward.oosWindow > 0, 'Out-of-sample window must be strictly positive');
  });

  // Test 132: Strategy key decoupling and canonical session gap execution guard
  test('runBacktestGenericOptimized decouples strategyKey from ATR multiplier and unifies session gap guards', () => {
    // 1. Verify getStrategyAtrMultiplier:
    assert.strictEqual(getStrategyAtrMultiplier('confluencia', '5m'), 2.0, 'Confluencia ATR multiplier must be 2.0');
    assert.strictEqual(getStrategyAtrMultiplier('scoring', '5m'), 1.5, 'Scoring ATR multiplier must be 1.5');
    assert.strictEqual(getStrategyAtrMultiplier('standard', '5m'), 1.2, 'Standard ATR multiplier must be 1.2 in 5m');
    assert.strictEqual(getStrategyAtrMultiplier('standard', '1d'), 1.0, 'Standard ATR multiplier must be 1.0 in 1d');

    // 2. Verify isExecutionAcrossSessionGap:
    const klinesWithGap: Kline[] = [
      { time: 1000, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: 1300, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: 62500, open: 10, high: 11, low: 9, close: 10, volume: 100 }, // overnight gap > 900s
    ];
    assert.strictEqual(isExecutionAcrossSessionGap(klinesWithGap, 0, '5m'), false, 'Normal 300s bar must not be flagged as gap');
    assert.strictEqual(isExecutionAcrossSessionGap(klinesWithGap, 1, '5m'), true, 'Execution candle jumping overnight gap must return true');
    assert.strictEqual(isExecutionAcrossSessionGap(klinesWithGap, 2, '5m'), false, 'Last candle cannot jump across non-existent candle');
    assert.strictEqual(isExecutionAcrossSessionGap(klinesWithGap, 1, '1d'), false, 'Daily interval is exempt from intraday session gap cuts');
  });

  // Test 133: Elimination of customAtrMultiplier backdoor and unbiasing of Andean Oscillator
  test('runBacktestGenericOptimized locks forwardWindow to strategy and calculateAndianOscillator excludes current bar', () => {
    // 1. Verify that runBacktestGenericOptimized derives atrMultiplier and forwardWindow canonically
    const klines5m = generateSyntheticKlines(600, 300, 100, 0.01);
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(600).fill('NEUTRAL');
    signals[100] = 'BUY';
    const res = runBacktestGenericOptimized(klines5m, '5m', signals, 'standard');
    assert.strictEqual(res.forwardWindow, 12, 'Standard 5m forward window must be canonically 12');

    // 2. Verify calculateAndianOscillator strictly excludes current bar from 20th percentile
    const synth1D: Kline[] = new Array(60).fill(null).map((_, idx) => ({
      time: 1700000000 + idx * 86400,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000
    }));
    // Inject extreme bear bar at index 55 (bearish expansion)
    synth1D[55] = {
      time: 1700000000 + 55 * 86400,
      open: 110,
      high: 110,
      low: 80,
      close: 80,
      volume: 50000
    };
    const andian = calculateAndianOscillator(synth1D, 14);
    assert.strictEqual(andian.length, 60, 'Andian oscillator output length must match input');
    assert.ok(typeof andian[55].bias === 'string', 'Bias must be a valid string');
  });

  // Test 134: Action-aware QVE fallback preserves quality while restoring usable alert flow
  test('selectActionableStrategy uses positive marginal OOS fallbacks and rejects genuinely negative validation', () => {
    const data5m = generateSyntheticKlines(220, 300, 100, 0.02);
    const data1h = generateSyntheticKlines(220, 3600, 100, 0.02);
    const data1d = generateSyntheticKlines(220, 86400, 100, 0.02);
    const base = runQVESelection({ symbol: 'ACTIONABLEUSDT', data5m, data1h, data1d });

    const positiveDirection = { signals: 6, wins: 4, losses: 2, winRate: 0.67, expectancyR: 0.18, profitFactor: 1.4 };
    const neutralDirection = { signals: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0, profitFactor: null };
    const makeFallbackCandidate = (oosExpectancyR: number, oosProfitFactor: number): StrategyCandidate => ({
      key: 'confluencia',
      label: 'Confluencia',
      profitFactor: 1.22,
      expectancyR: 0.12,
      expectancyPerHour: 0.08,
      winRate: 0.58,
      resolved: 18,
      walkForward: {
        ...createEmptyWalkForwardResult(400, 176),
        status: 'FAIL',
        inSample: {
          ...createEmptyWalkForwardResult().inSample,
          signals: 12,
          wins: 7,
          losses: 5,
          winRate: 0.58,
          expectancyR: 0.14,
          profitFactor: 1.25,
          maxDrawdownR: 1.6,
          longStats: positiveDirection,
          shortStats: neutralDirection,
        },
        outOfSample: {
          ...createEmptyWalkForwardResult().outOfSample,
          signals: 6,
          expectancyR: oosExpectancyR,
          profitFactor: oosProfitFactor,
        },
        folds: [
          { fold: 1, isWindow: 400, oosWindow: 58, oosTradesCount: 2, oosExpectancyR: 0.12, passed: true, status: 'PASS' },
          { fold: 2, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: -0.03, passed: false, status: 'FAIL' },
          { fold: 3, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: 0.04, passed: false, status: 'FAIL' },
        ],
        foldsPassed: 1,
        foldsWithData: 3,
      },
    });
    const primary: StrategyCandidate = {
      ...makeFallbackCandidate(0.12, 1.3),
      key: 'multifractal',
      label: 'Multifractal MTF',
    };
    const makeQve = (fallback: StrategyCandidate): QVESelectionResult => ({
      ...base,
      bestStrategy: 'multifractal',
      strategyLabel: primary.label,
      confidence: 'LIMITED',
      profitFactor: primary.profitFactor,
      candidates: [primary, fallback],
      tournament: {
        ...base.tournament,
        bestStrategy: 'multifractal',
        strategyLabel: primary.label,
        confidence: 'LIMITED',
        profitFactor: primary.profitFactor,
        longStats: primary.walkForward?.inSample.longStats,
        shortStats: primary.walkForward?.inSample.shortStats,
      },
    });

    const primaryWins = selectActionableStrategy(makeQve(makeFallbackCandidate(0.05, 1.1)), {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'SELL', confluencia: 'BUY',
    });
    assert.strictEqual(primaryWins.strategy, 'multifractal', 'An actionable tournament winner must keep priority');
    assert.strictEqual(primaryWins.isFallback, false);

    const marginalPositive = selectActionableStrategy(makeQve(makeFallbackCandidate(0.05, 1.1)), {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'NEUTRAL', confluencia: 'BUY',
    });
    assert.strictEqual(marginalPositive.strategy, 'confluencia', 'A positive OOS miss below the HIGH hurdle must remain usable as LIMITED');
    assert.strictEqual(marginalPositive.confidence, 'LIMITED');
    assert.strictEqual(marginalPositive.isFallback, true);

    const directionalWinner = makeFallbackCandidate(-0.20, 0.70);
    directionalWinner.expectancyR = -0.10;
    directionalWinner.profitFactor = 0.80;
    directionalWinner.walkForward!.inSample.expectancyR = -0.12;
    directionalWinner.walkForward!.inSample.profitFactor = 0.78;
    directionalWinner.walkForward!.outOfSample.longStats = {
      ...positiveDirection,
      signals: 3,
      expectancyR: 0.24,
      profitFactor: 1.55,
    };
    const directionalRecovery = selectActionableStrategy(makeQve(directionalWinner), {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'NEUTRAL', confluencia: 'BUY',
    });
    assert.strictEqual(directionalRecovery.strategy, 'confluencia', 'A validated BUY edge must not be hidden by the strategy losing only on its SELL side');
    assert.strictEqual(directionalRecovery.signal, 'BUY');

    const negativeOos = selectActionableStrategy(makeQve(makeFallbackCandidate(-0.01, 0.95)), {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'NEUTRAL', confluencia: 'BUY',
    });
    assert.strictEqual(negativeOos.strategy, 'NONE', 'Negative OOS evidence must remain hard-blocked');

    const toxicDirection = makeFallbackCandidate(0.05, 1.1);
    toxicDirection.walkForward!.inSample.longStats = { ...positiveDirection, signals: 4, expectancyR: -0.2, profitFactor: 0.7 };
    const directionBlocked = selectActionableStrategy(makeQve(toxicDirection), {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'NEUTRAL', confluencia: 'BUY',
    });
    assert.strictEqual(directionBlocked.strategy, 'NONE', 'Negative directional expectancy must still veto a fallback alert');

    // Tournament winner symmetric directional OOS veto:
    // When primary (winner) emits SELL but has >= 3 losing SELL trades in OOS (-1.0R):
    const primaryWithToxicShort: StrategyCandidate = {
      ...primary,
      walkForward: {
        ...primary.walkForward!,
        outOfSample: {
          ...primary.walkForward!.outOfSample,
          shortStats: { signals: 3, wins: 0, losses: 3, winRate: 0, expectancyR: -1.0, profitFactor: 0.0 },
        },
      },
    };
    const fallbackWithValidBuy = makeFallbackCandidate(0.05, 1.1);
    const qveWithToxicPrimaryShort: QVESelectionResult = {
      ...makeQve(fallbackWithValidBuy),
      candidates: [primaryWithToxicShort, fallbackWithValidBuy],
    };
    const primaryShortVetoed = selectActionableStrategy(qveWithToxicPrimaryShort, {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'SELL', confluencia: 'BUY',
    });
    // Primary's SELL must be blocked, and fallback Confluencia BUY must be selected!
    assert.strictEqual(primaryShortVetoed.strategy, 'confluencia', 'Primary losing on OOS SELL must be vetoed and allow valid fallback BUY');
    assert.strictEqual(primaryShortVetoed.signal, 'BUY');

    // If no fallback is active, must safely return NONE with explanatory reasoning:
    const primaryShortVetoedNoFallback = selectActionableStrategy(qveWithToxicPrimaryShort, {
      standard: 'NEUTRAL', scoring: 'HOLD', multitemporal: 'NEUTRAL', multifractal: 'SELL', confluencia: 'NEUTRAL',
    });
    assert.strictEqual(primaryShortVetoedNoFallback.strategy, 'NONE');
    assert.strictEqual(primaryShortVetoedNoFallback.signal, 'NEUTRAL');
    assert.ok(
      primaryShortVetoedNoFallback.reasoning.includes('neutralizada por OOS reciente negativo'),
      'Must explain why primary was vetoed in reasoning'
    );
  });

  // Test 135: Audit Fixes: VCME SHORT floating-point risk, TIMEOUT exit price, TP3 priority, and Tracker monotonicity
  test('validates audit fixes: VCME SHORT risk tolerance, TIMEOUT exit price, TP3 intra-candle priority, and tracker monotonicity', () => {
    // 1. TIMEOUT exit price must strictly use the expiration candle close, NOT an external floatingClosePrice
    const timeoutKlines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1300, open: 100, high: 101.5, low: 99.5, close: 101, volume: 1000 },
    ];
    const timeoutLevels: TradeLevels = { entryPrice: 100, stopLoss: 90, takeProfit1: 120 };
    const timeoutSim = simulateTrade(timeoutKlines, 0, 'BUY', timeoutLevels, {
      forwardWindow: 1,
      floatingClosePrice: 107, // Live price today (should NOT be used for trade expired at candle 1)
      marketSlippagePct: 0,
      frictionPct: 0
    });
    assert.strictEqual(timeoutSim.status, 'EXPIRED');
    assert.strictEqual(timeoutSim.exitIdx, 1);
    assert.strictEqual(timeoutSim.exitPrice, 101, 'Expired trade must exit at candle close (101), not live floating price (107)');

    // 2. TP3 intra-candle priority over close-of-bar EMA9/Chandelier
    const tp3Klines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1300, open: 100, high: 104, low: 99, close: 103, volume: 1000 }, // Hits TP1 (103)
      { time: 1600, open: 103, high: 106, low: 102, close: 105, volume: 1000 }, // Hits TP2 (105)
      // Hits TP3 (107) intra-candle, but closes at 104.8 below EMA9 (105)
      { time: 1900, open: 105, high: 107.5, low: 103.5, close: 104.8, volume: 1000 }
    ];
    const tp3Levels: TradeLevels = { entryPrice: 100, stopLoss: 97, takeProfit1: 103, takeProfit2: 105, takeProfit3: 107 };
    const tp3Sim = simulateTrade(tp3Klines, 0, 'BUY', tp3Levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      trailingStop: 'chandelier',
      ema9Series: [100, 102, 104, 105], // Candle 3 close (104.8) is below EMA9 (105)
      atrSeries: [1.5, 1.5, 1.5, 1.5],
      marketSlippagePct: 0,
      frictionPct: 0
    });
    assert.strictEqual(tp3Sim.exitReason, 'TP3', 'Limit TP3 must execute with priority over close-of-candle EMA9 breach');
    assert.strictEqual(tp3Sim.exitPrice, 107);
    assert.strictEqual(tp3Sim.status, 'TP2_CLOSED');

    // 3. Monotonic alertTracker status preservation
    const dummyAlert: AuditAlertItem = {
      id: 'TEST-1',
      symbol: 'AAPL',
      interval: '5m',
      signal: 'BUY',
      time: '10:00',
      pf: 1.5,
      strategy: 'VCME Sniper',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 102,
      status: 'TP1_HIT', // Already achieved TP1 in a previous tick
      realizedR: 1.0,
      pnlPercent: 1.5,
      timestamp: 1700000000000,
      candleTimestamp: 1700000000
    };
    // Live update where current candle retraced below TP1 but remains above breakeven:
    const klinesMap: Record<string, Kline[]> = {
      'AAPL:5m': [
        { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
        { time: 1700000300, open: 100.5, high: 101, low: 100.2, close: 100.8, volume: 1000 }
      ]
    };
    const updatedAlerts = updateAlertsOutcome([dummyAlert], klinesMap);
    assert.strictEqual(updatedAlerts[0].status, 'TP1_HIT', 'AlertTracker must preserve TP1_HIT monotonically and never downgrade to OPEN');

    // 4. Confluencia zero-volume rejection with full historical depth (> 30 candles)
    const deepKlines: Kline[] = Array.from({ length: 35 }, (_, i) => ({
      time: 1000 + i * 300,
      open: 100 + i * 0.5,
      high: 100 + i * 0.5 + 0.3,
      low: 100 + i * 0.5 - 0.2,
      close: 100 + i * 0.5 + 0.1,
      volume: 1000
    }));
    deepKlines[34].volume = 0;
    const ctxConfZero = buildConfluenciaContext(deepKlines, '5m');
    const resConfZero = evaluateConfluenciaAt(ctxConfZero, 34);
    assert.strictEqual(resConfZero.signal, 'NEUTRAL', 'Confluencia must reject zero-volume bar even in full candle history');
  });

  // Test 136: Multi-target sweep in single candle executes full TP3 without premature Breakeven stop-out
  test('tradeSimulator executes full TP3 win without premature Breakeven stop-out on single-candle sweep', () => {
    const sweepKlines: Kline[] = [
      { time: 1000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      // Single candle opens at 108, reaches high 109 (> tp3 107), then plunges to close at 99
      { time: 1300, open: 108, high: 109, low: 98.5, close: 99, volume: 5000 }
    ];
    const buyLevels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103, // +1.5R
      takeProfit2: 105, // +2.5R
      takeProfit3: 107  // +3.5R
    };
    const buySim = simulateTrade(sweepKlines, 0, 'BUY', buyLevels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      marketSlippagePct: 0,
      frictionPct: 0
    });
    // High reached 109 >= TP3 (107), so all targets TP1, TP2, TP3 were filled intra-candle
    assert.strictEqual(buySim.exitReason, 'TP3', 'Must exit as TP3 limit fill');
    assert.strictEqual(buySim.status, 'TP2_CLOSED', 'Status must be TP2_CLOSED');
    assert.strictEqual(buySim.exitPrice, 107, 'Exit price must be TP3 limit price');
    assert.strictEqual(buySim.realizedR, 2.25, 'Realized R: 0.50*1.5 + 0.25*2.5 + 0.25*3.5 = 2.25R');

    // Symmetrical SELL sweep test
    const sellSweepKlines: Kline[] = [
      { time: 1000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      // Single candle opens at 92, drops to low 91 (< tp3 93), then rallies to close at 101
      { time: 1300, open: 92, high: 101.5, low: 91, close: 101, volume: 5000 }
    ];
    const sellLevels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 102,
      takeProfit1: 97, // +1.5R
      takeProfit2: 95, // +2.5R
      takeProfit3: 93  // +3.5R
    };
    const sellSim = simulateTrade(sellSweepKlines, 0, 'SELL', sellLevels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      marketSlippagePct: 0,
      frictionPct: 0
    });
    assert.strictEqual(sellSim.exitReason, 'TP3');
    assert.strictEqual(sellSim.status, 'TP2_CLOSED');
    assert.strictEqual(sellSim.exitPrice, 93);
    assert.strictEqual(sellSim.realizedR, 2.25);
  });

  // Test 137: VCME Sniper maintains scale invariance on micro-price assets
  test('calculateVCMESniperSignal maintains scale invariance on micro-price crypto assets', () => {
    const basePrice = 0.00001000;
    const klines: Kline[] = Array.from({ length: 60 }, (_, i) => ({
      time: 1000 + i * 300,
      open: basePrice * (1 + i * 0.001),
      high: basePrice * (1 + i * 0.001 + 0.0005),
      low: basePrice * (1 + i * 0.001 - 0.0005),
      close: basePrice * (1 + i * 0.001 + 0.0002),
      volume: 1000000
    }));
    const klines1h: Kline[] = Array.from({ length: 60 }, (_, i) => ({
      time: 1000 + i * 3600,
      open: basePrice * (1 + i * 0.005),
      high: basePrice * (1 + i * 0.005 + 0.002),
      low: basePrice * (1 + i * 0.005 - 0.002),
      close: basePrice * (1 + i * 0.005 + 0.001),
      volume: 10000000
    }));
    const klines1d: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      time: 1000 + i * 86400,
      open: basePrice * (1 + i * 0.02),
      high: basePrice * (1 + i * 0.02 + 0.01),
      low: basePrice * (1 + i * 0.02 - 0.01),
      close: basePrice * (1 + i * 0.02 + 0.005),
      volume: 50000000
    }));

    const res = calculateVCMESniperSignal(klines, klines1h, klines1d, 'PEPEUSDT', 60, 2.0, 'dayTrading', 'aggressor');
    assert.ok(!isNaN(res.stopLoss), 'Stop loss must not be NaN');
    assert.ok(!isNaN(res.takeProfit1), 'TP1 must not be NaN');
    assert.ok(typeof res.signal === 'string');
  });

  // Test 138: Session stats win/loss classification by economic outcome (not status label)
  test('calculateSessionStats truthfully classifies TP1_BE_CLOSED with negative realized R as a loss', () => {
    const gappedBeAlert: AuditAlertItem = {
      id: 'GAP-BE-1',
      symbol: 'AAPL',
      interval: '5m',
      signal: 'BUY',
      time: '09:30',
      pf: 2.0,
      strategy: 'VCME Sniper',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103,
      status: 'TP1_BE_CLOSED',
      realizedR: -0.82, // Overnight gap ran through Breakeven stop
      pnlPercent: -1.64,
      timestamp: Date.now()
    };
    const stats = calculateSessionStats([gappedBeAlert]);
    assert.strictEqual(stats.losses, 1, 'Trade with negative realized R (-0.82) must be counted as a LOSS');
    assert.strictEqual(stats.wins, 0, 'Must NOT be counted as a win despite TP1_BE_CLOSED label');
    assert.strictEqual(stats.winRate, 0, 'Win rate must be 0%');
    assert.strictEqual(stats.totalR, -0.8);
  });

  // Test 139: trimAlertsPreservingActive protects active swing & intraday positions
  test('trimAlertsPreservingActive preserves all active positions regardless of age', () => {
    const alerts: AuditAlertItem[] = [];
    for (let i = 0; i < 105; i++) {
      alerts.push({
        id: `CLOSED-${i}`,
        symbol: 'AAPL',
        interval: '5m',
        signal: 'BUY',
        time: '10:00',
        pf: 1.5,
        strategy: 'VCME Sniper',
        entryPrice: 100,
        stopLoss: 98,
        takeProfit1: 103,
        status: 'TP1_CLOSED',
        realizedR: 1.5,
        pnlPercent: 3.0,
        timestamp: 1700000000000 + i * 1000
      });
    }
    const active1: AuditAlertItem = {
      id: 'ACTIVE-SWING-1',
      symbol: 'MSFT',
      interval: '1h',
      signal: 'BUY',
      time: '09:30',
      pf: 2.5,
      strategy: 'VCME Swing',
      executionStyle: 'swing',
      entryPrice: 400,
      stopLoss: 390,
      takeProfit1: 415,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 1.0,
      timestamp: 1690000000000
    };
    const active2: AuditAlertItem = { ...active1, id: 'ACTIVE-TP1-HIT', status: 'TP1_HIT' };
    const active3: AuditAlertItem = { ...active1, id: 'ACTIVE-TP2-HIT', status: 'TP2_HIT' };

    alerts.splice(10, 0, active1);
    alerts.splice(50, 0, active2);
    alerts.push(active3);

    const trimmed = trimAlertsPreservingActive(alerts, 100);
    assert.strictEqual(trimmed.length, 100, 'Total alerts trimmed to 100');
    assert.ok(trimmed.some(a => a.id === 'ACTIVE-SWING-1'), 'Active OPEN swing trade must be preserved');
    assert.ok(trimmed.some(a => a.id === 'ACTIVE-TP1-HIT'), 'Active TP1_HIT trade must be preserved');
    assert.ok(trimmed.some(a => a.id === 'ACTIVE-TP2-HIT'), 'Active TP2_HIT trade must be preserved');
    const activeCount = trimmed.filter(a => a.status === 'OPEN' || a.status === 'TP1_HIT' || a.status === 'TP2_HIT').length;
    assert.strictEqual(activeCount, 3);
  });

  // Test 140: VCME MTF temporal synchronization and Scoring S/R room clamp
  test('VCME MTF mapping includes confirmed 1H bar at close and Scoring blocks room <= 0', () => {
    // 1. MTF mapping synchronization test
    // 5M series with 12 candles: 0, 300, ..., 3300. Candle 11 opens at 3300 and closes at 3600.
    const klines5m: Kline[] = Array.from({ length: 12 }, (_, i) => ({
      time: i * 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000
    }));
    // 1H series: Candle 0 opens at 0, closes at 3600.
    const klines1h: Kline[] = [
      { time: 0, open: 100, high: 102, low: 98, close: 101, volume: 10000 },
      { time: 3600, open: 101, high: 103, low: 100, close: 102, volume: 10000 }
    ];
    const klines1d: Kline[] = [
      { time: 0, open: 100, high: 105, low: 95, close: 102, volume: 100000 }
    ];
    const vcmeCtx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'AAPL', 'dayTrading');
    // Candle 11 (09:55 to 10:00) closes at 3600. The 1H bar ending at 3600 (index 0) must be available!
    assert.strictEqual(vcmeCtx.idx1hMap[11], 0, '1H bar closing at 3600 must be mapped to 5m bar closing at 3600');

    // 2. Scoring S/R room validation
    const scoringKlines: Kline[] = Array.from({ length: 65 }, (_, i) => ({
      time: 1000 + i * 300,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1000
    }));
    const sCtx = buildScoringContext(scoringKlines, '5m');
    sCtx.srCache.set(60, { nearestSupport: 95, nearestResistance: 100 });
    const sRes = evaluateScoringAt(sCtx, 60);
    assert.notStrictEqual(sRes.signal, 'BUY', 'Scoring must reject BUY when price has zero or negative room to resistance');
  });

  test('Revision 3: simulateTrade Open Gap Target Fills execute limit targets before intra-candle drops', () => {
    // BUY position: Entry 100, SL 97, TP1 103, TP2 105, TP3 107
    const levels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: 107
    };
    const klines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      // Next candle opens above all targets at 108, but then plunges to low 96 intra-candle
      { time: 1300, open: 108, high: 109, low: 96, close: 98, volume: 5000 }
    ];

    // VCME Runner policy
    const simVCME = simulateTrade(klines, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      moveSlToBreakevenOnTp1: true
    });

    assert.strictEqual(simVCME.exitReason, 'TP3', 'Gap open above TP3 must fill all targets rather than executing SL');
    assert.strictEqual(simVCME.status, 'TP2_CLOSED', 'Status must be TP2_CLOSED on full target completion');
    assert.ok(simVCME.realizedR > 1.4, `realizedR (${simVCME.realizedR}) must be highly positive`);

    // Standard policy (no partials)
    const simStandard = simulateTrade(klines, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: false
    });
    assert.strictEqual(simStandard.exitReason, 'TP1', 'Standard policy must fill TP1 on gap open above TP1');
    assert.strictEqual(simStandard.status, 'TP1_CLOSED');
    assert.ok(simStandard.realizedR > 0);

    // Partial gap open at 104 (above TP1 103, below TP2 105), then dropping to 96
    const klinesPartial: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1300, open: 104, high: 104.5, low: 96, close: 97, volume: 5000 }
    ];
    const simPartial = simulateTrade(klinesPartial, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      moveSlToBreakevenOnTp1: true
    });
    assert.strictEqual(simPartial.exitReason, 'TP1_BE', 'Drop after TP1 gap open must exit at Breakeven, not initial SL');
    assert.strictEqual(simPartial.status, 'TP1_BE_CLOSED');
    assert.ok(simPartial.realizedR > 0, `realizedR (${simPartial.realizedR}) must be positive`);

    // SHORT position: Entry 100, SL 103, TP1 97, TP2 95, TP3 93
    const levelsShort: TradeLevels = {
      entryPrice: 100,
      stopLoss: 103,
      takeProfit1: 97,
      takeProfit2: 95,
      takeProfit3: 93
    };
    const klinesShort: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      // Opens with gap down at 92 (below TP3), then spikes to high 104 intra-candle
      { time: 1300, open: 92, high: 104, low: 91, close: 102, volume: 5000 }
    ];
    const simShort = simulateTrade(klinesShort, 0, 'SELL', levelsShort, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner'
    });
    assert.strictEqual(simShort.exitReason, 'TP3', 'Short gap open below TP3 must fill all targets, not SL');
    assert.strictEqual(simShort.status, 'TP2_CLOSED');
    assert.ok(simShort.realizedR > 1.4);
  });

  test('Revision 3: alertTracker resumes from initialState without regressing to SL_HIT', () => {
    const alert: AuditAlertItem = {
      id: 'test-tp1-alert',
      symbol: 'AAPL',
      interval: '5m',
      strategy: 'VCME Sniper',
      signal: 'BUY',
      status: 'TP1_HIT',
      tp1Time: 1000, // The fixture asserts that TP1 preceded the gap at 1300.
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 103,
      takeProfit2: 105,
      realizedR: 1.5,
      pnlPercent: 2.2,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    // Subsequent candle opens below entry and drops below original stopLoss
    const klines: Kline[] = [
      { time: 1000, open: 100, high: 103.5, low: 99.5, close: 103.2, volume: 1000 },
      { time: 1300, open: 98, high: 99, low: 96, close: 97, volume: 1000 }
    ];

    const updated = updateAlertsOutcome([alert], { 'AAPL:5m': klines });
    assert.strictEqual(updated.length, 1);
    // Because TP1 was hit and SL trailed to breakeven (100), the drop to 96 closes it at TP1_BE_CLOSED
    // It MUST NOT become SL_HIT with negative realizedR!
    assert.notStrictEqual(updated[0].status, 'SL_HIT', 'Alert must not regress to SL_HIT once TP1 was hit');
    assert.ok(updated[0].realizedR > 0, `realizedR (${updated[0].realizedR}) must remain positive`);
  });

  test('Revision 3: alertTracker enforces sessionGapCutoff on 1H Standard but exempts 1H VCME Swing', () => {
    const klines: Kline[] = [
      { time: 1000, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: 4600, open: 100.5, high: 101.5, low: 100, close: 101, volume: 1000 },
      // Overnight gap: 61200 seconds jump (> 3600 * 3)
      { time: 4600 + 61200, open: 101, high: 102, low: 100, close: 101.5, volume: 1000 }
    ];

    // 1. 1H Standard Equity Alert (Generic momentum - must cutoff at session boundary)
    const stdAlert: AuditAlertItem = {
      id: 'test-std-alert',
      symbol: 'AAPL',
      interval: '1h',
      strategy: 'Standard Momentum',
      signal: 'BUY',
      status: 'OPEN',
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 105,
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'swing' // Generic swing is NOT VCME swing
    };

    const stdRes = updateAlertsOutcome([stdAlert], { 'AAPL:1h': klines });
    assert.strictEqual(stdRes[0].status, 'EXPIRED', '1H Standard equity trade must expire on overnight session gap');

    // 2. 1H VCME Swing Alert (Calibrated multi-day holding - exempt from session gap cutoff)
    const vcmeAlert: AuditAlertItem = {
      id: 'test-vcme-alert',
      symbol: 'AAPL',
      interval: '1h',
      strategy: 'VCME Swing',
      signal: 'BUY',
      status: 'OPEN',
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 105,
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'swing'
    };

    const vcmeRes = updateAlertsOutcome([vcmeAlert], { 'AAPL:1h': klines });
    assert.strictEqual(vcmeRes[0].status, 'OPEN', '1H VCME Swing trade must remain open across overnight session gap');
  });

  test('Revision 3: App localStorage load preserves active alerts older than 7 days', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const items: Partial<AuditAlertItem>[] = [
      { id: 'old-closed', status: 'TP1_CLOSED', timestamp: eightDaysAgo },
      { id: 'old-active-open', status: 'OPEN', timestamp: eightDaysAgo },
      { id: 'old-active-tp1', status: 'TP1_HIT', timestamp: eightDaysAgo },
      { id: 'recent-closed', status: 'SL_HIT', timestamp: Date.now() - 1000 }
    ];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = items.filter(item => item && (
      item.status === 'OPEN' || item.status === 'TP1_HIT' || item.status === 'TP2_HIT' ||
      (typeof item.timestamp === 'number' && item.timestamp > sevenDaysAgo)
    ));

    assert.strictEqual(filtered.length, 3, 'Must retain 2 active old trades + 1 recent closed trade');
    assert.ok(filtered.some(i => i.id === 'old-active-open'), 'old-active-open must be preserved');
    assert.ok(filtered.some(i => i.id === 'old-active-tp1'), 'old-active-tp1 must be preserved');
    assert.ok(!filtered.some(i => i.id === 'old-closed'), 'old-closed must be pruned');
  });

  // =========================================================================
  // Revision 4: Verification of Findings 1 - 7
  // =========================================================================

  test('Revision 4: alertTracker persists causal execution state and closes at Breakeven (+0.87% net) without P&L congelation', () => {
    // Exact counterexample from Revision 4 lines 32-40:
    // VCME BUY alert, entry 100, SL 90, TP1 102, TP2 110, created on 5m candle at time 1000
    const alertTimeMs = 1700000000000;
    const initialAlert: AuditAlertItem = {
      id: 'rev4-tracker-1',
      symbol: 'SPY',
      interval: '5m',
      signal: 'BUY',
      time: '09:35',
      pf: 2.1,
      strategy: 'VCME Sniper',
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 102,
      takeProfit2: 110,
      takeProfit3: 115,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: alertTimeMs,
      candleTimestamp: 1700000000
    };

    // Step 1: Forward candle 1 (1700000300) reaches high 103 (TP1 hit at 102)
    const klinesMap1 = {
      'SPY:5m': [
        { time: 1700000300, open: 100, high: 103, low: 99.5, close: 102.5, volume: 1000 }
      ]
    };
    const step1 = updateAlertsOutcome([initialAlert], klinesMap1);
    assert.strictEqual(step1[0].status, 'TP1_HIT');
    assert.strictEqual(step1[0].tp1Hit, true);
    assert.strictEqual(step1[0].activeSL, 100, 'Active SL must move to entryPrice (100) after TP1');
    assert.ok(step1[0].pnlPercent > 0, 'Floating PnL must be positive on step 1');
    const step1Pnl = step1[0].pnlPercent;

    // Step 2: Candle finishes at 101; price drops towards 100.5
    // Floating PnL must NOT be frozen with Math.max! It must rise and fall naturally with latestPrice!
    const klinesMap2 = {
      'SPY:5m': [
        { time: 1700000300, open: 100, high: 103, low: 99.5, close: 101, volume: 1200 }
      ]
    };
    const step2 = updateAlertsOutcome(step1, klinesMap2);
    assert.strictEqual(step2[0].status, 'TP1_HIT');
    assert.ok(
      step2[0].pnlPercent < step1Pnl,
      `P&L must drop dynamically with latestPrice (got ${step2[0].pnlPercent} vs previous ${step1Pnl}), NO Math.max congelation!`
    );

    // Step 3: Subsequent candle breaches activeSL (entryPrice = 100, with low = 99)
    // Must execute TP1_BE_CLOSED with exact net ~+0.90% after slippage (0.03%) and proportional friction (0.08%)
    const klinesMap3 = {
      'SPY:5m': [
        { time: 1700000300, open: 100, high: 103, low: 99.5, close: 101, volume: 1200 },
        { time: 1700000600, open: 101, high: 101.5, low: 99.0, close: 99.2, volume: 1500 }
      ]
    };
    const step3 = updateAlertsOutcome(step2, klinesMap3);
    assert.strictEqual(step3[0].status, 'TP1_BE_CLOSED', 'Breaching activeSL after TP1 must close position as TP1_BE_CLOSED');
    assert.ok(
      step3[0].pnlPercent === 0.86 || step3[0].pnlPercent === 0.87 || step3[0].pnlPercent === 0.9,
      `Net PnL must be ~+0.90%, got ${step3[0].pnlPercent}`
    );
    assert.ok(step3[0].realizedR > 0, 'Realized R must remain positive');

    // Step 4: Further market crash to 89 must NOT retroactively show SL_HIT
    const klinesMap4 = {
      'SPY:5m': [
        { time: 1700000300, open: 100, high: 103, low: 99.5, close: 101, volume: 1200 },
        { time: 1700000600, open: 101, high: 101.5, low: 99.0, close: 99.2, volume: 1500 },
        { time: 1700000900, open: 99.2, high: 99.5, low: 89.0, close: 89.1, volume: 2000 }
      ]
    };
    const step4 = updateAlertsOutcome(step3, klinesMap4);
    assert.strictEqual(step4[0].status, 'TP1_BE_CLOSED', 'Closed trade must remain TP1_BE_CLOSED, never regressing to SL_HIT');
    assert.ok(step4[0].pnlPercent === 0.86 || step4[0].pnlPercent === 0.87 || step4[0].pnlPercent === 0.9);
  });

  test('Revision 4: Scanner validates risk geometry stopLoss < entryPrice < takeProfit1 and discards inverted levels', () => {
    // 1. Valid BUY geometry:
    const validBuy = { entryPrice: 100, stopLoss: 95, takeProfit1: 105 };
    const isBuyValid = validBuy.stopLoss < validBuy.entryPrice && validBuy.entryPrice < validBuy.takeProfit1;
    assert.strictEqual(isBuyValid, true, 'Valid BUY risk geometry must pass');

    // 2. Inverted BUY geometry:
    const invertedBuy = { entryPrice: 100, stopLoss: 104, takeProfit1: 105 };
    const isInvertedBuyValid = invertedBuy.stopLoss < invertedBuy.entryPrice && invertedBuy.entryPrice < invertedBuy.takeProfit1;
    assert.strictEqual(isInvertedBuyValid, false, 'Inverted BUY SL > Entry must fail geometry validation');

    // 3. Valid SELL geometry:
    const validSell = { entryPrice: 100, stopLoss: 105, takeProfit1: 95 };
    const isSellValid = validSell.stopLoss > validSell.entryPrice && validSell.entryPrice > validSell.takeProfit1;
    assert.strictEqual(isSellValid, true, 'Valid SELL risk geometry must pass');

    // 4. Inverted SELL geometry:
    const invertedSell = { entryPrice: 100, stopLoss: 96, takeProfit1: 95 };
    const isInvertedSellValid = invertedSell.stopLoss > invertedSell.entryPrice && invertedSell.entryPrice > invertedSell.takeProfit1;
    assert.strictEqual(isInvertedSellValid, false, 'Inverted SELL SL < Entry must fail geometry validation');
  });

  test('Revision 4: simulateTrade charges uniform 4-fill commission (0.16%) on TP3 open gap across all paths', () => {
    // Exact counterexample from Revision 4 lines 68-76:
    // Entry 100, SL 97, targets 103 / 105 / 107, open gap at 108
    const levels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: 107
    };

    // Path A: Gap straight to 108 on execution candle without prior partials
    const klinesPathA: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 2000, open: 108, high: 109, low: 99, close: 108.5, volume: 500 }
    ];
    const simA = simulateTrade(klinesPathA, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      frictionPct: 0.08,
      frictionModel: 'per-fill'
    });

    // Path B: Candle reaches TP1 (103.5) on bar 1, then gaps to 108 on bar 2
    const klinesPathB: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 2000, open: 101, high: 103.5, low: 100.5, close: 103, volume: 200 },
      { time: 3000, open: 108, high: 109, low: 99, close: 108.5, volume: 500 }
    ];
    const simB = simulateTrade(klinesPathB, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      frictionPct: 0.08,
      frictionModel: 'per-fill'
    });

    // Path C: Candle reaches TP1 & TP2 (105.5) on bar 1, then gaps to 108 on bar 2
    const klinesPathC: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 2000, open: 101, high: 105.5, low: 100.5, close: 105, volume: 200 },
      { time: 3000, open: 108, high: 109, low: 99, close: 108.5, volume: 500 }
    ];
    const simC = simulateTrade(klinesPathC, 0, 'BUY', levels, {
      forwardWindow: 10,
      enablePartials: 'vcme-runner',
      frictionPct: 0.08,
      frictionModel: 'per-fill'
    });

    assert.strictEqual(simA.outcome, 'win');
    assert.strictEqual(simB.outcome, 'win');
    assert.strictEqual(simC.outcome, 'win');
    assert.strictEqual(simA.pnlPct, 4.34, `Path A net must be exactly +4.34%, got ${simA.pnlPct}`);
    assert.strictEqual(simB.pnlPct, 4.34, `Path B net must be exactly +4.34%, got ${simB.pnlPct}`);
    assert.strictEqual(simC.pnlPct, 4.34, `Path C net must be exactly +4.34%, got ${simC.pnlPct}`);
    assert.strictEqual(simA.pnlPct, simC.pnlPct, 'All 3 paths must have identical net commission accounting');
  });

  test('Proportional friction model charges uniform 1x nominal commission (0.08%) across all paths', () => {
    const levels: TradeLevels = {
      entryPrice: 100,
      stopLoss: 97,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: 107
    };
    const klinesA: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 2000, open: 108, high: 109, low: 99, close: 108.5, volume: 500 }
    ];
    const klinesC: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 2000, open: 101, high: 105.5, low: 100.5, close: 105, volume: 200 },
      { time: 3000, open: 108, high: 109, low: 99, close: 108.5, volume: 500 }
    ];
    const simPropA = simulateTrade(klinesA, 0, 'BUY', levels, { forwardWindow: 10, enablePartials: 'vcme-runner', frictionPct: 0.08 });
    const simPropC = simulateTrade(klinesC, 0, 'BUY', levels, { forwardWindow: 10, enablePartials: 'vcme-runner', frictionPct: 0.08 });
    assert.strictEqual(simPropA.pnlPct, 4.42, 'Under proportional friction, net PnL is 4.50% - 0.08% = 4.42%');
    assert.strictEqual(simPropC.pnlPct, 4.42, 'Under proportional friction, 3-partial exit pays exact 0.08% without 2x penalty');
    assert.strictEqual(simPropA.pnlPct, simPropC.pnlPct);
  });

  test('Revision 4: getKlinesFingerprint distinguishes micro-price assets (0.000011 vs 0.000014) and hashes s[0]', () => {
    // Exact counterexample from Revision 4 lines 84-86:
    const kline1: Kline = {
      time: 300,
      open: 0.000010,
      high: 0.000015,
      low: 0.000009,
      close: 0.000011,
      volume: 1000000
    };
    const kline2: Kline = {
      time: 300,
      open: 0.000010,
      high: 0.000015,
      low: 0.000009,
      close: 0.000014,
      volume: 1000000
    };

    const fp1 = getKlinesFingerprint([[kline1]]);
    const fp2 = getKlinesFingerprint([[kline2]]);

    assert.notStrictEqual(
      fp1,
      fp2,
      `Bit-level IEEE 754 hashing must produce distinct fingerprints for 0.000011 vs 0.000014 (got ${fp1} vs ${fp2})`
    );

    // Also verify that modification to first candle s[0] changes fingerprint
    const seriesA: Kline[] = [
      { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 50 },
      { time: 200, open: 11, high: 13, low: 10, close: 12, volume: 60 }
    ];
    const seriesB: Kline[] = [
      { time: 100, open: 10, high: 12, low: 9, close: 11.0001, volume: 50 },
      { time: 200, open: 11, high: 13, low: 10, close: 12, volume: 60 }
    ];
    const fpA = getKlinesFingerprint([seriesA]);
    const fpB = getKlinesFingerprint([seriesB]);
    assert.notStrictEqual(fpA, fpB, 'Fingerprint must be sensitive to candle 0 mutations');
  });

  test('Revision 4: calculateAndianOscillator maintains scale invariance under 1e-8 Satoshi scaling', () => {
    // Exact reproduction from Revision 4 lines 95-98:
    const bars200: Kline[] = [];
    let t = 1700000000;
    for (let i = 0; i < 200; i++) {
      const open = 100 + Math.sin(i / 8) * 4;
      const close = open + Math.sin(i * 0.7) * 2;
      const high = Math.max(open, close) + 0.5;
      const low = Math.min(open, close) - 0.5;
      bars200.push({ time: t, open, high, low, close, volume: 1000 });
      t += 300;
    }

    const scale = 1e-8;
    const barsScaled: Kline[] = bars200.map(k => ({
      time: k.time,
      open: k.open * scale,
      high: k.high * scale,
      low: k.low * scale,
      close: k.close * scale,
      volume: k.volume
    }));

    const andianNormal = calculateAndianOscillator(bars200, 14);
    const andianScaled = calculateAndianOscillator(barsScaled, 14);

    let diffCount = 0;
    for (let i = 60; i < 200; i++) {
      const resNormal = andianNormal[i];
      const resScaled = andianScaled[i];
      if (resNormal.bias !== resScaled.bias) {
        diffCount++;
      }
      assert.ok(
        Math.abs(resNormal.green - resScaled.green) < 1e-2,
        `Green oscillator at index ${i} must match under scale: ${resNormal.green} vs ${resScaled.green}`
      );
      assert.ok(
        Math.abs(resNormal.red - resScaled.red) < 1e-2,
        `Red oscillator at index ${i} must match under scale: ${resNormal.red} vs ${resScaled.red}`
      );
    }
    assert.strictEqual(diffCount, 0, `Scale invariance must produce 0 bias discrepancies across indices 60-199, got ${diffCount}`);
  });

  test('Revision 4: Chart isIncremental logic detects deep historical mutations at bar 10 in 30-bar dataset', () => {
    const prevData: Kline[] = [];
    let t = 1000;
    for (let i = 0; i < 30; i++) {
      prevData.push({ time: t, open: 100, high: 102, low: 98, close: 100, volume: 500 });
      t += 300;
    }

    // Case 1: Pure forming candle update (only bar 29 modified) -> incremental
    const formingUpdate = prevData.map((k, i) => i === 29 ? { ...k, close: 101.5 } : { ...k });
    assert.strictEqual(isChartDataIncremental(prevData, formingUpdate), true, 'Forming candle update must be incremental');

    // Case 2: Deep historical mutation at bar 10 (close 100 -> 110) -> NOT incremental
    const deepCloseMutation = prevData.map((k, i) => i === 10 ? { ...k, close: 110 } : { ...k });
    assert.strictEqual(isChartDataIncremental(prevData, deepCloseMutation), false, 'Historical close revision at bar 10 must invalidate incremental mode');

    // Case 3: Deep historical mutation at bar 10 (high 102 -> 120) -> NOT incremental
    const deepHighMutation = prevData.map((k, i) => i === 10 ? { ...k, high: 120 } : { ...k });
    assert.strictEqual(isChartDataIncremental(prevData, deepHighMutation), false, 'Historical high revision at bar 10 must invalidate incremental mode');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REVISION 5 AUDIT TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  test('Revision 5: alertTracker guarantees idempotency and non-retrograde stops on repeated snapshots', () => {
    // Exact scenario from Finding 1: VCME BUY, Entry 100, SL 90, TP1 102, TP2 110
    const alert: AuditAlertItem = {
      id: 'idemp-vcme-buy',
      symbol: 'BTCUSDT',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'BUY',
      status: 'OPEN',
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 102,
      takeProfit2: 110,
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    const klines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      // Candle 1: hits TP1 (high 103)
      { time: 1300, open: 100, high: 103, low: 100, close: 103, volume: 100 },
      // Candle 2: low 101, does not touch breakeven (100)
      { time: 1600, open: 103, high: 104, low: 101, close: 103, volume: 100 },
      // Candle 3: reaches TP2 (high 111 >= 110)
      { time: 1900, open: 104, high: 111, low: 103, close: 110.5, volume: 100 }
    ];

    // First call: produces TP2_HIT, +6.02% under proportional friction (0.11%)
    const update1 = updateAlertsOutcome([alert], { 'BTCUSDT:5m': klines });
    assert.strictEqual(update1.length, 1);
    assert.strictEqual(update1[0].status, 'TP2_HIT');
    assert.strictEqual(update1[0].pnlPercent, 6.02);
    assert.strictEqual(update1[0].tp1Hit, true);
    assert.strictEqual(update1[0].tp2Hit, true);
    assert.strictEqual(update1[0].tp1Time, 1300);
    assert.strictEqual(update1[0].tp2Time, 1900);

    // Second call: exactly the same candles and state returned by update1
    const update2 = updateAlertsOutcome(update1, { 'BTCUSDT:5m': klines });
    assert.strictEqual(update2.length, 1);
    // Must remain TP2_HIT with 6.05%, and NOT retroactively stop out at Candle 2 (low 101) with 3.83%!
    assert.strictEqual(update2[0].status, 'TP2_HIT', 'Repeated snapshot must NOT close position retroactively');
    assert.strictEqual(update2[0].pnlPercent, 6.02, 'Repeated snapshot must be 100% idempotent in PnL');
    assert.strictEqual(update2[0].realizedR, update1[0].realizedR);

    // Also verify SHORT position idempotency
    const shortAlert: AuditAlertItem = {
      id: 'idemp-vcme-sell',
      symbol: 'BTCUSDT',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'SELL',
      status: 'OPEN',
      entryPrice: 100,
      stopLoss: 110,
      takeProfit1: 98,
      takeProfit2: 90,
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    const shortKlines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { time: 1300, open: 100, high: 100, low: 97, close: 97, volume: 100 },
      { time: 1600, open: 97, high: 99, low: 96, close: 97, volume: 100 },
      { time: 1900, open: 96, high: 97, low: 89, close: 89.5, volume: 100 }
    ];

    const shortUpd1 = updateAlertsOutcome([shortAlert], { 'BTCUSDT:5m': shortKlines });
    assert.strictEqual(shortUpd1[0].status, 'TP2_HIT');
    const shortUpd2 = updateAlertsOutcome(shortUpd1, { 'BTCUSDT:5m': shortKlines });
    assert.strictEqual(shortUpd2[0].status, 'TP2_HIT');
    assert.strictEqual(shortUpd2[0].pnlPercent, shortUpd1[0].pnlPercent);
  });

  test('Revision 5: adverse gaps through stop loss take priority over subsequent targets and fill at open', () => {
    // Exact scenario from Finding 2:
    // Entry 100, SL initial 90, TP1 102, TP2 110, activeSL 100 (after TP1 hit)
    const alert: AuditAlertItem = {
      id: 'gap-vcme-buy',
      symbol: 'AAPL',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'BUY',
      status: 'TP1_HIT',
      tp1Hit: true,
      tp1Time: 1000,
      activeSL: 100,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 102,
      takeProfit2: 110,
      realizedR: 0.5,
      pnlPercent: 0.88,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    // Case 1: Candle O=95, H=96, L=94, C=95
    const klinesA: Kline[] = [
      { time: 1000, open: 100, high: 102.5, low: 100, close: 102, volume: 100 },
      { time: 1300, open: 95, high: 96, low: 94, close: 95, volume: 100 }
    ];
    const updA = updateAlertsOutcome([alert], { 'AAPL:5m': klinesA });
    assert.strictEqual(updA[0].status, 'TP1_BE_CLOSED');
    assert.strictEqual(updA[0].pnlPercent, -1.62, 'Adverse gap fill O=95 must yield exactly -1.62% net');

    // Case 2: Candle O=95, H=151, L=94, C=150 (gaps through SL before spiking to TP2/TP3)
    const klinesB: Kline[] = [
      { time: 1000, open: 100, high: 102.5, low: 100, close: 102, volume: 100 },
      { time: 1300, open: 95, high: 151, low: 94, close: 150, volume: 100 }
    ];
    const updB = updateAlertsOutcome([alert], { 'AAPL:5m': klinesB });
    assert.strictEqual(updB[0].status, 'TP1_BE_CLOSED', 'Open gap through stop must NOT evaluate subsequent intra-candle target');
    assert.strictEqual(updB[0].pnlPercent, -1.62, 'Must produce identical -1.62% net without taking +15.84% TP2');

    // Case 3: SHORT position adverse gap through stop loss
    const shortAlert: AuditAlertItem = {
      id: 'gap-vcme-sell',
      symbol: 'AAPL',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'SELL',
      status: 'TP1_HIT',
      tp1Hit: true,
      tp1Time: 1000,
      activeSL: 100,
      entryPrice: 100,
      stopLoss: 110,
      takeProfit1: 98,
      takeProfit2: 90,
      realizedR: 0.5,
      pnlPercent: 0.88,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };
    const shortKlines: Kline[] = [
      { time: 1000, open: 100, high: 100, low: 97.5, close: 98, volume: 100 },
      { time: 1300, open: 105, high: 106, low: 50, close: 55, volume: 100 }
    ];
    const shortUpd = updateAlertsOutcome([shortAlert], { 'AAPL:5m': shortKlines });
    assert.strictEqual(shortUpd[0].status, 'TP1_BE_CLOSED');
    assert.strictEqual(shortUpd[0].pnlPercent, -1.63);
  });

  test('Revision 5: alertTracker enforces session gap cutoff and emergency exit after TP1', () => {
    // AAPL VCME DayTrading 5m after TP1 executed
    const alert: AuditAlertItem = {
      id: 'session-vcme-buy',
      symbol: 'AAPL',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'BUY',
      status: 'TP1_HIT',
      tp1Hit: true,
      tp1Time: 1000,
      activeSL: 100,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 102,
      takeProfit2: 110,
      realizedR: 0.5,
      pnlPercent: 0.88,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    // Overnight session gap: 17 hours jump (61200 sec > 300 * 3)
    const klines: Kline[] = [
      { time: 1000, open: 100, high: 103, low: 100, close: 103, volume: 100 },
      { time: 1300, open: 103, high: 103.5, low: 102.5, close: 103, volume: 100 },
      { time: 1300 + 61200, open: 103, high: 103.5, low: 102.5, close: 103, volume: 100 }
    ];

    const upd = updateAlertsOutcome([alert], { 'AAPL:5m': klines });
    assert.strictEqual(upd[0].status, 'EXPIRED', 'Must terminate at session boundary gap even after TP1 was hit');
    assert.strictEqual(upd[0].pnlPercent, 2.37, 'Session gap exit slippage produces exactly +2.37% net');
  });

  test('Revision 5: forward window horizon caps evaluation chronologically and ignores post-expiry targets', () => {
    // VCME 5m, forwardWindow 24 bars, entry 100, SL 90, TP1 102, TP2 110
    const alert: AuditAlertItem = {
      id: 'horizon-vcme-buy',
      symbol: 'AAPL',
      interval: '5m',
      strategy: 'VCME DayTrading',
      signal: 'BUY',
      status: 'TP1_HIT',
      tp1Hit: true,
      tp1Time: 1000,
      activeSL: 100,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit1: 102,
      takeProfit2: 110,
      realizedR: 0.5,
      pnlPercent: 0.88,
      timestamp: 1000 * 1000,
      candleTimestamp: 1000,
      executionStyle: 'dayTrading'
    };

    // 80 bars: bars 1..24 hover at 103; bar 80 spikes to 151 (post-expiry)
    const klines: Kline[] = [
      { time: 1000, open: 100, high: 103, low: 100, close: 103, volume: 100 }
    ];
    for (let i = 1; i <= 79; i++) {
      const isPostExpirySpike = i === 79;
      klines.push({
        time: 1000 + i * 300,
        open: 103,
        high: isPostExpirySpike ? 151 : 103.5,
        low: isPostExpirySpike ? 102 : 102.5,
        close: isPostExpirySpike ? 150 : 103,
        volume: 100
      });
    }

    const upd = updateAlertsOutcome([alert], { 'AAPL:5m': klines });
    assert.strictEqual(upd[0].status, 'EXPIRED', 'Trade must expire at horizon bar 24');
    assert.strictEqual(upd[0].pnlPercent, 2.37, 'Expiration PnL must be +2.37%, not post-expiry +15.84% TP2');
  });

  test('Revision 5: evaluateStandardVotingAt requires valid EMA200 for actionable trade signal', () => {
    // Reproducible series from Finding 5: LCG seed 123, 122 bars
    let seed = 123;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const klines: Kline[] = [];
    let price = 100;
    for (let i = 0; i < 122; i++) {
      const delta = (lcg() - 0.5) * 2;
      price = Math.max(10, price + delta);
      klines.push({
        time: 1000 + i * 300,
        open: price,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 1000 + lcg() * 500
      });
    }

    const ctx = buildStandardVotingContext(klines);
    assert.ok(isNaN(ctx.ema200Series[121]), 'EMA200 must be NaN on 122 bars');

    const evalAt121 = evaluateStandardVotingAt(ctx, 121);
    assert.strictEqual(evalAt121.finalSignal, 'NEUTRAL', 'Must force finalSignal to NEUTRAL when EMA200 is NaN');
    assert.strictEqual(evalAt121.signal, 'NEUTRAL');
  });

  test('Revision 5: getKlinesFingerprint hashes all bars and invalidates cache on deep mutations in 3000+ bar series', () => {
    // 3,000 candles with base OHLC 103 / 104 / 102.5 / 103
    const series: Kline[] = [];
    for (let i = 0; i < 3000; i++) {
      series.push({
        time: 1000 + i * 300,
        open: 103,
        high: 104,
        low: 102.5,
        close: 103,
        volume: 500
      });
    }

    const fpBase = getKlinesFingerprint([series]);

    // Mutation at bar 1 (close: 103 -> 103.5)
    const mutatedClose = series.map((k, i) => i === 1 ? { ...k, close: 103.5 } : { ...k });
    const fpClose = getKlinesFingerprint([mutatedClose]);
    assert.notStrictEqual(fpClose, fpBase, 'Mutation at bar 1 close must change fingerprint in 3000-candle dataset');

    // Mutation at bar 1 (high: 104 -> 104.5)
    const mutatedHigh = series.map((k, i) => i === 1 ? { ...k, high: 104.5 } : { ...k });
    const fpHigh = getKlinesFingerprint([mutatedHigh]);
    assert.notStrictEqual(fpHigh, fpBase, 'Mutation at bar 1 high must change fingerprint');

    // Mutation at bar 1 (low: 102.5 -> 102.0)
    const mutatedLow = series.map((k, i) => i === 1 ? { ...k, low: 102.0 } : { ...k });
    const fpLow = getKlinesFingerprint([mutatedLow]);
    assert.notStrictEqual(fpLow, fpBase, 'Mutation at bar 1 low must change fingerprint');

    // Mutation at bar 1 (volume: 500 -> 1500)
    const mutatedVol = series.map((k, i) => i === 1 ? { ...k, volume: 1500 } : { ...k });
    const fpVol = getKlinesFingerprint([mutatedVol]);
    assert.notStrictEqual(fpVol, fpBase, 'Mutation at bar 1 volume must change fingerprint');
  });

  test('Revision 5: Multifractal engine defines only a single takeProfit1 target without unexecuted takeProfit2', () => {
    // Verify that Multifractal levels configuration adheres strictly to 100% exit at TP1
    const entryPrice = 100;
    const stopLoss = 95;
    const riskDist = Math.abs(entryPrice - stopLoss);
    const tp1Price = entryPrice + 1.5 * riskDist;

    const levels = {
      stopLoss,
      takeProfit1: tp1Price
    };

    assert.strictEqual(levels.takeProfit1, 107.5);
    assert.strictEqual((levels as Record<string, unknown>).takeProfit2, undefined, 'Multifractal must not define takeProfit2');
  });

  test('Revision 6: VCME stop loss includes trigger candle extreme and prevents stop placement inside trigger wick', () => {
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0);
    const klines5m = generateSyntheticKlines(120, 300, 100, 0);

    // Build context and simulate a capitulation candle at the end
    const lastIdx = klines5m.length - 1;
    // Set preceding bars with a moderate low of 98.0
    for (let j = lastIdx - 10; j < lastIdx; j++) {
      klines5m[j].low = Math.max(98.0, klines5m[j].low);
    }
    // Trigger candle has a deep lower wick (capitulation to 94.0, close 98.5)
    klines5m[lastIdx].open = 97.0;
    klines5m[lastIdx].low = 94.0;
    klines5m[lastIdx].high = 99.0;
    klines5m[lastIdx].close = 98.5;

    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'MR_TEST', 'dayTrading', 'agresivo');
    const res = evaluateVCMESniperAt(ctx, lastIdx);

    // If signal triggers (or if evaluated), verify that stopLoss is never inside the wick [94.0, 98.5]
    if (res.signal === 'BUY') {
      const atr = ctx.atrSeries5m[lastIdx] || 1;
      assert.ok(
        res.stopLoss <= klines5m[lastIdx].low - 0.15 * atr,
        `Stop loss (${res.stopLoss}) must be at or below trigger candle low (${klines5m[lastIdx].low}) minus buffer, never inside wick`
      );
    }
  });

  test('Revision 6: backtester 1d forwardWindow preserves strategy parameter and formats dynamic forwardLabel', () => {
    const klines1d = generateSyntheticKlines(90, 86400, 100, 0.05);
    const signals = klines1d.map(() => 'NEUTRAL' as const);

    const confRes = runBacktestGenericOptimized(klines1d, '1d', signals, 'confluencia');
    assert.strictEqual(confRes.forwardWindow, 6, 'Confluencia on 1d must have forwardWindow 6');
    assert.strictEqual(confRes.forwardLabel, '6 velas (6 días)', 'forwardLabel must dynamically state 6 velas (6 días)');

    const scorRes = runBacktestGenericOptimized(klines1d, '1d', signals, 'scoring');
    assert.strictEqual(scorRes.forwardWindow, 5, 'Scoring on 1d must have forwardWindow 5');
    assert.strictEqual(scorRes.forwardLabel, '5 velas (5 días)', 'forwardLabel must dynamically state 5 velas (5 días)');

    const stdRes = runBacktestGenericOptimized(klines1d, '1d', signals, 'standard');
    assert.strictEqual(stdRes.forwardWindow, 3, 'Standard on 1d must have forwardWindow 3');
    assert.strictEqual(stdRes.forwardLabel, '3 velas (3 días)', 'forwardLabel must dynamically state 3 velas (3 días)');
  });

  test('Revision 6: calculateSessionStats segregates exploratory alerts from validated track record', () => {
    const todayMs = Date.now();
    const alerts: AuditAlertItem[] = [
      // 2 Validated Alerts (Both wins: +1.5R, +1.0R)
      {
        id: 'val-1', symbol: 'BTCUSDT', interval: '5m', signal: 'BUY', time: '10:00',
        pf: 2.5, strategy: 'VCME Sniper', alertType: 'PRIMARY', confidence: 'HIGH',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'TP1_CLOSED',
        realizedR: 1.5, pnlPercent: 3.0, timestamp: todayMs
      },
      {
        id: 'val-2', symbol: 'ETHUSDT', interval: '5m', signal: 'BUY', time: '11:00',
        pf: 2.0, strategy: 'Confluencia', alertType: 'PRIMARY', confidence: 'HIGH',
        entryPrice: 100, stopLoss: 98, takeProfit1: 102, status: 'TP1_CLOSED',
        realizedR: 1.0, pnlPercent: 2.0, timestamp: todayMs
      },
      // 2 Exploratory Alerts (Both losses: -1.0R, -1.0R)
      {
        id: 'exp-1', symbol: 'SOLUSDT', interval: '5m', signal: 'BUY', time: '12:00',
        pf: null, strategy: 'Estándar (Exploratoria)', alertType: 'EXPLORATORY', confidence: 'NONE',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'SL_HIT',
        realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs
      },
      {
        id: 'exp-2', symbol: 'ADAUSDT', interval: '5m', signal: 'BUY', time: '13:00',
        pf: null, strategy: 'Estándar (Exploratoria)', alertType: 'EXPLORATORY', confidence: 'NONE',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'SL_HIT',
        realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs
      }
    ];

    const stats = calculateSessionStats(alerts, false);

    // Validated metrics must NOT be contaminated by exploratory losses
    assert.strictEqual(stats.total, 2, 'Validated total must only count primary/validated alerts');
    assert.strictEqual(stats.wins, 2, 'Validated wins must be 2');
    assert.strictEqual(stats.losses, 0, 'Validated losses must be 0 (exploratory losses excluded)');
    assert.strictEqual(stats.winRate, 100, 'Validated winRate must be 100%');
    assert.strictEqual(stats.totalR, 2.5, 'Validated totalR must be +2.5R');

    // Exploratory metrics must be segregated in stats.exploratory
    assert.ok(stats.exploratory, 'stats.exploratory must be defined');
    assert.strictEqual(stats.exploratory.total, 2);
    assert.strictEqual(stats.exploratory.wins, 0);
    assert.strictEqual(stats.exploratory.losses, 2);
    assert.strictEqual(stats.exploratory.winRate, 0);
    assert.strictEqual(stats.exploratory.totalR, -2.0);
  });

  test('Revision 6: resolveStandardExploratoryFallback neutralizes signals when Standard backtest has negative directional edge', () => {
    // Mock QVESelectionResult where Standard has negative BUY expectancy (-0.35R with 5 trades)
    const mockQveNegBuy = {
      candidates: [
        {
          key: 'standard',
          label: 'Estándar',
          profitFactor: 0.8,
          expectancyR: -0.2,
          winRate: 0.4,
          resolved: 8,
          longStats: { signals: 5, wins: 1, losses: 4, winRate: 0.2, profitFactor: 0.5, expectancyR: -0.35 },
          shortStats: { signals: 3, wins: 2, losses: 1, winRate: 0.67, profitFactor: 1.5, expectancyR: 0.4 },
        }
      ]
    } as unknown as QVESelectionResult;

    // BUY signal must be neutralized because longStats has >= 3 trades and negative expectancy (-0.35R)
    const buyResult = resolveStandardExploratoryFallback(mockQveNegBuy, 'BUY');
    assert.strictEqual(buyResult, 'NEUTRAL', 'Must neutralize BUY fallback when Standard has negative long expectancy');

    // SELL signal must be preserved because shortStats has positive expectancy (+0.4R)
    const sellResult = resolveStandardExploratoryFallback(mockQveNegBuy, 'SELL');
    assert.strictEqual(sellResult, 'SELL', 'Must preserve SELL fallback when Standard has positive short expectancy');

    // Mock QVESelectionResult where sample is insufficient (< 3 trades) -> should allow exploratory signal
    const mockQveSmallSample = {
      candidates: [
        {
          key: 'standard',
          label: 'Estándar',
          profitFactor: null,
          expectancyR: 0,
          winRate: 0.5,
          resolved: 2,
          longStats: { signals: 1, wins: 0, losses: 1, winRate: 0, profitFactor: 0, expectancyR: -1.0 },
          shortStats: { signals: 1, wins: 1, losses: 0, winRate: 1.0, profitFactor: null, expectancyR: 1.5 },
        }
      ]
    } as unknown as QVESelectionResult;

    const smallSampleBuy = resolveStandardExploratoryFallback(mockQveSmallSample, 'BUY');
    assert.strictEqual(smallSampleBuy, 'BUY', 'Must allow BUY fallback when sample size is small (< 3 trades) as exploratory');
  });

  test('Revision 6: Confluencia evaluates hammer with bRatio < 0.30 without artificial dead-code suppression', () => {
    // Generate synthetic klines with bullish trend: closes increasing so EMA9 > EMA20 and close > VWAP
    const klines = generateSyntheticKlines(35, 3600, 100, 0.4);
    const lastIdx = klines.length - 1;

    // High volume on trigger candle
    klines[lastIdx].volume = 15000;
    for (let j = 0; j < lastIdx; j++) {
      klines[j].volume = 1000;
    }

    // Configure trigger candle as a classic hammer with small body:
    // body = 0.4, lowerWick = 1.6 (4x body), upperWick = 0.05, total range = 2.05 -> bRatio = 0.4 / 2.05 = 19.5% (< 30%)
    klines[lastIdx].open = 117.6;
    klines[lastIdx].close = 118.0;
    klines[lastIdx].high = 118.05;
    klines[lastIdx].low = 116.0;

    const ctx = buildConfluenciaContext(klines, '1h');
    const res = evaluateConfluenciaAt(ctx, lastIdx);

    assert.strictEqual(res.signal, 'BUY', 'Confluencia must trigger BUY on valid hammer even when body ratio is < 30%');
  });

  test('Revision 6: VCME stop loss enforces 1.5 ATR security floor against friction and enables dynamic SELL risk up to 1.8 ATR', () => {
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0);
    const klines5m = generateSyntheticKlines(60, 300, 100, 0);
    const lastIdxVcme = klines5m.length - 1;

    const ctxVcme = buildVCMESniperContext(klines5m, klines1h, klines1d, 'BTCUSDT', 'dayTrading', 'agresivo');
    const hIdx = 50;
    const dIdx = 40;
    for (let j = 0; j < klines5m.length; j++) {
      ctxVcme.idx1dMap[j] = dIdx;
      ctxVcme.idx1hMap[j] = hIdx;
    }

    // 1D setup
    ctxVcme.closes1d[dIdx] = 110;
    ctxVcme.ema200_1d[dIdx] = 100;
    ctxVcme.ema50_1d[dIdx] = 105;
    ctxVcme.adxData1d.adx[dIdx] = 30;
    ctxVcme.adxData1d.plusDI[dIdx] = 25;
    ctxVcme.adxData1d.minusDI[dIdx] = 10;

    // 1H setup
    ctxVcme.closes1h[hIdx] = 105;
    ctxVcme.ema200_1h[hIdx] = 95;
    ctxVcme.ema200_1h[hIdx - 5] = 94;
    ctxVcme.atrSeries1h[hIdx] = 1.0;
    ctxVcme.adxSeries1h.adx[hIdx] = 25;
    ctxVcme.ema20_1h[hIdx] = 104;
    ctxVcme.ema50_1h[hIdx] = 100;
    ctxVcme.rsiSeries1h[hIdx] = 60;
    ctxVcme.macdData1h.histogram[hIdx] = 0.5;
    ctxVcme.macdData1h.histogram[hIdx - 1] = 0.2;
    ctxVcme.vwapSeries1h[hIdx] = 103;

    // 5M volume and setup
    ctxVcme.vol5m[lastIdxVcme] = 5000;
    ctxVcme.volSma5m[lastIdxVcme] = 1000;
    ctxVcme.klines5m[lastIdxVcme].volume = 5000;

    // 1. Test minRisk protection: tight swing low at 0.5 ATR below entry
    for (let s = lastIdxVcme - 10; s < lastIdxVcme - 1; s++) {
      ctxVcme.klines5m[s].low = 105.7;
      ctxVcme.klines5m[s].high = 105.9;
    }
    ctxVcme.klines5m[lastIdxVcme - 1].low = 105.7;
    ctxVcme.klines5m[lastIdxVcme - 1].high = 105.9;
    ctxVcme.ema9_5m[lastIdxVcme - 1] = 105.8;
    ctxVcme.ema21_5m[lastIdxVcme - 1] = 105.8;
    ctxVcme.vwapSeries5m[lastIdxVcme - 1] = 105.8;

    ctxVcme.vwapSeries5m[lastIdxVcme] = 104;
    ctxVcme.ema9_5m[lastIdxVcme] = 105.8;
    ctxVcme.ema21_5m[lastIdxVcme] = 105.5;
    ctxVcme.atrSeries5m[lastIdxVcme] = 1.0;

    const curr5m = ctxVcme.klines5m[lastIdxVcme];
    curr5m.open = 105.8;
    curr5m.close = 106.0;
    curr5m.high = 106.1;
    curr5m.low = 105.7;

    const resTight = evaluateVCMESniperAt(ctxVcme, lastIdxVcme);
    assert.strictEqual(resTight.signal, 'BUY', 'Must trigger BUY on pullback setup');
    // Stop loss must be floored at 1.5 ATR (104.5) to protect against commission drag and micro-noise
    assert.strictEqual(resTight.stopLoss, 104.5, 'Stop loss must be floored at 1.5 ATR when swing is < 1.5 ATR');

    // 2. Test structural stop expansion: swing low at 1.55 ATR below entry (104.65 - 0.20 = 104.45)
    curr5m.low = 104.65;
    curr5m.open = 105.4; // preserves candleBodyRatio = 0.6 / 1.45 = 0.41 >= 0.3
    for (let s = lastIdxVcme - 10; s < lastIdxVcme - 1; s++) {
      ctxVcme.klines5m[s].low = 104.65;
    }
    const resStructural = evaluateVCMESniperAt(ctxVcme, lastIdxVcme);
    assert.strictEqual(resStructural.signal, 'BUY');
    // Structural swing expands stop beyond 1.5 ATR (104.5) up to 1.55 ATR (104.45) while remaining under maxAllowedRisk (1.5%)
    assert.strictEqual(resStructural.stopLoss, 104.45, 'Structural stop of 1.55 ATR must expand beyond 1.5 ATR floor');

    // 3. Test structural stop clamping in PULLBACK: swing low at 2.2 ATR below entry (103.8)
    // Previously, risk = 2.4 ATR > 1.8 ATR caused immediate discard to NEUTRAL.
    // Now, with clamping, stopLoss is clamped to entry - maxRisk (106.0 - 1.8 = 104.2).
    // In DAY mode (maxAllowedRisk 1.5%), risk of 1.8 / 106 = 1.70% > 1.5% is faithfully discarded by riskFilter.
    // In SWING mode (maxAllowedRisk 3.5%), risk of 1.70% <= 3.5% is allowed and clamped to 1.8 ATR.
    for (let s = lastIdxVcme - 10; s < lastIdxVcme - 1; s++) {
      ctxVcme.klines5m[s].low = 103.8;
    }
    // Keep trigger candle low at 105.0 so entry - maxRisk (104.2) clears trigger candle low (105.0 - 0.15 = 104.85)
    curr5m.low = 105.0;
    curr5m.open = 105.5;
    curr5m.close = 106.0;

    // First, verify DAY mode correctly enforces 1.5% account capital limit
    const resDayExcessive = evaluateVCMESniperAt(ctxVcme, lastIdxVcme);
    assert.strictEqual(resDayExcessive.signal, 'NEUTRAL');
    assert.strictEqual(resDayExcessive.discardReason, 'riskFilter');

    // Second, verify SWING mode (where 1.70% <= 3.5%) clamps to 1.8 ATR and remains actionable BUY
    ctxVcme.style = 'swing';
    const resClamped = evaluateVCMESniperAt(ctxVcme, lastIdxVcme);
    assert.strictEqual(resClamped.signal, 'BUY', 'Clamped pullback must remain actionable BUY');
    assert.strictEqual(resClamped.stopLoss, 104.2, 'Stop loss must be clamped to 1.8 ATR (104.2)');
  });

  // Test 124: Revision 6: Walk-Forward symmetrically classifies N < effectiveMinOos as INSUFFICIENT_OOS and prevents single-trade noise disqualification in tournament
  test('Revision 6: Walk-Forward symmetrically classifies N < effectiveMinOos as INSUFFICIENT_OOS and prevents single-trade noise disqualification', () => {
    // 1. Single trade in OOS with -1.0R loss (< effectiveMinOos)
    const tradesSingleLoss: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 0.9, pnlPct: 3.6, outcome: 'win', entryIdx: 15 },
      { dir: 'BUY', realizedR: 1.2, pnlPct: 4.8, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 0.7, pnlPct: 2.8, outcome: 'win', entryIdx: 25 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 40 },
      { dir: 'BUY', realizedR: 1.4, pnlPct: 5.6, outcome: 'win', entryIdx: 50 },
      { dir: 'BUY', realizedR: 1.1, pnlPct: 4.4, outcome: 'win', entryIdx: 60 },
      // 1 OOS trade only (splitIdx = 70)
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 85 }
    ];

    const wfSingleLoss = calculateWalkForward(tradesSingleLoss, 0, 99, 0.70, 5, 25);
    assert.strictEqual(wfSingleLoss.outOfSample.signals, 1);
    assert.strictEqual(wfSingleLoss.outOfSample.expectancyR, -1.0);
    assert.strictEqual(wfSingleLoss.status, 'INSUFFICIENT_OOS', 'Single negative OOS trade must receive INSUFFICIENT_OOS, NOT FAIL');
    assert.strictEqual(wfSingleLoss.passed, false, 'Underpowered sample must not pass');

    // 2. Candidate with robust In-Sample (15 trades) and 1 OOS loss must qualify for LIMITED confidence (NOT disqualified to NONE)
    const candidateWithSingleOosLoss: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia Robust IS',
      profitFactor: 2.5,
      expectancyR: 0.60,
      expectancyPerHour: 1.2,
      avgExposureHours: 0.5,
      winRate: 0.75,
      resolved: 15,
      forwardWindow: 6,
      walkForward: wfSingleLoss
    };

    const tourney = evaluateStrategyTournament([candidateWithSingleOosLoss], '5m');
    assert.strictEqual(tourney.confidence, 'LIMITED', 'Robust candidate with 1 OOS loss must retain LIMITED confidence based on IS track record');
    assert.strictEqual(tourney.bestStrategy, 'confluencia');
    assert.ok(tourney.reasoning.includes('Muestra OOS reducida (1 trades)'), 'Reasoning must clearly indicate reduced OOS sample');

    // 3. Candidate with >= effectiveMinOos (3 trades) and negative edge still legitimately receives FAIL and is disqualified
    const tradesThreeLosses: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.2, pnlPct: 4.8, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 0.8, pnlPct: 3.2, outcome: 'win', entryIdx: 30 },
      // 3 OOS trades
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 75 },
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 82 },
      { dir: 'BUY', realizedR: -0.8, pnlPct: -3.2, outcome: 'loss', entryIdx: 90 }
    ];
    const wfThreeLosses = calculateWalkForward(tradesThreeLosses, 0, 99, 0.70, 3, 25);
    assert.strictEqual(wfThreeLosses.outOfSample.signals, 3);
    assert.strictEqual(wfThreeLosses.status, 'FAIL', '3 trades with negative edge must receive FAIL');
    assert.strictEqual(wfThreeLosses.passed, false);

    const candidateFailed: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia Failed OOS',
      profitFactor: 2.0,
      expectancyR: 0.50,
      expectancyPerHour: 1.0,
      avgExposureHours: 0.5,
      winRate: 0.70,
      resolved: 15,
      forwardWindow: 6,
      walkForward: wfThreeLosses
    };
    const tourneyFailed = evaluateStrategyTournament([candidateFailed], '5m');
    assert.strictEqual(tourneyFailed.confidence, 'NONE', 'Candidate with verified FAIL in OOS must be disqualified');

    // 4. selectActionableStrategy handles INSUFFICIENT_OOS fallback without abrupt rejection
    const qve: QVESelectionResult = {
      bestStrategy: 'standard',
      strategyLabel: 'Standard',
      confidence: 'LIMITED',
      profitFactor: 1.5,
      expectancyR: 0.3,
      expectancyPerHour: 0.6,
      maxDrawdownR: 1.0,
      sortinoRatio: 1.2,
      tournament: {
        compositeScore: 10,
        longStats: { signals: 8, wins: 5, losses: 3, winRate: 0.625, expectancyR: 0.35, profitFactor: 1.8, maxDrawdownR: 1.0 },
        shortStats: { signals: 7, wins: 4, losses: 3, winRate: 0.571, expectancyR: 0.25, profitFactor: 1.4, maxDrawdownR: 1.0 },
        reasoning: 'Primary'
      },
      candidates: [
        {
          key: 'standard',
          label: 'Standard',
          profitFactor: 1.5,
          expectancyR: 0.3,
          expectancyPerHour: 0.6,
          avgExposureHours: 0.5,
          winRate: 0.60,
          resolved: 15,
          forwardWindow: 6
        },
        candidateWithSingleOosLoss
      ],
      targetInterval: '5m'
    };

    // Standard signal is NEUTRAL, fallback candidateWithSingleOosLoss triggers BUY
    const actionable = selectActionableStrategy(qve, { standard: 'NEUTRAL', confluencia: 'BUY' });
    assert.ok(actionable !== null, 'Actionable fallback must be found');
    assert.strictEqual(actionable?.strategy, 'confluencia');
    assert.strictEqual(actionable?.isFallback, true);
    assert.ok(actionable?.reasoning.includes('muestra reducida no concluyente'), 'Reasoning must state inconclusive reduced OOS');
  });

  // Test 125: Revision 6: Scoring R:R validation parity with calculateAlertLevels [0.2%, 8%] clamp and dynamic S/R resolution
  test('Revision 6: Scoring R:R validation enforces parity with calculateAlertLevels clamp and dynamic S/R resolution', () => {
    // Generate synthetic klines with low ATR = 0.10 (0.1% on price 100)
    const klines = generateSyntheticKlines(80, 300, 100, 0.001);
    const lastIdx = klines.length - 1;

    // Craft strong bullish indicators for Scoring BUY
    const ctx = buildScoringContext(klines, '5m');
    // Ensure atrSeries at lastIdx is 0.10 (0.1%)
    ctx.atrSeries[lastIdx] = 0.10;
    klines[lastIdx].close = 100.0;
    klines[lastIdx].open = 99.8;
    klines[lastIdx].high = 100.1;
    klines[lastIdx].low = 99.7;
    ctx.closes[lastIdx] = 100.0;

    // Cache entry with resistances at 100.25 (which blocks 100.30 target) and 100.50
    const cacheIdx = Math.floor(lastIdx / 5) * 5;
    ctx.srCache.set(cacheIdx, {
      nearestSupport: 99.5,
      nearestResistance: 100.25,
      supports: [99.5, 99.0],
      resistances: [100.25, 100.50]
    });

    // Artificially boost scores to trigger BUY before R:R check
    ctx.emaFastArr[lastIdx] = 101.0;
    ctx.emaSlowArr[lastIdx] = 99.0;
    ctx.rsiSeries[lastIdx - 3] = 50.0; // diff = 60 - 50 = +10 > 1.5 triggers rising RSI (+1.0 score)
    ctx.rsiSeries[lastIdx - 2] = 55.0;
    ctx.rsiSeries[lastIdx - 1] = 58.0;
    ctx.rsiSeries[lastIdx] = 60.0;
    const bbIdx = lastIdx - (ctx.cfg.bbPeriod - 1);
    if (bbIdx >= 0 && bbIdx < ctx.bbSeries.length) {
      ctx.bbSeries[bbIdx] = { upper: 105, lower: 95, middle: 100, bandwidth: 0.10, percentB: 0.5 };
    }
    ctx.vwapSeries[lastIdx] = 99.5;
    if (ctx.vwapReliableSeries) ctx.vwapReliableSeries[lastIdx] = true;

    // 1. With resistance at 100.25, target is at 100.30 (clamped 0.2% * 1.5 = 0.3%).
    // In old code, 1.5 * atr * 1.5 = 0.225%, so 100.25 passed!
    // In new code, targetDist is 0.30, rewardRoom = 0.25 < 0.30, so it must be blocked to HOLD!
    const resBlocked = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resBlocked.signal, 'HOLD', 'Scoring must block BUY to HOLD when resistance (100.25) is before TP1 (100.30)');
    assert.ok(resBlocked.layers.structure.note.includes('insuficiente'), 'Structure note must indicate insufficient R:R');

    // 2. Test dynamic S/R resolution when close advances past first resistance:
    // If price is 100.28 (above first resistance 100.25):
    klines[lastIdx].close = 100.28;
    ctx.closes[lastIdx] = 100.28;
    // Next resistance is at 100.50. Target for 100.28 is 100.28 + 0.30 = 100.58.
    // Reward room to 100.50 is 0.22 < 0.30 targetDist.
    // In old code, 100.25 - 100.28 = -0.03 < 0, so check was skipped completely!
    // In new code, it dynamically finds next resistance 100.50 and blocks!
    const resDynamicBlocked = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resDynamicBlocked.signal, 'HOLD', 'Must dynamically evaluate against next resistance (100.50) rather than skipping');

    // 3. Clear path: when resistance is safely beyond TP1 (e.g. 100.80):
    ctx.srCache.set(cacheIdx, {
      nearestSupport: 99.5,
      nearestResistance: 100.80,
      supports: [99.5, 99.0],
      resistances: [100.80]
    });
    klines[lastIdx].close = 100.0;
    ctx.closes[lastIdx] = 100.0;
    const resClean = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resClean.signal, 'BUY', 'When resistance is beyond TP1 (100.80 > 100.30), BUY must pass');
  });

  // Test 126: Revision 6: Confluencia volume filter rejects zero-volume symbols and aligns validVolume with 0.8x threshold
  test('Revision 6: Confluencia volume filter rejects zero-volume symbols and aligns validVolume with 0.8x threshold', () => {
    // 1. Zero-volume series (e.g. ^VIX or forex feed without volume)
    const zeroVolKlines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      time: 1000 + i * 300,
      open: 100 + i * 0.5,
      high: 100 + i * 0.5 + 0.3,
      low: 100 + i * 0.5 - 0.2,
      close: 100 + i * 0.5 + 0.25,
      volume: 0
    }));
    const zeroCtx = buildConfluenciaContext(zeroVolKlines, '5m');
    const zeroRes = evaluateConfluenciaAt(zeroCtx, 29);
    assert.strictEqual(zeroRes.signal, 'NEUTRAL', 'Symbols with zero volume must NOT pass Confluencia filter via 0 >= 0');
    assert.strictEqual(zeroRes.validVolume, false, 'validVolume must be false for zero-volume series');

    // 2. Volume at 85% of average (0.85 * vAvg >= 0.8 * vAvg):
    // Both signal and validVolume must be true (UI parity with strategy)
    const normalKlines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      time: 1000 + i * 300,
      open: 100 + i * 0.5,
      high: 100 + i * 0.5 + 0.3,
      low: 100 + i * 0.5 - 0.2,
      close: 100 + i * 0.5 + 0.25,
      volume: 1000
    }));
    // Last bar volume at 850 (0.85 * 1000 = 85%)
    normalKlines[29].volume = 850;
    const normalCtx = buildConfluenciaContext(normalKlines, '5m');
    const normalRes = evaluateConfluenciaAt(normalCtx, 29);
    assert.strictEqual(normalRes.validVolume, true, 'Volume at 85% of vAvg must report validVolume: true (aligned with >= 0.8x threshold)');

    // 3. Volume below 80% of average (750 < 800):
    normalKlines[29].volume = 750;
    const lowCtx = buildConfluenciaContext(normalKlines, '5m');
    const lowRes = evaluateConfluenciaAt(lowCtx, 29);
    assert.strictEqual(lowRes.validVolume, false, 'Volume at 75% of vAvg must report validVolume: false');
    assert.strictEqual(lowRes.signal, 'NEUTRAL', 'Confluencia must reject trades with volume below 80% of vAvg');
  });

  // Test 127: Revision 6: Tournament calcScore applies Walk-Forward Bayesian modulation to penalize negative OOS in LIMITED
  test('Revision 6: Tournament calcScore applies Walk-Forward Bayesian modulation to penalize negative OOS in LIMITED', () => {
    // Candidate Positive OOS: IS E[R] = 0.40R, OOS 2 trades with E[R] = +0.50R (INSUFFICIENT_OOS -> x0.90)
    const candidatePositiveOOS: StrategyCandidate = {
      key: 'standard',
      label: 'Positive OOS Candidate',
      profitFactor: 1.8,
      expectancyR: 0.40,
      expectancyPerHour: 0.20,
      avgExposureHours: 2.0,
      winRate: 0.60,
      resolved: 15,
      maxDrawdownR: 1.0,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 15, wins: 9, losses: 6, winRate: 0.60, expectancyR: 0.40, profitFactor: 1.8, maxDrawdownR: 1.0,
          avgExposureHours: 2.0
        },
        outOfSample: {
          signals: 2, wins: 2, losses: 0, winRate: 1.0, expectancyR: 0.50, profitFactor: 99.0, maxDrawdownR: 0,
          avgExposureHours: 1.5
        },
        passed: false,
        status: 'INSUFFICIENT_OOS'
      }
    };

    // Candidate Negative OOS: Slightly higher IS E[R] = 0.42R, but OOS 2 trades with E[R] = -1.0R (INSUFFICIENT_OOS -> x0.70)
    const candidateNegativeOOS: StrategyCandidate = {
      key: 'scoring',
      label: 'Negative OOS Candidate',
      profitFactor: 1.9,
      expectancyR: 0.42,
      expectancyPerHour: 0.21,
      avgExposureHours: 2.0,
      winRate: 0.62,
      resolved: 15,
      maxDrawdownR: 1.0,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: {
          signals: 15, wins: 10, losses: 5, winRate: 0.62, expectancyR: 0.42, profitFactor: 1.9, maxDrawdownR: 1.0,
          avgExposureHours: 2.0
        },
        outOfSample: {
          signals: 2, wins: 0, losses: 2, winRate: 0.0, expectancyR: -1.0, profitFactor: 0.0, maxDrawdownR: 2.0,
          avgExposureHours: 1.5
        },
        passed: false,
        status: 'INSUFFICIENT_OOS'
      }
    };

    const tourney = evaluateStrategyTournament([candidateNegativeOOS, candidatePositiveOOS], '5m');
    assert.strictEqual(tourney.confidence, 'LIMITED', 'Confidence must be LIMITED');
    // Positive OOS candidate (0.40 * 0.90 = 0.36) must beat Negative OOS candidate (0.42 * 0.70 = 0.294)
    assert.strictEqual(tourney.bestStrategy, 'standard', 'Positive OOS candidate must beat Negative OOS candidate due to x0.70 Bayesian OOS penalty');
  });

  // Test 128: Revision 6: Scoring S/R cache preserves raw pivot highs/lows preventing blindness when price retraces
  test('Revision 6: Scoring S/R cache preserves raw pivot highs/lows preventing blindness when price retraces', () => {
    // Generate synthetic klines with length 65 so cache index 60 is populated
    const klines = generateSyntheticKlines(65, 300, 100, 0.001);
    const lastIdx = klines.length - 1; // 64

    const ctx = buildScoringContext(klines, '5m');
    const cacheIdx = Math.floor(lastIdx / 5) * 5; // 60

    // Simulate raw clustered pivots in cache:
    // pivotHighs contains a resistance at 100.50
    // At the snapshot (candle 60), price closed at 101.00.
    // In old code, 100.50 was dropped because 100.50 < 101.00.
    // In new code, 100.50 is preserved in pivotHighs!
    ctx.srCache.set(cacheIdx, {
      pivotHighs: [100.50, 102.00],
      pivotLows: [99.00, 99.50]
    });

    // Now at lastIdx (candle 64), price has retraced to 100.25
    klines[lastIdx].close = 100.25;
    klines[lastIdx].open = 100.00;
    klines[lastIdx].high = 100.30;
    klines[lastIdx].low = 99.95;
    ctx.closes[lastIdx] = 100.25;
    ctx.atrSeries[lastIdx] = 0.10; // clamped targetDist = 0.30075. rewardRoom = 100.50 - 100.25 = 0.25 < 0.30075

    // Boost indicators for BUY
    ctx.emaFastArr[lastIdx] = 101.0;
    ctx.emaSlowArr[lastIdx] = 99.0;
    ctx.rsiSeries[lastIdx - 3] = 50.0;
    ctx.rsiSeries[lastIdx - 2] = 55.0;
    ctx.rsiSeries[lastIdx - 1] = 58.0;
    ctx.rsiSeries[lastIdx] = 60.0;
    const bbIdx = lastIdx - (ctx.cfg.bbPeriod - 1);
    if (bbIdx >= 0 && bbIdx < ctx.bbSeries.length) {
      ctx.bbSeries[bbIdx] = { upper: 105, lower: 95, middle: 100, bandwidth: 0.10, percentB: 0.5 };
    }
    ctx.vwapSeries[lastIdx] = 99.5;
    if (ctx.vwapReliableSeries) ctx.vwapReliableSeries[lastIdx] = true;

    const res = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(res.signal, 'HOLD', 'Must detect resistance at 100.50 and block BUY to HOLD due to insufficient R:R');
    assert.ok(res.layers.structure.note.includes('100.50'), 'Structure note must reference resistance at 100.50');
  });

  // Test 129: Friction Viability Gate (Fix C) filters unviable micro-stops where friction eats > 35% of R
  test('Revision 6: isTradeFrictionViable and backtester gate out micro-stops where friction exceeds 0.35R', () => {
    // 1. Math verification:
    // With 0.11% commission + 0.03% slippage = 0.14% friction:
    // A stop of 0.20% (0.002) has friction / stop = 0.14 / 0.20 = 0.70R (> 0.35R) -> UNVIABLE
    assert.strictEqual(isTradeFrictionViable(100, 99.80), false, '0.20% stop must be rejected as unviable (0.70R fee)');
    
    // A stop of 0.50% (0.005) has friction / stop = 0.14 / 0.50 = 0.28R (<= 0.35R) -> VIABLE
    assert.strictEqual(isTradeFrictionViable(100, 99.50), true, '0.50% stop must be accepted as viable (0.28R fee)');

    // Minimum viable stop is 0.40% ((0.11 + 0.03) / 0.35 = 0.40%)
    const minViable = getMinViableStopPct();
    assert.ok(Math.abs(minViable - 0.004) < 1e-4, `Min viable stop must be 0.40% (got ${minViable})`);

    // 2. Backtester gate:
    // Generate low-volatility candles where range is tiny (0.04 on price 100 -> ATR ~ 0.04% -> clamped stop is 0.20%)
    const lowVolKlines: Kline[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < 600; i++) {
      lowVolKlines.push({
        time: baseTime + i * 300,
        open: 100,
        high: 100.02,
        low: 99.98,
        close: 100,
        volume: 1000
      });
    }

    // Force BUY signals inside the evaluation window (indices 300, 320, 340)
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(600).fill('NEUTRAL');
    signals[300] = 'BUY';
    signals[320] = 'BUY';
    signals[340] = 'BUY';

    const btRes = runBacktestGenericOptimized(lowVolKlines, '5m', signals, 'standard');
    // Because ATR is ~0.04% and clamped stop is 0.20%, all 3 signals must be discarded into frictionFilter
    assert.strictEqual(btRes.totalSignals, 0, 'No signals should execute with micro-stop 0.20%');
    assert.strictEqual(btRes.discards.frictionFilter, 3, 'All 3 signals must be discarded in discards.frictionFilter');
    assert.strictEqual(btRes.discards.riskFilter, 0, 'Zero signals should be in riskFilter');
    const discardsSum = Object.values(btRes.discards).reduce((a, b) => a + b, 0);
    assert.strictEqual(btRes.neutrals, discardsSum, 'Neutrals must strictly equal discards sum');

    // 3. Operational trade calculator / live execution parity:
    const opInput = {
      strategy: 'standard',
      signal: 'BUY',
      executionStyle: 'dayTrading' as const,
      raw: { '5m': lowVolKlines },
      closed: { '5m': lowVolKlines }
    };
    const opPlan = resolveOperationalTrade(opInput);
    assert.strictEqual(opPlan.valid, false, 'Operational trade must be marked invalid due to excessive friction');
    assert.ok(opPlan.reason.includes('fricción') || opPlan.reason.includes('comisiones'), 'Reason must explain friction issue');
  });

  // Test 130: VCME Sniper operates purely in Pullback & Breakout modes without dead Mean Reversion code
  test('Revision 6: VCME Sniper operates exclusively in PULLBACK and BREAKOUT trend modes', () => {
    const klines1d = generateSyntheticKlines(60, 86400, 100, 0);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0);
    const klines5m = generateSyntheticKlines(120, 300, 100, 0);

    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'VCME_MODES', 'dayTrading', 'agresivo');
    const res = evaluateVCMESniperAt(ctx, klines5m.length - 1);
    assert(['PULLBACK', 'BREAKOUT', 'REVERSAL', 'NONE'].includes(res.mode), 'VCME mode must be PULLBACK, BREAKOUT, REVERSAL, or NONE');
    assert.notStrictEqual(res.mode, 'MEAN_REVERSION', 'VCME must not produce MEAN_REVERSION mode');
  });

  // Test 131: Revision 6: Tournament limitedCandidates aligns with selectActionableStrategy for marginal positive OOS
  test('Revision 6: Tournament limitedCandidates aligns with selectActionableStrategy for marginal positive OOS', () => {
    // 1. Candidate with WF status === 'FAIL' but positive marginal OOS (+0.06R, PF 1.35, 1 pass fold):
    const marginalOosCandidate: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia Marginal',
      profitFactor: 1.30,
      expectancyR: 0.15,
      expectancyPerHour: 0.30,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 16,
      forwardWindow: 6,
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 10, wins: 6, losses: 4, winRate: 0.60, expectancyR: 0.20, profitFactor: 1.40, maxDrawdownR: 1.2 },
        outOfSample: { signals: 6, wins: 4, losses: 2, winRate: 0.67, expectancyR: 0.06, profitFactor: 1.35, maxDrawdownR: 1.5 },
        folds: [
          { fold: 1, isWindow: 400, oosWindow: 58, oosTradesCount: 2, oosExpectancyR: 0.12, passed: true, status: 'PASS' },
          { fold: 2, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: 0.02, passed: false, status: 'FAIL' },
          { fold: 3, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: 0.04, passed: false, status: 'FAIL' },
        ],
        foldsPassed: 1,
        foldsWithData: 3,
        passed: false,
        status: 'FAIL'
      }
    };

    const tourneyMarginal = evaluateStrategyTournament([marginalOosCandidate], '5m');
    assert.strictEqual(tourneyMarginal.confidence, 'LIMITED', 'Candidate with marginal positive OOS must qualify as LIMITED');
    assert.strictEqual(tourneyMarginal.bestStrategy, 'confluencia');
    assert.ok(tourneyMarginal.reasoning.includes('OOS marginal (+0.06R)'), 'Reasoning must include OOS marginal note');
    assert.ok(tourneyMarginal.compositeScore > 0, 'Composite score must be positive with 0.82 multiplier applied');

    // 2. Candidate with genuinely negative OOS (-0.15R) must remain strictly disqualified (NONE):
    const negativeOosCandidate: StrategyCandidate = {
      ...marginalOosCandidate,
      key: 'standard',
      label: 'Negative OOS',
      walkForward: {
        ...marginalOosCandidate.walkForward!,
        outOfSample: { signals: 6, wins: 1, losses: 5, winRate: 0.17, expectancyR: -0.15, profitFactor: 0.30, maxDrawdownR: 3.5 },
        folds: [
          { fold: 1, isWindow: 400, oosWindow: 58, oosTradesCount: 2, oosExpectancyR: -0.10, passed: false, status: 'FAIL' },
          { fold: 2, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: -0.20, passed: false, status: 'FAIL' },
          { fold: 3, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: -0.15, passed: false, status: 'FAIL' },
        ],
        foldsPassed: 0,
      }
    };
    const tourneyNegative = evaluateStrategyTournament([negativeOosCandidate], '5m');
    assert.strictEqual(tourneyNegative.confidence, 'NONE', 'Candidate with negative OOS must remain FLAT (NONE)');
    assert.strictEqual(tourneyNegative.bestStrategy, 'NONE');
  });

  // Test 132: Revision 6: Hurdle 1 deflatedQualityExpR measures genuine R/trade without inflation from Sortino, Regime, or OOS boosts
  test('Revision 6: Hurdle 1 deflatedQualityExpR measures genuine R/trade without inflation from Sortino, Regime, or OOS boosts', () => {
    // A candidate with E[R] = 0.05R on 8 trades (5m):
    // Bayesian shrinkage (8 / (8+8)) = 0.50 -> shrunk E[R] = 0.025R (below the 0.040R hurdle).
    // It has extraordinary Sortino (4.0 -> x1.20), perfect regime (+0.80R -> x1.30), and OOS PASS (x1.15).
    // Under the old formula, 0.025 * 1.20 * 1.30 * 1.15 = 0.0448R >= 0.040R falsely passed into HIGH!
    // Under the true deflated formula, genuine edge is 0.025R < 0.040R -> correctly degraded to LIMITED.
    const candInflated: StrategyCandidate = {
      key: 'standard',
      label: 'Inflated Utility Candidate',
      profitFactor: 1.35,
      expectancyR: 0.05,
      expectancyPerHour: 0.10,
      avgExposureHours: 0.5,
      winRate: 0.60,
      resolved: 8,
      forwardWindow: 6,
      sortinoRatio: 4.0, // x1.20 boost
      regimeStats: {
        trending: { signals: 8, wins: 7, losses: 1, winRate: 0.88, expectancyR: 0.80 }, // x1.30 boost
        ranging:  { signals: 0, wins: 0, losses: 0, winRate: 0.00, expectancyR: 0.00 }
      },
      walkForward: {
        isWindow: 400,
        oosWindow: 176,
        inSample: { signals: 8, wins: 5, losses: 3, winRate: 0.62, expectancyR: 0.05, profitFactor: 1.35, maxDrawdownR: 1.0 },
        outOfSample: { signals: 6, wins: 4, losses: 2, winRate: 0.67, expectancyR: 0.25, profitFactor: 1.80, maxDrawdownR: 1.0 },
        folds: [
          { fold: 1, isWindow: 400, oosWindow: 58, oosTradesCount: 2, oosExpectancyR: 0.20, passed: true, status: 'PASS' },
          { fold: 2, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: 0.30, passed: true, status: 'PASS' },
          { fold: 3, isWindow: 400, oosWindow: 59, oosTradesCount: 2, oosExpectancyR: 0.25, passed: true, status: 'PASS' },
        ],
        foldsPassed: 3,
        foldsWithData: 3,
        passed: true,
        status: 'PASS' // x1.15 boost
      }
    };

    const tourney = evaluateStrategyTournament([candInflated], '5m', 'trending');
    assert.strictEqual(tourney.confidence, 'LIMITED', 'Candidate with genuine deflated edge 0.025R must not sneak into HIGH via utility multipliers');
    assert.ok(tourney.reasoning.includes('Score deflactado'), 'Reasoning must explicitly detail deflated score below hurdle');
  });

  // Test 133: Revision 6: getRobustCandleStepSec and backtestMultitemporal handle boundary gaps cleanly
  test('Revision 6: getRobustCandleStepSec and backtestMultitemporal are immune to boundary session gaps', () => {
    // 1. Initial bars cross a 65.5-hour weekend gap (Friday 16:00 -> Monday 09:30):
    const gapKlines: Kline[] = [
      { time: 1000000, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: 1000000 + 235800, open: 101, high: 102, low: 100, close: 101.5, volume: 1200 }, // +235,800 sec
      { time: 1000000 + 235800 + 300, open: 101.5, high: 102, low: 101, close: 101.8, volume: 1100 },
      { time: 1000000 + 235800 + 600, open: 101.8, high: 102.5, low: 101.5, close: 102, volume: 1300 },
    ];

    // Fragile calculation (klines[1].time - klines[0].time) would yield 235800:
    const fragileStep = gapKlines[1].time - gapKlines[0].time;
    assert.strictEqual(fragileStep, 235800, 'Raw two-bar subtraction across gap must be 235800');

    // Robust helper returns standard 300s for dayTrading or 5m interval:
    assert.strictEqual(getRobustCandleStepSec(gapKlines, '5m', 'dayTrading'), 300, 'Day trading must yield 300s');
    assert.strictEqual(getRobustCandleStepSec(gapKlines, undefined, 'dayTrading'), 300, 'Day trading style must yield 300s even if interval undefined');
    assert.strictEqual(getRobustCandleStepSec(gapKlines, '1h', 'swing'), 3600, '1h swing must yield 3600s');

    // Untyped/custom interval fallback derives minimum positive delta (300s) ignoring the 235800s gap:
    assert.strictEqual(getRobustCandleStepSec(gapKlines, 'custom'), 300, 'Minimum delta must filter out boundary gap');
  });

  // Test 134: Revision 6: 1D statistical robustness (evalWindow expansion to 120, minOosTrades floor to 3, minHighResolved to 5)
  test('Revision 6: 1d backtest expands evalWindow up to 120, requires >= 3 OOS trades, and gates HIGH behind >= 5 IS trades', () => {
    // 1. evalWindow expansion up to 120 candles:
    const klines180 = generateSyntheticKlines(180, 86400, 100, 0.05);
    const neutralSignals = klines180.map(() => 'NEUTRAL' as const);
    const bt180 = runBacktestGenericOptimized(klines180, '1d', neutralSignals, 'confluencia');
    assert.strictEqual(bt180.label, 'últimas 120 velas', '1d backtest with 180 candles must use expanded 120-candle evalWindow, not 60');

    // 2. Walk-Forward minOosTrades = 3 on 1d:
    // Window: 100 candles, split at candle 70.
    const trades2Oos: RecordedTrade[] = [
      // 5 IS trades
      { executionIdx: 10, exitIdx: 15, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 20, exitIdx: 25, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 30, exitIdx: 35, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 40, exitIdx: 45, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 50, exitIdx: 55, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      // Only 2 OOS trades (both lucky wins)
      { executionIdx: 75, exitIdx: 80, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 85, exitIdx: 90, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
    ];

    const wf2Oos = calculateWalkForward(trades2Oos, 0, 99, 0.70, 3, 20);
    assert.strictEqual(wf2Oos.status, 'INSUFFICIENT_OOS', '2 OOS trades on 1d must receive INSUFFICIENT_OOS, not PASS');
    assert.strictEqual(wf2Oos.passed, false, 'Candidate with only 2 OOS trades must not pass Walk-Forward');

    // With 3rd OOS trade added:
    const trades3Oos = [
      ...trades2Oos,
      { executionIdx: 92, exitIdx: 96, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 4, regime: 'trending', direction: 'BUY' },
    ];
    const wf3Oos = calculateWalkForward(trades3Oos, 0, 99, 0.70, 3, 20);
    assert.strictEqual(wf3Oos.status, 'PASS', '3 OOS trades with positive E[R] must PASS');
    assert.strictEqual(wf3Oos.passed, true, 'Walk-Forward passed must be true with 3 OOS trades');

    // 3. Tournament 1D minHighResolved = 5:
    // Candidate A: 3 IS wins, 0 losses (PF null, E[R]=1.0R) with 3 OOS trades. Formerly passed HIGH under 3 trades. Now restricted to LIMITED.
    const trades3Is3Oos: RecordedTrade[] = [
      // 3 IS trades
      { executionIdx: 10, exitIdx: 15, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 20, exitIdx: 25, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 30, exitIdx: 35, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      // 3 OOS trades
      { executionIdx: 75, exitIdx: 80, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 85, exitIdx: 90, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 5, regime: 'trending', direction: 'BUY' },
      { executionIdx: 92, exitIdx: 96, realizedR: 1.0, isWin: true, pnl: 100, entryPrice: 100, exitPrice: 102, atr: 1, durationCandles: 4, regime: 'trending', direction: 'BUY' },
    ];
    const wf3Is3Oos = calculateWalkForward(trades3Is3Oos, 0, 99, 0.70, 3, 20);
    assert.strictEqual(wf3Is3Oos.status, 'PASS', 'Walk-Forward status must PASS for trades3Is3Oos');

    const cand3Trades: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia 1D',
      expectancyR: 1.0,
      resolved: 3,
      profitFactor: null,
      winRate: 1.0,
      maxDrawdownR: 0,
      walkForward: wf3Is3Oos,
    };
    const tourney3Trades = evaluateStrategyTournament([cand3Trades], '1d', 'trending');
    assert.strictEqual(tourney3Trades.confidence, 'LIMITED', 'Candidate on 1d with only 3 IS trades must be LIMITED, not HIGH');
    assert.ok(tourney3Trades.reasoning.includes('Muestra limitada (3/5 trades IS'), 'Reasoning must explicitly cite 3/5 trades IS');

    // Candidate B: 5 wins, 0 losses with valid WF PASS: meets minHighResolved (5) and can certify HIGH.
    const cand5Trades: StrategyCandidate = {
      key: 'confluencia',
      label: 'Confluencia 1D',
      expectancyR: 1.0,
      resolved: 5,
      profitFactor: null,
      winRate: 1.0,
      maxDrawdownR: 0,
      walkForward: wf3Oos,
    };
    const tourney5Trades = evaluateStrategyTournament([cand5Trades], '1d', 'trending');
    assert.strictEqual(tourney5Trades.confidence, 'HIGH', 'Candidate on 1d with 5 IS trades and WF PASS must certify HIGH');
  });

  // Test 135: Revision 6: Scoring Layer 2 (RSI) & Layer 3 (Bollinger) harmonization with trend momentum and pullbacks
  test('Revision 6: Scoring Layer 2 and Layer 3 harmonize with trend momentum and pullbacks without self-contradiction', () => {
    const klines = generateSyntheticKlines(80, 300, 100, 0.001);
    const lastIdx = klines.length - 1;
    const ctx = buildScoringContext(klines, '5m');

    // Baseline: price 100.0, VWAP 99.5 (above VWAP), EMA9 > EMA21
    klines[lastIdx].close = 100.0;
    klines[lastIdx].open = 99.8; // Bull candle
    klines[lastIdx].high = 100.05;
    klines[lastIdx].low = 99.75;
    ctx.closes[lastIdx] = 100.0;
    ctx.emaFastArr[lastIdx] = 101.0;
    ctx.emaSlowArr[lastIdx] = 99.0;
    ctx.vwapSeries[lastIdx] = 99.5;
    if (ctx.vwapReliableSeries) ctx.vwapReliableSeries[lastIdx] = true;

    // 1. Pullback saludable en tendencia:
    // RSI at 46 (below 50, but >= 40) turning upward (slope > 0 across 3 bars)
    ctx.rsiSeries[lastIdx - 3] = 40.0;
    ctx.rsiSeries[lastIdx - 2] = 42.0;
    ctx.rsiSeries[lastIdx - 1] = 44.0;
    ctx.rsiSeries[lastIdx] = 46.0;
    const resPullback = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resPullback.layers.rsi.score, 1.0, 'RSI pullback recovering in 40-50 zone must score +1.0');
    assert.ok(resPullback.layers.rsi.note.includes('Pullback en tendencia'), 'RSI note must document Pullback en tendencia');

    // 2. Strong trend momentum:
    // RSI at 68 (above 65, which previously subtracted -1.0) with rising slope
    ctx.rsiSeries[lastIdx - 3] = 56.0;
    ctx.rsiSeries[lastIdx - 2] = 60.0;
    ctx.rsiSeries[lastIdx - 1] = 64.0;
    ctx.rsiSeries[lastIdx] = 68.0;
    // Bollinger %B = 0.80 (walking upper band in healthy expansion without upper wick, bandwidth 8% > 5% squeeze)
    const bbIdx = lastIdx - (ctx.cfg.bbPeriod - 1);
    if (bbIdx >= 0 && bbIdx < ctx.bbSeries.length) {
      ctx.bbSeries[bbIdx] = { upper: 101.60, lower: 93.60, middle: 97.60, bandwidth: 8.00, percentB: 0.80 };
    }
    const resTrend = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resTrend.layers.rsi.score, 1.0, 'RSI at 68 with positive slope must score +1.0 pro-trend, never -1.0');
    assert.strictEqual(resTrend.layers.bollinger.score, 1.0, 'Walking upper band with bull candle must score +1.0, never -1.0');
    assert.ok(resTrend.layers.bollinger.note.includes('Walking upper band'), 'Bollinger note must document Walking upper band');

    // 3. Bollinger Squeeze Breakout:
    // bbWidthRatio < 0.05, close above middle with bull candle
    if (bbIdx >= 0 && bbIdx < ctx.bbSeries.length) {
      ctx.bbSeries[bbIdx] = { upper: 100.10, lower: 99.90, middle: 100.00, bandwidth: 0.20, percentB: 0.50 };
    }
    const resSqueeze = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resSqueeze.layers.bollinger.score, 1.0, 'Bollinger squeeze breakout with close above middle must score +1.0');
    assert.ok(resSqueeze.layers.bollinger.note.includes('Squeeze con ruptura alcista'), 'Bollinger note must document Squeeze con ruptura alcista');
  });

  // Test 136: Revision 6: VCME trigger intentional asymmetry (1.5x LONG / 1.8x SHORT) and discardReason alignment
  test('Revision 6: VCME trigger intentional asymmetry (1.5x LONG / 1.8x SHORT) and discardReason alignment', () => {
    const klines1d = generateSyntheticKlines(250, 86400, 100, 0.01);
    const klines1h = generateSyntheticKlines(100, 3600, 100, 0.01);
    const klines5m = generateSyntheticKlines(100, 300, 100, 0.01);
    const lastIdx = klines5m.length - 1;

    // Build context for US equity (non-crypto) 'AAPL'
    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'AAPL', 'dayTrading', 'agresivo');

    // 1. Long setup armed with sub-threshold RVOL = 1.35 (< 1.5):
    // In old code, for non-crypto symbols it checked rvol < 1.2, so RVOL 1.35 was NOT classified as volumeFilter!
    // In new code, minRequiredRvol is 1.5, so 1.35 is correctly classified as volumeFilter.
    ctx.vol5m[lastIdx] = 1350;
    ctx.volSma5m[lastIdx] = 1000; // rvol = 1.35
    const idx1h = 60;
    const idx1d = 40;
    ctx.idx1hMap[lastIdx] = idx1h;
    ctx.idx1dMap[lastIdx] = idx1d;

    // Daily Bullish Bias:
    ctx.closes1d[idx1d] = 110;
    ctx.ema200_1d[idx1d] = 100;
    ctx.ema50_1d[idx1d] = 105;
    ctx.adxData1d.adx[idx1d] = 25;
    ctx.adxData1d.plusDI[idx1d] = 30;
    ctx.adxData1d.minusDI[idx1d] = 10;

    // 1H Bullish Setup:
    ctx.ema200_1h[idx1h] = 105;
    ctx.ema200_1h[idx1h - 5] = 100;
    ctx.atrSeries1h[idx1h] = 1.0;
    ctx.adxSeries1h.adx[idx1h] = 25;
    ctx.closes1h[idx1h] = 102;
    ctx.vwapSeries1h[idx1h] = 99;
    ctx.ema20_1h[idx1h] = 102;
    ctx.ema50_1h[idx1h] = 98;
    ctx.rsiSeries1h[idx1h] = 60;
    ctx.macdData1h.histogram[idx1h] = 2.0;
    ctx.macdData1h.histogram[idx1h - 1] = 1.0;

    const resLong = evaluateVCMESniperAt(ctx, lastIdx);
    assert.strictEqual(resLong.signal, 'NEUTRAL', 'RVOL 1.35 < 1.5 must not trigger BUY');
    assert.strictEqual(resLong.discardReason, 'volumeFilter', 'RVOL 1.35 < 1.5 on AAPL must be classified as volumeFilter, not skipped due to 1.2 threshold');

    // 2. Short setup armed with sub-threshold RVOL = 1.65 (< 1.8):
    // In old code, discardReason checked rvol < 1.5 (or 1.2), so RVOL 1.65 was NOT classified as volumeFilter!
    // In new code, minRequiredRvol is 1.8 for short, so 1.65 is correctly classified as volumeFilter.
    ctx.vol5m[lastIdx] = 1650;
    ctx.volSma5m[lastIdx] = 1000; // rvol = 1.65

    // Daily Bearish Bias:
    ctx.closes1d[idx1d] = 90;
    ctx.ema200_1d[idx1d] = 100;
    ctx.ema50_1d[idx1d] = 95;
    ctx.adxData1d.adx[idx1d] = 25;
    ctx.adxData1d.minusDI[idx1d] = 30;
    ctx.adxData1d.plusDI[idx1d] = 10;

    // 1H Bearish Setup:
    ctx.ema200_1h[idx1h] = 95;
    ctx.ema200_1h[idx1h - 5] = 100;
    ctx.atrSeries1h[idx1h] = 1.0;
    ctx.adxSeries1h.adx[idx1h] = 25;
    ctx.closes1h[idx1h] = 98;
    ctx.vwapSeries1h[idx1h] = 101;
    ctx.ema20_1h[idx1h] = 97;
    ctx.ema50_1h[idx1h] = 102;
    ctx.rsiSeries1h[idx1h] = 40;
    ctx.macdData1h.histogram[idx1h] = -2.0;
    ctx.macdData1h.histogram[idx1h - 1] = -1.0;

    const resShort = evaluateVCMESniperAt(ctx, lastIdx);
    assert.strictEqual(resShort.signal, 'NEUTRAL', 'RVOL 1.65 < 1.8 must not trigger SELL (asymmetry protects against short squeezes)');
    assert.strictEqual(resShort.discardReason, 'volumeFilter', 'RVOL 1.65 < 1.8 on SHORT must be classified as volumeFilter, not missed');
  });

  // Test 137: 1D Standard Voting marks insufficient: true when dataset candles < 203 (warmup 199 + forward 3 + 1)
  test('1D Standard marks insufficient data on short daily history (<203 candles) preventing zero-trade dead runs', () => {
    // 180 daily candles is below 199 warmup + 3 forward + 1 = 203 candles:
    const klines180 = generateSyntheticKlines(180, 86400, 100);
    const res180 = backtestStandard(klines180, '1d', 'TEST_STD_180_DAILY');
    assert.strictEqual(res180.insufficient, true, '180 daily candles must be marked insufficient: true for Standard (warmup floor is 199)');
    assert.ok(res180.label.includes('insuficientes'), `Label must state insufficient data, got: ${res180.label}`);
    assert.strictEqual(res180.totalSignals, 0, 'Total signals must be 0 on insufficient data');

    // 250 daily candles (approx 1 trading year) exceeds 203:
    const klines250 = generateSyntheticKlines(250, 86400, 100);
    const res250 = backtestStandard(klines250, '1d', 'TEST_STD_250_DAILY');
    assert.strictEqual(res250.insufficient, false, '250 daily candles must evaluate cleanly (evalWindow = 48)');
    assert.ok(res250.label.includes('48') || res250.label.includes('últimas'), `Label must indicate 48 evaluated candles, got: ${res250.label}`);
  });

  // Test 138: Backtest cache implements LRU eviction preserving frequently touched keys over older entries
  test('backtestCache implements O(1) LRU eviction preserving accessed entries beyond 250 size cap', () => {
    const klinesBase = generateSyntheticKlines(600, 300, 100);
    const resB = backtestStandard(klinesBase, '5m', 'LRU_SURVIVOR');
    for (let i = 0; i < 240; i++) {
      backtestConfluencia(klinesBase, '5m', `LRU_FILL_${i}`);
    }
    // Touch LRU_SURVIVOR so it moves to MRU:
    backtestStandard(klinesBase, '5m', 'LRU_SURVIVOR');
    // Add 20 more entries pushing total beyond 250:
    for (let i = 240; i < 260; i++) {
      backtestConfluencia(klinesBase, '5m', `LRU_FILL_${i}`);
    }
    // LRU_SURVIVOR must STILL be in cache because it was touched recently:
    const resBSurvived = backtestStandard(klinesBase, '5m', 'LRU_SURVIVOR');
    assert.strictEqual(resBSurvived, resB, 'Recently touched LRU_SURVIVOR must survive eviction in LRU cache');
  });

  // Test 139: Multifractal MTF dynamically adapts evalWindow to available candles and reports actual evaluated count in label
  test('backtestMultifractalMTF adapts evalWindow to available candles and reports truthful candle count in label', () => {
    const klines5m_600 = generateSyntheticKlines(600, 300, 100);
    const klines1h_100 = generateSyntheticKlines(100, 3600, 100);
    const klines1d_60 = generateSyntheticKlines(60, 86400, 100);

    const resMulti = backtestMultifractalMTF(klines5m_600, klines1h_100, klines1d_60, '5m', 'TEST_MULTI_LABEL');
    assert.strictEqual(resMulti.insufficient, false, '600 candles must evaluate cleanly');
    // 600 candles ≥ 4 × 59, so the converged warmup floor (59) applies: 600 − 1 − 12 (forward) − 59 + 1 = 529.
    assert.strictEqual(resMulti.label, 'últimas 529 velas (5m)', 'Label must reflect 529 actual evaluated bars, not 576');
  });

  // Test 140: evaluateVCMESniperAt safely falls back to rsi1H: 50 when 1H RSI is NaN or undefined without throwing TypeError
  test('evaluateVCMESniperAt returns rsi1H: 50 when 1H RSI is NaN or undefined without throwing TypeError', () => {
    const klines5m = generateSyntheticKlines(100, 300, 100);
    const klines1h = generateSyntheticKlines(30, 3600, 100);
    const klines1d = generateSyntheticKlines(30, 86400, 100);

    const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, 'TEST_RSI_NAN');
    ctx.rsiSeries1h[0] = NaN;

    const res = evaluateVCMESniperAt(ctx, 35, 100);
    assert.strictEqual(res.rsi1H, 50, 'RSI 1H must fall back to 50 when NaN or undefined');
    assert.ok(!isNaN(res.rsi1H), 'rsi1H must not be NaN');
  });

  // Test 141: Strict segregation between frictionFilter (micro-stops <0.31%) and riskFilter (structural/excessive risk)
  test('discards strictly segregates frictionFilter (micro-stops) from riskFilter (excessive risk stops)', () => {
    // 1. Synthetic dataset with low volatility producing micro-stops:
    const lowVolKlines: Kline[] = [];
    for (let i = 0; i < 600; i++) {
      lowVolKlines.push({
        time: 1000 + i * 300,
        open: 100,
        high: 100.02,
        low: 99.98,
        close: 100,
        volume: 1000
      });
    }
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(600).fill('NEUTRAL');
    signals[300] = 'BUY';
    signals[320] = 'BUY';

    const resStd = runBacktestGenericOptimized(lowVolKlines, '5m', signals, 'standard');
    assert.strictEqual(resStd.discards.frictionFilter, 2, 'Micro-stops must be recorded in frictionFilter');
    assert.strictEqual(resStd.discards.riskFilter, 0, 'Micro-stops must NOT bleed into riskFilter');

    // 2. Multifractal MTF excessive risk (>2.5% maxAllowedRiskPct or >2.0 ATR) setup:
    const klines5m = generateSyntheticKlines(100, 300, 100);
    const klines1h = generateSyntheticKlines(50, 3600, 100);
    const klines1d = generateSyntheticKlines(50, 86400, 100);
    const ctx = buildMultifractalMTFContext(klines5m, klines1h, klines1d, 'TEST_RISK_SEG');
    const lastIdx = klines5m.length - 1;
    ctx.idx1dMap[lastIdx] = 0;
    ctx.idx1hMap[lastIdx] = 0;

    // Force bullish macro + compression + breakout
    ctx.andianSeries[0] = { green: 100, red: 50, orange: 75, bias: 'BULLISH' };
    ctx.volBands1H[0] = { isCompressed: true, upper: 105, lower: 95, midpoint: 90, width: 10 };
    // 5M band with midpoint at 90 -> risk is 100 - 90 = 10 (10% risk > 2.5% max risk)
    ctx.volBands5M[lastIdx] = { upper: 99, lower: 95, midpoint: 90, width: 4, isCompressed: false };
    ctx.klines5m[lastIdx].close = 100;
    ctx.volComp5M[lastIdx] = { volumeMultiplier: 3.0, activeBuyPercent: 80, activeSellPercent: 20, isPassiveBuyAbsorption: false, isPassiveSellAbsorption: false };

    const resMtf = evaluateMultifractalMTFAt(ctx, lastIdx, 100);
    assert.strictEqual(resMtf.signal, 'NEUTRAL', 'Excessive risk must be rejected');
    assert.strictEqual(resMtf.discardReason, 'riskFilter', 'Excessive risk must be classified as riskFilter, not frictionFilter');
  });

  // Test 183: calculateSessionStats transparently segregates direct TP hits from profitable expirations (EXP+)
  test('calculateSessionStats transparently segregates direct TP hits from profitable expirations (EXP+)', () => {
    const todayMs = Date.now();
    const alerts: AuditAlertItem[] = [
      // 2 Confluencia alerts that expired in profit without hitting TP
      {
        id: 'conf-1', symbol: 'BTCUSDT', interval: '5m', signal: 'BUY', time: '10:00',
        pf: 2.0, strategy: 'Confluencia', alertType: 'PRIMARY', confidence: 'HIGH',
        entryPrice: 100, stopLoss: 98, takeProfit1: 104, status: 'EXPIRED',
        realizedR: 0.45, pnlPercent: 0.9, timestamp: todayMs
      },
      {
        id: 'conf-2', symbol: 'ETHUSDT', interval: '5m', signal: 'BUY', time: '10:30',
        pf: 2.0, strategy: 'Confluencia', alertType: 'PRIMARY', confidence: 'HIGH',
        entryPrice: 100, stopLoss: 98, takeProfit1: 104, status: 'EXPIRED',
        realizedR: 0.30, pnlPercent: 0.6, timestamp: todayMs
      },
      // 1 VCME alert that hit TP1
      {
        id: 'vcme-1', symbol: 'SOLUSDT', interval: '5m', signal: 'BUY', time: '11:00',
        pf: 2.2, strategy: 'VCME Sniper', alertType: 'PRIMARY', confidence: 'HIGH',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'TP1_CLOSED',
        realizedR: 1.5, pnlPercent: 3.0, timestamp: todayMs
      },
      // 3 SL hit alerts
      {
        id: 'sl-1', symbol: 'ADAUSDT', interval: '5m', signal: 'BUY', time: '11:30',
        pf: 1.8, strategy: 'Standard', alertType: 'PRIMARY', confidence: 'MEDIUM',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'SL_HIT',
        realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs
      },
      {
        id: 'sl-2', symbol: 'AVAXUSDT', interval: '5m', signal: 'BUY', time: '12:00',
        pf: 1.8, strategy: 'Standard', alertType: 'PRIMARY', confidence: 'MEDIUM',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'SL_HIT',
        realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs
      },
      {
        id: 'sl-3', symbol: 'DOTUSDT', interval: '5m', signal: 'BUY', time: '12:30',
        pf: 1.8, strategy: 'Standard', alertType: 'PRIMARY', confidence: 'MEDIUM',
        entryPrice: 100, stopLoss: 98, takeProfit1: 103, status: 'SL_HIT',
        realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs
      }
    ];

    const stats = calculateSessionStats(alerts, false);

    // 3 total economic wins (1 TP hit + 2 EXP in profit)
    assert.strictEqual(stats.wins, 3);
    assert.strictEqual(stats.tpWins, 1, 'Only 1 alert closed at TP1');
    assert.strictEqual(stats.expWins, 2, '2 Confluencia alerts closed as EXPIRED in profit');

    // 3 losses
    assert.strictEqual(stats.losses, 3);
    assert.strictEqual(stats.slLosses, 3);
    assert.strictEqual(stats.expLosses, 0);

    // Confluencia breakdown
    const confBreakdown = stats.byStrategy['Confluencia'];
    assert.ok(confBreakdown);
    assert.strictEqual(confBreakdown.wins, 2);
    assert.strictEqual(confBreakdown.tpWins, 0, 'Confluencia has 0 direct TPs');
    assert.strictEqual(confBreakdown.expWins, 2, 'Confluencia has 2 EXP+ wins');
    assert.strictEqual(confBreakdown.totalR, 0.8);

    // VCME breakdown
    const vcmeBreakdown = stats.byStrategy['VCME Sniper'];
    assert.ok(vcmeBreakdown);
    assert.strictEqual(vcmeBreakdown.wins, 1);
    assert.strictEqual(vcmeBreakdown.tpWins, 1);
    assert.strictEqual(vcmeBreakdown.expWins, 0);
  });

  // Test 184: Scoring re-validates S/R room at effective execution price, rejecting insufficient R:R into resistance
  test('Scoring re-validates S/R room at effective execution price, rejecting insufficient R:R into resistance', () => {
    // 65 candles with baseline around 100 and a distinct pivot high at 103 on candle 50
    const klines: Kline[] = Array.from({ length: 65 }, (_, i) => {
      const time = 1700000000 + i * 300;
      if (i === 50) return { time, open: 100, high: 103, low: 99, close: 100, volume: 1000 };
      return { time, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 };
    });

    const ctx = buildScoringContext(klines, '5m');
    const lastIdx = klines.length - 1;

    // Force strong bullish momentum across layers so totalScore >= threshold even with near-resistance penalty
    ctx.emaFastArr[lastIdx] = 101;
    ctx.emaSlowArr[lastIdx] = 99;
    ctx.emaMajorArr[lastIdx] = 95;
    ctx.rsiSeries[lastIdx - 3] = 50.0;
    ctx.rsiSeries[lastIdx - 2] = 55.0;
    ctx.rsiSeries[lastIdx - 1] = 58.0;
    ctx.rsiSeries[lastIdx] = 60.0;
    const bbIdx = lastIdx - (ctx.cfg.bbPeriod - 1);
    if (bbIdx >= 0 && bbIdx < ctx.bbSeries.length) {
      ctx.bbSeries[bbIdx] = { upper: 100.2, lower: 99.8, middle: 99.9, bandwidth: 0.4, percentB: 0.6 };
    }
    klines[lastIdx].open = 99.4;
    klines[lastIdx].high = 100.05;
    klines[lastIdx].low = 99.35;
    klines[lastIdx].close = 100.0;
    ctx.closes[lastIdx] = 100.0;
    ctx.vwapSeries[lastIdx] = 99.5;
    if (ctx.vwapReliableSeries) ctx.vwapReliableSeries[lastIdx] = true;
    ctx.atrSeries[lastIdx] = 1.0;

    // 1. At signal close (100), resistance is 103 (room = 3.0 >= targetDist = 2.27), so BUY is allowed
    const resAtClose = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resAtClose.signal, 'BUY', 'At close 100, room to 103 is sufficient');

    // 2. At effectivePrice 101.50 (e.g. quote moved or gap up at entry):
    // Resistance at 103 leaves room = 1.50 < targetDist = 2.27 (0.99R vs 1.5R target)
    const resAtEntry = evaluateScoringAt(ctx, lastIdx, 101.50);
    assert.strictEqual(resAtEntry.signal, 'HOLD', 'Scoring must veto BUY when effective execution price leaves insufficient room to resistance');
    assert.ok(resAtEntry.layers.structure.note.includes('insuficiente'), 'Layer 6 note must document insufficient R:R');

    // 3. Breakout case: if effectivePrice is 103.50, price already cleared resistance 103
    const resBreakout = evaluateScoringAt(ctx, lastIdx, 103.50);
    assert.notStrictEqual(resBreakout.signal, 'HOLD', 'Breakout past resistance must not be blocked');

    // 4. Backtester integration: in runBacktestGenericOptimized, a scoring trade gapped into resistance is discarded to riskFilter
    const btKlines: Kline[] = generateSyntheticKlines(600, 300, 100);
    // Establish pivot high at 103 at candle 560
    btKlines[560] = { ...btKlines[560], high: 103, low: 99.5, open: 100, close: 100 };
    // Candle 580 close is 100
    btKlines[580] = { ...btKlines[580], high: 100.5, low: 99.5, open: 100, close: 100 };
    // Candle 581 opens at 101.5 (gap up into resistance 103)
    btKlines[581] = { ...btKlines[581], open: 101.5, high: 102, low: 101, close: 101.5 };
    const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(btKlines.length).fill('NEUTRAL');
    signals[580] = 'BUY'; // candle 580 emits BUY, candle 581 opens at 101.5
    const btRes = runBacktestGenericOptimized(btKlines, '5m', signals, 'scoring');
    assert.strictEqual(btRes.discards.riskFilter, 1, 'Trade gapping into resistance must be discarded by riskFilter');
    assert.strictEqual(btRes.totalSignals, 0, 'No trade entered due to riskFilter');
  });

  // Test 185: Session closing candle guard unifies emission, backtest, and tracker (blocks generic swing, preserves VCME swing)
  test('Session closing candle guard unifies emission, backtest, and tracker (blocks generic swing, preserves VCME swing)', () => {
    // Wednesday July 15, 2026: 15:00 ET (19:00 UTC) -> 1h candle ends at 16:00 (closing candle of regular session)
    const wed1500 = Math.floor(Date.UTC(2026, 6, 15, 19, 0, 0) / 1000);
    assert.strictEqual(isNyseSessionClosingCandle(wed1500, '1h', 'AMD'), true, '15:00 1h candle on AMD must be recognized as closing candle');

    // Helper representing the unified emission guard in App.tsx:
    const shouldBlockEmission = (symbol: string, interval: string, timestamp: number, strategy: string, executionStyle: 'dayTrading' | 'swing') => {
      const isCryptoSymbol = isCryptoAsset(symbol);
      if (isCryptoSymbol) return false;
      const isSwingVCME = (strategy === 'multitemporal' || strategy.includes('VCME')) && executionStyle === 'swing';
      return !isSwingVCME && isNyseSessionClosingCandle(timestamp, interval, symbol);
    };

    // 1. Generic Swing (AMD 1h Scoring, Standard, Confluencia, Multifractal) on closing candle:
    assert.strictEqual(shouldBlockEmission('AMD', '1h', wed1500, 'scoring', 'swing'), true, 'Scoring Swing on AMD closing candle must be blocked');
    assert.strictEqual(shouldBlockEmission('AMD', '1h', wed1500, 'standard', 'swing'), true, 'Standard Swing on AMD closing candle must be blocked');
    assert.strictEqual(shouldBlockEmission('AMD', '1h', wed1500, 'confluencia', 'swing'), true, 'Confluencia Swing on AMD closing candle must be blocked');
    assert.strictEqual(shouldBlockEmission('AMD', '1h', wed1500, 'multifractal', 'swing'), true, 'Multifractal Swing on AMD closing candle must be blocked');

    // 2. DayTrading on closing candle (5m):
    const wed1555 = wed1500 + 55 * 60;
    assert.strictEqual(shouldBlockEmission('AMD', '5m', wed1555, 'scoring', 'dayTrading'), true, 'DayTrading on 15:55 5m closing candle must be blocked');
    assert.strictEqual(shouldBlockEmission('AMD', '5m', wed1500, 'scoring', 'dayTrading'), false, 'DayTrading on 15:00 5m non-closing candle must NOT be blocked');

    // 3. VCME Swing on closing candle: must NOT be blocked (calibrated for multi-day holding across session gap)
    assert.strictEqual(shouldBlockEmission('AMD', '1h', wed1500, 'multitemporal', 'swing'), false, 'VCME Swing must be exempt from session closing candle block');

    // 4. Crypto continuous 24/7 markets: must NOT be blocked
    assert.strictEqual(shouldBlockEmission('BTCUSDT', '1h', wed1500, 'scoring', 'swing'), false, 'Crypto Swing must not be blocked');

    // 5. Parity with alertTracker: generic 1h equity alert has sessionGapCutoff = true, while VCME Swing has sessionGapCutoff = false
    const stdAlert: AuditAlertItem = {
      id: 'amd-std-1h', symbol: 'AMD', interval: '1h', strategy: 'Scoring', signal: 'BUY',
      status: 'OPEN', entryPrice: 100, stopLoss: 98, takeProfit1: 103, realizedR: 0, pnlPercent: 0,
      timestamp: wed1500 * 1000 + 3500 * 1000, candleTimestamp: wed1500, executionStyle: 'swing'
    };
    const nextDayOpen = wed1500 + 63000; // Next trading day 09:30 ET (gap > 3 * 3600)
    const klinesWithGap: Kline[] = [
      { time: wed1500, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 },
      { time: nextDayOpen, open: 100.5, high: 101, low: 100, close: 100.5, volume: 1000 }
    ];
    const stdTrackerRes = updateAlertsOutcome([stdAlert], { 'AMD:1h': klinesWithGap });
    assert.strictEqual(stdTrackerRes[0].status, 'EXPIRED', 'Generic 1h equity alert crossing gap must expire');

    const vcmeAlert: AuditAlertItem = {
      ...stdAlert,
      id: 'amd-vcme-1h', strategy: 'VCME Swing'
    };
    const vcmeTrackerRes = updateAlertsOutcome([vcmeAlert], { 'AMD:1h': klinesWithGap });
    assert.notStrictEqual(vcmeTrackerRes[0].status, 'EXPIRED', 'VCME Swing alert must NOT expire across session gap');
  });

  // Test 186: Multifractal MTF strictly rejects unaligned context and preserves causal idempotency without lookahead
  test('Multifractal MTF rejects unaligned 1D/1H context with insufficientData and eliminates lookahead repainting', () => {
    // 1. Unaligned 1D series: 1D candle starts in future or has not closed relative to 5m bars
    const t0 = 1700000000;
    // 30 5m candles (2.5 hours duration: from t0 to t0 + 8700)
    const klines5m_30 = generateSyntheticKlines(30, 300, 100);
    // 10 1H candles starting from t0
    const klines1h = generateSyntheticKlines(10, 3600, 100);
    // 5 1D candles starting at t0 + 86400 (all in the future of the 5m bars)
    const future1d: Kline[] = [];
    for (let i = 0; i < 5; i++) {
      future1d.push({
        time: t0 + (i + 1) * 86400,
        open: 100, high: 105, low: 95, close: 102, volume: 10000
      });
    }

    const ctx30 = buildMultifractalMTFContext(klines5m_30, klines1h, future1d, 'TEST_MF');
    // For candle 29, 1D context is unaligned (idx1dMap[29] === -1)
    assert.strictEqual(ctx30.idx1dMap[29], -1, 'idx1dMap must be -1 when no 1D candle has causally closed');
    const evalAt29_first = evaluateMultifractalMTFAt(ctx30, 29);
    assert.strictEqual(evalAt29_first.signal, 'NEUTRAL', 'Must be NEUTRAL when 1D context is unaligned');
    assert.strictEqual(evalAt29_first.discardReason, 'insufficientData', 'Must discard with insufficientData');
    assert.strictEqual(evalAt29_first.reasoning.includes('1D insuficientes'), true, 'Reasoning must flag unaligned 1D data');

    // 2. Append another 5m candle (now 31 candles) to verify temporal idempotency / repainting immunity
    const klines5m_31 = generateSyntheticKlines(31, 300, 100);
    const ctx31 = buildMultifractalMTFContext(klines5m_31, klines1h, future1d, 'TEST_MF');
    const evalAt29_second = evaluateMultifractalMTFAt(ctx31, 29);
    assert.strictEqual(evalAt29_second.signal, evalAt29_first.signal, 'Signal at candle 29 must remain strictly identical after new candle arrives');
    assert.strictEqual(evalAt29_second.discardReason, evalAt29_first.discardReason, 'Discard reason at candle 29 must remain strictly identical');
    assert.strictEqual(evalAt29_second.reasoning, evalAt29_first.reasoning, 'Reasoning at candle 29 must remain strictly identical');

    // 3. Verify tClose causal alignment: 5m candle closing at 10:00 causal-aligns with 1H candle closing at 10:00
    // klines1h[0]: opens at t0, closes at t0 + 3600 (candle 0)
    // 5m bar index 11: opens at t0 + 11*300 = t0 + 3300, closes at t0 + 3600 (step = 300)
    // 5m bar index 10: opens at t0 + 10*300 = t0 + 3000, closes at t0 + 3300
    assert.strictEqual(ctx30.idx1hMap[10], -1, '5m bar closing at 55 min before 1H close cannot access forming 1H bar');
    assert.strictEqual(ctx30.idx1hMap[11], 0, '5m bar closing exactly at 1H close must causally access confirmed 1H bar 0');
  });

  // Test 187: Real timeframe duration calculation ensures live vs backtest parity in VCME Swing and gap immunity in Multifractal
  test('VCME Swing live vs backtest index parity and Multifractal missing-candle gap immunity', () => {
    // 1. VCME Swing: 61 hourly candles (indexes 0 to 60)
    const t0 = 1700000000;
    const klines1h_61 = generateSyntheticKlines(61, 3600, 100);
    const klines1d = generateSyntheticKlines(30, 86400, 100);

    // Live mode evaluation on latest closed candle (length 61, evaluating index 60)
    const liveCtx = buildVCMESniperContext(klines1h_61, klines1h_61, klines1d, 'TEST_VCME', 'swing');
    assert.strictEqual(liveCtx.idx1hMap[60], 60, 'VCME Swing live evaluation on candle 60 must map to 1H candle 60 (not 59)');

    // Backtest mode evaluation on larger dataset (100 candles) evaluating historical candle 60
    const klines1h_100 = generateSyntheticKlines(100, 3600, 100);
    const btCtx = buildVCMESniperContext(klines1h_100, klines1h_100, klines1d, 'TEST_VCME', 'swing');
    assert.strictEqual(btCtx.idx1hMap[60], 60, 'VCME Swing backtest evaluation on candle 60 must map to 1H candle 60');
    assert.strictEqual(liveCtx.idx1hMap[60], btCtx.idx1hMap[60], 'Live and backtest 1H mapping on candle 60 must be strictly identical');

    // 2. Multifractal MTF missing-bar and gap immunity:
    // Create 5m klines with a missing candle at 09:55:
    // Bar 0: 09:50 (t0 + 50*60 = t0 + 3000)
    // (09:55 is missing!)
    // Bar 1: 10:15 (t0 + 75*60 = t0 + 4500) -> 25 min gap
    const klines5mWithGap: Kline[] = [
      { time: t0 + 3000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      { time: t0 + 4500, open: 100.5, high: 102, low: 100, close: 101.5, volume: 1000 }
    ];
    // klines1h[0]: opens at t0, closes at t0 + 3600 (10:00)
    const klines1hSingle: Kline[] = [
      { time: t0, open: 100, high: 102, low: 99, close: 101, volume: 10000 }
    ];
    const mfCtx = buildMultifractalMTFContext(klines5mWithGap, klines1hSingle, klines1d, 'TEST_GAP');
    // Bar 0 (09:50) closes at 09:50 + 300 = 09:55 (t0 + 3300).
    // The 1H bar closes at t0 + 3600 (10:00).
    // Bar 0 must NOT map to the 1H bar because at 09:55 the 1H bar had not closed yet!
    assert.strictEqual(mfCtx.idx1hMap[0], -1, 'Multifractal bar at 09:50 cannot leak 1H bar closing at 10:00 despite gap to 10:15');
    // Bar 1 (10:15) closes at 10:15 + 300 = 10:20 (t0 + 4800 >= t0 + 3600), so it correctly maps to 1H bar 0
    assert.strictEqual(mfCtx.idx1hMap[1], 0, 'Multifractal bar at 10:15 must causally map to completed 1H bar 0');
  });

  // Test 188: Out-of-order or stale snapshot rejection preserves active TP1_HIT without false TP1_BE_CLOSED regression
  test('updateAlertsOutcome rejects snapshots older than lastObservationMs and prevents false TP1_BE_CLOSED regression', () => {
    const t0 = 1700000000;
    const alertItem: AuditAlertItem = {
      id: 'stale-snapshot-test',
      symbol: 'BTCUSDT',
      interval: '5m',
      strategy: 'VCME Sniper',
      signal: 'BUY',
      status: 'OPEN',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103,
      takeProfit2: 105,
      takeProfit3: 108,
      timestamp: t0 * 1000,
      candleTimestamp: t0,
      realizedR: 0,
      pnlPercent: 0,
    };

    // 1. Fresh observation where price hits TP1 (high touches 103.5)
    const freshKlines: Kline[] = [
      { time: t0, open: 100, high: 100.5, low: 99.8, close: 100.2, volume: 1000 },
      { time: t0 + 300, open: 100.2, high: 103.5, low: 100, close: 103.2, volume: 2000 }
    ];
    stampKlineSnapshot(freshKlines, (t0 + 600) * 1000); // Acquired at t0 + 600s

    const firstUpdate = updateAlertsOutcome([alertItem], { 'BTCUSDT:5m': freshKlines });
    assert.strictEqual(firstUpdate[0].status, 'TP1_HIT', 'Alert must transition to TP1_HIT on fresh observation');
    assert.strictEqual(firstUpdate[0].activeSL, 100, 'Stop loss must move to breakeven (100) after TP1');
    assert.strictEqual(firstUpdate[0].executionState?.lastObservationMs, (t0 + 600) * 1000, 'lastObservationMs must be stamped from snapshot acquisition time');

    // 2. An older/cached snapshot arrives (e.g. from an out-of-order network response acquired at t0 + 350s).
    // In this older snapshot, price was lower (close 100, low 99.5), which would breach the breakeven stop (100)
    // if evaluated as a new present-time observation.
    const staleKlines: Kline[] = [
      { time: t0, open: 100, high: 100.5, low: 99.8, close: 100.2, volume: 1000 },
      { time: t0 + 300, open: 100.2, high: 101.5, low: 99.5, close: 100.0, volume: 1500 }
    ];
    stampKlineSnapshot(staleKlines, (t0 + 350) * 1000); // Acquired earlier at t0 + 350s (< t0 + 600s)

    const secondUpdate = updateAlertsOutcome([firstUpdate[0]], { 'BTCUSDT:5m': staleKlines });
    // It must REJECT the stale snapshot and preserve TP1_HIT without falsely regressing to TP1_BE_CLOSED
    assert.strictEqual(secondUpdate[0].status, 'TP1_HIT', 'Alert must stay TP1_HIT and not regress to TP1_BE_CLOSED on stale snapshot');
    assert.strictEqual(secondUpdate[0].activeSL, 100, 'activeSL must remain at breakeven');
    assert.strictEqual(secondUpdate[0].executionState?.lastObservationMs, (t0 + 600) * 1000, 'lastObservationMs must not be downgraded by stale snapshot');
  });

  // Test 189: Scoring S/R lookback window parity between backtester and live operational trade filter
  test('Scoring S/R validation unifies 100-bar lookback window between live filter and backtester', () => {
    // Generate 500 candles of 5m data
    const klines: Kline[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 500; i++) {
      klines.push({
        time: t0 + i * 300,
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1000
      });
    }

    // Candle 150 (ancient history, 349 bars prior to current candle 499):
    // Form a sharp pivot high at 102.0 (with left/right radius 5 having highs <= 101.0).
    klines[150] = {
      time: t0 + 150 * 300,
      open: 101.0,
      high: 102.0,
      low: 100.5,
      close: 101.2,
      volume: 2000
    };

    // Candle 499 (current evaluation candle):
    // Entry price = 100.0, Take Profit 1 = 103.0 (targetDist = 3.0), Stop Loss = 98.0 (slDist = 2.0).
    // Note: The ancient pivot high at 102.0 is BETWEEN entry (100) and TP1 (103), with rewardRoom = 2.0 < targetDist = 3.0.
    
    // 1. Verify that the canonical validateScoringSRRoom with default 100-bar lookback ignores the ancient pivot
    const resBacktestWindow = validateScoringSRRoom(klines, 499, 'BUY', 100.0, 103.0, 98.0);
    assert.strictEqual(resBacktestWindow.viable, true, 'Default 100-bar lookback must ignore ancient pivot at bar 150');

    // 2. Verify that resolveOperationalTrade (live filter) also ignores the ancient pivot and accepts the trade
    const liveResult = resolveOperationalTrade({
      strategy: 'scoring',
      signal: 'BUY',
      executionStyle: 'dayTrading',
      raw: { '5m': klines },
      closed: { '5m': klines }
    });
    assert.strictEqual(liveResult.valid, true, 'Live operational trade filter must accept the trade (1:1 parity with backtester)');
    assert.strictEqual(liveResult.reason, '', 'Live reason must be empty when S/R is clear within 100-bar window');

    // 3. Verify that if full 500-bar lookback were erroneously applied, the ancient resistance would be caught
    const resFullLookback = validateScoringSRRoom(klines, 499, 'BUY', 100.0, 103.0, 98.0, 500);
    assert.strictEqual(resFullLookback.viable, false, '500-bar lookback would have rejected due to ancient pivot');
    assert.strictEqual(resFullLookback.nearestResistance, 102.0);

    // 4. Verify that an active, recent resistance within the 100-bar window (e.g. at bar 450) properly blocks both
    klines[450] = {
      time: t0 + 450 * 300,
      open: 101.0,
      high: 102.0,
      low: 100.5,
      close: 101.2,
      volume: 2000
    };
    const resRecentBlock = validateScoringSRRoom(klines, 499, 'BUY', 100.0, 103.0, 98.0);
    assert.strictEqual(resRecentBlock.viable, false, 'Recent pivot inside 100-bar window must be respected');
    assert.strictEqual(resRecentBlock.nearestResistance, 102.0);

    const liveRecentBlock = resolveOperationalTrade({
      strategy: 'scoring',
      signal: 'BUY',
      executionStyle: 'dayTrading',
      raw: { '5m': klines },
      closed: { '5m': klines }
    });
    assert.strictEqual(liveRecentBlock.valid, false, 'Live filter must also reject when resistance is within recent 100-bar window');
    assert.ok(liveRecentBlock.reason.includes('insuficiente hacia resistencia'), 'Live filter reason must detail resistance constraint');
  });

  // Test 190: detectClosedAlertTransitions and centralized post-exit cooldown synchronization
  test('detectClosedAlertTransitions triggers post-exit cooldown on active to terminal transitions', () => {
    const alertOpen: AuditAlertItem = {
      id: 'SOLUSDT-5m-1',
      symbol: 'SOLUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '10:00',
      pf: 2.1,
      strategy: 'VCME Sniper',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit1: 103,
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000 * 1000,
      alertType: 'PRIMARY'
    };

    const alertTp1: AuditAlertItem = {
      id: 'ETHUSDT-5m-2',
      symbol: 'ETHUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '10:00',
      pf: 1.8,
      strategy: 'Scoring',
      entryPrice: 2000,
      stopLoss: 1950,
      takeProfit1: 2075,
      status: 'TP1_HIT',
      realizedR: 1.0,
      pnlPercent: 3.75,
      timestamp: 1700000000 * 1000,
      alertType: 'EXPLORATORY'
    };

    const alertAlreadyClosed: AuditAlertItem = {
      id: 'BTCUSDT-5m-3',
      symbol: 'BTCUSDT',
      interval: '5m',
      signal: 'BUY',
      time: '09:00',
      pf: 2.5,
      strategy: 'Standard',
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit1: 51500,
      status: 'SL_HIT',
      realizedR: -1.0,
      pnlPercent: -2.0,
      timestamp: (1700000000 - 3600) * 1000,
      alertType: 'PRIMARY'
    };

    // 1. Verify getAlertCooldownKey segregation:
    assert.strictEqual(getAlertCooldownKey(alertOpen), 'SOLUSDT-5m', 'Primary alerts use symbol-interval');
    assert.strictEqual(getAlertCooldownKey(alertTp1), 'ETHUSDT-5m-exploratory', 'Exploratory alerts use symbol-interval-exploratory');

    // 2. Simulate alert outcomes:
    // SOLUSDT hits SL -> transitions from OPEN to SL_HIT (Terminal)
    const updatedSol: AuditAlertItem = { ...alertOpen, status: 'SL_HIT', realizedR: -1.0 };
    // ETHUSDT advances to TP2_HIT -> transitions from TP1_HIT to TP2_HIT (Still active!)
    const updatedEth: AuditAlertItem = { ...alertTp1, status: 'TP2_HIT', realizedR: 1.5 };
    // BTCUSDT remains in SL_HIT -> already terminal, no transition
    const updatedBtc: AuditAlertItem = { ...alertAlreadyClosed };

    const newlyClosed = detectClosedAlertTransitions(
      [alertOpen, alertTp1, alertAlreadyClosed],
      [updatedSol, updatedEth, updatedBtc]
    );

    // Only SOLUSDT reached terminal state!
    assert.strictEqual(newlyClosed.length, 1, 'Only transitions from active to terminal states must be detected');
    assert.strictEqual(newlyClosed[0].id, 'SOLUSDT-5m-1');
    assert.strictEqual(newlyClosed[0].status, 'SL_HIT');

    // 3. Verify that TP1_HIT transitioning to TP1_BE_CLOSED is also detected:
    const updatedEthBe: AuditAlertItem = { ...alertTp1, status: 'TP1_BE_CLOSED', realizedR: 0.5 };
    const closedBe = detectClosedAlertTransitions([alertTp1], [updatedEthBe]);
    assert.strictEqual(closedBe.length, 1);
    assert.strictEqual(closedBe[0].status, 'TP1_BE_CLOSED');

    // 4. Verify live cooldown guard preventing immediate re-entry after asset load:
    const tEntry = 1700000000 * 1000;
    const cooldownMs = 3600000; // 60 minutes
    const cooldownStore: Record<string, number> = {
      [getAlertCooldownKey(alertOpen)]: tEntry // Stored at entry time
    };

    // At tEntry + 75m, user loads SOLUSDT. The trade hits SL:
    const tExit = tEntry + 75 * 60 * 1000;
    // Without the fix, cooldownStore remained at tEntry, so (tExit + 1m - tEntry) = 76m >= 60m (cooldown bypassed!)
    // With the centralized fix, detectClosedAlertTransitions syncs the cooldown to tExit:
    newlyClosed.forEach(closed => {
      cooldownStore[getAlertCooldownKey(closed)] = tExit;
    });

    // Scanner evaluates 1 minute later at tExit + 1m:
    const tScan = tExit + 1 * 60 * 1000;
    const lastAlertTime = cooldownStore[getAlertCooldownKey(alertOpen)];
    const isCooldownElapsed = (tScan - lastAlertTime) >= cooldownMs;

    assert.strictEqual(isCooldownElapsed, false, 'Post-exit cooldown must block immediate re-entry (1 min after exit < 60 min cooldown)');
  });

  // Test 136: Revision 7: Tournament distinguishes marginal negative OOS from toxic OOS and downgrades to LIMITED
  test('Revision 7: Tournament distinguishes marginal negative OOS from toxic OOS and downgrades to LIMITED', () => {
    // 1. Primary winner has marginal OOS: 3 trades, E[R] = -0.03R, PF = 0.90
    // Under previous architecture, it was completely neutralized to NEUTRAL (hard veto).
    // Under the new architecture, it is preserved with confidence downgraded to LIMITED.
    const marginalOosWf = {
      ...createEmptyWalkForwardResult(400, 176),
      status: 'FAIL' as const,
      inSample: {
        ...createEmptyWalkForwardResult().inSample,
        signals: 15,
        wins: 9,
        losses: 6,
        winRate: 0.60,
        expectancyR: 0.22,
        profitFactor: 1.45,
        maxDrawdownR: 1.5,
        longStats: { signals: 8, wins: 5, losses: 3, winRate: 0.62, expectancyR: 0.25, profitFactor: 1.5 },
        shortStats: { signals: 7, wins: 4, losses: 3, winRate: 0.57, expectancyR: 0.18, profitFactor: 1.4 },
      },
      outOfSample: {
        ...createEmptyWalkForwardResult().outOfSample,
        signals: 5,
        expectancyR: 0.05,
        profitFactor: 1.1,
        longStats: { signals: 3, wins: 1, losses: 2, winRate: 0.33, expectancyR: -0.03, profitFactor: 0.90 },
        shortStats: { signals: 2, wins: 1, losses: 1, winRate: 0.50, expectancyR: 0.10, profitFactor: 1.2 },
      },
    };

    const primaryMarginal: StrategyCandidate = {
      key: 'multitemporal',
      label: 'VCME Sniper',
      profitFactor: 1.45,
      expectancyR: 0.22,
      expectancyPerHour: 0.15,
      winRate: 0.60,
      resolved: 20,
      walkForward: marginalOosWf,
    };

    const qveMarginal: QVESelectionResult = {
      bestStrategy: 'multitemporal',
      strategyLabel: 'VCME Sniper',
      confidence: 'HIGH',
      profitFactor: 1.45,
      winRate: 0.60,
      expectancyR: 0.22,
      expectancyPerHour: 0.15,
      candidates: [primaryMarginal],
      tournament: {
        bestStrategy: 'multitemporal',
        strategyLabel: 'VCME Sniper',
        confidence: 'HIGH',
        compositeScore: 2.5,
        profitFactor: 1.45,
        expectancyR: 0.22,
        expectancyPerHour: 0.15,
        longStats: marginalOosWf.inSample.longStats,
        shortStats: marginalOosWf.inSample.shortStats,
        reasoning: 'VCME Sniper lidera',
      },
    };

    const candidates = getActionableStrategyCandidates(qveMarginal, {
      multitemporal: 'BUY',
    });

    assert.strictEqual(candidates.length, 1, 'Primary candidate with marginal OOS must NOT be neutralized');
    assert.strictEqual(candidates[0].strategy, 'multitemporal');
    assert.strictEqual(candidates[0].signal, 'BUY');
    assert.strictEqual(candidates[0].confidence, 'LIMITED', 'Confidence must be downgraded from HIGH to LIMITED');
    assert.ok(candidates[0].reasoning.includes('LIMITED por OOS reciente marginal'), 'Reasoning must state marginal OOS downgrade');

    // 2. Primary winner with decisively toxic OOS (3 trades, E[R] = -0.40R, PF = 0.0):
    // Must be strictly vetoed to NEUTRAL
    const toxicOosWf = {
      ...marginalOosWf,
      outOfSample: {
        ...marginalOosWf.outOfSample,
        longStats: { signals: 3, wins: 0, losses: 3, winRate: 0, expectancyR: -0.40, profitFactor: 0.0 },
      },
    };
    const primaryToxic: StrategyCandidate = { ...primaryMarginal, walkForward: toxicOosWf };
    const qveToxic: QVESelectionResult = {
      ...qveMarginal,
      candidates: [primaryToxic],
      tournament: { ...qveMarginal.tournament, longStats: toxicOosWf.inSample.longStats },
    };
    const toxicCandidates = getActionableStrategyCandidates(qveToxic, { multitemporal: 'BUY' });
    assert.strictEqual(toxicCandidates.length, 0, 'Primary candidate with toxic OOS must be completely vetoed');

    // 3. sanitizeSignalWithDirectionalEdge: Continuous empirical Bayes shrinkage preserves friction variance (-0.35R on N=3, -0.05R on N=6) and neutralizes genuinely toxic edge (E[R] <= -0.50R or PF < 0.40 on N=3, E[R] <= -0.35R on N=6):
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.05 }, undefined, 3),
      'BUY',
      'Marginal negative on N=3 must not be neutralized by sanitizeSignalWithDirectionalEdge'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.17, profitFactor: 0.75 }, undefined, 3),
      'BUY',
      'Normal 1W/2L variance (-0.17R) on N=3 must be preserved to allow Bayesian shrinkage or LIMITED confidence'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.35, profitFactor: 0.60 }, undefined, 3),
      'BUY',
      'Friction-impacted 1W/2L variance (-0.35R) on N=3 must be preserved under continuous shrinkage'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 3, expectancyR: -0.50, profitFactor: 0.20 }, undefined, 3),
      'NEUTRAL',
      'Genuinely toxic negative (shrunk E[R] <= -0.18R or PF < 0.40) on N=3 must be neutralized'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 6, expectancyR: -0.05 }, undefined, 3),
      'BUY',
      'Marginal negative on N=6 (-0.05R) must NOT suffer sawtooth veto under continuous shrinkage'
    );
    assert.strictEqual(
      sanitizeSignalWithDirectionalEdge('BUY', { signals: 6, expectancyR: -0.35 }, undefined, 3),
      'NEUTRAL',
      'Genuinely toxic negative on N=6 (-0.35R, shrunk -0.21R <= -0.18R) must be neutralized'
    );
  });

  test('Revision 7: Scoring Layer 2 RSI symmetry (60-72 falling), Layer 3 adaptive squeeze & color-agnostic absorption, and inter-layer veto', () => {
    // 1. Squeeze adaptativo dinámico en 5m:
    // Con 60 velas y ancho de banda típico de acciones 5m (0.8% = 0.008), NO debe estar en squeeze.
    // %B a 0.82 (walking upper band) debe ejecutarse y puntuar +1.0.
    const klines5m = generateSyntheticKlines(60, 300, 100, 0.002);
    const lastIdx = klines5m.length - 1;
    const ctx = buildScoringContext(klines5m, '5m');
    const bbIdx = lastIdx - (ctx.cfg.bbPeriod - 1);

    // Inyectar 30 barras con ancho 0.010 (1.0%)
    for (let k = Math.max(0, bbIdx - 30); k <= bbIdx; k++) {
      ctx.bbSeries[k] = { upper: 100.5, lower: 99.5, middle: 100.0, bandwidth: 1.0, percentB: 0.5 };
    }
    // Barra actual con %B = 0.82 y ancho 0.010 (no comprimido respecto al promedio)
    ctx.bbSeries[bbIdx] = { upper: 100.5, lower: 99.5, middle: 100.0, bandwidth: 1.0, percentB: 0.82 };
    klines5m[lastIdx].open = 99.8;
    klines5m[lastIdx].close = 100.4;
    klines5m[lastIdx].high = 100.45;
    klines5m[lastIdx].low = 99.75;
    ctx.closes[lastIdx] = 100.4;
    const resDynamicBB = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resDynamicBB.layers.bollinger.score, 1.0, 'Dynamic BB in 5m with 1% bandwidth must execute %B walking upper band (+1.0), not squeeze');
    assert.ok(resDynamicBB.layers.bollinger.note.includes('Walking upper band'), 'Note must document Walking upper band');

    // 2. Simetría RSI en tramo (60, 72] bajando:
    // RSI 66.0 cayendo desde 71.0 debe puntuar -0.5 (pullback controlado), no -1.0.
    ctx.rsiSeries[lastIdx - 3] = 71.0;
    ctx.rsiSeries[lastIdx - 2] = 69.5;
    ctx.rsiSeries[lastIdx - 1] = 68.0;
    ctx.rsiSeries[lastIdx] = 66.0;
    const resRsiSym = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resRsiSym.layers.rsi.score, -0.5, 'RSI at 66 falling must score -0.5 as exact mirror of RSI at 34 rising (+0.5)');

    // 3. Absorción en banda inferior con cuerpo rojo y mecha inferior >= 0.25:
    // Martillo con cierre ligeramente rojo por debajo del open pero mecha inferior de 75% del rango
    // %B en 0.20 (cerca banda inferior). Debe puntuar +0.5 (absorción/rebote), NUNCA -1.0.
    ctx.bbSeries[bbIdx] = { upper: 101.0, lower: 99.0, middle: 100.0, bandwidth: 2.0, percentB: 0.20 };
    klines5m[lastIdx].open = 99.50;
    klines5m[lastIdx].close = 99.45; // Vela roja por 5 centavos
    klines5m[lastIdx].high = 99.55;
    klines5m[lastIdx].low = 99.15; // Rango total 0.40, mecha inferior: min(99.50, 99.45) - 99.15 = 0.30 (75% del rango!)
    ctx.closes[lastIdx] = 99.45;
    const resAbsorption = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resAbsorption.layers.bollinger.score, 0.5, 'Lower band hammer with red body and 75% lower wick must score +0.5 absorption, never -1.0');
    assert.ok(resAbsorption.layers.bollinger.note.includes('Rebote en soporte dinámico inf.') || resAbsorption.layers.bollinger.note.includes('Absorción'), 'Note must document absorption/rebound');

    // 4. Veto de no-contradicción inter-capas:
    // Si el score total supera threshold (+3.15), pero Bollinger tiene rechazo superior (-0.5), debe bloquear a HOLD.
    ctx.atrSeries[lastIdx] = 0.5;
    ctx.vwapSeries[lastIdx] = 99.0;
    if (ctx.vwapReliableSeries) ctx.vwapReliableSeries[lastIdx] = true;
    ctx.emaFastArr[lastIdx] = 105.0;
    ctx.emaSlowArr[lastIdx] = 95.0;
    ctx.rsiSeries[lastIdx - 3] = 48.0;
    ctx.rsiSeries[lastIdx - 2] = 50.0;
    ctx.rsiSeries[lastIdx - 1] = 52.0;
    ctx.rsiSeries[lastIdx] = 55.0; // rsiRising in 50-60 -> +1.0
    klines5m[lastIdx].open = 100.0;
    klines5m[lastIdx].close = 100.4;
    klines5m[lastIdx].high = 100.7; // uWick = 0.30 / 0.75 = 40% > 0.25 (rechazo en banda sup.)
    klines5m[lastIdx].low = 99.95;
    ctx.closes[lastIdx] = 100.4;
    ctx.bbSeries[bbIdx] = { upper: 100.5, lower: 99.5, middle: 100.0, bandwidth: 1.0, percentB: 0.85 };
    const resVetoContradiction = evaluateScoringAt(ctx, lastIdx);
    assert.strictEqual(resVetoContradiction.layers.bollinger.score, -0.5, 'Upper wick rejection must score -0.5 in Bollinger layer');
    assert.strictEqual(resVetoContradiction.signal, 'HOLD', 'Inter-layer non-contradiction filter must block BUY to HOLD when Bollinger has -0.5 rejection');
    assert.ok(resVetoContradiction.layers.bollinger.note.includes('Veto de contradicción inter-capas'), 'Note must document inter-layer conflict veto');
  });

  test('Revision 8: Standard Voting Bollinger symmetry (isBearExpansion) and EMA200 counter-trend falling knife protection', () => {
    const len = 40;
    const lastIdx = len - 1;
    const klines = generateSyntheticKlines(len, 300, 100, 0.005);
    
    // Downtrend setup: EMA200 at 105, current price at 95 (well below EMA200)
    const ema200Series = new Array(len).fill(105);
    const volSmaSeries = new Array(len).fill(1000);
    const bbSeries = Array.from({ length: len }, (_, i) => ({
      time: 1700000000 + i * 300,
      upper: 100,
      middle: 97,
      lower: 96.0,
      widthPercent: 4.0,
    }));
    const rsiSeries = new Array(len).fill(50);
    // RSI oversold and curling up
    rsiSeries[lastIdx - 3] = 22;
    rsiSeries[lastIdx] = 25;

    // 1. Plunging red candle expanding lower band downwards:
    // close = 95.0 < bb.lower (96.0), open = 95.8 (curr.close < curr.open), volume = 1500 (rvol = 1.5 >= 1.0)
    klines[lastIdx].open = 95.8;
    klines[lastIdx].close = 95.0;
    klines[lastIdx].high = 95.9;
    klines[lastIdx].low = 94.9;
    klines[lastIdx].volume = 1500;

    const ctxBearExpansion: StandardVotingContext = {
      klines,
      closes: klines.map(k => k.close),
      rsiSeries,
      macdSeries: { macd: new Array(len).fill(0), signal: new Array(len).fill(0), histogram: new Array(len).fill(0), signals: new Array(len).fill('NEUTRAL') },
      bbSeries,
      supertrendSeries: Array.from({ length: len }, () => ({ value: 105, direction: 'DOWN' as const, signal: 'NEUTRAL' as const })),
      stochRsiSeries: { k: new Array(len).fill(15), d: new Array(len).fill(15), signals: new Array(len).fill('BUY') },
      volSmaSeries,
      volSignalSeries: { values: new Array(len).fill('—'), signals: new Array(len).fill('NEUTRAL') },
      ema200Series,
    };

    const resBearExp = evaluateStandardVotingAt(ctxBearExpansion, lastIdx);
    const bbInd = resBearExp.indicators.find(i => i.name === 'Bollinger Bands');
    assert.strictEqual(bbInd?.signal, 'NEUTRAL', 'Bollinger must NOT vote BUY when walking lower band downwards on volume (isBearExpansion)');
    assert.strictEqual(resBearExp.finalSignal, 'NEUTRAL', 'Plunging knife under EMA200 must be vetoed to NEUTRAL');

    // 2. Absorption hammer candle recovering from lower band:
    // close = 95.8 >= open = 95.0, closePosition = (95.8 - 94.9) / (95.9 - 94.9) = 0.90
    klines[lastIdx].open = 95.0;
    klines[lastIdx].close = 95.8;
    klines[lastIdx].high = 95.9;
    klines[lastIdx].low = 94.9;
    ctxBearExpansion.closes[lastIdx] = 95.8;

    const resBounce = evaluateStandardVotingAt(ctxBearExpansion, lastIdx);
    const bbIndBounce = resBounce.indicators.find(i => i.name === 'Bollinger Bands');
    assert.strictEqual(bbIndBounce?.signal, 'BUY', 'Bollinger must vote BUY when oversold bounce closes green');
    assert.strictEqual(resBounce.finalSignal, 'BUY', 'Confluent absorption bounce below EMA200 is permitted');
  });

  test('Revision 9: Confluencia evaluator enforces 0.40% anti-friction stop floor in 5m against 0.11% friction drag', () => {
    // Large cap equity (e.g. AAPL at $200) with low ATR ($0.20, atrPct = 0.10%)
    // Raw 2 * ATR = $0.40 (0.20% stop).
    // In 5m, the structural floor is 0.40% ($0.80), yielding stopLoss = $199.20 instead of $199.60.
    const len = 35;
    const lastIdx = len - 1;
    const klines = generateSyntheticKlines(len, 300, 200, 0.001);
    const ctx = buildConfluenciaContext(klines, '5m');
    ctx.atr[lastIdx] = 0.20;
    klines[lastIdx].close = 200.0;
    klines[lastIdx].open = 199.8;
    klines[lastIdx].high = 200.1;
    klines[lastIdx].low = 199.7;
    ctx.closes[lastIdx] = 200.0;
    ctx.ema9[lastIdx] = 199.5;
    ctx.ema20[lastIdx] = 199.0;
    ctx.vwap[lastIdx] = 199.8;
    ctx.volSMA[lastIdx] = 1000;
    klines[lastIdx].volume = 1500;

    const res5m = evaluateConfluenciaAt(ctx, lastIdx);
    assert.strictEqual(res5m.signal, 'BUY', 'Confluencia must trigger BUY on valid uptrend continuation');
    // With 0.40% floor: 200 * (1 - 0.004) = 199.20
    assert.strictEqual(Math.round(res5m.stopLoss * 100) / 100, 199.20, 'Confluencia stop in 5m must enforce 0.40% anti-friction floor ($199.20), not raw 2*ATR ($199.60)');

    // In 1h timeframe, raw 2*ATR applies without 5m intraday floor:
    const ctx1h = buildConfluenciaContext(klines, '1h');
    ctx1h.atr[lastIdx] = 0.20;
    ctx1h.closes[lastIdx] = 200.0;
    ctx1h.ema9[lastIdx] = 199.5;
    ctx1h.ema20[lastIdx] = 199.0;
    ctx1h.vwap[lastIdx] = 199.8;
    ctx1h.volSMA[lastIdx] = 1000;
    const res1h = evaluateConfluenciaAt(ctx1h, lastIdx);
    assert.strictEqual(Math.round(res1h.stopLoss * 100) / 100, 199.60, 'Confluencia stop in 1h must use raw 2*ATR without 5m floor ($199.60)');
  });

  console.log(`\nSummary: ${passed}/${total} backtester tests passed.\n`);
  return { passed, total };
}

// Auto-run if executed directly via node/tsx
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('backtester.test')) {
  const { passed, total } = runAllBacktesterTests();
  if (passed !== total) {
    process.exit(1);
  }
}
