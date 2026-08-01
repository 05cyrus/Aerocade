import { MAX_PLAYERS, SIM_DT } from '../../constants.js';
import { spawnPlayer } from '../spawns.js';
import type { SimWorld } from '../world.js';

/** Count down dead players' respawn timers and bring them back. */
export function respawnSystem(world: SimWorld): void {
  const p = world.players;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1 || p.status[i] === 1) continue;
    const left = (p.respawn[i] ?? 0) - SIM_DT;
    p.respawn[i] = Math.max(0, left);
    if (left <= 0) {
      spawnPlayer(world, i);
    }
  }
}
