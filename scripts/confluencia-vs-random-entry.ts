/**
 * scripts/confluencia-vs-random-entry.ts
 *
 * ¿La señal de Confluencia aporta algo, o lo que se ve en acciones 5m viene de la ventana horaria,
 * del filtro ATR y de las reglas de salida? Compara las operaciones reales de Confluencia contra
 * entradas al azar con EXACTAMENTE la misma mecánica (niveles calculateAlertLevels, horizonte
 * canónico, costo 0,11% + 0,03% de deslizamiento, una posición a la vez por papel en lo real).
 *
 * Diseño fijado antes de ver resultados:
 *  - Vela elegible: abre 09:35–10:55 ET (isNyseOpeningHour), ATR(14) ≥ 0,5% del precio, la vela
 *    siguiente (entrada a su apertura) es del mismo día y el stop es viable por fricción.
 *  - Azar A (timing): por cada operación real, una vela elegible al azar del mismo papel, mismo día
 *    y misma dirección. CORRECCIÓN tras la primera corrida: tal como se prerregistró, A podía entrar
 *    ANTES de la señal en la dirección que la señal ya conocía (fuga de información: +0,13R bruto
 *    inalcanzable). Ahora A sólo usa velas en o después de la señal; las anteriores se informan
 *    aparte como diagnóstico ("A antes"), no como comparación válida.
 *  - Azar B (dirección): la misma vela con la dirección contraria (determinista).
 *  - Azar C (todo): por cada operación real, una vela elegible al azar del mismo papel en cualquier
 *    día, con dirección al azar.
 *  - 2000 repeticiones de A y C; p = fracción de repeticiones con E[R] ≥ el real (una cola).
 *  - IC del real por bootstrap agrupado por día (las alertas del mismo día están correlacionadas).
 *  - Cortes: mitades temporales y watchlist del usuario / resto.
 * No incluye el veto por historial tóxico por papel de la app. Sólo investigación.
 *
 * Datos: une scratch/fresh-5m-20261015, scratch/fresh-5m-20261021 y una descarga nueva de 60 días
 * (scratch/fresh-5m-<hoy>, se baja si no existe).
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/confluencia-vs-random-entry.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries, isNyseOpeningHour } from '../src/utils/indicators';
import { computeConfluenciaSignalsSeries, getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const COST = 0.11, SLIPPAGE = 0.03, MIN_ATR_PCT = 0.5, N_REP = 2000, WARM = 30;
const OLD_DIRS = ['scratch/fresh-5m-20261015', 'scratch/fresh-5m-20261021'];
const today = new Date(); const tag = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const NEW_DIR = `scratch/fresh-5m-${tag}`;
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };

// Generador reproducible (mulberry32)
let seed = 20261103;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

async function ensureNewData() {
  if (fs.existsSync(NEW_DIR) && fs.readdirSync(NEW_DIR).length > 50) return;
  fs.mkdirSync(NEW_DIR, { recursive: true });
  const nowSec = Date.now() / 1000;
  for (const s of fs.readdirSync(OLD_DIRS[1]).map(f => f.replace('.json', ''))) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=60d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
      if (!res.ok) { console.log(s, 'HTTP', res.status); continue; }
      const j: any = await res.json(); const r = j.chart?.result?.[0]; if (!r?.timestamp) continue;
      const q = r.indicators.quote[0]; const k: Kline[] = [];
      r.timestamp.forEach((t: number, i: number) => { const b = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
        if ([b.open, b.high, b.low, b.close].every(v => typeof v === 'number' && Number.isFinite(v)) && t % 300 === 0 && t + 300 <= nowSec) k.push(b as Kline); });
      fs.writeFileSync(path.join(NEW_DIR, `${s}.json`), JSON.stringify(k));
    } catch (e) { console.log(s, 'ERR', (e as Error).message); }
    await new Promise(r => setTimeout(r, 300));
  }
}

function loadMerged(sym: string): Kline[] {
  const byTime = new Map<number, Kline>();
  for (const d of [...OLD_DIRS, NEW_DIR]) {
    const f = path.join(d, sym + '.json'); if (!fs.existsSync(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(f, 'utf-8')) as Kline[]) byTime.set(b.time, b); // la descarga más nueva pisa
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

type Dir = 'BUY' | 'SELL';
interface Outcome { r: number; g: number; exitIdx: number; i: number }
interface Trade { sym: string; day: number; i: number; dir: Dir; r: number; g: number; flipR: number; flipG: number }

function main(SYMBOLS: string[], USER: Set<string>) {
  const fw = getStrategyForwardWindow('confluencia', '5m', undefined, false);
  const real: Trade[] = [];
  // pools[sym] = { byDayDir: Map<"day|dir", Outcome[]>, all: {dir, o}[] }
  const poolsDay = new Map<string, Outcome[]>();
  const poolsSym = new Map<string, Outcome[]>();
  let eligibleCount = 0;

  for (const sym of SYMBOLS) {
    const k = loadMerged(sym); if (k.length < 400) continue;
    const atr = calculateATRSeries(k, 14);
    const signals = computeConfluenciaSignalsSeries(k, '5m', false);
    const cache = new Map<string, Outcome | null>();
    const outcome = (i: number, dir: Dir): Outcome | null => {
      const key = `${i}|${dir}`; if (cache.has(key)) return cache.get(key)!;
      const entry = k[i + 1].open;
      const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(dir, entry, '5m', atr[i], 'confluencia', { isCrypto: false }) };
      let res: Outcome | null = null;
      if (isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
        const sim = simulateTrade(k, i, dir, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE,
          frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
        const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
        res = { r: (sim.pnlPct - COST) / riskPct, g: sim.grossPnlPct / riskPct, exitIdx: sim.exitIdx, i };
      }
      cache.set(key, res); return res;
    };
    const eligible = (i: number) => i >= WARM && i < k.length - 2 && isNyseOpeningHour(k[i].time * 1000)
      && atr[i] / k[i].close * 100 >= MIN_ATR_PCT && dk(k[i + 1].time) === dk(k[i].time);

    // Pools nulos
    const symPool: Outcome[] = [];
    for (let i = WARM; i < k.length - 2; i++) {
      if (!eligible(i)) continue; eligibleCount++;
      const d = dk(k[i].time);
      for (const dir of ['BUY', 'SELL'] as const) {
        const o = outcome(i, dir); if (!o) continue;
        const key = `${sym}|${d}|${dir}`; if (!poolsDay.has(key)) poolsDay.set(key, []); poolsDay.get(key)!.push(o);
        symPool.push(o);
      }
    }
    poolsSym.set(sym, symPool);

    // Operaciones reales (una posición a la vez)
    let next = WARM;
    for (let i = WARM; i < k.length - 2; i++) {
      if (i < next) continue;
      const sig = signals[i]; if (sig === 'NEUTRAL' || !eligible(i)) continue;
      const dir = sig as Dir; const o = outcome(i, dir); if (!o) continue;
      const f = outcome(i, dir === 'BUY' ? 'SELL' : 'BUY');
      real.push({ sym, day: dk(k[i].time), i, dir, r: o.r, g: o.g, flipR: f ? f.r : NaN, flipG: f ? f.g : NaN });
      next = Math.max(i + 1, o.exitIdx);
    }
  }

  const days = [...new Set(real.map(t => t.day))].sort((a, b) => a - b);
  const allDays = new Set<number>(); for (const key of poolsDay.keys()) allDays.add(Number(key.split('|')[1]));
  const sortedDays = [...allDays].sort((a, b) => a - b);
  const mid = sortedDays[Math.floor(sortedDays.length / 2)];
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

  // IC del real: bootstrap agrupado por día
  const clusterCI = (g: Trade[], field: 'r' | 'g') => {
    const byDay = new Map<number, number[]>(); for (const t of g) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day)!.push(t[field]); }
    const groups = [...byDay.values()]; const ms: number[] = [];
    for (let b = 0; b < N_REP; b++) { let s = 0, n = 0; for (let j = 0; j < groups.length; j++) { const gr = pick(groups); for (const x of gr) { s += x; n++; } } ms.push(s / Math.max(1, n)); }
    ms.sort((a, b) => a - b); return [ms[Math.floor(0.025 * N_REP)], ms[Math.floor(0.975 * N_REP)]];
  };

  const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);
  function report(title: string, g: Trade[]) {
    if (g.length < 20) { console.log(`\n=== ${title} === n=${g.length} (insuficiente)`); return; }
    const realR = mean(g.map(t => t.r)), realG = mean(g.map(t => t.g));
    const [lo, hi] = clusterCI(g, 'r');
    const repA: number[] = [], repAG: number[] = [], repC: number[] = [], repCG: number[] = [], repPre: number[] = [];
    for (let b = 0; b < N_REP; b++) {
      let sa = 0, sag = 0, sc = 0, scg = 0, spre = 0, npre = 0;
      for (const t of g) {
        const pa = poolsDay.get(`${t.sym}|${t.day}|${t.dir}`)!;
        const post = pa.filter(o => o.i >= t.i), pre = pa.filter(o => o.i < t.i);
        const oa = pick(post); sa += oa.r; sag += oa.g;
        if (pre.length) { spre += pick(pre).r; npre++; }
        const oc = pick(poolsSym.get(t.sym)!); sc += oc.r; scg += oc.g;
      }
      repA.push(sa / g.length); repAG.push(sag / g.length); repC.push(sc / g.length); repCG.push(scg / g.length); repPre.push(spre / Math.max(1, npre));
    }
    const p = (rep: number[], obs: number) => rep.filter(x => x >= obs).length / rep.length;
    const flips = g.filter(t => Number.isFinite(t.flipR));
    const flipR = mean(flips.map(t => t.flipR)), flipG = mean(flips.map(t => t.flipG));
    const wr = 100 * g.filter(t => t.r > 0).length / g.length;
    const nd = new Set(g.map(t => t.day)).size;
    console.log(`\n=== ${title} === n=${g.length} en ${nd} días, WR ${wr.toFixed(0)}%`);
    console.log(`  Confluencia real          neto ${fmt(realR)}R [IC95 por día ${fmt(lo)} a ${fmt(hi)}] | bruto ${fmt(realG)}R`);
    console.log(`  A timing (en/después)     neto ${fmt(mean(repA))}R | bruto ${fmt(mean(repAG))}R | real − azar ${fmt(realR - mean(repA))}R  p=${p(repA, realR).toFixed(3)}`);
    console.log(`  [diag] A antes de señal   neto ${fmt(mean(repPre))}R (fuga: no alcanzable)`);
    console.log(`  B dirección contraria    neto ${fmt(flipR)}R | bruto ${fmt(flipG)}R | real − contraria ${fmt(realR - flipR)}R (n=${flips.length})`);
    console.log(`  C todo al azar            neto ${fmt(mean(repC))}R | bruto ${fmt(mean(repCG))}R | real − azar ${fmt(realR - mean(repC))}R  p=${p(repC, realR).toFixed(3)}`);
  }

  console.log(`Papeles ${SYMBOLS.length} (watchlist ${[...USER].filter(s => SYMBOLS.includes(s)).length}), sesiones con velas elegibles ${sortedDays.length} (${sortedDays[0]}–${sortedDays.at(-1)}), corte de mitades ${mid}`);
  console.log(`Velas elegibles ${eligibleCount}; operaciones reales ${real.length} en ${days.length} días; horizonte ${fw} velas; ${N_REP} repeticiones`);
  report('TOTAL', real);
  report('1ª mitad', real.filter(t => t.day < mid));
  report('2ª mitad', real.filter(t => t.day >= mid));
  report('Watchlist del usuario', real.filter(t => USER.has(t.sym)));
  report('Resto de papeles', real.filter(t => !USER.has(t.sym)));
  report('Watchlist 1ª mitad', real.filter(t => USER.has(t.sym) && t.day < mid));
  report('Watchlist 2ª mitad', real.filter(t => USER.has(t.sym) && t.day >= mid));
  report('Período nuevo (≥ 2026-10-15, posterior a toda calibración)', real.filter(t => t.day >= 20261015));
  report('Período nuevo · watchlist', real.filter(t => t.day >= 20261015 && USER.has(t.sym)));
  report('BUY', real.filter(t => t.dir === 'BUY'));
  report('SELL', real.filter(t => t.dir === 'SELL'));
}

await ensureNewData();
const USER = new Set(fs.readdirSync('scratch/user-watchlist-5m').filter(f => f.endsWith('.json') && !f.includes('USDT')).map(f => f.replace('.json', '')));
const SYMBOLS = [...new Set(OLD_DIRS.concat(NEW_DIR).flatMap(d => fs.existsSync(d) ? fs.readdirSync(d) : []).map(f => f.replace('.json', '')))].filter(s => !s.includes('USDT'));
main(SYMBOLS, USER);
