import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADOUT,
  TUNING,
  WEAPON_COUNT,
  WEAPON_SLOTS,
  WeaponId,
  WeaponSlot,
  createMatch,
  parseAsciiMap,
  weaponDef,
  weaponsInSlot,
  type SimWorld,
} from '../src/index.js';
import { addCombatant, Buttons, equip, run, stage, teleport } from './helpers.js';

/** Flat room with one weapon pad at tile (5, 3). */
function padRoom(): SimWorld {
  return createMatch(
    parseAsciiMap('slots', 'Slots', [
      '##########',
      '#........#',
      '#........#',
      '#..S.W..S#',
      '##########',
    ]),
    99,
  );
}

/** Put a specific weapon on pad 0, fully loaded, and return its pickup slot. */
function stockPad(world: SimWorld, id: WeaponId): number {
  const slot = world.pads.pickup[0] ?? -1;
  if (slot < 0) throw new Error('pad not stocked');
  const def = weaponDef(id);
  world.pickups.weapon[slot] = id;
  world.pickups.mag[slot] = def.magSize;
  world.pickups.reserve[slot] = def.reserveMax;
  return slot;
}

function carried(world: SimWorld, player: number, slot: WeaponSlot): number {
  return world.players.weapons[player * WEAPON_SLOTS + slot] ?? -1;
}

/** Take the pad by standing on it and tapping interact. */
function takePad(world: SimWorld, player: number): void {
  const pad = world.map.pads[0];
  if (pad === undefined) throw new Error('no pad');
  teleport(world, player, pad.x, pad.y);
  stage(world, player, { buttons: Buttons.Interact });
  run(world, 1);
  stage(world, player, {});
}

describe('weapon slot classification', () => {
  it('every weapon declares a slot, and the roster covers both', () => {
    for (let id = 0; id < WEAPON_COUNT; id++) {
      const def = weaponDef(id as WeaponId);
      expect([WeaponSlot.Primary, WeaponSlot.Secondary], def.name).toContain(def.slot);
    }
    expect(weaponsInSlot(WeaponSlot.Primary).length).toBeGreaterThan(0);
    expect(weaponsInSlot(WeaponSlot.Secondary).length).toBeGreaterThan(0);
  });

  it('the pistol is the sidearm and the long guns are primaries', () => {
    expect(weaponDef(WeaponId.RivetPistol).slot).toBe(WeaponSlot.Secondary);
    for (const id of [
      WeaponId.VortexSmg,
      WeaponId.PulseRifle,
      WeaponId.Scattergun,
      WeaponId.LongboltRifle,
      WeaponId.Thumper,
      WeaponId.Lobber,
    ]) {
      expect(weaponDef(id).slot, weaponDef(id).name).toBe(WeaponSlot.Primary);
    }
  });

  it('the spawn loadout puts each weapon in its own slot', () => {
    for (let s = 0; s < WEAPON_SLOTS; s++) {
      const id = DEFAULT_LOADOUT[s];
      if (id === undefined) throw new Error('short loadout');
      expect(weaponDef(id).slot, weaponDef(id).name).toBe(s);
    }
  });

  it('a fresh player carries a primary and a secondary', () => {
    const world = padRoom();
    const p = addCombatant(world);
    expect(weaponDef(carried(world, p, WeaponSlot.Primary) as WeaponId).slot).toBe(
      WeaponSlot.Primary,
    );
    expect(weaponDef(carried(world, p, WeaponSlot.Secondary) as WeaponId).slot).toBe(
      WeaponSlot.Secondary,
    );
  });
});

describe('pickups only ever replace their own slot', () => {
  it('a primary replaces the primary and leaves the sidearm alone', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 5);
    // Hold the pistol so the active slot is the SECONDARY one.
    equip(world, p, WeaponId.RivetPistol);
    const sidearmBefore = carried(world, p, WeaponSlot.Secondary);
    stockPad(world, WeaponId.LongboltRifle);

    takePad(world, p);

    expect(carried(world, p, WeaponSlot.Primary)).toBe(WeaponId.LongboltRifle);
    expect(carried(world, p, WeaponSlot.Secondary)).toBe(sidearmBefore); // untouched
  });

  it('a secondary replaces the sidearm and leaves the primary alone', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 5);
    // Hold a rifle so the active slot is the PRIMARY one, and make the
    // sidearm something other than the pad's offering.
    equip(world, p, WeaponId.LongboltRifle);
    world.players.weapons[p * WEAPON_SLOTS + WeaponSlot.Secondary] = WeaponId.VortexSmg;
    stockPad(world, WeaponId.RivetPistol);

    takePad(world, p);

    expect(carried(world, p, WeaponSlot.Primary)).toBe(WeaponId.LongboltRifle); // untouched
    expect(carried(world, p, WeaponSlot.Secondary)).toBe(WeaponId.RivetPistol);
  });

  it('the displaced weapon hits the ground with its exact ammo', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 5);
    equip(world, p, WeaponId.RivetPistol); // holding the sidearm
    const primaryIdx = p * WEAPON_SLOTS + WeaponSlot.Primary;
    const displaced = world.players.weapons[primaryIdx];
    world.players.ammoMag[primaryIdx] = 9;
    world.players.ammoReserve[primaryIdx] = 21;
    stockPad(world, WeaponId.Scattergun);

    takePad(world, p);

    let found = -1;
    for (let i = 0; i < world.pickups.alive.length; i++) {
      if (world.pickups.alive[i] !== 1) continue;
      if ((world.pickups.padIndex[i] ?? -1) >= 0) continue;
      if (world.pickups.weapon[i] === displaced) found = i;
    }
    expect(found).toBeGreaterThanOrEqual(0);
    expect(world.pickups.mag[found]).toBe(9);
    expect(world.pickups.reserve[found]).toBe(21);
  });

  it('picking a weapon up equips it', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 5);
    equip(world, p, WeaponId.RivetPistol); // active slot = secondary
    stockPad(world, WeaponId.Thumper); // a primary
    takePad(world, p);
    expect(world.players.weaponSlot[p]).toBe(WeaponSlot.Primary);
  });
});

describe('grenades settle instead of sliding', () => {
  it('a grenade thrown flat comes to rest well before its fuse', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 20);
    teleport(world, p, 2, 3);
    stage(world, p, { buttons: Buttons.Grenade, aim: 0 }); // thrown level, to the right
    run(world, 1);
    stage(world, p, {});

    let slot = -1;
    for (let i = 0; i < world.projectiles.alive.length; i++) {
      if (world.projectiles.alive[i] === 1) slot = i;
    }
    expect(slot).toBeGreaterThanOrEqual(0);

    // Give it a second to land and settle — well inside the 2.6 s fuse.
    run(world, 60);
    expect(world.projectiles.alive[slot]).toBe(1); // has not detonated yet
    expect(Math.abs(world.projectiles.velX[slot] ?? 0)).toBe(0);
  });

  it('friction actually decelerates a grounded grenade', () => {
    const world = padRoom();
    const p = addCombatant(world);
    run(world, 20);
    stage(world, p, { buttons: Buttons.Grenade, aim: 0 });
    run(world, 1);
    stage(world, p, {});
    let slot = -1;
    for (let i = 0; i < world.projectiles.alive.length; i++) {
      if (world.projectiles.alive[i] === 1) slot = i;
    }
    // Plant it *resting on* the floor (row 4) with a healthy slide, and watch
    // friction bleed it off. Sitting mid-air would just fall instead.
    world.projectiles.posX[slot] = 4;
    world.projectiles.posY[slot] = 3.97;
    world.projectiles.velX[slot] = 6;
    world.projectiles.velY[slot] = 0;
    world.projectiles.fuse[slot] = 5;
    const startX = world.projectiles.posX[slot] ?? 0;

    run(world, 30); // half a second
    expect(Math.abs(world.projectiles.velX[slot] ?? 0)).toBe(0);
    // It travelled, but not far: 6 m/s under 26 m/s² stops inside ~0.7 m.
    const travelled = Math.abs((world.projectiles.posX[slot] ?? 0) - startX);
    expect(travelled).toBeLessThan(1);
    expect(travelled).toBeGreaterThan(0);
    // Sanity-check the tuning the assertion above depends on: v²/2a.
    const stopDistance = 6 ** 2 / (2 * TUNING.grenade.groundFriction);
    expect(stopDistance).toBeLessThan(1);
  });
});
