import type { ReactElement } from 'react';
import { MatchPhase } from '@aerocade/shared';
import { appStore, useAppState } from '../store.js';
import { Scoreboard } from './Scoreboard.js';

/**
 * Print a zoom factor exactly: 1 → "1", 2.3 → "2.3", 1.65 → "1.65".
 * Rounding to one decimal would misreport the roster — toFixed(1) turns the
 * Rivet Pistol's 1.25 into "1.3" and the Thumper's 1.65 into "1.6" (the
 * nearest double to 1.65 is just below it, so it rounds down).
 */
function formatZoom(zoom: number): string {
  return String(Math.round(zoom * 100) / 100);
}

/** m:ss, so 65 s reads as 1:05 rather than 65. */
function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(whole / 60);
  return `${String(mins)}:${String(whole % 60).padStart(2, '0')}`;
}

export function Hud(): ReactElement {
  const hud = useAppState((s) => s.hud);
  const killFeed = useAppState((s) => s.killFeed);
  const pickup = useAppState((s) => s.pickup);
  const prompt = useAppState((s) => s.prompt);
  const scoped = useAppState((s) => s.scoped);
  const scopeZoom = useAppState((s) => s.scopeZoom);
  const weaponIcons = useAppState((s) => s.weaponIcons);
  const muted = useAppState((s) => s.settings.muted);
  const match = useAppState((s) => s.match);
  const icon = weaponIcons[hud.weaponId];
  const otherIcon = weaponIcons[hud.otherWeaponId];

  const healthFrac = hud.maxHealth > 0 ? hud.health / hud.maxHealth : 0;
  const fuelFrac = hud.maxFuel > 0 ? hud.fuel / hud.maxFuel : 0;

  return (
    <div className="hud">
      {match !== null && (
        <div className="match-bar">
          <span className="match-clock">
            {match.timeLeft === null ? '∞' : formatClock(match.timeLeft)}
          </span>
          {match.fragLimit > 0 && (
            <span className="match-limit">
              {hud.kills}/{match.fragLimit}
            </span>
          )}
        </div>
      )}

      {match !== null && match.phase === MatchPhase.Warmup && (
        <div className="match-warmup" role="status">
          <div className="match-warmup-count">{Math.max(1, match.warmupLeft)}</div>
          <div className="match-warmup-label">weapons locked</div>
        </div>
      )}

      <Scoreboard />

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

      <button
        type="button"
        className="weapon-panel"
        aria-label={`${hud.weaponName}, ${String(hud.ammoMag)} of ${String(
          hud.ammoReserve,
        )} rounds. Switch to ${hud.otherWeaponName}`}
        onPointerDown={(e) => {
          e.preventDefault(); // keep keyboard focus on the game
          appStore.requestWeaponSwitch();
        }}
      >
        {icon !== undefined && icon !== '' && (
          <img className="weapon-panel-icon" src={icon} alt="" draggable={false} />
        )}
        <div className="weapon-panel-text">
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
        </div>
        <div className="weapon-panel-grenades" aria-hidden="true">
          <span className="pip" />
          <span>×{hud.grenades}</span>
        </div>
        <div className="weapon-panel-swap" aria-hidden="true">
          <span className="swap-glyph">⇄</span>
          {otherIcon !== undefined && otherIcon !== '' && (
            <img className="weapon-panel-other" src={otherIcon} alt="" draggable={false} />
          )}
        </div>
      </button>

      <div className="hud-corner hud-top-left">
        <div className="scorebox">
          K {hud.kills} · D {hud.deaths}
        </div>
        <div className="scorebox">{hud.fps} FPS</div>
        <button
          type="button"
          className={`scorebox mute-toggle${muted ? ' muted' : ''}`}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute sound' : 'Mute sound'}
          onPointerDown={(e) => {
            e.preventDefault(); // keep keyboard focus on the game
            appStore.toggleMute();
          }}
        >
          {muted ? 'SOUND OFF' : 'SOUND ON'}
        </button>
      </div>

      <button
        type="button"
        className={`scope-button${scoped ? ' active' : ''}`}
        aria-pressed={scoped}
        aria-label={scoped ? 'Disable scope' : 'Enable scope'}
        onPointerDown={(e) => {
          e.preventDefault(); // keep keyboard focus on the game
          appStore.requestScopeToggle();
        }}
      >
        <span className="scope-reticle" aria-hidden="true" />
        <span className="scope-factor">{formatZoom(scoped ? scopeZoom : 1)}×</span>
      </button>

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

      {prompt !== null && (
        <button
          type="button"
          className="pickup-button"
          aria-label={`Pick up ${prompt.weaponName}`}
          onPointerDown={(e) => {
            e.preventDefault(); // keep focus off the button so keys keep working
            appStore.requestInteract();
          }}
        >
          <span className="pickup-button-glyph" aria-hidden="true" />
          <span className="pickup-button-label">{prompt.weaponName}</span>
          <span className="pickup-button-key">E</span>
        </button>
      )}

      {pickup !== null && (
        <div className="pickup-note" key={pickup.id}>
          {pickup.text}
        </div>
      )}

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
