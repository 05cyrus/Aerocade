/**
 * Map format. Maps are a tile grid (1 tile = 1 m) plus placed entities.
 *
 * Terrain is a single byte per tile holding `TileFlag` bits, so a tile can be
 * solid, a one-way platform, a ladder, or a ladder drawn over a platform.
 * Small maps are authored as ASCII art (`parseAsciiMap`); large ones are built
 * programmatically with `MapBuilder`, which is the only sane way to keep a
 * 175×98 arena perfectly symmetric.
 *
 * ASCII legend:
 *   '#' solid          '.' empty          '=' one-way platform
 *   'H' ladder         'S' player spawn   'W' weapon pad
 *   '+' health pad     'A' ammo pad       'G' grenade pad
 */

import { MAX_PICKUP_PADS, MAX_PICKUPS } from '../../constants.js';

/** Terrain bits. A tile may carry several (a ladder over a platform). */
export const TileFlag = {
  Solid: 1 << 0,
  /** Blocks only downward movement: jump up through it, land on top. */
  OneWay: 1 << 1,
  /** Climbable. Never blocks movement by itself. */
  Ladder: 1 << 2,
} as const;

export type TileFlag = (typeof TileFlag)[keyof typeof TileFlag];

/** What a fixed pad on the map dispenses. */
export const PadKind = {
  Weapon: 0,
  Health: 1,
  Ammo: 2,
  Grenade: 3,
} as const;

export type PadKind = (typeof PadKind)[keyof typeof PadKind];

export interface SpawnPoint {
  /** Tile-center coordinates (x + 0.5, y + 0.5 of the marker tile). */
  x: number;
  y: number;
}

export interface PickupPad extends SpawnPoint {
  kind: PadKind;
}

export interface MapDef {
  id: string;
  name: string;
  /** Width/height in tiles (= meters). */
  width: number;
  height: number;
  /** Row-major `TileFlag` bitfield, `width * height` entries. */
  tiles: Uint8Array;
  spawnPoints: readonly SpawnPoint[];
  /**
   * Pickup pads. Index _i_ here is pad slot _i_ in the sim's pad pool — pads
   * are static map data, so only their contents are simulated.
   */
  pads: readonly PickupPad[];
}

function flagsAt(map: MapDef, tileX: number, tileY: number): number {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return TileFlag.Solid;
  return map.tiles[tileY * map.width + tileX] ?? 0;
}

/** Fully solid: blocks movement from every direction. Out of bounds counts. */
export function isSolid(map: MapDef, tileX: number, tileY: number): boolean {
  return (flagsAt(map, tileX, tileY) & TileFlag.Solid) !== 0;
}

/** A platform you can jump up through but land on top of. */
export function isOneWay(map: MapDef, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return false;
  return (flagsAt(map, tileX, tileY) & TileFlag.OneWay) !== 0;
}

export function isLadder(map: MapDef, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return false;
  return (flagsAt(map, tileX, tileY) & TileFlag.Ladder) !== 0;
}

/** True when any part of a world-space AABB overlaps a ladder tile. */
export function aabbTouchesLadder(
  map: MapDef,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const minX = Math.floor(centerX - halfWidth);
  const maxX = Math.floor(centerX + halfWidth - 1e-9);
  const minY = Math.floor(centerY - halfHeight);
  const maxY = Math.floor(centerY + halfHeight - 1e-9);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (isLadder(map, tx, ty)) return true;
    }
  }
  return false;
}

// ---------- construction ----------

/**
 * Mutable grid used while a map is being drawn. Programmatic construction is
 * what makes a large symmetric arena tractable: build the left half plus the
 * centre column, then `mirror()` — symmetry becomes structural rather than
 * something a human has to keep in sync by hand.
 */
export class MapBuilder {
  readonly tiles: Uint8Array;
  readonly spawnPoints: SpawnPoint[] = [];
  readonly pads: PickupPad[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    readonly width: number,
    readonly height: number,
  ) {
    this.tiles = new Uint8Array(width * height);
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, flags: number): this {
    if (this.inBounds(x, y)) this.tiles[y * this.width + x] = flags;
    return this;
  }

  add(x: number, y: number, flags: number): this {
    if (this.inBounds(x, y)) this.set(x, y, this.get(x, y) | flags);
    return this;
  }

  clear(x: number, y: number): this {
    if (this.inBounds(x, y)) this.tiles[y * this.width + x] = 0;
    return this;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.tiles[y * this.width + x] ?? 0;
  }

  /** Filled rectangle, inclusive of both corners. */
  rect(x0: number, y0: number, x1: number, y1: number, flags: number = TileFlag.Solid): this {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, flags);
    }
    return this;
  }

  /** Hollow out a rectangle (rooms, caves, corridors). */
  carve(x0: number, y0: number, x1: number, y1: number): this {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.clear(x, y);
    }
    return this;
  }

  /** Horizontal run of solid floor/ceiling one tile thick. */
  slab(x0: number, x1: number, y: number, flags: number = TileFlag.Solid): this {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, flags);
    return this;
  }

  /** Horizontal one-way platform: jump up through it, land on top. */
  platform(x0: number, x1: number, y: number): this {
    return this.slab(x0, x1, y, TileFlag.OneWay);
  }

  /**
   * Vertical ladder from `y0` to `y1` inclusive. Ladder tiles are added to
   * whatever is already there, so a ladder can run through a platform.
   */
  ladder(x: number, y0: number, y1: number): this {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      // A ladder must be climbable, so never leave it fully solid.
      const kept = this.get(x, y) & ~TileFlag.Solid;
      this.set(x, y, kept | TileFlag.Ladder);
    }
    return this;
  }

  spawn(x: number, y: number): this {
    this.spawnPoints.push({ x: x + 0.5, y: y + 0.5 });
    return this;
  }

  pad(x: number, y: number, kind: PadKind): this {
    this.pads.push({ x: x + 0.5, y: y + 0.5, kind });
    return this;
  }

  /**
   * Mirror everything left of `axis` onto the right, producing an exactly
   * symmetric arena. The column at `axis` is the untouched centre line.
   */
  mirror(axis: number): this {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < axis; x++) {
        this.set(this.width - 1 - x, y, this.get(x, y));
      }
    }
    const flip = (p: SpawnPoint): number => this.width - p.x;
    for (const s of [...this.spawnPoints]) {
      this.spawnPoints.push({ x: flip(s), y: s.y });
    }
    for (const p of [...this.pads]) {
      this.pads.push({ x: flip(p), y: p.y, kind: p.kind });
    }
    return this;
  }

  build(): MapDef {
    const map: MapDef = {
      id: this.id,
      name: this.name,
      width: this.width,
      height: this.height,
      tiles: this.tiles,
      spawnPoints: this.spawnPoints,
      pads: this.pads,
    };
    validateMap(map);
    return map;
  }
}

/** Shared sanity checks; every map goes through these before it can be played. */
export function validateMap(map: MapDef): void {
  if (map.spawnPoints.length < 2) {
    throw new Error(
      `map ${map.id}: needs at least 2 spawn points, found ${String(map.spawnPoints.length)}`,
    );
  }
  if (map.pads.length > MAX_PICKUP_PADS) {
    throw new Error(
      `map ${map.id}: ${String(map.pads.length)} pads exceeds the ${String(MAX_PICKUP_PADS)} pad pool`,
    );
  }
  if (map.pads.length > MAX_PICKUPS) {
    throw new Error(`map ${map.id}: more pads than the ${String(MAX_PICKUPS)} pickup pool`);
  }

  // Anything embedded in rock is unreachable and silently dead. On a large map
  // this is the single easiest mistake to make, so it fails at construction.
  for (let i = 0; i < map.spawnPoints.length; i++) {
    const s = map.spawnPoints[i];
    if (s === undefined) continue;
    if (isSolid(map, Math.floor(s.x), Math.floor(s.y))) {
      throw new Error(
        `map ${map.id}: spawn ${String(i + 1)} is inside solid rock at ${String(Math.floor(s.x))},${String(Math.floor(s.y))}`,
      );
    }
  }
  for (let i = 0; i < map.pads.length; i++) {
    const p = map.pads[i];
    if (p === undefined) continue;
    if (isSolid(map, Math.floor(p.x), Math.floor(p.y))) {
      throw new Error(
        `map ${map.id}: pad ${String(i)} is inside solid rock at ${String(Math.floor(p.x))},${String(Math.floor(p.y))}`,
      );
    }
  }
}

const ASCII: Record<string, { flags?: number; spawn?: boolean; pad?: PadKind }> = {
  '.': {},
  '#': { flags: TileFlag.Solid },
  '=': { flags: TileFlag.OneWay },
  H: { flags: TileFlag.Ladder },
  S: { spawn: true },
  W: { pad: PadKind.Weapon },
  '+': { pad: PadKind.Health },
  A: { pad: PadKind.Ammo },
  G: { pad: PadKind.Grenade },
};

/**
 * Parse an ASCII-authored map. Throws on ragged rows or a malformed legend, so
 * a bad map fails loudly at load time (and in unit tests), never mid-game.
 */
export function parseAsciiMap(id: string, name: string, rows: readonly string[]): MapDef {
  const height = rows.length;
  const first = rows[0];
  if (height === 0 || first === undefined) throw new Error(`map ${id}: empty`);
  const width = first.length;

  const builder = new MapBuilder(id, name, width, height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row?.length !== width) {
      throw new Error(
        `map ${id}: row ${String(y)} has length ${String(row?.length)}, expected ${String(width)}`,
      );
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? '';
      const entry = ASCII[ch];
      if (entry === undefined) {
        throw new Error(`map ${id}: unknown tile '${ch}' at ${String(x)},${String(y)}`);
      }
      if (entry.flags !== undefined) builder.set(x, y, entry.flags);
      if (entry.spawn === true) builder.spawn(x, y);
      if (entry.pad !== undefined) builder.pad(x, y, entry.pad);
    }
  }
  return builder.build();
}
