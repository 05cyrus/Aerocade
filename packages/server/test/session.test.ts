import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  addPlayer,
  BridgeClient,
  ClientSession,
  createMapById,
  createMatch,
  createWorld,
  HostSession,
  isNewerSeq,
  RelayTransport,
  TUNING,
  tuningHash,
  WEAPON_COUNT,
  weaponDef,
  type BridgeEvents,
  type WeaponId,
  type SocketCallbacks,
  type SocketLike,
  type RosterEntry,
} from '@aerocade/shared';
import { createBridge, type Bridge } from '../src/bridge.js';

/**
 * A real two-peer match: host simulation, client projection, real bridge, real
 * codec. The assertion that matters is **convergence** — a client's world must
 * come to agree with the host's, because that is the only thing the whole netcode
 * exists to achieve.
 *
 * Driven from Node rather than two browsers, which is what makes it a normal test
 * instead of a Playwright suite: the sessions are transport-agnostic and the
 * socket is injected, so nothing here is a stand-in for the shipped path.
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

async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Built from the public accessor rather than reaching into the defs table, so
// the hash covers exactly what a real peer would hash.
const WEAPON_DEFS = Array.from({ length: WEAPON_COUNT }, (_, i) => weaponDef(i as WeaponId));
const HASH = tuningHash(TUNING, WEAPON_DEFS);
const SEED = 1234;

/** Stand up a host and a joined client, wired through the bridge. */
async function match(clientTuningHash = HASH) {
  const hostWorld = createMatch(createMapById('hollow_works'), SEED);
  const hostPlayer = addPlayer(hostWorld);

  const hostBridge = makeClient({
    onRelay: (from, bytes) => {
      hostTransport.acceptRelay(from, bytes);
    },
    onPeerLeft: (peerId) => {
      host.dropPeer(peerId);
      hostTransport.peerDown(peerId);
    },
  });
  await hostBridge.connect();
  const room = await hostBridge.createRoom('Arena', 'Host', 'ffa', 'hollow_works');

  const joins: number[] = [];
  const hostTransport = new RelayTransport(hostBridge, {
    onFrame: (peer, channel, bytes) => {
      host.receive(peer, channel, bytes);
    },
  });
  const host = new HostSession(hostWorld, hostTransport, hostPlayer, HASH, 0, SEED, {
    onPlayerJoined: (peerId, playerId) => {
      hostTransport.peerUp(peerId);
      joins.push(playerId);
    },
  });

  // The client keeps a world it never simulates; snapshots are projected in.
  const clientWorld = createWorld(createMapById('hollow_works'), SEED);
  const clientBridge = makeClient({
    onRelay: (from, bytes) => {
      clientTransport.acceptRelay(from, bytes);
    },
  });
  await clientBridge.connect();
  const joined = await clientBridge.joinRoom(room.id, 'Guest');
  const mismatches: number[] = [];
  const clientTransport = new RelayTransport(clientBridge, {
    onFrame: (peer, channel, bytes) => {
      client.receive(peer, channel, bytes);
    },
  });
  const rosters: RosterEntry[][] = [];
  const client = new ClientSession(
    clientWorld,
    clientTransport,
    joined.hostPeerId,
    clientTuningHash,
    {
      onVersionMismatch: (hostHash) => {
        mismatches.push(hostHash);
      },
      onRoster: (entries) => {
        rosters.push([...entries]);
      },
    },
  );
  clientTransport.peerUp(joined.hostPeerId);

  /** Run the host loop for n ticks, letting the event loop deliver frames. */
  const run = async (ticks: number): Promise<void> => {
    for (let t = 0; t < ticks; t++) {
      host.tick({ moveX: 0, moveY: 0, aim: 0, buttons: 0 });
      // Yield so relayed frames actually arrive between ticks.
      if (t % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  return {
    host,
    client,
    hostWorld,
    clientWorld,
    hostPlayer,
    joins,
    mismatches,
    run,
    clientBridge,
    rosters,
  };
}

describe('host/client session over the bridge', () => {
  it('admits a joining client and assigns it a distinct player slot', async () => {
    const { host, client, hostPlayer, joins, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');

    expect(client.playerId).toBeGreaterThanOrEqual(0);
    expect(client.playerId).not.toBe(hostPlayer);
    expect(joins).toContain(client.playerId);
    expect(host.playerCount).toBe(2);
    await run(2);
  });

  it("converges the client's world onto the host's", async () => {
    const { client, hostWorld, clientWorld, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');

    // Host runs; the client should end up holding the host's state.
    await run(40);
    await until(() => client.stats.accepted > 0, 'first snapshot');
    await run(40);
    await until(() => client.stats.tick >= 60, 'snapshots flowing');

    const slot = client.playerId;
    expect(clientWorld.players.connected[slot]).toBe(1);
    // Quantized to 1/256 m, so exact equality is not the bar; agreement is.
    expect(clientWorld.players.posX[slot]).toBeCloseTo(hostWorld.players.posX[slot] ?? 0, 1);
    expect(clientWorld.players.posY[slot]).toBeCloseTo(hostWorld.players.posY[slot] ?? 0, 1);
    expect(clientWorld.players.health[slot]).toBe(hostWorld.players.health[slot]);
    // And it sees the host's player too, not just itself.
    expect(clientWorld.players.connected[0]).toBe(1);
  });

  it("moves the client's player in the host sim from its inputs", async () => {
    const { client, hostWorld, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    const slot = client.playerId;
    const startX = hostWorld.players.posX[slot] ?? 0;

    // Hold right for a while, sending an input per tick as the client would.
    for (let t = 0; t < 60; t++) {
      client.sendInput({ buttons: 0, moveX: 1, moveY: 0, aim: 0 });
      await run(1);
    }
    const movedX = hostWorld.players.posX[slot] ?? 0;
    expect(movedX - startX).toBeGreaterThan(2);
  });

  it('projects the host pickups and map state into the client world', async () => {
    const { client, hostWorld, clientWorld, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    await run(30);
    await until(() => client.stats.accepted > 0, 'snapshot');

    const hostAlive = [...hostWorld.pickups.alive].filter((v) => v === 1).length;
    const clientAlive = [...clientWorld.pickups.alive].filter((v) => v === 1).length;
    expect(hostAlive).toBeGreaterThan(0);
    expect(clientAlive).toBe(hostAlive);
  });

  it('sends deltas after the first keyframe, not keyframes forever', async () => {
    const { client, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    // Acks ride on inputs, so the client must be sending them for deltas to start.
    for (let t = 0; t < 40; t++) {
      client.sendInput({ buttons: 0, moveX: 0, moveY: 0, aim: 0 });
      await run(1);
    }
    // Every accepted snapshot proves the delta chain held: an unusable delta is
    // counted as dropped, so a high accept count with few drops means baselines
    // matched.
    expect(client.stats.accepted).toBeGreaterThan(5);
    expect(client.stats.dropped).toBeLessThan(client.stats.accepted);
  });

  it('refuses to join a host whose tuning disagrees', async () => {
    // A mismatched peer desyncs invisibly, which players read as lag or cheating.
    const { client, mismatches, run } = await match(HASH ^ 0xabcdef);
    client.requestJoin('Guest');
    await until(() => mismatches.length > 0, 'version mismatch');
    expect(client.joined).toBe(false);
    await run(4);
    expect(client.stats.accepted).toBe(0);
  });

  it('frees the slot when a peer disconnects', async () => {
    const { host, client, clientBridge, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    expect(host.playerCount).toBe(2);

    clientBridge.close();
    await until(() => host.playerCount === 1, 'slot freed');
    expect(host.playerIdOf('gone')).toBe(-1);
    await run(2);
  });

  it('treats a repeated join as idempotent rather than taking a second slot', async () => {
    const { host, client, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    const first = client.playerId;
    // A lost WELCOME means the client retries; it must not consume another slot.
    client.requestJoin('Guest');
    await run(10);
    expect(host.playerCount).toBe(2);
    expect(client.playerId).toBe(first);
  });
});

describe('sequence wrap', () => {
  it('treats a wrapped sequence as newer', () => {
    // A plain `>` works for ~18 minutes at 60 Hz and then the client goes mute.
    expect(isNewerSeq(1, 65535)).toBe(true);
    expect(isNewerSeq(65535, 1)).toBe(false);
    expect(isNewerSeq(100, 99)).toBe(true);
    expect(isNewerSeq(99, 100)).toBe(false);
    expect(isNewerSeq(5, 5)).toBe(false);
  });
});

describe('roster: names reach the other side', () => {
  it('publishes every player’s name to a joining client', async () => {
    // Without this the scoreboard shows "Player 2" for everyone but yourself,
    // which was the visible shortfall when the match UI first shipped.
    const { host, client, hostPlayer, run } = await match();
    host.setName(hostPlayer, 'Hostname');
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    await until(() => client.nameOf(client.playerId) === 'Guest', 'roster');

    expect(client.nameOf(hostPlayer)).toBe('Hostname');
    expect(client.nameOf(client.playerId)).toBe('Guest');
    // And the host can name both sides for its own scoreboard.
    expect(host.nameOf(hostPlayer)).toBe('Hostname');
    expect(host.nameOf(client.playerId)).toBe('Guest');
    await run(2);
  });

  it('returns null for a slot nobody occupies', async () => {
    const { client, run } = await match();
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    expect(client.nameOf(6)).toBeNull();
    await run(2);
  });

  it('drops a name when its player leaves, so no ghost is listed', async () => {
    const { host, client, clientBridge, run } = await match();
    host.setName(0, 'Hostname');
    client.requestJoin('Guest');
    await until(() => client.joined, 'welcome');
    const guestSlot = client.playerId;
    await until(() => host.nameOf(guestSlot) === 'Guest', 'host knows the guest');

    clientBridge.close();
    await until(() => host.playerCount === 1, 'slot freed');
    expect(host.nameOf(guestSlot)).toBeNull();
    expect(host.nameOf(0)).toBe('Hostname');
    await run(2);
  });

  it('sends the roster whole, not as a stream of joins', async () => {
    // A client that missed one delta would show a wrong name for the rest of the
    // match; a whole roster is self-healing.
    const { host, client, hostPlayer, rosters, run } = await match();
    host.setName(hostPlayer, 'Hostname');
    client.requestJoin('Guest');
    await until(() => rosters.length > 0, 'roster');
    const last = rosters[rosters.length - 1];
    if (last === undefined) throw new Error('no roster');
    expect(last.map((e) => e.slot).sort((a, b) => a - b)).toEqual([hostPlayer, client.playerId]);
    await run(2);
  });
});
