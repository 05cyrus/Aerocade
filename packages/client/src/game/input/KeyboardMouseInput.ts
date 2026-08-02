import { Buttons, type ButtonMask } from '@aerocade/shared';

/**
 * Desktop input sampler. Listens on the window, accumulates state, and is
 * drained once per simulation tick. Key taps shorter than one tick are
 * latched so no press is ever lost. Aim is composed by the scene (it needs
 * the camera transform); this class owns buttons and move axes only.
 *
 * Bindings (docs/ui.md): A/D move, Space jump + jetpack, S hover,
 * Shift walk, LMB fire, RMB melee, G grenade, R reload, Q switch weapon,
 * E take the weapon on the pad you are standing on.
 */
export class KeyboardMouseInput {
  private readonly down = new Set<string>();
  /** Keys pressed since the last sample (latch for sub-tick taps). */
  private latched = new Set<string>();
  private mouseDown = 0; // bitmask of pressed mouse buttons
  private mouseLatched = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.down.add(e.code);
    this.latched.add(e.code);
    if (e.code === 'Space') e.preventDefault(); // page scroll
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    this.mouseDown |= 1 << e.button;
    this.mouseLatched |= 1 << e.button;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseDown &= ~(1 << e.button);
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault(); // right click is melee
  };

  private readonly onBlur = (): void => {
    this.down.clear();
    this.mouseDown = 0;
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

  private active(code: string): boolean {
    return this.down.has(code) || this.latched.has(code);
  }

  private mouseActive(button: number): boolean {
    const bit = 1 << button;
    return (this.mouseDown & bit) !== 0 || (this.mouseLatched & bit) !== 0;
  }

  /** Drain accumulated state into (moveX, moveY, buttons) for one tick. */
  sample(): { moveX: number; moveY: number; buttons: ButtonMask } {
    let moveX = 0;
    if (this.active('KeyA') || this.active('ArrowLeft')) moveX -= 1;
    if (this.active('KeyD') || this.active('ArrowRight')) moveX += 1;

    let moveY = 0;
    if (this.active('KeyW') || this.active('ArrowUp')) moveY -= 1;
    if (this.active('KeyS') || this.active('ArrowDown')) moveY += 1;

    let buttons = 0;
    if (this.active('Space')) buttons |= Buttons.Jump | Buttons.Thrust;
    if (this.active('ShiftLeft') || this.active('ShiftRight')) buttons |= Buttons.Walk;
    if (this.active('KeyG')) buttons |= Buttons.Grenade;
    if (this.active('KeyR')) buttons |= Buttons.Reload;
    if (this.active('KeyQ')) buttons |= Buttons.SwitchWeapon;
    if (this.active('KeyF')) buttons |= Buttons.Melee;
    if (this.active('KeyE')) buttons |= Buttons.Interact;
    if (this.mouseActive(0)) buttons |= Buttons.Fire;
    if (this.mouseActive(2)) buttons |= Buttons.Melee;

    this.latched = new Set();
    this.mouseLatched = 0;
    return { moveX, moveY, buttons };
  }
}
