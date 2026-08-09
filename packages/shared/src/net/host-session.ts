import { MAX_PLAYERS } from '../constants.js';
import {
  captureSnapshot,
  decodeInput,
  encodeSnapshot,
  encodeRoster,
  encodeWelcome,
  decodeJoinRequest,
  MsgId,
  type RosterEntry,
  peekMsgId,
  type WireSnapshot,
} from '../protocol/codec.js';
import { PROTOCOL_VERSION } from '../protocol/messages.js';
import { addPlayer, removePlayer } from '../sim/spawns.js';
import { assignTeam } from '../sim/match.js';
import { stepWorld } from '../sim/step.js';
import { setInput, type SimWorld } from '../sim/world.js';
import { Channel, type Transport } from './transport.js';

/**
 * Host-authoritative session (docs/networking.md §2, ADR-006).
 *
 * The host player's browser owns the only real simulation. Clients send inputs
 * and receive snapshots; nothing a client says is trusted beyond its own input
 * frame, which is the whole point of host authority — a client cannot move
 * another player, set its own health, or claim a kill.
 *
 * Snapshots go out at 30 Hz (every second tick) while inputs arrive at 60, per
 * §6. The asymmetry is deliberate: inputs are tiny and latency-critical,
 * snapshots are large and interpolable.
 */

/** Snapshot every Nth tick: 60 Hz sim, 30 Hz snapshots. */
const SNAPSHOT_EVERY_TICKS = 2;
/** Per-client history for delta baselines; 32 entries ≈ 1 s at 30 Hz. */
const BASELINE_RING = 32;

interface ClientState {
  peerId: string;
  playerId: number;
  name: string;
  /** Newest input seq applied, for the reconciliation ack. */
  lastAppliedSeq: number;
  /** Snapshot ticks this client has acked, newest last. */
  ackTick: number;
  /** Recently sent snapshots, so a delta can be built against what they have. */
  history: Map<number, WireSnapshot>;
}

export interface HostSessionEvents {
  onPlayerJoined?(peerId: string, playerId: number, name: string): void;
  onPlayerLeft?(peerId: string, playerId: number): void;
  onRejected?(peerId: string, reason: string): void;
}

export class HostSession {
  private readonly clients = new Map<string, ClientState>();
  /** Slot → display name. Names are not simulated, so they live here. */
  private readonly names = new Map<number, string>();
  /** Inputs waiting to be applied on the next tick, by player slot. */
  private readonly queued = new Map<
    number,
    { seq: number; buttons: number; moveX: number; moveY: number; aim: number }
  >();

  constructor(
    private readonly world: SimWorld,
    private readonly transport: Transport,
    /** The host's own player slot — it plays too, it does not just serve. */
    private readonly hostPlayerId: number,
    private readonly tuningHashValue: number,
    private readonly mapIdIndex: number,
    /**
     * The seed the world was created with. Passed in rather than read off
     * `SimWorld`, which keeps only an `Rng` instance and not the seed that made
     * it — inventing a field there would put netcode state in the simulation.
     */
    private readonly seed: number,
    private readonly events: HostSessionEvents = {},
  ) {}

  get playerCount(): number {
    let count = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) if (this.world.players.connected[i] === 1) count += 1;
    return count;
  }

  /** Slot for a connected peer, or -1. */
  playerIdOf(peerId: string): number {
    return this.clients.get(peerId)?.playerId ?? -1;
  }

  /** Route one received frame. Unknown or malformed frames are dropped. */
  receive(peerId: string, channel: Channel, bytes: Uint8Array): void {
    const id = peekMsgId(bytes);
    if (id === MsgId.JoinRequest) {
      this.handleJoin(peerId, bytes);
      return;
    }
    if (id === MsgId.Input) {
      this.handleInput(peerId, bytes);
      return;
    }
    // Anything else from a client is not part of the client→host vocabulary.
    void channel;
  }

  private handleJoin(peerId: string, bytes: Uint8Array): void {
    let request;
    try {
      request = decodeJoinRequest(bytes);
    } catch {
      this.events.onRejected?.(peerId, 'bad-join');
      return;
    }
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      // Refuse rather than misbehave: a mismatched peer desyncs invisibly.
      this.events.onRejected?.(peerId, 'version-mismatch');
      return;
    }
    // Re-sending a join is idempotent — a lost WELCOME must be recoverable, and
    // the client has no way to know whether the host got the first one.
    const existing = this.clients.get(peerId);
    if (existing !== undefined) {
      this.sendWelcome(peerId, existing.playerId);
      return;
    }
    const playerId = addPlayer(this.world);
    if (playerId === -1) {
      this.events.onRejected?.(peerId, 'room-full');
      return;
    }
    // Balance the sides as people arrive, so a late joiner evens the teams out
    // rather than piling onto whoever is already ahead. A no-op in FFA. After the
    // full-room check, because there is no slot -1 to put on a team.
    assignTeam(this.world, playerId);
    this.clients.set(peerId, {
      peerId,
      playerId,
      name: request.name,
      lastAppliedSeq: 0,
      ackTick: 0,
      history: new Map(),
    });
    this.names.set(playerId, request.name);
    this.sendWelcome(peerId, playerId);
    // After WELCOME so the new client already knows its own slot when the roster
    // lands, and broadcast rather than unicast because everyone else needs the
    // newcomer's name too.
    this.broadcastRoster();
    this.events.onPlayerJoined?.(peerId, playerId, request.name);
  }

  /**
   * Name a player the host knows about outside the join path — in practice only
   * itself, since it never sends itself a JOIN_REQ.
   */
  setName(slot: number, name: string): void {
    this.names.set(slot, name);
    this.broadcastRoster();
  }

  /**
   * Send the whole roster to everyone.
   *
   * Whole rather than incremental: it is under 150 bytes for a full match, and a
   * client that missed one join/leave delta would show a wrong name for the rest
   * of the match with nothing to correct it.
   */
  private broadcastRoster(): void {
    const entries: RosterEntry[] = [];
    for (const [slot, name] of this.names) {
      if (this.world.players.connected[slot] === 1) entries.push({ slot, name });
    }
    entries.sort((a, b) => a.slot - b.slot);
    const bytes = encodeRoster(entries);
    for (const peerId of this.clients.keys()) this.transport.send(peerId, Channel.Ctrl, bytes);
  }

  /** Slot → name, for the host's own scoreboard. */
  nameOf(slot: number): string | null {
    return this.names.get(slot) ?? null;
  }

  private sendWelcome(peerId: string, playerId: number): void {
    this.transport.send(
      peerId,
      Channel.Ctrl,
      encodeWelcome({
        playerId,
        hostTick: this.world.tick,
        rngSeed: this.seed,
        mapId: this.mapIdIndex,
        tuningHash: this.tuningHashValue,
      }),
    );
  }

  private handleInput(peerId: string, bytes: Uint8Array): void {
    const client = this.clients.get(peerId);
    if (client === undefined) return; // Inputs before a join are ignored.
    let packet;
    try {
      packet = decodeInput(bytes);
    } catch {
      return;
    }
    client.ackTick = Math.max(client.ackTick, packet.ackTick);

    // Sequence numbers wrap at 16 bits, so "newer" is a windowed comparison, not
    // a plain `>`. Without this a client would go mute for ~18 minutes after
    // every wrap at 60 Hz.
    if (!isNewerSeq(packet.seq, client.lastAppliedSeq)) return;
    const frame = packet.frames[0];
    if (frame === undefined) return;
    this.queued.set(client.playerId, {
      seq: packet.seq,
      buttons: frame.buttons,
      moveX: frame.moveX,
      moveY: frame.moveY,
      aim: frame.aim,
    });
  }

  /** A peer vanished: free its slot so the match does not fill with ghosts. */
  dropPeer(peerId: string): void {
    const client = this.clients.get(peerId);
    if (client === undefined) return;
    this.clients.delete(peerId);
    this.queued.delete(client.playerId);
    this.names.delete(client.playerId);
    removePlayer(this.world, client.playerId);
    // Re-broadcast after removing the slot, so nobody keeps a name for a player
    // who has gone — the scoreboard would otherwise list a ghost.
    this.broadcastRoster();
    this.events.onPlayerLeft?.(peerId, client.playerId);
  }

  /**
   * Advance the authoritative sim one tick and, on snapshot ticks, broadcast.
   * `hostInput` is the host's own local input — it is a player, not a server.
   */
  tick(hostInput: { moveX: number; moveY: number; aim: number; buttons: number }): void {
    setInput(this.world, this.hostPlayerId, { seq: this.world.tick, ...hostInput });

    for (const [playerId, input] of this.queued) {
      setInput(this.world, playerId, {
        seq: input.seq,
        moveX: input.moveX,
        moveY: input.moveY,
        aim: input.aim,
        buttons: input.buttons,
      });
      const client = [...this.clients.values()].find((c) => c.playerId === playerId);
      if (client !== undefined) client.lastAppliedSeq = input.seq;
    }
    // Applied exactly once. Held buttons keep arriving every tick anyway, so
    // clearing here means a dropped packet costs one tick of input rather than
    // repeating a stale frame forever.
    this.queued.clear();

    stepWorld(this.world);

    if (this.world.tick % SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    for (const client of this.clients.values()) {
      const snapshot = captureSnapshot(this.world, client.lastAppliedSeq);
      const baseline = client.history.get(client.ackTick) ?? null;
      this.transport.send(client.peerId, Channel.Data, encodeSnapshot(snapshot, baseline));

      client.history.set(snapshot.tick, snapshot);
      // Bound the ring, or a long match leaks one snapshot per client per frame.
      if (client.history.size > BASELINE_RING) {
        const oldest = Math.min(...client.history.keys());
        client.history.delete(oldest);
      }
    }
  }
}

/**
 * Is `candidate` newer than `current`, accounting for 16-bit wrap?
 *
 * Exported because the client needs the same rule, and because getting it wrong
 * is a silent, delayed failure: a plain `>` works perfectly for 18 minutes and
 * then the client appears to freeze.
 */
export function isNewerSeq(candidate: number, current: number): boolean {
  return ((candidate - current) & 0xffff) !== 0 && ((candidate - current) & 0xffff) < 0x8000;
}
