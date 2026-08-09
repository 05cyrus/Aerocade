import { MAX_EVENTS } from '../constants.js';

/**
 * Per-tick simulation events: things that *happened* this tick which
 * observers (renderer, audio, netcode, kill feed) care about but which are
 * not part of continuous state. The buffer is preallocated and cleared at the
 * start of every tick; overflow drops events rather than allocating.
 */

export const SimEventType = {
  Shot: 0,
  HitConfirmed: 1,
  Explosion: 2,
  Death: 3,
  Respawn: 4,
  ReloadStart: 5,
  DryFire: 6,
  GrenadeBounce: 7,
  MeleeSwing: 8,
  GrenadeThrow: 9,
  /** One hitscan pellet's resolved path end, for tracer rendering. */
  Trace: 10,
  /** A weapon pad refilled with a freshly rolled weapon. */
  PickupSpawn: 11,
  /** A player collected a ground item. */
  PickupTaken: 12,
  /** Gear hit the ground from a weapon swap or a death. */
  PickupDropped: 13,
  /** The match changed phase. a=new MatchPhase, b=winning entrant or NO_PLAYER. */
  MatchPhase: 14,
} as const;

export type SimEventType = (typeof SimEventType)[keyof typeof SimEventType];

/**
 * One event record. Field meaning depends on `type`:
 * - Shot:          a=shooter, b=weaponId, x/y=muzzle position
 * - HitConfirmed:  a=attacker, b=victim, x/y=impact point
 * - Explosion:     a=owner, b=weaponId (-1 for frag grenade), x/y=center, r=radius
 * - Death:         a=victim, b=killer (NO_PLAYER for world), x/y=death position
 * - Respawn:       a=player, x/y=spawn position
 * - ReloadStart:   a=player, b=weaponId
 * - DryFire:       a=player, b=weaponId
 * - GrenadeBounce: x/y=contact point
 * - MeleeSwing:    a=player, b=1 if it connected, x/y=player position
 * - GrenadeThrow:  a=player, x/y=throw origin
 * - Trace:         a=shooter, b=weaponId, x/y=pellet path endpoint
 * - PickupSpawn:   a=padIndex, b=weaponId, x/y=pad position
 * - MatchPhase:    a=new phase (MatchPhase), b=winning entrant or NO_PLAYER
 * - PickupTaken:   a=player, b=weaponId (-1 for grenades), x/y=item position.
 *                  r means different things per kind: for a weapon it is 1
 *                  when the ammo merged into a gun already carried, 0 on a
 *                  swap; for grenades it is the NUMBER taken, which may be
 *                  fewer than the stack held (partial pickup, ADR-016).
 * - PickupDropped: a=player who dropped it, b=weaponId (-1 for grenades),
 *                  x/y=drop origin
 */
export interface SimEvent {
  type: SimEventType;
  a: number;
  b: number;
  x: number;
  y: number;
  r: number;
}

export class EventBuffer {
  private readonly pool: SimEvent[];
  private len = 0;
  /**
   * While set, `emit` drops everything.
   *
   * Reconciliation re-runs already-simulated ticks (docs/networking.md §7), and
   * those ticks emitted their events the first time round. Without suppression a
   * client would fire the same gunshot again on every snapshot — the correction
   * would be *audible*, which is a worse artefact than the misprediction it fixes.
   */
  private suppressed = false;

  constructor() {
    this.pool = Array.from({ length: MAX_EVENTS }, () => ({
      type: SimEventType.Shot,
      a: 0,
      b: 0,
      x: 0,
      y: 0,
      r: 0,
    }));
  }

  get count(): number {
    return this.len;
  }

  at(index: number): SimEvent {
    const ev = this.pool[index];
    if (ev === undefined || index >= this.len) {
      throw new RangeError(`event index ${String(index)} out of range`);
    }
    return ev;
  }

  clear(): void {
    this.len = 0;
  }

  /** Silence `emit` during a replay; returns the previous setting. */
  setSuppressed(suppressed: boolean): boolean {
    const previous = this.suppressed;
    this.suppressed = suppressed;
    return previous;
  }

  emit(type: SimEventType, a: number, b: number, x: number, y: number, r = 0): void {
    if (this.suppressed) return; // re-simulated tick: it already announced itself
    if (this.len >= MAX_EVENTS) return; // saturated: drop rather than allocate
    const ev = this.pool[this.len];
    if (ev === undefined) return;
    ev.type = type;
    ev.a = a;
    ev.b = b;
    ev.x = x;
    ev.y = y;
    ev.r = r;
    this.len += 1;
  }

  /** Iterate events without allocation. */
  forEach(fn: (ev: SimEvent) => void): void {
    for (let i = 0; i < this.len; i++) {
      const ev = this.pool[i];
      if (ev !== undefined) fn(ev);
    }
  }
}
