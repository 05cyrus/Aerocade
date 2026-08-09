import { describe, expect, it } from 'vitest';
import { DEV_BRIDGE_PORT, resolveBridgeUrl, type BridgeLocation } from '../src/game/net/netplay.js';

/**
 * Where the client looks for the bridge.
 *
 * This got its own tests because getting it wrong produces the least helpful
 * failure in the game: dialling the Vite dev server, which *accepts* the
 * WebSocket upgrade and then never answers the `hello`, so hosting hangs for
 * eight seconds and reports a handshake timeout. A wrong address that refuses the
 * connection would at least fail immediately.
 */

const location = (over: Partial<BridgeLocation> = {}): BridgeLocation => ({
  search: '',
  host: 'localhost:8080',
  hostname: 'localhost',
  protocol: 'http:',
  dev: false,
  ...over,
});

describe('resolveBridgeUrl', () => {
  it('uses the page origin in production, because the bridge served the page', () => {
    expect(
      resolveBridgeUrl(location({ host: '192.168.1.42:8080', hostname: '192.168.1.42' })),
    ).toBe('ws://192.168.1.42:8080/ws');
  });

  it('guesses the bridge port in a dev build, not the dev server', () => {
    // The dev page is served by Vite on 5173; the bridge is never there.
    const url = resolveBridgeUrl(
      location({ dev: true, host: 'localhost:5173', hostname: 'localhost' }),
    );
    expect(url).toBe(`ws://localhost:${String(DEV_BRIDGE_PORT)}/ws`);
    expect(url, 'never the dev server').not.toContain('5173');
  });

  it('keeps the hostname when guessing, so a phone on the LAN still works', () => {
    expect(
      resolveBridgeUrl(
        location({ dev: true, host: '192.168.1.42:5173', hostname: '192.168.1.42' }),
      ),
    ).toBe(`ws://192.168.1.42:${String(DEV_BRIDGE_PORT)}/ws`);
  });

  it('lets ?bridge= win over everything', () => {
    for (const dev of [true, false]) {
      expect(
        resolveBridgeUrl(
          location({ dev, search: '?bridge=10.0.0.5:9000', host: 'localhost:5173' }),
        ),
      ).toBe('ws://10.0.0.5:9000/ws');
    }
  });

  it('ignores an empty ?bridge= rather than dialling "/ws"', () => {
    expect(resolveBridgeUrl(location({ search: '?bridge=' }))).toBe('ws://localhost:8080/ws');
  });

  it('upgrades to wss on an https page', () => {
    expect(resolveBridgeUrl(location({ protocol: 'https:', host: 'aero.local' }))).toBe(
      'wss://aero.local/ws',
    );
  });

  it('matches the bridge default in packages/server/src/main.ts', () => {
    // If the server's default moves, this must move with it or dev hosting breaks.
    expect(DEV_BRIDGE_PORT).toBe(8080);
  });
});
