/**
 * scripts/warmup-floor-impact.ts
 *
 * Backtests of every engine on real 5m equities (scratch/, gitignored) and real 1h/1d context,
 * printed as aggregate signals / E[R] net. Run before and after changing backtest warmup
 * floors to measure their effect. Research only.
 *
 * Usage: npx tsx --tsconfig tsconfig.execution-tests.json scripts/warmup-floor-impact.ts [maxSymbols] [out.json]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { backtestStandard, backtestConfluencia, backtestScoring, backtestMultitemporal, backtestMultifractalMTF, backtestMFLS, type BacktestResult } from '../src/utils/backtester';
import { DEFAULT_WEIGHTS } from '../src/utils/indicators';

const DIR_5M = 'scratch/fresh-5m-20261015', DIR_1H = 'scratch/h1-20261015', DIR_1D = 'scratch/d1-20261015';
const maxSymbols = Number(process.argv[2] ?? 30);
const out = process.argv[3];
const load = (d: string, s: string) => JSON.parse(fs.readFileSync(path.join(d, `${s}.json`), 'utf8')) as Kline[];
const symbols = fs.readdirSync(DIR_5M).map(f => f.replace('.json', ''))
  .filter(s => fs.existsSync(path.join(DIR_1H, `${s}.json`)) && fs.existsSync(path.join(DIR_1D, `${s}.json`))).slice(0, maxSymbols);

const engines: Record<string, (k5: Kline[], h1: Kline[], d1: Kline[], s: string) => BacktestResult> = {
  Confluencia: (k, _h, _d, s) => backtestConfluencia(k, '5m', s),
  Scoring: (k, _h, _d, s) => backtestScoring(k, '5m', DEFAULT_WEIGHTS, s),
  Standard: (k, _h, _d, s) => backtestStandard(k, '5m', s),
  VCME: (k, h, d, s) => backtestMultitemporal(k, h, d, '5m', s, 'dayTrading'),
  Multifractal: (k, h, d, s) => backtestMultifractalMTF(k, h, d, '5m', s),
  MFLS: (k, _h, _d, s) => backtestMFLS(k, '5m', s),
};
const rows: Record<string, Record<string, { n: number; er: number; label: string }>> = {};
for (const s of symbols) {
  const h1 = load(DIR_1H, s), d1 = load(DIR_1D, s);
  const k5 = load(DIR_5M, s).filter(k => k.time + 300 <= h1[h1.length - 1].time + 3600);
  rows[s] = {};
  for (const [name, fn] of Object.entries(engines)) {
    const r = fn(k5, h1, d1, s);
    rows[s][name] = { n: r.totalSignals, er: r.expectancyR, label: r.label };
  }
}
console.log(`${symbols.length} símbolos 5m`);
for (const name of Object.keys(engines)) {
  let n = 0, sumR = 0;
  for (const s of symbols) { const r = rows[s][name]; n += r.n; sumR += r.n * r.er; }
  console.log(`  ${name.padEnd(12)} señales ${String(n).padStart(5)}  E[R] neta ${(n ? sumR / n : 0).toFixed(3)}  (ej. ${rows[symbols[0]][name].label})`);
}
if (out) fs.writeFileSync(out, JSON.stringify(rows));
