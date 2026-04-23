/**
 * Tiny deterministic identicon generator for Subsonic's `getAvatar` endpoint.
 *
 * mStream doesn't store user avatars, but Subsonic clients render a grey
 * box when the endpoint 404s. A 5x5 horizontally-symmetric pattern (à la
 * GitHub) seeded off the username is a cheap visual upgrade.
 *
 * Uses jimp (already a dep) to produce a PNG buffer at the requested size.
 */

import crypto from 'node:crypto';
import { Jimp } from 'jimp';

function hash32(s) {
  // SHA-1 gives us 20 bytes — plenty for a 5×5 symmetric grid + colour.
  return crypto.createHash('sha1').update(String(s)).digest();
}

// Turn a 3-byte slice into a pleasant saturated colour (HSL → RGB with
// medium lightness + high saturation), then pack into 0xRRGGBBAA.
function colourFrom(bytes) {
  const hue = bytes[0] / 255;          // 0..1
  const sat = 0.55 + (bytes[1] / 255) * 0.30;   // 0.55..0.85
  const lig = 0.40 + (bytes[2] / 255) * 0.15;   // 0.40..0.55
  const [r, g, b] = hslToRgb(hue, sat, lig);
  return (r << 24) | (g << 16) | (b << 8) | 0xff;
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const h2r = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) { return p + (q - p) * 6 * t; }
    if (t < 1 / 2) { return q; }
    if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
    return p;
  };
  return [
    Math.round(h2r(h + 1 / 3) * 255),
    Math.round(h2r(h)         * 255),
    Math.round(h2r(h - 1 / 3) * 255),
  ];
}

/**
 * Generate a PNG identicon buffer for a username.
 * @param {string} username
 * @param {number} [size=128]  Side length in pixels.
 * @returns {Promise<Buffer>}  PNG bytes.
 */
export function identiconFor(username, size = 128) {
  const h = hash32(username || '');
  const colour = colourFrom(h.subarray(0, 3));
  const bg     = 0xf0f0f0ff;

  // 5-column grid, columns 3 and 4 mirror columns 1 and 0. 5 rows × 3 unique
  // columns = 15 bits, easily fits in 2 of the 20 available hash bytes.
  const bits = [];
  for (let i = 0; i < 15; i++) {
    const byte = h[3 + Math.floor(i / 8)];
    bits.push((byte >> (i % 8)) & 1);
  }

  // Build a 5×5 matrix from 5 rows × 3 columns (mirrored).
  const gridSize = 5;
  const cell = Math.floor(size / gridSize);
  const img = new Jimp({ width: size, height: size, color: bg });

  let idx = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < 3; col++) {
      if (bits[idx++]) {
        // Paint cell (row, col) and its mirror (row, 4-col).
        for (const c of [col, gridSize - 1 - col]) {
          const x0 = c * cell;
          const y0 = row * cell;
          for (let y = 0; y < cell; y++) {
            for (let x = 0; x < cell; x++) {
              img.setPixelColor(colour, x0 + x, y0 + y);
            }
          }
        }
      }
    }
  }

  return img.getBuffer('image/png');
}
