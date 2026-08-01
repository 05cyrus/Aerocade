import { MAX_PLAYERS, SIM_DT } from '../../constants.js';
import { aabbOverlapsSolid } from '../geometry.js';
import type { MapDef } from '../map/mapdef.js';
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
    posY = moveAxis(map, posX, posY, halfW, halfH, velY * SIM_DT, 'y');
    const hitY = posY !== wantY;

    let grounded = false;
    if (hitY) {
      if (movingDown) grounded = true;
      velY = 0;
    } else if (velY >= 0) {
      // Standing check: a whisker probe just below the feet.
      grounded = aabbOverlapsSolid(map, posX, posY + SKIN * 2, halfW, halfH);
    }

    p.posX[i] = posX;
    p.posY[i] = posY;
    p.velX[i] = velX;
    p.velY[i] = velY;
    p.grounded[i] = grounded ? 1 : 0;
  }
}
