import { describe, expect, it } from 'vitest';
import { TUNING } from '@aerocade/shared';
import {
  fireHeld,
  moveAxis,
  resolveStick,
  FIRE_OFF,
  FIRE_ON,
  RUN_THRESHOLD,
  STICK_DEADZONE,
  STICK_FOLLOW,
  STICK_RADIUS_PX,
} from '../src/game/input/stick.js';

const R = STICK_RADIUS_PX;

describe('virtual stick geometry', () => {
  it('reports zero at the origin', () => {
    const s = resolveStick(100, 100, 100, 100);
    expect(s.magnitude).toBe(0);
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
  });

  it('swallows movement inside the deadzone', () => {
    const inside = resolveStick(0, 0, R * STICK_DEADZONE * 0.9, 0);
    expect(inside.magnitude).toBe(0);
  });

  it('re-normalises from the deadzone edge instead of jumping', () => {
    // Just past the deadzone must be near zero, not 0.18. A gate-only
    // implementation makes movement start with a lurch.
    const justPast = resolveStick(0, 0, R * (STICK_DEADZONE + 0.01), 0);
    expect(justPast.magnitude).toBeGreaterThan(0);
    expect(justPast.magnitude).toBeLessThan(0.05);
  });

  it('reaches exactly 1 at the rim and clamps beyond it', () => {
    expect(resolveStick(0, 0, R, 0).magnitude).toBeCloseTo(1, 6);
    // Still 1 well past the rim, but only until follow mode kicks in.
    expect(resolveStick(0, 0, R * 1.4, 0).magnitude).toBeCloseTo(1, 6);
  });

  it('gives screen-space angles with y pointing down', () => {
    expect(resolveStick(0, 0, R, 0).angle).toBeCloseTo(0, 6); // right
    expect(resolveStick(0, 0, 0, R).angle).toBeCloseTo(Math.PI / 2, 6); // down
    expect(resolveStick(0, 0, 0, -R).angle).toBeCloseTo(-Math.PI / 2, 6); // up
  });

  it('keeps the origin put until the follow leash is exceeded', () => {
    const inside = resolveStick(0, 0, R * (STICK_FOLLOW - 0.1), 0);
    expect(inside.originX).toBe(0);
  });

  it('drags the origin along past the leash, holding full deflection', () => {
    const far = resolveStick(0, 0, R * 4, 0);
    // The origin trails the finger by exactly the leash length, so the stick can
    // never be pinned at a stale centre by a long swipe.
    expect(far.originX).toBeCloseTo(R * 4 - R * STICK_FOLLOW, 6);
    expect(far.magnitude).toBeCloseTo(1, 6);
  });

  it('lets a re-anchored origin be pulled back to neutral', () => {
    // Swipe far right, then return to where the finger started: with follow mode
    // the stick must read as pushed LEFT of its new origin, not stuck right.
    const far = resolveStick(0, 0, R * 4, 0);
    const back = resolveStick(far.originX, far.originY, 0, 0);
    expect(back.x).toBeLessThan(0);
  });
});

describe('fire threshold hysteresis', () => {
  it('needs more deflection to start than to continue', () => {
    expect(FIRE_ON).toBeGreaterThan(FIRE_OFF);
  });

  it('does not fire below the start threshold', () => {
    expect(fireHeld(FIRE_ON - 0.01, false)).toBe(false);
  });

  it('fires at the start threshold', () => {
    expect(fireHeld(FIRE_ON, false)).toBe(true);
  });

  it('keeps firing in the hysteresis band once started', () => {
    // This band is the whole point: a thumb resting near the boundary would
    // otherwise stutter the trigger on and off every frame.
    const mid = (FIRE_ON + FIRE_OFF) / 2;
    expect(fireHeld(mid, true)).toBe(true);
    expect(fireHeld(mid, false)).toBe(false);
  });

  it('releases below the stop threshold', () => {
    expect(fireHeld(FIRE_OFF - 0.01, true)).toBe(false);
  });
});

describe('move axis tiers', () => {
  const { walkSpeed, runSpeed } = TUNING.player;
  const speed = (stickX: number): number => {
    const { moveX, walk } = moveAxis(stickX, walkSpeed, runSpeed);
    return Math.abs(moveX) * (walk ? walkSpeed : runSpeed);
  };

  it('is still at rest', () => {
    expect(moveAxis(0, walkSpeed, runSpeed)).toEqual({ moveX: 0, walk: false });
  });

  it('walks below the run threshold and runs above it', () => {
    expect(moveAxis(RUN_THRESHOLD - 0.05, walkSpeed, runSpeed).walk).toBe(true);
    expect(moveAxis(RUN_THRESHOLD + 0.05, walkSpeed, runSpeed).walk).toBe(false);
  });

  it('hits exactly walk speed at the tier boundary', () => {
    expect(speed(RUN_THRESHOLD - 1e-9)).toBeCloseTo(walkSpeed, 3);
    expect(speed(RUN_THRESHOLD)).toBeCloseTo(walkSpeed, 3);
  });

  it('is continuous across the boundary rather than dropping', () => {
    // The bug this guards: setting Walk below the threshold and passing raw
    // deflection makes speed FALL as you push further (0.54*4.2 = 2.3 m/s, then
    // 0.56*7.4 = 4.1 m/s is a jump, and worse orderings actually invert).
    const below = speed(RUN_THRESHOLD - 0.01);
    const above = speed(RUN_THRESHOLD + 0.01);
    expect(above).toBeGreaterThanOrEqual(below);
    expect(Math.abs(above - below)).toBeLessThan(0.3);
  });

  it('reaches full run speed at the rim', () => {
    expect(speed(1)).toBeCloseTo(runSpeed, 3);
  });

  it('rises monotonically across the whole travel', () => {
    let previous = -1;
    for (let d = 0; d <= 1.0001; d += 0.02) {
      const v = speed(d);
      expect(v, `deflection ${d.toFixed(2)}`).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
    }
  });

  it('mirrors for leftward deflection', () => {
    expect(moveAxis(-0.8, walkSpeed, runSpeed).moveX).toBeCloseTo(
      -moveAxis(0.8, walkSpeed, runSpeed).moveX,
      6,
    );
  });

  it('never exceeds the sim input range', () => {
    for (const d of [-2, -1, -0.3, 0.3, 1, 2]) {
      const { moveX } = moveAxis(d, walkSpeed, runSpeed);
      expect(Math.abs(moveX)).toBeLessThanOrEqual(1);
    }
  });
});
