import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  addPlayer,
  base64ToBytes,
  BridgeClient,
  bytesToBase64,
  captureSnapshot,
  Channel,
  createMapById,
  createMatch,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  RelayTransport,
  setInput,
  stepWorld,
  type BridgeEvents,
  type SocketCallbacks,
  type SocketLike,
} from '@aerocade/shared';
import { createBridge, type Bridge } from '../src/bridge.js';

/**
 * End-to-end relay path: two `BridgeClient`s, the **real** bridge, and the
 * **real** binary codec.
 *
 * This is deliberately not a mock. The transport is the seam where a mock proves
 * nothing — the interesting failures are base64 handling, the channel tag, room
 * addressing and payload caps, all of which a stub would happily fake. Because
 * `BridgeClient` takes an injected socket factory, the code exercised here is
 * exactly the code the browser runs; only the socket differs.
 */

let bridge: Bridge;
let port: number;
const clients: BridgeClient[] = [];

beforeEach(async () => {
  bridge = createBridge({
    staticDir: '/nonexistent-static-dir',
    createHttpServer: createServer,
    WebSocketServerImpl: WebSocketServer,
  });
  await new Promise<void>((resolve) => {
    bridge.httpServer.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = bridge.httpServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterEach(() => {
  for (const client of clients) client.close();
  clients.length = 0;
  bridge.close();
});

/** Adapt the `ws` package to the injected socket contract. */
function nodeSocketFactory(url: string, callbacks: SocketCallbacks): SocketLike {
  const ws = new WebSocket(url);
  ws.on('open', () => {
    callbacks.onOpen();
  });
  ws.on('message', (data: Buffer) => {
    callbacks.onMessage(data.toString('utf8'));
  });
  ws.on('close', () => {
    callbacks.onClose();
  });
  ws.on('error', (error) => {
    callbacks.onError(error);
  });
  return {
    send: (text) => {
      ws.send(text);
    },
    close: () => {
      ws.close();
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  };
}

function makeClient(events: BridgeEvents = {}): BridgeClient {
  const client = new BridgeClient(`ws://127.0.0.1:${String(port)}/ws`, nodeSocketFactory, events);
  clients.push(client);
  return client;
}

/** Wait for a condition the network will satisfy shortly, or fail loudly. */
async function until(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('bridge client handshake and rooms', () => {
  it('completes hello/welcome and is assigned a peer id', async () => {
    const client = makeClient();
    const peerId = await client.connect();
    expect(peerId).toBeTruthy();
    expect(client.id).toBe(peerId);
    expect(client.connected).toBe(true);
  });

  it('creates a room, lists it, and joins it from a second client', async () => {
    const host = makeClient();
    await host.connect();
    const room = await host.createRoom('Test Arena', 'Host', 'ffa', 'hollow_works');
    expect(room.mapId).toBe('hollow_works');
    // A host is its own host peer — relay addressing depends on this.
    expect(host.host).toBe(host.id);

    const guest = makeClient();
    await guest.connect();
    const rooms = await guest.listRooms();
    expect(rooms.map((r) => r.id)).toContain(room.id);

    const joined = await guest.joinRoom(room.id, 'Guest');
    expect(joined.hostPeerId).toBe(host.id);
    expect(guest.currentRoom?.id).toBe(room.id);
  });

  it('tells the host when a peer joins', async () => {
    const joins: string[] = [];
    const host = makeClient({
      onPeerJoined: (_peerId, name) => {
        joins.push(name);
      },
    });
    await host.connect();
    const room = await host.createRoom('Arena', 'Host', 'ffa', 'hollow_works');

    const guest = makeClient();
    await guest.connect();
    await guest.joinRoom(room.id, 'Vega');
    await until(() => joins.length > 0, 'peer-joined');
    expect(joins).toContain('Vega');
  });

  it('rejects joining a room that does not exist, with the bridge error code', async () => {
    // Without registering `error` alongside the happy path, this would time out
    // after 8 s and never say why.
    const guest = makeClient();
    await guest.connect();
    await expect(guest.joinRoom('nope', 'Guest')).rejects.toThrow(/room-not-found/);
  });
});

describe('relay transport carries real game frames', () => {
  /** Host + guest in one room, each with a transport pointed at the other. */
  async function pair() {
    const hostFrames: { peer: string; channel: Channel; bytes: Uint8Array }[] = [];
    const guestFrames: { peer: string; channel: Channel; bytes: Uint8Array }[] = [];

    const host = makeClient({
      onRelay: (from, bytes) => {
        hostTransport.acceptRelay(from, bytes);
      },
    });
    await host.connect();
    const room = await host.createRoom('Arena', 'Host', 'ffa', 'hollow_works');
    const hostTransport = new RelayTransport(host, {
      onFrame: (peer, channel, bytes) => {
        hostFrames.push({ peer, channel, bytes });
      },
    });

    const guest = makeClient({
      onRelay: (from, bytes) => {
        guestTransport.acceptRelay(from, bytes);
      },
    });
    await guest.connect();
    const joined = await guest.joinRoom(room.id, 'Guest');
    const guestTransport = new RelayTransport(guest, {
      onFrame: (peer, channel, bytes) => {
        guestFrames.push({ peer, channel, bytes });
      },
    });
    guestTransport.peerUp(joined.hostPeerId);
    return { host, guest, hostTransport, guestTransport, hostFrames, guestFrames, joined };
  }

  it('delivers an input packet from client to host, byte-exact', async () => {
    const { hostTransport, guestTransport, hostFrames, joined } = await pair();
    const packet = {
      seq: 1234,
      clientTick: 5678,
      ackTick: 5600,
      frames: [{ buttons: 0b101, moveX: 1, moveY: -1, aim: 1.25 }],
    };
    expect(guestTransport.send(joined.hostPeerId, Channel.Data, encodeInput(packet))).toBe(true);

    await until(() => hostFrames.length > 0, 'input frame at host');
    const received = hostFrames[0];
    if (received === undefined) throw new Error('no frame');
    expect(received.channel).toBe(Channel.Data);
    const decoded = decodeInput(received.bytes);
    expect(decoded.seq).toBe(packet.seq);
    expect(decoded.clientTick).toBe(packet.clientTick);
    expect(decoded.frames[0]?.buttons).toBe(0b101);
    expect(hostTransport.peers).toContain(received.peer);
  });

  it('delivers a real world snapshot from host to client', async () => {
    const { hostTransport, guestFrames, guest } = await pair();
    // Wait for the host transport to learn the guest, which it does from the
    // guest's first frame or an explicit peerUp.
    hostTransport.peerUp(guest.id);

    const world = createMatch(createMapById('hollow_works'), 7);
    addPlayer(world);
    addPlayer(world);
    for (let t = 0; t < 30; t++) {
      setInput(world, 0, { seq: t, moveX: 1, moveY: 0, aim: 0.5, buttons: 0 });
      stepWorld(world);
    }
    const snapshot = captureSnapshot(world, 42);
    expect(hostTransport.broadcast(Channel.Data, encodeSnapshot(snapshot, null))).toBe(1);

    await until(() => guestFrames.length > 0, 'snapshot at guest');
    const received = guestFrames[0];
    if (received === undefined) throw new Error('no frame');
    const decoded = decodeSnapshot(received.bytes);
    expect(decoded.tick).toBe(world.tick);
    expect(decoded.lastAckedInputSeq).toBe(42);
    expect(decoded.players).toHaveLength(snapshot.players.length);
    const sent = snapshot.players[0];
    const got = decoded.players[0];
    if (sent === undefined || got === undefined) throw new Error('player lost in transit');
    expect(got.x).toBeCloseTo(sent.x, 2);
    expect(got.y).toBeCloseTo(sent.y, 2);
  });

  it('keeps the two channels distinguishable over one socket', async () => {
    const { hostTransport, guestTransport, hostFrames, joined } = await pair();
    guestTransport.send(joined.hostPeerId, Channel.Ctrl, new Uint8Array([0x10, 1, 2]));
    guestTransport.send(joined.hostPeerId, Channel.Data, new Uint8Array([0x01, 9]));
    await until(() => hostFrames.length >= 2, 'both frames');
    const channels = hostFrames.map((f) => f.channel);
    expect(channels).toContain(Channel.Ctrl);
    expect(channels).toContain(Channel.Data);
    // The tag must not leak into the payload.
    const ctrl = hostFrames.find((f) => f.channel === Channel.Ctrl);
    expect([...(ctrl?.bytes ?? [])]).toEqual([0x10, 1, 2]);
    expect(hostTransport.dropped).toBe(0);
  });

  it('refuses an oversized frame instead of letting the bridge kill the socket', async () => {
    const errors: string[] = [];
    const client = makeClient({
      onError: (code) => {
        errors.push(code);
      },
    });
    await client.connect();
    const room = await client.createRoom('Arena', 'Host', 'ffa', 'hollow_works');
    expect(room.id).toBeTruthy();
    // 16 KiB of base64 is the bridge's cap; 32 KiB of bytes is far past it.
    expect(client.sendRelay(client.id, new Uint8Array(32 * 1024), false)).toBe(false);
    expect(errors).toContain('bad-message');
    // The socket must still be usable afterwards.
    expect(client.connected).toBe(true);
    expect((await client.listRooms()).length).toBeGreaterThan(0);
  });

  it('reports a peer leaving so the session can drop its player', async () => {
    const left: string[] = [];
    const host = makeClient({
      onPeerLeft: (peerId) => {
        left.push(peerId);
      },
    });
    await host.connect();
    const room = await host.createRoom('Arena', 'Host', 'ffa', 'hollow_works');
    const guest = makeClient();
    await guest.connect();
    await guest.joinRoom(room.id, 'Guest');
    const guestId = guest.id;
    guest.close();
    await until(() => left.includes(guestId), 'peer-left');
    expect(left).toContain(guestId);
  });
});

describe('base64 on the relay path', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect([...(base64ToBytes(bytesToBase64(all)) ?? [])]).toEqual([...all]);
  });

  it('round-trips every length modulo 3, so padding is exercised', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000, 1601]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37) & 0xff;
      const back = base64ToBytes(bytesToBase64(bytes));
      expect(back?.length, `length ${String(length)}`).toBe(length);
      expect([...(back ?? [])], `length ${String(length)}`).toEqual([...bytes]);
    }
  });

  it('returns null for malformed input rather than partial garbage', () => {
    // A truncated game frame is garbage, not a partial update (docs/security.md).
    expect(base64ToBytes('!!!!')).toBeNull();
    expect(base64ToBytes('AAAAA')).toBeNull(); // length 1 mod 4 is impossible
  });
});
