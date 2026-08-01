import { isSolid, type MapDef } from './map/mapdef.js';

/**
 * Allocation-free geometry queries against the tile grid and AABBs.
 * All functions return scalars; callers own any composite results.
 */

/**
 * Cast a ray against solid tiles using DDA grid traversal.
 * Returns the distance to the first solid tile boundary, or `maxDist` if the
 * ray travels the full length unobstructed. Direction need not be normalized
 * beyond "not both zero"; it is normalized internally.
 */
export function raycastTiles(
  map: MapDef,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
): number {
  const len = Math.hypot(dirX, dirY);
  if (len < 1e-9) return 0;
  const dx = dirX / len;
  const dy = dirY / len;

  let tileX = Math.floor(originX);
  let tileY = Math.floor(originY);
  if (isSolid(map, tileX, tileY)) return 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  // Distance along the ray to cross one tile in each axis.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  // Distance along the ray to the first tile boundary in each axis.
  let tMaxX =
    dx > 0 ? (tileX + 1 - originX) * tDeltaX : dx < 0 ? (originX - tileX) * tDeltaX : Infinity;
  let tMaxY =
    dy > 0 ? (tileY + 1 - originY) * tDeltaY : dy < 0 ? (originY - tileY) * tDeltaY : Infinity;

  for (;;) {
    if (tMaxX < tMaxY) {
      if (tMaxX > maxDist) return maxDist;
      tileX += stepX;
      if (isSolid(map, tileX, tileY)) return tMaxX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > maxDist) return maxDist;
      tileY += stepY;
      if (isSolid(map, tileX, tileY)) return tMaxY;
      tMaxY += tDeltaY;
    }
  }
}

/**
 * Ray vs. centered AABB (slab method). Returns the entry distance `t >= 0`
 * along the (normalized) ray, or `Infinity` when there is no hit in front of
 * the origin. A ray starting inside the box returns 0.
 */
export function rayVsAabb(
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): number {
  let tMin = -Infinity;
  let tMax = Infinity;

  if (dirX === 0) {
    if (Math.abs(originX - centerX) > halfWidth) return Infinity;
  } else {
    const inv = 1 / dirX;
    let t1 = (centerX - halfWidth - originX) * inv;
    let t2 = (centerX + halfWidth - originX) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
  }

  if (dirY === 0) {
    if (Math.abs(originY - centerY) > halfHeight) return Infinity;
  } else {
    const inv = 1 / dirY;
    let t1 = (centerY - halfHeight - originY) * inv;
    let t2 = (centerY + halfHeight - originY) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
  }

  if (tMax < tMin || tMax < 0) return Infinity;
  return tMin < 0 ? 0 : tMin;
}

/** Distance from a point to the nearest point of a centered AABB (0 if inside). */
export function pointToAabbDistance(
  pointX: number,
  pointY: number,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): number {
  const dx = Math.max(Math.abs(pointX - centerX) - halfWidth, 0);
  const dy = Math.max(Math.abs(pointY - centerY) - halfHeight, 0);
  return Math.hypot(dx, dy);
}

/** True when an AABB overlaps any solid tile. */
export function aabbOverlapsSolid(
  map: MapDef,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const minX = Math.floor(centerX - halfWidth);
  const maxX = Math.floor(centerX + halfWidth - 1e-9);
  const minY = Math.floor(centerY - halfHeight);
  const maxY = Math.floor(centerY + halfHeight - 1e-9);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (isSolid(map, tx, ty)) return true;
    }
  }
  return false;
}
