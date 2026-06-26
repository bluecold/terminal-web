import type { Kline } from '../services/api';
import {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateEMA,
  type ScoringWeights,
} from './indicators';

export interface BacktestResult {
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;       // 0 to 1
  neutrals: number;      // skipped NEUTRAL candles
  label: string;         // e.g. "últimas 150 velas"
  forwardLabel: string;  // e.g. "ventana 6 velas (30 min)"
  threshold: number;     // e.g. 0.012 for 1.2%
  insufficient: boolean; // true if not enough data
}

export function getTrendFilter(closes: number[]): 'UP' | 'DOWN' | 'NONE' {
  const period = 200;
  if (closes.length < period) return 'NONE';
  const ema = calculateEMA(closes, period);
  const lastEma = ema[ema.length - 1];
  const lastClose = closes[closes.length - 1];
  if (isNaN(lastEma)) return 'NONE';
  return lastClose > lastEma ? 'UP' : 'DOWN';
}

// Parameters adapted to each timeframe
interface BacktestParams {
  evalWindow: number;    // how many past candles to evaluate
  forwardWindow: number; // how many future candles to validate the signal
  forwardLabel: string;
  threshold: number;     // success/stop threshold (adaptive per timeframe)
}

function getParams(interval: string): BacktestParams {
  switch (interval) {
    case '5m':
      return { evalWindow: 150, forwardWindow: 6,  forwardLabel: '6 velas (30 min)', threshold: 0.010 }; // 1.0%
    case '1d':
      return { evalWindow: 60,  forwardWindow: 3,  forwardLabel: '3 velas (3 días)',  threshold: 0.015 }; // 1.5%
    case '1h':
    default:
      return { evalWindow: 100, forwardWindow: 4,  forwardLabel: '4 velas (4 hs)',    threshold: 0.012 }; // 1.2%
  }
}

// Thresholds are now adaptive per timeframe — passed in from getParams()

/**
 * Checks whether a signal (BUY or SELL) would have succeeded in the
 * `forwardWindow` candles following the entry candle at index `entryIdx`.
 *
 * Success: price moves SUCCESS_THRESHOLD in signal direction BEFORE
 *          touching STOP_THRESHOLD in the opposite direction.
 * Result: 'win' | 'loss' | 'timeout' (neither reached within window)
 */
function evaluateOutcome(
  klines: Kline[],
  entryIdx: number,
  signal: 'BUY' | 'SELL',
  forwardWindow: number,
  threshold: number
): 'win' | 'loss' | 'timeout' {
  const entry = klines[entryIdx].close;
  const target = signal === 'BUY'
    ? entry * (1 + threshold)
    : entry * (1 - threshold);
  const stop = signal === 'BUY'
    ? entry * (1 - threshold)
    : entry * (1 + threshold);

  for (let f = entryIdx + 1; f <= entryIdx + forwardWindow && f < klines.length; f++) {
    const { high, low } = klines[f];

    if (signal === 'BUY') {
      // Check stop first (pessimistic — wicks are checked intra-candle)
      if (low <= stop)    return 'loss';
      if (high >= target) return 'win';
    } else {
      if (high >= stop)  return 'loss';
      if (low <= target) return 'win';
    }
  }
  // Neither target nor stop was hit within the window
  return 'timeout';
}

// ─── Standard Voting Signal ────────────────────────────────────────────────
// Replicates the vote logic from SignalPanel: RSI + MACD + BB + Volume
function standardVotingSignal(closes: number[]): 'BUY' | 'SELL' | 'NEUTRAL' {
  if (closes.length < 35) return 'NEUTRAL'; // MACD needs 35 candles now

  const rsi  = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const bb   = calculateBollingerBands(closes);

  const votes: Array<'BUY' | 'SELL' | 'NEUTRAL'> = [rsi.signal, macd.signal, bb.signal];

  let buy = 0, sell = 0;
  votes.forEach(v => { if (v === 'BUY') buy++; if (v === 'SELL') sell++; });

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (buy >= 2 && sell === 0) signal = 'BUY';
  else if (buy > sell)             signal = 'BUY';
  else if (sell >= 2 && buy === 0) signal = 'SELL';
  else if (sell > buy)             signal = 'SELL';

  // Apply EMA 200 trend filter
  const trend = getTrendFilter(closes);
  if (trend === 'UP' && signal === 'SELL') return 'NEUTRAL';
  if (trend === 'DOWN' && signal === 'BUY') return 'NEUTRAL';

  return signal;
}

// ─── Generic runner ────────────────────────────────────────────────────────
function runBacktestGeneric(
  klines: Kline[],
  interval: string,
  signalFn: (subset: Kline[]) => 'BUY' | 'SELL' | 'NEUTRAL' | 'HOLD'
): BacktestResult {
  const { evalWindow, forwardWindow, forwardLabel, threshold } = getParams(interval);

  // Minimum data needed: evalWindow history + forwardWindow future
  const minCandles = evalWindow + forwardWindow;
  if (klines.length < minCandles) {
    return {
      totalSignals: 0, wins: 0, losses: 0, winRate: 0, neutrals: 0,
      label: `datos insuficientes (${klines.length} velas)`,
      forwardLabel,
      threshold,
      insufficient: true,
    };
  }

  // We evaluate from the oldest point that leaves forwardWindow room
  // The "latest" evaluation point = klines.length - 1 - forwardWindow
  // The "oldest"  evaluation point = latest - evalWindow + 1
  const latestEvalIdx  = klines.length - 1 - forwardWindow;
  const oldestEvalIdx  = Math.max(0, latestEvalIdx - evalWindow + 1);

  let totalSignals = 0;
  let wins         = 0;
  let losses       = 0;
  let neutrals     = 0;

  for (let i = oldestEvalIdx; i <= latestEvalIdx; i++) {
    // Feed ONLY data up to (and including) candle i — no lookahead
    const subset = klines.slice(0, i + 1);
    const raw    = signalFn(subset);
    const signal = (raw === 'HOLD') ? 'NEUTRAL' : raw as 'BUY' | 'SELL' | 'NEUTRAL';

    if (signal === 'NEUTRAL') {
      neutrals++;
      continue;
    }

    totalSignals++;
    const outcome = evaluateOutcome(klines, i, signal, forwardWindow, threshold);
    if (outcome === 'win')  wins++;
    if (outcome === 'loss') losses++;
    // 'timeout' counts neither as win nor loss — signal didn't reach threshold
  }

  const winRate = totalSignals > 0 ? wins / totalSignals : 0;
  const actualWindow = latestEvalIdx - oldestEvalIdx + 1;

  return {
    totalSignals,
    wins,
    losses,
    winRate,
    neutrals,
    label: `últimas ${actualWindow} velas`,
    forwardLabel,
    threshold,
    insufficient: false,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function backtestStandard(klines: Kline[], interval: string): BacktestResult {
  return runBacktestGeneric(klines, interval, (subset) => {
    const closes = subset.map(k => k.close);
    return standardVotingSignal(closes);
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
