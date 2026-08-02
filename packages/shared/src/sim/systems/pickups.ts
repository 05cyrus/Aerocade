import { MAX_PICKUPS, MAX_PLAYERS, SIM_DT, WEAPON_SLOTS } from '../../constants.js';
import { SimEventType } from '../events.js';
import { WEAPON_COUNT, weaponDef, type WeaponId } from '../combat/weapon-defs.js';
import type { SpawnPoint } from '../map/mapdef.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * Weapon pads: fixed spots on the map that hold one gun each, hand it to the
 * first player who touches it, then refill on a timer with a **randomly
 * rolled** weapon. Pad positions are static map data (`map.weaponPads`);
 * only contents are simulated, so pad index _i_ ↔ pickup slot _i_.
 *
 * The roll uses the world RNG, which lives in the snapshot — so a
 * reconciliation replay or lag-comp rewind reproduces the exact same weapon
 * on the exact same pad (ADR-009).
 */
export function pickupsSystem(world: SimWorld): void {
  const pads = world.map.weaponPads;
  const count = Math.min(pads.length, MAX_PICKUPS);
  const pk = world.pickups;

  for (let i = 0; i < count; i++) {
    const pad = pads[i];
    if (pad === undefined) continue;

    if (pk.active[i] !== 1) {
      const left = (pk.respawnIn[i] ?? 0) - SIM_DT;
      pk.respawnIn[i] = Math.max(0, left);
      if (left <= 0) refillPad(world, i, pad, true);
      continue;
    }

    const taker = findCollector(world, pad);
    if (taker === -1) continue;

    const weapon = (pk.weapon[i] ?? 0) as WeaponId;
    const toppedUp = grantWeapon(world, taker, weapon);
    pk.active[i] = 0;
    pk.respawnIn[i] = TUNING.pickups.weaponRespawnDelay;
    world.events.emit(SimEventType.PickupTaken, taker, weapon, pad.x, pad.y, toppedUp ? 1 : 0);
  }
}

/**
 * Put a freshly rolled weapon on a pad. Called on match start and whenever a
 * pad's respawn timer elapses.
 */
export function refillPad(
  world: SimWorld,
  padIndex: number,
  pad: SpawnPoint,
  emitEvent: boolean,
): void {
  const pk = world.pickups;
  const previous = pk.weapon[padIndex] ?? 0;

  // A pad never offers the same weapon twice in a row, so a looted pad is
  // always worth coming back to. On a collision we shift by a second draw
  // rather than re-rolling in a loop: a fixed number of draws per refill
  // keeps the RNG stream length predictable, which keeps replays cheap.
  let rolled = world.rng.int(WEAPON_COUNT);
  if (rolled === previous) {
    rolled = (rolled + 1 + world.rng.int(WEAPON_COUNT - 1)) % WEAPON_COUNT;
  }

  pk.active[padIndex] = 1;
  pk.weapon[padIndex] = rolled;
  pk.respawnIn[padIndex] = 0;
  if (emitEvent) {
    world.events.emit(SimEventType.PickupSpawn, padIndex, rolled, pad.x, pad.y);
  }
}

/** Stock every pad at match start so the arena is never empty. */
export function initPickups(world: SimWorld): void {
  const pads = world.map.weaponPads;
  const count = Math.min(pads.length, MAX_PICKUPS);
  for (let i = 0; i < count; i++) {
    const pad = pads[i];
    if (pad !== undefined) refillPad(world, i, pad, false);
  }
}

/**
 * Lowest-indexed living player whose body overlaps the pad, or -1.
 * Ties resolve by index so replays agree (ADR-009 iteration rule).
 */
function findCollector(world: SimWorld, pad: SpawnPoint): number {
  const p = world.players;
  const reachX = TUNING.player.width / 2 + TUNING.pickups.halfSize;
  const reachY = TUNING.player.height / 2 + TUNING.pickups.halfSize;

  for (let t = 0; t < MAX_PLAYERS; t++) {
    if (p.connected[t] !== 1 || p.status[t] !== 1) continue;
    if (Math.abs((p.posX[t] ?? 0) - pad.x) > reachX) continue;
    if (Math.abs((p.posY[t] ?? 0) - pad.y) > reachY) continue;
    return t;
  }
  return -1;
}

/**
 * Hand a weapon to a player. Carrying it already means the pad tops up that
 * slot's reserve ammo instead of swapping (so a duplicate is never a
 * downgrade); otherwise it replaces the **active** slot, fully loaded.
 * Replacing the held slot is the deliberate trade-off — switch to your
 * throwaway slot before stepping on a pad you don't want to keep.
 *
 * Returns true when it was an ammo top-up rather than a swap.
 */
function grantWeapon(world: SimWorld, player: number, id: WeaponId): boolean {
  const p = world.players;
  const def = weaponDef(id);

  for (let s = 0; s < WEAPON_SLOTS; s++) {
    const idx = player * WEAPON_SLOTS + s;
    if (p.weapons[idx] === id) {
      p.ammoReserve[idx] = def.reserveMax;
      return true;
    }
  }

  const idx = player * WEAPON_SLOTS + (p.weaponSlot[player] ?? 0);
  p.weapons[idx] = id;
  p.ammoMag[idx] = def.magSize;
  p.ammoReserve[idx] = def.reserveMax;
  // A swap interrupts whatever the old weapon was doing.
  p.reload[player] = 0;
  p.bloom[player] = 0;
  p.cooldown[player] = Math.max(p.cooldown[player] ?? 0, TUNING.combat.switchDelay);
  return false;
}
