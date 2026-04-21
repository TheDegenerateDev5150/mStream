/**
 * Waveform generator — batch post-processor.
 *
 * Spawned as a child process by waveform-generator.js after a scan completes.
 * Reads all tracks from the database, checks for existing waveform cache files,
 * and generates missing ones using ffmpeg.
 *
 * Input (JSON argv): { dbPath, ffmpegBin, waveformCacheDir }
 */

import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const NUM_BARS = 800;
const FFMPEG_TIMEOUT = 30000; // 30 seconds per track
const MAX_PCM_BYTES = 8 * 1024 * 1024; // 8MB safety limit

// ── Parse input ────────────────────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_error) {
  console.error('Failed to parse JSON input');
  process.exit(1);
}

if (!loadJson.dbPath || !loadJson.ffmpegBin || !loadJson.waveformCacheDir) {
  console.error('Missing required fields: dbPath, ffmpegBin, waveformCacheDir');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function cachePath(fileHash) {
  return path.join(loadJson.waveformCacheDir, fileHash + '.json');
}

function downsample(pcmBuffer, numBars) {
  const floats = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 4);
  const total = floats.length;
  if (total === 0) return new Array(numBars).fill(0);

  const chunkSize = Math.max(1, Math.floor(total / numBars));
  const bars = [];

  for (let i = 0; i < numBars; i++) {
    const start = Math.floor(i * total / numBars);
    const end = Math.min(start + chunkSize, total);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(floats[j]);
      if (v > peak) peak = v;
    }
    bars.push(Math.min(255, Math.round(peak * 255)));
  }

  return bars;
}

function generateWaveform(audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', audioPath,
      '-ac', '1',
      '-ar', '8000',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1'
    ];

    const proc = spawn(loadJson.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let totalBytes = 0;

    proc.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_PCM_BYTES) {
        chunks.push(chunk);
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('ffmpeg timeout'));
    }, FFMPEG_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || chunks.length === 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const pcm = Buffer.concat(chunks);
      const bars = downsample(pcm, NUM_BARS);
      resolve(bars);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

async function run() {
  // Ensure cache directory exists
  if (!fs.existsSync(loadJson.waveformCacheDir)) {
    fs.mkdirSync(loadJson.waveformCacheDir, { recursive: true });
  }

  // Open database (read-only — we never write to it). Even readers can be
  // briefly blocked during WAL checkpoints, so set a busy_timeout to avoid
  // spurious "database is locked" failures.
  const db = new DatabaseSync(loadJson.dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');

  // Get tracks with their library root paths and content hashes. When
  // invoked after a scan, task-queue passes a sinceTimestamp so we only
  // consider tracks added/modified in the current batch — rows
  // representing unchanged files keep their original created_at.
  let query = `
    SELECT t.filepath, t.file_hash, l.root_path
    FROM tracks t
    JOIN libraries l ON t.library_id = l.id
    WHERE t.file_hash IS NOT NULL`;
  const args = [];
  if (loadJson.sinceTimestamp) {
    query += ' AND t.created_at >= ?';
    args.push(loadJson.sinceTimestamp);
  }
  const tracks = db.prepare(query).all(...args);

  db.close();

  // Filter to tracks that don't have a waveform cache file yet
  const missing = [];
  for (const track of tracks) {
    const dest = cachePath(track.file_hash);
    if (!fs.existsSync(dest)) {
      missing.push({
        filepath: track.filepath,
        absolutePath: path.join(track.root_path, track.filepath),
        cacheFile: dest
      });
    }
  }

  if (missing.length === 0) {
    console.log('All waveforms up to date');
    return;
  }

  console.log(`Generating waveforms for ${missing.length} of ${tracks.length} tracks`);

  let generated = 0;
  let failed = 0;

  for (const track of missing) {
    try {
      // Verify the audio file still exists before processing
      await fsp.access(track.absolutePath);

      const waveform = await generateWaveform(track.absolutePath);
      await fsp.writeFile(track.cacheFile, JSON.stringify(waveform));
      generated++;

      if (generated % 50 === 0) {
        console.log(`Progress: ${generated + failed}/${missing.length} (${generated} generated, ${failed} failed)`);
      }
    } catch (err) {
      failed++;
      // Don't spam logs — just count failures. Individual errors are expected
      // for corrupted files, unsupported formats, etc.
    }
  }

  console.log(`Done: ${generated} generated, ${failed} failed, ${tracks.length - missing.length} already cached`);
}
