import { useSyncExternalStore } from 'react';
import { DEFAULT_MAP_ID, type MapId } from '@aerocade/shared';
import { DEFAULT_SETTINGS, saveSettings, type Settings } from './settings.js';
import type { NetHandle } from '../game/net/netplay.js';

/**
 * Minimal external store bridging the game session to React (no state
 * library needed at this size — see docs/ui.md). The game mutates via
 * `setState` on events / a 10 Hz timer; React subscribes per selector.
 */

export type Screen = 'menu' | 'settings' | 'host' | 'join' | 'sandbox' | 'net';

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

/**
 * Match clock, phase and limits as the HUD needs them. Derived from the sim's
 * `MatchState` each HUD tick rather than read live, so React re-renders at 10 Hz
 * instead of 60.
 */
export interface MatchHud {
  mode: number;
  modeLabel: string;
  phase: number;
  /** Seconds left in the live phase; null when the match is unlimited. */
  timeLeft: number | null;
  /** Seconds left in the countdown; 0 once live. */
  warmupLeft: number;
  fragLimit: number;
  /** Winning entrant, or -1 for undecided/drawn. */
  winner: number;
  /** Whether the local player (or their team) won. */
  youWon: boolean;
  teams: boolean;
}

/**
 * One row of the pre-game lobby — a person, always, even in a team mode where the
 * scoreboard groups by team. The lobby is about who is in the room.
 */
export interface LobbyPlayer {
  slot: number;
  name: string;
  isLocal: boolean;
  isHost: boolean;
  team: number;
}

/** One row of the scoreboard: a player in FFA, a team in TDM. */
export interface Standing {
  entrant: number;
  name: string;
  score: number;
  frags: number;
  deaths: number;
  /** The local player's own row, highlighted. */
  isLocal: boolean;
  team: number;
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
  /** Persisted player preferences (docs/ui.md §6). */
  settings: Settings;
  /**
   * Live LAN match, once its handshake has completed. Held here rather than in a
   * component because the game screen mounts *after* the handshake and must find
   * it already connected (see Lobby).
   */
  net: NetHandle | null;
  /** Match clock and phase, or null outside a ruled match (the sandbox). */
  match: MatchHud | null;
  /** Scoreboard rows, already sorted. Published only when something shows them. */
  standings: readonly Standing[];
  /** Everyone in the pre-game lobby, in join order. Empty once the match starts. */
  lobbyPlayers: readonly LobbyPlayer[];
  /** True when the local player is the host and may start the match. */
  canStartMatch: boolean;
  /** The player is holding the scoreboard key. Presentation only, never simulated. */
  scoreboardOpen: boolean;
  /**
   * Why the live match ended on its own, if it did. Rendered over the frozen
   * world rather than snapping to the menu: the player needs to know whether the
   * host quit or the network dropped, and a silent jump back looks like a crash.
   */
  netError: string | null;
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
  settings: { ...DEFAULT_SETTINGS },
  net: null,
  match: null,
  standings: [],
  lobbyPlayers: [],
  canStartMatch: false,
  scoreboardOpen: false,
  netError: null,
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
      match: null,
      standings: [],
      lobbyPlayers: [],
      canStartMatch: false,
      scoreboardOpen: false,
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
    appStore.patchSettings({ muted: !state.settings.muted });
  },
  /**
   * Apply a settings change live and persist it. Writing on every change is
   * fine here — these are user-driven and rare, unlike anything on the game
   * loop — and it means a crash never loses a preference the player just set.
   */
  patchSettings(patch: Partial<Settings>): void {
    const settings = { ...state.settings, ...patch };
    state = { ...state, settings };
    notify();
    void saveSettings(settings);
  },
  /** Replace wholesale, without a write — used when loading from storage. */
  hydrateSettings(settings: Settings): void {
    state = { ...state, settings };
    notify();
  },
  /** Hand over a connected match and switch to the game screen. */
  startNetMatch(net: NetHandle): void {
    state = { ...state, net, netError: null, screen: 'net' };
    notify();
    // Subscribed here rather than in a component: the notice must survive a
    // remount, and the store owns the handle's whole lifetime.
    net.onLost((reason) => {
      appStore.reportNetLoss(reason);
    });
  },
  /**
   * The match ended without the player asking. The handle is deliberately kept
   * open so the last known world stays on screen behind the notice; dismissing
   * it runs `endNetMatch`, which is what actually releases the socket.
   */
  reportNetLoss(netError: string): void {
    if (state.net === null || state.netError !== null) return;
    state = { ...state, netError };
    notify();
  },
  /** Tear the match down. Called when leaving, so no socket outlives a match. */
  endNetMatch(): void {
    state.net?.close();
    state = { ...state, net: null, netError: null, screen: 'menu' };
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
  /** Publish match clock/phase. Cheap no-op when nothing the HUD shows moved. */
  setMatch(match: MatchHud | null): void {
    const current = state.match;
    if (current === match) return;
    if (
      current !== null &&
      match !== null &&
      current.phase === match.phase &&
      current.timeLeft === match.timeLeft &&
      current.warmupLeft === match.warmupLeft &&
      current.winner === match.winner &&
      current.mode === match.mode
    ) {
      return;
    }
    state = { ...state, match };
    notify();
  },
  /** Publish scoreboard rows (already sorted by the session). */
  setStandings(standings: readonly Standing[]): void {
    state = { ...state, standings };
    notify();
  },
  /**
   * Publish the lobby roster. No-ops when nothing changed, because this runs on
   * the HUD's cadence and a new array every time would re-render the list ten
   * times a second while people are just standing around.
   */
  setLobby(lobbyPlayers: readonly LobbyPlayer[], canStartMatch: boolean): void {
    const same =
      state.canStartMatch === canStartMatch &&
      state.lobbyPlayers.length === lobbyPlayers.length &&
      state.lobbyPlayers.every((row, i) => {
        const next = lobbyPlayers[i];
        return (
          next?.slot === row.slot &&
          next.name === row.name &&
          next.team === row.team &&
          next.isHost === row.isHost
        );
      });
    if (same) return;
    state = { ...state, lobbyPlayers, canStartMatch };
    notify();
  },
  /** Show/hide the scoreboard. Held, not toggled — like every other shooter. */
  setScoreboardOpen(scoreboardOpen: boolean): void {
    if (state.scoreboardOpen === scoreboardOpen) return;
    state = { ...state, scoreboardOpen };
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
