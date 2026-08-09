import { WEAPON_COUNT, weaponDef, type WeaponId } from '@aerocade/shared';
import { SfxId } from './sfx.js';

/**
 * Which clip each weapon fires with, indexed by `WeaponId`.
 *
 * Kept in its own module rather than inside `ArenaScene` so the mapping can be
 * tested without loading Phaser — the invariant worth protecting (one clip per
 * weapon, none shared) is not something to discover by ear in a running game.
 */
export const SHOT_SFX: readonly SfxId[] = [
  SfxId.ShotPistol, // Rivet Pistol
  SfxId.ShotSmg, // Vortex SMG
  SfxId.ShotRifle, // Pulse Rifle
  SfxId.ShotShotgun, // Scattergun
  SfxId.ShotSniper, // Longbolt Rifle
  SfxId.ShotThumper, // Thumper
  SfxId.ShotLobber, // Lobber
];

/**
 * The clip a weapon fires with. Falls back to the pistol only so a weapon added
 * without a sound is audible rather than silent; the test suite fails first.
 */
export function shotSfx(weapon: WeaponId): SfxId {
  return SHOT_SFX[weapon] ?? SfxId.ShotPistol;
}

/**
 * How long this weapon's clip may be before it overlaps itself, in seconds.
 *
 * A clip whose loud part outlasts the fire interval smears into noise at full
 * auto, and the fix is always to shorten the clip rather than to quieten it. The
 * Vortex SMG's 90 ms is the tightest budget in the roster.
 */
export function clipBudgetSeconds(weapon: WeaponId): number {
  return weaponDef(weapon).cycleTime;
}

/** Every weapon id, for tests and for iterating the roster. */
export const WEAPON_IDS: readonly WeaponId[] = Array.from(
  { length: WEAPON_COUNT },
  (_, i) => i as WeaponId,
);
