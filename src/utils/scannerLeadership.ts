/**
 * Only one browser tab may run the alert scanner. Every tab shares the same localStorage
 * (alert log, dedup registry, cooldowns), so two scanners evaluating the same candle close at
 * the same moment could both pass the dedup check and emit the alert twice.
 *
 * Uses the Web Locks API: the lock is held while the tab lives and passes to another open tab
 * when it closes. Without Web Locks support the tab always scans (previous behavior).
 */
export const SCANNER_LOCK_NAME = 'terminal-alert-scanner';

type LockManagerLike = {
  request: (name: string, callback: () => Promise<void>) => Promise<void>;
};

export function acquireScannerLeadership(
  onLeader: () => void,
  locks: LockManagerLike | undefined = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManagerLike }).locks
    : undefined
): () => void {
  if (!locks) {
    onLeader();
    return () => {};
  }
  let release: () => void = () => {};
  let released = false;
  locks.request(SCANNER_LOCK_NAME, () => new Promise<void>(resolve => {
    release = resolve;
    if (released) {
      resolve();
      return;
    }
    onLeader();
  })).catch(() => {
    // Lock request failed: fall back to scanning in this tab rather than never scanning
    if (!released) onLeader();
  });
  return () => {
    released = true;
    release();
  };
}
