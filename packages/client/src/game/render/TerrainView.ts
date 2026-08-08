import type Phaser from 'phaser';
import { TileFlag, type MapDef } from '@aerocade/shared';
import { ATLAS, Frames, PX_PER_M } from './textures.js';

/**
 * Windowed terrain renderer.
 *
 * Outpost Delta is 175 × 98 = 17,150 tiles; a sprite per solid tile would put
 * ~4,400 game objects on the display list and pay their transform cost every
 * frame regardless of where the camera is. Instead this keeps a **fixed pool
 * sized to the viewport** and re-points it at whichever tile rectangle is on
 * screen, so cost is O(visible) rather than O(map) — the chunked-render /
 * frustum-culling requirement, done without leaving the single atlas.
 *
 * The pool is rebuilt only when the visible tile rect actually changes, so a
 * stationary camera costs nothing at all.
 */
export class TerrainView {
  private readonly solid: Phaser.GameObjects.Image[] = [];
  private readonly ladders: Phaser.GameObjects.Image[] = [];
  private readonly platforms: Phaser.GameObjects.Image[] = [];

  private lastX0 = Number.NaN;
  private lastY0 = Number.NaN;
  private lastX1 = Number.NaN;
  private lastY1 = Number.NaN;

  /** Tiles of slack around the viewport, so a small pan needs no rebuild. */
  private static readonly MARGIN = 3;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly map: MapDef,
    capacity: number,
  ) {
    const make = (frame: string, depth: number): Phaser.GameObjects.Image =>
      scene.add.image(0, 0, ATLAS, frame).setOrigin(0, 0).setDepth(depth).setVisible(false);
    for (let i = 0; i < capacity; i++) this.solid.push(make(Frames.Tile, 0));
    // Ladders and platforms are far rarer; a fraction of the pool covers them.
    const thin = Math.max(32, Math.floor(capacity / 4));
    for (let i = 0; i < thin; i++) this.ladders.push(make(Frames.Ladder, 1));
    for (let i = 0; i < thin; i++) this.platforms.push(make(Frames.Platform, 1));
  }

  /**
   * Point the pools at the camera's current view. Cheap and idempotent: it
   * returns immediately unless the visible tile rect moved.
   */
  update(camera: Phaser.Cameras.Scene2D.Camera): void {
    const view = camera.worldView;
    const m = TerrainView.MARGIN;
    const x0 = Math.max(0, Math.floor(view.x / PX_PER_M) - m);
    const y0 = Math.max(0, Math.floor(view.y / PX_PER_M) - m);
    const x1 = Math.min(this.map.width - 1, Math.ceil((view.x + view.width) / PX_PER_M) + m);
    const y1 = Math.min(this.map.height - 1, Math.ceil((view.y + view.height) / PX_PER_M) + m);

    if (x0 === this.lastX0 && y0 === this.lastY0 && x1 === this.lastX1 && y1 === this.lastY1) {
      return;
    }
    this.lastX0 = x0;
    this.lastY0 = y0;
    this.lastX1 = x1;
    this.lastY1 = y1;

    let s = 0;
    let l = 0;
    let pf = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const flags = this.map.tiles[ty * this.map.width + tx] ?? 0;
        if (flags === 0) continue;
        const px = tx * PX_PER_M;
        const py = ty * PX_PER_M;

        if ((flags & TileFlag.Solid) !== 0) {
          const sprite = this.solid[s];
          if (sprite !== undefined) {
            const frame = this.rockFrame(tx, ty);
            // Flip per tile so one frame does not visibly tile into a grid.
            // Surfaces and roofs may only flip horizontally — mirroring them
            // vertically would put the moss cap underneath or hang stalactites
            // off a floor. Buried rock and walls can flip both ways.
            const h = TerrainView.hash(tx, ty);
            const canFlipY = frame === Frames.TileRock || frame === Frames.TileDeep;
            sprite
              .setPosition(px, py)
              .setFrame(frame)
              .setFlipX((h & 1) === 1)
              .setFlipY(canFlipY && (h & 2) === 2)
              .setVisible(true);
            s += 1;
          }
        }
        if ((flags & TileFlag.OneWay) !== 0) {
          const sprite = this.platforms[pf];
          if (sprite !== undefined) {
            sprite.setPosition(px, py).setVisible(true);
            pf += 1;
          }
        }
        if ((flags & TileFlag.Ladder) !== 0) {
          const sprite = this.ladders[l];
          if (sprite !== undefined) {
            sprite.setPosition(px, py).setVisible(true);
            l += 1;
          }
        }
      }
    }

    for (let i = s; i < this.solid.length; i++) this.solid[i]?.setVisible(false);
    for (let i = l; i < this.ladders.length; i++) this.ladders[i]?.setVisible(false);
    for (let i = pf; i < this.platforms.length; i++) this.platforms[i]?.setVisible(false);
  }

  /**
   * Deterministic per-tile hash. Deliberately not the sim RNG and not
   * `Math.random`: the same tile must look the same on every boot and on every
   * client, or terrain would shimmer as the view rect is rebuilt.
   */
  private static hash(tx: number, ty: number): number {
    let h = (tx * 73856093) ^ (ty * 19349663);
    h ^= h >>> 13;
    h = (h * 1274126177) | 0;
    return (h ^ (h >>> 16)) & 0xff;
  }

  /** Solid for terrain-shading purposes; out of bounds counts as rock. */
  private isRock(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return true;
    return ((this.map.tiles[ty * this.map.width + tx] ?? 0) & TileFlag.Solid) !== 0;
  }

  /**
   * Choose a rock frame from the tile's neighbours, so the same tile grid reads
   * as ledges, cave walls, roofs and buried rock without the map carrying any
   * material data. This is purely presentation — the sim knows only "solid".
   *
   * It is also what makes the level legible: a mossy lit top edge is the visual
   * promise "you can stand here", and buried rock being darkest is what makes a
   * cave mouth read as an opening rather than as a differently-coloured wall.
   * Called only while the visible rect is being rebuilt, never per frame.
   */
  private rockFrame(tx: number, ty: number): string {
    if (!this.isRock(tx, ty - 1)) return Frames.TileSurface; // walkable ledge
    if (!this.isRock(tx, ty + 1)) return Frames.TileCeiling; // cave roof
    if (!this.isRock(tx - 1, ty) || !this.isRock(tx + 1, ty)) return Frames.TileRock; // wall
    return Frames.TileDeep; // buried
  }

  destroy(): void {
    for (const s of [...this.solid, ...this.ladders, ...this.platforms]) s.destroy();
  }

  /** Sprites the pool can show at once; sized from the viewport, not the map. */
  static capacityFor(viewTilesWide: number, viewTilesHigh: number): number {
    const m = TerrainView.MARGIN * 2;
    return (viewTilesWide + m + 2) * (viewTilesHigh + m + 2);
  }
}
