/**
 * Generates Aerocade's PWA icons procedurally — original artwork drawn in
 * code (a delta-wing thruster emblem), encoded as PNG with zero dependencies
 * beyond node:zlib. Rerun via `npm run icons -w @aerocade/client`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---------- minimal PNG encoder ----------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- emblem drawing ----------

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/** Shade one point in unit coordinates. Returns [r, g, b, a] 0-255. */
function shade(u, v, { maskable }) {
  // Rounded-square silhouette (full bleed when maskable).
  if (!maskable) {
    const r = 0.16;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (Math.hypot(qx, qy) > r) return [0, 0, 0, 0];
  }

  // Content sits in the middle 78% for maskable safe-zone compliance.
  const s = maskable ? 0.78 : 1;
  const x = (u - 0.5) / s + 0.5;
  const y = (v - 0.5) / s + 0.5;

  // Background: vertical deep-space gradient plus a cyan glow.
  let [r, g, b] = [0x10 + (0x0b - 0x10) * v, 0x1a + (0x10 - 0x1a) * v, 0x35 + (0x20 - 0x35) * v];
  const glow = Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.42) * 2.6);
  r += 0x3c * glow * glow * 0.25;
  g += 0xd6 * glow * glow * 0.25;
  b += 0xff * glow * glow * 0.25;

  // Delta-wing ship: apex top, swept base.
  if (inTriangle(x, y, 0.5, 0.16, 0.26, 0.62, 0.74, 0.62)) {
    const t = (y - 0.16) / 0.46;
    r = 0xff;
    g = 0xa0 + (0x6a - 0xa0) * t;
    b = 0x3c;
    // Visor slit.
    if (Math.abs(y - 0.38) < 0.035 && Math.abs(x - 0.5) < 0.09) {
      [r, g, b] = [0x3c, 0xd6, 0xff];
    }
  }

  // Thruster flame.
  if (inTriangle(x, y, 0.5, 0.84, 0.4, 0.64, 0.6, 0.64)) {
    const t = (0.84 - y) / 0.2;
    r = 0xff;
    g = 0xe0 * (0.6 + 0.4 * t);
    b = 0xa0 * t;
  }

  return [Math.min(255, r), Math.min(255, g), Math.min(255, b), 255];
}

function renderIcon(size, options) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 2; // 2x2 supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [sr, sg, sb, sa] = shade(
            (px + (sx + 0.5) / ss) / size,
            (py + (sy + 0.5) / ss) / size,
            options,
          );
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const o = (py * size + px) * 4;
      rgba[o] = r / (ss * ss);
      rgba[o + 1] = g / (ss * ss);
      rgba[o + 2] = b / (ss * ss);
      rgba[o + 3] = a / (ss * ss);
    }
  }
  return encodePng(rgba, size, size);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-512.png', 512, { maskable: false }],
  ['icon-192.png', 192, { maskable: false }],
  ['icon-180.png', 180, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, options] of targets) {
  writeFileSync(join(OUT_DIR, name), renderIcon(size, options));
  console.info(`wrote ${name}`);
}
