/**
 * scripts/scoring-sr-anchor.ts
 *
 * Scoring computes S/R from a checkpoint every 5 candles counted from the start of the array
 * (srCache, cacheIdx = floor(i/5)*5), so the same candle can get a different signal depending on
 * where the downloaded window starts. Compares, net of costs with the app backtest
 * (runBacktestGenericOptimized), three variants:
 *  - ACTUAL:  current behaviour.
 *  - TIEMPO:  same 5-candle cadence, grid anchored to the candle time (floor(time/step) % 5 == 0).
 *  - VELA:    S/R recomputed on every candle (no staleness).
 * For each variant: signals, E[R] net in two independent halves, and phase stability (share of
 * signals that change when the series starts 1–4 candles later). Research only.
 *
 * Usage: npx tsx --tsconfig tsconfig.execution-tests.json scripts/scoring-sr-anchor.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { buildScoringContext, evaluateScoringAt, type ScoringSRCacheItem } from '../src/utils/strategyEvaluators';
import { DEFAULT_WEIGHTS, calculateRawPivotLevels } from '../src/utils/indicators';
import { runBacktestGenericOptimized } from '../src/utils/backtester';

type Variant = 'ACTUAL' | 'TIEMPO' | 'VELA';
type Sig = 'BUY' | 'SELL' | 'NEUTRAL';
const VARIANTS: Variant[] = ['ACTUAL', 'TIEMPO', 'VELA'];

function srAt(klines: Kline[], j: number): ScoringSRCacheItem {
  const { pivotHighs, pivotLows } = calculateRawPivotLevels(klines.slice(Math.max(0, j - 100), j + 1), 5);
  return { pivotHighs, pivotLows } as ScoringSRCacheItem;
}

function signals(klines: Kline[], interval: string, symbol: string, variant: Variant): Sig[] {
  const out: Sig[] = new Array(klines.length).fill('NEUTRAL');
  if (klines.length < 60) return out;
  const ctx = buildScoringContext(klines, interval, DEFAULT_WEIGHTS, symbol);
  const step = interval === '1h' ? 3600 : 300;
  let current: ScoringSRCacheItem | undefined;
  let checkpoint = -1;
  if (variant !== 'ACTUAL') {
    ctx.srCache = { get: () => current } as unknown as Map<number, ScoringSRCacheItem>;
  }
  for (let i = 59; i < klines.length; i++) {
    if (variant === 'VELA') current = srAt(klines, i);
    if (variant === 'TIEMPO' && Math.floor(klines[i].time / step) % 5 === 0) {
      checkpoint = i; current = srAt(klines, i);
    }
    if (variant === 'TIEMPO' && checkpoint < 0) { current = undefined; }
    const r = evaluateScoringAt(ctx, i);
    out[i] = r.signal === 'HOLD' ? 'NEUTRAL' : r.signal;
  }
  return out;
}

const load = (dir: string, s: string) => JSON.parse(fs.readFileSync(path.join(dir, `${s}.json`), 'utf8')) as Kline[];

interface Dataset { label: string; dir: string; interval: '5m' | '1h'; chunk: number }
const DATASETS: Dataset[] = [
  { label: 'Acciones 5m', dir: 'scratch/fresh-5m-20261103', interval: '5m', chunk: 2340 },
  { label: 'Cripto 5m', dir: 'scratch/crypto-5m-20261104', interval: '5m', chunk: 4000 },
  { label: 'Acciones 1h', dir: 'scratch/h1-20261015', interval: '1h', chunk: 2540 },
  { label: 'Cripto 1h', dir: 'scratch/crypto-1h-20261104', interval: '1h', chunk: 2000 },
];

for (const ds of DATASETS) {
  const symbols = fs.readdirSync(ds.dir).map(f => f.replace('.json', ''));
  const agg: Record<Variant, { n: number[]; sumR: number[]; phaseMism: number; phaseAct: number; agree: number; act: number }> =
    Object.fromEntries(VARIANTS.map(v => [v, { n: [0, 0], sumR: [0, 0], phaseMism: 0, phaseAct: 0, agree: 0, act: 0 }])) as never;

  for (const sym of symbols) {
    const all = load(ds.dir, sym);
    if (all.length < ds.chunk * 2 - 50) continue;
    const halves = [all.slice(-2 * ds.chunk, -ds.chunk), all.slice(-ds.chunk)];
    halves.forEach((k, h) => {
      const base = signals(k, ds.interval, sym, 'ACTUAL');
      for (const v of VARIANTS) {
        const s = v === 'ACTUAL' ? base : signals(k, ds.interval, sym, v);
        const bt = runBacktestGenericOptimized(k, ds.interval, s, 'scoring', sym);
        const a = agg[v];
        a.n[h] += bt.totalSignals; a.sumR[h] += bt.totalSignals * bt.expectancyR;
        for (let i = 100; i < k.length; i++) {
          if (s[i] !== 'NEUTRAL' || base[i] !== 'NEUTRAL') { a.act++; if (s[i] === base[i]) a.agree++; }
        }
        // Phase stability: start the series 1–4 candles later and compare the last 1000 candles.
        for (const shift of [1, 2, 3, 4]) {
          const shifted = signals(k.slice(shift), ds.interval, sym, v);
          for (let i = k.length - 1000; i < k.length; i++) {
            const x = s[i], y = shifted[i - shift];
            if (x !== 'NEUTRAL' || y !== 'NEUTRAL') { a.phaseAct++; if (x !== y) a.phaseMism++; }
          }
        }
      }
    });
    process.stdout.write('.');
  }
  console.log(`\n${ds.label} (${symbols.length} símbolos, 2 mitades independientes)`);
  for (const v of VARIANTS) {
    const a = agg[v];
    const er = (h: number) => (a.n[h] ? a.sumR[h] / a.n[h] : 0).toFixed(3);
    const tot = a.n[0] + a.n[1];
    console.log(`  ${v.padEnd(7)} trades ${String(a.n[0]).padStart(5)} / ${String(a.n[1]).padStart(5)}  E[R] ${er(0).padStart(7)} / ${er(1).padStart(7)}  total ${((a.sumR[0] + a.sumR[1]) / Math.max(1, tot)).toFixed(3).padStart(7)}`
      + `  igual a ACTUAL ${(100 * a.agree / Math.max(1, a.act)).toFixed(0)}%  cambia por fase ${(100 * a.phaseMism / Math.max(1, a.phaseAct)).toFixed(1)}%`);
  }
}
