import {
  addPlayer,
  assignTeam,
  BridgeClient,
  Channel,
  ClientSession,
  createMapById,
  createMatch,
  createWorld,
  DEFAULT_MATCH_RULES,
  HostSession,
  isMapId,
  MAP_IDS,
  RelayTransport,
  TUNING,
  tuningHash,
  WEAPON_COUNT,
  weaponDef,
  type MapId,
  type RoomInfo,
  type SimWorld,
  type SocketCallbacks,
  type SocketLike,
  type WeaponId,
} from '@aerocade/shared';

/**
 * Browser side of LAN play: bridge connection, transport, and session, reduced to
 * one small handle the game loop can drive.
 *
 * `GameSession` deliberately learns nothing about netcode beyond `NetHandle` —
 * whether it is hosting, joining, or offline is three fields, so the sandbox path
 * stays exactly as it was.
 */

/** Hash of everything host and client must agree on (ADR-026). */
export const LOCAL_TUNING_HASH = tuningHash(
  TUNING,
  Array.from({ length: WEAPON_COUNT }, (_, i) => weaponDef(i as WeaponId)),
);

/**
 * The bridge's default port, matching `PORT ?? 8080` in packages/server/src/main.ts.
 * Only used to guess in development; a production page is served by the bridge
 * itself and uses its own origin.
 */
export const DEV_BRIDGE_PORT = 8080;

export interface BridgeLocation {
  /** `window.location.search`, for the `?bridge=` override. */
  search: string;
  /** `window.location.host` — hostname plus port. */
  host: string;
  /** `window.location.hostname` — no port. */
  hostname: string;
  /** `window.location.protocol`. */
  protocol: string;
  /** True in a Vite dev build. */
  dev: boolean;
}

/**
 * Work out where the bridge is.
 *
 * Three cases, in priority order:
 *
 * 1. **`?bridge=host:port` wins**, always. It is how a page served from anywhere
 *    reaches a bridge somewhere else, and how the e2e tests point a dev page at a
 *    real bridge.
 * 2. **In a dev build, guess the bridge's default port on this hostname.** The page
 *    is served by Vite, never by the bridge, so its own origin is the one place the
 *    bridge certainly is not — and dialling it produces a *worse* failure than no
 *    bridge at all: Vite accepts the WebSocket upgrade and then never answers the
 *    `hello`, so hosting sat there for eight seconds and reported "bridge handshake
 *    timed out". Guessing 8080 makes `npm run dev` work as soon as the bridge runs.
 * 3. **Otherwise the page's own origin**, because a production PWA is served *by*
 *    the bridge — same host, same port, `/ws`.
 */
export function resolveBridgeUrl(location: BridgeLocation): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const override = new URLSearchParams(location.search).get('bridge');
  if (override !== null && override !== '') return `${scheme}://${override}/ws`;
  const host = location.dev ? `${location.hostname}:${String(DEV_BRIDGE_PORT)}` : location.host;
  return `${scheme}://${host}/ws`;
}

/** `resolveBridgeUrl` against the real page location. */
export function bridgeUrl(): string {
  return resolveBridgeUrl({
    search: window.location.search,
    host: window.location.host,
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    dev: import.meta.env.DEV,
  });
}

/** Adapt the browser WebSocket to the injected socket contract. */
export function browserSocketFactory(url: string, callbacks: SocketCallbacks): SocketLike {
  const ws = new WebSocket(url);
  ws.onopen = () => {
    callbacks.onOpen();
  };
  ws.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') callbacks.onMessage(event.data);
  };
  ws.onclose = () => {
    callbacks.onClose();
  };
  ws.onerror = (event) => {
    callbacks.onError(event);
  };
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

export interface NetInput {
  moveX: number;
  moveY: number;
  aim: number;
  buttons: number;
}

/**
 * What the game loop needs to know about a networked match.
 *
 * `drivesSimulation` is the important one: a host steps the world, a client must
 * **not**. A client that also stepped would fight every arriving snapshot and
 * produce jitter indistinguishable from packet loss.
 */
export interface NetHandle {
  readonly kind: 'host' | 'client';
  readonly world: SimWorld;
  readonly localPlayer: number;
  readonly drivesSimulation: boolean;
  readonly room: RoomInfo | null;
  /** Called once per sim tick with the local player's input. */
  tick(input: NetInput): void;
  /** Players currently in the match, for the lobby/HUD. */
  playerCount(): number;
  /**
   * The name the host published for a slot, or null if it has not.
   *
   * Names are not simulated (docs/ecs.md), so they arrive on their own message
   * rather than in a snapshot — which means the scoreboard can show a real name
   * instead of "Player 2" without spending a kilobyte a second repeating it.
   */
  nameOf(slot: number): string | null;
  /**
   * Render-only offset for the local player, blending away a prediction
   * correction. Zero on a host, and zero on a client whose prediction was right.
   */
  renderOffset(): { x: number; y: number };
  /**
   * Register the listener told when the match ends on its own — the socket
   * dropped, or the host left. Without this a dead connection presents as a
   * frozen world with no explanation, which is the worst failure mode available:
   * a client stops stepping by design, so there is nothing else to notice it.
   */
  onLost(listener: (reason: string) => void): void;
  close(): void;
}

/**
 * One-shot loss latch shared by both match kinds. One-shot because a dropped
 * socket also closes the room: two events, one thing that happened.
 */
export function lossLatch(): {
  lose: (reason: string) => void;
  onLost: (listener: (reason: string) => void) => void;
} {
  let listener: ((reason: string) => void) | null = null;
  let reason: string | null = null;
  return {
    lose: (why) => {
      if (reason !== null) return;
      reason = why;
      listener?.(why);
    },
    // A loss can land before anyone subscribes (the handshake resolves a tick
    // after the socket dies), so a late listener is told immediately.
    onLost: (next) => {
      listener = next;
      if (reason !== null) next(reason);
    },
  };
}

/** Create a room and host it. The host plays; it is not a spectating server. */
export async function hostMatch(mapId: MapId, playerName: string): Promise<NetHandle> {
  const seed = Date.now() >>> 0;
  // A real match, not the sandbox: countdown, clock and frag limit. The sandbox
  // default would give a LAN game no way to end (ADR-031).
  const world = createMatch(createMapById(mapId), seed, DEFAULT_MATCH_RULES);
  const localPlayer = addPlayer(world);
  assignTeam(world, localPlayer);

  let session: HostSession | null = null;
  const loss = lossLatch();
  const bridge = new BridgeClient(bridgeUrl(), browserSocketFactory, {
    onRelay: (from, bytes) => {
      transport.acceptRelay(from, bytes);
    },
    onPeerLeft: (peerId) => {
      // Both halves matter: the session frees the player slot, the transport
      // stops broadcasting to a peer that has gone.
      session?.dropPeer(peerId);
      transport.peerDown(peerId);
    },
    // A host's own room closing is its own doing, so only the socket counts here.
    onDisconnected: () => {
      loss.lose('lost the connection to the LAN bridge');
    },
  });
  await bridge.connect();
  const room = await bridge.createRoom(`${playerName}'s game`, playerName, 'ffa', mapId);

  const transport = new RelayTransport(bridge, {
    onFrame: (peer, channel, bytes) => {
      session?.receive(peer, channel, bytes);
    },
  });
  // Index into MAP_IDS rather than a placeholder: WELCOME carries a numeric map
  // id, and shipping a constant 0 would name the wrong map the moment a client
  // trusted it.
  const mapIndex = Math.max(0, MAP_IDS.indexOf(mapId));
  const host = new HostSession(world, transport, localPlayer, LOCAL_TUNING_HASH, mapIndex, seed, {
    onPlayerJoined: (peerId) => {
      transport.peerUp(peerId);
    },
  });
  session = host;
  // The host never sends itself a JOIN_REQ, so it has to name itself.
  host.setName(localPlayer, playerName);
  return {
    kind: 'host',
    world,
    localPlayer,
    drivesSimulation: true,
    room,
    tick: (input) => {
      host.tick(input);
    },
    playerCount: () => host.playerCount,
    nameOf: (slot) => host.nameOf(slot),
    // A host predicts nothing: its own simulation is the answer.
    renderOffset: () => ({ x: 0, y: 0 }),
    onLost: loss.onLost,
    close: () => {
      bridge.leaveRoom();
      bridge.close();
    },
  };
}

export interface JoinResult {
  handle: NetHandle;
}

/**
 * Join a room and complete the handshake **before** returning.
 *
 * The player's slot only exists once WELCOME arrives, and the renderer is built
 * around a known local player id, so entering the scene first would mean
 * rendering a match with no idea which soldier is yours.
 */
export async function joinMatch(
  room: RoomInfo,
  playerName: string,
  timeoutMs = 8000,
): Promise<JoinResult> {
  if (!isMapId(room.mapId)) throw new Error(`host is on an unknown map: ${room.mapId}`);
  // Seeded from the host's map; the client never simulates, so the seed only has
  // to exist, not match — snapshots overwrite everything that matters.
  const world = createWorld(createMapById(room.mapId), 0);

  let session: ClientSession | null = null;
  const loss = lossLatch();
  const bridge = new BridgeClient(bridgeUrl(), browserSocketFactory, {
    onRelay: (from, bytes) => {
      // Routed only through the transport, which strips the channel tag; calling
      // the session directly here would deliver every frame twice.
      transport.acceptRelay(from, bytes);
    },
    onDisconnected: () => {
      loss.lose('lost the connection to the host');
    },
    onRoomClosed: () => {
      loss.lose('the host ended the match');
    },
  });
  await bridge.connect();
  const joined = await bridge.joinRoom(room.id, playerName);

  const transport = new RelayTransport(bridge, {
    onFrame: (peer, channel, bytes) => {
      session?.receive(peer, channel, bytes);
    },
  });
  transport.peerUp(joined.hostPeerId);

  // A deferred rather than work inside the Promise executor: the session has to
  // exist before it can be handed the resolve callbacks, and TypeScript cannot
  // see assignments made inside an executor.
  let settleWelcome: ((playerId: number) => void) | null = null;
  let failWelcome: ((error: Error) => void) | null = null;
  const welcomed = new Promise<number>((resolve, reject) => {
    settleWelcome = resolve;
    failWelcome = reject;
  });

  const client = new ClientSession(world, transport, joined.hostPeerId, LOCAL_TUNING_HASH, {
    onWelcome: (playerId) => {
      settleWelcome?.(playerId);
    },
    onVersionMismatch: () => {
      failWelcome?.(new Error('version mismatch — reload the page from the host'));
    },
  });
  session = client;

  const timer = setTimeout(() => {
    failWelcome?.(new Error('host did not answer the join request'));
  }, timeoutMs);
  // Losing the socket mid-handshake is not worth waiting the full timeout for;
  // the player should be told which of the two things went wrong.
  loss.onLost((reason) => {
    failWelcome?.(new Error(reason));
  });
  // Retried because the request rides the relay and can be lost; the host treats
  // a repeat as idempotent, so it cannot cost a second slot (ADR-028).
  const retry = setInterval(() => {
    client.requestJoin(playerName);
  }, 1000);
  client.requestJoin(playerName);

  let localPlayer: number;
  try {
    localPlayer = await welcomed;
  } finally {
    clearInterval(retry);
    clearTimeout(timer);
  }

  return {
    handle: {
      kind: 'client',
      world,
      localPlayer,
      // A client never steps: snapshots are the authority (ADR-028).
      drivesSimulation: false,
      room: joined.room,
      tick: (input) => {
        client.sendInput({
          buttons: input.buttons,
          moveX: input.moveX,
          moveY: input.moveY,
          aim: input.aim,
        });
      },
      playerCount: () => {
        let count = 0;
        for (const connected of world.players.connected) if (connected === 1) count += 1;
        return count;
      },
      nameOf: (slot) => client.nameOf(slot),
      renderOffset: () => client.renderOffset,
      onLost: loss.onLost,
      close: () => {
        bridge.leaveRoom();
        bridge.close();
      },
    },
  };
}

/** Connect just far enough to list rooms, for the join screen. */
export async function browseRooms(): Promise<{ rooms: RoomInfo[]; close: () => void }> {
  const bridge = new BridgeClient(bridgeUrl(), browserSocketFactory);
  await bridge.connect();
  const rooms = await bridge.listRooms();
  return {
    rooms,
    close: () => {
      bridge.close();
    },
  };
}

export { Channel };
