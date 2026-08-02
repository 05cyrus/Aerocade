import { initPickups } from './systems/pickups.js';
import { createWorld, type SimWorld } from './world.js';
import type { MapDef } from './map/mapdef.js';

/**
 * Create a match-ready world: an empty sim with every weapon pad stocked.
 * This is the entry point game code should use — `createWorld` alone leaves
 * the arena without guns on the ground.
 */
export function createMatch(map: MapDef, seed: number): SimWorld {
  const world = createWorld(map, seed);
  initPickups(world);
  return world;
}
