import { MAX_PLAYERS } from '../constants.js';
import { damageSystem } from './systems/damage.js';
import { movementSystem } from './systems/movement.js';
import { physicsSystem } from './systems/physics.js';
import { projectilesSystem } from './systems/projectiles.js';
import { respawnSystem } from './systems/respawn.js';
import { weaponsSystem } from './systems/weapons.js';
import type { SimWorld } from './world.js';

/**
 * Advance the world exactly one tick. This is THE simulation entry point —
 * host, prediction, replays, and tests all call this and nothing else.
 *
 * System order is a determinism contract (documented in docs/ecs.md):
 * inputs were staged via `setInput` before this call; `prevButtons` is
 * committed at the end so every system sees the same edge transitions.
 */
export function stepWorld(world: SimWorld): void {
  world.events.clear();
  world.damage.clear();

  movementSystem(world);
  physicsSystem(world);
  weaponsSystem(world);
  projectilesSystem(world);
  damageSystem(world);
  respawnSystem(world);

  const p = world.players;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] === 1) {
      p.prevButtons[i] = world.inputs[i]?.buttons ?? 0;
    }
  }

  world.tick += 1;
}
