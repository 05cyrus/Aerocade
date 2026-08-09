import { MAX_PLAYERS, ALL_PLAYERS } from '../../constants.js';
import { Buttons } from '../input.js';
import { MatchPhase } from '../match/state.js';
import type { SimWorld } from '../world.js';

/**
 * System 1, `input` (docs/ecs.md §4): the only system that touches `in*`/input
 * fields. It gates what the match phase permits before any other system reads an
 * input this tick.
 *
 * Gating here rather than inside `movement` and `weapons` keeps one rule in one
 * place. If each consumer checked the phase itself, a system added later would
 * simply not know to, and "you could still throw grenades during the end screen"
 * is the kind of bug nobody writes a test for.
 *
 * The lobby and the countdown both let players move but not shoot — standing
 * still while you wait feels broken, and getting a free frag off the starting line
 * is worse. Once the match is over everything is frozen so the arena settles under
 * the scoreboard.
 */

/** Everything that commits violence. Cleared during warmup. */
const WEAPON_BUTTONS = Buttons.Fire | Buttons.Melee | Buttons.Grenade;

export function inputGateSystem(world: SimWorld, only: number = ALL_PLAYERS): void {
  const phase = world.match.phase;
  if (phase === MatchPhase.Live) return;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (only !== ALL_PLAYERS && i !== only) continue;
    if (world.players.connected[i] !== 1) continue;
    const input = world.inputs[i];
    if (input === undefined) continue;
    if (phase === MatchPhase.Warmup || phase === MatchPhase.Waiting) {
      // Move and look around, but do not shoot. The Ready button is deliberately
      // untouched — it is how you leave this phase.
      input.buttons &= ~WEAPON_BUTTONS;
      continue;
    }
    // Over: no movement, no aim change, no buttons at all.
    input.moveX = 0;
    input.moveY = 0;
    input.buttons = 0;
  }
}
