import { spawn } from 'child_process';
import { Readable } from 'stream';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import path from 'node:path';
import {
  ensureFfmpeg,
  ffmpegBin,
  startAutoUpdate,
  stopAutoUpdate,
  getResolvedSource,
  reset as resetBootstrap
} from '../util/ffmpeg-bootstrap.js';

const codecMap = {
  'mp3':  { codec: 'libmp3lame', format: 'mp3',  contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus',    format: 'ogg',  contentType: 'audio/ogg' },
  'aac':  { codec: 'aac',        format: 'adts', contentType: 'audio/aac' }
};

const bitrateSet = new Set(['64k', '96k', '128k', '192k']);

export function getTransBitrates() { return Array.from(bitrateSet); }
export function getTransCodecs() { return Object.keys(codecMap); }

let lockInit = false;
let ffmpegPath = null;

async function init() {
  winston.info('Checking ffmpeg...');
  await ensureFfmpeg();

  // If the resolver found nothing (no bundled binary, no download, no system
  // PATH fallback), leave lockInit false and return. Downstream consumers
  // (transcode route, album-art embedding, waveforms, ytdl) will degrade
  // gracefully. The resolver already logged a detailed error.
  if (!getResolvedSource()) {
    winston.warn('FFmpeg unavailable — transcoding, album-art embedding, waveforms, and yt-dlp will be disabled');
    return;
  }

  ffmpegPath = ffmpegBin();

  // Only verify file existence when ffmpegBin() returned an absolute path
  // (i.e. a binary we manage on disk). Bare command names like 'ffmpeg' are
  // resolved by spawn() via PATH at call time, so we skip the access check.
  if (path.isAbsolute(ffmpegPath)) {
    const { access } = await import('node:fs/promises');
    try {
      await access(ffmpegPath);
    } catch {
      throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
    }
  }

  lockInit = true;
  winston.info('FFmpeg OK!');
  startAutoUpdate();
}

export function reset() {
  lockInit = false;
  ffmpegPath = null;
  stopAutoUpdate();
}

export function isDownloaded() {
  return lockInit;
}

export async function downloadedFFmpeg() {
  await init();
}

// ── Transcode cache ─────────────────────────────────────────────────────────
// Two-phase: strong reference for (song length + 2 min), then moved to weak.
// Only one copy in memory at a time. GC can reclaim weak entries under pressure.

const strongRefs = new Map();
const weakRefs = {};

function cacheGet(key) {
  const strong = strongRefs.get(key);
  if (strong) return strong;
  const weak = weakRefs[key]?.deref();
  if (!weak) delete weakRefs[key];
  return weak || null;
}

function cacheSet(key, entry, durationSec) {
  strongRefs.set(key, entry);
  const holdMs = (durationSec * 1000) + 120000; // song length + 2 minutes
  setTimeout(() => {
    strongRefs.delete(key);
    weakRefs[key] = new WeakRef(entry);
  }, holdMs);
}

// ── Spawn ffmpeg ────────────────────────────────────────────────────────────

function spawnTranscode(inputPath, codec, bitrate) {
  const entry = codecMap[codec];
  const args = [
    '-i', inputPath,
    '-vn',                          // no video
    '-f', entry.format,             // output container format
    '-acodec', entry.codec,         // audio codec
    '-ab', bitrate,                 // audio bitrate
    'pipe:1'                        // output to stdout
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stderr.on('data', () => {}); // suppress ffmpeg stderr

  proc.on('error', err => {
    winston.error('Transcoding spawn error', { stack: err });
  });

  return proc;
}

// ── Route ───────────────────────────────────────────────────────────────────

export function setup(mstream) {
  // Always try to bootstrap ffmpeg — album-art embedding, waveform generation,
  // and yt-dlp ingestion all use it independently of the old transcode toggle.
  init().catch(err => {
    winston.error('Failed to initialize FFmpeg', { stack: err });
  });

  mstream.get("/transcode/{*filepath}", (req, res) => {
    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

    // Express 5 {*filepath} returns an array — join back to a path string
    const filepath = Array.isArray(req.params.filepath)
      ? req.params.filepath.join('/')
      : req.params.filepath;
    const pathInfo = vpath.getVPathInfo(filepath, req.user);

    const cacheKey = `${pathInfo.fullPath}|${bitrate}|${codec}`;

    // ── Cache hit ────────────────────────────────────────────
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.header({
        'Accept-Ranges': 'bytes',
        'Content-Type': codecMap[codec].contentType,
        'Content-Length': cached.contentLength
      });
      Readable.from(cached.bufs).pipe(res);
      return;
    }

    // ── Look up duration for Content-Length estimate ──────────
    const lib = db.getLibraryByName(pathInfo.vpath);
    let duration = 0;
    if (lib) {
      const track = db.getDB()?.prepare(
        'SELECT duration FROM tracks WHERE filepath = ? AND library_id = ?'
      ).get(pathInfo.relativePath, lib.id);
      duration = track?.duration || 0;
    }

    const bitrateNum = parseInt(bitrate) * 1000; // '96k' → 96000
    const estimatedBytes = duration > 0
      ? Math.ceil(duration * bitrateNum / 8 * 1.05) // 5% container overhead
      : 0;

    // ── Set headers ──────────────────────────────────────────
    const headers = { 'Content-Type': codecMap[codec].contentType };
    if (estimatedBytes > 0) {
      headers['Content-Length'] = estimatedBytes;
      headers['Accept-Ranges'] = 'bytes';
    }
    res.header(headers);

    // ── Stream + collect for cache ───────────────────────────
    const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate);
    const bufs = [];
    let contentLength = 0;

    proc.stdout.on('data', chunk => {
      bufs.push(chunk);
      contentLength += chunk.length;
    });

    // Stream to client immediately
    proc.stdout.pipe(res);

    proc.on('close', code => {
      if (code !== 0 && code !== null) {
        winston.error(`FFmpeg exited with code ${code} for ${pathInfo.fullPath}`);
        return;
      }
      // Cache the result — strong for song length + 2 min, then weak
      if (contentLength > 0) {
        cacheSet(cacheKey, { contentLength, bufs }, duration);
      }
    });

    // Kill ffmpeg if client disconnects mid-stream
    res.on('close', () => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    });
  });
}
