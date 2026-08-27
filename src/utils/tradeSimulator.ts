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
  enablePartials?: boolean | 'standard' | 'vcme-runner'; // Scaling policy
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
  floatingClosePrice?: number;                        // If provided and trade is still open, compute floating PnL on this price
  maxExpiryTimestampMs?: number;                      // Timestamp in ms beyond which the trade is expired
}

export interface TradeSimulationResult {
  outcome: 'win' | 'loss' | 'timeout';
  pnlPct: number;                        // Net PnL percentage (after friction)
  grossPnlPct: number;                   // Gross PnL percentage (before friction)
  realizedR: number;                     // Net realized R-multiple
  exitIdx: number;                       // Index of the exit candle in klines
  exitPrice: number;                     // Effective execution exit price
  exitReason: 
    | 'TP1' | 'TP2' | 'TP3' | 'TP1_BE'
    | 'SL' | 'TIME_STOP' | 'EARLY_ADVERSE' | 'EMERGENCY_EXIT' | 'SESSION_GAP' | 'TIMEOUT';
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
  const frictionPct = policy.frictionPct ?? 0.08;

  const isVCME_Runner = policy.enablePartials === 'vcme-runner' || (policy.enablePartials === true && policy.trailingStop === 'chandelier');
  const isStandardPartials = policy.enablePartials === 'standard' || (policy.enablePartials === true && !isVCME_Runner);
  const hasPartials = isVCME_Runner || isStandardPartials;

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
  const maxIdx = Math.min(entryCandleIdx + policy.forwardWindow, klines.length - 1);

  for (let f = startIdx; f <= maxIdx; f++) {
    const k = klines[f];

    // Expiration check based on absolute timestamp
    if (policy.maxExpiryTimestampMs && k.time * 1000 >= policy.maxExpiryTimestampMs) {
      exitIdx = f;
      exitPrice = k.close;
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

    // Session boundary check (overnight gap exit)
    if (policy.sessionGapCutoff && f > startIdx) {
      const prevK = klines[f - 1];
      const gap = k.time - prevK.time;
      const expectedGapSec = policy.stepSec ?? 300;
      if (gap > expectedGapSec * 3) {
        exitIdx = f - 1;
        exitPrice = prevK.close;
        const tp1P = tp1Hit ? 0.50 * (isBuy ? (tp1 - entryPrice) / entryPrice * 100 : (entryPrice - tp1) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * (isBuy ? (tp2 - entryPrice) / entryPrice * 100 : (entryPrice - tp2) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = isBuy ? (exitPrice - entryPrice) / entryPrice * 100 : (entryPrice - exitPrice) / entryPrice * 100;
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
      // ── 1. Stop Loss Check ──────────────────────────────────────────────
      if (k.low <= activeSL) {
        exitIdx = f;
        exitPrice = activeSL;
        if (isVCME_Runner) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((tp1 - entryPrice) / entryPrice * 100);
            const tp2P = 0.25 * ((tp2 - entryPrice) / entryPrice * 100);
            const tp3P = 0.25 * ((activeSL - entryPrice) / entryPrice * 100);
            grossPnlPct = tp1P + tp2P + tp3P;
            realizedR = 0.50 * r1 + 0.25 * r2 + 0.25 * ((activeSL - entryPrice) / riskDist);
            exitReason = 'TP2';
            currentStatus = 'TP2_CLOSED';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((tp1 - entryPrice) / entryPrice * 100);
            grossPnlPct = tp1P;
            realizedR = 0.50 * r1;
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = -(initialRiskPct * 100);
            realizedR = -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else if (isStandardPartials) {
          if (tp1Hit) {
            const tp1P = 0.50 * ((tp1 - entryPrice) / entryPrice * 100);
            grossPnlPct = tp1P;
            realizedR = 0.50 * r1;
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = -(initialRiskPct * 100);
            realizedR = -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else {
          grossPnlPct = -(initialRiskPct * 100);
          realizedR = -1.0;
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
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 3. Target 2 (Limit Fill Intra-Candle) ───────────────────────────
      if (hasPartials && tp1Hit && !tp2Hit && k.high >= tp2) {
        tp2Hit = true;
        if (isVCME_Runner) {
          currentStatus = 'TP2_HIT';
          activeSL = tp1; // Trail SL to TP1
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
          const runnerFloating = ((k.close - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
          const runnerFloatingR = riskDist > 0 ? 0.25 * ((k.close - entryPrice) / riskDist) : 0.25 * r2;
          realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
        } else {
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 50;
          grossPnlPct = Number((tp1Gain + tp2Gain).toFixed(2));
          realizedR = Number(((r1 + r2) / 2).toFixed(2));
          exitIdx = f;
          exitPrice = tp2;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 4. Target 3 / Chandelier Trailing Exit (VCME Runner) ────────────
      if (isVCME_Runner && tp2Hit) {
        const currentATR = policy.atrSeries && policy.atrSeries[f] && !isNaN(policy.atrSeries[f]) && policy.atrSeries[f] > 0
          ? policy.atrSeries[f]
          : (riskDist / 1.5);
        const chandelierSL = highestHigh - 2.5 * currentATR;
        const ema9Val = policy.ema9Series && policy.ema9Series[f] ? policy.ema9Series[f] : NaN;

        if (k.close <= chandelierSL || (!isNaN(ema9Val) && ema9Val > 0 && k.close < ema9Val)) {
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
          const runnerGain = ((k.close - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        } else if (k.high >= tp3) {
          const tp1Gain = ((tp1 - entryPrice) / entryPrice) * 50;
          const tp2Gain = ((tp2 - entryPrice) / entryPrice) * 25;
          const tp3Gain = ((tp3 - entryPrice) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * 5.0).toFixed(2));
          exitIdx = f;
          exitPrice = tp3;
          exitReason = 'TP3';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // ── 5. Early Adverse Cutoff (Multifractal) ───────────────────────────
      if (policy.earlyAdverseCutoffBars && candleCount <= policy.earlyAdverseCutoffBars && currentStatus === 'OPEN') {
        const adverseDiff = entryPrice - k.close;
        const cutoffDist = (policy.earlyAdverseCutoffR ?? 0.5) * riskDist;
        if (adverseDiff > cutoffDist) {
          grossPnlPct = -Number(((adverseDiff / entryPrice) * 100).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'EARLY_ADVERSE';
          currentStatus = 'SL_HIT';
          isTerminated = true;
          break;
        }
      }

      // ── 6. Inactivity Time-Stop (8 candles) ─────────────────────────────
      if (policy.timeStopBars && policy.timeStopBars > 0 && candleCount >= policy.timeStopBars && currentStatus === 'OPEN') {
        const currentGain = k.close - entryPrice;
        if (currentGain < 0.5 * riskDist) {
          const diffPct = (currentGain / entryPrice) * 100;
          grossPnlPct = Number(diffPct.toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'TIME_STOP';
          currentStatus = 'EXPIRED';
          isTerminated = true;
          break;
        }
      }

      // ── 7. Emergency Exit (VWAP + EMA21 breach at candle close) ─────────
      if (policy.emergencyExitFn && policy.emergencyExitFn(k, f, 'BUY')) {
        const tp1P = tp1Hit ? 0.50 * ((tp1 - entryPrice) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * ((tp2 - entryPrice) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = (k.close - entryPrice) / entryPrice * 100;
        grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
        exitIdx = f;
        exitPrice = k.close;
        exitReason = 'EMERGENCY_EXIT';
        currentStatus = 'EXPIRED';
        isTerminated = true;
        break;
      }
    } else {
      // ── SHORT POSITION EXECUTION ─────────────────────────────────────────
      // 1. Stop Loss Check
      if (k.high >= activeSL) {
        exitIdx = f;
        exitPrice = activeSL;
        if (isVCME_Runner) {
          if (tp2Hit) {
            const tp1P = 0.50 * ((entryPrice - tp1) / entryPrice * 100);
            const tp2P = 0.25 * ((entryPrice - tp2) / entryPrice * 100);
            const tp3P = 0.25 * ((entryPrice - activeSL) / entryPrice * 100);
            grossPnlPct = tp1P + tp2P + tp3P;
            realizedR = 0.50 * r1 + 0.25 * r2 + 0.25 * ((entryPrice - activeSL) / riskDist);
            exitReason = 'TP2';
            currentStatus = 'TP2_CLOSED';
          } else if (tp1Hit) {
            const tp1P = 0.50 * ((entryPrice - tp1) / entryPrice * 100);
            grossPnlPct = tp1P;
            realizedR = 0.50 * r1;
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = -(initialRiskPct * 100);
            realizedR = -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else if (isStandardPartials) {
          if (tp1Hit) {
            const tp1P = 0.50 * ((entryPrice - tp1) / entryPrice * 100);
            grossPnlPct = tp1P;
            realizedR = 0.50 * r1;
            exitReason = 'TP1_BE';
            currentStatus = 'TP1_BE_CLOSED';
          } else {
            grossPnlPct = -(initialRiskPct * 100);
            realizedR = -1.0;
            exitReason = 'SL';
            currentStatus = 'SL_HIT';
          }
        } else {
          grossPnlPct = -(initialRiskPct * 100);
          realizedR = -1.0;
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
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // 3. Target 2 (Limit Fill Intra-Candle)
      if (hasPartials && tp1Hit && !tp2Hit && k.low <= tp2) {
        tp2Hit = true;
        if (isVCME_Runner) {
          currentStatus = 'TP2_HIT';
          activeSL = tp1; // Trail SL to TP1
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
          const runnerFloating = ((entryPrice - k.close) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerFloating).toFixed(2));
          const runnerFloatingR = riskDist > 0 ? 0.25 * ((entryPrice - k.close) / riskDist) : 0.25 * r2;
          realizedR = Number((0.50 * r1 + 0.25 * r2 + runnerFloatingR).toFixed(2));
        } else {
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 50;
          grossPnlPct = Number((tp1Gain + tp2Gain).toFixed(2));
          realizedR = Number(((r1 + r2) / 2).toFixed(2));
          exitIdx = f;
          exitPrice = tp2;
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

        if (k.close >= chandelierSL || (!isNaN(ema9Val) && ema9Val > 0 && k.close > ema9Val)) {
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
          const runnerGain = ((entryPrice - k.close) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + runnerGain).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : Number((0.50 * r1 + 0.25 * r2).toFixed(2));
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'TP2';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        } else if (k.low <= tp3) {
          const tp1Gain = ((entryPrice - tp1) / entryPrice) * 50;
          const tp2Gain = ((entryPrice - tp2) / entryPrice) * 25;
          const tp3Gain = ((entryPrice - tp3) / entryPrice) * 25;
          grossPnlPct = Number((tp1Gain + tp2Gain + tp3Gain).toFixed(2));
          realizedR = Number((0.50 * r1 + 0.25 * r2 + 0.25 * 5.0).toFixed(2));
          exitIdx = f;
          exitPrice = tp3;
          exitReason = 'TP3';
          currentStatus = 'TP2_CLOSED';
          isTerminated = true;
          break;
        }
      }

      // 5. Early Adverse Cutoff (Multifractal)
      if (policy.earlyAdverseCutoffBars && candleCount <= policy.earlyAdverseCutoffBars && currentStatus === 'OPEN') {
        const adverseDiff = k.close - entryPrice;
        const cutoffDist = (policy.earlyAdverseCutoffR ?? 0.5) * riskDist;
        if (adverseDiff > cutoffDist) {
          grossPnlPct = -Number(((adverseDiff / entryPrice) * 100).toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'EARLY_ADVERSE';
          currentStatus = 'SL_HIT';
          isTerminated = true;
          break;
        }
      }

      // 6. Inactivity Time-Stop (8 candles)
      if (policy.timeStopBars && policy.timeStopBars > 0 && candleCount >= policy.timeStopBars && currentStatus === 'OPEN') {
        const currentGain = entryPrice - k.close;
        if (currentGain < 0.5 * riskDist) {
          const diffPct = (currentGain / entryPrice) * 100;
          grossPnlPct = Number(diffPct.toFixed(2));
          realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
          exitIdx = f;
          exitPrice = k.close;
          exitReason = 'TIME_STOP';
          currentStatus = 'EXPIRED';
          isTerminated = true;
          break;
        }
      }

      // 7. Emergency Exit (VWAP + EMA21 breach at candle close)
      if (policy.emergencyExitFn && policy.emergencyExitFn(k, f, 'SELL')) {
        const tp1P = tp1Hit ? 0.50 * ((entryPrice - tp1) / entryPrice * 100) : 0;
        const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * ((entryPrice - tp2) / entryPrice * 100) : 0;
        const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
        const openPortionPnl = (entryPrice - k.close) / entryPrice * 100;
        grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
        realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : -0.5;
        exitIdx = f;
        exitPrice = k.close;
        exitReason = 'EMERGENCY_EXIT';
        currentStatus = 'EXPIRED';
        isTerminated = true;
        break;
      }
    }
  }

  // If trade did not terminate on a stop or target within forward window, calculate timeout/floating PnL
  if (!isTerminated) {
    const candlesEvaluated = maxIdx - entryCandleIdx;
    const isExpiredByTime = policy.maxExpiryTimestampMs !== undefined && klines[maxIdx].time * 1000 >= policy.maxExpiryTimestampMs;

    if (candlesEvaluated >= policy.forwardWindow || isExpiredByTime) {
      // Expiration: maximum strategy horizon reached
      const lastK = klines[maxIdx];
      exitIdx = maxIdx;
      exitPrice = policy.floatingClosePrice !== undefined ? policy.floatingClosePrice : lastK.close;
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
      exitPrice = lastK.close;
      exitReason = 'TIMEOUT';
      currentStatus = 'EXPIRED';

      const tp1P = tp1Hit ? 0.50 * (isBuy ? (tp1 - entryPrice) / entryPrice * 100 : (entryPrice - tp1) / entryPrice * 100) : 0;
      const tp2P = (tp2Hit && isVCME_Runner) ? 0.25 * (isBuy ? (tp2 - entryPrice) / entryPrice * 100 : (entryPrice - tp2) / entryPrice * 100) : 0;
      const leftWeight = 1 - (tp1Hit ? 0.50 : 0) - (tp2Hit && isVCME_Runner ? 0.25 : 0);
      const openPortionPnl = isBuy ? (lastK.close - entryPrice) / entryPrice * 100 : (entryPrice - lastK.close) / entryPrice * 100;
      grossPnlPct = Number((tp1P + tp2P + leftWeight * openPortionPnl).toFixed(2));
      realizedR = initialRiskPct > 0 ? Number(((grossPnlPct / 100) / initialRiskPct).toFixed(2)) : 0;
    }
  }

  const netPnlPct = grossPnlPct - frictionPct;

  // Calculate net realized R uniformly from net PnL and initial risk across all exit types
  let netRealizedR: number;
  if (!isTerminated && policy.floatingClosePrice !== undefined) {
    if (currentStatus === 'OPEN') {
      netRealizedR = 0;
    } else {
      const frictionR = initialRiskPct > 0 ? (frictionPct / 100) / initialRiskPct : 0;
      netRealizedR = realizedR - frictionR;
    }
  } else {
    netRealizedR = initialRiskPct > 0 ? (netPnlPct / 100) / initialRiskPct : 0;
  }

  const outcome: 'win' | 'loss' | 'timeout' = exitReason === 'TIMEOUT' || exitReason === 'SESSION_GAP' || exitReason === 'TIME_STOP' || exitReason === 'EMERGENCY_EXIT'
    ? (netPnlPct > 0 ? 'win' : (netPnlPct < 0 ? 'loss' : 'timeout'))
    : (netPnlPct > 0 ? 'win' : 'loss');

  return {
    outcome,
    pnlPct: Number(netPnlPct.toFixed(2)),
    grossPnlPct: Number(grossPnlPct.toFixed(2)),
    realizedR: Number(netRealizedR.toFixed(2)),
    exitIdx,
    exitPrice,
    exitReason,
    status: currentStatus
  };
}
