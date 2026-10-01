/**
 * scripts/htf-research.ts
 *
 * Investigación: dirección de mayor plazo (15m / 1h) con gatillo en 5m.
 * No modifica la app. Usa las velas de 5m guardadas por scripts/orb-research.ts (scratch/orb-data).
 *
 * Reglas (definidas antes de mirar resultados):
 * - Las velas de 15m y 1h se arman desde las de 5m de cada sesión. Solo se usan velas ya cerradas.
 * - Sesgo 1h:  cierre > EMA20(1h) y EMA20(1h) subiendo respecto de 3 velas atrás (espejo para venta).
 * - Sesgo 15m: EMA9(15m) > EMA21(15m) y cierre 15m > VWAP de la sesión (espejo para venta).
 * - Gatillo T1 (retroceso y reanudación en 5m): con sesgo alcista, alguna de las últimas 3 velas tocó la
 *   EMA20(5m), la vela actual cierra sobre el máximo de la anterior, sobre la EMA20(5m) y sobre el VWAP.
 * - Gatillo T0 (sin afinar en 5m): primera vela de 5m en la que aparece el sesgo.
 * - Control: mismo gatillo T1 con la dirección tomada de 5m (EMA20 > EMA50 en 5m), sin mayor plazo.
 * - Entrada: apertura de la vela siguiente, entre 09:45 y 15:00 ET. Una posición a la vez, máximo 3 por día.
 * - Salida: por tiempo (18, 24 o 36 velas) o al cierre de la sesión; stop de protección 2 ATR (mínimo 0,40%).
 * - Costos: comisión 0,11% por operación completa + 0,03% de deslizamiento en salidas a mercado.
 * - Base: mismo papel, misma hora y misma dirección, otro día elegido al azar.
 *
 * Uso: npx tsx scripts/htf-research.ts   (antes: npx tsx scripts/orb-research.ts para descargar los datos)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Kline } from '../src/services/api';
import { calculateATRSeries, calculateEMA, getEasternTime } from '../src/utils/indicators';
import { simulateTrade } from '../src/utils/tradeSimulator';

const CACHE_DIR = path.resolve(process.cwd(), 'scratch/orb-data');
const WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'SPY', 'QQQ', 'INTC', 'NFLX', 'BABA', 'PLTR', 'JPM'];
const HORIZONS = [18, 24, 36];
const ENTRY_START = 585; // 09:45 ET
const ENTRY_END = 900;   // 15:00 ET
const MAX_TRADES_PER_DAY = 3;
const WARMUP_BARS = 400;

type Dir = 'BUY' | 'SELL';
type Bias = Dir | null;

interface Prepared {
  k: Kline[];
  dayKey: string[];
  minute: number[];
  vwap: number[];
  ema20: number[];
  ema50: number[];
  atr: number[];
  bias1h: Bias[];
  bias15m: Bias[];
}

/** Arma velas de mayor plazo por sesión y devuelve, para cada vela de 5m, el índice de la última vela de mayor plazo ya cerrada. */
function resample(k: Kline[], minute: number[], dayKey: string[], sizeMin: number) {
  const bars: { close: number; end: number; vwap: number }[] = [];
  const lastClosedAt: number[] = new Array(k.length).fill(-1);
  let groupKey = '';
  let close = 0;
  let end = 0;
  let pv = 0;
  let vol = 0;
  let sessionPv = 0;
  let sessionVol = 0;
  let sessionDay = '';
  const pending: { endIdx: number; barIdx: number }[] = [];
  for (let i = 0; i < k.length; i++) {
    if (dayKey[i] !== sessionDay) { sessionDay = dayKey[i]; sessionPv = 0; sessionVol = 0; }
    const tp = (k[i].high + k[i].low + k[i].close) / 3;
    sessionPv += tp * k[i].volume;
    sessionVol += k[i].volume;
    const key = `${dayKey[i]}|${Math.floor((minute[i] - 570) / sizeMin)}`;
    if (key !== groupKey && groupKey !== '') {
      bars.push({ close, end, vwap: vol > 0 ? pv / vol : close });
      pending.push({ endIdx: i - 1, barIdx: bars.length - 1 });
    }
    if (key !== groupKey) { groupKey = key; pv = 0; vol = 0; }
    close = k[i].close;
    end = k[i].time + 300;
    pv = sessionPv;
    vol = sessionVol;
  }
  // La vela de mayor plazo queda disponible al cerrar su última vela de 5m.
  let p = 0;
  let last = -1;
  for (let i = 0; i < k.length; i++) {
    while (p < pending.length && pending[p].endIdx <= i) { last = pending[p].barIdx; p++; }
    lastClosedAt[i] = last;
  }
  return { bars, lastClosedAt };
}

function prepare(k: Kline[]): Prepared {
  const minute: number[] = [];
  const dayKey: string[] = [];
  for (const b of k) {
    const et = getEasternTime(b.time * 1000);
    minute.push(et.minuteOfDay);
    dayKey.push(`${et.year}-${et.month}-${et.day}`);
  }
  const vwap: number[] = [];
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < k.length; i++) {
    if (i === 0 || dayKey[i] !== dayKey[i - 1]) { pv = 0; vol = 0; }
    pv += ((k[i].high + k[i].low + k[i].close) / 3) * k[i].volume;
    vol += k[i].volume;
    vwap.push(vol > 0 ? pv / vol : k[i].close);
  }
  const closes = k.map(b => b.close);

  const h1 = resample(k, minute, dayKey, 60);
  const ema1h = calculateEMA(h1.bars.map(b => b.close), 20);
  const m15 = resample(k, minute, dayKey, 15);
  const ema9 = calculateEMA(m15.bars.map(b => b.close), 9);
  const ema21 = calculateEMA(m15.bars.map(b => b.close), 21);

  const bias1h: Bias[] = k.map((_, i) => {
    const j = h1.lastClosedAt[i];
    if (j < 23 || !Number.isFinite(ema1h[j]) || !Number.isFinite(ema1h[j - 3])) return null;
    const c = h1.bars[j].close;
    if (c > ema1h[j] && ema1h[j] > ema1h[j - 3]) return 'BUY';
    if (c < ema1h[j] && ema1h[j] < ema1h[j - 3]) return 'SELL';
    return null;
  });
  const bias15m: Bias[] = k.map((_, i) => {
    const j = m15.lastClosedAt[i];
    if (j < 21 || !Number.isFinite(ema21[j])) return null;
    const bar = m15.bars[j];
    if (ema9[j] > ema21[j] && bar.close > bar.vwap) return 'BUY';
    if (ema9[j] < ema21[j] && bar.close < bar.vwap) return 'SELL';
    return null;
  });

  return {
    k, dayKey, minute, vwap,
    ema20: calculateEMA(closes, 20),
    ema50: calculateEMA(closes, 50),
    atr: calculateATRSeries(k, 14),
    bias1h, bias15m,
  };
}

interface Variant {
  name: string;
  bias: (p: Prepared, i: number) => Bias;
  trigger: 'T1' | 'T0';
}

function triggerT1(p: Prepared, i: number, dir: Dir): boolean {
  const { k, ema20, vwap } = p;
  const touched = [i - 2, i - 1, i].some(j => dir === 'BUY' ? k[j].low <= ema20[j] : k[j].high >= ema20[j]);
  if (!touched) return false;
  return dir === 'BUY'
    ? k[i].close > k[i - 1].high && k[i].close > ema20[i] && k[i].close > vwap[i]
    : k[i].close < k[i - 1].low && k[i].close < ema20[i] && k[i].close < vwap[i];
}

function simulate(p: Prepared, i: number, dir: Dir, W: number) {
  const { k, atr } = p;
  if (i + 1 >= k.length || k[i + 1].time - k[i].time > 300) return null;
  const e = k[i + 1].open;
  const g = dir === 'BUY' ? 1 : -1;
  const sp = Math.max(0.004, (2 * atr[i]) / e);
  return simulateTrade(k, i, dir, { entryPrice: e, stopLoss: e * (1 - g * sp), takeProfit1: e * (1 + g * 1000 * sp) }, {
    forwardWindow: W, enablePartials: false, frictionModel: 'proportional', sessionGapCutoff: true, stepSec: 300,
  });
}

interface Trade { pnlPct: number; time: number; dir: Dir; minute: number }

function run(prepared: Map<string, Prepared>, v: Variant, W: number, rng: () => number) {
  const sig: Trade[] = [];
  const base: Trade[] = [];
  let tradingDays = 0;
  for (const p of prepared.values()) {
    const { k, dayKey, minute } = p;
    const days = [...new Set(dayKey)];
    tradingDays += days.length;
    const byDayMinute = new Map<string, number>();
    k.forEach((_, i) => byDayMinute.set(`${dayKey[i]}|${minute[i]}`, i));
    let next = -1;
    const perDay = new Map<string, number>();
    for (let i = WARMUP_BARS; i < k.length - 1; i++) {
      if (i < next || minute[i] < ENTRY_START || minute[i] >= ENTRY_END) continue;
      if ((perDay.get(dayKey[i]) ?? 0) >= MAX_TRADES_PER_DAY) continue;
      const dir = v.bias(p, i);
      if (!dir) continue;
      const fire = v.trigger === 'T1' ? triggerT1(p, i, dir) : v.bias(p, i - 1) !== dir;
      if (!fire) continue;
      const t = simulate(p, i, dir, W);
      if (!t) continue;
      sig.push({ pnlPct: t.pnlPct, time: k[i].time, dir, minute: minute[i] });
      perDay.set(dayKey[i], (perDay.get(dayKey[i]) ?? 0) + 1);
      next = t.exitIdx + 1;
      const other = days[Math.floor(rng() * days.length)];
      const j = byDayMinute.get(`${other}|${minute[i]}`);
      if (j !== undefined && j >= WARMUP_BARS) {
        const u = simulate(p, j, dir, W);
        if (u) base.push({ pnlPct: u.pnlPct, time: k[j].time, dir, minute: minute[i] });
      }
    }
  }
  return { sig, base, tradingDays };
}

function stats(a: number[]) {
  const n = a.length;
  const m = n ? a.reduce((x, y) => x + y, 0) / n : 0;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1));
  return `${m >= 0 ? '+' : ''}${m.toFixed(3)}% (n=${n}, t=${(sd > 0 ? m / (sd / Math.sqrt(n)) : 0).toFixed(1)})`;
}

function main() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.error('Faltan datos: ejecuta primero npx tsx scripts/orb-research.ts');
    process.exit(1);
  }
  const all = new Map<string, Prepared>();
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const k: Kline[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8'));
    if (k.length > 1000) all.set(f.replace('.json', ''), prepare(k));
  }
  const times = [...all.values()].flatMap(p => p.k.map(b => b.time)).sort((a, b) => a - b);
  const mid = times[Math.floor(times.length / 2)];

  const variants: Variant[] = [
    { name: 'A  sesgo 1h + gatillo 5m', bias: (p, i) => p.bias1h[i], trigger: 'T1' },
    { name: 'B  sesgo 15m + gatillo 5m', bias: (p, i) => p.bias15m[i], trigger: 'T1' },
    { name: 'C  sesgo 1h y 15m + gatillo 5m', bias: (p, i) => (p.bias1h[i] && p.bias1h[i] === p.bias15m[i] ? p.bias1h[i] : null), trigger: 'T1' },
    { name: 'D  sesgo 1h y 15m, sin gatillo 5m', bias: (p, i) => (p.bias1h[i] && p.bias1h[i] === p.bias15m[i] ? p.bias1h[i] : null), trigger: 'T0' },
    { name: 'E  control: solo 5m (EMA20>EMA50)', bias: (p, i) => (p.ema20[i] > p.ema50[i] ? 'BUY' : p.ema20[i] < p.ema50[i] ? 'SELL' : null), trigger: 'T1' },
  ];

  for (const [label, filter] of [['UNIVERSO (45)', null], ['WATCHLIST (15)', WATCHLIST]] as const) {
    const subset = new Map([...all].filter(([s]) => !filter || (filter as readonly string[]).includes(s)));
    console.log(`\n=== ${label}: ${subset.size} papeles ===`);
    for (const v of variants) {
      console.log(v.name);
      for (const W of HORIZONS) {
        let seed = 99;
        const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
        const { sig, base, tradingDays } = run(subset, v, W, rng);
        const pnl = (xs: Trade[]) => xs.map(t => t.pnlPct);
        console.log(`   ${String(W).padStart(2)} velas: señal ${stats(pnl(sig))} | alertas/papel/día ${(sig.length / tradingDays).toFixed(2)}`
          + ` | 1ª ${stats(pnl(sig.filter(t => t.time < mid)))} | 2ª ${stats(pnl(sig.filter(t => t.time >= mid)))}`
          + ` | base ${stats(pnl(base))}`);
        if (W === 36) {
          console.log(`            compras ${stats(pnl(sig.filter(t => t.dir === 'BUY')))} | ventas ${stats(pnl(sig.filter(t => t.dir === 'SELL')))}`
            + ` | 09:45-11:30 ${stats(pnl(sig.filter(t => t.minute < 690)))} | 11:30-15:00 ${stats(pnl(sig.filter(t => t.minute >= 690)))}`);
        }
      }
    }
  }
}

main();
