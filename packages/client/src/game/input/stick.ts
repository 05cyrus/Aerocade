/**
 * Virtual joystick maths, per the spec in docs/ui.md §5.
 *
 * Pure and DOM-free on purpose: the touch layer is the hardest input path to
 * test by hand (it needs a device, or at least synthetic pointer events), and
 * every rule here — deadzone re-normalisation, follow-mode re-anchoring, the
 * walk/run tier boundary, fire hysteresis — is a formula that either holds or
 * does not. So the formulas live here and the React component only feeds them
 * pointer coordinates.
 */

/** Visual and input radius at layout scale 1.0, CSS pixels. */
export const STICK_RADIUS_PX = 64;
/** Below this deflection the stick reports zero. */
export const STICK_DEADZONE = 0.18;
/** Drag past this multiple of the radius and the origin follows the finger. */
export const STICK_FOLLOW = 1.6;
/** Horizontal deflection at or above which the player runs instead of walks. */
export const RUN_THRESHOLD = 0.55;
/** Pushing the move stick up this far is an alternate jetpack input. */
export const JET_THRESHOLD = 0.6;
/** Aim-stick deflection that starts firing, and the lower one that stops it. */
export const FIRE_ON = 0.75;
export const FIRE_OFF = 0.65;

export interface StickSample {
  /** Direction scaled by deflection; each component in [-1, 1]. */
  x: number;
  y: number;
  /** Deflection in [0, 1] after the deadzone is removed and re-normalised. */
  magnitude: number;
  /** Screen-space angle in radians (y grows downward), 0 = right. */
  angle: number;
  /** Origin after follow-mode re-anchoring — feed this back next frame. */
  originX: number;
  originY: number;
}

const ZERO_ANGLE = 0;

/**
 * Resolve a finger position against a stick origin.
 *
 * Two details that matter more than they look:
 *
 * - **Deadzone output is re-normalised** from the deadzone edge, not just
 *   gated. Gating alone means the stick jumps from 0 to 0.18 the instant it
 *   passes the threshold, which feels like a stutter at the start of every
 *   movement.
 * - **Follow mode** drags the origin along once the finger passes
 *   `STICK_FOLLOW × radius`, so a long swipe can never pin the stick to a stale
 *   centre and leave the player stuck at full deflection.
 */
export function resolveStick(
  originX: number,
  originY: number,
  pointX: number,
  pointY: number,
  radius: number = STICK_RADIUS_PX,
): StickSample {
  let ox = originX;
  let oy = originY;
  let dx = pointX - ox;
  let dy = pointY - oy;
  let distance = Math.hypot(dx, dy);

  const leash = radius * STICK_FOLLOW;
  if (distance > leash && distance > 0) {
    const pull = distance - leash;
    ox += (dx / distance) * pull;
    oy += (dy / distance) * pull;
    dx = pointX - ox;
    dy = pointY - oy;
    distance = Math.hypot(dx, dy);
  }

  if (distance === 0) {
    return { x: 0, y: 0, magnitude: 0, angle: ZERO_ANGLE, originX: ox, originY: oy };
  }

  const raw = Math.min(distance, radius) / radius;
  const magnitude = raw <= STICK_DEADZONE ? 0 : (raw - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const nx = dx / distance;
  const ny = dy / distance;
  return {
    x: nx * magnitude,
    y: ny * magnitude,
    magnitude,
    angle: Math.atan2(dy, dx),
    originX: ox,
    originY: oy,
  };
}

/**
 * Fire state from aim-stick deflection, with hysteresis. A single threshold
 * makes fire stutter on and off while the thumb rests near the boundary, so
 * starting takes more deflection than continuing.
 */
export function fireHeld(magnitude: number, wasHeld: boolean): boolean {
  return wasHeld ? magnitude >= FIRE_OFF : magnitude >= FIRE_ON;
}

/**
 * Map horizontal stick deflection onto the sim's move axis and walk flag.
 *
 * The sim's `moveX` is analog (`target = moveX * speedCap`) and `Buttons.Walk`
 * swaps the cap between the two speed tiers. Naively setting Walk below the
 * threshold and passing the raw deflection makes speed *drop* as you cross it —
 * 0.54 × 4.2 = 2.3 m/s, then 0.56 × 7.4 = 4.1 m/s — so the axis is rescaled per
 * tier: the walk band spans 0 → walkSpeed, and the run band continues from
 * walkSpeed → runSpeed. Speed is then continuous across the boundary, which is
 * what the tiers in docs/ui.md §5 actually mean.
 */
export function moveAxis(
  stickX: number,
  walkSpeed: number,
  runSpeed: number,
): { moveX: number; walk: boolean } {
  const deflection = Math.min(1, Math.abs(stickX));
  if (deflection === 0) return { moveX: 0, walk: false };
  const direction = Math.sign(stickX);

  if (deflection < RUN_THRESHOLD) {
    return { moveX: direction * (deflection / RUN_THRESHOLD), walk: true };
  }
  const floor = runSpeed > 0 ? walkSpeed / runSpeed : 1;
  const t = (deflection - RUN_THRESHOLD) / (1 - RUN_THRESHOLD);
  return { moveX: direction * (floor + t * (1 - floor)), walk: false };
}
