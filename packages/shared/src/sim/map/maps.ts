import { createFoundryMap } from './foundry.js';
import { createOutpostDeltaMap } from './outpost-delta.js';
import type { MapDef } from './mapdef.js';

/** Every map the game can load, in menu order. */
export const MAP_IDS = ['foundry', 'outpost_delta'] as const;

export type MapId = (typeof MAP_IDS)[number];

const factories: Record<MapId, () => MapDef> = {
  foundry: createFoundryMap,
  outpost_delta: createOutpostDeltaMap,
};

/** Short blurbs for the map picker. */
export const MAP_SUMMARIES: Record<MapId, { name: string; blurb: string }> = {
  foundry: { name: 'Foundry', blurb: '48 × 27 · tight industrial hall · fast duels' },
  outpost_delta: {
    name: 'Outpost Delta',
    blurb: '175 × 98 · bunker, mountains and tunnels · 6 spawns',
  },
};

export function createMapById(id: MapId): MapDef {
  return factories[id]();
}

export function isMapId(value: string): value is MapId {
  return (MAP_IDS as readonly string[]).includes(value);
}
