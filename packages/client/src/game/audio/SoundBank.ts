import { LOOPING, renderSfx, SfxId } from './sfx.js';
import { loadSamples, type SampleDeps, type SampleLoadReport } from './samples.js';

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

/**
 * Global headroom at 100% volume. Several guns firing at once must not clip the
 * master, so the ceiling stays well under 1 even at full setting.
 */
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

/**
 * The app's base URL, so a PWA served from a subpath still finds its samples.
 * Read through a guard because this module is unit tested outside a bundler.
 */
function baseUrl(): string {
  try {
    return import.meta.env.BASE_URL;
  } catch {
    return '/';
  }
}

export class SoundBank {
  private readonly context: AudioContextLike;
  private readonly master: GainNode;
  private readonly buffers = new Map<SfxId, AudioBuffer>();

  private jetSource: AudioBufferSourceNode | null = null;
  private jetGain: GainNode | null = null;
  private muted = false;
  /** 0–1 from the settings screen; multiplies the headroom ceiling. */
  private volume = 1;

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
    this.applyMasterGain();
  }

  /** Set output level, 0–1. Muting still wins regardless of volume. */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN * this.volume;
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
   * Replace synthesised buffers with the recorded samples, where they exist.
   *
   * Deliberately not on the caller's critical path: the synth is already loaded,
   * so this upgrades a working game rather than gating it. Every id fails
   * independently and keeps its synthesised clip, so the worst outcome of a
   * missing or undecodable file is a game that sounds like it did before.
   */
  async loadSamples(deps?: Partial<SampleDeps>): Promise<SampleLoadReport> {
    const resolved: SampleDeps = {
      fetch: deps?.fetch ?? ((url) => fetch(url)),
      // The promise overload, not the callback one: it is the form that reliably
      // rejects on an undecodable codec instead of resolving with nothing.
      decode: deps?.decode ?? ((bytes) => this.context.decodeAudioData(bytes)),
      baseUrl: deps?.baseUrl ?? baseUrl(),
    };
    return loadSamples(resolved, (id, buffer) => {
      this.buffers.set(id, SoundBank.toMono(buffer, this.context));
      // The jet loop is the only buffer that can already be playing. Swapping the
      // map alone would leave the synthesised loop running for the rest of the
      // match, so its voice is rebuilt at the level it currently sits at.
      if (id === SfxId.JetLoop && this.jetSource !== null) this.restartJet();
    });
  }

  /**
   * Collapse a decoded sample to one channel.
   *
   * Everything downstream assumes mono: `spatial()` derives pan from world
   * geometry, so a stereo sample would fight the panner and put one shot in two
   * places at once. The bake writes mono; this is the guard for when it does not.
   */
  private static toMono(buffer: AudioBuffer, context: AudioContextLike): AudioBuffer {
    if (buffer.numberOfChannels === 1) return buffer;
    const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
    const out = mono.getChannelData(0);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < channel.length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
    }
    const scale = 1 / buffer.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * scale;
    return mono;
  }

  /** Rebuild the jet voice on the current buffer, preserving its level. */
  private restartJet(): void {
    const level = this.jetGain?.gain.value ?? 0;
    this.jetSource?.stop();
    this.jetSource?.disconnect();
    this.jetGain?.disconnect();
    this.jetSource = null;
    this.jetGain = null;
    if (level > 0) this.setJet(level / JET_GAIN);
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
