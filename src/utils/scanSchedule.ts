/**
 * Alert scanner cadence aligned to candle closes.
 *
 * Confluencia's net edge on 5m equities decays quickly with execution delay (1m-candle study:
 * ~0R lost at 1 minute, -0.05R at 2 minutes, -0.08R at 3 minutes), so the scanner runs a few
 * seconds after every minute boundary instead of on a free-running 60s interval. Every fifth run
 * lands right after a 5m candle close. The offset leaves the data provider time to finalize the
 * just-closed candle.
 */
export const SCAN_STEP_MS = 60_000;
export const SCAN_CLOSE_OFFSET_MS = 8_000;

export function getMsUntilNextAlignedScan(
  nowMs: number,
  stepMs: number = SCAN_STEP_MS,
  offsetMs: number = SCAN_CLOSE_OFFSET_MS
): number {
  const next = Math.floor((nowMs - offsetMs) / stepMs) * stepMs + stepMs + offsetMs;
  return Math.max(250, next - nowMs);
}
