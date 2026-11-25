/**
 * Causality checks for the six strategy evaluators, inspired by freqtrade's
 * `lookahead-analysis` and `recursive-analysis`.
 *
 * - Lookahead: evaluating bar i on the full history must give exactly the same result as
 *   evaluating it on a history truncated at bar i (higher timeframes truncated to the bars
 *   already closed at the 5m close). Any difference means the evaluator reads the future.
 * - Recursive (history sensitivity): evaluating bar i with only `h` bars of history must give
 *   the same signal as with the full history. Recursive indicators (EMA, Wilder ATR/RSI/ADX)
 *   converge with history; if they have not converged at the backtest warmup floor, early
 *   backtest signals differ from what the live app (≈60 days of 5m) would emit.
 *
 * Shared by `causality.test.ts` (synthetic, deterministic) and `scripts/causality-analysis.ts`
 * (real Yahoo data in scratch/).
 */
import type { Kline } from '../../../services/api';
import {
  buildConfluenciaContext, evaluateConfluenciaAt,
  buildScoringContext, evaluateScoringAt,
  buildStandardVotingContext, evaluateStandardVotingAt,
  buildVCMESniperContext, evaluateVCMESniperAt,
  buildMultifractalMTFContext, evaluateMultifractalMTFAt,
  buildMFLSContext, evaluateMFLSAt,
} from '../../strategyEvaluators';
import { DEFAULT_WEIGHTS } from '../../indicators';

export interface MarketData {
  symbol: string;
  interval: '5m' | '1h';
  primary: Kline[];
  h1?: Kline[];
  d1?: Kline[];
}

export interface EngineAdapter {
  name: string;
  /** Needs 1h/1d context in addition to the primary series. */
  multiTimeframe: boolean;
  /** Evaluates every index in `indices` on one context built from `data`. */
  evaluateMany(data: MarketData, indices: number[]): unknown[];
}

const signalOf = (r: unknown): string => {
  const o = r as { signal?: string; finalSignal?: string };
  return o.signal ?? o.finalSignal ?? 'NEUTRAL';
};
export { signalOf };

export const isActionable = (r: unknown): boolean => {
  const s = signalOf(r);
  return s === 'BUY' || s === 'SELL';
};

export const ENGINES: EngineAdapter[] = [
  {
    name: 'Confluencia', multiTimeframe: false,
    evaluateMany: (d, idx) => { const c = buildConfluenciaContext(d.primary, d.interval, d.symbol); return idx.map(i => evaluateConfluenciaAt(c, i)); },
  },
  {
    name: 'Scoring', multiTimeframe: false,
    evaluateMany: (d, idx) => { const c = buildScoringContext(d.primary, d.interval, DEFAULT_WEIGHTS, d.symbol); return idx.map(i => evaluateScoringAt(c, i)); },
  },
  {
    name: 'Standard', multiTimeframe: false,
    evaluateMany: (d, idx) => { const c = buildStandardVotingContext(d.primary); return idx.map(i => evaluateStandardVotingAt(c, i)); },
  },
  {
    name: 'VCME', multiTimeframe: true,
    evaluateMany: (d, idx) => { const c = buildVCMESniperContext(d.primary, d.h1 ?? [], d.d1 ?? [], d.symbol, 'dayTrading'); return idx.map(i => evaluateVCMESniperAt(c, i)); },
  },
  {
    name: 'Multifractal', multiTimeframe: true,
    evaluateMany: (d, idx) => { const c = buildMultifractalMTFContext(d.primary, d.h1 ?? [], d.d1 ?? [], d.symbol); return idx.map(i => evaluateMultifractalMTFAt(c, i)); },
  },
  {
    name: 'MFLS', multiTimeframe: false,
    evaluateMany: (d, idx) => { const c = buildMFLSContext(d.primary, d.symbol); return idx.map(i => evaluateMFLSAt(c, i)); },
  },
];

const intervalSec = (interval: string) => (interval === '1h' ? 3600 : 300);

/** History as it existed when primary bar `i` closed (same closure rule the MTF evaluators use). */
export function truncateAt(data: MarketData, i: number): MarketData {
  const tClose = data.primary[i].time + intervalSec(data.interval);
  return {
    ...data,
    primary: data.primary.slice(0, i + 1),
    h1: data.h1?.filter(k => k.time + 3600 <= tClose),
    d1: data.d1?.filter(k => k.time + 86400 <= tClose),
  };
}

/** Last `h + 1` primary bars ending at bar i (higher timeframes untouched but closed-only). */
export function windowAt(data: MarketData, i: number, h: number): { data: MarketData; index: number } {
  const start = Math.max(0, i - h);
  const t = truncateAt(data, i);
  return { data: { ...t, primary: t.primary.slice(start) }, index: i - start };
}

/** Deep comparison with relative float tolerance. Returns the first differing path or null. */
export function firstDifference(a: unknown, b: unknown, path = '', tol = 1e-9): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return null;
    if (a === b) return null;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= tol * scale ? null : `${path || '<root>'}: ${a} ≠ ${b}`;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? null : `${path || '<root>'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, tol);
    if (d) return d;
  }
  return null;
}

export interface LookaheadReport {
  engine: string;
  checked: number;
  checkedSignals: number;
  biased: Array<{ index: number; diff: string; fullSignal: string; truncatedSignal: string }>;
}

/**
 * Freqtrade-style lookahead analysis: every actionable signal (up to `maxSignals`) plus a sample
 * of neutral bars is re-evaluated on the truncated history.
 */
export function runLookaheadAnalysis(
  engine: EngineAdapter, data: MarketData, fromIndex: number, opts: { maxSignals?: number; neutralSample?: number } = {}
): LookaheadReport {
  const { maxSignals = 40, neutralSample = 25 } = opts;
  const all = Array.from({ length: data.primary.length - fromIndex }, (_, k) => fromIndex + k);
  const full = engine.evaluateMany(data, all);
  const signals = all.filter((_, k) => isActionable(full[k]));
  const neutrals = all.filter((_, k) => !isActionable(full[k]));
  const pick = <T,>(arr: T[], n: number) => arr.length <= n ? arr : Array.from({ length: n }, (_, k) => arr[Math.floor(k * arr.length / n)]);
  const chosen = [...pick(signals, maxSignals), ...pick(neutrals, neutralSample)];

  const biased: LookaheadReport['biased'] = [];
  for (const i of chosen) {
    const fullRes = full[i - fromIndex];
    const truncated = engine.evaluateMany(truncateAt(data, i), [i])[0];
    const diff = firstDifference(fullRes, truncated);
    if (diff) biased.push({ index: i, diff, fullSignal: signalOf(fullRes), truncatedSignal: signalOf(truncated) });
  }
  return { engine: engine.name, checked: chosen.length, checkedSignals: Math.min(signals.length, maxSignals), biased };
}

export interface RecursiveReport {
  engine: string;
  history: number;
  checked: number;
  /** Bars where the actionable signal (BUY/SELL/NEUTRAL) differs from the full-history one. */
  signalMismatches: number;
  /** Actionable signals (in either version) among the checked bars. */
  actionable: number;
  examples: Array<{ index: number; full: string; short: string }>;
}

/**
 * Freqtrade-style recursive analysis: for bars `indices` (each with ≥ max(histories) of history),
 * compare the signal computed with only `h` bars of history against the full-history signal.
 */
export function runRecursiveAnalysis(engine: EngineAdapter, data: MarketData, indices: number[], histories: number[]): RecursiveReport[] {
  const full = engine.evaluateMany(data, indices);
  return histories.map(h => {
    let signalMismatches = 0, actionable = 0;
    const examples: RecursiveReport['examples'] = [];
    indices.forEach((i, k) => {
      const w = windowAt(data, i, h);
      const short = engine.evaluateMany(w.data, [w.index])[0];
      const a = signalOf(full[k]), b = signalOf(short);
      if (isActionable(full[k]) || isActionable(short)) actionable++;
      if (a !== b) {
        signalMismatches++;
        if (examples.length < 5) examples.push({ index: i, full: a, short: b });
      }
    });
    return { engine: engine.name, history: h, checked: indices.length, signalMismatches, actionable, examples };
  });
}

// ─── Deterministic synthetic market (NYSE-like 5m session + 1h/1d aggregates) ────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function aggregate(bars: Kline[], time: number): Kline {
  return {
    time,
    open: bars[0].open,
    high: Math.max(...bars.map(b => b.high)),
    low: Math.min(...bars.map(b => b.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((s, b) => s + b.volume, 0),
  };
}

/** One synthetic bar with regime-dependent volatility, momentum and volume spikes. */
function nextBar(rand: () => number, time: number, open: number, sigma: number, drift: number, baseVol: number): Kline {
  const r = drift + sigma * gaussian(rand);
  const close = open * Math.exp(r);
  const wick = () => Math.abs(gaussian(rand)) * sigma * 0.6;
  const high = Math.max(open, close) * (1 + wick());
  const low = Math.min(open, close) * (1 - wick());
  const spike = rand() < 0.04 ? 2.5 + 2 * rand() : 1;
  const volume = Math.round(baseVol * Math.exp(0.35 * gaussian(rand)) * spike * (1 + 30 * Math.abs(r)));
  return { time, open, high, low, close, volume };
}

/**
 * US equity on 5m: `sessions` NYSE-like sessions (09:30–16:00 EDT, weekdays from 2026-06-01),
 * Yahoo-style 1h bars (09:30, 10:30 … 15:30) and 1d bars stamped 09:30, preceded by
 * `priorDays` synthetic daily bars so EMA200(1d) is available.
 */
export function makeSyntheticEquity(seed: number, sessions = 45, priorDays = 230, symbol = 'SYNTH'): MarketData {
  const rand = mulberry32(seed);
  const DAY = 86400;
  const OPEN_UTC = 13 * 3600 + 30 * 60; // 09:30 EDT

  // Weekdays only, starting Monday 2026-06-01 (no DST change inside the sample window).
  const firstSession = Date.UTC(2026, 5, 1) / 1000;
  const priorStart = firstSession - Math.ceil(priorDays * 7 / 5 + 7) * DAY;
  const isWeekday = (t: number) => { const d = new Date(t * 1000).getUTCDay(); return d >= 1 && d <= 5; };

  let price = 80 + 60 * rand();
  const d1: Kline[] = [];
  for (let t = priorStart; t < firstSession; t += DAY) {
    if (!isWeekday(t)) continue;
    const bar = nextBar(rand, t + OPEN_UTC, price, 0.018, 0.0004 * gaussian(rand), 4e7);
    d1.push(bar);
    price = bar.close * Math.exp(0.004 * gaussian(rand));
  }
  const prior = d1.slice(-priorDays);
  d1.length = 0; d1.push(...prior);

  const primary: Kline[] = [];
  const h1: Kline[] = [];
  let produced = 0;
  for (let day = firstSession; produced < sessions; day += DAY) {
    if (!isWeekday(day)) continue;
    produced++;
    const sigmaDay = 0.0007 + 0.0035 * rand() ** 2;   // calm to very volatile sessions
    let drift = 0;
    price *= Math.exp(sigmaDay * 3 * gaussian(rand));  // overnight gap
    const session: Kline[] = [];
    for (let k = 0; k < 78; k++) {
      if (rand() < 0.08) drift = sigmaDay * 0.6 * gaussian(rand); // momentum regime switches
      const ushape = 1 + 1.4 * Math.exp(-k / 6) + 0.6 * Math.exp(-(77 - k) / 8);
      const bar = nextBar(rand, day + OPEN_UTC + k * 300, price, sigmaDay * ushape, drift, 9e4 * ushape);
      session.push(bar);
      price = bar.close;
    }
    primary.push(...session);
    for (let h = 0; h < 7; h++) {
      const chunk = session.slice(h * 12, Math.min(78, h * 12 + 12));
      h1.push(aggregate(chunk, chunk[0].time));
    }
    d1.push(aggregate(session, session[0].time));
  }
  return { symbol, interval: '5m', primary, h1, d1 };
}

/** Equity on 1h: the hourly series of a synthetic equity as primary. */
export function makeSyntheticEquity1h(seed: number, sessions = 160): MarketData {
  const eq = makeSyntheticEquity(seed, sessions, 30, 'SYNTH1H');
  return { symbol: 'SYNTH1H', interval: '1h', primary: eq.h1! };
}

/** 24/7 crypto on 5m. */
export function makeSyntheticCrypto(seed: number, bars = 3000): MarketData {
  const rand = mulberry32(seed);
  const start = Date.UTC(2026, 6, 1) / 1000;
  const primary: Kline[] = [];
  let price = 60000, drift = 0, sigma = 0.002;
  for (let k = 0; k < bars; k++) {
    if (rand() < 0.01) sigma = 0.0008 + 0.004 * rand();
    if (rand() < 0.06) drift = sigma * 0.6 * gaussian(rand);
    const bar = nextBar(rand, start + k * 300, price, sigma, drift, 150);
    primary.push(bar);
    price = bar.close;
  }
  return { symbol: 'BTCUSDT', interval: '5m', primary };
}
