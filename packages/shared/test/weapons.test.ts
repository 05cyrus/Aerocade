import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADOUT,
  parseAsciiMap,
  SIM_DT,
  SimEventType,
  TUNING,
  WEAPON_SLOTS,
  weaponDef,
} from '../src/index.js';
import { addCombatant, Buttons, createTestWorld, run, stage, teleport } from './helpers.js';

function countEvents(world: ReturnType<typeof createTestWorld>, type: number): number {
  let n = 0;
  world.events.forEach((ev) => {
    if (ev.type === type) n += 1;
  });
  return n;
}

describe('firing', () => {
  it('consumes ammo and honors the cycle time', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const def = weaponDef(DEFAULT_LOADOUT[0]);
    const slotIndex = p * WEAPON_SLOTS;
    const magBefore = world.players.ammoMag[slotIndex] ?? 0;

    stage(world, p, { buttons: Buttons.Fire, aim: 0 });
    const ticks = 60;
    run(world, ticks);
    // Cooldowns are tick-quantized: a cycle takes ceil(cycleTime / dt) ticks.
    const cycleTicks = Math.ceil(def.cycleTime / SIM_DT);
    const expectedShots = Math.min(magBefore, 1 + Math.floor((ticks - 1) / cycleTicks));
    expect(magBefore - (world.players.ammoMag[slotIndex] ?? 0)).toBe(expectedShots);
  });

  it('semi-auto weapons fire once per press', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    // Switch to slot 1 (Thumper — semi-auto).
    stage(world, p, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    stage(world, p, {});
    run(world, 30); // let the switch delay lapse
    const slotIndex = p * WEAPON_SLOTS + 1;
    const magBefore = world.players.ammoMag[slotIndex] ?? 0;
    stage(world, p, { buttons: Buttons.Fire });
    run(world, 50); // held the whole time
    expect(magBefore - (world.players.ammoMag[slotIndex] ?? 0)).toBe(1);
  });

  it('applies recoil opposite the aim direction', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Fire, aim: 0 }); // firing right
    run(world, 1);
    expect(world.players.velX[p] ?? 0).toBeLessThan(0); // kicked left
  });

  it('firing forfeits spawn protection', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    world.players.protect[p] = 2;
    stage(world, p, { buttons: Buttons.Fire });
    run(world, 1);
    expect(world.players.protect[p]).toBe(0);
  });
});

describe('reload', () => {
  it('manual reload refills the magazine from reserve', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const def = weaponDef(DEFAULT_LOADOUT[0]);
    const slotIndex = p * WEAPON_SLOTS;
    world.players.ammoMag[slotIndex] = 3;

    stage(world, p, { buttons: Buttons.Reload });
    run(world, 1);
    expect(world.players.reload[p] ?? 0).toBeGreaterThan(0);
    run(world, Math.ceil(def.reloadTime / SIM_DT) + 2);
    expect(world.players.ammoMag[slotIndex]).toBe(def.magSize);
    expect(world.players.ammoReserve[slotIndex]).toBe(def.reserveMax - (def.magSize - 3));
  });

  it('dry fire auto-starts a reload', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const slotIndex = p * WEAPON_SLOTS;
    world.players.ammoMag[slotIndex] = 0;
    stage(world, p, { buttons: Buttons.Fire });
    run(world, 1);
    expect(countEvents(world, SimEventType.DryFire)).toBe(1);
    expect(world.players.reload[p] ?? 0).toBeGreaterThan(0);
  });

  it('switching weapons cancels an active reload', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const slotIndex = p * WEAPON_SLOTS;
    world.players.ammoMag[slotIndex] = 0;
    stage(world, p, { buttons: Buttons.Reload });
    run(world, 1);
    expect(world.players.reload[p] ?? 0).toBeGreaterThan(0);
    stage(world, p, { buttons: Buttons.SwitchWeapon });
    run(world, 1);
    expect(world.players.reload[p]).toBe(0);
    expect(world.players.weaponSlot[p]).toBe(1);
  });
});

describe('hitscan combat', () => {
  it('damages a target straight down-range and knocks it back', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 30);
    teleport(world, a, 4, 9.1);
    teleport(world, b, 10, 9.1);
    world.players.protect[b] = 0;

    stage(world, a, { buttons: Buttons.Fire, aim: 0 }); // aim right at b
    run(world, 1);
    expect(world.players.health[b] ?? 0).toBeLessThan(TUNING.player.maxHealth);
    expect(world.players.velX[b] ?? 0).toBeGreaterThan(0); // pushed away
  });

  it('walls block hitscan', () => {
    const walledRoom = parseAsciiMap('walled', 'Walled', [
      '####################',
      '#........#.........#',
      '#........#.........#',
      '#..S.....#......S..#',
      '####################',
    ]);
    const world = createTestWorld(walledRoom);
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 10);
    world.players.protect[b] = 0;
    // a stands left of the divider, b to its right; a fires right at b.
    stage(world, a, { buttons: Buttons.Fire, aim: 0 });
    run(world, 1);
    expect(world.players.health[b]).toBe(TUNING.player.maxHealth);
  });
});

describe('melee', () => {
  it('hits an adjacent enemy inside the arc, misses behind', () => {
    const world = createTestWorld();
    const a = addCombatant(world);
    const b = addCombatant(world);
    run(world, 30);
    teleport(world, a, 8, 9.1);
    teleport(world, b, 9, 9.1); // 1 m to the right
    world.players.protect[b] = 0;

    stage(world, a, { buttons: Buttons.Melee, aim: Math.PI }); // facing AWAY
    run(world, 1);
    expect(world.players.health[b]).toBe(TUNING.player.maxHealth);

    run(world, Math.ceil(TUNING.melee.cycleTime / SIM_DT) + 1);
    stage(world, a, {});
    run(world, 1);
    stage(world, a, { buttons: Buttons.Melee, aim: 0 }); // facing the target
    run(world, 1);
    expect(world.players.health[b]).toBe(TUNING.player.maxHealth - TUNING.melee.damage);
  });
});

describe('grenades', () => {
  it('throws, bounces, and detonates after the fuse', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const grenadesBefore = world.players.grenades[p] ?? 0;
    stage(world, p, { buttons: Buttons.Grenade, aim: -Math.PI / 4 }); // up-right
    run(world, 1);
    expect(world.players.grenades[p]).toBe(grenadesBefore - 1);
    expect(countEvents(world, SimEventType.GrenadeThrow)).toBe(1);

    // It must explode within fuse + margin.
    let sawExplosion = false;
    stage(world, p, {});
    for (let t = 0; t < Math.ceil(TUNING.grenade.fuse / SIM_DT) + 5; t++) {
      run(world, 1);
      if (countEvents(world, SimEventType.Explosion) > 0) {
        sawExplosion = true;
        break;
      }
    }
    expect(sawExplosion).toBe(true);
  });
});
