import {
  MAX_DAMAGE_REQUESTS,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  NO_PLAYER,
  SIM_DT,
  WEAPON_SLOTS,
} from '../constants.js';
import { Rng } from '../math/rng.js';
import { EventBuffer } from './events.js';
import { emptyInput, type InputCommand } from './input.js';
import type { MapDef } from './map/mapdef.js';

/** Any typed array we snapshot. */
type PoolArray = Float64Array | Float32Array | Int16Array | Int8Array | Uint8Array | Uint16Array;

/** Copy every array of `src` into the same-shaped `dst`. */
function copyArrays(src: readonly PoolArray[], dst: readonly PoolArray[]): void {
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    const d = dst[i];
    if (s === undefined || d === undefined) throw new Error('pool shape mismatch');
    // The pools are same-shaped by construction; set() is a fast memcpy.
    (d as Float64Array).set(s);
  }
}

/**
 * Player state as parallel arrays (struct-of-arrays). Slot index = player id.
 * A slot is in play when `connected[i] === 1`; `status[i]` is 1 while alive,
 * 0 while dead/awaiting respawn. Names/ping live outside the sim (roster).
 */
export class PlayerPool {
  readonly connected = new Uint8Array(MAX_PLAYERS);
  readonly status = new Uint8Array(MAX_PLAYERS);
  readonly posX = new Float64Array(MAX_PLAYERS);
  readonly posY = new Float64Array(MAX_PLAYERS);
  readonly velX = new Float64Array(MAX_PLAYERS);
  readonly velY = new Float64Array(MAX_PLAYERS);
  readonly aim = new Float32Array(MAX_PLAYERS);
  readonly health = new Float32Array(MAX_PLAYERS);
  readonly fuel = new Float32Array(MAX_PLAYERS);
  /** Time left before fuel regen resumes. */
  readonly fuelRegenWait = new Float32Array(MAX_PLAYERS);
  readonly grounded = new Uint8Array(MAX_PLAYERS);
  /** Coyote-time remaining (jump grace after leaving a ledge). */
  readonly coyote = new Float32Array(MAX_PLAYERS);
  /** Active inventory slot (0..WEAPON_SLOTS-1). */
  readonly weaponSlot = new Uint8Array(MAX_PLAYERS);
  /** WeaponId per inventory slot, flattened [player * WEAPON_SLOTS + slot]. */
  readonly weapons = new Uint8Array(MAX_PLAYERS * WEAPON_SLOTS);
  readonly ammoMag = new Int16Array(MAX_PLAYERS * WEAPON_SLOTS);
  readonly ammoReserve = new Int16Array(MAX_PLAYERS * WEAPON_SLOTS);
  /** Remaining reload time for the active slot; 0 = not reloading. */
  readonly reload = new Float32Array(MAX_PLAYERS);
  /** Remaining fire cooldown. */
  readonly cooldown = new Float32Array(MAX_PLAYERS);
  /** Accumulated extra spread (bloom), radians. */
  readonly bloom = new Float32Array(MAX_PLAYERS);
  readonly meleeCooldown = new Float32Array(MAX_PLAYERS);
  readonly grenades = new Uint8Array(MAX_PLAYERS);
  /** Remaining respawn wait while dead. */
  readonly respawn = new Float32Array(MAX_PLAYERS);
  /** Remaining spawn protection. */
  readonly protect = new Float32Array(MAX_PLAYERS);
  /** Buttons held last tick, for edge detection. */
  readonly prevButtons = new Uint16Array(MAX_PLAYERS);
  readonly kills = new Int16Array(MAX_PLAYERS);
  readonly deaths = new Int16Array(MAX_PLAYERS);
  readonly score = new Int16Array(MAX_PLAYERS);
  readonly team = new Uint8Array(MAX_PLAYERS);
  /** Last player to damage this one (kill attribution), NO_PLAYER if none. */
  readonly lastDamageBy = new Int8Array(MAX_PLAYERS).fill(NO_PLAYER);

  /** Every array, in a fixed order shared by snapshot/restore/hash. */
  readonly all: readonly PoolArray[] = [
    this.connected,
    this.status,
    this.posX,
    this.posY,
    this.velX,
    this.velY,
    this.aim,
    this.health,
    this.fuel,
    this.fuelRegenWait,
    this.grounded,
    this.coyote,
    this.weaponSlot,
    this.weapons,
    this.ammoMag,
    this.ammoReserve,
    this.reload,
    this.cooldown,
    this.bloom,
    this.meleeCooldown,
    this.grenades,
    this.respawn,
    this.protect,
    this.prevButtons,
    this.kills,
    this.deaths,
    this.score,
    this.team,
    this.lastDamageBy,
  ];
}

/** Projectile kinds understood by the projectile system. */
export const ProjectileKind = {
  /** Fired from a weapon; stats come from the weapon's ProjectileDef. */
  Weapon: 0,
  /** Thrown frag grenade; stats come from TUNING.grenade. */
  FragGrenade: 1,
} as const;

export type ProjectileKind = (typeof ProjectileKind)[keyof typeof ProjectileKind];

export class ProjectilePool {
  readonly alive = new Uint8Array(MAX_PROJECTILES);
  readonly kind = new Uint8Array(MAX_PROJECTILES);
  /** Source WeaponId for kind=Weapon (meaningless for grenades). */
  readonly weapon = new Uint8Array(MAX_PROJECTILES);
  readonly owner = new Int8Array(MAX_PROJECTILES);
  readonly posX = new Float64Array(MAX_PROJECTILES);
  readonly posY = new Float64Array(MAX_PROJECTILES);
  readonly velX = new Float64Array(MAX_PROJECTILES);
  readonly velY = new Float64Array(MAX_PROJECTILES);
  /** Time until detonation/expiry. */
  readonly fuse = new Float32Array(MAX_PROJECTILES);

  readonly all: readonly PoolArray[] = [
    this.alive,
    this.kind,
    this.weapon,
    this.owner,
    this.posX,
    this.posY,
    this.velX,
    this.velY,
    this.fuse,
  ];

  /** First free slot, or -1 when saturated (oldest is NOT evicted; spawn fails). */
  findFree(): number {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (this.alive[i] === 0) return i;
    }
    return -1;
  }
}

/**
 * Weapon pads. Slot _i_ corresponds to `map.weaponPads[i]`, so positions are
 * static map data and only the contents are simulated: which weapon is on the
 * pad, whether it is collectable, and how long until it refills.
 */
export class PickupPool {
  /** 1 while a weapon is sitting on the pad and can be collected. */
  readonly active = new Uint8Array(MAX_PICKUPS);
  /** WeaponId currently offered (meaningful only while active). */
  readonly weapon = new Uint8Array(MAX_PICKUPS);
  /** Seconds until the pad refills; 0 while active. */
  readonly respawnIn = new Float32Array(MAX_PICKUPS);

  readonly all: readonly PoolArray[] = [this.active, this.weapon, this.respawnIn];
}

/** One queued damage application; consumed by the damage system each tick. */
export interface DamageRequest {
  target: number;
  amount: number;
  /** Attacking player, or NO_PLAYER for world damage. */
  source: number;
  impulseX: number;
  impulseY: number;
}

/** Preallocated damage queue; cleared every tick. */
export class DamageQueue {
  private readonly pool: DamageRequest[] = Array.from({ length: MAX_DAMAGE_REQUESTS }, () => ({
    target: 0,
    amount: 0,
    source: NO_PLAYER,
    impulseX: 0,
    impulseY: 0,
  }));
  private len = 0;

  get count(): number {
    return this.len;
  }

  clear(): void {
    this.len = 0;
  }

  push(target: number, amount: number, source: number, impulseX: number, impulseY: number): void {
    if (this.len >= MAX_DAMAGE_REQUESTS) return;
    const r = this.pool[this.len];
    if (r === undefined) return;
    r.target = target;
    r.amount = amount;
    r.source = source;
    r.impulseX = impulseX;
    r.impulseY = impulseY;
    this.len += 1;
  }

  at(index: number): DamageRequest {
    const r = this.pool[index];
    if (r === undefined || index >= this.len) {
      throw new RangeError(`damage index ${String(index)} out of range`);
    }
    return r;
  }
}

/**
 * The complete authoritative game state plus per-tick scratch (inputs, damage
 * queue, events). Everything the simulation reads or writes hangs off this
 * value — there is no module-level mutable state anywhere in the sim.
 */
export interface SimWorld {
  tick: number;
  readonly rng: Rng;
  readonly map: MapDef;
  readonly players: PlayerPool;
  readonly projectiles: ProjectilePool;
  readonly pickups: PickupPool;
  readonly damage: DamageQueue;
  readonly events: EventBuffer;
  /** Current-tick input per player slot; set via `setInput` before stepping. */
  readonly inputs: readonly InputCommand[];
}

/**
 * Build an empty world. Callers then add players and stock the weapon pads —
 * `createMatch` in `match.ts` does both and is what game code should use.
 */
export function createWorld(map: MapDef, seed: number): SimWorld {
  return {
    tick: 0,
    rng: new Rng(seed),
    map,
    players: new PlayerPool(),
    projectiles: new ProjectilePool(),
    pickups: new PickupPool(),
    damage: new DamageQueue(),
    events: new EventBuffer(),
    inputs: Array.from({ length: MAX_PLAYERS }, () => emptyInput()),
  };
}

/** Elapsed simulated time in seconds. */
export function worldTime(world: SimWorld): number {
  return world.tick * SIM_DT;
}

/** Copy a command's fields into the world's per-slot input (no aliasing). */
export function setInput(world: SimWorld, slot: number, cmd: InputCommand): void {
  const dst = world.inputs[slot];
  if (dst === undefined) return;
  dst.seq = cmd.seq;
  dst.moveX = cmd.moveX;
  dst.moveY = cmd.moveY;
  dst.aim = cmd.aim;
  dst.buttons = cmd.buttons;
}

/** A restorable copy of all mutable sim state (for reconciliation/rewind). */
export interface Snapshot {
  tick: number;
  rngState: number;
  players: PlayerPool;
  projectiles: ProjectilePool;
  pickups: PickupPool;
}

export function createSnapshot(): Snapshot {
  return {
    tick: 0,
    rngState: 0,
    players: new PlayerPool(),
    projectiles: new ProjectilePool(),
    pickups: new PickupPool(),
  };
}

export function takeSnapshot(world: SimWorld, out: Snapshot): Snapshot {
  out.tick = world.tick;
  out.rngState = world.rng.state;
  copyArrays(world.players.all, out.players.all);
  copyArrays(world.projectiles.all, out.projectiles.all);
  copyArrays(world.pickups.all, out.pickups.all);
  return out;
}

export function restoreSnapshot(world: SimWorld, snap: Snapshot): void {
  world.tick = snap.tick;
  world.rng.state = snap.rngState;
  copyArrays(snap.players.all, world.players.all);
  copyArrays(snap.projectiles.all, world.projectiles.all);
  copyArrays(snap.pickups.all, world.pickups.all);
}

/**
 * FNV-1a hash over all state bytes. Two worlds that simulated the same inputs
 * from the same seed hash identically — the backbone of determinism tests.
 */
export function stateHash(world: SimWorld): number {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  };
  mix(world.tick & 0xff);
  mix((world.tick >>> 8) & 0xff);
  mix((world.tick >>> 16) & 0xff);
  mix((world.tick >>> 24) & 0xff);
  mix(world.rng.state & 0xff);
  mix((world.rng.state >>> 8) & 0xff);
  mix((world.rng.state >>> 16) & 0xff);
  mix((world.rng.state >>> 24) & 0xff);
  const pools = [world.players.all, world.projectiles.all, world.pickups.all];
  for (const pool of pools) {
    for (const arr of pool) {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (const byte of bytes) {
        mix(byte);
      }
    }
  }
  return h >>> 0;
}
