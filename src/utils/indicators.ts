import type { Kline } from '../services/api';
import { formatSmartPrice, formatSmartNumber } from './formatters';

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
  if (!bbSeries || bbSeries.length === 0) {
    return { status: 'NORMAL', percentile: 50, widthPercent: 0 };
  }
  const lastBB = bbSeries[bbSeries.length - 1];
  const currentWidth = lastBB.widthPercent;

  const windowSeries = bbSeries.slice(-lookback);
  const sampleSize = windowSeries.length;
  if (sampleSize < 10) {
    return { status: 'NORMAL', percentile: 50, widthPercent: currentWidth };
  }

  // Calculate percentile rank of current widthPercent within historical window
  const lowerCount = windowSeries.filter(b => b.widthPercent < currentWidth).length;
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

export function detectEmaCrossover(closes: number[], fastPeriod = 9, slowPeriod = 20, lookback = 5): EmaCrossover {
  if (closes.length < slowPeriod + lookback) return { type: 'NONE', barsAgo: 0 };

  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  // Buscar cruce en las últimas `lookback` velas
  for (let i = 1; i <= lookback; i++) {
    const idx     = closes.length - i;       // vela actual en este paso
    const idxPrev = idx - 1;                 // vela anterior
    if (idxPrev < 0) break;

    const fastNow  = emaFast[idx];
    const slowNow  = emaSlow[idx];
    const fastPrev = emaFast[idxPrev];
    const slowPrev = emaSlow[idxPrev];

    if (isNaN(fastNow) || isNaN(slowNow) || isNaN(fastPrev) || isNaN(slowPrev)) continue;

    // Cruce alcista: fast cruzó de abajo hacia arriba
    if (fastPrev < slowPrev && fastNow > slowNow) {
      return { type: 'BULLISH', barsAgo: i - 1 }; // 0 = en la vela actual
    }
    // Cruce bajista: fast cruzó de arriba hacia abajo
    if (fastPrev > slowPrev && fastNow < slowNow) {
      return { type: 'BEARISH', barsAgo: i - 1 };
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

export function calculateExperimentalSignal(klines: Kline[], interval: string = '1h'): { signal: 'BUY' | 'SELL' | 'NEUTRAL', stopLoss: number, rsi: number, validVolume: boolean, emaCrossover: EmaCrossover } {
  if (!klines || klines.length < 21) {
    return { signal: 'NEUTRAL', stopLoss: 0, rsi: 0, validVolume: false, emaCrossover: { type: 'NONE', barsAgo: 0 } };
  }

  const closes = klines.map(k => k.close);
  
  // EMAs
  const ema9Arr = calculateEMA(closes, 9);
  const ema20Arr = calculateEMA(closes, 20);
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];

  // RSI
  const rsiObj = calculateRSI(closes, 14);
  const rsi = rsiObj.value;

  // ATR
  const atr = calculateATR(klines, 14);

  // Session-based VWAP
  const vwap = calculateVWAP(klines, interval);

  // Volume
  const last20Vol = klines.slice(-20).map(k => k.volume);
  const volAvg = last20Vol.reduce((a, b) => a + b, 0) / 20;

  const curr = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  const hammer = isHammer(curr);
  const engulfing = isEngulfing(curr, prev);
  const bRatio = candleBodyRatio(curr);
  const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > ema9;
  const bullish_candle = hammer || engulfing === 1 || strongBullish;
  const bearish_candle = engulfing === -1;

  const distVwapAtr = atr > 0 ? Math.abs(curr.close - vwap) / atr : 0;
  const cp = closePosition(curr);
  const isNotOverextended = distVwapAtr <= 2.2;

  const is_buy = curr.close > vwap && ema9 > ema20 && curr.volume >= volAvg * 0.8 && bullish_candle && bRatio >= 0.3 && isNotOverextended && cp >= 0.50;
  const is_sell = curr.close < vwap && ema9 < ema20 && curr.volume >= volAvg * 0.8 && (bearish_candle || curr.close < ema20) && bRatio >= 0.3 && isNotOverextended && cp <= 0.50;

  // EMA Crossover detection
  const emaCrossover = detectEmaCrossover(closes, 9, 20, 5);

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (is_buy) signal = 'BUY';
  else if (is_sell) signal = 'SELL';

  const stopLossLong = curr.close - (2 * atr);
  const stopLossShort = curr.close + (2 * atr);

  return {
    signal,
    stopLoss: signal === 'BUY' ? stopLossLong : (signal === 'SELL' ? stopLossShort : 0),
    rsi,
    validVolume: curr.volume > volAvg,
    emaCrossover
  };
}

// ==========================================
// EXPERIMENTAL SIGNAL 2: SCORING MULTICAPA
// Port of analizar_señal() Python → TypeScript
// ==========================================

interface ScoringConfig {
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

const SCORING_CONFIG: Record<string, ScoringConfig> = {
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

function calculateOBV(klines: Kline[]): number[] {
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
  const fallback: ScoringResult = {
    signal: 'HOLD', score: 0, threshold: 3,
    layers: {
      trend:    { score: 0, weightedScore: 0, note: 'Datos insuficientes' },
      rsi:      { score: 0, weightedScore: 0, note: 'Datos insuficientes' },
      bollinger:{ score: 0, weightedScore: 0, note: 'Datos insuficientes' },
      volume:   { score: 0, weightedScore: 0, note: 'Datos insuficientes' },
      candle:   { score: 0, weightedScore: 0, note: 'Datos insuficientes' },
      structure:{ score: 0, weightedScore: 0, note: 'Datos insuficientes' },
    }
  };

  const cfg = SCORING_CONFIG[interval] ?? SCORING_CONFIG['1h'];
  if (!klines || klines.length < 60) return fallback;

  const closes = klines.map(k => k.close);
  const curr   = klines[klines.length - 1];

  // ── EMAs ──────────────────────────────────────────────────────────
  const emaFastArr  = calculateEMA(closes, cfg.emaFast);
  const emaSlowArr  = calculateEMA(closes, cfg.emaSlow);
  const emaFast     = emaFastArr[emaFastArr.length - 1];
  const emaSlow     = emaSlowArr[emaSlowArr.length - 1];
  let   emaMajorVal = NaN;
  if (cfg.emaMajor) {
    const arr = calculateEMA(closes, cfg.emaMajor);
    emaMajorVal = arr[arr.length - 1];
  }

  // Layer 1 — Tendencia EMA
  let s1 = 0; let n1 = '';
  if (emaFast > emaSlow)      { s1 += 1; n1 += `EMA${cfg.emaFast} > EMA${cfg.emaSlow} (alcista)`; }
  else if (emaFast < emaSlow) { s1 -= 1; n1 += `EMA${cfg.emaFast} < EMA${cfg.emaSlow} (bajista)`; }
  if (cfg.emaMajor && !isNaN(emaMajorVal)) {
    if (curr.close > emaMajorVal)      { s1 += 1; n1 += ` | Sobre EMA${cfg.emaMajor}`; }
    else                               { s1 -= 1; n1 += ` | Bajo EMA${cfg.emaMajor}`; }
  }

  // ── RSI ───────────────────────────────────────────────────────────
  const rsiSeriesFull = calculateRSISeries(closes, cfg.rsiPeriod);
  const rsi = rsiSeriesFull[rsiSeriesFull.length - 1];
  const rsiSlope = calculateRSISlope(rsiSeriesFull, rsiSeriesFull.length - 1, 3);
  const rsiRising = rsiSlope > 0;
  const rsiFalling = rsiSlope < 0;

  // Layer 2 — RSI (con pendiente)
  let s2 = 0; let n2 = `RSI(${cfg.rsiPeriod}): ${isNaN(rsi) ? '-' : rsi.toFixed(1)}`;
  if      (isNaN(rsi))                { n2 += ' | Datos insuficientes'; }
  else if (rsi < cfg.rsiOversold)     { s2 += 1; n2 += ` | Sobreventa (<${cfg.rsiOversold})`; }
  else if (rsi > cfg.rsiOverbought)   { s2 -= 1; n2 += ` | Sobrecompra (>${cfg.rsiOverbought})`; }
  else if (rsi > 50) {
    if (rsiFalling) { s2 += 0; n2 += ' | Sobre 50 ▼ (desacelerando)'; }
    else            { s2 += 1; n2 += rsiRising ? ' | Sobre 50 ▲ (momentum +)' : ' | Sobre 50 (momentum +)'; }
  } else {
    if (rsiRising) { s2 += 0; n2 += ' | Bajo 50 ▲ (recuperando)'; }
    else           { s2 -= 1; n2 += rsiFalling ? ' | Bajo 50 ▼ (momentum -)' : ' | Bajo 50 (momentum -)'; }
  }

  // ── Bollinger Bands %B ────────────────────────────────────────────
  const bbResult = calculateBollingerBands(closes, cfg.bbPeriod);
  const bandWidth = bbResult.upper - bbResult.lower;
  const pctB = bandWidth > 0 ? (curr.close - bbResult.lower) / bandWidth : 0.5;

  // Layer 3 — Bollinger %B & Squeeze
  const bbMiddle = (bbResult.upper + bbResult.lower) / 2;
  const bbWidthRatio = bbMiddle > 0 ? bandWidth / bbMiddle : 0;
  let s3 = 0; let n3 = `%B: ${pctB.toFixed(2)}`;
  if      (curr.close <= bbResult.lower)  { s3 += 1; n3 += ' | En/bajo banda inf. (rebote)'; }
  else if (curr.close >= bbResult.upper)  { s3 -= 1; n3 += ' | En/sobre banda sup. (rechazo)'; }
  else if (pctB < 0.2)                    { s3 += 1; n3 += ' | Cerca banda inf.'; }
  else if (pctB > 0.8)                    { s3 -= 1; n3 += ' | Cerca banda sup.'; }
  else                                    { n3 += ' | Dentro de bandas'; }
  if (bbWidthRatio < 0.05) { n3 += ' | Squeeze (alta compresión)'; }

  // ── Volumen: VWAP o OBV ───────────────────────────────────────────
  let s4 = 0; let n4 = '';

  if (cfg.useVwap) {
    const vwap = calculateVWAP(klines, interval);
    const atr = calculateATR(klines, 14);
    const isChasing = atr > 0 && Math.abs(curr.close - vwap) > 2.0 * atr;
    if (isChasing) {
      s4 -= 1;
      n4 = `VWAP: ${formatSmartNumber(vwap)} | Chasing (>2 ATR de VWAP)`;
    } else {
      if (curr.close > vwap) { s4 += 1; n4 = `VWAP: ${formatSmartNumber(vwap)} | Precio sobre VWAP (compradores)`; }
      else                   { s4 -= 1; n4 = `VWAP: ${formatSmartNumber(vwap)} | Precio bajo VWAP (vendedores)`; }
    }
  } else if (cfg.useObv) {
    const obvArr    = calculateOBV(klines);
    const obvEMAArr = calculateEMA(obvArr, 10);
    const obvLast   = obvArr[obvArr.length - 1];
    const obvEMA    = obvEMAArr[obvEMAArr.length - 1];
    if (obvLast > obvEMA) { s4 += 1; n4 = 'OBV > OBV_EMA10 (acumulación)'; }
    else                  { s4 -= 1; n4 = 'OBV < OBV_EMA10 (distribución)'; }
  } else {
    n4 = 'Indicador de volumen no disponible';
  }

  // Layer 5 — Confirmación de Vela & Ratios de Mecha
  const body      = curr.close - curr.open;
  const range     = curr.high - curr.low;
  const pctBody   = range > 0 ? Math.abs(body) / range : 0;
  const uWick     = upperWickRatio(curr);
  const lWick     = lowerWickRatio(curr);

  let s5 = 0; let n5 = `Cuerpo: ${body >= 0 ? '+' : ''}${formatSmartNumber(body)} (${(pctBody * 100).toFixed(0)}%)`;
  if (pctBody < 0.3) {
    s5 = 0;
    n5 += ' | Doji débil';
  } else {
    if      (body > 0 && pctBody > 0.5) { s5 += 1; n5 += ' | Alcista fuerte'; }
    else if (body > 0)                  { s5 += 1; n5 += ' | Alcista moderada'; }
    else if (body < 0 && pctBody > 0.5) { s5 -= 1; n5 += ' | Bajista fuerte'; }
    else if (body < 0)                  { s5 -= 1; n5 += ' | Bajista moderada'; }
    else                                { n5 += ' | Doji (indecisión)'; }

    if (body > 0 && uWick > 0.25) { s5 -= 0.5; n5 += ' (rechazo sup)'; }
    else if (body < 0 && lWick > 0.25) { s5 += 0.5; n5 += ' (rechazo inf)'; }
  }

  // ── Layer 6 — Estructura (Soportes / Resistencias) ────────────────
  const sr = calculateSupportResistance(klines, curr.close);
  const structureWeight = 1.0;
  let s6 = 0; let n6 = '';

  if (sr.nearestSupport > 0 || sr.nearestResistance > 0) {
    const distSupport = sr.nearestSupport > 0 ? (curr.close - sr.nearestSupport) / curr.close : Infinity;
    const distResist = sr.nearestResistance > 0 ? (sr.nearestResistance - curr.close) / curr.close : Infinity;
    const nearThreshold = 0.015; // within 1.5% = "near"

    if (distSupport >= 0 && distSupport < nearThreshold && distSupport <= distResist) {
      s6 += 1;
      n6 = `Cerca soporte (${formatSmartPrice(sr.nearestSupport)})`;
    } else if (distResist >= 0 && distResist < nearThreshold && distResist < distSupport) {
      s6 -= 1;
      n6 = `Cerca resistencia (${formatSmartPrice(sr.nearestResistance)})`;
    } else {
      n6 = `S: ${sr.nearestSupport > 0 ? formatSmartPrice(sr.nearestSupport) : '-'} | R: ${sr.nearestResistance > 0 ? formatSmartPrice(sr.nearestResistance) : '-'}`;
    }
  } else {
    n6 = 'Sin niveles S/R detectados';
  }

  // Calcular score ponderado
  const w1 = s1 * weights.trend;
  const w2 = s2 * weights.rsi;
  const w3 = s3 * weights.bollinger;
  const w4 = s4 * weights.volume;
  const w5 = s5 * weights.candle;
  const w6 = s6 * structureWeight;

  const totalScore = w1 + w2 + w3 + w4 + w5 + w6;

  // Calcular score máximo teórico para determinar el umbral (50% del máximo)
  const maxTrend = cfg.emaMajor ? 2 : 1;
  const maxPossible = (maxTrend * weights.trend) + weights.rsi + weights.bollinger + weights.volume + weights.candle + structureWeight;
  const threshold = Number((maxPossible * 0.5).toFixed(2));

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if      (totalScore >=  threshold) signal = 'BUY';
  else if (totalScore <= -threshold) signal = 'SELL';

  // R:R validation: degrade signal if insufficient room to nearest S/R
  if (signal !== 'HOLD') {
    const atr = calculateATR(klines, 14);
    if (atr > 0) {
      const slDist = 1.5 * atr;
      if (signal === 'BUY' && sr.nearestResistance > 0) {
        const rewardRoom = sr.nearestResistance - curr.close;
        if (rewardRoom > 0 && rewardRoom < slDist * 1.5) {
          signal = 'HOLD';
          n6 += ` | R:R ${(rewardRoom / slDist).toFixed(1)}:1 insuficiente`;
        }
      } else if (signal === 'SELL' && sr.nearestSupport > 0) {
        const rewardRoom = curr.close - sr.nearestSupport;
        if (rewardRoom > 0 && rewardRoom < slDist * 1.5) {
          signal = 'HOLD';
          n6 += ` | R:R ${(rewardRoom / slDist).toFixed(1)}:1 insuficiente`;
        }
      }
    }
  }

  return {
    signal,
    score: Number(totalScore.toFixed(2)),
    threshold,
    layers: {
      trend:    { score: s1, weightedScore: w1, note: n1 || 'EMAs neutras' },
      rsi:      { score: s2, weightedScore: w2, note: n2 },
      bollinger:{ score: s3, weightedScore: w3, note: n3 },
      volume:   { score: s4, weightedScore: w4, note: n4 },
      candle:   { score: s5, weightedScore: w5, note: n5 },
      structure:{ score: s6, weightedScore: w6, note: n6 },
    }
  };
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

  // 3. Support / Resistance
  const sr = calculateSupportResistance(klines5m, curr5m.close);

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
}

export function calculateStandardVoting(klines: Kline[]): StandardVotingResult {
  const fallbackResult: StandardVotingResult = { indicators: [], buyVotes: 0, sellVotes: 0, rawSignal: 'NEUTRAL' };
  if (!klines || klines.length < 35) {
    return fallbackResult;
  }

  const closes = klines.map(k => k.close);

  const rsi        = calculateRSI(closes);
  const macd       = calculateMACD(closes);
  const bb         = calculateBollingerBands(closes);
  const supertrend = calculateSupertrend(klines);
  const stochRsi   = calculateStochRSI(closes);
  const vol        = calculateVolumeSignal(klines);

  // RSI Slope visual indicator
  const rsiSeriesForSlope = calculateRSISeries(closes, 14);
  const slopeDir = calculateRSISlope(rsiSeriesForSlope, rsiSeriesForSlope.length - 1, 3);
  const slopeArrow = slopeDir > 0 ? ' ▲' : slopeDir < 0 ? ' ▼' : '';

  const colorFor = (sig: string) =>
    sig === 'BUY' ? 'var(--accent-green)' : sig === 'SELL' ? 'var(--accent-red)' : 'var(--text-primary)';

  const indicators = [
    { name: 'RSI (14)',           value: `${rsi.value}${slopeArrow}`,                                                                         signal: rsi.signal,        color: colorFor(rsi.signal) },
    { name: 'MACD (12,26,9)',     value: macd.value,                                                                                          signal: macd.signal,       color: colorFor(macd.signal) },
    { name: 'Bollinger Bands',    value: bb.current.toFixed(2),                                                                               signal: bb.signal,         color: colorFor(bb.signal) },
    { name: 'Supertrend (10,3)',  value: `ST: $${supertrend.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${supertrend.direction})`, signal: supertrend.signal, color: colorFor(supertrend.signal) },
    { name: 'Stochastic RSI',     value: `%K: ${stochRsi.k.toFixed(1)} · %D: ${stochRsi.d.toFixed(1)}`,                                      signal: stochRsi.signal,   color: colorFor(stochRsi.signal) },
    { name: 'Volume',             value: vol.value,                                                                                           signal: vol.signal,        color: colorFor(vol.signal) },
  ];

  let buyVotes = 0;
  let sellVotes = 0;
  indicators.forEach(ind => {
    if (ind.signal === 'BUY') buyVotes++;
    if (ind.signal === 'SELL') sellVotes++;
  });

  let rawSignal = 'NEUTRAL';
  if (buyVotes >= 3 && sellVotes === 0) {
    rawSignal = 'STRONG BUY';
  } else if (buyVotes > sellVotes) {
    rawSignal = 'BUY';
  } else if (sellVotes >= 3 && buyVotes === 0) {
    rawSignal = 'STRONG SELL';
  } else if (sellVotes > buyVotes) {
    rawSignal = 'SELL';
  }

  // Relative volume confirmation filter
  // BUYs require RVOL >= 1.2 (breakouts need volume confirmation)
  // SELLs require RVOL >= 0.8 (breakdowns can occur on lower volume / distribution)
  const lastCandle = klines[klines.length - 1];
  const lastVol = lastCandle ? lastCandle.volume : 0;
  const recentVols = klines.slice(Math.max(0, klines.length - 21), klines.length - 1).map(k => k ? k.volume : 0);
  const avgVol = recentVols.reduce((a, b) => a + b, 0) / Math.max(1, recentVols.length);
  const rvol = avgVol > 0 ? lastVol / avgVol : 0;

  const rvolThreshold = rawSignal.includes('BUY') ? 0.9 : 0.6;
  // Weak consensus (margin < 2 votes) requires slightly higher volume confirmation
  const voteMargin = Math.abs(buyVotes - sellVotes);
  const effectiveRvolThreshold = voteMargin < 2 ? Math.max(rvolThreshold, 1.1) : rvolThreshold;

  if (rawSignal !== 'NEUTRAL' && rvol < effectiveRvolThreshold) {
    rawSignal = 'NEUTRAL';
  }

  // Candle anatomy check (closePosition)
  const cp = closePosition(lastCandle);
  if (rawSignal.includes('BUY') && cp < 0.45) {
    rawSignal = 'NEUTRAL';
  } else if (rawSignal.includes('SELL') && cp > 0.55) {
    rawSignal = 'NEUTRAL';
  }

  return { indicators, buyVotes, sellVotes, rawSignal };
}

// ==========================================
// OPTIMIZED SERIES-BASED INDICATORS
// ==========================================

export function calculateATRSeries(klines: Kline[], period: number = 14): number[] {
  const length = klines.length;
  const atrSeries: number[] = new Array(length).fill(0);
  if (length < period + 1) return atrSeries;

  const trueRanges: number[] = [0]; // Index 0 has TR=0 or high-low. Let's align with calculateATR
  for (let i = 1; i < length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;

    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }

  // Wilder's Smoothing (RMA)
  let atr = trueRanges.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  atrSeries[period] = atr;

  for (let i = period + 1; i < length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrSeries[i] = atr;
  }

  // Fill initial values with the first ATR value to avoid NaN/0 problems in calculations
  for (let i = 0; i < period; i++) {
    atrSeries[i] = atrSeries[period];
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

/** Fast integer check for NYSE opening window (9:30 AM to 9:45 AM Eastern Time) without Intl or Date allocations.
 * Kline timestamps are Unix seconds. */
export function isNyseOpeningWindow(timeSeconds: number, symbol?: string): boolean {
  const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : false;
  if (isCrypto) return false;

  const secOfDay = ((timeSeconds % 86400) + 86400) % 86400;
  // EDT (13:30-13:45 UTC = 48600-49500) OR EST (14:30-14:45 UTC = 52200-53100)
  return (secOfDay >= 48600 && secOfDay < 49500) || (secOfDay >= 52200 && secOfDay < 53100);
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

export function calculateVCMESniperSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  _recentWinRate?: number,
  _recentProfitFactor?: number,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo',
  executionPrice?: number
): VCMESniperResult {
  const fallback: VCMESniperResult = {
    signal: 'NEUTRAL', mode: 'NONE', tradeType: 'DAY',
    stopLoss: 0, takeProfit1: 0, takeProfit2: 0, takeProfit3: 0, riskRewardRatio: 0,
    chandelierExit: 0, positionSizeUnits: 0, riskAmount: 100, confidenceScore: 0,
    bias1D: 'NEUTRAL', adx1H: 0, momentum1H: 'NEUTRAL',
    triggerDetail: 'Datos insuficientes',
    rsi1H: 50, macdHistDirection: 'PLANO',
    ema200_1D: 0, ema50_1H: 0, vwap5m: 0, bbUpper5m: 0, bbLower5m: 0,
    isTrendUp: false, nearestSupport: 0, nearestResistance: 0,
    score: 0, baseScore: 0, adaptiveFactor: 1.0,
    marketRegime: 'Normal', volatilityProfile: 'Normal', recentPerfLabel: 'Sin datos',
    atrPercent: 0, avgDailyRange: 0,
    confidence: 'DESCARTAR'
  };

  if (!klines5m || klines5m.length < 30) return fallback;
  if (!klines1h || klines1h.length < 60) return fallback;
  if (!klines1d || klines1d.length < 30) return fallback;

  const curr5m = klines5m[klines5m.length - 1];
  const prev5m = klines5m[klines5m.length - 2];
  const lastIdx = klines5m.length - 1;

  // ═══════════════════════════════════════════════════════════
  // 1. TIPO DE ACTIVO Y VOLATILIDAD DIARIA (1D Bias - VCME v2.0)
  // ═══════════════════════════════════════════════════════════
  const closes1d = klines1d.map(k => k.close);
  const ema200_1d = closes1d.length >= 200 ? calculateEMA(closes1d, 200) : new Array(closes1d.length).fill(NaN);
  const ema50_1d = closes1d.length >= 50 ? calculateEMA(closes1d, 50) : new Array(closes1d.length).fill(NaN);

  const lastEma200_1d = ema200_1d[ema200_1d.length - 1];
  const lastEma50_1d = ema50_1d[ema50_1d.length - 1];
  const lastClose1d = closes1d[closes1d.length - 1];

  const adxData1d = calculateADXSeries(klines1d, 14);
  const lastAdx1d = adxData1d.adx[adxData1d.adx.length - 1];
  const lastPlusDI1d = adxData1d.plusDI[adxData1d.plusDI.length - 1];
  const lastMinusDI1d = adxData1d.minusDI[adxData1d.minusDI.length - 1];

  let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
  const hasDailyTrend = !isNaN(lastEma200_1d) && !isNaN(lastEma50_1d) && !isNaN(lastAdx1d);
  const bias_long = hasDailyTrend && lastClose1d > lastEma200_1d && lastEma50_1d > lastEma200_1d && lastAdx1d > 20 && lastPlusDI1d > lastMinusDI1d;
  const bias_short = hasDailyTrend && lastClose1d < lastEma200_1d && lastEma50_1d < lastEma200_1d && lastAdx1d > 20 && lastMinusDI1d > lastPlusDI1d;

  if (bias_long) bias1D = 'ALCISTA';
  else if (bias_short) bias1D = 'BAJISTA';

  // Rango diario promedio (últimas 20 velas)
  const last20Ranges = klines1d.slice(-20).map(k => k.close > 0 ? (k.high - k.low) / k.close * 100 : 0);
  const avgDailyRange = last20Ranges.reduce((a, b) => a + b, 0) / Math.max(1, last20Ranges.length);

  // ═══════════════════════════════════════════════════════════
  // 2. FILTROS Y SETUP DE 1H (VCME v2.0 Context & Regime)
  // ═══════════════════════════════════════════════════════════
  const closes1h = klines1h.map(k => k.close);
  const ema200_1h = closes1h.length >= 200 ? calculateEMA(closes1h, 200) : new Array(closes1h.length).fill(NaN);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema20_1h = calculateEMA(closes1h, 20);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
  const adxSeries1h = calculateADXSeries(klines1h, 14);
  const macdData1h = calculateMACDSeries(closes1h);
  const atrSeries1h = calculateATRSeries(klines1h, 14);
  const vwapSeries1h = calculateVWAPSeries(klines1h, '1h', symbol);
  const chandelierData = calculateChandelierExit(klines1h, 22, 3.0);

  // Find latest closed 1H candle before current trigger timeframe candle
  let idx1h = -1;
  for (let h = klines1h.length - 1; h >= 0; h--) {
    const endTime1h = klines1h[h].time + 3600;
    if (endTime1h <= curr5m.time) {
      idx1h = h;
      break;
    }
  }

  if (idx1h < 50) {
    return { ...fallback, bias1D, ema200_1D: lastEma200_1d, triggerDetail: 'Datos 1H insuficientes' };
  }

  const close1h = closes1h[idx1h];
  const ema50Val1h = ema50_1h[idx1h];
  const ema20Val1h = ema20_1h[idx1h];
  const rsiVal1h = rsiSeries1h[idx1h];
  const adxVal1h = adxSeries1h.adx[idx1h];
  const atrVal1h = atrSeries1h[idx1h];
  const vwapVal1h = vwapSeries1h[idx1h];
  const macdHist1h = macdData1h.histogram[idx1h];
  const macdHistPrev1h = idx1h > 0 ? macdData1h.histogram[idx1h - 1] : NaN;

  // Volatility average for regime
  const atrSma1hArr = new Array(klines1h.length).fill(0);
  let atr1hSum = 0;
  for (let idx = 0; idx < Math.min(50, atrSeries1h.length); idx++) {
    atr1hSum += isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx];
  }
  if (atrSeries1h.length >= 50) atrSma1hArr[49] = atr1hSum / 50;
  for (let idx = 50; idx < atrSeries1h.length; idx++) {
    atr1hSum = atr1hSum - (isNaN(atrSeries1h[idx - 50]) ? 0 : atrSeries1h[idx - 50]) + (isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx]);
    atrSma1hArr[idx] = atr1hSum / 50;
  }
  const atrSma1h = atrSma1hArr[idx1h] || 1;

  // Evaluate if 1H Setup is armed within the 3-hour window with local regime evaluation (1:1 with backtester.ts)
  const isSetupLongCandle = (hIdx: number) => {
    const hist = macdData1h.histogram[hIdx];
    const prevHist = macdData1h.histogram[hIdx - 1];
    const ema200Val = !isNaN(ema200_1h[hIdx]) ? ema200_1h[hIdx] : ema50_1h[hIdx];
    const ema200Prev5 = hIdx >= 5 ? (!isNaN(ema200_1h[hIdx - 5]) ? ema200_1h[hIdx - 5] : ema50_1h[hIdx - 5]) : ema200Val;
    const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
    const adxVal = adxSeries1h.adx[hIdx];
    const regimeOkLong = adxVal > 20 && slope > 0;

    return (
      regimeOkLong &&
      closes1h[hIdx] > vwapSeries1h[hIdx] &&
      ema20_1h[hIdx] > ema50_1h[hIdx] &&
      rsiSeries1h[hIdx] >= 50 && rsiSeries1h[hIdx] <= 70 &&
      hist > 0 &&
      hist > prevHist
    );
  };

  const isSetupShortCandle = (hIdx: number) => {
    const hist = macdData1h.histogram[hIdx];
    const prevHist = macdData1h.histogram[hIdx - 1];
    const ema200Val = !isNaN(ema200_1h[hIdx]) ? ema200_1h[hIdx] : ema50_1h[hIdx];
    const ema200Prev5 = hIdx >= 5 ? (!isNaN(ema200_1h[hIdx - 5]) ? ema200_1h[hIdx - 5] : ema50_1h[hIdx - 5]) : ema200Val;
    const slope = (!isNaN(ema200Prev5) && ema200Prev5 > 0) ? (ema200Val - ema200Prev5) / ema200Prev5 : 0;
    const adxVal = adxSeries1h.adx[hIdx];
    const regimeOkShort = adxVal > 20 && slope < 0;

    return (
      regimeOkShort &&
      closes1h[hIdx] < vwapSeries1h[hIdx] &&
      ema20_1h[hIdx] < ema50_1h[hIdx] &&
      rsiSeries1h[hIdx] >= 30 && rsiSeries1h[hIdx] <= 50 &&
      hist < 0 &&
      hist < prevHist
    );
  };

  const isInvalidatedLong = (hIdx: number) => {
    return closes1h[hIdx] < vwapSeries1h[hIdx] || ema20_1h[hIdx] < ema50_1h[hIdx];
  };

  const isInvalidatedShort = (hIdx: number) => {
    return closes1h[hIdx] > vwapSeries1h[hIdx] || ema20_1h[hIdx] > ema50_1h[hIdx];
  };

  let setupArmedLong = false;
  for (let offset = 0; offset < 3; offset++) {
    const hIdx = idx1h - offset;
    if (hIdx < 1) break;
    if (isInvalidatedLong(hIdx)) continue;
    if (isSetupLongCandle(hIdx)) {
      setupArmedLong = true;
      break;
    }
  }

  let setupArmedShort = false;
  for (let offset = 0; offset < 3; offset++) {
    const hIdx = idx1h - offset;
    if (hIdx < 1) break;
    if (isInvalidatedShort(hIdx)) continue;
    if (isSetupShortCandle(hIdx)) {
      setupArmedShort = true;
      break;
    }
  }

  let momentum1H: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
  if (setupArmedLong) momentum1H = 'ALCISTA';
  else if (setupArmedShort) momentum1H = 'BAJISTA';

  // ═══════════════════════════════════════════════════════════
  // 3. INDICADORES DE GATILLO (5m) Y PREPARACIÓN
  // ═══════════════════════════════════════════════════════════
  const closes5m = klines5m.map(k => k.close);
  const bbSeries5m = calculateBollingerBandsSeries(klines5m, 20, 2);
  const ema9_5m = calculateEMA(closes5m, 9);
  const ema21_5m = calculateEMA(closes5m, 21);
  const vwapSeries5m = calculateVWAPSeries(klines5m, style === 'swing' ? '1h' : '5m', symbol);
  const rsiSeries5m = calculateRSISeries(closes5m, 14);
  const atrSeries5m = calculateATRSeries(klines5m, 14);

  const vol5m = klines5m.map(k => k.volume);
  const volSma5m: number[] = new Array(klines5m.length).fill(0);
  let volSum5m = 0;
  for (let i = 0; i < Math.min(20, vol5m.length); i++) volSum5m += vol5m[i];
  for (let i = 20; i < vol5m.length; i++) {
    volSma5m[i] = volSum5m / 20; // Trailing 20 bars (i-20 to i-1), strictly excluding candle i
    volSum5m = volSum5m - vol5m[i - 20] + vol5m[i]; // Update sum including candle i for the next index
  }

  const bbIdx = lastIdx - 19;
  const bb = bbIdx >= 0 && bbIdx < bbSeries5m.length ? bbSeries5m[bbIdx] : null;
  const vwap5m = vwapSeries5m[lastIdx];
  const ema9Val = ema9_5m[lastIdx];
  const ema21Val = ema21_5m[lastIdx];
  const rsi5m = rsiSeries5m[lastIdx];
  const atr5m = atrSeries5m[lastIdx];
  const volCurr5m = vol5m[lastIdx];
  
  const volAvg5m = volSma5m[lastIdx] > 0 ? volSma5m[lastIdx] : calculateRollingVolumeAvg(klines5m, lastIdx, 20);
  const rvol = volAvg5m > 0 ? volCurr5m / volAvg5m : 1.0;

  if (!bb || isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema21Val) || isNaN(rsi5m) || isNaN(atr5m)) {
    return { ...fallback, bias1D, momentum1H, triggerDetail: 'Indicadores de gatillo no calculables' };
  }

  const bbWidth5m = bbSeries5m.map(b => b.middle > 0 ? (b.upper - b.lower) / b.middle * 100 : 0);
  const last100Widths = bbWidth5m.slice(-100).filter(v => !isNaN(v)).sort((a, b) => a - b);
  const p20BBWidth = last100Widths.length > 0 ? last100Widths[Math.floor(last100Widths.length * 0.2)] : 0;
  const last20Widths = bbWidth5m.slice(-20);
  const squeezePrev = last20Widths.some(w => w < p20BBWidth);

  let macdHistDir: 'CRECIENTE' | 'DECRECIENTE' | 'PLANO' = 'PLANO';
  if (!isNaN(macdHist1h) && !isNaN(macdHistPrev1h)) {
    if (macdHist1h > macdHistPrev1h) macdHistDir = 'CRECIENTE';
    else if (macdHist1h < macdHistPrev1h) macdHistDir = 'DECRECIENTE';
  }

  // ═══════════════════════════════════════════════════════════
  // 4. ESTRATEGIAS DE DISPARO Y GATILLO (Asimétrico LONG vs SHORT)
  // ═══════════════════════════════════════════════════════════
  
  const checkBreakoutAtIdx = (idx: number, dir: 'LONG' | 'SHORT') => {
    if (idx < 20 || idx >= klines5m.length) return false;
    const k = klines5m[idx];
    const prevK = klines5m[idx - 1];
    const b = bbSeries5m[idx - 19];
    const prevB = bbSeries5m[idx - 20];
    const rsi = rsiSeries5m[idx];
    const vw = vwapSeries5m[idx];
    const rvolLocal = (volSma5m[idx] && volSma5m[idx] > 0) ? k.volume / volSma5m[idx] : 1.0;

    if (!b || !prevB || isNaN(rsi) || isNaN(vw)) return false;

    if (dir === 'LONG') {
      const gateVWAP = k.close > vw;
      const gateBreakout = k.close > b.upper && prevK.close <= prevB.upper;
      const gateVol = rvolLocal >= 1.5;
      const gateRSI = rsi > 50 && rsi < 75;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    } else {
      const gateVWAP = k.close < vw;
      const gateBreakout = k.close < b.lower && prevK.close >= prevB.lower;
      const gateVol = rvolLocal >= 1.8; // VCME v2.0 Asymmetry: 1.8x for SHORT
      const gateRSI = rsi < 50 && rsi > 25;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    }
  };

  // A. PULLBACK GATILLO (Agresivo)
  const hasPullbackLong = (idx: number) => {
    if (idx < 10) return false;
    const low = klines5m[idx].low;
    const e9 = ema9_5m[idx];
    const e21 = ema21_5m[idx];
    const vw = vwapSeries5m[idx];
    let swingLow10 = Infinity;
    for (let s = idx - 10; s < idx; s++) {
      if (klines5m[s].low < swingLow10) swingLow10 = klines5m[s].low;
    }
    return low <= Math.max(e9, e21, vw) && low > swingLow10;
  };

  const hasPullbackShort = (idx: number) => {
    if (idx < 10) return false;
    const high = klines5m[idx].high;
    const e9 = ema9_5m[idx];
    const e21 = ema21_5m[idx];
    const vw = vwapSeries5m[idx];
    let swingHigh10 = -Infinity;
    for (let s = idx - 10; s < idx; s++) {
      if (klines5m[s].high > swingHigh10) swingHigh10 = klines5m[s].high;
    }
    return high >= Math.min(e9, e21, vw) && high < swingHigh10;
  };

  const maxPrevHigh3 = Math.max(klines5m[lastIdx - 1].high, klines5m[lastIdx - 2].high, klines5m[lastIdx - 3].high);
  const condPullbackLong = triggerMode === 'agresivo' &&
                           (hasPullbackLong(lastIdx) || hasPullbackLong(lastIdx - 1) || hasPullbackLong(lastIdx - 2)) &&
                           curr5m.close > maxPrevHigh3 &&
                           curr5m.close > curr5m.open &&
                           rvol >= 1.5 &&
                           curr5m.close > vwap5m;

  const minPrevLow3 = Math.min(klines5m[lastIdx - 1].low, klines5m[lastIdx - 2].low, klines5m[lastIdx - 3].low);
  const condPullbackShort = triggerMode === 'agresivo' &&
                            (hasPullbackShort(lastIdx) || hasPullbackShort(lastIdx - 1) || hasPullbackShort(lastIdx - 2)) &&
                            curr5m.close < minPrevLow3 &&
                            curr5m.close < curr5m.open &&
                            rvol >= 1.8 && // VCME v2.0 Asymmetry: 1.8x volume for SHORT
                            curr5m.close < vwap5m;

  // B. BREAKOUT GATILLO
  let condBreakoutLong = false;
  let condBreakoutShort = false;

  if (triggerMode === 'conservador') {
    let recentBreakoutIdx = -1;
    for (let offset = 1; offset <= 5; offset++) {
      const idx = lastIdx - offset;
      if (checkBreakoutAtIdx(idx, 'LONG')) {
        recentBreakoutIdx = idx;
        break;
      }
    }

    if (recentBreakoutIdx !== -1) {
      const breakoutBB = bbSeries5m[recentBreakoutIdx - 19];
      if (breakoutBB) {
        const level = breakoutBB.upper;
        const retestSostenido = curr5m.low >= level * 0.998 && curr5m.close > level;
        if (retestSostenido) condBreakoutLong = true;
      }
    }

    let recentBreakdownIdx = -1;
    for (let offset = 1; offset <= 5; offset++) {
      const idx = lastIdx - offset;
      if (checkBreakoutAtIdx(idx, 'SHORT')) {
        recentBreakdownIdx = idx;
        break;
      }
    }

    if (recentBreakdownIdx !== -1) {
      const breakdownBB = bbSeries5m[recentBreakdownIdx - 19];
      if (breakdownBB) {
        const level = breakdownBB.lower;
        const retestSostenido = curr5m.high <= level * 1.002 && curr5m.close < level;
        if (retestSostenido) condBreakoutShort = true;
      }
    }
  } else {
    const orb = getOpeningRange(klines5m, lastIdx, style === 'swing' ? '1h' : '5m', symbol);
    const prevOrb = getOpeningRange(klines5m, lastIdx - 1, style === 'swing' ? '1h' : '5m', symbol);

    const rvolBreakoutLong = (volSma5m[lastIdx - 1] && volSma5m[lastIdx - 1] > 0) ? vol5m[lastIdx - 1] / volSma5m[lastIdx - 1] : 1.0;
    const breakoutLongPrev = prevOrb.isActive &&
                             prev5m.close > prevOrb.high + 0.10 * atrSeries5m[lastIdx - 1] &&
                             bbIdx > 0 && prev5m.close > bbSeries5m[bbIdx - 1].upper &&
                             rvolBreakoutLong >= 1.5 &&
                             (prev5m.close - bbSeries5m[bbIdx - 1].upper) <= 1.0 * atrSeries5m[lastIdx - 1];

    condBreakoutLong = squeezePrev && breakoutLongPrev && curr5m.close > orb.high;

    const rvolBreakoutShort = (volSma5m[lastIdx - 1] && volSma5m[lastIdx - 1] > 0) ? vol5m[lastIdx - 1] / volSma5m[lastIdx - 1] : 1.0;
    const breakoutShortPrev = prevOrb.isActive &&
                              prev5m.close < prevOrb.low - 0.10 * atrSeries5m[lastIdx - 1] &&
                              bbIdx > 0 && prev5m.close < bbSeries5m[bbIdx - 1].lower &&
                              rvolBreakoutShort >= 1.8 && // VCME v2.0 Asymmetry: 1.8x
                              (bbSeries5m[bbIdx - 1].lower - prev5m.close) <= 1.0 * atrSeries5m[lastIdx - 1];

    condBreakoutShort = squeezePrev && breakoutShortPrev && curr5m.close < orb.low;
  }

  // C. MEAN REVERSION
  const condMRLong = bias1D === 'NEUTRAL' &&
                     curr5m.close < bb.lower &&
                     rsi5m < 25 &&
                     checkBullishDivergence(klines5m, rsiSeries5m, lastIdx, 10) &&
                     curr5m.close > curr5m.open;

  const condMRShort = bias1D === 'NEUTRAL' &&
                      curr5m.close > bb.upper &&
                      rsi5m > 75 &&
                      checkBearishDivergence(klines5m, rsiSeries5m, lastIdx, 10) &&
                      curr5m.close < curr5m.open;

  // ═══════════════════════════════════════════════════════════
  // 5. FILTROS PREVIOS Y CALIDAD DE VELA (VCME v2.0 Sec 3.5 & Sec 4/5)
  // ═══════════════════════════════════════════════════════════
  const minutesSinceOpen = (() => {
    const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
    if (isCrypto) return 60;
    let sessionStartIdx = lastIdx;
    const expectedStep = style === 'swing' ? 3600 : 300;
    const offset = 18000;
    const curDay = Math.floor((curr5m.time - offset) / 86400);
    while (sessionStartIdx > 0) {
      const prevTime = klines5m[sessionStartIdx - 1].time;
      const gap = klines5m[sessionStartIdx].time - prevTime;
      if (gap > expectedStep * 3 || Math.floor((prevTime - offset) / 86400) !== curDay) {
        break;
      }
      sessionStartIdx--;
    }
    const unitMinutes = style === 'swing' ? 60 : 5;
    return (lastIdx - sessionStartIdx + (style === 'swing' ? 1 : 0)) * unitMinutes;
  })();

  const candleRange = curr5m.high - curr5m.low;
  const strengthCandleLong = candleRange > 0 ? (curr5m.close > curr5m.open) && ((curr5m.close - curr5m.low) > 0.60 * candleRange) : false;
  const strengthCandleShort = candleRange > 0 ? (curr5m.close < curr5m.open) && ((curr5m.high - curr5m.close) > 0.60 * candleRange) : false;

  const qualityLong = (curr5m.close - vwap5m) <= 2.0 * atr5m &&
                      candleBodyRatio(curr5m) >= 0.3 &&
                      strengthCandleLong &&
                      upperWickRatio(curr5m) <= 0.35 &&
                      minutesSinceOpen >= 5 &&
                      rvol < 8.0;

  const qualityShort = (vwap5m - curr5m.close) <= 2.0 * atr5m &&
                       candleBodyRatio(curr5m) >= 0.3 &&
                       strengthCandleShort &&
                       lowerWickRatio(curr5m) <= 0.35 &&
                       minutesSinceOpen >= 5 &&
                       rvol < 8.0;

  // ═══════════════════════════════════════════════════════════
  // 6. CONFIDENCE SCORE FÓRMULA CONTINUA (VCME v2.0 Sec 6: 0.0 a 1.0)
  // ═══════════════════════════════════════════════════════════
  const getContinuousConfidence = (dir: 'LONG' | 'SHORT') => {
    const isLong = dir === 'LONG';
    const volScore = 0.30 * Math.min(rvol / 2.0, 1.0);
    const macroScore = 0.25 * (isLong ? (lastClose1d > lastEma200_1d ? 1 : 0) : (lastClose1d < lastEma200_1d ? 1 : 0));
    const macdScore = 0.20 * (isLong ? (macdHist1h > 0 ? 1 : 0) : (macdHist1h < 0 ? 1 : 0));
    const distScore = 0.15 * Math.min(Math.abs(curr5m.close - ema21Val) / (atr5m || 1), 1.0);
    const vwapScore = 0.10 * (isLong ? (curr5m.close > vwap5m ? 1 : 0) : (curr5m.close < vwap5m ? 1 : 0));
    return Number((volScore + macroScore + macdScore + distScore + vwapScore).toFixed(2));
  };

  const confidenceScoreLong = getContinuousConfidence('LONG');
  const confidenceScoreShort = getContinuousConfidence('SHORT');

  const srLevel = calculateSupportResistance(klines5m, curr5m.close);
  const distSupport = srLevel.nearestSupport > 0 ? (curr5m.close - srLevel.nearestSupport) / curr5m.close : Infinity;
  const distResist = srLevel.nearestResistance > 0 ? (srLevel.nearestResistance - curr5m.close) / curr5m.close : Infinity;

  // Legacy Discrete Score 0-9 for UI compatibility
  const getConfluenceScore = (dir: 'LONG' | 'SHORT') => {
    let pt = 0;
    const isLong = dir === 'LONG';
    if (isLong ? bias1D === 'ALCISTA' : bias1D === 'BAJISTA') pt += 2;
    if (lastAdx1d > 25) pt += 1;
    if (rvol >= 2.0) pt += 2;
    if (isLong ? close1h > vwapVal1h : close1h < vwapVal1h) pt += 1;
    if (isLong ? (macdHist1h > 0 && macdHist1h > macdHistPrev1h) : (macdHist1h < 0 && macdHist1h < macdHistPrev1h)) pt += 1;
    if (squeezePrev) pt += 1;
    if (isLong ? distSupport < 0.005 : distResist < 0.005) pt += 1;

    return pt;
  };

  const scoreLong = getConfluenceScore('LONG');
  const scoreShort = getConfluenceScore('SHORT');

  // ═══════════════════════════════════════════════════════════
  // 7. DETERMINAR SEÑAL FINAL, CLASIFICACIÓN Y SUPRESIÓN
  // ═══════════════════════════════════════════════════════════
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let mode: 'PULLBACK' | 'BREAKOUT' | 'MEAN_REVERSION' | 'NONE' = 'NONE';
  let triggerDetail = 'Sin disparo de gatillo';

  const triggerLong = (setupArmedLong && (condPullbackLong || condBreakoutLong)) && qualityLong;
  const triggerShort = (setupArmedShort && (condPullbackShort || condBreakoutShort)) && qualityShort;

  const triggerMRLong = condMRLong && qualityLong;
  const triggerMRShort = condMRShort && qualityShort;

  if (triggerLong) {
    signal = 'BUY';
    mode = condPullbackLong ? 'PULLBACK' : 'BREAKOUT';
    triggerDetail = condPullbackLong ? 'Gatillo Pullback en 5m (Ruptura micro-máximo)' : 'Gatillo Breakout 5m (Ruptura ORB/Bollinger Squeeze)';
  } else if (triggerShort) {
    signal = 'SELL';
    mode = condPullbackShort ? 'PULLBACK' : 'BREAKOUT';
    triggerDetail = condPullbackShort ? 'Gatillo Pullback en 5m (Ruptura micro-mínimo)' : 'Gatillo Breakdown 5m (Ruptura ORB/Bollinger Squeeze)';
  } else if (triggerMRLong) {
    signal = 'BUY';
    mode = 'MEAN_REVERSION';
    triggerDetail = 'Gatillo Reversión a la Media (Sobreventa extrema BB + Divergencia RSI)';
  } else if (triggerMRShort) {
    signal = 'SELL';
    mode = 'MEAN_REVERSION';
    triggerDetail = 'Gatillo Reversión a la Media (Sobrecompra extrema BB + Divergencia RSI)';
  }

  const confidenceScore = signal === 'BUY' ? confidenceScoreLong : (signal === 'SELL' ? confidenceScoreShort : Math.max(confidenceScoreLong, confidenceScoreShort));
  const baseScore = signal === 'BUY' ? scoreLong : (signal === 'SELL' ? scoreShort : Math.max(scoreLong, scoreShort));
  const finalScorePercent = Math.round(confidenceScore * 100);

  // Suppress signal if confidence score is below 0.65 threshold (VCME v2.0 Sec 6)
  if (signal !== 'NEUTRAL' && confidenceScore < 0.65) {
    signal = 'NEUTRAL';
    mode = 'NONE';
    triggerDetail = `Confidence Score insuficiente: ${(confidenceScore * 100).toFixed(0)}% (requerido >= 65%)`;
  }

  // Clasificación Trade Type (DAY vs SWING - Sec 8.3 sincronizado con backtester.ts)
  let tradeType: 'DAY' | 'SWING' = 'DAY';
  if (lastAdx1d > 30) {
    if ((signal === 'BUY' && macdHist1h > macdHistPrev1h) ||
        (signal === 'SELL' && macdHist1h < macdHistPrev1h)) {
      tradeType = 'SWING';
    }
  }

  let confidence: 'ALTA' | 'MODERADA' | 'DESCARTAR' = 'DESCARTAR';
  if (signal !== 'NEUTRAL') {
    if (confidenceScore >= 0.75) confidence = 'ALTA';
    else if (confidenceScore >= 0.65) confidence = 'MODERADA';
  }

  // ═══════════════════════════════════════════════════════════
  // 8. GESTIÓN DE RIESGO ASIMÉTRICA Y CHANDELIER EXIT (VCME v2.0)
  // ═══════════════════════════════════════════════════════════
  let stopLoss = 0;
  let takeProfit1 = 0;
  let takeProfit2 = 0;
  let takeProfit3 = 0;
  let riskRewardRatio = 0;
  let chandelierExit = 0;

  const entry = (executionPrice && executionPrice > 0) ? executionPrice : curr5m.close;
  
  const lookbackS = Math.max(0, lastIdx - (tradeType === 'SWING' ? 5 : 10));
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (let s = lookbackS; s < lastIdx; s++) {
    if (klines5m[s].low < swingLow) swingLow = klines5m[s].low;
    if (klines5m[s].high > swingHigh) swingHigh = klines5m[s].high;
  }

  // Asymmetric SL multipliers (LONG: 1.5 ATR / SHORT: 1.8 ATR)
  const atrMultLong = 1.5;
  const atrMultShort = 1.8;
  const tp1Mult = 2.0;
  const tp2Mult = 3.5;
  const tp3Mult = 5.0;

  const chandelierLong = chandelierData.long[idx1h];
  const chandelierShort = chandelierData.short[idx1h];

  if (signal === 'BUY') {
    const slATR = entry - atrMultLong * atr5m;
    const slStruct = swingLow > 0 ? (swingLow - 0.20 * atr5m) : slATR;
    stopLoss = Math.min(slATR, slStruct);
    let risk = entry - stopLoss;
    if (risk <= 0) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      confidence = 'DESCARTAR';
      triggerDetail = 'Descartado: Stop loss inválido (riesgo <= 0)';
      stopLoss = 0;
    } else {
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry - minRisk;
        risk = minRisk;
      }

      const riskPercent = entry > 0 ? risk / entry : 0;
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        signal = 'NEUTRAL';
        mode = 'NONE';
        confidence = 'DESCARTAR';
        triggerDetail = `Descartado por riesgo excesivo (${formatSmartNumber(riskPercent * 100)}% vs máx ${formatSmartNumber(maxAllowedRisk * 100)}% o ${formatSmartNumber(risk / (atr5m || 1))} ATR vs máx 1.8 ATR)`;
        stopLoss = 0;
      } else {
        chandelierExit = !isNaN(chandelierLong) ? chandelierLong : (entry - 3.0 * atrVal1h);
        takeProfit1 = entry + tp1Mult * risk;
        takeProfit2 = entry + tp2Mult * risk;
        takeProfit3 = entry + tp3Mult * risk;
        riskRewardRatio = tp1Mult;
      }
    }
  } else if (signal === 'SELL') {
    const slATR = entry + atrMultShort * atr5m;
    const slStruct = swingHigh > 0 ? (swingHigh + 0.20 * atr5m) : slATR;
    stopLoss = Math.max(slATR, slStruct);
    let risk = stopLoss - entry;
    if (risk <= 0) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      confidence = 'DESCARTAR';
      triggerDetail = 'Descartado: Stop loss inválido (riesgo <= 0)';
      stopLoss = 0;
    } else {
      const minRisk = 0.8 * atr5m;
      const maxRisk = 1.8 * atr5m;

      if (risk < minRisk) {
        stopLoss = entry + minRisk;
        risk = minRisk;
      }

      const riskPercent = entry > 0 ? risk / entry : 0;
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        signal = 'NEUTRAL';
        mode = 'NONE';
        confidence = 'DESCARTAR';
        triggerDetail = `Descartado por riesgo excesivo (${formatSmartNumber(riskPercent * 100)}% vs máx ${formatSmartNumber(maxAllowedRisk * 100)}% o ${formatSmartNumber(risk / (atr5m || 1))} ATR vs máx 1.8 ATR)`;
        stopLoss = 0;
      } else {
        chandelierExit = !isNaN(chandelierShort) ? chandelierShort : (entry + 3.0 * atrVal1h);
        takeProfit1 = entry - tp1Mult * risk;
        takeProfit2 = entry - tp2Mult * risk;
        takeProfit3 = entry - tp3Mult * risk;
        riskRewardRatio = tp1Mult;
      }
    }
  }

  // Position sizing (1% risk, max 20% position size limit - Sec 7)
  const accountEquity = 10000;
  const riskAmount = 100; // 1% of 10,000 USD
  const stopDistance = Math.abs(entry - stopLoss);
  let positionSizeUnits = (signal !== 'NEUTRAL' && stopDistance > 0) ? riskAmount / stopDistance : 0;
  const maxUnits = entry > 0 ? (0.20 * accountEquity) / entry : 0;
  positionSizeUnits = Math.min(positionSizeUnits, maxUnits);

  const adaptiveFactor = 1.0;
  const marketRegime = atrVal1h > 1.2 * atrSma1h ? 'Alta Volatilidad' : 'Normal';
  const volatilityProfile = avgDailyRange > 3.5 ? 'Alta Volatilidad' : 'Normal';
  const recentPerfLabel = 'VCME v2.0 Activo';

  const sr = (Math.abs(entry - curr5m.close) < 0.0001) ? srLevel : calculateSupportResistance(klines5m, entry);
  const atrPercent = entry > 0 ? (atr5m / entry * 100) : 0;

  return {
    signal,
    mode,
    tradeType,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    riskRewardRatio,
    chandelierExit,
    positionSizeUnits,
    riskAmount,
    confidenceScore,
    bias1D,
    adx1H: isNaN(adxVal1h) ? 0 : Number(adxVal1h.toFixed(1)),
    momentum1H,
    triggerDetail,
    rsi1H: Number(rsiVal1h.toFixed(1)),
    macdHistDirection: macdHistDir,
    ema200_1D: lastEma200_1d,
    ema50_1H: ema50Val1h,
    vwap5m,
    bbUpper5m: bb.upper,
    bbLower5m: bb.lower,
    isTrendUp: bias1D === 'ALCISTA',
    nearestSupport: sr.nearestSupport,
    nearestResistance: sr.nearestResistance,
    score: finalScorePercent,
    baseScore,
    adaptiveFactor,
    marketRegime,
    volatilityProfile,
    recentPerfLabel,
    atrPercent: Number(atrPercent.toFixed(2)),
    avgDailyRange: Number(avgDailyRange.toFixed(2)),
    confidence,
    snapshot: {
      atr_5m: Number(atr5m.toFixed(2)),
      atr_1H: Number(atrVal1h.toFixed(2)),
      ema21_1H: Number(ema20Val1h.toFixed(2)),
      vwap_5m: Number(vwap5m.toFixed(2)),
      rvol: Number(rvol.toFixed(2))
    }
  };
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
  if (!klines5m || klines5m.length < 20) {
    return {
      signal: 'NEUTRAL',
      strategy: 'NONE',
      stopLoss: 0,
      triggerPrice: 0,
      isCompressed1H: false,
      bias1D: 'NEUTRAL',
      activeVolumePercent5M: 0,
      volumeMultiplier5M: 0,
      andianGreen: 0,
      andianRed: 0,
      andianOrange: 0,
      volatilityWidth1H: 0,
      dreadBlitzMCD: 0,
      isOverbought5M: false,
      isOversold5M: false,
      reasoning: 'Datos insuficientes — se requieren al menos 20 velas de 5m'
    };
  }

  // 1. MACRO FILTER (1D - Andian)
  // Bug #5 fix: if klines1d is insufficient, return NEUTRAL bias instead of
  // falling back to klines5m. 5m candles do not represent daily bull/bear strength.
  let bias1D: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let lastAndian: ReturnType<typeof calculateAndianOscillator>[number] = { green: 0, red: 0, orange: 0, bias: 'NEUTRAL' };
  if (klines1d.length >= 14) {
    const andianSeries = calculateAndianOscillator(klines1d);
    if (andianSeries.length > 0) {
      lastAndian = andianSeries[andianSeries.length - 1];
      bias1D = lastAndian.bias;
    }
  }

  // 2. CONTEXT FILTER (1H - Revolution Volatility Band Squeeze)
  // Bug #6 fix: if klines1h is insufficient, isCompressed1H = false (not a valid
  // squeeze reading). Without Layer 2, only Mean Reversion strategy can fire.
  let isCompressed1H = false;
  let current1HBand = { width: 0, midpoint: 0, upper: 0, lower: 0 };
  if (klines1h.length >= 20) {
    const volBands1H = calculateRevolutionVolatilityBand(klines1h);
    const recent1H = volBands1H.slice(-4);
    isCompressed1H = recent1H.some(b => b.isCompressed);
    if (volBands1H.length > 0) {
      current1HBand = volBands1H[volBands1H.length - 1];
    }
  }

  // 3. TRIGGER CONDITIONS (5M - Volume & Volatility / Dread Blitz)
  const volBands5M = calculateRevolutionVolatilityBand(klines5m);
  const volComp5M = calculateVolumeComposition(klines5m);
  const dreadBlitz5M = calculateDreadBlitz(klines5m);

  const currCandle = klines5m[klines5m.length - 1];
  const currVolComp = volComp5M[volComp5M.length - 1] || { volumeMultiplier: 1, activeBuyPercent: 50, activeSellPercent: 50, isPassiveBuyAbsorption: false, isPassiveSellAbsorption: false };
  const curr5MBand = volBands5M[volBands5M.length - 1] || { upper: currCandle.high, lower: currCandle.low, midpoint: currCandle.close };
  const currDread = dreadBlitz5M[dreadBlitz5M.length - 1] || { isOverbought: false, isOversold: false, mcd: 0 };
  const prevDread = dreadBlitz5M.length > 1 ? dreadBlitz5M[dreadBlitz5M.length - 2] : currDread;
  const prevCandle = klines5m.length > 1 ? klines5m[klines5m.length - 2] : currCandle;

  // The formatter handles EST/EDT automatically and timestamps are Unix seconds.
  const isNyseOpening = isNyseOpeningWindow(currCandle.time, _symbol);
  const minVolMultiplier = isNyseOpening ? 2.5 : 1.5;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let strategy: 'BREAKOUT_EXPANSION' | 'MEAN_REVERSION' | 'NONE' = 'NONE';
  let stopLoss = 0;
  let reasoning = '';

  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN DE VOLATILIDAD (LONG)
  if (
    bias1D === 'BULLISH' &&
    isCompressed1H &&
    currCandle.close > curr5MBand.upper &&
    currVolComp.volumeMultiplier >= minVolMultiplier &&
    currVolComp.activeBuyPercent >= 65
  ) {
    signal = 'BUY';
    strategy = 'BREAKOUT_EXPANSION';
    stopLoss = curr5MBand.midpoint;
    reasoning = `Placing SL at channel midpoint (${formatSmartPrice(stopLoss)}) for institutional breakout expansion hypothesis.`;
  }
  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN DE VOLATILIDAD (SHORT)
  else if (
    bias1D === 'BEARISH' &&
    isCompressed1H &&
    currCandle.close < curr5MBand.lower &&
    currVolComp.volumeMultiplier >= minVolMultiplier &&
    currVolComp.activeSellPercent >= 65
  ) {
    signal = 'SELL';
    strategy = 'BREAKOUT_EXPANSION';
    stopLoss = curr5MBand.midpoint;
    reasoning = `Placing SL at channel midpoint (${formatSmartPrice(stopLoss)}) for institutional breakdown expansion hypothesis.`;
  }
  // ESTRATEGIA 2: REVERSIÓN EXCESIVA A LA MEDIA (LONG)
  else if (
    currDread.isOversold &&
    currCandle.low < prevCandle.low &&
    currDread.mcd > prevDread.mcd && // Bullish Divergence
    currVolComp.isPassiveBuyAbsorption
  ) {
    signal = 'BUY';
    strategy = 'MEAN_REVERSION';
    stopLoss = currCandle.low - (curr5MBand.upper - curr5MBand.lower) * 0.25;
    reasoning = `Placing SL below absorption low (${formatSmartPrice(stopLoss)}) for mean reversion divergence.`;
  }
  // ESTRATEGIA 2: REVERSIÓN EXCESIVA A LA MEDIA (SHORT)
  else if (
    currDread.isOverbought &&
    currCandle.high > prevCandle.high &&
    currDread.mcd < prevDread.mcd && // Bearish Divergence
    currVolComp.isPassiveSellAbsorption
  ) {
    signal = 'SELL';
    strategy = 'MEAN_REVERSION';
    stopLoss = currCandle.high + (curr5MBand.upper - curr5MBand.lower) * 0.25;
    reasoning = `Placing SL above absorption high (${formatSmartPrice(stopLoss)}) for mean reversion divergence.`;
  }

  const activeVolPercent = signal === 'SELL' ? currVolComp.activeSellPercent : currVolComp.activeBuyPercent;

  return {
    signal,
    strategy,
    stopLoss,
    triggerPrice: (executionPrice && executionPrice > 0) ? executionPrice : currCandle.close,
    isCompressed1H,
    bias1D,
    activeVolumePercent5M: activeVolPercent,
    volumeMultiplier5M: currVolComp.volumeMultiplier,
    andianGreen: lastAndian.green,
    andianRed: lastAndian.red,
    andianOrange: lastAndian.orange,
    volatilityWidth1H: current1HBand.width,
    dreadBlitzMCD: currDread.mcd,
    isOverbought5M: currDread.isOverbought,
    isOversold5M: currDread.isOversold,
    reasoning: reasoning || 'Sin señal activa — esperando alineación de compuertas MTF'
  };
}
