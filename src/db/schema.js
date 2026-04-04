// SQLite schema definitions and migration system for mStream.
// Uses PRAGMA user_version for tracking which migrations have been applied.

export const SCHEMA_VERSION = 3;

export const SCHEMA_V1 = `
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    allow_upload INTEGER NOT NULL DEFAULT 1,
    allow_mkdir INTEGER NOT NULL DEFAULT 1,
    lastfm_user TEXT,
    lastfm_password TEXT
  );

  -- Libraries (vpaths)
  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'music'
  );

  -- User access to libraries
  CREATE TABLE IF NOT EXISTS user_libraries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
  );

  -- Artists
  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_name TEXT,
    mbz_artist_id TEXT
  );

  -- Albums
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year INTEGER,
    album_art_file TEXT,
    mbz_album_id TEXT,
    UNIQUE(name, artist_id, year)
  );

  -- Tracks (files)
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    title TEXT,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_number INTEGER,
    disc_number INTEGER,
    year INTEGER,
    duration REAL,
    bitrate INTEGER,
    format TEXT,
    file_size INTEGER,
    file_hash TEXT,
    album_art_file TEXT,
    genre TEXT,
    replaygain_track_db REAL,
    modified REAL,
    created_at TEXT DEFAULT (datetime('now')),
    scan_id TEXT,
    UNIQUE(filepath, library_id)
  );

  -- Per-user track metadata (ratings, play counts)
  CREATE TABLE IF NOT EXISTS user_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_hash TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played TEXT,
    rating INTEGER,
    UNIQUE(user_id, track_hash)
  );

  -- Playlists
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, user_id)
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    filepath TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  -- Shared playlists
  CREATE TABLE IF NOT EXISTS shared_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL UNIQUE,
    playlist_json TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires INTEGER,
    token TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_tracks_library ON tracks(library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(file_hash);
  CREATE INDEX IF NOT EXISTS idx_tracks_filepath ON tracks(filepath, library_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_scan ON tracks(scan_id);
  CREATE INDEX IF NOT EXISTS idx_user_metadata_hash ON user_metadata(track_hash);
  CREATE INDEX IF NOT EXISTS idx_user_metadata_user ON user_metadata(user_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
  CREATE INDEX IF NOT EXISTS idx_shared_expires ON shared_playlists(expires);
  CREATE INDEX IF NOT EXISTS idx_user_libraries_user ON user_libraries(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_libraries_library ON user_libraries(library_id);
`;

export const SCHEMA_V2 = `
  -- Genres (many-to-many with tracks)
  CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS track_genres (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, genre_id)
  );

  CREATE INDEX IF NOT EXISTS idx_track_genres_track ON track_genres(track_id);
  CREATE INDEX IF NOT EXISTS idx_track_genres_genre ON track_genres(genre_id);
`;

export const SCHEMA_V3 = `
  ALTER TABLE users ADD COLUMN allow_file_modify INTEGER NOT NULL DEFAULT 1;
`;

export const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
];
