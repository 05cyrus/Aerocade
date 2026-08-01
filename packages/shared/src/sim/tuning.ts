/**
 * All gameplay tuning in one place. Systems must not embed gameplay numbers —
 * if a value shapes how the game feels, it lives here (weapon stats live in
 * `combat/weapon-defs.ts`). Units: meters, seconds, radians; y grows downward.
 *
 * Every value is an original Aerocade tuning decision.
 */
export const TUNING = {
  player: {
    /** Collision box, centered on the player position. */
    width: 0.85,
    height: 1.65,
    maxHealth: 100,
    /** Top ground speed with the stick fully deflected (running). */
    runSpeed: 7.4,
    /** Ground speed with the walk modifier (or partial stick). */
    walkSpeed: 4.2,
    groundAccel: 55,
    /** Deceleration applied on the ground when there is no move input. */
    groundFriction: 48,
    airAccel: 26,
    /** Mild horizontal damping while airborne, so knockback settles. */
    airDrag: 1.6,
    jumpSpeed: 8.6,
    /** Extra gravity multiplier while rising with jump released (variable jump height). */
    jumpCutGravityMult: 2.2,
    /** Grace period after leaving a ledge during which a jump is still allowed. */
    coyoteTime: 0.08,
    gravity: 21,
    maxFallSpeed: 26,
    respawnDelay: 3,
    spawnProtection: 2.5,
    /** Grenades carried at spawn. */
    spawnGrenades: 3,
    /**
     * Absolute speed ceiling after knockback stacking. Keeps per-tick
     * displacement well under one tile so swept collision can never tunnel.
     */
    hardSpeedCap: 45,
  },
  jetpack: {
    /** Upward acceleration while thrusting (must exceed gravity to climb). */
    thrust: 38,
    maxFuel: 100,
    /** Fuel per second while thrusting normally. */
    burnRate: 46,
    /**
     * Fuel per second while hovering. Hover = thrust held together with the
     * down input (S / stick-down): the jetpack cancels gravity and brakes
     * vertical speed toward zero instead of climbing.
     */
    hoverBurnRate: 20,
    /** Vertical braking acceleration while hovering, m/s². */
    hoverBrake: 19,
    /** Fuel per second regained once regen starts. */
    regenRate: 30,
    /** Idle time after thrusting before fuel starts regenerating. */
    regenDelay: 0.6,
    /** Climb speed cap so sustained thrust doesn't accelerate forever. */
    maxRiseSpeed: 11,
  },
  melee: {
    damage: 25,
    /** Seconds between swings. */
    cycleTime: 0.5,
    range: 1.3,
    /** Half-angle of the swing arc around the aim direction. */
    halfArc: 70 * (Math.PI / 180),
    knockback: 9,
  },
  grenade: {
    fuse: 2.6,
    throwSpeed: 14,
    /** Fraction of the thrower's velocity inherited by the grenade. */
    velocityInherit: 0.4,
    damage: 62,
    radius: 3.4,
    knockback: 14,
    restitution: 0.45,
    /** Tangential velocity kept on each bounce. */
    bounceFriction: 0.8,
    gravityFactor: 1,
  },
  combat: {
    /** Cooldown imposed after a weapon switch. */
    switchDelay: 0.25,
    /** Distance from the player center at which projectiles spawn. */
    muzzleOffset: 0.6,
    /** Fraction of explosion damage applied to its owner (rocket-jump friendly). */
    selfDamageFrac: 0.6,
    /** Damage retained at the edge of an explosion radius. */
    explosionEdgeDamageFrac: 0.25,
    /** Damage retained at a hitscan weapon's falloff end. */
    falloffMinDamageFrac: 0.4,
    /** Knockback impulse per point of hitscan damage dealt. */
    hitscanKnockbackPerDamage: 0.12,
  },
  match: {
    /** Default match length (used from M4; the sandbox ignores it). */
    durationSeconds: 480,
    killScore: 100,
  },
} as const;

export type Tuning = typeof TUNING;
