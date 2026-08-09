import { ALL_PLAYERS } from '../constants.js';
import { inputGateSystem } from './systems/input-gate.js';
import { movementSystem } from './systems/movement.js';
import { physicsSystem } from './systems/physics.js';
import { weaponsSystem } from './systems/weapons.js';
import type { InputCommand } from './input.js';
import { setInput, type SimWorld } from './world.js';

/**
 * Advance **one** player by one tick, using the same systems the host runs.
 *
 * This is the client's half of prediction and reconciliation
 * (docs/networking.md §7). It deliberately runs only systems 1–4 —
 * input → movement → physics → weapons — and only for a single slot:
 *
 * - **Only these systems**, because the rest are authoritative and cannot be
 *   predicted honestly. Damage depends on where everyone else really is,
 *   projectiles and pickups are contested, and the match clock belongs to the
 *   host. Predicting them would produce a client that disagrees about who died.
 * - **Only this slot**, because the client has no idea what anyone else pressed.
 *   Stepping remote players would move them off their snapshot positions on
 *   nothing but a guess, and every arriving snapshot would yank them back.
 *
 * Events are **not** suppressed here. A freshly predicted tick must announce
 * itself — hearing your own shot immediately is half of what prediction buys. It
 * is the *replay* of already-simulated ticks that must stay silent, so
 * suppression is the caller's job (see `ClientSession.reconcile`).
 *
 * `prevButtons` is committed here exactly as `stepWorld` does it, because
 * edge-triggered actions (semi-auto fire, interact, weapon switch) read it — a
 * replay that skipped it would let one press fire twice.
 */
export function predictPlayer(world: SimWorld, slot: number, command: InputCommand): void {
  if (slot < 0 || slot === ALL_PLAYERS) return;
  setInput(world, slot, command);

  inputGateSystem(world, slot);
  movementSystem(world, slot);
  physicsSystem(world, slot);
  weaponsSystem(world, slot);

  world.players.prevButtons[slot] = world.inputs[slot]?.buttons ?? 0;
}
