import type { Kline } from '../services/api';
import type { AlertStatus } from './alertTracker';
import { DEFAULT_FRICTION_PCT } from './tradeLevels';
import type { ExitPolicy, ExitReason, TradeDirection, TradeExecutionState, TradeLevels, TradeSimulationResult } from './tradeSimulator';

const round = (n: number) => Number(n.toFixed(2));
const lowerBound = (bars: Kline[], time: number, start = 0) => {
  let end = bars.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (bars[mid].time < time) start = mid + 1;
    else end = mid;
  }
  return start;
};

/** One chronological reducer for historical bars and live observations.
 * A checkpoint owns its past: historical revisions cannot reverse its fills.
 * Within an observed bar only new extremes and the path since the preceding
 * quote are eligible; the old OHLC range is never replayed against a new stop.
 */
export function runTradeSimulation(
  klines: Kline[], entryCandleIdx: number, direction: TradeDirection,
  levels: TradeLevels, policy: ExitPolicy,
): TradeSimulationResult {
  const sign = direction === 'BUY' ? 1 : -1;
  const entry = levels.entryPrice;
  const risk = Math.abs(entry - levels.stopLoss);
  const riskPct = entry > 0 ? risk / entry : 0;
  const isTwoTier = policy.enablePartials === 'two-tier';
  const partials = policy.enablePartials === true || policy.enablePartials === 'vcme-runner' || isTwoTier;
  const targets = [
    levels.takeProfit1,
    levels.takeProfit2 ?? levels.takeProfit1,
    levels.takeProfit3 ?? (isTwoTier ? (levels.takeProfit2 ?? levels.takeProfit1) : entry + sign * 5 * risk)
  ];
  const commission = policy.frictionPct ?? DEFAULT_FRICTION_PCT;
  const slippage = (policy.marketSlippagePct ?? 0.03) / 100;
  const marketPrice = (price: number) => price * (1 - sign * slippage);
  const breached = (price: number, stop: number) => sign * (price - stop) <= 0;
  const reached = (price: number, target: number) => sign * (price - target) >= 0;
  const gross = (price: number, quantity: number) => sign * (price - entry) / entry * 100 * quantity;
  const saved = policy.executionState;
  const state: TradeExecutionState = saved ? {
    ...saved, fills: saved.fills.map(fill => ({ ...fill })),
    ...(saved.cursor ? { cursor: { bar: { ...saved.cursor.bar }, closed: saved.cursor.closed } } : {}),
    ...(saved.exit ? { exit: { ...saved.exit } } : {}),
  } : {
    version: 1, status: 'OPEN', remaining: 1, fills: [], activeSL: levels.stopLoss,
    highestHigh: entry, lowestLow: entry, barsSeen: 0, historyQuality: 'complete',
  };

  // Import only known legacy partials. Unknown execution times remain unknown.
  let legacyBoundary: number | undefined;
  if (!saved && policy.initialState) {
    const old = policy.initialState;
    const tp2 = old.tp2Hit ?? old.currentStatus === 'TP2_HIT';
    const tp1 = old.tp1Hit ?? (tp2 || old.currentStatus === 'TP1_HIT');
    if (tp1 || tp2) {
      state.historyQuality = 'legacy';
      state.status = tp2 ? 'TP2_HIT' : 'TP1_HIT';
      state.fills.push({ kind: 'TP1', quantity: 0.5, price: targets[0],
        ...(old.tp1Time !== undefined ? { barTime: old.tp1Time } : {}), source: 'legacy' });
      if (tp2) state.fills.push({ kind: 'TP2', quantity: isTwoTier ? 0.5 : 0.25, price: targets[1],
        ...(old.tp2Time !== undefined ? { barTime: old.tp2Time } : {}), source: 'legacy' });
      state.remaining = tp2 ? (isTwoTier ? 0 : 0.25) : 0.5;
      state.activeSL = old.activeSL ?? (tp2 ? targets[0] : entry);
      // Without the LAST partial's time, no historical bar is provably later
      // than that fill. Continue from the current quote, without inventing dates.
      legacyBoundary = (tp2 ? old.tp2Time : old.tp1Time) ?? klines.at(-1)?.time;
      if (legacyBoundary !== undefined) state.stopEffectiveTime = legacyBoundary;
    }
  }

  const hasFill = (kind: 'TP1' | 'TP2') => state.fills.some(fill => fill.kind === kind);
  const fill = (kind: 'TP1' | 'TP2' | 'TP3' | 'EXIT', quantity: number, price: number, k: Kline) => {
    const executed = Math.min(quantity, state.remaining);
    if (executed <= 0) return;
    state.fills.push({ kind, quantity: executed, price, barTime: k.time,
      ...(policy.observedAtMs !== undefined ? { observedAtMs: policy.observedAtMs } : {}), source: 'simulation' });
    state.remaining = Math.max(0, state.remaining - executed);
  };
  const exit = (reason: ExitReason, status: AlertStatus, price: number, k: Kline) => {
    fill('EXIT', state.remaining, price, k);
    state.status = status;
    state.exit = { reason, price, barTime: k.time };
  };
  const stop = (price: number, k: Kline) => {
    const tp2 = hasFill('TP2');
    const tp1 = hasFill('TP1');
    exit(tp2 ? 'TP2' : tp1 ? 'TP1_BE' : 'SL', tp2 ? 'TP2_CLOSED' : tp1 ? 'TP1_BE_CLOSED' : 'SL_HIT', marketPrice(price), k);
  };
  const setStop = (price: number, k: Kline) => {
    if (sign * (price - state.activeSL) > 0) {
      state.activeSL = price;
      state.stopEffectiveTime = policy.observedAtMs !== undefined ? policy.observedAtMs / 1000 : k.time;
    }
  };
  const takeTargets = (price: number, k: Kline) => {
    if (!hasFill('TP1') && reached(price, targets[0])) {
      fill('TP1', partials ? 0.5 : 1, targets[0], k);
      state.status = partials ? 'TP1_HIT' : 'TP1_CLOSED';
      if (!partials) state.exit = { reason: 'TP1', price: targets[0], barTime: k.time };
      if (policy.moveSlToBreakevenOnTp1 ?? partials) setStop(entry, k);
    }
    if (partials && hasFill('TP1') && !hasFill('TP2') && reached(price, targets[1])) {
      const tp2Qty = isTwoTier ? state.remaining : 0.25;
      fill('TP2', tp2Qty, targets[1], k);
      if (isTwoTier) {
        state.status = 'TP2_CLOSED';
        state.exit = { reason: 'TP2', price: targets[1], barTime: k.time };
      } else {
        state.status = 'TP2_HIT';
        setStop(targets[0], k);
      }
    }
    if (partials && !isTwoTier && hasFill('TP2') && reached(price, targets[2]) && state.remaining > 0) {
      fill('TP3', state.remaining, targets[2], k);
      state.status = 'TP2_CLOSED';
      state.exit = { reason: 'TP3', price: targets[2], barTime: k.time };
    }
  };

  let exitIdx = entryCandleIdx;
  const staleObservation = saved?.lastObservationMs !== undefined && policy.observedAtMs !== undefined
    && policy.observedAtMs < saved.lastObservationMs;
  if (!staleObservation && !state.exit) {
    const first = saved?.cursor ? lowerBound(klines, saved.cursor.bar.time, entryCandleIdx + 1) : entryCandleIdx + 1;
    for (let f = first; f < klines.length; f++) {
      const raw = klines[f];
      const closed = policy.isCandleClosed ? policy.isCandleClosed(raw) : true;
      if (legacyBoundary !== undefined && raw.time < legacyBoundary) {
        state.barsSeen++;
        state.highestHigh = Math.max(state.highestHigh, raw.high);
        state.lowestLow = Math.min(state.lowestLow, raw.low);
        state.cursor = { bar: { ...raw }, closed: true };
        continue;
      }
      const previous = state.cursor;
      if (previous && raw.time < previous.bar.time) continue;
      const sameBar = previous?.bar.time === raw.time;
      // Revisions to a finalized historical bar may change indicators, not fills.
      if (sameBar && previous.closed) continue;
      const priceChanged = sameBar && raw.close !== previous.bar.close;
      const newExtremes = sameBar && !previous.closed && (raw.high > previous.bar.high || raw.low < previous.bar.low);
      const closeEvent = closed && (!sameBar || !previous.closed);
      if (sameBar && !priceChanged && !newExtremes && !closeEvent) continue;
      const k: Kline = legacyBoundary === raw.time ? {
        ...raw, open: raw.close, high: raw.close, low: raw.close,
      } : sameBar ? {
        ...raw, open: previous.bar.close,
        high: Math.max(previous.bar.close, raw.close, !previous.closed && raw.high > previous.bar.high ? raw.high : -Infinity),
        low: Math.min(previous.bar.close, raw.close, !previous.closed && raw.low < previous.bar.low ? raw.low : Infinity),
      } : raw;
      exitIdx = f;

      // Session exit precedes the next open. No entry is allowed before its own bar.
      if (!sameBar && previous && policy.sessionGapCutoff && raw.time - previous.bar.time > (policy.stepSec ?? 300) * 3) {
        exit('SESSION_GAP', 'EXPIRED', marketPrice(previous.bar.close), previous.bar);
        exitIdx = Math.max(entryCandleIdx, f - 1);
        break;
      }
      if (!sameBar) state.barsSeen++;
      state.highestHigh = Math.max(state.highestHigh, k.high);
      state.lowestLow = Math.min(state.lowestLow, k.low);
      state.cursor = { bar: { ...raw }, closed: closed || (sameBar && previous.closed) };
      if (policy.observedAtMs !== undefined) state.lastObservationMs = policy.observedAtMs;

      if (closed && policy.maxExpiryTimestampMs !== undefined && raw.time * 1000 >= policy.maxExpiryTimestampMs) {
        exit('TIMEOUT', 'EXPIRED', marketPrice(k.close), k);
        break;
      }
      // Gap-through stops precede later highs/lows. OHLC ambiguity is stop-first,
      // using only the quantity and stop active at this observation.
      if (breached(k.open, state.activeSL)) { stop(k.open, k); break; }
      takeTargets(k.open, k);
      if (state.exit) break;
      if (breached(sign === 1 ? k.low : k.high, state.activeSL)) { stop(state.activeSL, k); break; }
      takeTargets(sign === 1 ? k.high : k.low, k);
      if (state.exit) break;
      if (breached(k.close, state.activeSL)) { stop(state.activeSL, k); break; }
      if (closeEvent) {
        if (partials && hasFill('TP2') && (policy.trailingStop ?? 'chandelier') === 'chandelier') {
          const suppliedATR = policy.atrSeries?.[f];
          const atr = suppliedATR && Number.isFinite(suppliedATR) && suppliedATR > 0 ? suppliedATR : risk / 1.5;
          const trailing = sign === 1 ? state.highestHigh - 2.5 * atr : state.lowestLow + 2.5 * atr;
          const ema = policy.ema9Series?.[f];
          if (breached(k.close, trailing) || (ema && Number.isFinite(ema) && sign * (k.close - ema) < 0)) {
            exit('TP2', 'TP2_CLOSED', marketPrice(k.close), k);
          }
        }
        if (!state.exit && state.status === 'OPEN' && policy.earlyAdverseCutoffBars && state.barsSeen <= policy.earlyAdverseCutoffBars
          && sign * (entry - k.close) > (policy.earlyAdverseCutoffR ?? 0.5) * risk) {
          exit('EARLY_ADVERSE', 'SL_HIT', marketPrice(k.close), k);
        }
        const minTimeStopR = policy.timeStopMinR ?? 0.5;
        if (!state.exit && state.status === 'OPEN' && policy.timeStopBars && state.barsSeen >= policy.timeStopBars
          && sign * (k.close - entry) < minTimeStopR * risk) {
          exit('TIME_STOP', 'EXPIRED', marketPrice(k.close), k);
        }
        if (!state.exit && policy.emergencyExitFn?.(raw, f, direction)) {
          exit('EMERGENCY_EXIT', 'EXPIRED', marketPrice(k.close), k);
        }
        if (!state.exit && state.barsSeen >= policy.forwardWindow) {
          exit('TIMEOUT', 'EXPIRED', marketPrice(k.close), k);
        }
      }
      if (state.exit) break;
    }
  }

  const lastBar = state.cursor?.bar;
  const newestInput = klines[klines.length - 1];
  const currentQuote = !staleObservation && (!lastBar || (newestInput && newestInput.time >= lastBar.time));
  let mark = currentQuote ? (policy.floatingClosePrice ?? lastBar?.close ?? entry) : (lastBar?.close ?? entry);
  if (!staleObservation && !state.exit && policy.floatingClosePrice === undefined && lastBar) exit('TIMEOUT', 'EXPIRED', marketPrice(lastBar.close), lastBar);
  if (state.exit) mark = state.exit.price;
  const tp1 = state.fills.find(fill => fill.kind === 'TP1');
  const tp2 = state.fills.find(fill => fill.kind === 'TP2');
  const isUnexecutedSessionGap = state.exit?.reason === 'SESSION_GAP' && exitIdx <= entryCandleIdx && !tp1 && !tp2;
  const realizedGross = isUnexecutedSessionGap ? 0 : state.fills.reduce((sum, fill) => sum + gross(fill.price, fill.quantity), 0);
  const rawGross = isUnexecutedSessionGap ? 0 : realizedGross + gross(mark, state.remaining);
  // Open P&L reserves an eventual exit fee; the fill ledger contains only actual fills.
  const fillsForCost = 1 + state.fills.length + (state.remaining > 0 ? 1 : 0);
  const frictionModel = policy.frictionModel ?? 'proportional';
  const fees = isUnexecutedSessionGap ? 0 : (frictionModel === 'proportional' ? commission : fillsForCost / 2 * commission);
  const accountingGross = state.exit?.reason === 'SL' || state.exit?.reason === 'TP1_BE' || state.exit?.reason === 'SESSION_GAP'
    ? rawGross : round(rawGross);
  const net = isUnexecutedSessionGap ? 0 : accountingGross - fees;
  let realizedR = isUnexecutedSessionGap ? 0 : (riskPct > 0 ? (net / 100) / riskPct : 0);
  if (!state.exit && state.status === 'OPEN') realizedR = 0;
  else if (!state.exit && state.status === 'TP1_HIT') realizedR = riskPct > 0 ? round(realizedGross / 100 / riskPct) - fees / 100 / riskPct : 0;
  else if (!state.exit && state.status === 'TP2_HIT') realizedR = riskPct > 0 ? round(rawGross / 100 / riskPct) - fees / 100 / riskPct : 0;
  realizedR = round(realizedR);
  const finalTime = state.exit?.barTime ?? lastBar?.time;
  if (finalTime !== undefined) {
    const found = lowerBound(klines, finalTime);
    if (klines[found]?.time === finalTime) exitIdx = found;
  }
  return {
    outcome: Math.abs(realizedR) <= 0.05 ? 'timeout' : realizedR > 0 ? 'win' : 'loss',
    pnlPct: round(net), grossPnlPct: round(accountingGross), realizedR,
    exitIdx, exitPrice: mark, exitReason: state.exit?.reason ?? 'TIMEOUT', status: state.status,
    tp1Hit: !!tp1, tp2Hit: !!tp2, tp1Time: tp1?.barTime, tp2Time: tp2?.barTime,
    activeSL: state.activeSL, executionState: state,
  };
}
