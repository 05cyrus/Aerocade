import type { SfxId } from './sfx.js';

/**
 * GENERATED FILE — do not edit by hand.
 * Written by `packages/client/scripts/bake-audio.mjs`; run `npm run audio` in
 * packages/client to regenerate.
 *
 * Generated rather than hand-written so it cannot drift from what is actually on
 * disk: a hand-maintained list is one rename away from a 404 that degrades to the
 * synthesised clip silently, which is exactly the kind of quality regression
 * nobody notices until a player mentions it.
 */
export const SAMPLE_MANIFEST: Partial<Record<SfxId, string>> = {
  'shot-pistol': 'shot-pistol.m4a',
  'shot-smg': 'shot-smg.m4a',
  'shot-rifle': 'shot-rifle.m4a',
  'shot-shotgun': 'shot-shotgun.m4a',
  'shot-sniper': 'shot-sniper.m4a',
  'shot-thumper': 'shot-thumper.m4a',
  'shot-lobber': 'shot-lobber.m4a',
};

/** Total bytes of the baked set, for the bundle-size test. */
export const SAMPLE_BYTES = 31363;
