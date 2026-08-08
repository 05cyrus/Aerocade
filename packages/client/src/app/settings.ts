/**
 * Player settings: the model, its validation, and IndexedDB persistence
 * (docs/ui.md §6, ADR-007 — local only, no cloud, no accounts).
 *
 * `normalizeSettings` is pure and is where all the risk lives. A settings record
 * is the one piece of state that arrives from *outside* the program — written by
 * an older build, hand-edited, or truncated by a crash — so every field is
 * coerced and clamped on the way in. A corrupt record falls back to defaults
 * rather than blocking entry, because a bad slider value must never stop the
 * game from starting.
 *
 * Every setting here has a real consumer. Notably absent is the spec's
 * "mouse/aim-stick sensitivity": Aerocade aims **absolutely** — the mouse aims
 * at a world point and the aim stick reports a direction — so there is no
 * relative delta for a sensitivity multiplier to scale. Shipping that slider
 * would have been a control that silently does nothing.
 */

/** Bumped when the record's shape changes; older records migrate on load. */
export const SETTINGS_VERSION = 1;

export interface Settings {
  version: number;
  /** Shown in the kill feed in place of "You". */
  playerName: string;
  /** 0–100. Scales the sound bank's master gain. */
  sfxVolume: number;
  muted: boolean;
  /** 0.8–1.4. Scales touch stick radius and the button cluster. */
  controlScale: number;
  /** Mirrors the touch sticks and button cluster. */
  leftHanded: boolean;
  /** Damps camera shake for players who find it uncomfortable. */
  reducedShake: boolean;
}

export const SETTINGS_LIMITS = {
  nameMaxLength: 16,
  sfxVolume: { min: 0, max: 100 },
  controlScale: { min: 0.8, max: 1.4 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  playerName: 'Pilot',
  sfxVolume: 70,
  muted: false,
  controlScale: 1,
  leftHanded: false,
  reducedShake: false,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce anything into a valid `Settings`. This doubles as the migration path:
 * unknown or older records simply keep whatever fields still validate and take
 * defaults for the rest, so adding a field never invalidates a saved record and
 * removing one never leaves a stale value behind.
 */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;

  const name = typeof r.playerName === 'string' ? r.playerName.trim() : '';
  return {
    version: SETTINGS_VERSION,
    // An empty or whitespace-only name would render as a blank kill-feed entry.
    playerName:
      name.length > 0 ? name.slice(0, SETTINGS_LIMITS.nameMaxLength) : DEFAULT_SETTINGS.playerName,
    sfxVolume: Math.round(
      clamp(
        r.sfxVolume,
        SETTINGS_LIMITS.sfxVolume.min,
        SETTINGS_LIMITS.sfxVolume.max,
        DEFAULT_SETTINGS.sfxVolume,
      ),
    ),
    muted: boolOr(r.muted, DEFAULT_SETTINGS.muted),
    controlScale: clamp(
      r.controlScale,
      SETTINGS_LIMITS.controlScale.min,
      SETTINGS_LIMITS.controlScale.max,
      DEFAULT_SETTINGS.controlScale,
    ),
    leftHanded: boolOr(r.leftHanded, DEFAULT_SETTINGS.leftHanded),
    reducedShake: boolOr(r.reducedShake, DEFAULT_SETTINGS.reducedShake),
  };
}

// ---------- persistence ----------

const DB_NAME = 'aerocade';
const DB_VERSION = 1;
const STORE = 'settings';
const RECORD_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexedDB open failed'));
    };
  });
}

/**
 * Read settings. Never rejects: private-browsing modes, disabled storage and
 * corrupt records all resolve to defaults, because failing to read a preference
 * is not a reason to refuse to start.
 */
export async function loadSettings(): Promise<Settings> {
  if (typeof indexedDB === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const db = await openDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_KEY);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('read failed'));
      };
    });
    db.close();
    return normalizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Write settings. Swallows storage failures — a lost preference is not fatal. */
export async function saveSettings(settings: Settings): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(settings, RECORD_KEY);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('write failed'));
      };
    });
    db.close();
  } catch {
    // Intentionally ignored: see doc comment.
  }
}
