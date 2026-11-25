/**
 * scripts/engine-agreement.ts
 *
 * ¿Varias señales exploratorias de enfoques distintos activas a la vez en un papel (acciones 5m)
 * valen más que una sola? Diseño fijado ANTES de ver resultados (2026-11-25):
 *
 *  - Universo: los 106 papeles de scratch/fresh-5m-20261015. 5m unidos de fresh-5m-20261015,
 *    -20261110 y -20261125 (descarga nueva); 1h/1d de h1-/d1-20261125 (descarga nueva).
 *  - Vela elegible: sesión regular NYSE, la siguiente vela es del mismo día (entrada a su apertura),
 *    no es la vela de cierre de sesión, índice ≥ 300 (calentamiento).
 *  - En cada vela se evalúan los seis motores con la semántica en vivo (dayTrading, agresivo, pesos
 *    por defecto). PRIMARIO: k = cantidad de motores INFORMATIVOS (Estándar, Scoring, VCME,
 *    Multifractal, MFLS) en la misma dirección, sin ninguno en contra. SECUNDARIO: los seis.
 *    Velas con motores en direcciones opuestas se informan aparte.
 *  - Mecánica de salida idéntica para todos los grupos (aisla la información de la señal):
 *    niveles calculateAlertLevels('confluencia'), horizonte canónico de Confluencia, viabilidad
 *    por fricción, costo 0,11% + 0,03% de deslizamiento. Una posición a la vez por papel y grupo.
 *  - IC 95% por bootstrap agrupado por día (2000 repeticiones).
 *  - Control al azar: por cada operación, una vela elegible del mismo papel y mismo día, en o
 *    después de la señal (sin fuga), misma dirección. 200 repeticiones; p = fracción ≥ real.
 *  - Descubrimiento: sesiones ≤ 2026-10-14 (el período de toda la investigación previa).
 *    Fuera de muestra (OOS): sesiones ≥ 2026-10-15. No hay papeles nunca vistos: OOS sólo temporal.
 *  - Criterio para aceptar (todos):
 *     1. Descubrimiento: E[R]neto(k≥2) − E[R]neto(k=1) ≥ +0,10R y el IC 95% de la diferencia > 0.
 *     2. OOS: diferencia > 0 y ≥ la mitad de la de descubrimiento.
 *     3. OOS: E[R]neto(k≥2) > 0.
 *     4. OOS: k≥2 supera al control al azar con p < 0,05.
 *     5. n(k≥2) ≥ 100 operaciones en cada período.
 *  - Descriptivo (no decide): ventana 09:35–10:55, correlación direccional entre pares de motores.
 * Sólo investigación: no cambia nada de la app.
 *
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/engine-agreement.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries, isNyseOpeningHour, isNyseSessionClosingCandle, isNyseTradingSessionActive, DEFAULT_WEIGHTS } from '../src/utils/indicators';
import {
  buildConfluenciaContext, evaluateConfluenciaAt, buildScoringContext, evaluateScoringAt,
  buildStandardVotingContext, evaluateStandardVotingAt, buildVCMESniperContext, evaluateVCMESniperAt,
  buildMultifractalMTFContext, evaluateMultifractalMTFAt, buildMFLSContext, evaluateMFLSAt,
} from '../src/utils/strategyEvaluators';
import { getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const COST = 0.11, SLIPPAGE = 0.03, WARM = 300, N_BOOT = 2000, N_RAND = 200;
const LIST = 'scratch/fresh-5m-20261015';
const DIRS_5M = ['scratch/fresh-5m-20261015', 'scratch/fresh-5m-20261110', 'scratch/fresh-5m-20261125'];
const DIR_1H = 'scratch/h1-20261125', DIR_1D = 'scratch/d1-20261125';
const SPLIT = 20261014;
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };

let seed = 20261125;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

async function get(symbol: string, range: string, interval: string, stepSec: number, out: string) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
  if (!res.ok) return `HTTP ${res.status}`;
  const j: any = await res.json(); const r = j.chart?.result?.[0]; if (!r?.timestamp) return 'sin datos';
  const q = r.indicators.quote[0]; const k: Kline[] = []; const nowSec = Date.now() / 1000;
  r.timestamp.forEach((t: number, i: number) => { const b = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
    if ([b.open, b.high, b.low, b.close].every(v => typeof v === 'number' && Number.isFinite(v)) && t + stepSec <= nowSec && (stepSec !== 300 || t % 300 === 0)) k.push(b as Kline); });
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${symbol}.json`), JSON.stringify(k));
  return `${k.length}`;
}
async function ensureData(symbols: string[]) {
  for (const s of symbols) {
    const need = [[DIRS_5M[2], '60d', '5m', 300], [DIR_1H, '730d', '1h', 3600], [DIR_1D, '5y', '1d', 86400]] as const;
    for (const [dir, range, iv, step] of need) {
      if (fs.existsSync(path.join(dir, s + '.json'))) continue;
      const r = await get(s, range, iv, step, dir).catch(e => 'ERR ' + e.message);
      if (!/^\d+$/.test(r)) console.error(s, iv, r);
      await new Promise(res => setTimeout(res, 250));
    }
  }
}
function load5m(sym: string): Kline[] {
  const byTime = new Map<number, Kline>();
  for (const d of DIRS_5M) { const f = path.join(d, sym + '.json'); if (!fs.existsSync(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(f, 'utf-8')) as Kline[]) byTime.set(b.time, b); }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
const loadJ = (d: string, s: string): Kline[] => { const f = path.join(d, s + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : []; };

type Dir = 'BUY' | 'SELL';
const ENGINES = ['standard', 'scoring', 'vcme', 'multifractal', 'mfls', 'confluencia'] as const;
type Eng = typeof ENGINES[number];
const INFO: Eng[] = ['standard', 'scoring', 'vcme', 'multifractal', 'mfls'];
const dirOf = (s: string): Dir | null => s.includes('BUY') ? 'BUY' : s.includes('SELL') ? 'SELL' : null;

interface Cand { i: number; day: number; sig: Record<Eng, Dir | null>; window: boolean }
interface Trade { sym: string; day: number; i: number; dir: Dir; r: number; g: number; group: string; set: 'INFO' | 'ALL'; window: boolean; randR: Float32Array }

const SYMBOLS = fs.readdirSync(LIST).map(f => f.replace(".json", "")).slice(0, Number(process.env.AGREE_LIMIT ?? 1e9));
await ensureData(SYMBOLS);
const fw = getStrategyForwardWindow('confluencia', '5m', undefined, false);
const trades: Trade[] = [];
const pairAgree: Record<string, { both: number; same: number }> = {};
const signalCount: Record<string, number> = {};
let candlesTotal = 0;
const conflict: Record<'INFO' | 'ALL', number> = { INFO: 0, ALL: 0 };

for (const sym of SYMBOLS) {
  const k = load5m(sym), h1 = loadJ(DIR_1H, sym), d1 = loadJ(DIR_1D, sym);
  if (k.length < 1000 || h1.length < 200 || d1.length < 200) { console.error('skip', sym); continue; }
  const atr = calculateATRSeries(k, 14);
  const ctx = {
    confluencia: buildConfluenciaContext(k, '5m', false),
    scoring: buildScoringContext(k, '5m', DEFAULT_WEIGHTS, false),
    standard: buildStandardVotingContext(k),
    vcme: buildVCMESniperContext(k, h1, d1, sym, 'dayTrading', 'agresivo'),
    multifractal: buildMultifractalMTFContext(k, h1, d1, sym),
    mfls: buildMFLSContext(k, false),
  };
  const outcomeCache = new Map<string, { r: number; g: number; exitIdx: number } | null>();
  const outcome = (i: number, dir: Dir) => {
    const key = `${i}|${dir}`; if (outcomeCache.has(key)) return outcomeCache.get(key)!;
    const entry = k[i + 1].open;
    const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(dir, entry, '5m', atr[i], 'confluencia', { isCrypto: false }) };
    let res: { r: number; g: number; exitIdx: number } | null = null;
    if (isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
      const sim = simulateTrade(k, i, dir, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE, frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
      const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
      res = { r: (sim.pnlPct - COST) / riskPct, g: sim.grossPnlPct / riskPct, exitIdx: sim.exitIdx };
    }
    outcomeCache.set(key, res); return res;
  };

  const cands: Cand[] = [];
  const eligibleByDay = new Map<number, number[]>();
  for (let i = WARM; i < k.length - 2; i++) {
    const tMs = k[i].time * 1000; const day = dk(k[i].time);
    if (dk(k[i + 1].time) !== day || !isNyseTradingSessionActive(tMs) || isNyseSessionClosingCandle(k[i].time, '5m', sym)) continue;
    candlesTotal++;
    if (!eligibleByDay.has(day)) eligibleByDay.set(day, []); eligibleByDay.get(day)!.push(i);
    const sig: Record<Eng, Dir | null> = {
      standard: dirOf(evaluateStandardVotingAt(ctx.standard, i).signal),
      scoring: dirOf(evaluateScoringAt(ctx.scoring, i).signal),
      vcme: dirOf(evaluateVCMESniperAt(ctx.vcme, i).signal),
      multifractal: dirOf(evaluateMultifractalMTFAt(ctx.multifractal, i).signal),
      mfls: dirOf(evaluateMFLSAt(ctx.mfls, i).signal),
      confluencia: dirOf(evaluateConfluenciaAt(ctx.confluencia, i).signal),
    };
    for (const e of ENGINES) if (sig[e]) signalCount[e] = (signalCount[e] ?? 0) + 1;
    for (let a = 0; a < ENGINES.length; a++) for (let b = a + 1; b < ENGINES.length; b++) {
      const ea = ENGINES[a], eb = ENGINES[b]; if (!sig[ea] || !sig[eb]) continue;
      const key = `${ea}+${eb}`; pairAgree[key] ??= { both: 0, same: 0 }; pairAgree[key].both++; if (sig[ea] === sig[eb]) pairAgree[key].same++;
    }
    cands.push({ i, day, sig, window: isNyseOpeningHour(tMs) });
  }

  for (const set of ['INFO', 'ALL'] as const) {
    const engines = set === 'INFO' ? INFO : [...ENGINES];
    const next: Record<string, number> = {};
    for (const c of cands) {
      const nb = engines.filter(e => c.sig[e] === 'BUY').length, ns = engines.filter(e => c.sig[e] === 'SELL').length;
      if (nb === 0 && ns === 0) continue;
      if (nb > 0 && ns > 0) { conflict[set]++; continue; }
      const dir: Dir = nb > 0 ? 'BUY' : 'SELL'; const n = Math.max(nb, ns);
      const group = n === 1 ? 'k=1' : n === 2 ? 'k=2' : 'k≥3';
      if (c.i < (next[group] ?? 0)) continue;
      const o = outcome(c.i, dir); if (!o) continue;
      next[group] = Math.max(c.i + 1, o.exitIdx);
      const pool = (eligibleByDay.get(c.day) ?? []).filter(j => j >= c.i);
      const randR = new Float32Array(N_RAND);
      for (let rep = 0; rep < N_RAND; rep++) { const j = pool[Math.floor(rand() * pool.length)]; const ro = outcome(j, dir); randR[rep] = ro ? ro.r : NaN; }
      trades.push({ sym, day: c.day, i: c.i, dir, r: o.r, g: o.g, group, set, window: c.window, randR });
    }
  }
  console.error(`ok ${sym} (${trades.length})`);
}

// ── estadística ──
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const byDay = (g: Trade[]) => { const m = new Map<number, Trade[]>(); for (const t of g) { if (!m.has(t.day)) m.set(t.day, []); m.get(t.day)!.push(t); } return [...m.values()]; };
function bootDiff(a: Trade[], b: Trade[] | null): [number, number] {
  const da = byDay(a), db = b ? byDay(b) : null; const out: number[] = [];
  for (let r = 0; r < N_BOOT; r++) {
    const sa: number[] = []; for (let x = 0; x < da.length; x++) sa.push(...da[Math.floor(rand() * da.length)].map(t => t.r));
    let v = mean(sa);
    if (db) { const sb: number[] = []; for (let x = 0; x < db.length; x++) sb.push(...db[Math.floor(rand() * db.length)].map(t => t.r)); v -= mean(sb); }
    out.push(v);
  }
  out.sort((x, y) => x - y); return [out[Math.floor(0.025 * N_BOOT)], out[Math.floor(0.975 * N_BOOT)]];
}
function randP(g: Trade[]): { ctrl: number; p: number } {
  const real = mean(g.map(t => t.r)); let ge = 0; const ctrls: number[] = [];
  for (let rep = 0; rep < N_RAND; rep++) { const v = g.map(t => t.randR[rep]).filter(Number.isFinite); const m = mean(v); ctrls.push(m); if (m >= real) ge++; }
  return { ctrl: mean(ctrls), p: ge / N_RAND };
}
const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);
function line(label: string, g: Trade[]) {
  if (g.length < 5) return `${label.padEnd(10)} n=${g.length}`;
  const [lo, hi] = bootDiff(g, null); const { ctrl, p } = randP(g);
  const wr = 100 * g.filter(t => t.r > 0).length / g.length;
  return `${label.padEnd(10)} n=${String(g.length).padStart(5)}  neto ${f(mean(g.map(t => t.r)))} [${f(lo)}, ${f(hi)}]  bruto ${f(mean(g.map(t => t.g)))}  WR ${wr.toFixed(0)}%  azar ${f(ctrl)} p=${p.toFixed(3)}`;
}
const days = [...new Set(trades.map(t => t.day))].sort((a, b) => a - b);
console.log(`Papeles ${SYMBOLS.length}, sesiones ${days.length} (${days[0]}–${days.at(-1)}), velas elegibles ${candlesTotal}`);
console.log(`Descubrimiento ≤ ${SPLIT} (${days.filter(d => d <= SPLIT).length} sesiones) | OOS > ${SPLIT} (${days.filter(d => d > SPLIT).length} sesiones)\n`);
console.log('Velas con señal por motor:', JSON.stringify(signalCount));
console.log('Velas con motores en conflicto:', JSON.stringify(conflict), '\n');

const verdict: string[] = [];
for (const set of ['INFO', 'ALL'] as const) {
  console.log(`=== ${set === 'INFO' ? 'PRIMARIO: 5 motores informativos' : 'SECUNDARIO: los 6 motores'} ===`);
  const diffs: Record<string, number> = {};
  for (const [pname, inP] of [['DESCUBRIMIENTO', (d: number) => d <= SPLIT], ['OOS', (d: number) => d > SPLIT]] as const) {
    const P = trades.filter(t => t.set === set && inP(t.day));
    console.log(`-- ${pname}`);
    for (const g of ['k=1', 'k=2', 'k≥3']) console.log('  ' + line(g, P.filter(t => t.group === g)));
    const k1 = P.filter(t => t.group === 'k=1'), k2 = P.filter(t => t.group !== 'k=1');
    console.log('  ' + line('k≥2', k2));
    const d = mean(k2.map(t => t.r)) - mean(k1.map(t => t.r)); const [lo, hi] = bootDiff(k2, k1); diffs[pname] = d;
    console.log(`  diferencia k≥2 − k=1: ${f(d)} [${f(lo)}, ${f(hi)}]`);
    console.log('  ventana 09:35–10:55 (descriptivo):');
    for (const g of ['k=1', 'k=2', 'k≥3']) console.log('    ' + line(g, P.filter(t => t.group === g && t.window)));
    if (set === 'INFO') {
      if (pname === 'DESCUBRIMIENTO') { verdict.push(`1. desc. dif ${f(d)} ≥ +0,10 y IC>0: ${d >= 0.10 && lo > 0 ? 'PASA' : 'NO'}`); verdict.push(`5a. n(k≥2) desc ${k2.length} ≥ 100: ${k2.length >= 100 ? 'PASA' : 'NO'}`); }
      else {
        const m2 = mean(k2.map(t => t.r)); const { p } = randP(k2);
        verdict.push(`2. OOS dif ${f(d)} > 0 y ≥ mitad de desc (${f(diffs['DESCUBRIMIENTO'] / 2)}): ${d > 0 && d >= diffs['DESCUBRIMIENTO'] / 2 ? 'PASA' : 'NO'}`);
        verdict.push(`3. OOS E[R] k≥2 ${f(m2)} > 0: ${m2 > 0 ? 'PASA' : 'NO'}`);
        verdict.push(`4. OOS k≥2 vs azar p=${p.toFixed(3)} < 0,05: ${p < 0.05 ? 'PASA' : 'NO'}`);
        verdict.push(`5b. n(k≥2) OOS ${k2.length} ≥ 100: ${k2.length >= 100 ? 'PASA' : 'NO'}`);
      }
    }
  }
  console.log();
}
console.log('Acuerdo direccional entre pares (cuando ambos dan señal):');
for (const [kk, v] of Object.entries(pairAgree).sort((a, b) => b[1].both - a[1].both)) console.log(`  ${kk.padEnd(26)} ambos ${String(v.both).padStart(6)}  misma dirección ${(100 * v.same / v.both).toFixed(0)}%`);
console.log('\nVEREDICTO (primario):\n  ' + verdict.join('\n  '));
