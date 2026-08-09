import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { WebSocketServer, WebSocket } from 'ws';
import { MAX_PEERS, RoomRegistry } from './rooms.js';
import { serveStatic } from './static-files.js';

/** Sockets that never complete a hello are dropped after this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Liveness heartbeat. A half-open socket (peer walked out of Wi-Fi range)
 * never emits 'close' on its own; without pings a dead host would pin its
 * room forever — and a stale room in the list is worse than no room, because a
 * player picks it and waits for a host that will never answer. Ten seconds means a
 * ghost is gone within twenty, which is about as long as someone will stare at a
 * room list. Two missed pongs = terminated, which fires 'close' and runs
 * the normal room-cleanup path.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Upper bound on one WS frame; larger is hostile, not gameplay (docs/security.md). */
const MAX_WS_PAYLOAD_BYTES = 128 * 1024;

export interface BridgeDeps {
  staticDir: string;
  createHttpServer: (listener: (req: IncomingMessage, res: ServerResponse) => void) => Server;
  WebSocketServerImpl: typeof WebSocketServer;
}

export interface Bridge {
  httpServer: Server;
  registry: RoomRegistry;
  close: () => void;
}

/** Normalize the ws library's message payload union into a UTF-8 string. */
function rawToUtf8(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Assemble the LAN bridge: static PWA hosting over HTTP plus the room/signal
 * WebSocket at /ws. Constructed via injection so tests can drive it on an
 * ephemeral port.
 */
export function createBridge(deps: BridgeDeps): Bridge {
  const registry = new RoomRegistry();

  const httpServer = deps.createHttpServer((req, res) => {
    serveStatic(deps.staticDir, req, res);
  });

  const wss = new deps.WebSocketServerImpl({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });

  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws: WebSocket) => {
    if (registry.peerCount >= MAX_PEERS) {
      ws.close(4001, 'bridge full');
      return;
    }
    const peer = registry.addPeer(ws);
    alive.set(ws, true);
    const handshakeTimer = setTimeout(() => {
      if (!peer.saidHello) ws.close(4000, 'hello timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return; // bridge control channel is JSON-only
      registry.handleRaw(peer, rawToUtf8(data));
    });
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      registry.removePeer(peer);
    });
    ws.on('error', () => {
      ws.close();
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate(); // fires 'close' → removePeer → room cleanup
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    httpServer,
    registry,
    close: (): void => {
      clearInterval(heartbeat);
      wss.close();
      httpServer.close();
    },
  };
}
