import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { nanoid } from 'nanoid';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { addToKillQueue, removeFromKillQueue } from '../state/kill-list.js';
import { getDirname } from '../util/esm-helpers.js';
import * as waveformGenerator from './waveform-generator.js';
import * as dlnaApi from '../api/dlna.js';

const __dirname = getDirname(import.meta.url);

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
let scanIntervalTimer = null;
// True when any scan in the current batch added, changed, or removed tracks.
// Reset to false after the waveform post-processor runs.
let anyScansChanged = false;
// SQLite-format timestamp ("YYYY-MM-DD HH:MM:SS" UTC) captured when a new
// batch starts. Passed to the waveform generator so it can query only
// tracks created during this batch instead of the whole library.
let batchStartTime = null;

// ── Rust parser binary detection ────────────────────────────────────────────

const ext = process.platform === 'win32' ? '.exe' : '';
// Detect musl libc (Alpine, Void, distroless musl, etc.) — glibcVersionRuntime is undefined on musl
const isMusl = process.platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
const libcSuffix = isMusl ? '-musl' : '';
const rustParserDir = path.join(__dirname, '../../rust-parser');
const prebuiltBin = path.join(__dirname, `../../bin/rust-parser/rust-parser-${process.platform}-${process.arch}${libcSuffix}${ext}`);
const localBuildBin = path.join(rustParserDir, `target/release/rust-parser${ext}`);
let rustParserBin = null;
let rustBinaryReady = false;
let rustParserDisabled = false;

function findRustParser() {
  if (rustParserDisabled) { return false; }
  if (rustBinaryReady) { return true; }

  const markReady = (binPath) => {
    rustParserBin = binPath;
    // Docker / tarball extraction can strip the execute bit — restore it.
    // No-op on Windows; if chmod fails (read-only volume etc.) the later
    // spawn will fail and trigger the JS fallback in runScan().
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
    rustBinaryReady = true;
    return true;
  };

  // Check local build first (may be newer than prebuilt during development)
  if (fs.existsSync(localBuildBin)) { return markReady(localBuildBin); }
  if (fs.existsSync(prebuiltBin)) { return markReady(prebuiltBin); }

  // Try to build from source
  winston.info('Rust parser binary not found — building from source...');
  try {
    child.execSync('cargo build --release', { cwd: rustParserDir, stdio: 'pipe', timeout: 300000 });
    if (fs.existsSync(localBuildBin)) {
      markReady(localBuildBin);
      winston.info('Rust parser built successfully');
      return true;
    }
  } catch (err) {
    winston.warn(`Failed to build Rust parser: ${err.message}. Falling back to JS parser.`);
  }
  return false;
}

// ── Scan task management ────────────────────────────────────────────────────

function addScanTask(vpath, forceRescan = false) {
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid(8), forceRescan };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

function scanAll() {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name);
  }
}

function rescanAll() {
  const libraries = db.getAllLibraries();
  for (const lib of libraries) {
    addScanTask(lib.name, true);
  }
}

function nextTask() {
  if (
    taskQueue.length > 0
    && runningTasks.size < config.program.scanOptions.maxConcurrentTasks
    && !vpathLimiter.has(taskQueue[taskQueue.length - 1].vpath)
  ) {
    runScan(taskQueue.pop());
  }
}

function handleScannerLine(line) {
  if (!line) { return; }
  // Structured events from the scanner are emitted as single-line JSON;
  // see scanner.mjs and rust-parser/src/main.rs for the event shapes.
  if (line[0] === '{') {
    try {
      const evt = JSON.parse(line);
      if (evt?.event === 'scanComplete') {
        winston.info(`Scan complete: ${evt.filesProcessed} files processed, ${evt.staleEntriesRemoved} stale entries removed`);
        if (evt.filesProcessed > 0 || evt.staleEntriesRemoved > 0) {
          anyScansChanged = true;
        }
        return;
      }
    } catch (_) { /* not a structured event — fall through and log as plain text */ }
  }
  winston.info(line);
}

function attachScanHandlers(forkedScan, scanObj) {
  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  // Ensure scanner is killed on server shutdown; keep a handle so we can
  // drop the entry from the kill queue when the process exits cleanly —
  // otherwise the queue would grow unbounded across scheduled scans.
  const killFn = () => { try { forkedScan.kill(); } catch (_) {} };
  forkedScan._killFn = killFn;
  addToKillQueue(killFn);

  // Line-buffer stdout so structured JSON events parse cleanly regardless
  // of how the OS chunks the pipe data.
  let stdoutBuffer = '';
  forkedScan.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      handleScannerLine(line.trim());
    }
  });
  forkedScan.stdout.on('end', () => {
    if (stdoutBuffer.trim()) { handleScannerLine(stdoutBuffer.trim()); }
    stdoutBuffer = '';
  });

  // Line-buffer stderr the same way as stdout. Scanner lines prefixed with
  // "Warning:" are recoverable (metadata parse failures fall back to null
  // tags; the track still gets indexed) and are logged at warn level so a
  // library with malformed ID3 tags doesn't flood error-level log streams.
  // Anything else on stderr is treated as a real error.
  let stderrBuffer = '';
  const handleStderrLine = (line) => {
    if (!line) { return; }
    if (line.startsWith('Warning:')) {
      winston.warn(`File scan: ${line}`);
    } else {
      winston.error(`File scan error: ${line}`);
    }
  };
  forkedScan.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      handleStderrLine(line.trim());
    }
  });
  forkedScan.stderr.on('end', () => {
    if (stderrBuffer.trim()) { handleStderrLine(stderrBuffer.trim()); }
    stderrBuffer = '';
  });
}

function onScanClose(forkedScan, scanObj, code) {
  winston.info(`File scan completed with code ${code}`);
  runningTasks.delete(forkedScan);
  vpathLimiter.delete(scanObj.vpath);
  if (forkedScan._killFn) { removeFromKillQueue(forkedScan._killFn); }

  // Clean up progress row (scanner should have deleted it, but handle crashes)
  try {
    db.getDB()?.prepare('DELETE FROM scan_progress WHERE scan_id = ?').run(scanObj.id);
  } catch (_) {}

  nextTask();

  // When all scans are done, run the waveform post-processor — but only if
  // some scan actually changed the DB. A scheduled rescan over an unchanged
  // library shouldn't fork a child just to SELECT and return "up to date".
  if (runningTasks.size === 0 && taskQueue.length === 0 && anyScansChanged) {
    const since = batchStartTime;
    anyScansChanged = false;
    batchStartTime = null;
    if (config.program.scanOptions.generateWaveforms !== false) {
      waveformGenerator.run(since);
    }
    // Bump SystemUpdateID so DLNA control points refresh their caches.
    // Safe to call whether or not DLNA is enabled.
    dlnaApi.bumpSystemUpdateID();
  }
}

function launchJsScanner(scanObj, jsonLoad, library, { isFallback = false } = {}) {
  const forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started${isFallback ? ' (JS fallback)' : ''} on ${library.root_path}`);
  attachScanHandlers(forkedScan, scanObj);
  forkedScan.on('close', (code) => onScanClose(forkedScan, scanObj, code));
  return forkedScan;
}

function runScan(scanObj) {
  const library = db.getLibraryByName(scanObj.vpath);
  if (!library) {
    winston.warn(`Library '${scanObj.vpath}' not found in database, skipping scan`);
    return;
  }

  // Stamp the start of the batch using SQLite's own clock so the string
  // format ("YYYY-MM-DD HH:MM:SS") lines up with rows' created_at defaults
  // and lexical comparison is valid.
  if (batchStartTime === null) {
    try {
      batchStartTime = db.getDB()?.prepare("SELECT datetime('now') AS ts").get()?.ts || null;
    } catch (_) { batchStartTime = null; }
  }

  const dbPath = path.join(config.program.storage.dbDirectory, 'mstream.db');

  const jsonLoad = {
    dbPath: dbPath,
    libraryId: library.id,
    vpath: scanObj.vpath,
    directory: library.root_path,
    skipImg: config.program.scanOptions.skipImg,
    albumArtDirectory: config.program.storage.albumArtDirectory,
    scanId: scanObj.id,
    compressImage: config.program.scanOptions.compressImage,
    supportedFiles: config.program.supportedAudioFiles,
    scanCommitInterval: config.program.scanOptions.scanCommitInterval || 25,
    forceRescan: scanObj.forceRescan || false
  };

  if (!findRustParser()) {
    launchJsScanner(scanObj, jsonLoad, library);
    return;
  }

  const rustScan = child.spawn(rustParserBin, [JSON.stringify(jsonLoad)], { stdio: ['ignore', 'pipe', 'pipe'] });
  winston.info(`File scan started (Rust) on ${library.root_path}`);

  let fellBack = false;
  rustScan.on('error', (err) => {
    if (fellBack) { return; }
    fellBack = true;
    winston.warn(`Rust parser failed to start (${err.code || 'ERR'}), falling back to JS scanner: ${err.message}`);
    // Permission / ABI / exec errors don't resolve themselves — disable Rust
    // for the rest of this process lifetime so we don't retry every scan.
    rustParserDisabled = true;
    runningTasks.delete(rustScan);
    if (rustScan._killFn) { removeFromKillQueue(rustScan._killFn); }
    launchJsScanner(scanObj, jsonLoad, library, { isFallback: true });
  });

  attachScanHandlers(rustScan, scanObj);
  rustScan.on('close', (code) => {
    if (fellBack) { return; }
    onScanClose(rustScan, scanObj, code);
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export function scanVPath(vPath) {
  addScanTask(vPath);
}

export { scanAll, rescanAll };

export function isScanning() {
  return runningTasks.size > 0;
}

export function getAdminStats() {
  return {
    taskQueue,
    vpaths: [...vpathLimiter]
  };
}

export function runAfterBoot() {
  // Clear any stale scan progress rows left from a previous crash
  try { db.getDB()?.prepare('DELETE FROM scan_progress').run(); } catch (_) {}

  // Check if a migration flagged a force rescan
  const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
  let pendingRescan = false;
  try {
    if (fs.existsSync(markerPath)) {
      pendingRescan = true;
      fs.unlinkSync(markerPath);
      winston.info('Force rescan pending from migration — will rescan all libraries');
    }
  } catch (_) {}

  setTimeout(() => {
    if (pendingRescan) {
      // Migration requires full rescan — force re-parse all files
      rescanAll();
    } else if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanAll();
    }
    if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

export function resetScanInterval() {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}
