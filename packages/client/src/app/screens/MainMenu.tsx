import type { ReactElement } from 'react';
import { MAP_IDS, MAP_SUMMARIES } from '@aerocade/shared';
import { appStore, useAppState } from '../store.js';
import {
  ACTION_LABELS,
  describeCode,
  InputAction,
  type Bindings,
} from '../../game/input/bindings.js';

/** Actions worth advertising on the menu, in the order they matter. */
const HINT_ACTIONS: readonly InputAction[] = [
  InputAction.MoveLeft,
  InputAction.MoveRight,
  InputAction.Jump,
  InputAction.Fire,
  InputAction.Melee,
  InputAction.Grenade,
  InputAction.Reload,
  InputAction.SwitchWeapon,
  InputAction.Interact,
  InputAction.Scope,
  InputAction.Walk,
];

/**
 * Render the hint from the live bindings. It used to be hard-coded, which meant
 * the menu confidently advertised A/D after the player had rebound them.
 */
function hintFor(bindings: Bindings): { action: InputAction; keys: string }[] {
  return HINT_ACTIONS.map((action) => ({
    action,
    keys: bindings[action].map(describeCode).join(' / ') || 'unbound',
  }));
}

export function MainMenu(): ReactElement {
  const mapId = useAppState((s) => s.mapId);
  const bindings = useAppState((s) => s.settings.bindings);
  return (
    <div className="menu">
      <h1>AEROCADE</h1>
      <div className="tagline">JETPACKS · ROCKETS · ZERO INTERNET</div>
      <div className="map-picker">
        {MAP_IDS.map((id) => (
          <button
            type="button"
            key={id}
            className={`map-option${id === mapId ? ' selected' : ''}`}
            aria-pressed={id === mapId}
            onClick={() => {
              appStore.setMap(id);
            }}
          >
            <span className="map-option-name">{MAP_SUMMARIES[id].name}</span>
            <span className="map-option-blurb">{MAP_SUMMARIES[id].blurb}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          appStore.setScreen('sandbox');
        }}
      >
        Training Sandbox
      </button>
      <button type="button" disabled title="Arrives with milestone M2 (LAN multiplayer)">
        Host LAN Match — M2
      </button>
      <button type="button" disabled title="Arrives with milestone M2 (LAN multiplayer)">
        Join LAN Match — M2
      </button>
      <button
        type="button"
        onClick={() => {
          appStore.setScreen('settings');
        }}
      >
        Settings
      </button>
      <div className="hint">
        {hintFor(bindings).map(({ action, keys }, i) => (
          <span key={action}>
            {i > 0 && ' · '}
            <kbd>{keys}</kbd> {ACTION_LABELS[action].toLowerCase()}
          </span>
        ))}
        {' · '}mouse or right stick aims
      </div>
    </div>
  );
}
