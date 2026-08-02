import {
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_WEAPON_PADS,
  SIM_DT,
  WEAPON_SLOTS,
} from '../../constants.js';
import { SimEventType } from '../events.js';
import { Buttons } from '../input.js';
import { WEAPON_COUNT, weaponDef, type WeaponId } from '../combat/weapon-defs.js';
import { isSolid } from '../map/mapdef.js';
import type { SpawnPoint } from '../map/mapdef.js';
import { TUNING } from '../tuning.js';
import { PickupKind, type SimWorld } from '../world.js';

/**
 * Ground items and the pads that spawn them.
 *
 * Three ways a gun ends up on the floor (ADR-015):
 *  1. a **weapon pad** refills on its timer with a randomly rolled gun,
 *  2. a player **swaps** — the weapon they were holding drops at their feet,
 *  3. a player **dies** — both guns and their grenades drop where they fell.
 *
 * Dropped items carry their owner's exact remaining ammo, fall under gravity,
 * and expire after `dropTtl`. Pad-spawned guns never expire.
 *
 * Collection is opt-in (ADR-014): overlapping does nothing until the player
 * presses `Buttons.Interact`, edge-detected so holding it cannot hoover up
 * items as they appear.
 */
export function pickupsSystem(world: SimWorld): void {
  advancePads(world);
  advanceDrops(world);
  resolveCollections(world);
}

// ---------- pads ----------

function advancePads(world: SimWorld): void {
  const pads = world.map.weaponPads;
  const count = Math.min(pads.length, MAX_WEAPON_PADS);
  const padPool = world.pads;

  for (let i = 0; i < count; i++) {
    const pad = pads[i];
    if (pad === undefined) continue;

    // Forget a pickup that was collected or despawned elsewhere.
    const owned = padPool.pickup[i] ?? -1;
    if (owned >= 0 && world.pickups.alive[owned] !== 1) {
      padPool.pickup[i] = -1;
      if ((padPool.timer[i] ?? 0) <= 0) padPool.timer[i] = TUNING.pickups.weaponRespawnDelay;
    }
    if ((padPool.pickup[i] ?? -1) >= 0) continue;

    const left = (padPool.timer[i] ?? 0) - SIM_DT;
    padPool.timer[i] = Math.max(0, left);
    if (left <= 0) refillPad(world, i, pad, true);
  }
}

/**
 * Put a freshly rolled weapon on a pad, fully loaded. A pad never offers the
 * same gun twice running, so a looted pad is always worth returning to; on a
 * repeat we shift by a second draw rather than looping, keeping the number of
 * RNG draws per refill fixed and replays cheap.
 */
export function refillPad(
  world: SimWorld,
  padIndex: number,
  pad: SpawnPoint,
  emitEvent: boolean,
): void {
  const previous = lastWeaponOnPad(world, padIndex);
  let rolled = world.rng.int(WEAPON_COUNT);
  if (rolled === previous) {
    rolled = (rolled + 1 + world.rng.int(WEAPON_COUNT - 1)) % WEAPON_COUNT;
  }

  const def = weaponDef(rolled as WeaponId);
  const slot = spawnPickup(world, {
    kind: PickupKind.Weapon,
    weapon: rolled,
    mag: def.magSize,
    reserve: def.reserveMax,
    x: pad.x,
    y: pad.y,
    velX: 0,
    velY: 0,
    padIndex,
    ttl: 0,
    arm: 0,
  });
  if (slot === -1) return;

  world.pads.pickup[padIndex] = slot;
  world.pads.timer[padIndex] = 0;
  world.pickups.grounded[slot] = 1; // pad guns hover in place, no drop arc
  if (emitEvent) {
    world.events.emit(SimEventType.PickupSpawn, padIndex, rolled, pad.x, pad.y);
  }
}

/** Weapon most recently offered by a pad, for the no-repeat rule. */
function lastWeaponOnPad(world: SimWorld, padIndex: number): number {
  const owned = world.pads.pickup[padIndex] ?? -1;
  return owned >= 0 ? (world.pickups.weapon[owned] ?? -1) : (world.pads.lastWeapon[padIndex] ?? -1);
}

/** Stock every pad at match start so the arena is never empty. */
export function initPickups(world: SimWorld): void {
  const pads = world.map.weaponPads;
  const count = Math.min(pads.length, MAX_WEAPON_PADS);
  for (let i = 0; i < count; i++) {
    const pad = pads[i];
    if (pad !== undefined) refillPad(world, i, pad, false);
  }
}

// ---------- ground items ----------

interface SpawnRequest {
  kind: PickupKind;
  weapon: number;
  mag: number;
  reserve: number;
  x: number;
  y: number;
  velX: number;
  velY: number;
  padIndex: number;
  ttl: number;
  arm: number;
}

/**
 * Claim a pickup slot. When the pool is saturated the shortest-lived *drop*
 * is recycled — pad guns are never evicted, so the arena's fixed supply
 * survives a messy firefight.
 */
function spawnPickup(world: SimWorld, req: SpawnRequest): number {
  const pk = world.pickups;
  let slot = pk.findFree();
  if (slot === -1) slot = oldestDrop(world);
  if (slot === -1) return -1;

  releaseSlot(world, slot);

  pk.alive[slot] = 1;
  pk.kind[slot] = req.kind;
  pk.weapon[slot] = req.weapon;
  pk.mag[slot] = req.mag;
  pk.reserve[slot] = req.reserve;
  pk.posX[slot] = req.x;
  pk.posY[slot] = req.y;
  pk.velX[slot] = req.velX;
  pk.velY[slot] = req.velY;
  pk.grounded[slot] = 0;
  pk.padIndex[slot] = req.padIndex;
  pk.ttl[slot] = req.ttl;
  pk.arm[slot] = req.arm;
  return slot;
}

/** Live drop with the least time remaining, or -1 if there are none. */
function oldestDrop(world: SimWorld): number {
  const pk = world.pickups;
  let best = -1;
  let bestTtl = Infinity;
  for (let i = 0; i < MAX_PICKUPS; i++) {
    if (pk.alive[i] !== 1 || (pk.padIndex[i] ?? -1) >= 0) continue;
    const ttl = pk.ttl[i] ?? 0;
    if (ttl < bestTtl) {
      bestTtl = ttl;
      best = i;
    }
  }
  return best;
}

/** Free a pickup slot, detaching it from its pad if it had one. */
function releaseSlot(world: SimWorld, slot: number): void {
  const pk = world.pickups;
  const pad = pk.padIndex[slot] ?? -1;
  if (pad >= 0 && world.pads.pickup[pad] === slot) {
    // Remember what this pad last offered so the no-repeat rule survives.
    world.pads.lastWeapon[pad] = pk.weapon[slot] ?? -1;
    world.pads.pickup[pad] = -1;
    if ((world.pads.timer[pad] ?? 0) <= 0) {
      world.pads.timer[pad] = TUNING.pickups.weaponRespawnDelay;
    }
  }
  pk.alive[slot] = 0;
  pk.padIndex[slot] = -1;
  pk.ttl[slot] = 0;
  pk.arm[slot] = 0;
}

/** Gravity, settling, and expiry for everything on the ground. */
function advanceDrops(world: SimWorld): void {
  const pk = world.pickups;
  const t = TUNING.pickups;
  const restHalf = t.dropRestHalfHeight;

  for (let i = 0; i < MAX_PICKUPS; i++) {
    if (pk.alive[i] !== 1) continue;

    // Drops age out; pad guns (ttl 0) stay until taken.
    const ttl = pk.ttl[i] ?? 0;
    if (ttl > 0) {
      const left = ttl - SIM_DT;
      if (left <= 0) {
        releaseSlot(world, i);
        continue;
      }
      pk.ttl[i] = left;
    }

    const arm = pk.arm[i] ?? 0;
    if (arm > 0) pk.arm[i] = Math.max(0, arm - SIM_DT);

    if (pk.grounded[i] === 1) continue;

    let posX = pk.posX[i] ?? 0;
    let posY = pk.posY[i] ?? 0;
    let velX = pk.velX[i] ?? 0;
    let velY = (pk.velY[i] ?? 0) + TUNING.player.gravity * SIM_DT;
    velX -= velX * t.dropAirDrag * SIM_DT;

    const nextX = posX + velX * SIM_DT;
    if (isSolid(world.map, Math.floor(nextX), Math.floor(posY))) velX = 0;
    else posX = nextX;

    const nextY = posY + velY * SIM_DT;
    if (isSolid(world.map, Math.floor(posX), Math.floor(nextY + restHalf))) {
      // Rest the item's underside on the surface it landed on.
      posY = Math.floor(nextY + restHalf) - restHalf;
      velX = 0;
      velY = 0;
      pk.grounded[i] = 1;
    } else {
      posY = nextY;
    }

    pk.posX[i] = posX;
    pk.posY[i] = posY;
    pk.velX[i] = velX;
    pk.velY[i] = velY;
  }
}

// ---------- collection ----------

function resolveCollections(world: SimWorld): void {
  const pk = world.pickups;
  // A player makes at most one *deliberate* pickup per tick: collecting can
  // itself drop gear into a later pool slot, and nobody should sweep a pile
  // with one press. Automatic grenade gathering is exempt — it is not a
  // decision, and it is already bounded by the carry cap.
  let claimed = 0;
  for (let i = 0; i < MAX_PICKUPS; i++) {
    if (pk.alive[i] !== 1) continue;
    const taker = findCollector(world, i);
    if (taker === -1) continue;

    const automatic = (pk.kind[i] as PickupKind) === PickupKind.Grenades;
    if (!automatic) {
      if ((claimed & (1 << taker)) !== 0) continue;
      claimed |= 1 << taker;
    }
    collect(world, taker, i);
  }
}

/** True when a living player's body is within reach of a ground item. */
export function playerReachesPickup(world: SimWorld, player: number, pickup: number): boolean {
  const p = world.players;
  if (p.connected[player] !== 1 || p.status[player] !== 1) return false;
  if (world.pickups.alive[pickup] !== 1) return false;
  if ((world.pickups.arm[pickup] ?? 0) > 0) return false; // still settling
  const reachX = TUNING.player.width / 2 + TUNING.pickups.halfSize;
  const reachY = TUNING.player.height / 2 + TUNING.pickups.halfSize;
  if (Math.abs((p.posX[player] ?? 0) - (world.pickups.posX[pickup] ?? 0)) > reachX) return false;
  return Math.abs((p.posY[player] ?? 0) - (world.pickups.posY[pickup] ?? 0)) <= reachY;
}

/**
 * Index of the ground item a player must *press* to collect, or -1. Clients
 * call this to decide whether to offer the pickup button, so the prompt can
 * never disagree with what the simulation would accept.
 *
 * Grenades are excluded: they are gathered automatically when there is room
 * and cannot be taken at all when full, so a button for them would never do
 * anything.
 */
export function findPickupUnderPlayer(world: SimWorld, player: number): number {
  for (let i = 0; i < MAX_PICKUPS; i++) {
    if ((world.pickups.kind[i] as PickupKind) === PickupKind.Grenades) continue;
    if (playerReachesPickup(world, player, i)) return i;
  }
  return -1;
}

/**
 * Grenades are gathered by walking over them, up to the carry cap — no button
 * (ADR-016). Weapons never auto-collect: swapping your gun must stay a
 * deliberate choice, but topping up grenades is never a decision worth a
 * keypress.
 */
function autoCollects(world: SimWorld, player: number, pickup: number): boolean {
  if ((world.pickups.kind[pickup] as PickupKind) !== PickupKind.Grenades) return false;
  return (world.players.grenades[player] ?? 0) < TUNING.player.maxGrenades;
}

/**
 * Lowest-indexed player on the item who either pressed interact this tick or
 * qualifies for automatic pickup, or -1. Ties resolve by index so hosts and
 * replays agree (ADR-009).
 */
function findCollector(world: SimWorld, pickup: number): number {
  const p = world.players;
  const isGrenades = (world.pickups.kind[pickup] as PickupKind) === PickupKind.Grenades;

  for (let t = 0; t < MAX_PLAYERS; t++) {
    if (!playerReachesPickup(world, t, pickup)) continue;

    if (isGrenades) {
      // Automatic when there is room, and impossible when full — a press
      // never enters into it, so a player standing on a stack they cannot
      // use never has their press swallowed by it.
      if (autoCollects(world, t, pickup)) return t;
      continue;
    }

    const cmd = world.inputs[t];
    if (cmd === undefined) continue;
    const pressed = cmd.buttons & ~(p.prevButtons[t] ?? 0);
    if ((pressed & Buttons.Interact) === 0) continue;
    return t;
  }
  return -1;
}

function collect(world: SimWorld, player: number, pickup: number): void {
  const pk = world.pickups;
  const x = pk.posX[pickup] ?? 0;
  const y = pk.posY[pickup] ?? 0;

  if ((pk.kind[pickup] as PickupKind) === PickupKind.Grenades) {
    const p = world.players;
    const have = p.grenades[player] ?? 0;
    const room = TUNING.player.maxGrenades - have;
    if (room <= 0) return; // full: leave the whole stack for someone else

    // Take only what fits. A stack of 3 walked over by a player holding 1
    // gives up 2 and keeps 1 lying there for the next person.
    const available = pk.mag[pickup] ?? 0;
    const taken = Math.min(room, available);
    if (taken <= 0) return;
    p.grenades[player] = have + taken;

    const remaining = available - taken;
    if (remaining > 0) pk.mag[pickup] = remaining;
    else releaseSlot(world, pickup);

    world.events.emit(SimEventType.PickupTaken, player, -1, x, y, taken);
    return;
  }

  const weapon = (pk.weapon[pickup] ?? 0) as WeaponId;
  const toppedUp = takeWeapon(world, player, weapon, pk.mag[pickup] ?? 0, pk.reserve[pickup] ?? 0);
  releaseSlot(world, pickup);
  world.events.emit(SimEventType.PickupTaken, player, weapon, x, y, toppedUp ? 1 : 0);
}

/**
 * Equip a weapon off the ground. Already carrying it merges the ammo into
 * that slot instead of swapping, so a duplicate is never a downgrade.
 *
 * Otherwise it replaces **the weapon in its own slot** — a rifle can only
 * displace your rifle, a sidearm only your sidearm (ADR-017) — and the gun
 * that came out is dropped at the player's feet with the ammo it had left.
 * The player also switches to what they just picked up, since the pickup was
 * a deliberate press.
 *
 * Returns true when it was an ammo merge rather than a swap.
 */
function takeWeapon(
  world: SimWorld,
  player: number,
  weapon: WeaponId,
  mag: number,
  reserve: number,
): boolean {
  const p = world.players;
  const def = weaponDef(weapon);

  for (let s = 0; s < WEAPON_SLOTS; s++) {
    const idx = player * WEAPON_SLOTS + s;
    if (p.weapons[idx] === weapon) {
      const pooled = (p.ammoReserve[idx] ?? 0) + mag + reserve;
      p.ammoReserve[idx] = Math.min(def.reserveMax, pooled);
      return true;
    }
  }

  const slot = def.slot;
  const idx = player * WEAPON_SLOTS + slot;
  dropItem(world, player, {
    kind: PickupKind.Weapon,
    weapon: p.weapons[idx] ?? 0,
    mag: p.ammoMag[idx] ?? 0,
    reserve: p.ammoReserve[idx] ?? 0,
    sideways: -1,
  });

  p.weapons[idx] = weapon;
  p.ammoMag[idx] = mag;
  p.ammoReserve[idx] = reserve;
  p.weaponSlot[player] = slot; // you asked for it, so you are holding it
  // A swap interrupts whatever the old weapon was doing.
  p.reload[player] = 0;
  p.bloom[player] = 0;
  p.cooldown[player] = Math.max(p.cooldown[player] ?? 0, TUNING.combat.switchDelay);
  return false;
}

// ---------- drops ----------

interface DropRequest {
  kind: PickupKind;
  weapon: number;
  mag: number;
  reserve: number;
  /** -1 throws the item left, +1 right, 0 straight up. */
  sideways: number;
}

/** Throw one item clear of a player, where it arcs down and settles. */
function dropItem(world: SimWorld, player: number, req: DropRequest): void {
  const p = world.players;
  const t = TUNING.pickups;
  const slot = spawnPickup(world, {
    kind: req.kind,
    weapon: req.weapon,
    mag: req.mag,
    reserve: req.reserve,
    x: p.posX[player] ?? 0,
    y: p.posY[player] ?? 0,
    // Fixed scatter rather than a random one: drops stay deterministic
    // without consuming RNG draws that reconciliation would have to replay.
    velX: req.sideways * t.dropSideSpeed,
    velY: -t.dropUpSpeed,
    padIndex: -1,
    ttl: t.dropTtl,
    arm: t.dropArmDelay,
  });
  if (slot === -1) return;
  world.events.emit(
    SimEventType.PickupDropped,
    player,
    req.kind === PickupKind.Grenades ? -1 : req.weapon,
    world.pickups.posX[slot] ?? 0,
    world.pickups.posY[slot] ?? 0,
  );
}

/**
 * Scatter everything a player was carrying — both weapons with their exact
 * remaining ammo, plus any grenades. Called when they die, so a kill leaves
 * loot worth fighting over.
 */
export function dropAllEquipment(world: SimWorld, player: number): void {
  const p = world.players;

  for (let s = 0; s < WEAPON_SLOTS; s++) {
    const idx = player * WEAPON_SLOTS + s;
    dropItem(world, player, {
      kind: PickupKind.Weapon,
      weapon: p.weapons[idx] ?? 0,
      mag: p.ammoMag[idx] ?? 0,
      reserve: p.ammoReserve[idx] ?? 0,
      sideways: s === 0 ? -1 : 1,
    });
  }

  const grenades = p.grenades[player] ?? 0;
  if (grenades > 0) {
    dropItem(world, player, {
      kind: PickupKind.Grenades,
      weapon: 0,
      mag: grenades,
      reserve: 0,
      sideways: 0,
    });
    p.grenades[player] = 0;
  }
}
