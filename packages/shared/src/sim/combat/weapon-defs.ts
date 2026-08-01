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
  projectile?: ProjectileDef;
}

const defs: Record<WeaponId, WeaponDef> = {
  [WeaponId.RivetPistol]: {
    id: WeaponId.RivetPistol,
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
  },
  [WeaponId.VortexSmg]: {
    id: WeaponId.VortexSmg,
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
  },
  [WeaponId.PulseRifle]: {
    id: WeaponId.PulseRifle,
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
  },
  [WeaponId.Scattergun]: {
    id: WeaponId.Scattergun,
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
  },
  [WeaponId.LongboltRifle]: {
    id: WeaponId.LongboltRifle,
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
  },
  [WeaponId.Thumper]: {
    id: WeaponId.Thumper,
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

/** Weapons every player spawns with in the sandbox and default loadout. */
export const DEFAULT_LOADOUT: readonly [WeaponId, WeaponId] = [
  WeaponId.VortexSmg,
  WeaponId.Thumper,
];
