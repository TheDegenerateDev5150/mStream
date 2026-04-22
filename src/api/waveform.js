// On-demand waveform endpoint for the player's progress bar.
// Used by both the default and Velvet UIs. Caches generated waveforms to
// disk (keyed by content hash) and keeps a hot set in memory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { ffmpegBin, getResolvedSource } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { getVPathInfo } from '../util/vpath.js';
import { generateWaveformBars } from '../db/waveform-lib.js';

const __dirname = getDirname(import.meta.url);
const LEGACY_CACHE_DIR = path.join(__dirname, '../../waveform-cache');

// In-memory LRU to avoid repeated disk reads
const memCache = new Map();
const MEM_MAX = 200;

function cacheDir() {
  return config.program.storage.waveformCacheDirectory;
}

function ensureCacheDir() {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cachePath(fileHash) {
  return path.join(cacheDir(), fileHash + '.json');
}

// Legacy location (pre-6.4.4) was <install>/waveform-cache. If that dir has
// files and the configured location is untouched, log a note once at startup
// so users can copy/move the cache into the persistent path if they want to
// avoid a one-time regeneration pass.
function logLegacyCacheNoteIfNeeded() {
  try {
    if (LEGACY_CACHE_DIR === cacheDir()) { return; }
    if (!fs.existsSync(LEGACY_CACHE_DIR)) { return; }
    const hasLegacyFiles = fs.readdirSync(LEGACY_CACHE_DIR).some(f => f.endsWith('.json'));
    if (!hasLegacyFiles) { return; }
    winston.info(`[waveform] Old cache dir "${LEGACY_CACHE_DIR}" still has files. New default is "${cacheDir()}" — copy/move the *.json files there to avoid regenerating waveforms on the next scan.`);
  } catch (_) { /* non-fatal */ }
}

export function setup(mstream) {
  ensureCacheDir();
  logLegacyCacheNoteIfNeeded();

  mstream.get('/api/v1/db/waveform', async (req, res) => {
    const filepath = req.query.filepath;
    if (!filepath) {
      return res.status(400).json({ error: 'filepath required' });
    }

    // Parse and validate library access via getVPathInfo
    let pathInfo;
    try { pathInfo = getVPathInfo(filepath, req.user); } catch (_) {
      return res.status(403).json({ error: 'access denied' });
    }

    const absolutePath = pathInfo.fullPath;
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'file not found' });
    }

    // Look up the track's content hash from the database
    const lib = db.getLibraryByName(pathInfo.vpath);
    const track = lib && db.getDB()?.prepare(
      'SELECT file_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);

    if (!track?.file_hash) {
      return res.status(404).json({ error: 'track not in database' });
    }

    const key = track.file_hash;

    // Check memory cache
    if (memCache.has(key)) {
      return res.json({ waveform: memCache.get(key) });
    }

    // Check disk cache
    const diskPath = cachePath(key);
    try {
      const cached = await fsp.readFile(diskPath, 'utf8');
      const waveform = JSON.parse(cached);
      // Store in memory cache
      if (memCache.size >= MEM_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
      }
      memCache.set(key, waveform);
      return res.json({ waveform });
    } catch (_) {
      // Not cached — generate
    }

    if (!getResolvedSource()) {
      return res.status(503).json({ error: 'ffmpeg not ready' });
    }

    const bin = ffmpegBin();
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
      return res.status(503).json({ error: 'ffmpeg not available' });
    }

    try {
      const waveform = await generateWaveformBars(absolutePath, bin);

      // Save to disk cache (fire and forget)
      fsp.writeFile(diskPath, JSON.stringify(waveform)).catch(() => {});

      // Save to memory cache
      if (memCache.size >= MEM_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
      }
      memCache.set(key, waveform);

      res.json({ waveform });
    } catch (err) {
      res.status(500).json({ error: 'waveform generation failed' });
    }
  });
}
