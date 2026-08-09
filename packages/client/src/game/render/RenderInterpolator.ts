import { MAX_PLAYERS, MAX_PROJECTILES, type SimWorld } from '@aerocade/shared';

/**
 * Double-buffered render state. The game loop captures the sim after every
 * tick; the renderer draws `lerp(prev, curr, alpha)` at display rate, giving
 * smooth motion regardless of the display's refresh rate (docs/rendering.md).
 * All buffers are preallocated — capture is a handful of typed-array copies.
 */
export class RenderInterpolator {
  readonly prevPlayerX = new Float64Array(MAX_PLAYERS);
  readonly prevPlayerY = new Float64Array(MAX_PLAYERS);
  readonly currPlayerX = new Float64Array(MAX_PLAYERS);
  /** Render-only offsets, for blending prediction corrections. */
  private readonly offsetX = new Float64Array(MAX_PLAYERS);
  private readonly offsetY = new Float64Array(MAX_PLAYERS);
  readonly currPlayerY = new Float64Array(MAX_PLAYERS);
  readonly prevAim = new Float32Array(MAX_PLAYERS);
  readonly currAim = new Float32Array(MAX_PLAYERS);
  readonly playerVisible = new Uint8Array(MAX_PLAYERS);
  /** Set when a player (re)appears — respawn teleports must snap, not streak. */
  readonly playerFresh = new Uint8Array(MAX_PLAYERS);

  readonly prevProjX = new Float64Array(MAX_PROJECTILES);
  readonly prevProjY = new Float64Array(MAX_PROJECTILES);
  readonly currProjX = new Float64Array(MAX_PROJECTILES);
  readonly currProjY = new Float64Array(MAX_PROJECTILES);
  readonly projVisible = new Uint8Array(MAX_PROJECTILES);
  /** Set on the capture where a projectile first appears (skip lerp that frame). */
  readonly projFresh = new Uint8Array(MAX_PROJECTILES);

  capture(world: SimWorld): void {
    const p = world.players;
    this.prevPlayerX.set(this.currPlayerX);
    this.prevPlayerY.set(this.currPlayerY);
    this.prevAim.set(this.currAim);
    this.currPlayerX.set(p.posX);
    this.currPlayerY.set(p.posY);
    this.currAim.set(p.aim);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const visible = p.connected[i] === 1 && p.status[i] === 1 ? 1 : 0;
      this.playerFresh[i] = visible === 1 && this.playerVisible[i] === 0 ? 1 : 0;
      this.playerVisible[i] = visible;
    }

    const pr = world.projectiles;
    this.prevProjX.set(this.currProjX);
    this.prevProjY.set(this.currProjY);
    this.currProjX.set(pr.posX);
    this.currProjY.set(pr.posY);
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const visible = pr.alive[i] === 1 ? 1 : 0;
      this.projFresh[i] = visible === 1 && this.projVisible[i] === 0 ? 1 : 0;
      this.projVisible[i] = visible;
    }
  }

  /**
   * A render-only nudge for one player, added by `playerX`/`playerY`.
   *
   * Used to blend away a prediction correction (docs/networking.md §7): the
   * simulation jumps to the host's answer immediately while the drawn position
   * slides there over ~100 ms. Applied here rather than at each draw site so the
   * camera, the rig and the muzzle all agree about where the player is — three
   * separately-offset copies of one position is how a gun ends up firing from
   * beside its owner.
   */
  setRenderOffset(i: number, x: number, y: number): void {
    this.offsetX[i] = x;
    this.offsetY[i] = y;
  }

  playerX(i: number, alpha: number): number {
    const base =
      this.playerFresh[i] === 1
        ? (this.currPlayerX[i] ?? 0)
        : lerp(this.prevPlayerX[i] ?? 0, this.currPlayerX[i] ?? 0, alpha);
    return base + (this.offsetX[i] ?? 0);
  }

  playerY(i: number, alpha: number): number {
    const base =
      this.playerFresh[i] === 1
        ? (this.currPlayerY[i] ?? 0)
        : lerp(this.prevPlayerY[i] ?? 0, this.currPlayerY[i] ?? 0, alpha);
    return base + (this.offsetY[i] ?? 0);
  }

  playerAim(i: number, alpha: number): number {
    if (this.playerFresh[i] === 1) return this.currAim[i] ?? 0;
    // Angles are close between ticks; simple lerp with wrap handling.
    const a = this.prevAim[i] ?? 0;
    const b = this.currAim[i] ?? 0;
    let d = b - a;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * alpha;
  }

  projX(i: number, alpha: number): number {
    if (this.projFresh[i] === 1) return this.currProjX[i] ?? 0;
    return lerp(this.prevProjX[i] ?? 0, this.currProjX[i] ?? 0, alpha);
  }

  projY(i: number, alpha: number): number {
    if (this.projFresh[i] === 1) return this.currProjY[i] ?? 0;
    return lerp(this.prevProjY[i] ?? 0, this.currProjY[i] ?? 0, alpha);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
