import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditAlertItem } from '../alertTracker';
import {
  ALERT_ARCHIVE_STORAGE_KEY,
  archiveInputSignature,
  buildAlertExport,
  mergeArchivedAlerts,
  mergeIntoAlertArchive,
  parseAlertImport,
  toArchivedAlert,
} from '../alertReport';
import { pruneSeenDiscardKeys, generateDiscardDedupKey } from '../liveDiscards';
import { pruneExpiredCooldowns } from '../radarFilters';
import { ApiResponseCache } from '../../services/api';
import { readAlertArchive, updateAlertArchive } from '../alertArchiveStore';

const NOW = Date.UTC(2026, 10, 25, 21, 0);
const DAY = 86_400_000;

const alert = (over: Partial<AuditAlertItem>): AuditAlertItem => ({
  id: over.id ?? 'a', symbol: 'MSFT', interval: '5m', signal: 'BUY', time: '', pf: null, strategy: 'Confluencia',
  entryPrice: 100, stopLoss: 99, takeProfit1: 101.5, status: 'SL_HIT', realizedR: -1, pnlPercent: -1,
  timestamp: NOW - DAY, candleTimestamp: Math.floor((NOW - DAY - 320_000) / 1000), alertType: 'PRIMARY',
  ...over,
});

test('Archive keeps the whole 90-day window beyond the old 3000-alert cap', () => {
  // ~42 closed alerts per day (measured live) over 89 days ≈ 3,700 alerts
  const alerts = Array.from({ length: 3738 }, (_, k) => {
    const ts = NOW - Math.floor(k / 42) * DAY - (k % 42) * 60_000 - 3_600_000;
    return toArchivedAlert(alert({ id: `a${k}`, symbol: `S${k % 50}`, timestamp: ts, candleTimestamp: Math.floor(ts / 1000) - 320 }));
  });
  const merged = mergeArchivedAlerts([alerts], NOW);
  assert.equal(merged.length, 3738);
  // Older than 90 days still leaves
  const old = toArchivedAlert(alert({ id: 'old', timestamp: NOW - 91 * DAY, candleTimestamp: Math.floor((NOW - 91 * DAY) / 1000) }));
  assert.equal(mergeArchivedAlerts([[old]], NOW).length, 0);
});

test('Archive input signature ignores active alerts and changes when an alert closes', () => {
  const open = alert({ id: 'x', status: 'OPEN', realizedR: 0 });
  const closed = alert({ id: 'y', status: 'TP1_CLOSED', realizedR: 1.2 });
  assert.equal(archiveInputSignature([open]), '');
  const before = archiveInputSignature([open, closed]);
  assert.equal(archiveInputSignature([{ ...open, pnlPercent: 0.4 }, closed]), before, 'floating P&L of open alerts does not rewrite the archive');
  assert.notEqual(archiveInputSignature([{ ...open, status: 'SL_HIT', realizedR: -1 }, closed]), before);
  assert.notEqual(archiveInputSignature([open, { ...closed, userFillPrice: 100.2 }]), before);
});

test('Backup export round-trips and imports merge without duplicates', () => {
  const closed = alert({ id: 'c1', status: 'TP1_CLOSED', realizedR: 1.4 });
  const open = alert({ id: 'o1', status: 'OPEN', realizedR: 0, candleTimestamp: closed.candleTimestamp! + 300 });
  const archive = mergeIntoAlertArchive([], [closed], NOW);
  const file = JSON.parse(JSON.stringify(buildAlertExport(archive, [closed, open], 'v2026.11.25.1', NOW)));
  assert.equal(file.format, 'terminal-lite-alerts');

  const imported = parseAlertImport(file);
  assert.deepEqual([...new Set(imported.map(a => a.id))], ['c1'], 'open alerts are not imported');
  // Importing the same backup twice adds nothing
  const once = mergeArchivedAlerts([archive, imported], NOW);
  assert.equal(mergeArchivedAlerts([once, imported], NOW).length, once.length);
});

test('Import accepts the older console-snippet export and bare arrays, and rejects other files', () => {
  const closed = alert({ id: 'snip', status: 'SL_HIT' });
  const snippet = { exportedAt: '2026-11-06', archive: null, liveLog: [closed, alert({ id: 'live-open', status: 'TP1_HIT' })] };
  assert.deepEqual(parseAlertImport(snippet).map(a => a.id), ['snip']);
  assert.deepEqual(parseAlertImport([toArchivedAlert(closed), { id: 'broken' }]).map(a => a.id), ['snip'], 'invalid entries are dropped');
  assert.throws(() => parseAlertImport({ watchlist: ['AAPL'] }), /no contiene alertas/);
  assert.throws(() => parseAlertImport(null), /no contiene alertas/);
});

test('Seen discard keys forget candles older than a day, including symbols with dashes', () => {
  const nowSec = Math.floor(NOW / 1000);
  const seen = new Set([
    generateDiscardDedupKey('BTC-USD', '5m', nowSec - 600, 'cooldown'),
    generateDiscardDedupKey('BTC-USD', '5m', nowSec - 2 * 86400, 'cooldown'),
    generateDiscardDedupKey('AAPL', '5m', nowSec - 90_000, 'friction'),
    'garbage',
  ]);
  assert.equal(pruneSeenDiscardKeys(seen, nowSec), 3);
  assert.deepEqual([...seen], [generateDiscardDedupKey('BTC-USD', '5m', nowSec - 600, 'cooldown')]);
});

test('Cooldown records older than a week are dropped (longest cooldown is 48 h)', () => {
  const pruned = pruneExpiredCooldowns({
    'A:5m:PRIMARY': { timestamp: NOW - 2 * DAY, outcome: 'SL' },
    'B:5m:PRIMARY': NOW - 8 * DAY,
    'C:1d:PRIMARY': { timestamp: NOW - 8 * DAY },
    'D:5m:PRIMARY': { timestamp: Number.NaN },
  }, NOW);
  assert.deepEqual(Object.keys(pruned), ['A:5m:PRIMARY']);
});

test('API response cache evicts the least recently used beyond its cap and sweeps expired entries', () => {
  const cache = new ApiResponseCache(3, 60_000);
  const now = Date.now();
  cache.set('a', { timestamp: now, data: 1 });
  cache.set('b', { timestamp: now, data: 2 });
  cache.set('c', { timestamp: now, data: 3 });
  assert.equal(cache.get('a')?.data, 1); // touch: 'b' becomes the oldest
  cache.set('d', { timestamp: now, data: 4 });
  assert.deepEqual([...cache.keys()].sort(), ['a', 'c', 'd']);

  cache.set('old', { timestamp: now - 120_000, data: 0 });
  cache.sweepExpired(now);
  assert.equal(cache.has('old'), false);
});

test('Archive store falls back to localStorage without IndexedDB and migrates nothing twice', async () => {
  const data = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
  try {
    const existing = toArchivedAlert(alert({ id: 'legacy', status: 'SL_HIT' }));
    data.set(ALERT_ARCHIVE_STORAGE_KEY, JSON.stringify([existing]));
    assert.deepEqual((await readAlertArchive()).map(a => a.id), ['legacy']);

    const added = toArchivedAlert(alert({ id: 'new', status: 'TP1_CLOSED', realizedR: 1, candleTimestamp: existing.candleTimestamp! + 300 }));
    const saved = await updateAlertArchive(current => mergeArchivedAlerts([current, [added]], NOW));
    assert.deepEqual(saved.map(a => a.id).sort(), ['legacy', 'new']);
    assert.equal(JSON.parse(data.get(ALERT_ARCHIVE_STORAGE_KEY)!).length, 2);
  } finally {
    g.localStorage = previous;
  }
});
