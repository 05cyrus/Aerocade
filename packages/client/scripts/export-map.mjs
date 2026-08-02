/**
 * Regenerate the published JSON configuration for every map.
 *
 *   npx tsx packages/client/scripts/export-map.mjs
 *
 * The builder in packages/shared/src/sim/map/ is the source of truth; this
 * writes the derived JSON that external tooling reads.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_IDS, createMapById, exportMapJson } from '../../shared/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'maps');
for (const id of MAP_IDS) {
  const map = createMapById(id);
  const dir = join(root, id, 'json');
  mkdirSync(dir, { recursive: true });
  const json = exportMapJson(map);
  writeFileSync(join(dir, 'map.json'), JSON.stringify(json, null, 2) + '\n');
  console.info(
    `${id}: ${json.size.tilesX}x${json.size.tilesY} tiles, ` +
      `${json.collision.length} collision runs, ${json.ladders.length} ladder runs, ` +
      `${json.spawns.length} spawns`,
  );
}
