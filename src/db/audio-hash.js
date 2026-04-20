/**
 * Dual-hash computation for the scanner.
 *
 *   file_hash  — MD5 of the whole file. Changes on any byte change.
 *   audio_hash — MD5 of just the audio payload region (tag regions
 *                stripped). Stable across tag edits.
 *
 * audio_hash is the preferred identity key for user-facing state
 * (stars, play counts, bookmarks, play queue). It is NULL for formats
 * whose audio boundary we don't yet parse — callers fall back to
 * file_hash in that case.
 *
 * Supported formats for audio_hash: MP3 (ID3v2 prefix + ID3v1 suffix
 * stripped) and FLAC (metadata blocks skipped). Everything else returns
 * { audioHash: null }.
 *
 * MUST stay byte-identical with rust-parser/src/main.rs `audio_hash` fn.
 * Parity is enforced by test/audio-hash-parity.test.mjs — any change to
 * the byte-range logic here must land there too, in the same commit.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

// ── Whole-file MD5 (streamed) ──────────────────────────────────────────────

function hashRange(filepath, start, end) {
  // end is exclusive. Pass null for "to EOF".
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const opts = { start };
    if (end != null) { opts.end = end - 1; }  // fs.createReadStream end is inclusive
    const stream = fs.createReadStream(filepath, opts);
    stream.on('data', chunk => md5.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(md5.digest('hex')));
  });
}

export function fileHashOf(filepath) {
  return hashRange(filepath, 0, null);
}

// ── Audio-region detection, per format ────────────────────────────────────

// ID3v2: 10-byte header at offset 0.
//   bytes 0..2: "ID3"
//   byte  3:    major version
//   byte  5:    flags (bit 0x10 = footer present)
//   bytes 6..9: synchsafe 32-bit tag size (NOT counting the header; nor
//               the optional 10-byte footer)
// Audio starts at 10 + tagSize (+ 10 if footer flag set).
async function mp3AudioRange(filepath, fileSize) {
  if (fileSize < 10) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const head = Buffer.alloc(10);
    await fd.read(head, 0, 10, 0);

    let start = 0;
    if (head[0] === 0x49 /*I*/ && head[1] === 0x44 /*D*/ && head[2] === 0x33 /*3*/) {
      // Synchsafe integer: each of the 4 bytes uses only 7 bits (MSB always 0).
      const tagSize = ((head[6] & 0x7f) << 21)
                    | ((head[7] & 0x7f) << 14)
                    | ((head[8] & 0x7f) << 7)
                    |  (head[9] & 0x7f);
      start = 10 + tagSize;
      if (head[5] & 0x10) { start += 10; }  // footer present
    }

    // ID3v1: exactly 128 bytes at EOF, starting with "TAG" (0x54 0x41 0x47).
    let end = fileSize;
    if (fileSize >= 128) {
      const trailer = Buffer.alloc(3);
      await fd.read(trailer, 0, 3, fileSize - 128);
      if (trailer[0] === 0x54 && trailer[1] === 0x41 && trailer[2] === 0x47) {
        end = fileSize - 128;
      }
    }

    // APEv2 footer: 32-byte footer with signature "APETAGEX" (0x41 0x50 0x45 0x54 0x41 0x47 0x45 0x58).
    // Sits before the ID3v1 block if both are present. We check both
    // candidate offsets and strip only if the signature matches.
    const apeProbe = Buffer.alloc(8);
    const tryApeAt = async (footerStart) => {
      if (footerStart < 0) { return false; }
      await fd.read(apeProbe, 0, 8, footerStart);
      return apeProbe.toString('latin1') === 'APETAGEX';
    };
    // `tagSize` here is read from the APEv2 footer's size field.
    const apeTailSize = async (footerStart) => {
      const hdr = Buffer.alloc(32);
      await fd.read(hdr, 0, 32, footerStart);
      // Bytes 12..15 = little-endian u32 tag size (excludes header).
      const sz = hdr.readUInt32LE(12);
      // Bytes 20..23 = flags; bit 31 (0x80000000) indicates header-present.
      const flags = hdr.readUInt32LE(20);
      const hasHeader = !!(flags & 0x80000000);
      return sz + (hasHeader ? 32 : 0);
    };

    const apeDirect = end - 32;
    if (await tryApeAt(apeDirect)) {
      end = end - await apeTailSize(apeDirect);
    }

    if (start >= end) { return null; }  // pathological — treat as unknown
    return { start, end };
  } finally {
    await fd.close();
  }
}

// FLAC: 4-byte "fLaC" magic followed by a chain of metadata blocks.
// Each block header: 1 byte [last_flag:1 | block_type:7] + 3 bytes big-endian length.
// Audio frames start immediately after the block whose last_flag is 1.
async function flacAudioRange(filepath, fileSize) {
  if (fileSize < 4) { return null; }

  const fd = await fsp.open(filepath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await fd.read(magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'fLaC') { return null; }

    let cursor = 4;
    const blkHdr = Buffer.alloc(4);
    while (cursor + 4 <= fileSize) {
      await fd.read(blkHdr, 0, 4, cursor);
      const last = (blkHdr[0] & 0x80) !== 0;
      const len = (blkHdr[1] << 16) | (blkHdr[2] << 8) | blkHdr[3];
      cursor += 4 + len;
      if (last) { break; }
      // Guard against a corrupt file that never asserts last_flag — bail
      // before we read past EOF with a "not a FLAC we recognise" answer.
      if (cursor > fileSize) { return null; }
    }
    if (cursor >= fileSize) { return null; }
    return { start: cursor, end: fileSize };
  } finally {
    await fd.close();
  }
}

// ── Public entry point ────────────────────────────────────────────────────

const EXTRACTORS = {
  mp3:  mp3AudioRange,
  flac: flacAudioRange,
};

/**
 * Compute both hashes for a file in a single pass.
 *
 * @param {string} filepath
 * @returns {Promise<{fileHash: string, audioHash: string|null, format: string|null}>}
 */
export async function computeHashes(filepath) {
  const stat = await fsp.stat(filepath);
  const fileSize = stat.size;
  const fileHash = await hashRange(filepath, 0, null);

  const ext = path.extname(filepath).slice(1).toLowerCase();
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    return { fileHash, audioHash: null, format: null };
  }

  let range;
  try { range = await extractor(filepath, fileSize); }
  catch { return { fileHash, audioHash: null, format: ext }; }

  if (!range) { return { fileHash, audioHash: null, format: ext }; }

  const audioHash = await hashRange(filepath, range.start, range.end);
  return { fileHash, audioHash, format: ext };
}

/**
 * Convenience: pick the best identity key for a track.
 * Preference: audio_hash (stable across tag edits), fall back to file_hash
 * (what older rows use and what formats we don't parse yet emit).
 */
export function canonicalHash(track) {
  if (!track) { return null; }
  return track.audio_hash || track.file_hash || null;
}
