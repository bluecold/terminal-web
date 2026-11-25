import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEYS,
  readSetting,
  readJsonSetting,
  writeJsonSetting,
  isExploratoryLoggingEnabled,
  isExploratoryNotificationEnabled,
  areDesktopNotificationsEnabled,
} from '../settings';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) { this.data.set(k, String(v)); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

const g = globalThis as unknown as { localStorage?: MemoryStorage };

beforeEach(() => {
  g.localStorage = new MemoryStorage();
});

test('exploratory alerts are logged when either the 🔬 switch or exploratory notifications are on', () => {
  assert.equal(isExploratoryLoggingEnabled(), false);
  g.localStorage!.setItem(STORAGE_KEYS.exploratoryAlerts, 'true');
  assert.equal(isExploratoryLoggingEnabled(), true);
  assert.equal(isExploratoryNotificationEnabled(), false, 'logging alone never notifies');
  g.localStorage!.clear();
  g.localStorage!.setItem(STORAGE_KEYS.exploratoryNotifications, 'true');
  assert.equal(isExploratoryLoggingEnabled(), true);
  assert.equal(isExploratoryNotificationEnabled(), true);
});

test('desktop notifications need the in-app switch (and, in the browser, the permission)', () => {
  g.localStorage!.setItem(STORAGE_KEYS.notificationsEnabled, 'true');
  // No window/Notification in node: never enabled outside the browser.
  assert.equal(areDesktopNotificationsEnabled(), false);
});

test('JSON settings round-trip and malformed values fall back to null', () => {
  writeJsonSetting(STORAGE_KEYS.scoringWeights, { trend: 2 });
  assert.deepEqual(readJsonSetting(STORAGE_KEYS.scoringWeights), { trend: 2 });
  g.localStorage!.setItem(STORAGE_KEYS.scoringWeights, '{broken');
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(readJsonSetting(STORAGE_KEYS.scoringWeights), null);
  } finally {
    console.error = originalError;
  }
});

test('unavailable storage reads as unset instead of throwing', () => {
  delete g.localStorage;
  assert.equal(readSetting(STORAGE_KEYS.currentAsset), null);
  assert.equal(isExploratoryLoggingEnabled(), false);
});
