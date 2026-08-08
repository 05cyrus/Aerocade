import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { MapId } from '@aerocade/shared';
import { GameSession } from '../game/GameSession.js';
import { prefersTouchControls } from '../game/input/TouchInput.js';
import { Hud } from './screens/Hud.js';
import { MainMenu } from './screens/MainMenu.js';
import { Settings } from './screens/Settings.js';
import { TouchControls } from './screens/TouchControls.js';
import { appStore, useAppState } from './store.js';
import { loadSettings } from './settings.js';

function SandboxScreen({ mapId }: { mapId: MapId }): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null);
  // Decided once per session: a coarse pointer without hover means a phone or
  // tablet, where thumb sticks are the only way to play. Touch-capable laptops
  // report touch points but do hover, so they keep mouse aim uncluttered.
  const [touch] = useState(prefersTouchControls);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return undefined;
    const session = new GameSession(mount, mapId);
    return () => {
      session.destroy();
    };
  }, [mapId]);

  return (
    <>
      <div className="game-mount" ref={mountRef} />
      <Hud />
      {touch && <TouchControls />}
      <button
        type="button"
        className="back-button"
        onClick={() => {
          appStore.setScreen('menu');
        }}
      >
        ← Leave sandbox
      </button>
    </>
  );
}

export function App(): ReactElement {
  const screen = useAppState((s) => s.screen);
  const mapId = useAppState((s) => s.mapId);

  // Load persisted settings once, without blocking first paint: defaults render
  // immediately and the saved record replaces them when it arrives. A corrupt or
  // unavailable store resolves to defaults rather than rejecting (docs/ui.md §6).
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((settings) => {
      if (!cancelled) appStore.hydrateSettings(settings);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      {screen === 'menu' && <MainMenu />}
      {screen === 'settings' && <Settings />}
      {screen === 'sandbox' && <SandboxScreen mapId={mapId} />}
    </div>
  );
}
