import { MapBuilder, PadKind, type MapDef } from './mapdef.js';

/**
 * "Outpost Delta" — a large symmetric military-outpost arena.
 *
 * 175 × 98 tiles = 5600 × 3136 px at 32 px/m, matching the brief.
 *
 * The map is built rather than drawn as ASCII: at this size a hand-kept text
 * grid is unreviewable and symmetry would drift. Only the left half and the
 * centre column are authored; `mirror()` produces the right half exactly, so
 * "perfectly symmetrical" is structural rather than a promise. A connectivity
 * test flood-fills the finished map and fails if any spawn or pad is walled
 * off, which is what keeps hand-placed coordinates honest.
 *
 * Vertical bands (y grows downward):
 *   26–33  sniper nest ledges
 *   44     mountain plateau (top step)
 *   58     middle step
 *   70     lower step
 *   84     battlefield floor
 *   85–96  tunnel network
 *
 * Horizontal, mirrored about x = 87:
 *   2–34   flank mountain: three steps, caves, sniper nest above
 *   35–61  open battlefield with hard cover
 *   62–87  central bunker: basement, three decks, roof and watchtower
 */

const W = 175;
const H = 98;
/** Column of symmetry: everything left of it is mirrored to the right. */
const AXIS = 87;

/** First solid row of the battlefield floor. */
const GROUND = 84;
/** Standing surface of the battlefield. */
const FLOOR = GROUND - 1;

/** Mountain step tops (first solid row of each step). */
const STEP_LOW = 70;
const STEP_MID = 58;
const STEP_TOP = 44;
/** Upper crag, splitting the long climb to the nest. */
const CRAG = 30;
/** Sniper nest: the highest ledge on the map. */
const NEST = 14;
/** High catwalk running inward from the mountain toward the bunker roof. */
const CATWALK = 22;

/** Bunker footprint (left edge only — the right half is mirrored). */
const BUNKER_X = 62;
const BUNKER_TOP = 40;

export function createOutpostDeltaMap(): MapDef {
  const b = new MapBuilder('outpost_delta', 'Outpost Delta', W, H);

  bedrock(b);
  mountain(b);
  battlefield(b);
  tunnels(b);
  bunker(b);
  placeEntities(b);

  return b.mirror(AXIS).build();
}

/** Ground mass, underground rock and the sealed arena border. */
function bedrock(b: MapBuilder): void {
  b.rect(0, GROUND, AXIS, H - 1); // everything below the battlefield is rock
  b.rect(0, 0, 1, H - 1); // outer wall
  b.slab(0, AXIS, 0); // ceiling
  b.slab(0, AXIS, H - 1); // world floor
}

/**
 * The flank mountain: a three-step staircase rising from the battlefield to a
 * plateau, with a sniper ledge above it. Each step is hollowed into a cave, so
 * the high ground can always be flanked from inside as well as climbed.
 *
 * Every level has at least two routes: a ladder up the step face, and a
 * one-way platform chain reaching in from the battlefield side.
 */
function mountain(b: MapBuilder): void {
  // --- the three solid steps, each sitting on the floor ---
  b.rect(2, STEP_TOP, 14, GROUND - 1); // top step
  b.rect(15, STEP_MID, 24, GROUND - 1); // middle step
  b.rect(25, STEP_LOW, 34, GROUND - 1); // lower step

  // --- caves cut through each step ---
  // Base cave: the bottom-left spawn room, open east to the battlefield.
  b.carve(26, 75, 35, GROUND - 1);
  b.carve(20, 78, 25, GROUND - 1); // burrows under the middle step
  // Middle cave, open east onto the lower step.
  b.carve(16, 62, 24, 67);
  b.carve(24, 64, 25, 67); // mouth
  // Upper cave inside the top step, open east onto the middle step.
  b.carve(4, 48, 13, 54);
  b.carve(13, 51, 15, 54); // mouth

  // --- upper crag: breaks the long climb to the nest in two ---
  b.rect(2, CRAG, 12, CRAG + 3);
  b.carve(4, CRAG + 1, 9, CRAG + 3); // hollow: a covered firing position

  // --- sniper nest, the highest ledge on the map ---
  b.rect(3, NEST, 13, NEST + 3);
  b.rect(3, NEST - 2, 5, NEST - 1); // rock lip: cover, and it breaks the sight
  b.rect(11, NEST - 2, 13, NEST - 1); // line straight down onto spawn 1

  // --- high catwalk: a top-level route from the mountain toward the bunker ---
  b.platform(14, 22, NEST - 1);
  b.platform(22, 34, CATWALK);
  b.rect(34, CATWALK, 37, CATWALK + 2); // outcrop anchoring the catwalk
  b.platform(38, 50, CATWALK + 4);
  b.rect(44, CATWALK + 10, 47, CATWALK + 11); // floating rock, jetpack cover
  b.platform(52, 60, CATWALK + 8);

  // --- ladders: one up each step face, in open air ---
  b.ladder(35, STEP_LOW - 1, FLOOR); // battlefield → lower step
  b.ladder(25, STEP_MID - 1, STEP_LOW - 1); // lower → middle
  b.ladder(15, STEP_TOP - 1, STEP_MID - 1); // middle → plateau
  b.ladder(10, CRAG + 3, STEP_TOP - 1); // plateau → crag
  b.ladder(6, NEST - 1, CRAG - 1); // crag → sniper nest (shaft through the ledge)

  // --- one-way platforms: the second route to every level ---
  b.platform(36, 44, STEP_LOW - 1);
  b.platform(26, 33, STEP_MID - 1);
  b.platform(16, 23, STEP_TOP - 1);
  b.platform(13, 20, CRAG - 1);
}

/** The open combat floor between the mountains and the bunker. */
function battlefield(b: MapBuilder): void {
  // Hard cover so the middle is never a bare shooting gallery.
  const cover: [number, number, number][] = [
    [38, 3, 2], // [x, width, height above the floor]
    [44, 2, 3],
    [50, 4, 2],
    [56, 2, 3],
  ];
  for (const [x, w, h] of cover) b.rect(x, GROUND - h, x + w - 1, FLOOR);

  // A raised sandbag firing step, reachable and useful for the bunker approach.
  b.rect(46, GROUND - 5, 49, GROUND - 5);
  b.platform(43, 52, GROUND - 9);
}

/**
 * Winding tunnels under the battlefield: a gallery with ambush pockets, two
 * surface shafts, and a rise into the bunker basement. Every tunnel has at
 * least two exits so nobody can be sealed in.
 */
function tunnels(b: MapBuilder): void {
  const roof = GROUND + 3;
  const deep = GROUND + 8;

  b.carve(8, roof, 60, deep); // main gallery
  b.carve(14, roof - 3, 18, roof - 1); // ambush pocket, up under the mountain
  b.carve(38, roof - 2, 42, roof - 1);
  b.carve(52, roof - 2, 56, roof - 1);

  // Shaft from the battlefield floor down into the gallery.
  b.carve(40, GROUND, 41, roof - 1);
  b.ladder(40, FLOOR, deep - 1);
  // Second shaft, from the mountain base cave.
  b.carve(30, GROUND, 31, roof - 1);
  b.ladder(30, FLOOR, deep - 1);
  // Rise into the bunker basement.
  b.carve(58, roof - 4, 60, deep);
  b.ladder(59, roof - 4, deep - 1);
  b.carve(58, GROUND, 60, roof - 4);
}

/**
 * The central bunker: basement, three decks and a sandbagged roof with a
 * watchtower. Each deck is reachable by a ladder near the outer wall *and* a
 * stairwell gap near the centre, so no single defender can hold both.
 */
function bunker(b: MapBuilder): void {
  const x0 = BUNKER_X;
  const top = BUNKER_TOP;

  b.rect(x0, top, AXIS, GROUND - 1); // solid shell

  /** Deck interiors as [ceiling, floor-surface] pairs. */
  const decks: [number, number][] = [
    [top + 3, top + 9], // upper floor
    [top + 13, top + 19], // middle floor
    [top + 23, top + 29], // ground floor
    [top + 33, GROUND - 1], // basement
  ];
  for (const [y0, y1] of decks) b.carve(x0 + 2, y0, AXIS, y1);

  // Interior cover on every deck: a crate stack and a hanging pillar.
  for (const [y0, y1] of decks) {
    b.rect(x0 + 8, y1 - 1, x0 + 9, y1);
    b.rect(x0 + 15, y0, x0 + 15, y0 + 2);
  }

  // Window slits on the outer face — shoot out, and be shot at.
  for (const [, y1] of decks) b.carve(x0, y1 - 2, x0 + 1, y1 - 1);

  // Vertical circulation.
  b.ladder(x0 + 4, top + 3, GROUND - 1); // outer ladder shaft, all decks
  for (const [, y1] of decks) b.carve(x0 + 18, y1, x0 + 20, y1); // stairwell gaps
  b.platform(x0 + 16, x0 + 22, top + 11);
  b.platform(x0 + 16, x0 + 22, top + 21);
  b.platform(x0 + 16, x0 + 22, top + 31);

  // Ground-level doorway to the battlefield and the basement mouth.
  b.carve(x0, top + 24, x0 + 1, top + 29);
  b.carve(x0, top + 34, x0 + 1, GROUND - 1);

  // Roof: parapet, watchtower and a way up from the top deck.
  b.rect(x0, top - 2, x0 + 1, top - 1); // parapet
  b.rect(x0 + 24, top - 2, AXIS, top - 1);
  // Watchtower: tall enough to contest the catwalk band, hollow, with a ladder.
  b.rect(x0 + 10, top - 16, x0 + 13, top - 1);
  b.carve(x0 + 11, top - 15, x0 + 12, top - 1);
  b.ladder(x0 + 11, top - 15, top - 1);
  b.platform(x0 + 6, x0 + 10, top - 16); // tower-top landing, reachable by air
  b.platform(x0 + 14, x0 + 20, top - 10);
  b.carve(x0 + 2, top, x0 + 2, top); // roof hatch
  b.ladder(x0 + 2, top - 1, top + 8);

  // Outside ramp up the bunker flank: one-way platforms every few metres, so
  // the roof is reachable without ever entering the building.
  b.platform(x0 - 11, x0 - 4, top + 28);
  b.platform(x0 - 15, x0 - 8, top + 20);
  b.platform(x0 - 11, x0 - 4, top + 12);
  b.platform(x0 - 15, x0 - 8, top + 4);
  b.platform(x0 - 9, x0 - 1, top - 1);
}

/**
 * Spawns and pickups. Spawn order matches the brief: authoring 1, 3, 5 on the
 * left makes `mirror()` append 2, 4, 6 on the right, so the pairs are exactly
 * balanced. Every position here is verified open and reachable by the
 * connectivity test.
 */
function placeEntities(b: MapBuilder): void {
  b.spawn(8, STEP_TOP - 1); // Spawn 1 — top left, mountain plateau
  b.spawn(29, GROUND - 1); // Spawn 3 — bottom left, base cave
  b.spawn(20, 67); // Spawn 5 — middle left, middle cave

  // Health: bunker interior, mid-mountain, and the battlefield approach.
  b.pad(BUNKER_X + 12, BUNKER_TOP + 9, PadKind.Health);
  b.pad(19, 67, PadKind.Health);
  b.pad(55, GROUND - 1, PadKind.Health);

  // Ammo: outer corners, high and low.
  b.pad(6, 49, PadKind.Ammo); // inside the upper cave
  b.pad(6, CRAG + 3, PadKind.Health); // upper crag
  b.pad(33, GROUND - 1, PadKind.Ammo);

  // Weapons: one per height band, on both the mountain and the bunker.
  b.pad(8, NEST - 1, PadKind.Weapon); // sniper nest, standing on the ledge
  b.pad(30, STEP_LOW - 1, PadKind.Weapon); // lower step
  b.pad(18, STEP_TOP - 1, PadKind.Weapon); // plateau edge
  b.pad(41, GROUND - 1, PadKind.Weapon); // battlefield
  b.pad(35, GROUND + 6, PadKind.Weapon); // tunnel gallery
  b.pad(BUNKER_X + 12, BUNKER_TOP + 19, PadKind.Weapon); // bunker middle deck
  b.pad(BUNKER_X + 20, BUNKER_TOP - 1, PadKind.Weapon); // roof

  // Grenades: contested crossings.
  b.pad(24, 67, PadKind.Grenade);
  b.pad(28, CATWALK - 1, PadKind.Grenade); // high catwalk
  b.pad(BUNKER_X + 12, BUNKER_TOP + 29, PadKind.Grenade);
}
