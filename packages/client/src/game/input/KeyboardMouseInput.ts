import { type ButtonMask } from '@aerocade/shared';
import {
  ACTION_BUTTON,
  ALL_ACTIONS,
  DEFAULT_BINDINGS,
  InputAction,
  mouseCode,
  type Bindings,
} from './bindings.js';

/**
 * Desktop input sampler. Listens on the window, accumulates state, and is
 * drained once per simulation tick. Presses shorter than one tick are latched so
 * no input is ever lost. Aim is composed by the scene (it needs the camera
 * transform); this class owns buttons and move axes only.
 *
 * Bindings are **data**, not code (see `bindings.ts`): the sampler resolves
 * actions through the current binding table, which is what makes the settings
 * screen's rebinding table possible. Keyboard and mouse share one code space
 * (`KeyA`, `Mouse0`), so an action can be bound to either without a special case
 * here.
 *
 * Scope is deliberately not a simulation button: scoping only reframes the
 * camera, so it never reaches the simulation (ADR-016).
 */
export class KeyboardMouseInput {
  private readonly down = new Set<string>();
  /** Codes pressed since the last sample (latch for sub-tick taps). */
  private latched = new Set<string>();
  private bindings: Bindings = DEFAULT_BINDINGS;

  /** True once per Scope press; consumed by the caller. Client-side only. */
  private scopeToggled = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.down.add(e.code);
    this.latched.add(e.code);
    if (this.isBound(InputAction.Scope, e.code)) this.scopeToggled = true;
    // Space scrolls the page; suppress it only when it is actually bound.
    if (e.code === 'Space' && this.isAnyBinding(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const code = mouseCode(e.button);
    this.down.add(code);
    this.latched.add(code);
    if (this.isBound(InputAction.Scope, code)) this.scopeToggled = true;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.down.delete(mouseCode(e.button));
  };

  private readonly onContextMenu = (e: Event): void => {
    // Right click is bindable (melee by default), so the menu must never open.
    e.preventDefault();
  };

  private readonly onBlur = (): void => {
    // Losing focus mid-press would otherwise latch the player into running.
    this.down.clear();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
  }

  /**
   * Swap the binding table. Held codes are cleared: a key held while its action
   * is rebound would otherwise stay stuck down for an action it no longer feeds.
   */
  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
    this.down.clear();
    this.latched = new Set();
  }

  private isBound(action: InputAction, code: string): boolean {
    return this.bindings[action].includes(code);
  }

  private isAnyBinding(code: string): boolean {
    return ALL_ACTIONS.some((action) => this.bindings[action].includes(code));
  }

  /** Is any code bound to this action currently active (held or latched)? */
  private active(action: InputAction): boolean {
    for (const code of this.bindings[action]) {
      if (this.down.has(code) || this.latched.has(code)) return true;
    }
    return false;
  }

  /** Drain accumulated state into (moveX, moveY, buttons) for one tick. */
  sample(): { moveX: number; moveY: number; buttons: ButtonMask; scopeToggled: boolean } {
    let moveX = 0;
    if (this.active(InputAction.MoveLeft)) moveX -= 1;
    if (this.active(InputAction.MoveRight)) moveX += 1;

    let moveY = 0;
    if (this.active(InputAction.Up)) moveY -= 1;
    if (this.active(InputAction.Down)) moveY += 1;

    let buttons: ButtonMask = 0;
    for (const action of ALL_ACTIONS) {
      const bit = ACTION_BUTTON[action];
      if (bit !== null && this.active(action)) buttons |= bit;
    }

    const scopeToggled = this.scopeToggled;
    this.scopeToggled = false;
    this.latched = new Set();
    return { moveX, moveY, buttons, scopeToggled };
  }
}
