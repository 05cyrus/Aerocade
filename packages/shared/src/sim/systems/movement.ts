import { MAX_PLAYERS, SIM_DT } from '../../constants.js';
import { approach } from '../../math/scalar.js';
import { Buttons } from '../input.js';
import { aabbTouchesLadder } from '../map/mapdef.js';
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

    // --- Ladders ---
    // Gripping suspends gravity and hands vertical control to the player.
    // Firing is untouched: weapons never consult ladder state, so you can
    // shoot the whole way up (ADR-018).
    if (updateLadder(world, i, cmd)) {
      const lad = TUNING.ladder;
      if ((pressed & Buttons.Jump) !== 0) {
        // Kick clear of the rungs rather than re-gripping next tick.
        p.onLadder[i] = 0;
        p.ladderRegrip[i] = lad.regripDelay;
        p.velX[i] = cmd.moveX * lad.jumpOffPush;
        p.velY[i] = -lad.jumpOffSpeed;
        p.grounded[i] = 0;
        continue;
      }
      p.velX[i] = approach(velX, cmd.moveX * lad.sideSpeed, t.groundAccel * SIM_DT);
      p.velY[i] = cmd.moveY * lad.climbSpeed;
      p.grounded[i] = 0;
      p.coyote[i] = t.coyoteTime; // stepping off a ladder still allows a jump
      regenFuel(world, i, held);
      continue;
    }

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

/**
 * Decide whether a player is on a ladder this tick and keep the grip/regrip
 * timers. Grabbing on needs a deliberate vertical input while overlapping
 * ladder tiles; you stay attached until you leave them, jump off, or land.
 */
function updateLadder(
  world: SimWorld,
  player: number,
  cmd: { moveX: number; moveY: number },
): boolean {
  const p = world.players;
  const t = TUNING.player;

  const regrip = p.ladderRegrip[player] ?? 0;
  if (regrip > 0) p.ladderRegrip[player] = Math.max(0, regrip - SIM_DT);

  const touching = aabbTouchesLadder(
    world.map,
    p.posX[player] ?? 0,
    p.posY[player] ?? 0,
    t.width / 2,
    t.height / 2,
  );
  if (!touching) {
    p.onLadder[player] = 0;
    return false;
  }

  if (p.onLadder[player] === 1) return true;
  if ((p.ladderRegrip[player] ?? 0) > 0) return false;
  // Grabbing on is deliberate: press up or down while touching the rungs.
  // Without that you would stick to every ladder you ran past.
  if (Math.abs(cmd.moveY) > 0.5) {
    p.onLadder[player] = 1;
    return true;
  }
  return false;
}

/** Fuel regen shared by the ladder path and normal movement. */
function regenFuel(world: SimWorld, player: number, held: number): void {
  const p = world.players;
  const jet = TUNING.jetpack;
  if ((held & Buttons.Thrust) !== 0) return;
  const wait = p.fuelRegenWait[player] ?? 0;
  if (wait > 0) {
    p.fuelRegenWait[player] = Math.max(0, wait - SIM_DT);
    return;
  }
  const fuel = p.fuel[player] ?? 0;
  if (fuel < jet.maxFuel) {
    p.fuel[player] = Math.min(jet.maxFuel, fuel + jet.regenRate * SIM_DT);
  }
}
