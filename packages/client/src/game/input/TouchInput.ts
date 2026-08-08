import { Buttons, type ButtonMask } from '@aerocade/shared';

/**
 * Touch input channel. Mirrors `KeyboardMouseInput`'s role: accumulate device
 * state, drained once per simulation tick, so the simulation cannot tell a
 * thumb from a keyboard (docs/ui.md §5).
 *
 * This is a module singleton rather than store state on purpose. The sticks
 * produce continuous values read at 60 Hz; putting them in the React store
 * would re-render the HUD on the game loop's schedule, which docs/ui.md §4
 * forbids outright. The existing one-shot latches (`requestInteract` and
 * friends) already use this pattern — sticks just need held values instead of
 * single pulses.
 *
 * Taps shorter than one tick are latched, exactly as the keyboard sampler does,
 * or a quick grenade tap between ticks would be swallowed.
 */
export class TouchInput {
  private moveX = 0;
  private moveY = 0;
  /** Null when the aim stick is not engaged, so the pointer keeps aiming. */
  private aim: number | null = null;
  private held: ButtonMask = 0;
  private latched: ButtonMask = 0;
  /** True once any touch control has been used, so the layer can reveal itself. */
  private used = false;

  setMove(moveX: number, moveY: number): void {
    this.moveX = moveX;
    this.moveY = moveY;
    this.used = true;
  }

  clearMove(): void {
    this.moveX = 0;
    this.moveY = 0;
  }

  /** Aim angle in radians, or null to hand aiming back to the mouse. */
  setAim(angle: number | null): void {
    this.aim = angle;
    if (angle !== null) this.used = true;
  }

  press(button: ButtonMask): void {
    this.held |= button;
    this.latched |= button;
    this.used = true;
  }

  release(button: ButtonMask): void {
    this.held &= ~button;
  }

  /** Drop everything — used when the control layer unmounts or loses pointers. */
  reset(): void {
    this.moveX = 0;
    this.moveY = 0;
    this.aim = null;
    this.held = 0;
    this.latched = 0;
  }

  get everUsed(): boolean {
    return this.used;
  }

  /**
   * Drain one tick's worth of state. `aim` is returned separately from the
   * button mask because the scene composes aim from the camera for mouse play;
   * a non-null value here overrides that.
   */
  sample(): { moveX: number; moveY: number; buttons: ButtonMask; aim: number | null } {
    const buttons = this.held | this.latched;
    this.latched = 0;
    return { moveX: this.moveX, moveY: this.moveY, buttons, aim: this.aim };
  }
}

/** Shared instance: the React control layer writes it, the game loop reads it. */
export const touchInput = new TouchInput();

/**
 * Does this device want touch controls at all? Coarse pointer without hover is
 * the reliable signal for phones and tablets; `maxTouchPoints` alone is true on
 * plenty of touch-capable laptops, where showing thumb sticks over the game
 * would be wrong.
 */
export function prefersTouchControls(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
}

export { Buttons };
