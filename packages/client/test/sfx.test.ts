import { describe, expect, it } from 'vitest';
import { LOOPING, renderSfx, SfxId } from '../src/game/audio/sfx.js';
import { SoundBank } from '../src/game/audio/SoundBank.js';

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

  it('gives each weapon class a distinguishable report', () => {
    const clips = renderSfx(48000);
    const shots = [
      SfxId.ShotLight,
      SfxId.ShotRifle,
      SfxId.ShotShotgun,
      SfxId.ShotSniper,
      SfxId.ShotLauncher,
    ];
    const lengths = shots.map((id) => clips[id].length);
    expect(new Set(lengths).size, 'every shot clip is a different length').toBe(shots.length);
  });

  it('marks only the jetpack as looping', () => {
    expect([...LOOPING]).toEqual([SfxId.JetLoop]);
  });
});

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
