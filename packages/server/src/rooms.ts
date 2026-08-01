import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  parseClientToBridge,
  type BridgeToClient,
  type BridgeErrorCode,
  type RoomInfo,
} from '@aerocade/shared';

/** Messages allowed per peer per second (relay fallback traffic is chatty). */
const RATE_LIMIT_PER_SECOND = 240;
/** Hard cap on a single message's wire size; larger is hostile, not gameplay. */
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_ROOMS = 32;
/** Total concurrent sockets the bridge will accept. */
export const MAX_PEERS = 64;

export interface Peer {
  id: string;
  ws: WebSocket;
  name: string;
  roomId: string | null;
  /** Sliding-window rate limiting. */
  windowStart: number;
  windowCount: number;
  saidHello: boolean;
}

interface Room {
  id: string;
  name: string;
  hostPeerId: string;
  hostName: string;
  mode: string;
  mapId: string;
  /** Peer ids, host included. */
  members: Set<string>;
}

/**
 * The bridge's whole brain: rooms, membership, and message forwarding.
 * Deliberately game-agnostic — it never inspects game traffic (docs/networking.md).
 * Transport-agnostic by design: tests drive it with fake sockets.
 */
export class RoomRegistry {
  private readonly peers = new Map<string, Peer>();
  private readonly rooms = new Map<string, Room>();

  addPeer(ws: WebSocket): Peer {
    const peer: Peer = {
      id: randomBytes(6).toString('hex'),
      ws,
      name: '',
      roomId: null,
      windowStart: Date.now(),
      windowCount: 0,
      saidHello: false,
    };
    this.peers.set(peer.id, peer);
    return peer;
  }

  removePeer(peer: Peer): void {
    this.leaveRoom(peer);
    this.peers.delete(peer.id);
  }

  /** Handle one raw incoming message; all validation lives here. */
  handleRaw(peer: Peer, raw: string): void {
    if (this.rateLimited(peer)) {
      this.sendError(peer, 'rate-limited', 'slow down');
      return;
    }
    if (raw.length > MAX_MESSAGE_BYTES) {
      this.sendError(peer, 'bad-message', 'message too large');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(peer, 'bad-message', 'not JSON');
      return;
    }
    const msg = parseClientToBridge(parsed);
    if (msg === null) {
      this.sendError(peer, 'bad-message', 'unknown or malformed message');
      return;
    }

    switch (msg.t) {
      case 'hello': {
        if (msg.version !== PROTOCOL_VERSION) {
          this.sendError(peer, 'version-mismatch', `bridge speaks v${String(PROTOCOL_VERSION)}`);
          return;
        }
        peer.saidHello = true;
        this.send(peer, { t: 'welcome', peerId: peer.id, version: PROTOCOL_VERSION });
        return;
      }
      case 'ping': {
        this.send(peer, { t: 'pong' });
        return;
      }
      default:
        break;
    }

    if (!peer.saidHello) {
      this.sendError(peer, 'bad-message', 'say hello first');
      return;
    }

    switch (msg.t) {
      case 'room:create': {
        this.leaveRoom(peer);
        if (this.rooms.size >= MAX_ROOMS) {
          this.sendError(peer, 'room-full', 'bridge room limit reached');
          return;
        }
        peer.name = msg.hostName;
        const room: Room = {
          id: randomBytes(3).toString('hex'),
          name: msg.name,
          hostPeerId: peer.id,
          hostName: msg.hostName,
          mode: msg.mode,
          mapId: msg.mapId,
          members: new Set([peer.id]),
        };
        this.rooms.set(room.id, room);
        peer.roomId = room.id;
        this.send(peer, { t: 'room:created', room: this.roomInfo(room) });
        return;
      }
      case 'room:list': {
        const rooms: RoomInfo[] = [];
        for (const room of this.rooms.values()) rooms.push(this.roomInfo(room));
        this.send(peer, { t: 'room:listing', rooms });
        return;
      }
      case 'room:join': {
        const room = this.rooms.get(msg.roomId);
        if (room === undefined) {
          this.sendError(peer, 'room-not-found', 'no such room');
          return;
        }
        // Re-joining the room you are already in (double-click, client retry)
        // must be idempotent — leaveRoom here would close a host's own room.
        if (peer.roomId === msg.roomId) {
          this.send(peer, {
            t: 'room:joined',
            room: this.roomInfo(room),
            hostPeerId: room.hostPeerId,
          });
          return;
        }
        if (room.members.size >= MAX_PLAYERS) {
          this.sendError(peer, 'room-full', 'room is full');
          return;
        }
        this.leaveRoom(peer);
        peer.name = msg.playerName;
        room.members.add(peer.id);
        peer.roomId = room.id;
        this.send(peer, {
          t: 'room:joined',
          room: this.roomInfo(room),
          hostPeerId: room.hostPeerId,
        });
        const host = this.peers.get(room.hostPeerId);
        if (host !== undefined) {
          this.send(host, { t: 'room:peer-joined', peerId: peer.id, playerName: peer.name });
        }
        return;
      }
      case 'room:leave': {
        this.leaveRoom(peer);
        return;
      }
      case 'signal': {
        this.forward(peer, msg.to, (from) => ({ t: 'signal', from, data: msg.data }));
        return;
      }
      case 'relay': {
        this.forward(peer, msg.to, (from) => ({ t: 'relay', from, payload: msg.payload }));
        return;
      }
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  // ---------- internals ----------

  private forward(peer: Peer, targetId: string, build: (fromId: string) => BridgeToClient): void {
    if (peer.roomId === null) {
      this.sendError(peer, 'not-in-room', 'join a room first');
      return;
    }
    const target = this.peers.get(targetId);
    if (target?.roomId !== peer.roomId) {
      this.sendError(peer, 'not-in-room', 'target not in your room');
      return;
    }
    this.send(target, build(peer.id));
  }

  private leaveRoom(peer: Peer): void {
    if (peer.roomId === null) return;
    const room = this.rooms.get(peer.roomId);
    peer.roomId = null;
    if (room === undefined) return;
    room.members.delete(peer.id);

    if (room.hostPeerId === peer.id) {
      // Host left: the match cannot continue (host-authoritative), close it.
      for (const memberId of room.members) {
        const member = this.peers.get(memberId);
        if (member !== undefined) {
          member.roomId = null;
          this.send(member, { t: 'room:closed', roomId: room.id });
        }
      }
      this.rooms.delete(room.id);
    } else {
      const host = this.peers.get(room.hostPeerId);
      if (host !== undefined) this.send(host, { t: 'room:peer-left', peerId: peer.id });
    }
  }

  private roomInfo(room: Room): RoomInfo {
    return {
      id: room.id,
      name: room.name,
      hostName: room.hostName,
      players: room.members.size,
      maxPlayers: MAX_PLAYERS,
      mode: room.mode,
      mapId: room.mapId,
    };
  }

  private rateLimited(peer: Peer): boolean {
    const now = Date.now();
    if (now - peer.windowStart >= 1000) {
      peer.windowStart = now;
      peer.windowCount = 0;
    }
    peer.windowCount += 1;
    return peer.windowCount > RATE_LIMIT_PER_SECOND;
  }

  private send(peer: Peer, msg: BridgeToClient): void {
    if (peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(JSON.stringify(msg));
    }
  }

  private sendError(peer: Peer, code: BridgeErrorCode, message: string): void {
    this.send(peer, { t: 'error', code, message });
  }
}
