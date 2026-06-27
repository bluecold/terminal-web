import type { Kline } from '../services/api';

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

  // Calculate histogram for the last few bars
  const histogramSeries: number[] = [];
  const offsetDiff = validMacd.length - signalLine.length;
  for (let i = 0; i < validMacd.length; i++) {
    const sigIdx = i - offsetDiff;
    if (sigIdx >= 0 && sigIdx < signalLine.length) {
      const macdVal = validMacd[i];
      const sigVal = signalLine[sigIdx];
      if (macdVal !== undefined && sigVal !== undefined && !isNaN(macdVal) && !isNaN(sigVal)) {
        histogramSeries.push(macdVal - sigVal);
      } else {
        histogramSeries.push(0);
      }
    } else {
      histogramSeries.push(0);
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

export function calculateVWAP(klines: Kline[], interval: string = '1h'): number {
  if (!klines || klines.length === 0) return 0;

  let cumVol = 0;
  let cumVolPrice = 0;
  let prevSessionId = '';

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const date = new Date(k.time * 1000);
    let sessionId = '';

    if (interval === '5m' || interval === '1h') {
      // Daily reset: YYYY-MM-DD
      sessionId = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    } else if (interval === '1d') {
      // Weekly reset: ISO Week
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
      sessionId = `${d.getUTCFullYear()}-W${weekNo}`;
    } else {
      sessionId = 'all';
    }

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

  const bullish_candle = hammer || engulfing === 1;
  const bearish_candle = engulfing === -1;

  const is_buy = curr.close > vwap && ema9 > ema20 && curr.volume > volAvg && bullish_candle;
  const is_sell = curr.close < vwap && ema9 < ema20 && (bearish_candle || curr.close < ema20);

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
  const rsiResult = calculateRSI(closes, cfg.rsiPeriod);
  const rsi = rsiResult.value;

  // Layer 2 — RSI
  let s2 = 0; let n2 = `RSI(${cfg.rsiPeriod}): ${rsi.toFixed(1)}`;
  if      (rsi < cfg.rsiOversold)  { s2 += 1; n2 += ` | Sobreventa (<${cfg.rsiOversold})`; }
  else if (rsi > cfg.rsiOverbought){ s2 -= 1; n2 += ` | Sobrecompra (>${cfg.rsiOverbought})`; }
  else if (rsi > 50)               { s2 += 1; n2 += ' | Sobre 50 (momentum +)'; }
  else                             { s2 -= 1; n2 += ' | Bajo 50 (momentum -)'; }

  // ── Bollinger Bands %B ────────────────────────────────────────────
  const bbResult = calculateBollingerBands(closes, cfg.bbPeriod);
  const bandWidth = bbResult.upper - bbResult.lower;
  const pctB = bandWidth > 0 ? (curr.close - bbResult.lower) / bandWidth : 0.5;

  // Layer 3 — Bollinger %B
  let s3 = 0; let n3 = `%B: ${pctB.toFixed(2)}`;
  if      (curr.close <= bbResult.lower)  { s3 += 1; n3 += ' | En/bajo banda inf. (rebote)'; }
  else if (curr.close >= bbResult.upper)  { s3 -= 1; n3 += ' | En/sobre banda sup. (rechazo)'; }
  else if (pctB < 0.2)                    { s3 += 1; n3 += ' | Cerca banda inf.'; }
  else if (pctB > 0.8)                    { s3 -= 1; n3 += ' | Cerca banda sup.'; }
  else                                    { n3 += ' | Dentro de bandas'; }

  // ── Volumen: VWAP o OBV ───────────────────────────────────────────
  let s4 = 0; let n4 = '';

  if (cfg.useVwap) {
    const vwap = calculateVWAP(klines, interval);
    if (curr.close > vwap) { s4 += 1; n4 = `VWAP: ${vwap.toFixed(2)} | Precio sobre VWAP (compradores)`; }
    else                   { s4 -= 1; n4 = `VWAP: ${vwap.toFixed(2)} | Precio bajo VWAP (vendedores)`; }
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

  // Layer 5 — Confirmación de Vela
  const body      = curr.close - curr.open;
  const range     = curr.high - curr.low;
  const pctBody   = range > 0 ? Math.abs(body) / range : 0;
  let s5 = 0; let n5 = `Cuerpo: ${body >= 0 ? '+' : ''}${body.toFixed(2)} (${(pctBody * 100).toFixed(0)}%)`;
  if      (body > 0 && pctBody > 0.5) { s5 += 1; n5 += ' | Alcista fuerte'; }
  else if (body > 0)                  { s5 += 1; n5 += ' | Alcista moderada'; }
  else if (body < 0 && pctBody > 0.5) { s5 -= 1; n5 += ' | Bajista fuerte'; }
  else if (body < 0)                  { s5 -= 1; n5 += ' | Bajista moderada'; }
  else                                { n5 += ' | Doji (indecisión)'; }

  // Calcular score ponderado
  const w1 = s1 * weights.trend;
  const w2 = s2 * weights.rsi;
  const w3 = s3 * weights.bollinger;
  const w4 = s4 * weights.volume;
  const w5 = s5 * weights.candle;

  const totalScore = w1 + w2 + w3 + w4 + w5;

  // Calcular score máximo teórico para determinar el umbral (50% del máximo)
  const maxTrend = cfg.emaMajor ? 2 : 1;
  const maxPossible = (maxTrend * weights.trend) + weights.rsi + weights.bollinger + weights.volume + weights.candle;
  const threshold = Number((maxPossible * 0.5).toFixed(2));

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if      (totalScore >=  threshold) signal = 'BUY';
  else if (totalScore <= -threshold) signal = 'SELL';

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

export function calculateSupertrend(klines: Kline[], period: number = 10, multiplier: number = 3): SupertrendResult {
  if (!klines || klines.length < period + 1) {
    return { value: 0, direction: 'UP', signal: 'NEUTRAL' };
  }

  const length = klines.length;
  
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

  const latestVal = superTrend[length - 1];
  const latestDir = direction[length - 1] === 1 ? 'UP' : 'DOWN';
  const signal: 'BUY' | 'SELL' | 'NEUTRAL' = latestDir === 'UP' ? 'BUY' : 'SELL';

  return {
    value: Number(latestVal.toFixed(2)),
    direction: latestDir,
    signal
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
      if (currK < 20 && prevK <= prevD && currK > currD) {
        signal = 'BUY';
      } else if (currK > 80 && prevK >= prevD && currK < currD) {
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
