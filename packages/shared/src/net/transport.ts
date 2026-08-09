/**
 * The transport seam (docs/networking.md §3).
 *
 * Game code talks to this interface and never to a socket, so the WebRTC path
 * and the WebSocket-relay fallback are interchangeable — ADR-006 requires the
 * fallback to be invisible to the game, and the only way to keep that true is to
 * give the game no way to tell.
 */

/**
 * Two logical channels with different delivery guarantees.
 *
 * On RTC these are two DataChannels; on the relay they share one WebSocket and a
 * 1-byte tag preserves the distinction. The tag is what lets the relay honour
 * "unreliable" semantics at all — it can drop `Data` frames under backpressure
 * while never dropping `Ctrl`.
 */
export const Channel = {
  /**
   * Unreliable, unordered: inputs at 60 Hz and snapshots at 30 Hz. A stale
   * input or snapshot is worthless, so retransmitting one only delays the frame
   * that mattered.
   */
  Data: 0,
  /** Reliable, ordered: joins, welcomes, kills, match state, chat. */
  Ctrl: 1,
} as const;

export type Channel = (typeof Channel)[keyof typeof Channel];

export interface TransportHandlers {
  /** A game frame arrived from `peerId`. */
  onFrame(peerId: string, channel: Channel, bytes: Uint8Array): void;
  /** A peer became reachable. */
  onPeerUp?(peerId: string): void;
  /** A peer went away; the session should drop its player. */
  onPeerDown?(peerId: string): void;
  onError?(error: unknown): void;
}

export interface Transport {
  /**
   * Send one frame. Returns false when the frame was deliberately dropped —
   * an unreliable send under backpressure — so callers can count it rather than
   * assume delivery.
   */
  send(peerId: string, channel: Channel, bytes: Uint8Array): boolean;
  /** Send to every connected peer. Returns how many actually went out. */
  broadcast(channel: Channel, bytes: Uint8Array): number;
  readonly peers: readonly string[];
  close(): void;
}

/** Prefix a frame with its channel tag, for transports that share one pipe. */
export function tagFrame(channel: Channel, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = channel;
  out.set(bytes, 1);
  return out;
}

/** Split a tagged frame. Returns null if the tag is not a channel we know. */
export function untagFrame(bytes: Uint8Array): { channel: Channel; payload: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const tag = bytes[0];
  if (tag !== Channel.Data && tag !== Channel.Ctrl) return null;
  return { channel: tag, payload: bytes.subarray(1) };
}
