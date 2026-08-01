import { describe, expect, it } from 'vitest';
import {
  damageSystem,
  NO_PLAYER,
  SIM_DT,
  SimEventType,
  TUNING,
  WeaponId,
  weaponDef,
} from '../src/index.js';
import { addCombatant, Buttons, createTestWorld, run, stage, teleport } from './helpers.js';

describe('spawn protection', () => {
  it('absorbs damage while active and expires on schedule', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 10);
    teleport(world, a, 4, 9.1);
    teleport(world, b, 10, 9.1);
    world.players.protect[b] = TUNING.player.spawnProtection;

    stage(world, a, { buttons: Buttons.Fire, aim: 0 });
    run(world, 1);
    expect(world.players.health[b]).toBe(TUNING.player.maxHealth); // protected

    stage(world, a, {});
    run(world, Math.ceil(TUNING.player.spawnProtection / SIM_DT) + 2);
    // Both settled onto the floor meanwhile; realign them for the second shot.
    teleport(world, a, 4, 9.1);
    teleport(world, b, 10, 9.1);
    stage(world, a, { buttons: Buttons.Fire, aim: 0 });
    run(world, 1);
    expect(world.players.health[b] ?? 0).toBeLessThan(TUNING.player.maxHealth);
  });
});

describe('death, scoring, and respawn', () => {
  it('killing credits the killer and respawns the victim after the delay', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 10);
    teleport(world, a, 4, 9.1);
    teleport(world, b, 10, 9.1);
    world.players.protect[b] = 0;
    world.players.health[b] = 1;

    stage(world, a, { buttons: Buttons.Fire, aim: 0 });
    run(world, 1);

    expect(world.players.status[b]).toBe(0);
    expect(world.players.deaths[b]).toBe(1);
    expect(world.players.kills[a]).toBe(1);
    expect(world.players.score[a]).toBe(TUNING.match.killScore);

    let deathSeen = false;
    world.events.forEach((ev) => {
      if (ev.type === SimEventType.Death && ev.a === b && ev.b === a) deathSeen = true;
    });
    expect(deathSeen).toBe(true);

    stage(world, a, {});
    run(world, Math.ceil(TUNING.player.respawnDelay / SIM_DT) + 2);
    expect(world.players.status[b]).toBe(1);
    expect(world.players.health[b]).toBe(TUNING.player.maxHealth);
    expect(world.players.protect[b] ?? 0).toBeGreaterThan(0);
    expect(world.players.grenades[b]).toBe(TUNING.player.spawnGrenades);
  });

  it('self-destruction counts a death but credits no kill', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    run(world, 10);
    world.players.health[a] = 5;
    // Fire a rocket point-blank into the floor.
    stage(world, a, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    stage(world, a, {});
    run(world, 20);
    stage(world, a, { buttons: Buttons.Fire, aim: Math.PI / 2 }); // straight down
    run(world, 30);

    expect(world.players.status[a]).toBe(0);
    expect(world.players.deaths[a]).toBe(1);
    expect(world.players.kills[a]).toBe(0);
    expect(world.players.score[a]).toBe(0);
  });
});

describe('projectiles', () => {
  it('rocket explodes on a wall and splashes a nearby player', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 10);
    teleport(world, a, 6, 9.1);
    teleport(world, b, 17.5, 9.1); // standing near the right wall (face at x=19)
    world.players.protect[b] = 0;
    run(world, 5); // both settle onto the floor

    stage(world, a, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    stage(world, a, {});
    run(world, 20);
    // Aim over b's head so the rocket detonates on the wall above them —
    // splash, not a direct hit, is what this test exercises.
    const aimAtWall = Math.atan2(7 - (world.players.posY[a] ?? 0), 19 - (world.players.posX[a] ?? 0));
    stage(world, a, { buttons: Buttons.Fire, aim: aimAtWall });
    run(world, 1);
    stage(world, a, {});

    // Step until the explosion tick, then assert immediately — ground
    // friction would decay the knockback within a few further ticks.
    const def = weaponDef(WeaponId.Thumper);
    const maxTicks = Math.ceil(15 / (def.projectile?.speed ?? 24) / SIM_DT);
    const sawExplosionThisTick = (): boolean => {
      let seen = false;
      world.events.forEach((ev) => {
        if (ev.type === SimEventType.Explosion) seen = true;
      });
      return seen;
    };
    let exploded = false;
    for (let t = 0; t < maxTicks; t++) {
      run(world, 1);
      exploded = sawExplosionThisTick();
      if (exploded) break;
    }
    expect(exploded).toBe(true);
    expect(world.players.health[b] ?? 0).toBeLessThan(TUNING.player.maxHealth);
    expect(world.players.velX[b] ?? 0).toBeLessThan(0); // blasted away from the wall
  });

  it('rocket jumping: a downward rocket launches the shooter upward', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    run(world, 10);
    stage(world, a, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    stage(world, a, {});
    run(world, 20);
    const healthBefore = world.players.health[a] ?? 0;
    stage(world, a, { buttons: Buttons.Fire, aim: Math.PI / 2 });
    run(world, 6); // rocket travels ~0.6 m to the floor and detonates
    expect(world.players.velY[a] ?? 0).toBeLessThan(-3); // strong upward shove
    expect(world.players.health[a] ?? 0).toBeLessThan(healthBefore); // at a health cost
  });

  it('owner is immune to direct hits but not splash', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    run(world, 10);
    stage(world, a, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    stage(world, a, {});
    run(world, 20);
    stage(world, a, { buttons: Buttons.Fire, aim: 0 });
    run(world, 1);
    stage(world, a, {});
    run(world, 2);
    // The rocket spawned inside/near the owner but must not have detonated on them.
    let aliveRockets = 0;
    for (const alive of world.projectiles.alive) {
      if (alive === 1) aliveRockets += 1;
    }
    expect(aliveRockets).toBe(1);
  });
});

describe('damage attribution edge cases', () => {
  it('world damage with a prior attacker credits that attacker', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 10);
    world.players.protect[b] = 0;
    world.players.lastDamageBy[b] = a;
    world.players.health[b] = 5;
    // Inject world damage (a future hazard) and resolve it directly —
    // stepWorld clears the queue at tick start, so drive the system itself.
    world.damage.push(b, 10, NO_PLAYER, 0, 0);
    damageSystem(world);
    expect(world.players.kills[a]).toBe(1);
    expect(world.players.status[b]).toBe(0);
  });
});
