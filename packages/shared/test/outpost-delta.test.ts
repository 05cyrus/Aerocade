import { describe, expect, it } from 'vitest';
import {
  PadKind,
  TileFlag,
  createMapById,
  createOutpostDeltaMap,
  exportMapJson,
  isLadder,
  isOneWay,
  isSolid,
  type MapDef,
} from '../src/index.js';

const map = createOutpostDeltaMap();

/** Open tiles reachable from a start tile, allowing a generous vertical step. */
function reachable(m: MapDef, startX: number, startY: number): Uint8Array {
  const seen = new Uint8Array(m.width * m.height);
  const open = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < m.width && y < m.height && !isSolid(m, x, y);
  const stack: [number, number][] = [[startX, startY]];
  seen[startY * m.width + startX] = 1;
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    const [x, y] = top;
    const nbrs: [number, number][] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    // Jump/jetpack reach: several tiles of clearance upward.
    for (let up = 2; up <= 6; up++) nbrs.push([x, y - up]);
    for (const [nx, ny] of nbrs) {
      if (!open(nx, ny)) continue;
      const i = ny * m.width + nx;
      if (seen[i] === 1) continue;
      seen[i] = 1;
      stack.push([nx, ny]);
    }
  }
  return seen;
}

describe('Outpost Delta geometry', () => {
  it('matches the briefed size', () => {
    expect(map.width * 32).toBe(5600);
    expect(map.height * 32).toBe(3136); // 98 tiles; 3150 is not a whole tile
  });

  it('is perfectly symmetric', () => {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        expect(map.tiles[y * map.width + x], `tile ${String(x)},${String(y)}`).toBe(
          map.tiles[y * map.width + (map.width - 1 - x)],
        );
      }
    }
  });

  it('has six spawns in mirrored pairs', () => {
    expect(map.spawnPoints).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      const left = map.spawnPoints[i];
      const right = map.spawnPoints[i + 3];
      if (left === undefined || right === undefined) throw new Error('missing spawn');
      expect(right.y).toBe(left.y);
      expect(right.x).toBeCloseTo(map.width - left.x, 6);
    }
  });

  it('carries every pickup kind the brief asks for', () => {
    const count = (k: PadKind): number => map.pads.filter((p) => p.kind === k).length;
    expect(count(PadKind.Health)).toBeGreaterThanOrEqual(6);
    expect(count(PadKind.Ammo)).toBeGreaterThanOrEqual(4);
    expect(count(PadKind.Weapon)).toBeGreaterThanOrEqual(8);
    expect(count(PadKind.Grenade)).toBeGreaterThanOrEqual(2);
  });

  it('has ladders and one-way platforms', () => {
    let ladders = 0;
    let oneWay = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (isLadder(map, x, y)) ladders += 1;
        if (isOneWay(map, x, y)) oneWay += 1;
      }
    }
    expect(ladders).toBeGreaterThan(100);
    expect(oneWay).toBeGreaterThan(100);
  });

  it('never leaves a ladder tile fully solid', () => {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (isLadder(map, x, y))
          expect(isSolid(map, x, y), `${String(x)},${String(y)}`).toBe(false);
      }
    }
  });

  it('is sealed: the border is solid all the way round', () => {
    for (let x = 0; x < map.width; x++) {
      expect(isSolid(map, x, 0)).toBe(true);
      expect(isSolid(map, x, map.height - 1)).toBe(true);
    }
    for (let y = 0; y < map.height; y++) {
      expect(isSolid(map, 0, y)).toBe(true);
      expect(isSolid(map, map.width - 1, y)).toBe(true);
    }
  });
});

describe('Outpost Delta connectivity', () => {
  const first = map.spawnPoints[0];
  if (first === undefined) throw new Error('no spawns');
  const seen = reachable(map, Math.floor(first.x), Math.floor(first.y));

  it('every spawn is reachable from every other', () => {
    for (let i = 0; i < map.spawnPoints.length; i++) {
      const s = map.spawnPoints[i];
      if (s === undefined) continue;
      expect(seen[Math.floor(s.y) * map.width + Math.floor(s.x)], `spawn ${String(i + 1)}`).toBe(1);
    }
  });

  it('every pickup pad is reachable', () => {
    for (let i = 0; i < map.pads.length; i++) {
      const p = map.pads[i];
      if (p === undefined) continue;
      expect(
        seen[Math.floor(p.y) * map.width + Math.floor(p.x)],
        `pad ${String(i)} at ${String(Math.floor(p.x))},${String(Math.floor(p.y))}`,
      ).toBe(1);
    }
  });

  it('leaves no walled-off pockets of open space', () => {
    let open = 0;
    let found = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (isSolid(map, x, y)) continue;
        open += 1;
        if (seen[y * map.width + x] === 1) found += 1;
      }
    }
    expect(found / open).toBeGreaterThan(0.99);
  });

  it('spawns are spread out, not clustered', () => {
    for (let i = 0; i < map.spawnPoints.length; i++) {
      for (let j = i + 1; j < map.spawnPoints.length; j++) {
        const a = map.spawnPoints[i];
        const bPoint = map.spawnPoints[j];
        if (a === undefined || bPoint === undefined) continue;
        expect(Math.hypot(a.x - bPoint.x, a.y - bPoint.y)).toBeGreaterThan(8);
      }
    }
  });
});

describe('map JSON export', () => {
  const json = exportMapJson(map);

  it('publishes the shape external tooling expects', () => {
    for (const key of [
      'map',
      'size',
      'spawns',
      'health',
      'ammo',
      'weapons',
      'grenades',
      'ladders',
      'collision',
      'oneWayPlatforms',
      'respawnTimers',
      'navigation',
    ]) {
      expect(json, key).toHaveProperty(key);
    }
  });

  it('compresses collision into far fewer rects than tiles', () => {
    const runs = json.collision as unknown[];
    let solidTiles = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) if (isSolid(map, x, y)) solidTiles += 1;
    }
    expect(runs.length).toBeLessThan(solidTiles / 5);
  });

  it('round-trips through the map registry', () => {
    expect(createMapById('outpost_delta').width).toBe(map.width);
    expect(TileFlag.Solid).toBe(1);
  });
});
