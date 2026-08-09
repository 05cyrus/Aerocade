import {
  MAX_EVENTS,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  WEAPON_SLOTS,
} from '../constants.js';
import { Buttons } from '../sim/input.js';
import type { SimWorld } from '../sim/world.js';
import { PROTOCOL_VERSION } from './messages.js';

/**
 * Binary game-frame codec (docs/networking.md §5). Little-endian, every message
 * prefixed with a `u8` message id.
 *
 * This is the layer everything else in the netcode rests on, so it is written
 * and tested first: prediction, reconciliation and interpolation are all
 * meaningless if a snapshot does not survive a round trip.
 *
 * ## Quantization
 *
 * Positions are 1/256 m in a `u16`, which caps the encodable world at
 * **255.996 m**. The spec says "map is 48×27 m — fits u16 with headroom", which
 * is stale: Hollow Works is 180×92 m. It still fits, but the headroom is a third
 * of what that note implies, and a future map past 256 m would wrap silently
 * rather than fail. `assertEncodable` and a test over every registered map guard
 * that ceiling explicitly.
 *
 * Velocities are 1/256 m/s in an `i16` (±127.99 m/s) against a `hardSpeedCap`
 * of 45 m/s, so they have real headroom. Aim is a `u16` over a full turn —
 * about 0.0055°, which matters because the Longbolt reaches 70 m and coarser
 * angles would visibly miss.
 */

export const MsgId = {
  Input: 0x01,
  Snapshot: 0x02,
  Event: 0x03,
  /** Slot → display name for everyone in the match. Host → clients. */
  Roster: 0x04,
  JoinRequest: 0x10,
  Welcome: 0x11,
} as const;

export type MsgId = (typeof MsgId)[keyof typeof MsgId];

/** Marks a snapshot as a full keyframe rather than a delta. */
export const KEYFRAME = 0xffffffff;

const POS_SCALE = 256;
const VEL_SCALE = 256;
/** Largest position this format can carry, in metres. */
export const POSITION_MAX_M = 65535 / POS_SCALE;
/** Largest speed component this format can carry, in m/s. */
export const VELOCITY_MAX_MS = 32767 / VEL_SCALE;

const TWO_PI = Math.PI * 2;

// 16 bytes of movement/loadout plus 3 of scoreboard (kills, deaths, team). The
// scoreboard fields are cheap because the delta encoder only ships players that
// changed, and a frag count changes far less often than a position.
const PLAYER_RECORD_BYTES = 19;

/**
 * Match block appended to every snapshot: mode, phase, winner, the two clocks,
 * the frag limit and team frags.
 *
 * Sent whole rather than delta-encoded. It is 17 bytes against a snapshot that is
 * already hundreds, it changes rarely enough that a delta would almost always be
 * "no change" anyway, and keeping it unconditional means the decoder has no
 * branch that could leave a client with a half-known match.
 */
const MATCH_BLOCK_BYTES = 17;
const PROJECTILE_RECORD_BYTES = 11;
/**
 * 6 bytes, not the spec's 2. A 2-byte `index, state` record cannot place an
 * item, which is fine for pad guns (position comes from the map) but wrong for
 * gear dropped on a swap or a death — that is thrown and falls, so the client
 * has nowhere to draw it. Position is carried instead of inferred.
 */
const PICKUP_RECORD_BYTES = 6;

const INPUT_FRAME_BYTES = 6;
/** msgId + seq + clientTick + ackTick + newest frame + 2 redundant frames. */
export const INPUT_BYTES = 1 + 2 + 4 + 4 + INPUT_FRAME_BYTES + INPUT_FRAME_BYTES * 2;

/** Player record flag bits (docs/networking.md §5.2). */
export const PlayerFlag = {
  Alive: 1 << 0,
  OnGround: 1 << 1,
  Jetpack: 1 << 2,
  Hover: 1 << 3,
  SpawnProtected: 1 << 4,
  Firing: 1 << 5,
  /** Set when facing left; the rig mirrors on this. */
  FacingLeft: 1 << 6,
  Reloading: 1 << 7,
} as const;

// ---------- quantization ----------

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function encodePos(metres: number): number {
  return clampInt(metres * POS_SCALE, 0, 65535);
}

export function decodePos(raw: number): number {
  return raw / POS_SCALE;
}

export function encodeVel(metresPerSecond: number): number {
  return clampInt(metresPerSecond * VEL_SCALE, -32768, 32767);
}

export function decodeVel(raw: number): number {
  return raw / VEL_SCALE;
}

/** Wrap any angle into 0..65535 over a full turn. */
export function encodeAim(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const turns = radians / TWO_PI;
  const wrapped = turns - Math.floor(turns);
  return Math.round(wrapped * 65536) & 0xffff;
}

export function decodeAim(raw: number): number {
  const angle = (raw / 65536) * TWO_PI;
  // Return the signed range the sim uses, so a decoded aim compares directly
  // against `Math.atan2` output instead of being off by a full turn.
  return angle > Math.PI ? angle - TWO_PI : angle;
}

function encodeAxis(value: number): number {
  return clampInt(value * 127, -127, 127);
}

function decodeAxis(raw: number): number {
  return raw / 127;
}

/**
 * Fail loudly if a map cannot be represented. Called when a session starts:
 * silently wrapping a position is the worst possible failure — players would
 * teleport across the map with no error anywhere.
 */
export function assertEncodable(widthM: number, heightM: number): void {
  if (widthM > POSITION_MAX_M || heightM > POSITION_MAX_M) {
    throw new Error(
      `map ${String(widthM)}×${String(heightM)} m exceeds the ${String(POSITION_MAX_M)} m ` +
        `position quantization ceiling; widen the wire format before shipping it`,
    );
  }
}

// ---------- C2H_INPUT ----------

export interface InputFrame {
  buttons: number;
  moveX: number;
  moveY: number;
  aim: number;
}

export interface InputPacket {
  seq: number;
  clientTick: number;
  ackTick: number;
  /** Newest frame first, then up to two older ones (redundancy). */
  frames: InputFrame[];
}

function writeInputFrame(view: DataView, offset: number, frame: InputFrame): void {
  view.setUint16(offset, frame.buttons & 0xffff, true);
  view.setInt8(offset + 2, encodeAxis(frame.moveX));
  view.setInt8(offset + 3, encodeAxis(frame.moveY));
  view.setUint16(offset + 4, encodeAim(frame.aim), true);
}

function readInputFrame(view: DataView, offset: number): InputFrame {
  return {
    buttons: view.getUint16(offset, true),
    moveX: decodeAxis(view.getInt8(offset + 2)),
    moveY: decodeAxis(view.getInt8(offset + 3)),
    aim: decodeAim(view.getUint16(offset + 4, true)),
  };
}

/**
 * Encode one input datagram. Always fixed-size: the two redundant frames are
 * padded with copies of the newest when history is short, so a fresh connection
 * produces the same 29 bytes as a running one and the reader never branches.
 */
export function encodeInput(packet: InputPacket): Uint8Array {
  const bytes = new Uint8Array(INPUT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MsgId.Input);
  view.setUint16(1, packet.seq & 0xffff, true);
  view.setUint32(3, packet.clientTick >>> 0, true);
  view.setUint32(7, packet.ackTick >>> 0, true);

  const newest = packet.frames[0] ?? { buttons: 0, moveX: 0, moveY: 0, aim: 0 };
  writeInputFrame(view, 11, newest);
  for (let i = 0; i < 2; i++) {
    writeInputFrame(view, 17 + i * INPUT_FRAME_BYTES, packet.frames[i + 1] ?? newest);
  }
  return bytes;
}

export function decodeInput(bytes: Uint8Array): InputPacket {
  if (bytes.length < INPUT_BYTES) throw new Error('input packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.Input) throw new Error('not an input packet');
  const frames: InputFrame[] = [readInputFrame(view, 11)];
  for (let i = 0; i < 2; i++) frames.push(readInputFrame(view, 17 + i * INPUT_FRAME_BYTES));
  return {
    seq: view.getUint16(1, true),
    clientTick: view.getUint32(3, true),
    ackTick: view.getUint32(7, true),
    frames,
  };
}

// ---------- H2C_SNAPSHOT ----------

export interface PlayerRecord {
  id: number;
  flags: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  health: number;
  fuel: number;
  weapon: number;
  ammo: number;
  /** Scoreboard fields — a client cannot draw standings without them. */
  kills: number;
  deaths: number;
  team: number;
}

export interface ProjectileRecord {
  id: number;
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface PickupRecord {
  index: number;
  alive: boolean;
  kind: number;
  weapon: number;
  x: number;
  y: number;
}

/**
 * One transported world state. Named `WireSnapshot` rather than `Snapshot`
 * because `sim/world.ts` already exports a `Snapshot` — that one is the
 * rollback copy of the entire pool set, this one is the quantized subset that
 * crosses the network. Conflating them would be a genuinely confusing bug.
 */
/**
 * Match phase, clocks and score as they go over the wire. A joining client learns
 * the whole match from its first snapshot, so nothing about it has to be added to
 * the join handshake.
 */
export interface MatchRecord {
  mode: number;
  phase: number;
  winner: number;
  phaseStartTick: number;
  timeLimitTicks: number;
  fragLimit: number;
  teamFrags: number[];
}

export interface WireSnapshot {
  tick: number;
  /** `KEYFRAME` when this carries full state. */
  baselineTick: number;
  lastAckedInputSeq: number;
  players: PlayerRecord[];
  projectiles: ProjectileRecord[];
  pickups: PickupRecord[];
  match: MatchRecord;
}

/** Read the authoritative world into a transport-shaped snapshot. */
export function captureSnapshot(world: SimWorld, lastAckedInputSeq: number): WireSnapshot {
  const p = world.players;
  const players: PlayerRecord[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (p.connected[i] !== 1) continue;
    const cmd = world.inputs[i];
    const buttons = cmd?.buttons ?? 0;
    const aim = p.aim[i] ?? 0;
    const slot = p.weaponSlot[i] ?? 0;

    let flags = 0;
    if (p.status[i] === 1) flags |= PlayerFlag.Alive;
    if (p.grounded[i] === 1) flags |= PlayerFlag.OnGround;
    if ((buttons & Buttons.Thrust) !== 0) flags |= PlayerFlag.Jetpack;
    // Hover is thrust plus a down input while airborne (ADR-011).
    if ((buttons & Buttons.Thrust) !== 0 && (cmd?.moveY ?? 0) > 0.5 && p.grounded[i] !== 1) {
      flags |= PlayerFlag.Hover;
    }
    if ((p.protect[i] ?? 0) > 0) flags |= PlayerFlag.SpawnProtected;
    if ((buttons & Buttons.Fire) !== 0) flags |= PlayerFlag.Firing;
    if (Math.abs(aim) > Math.PI / 2) flags |= PlayerFlag.FacingLeft;
    if ((p.reload[i] ?? 0) > 0) flags |= PlayerFlag.Reloading;

    players.push({
      id: i,
      flags,
      x: p.posX[i] ?? 0,
      y: p.posY[i] ?? 0,
      vx: p.velX[i] ?? 0,
      vy: p.velY[i] ?? 0,
      aim,
      // Health and fuel are both 0..100, so a byte is lossless for them.
      health: Math.round(p.health[i] ?? 0),
      fuel: Math.round(p.fuel[i] ?? 0),
      weapon: p.weapons[i * WEAPON_SLOTS + slot] ?? 0,
      ammo: Math.max(0, Math.min(255, p.ammoMag[i * WEAPON_SLOTS + slot] ?? 0)),
      // Clamped rather than wrapped: a scoreboard that rolls over to 0 at 256
      // frags is worse than one that sticks, and no match runs that long.
      kills: Math.max(0, Math.min(255, p.kills[i] ?? 0)),
      deaths: Math.max(0, Math.min(255, p.deaths[i] ?? 0)),
      team: (p.team[i] ?? 0) & 0xff,
    });
  }

  const pr = world.projectiles;
  const projectiles: ProjectileRecord[] = [];
  for (let i = 0; i < MAX_PROJECTILES; i++) {
    if (pr.alive[i] !== 1) continue;
    projectiles.push({
      id: i,
      kind: pr.kind[i] ?? 0,
      x: pr.posX[i] ?? 0,
      y: pr.posY[i] ?? 0,
      vx: pr.velX[i] ?? 0,
      vy: pr.velY[i] ?? 0,
    });
  }

  const pk = world.pickups;
  const pickups: PickupRecord[] = [];
  for (let i = 0; i < MAX_PICKUPS; i++) {
    if (pk.alive[i] !== 1) continue;
    pickups.push({
      index: i,
      alive: true,
      kind: pk.kind[i] ?? 0,
      weapon: pk.weapon[i] ?? 0,
      x: pk.posX[i] ?? 0,
      y: pk.posY[i] ?? 0,
    });
  }

  const m = world.match;
  return {
    tick: world.tick,
    baselineTick: KEYFRAME,
    lastAckedInputSeq,
    players,
    projectiles,
    pickups,
    match: {
      mode: m.mode,
      phase: m.phase,
      winner: m.winner,
      phaseStartTick: m.phaseStartTick,
      timeLimitTicks: m.timeLimitTicks,
      fragLimit: m.fragLimit,
      teamFrags: [...m.teamFrags],
    },
  };
}

function playerRecordsEqual(a: PlayerRecord, b: PlayerRecord): boolean {
  // Compared post-quantization: two positions a thousandth of a metre apart
  // encode to the same bytes, and re-sending them would waste the delta.
  return (
    a.flags === b.flags &&
    a.kills === b.kills &&
    a.deaths === b.deaths &&
    a.team === b.team &&
    encodePos(a.x) === encodePos(b.x) &&
    encodePos(a.y) === encodePos(b.y) &&
    encodeVel(a.vx) === encodeVel(b.vx) &&
    encodeVel(a.vy) === encodeVel(b.vy) &&
    encodeAim(a.aim) === encodeAim(b.aim) &&
    a.health === b.health &&
    a.fuel === b.fuel &&
    a.weapon === b.weapon &&
    a.ammo === b.ammo
  );
}

function pickupRecordsEqual(a: PickupRecord, b: PickupRecord): boolean {
  return (
    a.alive === b.alive &&
    a.kind === b.kind &&
    a.weapon === b.weapon &&
    encodePos(a.x) === encodePos(b.x) &&
    encodePos(a.y) === encodePos(b.y)
  );
}

/** Pack a pickup's discrete fields into one byte: alive, kind, weapon. */
function packPickupState(record: PickupRecord): number {
  return (record.alive ? 1 : 0) | ((record.kind & 0x7) << 1) | ((record.weapon & 0xf) << 4);
}

/**
 * Encode a snapshot, optionally as a delta against a baseline.
 *
 * Projectiles are always sent in full. They are short-lived and mostly either
 * new or gone, so diffing them costs more bookkeeping than it saves; players and
 * pickups are the state that persists and benefits.
 */
export function encodeSnapshot(snapshot: WireSnapshot, baseline: WireSnapshot | null): Uint8Array {
  const basePlayers = new Map<number, PlayerRecord>();
  const basePickups = new Map<number, PickupRecord>();
  if (baseline !== null) {
    for (const record of baseline.players) basePlayers.set(record.id, record);
    for (const record of baseline.pickups) basePickups.set(record.index, record);
  }

  const players = snapshot.players.filter((record) => {
    const previous = basePlayers.get(record.id);
    return previous === undefined || !playerRecordsEqual(record, previous);
  });
  const pickups = snapshot.pickups.filter((record) => {
    const previous = basePickups.get(record.index);
    return previous === undefined || !pickupRecordsEqual(record, previous);
  });
  // A pickup that vanished must be reported, or the client keeps drawing it.
  if (baseline !== null) {
    for (const previous of baseline.pickups) {
      if (!snapshot.pickups.some((r) => r.index === previous.index)) {
        pickups.push({ ...previous, alive: false });
      }
    }
  }

  const size =
    1 +
    4 +
    4 +
    2 +
    1 +
    players.length * PLAYER_RECORD_BYTES +
    1 +
    snapshot.projectiles.length * PROJECTILE_RECORD_BYTES +
    1 +
    pickups.length * PICKUP_RECORD_BYTES +
    MATCH_BLOCK_BYTES;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, MsgId.Snapshot);
  view.setUint32(1, snapshot.tick >>> 0, true);
  view.setUint32(5, baseline === null ? KEYFRAME : baseline.tick >>> 0, true);
  view.setUint16(9, snapshot.lastAckedInputSeq & 0xffff, true);

  let mask = 0;
  for (const record of players) mask |= 1 << record.id;
  view.setUint8(11, mask);

  let at = 12;
  for (const record of players) {
    view.setUint8(at, record.id);
    view.setUint8(at + 1, record.flags & 0xff);
    view.setUint16(at + 2, encodePos(record.x), true);
    view.setUint16(at + 4, encodePos(record.y), true);
    view.setInt16(at + 6, encodeVel(record.vx), true);
    view.setInt16(at + 8, encodeVel(record.vy), true);
    view.setUint16(at + 10, encodeAim(record.aim), true);
    view.setUint8(at + 12, Math.max(0, Math.min(255, record.health)));
    view.setUint8(at + 13, Math.max(0, Math.min(255, record.fuel)));
    view.setUint8(at + 14, record.weapon & 0xff);
    view.setUint8(at + 15, Math.max(0, Math.min(255, record.ammo)));
    view.setUint8(at + 16, Math.max(0, Math.min(255, record.kills)));
    view.setUint8(at + 17, Math.max(0, Math.min(255, record.deaths)));
    view.setUint8(at + 18, record.team & 0xff);
    at += PLAYER_RECORD_BYTES;
  }

  view.setUint8(at, Math.min(255, snapshot.projectiles.length));
  at += 1;
  for (const record of snapshot.projectiles) {
    view.setUint16(at, record.id & 0xffff, true);
    view.setUint8(at + 2, record.kind & 0xff);
    view.setUint16(at + 3, encodePos(record.x), true);
    view.setUint16(at + 5, encodePos(record.y), true);
    view.setInt16(at + 7, encodeVel(record.vx), true);
    view.setInt16(at + 9, encodeVel(record.vy), true);
    at += PROJECTILE_RECORD_BYTES;
  }

  view.setUint8(at, Math.min(255, pickups.length));
  at += 1;
  for (const record of pickups) {
    view.setUint8(at, record.index & 0xff);
    view.setUint8(at + 1, packPickupState(record));
    view.setUint16(at + 2, encodePos(record.x), true);
    view.setUint16(at + 4, encodePos(record.y), true);
    at += PICKUP_RECORD_BYTES;
  }

  const m = snapshot.match;
  view.setUint8(at, m.mode & 0xff);
  view.setUint8(at + 1, m.phase & 0xff);
  // Signed: NO_WINNER is -1, and an unsigned 255 would decode as a real entrant.
  view.setInt8(at + 2, Math.max(-128, Math.min(127, m.winner)));
  view.setUint32(at + 3, m.phaseStartTick >>> 0, true);
  view.setUint32(at + 7, m.timeLimitTicks >>> 0, true);
  view.setUint16(at + 11, m.fragLimit & 0xffff, true);
  view.setUint16(at + 13, (m.teamFrags[0] ?? 0) & 0xffff, true);
  view.setUint16(at + 15, (m.teamFrags[1] ?? 0) & 0xffff, true);

  return bytes;
}

export function decodeSnapshot(bytes: Uint8Array): WireSnapshot {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.Snapshot) throw new Error('not a snapshot');

  const tick = view.getUint32(1, true);
  const baselineTick = view.getUint32(5, true);
  const lastAckedInputSeq = view.getUint16(9, true);
  const mask = view.getUint8(11);

  let at = 12;
  const players: PlayerRecord[] = [];
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    if ((mask & (1 << slot)) === 0) continue;
    players.push({
      id: view.getUint8(at),
      flags: view.getUint8(at + 1),
      x: decodePos(view.getUint16(at + 2, true)),
      y: decodePos(view.getUint16(at + 4, true)),
      vx: decodeVel(view.getInt16(at + 6, true)),
      vy: decodeVel(view.getInt16(at + 8, true)),
      aim: decodeAim(view.getUint16(at + 10, true)),
      health: view.getUint8(at + 12),
      fuel: view.getUint8(at + 13),
      weapon: view.getUint8(at + 14),
      ammo: view.getUint8(at + 15),
      kills: view.getUint8(at + 16),
      deaths: view.getUint8(at + 17),
      team: view.getUint8(at + 18),
    });
    at += PLAYER_RECORD_BYTES;
  }

  const projCount = view.getUint8(at);
  at += 1;
  const projectiles: ProjectileRecord[] = [];
  for (let i = 0; i < projCount; i++) {
    projectiles.push({
      id: view.getUint16(at, true),
      kind: view.getUint8(at + 2),
      x: decodePos(view.getUint16(at + 3, true)),
      y: decodePos(view.getUint16(at + 5, true)),
      vx: decodeVel(view.getInt16(at + 7, true)),
      vy: decodeVel(view.getInt16(at + 9, true)),
    });
    at += PROJECTILE_RECORD_BYTES;
  }

  const pickupCount = view.getUint8(at);
  at += 1;
  const pickups: PickupRecord[] = [];
  for (let i = 0; i < pickupCount; i++) {
    const state = view.getUint8(at + 1);
    pickups.push({
      index: view.getUint8(at),
      alive: (state & 1) === 1,
      kind: (state >> 1) & 0x7,
      weapon: (state >> 4) & 0xf,
      x: decodePos(view.getUint16(at + 2, true)),
      y: decodePos(view.getUint16(at + 4, true)),
    });
    at += PICKUP_RECORD_BYTES;
  }

  const match: MatchRecord = {
    mode: view.getUint8(at),
    phase: view.getUint8(at + 1),
    winner: view.getInt8(at + 2),
    phaseStartTick: view.getUint32(at + 3, true),
    timeLimitTicks: view.getUint32(at + 7, true),
    fragLimit: view.getUint16(at + 11, true),
    teamFrags: [view.getUint16(at + 13, true), view.getUint16(at + 15, true)],
  };

  return { tick, baselineTick, lastAckedInputSeq, players, projectiles, pickups, match };
}

/**
 * Rebuild full state from a baseline plus a decoded delta.
 *
 * Absent players and pickups mean "unchanged", so they carry over. Dead pickups
 * are dropped entirely rather than kept with `alive: false`, so the result is
 * always a valid keyframe that can itself serve as the next baseline.
 */
export function applyDelta(baseline: WireSnapshot, delta: WireSnapshot): WireSnapshot {
  const players = new Map<number, PlayerRecord>();
  for (const record of baseline.players) players.set(record.id, record);
  for (const record of delta.players) players.set(record.id, record);

  const pickups = new Map<number, PickupRecord>();
  for (const record of baseline.pickups) pickups.set(record.index, record);
  for (const record of delta.pickups) {
    if (record.alive) pickups.set(record.index, record);
    else pickups.delete(record.index);
  }

  return {
    tick: delta.tick,
    baselineTick: KEYFRAME,
    lastAckedInputSeq: delta.lastAckedInputSeq,
    players: [...players.values()].sort((a, b) => a.id - b.id),
    projectiles: delta.projectiles,
    pickups: [...pickups.values()].sort((a, b) => a.index - b.index),
    // Always sent whole, so the delta's copy is simply the current one.
    match: delta.match,
  };
}

// ---------- JOIN_REQ / WELCOME ----------

const MAX_NAME_BYTES = 16;

export interface JoinRequest {
  protocolVersion: number;
  name: string;
}

export function encodeJoinRequest(request: JoinRequest): Uint8Array {
  const name = new TextEncoder().encode(request.name).slice(0, MAX_NAME_BYTES);
  const bytes = new Uint8Array(1 + 2 + 1 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MsgId.JoinRequest);
  view.setUint16(1, request.protocolVersion & 0xffff, true);
  view.setUint8(3, name.length);
  bytes.set(name, 4);
  return bytes;
}

export function decodeJoinRequest(bytes: Uint8Array): JoinRequest {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.JoinRequest) throw new Error('not a join request');
  const nameLength = Math.min(view.getUint8(3), MAX_NAME_BYTES);
  const name = new TextDecoder().decode(bytes.subarray(4, 4 + nameLength));
  return { protocolVersion: view.getUint16(1, true), name };
}

/**
 * Sim events for one tick, host → client.
 *
 * Carries `SimEvent` records verbatim rather than the per-type payloads sketched
 * in docs/networking.md §5.3. That sketch predates the event buffer and described
 * a lobby feed (joined/left/chat); three of its types are now served better
 * elsewhere — the roster publishes joins and leaves (ADR-032) and every snapshot
 * carries the match state (ADR-031) — while none of them covered the thing that
 * actually matters here: gunfire, impacts and explosions belonging to *other*
 * players.
 *
 * Carrying the buffer verbatim means `ArenaScene.applyEvents` needs no change at
 * all: a client's `world.events` ends up holding the same records a host's does,
 * so remote players sound and look like local ones for free.
 */
export interface EventBatch {
  tick: number;
  events: SimEventRecord[];
}

/** One event on the wire; mirrors `SimEvent` in sim/events.ts. */
export interface SimEventRecord {
  type: number;
  a: number;
  b: number;
  x: number;
  y: number;
  r: number;
}

/** type u8 + a i16 + b i16 + x u16 + y u16 + r u16. */
const EVENT_RECORD_BYTES = 11;

export function encodeEvents(batch: EventBatch): Uint8Array {
  const events = batch.events.slice(0, MAX_EVENTS);
  const bytes = new Uint8Array(1 + 4 + 1 + events.length * EVENT_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MsgId.Event);
  view.setUint32(1, batch.tick >>> 0, true);
  view.setUint8(5, events.length);
  let at = 6;
  for (const ev of events) {
    view.setUint8(at, ev.type & 0xff);
    // Signed: `a` and `b` carry NO_PLAYER (-1) for a world kill, a frag grenade's
    // absent weapon, and an undecided winner. Unsigned would decode those as 255.
    view.setInt16(at + 1, clampI16(ev.a), true);
    view.setInt16(at + 3, clampI16(ev.b), true);
    view.setUint16(at + 5, encodePos(ev.x), true);
    view.setUint16(at + 7, encodePos(ev.y), true);
    view.setUint16(at + 9, encodePos(ev.r), true);
    at += EVENT_RECORD_BYTES;
  }
  return bytes;
}

export function decodeEvents(bytes: Uint8Array): EventBatch {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.Event) throw new Error('not an event batch');
  const tick = view.getUint32(1, true);
  const count = view.getUint8(5);
  const events: SimEventRecord[] = [];
  let at = 6;
  for (let i = 0; i < count; i++) {
    // Truncated frames stop the walk: this arrives from the network.
    if (at + EVENT_RECORD_BYTES > bytes.length) break;
    events.push({
      type: view.getUint8(at),
      a: view.getInt16(at + 1, true),
      b: view.getInt16(at + 3, true),
      x: decodePos(view.getUint16(at + 5, true)),
      y: decodePos(view.getUint16(at + 7, true)),
      r: decodePos(view.getUint16(at + 9, true)),
    });
    at += EVENT_RECORD_BYTES;
  }
  return { tick, events };
}

function clampI16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.trunc(value)));
}

/** One player's identity — everything about them that is not simulated. */
export interface RosterEntry {
  slot: number;
  name: string;
}

/**
 * Slot → name for every player in the match.
 *
 * Sent whole whenever the roster changes rather than as a join/leave stream. The
 * whole thing is under 150 bytes for a full server, and a client that missed one
 * delta would show a wrong name for the rest of the match with nothing to
 * correct it — whereas a whole roster is self-healing by construction.
 *
 * Names are deliberately **not** in the snapshot: they never change during a
 * match, and putting them on a 30 Hz channel would spend a kilobyte a second
 * repeating them.
 */
export function encodeRoster(entries: readonly RosterEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = entries.slice(0, MAX_PLAYERS).map((entry) => ({
    slot: entry.slot & 0xff,
    name: encoder.encode(entry.name).slice(0, MAX_NAME_BYTES),
  }));
  const size = 2 + encoded.reduce((total, e) => total + 2 + e.name.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MsgId.Roster);
  view.setUint8(1, encoded.length);
  let at = 2;
  for (const entry of encoded) {
    view.setUint8(at, entry.slot);
    view.setUint8(at + 1, entry.name.length);
    bytes.set(entry.name, at + 2);
    at += 2 + entry.name.length;
  }
  return bytes;
}

export function decodeRoster(bytes: Uint8Array): RosterEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.Roster) throw new Error('not a roster');
  const count = view.getUint8(1);
  const decoder = new TextDecoder();
  const entries: RosterEntry[] = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    // A truncated frame stops the walk rather than reading past the end: this
    // arrives from the network, so a malformed length is an expected input.
    if (at + 2 > bytes.length) break;
    const slot = view.getUint8(at);
    const length = Math.min(view.getUint8(at + 1), MAX_NAME_BYTES);
    if (at + 2 + length > bytes.length) break;
    entries.push({ slot, name: decoder.decode(bytes.subarray(at + 2, at + 2 + length)) });
    at += 2 + length;
  }
  return entries;
}

export interface Welcome {
  playerId: number;
  hostTick: number;
  rngSeed: number;
  mapId: number;
  tuningHash: number;
}

export function encodeWelcome(welcome: Welcome): Uint8Array {
  const bytes = new Uint8Array(1 + 1 + 4 + 4 + 1 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MsgId.Welcome);
  view.setUint8(1, welcome.playerId & 0xff);
  view.setUint32(2, welcome.hostTick >>> 0, true);
  view.setUint32(6, welcome.rngSeed >>> 0, true);
  view.setUint8(10, welcome.mapId & 0xff);
  view.setUint32(11, welcome.tuningHash >>> 0, true);
  return bytes;
}

export function decodeWelcome(bytes: Uint8Array): Welcome {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MsgId.Welcome) throw new Error('not a welcome');
  return {
    playerId: view.getUint8(1),
    hostTick: view.getUint32(2, true),
    rngSeed: view.getUint32(6, true),
    mapId: view.getUint8(10),
    tuningHash: view.getUint32(11, true),
  };
}

/** The message id of a frame, or null when it is not a frame we know. */
export function peekMsgId(bytes: Uint8Array): number | null {
  return bytes.length === 0 ? null : (bytes[0] ?? null);
}

/**
 * Hash of everything that must match between host and client: the protocol
 * version plus every gameplay value the simulation reads.
 *
 * Two peers running different tuning diverge invisibly — the same inputs produce
 * different positions, which looks like lag or cheating rather than a version
 * mismatch. Comparing a hash in `WELCOME` turns that into an immediate, legible
 * rejection.
 */
export function tuningHash(tuning: unknown, weaponDefs: unknown): number {
  const text = `${String(PROTOCOL_VERSION)}|${JSON.stringify(tuning)}|${JSON.stringify(weaponDefs)}`;
  // FNV-1a: short, dependency-free, and stable across engines — which matters,
  // because a hash that differs between browsers would reject every join.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
