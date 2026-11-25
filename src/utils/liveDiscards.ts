export type LiveDiscardReason = 'friction' | 'activeTrade' | 'marketHours' | 'cooldown' | 'geometry' | 'confidence';

export interface LiveDiscardStats {
  total: number;
  friction: number;
  activeTrade: number;
  marketHours: number;
  cooldown: number;
  geometry: number;
  confidence: number;
}

export const DISCARD_REASON_LABELS: Record<LiveDiscardReason, { label: string; icon: string; short: string; description: string }> = {
  friction: {
    label: 'Fricción / Comisiones',
    icon: '⚡',
    short: 'Fricción',
    description: 'Riesgo menor al mínimo viable (fricción consume > 35% del stop en 5m)',
  },
  marketHours: {
    label: 'Horario / Sesión',
    icon: '🕒',
    short: 'Horario',
    description: 'Mercado cerrado o vela final de sesión en acciones EEUU (riesgo de gap)',
  },
  activeTrade: {
    label: 'Posición Abierta',
    icon: '⏳',
    short: 'Posición',
    description: 'Ya existe una posición activa (OPEN/TP1) en este activo e intervalo',
  },
  cooldown: {
    label: 'Cooldown Activo',
    icon: '⏱️',
    short: 'Cooldown',
    description: 'Tiempo mínimo entre alertas no cumplido para evitar sobreoperar',
  },
  geometry: {
    label: 'Geometría Inválida',
    icon: '📐',
    short: 'Geometría',
    description: 'Stop Loss o TP invertido, nulo o fuera de rango para la dirección',
  },
  confidence: {
    label: 'Sin Ventaja / Exploratoria',
    icon: '🔬',
    short: 'Confianza',
    description: 'Estrategia sin muestra estadística validada (Confidence = NONE)',
  },
};

export const DISCARDS_STORAGE_KEY = 'terminal_discard_stats';

export function createInitialDiscardStats(): LiveDiscardStats {
  return {
    total: 0,
    friction: 0,
    activeTrade: 0,
    marketHours: 0,
    cooldown: 0,
    geometry: 0,
    confidence: 0,
  };
}

export function loadDiscardStats(): LiveDiscardStats {
  if (typeof localStorage === 'undefined') return createInitialDiscardStats();
  try {
    const raw = localStorage.getItem(DISCARDS_STORAGE_KEY);
    if (!raw) return createInitialDiscardStats();
    const parsed = JSON.parse(raw);
    return {
      total: Number(parsed.total) || 0,
      friction: Number(parsed.friction) || 0,
      activeTrade: Number(parsed.activeTrade) || 0,
      marketHours: Number(parsed.marketHours) || 0,
      cooldown: Number(parsed.cooldown) || 0,
      geometry: Number(parsed.geometry) || 0,
      confidence: Number(parsed.confidence) || 0,
    };
  } catch {
    return createInitialDiscardStats();
  }
}

export function saveDiscardStats(stats: LiveDiscardStats): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DISCARDS_STORAGE_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error('Error saving discard stats to localStorage', e);
  }
}

export function clearDiscardStats(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DISCARDS_STORAGE_KEY);
  } catch (e) {
    console.error('Error clearing discard stats from localStorage', e);
  }
}

/**
 * Generates an atomic deduplication key for a discarded signal.
 * Ensures that continuous scanner polling of the same candle does not artificially inflate the discard counter.
 */
export function generateDiscardDedupKey(
  symbol: string,
  interval: string,
  candleTimestamp: number,
  reason: LiveDiscardReason
): string {
  const sym = (symbol || '').toUpperCase().trim();
  const intv = (interval || '').toLowerCase().trim();
  return `${sym}-${intv}-${candleTimestamp}-${reason}`;
}

/**
 * Forgets dedup keys of candles older than `maxAgeSec`: a closed candle is never re-evaluated after
 * its scan window, so its key can no longer prevent a double count. Keeps the in-memory set bounded
 * when the tab stays open for days. Returns how many keys were removed.
 */
export function pruneSeenDiscardKeys(seenKeys: Set<string>, nowSec: number, maxAgeSec: number = 86400): number {
  let removed = 0;
  for (const key of seenKeys) {
    // Key layout: SYMBOL-interval-candleTimestamp-reason (the symbol itself may contain '-')
    const match = /-(\d+)-[A-Za-z]+$/.exec(key);
    const candleSec = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(candleSec) || nowSec - candleSec > maxAgeSec) {
      seenKeys.delete(key);
      removed++;
    }
  }
  return removed;
}

export const SEEN_DISCARD_KEYS_PRUNE_THRESHOLD = 2000;

/**
 * Records a discard event if not already present in the seenKeys set.
 * Returns the updated stats object and a boolean indicating if it was newly recorded.
 */
export function recordDiscardEvent(
  stats: LiveDiscardStats,
  seenKeys: Set<string>,
  symbol: string,
  interval: string,
  candleTimestamp: number,
  reason: LiveDiscardReason
): { stats: LiveDiscardStats; recorded: boolean } {
  const key = generateDiscardDedupKey(symbol, interval, candleTimestamp, reason);
  if (seenKeys.has(key)) {
    return { stats, recorded: false };
  }
  seenKeys.add(key);
  const updated = {
    ...stats,
    total: stats.total + 1,
    [reason]: stats[reason] + 1,
  };
  saveDiscardStats(updated);
  return {
    stats: updated,
    recorded: true,
  };
}
