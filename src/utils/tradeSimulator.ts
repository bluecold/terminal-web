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
  enablePartials?: boolean | 'vcme-runner' | 'two-tier'; // Scaling policy (3-tier for VCME, 2-tier for MFLS)
  moveSlToBreakevenOnTp1?: boolean;                   // Move active SL to entry when TP1 hit
  earlyAdverseCutoffBars?: number;                    // e.g. 3 bars for Multifractal / MFLS
  earlyAdverseCutoffR?: number;                       // e.g. 0.5R adverse threshold
  timeStopBars?: number;                             // e.g. 8 bars (40m) for MFLS, 18 bars (90m) for VCME
  timeStopMinR?: number;                             // Minimum floating R required to avoid time-stop (default 0.5, 0.4 for MFLS)
  trailingStop?: 'chandelier' | 'none';              // Default: chandelier for partials; none disables ATR/EMA9 exit
  emergencyExitFn?: (k: Kline, idx: number, signal: TradeDirection) => boolean;
  sessionGapCutoff?: boolean;                         // Detect session boundary gap (e.g. overnight stock gap)
  stepSec?: number;                                   // Timeframe step in seconds (300 for 5m, 3600 for 1h)
  atrSeries?: number[];                               // Full-length ATR series for trailing Chandelier stop
  ema9Series?: number[];                              // Full-length EMA9 series for runner exit
  frictionPct?: number;                               // Friction/commissions deducted from net return (default: 0.11%)
  frictionModel?: 'proportional' | 'per-fill';        // Friction calculation model (default: 'proportional' for nominal weighting, 'per-fill' for ticket fee parity)
  marketSlippagePct?: number;                         // Adverse slippage on market/stop orders in % (default: 0.03%)
  floatingClosePrice?: number;                        // If provided and trade is still open, compute floating PnL on this price
  maxExpiryTimestampMs?: number;                      // Timestamp in ms beyond which the trade is expired
  isCandleClosed?: (k: Kline) => boolean;            // Identifies whether a candle is finalized closed vs forming live
  executionState?: TradeExecutionState;
  observedAtMs?: number;                             // Live observation time, not candle opening time
  initialState?: {                                   // Legacy migration only; prefer executionState to resume
    tp1Hit?: boolean;
    tp2Hit?: boolean;
    tp1Time?: number;
    tp2Time?: number;
    activeSL?: number;
    currentStatus?: AlertStatus;
  };
}

export type ExitReason = 
  | 'TP1' | 'TP2' | 'TP3' | 'TP1_BE'
  | 'SL' | 'TIME_STOP' | 'EARLY_ADVERSE' | 'EMERGENCY_EXIT' | 'SESSION_GAP' | 'TIMEOUT';

export interface TradeFill {
  kind: 'TP1' | 'TP2' | 'TP3' | 'EXIT';
  quantity: number;                                  // Fraction of ORIGINAL position
  price: number;
  barTime?: number;
  observedAtMs?: number;
  source: 'simulation' | 'legacy';
}

export interface TradeExecutionState {
  version: 1;
  status: AlertStatus;
  remaining: number;
  fills: TradeFill[];
  activeSL: number;
  stopEffectiveTime?: number;
  highestHigh: number;
  lowestLow: number;
  barsSeen: number;
  cursor?: { bar: Kline; closed: boolean };
  lastObservationMs?: number;
  historyQuality: 'complete' | 'legacy';
  exit?: { reason: ExitReason; price: number; barTime?: number };
}

export interface TradeSimulationResult {
  outcome: 'win' | 'loss' | 'timeout';
  pnlPct: number;                        // Net PnL percentage (after friction)
  grossPnlPct: number;                   // Gross PnL percentage (before friction)
  realizedR: number;                     // Net realized R-multiple
  exitIdx: number;                       // Index of the exit candle in klines
  exitPrice: number;                     // Effective execution exit price
  exitReason: ExitReason;
  status: AlertStatus;                   // Current or terminal alert status
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp1Time?: number;
  tp2Time?: number;
  activeSL: number;
  executionState: TradeExecutionState;
}

// Shared compatibility entry point for all backtests and live tracking.
export { runTradeSimulation as simulateTrade } from './executionEngine';
