/**
 * Engine-level constants. Gameplay tuning lives in `sim/tuning.ts`; these are
 * structural limits the whole engine (pools, protocol, netcode) is sized around.
 */

/** Simulation ticks per second. The simulation only ever advances in these steps. */
export const SIM_HZ = 60;

/** Fixed simulation timestep in seconds. */
export const SIM_DT = 1 / SIM_HZ;

/** Hard cap on connected players; pools and the protocol are sized for this. */
export const MAX_PLAYERS = 8;

/** Pool capacity for live projectiles (rockets, shells, grenades). */
export const MAX_PROJECTILES = 256;

/**
 * Pool capacity for items lying on the ground (pad contents plus drops).
 * Sized for a large arena: ~30 pads plus 8 players' worth of death drops.
 */
export const MAX_PICKUPS = 96;

/** Maximum pickup pads (weapon / health / ammo / grenade) a map may declare. */
export const MAX_PICKUP_PADS = 48;

/** Pool capacity for per-tick simulation events (effects, kills, sounds). */
export const MAX_EVENTS = 128;

/** Pool capacity for per-tick damage requests. */
export const MAX_DAMAGE_REQUESTS = 128;

/** Weapon inventory slots per player. */
export const WEAPON_SLOTS = 2;

/** Sentinel for "no player" in ownership/attribution fields. */
export const NO_PLAYER = -1;

/**
 * Scope sentinel for the player-iterating systems: run for everybody.
 *
 * The systems take an optional slot so a client can re-simulate **only its own
 * player** during reconciliation (docs/networking.md §7) through the exact same
 * code the host runs. A separate "predict one player" implementation would be two
 * physics engines that must agree forever, which is the one thing determinism
 * cannot survive.
 */
export const ALL_PLAYERS = -1;
