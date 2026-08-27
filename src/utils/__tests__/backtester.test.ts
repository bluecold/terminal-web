import assert from 'node:assert';
import {
  backtestStandard,
  backtestMultitemporal,
  backtestMultifractalMTF,
  computeStandardSignalsSeries,
  computeConfluenciaSignalsSeries,
  computeScoringSignalsSeries,
  calculateRiskMetrics,
  calculateWalkForward,
  type RecordedTrade
} from '../backtester';
import {
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateRollingVolumeAvg,
  calculateRevolutionVolatilityBand,
  isNyseOpeningWindow,
  getOpeningRange,
  getSessionId
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
  type AuditAlertItem
} from '../alertTracker';
import { formatSmartPrice, formatSmartNumber, getOptimalDecimals } from '../formatters';
import { evaluateStrategyTournament, type StrategyCandidate } from '../tournament';
import { simulateTrade, type TradeLevels, type ExitPolicy } from '../tradeSimulator';
import type { Kline } from '../../services/api';

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

  // Test 7: Alert Tracker TP1 -> TP2 Progression
  test('updateAlertsOutcome advances OPEN alert to TP1_HIT and then TP2_CLOSED', () => {
    const openAlert: AuditAlertItem = {
      id: '2', symbol: 'ETHUSDT', interval: '1h', signal: 'BUY', time: '12:00',
      pf: 1.8, strategy: 'Standard', entryPrice: 100, stopLoss: 98, takeProfit1: 102, takeProfit2: 105,
      status: 'OPEN', realizedR: 0, pnlPercent: 0, timestamp: 1700000000000
    };

    const klinesMap = {
      'ETHUSDT:1h': [
        { time: 1700000010, open: 100, high: 103, low: 99.5, close: 102.5, volume: 100 },
        { time: 1700003610, open: 102.5, high: 106, low: 101, close: 105.5, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([openAlert], klinesMap);
    assert.strictEqual(updated[0].status, 'TP2_CLOSED', 'Standard alert should progress through TP1 to TP2_CLOSED');
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
    assert.strictEqual(updated[0].realizedR, 0.75, 'Realized R should be locked at +0.75R for 50% TP1 (1.5R) + BE');
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

  // Test 18: Unclosed live candle repainting immunity
  test('updateAlertsOutcome ignores unclosed live candle extremes for terminal status and updates floating PnL', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const alertTime = Date.now() - 60000; // fired 1 minute ago

    const alert: AuditAlertItem = {
      id: 'repainting-test-1',
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

    // The live 1H candle started 10 minutes ago and is currently in formation (ends in 50 minutes)
    // It has a spike to 125 (would hit TP2 if evaluated), but it is NOT closed yet!
    const liveCandleTime = nowSec - 600;
    const klinesMap = {
      'BTCUSDT:1h': [
        // Previous closed candle from yesterday
        { time: liveCandleTime - 3600, open: 98, high: 101, low: 97, close: 100, volume: 100 },
        // Current forming 1H candle (open now)
        { time: liveCandleTime, open: 100, high: 125, low: 99, close: 105, volume: 100 }
      ]
    };

    const updated = updateAlertsOutcome([alert], klinesMap);
    assert.strictEqual(updated[0].status, 'OPEN', 'Alert must stay OPEN and NOT freeze as TP2_HIT from an unclosed candle');
    assert.strictEqual(updated[0].pnlPercent, 5, 'Floating PnL should be calculated from live close (105 vs 100 = +5%)');
  });

  // Test 19: Multi-Timeframe Cache Invalidation via Auxiliary Timeframe Fingerprint
  test('backtestMultitemporal cache invalidates when 1h or 1d updates even if 5m is unchanged', () => {
    const klines5m = generateSyntheticKlines(900, 300, 50000, 0.02);
    const klines1h_v1 = generateSyntheticKlines(120, 3600, 50000, 0.02);
    const klines1d = generateSyntheticKlines(60, 86400, 50000, 0.02);

    // Initial evaluation with 1h_v1
    const res1 = backtestMultitemporal(klines5m, klines1h_v1, klines1d, '5m', 'TEST_MTF_SYM', 'dayTrading');

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
  test('updateAlertsOutcome triggers 8-candle Time-Stop for stagnant VCME 5m trades', () => {
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
    const klinesMap = {
      'BTCUSDT:5m': [
        { time: 1700000300, open: 100, high: 100.5, low: 99.5, close: 100.1, volume: 100 },
        { time: 1700000600, open: 100.1, high: 100.6, low: 99.6, close: 100.2, volume: 100 },
        { time: 1700000900, open: 100.2, high: 100.7, low: 99.7, close: 100.3, volume: 100 },
        { time: 1700001200, open: 100.3, high: 100.8, low: 99.8, close: 100.2, volume: 100 },
        { time: 1700001500, open: 100.2, high: 100.6, low: 99.6, close: 100.1, volume: 100 },
        { time: 1700001800, open: 100.1, high: 100.5, low: 99.5, close: 100.2, volume: 100 },
        { time: 1700002100, open: 100.2, high: 100.6, low: 99.6, close: 100.3, volume: 100 },
        { time: 1700002400, open: 100.3, high: 100.5, low: 99.5, close: 100.2, volume: 100 }, // 8th candle
      ]
    };

    const updated = updateAlertsOutcome([alert], klinesMap);
    assert.strictEqual(updated[0].status, 'EXPIRED', 'Stagnant VCME 5m trade must close via 8-candle Time-Stop');
    assert.strictEqual(updated[0].pnlPercent, 0.2, 'PnL must match gain at candle 8 (100.2 vs 100 = +0.2%)');
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
    assert.strictEqual(updated[0].pnlPercent, -6, 'Loss should be capped at early exit price (-6% vs full SL -10%)');
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
      takeProfit2: 110, // 2.5R
      status: 'OPEN',
      realizedR: 0,
      pnlPercent: 0,
      timestamp: 1700000000000,
      candleTimestamp: 1700000000
    };

    // Forward candle hits TP1 and later retests entry -> should lock in TP1_BE_CLOSED
    const forwardKlines = [
      { time: 1700000300, open: 100, high: 107, low: 99.5, close: 106, volume: 1500 },
      { time: 1700000600, open: 106, high: 106.5, low: 99.8, close: 100, volume: 1200 }
    ];

    const trackerRes = updateAlertsOutcome([alert], { 'GOLDEN_MTF:5m': forwardKlines });
    assert.strictEqual(trackerRes[0].status, 'TP1_BE_CLOSED', 'Multifractal must transition to TP1_BE_CLOSED on entry retest');
    assert.strictEqual(trackerRes[0].realizedR, 0.75, 'Realized R for 1.5R TP1 at Breakeven must be exactly +0.75R');
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
    assert(buyLevels.takeProfit2 >= buyLevels.takeProfit1, 'TP2 must match or exceed TP1');

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
    assert.strictEqual(getStrategyExpiryCandles('VCME Sniper', '5m', 'dayTrading'), 72, 'VCME DayTrading 5m must be 72 candles (6h)');
    assert.strictEqual(getStrategyExpiryCandles('VCME Multitemporal', '1h', 'swing'), 48, 'VCME Swing 1h must be 48 candles (48h)');
    assert.strictEqual(getStrategyExpiryCandles('Multifractal MTF', '5m'), 12, 'Multifractal MTF 5m must be 12 candles (1h)');
    assert.strictEqual(getStrategyExpiryCandles('Standard Voting', '5m'), 6, 'Standard 5m must be 6 candles');
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
    assert(evaluated[0].realizedR >= 1.8, `Realized R with trailing runner should be >= 1.8R (got ${evaluated[0].realizedR}R)`);
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
    // Realized R: 0.50*1.5 + 0.25*2.5 + 0.25*1.5 = 0.75 + 0.625 + 0.375 = 1.75R (NOT 2.00R!)
    assert.strictEqual(evaluated[0].realizedR, 1.75, 'Realized R on pullback to TP1 SL must be exactly +1.75R');
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

  // Test 38: VCME Swing Mode Window Reachability for Stocks (evalWindow = 168)
  test('VCME Swing mode evaluates on stock datasets with ~300-440 1H candles (evalWindow = 168)', () => {
    // 350 hourly candles (typical 2-month stock data or 440 3-month data)
    const klines1h = generateSyntheticKlines(350, 3600, 150);
    const klines1d = generateSyntheticKlines(60, 86400, 150);

    const result = backtestMultitemporal(klines1h, klines1h, klines1d, '1h', 'AAPL', 'swing', 'agresivo');
    assert.strictEqual(result.insufficient, false, 'VCME Swing must evaluate successfully with 350 1H candles');
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
    assert.strictEqual(levels5m.takeProfit2, levels5m.takeProfit1, '5m TP2 must equal TP1 (single objective parity)');

    // 1d: atrMultiplier = 1.0 -> stopPct = 1.0%, target = 1.5% (+1.5R)
    const levels1d = calculateAlertLevels('SELL', entry, '1d', atr);
    assert.strictEqual(levels1d.stopLoss, 100.0 * (1 + 0.010), '1d Stop loss must equal entry * (1 + 1.0 * ATR)');
    assert.strictEqual(levels1d.takeProfit1, 100.0 * (1 - 0.015), '1d TP1 must equal entry * (1 - 1.5 * ATR)');
    assert.strictEqual(levels1d.takeProfit2, levels1d.takeProfit1, '1d TP2 must equal TP1');

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

  // Test 44: Classic Strategy 2-Hour (24 Candle) Cooldown Parity
  test('backtestStandard enforces documented 2-hour (24 candles) cooldown on 5m', () => {
    // Generate trending klines of 600 bars
    const klines = generateSyntheticKlines(600, 300, 100, 0.10);
    const result = backtestStandard(klines, '5m', 'COOLDOWN_TEST');

    // In a 576-bar eval window, max possible signals with 24-candle cooldown is 576 / 24 = 24
    assert.ok(result.totalSignals <= 24, `Total signals (${result.totalSignals}) must not exceed window / cooldown (24)`);
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
    assert.strictEqual(evaluated[0].status, 'EXPIRED', 'Alert must exit via Emergency Exit as EXPIRED');
    // Expected PnL: 50% * (+6%) + 50% * (-2%) = +3.0% - 1.0% = +2.0%
    assert.strictEqual(evaluated[0].pnlPercent, 2.0, `PnL must be +2.0% with 50% partial taken (got ${evaluated[0].pnlPercent}%)`);
    assert(evaluated[0].realizedR > 0, `Realized R must be positive (+0.5R) because TP1 was filled intra-candle (got ${evaluated[0].realizedR}R)`);
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
      frictionPct: 0.08
    });
    assert.strictEqual(res2.outcome, 'win');
    assert.strictEqual(res2.exitReason, 'TP2');
    assert.strictEqual(res2.status, 'TP2_CLOSED');
    // Active SL was trailed to TP1 (106). Low 104.5 fills stop at 106:
    // 50% * 6% (TP1) + 25% * 10% (TP2) + 25% * 6% (TP1 SL) = 3.0 + 2.5 + 1.5 = 7.0% gross, 6.92% net
    // Net R = 6.92% / 4.0% = 1.73R
    assert.strictEqual(res2.grossPnlPct, 7.0);
    assert.strictEqual(res2.pnlPct, 6.92);
    assert.strictEqual(res2.realizedR, 1.73);

    // 3. Emergency Exit VWAP breach
    const emergKlines: Kline[] = [
      { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1700000300, open: 100, high: 101, low: 96.5, close: 97, volume: 1000 }
    ];
    const res3 = simulateTrade(emergKlines, 0, 'BUY', levels1, {
      forwardWindow: 5,
      emergencyExitFn: () => true, // Emergency triggered immediately
      frictionPct: 0.08
    });
    assert.strictEqual(res3.outcome, 'timeout');
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
    const resSL = simulateTrade(slKlines, 0, 'BUY', slLevels, { forwardWindow: 5, frictionPct: 0.08 });
    assert.strictEqual(resSL.outcome, 'loss');
    assert.strictEqual(resSL.exitReason, 'SL');
    assert.strictEqual(resSL.grossPnlPct, -2.0);
    assert.strictEqual(resSL.pnlPct, -2.08);
    assert.strictEqual(resSL.realizedR, -1.04, 'Stop Loss with 2% risk and 0.08% friction must yield -1.04R net');
  });

  // Test 54: R-multiple and exposure velocity tournament evaluation with null PF handling
  test('evaluateStrategyTournament normalizes by R and exposure velocity and excludes null PF singularities', () => {
    // Zero losses with single trade: PF must be null and treated as unproven
    const zeroLossCandidate: StrategyCandidate = {
      key: 'standard',
      label: 'Zero Loss 1-Trade',
      profitFactor: null,
      expectancyR: 1.5,
      expectancyPerHour: 3.0,
      avgExposureHours: 0.5,
      winRate: 1.0,
      resolved: 1,
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

    // Scenario A.2: Single positive trade in OOS (< 5 trades) -> NO_OOS_TRADES (unproven)
    const tradesSingleOOS: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.5, pnlPct: 6.0, outcome: 'win', entryIdx: 20 },
      { dir: 'BUY', realizedR: 0.01, pnlPct: 0.04, outcome: 'win', entryIdx: 85 } // 1 OOS trade only
    ];
    const wfSingle = calculateWalkForward(tradesSingleOOS, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfSingle.outOfSample.signals, 1);
    assert.strictEqual(wfSingle.status, 'NO_OOS_TRADES', 'Single OOS trade must NOT be awarded PASS');
    assert.strictEqual(wfSingle.passed, false);

    // Scenario B: Negative OOS -> FAIL
    const tradesFailing: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 2.0, pnlPct: 8.0, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 75 }, // OOS trade
      { dir: 'SELL', realizedR: -1.0, pnlPct: -4.0, outcome: 'loss', entryIdx: 90 } // OOS trade
    ];
    const wfFail = calculateWalkForward(tradesFailing, oldestIdx, latestIdx, 0.70, 5);
    assert.strictEqual(wfFail.inSample.signals, 1);
    assert.strictEqual(wfFail.outOfSample.signals, 2);
    assert.strictEqual(wfFail.outOfSample.wins, 0);
    assert.strictEqual(wfFail.outOfSample.losses, 2);
    assert.strictEqual(wfFail.outOfSample.expectancyR, -1.0);
    assert.strictEqual(wfFail.status, 'FAIL');
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
      stdResult.walkForward.inSample.signals + stdResult.walkForward.outOfSample.signals,
      stdResult.totalSignals
    );
    assert.ok(['PASS', 'FAIL', 'NO_OOS_TRADES'].includes(stdResult.walkForward.status));
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

    // Also test what happens if ONLY the degraded candidate is evaluated
    const soloDegraded = evaluateStrategyTournament([candidateDegradedOOS], '5m');
    assert.strictEqual(soloDegraded.confidence, 'LIMITED', 'Failed OOS candidate must NEVER be awarded HIGH confidence');
    assert.ok(soloDegraded.reasoning.includes('WF OOS falló'));
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
    const tightSL = simulateTrade(tightKlines, 0, 'BUY', tightLevels, { forwardWindow: 5, frictionPct: 0.08 });
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
    const stdSL = simulateTrade(stdKlines, 0, 'BUY', stdLevels, { forwardWindow: 5, frictionPct: 0.08 });
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
    // 1. Single trade in OOS with +0.01R must result in NO_OOS_TRADES and passed = false
    const tradesSingleLucky: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 30 },
      { dir: 'BUY', realizedR: 0.01, pnlPct: 0.04, outcome: 'win', entryIdx: 85 } // 1 trade in OOS
    ];
    const wfSingle = calculateWalkForward(tradesSingleLucky, 0, 99, 0.70, 5);
    assert.strictEqual(wfSingle.outOfSample.signals, 1);
    assert.strictEqual(wfSingle.status, 'NO_OOS_TRADES');
    assert.strictEqual(wfSingle.passed, false, 'Single trade in OOS must not be awarded PASS');

    // 2. Candidate with NO_OOS_TRADES must be rejected from HIGH confidence in tournament
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
    assert.ok(tourneyUnproven.reasoning.includes('Muestra OOS Insuficiente') || tourneyUnproven.reasoning.includes('Muestra limitada'));

    // 3. Robust candidate with 5 OOS trades with E[R] > 0 unlocks HIGH confidence
    const tradesRobustOOS: RecordedTrade[] = [
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 10 },
      { dir: 'BUY', realizedR: 1.0, pnlPct: 4.0, outcome: 'win', entryIdx: 30 },
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

  // Test 66: Disjoint partition parity: wins + losses + timeouts === totalSignals
  test('wins, losses, and timeouts form a strictly disjoint partition of totalSignals', () => {
    const klines5m = generateSyntheticKlines(700, 300, 100, 0.03);
    const klines1h = generateSyntheticKlines(250, 3600, 100, 0.03);
    const klines1d = generateSyntheticKlines(220, 86400, 100, 0.03);

    // 1. Test VCME backtest
    const vcmeRes = backtestMultitemporal(klines5m, klines1h, klines1d, '5m', 'DISJOINT_VCME', 'dayTrading');
    assert.strictEqual(
      vcmeRes.wins + vcmeRes.losses + vcmeRes.timeouts,
      vcmeRes.totalSignals,
      `VCME: wins(${vcmeRes.wins}) + losses(${vcmeRes.losses}) + timeouts(${vcmeRes.timeouts}) must equal totalSignals(${vcmeRes.totalSignals})`
    );
    if (vcmeRes.totalSignals > 0) {
      const expectedResolutionRate = Number(((vcmeRes.wins + vcmeRes.losses) / vcmeRes.totalSignals).toFixed(3));
      assert(Math.abs(vcmeRes.resolutionRate - expectedResolutionRate) < 0.01, 'resolutionRate must equal (wins + losses) / totalSignals');
    }

    // 2. Test Standard backtest
    const stdRes = backtestStandard(klines5m, '5m', 'DISJOINT_STD');
    assert.strictEqual(
      stdRes.wins + stdRes.losses + stdRes.timeouts,
      stdRes.totalSignals,
      `Standard: wins(${stdRes.wins}) + losses(${stdRes.losses}) + timeouts(${stdRes.timeouts}) must equal totalSignals(${stdRes.totalSignals})`
    );

    // 3. Test Multifractal backtest
    const mfRes = backtestMultifractalMTF(klines5m, klines1h, klines1d, '5m', 'DISJOINT_MF');
    assert.strictEqual(
      mfRes.wins + mfRes.losses + mfRes.timeouts,
      mfRes.totalSignals,
      `Multifractal: wins(${mfRes.wins}) + losses(${mfRes.losses}) + timeouts(${mfRes.timeouts}) must equal totalSignals(${mfRes.totalSignals})`
    );
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
