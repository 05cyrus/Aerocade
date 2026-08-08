import { useSyncExternalStore } from 'react';
import { DEFAULT_MAP_ID, type MapId } from '@aerocade/shared';

/**
 * Minimal external store bridging the game session to React (no state
 * library needed at this size — see docs/ui.md). The game mutates via
 * `setState` on events / a 10 Hz timer; React subscribes per selector.
 */

export type Screen = 'menu' | 'sandbox';

/**
 * Map the next sandbox session will load. Aliased to the shared `MapId` rather
 * than restating the union, so adding a map to the registry cannot leave this
 * behind — the menu is generated from `MAP_IDS`, and a stale union here would
 * silently make a real map unselectable.
 */
export type SelectedMap = MapId;

export interface HudState {
  health: number;
  maxHealth: number;
  fuel: number;
  maxFuel: number;
  ammoMag: number;
  ammoReserve: number;
  weaponName: string;
  weaponId: number;
  /** The weapon in the other slot — what tapping the panel switches to. */
  otherWeaponId: number;
  otherWeaponName: string;
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

/** The weapon pad the local player is standing on, if any. */
export interface PickupPrompt {
  weaponId: number;
  weaponName: string;
}

/** Transient "you picked something up" banner. */
export interface PickupNotice {
  id: number;
  text: string;
}

export interface AppState {
  screen: Screen;
  mapId: SelectedMap;
  hud: HudState;
  killFeed: readonly KillFeedEntry[];
  pickup: PickupNotice | null;
  /** Non-null while the pickup button should be on screen. */
  prompt: PickupPrompt | null;
  /** Scoped view active, and the zoom factor the held weapon provides. */
  scoped: boolean;
  scopeZoom: number;
  /** Data-URL icon per WeaponId, cropped from the render atlas at boot. */
  weaponIcons: readonly string[];
  /** Sound off. Not persisted yet — settings storage is a later milestone. */
  muted: boolean;
}

const initialHud: HudState = {
  health: 0,
  maxHealth: 100,
  fuel: 0,
  maxFuel: 100,
  ammoMag: 0,
  ammoReserve: 0,
  weaponName: '',
  weaponId: 0,
  otherWeaponId: 0,
  otherWeaponName: '',
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
  mapId: DEFAULT_MAP_ID,
  hud: initialHud,
  killFeed: [],
  pickup: null,
  prompt: null,
  scoped: false,
  scopeZoom: 1,
  weaponIcons: [],
  muted: false,
};

const listeners = new Set<() => void>();
let feedId = 0;
let pickupId = 0;
let pickupTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * One-shot latch: the pickup button sets it, the game loop consumes it on the
 * next tick and feeds Buttons.Interact through the normal input path. Kept out
 * of React state deliberately — it is input, not something to render.
 */
let interactRequested = false;
/** Same one-shot pattern for the scope button. */
let scopeToggleRequested = false;
/** ...and for tapping the weapon panel to switch weapons. */
let weaponSwitchRequested = false;

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
  /** Fresh-session state; called when a game session starts so nothing leaks between matches. */
  reset(): void {
    if (pickupTimer !== null) clearTimeout(pickupTimer);
    pickupTimer = null;
    state = {
      ...state,
      hud: { ...initialHud },
      killFeed: [],
      pickup: null,
      prompt: null,
      scoped: false,
      scopeZoom: 1,
    };
    interactRequested = false;
    scopeToggleRequested = false;
    weaponSwitchRequested = false;
    notify();
  },
  /** Show or hide the pickup button; no-ops when nothing changed. */
  setPrompt(prompt: PickupPrompt | null): void {
    const current = state.prompt;
    if (current === prompt) return;
    // Compare the label too: grenade bundles all share weaponId -1 but differ
    // by count, and the button must show the right number.
    if (
      current !== null &&
      prompt !== null &&
      current.weaponId === prompt.weaponId &&
      current.weaponName === prompt.weaponName
    ) {
      return;
    }
    state = { ...state, prompt };
    notify();
  },
  /** Called by the pickup button (tap or click). */
  requestInteract(): void {
    interactRequested = true;
  },
  /** Called by tapping the weapon panel. */
  requestWeaponSwitch(): void {
    weaponSwitchRequested = true;
  },
  consumeWeaponSwitch(): boolean {
    const requested = weaponSwitchRequested;
    weaponSwitchRequested = false;
    return requested;
  },
  /** Called by the scope button (tap or click). */
  requestScopeToggle(): void {
    scopeToggleRequested = true;
  },
  consumeScopeToggle(): boolean {
    const requested = scopeToggleRequested;
    scopeToggleRequested = false;
    return requested;
  },
  /** Publish the generated weapon icons once, after the atlas exists. */
  setWeaponIcons(weaponIcons: readonly string[]): void {
    state = { ...state, weaponIcons };
    notify();
  },
  /** Publish scope state for the HUD; no-ops when nothing changed. */
  setScope(scoped: boolean, scopeZoom: number): void {
    if (state.scoped === scoped && state.scopeZoom === scopeZoom) return;
    state = { ...state, scoped, scopeZoom };
    notify();
  },
  /** Called once per sim tick by the game loop. */
  consumeInteract(): boolean {
    const requested = interactRequested;
    interactRequested = false;
    return requested;
  },
  /** Flash a pickup banner; a newer pickup replaces an older one. */
  showPickup(text: string): void {
    pickupId += 1;
    const id = pickupId;
    state = { ...state, pickup: { id, text } };
    notify();
    if (pickupTimer !== null) clearTimeout(pickupTimer);
    pickupTimer = setTimeout(() => {
      pickupTimer = null;
      if (state.pickup?.id !== id) return;
      state = { ...state, pickup: null };
      notify();
    }, 1600);
  },
  setScreen(screen: Screen): void {
    state = { ...state, screen };
    notify();
  },
  /** Flip the sound on/off. The scene watches this and moves its master gain. */
  toggleMute(): void {
    state = { ...state, muted: !state.muted };
    notify();
  },
  setMap(mapId: SelectedMap): void {
    if (state.mapId === mapId) return;
    state = { ...state, mapId };
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
