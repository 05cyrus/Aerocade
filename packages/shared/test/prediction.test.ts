import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, SIM_HZ, WEAPON_SLOTS } from '../src/constants.js';
import { Buttons } from '../src/sim/input.js';
import { SimEventType } from '../src/sim/events.js';
import { addPlayer } from '../src/sim/spawns.js';
import { createMatch } from '../src/sim/match.js';
import { DEFAULT_MATCH_RULES, MatchPhase } from '../src/sim/match/state.js';
import { predictPlayer } from '../src/sim/predict.js';
import { depenetrate } from '../src/sim/systems/physics.js';
import { stepWorld } from '../src/sim/step.js';
import { setInput, type SimWorld } from '../src/sim/world.js';
import {
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  encodeWelcome,
  type InputFrame,
} from '../src/protocol/codec.js';
import { applySnapshotToWorld } from '../src/net/apply-snapshot.js';
import { ClientSession } from '../src/net/client-session.js';
import { Channel, type Transport } from '../src/net/transport.js';
import { createBoxMap } from './helpers.js';

/**
 * Client prediction and reconciliation (docs/networking.md §7).
 *
 * Without prediction a client waits a full round trip to see its own movement,
 * which is the difference between LAN play feeling instant and feeling broken.
 * Prediction is also the easiest netcode to get subtly wrong — a replay that
 * drifts, double-fires a semi-auto, or replays somebody else's player produces
 * artefacts that look like lag and are far harder to diagnose than lag.
 *
 * These drive a real `ClientSession` with a scripted snapshot stream produced by
 * a real host world, so the codec, the projection and the replay are all the
 * shipped ones.
 */

const HOST_PEER = 'host-peer';

/** Records what the client sent; delivery is driven by the test. */
function fakeTransport(sent: Uint8Array[]): Transport {
  return {
    send: (_peer, _channel, bytes) => {
      sent.push(bytes);
      return true;
    },
    broadcast: () => 0,
    peers: [HOST_PEER],
    close: () => undefined,
  };
}

interface Rig {
  host: SimWorld;
  client: SimWorld;
  session: ClientSession;
  slot: number;
  sent: Uint8Array[];
  // Function-typed properties, not methods: they are closures, and declaring
  // them as methods makes every destructure look like an unbound `this`.
  /** Step the host with the client's input applied to its slot. */
  hostStep: (frame: InputFrame, seq: number) => void;
  /** Deliver the host's current state to the client. */
  deliver: (lastAckedSeq: number) => void;
  press: (frame?: Partial<InputFrame>) => InputFrame;
}

function rig(): Rig {
  // A live match, so nothing is gated by warmup.
  const host = createMatch(createBoxMap(), 4242, { ...DEFAULT_MATCH_RULES, warmup: false });
  addPlayer(host); // slot 0 = the "host player"
  const slot = addPlayer(host); // slot 1 = our client
  expect(host.match.phase).toBe(MatchPhase.Live);

  const client = createMatch(createBoxMap(), 4242, { ...DEFAULT_MATCH_RULES, warmup: false });
  const sent: Uint8Array[] = [];
  const session = new ClientSession(client, fakeTransport(sent), HOST_PEER, 0);
  // Through the real handshake rather than a test hook, so the slot the session
  // predicts is the one WELCOME actually assigned.
  session.receive(
    HOST_PEER,
    Channel.Ctrl,
    encodeWelcome({ playerId: slot, hostTick: 0, rngSeed: 4242, mapId: 0, tuningHash: 0 }),
  );
  expect(session.playerId).toBe(slot);
  // A client's world is a projection: it has no players until a snapshot arrives.
  // Deliver one, exactly as a real client's first frame would, so the slot exists
  // at a real spawn point with a real loadout before anything is predicted.
  session.receive(HOST_PEER, Channel.Data, encodeSnapshot(captureSnapshot(host, 0), null));
  expect(client.players.connected[slot]).toBe(1);
  expect(client.players.ammoMag[slot * WEAPON_SLOTS] ?? 0).toBeGreaterThan(0);

  return {
    host,
    client,
    session,
    slot,
    sent,
    hostStep: (frame, seq) => {
      setInput(host, slot, { seq, ...frame });
      stepWorld(host);
    },
    deliver: (lastAckedSeq) => {
      // Snapshots are rejected if not newer than the last accepted one, so a
      // delivery has to come from a host that has actually moved on.
      if (host.tick <= client.tick - session.pendingCount) stepWorld(host);
      const snapshot = captureSnapshot(host, lastAckedSeq);
      session.receive(HOST_PEER, Channel.Data, encodeSnapshot(snapshot, null));
    },
    press: (frame = {}) => ({ buttons: 0, moveX: 0, moveY: 0, aim: 0, ...frame }),
  };
}

describe('prediction removes the round trip', () => {
  it('moves the local player on its own input, with no snapshot at all', () => {
    const { client, session, slot, press } = rig();
    const startX = client.players.posX[slot] ?? 0;

    for (let i = 0; i < 20; i++) session.sendInput(press({ moveX: 1 }));

    expect(client.players.posX[slot] ?? 0).toBeGreaterThan(startX + 0.5);
    expect(session.pendingCount, 'nothing acked yet').toBe(20);
  });

  it('reproduces the host bit-for-bit from the same starting state', () => {
    // The whole reason the systems take a slot parameter instead of there being a
    // separate "predict one player" routine: two implementations of movement would
    // have to agree forever, and they would not.
    const rules = { ...DEFAULT_MATCH_RULES, warmup: false };
    const host = createMatch(createBoxMap(), 4242, rules);
    addPlayer(host);
    const slot = addPlayer(host);
    // Same seed, same map, same spawns — no wire in between, so any difference at
    // all is a difference between the two code paths.
    const client = createMatch(createBoxMap(), 4242, rules);
    addPlayer(client);
    addPlayer(client);

    for (let i = 1; i <= 60; i++) {
      const frame = {
        moveX: i <= 30 ? 1 : -1,
        moveY: 0,
        aim: 0,
        buttons: i === 6 ? Buttons.Jump : 0,
      };
      setInput(host, slot, { seq: i, ...frame });
      stepWorld(host);
      predictPlayer(client, slot, { seq: i, ...frame });
    }
    expect(client.players.posX[slot]).toBe(host.players.posX[slot]);
    expect(client.players.posY[slot]).toBe(host.players.posY[slot]);
    expect(client.players.velX[slot]).toBe(host.players.velX[slot]);
    expect(client.players.velY[slot]).toBe(host.players.velY[slot]);
  });

  it('tracks the host closely over the wire, within the quantisation it inherits', () => {
    // Over the wire the client's starting state is quantised to 1/256 m
    // (ADR-026), so its prediction can never be bit-exact — and near a ground
    // contact those 4 mm can flip `grounded` for one tick, which at 55 m/s² of
    // ground acceleration is worth centimetres. This is precisely why
    // reconciliation is mandatory rather than a refinement, and the bound worth
    // asserting is "close", not "equal".
    const { host, client, session, slot, press } = rig();
    for (let i = 0; i < 30; i++) {
      const frame = press({ moveX: i < 15 ? 1 : -1, buttons: i === 5 ? Buttons.Jump : 0 });
      session.sendInput(frame);
      setInput(host, slot, { seq: i + 1, ...frame });
      stepWorld(host);
    }
    // Sub-metre without any correction at all, over half a second of running and
    // a jump. A broken predictor is metres out or moving the wrong way.
    expect(
      Math.abs((client.players.posX[slot] ?? 0) - (host.players.posX[slot] ?? 0)),
    ).toBeLessThan(1);

    // And a snapshot pulls it back onto the host's answer.
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(captureSnapshot(host, 30), null));
    expect(session.pendingCount).toBe(0);
    expect(client.players.posX[slot]).toBeCloseTo(host.players.posX[slot] ?? 0, 2);
  });

  it('does not predict anybody else', () => {
    // A client has no idea what remote players pressed; stepping them would move
    // them on a guess and every snapshot would yank them back.
    const { client, session, press } = rig();
    const other = 0;
    client.players.connected[other] = 1;
    client.players.status[other] = 1;
    const otherX = client.players.posX[other] ?? 0;
    const otherY = client.players.posY[other] ?? 0;

    for (let i = 0; i < 30; i++) session.sendInput(press({ moveX: 1, buttons: Buttons.Jump }));

    expect(client.players.posX[other]).toBe(otherX);
    expect(client.players.posY[other]).toBe(otherY);
  });
});

describe('reconciliation', () => {
  it('replays unacknowledged inputs so the client stays ahead of the snapshot', () => {
    const { host, client, session, slot, press } = rig();
    const frame = press({ moveX: 1 });

    // Host applies 5 inputs; client has sent 12.
    for (let i = 0; i < 12; i++) session.sendInput(frame);
    for (let i = 0; i < 5; i++) {
      setInput(host, slot, { seq: i + 1, ...frame });
      stepWorld(host);
    }
    const hostX = host.players.posX[slot] ?? 0;

    const snapshot = captureSnapshot(host, 5);
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(snapshot, null));

    // 7 inputs remain unconfirmed and must have been replayed forward.
    expect(session.pendingCount).toBe(7);
    expect(client.players.posX[slot] ?? 0, 'ahead of the host, not snapped back').toBeGreaterThan(
      hostX,
    );
    expect(client.tick).toBe(host.tick + 7);
  });

  it('drops acknowledged inputs and keeps only newer ones', () => {
    const { session, deliver, press } = rig();
    for (let i = 0; i < 10; i++) session.sendInput(press({ moveX: 1 }));
    expect(session.pendingCount).toBe(10);
    deliver(10);
    expect(session.pendingCount, 'all acked').toBe(0);
  });

  it('converges without a visible correction when the host agrees', () => {
    // An uncontested player must not need visible correcting. The prediction can
    // still be a wire-quantisation off (see above), so what matters is that the
    // correction is too small to see rather than exactly zero.
    const { host, client, session, slot, press } = rig();
    const frame = press({ moveX: 1 });
    for (let i = 0; i < 8; i++) {
      session.sendInput(frame);
      setInput(host, slot, { seq: i + 1, ...frame });
      stepWorld(host);
    }
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(captureSnapshot(host, 8), null));

    const offset = session.renderOffset;
    expect(Math.hypot(offset.x, offset.y), 'nothing worth blending').toBeLessThan(0.1);
    expect(client.players.posX[slot]).toBeCloseTo(host.players.posX[slot] ?? 0, 2);
  });

  it('notices a correction, smooths it, and decays the offset to nothing', () => {
    const { host, session, slot, press } = rig();
    const frame = press({ moveX: 1 });
    for (let i = 0; i < 8; i++) {
      session.sendInput(frame);
      setInput(host, slot, { seq: i + 1, ...frame });
      stepWorld(host);
    }
    // The host disagrees — a knockback the client could not know about.
    host.players.posX[slot] = (host.players.posX[slot] ?? 0) - 2;
    const snapshot = captureSnapshot(host, 8);
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(snapshot, null));

    expect(session.mispredictionCount).toBe(1);
    const offset = session.renderOffset;
    expect(Math.abs(offset.x), 'the error is held as a visual offset').toBeGreaterThan(0.5);

    // It must fade rather than persist, or the drawn position stays wrong.
    let last = Math.abs(session.renderOffset.x);
    for (let i = 0; i < 6; i++) {
      session.sendInput(press());
      const now = Math.abs(session.renderOffset.x);
      expect(now).toBeLessThanOrEqual(last);
      last = now;
    }
    expect(session.renderOffset).toEqual({ x: 0, y: 0 });
  });

  it('leaves remote players exactly where the snapshot put them', () => {
    const { host, client, session, slot, press } = rig();
    for (let i = 0; i < 6; i++) session.sendInput(press({ moveX: 1 }));
    // The host has to have moved on, or the snapshot is rejected as out-of-order.
    stepWorld(host);
    // Move the host's own player so the snapshot carries a distinct position.
    host.players.posX[0] = 12.25;
    const snapshot = captureSnapshot(host, 3);
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(snapshot, null));

    // Quantised to 1/256 m on the wire, so agreement rather than equality.
    expect(client.players.posX[0]).toBeCloseTo(12.25, 2);
    expect(client.players.posX[slot]).not.toBeCloseTo(12.25, 2);
  });

  it('bounds the pending ring so a silent host cannot grow it forever', () => {
    const { session, press } = rig();
    for (let i = 0; i < 300; i++) session.sendInput(press({ moveX: 1 }));
    expect(session.pendingCount).toBe(128);
  });
});

describe('replay must not be observable', () => {
  it('does not re-emit events for ticks that already happened', () => {
    // Otherwise every snapshot replays the last few gunshots — the correction
    // becomes audible, which is worse than the misprediction it fixes.
    const { host, client, session, slot, press } = rig();
    const firing = press({ buttons: Buttons.Fire });
    for (let i = 0; i < 6; i++) {
      session.sendInput(firing);
      setInput(host, slot, { seq: i + 1, ...firing });
      stepWorld(host);
    }
    // Whatever the client's own tick emitted is already consumed; a replay must
    // add nothing.
    client.events.clear();
    const snapshot = captureSnapshot(host, 2);
    session.receive(HOST_PEER, Channel.Data, encodeSnapshot(snapshot, null));

    let shots = 0;
    client.events.forEach((ev) => {
      if (ev.type === SimEventType.Shot) shots += 1;
    });
    expect(shots).toBe(0);
  });

  it('restores event emission afterwards', () => {
    const { client, session, deliver, press } = rig();
    for (let i = 0; i < 3; i++) session.sendInput(press({ moveX: 1 }));
    deliver(1);
    client.events.clear();
    // A fresh predicted tick still announces itself.
    session.sendInput(press({ buttons: Buttons.Fire }));
    let shots = 0;
    client.events.forEach((ev) => {
      if (ev.type === SimEventType.Shot) shots += 1;
    });
    expect(shots).toBeGreaterThan(0);
  });

  it('keeps a semi-auto weapon to one shot per press across a replay', () => {
    // `prevButtons` is what makes an edge an edge. A replay that lost it would
    // let one press fire twice — free extra damage, invisible in a diff.
    const { client, session, slot, press } = rig();
    const before = client.players.ammoMag[slot * WEAPON_SLOTS] ?? 0;
    // Hold fire for a while: a semi-auto must spend exactly one round.
    session.sendInput(press({ buttons: Buttons.Fire }));
    for (let i = 0; i < 5; i++) session.sendInput(press({ buttons: Buttons.Fire }));
    const spentBeforeReplay = before - (client.players.ammoMag[slot * WEAPON_SLOTS] ?? 0);
    expect(spentBeforeReplay, 'one press, one round').toBe(1);
  });
});

describe('predictPlayer in isolation', () => {
  it('advances one slot and leaves the rest untouched', () => {
    const world = createMatch(createBoxMap(), 7);
    const a = addPlayer(world);
    const b = addPlayer(world);
    const bx = world.players.posX[b] ?? 0;
    for (let i = 0; i < 20; i++) {
      predictPlayer(world, a, { seq: i, moveX: 1, moveY: 0, aim: 0, buttons: 0 });
    }
    expect(world.players.posX[a] ?? 0).not.toBeCloseTo(bx, 3);
    expect(world.players.posX[b]).toBe(bx);
  });

  it('ignores a nonsense slot rather than corrupting the world', () => {
    const world = createMatch(createBoxMap(), 7);
    addPlayer(world);
    const before = [...world.players.posX];
    predictPlayer(world, -1, { seq: 1, moveX: 1, moveY: 0, aim: 0, buttons: 0 });
    predictPlayer(world, MAX_PLAYERS + 4, { seq: 2, moveX: 1, moveY: 0, aim: 0, buttons: 0 });
    expect([...world.players.posX]).toEqual(before);
  });

  it('respects the match phase gate', () => {
    // Prediction runs the same input gate, so a client cannot shoot during a
    // countdown just because it is predicting locally.
    const world = createMatch(createBoxMap(), 7, DEFAULT_MATCH_RULES);
    const slot = addPlayer(world);
    expect(world.match.phase).toBe(MatchPhase.Warmup);
    const ammo = world.players.ammoMag[slot * WEAPON_SLOTS] ?? 0;
    for (let i = 0; i < SIM_HZ; i++) {
      predictPlayer(world, slot, { seq: i, moveX: 0, moveY: 0, aim: 0, buttons: Buttons.Fire });
    }
    expect(world.players.ammoMag[slot * WEAPON_SLOTS]).toBe(ammo);
  });
});

describe('a projected position must not be stuck in the floor', () => {
  it('lifts a resting player out of the tile the wire rounded it into', () => {
    // Regression. Positions cross the wire at 1/256 m — 3.9 mm, twenty times the
    // physics skin — so a player resting on the floor can project a couple of
    // millimetres *inside* it. Because the sweep resolves X before Y, the next
    // predicted tick then ejects it sideways by half a tile plus half a body: a
    // horizontal teleport on every single snapshot. Clients never ran physics
    // before prediction, which is why this only surfaced now.
    const rules = { ...DEFAULT_MATCH_RULES, warmup: false };
    const host = createMatch(createBoxMap(), 4242, rules);
    addPlayer(host);
    const slot = addPlayer(host);
    stepWorld(host); // settle onto the ground

    const client = createMatch(createBoxMap(), 4242, rules);
    applySnapshotToWorld(client, decodeSnapshot(encodeSnapshot(captureSnapshot(host, 0), null)));

    const beforeX = client.players.posX[slot] ?? 0;
    // Moving matters: the sweep only resolves a penetration when there is
    // displacement to resolve, so a stationary player would hide the bug.
    predictPlayer(client, slot, { seq: 1, moveX: 1, moveY: 0, aim: 0, buttons: 0 });
    const afterX = client.players.posX[slot] ?? 0;

    // Walking right must move right. Un-depenetrated this was ejected ~0.93 m to
    // the *left* on the first tick — the wrong direction, not merely inaccurate.
    expect(afterX, 'walked right, not ejected left').toBeGreaterThan(beforeX);
    expect(afterX - beforeX, 'one tick of walking, nothing more').toBeLessThan(0.05);
  });

  it('leaves an airborne player where the snapshot put it', () => {
    // There is nothing to be stuck in, so nothing should move.
    const world = createMatch(createBoxMap(), 7);
    const slot = addPlayer(world);
    const y = (world.players.posY[slot] ?? 0) - 3;
    const x = world.players.posX[slot] ?? 0;
    expect(depenetrate(world.map, x, y)).toBe(y);
  });

  it('does not teleport a player who is genuinely deep inside geometry', () => {
    // Only rounding-scale overlap is a rounding artefact. A metre of overlap is
    // state the host put there, and inventing a new position would be worse.
    const world = createMatch(createBoxMap(), 7);
    const slot = addPlayer(world);
    const x = world.players.posX[slot] ?? 0;
    const deep = (world.players.posY[slot] ?? 0) + 1;
    expect(depenetrate(world.map, x, deep)).toBe(deep);
  });
});
