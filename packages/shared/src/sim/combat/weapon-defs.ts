import { DEG_TO_RAD } from '../../math/scalar.js';

/**
 * Data-driven weapon catalog. Adding a weapon means adding a definition here
 * (and, if it needs one, a projectile kind) — the firing/projectile systems
 * are generic over this data. All names and values are original.
 */

export const WeaponId = {
  RivetPistol: 0,
  VortexSmg: 1,
  PulseRifle: 2,
  Scattergun: 3,
  LongboltRifle: 4,
  Thumper: 5,
  Lobber: 6,
} as const;

export type WeaponId = (typeof WeaponId)[keyof typeof WeaponId];

export const WEAPON_COUNT = 7;

/**
 * Which inventory slot a weapon occupies. The values are the slot indices
 * themselves, so `weapons[player * WEAPON_SLOTS + def.slot]` is the weapon's
 * only legal home: a primary can never displace a sidearm and vice versa
 * (ADR-017).
 */
export const WeaponSlot = {
  /** The big guns: SMGs, rifles, shotguns, snipers, launchers. */
  Primary: 0,
  /** Sidearms — the fallback you always have when the primary runs dry. */
  Secondary: 1,
} as const;

export type WeaponSlot = (typeof WeaponSlot)[keyof typeof WeaponSlot];

/**
 * Scoped-view camera settings — **presentation only**. The simulation never
 * reads these: scoping changes what you can see, never what you can hit, so
 * it stays a client-side camera concern (ADR-016). They live here because how
 * far a weapon lets you see is part of that weapon's design.
 */
export interface ScopeDef {
  /** Multiplier on the visible world width while scoped (1 = no change). */
  zoomOut: number;
  /** Metres the camera slides toward the aim point while scoped. */
  lookAhead: number;
}

export interface SplashDef {
  radius: number;
  maxDamage: number;
  /** Peak knockback impulse at the explosion center, m/s. */
  knockback: number;
}

export interface ProjectileDef {
  /** Muzzle speed, m/s. */
  speed: number;
  /** Multiple of world gravity (0 = flies straight, 1 = full ballistic arc). */
  gravityFactor: number;
  /** Seconds until self-detonation (also the lifetime for impact-only projectiles). */
  fuse: number;
  /** Detonate on world/player contact (false = bounce until fuse, grenade-style). */
  detonateOnImpact: boolean;
  /** Damage applied on a direct player hit, before splash. */
  directDamage: number;
  splash: SplashDef;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  category: 'hitscan' | 'projectile';
  /** Damage per pellet for hitscan; ignored for projectile weapons. */
  damage: number;
  pellets: number;
  /** Seconds between shots. */
  cycleTime: number;
  /** True = fires continuously while held; false = one shot per trigger press. */
  auto: boolean;
  magSize: number;
  /** Maximum reserve ammo carried (excludes the loaded magazine). */
  reserveMax: number;
  reloadTime: number;
  /** Base half-angle cone of fire, radians. */
  spread: number;
  /** Extra spread added per shot (SMG-style bloom), radians. */
  bloomPerShot: number;
  /** Bloom recovery per second, radians. */
  bloomDecay: number;
  /** Max accumulated bloom, radians. */
  bloomMax: number;
  /** Hitscan range, m. Damage falls off between falloffStart and range. */
  range: number;
  falloffStart: number;
  /** Backward impulse on the shooter per shot (recoil), m/s. */
  recoilKick: number;
  /** Impulse multiplier on hitscan targets (scaled by damage dealt). */
  knockbackMult: number;
  /** Inventory slot this weapon lives in; pickups only ever replace their own. */
  slot: WeaponSlot;
  /** How this weapon's scope reframes the view. */
  scope: ScopeDef;
  projectile?: ProjectileDef;
}

const defs: Record<WeaponId, WeaponDef> = {
  [WeaponId.RivetPistol]: {
    id: WeaponId.RivetPistol,
    // a sidearm: the gun you always still have
    slot: WeaponSlot.Secondary,
    name: 'Rivet Pistol',
    category: 'hitscan',
    damage: 16,
    pellets: 1,
    cycleTime: 0.28,
    auto: false,
    magSize: 12,
    reserveMax: 48,
    reloadTime: 1.3,
    spread: 1.5 * DEG_TO_RAD,
    bloomPerShot: 0,
    bloomDecay: 0,
    bloomMax: 0,
    range: 40,
    falloffStart: 22,
    recoilKick: 0.6,
    knockbackMult: 1,
    // sidearm: a glance down-range, nothing more
    scope: { zoomOut: 1.25, lookAhead: 4 },
  },
  [WeaponId.VortexSmg]: {
    id: WeaponId.VortexSmg,
    slot: WeaponSlot.Primary,
    name: 'Vortex SMG',
    category: 'hitscan',
    damage: 9,
    pellets: 1,
    cycleTime: 0.09,
    auto: true,
    magSize: 32,
    reserveMax: 96,
    reloadTime: 1.9,
    spread: 4 * DEG_TO_RAD,
    bloomPerShot: 0.35 * DEG_TO_RAD,
    bloomDecay: 6 * DEG_TO_RAD,
    bloomMax: 3 * DEG_TO_RAD,
    range: 26,
    falloffStart: 12,
    recoilKick: 0.35,
    knockbackMult: 0.8,
    // close quarters; the scope barely helps
    scope: { zoomOut: 1.2, lookAhead: 3 },
  },
  [WeaponId.PulseRifle]: {
    id: WeaponId.PulseRifle,
    slot: WeaponSlot.Primary,
    name: 'Pulse Rifle',
    category: 'hitscan',
    damage: 14,
    pellets: 1,
    cycleTime: 0.14,
    auto: true,
    magSize: 24,
    reserveMax: 72,
    reloadTime: 2.0,
    spread: 2 * DEG_TO_RAD,
    bloomPerShot: 0.25 * DEG_TO_RAD,
    bloomDecay: 5 * DEG_TO_RAD,
    bloomMax: 2 * DEG_TO_RAD,
    range: 38,
    falloffStart: 20,
    recoilKick: 0.5,
    knockbackMult: 1,
    // mid-range workhorse
    scope: { zoomOut: 1.5, lookAhead: 6.5 },
  },
  [WeaponId.Scattergun]: {
    id: WeaponId.Scattergun,
    slot: WeaponSlot.Primary,
    name: 'Scattergun',
    category: 'hitscan',
    damage: 9,
    pellets: 8,
    cycleTime: 0.85,
    auto: false,
    magSize: 6,
    reserveMax: 24,
    reloadTime: 2.2,
    spread: 11 * DEG_TO_RAD,
    bloomPerShot: 0,
    bloomDecay: 0,
    bloomMax: 0,
    range: 14,
    falloffStart: 5,
    recoilKick: 3.2,
    knockbackMult: 1.4,
    // point blank by design — almost no scope
    scope: { zoomOut: 1.1, lookAhead: 2 },
  },
  [WeaponId.LongboltRifle]: {
    id: WeaponId.LongboltRifle,
    slot: WeaponSlot.Primary,
    name: 'Longbolt Rifle',
    category: 'hitscan',
    damage: 70,
    pellets: 1,
    cycleTime: 1.5,
    auto: false,
    magSize: 4,
    reserveMax: 12,
    reloadTime: 2.6,
    spread: 0,
    bloomPerShot: 0,
    bloomDecay: 0,
    bloomMax: 0,
    range: 70,
    falloffStart: 70,
    recoilKick: 2.4,
    knockbackMult: 2,
    // the true sniper: sees most of the arena
    scope: { zoomOut: 2.3, lookAhead: 15 },
  },
  [WeaponId.Thumper]: {
    id: WeaponId.Thumper,
    slot: WeaponSlot.Primary,
    name: 'Thumper',
    category: 'projectile',
    damage: 0,
    pellets: 1,
    cycleTime: 1.1,
    auto: false,
    magSize: 3,
    reserveMax: 9,
    reloadTime: 2.8,
    spread: 1 * DEG_TO_RAD,
    bloomPerShot: 0,
    bloomDecay: 0,
    bloomMax: 0,
    range: 0,
    falloffStart: 0,
    recoilKick: 4.5,
    knockbackMult: 0,
    // lob rockets at targets you could not otherwise see
    scope: { zoomOut: 1.65, lookAhead: 9 },
    projectile: {
      speed: 24,
      gravityFactor: 0,
      fuse: 4,
      detonateOnImpact: true,
      directDamage: 40,
      splash: { radius: 3.2, maxDamage: 55, knockback: 13 },
    },
  },
  [WeaponId.Lobber]: {
    id: WeaponId.Lobber,
    slot: WeaponSlot.Primary,
    name: 'Lobber',
    category: 'projectile',
    damage: 0,
    pellets: 1,
    cycleTime: 0.75,
    auto: false,
    magSize: 4,
    reserveMax: 16,
    reloadTime: 2.5,
    spread: 1.5 * DEG_TO_RAD,
    bloomPerShot: 0,
    bloomDecay: 0,
    bloomMax: 0,
    range: 0,
    falloffStart: 0,
    recoilKick: 1.8,
    knockbackMult: 0,
    // arcing shots need to see where they land
    scope: { zoomOut: 1.5, lookAhead: 7 },
    projectile: {
      speed: 16,
      gravityFactor: 1,
      fuse: 2.0,
      detonateOnImpact: true,
      directDamage: 30,
      splash: { radius: 2.8, maxDamage: 45, knockback: 11 },
    },
  },
};

export function weaponDef(id: WeaponId): WeaponDef {
  return defs[id];
}

export function isWeaponId(value: number): value is WeaponId {
  return Number.isInteger(value) && value >= 0 && value < WEAPON_COUNT;
}

/**
 * Spawn loadout, indexed by slot: `[primary, secondary]`. Each entry must
 * belong to the slot it sits in — `weaponsMatchTheirSlots` asserts it.
 */
export const DEFAULT_LOADOUT: readonly [WeaponId, WeaponId] = [
  WeaponId.VortexSmg,
  WeaponId.RivetPistol,
];

/** Every weapon of a given slot, for roster checks and future loadout UI. */
export function weaponsInSlot(slot: WeaponSlot): WeaponId[] {
  const out: WeaponId[] = [];
  for (let id = 0; id < WEAPON_COUNT; id++) {
    if (defs[id as WeaponId].slot === slot) out.push(id as WeaponId);
  }
  return out;
}
