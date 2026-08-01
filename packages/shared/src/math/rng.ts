/**
 * Deterministic PRNG (mulberry32). The simulation must never touch
 * `Math.random`; every source of randomness flows through the world's Rng so
 * that replaying the same seed + inputs reproduces the same match.
 *
 * The 32-bit state is part of the snapshot, so reconciliation replays and
 * lag-compensation rewinds restore the exact random stream.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Current internal state, for snapshots. */
  get state(): number {
    return this.s;
  }

  set state(value: number) {
    this.s = value >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Symmetric spread around zero: uniform in [-halfWidth, +halfWidth]. */
  spread(halfWidth: number): number {
    return (this.float() * 2 - 1) * halfWidth;
  }
}
