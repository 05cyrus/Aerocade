import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { WebSocketServer, WebSocket } from 'ws';
import { RoomRegistry } from './rooms.js';
import { serveStatic } from './static-files.js';

const SWEEP_INTERVAL_MS = 5000;
/** Sockets that never complete a hello are dropped after this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface BridgeDeps {
  staticDir: string;
  createHttpServer: (
    listener: (req: IncomingMessage, res: ServerResponse) => void,
  ) => Server;
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

  const wss = new deps.WebSocketServerImpl({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const peer = registry.addPeer(ws);
    const handshakeTimer = setTimeout(() => {
      if (!peer.saidHello) ws.close(4000, 'hello timeout');
    }, HANDSHAKE_TIMEOUT_MS);

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

  const sweeper = setInterval(() => {
    registry.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    httpServer,
    registry,
    close: (): void => {
      clearInterval(sweeper);
      wss.close();
      httpServer.close();
    },
  };
}
