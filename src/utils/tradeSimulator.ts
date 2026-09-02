import type { Kline } from '../services/api';
import type { AlertStatus } from './alertTracker';

export type TradeDirection = 'BUY' | 'SELL';

export interface TradeLevels {
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number;
  takeProfit3?: number;
}

export interface ExitPolicy {
  forwardWindow: number;                              // Maximum forward horizon (number of candles)
  enablePartials?: boolean | 'vcme-runner';            // Scaling policy (3-tier scaling for VCME)
  moveSlToBreakevenOnTp1?: boolean;                   // Move active SL to entry when TP1 hit
  earlyAdverseCutoffBars?: number;                    // e.g. 3 bars for Multifractal
  earlyAdverseCutoffR?: number;                       // e.g. 0.5R adverse threshold
  timeStopBars?: number;                             // e.g. 8 bars for VCME DayTrading stagnation
  trailingStop?: 'chandelier' | 'none';              // Trailing exit using ATR chandelier
  emergencyExitFn?: (k: Kline, idx: number, signal: TradeDirection) => boolean;
  sessionGapCutoff?: boolean;                         // Detect session boundary gap (e.g. overnight stock gap)
  stepSec?: number;                                   // Timeframe step in seconds (300 for 5m, 3600 for 1h)
  atrSeries?: number[];                               // Full-length ATR series for trailing Chandelier stop
  ema9Series?: number[];                              // Full-length EMA9 series for runner exit
  frictionPct?: number;                               // Friction/commissions deducted from net return (default: 0.08%)
  marketSlippagePct?: number;                         // Adverse slippage on market/stop orders in % (default: 0.03%)
  floatingClosePrice?: number;                        // If provided and trade is still open, compute floating PnL on this price
  maxExpiryTimestampMs?: number;                      // Timestamp in ms beyond which the trade is expired
  isCandleClosed?: (k: Kline) => boolean;            // Identifies whether a candle is finalized closed vs forming live
}

export type ExitReason = 
  | 'TP1' | 'TP2' | 'TP3' | 'TP1_BE'
  | 'SL' | 'TIME_STOP' | 'EARLY_ADVERSE' | 'EMERGENCY_EXIT' | 'SESSION_GAP' | 'TIMEOUT';

export interface TradeSimulationResult {
  outcome: 'win' | 'loss' | 'timeout';
  pnlPct: number;                        // Net PnL percentage (after friction)
  grossPnlPct: number;                   // Gross PnL percentage (before friction)
  realizedR: number;                     // Net realized R-multiple
  exitIdx: number;                       // Index of the exit candle in klines
  exitPrice: number;                     // Effective execution exit price
  exitReason: ExitReason;
  status: AlertStatus;                   // Current or terminal alert status
}

/**
 * Unified deterministic trade execution engine.
 * Single source of truth for all backtests and real-time alert tracking.
 */
export function simulateTrade(
  klines: Kline[],
  entryCandleIdx: number,
  signal: TradeDirection,
  levels: TradeLevels,
  policy: ExitPolicy
): TradeSimulationResult {
  const isBuy = signal === 'BUY';
  const entryPrice = levels.entryPrice;
  const stopLoss = levels.stopLoss;
  const tp1 = levels.takeProfit1;
  const tp2 = levels.takeProfit2 ?? tp1;
  const riskDist = Math.abs(entryPrice - stopLoss);
  const tp3 = levels.takeProfit3 ?? (isBuy ? entryPrice + 5.0 * riskDist : entryPrice - 5.0 * riskDist);

  const initialRiskPct = entryPrice > 0 ? riskDist / entryPrice : 0.02;
  const r1 = riskDist > 0 ? Math.abs(tp1 - entryPrice) / riskDist : 1.5;
  const r2 = riskDist > 0 ? Math.abs(tp2 - entryPrice) / riskDist : 2.5;
  const r3 = riskDist > 0 ? Math.abs(tp3 - entryPrice) / riskDist : 5.0;
  const frictionPct = policy.frictionPct ?? 0.08;
  const marketSlippagePct = policy.marketSlippagePct ?? 0.03;
  const marketSlippageRate = marketSlippagePct / 100;

  const isVCME_Runner = policy.enablePartials === 'vcme-runner' || policy.enablePartials === true;
  const hasPartials = isVCME_Runner;

  let currentStatus: AlertStatus = 'OPEN';
  let activeSL = stopLoss;
  let highestHigh = entryPrice;
  let lowestLow = entryPrice;
  let tp1Hit = false;
  let tp2Hit = false;
  let realizedR = 0;
  let grossPnlPct = 0;
  let exitIdx = entryCandleIdx;
  let exitPrice = entryPrice;
  let exitReason: TradeSimulationResult['exitReason'] = 'TIMEOUT';
  let isTerminated = false;

  const startIdx = entryCandleIdx + 1;
  const maxIdx = Math.min(entryCandleIdx + (policy.forwardWindow ?? 24), klines.length - 1);

  for (let f = startIdx; f <= maxIdx; f++) {
    const k = klines[f];
    const isClosed = policy.isCandleClosed ? policy.isCandleClosed(k) : true;

    // Expiration check based on absolute timestamp (market exit)
    if (isClosed && policy.maxExpiryTimestampMs && k.time * 1000 >= policy.maxExpiryTimestampMs) {
      exitIdx = f;
      exitPrice = isBuy ? k.close * (1 - marketSlippageRate) : k.close * (1 + marketSlippageRate);
      const tp1P = tp1Hit ? 0.50 * (isBuy ? (tp1 - entryPrice) / entryPrice * 100 : (entryPrice - tp1) / entryPrice * 100) : 0;
      const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * (isBuy ? (tp2 - entryPrice) / entryPrice * 100 : (entryPrice - tp2) / entryPrice * 100) : 0;
      const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
      const openPortionPnl = (isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / entryPrice * 100;
      grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
      realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
      exitReason = 'TIMEOUT';
      currentStatus = 'EXPIRED';
      isTerminated = true;
      break;
    }

    // Session boundary check (overnight gap market exit)
    if (policy.sessionGapCutoff && f > entryCandleIdx && f > 0) {
      const prevK = klines[f - 1];
      const gap = k.time - prevK.time;
      const expectedGapSec = policy.stepSec ?? 300;
      if (gap > expectedGapSec * 3) {
        exitIdx = f - 1;
        exitPrice = isBuy ? prevK.close * (1 - marketSlippageRate) : prevK.close * (1 + marketSlippageRate);
        const tp1P = tp1Hit ? 0.50 * (isBuy ? (tp1 - entryPrice) / entryPrice * 100 : (entryPrice - tp1) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * (isBuy ? (tp2 - entryPrice) / entryPrice * 100 : (entryPrice - tp2) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = (isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / entryPrice * 100;
        grossPnlPct = tp1P + tp2P + leftWeight * openPortionPnl;
        realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
        exitReason = 'SESSION_GAP';
        currentStatus = 'EXPIRED';
        isTerminated = true;
        break;
      }
    }

    if (k.high > highestHigh) highestHigh = k.high;
    if (k.low < lowestLow) lowestLow = k.low;
    const candleCount = f - entryCandleIdx;

    if (isBuy) {
      // ── 1. Stop Loss Check (Realistic Gap-Through Fill with Adverse Market Slippage) ─
      if (k.low <= activeSL) {
        const rawFill = Math.min(k.open, activeSL);
        const fill = rawFill * (1 - marketSlippageRate);
        exitIdx = f;
        exitPrice = fill;
        if (isVCME_Runner) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((tp1 - entryPrice) / entryPrice * 100);
            const tp2P = 0.25 * ((tp2 - entryPrice) / entryPrice * 100);
            const tp3P = 0.25 * ((fill - entryPrice) / entryPrice * 100);
            grossPnlPct = tp1P + tp2P + tp3P;
            realizedR = 0.50 * r1 + 0.25 * r2 + 0.25 * (riskDist > 0 ? (fill - entryPrice) / riskDist : 0);
            exitReason = 'TP2';
            currentStatus = 'TP2_CLOSED';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((tp1 - entryPrice) / entryPrice * 100);
            const beP = 0.50 * ((fill - entryPrice) / entryPrice * 100);
            grossPnlPct = tp1P + beP;
            realizedR = 0.50 * r1 + 0.50 * (riskDist > 0 ? (fill - entryPrice) / riskDist : 0);
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = ((fill - entryPrice) / entryPrice) * 100;
            realizedR = riskDist > 0 ? (fill - entryPrice) / riskDist : -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else {
          grossPnlPct = ((fill - entryPrice) / entryPrice) * 100;
          realizedR = riskDist > 0 ? (fill - entryPrice) / riskDist : -1.0;
          exitReason = 'SL';
          currentStatus = 'SL_HIT';
        }
        isTerminated = true;
        break;
      }

      // ── 2. Target 1 (Limit Fill Intra-Candle) ───────────────────────────
      if (!tp1Hit && k.high >= tp1) {
        tp1Hit = true;
        currentStatus = 'TP1_HIT';
        if (policy.moveSlToBreakevenOnTp1 ?? hasPartials) {
          activeSL = entryPrice;
        }
        const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
        const openFloating = ((k.close - entryPrice) / entryPrice) * 50;
        grossPnlPct = Number((tp1Gain + openFloating).toFixed(2));
        realizedR = Number((0.50 * r1).toFixed(2));

        if (!hasPartials) {
          exitIdx = f;
          exitPrice = tp1;
          grossPnlPct = Number(((tp1 - entryPrice) / entryPrice * 100).toFixed(2));
          realizedR = Number(r1.toFixed(2));
          exitReason = 'TP1';
          currentStatus = 'TP1_CLOSED';
          isTerminated = true;
          break;
        } else if (isClosed && k.close <= activeSL) {
          // Conservative intra-candle re-check: candle hit TP1 but closed at or below Breakeven (market stop)
          exitIdx = f;
          exitPrice = activeSL * (1 - marketSlippageRate);
          const beP = 0.50 * ((exitPrice - entryPrice) / entryPrice * 100);
          grossPnlPct = Number((tp1Gain + beP).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.50 * (riskDist > 0 ? (exitPrice - entryPrice) / riskDist : 0)).toFixed(2));
          exitReason = 'TP1_BE';
          currentStatus = 'TP1_BE_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 3. Target 2 (Limit Fill Intra-Candle) ───────────────────────────
      if (hasPartials && tp1Hit && !tp2Hit && k.high >= tp2) {
        tp2Hit = true;
        currentStatus = 'TP2_HIT';
        activeSL = tp1; // Trail SL to TP1
        const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
        const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
        const runnerFloating = ((k.close - entryPrice) / entryPrice) * 25;
        grossPnlPct = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
        const runnerFloatingR = riskDist > 0 ? 0.25 * ((k.close - entryPrice) / riskDist) : 0.25 * r2;
        realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));

        if (isClosed && k.close <= activeSL) {
          // Conservative intra-candle re-check: candle hit TP2 but closed at or below TP1 (market stop)
          const fill = activeSL * (1 - marketSlippageRate);
          const tp3Gain = ((fill - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * (riskDist > 0 ? (fill - entryPrice) / riskDist : 0)).toFixed(2));
          exitIdx = f;
          exitPrice = fill;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 4. Target 3 / Chandelier Trailing Exit (VCME Runner) ─────────────
      if (isVCME_Runner && tp2Hit) {
        const currentATR = policy.atrSeries && policy.atrSeries[f] && !isNaN(policy.atrSeries[f]) && policy.atrSeries[f] > 0
          ? policy.atrSeries[f]
          : (riskDist / 1.5);
        const chandelierSL = highestHigh - 2.5 * currentATR;
        const ema9Val = policy.ema9Series && policy.ema9Series[f] ? policy.ema9Series[f] : NaN;

        if (isClosed && (k.close <= chandelierSL || (!isNaN(ema9Val) && ema9Val > 0 && k.close < ema9Val))) {
          const runnerPrice = k.close * (1 - marketSlippageRate);
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
          const runnerGain = ((runnerPrice - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
          exitIdx = f;
          exitPrice = runnerPrice;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        } else if (k.high >= tp3) {
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
          const tp3Gain = ((tp3 - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * r3).toFixed(2));
          exitIdx = f;
          exitPrice = tp3;
          exitReason = 'TP3';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 5. Early Adverse Cutoff (Multifractal - Market Order) ────────────
      if (isClosed && policy.earlyAdverseCutoffBars && candleCount <= policy.earlyAdverseCutoffBars && currentStatus === 'OPEN') {
        const cutoffDist = (policy.earlyAdverseCutoffR ?? 0.5) * riskDist;
        if ((entryPrice - k.close) > cutoffDist) {
          const fillPrice = k.close * (1 - marketSlippageRate);
          const adverseDiff = entryPrice - fillPrice;
          grossPnlPct = -Number(((adverseDiff / entryPrice) * 100).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
          exitIdx = f;
          exitPrice = fillPrice;
          exitReason = 'EARLY_ADVERSE';
          currentStatus = 'SL_HIT';
          isTerminated = true;
          break;
        }
      }

      // ── 6. Inactivity Time-Stop (8 candles - Market Order) ───────────────
      if (isClosed && policy.timeStopBars && policy.timeStopBars > 0 && candleCount >= policy.timeStopBars && currentStatus === 'OPEN') {
        const currentGain = k.close - entryPrice;
        if (currentGain < 0.5 * riskDist) {
          const fillPrice = k.close * (1 - marketSlippageRate);
          const diffPct = ((fillPrice - entryPrice) / entryPrice) * 100;
          grossPnlPct = Number(diffPct.toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
          exitIdx = f;
          exitPrice = fillPrice;
          exitReason = 'TIME_STOP';
          currentStatus = 'EXPIRED';
          isTerminated = true;
          break;
        }
      }

      // ── 7. Emergency Exit (VWAP + EMA21 breach - Market Order) ───────────
      if (isClosed && policy.emergencyExitFn && policy.emergencyExitFn(k, f, 'BUY')) {
        const fillPrice = k.close * (1 - marketSlippageRate);
        const tp1P = tp1Hit ? 0.50 * ((tp1 - entryPrice) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * ((tp2 - entryPrice) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = (fillPrice - entryPrice) / entryPrice * 100;
        grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
        exitIdx = f;
        exitPrice = fillPrice;
        exitReason = 'EMERGENCY_EXIT';
        currentStatus = 'EXPIRED';
        isTerminated = true;
        break;
      }
    } else {
      // ── SHORT POSITION EXECUTION ─────────────────────────────────────────
      // ── 1. Stop Loss Check (Realistic Gap-Through Fill with Adverse Market Slippage) ─
      if (k.high >= activeSL) {
        const rawFill = Math.max(k.open, activeSL);
        const fill = rawFill * (1 + marketSlippageRate);
        exitIdx = f;
        exitPrice = fill;
        if (isVCME_Runner) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((entryPrice - tp1) / entryPrice * 100);
            const tp2P = 0.25 * ((entryPrice - tp2) / entryPrice * 100);
            const tp3P = 0.25 * ((entryPrice - fill) / entryPrice * 100);
            grossPnlPct = tp1P + tp2P + tp3P;
            realizedR = 0.50 * r1 + 0.25 * r2 + 0.25 * (riskDist > 0 ? (entryPrice - fill) / riskDist : 0);
            exitReason = 'TP2';
            currentStatus = 'TP2_CLOSED';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((entryPrice - tp1) / entryPrice * 100);
            const beP = 0.50 * ((entryPrice - fill) / entryPrice * 100);
            grossPnlPct = tp1P + beP;
            realizedR = 0.50 * r1 + 0.50 * (riskDist > 0 ? (entryPrice - fill) / riskDist : 0);
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = ((entryPrice - fill) / entryPrice) * 100;
            realizedR = riskDist > 0 ? (entryPrice - fill) / riskDist : -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else {
          grossPnlPct = ((entryPrice - fill) / entryPrice) * 100;
          realizedR = riskDist > 0 ? (entryPrice - fill) / riskDist : -1.0;
          exitReason = 'SL';
          currentStatus = 'SL_HIT';
        }
        isTerminated = true;
        break;
      }

      // 2. Target 1 (Limit Fill Intra-Candle)
      if (!tp1Hit && k.low <= tp1) {
        tp1Hit = true;
        currentStatus = 'TP1_HIT';
        if (policy.moveSlToBreakevenOnTp1 ?? hasPartials) {
          activeSL = entryPrice;
        }
        const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
        const openFloating = ((entryPrice - k.close) / entryPrice) * 50;
        grossPnlPct = Number((tp1Gain + openFloating).toFixed(2));
        realizedR = Number((0.50 * r1).toFixed(2));

        if (!hasPartials) {
          exitIdx = f;
          exitPrice = tp1;
          grossPnlPct = Number(((entryPrice - tp1) / entryPrice * 100).toFixed(2));
          realizedR = Number(r1.toFixed(2));
          exitReason = 'TP1';
          currentStatus = 'TP1_CLOSED';
          isTerminated = true;
          break;
        } else if (isClosed && k.close >= activeSL) {
          // Conservative intra-candle re-check: candle hit TP1 but closed at or above Breakeven (market stop)
          exitIdx = f;
          exitPrice = activeSL * (1 + marketSlippageRate);
          const beP = 0.50 * ((entryPrice - exitPrice) / entryPrice * 100);
          grossPnlPct = Number((tp1Gain + beP).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.50 * (riskDist > 0 ? (entryPrice - exitPrice) / riskDist : 0)).toFixed(2));
          exitReason = 'TP1_BE';
          currentStatus = 'TP1_BE_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // 3. Target 2 (Limit Fill Intra-Candle)
      if (hasPartials && tp1Hit && !tp2Hit && k.low <= tp2) {
        tp2Hit = true;
        currentStatus = 'TP2_HIT';
        activeSL = tp1; // Trail SL to TP1
        const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
        const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
        const runnerFloating = ((entryPrice - k.close) / entryPrice) * 25;
        grossPnlPct = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
        const runnerFloatingR = riskDist > 0 ? 0.25 * ((entryPrice - k.close) / riskDist) : 0.25 * r2;
        realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));

        if (isClosed && k.close >= activeSL) {
          // Conservative intra-candle re-check: candle hit TP2 but closed at or above TP1 (market stop)
          const fill = activeSL * (1 + marketSlippageRate);
          const tp3Gain = ((entryPrice - fill) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * ((entryPrice - fill) / riskDist)).toFixed(2));
          exitIdx = f;
          exitPrice = fill;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // 4. Target 3 / Chandelier Trailing Exit (VCME Runner)
      if (isVCME_Runner && tp2Hit) {
        const currentATR = policy.atrSeries && policy.atrSeries[f] && !isNaN(policy.atrSeries[f]) && policy.atrSeries[f] > 0
          ? policy.atrSeries[f]
          : (riskDist / 1.5);
        const chandelierSL = lowestLow + 2.5 * currentATR;
        const ema9Val = policy.ema9Series && policy.ema9Series[f] ? policy.ema9Series[f] : NaN;

        if (isClosed && (k.close >= chandelierSL || (!isNaN(ema9Val) && ema9Val > 0 && k.close > ema9Val))) {
          const runnerPrice = k.close * (1 + marketSlippageRate);
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
          const runnerGain = ((entryPrice - runnerPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
          exitIdx = f;
          exitPrice = runnerPrice;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        } else if (k.low <= tp3) {
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
          const runnerGain = ((entryPrice - tp3) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * r3).toFixed(2));
          exitIdx = f;
          exitPrice = tp3;
          exitReason = 'TP3';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // 5. Early Adverse Cutoff (Multifractal - Market Order)
      if (isClosed && policy.earlyAdverseCutoffBars && candleCount <= policy.earlyAdverseCutoffBars && currentStatus === 'OPEN') {
        const cutoffDist = (policy.earlyAdverseCutoffR ?? 0.5) * riskDist;
        if ((k.close - entryPrice) > cutoffDist) {
          const fillPrice = k.close * (1 + marketSlippageRate);
          const adverseDiff = fillPrice - entryPrice;
          grossPnlPct = -Number(((adverseDiff / entryPrice) * 100).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
          exitIdx = f;
          exitPrice = fillPrice;
          exitReason = 'EARLY_ADVERSE';
          currentStatus = 'SL_HIT';
          isTerminated = true;
          break;
        }
      }

      // 6. Inactivity Time-Stop (8 candles - Market Order)
      if (isClosed && policy.timeStopBars && policy.timeStopBars > 0 && candleCount >= policy.timeStopBars && currentStatus === 'OPEN') {
        const currentGain = entryPrice - k.close;
        if (currentGain < 0.5 * riskDist) {
          const fillPrice = k.close * (1 + marketSlippageRate);
          const diffPct = ((entryPrice - fillPrice) / entryPrice) * 100;
          grossPnlPct = Number(diffPct.toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
          exitIdx = f;
          exitPrice = fillPrice;
          exitReason = 'TIME_STOP';
          currentStatus = 'EXPIRED';
          isTerminated = true;
          break;
        }
      }

      // 7. Emergency Exit (VWAP + EMA21 breach - Market Order)
      if (isClosed && policy.emergencyExitFn && policy.emergencyExitFn(k, f, 'SELL')) {
        const fillPrice = k.close * (1 + marketSlippageRate);
        const tp1P = tp1Hit ? 0.50 * ((entryPrice - tp1) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * ((entryPrice - tp2) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = (entryPrice - fillPrice) / entryPrice * 100;
        grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
        exitIdx = f;
        exitPrice = fillPrice;
        exitReason = 'EMERGENCY_EXIT';
        currentStatus = 'EXPIRED';
        isTerminated = true;
        break;
      }
    }
  }

  // If trade did not terminate on a stop or target within forward window, calculate timeout/floating PnL
  if (!isTerminated) {
    const lastK = klines[maxIdx];
    const isLastKClosed = policy.isCandleClosed ? policy.isCandleClosed(lastK) : true;
    const candlesEvaluated = maxIdx - entryCandleIdx;
    const isExpiredByTime = isLastKClosed && policy.maxExpiryTimestampMs !== undefined && lastK.time * 1000 >= policy.maxExpiryTimestampMs;

    if ((isLastKClosed && candlesEvaluated >= policy.forwardWindow) || isExpiredByTime) {
      // Expiration: maximum strategy horizon reached (market exit)
      exitIdx = maxIdx;
      const rawPrice = policy.floatingClosePrice !== undefined ? policy.floatingClosePrice : lastK.close;
      const fillPrice = isBuy ? rawPrice * (1 - marketSlippageRate) : rawPrice * (1 + marketSlippageRate);
      exitPrice = fillPrice;
      exitReason = 'TIMEOUT';
      currentStatus = 'EXPIRED';

      const isLong = isBuy;
      const tp1P = tp1Hit
        ? 0.50 * (isLong ? (tp1 - entryPrice) : (entryPrice - tp1)) / entryPrice * 100
        : 0;
      const tp2P = (tp2Hit && isVCME_Runner)
        ? 0.25 * (isLong ? (tp2 - entryPrice) : (entryPrice - tp2)) / entryPrice * 100
        : 0;
      const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
      const openPortionPnl = (isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / entryPrice * 100;
      grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
      realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
    } else if (policy.floatingClosePrice !== undefined) {
      // Actively floating live calculation
      const p = policy.floatingClosePrice;
      exitIdx = maxIdx;
      exitPrice = p;
      if (currentStatus === 'OPEN') {
        grossPnlPct = Number(((isBuy ? p - entryPrice : entryPrice - p) / entryPrice * 100).toFixed(2));
        realizedR = 0;
      } else if (currentStatus === 'TP1_HIT') {
        const tp1Gain = isBuy ? ((tp1 - entryPrice) / entryPrice) * 50 : ((entryPrice - tp1) / entryPrice) * 50;
        const openFloating = isBuy ? ((p - entryPrice) / entryPrice) * 50 : ((entryPrice - p) / entryPrice) * 50;
        grossPnlPct = Number((tp1Gain + openFloating).toFixed(2));
        realizedR = Number((0.50 * r1).toFixed(2));
      } else if (currentStatus === 'TP2_HIT' && isVCME_Runner) {
        const tp1Gain = isBuy ? ((tp1 - entryPrice) / entryPrice) * 50 : ((entryPrice - tp1) / entryPrice) * 50;
        const tp2Gain = isBuy ? ((tp2 - entryPrice) / entryPrice) * 25 : ((entryPrice - tp2) / entryPrice) * 25;
        const runnerFloating = isBuy ? ((p - entryPrice) / entryPrice) * 25 : ((entryPrice - p) / entryPrice) * 25;
        grossPnlPct = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
        const runnerFloatingR = riskDist > 0 ? 0.25 * ((isBuy ? p - entryPrice : entryPrice - p) / riskDist) : 0.25 * r2;
        realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
      }
    } else if (maxIdx >= startIdx) {
      const lastK = klines[maxIdx];
      exitIdx = maxIdx;
      const fillPrice = isBuy ? lastK.close * (1 - marketSlippageRate) : lastK.close * (1 + marketSlippageRate);
      exitPrice = fillPrice;
      exitReason = 'TIMEOUT';
      currentStatus = 'EXPIRED';

      const tp1P = tp1Hit ? 0.50 * (isBuy ? (tp1 - entryPrice) / entryPrice * 100 : (entryPrice - tp1) / entryPrice * 100) : 0;
      const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * (isBuy ? (tp2 - entryPrice) / entryPrice * 100 : (entryPrice - tp2) / entryPrice * 100) : 0;
      const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
      const openPortionPnl = isBuy ? (exitPrice - entryPrice) / entryPrice * 100 : (entryPrice - exitPrice) / entryPrice * 100;
      grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
      realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
    }
  }

  // Number of order execution fills: 1 entry leg + 1 to 3 exit legs depending on scaling
  // Standard 2-fill trade (or no partials): 1 entry + 1 exit -> (2/2) * frictionPct = 1.0x (0.08%)
  // 3-fill trade (TP1 hit + BE/trailing exit): 1 entry + 2 exits -> (3/2) * frictionPct = 1.5x (0.12%)
  // 4-fill trade (TP1 + TP2 + runner exit): 1 entry + 3 exits -> (4/2) * frictionPct = 2.0x (0.16%)
  const fillCount = (hasPartials && tp2Hit) ? 4 : (hasPartials && tp1Hit ? 3 : 2);
  const effectiveFrictionPct = (fillCount / 2) * frictionPct;

  const netPnlPct = grossPnlPct - effectiveFrictionPct;

  // Calculate net realized R uniformly from net PnL and initial risk across all exit types
  let netRealizedR: number;
  if (!isTerminated && policy.floatingClosePrice !== undefined) {
    if (currentStatus === 'OPEN') {
      netRealizedR = 0;
    } else {
      const frictionR = initialRiskPct > 0 ? (effectiveFrictionPct / 100) / initialRiskPct : 0;
      netRealizedR = realizedR - frictionR;
    }
  } else {
    netRealizedR = initialRiskPct > 0 ? (netPnlPct / 100) / initialRiskPct : 0;
  }

  const finalRealizedR = Number(netRealizedR.toFixed(2));
  let outcome: 'win' | 'loss' | 'timeout';
  // Symmetric economic deadband in R-units evaluated BEFORE win branch:
  // Both micro-positive (+0.02R) and micro-negative (-0.02R) noise are classified as 'timeout' (scratch).
  // Real losses (e.g. -0.75R) are strictly classified as 'loss'.
  const isScratch = Math.abs(finalRealizedR) <= 0.05;

  if (isScratch) {
    outcome = 'timeout';
  } else if (finalRealizedR > 0) {
    outcome = 'win';
  } else {
    outcome = 'loss';
  }

  return {
    outcome,
    pnlPct: Number(netPnlPct.toFixed(2)),
    grossPnlPct: Number(grossPnlPct.toFixed(2)),
    realizedR: finalRealizedR,
    exitIdx,
    exitPrice,
    exitReason,
    status: currentStatus
  };
}
