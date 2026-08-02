import { describe, expect, it } from 'vitest';
import {
  PickupKind,
  SIM_DT,
  SimEventType,
  damageSystem,
  TUNING,
  WEAPON_COUNT,
  WEAPON_SLOTS,
  createFoundryMap,
  createMatch,
  findPickupUnderPlayer,
  parseAsciiMap,
  weaponDef,
  WeaponId,
  type SimWorld,
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

/** Is pad `i` currently holding a gun? */
function padStocked(world: SimWorld, i: number): boolean {
  const slot = world.pads.pickup[i] ?? -1;
  return slot >= 0 && world.pickups.alive[slot] === 1;
}

/** Weapon currently on pad `i`, or -1. */
function padWeapon(world: SimWorld, i: number): number {
  const slot = world.pads.pickup[i] ?? -1;
  return slot >= 0 ? (world.pickups.weapon[slot] ?? -1) : -1;
}

/** Count live ground items, optionally only drops (not pad guns). */
function groundItems(world: SimWorld, dropsOnly = false): number {
  let n = 0;
  for (let i = 0; i < world.pickups.alive.length; i++) {
    if (world.pickups.alive[i] !== 1) continue;
    if (dropsOnly && (world.pickups.padIndex[i] ?? -1) >= 0) continue;
    n += 1;
  }
  return n;
}

describe('weapon pad placement', () => {
  it('Foundry publishes eight pads, each grounded with headroom', () => {
    const map = createFoundryMap();
    expect(map.pads).toHaveLength(8);
    for (const pad of map.pads) {
      const tx = Math.floor(pad.x);
      const ty = Math.floor(pad.y);
      expect(map.tiles[ty * map.width + tx]).toBe(0); // pad tile is open
      expect(map.tiles[(ty + 1) * map.width + tx]).toBe(1); // stands on ground
      expect(map.tiles[(ty - 1) * map.width + tx]).toBe(0); // reachable
    }
  });

  it('pads are spread across the arena, not clustered', () => {
    const map = createFoundryMap();
    const ys = map.pads.map((p) => p.y);
    // Pads occupy at least four distinct height bands.
    expect(new Set(ys).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(map.height / 2);
  });

  it('rejects a map with more pads than the pad pool', () => {
    const row = '#' + 'W'.repeat(70) + '#';
    const floor = '#'.repeat(72);
    expect(() =>
      parseAsciiMap('big', 'Big', [floor, '#S' + '.'.repeat(68) + 'S#', row, floor]),
    ).toThrow(/pad pool/);
  });
});

describe('pad stocking and respawn', () => {
  it('every pad starts stocked with a valid weapon', () => {
    const world = createMatch(createFoundryMap(), 7);
    for (let i = 0; i < world.map.pads.length; i++) {
      expect(padStocked(world, i)).toBe(true);
      expect(padWeapon(world, i)).toBeLessThan(WEAPON_COUNT);
    }
  });

  it('a looted pad stays empty for the respawn delay, then refills', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    expect(padStocked(world, 0)).toBe(false);
    expect(world.pads.timer[0]).toBeCloseTo(TUNING.pickups.weaponRespawnDelay, 3);

    // Step to just before the delay elapses — still empty.
    teleport(world, p, 2, pad.y);
    const delayTicks = Math.ceil(TUNING.pickups.weaponRespawnDelay / SIM_DT);
    run(world, delayTicks - 2);
    expect(padStocked(world, 0)).toBe(false);

    run(world, 3);
    expect(padStocked(world, 0)).toBe(true);
    expect(countEvents(world, SimEventType.PickupSpawn)).toBeGreaterThan(0);
  });

  it('refills are random: repeated respawns produce more than one weapon', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    const seen = new Set<number>();
    for (let cycle = 0; cycle < 12; cycle++) {
      seen.add(padWeapon(world, 0));
      takePad(world, p, pad);
      // Fast-forward the refill timer: the delay itself is covered above, so
      // this test spends its ticks on the roll, not on waiting. Use a
      // sub-tick value — respawnIn is Float32, and storing exactly SIM_DT
      // rounds up just enough to push the refill a tick later.
      teleport(world, p, 2, pad.y);
      world.pads.timer[0] = SIM_DT / 2;
      run(world, 1);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('a refill never repeats the weapon it just held', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    for (let cycle = 0; cycle < 20; cycle++) {
      const before = padWeapon(world, 0);
      takePad(world, p, pad);
      teleport(world, p, 2, pad.y);
      world.pads.timer[0] = SIM_DT / 2; // sub-tick fast-forward, as above
      run(world, 1);
      expect(padWeapon(world, 0)).not.toBe(before);
    }
  });
});

describe('pickup is opt-in', () => {
  it('standing on a pad without pressing interact takes nothing', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    const carried = world.players.weapons[p * WEAPON_SLOTS];

    teleport(world, p, pad.x, pad.y);
    stage(world, p, {}); // loiter on the pad, no interact
    run(world, 120); // two full seconds
    expect(padStocked(world, 0)).toBe(true);
    expect(world.players.weapons[p * WEAPON_SLOTS]).toBe(carried);
    expect(countEvents(world, SimEventType.PickupTaken)).toBe(0);
  });

  it('pressing interact off a pad does nothing', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x + 3, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 5);
    expect(padStocked(world, 0)).toBe(true);
  });

  it('holding interact does not vacuum up the pad when it respawns', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    expect(padStocked(world, 0)).toBe(false);

    // Camp the empty pad with the button held down through the refill.
    teleport(world, p, pad.x, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, Math.ceil(TUNING.pickups.weaponRespawnDelay / SIM_DT) + 30);

    // It respawned and stayed put: a held button is not a fresh press.
    expect(padStocked(world, 0)).toBe(true);
  });

  it('a second tap after a refill does collect', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    takePad(world, p, pad);
    world.pads.timer[0] = SIM_DT / 2; // fast-forward the refill
    teleport(world, p, pad.x, pad.y);
    run(world, 1);
    expect(padStocked(world, 0)).toBe(true);

    takePad(world, p, pad);
    expect(padStocked(world, 0)).toBe(false);
  });
});

describe('swapping drops the old weapon', () => {
  it('leaves the previously held gun on the ground with its exact ammo', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = padWeapon(world, 0) as WeaponId;
    const slotIndex = p * WEAPON_SLOTS;
    // Hold something different, part-used.
    world.players.weapons[slotIndex] = (offered + 1) % WEAPON_COUNT;
    world.players.weapons[slotIndex + 1] = (offered + 2) % WEAPON_COUNT;
    world.players.weaponSlot[p] = 0;
    world.players.ammoMag[slotIndex] = 5;
    world.players.ammoReserve[slotIndex] = 17;
    const oldWeapon = world.players.weapons[slotIndex];

    takePad(world, p, pad);

    // Equipped the pad gun...
    expect(world.players.weapons[slotIndex]).toBe(offered);
    // ...and the old one is on the floor with exactly the rounds it had.
    let found = -1;
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] === 1 && world.pickups.weapon[i] === oldWeapon) found = i;
    }
    expect(found).toBeGreaterThanOrEqual(0);
    expect(world.pickups.mag[found]).toBe(5);
    expect(world.pickups.reserve[found]).toBe(17);
    expect(world.pickups.padIndex[found]).toBe(-1); // a drop, not a pad gun
  });

  it('merging ammo into a gun you already carry drops nothing', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = padWeapon(world, 0) as WeaponId;
    world.players.weapons[p * WEAPON_SLOTS] = offered; // already holding it
    world.players.ammoReserve[p * WEAPON_SLOTS] = 0;
    world.players.weaponSlot[p] = 0;

    takePad(world, p, pad);
    expect(groundItems(world, true)).toBe(0);
    expect(world.players.ammoReserve[p * WEAPON_SLOTS] ?? 0).toBeGreaterThan(0);
  });

  it('a dropped weapon can be picked back up with the ammo it kept', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    const slotIndex = p * WEAPON_SLOTS;
    const offered = padWeapon(world, 0) as WeaponId;
    world.players.weapons[slotIndex] = (offered + 1) % WEAPON_COUNT;
    world.players.weapons[slotIndex + 1] = (offered + 3) % WEAPON_COUNT;
    world.players.weaponSlot[p] = 0;
    world.players.ammoMag[slotIndex] = 4;
    world.players.ammoReserve[slotIndex] = 9;
    const dropped = world.players.weapons[slotIndex];

    takePad(world, p, pad); // swap: old gun hits the floor
    run(world, 60); // let it land

    let slot = -1;
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] === 1 && world.pickups.weapon[i] === dropped) slot = i;
    }
    expect(slot).toBeGreaterThanOrEqual(0);

    // Walk back over it and take it again.
    teleport(world, p, world.pickups.posX[slot] ?? 0, world.pickups.posY[slot] ?? 0);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);

    expect(world.players.weapons[slotIndex]).toBe(dropped);
    expect(world.players.ammoMag[slotIndex]).toBe(4);
    expect(world.players.ammoReserve[slotIndex]).toBe(9);
  });
});

describe('death drops equipment', () => {
  it('scatters both weapons and the grenades the victim still had', () => {
    const world = padRoom();
    const victim = addCombatant(world);
    const killer = addCombatant(world);
    run(world, 5);

    const slotIndex = victim * WEAPON_SLOTS;
    world.players.ammoMag[slotIndex] = 7;
    world.players.ammoReserve[slotIndex] = 12;
    world.players.grenades[victim] = 2;
    const gunA = world.players.weapons[slotIndex];
    const gunB = world.players.weapons[slotIndex + 1];

    const dropsBefore = groundItems(world, true);
    world.players.protect[victim] = 0;
    world.players.health[victim] = 1;
    world.damage.push(victim, 50, killer, 0, 0);
    damageSystem(world);

    expect(world.players.status[victim]).toBe(0);
    // Two guns plus one grenade bundle.
    expect(groundItems(world, true) - dropsBefore).toBe(3);

    let gunADrop = -1;
    let grenadeDrop = -1;
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] !== 1 || (world.pickups.padIndex[i] ?? -1) >= 0) continue;
      if (world.pickups.kind[i] === PickupKind.Grenades) grenadeDrop = i;
      else if (world.pickups.weapon[i] === gunA) gunADrop = i;
    }
    expect(gunADrop).toBeGreaterThanOrEqual(0);
    expect(world.pickups.mag[gunADrop]).toBe(7); // exact remaining rounds
    expect(world.pickups.reserve[gunADrop]).toBe(12);
    expect(grenadeDrop).toBeGreaterThanOrEqual(0);
    expect(world.pickups.mag[grenadeDrop]).toBe(2); // exact remaining grenades
    expect(gunB).toBeGreaterThanOrEqual(0);
  });

  it('drops fall and come to rest on the floor', () => {
    const world = padRoom();
    const victim = addCombatant(world);
    const killer = addCombatant(world);
    run(world, 5);
    world.players.protect[victim] = 0;
    world.players.health[victim] = 1;
    world.damage.push(victim, 50, killer, 0, 0);
    damageSystem(world);

    run(world, 180); // three seconds of falling
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] !== 1 || (world.pickups.padIndex[i] ?? -1) >= 0) continue;
      expect(world.pickups.grounded[i]).toBe(1);
      expect(world.pickups.velY[i]).toBe(0);
    }
  });

  it('a dropped bundle tops the looter up to the cap', () => {
    const world = padRoom();
    const victim = addCombatant(world);
    const looter = addCombatant(world);
    run(world, 5);
    world.players.grenades[victim] = 2;
    world.players.protect[victim] = 0;
    world.players.health[victim] = 1;
    world.damage.push(victim, 50, victim, 0, 0);
    damageSystem(world);

    // Let the bundle land and finish its arm delay before anyone can take it.
    run(world, Math.ceil(TUNING.pickups.dropArmDelay / SIM_DT) + 20);

    let bundle = -1;
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] === 1 && world.pickups.kind[i] === PickupKind.Grenades) bundle = i;
    }
    expect(bundle).toBeGreaterThanOrEqual(0);

    // Park the bundle well clear of the pad gun and the other drops: a player
    // takes one item per tick, lowest pool index first, so an overlapping pile
    // would make this assertion ambiguous.
    world.pickups.posX[bundle] = 8.5;
    world.pickups.posY[bundle] = 3.4;
    world.players.grenades[looter] = 1;
    teleport(world, looter, 8.5, 3.4);
    stage(world, looter, { buttons: Buttons.Interact });
    run(world, 1);
    expect(world.players.grenades[looter]).toBe(3);
  });

  it('drops expire so a long match does not silt up', () => {
    const world = padRoom();
    const victim = addCombatant(world);
    run(world, 5);
    world.players.protect[victim] = 0;
    world.players.health[victim] = 1;
    world.damage.push(victim, 50, victim, 0, 0);
    damageSystem(world);
    expect(groundItems(world, true)).toBeGreaterThan(0);

    // Keep the (respawned) player away from the loot while it ages out.
    run(world, Math.ceil(TUNING.pickups.dropTtl / SIM_DT) + 10);
    expect(groundItems(world, true)).toBe(0);
  });
});

describe('grenades are picked up automatically when you have none', () => {
  it('walks them up with no input at all', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const looter = addCombatant(world);
    run(world, 5);
    const bundle = bundleAt(world, owner, 8.5, 3.4);

    world.players.grenades[looter] = 0; // out of grenades
    teleport(world, looter, 8.5, 3.4);
    stage(world, looter, {}); // no buttons whatsoever
    run(world, 1);

    expect(world.players.grenades[looter]).toBe(2);
    expect(world.pickups.alive[bundle]).toBe(0);
  });

  it('takes only what fits and leaves the rest on the ground', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const looter = addCombatant(world);
    run(world, 5);
    const bundle = bundleAt(world, owner, 8.5, 3.4);
    world.pickups.mag[bundle] = 3; // a stack of three

    world.players.grenades[looter] = 1; // room for exactly two
    teleport(world, looter, 8.5, 3.4);
    stage(world, looter, {});
    run(world, 1);

    expect(world.players.grenades[looter]).toBe(TUNING.player.maxGrenades);
    // The odd one out stays put for whoever comes next.
    expect(world.pickups.alive[bundle]).toBe(1);
    expect(world.pickups.mag[bundle]).toBe(1);
  });

  it('a full player leaves the whole stack alone', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const looter = addCombatant(world);
    run(world, 5);
    const bundle = bundleAt(world, owner, 8.5, 3.4);
    world.pickups.mag[bundle] = 2;

    world.players.grenades[looter] = TUNING.player.maxGrenades;
    teleport(world, looter, 8.5, 3.4);
    stage(world, looter, {});
    run(world, 60);

    expect(world.players.grenades[looter]).toBe(TUNING.player.maxGrenades);
    expect(world.pickups.mag[bundle]).toBe(2);
  });

  it('the leftover is still collectable by a second player', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const first = addCombatant(world);
    const second = addCombatant(world);
    run(world, 5);
    const bundle = bundleAt(world, owner, 8.5, 3.4);
    world.pickups.mag[bundle] = 3;

    world.players.grenades[first] = 2; // room for one
    teleport(world, first, 8.5, 3.4);
    stage(world, first, {});
    run(world, 1);
    expect(world.players.grenades[first]).toBe(3);
    expect(world.pickups.mag[bundle]).toBe(2);

    teleport(world, first, 2, 3.4); // step away
    world.players.grenades[second] = 1;
    teleport(world, second, 8.5, 3.4);
    stage(world, second, {});
    run(world, 1);
    expect(world.players.grenades[second]).toBe(3);
    expect(world.pickups.alive[bundle]).toBe(0); // stack exhausted
  });

  it('never auto-collects weapons, only grenades', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    world.players.grenades[p] = 0; // empty, but that must not grab guns
    teleport(world, p, pad.x, pad.y);
    stage(world, p, {});
    run(world, 60);
    expect(padStocked(world, 0)).toBe(true);
  });
});

/** Drop a grenade bundle at a known clear spot and let it arm. */
function bundleAt(world: SimWorld, owner: number, x: number, y: number): number {
  world.players.grenades[owner] = 2;
  world.players.protect[owner] = 0;
  world.players.health[owner] = 1;
  world.damage.push(owner, 50, owner, 0, 0);
  damageSystem(world);
  run(world, Math.ceil(TUNING.pickups.dropArmDelay / SIM_DT) + 20);

  let bundle = -1;
  for (let i = 0; i < world.pickups.alive.length; i++) {
    if (world.pickups.alive[i] === 1 && world.pickups.kind[i] === PickupKind.Grenades) bundle = i;
  }
  if (bundle === -1) throw new Error('no bundle');
  // Park it clear of the pad gun and the other drops.
  world.pickups.posX[bundle] = x;
  world.pickups.posY[bundle] = y;
  return bundle;
}

describe('grenades never mask a weapon underneath', () => {
  it('a gun under a grenade stack is still prompted and collectable', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const a = addCombatant(world);
    run(world, 5);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    // Drop a bundle directly on top of the pad's gun.
    const bundle = bundleAt(world, owner, pad.x, pad.y);
    world.pickups.mag[bundle] = 2;
    world.players.grenades[a] = TUNING.player.maxGrenades; // full: cannot use it

    teleport(world, a, pad.x, pad.y);
    // The prompt skips the grenades and offers the gun.
    const prompted = findPickupUnderPlayer(world, a);
    expect(prompted).toBeGreaterThanOrEqual(0);
    expect(world.pickups.kind[prompted]).toBe(PickupKind.Weapon);

    const before = world.players.weapons[a * WEAPON_SLOTS + (world.players.weaponSlot[a] ?? 0)];
    stage(world, a, { buttons: Buttons.Interact });
    run(world, 1);
    const after = world.players.weapons[a * WEAPON_SLOTS + (world.players.weaponSlot[a] ?? 0)];
    expect(after).not.toBe(before); // the press reached the gun, not the grenades
    expect(world.pickups.mag[bundle]).toBe(2); // stack untouched by a full player
  });

  it('topping up grenades does not consume the press meant for a gun', () => {
    const world = padRoom();
    const owner = addCombatant(world);
    const a = addCombatant(world);
    run(world, 5);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    const bundle = bundleAt(world, owner, pad.x, pad.y);
    world.pickups.mag[bundle] = 2;
    world.players.grenades[a] = 0; // will auto-collect this tick

    teleport(world, a, pad.x, pad.y);
    const before = world.players.weapons[a * WEAPON_SLOTS + (world.players.weaponSlot[a] ?? 0)];
    stage(world, a, { buttons: Buttons.Interact });
    run(world, 1);

    // Both happened in the same tick: grenades gathered AND the gun swapped.
    expect(world.players.grenades[a]).toBe(2);
    expect(world.players.weapons[a * WEAPON_SLOTS + (world.players.weaponSlot[a] ?? 0)]).not.toBe(
      before,
    );
  });
});

describe('weapon scopes', () => {
  it('every weapon defines a distinct, sane scope', () => {
    const zooms = new Set<number>();
    for (let id = 0; id < WEAPON_COUNT; id++) {
      const { scope, name } = weaponDef(id as WeaponId);
      expect(scope.zoomOut, name).toBeGreaterThanOrEqual(1);
      expect(scope.zoomOut, name).toBeLessThanOrEqual(3);
      expect(scope.lookAhead, name).toBeGreaterThanOrEqual(0);
      zooms.add(scope.zoomOut);
    }
    // Not every weapon has to be unique, but the roster must offer real choice.
    expect(zooms.size).toBeGreaterThanOrEqual(5);
  });

  it('the sniper sees furthest and the shotgun least', () => {
    const sniper = weaponDef(WeaponId.LongboltRifle).scope;
    const shotgun = weaponDef(WeaponId.Scattergun).scope;
    for (let id = 0; id < WEAPON_COUNT; id++) {
      const scope = weaponDef(id as WeaponId).scope;
      expect(scope.zoomOut).toBeLessThanOrEqual(sniper.zoomOut);
      expect(scope.lookAhead).toBeLessThanOrEqual(sniper.lookAhead);
      expect(scope.zoomOut).toBeGreaterThanOrEqual(shotgun.zoomOut);
    }
  });
});

describe('collecting a pad', () => {
  it('swaps the active slot and loads it fully', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = padWeapon(world, 0) as WeaponId;
    const def = weaponDef(offered);
    // Make sure the pad offers something the player is not already carrying.
    world.players.weapons[p * WEAPON_SLOTS] = (offered + 1) % WEAPON_COUNT;
    world.players.weapons[p * WEAPON_SLOTS + 1] = (offered + 2) % WEAPON_COUNT;
    world.players.weaponSlot[p] = 0;

    takePad(world, p, pad);

    expect(world.players.weapons[p * WEAPON_SLOTS]).toBe(offered);
    expect(world.players.ammoMag[p * WEAPON_SLOTS]).toBe(def.magSize);
    expect(world.players.ammoReserve[p * WEAPON_SLOTS]).toBe(def.reserveMax);
    expect(padStocked(world, 0)).toBe(false);
  });

  it('leaves the other slot untouched', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    const offered = padWeapon(world, 0) as WeaponId;
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
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    const offered = padWeapon(world, 0) as WeaponId;
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
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');

    teleport(world, a, pad.x, pad.y);
    teleport(world, b, pad.x, pad.y);
    stage(world, a, { buttons: Buttons.Interact });
    stage(world, b, { buttons: Buttons.Interact });
    run(world, 1);
    expect(countEvents(world, SimEventType.PickupTaken)).toBe(1);
    expect(padStocked(world, 0)).toBe(false);
  });

  it('a dead player standing on a pad does not collect it', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x, pad.y);
    world.players.status[p] = 0;
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);
    expect(padStocked(world, 0)).toBe(true);
  });

  it('is not collectable from across the room', () => {
    const world = padRoom();
    const p = addCombatant(world);
    const pad = world.map.pads[0];
    if (pad === undefined) throw new Error('no pad');
    teleport(world, p, pad.x + 3, pad.y);
    stage(world, p, { buttons: Buttons.Interact });
    run(world, 1);
    expect(padStocked(world, 0)).toBe(true);
  });
});
