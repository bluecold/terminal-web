/**
 * scripts/earnings-gap-drift.ts
 *
 * PEAD intradía: en la sesión que reacciona a un balance, ¿entrar a favor del gap de apertura y
 * salir en ≤ 3 h deja E[R] neta positiva? Sólo investigación; no cambia la app.
 *
 * Diseño fijado antes de ver resultados:
 *  - Eventos: 8-K Item 2.02 de SEC EDGAR (scratch/edgar-earnings.json); sesión de reacción = misma
 *    sesión si se presentó antes de 09:30 ET, la siguiente si fue desde 16:00 ET (durante la sesión:
 *    excluido). Un evento por trimestre (8-K a < 10 días del anterior se ignoran).
 *  - Gap = apertura de la sesión de reacción / último cierre de la sesión anterior − 1; |gap| ≥ 1%.
 *  - Entrada a favor del gap a la apertura de la vela de 09:40 (señal al cierre de la de 09:35).
 *  - Niveles calculateAlertLevels de Confluencia con el ATR(14) de la vela de 09:35, horizonte
 *    canónico (36 velas), costo 0,11% + 0,03% de deslizamiento, igual que la app.
 *  - Comparaciones: dirección contraria en la misma vela; y la misma hora en días NORMALES (sin
 *    balance ni previa) con dirección al azar (promedio exhaustivo de ambas direcciones).
 *  - Regla: pasa sólo si la E[R] neta es > 0 en ambas temporadas (corte 2026-09-15) y el límite
 *    inferior del IC95 total (bootstrap por evento) es > 0.
 *  - Secundario sin valor de decisión: entrada a las 10:00 y a las 10:30.
 *
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/earnings-gap-drift.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries } from '../src/utils/indicators';
import { getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const COST = 0.11, SLIPPAGE = 0.03, MIN_GAP = 0.01, SEASON_CUT = 20260915, N_BOOT = 5000;
const DIRS_5M = ['scratch/fresh-5m-20261015', 'scratch/fresh-5m-20261021', 'scratch/fresh-5m-20261103'];
const edgar: Record<string, { acceptance: string }[]> = JSON.parse(fs.readFileSync('scratch/edgar-earnings.json', 'utf8'));

let seed = 20261104;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };
const hm = (t: number) => { const e = getEasternTime(t * 1000); return e.hour * 100 + e.minute; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const fmt = (x: number) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '  n/a');

function loadMerged(sym: string): Kline[] {
  const byTime = new Map<number, Kline>();
  for (const d of DIRS_5M) {
    const f = path.join(d, sym + '.json'); if (!fs.existsSync(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(f, 'utf-8')) as Kline[]) byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

type Dir = 'BUY' | 'SELL';
const SIGNAL_TIMES = { '09:40': 935, '10:00': 955, '10:30': 1025 } as const; // vela de señal; entrada a la apertura de la siguiente
type Slot = keyof typeof SIGNAL_TIMES;
interface Ev { sym: string; day: number; gap: number; with: Record<Slot, number | null>; against: Record<Slot, number | null>; gross: number | null }
const events: Ev[] = [];
const normal: Record<Slot, number[]> = { '09:40': [], '10:00': [], '10:30': [] };
let candidates = 0, smallGap = 0;
const fw = getStrategyForwardWindow('confluencia', '5m', undefined, false);

for (const sym of Object.keys(edgar)) {
  const k = loadMerged(sym); if (k.length < 400) continue;
  const sessions = [...new Set(k.map(b => dk(b.time)))].sort((a, b) => a - b);
  const firstIdx = new Map<number, number>(), lastIdx = new Map<number, number>();
  k.forEach((b, i) => { const d = dk(b.time); if (!firstIdx.has(d)) firstIdx.set(d, i); lastIdx.set(d, i); });
  const atr = calculateATRSeries(k, 14);

  const run = (i: number, dir: Dir) => {
    if (i < 30 || i + 1 >= k.length || dk(k[i + 1].time) !== dk(k[i].time)) return null;
    const entry = k[i + 1].open;
    const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(dir, entry, '5m', atr[i], 'confluencia', { isCrypto: false }) };
    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) return null;
    const sim = simulateTrade(k, i, dir, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE,
      frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
    const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
    return { r: (sim.pnlPct - COST) / riskPct, g: sim.grossPnlPct / riskPct };
  };
  const barAt = (day: number, time: number) => {
    const a = firstIdx.get(day), b = lastIdx.get(day); if (a === undefined || b === undefined) return -1;
    for (let i = a; i <= b; i++) if (hm(k[i].time) === time) return i;
    return -1;
  };

  // Sesiones con balance (reacción y previa) para excluirlas de NORMAL.
  const eventDays = new Set<number>();
  let lastMs = -Infinity;
  const reactions: number[] = [];
  for (const ev of [...edgar[sym]].sort((a, b) => a.acceptance.localeCompare(b.acceptance))) {
    const ms = Date.parse(ev.acceptance); if (ms - lastMs < 10 * 86400000) continue; lastMs = ms;
    const e = getEasternTime(ms); const day = e.year * 10000 + e.month * 100 + e.day, minutes = e.hour * 60 + e.minute;
    if (minutes >= 570 && minutes < 960) continue;
    const idx = sessions.findIndex(d => (minutes < 570 ? d >= day : d > day));
    if (idx <= 0 || day < sessions[0]) continue;
    reactions.push(idx);
    eventDays.add(sessions[idx]); eventDays.add(sessions[idx - 1]);
  }

  for (const idx of reactions) {
    candidates++;
    const day = sessions[idx], prevLast = lastIdx.get(sessions[idx - 1])!, open = k[firstIdx.get(day)!];
    const gap = open.open / k[prevLast].close - 1;
    if (Math.abs(gap) < MIN_GAP) { smallGap++; continue; }
    const dir: Dir = gap > 0 ? 'BUY' : 'SELL', opp: Dir = gap > 0 ? 'SELL' : 'BUY';
    const ev: Ev = { sym, day, gap, with: { '09:40': null, '10:00': null, '10:30': null }, against: { '09:40': null, '10:00': null, '10:30': null }, gross: null };
    for (const slot of Object.keys(SIGNAL_TIMES) as Slot[]) {
      const i = barAt(day, SIGNAL_TIMES[slot]); if (i < 0) continue;
      const w = run(i, dir), a = run(i, opp);
      ev.with[slot] = w ? w.r : null; ev.against[slot] = a ? a.r : null;
      if (slot === '09:40') ev.gross = w ? w.g : null;
    }
    events.push(ev);
  }
  for (const day of sessions) {
    if (eventDays.has(day)) continue;
    for (const slot of Object.keys(SIGNAL_TIMES) as Slot[]) {
      const i = barAt(day, SIGNAL_TIMES[slot]); if (i < 0) continue;
      for (const d of ['BUY', 'SELL'] as const) { const o = run(i, d); if (o) normal[slot].push(o.r); }
    }
  }
}

const ci = (xs: number[]) => {
  const ms: number[] = [];
  for (let b = 0; b < N_BOOT; b++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rand() * xs.length)]; ms.push(s / Math.max(1, xs.length)); }
  ms.sort((a, b) => a - b); return [ms[Math.floor(0.025 * N_BOOT)], ms[Math.floor(0.975 * N_BOOT)]];
};

console.log(`Balances con sesión de reacción en los datos ${candidates}; |gap| < ${MIN_GAP * 100}% descartados ${smallGap}; eventos analizados ${events.length}`);
console.log(`Gap medio absoluto ${(100 * mean(events.map(e => Math.abs(e.gap)))).toFixed(1)}%; alcistas ${events.filter(e => e.gap > 0).length}, bajistas ${events.filter(e => e.gap < 0).length}; horizonte ${fw} velas`);

for (const slot of Object.keys(SIGNAL_TIMES) as Slot[]) {
  console.log(`\n=== Entrada ${slot}${slot === '09:40' ? ' (PRINCIPAL)' : ' (secundario)'} ===`);
  for (const [title, f] of [['Total', () => true], ['Temporada 1 (jul–ago)', (e: Ev) => e.day < SEASON_CUT], ['Temporada 2 (oct–nov)', (e: Ev) => e.day >= SEASON_CUT]] as const) {
    const evs = events.filter(f);
    const w = evs.map(e => e.with[slot]).filter((x): x is number => x !== null);
    const a = evs.map(e => e.against[slot]).filter((x): x is number => x !== null);
    const paired = evs.filter(e => e.with[slot] !== null && e.against[slot] !== null).map(e => e.with[slot]! - e.against[slot]!);
    const [lo, hi] = ci(w), [plo, phi] = ci(paired);
    const wr = 100 * w.filter(x => x > 0).length / Math.max(1, w.length);
    console.log(`  ${title.padEnd(22)} a favor n=${String(w.length).padStart(3)} neto ${fmt(mean(w))}R [IC95 ${fmt(lo)}, ${fmt(hi)}] WR ${wr.toFixed(0)}% | en contra ${fmt(mean(a))}R | favor − contra ${fmt(mean(paired))}R [${fmt(plo)}, ${fmt(phi)}]`);
  }
  if (slot === '09:40') {
    const g = events.map(e => e.gross).filter((x): x is number => x !== null);
    console.log(`  Bruto a favor ${fmt(mean(g))}R`);
  }
  console.log(`  Días normales, misma hora, dirección al azar: ${fmt(mean(normal[slot]))}R (${normal[slot].length} entradas)`);
}

const main = (f: (e: Ev) => boolean) => mean(events.filter(f).map(e => e.with['09:40']).filter((x): x is number => x !== null));
const allMain = events.map(e => e.with['09:40']).filter((x): x is number => x !== null);
const [mlo] = ci(allMain);
const pass = main(e => e.day < SEASON_CUT) > 0 && main(e => e.day >= SEASON_CUT) > 0 && mlo > 0;
console.log(`\nREGLA PRERREGISTRADA: ${pass ? 'PASA' : 'NO PASA'} (T1 ${fmt(main(e => e.day < SEASON_CUT))}R, T2 ${fmt(main(e => e.day >= SEASON_CUT))}R, IC95 inferior total ${fmt(mlo)}R)`);
