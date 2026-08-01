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

/** Pool capacity for map pickups (health, ammo, weapons). */
export const MAX_PICKUPS = 64;

/** Pool capacity for per-tick simulation events (effects, kills, sounds). */
export const MAX_EVENTS = 128;

/** Pool capacity for per-tick damage requests. */
export const MAX_DAMAGE_REQUESTS = 128;

/** Weapon inventory slots per player. */
export const WEAPON_SLOTS = 2;

/** Sentinel for "no player" in ownership/attribution fields. */
export const NO_PLAYER = -1;
