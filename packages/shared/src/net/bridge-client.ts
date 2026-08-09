import {
  MAX_RELAY_PAYLOAD_CHARS,
  PROTOCOL_VERSION,
  type BridgeToClient,
  type ClientToBridge,
  type RoomInfo,
} from '../protocol/messages.js';
import { base64ToBytes, bytesToBase64 } from './base64.js';

/**
 * Client half of the bridge protocol (docs/networking.md §4).
 *
 * The socket is **injected** rather than constructed here. `packages/shared` may
 * not reference DOM or Node types (ADR-002), and more usefully it means the exact
 * code the browser runs is the code the tests drive against a real bridge from
 * Node — no environment branch, so the tested path is the shipped path.
 */

/** Minimal socket surface: everything else is adapted by the factory. */
export interface SocketLike {
  send(text: string): void;
  close(): void;
  /** Bytes queued but not yet flushed, when the implementation exposes it. */
  readonly bufferedAmount?: number;
}

export interface SocketCallbacks {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(): void;
  onError(error: unknown): void;
}

/** Adapts whatever WebSocket the host environment has to plain callbacks. */
export type SocketFactory = (url: string, callbacks: SocketCallbacks) => SocketLike;

export interface BridgeEvents {
  onPeerJoined?(peerId: string, playerName: string): void;
  onPeerLeft?(peerId: string): void;
  onRoomClosed?(roomId: string): void;
  onSignal?(from: string, data: unknown): void;
  onRelay?(from: string, bytes: Uint8Array): void;
  onError?(code: string, message: string): void;
  onDisconnected?(): void;
}

/** Application keepalive; the bridge also runs its own 30 s WS heartbeat. */
const PING_INTERVAL_MS = 10_000;
/** Above this many queued bytes, unreliable frames are dropped rather than sent. */
const BACKPRESSURE_BYTES = 64 * 1024;

type Timer = ReturnType<typeof setInterval>;

export class BridgeClient {
  private socket: SocketLike | null = null;
  private peerId = '';
  private room: RoomInfo | null = null;
  private hostPeerId = '';
  private pingTimer: Timer | null = null;
  private closed = false;
  /** Resolvers for request/response pairs the bridge answers exactly once. */
  private readonly pending = new Map<string, (msg: BridgeToClient) => void>();

  constructor(
    private readonly url: string,
    private readonly createSocket: SocketFactory,
    private readonly events: BridgeEvents = {},
  ) {}

  get id(): string {
    return this.peerId;
  }

  get currentRoom(): RoomInfo | null {
    return this.room;
  }

  get host(): string {
    return this.hostPeerId;
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  /** Open the socket and complete the `hello` → `welcome` handshake. */
  async connect(): Promise<string> {
    const welcome = await new Promise<BridgeToClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('bridge handshake timed out'));
      }, 8000);
      this.pending.set('welcome', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.socket = this.createSocket(this.url, {
        onOpen: () => {
          this.send({ t: 'hello', version: PROTOCOL_VERSION });
        },
        onMessage: (text) => {
          this.handle(text);
        },
        onClose: () => {
          clearTimeout(timer);
          this.onSocketClosed();
          reject(new Error('bridge closed during handshake'));
        },
        onError: (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('bridge socket error'));
        },
      });
    });

    if (welcome.t !== 'welcome') throw new Error('unexpected handshake reply');
    if (welcome.version !== PROTOCOL_VERSION) {
      throw new Error(
        `bridge speaks protocol ${String(welcome.version)}, we speak ${String(PROTOCOL_VERSION)}`,
      );
    }
    this.peerId = welcome.peerId;
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
    return this.peerId;
  }

  async createRoom(name: string, hostName: string, mode: string, mapId: string): Promise<RoomInfo> {
    const reply = await this.request('room:created', {
      t: 'room:create',
      name,
      hostName,
      mode,
      mapId,
    });
    if (reply.t !== 'room:created') throw new Error('room create failed');
    this.room = reply.room;
    // The host is its own host: signalling and relay addressing both use this.
    this.hostPeerId = this.peerId;
    return reply.room;
  }

  async listRooms(): Promise<RoomInfo[]> {
    const reply = await this.request('room:listing', { t: 'room:list' });
    return reply.t === 'room:listing' ? reply.rooms : [];
  }

  async joinRoom(
    roomId: string,
    playerName: string,
  ): Promise<{ room: RoomInfo; hostPeerId: string }> {
    const reply = await this.request('room:joined', { t: 'room:join', roomId, playerName });
    if (reply.t !== 'room:joined') throw new Error('room join failed');
    this.room = reply.room;
    this.hostPeerId = reply.hostPeerId;
    return { room: reply.room, hostPeerId: reply.hostPeerId };
  }

  leaveRoom(): void {
    this.send({ t: 'room:leave' });
    this.room = null;
    this.hostPeerId = '';
  }

  sendSignal(to: string, data: unknown): void {
    this.send({ t: 'signal', to, data });
  }

  /**
   * Relay a game frame. `allowDrop` marks an unreliable send: those are dropped
   * when the socket is backed up, because a queued 60 Hz input is already stale
   * by the time it flushes and queueing it only delays the next one
   * (docs/networking.md §3).
   */
  sendRelay(to: string, bytes: Uint8Array, allowDrop: boolean): boolean {
    if (this.socket === null || this.closed) return false;
    const buffered = this.socket.bufferedAmount ?? 0;
    if (allowDrop && buffered > BACKPRESSURE_BYTES) return false;

    const payload = bytesToBase64(bytes);
    if (payload.length > MAX_RELAY_PAYLOAD_CHARS) {
      // The bridge would reject this outright; failing here names the real cause
      // instead of surfacing as a mysterious disconnect.
      this.events.onError?.(
        'bad-message',
        `relay payload ${String(payload.length)} chars exceeds the cap`,
      );
      return false;
    }
    this.send({ t: 'relay', to, payload });
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private send(message: ClientToBridge): void {
    if (this.socket === null || this.closed) return;
    this.socket.send(JSON.stringify(message));
  }

  private async request(expect: string, message: ClientToBridge): Promise<BridgeToClient> {
    return new Promise<BridgeToClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expect);
        reject(new Error(`bridge did not answer ${message.t}`));
      }, 8000);
      // `error` is registered alongside the happy path: the bridge answers a bad
      // request with `error`, and without this the caller would just time out
      // and never learn why.
      const settle = (msg: BridgeToClient): void => {
        clearTimeout(timer);
        this.pending.delete(expect);
        this.pending.delete('error');
        if (msg.t === 'error') reject(new Error(`${msg.code}: ${msg.message}`));
        else resolve(msg);
      };
      this.pending.set(expect, settle);
      this.pending.set('error', settle);
      this.send(message);
    });
  }

  private onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.events.onDisconnected?.();
  }

  private handle(text: string): void {
    // Parsed as `unknown` and narrowed by hand. Casting straight to
    // `BridgeToClient` makes the shape checks look dead to the compiler while
    // the data is in fact arbitrary — it arrives off the network.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // The bridge only ever sends JSON; anything else is noise.
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const tag = (parsed as { t?: unknown }).t;
    if (typeof tag !== 'string') return;
    const msg = parsed as BridgeToClient;

    const waiting = this.pending.get(tag);
    if (waiting !== undefined) {
      waiting(msg);
      return;
    }

    switch (msg.t) {
      case 'room:peer-joined':
        this.events.onPeerJoined?.(msg.peerId, msg.playerName);
        break;
      case 'room:peer-left':
        this.events.onPeerLeft?.(msg.peerId);
        break;
      case 'room:closed':
        this.room = null;
        this.events.onRoomClosed?.(msg.roomId);
        break;
      case 'signal':
        this.events.onSignal?.(msg.from, msg.data);
        break;
      case 'relay': {
        const bytes = base64ToBytes(msg.payload);
        // A frame that fails to decode is dropped, never half-applied: a
        // truncated snapshot is garbage, not a partial update.
        if (bytes !== null) this.events.onRelay?.(msg.from, bytes);
        break;
      }
      case 'error':
        this.events.onError?.(msg.code, msg.message);
        break;
      default:
        break;
    }
  }
}
