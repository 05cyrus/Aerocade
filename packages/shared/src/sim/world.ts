import {
  MAX_DAMAGE_REQUESTS,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PICKUP_PADS,
  MAX_PROJECTILES,
  NO_PLAYER,
  SIM_DT,
  WEAPON_SLOTS,
} from '../constants.js';
import { Rng } from '../math/rng.js';
import { EventBuffer } from './events.js';
import { MatchState } from './match/state.js';
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
  /** 1 while gripping a ladder: gravity is suspended and climbing is manual. */
  readonly onLadder = new Uint8Array(MAX_PLAYERS);
  /** Cooldown after letting go, so a jump-off cannot instantly re-grip. */
  readonly ladderRegrip = new Float32Array(MAX_PLAYERS);
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
    this.onLadder,
    this.ladderRegrip,
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

/** What a ground pickup contains. */
export const PickupKind = {
  Weapon: 0,
  Grenades: 1,
  /** Restores health on contact. */
  Health: 2,
  /** Refills reserve ammo for every weapon carried. */
  Ammo: 3,
} as const;

export type PickupKind = (typeof PickupKind)[keyof typeof PickupKind];

/**
 * Items lying on the ground: guns spawned by pads, plus gear dropped when a
 * player swaps weapons or dies. Unlike pads these have real positions and
 * fall under gravity, so the pool carries motion state.
 *
 * Ammo travels with the item — a dropped gun keeps exactly the rounds its
 * owner had left (ADR-015).
 */
export class PickupPool {
  readonly alive = new Uint8Array(MAX_PICKUPS);
  /** `PickupKind`. */
  readonly kind = new Uint8Array(MAX_PICKUPS);
  /** WeaponId, for `kind === Weapon`. */
  readonly weapon = new Uint8Array(MAX_PICKUPS);
  /** Rounds in the magazine, or the grenade count for `kind === Grenades`. */
  readonly mag = new Int16Array(MAX_PICKUPS);
  /** Reserve rounds; unused for grenades. */
  readonly reserve = new Int16Array(MAX_PICKUPS);
  readonly posX = new Float64Array(MAX_PICKUPS);
  readonly posY = new Float64Array(MAX_PICKUPS);
  readonly velX = new Float64Array(MAX_PICKUPS);
  readonly velY = new Float64Array(MAX_PICKUPS);
  /** 1 once the item has settled on a surface. */
  readonly grounded = new Uint8Array(MAX_PICKUPS);
  /** Owning weapon pad, or -1 when this is a swap/death drop. */
  readonly padIndex = new Int8Array(MAX_PICKUPS).fill(-1);
  /** Seconds until a drop despawns; 0 means "never" (pad-spawned). */
  readonly ttl = new Float32Array(MAX_PICKUPS);
  /**
   * Seconds before this item can be collected. Gear you just dropped must
   * not fly straight back into your hands on the same tick you swapped.
   */
  readonly arm = new Float32Array(MAX_PICKUPS);

  readonly all: readonly PoolArray[] = [
    this.alive,
    this.kind,
    this.weapon,
    this.mag,
    this.reserve,
    this.posX,
    this.posY,
    this.velX,
    this.velY,
    this.grounded,
    this.padIndex,
    this.ttl,
    this.arm,
  ];

  findFree(): number {
    for (let i = 0; i < MAX_PICKUPS; i++) {
      if (this.alive[i] === 0) return i;
    }
    return -1;
  }
}

/**
 * Pickup pads are fixed spawners, not containers: each owns at most one live
 * pickup and starts a refill timer when that pickup is taken. Slot _i_
 * corresponds to `map.pads[i]`, so positions and kinds stay static map data.
 */
export class WeaponPadPool {
  /** Seconds until this pad spawns a new gun; 0 when it already has one. */
  readonly timer = new Float32Array(MAX_PICKUP_PADS);
  /** Pickup slot this pad currently owns, or -1. */
  readonly pickup = new Int8Array(MAX_PICKUP_PADS).fill(-1);
  /**
   * Weapon this pad last offered, remembered after the pickup is gone so the
   * "never the same gun twice running" rule survives the empty period.
   */
  readonly lastWeapon = new Int8Array(MAX_PICKUP_PADS).fill(-1);

  readonly all: readonly PoolArray[] = [this.timer, this.pickup, this.lastWeapon];
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
  readonly pads: WeaponPadPool;
  readonly damage: DamageQueue;
  readonly events: EventBuffer;
  /** Phase, clock, limits and team scores. Snapshot-serialised (docs/roadmap M4). */
  readonly match: MatchState;
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
    pads: new WeaponPadPool(),
    damage: new DamageQueue(),
    events: new EventBuffer(),
    match: new MatchState(),
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
  pads: WeaponPadPool;
  match: MatchState;
}

export function createSnapshot(): Snapshot {
  return {
    tick: 0,
    rngState: 0,
    players: new PlayerPool(),
    projectiles: new ProjectilePool(),
    pickups: new PickupPool(),
    pads: new WeaponPadPool(),
    match: new MatchState(),
  };
}

export function takeSnapshot(world: SimWorld, out: Snapshot): Snapshot {
  out.tick = world.tick;
  out.rngState = world.rng.state;
  copyArrays(world.players.all, out.players.all);
  copyArrays(world.projectiles.all, out.projectiles.all);
  copyArrays(world.pickups.all, out.pickups.all);
  copyArrays(world.pads.all, out.pads.all);
  out.match.copyFrom(world.match);
  return out;
}

export function restoreSnapshot(world: SimWorld, snap: Snapshot): void {
  world.tick = snap.tick;
  world.rng.state = snap.rngState;
  copyArrays(snap.players.all, world.players.all);
  copyArrays(snap.projectiles.all, world.projectiles.all);
  copyArrays(snap.pickups.all, world.pickups.all);
  copyArrays(snap.pads.all, world.pads.all);
  world.match.copyFrom(snap.match);
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
  // Match state is hashed too: a desync in phase, clock or team score is exactly
  // as fatal as one in a position, and would otherwise pass every determinism test.
  const m = world.match;
  for (const scalar of [
    m.mode,
    m.phase,
    m.phaseStartTick,
    m.timeLimitTicks,
    m.fragLimit,
    m.winner,
  ]) {
    mix(scalar & 0xff);
    mix((scalar >>> 8) & 0xff);
    mix((scalar >>> 16) & 0xff);
    mix((scalar >>> 24) & 0xff);
  }
  const pools = [
    world.players.all,
    world.projectiles.all,
    world.pickups.all,
    world.pads.all,
    [m.teamFrags],
  ];
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
