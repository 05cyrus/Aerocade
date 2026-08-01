import { describe, expect, it } from 'vitest';
import { SIM_DT, TUNING } from '../src/index.js';
import { addCombatant, Buttons, createTestWorld, run, stage, teleport } from './helpers.js';

describe('gravity and ground collision', () => {
  it('drops a player onto the floor and grounds them', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    teleport(world, p, 10, 4);
    run(world, 180); // 3 seconds is plenty to land
    const feet = (world.players.posY[p] ?? 0) + TUNING.player.height / 2;
    expect(feet).toBeCloseTo(11, 2); // floor top of the box room is y=11
    expect(world.players.grounded[p]).toBe(1);
    expect(world.players.velY[p]).toBe(0);
  });

  it('never tunnels through the floor even at the hard speed cap', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    teleport(world, p, 10, 8);
    world.players.velY[p] = TUNING.player.hardSpeedCap * 2; // absurd downward speed
    run(world, 60);
    // Center stays above the floor top (y=11): the box never entered the tiles.
    expect(world.players.posY[p] ?? 0).toBeLessThan(11 - TUNING.player.height / 2 + 0.01);
    expect(world.players.grounded[p]).toBe(1);
  });

  it('stops at walls without entering them', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    teleport(world, p, 2, 9);
    stage(world, p, { moveX: -1 });
    run(world, 120);
    const left = (world.players.posX[p] ?? 0) - TUNING.player.width / 2;
    expect(left).toBeGreaterThanOrEqual(1); // wall face at x=1
    expect(left).toBeLessThan(1.05);
  });
});

describe('running and walking', () => {
  it('reaches run speed but never exceeds it', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30); // settle on ground
    stage(world, p, { moveX: 1 });
    run(world, 90);
    expect(world.players.velX[p] ?? 0).toBeCloseTo(TUNING.player.runSpeed, 5);
  });

  it('caps at walk speed with the walk modifier', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { moveX: 1, buttons: Buttons.Walk });
    run(world, 90);
    expect(world.players.velX[p] ?? 0).toBeCloseTo(TUNING.player.walkSpeed, 5);
  });

  it('friction stops a running player when input ceases', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { moveX: 1 });
    run(world, 60);
    stage(world, p, {});
    run(world, 60);
    expect(Math.abs(world.players.velX[p] ?? 0)).toBeLessThan(1e-9);
  });
});

describe('jumping', () => {
  it('jump press launches upward from the ground', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Jump });
    run(world, 1);
    expect(world.players.velY[p] ?? 0).toBeLessThan(0);
    expect(world.players.grounded[p]).toBe(0);
  });

  it('holding jump does not re-jump without a release (edge-triggered)', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Jump });
    run(world, 120); // full arc while holding: lands, must NOT bounce again
    expect(world.players.grounded[p]).toBe(1);
    expect(world.players.velY[p]).toBe(0);
  });

  it('released jump rises less than held jump (variable height)', () => {
    const heightAfter = (holdTicks: number): number => {
      const world = createTestWorld();
      const p = addCombatant(world);
      run(world, 30);
      stage(world, p, { buttons: Buttons.Jump });
      run(world, holdTicks);
      stage(world, p, {});
      run(world, 40 - holdTicks);
      return world.players.posY[p] ?? 0;
    };
    // y grows downward: higher jump = smaller y.
    expect(heightAfter(30)).toBeLessThan(heightAfter(2));
  });
});

describe('jetpack', () => {
  it('thrust lifts against gravity and burns fuel', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    const fuelBefore = world.players.fuel[p] ?? 0;
    const yBefore = world.players.posY[p] ?? 0;
    stage(world, p, { buttons: Buttons.Thrust });
    run(world, 60);
    expect(world.players.posY[p] ?? 0).toBeLessThan(yBefore - 1);
    expect(world.players.fuel[p] ?? 0).toBeLessThan(fuelBefore);
  });

  it('climb speed is capped at maxRiseSpeed', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Thrust });
    run(world, 45);
    expect(-(world.players.velY[p] ?? 0)).toBeLessThanOrEqual(TUNING.jetpack.maxRiseSpeed + 1e-9);
  });

  it('fuel regenerates only after the regen delay', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Thrust });
    run(world, 30);
    stage(world, p, {});
    const fuelAtRelease = world.players.fuel[p] ?? 0;
    const delayTicks = Math.floor(TUNING.jetpack.regenDelay / SIM_DT) - 2;
    run(world, delayTicks);
    expect(world.players.fuel[p] ?? 0).toBeCloseTo(fuelAtRelease, 5);
    run(world, 60);
    expect(world.players.fuel[p] ?? 0).toBeGreaterThan(fuelAtRelease);
  });

  it('runs dry: thrust stops working at zero fuel', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    stage(world, p, { buttons: Buttons.Thrust });
    const burnAll = Math.ceil(TUNING.jetpack.maxFuel / TUNING.jetpack.burnRate / SIM_DT) + 30;
    run(world, burnAll);
    expect(world.players.fuel[p]).toBe(0);
    // With no fuel and holding thrust, the player falls back to the floor.
    run(world, 240);
    expect(world.players.grounded[p]).toBe(1);
  });

  it('hover (thrust + down) holds altitude and burns less fuel than climbing', () => {
    const world = createTestWorld();
    const p = addCombatant(world);
    run(world, 30);
    // Climb for half a second, then switch to hover.
    stage(world, p, { buttons: Buttons.Thrust });
    run(world, 30);
    const climbBurn = TUNING.jetpack.maxFuel - (world.players.fuel[p] ?? 0);
    expect(climbBurn).toBeCloseTo(TUNING.jetpack.burnRate * 0.5, 1);

    stage(world, p, { buttons: Buttons.Thrust, moveY: 1 });
    run(world, 60); // vertical speed settles to zero
    const yStart = world.players.posY[p] ?? 0;
    const fuelStart = world.players.fuel[p] ?? 0;
    run(world, 60);
    expect(Math.abs((world.players.posY[p] ?? 0) - yStart)).toBeLessThan(0.05); // holds altitude
    const hoverBurn = fuelStart - (world.players.fuel[p] ?? 0);
    expect(hoverBurn).toBeCloseTo(TUNING.jetpack.hoverBurnRate * 1, 1);
    expect(hoverBurn).toBeLessThan(TUNING.jetpack.burnRate * 1);
  });
});
