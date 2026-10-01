/**
 * scripts/orb-research.ts
 *
 * Investigación del motor ORB (Opening Range Breakout) para acciones de EE.UU. en 5m.
 * No modifica la app: mide con datos reales de Yahoo antes de decidir si integrarlo.
 *
 * Reglas (definidas antes de mirar resultados):
 * - Rango de apertura: velas 09:30, 09:35 y 09:40 ET (primeros 15 minutos).
 * - Señal: primera vela entre 09:45 y 11:00 ET que cierra por encima del máximo (compra)
 *   o por debajo del mínimo (venta) del rango. Una sola operación por papel y día.
 * - Entrada: apertura de la vela siguiente.
 * - Stop: extremo opuesto del rango (o su punto medio en V6), con mínimo de 0,40% y máximo de 3%.
 * - Salida: cierre de la sesión (16:00), o objetivo a 2R en V5.
 * - Filtros opcionales: volumen relativo por horario (acumulado del día vs. promedio de los
 *   10 días previos a la misma hora) >= 1,5 y fuerza relativa vs. SPY desde la apertura.
 * - Costos: comisión 0,11% por operación completa + 0,03% de deslizamiento en salidas a mercado.
 * - Base aleatoria: misma franja, mismo stop y misma salida, con dirección y hora al azar.
 *
 * Uso: npx tsx scripts/orb-research.ts [--refresh]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime } from '../src/utils/indicators';
import { simulateTrade } from '../src/utils/tradeSimulator';

const WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'SPY', 'QQQ', 'INTC', 'NFLX', 'BABA', 'PLTR', 'JPM'];
const EXTRA = ['AVGO', 'MU', 'COIN', 'UBER', 'CRM', 'ORCL', 'ADBE', 'QCOM', 'SHOP', 'XOM', 'CVX', 'BAC', 'WFC', 'GS', 'DIS',
  'NKE', 'BA', 'CAT', 'LLY', 'UNH', 'COST', 'WMT', 'HOOD', 'SMCI', 'MSTR', 'ARM', 'SOFI', 'RIVN', 'MARA', 'SNOW'];
const UNIVERSE = [...WATCHLIST, ...EXTRA];
const CACHE_DIR = path.resolve(process.cwd(), 'scratch/orb-data');
const OR_START = 570;      // 09:30 ET
const OR_END = 585;        // 09:45 ET (exclusivo)
const SIGNAL_END = 660;    // 11:00 ET (exclusivo)
const MIN_STOP_PCT = 0.004;
const MAX_STOP_PCT = 0.03;
const RVOL_MIN = 1.5;
const RVOL_LOOKBACK_DAYS = 10;

interface Day {
  key: string;
  bars: Kline[];
  mins: number[];
  cumVol: number[];
}

interface Variant {
  name: string;
  rvol: boolean;
  rs: boolean;
  stop: 'opposite' | 'mid';
  targetR: number | null;
}

interface Trade {
  symbol: string;
  time: number;
  dir: 'BUY' | 'SELL';
  pnlPct: number;
  r: number;
}

async function fetchSymbol(symbol: string, refresh: boolean): Promise<Kline[]> {
  const file = path.join(CACHE_DIR, `${symbol}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=60d&interval=5m`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<Record<string, (number | null)[]>> } }> } };
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('sin datos');
  const q = result.indicators.quote[0];
  const nowSec = Date.now() / 1000;
  const klines: Kline[] = [];
  result.timestamp.forEach((t, i) => {
    const k = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
    const valid = [k.open, k.high, k.low, k.close].every(v => typeof v === 'number' && Number.isFinite(v));
    // Solo velas alineadas a 5m y ya cerradas (descarta la vela en formación)
    if (valid && t % 300 === 0 && t + 300 <= nowSec) klines.push(k as Kline);
  });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(klines));
  return klines;
}

function splitDays(klines: Kline[]): Day[] {
  const days = new Map<string, Day>();
  for (const k of klines) {
    const et = getEasternTime(k.time * 1000);
    if (et.minuteOfDay < OR_START || et.minuteOfDay >= 960) continue;
    const key = `${et.year}-${et.month}-${et.day}`;
    let d = days.get(key);
    if (!d) { d = { key, bars: [], mins: [], cumVol: [] }; days.set(key, d); }
    d.bars.push(k);
    d.mins.push(et.minuteOfDay);
    d.cumVol.push((d.cumVol.at(-1) ?? 0) + k.volume);
  }
  return [...days.values()].filter(d => d.mins[0] === OR_START && d.bars.length >= 60);
}

/** Volumen acumulado del día hasta el minuto dado, relativo al promedio de los días previos a esa misma hora. */
function timeOfDayRvol(days: Day[], dayIdx: number, minute: number): number | null {
  const cumAt = (d: Day) => {
    let v: number | null = null;
    for (let j = 0; j < d.mins.length && d.mins[j] <= minute; j++) v = d.cumVol[j];
    return v;
  };
  const prev: number[] = [];
  for (let p = dayIdx - 1; p >= 0 && prev.length < RVOL_LOOKBACK_DAYS; p--) {
    const v = cumAt(days[p]);
    if (v && v > 0) prev.push(v);
  }
  const today = cumAt(days[dayIdx]);
  if (prev.length < 5 || !today) return null;
  return today / (prev.reduce((a, b) => a + b, 0) / prev.length);
}

function spyChangeAt(spyDays: Map<string, Day>, key: string, minute: number): number | null {
  const d = spyDays.get(key);
  if (!d) return null;
  let close: number | null = null;
  for (let j = 0; j < d.mins.length && d.mins[j] <= minute; j++) close = d.bars[j].close;
  return close === null ? null : close / d.bars[0].open - 1;
}

function simulate(allBars: Kline[], signalIdx: number, dir: 'BUY' | 'SELL', stop: number, targetR: number | null): { pnlPct: number; r: number } | null {
  const entry = allBars[signalIdx + 1].open;
  const sign = dir === 'BUY' ? 1 : -1;
  let risk = sign * (entry - stop);
  if (risk < entry * MIN_STOP_PCT) risk = entry * MIN_STOP_PCT;
  if (risk > entry * MAX_STOP_PCT) return null;
  const levels = {
    entryPrice: entry,
    stopLoss: entry - sign * risk,
    takeProfit1: entry + sign * risk * (targetR ?? 1000),
  };
  const sim = simulateTrade(allBars, signalIdx, dir, levels, {
    forwardWindow: 100,          // sin límite práctico: la sesión corta antes
    enablePartials: false,
    frictionModel: 'proportional',
    sessionGapCutoff: true,      // sale al cierre de la sesión
    stepSec: 300,
  });
  return { pnlPct: sim.pnlPct, r: sim.realizedR };
}

function runVariant(data: Map<string, Kline[]>, variant: Variant, random: boolean, rng: () => number): Trade[] {
  const spyDays = new Map(splitDays(data.get('SPY') ?? []).map(d => [d.key, d]));
  const trades: Trade[] = [];
  for (const [symbol, klines] of data) {
    const days = splitDays(klines);
    const indexOf = new Map(klines.map((k, i) => [k.time, i]));
    days.forEach((day, dayIdx) => {
      const orBars = day.bars.filter((_, j) => day.mins[j] < OR_END);
      if (orBars.length !== 3) return;
      const orHigh = Math.max(...orBars.map(b => b.high));
      const orLow = Math.min(...orBars.map(b => b.low));
      const candidates = day.bars.map((_, j) => j).filter(j => day.mins[j] >= OR_END && day.mins[j] < SIGNAL_END);
      if (candidates.length === 0) return;

      let pick: { j: number; dir: 'BUY' | 'SELL' } | null = null;
      if (random) {
        if (rng() < 0.5) return; // aproxima la frecuencia de las señales
        pick = { j: candidates[Math.floor(rng() * candidates.length)], dir: rng() < 0.5 ? 'BUY' : 'SELL' };
      } else {
        for (const j of candidates) {
          const c = day.bars[j].close;
          if (c > orHigh) { pick = { j, dir: 'BUY' }; break; }
          if (c < orLow) { pick = { j, dir: 'SELL' }; break; }
        }
      }
      if (!pick) return;
      const minuteClose = day.mins[pick.j];

      if (variant.rvol) {
        const rv = timeOfDayRvol(days, dayIdx, minuteClose);
        if (rv === null || rv < RVOL_MIN) return;
      }
      if (variant.rs) {
        const spy = spyChangeAt(spyDays, day.key, minuteClose);
        if (spy === null || symbol === 'SPY') return;
        const own = day.bars[pick.j].close / day.bars[0].open - 1;
        if ((pick.dir === 'BUY' ? own - spy : spy - own) <= 0) return;
      }

      const globalIdx = indexOf.get(day.bars[pick.j].time);
      if (globalIdx === undefined || globalIdx + 1 >= klines.length) return;
      if (klines[globalIdx + 1].time - klines[globalIdx].time > 300) return;
      const stop = variant.stop === 'mid'
        ? (orHigh + orLow) / 2
        : (pick.dir === 'BUY' ? orLow : orHigh);
      const res = simulate(klines, globalIdx, pick.dir, stop, variant.targetR);
      if (res) trades.push({ symbol, time: day.bars[pick.j].time, dir: pick.dir, ...res });
    });
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  if (n === 0) return { n, e: 0, r: 0, wr: 0, t: 0 };
  const e = trades.reduce((a, t) => a + t.pnlPct, 0) / n;
  const sd = Math.sqrt(trades.reduce((a, t) => a + (t.pnlPct - e) ** 2, 0) / Math.max(1, n - 1));
  return {
    n,
    e,
    r: trades.reduce((a, t) => a + t.r, 0) / n,
    wr: (100 * trades.filter(t => t.pnlPct > 0).length) / n,
    t: sd > 0 ? e / (sd / Math.sqrt(n)) : 0,
  };
}

function fmt(s: ReturnType<typeof stats>): string {
  return `n=${String(s.n).padStart(4)} ${(s.e >= 0 ? '+' : '') + s.e.toFixed(3)}% ${(s.r >= 0 ? '+' : '') + s.r.toFixed(2)}R WR ${s.wr.toFixed(0)}% t=${s.t.toFixed(1)}`;
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const data = new Map<string, Kline[]>();
  for (const s of UNIVERSE) {
    try { data.set(s, await fetchSymbol(s, refresh)); } catch (e) { console.error(`✗ ${s}: ${(e as Error).message}`); }
  }
  const tradingDays = splitDays(data.get('SPY') ?? []).length;
  const allTimes = [...data.values()].flatMap(k => k.map(b => b.time)).sort((a, b) => a - b);
  const mid = allTimes[Math.floor(allTimes.length / 2)];

  const variants: Variant[] = [
    { name: 'V1 base (stop extremo, salida al cierre)', rvol: false, rs: false, stop: 'opposite', targetR: null },
    { name: 'V2 + volumen relativo >= 1,5', rvol: true, rs: false, stop: 'opposite', targetR: null },
    { name: 'V3 + fuerza relativa vs SPY', rvol: false, rs: true, stop: 'opposite', targetR: null },
    { name: 'V4 + volumen + fuerza relativa', rvol: true, rs: true, stop: 'opposite', targetR: null },
    { name: 'V5 = V4 con objetivo 2R', rvol: true, rs: true, stop: 'opposite', targetR: 2 },
    { name: 'V6 = V4 con stop en punto medio', rvol: true, rs: true, stop: 'mid', targetR: null },
  ];

  let seed = 12345;
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

  for (const [label, symbols] of [['WATCHLIST (15)', WATCHLIST], ['UNIVERSO AMPLIO (45)', UNIVERSE]] as const) {
    const subset = new Map([...data].filter(([s]) => (symbols as readonly string[]).includes(s)));
    if (!subset.has('SPY')) subset.set('SPY', data.get('SPY')!);
    console.log(`\n=== ${label}: ${subset.size} papeles, ${tradingDays} días ===`);
    for (const v of variants) {
      const tr = runVariant(subset, v, false, rng);
      const rnd = runVariant(subset, v, true, rng);
      const perDay = tr.length / (subset.size * tradingDays);
      console.log(`${v.name}`);
      console.log(`   señal  ${fmt(stats(tr))} | alertas/papel/día ${perDay.toFixed(2)} | 1ª mitad ${fmt(stats(tr.filter(t => t.time < mid)))} | 2ª mitad ${fmt(stats(tr.filter(t => t.time >= mid)))}`);
      console.log(`   azar   ${fmt(stats(rnd))}`);
      if (v.name.startsWith('V4')) {
        console.log(`   compras ${fmt(stats(tr.filter(t => t.dir === 'BUY')))} | ventas ${fmt(stats(tr.filter(t => t.dir === 'SELL')))}`);
      }
    }
  }
}

main();
