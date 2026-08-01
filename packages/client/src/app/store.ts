import { useSyncExternalStore } from 'react';

/**
 * Minimal external store bridging the game session to React (no state
 * library needed at this size — see docs/ui.md). The game mutates via
 * `setState` on events / a 10 Hz timer; React subscribes per selector.
 */

export type Screen = 'menu' | 'sandbox';

export interface HudState {
  health: number;
  maxHealth: number;
  fuel: number;
  maxFuel: number;
  ammoMag: number;
  ammoReserve: number;
  weaponName: string;
  grenades: number;
  reloading: boolean;
  kills: number;
  deaths: number;
  /** Seconds until respawn; 0 while alive. */
  respawnIn: number;
  /** Seconds of spawn protection left. */
  protectFor: number;
  fps: number;
}

export interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
}

export interface AppState {
  screen: Screen;
  hud: HudState;
  killFeed: readonly KillFeedEntry[];
}

const initialHud: HudState = {
  health: 0,
  maxHealth: 100,
  fuel: 0,
  maxFuel: 100,
  ammoMag: 0,
  ammoReserve: 0,
  weaponName: '',
  grenades: 0,
  reloading: false,
  kills: 0,
  deaths: 0,
  respawnIn: 0,
  protectFor: 0,
  fps: 0,
};

let state: AppState = {
  screen: 'menu',
  hud: initialHud,
  killFeed: [],
};

const listeners = new Set<() => void>();
let feedId = 0;

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const appStore = {
  getState(): AppState {
    return state;
  },
  setScreen(screen: Screen): void {
    state = { ...state, screen };
    notify();
  },
  setHud(hud: HudState): void {
    state = { ...state, hud };
    notify();
  },
  pushKill(killer: string, victim: string): void {
    feedId += 1;
    const entry: KillFeedEntry = { id: feedId, killer, victim };
    const killFeed = [...state.killFeed.slice(-4), entry];
    state = { ...state, killFeed };
    notify();
    // Entries age out on a timer; the HUD renders whatever is present.
    setTimeout(() => {
      state = { ...state, killFeed: state.killFeed.filter((e) => e.id !== entry.id) };
      notify();
    }, 4500);
  },
  subscribe,
};

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
