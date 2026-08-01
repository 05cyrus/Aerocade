import { MAX_PLAYERS, SIM_DT, WEAPON_SLOTS } from '../../constants.js';
import { angleDelta } from '../../math/scalar.js';
import { SimEventType } from '../events.js';
import { rayVsAabb, raycastTiles, aabbOverlapsSolid } from '../geometry.js';
import { Buttons } from '../input.js';
import { weaponDef, type WeaponDef, type WeaponId } from '../combat/weapon-defs.js';
import { TUNING } from '../tuning.js';
import { ProjectileKind, type SimWorld } from '../world.js';

/**
 * Fire control: cooldowns, reload, weapon switching, hitscan and projectile
 * firing, melee, and grenade throws. Damage is queued, never applied here —
 * the damage system owns health so ordering stays deterministic.
 */
export function weaponsSystem(world: SimWorld): void {
  const p = world.players;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1 || p.status[i] !== 1) continue;

    const cmd = world.inputs[i];
    if (cmd === undefined) continue;
    const prev = p.prevButtons[i] ?? 0;
    const held = cmd.buttons;
    const pressed = held & ~prev;

    const slot = p.weaponSlot[i] ?? 0;
    const slotIndex = i * WEAPON_SLOTS + slot;
    const def = weaponDef((p.weapons[slotIndex] ?? 0) as WeaponId);

    // --- Timers ---
    if ((p.cooldown[i] ?? 0) > 0) p.cooldown[i] = Math.max(0, (p.cooldown[i] ?? 0) - SIM_DT);
    if ((p.meleeCooldown[i] ?? 0) > 0) {
      p.meleeCooldown[i] = Math.max(0, (p.meleeCooldown[i] ?? 0) - SIM_DT);
    }
    if ((p.bloom[i] ?? 0) > 0 && def.bloomDecay > 0) {
      p.bloom[i] = Math.max(0, (p.bloom[i] ?? 0) - def.bloomDecay * SIM_DT);
    }

    // --- Reload completion ---
    if ((p.reload[i] ?? 0) > 0) {
      const left = (p.reload[i] ?? 0) - SIM_DT;
      p.reload[i] = Math.max(0, left);
      if (left <= 0) {
        const mag = p.ammoMag[slotIndex] ?? 0;
        const reserve = p.ammoReserve[slotIndex] ?? 0;
        const moved = Math.min(def.magSize - mag, reserve);
        p.ammoMag[slotIndex] = mag + moved;
        p.ammoReserve[slotIndex] = reserve - moved;
      }
    }

    // --- Weapon switch (cancels reload, imposes a short delay) ---
    if ((pressed & Buttons.SwitchWeapon) !== 0) {
      p.weaponSlot[i] = (slot + 1) % WEAPON_SLOTS;
      p.reload[i] = 0;
      p.bloom[i] = 0;
      p.cooldown[i] = Math.max(p.cooldown[i] ?? 0, TUNING.combat.switchDelay);
    }

    // Re-read the (possibly switched) active weapon for firing.
    const activeSlot = p.weaponSlot[i] ?? 0;
    const activeIndex = i * WEAPON_SLOTS + activeSlot;
    const activeDef = weaponDef((p.weapons[activeIndex] ?? 0) as WeaponId);

    // --- Manual reload ---
    if ((pressed & Buttons.Reload) !== 0 && (p.reload[i] ?? 0) === 0) {
      const mag = p.ammoMag[activeIndex] ?? 0;
      const reserve = p.ammoReserve[activeIndex] ?? 0;
      if (mag < activeDef.magSize && reserve > 0) {
        p.reload[i] = activeDef.reloadTime;
        world.events.emit(
          SimEventType.ReloadStart,
          i,
          activeDef.id,
          p.posX[i] ?? 0,
          p.posY[i] ?? 0,
        );
      }
    }

    // --- Fire ---
    const wantsFire = activeDef.auto ? (held & Buttons.Fire) !== 0 : (pressed & Buttons.Fire) !== 0;
    if (wantsFire && (p.reload[i] ?? 0) === 0 && (p.cooldown[i] ?? 0) === 0) {
      const mag = p.ammoMag[activeIndex] ?? 0;
      if (mag <= 0) {
        // Any empty fire request starts the reload (holding the trigger on an
        // auto weapon must not stall the gun); the dry-fire *sound* stays
        // edge-triggered so it clicks once instead of buzzing.
        if ((pressed & Buttons.Fire) !== 0) {
          world.events.emit(SimEventType.DryFire, i, activeDef.id, p.posX[i] ?? 0, p.posY[i] ?? 0);
        }
        const reserve = p.ammoReserve[activeIndex] ?? 0;
        if (reserve > 0) {
          p.reload[i] = activeDef.reloadTime;
          world.events.emit(
            SimEventType.ReloadStart,
            i,
            activeDef.id,
            p.posX[i] ?? 0,
            p.posY[i] ?? 0,
          );
        }
      } else {
        fireWeapon(world, i, activeIndex, activeDef);
      }
    }

    // --- Melee ---
    if ((pressed & Buttons.Melee) !== 0 && (p.meleeCooldown[i] ?? 0) === 0) {
      p.meleeCooldown[i] = TUNING.melee.cycleTime;
      p.protect[i] = 0;
      meleeStrike(world, i);
    }

    // --- Grenade ---
    if ((pressed & Buttons.Grenade) !== 0 && (p.grenades[i] ?? 0) > 0) {
      p.grenades[i] = (p.grenades[i] ?? 0) - 1;
      p.protect[i] = 0;
      throwFragGrenade(world, i);
    }
  }
}

function fireWeapon(world: SimWorld, shooter: number, ammoIndex: number, def: WeaponDef): void {
  const p = world.players;
  const originX = p.posX[shooter] ?? 0;
  const originY = p.posY[shooter] ?? 0;
  const aim = p.aim[shooter] ?? 0;

  p.ammoMag[ammoIndex] = (p.ammoMag[ammoIndex] ?? 0) - 1;
  p.cooldown[shooter] = def.cycleTime;
  p.protect[shooter] = 0; // firing forfeits spawn protection

  world.events.emit(SimEventType.Shot, shooter, def.id, originX, originY);

  if (def.category === 'hitscan') {
    for (let pellet = 0; pellet < def.pellets; pellet++) {
      const spread = def.spread + (p.bloom[shooter] ?? 0);
      const angle = aim + (spread > 0 ? world.rng.spread(spread) : 0);
      fireHitscanRay(world, shooter, originX, originY, angle, def);
    }
    p.bloom[shooter] = Math.min(def.bloomMax, (p.bloom[shooter] ?? 0) + def.bloomPerShot);
  } else if (def.projectile !== undefined) {
    const spread = def.spread;
    const angle = aim + (spread > 0 ? world.rng.spread(spread) : 0);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    spawnProjectile(
      world,
      shooter,
      ProjectileKind.Weapon,
      def.id,
      originX,
      originY,
      dirX,
      dirY,
      def.projectile.speed,
      def.projectile.fuse,
      0,
      0,
    );
  }

  // Recoil pushes opposite the aim direction.
  p.velX[shooter] = (p.velX[shooter] ?? 0) - Math.cos(aim) * def.recoilKick;
  p.velY[shooter] = (p.velY[shooter] ?? 0) - Math.sin(aim) * def.recoilKick;
}

function fireHitscanRay(
  world: SimWorld,
  shooter: number,
  originX: number,
  originY: number,
  angle: number,
  def: WeaponDef,
): void {
  const p = world.players;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const halfW = TUNING.player.width / 2;
  const halfH = TUNING.player.height / 2;

  const wallDist = raycastTiles(world.map, originX, originY, dirX, dirY, def.range);

  let hitPlayer = -1;
  let hitDist = wallDist;
  for (let t = 0; t < MAX_PLAYERS; t++) {
    if (t === shooter || p.connected[t] !== 1 || p.status[t] !== 1) continue;
    const d = rayVsAabb(originX, originY, dirX, dirY, p.posX[t] ?? 0, p.posY[t] ?? 0, halfW, halfH);
    if (d < hitDist) {
      hitDist = d;
      hitPlayer = t;
    }
  }

  const endX = originX + dirX * hitDist;
  const endY = originY + dirY * hitDist;
  world.events.emit(SimEventType.Trace, shooter, def.id, endX, endY);

  if (hitPlayer === -1) return;

  // Linear damage falloff from falloffStart to range.
  let damage = def.damage;
  if (hitDist > def.falloffStart && def.range > def.falloffStart) {
    const f = (hitDist - def.falloffStart) / (def.range - def.falloffStart);
    const minFrac = TUNING.combat.falloffMinDamageFrac;
    damage *= 1 - (1 - minFrac) * Math.min(1, f);
  }

  const impulse = damage * TUNING.combat.hitscanKnockbackPerDamage * def.knockbackMult;
  world.damage.push(hitPlayer, damage, shooter, dirX * impulse, dirY * impulse);
  world.events.emit(SimEventType.HitConfirmed, shooter, hitPlayer, endX, endY);
}

function meleeStrike(world: SimWorld, attacker: number): void {
  const p = world.players;
  const m = TUNING.melee;
  const originX = p.posX[attacker] ?? 0;
  const originY = p.posY[attacker] ?? 0;
  const aim = p.aim[attacker] ?? 0;
  const halfW = TUNING.player.width / 2;
  const halfH = TUNING.player.height / 2;

  let connected = 0;
  for (let t = 0; t < MAX_PLAYERS; t++) {
    if (t === attacker || p.connected[t] !== 1 || p.status[t] !== 1) continue;
    const tx = p.posX[t] ?? 0;
    const ty = p.posY[t] ?? 0;
    const dist = Math.hypot(tx - originX, ty - originY) - Math.min(halfW, halfH);
    if (dist > m.range) continue;
    const toTarget = Math.atan2(ty - originY, tx - originX);
    if (Math.abs(angleDelta(aim, toTarget)) > m.halfArc) continue;

    const dirX = Math.cos(toTarget);
    const dirY = Math.sin(toTarget);
    world.damage.push(t, m.damage, attacker, dirX * m.knockback, dirY * m.knockback);
    connected = 1;
  }
  world.events.emit(SimEventType.MeleeSwing, attacker, connected, originX, originY);
}

function throwFragGrenade(world: SimWorld, thrower: number): void {
  const p = world.players;
  const g = TUNING.grenade;
  const aim = p.aim[thrower] ?? 0;
  const dirX = Math.cos(aim);
  const dirY = Math.sin(aim);
  const inheritX = (p.velX[thrower] ?? 0) * g.velocityInherit;
  const inheritY = (p.velY[thrower] ?? 0) * g.velocityInherit;

  spawnProjectile(
    world,
    thrower,
    ProjectileKind.FragGrenade,
    0,
    p.posX[thrower] ?? 0,
    p.posY[thrower] ?? 0,
    dirX,
    dirY,
    g.throwSpeed,
    g.fuse,
    inheritX,
    inheritY,
  );
  world.events.emit(
    SimEventType.GrenadeThrow,
    thrower,
    0,
    p.posX[thrower] ?? 0,
    p.posY[thrower] ?? 0,
  );
}

function spawnProjectile(
  world: SimWorld,
  owner: number,
  kind: ProjectileKind,
  weapon: number,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  speed: number,
  fuse: number,
  extraVelX: number,
  extraVelY: number,
): void {
  const idx = world.projectiles.findFree();
  if (idx === -1) return; // pool saturated: the shot fizzles rather than allocating

  // Nudge the spawn point out of the shooter, but never into a wall.
  let posX = originX + dirX * TUNING.combat.muzzleOffset;
  let posY = originY + dirY * TUNING.combat.muzzleOffset;
  if (aabbOverlapsSolid(world.map, posX, posY, 0.05, 0.05)) {
    posX = originX;
    posY = originY;
  }

  const pr = world.projectiles;
  pr.alive[idx] = 1;
  pr.kind[idx] = kind;
  pr.weapon[idx] = weapon;
  pr.owner[idx] = owner;
  pr.posX[idx] = posX;
  pr.posY[idx] = posY;
  pr.velX[idx] = dirX * speed + extraVelX;
  pr.velY[idx] = dirY * speed + extraVelY;
  pr.fuse[idx] = fuse;
}
