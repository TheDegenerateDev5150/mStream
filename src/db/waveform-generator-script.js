/**
 * Waveform generator — batch post-processor.
 *
 * Spawned as a child process by waveform-generator.js after a scan completes.
 * Reads all tracks from the database, checks for existing waveform cache files,
 * and generates missing ones using ffmpeg.
 *
 * Input (JSON argv): {
 *   dbPath, ffmpegBin, waveformCacheDir,
 *   sinceTimestamp?,      // filter to tracks created since this timestamp
 *   concurrency?          // how many ffmpeg processes to run in parallel (default 2)
 * }
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  generateWaveformBars,
  hasCachedWaveform,
  writeCachedWaveform,
} from './waveform-lib.js';

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

const CONCURRENCY = Math.max(1, loadJson.concurrency || 2);

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

  // Filter to tracks that don't have a waveform cache file yet.
  const missing = [];
  for (const track of tracks) {
    if (!hasCachedWaveform(loadJson.waveformCacheDir, track.file_hash)) {
      missing.push({
        filepath: track.filepath,
        fileHash: track.file_hash,
        absolutePath: path.join(track.root_path, track.filepath),
      });
    }
  }

  if (missing.length === 0) {
    console.log('All waveforms up to date');
    return;
  }

  console.log(
    `Generating waveforms for ${missing.length} of ${tracks.length} tracks ` +
    `(concurrency ${CONCURRENCY})`
  );

  // Worker-pool pattern: up to CONCURRENCY workers pull from a shared queue.
  // ffmpeg is CPU-bound for this pipeline, so running too many in parallel
  // just causes contention — the default of 2 is a conservative sweet spot
  // for a multi-core machine that's also serving HTTP traffic.
  const queue = missing.slice();
  let generated = 0;
  let failed = 0;

  async function processOne(track) {
    // Verify the audio file still exists before processing
    try { await fsp.access(track.absolutePath); }
    catch (_) { failed++; return; }

    try {
      const waveform = await generateWaveformBars(track.absolutePath, loadJson.ffmpegBin);
      await writeCachedWaveform(loadJson.waveformCacheDir, track.fileHash, waveform);
      generated++;
    } catch (_err) {
      failed++;
      // Individual failures are expected (corrupt files, unsupported formats).
      // Don't spam logs — the final summary covers them.
    }

    const done = generated + failed;
    if (done % 50 === 0) {
      console.log(`Progress: ${done}/${missing.length} (${generated} generated, ${failed} failed)`);
    }
  }

  async function worker() {
    while (queue.length > 0) {
      const track = queue.shift();
      if (!track) { return; }
      await processOne(track);
    }
  }

  const workerCount = Math.min(CONCURRENCY, missing.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  console.log(
    `Done: ${generated} generated, ${failed} failed, ` +
    `${tracks.length - missing.length} already cached`
  );
}
