import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { MapId } from '@aerocade/shared';
import { GameSession } from '../game/GameSession.js';
import { prefersTouchControls } from '../game/input/TouchInput.js';
import { Hud } from './screens/Hud.js';
import { MainMenu } from './screens/MainMenu.js';
import { Settings } from './screens/Settings.js';
import { Lobby } from './screens/Lobby.js';
import { TouchControls } from './screens/TouchControls.js';
import { appStore, useAppState } from './store.js';
import { loadSettings } from './settings.js';

/**
 * The in-game screen, offline or networked. `net` is already connected when it is
 * non-null — the lobby completes the handshake before switching here, because a
 * joining client's player slot does not exist until the host's WELCOME lands.
 */
function GameScreen({ mapId }: { mapId: MapId }): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null);
  const net = useAppState((s) => s.net);
  const netError = useAppState((s) => s.netError);
  // Decided once per session: a coarse pointer without hover means a phone or
  // tablet, where thumb sticks are the only way to play. Touch-capable laptops
  // report touch points but do hover, so they keep mouse aim uncluttered.
  const [touch] = useState(prefersTouchControls);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return undefined;
    const session = new GameSession(mount, mapId, net);
    return () => {
      session.destroy();
    };
    // `net` is intentionally a dependency: swapping match kind must rebuild the
    // session, since the world and local player differ.
  }, [mapId, net]);

  return (
    <>
      <div className="game-mount" ref={mountRef} />
      <Hud />
      {touch && <TouchControls />}
      {netError !== null && (
        <div className="net-lost" role="alert">
          <h2>MATCH ENDED</h2>
          <p>{netError}</p>
          <button
            type="button"
            onClick={() => {
              appStore.endNetMatch();
            }}
          >
            Back to menu
          </button>
        </div>
      )}
      <button
        type="button"
        className="back-button"
        onClick={() => {
          // endNetMatch closes the bridge socket too; leaving a LAN game must
          // not leave a room registered with a player who has gone.
          if (net !== null) appStore.endNetMatch();
          else appStore.setScreen('menu');
        }}
      >
        {net === null ? '← Leave sandbox' : '← Leave match'}
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
      {screen === 'host' && <Lobby mode="host" />}
      {screen === 'join' && <Lobby mode="join" />}
      {screen === 'sandbox' && <GameScreen mapId={mapId} />}
      {screen === 'net' && <GameScreen mapId={mapId} />}
    </div>
  );
}
