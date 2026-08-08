import { Buttons, type ButtonMask } from '@aerocade/shared';
import { applyDeadzone, moveAxis } from './stick.js';

/**
 * Gamepad input channel (docs/ui.md §6 "gamepad bindings").
 *
 * The Gamepad API is **poll-only** — there are no button events, and a `Gamepad`
 * object is a snapshot that never updates — so `navigator.getGamepads()` has to
 * be re-read every tick. That suits this codebase: `sample()` is already called
 * once per simulation tick, exactly like the keyboard and touch samplers.
 *
 * Mapping is separated from polling so it can be unit tested with synthetic pads
 * rather than requiring a controller plugged into CI.
 *
 * Bindings follow the W3C "standard" layout, which is what browsers normalise
 * Xbox and PlayStation pads to:
 *
 * | Control            | Action                                    |
 * | ------------------ | ----------------------------------------- |
 * | Left stick / D-pad | Move (analog: walk below 0.55 deflection) |
 * | Left stick down    | Hover, when held with thrust (ADR-011)    |
 * | Right stick        | Aim (absolute direction, like the mouse)  |
 * | Right trigger      | Fire                                      |
 * | South (A / ✕)      | Jump and jetpack                          |
 * | Left bumper        | Melee                                     |
 * | Right bumper       | Grenade                                   |
 * | West (X / □)       | Reload                                    |
 * | North (Y / △)      | Switch weapon                             |
 * | East (B / ○)       | Take the weapon off a pad                 |
 */

/** Standard-mapping indices, named so the mapping reads as intent. */
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

const BTN_SOUTH = 0;
const BTN_EAST = 1;
const BTN_WEST = 2;
const BTN_NORTH = 3;
const BTN_LEFT_BUMPER = 4;
const BTN_RIGHT_BUMPER = 5;
const BTN_RIGHT_TRIGGER = 7;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

/** Analog triggers report a value; half-pressed counts as pressed. */
const TRIGGER_THRESHOLD = 0.5;

/** Only the parts of `Gamepad` this module reads, so tests can fake one. */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

export interface GamepadFrame {
  moveX: number;
  moveY: number;
  buttons: ButtonMask;
  /** Absolute aim angle, or null when the right stick is idle. */
  aim: number | null;
}

function pressed(pad: GamepadLike, index: number): boolean {
  const button = pad.buttons[index];
  if (button === undefined) return false;
  return button.pressed || button.value >= TRIGGER_THRESHOLD;
}

function axis(pad: GamepadLike, index: number): number {
  const value = pad.axes[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Map one gamepad snapshot onto the sim's input frame.
 *
 * The D-pad is folded into the move axis at full deflection so it is a valid way
 * to play, and it wins over the stick when both are pushed — a player mashing
 * the D-pad while their thumb rests on a drifting stick should get the D-pad.
 */
export function mapGamepad(pad: GamepadLike, walkSpeed: number, runSpeed: number): GamepadFrame {
  const left = applyDeadzone(axis(pad, AXIS_LEFT_X), axis(pad, AXIS_LEFT_Y));

  let dpadX = 0;
  if (pressed(pad, BTN_DPAD_LEFT)) dpadX -= 1;
  if (pressed(pad, BTN_DPAD_RIGHT)) dpadX += 1;
  let dpadY = 0;
  if (pressed(pad, BTN_DPAD_UP)) dpadY -= 1;
  if (pressed(pad, BTN_DPAD_DOWN)) dpadY += 1;

  const rawX = dpadX !== 0 ? dpadX : left.x;
  const rawY = dpadY !== 0 ? dpadY : left.y;
  const move = moveAxis(rawX, walkSpeed, runSpeed);

  let buttons: ButtonMask = 0;
  if (move.walk) buttons |= Buttons.Walk;
  if (pressed(pad, BTN_SOUTH)) buttons |= Buttons.Jump | Buttons.Thrust;
  if (pressed(pad, BTN_RIGHT_TRIGGER)) buttons |= Buttons.Fire;
  if (pressed(pad, BTN_LEFT_BUMPER)) buttons |= Buttons.Melee;
  if (pressed(pad, BTN_RIGHT_BUMPER)) buttons |= Buttons.Grenade;
  if (pressed(pad, BTN_WEST)) buttons |= Buttons.Reload;
  if (pressed(pad, BTN_NORTH)) buttons |= Buttons.SwitchWeapon;
  if (pressed(pad, BTN_EAST)) buttons |= Buttons.Interact;

  // Aim is absolute, matching the mouse and the touch aim stick, so an idle
  // right stick must report null rather than an angle of 0 — that would snap
  // the soldier to face right the moment a pad is connected.
  const right = applyDeadzone(axis(pad, AXIS_RIGHT_X), axis(pad, AXIS_RIGHT_Y));
  const aim = right.magnitude > 0 ? right.angle : null;

  return { moveX: move.moveX, moveY: rawY, buttons, aim };
}

const IDLE: GamepadFrame = { moveX: 0, moveY: 0, buttons: 0, aim: null };

export class GamepadInput {
  constructor(
    private readonly walkSpeed: number,
    private readonly runSpeed: number,
  ) {}

  /**
   * First connected pad wins. Re-read every call: a `Gamepad` object is a
   * snapshot, so holding one and reading it later returns stale values.
   */
  private firstConnected(): GamepadLike | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    for (const pad of navigator.getGamepads()) {
      // Browsers pad this array with nulls for empty slots, so the optional
      // chain is doing real work rather than being defensive noise.
      if (pad?.connected === true) return pad;
    }
    return null;
  }

  get connected(): boolean {
    return this.firstConnected() !== null;
  }

  sample(): GamepadFrame {
    const pad = this.firstConnected();
    if (pad === null) return IDLE;
    return mapGamepad(pad, this.walkSpeed, this.runSpeed);
  }
}
