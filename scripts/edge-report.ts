/**
 * scripts/edge-report.ts
 *
 * Quantitative Edge & Benchmark Report
 * - Evaluates strategies across the entire 15-stock US equities watchlist on REAL Yahoo Finance 5m data
 * - Measures performance under real broker friction (0.11% commission + 0.03% slippage = 0.14% round-trip)
 * - Compares directional signals against an empirical random-entry benchmark in the same session windows
 * - Performs split validation (First 70% In-Sample vs Last 30% Out-of-Sample) to verify robustness
 *
 * Usage: npx tsx scripts/edge-report.ts
 */

import {
  backtestStandard,
  backtestConfluencia,
  backtestScoring,
  backtestMFLS,
  type BacktestResult,
} from '../src/utils/backtester';
import { DEFAULT_FRICTION_PCT, DEFAULT_SLIPPAGE_PCT } from '../src/utils/tradeLevels';
import { simulateTrade, type TradeLevels } from '../src/utils/tradeSimulator';
import type { Kline } from '../src/services/api';
import { getEasternTime, calculateATRSeries } from '../src/utils/indicators';
import { WATCHLIST_SYMBOLS, getCachedKlines, loadWatchlistRealData } from './fetch-real-data';

interface StrategyAgg {
  name: string;
  runner: (klines: Kline[], symbol: string) => BacktestResult;
}

/**
 * Realistic random-entry benchmark:
 * - Samples random entries in active market hours across the same real stocks
 * - Enters at next candle open (klines[i+1].open)
 * - Identical 2.0 ATR stop geometry (floored at 0.40%)
 * - Identical holding window and 0.14% friction
 * - Crucial: passes i (signal candle) to simulateTrade so entry at i+1.open is evaluated on bar i+1
 */
function simulateRealisticRandomBaseline(
  klines: Kline[],
  forwardWindow: number = 24,
  atrMult: number = 2.0,
  minFloorPct: number = 0.0040,
  sessionWindow?: { minMinute: number; maxMinute: number }
): { totalR: number; wins: number; trades: number; pnlPct: number } {
  const atrSeries = calculateATRSeries(klines, 14);
  let totalR = 0;
  let wins = 0;
  let trades = 0;
  let pnlPct = 0;

  for (let i = 30; i < klines.length - forwardWindow - 1; i += 6) {
    const et = getEasternTime(klines[i].time * 1000);
    if (sessionWindow) {
      if (et.minuteOfDay < sessionWindow.minMinute || et.minuteOfDay >= sessionWindow.maxMinute) continue;
    } else {
      // Active session (09:30 - 11:30 and 14:00 - 15:15)
      if (et.minuteOfDay < 570 || et.minuteOfDay >= 915) continue;
      if (et.minuteOfDay >= 690 && et.minuteOfDay < 840) continue; // skip midday chop (< 840)
    }

    const nextBar = klines[i + 1];
    const entryPrice = nextBar.open;
    const atr = atrSeries[i] || (entryPrice * 0.005);
    const stopDist = Math.max(entryPrice * minFloorPct, atr * atrMult);
    const stopLoss = entryPrice - stopDist;
    const takeProfit1 = entryPrice + 1.5 * stopDist;

    const levels: TradeLevels = {
      entryPrice,
      stopLoss,
      takeProfit1,
    };

    // Pass i (signal bar) so simulateTrade evaluates bar i+1 (entry bar) onward:
    const sim = simulateTrade(klines, i, 'BUY', levels, {
      forwardWindow,
      frictionPct: DEFAULT_FRICTION_PCT,
      marketSlippagePct: DEFAULT_SLIPPAGE_PCT,
      frictionModel: 'proportional',
      sessionGapCutoff: true,
      stepSec: 300,
    });

    totalR += sim.realizedR;
    pnlPct += sim.pnlPct;
    if (sim.realizedR > 0) wins++;
    trades++;
  }

  return { totalR, wins, trades, pnlPct };
}

export async function runEdgeReport() {
  console.log('='.repeat(92));
  console.log(' FINCEPT TERMINAL — REPORTE CUANTITATIVO DE EDGE AGREGADO (DATOS REALES YAHOO)');
  console.log(` Watchlist: ${WATCHLIST_SYMBOLS.length} acciones | Período: ~60 días reales | Velas: 5m`);
  console.log(` Fricción Real: ${DEFAULT_FRICTION_PCT}% broker + ${DEFAULT_SLIPPAGE_PCT}% slippage = ${(DEFAULT_FRICTION_PCT + DEFAULT_SLIPPAGE_PCT).toFixed(2)}% total`);
  console.log('='.repeat(92));

  // Load real data
  let dataMap = new Map<string, Kline[]>();
  for (const sym of WATCHLIST_SYMBOLS) {
    const klines = getCachedKlines(sym);
    if (klines && klines.length > 500) {
      dataMap.set(sym, klines);
    }
  }

  if (dataMap.size < WATCHLIST_SYMBOLS.length) {
    dataMap = await loadWatchlistRealData();
  }

  // Calculate distinct trading days observed across datasets
  const uniqueTradingDays = new Set<string>();
  for (const klines of dataMap.values()) {
    for (const k of klines) {
      const dayStr = new Date(k.time * 1000).toISOString().slice(0, 10);
      uniqueTradingDays.add(dayStr);
    }
  }
  const numDays = Math.max(1, uniqueTradingDays.size);

  // 1. General Active Session Random Baseline (09:30-11:30 and 14:00-15:15)
  let randTotalR = 0;
  let randWins = 0;
  let randTrades = 0;
  let randPnl = 0;

  // 2. Opening Hour Random Baseline (09:30-10:30) for apples-to-apples comparison with Confluencia
  let openRandTotalR = 0;
  let openRandWins = 0;
  let openRandTrades = 0;
  let openRandPnl = 0;

  for (const klines of dataMap.values()) {
    const res = simulateRealisticRandomBaseline(klines, 24, 2.0, 0.0040);
    randTotalR += res.totalR;
    randWins += res.wins;
    randTrades += res.trades;
    randPnl += res.pnlPct;

    const openRes = simulateRealisticRandomBaseline(klines, 36, 2.0, 0.0040, { minMinute: 570, maxMinute: 630 });
    openRandTotalR += openRes.totalR;
    openRandWins += openRes.wins;
    openRandTrades += openRes.trades;
    openRandPnl += openRes.pnlPct;
  }

  const randWr = randTrades > 0 ? (randWins / randTrades) * 100 : 0;
  const randExpR = randTrades > 0 ? randTotalR / randTrades : 0;
  const randNetPct = randTrades > 0 ? randPnl / randTrades : 0;

  const openRandWr = openRandTrades > 0 ? (openRandWins / openRandTrades) * 100 : 0;
  const openRandExpR = openRandTrades > 0 ? openRandTotalR / openRandTrades : 0;
  const openRandNetPct = openRandTrades > 0 ? openRandPnl / openRandTrades : 0;

  console.log('\n--- LÍNEAS BASE ALEATORIAS (COMPRAS AL AZAR / 15 ACCIONES REALES / COSTO REAL 0.14%) ---');
  console.log(` • Sesión Activa Completa:  ${randExpR.toFixed(2)}R | Win Rate: ${randWr.toFixed(1)}% | Retorno Neto: ${randNetPct.toFixed(2)}% | N=${randTrades}`);
  console.log(` • Apertura (09:30-10:30):   ${openRandExpR.toFixed(2)}R | Win Rate: ${openRandWr.toFixed(1)}% | Retorno Neto: ${openRandNetPct.toFixed(2)}% | N=${openRandTrades}`);
  console.log(` * Días hábiles reales observados en el dataset: ${numDays} días.\n`);

  console.log('┌─────────────────────────────┬────────────┬──────────┬──────────────┬────────────┬────────────┐');
  console.log('│         Estrategia          │  Alertas/  │ Tasa de  │  Resultado   │ Primer 70% │ Último 30% │');
  console.log('│                             │  papel/día │ acierto  │   Neto (R)   │ (InSample) │ (OutSample)│');
  console.log('├─────────────────────────────┼────────────┼──────────┼──────────────┼────────────┼────────────┤');

  const strategies: StrategyAgg[] = [
    {
      name: 'Confluencia (5m Long)',
      runner: (klines, sym) => backtestConfluencia(klines, '5m', sym)
    },
    {
      name: 'Scoring (5m Long)',
      runner: (klines, sym) => backtestScoring(klines, '5m', undefined, sym)
    },
    {
      name: 'MFLS Sweep (5m)',
      runner: (klines, sym) => backtestMFLS(klines, '5m', sym)
    },
    {
      name: 'Standard Voting (5m)',
      runner: (klines, sym) => backtestStandard(klines, '5m', sym)
    }
  ];

  for (const strat of strategies) {
    let totalR = 0;
    let wins = 0;
    let totalTrades = 0;
    let isR = 0;
    let isTrades = 0;
    let oosR = 0;
    let oosTrades = 0;

    for (const [sym, klines] of dataMap.entries()) {
      const res = strat.runner(klines, sym);

      totalTrades += res.totalSignals;
      wins += res.wins;
      totalR += res.expectancyR * res.totalSignals;

      if (res.walkForward) {
        const wf = res.walkForward;
        isTrades += wf.inSample.signals;
        isR += wf.inSample.expectancyR * wf.inSample.signals;
        oosTrades += wf.outOfSample.signals;
        oosR += wf.outOfSample.expectancyR * wf.outOfSample.signals;
      }
    }

    const perDay = totalTrades / (WATCHLIST_SYMBOLS.length * numDays);
    const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const expR = totalTrades > 0 ? totalR / totalTrades : 0;
    const isVal = isTrades > 0 ? isR / isTrades : 0;
    const oosVal = oosTrades > 0 ? oosR / oosTrades : 0;

    const padName = strat.name.padEnd(27, ' ');
    const padAlerts = perDay.toFixed(2).padStart(8, ' ');
    const padWr = `${wr.toFixed(0)}%`.padStart(6, ' ');
    const padExpR = `${expR >= 0 ? '+' : ''}${expR.toFixed(2)}R`.padStart(10, ' ');
    const padIS = `${isVal >= 0 ? '+' : ''}${isVal.toFixed(2)}R`.padStart(8, ' ');
    const padOOS = `${oosVal >= 0 ? '+' : ''}${oosVal.toFixed(2)}R`.padStart(8, ' ');

    console.log(`│ ${padName} │  ${padAlerts}  │   ${padWr} │   ${padExpR} │   ${padIS} │   ${padOOS} │`);
  }

  console.log('└─────────────────────────────┴────────────┴──────────┴──────────────┴────────────┴────────────┘');
  console.log('\n✔ Medición con datos reales completada exitosamente.');
}

if (process.argv[1]?.includes('edge-report')) {
  runEdgeReport();
}
