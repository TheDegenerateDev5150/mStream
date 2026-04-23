// Waveform generation helpers for the on-demand fallback path.
//
// The primary waveform generator now lives in rust-parser (symphonia-based,
// runs inline during the scan, writes .bin files keyed by audio_hash). This
// module is the fallback used by the on-demand endpoint (src/api/waveform.js)
// when the Rust scanner didn't produce a cache entry — typically because the
// user is on the JS fallback scanner, the file is Opus (symphonia 0.5 has no
// decoder), or the file was added/played before a scan completed.
//
// generateWaveformBars() here spawns ffmpeg; the cache helpers read/write
// the same .bin format the Rust scanner uses so both paths interoperate.
//
// generateWaveformBars():
//   1. spawns ffmpeg to decode the audio to mono 8-bit unsigned PCM at 8 kHz
//      (plenty of resolution for 800 visual bars; 4× smaller than float32)
//   2. buffers up to MAX_PCM_BYTES of PCM output
//   3. downsamples to NUM_BARS entries of 0-255 peak magnitude
//
// pcm_u8 encodes silence as 128 and peaks as 0/255. We measure magnitude as
// |sample - 128| (0..127) and rescale to 0..255 by doubling.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const NUM_BARS = 800;

// On-disk cache format: raw byte array, exactly NUM_BARS bytes, one per bar.
// Files are keyed by track content hash.
const CACHE_EXT = '.bin';

function cacheFilePath(dir, fileHash) {
  return path.join(dir, fileHash + CACHE_EXT);
}

/** Synchronous existence check — used by the bulk generator's pre-scan. */
export function hasCachedWaveform(dir, fileHash) {
  return fs.existsSync(cacheFilePath(dir, fileHash));
}

/**
 * Read a cached waveform. Returns null if nothing is cached OR the file
 * exists but isn't exactly NUM_BARS bytes (partial write from a prior
 * crash, wrong-format leftover, etc.) — in which case the caller
 * regenerates, so the corrupt cache file self-heals next time.
 */
export async function readCachedWaveform(dir, fileHash) {
  let buf;
  try {
    buf = await fsp.readFile(cacheFilePath(dir, fileHash));
  } catch (err) {
    if (err.code === 'ENOENT') { return null; }
    throw err;
  }
  if (buf.length !== NUM_BARS) { return null; }
  return Array.from(buf);
}

/**
 * Write a cached waveform atomically: write to a sibling `.bin.tmp`, then
 * rename to `.bin`. Prevents partial writes from a process crash or
 * power-loss leaving a truncated file that `readCachedWaveform` would see
 * as valid. Mirrors the atomic-write pattern the Rust scanner uses on the
 * scan path.
 *
 * Values outside [0, 255] are masked to 8 bits by Buffer.from — shouldn't
 * happen given generateWaveformBars() clamps on output, but the clamp is
 * implicit rather than asserted.
 */
export async function writeCachedWaveform(dir, fileHash, bars) {
  const finalPath = cacheFilePath(dir, fileHash);
  const tmpPath = path.join(dir, fileHash + CACHE_EXT + '.tmp');
  await fsp.writeFile(tmpPath, Buffer.from(bars));
  await fsp.rename(tmpPath, finalPath);
}

const FFMPEG_TIMEOUT = 30000;            // 30 seconds per track
const MAX_PCM_BYTES = 2 * 1024 * 1024;   // 2 MB — plenty for 8-bit/8kHz/mono
                                          // (≈4 min at 8000 B/s)

function downsample(pcmBuffer, numBars) {
  const total = pcmBuffer.length;
  if (total === 0) { return new Array(numBars).fill(0); }

  const bars = new Array(numBars);
  for (let i = 0; i < numBars; i++) {
    const start = Math.floor(i * total / numBars);
    const end = Math.floor((i + 1) * total / numBars);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = pcmBuffer[j] - 128;          // deviation from silence
      const mag = v < 0 ? -v : v;            // |v| in [0, 128]
      if (mag > peak) { peak = mag; }
    }
    bars[i] = Math.min(255, peak * 2);       // rescale to [0, 255]
  }
  return bars;
}

/**
 * Generate waveform bars for an audio file.
 * @param {string} audioPath  absolute path to audio file
 * @param {string} ffmpegBin  path or command name for ffmpeg
 * @returns {Promise<number[]>} NUM_BARS entries in [0, 255]
 */
export function generateWaveformBars(audioPath, ffmpegBin) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Cap internal threads to 1 — the outer worker pool already provides
      // concurrency; extra threads per process just fight for cores.
      '-threads', '1',
      '-i', audioPath,
      // Drop embedded cover art / data / subtitle streams so ffmpeg doesn't
      // waste cycles decoding a JPEG we'd discard anyway.
      '-vn', '-dn', '-sn',
      '-ac', '1',                // mono
      '-ar', '8000',             // 8 kHz — 800 bars × ~10 samples/bar for a 10s clip
      '-f', 'u8',
      '-acodec', 'pcm_u8',
      'pipe:1'
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    proc.stdout.on('data', (chunk) => {
      if (truncated) { return; }
      if (totalBytes + chunk.length > MAX_PCM_BYTES) {
        // Keep what fits in the budget, then stop the process — we have
        // enough samples for a reasonable visualization of very long tracks.
        const remaining = MAX_PCM_BYTES - totalBytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          totalBytes += remaining;
        }
        truncated = true;
        try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
      reject(new Error('ffmpeg timeout'));
    }, FFMPEG_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // SIGTERM (code null or non-zero) is expected when we truncated on
      // purpose; accept the partial data we collected.
      if (!truncated && code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      if (chunks.length === 0) {
        return reject(new Error('ffmpeg produced no audio data'));
      }
      const pcm = Buffer.concat(chunks);
      resolve(downsample(pcm, NUM_BARS));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
