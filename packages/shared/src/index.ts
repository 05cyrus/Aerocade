/**
 * @aerocade/shared — the deterministic Aerocade engine core.
 * Everything exported here is renderer-free and runs identically in browsers
 * and Node. See docs/architecture.md for the layering rules.
 */

export * from './constants.js';
export * from './math/scalar.js';
export { Rng } from './math/rng.js';

export * from './sim/tuning.js';
export * from './sim/input.js';
export * from './sim/events.js';
export * from './sim/geometry.js';
export * from './sim/map/mapdef.js';
export { createFoundryMap } from './sim/map/foundry.js';
export { createOutpostDeltaMap } from './sim/map/outpost-delta.js';
export { createHollowWorksMap, HOLLOW_WORKS_DECKS } from './sim/map/hollow-works.js';
export * from './sim/map/maps.js';
export * from './sim/map/export.js';
export * from './sim/world.js';
export * from './sim/spawns.js';
export * from './sim/match.js';
export * from './sim/step.js';
export { movementSystem } from './sim/systems/movement.js';
export { physicsSystem } from './sim/systems/physics.js';
export { weaponsSystem } from './sim/systems/weapons.js';
export { projectilesSystem } from './sim/systems/projectiles.js';
export { damageSystem } from './sim/systems/damage.js';
export {
  pickupsSystem,
  initPickups,
  findPickupUnderPlayer,
  playerReachesPickup,
  dropAllEquipment,
} from './sim/systems/pickups.js';
export { respawnSystem } from './sim/systems/respawn.js';
export * from './sim/combat/weapon-defs.js';
export { explode } from './sim/combat/explosions.js';

export * from './protocol/messages.js';
export * from './protocol/codec.js';
export * from './net/base64.js';
export * from './net/transport.js';
export * from './net/bridge-client.js';
export * from './net/relay-transport.js';
