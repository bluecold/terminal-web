/**
 * scripts/confluencia-volatility-oos.ts
 *
 * Validación fuera de muestra del filtro de volatilidad de Confluencia en acciones 5m
 * (CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT). Umbral elegido sobre jul–sep 2026 (scratch/user-watchlist-5m,
 * scratch/orb-data) y validado en: (1) sesiones posteriores de esos papeles, (2) 49 papeles nunca vistos.
 * Datos: npx tsx scripts/fetch-fresh-5m.ts  →  scratch/fresh-5m-20261015
 * Nota: simula la regla de Confluencia SIN el filtro y lo aplica por umbral, para comparar pasa/rechaza.
 * Uso: npx tsx --tsconfig tsconfig.execution-tests.json scripts/confluencia-volatility-oos.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries } from '../src/utils/indicators';
import { buildConfluenciaContext, evaluateConfluenciaAt } from '../src/utils/strategyEvaluators';
import { simulateTrade } from '../src/utils/tradeSimulator';
const FRESH = 'scratch/fresh-5m-20261015';
const dk = (t: number) => { const e = getEasternTime(t * 1000); return e.year * 10000 + e.month * 100 + e.day; };
const lastDay = (dir: string, s: string) => { const f = path.join(dir, s + '.json'); if (!fs.existsSync(f)) return null; const a = JSON.parse(fs.readFileSync(f, 'utf-8')); return dk(a.at(-1).time); };
const USER = fs.readdirSync('scratch/user-watchlist-5m').filter(f => f.endsWith('.json') && !f.includes('USDT')).map(f => f.replace('.json', ''));
const ORB = fs.readdirSync('scratch/orb-data').filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
const OLD = new Set([...USER, ...ORB]);
interface Row { sym: string; day: number; atrPct: number; r: number; dir: string }
function trades(sym: string, fromDayExcl: number): Row[] {
  const k: Kline[] = JSON.parse(fs.readFileSync(path.join(FRESH, sym + '.json'), 'utf-8'));
  const atr = calculateATRSeries(k, 14); const ctx = buildConfluenciaContext(k, '5m', false);
  const out: Row[] = []; let busy = -1;
  for (let i = 30; i < k.length - 2; i++) {
    if (i <= busy) continue;
    const raw = evaluateConfluenciaAt(ctx, i);
    // Rule without the volatility guard: blocked setups are re-included with their direction
    const ev = { signal: raw.blockedSignal ?? raw.signal };
    if (ev.signal === 'NEUTRAL') continue;
    const d = dk(k[i].time); if (d <= fromDayExcl || dk(k[i + 1].time) !== d) continue;
    const entry = k[i + 1].open, sign = ev.signal === 'BUY' ? 1 : -1, risk = Math.max(2 * atr[i], entry * 0.004);
    const res = simulateTrade(k, i, ev.signal, { entryPrice: entry, stopLoss: entry - sign * risk, takeProfit1: entry + sign * 1.5 * risk },
      { forwardWindow: 36, enablePartials: false, frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300 });
    out.push({ sym, day: d, atrPct: atr[i] / k[i].close * 100, r: res.realizedR, dir: ev.signal }); busy = i + 6;
  }
  return out;
}
const stat = (g: Row[]) => { if (!g.length) return 'n=0'; const m = g.reduce((a, x) => a + x.r, 0) / g.length; const sd = Math.sqrt(g.reduce((a, x) => a + (x.r - m) ** 2, 0) / g.length);
  const w = g.filter(x => x.r > 0).length; return `n=${String(g.length).padStart(4)} E[R]=${(m >= 0 ? '+' : '') + m.toFixed(3)} ±${(1.96 * sd / Math.sqrt(g.length)).toFixed(3)} WR=${(100 * w / g.length).toFixed(0)}% totalR=${(m * g.length).toFixed(1)}`; };
function report(title: string, rows: Row[]) {
  console.log(`\n=== ${title} ===`);
  console.log(`  Sin filtro              ${stat(rows)}`);
  for (const th of [0.5, 0.6, 0.65, 0.8]) {
    const pass = rows.filter(x => x.atrPct >= th), rej = rows.filter(x => x.atrPct < th);
    console.log(`  ATR%>=${th.toFixed(2)} pasa      ${stat(pass)}   | rechaza ${stat(rej)}`);
  }
  const days = [...new Set(rows.map(r => r.day))].sort(); const mid = days[Math.floor(days.length / 2)];
  const p = rows.filter(x => x.atrPct >= 0.65);
  console.log(`  [0.65] 1ª mitad ${stat(p.filter(x => x.day < mid))} | 2ª mitad ${stat(p.filter(x => x.day >= mid))}`);
  console.log(`  [0.65] BUY ${stat(p.filter(x => x.dir === 'BUY'))} | SELL ${stat(p.filter(x => x.dir === 'SELL'))}`);
}
// 1) Temporal OOS: símbolos ya vistos, sólo días posteriores a los datos usados para elegir el umbral
const t1: Row[] = [], t1user: Row[] = [];
for (const s of OLD) { if (!fs.existsSync(path.join(FRESH, s + '.json'))) continue;
  const cut = Math.max(lastDay('scratch/user-watchlist-5m', s) ?? 0, lastDay('scratch/orb-data', s) ?? 0);
  const r = trades(s, cut); t1.push(...r); if (USER.includes(s)) t1user.push(...r); }
const d1 = [...new Set(t1.map(r => r.day))].sort();
report(`OOS temporal — 57 papeles conocidos, ${d1.length} sesiones nuevas (${d1[0]}–${d1.at(-1)})`, t1);
report(`OOS temporal — sólo tu watchlist (21)`, t1user);
// 2) Cross-sectional OOS: símbolos nunca analizados, 60 días completos
const NEWS = fs.readdirSync(FRESH).map(f => f.replace('.json', '')).filter(s => !OLD.has(s));
const t2: Row[] = []; for (const s of NEWS) t2.push(...trades(s, 0));
report(`OOS transversal — ${NEWS.length} papeles nuevos, 60 días`, t2);
// Por papel (nuevos): ATR% mediano y E[R], para ver si un filtro a nivel papel sería equivalente
const bySym = new Map<string, Row[]>(); for (const r of t2) { if (!bySym.has(r.sym)) bySym.set(r.sym, []); bySym.get(r.sym)!.push(r); }
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const lines = [...bySym].map(([s, g]) => ({ s, atr: med(g.map(x => x.atrPct)), n: g.length, e: g.reduce((a, x) => a + x.r, 0) / g.length })).sort((a, b) => a.atr - b.atr);
console.log('\nPapeles nuevos (ATR% mediano en señal → E[R]):'); console.log(lines.map(l => `${l.s}:${l.atr.toFixed(2)}%→${l.e >= 0 ? '+' : ''}${l.e.toFixed(2)}(${l.n})`).join('  '));
