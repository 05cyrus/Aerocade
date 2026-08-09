import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  assertEncodable,
  captureSnapshot,
  addPlayer,
  createMapById,
  createMatch,
  decodeAim,
  decodeInput,
  decodeJoinRequest,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeAim,
  encodeInput,
  encodeJoinRequest,
  encodePos,
  encodeRoster,
  encodeSnapshot,
  encodeVel,
  encodeWelcome,
  INPUT_BYTES,
  KEYFRAME,
  MAP_IDS,
  MsgId,
  peekMsgId,
  PlayerFlag,
  POSITION_MAX_M,
  PROTOCOL_VERSION,
  setInput,
  stepWorld,
  TUNING,
  tuningHash,
  VELOCITY_MAX_MS,
  weaponDef,
  WeaponId,
  type WireSnapshot,
} from '../src/index.js';

/**
 * The netcode's foundation. ADR-010 has listed "snapshot round-trips" as a test
 * target since M0 — prediction, reconciliation and interpolation are all
 * meaningless if a snapshot does not survive the wire, and a quantization bug
 * here looks like lag or cheating rather than like a bug.
 */

describe('quantization', () => {
  it('round-trips a position to within half a step', () => {
    for (const metres of [0, 0.5, 1, 12.34, 91.5, 179.99, 255.9]) {
      const back = encodePos(metres) / 256;
      expect(Math.abs(back - metres), `${String(metres)} m`).toBeLessThanOrEqual(1 / 512);
    }
  });

  it('clamps rather than wrapping past the ceiling', () => {
    // Wrapping would teleport a player across the map with no error anywhere,
    // which is the single worst failure this format can have.
    expect(encodePos(POSITION_MAX_M + 50)).toBe(65535);
    expect(encodePos(-5)).toBe(0);
  });

  it('covers every registered map', () => {
    for (const id of MAP_IDS) {
      const map = createMapById(id);
      expect(() => {
        assertEncodable(map.width, map.height);
      }, id).not.toThrow();
    }
  });

  it('rejects a map beyond the ceiling instead of silently wrapping', () => {
    expect(() => {
      assertEncodable(300, 100);
    }).toThrow(/quantization ceiling/);
  });

  it('has real headroom over the sim speed cap', () => {
    // hardSpeedCap is what knockback stacking can reach; the wire must exceed it
    // or a rocket hit would encode as a slower shove than it was.
    expect(VELOCITY_MAX_MS).toBeGreaterThan(TUNING.player.hardSpeedCap);
    expect(encodeVel(TUNING.player.hardSpeedCap) / 256).toBeCloseTo(TUNING.player.hardSpeedCap, 2);
  });

  it('round-trips aim finely enough for the longest shot', () => {
    // The Longbolt reaches 70 m, so an angular error of e must keep 70·e well
    // under a player's 0.85 m width or long shots would visibly miss.
    // Compared as a shortest arc, because -pi and +pi are the same heading yet
    // differ by 2pi as plain numbers — a naive subtraction reports a full turn
    // of "error" for a perfect round trip.
    const arc = (a: number, b: number): number => {
      const d = Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      return d;
    };
    const worst = Math.max(
      ...[-Math.PI, -1.2, 0, 0.0001, 1.5707, 3.14159].map((a) => arc(decodeAim(encodeAim(a)), a)),
    );
    expect(worst * weaponDef(WeaponId.LongboltRifle).range).toBeLessThan(0.05);
  });

  it('wraps aim instead of clamping it', () => {
    // Angles arrive from atan2 in −π..π but also accumulate past a turn; a clamp
    // would peg the soldier at one extreme instead of coming round.
    expect(decodeAim(encodeAim(Math.PI * 2 + 0.3))).toBeCloseTo(0.3, 3);
    expect(decodeAim(encodeAim(-Math.PI * 2 - 0.3))).toBeCloseTo(-0.3, 3);
  });

  it('survives non-finite input rather than producing NaN bytes', () => {
    expect(encodePos(NaN)).toBe(0);
    expect(encodeVel(Infinity)).toBe(0);
    expect(encodeAim(NaN)).toBe(0);
  });
});

describe('C2H_INPUT', () => {
  const packet = {
    seq: 4321,
    clientTick: 987654,
    ackTick: 987600,
    frames: [
      { buttons: 0b1010_1010, moveX: 1, moveY: -1, aim: 1.25 },
      { buttons: 0b0101, moveX: -0.5, moveY: 0, aim: -2.5 },
      { buttons: 0, moveX: 0, moveY: 1, aim: 3.1 },
    ],
  };

  it('is the size the spec budgets', () => {
    expect(encodeInput(packet)).toHaveLength(INPUT_BYTES);
    expect(INPUT_BYTES).toBe(29);
  });

  it('round-trips header fields exactly', () => {
    const back = decodeInput(encodeInput(packet));
    expect(back.seq).toBe(packet.seq);
    expect(back.clientTick).toBe(packet.clientTick);
    expect(back.ackTick).toBe(packet.ackTick);
  });

  it('round-trips all three frames', () => {
    const back = decodeInput(encodeInput(packet));
    expect(back.frames).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const sent = packet.frames[i];
      const got = back.frames[i];
      if (sent === undefined || got === undefined) throw new Error('missing frame');
      expect(got.buttons, `frame ${String(i)} buttons`).toBe(sent.buttons);
      expect(got.moveX, `frame ${String(i)} moveX`).toBeCloseTo(sent.moveX, 2);
      expect(got.moveY, `frame ${String(i)} moveY`).toBeCloseTo(sent.moveY, 2);
      expect(got.aim, `frame ${String(i)} aim`).toBeCloseTo(sent.aim, 3);
    }
  });

  it('pads redundancy with the newest frame on a fresh connection', () => {
    // Fixed size means the reader never branches on how much history exists.
    const newest = packet.frames[0];
    if (newest === undefined) throw new Error('fixture is missing its newest frame');
    const fresh = encodeInput({ seq: 1, clientTick: 1, ackTick: 0, frames: [newest] });
    expect(fresh).toHaveLength(INPUT_BYTES);
    const back = decodeInput(fresh);
    expect(back.frames[1]?.buttons).toBe(newest.buttons);
  });

  it('wraps seq at 16 bits rather than corrupting the frame', () => {
    const back = decodeInput(encodeInput({ ...packet, seq: 70000 }));
    expect(back.seq).toBe(70000 & 0xffff);
  });

  it('rejects a truncated packet and a foreign message', () => {
    expect(() => decodeInput(new Uint8Array(4))).toThrow(/too short/);
    const wrong = encodeInput(packet);
    wrong[0] = MsgId.Snapshot;
    expect(() => decodeInput(wrong)).toThrow(/not an input/);
  });

  it('is identified by peekMsgId without decoding', () => {
    expect(peekMsgId(encodeInput(packet))).toBe(MsgId.Input);
    expect(peekMsgId(new Uint8Array(0))).toBeNull();
  });
});

describe('H2C_SNAPSHOT', () => {
  /** A world that has actually run, so it holds real state rather than zeros. */
  function liveWorld(ticks: number) {
    const world = createMatch(createMapById('hollow_works'), 99);
    // createMatch builds an empty match; slots only exist once players join.
    addPlayer(world);
    addPlayer(world);
    for (let t = 0; t < ticks; t++) {
      setInput(world, 0, { seq: t, moveX: 1, moveY: 0, aim: 0.4, buttons: 0 });
      stepWorld(world);
    }
    return world;
  }

  it('round-trips a keyframe', () => {
    const snap = captureSnapshot(liveWorld(40), 123);
    const back = decodeSnapshot(encodeSnapshot(snap, null));

    expect(back.tick).toBe(snap.tick);
    expect(back.baselineTick).toBe(KEYFRAME);
    expect(back.lastAckedInputSeq).toBe(123);
    expect(back.players).toHaveLength(snap.players.length);
    expect(back.players.length).toBeGreaterThan(0);

    for (const sent of snap.players) {
      const got = back.players.find((r) => r.id === sent.id);
      if (got === undefined) throw new Error(`player ${String(sent.id)} lost`);
      expect(got.x, 'x').toBeCloseTo(sent.x, 2);
      expect(got.y, 'y').toBeCloseTo(sent.y, 2);
      expect(got.vx, 'vx').toBeCloseTo(sent.vx, 2);
      expect(got.vy, 'vy').toBeCloseTo(sent.vy, 2);
      expect(got.aim, 'aim').toBeCloseTo(sent.aim, 3);
      expect(got.flags, 'flags').toBe(sent.flags);
      expect(got.health, 'health').toBe(sent.health);
      expect(got.fuel, 'fuel').toBe(sent.fuel);
      expect(got.weapon, 'weapon').toBe(sent.weapon);
      expect(got.ammo, 'ammo').toBe(sent.ammo);
    }
  });

  it('round-trips pickups with their positions', () => {
    // The reason this record is 6 bytes, not the spec's 2: dropped gear is
    // thrown and falls, so a client cannot infer where to draw it.
    const snap = captureSnapshot(liveWorld(10), 0);
    expect(snap.pickups.length).toBeGreaterThan(0);
    const back = decodeSnapshot(encodeSnapshot(snap, null));
    for (const sent of snap.pickups) {
      const got = back.pickups.find((r) => r.index === sent.index);
      if (got === undefined) throw new Error(`pickup ${String(sent.index)} lost`);
      expect(got.x).toBeCloseTo(sent.x, 2);
      expect(got.y).toBeCloseTo(sent.y, 2);
      expect(got.kind).toBe(sent.kind);
      expect(got.weapon).toBe(sent.weapon);
      expect(got.alive).toBe(true);
    }
  });

  it('encodes the alive/onGround flags the renderer needs', () => {
    const snap = captureSnapshot(liveWorld(60), 0);
    const first = snap.players[0];
    if (first === undefined) throw new Error('no players');
    expect(first.flags & PlayerFlag.Alive).not.toBe(0);
  });

  it('omits unchanged players from a delta', () => {
    const world = liveWorld(30);
    const baseline = captureSnapshot(world, 1);
    // Same world, no further ticks: nothing has moved.
    const delta = decodeSnapshot(encodeSnapshot(captureSnapshot(world, 2), baseline));
    expect(delta.players).toHaveLength(0);
    expect(delta.baselineTick).toBe(baseline.tick);
  });

  it('includes players that moved, and a delta is smaller than a keyframe', () => {
    const world = liveWorld(30);
    const baseline = captureSnapshot(world, 1);
    for (let t = 0; t < 5; t++) {
      setInput(world, 0, { seq: 100 + t, moveX: 1, moveY: 0, aim: 0.4, buttons: 0 });
      stepWorld(world);
    }
    const next = captureSnapshot(world, 2);
    const delta = encodeSnapshot(next, baseline);
    const keyframe = encodeSnapshot(next, null);
    expect(decodeSnapshot(delta).players.length).toBeGreaterThan(0);
    expect(delta.byteLength).toBeLessThan(keyframe.byteLength);
  });

  it('rebuilds full state by applying a delta to its baseline', () => {
    const world = liveWorld(30);
    const baseline = captureSnapshot(world, 1);
    for (let t = 0; t < 5; t++) {
      setInput(world, 0, { seq: 200 + t, moveX: -1, moveY: 0, aim: 2, buttons: 0 });
      stepWorld(world);
    }
    const truth = captureSnapshot(world, 2);
    const rebuilt = applyDelta(baseline, decodeSnapshot(encodeSnapshot(truth, baseline)));

    expect(rebuilt.players).toHaveLength(truth.players.length);
    for (const sent of truth.players) {
      const got = rebuilt.players.find((r) => r.id === sent.id);
      if (got === undefined) throw new Error('player lost through the delta');
      expect(got.x).toBeCloseTo(sent.x, 2);
      expect(got.y).toBeCloseTo(sent.y, 2);
    }
    // The result must itself be usable as the next baseline.
    expect(rebuilt.baselineTick).toBe(KEYFRAME);
  });

  it('reports a pickup that disappeared, so the client stops drawing it', () => {
    const world = liveWorld(10);
    const baseline = captureSnapshot(world, 1);
    const gone: WireSnapshot = { ...baseline, tick: baseline.tick + 2, pickups: [] };
    const delta = decodeSnapshot(encodeSnapshot(gone, baseline));
    expect(delta.pickups.length).toBe(baseline.pickups.length);
    expect(delta.pickups.every((r) => !r.alive)).toBe(true);
    // Applying it must actually remove them, not keep dead entries around.
    expect(applyDelta(baseline, delta).pickups).toHaveLength(0);
  });

  it('rejects a foreign message', () => {
    const bytes = encodeSnapshot(captureSnapshot(liveWorld(1), 0), null);
    bytes[0] = MsgId.Input;
    expect(() => decodeSnapshot(bytes)).toThrow(/not a snapshot/);
  });

  it('stays inside the spec bandwidth budget for a keyframe', () => {
    // §11 budgets ~1.6 kB worst case for a keyframe.
    const bytes = encodeSnapshot(captureSnapshot(liveWorld(60), 0), null);
    expect(bytes.byteLength).toBeLessThan(1600);
  });
});

describe('JOIN_REQ / WELCOME', () => {
  it('round-trips a join request', () => {
    const back = decodeJoinRequest(
      encodeJoinRequest({ protocolVersion: PROTOCOL_VERSION, name: 'Vega' }),
    );
    expect(back.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(back.name).toBe('Vega');
  });

  it('truncates an over-long name instead of overflowing the record', () => {
    const back = decodeJoinRequest(encodeJoinRequest({ protocolVersion: 1, name: 'x'.repeat(64) }));
    expect(back.name.length).toBeLessThanOrEqual(16);
  });

  it('round-trips a welcome', () => {
    const welcome = {
      playerId: 3,
      hostTick: 123456,
      rngSeed: 0xdeadbeef,
      mapId: 2,
      tuningHash: 0x1234abcd,
    };
    expect(decodeWelcome(encodeWelcome(welcome))).toEqual(welcome);
  });

  it('keeps a full 32-bit seed intact', () => {
    // A signed-vs-unsigned slip here would desync every RNG-driven roll.
    const back = decodeWelcome(
      encodeWelcome({ playerId: 0, hostTick: 0, rngSeed: 0xffffffff, mapId: 0, tuningHash: 0 }),
    );
    expect(back.rngSeed).toBe(0xffffffff);
  });
});

describe('tuningHash', () => {
  it('is stable for identical inputs', () => {
    expect(tuningHash(TUNING, { a: 1 })).toBe(tuningHash(TUNING, { a: 1 }));
  });

  it('changes when any tuning value changes', () => {
    // This is the whole point: mismatched tuning desyncs invisibly, so the hash
    // has to notice a single altered number.
    const altered = { ...TUNING, player: { ...TUNING.player, jumpSpeed: 8.7 } };
    expect(tuningHash(altered, {})).not.toBe(tuningHash(TUNING, {}));
  });

  it('changes when weapon defs change', () => {
    expect(tuningHash(TUNING, { damage: 16 })).not.toBe(tuningHash(TUNING, { damage: 17 }));
  });

  it('is an unsigned 32-bit value', () => {
    const hash = tuningHash(TUNING, {});
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hash)).toBe(true);
  });
});

describe('roster', () => {
  it('round-trips slots and names', () => {
    const entries = [
      { slot: 0, name: 'Pilot' },
      { slot: 3, name: 'Wrenchie' },
      { slot: 7, name: 'Ø Ünïcode ✈' },
    ];
    expect(decodeRoster(encodeRoster(entries))).toEqual(entries);
  });

  it('truncates a long name to the wire limit instead of overflowing', () => {
    const decoded = decodeRoster(encodeRoster([{ slot: 1, name: 'x'.repeat(64) }]));
    // 16 bytes is the cap shared with JOIN_REQ.
    expect(decoded[0]?.name.length).toBe(16);
  });

  it('handles an empty roster', () => {
    expect(decodeRoster(encodeRoster([]))).toEqual([]);
  });

  it('stops at a truncated frame rather than reading past the end', () => {
    // This arrives from the network, so a bad length is an expected input, not an
    // impossible one.
    const full = encodeRoster([
      { slot: 0, name: 'Alpha' },
      { slot: 1, name: 'Beta' },
    ]);
    for (let cut = 2; cut < full.length; cut++) {
      const decoded = decodeRoster(full.subarray(0, cut));
      expect(decoded.length, `cut at ${String(cut)}`).toBeLessThanOrEqual(2);
      for (const entry of decoded) expect(typeof entry.name).toBe('string');
    }
  });

  it('rejects a frame that is not a roster', () => {
    expect(() => decodeRoster(encodeJoinRequest({ protocolVersion: 1, name: 'x' }))).toThrow();
  });

  it('is small enough to resend whole on every change', () => {
    // The whole point of sending it whole rather than as join/leave deltas.
    const full = Array.from({ length: 8 }, (_, i) => ({ slot: i, name: 'SixteenCharName!' }));
    expect(encodeRoster(full).length).toBeLessThan(200);
  });
});
