import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBridge } from './bridge.js';

const port = Number(process.env.PORT ?? 8080);
const staticDir =
  process.env.AEROCADE_STATIC_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

const { httpServer } = createBridge({
  staticDir,
  createHttpServer: createServer,
  WebSocketServerImpl: WebSocketServer,
});

httpServer.listen(port, () => {
  console.info('');
  console.info('  Aerocade LAN bridge is up.  Players on this Wi-Fi can open:');
  console.info('');
  for (const addr of lanAddresses()) {
    console.info(`    http://${addr}:${String(port)}`);
  }
  console.info(`    http://localhost:${String(port)}  (this machine)`);
  console.info('');
  console.info(`  serving: ${staticDir}`);
  console.info('  no internet required — everything stays on your network.');
  console.info('');
});

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
