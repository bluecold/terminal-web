import type { Kline } from '../services/api';
import { calculateATRSeries, getEffectiveExecutionPrice } from './indicators';
import { calculateAlertLevels, isValidTradeGeometry, isTradeFrictionViable, validateScoringSRRoom, DEFAULT_FRICTION_PCT, DEFAULT_SLIPPAGE_PCT } from './tradeLevels';
import type { TradeLevels } from './tradeSimulator';

interface EngineLevels {
  signal: string;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit3?: number;
}

export interface OperationalTradeInput {
  strategy: string;
  signal: string;
  executionStyle: 'dayTrading' | 'swing';
  raw: Record<string, Kline[]>;
  closed: Record<string, Kline[]>;
  vcme?: EngineLevels;
  multifractal?: EngineLevels;
  mfls?: EngineLevels;
  isCrypto?: boolean;
  frictionPct?: number;
  slippagePct?: number;
}

/** The same native snapshot and levels drive notifications, sizing and overlays. */
export function resolveOperationalTrade(input: OperationalTradeInput) {
  const {
    strategy,
    signal,
    executionStyle,
    isCrypto = true,
    frictionPct = input.frictionPct ?? DEFAULT_FRICTION_PCT,
    slippagePct = DEFAULT_SLIPPAGE_PCT
  } = input;
  const interval = (strategy === 'multifractal' || strategy === 'mfls') ? '5m' : executionStyle === 'swing' ? '1h' : '5m';
  const signalKlines = input.closed[interval] ?? [];
  const entryPrice = getEffectiveExecutionPrice(input.raw[interval], signalKlines);
  let levels: TradeLevels = { entryPrice, stopLoss: 0, takeProfit1: 0 };
  let reason = '';
  if (strategy === 'multitemporal' || strategy === 'multifractal' || strategy === 'mfls') {
    const engine = strategy === 'multitemporal' ? input.vcme : strategy === 'multifractal' ? input.multifractal : input.mfls;
    const direction = signal.includes('BUY') ? 'BUY' : signal.includes('SELL') ? 'SELL' : 'NEUTRAL';
    if (!engine || engine.signal !== direction || direction === 'NEUTRAL') {
      reason = 'La dirección elegida no coincide con una señal operativa del motor.';
    } else if (strategy === 'multitemporal') {
      levels = { entryPrice, stopLoss: engine.stopLoss, takeProfit1: engine.takeProfit1 ?? 0,
        takeProfit2: engine.takeProfit2, takeProfit3: engine.takeProfit3 };
    } else if (strategy === 'mfls') {
      levels = { entryPrice, stopLoss: engine.stopLoss, takeProfit1: engine.takeProfit1 ?? 0,
        takeProfit2: engine.takeProfit2 };
    } else {
      const risk = Math.abs(entryPrice - engine.stopLoss);
      levels = { entryPrice, stopLoss: engine.stopLoss, takeProfit1: entryPrice + (direction === 'BUY' ? 1 : -1) * 1.5 * risk };
    }
  } else if (['standard', 'confluencia', 'scoring'].includes(strategy)) {
    const atr = calculateATRSeries(signalKlines, 14);
    levels = {
      entryPrice,
      ...calculateAlertLevels(signal, entryPrice, interval, atr[atr.length - 1], strategy, { isCrypto })
    };
  } else {
    reason = 'No hay una estrategia operativa disponible.';
  }
  const validGeometry = !reason && signalKlines.length > 0 && isValidTradeGeometry(signal, levels);
  const frictionViable = validGeometry && isTradeFrictionViable(levels.entryPrice, levels.stopLoss, frictionPct, slippagePct);
  let srViable = true;
  if (strategy === 'scoring' && validGeometry && frictionViable) {
    const srValidation = validateScoringSRRoom(
      signalKlines,
      signalKlines.length - 1,
      signal,
      entryPrice,
      levels.takeProfit1,
      levels.stopLoss
    );
    if (!srValidation.viable) {
      srViable = false;
      reason = srValidation.reason ?? 'Riesgo/recompensa insuficiente hacia soporte o resistencia.';
    }
  }
  const valid = validGeometry && frictionViable && srViable;
  if (!valid && !reason) {
    reason = !validGeometry
      ? 'Entrada, stop u objetivos inválidos para esta dirección.'
      : 'Riesgo insuficiente frente a comisiones (fricción consume > 35% del stop).';
  }
  const riskDistance = valid ? Math.abs(entryPrice - levels.stopLoss) / entryPrice : 0;
  return { strategy, signal, interval, signalKlines, entryPrice, levels, valid, validGeometry, frictionViable, srViable, reason, riskDistance };
}
