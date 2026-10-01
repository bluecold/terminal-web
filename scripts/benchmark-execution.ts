import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Kline } from '../src/services/api';
import { simulateTrade } from '../src/utils/tradeSimulator';

// Isolated execution reducer benchmark, NOT browser/render/network latency.
// Baseline is full replay in the current engine, not the former implementation.
const bars: Kline[] = Array.from({ length: 1001 }, (_, i) => ({
  time: 1_700_000_000 + i * 300, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100,
}));
const levels = { entryPrice: 100, stopLoss: 80, takeProfit1: 130 };
const policy = { forwardWindow: 1500, floatingClosePrice: 100, trailingStop: 'none' as const };
const checkpoint = simulateTrade(bars, 0, 'BUY', levels, policy).executionState;
const replay = () => simulateTrade(bars, 0, 'BUY', levels, policy);
const resume = () => simulateTrade(bars, 0, 'BUY', levels, { ...policy, executionState: checkpoint });
assert.deepEqual(resume(), replay());
for (let i = 0; i < 100; i++) { replay(); resume(); }
const iterations = 200;
const rounds = 7;
const measure = (run: typeof replay) => {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) run();
  return (performance.now() - start) / iterations;
};
const full: number[] = [];
const incremental: number[] = [];
for (let i = 0; i < rounds; i++) {
  // Alternate order to reduce warmup/thermal ordering bias.
  if (i % 2) { incremental.push(measure(resume)); full.push(measure(replay)); }
  else { full.push(measure(replay)); incremental.push(measure(resume)); }
}
const median = (samples: number[]) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
console.log(JSON.stringify({
  node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  evaluatedBars: bars.length - 1, iterationsPerRound: iterations, rounds,
  fullReplayMedianMs: median(full), unchangedCheckpointMedianMs: median(incremental),
  scope: 'One open trade, identical snapshot, current reducer only; excludes indicators, persistence, rendering and GPU.',
}, null, 2));
