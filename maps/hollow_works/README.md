# Hollow Works — map assets

180 × 92 tiles (5760 × 2944 px at 32 px/m). The **default** map: an abandoned
rock-and-concrete complex carved into a ridge, in five vertical layers.

As with `../outpost_delta/`, **most of these folders are intentionally empty**.
Aerocade generates 100% of its art procedurally at runtime into a single texture
atlas (`packages/client/src/game/render/textures.ts`); there are no image files
anywhere in the game bundle, by design — see [ADR-001](../../docs/DECISIONS.md)
(originality) and [ADR-012](../../docs/DECISIONS.md) (one atlas, for batching).

| Folder         | Status        | Where it actually lives                                       |
| -------------- | ------------- | ------------------------------------------------------------- |
| `json/`        | **populated** | `map.json`, generated — see below                             |
| `tiles/`       | code          | `Frames.Tile` in `textures.ts`                                |
| `ladders/`     | code          | `Frames.Ladder`                                               |
| `collision/`   | data          | `collision` + `oneWayPlatforms` rect lists in `json/map.json` |
| `pickups/`     | code          | `Frames.HealthBox`, `Frames.AmmoBox`, `Frames.Grenade`        |
| `weapons/`     | code          | `weaponFrame(id)` — one silhouette per weapon                 |
| `background/`  | —             | parallax layers are a future milestone                        |
| `foreground/`  | —             | as above                                                      |
| `decorations/` | —             | as above                                                      |
| `audio/`       | —             | generated audio arrives in M5                                 |

## `json/map.json`

A **derived artifact** — hand-edits will be overwritten. Regenerate after any
change to the map builder:

```bash
npx tsx packages/client/scripts/export-map.mjs
```

Contains size, spawn points, pad positions by kind, ladder runs, collision
rectangles, one-way platform rectangles, respawn timers and navigation hints.
Coordinates are in pixels at 32 px/tile.

## Source of truth

The map is built in
[`packages/shared/src/sim/map/hollow-works.ts`](../../packages/shared/src/sim/map/hollow-works.ts).

Unlike Outpost Delta it is **not** mirrored — the layout is deliberately
asymmetric (natural cliff left, industrial works right), so balance comes from
paired corner spawns rather than from `mirror()`. See
[ADR-020](../../docs/DECISIONS.md) for why, and for the three physics numbers
(1.76 m jump, 1.65 m body, ~20 m jetpack climb) that set every dimension.

Geometry is verified by
[`packages/shared/test/hollow-works.test.ts`](../../packages/shared/test/hollow-works.test.ts),
which walks a real 1×2 player body through the level rather than flood-filling
tiles — a tile fill routes through gaps a player cannot enter.
