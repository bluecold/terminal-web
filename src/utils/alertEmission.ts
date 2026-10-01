import type { AlertStatus, AuditAlertItem } from './alertTracker';
import type { ConfidenceLevel } from './tournament';
import type { LiveDiscardReason } from './liveDiscards';
import { isNyseSessionClosingCandle, isNyseTradingSessionActive } from './indicators';
import { checkAlertCooldownStatus, type AlertCooldownRecord } from './radarFilters';

/**
 * Pure decision of whether the live scanner emits an alert for an operationally viable candidate.
 * Extracted from the App scanner so every gate (exploratory opt-in, open position, NYSE session,
 * session-closing candle, candle deduplication and cooldown) is unit-testable.
 */

const ACTIVE_STATUSES = new Set<AlertStatus>(['OPEN', 'TP1_HIT', 'TP2_HIT']);

/** Exploratory/informational selections (confidence NONE) are tracked apart from PRIMARY alerts. */
export function isExploratorySelection(selection: { confidence: ConfidenceLevel; strategyLabel: string }): boolean {
  return selection.confidence === 'NONE' || selection.strategyLabel.includes('(Exploratoria)');
}

export interface AlertEmissionInput {
  symbol: string;
  interval: string;
  signal: string;
  strategyKey: string;
  strategyLabel: string;
  confidence: ConfidenceLevel;
  executionStyle: 'dayTrading' | 'swing';
  isCrypto: boolean;
  candleTimestamp: number;              // Unix seconds of the closed trigger candle (0 if unknown)
  nowMs: number;
  validGeometry: boolean;
  allowExploratoryAlerts: boolean;
  activeAlerts: Pick<AuditAlertItem, 'symbol' | 'interval' | 'status' | 'alertType'>[];
  alreadyFiredForCandle: boolean;
  cooldowns: Record<string, number | AlertCooldownRecord>;
}

export interface AlertEmissionDecision {
  emit: boolean;
  isExploratory: boolean;
  discards: LiveDiscardReason[];       // Telemetry reasons, in the order they were detected
}

export function evaluateAlertEmission(input: AlertEmissionInput): AlertEmissionDecision {
  const isExploratory = isExploratorySelection({ confidence: input.confidence, strategyLabel: input.strategyLabel });
  const discards: LiveDiscardReason[] = [];
  const isDirectional = input.signal.includes('BUY') || input.signal.includes('SELL');
  const hasStatisticalConfidence = !isExploratory || input.allowExploratoryAlerts;
  const isActionable = isDirectional && input.validGeometry && hasStatisticalConfidence;

  if (isDirectional && input.validGeometry && !hasStatisticalConfidence) {
    discards.push('confidence');
  }

  // Single position per symbol & timeframe. An active exploratory alert never blocks a PRIMARY one.
  const hasActiveTrade = input.activeAlerts.some(a =>
    a.symbol === input.symbol &&
    a.interval === input.interval &&
    ACTIVE_STATUSES.has(a.status) &&
    (isExploratory ? true : (a.alertType ?? 'PRIMARY') !== 'EXPLORATORY')
  );
  if (hasActiveTrade) {
    discards.push('activeTrade');
    return { emit: false, isExploratory, discards };
  }

  // Equities: no live alerts outside the regular NYSE session, nor on the session's closing candle
  // (entering on the next bar would cross an overnight gap), except the multi-day VCME Swing model.
  if (!input.isCrypto) {
    if (!isNyseTradingSessionActive(input.nowMs)) {
      discards.push('marketHours');
      return { emit: false, isExploratory, discards };
    }
    const isSwingVCME = (input.strategyKey === 'multitemporal' || input.strategyLabel.includes('VCME')) && input.executionStyle === 'swing';
    if (!isSwingVCME && isNyseSessionClosingCandle(input.candleTimestamp, input.interval, input.symbol)) {
      discards.push('marketHours');
      return { emit: false, isExploratory, discards };
    }
  }

  const { inCooldown } = checkAlertCooldownStatus(
    input.symbol,
    input.interval,
    isExploratory,
    input.executionStyle,
    input.cooldowns,
    input.nowMs
  );
  if (isActionable && !input.alreadyFiredForCandle && inCooldown) {
    discards.push('cooldown');
  }

  return { emit: isActionable && !input.alreadyFiredForCandle && !inCooldown, isExploratory, discards };
}
