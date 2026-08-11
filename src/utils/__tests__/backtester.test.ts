import assert from 'node:assert';
import {
  backtestMultitemporal,
  backtestMultifractalMTF,
  computeStandardSignalsSeries,
  computeConfluenciaSignalsSeries
} from '../backtester';
import type { Kline } from '../../services/api';

function generateSyntheticKlines(count: number, intervalSeconds: number, startPrice: number = 100): Kline[] {
  const klines: Kline[] = [];
  let price = startPrice;
  const startTime = 1700000000;

  for (let i = 0; i < count; i++) {
    const time = startTime + i * intervalSeconds;
    const change = (Math.sin(i / 10) * 0.5) + ((i % 5 === 0 ? 1 : -0.8) * 0.3);
    const open = price;
    const close = Math.max(10, price + change);
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
