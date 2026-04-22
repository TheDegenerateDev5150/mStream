/**
 * cli-audio/index.js — CLI-player fallback for server-side playback.
 *
 * When the Rust audio binary isn't available, this module probes the host for
 * a known CLI music player and boots an adapter that mimics the Rust binary's
 * HTTP API. `proxyToCli` is a drop-in replacement for `proxyToRust`.
 *
 * Priority order is defined in PLAYERS below — first installed wins.
 */

import child_process from 'child_process';
import winston from 'winston';
import { MpvAdapter } from './mpv.js';
import { VlcAdapter } from './vlc.js';
import { MplayerAdapter } from './mplayer.js';

/**
 * Priority list. First entry whose binary is found on PATH is used.
 * `probeArgs` should be a lightweight flag that returns quickly and exits 0
 * (or at least produces version text without blocking on stdin).
 */
export const PLAYERS = [
  { name: 'mpv',     binary: 'mpv',     probeArgs: ['--version'], AdapterClass: MpvAdapter,     label: 'mpv' },
  { name: 'vlc',     binary: 'vlc',     probeArgs: ['--version'], AdapterClass: VlcAdapter,     label: 'VLC' },
  { name: 'mplayer', binary: 'mplayer', probeArgs: ['-v'],        AdapterClass: MplayerAdapter, label: 'MPlayer' },
];

function probe(binary, args) {
  try {
    const res = child_process.spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (res.error) { return false; }
    const out = (res.stdout || '') + (res.stderr || '');
    // Most players print a version banner; as long as the binary resolved and
    // produced output, count it as available. Exit code varies (mplayer -v can
    // return non-zero because it expects a file argument).
    return out.length > 0;
  } catch (_e) {
    return false;
  }
}

/**
 * Returns the subset of PLAYERS that are actually installed, in priority order.
 */
export function detectAvailablePlayers() {
  const found = [];
  for (const p of PLAYERS) {
    if (probe(p.binary, p.probeArgs)) { found.push(p.name); }
  }
  return found;
}

// ── Active adapter state ───────────────────────────────────────────────────

let activeAdapter = null;
let activePlayerName = null;

export function getActivePlayerName() { return activePlayerName; }
export function getActiveAdapter() { return activeAdapter; }
export function isCliActive() { return activeAdapter !== null; }

/**
 * Detect + start the first available CLI player. Returns the player name if
 * started, or null if none could be started.
 */
export async function bootCliPlayer() {
  if (activeAdapter) { return activePlayerName; }

  for (const p of PLAYERS) {
    if (!probe(p.binary, p.probeArgs)) { continue; }
    const adapter = new p.AdapterClass(p.binary);
    try {
      await adapter.start();
      activeAdapter = adapter;
      activePlayerName = p.name;
      winston.info(`[cli-audio] started ${p.label} as fallback audio player`);
      return p.name;
    } catch (err) {
      winston.warn(`[cli-audio] ${p.label} detected but failed to start: ${err.message}`);
      try { await adapter.stop(); } catch (_) { /* ignore */ }
    }
  }
  return null;
}

export async function killCliPlayer() {
  if (!activeAdapter) { return; }
  try { await activeAdapter.stop(); } catch (_) { /* ignore */ }
  activeAdapter = null;
  activePlayerName = null;
}

/**
 * Drop-in counterpart to server-playback.js's proxyToRust. Takes the same
 * method/rustPath/body triple and returns `{ status, data }`.
 */
export function proxyToCli(method, rustPath, body) {
  if (!activeAdapter) {
    return Promise.reject(new Error('CLI audio player is not running'));
  }
  return activeAdapter.handleRequest(method, rustPath, body);
}
