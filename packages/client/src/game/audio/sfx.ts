/**
 * Procedural sound synthesis.
 *
 * Every clip is generated from code at boot. Aerocade ships no audio files for
 * the same reason it ships no image files ([ADR-001](../../../../../docs/DECISIONS.md)):
 * originality by construction, and a PWA precache that stays tiny.
 *
 * This module is deliberately **pure and DOM-free** — it returns raw mono
 * sample data and knows nothing about Web Audio — so the synthesis can be unit
 * tested in Node. `SoundBank` is the part that needs a browser.
 *
 * Conventions:
 * - Samples are mono `Float32Array` in [-1, 1]; anything louder is soft-clipped
 *   with `tanh` rather than allowed to wrap.
 * - Oscillators accumulate **phase** instead of evaluating `sin(2π f t)`. With a
 *   swept frequency the latter is not a real oscillator — the phase jumps every
 *   sample and it buzzes.
 * - Noise comes from a seeded generator, never `Math.random`: the same clip must
 *   be produced on every boot, exactly like texture generation. This is the
 *   render-side RNG and is entirely separate from the sim's (ADR-009).
 */

export const SfxId = {
  /** Pistol and SMG: tight, dry crack. */
  ShotLight: 'shot-light',
  ShotRifle: 'shot-rifle',
  ShotShotgun: 'shot-shotgun',
  ShotSniper: 'shot-sniper',
  /** Thumper and Lobber: a deep launch whump, no crack. */
  ShotLauncher: 'shot-launcher',
  Explosion: 'explosion',
  /** Hitmarker tick — feedback that a shot connected. */
  Hit: 'hit',
  Death: 'death',
  Reload: 'reload',
  DryFire: 'dry-fire',
  GrenadeBounce: 'grenade-bounce',
  /** Grenade throw and melee swing share one air-swipe. */
  Whoosh: 'whoosh',
  PickupTaken: 'pickup-taken',
  PadRespawn: 'pad-respawn',
  /** The only looping clip: jetpack thrust, gated by a gain ramp. */
  JetLoop: 'jet-loop',
} as const;

export type SfxId = (typeof SfxId)[keyof typeof SfxId];

/** Ids whose buffers are meant to loop rather than one-shot. */
export const LOOPING: readonly SfxId[] = [SfxId.JetLoop];

const TAU = Math.PI * 2;

/**
 * Seeded PRNG (mulberry32). Same algorithm the renderer uses for texture noise;
 * a fixed seed per clip keeps every boot byte-identical.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scale a clip so its loudest sample sits at `peak`. */
function normalize(out: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const sample of out) {
    const v = Math.abs(sample);
    if (v > max) max = v;
  }
  if (max === 0) return out;
  const gain = peak / max;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * gain;
  return out;
}

interface GunOptions {
  seconds: number;
  /** Amplitude decay time constant, seconds. Longer = boomier tail. */
  tau: number;
  /** Starting pitch of the body thump, Hz. */
  bodyHz: number;
  /** One-pole lowpass coefficient for the noise crack: higher = brighter. */
  bright: number;
  /** Pre-clip drive. Above ~1 the tanh starts adding grit. */
  drive: number;
  seed: number;
}

/**
 * A gunshot: a bright noise crack over a short pitch-down thump. Every firearm
 * in the roster is this recipe with different numbers, which is what makes them
 * sound like one family of weapons rather than unrelated noises.
 */
function gunshot(sampleRate: number, o: GunOptions): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * o.seconds));
  const out = new Float32Array(n);
  const rand = mulberry32(o.seed);
  let lp = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / o.tau);
    lp += (rand() * 2 - 1 - lp) * o.bright;
    // Body pitch falls fast, so the thump lands under the crack, not with it.
    const hz = o.bodyHz * (0.32 + 0.68 * Math.exp(-t / (o.tau * 0.5)));
    phase += (TAU * hz) / sampleRate;
    out[i] = Math.tanh((lp * 1.7 + Math.sin(phase) * 0.95) * env * o.drive);
  }
  return normalize(out, 0.92);
}

function explosion(sampleRate: number): Float32Array {
  const n = Math.floor(sampleRate * 1.1);
  const out = new Float32Array(n);
  const rand = mulberry32(0x00b001);
  let lp = 0;
  let lp2 = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.34);
    // Two cascaded lowpasses: one pole leaves too much hiss to read as a blast.
    lp += (rand() * 2 - 1 - lp) * 0.05;
    lp2 += (lp - lp2) * 0.28;
    const hz = 78 * (0.3 + 0.7 * Math.exp(-t / 0.12));
    phase += (TAU * hz) / sampleRate;
    // Sharp transient only in the first few ms, so the onset punches.
    const crack = t < 0.012 ? (rand() * 2 - 1) * (1 - t / 0.012) * 0.7 : 0;
    out[i] = Math.tanh((lp2 * 7 + Math.sin(phase) * 1.15 + crack) * env * 1.5);
  }
  return normalize(out, 0.98);
}

/** A short pitched tick. Used for hitmarkers and mechanical clicks. */
function tick(
  sampleRate: number,
  hz: number,
  tau: number,
  noiseMix: number,
  seed: number,
): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * tau * 6));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / tau);
    phase += (TAU * hz) / sampleRate;
    lp += (rand() * 2 - 1 - lp) * 0.5;
    out[i] = Math.tanh((Math.sin(phase) * (1 - noiseMix) + lp * noiseMix) * env * 1.4);
  }
  return normalize(out, 0.7);
}

function death(sampleRate: number): Float32Array {
  const n = Math.floor(sampleRate * 0.75);
  const out = new Float32Array(n);
  const rand = mulberry32(0x0dead1);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.26);
    // Falling tone: reads as "systems down" without being a musical sting.
    const hz = 300 * Math.exp(-t / 0.32) + 55;
    phase += (TAU * hz) / sampleRate;
    lp += (rand() * 2 - 1 - lp) * 0.12;
    out[i] = Math.tanh((Math.sin(phase) * 0.8 + lp * 2.2) * env);
  }
  return normalize(out, 0.85);
}

/** Two mechanical clicks: magazine out, magazine in. */
function reload(sampleRate: number): Float32Array {
  const gap = 0.17;
  const first = tick(sampleRate, 780, 0.02, 0.75, 0x0c11c1);
  const second = tick(sampleRate, 520, 0.03, 0.8, 0x0c11c2);
  const offset = Math.floor(sampleRate * gap);
  const out = new Float32Array(offset + second.length);
  for (let i = 0; i < first.length && i < out.length; i++) out[i] = first[i] ?? 0;
  for (let i = 0; i < second.length; i++) {
    out[offset + i] = (out[offset + i] ?? 0) + (second[i] ?? 0) * 0.9;
  }
  return normalize(out, 0.62);
}

/** Air swipe: noise whose brightness sweeps up then down. */
function whoosh(sampleRate: number): Float32Array {
  const n = Math.floor(sampleRate * 0.26);
  const out = new Float32Array(n);
  const rand = mulberry32(0x0f00d5);
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const p = t / (n / sampleRate);
    const env = Math.sin(Math.PI * p) ** 1.5; // swells and fades
    lp += (rand() * 2 - 1 - lp) * (0.05 + 0.3 * p);
    // One-pole highpass (x - previous lowpass) thins the rumble out.
    const hp = lp - prev;
    prev += (lp - prev) * 0.08;
    out[i] = Math.tanh(hp * 6 * env);
  }
  return normalize(out, 0.5);
}

/** Two rising blips — the "you got it" confirmation. */
function twoTone(sampleRate: number, aHz: number, bHz: number, seconds: number): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  const half = Math.floor(n / 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const inSecond = i >= half;
    const local = (inSecond ? i - half : i) / sampleRate;
    const env = Math.exp(-local / (seconds * 0.16));
    phase += (TAU * (inSecond ? bHz : aHz)) / sampleRate;
    out[i] = Math.sin(phase) * env * 0.8;
  }
  return normalize(out, 0.55);
}

/** Soft rising chime: a pad has restocked. */
function chime(sampleRate: number): Float32Array {
  const n = Math.floor(sampleRate * 0.34);
  const out = new Float32Array(n);
  let phase = 0;
  let harm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.13) * Math.min(1, t / 0.01);
    const hz = 420 + 320 * (t / (n / sampleRate));
    phase += (TAU * hz) / sampleRate;
    harm += (TAU * hz * 2) / sampleRate;
    out[i] = (Math.sin(phase) * 0.75 + Math.sin(harm) * 0.25) * env;
  }
  return normalize(out, 0.45);
}

/**
 * Jetpack thrust: a steady dark rush plus a low rumble, crossfaded end-to-start
 * so it loops without a click. Played once as a looping source and gated by
 * gain, never restarted per frame.
 */
function jetLoop(sampleRate: number): Float32Array {
  const fade = Math.floor(sampleRate * 0.06);
  const n = Math.floor(sampleRate * 1.0);
  const raw = new Float32Array(n);
  const rand = mulberry32(0x0e7a17);
  let lp = 0;
  let lp2 = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    lp += (rand() * 2 - 1 - lp) * 0.07;
    lp2 += (lp - lp2) * 0.3;
    phase += (TAU * 58) / sampleRate;
    raw[i] = Math.tanh(lp2 * 6 + Math.sin(phase) * 0.22);
  }
  // Blend the tail over the head, then drop the tail: the seam disappears.
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    raw[i] = (raw[i] ?? 0) * w + (raw[n - fade + i] ?? 0) * (1 - w);
  }
  return normalize(raw.slice(0, n - fade), 0.8);
}

/**
 * Render every clip. Called once at boot; a few hundred kB of Float32 and a few
 * milliseconds of maths, so it costs about as much as the texture atlas.
 */
export function renderSfx(sampleRate: number): Record<SfxId, Float32Array> {
  return {
    [SfxId.ShotLight]: gunshot(sampleRate, {
      seconds: 0.16,
      tau: 0.035,
      bodyHz: 210,
      bright: 0.55,
      drive: 1.5,
      seed: 0x511,
    }),
    [SfxId.ShotRifle]: gunshot(sampleRate, {
      seconds: 0.22,
      tau: 0.05,
      bodyHz: 165,
      bright: 0.45,
      drive: 1.8,
      seed: 0x512,
    }),
    [SfxId.ShotShotgun]: gunshot(sampleRate, {
      seconds: 0.36,
      tau: 0.1,
      bodyHz: 110,
      bright: 0.3,
      drive: 2.2,
      seed: 0x513,
    }),
    [SfxId.ShotSniper]: gunshot(sampleRate, {
      seconds: 0.5,
      tau: 0.14,
      bodyHz: 132,
      bright: 0.6,
      drive: 2.6,
      seed: 0x514,
    }),
    [SfxId.ShotLauncher]: gunshot(sampleRate, {
      seconds: 0.4,
      tau: 0.13,
      bodyHz: 74,
      bright: 0.12,
      drive: 1.9,
      seed: 0x515,
    }),
    [SfxId.Explosion]: explosion(sampleRate),
    [SfxId.Hit]: tick(sampleRate, 1650, 0.022, 0.15, 0x00417),
    [SfxId.Death]: death(sampleRate),
    [SfxId.Reload]: reload(sampleRate),
    [SfxId.DryFire]: tick(sampleRate, 900, 0.014, 0.85, 0x0d19),
    [SfxId.GrenadeBounce]: tick(sampleRate, 560, 0.055, 0.2, 0x0b0c),
    [SfxId.Whoosh]: whoosh(sampleRate),
    [SfxId.PickupTaken]: twoTone(sampleRate, 680, 1020, 0.16),
    [SfxId.PadRespawn]: chime(sampleRate),
    [SfxId.JetLoop]: jetLoop(sampleRate),
  };
}
