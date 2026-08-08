import { MapBuilder, PadKind, TileFlag, type MapDef } from './mapdef.js';

/**
 * "Hollow Works" — an abandoned rock-and-concrete complex cut into a ridge.
 *
 * 180 × 92 tiles = 5760 × 2944 px at 32 px/m.
 *
 * The design goal is a single connected massif rather than a field of floating
 * platforms: the whole ridge is filled solid once, then every cave, gallery,
 * tunnel and shaft is **carved out of it**. That is why nothing here can float
 * — a chamber is a hole in rock, so its floor is by construction attached to
 * the mass around it. Surface relief is cut the same way, by carving the sky
 * down to a per-column deck height.
 *
 * Scale comes from the physics, not from the reference art (docs/physics.md):
 *   player 0.85 × 1.65 m  → every passage is carved ≥ 3 tiles of open height
 *   jump rise 1.76 m      → a 1-tile step is walkable, 2 tiles is NOT, so all
 *                           surface relief moves in 1-tile steps and every
 *                           bigger climb gets a ladder or a platform chain
 *   jetpack ≈ 20 m climb  → layer decks sit 14–17 tiles apart, so a full tank
 *                           crosses one layer but never trivialises two
 *
 * Five decks, y growing downward (each value is the first SOLID row, so the
 * standing surface is one above it):
 *   L1 15  upper cliffs, ruins and towers      — S1, S2, W2
 *   L2 29  upper caves and bridges             — W1, W3
 *   L3 45  central combat hall (the arches)    — the main fight
 *   L4 62  lower caves and industrial floor    — W4
 *   L5 78  underground tunnels                 — S3, S4, W5
 *
 * Left/right are deliberately NOT mirrored — the reference has a natural cliff
 * on the left and an industrial works on the right — so balance comes from
 * paired corner spawns (S1/S2 high, S3/S4 low) instead of `mirror()`.
 */

const W = 180;
const H = 92;

/** First solid row of each deck; the standing surface is one row above. */
const L1 = 15;
const L2 = 29;
const L3 = 45;
const L4 = 62;
const L5 = 78;

/** Highest row the ridge mass is filled to before the sky is carved out. */
const RIDGE_TOP = 10;

/** Open bands carved inside the mass, as [firstOpenRow, lastOpenRow]. */
const L2_BAND: readonly [number, number] = [19, L2 - 1];
const L3_BAND: readonly [number, number] = [31, L3 - 1];
const L4_BAND: readonly [number, number] = [48, L4 - 1];
const L5_BAND: readonly [number, number] = [65, L5 - 1];

/**
 * Surface deck heights, left to right. The L2 gallery has to stay *below*
 * whatever the skyline does above it, so these are the constraint that sets
 * each L2 chamber's ceiling: a tall chamber can only sit under high ground.
 * Getting this wrong punches the gallery roof out through a saddle floor.
 */
const SADDLE = 22; // the two low points in the skyline
const TERRACE = 17; // the central ruin terrace
/** Roof of the shallow throats that pass under the saddles. */
const THROAT_TOP = 25;
/** Roof of the chamber under the central terrace. */
const MID_TOP = 20;

export function createHollowWorksMap(): MapDef {
  const b = new MapBuilder('hollow_works', 'Hollow Works', W, H);

  massif(b);
  surface(b);
  upperCaves(b);
  centralHall(b);
  lowerWorks(b);
  tunnels(b);
  verticals(b);
  clutter(b);
  placeEntities(b);

  return b.build();
}

// ---------- helpers (local: they compose MapBuilder, they don't extend it) ----------

/**
 * Carve the sky above a sloped surface. `deckAt(x)` gives the first solid row
 * for each column, so relief is cut downward out of the mass. Steps are always
 * 1 tile because a 2-tile step exceeds the 1.76 m jump.
 */
function ridge(b: MapBuilder, x0: number, x1: number, y0: number, y1: number): void {
  const span = Math.max(1, x1 - x0);
  for (let x = x0; x <= x1; x++) {
    const t = (x - x0) / span;
    const deck = Math.round(y0 + (y1 - y0) * t);
    b.carve(x, RIDGE_TOP - 6, x, deck - 1);
  }
}

/** Flat plateau top: carve the sky down to `deck - 1`. */
function plateau(b: MapBuilder, x0: number, x1: number, deck: number): void {
  b.carve(x0, RIDGE_TOP - 6, x1, deck - 1);
}

/**
 * A cave/gallery with beveled top corners, so a chamber reads as a rock arch
 * instead of a box. The bevel only shaves the ceiling corners, so it never
 * narrows the walkable floor.
 */
function arch(b: MapBuilder, x0: number, y0: number, x1: number, y1: number, bevel = 3): void {
  b.carve(x0, y0, x1, y1);
  for (let i = 0; i < bevel; i++) {
    const inset = bevel - 1 - i;
    if (inset <= 0) continue;
    b.rect(x0, y0 + i, x0 + inset - 1, y0 + i);
    b.rect(x1 - inset + 1, y0 + i, x1, y0 + i);
  }
}

/** A solid rock pillar between two arches: cover, and it breaks sightlines. */
function pillar(b: MapBuilder, x0: number, x1: number, y0: number, y1: number): void {
  b.rect(x0, y0, x1, y1);
}

/**
 * Vertical shaft through a roof, with a ladder. `y0` is inside the upper space
 * and `y1` inside the lower one, so the ladder always has open air at both
 * ends — a ladder that stops inside rock is unusable.
 */
function shaft(b: MapBuilder, x: number, y0: number, y1: number, width = 2): void {
  b.carve(x, y0, x + width - 1, y1);
  b.ladder(x, y0, y1);
}

/**
 * A crate/barrel/rubble mound: cover that can always be crossed.
 *
 * Built as a symmetric staircase, because a plain block two tiles tall is not
 * cover — it is a wall. The jump only rises 1.76 m, so a flat 2-tile stack
 * cannot be climbed from either side and silently severs the route it sits on.
 * Stepping the profile keeps it passable both ways, and the height is clamped
 * to what the width can ramp up to.
 */
function cover(b: MapBuilder, x: number, deck: number, width: number, height = 1): void {
  const climbable = Math.ceil((width + 1) / 2);
  const peak = Math.min(height, climbable);
  for (let i = 0; i < width; i++) {
    const step = Math.min(i + 1, width - i, peak);
    b.rect(x + i, deck - step, x + i, deck - 1);
  }
}

// ---------- the massif ----------

/**
 * Fill the entire ridge solid and seal the world border. Everything after this
 * subtracts from the mass, which is what guarantees a connected level.
 */
function massif(b: MapBuilder): void {
  b.rect(0, RIDGE_TOP, W - 1, H - 1);
  b.slab(0, W - 1, 0); // ceiling
  b.slab(0, W - 1, H - 1); // world floor
  b.rect(0, 0, 1, H - 1); // left wall
  b.rect(W - 2, 0, W - 1, H - 1); // right wall
}

/**
 * Cut the skyline. Left cliff and right works sit high; the centre ruin sits a
 * little lower with saddles either side, so the top layer is a real route
 * rather than one flat roof.
 */
function surface(b: MapBuilder): void {
  plateau(b, 2, 3, L1 - 2); // far-left rock lip: cover behind S1
  plateau(b, 4, 32, L1); // S1 plateau
  ridge(b, 33, 41, L1, SADDLE); // slope down off the plateau
  plateau(b, 42, 50, SADDLE); // west saddle
  ridge(b, 51, 55, SADDLE, TERRACE);
  plateau(b, 56, 104, TERRACE); // central ruin terrace — W2
  ridge(b, 105, 110, TERRACE, SADDLE);
  plateau(b, 111, 120, SADDLE); // east saddle, under the old crane
  ridge(b, 121, 130, SADDLE, L1);
  plateau(b, 131, 176, L1); // S2 plateau / works roof
  plateau(b, 177, 177, L1 - 2); // far-right rock lip

  // Ruined concrete on the centre terrace. These are stepped mounds, not square
  // stubs: as flat 3-tile blocks they walled the terrace off completely and the
  // top route died 1 m from where it started.
  cover(b, 58, TERRACE, 5, 3);
  cover(b, 70, TERRACE, 5, 3);
  cover(b, 82, TERRACE, 5, 3);
  cover(b, 94, TERRACE, 3, 2);
  b.platform(62, 69, 12); // walkway between two ruins — high firing step
  b.platform(74, 81, 11);

  // Left watchtower ruin: hollow, laddered, overlooks S1 and the west saddle.
  b.rect(20, 8, 25, L1 - 1);
  b.carve(21, 9, 24, L1 - 1);
  b.ladder(22, 9, L1 - 1);

  // Right works headframe: a steel gantry over the S2 plateau.
  b.rect(150, 9, 152, L1 - 1);
  b.carve(151, 10, 151, L1 - 1);
  b.ladder(151, 10, L1 - 1);
  b.platform(140, 150, 9);
  b.platform(153, 164, 11);
}

// ---------- L2: upper caves and bridges ----------

/**
 * The gallery immediately under the skyline. Three chambers — the big left
 * cave under S1, a broken mid section open to the sky, and the works interior
 * on the right — joined by short passages, so the top layer can always be
 * flanked from inside.
 */
function upperCaves(b: MapBuilder): void {
  const [top, floor] = L2_BAND;

  // Left cave under the S1 plateau — the tallest chamber, because it has the
  // full 15-high plateau above it. W1 sits on an interior ledge.
  arch(b, 5, top, 31, floor);
  b.rect(5, floor - 4, 16, floor - 4); // interior ledge for W1, into the wall
  b.platform(17, 22, floor - 4); // step out onto the ledge
  b.rect(24, top, 25, top + 3); // hanging rock: cover, breaks the sightline
  b.ladder(8, floor - 4, floor); // ledge down to the cave floor

  // West throat: a low passage under the saddle, so the roof stays 3 tiles
  // thick where the skyline dips. Short sightlines, good ambush ground.
  arch(b, 32, THROAT_TOP, 55, floor, 2);
  b.rect(38, THROAT_TOP, 39, THROAT_TOP + 1);

  // Mid chamber under the central terrace.
  arch(b, 56, MID_TOP, 104, floor);
  b.rect(64, MID_TOP, 66, MID_TOP + 4); // pillar stubs hanging from the roof
  b.rect(80, MID_TOP, 82, MID_TOP + 4);
  b.platform(60, 74, floor - 5); // mid ledge
  b.platform(84, 98, floor - 7);
  b.platform(92, 96, floor - 3); // suspended walkway, so it cannot float as rock

  // East throat under the second saddle.
  arch(b, 105, THROAT_TOP, 130, floor, 2);
  b.rect(118, THROAT_TOP, 119, THROAT_TOP + 1);

  // The works interior on the right: two floors of concrete, W3 on the upper.
  arch(b, 131, top, 176, floor);
  b.rect(134, floor - 6, 176, floor - 6); // upper works floor
  b.carve(148, floor - 6, 151, floor - 6); // stairwell gap
  b.platform(144, 154, floor - 10);
  b.rect(140, top, 141, top + 3);
  b.rect(162, top, 163, top + 3);
  cover(b, 156, floor, 3); // crates on the lower works floor
  cover(b, 170, floor, 2, 2);
  b.ladder(138, floor - 6, floor); // upper works floor down to lower
  b.ladder(174, floor - 6, floor);
}

// ---------- L3: the central combat hall ----------

/**
 * The main arena: a run of tall rock arches with a bridge across the middle.
 * This is the widest open space on the map, deliberately broken by pillars so
 * it is never a bare shooting gallery, and it is the layer every other layer
 * drops into.
 */
function centralHall(b: MapBuilder): void {
  const [top, floor] = L3_BAND;

  // Four big arches with rock pillars between them.
  arch(b, 4, top, 40, floor, 4);
  pillar(b, 41, 45, top, floor);
  arch(b, 46, top, 84, floor, 4);
  pillar(b, 85, 89, top, floor);
  arch(b, 90, top, 128, floor, 4);
  pillar(b, 129, 133, top, floor);
  arch(b, 134, top, 176, floor, 4);

  // Doorways through the pillars, so the hall reads as one connected space and
  // the pillars are cover rather than walls.
  b.carve(41, floor - 3, 45, floor);
  b.carve(85, floor - 3, 89, floor);
  b.carve(129, floor - 3, 133, floor);

  // The central rocky bridge. It spans pillar to pillar so it is anchored at
  // both ends — a slab stopping short of the rock would be exactly the floating
  // platform this map exists to avoid. Three ways onto it: a ladder up the
  // middle and a shaft inside each pillar.
  b.rect(46, 38, 84, 39);
  b.ladder(66, 38, floor); // mid-span, down to the hall floor
  b.ladder(44, 36, floor); // inside the left pillar (not its edge column, so
  b.ladder(86, 36, floor); // the bridge ends still touch solid rock)
  cover(b, 58, 38, 5, 2); // cover on the bridge deck
  cover(b, 72, 38, 3, 2);

  // Side ledges: high ground inside the hall, all within a 1-tile step chain.
  b.rect(4, 36, 18, 37);
  b.platform(18, 26, 35);
  b.rect(160, 36, 176, 37);
  b.platform(152, 160, 35);
  b.ladder(16, 36, floor);
  b.ladder(162, 36, floor);

  // Hard cover on the hall floor.
  cover(b, 22, floor, 3, 2);
  cover(b, 34, floor, 2, 1);
  cover(b, 98, floor, 4, 2);
  cover(b, 112, floor, 2, 3);
  cover(b, 142, floor, 3, 2);
}

// ---------- L4: lower caves and industrial floor ----------

/**
 * A broad lower gallery: rock on the left, machinery and pipework on the right.
 * This is an alternative lateral route rather than the bottom of the map — it
 * runs the full width and has its own connections up and down.
 */
function lowerWorks(b: MapBuilder): void {
  const [top, floor] = L4_BAND;

  arch(b, 4, top, 58, floor, 4);
  pillar(b, 59, 62, top, floor);
  arch(b, 63, top, 118, floor, 4);
  pillar(b, 119, 122, top, floor);
  arch(b, 123, top, 176, floor, 4);
  b.carve(59, floor - 3, 62, floor);
  b.carve(119, floor - 3, 122, floor);

  // A raised rock shelf on the left, and a mid platform chain over the centre.
  // The platform starts one tile clear of the shelf: a one-way tile overwrites
  // solid, and with the ladder stripping the tile on the other side the shelf's
  // last tile would be left as a single floating rock.
  b.rect(4, floor - 5, 24, floor - 5);
  b.platform(25, 32, floor - 5);
  b.ladder(22, floor - 5, floor);
  b.platform(66, 78, floor - 6);
  b.platform(86, 98, floor - 9);

  // Industrial pipework on the right: solid runs at two heights, walkable on
  // top, with a gap so they cannot wall the gallery off.
  b.rect(123, floor - 6, 150, floor - 6); // pipe run, anchored into the pillar
  b.rect(156, floor - 9, 176, floor - 9);
  b.ladder(148, floor - 6, floor);
  b.platform(150, 156, floor - 9);

  // The big vent wheel from the reference: a stepped housing resting on the
  // deck. As a sheer 4-tile drum it floated a tile clear of the floor AND
  // could not be climbed from either side.
  cover(b, 158, L4, 9, 4);
  b.platform(167, 174, floor - 5);

  cover(b, 40, floor, 3, 2);
  cover(b, 50, floor, 2, 1);
  cover(b, 80, floor, 4, 2);
  cover(b, 104, floor, 3, 2);
  cover(b, 134, floor, 2, 2);
}

// ---------- L5: underground tunnels ----------

/**
 * The tunnel network. S3 and S4 sit in their own alcoves at opposite ends, W5
 * toward the right of centre, and the whole run has several exits upward so
 * nobody can be sealed in or camped from a single mouth.
 */
function tunnels(b: MapBuilder): void {
  const [top, floor] = L5_BAND;

  // Main gallery, kept a little lower than the spawn alcoves.
  arch(b, 6, top + 4, 174, floor, 3);

  // Spawn alcoves, raised off the gallery floor so a spawn is never in the
  // open, each with two ways out.
  arch(b, 6, top, 26, top + 6, 2); // S3, lower left
  b.rect(6, top + 7, 26, top + 7);
  b.carve(22, top + 7, 24, top + 7); // drop into the gallery
  b.ladder(10, top + 4, floor);
  cover(b, 16, top + 7, 3);

  arch(b, 154, top, 174, top + 6, 2); // S4, lower right
  b.rect(154, top + 7, 174, top + 7);
  b.carve(156, top + 7, 158, top + 7);
  b.ladder(170, top + 4, floor);
  cover(b, 164, top + 7, 3);

  // Pipework and machinery through the middle of the run.
  b.platform(60, 88, floor - 5); // suspended pipe walkway
  b.platform(52, 60, floor - 5);
  b.platform(88, 96, floor - 5);
  b.ladder(74, floor - 5, floor);
  b.platform(112, 136, floor - 4); // second pipe walkway
  b.ladder(124, floor - 4, floor);

  cover(b, 40, floor, 3, 2);
  cover(b, 100, floor, 2, 2);
  cover(b, 144, floor, 3, 2);
}

// ---------- vertical circulation ----------

/**
 * Shafts through every roof. Each layer boundary gets at least three at spread
 * x, so no single shaft can be held to cut the map in half, and each is a
 * ladder so the climb never depends on jetpack fuel.
 */
function verticals(b: MapBuilder): void {
  const l2 = L2_BAND[1];
  const l3 = L3_BAND[1];
  const l4 = L4_BAND[1];
  const l5 = L5_BAND[1];

  // Every shaft runs from the standing surface above to the STANDING SURFACE
  // BELOW — not just far enough to break through the roof. Ladders that stopped
  // a few tiles into the lower band left an 8-tile air gap between the ladder's
  // bottom and the floor, so the only way to reach one from below was to burn
  // jetpack fuel first. Columns are chosen clear of ledges, mounds, platforms
  // and pads so each ladder lands on open floor.
  //
  // Starting one row above the deck matters too: a ladder starting level with
  // the deck can only be used after falling in, never grabbed from the top.

  // Surface → L2, through the cave mouths in the skyline.
  shaft(b, 28, L1 - 1, l2, 2); // behind the S1 plateau
  shaft(b, 50, SADDLE - 1, l2, 2); // through the west saddle
  shaft(b, 100, TERRACE - 1, l2, 2); // through the centre terrace
  shaft(b, 116, SADDLE - 1, l2, 2); // through the east saddle
  shaft(b, 168, L1 - 1, l2, 2); // hatch through the works floors

  // L2 → L3.
  shaft(b, 26, l2, l3, 2);
  shaft(b, 94, l2, l3, 2);
  shaft(b, 120, l2, l3, 2);
  shaft(b, 152, l2, l3, 2);

  // L3 → L4.
  shaft(b, 34, l3, l4, 2);
  shaft(b, 74, l3, l4, 2);
  shaft(b, 110, l3, l4, 2);
  shaft(b, 152, l3, l4, 2);

  // L4 → L5.
  shaft(b, 36, l4, l5, 2);
  shaft(b, 54, l4, l5, 2);
  shaft(b, 96, l4, l5, 2);
  shaft(b, 140, l4, l5, 2);
}

/**
 * Rubble that breaks long sightlines without blocking a route. Anything on a
 * floor is a stepped mound; anything square hangs from a ceiling, where it
 * cannot obstruct walking as long as it leaves the body's 2 tiles clear.
 */
function clutter(b: MapBuilder): void {
  cover(b, 36, L2_BAND[1] + 1, 5, 2); // rubble in the west throat
  cover(b, 28, L5_BAND[1] + 1, 5, 2); // rubble in the tunnel run
  b.rect(104, L3_BAND[0], 105, L3_BAND[0] + 3); // hanging rock in the hall
  b.rect(48, L3_BAND[0], 49, L3_BAND[0] + 3);
  b.rect(94, L4_BAND[0], 95, L4_BAND[0] + 3);
}

// ---------- spawns and pickups ----------

/**
 * Spawn and pad placement. The four reference spawns are the corners — S1/S2
 * high, S3/S4 low — and four more are spread through the middle layers so all
 * eight player slots get a distinct start. No two spawns share a sightline: the
 * corner pairs are on opposite sides of the map and every one sits beside cover
 * with at least two exits.
 */
function placeEntities(b: MapBuilder): void {
  const l2Floor = L2_BAND[1];
  const l3Floor = L3_BAND[1];
  const l4Floor = L4_BAND[1];
  const l5Top = L5_BAND[0];

  // --- the four reference spawns ---
  b.spawn(10, L1 - 1); // S1 upper left, behind the rock lip and the tower
  b.spawn(166, L1 - 1); // S2 upper right, on the works roof
  b.spawn(12, l5Top + 6); // S3 lower left alcove
  b.spawn(168, l5Top + 6); // S4 lower right alcove

  // --- four more, spread over the middle layers, for 8-player matches ---
  b.spawn(20, l2Floor); // upper-left cave
  b.spawn(164, l2Floor); // works lower floor, clear of the crate stacks
  // Raised onto the left shelf rather than the gallery floor: on the floor it
  // shared row 61 with the spawn opposite, and the pillar doorways left that
  // row open end to end — a clean cross-map sightline between two spawns.
  b.spawn(14, l4Floor - 6); // lower-left shelf
  b.spawn(150, l4Floor); // lower-right pipework

  // --- weapons: the five reference locations, one per layer ---
  b.pad(12, l2Floor - 5, PadKind.Weapon); // W1 upper-left cave ledge
  b.pad(78, TERRACE - 1, PadKind.Weapon); // W2 central ruin terrace
  b.pad(160, l2Floor - 7, PadKind.Weapon); // W3 upper works floor
  b.pad(70, l4Floor, PadKind.Weapon); // W4 lower-central cave
  b.pad(130, L5_BAND[1], PadKind.Weapon); // W5 lower-right underground

  // Two more weapon pads on the contested middle layer, so the main arena is
  // worth fighting over rather than just crossed. Both stay clear of the
  // ladder columns, or the pad would have no floor under it.
  b.pad(68, 37, PadKind.Weapon); // on the central bridge
  b.pad(10, 35, PadKind.Weapon); // hall left ledge

  // --- health: one per layer, away from the weapon pads ---
  b.pad(44, SADDLE - 1, PadKind.Health); // west saddle
  b.pad(104, l2Floor, PadKind.Health);
  b.pad(120, l3Floor, PadKind.Health);
  b.pad(46, l4Floor, PadKind.Health);
  b.pad(92, L5_BAND[1], PadKind.Health); // clear of the x96 shaft
  b.pad(170, l3Floor, PadKind.Health);

  // --- ammo: on the through-routes ---
  b.pad(54, l2Floor, PadKind.Ammo); // west throat, clear of rubble and the shaft
  b.pad(26, l3Floor, PadKind.Ammo);
  b.pad(146, l3Floor, PadKind.Ammo);
  b.pad(84, l4Floor, PadKind.Ammo);
  b.pad(56, L5_BAND[1], PadKind.Ammo);

  // --- grenades: at the contested crossings ---
  b.pad(88, TERRACE - 1, PadKind.Grenade); // centre terrace, between a ruin and the shaft
  b.pad(76, 37, PadKind.Grenade); // bridge approach
  b.pad(114, l4Floor, PadKind.Grenade);
}

/** Exported for tests that need the layer decks without re-deriving them. */
export const HOLLOW_WORKS_DECKS = { L1, L2, L3, L4, L5, width: W, height: H } as const;

/** Exported so tests can assert the tile legend is used as intended. */
export const HOLLOW_WORKS_FLAGS = TileFlag;
