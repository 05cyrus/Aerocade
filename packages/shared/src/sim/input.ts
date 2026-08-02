/**
 * Player input as the simulation consumes it. One `InputCommand` per player
 * per tick. Clients sample devices into this shape; the host validates it
 * before feeding it to the simulation (see docs/security.md).
 */

/** Button bitfield. Held state every tick; the sim edge-detects where needed. */
export const Buttons = {
  Jump: 1 << 0,
  Thrust: 1 << 1,
  Fire: 1 << 2,
  Melee: 1 << 3,
  Grenade: 1 << 4,
  Reload: 1 << 5,
  SwitchWeapon: 1 << 6,
  Walk: 1 << 7,
  /**
   * Context action — currently "take the weapon on the pad I'm standing on".
   * Edge-triggered by the sim, so holding it never grabs the next respawn.
   */
  Interact: 1 << 8,
} as const;

export type ButtonMask = number;

/**
 * Every defined button bit. Derived rather than hard-coded so adding a button
 * cannot silently leave it stripped by `sanitizeInput`.
 */
export const ALL_BUTTONS: ButtonMask = Object.values(Buttons).reduce((mask, bit) => mask | bit, 0);

export interface InputCommand {
  /** Client-side monotonically increasing sequence number (netcode acking). */
  seq: number;
  /** Horizontal move axis in [-1, 1]. Magnitude selects walk/run speed. */
  moveX: number;
  /**
   * Vertical move axis in [-1, 1], y-down (+1 = down input).
   * moveY > 0.5 while Thrust is held triggers jetpack hover (ADR-011) — any
   * wire codec or input sampler must preserve at least that threshold.
   */
  moveY: number;
  /** Aim direction in radians, screen convention (y-down, 0 = right). */
  aim: number;
  /** OR of `Buttons` flags held this tick. */
  buttons: ButtonMask;
}

/** A neutral command (used for absent players and packet-loss gaps). */
export function emptyInput(): InputCommand {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, buttons: 0 };
}

/**
 * Clamp a (potentially hostile) command into legal ranges, in place.
 * The host runs this on every command before simulation.
 */
export function sanitizeInput(cmd: InputCommand): InputCommand {
  cmd.moveX = Number.isFinite(cmd.moveX) ? Math.max(-1, Math.min(1, cmd.moveX)) : 0;
  cmd.moveY = Number.isFinite(cmd.moveY) ? Math.max(-1, Math.min(1, cmd.moveY)) : 0;
  cmd.aim = Number.isFinite(cmd.aim) ? cmd.aim : 0;
  cmd.buttons = (cmd.buttons >>> 0) & ALL_BUTTONS;
  return cmd;
}
