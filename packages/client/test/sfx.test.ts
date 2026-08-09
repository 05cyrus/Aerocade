import { describe, expect, it } from 'vitest';
import { weaponDef } from '@aerocade/shared';
import { LOOPING, renderSfx, SfxId } from '../src/game/audio/sfx.js';
import { SoundBank } from '../src/game/audio/SoundBank.js';
import { SHOT_SFX, shotSfx, WEAPON_IDS } from '../src/game/audio/weapon-sfx.js';

/**
 * The first tests in the client package. Sound synthesis is the natural place
 * to start: it is pure maths over a Float32Array, so it needs no DOM, no canvas
 * and no Web Audio — exactly the kind of client logic that was going untested.
 *
 * These assert the properties that actually break audio in practice. A clip
 * that is silent, clipped, or full of NaN still "plays" — it just sounds wrong
 * or blows the master out — so eyeballing the code catches none of it.
 */

const RATES = [44100, 48000];

describe('procedural sound synthesis', () => {
  for (const rate of RATES) {
    describe(`at ${String(rate)} Hz`, () => {
      const clips = renderSfx(rate);

      it('renders every declared sound id', () => {
        for (const id of Object.values(SfxId)) {
          expect(clips[id], id).toBeInstanceOf(Float32Array);
          expect(clips[id].length, `${id} is empty`).toBeGreaterThan(0);
        }
      });

      it('produces only finite samples', () => {
        // A single NaN silences the rest of a Web Audio buffer on some
        // implementations, and it is trivially introduced by a divide-by-zero
        // in an envelope.
        for (const id of Object.values(SfxId)) {
          for (const sample of clips[id]) {
            if (!Number.isFinite(sample)) {
              throw new Error(`${id} contains a non-finite sample`);
            }
          }
        }
      });

      it('stays inside the [-1, 1] range so nothing clips the master', () => {
        for (const id of Object.values(SfxId)) {
          let peak = 0;
          for (const sample of clips[id]) peak = Math.max(peak, Math.abs(sample));
          expect(peak, `${id} peak`).toBeLessThanOrEqual(1);
        }
      });

      it('is actually audible — no clip is silent or near-silent', () => {
        for (const id of Object.values(SfxId)) {
          let peak = 0;
          for (const sample of clips[id]) peak = Math.max(peak, Math.abs(sample));
          expect(peak, `${id} is inaudible`).toBeGreaterThan(0.2);
        }
      });

      it('scales clip length with the sample rate', () => {
        // Durations are expressed in seconds, so a clip must contain more
        // samples at a higher rate. Getting this wrong makes every sound play
        // at the wrong speed on 48 kHz hardware.
        const seconds = clips[SfxId.Explosion].length / rate;
        expect(seconds).toBeGreaterThan(0.5);
        expect(seconds).toBeLessThan(2);
      });
    });
  }

  it('is deterministic: two renders are sample-identical', () => {
    // Clips are noise-based but must never use Math.random, or a reload would
    // change how the game sounds and no bug here would ever reproduce.
    const a = renderSfx(48000);
    const b = renderSfx(48000);
    for (const id of Object.values(SfxId)) {
      expect(a[id].length, id).toBe(b[id].length);
      for (let i = 0; i < a[id].length; i++) {
        if (a[id][i] !== b[id][i]) throw new Error(`${id} differs at sample ${String(i)}`);
      }
    }
  });

  it('gives every weapon its own clip, with none shared', () => {
    // The whole point: the Rivet Pistol and Vortex SMG used to fire the same
    // clip, as did the Thumper and Lobber, so two different guns sounded like
    // one. Length is checked separately below — this is about the mapping.
    expect(SHOT_SFX).toHaveLength(WEAPON_IDS.length);
    expect(new Set(SHOT_SFX).size, 'no two weapons share a clip').toBe(SHOT_SFX.length);
    for (const weapon of WEAPON_IDS) {
      expect(shotSfx(weapon), weaponDef(weapon).name).toBe(SHOT_SFX[weapon]);
    }
  });

  it('keeps every weapon clip inside its own fire interval', () => {
    // A clip whose loud part outlasts the fire interval overlaps itself at full
    // auto and smears into noise. The Vortex SMG cycles every 90 ms, so this is
    // a real constraint and not a rounding concern.
    const clips = renderSfx(48000);
    for (const weapon of WEAPON_IDS) {
      const def = weaponDef(weapon);
      const clip = clips[shotSfx(weapon)];
      const loud = loudSeconds(clip, 48000);
      expect(
        loud,
        `${def.name}: ${(loud * 1000).toFixed(0)}ms of loud over a ${(def.cycleTime * 1000).toFixed(
          0,
        )}ms cycle`,
      ).toBeLessThanOrEqual(def.cycleTime);
    }
  });

  it('separates every pair of weapons on more than one axis', () => {
    // Two clips that differ only in length are still the same gun to a player.
    // Every pair must differ meaningfully on at least two of: duration,
    // brightness (zero-crossing rate), loudness, and decay time — which is what
    // stops a "distinct" roster from being one sound with the tail trimmed.
    const clips = renderSfx(48000);
    const measured = WEAPON_IDS.map((w) => ({
      name: weaponDef(w).name,
      ...features(clips[shotSfx(w)], 48000),
    }));

    for (let i = 0; i < measured.length; i++) {
      for (let j = i + 1; j < measured.length; j++) {
        const a = measured[i];
        const b = measured[j];
        if (a === undefined || b === undefined) throw new Error('missing measurement');
        const axes = {
          duration: ratio(a.seconds, b.seconds),
          brightness: ratio(a.zcr, b.zcr),
          loudness: ratio(a.rms, b.rms),
          decay: ratio(a.decaySeconds, b.decaySeconds),
        };
        // 15% apart counts as separated on that axis.
        const separated = Object.entries(axes).filter(([, r]) => r >= 1.15);
        expect(
          separated.length,
          `${a.name} vs ${b.name}: only ${separated
            .map(([k]) => k)
            .join(', ')} differ — ${JSON.stringify(
            Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, Number(v.toFixed(2))])),
          )}`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('marks only the jetpack as looping', () => {
    expect([...LOOPING]).toEqual([SfxId.JetLoop]);
  });
});

/** Larger of the two over the smaller, so 1 means identical. */
function ratio(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  const lo = Math.min(Math.abs(a), Math.abs(b));
  return lo === 0 ? (hi === 0 ? 1 : Infinity) : hi / lo;
}

/**
 * Seconds the clip spends above a tenth of its own peak — the part a player
 * hears as "the shot", as opposed to the tail that is free to overlap.
 */
function loudSeconds(clip: Float32Array, sampleRate: number): number {
  let peak = 0;
  for (const s of clip) peak = Math.max(peak, Math.abs(s));
  const floor = peak * 0.1;
  let last = -1;
  for (let i = 0; i < clip.length; i++) if (Math.abs(clip[i] ?? 0) >= floor) last = i;
  return (last + 1) / sampleRate;
}

/**
 * Cheap timbre measurements. Zero-crossing rate stands in for a spectral
 * centroid: no FFT needed, and it separates a bright crack from a low whump
 * exactly as well for this purpose.
 */
function features(
  clip: Float32Array,
  sampleRate: number,
): { seconds: number; zcr: number; rms: number; decaySeconds: number } {
  let crossings = 0;
  let sumSquares = 0;
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < clip.length; i++) {
    const v = clip[i] ?? 0;
    const prev = clip[i - 1] ?? 0;
    if (i > 0 && v >= 0 !== prev >= 0) crossings += 1;
    sumSquares += v * v;
    if (Math.abs(v) > peak) {
      peak = Math.abs(v);
      peakAt = i;
    }
  }
  // Decay: peak until it has fallen 20 dB, which is where a shot stops reading
  // as a shot and starts reading as room.
  const target = peak * 0.1;
  let decayEnd = clip.length - 1;
  for (let i = peakAt; i < clip.length; i++) {
    if (Math.abs(clip[i] ?? 0) <= target) {
      decayEnd = i;
      break;
    }
  }
  return {
    seconds: clip.length / sampleRate,
    zcr: crossings / (clip.length / sampleRate),
    rms: Math.sqrt(sumSquares / Math.max(1, clip.length)),
    decaySeconds: (decayEnd - peakAt) / sampleRate,
  };
}

describe('spatial attenuation', () => {
  it('is full volume and centred on top of the listener', () => {
    const { volume, pan } = SoundBank.spatial(10, 10, 10, 10);
    expect(volume).toBe(1);
    expect(pan).toBe(0);
  });

  it('falls to silence at long range rather than staying faintly audible', () => {
    const near = SoundBank.spatial(0, 0, 5, 0).volume;
    const mid = SoundBank.spatial(0, 0, 25, 0).volume;
    const far = SoundBank.spatial(0, 0, 60, 0).volume;
    expect(near).toBe(1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(far).toBe(0);
  });

  it('pans by horizontal offset only, and clamps hard left/right', () => {
    expect(SoundBank.spatial(0, 0, -100, 0).pan).toBe(-1);
    expect(SoundBank.spatial(0, 0, 100, 0).pan).toBe(1);
    expect(SoundBank.spatial(0, 0, 11, 0).pan).toBeCloseTo(0.5, 1);
    // Vertical separation must not pan: a fight overhead is not "to the right".
    expect(SoundBank.spatial(0, 0, 0, 30).pan).toBe(0);
  });

  it('attenuates by true distance, not by horizontal distance', () => {
    const flat = SoundBank.spatial(0, 0, 30, 0).volume;
    const diagonal = SoundBank.spatial(0, 0, 30, 30).volume;
    expect(diagonal).toBeLessThan(flat);
  });
});
