import type { ConfidenceLevel } from './tournament';
import { getAlertCooldownKey } from './alertTracker';
import { getStrategyCooldownMs } from './backtester';

export interface AlertCooldownRecord {
  timestamp: number;
  outcome?: 'SL' | 'TP' | 'TIMEOUT' | 'ENTRY' | string;
}

/** Longest cooldown is 48 h (1d position); entries a week old can never block an alert again. */
export const COOLDOWN_RECORD_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Drops cooldown records older than `maxAgeMs` (they no longer affect any alert). */
export function pruneExpiredCooldowns(
  cooldowns: Record<string, number | AlertCooldownRecord>,
  nowMs: number,
  maxAgeMs: number = COOLDOWN_RECORD_MAX_AGE_MS
): Record<string, number | AlertCooldownRecord> {
  const out: Record<string, number | AlertCooldownRecord> = {};
  for (const [key, record] of Object.entries(cooldowns ?? {})) {
    const ts = typeof record === 'number' ? record : record?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && nowMs - ts <= maxAgeMs) out[key] = record;
  }
  return out;
}

export interface RadarRowData {
  symbol: string;
  name: string;
  isCrypto: boolean;
  price: number;
  changePercent: number;
  signal5m: string;
  signal1h: string;
  signal1d: string;
  overallSignal: string;
  isFullConfluence: boolean;
  confluenceType: 'BUY_3' | 'SELL_3' | 'BUY_2' | 'SELL_2' | 'PARTIAL' | 'NEUTRAL';
  confluenceScore: number;
  qveStrategy: string;
  qveProfitFactor: number | null;
  qveConfidence: ConfidenceLevel;
  signalConfidence: ConfidenceLevel;
  rvol: number;
  volatilityStatus: 'SQUEEZE' | 'EXPANSION' | 'NORMAL';
  bbWidthPercent: number;
  bbPercentile: number;
  loading: boolean;
  isOffline?: boolean;
  offlineReason?: string;
  isMarketClosed?: boolean;
  confluenceWarning?: string;
  hasPartialData?: boolean;
  qveReasoning?: string;
  activeStrategyLabel?: string;
  isFallbackSignal?: boolean;
  actionableReasoning?: string;
  isOperationalViable?: boolean;
  operationalReason?: string;
  isCooldownActive?: boolean;
  cooldownRemainingMs?: number;
  isSessionClosingCandle?: boolean;
}

export type RadarFilter = 'all' | 'confluence' | 'squeeze' | 'rvol' | 'active';
export type SortColumn = 'symbol' | 'price' | 'changePercent' | 'qveProfitFactor' | 'rvol' | 'bbWidthPercent' | 'confluenceScore';

/**
 * Computes whether an alert cooldown is active for the given symbol and interval,
 * and returns the remaining cooldown duration in milliseconds.
 */
export function checkAlertCooldownStatus(
  symbol: string,
  interval: string,
  isExploratory: boolean,
  style: 'dayTrading' | 'swing',
  cooldowns: Record<string, number | AlertCooldownRecord> = {},
  nowMs: number = Date.now()
): { inCooldown: boolean; remainingMs: number } {
  const cooldownKey = getAlertCooldownKey({
    symbol,
    interval,
    alertType: isExploratory ? 'EXPLORATORY' : 'PRIMARY',
  });
  const record = cooldowns[cooldownKey];
  if (!record) return { inCooldown: false, remainingMs: 0 };

  const lastAlertTime = typeof record === 'number' ? record : (record?.timestamp || 0);
  const outcome = typeof record === 'object' ? record?.outcome : undefined;
  const cooldownMs = getStrategyCooldownMs(interval, style, outcome);
  const elapsed = nowMs - lastAlertTime;
  if (elapsed >= cooldownMs) {
    return { inCooldown: false, remainingMs: 0 };
  }
  return { inCooldown: true, remainingMs: Math.max(0, cooldownMs - elapsed) };
}

/**
 * Validates whether a radar row possesses an active, validated signal or open position.
 * - Always preserves active open positions tracked in the current session (activeSignals).
 * - For new signals: requires validated statistical confidence (HIGH or LIMITED),
 *   active market session (not closed), operational trade plan viability
 *   (valid geometry, friction <= 0.35R, and S/R room), absence of post-loss/exit
 *   anti-revenge cooldowns, and non-closing session candle (to avoid overnight gaps in equities).
 */
export function isRadarRowActive(
  row: RadarRowData,
  activeSignals: Record<string, string> = {},
  allowExploratory: boolean = false
): boolean {
  // 1. Preserves existing open positions tracked in the active session
  if (activeSignals[row.symbol]) {
    return true;
  }

  // 2. Reject new signals if market is closed (e.g. equities outside NYSE hours)
  if (row.isMarketClosed) {
    return false;
  }

  // 3. Reject new equity signals occurring on the final closing candle of the session (overnight gap risk)
  if (row.isSessionClosingCandle) {
    return false;
  }

  // 4. Reject new signals under active post-exit or anti-revenge cooldown
  if (row.isCooldownActive) {
    return false;
  }

  // 5. Reject unvalidated or non-directional signals (unless allowExploratory is explicitly enabled)
  const isDirectional = row.overallSignal.includes('BUY') || row.overallSignal.includes('SELL');
  const hasValidatedSignal =
    (allowExploratory || row.signalConfidence !== 'NONE') && isDirectional;
  if (!hasValidatedSignal) {
    return false;
  }

  // 6. Reject signals whose operational plan is unviable (friction > 0.35R, S/R barrier, invalid geometry)
  if (row.isOperationalViable === false) {
    return false;
  }

  return true;
}
