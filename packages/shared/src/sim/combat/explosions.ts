import { MAX_PLAYERS } from '../../constants.js';
import { SimEventType } from '../events.js';
import { pointToAabbDistance } from '../geometry.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * Apply an explosion: radial damage with linear falloff plus a knockback
 * impulse away from the center. The owner takes reduced self-damage but full
 * knockback — that asymmetry is what makes rocket-jumping worth the health.
 * v1 deliberately has no line-of-sight occlusion (documented in physics.md).
 */
export function explode(
  world: SimWorld,
  centerX: number,
  centerY: number,
  radius: number,
  maxDamage: number,
  knockback: number,
  owner: number,
  weaponRef: number,
): void {
  const p = world.players;
  const halfW = TUNING.player.width / 2;
  const halfH = TUNING.player.height / 2;
  const edgeFrac = TUNING.combat.explosionEdgeDamageFrac;

  world.events.emit(SimEventType.Explosion, owner, weaponRef, centerX, centerY, radius);

  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1 || p.status[i] !== 1) continue;
    const px = p.posX[i] ?? 0;
    const py = p.posY[i] ?? 0;
    const dist = pointToAabbDistance(centerX, centerY, px, py, halfW, halfH);
    if (dist > radius) continue;

    const falloff = edgeFrac + (1 - edgeFrac) * (1 - dist / radius);
    const isSelf = i === owner;
    const damage = maxDamage * falloff * (isSelf ? TUNING.combat.selfDamageFrac : 1);

    // Push away from the center; straight up if the center is inside the box.
    let dirX = px - centerX;
    let dirY = py - centerY;
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) {
      dirX = 0;
      dirY = -1;
    } else {
      dirX /= len;
      dirY /= len;
    }
    const impulse = knockback * falloff;
    world.damage.push(i, damage, owner, dirX * impulse, dirY * impulse);
  }
}
