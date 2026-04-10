// Waveform generation for the Velvet UI progress bar.
// Uses ffmpeg to extract PCM peaks, downsamples to ~800 bars,
// and caches the result as JSON on disk.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from '../db/manager.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { getVPathInfo } from '../util/vpath.js';

const __dirname = getDirname(import.meta.url);
const CACHE_DIR = path.join(__dirname, '../../waveform-cache');
const NUM_BARS = 800;

// In-memory LRU to avoid repeated disk reads
const memCache = new Map();
const MEM_MAX = 200;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(filepath) {
  return crypto.createHash('md5').update(filepath).digest('hex');
}

function cachePath(key) {
  return path.join(CACHE_DIR, key + '.json');
}

// Downsample raw PCM float32 peaks into NUM_BARS 0-255 values
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

// Generate waveform data from audio file using ffmpeg
function generateWaveform(audioPath) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin();
    // Only verify existence for absolute paths. When ffmpegBin() returns a
    // bare command name (system-PATH fallback), leave the check to spawn().
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
      return reject(new Error('ffmpeg not available'));
    }

    // ffmpeg: decode to mono float32 PCM at 8kHz (enough for visualization)
    const args = [
      '-i', audioPath,
      '-ac', '1',           // mono
      '-ar', '8000',        // 8kHz sample rate
      '-f', 'f32le',        // raw float32 little-endian
      '-acodec', 'pcm_f32le',
      'pipe:1'
    ];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let totalBytes = 0;
    const MAX_BYTES = 8 * 1024 * 1024; // 8MB safety limit

    proc.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BYTES) {
        chunks.push(chunk);
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('ffmpeg timeout'));
    }, 30000);

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

    const key = cacheKey(filepath);

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

    try {
      const waveform = await generateWaveform(absolutePath);

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
