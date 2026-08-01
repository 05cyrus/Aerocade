import type { ReactElement } from 'react';
import { useAppState } from '../store.js';

export function Hud(): ReactElement {
  const hud = useAppState((s) => s.hud);
  const killFeed = useAppState((s) => s.killFeed);

  const healthFrac = hud.maxHealth > 0 ? hud.health / hud.maxHealth : 0;
  const fuelFrac = hud.maxFuel > 0 ? hud.fuel / hud.maxFuel : 0;

  return (
    <div className="hud">
      <div className="hud-corner hud-bottom-left">
        <div>
          <div className="bar-label">HULL</div>
          <div className={`bar bar-health${healthFrac < 0.3 ? ' low' : ''}`}>
            <div style={{ width: `${String(Math.round(healthFrac * 100))}%` }} />
          </div>
        </div>
        <div>
          <div className="bar-label">FUEL</div>
          <div className="bar bar-fuel">
            <div style={{ width: `${String(Math.round(fuelFrac * 100))}%` }} />
          </div>
        </div>
      </div>

      <div className="hud-corner hud-bottom-right">
        <div className="weapon-name">{hud.weaponName.toUpperCase()}</div>
        <div className="ammo">
          {hud.reloading ? (
            <span className="reloading">RELOADING…</span>
          ) : (
            <>
              {hud.ammoMag}
              <span className="reserve"> / {hud.ammoReserve}</span>
            </>
          )}
        </div>
        <div className="grenades">GRENADES ×{hud.grenades}</div>
      </div>

      <div className="hud-corner hud-top-left">
        <div className="scorebox">
          K {hud.kills} · D {hud.deaths}
        </div>
        <div className="scorebox">{hud.fps} FPS</div>
      </div>

      <div className="hud-corner hud-top-right">
        <div className="killfeed">
          {killFeed.map((e) => (
            <div className="entry" key={e.id}>
              <span className="killer">{e.killer}</span> ⚡{' '}
              <span className="victim">{e.victim}</span>
            </div>
          ))}
        </div>
      </div>

      {hud.protectFor > 0 && hud.respawnIn === 0 && (
        <div className="protect-note">SPAWN SHIELD — fire to drop it</div>
      )}

      {hud.respawnIn > 0 && (
        <div className="respawn-overlay">
          <div className="title">DOWN</div>
          <div className="count">Respawning in {hud.respawnIn}…</div>
        </div>
      )}
    </div>
  );
}
