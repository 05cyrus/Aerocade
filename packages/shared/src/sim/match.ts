import { MAX_PLAYERS } from '../constants.js';
import { initPickups } from './systems/pickups.js';
import { configureMatch, SANDBOX_RULES, type MatchRules } from './match/state.js';
import { rulesetFor } from './match/modes.js';
import { createWorld, type SimWorld } from './world.js';
import type { MapDef } from './map/mapdef.js';

/**
 * Create a match-ready world: an empty sim with every weapon pad stocked.
 *
 * Defaults to `SANDBOX_RULES` — live immediately, no clock, no frag limit —
 * because that is what "a world you can play in" has always meant here. Pass
 * `DEFAULT_MATCH_RULES` (or your own) for a match that counts down and ends.
 */
export function createMatch(
  map: MapDef,
  seed: number,
  rules: MatchRules = SANDBOX_RULES,
): SimWorld {
  const world = createWorld(map, seed);
  initPickups(world);
  configureMatch(world.match, world.tick, rules);
  return world;
}

/**
 * Put a player on the smaller team, for team modes. A no-op in FFA, where the
 * `team` field is only ever a render tint.
 *
 * Balancing on join rather than shuffling at match start means a late joiner
 * evens the sides out instead of piling onto whoever is already winning.
 */
export function assignTeam(world: SimWorld, player: number): number {
  const rules = rulesetFor(world.match.mode);
  if (!rules.teams) return 0;
  const counts = new Array<number>(rules.entrantCount).fill(0);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (i === player || world.players.connected[i] !== 1) continue;
    const team = world.players.team[i] ?? 0;
    if (team < counts.length) counts[team] = (counts[team] ?? 0) + 1;
  }
  let smallest = 0;
  for (let t = 1; t < counts.length; t++) {
    if ((counts[t] ?? 0) < (counts[smallest] ?? 0)) smallest = t;
  }
  world.players.team[player] = smallest;
  return smallest;
}
