/**
 * scripts/causality-analysis.ts
 *
 * Freqtrade-style lookahead + recursive analysis of the six engines on real Yahoo data
 * (scratch/, gitignored). Research only: changes nothing in the app.
 *
 * - LOOKAHEAD: every actionable signal (≤ 40 per symbol/engine) plus 25 neutral bars is
 *   re-evaluated on history truncated at that bar (1h/1d truncated to bars already closed).
 *   Any difference in the evaluator output = the engine reads the future.
 * - RECURSIVE: for bars in the last 25 sessions, the signal computed with only H bars of
 *   history is compared with the full-history signal (what the live app sees with ~60 days of
 *   5m / 730 days of 1h). The share of actionable signals that change at the backtest warmup
 *   floor tells how much early backtest bars differ from live.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.execution-tests.json scripts/causality-analysis.ts [maxSymbols]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import {
  ENGINES, runLookaheadAnalysis, runRecursiveAnalysis, type MarketData, type RecursiveReport,
} from '../src/utils/__tests__/helpers/causality';
import { getStrategySignalWarmup } from '../src/utils/backtester';

const DIR_5M = 'scratch/fresh-5m-20261015';
const DIR_1H = 'scratch/h1-20261015';
const DIR_1D = 'scratch/d1-20261015';
const maxSymbols = Number(process.argv[2] ?? 40);

const load = (dir: string, s: string): Kline[] | null => {
  const f = path.join(dir, `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) as Kline[] : null;
};

const symbols = fs.readdirSync(DIR_5M).map(f => f.replace('.json', ''))
  .filter(s => fs.existsSync(path.join(DIR_1H, `${s}.json`)) && fs.existsSync(path.join(DIR_1D, `${s}.json`)))
  .slice(0, maxSymbols);

const warmupOf = (engine: string) => getStrategySignalWarmup(engine.toLowerCase());
const HISTORIES = [30, 59, 100, 199, 300, 500, 1000];

const lookahead = new Map<string, { checked: number; signals: number; biased: number; example?: string }>();
const recursive = new Map<string, Map<number, { mism: number; act: number }>>();
const addRec = (key: string, rs: RecursiveReport[]) => {
  const m = recursive.get(key) ?? new Map();
  for (const r of rs) {
    const cur = m.get(r.history) ?? { mism: 0, act: 0 };
    cur.mism += r.signalMismatches; cur.act += r.actionable;
    m.set(r.history, cur);
  }
  recursive.set(key, m);
};

const t0 = Date.now();
for (const sym of symbols) {
  const h1 = load(DIR_1H, sym)!, d1 = load(DIR_1D, sym)!;
  const lastClosed1h = h1[h1.length - 1].time + 3600;
  const k5 = load(DIR_5M, sym)!.filter(k => k.time + 300 <= lastClosed1h);
  if (k5.length < 2500) continue;
  // Same higher-timeframe start for full and truncated runs; ~1500 1h / 400 1d bars is plenty
  // for EMA200 and keeps each rebuild fast.
  const eq5: MarketData = { symbol: sym, interval: '5m', primary: k5, h1: h1.slice(-1500), d1: d1.slice(-400) };
  const eq1h: MarketData = { symbol: sym, interval: '1h', primary: h1 };

  for (const e of ENGINES) {
    const r = runLookaheadAnalysis(e, eq5, 220);
    const key = `5m ${e.name}`;
    const cur = lookahead.get(key) ?? { checked: 0, signals: 0, biased: 0 };
    cur.checked += r.checked; cur.signals += r.checkedSignals; cur.biased += r.biased.length;
    if (!cur.example && r.biased[0]) cur.example = `${sym}@${r.biased[0].index} ${r.biased[0].diff}`;
    lookahead.set(key, cur);

    const idx = Array.from({ length: 80 }, (_, k) => k5.length - 25 * 78 + Math.floor(k * (25 * 78 - 1) / 80));
    addRec(key, runRecursiveAnalysis(e, eq5, idx, HISTORIES));
  }
  for (const e of ENGINES.filter(x => ['Confluencia', 'Scoring', 'Standard'].includes(x.name))) {
    const r = runLookaheadAnalysis(e, eq1h, 220);
    const key = `1h ${e.name}`;
    const cur = lookahead.get(key) ?? { checked: 0, signals: 0, biased: 0 };
    cur.checked += r.checked; cur.signals += r.checkedSignals; cur.biased += r.biased.length;
    if (!cur.example && r.biased[0]) cur.example = `${sym}@${r.biased[0].index} ${r.biased[0].diff}`;
    lookahead.set(key, cur);

    const idx = Array.from({ length: 80 }, (_, k) => h1.length - 1200 + Math.floor(k * 1199 / 80));
    addRec(key, runRecursiveAnalysis(e, eq1h, idx, HISTORIES));
  }
  process.stdout.write('.');
}
console.log(`\n${symbols.length} símbolos, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);

console.log('LOOKAHEAD (salida del evaluador distinta con historia truncada)');
for (const [k, v] of lookahead) {
  console.log(`  ${k.padEnd(16)} revisadas ${String(v.checked).padStart(5)}  señales ${String(v.signals).padStart(5)}  con sesgo ${v.biased}${v.example ? `  ej: ${v.example}` : ''}`);
}

console.log('\nRECURSIVE (% de señales accionables que cambian con H velas de historia vs historia completa)');
console.log(`  ${''.padEnd(16)} warmup ${HISTORIES.map(h => `H=${h}`.padStart(9)).join('')}`);
for (const [k, m] of recursive) {
  const engine = k.split(' ')[1];
  const cells = HISTORIES.map(h => {
    const v = m.get(h)!;
    return (v.act ? `${(100 * v.mism / v.act).toFixed(0)}%/${v.act}` : '–').padStart(9);
  });
  console.log(`  ${k.padEnd(16)} ${String(warmupOf(engine)).padStart(6)} ${cells.join('')}`);
}
