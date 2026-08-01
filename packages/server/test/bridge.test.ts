import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type BridgeToClient } from '@aerocade/shared';
import { createBridge, type Bridge } from '../src/bridge.js';

let bridge: Bridge;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  bridge = createBridge({
    staticDir: '/nonexistent-static-dir',
    createHttpServer: createServer,
    WebSocketServerImpl: WebSocketServer,
  });
  await new Promise<void>((resolveListen) => {
    bridge.httpServer.listen(0, '127.0.0.1', () => {
      resolveListen();
    });
  });
  const addr = bridge.httpServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterEach(() => {
  for (const ws of sockets) ws.close();
  sockets.length = 0;
  bridge.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    sockets.push(ws);
    ws.once('open', () => {
      resolveWs(ws);
    });
    ws.once('error', rejectWs);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<BridgeToClient> {
  return new Promise((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => {
      rejectMsg(new Error('timed out waiting for message'));
    }, timeoutMs);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      resolveMsg(JSON.parse(data.toString()) as BridgeToClient);
    });
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function hello(ws: WebSocket): Promise<string> {
  send(ws, { t: 'hello', version: PROTOCOL_VERSION });
  const welcome = await nextMessage(ws);
  if (welcome.t !== 'welcome') throw new Error(`expected welcome, got ${welcome.t}`);
  return welcome.peerId;
}

describe('bridge handshake', () => {
  it('welcomes a matching protocol version', async () => {
    const ws = await connect();
    const peerId = await hello(ws);
    expect(peerId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rejects a version mismatch', async () => {
    const ws = await connect();
    send(ws, { t: 'hello', version: 999 });
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ t: 'error', code: 'version-mismatch' });
  });

  it('rejects malformed JSON and unknown messages without crashing', async () => {
    const ws = await connect();
    ws.send('this is not json');
    expect(await nextMessage(ws)).toMatchObject({ t: 'error', code: 'bad-message' });
    send(ws, { t: 'launch-missiles' });
    expect(await nextMessage(ws)).toMatchObject({ t: 'error', code: 'bad-message' });
  });

  it('requires hello before room operations', async () => {
    const ws = await connect();
    send(ws, { t: 'room:list' });
    expect(await nextMessage(ws)).toMatchObject({ t: 'error', code: 'bad-message' });
  });
});

describe('rooms', () => {
  it('create, list, join, and notify the host', async () => {
    const hostWs = await connect();
    await hello(hostWs);
    send(hostWs, {
      t: 'room:create',
      name: 'Test Arena',
      hostName: 'Hosty',
      mode: 'ffa',
      mapId: 'foundry',
    });
    const created = await nextMessage(hostWs);
    if (created.t !== 'room:created') throw new Error('expected room:created');
    expect(created.room).toMatchObject({ name: 'Test Arena', players: 1, mapId: 'foundry' });

    const joinerWs = await connect();
    const joinerId = await hello(joinerWs);
    send(joinerWs, { t: 'room:list' });
    const listing = await nextMessage(joinerWs);
    if (listing.t !== 'room:listing') throw new Error('expected room:listing');
    expect(listing.rooms).toHaveLength(1);

    const hostNotified = nextMessage(hostWs);
    send(joinerWs, { t: 'room:join', roomId: created.room.id, playerName: 'Zoomer' });
    const joined = await nextMessage(joinerWs);
    expect(joined).toMatchObject({ t: 'room:joined' });
    expect(await hostNotified).toMatchObject({
      t: 'room:peer-joined',
      peerId: joinerId,
      playerName: 'Zoomer',
    });
  });

  it('a host re-joining their own room is idempotent (room survives)', async () => {
    const hostWs = await connect();
    await hello(hostWs);
    send(hostWs, { t: 'room:create', name: 'Mine', hostName: 'H', mode: 'ffa', mapId: 'foundry' });
    const created = await nextMessage(hostWs);
    if (created.t !== 'room:created') throw new Error('expected room:created');

    send(hostWs, { t: 'room:join', roomId: created.room.id, playerName: 'H' });
    const rejoined = await nextMessage(hostWs);
    expect(rejoined).toMatchObject({ t: 'room:joined' });
    expect(bridge.registry.roomCount).toBe(1);

    // The room is still joinable by someone else afterwards.
    const otherWs = await connect();
    await hello(otherWs);
    send(otherWs, { t: 'room:join', roomId: created.room.id, playerName: 'O' });
    expect(await nextMessage(otherWs)).toMatchObject({ t: 'room:joined' });
  });

  it('joining a missing or full room fails cleanly', async () => {
    const ws = await connect();
    await hello(ws);
    send(ws, { t: 'room:join', roomId: 'nope42', playerName: 'Lost' });
    expect(await nextMessage(ws)).toMatchObject({ t: 'error', code: 'room-not-found' });
  });

  it('host disconnect closes the room for members', async () => {
    const hostWs = await connect();
    await hello(hostWs);
    send(hostWs, {
      t: 'room:create',
      name: 'Doomed',
      hostName: 'H',
      mode: 'ffa',
      mapId: 'foundry',
    });
    const created = await nextMessage(hostWs);
    if (created.t !== 'room:created') throw new Error('expected room:created');

    const memberWs = await connect();
    await hello(memberWs);
    send(memberWs, { t: 'room:join', roomId: created.room.id, playerName: 'M' });
    await nextMessage(memberWs); // room:joined

    const closed = nextMessage(memberWs);
    hostWs.close();
    expect(await closed).toMatchObject({ t: 'room:closed', roomId: created.room.id });
    expect(bridge.registry.roomCount).toBe(0);
  });
});

describe('signaling and relay', () => {
  it('forwards signal and relay payloads between room members only', async () => {
    const hostWs = await connect();
    const hostId = await hello(hostWs);
    send(hostWs, { t: 'room:create', name: 'R', hostName: 'H', mode: 'ffa', mapId: 'foundry' });
    const created = await nextMessage(hostWs);
    if (created.t !== 'room:created') throw new Error('expected room:created');

    const peerWs = await connect();
    const peerId = await hello(peerWs);
    const hostSeesJoin = nextMessage(hostWs);
    send(peerWs, { t: 'room:join', roomId: created.room.id, playerName: 'P' });
    await nextMessage(peerWs);
    await hostSeesJoin;

    // signal peer -> host
    const hostGetsSignal = nextMessage(hostWs);
    send(peerWs, { t: 'signal', to: hostId, data: { sdp: 'fake-offer' } });
    expect(await hostGetsSignal).toMatchObject({
      t: 'signal',
      from: peerId,
      data: { sdp: 'fake-offer' },
    });

    // relay host -> peer
    const peerGetsRelay = nextMessage(peerWs);
    send(hostWs, { t: 'relay', to: peerId, payload: 'AAECAw==' });
    expect(await peerGetsRelay).toMatchObject({ t: 'relay', from: hostId, payload: 'AAECAw==' });

    // an outsider cannot signal into the room
    const outsiderWs = await connect();
    await hello(outsiderWs);
    send(outsiderWs, { t: 'signal', to: hostId, data: {} });
    expect(await nextMessage(outsiderWs)).toMatchObject({ t: 'error', code: 'not-in-room' });
  });

  it('rejects oversized relay payloads instead of forwarding them', async () => {
    const hostWs = await connect();
    const hostId = await hello(hostWs);
    send(hostWs, { t: 'room:create', name: 'R', hostName: 'H', mode: 'ffa', mapId: 'foundry' });
    const created = await nextMessage(hostWs);
    if (created.t !== 'room:created') throw new Error('expected room:created');

    const peerWs = await connect();
    await hello(peerWs);
    const hostSeesJoin = nextMessage(hostWs);
    send(peerWs, { t: 'room:join', roomId: created.room.id, playerName: 'P' });
    await nextMessage(peerWs); // room:joined
    await hostSeesJoin;

    send(peerWs, { t: 'relay', to: hostId, payload: 'A'.repeat(20 * 1024) });
    expect(await nextMessage(peerWs)).toMatchObject({ t: 'error', code: 'bad-message' });
  });
});
