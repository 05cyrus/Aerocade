import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  Buttons,
  createFoundryMap,
  createSnapshot,
  createWorld,
  restoreSnapshot,
  Rng,
  setInput,
  stateHash,
  stepWorld,
  takeSnapshot,
  type SimWorld,
} from '../src/index.js';

/**
 * A deterministic pseudo-player input script: chaotic enough to exercise
 * movement, jetpack, firing, grenades, and deaths, driven by a seeded Rng
 * that is *separate* from the world's (scripts are "user input").
 */
function scriptInputs(world: SimWorld, rng: Rng, playerCount: number): void {
  for (let p = 0; p < playerCount; p++) {
    let buttons = 0;
    if (rng.float() < 0.7) buttons |= Buttons.Fire;
    if (rng.float() < 0.4) buttons |= Buttons.Thrust;
    if (rng.float() < 0.1) buttons |= Buttons.Jump;
    if (rng.float() < 0.05) buttons |= Buttons.Grenade;
    if (rng.float() < 0.03) buttons |= Buttons.SwitchWeapon;
    if (rng.float() < 0.03) buttons |= Buttons.Reload;
    if (rng.float() < 0.05) buttons |= Buttons.Melee;
    setInput(world, p, {
      seq: world.tick,
      moveX: rng.float() < 0.5 ? -1 : 1,
      moveY: 0,
      aim: rng.range(-Math.PI, Math.PI),
      buttons,
    });
  }
}

function buildWorld(seed: number, players: number): SimWorld {
  const world = createWorld(createFoundryMap(), seed);
  for (let i = 0; i < players; i++) addPlayer(world);
  return world;
}

describe('determinism', () => {
  it('same seed + same inputs => identical state hash after 600 ticks', () => {
    const a = buildWorld(99, 4);
    const b = buildWorld(99, 4);
    const scriptA = new Rng(7);
    const scriptB = new Rng(7);

    for (let t = 0; t < 600; t++) {
      scriptInputs(a, scriptA, 4);
      scriptInputs(b, scriptB, 4);
      stepWorld(a);
      stepWorld(b);
      if (stateHash(a) !== stateHash(b)) {
        throw new Error(`state diverged at tick ${String(t)}`);
      }
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('different seeds diverge (the hash actually discriminates)', () => {
    const a = buildWorld(1, 2);
    const b = buildWorld(2, 2);
    const script = new Rng(7);
    const script2 = new Rng(7);
    for (let t = 0; t < 120; t++) {
      scriptInputs(a, script, 2);
      scriptInputs(b, script2, 2);
      stepWorld(a);
      stepWorld(b);
    }
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

describe('snapshot / restore', () => {
  it('restoring a snapshot and replaying reproduces the exact same future', () => {
    const world = buildWorld(555, 3);
    const script = new Rng(42);

    // Advance 120 ticks, snapshot, record the input stream for 120 more.
    for (let t = 0; t < 120; t++) {
      scriptInputs(world, script, 3);
      stepWorld(world);
    }
    const snap = takeSnapshot(world, createSnapshot());

    const replayScriptState = script.state;
    for (let t = 0; t < 120; t++) {
      scriptInputs(world, script, 3);
      stepWorld(world);
    }
    const finalHash = stateHash(world);

    // Rewind and replay the identical inputs.
    restoreSnapshot(world, snap);
    const replayScript = new Rng(0);
    replayScript.state = replayScriptState;
    for (let t = 0; t < 120; t++) {
      scriptInputs(world, replayScript, 3);
      stepWorld(world);
    }
    expect(stateHash(world)).toBe(finalHash);
  });

  it('snapshot captures state at the exact tick (rewind changes nothing)', () => {
    const world = buildWorld(31337, 2);
    const script = new Rng(9);
    for (let t = 0; t < 60; t++) {
      scriptInputs(world, script, 2);
      stepWorld(world);
    }
    const hashBefore = stateHash(world);
    const snap = takeSnapshot(world, createSnapshot());
    restoreSnapshot(world, snap);
    expect(stateHash(world)).toBe(hashBefore);
    expect(world.tick).toBe(60);
  });
});
