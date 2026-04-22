// Shared waveform generation helpers.
//
// Used by both the on-demand endpoint (src/api/waveform.js — single track,
// requested by the player) and the bulk post-scan generator
// (src/db/waveform-generator-script.js — batches entire library).
//
// Both call generateWaveformBars() which:
//   1. spawns ffmpeg to decode the audio to mono 8-bit unsigned PCM at 8 kHz
//      (plenty of resolution for 800 visual bars; 4× smaller than float32)
//   2. buffers up to MAX_PCM_BYTES of PCM output
//   3. downsamples to NUM_BARS entries of 0-255 peak magnitude
//
// pcm_u8 encodes silence as 128 and peaks as 0/255. We measure magnitude as
// |sample - 128| (0..127) and rescale to 0..255 by doubling.

import { spawn } from 'node:child_process';

export const NUM_BARS = 800;
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
      '-i', audioPath,
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
