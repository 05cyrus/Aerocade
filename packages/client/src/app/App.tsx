import { useEffect, useRef, type ReactElement } from 'react';
import type { MapId } from '@aerocade/shared';
import { GameSession } from '../game/GameSession.js';
import { Hud } from './screens/Hud.js';
import { MainMenu } from './screens/MainMenu.js';
import { appStore, useAppState } from './store.js';

function SandboxScreen({ mapId }: { mapId: MapId }): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null);

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
  return (
    <div className="app">{screen === 'menu' ? <MainMenu /> : <SandboxScreen mapId={mapId} />}</div>
  );
}
