import { MAX_PLAYERS, SIM_DT } from '../../constants.js';
import { approach } from '../../math/scalar.js';
import { Buttons } from '../input.js';
import { TUNING } from '../tuning.js';
import type { SimWorld } from '../world.js';

/**
 * Player locomotion: reads this tick's inputs and updates velocities, aim,
 * fuel, and timers. Position integration and collision belong to the physics
 * system. y grows downward, so "up" is negative velY.
 */
export function movementSystem(world: SimWorld): void {
  const p = world.players;
  const t = TUNING.player;
  const jet = TUNING.jetpack;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1) continue;

    // Timers that run for connected players regardless of life state.
    const protect = p.protect[i] ?? 0;
    if (protect > 0) p.protect[i] = Math.max(0, protect - SIM_DT);

    if (p.status[i] !== 1) continue;

    const cmd = world.inputs[i];
    if (cmd === undefined) continue;
    const prev = p.prevButtons[i] ?? 0;
    const held = cmd.buttons;
    const pressed = held & ~prev;

    p.aim[i] = cmd.aim;

    let velX = p.velX[i] ?? 0;
    let velY = p.velY[i] ?? 0;
    const grounded = p.grounded[i] === 1;

    // --- Horizontal: run/walk with analog magnitude, friction when idle ---
    const walking = (held & Buttons.Walk) !== 0;
    const speedCap = walking ? t.walkSpeed : t.runSpeed;
    const target = cmd.moveX * speedCap;
    if (grounded) {
      const accel = cmd.moveX !== 0 ? t.groundAccel : t.groundFriction;
      velX = approach(velX, target, accel * SIM_DT);
    } else {
      if (cmd.moveX !== 0) {
        // Air control accelerates toward the desired speed but never brakes a
        // faster same-direction velocity, preserving rocket-jump momentum.
        const sameDirFaster =
          Math.sign(velX) === Math.sign(target) && Math.abs(velX) > Math.abs(target);
        if (!sameDirFaster) {
          velX = approach(velX, target, t.airAccel * SIM_DT);
        }
      }
      velX -= velX * t.airDrag * SIM_DT;
    }

    // --- Coyote time & jump ---
    if (grounded) {
      p.coyote[i] = t.coyoteTime;
    } else {
      p.coyote[i] = Math.max(0, (p.coyote[i] ?? 0) - SIM_DT);
    }
    if ((pressed & Buttons.Jump) !== 0 && (grounded || (p.coyote[i] ?? 0) > 0)) {
      velY = -t.jumpSpeed;
      p.coyote[i] = 0;
      p.grounded[i] = 0;
    }

    // --- Gravity (with variable jump height: cut rises harder when released) ---
    const rising = velY < 0;
    const jumpHeld = (held & Buttons.Jump) !== 0;
    const thrustHeld = (held & Buttons.Thrust) !== 0;
    const gravityMult = rising && !jumpHeld && !thrustHeld ? t.jumpCutGravityMult : 1;
    velY += t.gravity * gravityMult * SIM_DT;

    // --- Jetpack: climb, or hover (altitude hold) with the down input ---
    const fuel = p.fuel[i] ?? 0;
    if (thrustHeld && fuel > 0) {
      const wantsHover = cmd.moveY > 0.5 && !grounded;
      if (wantsHover) {
        // Altitude hold: cancel this tick's gravity and settle vertical speed.
        // Cheaper on fuel than climbing — deliberate positioning is rewarded.
        velY -= t.gravity * gravityMult * SIM_DT;
        velY = approach(velY, 0, jet.hoverBrake * SIM_DT);
        p.fuel[i] = Math.max(0, fuel - jet.hoverBurnRate * SIM_DT);
      } else {
        velY -= jet.thrust * SIM_DT;
        if (velY < -jet.maxRiseSpeed) velY = -jet.maxRiseSpeed;
        p.fuel[i] = Math.max(0, fuel - jet.burnRate * SIM_DT);
      }
      p.fuelRegenWait[i] = jet.regenDelay;
    } else {
      const wait = p.fuelRegenWait[i] ?? 0;
      if (wait > 0) {
        p.fuelRegenWait[i] = Math.max(0, wait - SIM_DT);
      } else if (fuel < jet.maxFuel) {
        p.fuel[i] = Math.min(jet.maxFuel, fuel + jet.regenRate * SIM_DT);
      }
    }

    if (velY > t.maxFallSpeed) velY = t.maxFallSpeed;

    p.velX[i] = velX;
    p.velY[i] = velY;
  }
}
