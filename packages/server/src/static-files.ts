import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** decodeURIComponent throws on malformed escapes ('%zz') — never let a request crash the process. */
function safeDecode(component: string): string | null {
  try {
    return decodeURIComponent(component);
  } catch {
    return null;
  }
}

/**
 * Serve the built PWA. Traversal-safe: the resolved path must stay inside the
 * root (docs/security.md). Unknown paths fall back to index.html (SPA), and
 * HTML / the service worker are never cached so updates roll out immediately.
 * Every path through here must respond rather than throw — this is the HTTP
 * listener of a process that also holds all room state.
 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  try {
    serveStaticInner(root, req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error');
  }
}

function serveStaticInner(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const rootAbs = resolve(root);
  const urlPath = safeDecode((req.url ?? '/').split('?')[0] ?? '/');
  if (urlPath === null || urlPath.includes('\0')) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  let filePath = normalize(join(rootAbs, urlPath));
  if (filePath !== rootAbs && !filePath.startsWith(rootAbs + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const index = join(filePath, 'index.html');
    filePath = existsSync(index) && statSync(index).isFile() ? index : join(rootAbs, 'index.html');
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('not found — build the client first (npm run build)');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const noCache = ext === '.html' || filePath.endsWith('sw.js') || ext === '.webmanifest';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    // File vanished between stat and read (rebuild mid-request): end cleanly.
    res.destroy();
  });
  stream.pipe(res);
}
