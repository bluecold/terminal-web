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
    const date = new Date(k.time * 1000);
    let sessionId = '';

    if (interval === '5m' || interval === '1h') {
      const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
      if (isCrypto) {
        // Daily reset: YYYY-MM-DD
        sessionId = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
      } else {
        // NYSE session: daily reset based on America/New_York local date
        try {
          sessionId = nycFormatter.format(date); // Format: MM/DD/YYYY
        } catch (e) {
          // Fallback to UTC
          sessionId = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
        }
      }
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

  const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > ema9;
  const bullish_candle = hammer || engulfing === 1 || strongBullish;
  const bearish_candle = engulfing === -1;
  const bRatio = candleBodyRatio(curr);

  const is_buy = curr.close > vwap && ema9 > ema20 && curr.volume > volAvg && bullish_candle && bRatio >= 0.4;
  const is_sell = curr.close < vwap && ema9 < ema20 && curr.volume > volAvg && (bearish_candle || curr.close < ema20) && bRatio >= 0.4;

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
    const atr = calculateATR(klines, 14);
    const isChasing = atr > 0 && Math.abs(curr.close - vwap) > 2.0 * atr;
    if (isChasing) {
      s4 -= 1;
      n4 = `VWAP: ${vwap.toFixed(2)} | Chasing (>2 ATR de VWAP)`;
    } else {
      if (curr.close > vwap) { s4 += 1; n4 = `VWAP: ${vwap.toFixed(2)} | Precio sobre VWAP (compradores)`; }
      else                   { s4 -= 1; n4 = `VWAP: ${vwap.toFixed(2)} | Precio bajo VWAP (vendedores)`; }
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

  // Layer 5 — Confirmación de Vela
  const body      = curr.close - curr.open;
  const range     = curr.high - curr.low;
  const pctBody   = range > 0 ? Math.abs(body) / range : 0;
  let s5 = 0; let n5 = `Cuerpo: ${body >= 0 ? '+' : ''}${body.toFixed(2)} (${(pctBody * 100).toFixed(0)}%)`;
  if (pctBody < 0.3) {
    s5 = 0;
    n5 += ' | Doji débil';
  } else {
    if      (body > 0 && pctBody > 0.5) { s5 += 1; n5 += ' | Alcista fuerte'; }
    else if (body > 0)                  { s5 += 1; n5 += ' | Alcista moderada'; }
    else if (body < 0 && pctBody > 0.5) { s5 -= 1; n5 += ' | Bajista fuerte'; }
    else if (body < 0)                  { s5 -= 1; n5 += ' | Bajista moderada'; }
    else                                { n5 += ' | Doji (indecisión)'; }
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
      n6 = `Cerca soporte ($${sr.nearestSupport.toFixed(2)})`;
    } else if (distResist >= 0 && distResist < nearThreshold && distResist < distSupport) {
      s6 -= 1;
      n6 = `Cerca resistencia ($${sr.nearestResistance.toFixed(2)})`;
    } else {
      n6 = `S: $${sr.nearestSupport > 0 ? sr.nearestSupport.toFixed(2) : '-'} | R: $${sr.nearestResistance > 0 ? sr.nearestResistance.toFixed(2) : '-'}`;
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

  let totalScore = w1 + w2 + w3 + w4 + w5 + w6;

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
      value: Number(superTrend[i].toFixed(2)),
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
    stopLoss: Number(stopLoss.toFixed(2)),
    takeProfit: Number(takeProfit.toFixed(2)),
    rsi: isNaN(rsi) ? 50 : rsi,
    rsiSlope: rsiSlopeVal,
    supertrendVal: latestSt.value,
    supertrendDir: latestSt.direction,
    vwap: Number(vwap.toFixed(2)),
    ema200_1h: Number(macroEma200.toFixed(2)),
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

  const rvolThreshold = rawSignal.includes('BUY') ? 1.2 : 0.8;
  // Weak consensus (margin < 2 votes) requires stronger volume confirmation
  const voteMargin = Math.abs(buyVotes - sellVotes);
  const effectiveRvolThreshold = voteMargin < 2 ? Math.max(rvolThreshold, 1.5) : rvolThreshold;

  if (rawSignal !== 'NEUTRAL' && rvol < effectiveRvolThreshold) {
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
    const date = new Date(k.time * 1000);
    let sessionId = '';

    if (interval === '5m' || interval === '1h') {
      const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
      if (isCrypto) {
        sessionId = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
      } else {
        try {
          sessionId = nycFormatter.format(date);
        } catch (e) {
          sessionId = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
        }
      }
    } else if (interval === '1d') {
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
// VCME SNIPER ENGINE — 3-Layer Multi-Temporal Signal
// Replaces the old calculateMultitemporalSignal (Filtro Maestro)
// ==========================================

export interface VCMESniperResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  mode: 'BREAKOUT' | 'REVERSAL' | 'NONE';
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskRewardRatio: number;
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
}

const nycFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function getSessionId(kline: Kline, interval: string, symbol?: string): string {
  const date = new Date(kline.time * 1000);
  if (interval === '5m' || interval === '1h') {
    const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
    if (isCrypto) {
      return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
    } else {
      try {
        return nycFormatter.format(date);
      } catch (e) {
        return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
      }
    }
  } else if (interval === '1d') {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
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

  const currentSession = getSessionId(klines[index], interval, symbol);

  // Find start index of current session
  let sessionStartIdx = index;
  while (sessionStartIdx > 0 && getSessionId(klines[sessionStartIdx - 1], interval, symbol) === currentSession) {
    sessionStartIdx--;
  }

  // We need at least 6 candles in the current session to define the opening range
  const requiredCandles = 6;
  if (index < sessionStartIdx + requiredCandles) {
    return fallback;
  }

  // Calculate high and low of the first 6 candles
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

export function calculateTimeOfDayVolumeAvg(klines: Kline[], index: number, lookbackDays: number = 20): number {
  if (index < 0 || index >= klines.length) return 0;
  const currentKline = klines[index];
  const currentDate = new Date(currentKline.time * 1000);
  const currentHour = currentDate.getUTCHours();
  const currentMinute = currentDate.getUTCMinutes();

  let matchSum = 0;
  let matchCount = 0;

  for (let i = index - 1; i >= 0; i--) {
    const d = new Date(klines[i].time * 1000);
    if (d.getUTCHours() === currentHour && d.getUTCMinutes() === currentMinute) {
      matchSum += klines[i].volume;
      matchCount++;
      if (matchCount >= lookbackDays) {
        break;
      }
    }
  }

  if (matchCount === 0) {
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, index - 20); i < index; i++) {
      sum += klines[i].volume;
      count++;
    }
    return count > 0 ? sum / count : currentKline.volume;
  }

  return matchSum / matchCount;
}

export function calculateVCMESniperSignal(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  recentWinRate?: number,
  recentProfitFactor?: number,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo'
): VCMESniperResult {
  const fallback: VCMESniperResult = {
    signal: 'NEUTRAL', mode: 'NONE',
    stopLoss: 0, takeProfit1: 0, takeProfit2: 0, takeProfit3: 0, riskRewardRatio: 0,
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
  if (!klines1d || klines1d.length < 210) return fallback;

  const curr5m = klines5m[klines5m.length - 1];
  const prev5m = klines5m[klines5m.length - 2];
  const lastIdx = klines5m.length - 1;

  // ═══════════════════════════════════════════════════════════
  // 1. TIPO DE ACTIVO Y VOLATILIDAD DIARIA (1D Bias)
  // ═══════════════════════════════════════════════════════════
  const closes1d = klines1d.map(k => k.close);
  const ema200_1d = calculateEMA(closes1d, 200);
  const ema50_1d = calculateEMA(closes1d, 50);

  const lastEma200_1d = ema200_1d[ema200_1d.length - 1];
  const lastEma50_1d = ema50_1d[ema50_1d.length - 1];
  const lastClose1d = closes1d[closes1d.length - 1];

  const adxData1d = calculateADXSeries(klines1d, 14);
  const lastAdx1d = adxData1d.adx[adxData1d.adx.length - 1];
  const lastPlusDI1d = adxData1d.plusDI[adxData1d.plusDI.length - 1];
  const lastMinusDI1d = adxData1d.minusDI[adxData1d.minusDI.length - 1];

  if (isNaN(lastEma200_1d) || isNaN(lastEma50_1d) || isNaN(lastAdx1d)) {
    return { ...fallback, triggerDetail: 'Datos diarios incompletos' };
  }

  // Rango diario promedio (últimas 20 velas)
  const last20Ranges = klines1d.slice(-20).map(k => k.close > 0 ? (k.high - k.low) / k.close * 100 : 0);
  const avgDailyRange = last20Ranges.reduce((a, b) => a + b, 0) / Math.max(1, last20Ranges.length);

  let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
  // bias_long = (close_1d > ema200_1d and ema50_1d > ema200_1d and adx_1d > 20 and plus_di_1d > minus_di_1d)
  const bias_long = lastClose1d > lastEma200_1d && lastEma50_1d > lastEma200_1d && lastAdx1d > 20 && lastPlusDI1d > lastMinusDI1d;
  const bias_short = lastClose1d < lastEma200_1d && lastEma50_1d < lastEma200_1d && lastAdx1d > 20 && lastMinusDI1d > lastPlusDI1d;

  if (bias_long) bias1D = 'ALCISTA';
  else if (bias_short) bias1D = 'BAJISTA';

  // ═══════════════════════════════════════════════════════════
  // 2. FILTROS Y SETUP DE 1H (Stateless State Machine)
  // ═══════════════════════════════════════════════════════════
  const closes1h = klines1h.map(k => k.close);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema20_1h = calculateEMA(closes1h, 20);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
  const adxSeries1h = calculateADXSeries(klines1h, 14);
  const macdData1h = calculateMACDSeries(closes1h);
  const atrSeries1h = calculateATRSeries(klines1h, 14);
  const vwapSeries1h = calculateVWAPSeries(klines1h, '1h', symbol);

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
    return { ...fallback, bias1D, ema200_1D: Number(lastEma200_1d.toFixed(2)), triggerDetail: 'Datos 1H insuficientes' };
  }

  const close1h = closes1h[idx1h];
  const ema50Val1h = ema50_1h[idx1h];
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

  // Evaluate if 1H Setup is armed within the 3-hour window
  const isSetupLongCandle = (hIdx: number) => {
    const hist = macdData1h.histogram[hIdx];
    const prevHist = macdData1h.histogram[hIdx - 1];
    return (
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
    return (
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
    if (isInvalidatedLong(hIdx)) break;
    if (isSetupLongCandle(hIdx)) {
      setupArmedLong = true;
      break;
    }
  }

  let setupArmedShort = false;
  for (let offset = 0; offset < 3; offset++) {
    const hIdx = idx1h - offset;
    if (hIdx < 1) break;
    if (isInvalidatedShort(hIdx)) break;
    if (isSetupShortCandle(hIdx)) {
      setupArmedShort = true;
      break;
    }
  }

  let momentum1H: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
  if (setupArmedLong) momentum1H = 'ALCISTA';
  else if (setupArmedShort) momentum1H = 'BAJISTA';

  // ═══════════════════════════════════════════════════════════
  // 3. INDICADORES DE GATILLO (5m o 1H para Swing) Y PREPARACIÓN
  // ═══════════════════════════════════════════════════════════
  const closes5m = klines5m.map(k => k.close);
  const bbSeries5m = calculateBollingerBandsSeries(klines5m, 20, 2);
  const ema9_5m = calculateEMA(closes5m, 9);
  const ema21_5m = calculateEMA(closes5m, 21);
  const vwapSeries5m = calculateVWAPSeries(klines5m, style === 'swing' ? '1h' : '5m', symbol);
  const rsiSeries5m = calculateRSISeries(closes5m, 14);
  const atrSeries5m = calculateATRSeries(klines5m, 14);

  // Volume SMA 20 for trigger timeframe
  const vol5m = klines5m.map(k => k.volume);
  const volSma5m: number[] = new Array(klines5m.length).fill(0);
  let volSum5m = 0;
  for (let i = 0; i < Math.min(20, vol5m.length); i++) volSum5m += vol5m[i];
  if (vol5m.length >= 20) volSma5m[19] = volSum5m / 20;
  for (let i = 20; i < vol5m.length; i++) {
    volSum5m = volSum5m - vol5m[i - 20] + vol5m[i];
    volSma5m[i] = volSum5m / 20;
  }

  const bbIdx = lastIdx - 19;
  const bb = bbIdx >= 0 && bbIdx < bbSeries5m.length ? bbSeries5m[bbIdx] : null;
  const vwap5m = vwapSeries5m[lastIdx];
  const ema9Val = ema9_5m[lastIdx];
  const ema21Val = ema21_5m[lastIdx];
  const rsi5m = rsiSeries5m[lastIdx];
  const atr5m = atrSeries5m[lastIdx];
  const volCurr5m = vol5m[lastIdx];
  
  // RVOL Estacional/Horario
  const volAvg5m = calculateTimeOfDayVolumeAvg(klines5m, lastIdx, 20);

  if (!bb || isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema21Val) || isNaN(rsi5m) || isNaN(atr5m)) {
    return { ...fallback, bias1D, momentum1H, triggerDetail: 'Indicadores de gatillo no calculables' };
  }

  // Bollinger Band Width squeeze (20th percentile)
  const bbWidth5m = bbSeries5m.map(b => b.middle > 0 ? (b.upper - b.lower) / b.middle * 100 : 0);
  const last100Widths = bbWidth5m.slice(-100).filter(v => !isNaN(v)).sort((a, b) => a - b);
  const p20BBWidth = last100Widths.length > 0 ? last100Widths[Math.floor(last100Widths.length * 0.2)] : 0;
  const last20Widths = bbWidth5m.slice(-20);
  const squeezePrev = last20Widths.some(w => w < p20BBWidth);

  // MACD Histogram Direction for display
  let macdHistDir: 'CRECIENTE' | 'DECRECIENTE' | 'PLANO' = 'PLANO';
  if (!isNaN(macdHist1h) && !isNaN(macdHistPrev1h)) {
    if (macdHist1h > macdHistPrev1h) macdHistDir = 'CRECIENTE';
    else if (macdHist1h < macdHistPrev1h) macdHistDir = 'DECRECIENTE';
  }

  // ═══════════════════════════════════════════════════════════
  // 4. ESTRATEGIAS DE DISPARO Y GATILLO
  // ═══════════════════════════════════════════════════════════
  
  // Helper to check for a breakout at any historical index (used for retest validation)
  const checkBreakoutAtIdx = (idx: number, dir: 'LONG' | 'SHORT') => {
    if (idx < 20 || idx >= klines5m.length) return false;
    const k = klines5m[idx];
    const prevK = klines5m[idx - 1];
    const b = bbSeries5m[idx - 19];
    const prevB = bbSeries5m[idx - 20];
    const rsi = rsiSeries5m[idx];
    const vw = vwapSeries5m[idx];
    const rvol = k.volume / (volSma5m[idx] || 1);

    if (!b || !prevB || isNaN(rsi) || isNaN(vw)) return false;

    if (dir === 'LONG') {
      const gateVWAP = k.close > vw;
      const gateBreakout = k.close > b.upper && prevK.close <= prevB.upper;
      const gateVol = rvol >= 1.5;
      const gateRSI = rsi > 50 && rsi < 75;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    } else {
      const gateVWAP = k.close < vw;
      const gateBreakout = k.close < b.lower && prevK.close >= prevB.lower;
      const gateVol = rvol >= 1.5;
      const gateRSI = rsi < 50 && rsi > 25;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    }
  };

  // A. PULLBACK GATILLO (Solo en modo agresivo)
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
                           volCurr5m / volAvg5m >= 1.5 &&
                           curr5m.close > vwap5m;

  const minPrevLow3 = Math.min(klines5m[lastIdx - 1].low, klines5m[lastIdx - 2].low, klines5m[lastIdx - 3].low);
  const condPullbackShort = triggerMode === 'agresivo' &&
                            (hasPullbackShort(lastIdx) || hasPullbackShort(lastIdx - 1) || hasPullbackShort(lastIdx - 2)) &&
                            curr5m.close < minPrevLow3 &&
                            curr5m.close < curr5m.open &&
                            volCurr5m / volAvg5m >= 1.5 &&
                            curr5m.close < vwap5m;

  // B. BREAKOUT GATILLO (Agresivo = Ruptura Directa / Conservador = Espera Retest de la Banda Rota)
  let condBreakoutLong = false;
  let condBreakoutShort = false;

  if (triggerMode === 'conservador') {
    // Buscar si hubo ruptura en las últimas 5 velas
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
        // Retest: low de la vela toca/está cerca del nivel roto y cierra sobre él
        const retestSostenido = curr5m.low >= level * 0.998 && curr5m.close > level;
        if (retestSostenido) {
          condBreakoutLong = true;
        }
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
        // Retest: high de la vela toca/está cerca del nivel roto y cierra bajo él
        const retestSostenido = curr5m.high <= level * 1.002 && curr5m.close < level;
        if (retestSostenido) {
          condBreakoutShort = true;
        }
      }
    }
  } else {
    // Ruptura directa (Agresivo) con Squeeze Bollinger y Opening Range
    const orb = getOpeningRange(klines5m, lastIdx, style === 'swing' ? '1h' : '5m', symbol);
    const prevOrb = getOpeningRange(klines5m, lastIdx - 1, style === 'swing' ? '1h' : '5m', symbol);

    const breakoutLongPrev = prevOrb.isActive &&
                             prev5m.close > prevOrb.high + 0.10 * atrSeries5m[lastIdx - 1] &&
                             bbIdx > 0 && prev5m.close > bbSeries5m[bbIdx - 1].upper &&
                             (vol5m[lastIdx - 1] / volSma5m[lastIdx - 1]) >= 2.0 &&
                             (prev5m.close - bbSeries5m[bbIdx - 1].upper) <= 1.0 * atrSeries5m[lastIdx - 1];

    condBreakoutLong = squeezePrev && breakoutLongPrev && curr5m.low > orb.high;

    const breakoutShortPrev = prevOrb.isActive &&
                              prev5m.close < prevOrb.low - 0.10 * atrSeries5m[lastIdx - 1] &&
                              bbIdx > 0 && prev5m.close < bbSeries5m[bbIdx - 1].lower &&
                              (vol5m[lastIdx - 1] / volSma5m[lastIdx - 1]) >= 2.0 &&
                              (bbSeries5m[bbIdx - 1].lower - prev5m.close) <= 1.0 * atrSeries5m[lastIdx - 1];

    condBreakoutShort = squeezePrev && breakoutShortPrev && curr5m.high < orb.low;
  }

  // C. MEAN REVERSION (Solo en Bias Neutral con Divergencia)
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
  // 5. FILTROS DE CALIDAD Y EJECUCIÓN
  // ═══════════════════════════════════════════════════════════
  const minutesSinceOpen = (() => {
    const isCrypto = symbol ? (symbol.endsWith('USDT') || symbol.endsWith('BTC')) : true;
    if (isCrypto) return 60; // always valid
    let sessionStartIdx = lastIdx;
    const currentSession = getSessionId(curr5m, style === 'swing' ? '1h' : '5m', symbol);
    while (sessionStartIdx > 0 && getSessionId(klines5m[sessionStartIdx - 1], style === 'swing' ? '1h' : '5m', symbol) === currentSession) {
      sessionStartIdx--;
    }
    const unitMinutes = style === 'swing' ? 60 : 5;
    return (lastIdx - sessionStartIdx + (style === 'swing' ? 1 : 0)) * unitMinutes;
  })();

  const qualityLong = (curr5m.close - vwap5m) <= 2.0 * atr5m && // no chasing
                      candleBodyRatio(curr5m) >= 0.4 && // no doji
                      minutesSinceOpen >= 15 && // avoid opening chaos
                      volCurr5m / volAvg5m < 8.0; // avoid news spike

  const qualityShort = (vwap5m - curr5m.close) <= 2.0 * atr5m &&
                       candleBodyRatio(curr5m) >= 0.4 &&
                       minutesSinceOpen >= 15 &&
                       volCurr5m / volAvg5m < 8.0;

  // ═══════════════════════════════════════════════════════════
  // 6. SISTEMA DE PUNTUACIÓN DE CONFLUENCIA (0-9)
  // ═══════════════════════════════════════════════════════════
  const getConfluenceScore = (dir: 'LONG' | 'SHORT') => {
    let pt = 0;
    const isLong = dir === 'LONG';
    
    // A. Bias 1D alineado (+2)
    const activeBias = isLong ? bias1D === 'ALCISTA' : bias1D === 'BAJISTA';
    if (activeBias) pt += 2;

    // B. ADX 1D > 25 (+1)
    if (lastAdx1d > 25) pt += 1;

    // C. RVOL >= 2.0 (+2)
    if (volCurr5m / volAvg5m >= 2.0) pt += 2;

    // D. Precio 1H sobre/bajo VWAP (+1)
    const activeVwap1h = isLong ? close1h > vwapVal1h : close1h < vwapVal1h;
    if (activeVwap1h) pt += 1;

    // E. MACD 1H histograma expandiendo (+1)
    const activeMacd1h = isLong ? (macdHist1h > 0 && macdHist1h > macdHistPrev1h) : (macdHist1h < 0 && macdHist1h < macdHistPrev1h);
    if (activeMacd1h) pt += 1;

    // F. Squeeze Bollinger previo (+1)
    if (squeezePrev) pt += 1;

    // G. Soporte/Resistencia o Donchian 20 coincidente (+1)
    const srLevel = calculateSupportResistance(klines5m, curr5m.close);
    const distSupport = srLevel.nearestSupport > 0 ? (curr5m.close - srLevel.nearestSupport) / curr5m.close : Infinity;
    const distResist = srLevel.nearestResistance > 0 ? (srLevel.nearestResistance - curr5m.close) / curr5m.close : Infinity;
    const nearLevel = isLong ? distSupport < 0.005 : distResist < 0.005;
    
    let donchianHigh = -Infinity;
    let donchianLow = Infinity;
    const donStart = Math.max(0, klines1d.length - 20);
    for (let d = donStart; d < klines1d.length; d++) {
      if (klines1d[d].high > donchianHigh) donchianHigh = klines1d[d].high;
      if (klines1d[d].low < donchianLow) donchianLow = klines1d[d].low;
    }
    const nearDonchian = isLong ? Math.abs(curr5m.close - donchianLow) / curr5m.close < 0.01 : Math.abs(curr5m.close - donchianHigh) / curr5m.close < 0.01;
    
    if (nearLevel || nearDonchian) pt += 1;

    return pt;
  };

  const scoreLong = getConfluenceScore('LONG');
  const scoreShort = getConfluenceScore('SHORT');

  // ═══════════════════════════════════════════════════════════
  // 7. DETERMINACIÓN DE SEÑAL FINAL
  // ═══════════════════════════════════════════════════════════
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let mode: 'BREAKOUT' | 'REVERSAL' | 'NONE' = 'NONE';
  let triggerDetail = '';

  const triggerLong = (setupArmedLong && (condPullbackLong || condBreakoutLong)) && qualityLong;
  const triggerShort = (setupArmedShort && (condPullbackShort || condBreakoutShort)) && qualityShort;

  const triggerMRLong = condMRLong && qualityLong;
  const triggerMRShort = condMRShort && qualityShort;

  if (triggerLong) {
    signal = 'BUY';
    mode = condBreakoutLong ? 'BREAKOUT' : 'REVERSAL';
    triggerDetail = condBreakoutLong 
      ? (triggerMode === 'conservador' ? 'Retest sostenido de Breakout' : 'ORB Breakout con confirmación') 
      : 'Pullback en tendencia alcista';
  } else if (triggerMRLong) {
    signal = 'BUY';
    mode = 'REVERSAL';
    triggerDetail = 'Mean Reversion con Divergencia (Régimen Neutral)';
  } else if (triggerShort) {
    signal = 'SELL';
    mode = condBreakoutShort ? 'BREAKOUT' : 'REVERSAL';
    triggerDetail = condBreakoutShort 
      ? (triggerMode === 'conservador' ? 'Retest sostenido de Breakdown' : 'ORB Breakdown con confirmación') 
      : 'Pullback en tendencia bajista';
  } else if (triggerMRShort) {
    signal = 'SELL';
    mode = 'REVERSAL';
    triggerDetail = 'Mean Reversion con Divergencia (Régimen Neutral)';
  }

  // Filter signals by confluence score (requires score >= 4, which maps to 44% in UI compatibility)
  const baseScore = signal === 'BUY' ? scoreLong : (signal === 'SELL' ? scoreShort : Math.max(scoreLong, scoreShort));
  const finalScorePercent = Math.round((baseScore / 9) * 100);

  // Volatility adjusted threshold: score >= 4 (44%), high vol >= 3 (33%), low vol >= 5 (55%)
  let requiredThreshold = 44;
  if (atrVal1h > 1.2 * atrSma1h) requiredThreshold = 33;
  else if (atrVal1h < 0.8 * atrSma1h) requiredThreshold = 55;

  // Grade Confidence
  let confidence: 'ALTA' | 'MODERADA' | 'DESCARTAR' = 'DESCARTAR';
  if (finalScorePercent >= 70) {
    confidence = 'ALTA';
  } else if (finalScorePercent >= requiredThreshold) {
    confidence = 'MODERADA';
  }

  if (signal !== 'NEUTRAL' && confidence === 'DESCARTAR') {
    signal = 'NEUTRAL';
    mode = 'NONE';
    triggerDetail = `Fuerza confluente insuficiente: ${baseScore} puntos (${finalScorePercent}%)`;
  }

  // ═══════════════════════════════════════════════════════════
  // 8. GESTIÓN DE RIESGO (Stop Loss y Take Profits escalonados)
  // ═══════════════════════════════════════════════════════════
  let stopLoss = 0;
  let takeProfit1 = 0;
  let takeProfit2 = 0;
  let takeProfit3 = 0;
  let riskRewardRatio = 0;

  const entry = curr5m.close;
  
  // Swing style SL lookback is 5 bars, Day Trading is 10 bars
  const lookbackS = Math.max(0, lastIdx - (style === 'swing' ? 5 : 10));
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (let s = lookbackS; s < lastIdx; s++) {
    if (klines5m[s].low < swingLow) swingLow = klines5m[s].low;
    if (klines5m[s].high > swingHigh) swingHigh = klines5m[s].high;
  }

  const atrMult = style === 'swing' ? 1.0 : 1.5;
  const tp1Mult = style === 'swing' ? 2.0 : 1.5;
  const tp2Mult = style === 'swing' ? 4.0 : 2.5;
  const tp3Mult = style === 'swing' ? 5.0 : 3.5;

  if (signal === 'BUY') {
    const slATR = entry - atrMult * atr5m;
    const slStruct = swingLow - 0.25 * atr5m;
    
    // U-shaped / Conservative SL: Math.min (lowest price, furthest from entry)
    stopLoss = Math.min(slATR, slStruct);

    // Limit SL risk. Day trading has 1.2% cap. Swing has a wider cap of 3.5%
    const riskPercent = (entry - stopLoss) / entry;
    const maxAllowedRisk = style === 'swing' ? 0.035 : 0.012;
    if (riskPercent > maxAllowedRisk) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      triggerDetail = `Riesgo excesivo (${(riskPercent * 100).toFixed(2)}% > ${(maxAllowedRisk * 100).toFixed(1)}%)`;
      stopLoss = 0;
    } else {
      const risk = entry - stopLoss;
      takeProfit1 = entry + risk * tp1Mult;
      takeProfit2 = entry + risk * tp2Mult;
      takeProfit3 = entry + risk * tp3Mult; // trailing target
      riskRewardRatio = tp1Mult;
    }
  } else if (signal === 'SELL') {
    const slATR = entry + atrMult * atr5m;
    const slStruct = swingHigh + 0.25 * atr5m;
    
    // Conservative SL: Math.max (highest price, furthest from entry)
    stopLoss = Math.max(slATR, slStruct);

    const riskPercent = (stopLoss - entry) / entry;
    const maxAllowedRisk = style === 'swing' ? 0.035 : 0.012;
    if (riskPercent > maxAllowedRisk) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      triggerDetail = `Riesgo excesivo (${(riskPercent * 100).toFixed(2)}% > ${(maxAllowedRisk * 100).toFixed(1)}%)`;
      stopLoss = 0;
    } else {
      const risk = stopLoss - entry;
      takeProfit1 = entry - risk * tp1Mult;
      takeProfit2 = entry - risk * tp2Mult;
      takeProfit3 = entry - risk * tp3Mult;
      riskRewardRatio = tp1Mult;
    }
  }

  // Meta-learning / Adaptive Factor calculations
  let adaptiveFactor = 1.0;
  let marketRegime = 'Normal';
  let volatilityProfile = 'Normal';
  let recentPerfLabel = 'Sin datos';

  if (atrVal1h > 1.2 * atrSma1h) {
    adaptiveFactor *= 1.15;
    marketRegime = 'Alta Volatilidad (+15% Size)';
  } else if (atrVal1h < 0.8 * atrSma1h) {
    adaptiveFactor *= 0.82;
    marketRegime = 'Baja Volatilidad (-18% Size)';
  }

  if (avgDailyRange > 3.5) {
    adaptiveFactor *= 1.12;
    volatilityProfile = 'Alta Volatilidad (+12% Size)';
  } else if (avgDailyRange < 1.2) {
    adaptiveFactor *= 0.75;
    volatilityProfile = 'Baja Volatilidad (-25% Size)';
  }

  if (recentWinRate !== undefined) {
    let perfMult = 1.0;
    if (recentWinRate > 0.68) {
      perfMult += 0.12;
      recentPerfLabel = `Excelente WR: ${(recentWinRate * 100).toFixed(0)}% (+12% Size)`;
    } else if (recentWinRate < 0.45) {
      perfMult -= 0.18;
      recentPerfLabel = `Deficiente WR: ${(recentWinRate * 100).toFixed(0)}% (-18% Size)`;
    } else {
      recentPerfLabel = `Estable WR: ${(recentWinRate * 100).toFixed(0)}%`;
    }
    if (recentProfitFactor && recentProfitFactor > 1.8) {
      perfMult += 0.08;
      recentPerfLabel += ` | Buen PF: ${recentProfitFactor.toFixed(2)}`;
    }
    const clampedPerf = Math.max(0.65, Math.min(1.25, perfMult));
    adaptiveFactor *= clampedPerf;
  }

  const sr = calculateSupportResistance(klines5m, entry);
  const atrPercent = entry > 0 ? (atr5m / entry * 100) : 0;

  return {
    signal,
    mode,
    stopLoss: Number(stopLoss.toFixed(2)),
    takeProfit1: Number(takeProfit1.toFixed(2)),
    takeProfit2: Number(takeProfit2.toFixed(2)),
    takeProfit3: Number(takeProfit3.toFixed(2)),
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    bias1D,
    adx1H: isNaN(adxVal1h) ? 0 : Number(adxVal1h.toFixed(1)),
    momentum1H,
    triggerDetail,
    rsi1H: Number(rsiVal1h.toFixed(1)),
    macdHistDirection: macdHistDir,
    ema200_1D: Number(lastEma200_1d.toFixed(2)),
    ema50_1H: Number(ema50Val1h.toFixed(2)),
    vwap5m: Number(vwap5m.toFixed(2)),
    bbUpper5m: Number(bb.upper.toFixed(2)),
    bbLower5m: Number(bb.lower.toFixed(2)),
    isTrendUp: bias1D === 'ALCISTA',
    nearestSupport: sr.nearestSupport,
    nearestResistance: sr.nearestResistance,
    score: finalScorePercent,
    baseScore,
    adaptiveFactor: Number(adaptiveFactor.toFixed(2)),
    marketRegime,
    volatilityProfile,
    recentPerfLabel,
    atrPercent: Number(atrPercent.toFixed(2)),
    avgDailyRange: Number(avgDailyRange.toFixed(2)),
    confidence
  };
}
