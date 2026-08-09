import type { BridgeClient } from './bridge-client.js';
import {
  Channel,
  tagFrame,
  untagFrame,
  type Transport,
  type TransportHandlers,
} from './transport.js';

/**
 * `Transport` over the bridge's WebSocket relay — the fallback path from ADR-006,
 * used when WebRTC cannot be established (locked-down APs, client isolation).
 *
 * Both logical channels share the one socket, so a 1-byte tag carries the
 * distinction and `Channel.Data` frames are droppable under backpressure. The
 * game cannot tell this apart from the RTC path, which is the whole point of the
 * interface: the fallback must be invisible.
 */
export class RelayTransport implements Transport {
  private readonly connected = new Set<string>();
  /** Frames deliberately dropped for backpressure — surfaced for diagnostics. */
  private droppedFrames = 0;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly handlers: TransportHandlers,
    initialPeers: readonly string[] = [],
  ) {
    for (const peer of initialPeers) this.connected.add(peer);
  }

  get peers(): readonly string[] {
    return [...this.connected];
  }

  get dropped(): number {
    return this.droppedFrames;
  }

  /** Route a relayed frame from the bridge into the session. */
  acceptRelay(from: string, bytes: Uint8Array): void {
    const frame = untagFrame(bytes);
    if (frame === null) return; // Unknown channel tag: not ours, drop it.
    this.connected.add(from);
    this.handlers.onFrame(from, frame.channel, frame.payload);
  }

  peerUp(peerId: string): void {
    if (this.connected.has(peerId)) return;
    this.connected.add(peerId);
    this.handlers.onPeerUp?.(peerId);
  }

  peerDown(peerId: string): void {
    if (!this.connected.delete(peerId)) return;
    this.handlers.onPeerDown?.(peerId);
  }

  send(peerId: string, channel: Channel, bytes: Uint8Array): boolean {
    const sent = this.bridge.sendRelay(peerId, tagFrame(channel, bytes), channel === Channel.Data);
    if (!sent) this.droppedFrames += 1;
    return sent;
  }

  broadcast(channel: Channel, bytes: Uint8Array): number {
    // Tagged once and reused: tagging per peer would copy the buffer 8 times a
    // snapshot, which is exactly the per-frame allocation the budget forbids.
    const tagged = tagFrame(channel, bytes);
    let sent = 0;
    for (const peer of this.connected) {
      if (this.bridge.sendRelay(peer, tagged, channel === Channel.Data)) sent += 1;
      else this.droppedFrames += 1;
    }
    return sent;
  }

  close(): void {
    this.connected.clear();
  }
}
