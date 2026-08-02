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

/** Untinted palette for parts shared by every soldier. */
const INK = 0x151b2e; // visors, boots, seams
const GUNMETAL = 0x2c3346;
const GUNMETAL_LIGHT = 0x4a5470;
const ARMOR = 0xe8edfa; // near-white so team tint colors it
const ARMOR_SHADE = 0xb9c3e0;
const PACK_METAL = 0x9aa5c4;

/** Frame names within the atlas. */
export const Frames = {
  Tile: 'tile',
  Head: 'head',
  Torso: 'torso',
  Leg: 'leg',
  Arm: 'arm',
  Jetpack: 'jetpack',
  Rocket: 'rocket',
  Grenade: 'grenade',
  Spark: 'spark',
  Muzzle: 'muzzle',
  /** Glowing floor disc marking a weapon pad. */
  Pad: 'pad',
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
    { name: Frames.Head, w: 32, h: 32, draw: drawHead },
    { name: Frames.Torso, w: 30, h: 40, draw: drawTorso },
    { name: Frames.Leg, w: 12, h: 36, draw: drawLeg },
    { name: Frames.Arm, w: 22, h: 10, draw: drawArm },
    { name: Frames.Jetpack, w: 18, h: 34, draw: drawJetpack },
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

// ---------- character parts (drawn facing right, at 2× scale) ----------

/** Helmeted head. Team tint colors the shell; the visor stays dark. */
function drawHead(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  // antenna (drawn first: it sits behind the shell)
  g.fillStyle(PACK_METAL, 1);
  g.fillRect(ox + 3, oy + 0, 2, 8);
  g.fillStyle(0xff4d5e, 1);
  g.fillRect(ox + 2, oy + 0, 4, 3);
  // helmet shell
  g.fillStyle(ARMOR, 1);
  g.fillRoundedRect(ox, oy + 2, 32, 26, { tl: 15, tr: 15, bl: 6, br: 6 });
  // shell shading band
  g.fillStyle(ARMOR_SHADE, 1);
  g.fillRoundedRect(ox, oy + 20, 32, 8, { tl: 0, tr: 0, bl: 6, br: 6 });
  // visor: wide dark band with a glint, biased toward the face (right)
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 8, oy + 11, 23, 11, 5);
  g.fillStyle(0x3cd6ff, 0.55);
  g.fillRoundedRect(ox + 22, oy + 13, 7, 3, 1.5);
  // chin guard
  g.fillStyle(ARMOR_SHADE, 1);
  g.fillRoundedRect(ox + 6, oy + 26, 20, 6, 3);
}

/** Armored torso. Team tint colors the vest. */
function drawTorso(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(ARMOR, 1);
  g.fillRoundedRect(ox + 1, oy, 28, 36, 8);
  g.fillStyle(ARMOR_SHADE, 1);
  g.fillRoundedRect(ox + 1, oy, 9, 36, { tl: 8, tr: 0, bl: 8, br: 0 }); // back shade
  g.fillStyle(INK, 0.35);
  g.fillRect(ox + 4, oy + 12, 23, 2); // plate seams
  g.fillRect(ox + 4, oy + 22, 23, 2);
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 2, oy + 32, 26, 6, 3); // belt
  g.fillStyle(0xffa03c, 1);
  g.fillRect(ox + 13, oy + 33, 5, 4); // buckle
}

/** One leg with boot. Pivot is the top edge. */
function drawLeg(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(ARMOR_SHADE, 1);
  g.fillRoundedRect(ox + 1, oy, 10, 26, 5); // thigh/shin
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox, oy + 24, 12, 10, { tl: 3, tr: 3, bl: 4, br: 4 }); // boot
  g.fillStyle(GUNMETAL_LIGHT, 1);
  g.fillRect(ox, oy + 30, 12, 2); // sole
}

/** Forearm + glove. Pivot at the left end. */
function drawArm(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(ARMOR_SHADE, 1);
  g.fillRoundedRect(ox, oy + 1, 16, 8, 4);
  g.fillStyle(INK, 1);
  g.fillRoundedRect(ox + 13, oy, 9, 10, 4); // glove
}

/** Jetpack worn on the back. */
function drawJetpack(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
  g.fillStyle(PACK_METAL, 1);
  g.fillRoundedRect(ox, oy, 18, 26, 7); // tank
  g.fillStyle(0xc4cde8, 1);
  g.fillRoundedRect(ox + 3, oy + 2, 5, 20, 2.5); // highlight
  g.fillStyle(INK, 0.4);
  g.fillRect(ox, oy + 8, 18, 2);
  g.fillRect(ox, oy + 16, 18, 2);
  g.fillStyle(GUNMETAL, 1); // twin nozzles
  g.fillRoundedRect(ox + 2, oy + 25, 6, 8, 2);
  g.fillRoundedRect(ox + 10, oy + 25, 6, 8, 2);
  g.fillStyle(0xffa03c, 1);
  g.fillRect(ox + 3, oy + 31, 4, 2);
  g.fillRect(ox + 11, oy + 31, 4, 2);
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
