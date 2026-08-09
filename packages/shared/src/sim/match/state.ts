import { SIM_HZ } from '../../constants.js';
import { TUNING } from '../tuning.js';
import { GameMode, MAX_TEAMS, NO_WINNER } from './modes.js';

/**
 * Match phase, clock and limits — part of the deterministic simulation, not UI
 * state (docs/roadmap.md M4).
 *
 * It lives in the world for two reasons. Determinism: the clock is derived from
 * `world.tick`, never from wall time, so a replay of the same inputs ends at the
 * same instant (docs/architecture.md §"The clamp"). And synchronisation: because
 * it is snapshot-serialised, a joining client learns the mode, the time left and
 * the score from the first snapshot it receives, with nothing added to the join
 * handshake.
 */

export const MatchPhase = {
  /** Pre-match countdown: players can move, weapons are locked. */
  Warmup: 0,
  /** The match proper. The only phase in which anything scores. */
  Live: 1,
  /** Decided. Inputs are frozen and the scoreboard is final. */
  Over: 2,
} as const;
export type MatchPhase = (typeof MatchPhase)[keyof typeof MatchPhase];

export class MatchState {
  /** `GameMode` id; the ruleset is resolved from it (never stored). */
  mode: number = GameMode.Ffa;
  /**
   * Defaults to the sandbox: live, with no clock and no frag limit (the zeroes
   * below). A bare `createWorld` is therefore immediately playable and immediately
   * steppable, which is what it has always meant — a world that started in warmup
   * would silently swallow every shot until someone called `configureMatch`.
   */
  phase: number = MatchPhase.Live;
  /** Tick the current phase began. Every clock in the game derives from this. */
  phaseStartTick = 0;
  /** Ticks the live phase may run. 0 means no time limit. */
  timeLimitTicks = 0;
  /** Frags that end the match. 0 means no frag limit. */
  fragLimit = 0;
  /** Winning entrant (player slot in FFA, team in TDM), or `NO_WINNER`. */
  winner: number = NO_WINNER;
  /**
   * Team frags, accumulated rather than summed from `players.kills` so a
   * disconnect cannot retroactively lower a team's score.
   */
  readonly teamFrags = new Int16Array(MAX_TEAMS);

  /**
   * Copy every field. Written out longhand on purpose: this is the match half of
   * the snapshot manifest, and a field missing here is a field that silently
   * fails to rewind (docs/ecs.md §5). The round-trip test catches it.
   */
  copyFrom(src: MatchState): void {
    this.mode = src.mode;
    this.phase = src.phase;
    this.phaseStartTick = src.phaseStartTick;
    this.timeLimitTicks = src.timeLimitTicks;
    this.fragLimit = src.fragLimit;
    this.winner = src.winner;
    this.teamFrags.set(src.teamFrags);
  }
}

/** Rules a match is started under. Everything has a default from TUNING. */
export interface MatchRules {
  mode?: number;
  /** Live-phase length in seconds; 0 for unlimited. */
  durationSeconds?: number;
  /** Frags to win; 0 for unlimited. */
  fragLimit?: number;
  /** Run the pre-match countdown. False starts live immediately. */
  warmup?: boolean;
}

/**
 * The offline sandbox: live at once, no clock, no frag limit, never ends.
 *
 * This is what `createMatch` gives you unless you ask for something else. A
 * practice arena that counted down and then threw you out after eight minutes
 * would be a worse sandbox, and it is also what every sim test wants — a world
 * that lets you fire on tick 0.
 */
export const SANDBOX_RULES: MatchRules = {
  mode: GameMode.Ffa,
  durationSeconds: 0,
  fragLimit: 0,
  warmup: false,
};

/** A real match: TUNING's mode, clock and frag limit, with the countdown. */
export const DEFAULT_MATCH_RULES: MatchRules = { warmup: true };

/** Apply rules to a fresh match. */
export function configureMatch(state: MatchState, tick: number, rules: MatchRules = {}): void {
  state.mode = rules.mode ?? GameMode.Ffa;
  state.phase = (rules.warmup ?? true) ? MatchPhase.Warmup : MatchPhase.Live;
  state.phaseStartTick = tick;
  state.timeLimitTicks = Math.max(
    0,
    Math.round((rules.durationSeconds ?? TUNING.match.durationSeconds) * SIM_HZ),
  );
  state.fragLimit = Math.max(0, Math.trunc(rules.fragLimit ?? TUNING.match.fragLimit));
  state.winner = NO_WINNER;
  state.teamFrags.fill(0);
}

/** Ticks the current phase has been running. */
export function phaseElapsedTicks(state: MatchState, tick: number): number {
  return tick - state.phaseStartTick;
}

/**
 * Seconds left in the live phase, or `Infinity` when there is no time limit.
 * Before the match goes live this is the full duration, not a partial one.
 */
export function timeRemainingSeconds(state: MatchState, tick: number): number {
  if (state.timeLimitTicks === 0) return Infinity;
  if (state.phase === MatchPhase.Warmup) return state.timeLimitTicks / SIM_HZ;
  const left = state.timeLimitTicks - phaseElapsedTicks(state, tick);
  return Math.max(0, left) / SIM_HZ;
}

/** Seconds left in the warmup countdown; 0 once the match is live. */
export function warmupRemainingSeconds(state: MatchState, tick: number): number {
  if (state.phase !== MatchPhase.Warmup) return 0;
  const left = Math.round(TUNING.match.warmupSeconds * SIM_HZ) - phaseElapsedTicks(state, tick);
  return Math.max(0, left) / SIM_HZ;
}
