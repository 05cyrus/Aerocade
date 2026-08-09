import { describe, expect, it, vi } from 'vitest';
import { SfxId } from '../src/game/audio/sfx.js';
import { loadSamples, SAMPLE_DIR, type SampleDeps } from '../src/game/audio/samples.js';
import { SAMPLE_BYTES, SAMPLE_MANIFEST } from '../src/game/audio/sample-manifest.js';

/**
 * The recorded samples are only safe to ship because the synthesised clip stays
 * underneath every one of them. These tests are about that guarantee, not about
 * how the samples sound: a 404, an undecodable codec, a truncated download and a
 * browser with no AAC support must all end in a game that still makes noise.
 *
 * That is the difference between adding audio files and depending on them.
 */

/** A decoded buffer, minus a real AudioContext. */
function fakeBuffer(length = 1024): AudioBuffer {
  return { length, numberOfChannels: 1, sampleRate: 44100 } as unknown as AudioBuffer;
}

function deps(over: Partial<SampleDeps> = {}): SampleDeps {
  return {
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      }),
    decode: () => Promise.resolve(fakeBuffer()),
    ...over,
  };
}

describe('sample loading falls back rather than failing', () => {
  it('accepts a decoded sample', async () => {
    const accepted: SfxId[] = [];
    const report = await loadSamples(deps(), (id) => accepted.push(id), {
      [SfxId.ShotPistol]: 'shot-pistol.m4a',
    });
    expect(report.loaded).toEqual([SfxId.ShotPistol]);
    expect(report.fellBack).toEqual([]);
    expect(accepted).toEqual([SfxId.ShotPistol]);
  });

  it('keeps the synth clip when the file is missing', async () => {
    const accept = vi.fn();
    const report = await loadSamples(
      deps({
        fetch: () =>
          Promise.resolve({
            ok: false,
            status: 404,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          }),
      }),
      accept,
      { [SfxId.ShotSmg]: 'shot-smg.m4a' },
    );
    expect(report.loaded).toEqual([]);
    expect(report.fellBack).toEqual([{ id: SfxId.ShotSmg, reason: 'http 404' }]);
    // The important half: nothing was handed over, so the synthesised buffer stands.
    expect(accept).not.toHaveBeenCalled();
  });

  it('keeps the synth clip when the browser cannot decode the codec', async () => {
    // The realistic version of this is a browser without AAC. It must cost that
    // one sound's fidelity, never the sound itself.
    const accept = vi.fn();
    const report = await loadSamples(
      deps({ decode: () => Promise.reject(new Error('Unable to decode audio data')) }),
      accept,
      { [SfxId.ShotSniper]: 'shot-sniper.m4a' },
    );
    expect(report.fellBack).toEqual([
      { id: SfxId.ShotSniper, reason: 'Unable to decode audio data' },
    ]);
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a buffer that decoded to nothing', async () => {
    // A truncated download can decode "successfully" to zero frames, which would
    // silently replace a working clip with silence — worse than not loading.
    const accept = vi.fn();
    const report = await loadSamples(
      deps({ decode: () => Promise.resolve(fakeBuffer(0)) }),
      accept,
      {
        [SfxId.Explosion]: 'explosion.m4a',
      },
    );
    expect(report.fellBack).toEqual([
      { id: SfxId.Explosion, reason: 'decoded to an empty buffer' },
    ]);
    expect(accept).not.toHaveBeenCalled();
  });

  it('fails each id independently', async () => {
    // One bad file must not cost the whole set, which is why this is not a
    // Promise.all over throwing loads.
    const accepted: SfxId[] = [];
    const report = await loadSamples(
      deps({
        fetch: (url) =>
          Promise.resolve({
            ok: !url.includes('shot-smg'),
            status: url.includes('shot-smg') ? 500 : 200,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
          }),
      }),
      (id) => accepted.push(id),
      { [SfxId.ShotPistol]: 'shot-pistol.m4a', [SfxId.ShotSmg]: 'shot-smg.m4a' },
    );
    expect(report.loaded).toEqual([SfxId.ShotPistol]);
    expect(report.fellBack).toEqual([{ id: SfxId.ShotSmg, reason: 'http 500' }]);
    expect(accepted).toEqual([SfxId.ShotPistol]);
  });

  it('never rejects, whatever fetch does', async () => {
    // Called during startup; a rejection here would surface as an unhandled
    // promise and could take the boot path with it.
    const report = await loadSamples(
      deps({ fetch: () => Promise.reject(new Error('network down')) }),
      () => undefined,
      { [SfxId.Reload]: 'reload.m4a' },
    );
    expect(report.loaded).toEqual([]);
    expect(report.fellBack).toHaveLength(1);
  });

  it('requests each sample under the base url', async () => {
    const urls: string[] = [];
    await loadSamples(
      deps({
        baseUrl: '/aerocade/',
        fetch: (url) => {
          urls.push(url);
          return Promise.resolve({
            ok: true,
            status: 200,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
          });
        },
      }),
      () => undefined,
      { [SfxId.ShotPistol]: 'shot-pistol.m4a' },
    );
    expect(urls).toEqual([`/aerocade/${SAMPLE_DIR}shot-pistol.m4a`]);
  });

  it('does nothing at all with an empty manifest', async () => {
    const accept = vi.fn();
    const report = await loadSamples(deps(), accept, {});
    expect(report).toEqual({ loaded: [], fellBack: [] });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('the generated manifest', () => {
  it('names only known sound ids', () => {
    // The manifest is generated, so a stale entry means the bake and the code
    // disagree about what exists — a 404 that hides behind the fallback.
    const ids = new Set<string>(Object.values(SfxId));
    for (const id of Object.keys(SAMPLE_MANIFEST)) expect(ids, id).toContain(id);
  });

  it('uses one distinct file per id', () => {
    const files = Object.values(SAMPLE_MANIFEST);
    expect(new Set(files).size).toBe(files.length);
  });

  it('stays inside a sane precache budget', () => {
    // These files are precached by the service worker, so they are part of what a
    // player downloads before the first match. A blown budget here is a slower
    // install for everyone, which is exactly the cost ADR-001 was avoiding.
    expect(SAMPLE_BYTES).toBeLessThan(1_500_000);
  });
});
