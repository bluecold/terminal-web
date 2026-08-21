import assert from 'node:assert';
import {
  backtestStandard,
  backtestMultitemporal,
  backtestMultifractalMTF,
  computeStandardSignalsSeries,
  computeConfluenciaSignalsSeries
} from '../backtester';
import {
  updateAlertsOutcome,
  calculateSessionStats,
  generateCandleAlertKey,
  isCandleAlertFired,
  registerFiredCandleAlert,
  pruneFiredAlertsRegistry,
  clearFiredAlertsRegistry,
  type AuditAlertItem
} from '../alertTracker';
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
    assert.strictEqual(result.forwardLabel, '24 hs max (Intradía)');
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
      status: 'TP2_HIT', realizedR: 2.5, pnlPercent: 4.5, timestamp: 1700000000000
    };

    const klinesMap = {
      'BTCUSDT:5m': [{ time: 1700000010, open: 100, high: 110, low: 90, close: 90, volume: 100 }]
    };

    const updated = updateAlertsOutcome([closedAlert], klinesMap);
    assert.strictEqual(updated[0].pnlPercent, 4.5, 'Closed alert P&L should be frozen');
    assert.strictEqual(updated[0].status, 'TP2_HIT');
  });

  // Test 7: Alert Tracker TP1 -> TP2 Progression
  test('updateAlertsOutcome advances OPEN alert to TP1_HIT and then TP2_HIT', () => {
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
    assert.strictEqual(updated[0].status, 'TP2_HIT', 'Alert should progress through TP1 to TP2_HIT');
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
    assert.strictEqual(updated[0].realizedR, 1.0, 'Realized R should be locked at +1.0R for TP1 + BE');
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
      status: 'TP1_HIT', realizedR: 1.5, pnlPercent: 1.5, timestamp: oldTimestamp
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
      { id: '1', symbol: 'BTC', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP1_BE_CLOSED', realizedR: 1.0, pnlPercent: 1.5, timestamp: todayMs },
      { id: '2', symbol: 'ETH', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP2_HIT', realizedR: 2.5, pnlPercent: 4.5, timestamp: todayMs },
      { id: '3', symbol: 'SOL', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'SL_HIT', realizedR: -1.0, pnlPercent: -2.0, timestamp: todayMs },
      { id: '4', symbol: 'BNB', interval: '5m', signal: 'BUY', time: '12:00', pf: 2.0, strategy: 'VCME', entryPrice: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 106, status: 'TP1_HIT', realizedR: 1.5, pnlPercent: 2.0, timestamp: todayMs }
    ];

    const stats = calculateSessionStats(alerts, false);
    assert.strictEqual(stats.total, 4);
    assert.strictEqual(stats.wins, 2, 'TP1_BE_CLOSED and TP2_HIT must count as wins');
    assert.strictEqual(stats.losses, 1, 'SL_HIT must count as loss');
    assert.strictEqual(stats.openCount, 1, 'TP1_HIT must be counted in openCount while trailing');
    assert.strictEqual(stats.winRate, 66.7);
    assert.strictEqual(stats.totalR, 2.5);
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
