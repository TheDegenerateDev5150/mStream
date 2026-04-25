import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';
import * as config from '../state/config.js';
import { SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { shouldMigrate, migrate } from './migrate-from-loki.js';

let db = null;
let clearSharedTimer = null;

// ── Anonymous (no-users) sentinel ────────────────────────────────────────────
//
// users.user_id is a NOT NULL FK on every per-user table (user_metadata,
// playlists, cue_points, user_settings, …). When the admin hasn't created
// any real users — i.e. mStream is running in public read-only mode — every
// HTTP request still needs *some* valid user_id to attribute writes to,
// otherwise scrobbles, ratings, "save queue as playlist", etc. all crash
// with NOT NULL constraint violations.
//
// Solution: keep one always-present sentinel user row identified by the
// is_anonymous_sentinel = 1 flag (added in V25). When auth.js detects
// "no real users", it pins req.user.id to this sentinel's id so every
// downstream INSERT has a valid FK target without per-endpoint null guards.
//
// The flag, not the username, is what marks the sentinel — usernames have
// no server-side validation, so an admin could legitimately have already
// created a user with whatever default name we'd pick. ensureAnonymousUser()
// finds an unused name (suffixing if needed) for fresh sentinels, and
// existing real rows always get is_anonymous_sentinel = 0 by ALTER's
// default, so they can never be confused with the sentinel.
const ANONYMOUS_USERNAME_BASE = '__mstream_anonymous__';

let _anonymousUserId = null;

// ── In-memory cache for users and libraries ─────────────────────────────────
// These change rarely (admin panel only) but are read on every HTTP request.
// Cache is invalidated by calling invalidateCache() after any admin mutation.

let _usersCache = null;           // Map<username, userRow>
let _librariesCache = null;       // Array of library rows
let _librariesByNameCache = null; // Map<name, libraryRow>
let _userLibrariesCache = null;   // Map<userId, [libraryId, ...]>

// ── Initialize ──────────────────────────────────────────────────────────────

export function initDB() {
  const dbPath = path.join(config.program.storage.dbDirectory, 'mstream.db');
  db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations();

  // One-time migration from LokiJS/config to SQLite
  if (shouldMigrate()) {
    migrate(db);
  }

  // Ensure the anonymous sentinel exists before populating caches —
  // auth.js's no-users branch needs its id at request time.
  ensureAnonymousUser();

  // Populate caches
  loadUsersCache();
  loadLibrariesCache();
  loadUserLibrariesCache();

  startSharedCleanup();

  winston.info(`Database initialized: ${dbPath}`);
}

// ── Access ──────────────────────────────────────────────────────────────────

export function getDB() {
  return db;
}

export function close() {
  stopSharedCleanup();
  if (db) {
    db.close();
    db = null;
  }
}

// ── Migrations ──────────────────────────────────────────────────────────────

function getSchemaVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function setSchemaVersion(version) {
  db.exec(`PRAGMA user_version = ${version}`);
}

function runMigrations() {
  const currentVersion = getSchemaVersion();

  if (currentVersion >= SCHEMA_VERSION) {
    winston.info(`Database schema is up to date (v${currentVersion})`);
    return;
  }

  winston.info(`Database schema v${currentVersion} → v${SCHEMA_VERSION}`);

  let needsRescan = false;
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      winston.info(`Applying migration v${migration.version}...`);
      // Wrap each migration in a single transaction so a multi-statement
      // migration (e.g. CREATE TABLE + CREATE INDEX + ALTER TABLE) either
      // applies fully or rolls back fully. Without this, a partial failure
      // could leave the DB in an inconsistent state that the next boot's
      // migration loop can't self-heal (e.g. ALTER TABLE ADD COLUMN has no
      // IF NOT EXISTS, so re-running after a mid-migration failure would
      // error with "duplicate column").
      db.exec('BEGIN');
      try {
        db.exec(migration.sql);
        setSchemaVersion(migration.version);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        winston.error(`Migration v${migration.version} failed: ${err.message}`);
        throw err;
      }
      if (migration.rescanRequired) {
        needsRescan = true;
      }
    }
  }

  // Write marker file if any migration requires a force rescan
  if (needsRescan) {
    const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
    try {
      fs.writeFileSync(markerPath, '');
      winston.info('Migration requires force rescan — will run on next boot scan');
    } catch (_) {}
  }
}

// ── Shared playlist cleanup ─────────────────────────────────────────────────

function startSharedCleanup() {
  const intervalHours = config.program.db?.clearSharedInterval;
  if (!intervalHours) { return; }

  clearSharedTimer = setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(now);
      winston.info('Cleared expired shared playlists');
    } catch (err) {
      winston.error('Failed to clear expired shared playlists', { stack: err });
    }
  }, intervalHours * 60 * 60 * 1000);
}

function stopSharedCleanup() {
  if (clearSharedTimer) {
    clearInterval(clearSharedTimer);
    clearSharedTimer = null;
  }
}

// ── Cache management ────────────────────────────────────────────────────────

export function invalidateCache() {
  _usersCache = null;
  _librariesCache = null;
  _librariesByNameCache = null;
  _userLibrariesCache = null;
}

function loadUsersCache() {
  if (_usersCache) { return; }
  _usersCache = new Map();
  for (const row of db.prepare('SELECT * FROM users').all()) {
    _usersCache.set(row.username, row);
  }
}

function loadLibrariesCache() {
  if (_librariesCache) { return; }
  _librariesCache = db.prepare('SELECT * FROM libraries').all();
  _librariesByNameCache = new Map();
  for (const lib of _librariesCache) {
    _librariesByNameCache.set(lib.name, lib);
  }
}

function loadUserLibrariesCache() {
  if (_userLibrariesCache) { return; }
  _userLibrariesCache = new Map();
  for (const row of db.prepare('SELECT user_id, library_id FROM user_libraries').all()) {
    if (!_userLibrariesCache.has(row.user_id)) {
      _userLibrariesCache.set(row.user_id, []);
    }
    _userLibrariesCache.get(row.user_id).push(row.library_id);
  }
}

// ── Cached lookups (hot path — called on every request) ─────────────────────

export function getUserByUsername(username) {
  loadUsersCache();
  const row = _usersCache.get(username);
  // The sentinel is never reachable by name. Login attempts already fail
  // at PBKDF2 (its stored hash is the literal '!' which no PBKDF2 output
  // can produce), but every other call site — admin mint-key, password
  // change, delete-user, edit-access, Subsonic getUser/updateUser — also
  // resolves users by name, and we don't want any of those to be able
  // to address the sentinel either. The auth no-users branch resolves
  // the sentinel by id (getAnonymousUserId), not name, so it's
  // unaffected by this filter.
  if (row?.is_anonymous_sentinel === 1) { return undefined; }
  return row;
}

export function getAllUsers() {
  loadUsersCache();
  // Hide the anonymous sentinel — empty-check `getAllUsers().length === 0`
  // should mean "no real users", and admin panels listing users shouldn't
  // surface a row no one can actually log in as.
  return Array.from(_usersCache.values()).filter(u => u.is_anonymous_sentinel !== 1);
}

export function getAnonymousUserId() {
  return _anonymousUserId;
}

// Returns the anonymous sentinel's full users-table row (or null when
// the sentinel hasn't been initialised yet — only happens before
// initDB() finishes).
//
// Callers: auth.js's no-users branch uses this to spread the sentinel's
// columns (lastfm_user, lastfm_password, listenbrainz_token, …) onto
// req.user, so public-mode requests look like a real-user request and
// the per-user-data endpoints (LB/Last.fm scrobbling, /lastfm/status,
// etc.) work without per-endpoint special-casing.
//
// getUserByUsername / getAllUsers intentionally hide the sentinel from
// admin-facing surfaces; this getter is the explicit bypass for the one
// caller that legitimately needs the full row.
export function getAnonymousUser() {
  if (_anonymousUserId === null) { return null; }
  loadUsersCache();
  for (const u of _usersCache.values()) {
    if (u.id === _anonymousUserId) { return u; }
  }
  return null;
}

// "Public mode" predicate. Returns true when the request has no user
// (legacy null-id callers) OR when it's been pinned to the anonymous
// sentinel by auth.js's no-users branch. Used wherever the old code
// said `if (!user || !user.id)` to mean "skip per-user filtering /
// short-circuit per-user state writes".
//
// Background: V25 introduced the sentinel so per-user tables (which all
// FK NOT NULL on users(id)) can accept inserts in public/no-users mode.
// auth.js now sets `req.user.id = getAnonymousUserId()` instead of `null`,
// which makes the sentinel id truthy. Every site that used `!user.id` as
// a shorthand for "public mode" got silently bypassed by the change —
// most visibly the library filter, which started returning `1=0` for
// public-mode requests because the sentinel has no user_libraries rows.
//
// Call this whenever the OLD intent was "treat the absence of a user as
// public mode" — it preserves that intent while remaining correct under
// the sentinel design.
export function isPublicMode(user) {
  if (!user || !user.id) { return true; }
  return _anonymousUserId !== null && user.id === _anonymousUserId;
}

function ensureAnonymousUser() {
  // Already have a sentinel? Reuse it.
  const existing = db.prepare('SELECT id FROM users WHERE is_anonymous_sentinel = 1').get();
  if (existing) {
    _anonymousUserId = existing.id;
    return;
  }

  // Pick a username that isn't already taken. Almost always the canonical
  // base; suffix with a counter only on the unlikely chance that an admin
  // has already created a user with that name.
  let username = ANONYMOUS_USERNAME_BASE;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); i++) {
    username = `${ANONYMOUS_USERNAME_BASE.slice(0, -2)}_${i}__`;
  }

  // Dummy password/salt are literal '!' — no PBKDF2 output ever produces
  // that exact string, so login attempts against the sentinel are
  // guaranteed to fail at the hash-comparison step in src/util/auth.js.
  const result = db.prepare(
    `INSERT INTO users (username, password, salt, is_admin, is_anonymous_sentinel,
                        allow_upload, allow_mkdir, allow_server_audio)
     VALUES (?, '!', '!', 0, 1, 0, 0, 0)`
  ).run(username);
  _anonymousUserId = Number(result.lastInsertRowid);
}

export function getLibraryByName(name) {
  loadLibrariesCache();
  return _librariesByNameCache.get(name);
}

export function getAllLibraries() {
  loadLibrariesCache();
  return _librariesCache;
}

export function getUserLibraryIds(user) {
  // Public mode (no user, or pinned to the anonymous sentinel by auth.js)
  // — every library is visible. Without this branch, the sentinel id (a
  // real integer with zero rows in user_libraries) would fall through to
  // the lookup below and return [], which libraryFilter then translates
  // to `1=0`, hiding every track. See isPublicMode() above for context.
  if (isPublicMode(user)) {
    loadLibrariesCache();
    return _librariesCache.map(l => l.id);
  }
  loadUserLibrariesCache();
  return _userLibrariesCache.get(user.id) || [];
}

// ── Helper queries (not cached — called less frequently) ────────────────────

export function inPlaceholders(arr) {
  return '(' + arr.map(() => '?').join(',') + ')';
}

export function findOrCreateArtist(name) {
  if (!name) { return null; }
  const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name);
  if (existing) { return existing.id; }
  const result = db.prepare('INSERT INTO artists (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

export function findOrCreateAlbum(name, artistId, year) {
  if (!name) { return null; }
  const existing = db.prepare(
    'SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?'
  ).get(name, artistId, year);
  if (existing) { return existing.id; }
  const result = db.prepare(
    'INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)'
  ).run(name, artistId, year);
  return Number(result.lastInsertRowid);
}

// Parse a genre string (e.g. "Rock; Electronic, Pop") into individual genre names.
// Handles comma, semicolon, and slash delimiters.
export function parseGenreString(genreStr) {
  if (!genreStr) { return []; }
  return genreStr
    .split(/[,;\/]/)
    .map(g => g.trim())
    .filter(g => g.length > 0);
}

// Find or create a genre by name. Returns the genre id.
export function findOrCreateGenre(name) {
  if (!name) { return null; }
  const existing = db.prepare('SELECT id FROM genres WHERE name = ?').get(name);
  if (existing) { return existing.id; }
  const result = db.prepare('INSERT INTO genres (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

// Link a track to its genres. Parses the genre string and creates junction entries.
export function setTrackGenres(trackId, genreStr) {
  const genres = parseGenreString(genreStr);
  if (genres.length === 0) { return; }

  const insertLink = db.prepare(
    'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
  );
  for (const name of genres) {
    const genreId = findOrCreateGenre(name);
    if (genreId) { insertLink.run(trackId, genreId); }
  }
}
