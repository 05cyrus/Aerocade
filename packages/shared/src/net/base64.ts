/**
 * Base64 for relayed game frames.
 *
 * Hand-rolled rather than using `btoa`/`atob` (browser-only) or `Buffer`
 * (Node-only), because this code runs in both: the client relays frames through
 * the bridge, and the tests drive the same path from Node. Branching on the
 * environment would mean the tested path is not the shipped path.
 *
 * `packages/shared` must stay free of DOM and Node types (ADR-002), which rules
 * both of them out anyway.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, built once. 255 marks "not a base64 character". */
const LOOKUP = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    // `?? ''` throughout: noUncheckedIndexedAccess types a string index as
    // possibly undefined, and the masks already guarantee 0..63.
    out +=
      `${ALPHABET[(triple >> 18) & 63] ?? ''}${ALPHABET[(triple >> 12) & 63] ?? ''}` +
      `${ALPHABET[(triple >> 6) & 63] ?? ''}${ALPHABET[triple & 63] ?? ''}`;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = (bytes[i] ?? 0) << 16;
    out += `${ALPHABET[(chunk >> 18) & 63] ?? ''}${ALPHABET[(chunk >> 12) & 63] ?? ''}==`;
  } else if (remaining === 2) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      `${ALPHABET[(chunk >> 18) & 63] ?? ''}${ALPHABET[(chunk >> 12) & 63] ?? ''}` +
      `${ALPHABET[(chunk >> 6) & 63] ?? ''}=`;
  }
  return out;
}

/**
 * Decode base64 into bytes. Returns null on anything malformed rather than
 * throwing or producing partial garbage: this parses untrusted input off the
 * network, and a truncated game frame is worse than a dropped one
 * (docs/security.md).
 */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.endsWith('==')
    ? text.slice(0, -2)
    : text.endsWith('=')
      ? text.slice(0, -1)
      : text;
  const padding = text.length - clean.length;
  if (padding > 2) return null;
  // Every 4 characters carry 3 bytes; a length of 1 mod 4 cannot happen.
  if (clean.length % 4 === 1) return null;

  const byteLength = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(byteLength);
  let bits = 0;
  let accumulator = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = LOOKUP[clean.charCodeAt(i)] ?? 255;
    if (value === 255) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (accumulator >> bits) & 0xff;
      at += 1;
    }
  }
  return at === byteLength ? out : out.subarray(0, at);
}
