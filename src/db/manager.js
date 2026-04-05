import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';
import * as config from '../state/config.js';
import { SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { shouldMigrate, migrate } from './migrate-from-loki.js';

let db = null;
let clearSharedTimer = null;

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

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      winston.info(`Applying migration v${migration.version}...`);
      db.exec(migration.sql);
      setSchemaVersion(migration.version);
    }
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
  return _usersCache.get(username);
}

export function getAllUsers() {
  loadUsersCache();
  return Array.from(_usersCache.values());
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
  if (!user || !user.id) {
    // Public mode — return all library IDs
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
