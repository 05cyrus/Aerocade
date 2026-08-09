import {
  applyDelta,
  decodeSnapshot,
  decodeWelcome,
  encodeInput,
  encodeJoinRequest,
  KEYFRAME,
  MsgId,
  peekMsgId,
  type InputFrame,
  type WireSnapshot,
} from '../protocol/codec.js';
import { PROTOCOL_VERSION } from '../protocol/messages.js';
import type { SimWorld } from '../sim/world.js';
import { applySnapshotToWorld } from './apply-snapshot.js';
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

export interface ClientSessionEvents {
  onWelcome?(playerId: number, hostTick: number): void;
  /** Host and client disagree on tuning or protocol — the match is unplayable. */
  onVersionMismatch?(hostHash: number, localHash: number): void;
  onSnapshot?(snapshot: WireSnapshot): void;
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
    applySnapshotToWorld(this.world, full);
    this.events.onSnapshot?.(full);
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

  /** Latest sequence sent; useful once reconciliation needs a replay window. */
  get lastSentSeq(): number {
    return this.seq;
  }

  /** Re-exported so callers comparing acks use the same wrap-safe rule. */
  static isNewerSeq = isNewerSeq;
}
