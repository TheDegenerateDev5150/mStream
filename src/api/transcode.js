import { spawn } from 'child_process';
import { PassThrough, Readable } from 'stream';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import { ensureFfmpeg, ffmpegBin, startAutoUpdate, stopAutoUpdate } from '../util/ffmpeg-bootstrap.js';

const codecMap = {
  'mp3':  { codec: 'libmp3lame', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus',    contentType: 'audio/ogg' },
  'aac':  { codec: 'aac',        contentType: 'audio/aac' }
};

const algoSet = new Set(['buffer', 'stream']);
const bitrateSet = new Set(['64k', '128k', '192k', '96k']);

export function getTransAlgos() { return Array.from(algoSet); }
export function getTransBitrates() { return Array.from(bitrateSet); }
export function getTransCodecs() { return Object.keys(codecMap); }

let lockInit = false;
let ffmpegPath = null;

async function init() {
  winston.info('Checking ffmpeg...');
  await ensureFfmpeg();

  ffmpegPath = ffmpegBin();

  const { access } = await import('node:fs/promises');
  try {
    await access(ffmpegPath);
  } catch {
    throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
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

export function isEnabled() {
  return lockInit === true && config.program.transcode.enabled === true;
}

export function isDownloaded() {
  return lockInit;
}

export async function downloadedFFmpeg() {
  await init();
}

// Spawn ffmpeg and return a readable stream of the transcoded audio.
// Command: ffmpeg -i <input> -vn -f <format> -acodec <codec> -ab <bitrate> pipe:1
function spawnTranscode(inputPath, codec, bitrate) {
  const args = [
    '-i', inputPath,
    '-vn',                          // no video
    '-f', codec,                    // output format
    '-acodec', codecMap[codec].codec, // audio codec
    '-ab', bitrate,                 // audio bitrate
    'pipe:1'                        // output to stdout
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stderr.on('data', () => {}); // suppress ffmpeg stderr output

  proc.on('error', err => {
    winston.error('Transcoding spawn error', { stack: err });
  });

  proc.on('close', code => {
    if (code !== 0 && code !== null) {
      winston.error(`FFmpeg exited with code ${code} for ${inputPath}`);
    }
  });

  return proc.stdout;
}

const transCache = {};

export function setup(mstream) {
  if (config.program.transcode.enabled === true) {
    init().catch(err => {
      winston.error('Failed to initialize FFmpeg', { stack: err });
    });
  }

  mstream.all("/transcode/{*filepath}", (req, res) => {
    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const algo = algoSet.has(req.query.algo) ? req.query.algo : config.program.transcode.algorithm;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

    const pathInfo = vpath.getVPathInfo(req.params.filepath, req.user);

    if (req.method === 'GET') {
      // Check cache
      const cacheKey = `${pathInfo.fullPath}|${bitrate}|${codec}`;
      if (transCache[cacheKey]) {
        const t = transCache[cacheKey].deref();
        if (t !== undefined) {
          res.header({
            'Accept-Ranges': 'bytes',
            'Content-Type': codecMap[codec].contentType,
            'Content-Length': t.contentLength
          });
          Readable.from(t.bufs).pipe(res);
          return;
        }
      }

      if (algo === 'stream') {
        res.header({ 'Content-Type': codecMap[codec].contentType });
        return spawnTranscode(pathInfo.fullPath, codec, bitrate).pipe(res);
      }

      // Buffer mode: collect output, cache, then send
      const stream = spawnTranscode(pathInfo.fullPath, codec, bitrate);
      const bufs = [];
      let contentLength = 0;

      stream.on('data', chunk => {
        bufs.push(chunk);
        contentLength += chunk.length;
      });

      stream.on('end', () => {
        res.header({
          'Accept-Ranges': 'bytes',
          'Content-Type': codecMap[codec].contentType,
          'Content-Length': contentLength
        });
        transCache[cacheKey] = new WeakRef({ contentLength, bufs });
        Readable.from(bufs).pipe(res);
      });

      stream.on('error', err => {
        winston.error('Transcoding stream error', { stack: err });
        if (!res.headersSent) {
          res.status(500).json({ error: 'transcoding failed' });
        }
      });
    } else {
      res.sendStatus(405);
    }
  });
}
