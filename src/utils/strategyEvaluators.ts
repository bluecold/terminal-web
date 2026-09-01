import type { Kline } from '../services/api';
import {
  calculateEMA,
  calculateRSISeries,
  calculateRSISlope,
  calculateBollingerBandsSeries,
  type BollingerBandsSeriesResult,
  calculateSupertrendSeries,
  calculateStochRSISeries,
  calculateVolumeSignalSeries,
  calculateVWAPSeries,
  calculateMACDSeries,
  type MACDSeriesData,
  calculateATRSeries,
  calculateADXSeries,
  calculateSupportResistance,
  calculateChandelierExit,
  calculateRevolutionVolatilityBand,
  calculateVolumeComposition,
  calculateAndianOscillator,
  calculateDreadBlitz,
  candleBodyRatio,
  closePosition,
  upperWickRatio,
  lowerWickRatio,
  isHammer,
  isEngulfing,
  detectEmaCrossoverFromSeries,
  getOpeningRange,
  isNyseOpeningWindow,
  checkBullishDivergence,
  checkBearishDivergence,
  calculateRollingVolumeAvg,
  type ScoringWeights,
  DEFAULT_WEIGHTS,
  SCORING_CONFIG,
  type ScoringResult,
  type StandardVotingResult,
  type VCMESniperResult,
  type MultifractalMTFSignalResult,
  type EmaCrossover
} from './indicators';
import { formatSmartPrice, formatSmartNumber } from './formatters';
import type { DiscardBreakdown } from './backtester';

// ═══════════════════════════════════════════════════════════════════════════
// 1. CONFLUENCIA / EXPERIMENTAL SIGNAL (Signal 1)
// ═══════════════════════════════════════════════════════════════════════════

export interface ConfluenciaContext {
  klines: Kline[];
  interval: string;
  closes: number[];
  ema9: number[];
  ema20: number[];
  vwap: number[];
  atr: number[];
  volSMA: number[];
}

export interface ConfluenciaEvaluationResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  stopLoss: number;
  validVolume: boolean;
  emaCrossover: EmaCrossover;
}

export function buildConfluenciaContext(klines: Kline[], interval: string = '1h'): ConfluenciaContext {
  const length = klines ? klines.length : 0;
  if (length === 0) {
    return { klines: [], interval, closes: [], ema9: [], ema20: [], vwap: [], atr: [], volSMA: [] };
  }

  const closes = klines.map(k => k.close);
  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  const vwap = calculateVWAPSeries(klines, interval);
  const atr = calculateATRSeries(klines, 14);

  const volSMA = new Array(length).fill(0);
  let sumVol = 0;
  for (let i = 0; i < Math.min(20, length); i++) {
    sumVol += klines[i].volume;
  }
  if (length >= 20) volSMA[19] = sumVol / 20;
  for (let i = 20; i < length; i++) {
    sumVol = sumVol - klines[i - 20].volume + klines[i].volume;
    volSMA[i] = sumVol / 20;
  }

  return { klines, interval, closes, ema9, ema20, vwap, atr, volSMA };
}

export function evaluateConfluenciaAt(ctx: ConfluenciaContext, i: number): ConfluenciaEvaluationResult {
  const fallback: ConfluenciaEvaluationResult = {
    signal: 'NEUTRAL',
    stopLoss: 0,
    validVolume: false,
    emaCrossover: { type: 'NONE', barsAgo: 0 }
  };

  if (!ctx.klines || ctx.klines.length < 21 || i < 20 || i >= ctx.klines.length) {
    return fallback;
  }

  const curr = ctx.klines[i];
  const prev = ctx.klines[i - 1];

  const hammer = isHammer(curr);
  const engulf = isEngulfing(curr, prev);
  const bRatio = candleBodyRatio(curr);

  const e9 = ctx.ema9[i];
  const e20 = ctx.ema20[i];
  const vw = ctx.vwap[i];
  const vAvg = ctx.volSMA[i];
  const atr = ctx.atr[i];

  const cp = closePosition(curr);
  const distVwapAtr = atr > 0 ? Math.abs(curr.close - vw) / atr : 0;
  const isNotOverextended = distVwapAtr <= 2.2;

  const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > e9;
  const bullish_candle = hammer || engulf === 1 || strongBullish;
  const bearish_candle = engulf === -1;

  const is_buy = curr.close > vw && e9 > e20 && curr.volume >= vAvg * 0.8
                  && bullish_candle && bRatio >= 0.3 && isNotOverextended && cp >= 0.50;
  const is_sell = curr.close < vw && e9 < e20 && curr.volume >= vAvg * 0.8
                  && (bearish_candle || curr.close < e20) && bRatio >= 0.3 && isNotOverextended && cp <= 0.50;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (is_buy) signal = 'BUY';
  else if (is_sell) signal = 'SELL';

  const stopLossLong = curr.close - (2 * atr);
  const stopLossShort = curr.close + (2 * atr);
  const stopLoss = signal === 'BUY' ? stopLossLong : (signal === 'SELL' ? stopLossShort : 0);

  const emaCrossover = detectEmaCrossoverFromSeries(ctx.ema9, ctx.ema20, i, 5);

  return {
    signal,
    stopLoss,
    validVolume: curr.volume > vAvg,
    emaCrossover
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. SCORING MULTICAPA (Signal 2)
// ═══════════════════════════════════════════════════════════════════════════

export interface ScoringContext {
  klines: Kline[];
  interval: string;
  weights: ScoringWeights;
  cfg: typeof SCORING_CONFIG[string];
  closes: number[];
  emaFastArr: number[];
  emaSlowArr: number[];
  emaMajorArr: number[];
  rsiSeries: number[];
  bbSeries: BollingerBandsSeriesResult[];
  vwapSeries: number[];
  atrSeries: number[];
  obvArr: number[];
  obvEMAArr: number[];
  srCache: Map<number, { nearestSupport: number; nearestResistance: number }>;
}

export function buildScoringContext(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoringContext {
  const length = klines ? klines.length : 0;
  const cfg = SCORING_CONFIG[interval] ?? SCORING_CONFIG['1h'];
  if (length === 0) {
    return {
      klines: [], interval, weights, cfg, closes: [], emaFastArr: [], emaSlowArr: [], emaMajorArr: [],
      rsiSeries: [], bbSeries: [], vwapSeries: [], atrSeries: [], obvArr: [], obvEMAArr: [], srCache: new Map()
    };
  }

  const closes = klines.map(k => k.close);
  const emaFastArr = calculateEMA(closes, cfg.emaFast);
  const emaSlowArr = calculateEMA(closes, cfg.emaSlow);
  const emaMajorArr = cfg.emaMajor ? calculateEMA(closes, cfg.emaMajor) : new Array(length).fill(NaN);
  const rsiSeries = calculateRSISeries(closes, cfg.rsiPeriod);
  const bbSeries = calculateBollingerBandsSeries(klines, cfg.bbPeriod);
  const vwapSeries = cfg.useVwap ? calculateVWAPSeries(klines, interval) : new Array(length).fill(0);
  const atrSeries = calculateATRSeries(klines, 14);

  let obvArr: number[] = [];
  let obvEMAArr: number[] = [];
  if (cfg.useObv) {
    obvArr = [0];
    for (let i = 1; i < length; i++) {
      if (closes[i] > closes[i - 1])      obvArr.push(obvArr[i - 1] + klines[i].volume);
      else if (closes[i] < closes[i - 1]) obvArr.push(obvArr[i - 1] - klines[i].volume);
      else                                obvArr.push(obvArr[i - 1]);
    }
    obvEMAArr = calculateEMA(obvArr, 10);
  }

  // Aligned 5-bar checkpoint cache for S/R
  const srCacheInterval = 5;
  const srCache: Map<number, { nearestSupport: number; nearestResistance: number }> = new Map();
  const startIdx = Math.max(0, Math.floor(55 / srCacheInterval) * srCacheInterval);
  for (let idx = startIdx; idx < length; idx += srCacheInterval) {
    const windowStart = Math.max(0, idx - 100);
    const windowSlice = klines.slice(windowStart, idx + 1);
    const sr = calculateSupportResistance(windowSlice, klines[idx].close);
    srCache.set(idx, { nearestSupport: sr.nearestSupport, nearestResistance: sr.nearestResistance });
  }

  return {
    klines, interval, weights, cfg, closes, emaFastArr, emaSlowArr, emaMajorArr,
    rsiSeries, bbSeries, vwapSeries, atrSeries, obvArr, obvEMAArr, srCache
  };
}

export function evaluateScoringAt(ctx: ScoringContext, i: number): ScoringResult {
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

  if (!ctx.klines || ctx.klines.length < 60 || i < 59 || i >= ctx.klines.length) {
    return fallback;
  }

  const curr = ctx.klines[i];
  const closeVal = ctx.closes[i];
  const cfg = ctx.cfg;

  // Layer 1 — Tendencia EMA
  const ef = ctx.emaFastArr[i];
  const es = ctx.emaSlowArr[i];
  const em = ctx.emaMajorArr[i];

  let s1 = 0;
  let n1 = '';
  if (ef > es)      { s1 += 1; n1 += `EMA${cfg.emaFast} > EMA${cfg.emaSlow} (alcista)`; }
  else if (ef < es) { s1 -= 1; n1 += `EMA${cfg.emaFast} < EMA${cfg.emaSlow} (bajista)`; }

  if (cfg.emaMajor && !isNaN(em)) {
    if (closeVal > em) { s1 += 1; n1 += ` | Sobre EMA${cfg.emaMajor}`; }
    else               { s1 -= 1; n1 += ` | Bajo EMA${cfg.emaMajor}`; }
  }

  // Layer 2 — RSI con pendiente
  const rsi = ctx.rsiSeries[i];
  const rsiSlopeVal = calculateRSISlope(ctx.rsiSeries, i, 3);
  const rsiRising = rsiSlopeVal > 0;
  const rsiFalling = rsiSlopeVal < 0;

  let s2 = 0;
  let n2 = `RSI(${cfg.rsiPeriod}): ${isNaN(rsi) ? '-' : rsi.toFixed(1)}`;
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

  // Layer 3 — Bollinger %B & Squeeze
  let s3 = 0;
  let n3 = '';
  const bbIdx = i - (cfg.bbPeriod - 1);
  const bb = bbIdx >= 0 && bbIdx < ctx.bbSeries.length ? ctx.bbSeries[bbIdx] : null;
  if (bb) {
    const bandWidth = bb.upper - bb.lower;
    const pctB = bandWidth > 0 ? (closeVal - bb.lower) / bandWidth : 0.5;
    n3 = `%B: ${pctB.toFixed(2)}`;
    if      (closeVal <= bb.lower) { s3 += 1; n3 += ' | En/bajo banda inf. (rebote)'; }
    else if (closeVal >= bb.upper) { s3 -= 1; n3 += ' | En/sobre banda sup. (rechazo)'; }
    else if (pctB < 0.2)           { s3 += 1; n3 += ' | Cerca banda inf.'; }
    else if (pctB > 0.8)           { s3 -= 1; n3 += ' | Cerca banda sup.'; }
    else                           { n3 += ' | Dentro de bandas'; }

    const bbMiddle = (bb.upper + bb.lower) / 2;
    const bbWidthRatio = bbMiddle > 0 ? bandWidth / bbMiddle : 0;
    if (bbWidthRatio < 0.05) { n3 += ' | Squeeze (alta compresión)'; }
  } else {
    n3 = 'Bollinger no disponible';
  }

  // Layer 4 — Volumen: VWAP u OBV
  let s4 = 0;
  let n4 = '';
  if (cfg.useVwap) {
    const vwap = ctx.vwapSeries[i];
    const atr = ctx.atrSeries[i];
    const isChasing = atr > 0 && Math.abs(closeVal - vwap) > 2.0 * atr;
    if (isChasing) {
      s4 -= 1;
      n4 = `VWAP: ${formatSmartNumber(vwap)} | Chasing (>2 ATR de VWAP)`;
    } else {
      if (closeVal > vwap) { s4 += 1; n4 = `VWAP: ${formatSmartNumber(vwap)} | Precio sobre VWAP (compradores)`; }
      else                 { s4 -= 1; n4 = `VWAP: ${formatSmartNumber(vwap)} | Precio bajo VWAP (vendedores)`; }
    }
  } else if (cfg.useObv) {
    const obvLast = ctx.obvArr[i];
    const obvEMA = ctx.obvEMAArr[i];
    if (obvLast > obvEMA) { s4 += 1; n4 = 'OBV > OBV_EMA10 (acumulación)'; }
    else                  { s4 -= 1; n4 = 'OBV < OBV_EMA10 (distribución)'; }
  } else {
    n4 = 'Indicador de volumen no disponible';
  }

  // Layer 5 — Confirmación de Vela & Mechas
  const body = curr.close - curr.open;
  const range = curr.high - curr.low;
  const pctBody = range > 0 ? Math.abs(body) / range : 0;
  const uWick = upperWickRatio(curr);
  const lWick = lowerWickRatio(curr);

  let s5 = 0;
  let n5 = `Cuerpo: ${body >= 0 ? '+' : ''}${formatSmartNumber(body)} (${(pctBody * 100).toFixed(0)}%)`;

  if (pctBody < 0.3) {
    s5 = 0;
    n5 += ' | Doji (indecisión)';
  } else if (body > 0) {
    if (pctBody >= 0.5) { s5 += 1.0; n5 += ' | Alcista fuerte'; }
    else                { s5 += 0.5; n5 += ' | Alcista moderada'; }
  } else {
    if (pctBody >= 0.5) { s5 -= 1.0; n5 += ' | Bajista fuerte'; }
    else                { s5 -= 0.5; n5 += ' | Bajista moderada'; }
  }

  if (pctBody >= 0.3) {
    if (body > 0 && uWick > 0.25) { s5 -= 0.5; n5 += ' (rechazo sup)'; }
    else if (body < 0 && lWick > 0.25) { s5 += 0.5; n5 += ' (rechazo inf)'; }
  }

  // Layer 6 — Estructura S/R
  const srCacheInterval = 5;
  const cacheIdx = Math.floor(i / srCacheInterval) * srCacheInterval;
  const sr = ctx.srCache.get(cacheIdx) || { nearestSupport: 0, nearestResistance: 0 };
  const structureWeight = 1.0;
  let s6 = 0;
  let n6 = '';

  if (sr.nearestSupport > 0 || sr.nearestResistance > 0) {
    const distSupport = sr.nearestSupport > 0 ? (closeVal - sr.nearestSupport) / closeVal : Infinity;
    const distResist = sr.nearestResistance > 0 ? (sr.nearestResistance - closeVal) / closeVal : Infinity;
    const nearThreshold = 0.015; // 1.5%

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

  // Ponderación de Score
  const w = ctx.weights;
  const w1 = s1 * w.trend;
  const w2 = s2 * w.rsi;
  const w3 = s3 * w.bollinger;
  const w4 = s4 * w.volume;
  const w5 = s5 * w.candle;
  const w6 = s6 * structureWeight;
  const totalScore = w1 + w2 + w3 + w4 + w5 + w6;

  const maxTrend = cfg.emaMajor ? 2 : 1;
  const maxPossible = (maxTrend * w.trend) + w.rsi + w.bollinger + w.volume + w.candle + structureWeight;
  const threshold = Number((maxPossible * 0.5).toFixed(2));

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if      (totalScore >=  threshold) signal = 'BUY';
  else if (totalScore <= -threshold) signal = 'SELL';

  // R:R validation
  if (signal !== 'HOLD') {
    const atr = ctx.atrSeries[i];
    if (atr > 0) {
      const slDist = 1.5 * atr;
      if (signal === 'BUY' && sr.nearestResistance > 0) {
        const rewardRoom = sr.nearestResistance - closeVal;
        if (rewardRoom > 0 && rewardRoom < slDist * 1.5) {
          signal = 'HOLD';
          n6 += ` | R:R ${(rewardRoom / slDist).toFixed(1)}:1 insuficiente`;
        }
      } else if (signal === 'SELL' && sr.nearestSupport > 0) {
        const rewardRoom = closeVal - sr.nearestSupport;
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

// ═══════════════════════════════════════════════════════════════════════════
// 3. STANDARD VOTING (Signal 3)
// ═══════════════════════════════════════════════════════════════════════════

export interface StandardVotingContext {
  klines: Kline[];
  closes: number[];
  rsiSeries: number[];
  macdSeries: MACDSeriesData;
  bbSeries: BollingerBandsSeriesResult[];
  supertrendSeries: Array<{ time?: number; value: number; direction: 'UP' | 'DOWN' }>;
  stochRsiSeries: { k: number[]; d: number[]; signals: ('BUY' | 'SELL' | 'NEUTRAL')[] };
  volSmaSeries: number[];
  volSignalSeries: { values: string[]; signals: ('BUY' | 'SELL' | 'NEUTRAL')[] };
  ema200Series: number[];
}

export function buildStandardVotingContext(klines: Kline[]): StandardVotingContext {
  const length = klines ? klines.length : 0;
  if (length === 0) {
    return {
      klines: [], closes: [], rsiSeries: [],
      macdSeries: { macd: [], signal: [], histogram: [], signals: [] },
      bbSeries: [], supertrendSeries: [], stochRsiSeries: { k: [], d: [], signals: [] },
      volSmaSeries: [], volSignalSeries: { values: [], signals: [] }, ema200Series: []
    };
  }

  const closes = klines.map(k => k.close);
  const rsiSeries = calculateRSISeries(closes, 14);
  const macdSeries = calculateMACDSeries(closes);
  const bbSeries = calculateBollingerBandsSeries(klines, 20, 2);
  const supertrendSeries = calculateSupertrendSeries(klines, 10, 3);
  const stochRsiSeries = calculateStochRSISeries(closes, 14, 14, 3, 3);
  const volSignalSeries = calculateVolumeSignalSeries(klines);
  const ema200Series = calculateEMA(closes, 200);

  const volSmaSeries: number[] = new Array(length).fill(0);
  let volSum = 0;
  for (let i = 0; i < Math.min(20, length); i++) volSum += klines[i].volume;
  if (length >= 20) volSmaSeries[19] = volSum / 20;
  for (let i = 20; i < length; i++) {
    volSmaSeries[i] = volSum / 20;
    volSum = volSum - klines[i - 20].volume + klines[i].volume;
  }

  return {
    klines, closes, rsiSeries, macdSeries, bbSeries,
    supertrendSeries, stochRsiSeries, volSmaSeries, volSignalSeries, ema200Series
  };
}

export function evaluateStandardVotingAt(
  ctx: StandardVotingContext,
  i: number
): StandardVotingResult {
  const fallbackResult: StandardVotingResult = {
    indicators: [], buyVotes: 0, sellVotes: 0, rawSignal: 'NEUTRAL', finalSignal: 'NEUTRAL', signal: 'NEUTRAL'
  };

  if (!ctx.klines || ctx.klines.length < 35 || i < 34 || i >= ctx.klines.length) {
    return fallbackResult;
  }

  const curr = ctx.klines[i];
  const close = ctx.closes[i];

  // 1. RSI Indicator
  const rsiVal = ctx.rsiSeries[i];
  const rsiSlopeDir = calculateRSISlope(ctx.rsiSeries, i, 3);
  const slopeArrow = rsiSlopeDir > 0 ? ' ▲' : rsiSlopeDir < 0 ? ' ▼' : '';
  let rsiSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(rsiVal)) {
    if (rsiVal < 30) rsiSig = 'BUY';
    else if (rsiVal > 70) rsiSig = 'SELL';
  }

  // 2. MACD Indicator
  const macdSig = ctx.macdSeries.signals[i] || 'NEUTRAL';
  const macdVal = !isNaN(ctx.macdSeries.macd[i]) ? ctx.macdSeries.macd[i].toFixed(2) : '-';

  // 3. Bollinger Bands Indicator
  const bbIdx = i - 19;
  const bb = bbIdx >= 0 && bbIdx < ctx.bbSeries.length ? ctx.bbSeries[bbIdx] : null;
  let bbSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let bbVal = '-';
  if (bb) {
    bbVal = close.toFixed(2);
    if (close < bb.lower) bbSig = 'BUY';
    else if (close > bb.upper) bbSig = 'SELL';
  }

  // 4. Supertrend Indicator (Lookback up to 3 candles for flip)
  const st = ctx.supertrendSeries[i] || { value: 0, direction: 'UP', signal: 'NEUTRAL' };
  let stSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  const flipLookback = 3;
  let recentFlip = false;
  for (let offset = 0; offset < flipLookback; offset++) {
    const idxCurr = i - offset;
    const idxPrev = idxCurr - 1;
    if (idxPrev < 9) break;
    if (ctx.supertrendSeries[idxCurr] && ctx.supertrendSeries[idxPrev] && ctx.supertrendSeries[idxCurr].direction !== ctx.supertrendSeries[idxPrev].direction) {
      recentFlip = true;
      break;
    }
  }
  if (recentFlip) {
    stSig = st.direction === 'UP' ? 'BUY' : 'SELL';
  }
  const stVal = `ST: $${st.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${st.direction})`;

  // 5. Stochastic RSI
  const kVal = ctx.stochRsiSeries.k ? ctx.stochRsiSeries.k[i] : NaN;
  const dVal = ctx.stochRsiSeries.d ? ctx.stochRsiSeries.d[i] : NaN;
  const stochSig = ctx.stochRsiSeries.signals ? (ctx.stochRsiSeries.signals[i] || 'NEUTRAL') : 'NEUTRAL';
  const stochVal = `%K: ${!isNaN(kVal) ? kVal.toFixed(1) : '-'} · %D: ${!isNaN(dVal) ? dVal.toFixed(1) : '-'}`;

  // 6. Volume Signal
  const volSig = ctx.volSignalSeries.signals ? (ctx.volSignalSeries.signals[i] || 'NEUTRAL') : 'NEUTRAL';
  const volVal = ctx.volSignalSeries.values ? (ctx.volSignalSeries.values[i] || '—') : '—';
  const rvol = ctx.volSmaSeries[i] > 0 ? curr.volume / ctx.volSmaSeries[i] : 0;

  const colorFor = (sig: string) =>
    sig === 'BUY' ? 'var(--accent-green)' : sig === 'SELL' ? 'var(--accent-red)' : 'var(--text-primary)';

  const indicators = [
    { name: 'RSI (14)',          value: `${!isNaN(rsiVal) ? rsiVal.toFixed(1) : '-'}${slopeArrow}`, signal: rsiSig,   color: colorFor(rsiSig) },
    { name: 'MACD (12,26,9)',    value: macdVal,                                                     signal: macdSig,  color: colorFor(macdSig) },
    { name: 'Bollinger Bands',   value: bbVal,                                                       signal: bbSig,    color: colorFor(bbSig) },
    { name: 'Supertrend (10,3)', value: stVal,                                                       signal: stSig,    color: colorFor(stSig) },
    { name: 'Stochastic RSI',    value: stochVal,                                                    signal: stochSig, color: colorFor(stochSig) },
    { name: 'Volume',            value: volVal,                                                      signal: volSig,   color: colorFor(volSig) },
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
  const rvolThreshold = rawSignal.includes('BUY') ? 0.9 : 0.6;
  const voteMargin = Math.abs(buyVotes - sellVotes);
  const effectiveRvolThreshold = voteMargin < 2 ? Math.max(rvolThreshold, 1.1) : rvolThreshold;

  if (rawSignal !== 'NEUTRAL' && rvol < effectiveRvolThreshold) {
    rawSignal = 'NEUTRAL';
  }

  // Candle anatomy check
  const cp = closePosition(curr);
  if (rawSignal.includes('BUY') && cp < 0.45) {
    rawSignal = 'NEUTRAL';
  } else if (rawSignal.includes('SELL') && cp > 0.55) {
    rawSignal = 'NEUTRAL';
  }

  // Unified final signal with EMA 200 macro trend filter
  let finalSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (rawSignal.includes('BUY')) finalSig = 'BUY';
  if (rawSignal.includes('SELL')) finalSig = 'SELL';

  const emaVal = ctx.ema200Series[i];
  if (!isNaN(emaVal) && finalSig !== 'NEUTRAL') {
    const trend = close > emaVal ? 'UP' : 'DOWN';
    if (trend === 'UP' && finalSig === 'SELL') finalSig = 'NEUTRAL';
    if (trend === 'DOWN' && finalSig === 'BUY') finalSig = 'NEUTRAL';
  }

  return { indicators, buyVotes, sellVotes, rawSignal, finalSignal: finalSig, signal: finalSig };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. VCME SNIPER ENGINE (Signal 4)
// ═══════════════════════════════════════════════════════════════════════════

export interface VCMESniperContext {
  klines5m: Kline[];
  klines1h: Kline[];
  klines1d: Kline[];
  symbol?: string;
  style: 'dayTrading' | 'swing';
  triggerMode: 'agresivo' | 'conservador';
  // 1D
  closes1d: number[];
  ema200_1d: number[];
  ema50_1d: number[];
  adxData1d: ReturnType<typeof calculateADXSeries>;
  avgDailyRange: number;
  // 1H
  closes1h: number[];
  ema200_1h: number[];
  ema50_1h: number[];
  ema20_1h: number[];
  rsiSeries1h: number[];
  adxSeries1h: ReturnType<typeof calculateADXSeries>;
  macdData1h: MACDSeriesData;
  atrSeries1h: number[];
  vwapSeries1h: number[];
  chandelierData: ReturnType<typeof calculateChandelierExit>;
  atrSma1hArr: number[];
  // 5M
  closes5m: number[];
  bbSeries5m: BollingerBandsSeriesResult[];
  ema9_5m: number[];
  ema21_5m: number[];
  vwapSeries5m: number[];
  rsiSeries5m: number[];
  atrSeries5m: number[];
  vol5m: number[];
  volSma5m: number[];
  bbWidth5m: number[];
  // Index mappings O(1)
  idx1hMap: Int32Array;
  idx1dMap: Int32Array;
}

export interface VCMESniperEvaluationResult extends VCMESniperResult {
  discardReason?: keyof DiscardBreakdown;
}

export function buildVCMESniperContext(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol?: string,
  style: 'dayTrading' | 'swing' = 'dayTrading',
  triggerMode: 'agresivo' | 'conservador' = 'agresivo'
): VCMESniperContext {
  const len5m = klines5m ? klines5m.length : 0;
  const len1h = klines1h ? klines1h.length : 0;
  const len1d = klines1d ? klines1d.length : 0;

  // 1D
  const closes1d = klines1d ? klines1d.map(k => k.close) : [];
  const ema200_1d = closes1d.length >= 200 ? calculateEMA(closes1d, 200) : new Array(closes1d.length).fill(NaN);
  const ema50_1d = closes1d.length >= 50 ? calculateEMA(closes1d, 50) : new Array(closes1d.length).fill(NaN);
  const adxData1d = klines1d ? calculateADXSeries(klines1d, 14) : { adx: [], plusDI: [], minusDI: [] };
  const last20Ranges = klines1d ? klines1d.slice(-20).map(k => k.close > 0 ? (k.high - k.low) / k.close * 100 : 0) : [];
  const avgDailyRange = last20Ranges.reduce((a, b) => a + b, 0) / Math.max(1, last20Ranges.length);

  // 1H
  const closes1h = klines1h ? klines1h.map(k => k.close) : [];
  const ema200_1h = closes1h.length >= 200 ? calculateEMA(closes1h, 200) : new Array(closes1h.length).fill(NaN);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema20_1h = calculateEMA(closes1h, 20);
  const rsiSeries1h = calculateRSISeries(closes1h, 14);
  const adxSeries1h = klines1h ? calculateADXSeries(klines1h, 14) : { adx: [], plusDI: [], minusDI: [] };
  const macdData1h = calculateMACDSeries(closes1h);
  const atrSeries1h = klines1h ? calculateATRSeries(klines1h, 14) : [];
  const vwapSeries1h = klines1h ? calculateVWAPSeries(klines1h, '1h', symbol) : [];
  const chandelierData = klines1h ? calculateChandelierExit(klines1h, 22, 3.0) : { long: [], short: [] };

  const atrSma1hArr = new Array(len1h).fill(0);
  let atr1hSum = 0;
  for (let idx = 0; idx < Math.min(50, atrSeries1h.length); idx++) {
    atr1hSum += isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx];
  }
  if (atrSeries1h.length >= 50) atrSma1hArr[49] = atr1hSum / 50;
  for (let idx = 50; idx < atrSeries1h.length; idx++) {
    atr1hSum = atr1hSum - (isNaN(atrSeries1h[idx - 50]) ? 0 : atrSeries1h[idx - 50]) + (isNaN(atrSeries1h[idx]) ? 0 : atrSeries1h[idx]);
    atrSma1hArr[idx] = atr1hSum / 50;
  }

  // 5M
  const closes5m = klines5m ? klines5m.map(k => k.close) : [];
  const bbSeries5m = klines5m ? calculateBollingerBandsSeries(klines5m, 20, 2) : [];
  const ema9_5m = calculateEMA(closes5m, 9);
  const ema21_5m = calculateEMA(closes5m, 21);
  const vwapSeries5m = klines5m ? calculateVWAPSeries(klines5m, style === 'swing' ? '1h' : '5m', symbol) : [];
  const rsiSeries5m = calculateRSISeries(closes5m, 14);
  const atrSeries5m = klines5m ? calculateATRSeries(klines5m, 14) : [];

  const vol5m = klines5m ? klines5m.map(k => k.volume) : [];
  const volSma5m: number[] = new Array(len5m).fill(0);
  let volSum5m = 0;
  for (let i = 0; i < Math.min(20, vol5m.length); i++) volSum5m += vol5m[i];
  if (vol5m.length >= 20) volSma5m[19] = volSum5m / 20;
  for (let i = 20; i < vol5m.length; i++) {
    volSma5m[i] = volSum5m / 20;
    volSum5m = volSum5m - vol5m[i - 20] + vol5m[i];
  }

  const bbWidth5m = bbSeries5m.map(b => b.middle > 0 ? (b.upper - b.lower) / b.middle * 100 : 0);

  // Pre-indexed temporal mappings 5m -> 1h and 5m -> 1d O(N+M)
  const idx1hMap = new Int32Array(len5m).fill(-1);
  const idx1dMap = new Int32Array(len5m).fill(-1);

  if (len5m > 0 && len1h > 0) {
    let hCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      while (hCursor + 1 < len1h && (klines1h[hCursor + 1].time + 3600) <= t) {
        hCursor++;
      }
      if ((klines1h[hCursor].time + 3600) <= t) {
        idx1hMap[i] = hCursor;
      }
    }
  }

  if (len5m > 0 && len1d > 0) {
    let dCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      while (dCursor + 1 < len1d && (klines1d[dCursor + 1].time + 86400) <= t) {
        dCursor++;
      }
      if ((klines1d[dCursor].time + 86400) <= t) {
        idx1dMap[i] = dCursor;
      }
    }
  }

  return {
    klines5m, klines1h, klines1d, symbol, style, triggerMode,
    closes1d, ema200_1d, ema50_1d, adxData1d, avgDailyRange,
    closes1h, ema200_1h, ema50_1h, ema20_1h, rsiSeries1h, adxSeries1h,
    macdData1h, atrSeries1h, vwapSeries1h, chandelierData, atrSma1hArr,
    closes5m, bbSeries5m, ema9_5m, ema21_5m, vwapSeries5m, rsiSeries5m,
    atrSeries5m, vol5m, volSma5m, bbWidth5m,
    idx1hMap, idx1dMap
  };
}

export function evaluateVCMESniperAt(
  ctx: VCMESniperContext,
  i: number,
  executionPrice?: number
): VCMESniperEvaluationResult {
  const fallback: VCMESniperEvaluationResult = {
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

  if (!ctx.klines5m || ctx.klines5m.length < 30 || i < 20 || i >= ctx.klines5m.length) {
    return { ...fallback, discardReason: 'insufficientData' };
  }

  const curr5m = ctx.klines5m[i];
  const prev5m = ctx.klines5m[i - 1];

  // 1. LAYER 1 — Daily Bias 1D
  const idx1d = ctx.idx1dMap[i];
  if (idx1d < 30) {
    return { ...fallback, triggerDetail: 'Datos 1D insuficientes', discardReason: 'insufficientData' };
  }

  const lastEma200_1d = ctx.ema200_1d[idx1d];
  const lastEma50_1d = ctx.ema50_1d[idx1d];
  const lastClose1d = ctx.closes1d[idx1d];
  const lastAdx1d = ctx.adxData1d.adx[idx1d];
  const lastPlusDI1d = ctx.adxData1d.plusDI[idx1d];
  const lastMinusDI1d = ctx.adxData1d.minusDI[idx1d];

  const lastEma200Ref = !isNaN(lastEma200_1d) ? lastEma200_1d : lastEma50_1d;
  const hasDailyTrend = !isNaN(lastEma200Ref) && !isNaN(lastEma50_1d) && !isNaN(lastAdx1d);
  let bias1D: 'ALCISTA' | 'BAJISTA' | 'NEUTRAL' = 'NEUTRAL';
  if (hasDailyTrend) {
    const bias_long = lastClose1d > lastEma200Ref && (isNaN(lastEma200_1d) ? true : lastEma50_1d > lastEma200_1d) && lastAdx1d > 20 && lastPlusDI1d > lastMinusDI1d;
    const bias_short = lastClose1d < lastEma200Ref && (isNaN(lastEma200_1d) ? true : lastEma50_1d < lastEma200_1d) && lastAdx1d > 20 && lastMinusDI1d > lastPlusDI1d;

    if (bias_long) bias1D = 'ALCISTA';
    else if (bias_short) bias1D = 'BAJISTA';
  }

  // 2. LAYER 2 — 1H Setup & Regime
  const idx1h = ctx.idx1hMap[i];
  if (idx1h < 50) {
    return { ...fallback, bias1D, ema200_1D: lastEma200_1d, triggerDetail: 'Datos 1H insuficientes', discardReason: 'insufficientData' };
  }

  const close1h = ctx.closes1h[idx1h];
  const ema50Val1h = ctx.ema50_1h[idx1h];
  const ema20Val1h = ctx.ema20_1h[idx1h];
  const rsiVal1h = ctx.rsiSeries1h[idx1h];
  const adxVal1h = ctx.adxSeries1h.adx[idx1h];
  const atrVal1h = ctx.atrSeries1h[idx1h];
  const vwapVal1h = ctx.vwapSeries1h[idx1h];
  const macdHist1h = ctx.macdData1h.histogram[idx1h];
  const macdHistPrev1h = idx1h > 0 ? ctx.macdData1h.histogram[idx1h - 1] : NaN;
  const atrSma1h = ctx.atrSma1hArr[idx1h] || 1;

  const isSetupLongCandle = (hIdx: number) => {
    const hist = ctx.macdData1h.histogram[hIdx];
    const prevHist = ctx.macdData1h.histogram[hIdx - 1];
    const ema200Val = !isNaN(ctx.ema200_1h[hIdx]) ? ctx.ema200_1h[hIdx] : ctx.ema50_1h[hIdx];
    const ema200Prev5 = hIdx >= 5 ? (!isNaN(ctx.ema200_1h[hIdx - 5]) ? ctx.ema200_1h[hIdx - 5] : ctx.ema50_1h[hIdx - 5]) : ema200Val;
    const atr1h = (hIdx < ctx.atrSeries1h.length && !isNaN(ctx.atrSeries1h[hIdx]) && ctx.atrSeries1h[hIdx] > 0)
      ? ctx.atrSeries1h[hIdx]
      : (ema200Prev5 * 0.01);
    const slopeAtr = (ema200Val - ema200Prev5) / atr1h;
    const adxVal = ctx.adxSeries1h.adx[hIdx];
    const regimeOkLong = adxVal > 20 && slopeAtr > 0.05;

    return (
      regimeOkLong &&
      ctx.closes1h[hIdx] > ctx.vwapSeries1h[hIdx] &&
      ctx.ema20_1h[hIdx] > ctx.ema50_1h[hIdx] &&
      ctx.rsiSeries1h[hIdx] >= 50 && ctx.rsiSeries1h[hIdx] <= 70 &&
      hist > 0 &&
      hist > prevHist
    );
  };

  const isSetupShortCandle = (hIdx: number) => {
    const hist = ctx.macdData1h.histogram[hIdx];
    const prevHist = ctx.macdData1h.histogram[hIdx - 1];
    const ema200Val = !isNaN(ctx.ema200_1h[hIdx]) ? ctx.ema200_1h[hIdx] : ctx.ema50_1h[hIdx];
    const ema200Prev5 = hIdx >= 5 ? (!isNaN(ctx.ema200_1h[hIdx - 5]) ? ctx.ema200_1h[hIdx - 5] : ctx.ema50_1h[hIdx - 5]) : ema200Val;
    const atr1h = (hIdx < ctx.atrSeries1h.length && !isNaN(ctx.atrSeries1h[hIdx]) && ctx.atrSeries1h[hIdx] > 0)
      ? ctx.atrSeries1h[hIdx]
      : (ema200Prev5 * 0.01);
    const slopeAtr = (ema200Val - ema200Prev5) / atr1h;
    const adxVal = ctx.adxSeries1h.adx[hIdx];
    const regimeOkShort = adxVal > 20 && slopeAtr < -0.05;

    return (
      regimeOkShort &&
      ctx.closes1h[hIdx] < ctx.vwapSeries1h[hIdx] &&
      ctx.ema20_1h[hIdx] < ctx.ema50_1h[hIdx] &&
      ctx.rsiSeries1h[hIdx] >= 30 && ctx.rsiSeries1h[hIdx] <= 50 &&
      hist < 0 &&
      hist < prevHist
    );
  };

  const isInvalidatedLong = (hIdx: number) => {
    return ctx.closes1h[hIdx] < ctx.vwapSeries1h[hIdx] || ctx.ema20_1h[hIdx] < ctx.ema50_1h[hIdx];
  };

  const isInvalidatedShort = (hIdx: number) => {
    return ctx.closes1h[hIdx] > ctx.vwapSeries1h[hIdx] || ctx.ema20_1h[hIdx] > ctx.ema50_1h[hIdx];
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

  // 3. LAYER 3 — Trigger Indicators & Squeeze
  const bbIdx = i - 19;
  const bb = bbIdx >= 0 && bbIdx < ctx.bbSeries5m.length ? ctx.bbSeries5m[bbIdx] : null;
  const vwap5m = ctx.vwapSeries5m[i];
  const ema9Val = ctx.ema9_5m[i];
  const ema21Val = ctx.ema21_5m[i];
  const rsi5m = ctx.rsiSeries5m[i];
  const atr5m = ctx.atrSeries5m[i];
  const volCurr5m = ctx.vol5m[i];

  const volAvg5m = ctx.volSma5m[i] > 0 ? ctx.volSma5m[i] : calculateRollingVolumeAvg(ctx.klines5m, i, 20);
  const rvol = volAvg5m > 0 ? volCurr5m / volAvg5m : 1.0;

  if (!bb || isNaN(vwap5m) || isNaN(ema9Val) || isNaN(ema21Val) || isNaN(rsi5m) || isNaN(atr5m)) {
    return { ...fallback, bias1D, momentum1H, triggerDetail: 'Indicadores de gatillo no calculables', discardReason: 'insufficientData' };
  }

  const last100Widths = ctx.bbWidth5m.slice(Math.max(0, bbIdx - 100), bbIdx + 1).filter(v => !isNaN(v)).sort((a, b) => a - b);
  const p20BBWidth = last100Widths.length > 0 ? last100Widths[Math.floor(last100Widths.length * 0.2)] : 0;
  const last20Widths = ctx.bbWidth5m.slice(Math.max(0, bbIdx - 20), bbIdx + 1);
  const squeezePrev = last20Widths.some(w => w < p20BBWidth);

  let macdHistDir: 'CRECIENTE' | 'DECRECIENTE' | 'PLANO' = 'PLANO';
  if (!isNaN(macdHist1h) && !isNaN(macdHistPrev1h)) {
    if (macdHist1h > macdHistPrev1h) macdHistDir = 'CRECIENTE';
    else if (macdHist1h < macdHistPrev1h) macdHistDir = 'DECRECIENTE';
  }

  // 4. TRIGGERS (Pullback, Breakout, Mean Reversion)
  const checkBreakoutAtIdx = (idx: number, dir: 'LONG' | 'SHORT') => {
    if (idx < 20 || idx >= ctx.klines5m.length) return false;
    const k = ctx.klines5m[idx];
    const prevK = ctx.klines5m[idx - 1];
    const b = ctx.bbSeries5m[idx - 19];
    const prevB = ctx.bbSeries5m[idx - 20];
    const rsi = ctx.rsiSeries5m[idx];
    const vw = ctx.vwapSeries5m[idx];
    const rvolLocal = (ctx.volSma5m[idx] && ctx.volSma5m[idx] > 0) ? k.volume / ctx.volSma5m[idx] : 1.0;

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
      const gateVol = rvolLocal >= 1.8;
      const gateRSI = rsi < 50 && rsi > 25;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    }
  };

  const hasPullbackLong = (idx: number) => {
    if (idx < 10) return false;
    const low = ctx.klines5m[idx].low;
    const e9 = ctx.ema9_5m[idx];
    const e21 = ctx.ema21_5m[idx];
    const vw = ctx.vwapSeries5m[idx];
    let swingLow10 = Infinity;
    for (let s = idx - 10; s < idx; s++) {
      if (ctx.klines5m[s].low < swingLow10) swingLow10 = ctx.klines5m[s].low;
    }
    return low <= Math.max(e9, e21, vw) && low > swingLow10;
  };

  const hasPullbackShort = (idx: number) => {
    if (idx < 10) return false;
    const high = ctx.klines5m[idx].high;
    const e9 = ctx.ema9_5m[idx];
    const e21 = ctx.ema21_5m[idx];
    const vw = ctx.vwapSeries5m[idx];
    let swingHigh10 = -Infinity;
    for (let s = idx - 10; s < idx; s++) {
      if (ctx.klines5m[s].high > swingHigh10) swingHigh10 = ctx.klines5m[s].high;
    }
    return high >= Math.min(e9, e21, vw) && high < swingHigh10;
  };

  const maxPrevHigh3 = Math.max(ctx.klines5m[i - 1].high, ctx.klines5m[i - 2].high, ctx.klines5m[i - 3].high);
  const condPullbackLong = ctx.triggerMode === 'agresivo' &&
                           (hasPullbackLong(i) || hasPullbackLong(i - 1) || hasPullbackLong(i - 2)) &&
                           curr5m.close > maxPrevHigh3 &&
                           curr5m.close > curr5m.open &&
                           rvol >= 1.5 &&
                           curr5m.close > vwap5m;

  const minPrevLow3 = Math.min(ctx.klines5m[i - 1].low, ctx.klines5m[i - 2].low, ctx.klines5m[i - 3].low);
  const condPullbackShort = ctx.triggerMode === 'agresivo' &&
                            (hasPullbackShort(i) || hasPullbackShort(i - 1) || hasPullbackShort(i - 2)) &&
                            curr5m.close < minPrevLow3 &&
                            curr5m.close < curr5m.open &&
                            rvol >= 1.8 &&
                            curr5m.close < vwap5m;

  let condBreakoutLong = false;
  let condBreakoutShort = false;

  if (ctx.triggerMode === 'conservador') {
    let recentBreakoutIdx = -1;
    for (let offset = 1; offset <= 5; offset++) {
      const idx = i - offset;
      if (checkBreakoutAtIdx(idx, 'LONG')) {
        recentBreakoutIdx = idx;
        break;
      }
    }

    if (recentBreakoutIdx !== -1) {
      const breakoutBB = ctx.bbSeries5m[recentBreakoutIdx - 19];
      if (breakoutBB) {
        const level = breakoutBB.upper;
        const retestSostenido = curr5m.low >= level * 0.998 && curr5m.close > level;
        if (retestSostenido) condBreakoutLong = true;
      }
    }

    let recentBreakdownIdx = -1;
    for (let offset = 1; offset <= 5; offset++) {
      const idx = i - offset;
      if (checkBreakoutAtIdx(idx, 'SHORT')) {
        recentBreakdownIdx = idx;
        break;
      }
    }

    if (recentBreakdownIdx !== -1) {
      const breakdownBB = ctx.bbSeries5m[recentBreakdownIdx - 19];
      if (breakdownBB) {
        const level = breakdownBB.lower;
        const retestSostenido = curr5m.high <= level * 1.002 && curr5m.close < level;
        if (retestSostenido) condBreakoutShort = true;
      }
    }
  } else {
    const orb = getOpeningRange(ctx.klines5m, i, ctx.style === 'swing' ? '1h' : '5m', ctx.symbol);
    const prevOrb = getOpeningRange(ctx.klines5m, i - 1, ctx.style === 'swing' ? '1h' : '5m', ctx.symbol);

    const rvolBreakoutLong = (ctx.volSma5m[i - 1] && ctx.volSma5m[i - 1] > 0) ? ctx.vol5m[i - 1] / ctx.volSma5m[i - 1] : 1.0;
    const breakoutLongPrev = prevOrb.isActive &&
                             prev5m.close > prevOrb.high + 0.10 * ctx.atrSeries5m[i - 1] &&
                             bbIdx > 0 && prev5m.close > ctx.bbSeries5m[bbIdx - 1].upper &&
                             rvolBreakoutLong >= 1.5 &&
                             (prev5m.close - ctx.bbSeries5m[bbIdx - 1].upper) <= 1.0 * ctx.atrSeries5m[i - 1];

    condBreakoutLong = squeezePrev && breakoutLongPrev && curr5m.close > orb.high;

    const rvolBreakoutShort = (ctx.volSma5m[i - 1] && ctx.volSma5m[i - 1] > 0) ? ctx.vol5m[i - 1] / ctx.volSma5m[i - 1] : 1.0;
    const breakoutShortPrev = prevOrb.isActive &&
                              prev5m.close < prevOrb.low - 0.10 * ctx.atrSeries5m[i - 1] &&
                              bbIdx > 0 && prev5m.close < ctx.bbSeries5m[bbIdx - 1].lower &&
                              rvolBreakoutShort >= 1.8 &&
                              (ctx.bbSeries5m[bbIdx - 1].lower - prev5m.close) <= 1.0 * ctx.atrSeries5m[i - 1];

    condBreakoutShort = squeezePrev && breakoutShortPrev && curr5m.close < orb.low;
  }

  // Mean Reversion
  const condMRLong = bias1D === 'NEUTRAL' &&
                     curr5m.close < bb.lower &&
                     rsi5m < 25 &&
                     checkBullishDivergence(ctx.klines5m, ctx.rsiSeries5m, i, 10) &&
                     curr5m.close > curr5m.open;

  const condMRShort = bias1D === 'NEUTRAL' &&
                      curr5m.close > bb.upper &&
                      rsi5m > 75 &&
                      checkBearishDivergence(ctx.klines5m, ctx.rsiSeries5m, i, 10) &&
                      curr5m.close < curr5m.open;

  // 5. Candle Quality & Filters
  const minutesSinceOpen = (() => {
    const isCrypto = ctx.symbol ? (ctx.symbol.endsWith('USDT') || ctx.symbol.endsWith('BTC')) : true;
    if (isCrypto) return 60;
    let sessionStartIdx = i;
    const expectedStep = ctx.style === 'swing' ? 3600 : 300;
    const offset = 18000;
    const curDay = Math.floor((curr5m.time - offset) / 86400);
    while (sessionStartIdx > 0) {
      const prevTime = ctx.klines5m[sessionStartIdx - 1].time;
      const gap = ctx.klines5m[sessionStartIdx].time - prevTime;
      if (gap > expectedStep * 3 || Math.floor((prevTime - offset) / 86400) !== curDay) {
        break;
      }
      sessionStartIdx--;
    }
    const unitMinutes = ctx.style === 'swing' ? 60 : 5;
    return (i - sessionStartIdx + (ctx.style === 'swing' ? 1 : 0)) * unitMinutes;
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

  // 6. Confidence Score Continuous
  const getContinuousConfidence = (dir: 'LONG' | 'SHORT') => {
    const isLong = dir === 'LONG';
    const volScore = 0.30 * Math.min(rvol / 2.0, 1.0);
    const macroScore = 0.25 * (isLong ? (lastClose1d > lastEma200_1d ? 1 : 0) : (lastClose1d < lastEma200_1d ? 1 : 0));
    const macdScore = 0.20 * (isLong ? (macdHist1h > 0 ? 1 : 0) : (macdHist1h < 0 ? 1 : 0));
    const distRatio = Math.abs(curr5m.close - ema21Val) / (atr5m || 1);
    const distScore = 0.15 * Math.max(0, 1.0 - Math.abs(distRatio - 0.5) / 1.0);
    const vwapScore = 0.10 * (isLong ? (curr5m.close > vwap5m ? 1 : 0) : (curr5m.close < vwap5m ? 1 : 0));
    const totalScore = volScore + macroScore + macdScore + distScore + vwapScore;

    // Directional veto penalty: direct conflict with 1D bias cuts confidence in half
    if ((isLong && bias1D === 'BAJISTA') || (!isLong && bias1D === 'ALCISTA')) {
      return Number((totalScore * 0.5).toFixed(2));
    }
    return Number(totalScore.toFixed(2));
  };

  const confidenceScoreLong = getContinuousConfidence('LONG');
  const confidenceScoreShort = getContinuousConfidence('SHORT');

  const srLevel = calculateSupportResistance(ctx.klines5m.slice(Math.max(0, i - 100), i + 1), curr5m.close);
  const distSupport = srLevel.nearestSupport > 0 ? (curr5m.close - srLevel.nearestSupport) / curr5m.close : Infinity;
  const distResist = srLevel.nearestResistance > 0 ? (srLevel.nearestResistance - curr5m.close) / curr5m.close : Infinity;

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

  // 7. Final Signal Determination
  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let mode: 'PULLBACK' | 'BREAKOUT' | 'MEAN_REVERSION' | 'NONE' = 'NONE';
  let triggerDetail = 'Sin disparo de gatillo';

  const isBiasCompatibleLong = ctx.style === 'swing'
    ? bias1D === 'ALCISTA'
    : bias1D !== 'BAJISTA';

  const isBiasCompatibleShort = ctx.style === 'swing'
    ? bias1D === 'BAJISTA'
    : bias1D !== 'ALCISTA';

  const triggerLong = isBiasCompatibleLong && (setupArmedLong && (condPullbackLong || condBreakoutLong)) && qualityLong;
  const triggerShort = isBiasCompatibleShort && (setupArmedShort && (condPullbackShort || condBreakoutShort)) && qualityShort;
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

  let discardReason: keyof DiscardBreakdown | undefined;
  if (signal !== 'NEUTRAL' && confidenceScore < 0.65) {
    signal = 'NEUTRAL';
    mode = 'NONE';
    triggerDetail = `Confidence Score insuficiente: ${(confidenceScore * 100).toFixed(0)}% (requerido >= 65%)`;
  }

  if (signal === 'NEUTRAL') {
    const isCrypto = ctx.symbol ? (ctx.symbol.endsWith('USDT') || ctx.symbol.endsWith('BTC')) : true;
    if ((setupArmedLong && !isBiasCompatibleLong) || (setupArmedShort && !isBiasCompatibleShort)) {
      discardReason = 'regimeFilter';
    } else if (!setupArmedLong && !setupArmedShort) {
      discardReason = 'regimeFilter';
    } else if (rvol < (isCrypto ? 1.5 : 1.2)) {
      discardReason = 'volumeFilter';
    } else if (upperWickRatio(curr5m) > 0.35 || lowerWickRatio(curr5m) > 0.35 || candleBodyRatio(curr5m) < 0.3) {
      discardReason = 'candleAnatomy';
    } else {
      discardReason = 'noSetup';
    }
  }

  const tradeType: 'DAY' | 'SWING' = ctx.style === 'swing' ? 'SWING' : 'DAY';

  let confidence: 'ALTA' | 'MODERADA' | 'DESCARTAR' = 'DESCARTAR';
  if (signal !== 'NEUTRAL') {
    if (confidenceScore >= 0.75) confidence = 'ALTA';
    else if (confidenceScore >= 0.65) confidence = 'MODERADA';
  }

  // 8. Risk Management & Targets
  let stopLoss = 0;
  let takeProfit1 = 0;
  let takeProfit2 = 0;
  let takeProfit3 = 0;
  let riskRewardRatio = 0;
  let chandelierExit = 0;

  const entry = (executionPrice && executionPrice > 0) ? executionPrice : curr5m.close;
  const lookbackS = Math.max(0, i - (tradeType === 'SWING' ? 5 : 10));
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (let s = lookbackS; s < i; s++) {
    if (ctx.klines5m[s].low < swingLow) swingLow = ctx.klines5m[s].low;
    if (ctx.klines5m[s].high > swingHigh) swingHigh = ctx.klines5m[s].high;
  }

  const atrMultLong = 1.5;
  const atrMultShort = 1.8;
  const tp1Mult = 2.0;
  const tp2Mult = 3.5;
  const tp3Mult = 5.0;

  const chandelierLong = ctx.chandelierData.long[idx1h];
  const chandelierShort = ctx.chandelierData.short[idx1h];

  if (signal === 'BUY') {
    const slATR = entry - atrMultLong * atr5m;
    const slStruct = swingLow > 0 && swingLow < Infinity ? (swingLow - 0.20 * atr5m) : slATR;
    stopLoss = Math.min(slATR, slStruct);
    let risk = entry - stopLoss;
    if (risk <= 0) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      confidence = 'DESCARTAR';
      triggerDetail = 'Descartado: Stop loss inválido (riesgo <= 0)';
      discardReason = 'riskFilter';
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
        discardReason = 'riskFilter';
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
    const slStruct = swingHigh > -Infinity ? (swingHigh + 0.20 * atr5m) : slATR;
    stopLoss = Math.max(slATR, slStruct);
    let risk = stopLoss - entry;
    if (risk <= 0) {
      signal = 'NEUTRAL';
      mode = 'NONE';
      confidence = 'DESCARTAR';
      triggerDetail = 'Descartado: Stop loss inválido (riesgo <= 0)';
      discardReason = 'riskFilter';
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
        discardReason = 'riskFilter';
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

  const accountEquity = 10000;
  const riskAmount = 100;
  const stopDistance = Math.abs(entry - stopLoss);
  let positionSizeUnits = (signal !== 'NEUTRAL' && stopDistance > 0) ? riskAmount / stopDistance : 0;
  const maxUnits = entry > 0 ? (0.20 * accountEquity) / entry : 0;
  positionSizeUnits = Math.min(positionSizeUnits, maxUnits);

  const marketRegime = atrVal1h > 1.2 * atrSma1h ? 'Alta Volatilidad' : 'Normal';
  const volatilityProfile = ctx.avgDailyRange > 3.5 ? 'Alta Volatilidad' : 'Normal';
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
    nearestSupport: srLevel.nearestSupport,
    nearestResistance: srLevel.nearestResistance,
    score: baseScore,
    baseScore,
    adaptiveFactor: 1.0,
    marketRegime,
    volatilityProfile,
    recentPerfLabel: 'VCME v2.0 Activo',
    atrPercent,
    avgDailyRange: ctx.avgDailyRange,
    confidence,
    discardReason,
    snapshot: {
      atr_5m: Number(atr5m.toFixed(2)),
      atr_1H: Number(atrVal1h.toFixed(2)),
      ema21_1H: Number(ema20Val1h.toFixed(2)),
      vwap_5m: Number(vwap5m.toFixed(2)),
      rvol: Number(rvol.toFixed(2))
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. MULTIFRACTAL MTF ENGINE (Signal 5)
// ═══════════════════════════════════════════════════════════════════════════

export interface MultifractalMTFContext {
  klines5m: Kline[];
  klines1h: Kline[];
  klines1d: Kline[];
  symbol: string;
  // 1D
  andianSeries: ReturnType<typeof calculateAndianOscillator>;
  // 1H
  volBands1H: ReturnType<typeof calculateRevolutionVolatilityBand>;
  // 5M
  volBands5M: ReturnType<typeof calculateRevolutionVolatilityBand>;
  volComp5M: ReturnType<typeof calculateVolumeComposition>;
  dreadBlitz5M: ReturnType<typeof calculateDreadBlitz>;
  atrSeries5M: number[];
  adxData5M: ReturnType<typeof calculateADXSeries>;
  // Time maps
  idx1hMap: Int32Array;
  idx1dMap: Int32Array;
}

export interface MultifractalMTFEvaluationResult extends MultifractalMTFSignalResult {
  discardReason?: keyof DiscardBreakdown;
}

export function buildMultifractalMTFContext(
  klines5m: Kline[],
  klines1h: Kline[],
  klines1d: Kline[],
  symbol: string = 'ASSET'
): MultifractalMTFContext {
  const len5m = klines5m ? klines5m.length : 0;
  const len1h = klines1h ? klines1h.length : 0;
  const len1d = klines1d ? klines1d.length : 0;

  const andianSeries = (klines1d && klines1d.length >= 14) ? calculateAndianOscillator(klines1d) : [];
  const volBands1H = (klines1h && klines1h.length >= 20) ? calculateRevolutionVolatilityBand(klines1h) : [];
  const volBands5M = (klines5m && klines5m.length >= 20) ? calculateRevolutionVolatilityBand(klines5m) : [];
  const volComp5M = (klines5m && klines5m.length >= 20) ? calculateVolumeComposition(klines5m) : [];
  const dreadBlitz5M = (klines5m && klines5m.length >= 20) ? calculateDreadBlitz(klines5m) : [];
  const atrSeries5M = (klines5m && klines5m.length >= 14) ? calculateATRSeries(klines5m, 14) : [];
  const adxData5M = (klines5m && klines5m.length >= 29) ? calculateADXSeries(klines5m, 14) : { adx: [], plusDI: [], minusDI: [] };

  const idx1hMap = new Int32Array(len5m).fill(-1);
  const idx1dMap = new Int32Array(len5m).fill(-1);

  if (len5m > 0 && len1h > 0) {
    let hCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      while (hCursor + 1 < len1h && (klines1h[hCursor + 1].time + 3600) <= t) {
        hCursor++;
      }
      if ((klines1h[hCursor].time + 3600) <= t) {
        idx1hMap[i] = hCursor;
      }
    }
  }

  if (len5m > 0 && len1d > 0) {
    let dCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      while (dCursor + 1 < len1d && (klines1d[dCursor + 1].time + 86400) <= t) {
        dCursor++;
      }
      if ((klines1d[dCursor].time + 86400) <= t) {
        idx1dMap[i] = dCursor;
      }
    }
  }

  return {
    klines5m, klines1h, klines1d, symbol,
    andianSeries, volBands1H, volBands5M, volComp5M, dreadBlitz5M, atrSeries5M, adxData5M,
    idx1hMap, idx1dMap
  };
}

export function evaluateMultifractalMTFAt(
  ctx: MultifractalMTFContext,
  i: number,
  executionPrice?: number
): MultifractalMTFEvaluationResult {
  const fallback: MultifractalMTFEvaluationResult = {
    signal: 'NEUTRAL', strategy: 'NONE', stopLoss: 0, triggerPrice: 0,
    isCompressed1H: false, bias1D: 'NEUTRAL', activeVolumePercent5M: 0, volumeMultiplier5M: 0,
    andianGreen: 0, andianRed: 0, andianOrange: 0, volatilityWidth1H: 0, dreadBlitzMCD: 0,
    isOverbought5M: false, isOversold5M: false,
    reasoning: 'Datos insuficientes — se requieren al menos 20 velas de 5m'
  };

  if (!ctx.klines5m || ctx.klines5m.length < 20 || i < 19 || i >= ctx.klines5m.length) {
    return { ...fallback, discardReason: 'insufficientData' };
  }

  // 1. MACRO FILTER (1D - Andian)
  let bias1D: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let lastAndian = { green: 0, red: 0, orange: 0, bias: 'NEUTRAL' as 'BULLISH' | 'BEARISH' | 'NEUTRAL' };
  const idx1d = ctx.idx1dMap[i];
  if (idx1d >= 0 && idx1d < ctx.andianSeries.length) {
    lastAndian = ctx.andianSeries[idx1d];
    bias1D = lastAndian.bias;
  } else if (ctx.andianSeries.length > 0 && i === ctx.klines5m.length - 1) {
    lastAndian = ctx.andianSeries[ctx.andianSeries.length - 1];
    bias1D = lastAndian.bias;
  }

  // 2. CONTEXT FILTER (1H - Revolution Volatility Band Squeeze)
  let isCompressed1H = false;
  let current1HBand = { width: 0, midpoint: 0, upper: 0, lower: 0 };
  const idx1h = ctx.idx1hMap[i];
  if (idx1h >= 0 && idx1h < ctx.volBands1H.length) {
    const recent1H = ctx.volBands1H.slice(Math.max(0, idx1h - 3), idx1h + 1);
    isCompressed1H = recent1H.some(b => b.isCompressed);
    current1HBand = ctx.volBands1H[idx1h];
  } else if (ctx.volBands1H.length > 0 && i === ctx.klines5m.length - 1) {
    const recent1H = ctx.volBands1H.slice(-4);
    isCompressed1H = recent1H.some(b => b.isCompressed);
    current1HBand = ctx.volBands1H[ctx.volBands1H.length - 1];
  }

  // 3. TRIGGER CONDITIONS (5M)
  const currCandle = ctx.klines5m[i];
  const prevCandle = i > 0 ? ctx.klines5m[i - 1] : currCandle;
  const currVolComp = (i < ctx.volComp5M.length) ? ctx.volComp5M[i] : { volumeMultiplier: 1, activeBuyPercent: 50, activeSellPercent: 50, isPassiveBuyAbsorption: false, isPassiveSellAbsorption: false };
  const curr5MBand = (i < ctx.volBands5M.length) ? ctx.volBands5M[i] : { upper: currCandle.high, lower: currCandle.low, midpoint: currCandle.close, width: 0, isCompressed: false };
  const currDread = (i < ctx.dreadBlitz5M.length) ? ctx.dreadBlitz5M[i] : { isOverbought: false, isOversold: false, mcd: 0 };
  const prevDread = (i > 0 && (i - 1) < ctx.dreadBlitz5M.length) ? ctx.dreadBlitz5M[i - 1] : currDread;

  const isNyseOpening = isNyseOpeningWindow(currCandle.time, ctx.symbol);
  const minVolMultiplier = isNyseOpening ? 2.5 : 1.5;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let strategy: 'BREAKOUT_EXPANSION' | 'MEAN_REVERSION' | 'NONE' = 'NONE';
  let stopLoss = 0;
  let reasoning = '';

  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN (LONG)
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
  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN (SHORT)
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
    currDread.mcd > prevDread.mcd &&
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
    currDread.mcd < prevDread.mcd &&
    currVolComp.isPassiveSellAbsorption
  ) {
    signal = 'SELL';
    strategy = 'MEAN_REVERSION';
    stopLoss = currCandle.high + (curr5MBand.upper - curr5MBand.lower) * 0.25;
    reasoning = `Placing SL above absorption high (${formatSmartPrice(stopLoss)}) for mean reversion divergence.`;
  }

  // 4. RISK BOUNDS & DIRECTIONAL VALIDITY
  const atr5m = (i < ctx.atrSeries5M.length && !isNaN(ctx.atrSeries5M[i]) && ctx.atrSeries5M[i] > 0)
    ? ctx.atrSeries5M[i]
    : (currCandle.close * 0.005);
  const minRisk = 0.8 * atr5m;
  const maxRisk = 2.0 * atr5m;
  const maxAllowedRiskPct = 0.025; // 2.5%

  const triggerPrice = (executionPrice && executionPrice > 0) ? executionPrice : currCandle.close;

  let discardReason: keyof DiscardBreakdown | undefined;

  if (signal !== 'NEUTRAL' && stopLoss > 0) {
    let risk = signal === 'BUY' ? triggerPrice - stopLoss : stopLoss - triggerPrice;
    const isValidRisk = signal === 'BUY' ? stopLoss < triggerPrice : stopLoss > triggerPrice;

    if (!isValidRisk || risk <= 0) {
      signal = 'NEUTRAL';
      strategy = 'NONE';
      discardReason = 'riskFilter';
      reasoning = `Discarded: Invalid Stop Loss position relative to trigger price (${formatSmartPrice(stopLoss)} vs ${formatSmartPrice(triggerPrice)}).`;
    } else {
      if (risk < minRisk) {
        stopLoss = signal === 'BUY' ? triggerPrice - minRisk : triggerPrice + minRisk;
        risk = minRisk;
        reasoning += ` [SL expanded to minimum bound 0.8*ATR: ${formatSmartPrice(stopLoss)}]`;
      }

      const riskPct = triggerPrice > 0 ? risk / triggerPrice : 0;
      if (risk > maxRisk || riskPct > maxAllowedRiskPct) {
        signal = 'NEUTRAL';
        strategy = 'NONE';
        discardReason = 'riskFilter';
        reasoning = `Discarded: Risk of ${formatSmartNumber(riskPct * 100)}% (${formatSmartNumber(risk / atr5m)} ATR) exceeds maximum allowed bounds (2.5% or 2.0 ATR).`;
      }
    }
  } else if (signal === 'NEUTRAL') {
    if (currVolComp.volumeMultiplier < minVolMultiplier) {
      discardReason = 'volumeFilter';
    } else if (bias1D === 'NEUTRAL') {
      discardReason = 'regimeFilter';
    } else {
      discardReason = 'noSetup';
    }
  }

  return {
    signal,
    strategy,
    stopLoss,
    triggerPrice,
    isCompressed1H,
    bias1D,
    activeVolumePercent5M: signal === 'BUY' ? currVolComp.activeBuyPercent : (signal === 'SELL' ? currVolComp.activeSellPercent : Math.max(currVolComp.activeBuyPercent, currVolComp.activeSellPercent)),
    volumeMultiplier5M: currVolComp.volumeMultiplier,
    andianGreen: lastAndian.green,
    andianRed: lastAndian.red,
    andianOrange: lastAndian.orange,
    volatilityWidth1H: current1HBand.width,
    dreadBlitzMCD: currDread.mcd,
    isOverbought5M: currDread.isOverbought,
    isOversold5M: currDread.isOversold,
    reasoning: reasoning || 'No trigger condition met on current 5m candle',
    discardReason
  };
}
