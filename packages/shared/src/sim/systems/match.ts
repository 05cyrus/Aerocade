import { MAX_PLAYERS, SIM_HZ } from '../../constants.js';
import { SimEventType } from '../events.js';
import { NO_WINNER, rulesetFor } from '../match/modes.js';
import { MatchPhase, phaseElapsedTicks } from '../match/state.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * System 9, `match` (docs/ecs.md §4): the clock, the phase machine, and the
 * scoring that the mode ruleset defines.
 *
 * Runs last on purpose. It reads the kill events that `damage` produced this
 * tick, so scoring always reflects a completed tick rather than a half-resolved
 * one — and because it is the last writer of the phase, no system this tick ever
 * sees the match end mid-pipeline.
 *
 * Every clock is derived from `world.tick`, never wall time, so the same inputs
 * always end the match on the same tick.
 */
export function matchSystem(world: SimWorld): void {
  const match = world.match;
  const rules = rulesetFor(match.mode);

  // This system runs before `stepWorld` advances the tick counter, so the tick
  // being completed right now is `world.tick`, and the number of ticks this phase
  // has covered including it is one more than `phaseElapsedTicks` reports. Without
  // the +1 every phase overruns by exactly one tick — invisible on a 480 s clock,
  // and the difference between a 5.000 s and a 5.017 s countdown in a test.
  const covered = phaseElapsedTicks(match, world.tick) + 1;

  // The lobby ends when the host presses Start — never on a timer, and never
  // because some quorum was reached. `startMatch` is the only way out.
  if (match.phase === MatchPhase.Waiting) return;

  if (match.phase === MatchPhase.Warmup) {
    if (covered >= Math.round(TUNING.match.warmupSeconds * SIM_HZ)) {
      enterPhaseInPipeline(world, MatchPhase.Live);
    }
    return;
  }
  if (match.phase !== MatchPhase.Live) return;

  // Score the kills this tick. `damage` has already booked kills/deaths, so the
  // ruleset only handles what is mode-specific.
  world.events.forEach((ev) => {
    if (ev.type === SimEventType.Death) rules.onKill(world, ev.b, ev.a);
    else if (ev.type === SimEventType.PickupTaken) rules.onPickup(world, ev.a);
  });
  rules.onTick(world);

  // Frag limit first: reaching it is a decisive win, whereas time running out is
  // only ever "whoever was ahead".
  if (match.fragLimit > 0) {
    for (let entrant = 0; entrant < rules.entrantCount; entrant++) {
      if (!rules.isActive(world, entrant)) continue;
      if (rules.fragsOf(world, entrant) >= match.fragLimit) {
        match.winner = entrant;
        enterPhaseInPipeline(world, MatchPhase.Over);
        return;
      }
    }
  }

  if (match.timeLimitTicks > 0 && covered >= match.timeLimitTicks) {
    match.winner = leader(world);
    enterPhaseInPipeline(world, MatchPhase.Over);
  }
}

/**
 * Leave the lobby and play. **Host only** — a client calling this would move its
 * own projection and be corrected by the next snapshot, which is why nothing on
 * the client path can reach it.
 *
 * Goes straight to `Live` unless the match was configured with a countdown; there
 * is no timer in the lobby, so this is the only thing that starts a match.
 */
export function startMatch(world: SimWorld): void {
  if (world.match.phase !== MatchPhase.Waiting) return;
  enterPhase(world, world.match.warmupAfterWait ? MatchPhase.Warmup : MatchPhase.Live, world.tick);
}

/** Players present, and the minimum a match wants — for the lobby screen. */
export function lobbyCounts(world: SimWorld): { connected: number; needed: number } {
  const p = world.players;
  let connected = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) if (p.connected[i] === 1) connected += 1;
  return { connected, needed: TUNING.match.minPlayers };
}

/**
 * The entrant in front, or `NO_WINNER` on a tie.
 *
 * A tie is reported as no winner rather than as the lowest-numbered entrant,
 * because "player 1 wins" on a drawn match is worse than saying it was a draw.
 */
export function leader(world: SimWorld): number {
  const rules = rulesetFor(world.match.mode);
  let best = NO_WINNER;
  let bestFrags = -1;
  let tied = false;
  for (let entrant = 0; entrant < rules.entrantCount; entrant++) {
    if (!rules.isActive(world, entrant)) continue;
    const frags = rules.fragsOf(world, entrant);
    if (frags > bestFrags) {
      bestFrags = frags;
      best = entrant;
      tied = false;
    } else if (frags === bestFrags) {
      tied = true;
    }
  }
  return tied ? NO_WINNER : best;
}

/**
 * Move to a phase and restart its clock, emitting one event so the renderer,
 * audio and UI all learn about it the same way they learn about a kill — rather
 * than by polling the phase every frame and comparing it to what they saw last.
 *
 * `startTick` is which tick the new phase's clock counts from, and the two callers
 * genuinely differ. `stepWorld` simulates tick `world.tick` and *then* increments,
 * so:
 *
 * - **From inside the pipeline** (`matchSystem`), tick `world.tick` has already
 *   been simulated under the outgoing phase, so the new phase starts at
 *   `world.tick + 1`.
 * - **From outside it** (`startMatch`, `restartMatch` — a button press between
 *   ticks), nothing has run under the outgoing phase since the change, so the new
 *   phase starts at `world.tick` itself.
 *
 * Getting this wrong costs one tick per transition, which is invisible until a
 * test measures the clock and finds 478.017 s where it wanted 478.
 */
function enterPhase(world: SimWorld, phase: MatchPhase, startTick: number): void {
  world.match.phase = phase;
  world.match.phaseStartTick = startTick;
  world.events.emit(SimEventType.MatchPhase, phase, world.match.winner, 0, 0);
}

/** A transition decided while simulating the current tick. */
function enterPhaseInPipeline(world: SimWorld, phase: MatchPhase): void {
  enterPhase(world, phase, world.tick + 1);
}

/**
 * Start a decided match over again, keeping the same rules.
 *
 * Scores are cleared here rather than by rebuilding the world, so a rematch does
 * not have to re-stock pads or re-place players — and, in a networked match, does
 * not have to re-run the join handshake.
 */
export function restartMatch(world: SimWorld): void {
  const p = world.players;
  p.kills.fill(0);
  p.deaths.fill(0);
  world.match.teamFrags.fill(0);
  world.match.winner = NO_WINNER;
  enterPhase(world, MatchPhase.Waiting, world.tick);
}
