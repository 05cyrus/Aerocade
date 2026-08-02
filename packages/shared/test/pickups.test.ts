import { describe, expect, it } from 'vitest';
import {
  SIM_DT,
  SimEventType,
  TUNING,
  WEAPON_COUNT,
  WEAPON_SLOTS,
  createFoundryMap,
  createMatch,
  parseAsciiMap,
  weaponDef,
  type SimWorld,
  type WeaponId,
} from '../src/index.js';
import { addCombatant, Buttons, run, stage, teleport } from './helpers.js';

/** A flat room with one weapon pad on the floor at tile (5, 3). */
function padRoom(): SimWorld {
  const map = parseAsciiMap('pad', 'Pad', [
    '##########',
    '#........#',
    '#........#',
    '#..S.W..S#',
    '##########',
  ]);
  return createMatch(map, 4242);
}

function countEvents(world: SimWorld, type: number): number {
  let n = 0;
  world.events.forEach((ev) => {
    if (ev.type === type) n += 1;
  });
  return n;
}

/**
 * Stand a player on a pad and tap interact — the sequence a real player
 * performs. Pickup is opt-in (ADR-014), so the press is what collects.
 */
function takePad(world: SimWorld, player: number, pad: { x: number; y: number }): void {
  teleport(world, player, pad.x, pad.y);
  stage(world, player, { buttons: Buttons.Interact });
  run(world, 1);
  stage(world, player, {}); // release, so the next tick is a fresh edge
}

describe('weapon pad placement', () => {
  it('Foundry publishes eight pads, each grounded with headroom', () => {
    const map = createFoundryMap();
    expect(map.weaponPads).toHaveLength(8);
    for (const pad of map.weaponPads) {
      const tx = Math.floor(pad.x);
      const ty = Math.floor(pad.y);
      expect(map.solid[ty * map.width + tx]).toBe(0); // pad tile is open
      expect(map.solid[(ty + 1) * map.width + tx]).toBe(1); // stands on ground
      expect(map.solid[(ty - 1) * map.width + tx]).toBe(0); // reachable
    }
  });

  it('pads are spread across the arena, not clustered', () => {
    const map = createFoundryMap();
    const ys = map.weaponPads.map((p) => p.y);
    // Pads occupy at least four distinct height bands.
    expect(new Set(ys).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(map.height / 2);
  });

  it('rejects a map with more pads than the pickup pool', () => {
    const row = '#' + 'W'.repeat(70) + '#';
    const floor = '#'.repeat(72);
    expect(() =>
      parseAsciiMap('big', 'Big', [floor, '#S' + '.'.repeat(68) + 'S#', row, floor]),
    ).toThrow(/pickup pool/);
  });
});

describe('pad stocking and respawn', () => {
  it('every pad starts stocked with a valid weapon', () => {
    const world = createMatch(createFoundryMap(), 7);
    for (let i = 0; i < world.map.weaponPads.length; i++) {
      expect(world.pickups.active[i]).toBe(1);
      expect(world.pickups.weapon[i]).toBeLessThan(WEAPON_COUNT);
    }
  });

  it('a looted pad stays empty for the respawn delay, then refills', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    expect(world.pickups.active[0]).toBe(0);
    expect(world.pickups.respawnIn[0]).toBeCloseTo(TUNING.pickups.weaponRespawnDelay, 3);

    // Step to just before the delay elapses — still empty.
    teleport(world, p, 2, pad.y);
    const delayTicks = Math.ceil(TUNING.pickups.weaponRespawnDelay / SIM_DT);
    run(world, delayTicks - 2);
    expect(world.pickups.active[0]).toBe(0);

    run(world, 3);
    expect(world.pickups.active[0]).toBe(1);
    expect(countEvents(world, SimEventType.PickupSpawn)).toBeGreaterThan(0);
  });

  it('refills are random: repeated respawns produce more than one weapon', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    const seen = new Set<number>();
    for (let cycle = 0; cycle < 12; cycle++) {
      seen.add(world.pickups.weapon[0] ?? -1);
      takePad(world, p, pad);
      // Fast-forward the refill timer: the delay itself is covered above, so
      // this test spends its ticks on the roll, not on waiting. Use a
      // sub-tick value — respawnIn is Float32, and storing exactly SIM_DT
      // rounds up just enough to push the refill a tick later.
      teleport(world, p, 2, pad.y);
      world.pickups.respawnIn[0] = SIM_DT / 2;
      run(world, 1);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('a refill never repeats the weapon it just held', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    for (let cycle = 0; cycle < 20; cycle++) {
      const before = world.pickups.weapon[0] ?? -1;
      takePad(world, p, pad);
      teleport(world, p, 2, pad.y);
      world.pickups.respawnIn[0] = SIM_DT / 2; // sub-tick fast-forward, as above
      run(world, 1);
      expect(world.pickups.weapon[0]).not.toBe(before);
    }
  });
});

describe('pickup is opt-in', () => {
  it('standing on a pad without pressing interact takes nothing', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    const carried = world.players.weapons[p * WEAPON_SLOTS];

    teleport(world, p, pad.x, pad.y);
    stage(world, p, {}); // loiter on the pad, no interact
    run(world, 120); // two full seconds
    expect(world.pickups.active[0]).toBe(1);
    expect(world.players.weapons[p * WEAPON_SLOTS]).toBe(carried);
    expect(countEvents(world, SimEventType.PickupTaken)).toBe(0);
  });

  it('pressing interact off a pad does nothing', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x + 3, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 5);
    expect(world.pickups.active[0]).toBe(1);
  });

  it('holding interact does not vacuum up the pad when it respawns', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    expect(world.pickups.active[0]).toBe(0);

    // Camp the empty pad with the button held down through the refill.
    teleport(world, p, pad.x, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, Math.ceil(TUNING.pickups.weaponRespawnDelay / SIM_DT) + 30);

    // It respawned and stayed put: a held button is not a fresh press.
    expect(world.pickups.active[0]).toBe(1);
  });

  it('a second tap after a refill does collect', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    world.pickups.respawnIn[0] = SIM_DT / 2; // fast-forward the refill
    teleport(world, p, pad.x, pad.y);
    run(world, 1);
    expect(world.pickups.active[0]).toBe(1);

    takePad(world, p, pad);
    expect(world.pickups.active[0]).toBe(0);
  });
});

describe('collecting a pad', () => {
  it('swaps the active slot and loads it fully', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = (world.pickups.weapon[0] ?? 0) as WeaponId;
    const def = weaponDef(offered);
    // Make sure the pad offers something the player is not already carrying.
    world.players.weapons[p * WEAPON_SLOTS] = (offered + 1) % WEAPON_COUNT;
    world.players.weapons[p * WEAPON_SLOTS + 1] = (offered + 2) % WEAPON_COUNT;
    world.players.weaponSlot[p] = 0;

    takePad(world, p, pad);

    expect(world.players.weapons[p * WEAPON_SLOTS]).toBe(offered);
    expect(world.players.ammoMag[p * WEAPON_SLOTS]).toBe(def.magSize);
    expect(world.players.ammoReserve[p * WEAPON_SLOTS]).toBe(def.reserveMax);
    expect(world.pickups.active[0]).toBe(0);
  });

  it('leaves the other slot untouched', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    const offered = (world.pickups.weapon[0] ?? 0) as WeaponId;
    world.players.weapons[p * WEAPON_SLOTS] = (offered + 1) % WEAPON_COUNT;
    world.players.weapons[p * WEAPON_SLOTS + 1] = (offered + 2) % WEAPON_COUNT;
    world.players.weaponSlot[p] = 0;
    const keep = world.players.weapons[p * WEAPON_SLOTS + 1];

    takePad(world, p, pad);
    expect(world.players.weapons[p * WEAPON_SLOTS + 1]).toBe(keep);
  });

  it('tops up reserve ammo instead of swapping when already carried', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = (world.pickups.weapon[0] ?? 0) as WeaponId;
    const def = weaponDef(offered);
    world.players.weapons[p * WEAPON_SLOTS + 1] = offered; // carried in the OFF slot
    world.players.ammoReserve[p * WEAPON_SLOTS + 1] = 0;
    world.players.weaponSlot[p] = 0;
    const activeBefore = world.players.weapons[p * WEAPON_SLOTS];

    teleport(world, p, pad.x, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);

    expect(world.players.ammoReserve[p * WEAPON_SLOTS + 1]).toBe(def.reserveMax);
    expect(world.players.weapons[p * WEAPON_SLOTS]).toBe(activeBefore); // no swap
    let toppedUp = false;
    world.events.forEach((ev) => {
      if (ev.type === SimEventType.PickupTaken && ev.r === 1) toppedUp = true;
    });
    expect(toppedUp).toBe(true);
  });

  it('only one player can take a pad', () => {
    const world = padRoom();
    const a = addCombatant(world);
    const b = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');

    teleport(world, a, pad.x, pad.y);
    teleport(world, b, pad.x, pad.y);
    stage(world, a, { buttons: Buttons.Interact });
    stage(world, b, { buttons: Buttons.Interact });
    run(world, 1);
    expect(countEvents(world, SimEventType.PickupTaken)).toBe(1);
    expect(world.pickups.active[0]).toBe(0);
  });

  it('a dead player standing on a pad does not collect it', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    world.players.status[p] = 0;
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);
    expect(world.pickups.active[0]).toBe(1);
  });

  it('is not collectable from across the room', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.weaponPads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x + 3, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);
    expect(world.pickups.active[0]).toBe(1);
  });
});
