import { useEffect, useRef, type ReactElement } from 'react';
import { GameSession } from '../game/GameSession.js';
import { Hud } from './screens/Hud.js';
import { MainMenu } from './screens/MainMenu.js';
import { appStore, useAppState } from './store.js';

function SandboxScreen(): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return undefined;
    const session = new GameSession(mount);
    return () => {
      session.destroy();
    };
  }, []);

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
  return <div className="app">{screen === 'menu' ? <MainMenu /> : <SandboxScreen />}</div>;
}
