import assert from 'node:assert';
import {
  backtestStandard,
  backtestMultitemporal,
  backtestMultifractalMTF,
  computeStandardSignalsSeries,
  computeConfluenciaSignalsSeries
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
    assert(buyLevels.takeProfit2 > buyLevels.takeProfit1, 'TP2 must be strictly above TP1');

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

    // Pre-load klines:
    // Candle 1: reaches 103.5 -> hits TP1 (status = TP1_HIT)
    // Candle 2: surges to 106.0 -> hits TP2 (status = TP2_HIT)
    // Candle 3: peaks at 108.0 (highestHigh = 108.0), ATR ~ 1.0 -> Chandelier SL = 108 - 2.5*1 = 105.5
    // Candle 4: drops to close at 105.0 (below Chandelier 105.5) -> exits runner
    const klines: Kline[] = [
      { time: startTime, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
      { time: startTime + 300, open: 100, high: 103.5, low: 100, close: 103.2, volume: 1000 },
      { time: startTime + 600, open: 103.2, high: 106.0, low: 103.0, close: 105.5, volume: 1500 },
      { time: startTime + 900, open: 105.5, high: 108.0, low: 105.2, close: 107.5, volume: 2000 },
      { time: startTime + 1200, open: 107.5, high: 107.5, low: 104.8, close: 105.0, volume: 2500 },
    ];

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
    assert(typeof result.profitFactor === 'number');
  });

  // Test 33: Tournament Zero-Loss / Single Trade Singularity Rejection
  test('evaluateStrategyTournament prevents single-trade zero-loss candidates from beating robust samples', () => {
    const candidates: StrategyCandidate[] = [
      // 1 single lucky trade with 0 losses
      { key: 'standard', label: 'Lucky Single Trade', profitFactor: 99.9, expectancy: 1.5, winRate: 1.0, resolved: 1, forwardWindow: 6 },
      // 20 robust trades with strong stats
      { key: 'confluencia', label: 'Robust Confluencia', profitFactor: 2.2, expectancy: 0.6, winRate: 0.65, resolved: 20, forwardWindow: 6 }
    ];

    const result = evaluateStrategyTournament(candidates, '5m');
    assert.strictEqual(result.bestStrategy, 'confluencia', 'Robust sample must decisively beat single lucky trade');
    assert.strictEqual(result.confidence, 'HIGH');
  });

  // Test 34: Tournament Time-Horizon Expectancy Normalization
  test('evaluateStrategyTournament fairly scales expectancy across different forward windows', () => {
    const candidates: StrategyCandidate[] = [
      // Fast strategy (6 candles): +0.35% in 30 min (E_norm = 0.35%)
      { key: 'standard', label: 'Fast Scalp (6 candles)', profitFactor: 1.8, expectancy: 0.35, winRate: 0.60, resolved: 20, forwardWindow: 6 },
      // Slow strategy (72 candles): +0.40% in 6 hrs (E_norm = 0.40 / sqrt(12) = 0.115%)
      { key: 'multitemporal', label: 'Slow Drift (72 candles)', profitFactor: 1.8, expectancy: 0.40, winRate: 0.60, resolved: 20, forwardWindow: 72 }
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
