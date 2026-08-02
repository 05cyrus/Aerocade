import { MAX_PLAYERS, SIM_DT } from '../../constants.js';
import { aabbOverlapsSolid } from '../geometry.js';
import { isOneWay, isSolid, type MapDef } from '../map/mapdef.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/** Gap left between a resolved AABB and the tile it hit, in meters. */
const SKIN = 1e-4;

/**
 * Move an AABB along one axis and resolve against solid tiles.
 * Precondition (enforced by `hardSpeedCap`): per-tick displacement is under
 * one tile, so only the immediately-crossed tile boundary needs clamping.
 * Returns the resolved center coordinate; `hit` is signaled via return sign
 * trick avoided — callers compare against the attempted target instead.
 */
function moveAxis(
  map: MapDef,
  centerX: number,
  centerY: number,
  halfW: number,
  halfH: number,
  delta: number,
  axis: 'x' | 'y',
): number {
  if (delta === 0) return axis === 'x' ? centerX : centerY;
  const targetX = axis === 'x' ? centerX + delta : centerX;
  const targetY = axis === 'y' ? centerY + delta : centerY;
  if (!aabbOverlapsSolid(map, targetX, targetY, halfW, halfH)) {
    return axis === 'x' ? targetX : targetY;
  }
  if (axis === 'x') {
    if (delta > 0) {
      const edgeTile = Math.floor(targetX + halfW);
      return edgeTile - halfW - SKIN;
    }
    const edgeTile = Math.floor(targetX - halfW) + 1;
    return edgeTile + halfW + SKIN;
  }
  if (delta > 0) {
    const edgeTile = Math.floor(targetY + halfH);
    return edgeTile - halfH - SKIN;
  }
  const edgeTile = Math.floor(targetY - halfH) + 1;
  return edgeTile + halfH + SKIN;
}

/**
 * Highest one-way platform top that a body falling from `fromBottom` to
 * `toBottom` would cross this tick, or `null` if none. One-way tiles only
 * exist for a body moving downward whose feet were above the tile's top edge
 * before the step — that is what lets you jump up through them.
 */
function oneWayLanding(
  map: MapDef,
  centerX: number,
  halfW: number,
  fromBottom: number,
  toBottom: number,
): number | null {
  if (toBottom <= fromBottom) return null;
  const minX = Math.floor(centerX - halfW);
  const maxX = Math.floor(centerX + halfW - 1e-9);
  const firstRow = Math.floor(fromBottom);
  const lastRow = Math.floor(toBottom);

  for (let ty = firstRow; ty <= lastRow; ty++) {
    const top = ty;
    // Only catch a platform whose surface we were strictly above and have now
    // reached; anything else we are already inside and must pass through.
    if (fromBottom > top + 1e-6 || toBottom < top) continue;
    for (let tx = minX; tx <= maxX; tx++) {
      if (isOneWay(map, tx, ty) && !isSolid(map, tx, ty)) return top;
    }
  }
  return null;
}

/**
 * Integrate player positions with axis-separated swept collision (X then Y).
 * Sets `grounded` from downward contact and clamps velocity on hit surfaces.
 */
export function physicsSystem(world: SimWorld): void {
  const p = world.players;
  const map = world.map;
  const halfW = TUNING.player.width / 2;
  const halfH = TUNING.player.height / 2;
  const cap = TUNING.player.hardSpeedCap;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1 || p.status[i] !== 1) continue;
    // A climbing player is driven entirely by the movement system, but still
    // collides with terrain — a ladder does not let you walk through walls.
    const climbing = p.onLadder[i] === 1;

    let velX = p.velX[i] ?? 0;
    let velY = p.velY[i] ?? 0;

    // Hard cap keeps displacement < 1 tile/tick — the no-tunneling invariant.
    const speed = Math.hypot(velX, velY);
    if (speed > cap) {
      const scale = cap / speed;
      velX *= scale;
      velY *= scale;
    }

    let posX = p.posX[i] ?? 0;
    let posY = p.posY[i] ?? 0;

    const wantX = posX + velX * SIM_DT;
    posX = moveAxis(map, posX, posY, halfW, halfH, velX * SIM_DT, 'x');
    if (posX !== wantX) velX = 0;

    const wantY = posY + velY * SIM_DT;
    const movingDown = velY > 0;
    const bottomBefore = posY + halfH;
    posY = moveAxis(map, posX, posY, halfW, halfH, velY * SIM_DT, 'y');
    let hitY = posY !== wantY;

    // One-way platforms catch a descending player at the surface they crossed
    // — but never someone climbing a ladder through them.
    if (!hitY && movingDown && !climbing) {
      const landing = oneWayLanding(map, posX, halfW, bottomBefore, posY + halfH);
      if (landing !== null) {
        posY = landing - halfH - SKIN;
        hitY = true;
      }
    }

    let grounded = false;
    if (climbing) {
      // Do not let one-way platforms catch a player climbing through them.
      p.posX[i] = posX;
      p.posY[i] = posY;
      p.velX[i] = velX;
      p.velY[i] = velY;
      p.grounded[i] = 0;
      continue;
    }
    if (hitY) {
      if (movingDown) grounded = true;
      velY = 0;
    } else if (velY >= 0) {
      // Standing check: a whisker probe just below the feet, solid or one-way.
      const probeBottom = posY + halfH + SKIN * 2;
      grounded =
        aabbOverlapsSolid(map, posX, posY + SKIN * 2, halfW, halfH) ||
        oneWayLanding(map, posX, halfW, posY + halfH, probeBottom) !== null;
    }

    p.posX[i] = posX;
    p.posY[i] = posY;
    p.velX[i] = velX;
    p.velY[i] = velY;
    p.grounded[i] = grounded ? 1 : 0;
  }
}
