// On-demand waveform endpoint for the player's progress bar.
// Used by both the default and Velvet UIs. Caches generated waveforms to
// disk (keyed by content hash) and keeps a hot set in memory.

import fs from 'node:fs';
import path from 'node:path';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { ffmpegBin, getResolvedSource } from '../util/ffmpeg-bootstrap.js';
import { getVPathInfo } from '../util/vpath.js';
import {
  generateWaveformBars,
  readCachedWaveform,
  writeCachedWaveform,
} from '../db/waveform-lib.js';

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

export function setup(mstream) {
  ensureCacheDir();

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

    function rememberInMem(waveform) {
      if (memCache.size >= MEM_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
      }
      memCache.set(key, waveform);
    }

    // Check disk cache (tries new .bin, falls back to legacy .json)
    const cached = await readCachedWaveform(cacheDir(), key);
    if (cached) {
      rememberInMem(cached);
      return res.json({ waveform: cached });
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
      writeCachedWaveform(cacheDir(), key, waveform).catch(() => {});

      rememberInMem(waveform);
      res.json({ waveform });
    } catch (err) {
      res.status(500).json({ error: 'waveform generation failed' });
    }
  });
}
