#!/usr/bin/env node
/**
 * Bake the shipped weapon/event samples from the licensed source pack.
 *
 * Run: `npm run audio` (from packages/client), with the pack present at
 * `assets/Free Sounds Pack/`. Outputs go to `public/sfx/*.m4a` and are
 * **committed**, so a normal build — and a normal clone — never needs the 65 MB
 * pack or ffmpeg. This script only has to run when the sound design changes.
 *
 * Why a script and not runtime processing: every transform here (trim, pitch,
 * filter, normalise) is deterministic and identical on every boot, so doing it
 * once at authoring time costs nothing at run time and makes the result
 * reviewable — you can listen to exactly what ships.
 *
 * Each recipe is a plain ffmpeg filter chain. Two rules are load-bearing:
 *  - the transient must land within ~10 ms of sample 0, or the gun feels late;
 *  - the loud part must fit inside the weapon's `cycleTime`, or full-auto fire
 *    overlaps itself into mush.
 * Both are checked after every bake and the script fails on a violation rather
 * than shipping a clip that only sounds wrong in the game.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the repo path contains a space, which
// pathname percent-encodes into a path that does not exist.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, '..');
const REPO = resolve(CLIENT, '../..');
const PACK = join(REPO, 'assets', 'Free Sounds Pack');
const OUT_DIR = join(CLIENT, 'public', 'sfx');
const MANIFEST = join(CLIENT, 'src', 'game', 'audio', 'sample-manifest.ts');

/** Final encode: mono AAC in m4a — the widest `decodeAudioData` support there is. */
const ENCODE = [
  '-ac',
  '1',
  '-ar',
  '44100',
  '-c:a',
  'aac',
  '-b:a',
  '64k',
  '-movflags',
  '+faststart',
];

/**
 * Per-clip recipes. `filter` is an ffmpeg `-af` chain applied to `source`.
 *
 * `maxSeconds` is the hard budget: for a weapon it is that weapon's `cycleTime`
 * from weapon-defs.ts, repeated here because this script cannot import TypeScript.
 * Keep the two in step — the test suite asserts the synth side, this asserts the
 * baked side.
 */
const RECIPES = [
  {
    id: 'shot-pistol',
    source: 'Gunshot 1-1.wav',
    maxSeconds: 0.28, // Rivet Pistol cycleTime
    filter:
      'pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0415:end=0.300,asetrate=44100*1.1892,' +
      'aresample=44100,highpass=f=110,afade=t=out:start_sample=6615:nb_samples=2200,volume=6.614dB',
  },
  {
    id: 'shot-smg',
    source: 'Gunshot 7-1.wav',
    maxSeconds: 0.09, // Vortex SMG — the tightest budget in the roster
    filter:
      'pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0505:end=0.146002,asetrate=44100*1.1225,' +
      'aresample=44100,highpass=f=180,highpass=f=220,highpass=f=220,' +
      'treble=f=4000:g=1.1:width_type=q:width=0.7,volume=3.50dB,' +
      'afade=t=out:start_sample=2957:nb_samples=795',
  },
  {
    id: 'shot-rifle',
    source: 'Sci-Fi Gun 1-1.wav',
    maxSeconds: 0.14, // Pulse Rifle
    filter:
      'pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0255:end=0.260,asetrate=44100*2.0,' +
      'aresample=44100,highpass=f=260,equalizer=f=700:width_type=o:width=1.0:g=4,' +
      'treble=f=1500:width_type=o:width=1.0:g=-1.5,volume=5.0dB,' +
      'afade=t=out:start_sample=1985:nb_samples=1985',
  },
  {
    id: 'shot-shotgun',
    source: 'Gunshot 1-1.wav',
    layer: 'Gunshot 7-1.wav', // bright pellet fizz over the low blast
    maxSeconds: 0.85, // Scattergun
    filter:
      '[0:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0424:end=0.360,asetpts=N/SR/TB,' +
      'asetrate=44100*0.7492,aresample=44100,asetpts=N/SR/TB,highpass=f=38,' +
      'equalizer=f=95:width_type=o:width=1.2:g=5,' +
      'equalizer=f=560:width_type=o:width=1.4:g=-5.2,' +
      'afade=t=out:start_sample=14700:nb_samples=3300[main];' +
      '[1:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0450:end=0.190,asetpts=N/SR/TB,' +
      'highpass=f=1500,volume=-1dB,adelay=delays=2:all=1[lay];' +
      '[main][lay]amix=inputs=2:duration=longest:normalize=0,' +
      'highshelf=f=2000:g=1.1,highshelf=f=6500:g=1.2,volume=5.415dB,' +
      'alimiter=level=false:limit=0.87565:attack=0.1:release=30[out]',
  },
  {
    id: 'shot-sniper',
    source: 'Gunshot 7-1.wav',
    layer: 'Gunshot 1-1.wav', // mechanical clack, then the big crack under it
    maxSeconds: 1.5, // Longbolt Rifle — the long tail the automatics cannot afford
    filter:
      '[0:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0225:end=0.420,asetpts=N/SR/TB,' +
      'afade=t=in:start_sample=0:nb_samples=44[main];' +
      '[1:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0424:end=0.658,asetpts=N/SR/TB,' +
      'asetrate=44100*0.5,aresample=44100,lowpass=f=2000,volume=-1dB,' +
      'adelay=delays=24:all=1[lay];' +
      '[main][lay]amix=inputs=2:duration=longest:normalize=0,' +
      'lowpass=f=5800:poles=1,equalizer=f=480:t=q:w=1.2:g=0.6,' +
      'equalizer=f=2000:t=q:w=1.2:g=-0.5,volume=1.37dB,' +
      'afade=t=out:start_sample=48510:nb_samples=6615[out]',
  },
  {
    id: 'shot-thumper',
    source: 'Gunshot 7-1.wav',
    layer: 'Explosion Medium 2-1.wav', // a rocket motor's low shove under the launch
    maxSeconds: 1.1, // Thumper
    filter:
      '[0:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start_sample=2358:end_sample=18022,asetpts=N,' +
      'asetrate=44100*0.3969,aresample=44100,asetpts=N,highpass=f=32,' +
      'afade=t=in:start_sample=0:nb_samples=20,' +
      'afade=t=out:start_sample=34173:nb_samples=5292[m];' +
      '[1:a]pan=mono|c0=0.5*c0+0.5*c1,atrim=start_sample=2157:end_sample=33556,asetpts=N,' +
      'lowpass=f=350,volume=-1dB,afade=t=in:start_sample=0:nb_samples=88,' +
      'afade=t=out:start_sample=29194:nb_samples=2205[l];' +
      '[m][l]amix=inputs=2:duration=longest:normalize=0,' +
      'bass=g=-1.3:f=120:width_type=q:width=0.7,' +
      'equalizer=f=450:width_type=q:width=1.0:g=0.8,' +
      'treble=g=0.8:f=4000:width_type=q:width=0.7,volume=3.161dB,asetpts=N[out]',
  },
  {
    id: 'shot-lobber',
    source: 'Gunshot 1-1.wav',
    maxSeconds: 0.75, // Lobber — same family as the Thumper, hollow and higher
    // Pitched to 0.63, not the 0.5 the design called for. At 0.5 the source's
    // attack is stretched enough that the clip takes 13 ms to cross -40 dBFS,
    // which would make the Lobber feel *later* than the synthesised clip it
    // replaces (that one starts at full amplitude, 0 ms). 0.63 lands at 8.4 ms
    // and keeps 21.9 dB of body-over-air tilt against 23.0 — still the darkest
    // clip in the roster, and still 2.4x shorter than the Thumper.
    filter:
      'pan=mono|c0=0.5*c0+0.5*c1,atrim=start=0.0424:end=0.230,asetrate=44100*0.63,' +
      'aresample=44100,highpass=f=45,lowpass=f=2100,' +
      'bass=g=0.5:f=190:width_type=q:width=0.7,volume=6.040dB,' +
      'afade=t=out:start_sample=8750:nb_samples=3500',
  },
];

// ---------------------------------------------------------------------------

function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-y', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ffprobeJson(file) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=channels,sample_rate,codec_name:format=duration,size',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

/**
 * ffmpeg's analysis filters write to **stderr**, not stdout. `execFileSync`
 * returns stdout, so parsing its result finds an empty string and every check
 * silently passes — which is how these two guards were wrong the first time.
 */
function ffmpegLog(args) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-v', 'info', ...args, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return `${run.stderr ?? ''}${run.stdout ?? ''}`;
}

/** Milliseconds of silence at the very start of the clip; 0 if it opens on signal. */
function leadingSilenceMs(file) {
  const log = ffmpegLog(['-i', file, '-af', 'silencedetect=noise=-40dB:d=0.005']);
  // Only a silence that *starts* at 0 is leading silence; later ones are the gaps
  // and tail inside the clip, which are none of this check's business.
  const first = /silence_start: (-?[\d.]+)[\s\S]*?silence_end: ([\d.]+)/.exec(log);
  if (first === null || Number(first[1]) > 0.001) return 0;
  return Number(first[2]) * 1000;
}

/**
 * Seconds the clip spends above -25 dBFS — the part a player hears as the event,
 * which is what has to fit inside the weapon's fire interval. The quiet tail is
 * free to overlap the next shot.
 */
function loudSeconds(file) {
  const log = ffmpegLog([
    '-i',
    file,
    '-af',
    'silenceremove=stop_periods=-1:stop_threshold=-25dB:stop_duration=0.01,astats=measure_perchannel=none',
  ]);
  const samples = /Number of samples: (\d+)/.exec(log);
  return samples === null ? Number.NaN : Number(samples[1]) / 44100;
}

function main() {
  if (RECIPES.length === 0) {
    console.error('No recipes defined; nothing to bake.');
    process.exit(1);
  }
  if (!existsSync(PACK)) {
    console.error(`Source pack not found: ${PACK}`);
    console.error('The baked clips in public/sfx are committed, so a build does not need it.');
    console.error('Only re-run this script with the pack in place.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  // Clear stale outputs so a removed recipe cannot leave an orphan file that the
  // service worker keeps precaching forever.
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.m4a')) rmSync(join(OUT_DIR, f));

  const failures = [];
  const rows = [];
  let total = 0;

  for (const recipe of RECIPES) {
    const source = join(PACK, recipe.source);
    if (!existsSync(source)) {
      failures.push(`${recipe.id}: missing source "${recipe.source}"`);
      continue;
    }
    const out = join(OUT_DIR, `${recipe.id}.m4a`);
    const inputs = [['-i', source]];
    if (recipe.layer !== undefined) inputs.push(['-i', join(PACK, recipe.layer)]);
    // A layered recipe is a filter graph with a labelled output, which needs an
    // explicit -map; a single-source one is a plain -af chain.
    const graph =
      recipe.layer === undefined
        ? ['-af', recipe.filter]
        : ['-filter_complex', recipe.filter, '-map', '[out]'];
    ffmpeg([...inputs.flat(), ...graph, ...ENCODE, out]);

    const probe = ffprobeJson(out);
    const stream = probe.streams?.[0] ?? {};
    const bytes = statSync(out).size;
    const duration = Number(probe.format?.duration ?? 0);
    const silence = leadingSilenceMs(out);
    const loud = loudSeconds(out);
    total += bytes;

    if (stream.channels !== 1)
      failures.push(`${recipe.id}: ${stream.channels} channels, expected mono`);
    if (silence > 10)
      failures.push(`${recipe.id}: ${silence.toFixed(1)}ms of leading silence (max 10)`);
    if (Number.isNaN(loud)) failures.push(`${recipe.id}: could not measure duration`);
    if (recipe.maxSeconds !== undefined && loud > recipe.maxSeconds) {
      failures.push(
        `${recipe.id}: ${(loud * 1000).toFixed(0)}ms of loud audio exceeds its ${(recipe.maxSeconds * 1000).toFixed(0)}ms budget`,
      );
    }
    rows.push({ id: recipe.id, duration, loud, silence, bytes, source: recipe.source });
  }

  console.log(
    `\n${'id'.padEnd(16)}${'dur'.padStart(7)}${'loud'.padStart(7)}${'lead'.padStart(7)}${'KB'.padStart(7)}  source`,
  );
  for (const r of rows) {
    console.log(
      r.id.padEnd(16) +
        `${r.duration.toFixed(2)}s`.padStart(7) +
        `${(r.loud * 1000).toFixed(0)}ms`.padStart(7) +
        `${r.silence.toFixed(0)}ms`.padStart(7) +
        `${(r.bytes / 1024).toFixed(1)}`.padStart(7) +
        `  ${r.source}`,
    );
  }
  console.log(`\n${rows.length} clips, ${(total / 1024).toFixed(1)} KB total\n`);

  if (failures.length > 0) {
    console.error('FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  const lines = rows.map((r) => `  '${r.id}': '${r.id}.m4a',`).join('\n');
  writeFileSync(
    MANIFEST,
    `import type { SfxId } from './sfx.js';

/**
 * GENERATED FILE — do not edit by hand.
 * Written by \`packages/client/scripts/bake-audio.mjs\`; run \`npm run audio\` in
 * packages/client to regenerate.
 *
 * Generated rather than hand-written so it cannot drift from what is actually on
 * disk: a hand-maintained list is one rename away from a 404 that degrades to the
 * synthesised clip silently, which is exactly the kind of quality regression
 * nobody notices until a player mentions it.
 */
export const SAMPLE_MANIFEST: Partial<Record<SfxId, string>> = {
${lines}
};

/** Total bytes of the baked set, for the bundle-size test. */
export const SAMPLE_BYTES = ${total};
`,
  );
  console.log(`wrote ${MANIFEST}`);
}

main();
