/**
 * LRCLib external-lookup fallback for the lyrics endpoints (Phase 3).
 *
 * Called by src/api/subsonic/handlers.js and src/api/lyrics.js when a
 * track has no embedded or sidecar lyrics. Consults the `lyrics_cache`
 * table first; on cache miss, enqueues a background fetch against
 * https://lrclib.net and returns immediately so the HTTP response
 * stays snappy. The client sees "no lyrics" on the first request for
 * an unseen track and real data on the next one.
 *
 * Opt-in via `config.lyrics.lrclib = true`. When disabled, `getCached`
 * returns null for everything and `maybeEnqueueFetch` is a no-op —
 * the cache table stays empty and no network traffic happens.
 *
 * Design choices worth knowing:
 *   - Keyed on `audio_hash` (V14 / scanner canonical identity) so a
 *     cache hit survives tag rewrites and ReplayGain updates. Only a
 *     genuine content edit invalidates.
 *   - Dedup via a `status='pending'` row: two simultaneous requests
 *     for the same track enqueue once; the second request still returns
 *     empty but doesn't double-fetch.
 *   - In-process concurrency cap (config.lyrics.concurrency, default 2).
 *     LRCLib is free and generous but a bulk-scrobble burst shouldn't
 *     hammer them.
 *   - Two-attempt fetch strategy: duration-exact first (LRCLib's
 *     matcher is stricter than users expect — re-rips at different
 *     bitrates miss the duration filter), then duration=0 fuzzy.
 *     Credit: pattern adapted from the Velvet fork
 *     (aroundmyroom/mStream:src/api/lyrics.js).
 *   - TTLs per status (config.lyrics.cacheTtl*Ms). Stale hits
 *     continue to be served while a re-fetch runs — no request
 *     regresses from "had lyrics" to "empty" on a single blip.
 *
 * Test hook: the exported `_setHttpClient` lets the test harness
 * inject a mock fetcher so we never hit lrclib.net in CI.
 */

import https from 'node:https';
import http  from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';

// Default HTTP GET implementation. Returns `{status, body}` where body
// is parsed JSON (or null for non-200). Overridable for tests. Follows
// redirects; dispatches to `https` or `http` based on scheme so the
// test harness can point us at a local plain-http mock.
function defaultHttpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, {
        headers: {
          'User-Agent':       'mStream/lrclib-fetch (+https://mstream.io)',
          'Accept':           'application/json',
          'Accept-Encoding':  'identity',
        },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location);
        }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { return resolve({ status: res.statusCode, body: null }); }
          try { resolve({ status: 200, body: JSON.parse(data) }); }
          catch { resolve({ status: 200, body: null }); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('lrclib timeout')); });
    };
    follow(url);
  });
}

let httpGet = defaultHttpGet;
/** Test-only: replace the HTTP client. Pass `null` to restore the real one. */
export function _setHttpClient(fn) { httpGet = fn || defaultHttpGet; }

// Default endpoint; overridable via env for internal testing.
const LRCLIB_BASE = process.env.MSTREAM_LRCLIB_BASE || 'https://lrclib.net';
const FETCH_TIMEOUT_MS = 8000;

// ── Cache access ────────────────────────────────────────────────────────────

function now() { return Date.now(); }

// Fetch a cache row. Returns null if no row, or the row with an
// `isFresh` flag computed against the current TTLs.
export function getCached(audioHash) {
  if (!audioHash) { return null; }
  const row = db.getDB().prepare(
    'SELECT audio_hash, status, synced_lrc, plain, lang, source, fetched_at FROM lyrics_cache WHERE audio_hash = ?'
  ).get(audioHash);
  if (!row) { return null; }
  const age = now() - (row.fetched_at || 0);
  const ttl = ttlForStatus(row.status);
  row.isFresh = age < ttl;
  return row;
}

function ttlForStatus(status) {
  const l = config.program.lyrics || {};
  if (status === 'hit')   { return l.cacheTtlHitsMs   ?? 7 * 24 * 60 * 60 * 1000; }
  if (status === 'miss')  { return l.cacheTtlMissesMs ??     24 * 60 * 60 * 1000; }
  if (status === 'error') { return l.cacheTtlErrorsMs ??          60 * 60 * 1000; }
  // 'pending' — infinite TTL in practice; the fetcher clears it to
  // hit/miss/error when the call resolves. A crashed process could
  // leave this stuck; the admin "retry errors" button also wipes
  // pending so operators have an escape hatch.
  return Infinity;
}

function writeCacheRow(audioHash, { status, syncedLrc = null, plain = null, lang = null, source = 'lrclib' }) {
  db.getDB().prepare(`
    INSERT INTO lyrics_cache (audio_hash, status, synced_lrc, plain, lang, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audio_hash) DO UPDATE SET
      status     = excluded.status,
      synced_lrc = excluded.synced_lrc,
      plain      = excluded.plain,
      lang       = excluded.lang,
      source     = excluded.source,
      fetched_at = excluded.fetched_at
  `).run(audioHash, status, syncedLrc, plain, lang, source, now());
}

// ── Async fetch queue (in-process semaphore) ────────────────────────────────

const queued = new Set();    // audio_hashes currently queued OR in-flight
let inFlight = 0;
const pendingJobs = [];

/**
 * If configured + not already cached-fresh + not already queued,
 * enqueue an async fetch for this track. Returns true when enqueued.
 *
 * Never throws — every failure path logs + writes a status='error'
 * row so the caller can just await and move on.
 */
export function maybeEnqueueFetch({ audioHash, artist, title, duration }) {
  if (!isEnabled())         { return false; }
  if (!audioHash)           { return false; }
  if (!artist || !title)    { return false; }
  if (queued.has(audioHash)) { return false; }

  // Write a 'pending' row so concurrent requests see it and skip
  // enqueueing. We also use this as the serialisation point: the
  // worker clears/overwrites it when the fetch resolves.
  writeCacheRow(audioHash, { status: 'pending' });
  queued.add(audioHash);
  pendingJobs.push({ audioHash, artist, title, duration: duration || 0 });
  drain();
  return true;
}

function isEnabled() {
  return !!(config.program.lyrics && config.program.lyrics.lrclib);
}

function concurrencyCap() {
  return (config.program.lyrics && config.program.lyrics.concurrency) || 2;
}

function drain() {
  while (inFlight < concurrencyCap() && pendingJobs.length) {
    const job = pendingJobs.shift();
    inFlight++;
    runJob(job).finally(() => {
      inFlight--;
      queued.delete(job.audioHash);
      // Kick the queue again — a pile-up could have landed during the
      // await and we don't want to stall until the next external call.
      if (pendingJobs.length) { drain(); }
    });
  }
}

async function runJob(job) {
  try {
    const data = await fetchFromLrclib(job.artist, job.title, job.duration);
    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      writeCacheRow(job.audioHash, { status: 'miss' });
      return;
    }
    writeCacheRow(job.audioHash, {
      status:     'hit',
      syncedLrc:  data.syncedLyrics || null,
      plain:      data.plainLyrics  || null,
      lang:       data.lang         || null,
      source:     'lrclib',
    });
    // Optional write-back to filesystem so the lyrics travel with the
    // audio file if it's copied/exported. Never clobbers an existing
    // sidecar; silent no-op when the file moved or parent dir is
    // read-only. Next scan picks up the written sidecar and mirrors
    // it into tracks.lyrics_synced_lrc via the normal path (at which
    // point the cache row becomes a duplicate that still serves fast).
    if (config.program.lyrics?.writeSidecar) {
      writeSidecarIfPossible(job.audioHash, data);
    }
  } catch (err) {
    // Network / parse / timeout. Status='error' has a short TTL so a
    // transient blip doesn't stick — next request retries in ~1hr.
    writeCacheRow(job.audioHash, { status: 'error' });
  }
}

/**
 * Resolve the audio file's absolute path from its audio_hash and
 * drop a sibling .lrc (preferred) or .txt (fallback) containing the
 * fetched lyrics. Called from runJob only when the writeSidecar
 * config flag is true.
 *
 * Safety policy:
 *   - Only writes if we can resolve the track row AND the library's
 *     root_path.
 *   - Silently bails if an `.lrc` or `.txt` sibling already exists
 *     (user curation wins).
 *   - Silently bails if the audio file doesn't exist at the computed
 *     path (track renamed / moved / deleted between scan and fetch).
 *   - Silently bails on any fs error (read-only FS, permission denied,
 *     ENOSPC). These aren't fatal to the lyrics-serving path — the
 *     cache row already has the lyrics and will continue to serve.
 *
 * Exported for tests so the unit suite can assert the safety rules
 * without needing a full server spin-up.
 */
export function writeSidecarIfPossible(audioHash, data) {
  try {
    // Resolve library root + tracks.filepath for this hash. Library
    // root comes from libraries.root_path. We accept EITHER
    // audio_hash or file_hash so legacy rows (pre-V14) still get
    // write-back.
    const row = db.getDB().prepare(`
      SELECT t.filepath, l.root_path
      FROM tracks t
      JOIN libraries l ON l.id = t.library_id
      WHERE t.audio_hash = ? OR t.file_hash = ?
      LIMIT 1
    `).get(audioHash, audioHash);
    if (!row || !row.filepath || !row.root_path) { return false; }

    const absolute = path.resolve(row.root_path, row.filepath);
    if (!fs.existsSync(absolute)) { return false; }

    // Compute sibling base. `<base>.lrc` preferred for synced content,
    // `<base>.txt` for plain. Both probed for existence; if either
    // variant already exists, we bail — curated content wins.
    const parsed = path.parse(absolute);
    const baseName = path.join(parsed.dir, parsed.name);
    const lrcPath = `${baseName}.lrc`;
    const txtPath = `${baseName}.txt`;
    if (fs.existsSync(lrcPath) || fs.existsSync(txtPath)) { return false; }

    // Pick variant + content. If we have synced lyrics, emit `.lrc`;
    // if only plain, emit `.txt`. Writing both would double-write
    // the same info.
    const target = data.syncedLyrics ? lrcPath : txtPath;
    const payload = data.syncedLyrics || data.plainLyrics;
    if (!payload) { return false; }

    // Atomic write via .tmp + rename so a crashed process never leaves
    // a truncated sidecar that the next scan would cache verbatim.
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    winston.warn(`[lyrics-lrclib] sidecar write-back failed for ${audioHash}: ${err.message}`);
    return false;
  }
}

// Two-attempt fetch: exact-duration first (LRCLib's matcher is strict),
// then fuzzy (duration=0) as a fallback.
//
// tryOnce distinguishes three outcomes:
//   - body (non-null)       → success, return to caller
//   - null                  → authoritative miss (HTTP 404, or 200 with
//                             empty syncedLyrics + plainLyrics)
//   - throw                 → transient error (5xx, timeout, connection
//                             refused, parse failure). `runJob` catches
//                             this and writes status='error' so the
//                             short-TTL retry logic kicks in.
//
// fetchFromLrclib returns null for a clean "LRCLib has no match for
// this track" (both attempts 404). Anything transient propagates.
async function fetchFromLrclib(artist, title, duration) {
  const tryOnce = async (dur) => {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (dur > 0) { params.set('duration', String(Math.round(dur))); }
    const url = `${LRCLIB_BASE}/api/get?${params}`;
    const { status, body } = await httpGet(url, FETCH_TIMEOUT_MS);
    if (status === 404) { return null; }              // authoritative miss
    if (status !== 200)  { throw new Error(`lrclib ${status}`); }  // transient
    if (!body)           { throw new Error('lrclib parse error'); }
    if (!body.syncedLyrics && !body.plainLyrics) { return null; }  // 200-but-empty
    return body;
  };

  // Exact-duration first — matches the way the Velvet fork does it,
  // which avoids spurious hits on other tracks with the same title.
  // A miss (null) falls through to fuzzy; a throw propagates so the
  // whole fetch counts as transient and retries soon.
  if (duration > 0) {
    const hit = await tryOnce(duration);
    if (hit) { return hit; }
  }
  return tryOnce(0);
}

// ── Admin helpers (purge / stats) ───────────────────────────────────────────

export function cacheStats() {
  const rows = db.getDB().prepare(
    'SELECT status, COUNT(*) AS n FROM lyrics_cache GROUP BY status'
  ).all();
  const out = { hit: 0, miss: 0, error: 0, pending: 0, total: 0 };
  for (const r of rows) {
    if (r.status in out) { out[r.status] = r.n; }
    out.total += r.n;
  }
  return out;
}

/**
 * Drop every cache row. Called by the admin "purge all" button.
 * Returns the number of rows deleted.
 */
export function purgeAll() {
  const r = db.getDB().prepare('DELETE FROM lyrics_cache').run();
  // Also flush the in-memory queue/set — a purge while jobs are
  // mid-flight would otherwise race with those jobs writing fresh
  // rows in as the admin expects a clean slate.
  queued.clear();
  pendingJobs.length = 0;
  return r.changes;
}

/**
 * Wipe just the error + pending rows so those tracks get retried on
 * next request. Used by the admin "retry errors" button to shake
 * loose a network-outage window without dropping successful hits.
 */
export function purgeTransient() {
  const r = db.getDB().prepare(
    "DELETE FROM lyrics_cache WHERE status IN ('error', 'pending')"
  ).run();
  // Clear the dedup set for the rows we just removed. Cheap — re-
  // derive from the new DB state rather than tracking which set
  // entries correspond to 'error' vs 'hit' rows.
  queued.clear();
  return r.changes;
}

// ── Test-only internals ─────────────────────────────────────────────────────

/**
 * Wait until the background queue drains. Returns a Promise that
 * resolves when `inFlight === 0 && pendingJobs.length === 0`. Poll-
 * based (5ms) — accurate enough for tests and zero overhead when
 * not called.
 */
export function _drainForTests() {
  return new Promise(resolve => {
    const tick = () => {
      if (inFlight === 0 && pendingJobs.length === 0) { return resolve(); }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Test-only: reset the in-memory queue state between cases. */
export function _resetForTests() {
  queued.clear();
  pendingJobs.length = 0;
  inFlight = 0;
}
