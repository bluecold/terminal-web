/**
 * Freqtrade-style causality checks for the six engines (see helpers/causality.ts).
 *
 * Lookahead: an evaluator must give the same output for bar i whether it sees the full history
 * or only what existed when bar i closed. This guards live/backtest parity for every engine at
 * once, so new evaluator code is covered without writing a dedicated lookahead test.
 *
 * Recursive: with enough history the signal must not depend on where the series starts.
 * The "converged history" asserted per engine is the measured state on synthetic data; real
 * data is measured by scripts/causality-analysis.ts. Known gaps are kept visible as `todo`.
 */
import assert from 'node:assert';
import test, { describe } from 'node:test';
import type { Kline } from '../../services/api';
import { calculateEMA } from '../indicators';
import { getStrategyConvergedWarmup, resolveBacktestWarmupFloor } from '../backtester';
import {
  ENGINES, makeSyntheticEquity, makeSyntheticEquity1h, makeSyntheticCrypto,
  runLookaheadAnalysis, runRecursiveAnalysis, windowAt, signalOf,
  type EngineAdapter, type MarketData,
} from './helpers/causality';

const equity5m = makeSyntheticEquity(7);
const crypto5m = makeSyntheticCrypto(11);
const equity1h = makeSyntheticEquity1h(5);

const engine = (name: string) => ENGINES.find(e => e.name === name)!;

/** Deliberately broken engines used to prove the detectors work. */
const leakyEngine: EngineAdapter = {
  name: 'Leaky', multiTimeframe: false,
  evaluateMany: (d, idx) => idx.map(i => {
    const next = d.primary[i + 1];
    return { signal: next && next.close > d.primary[i].close ? 'BUY' : 'NEUTRAL' };
  }),
};
const ema200Engine: EngineAdapter = {
  name: 'EMA200', multiTimeframe: false,
  evaluateMany: (d, idx) => {
    const ema = calculateEMA(d.primary.map((k: Kline) => k.close), 200);
    return idx.map(i => ({ signal: d.primary[i].close > ema[i] ? 'BUY' : 'SELL' }));
  },
};

describe('Lookahead analysis (freqtrade lookahead-analysis)', () => {
  test('detector flags an engine that reads the next candle', () => {
    const r = runLookaheadAnalysis(leakyEngine, crypto5m, 50);
    assert.ok(r.biased.length > 0, 'the leaky control engine must be flagged');
  });

  // From bar 400 the truncated 1h series already has > 30 closed bars, so the MTF context gates
  // (≥ 20 bars of 1h) behave the same with full and truncated history.
  for (const e of ENGINES) {
    test(`${e.name}: 5m equity evaluation is identical with history truncated at the bar`, () => {
      const r = runLookaheadAnalysis(e, equity5m, 400);
      assert.ok(r.checkedSignals > 0, `${e.name} must produce at least one signal to verify`);
      assert.deepStrictEqual(r.biased, [], `${e.name} reads the future`);
    });
  }

  for (const e of ENGINES.filter(x => !x.multiTimeframe)) {
    test(`${e.name}: 5m crypto evaluation is identical with history truncated at the bar`, () => {
      const r = runLookaheadAnalysis(e, crypto5m, 250);
      assert.ok(r.checkedSignals > 0);
      assert.deepStrictEqual(r.biased, []);
    });
  }

  for (const name of ['Confluencia', 'Scoring', 'Standard']) {
    test(`${name}: 1h equity evaluation is identical with history truncated at the bar`, () => {
      const r = runLookaheadAnalysis(engine(name), equity1h, 250);
      assert.ok(r.checkedSignals > 0);
      assert.deepStrictEqual(r.biased, []);
    });
  }
});

describe('Recursive analysis (freqtrade recursive-analysis)', () => {
  const tail = (d: MarketData, n: number) =>
    Array.from({ length: n }, (_, k) => d.primary.length - 1 - Math.floor(k * 1400 / n));

  const assertConverged = (e: EngineAdapter, d: MarketData, history: number) => {
    const [r] = runRecursiveAnalysis(e, d, tail(d, 120), [history]);
    assert.strictEqual(r.signalMismatches, 0,
      `${e.name} with ${history} bars differs from full history on ${r.signalMismatches}/${r.actionable} signals: ${JSON.stringify(r.examples)}`);
  };

  test('detector flags EMA200 computed on a short window', () => {
    const [r] = runRecursiveAnalysis(ema200Engine, crypto5m, tail(crypto5m, 120), [60]);
    assert.ok(r.signalMismatches > 0);
  });

  test('Confluencia 5m equity: converged from 100 bars (EMA20; VWAP resets each session)', () => {
    assertConverged(engine('Confluencia'), equity5m, 100);
  });

  test('Confluencia 5m crypto: converged once a full UTC day of 5m is available (VWAP anchor)', () => {
    assertConverged(engine('Confluencia'), crypto5m, 300);
  });

  test('MFLS 5m: converged from 59 bars', () => {
    assertConverged(engine('MFLS'), equity5m, 59);
    assertConverged(engine('MFLS'), crypto5m, 59);
  });

  test('Standard: EMA200 needs ~1000 bars to converge', () => {
    assertConverged(engine('Standard'), equity5m, 1000);
    assertConverged(engine('Standard'), crypto5m, 1000);
  });

  test('VCME and Multifractal 5m: converged from 300 bars of 5m (1h/1d unchanged)', () => {
    assertConverged(engine('VCME'), equity5m, 300);
    assertConverged(engine('Multifractal'), equity5m, 300);
  });

  test('Scoring: converged from 300 bars wherever the series starts (S/R checkpoints anchored to candle time)', () => {
    assertConverged(engine('Scoring'), equity5m, 300);
    assertConverged(engine('Scoring'), crypto5m, 300);
  });

  test('Scoring: S/R checkpoints do not depend on where the series starts', () => {
    const e = engine('Scoring');
    for (const d of [equity5m, crypto5m]) {
      const idx = tail(d, 120);
      const full = e.evaluateMany(d, idx);
      for (const shift of [0, 1, 2, 3, 4]) {
        idx.forEach((i, k) => {
          const w = windowAt(d, i, 600 + shift);
          assert.strictEqual(signalOf(e.evaluateMany(w.data, [w.index])[0]), signalOf(full[k]), `bar ${i}, start shifted by ${shift}`);
        });
      }
    }
  });

  // The backtest evaluates from getStrategyConvergedWarmup on long series (resolveBacktestWarmupFloor).
  // At that history the signal may still differ marginally from the full-history one (EMA200 needs
  // ~1000 bars), so the bound is a rate, not zero.
  for (const [name, key] of [['Confluencia', 'confluencia'], ['Standard', 'standard'], ['MFLS', 'mfls'], ['Multifractal', 'multifractal'], ['VCME', 'vcme']] as const) {
    test(`${name}: backtest converged warmup floor keeps signals within 10% of full history`, () => {
      for (const d of [equity5m, ...(engine(name).multiTimeframe ? [] : [crypto5m])]) {
        const floor = resolveBacktestWarmupFloor(key, d.primary.length, { interval: '5m', isCrypto: d === crypto5m });
        assert.ok(floor >= getStrategyConvergedWarmup(key));
        const [r] = runRecursiveAnalysis(engine(name), d, tail(d, 120), [floor]);
        assert.ok(r.signalMismatches <= Math.max(1, 0.1 * r.actionable),
          `${name} @${floor} (${d.symbol}): ${r.signalMismatches}/${r.actionable}`);
      }
    });
  }

  test('long series use the converged floor; short series keep the minimal one', () => {
    assert.strictEqual(resolveBacktestWarmupFloor('standard', 4680), 500);
    assert.strictEqual(resolveBacktestWarmupFloor('standard', 500), 199); // ≈ 2y of 1d
    assert.strictEqual(resolveBacktestWarmupFloor('scoring', 4680), 100);
    assert.strictEqual(resolveBacktestWarmupFloor('confluencia', 4680), 59);
    assert.strictEqual(resolveBacktestWarmupFloor('confluencia', 200), 30);
    assert.strictEqual(resolveBacktestWarmupFloor('confluencia', 4000, { interval: '5m', isCrypto: true }), 300);
    assert.strictEqual(resolveBacktestWarmupFloor('confluencia', 1000, { interval: '5m', isCrypto: true }), 30);
  });
});
