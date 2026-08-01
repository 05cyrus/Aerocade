import { MAX_PLAYERS, MAX_PROJECTILES, SIM_DT } from '../../constants.js';
import { SimEventType } from '../events.js';
import { explode } from '../combat/explosions.js';
import { weaponDef, type WeaponId } from '../combat/weapon-defs.js';
import { isSolid } from '../map/mapdef.js';
import { pointToAabbDistance } from '../geometry.js';
import { TUNING } from '../tuning.js';
import { ProjectileKind, type SimWorld } from '../world.js';

/** Below this impact speed a bounce silently settles instead of reflecting. */
const SETTLE_SPEED = 0.8;
/** How far beneath a projectile to probe for the surface it rests on. */
const SETTLE_PROBE = 0.05;

/**
 * Projectile flight, bounce, fuse, and impact. Projectiles are points moving
 * axis-separated against the tile grid (speeds stay below one tile per tick,
 * so point stepping cannot tunnel). Direct player hits only apply to
 * detonate-on-impact projectiles; frag grenades bounce off the world and pass
 * through players until their fuse pops.
 */
export function projectilesSystem(world: SimWorld): void {
  const pr = world.projectiles;
  const p = world.players;
  const g = TUNING.grenade;
  const halfW = TUNING.player.width / 2;
  const halfH = TUNING.player.height / 2;

  for (let i = 0; i < MAX_PROJECTILES; i++) {
    if (pr.alive[i] !== 1) continue;

    const kind = pr.kind[i] as ProjectileKind;
    const isGrenade = kind === ProjectileKind.FragGrenade;
    const def = isGrenade ? undefined : weaponDef((pr.weapon[i] ?? 0) as WeaponId).projectile;

    // --- Fuse ---
    const fuse = (pr.fuse[i] ?? 0) - SIM_DT;
    pr.fuse[i] = fuse;
    if (fuse <= 0) {
      detonate(world, i);
      continue;
    }

    let posX = pr.posX[i] ?? 0;
    let posY = pr.posY[i] ?? 0;
    let velX = pr.velX[i] ?? 0;
    let velY = pr.velY[i] ?? 0;
    const detonateOnImpact = isGrenade ? false : (def?.detonateOnImpact ?? true);
    let exploded = false;

    // --- Ballistics ---
    // A settled grenade (velY zeroed, floor directly beneath) stops feeling
    // gravity; otherwise the 0.35 m/s per-tick pull re-collides it every tick
    // and each contact spams a bounce event (review finding, M1).
    const gravityFactor = isGrenade ? g.gravityFactor : (def?.gravityFactor ?? 0);
    const resting =
      velY === 0 && isSolid(world.map, Math.floor(posX), Math.floor(posY + SETTLE_PROBE));
    if (gravityFactor > 0 && !resting) {
      velY += TUNING.player.gravity * gravityFactor * SIM_DT;
    }
    if (resting && Math.abs(velX) < SETTLE_SPEED) velX = 0;

    // X axis
    const nextX = posX + velX * SIM_DT;
    if (velX !== 0 && isSolid(world.map, Math.floor(nextX), Math.floor(posY))) {
      if (detonateOnImpact) {
        detonate(world, i);
        exploded = true;
      } else {
        const impactSpeed = Math.abs(velX);
        velX = -velX * g.restitution;
        velY *= g.bounceFriction;
        if (Math.abs(velX) < SETTLE_SPEED) velX = 0;
        if (impactSpeed >= SETTLE_SPEED) {
          world.events.emit(SimEventType.GrenadeBounce, i, 0, posX, posY);
        }
      }
    } else {
      posX = nextX;
    }
    if (exploded) continue;

    // Y axis
    const nextY = posY + velY * SIM_DT;
    if (velY !== 0 && isSolid(world.map, Math.floor(posX), Math.floor(nextY))) {
      if (detonateOnImpact) {
        detonate(world, i);
        exploded = true;
      } else {
        const impactSpeed = Math.abs(velY);
        velY = -velY * g.restitution;
        velX *= g.bounceFriction;
        // Settle instead of micro-bouncing forever.
        if (Math.abs(velY) < SETTLE_SPEED) velY = 0;
        if (impactSpeed >= SETTLE_SPEED) {
          world.events.emit(SimEventType.GrenadeBounce, i, 0, posX, posY);
        }
      }
    } else {
      posY = nextY;
    }
    if (exploded) continue;

    pr.posX[i] = posX;
    pr.posY[i] = posY;
    pr.velX[i] = velX;
    pr.velY[i] = velY;

    // --- Direct player contact (impact projectiles only, never the owner) ---
    if (detonateOnImpact) {
      for (let t = 0; t < MAX_PLAYERS; t++) {
        if (t === pr.owner[i] || p.connected[t] !== 1 || p.status[t] !== 1) continue;
        if (pointToAabbDistance(posX, posY, p.posX[t] ?? 0, p.posY[t] ?? 0, halfW, halfH) > 0) {
          continue;
        }
        const direct = def?.directDamage ?? 0;
        if (direct > 0) {
          const dirX = Math.cos(Math.atan2(velY, velX));
          const dirY = Math.sin(Math.atan2(velY, velX));
          world.damage.push(t, direct, pr.owner[i] ?? -1, dirX * 2, dirY * 2);
          world.events.emit(SimEventType.HitConfirmed, pr.owner[i] ?? -1, t, posX, posY);
        }
        detonate(world, i);
        break;
      }
    }
  }
}

/** Explode (or fizzle) a projectile and free its slot. */
function detonate(world: SimWorld, index: number): void {
  const pr = world.projectiles;
  pr.alive[index] = 0;

  const posX = pr.posX[index] ?? 0;
  const posY = pr.posY[index] ?? 0;
  const owner = pr.owner[index] ?? -1;

  if ((pr.kind[index] as ProjectileKind) === ProjectileKind.FragGrenade) {
    const g = TUNING.grenade;
    explode(world, posX, posY, g.radius, g.damage, g.knockback, owner, -1);
    return;
  }

  const def = weaponDef((pr.weapon[index] ?? 0) as WeaponId);
  const splash = def.projectile?.splash;
  if (splash !== undefined) {
    explode(world, posX, posY, splash.radius, splash.maxDamage, splash.knockback, owner, def.id);
  }
}
