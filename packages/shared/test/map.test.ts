import { describe, expect, it } from 'vitest';
import { createFoundryMap, isSolid, parseAsciiMap } from '../src/index.js';

describe('map parsing', () => {
  it('parses Foundry with 8 grounded spawn points', () => {
    const map = createFoundryMap();
    expect(map.width).toBe(48);
    expect(map.height).toBe(27);
    expect(map.spawnPoints).toHaveLength(8);
    for (const sp of map.spawnPoints) {
      const tx = Math.floor(sp.x);
      const ty = Math.floor(sp.y);
      expect(isSolid(map, tx, ty)).toBe(false);
      expect(isSolid(map, tx, ty - 1)).toBe(false); // headroom
      expect(isSolid(map, tx, ty + 1)).toBe(true); // ground beneath
    }
  });

  it('seals the arena border', () => {
    const map = createFoundryMap();
    for (let x = 0; x < map.width; x++) {
      expect(isSolid(map, x, 0)).toBe(true);
      expect(isSolid(map, x, map.height - 1)).toBe(true);
    }
    for (let y = 0; y < map.height; y++) {
      expect(isSolid(map, 0, y)).toBe(true);
      expect(isSolid(map, map.width - 1, y)).toBe(true);
    }
  });

  it('treats out-of-bounds as solid', () => {
    const map = createFoundryMap();
    expect(isSolid(map, -1, 5)).toBe(true);
    expect(isSolid(map, map.width, 5)).toBe(true);
    expect(isSolid(map, 5, -1)).toBe(true);
    expect(isSolid(map, 5, map.height)).toBe(true);
  });

  it('rejects ragged rows', () => {
    expect(() => parseAsciiMap('bad', 'Bad', ['###', '##'])).toThrow(/row 1/);
  });

  it('rejects unknown tiles', () => {
    expect(() => parseAsciiMap('bad', 'Bad', ['###', '#X#', '###'])).toThrow(/unknown tile/);
  });

  it('requires at least two spawns', () => {
    expect(() => parseAsciiMap('bad', 'Bad', ['####', '#S.#', '####'])).toThrow(/spawn/);
  });
});
