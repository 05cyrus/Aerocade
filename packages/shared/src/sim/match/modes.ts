import { MAX_PLAYERS, NO_PLAYER } from '../../constants.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * Game modes as rulesets: a small object of pure hooks resolved by mode id
 * (docs/architecture.md §"Game modes").
 *
 * The point of the seam is that the simulation pipeline never learns what mode
 * it is running. `matchSystem` owns the clock and the phase machine — universal
 * to every mode — and asks the ruleset the only three questions that actually
 * differ: who scores for a kill, what an entrant's score is, and whether anyone
 * has won. CTF and Survival slot in here as further rulesets rather than as
 * branches inside the systems.
 *
 * "Entrant" is the thing that scores: a player slot in FFA, a team in TDM. Every
 * hook is expressed in entrants so the scoreboard, the frag limit and the winner
 * are one code path across modes instead of three.
 */

export const GameMode = {
  Ffa: 0,
  Tdm: 1,
} as const;
export type GameMode = (typeof GameMode)[keyof typeof GameMode];

/** Teams in a team mode. Two is what TDM means; CTF will want the same two. */
export const MAX_TEAMS = 2;

/** No entrant has won yet. Shares `NO_PLAYER`'s value so both read as "nobody". */
export const NO_WINNER = NO_PLAYER;

export interface ModeRuleset {
  readonly id: GameMode;
  /** Shown in the lobby and on the end screen. */
  readonly label: string;
  /** True when entrants are teams rather than individual players. */
  readonly teams: boolean;
  /** Scoring entrants: player slots in FFA, teams in TDM. */
  readonly entrantCount: number;
  /** The entrant a player scores for. */
  entrantOf(world: SimWorld, player: number): number;
  /** A kill has happened; `kills`/`deaths` are already booked by `damage`. */
  onKill(world: SimWorld, killer: number, victim: number): void;
  /** A pickup was collected. Unused by FFA/TDM; CTF's flag capture lands here. */
  onPickup(world: SimWorld, player: number): void;
  /** Once per live tick, for modes with their own timers. */
  onTick(world: SimWorld): void;
  /** Frags for one entrant — what the frag limit is measured against. */
  fragsOf(world: SimWorld, entrant: number): number;
  /** Points for one entrant, as shown on the scoreboard. */
  scoreOf(world: SimWorld, entrant: number): number;
  /** Whether this entrant is present at all (an empty slot is not last place). */
  isActive(world: SimWorld, entrant: number): boolean;
}

/** Frags are the win condition; points are what the scoreboard shows. */
function points(frags: number): number {
  return frags * TUNING.match.killScore;
}

/**
 * Free-for-all: every player is their own entrant and every kill is their own.
 *
 * A suicide (killer === victim, or no killer at all) deliberately does not score.
 * `damage` still books the death, so the scoreboard shows the cost without
 * handing anybody a frag for it.
 */
export const FFA_RULES: ModeRuleset = {
  id: GameMode.Ffa,
  label: 'Free-for-all',
  teams: false,
  entrantCount: MAX_PLAYERS,
  entrantOf: (_world, player) => player,
  onKill: () => undefined, // `players.kills` is already the FFA score
  onPickup: () => undefined,
  onTick: () => undefined,
  fragsOf: (world, entrant) => world.players.kills[entrant] ?? 0,
  scoreOf: (world, entrant) => points(world.players.kills[entrant] ?? 0),
  isActive: (world, entrant) => world.players.connected[entrant] === 1,
};

/**
 * Team deathmatch: the two teams are the entrants.
 *
 * Team frags are accumulated in `match.teamFrags` rather than summed from
 * `players.kills` on demand, because a player who disconnects mid-match takes
 * their kills with them — and a team's score dropping when someone rage-quits is
 * a bug, not a rule. A team kill costs the team a frag instead of granting one.
 */
export const TDM_RULES: ModeRuleset = {
  id: GameMode.Tdm,
  label: 'Team deathmatch',
  teams: true,
  entrantCount: MAX_TEAMS,
  entrantOf: (world, player) => world.players.team[player] ?? 0,
  onKill: (world, killer, victim) => {
    if (killer === NO_PLAYER || killer === victim) return;
    const killerTeam = world.players.team[killer] ?? 0;
    const victimTeam = world.players.team[victim] ?? 0;
    const frags = world.match.teamFrags;
    // Team-killing subtracts, so farming your own side is never a strategy.
    const delta = killerTeam === victimTeam ? -1 : 1;
    frags[killerTeam] = Math.max(0, (frags[killerTeam] ?? 0) + delta);
  },
  onPickup: () => undefined,
  onTick: () => undefined,
  fragsOf: (world, entrant) => world.match.teamFrags[entrant] ?? 0,
  scoreOf: (world, entrant) => points(world.match.teamFrags[entrant] ?? 0),
  // A team is in play while anyone is on it.
  isActive: (world, entrant) => {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (world.players.connected[i] === 1 && (world.players.team[i] ?? 0) === entrant) return true;
    }
    return false;
  },
};

const RULESETS: readonly ModeRuleset[] = [FFA_RULES, TDM_RULES];

/** The ruleset for a mode id, falling back to FFA for an unknown id. */
export function rulesetFor(mode: number): ModeRuleset {
  return RULESETS[mode] ?? FFA_RULES;
}

/** Every mode, for the lobby's mode picker. */
export const GAME_MODES: readonly ModeRuleset[] = RULESETS;
