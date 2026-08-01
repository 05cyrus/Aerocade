import type Phaser from 'phaser';

/**
 * All Aerocade art is generated procedurally at boot — shapes, gradients, and
 * palette are original code, guaranteeing zero third-party assets (see
 * docs/rendering.md). Textures are drawn once into the texture manager; the
 * scene only ever instantiates pooled sprites from them.
 */

/** Pixels per simulation meter. */
export const PX_PER_M = 32;

export const PLAYER_COLORS: readonly number[] = [
  0x3cd6ff, 0xffa03c, 0x55e08c, 0xff4d5e, 0xc77dff, 0xf5e663, 0x6bc1ff, 0xff8fb3,
];

export const TextureKeys = {
  Tile: 'tex-tile',
  Player: 'tex-player',
  Rocket: 'tex-rocket',
  Grenade: 'tex-grenade',
  Spark: 'tex-spark',
  Muzzle: 'tex-muzzle',
  Barrel: 'tex-barrel',
} as const;

export function generateTextures(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);

  // --- Solid tile: layered industrial plate ---
  g.fillStyle(0x2a3350, 1);
  g.fillRect(0, 0, PX_PER_M, PX_PER_M);
  g.fillStyle(0x333e63, 1);
  g.fillRect(1, 1, PX_PER_M - 2, PX_PER_M - 2);
  g.fillStyle(0x2e3859, 1);
  g.fillRect(3, 3, PX_PER_M - 6, PX_PER_M - 6);
  g.fillStyle(0x445081, 1);
  g.fillRect(0, 0, PX_PER_M, 2); // top highlight reads as a walkable edge
  g.generateTexture(TextureKeys.Tile, PX_PER_M, PX_PER_M);
  g.clear();

  // --- Player: white capsule body + visor + jetpack, tinted per player ---
  const pw = Math.round(0.85 * PX_PER_M);
  const ph = Math.round(1.65 * PX_PER_M);
  g.fillStyle(0xffffff, 1);
  g.fillRoundedRect(4, 0, pw - 8, ph, 9); // body
  g.fillStyle(0xffffff, 0.55);
  g.fillRoundedRect(0, Math.round(ph * 0.22), 5, Math.round(ph * 0.42), 2); // jetpack left
  g.fillRoundedRect(pw - 5, Math.round(ph * 0.22), 5, Math.round(ph * 0.42), 2); // jetpack right
  g.fillStyle(0x101828, 1);
  g.fillRoundedRect(7, Math.round(ph * 0.12), pw - 14, Math.round(ph * 0.14), 4); // visor
  g.generateTexture(TextureKeys.Player, pw, ph);
  g.clear();

  // --- Weapon barrel (rotates with aim) ---
  g.fillStyle(0xcfd8f5, 1);
  g.fillRoundedRect(0, 0, 22, 6, 2);
  g.fillStyle(0x8f9cc4, 1);
  g.fillRect(0, 0, 8, 6);
  g.generateTexture(TextureKeys.Barrel, 22, 6);
  g.clear();

  // --- Rocket ---
  g.fillStyle(0xe8edff, 1);
  g.fillRoundedRect(0, 0, 16, 6, 3);
  g.fillStyle(0xffa03c, 1);
  g.fillRect(0, 1, 4, 4); // exhaust cap
  g.generateTexture(TextureKeys.Rocket, 16, 6);
  g.clear();

  // --- Grenade ---
  g.fillStyle(0x55e08c, 1);
  g.fillCircle(5, 5, 5);
  g.fillStyle(0x101828, 1);
  g.fillRect(4, 0, 2, 3); // pin nub
  g.generateTexture(TextureKeys.Grenade, 10, 10);
  g.clear();

  // --- Radial spark (explosions, jet exhaust, muzzle flash particles) ---
  drawRadial(g, 8, 0xffffff);
  g.generateTexture(TextureKeys.Spark, 16, 16);
  g.clear();

  // --- Muzzle flash ---
  drawRadial(g, 10, 0xffe0a0);
  g.generateTexture(TextureKeys.Muzzle, 20, 20);
  g.destroy();
}

/** Cheap radial falloff: concentric circles at decreasing alpha. */
function drawRadial(g: Phaser.GameObjects.Graphics, radius: number, color: number): void {
  for (let r = radius; r >= 1; r -= 1) {
    const alpha = 0.16 + 0.84 * (1 - r / radius);
    g.fillStyle(color, alpha);
    g.fillCircle(radius, radius, r);
  }
}
