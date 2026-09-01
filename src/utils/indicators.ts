import type { Kline } from '../services/api';
import {
  buildConfluenciaContext,
  evaluateConfluenciaAt,
  buildScoringContext,
  evaluateScoringAt,
  buildStandardVotingContext,
  evaluateStandardVotingAt,
  buildVCMESniperContext,
  evaluateVCMESniperAt,
  buildMultifractalMTFContext,
  evaluateMultifractalMTFAt,
  type ConfluenciaContext,
  type ConfluenciaEvaluationResult,
  type ScoringContext,
  type StandardVotingContext,
  type VCMESniperContext,
  type VCMESniperEvaluationResult,
  type MultifractalMTFContext,
  type MultifractalMTFEvaluationResult
} from './strategyEvaluators';

export {
  buildConfluenciaContext,
  evaluateConfluenciaAt,
  buildScoringContext,
  evaluateScoringAt,
  buildStandardVotingContext,
  evaluateStandardVotingAt,
  buildVCMESniperContext,
  evaluateVCMESniperAt,
  buildMultifractalMTFContext,
  evaluateMultifractalMTFAt,
  type ConfluenciaContext,
  type ConfluenciaEvaluationResult,
  type ScoringContext,
  type StandardVotingContext,
  type VCMESniperContext,
  type VCMESniperEvaluationResult,
  type MultifractalMTFContext,
  type MultifractalMTFEvaluationResult
};

export interface IndicatorResult {
  value: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
}

export function calculateSMA(data: number[], period: number): number[] {
  const sma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sma.push(NaN);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      sma.push(sum / period);
    }
  }
  return sma;
}

export function calculateEMA(data: number[], period: number): number[] {
  if (!data || data.length < period) {
    return new Array(data ? data.length : 0).fill(NaN);
  }
  const ema = [];
  const multiplier = 2 / (period + 1);
  let prevEma = data.slice(0, period).reduce((a, b) => a + b, 0) / period; // Start with SMA

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      ema.push(NaN);
    } else if (i === period - 1) {
      ema.push(prevEma);
    } else {
      const currentEma = (data[i] - prevEma) * multiplier + prevEma;
      ema.push(currentEma);
      prevEma = currentEma;
    }
  }
  return ema;
}

export function calculateRSI(data: number[], period: number = 14): IndicatorResult {
  if (!data || data.length < period + 1) return { value: 50, signal: 'NEUTRAL' };

  let avgGain = 0;
  let avgLoss = 0;

  // First RMA value is the SMA of the first 'period' changes
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) {
      avgGain += diff;
    } else {
      avgLoss -= diff;
    }
  }

  avgGain /= period;
  avgLoss /= period;

  // Subsequent values use Wilder's smoothing (RMA)
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  let rsi = 50;
  if (avgLoss === 0) {
    rsi = avgGain === 0 ? 50 : 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
  }

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (rsi < 30) signal = 'BUY'; // Oversold
  if (rsi > 70) signal = 'SELL'; // Overbought

  return { value: Number(rsi.toFixed(2)), signal };
}

export function calculateMACD(data: number[]): IndicatorResult {
  if (!data || data.length < 35) return { value: 0, signal: 'NEUTRAL' }; // Increased minimum data requirements for EMA + EMA smoothing

  const ema12 = calculateEMA(data, 12);
  const ema26 = calculateEMA(data, 26);
  
  const macdLine = [];
  for (let i = 0; i < data.length; i++) {
    if (isNaN(ema12[i]) || isNaN(ema26[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(ema12[i] - ema26[i]);
    }
  }

  const validMacd = macdLine.filter(val => !isNaN(val));
  if (validMacd.length === 0) return { value: 0, signal: 'NEUTRAL' };

  const signalLine = calculateEMA(validMacd, 9);
  
  const currentMacd = validMacd[validMacd.length - 1];
  
  if (currentMacd === undefined || isNaN(currentMacd)) return { value: 0, signal: 'NEUTRAL' };

  // Calculate histogram — signalLine has same length as validMacd
  // (first 8 entries are NaN from the EMA seed period)
  const histogramSeries: number[] = [];
  for (let i = 0; i < validMacd.length; i++) {
    const macdVal = validMacd[i];
    const sigVal = signalLine[i];
    if (!isNaN(macdVal) && !isNaN(sigVal)) {
      histogramSeries.push(macdVal - sigVal);
    } else {
      histogramSeries.push(NaN);
    }
  }

  // Look back up to 3 candles (current, prev, prev-prev) for a crossover
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  const len = histogramSeries.length;
  if (len >= 4) {
    for (let offset = 0; offset < 3; offset++) {
      const idxCurr = len - 1 - offset;
      const idxPrev = idxCurr - 1;
      
      const histCurr = histogramSeries[idxCurr];
      const histPrev = histogramSeries[idxPrev];
      
      // Bullish Crossover: crossed from negative/zero to positive
      if (histPrev <= 0 && histCurr > 0) {
        signal = 'BUY';
        break; // Stop at most recent crossover
      }
      // Bearish Crossover: crossed from positive/zero to negative
      if (histPrev >= 0 && histCurr < 0) {
        signal = 'SELL';
        break;
      }
    }

    // Histogram acceleration filter: degrade signal if momentum is fading
    if (signal !== 'NEUTRAL' && len >= 3) {
      const latestHist = histogramSeries[len - 1];
      const prevHist = histogramSeries[len - 2];
      if (!isNaN(latestHist) && !isNaN(prevHist)) {
        if (signal === 'BUY' && latestHist > 0 && latestHist < prevHist) {
          signal = 'NEUTRAL'; // Bullish momentum decelerating
        } else if (signal === 'SELL' && latestHist < 0 && latestHist > prevHist) {
          signal = 'NEUTRAL'; // Bearish momentum decelerating
        }
      }
    }
  }

  return { value: Number(currentMacd.toFixed(2)), signal };
}

export function calculateBollingerBands(data: number[], period: number = 20, multiplier: number = 2): { upper: number, lower: number, current: number, signal: 'BUY' | 'SELL' | 'NEUTRAL' } {
  if (!data || data.length < period) return { upper: 0, lower: 0, current: 0, signal: 'NEUTRAL' };
  
  const sma = calculateSMA(data, period);
  const currentSma = sma[sma.length - 1];
  const currentPrice = data[data.length - 1];

  // Calculate standard deviation
  let sumSquaredDiffs = 0;
  for (let i = data.length - period; i < data.length; i++) {
    sumSquaredDiffs += Math.pow(data[i] - currentSma, 2);
  }
  const stdDev = Math.sqrt(sumSquaredDiffs / period);

  const upper = currentSma + (stdDev * multiplier);
  const lower = currentSma - (stdDev * multiplier);

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (currentPrice < lower) signal = 'BUY'; // Price bounced off or crossed lower band
  if (currentPrice > upper) signal = 'SELL'; // Price crossed upper band

  return { upper, lower, current: currentPrice, signal };
}

export interface BollingerBandsSeriesResult {
  time: number;
  upper: number;
  middle: number;
  lower: number;
  widthPercent: number;
}

export function calculateBollingerBandsSeries(klines: Kline[], period: number = 20, multiplier: number = 2): BollingerBandsSeriesResult[] {
  if (!klines || klines.length < period) return [];

  const results: BollingerBandsSeriesResult[] = [];
  const closes = klines.map(k => k.close);
  
  // Calculate SMA for the entire series
  const sma = calculateSMA(closes, period);

  for (let i = 0; i < klines.length; i++) {
    if (i < period - 1) {
      continue;
    }

    const currentSma = sma[i];
    if (isNaN(currentSma)) continue;

    // Calculate standard deviation for window [i - period + 1 ... i]
    let sumSquaredDiffs = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSquaredDiffs += Math.pow(closes[j] - currentSma, 2);
    }
    const stdDev = Math.sqrt(sumSquaredDiffs / period);

    const upper = currentSma + (stdDev * multiplier);
    const lower = currentSma - (stdDev * multiplier);
    const widthPercent = currentSma !== 0 ? ((upper - lower) / currentSma) * 100 : 0;

    results.push({
      time: klines[i].time,
      upper,
      middle: currentSma,
      lower,
      widthPercent
    });
  }

  return results;
}

export interface BollingerVolatilityStatusResult {
  status: 'SQUEEZE' | 'EXPANSION' | 'NORMAL';
  percentile: number;
  widthPercent: number;
}

export function calculateBollingerVolatilityStatus(
  bbSeries: BollingerBandsSeriesResult[],
  lookback: number = 50
): BollingerVolatilityStatusResult {
  if (!bbSeries || bbSeries.length <= 1) {
    return { status: 'NORMAL', percentile: 50, widthPercent: bbSeries?.[0]?.widthPercent || 0 };
  }
  const currentWidth = bbSeries[bbSeries.length - 1].widthPercent;

  // 1. Strictly historical baseline excluding current bar to prevent self-inclusion damping
  const historicalSeries = bbSeries.slice(0, -1).slice(-lookback);
  const sampleSize = historicalSeries.length;
  if (sampleSize < 10) {
    return { status: 'NORMAL', percentile: 50, widthPercent: currentWidth };
  }

  // 2. Symmetric empirical percentile rank within historical window [0.0% - 100.0%]
  const lowerCount = historicalSeries.filter(b => b.widthPercent < currentWidth).length;
  const percentile = Number(((lowerCount / sampleSize) * 100).toFixed(1));

  let status: 'SQUEEZE' | 'EXPANSION' | 'NORMAL' = 'NORMAL';
  if (percentile <= 15) {
    status = 'SQUEEZE';
  } else if (percentile >= 85) {
    status = 'EXPANSION';
  }

  return { status, percentile, widthPercent: currentWidth };
}

// ==========================================
// EXPERIMENTAL CUSTOM ALGO
// ==========================================

export function calculateATR(klines: Kline[], period: number = 14): number {
  if (klines.length < period + 1) return 0;
  
  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }
  
  // Wilder's Smoothing (RMA)
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period; 
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

export function isHammer(kline: Kline): boolean {
  const bodySize = Math.abs(kline.close - kline.open);
  const upperWick = kline.high - Math.max(kline.close, kline.open);
  const lowerWick = Math.min(kline.close, kline.open) - kline.low;
  
  return lowerWick > bodySize * 2 && upperWick < bodySize * 0.2;
}

export function isShootingStar(kline: Kline): boolean {
  const bodySize = Math.abs(kline.close - kline.open);
  const upperWick = kline.high - Math.max(kline.close, kline.open);
  const lowerWick = Math.min(kline.close, kline.open) - kline.low;
  
  return upperWick > bodySize * 2 && lowerWick < bodySize * 0.2;
}

export function isEngulfing(curr: Kline, prev: Kline): number {
  const prevIsBullish = prev.close > prev.open;
  const currIsBullish = curr.close > curr.open;
  
  // Bullish engulfing
  if (!prevIsBullish && currIsBullish && curr.close > prev.open && curr.open < prev.close) {
    return 1;
  }
  
  // Bearish engulfing
  if (prevIsBullish && !currIsBullish && curr.close < prev.open && curr.open > prev.close) {
    return -1;
  }
  
  return 0;
}

export interface EmaCrossover {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  barsAgo: number; // cuántas velas atrás ocurrió el cruce
}

export function detectEmaCrossoverFromSeries(
  emaFast: number[],
  emaSlow: number[],
  idx: number,
  lookback = 5
): EmaCrossover {
  if (!emaFast || !emaSlow || idx < 1) return { type: 'NONE', barsAgo: 0 };

  for (let k = 0; k < lookback; k++) {
    const currIdx = idx - k;
    const prevIdx = currIdx - 1;
    if (prevIdx < 0) break;

    const fastNow = emaFast[currIdx];
    const slowNow = emaSlow[currIdx];
    const fastPrev = emaFast[prevIdx];
    const slowPrev = emaSlow[prevIdx];

    if (isNaN(fastNow) || isNaN(slowNow) || isNaN(fastPrev) || isNaN(slowPrev)) continue;

    // Cruce alcista: fast cruzó de abajo hacia arriba
    if (fastPrev < slowPrev && fastNow > slowNow) {
      return { type: 'BULLISH', barsAgo: k };
    }
    // Cruce bajista: fast cruzó de arriba hacia abajo
    if (fastPrev > slowPrev && fastNow < slowNow) {
      return { type: 'BEARISH', barsAgo: k };
    }
  }

  return { type: 'NONE', barsAgo: 0 };
}

export function calculateVWAP(klines: Kline[], interval: string = '1h', symbol?: string): number {
  if (!klines || klines.length === 0) return 0;

  let cumVol = 0;
  let cumVolPrice = 0;
  let prevSessionId = '';

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const sessionId = getSessionId(klines[i], interval, symbol);

    if (sessionId !== prevSessionId && prevSessionId !== '') {
      cumVol = 0;
      cumVolPrice = 0;
    }
    prevSessionId = sessionId;

    const v = k.volume;
    const p = (k.high + k.low + k.close) / 3;
    cumVol += v;
    cumVolPrice += p * v;
  }

  return cumVol > 0 ? cumVolPrice / cumVol : klines[klines.length - 1].close;
}

export function closePosition(c: Kline): number {
  if (!c || c.high === c.low) return 0.5;
  return (c.close - c.low) / (c.high - c.low);
}

export function upperWickRatio(c: Kline): number {
  if (!c || c.high === c.low) return 0;
  return (c.high - Math.max(c.open, c.close)) / (c.high - c.low);
}

export function lowerWickRatio(c: Kline): number {
  if (!c || c.high === c.low) return 0;
  return (Math.min(c.open, c.close) - c.low) / (c.high - c.low);
}

export function calculateExperimentalSignal(klines: Kline[], interval: string = '1h'): ConfluenciaEvaluationResult {
  const ctx = buildConfluenciaContext(klines, interval);
  return evaluateConfluenciaAt(ctx, klines ? klines.length - 1 : 0);
}

// ==========================================
// EXPERIMENTAL SIGNAL 2: SCORING MULTICAPA
// Port of analizar_señal() Python → TypeScript
// ==========================================

export interface ScoringConfig {
  emaFast: number;
  emaSlow: number;
  emaMajor: number | null;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  bbPeriod: number;
  useVwap: boolean;
  useObv: boolean;
}

export const SCORING_CONFIG: Record<string, ScoringConfig> = {
  '5m': { emaFast: 9, emaSlow: 21, emaMajor: null,  rsiPeriod: 7,  rsiOversold: 35, rsiOverbought: 65, bbPeriod: 20, useVwap: true,  useObv: false },
  '1h': { emaFast: 9, emaSlow: 21, emaMajor: 50,    rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65, bbPeriod: 20, useVwap: true,  useObv: false },
  '1d': { emaFast: 9, emaSlow: 21, emaMajor: 50,    rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, bbPeriod: 20, useVwap: false, useObv: true  },
};

export interface ScoringWeights {
  trend: number;
  rsi: number;
  bollinger: number;
  volume: number;
  candle: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  trend: 1.5,
  rsi: 1.0,
  bollinger: 1.0,
  volume: 1.5,
  candle: 1.0,
};

export interface LayerScore { score: number; weightedScore: number; note: string; }

export interface ScoringResult {
  signal: 'BUY' | 'SELL' | 'HOLD';
  score: number;
  threshold: number;
  layers: {
    trend:    LayerScore;
    rsi:      LayerScore;
    bollinger:LayerScore;
    volume:   LayerScore;
    candle:   LayerScore;
    structure: LayerScore;
  };
}

export function calculateOBV(klines: Kline[]): number[] {
  const obv: number[] = [0];
  for (let i = 1; i < klines.length; i++) {
    if (klines[i].close > klines[i - 1].close)      obv.push(obv[i - 1] + klines[i].volume);
    else if (klines[i].close < klines[i - 1].close) obv.push(obv[i - 1] - klines[i].volume);
    else                                              obv.push(obv[i - 1]);
  }
  return obv;
}

export function calculateScoringSignal(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoringResult {
  const ctx = buildScoringContext(klines, interval, weights);
  return evaluateScoringAt(ctx, klines ? klines.length - 1 : 0);
}

export function calculateRSISeries(data: number[], period: number = 14): number[] {
  const rsiSeries: number[] = new Array(data.length).fill(NaN);
  if (!data || data.length < period + 1) return rsiSeries;

  let avgGain = 0;
  let avgLoss = 0;

  // First RMA value
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) {
      avgGain += diff;
    } else {
      avgLoss -= diff;
    }
  }

  avgGain /= period;
  avgLoss /= period;
  rsiSeries[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  // Subsequent RMA values
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    if (avgLoss === 0) {
      rsiSeries[i] = avgGain === 0 ? 50 : 100;
    } else {
      const rs = avgGain / avgLoss;
      rsiSeries[i] = 100 - (100 / (1 + rs));
    }
  }

  return rsiSeries;
}

export interface SupertrendResult {
  value: number;
  direction: 'UP' | 'DOWN';
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
}

export interface SupertrendSeriesItem {
  time: number;
  value: number;
  direction: 'UP' | 'DOWN';
}

export function calculateSupertrendSeries(klines: Kline[], period: number = 10, multiplier: number = 3): SupertrendSeriesItem[] {
  const length = klines.length;
  if (!klines || length === 0) return [];
  if (length < period + 1) {
    return klines.map(k => ({ time: k.time, value: k.close, direction: 'UP' }));
  }

  // 1. Calculate TR (True Range)
  const tr: number[] = [0];
  tr[0] = klines[0].high - klines[0].low;
  for (let i = 1; i < length; i++) {
    const hl = klines[i].high - klines[i].low;
    const hpc = Math.abs(klines[i].high - klines[i - 1].close);
    const lpc = Math.abs(klines[i].low - klines[i - 1].close);
    tr.push(Math.max(hl, hpc, lpc));
  }

  // 2. Calculate ATR Series
  const atr: number[] = new Array(length).fill(0);
  let sumTr = 0;
  for (let i = 0; i < period; i++) {
    sumTr += tr[i];
  }
  atr[period - 1] = sumTr / period;
  for (let i = period; i < length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  // 3. Calculate Supertrend
  const upperBand: number[] = new Array(length).fill(0);
  const lowerBand: number[] = new Array(length).fill(0);
  const finalUpperBand: number[] = new Array(length).fill(0);
  const finalLowerBand: number[] = new Array(length).fill(0);
  const superTrend: number[] = new Array(length).fill(0);
  const direction: number[] = new Array(length).fill(1); // 1 = UP, -1 = DOWN

  for (let i = 0; i < length; i++) {
    const hl2 = (klines[i].high + klines[i].low) / 2;
    upperBand[i] = hl2 + multiplier * atr[i];
    lowerBand[i] = hl2 - multiplier * atr[i];
  }

  // Initialize first valid index
  const startIdx = period - 1;
  finalUpperBand[startIdx] = upperBand[startIdx];
  finalLowerBand[startIdx] = lowerBand[startIdx];
  superTrend[startIdx] = lowerBand[startIdx];
  direction[startIdx] = 1;

  for (let i = startIdx + 1; i < length; i++) {
    // Final Upper Band
    if (upperBand[i] < finalUpperBand[i - 1] || klines[i - 1].close > finalUpperBand[i - 1]) {
      finalUpperBand[i] = upperBand[i];
    } else {
      finalUpperBand[i] = finalUpperBand[i - 1];
    }

    // Final Lower Band
    if (lowerBand[i] > finalLowerBand[i - 1] || klines[i - 1].close < finalLowerBand[i - 1]) {
      finalLowerBand[i] = lowerBand[i];
    } else {
      finalLowerBand[i] = finalLowerBand[i - 1];
    }

    // Supertrend & Direction
    if (klines[i].close > finalUpperBand[i - 1]) {
      direction[i] = 1;
    } else if (klines[i].close < finalLowerBand[i - 1]) {
      direction[i] = -1;
    } else {
      direction[i] = direction[i - 1];
    }

    if (direction[i] === 1) {
      superTrend[i] = finalLowerBand[i];
    } else {
      superTrend[i] = finalUpperBand[i];
    }
  }

  return klines.map((k, i) => {
    if (i < startIdx) {
      return { time: k.time, value: k.close, direction: 'UP' };
    }
    return {
      time: k.time,
      value: superTrend[i],
      direction: direction[i] === 1 ? 'UP' : 'DOWN'
    };
  });
}

export function calculateSupertrend(klines: Kline[], period: number = 10, multiplier: number = 3): SupertrendResult {
  if (!klines || klines.length < period + 1) {
    return { value: 0, direction: 'UP', signal: 'NEUTRAL' };
  }

  const series = calculateSupertrendSeries(klines, period, multiplier);
  const length = series.length;
  const latest = series[length - 1];

  const startIdx = period - 1;
  const flipLookback = 3;
  let recentFlip = false;
  for (let i = 1; i <= flipLookback && (length - i) > startIdx; i++) {
    if (series[length - i].direction !== series[length - i - 1].direction) {
      recentFlip = true;
      break;
    }
  }

  const signal: 'BUY' | 'SELL' | 'NEUTRAL' = recentFlip
    ? (latest.direction === 'UP' ? 'BUY' : 'SELL')
    : 'NEUTRAL';

  return {
    value: latest.value,
    direction: latest.direction,
    signal
  };
}

export interface MultitemporalSignalResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  stopLoss: number;
  takeProfit: number;
  rsi: number;
  rsiSlope: number;
  supertrendVal: number;
  supertrendDir: 'UP' | 'DOWN';
  vwap: number;
  ema200_1h: number;
  isTrendUp: boolean;
  nearestSupport: number;
  nearestResistance: number;
}

export function calculateMultitemporalSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  symbol?: string
): MultitemporalSignalResult {
  const fallback: MultitemporalSignalResult = {
    signal: 'NEUTRAL',
    stopLoss: 0,
    takeProfit: 0,
    rsi: 50,
    rsiSlope: 0,
    supertrendVal: 0,
    supertrendDir: 'UP',
    vwap: 0,
    ema200_1h: 0,
    isTrendUp: false,
    nearestSupport: 0,
    nearestResistance: 0
  };

  if (!klines5m || klines5m.length < 15) return fallback;
  if (!klines1h || klines1h.length < 200) {
    return fallback;
  }

  const curr5m = klines5m[klines5m.length - 1];

  // 1. Calculate 1H Trend (EMA 200 of 1H)
  const closes1h = klines1h.map(k => k.close);
  const ema200_1h_series = calculateEMA(closes1h, 200);
  let macroEma200 = NaN;
  let lastClosed1hClose = NaN;

  // Find the latest 1H candle that was closed before (or at) the current 5m candle
  for (let i = klines1h.length - 1; i >= 0; i--) {
    const endTime = klines1h[i].time + 3600;
    if (endTime <= curr5m.time) {
      macroEma200 = ema200_1h_series[i];
      lastClosed1hClose = klines1h[i].close;
      break;
    }
  }

  if (isNaN(macroEma200) || isNaN(lastClosed1hClose)) {
    return fallback;
  }

  const isTrendUp = lastClosed1hClose > macroEma200;
  const isTrendDown = lastClosed1hClose < macroEma200;

  // 2. Calculate 5m Indicators
  const closes5m = klines5m.map(k => k.close);
  const rsiSeriesFull = calculateRSISeries(closes5m, 14);
  const rsi = rsiSeriesFull[rsiSeriesFull.length - 1];
  const rsiSlopeVal = calculateRSISlope(rsiSeriesFull, rsiSeriesFull.length - 1, 3);

  const vwap = calculateVWAP(klines5m, '5m', symbol);

  const stSeries = calculateSupertrendSeries(klines5m, 10, 3);
  if (stSeries.length < 2) return fallback;
  
  const latestSt = stSeries[stSeries.length - 1];
  const prevSt = stSeries[stSeries.length - 2];

  const isSupertrendFlipGreen = latestSt.direction === 'UP' && prevSt.direction === 'DOWN';
  const isSupertrendFlipRed = latestSt.direction === 'DOWN' && prevSt.direction === 'UP';

  // 3. Support / Resistance (100-candle rolling window)
  const srWindow = klines5m.slice(Math.max(0, klines5m.length - 100));
  const sr = calculateSupportResistance(srWindow, curr5m.close);

  // 4. Evaluate Signals (RSI slope: don't buy into falling momentum, don't sell into rising)
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let stopLoss = 0;
  let takeProfit = 0;

  if (isTrendUp && isSupertrendFlipGreen && curr5m.close > vwap && rsi >= 40 && rsi <= 70 && rsiSlopeVal >= 0) {
    signal = 'BUY';
    stopLoss = Math.max(latestSt.value, vwap);
    takeProfit = curr5m.close + 1.5 * (curr5m.close - stopLoss);
  } else if (isTrendDown && isSupertrendFlipRed && curr5m.close < vwap && rsi >= 30 && rsi <= 60 && rsiSlopeVal <= 0) {
    signal = 'SELL';
    stopLoss = Math.min(latestSt.value, vwap);
    takeProfit = curr5m.close - 1.5 * (stopLoss - curr5m.close);
  }

  // 5. R:R validation against nearest S/R
  if (signal === 'BUY' && sr.nearestResistance > 0 && stopLoss > 0) {
    const riskDist = curr5m.close - stopLoss;
    const rewardRoom = sr.nearestResistance - curr5m.close;
    if (riskDist > 0 && rewardRoom > 0 && rewardRoom < riskDist * 1.5) {
      signal = 'NEUTRAL'; // R:R insufficient
    }
  } else if (signal === 'SELL' && sr.nearestSupport > 0 && stopLoss > 0) {
    const riskDist = stopLoss - curr5m.close;
    const rewardRoom = curr5m.close - sr.nearestSupport;
    if (riskDist > 0 && rewardRoom > 0 && rewardRoom < riskDist * 1.5) {
      signal = 'NEUTRAL'; // R:R insufficient
    }
  }

  return {
    signal,
    stopLoss,
    takeProfit,
    rsi: isNaN(rsi) ? 50 : rsi,
    rsiSlope: rsiSlopeVal,
    supertrendVal: latestSt.value,
    supertrendDir: latestSt.direction,
    vwap,
    ema200_1h: macroEma200,
    isTrendUp,
    nearestSupport: sr.nearestSupport,
    nearestResistance: sr.nearestResistance,
  };
}

export interface StochRSIResult {
  k: number;
  d: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
}

export function calculateStochRSI(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3
): StochRSIResult {
  const defaultResult: StochRSIResult = { k: 50, d: 50, signal: 'NEUTRAL' };
  const minRequired = rsiPeriod + stochPeriod + Math.max(kPeriod, dPeriod);
  if (!closes || closes.length < minRequired) return defaultResult;

  // 1. Calculate RSI Series
  const rsiSeries = calculateRSISeries(closes, rsiPeriod);

  // 2. Calculate Raw StochRSI
  const stochRsiRaw: number[] = new Array(closes.length).fill(NaN);
  for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length < stochPeriod) continue;
    
    const minRsi = Math.min(...validWindow);
    const maxRsi = Math.max(...validWindow);
    const currentRsi = rsiSeries[i];
    
    if (maxRsi === minRsi) {
      stochRsiRaw[i] = 50;
    } else {
      stochRsiRaw[i] = ((currentRsi - minRsi) / (maxRsi - minRsi)) * 100;
    }
  }

  // 3. Calculate %K (SMA of stochRsiRaw)
  const kSeries: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) continue;
    const window = stochRsiRaw.slice(i - kPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length === kPeriod) {
      kSeries[i] = validWindow.reduce((a, b) => a + b, 0) / kPeriod;
    }
  }

  // 4. Calculate %D (SMA of %K)
  const dSeries: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (i < dPeriod - 1) continue;
    const window = kSeries.slice(i - dPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length === dPeriod) {
      dSeries[i] = validWindow.reduce((a, b) => a + b, 0) / dPeriod;
    }
  }

  const latestK = kSeries[kSeries.length - 1];
  const latestD = dSeries[dSeries.length - 1];

  if (isNaN(latestK) || isNaN(latestD)) return defaultResult;

  // Signal:
  // BUY: oversold (< 20) and %K crosses above %D in the last 2 candles
  // SELL: overbought (> 80) and %K crosses below %D in the last 2 candles
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  const len = kSeries.length;
  
  if (len >= 2) {
    const prevK = kSeries[len - 2];
    const prevD = dSeries[len - 2];
    const currK = kSeries[len - 1];
    const currD = dSeries[len - 1];

    if (!isNaN(prevK) && !isNaN(prevD)) {
      if ((prevK < 20 || currK < 25) && prevK <= prevD && currK > currD) {
        signal = 'BUY';
      } else if ((prevK > 80 || currK > 75) && prevK >= prevD && currK < currD) {
        signal = 'SELL';
      }
    }
  }

  return {
    k: Number(latestK.toFixed(2)),
    d: Number(latestD.toFixed(2)),
    signal
  };
}

// ==========================================
// VOLUME SIGNAL — Bug #3 fix
// Compares latest candle volume against the 20-period average volume.
// ==========================================

export function calculateVolumeSignal(klines: Kline[]): { value: string; signal: 'BUY' | 'SELL' | 'NEUTRAL' } {
  if (!klines || klines.length < 21) {
    return { value: '—', signal: 'NEUTRAL' };
  }

  const recentVols = klines.slice(-21, -1).map(k => k.volume);
  const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const currentVol = klines[klines.length - 1].volume;
  const ratio = avgVol > 0 ? currentVol / avgVol : 0;

  const formatted = currentVol > 1_000_000
    ? (currentVol / 1_000_000).toFixed(1) + 'M'
    : currentVol > 1_000
      ? (currentVol / 1_000).toFixed(1) + 'K'
      : currentVol.toFixed(0);

  // Volume spike (≥1.5× average) is a confirming signal (BUY bias since
  // volume spikes more commonly accompany breakouts than breakdowns).
  const signal: 'BUY' | 'SELL' | 'NEUTRAL' = ratio >= 1.5 ? 'BUY' : 'NEUTRAL';

  return { value: `${formatted} (${ratio.toFixed(1)}×)`, signal };
}

// ==========================================
// UNIFIED STANDARD VOTING — Bug #4 fix
// Single source of truth used by both SignalPanel and Backtester.
// ==========================================

export interface StandardVotingResult {
  indicators: Array<{
    name: string;
    value: string | number;
    signal: 'BUY' | 'SELL' | 'NEUTRAL';
    color: string;
  }>;
  buyVotes: number;
  sellVotes: number;
  rawSignal: string;
  finalSignal: 'BUY' | 'SELL' | 'NEUTRAL';
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
}

export function calculateStandardVoting(klines: Kline[]): StandardVotingResult {
  const ctx = buildStandardVotingContext(klines);
  return evaluateStandardVotingAt(ctx, klines ? klines.length - 1 : 0);
}

// ==========================================
// OPTIMIZED SERIES-BASED INDICATORS
// ==========================================

export function calculateATRSeries(klines: Kline[], period: number = 14): number[] {
  const length = klines ? klines.length : 0;
  if (!klines || length === 0) return [];
  const atrSeries: number[] = new Array(length).fill(0);
  if (length === 1) {
    atrSeries[0] = Math.max(0, klines[0].high - klines[0].low);
    return atrSeries;
  }

  const trueRanges: number[] = [Math.max(0, klines[0].high - klines[0].low)];
  for (let i = 1; i < length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;

    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }

  let runningSum = 0;
  for (let i = 0; i < Math.min(period, length); i++) {
    runningSum += trueRanges[i];
    atrSeries[i] = runningSum / (i + 1);
  }

  if (length <= period) return atrSeries;

  let atr = atrSeries[period - 1];
  for (let i = period; i < length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrSeries[i] = atr;
  }

  return atrSeries;
}

export function calculateVWAPSeries(klines: Kline[], interval: string = '1h', symbol?: string): number[] {
  const length = klines.length;
  const vwapSeries: number[] = new Array(length).fill(0);
  if (!klines || length === 0) return vwapSeries;

  let cumVol = 0;
  let cumVolPrice = 0;
  let prevSessionId = '';

  for (let i = 0; i < length; i++) {
    const k = klines[i];
    const sessionId = getSessionId(klines[i], interval, symbol);

    if (sessionId !== prevSessionId && prevSessionId !== '') {
      cumVol = 0;
      cumVolPrice = 0;
    }
    prevSessionId = sessionId;

    const v = k.volume;
    const p = (k.high + k.low + k.close) / 3;
    cumVol += v;
    cumVolPrice += p * v;

    vwapSeries[i] = cumVol > 0 ? cumVolPrice / cumVol : k.close;
  }

  return vwapSeries;
}

export interface MACDSeriesData {
  macd: number[];
  signal: number[];
  histogram: number[];
  signals: ('BUY' | 'SELL' | 'NEUTRAL')[];
}

export function calculateMACDSeries(data: number[]): MACDSeriesData {
  const length = data.length;
  const macd: number[] = new Array(length).fill(NaN);
  const signal: number[] = new Array(length).fill(NaN);
  const histogram: number[] = new Array(length).fill(NaN);
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');

  if (!data || length < 35) {
    return { macd, signal, histogram, signals };
  }

  const ema12 = calculateEMA(data, 12);
  const ema26 = calculateEMA(data, 26);

  for (let i = 0; i < length; i++) {
    if (!isNaN(ema12[i]) && !isNaN(ema26[i])) {
      macd[i] = ema12[i] - ema26[i];
    }
  }

  // Get index where valid macd starts (first index without NaN is 25 for ema26)
  const firstValidMacdIdx = macd.findIndex(v => !isNaN(v));
  if (firstValidMacdIdx === -1) {
    return { macd, signal, histogram, signals };
  }

  const validMacd = macd.slice(firstValidMacdIdx);
  const validSignal = calculateEMA(validMacd, 9);

  // Align validSignal back to main arrays
  for (let i = 0; i < validSignal.length; i++) {
    const origIdx = firstValidMacdIdx + i;
    if (!isNaN(validSignal[i])) {
      signal[origIdx] = validSignal[i];
      histogram[origIdx] = macd[origIdx] - signal[origIdx];
    }
  }

  // Calculate crossovers for each index
  for (let i = firstValidMacdIdx + 8; i < length; i++) {
    let sig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    
    // Look back up to 3 candles (offset 0, 1, 2)
    for (let offset = 0; offset < 3; offset++) {
      const idxCurr = i - offset;
      const idxPrev = idxCurr - 1;
      if (idxPrev < 0) break;

      const histCurr = histogram[idxCurr];
      const histPrev = histogram[idxPrev];

      if (isNaN(histCurr) || isNaN(histPrev)) continue;

      if (histPrev <= 0 && histCurr > 0) {
        sig = 'BUY';
        break;
      }
      if (histPrev >= 0 && histCurr < 0) {
        sig = 'SELL';
        break;
      }
    }

    // Histogram acceleration filter
    if (sig !== 'NEUTRAL') {
      const latestHist = histogram[i];
      const prevHistVal = histogram[i - 1];
      if (!isNaN(latestHist) && !isNaN(prevHistVal)) {
        if (sig === 'BUY' && latestHist > 0 && latestHist < prevHistVal) {
          sig = 'NEUTRAL';
        } else if (sig === 'SELL' && latestHist < 0 && latestHist > prevHistVal) {
          sig = 'NEUTRAL';
        }
      }
    }

    signals[i] = sig;
  }

  return { macd, signal, histogram, signals };
}

export interface StochRSISeriesResult {
  k: number[];
  d: number[];
  signals: ('BUY' | 'SELL' | 'NEUTRAL')[];
}

export function calculateStochRSISeries(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3
): StochRSISeriesResult {
  const length = closes.length;
  const kSeries: number[] = new Array(length).fill(NaN);
  const dSeries: number[] = new Array(length).fill(NaN);
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');

  const minRequired = rsiPeriod + stochPeriod + Math.max(kPeriod, dPeriod);
  if (!closes || length < minRequired) {
    return { k: kSeries, d: dSeries, signals };
  }

  const rsiSeries = calculateRSISeries(closes, rsiPeriod);

  const stochRsiRaw: number[] = new Array(length).fill(NaN);
  for (let i = rsiPeriod + stochPeriod - 1; i < length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length < stochPeriod) continue;

    const minRsi = Math.min(...validWindow);
    const maxRsi = Math.max(...validWindow);
    const currentRsi = rsiSeries[i];

    if (maxRsi === minRsi) {
      stochRsiRaw[i] = 50;
    } else {
      stochRsiRaw[i] = ((currentRsi - minRsi) / (maxRsi - minRsi)) * 100;
    }
  }

  for (let i = 0; i < length; i++) {
    if (i < rsiPeriod + stochPeriod + kPeriod - 2) continue;
    const window = stochRsiRaw.slice(i - kPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length === kPeriod) {
      kSeries[i] = validWindow.reduce((a, b) => a + b, 0) / kPeriod;
    }
  }

  for (let i = 0; i < length; i++) {
    if (i < rsiPeriod + stochPeriod + kPeriod + dPeriod - 3) continue;
    const window = kSeries.slice(i - dPeriod + 1, i + 1);
    const validWindow = window.filter(v => !isNaN(v));
    if (validWindow.length === dPeriod) {
      dSeries[i] = validWindow.reduce((a, b) => a + b, 0) / dPeriod;
    }
  }

  // Generate signals for each index
  for (let i = rsiPeriod + stochPeriod + kPeriod + dPeriod - 2; i < length; i++) {
    const prevK = kSeries[i - 1];
    const prevD = dSeries[i - 1];
    const currK = kSeries[i];
    const currD = dSeries[i];

    if (isNaN(prevK) || isNaN(prevD) || isNaN(currK) || isNaN(currD)) continue;

    let sig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if ((prevK < 20 || currK < 25) && prevK <= prevD && currK > currD) {
      sig = 'BUY';
    } else if ((prevK > 80 || currK > 75) && prevK >= prevD && currK < currD) {
      sig = 'SELL';
    }
    signals[i] = sig;
  }

  return { k: kSeries, d: dSeries, signals };
}

export function calculateVolumeSignalSeries(klines: Kline[]): { values: string[], signals: ('BUY' | 'SELL' | 'NEUTRAL')[] } {
  const length = klines.length;
  const values: string[] = new Array(length).fill('—');
  const signals: ('BUY' | 'SELL' | 'NEUTRAL')[] = new Array(length).fill('NEUTRAL');

  if (!klines || length < 21) {
    return { values, signals };
  }

  // Precompute simple moving average of volume
  let sumVol = 0;
  for (let i = 0; i < 20; i++) {
    sumVol += klines[i].volume;
  }

  for (let i = 20; i < length; i++) {
    const avgVol = sumVol / 20;
    const currentVol = klines[i].volume;
    const ratio = avgVol > 0 ? currentVol / avgVol : 0;

    const formatted = currentVol > 1_000_000
      ? (currentVol / 1_000_000).toFixed(1) + 'M'
      : currentVol > 1_000
        ? (currentVol / 1_000).toFixed(1) + 'K'
        : currentVol.toFixed(0);

    values[i] = `${formatted} (${ratio.toFixed(1)}×)`;
    signals[i] = ratio >= 1.5 ? 'BUY' : 'NEUTRAL';

    // Slide window for next iteration: subtract oldest volume (i-19) and add current volume (i)
    // Actually, avgVol uses klines.slice(i-21, i-1) which means indices i-20 to i-1.
    // So the window is length 20, ending at i-1.
    // Let's verify sumVol tracking:
    // When i = 20, sumVol is sum of index 0 to 19. That is correct!
    // Next, for i = 21, the sumVol should be sum of index 1 to 20.
    // So we subtract index i-20 (which is 20-20 = 0) and add index i-1 (which is 20).
    sumVol = sumVol - klines[i - 20].volume + klines[i].volume;
  }

  return { values, signals };
}

// ==========================================
// RSI SLOPE — Momentum direction detection
// ==========================================

export function calculateRSISlope(rsiSeries: number[], index: number, lookback: number = 3): number {
  if (index < lookback) return 0;
  const current = rsiSeries[index];
  const past = rsiSeries[index - lookback];
  if (isNaN(current) || isNaN(past)) return 0;
  const diff = current - past;
  if (diff > 1.5) return 1;   // Rising
  if (diff < -1.5) return -1; // Falling
  return 0; // Flat
}

// ==========================================
// PIVOT POINTS — Support & Resistance Detection
// ==========================================

export interface PivotPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

export function calculatePivotPoints(klines: Kline[], lookback: number = 5): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  if (!klines || klines.length < lookback * 2 + 1) return pivots;

  for (let i = lookback; i < klines.length - lookback; i++) {
    let isPivotHigh = true;
    let isPivotLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isPivotHigh = false;
      if (klines[j].low <= klines[i].low) isPivotLow = false;
      if (!isPivotHigh && !isPivotLow) break;
    }

    if (isPivotHigh) pivots.push({ index: i, price: klines[i].high, type: 'high' });
    if (isPivotLow) pivots.push({ index: i, price: klines[i].low, type: 'low' });
  }

  return pivots;
}

function clusterPrices(prices: number[], threshold: number = 0.005): number[] {
  if (prices.length === 0) return [];

  const sorted = [...prices].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const clusterAvg = lastCluster.reduce((a, b) => a + b, 0) / lastCluster.length;

    if (clusterAvg > 0 && Math.abs(sorted[i] - clusterAvg) / clusterAvg < threshold) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);
}

export interface SupportResistanceLevels {
  supports: number[];
  resistances: number[];
  nearestSupport: number;
  nearestResistance: number;
}

export function calculateSupportResistance(
  klines: Kline[],
  currentPrice: number,
  pivotLookback: number = 5
): SupportResistanceLevels {
  const fallback: SupportResistanceLevels = {
    supports: [],
    resistances: [],
    nearestSupport: 0,
    nearestResistance: 0,
  };

  if (!klines || klines.length < pivotLookback * 2 + 1 || currentPrice <= 0) return fallback;

  const pivots = calculatePivotPoints(klines, pivotLookback);
  if (pivots.length === 0) return fallback;

  const rawSupports: number[] = [];
  const rawResistances: number[] = [];

  for (const p of pivots) {
    if (p.type === 'low' && p.price < currentPrice) {
      rawSupports.push(p.price);
    } else if (p.type === 'high' && p.price > currentPrice) {
      rawResistances.push(p.price);
    }
  }

  const supports = clusterPrices(rawSupports)
    .sort((a, b) => b - a)
    .slice(0, 3);

  const resistances = clusterPrices(rawResistances)
    .sort((a, b) => a - b)
    .slice(0, 3);

  return {
    supports,
    resistances,
    nearestSupport: supports[0] || 0,
    nearestResistance: resistances[0] || 0,
  };
}

// ==========================================
// ADX (Average Directional Index) — Wilder 1978
// Measures trend STRENGTH (not direction).
// ADX > 20 = trending market, ADX < 20 = range/choppy.
// ==========================================

export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export function calculateADXSeries(klines: Kline[], period: number = 14): ADXResult {
  const length = klines.length;
  const adxSeries: number[] = new Array(length).fill(NaN);
  const plusDISeries: number[] = new Array(length).fill(NaN);
  const minusDISeries: number[] = new Array(length).fill(NaN);
  const fallback = { adx: adxSeries, plusDI: plusDISeries, minusDI: minusDISeries };
  if (length < period * 2 + 1) return fallback;

  // Step 1: Calculate +DM, -DM, and TR for each bar
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [klines[0].high - klines[0].low];

  for (let i = 1; i < length; i++) {
    const highDiff = klines[i].high - klines[i - 1].high;
    const lowDiff = klines[i - 1].low - klines[i].low;

    // +DM: if upward move is larger than downward move and is positive
    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    // -DM: if downward move is larger than upward move and is positive
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    // True Range
    const hl = klines[i].high - klines[i].low;
    const hpc = Math.abs(klines[i].high - klines[i - 1].close);
    const lpc = Math.abs(klines[i].low - klines[i - 1].close);
    tr.push(Math.max(hl, hpc, lpc));
  }

  // Step 2: Wilder's smoothing (RMA) for +DM, -DM, TR over `period`
  // First value = sum of first `period` values
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  let smoothTR = 0;

  for (let i = 1; i <= period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += tr[i];
  }

  // Step 3: Calculate +DI, -DI, DX from period onward
  const dxSeries: number[] = new Array(length).fill(NaN);

  for (let i = period; i < length; i++) {
    if (i > period) {
      // Wilder's smoothing: smoothed = prev - (prev / period) + current
      smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
      smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
      smoothTR = smoothTR - (smoothTR / period) + tr[i];
    }

    if (smoothTR === 0) {
      dxSeries[i] = 0;
      plusDISeries[i] = 0;
      minusDISeries[i] = 0;
      continue;
    }

    const plusDI = 100 * smoothPlusDM / smoothTR;
    const minusDI = 100 * smoothMinusDM / smoothTR;
    plusDISeries[i] = plusDI;
    minusDISeries[i] = minusDI;
    const diSum = plusDI + minusDI;

    dxSeries[i] = diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;
  }

  // Fill initial NaN indices with first valid DI to prevent NaN issues in bias checks
  for (let i = 0; i < period; i++) {
    plusDISeries[i] = plusDISeries[period] || 0;
    minusDISeries[i] = minusDISeries[period] || 0;
  }

  // Step 4: ADX = RMA of DX over `period`
  // First ADX = average of first `period` valid DX values
  const firstValidDX = period; // first valid DX is at index `period`
  const adxStartIdx = firstValidDX + period; // need `period` DX values to seed

  if (adxStartIdx >= length) return fallback;

  let adxSum = 0;
  for (let i = firstValidDX; i < firstValidDX + period; i++) {
    adxSum += (isNaN(dxSeries[i]) ? 0 : dxSeries[i]);
  }

  let adx = adxSum / period;
  adxSeries[adxStartIdx - 1] = adx;

  for (let i = adxStartIdx; i < length; i++) {
    const dx = isNaN(dxSeries[i]) ? 0 : dxSeries[i];
    adx = (adx * (period - 1) + dx) / period;
    adxSeries[i] = adx;
  }

  // Fill initial values for ADX
  for (let i = 0; i < adxStartIdx - 1; i++) {
    adxSeries[i] = adxSeries[adxStartIdx - 1] || 0;
  }

  return { adx: adxSeries, plusDI: plusDISeries, minusDI: minusDISeries };
}

// ==========================================
// CANDLE QUALITY HELPERS
// Used by VCME Sniper to filter fakeout breakouts
// ==========================================

/** Ratio of candle body to total range (0 to 1). Values > 0.5 indicate a decisive candle (not a doji). */
export function candleBodyRatio(k: Kline): number {
  const range = k.high - k.low;
  if (range === 0) return 0;
  return Math.abs(k.close - k.open) / range;
}

/** Position of the close within the candle range (0 = low, 1 = high).
 * For LONG breakouts, values > 0.7 indicate strength (close in upper third).
 * For SHORT breakdowns, values < 0.3 indicate strength (close in lower third). */
export function candleClosePosition(k: Kline): number {
  const range = k.high - k.low;
  if (range === 0) return 0.5;
  return (k.close - k.low) / range;
}

// ==========================================
// VCME SNIPER ENGINE — 3-Layer Multi-Temporal Signal (v2.0)
// Replaces the old calculateMultitemporalSignal (Filtro Maestro)
// ==========================================

export interface VCMESniperResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  mode: 'PULLBACK' | 'BREAKOUT' | 'MEAN_REVERSION' | 'REVERSAL' | 'NONE';
  tradeType: 'DAY' | 'SWING';
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskRewardRatio: number;
  chandelierExit: number;
  positionSizeUnits: number;
  riskAmount: number;
  confidenceScore: number;
  // Context for UI display
  bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL';
  adx1H: number;
  momentum1H: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL';
  triggerDetail: string;
  // Key indicators for display
  rsi1H: number;
  macdHistDirection: 'CRECIENTE' | 'DECRECIENTE' | 'PLANO';
  ema200_1D: number;
  ema50_1H: number;
  vwap5m: number;
  bbUpper5m: number;
  bbLower5m: number;
  // Compatibility fields for existing UI
  isTrendUp: boolean;
  nearestSupport: number;
  nearestResistance: number;
  // Adaptive scoring fields
  score: number;
  baseScore: number;
  adaptiveFactor: number;
  marketRegime: string;
  volatilityProfile: string;
  recentPerfLabel: string;
  atrPercent: number;
  avgDailyRange: number;
  confidence: 'ALTA' | 'MODERADA' | 'DESCARTAR';
  // Payload Snapshot for alerts and trailing persistence
  snapshot?: {
    atr_5m: number;
    atr_1H: number;
    ema21_1H: number;
    vwap_5m: number;
    rvol: number;
  };
}

export function calculateChandelierExit(klines1h: Kline[], period: number = 22, multiplier: number = 3.0): { long: number[]; short: number[] } {
  const length = klines1h ? klines1h.length : 0;
  const longExit: number[] = new Array(length).fill(NaN);
  const shortExit: number[] = new Array(length).fill(NaN);
  if (!klines1h || length < period) return { long: longExit, short: shortExit };

  const atrSeries = calculateATRSeries(klines1h, period);

  for (let i = period - 1; i < length; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (klines1h[j].high > highestHigh) highestHigh = klines1h[j].high;
      if (klines1h[j].low < lowestLow) lowestLow = klines1h[j].low;
    }
    const atr = atrSeries[i];
    if (!isNaN(atr)) {
      longExit[i] = highestHigh - multiplier * atr;
      shortExit[i] = lowestLow + multiplier * atr;
    }
  }
  return { long: longExit, short: shortExit };
}

/**
 * Fast arithmetic check for US Daylight Saving Time (EDT vs EST).
 * US DST begins the second Sunday in March (at 07:00 UTC / 02:00 EST)
 * and ends the first Sunday in November (at 06:00 UTC / 02:00 EDT).
 */
export function isUsDaylightSavingTime(epochMs: number = Date.now()): boolean {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();

  // Second Sunday in March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const secondSunMarch = 1 + ((7 - marchFirst.getUTCDay()) % 7) + 7;
  const dstStart = Date.UTC(year, 2, secondSunMarch, 7, 0, 0);

  // First Sunday in November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const firstSunNov = 1 + ((7 - novFirst.getUTCDay()) % 7);
  const dstEnd = Date.UTC(year, 10, firstSunNov, 6, 0, 0);

  return epochMs >= dstStart && epochMs < dstEnd;
}

/**
 * Returns exact US Eastern Time calendar components with zero Intl overhead.
 */
export function getEasternTime(epochMs: number = Date.now()): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  minuteOfDay: number;
  isDst: boolean;
} {
  const isDst = isUsDaylightSavingTime(epochMs);
  const offsetMs = (isDst ? -4 : -5) * 3600 * 1000;
  const etDate = new Date(epochMs + offsetMs);

  const year = etDate.getUTCFullYear();
  const month = etDate.getUTCMonth() + 1;
  const day = etDate.getUTCDate();
  const dayOfWeek = etDate.getUTCDay();
  const hour = etDate.getUTCHours();
  const minute = etDate.getUTCMinutes();
  const minuteOfDay = hour * 60 + minute;

  return { year, month, day, dayOfWeek, hour, minute, minuteOfDay, isDst };
}

/**
 * Calculates Good Friday date for any Gregorian year using Meeus/Jones/Butcher algorithm.
 */
function getGoodFriday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  const easter = new Date(Date.UTC(year, month - 1, day));
  easter.setUTCDate(easter.getUTCDate() - 2);
  return { month: easter.getUTCMonth() + 1, day: easter.getUTCDate() };
}

/**
 * Checks if the given date is an official NYSE / NASDAQ market holiday.
 */
export function isNyseHoliday(year: number, month: number, day: number, dayOfWeek: number): boolean {
  if (dayOfWeek === 0 || dayOfWeek === 6) return true;

  // 1. New Year's Day (Jan 1) or observed
  if (month === 1 && day === 1) return true;
  if (month === 1 && day === 2 && dayOfWeek === 1) return true;
  if (month === 12 && day === 31 && dayOfWeek === 5) return true;

  // 2. Martin Luther King Jr. Day (3rd Monday of Jan: 15-21)
  if (month === 1 && dayOfWeek === 1 && day >= 15 && day <= 21) return true;

  // 3. Washington's Birthday / Presidents' Day (3rd Monday of Feb: 15-21)
  if (month === 2 && dayOfWeek === 1 && day >= 15 && day <= 21) return true;

  // 4. Good Friday
  const gf = getGoodFriday(year);
  if (month === gf.month && day === gf.day) return true;

  // 5. Memorial Day (Last Monday of May: 25-31)
  if (month === 5 && dayOfWeek === 1 && day >= 25 && day <= 31) return true;

  // 6. Juneteenth National Independence Day (June 19, established 2021) or observed
  if (year >= 2021) {
    if (month === 6 && day === 19) return true;
    if (month === 6 && day === 20 && dayOfWeek === 1) return true;
    if (month === 6 && day === 18 && dayOfWeek === 5) return true;
  }

  // 7. Independence Day (July 4) or observed
  if (month === 7 && day === 4) return true;
  if (month === 7 && day === 5 && dayOfWeek === 1) return true;
  if (month === 7 && day === 3 && dayOfWeek === 5) return true;

  // 8. Labor Day (1st Monday of Sept: 1-7)
  if (month === 9 && dayOfWeek === 1 && day >= 1 && day <= 7) return true;

  // 9. Thanksgiving Day (4th Thursday of Nov: 22-28)
  if (month === 11 && dayOfWeek === 4 && day >= 22 && day <= 28) return true;

  // 10. Christmas Day (Dec 25) or observed
  if (month === 12 && day === 25) return true;
  if (month === 12 && day === 26 && dayOfWeek === 1) return true;
  if (month === 12 && day === 24 && dayOfWeek === 5) return true;

  return false;
}

/**
 * Checks if the given date is a NYSE early close day (13:00 ET / 1:00 PM ET).
 */
export function isNyseEarlyCloseDay(_year: number, month: number, day: number, dayOfWeek: number): boolean {
  // Day after Thanksgiving (Black Friday, 4th Friday of Nov: 23-29)
  if (month === 11 && dayOfWeek === 5 && day >= 23 && day <= 29) return true;

  // Christmas Eve (Dec 24, if a weekday and not a holiday)
  if (month === 12 && day === 24 && dayOfWeek >= 1 && dayOfWeek <= 4) return true;

  // July 3 (if weekday before July 4)
  if (month === 7 && day === 3 && dayOfWeek >= 1 && dayOfWeek <= 4) return true;

  return false;
}

/**
 * Evaluates whether the NYSE / NASDAQ regular trading session is actively open.
 * Regular hours: 09:30 to 16:00 ET (or 09:30 to 13:00 ET on early close days).
 */
export function isNyseTradingSessionActive(epochMs: number = Date.now()): boolean {
  const et = getEasternTime(epochMs);

  // Non-trading day (weekend or official market holiday)
  if (et.dayOfWeek === 0 || et.dayOfWeek === 6 || isNyseHoliday(et.year, et.month, et.day, et.dayOfWeek)) {
    return false;
  }

  const openMinute = 570; // 09:30 AM ET
  const closeMinute = isNyseEarlyCloseDay(et.year, et.month, et.day, et.dayOfWeek) ? 780 : 960; // 13:00 or 16:00 ET

  return et.minuteOfDay >= openMinute && et.minuteOfDay < closeMinute;
}

/**
 * Fast check for NYSE opening window (09:30 AM to 09:45 AM Eastern Time) with exact DST handling.
 */
export function isNyseOpeningWindow(timeSeconds: number, symbol?: string): boolean {
  const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : false;
  if (isCrypto) return false;

  const et = getEasternTime(timeSeconds * 1000);
  if (et.dayOfWeek === 0 || et.dayOfWeek === 6 || isNyseHoliday(et.year, et.month, et.day, et.dayOfWeek)) {
    return false;
  }

  // 09:30 AM to 09:45 AM ET (minutes 570 to 585)
  return et.minuteOfDay >= 570 && et.minuteOfDay < 585;
}

/**
 * Returns only confirmed closed candles.
 * If the candle period has already elapsed in time (e.g. historical data, weekend, completed bar),
 * or for equities outside regular trading hours, the candle is closed and preserved.
 * If the candle is actively forming in real-time (crypto 24/7 or live NYSE session),
 * it is dropped via slice(0, -1) to prevent repainting.
 */
export function getConfirmedClosedKlines(
  klines: Kline[],
  interval: string,
  symbol?: string
): Kline[] {
  if (!klines || klines.length <= 1) return klines || [];

  const lastCandle = klines[klines.length - 1];
  const nowSec = Math.floor(Date.now() / 1000);

  let durationSec = 300; // 5m default
  if (interval === '15m') durationSec = 900;
  else if (interval === '1h') durationSec = 3600;
  else if (interval === '4h') durationSec = 14400;
  else if (interval === '1d') durationSec = 86400;
  else if (interval === '1wk') durationSec = 604800;

  // 1. If candle duration has elapsed since candle start timestamp, it is fully closed
  if ((nowSec - lastCandle.time) >= durationSec) {
    return klines;
  }

  // 2. For non-crypto equities (NYSE / NASDAQ), if outside active market hours, last candle is finalized
  const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : false;
  if (!isCrypto) {
    if (!isNyseTradingSessionActive(nowSec * 1000)) {
      return klines;
    }
  }

  // 3. Candle is actively forming in live session (crypto 24/7 or active NYSE session): drop unclosed candle
  return klines.slice(0, -1);
}

/**
 * Resolves the authentic, causal execution price for a quantitative signal setup:
 * - If a live forming candle exists in an active session (rawKlines.length > closedKlines.length):
 *   returns rawKlines[last].close (the real-time market quote / provisional close at alert time).
 * - If the market is closed or no new candle is forming (rawKlines.length <= closedKlines.length):
 *   returns closedKlines[last].close (Close_i, the finalized close of the trigger candle).
 */
export function getEffectiveExecutionPrice(
  rawKlines: Kline[] | undefined,
  closedKlines: Kline[]
): number {
  if (!closedKlines || closedKlines.length === 0) return 0;
  const lastClosed = closedKlines[closedKlines.length - 1];

  if (rawKlines && rawKlines.length > closedKlines.length) {
    const liveCandle = rawKlines[rawKlines.length - 1];
    if (liveCandle && liveCandle.close > 0) {
      return liveCandle.close;
    }
  }

  return lastClosed.close;
}

export function getSessionId(kline: Kline, interval: string, symbol?: string): string {
  const t = kline.time;
  if (interval === '5m' || interval === '1h') {
    const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
    const offset = isCrypto ? 0 : 18000;
    return String(Math.floor((t - offset) / 86400));
  } else if (interval === '1d') {
    return String(Math.floor(t / 604800));
  }
  return 'all';
}

export interface OpeningRange {
  high: number;
  low: number;
  isActive: boolean;
}

export function getOpeningRange(klines: Kline[], index: number, interval: string = '5m', symbol?: string): OpeningRange {
  const fallback = { high: 0, low: 0, isActive: false };
  if (klines.length === 0 || index < 0 || index >= klines.length) return fallback;

  const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
  const stepSec = interval === '1h' ? 3600 : 300;
  const offset = isCrypto ? 0 : 18000;
  const curTime = klines[index].time;
  const curDay = Math.floor((curTime - offset) / 86400);

  // Find start index of current session using fast integer math and gap detection
  let sessionStartIdx = index;
  while (sessionStartIdx > 0) {
    const prevTime = klines[sessionStartIdx - 1].time;
    const prevDay = Math.floor((prevTime - offset) / 86400);
    const gap = klines[sessionStartIdx].time - prevTime;
    if (prevDay !== curDay || gap > stepSec * 3) {
      break;
    }
    sessionStartIdx--;
  }

  const requiredCandles = 6;
  if (index < sessionStartIdx + requiredCandles) {
    return fallback;
  }

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (let i = sessionStartIdx; i < sessionStartIdx + requiredCandles; i++) {
    if (klines[i].high > rangeHigh) rangeHigh = klines[i].high;
    if (klines[i].low < rangeLow) rangeLow = klines[i].low;
  }

  return { high: rangeHigh, low: rangeLow, isActive: true };
}

export function checkBullishDivergence(klines: Kline[], rsiSeries: number[], index: number, lookback: number = 10): boolean {
  if (index < lookback || isNaN(rsiSeries[index])) return false;
  const currLow = klines[index].low;
  const currRsi = rsiSeries[index];

  // Find pivot low or minimum price in lookback
  let minPrice = Infinity;
  let minPriceIdx = -1;
  for (let i = index - lookback; i < index; i++) {
    if (isNaN(rsiSeries[i])) continue;
    if (klines[i].low < minPrice) {
      minPrice = klines[i].low;
      minPriceIdx = i;
    }
  }

  if (minPriceIdx === -1) return false;

  return currLow < minPrice && currRsi > rsiSeries[minPriceIdx];
}

export function checkBearishDivergence(klines: Kline[], rsiSeries: number[], index: number, lookback: number = 10): boolean {
  if (index < lookback || isNaN(rsiSeries[index])) return false;
  const currHigh = klines[index].high;
  const currRsi = rsiSeries[index];

  // Find pivot high or maximum price in lookback
  let maxPrice = -Infinity;
  let maxPriceIdx = -1;
  for (let i = index - lookback; i < index; i++) {
    if (isNaN(rsiSeries[i])) continue;
    if (klines[i].high > maxPrice) {
      maxPrice = klines[i].high;
      maxPriceIdx = i;
    }
  }

  if (maxPriceIdx === -1) return false;

  return currHigh > maxPrice && currRsi < rsiSeries[maxPriceIdx];
}

/**
 * Calculates rolling Volume SMA (default: 20 periods) without date allocation overhead.
 * Provides a statistically robust liquidity baseline for RVOL in 24/7 markets.
 */
export function calculateRollingVolumeAvg(klines: Kline[], index: number, period: number = 20): number {
  if (index < 0 || index >= klines.length) return 0;
  let sum = 0;
  let count = 0;
  const start = Math.max(0, index - period);
  for (let i = start; i < index; i++) {
    sum += klines[i].volume;
    count++;
  }
  return count > 0 ? sum / count : klines[index].volume;
}

/**
 * Calculates authentic Relative Volume Time-of-Day (RVOL ToD).
 * Compares current volume at time slot H:M against historical average volume for the same
 * time-of-day slot across previous trading days (default: lookback 10 days).
 * Automatically falls back to rolling 20-bar SMA if < 3 historical matching days are present.
 */
export function calculateTimeOfDayRVOL(
  klines: Kline[],
  index: number = klines.length - 1,
  lookbackDays: number = 10,
  intervalSec: number = 300
): number {
  if (!klines || index < 0 || index >= klines.length) return 1.0;
  const targetCandle = klines[index];
  const targetVol = targetCandle.volume;
  if (targetVol <= 0) return 1.0;

  const targetSecOfDay = ((targetCandle.time % 86400) + 86400) % 86400;
  let sumVol = 0;
  let matchedDays = 0;
  const targetDay = Math.floor(targetCandle.time / 86400);

  let lastMatchedDay = targetDay;
  for (let i = index - 1; i >= 0 && matchedDays < lookbackDays; i--) {
    const c = klines[i];
    const cDay = Math.floor(c.time / 86400);
    if (cDay === lastMatchedDay) continue; // 1 slot per historical day

    const cSecOfDay = ((c.time % 86400) + 86400) % 86400;
    if (Math.abs(cSecOfDay - targetSecOfDay) < (intervalSec / 2)) {
      sumVol += c.volume;
      matchedDays++;
      lastMatchedDay = cDay;
    }
  }

  if (matchedDays >= 3) {
    const avgVol = sumVol / matchedDays;
    return avgVol > 0 ? Number((targetVol / avgVol).toFixed(2)) : 1.0;
  }

  // Fallback to rolling 20-bar SMA if insufficient historical day slots
  const rollingAvg = calculateRollingVolumeAvg(klines, index, 20);
  return rollingAvg > 0 ? Number((targetVol / rollingAvg).toFixed(2)) : 1.0;
}

export function calculateVCMESniperSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  _recentWinRate?: number,
  _recentProfitFactor?: number | null,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo',
  executionPrice?: number
): VCMESniperResult {
  const ctx = buildVCMESniperContext(klines5m, klines1h, klines1d, symbol, style, triggerMode);
  return evaluateVCMESniperAt(ctx, klines5m ? klines5m.length - 1 : 0, executionPrice);
}

// ============================================================================
// MOTOR DE ALERTAS MULTIFRACTAL (MTF ENGINE) - MÓDULOS Y SEÑAL PRINCIPAL
// ============================================================================

export interface VolatilityBandItem {
  upper: number;
  lower: number;
  midpoint: number;
  width: number;
  threshold: number;
  isCompressed: boolean;
}

export function calculateRevolutionVolatilityBand(
  klines: Kline[],
  period: number = 20,
  multiplier: number = 2,
  lookbackN: number = 200,
  percentile: number = 15
): VolatilityBandItem[] {
  if (!klines || klines.length < period) return [];

  const n = klines.length;
  const closes = new Float64Array(n);
  for (let i = 0; i < n; i++) closes[i] = klines[i].close;

  const widths = new Float64Array(n);
  const uppers = new Float64Array(n);
  const lowers = new Float64Array(n);
  const midpoints = new Float64Array(n);

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < n; i++) {
    const c = closes[i];
    sum += c;
    sumSq += c * c;

    if (i >= period) {
      const oldC = closes[i - period];
      sum -= oldC;
      sumSq -= oldC * oldC;
    }

    if (i < period - 1) {
      widths[i] = NaN;
      uppers[i] = NaN;
      lowers[i] = NaN;
      midpoints[i] = NaN;
      continue;
    }

    const currentSma = sum / period;
    const variance = Math.max(0, (sumSq - (sum * sum) / period) / period);
    const stdDev = Math.sqrt(variance);
    const upper = currentSma + (stdDev * multiplier);
    const lower = currentSma - (stdDev * multiplier);
    const width = upper - lower;

    widths[i] = width;
    uppers[i] = upper;
    lowers[i] = lower;
    midpoints[i] = currentSma;
  }

  const result: VolatilityBandItem[] = new Array(n);
  const scratchBuf = new Float64Array(lookbackN);

  for (let i = 0; i < n; i++) {
    if (i < period - 1) {
      result[i] = { upper: 0, lower: 0, midpoint: 0, width: 0, threshold: 0, isCompressed: false };
      continue;
    }

    const currentWidth = widths[i];
    const startIdx = Math.max(period - 1, i - lookbackN);
    let count = 0;
    for (let j = startIdx; j < i; j++) {
      const w = widths[j];
      if (!isNaN(w)) {
        scratchBuf[count++] = w;
      }
    }

    let threshold = currentWidth;
    if (count > 5) {
      const slice = scratchBuf.subarray(0, count);
      slice.sort();
      const pIdx = Math.floor((percentile / 100) * count);
      threshold = slice[Math.min(pIdx, count - 1)];
    }

    const isCompressed = !isNaN(currentWidth) && currentWidth <= threshold;

    result[i] = {
      upper: uppers[i],
      lower: lowers[i],
      midpoint: midpoints[i],
      width: currentWidth,
      threshold,
      isCompressed
    };
  }

  return result;
}

export interface VolumeCompositionItem {
  volume: number;
  smaVolume: number;
  volumeMultiplier: number;
  activeBuyPercent: number;
  activeSellPercent: number;
  isHighVolume: boolean;
  isPassiveBuyAbsorption: boolean;
  isPassiveSellAbsorption: boolean;
}

export function calculateVolumeComposition(klines: Kline[], period: number = 20): VolumeCompositionItem[] {
  if (!klines || klines.length === 0) return [];

  const volumes = klines.map(k => k.volume);
  const smaV = calculateSMA(volumes, period);
  const result: VolumeCompositionItem[] = [];

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const range = k.high - k.low;
    const vol = k.volume;
    const avgVol = isNaN(smaV[i]) ? vol : smaV[i];
    const volumeMultiplier = avgVol > 0 ? vol / avgVol : 1;

    let activeBuyRatio = 0.5;
    let activeSellRatio = 0.5;

    if (range > 0) {
      activeBuyRatio = (k.close - k.low) / range;
      activeSellRatio = (k.high - k.close) / range;
    } else if (k.close > k.open) {
      activeBuyRatio = 0.8;
      activeSellRatio = 0.2;
    } else if (k.close < k.open) {
      activeBuyRatio = 0.2;
      activeSellRatio = 0.8;
    }

    const activeBuyPercent = Number((activeBuyRatio * 100).toFixed(1));
    const activeSellPercent = Number((activeSellRatio * 100).toFixed(1));

    const lowerWick = Math.min(k.open, k.close) - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);

    const isHighVolume = volumeMultiplier >= 1.5;
    const isPassiveBuyAbsorption = vol > avgVol && range > 0 && (lowerWick / range) >= 0.35 && activeBuyPercent >= 45;
    const isPassiveSellAbsorption = vol > avgVol && range > 0 && (upperWick / range) >= 0.35 && activeSellPercent >= 45;

    result.push({
      volume: vol,
      smaVolume: avgVol,
      volumeMultiplier: Number(volumeMultiplier.toFixed(2)),
      activeBuyPercent,
      activeSellPercent,
      isHighVolume,
      isPassiveBuyAbsorption,
      isPassiveSellAbsorption
    });
  }

  return result;
}

export interface AndianOscillatorResult {
  green: number;
  red: number;
  orange: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export function calculateAndianOscillator(klines1D: Kline[], period: number = 14): AndianOscillatorResult[] {
  if (!klines1D || klines1D.length < period) return [];

  const bullishMoves: number[] = [];
  const bearishMoves: number[] = [];
  const ranges: number[] = [];

  for (let i = 0; i < klines1D.length; i++) {
    const k = klines1D[i];
    const range = Math.max(0.000001, k.high - k.low);
    const bull = Math.max(0, k.close - k.open);
    const bear = Math.max(0, k.open - k.close);

    bullishMoves.push(bull);
    bearishMoves.push(bear);
    ranges.push(range);
  }

  const emaBull = calculateEMA(bullishMoves, period);
  const emaBear = calculateEMA(bearishMoves, period);
  const emaRange = calculateEMA(ranges, period);

  const greenSeries: number[] = [];
  const redSeries: number[] = [];
  const rawOrange: number[] = [];

  for (let i = 0; i < klines1D.length; i++) {
    const r = Math.max(0.000001, emaRange[i] || 1);
    const g = Number(((emaBull[i] / r) * 100).toFixed(1));
    const rd = Number(((emaBear[i] / r) * 100).toFixed(1));
    greenSeries.push(isNaN(g) ? 0 : g);
    redSeries.push(isNaN(rd) ? 0 : rd);
    rawOrange.push(isNaN(g) || isNaN(rd) ? 0 : (g + rd) / 2);
  }

  const orangeSeries = calculateEMA(rawOrange, 9);
  const results: AndianOscillatorResult[] = [];

  // Calculate 20th percentiles for submerged checks over last 50 bars
  for (let i = 0; i < klines1D.length; i++) {
    const g = greenSeries[i];
    const r = redSeries[i];
    const o = orangeSeries[i];

    const pastRed = redSeries.slice(Math.max(0, i - 50), i + 1).sort((a, b) => a - b);
    const redP20 = pastRed.length > 0 ? pastRed[Math.floor(pastRed.length * 0.2)] : 20;

    const pastGreen = greenSeries.slice(Math.max(0, i - 50), i + 1).sort((a, b) => a - b);
    const greenP20 = pastGreen.length > 0 ? pastGreen[Math.floor(pastGreen.length * 0.2)] : 20;

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (g > o && r <= redP20) {
      bias = 'BULLISH';
    } else if (r > o && g <= greenP20) {
      bias = 'BEARISH';
    }

    results.push({
      green: g,
      red: r,
      orange: isNaN(o) ? 0 : Number(o.toFixed(1)),
      bias
    });
  }

  return results;
}

export interface DreadBlitzItem {
  mcd: number;
  upperBB: number;
  lowerBB: number;
  isOverbought: boolean;
  isOversold: boolean;
}

export function calculateDreadBlitz(klines5M: Kline[], period: number = 20, multiplier: number = 2): DreadBlitzItem[] {
  if (!klines5M || klines5M.length < period) return [];

  const closes = klines5M.map(k => k.close);
  const ema12 = calculateEMA(closes, 12);
  const atrSeries = calculateATRSeries(klines5M, 14);

  const mcdSeries: number[] = [];
  for (let i = 0; i < klines5M.length; i++) {
    const currentAtr = Math.max(0.0001, atrSeries[i] || 1);
    const rawMcd = (closes[i] - (ema12[i] || closes[i])) / currentAtr;
    mcdSeries.push(isNaN(rawMcd) ? 0 : rawMcd);
  }

  const smaMcd = calculateSMA(mcdSeries, period);
  const results: DreadBlitzItem[] = [];

  for (let i = 0; i < klines5M.length; i++) {
    if (i < period - 1) {
      results.push({ mcd: 0, upperBB: 0, lowerBB: 0, isOverbought: false, isOversold: false });
      continue;
    }

    const currentSma = smaMcd[i];
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += Math.pow(mcdSeries[j] - currentSma, 2);
    }
    const stdDev = Math.sqrt(sumSq / period);
    const upperBB = currentSma + (stdDev * multiplier);
    const lowerBB = currentSma - (stdDev * multiplier);
    const currentMcd = mcdSeries[i];

    results.push({
      mcd: Number(currentMcd.toFixed(3)),
      upperBB: Number(upperBB.toFixed(3)),
      lowerBB: Number(lowerBB.toFixed(3)),
      isOverbought: currentMcd >= upperBB,
      isOversold: currentMcd <= lowerBB
    });
  }

  return results;
}

export interface MultifractalMTFSignalResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  strategy: 'BREAKOUT_EXPANSION' | 'MEAN_REVERSION' | 'NONE';
  stopLoss: number;
  triggerPrice: number;
  isCompressed1H: boolean;
  bias1D: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  activeVolumePercent5M: number;
  volumeMultiplier5M: number;
  andianGreen: number;
  andianRed: number;
  andianOrange: number;
  volatilityWidth1H: number;
  dreadBlitzMCD: number;
  isOverbought5M: boolean;
  isOversold5M: boolean;
  reasoning: string;
}

export function calculateMultifractalMTFSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  _symbol: string = 'ASSET',
  executionPrice?: number
): MultifractalMTFSignalResult {
  const ctx = buildMultifractalMTFContext(klines5m, klines1h, klines1d, _symbol);
  return evaluateMultifractalMTFAt(ctx, klines5m ? klines5m.length - 1 : 0, executionPrice);
}
