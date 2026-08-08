import type { ReactElement } from 'react';
import { MAP_IDS, MAP_SUMMARIES } from '@aerocade/shared';
import { appStore, useAppState } from '../store.js';

export function MainMenu(): ReactElement {
  const mapId = useAppState((s) => s.mapId);
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
        <kbd>A</kbd>/<kbd>D</kbd> move · <kbd>Space</kbd> jump &amp; jetpack · <kbd>S</kbd> +{' '}
        <kbd>Space</kbd> hover · mouse aim · <kbd>LMB</kbd> fire · <kbd>RMB</kbd> melee ·{' '}
        <kbd>G</kbd> grenade · <kbd>R</kbd> reload · <kbd>Q</kbd> swap weapon · <kbd>E</kbd> take
        weapon from pad · <kbd>Z</kbd> scope · <kbd>Shift</kbd> walk
      </div>
    </div>
  );
}
