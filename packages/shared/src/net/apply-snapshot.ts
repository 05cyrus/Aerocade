import { MAX_PICKUPS, MAX_PLAYERS, MAX_PROJECTILES, WEAPON_SLOTS } from '../constants.js';
import { PlayerFlag, type WireSnapshot } from '../protocol/codec.js';
import { depenetrate } from '../sim/systems/physics.js';
import type { SimWorld } from '../sim/world.js';

/**
 * Write a decoded snapshot into a `SimWorld`.
 *
 * A joining client keeps a full `SimWorld` and overwrites it from snapshots
 * rather than holding some parallel "remote state" structure. That choice is
 * deliberate: the renderer, the interpolator, the HUD and the audio layer all
 * already read a `SimWorld`, so a client needs **no** rendering changes to show
 * a remote match — and when prediction arrives, the same world is what gets
 * re-simulated forward, so there is no second representation to keep in sync.
 *
 * Only the fields the wire carries are touched. Everything else (cooldowns,
 * bloom, ladder regrip) is host-authoritative and simply not needed to draw a
 * frame; leaving it alone is what keeps this a projection rather than a partial,
 * subtly-wrong simulation.
 */
export function applySnapshotToWorld(world: SimWorld, snapshot: WireSnapshot): void {
  world.tick = snapshot.tick;

  const p = world.players;
  const present = new Set<number>();
  for (const record of snapshot.players) {
    const i = record.id;
    if (i < 0 || i >= MAX_PLAYERS) continue;
    present.add(i);

    p.connected[i] = 1;
    p.status[i] = (record.flags & PlayerFlag.Alive) !== 0 ? 1 : 0;
    p.posX[i] = record.x;
    // Lift out of any tile the wire's rounding pushed us into. Without this a
    // predicting client is ejected sideways on the tick after every snapshot
    // (see `depenetrate`), which is the single worst artefact prediction can add.
    p.posY[i] = depenetrate(world.map, record.x, record.y);
    p.velX[i] = record.vx;
    p.velY[i] = record.vy;
    p.aim[i] = record.aim;
    p.health[i] = record.health;
    p.fuel[i] = record.fuel;
    p.grounded[i] = (record.flags & PlayerFlag.OnGround) !== 0 ? 1 : 0;
    // Spawn protection drives an alpha pulse, so any non-zero value will do —
    // the exact remaining seconds are not on the wire and are not needed.
    p.protect[i] = (record.flags & PlayerFlag.SpawnProtected) !== 0 ? 1 : 0;
    p.reload[i] = (record.flags & PlayerFlag.Reloading) !== 0 ? 1 : 0;

    p.kills[i] = record.kills;
    p.deaths[i] = record.deaths;
    p.team[i] = record.team;

    const slot = p.weaponSlot[i] ?? 0;
    p.weapons[i * WEAPON_SLOTS + slot] = record.weapon;
    p.ammoMag[i * WEAPON_SLOTS + slot] = record.ammo;
  }

  // Slots absent from a *keyframe* have left the match. A delta must never be
  // applied here — `applyDelta` rebuilds a keyframe first — or every player the
  // delta happened not to mention would be disconnected.
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!present.has(i)) {
      p.connected[i] = 0;
      p.status[i] = 0;
    }
  }

  const pr = world.projectiles;
  pr.alive.fill(0);
  for (const record of snapshot.projectiles) {
    const i = record.id;
    if (i < 0 || i >= MAX_PROJECTILES) continue;
    pr.alive[i] = 1;
    pr.kind[i] = record.kind;
    pr.posX[i] = record.x;
    pr.posY[i] = record.y;
    pr.velX[i] = record.vx;
    pr.velY[i] = record.vy;
  }

  // The match block is sent whole in every snapshot, so a client knows the phase,
  // both clocks and the score from the first frame it decodes — a late joiner sees
  // "3:41 left, 14-9" immediately rather than after the next phase change.
  const m = world.match;
  m.mode = snapshot.match.mode;
  m.phase = snapshot.match.phase;
  m.winner = snapshot.match.winner;
  m.phaseStartTick = snapshot.match.phaseStartTick;
  m.timeLimitTicks = snapshot.match.timeLimitTicks;
  m.fragLimit = snapshot.match.fragLimit;
  for (let t = 0; t < m.teamFrags.length; t++) m.teamFrags[t] = snapshot.match.teamFrags[t] ?? 0;

  const pk = world.pickups;
  pk.alive.fill(0);
  for (const record of snapshot.pickups) {
    const i = record.index;
    if (i < 0 || i >= MAX_PICKUPS || !record.alive) continue;
    pk.alive[i] = 1;
    pk.kind[i] = record.kind;
    pk.weapon[i] = record.weapon;
    pk.posX[i] = record.x;
    pk.posY[i] = record.y;
  }
}
