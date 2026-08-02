# Rendering Architecture

Aerocade's renderer is a deliberately thin layer: Phaser 3.87 is used **only** as a WebGL
renderer, audio mixer, and raw input surface, while all game state lives in the deterministic
simulation in `packages/shared` (see [architecture.md](architecture.md) and
[ecs.md](ecs.md)). The render layer never mutates sim state; each animation frame it reads the
two most recent tick states, interpolates them by the accumulator alpha, and pushes the result
into pooled sprites whose lifetimes mirror the sim's struct-of-arrays pools. All textures are
generated procedurally at boot — the project ships zero external art assets — and the HUD is
React DOM layered above the canvas, not Phaser text. Everything in this document targets a
steady 60 FPS on mid-range Android hardware.

## Phaser as a renderer, nothing more

Per [ADR-003](DECISIONS.md#adr-003-custom-fixed-timestep-physics-instead-of-matterjs), Phaser's
physics (Arcade and Matter) is **disabled** in the game config. The reasons are the same ones
that ruled out Matter.js for the sim:

- **Determinism.** Prediction and reconciliation re-simulate ticks from snapshots
  ([networking.md](networking.md)); any physics living inside the renderer would diverge from
  the authoritative sim and cannot be rewound.
- **Single source of truth.** Sprite `x/y/rotation` are _outputs_ written once per frame from
  interpolated sim state. If Phaser also moved bodies, two owners would fight over the same
  transforms.
- **Sim runs headless.** `packages/shared` has zero dependencies and no DOM; it must run
  identically in the host browser, predicting clients, and Node test runners. Phaser is a
  client-only concern.

What Phaser _does_ own:

| Responsibility   | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| WebGL rendering  | sprites, tilemap layers, particle emitters, `Graphics` for beams          |
| Texture registry | procedural `CanvasTexture`s generated in `BootScene`                      |
| Audio            | Web Audio via Phaser sound manager; clips are generated, not loaded       |
| Raw input events | keyboard/pointer/Gamepad API events, forwarded to the shared input mapper |
| Cameras          | follow, bounds clamp, shake, parallax scroll factors                      |

The renderer consumes `SimWorld` snapshots read-only. The only data flowing the other way is
sampled input intent (see [ui.md](ui.md) for the mapping layer).

## Scene structure

Two scenes, no more:

```mermaid
flowchart LR
    Boot[BootScene] -->|"generate textures + audio,\nthen start"| Arena[ArenaScene]
    Arena -->|"per frame"| Read[read sim states t-1, t]
    Read --> Lerp[interpolate by alpha]
    Lerp --> Sync[sync sprite pools]
    Sync --> FX[drain FX event queue]
```

- **`BootScene`** — runs once. Generates every texture and audio buffer procedurally (below),
  registers them under stable keys, then starts `ArenaScene`. There is no loading bar for
  network assets because there are no network assets; generation completes in well under a
  second on target hardware.
- **`ArenaScene`** — renders one match. On create it builds the static tilemap for the current
  map (e.g. Foundry, 48×27 tiles), allocates all sprite/emitter pools at full capacity, wires
  the camera, and subscribes to the sim. On shutdown it releases pools and unsubscribes.
  Menus, lobby, scoreboard, and pause are **not** scenes — they are React ([ui.md](ui.md)).

React owns the page; Phaser owns one `<canvas>` inside a React-managed container. Scene
transitions never touch React routing and vice versa.

## Interpolated presentation

Per [ADR-004](DECISIONS.md#adr-004-simulation-is-authoritative-rendering-interpolates), the sim
steps at a fixed 60 Hz (`SIM_DT = 1/60`) inside an accumulator loop, and rendering runs at
display rate (60–144 Hz). The game loop keeps **two** state views: `prevState` (tick _t−1_)
and `currState` (tick _t_), both typed-array snapshots. After stepping, the leftover
accumulator yields the blend factor:

```
alpha = accumulator / SIM_DT        // in [0, 1)
renderX = prevX + (currX - prevX) * alpha
renderAngle = prevAngle + shortestArc(currAngle - prevAngle) * alpha
```

Rules:

- **Positions** lerp linearly; sim units are meters, converted to pixels only at this write
  (`px = meters * TILE_PX`, per [ADR-008](DECISIONS.md#adr-008-units-and-tuning) render scale
  is the renderer's business).
- **Angles** (aim, projectile heading) lerp along the shortest arc to avoid 359°→1° spins.
- **Teleports** (respawn, future jump pads) set a per-entity `snap` flag for one tick; the
  renderer skips interpolation for that entity that frame instead of streaking it across the
  arena.
- **Networked remote entities** interpolate between buffered host snapshots (~100 ms buffer,
  ≤120 ms extrapolation) rather than local ticks; the renderer is agnostic — it always receives
  a `(prev, curr, alpha)` triple from the state provider, whether that provider is the local
  sandbox loop or the netcode's interpolation buffer ([networking.md](networking.md)).

The render pass is a single tight loop per pool, iterating by ascending index exactly like the
sim, touching only entities whose `alive` flag is set.

## Terrain: a viewport-sized window, not a map-sized display list

Foundry is 48 × 27 tiles and could afford one image per solid tile. Outpost Delta is 175 × 98 —
17,150 tiles, ~4,400 of them solid — and a sprite each would put thousands of objects on the
display list whose transforms are walked every frame no matter where the camera is.

`TerrainView` instead keeps a **pool sized to the viewport** (about 500 sprites) and re-points it
at whichever tile rectangle the camera can see, with a few tiles of slack so small pans need no
work at all. Cost is O(visible), not O(map), and the rebuild only runs when the visible tile rect
actually changes — a stationary camera costs nothing. This is the chunked-rendering and
frustum-culling requirement met without leaving the single atlas (ADR-012): ladders, one-way
platforms and terrain all draw from the same texture, so the whole world is still one batch.

## Sprite pools mirror sim pools

Sim pools are fixed-capacity (players ×8, projectiles ×256, pickups ×64). The renderer
allocates matching sprite pools **once** in `ArenaScene.create` and never afterwards:

| Sim pool         | Render pool                                      | Sync rule                                                 |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------- |
| players ×8       | 8 articulated rigs (7 sprites each, see below)   | index _i_ sim ↔ index _i_ rig                             |
| projectiles ×256 | 256 sprites                                      | atlas frame swapped by projectile kind on activation      |
| pickups ×64      | 64 item sprites (+ 1 static disc per weapon pad) | index _i_ sim ↔ index _i_ sprite; discs are map furniture |

Sync per frame: if `alive[i]` and sprite hidden → activate (`setVisible(true)`, assign
texture); if dead and visible → deactivate. Active sprites get position/rotation/flip written
from interpolated state. There is no create/destroy, no dynamic display-list churn, and no
lookup maps — index identity between sim and render pools makes the sync branch-cheap and
allocation-free.

### The player rig

Each player is an articulated soldier (`PlayerRig`), not a single sprite: a helmeted head, an
armored torso, a jetpack, two legs, an arm, and the held weapon — seven sprites in one flat
`Container`. Facing is the container's `scaleX = ±1`; because a mirrored container renders a
rotation `r` as `π − r` (y-down), the arm pre-mirrors the aim to `π − aim` when facing left.

The rig is **pure presentation**. It reads interpolated position/aim plus three sim facts
(`velX`, `grounded`, active weapon) and owns only cosmetic state — a run phase. Nothing it
computes feeds back into the simulation.

| State    | Pose                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle     | legs slightly splayed, torso upright                                                                                                                                         |
| Running  | legs counter-swing on a `sin(runPhase)` cycle advanced by **distance moved**, so the stride matches ground speed at any frame rate; torso leans into travel; upper body bobs |
| Airborne | legs settle into a trailing pose; jetpack plume emits from the pack nozzles                                                                                                  |

Poses blend toward their target each frame (`POSE_EASE`) so transitions never snap. The arm and
gun are positioned with explicit trigonometry rather than a nested container — one less
container per player on the display list.

Spawn protection (2.5 s) renders as an alpha pulse on the whole rig; death spawns a short
tumble of armor pieces. Reload and low-fuel states are HUD concerns, not sprite concerns.

### Overhead health bars

**Every living player** carries a bar above their head, the local player included, read straight
from `players.health` each frame so it tracks damage the tick it lands. The bar is cleared in the
same frame a player dies — the render loop skips invisible players, so hiding has to happen on
that branch or the last drawn sliver of health freezes over the corpse. It is two sprites — a slate
backing and a tinted fill whose `scaleX` is the health fraction, origin pinned left so it drains
rightward. Fill color runs green → amber → red.

Two constraints shaped this. The bars are **atlas sprites, not `Graphics`**: a per-player
`Graphics` rebuilds geometry and flushes the batch every frame (ADR-012). And they sit
**outside the rig container**, because the rig mirrors with `scaleX = -1` on facing, which would
make a nested bar drain the wrong way. The backing is deliberately mid-slate rather than
near-black — against a dark arena a black backing is invisible, and a nearly-empty bar then
reads as a floating chip rather than a bar that is nearly empty.

### Weapon pads

Pads are drawn state-driven, never event-driven, so they are correct on the first frame after a
snapshot or a reconciliation rewind. Pad discs are static furniture, one per map pad. Ground items — pad guns _and_ dropped gear —
are separate pooled sprites indexed by pickup slot, since drops are thrown and fall. A pad's gun
bobs; dropped gear lies where it landed and fades over its final seconds. A looted pad keeps the
disc but dims it, then **brightens it as the refill approaches**: readiness is
`1 − respawnIn / weaponRespawnDelay`, so a player across the arena can read "that pad is about
to restock" and time a return. Collection and refill each emit a short particle puff.

## Procedural textures — zero external assets

All art is generated at runtime in `BootScene` from code: canvas 2D shapes, gradients, and
noise from a **render-local** mulberry32 instance (never the sim RNG — sim determinism rules in
[ADR-009](DECISIONS.md#adr-009-determinism-rules) are untouched because texture generation
happens outside the sim). This guarantees originality by construction — there is no asset file
to resemble anything — and keeps the PWA precache tiny ([ADR-007](DECISIONS.md#adr-007-pwa)).

Generation strategy per family:

| Family               | Technique                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ |
| Tileset (Foundry)    | 1 m tiles: base fill + edge bevel gradient + walkable-edge highlight                 |
| Character parts      | head / torso / leg / arm / jetpack, drawn facing right on a near-white tintable base |
| Weapons              | layered rects/polys per weapon def; one frame per roster entry, keyed by weapon id   |
| Projectiles          | rocket and grenade silhouettes with emissive caps                                    |
| Particles            | soft radial discs (spark, muzzle flash) built from concentric alpha rings            |
| Background layers    | large low-frequency gradient + silhouette shapes, one frame per parallax layer       |
| UI icons / PWA icons | same pipeline, exported to the manifest at build time                                |

### One atlas, not many textures — a hard requirement

Every frame above is packed into a **single** runtime atlas texture (`ATLAS`), shelf-packed with
a 2 px gutter, baked once with `generateTexture`, then carved into named frames via
`texture.add()`. Character parts are authored at 2× and drawn at `RIG_SCALE` for clean edges.

This is a performance contract, not tidiness. Sprites drawn from different textures force a
WebGL batch flush apiece, and the rig is seven sprites per player across eight players. When the
rig first shipped with one texture per body part it measured **~3.5× the frame time** of the
capsule it replaced on the software rasterizer; folding every part — tiles included — into one
atlas erased the regression entirely and left the rig marginally _cheaper_ than the capsule,
because tiles and characters now batch together. Any new art must join the atlas.

Textures are generated once at a fixed authoring resolution and never regenerated mid-match.
Team coloring uses Phaser tint on the near-white bases instead of per-color texture variants,
keeping frame count — and batch breaks — low.

## Camera model

One main camera plus parallax scroll factors (no second camera needed):

- **Follow** the local player's _interpolated_ render position with `lerp` smoothing
  (~0.12/frame), so camera motion is as smooth as the entity it tracks.
- **Aim lookahead**: the follow target is offset toward the aim direction by up to 2.5 m,
  eased, so players see more of where they are shooting — vital with the Longbolt's range.
- **Bounds clamp** to the arena rect (48 × 27 m for Foundry); the camera never shows outside
  the map, and on very wide screens zoom is raised until the vertical bound fits.
- **Screenshake budget**: shake requests carry intensity and duration (Scattergun blast 0.15,
  rocket splash up to 0.4 scaled by distance, own damage taken 0.25). Concurrent requests
  **max-combine** rather than sum, hard-capped at 0.5 total with ~8 px peak amplitude, and the
  settings screen exposes a global multiplier (accessibility). Shake perturbs only the camera
  offset — never sim state, never HUD DOM.

## Layering and parallax

Fixed depth bands; sprites set depth once at pool creation, never per frame:

| Depth | Layer                                            | Scroll factor |
| ----: | ------------------------------------------------ | ------------: |
|     0 | Sky gradient backdrop                            |           0.0 |
|    10 | Far silhouettes (stacks, gantries)               |          0.25 |
|    20 | Near background structures                       |          0.55 |
|    30 | Tilemap: behind-tiles (pipes, braces)            |           1.0 |
|    40 | Pickups                                          |           1.0 |
|    50 | Players (local player rendered last within band) |           1.0 |
|    60 | Projectiles, beams                               |           1.0 |
|    70 | Tilemap: foreground lips/overhangs               |           1.0 |
|    80 | Particles (flash, smoke, explosions)             |           1.0 |
|    90 | World-space markers (spawn shimmer, hit flashes) |           1.0 |

Parallax layers are single large `TileSprite`s scrolled by camera position — three quads total,
negligible cost. The React HUD sits above depth 90 in DOM space and is untouched by camera or
shake.

## HUD: React DOM above the canvas

Phaser text objects are **never used** — `Text` re-rasterizes a canvas per change and breaks
sprite batches. Instead ([ui.md](ui.md)):

- The HUD (health, fuel, ammo, weapon, killfeed, scoreboard, timer) is React DOM absolutely
  positioned over the canvas, `pointer-events: none` except interactive controls.
- **Low-frequency values** (ammo count, kill feed, scores, timer seconds) flow through a small
  external store; the renderer publishes changes **only when the integer value actually
  changes**, so React re-renders a handful of times per second, not per frame.
- **Continuous bars** (health, jetpack fuel — fuel changes every tick while thrusting at
  46/s burn) bypass React reconciliation: a rAF-driven writer sets `transform: scaleX(...)`
  directly on the bar fill elements via refs. No layout, no React render, compositor-only.
- Damage direction indicators and hit markers are also DOM elements toggled via class, driven
  by the same FX event queue as world particles.

This split keeps text layout entirely off the per-frame path while staying crisp at any DPR.

## Effects: pooled particle emitters

All transient FX come from emitters and pooled `Graphics`/sprite helpers pre-created in
`ArenaScene.create`:

- **Muzzle flashes** — per-player one-shot emitter burst at the barrel offset, 2–4 particles,
  additive blend.
- **Tracers** — hitscan weapons (Rivet Pistol, Vortex SMG, Pulse Rifle, Scattergun, Longbolt)
  draw a fading line via a pooled `Graphics` ring buffer (32 entries), one `lineBetween` per
  active tracer, alpha decays over ~90 ms. No allocation: the ring reuses entries.
- **Explosions** — Thumper/Lobber/Frag detonations trigger a flash sprite scale-pop plus a
  smoke+spark emitter burst sized by blast radius (3.2 / 2.8 / 3.4 m), plus a shake request.
- **Jetpack flame** — a persistent per-player emitter toggled by the sim's thrust flag; hover
  mode (reduced 20/s burn) halves emission rate for readable feedback.

The sim emits **FX events** (id, kind, position, params) into a fixed-size ring buffer during
its systems pass; the renderer drains the ring each frame. Events are fire-and-forget data —
the sim never knows the renderer exists, which keeps headless test runs
([testing.md](testing.md)) byte-identical to rendered ones.

## Performance rules

Target: 60 FPS on mid-range Android (~2020 class GPU) at DPR ≤ 2. Enforced rules — violations
are review blockers:

1. **Zero per-frame allocation** in the render loop: no closures, no array literals, no
   destructuring that allocates, no `new`. Scratch vectors are module-level and reused.
2. **No per-frame text layout**: no Phaser `Text`, no per-frame DOM writes except the
   transform-only bar updates.
3. **Batched draws**: procedural textures for one layer share a canvas atlas where practical;
   depth bands group same-texture sprites; additive-blend particles live in their own band to
   avoid pipeline ping-pong. Budget: ≤ ~30 draw calls in a full 8-player firefight.
4. **Static geometry stays static**: the tile layers are culled by Phaser's tile culling; tiles
   never change during a match (destructibles are out of scope through M6).
5. **Off-screen skip**: pooled sprites outside the camera view (+1 m margin) are hidden, not
   updated.
6. Measured continuously against the budgets in [performance.md](performance.md); the frame
   profiler overlay (dev builds only) shows sim/render/GC time split.

## Resolution, DPR, and letterboxing

- **Scale mode**: Phaser `FIT` inside a 16:9 design space of **960 × 540 logical pixels**
  (20 px per tile × 48 tiles wide). `FIT` letterboxes rather than crops, so no aspect ratio
  reveals more arena than another — a fairness requirement for LAN play.
- **DPR policy**: render resolution = logical × `min(devicePixelRatio, 2)`. DPR is capped at 2;
  above that, GPU fill cost outweighs visible benefit on small screens. A settings toggle
  ("Sharp/Fast") drops the cap to 1 on struggling devices — resolution scaling is the single
  biggest lever on mobile GPUs.
- **Landscape only**: the PWA manifest requests landscape ([ADR-007](DECISIONS.md#adr-007-pwa));
  in portrait the React shell shows a rotate prompt and the scene pauses rendering (sim
  keeps ticking in networked play so the player rejoins the action, not a time warp).
- **Letterbox bars** are DOM background, not canvas — the canvas is sized to the fitted rect
  and the surrounding page is a solid color, so the GPU never rasterizes dead pixels.
- Resize/orientation events re-run the fit calculation and re-anchor HUD DOM; nothing about
  the sim or the camera bounds changes, because all gameplay space is in meters
  ([physics.md](physics.md)).
