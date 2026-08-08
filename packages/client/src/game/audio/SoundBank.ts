import { LOOPING, renderSfx, SfxId } from './sfx.js';

/**
 * Web Audio playback for the procedurally generated clips in `sfx.ts`.
 *
 * Owns its own `AudioContext` rather than borrowing Phaser's sound manager.
 * Phaser's manager exists to load and decode asset files and to mix them; we
 * generate every buffer ourselves and need none of that, so going through it
 * would add a layer and a second `AudioContext` for no benefit. Phaser stays
 * configured with `noAudio: true`.
 *
 * Everything routes through one master gain, so mute and volume are a single
 * node rather than state smeared across call sites.
 *
 * Autoplay: browsers start a context suspended until a user gesture, so
 * `resume()` must be called from a real click or keypress. Entering the sandbox
 * is a click, which is where the game calls it.
 */

/** How the world sounds: full volume close by, silent past this range. */
const FALLOFF_NEAR_M = 7;
const FALLOFF_FAR_M = 42;
/** Metres of separation that map to a fully hard-panned sound. */
const PAN_WIDTH_M = 22;

/** Global headroom. Several guns firing at once must not clip the master. */
const MASTER_GAIN = 0.55;

/** Jetpack gain ramp, seconds — short enough to feel keyed to the thruster. */
const JET_RAMP_S = 0.08;
const JET_GAIN = 0.5;

export interface PlayOptions {
  /** 0–1 before falloff; defaults to 1. */
  volume?: number;
  /** -1 left … 1 right. */
  pan?: number;
  /** Playback rate; use small random-ish variation to avoid machine-gun sameness. */
  rate?: number;
}

/** The subset of AudioContext this class needs, so tests can supply a stub. */
export type AudioContextLike = AudioContext;

export class SoundBank {
  private readonly context: AudioContextLike;
  private readonly master: GainNode;
  private readonly buffers = new Map<SfxId, AudioBuffer>();

  private jetSource: AudioBufferSourceNode | null = null;
  private jetGain: GainNode | null = null;
  private muted = false;

  constructor(context: AudioContextLike) {
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(context.destination);

    // Render once at the context's real sample rate, so nothing is resampled.
    const clips = renderSfx(context.sampleRate);
    for (const id of Object.values(SfxId)) {
      const data = clips[id];
      const buffer = context.createBuffer(1, data.length, context.sampleRate);
      // `set` on the channel view rather than `copyToChannel`: the latter's
      // signature pins the ArrayBuffer flavour and rejects a sliced array.
      buffer.getChannelData(0).set(data);
      this.buffers.set(id, buffer);
    }
  }

  /**
   * Build a bank if this browser can. Returns null instead of throwing when
   * Web Audio is unavailable or blocked, so a missing audio device degrades to
   * a silent game rather than a broken one.
   */
  static tryCreate(): SoundBank | null {
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined' ? AudioContext : undefined;
      if (Ctor === undefined) return null;
      return new SoundBank(new Ctor());
    } catch {
      return null;
    }
  }

  /** Must be called from a user gesture or the context stays suspended. */
  resume(): void {
    if (this.context.state === 'suspended') void this.context.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.master.gain.value = muted ? 0 : MASTER_GAIN;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Fire a one-shot. Silently ignores unknown ids and a suspended context. */
  play(id: SfxId, options?: PlayOptions): void {
    if (this.muted) return;
    const buffer = this.buffers.get(id);
    if (buffer === undefined || this.context.state !== 'running') return;

    const volume = options?.volume ?? 1;
    if (volume <= 0.001) return; // too far away to be worth a node

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options?.rate ?? 1;

    const gain = this.context.createGain();
    gain.gain.value = volume;

    const pan = options?.pan ?? 0;
    if (pan !== 0) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      source.connect(gain).connect(panner).connect(this.master);
    } else {
      source.connect(gain).connect(this.master);
    }
    source.start();
    // Nodes are garbage once they finish; releasing the graph keeps them from
    // piling up over a long match.
    source.onended = (): void => {
      source.disconnect();
      gain.disconnect();
    };
  }

  /**
   * Jetpack thrust, 0 (off) to 1 (full). The looping source is created once and
   * left running; only its gain moves, because restarting a buffer every frame
   * would click and allocate.
   */
  setJet(intensity: number): void {
    if (this.context.state !== 'running') return;
    const target = Math.max(0, Math.min(1, intensity)) * JET_GAIN;

    if (this.jetSource === null) {
      if (target <= 0) return; // don't spin up the loop until it is first needed
      const buffer = this.buffers.get(SfxId.JetLoop);
      if (buffer === undefined) return;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = LOOPING.includes(SfxId.JetLoop);
      const gain = this.context.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.master);
      source.start();
      this.jetSource = source;
      this.jetGain = gain;
    }
    const gain = this.jetGain;
    if (gain === null) return;
    // Ramp rather than assign: a stepped gain on a loud noise loop zips.
    gain.gain.setTargetAtTime(target, this.context.currentTime, JET_RAMP_S);
  }

  /**
   * Attenuation and stereo placement for a world-space sound, relative to the
   * listener (the local player). Exposed so callers do the geometry once and
   * pass the result to `play`.
   */
  static spatial(
    listenerX: number,
    listenerY: number,
    sourceX: number,
    sourceY: number,
  ): { volume: number; pan: number } {
    const dx = sourceX - listenerX;
    const distance = Math.hypot(dx, sourceY - listenerY);
    const t = (distance - FALLOFF_NEAR_M) / (FALLOFF_FAR_M - FALLOFF_NEAR_M);
    // Linear in the near field would drop off too fast to feel like space;
    // squaring the remaining fraction keeps distant fights faintly audible.
    const volume = distance <= FALLOFF_NEAR_M ? 1 : Math.max(0, 1 - t) ** 2;
    return { volume, pan: Math.max(-1, Math.min(1, dx / PAN_WIDTH_M)) };
  }

  destroy(): void {
    this.jetSource?.stop();
    this.jetSource?.disconnect();
    this.jetGain?.disconnect();
    this.jetSource = null;
    this.jetGain = null;
    this.master.disconnect();
    void this.context.close();
  }
}
