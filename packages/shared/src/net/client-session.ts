import {
  applyDelta,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeInput,
  encodeJoinRequest,
  KEYFRAME,
  MsgId,
  peekMsgId,
  type InputFrame,
  type RosterEntry,
  type WireSnapshot,
} from '../protocol/codec.js';
import { PROTOCOL_VERSION } from '../protocol/messages.js';
import type { SimWorld } from '../sim/world.js';
import { applySnapshotToWorld } from './apply-snapshot.js';
import { predictPlayer } from '../sim/predict.js';
import { isNewerSeq } from './host-session.js';
import { Channel, type Transport } from './transport.js';

/**
 * Joining-client session: send inputs, receive snapshots, project them into a
 * local `SimWorld` the existing renderer can draw.
 *
 * There is deliberately **no prediction yet**. Snapshots are applied as they
 * arrive, so the local player feels one round trip of lag. That is the honest
 * intermediate state: prediction and reconciliation are a separate, subtle piece
 * of work (§7), and shipping a half-done version of it would produce rubber-
 * banding that is far harder to debug than plain latency.
 */

/** Input frames kept for the redundancy the packet format carries. */
const INPUT_HISTORY = 3;

/**
 * Unacknowledged inputs kept for replay (docs/networking.md §7). 128 ticks is
 * over two seconds of round trip — far more than a LAN needs, and the ring is
 * bounded so a stalled host cannot grow it without limit.
 */
const PENDING_CAPACITY = 128;

/** A prediction is "right" within a centimetre and five centimetres a second. */
const POSITION_TOLERANCE_M = 0.01;
const VELOCITY_TOLERANCE_MS = 0.05;

/**
 * Ticks over which a correction is blended away visually. Six ticks ≈ 100 ms:
 * long enough that a correction is not a snap, short enough that the player is
 * never looking at a stale position for longer than a blink.
 */
const SMOOTHING_TICKS = 6;

/** One input we have sent but the host has not yet confirmed applying. */
interface PendingInput {
  seq: number;
  frame: InputFrame;
  /** `prevButtons` in effect *before* this input, so a replay re-derives edges. */
  prevButtons: number;
  /** Our predicted state *after* this input — what the host's answer is judged against. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface ClientSessionEvents {
  onWelcome?(playerId: number, hostTick: number): void;
  /** Host and client disagree on tuning or protocol — the match is unplayable. */
  onVersionMismatch?(hostHash: number, localHash: number): void;
  onSnapshot?(snapshot: WireSnapshot): void;
  /** The host published who is in the match. */
  onRoster?(entries: readonly RosterEntry[]): void;
}

export class ClientSession {
  /** Assigned by WELCOME; -1 until then. */
  private localPlayer = -1;
  private seq = 0;
  private readonly history: InputFrame[] = [];
  /** Newest fully-reconstructed state, kept as the next delta baseline. */
  private baseline: WireSnapshot | null = null;
  private newestTick = -1;
  private acceptedSnapshots = 0;
  private droppedSnapshots = 0;
  /** Slot → display name, as published by the host. */
  private readonly names = new Map<number, string>();
  /** Inputs sent but not yet acknowledged, oldest first. */
  private pending: PendingInput[] = [];
  private mispredictions = 0;
  /** Visual error left by the last correction, decayed over `SMOOTHING_TICKS`. */
  private smoothX = 0;
  private smoothY = 0;
  private smoothTicksLeft = 0;

  constructor(
    private readonly world: SimWorld,
    private readonly transport: Transport,
    private readonly hostPeerId: string,
    private readonly localTuningHash: number,
    private readonly events: ClientSessionEvents = {},
  ) {}

  get playerId(): number {
    return this.localPlayer;
  }

  get joined(): boolean {
    return this.localPlayer >= 0;
  }

  get stats(): { accepted: number; dropped: number; tick: number } {
    return {
      accepted: this.acceptedSnapshots,
      dropped: this.droppedSnapshots,
      tick: this.newestTick,
    };
  }

  /** Ask to join. Safe to call again: the host treats a repeat as idempotent. */
  requestJoin(name: string): void {
    this.transport.send(
      this.hostPeerId,
      Channel.Ctrl,
      encodeJoinRequest({ protocolVersion: PROTOCOL_VERSION, name }),
    );
  }

  receive(peerId: string, channel: Channel, bytes: Uint8Array): void {
    // Only the host may speak authoritatively; frames from other peers are not
    // part of the star topology and are dropped rather than trusted.
    if (peerId !== this.hostPeerId) return;
    void channel;
    const id = peekMsgId(bytes);
    if (id === MsgId.Welcome) this.handleWelcome(bytes);
    else if (id === MsgId.Snapshot) this.handleSnapshot(bytes);
    else if (id === MsgId.Roster) this.handleRoster(bytes);
  }

  /**
   * Replace the roster wholesale.
   *
   * Replace rather than merge: the host sends the complete roster on every
   * change, so anything absent from this one has left the match — merging would
   * keep naming players who are gone.
   */
  private handleRoster(bytes: Uint8Array): void {
    let entries;
    try {
      entries = decodeRoster(bytes);
    } catch {
      return; // malformed: keep the names we already have
    }
    this.names.clear();
    for (const entry of entries) this.names.set(entry.slot, entry.name);
    this.events.onRoster?.(entries);
  }

  /** Slot → name, or null when the host has not named that slot. */
  nameOf(slot: number): string | null {
    return this.names.get(slot) ?? null;
  }

  private handleWelcome(bytes: Uint8Array): void {
    let welcome;
    try {
      welcome = decodeWelcome(bytes);
    } catch {
      return;
    }
    if (welcome.tuningHash !== this.localTuningHash) {
      // Refusing loudly beats playing a match that silently disagrees about
      // physics — that reads to players as lag or cheating (ADR-026).
      this.events.onVersionMismatch?.(welcome.tuningHash, this.localTuningHash);
      return;
    }
    this.localPlayer = welcome.playerId;
    this.events.onWelcome?.(welcome.playerId, welcome.hostTick);
  }

  private handleSnapshot(bytes: Uint8Array): void {
    let frame: WireSnapshot;
    try {
      frame = decodeSnapshot(bytes);
    } catch {
      this.droppedSnapshots += 1;
      return;
    }

    let full: WireSnapshot;
    if (frame.baselineTick === KEYFRAME) {
      full = frame;
    } else {
      // A delta whose baseline we no longer hold is unusable. Dropping it is
      // correct: the host resends a keyframe when its ack goes stale, so the
      // gap self-heals rather than needing a request.
      if (this.baseline?.tick !== frame.baselineTick) {
        this.droppedSnapshots += 1;
        return;
      }
      full = applyDelta(this.baseline, frame);
    }

    // Out-of-order arrival is normal on an unordered channel; an older frame
    // would visibly rewind everything on screen.
    if (full.tick <= this.newestTick) {
      this.droppedSnapshots += 1;
      return;
    }

    this.baseline = full;
    this.newestTick = full.tick;
    this.acceptedSnapshots += 1;

    // Where we thought we were, before the host's answer lands. Kept so the
    // visual correction can be blended rather than snapped.
    const slot = this.localPlayer;
    const p = this.world.players;
    const wasX = slot >= 0 ? (p.posX[slot] ?? 0) : 0;
    const wasY = slot >= 0 ? (p.posY[slot] ?? 0) : 0;

    applySnapshotToWorld(this.world, full);
    this.reconcile(full, wasX, wasY);
    this.events.onSnapshot?.(full);
  }

  /**
   * Re-derive "now" from the host's authoritative past (docs/networking.md §7).
   *
   * `applySnapshotToWorld` has just overwritten the local player with the host's
   * state as of `lastAckedInputSeq`, which is deliberately *behind* where we had
   * predicted we are. Every input the host has not confirmed yet is then replayed
   * through the same systems the host runs, which puts the local player back at a
   * predicted present.
   *
   * The spec describes accepting a good prediction without replaying. Here the
   * replay is unconditional, because the snapshot has already overwritten the
   * predicted state by the time we can compare — one code path, same result. The
   * tolerance check survives as what it is actually useful for: telling a real
   * misprediction (worth blending away visually, worth counting) from the
   * ordinary case of simply being ahead of the host.
   */
  private reconcile(full: WireSnapshot, wasX: number, wasY: number): void {
    const slot = this.localPlayer;
    if (slot < 0) return;
    const p = this.world.players;

    // Anything the host has confirmed is history. Keep only what is strictly
    // newer, and remember the confirmed one so its prediction can be judged.
    const acked = full.lastAckedInputSeq;
    let judged: PendingInput | null = null;
    const unconfirmed: PendingInput[] = [];
    for (const entry of this.pending) {
      if (entry.seq === acked) judged = entry;
      if (isNewerSeq(entry.seq, acked)) unconfirmed.push(entry);
    }
    this.pending = unconfirmed;

    if (judged !== null) {
      const dx = (p.posX[slot] ?? 0) - judged.x;
      const dy = (p.posY[slot] ?? 0) - judged.y;
      const dvx = (p.velX[slot] ?? 0) - judged.vx;
      const dvy = (p.velY[slot] ?? 0) - judged.vy;
      const missed =
        Math.hypot(dx, dy) > POSITION_TOLERANCE_M || Math.hypot(dvx, dvy) > VELOCITY_TOLERANCE_MS;
      if (missed) this.mispredictions += 1;
    }

    // Silent for the replay only: these ticks already announced themselves when
    // they were first predicted, and re-emitting would fire the same gunshot
    // again on every snapshot — an audible correction, worse than the
    // misprediction it fixes. A freshly predicted tick is *not* suppressed.
    const wasSuppressed = this.world.events.setSuppressed(true);
    try {
      for (const entry of this.pending) {
        p.prevButtons[slot] = entry.prevButtons;
        predictPlayer(this.world, slot, { seq: entry.seq, ...entry.frame });
        // Refresh the recorded prediction: the next snapshot judges against this
        // replay, not against the guess made before the correction.
        entry.x = p.posX[slot] ?? 0;
        entry.y = p.posY[slot] ?? 0;
        entry.vx = p.velX[slot] ?? 0;
        entry.vy = p.velY[slot] ?? 0;
      }
    } finally {
      this.world.events.setSuppressed(wasSuppressed);
    }
    // The predicted present is the authoritative tick plus everything replayed.
    this.world.tick = full.tick + this.pending.length;

    // Blend, do not snap: a corrected camera that jumps reads as a worse bug than
    // the latency it is fixing. Only a real correction is smoothed — being ahead
    // of the host is not an error.
    const errX = wasX - (p.posX[slot] ?? 0);
    const errY = wasY - (p.posY[slot] ?? 0);
    if (Math.hypot(errX, errY) > POSITION_TOLERANCE_M) {
      this.smoothX = errX;
      this.smoothY = errY;
      this.smoothTicksLeft = SMOOTHING_TICKS;
    }
  }

  /**
   * Render-only offset to add to the local player's drawn position, so a
   * correction arrives as a slide rather than a jump. Decays to zero.
   */
  get renderOffset(): { x: number; y: number } {
    if (this.smoothTicksLeft <= 0) return { x: 0, y: 0 };
    const fraction = this.smoothTicksLeft / SMOOTHING_TICKS;
    return { x: this.smoothX * fraction, y: this.smoothY * fraction };
  }

  /** Predictions the host disagreed with. Zero on a quiet LAN; rises with contact. */
  get mispredictionCount(): number {
    return this.mispredictions;
  }

  /** Unacknowledged inputs — effectively the round trip measured in ticks. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Send this tick's input. Carries the two previous frames as redundancy, so a
   * single lost datagram costs nothing (§5.1), and acks the newest snapshot tick
   * so the host can delta against something we actually hold.
   */
  sendInput(frame: InputFrame): boolean {
    this.seq = (this.seq + 1) & 0xffff;
    this.history.unshift(frame);
    if (this.history.length > INPUT_HISTORY) this.history.length = INPUT_HISTORY;
    // Predict in the same call that sends, so the two can never disagree about
    // which inputs are outstanding — a pending queue that does not match what
    // was actually sent replays the wrong thing.
    this.predictLocally(frame);
    return this.transport.send(
      this.hostPeerId,
      Channel.Data,
      encodeInput({
        seq: this.seq,
        clientTick: this.world.tick,
        ackTick: this.newestTick < 0 ? 0 : this.newestTick,
        frames: [...this.history],
      }),
    );
  }

  /**
   * Apply this input to our own player immediately, and remember it for replay.
   *
   * This is what removes the round trip from the local player's own movement: the
   * host is still the authority, but the client no longer waits for permission to
   * take a step.
   */
  private predictLocally(frame: InputFrame): void {
    const slot = this.localPlayer;
    if (slot < 0 || this.world.players.connected[slot] !== 1) return;
    const p = this.world.players;
    const prevButtons = p.prevButtons[slot] ?? 0;

    predictPlayer(this.world, slot, { seq: this.seq, ...frame });
    this.world.tick += 1;

    this.pending.push({
      seq: this.seq,
      frame: { ...frame },
      prevButtons,
      x: p.posX[slot] ?? 0,
      y: p.posY[slot] ?? 0,
      vx: p.velX[slot] ?? 0,
      vy: p.velY[slot] ?? 0,
    });
    // Bounded: a host that stops acking must not grow this without limit.
    if (this.pending.length > PENDING_CAPACITY) this.pending.shift();
    if (this.smoothTicksLeft > 0) this.smoothTicksLeft -= 1;
  }

  /** Latest sequence sent; useful once reconciliation needs a replay window. */
  get lastSentSeq(): number {
    return this.seq;
  }

  /** Re-exported so callers comparing acks use the same wrap-safe rule. */
  static isNewerSeq = isNewerSeq;
}
