import { MAX_PLAYERS, NO_PLAYER, WEAPON_SLOTS } from '../constants.js';
import { SimEventType } from './events.js';
import { DEFAULT_LOADOUT, weaponDef } from './combat/weapon-defs.js';
import { TUNING } from './tuning.js';
import type { SimWorld } from './world.js';

/**
 * Deterministic spawn selection: the spawn point that maximizes the minimum
 * distance to any living enemy. Ties resolve to the lowest index so replays
 * agree. Falls back to spawn 0 on an empty map (parse guarantees >= 2).
 */
export function pickSpawnPoint(world: SimWorld, forPlayer: number): number {
  const { players, map } = world;
  let bestIndex = 0;
  let bestScore = -1;
  for (let s = 0; s < map.spawnPoints.length; s++) {
    const sp = map.spawnPoints[s];
    if (sp === undefined) continue;
    let minDist = Infinity;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (p === forPlayer || players.connected[p] !== 1 || players.status[p] !== 1) continue;
      const dx = (players.posX[p] ?? 0) - sp.x;
      const dy = (players.posY[p] ?? 0) - sp.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) minDist = d;
    }
    if (minDist > bestScore) {
      bestScore = minDist;
      bestIndex = s;
    }
  }
  return bestIndex;
}

/** Reset a player slot to a fresh combat-ready state at a chosen spawn. */
export function spawnPlayer(world: SimWorld, player: number): void {
  const { players, map } = world;
  const spawnIndex = pickSpawnPoint(world, player);
  const sp = map.spawnPoints[spawnIndex];
  if (sp === undefined) return;

  players.status[player] = 1;
  // Spawn standing on the marker tile: center the collision box on the tile
  // horizontally and rest its feet on the tile's floor.
  players.posX[player] = sp.x;
  players.posY[player] = sp.y + 0.5 - TUNING.player.height / 2;
  players.velX[player] = 0;
  players.velY[player] = 0;
  players.health[player] = TUNING.player.maxHealth;
  players.fuel[player] = TUNING.jetpack.maxFuel;
  players.fuelRegenWait[player] = 0;
  players.grounded[player] = 1;
  players.coyote[player] = 0;
  players.weaponSlot[player] = 0;
  for (let s = 0; s < WEAPON_SLOTS; s++) {
    const id = DEFAULT_LOADOUT[s] ?? DEFAULT_LOADOUT[0];
    const def = weaponDef(id);
    players.weapons[player * WEAPON_SLOTS + s] = id;
    players.ammoMag[player * WEAPON_SLOTS + s] = def.magSize;
    players.ammoReserve[player * WEAPON_SLOTS + s] = def.reserveMax;
  }
  players.reload[player] = 0;
  players.cooldown[player] = 0;
  players.bloom[player] = 0;
  players.meleeCooldown[player] = 0;
  players.grenades[player] = TUNING.player.spawnGrenades;
  players.respawn[player] = 0;
  players.protect[player] = TUNING.player.spawnProtection;
  players.lastDamageBy[player] = NO_PLAYER;

  world.events.emit(SimEventType.Respawn, player, 0, sp.x, players.posY[player] ?? sp.y);
}

/**
 * Claim the first free slot (or a specific one) for a joining player and
 * spawn them. Returns the slot, or -1 when the match is full.
 */
export function addPlayer(world: SimWorld, preferredSlot = -1): number {
  const { players } = world;
  let slot = -1;
  if (preferredSlot >= 0 && preferredSlot < MAX_PLAYERS && players.connected[preferredSlot] === 0) {
    slot = preferredSlot;
  } else {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (players.connected[i] === 0) {
        slot = i;
        break;
      }
    }
  }
  if (slot === -1) return -1;

  players.connected[slot] = 1;
  players.kills[slot] = 0;
  players.deaths[slot] = 0;
  players.score[slot] = 0;
  players.team[slot] = 0;
  players.prevButtons[slot] = 0;
  spawnPlayer(world, slot);
  return slot;
}

/** Release a slot (disconnect). The slot becomes reusable immediately. */
export function removePlayer(world: SimWorld, player: number): void {
  if (player < 0 || player >= MAX_PLAYERS) return;
  world.players.connected[player] = 0;
  world.players.status[player] = 0;
}
