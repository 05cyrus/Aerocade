import type { ReactElement } from 'react';
import { appStore } from '../store.js';

export function MainMenu(): ReactElement {
  return (
    <div className="menu">
      <h1>AEROCADE</h1>
      <div className="tagline">JETPACKS · ROCKETS · ZERO INTERNET</div>
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
      <div className="hint">
        <kbd>A</kbd>/<kbd>D</kbd> move · <kbd>Space</kbd> jump &amp; jetpack · <kbd>S</kbd> +{' '}
        <kbd>Space</kbd> hover · mouse aim · <kbd>LMB</kbd> fire · <kbd>RMB</kbd> melee ·{' '}
        <kbd>G</kbd> grenade · <kbd>R</kbd> reload · <kbd>Q</kbd> swap weapon · <kbd>Shift</kbd>{' '}
        walk
      </div>
    </div>
  );
}
