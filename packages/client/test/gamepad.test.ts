import { describe, expect, it } from 'vitest';
import { Buttons, TUNING } from '@aerocade/shared';
import { mapGamepad, type GamepadLike } from '../src/game/input/GamepadInput.js';
import { applyDeadzone, RUN_THRESHOLD, STICK_DEADZONE } from '../src/game/input/stick.js';

const { walkSpeed, runSpeed } = TUNING.player;

/** Build a standard-mapping pad with everything neutral, then override. */
function pad(
  overrides: { axes?: Partial<Record<number, number>>; press?: number[] } = {},
): GamepadLike {
  const axes = Array.from({ length: 4 }, (_, i) => overrides.axes?.[i] ?? 0);
  const down = new Set(overrides.press ?? []);
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: down.has(i),
    value: down.has(i) ? 1 : 0,
  }));
  return { axes, buttons };
}

const map = (p: GamepadLike): ReturnType<typeof mapGamepad> => mapGamepad(p, walkSpeed, runSpeed);

describe('gamepad: neutral state', () => {
  it('reports nothing at rest', () => {
    const frame = map(pad());
    expect(frame.moveX).toBe(0);
    expect(frame.moveY).toBe(0);
    expect(frame.buttons).toBe(0);
  });

  it('leaves aim null when the right stick is idle', () => {
    // Critical: returning an angle of 0 here would snap the soldier to face
    // right the instant a controller is connected, stealing mouse aim.
    expect(map(pad()).aim).toBeNull();
  });

  it('ignores stick drift inside the deadzone', () => {
    const drifting = pad({ axes: { 0: STICK_DEADZONE * 0.8, 2: STICK_DEADZONE * 0.8 } });
    const frame = map(drifting);
    expect(frame.moveX).toBe(0);
    expect(frame.aim).toBeNull();
  });

  it('survives a pad reporting missing or broken axes', () => {
    const broken: GamepadLike = { axes: [NaN, undefined as unknown as number], buttons: [] };
    expect(() => map(broken)).not.toThrow();
    expect(map(broken).moveX).toBe(0);
  });
});

describe('gamepad: movement', () => {
  it('walks on a small left-stick push and runs on a large one', () => {
    expect(map(pad({ axes: { 0: RUN_THRESHOLD - 0.2 } })).buttons & Buttons.Walk).not.toBe(0);
    expect(map(pad({ axes: { 0: 1 } })).buttons & Buttons.Walk).toBe(0);
  });

  it('reaches full move axis at full stick deflection', () => {
    expect(map(pad({ axes: { 0: 1 } })).moveX).toBeCloseTo(1, 6);
    expect(map(pad({ axes: { 0: -1 } })).moveX).toBeCloseTo(-1, 6);
  });

  it('accepts the D-pad as full deflection', () => {
    expect(map(pad({ press: [15] })).moveX).toBeCloseTo(1, 6); // right
    expect(map(pad({ press: [14] })).moveX).toBeCloseTo(-1, 6); // left
  });

  it('lets the D-pad win over a drifting stick', () => {
    // A thumb resting on a worn stick must not fight the D-pad.
    const both = pad({ axes: { 0: 0.9 }, press: [14] });
    expect(map(both).moveX).toBeLessThan(0);
  });

  it('passes stick-down through for hover', () => {
    // Hover is thrust + down input (ADR-011), so moveY has to survive.
    const frame = map(pad({ axes: { 1: 1 }, press: [0] }));
    expect(frame.moveY).toBeGreaterThan(0);
    expect(frame.buttons & Buttons.Thrust).not.toBe(0);
  });

  it('does not skew direction on a diagonal beyond unit length', () => {
    // Sticks can report (1, 1), length √2. Normalising by the clamped length
    // would bend a 45° push away from the diagonal.
    const diagonal = applyDeadzone(1, 1);
    expect(diagonal.angle).toBeCloseTo(Math.PI / 4, 6);
    expect(diagonal.magnitude).toBeCloseTo(1, 6);
  });
});

describe('gamepad: aim', () => {
  it('aims absolutely from the right stick', () => {
    expect(map(pad({ axes: { 2: 1 } })).aim).toBeCloseTo(0, 6); // right
    expect(map(pad({ axes: { 3: -1 } })).aim).toBeCloseTo(-Math.PI / 2, 6); // up
    expect(map(pad({ axes: { 2: -1 } })).aim).toBeCloseTo(Math.PI, 6); // left
  });

  it('does not fire just because the aim stick is pushed', () => {
    // Unlike the touch layer, a pad has a trigger — so aiming and firing stay
    // separate and you can track a target without shooting.
    expect(map(pad({ axes: { 2: 1, 3: 1 } })).buttons & Buttons.Fire).toBe(0);
  });
});

describe('gamepad: button bindings', () => {
  const cases: [string, number, number][] = [
    ['south jumps and thrusts', 0, Buttons.Jump | Buttons.Thrust],
    ['right trigger fires', 7, Buttons.Fire],
    ['left bumper melees', 4, Buttons.Melee],
    ['right bumper throws a grenade', 5, Buttons.Grenade],
    ['west reloads', 2, Buttons.Reload],
    ['north switches weapon', 3, Buttons.SwitchWeapon],
    ['east interacts', 1, Buttons.Interact],
  ];
  for (const [label, index, expected] of cases) {
    it(label, () => {
      expect(map(pad({ press: [index] })).buttons & expected).toBe(expected);
    });
  }

  it('treats a half-pulled analog trigger as pressed', () => {
    const halfPulled: GamepadLike = {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({
        pressed: false, // analog triggers often report pressed=false mid-travel
        value: i === 7 ? 0.7 : 0,
      })),
    };
    expect(map(halfPulled).buttons & Buttons.Fire).not.toBe(0);
  });

  it('combines several inputs at once', () => {
    const busy = map(pad({ axes: { 0: 1, 2: 0, 3: -1 }, press: [0, 7] }));
    expect(busy.buttons & Buttons.Fire).not.toBe(0);
    expect(busy.buttons & Buttons.Jump).not.toBe(0);
    expect(busy.moveX).toBeCloseTo(1, 6);
    expect(busy.aim).toBeCloseTo(-Math.PI / 2, 6);
  });
});
