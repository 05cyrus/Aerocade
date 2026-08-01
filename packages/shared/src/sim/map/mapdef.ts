/**
 * Map format. Maps are a solid-tile grid (1 tile = 1 m) plus placed entities.
 * Authored as ASCII art for now; a binary/JSON format plus editor arrives
 * post-1.0 (see docs/roadmap.md).
 *
 * Legend: '#' solid, '.' empty, 'S' spawn point (empty tile).
 */

export interface SpawnPoint {
  /** Tile-center coordinates (x + 0.5, y + 0.5 of the marker tile). */
  x: number;
  y: number;
}

export interface MapDef {
  id: string;
  name: string;
  /** Width/height in tiles (= meters). */
  width: number;
  height: number;
  /** Row-major solidity grid, `width * height` entries of 0 | 1. */
  solid: Uint8Array;
  spawnPoints: readonly SpawnPoint[];
}

export function isSolid(map: MapDef, tileX: number, tileY: number): boolean {
  // Everything outside the grid counts as solid so nothing escapes the arena.
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return true;
  return map.solid[tileY * map.width + tileX] === 1;
}

/**
 * Parse an ASCII-authored map. Throws on ragged rows or missing spawns, so a
 * malformed map fails loudly at load time (and in unit tests), never mid-game.
 */
export function parseAsciiMap(id: string, name: string, rows: readonly string[]): MapDef {
  const height = rows.length;
  const first = rows[0];
  if (height === 0 || first === undefined) throw new Error(`map ${id}: empty`);
  const width = first.length;

  const solid = new Uint8Array(width * height);
  const spawnPoints: SpawnPoint[] = [];

  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row?.length !== width) {
      throw new Error(
        `map ${id}: row ${String(y)} has length ${String(row?.length)}, expected ${String(width)}`,
      );
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      if (ch === '#') {
        solid[y * width + x] = 1;
      } else if (ch === 'S') {
        spawnPoints.push({ x: x + 0.5, y: y + 0.5 });
      } else if (ch !== '.') {
        throw new Error(`map ${id}: unknown tile '${ch ?? ''}' at ${String(x)},${String(y)}`);
      }
    }
  }

  if (spawnPoints.length < 2) {
    throw new Error(
      `map ${id}: needs at least 2 spawn points, found ${String(spawnPoints.length)}`,
    );
  }

  return { id, name, width, height, solid, spawnPoints };
}
