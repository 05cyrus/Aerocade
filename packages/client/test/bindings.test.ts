import { describe, expect, it } from 'vitest';
import { ALL_BUTTONS } from '@aerocade/shared';
import {
  ACTION_BUTTON,
  ACTION_LABELS,
  ALL_ACTIONS,
  assignBinding,
  BINDING_SLOTS,
  clearBinding,
  DEFAULT_BINDINGS,
  describeCode,
  findConflicts,
  InputAction,
  mouseCode,
  normalizeBindings,
} from '../src/game/input/bindings.js';

describe('default bindings', () => {
  it('binds every action', () => {
    // An unbound action ships as a control the player cannot use and cannot
    // discover is missing.
    for (const action of ALL_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length, action).toBeGreaterThan(0);
    }
  });

  it('labels every action for the settings table', () => {
    for (const action of ALL_ACTIONS) expect(ACTION_LABELS[action], action).toBeTruthy();
  });

  it('never exceeds the slot count', () => {
    for (const action of ALL_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length, action).toBeLessThanOrEqual(BINDING_SLOTS);
    }
  });

  it('starts with no conflicts', () => {
    expect([...findConflicts(DEFAULT_BINDINGS).keys()]).toEqual([]);
  });

  it('maps action buttons onto real simulation bits', () => {
    for (const action of ALL_ACTIONS) {
      const bit = ACTION_BUTTON[action];
      if (bit === null) continue;
      // A bit outside ALL_BUTTONS would be silently stripped by sanitizeInput,
      // so the binding would look wired up and do nothing.
      expect(bit & ~ALL_BUTTONS, action).toBe(0);
    }
  });

  it('leaves movement and scope off the button mask', () => {
    // Movement is an axis; scope is camera-only and never reaches the sim.
    expect(ACTION_BUTTON[InputAction.MoveLeft]).toBeNull();
    expect(ACTION_BUTTON[InputAction.MoveRight]).toBeNull();
    expect(ACTION_BUTTON[InputAction.Scope]).toBeNull();
  });
});

describe('normalizeBindings', () => {
  it('falls back to defaults for junk', () => {
    for (const junk of [null, undefined, 7, 'keys', []]) {
      expect(normalizeBindings(junk)).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('keeps a valid custom binding', () => {
    const result = normalizeBindings({ ...DEFAULT_BINDINGS, fire: ['KeyJ'] });
    expect(result[InputAction.Fire]).toEqual(['KeyJ']);
  });

  it('restores defaults for an action whose bindings are all junk', () => {
    // Otherwise a corrupt record could leave Fire permanently unbindable, with
    // no way back except clearing storage.
    const result = normalizeBindings({ fire: [null, 42, {}] });
    expect(result[InputAction.Fire]).toEqual(DEFAULT_BINDINGS[InputAction.Fire]);
  });

  it('collapses duplicates inside one action', () => {
    const result = normalizeBindings({ fire: ['KeyJ', 'KeyJ'] });
    expect(result[InputAction.Fire]).toEqual(['KeyJ']);
  });

  it('truncates to the slot count', () => {
    const result = normalizeBindings({ fire: ['KeyJ', 'KeyK', 'KeyL', 'KeyM'] });
    expect(result[InputAction.Fire]).toHaveLength(BINDING_SLOTS);
  });

  it('is idempotent', () => {
    const once = normalizeBindings({ fire: ['KeyJ', 'KeyJ', 'KeyK'] });
    expect(normalizeBindings(once)).toEqual(once);
  });
});

describe('conflict detection', () => {
  it('reports a code claimed by two actions', () => {
    const clashing = { ...DEFAULT_BINDINGS, [InputAction.Grenade]: ['KeyR'] };
    const conflicts = findConflicts(clashing);
    expect(conflicts.has('KeyR')).toBe(true);
    expect(conflicts.get('KeyR')).toContain(InputAction.Reload);
    expect(conflicts.get('KeyR')).toContain(InputAction.Grenade);
  });

  it('does not report a code used twice within one action', () => {
    // normalizeBindings already collapses those, and reporting them would
    // accuse the player of a conflict with themselves.
    expect(findConflicts(normalizeBindings({ fire: ['KeyJ', 'KeyJ'] })).size).toBe(0);
  });
});

describe('assignBinding', () => {
  it('sets the requested slot', () => {
    const next = assignBinding(DEFAULT_BINDINGS, InputAction.Fire, 0, 'KeyJ');
    expect(next[InputAction.Fire][0]).toBe('KeyJ');
  });

  it('leaves the other owner alone and reports the clash', () => {
    // Stealing the code would silently strip Reload of its only binding. The
    // duplicate is allowed and surfaced instead, so nothing is lost without the
    // player choosing it (docs/ui.md §6).
    const next = assignBinding(DEFAULT_BINDINGS, InputAction.Grenade, 0, 'KeyR');
    expect(next[InputAction.Grenade]).toContain('KeyR');
    expect(next[InputAction.Reload]).toContain('KeyR');
    // Order is an implementation detail of the iteration, so compare as a set.
    const owners = findConflicts(next).get('KeyR') ?? [];
    expect([...owners].sort()).toEqual([InputAction.Grenade, InputAction.Reload].sort());
  });

  it('never strips another action to zero bindings', () => {
    let bindings = DEFAULT_BINDINGS;
    // Bind every action to one shared key; nothing should end up empty.
    for (const action of ALL_ACTIONS) bindings = assignBinding(bindings, action, 0, 'KeyX');
    for (const action of ALL_ACTIONS) {
      expect(bindings[action].length, action).toBeGreaterThan(0);
    }
  });

  it('does not disturb other actions', () => {
    const next = assignBinding(DEFAULT_BINDINGS, InputAction.Fire, 0, 'KeyJ');
    expect(next[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('fills the second slot without dropping the first', () => {
    const next = assignBinding(DEFAULT_BINDINGS, InputAction.Grenade, 1, 'KeyH');
    expect(next[InputAction.Grenade]).toEqual(['KeyG', 'KeyH']);
  });

  it('never exceeds the slot count', () => {
    let bindings = DEFAULT_BINDINGS;
    for (const code of ['KeyJ', 'KeyK', 'KeyL']) {
      bindings = assignBinding(bindings, InputAction.Fire, 1, code);
    }
    expect(bindings[InputAction.Fire].length).toBeLessThanOrEqual(BINDING_SLOTS);
  });

  it('accepts mouse buttons in the same code space as keys', () => {
    const next = assignBinding(DEFAULT_BINDINGS, InputAction.Grenade, 0, mouseCode(1));
    expect(next[InputAction.Grenade]).toContain('Mouse1');
  });
});

describe('clearBinding', () => {
  it('removes just that slot', () => {
    const next = clearBinding(DEFAULT_BINDINGS, InputAction.MoveLeft, 1);
    expect(next[InputAction.MoveLeft]).toEqual(['KeyA']);
  });

  it('tolerates clearing a slot that was already empty', () => {
    const next = clearBinding(DEFAULT_BINDINGS, InputAction.Jump, 1);
    expect(next[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('allows an action to end up with nothing bound', () => {
    const next = clearBinding(DEFAULT_BINDINGS, InputAction.Scope, 0);
    expect(next[InputAction.Scope]).toEqual([]);
  });
});

describe('describeCode', () => {
  const cases: [string, string][] = [
    ['KeyA', 'A'],
    ['Digit1', '1'],
    ['ArrowLeft', 'Left arrow'],
    ['Space', 'Space'],
    ['ShiftLeft', 'Shift L'],
    ['ShiftRight', 'Shift R'],
    ['Mouse0', 'Left click'],
    ['Mouse2', 'Right click'],
  ];
  for (const [code, expected] of cases) {
    it(`renders ${code} as "${expected}"`, () => {
      expect(describeCode(code)).toBe(expected);
    });
  }

  it('falls back to the raw code for anything unrecognised', () => {
    expect(describeCode('F13')).toBe('F13');
  });

  it('describes every default binding as something readable', () => {
    for (const action of ALL_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(describeCode(code), code).toBeTruthy();
      }
    }
  });
});
