/**
 * Procedural sound synthesis.
 *
 * Every clip is generated from code at boot, and this remains the **floor** for
 * every sound in the game: `SoundBank` fills its whole buffer map from here
 * before any file is fetched, so a match is fully audible with nothing loaded.
 *
 * Recorded samples are layered over the top where they are better
 * ([ADR-030](../../../../../docs/DECISIONS.md)), which is a change from the
 * original position of shipping no audio files at all ([ADR-001](../../../../../docs/DECISIONS.md)).
 * What that ADR bought is kept regardless: a sample that is missing, 404s, or
 * hits a codec the browser cannot decode falls back to the clip below it rather
 * than going silent, so the synthesis is not dead weight — it is the reason the
 * files are safe to depend on.
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
  /**
   * One firing sound per weapon, no sharing. Two guns that share a clip read as
   * the same gun no matter how differently they behave, and the roster has two
   * pairs that used to do exactly that.
   *
   * The numbers each one is built from are bounded by its `cycleTime`
   * (weapon-defs.ts): a clip whose loud part outlasts the fire interval overlaps
   * itself at full auto and smears into noise. The Vortex SMG cycles every 90 ms,
   * which is the tightest budget in the roster and why its clip is the shortest.
   */
  ShotPistol: 'shot-pistol',
  ShotSmg: 'shot-smg',
  ShotRifle: 'shot-rifle',
  ShotShotgun: 'shot-shotgun',
  ShotSniper: 'shot-sniper',
  ShotThumper: 'shot-thumper',
  ShotLobber: 'shot-lobber',
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
    // Rivet Pistol (0.28 s cycle, 16 dmg): a tight dry snap, mid-bodied. The
    // reference point the rest are heard against.
    [SfxId.ShotPistol]: gunshot(sampleRate, {
      seconds: 0.16,
      tau: 0.034,
      bodyHz: 232,
      bright: 0.58,
      drive: 1.5,
      seed: 0x511,
    }),
    // Vortex SMG (0.09 s cycle, 9 dmg): the shortest and thinnest in the roster.
    // Held down it becomes a texture rather than seven separate shots, so it is
    // deliberately small — a fuller clip here just muddies itself.
    [SfxId.ShotSmg]: gunshot(sampleRate, {
      seconds: 0.082,
      tau: 0.016,
      bodyHz: 305,
      bright: 0.74,
      drive: 1.3,
      seed: 0x516,
    }),
    // Pulse Rifle (0.14 s cycle, 14 dmg): the energy outlier. Low `bright` with a
    // high body leaves a tuned zap instead of a powder crack, which is the one
    // weapon in the roster that should not sound like a firearm.
    [SfxId.ShotRifle]: gunshot(sampleRate, {
      seconds: 0.13,
      tau: 0.032,
      bodyHz: 268,
      bright: 0.3,
      drive: 2.0,
      seed: 0x512,
    }),
    // Scattergun (0.85 s cycle, 8 pellets): low and broad, the pellets read as
    // one wide blast rather than eight events.
    [SfxId.ShotShotgun]: gunshot(sampleRate, {
      seconds: 0.36,
      tau: 0.1,
      bodyHz: 104,
      bright: 0.3,
      drive: 2.2,
      seed: 0x513,
    }),
    // Longbolt Rifle (1.5 s cycle, 70 dmg): the loudest and longest. It gets the
    // tail budget the automatics cannot afford, which is most of what sells a
    // one-shot weapon.
    [SfxId.ShotSniper]: gunshot(sampleRate, {
      seconds: 0.55,
      tau: 0.15,
      bodyHz: 140,
      bright: 0.62,
      drive: 2.8,
      seed: 0x514,
    }),
    // Thumper (1.1 s cycle, explosive projectile): a deep launch whump with the
    // crack almost entirely removed — it throws a shell, it does not shoot.
    [SfxId.ShotThumper]: gunshot(sampleRate, {
      seconds: 0.42,
      tau: 0.145,
      bodyHz: 66,
      bright: 0.09,
      drive: 1.9,
      seed: 0x515,
    }),
    // Lobber (0.75 s cycle, projectile): the same family as the Thumper but
    // hollow and higher — a lighter tube lobbing a lighter shell. Separated from
    // it on pitch, length and decay together, because one axis is not enough to
    // tell two launchers apart.
    [SfxId.ShotLobber]: gunshot(sampleRate, {
      seconds: 0.28,
      tau: 0.082,
      bodyHz: 98,
      bright: 0.17,
      drive: 1.6,
      seed: 0x517,
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
