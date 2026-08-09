import type { SfxId } from './sfx.js';
import { SAMPLE_MANIFEST } from './sample-manifest.js';

/**
 * Recorded samples, layered over the procedural synthesis rather than replacing
 * it (ADR-030).
 *
 * The synth stays the floor: `SoundBank` fills every buffer from `renderSfx` in
 * its constructor, so a match is fully audible before a single byte is fetched,
 * and a sample that 404s, fails to decode, or is simply absent leaves a working
 * sound in place. That is what makes shipping audio files safe here — nothing in
 * the game becomes silent if the files go missing, which is the failure mode a
 * PWA on a flaky first load actually has.
 *
 * Load order is therefore never a correctness question, only a quality one.
 */

/** Where the baked clips live, relative to the app's base URL. */
export const SAMPLE_DIR = 'sfx/';

export interface SampleLoadReport {
  /** Ids whose buffer was replaced by a decoded sample. */
  loaded: SfxId[];
  /** Ids that stayed on the synthesised clip, with the reason. */
  fellBack: { id: SfxId; reason: string }[];
}

/** Injected so tests can drive the loader without a network or a real decoder. */
export interface SampleDeps {
  fetch: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
  /** Prepended to every sample path; the app's base URL in the browser. */
  baseUrl?: string;
}

/**
 * Fetch and decode every sample in the manifest, handing each decoded buffer to
 * `accept`.
 *
 * Resolves only once every entry has settled, and **never rejects**: each id
 * fails independently, because one bad file must not cost the whole set. The
 * report is returned rather than logged so callers (and tests) can assert on it.
 */
export async function loadSamples(
  deps: SampleDeps,
  accept: (id: SfxId, buffer: AudioBuffer) => void,
  manifest: Partial<Record<SfxId, string>> = SAMPLE_MANIFEST,
): Promise<SampleLoadReport> {
  const report: SampleLoadReport = { loaded: [], fellBack: [] };
  const base = deps.baseUrl ?? '';

  const entries = Object.entries(manifest) as [SfxId, string][];
  await Promise.all(
    entries.map(async ([id, file]) => {
      try {
        const response = await deps.fetch(`${base}${SAMPLE_DIR}${file}`);
        if (!response.ok) {
          report.fellBack.push({ id, reason: `http ${String(response.status)}` });
          return;
        }
        const buffer = await deps.decode(await response.arrayBuffer());
        if (buffer.length === 0) {
          report.fellBack.push({ id, reason: 'decoded to an empty buffer' });
          return;
        }
        accept(id, buffer);
        report.loaded.push(id);
      } catch (error) {
        // Includes the case that matters most: a browser that cannot decode this
        // codec at all. It keeps the synth and plays on.
        report.fellBack.push({
          id,
          reason: error instanceof Error ? error.message : 'decode failed',
        });
      }
    }),
  );
  return report;
}
