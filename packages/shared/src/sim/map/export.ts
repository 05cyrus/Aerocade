import { TUNING } from '../tuning.js';
import { PadKind, TileFlag, type MapDef } from './mapdef.js';

/** Pixels per tile used when publishing pixel coordinates. */
const PX = 32;

const PAD_NAMES: Record<PadKind, string> = {
  [PadKind.Weapon]: 'weapon',
  [PadKind.Health]: 'health',
  [PadKind.Ammo]: 'ammo',
  [PadKind.Grenade]: 'grenade',
};

/** One horizontal run of tiles sharing a flag — a compact collision rect. */
export interface TileRun {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Merge a flag's tiles into horizontal runs. Publishing 4,000 individual
 * collision tiles is unusable; runs give an engine-agnostic rectangle list
 * that is an order of magnitude smaller and trivially re-importable.
 */
export function tileRuns(map: MapDef, flag: number, excludeFlag = 0): TileRun[] {
  const runs: TileRun[] = [];
  for (let y = 0; y < map.height; y++) {
    let start = -1;
    for (let x = 0; x <= map.width; x++) {
      const flags = x < map.width ? (map.tiles[y * map.width + x] ?? 0) : 0;
      const match = (flags & flag) !== 0 && (excludeFlag === 0 || (flags & excludeFlag) === 0);
      if (match && start === -1) start = x;
      if (!match && start !== -1) {
        runs.push({ x: start * PX, y: y * PX, width: (x - start) * PX, height: PX });
        start = -1;
      }
    }
  }
  return runs;
}

/**
 * Full map configuration as plain JSON: size, spawns, pickups, ladders,
 * collision, one-way platforms, respawn timers and navigation hints.
 *
 * This is a *derived artifact*. The map source of truth is the builder in
 * `outpost-delta.ts`; regenerate this file rather than hand-editing it, or the
 * two will drift.
 */
export function exportMapJson(map: MapDef): Record<string, unknown> {
  const spawns = map.spawnPoints.map((s, i) => ({
    id: i + 1,
    x: Math.round(s.x * PX),
    y: Math.round(s.y * PX),
    // Left-hand spawns are authored first and mirrored, so odd ids sit left.
    team: i % 2 === 0 ? 1 : 2,
  }));

  const padsOf = (kind: PadKind): Record<string, number>[] =>
    map.pads
      .filter((p) => p.kind === kind)
      .map((p, i) => ({ id: i + 1, x: Math.round(p.x * PX), y: Math.round(p.y * PX) }));

  return {
    map: map.id,
    name: map.name,
    tileSize: PX,
    size: { width: map.width * PX, height: map.height * PX, tilesX: map.width, tilesY: map.height },
    spawns,
    health: padsOf(PadKind.Health),
    ammo: padsOf(PadKind.Ammo),
    weapons: padsOf(PadKind.Weapon),
    grenades: padsOf(PadKind.Grenade),
    ladders: tileRuns(map, TileFlag.Ladder),
    collision: tileRuns(map, TileFlag.Solid),
    oneWayPlatforms: tileRuns(map, TileFlag.OneWay, TileFlag.Solid),
    respawnTimers: {
      weapon: TUNING.pickups.weaponRespawnDelay,
      health: TUNING.pickups.healthRespawnDelay,
      ammo: TUNING.pickups.ammoRespawnDelay,
      grenade: TUNING.pickups.grenadeRespawnDelay,
      player: TUNING.player.respawnDelay,
    },
    pickupKinds: Object.fromEntries(map.pads.map((p, i) => [String(i), PAD_NAMES[p.kind]])),
    navigation: {
      /** Bands a bot or camera can reason about, in pixels. */
      groundY: 84 * PX,
      symmetryAxisX: Math.round((map.width / 2) * PX),
      note: 'Map is mirrored about symmetryAxisX; every level has >= 2 routes.',
    },
  };
}
