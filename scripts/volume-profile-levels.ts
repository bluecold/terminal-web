/**
 * scripts/volume-profile-levels.ts
 *
 * ¿Los niveles del perfil de volumen (HVN / LVN) tienen poder predictivo en acciones 5m?
 * Prueba de la tesis "el precio viaja de un HVN al siguiente; los LVN se cruzan rápido / rechazan".
 *
 * Diseño fijado ANTES de ver resultados (ningún parámetro se ajusta con los datos):
 *  - Perfil causal: volumen por precio de las N sesiones previas (N=5 primario, N=1 robustez), sólo
 *    velas 09:30–16:00 ET. El volumen de cada vela 5m se reparte uniforme en su rango [low, high].
 *    Bin = 0,25 × mediana del ATR(14) 5m de la ventana. Suavizado triangular de 5 bins.
 *  - HVN = máximo local (±4 bins) con volumen ≥ media del perfil. Dos HVN vecinos sólo cuentan como
 *    nodos distintos si el valle entre ambos (LVN) es ≤ 70% del menor de los dos y están a ≥ 8 bins
 *    (2 ATR); si no, se conserva el mayor.
 *  - Hipótesis A (viaje HVN→HVN): terna (origen A, valle V, destino B). Disparo: primera vela del día
 *    cuyo cierre cruza V hacia B (cierre previo del mismo día del lado de A). Entrada a la apertura
 *    de la vela siguiente (mismo día), objetivo = B, stop = A, si no cierre de la sesión. Si una vela
 *    toca ambos se asume stop. Una operación por terna y dirección por día.
 *    Con precio martingala la esperanza bruta es 0 para cualquier geometría, así que la prueba es:
 *    bruto > 0 (IC95 por bootstrap agrupado por día) Y mayor que el placebo.
 *  - Placebo: la misma terna desplazada al azar dentro del rango del perfil (misma geometría, mismo
 *    R:R, excluyendo desplazamientos < 25% del tramo). 200 repeticiones; p = fracción ≥ real.
 *  - Control invertido: terna LVN→LVN cruzando un HVN (si los HVN son imanes, debería rendir peor).
 *  - Variante "3 preguntas" del texto: sólo disparos con cierre del lado correcto del VWAP de sesión,
 *    EMA9 vs EMA21 alineadas y máximos (mínimos) de las últimas 6 velas por debajo (encima) de las 6
 *    anteriores.
 *  - Hipótesis B: (B1 velocidad) |retorno de la vela siguiente|/ATR, normalizado por franja horaria,
 *    en velas que cierran en bins LVN (tercil inferior de volumen) contra HVN (tercil superior),
 *    comparado dentro del mismo papel y día. (B2 rechazo) retorno a 6 velas hacia el HVN más cercano
 *    desde bins LVN, en ATR; nulo = 0.
 *  - Costo 0,11% + 0,03%. Cortes: mitades temporales, watchlist del usuario / resto, viables por
 *    fricción (isTradeFrictionViable), largos / cortos.
 *  - Criterio para "vale la pena": bruto > 0 con IC que excluye 0, p < 0,05 contra placebo, signo
 *    positivo en ambas mitades y neto > 0.
 *
 * EXTENSIÓN (fijada antes de correrla), modo `filters`:
 *  - Filtro A ("no comprar contra el POC"): operaciones reales de Confluencia (misma mecánica que
 *    confluencia-vs-random-entry.ts). Se marca "contra nivel" si la entrada queda a ≤ x·ATR(14) 5m
 *    por debajo (BUY) o por encima (SELL) del nivel, x ∈ {0,5; 1; 2}. Niveles: POC de la sesión
 *    previa, POC de 5 sesiones, cualquier HVN de 5 sesiones, y borde del área de valor (70%) de la
 *    sesión previa (VAH para BUY, VAL para SELL). Métrica: neto marcadas − neto no marcadas, IC por
 *    bootstrap agrupado por día y placebo (niveles desplazados ±2 a 6 ATR, 500 repeticiones;
 *    p = fracción de placebos con diferencia ≤ la real). El filtro sirve si la diferencia es
 *    negativa, significativa y con el mismo signo en ambas mitades.
 *  - Regla del 80% (C): área de valor de la sesión previa. Si el precio abrió o cerró una vela
 *    fuera y luego cierra M velas consecutivas dentro (M=2 como dice el texto; M=6 = 30 min como
 *    variante cercana a la regla original), entrada a la apertura siguiente hacia el extremo
 *    opuesto; objetivo = extremo opuesto, stop = extremo del día previo a la entrada del lado de la
 *    excursión. Primera ocurrencia del día. Se informa % que alcanza el extremo opuesto antes del
 *    cierre (ignorando el stop) y el R bruto, contra placebo (área desplazada ±0,5 a 1,5 anchos).
 *
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/volume-profile-levels.ts [filters]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries, isNyseOpeningHour } from '../src/utils/indicators';
import { calculateAlertLevels, isTradeFrictionViable } from '../src/utils/tradeLevels';
import { computeConfluenciaSignalsSeries, getStrategyForwardWindow } from '../src/utils/backtester';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const COST_PCT = 0.14, N_PLACEBO = 200, N_BOOT = 2000;
const OLD_DIRS = ['scratch/fresh-5m-20261015', 'scratch/fresh-5m-20261021', 'scratch/fresh-5m-20261103'];
const NEW_DIR = 'scratch/fresh-5m-20261110'; // descarga de la corrida original, fijada para reproducir

let seed = 20261110;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const fmt = (x: number, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);

async function ensureNewData() {
  if (fs.existsSync(NEW_DIR) && fs.readdirSync(NEW_DIR).length > 50) return;
  fs.mkdirSync(NEW_DIR, { recursive: true });
  const nowSec = Date.now() / 1000;
  for (const s of fs.readdirSync(OLD_DIRS[2]).map(f => f.replace('.json', ''))) {
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

interface Bar extends Kline { day: number }
function loadRaw(sym: string): Kline[] {
  const byTime = new Map<number, Kline>();
  for (const d of [...OLD_DIRS, NEW_DIR]) {
    const f = path.join(d, sym + '.json'); if (!fs.existsSync(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(f, 'utf-8')) as Kline[]) byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, c) => a.time - c.time);
}
function loadMerged(sym: string): Bar[] {
  const out: Bar[] = [];
  for (const b of loadRaw(sym)) {
    const e = getEasternTime(b.time * 1000); const m = e.hour * 60 + e.minute;
    if (m < 570 || m >= 960 || !(b.volume > 0) || b.high < b.low) continue;
    out.push({ ...b, day: e.year * 10000 + e.month * 100 + e.day });
  }
  return out;
}

interface Profile { lo: number; hi: number; bin: number; s: number[]; rank: number[]; peaks: number[]; valleys: number[]; poc: number; val: number; vah: number }
const price = (p: Profile, j: number) => p.lo + (j + 0.5) * p.bin;

function buildProfile(k: Bar[], a: number, b: number, atr: number[]): Profile | null {
  const atrs: number[] = []; let lo = Infinity, hi = -Infinity;
  for (let i = a; i <= b; i++) { if (atr[i] > 0) atrs.push(atr[i]); lo = Math.min(lo, k[i].low); hi = Math.max(hi, k[i].high); }
  if (atrs.length < 30) return null;
  atrs.sort((x, y) => x - y); const bin = 0.25 * atrs[Math.floor(atrs.length / 2)];
  if (!(bin > 0)) return null;
  const nb = Math.floor((hi - lo) / bin) + 1; if (nb < 20 || nb > 5000) return null;
  const raw = new Array<number>(nb).fill(0);
  for (let i = a; i <= b; i++) {
    const b0 = Math.floor((k[i].low - lo) / bin), b1 = Math.min(nb - 1, Math.floor((k[i].high - lo) / bin));
    const v = k[i].volume / (b1 - b0 + 1); for (let j = b0; j <= b1; j++) raw[j] += v;
  }
  const w = [1, 2, 3, 2, 1]; const s = new Array<number>(nb).fill(0);
  for (let j = 0; j < nb; j++) { let acc = 0, ws = 0; for (let d = -2; d <= 2; d++) { const q = j + d; if (q < 0 || q >= nb) continue; acc += raw[q] * w[d + 2]; ws += w[d + 2]; } s[j] = acc / ws; }
  const avg = mean(s);
  let peaks: number[] = [];
  for (let j = 0; j < nb; j++) {
    if (s[j] < avg) continue; let ok = true;
    for (let d = -4; d <= 4 && ok; d++) { const q = j + d; if (d === 0 || q < 0 || q >= nb) continue; if (s[q] > s[j] || (s[q] === s[j] && q < j)) ok = false; }
    if (ok) peaks.push(j);
  }
  const valleyOf = (p1: number, p2: number) => { let v = p1 + 1; for (let j = p1 + 1; j < p2; j++) if (s[j] < s[v]) v = j; return v; };
  for (let changed = true; changed;) {
    changed = false;
    for (let q = 0; q + 1 < peaks.length; q++) {
      const p1 = peaks[q], p2 = peaks[q + 1]; const v = valleyOf(p1, p2);
      if (p2 - p1 < 8 || s[v] > 0.7 * Math.min(s[p1], s[p2])) { peaks.splice(s[p1] >= s[p2] ? q + 1 : q, 1); changed = true; break; }
    }
  }
  const valleys: number[] = []; for (let q = 0; q + 1 < peaks.length; q++) valleys.push(valleyOf(peaks[q], peaks[q + 1]));
  const order = s.map((v, j) => [v, j] as [number, number]).sort((x, y) => x[0] - y[0]);
  const rank = new Array<number>(nb); order.forEach(([, j], r) => { rank[j] = (r + 0.5) / nb; });
  let pj = 0; for (let j = 1; j < nb; j++) if (s[j] > s[pj]) pj = j;
  const total = s.reduce((x, y) => x + y, 0); let a0 = pj, a1 = pj, acc = s[pj];
  while (acc < 0.7 * total && (a0 > 0 || a1 < nb - 1)) { const up = a1 < nb - 1 ? s[a1 + 1] : -1, dn = a0 > 0 ? s[a0 - 1] : -1; if (up >= dn) acc += s[++a1]; else acc += s[--a0]; }
  return { lo, hi, bin, s, rank, peaks, valleys, poc: lo + (pj + 0.5) * bin, val: lo + a0 * bin, vah: lo + (a1 + 1) * bin };
}

interface Ev { day: number; user: boolean; long: boolean; g: number; net: number; bps: number; res: 0 | 1 | 2; viable: boolean; filt: boolean; amb: boolean }
interface Ctx { k: Bar[]; vwap: number[]; e9: number[]; e21: number[]; user: boolean }

/** Simula la terna (A origen, V disparo, B destino) en las velas s..e de un día. */
function runTriplet(c: Ctx, s: number, e: number, A: number, V: number, B: number): Ev | null {
  const k = c.k; const long = B > A;
  for (let i = s + 1; i < e; i++) {
    const prev = k[i - 1].close, cl = k[i].close;
    const cross = long ? (prev <= V && cl > V && cl < B) : (prev >= V && cl < V && cl > B);
    if (!cross) continue;
    const entry = k[i + 1].open;
    if (long ? !(entry > A && entry < B) : !(entry < A && entry > B)) return null;
    let exit = k[e].close; let res: 0 | 1 | 2 = 2; let amb = false;
    for (let j = i + 1; j <= e; j++) {
      const hitStop = long ? k[j].low <= A : k[j].high >= A, hitTgt = long ? k[j].high >= B : k[j].low <= B;
      if (hitStop) { amb = hitTgt; exit = long ? Math.min(A, k[j].open) : Math.max(A, k[j].open); res = 0; break; }
      if (hitTgt) { exit = B; res = 1; break; }
    }
    const risk = Math.abs(entry - A); const pnl = long ? exit - entry : entry - exit;
    let filt = false;
    if (i >= 12) {
      let h1 = -Infinity, h0 = -Infinity, l1 = Infinity, l0 = Infinity;
      for (let q = i - 5; q <= i; q++) { h1 = Math.max(h1, k[q].high); l1 = Math.min(l1, k[q].low); }
      for (let q = i - 11; q <= i - 6; q++) { h0 = Math.max(h0, k[q].high); l0 = Math.min(l0, k[q].low); }
      filt = long ? (cl > c.vwap[i] && c.e9[i] > c.e21[i] && l1 > l0) : (cl < c.vwap[i] && c.e9[i] < c.e21[i] && h1 < h0);
    }
    return { day: k[i].day, user: c.user, long, g: pnl / risk, net: pnl / risk - (COST_PCT / 100) * entry / risk, bps: pnl / entry * 1e4, res, viable: isTradeFrictionViable(entry, A), filt, amb };
  }
  return null;
}

interface DayJob { c: Ctx; s: number; e: number; lo: number; hi: number; trips: [number, number, number][]; inv: [number, number, number][] }

function ema(v: number[], n: number) { const a = 2 / (n + 1); const o = new Array<number>(v.length); o[0] = v[0]; for (let i = 1; i < v.length; i++) o[i] = a * v[i] + (1 - a) * o[i - 1]; return o; }

function runN(N: number, SYMBOLS: string[], USER: Set<string>) {
  const jobs: DayJob[] = []; const allDays = new Set<number>();
  // Hipótesis B
  const bRows: { key: string; day: number; slot: number; rank: number; y: number; pull: number }[] = [];
  let nodesSum = 0, profCount = 0;

  for (const sym of SYMBOLS) {
    const k = loadMerged(sym); if (k.length < 800) continue;
    const atr = calculateATRSeries(k, 14);
    const starts: number[] = []; for (let i = 0; i < k.length; i++) if (i === 0 || k[i].day !== k[i - 1].day) starts.push(i);
    const vwap = new Array<number>(k.length); { let pv = 0, vv = 0; for (let i = 0; i < k.length; i++) { if (i === 0 || k[i].day !== k[i - 1].day) { pv = 0; vv = 0; } pv += (k[i].high + k[i].low + k[i].close) / 3 * k[i].volume; vv += k[i].volume; vwap[i] = pv / vv; } }
    const cl = k.map(b => b.close);
    const c: Ctx = { k, vwap, e9: ema(cl, 9), e21: ema(cl, 21), user: USER.has(sym) };
    for (let d = N; d < starts.length; d++) {
      const s = starts[d], e = (d + 1 < starts.length ? starts[d + 1] : k.length) - 1;
      if (e - s < 40 || s - starts[d - N] < 40 * N) continue;
      const p = buildProfile(k, starts[d - N], s - 1, atr); if (!p) continue;
      allDays.add(k[s].day); profCount++; nodesSum += p.peaks.length;
      const trips: [number, number, number][] = [], inv: [number, number, number][] = [];
      for (let q = 0; q + 1 < p.peaks.length; q++) {
        const a = price(p, p.peaks[q]), v = price(p, p.valleys[q]), b = price(p, p.peaks[q + 1]);
        trips.push([a, v, b], [b, v, a]);
        if (q + 2 < p.peaks.length) { const v2 = price(p, p.valleys[q + 1]); inv.push([v, b, v2], [v2, b, v]); }
      }
      jobs.push({ c, s, e, lo: p.lo, hi: p.hi, trips, inv });
      if (p.peaks.length) for (let i = s; i < e; i++) {
        const j = Math.floor((k[i].close - p.lo) / p.bin); if (j < 0 || j >= p.s.length || !(atr[i] > 0)) continue;
        let near = price(p, p.peaks[0]); for (const pk of p.peaks) { const pp = price(p, pk); if (Math.abs(pp - k[i].close) < Math.abs(near - k[i].close)) near = pp; }
        const fut = k[Math.min(i + 6, e)].close;
        bRows.push({ key: `${sym}|${k[i].day}`, day: k[i].day, slot: i - s, rank: p.rank[j], y: Math.abs(k[i + 1].close - k[i].close) / atr[i], pull: Math.sign(near - k[i].close) * (fut - k[i].close) / atr[i] });
      }
    }
  }
  const sortedDays = [...allDays].sort((a, b) => a - b); const mid = sortedDays[Math.floor(sortedDays.length / 2)];

  const real: Ev[] = [], inverted: Ev[] = [];
  for (const j of jobs) {
    for (const [a, v, b] of j.trips) { const ev = runTriplet(j.c, j.s, j.e, a, v, b); if (ev) real.push(ev); }
    for (const [a, v, b] of j.inv) { const ev = runTriplet(j.c, j.s, j.e, a, v, b); if (ev) inverted.push(ev); }
  }

  const groups: [string, (t: Ev) => boolean][] = [
    ['TOTAL', () => true], ['1ª mitad', t => t.day < mid], ['2ª mitad', t => t.day >= mid],
    ['Watchlist usuario', t => t.user], ['Resto de papeles', t => !t.user],
    ['Viables por fricción', t => t.viable], ['Largos', t => t.long], ['Cortos', t => !t.long],
    ['Filtro 3 preguntas', t => t.filt], ['Filtro · 1ª mitad', t => t.filt && t.day < mid], ['Filtro · 2ª mitad', t => t.filt && t.day >= mid],
    ['Filtro + viables', t => t.filt && t.viable], ['Filtro · watchlist', t => t.filt && t.user],
  ];

  // Placebo: ternas desplazadas
  const plG: number[][] = groups.map(() => []), plNet: number[][] = groups.map(() => []), plN: number[] = groups.map(() => 0);
  for (let rep = 0; rep < N_PLACEBO; rep++) {
    const sg = groups.map(() => 0), sn = groups.map(() => 0), n = groups.map(() => 0);
    for (const j of jobs) for (const [a, v, b] of j.trips) {
      const mn = Math.min(a, b), mx = Math.max(a, b), span = mx - mn; let off = NaN;
      for (let t = 0; t < 20; t++) { const o = (j.lo - mn) + rand() * ((j.hi - mx) - (j.lo - mn)); if (Math.abs(o) >= 0.25 * span) { off = o; break; } }
      if (!Number.isFinite(off)) continue;
      const ev = runTriplet(j.c, j.s, j.e, a + off, v + off, b + off); if (!ev) continue;
      groups.forEach(([, f], gi) => { if (f(ev)) { sg[gi] += ev.g; sn[gi] += ev.net; n[gi]++; } });
    }
    groups.forEach((_, gi) => { if (n[gi]) { plG[gi].push(sg[gi] / n[gi]); plNet[gi].push(sn[gi] / n[gi]); plN[gi] += n[gi] / N_PLACEBO; } });
  }

  const clusterCI = (rows: { day: number }[], val: (r: any) => number) => {
    const byDay = new Map<number, number[]>(); for (const t of rows) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day)!.push(val(t)); }
    const gs = [...byDay.values()]; const ms: number[] = [];
    for (let b = 0; b < N_BOOT; b++) { let s = 0, n = 0; for (let q = 0; q < gs.length; q++) { const gr = gs[Math.floor(rand() * gs.length)]; for (const x of gr) { s += x; n++; } } ms.push(s / Math.max(1, n)); }
    ms.sort((a, b) => a - b); return [ms[Math.floor(0.025 * N_BOOT)], ms[Math.floor(0.975 * N_BOOT)]];
  };

  console.log(`\n################ PERFIL DE ${N} SESIÓN(ES) PREVIA(S) ################`);
  console.log(`Sesiones ${sortedDays.length} (${sortedDays[0]}–${sortedDays.at(-1)}), corte de mitades ${mid}; perfiles ${profCount}, HVN por perfil ${(nodesSum / profCount).toFixed(2)}`);
  console.log(`Hipótesis A — viaje HVN→HVN (objetivo HVN destino, stop HVN origen, cierre de sesión)`);
  groups.forEach(([name, f], gi) => {
    const g = real.filter(f); if (g.length < 30) { console.log(`\n=== ${name} === n=${g.length} (insuficiente)`); return; }
    const G = mean(g.map(t => t.g)), NET = mean(g.map(t => t.net)); const [lo, hi] = clusterCI(g, t => t.g);
    const pct = (r: number) => (100 * g.filter(t => t.res === r).length / g.length).toFixed(0);
    const inv = inverted.filter(f);
    const p = plG[gi].filter(x => x >= G).length / Math.max(1, plG[gi].length);
    console.log(`\n=== ${name} === n=${g.length} en ${new Set(g.map(t => t.day)).size} días | objetivo ${pct(1)}% stop ${pct(0)}% cierre ${pct(2)}% | ambiguas ${(100 * g.filter(t => t.amb).length / g.length).toFixed(1)}%`);
    console.log(`  Niveles reales   bruto ${fmt(G)}R [IC95 por día ${fmt(lo)} a ${fmt(hi)}] | ${fmt(mean(g.map(t => t.bps)), 1)} pb | neto ${fmt(NET)}R`);
    console.log(`  Placebo (n≈${plN[gi].toFixed(0)})  bruto ${fmt(mean(plG[gi]))}R | neto ${fmt(mean(plNet[gi]))}R | real − placebo ${fmt(G - mean(plG[gi]))}R  p=${p.toFixed(3)}`);
    if (inv.length >= 30) console.log(`  Invertido LVN→LVN (n=${inv.length})  bruto ${fmt(mean(inv.map(t => t.g)))}R | neto ${fmt(mean(inv.map(t => t.net)))}R`);
  });

  // Hipótesis B
  const slotSum = new Map<number, [number, number]>(); for (const r of bRows) { const x = slotSum.get(r.slot) ?? [0, 0]; x[0] += r.y; x[1]++; slotSum.set(r.slot, x); }
  const byKey = new Map<string, { day: number; l: number[]; h: number[] }>();
  const pullRows: { day: number; v: number }[] = [], pullH: { day: number; v: number }[] = [];
  let nL = 0, nH = 0, sL = 0, sH = 0;
  for (const r of bRows) {
    const sm = slotSum.get(r.slot)!; const yn = r.y / (sm[0] / sm[1]);
    if (r.rank < 1 / 3) { nL++; sL += yn; pullRows.push({ day: r.day, v: r.pull }); } else if (r.rank > 2 / 3) { nH++; sH += yn; pullH.push({ day: r.day, v: r.pull }); } else continue;
    if (!byKey.has(r.key)) byKey.set(r.key, { day: r.day, l: [], h: [] });
    (r.rank < 1 / 3 ? byKey.get(r.key)!.l : byKey.get(r.key)!.h).push(yn);
  }
  const diffs = [...byKey.values()].filter(x => x.l.length >= 5 && x.h.length >= 5).map(x => ({ day: x.day, v: mean(x.l) - mean(x.h) }));
  const [dlo, dhi] = clusterCI(diffs, r => r.v); const [plo, phi] = clusterCI(pullRows, r => r.v); const [hlo, hhi] = clusterCI(pullH, r => r.v);
  console.log(`\nHipótesis B — velas dentro del rango del perfil: ${bRows.length} (LVN ${nL}, HVN ${nH})`);
  console.log(`  B1 velocidad (|ret. vela siguiente|/ATR, normalizado por franja): LVN ${(sL / nL).toFixed(3)} vs HVN ${(sH / nH).toFixed(3)} (crudo, mezcla días)`);
  console.log(`     Dentro del mismo papel y día (n=${diffs.length}): LVN − HVN ${fmt(mean(diffs.map(d => d.v)))} [IC95 ${fmt(dlo)} a ${fmt(dhi)}]`);
  console.log(`  B2 rechazo: retorno a 6 velas hacia el HVN más cercano desde LVN ${fmt(mean(pullRows.map(r => r.v)))} ATR [IC95 ${fmt(plo)} a ${fmt(phi)}]; desde HVN ${fmt(mean(pullH.map(r => r.v)))} ATR [IC95 ${fmt(hlo)} a ${fmt(hhi)}]`);
}

// ───────────────────────── Extensión: filtro A y regla del 80% ─────────────────────────
function bootDiff(rows: { day: number; r: number; f: boolean }[]) {
  const byDay = new Map<number, typeof rows>(); for (const t of rows) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day)!.push(t); }
  const gs = [...byDay.values()]; const ds: number[] = [];
  for (let b = 0; b < N_BOOT; b++) { let s1 = 0, n1 = 0, s0 = 0, n0 = 0; for (let q = 0; q < gs.length; q++) for (const t of gs[Math.floor(rand() * gs.length)]) { if (t.f) { s1 += t.r; n1++; } else { s0 += t.r; n0++; } } if (n1 && n0) ds.push(s1 / n1 - s0 / n0); }
  ds.sort((a, b) => a - b); return [ds[Math.floor(0.025 * ds.length)], ds[Math.floor(0.975 * ds.length)]];
}

function runFilterA(SYMBOLS: string[], USER: Set<string>) {
  const fw = getStrategyForwardWindow('confluencia', '5m', undefined, false);
  interface T { day: number; user: boolean; buy: boolean; r: number; entry: number; a: number; lv: Record<string, number[]> }
  const trades: T[] = [];
  for (const sym of SYMBOLS) {
    const k = loadRaw(sym); if (k.length < 800) continue;
    const kb = loadMerged(sym); const atrB = calculateATRSeries(kb, 14);
    const starts: number[] = []; for (let i = 0; i < kb.length; i++) if (i === 0 || kb[i].day !== kb[i - 1].day) starts.push(i);
    const dayIdx = new Map<number, number>(); starts.forEach((s, d) => dayIdx.set(kb[s].day, d));
    const profCache = new Map<string, Profile | null>();
    const prof = (d: number, N: number) => { const key = `${d}|${N}`; if (!profCache.has(key)) profCache.set(key, d >= N ? buildProfile(kb, starts[d - N], starts[d] - 1, atrB) : null); return profCache.get(key)!; };
    const atr = calculateATRSeries(k, 14); const signals = computeConfluenciaSignalsSeries(k, '5m', false);
    const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };
    let next = 30;
    for (let i = 30; i < k.length - 2; i++) {
      if (i < next) continue; const sig = signals[i]; if (sig === 'NEUTRAL') continue;
      if (!isNyseOpeningHour(k[i].time * 1000) || atr[i] / k[i].close * 100 < 0.5) continue;
      const day = dk(k[i].time); if (dk(k[i + 1].time) !== day) continue;
      const dir = sig as 'BUY' | 'SELL'; const entry = k[i + 1].open;
      const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(dir, entry, '5m', atr[i], 'confluencia', { isCrypto: false }) };
      if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) continue;
      const sim = simulateTrade(k, i, dir, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: 0.03, frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
      next = Math.max(i + 1, sim.exitIdx);
      const d = dayIdx.get(day); if (d === undefined) continue; const p1 = prof(d, 1), p5 = prof(d, 5); if (!p1 || !p5) continue;
      const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
      trades.push({ day, user: USER.has(sym), buy: dir === 'BUY', r: (sim.pnlPct - 0.11) / riskPct, entry, a: atr[i],
        lv: { 'POC sesión previa': [p1.poc], 'POC 5 sesiones': [p5.poc], 'Cualquier HVN 5 sesiones': p5.peaks.map(j => price(p5, j)), 'Borde área de valor previa': [dir === 'BUY' ? p1.vah : p1.val] } });
    }
  }
  const days = [...new Set(trades.map(t => t.day))].sort((a, b) => a - b); const mid = days[Math.floor(days.length / 2)];
  const flag = (t: T, kind: string, x: number, off = 0) => t.lv[kind].some(L => { const dist = t.buy ? L + off - t.entry : t.entry - (L + off); return dist > 0 && dist <= x * t.a; });
  const diffOf = (g: T[], f: (t: T) => boolean) => { let s1 = 0, n1 = 0, s0 = 0, n0 = 0; for (const t of g) { if (f(t)) { s1 += t.r; n1++; } else { s0 += t.r; n0++; } } return { n1, m1: s1 / Math.max(1, n1), m0: s0 / Math.max(1, n0), d: s1 / Math.max(1, n1) - s0 / Math.max(1, n0) }; };
  console.log(`\n################ FILTRO A — Confluencia contra niveles del perfil ################`);
  console.log(`Operaciones de Confluencia ${trades.length} en ${days.length} días (${days[0]}–${days.at(-1)}), neto medio ${fmt(mean(trades.map(t => t.r)))}R, corte de mitades ${mid}`);
  for (const kind of Object.keys(trades[0].lv)) {
    console.log(`\n=== ${kind} ===`);
    for (const x of [0.5, 1, 2]) {
      const real = diffOf(trades, t => flag(t, kind, x)); if (real.n1 < 30) { console.log(`  ≤${x} ATR: marcadas n=${real.n1} (insuficiente)`); continue; }
      const [lo, hi] = bootDiff(trades.map(t => ({ day: t.day, r: t.r, f: flag(t, kind, x) })));
      const pl: number[] = [];
      for (let rep = 0; rep < 500; rep++) { const offs = trades.map(t => (rand() < 0.5 ? -1 : 1) * (2 + 4 * rand()) * t.a); let q = 0; const d = diffOf(trades, t => flag(t, kind, x, offs[q++])); if (d.n1 >= 10) pl.push(d.d); }
      const p = pl.filter(v => v <= real.d).length / Math.max(1, pl.length);
      const h1 = diffOf(trades.filter(t => t.day < mid), t => flag(t, kind, x)), h2 = diffOf(trades.filter(t => t.day >= mid), t => flag(t, kind, x)), u = diffOf(trades.filter(t => t.user), t => flag(t, kind, x));
      console.log(`  ≤${x} ATR: marcadas n=${real.n1} neto ${fmt(real.m1)}R | resto ${fmt(real.m0)}R | dif ${fmt(real.d)}R [IC95 ${fmt(lo)} a ${fmt(hi)}] | placebo dif ${fmt(mean(pl))}R p=${p.toFixed(3)} | 1ª mitad ${fmt(h1.d)} (n=${h1.n1}) 2ª mitad ${fmt(h2.d)} (n=${h2.n1}) watchlist ${fmt(u.d)} (n=${u.n1})`);
    }
  }
}

function runRule80(SYMBOLS: string[], USER: Set<string>) {
  interface E { day: number; user: boolean; g: number; net: number; reach: boolean }
  interface J { k: Bar[]; s: number; e: number; val: number; vah: number; user: boolean }
  const jobs: J[] = []; const allDays = new Set<number>();
  for (const sym of SYMBOLS) {
    const k = loadMerged(sym); if (k.length < 800) continue; const atr = calculateATRSeries(k, 14);
    const starts: number[] = []; for (let i = 0; i < k.length; i++) if (i === 0 || k[i].day !== k[i - 1].day) starts.push(i);
    for (let d = 1; d < starts.length; d++) {
      const s = starts[d], e = (d + 1 < starts.length ? starts[d + 1] : k.length) - 1; if (e - s < 40 || s - starts[d - 1] < 40) continue;
      const p = buildProfile(k, starts[d - 1], s - 1, atr); if (!p) continue;
      jobs.push({ k, s, e, val: p.val, vah: p.vah, user: USER.has(sym) }); allDays.add(k[s].day);
    }
  }
  const sortedDays = [...allDays].sort((a, b) => a - b); const mid = sortedDays[Math.floor(sortedDays.length / 2)];
  const run = (j: J, val: number, vah: number, M: number): E | null => {
    const k = j.k; let out = k[j.s].open > vah ? 1 : k[j.s].open < val ? -1 : 0; let cnt = 0, hiDay = -Infinity, loDay = Infinity;
    for (let i = j.s; i < j.e; i++) {
      hiDay = Math.max(hiDay, k[i].high); loDay = Math.min(loDay, k[i].low);
      const c = k[i].close;
      if (c > vah) { out = 1; cnt = 0; continue; } if (c < val) { out = -1; cnt = 0; continue; }
      if (out === 0) continue; if (++cnt < M) continue;
      const long = out < 0; const entry = k[i + 1].open; const tgt = long ? vah : val, stop = long ? loDay : hiDay;
      if (long ? !(entry > stop && entry < tgt) : !(entry < stop && entry > tgt)) return null;
      let exit = k[j.e].close, done = false, reach = false;
      for (let q = i + 1; q <= j.e; q++) {
        const hs = long ? k[q].low <= stop : k[q].high >= stop, ht = long ? k[q].high >= tgt : k[q].low <= tgt;
        if (!done && hs) { exit = long ? Math.min(stop, k[q].open) : Math.max(stop, k[q].open); done = true; }
        if (ht) { reach = true; if (!done) { exit = tgt; done = true; } break; }
      }
      const risk = Math.abs(entry - stop), pnl = long ? exit - entry : entry - exit;
      return { day: k[i].day, user: j.user, g: pnl / risk, net: pnl / risk - (COST_PCT / 100) * entry / risk, reach };
    }
    return null;
  };
  const groups: [string, (t: E) => boolean][] = [['TOTAL', () => true], ['1ª mitad', t => t.day < mid], ['2ª mitad', t => t.day >= mid], ['Watchlist usuario', t => t.user]];
  console.log(`\n################ REGLA DEL 80% — área de valor (70%) de la sesión previa ################`);
  console.log(`Sesiones ${sortedDays.length} (${sortedDays[0]}–${sortedDays.at(-1)}), papel-días ${jobs.length}, corte de mitades ${mid}`);
  for (const M of [2, 6]) {
    const real: E[] = []; for (const j of jobs) { const ev = run(j, j.val, j.vah, M); if (ev) real.push(ev); }
    const plG = groups.map(() => [] as number[]), plReach = groups.map(() => [] as number[]);
    for (let rep = 0; rep < N_PLACEBO; rep++) {
      const sg = groups.map(() => 0), sr = groups.map(() => 0), n = groups.map(() => 0);
      for (const j of jobs) { const off = (rand() < 0.5 ? -1 : 1) * (0.5 + rand()) * (j.vah - j.val); const ev = run(j, j.val + off, j.vah + off, M); if (!ev) continue; groups.forEach(([, f], gi) => { if (f(ev)) { sg[gi] += ev.g; sr[gi] += ev.reach ? 1 : 0; n[gi]++; } }); }
      groups.forEach((_, gi) => { if (n[gi]) { plG[gi].push(sg[gi] / n[gi]); plReach[gi].push(sr[gi] / n[gi]); } });
    }
    console.log(`\n--- ${M} velas consecutivas dentro (${M * 5} min) ---`);
    groups.forEach(([name, f], gi) => {
      const g = real.filter(f); if (g.length < 30) { console.log(`  ${name}: n=${g.length} (insuficiente)`); return; }
      const G = mean(g.map(t => t.g)), reach = g.filter(t => t.reach).length / g.length;
      const byDay = new Map<number, number[]>(); for (const t of g) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day)!.push(t.g); }
      const gs = [...byDay.values()]; const ms: number[] = []; for (let b = 0; b < N_BOOT; b++) { let s = 0, n = 0; for (let q = 0; q < gs.length; q++) for (const x of gs[Math.floor(rand() * gs.length)]) { s += x; n++; } ms.push(s / Math.max(1, n)); } ms.sort((a, b) => a - b);
      console.log(`  ${name}: n=${g.length} | alcanza el extremo opuesto ${(100 * reach).toFixed(0)}% (placebo ${(100 * mean(plReach[gi])).toFixed(0)}%, p=${(plReach[gi].filter(x => x >= reach).length / plReach[gi].length).toFixed(3)}) | bruto ${fmt(G)}R [IC95 ${fmt(ms[Math.floor(0.025 * N_BOOT)])} a ${fmt(ms[Math.floor(0.975 * N_BOOT)])}] placebo ${fmt(mean(plG[gi]))}R p=${(plG[gi].filter(x => x >= G).length / plG[gi].length).toFixed(3)} | neto ${fmt(mean(g.map(t => t.net)))}R`);
    });
  }
}

await ensureNewData();
const USER = new Set(fs.readdirSync('scratch/user-watchlist-5m').filter(f => f.endsWith('.json') && !f.includes('USDT')).map(f => f.replace('.json', '')));
const SYMBOLS = [...new Set(OLD_DIRS.concat(NEW_DIR).flatMap(d => fs.existsSync(d) ? fs.readdirSync(d) : []).map(f => f.replace('.json', '')))].filter(s => !s.includes('USDT'));
console.log(`Papeles ${SYMBOLS.length} (watchlist ${[...USER].filter(s => SYMBOLS.includes(s)).length}); costo ${COST_PCT}%; placebo ${N_PLACEBO} repeticiones`);
if (process.argv.includes('filters')) { runFilterA(SYMBOLS, USER); runRule80(SYMBOLS, USER); }
else { runN(5, SYMBOLS, USER); runN(1, SYMBOLS, USER); }
