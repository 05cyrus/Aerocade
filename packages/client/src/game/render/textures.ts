import type Phaser from 'phaser';
import { WeaponId } from '@aerocade/shared';

/**
 * All Aerocade art is generated procedurally at boot — shapes, gradients, and
 * palette are original code, guaranteeing zero third-party assets.
 *
 * Everything lands in a SINGLE runtime atlas texture. That is a hard
 * performance requirement, not a tidiness preference (docs/performance.md):
 * sprites drawn from different textures force a WebGL batch flush each, and
 * an 8-player articulated rig is ~9 sprites per player. Measured on the
 * software rasterizer, one-texture-per-part cost ~3.5× the frame time of the
 * atlas build.
 *
 * Character parts are drawn at 2× and rendered at RIG_SCALE for clean edges.
 */

/** Pixels per simulation meter. */
export const PX_PER_M = 32;

/** Supersampling factor for character part textures. */
const SS = 2;
/** Scale rig sprites by this to display supersampled frames at 1×. */
export const RIG_SCALE = 1 / SS;

/** The one texture every game object samples from. */
export const ATLAS = 'aerocade-atlas';

/** Transparent gutter between packed frames so filtering can't bleed. */
const PAD = 2;
const ATLAS_WIDTH = 320;

export const PLAYER_COLORS: readonly number[] = [
  0x3cd6ff, 0xffa03c, 0x55e08c, 0xff4d5e, 0xc77dff, 0xf5e663, 0x6bc1ff, 0xff8fb3,
];

/**
 * Character palette, locked by docs/character.md: olive uniform, warm
 * near-black gear, flat fills, one heavy outline. Read that doc before
 * changing any value here.
 *
 * The uniform is deliberately NOT tintable. Phaser tint multiplies, so an
 * olive base under a saturated team color goes muddy — player color lives on
 * the insignia and helmet band instead, which are drawn on TEAM_BASE.
 */
const INK = 0x23241d; // outlines, face mask, vest, gloves, boots
const OLIVE = 0x6b7040; // the uniform — dominant color
const OLIVE_SHADE = 0x4a5230; // undersides and back-facing surfaces
const GEAR = 0x33352a; // pads and pouches: a step off ink so they still read
const HARD_GREY = 0x3f3f3f; // boot soles and buckles — neutral, never blue
const SKIN = 0xf0c088; // exposed eye band and fingertips
const EYE_WHITE = 0xf2efe4;
const GUNMETAL = 0x2c3346;
const GUNMETAL_LIGHT = 0x4a5470;
/** Near-white base for the only two team-tinted parts. */
const TEAM_BASE = 0xf2f4f8;

/** Frame names within the atlas. */
export const Frames = {
  Tile: 'tile',
  Head: 'head',
  Torso: 'torso',
  Leg: 'leg',
  Arm: 'arm',
  Jetpack: 'jetpack',
  /** Shoulder insignia — near-white, carries the player's team color. */
  Insignia: 'insignia',
  /** Helmet side pad — near-white, carries the player's team color. */
  HelmetPad: 'helmet-pad',
  Rocket: 'rocket',
  Grenade: 'grenade',
  Spark: 'spark',
  Muzzle: 'muzzle',
  /** Glowing floor disc marking a weapon pad. */
  Pad: 'pad',
  /** Ladder rung section, tiled vertically. */
  Ladder: 'ladder',
  /** Thin one-way platform: stand on top, jump up through. */
  Platform: 'platform',
  /** Health box. */
  HealthBox: 'health-box',
  /** Ammo crate. */
  AmmoBox: 'ammo-box',
  /**
   * Plain white rounded rect, drawn twice per overhead health bar (dark
   * backing + tinted fill). A tintable sprite keeps bars inside the atlas
   * batch; a per-player `Graphics` would flush it every frame.
   */
  Bar: 'bar',
} as const;

/**
 * Crop one atlas frame into a standalone data URL, so DOM UI can show the
 * exact same generated art the canvas draws — no second set of icons to keep
 * in sync. Called once per weapon at boot; never in a hot path.
 */
export function frameDataUrl(scene: Phaser.Scene, frameName: string, scale = 2): string {
  const texture = scene.textures.get(ATLAS);
  if (!texture.has(frameName)) {
    // Phaser hands back the __BASE frame for an unknown name, which would
    // render the entire atlas as the icon. Fail visibly instead.
    console.error(`atlas frame "${frameName}" is missing`);
    return '';
  }
  const frame = texture.get(frameName);
  const source = texture.getSourceImage();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    source as CanvasImageSource,
    frame.cutX,
    frame.cutY,
    frame.width,
    frame.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas.toDataURL();
}

/** Atlas frame name for a weapon's held silhouette. */
export function weaponFrame(id: WeaponId): string {
  return `gun-${String(id)}`;
}

interface Part {
  name: string;
  w: number;
  h: number;
  draw: (g: Phaser.GameObjects.Graphics, ox: number, oy: number) => void;
}

/**
 * Build the atlas: draw every part into one Graphics at packed offsets,
 * bake it to a texture, then register each part's rectangle as a frame.
 */
export function generateTextures(scene: Phaser.Scene): void {
  const parts = collectParts();

  // Shelf-pack into rows of ATLAS_WIDTH.
  const placed: { part: Part; x: number; y: number }[] = [];
  let cursorX = PAD;
  let cursorY = PAD;
  let rowHeight = 0;
  for (const part of parts) {
    if (cursorX + part.w + PAD > ATLAS_WIDTH) {
      cursorX = PAD;
      cursorY += rowHeight + PAD;
      rowHeight = 0;
    }
    placed.push({ part, x: cursorX, y: cursorY });
    cursorX += part.w + PAD;
    rowHeight = Math.max(rowHeight, part.h);
  }
  const atlasHeight = cursorY + rowHeight + PAD;

  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  for (const { part, x, y } of placed) {
    part.draw(g, x, y);
  }
  g.generateTexture(ATLAS, ATLAS_WIDTH, atlasHeight);
  g.destroy();

  const texture = scene.textures.get(ATLAS);
  for (const { part, x, y } of placed) {
    texture.add(part.name, 0, x, y, part.w, part.h);
  }
}

function collectParts(): Part[] {
  return [
    { name: Frames.Tile, w: PX_PER_M, h: PX_PER_M, draw: drawTile },
    { name: Frames.Head, w: 36, h: 32, draw: drawHead },
    { name: Frames.Torso, w: 32, h: 36, draw: drawTorso },
    { name: Frames.Leg, w: 14, h: 40, draw: drawLeg },
    { name: Frames.Arm, w: 24, h: 12, draw: drawArm },
    { name: Frames.Jetpack, w: 20, h: 34, draw: drawJetpack },
    { name: Frames.Insignia, w: 10, h: 10, draw: drawInsignia },
    { name: Frames.HelmetPad, w: 10, h: 10, draw: drawHelmetPad },
    { name: weaponFrame(WeaponId.RivetPistol), w: 24, h: 20, draw: drawPistol },
    { name: weaponFrame(WeaponId.VortexSmg), w: 36, h: 24, draw: drawSmg },
    { name: weaponFrame(WeaponId.PulseRifle), w: 46, h: 22, draw: drawRifle },
    { name: weaponFrame(WeaponId.Scattergun), w: 42, h: 22, draw: drawScattergun },
    { name: weaponFrame(WeaponId.LongboltRifle), w: 58, h: 18, draw: drawLongbolt },
    { name: weaponFrame(WeaponId.Thumper), w: 48, h: 20, draw: drawThumper },
    { name: weaponFrame(WeaponId.Lobber), w: 42, h: 24, draw: drawLobber },
    { name: Frames.Rocket, w: 16, h: 6, draw: drawRocket },
    { name: Frames.Grenade, w: 10, h: 10, draw: drawGrenade },
    { name: Frames.Pad, w: 48, h: 20, draw: drawPad },
    { name: Frames.Bar, w: 64, h: 10, draw: drawBar },
    { name: Frames.Ladder, w: PX_PER_M, h: PX_PER_M, draw: drawLadder },
    { name: Frames.Platform, w: PX_PER_M, h: 10, draw: drawPlatform },
    { name: Frames.HealthBox, w: 22, h: 22, draw: drawHealthBox },
    { name: Frames.AmmoBox, w: 24, h: 20, draw: drawAmmoBox },
    {
      name: Frames.Spark,
      w: 16,
      h: 16,
      draw: (g, x, y) => {
        drawRadial(g, x, y, 8, 0xffffff);
      },
    },
    {
      name: Frames.Muzzle,
      w: 20,
      h: 20,
      draw: (g, x, y) => {
        drawRadial(g, x, y, 10, 0xffe0a0);
      },
    },
  ];
}

// ---------- world ----------

function drawTile(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0x2a3350, 1);
  g.fillRect(ox, oy, PX_PER_M, PX_PER_M);
  g.fillStyle(0x333e63, 1);
  g.fillRect(ox + 1, oy + 1, PX_PER_M - 2, PX_PER_M - 2);
  g.fillStyle(0x2e3859, 1);
  g.fillRect(ox + 3, oy + 3, PX_PER_M - 6, PX_PER_M - 6);
  g.fillStyle(0x445081, 1);
  g.fillRect(ox, oy, PX_PER_M, 2); // top highlight reads as a walkable edge
}

// ---------- character parts (side view, facing right, at 2× scale) ----------
//
// The soldier is locked by docs/character.md. Two rules run through every part
// below. Each draws its INK silhouette first and insets the fills by OUTLINE,
// because that heavy outline — not shading — is what makes an 16 px figure read
// against both bright sky and dark terrain. And fills are flat: one shade tone
// per material, no gradients, no rim light.
//
// These are SIDE projections. The game is a side-scroller and the rig mirrors
// on facing, so the reference turnaround's front/back views are identity guides
// rather than frames to draw: one eye, one arm, and the pouch row seen edge-on.

/** Ink border thickness at 2× authoring — 1 px on screen. */
const OUTLINE = 2;

/**
 * Helmeted head: domed shell over an exposed eye band and a balaclava. No
 * visor and no antenna — both are off-model (docs/character.md).
 */
function drawHead(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  // Silhouette: helmet dome, then the jaw mass hanging below it.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy, 36, 24, { tl: 16, tr: 16, bl: 7, br: 7 });
  g.fillRoundedRect(ox + 5, oy + 14, 29, 18, { tl: 4, tr: 9, bl: 7, br: 9 });

  // Shell, with a shade band along its lower edge.
  g.fillStyle(OLIVE, 1);
  g.fillRoundedRect(ox + OUTLINE, oy + OUTLINE, 32, 20, { tl: 14, tr: 14, bl: 6, br: 6 });
  g.fillStyle(OLIVE_SHADE, 1);
  g.fillRoundedRect(ox + OUTLINE, oy + 14, 32, 8, { tl: 0, tr: 0, bl: 6, br: 6 });

  // Brow brim, jutting forward over the eyes.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 19, oy + 13, 17, 6, 3);
  g.fillStyle(OLIVE_SHADE, 1);
  g.fillRoundedRect(ox + 20, oy + 14, 15, 3, 1.5);

  // Side accessory pad and its four rivets.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 6, oy + 7, 11, 11, 3);
  g.fillStyle(GEAR, 1);
  g.fillRoundedRect(ox + 7, oy + 8, 9, 9, 2);
  g.fillStyle(INK, 1);
  g.fillRect(ox + 9, oy + 10, 2, 2);
  g.fillRect(ox + 13, oy + 10, 2, 2);
  g.fillRect(ox + 9, oy + 14, 2, 2);
  g.fillRect(ox + 13, oy + 14, 2, 2);

  // Balaclava over nose, mouth and jaw.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 15, oy + 23, 19, 9, { tl: 2, tr: 6, bl: 5, br: 7 });

  // Exposed skin, then the single visible eye and an angled brow. Only one
  // face is authored: at 16 px the reference's six expressions cannot resolve.
  g.fillStyle(SKIN, 1);
  g.fillRoundedRect(ox + 20, oy + 18, 15, 6, { tl: 1, tr: 4, bl: 1, br: 2 });
  g.fillStyle(EYE_WHITE, 1);
  g.fillRoundedRect(ox + 26, oy + 19, 7, 5, 2);
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 29, oy + 20, 3, 4, 1); // iris, looking forward
  g.fillTriangle(ox + 24, oy + 19.5, ox + 33.5, oy + 17, ox + 33.5, oy + 19.5);
}

/** Olive jacket under a near-black tactical vest, belted at the waist. */
function drawTorso(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy, 32, 36, 9);

  g.fillStyle(OLIVE, 1);
  g.fillRoundedRect(ox + OUTLINE, oy + OUTLINE, 28, 32, 7);
  g.fillStyle(OLIVE_SHADE, 1); // the back (left) falls into shade
  g.fillRoundedRect(ox + OUTLINE, oy + OUTLINE, 10, 32, { tl: 7, tr: 0, bl: 7, br: 0 });

  // Vest: one near-black mass over the chest.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 6, oy + 5, 24, 21, { tl: 4, tr: 6, bl: 3, br: 5 });

  // The four-pouch row, seen edge-on from the side as a stack.
  g.fillStyle(GEAR, 1);
  g.fillRoundedRect(ox + 20, oy + 8, 9, 7, 2);
  g.fillRoundedRect(ox + 20, oy + 17, 9, 7, 2);
  g.fillStyle(INK, 1);
  g.fillRect(ox + 20, oy + 11, 9, 1.5); // buckle straps
  g.fillRect(ox + 20, oy + 20, 9, 1.5);

  // Belt.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 2, oy + 28, 28, 7, 3);
  g.fillStyle(HARD_GREY, 1);
  g.fillRect(ox + 13, oy + 30, 6, 4); // buckle
}

/** One leg: olive trouser, knee pad, and a boot wider than the shin. */
function drawLeg(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 1, oy, 12, 30, 5); // trouser
  g.fillRoundedRect(ox, oy + 26, 14, 14, { tl: 3, tr: 3, bl: 4, br: 4 }); // boot

  g.fillStyle(OLIVE, 1);
  g.fillRoundedRect(ox + 3, oy + 1, 8, 27, 4);
  g.fillStyle(OLIVE_SHADE, 1);
  g.fillRoundedRect(ox + 3, oy + 1, 4, 27, { tl: 4, tr: 0, bl: 4, br: 0 });

  // Knee pad with rivets.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 2, oy + 13, 11, 10, 4);
  g.fillStyle(GEAR, 1);
  g.fillRoundedRect(ox + 3, oy + 14, 9, 8, 3);
  g.fillStyle(INK, 1);
  g.fillRect(ox + 5, oy + 16, 2, 2);
  g.fillRect(ox + 9, oy + 16, 2, 2);

  // Boot: lace hint, then a treaded sole. Grey rather than olive-dark, or the
  // black boot just merges into the trouser above it at 20 px.
  g.fillStyle(HARD_GREY, 1);
  g.fillRect(ox + 4, oy + 29, 7, 1.5);
  g.fillRect(ox + 4, oy + 32, 7, 1.5);
  g.fillRoundedRect(ox, oy + 36, 14, 4, 2);
}

/** Forearm with elbow pad and a fingerless glove. Pivot at the left end. */
function drawArm(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy + 1, 18, 10, 5); // sleeve
  g.fillRoundedRect(ox + 14, oy, 10, 12, 5); // glove

  g.fillStyle(OLIVE, 1);
  g.fillRoundedRect(ox + 1, oy + 2, 16, 8, 4);
  g.fillStyle(OLIVE_SHADE, 1);
  g.fillRoundedRect(ox + 1, oy + 2, 6, 8, { tl: 4, tr: 0, bl: 4, br: 0 });

  // Elbow pad.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 4, oy + 1, 9, 10, 4);
  g.fillStyle(GEAR, 1);
  g.fillRoundedRect(ox + 5, oy + 2, 7, 8, 3);

  // Fingertips left bare by the glove.
  g.fillStyle(SKIN, 1);
  g.fillRoundedRect(ox + 21, oy + 3, 3, 6, 1.5);
}

/**
 * The pack. Styled as the reference's buckled olive rucksack, with thruster
 * nozzles beneath: one part reads as a backpack standing still and as a
 * jetpack when it fires. The amber plume is the emitter's job, not the art's.
 */
function drawJetpack(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy, 20, 28, 7);

  g.fillStyle(OLIVE, 1);
  g.fillRoundedRect(ox + OUTLINE, oy + OUTLINE, 16, 24, 5);
  g.fillStyle(OLIVE_SHADE, 1);
  g.fillRoundedRect(ox + OUTLINE, oy + OUTLINE, 6, 24, { tl: 5, tr: 0, bl: 5, br: 0 });

  // Two buckle straps and a side pouch.
  g.fillStyle(INK, 1);
  g.fillRect(ox + OUTLINE, oy + 7, 16, 2);
  g.fillRect(ox + OUTLINE, oy + 17, 16, 2);
  g.fillRoundedRect(ox + 4, oy + 10, 11, 6, 2);
  g.fillStyle(GEAR, 1);
  g.fillRoundedRect(ox + 5, oy + 11, 9, 4, 1.5);

  // Twin nozzles.
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 2, oy + 25, 7, 9, 2);
  g.fillRoundedRect(ox + 11, oy + 25, 7, 9, 2);
  g.fillStyle(HARD_GREY, 1);
  g.fillRect(ox + 3, oy + 31, 5, 2);
  g.fillRect(ox + 12, oy + 31, 5, 2);
}

/**
 * Shoulder insignia — the reference's three stripes, on a near-white base so
 * tint colors them. With the uniform locked olive and untinted, this and the
 * helmet pad are the only parts carrying player color, so eight soldiers stay
 * tellable apart. Stripes rather than a solid block on purpose: a filled patch
 * this small reads as a glowing panel instead of cloth.
 */
function drawInsignia(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy, 10, 10, 2);
  g.fillStyle(TEAM_BASE, 1);
  g.fillRect(ox + 2, oy + 2, 6, 1.5);
  g.fillRect(ox + 2, oy + 4.5, 6, 1.5);
  g.fillRect(ox + 2, oy + 7, 6, 1.5);
}

/**
 * Helmet side pad — the second team-colored part. It overlays the dark pad
 * drawn by drawHead, reusing a shape the reference already puts on the helmet.
 * Its rivets stay ink so the pad reads as gear rather than a lamp; an earlier
 * attempt used a band across the brow and simply looked like the visor this
 * design removed.
 */
function drawHelmetPad(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy, 10, 10, 3);
  g.fillStyle(TEAM_BASE, 1);
  g.fillRoundedRect(ox + 1.5, oy + 1.5, 7, 7, 2);
  g.fillStyle(INK, 1);
  g.fillRect(ox + 3, oy + 3, 1.5, 1.5);
  g.fillRect(ox + 5.5, oy + 3, 1.5, 1.5);
  g.fillRect(ox + 3, oy + 5.5, 1.5, 1.5);
  g.fillRect(ox + 5.5, oy + 5.5, 1.5, 1.5);
}

// ---------- weapons (original silhouettes, muzzle pointing right) ----------

function drawPistol(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox, oy, 22, 9, 3); // slide
  g.fillRoundedRect(ox + 2, oy + 7, 8, 12, 3); // grip
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRect(ox + 16, oy + 1, 6, 3);
}

function drawSmg(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox, oy + 2, 30, 10, 3); // body
  g.fillRect(ox + 28, oy + 4, 8, 5); // stub barrel
  g.fillRoundedRect(ox + 12, oy + 10, 8, 14, 2); // magazine
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRect(ox + 4, oy, 10, 3); // top rail
  g.fillStyle(0x3cd6ff, 0.8);
  g.fillRect(ox + 24, oy + 4, 2, 4); // cell glow
}

function drawRifle(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox + 4, oy + 2, 34, 9, 3); // body
  g.fillRect(ox + 36, oy + 4, 10, 5); // barrel
  g.fillRoundedRect(ox, oy + 3, 6, 12, 2); // stock
  g.fillRoundedRect(ox + 16, oy + 10, 7, 12, 2); // magazine
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRect(ox + 10, oy, 16, 3); // rail
  g.fillStyle(0x3cd6ff, 0.8);
  g.fillRect(ox + 32, oy + 4, 2, 5);
}

function drawScattergun(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox, oy + 3, 38, 12, 4); // receiver
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRect(ox + 26, oy + 5, 14, 3); // upper tube
  g.fillRect(ox + 26, oy + 10, 14, 3); // lower tube
  g.fillStyle(0xffa03c, 1);
  g.fillRoundedRect(ox + 14, oy + 15, 12, 6, 2); // pump grip
}

function drawLongbolt(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox + 2, oy + 4, 30, 8, 3); // receiver
  g.fillRect(ox + 30, oy + 6, 26, 4); // long barrel
  g.fillRoundedRect(ox, oy + 5, 5, 11, 2); // stock
  g.fillRect(ox + 54, oy + 5, 3, 6); // muzzle brake
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRoundedRect(ox + 12, oy, 14, 5, 2); // scope
  g.fillStyle(0x3cd6ff, 0.9);
  g.fillRect(ox + 24, oy + 1, 2, 3); // lens
}

function drawThumper(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox, oy + 2, 44, 14, 6); // tube
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRoundedRect(ox + 38, oy, 10, 18, 5); // muzzle ring
  g.fillStyle(INK, 1);
  g.fillCircle(ox + 43, oy + 9, 5); // bore
  g.fillStyle(0xffa03c, 1);
  g.fillRect(ox + 8, oy + 4, 4, 10); // hazard stripes
  g.fillRect(ox + 16, oy + 4, 4, 10);
}

function drawLobber(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(GUNMETAL, 1);
  g.fillRoundedRect(ox + 4, oy + 3, 30, 10, 4); // body
  g.fillRect(ox + 32, oy + 5, 8, 6); // muzzle
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillCircle(ox + 16, oy + 13, 8); // drum
  g.fillStyle(INK, 0.5);
  g.fillCircle(ox + 16, oy + 13, 4);
}

// ---------- projectiles & effects ----------

function drawRocket(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0xe8edff, 1);
  g.fillRoundedRect(ox, oy, 16, 6, 3);
  g.fillStyle(0xffa03c, 1);
  g.fillRect(ox, oy + 1, 4, 4); // exhaust cap
}

function drawGrenade(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0x55e08c, 1);
  g.fillCircle(ox + 5, oy + 5, 5);
  g.fillStyle(0x101828, 1);
  g.fillRect(ox + 4, oy, 2, 3); // pin nub
}

/**
 * Weapon-pad marker: a flat glowing disc that sits on the floor so players can
 * spot a pad — and tell a stocked one from an empty one — at a glance.
 */
function drawPad(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  for (let i = 6; i >= 1; i--) {
    g.fillStyle(0x3cd6ff, 0.05 + 0.05 * (6 - i));
    g.fillEllipse(ox + 24, oy + 12, 8 + i * 6.5, 4 + i * 2.6);
  }
  g.fillStyle(0x3cd6ff, 0.55);
  g.fillEllipse(ox + 24, oy + 12, 26, 9);
  g.fillStyle(0xdff4ff, 0.75);
  g.fillEllipse(ox + 24, oy + 12, 14, 5);
}

/** Wooden ladder: two rails and evenly spaced rungs, tiling seamlessly. */
function drawLadder(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  const railW = 4;
  g.fillStyle(0x8a6a3d, 1);
  g.fillRect(ox + 5, oy, railW, PX_PER_M);
  g.fillRect(ox + PX_PER_M - 5 - railW, oy, railW, PX_PER_M);
  g.fillStyle(0xb08b52, 1);
  for (let i = 0; i < 4; i++) {
    g.fillRect(ox + 5, oy + 3 + i * 8, PX_PER_M - 10, 3);
  }
}

/** One-way platform: a plank with a bright top edge you can clearly land on. */
function drawPlatform(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0x6b5230, 1);
  g.fillRect(ox, oy + 2, PX_PER_M, 8);
  g.fillStyle(0xa8814c, 1);
  g.fillRect(ox, oy, PX_PER_M, 3);
  g.fillStyle(0x4a3720, 0.6);
  g.fillRect(ox + 6, oy + 5, 3, 4);
  g.fillRect(ox + PX_PER_M - 9, oy + 5, 3, 4);
}

/** Health box: white crate with a green cross. */
function drawHealthBox(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0xf0f4ff, 1);
  g.fillRoundedRect(ox, oy, 22, 22, 4);
  g.fillStyle(0xc9d4ee, 1);
  g.fillRect(ox, oy + 16, 22, 6);
  g.fillStyle(0x2fbf71, 1);
  g.fillRect(ox + 8, oy + 4, 6, 14);
  g.fillRect(ox + 3, oy + 9, 16, 5);
}

/** Ammo crate: olive box with brass banding. */
function drawAmmoBox(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0x6c6a3a, 1);
  g.fillRoundedRect(ox, oy, 24, 20, 3);
  g.fillStyle(0x88864a, 1);
  g.fillRect(ox + 2, oy + 2, 20, 7);
  g.fillStyle(0xffa03c, 1);
  g.fillRect(ox + 3, oy + 12, 18, 3);
  g.fillStyle(0x3a3922, 1);
  g.fillRect(ox + 9, oy + 15, 6, 3);
}

/** Flat white capsule; tinted at draw time for health-bar backing and fill. */
function drawBar(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(0xffffff, 1);
  g.fillRoundedRect(ox, oy, 64, 10, 5);
}

/** Cheap radial falloff: concentric circles at decreasing alpha. */
function drawRadial(
  g: Phaser.GameObjects.Graphics,
  ox: number,
  oy: number,
  radius: number,
  color: number,
): void {
  for (let r = radius; r >= 1; r -= 1) {
    const alpha = 0.16 + 0.84 * (1 - r / radius);
    g.fillStyle(color, alpha);
    g.fillCircle(ox + radius, oy + radius, r);
  }
}
