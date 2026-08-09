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

/**
 * Phase values are **wire values** (a `u8` in every snapshot), so this list is
 * append-only — renumbering would make an older client misread a newer host's
 * phase, and `tuningHash` does not cover it. That is why `Waiting` is 3 rather
 * than 0 despite coming first in the match's life.
 */
export const MatchPhase = {
  /** Pre-match countdown: players can move, weapons are locked. */
  Warmup: 0,
  /** The match proper. The only phase in which anything scores. */
  Live: 1,
  /** Decided. Inputs are frozen and the scoreboard is final. */
  Over: 2,
  /**
   * Waiting in the lobby for enough players, all readied up. Movement is allowed
   * so people can look around; weapons are not.
   */
  Waiting: 3,
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
  /** Whether leaving the lobby runs a countdown, or goes straight live. */
  warmupAfterWait = true;
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
    this.warmupAfterWait = src.warmupAfterWait;
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
  /**
   * Hold the match in the lobby until the host starts it. Defaults
   * to **false**, so `createMatch` and every sim test still get a world that can
   * be played immediately; a real LAN match opts in via `DEFAULT_MATCH_RULES`.
   */
  waitForPlayers?: boolean;
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
  waitForPlayers: false,
};

/**
 * A real match: TUNING's mode, clock and frag limit, held in the lobby until the
 * host presses Start — and then straight into play.
 *
 * No countdown. A timer that starts the match for you is exactly what the lobby
 * replaces: players join, the host sees who is there, and the host decides. The
 * `warmup` phase is still supported for a mode that wants one, just not default.
 */
export const DEFAULT_MATCH_RULES: MatchRules = { warmup: false, waitForPlayers: true };

/** Apply rules to a fresh match. */
export function configureMatch(state: MatchState, tick: number, rules: MatchRules = {}): void {
  state.mode = rules.mode ?? GameMode.Ffa;
  state.phase =
    (rules.waitForPlayers ?? false)
      ? MatchPhase.Waiting
      : (rules.warmup ?? true)
        ? MatchPhase.Warmup
        : MatchPhase.Live;
  state.warmupAfterWait = rules.warmup ?? true;
  state.phaseStartTick = tick;
  state.timeLimitTicks = Math.max(
    0,
    Math.round((rules.durationSeconds ?? TUNING.match.durationSeconds) * SIM_HZ),
  );
  state.fragLimit = Math.max(0, Math.trunc(rules.fragLimit ?? TUNING.match.fragLimit));
  state.winner = NO_WINNER;
  state.teamFrags.fill(0);
}

/** True while the match has not started and is waiting on players. */
export function isWaiting(state: MatchState): boolean {
  return state.phase === MatchPhase.Waiting;
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
  // Before the live phase the full duration is still ahead: a HUD showing 7:58
  // during the lobby looks like the match already started without you.
  if (state.phase === MatchPhase.Warmup || state.phase === MatchPhase.Waiting) {
    return state.timeLimitTicks / SIM_HZ;
  }
  // Clamped at both ends. `enterPhase` sets `phaseStartTick` to the *next* tick, so
  // for one tick after a transition `elapsed` is -1 — and an unclamped subtraction
  // then reports 480.017 s on an eight-minute match, which a HUD renders as 8:01.
  const elapsed = Math.max(0, phaseElapsedTicks(state, tick));
  return Math.max(0, state.timeLimitTicks - elapsed) / SIM_HZ;
}

/** Seconds left in the warmup countdown; 0 once the match is live. */
export function warmupRemainingSeconds(state: MatchState, tick: number): number {
  if (state.phase !== MatchPhase.Warmup) return 0;
  // Same clamp as the live clock: a countdown must never read above its own length.
  const elapsed = Math.max(0, phaseElapsedTicks(state, tick));
  return Math.max(0, Math.round(TUNING.match.warmupSeconds * SIM_HZ) - elapsed) / SIM_HZ;
}
