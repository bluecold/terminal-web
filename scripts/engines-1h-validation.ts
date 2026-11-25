/**
 * scripts/engines-1h-validation.ts
 *
 * ¿Tienen ventaja neta los motores en velas de 1h para acciones de EE.UU.?
 * Datos: scripts/fetch-1h-1d.ts (≈2 años de 1h, 106 papeles; 1d para VCME).
 *
 * Costos reales del usuario: 0,11% si la operación abre y cierra el mismo día, 0,22% si cruza
 * la noche (0,11% por orden), más 0,03% de deslizamiento en salidas a mercado (simulador).
 *
 * Modos:
 *  - APP: igual que el backtester de la app en 1h (salida forzada al cierre de la sesión,
 *    horizonte canónico de cada motor). Siempre intradía → 0,11%.
 *  - SWING: mismas señales y niveles, se permite mantener de un día a otro hasta 21 velas
 *    (≈ 3 sesiones). VCME usa su modo swing nativo (48 velas, runner + chandelier).
 * Una posición a la vez por papel (la siguiente señal se evalúa después de la salida).
 *
 * Criterio fijado antes de mirar resultados: "ventaja" = E[R] neto > 0 en los 4 cortes
 * (1ª/2ª mitad temporal × watchlist del usuario / resto) y límite inferior del IC 95% total > 0.
 *
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/engines-1h-validation.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries } from '../src/utils/indicators';
import { computeConfluenciaSignalsSeries, computeScoringSignalsSeries, computeStandardSignalsSeries, getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable, validateScoringSRRoom } from '../src/utils/tradeLevels';
import { DEFAULT_WEIGHTS } from '../src/utils/indicators';
import { buildVCMESniperContext, evaluateVCMESniperAt } from '../src/utils/strategyEvaluators';
import { simulateTrade, type TradeLevels, type TradeSimulationResult } from '../src/utils/tradeSimulator';

const H1 = 'scratch/h1-20261015', D1 = 'scratch/d1-20261015';
const USER = new Set(fs.readdirSync('scratch/user-watchlist-5m').filter(f => f.endsWith('.json') && !f.includes('USDT')).map(f => f.replace('.json', '')));
const SYMBOLS = fs.readdirSync(H1).map(f => f.replace('.json', ''));
const SAME_DAY_COST = 0.11, OVERNIGHT_COST = 0.22, SLIPPAGE = 0.03;
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };
const load = (dir: string, s: string): Kline[] => JSON.parse(fs.readFileSync(path.join(dir, s + '.json'), 'utf-8'));

interface Row { engine: string; mode: string; sym: string; day: number; r: number; grossR: number; overnight: boolean; dir: string }

function netRow(engine: string, mode: string, sym: string, k: Kline[], i: number, dir: 'BUY' | 'SELL', levels: TradeLevels, sim: TradeSimulationResult): Row {
  const overnight = dk(k[i + 1].time) !== dk(k[sim.exitIdx].time);
  const riskPct = Math.abs(levels.entryPrice - levels.stopLoss) / levels.entryPrice * 100;
  const netPct = sim.pnlPct - (overnight ? OVERNIGHT_COST : SAME_DAY_COST);
  return { engine, mode, sym, day: dk(k[i].time), r: netPct / riskPct, grossR: sim.grossPnlPct / riskPct, overnight, dir };
}

function runGeneric(engine: 'confluencia' | 'scoring' | 'standard', sym: string, k: Kline[], swing: boolean): Row[] {
  const signals = engine === 'confluencia' ? computeConfluenciaSignalsSeries(k, '1h', false)
    : engine === 'scoring' ? computeScoringSignalsSeries(k, '1h', DEFAULT_WEIGHTS, false)
    : computeStandardSignalsSeries(k);
  const atr = calculateATRSeries(k, 14);
  const fw = swing ? 21 : getStrategyForwardWindow(engine, '1h', undefined, false);
  const warm = engine === 'standard' ? 199 : engine === 'scoring' ? 59 : 30;
  const out: Row[] = []; let next = warm;
  for (let i = warm; i < k.length - fw - 1; i++) {
    if (i < next) continue;
    const sig = signals[i]; if (sig === 'NEUTRAL') continue;
    // Modo APP: como la app, no entra cruzando la noche (la vela siguiente es de otro día)
    if (!swing && dk(k[i + 1].time) !== dk(k[i].time)) continue;
    const entry = k[i + 1].open;
    const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(sig, entry, '1h', atr[i], engine, { isCrypto: false }) };
    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) continue;
    if (engine === 'scoring' && !validateScoringSRRoom(k, i, sig, entry, levels.takeProfit1, levels.stopLoss).viable) continue;
    const sim = simulateTrade(k, i, sig, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE,
      frictionModel: 'proportional', sessionGapCutoff: !swing, stepSec: 3600 });
    out.push(netRow(engine, swing ? 'SWING' : 'APP', sym, k, i, sig, levels, sim));
    next = Math.max(i + 1, sim.exitIdx);
  }
  return out;
}

function runVCMESwing(sym: string, k: Kline[], d: Kline[]): Row[] {
  const ctx = buildVCMESniperContext(k, k, d, sym, 'swing', 'agresivo');
  const fw = 48; const out: Row[] = []; let next = 30;
  for (let i = 30; i < k.length - fw - 1; i++) {
    if (i < next) continue;
    const entry = k[i + 1].open;
    const ev = evaluateVCMESniperAt(ctx, i, entry);
    if (ev.signal === 'NEUTRAL') continue;
    const levels: TradeLevels = { entryPrice: entry, stopLoss: ev.stopLoss, takeProfit1: ev.takeProfit1, takeProfit2: ev.takeProfit2, takeProfit3: ev.takeProfit3 };
    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) continue;
    const sim = simulateTrade(k, i, ev.signal, levels, {
      forwardWindow: fw, enablePartials: 'vcme-runner', moveSlToBreakevenOnTp1: true, timeStopBars: ev.tradeType === 'DAY' ? 18 : 0,
      trailingStop: 'chandelier',
      emergencyExitFn: (bar, idx, dir) => dir === 'BUY'
        ? (bar.close < ctx.vwapSeries5m[idx] && bar.close < ctx.ema21_5m[idx])
        : (bar.close > ctx.vwapSeries5m[idx] && bar.close > ctx.ema21_5m[idx]),
      sessionGapCutoff: false, stepSec: 3600, atrSeries: ctx.atrSeries5m, ema9Series: ctx.ema9_5m,
      frictionPct: 0, marketSlippagePct: SLIPPAGE, frictionModel: 'proportional',
    });
    out.push(netRow('vcme', 'SWING', sym, k, i, ev.signal, levels, sim));
    next = Math.max(i + 1, sim.exitIdx);
  }
  return out;
}

const rows: Row[] = [];
let firstDay = 99999999, lastDay = 0;
for (const s of SYMBOLS) {
  const k = load(H1, s); if (k.length < 400) continue;
  firstDay = Math.min(firstDay, dk(k[0].time)); lastDay = Math.max(lastDay, dk(k.at(-1)!.time));
  for (const e of ['confluencia', 'scoring', 'standard'] as const) { rows.push(...runGeneric(e, s, k, false)); rows.push(...runGeneric(e, s, k, true)); }
  if (fs.existsSync(path.join(D1, s + '.json'))) rows.push(...runVCMESwing(s, k, load(D1, s)));
}
// Mitad temporal por fecha calendario (no por papel)
const days = [...new Set(rows.map(r => r.day))].sort(); const mid = days[Math.floor(days.length / 2)];
const stat = (g: Row[]) => {
  if (!g.length) return { n: 0, m: 0, ci: 0, txt: 'n=0'.padEnd(20) };
  const m = g.reduce((a, x) => a + x.r, 0) / g.length; const sd = Math.sqrt(g.reduce((a, x) => a + (x.r - m) ** 2, 0) / g.length);
  const ci = 1.96 * sd / Math.sqrt(g.length);
  return { n: g.length, m, ci, txt: `${String(g.length).padStart(5)} ${(m >= 0 ? '+' : '') + m.toFixed(3)}±${ci.toFixed(2)}` };
};
console.log(`Papeles: ${SYMBOLS.length} (watchlist ${[...USER].filter(s => SYMBOLS.includes(s)).length}), período ${firstDay}–${lastDay}, corte temporal ${mid}`);
console.log('Columnas: n  E[R] neto ±IC95  |  cortes: H1/H2 = mitades temporales, WL = tu watchlist, RESTO = otros papeles\n');
const combos = [['confluencia', 'APP'], ['confluencia', 'SWING'], ['scoring', 'APP'], ['scoring', 'SWING'], ['standard', 'APP'], ['standard', 'SWING'], ['vcme', 'SWING']];
for (const [e, mode] of combos) {
  const g = rows.filter(r => r.engine === e && r.mode === mode);
  const all = stat(g);
  const cells = [
    ['H1·WL', g.filter(r => r.day < mid && USER.has(r.sym))], ['H1·RESTO', g.filter(r => r.day < mid && !USER.has(r.sym))],
    ['H2·WL', g.filter(r => r.day >= mid && USER.has(r.sym))], ['H2·RESTO', g.filter(r => r.day >= mid && !USER.has(r.sym))],
  ] as const;
  const cellStats = cells.map(([n, c]) => ({ n, s: stat(c as Row[]) }));
  const pass = cellStats.every(c => c.s.n > 0 && c.s.m > 0) && all.m - all.ci > 0;
  const ovn = g.length ? (100 * g.filter(r => r.overnight).length / g.length).toFixed(0) : '0';
  const perSymMonth = g.length / SYMBOLS.length / 24;
  console.log(`${(e + ' ' + mode).padEnd(18)} TOTAL ${all.txt} | ${cellStats.map(c => `${c.n} ${c.s.txt}`).join(' | ')} | noche ${ovn}% | ${perSymMonth.toFixed(1)} op/papel/mes | ${pass ? 'VENTAJA ✔' : 'sin ventaja'}`);
  const b = stat(g.filter(r => r.dir === 'BUY')), s = stat(g.filter(r => r.dir === 'SELL'));
  const gross = g.reduce((a, x) => a + x.grossR, 0) / Math.max(1, g.length);
  console.log(`${''.padEnd(18)} BUY ${b.txt} | SELL ${s.txt} | bruto (sin costos ni deslizamiento) ${(gross >= 0 ? '+' : '') + gross.toFixed(3)}R`);
}
