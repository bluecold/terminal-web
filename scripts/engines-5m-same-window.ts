/**
 * scripts/engines-5m-same-window.ts
 *
 * ¿Estándar y Scoring pierden menos que Confluencia en acciones 5m porque son mejores motores,
 * o porque operan en otras horas/condiciones? Compara los tres con los niveles reales de la app
 * (calculateAlertLevels + horizonte canónico), costo 0,11% + 0,03% de deslizamiento, una posición
 * a la vez por papel y motor, en dos universos:
 *  - TODO EL DÍA: como se registran hoy las alertas informativas de Estándar/Scoring.
 *  - MISMA VENTANA: velas 09:35–10:55 ET con ATR(14) ≥ 0,5% (la puerta de Confluencia).
 * Cortes: mitades temporales × tu watchlist / resto, y últimos 30 días (comparable al INFORME).
 * Sólo investigación: no cambia nada de la app.
 *
 * Datos: se descargan 60 días de Yahoo a scratch/fresh-5m-<fecha> si no existen.
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/engines-5m-same-window.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries, isNyseOpeningHour, DEFAULT_WEIGHTS } from '../src/utils/indicators';
import { computeConfluenciaSignalsSeries, computeScoringSignalsSeries, computeStandardSignalsSeries, getStrategyForwardWindow } from '../src/utils/backtester';
import { calculateAlertLevels, isTradeFrictionViable, validateScoringSRRoom } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';

const DATA = 'scratch/fresh-5m-20261021';
const SOURCE_LIST = 'scratch/fresh-5m-20261015';
const COST = 0.11, SLIPPAGE = 0.03, MIN_ATR_PCT = 0.5;
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };

async function ensureData() {
  if (fs.existsSync(DATA) && fs.readdirSync(DATA).length > 50) return;
  fs.mkdirSync(DATA, { recursive: true });
  const nowSec = Date.now() / 1000;
  for (const s of fs.readdirSync(SOURCE_LIST).map(f => f.replace('.json', ''))) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=60d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
      if (!res.ok) { console.log(s, 'HTTP', res.status); continue; }
      const j: any = await res.json(); const r = j.chart?.result?.[0]; if (!r?.timestamp) continue;
      const q = r.indicators.quote[0]; const k: Kline[] = [];
      r.timestamp.forEach((t: number, i: number) => { const b = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
        if ([b.open, b.high, b.low, b.close].every(v => typeof v === 'number' && Number.isFinite(v)) && t % 300 === 0 && t + 300 <= nowSec) k.push(b as Kline); });
      fs.writeFileSync(path.join(DATA, `${s}.json`), JSON.stringify(k));
    } catch (e) { console.log(s, 'ERR', (e as Error).message); }
    await new Promise(r => setTimeout(r, 300));
  }
}

type Engine = 'confluencia' | 'scoring' | 'standard';
interface Row { engine: Engine; universe: 'ALLDAY' | 'WINDOW'; sym: string; day: number; r: number; grossR: number; dir: string; win: boolean; hour: number }

function run(engine: Engine, sym: string, k: Kline[], windowOnly: boolean): Row[] {
  const signals = engine === 'confluencia' ? computeConfluenciaSignalsSeries(k, '5m', false)
    : engine === 'scoring' ? computeScoringSignalsSeries(k, '5m', DEFAULT_WEIGHTS, false)
    : computeStandardSignalsSeries(k);
  const atr = calculateATRSeries(k, 14);
  const fw = getStrategyForwardWindow(engine, '5m', undefined, false);
  const warm = engine === 'standard' ? 199 : engine === 'scoring' ? 59 : 30;
  const out: Row[] = []; let next = warm;
  for (let i = warm; i < k.length - 2; i++) {
    if (i < next) continue;
    const sig = signals[i]; if (sig === 'NEUTRAL') continue;
    const d = dk(k[i].time); if (dk(k[i + 1].time) !== d) continue;
    if (windowOnly && !(isNyseOpeningHour(k[i].time * 1000) && atr[i] / k[i].close * 100 >= MIN_ATR_PCT)) continue;
    const entry = k[i + 1].open;
    const levels: TradeLevels = { entryPrice: entry, ...calculateAlertLevels(sig, entry, '5m', atr[i], engine, { isCrypto: false }) };
    if (!isTradeFrictionViable(levels.entryPrice, levels.stopLoss)) continue;
    if (engine === 'scoring' && !validateScoringSRRoom(k, i, sig, entry, levels.takeProfit1, levels.stopLoss).viable) continue;
    const sim = simulateTrade(k, i, sig, levels, { forwardWindow: fw, enablePartials: false, frictionPct: 0, marketSlippagePct: SLIPPAGE,
      frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
    const riskPct = Math.abs(entry - levels.stopLoss) / entry * 100;
    const r = (sim.pnlPct - COST) / riskPct;
    out.push({ engine, universe: windowOnly ? 'WINDOW' : 'ALLDAY', sym, day: d, r, grossR: sim.grossPnlPct / riskPct, dir: sig, win: r > 0, hour: Math.floor(getEasternTime(k[i].time * 1000).minuteOfDay / 60) });
    next = Math.max(i + 1, sim.exitIdx);
  }
  return out;
}

await ensureData();
const USER = new Set(fs.readdirSync('scratch/user-watchlist-5m').filter(f => f.endsWith('.json') && !f.includes('USDT')).map(f => f.replace('.json', '')));
const SYMBOLS = fs.readdirSync(DATA).map(f => f.replace('.json', ''));
const rows: Row[] = [];
for (const s of SYMBOLS) {
  const k: Kline[] = JSON.parse(fs.readFileSync(path.join(DATA, s + '.json'), 'utf-8')); if (k.length < 400) continue;
  for (const e of ['confluencia', 'scoring', 'standard'] as const) {
    if (e !== 'confluencia') rows.push(...run(e, s, k, false));
    rows.push(...run(e, s, k, true));
  }
}
const days = [...new Set(rows.map(r => r.day))].sort(); const mid = days[Math.floor(days.length / 2)];
const last30 = days[Math.max(0, days.length - 21)]; // ~21 sesiones ≈ 30 días calendario
const stat = (g: Row[]) => {
  if (!g.length) return { n: 0, m: 0, ci: 0, txt: 'n=0' };
  const m = g.reduce((a, x) => a + x.r, 0) / g.length; const sd = Math.sqrt(g.reduce((a, x) => a + (x.r - m) ** 2, 0) / g.length);
  const ci = 1.96 * sd / Math.sqrt(g.length); const wr = 100 * g.filter(x => x.win).length / g.length;
  return { n: g.length, m, ci, txt: `n=${String(g.length).padStart(5)} ${(m >= 0 ? '+' : '') + m.toFixed(3)}±${ci.toFixed(2)} WR ${wr.toFixed(0)}%` };
};
console.log(`Papeles ${SYMBOLS.length} (watchlist ${[...USER].filter(s => SYMBOLS.includes(s)).length}), sesiones ${days.length} (${days[0]}–${days.at(-1)}), corte ${mid}, últimos 30d desde ${last30}\n`);
for (const [e, u] of [['standard', 'ALLDAY'], ['scoring', 'ALLDAY'], ['standard', 'WINDOW'], ['scoring', 'WINDOW'], ['confluencia', 'WINDOW']] as const) {
  const g = rows.filter(r => r.engine === e && r.universe === u);
  const gross = g.reduce((a, x) => a + x.grossR, 0) / Math.max(1, g.length);
  console.log(`${(e + ' ' + (u === 'ALLDAY' ? 'todo el día' : '09:35–10:55+ATR')).padEnd(30)} TOTAL ${stat(g).txt} | bruto ${(gross >= 0 ? '+' : '') + gross.toFixed(3)}`);
  console.log(`${''.padEnd(30)} H1·WL ${stat(g.filter(r => r.day < mid && USER.has(r.sym))).txt} | H1·RESTO ${stat(g.filter(r => r.day < mid && !USER.has(r.sym))).txt}`);
  console.log(`${''.padEnd(30)} H2·WL ${stat(g.filter(r => r.day >= mid && USER.has(r.sym))).txt} | H2·RESTO ${stat(g.filter(r => r.day >= mid && !USER.has(r.sym))).txt}`);
  console.log(`${''.padEnd(30)} últ.30d ${stat(g.filter(r => r.day >= last30)).txt} | últ.30d WL ${stat(g.filter(r => r.day >= last30 && USER.has(r.sym))).txt}`);
  console.log(`${''.padEnd(30)} BUY ${stat(g.filter(r => r.dir === 'BUY')).txt} | SELL ${stat(g.filter(r => r.dir === 'SELL')).txt}\n`);
}
// Estándar todo el día por franja horaria: ¿dónde pierde/gana?
console.log('Estándar / Scoring todo el día por franja ET (E[R] neto):');
for (const e of ['standard', 'scoring'] as const) {
  const g = rows.filter(r => r.engine === e && r.universe === 'ALLDAY');
  console.log(`  ${e}`); for (let h = 9; h <= 15; h++) console.log(`    ${h}h ${stat(g.filter(r => r.hour === h)).txt}`);
  const hi = g.filter(r => r.hour >= 11), lo = g.filter(r => r.hour < 11);
  console.log(`    <11h ${stat(lo).txt} | ≥11h ${stat(hi).txt}`);
}
