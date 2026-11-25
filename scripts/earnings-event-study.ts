/**
 * scripts/earnings-event-study.ts
 *
 * Estudio de eventos: ¿Confluencia 5m (y las entradas al azar) rinden distinto en la sesión que
 * reacciona a un balance? Sirve para decidir si los avisos de `marketEvents.ts` deben seguir siendo
 * sólo informativos o justifican un filtro.
 *
 * Diseño fijado antes de ver resultados:
 *  - Fecha del balance: calendario Nasdaq por día (scratch/earnings-nasdaq, fetch-earnings-calendar.ts).
 *  - Sesión de REACCIÓN: la primera que opera el balance (mismo día si BMO, siguiente si AMC). El
 *    histórico de Nasdaq casi nunca trae el horario, así que se deduce por el volumen de los
 *    primeros 30 min (09:30–10:00 ET) del día del reporte vs el siguiente: gana el mayor si lo supera
 *    por ≥ 1,5×; si no, el evento es AMBIGUO y sus dos sesiones se excluyen. Se valida contra los
 *    eventos con horario conocido. En vivo el horario se conoce de antemano (Nasdaq/Zacks).
 *  - PREVIA: la sesión anterior a la de reacción. NORMAL: todas las demás.
 *  - Mecánica idéntica a confluencia-vs-random-entry.ts: vela elegible 09:35–10:55 ET con ATR ≥ 0,5%,
 *    entrada a la apertura de la vela siguiente, niveles calculateAlertLevels, horizonte canónico,
 *    costo 0,11% + 0,03%, una posición a la vez por papel.
 *  - Azar: promedio exhaustivo de TODAS las velas elegibles del grupo en ambas direcciones.
 *  - Cortes: temporada 1 (balances de jul–ago) y temporada 2 (oct–nov), corte 2026-09-15.
 *  - IC95 de la diferencia REACCIÓN − NORMAL por bootstrap agrupado por papel-sesión.
 *  - Regla: sólo se recomienda filtrar si REACCIÓN pierde ≥ 0,10R más que NORMAL en ambas
 *    temporadas y el IC95 total de la diferencia excluye 0. Si no, queda informativo.
 *
 * Modo --edgar: el horario sale de la hora de aceptación del 8-K Item 2.02 en SEC EDGAR
 * (scratch/edgar-earnings.json, fetch-edgar-earnings.ts): antes de 09:30 ET → reacción ese día;
 * desde 16:00 ET → la sesión siguiente; durante la sesión → se excluye. Se informa cuánto coincide
 * con la deducción por volumen.
 *
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/earnings-event-study.ts [--edgar]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries, isNyseOpeningHour } from '../src/utils/indicators';
import { computeConfluenciaSignalsSeries, getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const COST = 0.11, SLIPPAGE = 0.03, MIN_ATR_PCT = 0.5, WARM = 30, N_BOOT = 2000, SEASON_CUT = 20260915;
const DIRS_5M = ['scratch/fresh-5m-20261015', 'scratch/fresh-5m-20261021', 'scratch/fresh-5m-20261103'];
const CAL_DIR = 'scratch/earnings-nasdaq';
const USE_EDGAR = process.argv.includes('--edgar');
const edgar: Record<string, { acceptance: string }[]> = USE_EDGAR ? JSON.parse(fs.readFileSync('scratch/edgar-earnings.json', 'utf8')) : {};
let edgarIntraday = 0, edgarVsVolume = 0, edgarVsVolumeOk = 0;

let seed = 20261104;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };
const keyToNum = (k: string) => Number(k.replaceAll('-', ''));
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

// symbol -> [{ date, time }]
const calendar = new Map<string, { date: number; time: string }[]>();
for (const f of fs.readdirSync(CAL_DIR)) {
  const date = keyToNum(f.replace('.json', ''));
  for (const r of JSON.parse(fs.readFileSync(path.join(CAL_DIR, f), 'utf8')) as { symbol: string; time: string }[]) {
    if (!calendar.has(r.symbol)) calendar.set(r.symbol, []);
    calendar.get(r.symbol)!.push({ date, time: r.time });
  }
}

type Group = 'REACCION' | 'PREVIA' | 'NORMAL';
type Dir = 'BUY' | 'SELL';
interface Trade { sym: string; day: number; group: Group; r: number; g: number }
interface Cand { sym: string; day: number; group: Group; r: number }

const symbols = [...new Set(DIRS_5M.flatMap(d => fs.readdirSync(d)).map(f => f.replace('.json', '')))].filter(s => !s.includes('USDT'));
const fw = getStrategyForwardWindow('confluencia', '5m', undefined, false);
const trades: Trade[] = [], tradesFiltered: Trade[] = [], cands: Cand[] = [];
let validated = 0, validatedOk = 0, ambiguous = 0, events = 0;

for (const sym of symbols) {
  const k = loadMerged(sym); if (k.length < 400) continue;
  const sessions = [...new Set(k.map(b => dk(b.time)))].sort((a, b) => a - b);
  const openVol = new Map<number, number>();
  for (const b of k) {
    const e = getEasternTime(b.time * 1000);
    if (e.hour === 9 && e.minute >= 30) openVol.set(dk(b.time), (openVol.get(dk(b.time)) ?? 0) + b.volume);
  }

  const groupOf = new Map<number, Group | 'EXCLUIR'>();
  const markReaction = (reaction: number) => {
    groupOf.set(sessions[reaction], 'REACCION');
    if (reaction > 0 && groupOf.get(sessions[reaction - 1]) === undefined) groupOf.set(sessions[reaction - 1], 'PREVIA');
  };
  if (USE_EDGAR) {
    let lastMs = -Infinity;
    for (const ev of [...(edgar[sym] ?? [])].sort((a, b) => a.acceptance.localeCompare(b.acceptance))) {
      const ms = Date.parse(ev.acceptance);
      if (ms - lastMs < 10 * 86400000) continue; // enmiendas o 8-K repetidos del mismo trimestre
      lastMs = ms;
      const e = getEasternTime(ms);
      const day = e.year * 10000 + e.month * 100 + e.day, minutes = e.hour * 60 + e.minute;
      const idx = sessions.findIndex(d => (minutes < 570 ? d >= day : d > day));
      if (idx < 0 || (minutes < 570 && idx === 0 && sessions[0] > day)) continue;
      if (day < sessions[0] || idx >= sessions.length) continue; // fuera de los datos
      events++;
      if (minutes >= 570 && minutes < 960) {
        edgarIntraday++;
        const j = sessions.indexOf(day);
        if (j >= 0) groupOf.set(sessions[j], 'EXCLUIR');
        if (j + 1 < sessions.length) groupOf.set(sessions[j + 1], 'EXCLUIR');
        continue;
      }
      // Validación de la deducción por volumen (día del reporte vs siguiente).
      const reportIdx = minutes < 570 ? idx : idx - 1;
      if (reportIdx >= 0 && reportIdx + 1 < sessions.length) {
        const vSame = openVol.get(sessions[reportIdx]) ?? 0, vNext = openVol.get(sessions[reportIdx + 1]) ?? 0;
        const inferred = vSame >= 1.5 * vNext ? reportIdx : vNext >= 1.5 * vSame ? reportIdx + 1 : null;
        if (inferred !== null) { edgarVsVolume++; if (inferred === idx) edgarVsVolumeOk++; }
      }
      markReaction(idx);
    }
  }
  for (const ev of USE_EDGAR ? [] : (calendar.get(sym) ?? [])) {
    const idx = sessions.findIndex(d => d >= ev.date);
    if (idx < 0 || sessions[idx] !== ev.date || idx + 1 >= sessions.length) continue; // fuera de los datos
    events++;
    const vSame = openVol.get(sessions[idx]) ?? 0, vNext = openVol.get(sessions[idx + 1]) ?? 0;
    let reaction: number | null = vSame >= 1.5 * vNext ? idx : vNext >= 1.5 * vSame ? idx + 1 : null;
    if (ev.time === 'time-pre-market' || ev.time === 'time-after-hours') {
      validated++;
      if (reaction === (ev.time === 'time-pre-market' ? idx : idx + 1)) validatedOk++;
      reaction = ev.time === 'time-pre-market' ? idx : idx + 1; // horario conocido: prevalece
    }
    if (reaction === null) { ambiguous++; groupOf.set(sessions[idx], 'EXCLUIR'); groupOf.set(sessions[idx + 1], 'EXCLUIR'); continue; }
    markReaction(reaction);
  }
  const group = (t: number): Group | 'EXCLUIR' => groupOf.get(dk(t)) ?? 'NORMAL';

  const atr = calculateATRSeries(k, 14);
  const signals = computeConfluenciaSignalsSeries(k, '5m', false);
  const cache = new Map<string, { r: number; g: number; exitIdx: number } | null>();
  const outcome = (i: number, dir: Dir) => {
    const key = `${i}|${dir}`; if (cache.has(key)) return cache.get(key)!;
    const entry = k[i + 1].open;
    const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(dir, entry, '5m', atr[i], 'confluencia', { isCrypto: false }) };
    let res: { r: number; g: number; exitIdx: number } | null = null;
    if (isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) {
      const sim = simulateTrade(k, i, dir, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE,
        frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
      const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
      res = { r: (sim.pnlPct - COST) / riskPct, g: sim.grossPnlPct / riskPct, exitIdx: sim.exitIdx };
    }
    cache.set(key, res); return res;
  };
  const eligible = (i: number) => i >= WARM && i < k.length - 2 && isNyseOpeningHour(k[i].time * 1000)
    && atr[i] / k[i].close * 100 >= MIN_ATR_PCT && dk(k[i + 1].time) === dk(k[i].time);

  for (let i = WARM; i < k.length - 2; i++) {
    if (!eligible(i)) continue;
    const g = group(k[i].time); if (g === 'EXCLUIR') continue;
    for (const dir of ['BUY', 'SELL'] as const) { const o = outcome(i, dir); if (o) cands.push({ sym, day: dk(k[i].time), group: g, r: o.r }); }
  }
  for (const [list, skipReaction] of [[trades, false], [tradesFiltered, true]] as const) {
    let next = WARM;
    for (let i = WARM; i < k.length - 2; i++) {
      if (i < next) continue;
      const sig = signals[i]; if (sig === 'NEUTRAL' || !eligible(i)) continue;
      const g = group(k[i].time); if (g === 'EXCLUIR') continue;
      if (skipReaction && g === 'REACCION') continue;
      const o = outcome(i, sig as Dir); if (!o) continue;
      list.push({ sym, day: dk(k[i].time), group: g, r: o.r, g: o.g });
      next = Math.max(i + 1, o.exitIdx);
    }
  }
}

function diffCI(a: { sym: string; day: number; r: number }[], b: { sym: string; day: number; r: number }[]) {
  const clusters = (xs: typeof a) => { const m = new Map<string, number[]>(); for (const x of xs) { const key = `${x.sym}|${x.day}`; if (!m.has(key)) m.set(key, []); m.get(key)!.push(x.r); } return [...m.values()]; };
  const ca = clusters(a), cb = clusters(b);
  const draw = (cs: number[][]) => { let s = 0, n = 0; for (let j = 0; j < cs.length; j++) { const c = cs[Math.floor(rand() * cs.length)]; for (const x of c) { s += x; n++; } } return s / Math.max(1, n); };
  const ds: number[] = [];
  for (let i = 0; i < N_BOOT; i++) ds.push(draw(ca) - draw(cb));
  ds.sort((x, y) => x - y);
  return [ds[Math.floor(0.025 * N_BOOT)], ds[Math.floor(0.975 * N_BOOT)]];
}

if (USE_EDGAR) console.log(`EDGAR: ${events} balances, ${edgarIntraday} presentados durante la sesión (excluidos); la deducción por volumen coincide en ${edgarVsVolumeOk}/${edgarVsVolume} de los que no eran ambiguos`);
console.log(`Papeles ${symbols.length}, eventos en los datos ${events}, ambiguos excluidos ${ambiguous}; deducción por volumen correcta en ${validatedOk}/${validated} con horario conocido`);
console.log(`Horizonte ${fw} velas, costo ${COST}% + ${SLIPPAGE}%`);

for (const [title, filter] of [['TOTAL', () => true], ['Temporada 1 (jul–ago)', (d: number) => d < SEASON_CUT], ['Temporada 2 (oct–nov)', (d: number) => d >= SEASON_CUT]] as const) {
  const T = trades.filter(t => filter(t.day)), C = cands.filter(c => filter(c.day));
  console.log(`\n=== ${title} ===`);
  for (const g of ['REACCION', 'PREVIA', 'NORMAL'] as const) {
    const tg = T.filter(t => t.group === g), cg = C.filter(c => c.group === g);
    const nSess = new Set(cg.map(c => `${c.sym}|${c.day}`)).size;
    console.log(`  ${g.padEnd(9)} Confluencia n=${String(tg.length).padStart(4)} neto ${fmt(mean(tg.map(t => t.r)))}R bruto ${fmt(mean(tg.map(t => t.g)))}R | azar ${fmt(mean(cg.map(c => c.r)))}R (${cg.length} velas×dir, ${nSess} papel-sesiones) | Conf − azar ${fmt(mean(tg.map(t => t.r)) - mean(cg.map(c => c.r)))}R`);
  }
  const re = T.filter(t => t.group === 'REACCION'), no = T.filter(t => t.group === 'NORMAL');
  const [lo, hi] = diffCI(re, no);
  console.log(`  REACCIÓN − NORMAL (Confluencia) ${fmt(mean(re.map(t => t.r)) - mean(no.map(t => t.r)))}R  IC95 [${fmt(lo)}, ${fmt(hi)}]`);
  const pr = T.filter(t => t.group === 'PREVIA');
  const [lo3, hi3] = diffCI(pr, no);
  console.log(`  [post hoc] PREVIA − NORMAL (Confluencia) ${fmt(mean(pr.map(t => t.r)) - mean(no.map(t => t.r)))}R  IC95 [${fmt(lo3)}, ${fmt(hi3)}]  (${new Set(pr.map(t => t.sym)).size} papeles)`);
  const cre = C.filter(c => c.group === 'REACCION'), cno = C.filter(c => c.group === 'NORMAL');
  const [lo2, hi2] = diffCI(cre, cno);
  console.log(`  REACCIÓN − NORMAL (azar)        ${fmt(mean(cre.map(c => c.r)) - mean(cno.map(c => c.r)))}R  IC95 [${fmt(lo2)}, ${fmt(hi2)}]`);
  const F = tradesFiltered.filter(t => filter(t.day));
  const sum = (xs: Trade[]) => xs.reduce((s, x) => s + x.r, 0);
  console.log(`  Sin operar en REACCIÓN: n ${T.length}→${F.length}, E[R] ${fmt(mean(T.map(t => t.r)))}→${fmt(mean(F.map(t => t.r)))}R, R total ${sum(T).toFixed(1)}→${sum(F).toFixed(1)}`);
}
