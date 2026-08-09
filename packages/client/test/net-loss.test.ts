import { describe, expect, it, vi } from 'vitest';
import { appStore } from '../src/app/store.js';
import { lossLatch, type NetHandle } from '../src/game/net/netplay.js';

/**
 * A LAN match can end without anyone asking: the host quits, Wi-Fi drops, or the
 * bridge terminates a peer that stopped answering its heartbeat. A client never
 * steps its own world, so it has nothing that would notice — the match simply
 * freezes. These tests pin the path that turns that silence into a message.
 */

/** A handle that records what the store does to it, with no network at all. */
function fakeHandle(): NetHandle & { closes: number; lose: (reason: string) => void } {
  const latch = lossLatch();
  const handle = {
    kind: 'client' as const,
    world: {} as NetHandle['world'],
    localPlayer: 1,
    drivesSimulation: false,
    room: null,
    tick: () => undefined,
    playerCount: () => 2,
    nameOf: () => null,
    renderOffset: () => ({ x: 0, y: 0 }),
    hostPlayer: 0,
    startMatch: () => undefined,
    onLost: latch.onLost,
    closes: 0,
    lose: latch.lose,
    close: () => {
      handle.closes += 1;
    },
  };
  return handle;
}

describe('loss latch', () => {
  it('tells a listener that subscribed before the loss', () => {
    const latch = lossLatch();
    const seen: string[] = [];
    latch.onLost((r) => seen.push(r));
    latch.lose('socket died');
    expect(seen).toEqual(['socket died']);
  });

  it('tells a listener that subscribed after the loss', () => {
    // The join handshake can resolve a tick after the socket dies, so the store
    // subscribes to an already-lost match. Dropping that notification would
    // strand the player in a frozen world.
    const latch = lossLatch();
    latch.lose('host left');
    const seen: string[] = [];
    latch.onLost((r) => seen.push(r));
    expect(seen).toEqual(['host left']);
  });

  it('reports one loss, not one per event', () => {
    // A dropped socket also closes the room: two callbacks, one thing happened.
    const latch = lossLatch();
    const seen: string[] = [];
    latch.onLost((r) => seen.push(r));
    latch.lose('lost the connection to the host');
    latch.lose('the host ended the match');
    expect(seen).toEqual(['lost the connection to the host']);
  });
});

describe('store: a match that ends on its own', () => {
  it('surfaces the reason and keeps the handle so the world stays on screen', () => {
    const handle = fakeHandle();
    appStore.startNetMatch(handle);
    expect(appStore.getState().netError).toBeNull();

    handle.lose('the host ended the match');
    expect(appStore.getState().netError).toBe('the host ended the match');
    // Deliberately still open: dismissing is what releases the socket, so the
    // last known frame is still there to look at.
    expect(handle.closes).toBe(0);
    expect(appStore.getState().screen).toBe('net');

    appStore.endNetMatch();
    expect(handle.closes).toBe(1);
    expect(appStore.getState().netError).toBeNull();
    expect(appStore.getState().net).toBeNull();
    expect(appStore.getState().screen).toBe('menu');
  });

  it('starting a new match clears a previous match’s notice', () => {
    const first = fakeHandle();
    appStore.startNetMatch(first);
    first.lose('lost the connection to the bridge');
    expect(appStore.getState().netError).not.toBeNull();

    appStore.startNetMatch(fakeHandle());
    expect(appStore.getState().netError).toBeNull();
    appStore.endNetMatch();
  });

  it('ignores a loss from a match the player already left', () => {
    // The socket's close event can land after the player hit "Leave", and a
    // notice over the main menu would be nonsense.
    const handle = fakeHandle();
    appStore.startNetMatch(handle);
    appStore.endNetMatch();
    handle.lose('lost the connection to the host');
    expect(appStore.getState().netError).toBeNull();
    expect(appStore.getState().screen).toBe('menu');
  });

  it('notifies subscribers so the notice actually renders', () => {
    const handle = fakeHandle();
    appStore.startNetMatch(handle);
    const listener = vi.fn();
    const unsubscribe = appStore.subscribe(listener);
    handle.lose('lost the connection to the host');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    appStore.endNetMatch();
  });
});
