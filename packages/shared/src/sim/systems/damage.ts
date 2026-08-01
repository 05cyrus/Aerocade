import { NO_PLAYER } from '../../constants.js';
import { SimEventType } from '../events.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * Apply the tick's queued damage: spawn protection gate, knockback impulse,
 * health, death, attribution, and scoring. Health is mutated nowhere else,
 * so combat resolution order is exactly queue order (which is itself
 * deterministic system order).
 */
export function damageSystem(world: SimWorld): void {
  const p = world.players;
  const q = world.damage;

  for (let r = 0; r < q.count; r++) {
    const req = q.at(r);
    const target = req.target;
    if (p.connected[target] !== 1 || p.status[target] !== 1) continue;
    if ((p.protect[target] ?? 0) > 0) continue; // spawn protection absorbs everything

    p.velX[target] = (p.velX[target] ?? 0) + req.impulseX;
    p.velY[target] = (p.velY[target] ?? 0) + req.impulseY;

    const health = (p.health[target] ?? 0) - req.amount;
    p.health[target] = health;

    if (req.source !== NO_PLAYER && req.source !== target) {
      p.lastDamageBy[target] = req.source;
    }

    if (health <= 0) {
      kill(world, target, req.source);
    }
  }
}

function kill(world: SimWorld, victim: number, directSource: number): void {
  const p = world.players;
  p.status[victim] = 0;
  p.health[victim] = 0;
  p.respawn[victim] = TUNING.player.respawnDelay;
  p.deaths[victim] = (p.deaths[victim] ?? 0) + 1;

  // Credit the direct source; fall back to the last attacker (e.g. a shove
  // into a pit — relevant once world hazards exist). Suicides credit nobody.
  let killer = directSource;
  if (killer === NO_PLAYER) killer = p.lastDamageBy[victim] ?? NO_PLAYER;
  if (killer === victim) killer = NO_PLAYER;

  if (killer !== NO_PLAYER && p.connected[killer] === 1) {
    p.kills[killer] = (p.kills[killer] ?? 0) + 1;
    p.score[killer] = (p.score[killer] ?? 0) + TUNING.match.killScore;
  }

  world.events.emit(SimEventType.Death, victim, killer, p.posX[victim] ?? 0, p.posY[victim] ?? 0);
}
