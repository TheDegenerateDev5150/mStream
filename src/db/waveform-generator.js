import child from 'child_process';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';
import { ffmpegBin, getResolvedSource } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

let runningTask;

/**
 * Spawn the waveform generator script as a child process.
 * Iterates all tracks in the DB and generates missing waveform cache files.
 * Returns false if ffmpeg is not available or a task is already running.
 */
export function run() {
  if (runningTask !== undefined) {
    return false;
  }

  // Don't spawn if ffmpeg was never resolved
  if (!getResolvedSource()) {
    winston.warn('[waveform-generator] Skipping — ffmpeg not available');
    return false;
  }

  const jsonLoad = {
    dbPath: path.join(config.program.storage.dbDirectory, 'mstream.db'),
    ffmpegBin: ffmpegBin(),
    waveformCacheDir: path.join(__dirname, '../../waveform-cache'),
  };

  const forkedTask = child.fork(
    path.join(__dirname, './waveform-generator-script.js'),
    [JSON.stringify(jsonLoad)],
    { silent: true }
  );

  winston.info('[waveform-generator] Started');
  runningTask = forkedTask;

  forkedTask.stdout.on('data', (data) => {
    winston.info(`[waveform-generator] ${data.toString().trim()}`);
  });

  forkedTask.stderr.on('data', (data) => {
    winston.error(`[waveform-generator] ${data.toString().trim()}`);
  });

  forkedTask.on('close', (code) => {
    winston.info(`[waveform-generator] Completed with code ${code}`);
    runningTask = undefined;
  });

  return true;
}
