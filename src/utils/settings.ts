/**
 * Typed localStorage keys and safe accessors for the app shell (App.tsx and the scanner hook).
 * Every read/write is wrapped so a blocked or full storage never breaks rendering or scanning.
 * Domain modules with their own persistence (alertTracker, alertReport, liveDiscards,
 * scannerLeadership) keep their keys next to their logic.
 */
export const STORAGE_KEYS = {
  alertsLog: 'terminal_alerts_log',
  alertCooldowns: 'terminal_alert_cooldowns',
  exploratoryAlerts: 'terminal_exploratory_alerts',
  exploratoryNotifications: 'terminal_exploratory_notifications',
  notificationsEnabled: 'terminal_notifications_enabled',
  leftCollapsed: 'terminal_left_collapsed',
  rightCollapsed: 'terminal_right_collapsed',
  currentAsset: 'terminal_current_asset',
  timeInterval: 'terminal_time_interval',
  splitView: 'terminal_split_view',
  splitInterval: 'terminal_split_interval',
  showBB: 'terminal_show_bb',
  watchlist: 'terminal_watchlist',
  executionStyle: 'terminal_execution_style',
  triggerMode: 'terminal_trigger_mode',
  scoringWeights: 'terminal_scoring_weights',
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

export function readSetting(key: StorageKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: StorageKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.error(`Error saving ${key} to local storage`, e);
  }
}

export function removeSetting(key: StorageKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const readBoolSetting = (key: StorageKey): boolean => readSetting(key) === 'true';
export const writeBoolSetting = (key: StorageKey, value: boolean): void => writeSetting(key, value ? 'true' : 'false');

export function readJsonSetting<T>(key: StorageKey): T | null {
  const raw = readSetting(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`Error parsing ${key} from local storage`, e);
    return null;
  }
}

export const writeJsonSetting = (key: StorageKey, value: unknown): void => writeSetting(key, JSON.stringify(value));

/** Exploratory/informational alerts are logged when either the 🔬 logging or their notifications are on. */
export const isExploratoryLoggingEnabled = (): boolean =>
  readBoolSetting(STORAGE_KEYS.exploratoryAlerts) || readBoolSetting(STORAGE_KEYS.exploratoryNotifications);

export const isExploratoryNotificationEnabled = (): boolean => readBoolSetting(STORAGE_KEYS.exploratoryNotifications);

/** Desktop notifications need both the in-app switch and the browser permission. */
export const areDesktopNotificationsEnabled = (): boolean =>
  readBoolSetting(STORAGE_KEYS.notificationsEnabled) && typeof window !== 'undefined'
  && ('Notification' in window) && Notification.permission === 'granted';
