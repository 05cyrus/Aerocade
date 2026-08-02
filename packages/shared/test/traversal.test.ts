import { describe, expect, it } from 'vitest';
import { SIM_DT, TUNING, createMatch, parseAsciiMap, type SimWorld } from '../src/index.js';
import { addCombatant, Buttons, run, stage, teleport } from './helpers.js';

/**
 * A tower room: a ladder up the left, a one-way platform mid-height on the
 * right, floor at row 10.
 *
 *      col 3 = ladder, rows 2..9 ; platform row 5, cols 7..11
 */
function tower(): SimWorld {
  const rows = [
    '################',
    '#..............#',
    '#..H...........#',
    '#..H...........#',
    '#..H...........#',
    '#..H...=====...#',
    '#..H...........#',
    '#..H...........#',
    '#..H...........#',
    '#S.H..........S#',
    '################',
  ];
  return createMatch(parseAsciiMap('tower', 'Tower', rows), 5);
}

describe('ladders', () => {
  it('holding up climbs, and gravity is suspended while gripping', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 9);

    stage(world, p, { moveY: -1 }); // press up
    run(world, 30);

    expect(world.players.onLadder[p]).toBe(1);
    expect(world.players.posY[p] ?? 0).toBeLessThan(7); // climbed several metres
  });

  it('does nothing until you actually press up or down', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 5);
    stage(world, p, {}); // just standing in the ladder column
    run(world, 30);
    expect(world.players.onLadder[p]).toBe(0);
    expect(world.players.posY[p] ?? 0).toBeGreaterThan(6); // fell as normal
  });

  it('climbing down works too', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 3);
    stage(world, p, { moveY: -1 });
    run(world, 5);
    const high = world.players.posY[p] ?? 0;
    stage(world, p, { moveY: 1 });
    run(world, 20);
    expect(world.players.posY[p] ?? 0).toBeGreaterThan(high);
  });

  it('you can shoot while climbing', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 6);
    const slotIndex = p * 2 + (world.players.weaponSlot[p] ?? 0);
    const before = world.players.ammoMag[slotIndex] ?? 0;

    stage(world, p, { moveY: -1, buttons: Buttons.Fire, aim: 0 });
    run(world, 10);

    expect(world.players.onLadder[p]).toBe(1); // still climbing
    expect(world.players.ammoMag[slotIndex] ?? 0).toBeLessThan(before); // and firing
  });

  it('jumping off releases the ladder and pushes clear', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 6);
    stage(world, p, { moveY: -1 });
    run(world, 6);
    expect(world.players.onLadder[p]).toBe(1);

    stage(world, p, { moveY: -1, moveX: 1, buttons: Buttons.Jump });
    run(world, 1);
    expect(world.players.onLadder[p]).toBe(0);
    expect(world.players.velY[p] ?? 0).toBeLessThan(0); // launched upward
    expect(world.players.velX[p] ?? 0).toBeGreaterThan(0); // and sideways, clear

    // The regrip delay stops it re-attaching on the very next tick.
    run(world, 2);
    expect(world.players.onLadder[p]).toBe(0);
  });

  it('stepping off the ladder column lets go', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 3.5, 6);
    stage(world, p, { moveY: -1 });
    run(world, 5);
    expect(world.players.onLadder[p]).toBe(1);
    teleport(world, p, 10, 6);
    run(world, 2);
    expect(world.players.onLadder[p]).toBe(0);
  });
});

describe('one-way platforms', () => {
  it('catches a falling player on top', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 9, 2);
    stage(world, p, {});
    run(world, 60);
    const feet = (world.players.posY[p] ?? 0) + TUNING.player.height / 2;
    expect(feet).toBeCloseTo(5, 1); // resting on the platform at row 5
    expect(world.players.grounded[p]).toBe(1);
  });

  it('lets a player jump up through it from below', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 9, 9);
    run(world, 10); // settle on the floor

    // Jetpack straight up through the platform.
    stage(world, p, { buttons: Buttons.Thrust });
    run(world, 45);
    expect(world.players.posY[p] ?? 0).toBeLessThan(4.5); // above the platform
  });

  it('does not block horizontal movement', () => {
    const world = tower();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 6, 4.1); // level with the platform row, just left of it
    stage(world, p, { moveX: 1, buttons: Buttons.Thrust });
    run(world, 30);
    expect(world.players.posX[p] ?? 0).toBeGreaterThan(8);
  });
});

describe('health and ammo pickups', () => {
  function room(marker: string): SimWorld {
    return createMatch(
      parseAsciiMap('pk', 'Pickup', [
        '##########',
        '#........#',
        '#........#',
        `#..S.${marker}..S#`,
        '##########',
      ]),
      11,
    );
  }

  it('a health box heals on contact, with no button', () => {
    const world = room('+');
    const p = addCombatant(world);
    run(world, 10);
    world.players.health[p] = 20;
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    stage(world, p, {});
    run(world, 2);
    expect(world.players.health[p] ?? 0).toBeGreaterThan(20);
  });

  it('a full-health player leaves the box alone', () => {
    const world = room('+');
    const p = addCombatant(world);
    run(world, 10);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    stage(world, p, {});
    run(world, 30);
    const slot = world.pads.pickup[0] ?? -1;
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(world.pickups.alive[slot]).toBe(1); // still there for someone hurt
  });

  it('an ammo box refills reserve ammo on contact', () => {
    const world = room('A');
    const p = addCombatant(world);
    run(world, 10);
    world.players.ammoReserve[p * 2] = 0;
    world.players.ammoReserve[p * 2 + 1] = 0;
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    stage(world, p, {});
    run(world, 2);
    expect(world.players.ammoReserve[p * 2] ?? 0).toBeGreaterThan(0);
  });

  it('pads refill on their own cooldown', () => {
    const world = room('+');
    const p = addCombatant(world);
    run(world, 10);
    world.players.health[p] = 10;
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    run(world, 2);
    const emptied = world.pads.pickup[0] ?? -1;
    expect(emptied).toBe(-1);

    teleport(world, p, 2, pad.y);
    run(world, Math.ceil(TUNING.pickups.healthRespawnDelay / SIM_DT) + 5);
    expect(world.pads.pickup[0] ?? -1).toBeGreaterThanOrEqual(0);
  });
});
