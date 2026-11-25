/**
 * Persistent store for the INFORME archive (resolved alerts, 90 days).
 *
 * Lives in IndexedDB: no ~5 MB localStorage quota shared with the rest of the app, and writes do not
 * block the UI. The first read migrates the legacy localStorage copy ('terminal_alert_archive') and
 * frees it. Where IndexedDB is unavailable (some private modes, tests) it falls back to localStorage.
 * Updates run read-modify-write inside one IndexedDB transaction, so two tabs never overwrite each
 * other's entries.
 */
import { ALERT_ARCHIVE_STORAGE_KEY, loadAlertArchive, saveAlertArchive, type ArchivedAlert } from './alertReport';

const DB_NAME = 'terminal-lite';
const DB_VERSION = 1;
const STORE = 'kv';
const ARCHIVE_RECORD = 'alertArchive';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function legacyStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function asArchive(value: unknown): ArchivedAlert[] | undefined {
  return Array.isArray(value) ? value.filter(a => a && typeof a.id === 'string') : undefined;
}

/** Applies `mutate` to the stored archive atomically and returns the saved result. */
export async function updateAlertArchive(mutate: (current: ArchivedAlert[]) => ArchivedAlert[]): Promise<ArchivedAlert[]> {
  const db = await openDb();
  if (!db) {
    const storage = legacyStorage();
    const current = loadAlertArchive(storage);
    const next = mutate(current);
    if (next === current) return next;
    if (!storage || !saveAlertArchive(next, storage)) {
      throw new Error('El navegador no permitió guardar el archivo de alertas.');
    }
    return next;
  }
  return new Promise<ArchivedAlert[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let next: ArchivedAlert[] = [];
    const get = store.get(ARCHIVE_RECORD);
    get.onsuccess = () => {
      let current = asArchive(get.result);
      let migrated = false;
      if (current === undefined) {
        // First use: bring the legacy localStorage archive over
        current = loadAlertArchive(legacyStorage());
        migrated = true;
      }
      try {
        next = mutate(current);
      } catch (e) {
        tx.abort();
        reject(e);
        return;
      }
      // Reads (mutate returns the same array) write nothing, except the one-time migration
      if (next !== current || migrated) store.put(next, ARCHIVE_RECORD);
      if (migrated) {
        tx.addEventListener('complete', () => {
          try { legacyStorage()?.removeItem(ALERT_ARCHIVE_STORAGE_KEY); } catch { /* ignore */ }
        });
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error ?? new Error('No se pudo guardar el archivo de alertas.'));
    tx.onabort = () => reject(tx.error ?? new Error('Se canceló el guardado del archivo de alertas.'));
  });
}

/** Reads the stored archive (migrating the legacy copy on first use). */
export function readAlertArchive(): Promise<ArchivedAlert[]> {
  return updateAlertArchive(current => current);
}
