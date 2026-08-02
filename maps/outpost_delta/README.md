# Outpost Delta — map assets

Layout follows the brief. **Most of these folders are intentionally empty**, and
that is a real constraint rather than an omission:

Aerocade generates 100% of its art procedurally at runtime, in code, into a
single texture atlas (`packages/client/src/game/render/textures.ts`). There are
no image files anywhere in the project, by design — see
[ADR-001](../../docs/DECISIONS.md) (originality: the game ships no third-party
assets) and [ADR-012](../../docs/DECISIONS.md) (one atlas, for batching).

So for this map:

| Folder         | Status        | Where it actually lives                                       |
| -------------- | ------------- | ------------------------------------------------------------- |
| `json/`        | **populated** | `map.json`, generated — see below                             |
| `tiles/`       | code          | `Frames.Tile` in `textures.ts`                                |
| `ladders/`     | code          | `Frames.Ladder`                                               |
| `collision/`   | data          | `collision` + `oneWayPlatforms` rect lists in `json/map.json` |
| `pickups/`     | code          | `Frames.HealthBox`, `Frames.AmmoBox`, `Frames.Grenade`        |
| `weapons/`     | code          | `weaponFrame(id)` — one silhouette per weapon                 |
| `background/`  | —             | parallax layers are a future milestone (M6)                   |
| `foreground/`  | —             | as above                                                      |
| `decorations/` | —             | as above                                                      |
| `audio/`       | —             | generated audio arrives in M5                                 |

The folders are kept so that a future art pass (or a fork that wants painted
assets) has the structure the brief specifies.

## `json/map.json`

Regenerate after any change to the map builder — it is a **derived artifact**
and hand-edits will be overwritten:

```bash
npx tsx packages/client/scripts/export-map.mjs
```

Contains: size, spawn points (with team), health/ammo/weapon/grenade pad
positions, ladder runs, collision rectangles, one-way platform rectangles,
respawn timers, and navigation hints. Coordinates are in pixels at 32 px/tile.

## Source of truth

The map itself is built in
[`packages/shared/src/sim/map/outpost-delta.ts`](../../packages/shared/src/sim/map/outpost-delta.ts).
Only the left half is authored; `mirror()` produces the right half, so symmetry
is structural. A connectivity test flood-fills the finished map and fails if any
spawn or pickup becomes unreachable.
