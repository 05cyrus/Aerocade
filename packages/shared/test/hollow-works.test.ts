import { describe, expect, it } from 'vitest';
import {
  HOLLOW_WORKS_DECKS,
  PadKind,
  createHollowWorksMap,
  createMapById,
  exportMapJson,
  isLadder,
  isOneWay,
  isSolid,
  TUNING,
  type MapDef,
} from '../src/index.js';

const map = createHollowWorksMap();

/**
 * Player-aware traversal.
 *
 * A tile flood fill is not enough for a map like this: it happily routes
 * through a one-tile gap that a 1.65 m player cannot enter, so it would pass a
 * level that is actually impassable. This models the real body and the real
 * movement budget instead.
 *
 * A position is the player's FEET tile and needs two open tiles (feet + head),
 * because the collision box is 0.85 × 1.65 m — one tile wide, two tall.
 */
const BODY_H = 2;

/** Tiles a plain jump can rise: v²/2g = 8.6²/42 ≈ 1.76 m, so one tile. */
const JUMP_TILES = Math.floor(TUNING.player.jumpSpeed ** 2 / (2 * TUNING.player.gravity) / 1);

/**
 * Tiles credited to the jetpack. The real budget is ~20 m (thrust 38 beats
 * gravity 21, and a full tank sustains ~2.2 s of climb), but the test stays
 * deliberately conservative so a route that only works on a perfect fuel burn
 * is not counted as connected.
 */
const JET_TILES = 6;

function open(m: MapDef, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.width && y < m.height && !isSolid(m, x, y);
}

/** Does the player body fit with its feet in this tile? */
function fits(m: MapDef, x: number, y: number): boolean {
  for (let i = 0; i < BODY_H; i++) if (!open(m, x, y - i)) return false;
  return true;
}

/** Standing on solid ground, a one-way platform, or a ladder. */
function supported(m: MapDef, x: number, y: number): boolean {
  return isSolid(m, x, y + 1) || isOneWay(m, x, y + 1) || isLadder(m, x, y);
}

/** Every place the player can stand or hang, reachable from a start tile. */
function traverse(m: MapDef, startX: number, startY: number): Set<number> {
  const key = (x: number, y: number): number => y * m.width + x;
  const seen = new Set<number>();
  const stack: [number, number][] = [];

  const push = (x: number, y: number): void => {
    if (!fits(m, x, y)) return;
    const k = key(x, y);
    if (seen.has(k)) return;
    seen.add(k);
    stack.push([x, y]);
  };

  push(startX, startY);
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    const [x, y] = top;

    // Walk, including a one-tile step up or down (a rocky slope).
    for (const dx of [-1, 1]) {
      for (const dy of [0, -1, 1]) push(x + dx, y + dy);
    }

    // Fall: drop straight down until something supports the body.
    let fy = y;
    while (fits(m, x, fy + 1)) {
      fy += 1;
      push(x, fy);
      if (supported(m, x, fy)) break;
    }

    // Jump, and climb a ladder the body is touching.
    for (let up = 1; up <= JUMP_TILES; up++) push(x, y - up);
    if (isLadder(m, x, y) || isLadder(m, x, y - 1)) {
      push(x, y - 1);
      push(x, y + 1);
    }

    // Jetpack: rise through clear air only.
    for (let up = 1; up <= JET_TILES; up++) {
      if (!fits(m, x, y - up)) break;
      push(x, y - up);
    }
  }
  return seen;
}

const spawn0 = map.spawnPoints[0];
if (spawn0 === undefined) throw new Error('no spawns');
const walkable = traverse(map, Math.floor(spawn0.x), Math.floor(spawn0.y));
const at = (p: { x: number; y: number }): number => Math.floor(p.y) * map.width + Math.floor(p.x);

describe('Hollow Works structure', () => {
  it('is the briefed size and is registered as a playable map', () => {
    expect(map.width).toBe(HOLLOW_WORKS_DECKS.width);
    expect(map.height).toBe(HOLLOW_WORKS_DECKS.height);
    expect(createMapById('hollow_works').width).toBe(map.width);
  });

  it('is sealed all the way round', () => {
    for (let x = 0; x < map.width; x++) {
      expect(isSolid(map, x, 0), `top ${String(x)}`).toBe(true);
      expect(isSolid(map, x, map.height - 1), `bottom ${String(x)}`).toBe(true);
    }
    for (let y = 0; y < map.height; y++) {
      expect(isSolid(map, 0, y), `left ${String(y)}`).toBe(true);
      expect(isSolid(map, map.width - 1, y), `right ${String(y)}`).toBe(true);
    }
  });

  it('has five populated vertical layers', () => {
    const { L1, L2, L3, L4, L5 } = HOLLOW_WORKS_DECKS;
    for (const deck of [L1, L2, L3, L4, L5]) {
      let standing = 0;
      for (let x = 2; x < map.width - 2; x++) {
        if (!isSolid(map, x, deck) || !fits(map, x, deck - 1)) continue;
        standing += 1;
      }
      expect(standing, `deck ${String(deck)}`).toBeGreaterThan(30);
    }
  });

  it('has ladders and one-way platforms on every layer boundary', () => {
    let ladders = 0;
    let oneWay = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (isLadder(map, x, y)) ladders += 1;
        if (isOneWay(map, x, y)) oneWay += 1;
      }
    }
    expect(ladders).toBeGreaterThan(150);
    expect(oneWay).toBeGreaterThan(100);
  });

  it('never leaves a ladder tile fully solid', () => {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (isLadder(map, x, y)) {
          expect(isSolid(map, x, y), `${String(x)},${String(y)}`).toBe(false);
        }
      }
    }
  });

  it('is one connected rock mass, not floating platforms', () => {
    // Every solid tile that is not border must touch another solid tile, so no
    // island of rock hangs in the air on its own.
    let isolated = 0;
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (!isSolid(map, x, y)) continue;
        const touching =
          (isSolid(map, x - 1, y) ? 1 : 0) +
          (isSolid(map, x + 1, y) ? 1 : 0) +
          (isSolid(map, x, y - 1) ? 1 : 0) +
          (isSolid(map, x, y + 1) ? 1 : 0);
        if (touching === 0) isolated += 1;
      }
    }
    expect(isolated).toBe(0);
  });
});

describe('Hollow Works traversal', () => {
  it('a real player body can reach every spawn from every other', () => {
    for (let i = 0; i < map.spawnPoints.length; i++) {
      const s = map.spawnPoints[i];
      if (s === undefined) continue;
      expect(walkable.has(at(s)), `spawn S${String(i + 1)}`).toBe(true);
    }
  });

  it('a real player body can reach every pickup pad', () => {
    for (let i = 0; i < map.pads.length; i++) {
      const p = map.pads[i];
      if (p === undefined) continue;
      const kind = ['weapon', 'health', 'ammo', 'grenade'][p.kind] ?? '?';
      expect(
        walkable.has(at(p)),
        `${kind} pad ${String(i)} at ${String(Math.floor(p.x))},${String(Math.floor(p.y))}`,
      ).toBe(true);
    }
  });

  it('every spawn and pad stands on ground with headroom', () => {
    for (const p of [...map.spawnPoints, ...map.pads]) {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      expect(fits(map, x, y), `body fits at ${String(x)},${String(y)}`).toBe(true);
      expect(supported(map, x, y), `supported at ${String(x)},${String(y)}`).toBe(true);
    }
  });

  it('reaches all five layers, so no layer is a dead end', () => {
    const { L1, L2, L3, L4, L5 } = HOLLOW_WORKS_DECKS;
    for (const deck of [L1, L2, L3, L4, L5]) {
      let reached = 0;
      for (let x = 0; x < map.width; x++)
        if (walkable.has((deck - 1) * map.width + x)) reached += 1;
      expect(reached, `layer at deck ${String(deck)}`).toBeGreaterThan(10);
    }
  });

  it('connects left, centre and right on the middle layer', () => {
    const y = HOLLOW_WORKS_DECKS.L3 - 1;
    const bands: [string, number, number][] = [
      ['left', 6, 38],
      ['centre', 60, 120],
      ['right', 140, 172],
    ];
    for (const [name, x0, x1] of bands) {
      let reached = 0;
      for (let x = x0; x <= x1; x++) if (walkable.has(y * map.width + x)) reached += 1;
      expect(reached, `${name} band of the central hall`).toBeGreaterThan(5);
    }
  });

  it('every ladder run ends on ground the player can stand on', () => {
    // A ladder whose bottom stops in mid-air can only be reached from below by
    // burning jetpack fuel to get up to it, which quietly turns a ladder route
    // into a fuel-gated one. Each run must meet a floor.
    for (let x = 0; x < map.width; x++) {
      for (let y = 0; y < map.height; y++) {
        if (!isLadder(map, x, y)) continue;
        if (isLadder(map, x, y + 1)) continue; // not the bottom of the run yet
        expect(
          supported(map, x, y) || isSolid(map, x, y + 1),
          `ladder at ${String(x)},${String(y)} ends in mid-air`,
        ).toBe(true);
      }
    }
  });

  it('leaves no meaningful pocket of standable ground cut off', () => {
    let standable = 0;
    let reached = 0;
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (!fits(map, x, y) || !supported(map, x, y)) continue;
        standable += 1;
        if (walkable.has(y * map.width + x)) reached += 1;
      }
    }
    expect(reached / standable).toBeGreaterThan(0.98);
  });
});

describe('Hollow Works spawns and pickups', () => {
  it('places the four reference spawns in opposite corners', () => {
    const [s1, s2, s3, s4] = map.spawnPoints;
    if (!s1 || !s2 || !s3 || !s4) throw new Error('missing corner spawns');
    expect(s1.x).toBeLessThan(map.width / 2); // S1 upper left
    expect(s2.x).toBeGreaterThan(map.width / 2); // S2 upper right
    expect(s3.x).toBeLessThan(map.width / 2); // S3 lower left
    expect(s4.x).toBeGreaterThan(map.width / 2); // S4 lower right
    expect(s1.y).toBeLessThan(map.height / 2);
    expect(s2.y).toBeLessThan(map.height / 2);
    expect(s3.y).toBeGreaterThan(map.height / 2);
    expect(s4.y).toBeGreaterThan(map.height / 2);
  });

  it('gives all eight player slots a distinct, spread-out spawn', () => {
    expect(map.spawnPoints).toHaveLength(8);
    for (let i = 0; i < map.spawnPoints.length; i++) {
      for (let j = i + 1; j < map.spawnPoints.length; j++) {
        const a = map.spawnPoints[i];
        const c = map.spawnPoints[j];
        if (a === undefined || c === undefined) continue;
        expect(
          Math.hypot(a.x - c.x, a.y - c.y),
          `S${String(i + 1)} vs S${String(j + 1)}`,
        ).toBeGreaterThan(10);
      }
    }
  });

  it('no two spawns share an open horizontal sightline', () => {
    for (let i = 0; i < map.spawnPoints.length; i++) {
      for (let j = i + 1; j < map.spawnPoints.length; j++) {
        const a = map.spawnPoints[i];
        const c = map.spawnPoints[j];
        if (a === undefined || c === undefined) continue;
        if (Math.floor(a.y) !== Math.floor(c.y)) continue;
        const y = Math.floor(a.y);
        let blocked = false;
        for (let x = Math.min(a.x, c.x); x <= Math.max(a.x, c.x); x++) {
          if (isSolid(map, Math.floor(x), y)) {
            blocked = true;
            break;
          }
        }
        expect(blocked, `S${String(i + 1)} sees S${String(j + 1)} down row ${String(y)}`).toBe(
          true,
        );
      }
    }
  });

  it('carries the five reference weapon locations spread over every layer', () => {
    const weapons = map.pads.filter((p) => p.kind === PadKind.Weapon);
    expect(weapons.length).toBeGreaterThanOrEqual(5);
    const bands = new Set(weapons.map((p) => Math.floor(p.y / (map.height / 5))));
    expect(bands.size, 'weapon pads occupy distinct height bands').toBeGreaterThanOrEqual(4);
  });

  it('carries every other pickup kind', () => {
    const count = (k: PadKind): number => map.pads.filter((p) => p.kind === k).length;
    expect(count(PadKind.Health)).toBeGreaterThanOrEqual(4);
    expect(count(PadKind.Ammo)).toBeGreaterThanOrEqual(4);
    expect(count(PadKind.Grenade)).toBeGreaterThanOrEqual(2);
  });

  it('exports for external tooling like the other maps', () => {
    const json = exportMapJson(map);
    for (const key of ['map', 'size', 'spawns', 'weapons', 'collision', 'oneWayPlatforms']) {
      expect(json, key).toHaveProperty(key);
    }
  });
});
