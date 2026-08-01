/**
 * Wire protocol types shared by client, host, and the LAN bridge.
 *
 * Bridge traffic is JSON over WebSocket (low rate: rooms + signaling).
 * Game traffic (inputs/snapshots) is binary over RTC DataChannels or the WS
 * relay; its codec lands in M2 — see docs/networking.md for the full spec.
 */

/** Protocol version; mismatches refuse to connect rather than misbehave. */
export const PROTOCOL_VERSION = 1;

export interface RoomInfo {
  id: string;
  name: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  mode: string;
  mapId: string;
}

/** Messages a browser sends to the bridge. */
export type ClientToBridge =
  | { t: 'hello'; version: number }
  | { t: 'room:create'; name: string; hostName: string; mode: string; mapId: string }
  | { t: 'room:list' }
  | { t: 'room:join'; roomId: string; playerName: string }
  | { t: 'room:leave' }
  | { t: 'signal'; to: string; data: unknown }
  | { t: 'relay'; to: string; payload: string }
  | { t: 'ping' };

/** Messages the bridge sends to a browser. */
export type BridgeToClient =
  | { t: 'welcome'; peerId: string; version: number }
  | { t: 'room:created'; room: RoomInfo }
  | { t: 'room:listing'; rooms: RoomInfo[] }
  | { t: 'room:joined'; room: RoomInfo; hostPeerId: string }
  | { t: 'room:peer-joined'; peerId: string; playerName: string }
  | { t: 'room:peer-left'; peerId: string }
  | { t: 'room:closed'; roomId: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'relay'; from: string; payload: string }
  | { t: 'error'; code: BridgeErrorCode; message: string }
  | { t: 'pong' };

export type BridgeErrorCode =
  | 'bad-message'
  | 'version-mismatch'
  | 'room-not-found'
  | 'room-full'
  | 'not-in-room'
  | 'rate-limited';

/** Type guard for messages arriving at the bridge; malformed input is rejected. */
export function parseClientToBridge(raw: unknown): ClientToBridge | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.t) {
    case 'hello':
      return typeof msg.version === 'number' ? { t: 'hello', version: msg.version } : null;
    case 'room:create':
      return typeof msg.name === 'string' &&
        typeof msg.hostName === 'string' &&
        typeof msg.mode === 'string' &&
        typeof msg.mapId === 'string'
        ? {
            t: 'room:create',
            name: msg.name.slice(0, 32),
            hostName: msg.hostName.slice(0, 24),
            mode: msg.mode.slice(0, 16),
            mapId: msg.mapId.slice(0, 32),
          }
        : null;
    case 'room:list':
      return { t: 'room:list' };
    case 'room:join':
      return typeof msg.roomId === 'string' && typeof msg.playerName === 'string'
        ? { t: 'room:join', roomId: msg.roomId.slice(0, 16), playerName: msg.playerName.slice(0, 24) }
        : null;
    case 'room:leave':
      return { t: 'room:leave' };
    case 'signal':
      return typeof msg.to === 'string'
        ? { t: 'signal', to: msg.to.slice(0, 16), data: msg.data }
        : null;
    case 'relay':
      return typeof msg.to === 'string' && typeof msg.payload === 'string'
        ? { t: 'relay', to: msg.to.slice(0, 16), payload: msg.payload }
        : null;
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}
