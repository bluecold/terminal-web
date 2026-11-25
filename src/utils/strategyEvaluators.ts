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
  calculateVWAPReliabilitySeries,
  calculateMACDSeries,
  type MACDSeriesData,
  calculateATRSeries,
  calculateADXSeries,
  calculateSupportResistance,
  calculateRawPivotLevels,
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
  isShootingStar,
  isEngulfing,
  detectEmaCrossoverFromSeries,
  getOpeningRange,
  isNyseOpeningWindow,
  calculateRollingVolumeAvg,
  type ScoringWeights,
  type ScoringConfig,
  DEFAULT_WEIGHTS,
  SCORING_CONFIG,
  type ScoringResult,
  type StandardVotingResult,
  type VCMESniperResult,
  type MultifractalMTFSignalResult,
  type EmaCrossover,
  calculateFractalPivotsSeries,
  type FractalPivotsSeries,
  isMFLSSessionWindow,
  isNyseMiddayChop,
  isNearNyseSessionClose,
  isNyseOpeningHour,
  isNyseOpeningCross
} from './indicators';
import { formatSmartPrice, formatSmartNumber } from './formatters';
import { calculateAlertLevels, isCryptoAsset } from './tradeLevels';
import type { DiscardBreakdown } from './backtester';

// ==========================================
// 1. CONFLUENCIA ENGINE (Signal 1)
// ==========================================

export interface ConfluenciaContext {
  klines: Kline[];
  interval: string;
  closes: number[];
  ema9: number[];
  ema20: number[];
  vwap: number[];
  vwapReliable?: boolean[];
  atr: number[];
  volSMA: number[];
  adx?: ReturnType<typeof calculateADXSeries>;
  isCrypto?: boolean;
}

export interface ConfluenciaEvaluationResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  stopLoss: number;
  validVolume: boolean;
  emaCrossover: EmaCrossover;
  /** ATR(14) / close of the evaluated candle (0 when unavailable). */
  atrPct?: number;
  /** True when a 5m equity setup was neutralized by the minimum-volatility guard. */
  lowVolatility?: boolean;
  /** Direction of the setup neutralized by the volatility guard (research and telemetry). */
  blockedSignal?: 'BUY' | 'SELL';
}

/**
 * Minimum ATR(14)/close for Confluencia on 5m equities. Below it, the 0.14% round-trip friction
 * eats too much of the 2 ATR stop: out-of-sample (2026-07-22 → 2026-10-14, 49 unseen symbols plus
 * 14 new sessions on 57 known ones) the rejected setups lost −0.23R to −0.32R per alert, while the
 * accepted ones were roughly break-even. It protects capital; it does not create a positive edge.
 */
export const CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT = 0.005;

export function buildConfluenciaContext(
  klines: Kline[],
  interval: string = '1h',
  symbolOrIsCrypto?: string | boolean
): ConfluenciaContext {
  const isCrypto = typeof symbolOrIsCrypto === 'boolean' ? symbolOrIsCrypto : isCryptoAsset(symbolOrIsCrypto);
  const length = klines ? klines.length : 0;
  if (length === 0) {
    return { klines: [], interval, closes: [], ema9: [], ema20: [], vwap: [], vwapReliable: [], atr: [], volSMA: [], isCrypto };
  }

  const closes = klines.map(k => k.close);
  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  const vwap = calculateVWAPSeries(klines, interval);
  const vwapReliable = calculateVWAPReliabilitySeries(klines, interval);
  const atr = calculateATRSeries(klines, 14);

  const volSMA = new Array(length).fill(0);
  let sumVol = 0;
  for (let i = 0; i < Math.min(20, length); i++) {
    sumVol += klines[i].volume;
  }
  if (length >= 20) volSMA[19] = sumVol / 20;
  for (let i = 20; i < length; i++) {
    volSMA[i] = sumVol / 20;
    sumVol = sumVol - klines[i - 20].volume + klines[i].volume;
  }

  const adx = calculateADXSeries(klines, 14);

  return { klines, interval, closes, ema9, ema20, vwap, vwapReliable, atr, volSMA, adx, isCrypto };
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
  const shootingStar = isShootingStar(curr);
  const engulf = isEngulfing(curr, prev);
  const bRatio = candleBodyRatio(curr);

  const e9 = ctx.ema9[i];
  const e20 = ctx.ema20[i];
  const vw = ctx.vwap[i];
  const isVwapReliable = ctx.vwapReliable && ctx.vwapReliable.length > i ? ctx.vwapReliable[i] : true;
  const vAvg = ctx.volSMA[i];
  const atr = ctx.atr[i];

  const cp = closePosition(curr);
  const distVwapAtr = atr > 0 ? Math.abs(curr.close - vw) / atr : 0;
  const isNotOverextended = isVwapReliable ? distVwapAtr <= 2.2 : true;

  const strongBullish = curr.close > curr.open && bRatio >= 0.4 && curr.close > e9;
  const strongBearish = curr.close < curr.open && bRatio >= 0.4 && curr.close < e9;
  const validBullishCandle = hammer || (engulf === 1 && bRatio >= 0.3) || strongBullish;
  const validBearishCandle = shootingStar || (engulf === -1 && bRatio >= 0.3) || strongBearish;

  // Symmetrical VWAP gate: in the first 2 bars of a session, VWAP is degenerate (HLC3 coin flip)
  // Neutralize the VWAP gate during session opening to eliminate systematic false positives
  const vwapBuyOk = isVwapReliable ? curr.close > vw : true;
  const vwapSellOk = isVwapReliable ? curr.close < vw : true;

  // Confluencia requires valid market volume: must be positive and >= 0.8 * vAvg
  // For zero-volume symbols (^VIX, Yahoo Forex), volume = 0 must NOT pass the filter
  const validVolume = curr.volume > 0 && vAvg > 0 && curr.volume >= vAvg * 0.8;

  const is_buy = vwapBuyOk && e9 > e20 && validVolume
                  && validBullishCandle && isNotOverextended && cp >= 0.50;
  const is_sell = vwapSellOk && e9 < e20 && validVolume
                  && validBearishCandle && isNotOverextended && cp <= 0.50;

  const is5m = (ctx.interval || '').toLowerCase() === '5m';
  const isEquity = ctx.isCrypto === false;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (is_buy) signal = 'BUY';
  else if (is_sell) signal = 'SELL';

  // Session guard for 5m equities: Confluencia only has net edge in the opening window
  // (09:35–11:00 ET). The former afternoon ADX >= 25 window (14:00–15:15 ET) was removed:
  // 90 signals over 60 days on the 21-symbol watchlist at -0.23R net.
  if (isEquity && is5m && signal !== 'NEUTRAL' && curr && curr.time) {
    const candleMs = curr.time > 1e11 ? curr.time : curr.time * 1000;
    if (!isNyseOpeningHour(candleMs)) {
      signal = 'NEUTRAL';
    }
  }

  // Volatility guard for 5m equities: no setup when ATR(14) < 0.5% of the price.
  const atrPct = curr.close > 0 && atr > 0 ? atr / curr.close : 0;
  let lowVolatility = false;
  let blockedSignal: 'BUY' | 'SELL' | undefined;
  if (isEquity && is5m && signal !== 'NEUTRAL' && !(atrPct >= CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT)) {
    blockedSignal = signal;
    signal = 'NEUTRAL';
    lowVolatility = true;
  }

  const rawDistPct = curr.close > 0 && atr > 0 ? (2 * atr) / curr.close : 0.008;
  const effectiveStopPct = is5m ? Math.max(0.004, rawDistPct) : rawDistPct;
  const stopLossLong = curr.close * (1 - effectiveStopPct);
  const stopLossShort = curr.close * (1 + effectiveStopPct);
  const stopLoss = signal === 'BUY' ? stopLossLong : (signal === 'SELL' ? stopLossShort : 0);

  const emaCrossover = detectEmaCrossoverFromSeries(ctx.ema9, ctx.ema20, i, 5);

  return {
    signal,
    stopLoss,
    validVolume,
    emaCrossover,
    atrPct,
    lowVolatility,
    ...(blockedSignal ? { blockedSignal } : {})
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. SCORING MULTICAPA (Signal 2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Empirical scoring threshold multiplier calibrated against real watchlist market data
 * (achieving >= 80% to 100% compliance with minHighResolved >= 8 in 5m and >= 5 in 1h
 * without noise over-trading):
 * - 5m: 7.00 * 0.45 = 3.15
 * - 1h/1d: 8.50 * 0.45 = 3.83
 */
export const DEFAULT_SCORING_THRESHOLD_RATIO = 0.45;

export interface ScoringSRCacheItem {
  nearestSupport?: number;
  nearestResistance?: number;
  supports?: number[];
  resistances?: number[];
  pivotHighs?: number[];
  pivotLows?: number[];
}

export interface ScoringContext {
  klines: Kline[];
  interval: string;
  weights: ScoringWeights;
  cfg: ScoringConfig;
  closes: number[];
  emaFastArr: number[];
  emaSlowArr: number[];
  emaMajorArr: number[];
  rsiSeries: number[];
  bbSeries: BollingerBandsSeriesResult[];
  vwapSeries: number[];
  vwapReliableSeries?: boolean[];
  atrSeries: number[];
  obvArr: number[];
  obvEMAArr: number[];
  volRollingArr?: number[];
  srCache: Map<number, ScoringSRCacheItem>;
  isCrypto?: boolean;
}

export function buildScoringContext(
  klines: Kline[],
  interval: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  symbolOrIsCrypto?: string | boolean
): ScoringContext {
  const isCrypto = typeof symbolOrIsCrypto === 'boolean' ? symbolOrIsCrypto : isCryptoAsset(symbolOrIsCrypto);
  const length = klines ? klines.length : 0;
  const cfg = SCORING_CONFIG[interval] ?? SCORING_CONFIG['1h'];
  if (length === 0) {
    return {
      klines: [], interval, weights, cfg, closes: [], emaFastArr: [], emaSlowArr: [], emaMajorArr: [],
      rsiSeries: [], bbSeries: [], vwapSeries: [], vwapReliableSeries: [], atrSeries: [], obvArr: [], obvEMAArr: [], volRollingArr: [], srCache: new Map(), isCrypto
    };
  }

  const closes = klines.map(k => k.close);
  const emaFastArr = calculateEMA(closes, cfg.emaFast);
  const emaSlowArr = calculateEMA(closes, cfg.emaSlow);
  const emaMajorArr = cfg.emaMajor ? calculateEMA(closes, cfg.emaMajor) : new Array(length).fill(NaN);
  const rsiSeries = calculateRSISeries(closes, cfg.rsiPeriod);
  const bbSeries = calculateBollingerBandsSeries(klines, cfg.bbPeriod);
  const vwapSeries = cfg.useVwap ? calculateVWAPSeries(klines, interval) : new Array(length).fill(0);
  const vwapReliableSeries = cfg.useVwap ? calculateVWAPReliabilitySeries(klines, interval) : new Array(length).fill(true);
  const atrSeries = calculateATRSeries(klines, 14);

  let obvArr: number[] = [];
  let obvEMAArr: number[] = [];
  let volRollingArr: number[] = [];
  if (cfg.useObv) {
    obvArr = [0];
    for (let i = 1; i < length; i++) {
      if (closes[i] > closes[i - 1])      obvArr.push(obvArr[i - 1] + klines[i].volume);
      else if (closes[i] < closes[i - 1]) obvArr.push(obvArr[i - 1] - klines[i].volume);
      else                                obvArr.push(obvArr[i - 1]);
    }
    obvEMAArr = calculateEMA(obvArr, 10);
    volRollingArr = new Array(length);
    for (let idx = 0; idx < length; idx++) {
      volRollingArr[idx] = calculateRollingVolumeAvg(klines, idx, 20);
    }
  }

  // Aligned 5-bar checkpoint cache for S/R:
  // Caches raw clustered pivot highs and pivot lows without pre-filtering against klines[idx].close,
  // preventing level blindness when price moves between snapshot intervals.
  const srCacheInterval = 5;
  const srCache: Map<number, ScoringSRCacheItem> = new Map();
  const startIdx = Math.max(0, Math.floor(55 / srCacheInterval) * srCacheInterval);
  for (let idx = startIdx; idx < length; idx += srCacheInterval) {
    const windowStart = Math.max(0, idx - 100);
    const windowSlice = klines.slice(windowStart, idx + 1);
    const { pivotHighs, pivotLows } = calculateRawPivotLevels(windowSlice, 5);
    srCache.set(idx, {
      pivotHighs,
      pivotLows
    });
  }

  return {
    klines, interval, weights, cfg, closes, emaFastArr, emaSlowArr, emaMajorArr,
    rsiSeries, bbSeries, vwapSeries, vwapReliableSeries, atrSeries, obvArr, obvEMAArr, srCache, isCrypto
  };
}

export function evaluateScoringAt(ctx: ScoringContext, i: number, effectivePrice?: number): ScoringResult {
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
  const evalPrice = (effectivePrice !== undefined && effectivePrice > 0) ? effectivePrice : closeVal;
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
    const atr = ctx.atrSeries[i];
    const distEmaAtr = atr > 0 ? (closeVal - em) / atr : (closeVal > em ? 1 : -1);
    const s1Major = Math.tanh(distEmaAtr);
    s1 += s1Major;
    n1 += ` | Sobre/Bajo EMA${cfg.emaMajor} (${s1Major >= 0 ? '+' : ''}${s1Major.toFixed(2)})`;
  }

  // Layer 2 — RSI con pendiente simétrica (matriz espejo alrededor de 50)
  const rsi = ctx.rsiSeries[i];
  const rsiSlopeVal = calculateRSISlope(ctx.rsiSeries, i, 3);
  const rsiRising = rsiSlopeVal > 0;
  const rsiFalling = rsiSlopeVal < 0;

  let s2 = 0;
  let n2 = `RSI(${cfg.rsiPeriod}): ${isNaN(rsi) ? '-' : rsi.toFixed(1)}`;
  if (isNaN(rsi)) {
    n2 += ' | Datos insuficientes';
  } else if (!rsiRising && !rsiFalling) {
    // RSI plano (variación <= 1.5 puntos en 3 velas): estrictamente neutral
    s2 = 0.0;
    n2 += ' | Plano (neutral)';
  } else if (rsiRising) {
    if (rsi > 80) {
      s2 = 0.0;
      n2 += ' | Sobrecompra extrema >80 (agotamiento)';
    } else if (rsi >= 72) {
      s2 = 0.5;
      n2 += ' | Impulso extendido ▲ (+0.5)';
    } else if (rsi >= 50) {
      s2 = 1.0;
      n2 += ' | Sobre 50 ▲ (momentum +)';
    } else if (rsi >= 40) {
      s2 = 1.0;
      n2 += ' | Pullback en tendencia ▲ (recuperando)';
    } else if (rsi >= 28) {
      s2 = 0.5;
      n2 += ' | Rebote técnico en soporte ▲ (+0.5)';
    } else if (rsi >= 20) {
      s2 = 0.5;
      n2 += ' | Rebote desde sobreventa ▲ (+0.5)';
    } else {
      // rsi < 20 subiendo
      s2 = 0.5;
      n2 += ' | Rebote desde capitulación extrema ▲ (+0.5)';
    }
  } else {
    // rsiFalling — matriz simétrica alrededor de 50 (espejo exacto de rsiRising)
    if (rsi < 20) {
      // Sobreventa extrema (<20): neutraliza para evitar vender suelos de capitulación
      s2 = 0.0;
      n2 += ' | Sobreventa extrema <20 (agotamiento bajista)';
    } else if (rsi <= 28) {
      s2 = -0.5;
      n2 += ' | Sobreventa extendida ▼ (-0.5)';
    } else if (rsi <= 40) {
      s2 = -1.0;
      n2 += ' | Impulso bajista (<40 ▼)';
    } else if (rsi <= 50) {
      s2 = -1.0;
      n2 += ' | Impulso bajista hacia sobreventa ▼';
    } else if (rsi <= 60) {
      s2 = -1.0;
      n2 += ' | Impulso bajista bajo 60 ▼';
    } else if (rsi <= 72) {
      s2 = -0.5;
      n2 += ' | Pullback en tendencia alcista ▼ (-0.5)';
    } else if (rsi <= 80) {
      s2 = -0.5;
      n2 += ' | Rechazo desde sobrecompra ▼ (-0.5)';
    } else {
      // rsi > 80 bajando
      s2 = -0.5;
      n2 += ' | Rechazo desde sobrecompra extrema ▼ (-0.5)';
    }
  }

  // Layer 3 — Bollinger %B, Squeeze y Expansión de Volatilidad
  let s3 = 0;
  let n3 = '';
  const bbIdx = i - (cfg.bbPeriod - 1);
  const bb = bbIdx >= 0 && bbIdx < ctx.bbSeries.length ? ctx.bbSeries[bbIdx] : null;
  if (bb) {
    const bandWidth = bb.upper - bb.lower;
    const pctB = bandWidth > 0 ? (closeVal - bb.lower) / bandWidth : 0.5;
    n3 = `%B: ${pctB.toFixed(2)}`;

    const bbMiddle = (bb.upper + bb.lower) / 2;
    const bbWidthRatio = bbMiddle > 0 ? bandWidth / bbMiddle : 0;

    // Squeeze adaptativo dinámico:
    // En velas cortas (5m de acciones/cripto), el ancho de banda normal es de 0.5% a 1.5%.
    // Un squeeze real representa una contracción estadística significativa respecto a la volatilidad reciente:
    // 1) Si hay historial rodante (>= 10 velas), el ancho actual debe ser < 75% del promedio reciente de las últimas 30 velas.
    // 2) Piso absoluto de compresión por temporalidad (0.004 en 5m, 0.010 en 1h, 0.020 en 1d).
    // 3) Salvaguarda para series sintéticas o cortas (< 10 velas en tests unitarios): bbWidthRatio < 0.05.
    let sumWidthRatio = 0;
    let countWidthRatio = 0;
    const lookback = 30;
    const startBBIdx = Math.max(0, bbIdx - lookback);
    for (let k = startBBIdx; k <= bbIdx; k++) {
      const bItem = ctx.bbSeries[k];
      if (bItem) {
        const bMid = (bItem.upper + bItem.lower) / 2;
        if (bMid > 0) {
          sumWidthRatio += (bItem.upper - bItem.lower) / bMid;
          countWidthRatio++;
        }
      }
    }
    const avgWidthRatio = countWidthRatio > 0 ? sumWidthRatio / countWidthRatio : 0;
    const isSqueeze = (countWidthRatio >= 10 && avgWidthRatio > 0 && bbWidthRatio < avgWidthRatio * 0.70)
      || (countWidthRatio < 10 && bbWidthRatio < 0.03);

    const uWick = upperWickRatio(curr);
    const lWick = lowerWickRatio(curr);
    const isBullCandle = curr.close >= curr.open;

    if (isSqueeze) {
      // En compresión alta de volatilidad (Squeeze):
      // Si rompe con vela verde sobre la media, premia la liberación de volatilidad alcista
      if (closeVal >= bbMiddle && isBullCandle) {
        s3 = 1.0;
        n3 += ' | Squeeze con ruptura alcista';
      } else if (closeVal <= bbMiddle && !isBullCandle) {
        s3 = -1.0;
        n3 += ' | Squeeze con ruptura bajista';
      } else {
        s3 = 0.0;
        n3 += ' | Squeeze (alta compresión)';
      }
    } else {
      // Fuera de squeeze: evaluar expansión direccional vs sobreextensión
      if (pctB >= 0.70) {
        // Mitad superior expandida:
        if (pctB <= 0.95) {
          // Cabalgando banda superior en expansión sana
          if (isBullCandle && uWick <= 0.25) {
            s3 = 1.0;
            n3 += ' | Walking upper band (impulso fuerte)';
          } else if (uWick > 0.25) {
            s3 = -0.5;
            n3 += ' | Rechazo en banda sup. (mecha)';
          } else {
            s3 = 0.5;
            n3 += ' | En banda sup. (expansión)';
          }
        } else {
          // Sobreextensión extrema (>0.95) fuera de la banda: riesgo de rechazo o clímax
          if (uWick > 0.20) {
            s3 = -0.5;
            n3 += ' | Rechazo en techo de banda sup.';
          } else if (isBullCandle && uWick <= 0.15) {
            s3 = 1.0;
            n3 += ' | Walking upper band (ruptura climática)';
          } else {
            s3 = 0.0;
            n3 += ' | Sobreextendido fuera de banda sup.';
          }
        }
      } else if (pctB <= 0.30) {
        // Mitad inferior expandida:
        if (pctB >= 0.05) {
          // Cerca banda inferior:
          if (lWick >= 0.25) {
            // Mecha de absorción/rebote independientemente de si el cuerpo cerró verde o rojo
            s3 = 0.5;
            n3 += ' | Rebote en soporte dinámico inf.';
          } else if (!isBullCandle) {
            s3 = -1.0;
            n3 += ' | Presión bajista hacia banda inf.';
          } else {
            s3 = 0.0;
            n3 += ' | Dentro de bandas';
          }
        } else {
          // En o bajo la banda inferior (pctB < 0.05):
          if (lWick >= 0.25) {
            // Mecha inferior: absorción institucional en soporte dinámico
            s3 = 0.5;
            n3 += ' | Absorción en banda inf. (rebote)';
          } else if (!isBullCandle && lWick <= 0.15) {
            s3 = -1.0;
            n3 += ' | Walking lower band (impulso bajista)';
          } else {
            s3 = 0.0;
            n3 += ' | En banda inf.';
          }
        }
      } else {
        // Dentro de la zona media neutral [0.30, 0.70]
        s3 = 0.0;
        n3 += ' | Dentro de bandas';
      }
    }
  } else {
    n3 = 'Bollinger no disponible';
  }

  // Layer 4 — Volumen: VWAP u OBV
  let s4 = 0;
  let n4 = '';
  if (cfg.useVwap) {
    const vwap = ctx.vwapSeries[i];
    const isVwapReliable = ctx.vwapReliableSeries && ctx.vwapReliableSeries.length > i ? ctx.vwapReliableSeries[i] : true;

    if (!isVwapReliable) {
      s4 = 0;
      n4 = `VWAP: ${formatSmartNumber(vwap)} | Apertura de sesión (VWAP no fiable neutralizado)`;
    } else {
      const atr = ctx.atrSeries[i];
      const distAtr = atr > 0 ? (closeVal - vwap) / atr : 0;

      // Mapeo continuo suave tanh que alinea el score estrictamente con la tendencia y flujo institucional
      // (asintóticamente ±1.0, suave, monótono y sin singularidades ni inversiones de signo)
      s4 = Math.tanh(distAtr);
      n4 = `VWAP: ${formatSmartNumber(vwap)} | Score continuo (${s4 >= 0 ? '+' : ''}${s4.toFixed(2)})`;
    }
  } else if (cfg.useObv) {
    const obvLast = ctx.obvArr[i];
    const obvEMA = ctx.obvEMAArr[i];
    const avgVol = (ctx.volRollingArr && ctx.volRollingArr[i] > 0)
      ? ctx.volRollingArr[i]
      : calculateRollingVolumeAvg(ctx.klines, i, 20);
    const safeAvgVol = avgVol > 0 ? avgVol : (curr.volume || 1);

    // Mapeo continuo suave tanh de la divergencia OBV vs su media, normalizado por volumen medio
    // Elimina el salto binario ±1.0 duro en 1D y el churn por ruido cerca del cruce
    const distObv = (obvLast - obvEMA) / safeAvgVol;
    s4 = Math.tanh(distObv);
    n4 = `OBV: ${formatSmartNumber(obvLast)} vs EMA ${formatSmartNumber(obvEMA)} | Score continuo (${s4 >= 0 ? '+' : ''}${s4.toFixed(2)})`;
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
  const cachedSr = ctx.srCache.get(cacheIdx);

  // Dynamically resolve resistances (above evalPrice) and supports (below evalPrice):
  // When raw pivot levels are cached, classify without snapshot truncation; otherwise fall back to pre-filtered levels.
  let resistances: number[] = [];
  let supports: number[] = [];
  if (cachedSr?.pivotHighs || cachedSr?.pivotLows) {
    resistances = (cachedSr.pivotHighs ?? []).filter(r => r > evalPrice);
    supports = (cachedSr.pivotLows ?? []).filter(s => s < evalPrice);
  } else {
    resistances = (cachedSr?.resistances ?? (cachedSr?.nearestResistance ? [cachedSr.nearestResistance] : [])).filter(r => r > evalPrice);
    supports = (cachedSr?.supports ?? (cachedSr?.nearestSupport ? [cachedSr.nearestSupport] : [])).filter(s => s < evalPrice);
  }

  const nearestResistance = resistances[0] ?? 0;
  const nearestSupport = supports[0] ?? 0;

  const structureWeight = 1.0;
  let s6 = 0;
  let n6 = '';

  if (nearestSupport > 0 || nearestResistance > 0) {
    const distSupport = nearestSupport > 0 ? (evalPrice - nearestSupport) / evalPrice : Infinity;
    const distResist = nearestResistance > 0 ? (nearestResistance - evalPrice) / evalPrice : Infinity;
    const nearThreshold = 0.015; // 1.5%

    if (distSupport >= 0 && distSupport < nearThreshold && distSupport <= distResist) {
      s6 += 1;
      n6 = `Cerca soporte (${formatSmartPrice(nearestSupport)})`;
    } else if (distResist >= 0 && distResist < nearThreshold && distResist < distSupport) {
      s6 -= 1;
      n6 = `Cerca resistencia (${formatSmartPrice(nearestResistance)})`;
    } else {
      n6 = `S: ${nearestSupport > 0 ? formatSmartPrice(nearestSupport) : '-'} | R: ${nearestResistance > 0 ? formatSmartPrice(nearestResistance) : '-'}`;
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

  // Capacidad máxima teórica alcanzable por capa:
  // - Capas discretas (EMA fast/slow, RSI, Bollinger, Velas, Estructura): ±1.0
  // - Capas continuas con tanh (EMA mayor, VWAP y OBV): asintóticamente ±1.0
  const maxTrend = 1 + (cfg.emaMajor ? 1.0 : 0);
  const maxVolume = (cfg.useVwap || cfg.useObv) ? 1.0 : 0;
  const maxPossible = (maxTrend * w.trend) + w.rsi + w.bollinger + (maxVolume * w.volume) + w.candle + structureWeight;
  const threshold = Number((maxPossible * DEFAULT_SCORING_THRESHOLD_RATIO).toFixed(2));

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if      (totalScore >=  threshold) signal = 'BUY';
  else if (totalScore <= -threshold) signal = 'SELL';

  // Filtro de No-Contradicción Inter-Capas (Non-Dissent Rule):
  // Protege la calidad de las señales impidiendo operaciones "híbridas" donde una capa principal
  // presenta una oposición frontal dura (rechazo severo en Bollinger s3 <= -0.5 o volumen netamente contrario s4 <= -0.5).
  if (signal === 'BUY') {
    if (s3 <= -0.5) {
      signal = 'HOLD';
      n3 += ' | Veto de contradicción inter-capas: BUY bloqueado por rechazo en techo de Bollinger';
    } else if (s4 <= -0.5) {
      signal = 'HOLD';
      n4 += ' | Veto de contradicción inter-capas: BUY bloqueado por presión distribuidora en volumen';
    }
  } else if (signal === 'SELL') {
    if (s3 >= 0.5) {
      signal = 'HOLD';
      n3 += ' | Veto de contradicción inter-capas: SELL bloqueado por absorción en soporte de Bollinger';
    } else if (s4 >= 0.5) {
      signal = 'HOLD';
      n4 += ' | Veto de contradicción inter-capas: SELL bloqueado por presión compradora en volumen';
    }
  }

  // Veto direccional incondicional de VWAP:
  // En intradía (5m y 1h), Scoring opera como un motor estrictamente tendencial y alineado
  // con el flujo institucional: nunca compra por debajo de VWAP ni vende en corto por encima de VWAP.
  if (cfg.useVwap) {
    const isVwapReliable = ctx.vwapReliableSeries && ctx.vwapReliableSeries.length > i ? ctx.vwapReliableSeries[i] : true;
    if (isVwapReliable) {
      const vwap = ctx.vwapSeries[i];

      if (signal === 'BUY' && (closeVal < vwap || evalPrice < vwap)) {
        signal = 'HOLD';
        n4 += ' | Veto direccional VWAP: BUY bloqueado bajo VWAP (tendencia contraria)';
      } else if (signal === 'SELL' && (closeVal > vwap || evalPrice > vwap)) {
        signal = 'HOLD';
        n4 += ' | Veto direccional VWAP: SELL bloqueado sobre VWAP (tendencia contraria)';
      }
    }
  }

  // R:R validation using exact operational levels from calculateAlertLevels (parity with [0.2%, 8%] clamp)
  if (signal !== 'HOLD') {
    const atr = ctx.atrSeries[i];
    if (atr > 0) {
      const levels = calculateAlertLevels(signal, evalPrice, ctx.interval, atr, 'scoring', { isCrypto: ctx.isCrypto });
      const slDist = Math.abs(evalPrice - levels.stopLoss);
      const targetDist = Math.abs(levels.takeProfit1 - evalPrice);

      if (signal === 'BUY' && nearestResistance > evalPrice) {
        const rewardRoom = nearestResistance - evalPrice;
        if (rewardRoom < targetDist) {
          signal = 'HOLD';
          n6 += ` | R:R ${(rewardRoom / (slDist || 1)).toFixed(1)}:1 insuficiente (resistencia en ${formatSmartPrice(nearestResistance)} antes de TP1 ${formatSmartPrice(levels.takeProfit1)})`;
        }
      } else if (signal === 'SELL' && nearestSupport > 0 && nearestSupport < evalPrice) {
        const rewardRoom = evalPrice - nearestSupport;
        if (rewardRoom < targetDist) {
          signal = 'HOLD';
          n6 += ` | R:R ${(rewardRoom / (slDist || 1)).toFixed(1)}:1 insuficiente (soporte en ${formatSmartPrice(nearestSupport)} antes de TP1 ${formatSmartPrice(levels.takeProfit1)})`;
        }
      }
    }
  }

  // Veto para acciones en 5m:
  // 1) En 5m acciones, los setups SELL de Scoring han demostrado ser estadísticamente anti-predictivos.
  // 2) Pausa durante apertura NYSE (09:30–09:35 ET: normalización de subasta y spreads).
  // 3) Pausa durante la sesión de mediodía de Wall Street (11:30–14:00 ET: bajo volumen institucional).
  // 4) Pausa cerca del cierre de sesión NYSE (después de 15:15 ET: insuficiente tiempo para madurar).
  if (ctx.isCrypto === false && ctx.interval === '5m' && signal !== 'HOLD') {
    if (signal === 'SELL') {
      signal = 'HOLD';
      n3 += ' | SELL desactivado en 5m para acciones (asimetría predictiva adversa)';
    } else if (curr.time && isNyseOpeningCross(curr.time * 1000)) {
      signal = 'HOLD';
      n4 += ' | Pausado durante apertura NYSE (primeros 5m normalización de subasta)';
    } else if (curr.time && isNyseMiddayChop(curr.time * 1000)) {
      signal = 'HOLD';
      n4 += ' | Pausado durante sesión de mediodía NYSE (11:30–14:00 ET: bajo volumen institucional)';
    } else if (curr.time && isNearNyseSessionClose(curr.time * 1000, 915)) {
      signal = 'HOLD';
      n4 += ' | Pausado por proximidad al cierre NYSE (después de 15:15 ET)';
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
  const emaVal = ctx.ema200Series[i];
  const rvol = ctx.volSmaSeries[i] > 0 ? curr.volume / ctx.volSmaSeries[i] : 0;

  // 1. RSI Indicator
  const rsiVal = ctx.rsiSeries[i];
  const rsiSlopeDir = calculateRSISlope(ctx.rsiSeries, i, 3);
  const slopeArrow = rsiSlopeDir > 0 ? ' ▲' : rsiSlopeDir < 0 ? ' ▼' : '';
  let rsiSig: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(rsiVal)) {
    // Momentum slope alignment: oversold reversal curling up OR trend-pullback bounce in bull market support zone (35-48)
    const isTrendPullbackBuy = !isNaN(emaVal) && close > emaVal && rsiVal >= 35 && rsiVal <= 48 && rsiSlopeDir >= 0;
    const isTrendPullbackSell = !isNaN(emaVal) && close < emaVal && rsiVal >= 52 && rsiVal <= 65 && rsiSlopeDir <= 0;
    if ((rsiVal < 30 && rsiSlopeDir >= 0) || isTrendPullbackBuy) rsiSig = 'BUY';
    else if ((rsiVal > 70 && rsiSlopeDir <= 0) || isTrendPullbackSell) rsiSig = 'SELL';
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
    const bandWidth = bb.upper - bb.lower;
    const pctB = bandWidth > 0 ? (close - bb.lower) / bandWidth : 0.5;

    if (close < bb.lower) {
      // In established downtrend with healthy volume and bearish continuation candle, walking the lower band is downward expansion, not immediate buy
      const isBearExpansion = !isNaN(emaVal) && close < emaVal && rvol >= 1.0 && curr.close < curr.open;
      bbSig = isBearExpansion ? 'NEUTRAL' : 'BUY';
    } else if (close > bb.upper) {
      // In established uptrend with healthy volume, walking the upper band is upward expansion, not immediate sell
      const isBullExpansion = !isNaN(emaVal) && close > emaVal && rvol >= 1.0;
      bbSig = isBullExpansion ? 'NEUTRAL' : 'SELL';
    } else if (!isNaN(emaVal) && close > emaVal && pctB <= 0.38 && curr.close >= curr.open) {
      // Confluent trend pullback bounce: in uptrend, testing lower third of bands (%B <= 0.38) with bullish candle
      bbSig = 'BUY';
    } else if (!isNaN(emaVal) && close < emaVal && pctB >= 0.62 && curr.close <= curr.open) {
      // Confluent trend pullback rejection: in downtrend, testing upper third of bands (%B >= 0.62) with bearish candle
      bbSig = 'SELL';
    }
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
  // Require voteMargin >= 2 as the absolute floor to emit any directional signal
  // A single-vote majority (e.g. 1-0 or 2-1) is noisy and rejected to NEUTRAL
  if (buyVotes - sellVotes >= 3 && sellVotes === 0) {
    rawSignal = 'STRONG BUY';
  } else if (buyVotes - sellVotes >= 2) {
    rawSignal = 'BUY';
  } else if (sellVotes - buyVotes >= 3 && buyVotes === 0) {
    rawSignal = 'STRONG SELL';
  } else if (sellVotes - buyVotes >= 2) {
    rawSignal = 'SELL';
  }

  // Symmetrical relative volume confirmation filter (0.90 for both BUY and SELL)
  const rvolThreshold = 0.9;
  if (rawSignal !== 'NEUTRAL' && rvol < rvolThreshold) {
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

  if (isNaN(emaVal)) {
    finalSig = 'NEUTRAL';
  } else if (finalSig !== 'NEUTRAL') {
    const trend = close > emaVal ? 'UP' : 'DOWN';
    // Allow counter-trend signals ONLY when confirmed by high-conviction mean-reversion confluence
    // (STRONG consensus margin >= 3 with 0 opposing votes, or both extreme oversold/overbought voters aligned with non-plunging anatomy)
    const isConfluentMeanReversionBuy = (rsiSig === 'BUY' && bbSig === 'BUY' && (curr.close >= curr.open || cp >= 0.50)) || (rawSignal === 'STRONG BUY' && sellVotes === 0);
    const isConfluentMeanReversionSell = (rsiSig === 'SELL' && bbSig === 'SELL' && (curr.close <= curr.open || cp <= 0.50)) || (rawSignal === 'STRONG SELL' && buyVotes === 0);

    if (trend === 'UP' && finalSig === 'SELL' && !isConfluentMeanReversionSell) {
      finalSig = 'NEUTRAL';
    }
    if (trend === 'DOWN' && finalSig === 'BUY' && !isConfluentMeanReversionBuy) {
      finalSig = 'NEUTRAL';
    }
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
  avgDailyRange1d: number[];
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
  vwapReliable1h?: boolean[];
  chandelierData: ReturnType<typeof calculateChandelierExit>;
  atrSma1hArr: number[];
  // 5M
  closes5m: number[];
  bbSeries5m: BollingerBandsSeriesResult[];
  ema9_5m: number[];
  ema21_5m: number[];
  vwapSeries5m: number[];
  vwapReliable5m?: boolean[];
  rsiSeries5m: number[];
  atrSeries5m: number[];
  adxSeries5m: ReturnType<typeof calculateADXSeries>;
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
  const dailyRangePct1d = klines1d ? klines1d.map(k => k.close > 0 ? (k.high - k.low) / k.close * 100 : 0) : [];
  const avgDailyRange1d = new Array(len1d).fill(0);
  let rangeSum1d = 0;
  for (let idx = 0; idx < Math.min(20, len1d); idx++) {
    rangeSum1d += dailyRangePct1d[idx];
  }
  if (len1d >= 20) avgDailyRange1d[19] = rangeSum1d / 20;
  for (let idx = 20; idx < len1d; idx++) {
    avgDailyRange1d[idx] = rangeSum1d / 20;
    rangeSum1d = rangeSum1d - dailyRangePct1d[idx - 20] + dailyRangePct1d[idx];
  }
  const avgDailyRange = len1d > 0 ? (avgDailyRange1d[len1d - 1] || (rangeSum1d / Math.max(1, len1d))) : 0;

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
  const vwapReliable1h = klines1h ? calculateVWAPReliabilitySeries(klines1h, '1h', symbol) : [];
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
  const vwapReliable5m = klines5m ? calculateVWAPReliabilitySeries(klines5m, style === 'swing' ? '1h' : '5m', symbol) : [];
  const rsiSeries5m = calculateRSISeries(closes5m, 14);
  const atrSeries5m = klines5m ? calculateATRSeries(klines5m, 14) : [];
  const adxSeries5m = klines5m ? calculateADXSeries(klines5m, 14) : { adx: [], plusDI: [], minusDI: [] };

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
  const triggerStepSec = style === 'swing' ? 3600 : 300;

  if (len5m > 0 && len1h > 0) {
    let hCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      const tClose = t + triggerStepSec;
      while (hCursor + 1 < len1h && (klines1h[hCursor + 1].time + 3600) <= tClose) {
        hCursor++;
      }
      if ((klines1h[hCursor].time + 3600) <= tClose) {
        idx1hMap[i] = hCursor;
      }
    }
  }

  if (len5m > 0 && len1d > 0) {
    let dCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      const tClose = t + triggerStepSec;
      while (dCursor + 1 < len1d && (klines1d[dCursor + 1].time + 86400) <= tClose) {
        dCursor++;
      }
      if ((klines1d[dCursor].time + 86400) <= tClose) {
        idx1dMap[i] = dCursor;
      }
    }
  }

  return {
    klines5m, klines1h, klines1d, symbol, style, triggerMode,
    closes1d, ema200_1d, ema50_1d, adxData1d, avgDailyRange, avgDailyRange1d,
    closes1h, ema200_1h, ema50_1h, ema20_1h, rsiSeries1h, adxSeries1h,
    macdData1h, atrSeries1h, vwapSeries1h, vwapReliable1h, chandelierData, atrSma1hArr,
    closes5m, bbSeries5m, ema9_5m, ema21_5m, vwapSeries5m, vwapReliable5m, rsiSeries5m,
    atrSeries5m, adxSeries5m, vol5m, volSma5m, bbWidth5m,
    idx1hMap, idx1dMap
  };
}

export function getVCMETargetMultipliers(tradeType: 'DAY' | 'SWING'): { tp1Mult: number; tp2Mult: number; tp3Mult: number } {
  return {
    tp1Mult: tradeType === 'SWING' ? 2.0 : 1.20,
    tp2Mult: tradeType === 'SWING' ? 3.5 : 2.0,
    tp3Mult: tradeType === 'SWING' ? 5.0 : 3.0,
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

    // In day trading, avoid discarding early consolidations or gentle slopes:
    const isSwing = ctx.style === 'swing';
    const slopeThreshold = isSwing ? 0.05 : -0.01;
    const adxThreshold = isSwing ? 20 : 18;
    const regimeOkLong = adxVal >= adxThreshold && slopeAtr >= slopeThreshold;

    const isVwap1hOkLong = (!ctx.vwapReliable1h || !ctx.vwapReliable1h[hIdx]) ? true : ctx.closes1h[hIdx] > ctx.vwapSeries1h[hIdx];
    const macdHistOkLong = isSwing
      ? hist > 0 && (hist > prevHist || hist >= 0.02 * atr1h)
      : (hist > prevHist || hist > 0);
    const rsiMin = isSwing ? 50 : 45;
    return (
      regimeOkLong &&
      isVwap1hOkLong &&
      ctx.ema20_1h[hIdx] > ctx.ema50_1h[hIdx] &&
      ctx.rsiSeries1h[hIdx] >= rsiMin && ctx.rsiSeries1h[hIdx] <= 80 &&
      macdHistOkLong
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

    const isSwing = ctx.style === 'swing';
    const slopeThreshold = isSwing ? -0.05 : 0.01;
    const adxThreshold = isSwing ? 20 : 18;
    const regimeOkShort = adxVal >= adxThreshold && slopeAtr <= slopeThreshold;

    const isVwap1hOkShort = (!ctx.vwapReliable1h || !ctx.vwapReliable1h[hIdx]) ? true : ctx.closes1h[hIdx] < ctx.vwapSeries1h[hIdx];
    const macdHistOkShort = isSwing
      ? hist < 0 && (hist < prevHist || hist <= -0.02 * atr1h)
      : (hist < prevHist || hist < 0);
    const rsiMax = isSwing ? 50 : 55;
    return (
      regimeOkShort &&
      isVwap1hOkShort &&
      ctx.ema20_1h[hIdx] < ctx.ema50_1h[hIdx] &&
      ctx.rsiSeries1h[hIdx] >= 20 && ctx.rsiSeries1h[hIdx] <= rsiMax &&
      macdHistOkShort
    );
  };

  const isInvalidatedLong = (hIdx: number) => {
    const isVwap1hBad = (ctx.vwapReliable1h && ctx.vwapReliable1h[hIdx]) ? ctx.closes1h[hIdx] < ctx.vwapSeries1h[hIdx] : false;
    return isVwap1hBad || ctx.ema20_1h[hIdx] < ctx.ema50_1h[hIdx];
  };

  const isInvalidatedShort = (hIdx: number) => {
    const isVwap1hBad = (ctx.vwapReliable1h && ctx.vwapReliable1h[hIdx]) ? ctx.closes1h[hIdx] > ctx.vwapSeries1h[hIdx] : false;
    return isVwap1hBad || ctx.ema20_1h[hIdx] > ctx.ema50_1h[hIdx];
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
      const gateRSI = rsi > 50 && rsi <= 82;
      return gateVWAP && gateBreakout && gateVol && gateRSI;
    } else {
      const gateVWAP = k.close < vw;
      const gateBreakout = k.close < b.lower && prevK.close >= prevB.lower;
      const gateVol = rvolLocal >= 1.8;
      const gateRSI = rsi < 50 && rsi >= 18;
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

  const isVwapReliable5m = ctx.vwapReliable5m && ctx.vwapReliable5m.length > i ? ctx.vwapReliable5m[i] : true;
  const vwapLongOk = isVwapReliable5m ? curr5m.close > vwap5m : true;
  const vwapShortOk = isVwapReliable5m ? curr5m.close < vwap5m : true;

  const maxPrevHigh3 = Math.max(ctx.klines5m[i - 1].high, ctx.klines5m[i - 2].high, ctx.klines5m[i - 3].high);
  const condPullbackLong = ctx.triggerMode === 'agresivo' &&
                           (hasPullbackLong(i) || hasPullbackLong(i - 1) || hasPullbackLong(i - 2)) &&
                           curr5m.close > maxPrevHigh3 &&
                           curr5m.close > curr5m.open &&
                           rvol >= 1.5 &&
                           vwapLongOk;

  const minPrevLow3 = Math.min(ctx.klines5m[i - 1].low, ctx.klines5m[i - 2].low, ctx.klines5m[i - 3].low);
  const condPullbackShort = ctx.triggerMode === 'agresivo' &&
                            (hasPullbackShort(i) || hasPullbackShort(i - 1) || hasPullbackShort(i - 2)) &&
                            curr5m.close < minPrevLow3 &&
                            curr5m.close < curr5m.open &&
                            rvol >= 1.8 &&
                            vwapShortOk;

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

  // 5. Candle Quality & Filters
  const minutesSinceOpen = (() => {
    const isCrypto = isCryptoAsset(ctx.symbol);
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

  const vwapExtLongOk = isVwapReliable5m ? (curr5m.close - vwap5m) <= 2.0 * atr5m : true;
  const qualityLong = vwapExtLongOk &&
                      candleBodyRatio(curr5m) >= 0.3 &&
                      strengthCandleLong &&
                      upperWickRatio(curr5m) <= 0.35 &&
                      minutesSinceOpen >= 5 &&
                      rvol < 8.0;

  const vwapExtShortOk = isVwapReliable5m ? (vwap5m - curr5m.close) <= 2.0 * atr5m : true;
  const qualityShort = vwapExtShortOk &&
                       candleBodyRatio(curr5m) >= 0.3 &&
                       strengthCandleShort &&
                       lowerWickRatio(curr5m) <= 0.35 &&
                       minutesSinceOpen >= 5 &&
                       rvol < 8.0;

  // 6. Confidence Score Continuous
  const getContinuousConfidence = (dir: 'LONG' | 'SHORT') => {
    const isLong = dir === 'LONG';
    const volScore = 0.30 * Math.min(rvol / 2.0, 1.0);
    const macroScore = 0.25 * (
      isLong
        ? (lastClose1d > lastEma200Ref ? 1.0 : (bias1D === 'NEUTRAL' && ctx.style !== 'swing' ? 0.5 : 0))
        : (lastClose1d < lastEma200Ref ? 1.0 : (bias1D === 'NEUTRAL' && ctx.style !== 'swing' ? 0.5 : 0))
    );
    const macdScore = 0.20 * (isLong ? (macdHist1h > 0 ? 1 : 0) : (macdHist1h < 0 ? 1 : 0));
    const distRatio = Math.abs(curr5m.close - ema21Val) / (atr5m || 1);
    const distScore = 0.15 * Math.max(0, 1.0 - Math.abs(distRatio - 0.5) / 1.0);
    const vwapScore = isVwapReliable5m
      ? 0.10 * (isLong ? (curr5m.close > vwap5m ? 1 : 0) : (curr5m.close < vwap5m ? 1 : 0))
      : 0.05;
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
  let mode: 'PULLBACK' | 'BREAKOUT' | 'NONE' = 'NONE';
  let triggerDetail = 'Sin disparo de gatillo';

  // 1D Macro Bias Gate:
  // - Swing Trading (1H): Requires strictly aligned 1D macro trend (ALCISTA for BUY, BAJISTA for SELL).
  // - Day Trading (5m): Requires non-adverse 1D bias (allows trading during NEUTRAL daily consolidation, blocks opposing trend).
  const isBiasCompatibleLong = ctx.style === 'swing'
    ? bias1D === 'ALCISTA'
    : bias1D !== 'BAJISTA';

  const isBiasCompatibleShort = ctx.style === 'swing'
    ? bias1D === 'BAJISTA'
    : bias1D !== 'ALCISTA';

  const triggerLong = isBiasCompatibleLong && (setupArmedLong && (condPullbackLong || condBreakoutLong)) && qualityLong;
  const triggerShort = isBiasCompatibleShort && (setupArmedShort && (condPullbackShort || condBreakoutShort)) && qualityShort;

  if (triggerLong) {
    signal = 'BUY';
    mode = condPullbackLong ? 'PULLBACK' : 'BREAKOUT';
    triggerDetail = condPullbackLong ? 'Gatillo Pullback en 5m (Ruptura micro-máximo)' : 'Gatillo Breakout 5m (Ruptura ORB/Bollinger Squeeze)';
  } else if (triggerShort) {
    signal = 'SELL';
    mode = condPullbackShort ? 'PULLBACK' : 'BREAKOUT';
    triggerDetail = condPullbackShort ? 'Gatillo Pullback en 5m (Ruptura micro-mínimo)' : 'Gatillo Breakdown 5m (Ruptura ORB/Bollinger Squeeze)';
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
    const minRequiredRvol = (setupArmedShort && !setupArmedLong) ? 1.8 : 1.5;
    if ((setupArmedLong && !isBiasCompatibleLong) || (setupArmedShort && !isBiasCompatibleShort)) {
      discardReason = 'regimeFilter';
    } else if (!setupArmedLong && !setupArmedShort) {
      discardReason = 'regimeFilter';
    } else if (rvol < minRequiredRvol) {
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
  for (let s = lookbackS; s <= i; s++) {
    if (ctx.klines5m[s].low < swingLow) swingLow = ctx.klines5m[s].low;
    if (ctx.klines5m[s].high > swingHigh) swingHigh = ctx.klines5m[s].high;
  }

  const atrMultLong = 1.5;
  const atrMultShort = 1.5;
  const { tp1Mult, tp2Mult, tp3Mult } = getVCMETargetMultipliers(tradeType);

  const chandelierLong = ctx.chandelierData.long[idx1h];
  const chandelierShort = ctx.chandelierData.short[idx1h];

  if (signal === 'BUY') {
    const slATR = entry - atrMultLong * atr5m;
    const slStruct = swingLow > 0 && swingLow < Infinity ? (swingLow - 0.20 * atr5m) : slATR;
    // Floor at 1.5 ATR (slATR) to protect trade against friction and micro-noise, expandable up to 1.8 ATR (2.0 ATR in BREAKOUT)
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
      const minRisk = 1.5 * atr5m;
      const maxRisk = (mode === 'BREAKOUT' ? 2.0 : (tradeType === 'SWING' ? 1.8 : 2.0)) * atr5m;
      if (risk < minRisk) {
        stopLoss = entry - minRisk;
        risk = minRisk;
      }
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;

      // Clamping: If structural risk exceeds maxRisk, clamp stop to maxRisk provided it
      // stays strictly at or below the trigger candle extreme buffer (curr5m.low - 0.15 * atr5m)
      const triggerExtreme = curr5m.low - 0.15 * atr5m;
      const clampedStop = entry - maxRisk;
      if (risk > maxRisk && clampedStop <= triggerExtreme) {
        stopLoss = clampedStop;
        risk = maxRisk;
      }

      const riskPercent = entry > 0 ? risk / entry : 0;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        signal = 'NEUTRAL';
        mode = 'NONE';
        confidence = 'DESCARTAR';
        triggerDetail = `Descartado por riesgo excesivo (${formatSmartNumber(riskPercent * 100)}% vs máx ${formatSmartNumber(maxAllowedRisk * 100)}% o ${formatSmartNumber(risk / (atr5m || 1))} ATR vs máx ${formatSmartNumber(maxRisk / (atr5m || 1))} ATR)`;
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
    // Floor at 1.5 ATR (slATR) to protect trade against friction and micro-noise, expandable up to 1.8 ATR (2.0 ATR in BREAKOUT)
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
      const minRisk = 1.5 * atr5m;
      const maxRisk = (mode === 'BREAKOUT' ? 2.0 : (tradeType === 'SWING' ? 1.8 : 2.0)) * atr5m;
      if (risk < minRisk) {
        stopLoss = entry + minRisk;
        risk = minRisk;
      }
      const maxAllowedRisk = tradeType === 'SWING' ? 0.035 : 0.015;

      // Clamping: If structural risk exceeds maxRisk, clamp stop to maxRisk provided it
      // stays strictly at or above the trigger candle extreme buffer (curr5m.high + 0.15 * atr5m)
      const triggerExtreme = curr5m.high + 0.15 * atr5m;
      const clampedStop = entry + maxRisk;
      if (risk > maxRisk && clampedStop >= triggerExtreme) {
        stopLoss = clampedStop;
        risk = maxRisk;
      }

      const riskPercent = entry > 0 ? risk / entry : 0;
      if (risk > maxRisk || riskPercent > maxAllowedRisk) {
        signal = 'NEUTRAL';
        mode = 'NONE';
        confidence = 'DESCARTAR';
        triggerDetail = `Descartado por riesgo excesivo (${formatSmartNumber(riskPercent * 100)}% vs máx ${formatSmartNumber(maxAllowedRisk * 100)}% o ${formatSmartNumber(risk / (atr5m || 1))} ATR vs máx ${formatSmartNumber(maxRisk / (atr5m || 1))} ATR)`;
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

  const currentAvgDailyRange = (idx1d >= 0 && ctx.avgDailyRange1d && idx1d < ctx.avgDailyRange1d.length && ctx.avgDailyRange1d[idx1d] > 0)
    ? ctx.avgDailyRange1d[idx1d]
    : ctx.avgDailyRange;

  const marketRegime = atrVal1h > 1.2 * atrSma1h ? 'Alta Volatilidad' : 'Normal';
  const volatilityProfile = currentAvgDailyRange > 3.5 ? 'Alta Volatilidad' : 'Normal';
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
    rsi1H: (rsiVal1h !== undefined && !isNaN(rsiVal1h)) ? Number(rsiVal1h.toFixed(1)) : 50,
    macdHistDirection: macdHistDir,
    ema200_1D: lastEma200Ref,
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
    avgDailyRange: Number(currentAvgDailyRange.toFixed(2)),
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
  const triggerStepSec = 300;

  if (len5m > 0 && len1h > 0) {
    let hCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      const tClose = t + triggerStepSec;
      while (hCursor + 1 < len1h && (klines1h[hCursor + 1].time + 3600) <= tClose) {
        hCursor++;
      }
      if ((klines1h[hCursor].time + 3600) <= tClose) {
        idx1hMap[i] = hCursor;
      }
    }
  }

  if (len5m > 0 && len1d > 0) {
    let dCursor = 0;
    for (let i = 0; i < len5m; i++) {
      const t = klines5m[i].time;
      const tClose = t + triggerStepSec;
      while (dCursor + 1 < len1d && (klines1d[dCursor + 1].time + 86400) <= tClose) {
        dCursor++;
      }
      if ((klines1d[dCursor].time + 86400) <= tClose) {
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
  const currCandle = (ctx.klines5m && i >= 0 && i < ctx.klines5m.length) ? ctx.klines5m[i] : undefined;
  const triggerPrice = (executionPrice && executionPrice > 0) ? executionPrice : (currCandle ? currCandle.close : 0);

  const fallback: MultifractalMTFEvaluationResult = {
    signal: 'NEUTRAL', strategy: 'NONE', stopLoss: 0, triggerPrice,
    isCompressed1H: false, bias1D: 'NEUTRAL', activeVolumePercent5M: 0, volumeMultiplier5M: 0,
    andianGreen: 0, andianRed: 0, andianOrange: 0, volatilityWidth1H: 0, dreadBlitzMCD: 0,
    isOverbought5M: false, isOversold5M: false,
    reasoning: 'Datos insuficientes — se requieren al menos 20 velas de 5m'
  };

  if (!ctx.klines5m || ctx.klines5m.length < 20 || i < 19 || i >= ctx.klines5m.length || !currCandle) {
    return { ...fallback, discardReason: 'insufficientData' };
  }

  // 1. MACRO FILTER (1D - Andian)
  const idx1d = ctx.idx1dMap[i];
  if (idx1d < 0 || idx1d >= ctx.andianSeries.length) {
    return { ...fallback, reasoning: 'Datos 1D insuficientes o no alineados con la vela evaluada', discardReason: 'insufficientData' };
  }
  const lastAndian = ctx.andianSeries[idx1d];
  const bias1D = lastAndian.bias;

  // 2. CONTEXT FILTER (1H - Revolution Volatility Band Squeeze)
  const idx1h = ctx.idx1hMap[i];
  if (idx1h < 0 || idx1h >= ctx.volBands1H.length) {
    return {
      ...fallback,
      bias1D,
      andianGreen: lastAndian.green,
      andianRed: lastAndian.red,
      andianOrange: lastAndian.orange,
      reasoning: 'Datos 1H insuficientes o no alineados con la vela evaluada',
      discardReason: 'insufficientData'
    };
  }
  const recent1H = ctx.volBands1H.slice(Math.max(0, idx1h - 3), idx1h + 1);
  const isCompressed1H = recent1H.some(b => b.isCompressed);
  const current1HBand = ctx.volBands1H[idx1h];

  // 3. TRIGGER CONDITIONS (5M)
  const prevCandle = i > 0 ? ctx.klines5m[i - 1] : currCandle;
  const currVolComp = (i < ctx.volComp5M.length) ? ctx.volComp5M[i] : { volumeMultiplier: 1, activeBuyPercent: 50, activeSellPercent: 50, isPassiveBuyAbsorption: false, isPassiveSellAbsorption: false };
  const curr5MBand = (i < ctx.volBands5M.length) ? ctx.volBands5M[i] : { upper: currCandle.high, lower: currCandle.low, midpoint: currCandle.close, width: 0, isCompressed: false };
  const currDread = (i < ctx.dreadBlitz5M.length) ? ctx.dreadBlitz5M[i] : { isOverbought: false, isOversold: false, mcd: 0 };
  const prevDread = (i > 0 && (i - 1) < ctx.dreadBlitz5M.length) ? ctx.dreadBlitz5M[i - 1] : currDread;

  const isNyseOpening = isNyseOpeningWindow(currCandle.time, ctx.symbol);
  const minVolMultiplier = isNyseOpening ? 1.8 : 1.5;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let strategy: 'BREAKOUT_EXPANSION' | 'MEAN_REVERSION' | 'NONE' = 'NONE';
  let stopLoss = 0;
  let reasoning = '';

  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN (LONG)
  const isBreakoutBiasLong = bias1D === 'BULLISH' || (bias1D === 'NEUTRAL' && isCompressed1H);
  const isBreakoutBiasShort = bias1D === 'BEARISH' || (bias1D === 'NEUTRAL' && isCompressed1H);

  if (
    isBreakoutBiasLong &&
    isCompressed1H &&
    currCandle.close > curr5MBand.upper &&
    currVolComp.volumeMultiplier >= minVolMultiplier &&
    currVolComp.activeBuyPercent >= 58
  ) {
    signal = 'BUY';
    strategy = 'BREAKOUT_EXPANSION';
    stopLoss = curr5MBand.midpoint;
    reasoning = `Placing SL at channel midpoint (${formatSmartPrice(stopLoss)}) for institutional breakout expansion hypothesis.`;
  }
  // ESTRATEGIA 1: RUPTURA DE RANGO CON EXPANSIÓN (SHORT)
  else if (
    isBreakoutBiasShort &&
    isCompressed1H &&
    currCandle.close < curr5MBand.lower &&
    currVolComp.volumeMultiplier >= minVolMultiplier &&
    currVolComp.activeSellPercent >= 58
  ) {
    signal = 'SELL';
    strategy = 'BREAKOUT_EXPANSION';
    stopLoss = curr5MBand.midpoint;
    reasoning = `Placing SL at channel midpoint (${formatSmartPrice(stopLoss)}) for institutional breakdown expansion hypothesis.`;
  }
  // ESTRATEGIA 2: REVERSIÓN EXCESIVA A LA MEDIA (LONG)
  // Strict Layer 1 Macro Alignment: Mean reversion BUY is forbidden against a confirmed BEARISH 1D bias
  else if (
    bias1D !== 'BEARISH' &&
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
  // Strict Layer 1 Macro Alignment: Mean reversion SELL is forbidden against a confirmed BULLISH 1D bias
  else if (
    bias1D !== 'BULLISH' &&
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
    const isLongMeanReversionSetup = currDread.isOversold && currCandle.low < prevCandle.low && currDread.mcd > prevDread.mcd && currVolComp.isPassiveBuyAbsorption;
    const isShortMeanReversionSetup = currDread.isOverbought && currCandle.high > prevCandle.high && currDread.mcd < prevDread.mcd && currVolComp.isPassiveSellAbsorption;

    if (isLongMeanReversionSetup && bias1D === 'BEARISH') {
      discardReason = 'regimeFilter';
      reasoning = `Discarded: Long mean reversion setup rejected due to conflicting 1D bearish macro bias (${bias1D}).`;
    } else if (isShortMeanReversionSetup && bias1D === 'BULLISH') {
      discardReason = 'regimeFilter';
      reasoning = `Discarded: Short mean reversion setup rejected due to conflicting 1D bullish macro bias (${bias1D}).`;
    } else if (currVolComp.volumeMultiplier < minVolMultiplier) {
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. MACD FAILURE & LIQUIDITY SWEEP (MFLS) ENGINE (Signal 6)
// ═══════════════════════════════════════════════════════════════════════════

export interface MFLSContext {
  klines5m: Kline[];
  symbol: string;
  closes: number[];
  atrSeries: number[];
  macdData: MACDSeriesData;
  rsiSeries: number[];
  volSmaSeries: number[];
  pivots: FractalPivotsSeries;
  isCrypto: boolean;
}

export interface MFLSEvaluationResult {
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: number;
  triggerPrice: number;
  sweepPrice: number;
  pivotReference: number;
  penetrationPct: number;
  isReclaim: boolean;
  macdDivergence: boolean;
  rsiDivergence: boolean;
  hasImbalance: boolean;
  setupSide: 'BUY' | 'SELL' | null;
  reasoning: string;
  discardReason?: keyof DiscardBreakdown;
}

export function buildMFLSContext(
  klines5m: Kline[],
  symbolOrIsCrypto: string | boolean = 'ASSET'
): MFLSContext {
  const isCrypto = typeof symbolOrIsCrypto === 'boolean' ? symbolOrIsCrypto : isCryptoAsset(symbolOrIsCrypto);
  const symbol = typeof symbolOrIsCrypto === 'string' ? symbolOrIsCrypto : (isCrypto ? 'BTCUSDT' : 'AAPL');
  const len = klines5m ? klines5m.length : 0;

  if (len === 0) {
    return {
      klines5m: [],
      symbol,
      closes: [],
      atrSeries: [],
      macdData: { macd: [], signal: [], histogram: [], signals: [] },
      rsiSeries: [],
      volSmaSeries: [],
      pivots: { swingLows: [], swingLowIndices: [], swingHighs: [], swingHighIndices: [] },
      isCrypto
    };
  }

  const closes = klines5m.map(k => k.close);
  const atrSeries = calculateATRSeries(klines5m, 14);
  const macdData = calculateMACDSeries(closes);
  const rsiSeries = calculateRSISeries(closes, 14);

  const volSmaSeries = new Array(len).fill(0);
  let volSum = 0;
  for (let idx = 0; idx < Math.min(20, len); idx++) {
    volSum += klines5m[idx].volume;
  }
  if (len >= 20) volSmaSeries[19] = volSum / 20;
  for (let idx = 20; idx < len; idx++) {
    volSmaSeries[idx] = volSum / 20;
    volSum = volSum - klines5m[idx - 20].volume + klines5m[idx].volume;
  }

  const pivots = calculateFractalPivotsSeries(klines5m, 20);

  return {
    klines5m,
    symbol,
    closes,
    atrSeries,
    macdData,
    rsiSeries,
    volSmaSeries,
    pivots,
    isCrypto
  };
}

export function evaluateMFLSAt(
  ctx: MFLSContext,
  i: number,
  executionPrice?: number
): MFLSEvaluationResult {
  const currCandle = (ctx.klines5m && i >= 0 && i < ctx.klines5m.length) ? ctx.klines5m[i] : undefined;
  const triggerPrice = (executionPrice && executionPrice > 0) ? executionPrice : (currCandle ? currCandle.close : 0);

  const fallback: MFLSEvaluationResult = {
    signal: 'NEUTRAL',
    setupSide: null,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    riskRewardRatio: 0,
    triggerPrice,
    sweepPrice: 0,
    pivotReference: 0,
    penetrationPct: 0,
    isReclaim: false,
    macdDivergence: false,
    rsiDivergence: false,
    hasImbalance: false,
    reasoning: 'Datos insuficientes para evaluar MFLS',
    discardReason: 'insufficientData'
  };

  if (!ctx.klines5m || ctx.klines5m.length < 25 || i < 20 || i >= ctx.klines5m.length || !currCandle) {
    return fallback;
  }

  // 1. Session Filter (Equities only: 9:45 - 15:30 EST)
  if (!ctx.isCrypto) {
    const executionMs = currCandle.time > 1e11 ? currCandle.time : (currCandle.time + 300) * 1000;
    if (!isMFLSSessionWindow(executionMs)) {
      return { ...fallback, reasoning: 'Descartado: Fuera del horario de sesión MFLS (09:45–15:30 EST)', discardReason: 'sessionGap' };
    }
  }

  // 2. Relative Volume & News Spike Filter
  // Veto extreme uncontrolled spikes (RVOL >= 8.0x). Climax absorption (6.0x-8.0x) is evaluated directionally per side.
  const volSma = (i < ctx.volSmaSeries.length && ctx.volSmaSeries[i] > 0) ? ctx.volSmaSeries[i] : 1;
  const rvol = volSma > 0 ? (currCandle.volume / volSma) : 1;
  if (rvol >= 8.0) {
    return { ...fallback, reasoning: `Descartado: Volumen anómalo de noticias institucionales (RVOL ${rvol.toFixed(1)}x)`, discardReason: 'volumeFilter' };
  }

  const atr = (i < ctx.atrSeries.length && !isNaN(ctx.atrSeries[i]) && ctx.atrSeries[i] > 0)
    ? ctx.atrSeries[i]
    : (currCandle.close * 0.005);

  const prevSwingLow = ctx.pivots.swingLows[i];
  const prevSwingLowIdx = ctx.pivots.swingLowIndices[i];
  const prevSwingHigh = ctx.pivots.swingHighs[i];
  const prevSwingHighIdx = ctx.pivots.swingHighIndices[i];

  // Sweep penetration bound strictly driven by ATR volatility (1.8x ATR)
  const maxSweepDist = 1.8 * atr;

  let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let setupSide: 'BUY' | 'SELL' | null = null;
  let stopLoss = 0;
  let takeProfit1 = 0;
  let takeProfit2 = 0;
  let sweepPrice = 0;
  let pivotReference = 0;
  let penetrationPct = 0;
  let isReclaim = false;
  let macdDivergence = false;
  let rsiDivergence = false;
  let hasImbalance = false;
  let reasoning = '';
  let discardReason: keyof DiscardBreakdown | undefined;

  // -------------------------------------------------------------
  // EVALUAR LADO LARGO (BUY - BARRIDO DE SOPORTE + RECLAIM)
  // -------------------------------------------------------------
  if (prevSwingLow !== null && prevSwingLowIdx !== null && prevSwingLowIdx < i) {
    const sweepDepth = prevSwingLow - currCandle.low;
    const isSweep = currCandle.low < prevSwingLow && sweepDepth > 0 && sweepDepth <= maxSweepDist;
    const isReclaimClose = currCandle.close > prevSwingLow;

    if (isSweep && isReclaimClose) {
      setupSide = 'BUY';
      sweepPrice = currCandle.low;
      pivotReference = prevSwingLow;
      penetrationPct = (sweepDepth / prevSwingLow) * 100;
      isReclaim = true;

      // Guard against invalidation by execution/live price (symmetrical without premature return)
      let buyInvalidated = false;
      if (triggerPrice < prevSwingLow || triggerPrice <= currCandle.low) {
        buyInvalidated = true;
        discardReason = 'riskFilter';
        reasoning = `Descartado: Reclaim invalidado por precio (${formatSmartPrice(triggerPrice)} < soporte ${formatSmartPrice(prevSwingLow)})`;
      }
      const maxChasingDist = Math.max(1.2 * atr, Math.min(1.8 * atr, 0.015 * triggerPrice));
      if (!buyInvalidated && triggerPrice > prevSwingLow + maxChasingDist) {
        buyInvalidated = true;
        discardReason = 'riskFilter';
        reasoning = 'Descartado: Precio en vivo escapado de la zona de soporte (deslizamiento excesivo)';
      }

      if (!buyInvalidated) {
        // Inefficiency / Imbalance check in prior 4 bars: requires genuine expansion displacement in i-4 to i-1
        let wideBearBars = 0;
        let maxPriorHigh = -Infinity;
        let minPriorLow = Infinity;
        const lookStart = Math.max(0, i - 4);
        for (let kIdx = lookStart; kIdx < i; kIdx++) {
          const k = ctx.klines5m[kIdx];
          if (k.close < k.open && candleBodyRatio(k) >= 0.45) wideBearBars++;
          if (k.high > maxPriorHigh) maxPriorHigh = k.high;
          if (k.low < minPriorLow) minPriorLow = k.low;
        }
        const priorDrop = (maxPriorHigh > -Infinity && minPriorLow < Infinity) ? (maxPriorHigh - minPriorLow) : 0;
        const priceDropAtr = priorDrop / atr;
        hasImbalance = wideBearBars >= 2 || priceDropAtr >= 1.6;

        // MACD Failure: strictly evaluated on the MACD line itself (curling up + higher low vs pivot bar)
        const currMacd = ctx.macdData.macd[i];
        const prevMacd = ctx.macdData.macd[i - 1];
        const pivotMacd = ctx.macdData.macd[prevSwingLowIdx];
        const macdCurlingUp = currMacd > prevMacd;
        const macdHigherLow = currMacd > pivotMacd;
        macdDivergence = macdCurlingUp && macdHigherLow;

        // RSI Divergence: RSI at current bar > RSI at pivot low bar
        const currRsi = ctx.rsiSeries[i];
        const pivotRsi = ctx.rsiSeries[prevSwingLowIdx];
        rsiDivergence = currRsi > pivotRsi;

        // Rejection wick confirmation (lower wick >= 25% of candle range, or >= 40% if RVOL >= 6.0)
        const range = currCandle.high - currCandle.low;
        const lowerWick = Math.min(currCandle.open, currCandle.close) - currCandle.low;
        const lowerWickRatio = range > 0 ? (lowerWick / range) : 1;
        const minWickRequired = rvol >= 6.0 ? 0.40 : 0.25;
        const hasRejectionWick = lowerWickRatio >= minWickRequired;

        if (rvol >= 6.0 && !hasRejectionWick) {
          buyInvalidated = true;
          discardReason = 'volumeFilter';
          reasoning = `Descartado: Volumen anómalo (RVOL ${rvol.toFixed(1)}x) sin absorción compradora suficiente (mecha inf ${(lowerWickRatio * 100).toFixed(0)}% < 40%)`;
        } else if (!hasRejectionWick) {
          buyInvalidated = true;
          discardReason = 'riskFilter';
          reasoning = `Descartado: Mecha de rechazo inferior insuficiente (${(lowerWickRatio * 100).toFixed(0)}% < 25%)`;
        }

        // Strict gating: hasImbalance AND macdDivergence AND hasRejectionWick
        if (!buyInvalidated && hasImbalance && macdDivergence && hasRejectionWick) {
          signal = 'BUY';
          
          // Structural Stop Loss: 0.8 ATR beyond sweep price, floored at 0.40% (native equity floor)
          const rawSL = sweepPrice - 0.8 * atr;
          const minRiskDist = Math.max(0.8 * atr, triggerPrice * 0.0040);
          stopLoss = Math.min(rawSL, triggerPrice - minRiskDist);
          const risk = triggerPrice - stopLoss;

          takeProfit1 = triggerPrice + 1.75 * risk;
          takeProfit2 = triggerPrice + 3.0 * risk;

          const divText = rsiDivergence ? 'confluencia de fallo de MACD y divergencia RSI' : 'fallo de MACD confirmado';
          reasoning = `MFLS Compra: Barrido de soporte ($${formatSmartPrice(prevSwingLow)}) con penetración ${penetrationPct.toFixed(2)}%, reclaim al cierre ($${formatSmartPrice(currCandle.close)}), ${divText}.`;
        }
      }
    }
  }

  // -------------------------------------------------------------
  // EVALUAR LADO CORTO (SELL - BARRIDO DE RESISTENCIA + RECLAIM)
  // -------------------------------------------------------------
  if (signal === 'NEUTRAL' && prevSwingHigh !== null && prevSwingHighIdx !== null && prevSwingHighIdx < i) {
    const sweepDepth = currCandle.high - prevSwingHigh;
    const isSweep = currCandle.high > prevSwingHigh && sweepDepth > 0 && sweepDepth <= maxSweepDist;
    const isReclaimClose = currCandle.close < prevSwingHigh;

    if (isSweep && isReclaimClose) {
      // Prior BUY evaluation was invalidated or didn't trigger, but now we have a valid SELL sweep & reclaim candidate
      discardReason = undefined;
      reasoning = '';
      setupSide = 'SELL';
      sweepPrice = currCandle.high;
      pivotReference = prevSwingHigh;
      penetrationPct = (sweepDepth / prevSwingHigh) * 100;
      isReclaim = true;

      let sellInvalidated = false;
      if (triggerPrice > prevSwingHigh || triggerPrice >= currCandle.high) {
        sellInvalidated = true;
        discardReason = 'riskFilter';
        reasoning = `Descartado: Reclaim bajista invalidado por precio (${formatSmartPrice(triggerPrice)} > resistencia ${formatSmartPrice(prevSwingHigh)})`;
      }
      const maxChasingDist = Math.max(1.2 * atr, Math.min(1.8 * atr, 0.015 * triggerPrice));
      if (!sellInvalidated && triggerPrice < prevSwingHigh - maxChasingDist) {
        sellInvalidated = true;
        discardReason = 'riskFilter';
        reasoning = 'Descartado: Precio en vivo escapado de la zona de resistencia (deslizamiento excesivo)';
      }

      if (!sellInvalidated) {
        let wideBullBars = 0;
        let maxPriorHigh = -Infinity;
        let minPriorLow = Infinity;
        const lookStart = Math.max(0, i - 4);
        for (let kIdx = lookStart; kIdx < i; kIdx++) {
          const k = ctx.klines5m[kIdx];
          if (k.close > k.open && candleBodyRatio(k) >= 0.45) wideBullBars++;
          if (k.high > maxPriorHigh) maxPriorHigh = k.high;
          if (k.low < minPriorLow) minPriorLow = k.low;
        }
        const priorRally = (maxPriorHigh > -Infinity && minPriorLow < Infinity) ? (maxPriorHigh - minPriorLow) : 0;
        const priceRallyAtr = priorRally / atr;
        hasImbalance = wideBullBars >= 2 || priceRallyAtr >= 1.6;

        const currMacd = ctx.macdData.macd[i];
        const prevMacd = ctx.macdData.macd[i - 1];
        const pivotMacd = ctx.macdData.macd[prevSwingHighIdx];
        const macdCurlingDown = currMacd < prevMacd;
        const macdLowerHigh = currMacd < pivotMacd;
        macdDivergence = macdCurlingDown && macdLowerHigh;

        const currRsi = ctx.rsiSeries[i];
        const pivotRsi = ctx.rsiSeries[prevSwingHighIdx];
        rsiDivergence = currRsi < pivotRsi;

        const range = currCandle.high - currCandle.low;
        const upperWick = currCandle.high - Math.max(currCandle.open, currCandle.close);
        const upperWickRatio = range > 0 ? (upperWick / range) : 1;
        const minWickRequired = rvol >= 6.0 ? 0.40 : 0.25;
        const hasRejectionWick = upperWickRatio >= minWickRequired;

        if (rvol >= 6.0 && !hasRejectionWick) {
          sellInvalidated = true;
          discardReason = 'volumeFilter';
          reasoning = `Descartado: Volumen anómalo (RVOL ${rvol.toFixed(1)}x) sin absorción vendedora suficiente (mecha sup ${(upperWickRatio * 100).toFixed(0)}% < 40%)`;
        } else if (!hasRejectionWick) {
          sellInvalidated = true;
          discardReason = 'riskFilter';
          reasoning = `Descartado: Mecha de rechazo superior insuficiente (${(upperWickRatio * 100).toFixed(0)}% < 25%)`;
        }

        if (!sellInvalidated && hasImbalance && macdDivergence && hasRejectionWick) {
          signal = 'SELL';

          const rawSL = sweepPrice + 0.8 * atr;
          const minRiskDist = Math.max(0.8 * atr, triggerPrice * 0.0040);
          stopLoss = Math.max(rawSL, triggerPrice + minRiskDist);
          const risk = stopLoss - triggerPrice;

          takeProfit1 = triggerPrice - 1.75 * risk;
          takeProfit2 = triggerPrice - 3.0 * risk;

          const divText = rsiDivergence ? 'confluencia de fallo de MACD y divergencia RSI' : 'fallo de MACD confirmado';
          reasoning = `MFLS Venta: Barrido de resistencia ($${formatSmartPrice(prevSwingHigh)}) con penetración ${penetrationPct.toFixed(2)}%, reclaim bajista al cierre ($${formatSmartPrice(currCandle.close)}), ${divText}.`;
        }
      }
    }
  }

  // -------------------------------------------------------------
  // VALIDACIÓN DE RIESGO FINAL Y LÍMITES
  // -------------------------------------------------------------
  if (signal !== 'NEUTRAL') {
    discardReason = undefined;
    const risk = Math.abs(triggerPrice - stopLoss);
    const maxRiskPct = 0.025; // 2.5% max risk
    const riskPct = triggerPrice > 0 ? (risk / triggerPrice) : 0;
    const minRiskDist = Math.max(0.8 * atr, triggerPrice * 0.0040);

    if (riskPct > maxRiskPct) {
      signal = 'NEUTRAL';
      discardReason = 'riskFilter';
      reasoning = `Descartado: Riesgo excesivo (${(riskPct * 100).toFixed(2)}% vs máx 2.50%).`;
    } else if (risk > 2.5 * atr && risk > minRiskDist) {
      signal = 'NEUTRAL';
      discardReason = 'riskFilter';
      reasoning = `Descartado: Barrido estructural demasiado profundo (stop ${risk.toFixed(2)} > 2.5x ATR ${atr.toFixed(2)}).`;
    }
  } else {
    discardReason = discardReason || 'noSetup';
    reasoning = reasoning || 'Sin setup de barrido con reclaim y divergencia en la vela actual';
  }

  // Reset levels if signal degraded to NEUTRAL
  if (signal === 'NEUTRAL') {
    stopLoss = 0;
    takeProfit1 = 0;
    takeProfit2 = 0;
  }

  const risk = Math.abs(triggerPrice - stopLoss);
  const riskRewardRatio = risk > 0 ? Number((Math.abs(takeProfit1 - triggerPrice) / risk).toFixed(2)) : 0;

  return {
    signal,
    setupSide,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardRatio,
    triggerPrice,
    sweepPrice,
    pivotReference,
    penetrationPct: Number(penetrationPct.toFixed(2)),
    isReclaim,
    macdDivergence,
    rsiDivergence,
    hasImbalance,
    reasoning,
    discardReason
  };
}

