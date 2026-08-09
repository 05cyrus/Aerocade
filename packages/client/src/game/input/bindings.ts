import { Buttons, type ButtonMask } from '@aerocade/shared';

/**
 * Keyboard and mouse bindings as data (docs/ui.md §6).
 *
 * `KeyboardMouseInput` used to hard-code `KeyA`, `Space`, mouse button 0 and so
 * on, which is exactly why the settings screen shipped without a rebinding
 * table: a table that cannot actually rebind is worse than no table. Bindings
 * now live here, the sampler reads them, and the UI edits them.
 *
 * Codes are `KeyboardEvent.code`, which is **layout-independent** — `KeyA` is
 * the same physical key on QWERTY and AZERTY. Using `event.key` would rebind
 * itself when the OS layout changed.
 *
 * Mouse buttons share the same flat string space as `Mouse0`/`Mouse1`/`Mouse2`.
 * One namespace means conflict detection is a plain string comparison instead of
 * two parallel code paths, and it lets a player put Fire on a key or Melee on a
 * mouse button without the model caring.
 */

export const InputAction = {
  MoveLeft: 'moveLeft',
  MoveRight: 'moveRight',
  Up: 'up',
  Down: 'down',
  Jump: 'jump',
  Walk: 'walk',
  Fire: 'fire',
  Melee: 'melee',
  Grenade: 'grenade',
  Reload: 'reload',
  SwitchWeapon: 'switchWeapon',
  Interact: 'interact',
  Scope: 'scope',
  /** Hold to show the scoreboard. Presentation only — never enters the sim. */
  Scoreboard: 'scoreboard',
} as const;

export type InputAction = (typeof InputAction)[keyof typeof InputAction];

export const ALL_ACTIONS: readonly InputAction[] = Object.values(InputAction);

export type Bindings = Record<InputAction, readonly string[]>;

/** Two slots per action, so the arrow-key alternates that always worked keep working. */
export const BINDING_SLOTS = 2;

export const DEFAULT_BINDINGS: Bindings = {
  [InputAction.MoveLeft]: ['KeyA', 'ArrowLeft'],
  [InputAction.MoveRight]: ['KeyD', 'ArrowRight'],
  [InputAction.Up]: ['KeyW', 'ArrowUp'],
  [InputAction.Down]: ['KeyS', 'ArrowDown'],
  [InputAction.Jump]: ['Space'],
  [InputAction.Walk]: ['ShiftLeft', 'ShiftRight'],
  [InputAction.Fire]: ['Mouse0'],
  [InputAction.Melee]: ['Mouse2', 'KeyF'],
  [InputAction.Grenade]: ['KeyG'],
  [InputAction.Reload]: ['KeyR'],
  [InputAction.SwitchWeapon]: ['KeyQ'],
  [InputAction.Interact]: ['KeyE'],
  [InputAction.Scope]: ['KeyZ'],
  [InputAction.Scoreboard]: ['Tab'],
};

/** Human-readable rows for the settings table, in display order. */
export const ACTION_LABELS: Record<InputAction, string> = {
  [InputAction.MoveLeft]: 'Move left',
  [InputAction.MoveRight]: 'Move right',
  [InputAction.Up]: 'Up / climb',
  [InputAction.Down]: 'Down / hover',
  [InputAction.Jump]: 'Jump & jetpack',
  [InputAction.Walk]: 'Walk',
  [InputAction.Fire]: 'Fire',
  [InputAction.Melee]: 'Melee',
  [InputAction.Grenade]: 'Grenade',
  [InputAction.Reload]: 'Reload',
  [InputAction.SwitchWeapon]: 'Switch weapon',
  [InputAction.Interact]: 'Take weapon from pad',
  [InputAction.Scope]: 'Scope',
  [InputAction.Scoreboard]: 'Scoreboard (hold)',
};

/**
 * The simulation button each action feeds, where there is one.
 *
 * Movement is an axis rather than a button, and Scope only reframes the camera
 * and never reaches the simulation (ADR-016) — so those map to null and the
 * sampler handles them separately.
 */
export const ACTION_BUTTON: Record<InputAction, ButtonMask | null> = {
  [InputAction.MoveLeft]: null,
  [InputAction.MoveRight]: null,
  [InputAction.Up]: null,
  [InputAction.Down]: null,
  [InputAction.Jump]: Buttons.Jump | Buttons.Thrust,
  [InputAction.Walk]: Buttons.Walk,
  [InputAction.Fire]: Buttons.Fire,
  [InputAction.Melee]: Buttons.Melee,
  [InputAction.Grenade]: Buttons.Grenade,
  [InputAction.Reload]: Buttons.Reload,
  [InputAction.SwitchWeapon]: Buttons.SwitchWeapon,
  [InputAction.Interact]: Buttons.Interact,
  [InputAction.Scope]: null,
  [InputAction.Scoreboard]: null,
};

/** Pseudo-code for a mouse button, so it shares the keyboard's string space. */
export function mouseCode(button: number): string {
  return `Mouse${String(button)}`;
}

const MOUSE_NAMES: Record<string, string> = {
  Mouse0: 'Left click',
  Mouse1: 'Middle click',
  Mouse2: 'Right click',
};

/** Turn a code into something a player recognises on the settings screen. */
export function describeCode(code: string): string {
  const mouse = MOUSE_NAMES[code];
  if (mouse !== undefined) return mouse;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  if (code === 'Space') return 'Space';
  // Sided modifiers: ShiftLeft → "Shift L". Arrows are handled above, so this
  // cannot catch ArrowLeft.
  if (code.endsWith('Left')) return `${code.slice(0, -4)} L`;
  if (code.endsWith('Right')) return `${code.slice(0, -5)} R`;
  return code;
}

/** A code is bindable if it looks like a key code or one of our mouse codes. */
export function isBindableCode(code: unknown): code is string {
  return typeof code === 'string' && code.length > 0 && code.length <= 24;
}

/**
 * Coerce arbitrary stored data into usable bindings.
 *
 * Same contract as the rest of the settings record: never throw, keep whatever
 * validates, default the rest. Two rules earn their place — an action whose
 * bindings all turn out to be junk falls back to its defaults rather than
 * becoming **unbindable**, and duplicates within one action are collapsed so a
 * slot cannot silently shadow the other.
 */
export function normalizeBindings(raw: unknown): Bindings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Partial<Record<InputAction, readonly string[]>> = {};
  for (const action of ALL_ACTIONS) {
    const value = source[action];
    const codes = Array.isArray(value) ? value.filter(isBindableCode) : [];
    const unique = [...new Set(codes)].slice(0, BINDING_SLOTS);
    result[action] = unique.length > 0 ? unique : DEFAULT_BINDINGS[action];
  }
  return result as Bindings;
}

/**
 * Codes bound to more than one action, with the actions that claim them.
 *
 * The settings table warns rather than refusing the edit: blocking a keystroke
 * mid-rebind leaves the player stuck holding a key they cannot place, whereas a
 * visible conflict tells them what to fix and still lets them fix it in any
 * order.
 */
export function findConflicts(bindings: Bindings): Map<string, InputAction[]> {
  const owners = new Map<string, InputAction[]>();
  for (const action of ALL_ACTIONS) {
    for (const code of bindings[action]) {
      const list = owners.get(code) ?? [];
      list.push(action);
      owners.set(code, list);
    }
  }
  for (const [code, actions] of owners) {
    if (actions.length < 2) owners.delete(code);
  }
  return owners;
}

/**
 * Replace one slot.
 *
 * Deliberately does **not** steal the code from other actions. Stealing avoids
 * duplicates, but it can leave an action with nothing bound — binding Grenade to
 * R silently cost the player Reload entirely, with only a dash in a table to
 * show it. Allowing the duplicate and surfacing it (`findConflicts`, plus the
 * inline warning the settings table renders) loses nothing without the player
 * saying so, and matches docs/ui.md §6: warn on duplicates, do not reject.
 */
export function assignBinding(
  bindings: Bindings,
  action: InputAction,
  slot: number,
  code: string,
): Bindings {
  const slots = [...bindings[action]];
  while (slots.length < BINDING_SLOTS) slots.push('');
  slots[slot] = code;
  // Filter empties and any duplicate of this same code within the action, so a
  // slot cannot shadow its sibling.
  const cleaned = [...new Set(slots.filter((c) => c !== ''))].slice(0, BINDING_SLOTS);
  return { ...bindings, [action]: cleaned };
}

/** Clear one slot. An action may legitimately end up with no binding at all. */
export function clearBinding(bindings: Bindings, action: InputAction, slot: number): Bindings {
  const slots = [...bindings[action]];
  if (slot >= slots.length) return bindings;
  slots.splice(slot, 1);
  return { ...bindings, [action]: slots };
}
