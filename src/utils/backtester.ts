import type { Kline } from '../services/api';
import {
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateEMA,
  calculateATR,
  calculateStandardVoting,
  type ScoringWeights,
} from './indicators';

// ─── Result Interface ──────────────────────────────────────────────────────

export interface BacktestResult {
  totalSignals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;          // wins / resolved (wins + losses) — trades that reached an outcome
  resolutionRate: number;   // resolved / totalSignals — what % of signals reached target or stop
  profitFactor: number;     // total gains / total losses (>1 = profitable)
  expectancy: number;       // expected % gain per trade
  neutrals: number;         // skipped NEUTRAL candles
  label: string;            // e.g. "últimas 150 velas"
  forwardLabel: string;     // e.g. "ventana 6 velas (30 min)"
  threshold: number;        // stop loss threshold used (adaptive)
  targetThreshold: number;  // take profit threshold (threshold × targetMultiplier)
  targetMultiplier: number; // risk/reward ratio (e.g. 1.5 = 1:1.5 R:R)
  insufficient: boolean;    // true if not enough data
}

// ─── Trend Filter ──────────────────────────────────────────────────────────

export function getTrendFilter(closes: number[]): 'UP' | 'DOWN' | 'NONE' {
  const period = 200;
  if (closes.length < period) return 'NONE';
  const ema = calculateEMA(closes, period);
  const lastEma = ema[ema.length - 1];
  const lastClose = closes[closes.length - 1];
  if (isNaN(lastEma)) return 'NONE';
  return lastClose > lastEma ? 'UP' : 'DOWN';
}

// ─── Timeframe Parameters ──────────────────────────────────────────────────

interface BacktestParams {
  evalWindow: number;
  forwardWindow: number;
  forwardLabel: string;
  fallbackThreshold: number;   // fallback if ATR can't be calculated
  atrMultiplier: number;       // ATR × this = stop threshold
  targetMultiplier: number;    // risk/reward: target = stop × this
}

function getParams(interval: string): BacktestParams {
  switch (interval) {
    case '5m':
      return {
        evalWindow: 150,
        forwardWindow: 6,
        forwardLabel: '6 velas (30 min)',
        fallbackThreshold: 0.010,
        atrMultiplier: 1.5,
        targetMultiplier: 1.5,
      };
    case '1d':
      return {
        evalWindow: 60,
        forwardWindow: 3,
        forwardLabel: '3 velas (3 días)',
        fallbackThreshold: 0.015,
        atrMultiplier: 1.0,
        targetMultiplier: 1.5,
      };
    case '1h':
    default:
      return {
        evalWindow: 100,
        forwardWindow: 4,
        forwardLabel: '4 velas (4 hs)',
        fallbackThreshold: 0.012,
        atrMultiplier: 1.2,
        targetMultiplier: 1.5,
      };
  }
}

// ─── ATR-based Adaptive Threshold ──────────────────────────────────────────
// Computes threshold as a percentage of the close, scaled by ATR.
// This makes the backtest fair for both low-vol stocks (KO) and high-vol crypto (SOL).

function getAdaptiveThreshold(klines: Kline[], atrMultiplier: number, fallback: number): number {
  if (klines.length < 15) return fallback;

  const atr = calculateATR(klines, 14);
  const lastClose = klines[klines.length - 1].close;

  if (atr <= 0 || lastClose <= 0) return fallback;

  const atrPct = atr / lastClose;
  const threshold = atrPct * atrMultiplier;

  // Clamp to sane bounds: 0.2% minimum, 8% maximum
  return Math.max(0.002, Math.min(0.08, threshold));
}

// ─── Session Gap Detection (stocks vs crypto) ──────────────────────────────
// If consecutive klines have gaps significantly larger than expected,
// the asset trades in sessions (stocks). Crypto trades 24/7 with no gaps.

function hasSessionGaps(klines: Kline[], interval: string): boolean {
  if (klines.length < 10) return false;
  const expectedGapSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;

  // Sample last 20 candles for gaps
  for (let i = Math.max(1, klines.length - 20); i < klines.length; i++) {
    const gap = klines[i].time - klines[i - 1].time;
    if (gap > expectedGapSec * 3) return true; // Gap > 3× expected = session break
  }
  return false;
}

// Checks if a given candle is near the end of a trading session.
// We detect this by looking at whether the NEXT candle has a large time gap.
function isNearSessionEnd(klines: Kline[], idx: number, interval: string, forwardWindow: number): boolean {
  // Check if any of the forward candles have a session gap
  for (let f = idx + 1; f <= idx + forwardWindow && f < klines.length; f++) {
    const gap = klines[f].time - klines[f - 1].time;
    const expectedGapSec = interval === '5m' ? 300 : interval === '1h' ? 3600 : 86400;
    if (gap > expectedGapSec * 3) return true;
  }
  return false;
}

// ─── Trade Outcome Evaluation ──────────────────────────────────────────────

interface TradeOutcome {
  result: 'win' | 'loss' | 'timeout';
  pnlPct: number; // percentage P&L of this trade
}

function evaluateOutcome(
  klines: Kline[],
  entryIdx: number,
  signal: 'BUY' | 'SELL',
  forwardWindow: number,
  stopThreshold: number,
  targetThreshold: number
): TradeOutcome {
  const entry = klines[entryIdx].close;

  const target = signal === 'BUY'
    ? entry * (1 + targetThreshold)
    : entry * (1 - targetThreshold);
  const stop = signal === 'BUY'
    ? entry * (1 - stopThreshold)
    : entry * (1 + stopThreshold);

  for (let f = entryIdx + 1; f <= entryIdx + forwardWindow && f < klines.length; f++) {
    const { high, low } = klines[f];

    if (signal === 'BUY') {
      // Check stop first (pessimistic)
      if (low <= stop)    return { result: 'loss', pnlPct: -stopThreshold * 100 };
      if (high >= target) return { result: 'win',  pnlPct: targetThreshold * 100 };
    } else {
      if (high >= stop)  return { result: 'loss', pnlPct: -stopThreshold * 100 };
      if (low <= target) return { result: 'win',  pnlPct: targetThreshold * 100 };
    }
  }

  // Timeout: calculate actual P&L at end of window
  const lastIdx = Math.min(entryIdx + forwardWindow, klines.length - 1);
  const exitPrice = klines[lastIdx].close;
  const rawPnl = signal === 'BUY'
    ? (exitPrice - entry) / entry * 100
    : (entry - exitPrice) / entry * 100;

  return { result: 'timeout', pnlPct: rawPnl };
}

// ─── Standard Voting Signal (unified with SignalPanel) ─────────────────────

function standardVotingSignal(klines: Kline[]): 'BUY' | 'SELL' | 'NEUTRAL' {
  const closes = klines.map(k => k.close);
  if (closes.length < 35) return 'NEUTRAL';

  const { rawSignal } = calculateStandardVoting(klines);

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (rawSignal.includes('BUY'))  signal = 'BUY';
  if (rawSignal.includes('SELL')) signal = 'SELL';

  const trend = getTrendFilter(closes);
  if (trend === 'UP' && signal === 'SELL') return 'NEUTRAL';
  if (trend === 'DOWN' && signal === 'BUY') return 'NEUTRAL';

  return signal;
}

// ─── Generic Backtester Runner ─────────────────────────────────────────────

function runBacktestGeneric(
  klines: Kline[],
  interval: string,
  signalFn: (subset: Kline[]) => 'BUY' | 'SELL' | 'NEUTRAL' | 'HOLD'
): BacktestResult {
  const params = getParams(interval);
  const { evalWindow, forwardWindow, forwardLabel, targetMultiplier } = params;

  // Adaptive threshold based on the asset's actual volatility
  const threshold = getAdaptiveThreshold(klines, params.atrMultiplier, params.fallbackThreshold);
  const targetThreshold = threshold * targetMultiplier;

  // Minimum data
  const minCandles = evalWindow + forwardWindow;
  if (klines.length < minCandles) {
    return {
      totalSignals: 0, wins: 0, losses: 0, timeouts: 0,
      winRate: 0, resolutionRate: 0, profitFactor: 0, expectancy: 0,
      neutrals: 0,
      label: `datos insuficientes (${klines.length} velas)`,
      forwardLabel,
      threshold,
      targetThreshold,
      targetMultiplier,
      insufficient: true,
    };
  }

  // Detect if this asset has session gaps (stocks)
  const isSessionBased = hasSessionGaps(klines, interval);

  const latestEvalIdx = klines.length - 1 - forwardWindow;
  const oldestEvalIdx = Math.max(0, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins         = 0;
  let losses       = 0;
  let timeouts     = 0;
  let neutrals     = 0;
  let totalGainPct = 0;
  let totalLossPct = 0;

  // Cooldown: skip candles within a previous signal's forward window
  let nextAllowedIdx = 0;

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    // Cooldown: skip if still within previous signal's evaluation window
    if (i < nextAllowedIdx) {
      neutrals++;
      continue;
    }

    // Session boundary check: skip signals near end of session for stocks
    if (isSessionBased && (interval === '5m' || interval === '1h')) {
      if (isNearSessionEnd(klines, i, interval, forwardWindow)) {
        neutrals++;
        continue;
      }
    }

    const subset = klines.slice(0, i + 1);
    const raw    = signalFn(subset);
    const signal = (raw === 'HOLD') ? 'NEUTRAL' : raw as 'BUY' | 'SELL' | 'NEUTRAL';

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    totalSignals++;
    const outcome = evaluateOutcome(klines, i, signal, forwardWindow, threshold, targetThreshold);

    if (outcome.result === 'win') {
      wins++;
      totalGainPct += outcome.pnlPct;
    } else if (outcome.result === 'loss') {
      losses++;
      totalLossPct += Math.abs(outcome.pnlPct);
    } else {
      timeouts++;
    }

    // Cooldown: don't evaluate another signal until this one's window expires
    nextAllowedIdx = i + forwardWindow + 1;
  }

  // ── Calculate Metrics ──────────────────────────────────────────────
  const resolved = wins + losses;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const resolutionRate = totalSignals > 0 ? resolved / totalSignals : 0;

  // Profit Factor = gross gains / gross losses
  const profitFactor = totalLossPct > 0 ? totalGainPct / totalLossPct : (totalGainPct > 0 ? Infinity : 0);

  // Expectancy = average P&L per resolved trade (%)
  const avgWinPct = wins > 0 ? totalGainPct / wins : 0;
  const avgLossPct = losses > 0 ? totalLossPct / losses : 0;
  const expectancy = resolved > 0
    ? (winRate * avgWinPct) - ((1 - winRate) * avgLossPct)
    : 0;

  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;

  return {
    totalSignals,
    wins,
    losses,
    timeouts,
    winRate,
    resolutionRate,
    profitFactor: Number(profitFactor === Infinity ? 99.9 : profitFactor.toFixed(2)),
    expectancy: Number(expectancy.toFixed(3)),
    neutrals,
    label: `últimas ${actualWindow} velas`,
    forwardLabel,
    threshold,
    targetThreshold,
    targetMultiplier,
    insufficient: false,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function backtestStandard(klines: Kline[], interval: string): BacktestResult {
  return runBacktestGeneric(klines, interval, (subset) => {
    return standardVotingSignal(subset);
  });
}

export function backtestConfluencia(klines: Kline[], interval: string): BacktestResult {
  return runBacktestGeneric(klines, interval, (subset) => {
    const result = calculateExperimentalSignal(subset, interval);
    return result.signal;
  });
}

export function backtestScoring(klines: Kline[], interval: string, weights?: ScoringWeights): BacktestResult {
  return runBacktestGeneric(klines, interval, (subset) => {
    const result = calculateScoringSignal(subset, interval, weights);
    return result.signal;
  });
}
