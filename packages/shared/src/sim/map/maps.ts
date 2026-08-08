import { createFoundryMap } from './foundry.js';
import { createHollowWorksMap } from './hollow-works.js';
import { createOutpostDeltaMap } from './outpost-delta.js';
import type { MapDef } from './mapdef.js';

/** Every map the game can load, in menu order. Index 0 is the default. */
export const MAP_IDS = ['hollow_works', 'outpost_delta', 'foundry'] as const;

export type MapId = (typeof MAP_IDS)[number];

/** The map a fresh session loads. */
export const DEFAULT_MAP_ID: MapId = 'hollow_works';

const factories: Record<MapId, () => MapDef> = {
  hollow_works: createHollowWorksMap,
  outpost_delta: createOutpostDeltaMap,
  foundry: createFoundryMap,
};

/** Short blurbs for the map picker. */
export const MAP_SUMMARIES: Record<MapId, { name: string; blurb: string }> = {
  hollow_works: {
    name: 'Hollow Works',
    blurb: '180 × 92 · five layers of caves, ruins and tunnels · 8 spawns',
  },
  outpost_delta: {
    name: 'Outpost Delta',
    blurb: '175 × 98 · bunker, mountains and tunnels · 6 spawns',
  },
  foundry: { name: 'Foundry', blurb: '48 × 27 · tight industrial hall · fast duels' },
};

export function createMapById(id: MapId): MapDef {
  return factories[id]();
}

export function isMapId(value: string): value is MapId {
  return (MAP_IDS as readonly string[]).includes(value);
}
