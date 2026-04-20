/**
 * Subsonic API endpoint handlers (Phase 1).
 *
 * Covers the minimum set a typical Subsonic client needs to connect, browse
 * a library, and start playback:
 *
 *   System:    ping, getLicense, getMusicFolders
 *   Browsing:  getIndexes, getMusicDirectory, getArtists, getArtist,
 *              getAlbum, getSong, getGenres
 *   Media:     getCoverArt, stream, download
 *   Search:    search3 (plus search, search2 as thin shims)
 *
 * IDs are bare numeric DB row IDs. Clients treat them as opaque strings.
 * getCoverArt routes by trying the songs → albums tables in that order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import * as db from '../../db/manager.js';
import * as config from '../../state/config.js';
import * as dbQueue from '../../db/task-queue.js';
import * as adminUtil from '../../util/admin.js';
import { ffmpegBin } from '../../util/ffmpeg-bootstrap.js';
import { serveAlbumArtFile } from '../album-art.js';
import { sendOk, SubErr } from './response.js';
import * as nowPlaying from './now-playing.js';
import { identiconFor } from './identicon.js';

// ── Common helpers ──────────────────────────────────────────────────────────

// Comma-separated list of leading articles Subsonic sorting ignores.
const IGNORED_ARTICLES = 'The An A Die Das Ein Eine Les Le La';

// ── ID encoding ─────────────────────────────────────────────────────────────
// Containers get type-prefixed opaque IDs so getMusicDirectory and getCoverArt
// can route correctly even when artist/album/song numeric rowids overlap.
//   mf-N  music folder (library)
//   ar-N  artist
//   al-N  album
//   N     song (bare numeric — clients commonly pass song ids through to
//         getCoverArt, stream, scrobble, etc., and bare numerics are what
//         every Subsonic client expects for those endpoints)

const encArtist = n => `ar-${n}`;
const encAlbum  = n => `al-${n}`;
const encFolder = n => `mf-${n}`;

function decodeId(str, expectedType) {
  if (str == null) { return null; }
  const s = String(str);
  // Bare numeric = song
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (expectedType && expectedType !== 'song') { return null; }
    return { type: 'song', id: n };
  }
  const m = /^(ar|al|mf)-(\d+)$/.exec(s);
  if (!m) { return null; }
  const type = m[1] === 'ar' ? 'artist' : m[1] === 'al' ? 'album' : 'folder';
  if (expectedType && expectedType !== type) { return null; }
  return { type, id: parseInt(m[2], 10) };
}

function isoUtc(d) {
  if (!d) { return undefined; }
  // DB timestamps are "YYYY-MM-DD HH:MM:SS" in UTC (SQLite default). Convert
  // to ISO 8601 which is what Subsonic clients expect.
  const s = typeof d === 'string' ? d.replace(' ', 'T') + 'Z' : new Date(d).toISOString();
  return s;
}

function suffixFor(filepath, format) {
  return (format || path.extname(filepath).slice(1) || '').toLowerCase();
}

const MIME_BY_SUFFIX = {
  mp3:  'audio/mpeg',
  flac: 'audio/flac',
  wav:  'audio/wav',
  ogg:  'audio/ogg',
  opus: 'audio/opus',
  aac:  'audio/mp4',
  m4a:  'audio/mp4',
  m4b:  'audio/mp4',
};
function contentTypeFor(suffix) {
  return MIME_BY_SUFFIX[suffix] || 'application/octet-stream';
}

// Restrict a track query to libraries this user can see. Returns a WHERE
// fragment + its params, ready to concat into a larger query.
function libraryScope(req) {
  const vpaths = req.user?.vpaths || [];
  if (vpaths.length === 0) { return { clause: '1=0', params: [] }; }
  const libs = db.getAllLibraries().filter(l => vpaths.includes(l.name));
  if (libs.length === 0) { return { clause: '1=0', params: [] }; }
  const placeholders = libs.map(() => '?').join(',');
  return { clause: `t.library_id IN (${placeholders})`, params: libs.map(l => l.id) };
}

// Look up a user's metadata row for a given track. Used by star/rating/
// scrobble handlers. Returns the row (possibly with NULL fields) or null if
// we can't even find the track.
function trackFileHash(trackId) {
  return db.getDB().prepare('SELECT file_hash FROM tracks WHERE id = ?')
    .get(trackId)?.file_hash;
}

// Upsert a user_metadata row, setting the supplied fields. Leaves other
// fields untouched — clients that only call setRating shouldn't clobber
// starred_at, and vice versa.
function upsertUserMeta(userId, trackHash, fields) {
  if (!trackHash) { return false; }
  const d = db.getDB();
  // Insert if the row doesn't exist yet; caller's SET block runs either way.
  d.prepare('INSERT OR IGNORE INTO user_metadata (user_id, track_hash) VALUES (?, ?)').run(userId, trackHash);
  const keys = Object.keys(fields);
  if (keys.length === 0) { return true; }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  d.prepare(`UPDATE user_metadata SET ${setClause} WHERE user_id = ? AND track_hash = ?`)
    .run(...vals, userId, trackHash);
  return true;
}

// Look up the star-timestamp for a set of album or artist ids for the caller.
// Returns a Map<id, isoString>. Empty input returns an empty Map.
function albumStarMap(userId, albumIds) {
  if (!albumIds.length) { return new Map(); }
  const ph = albumIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(
    `SELECT album_id, starred_at FROM user_album_stars
     WHERE user_id = ? AND album_id IN (${ph})`
  ).all(userId, ...albumIds);
  return new Map(rows.map(r => [r.album_id, r.starred_at]));
}
function artistStarMap(userId, artistIds) {
  if (!artistIds.length) { return new Map(); }
  const ph = artistIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(
    `SELECT artist_id, starred_at FROM user_artist_stars
     WHERE user_id = ? AND artist_id IN (${ph})`
  ).all(userId, ...artistIds);
  return new Map(rows.map(r => [r.artist_id, r.starred_at]));
}

// Bulk-annotate Subsonic song objects with the current user's starred /
// rating / play-count state. Cheaper than joining user_metadata into every
// base query.
function enrichSongsWithUserMeta(req, songs) {
  if (!songs.length) { return songs; }
  const trackIds = songs
    .map(s => parseInt(s.id, 10))
    .filter(Number.isFinite);
  if (!trackIds.length) { return songs; }

  const placeholders = trackIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(`
    SELECT t.id, um.starred_at, um.rating, um.play_count
    FROM tracks t
    LEFT JOIN user_metadata um
      ON um.track_hash = t.file_hash AND um.user_id = ?
    WHERE t.id IN (${placeholders})
  `).all(req.user.id, ...trackIds);

  const meta = new Map(rows.map(r => [r.id, r]));
  for (const song of songs) {
    const m = meta.get(parseInt(song.id, 10));
    if (!m) { continue; }
    if (m.starred_at)               { song.starred    = isoUtc(m.starred_at); }
    if (m.rating && m.rating > 0)   { song.userRating = m.rating; }
    if (m.play_count && m.play_count > 0) { song.playCount = m.play_count; }
  }
  return songs;
}

// Normalise a repeated query param — Express gives us an Array when it's
// passed multiple times (`id=1&id=2`) or a string when it's passed once.
// Always returns an Array (possibly empty).
function arrayParam(v) {
  if (v == null) { return []; }
  return Array.isArray(v) ? v : [v];
}

// Build a Subsonic Song object from a DB row. The query supplying `row` must
// include at minimum: t.id, t.filepath, t.title, t.track_number, t.disc_number,
// t.duration, t.format, t.file_size, t.bitrate, t.year, t.genre,
// t.album_art_file, t.created_at, t.library_id, a.name AS artist_name,
// a.id AS artist_id, al.name AS album_name, al.id AS album_id.
function songFromRow(row) {
  const suffix = suffixFor(row.filepath, row.format);
  return {
    id:          String(row.id),
    parent:      row.album_id != null ? encAlbum(row.album_id) : undefined,
    isDir:       false,
    title:       row.title || path.basename(row.filepath),
    album:       row.album_name || undefined,
    artist:      row.artist_name || undefined,
    track:       row.track_number || undefined,
    year:        row.year || undefined,
    genre:       row.genre || undefined,
    coverArt:    row.album_art_file ? (row.album_id != null ? encAlbum(row.album_id) : String(row.id)) : undefined,
    size:        row.file_size || undefined,
    contentType: contentTypeFor(suffix),
    suffix,
    duration:    row.duration != null ? Math.round(row.duration) : undefined,
    bitRate:     row.bitrate != null ? Math.round(row.bitrate / 1000) : undefined,
    path:        row.filepath,
    discNumber:  row.disc_number || undefined,
    created:     isoUtc(row.created_at),
    albumId:     row.album_id != null ? encAlbum(row.album_id) : undefined,
    artistId:    row.artist_id != null ? encArtist(row.artist_id) : undefined,
    type:        'music',
  };
}

// ── System ──────────────────────────────────────────────────────────────────

export function ping(req, res) { sendOk(req, res); }

export function getLicense(req, res) {
  // Subsonic Premium licensing is a vestige; we always report valid.
  sendOk(req, res, {
    license: { valid: true, email: 'mstream@local', licenseExpires: '2099-12-31T00:00:00Z' },
  });
}

export function getMusicFolders(req, res) {
  const vpaths = req.user.vpaths || [];
  const libs = db.getAllLibraries().filter(l => vpaths.includes(l.name));
  sendOk(req, res, {
    musicFolders: {
      musicFolder: libs.map(l => ({ id: encFolder(l.id), name: l.name })),
    },
  });
}

// ── Browsing: artist/album/song ─────────────────────────────────────────────

// Helpful for A/B/C… indexing. Strips leading ignored articles.
function indexLetter(name) {
  if (!name) { return '#'; }
  const stripped = name.replace(new RegExp(`^(?:${IGNORED_ARTICLES.split(' ').join('|')})\\s+`, 'i'), '');
  const first = stripped.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

function getArtistsCore(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT a.id, a.name,
           COUNT(DISTINCT al.id) AS albumCount,
           MIN(al.album_art_file) AS coverArt
    FROM artists a
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    WHERE ${clause}
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE
  `).all(...params);
}

export function getArtists(req, res) {
  const artists = getArtistsCore(req);
  const buckets = new Map();
  for (const a of artists) {
    const letter = indexLetter(a.name);
    if (!buckets.has(letter)) { buckets.set(letter, []); }
    buckets.get(letter).push({
      id: encArtist(a.id),
      name: a.name,
      albumCount: a.albumCount,
      coverArt: a.coverArt ? encArtist(a.id) : undefined,
    });
  }
  const index = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));
  sendOk(req, res, {
    artists: { ignoredArticles: IGNORED_ARTICLES, index },
  });
}

// Legacy getIndexes — older clients use this instead of getArtists.
export function getIndexes(req, res) {
  const artists = getArtistsCore(req);
  const buckets = new Map();
  for (const a of artists) {
    const letter = indexLetter(a.name);
    if (!buckets.has(letter)) { buckets.set(letter, []); }
    buckets.get(letter).push({ id: encArtist(a.id), name: a.name });
  }
  const index = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));
  sendOk(req, res, {
    indexes: {
      ignoredArticles: IGNORED_ARTICLES,
      lastModified: Date.now(),
      index,
    },
  });
}

export function getArtist(req, res) {
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);

  const artist = db.getDB().prepare('SELECT id, name FROM artists WHERE id = ?').get(id);
  if (!artist) { return SubErr.NOT_FOUND(req, res, 'Artist'); }

  const albums = db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file AS coverArt,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           MIN(t.genre) AS genre
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    WHERE al.artist_id = ? AND ${clause}
    GROUP BY al.id
    ORDER BY al.year, al.name COLLATE NOCASE
  `).all(id, ...params);

  const albumStars = albumStarMap(req.user.id, albums.map(a => a.id));
  const artistStars = artistStarMap(req.user.id, [artist.id]);

  sendOk(req, res, {
    artist: {
      id: encArtist(artist.id),
      name: artist.name,
      albumCount: albums.length,
      starred: artistStars.has(artist.id) ? isoUtc(artistStars.get(artist.id)) : undefined,
      album: albums.map(al => ({
        id:        encAlbum(al.id),
        parent:    encArtist(artist.id),
        isDir:     true,
        name:      al.name,
        title:     al.name,
        album:     al.name,
        artist:    artist.name,
        artistId:  encArtist(artist.id),
        year:      al.year || undefined,
        genre:     al.genre || undefined,
        coverArt:  al.coverArt ? encAlbum(al.id) : undefined,
        songCount: al.songCount,
        duration:  al.duration != null ? Math.round(al.duration) : undefined,
        created:   undefined,
        starred:   albumStars.has(al.id) ? isoUtc(albumStars.get(al.id)) : undefined,
      })),
    },
  });
}

export function getAlbum(req, res) {
  const parsed = decodeId(req.query.id, 'album');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);

  const album = db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    WHERE al.id = ?
  `).get(id);
  if (!album) { return SubErr.NOT_FOUND(req, res, 'Album'); }

  const songs = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.album_id = ? AND ${clause}
    ORDER BY t.disc_number, t.track_number, t.title
  `).all(id, ...params);

  const albumStars = albumStarMap(req.user.id, [album.id]);

  sendOk(req, res, {
    album: {
      id:        encAlbum(album.id),
      name:      album.name,
      artist:    album.artist_name || undefined,
      artistId:  album.artist_id != null ? encArtist(album.artist_id) : undefined,
      year:      album.year || undefined,
      coverArt:  album.album_art_file ? encAlbum(album.id) : undefined,
      songCount: songs.length,
      duration:  Math.round(songs.reduce((s, r) => s + (r.duration || 0), 0)),
      starred:   albumStars.has(album.id) ? isoUtc(albumStars.get(album.id)) : undefined,
      song:      enrichSongsWithUserMeta(req, songs.map(songFromRow)),
    },
  });
}

export function getSong(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);
  const row = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.id = ? AND ${clause}
  `).get(id, ...params);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const [song] = enrichSongsWithUserMeta(req, [songFromRow(row)]);
  sendOk(req, res, { song });
}

export function getGenres(req, res) {
  const { clause, params } = libraryScope(req);
  const rows = db.getDB().prepare(`
    SELECT COALESCE(t.genre, '') AS value,
           COUNT(*) AS songCount,
           COUNT(DISTINCT t.album_id) AS albumCount
    FROM tracks t
    WHERE ${clause} AND t.genre IS NOT NULL AND t.genre <> ''
    GROUP BY t.genre
    ORDER BY t.genre COLLATE NOCASE
  `).all(...params);
  sendOk(req, res, { genres: { genre: rows } });
}

// getMusicDirectory is the pre-getArtists folder-style browse. The prefixed
// id tells us whether it's a music folder (mf-N), artist (ar-N) or album
// (al-N) — bare numerics are song ids, which can't be drilled into.
export function getMusicDirectory(req, res) {
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const n = parsed.id;

  if (parsed.type === 'folder') {
    const lib = db.getAllLibraries().find(l => l.id === n && req.user.vpaths.includes(l.name));
    if (!lib) { return SubErr.NOT_FOUND(req, res); }
    // Library "folder": list its artists as children.
    const { clause, params } = libraryScope(req);
    const artists = db.getDB().prepare(`
      SELECT a.id, a.name
      FROM artists a
      JOIN albums al ON al.artist_id = a.id
      JOIN tracks t  ON t.album_id = al.id
      WHERE ${clause}
      GROUP BY a.id
      ORDER BY a.name COLLATE NOCASE
    `).all(...params);
    return sendOk(req, res, {
      directory: {
        id:    encFolder(n),
        name:  lib.name,
        child: artists.map(a => ({
          id:     encArtist(a.id),
          parent: encFolder(n),
          isDir:  true,
          title:  a.name,
          name:   a.name,
        })),
      },
    });
  }

  if (parsed.type === 'artist') {
    const artist = db.getDB().prepare('SELECT id, name FROM artists WHERE id = ?').get(n);
    if (!artist) { return SubErr.NOT_FOUND(req, res); }
    // Reuse getArtist logic but as getMusicDirectory shape.
    const { clause, params } = libraryScope(req);
    const albums = db.getDB().prepare(`
      SELECT al.id, al.name, al.year, al.album_art_file AS coverArt,
             COUNT(t.id) AS songCount, SUM(t.duration) AS duration
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      WHERE al.artist_id = ? AND ${clause}
      GROUP BY al.id
      ORDER BY al.year, al.name COLLATE NOCASE
    `).all(artist.id, ...params);
    return sendOk(req, res, {
      directory: {
        id:    encArtist(artist.id),
        name:  artist.name,
        child: albums.map(al => ({
          id:       encAlbum(al.id),
          parent:   encArtist(artist.id),
          isDir:    true,
          title:    al.name,
          album:    al.name,
          artist:   artist.name,
          artistId: encArtist(artist.id),
          year:     al.year || undefined,
          coverArt: al.coverArt ? encAlbum(al.id) : undefined,
        })),
      },
    });
  }

  if (parsed.type === 'album') {
    const album = db.getDB().prepare(`
      SELECT al.id, al.name, a.name AS artist_name, al.artist_id
      FROM albums al LEFT JOIN artists a ON a.id = al.artist_id WHERE al.id = ?
    `).get(n);
    if (!album) { return SubErr.NOT_FOUND(req, res); }
    const { clause, params } = libraryScope(req);
    const songs = db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
             t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
             t.created_at, t.library_id,
             a.id AS artist_id, a.name AS artist_name,
             al.id AS album_id, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      LEFT JOIN albums  al ON al.id = t.album_id
      WHERE t.album_id = ? AND ${clause}
      ORDER BY t.disc_number, t.track_number, t.title
    `).all(album.id, ...params);
    return sendOk(req, res, {
      directory: {
        id:     encAlbum(album.id),
        parent: album.artist_id != null ? encArtist(album.artist_id) : undefined,
        name:   album.name,
        child:  enrichSongsWithUserMeta(req, songs.map(songFromRow)),
      },
    });
  }

  SubErr.NOT_FOUND(req, res);
}

// ── Media: cover art, stream, download ──────────────────────────────────────

// getCoverArt — accepts any of: song (bare numeric), album (al-N), artist
// (ar-N). Delegates to the shared album-art handler for byte serving.
export function getCoverArt(req, res) {
  const parsed = decodeId(req.query.id);
  if (!parsed) { return res.status(400).end(); }
  const size = parseInt(req.query.size, 10);

  const d = db.getDB();
  let artFile = null;
  if (parsed.type === 'song') {
    artFile = d.prepare('SELECT album_art_file FROM tracks WHERE id = ?').get(parsed.id)?.album_art_file;
  } else if (parsed.type === 'album') {
    artFile = d.prepare('SELECT album_art_file FROM albums WHERE id = ?').get(parsed.id)?.album_art_file
      || d.prepare('SELECT MIN(album_art_file) AS a FROM tracks WHERE album_id = ?').get(parsed.id)?.a;
  } else if (parsed.type === 'artist') {
    artFile = d.prepare(
      'SELECT MIN(album_art_file) AS a FROM tracks WHERE artist_id = ? AND album_art_file IS NOT NULL'
    ).get(parsed.id)?.a;
  }
  if (!artFile) { return res.status(404).end(); }

  // Delegate to serveAlbumArtFile using a synthesized req/res. Clients pass
  // pixel sizes; we have `s` (92px) and `l` (256px) cache variants.
  req.params = { file: artFile };
  if (Number.isFinite(size) && size <= 120) { req.query.compress = 's'; }
  else if (Number.isFinite(size) && size <= 300) { req.query.compress = 'l'; }
  return serveAlbumArtFile(req, res);
}

function resolveTrackForPlayback(req, id) {
  const { clause, params } = libraryScope(req);
  const row = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.format, t.bitrate, t.duration, t.library_id
    FROM tracks t
    WHERE t.id = ? AND ${clause}
  `).get(id, ...params);
  if (!row) { return null; }
  const lib = db.getAllLibraries().find(l => l.id === row.library_id);
  if (!lib) { return null; }
  const absPath = path.resolve(path.join(lib.root_path, row.filepath));
  const rootResolved = path.resolve(lib.root_path);
  if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) { return null; }
  return { row, lib, absPath };
}

const TRANSCODE_CODECS = {
  mp3:  { args: ['-c:a', 'libmp3lame'], mime: 'audio/mpeg', suffix: 'mp3',  format: 'mp3' },
  opus: { args: ['-c:a', 'libopus'],    mime: 'audio/ogg',  suffix: 'opus', format: 'ogg' },
  aac:  { args: ['-c:a', 'aac'],        mime: 'audio/mp4',  suffix: 'aac',  format: 'adts' },
};

function streamNative(req, res, track) {
  if (!fs.existsSync(track.absPath)) { return res.status(404).end(); }
  if (req.method === 'HEAD') {
    try {
      const st = fs.statSync(track.absPath);
      const suffix = suffixFor(track.row.filepath, track.row.format);
      res.status(200).set({
        'Content-Type':   contentTypeFor(suffix),
        'Content-Length': String(st.size),
        'Accept-Ranges':  'bytes',
      }).end();
    } catch { res.status(404).end(); }
    return;
  }
  res.sendFile(track.absPath, { dotfiles: 'allow' });
}

function streamTranscoded(req, res, track, codec, bitrateK, timeOffsetSec, estimateContentLength) {
  const spec = TRANSCODE_CODECS[codec];
  const args = ['-nostdin'];
  // `-ss` before `-i` uses input-seek (fast, keyframe-aligned) — good enough
  // for lossy sources where sample-accurate seek doesn't matter.
  if (Number.isFinite(timeOffsetSec) && timeOffsetSec > 0) {
    args.push('-ss', String(Math.floor(timeOffsetSec)));
  }
  args.push(
    '-i', track.absPath,
    '-vn', ...spec.args, '-b:a', `${bitrateK}k`,
    '-f', spec.format, '-loglevel', 'error',
    '-',
  );

  // Send headers first. If the caller asked for an estimate, compute one from
  // the remaining duration × bitrate so clients that require Content-Length
  // (e.g. Ultrasonic) can populate their seek bar.
  const headers = {
    'Content-Type': spec.mime,
    'transferMode.dlna.org': 'Streaming',
    'Connection': 'close',
  };
  if (estimateContentLength && Number.isFinite(track.row.duration)) {
    const remaining = Math.max(0, track.row.duration - (timeOffsetSec || 0));
    headers['Content-Length'] = String(Math.floor((remaining * bitrateK * 1000) / 8));
  }

  if (req.method === 'HEAD') {
    // Don't spawn ffmpeg for a probe — headers-only response is the contract.
    res.status(200).set(headers).end();
    return;
  }

  let ff;
  try { ff = spawn(ffmpegBin(), args); }
  catch (err) {
    winston.error('[subsonic] stream: ffmpeg spawn failed', { stack: err });
    return res.status(500).end();
  }
  res.status(200).set(headers);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => winston.debug(`[subsonic stream] ${d.toString().trim()}`));
  ff.on('error', err => {
    winston.error('[subsonic] ffmpeg error', { stack: err });
    try { res.end(); } catch { /* already closed */ }
  });
  const cleanup = () => { try { ff.kill('SIGKILL'); } catch { /* exited */ } };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export function stream(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return res.status(400).end(); }
  const track = resolveTrackForPlayback(req, parsed.id);
  if (!track) { return res.status(404).end(); }

  // Register now-playing so getNowPlaying can surface it. HEAD is a probe,
  // not real playback — skip registration. The handle-based unregister
  // protects against a slow-closing old stream from wiping a newer one out
  // of the map when the same user has overlapping playbacks.
  if (req.method !== 'HEAD') {
    try {
      const handle = nowPlaying.register(req.user.id, req.user.username, track.row.id);
      const off = () => nowPlaying.unregister(handle);
      req.on('close', off);
      res.on('close', off);
    } catch { /* non-fatal */ }
  }

  const requestedFormat = (req.query.format || '').toLowerCase();
  const maxBitRate = parseInt(req.query.maxBitRate, 10);
  const timeOffset = parseFloat(req.query.timeOffset);
  const estimateContentLength = req.query.estimateContentLength === 'true';
  const nativeFormat = (track.row.format || '').toLowerCase();
  const nativeBitRateK = track.row.bitrate ? Math.round(track.row.bitrate / 1000) : null;

  // Native streaming only works when no seek was requested — ffmpeg is needed
  // to shift the start offset mid-stream.
  const wantsNative =
    !requestedFormat || requestedFormat === 'raw' || requestedFormat === nativeFormat;
  const bitrateOk = !Number.isFinite(maxBitRate) || !nativeBitRateK || nativeBitRateK <= maxBitRate;
  const seekRequested = Number.isFinite(timeOffset) && timeOffset > 0;
  if (wantsNative && bitrateOk && !seekRequested) {
    return streamNative(req, res, track);
  }

  // Pick a codec. Prefer the requested one if supported; otherwise fall back
  // to the server default.
  const codec = TRANSCODE_CODECS[requestedFormat]
    ? requestedFormat
    : config.program.transcode.defaultCodec;
  const bitrateK = Number.isFinite(maxBitRate) ? maxBitRate : parseInt(config.program.transcode.defaultBitrate, 10);
  streamTranscoded(req, res, track, codec, bitrateK, timeOffset, estimateContentLength);
}

export function download(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return res.status(400).end(); }
  const track = resolveTrackForPlayback(req, parsed.id);
  if (!track) { return res.status(404).end(); }
  if (!fs.existsSync(track.absPath)) { return res.status(404).end(); }
  res.sendFile(track.absPath, { dotfiles: 'allow' });
}

// ── Search ──────────────────────────────────────────────────────────────────

function normalizeQueryFragment(q) {
  // Subsonic clients typically send `"foo"` (Lucene-ish) or bare `foo`. Strip
  // quotes and wildcards — we do simple LIKE matches.
  return String(q || '').trim().replace(/[*"%_]/g, '').toLowerCase();
}

export function search3(req, res) {
  const q = normalizeQueryFragment(req.query.query);
  const artistCount = Math.max(0, parseInt(req.query.artistCount, 10) || 20);
  const albumCount  = Math.max(0, parseInt(req.query.albumCount,  10) || 20);
  const songCount   = Math.max(0, parseInt(req.query.songCount,   10) || 20);
  const artistOffset = Math.max(0, parseInt(req.query.artistOffset, 10) || 0);
  const albumOffset  = Math.max(0, parseInt(req.query.albumOffset,  10) || 0);
  const songOffset   = Math.max(0, parseInt(req.query.songOffset,   10) || 0);

  if (!q) {
    return sendOk(req, res, { searchResult3: {} });
  }

  const { clause, params } = libraryScope(req);
  const like = `%${q}%`;

  const d = db.getDB();
  const artists = d.prepare(`
    SELECT DISTINCT a.id, a.name
    FROM artists a
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    WHERE ${clause} AND LOWER(a.name) LIKE ?
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...params, like, artistCount, artistOffset);

  const albums = d.prepare(`
    SELECT DISTINCT al.id, al.name, al.year, al.album_art_file, al.artist_id,
                    a.name AS artist_name
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    WHERE ${clause} AND LOWER(al.name) LIKE ?
    GROUP BY al.id
    ORDER BY al.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...params, like, albumCount, albumOffset);

  const songs = d.prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${clause} AND LOWER(t.title) LIKE ?
    ORDER BY t.title COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...params, like, songCount, songOffset);

  sendOk(req, res, {
    searchResult3: {
      artist: artists.map(a => ({
        id: encArtist(a.id), name: a.name, coverArt: encArtist(a.id),
      })),
      album: albums.map(al => ({
        id:       encAlbum(al.id),
        name:     al.name,
        title:    al.name,
        artist:   al.artist_name || undefined,
        artistId: al.artist_id != null ? encArtist(al.artist_id) : undefined,
        year:     al.year || undefined,
        coverArt: al.album_art_file ? encAlbum(al.id) : undefined,
      })),
      song: enrichSongsWithUserMeta(req, songs.map(songFromRow)),
    },
  });
}

// Legacy search + search2 are thin wrappers around search3 for old clients.
export function search(req, res)  { search3(req, res); }
export function search2(req, res) { search3(req, res); }

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 — scrobble, favourites, playlists, album lists
// ════════════════════════════════════════════════════════════════════════════

// ── Scrobble ────────────────────────────────────────────────────────────────

// Subsonic `scrobble` is called in two modes:
//   submission=false → "now playing" (we're about to/just started playing)
//   submission=true  → "completed play" (update stats)
// We only increment counts on submission=true.
export function scrobble(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const submission = req.query.submission !== 'false'; // default true per spec

  // submission=false is the "now playing" signal — register the user as
  // currently playing this track but don't bump play_count.
  if (!submission) {
    nowPlaying.register(req.user.id, req.user.username, parsed.id);
    return sendOk(req, res);
  }

  const hash = trackFileHash(parsed.id);
  if (!hash) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  // Subsonic passes milliseconds since epoch; we store an ISO-ish datetime.
  const ms = parseInt(req.query.time, 10);
  const when = Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;

  // Bump play_count; set last_played to the supplied time or now.
  const d = db.getDB();
  d.prepare('INSERT OR IGNORE INTO user_metadata (user_id, track_hash) VALUES (?, ?)')
    .run(req.user.id, hash);
  d.prepare(`
    UPDATE user_metadata
    SET play_count = COALESCE(play_count, 0) + 1,
        last_played = COALESCE(?, datetime('now'))
    WHERE user_id = ? AND track_hash = ?
  `).run(when, req.user.id, hash);

  sendOk(req, res);
}

// ── Star / unstar / setRating / getStarred{,2} ─────────────────────────────

// Starring is per-user and tracked in three tables:
//
//   user_metadata.starred_at  — song stars (set alongside ratings)
//   user_album_stars          — album stars
//   user_artist_stars         — artist stars
//
// Earlier phases synthesised album/artist stars by flagging every child track,
// which lost information (unstarring a track unstarred "the album"). Phase 3
// stores each grain independently.

function collectIds(req) {
  return {
    songIds:   arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite),
    albumIds:  arrayParam(req.query.albumId).map(v => decodeId(v, 'album')?.id).filter(Number.isFinite),
    artistIds: arrayParam(req.query.artistId).map(v => decodeId(v, 'artist')?.id).filter(Number.isFinite),
  };
}

function starSongs(userId, songIds) {
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const id of songIds) {
    const hash = trackFileHash(id);
    if (hash) { upsertUserMeta(userId, hash, { starred_at: nowIso }); }
  }
}
function unstarSongs(userId, songIds) {
  for (const id of songIds) {
    const hash = trackFileHash(id);
    if (hash) { upsertUserMeta(userId, hash, { starred_at: null }); }
  }
}
function starAlbums(userId, albumIds) {
  const stmt = db.getDB().prepare(
    `INSERT INTO user_album_stars (user_id, album_id) VALUES (?, ?)
     ON CONFLICT(user_id, album_id) DO UPDATE SET starred_at = datetime('now')`
  );
  for (const id of albumIds) { stmt.run(userId, id); }
}
function unstarAlbums(userId, albumIds) {
  const stmt = db.getDB().prepare('DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?');
  for (const id of albumIds) { stmt.run(userId, id); }
}
function starArtists(userId, artistIds) {
  const stmt = db.getDB().prepare(
    `INSERT INTO user_artist_stars (user_id, artist_id) VALUES (?, ?)
     ON CONFLICT(user_id, artist_id) DO UPDATE SET starred_at = datetime('now')`
  );
  for (const id of artistIds) { stmt.run(userId, id); }
}
function unstarArtists(userId, artistIds) {
  const stmt = db.getDB().prepare('DELETE FROM user_artist_stars WHERE user_id = ? AND artist_id = ?');
  for (const id of artistIds) { stmt.run(userId, id); }
}

export function star(req, res) {
  const { songIds, albumIds, artistIds } = collectIds(req);
  if (!songIds.length && !albumIds.length && !artistIds.length) {
    return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId');
  }
  starSongs(req.user.id, songIds);
  starAlbums(req.user.id, albumIds);
  starArtists(req.user.id, artistIds);
  sendOk(req, res);
}

export function unstar(req, res) {
  const { songIds, albumIds, artistIds } = collectIds(req);
  if (!songIds.length && !albumIds.length && !artistIds.length) {
    return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId');
  }
  unstarSongs(req.user.id, songIds);
  unstarAlbums(req.user.id, albumIds);
  unstarArtists(req.user.id, artistIds);
  sendOk(req, res);
}

export function setRating(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const rating = parseInt(req.query.rating, 10);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return SubErr.GENERIC(req, res, 'rating must be 0..5');
  }
  const hash = trackFileHash(parsed.id);
  if (!hash) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  upsertUserMeta(req.user.id, hash, { rating: rating === 0 ? null : rating });
  sendOk(req, res);
}

// Fetch a user's starred-song rows, optionally library-scoped.
function starredSongRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    JOIN user_metadata um ON um.track_hash = t.file_hash AND um.user_id = ?
    WHERE ${clause} AND um.starred_at IS NOT NULL
    ORDER BY um.starred_at DESC
  `).all(req.user.id, ...params);
}

// Starred albums for the caller, scoped to their libraries via the existing
// album-list machinery. We reuse buildAlbumListQuery's select shape by going
// direct — the 'starred' type used to synthesise from child tracks, which
// this replaces.
function starredAlbumRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           MIN(t.genre) AS genre, MIN(t.created_at) AS created_at,
           s.starred_at AS starred_at
    FROM user_album_stars s
    JOIN albums al ON al.id = s.album_id
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    WHERE s.user_id = ? AND ${clause}
    GROUP BY al.id
    HAVING songCount > 0
    ORDER BY s.starred_at DESC
  `).all(req.user.id, ...params);
}

function starredArtistRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT a.id, a.name, s.starred_at,
           COUNT(DISTINCT al.id) AS albumCount,
           MIN(al.album_art_file) AS coverArt
    FROM user_artist_stars s
    JOIN artists a ON a.id = s.artist_id
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    WHERE s.user_id = ? AND ${clause}
    GROUP BY a.id
    HAVING albumCount > 0
    ORDER BY s.starred_at DESC
  `).all(req.user.id, ...params);
}

function artistFromStarredRow(a) {
  return {
    id:         encArtist(a.id),
    name:       a.name,
    albumCount: a.albumCount,
    coverArt:   a.coverArt ? encArtist(a.id) : undefined,
    starred:    a.starred_at ? isoUtc(a.starred_at) : undefined,
  };
}

export function getStarred2(req, res) {
  const songs = enrichSongsWithUserMeta(req, starredSongRows(req).map(songFromRow));
  const albums = starredAlbumRows(req).map(albumFromListRow);
  const artists = starredArtistRows(req).map(artistFromStarredRow);
  sendOk(req, res, {
    starred2: { artist: artists, album: albums, song: songs },
  });
}

// v1 getStarred. Shape is almost identical to getStarred2 but under the
// `starred` key. Clients that predate ID3-based browsing use this.
export function getStarred(req, res) {
  const songs = enrichSongsWithUserMeta(req, starredSongRows(req).map(songFromRow));
  const albums = starredAlbumRows(req).map(albumFromListRow);
  const artists = starredArtistRows(req).map(artistFromStarredRow);
  sendOk(req, res, {
    starred: { artist: artists, album: albums, song: songs },
  });
}

// ── Album lists ────────────────────────────────────────────────────────────

// Shared album-list query: returns albums ordered by the given SQL tail
// (ORDER BY + LIMIT/OFFSET), scoped to the caller's libraries. `type` decides
// which ordering we synthesize.
function buildAlbumListQuery(req, type, params = {}) {
  const size   = Math.min(Math.max(parseInt(params.size, 10) || 10, 1), 500);
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);
  const { clause, params: libParams } = libraryScope(req);

  // Base select + join schema used by every type. user_album_stars is joined
  // at the album level so the `starred` column reflects proper album-level
  // star state (not "any one track is starred" — fixed in Phase 3).
  const base = `
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           MIN(t.genre) AS genre, MIN(t.created_at) AS created_at,
           uas.starred_at AS starred_at,
           MAX(um.rating) AS rating_max,
           SUM(COALESCE(um.play_count, 0)) AS plays,
           MAX(um.last_played) AS last_played
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    LEFT JOIN user_metadata um ON um.track_hash = t.file_hash AND um.user_id = ?
    LEFT JOIN user_album_stars uas ON uas.album_id = al.id AND uas.user_id = ?
    WHERE ${clause}
  `;
  const tailParams = [req.user.id, req.user.id, ...libParams];

  let where   = '';           // row-level filter (WHERE clause tail)
  let having  = 'songCount > 0'; // group-level filter (HAVING clause)
  let order   = 'al.name COLLATE NOCASE';

  switch (type) {
    case 'newest':    order = 'MIN(t.created_at) DESC'; break;
    case 'recent':    having += ' AND MAX(um.last_played) IS NOT NULL'; order = 'MAX(um.last_played) DESC'; break;
    case 'frequent':  having += ' AND plays > 0';                        order = 'plays DESC'; break;
    case 'highest':   having += ' AND rating_max IS NOT NULL';           order = 'rating_max DESC'; break;
    case 'starred':   having += ' AND uas.starred_at IS NOT NULL';       order = 'uas.starred_at DESC'; break;
    case 'random':    order = 'RANDOM()'; break;
    case 'byYear': {
      const from = parseInt(params.fromYear, 10);
      const to   = parseInt(params.toYear, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) { return null; }
      where = 'AND al.year BETWEEN ? AND ?';
      tailParams.push(Math.min(from, to), Math.max(from, to));
      order = from <= to ? 'al.year ASC' : 'al.year DESC';
      break;
    }
    case 'byGenre': {
      if (!params.genre) { return null; }
      where = 'AND t.genre = ?';
      tailParams.push(params.genre);
      // order stays at the default alphabetical
      break;
    }
    case 'alphabeticalByArtist': order = 'a.name COLLATE NOCASE, al.name COLLATE NOCASE'; break;
    case 'alphabeticalByName':
    default:
      order = 'al.name COLLATE NOCASE';
  }

  tailParams.push(size, offset);
  return {
    sql: `${base} ${where} GROUP BY al.id HAVING ${having} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: tailParams,
  };
}

function albumFromListRow(al) {
  return {
    id:        encAlbum(al.id),
    parent:    al.artist_id != null ? encArtist(al.artist_id) : undefined,
    isDir:     true,
    name:      al.name,
    title:     al.name,
    album:     al.name,
    artist:    al.artist_name || undefined,
    artistId:  al.artist_id != null ? encArtist(al.artist_id) : undefined,
    year:      al.year || undefined,
    genre:     al.genre || undefined,
    coverArt:  al.album_art_file ? encAlbum(al.id) : undefined,
    songCount: al.songCount,
    duration:  al.duration != null ? Math.round(al.duration) : undefined,
    created:   isoUtc(al.created_at),
    starred:   al.starred_at ? isoUtc(al.starred_at) : undefined,
    playCount: al.plays > 0 ? al.plays : undefined,
  };
}

export function getAlbumList2(req, res) {
  const type = String(req.query.type || 'alphabeticalByName');
  const query = buildAlbumListQuery(req, type, req.query);
  if (!query) { return SubErr.MISSING_PARAM(req, res, type === 'byYear' ? 'fromYear/toYear' : 'genre'); }
  const rows = db.getDB().prepare(query.sql).all(...query.params);
  sendOk(req, res, { albumList2: { album: rows.map(albumFromListRow) } });
}

// v1 client path. Same payload under the older tag.
export function getAlbumList(req, res) {
  const type = String(req.query.type || 'alphabeticalByName');
  const query = buildAlbumListQuery(req, type, req.query);
  if (!query) { return SubErr.MISSING_PARAM(req, res, type === 'byYear' ? 'fromYear/toYear' : 'genre'); }
  const rows = db.getDB().prepare(query.sql).all(...query.params);
  sendOk(req, res, { albumList: { album: rows.map(albumFromListRow) } });
}

// ── Random songs / songs by genre ──────────────────────────────────────────

export function getRandomSongs(req, res) {
  const size   = Math.min(Math.max(parseInt(req.query.size, 10) || 10, 1), 500);
  const fromY  = parseInt(req.query.fromYear, 10);
  const toY    = parseInt(req.query.toYear, 10);
  const genre  = req.query.genre || null;
  const folder = decodeId(req.query.musicFolderId, 'folder');

  const { clause, params } = libraryScope(req);
  const where = [clause];
  const args  = [...params];
  if (genre)                    { where.push('t.genre = ?'); args.push(genre); }
  if (Number.isFinite(fromY))   { where.push('t.year >= ?'); args.push(fromY); }
  if (Number.isFinite(toY))     { where.push('t.year <= ?'); args.push(toY); }
  if (folder)                   { where.push('t.library_id = ?'); args.push(folder.id); }

  const rows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${where.join(' AND ')}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...args, size);

  sendOk(req, res, {
    randomSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

export function getSongsByGenre(req, res) {
  const genre  = req.query.genre;
  if (!genre) { return SubErr.MISSING_PARAM(req, res, 'genre'); }
  const count  = Math.min(Math.max(parseInt(req.query.count,  10) || 10, 1), 500);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const folder = decodeId(req.query.musicFolderId, 'folder');

  const { clause, params } = libraryScope(req);
  const where = [clause, 't.genre = ?'];
  const args  = [...params, genre];
  if (folder) { where.push('t.library_id = ?'); args.push(folder.id); }

  const rows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.disc_number, t.track_number
    LIMIT ? OFFSET ?
  `).all(...args, count, offset);

  sendOk(req, res, {
    songsByGenre: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

// ── Playlists ──────────────────────────────────────────────────────────────
// mStream stores playlist_tracks.filepath as "<vpath>/<relpath>". Subsonic
// clients pass song IDs; we translate between the two on insert/retrieval.

function filepathForSong(trackId) {
  const row = db.getDB().prepare(`
    SELECT t.filepath AS rel, l.name AS vpath
    FROM tracks t JOIN libraries l ON l.id = t.library_id
    WHERE t.id = ?
  `).get(trackId);
  return row ? `${row.vpath}/${row.rel}` : null;
}

function playlistMeta(playlistId, userId) {
  return db.getDB().prepare(`
    SELECT p.id, p.name, p.created_at, p.user_id, u.username,
           (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS songCount,
           (SELECT COALESCE(SUM(t.duration), 0) FROM playlist_tracks pt
              JOIN libraries l ON l.name =
                CASE WHEN INSTR(pt.filepath, '/') > 0
                     THEN SUBSTR(pt.filepath, 1, INSTR(pt.filepath, '/') - 1)
                     ELSE pt.filepath END
              JOIN tracks t ON t.library_id = l.id AND t.filepath =
                CASE WHEN INSTR(pt.filepath, '/') > 0
                     THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
                     ELSE '' END
              WHERE pt.playlist_id = p.id) AS duration
    FROM playlists p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND p.user_id = ?
  `).get(playlistId, userId);
}

function playlistSummary(row) {
  return {
    id:        `pl-${row.id}`,
    name:      row.name,
    owner:     row.username,
    public:    false, // mStream has no public-flag concept yet
    songCount: row.songCount,
    duration:  Math.round(row.duration || 0),
    created:   isoUtc(row.created_at),
    changed:   isoUtc(row.created_at),
  };
}

function decodePlaylistId(raw) {
  const s = String(raw || '');
  const m = /^(?:pl-)?(\d+)$/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

export function getPlaylists(req, res) {
  const rows = db.getDB().prepare(`
    SELECT p.id, p.name, p.created_at, p.user_id, u.username,
           (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS songCount,
           0 AS duration
    FROM playlists p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ?
    ORDER BY p.name COLLATE NOCASE
  `).all(req.user.id);
  sendOk(req, res, { playlists: { playlist: rows.map(playlistSummary) } });
}

export function getPlaylist(req, res) {
  const id = decodePlaylistId(req.query.id);
  if (id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const meta = playlistMeta(id, req.user.id);
  if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }

  // Resolve tracks by splitting pt.filepath at the first `/`.
  const tracks = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM playlist_tracks pt
    JOIN libraries l ON l.name = CASE
        WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, 1, INSTR(pt.filepath, '/') - 1)
        ELSE pt.filepath END
    JOIN tracks t ON t.library_id = l.id AND t.filepath = CASE
        WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
        ELSE '' END
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).all(id);

  sendOk(req, res, {
    playlist: {
      ...playlistSummary(meta),
      entry: enrichSongsWithUserMeta(req, tracks.map(songFromRow)),
    },
  });
}

function addSongsToPlaylist(playlistId, songIds, startPosition) {
  const stmt = db.getDB().prepare(
    'INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?, ?, ?)'
  );
  let pos = startPosition;
  for (const sid of songIds) {
    const fp = filepathForSong(sid);
    if (fp) { stmt.run(playlistId, fp, pos++); }
  }
}

export function createPlaylist(req, res) {
  const name = String(req.query.name || '').trim();
  const updatePlaylistId = decodePlaylistId(req.query.playlistId);
  const songIds = arrayParam(req.query.songId).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  const d = db.getDB();

  if (updatePlaylistId != null) {
    // Subsonic overloads createPlaylist: passing playlistId replaces contents.
    const meta = playlistMeta(updatePlaylistId, req.user.id);
    if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
    d.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(updatePlaylistId);
    addSongsToPlaylist(updatePlaylistId, songIds, 0);
    if (name) { d.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, updatePlaylistId); }
    return getPlaylist({ ...req, query: { ...req.query, id: `pl-${updatePlaylistId}` } }, res);
  }

  if (!name) { return SubErr.MISSING_PARAM(req, res, 'name'); }
  const result = d.prepare('INSERT INTO playlists (name, user_id) VALUES (?, ?)').run(name, req.user.id);
  const newId = Number(result.lastInsertRowid);
  addSongsToPlaylist(newId, songIds, 0);
  return getPlaylist({ ...req, query: { ...req.query, id: `pl-${newId}` } }, res);
}

export function updatePlaylist(req, res) {
  const id = decodePlaylistId(req.query.playlistId);
  if (id == null) { return SubErr.MISSING_PARAM(req, res, 'playlistId'); }
  const meta = playlistMeta(id, req.user.id);
  if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }

  const d = db.getDB();
  if (req.query.name) { d.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(String(req.query.name), id); }
  // `public` and `comment` are accepted but ignored (no schema for them yet).

  // Remove entries by zero-based index (into current sorted position list).
  const removeIdx = arrayParam(req.query.songIndexToRemove).map(v => parseInt(v, 10)).filter(Number.isFinite);
  if (removeIdx.length) {
    const rows = d.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(id);
    const toDelete = removeIdx.filter(i => i >= 0 && i < rows.length).map(i => rows[i].id);
    if (toDelete.length) {
      const ph = toDelete.map(() => '?').join(',');
      d.prepare(`DELETE FROM playlist_tracks WHERE id IN (${ph})`).run(...toDelete);
    }
  }

  // Append new songs at the end.
  const toAdd = arrayParam(req.query.songIdToAdd).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  if (toAdd.length) {
    const maxPos = d.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks WHERE playlist_id = ?').get(id).p;
    addSongsToPlaylist(id, toAdd, maxPos);
  }

  sendOk(req, res);
}

export function deletePlaylist(req, res) {
  const id = decodePlaylistId(req.query.id);
  if (id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const result = db.getDB().prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (result.changes === 0) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  sendOk(req, res);
}

// ── Phase 3: OpenSubsonic extensions manifest ─────────────────────────────
//
// Declared extensions — the client probes this to decide which optional
// features to use. Keep this list in sync with what we actually implement
// across phases. Each entry is { name, versions: [numbers] }.

const OPENSUBSONIC_EXTENSIONS = [
  { name: 'formPost',          versions: [1] },    // POST bodies accepted on every endpoint
  { name: 'apiKeyAuthentication', versions: [1] }, // `apiKey=` auth
  { name: 'transcodeOffset',   versions: [1] },    // `timeOffset` supported on stream
  { name: 'httpHeaders',       versions: [1] },    // HEAD + Content-Length estimate
];

export function getOpenSubsonicExtensions(req, res) {
  sendOk(req, res, { openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS });
}

// ── Phase 3: User management ───────────────────────────────────────────────
//
// Thin wrappers around src/util/admin.js so validation, hashing, and vpath
// linking happen in exactly one place. Admin-only endpoints guard with
// `req.user.admin`; self-service endpoints let users change their own data.

function userToSubsonicShape(row, libNames) {
  const isAdmin = !!row.is_admin;
  return {
    username:          row.username,
    email:             row.email || undefined,
    scrobblingEnabled: true,
    adminRole:         isAdmin,
    settingsRole:      isAdmin,
    downloadRole:      true,
    uploadRole:        !!row.allow_upload,
    playlistRole:      true,
    coverArtRole:      isAdmin,
    commentRole:       false,
    podcastRole:       false,
    streamRole:        true,
    jukeboxRole:       false,
    shareRole:         true,
    videoConversionRole: false,
    folder:            libNames,
  };
}

function vpathsForUser(row) {
  const libIds = db.getUserLibraryIds(row);
  return db.getAllLibraries().filter(l => libIds.includes(l.id)).map(l => l.name);
}

export function getUser(req, res) {
  const wanted = req.query.username ? String(req.query.username) : req.user.username;
  // Non-admins can only query themselves.
  if (wanted !== req.user.username && !req.user.admin) {
    return SubErr.NOT_AUTHORIZED(req, res);
  }
  const row = db.getUserByUsername(wanted);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'User'); }
  sendOk(req, res, { user: userToSubsonicShape(row, vpathsForUser(row)) });
}

export function getUsers(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const rows = db.getAllUsers();
  sendOk(req, res, {
    users: { user: rows.map(r => userToSubsonicShape(r, vpathsForUser(r))) },
  });
}

export async function createUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  const password = String(req.query.password || '');
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (!password) { return SubErr.MISSING_PARAM(req, res, 'password'); }

  const plainPassword = password.startsWith('enc:')
    ? Buffer.from(password.slice(4), 'hex').toString('utf8')
    : password;
  const adminRole    = req.query.adminRole === 'true';
  const uploadRole   = req.query.uploadRole !== 'false';
  // Subsonic's `musicFolderId` is repeatable — map each id back to a vpath.
  const folderIds = arrayParam(req.query.musicFolderId)
    .map(v => decodeId(v, 'folder')?.id)
    .filter(Number.isFinite);
  const libs = db.getAllLibraries();
  const vpaths = folderIds.length
    ? libs.filter(l => folderIds.includes(l.id)).map(l => l.name)
    : libs.map(l => l.name); // default: grant everything

  try {
    await adminUtil.addUser(username, plainPassword, adminRole, vpaths, true, uploadRole);
    sendOk(req, res);
  } catch (err) {
    return SubErr.GENERIC(req, res, err.message || 'createUser failed');
  }
}

export async function updateUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  const row = db.getUserByUsername(username);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'User'); }

  // Only update fields the client actually sent.
  const adminRole    = 'adminRole'  in req.query ? req.query.adminRole  === 'true' : !!row.is_admin;
  const uploadRole   = 'uploadRole' in req.query ? req.query.uploadRole === 'true' : !!row.allow_upload;
  await adminUtil.editUserAccess(username, adminRole, !!row.allow_mkdir, uploadRole,
    row.allow_file_modify == null ? true : !!row.allow_file_modify);

  if ('musicFolderId' in req.query) {
    const folderIds = arrayParam(req.query.musicFolderId)
      .map(v => decodeId(v, 'folder')?.id)
      .filter(Number.isFinite);
    const libs = db.getAllLibraries();
    const vpaths = libs.filter(l => folderIds.includes(l.id)).map(l => l.name);
    await adminUtil.editUserVPaths(username, vpaths);
  }

  if (req.query.password) {
    const plain = String(req.query.password).startsWith('enc:')
      ? Buffer.from(String(req.query.password).slice(4), 'hex').toString('utf8')
      : String(req.query.password);
    await adminUtil.editUserPassword(username, plain);
  }
  sendOk(req, res);
}

export async function deleteUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (username === req.user.username) {
    return SubErr.GENERIC(req, res, 'Cannot delete the currently authenticated user.');
  }
  try {
    await adminUtil.deleteUser(username);
    sendOk(req, res);
  } catch {
    return SubErr.NOT_FOUND(req, res, 'User');
  }
}

export async function changePassword(req, res) {
  const username = String(req.query.username || '').trim();
  const password = String(req.query.password || '');
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (!password) { return SubErr.MISSING_PARAM(req, res, 'password'); }
  // Self-service or admin.
  if (username !== req.user.username && !req.user.admin) {
    return SubErr.NOT_AUTHORIZED(req, res);
  }
  const plain = password.startsWith('enc:')
    ? Buffer.from(password.slice(4), 'hex').toString('utf8')
    : password;
  try {
    await adminUtil.editUserPassword(username, plain);
    sendOk(req, res);
  } catch {
    return SubErr.NOT_FOUND(req, res, 'User');
  }
}

// ── Phase 3: Similar songs & top songs ─────────────────────────────────────
//
// No LastFM dependency. `getTopSongs` is straight from local play counts.
// `getSimilarSongs{,2}` uses a "same artist, then shared-genre peers" local
// heuristic — good enough to make client Shuffle / recommendation features
// light up instead of showing empty state.

function songQueryBase() {
  return `
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
  `;
}

export function getTopSongs(req, res) {
  const artistName = String(req.query.artist || '').trim();
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);
  if (!artistName) { return SubErr.MISSING_PARAM(req, res, 'artist'); }

  const { clause, params } = libraryScope(req);
  const rows = db.getDB().prepare(`
    ${songQueryBase()}
    LEFT JOIN user_metadata um ON um.track_hash = t.file_hash AND um.user_id = ?
    WHERE ${clause} AND a.name = ?
    ORDER BY COALESCE(um.play_count, 0) DESC, um.last_played DESC, t.title
    LIMIT ?
  `).all(req.user.id, ...params, artistName, count);

  sendOk(req, res, {
    topSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

function similarSongsFor(req, artistId, count) {
  const { clause, params } = libraryScope(req);
  // Tier 1: tracks by the same artist.
  const sameArtist = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE ${clause} AND t.artist_id = ?
    ORDER BY RANDOM() LIMIT ?
  `).all(...params, artistId, count);
  if (sameArtist.length >= count) { return sameArtist.slice(0, count); }

  // Tier 2: tracks that share at least one genre with any of this artist's
  // tracks, excluding the artist's own tracks.
  const genres = db.getDB().prepare(`
    SELECT DISTINCT t.genre FROM tracks t
    WHERE t.artist_id = ? AND t.genre IS NOT NULL AND t.genre <> ''
  `).all(artistId).map(r => r.genre);

  if (!genres.length) { return sameArtist; }

  const genrePh = genres.map(() => '?').join(',');
  const remaining = count - sameArtist.length;
  const related = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE ${clause} AND t.artist_id <> ? AND t.genre IN (${genrePh})
    ORDER BY RANDOM() LIMIT ?
  `).all(...params, artistId, ...genres, remaining);

  return [...sameArtist, ...related];
}

export function getSimilarSongs(req, res) {
  // v1 accepts any id (artist / album / song) — pick the enclosing artist.
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);

  const artistId = (() => {
    if (parsed.type === 'artist') { return parsed.id; }
    if (parsed.type === 'album')  { return db.getDB().prepare('SELECT artist_id FROM albums WHERE id = ?').get(parsed.id)?.artist_id; }
    return db.getDB().prepare('SELECT artist_id FROM tracks WHERE id = ?').get(parsed.id)?.artist_id;
  })();
  if (!artistId) { return SubErr.NOT_FOUND(req, res, 'Artist'); }

  const rows = similarSongsFor(req, artistId, count);
  sendOk(req, res, {
    similarSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

export function getSimilarSongs2(req, res) {
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);
  const rows = similarSongsFor(req, parsed.id, count);
  sendOk(req, res, {
    similarSongs2: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

// ── Phase 3: Now playing ───────────────────────────────────────────────────

export function getNowPlaying(req, res) {
  const snap = nowPlaying.snapshot();
  if (!snap.length) {
    return sendOk(req, res, { nowPlaying: { entry: [] } });
  }

  const trackIds = snap.map(s => s.trackId);
  const ph = trackIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE t.id IN (${ph})
  `).all(...trackIds);
  const byId = new Map(rows.map(r => [r.id, r]));

  const entry = snap.map(s => {
    const r = byId.get(s.trackId);
    if (!r) { return null; }
    const song = songFromRow(r);
    return {
      ...song,
      username:  s.username,
      // Seconds since this player's stream started. The spec calls this
      // `minutesAgo` — we convert.
      minutesAgo: Math.max(0, Math.floor((Date.now() - s.since) / 60000)),
      playerId:  s.userId, // stable per-user; matches Subsonic's loose usage
    };
  }).filter(Boolean);

  sendOk(req, res, { nowPlaying: { entry } });
}

// ── Phase 3: Scan status / start ───────────────────────────────────────────

export function getScanStatus(req, res) {
  // The scanner exposes its progress via dbQueue; we also report the total
  // number of tracks known so clients can display a "library size" number.
  const total = db.getDB().prepare('SELECT COUNT(*) AS n FROM tracks').get()?.n || 0;
  const scanning = typeof dbQueue.isScanning === 'function' ? !!dbQueue.isScanning() : false;
  sendOk(req, res, { scanStatus: { scanning, count: total } });
}

export function startScan(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  try { dbQueue.scanAll(); } catch { /* already scanning */ }
  // Return the fresh status so clients can immediately display progress.
  return getScanStatus(req, res);
}

// ── Phase 3: Artist/album info stubs ──────────────────────────────────────
//
// LastFM/MusicBrainz bios aren't in scope. We return the minimum shape with
// real similar-artists (computed from shared genres) so client "Info" panels
// render something useful instead of falling back to an error.

function similarArtistsFor(artistId, limit = 10) {
  const { clause: libClause, params: libParams } = { clause: '1=1', params: [] }; // libraries don't apply to artist rows
  void libClause; void libParams;
  // Artists sharing ≥1 genre with the target, scored by shared-genre count.
  return db.getDB().prepare(`
    WITH our_genres AS (
      SELECT DISTINCT t.genre FROM tracks t
      WHERE t.artist_id = ? AND t.genre IS NOT NULL AND t.genre <> ''
    )
    SELECT a.id, a.name,
           COUNT(DISTINCT t.genre) AS shared,
           COUNT(DISTINCT al.id)   AS albumCount
    FROM artists a
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    WHERE a.id <> ? AND t.genre IN (SELECT genre FROM our_genres)
    GROUP BY a.id
    HAVING shared > 0
    ORDER BY shared DESC, albumCount DESC
    LIMIT ?
  `).all(artistId, artistId, limit);
}

function artistInfoPayload(artistRow) {
  const similar = similarArtistsFor(artistRow.id, 10);
  return {
    biography:      '',
    musicBrainzId:  artistRow.mbz_artist_id || undefined,
    lastFmUrl:      undefined,
    smallImageUrl:  undefined,
    mediumImageUrl: undefined,
    largeImageUrl:  undefined,
    similarArtist:  similar.map(s => ({
      id:         encArtist(s.id),
      name:       s.name,
      albumCount: s.albumCount,
    })),
  };
}

export function getArtistInfo(req, res) {
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const artistId = parsed.type === 'artist' ? parsed.id
    : (parsed.type === 'album' ? db.getDB().prepare('SELECT artist_id FROM albums WHERE id = ?').get(parsed.id)?.artist_id
    : db.getDB().prepare('SELECT artist_id FROM tracks WHERE id = ?').get(parsed.id)?.artist_id);
  if (!artistId) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const row = db.getDB().prepare('SELECT id, name, mbz_artist_id FROM artists WHERE id = ?').get(artistId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  sendOk(req, res, { artistInfo: artistInfoPayload(row) });
}

export function getArtistInfo2(req, res) {
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT id, name, mbz_artist_id FROM artists WHERE id = ?').get(parsed.id);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  sendOk(req, res, { artistInfo2: artistInfoPayload(row) });
}

function albumInfoPayload(albumRow) {
  return {
    notes:          '',
    musicBrainzId:  albumRow.mbz_album_id || undefined,
    lastFmUrl:      undefined,
    smallImageUrl:  undefined,
    mediumImageUrl: undefined,
    largeImageUrl:  undefined,
  };
}

export function getAlbumInfo(req, res) {
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const albumId = parsed.type === 'album' ? parsed.id
    : (parsed.type === 'song' ? db.getDB().prepare('SELECT album_id FROM tracks WHERE id = ?').get(parsed.id)?.album_id : null);
  if (!albumId) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  const row = db.getDB().prepare('SELECT id, mbz_album_id FROM albums WHERE id = ?').get(albumId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  sendOk(req, res, { albumInfo: albumInfoPayload(row) });
}

export function getAlbumInfo2(req, res) {
  const parsed = decodeId(req.query.id, 'album');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT id, mbz_album_id FROM albums WHERE id = ?').get(parsed.id);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  sendOk(req, res, { albumInfo2: albumInfoPayload(row) });
}

// ── Phase 3: Avatar (identicon) ───────────────────────────────────────────

export async function getAvatar(req, res) {
  const username = String(req.query.username || req.user.username);
  try {
    const buf = await identiconFor(username, 128);
    res.status(200).set({
      'Content-Type':  'image/png',
      'Cache-Control': 'public, max-age=3600',
    }).send(buf);
  } catch (err) {
    winston.error('[subsonic] getAvatar failed', { stack: err });
    res.status(404).end();
  }
}

// ── Phase 3: Shares ───────────────────────────────────────────────────────
//
// Subsonic shares map onto mStream's existing `shared_playlists` table.
// `playlist_json` is already a JSON array of "<vpath>/<relpath>" strings,
// which is exactly what mStream's share-view webapp reads. We convert song
// IDs to that form on create and back to songs on read.

function shareRowToPayload(row, sharePrefix) {
  const entries = JSON.parse(row.playlist_json || '[]');
  // Resolve each "<vpath>/<relpath>" filepath back to a track row so we can
  // emit the full Subsonic song object.
  const stmt = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    JOIN libraries l ON l.id = t.library_id
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE l.name = ? AND t.filepath = ?
  `);
  const songRows = [];
  for (const fp of entries) {
    const slash = fp.indexOf('/');
    if (slash < 0) { continue; }
    const vpath = fp.slice(0, slash);
    const rel   = fp.slice(slash + 1);
    const r = stmt.get(vpath, rel);
    if (r) { songRows.push(r); }
  }

  return {
    id:          `sh-${row.share_id}`,
    url:         `${sharePrefix}/shared/${row.share_id}`,
    description: row.description || undefined,
    username:    row.username || undefined,
    created:     isoUtc(row.created_at),
    expires:     row.expires ? new Date(row.expires * 1000).toISOString() : undefined,
    entry:       songRows.map(songFromRow),
  };
}

function shareUrlPrefix(req) {
  const host = req.get('host') || `127.0.0.1:${config.program.port}`;
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

export function getShares(req, res) {
  const rows = db.getDB().prepare(`
    SELECT s.id, s.share_id, s.playlist_json, s.user_id, s.expires, s.created_at,
           u.username
    FROM shared_playlists s
    LEFT JOIN users u ON u.id = s.user_id
    ${req.user.admin ? '' : 'WHERE s.user_id = ?'}
    ORDER BY s.created_at DESC
  `).all(...(req.user.admin ? [] : [req.user.id]));

  const prefix = shareUrlPrefix(req);
  sendOk(req, res, {
    shares: { share: rows.map(r => shareRowToPayload({ ...r, description: null }, prefix)) },
  });
}

export function createShare(req, res) {
  const songIds = arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  if (!songIds.length) { return SubErr.MISSING_PARAM(req, res, 'id'); }

  const filepaths = songIds.map(id => filepathForSong(id)).filter(Boolean);
  if (!filepaths.length) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  const shareId = nanoid(10);
  // Subsonic sends `expires` as ms-since-epoch; mStream stores seconds-since-
  // epoch in shared_playlists.expires. Derive JWT options from the same value
  // so the JWT expiry and DB expiry agree.
  const expiresMs = parseInt(req.query.expires, 10);
  const hasExpiry = Number.isFinite(expiresMs) && expiresMs > Date.now();
  const expires = hasExpiry ? Math.floor(expiresMs / 1000) : null;

  // The webapp share-viewer (src/api/shared.js) verifies this JWT on every
  // lookup — an empty string here would throw "jwt must be provided" and
  // break browser access. Match the shape that /api/v1/share produces so
  // both code paths yield interchangeable rows.
  const tokenData = {
    playlistId: shareId,
    shareToken: true,
    username:   req.user.username,
  };
  const jwtOptions = hasExpiry
    ? { expiresIn: Math.max(1, Math.floor((expiresMs - Date.now()) / 1000)) }
    : {};
  const token = jwt.sign(tokenData, config.program.secret, jwtOptions);

  db.getDB().prepare(`
    INSERT INTO shared_playlists (share_id, playlist_json, user_id, expires, token)
    VALUES (?, ?, ?, ?, ?)
  `).run(shareId, JSON.stringify(filepaths), req.user.id, expires, token);

  const row = db.getDB().prepare(`
    SELECT s.*, u.username FROM shared_playlists s
    LEFT JOIN users u ON u.id = s.user_id WHERE s.share_id = ?
  `).get(shareId);
  sendOk(req, res, {
    shares: { share: [shareRowToPayload({ ...row, description: req.query.description || null }, shareUrlPrefix(req))] },
  });
}

export function updateShare(req, res) {
  const idRaw = String(req.query.id || '');
  const m = /^sh-(.+)$/.exec(idRaw);
  const shareId = m ? m[1] : idRaw;
  if (!shareId) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT user_id FROM shared_playlists WHERE share_id = ?').get(shareId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Share'); }
  if (row.user_id !== req.user.id && !req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }

  // Only `expires` is persistable — mStream's schema doesn't store a
  // description column. We accept `description` silently so clients don't
  // error out, but it won't round-trip.
  if ('expires' in req.query) {
    const ms = parseInt(req.query.expires, 10);
    const expires = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
    db.getDB().prepare('UPDATE shared_playlists SET expires = ? WHERE share_id = ?').run(expires, shareId);
  }
  sendOk(req, res);
}

export function deleteShare(req, res) {
  const idRaw = String(req.query.id || '');
  const m = /^sh-(.+)$/.exec(idRaw);
  const shareId = m ? m[1] : idRaw;
  if (!shareId) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT user_id FROM shared_playlists WHERE share_id = ?').get(shareId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Share'); }
  if (row.user_id !== req.user.id && !req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  db.getDB().prepare('DELETE FROM shared_playlists WHERE share_id = ?').run(shareId);
  sendOk(req, res);
}

// ── Phase 3: Bookmarks ────────────────────────────────────────────────────
//
// Keyed on track_hash to survive a rescan (same pattern as user_metadata).

function bookmarkToPayload(row, songRow) {
  return {
    entry:       songRow ? songFromRow(songRow) : undefined,
    position:    row.position_ms,
    username:    row.username || undefined,
    comment:     row.comment || undefined,
    created:     isoUtc(row.created_at),
    changed:     isoUtc(row.changed_at),
  };
}

export function getBookmarks(req, res) {
  const rows = db.getDB().prepare(`
    SELECT b.*, u.username
    FROM user_bookmarks b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.user_id = ?
    ORDER BY b.changed_at DESC
  `).all(req.user.id);

  if (!rows.length) { return sendOk(req, res, { bookmarks: { bookmark: [] } }); }

  const hashes = rows.map(r => r.track_hash);
  const ph = hashes.map(() => '?').join(',');
  const { clause, params } = libraryScope(req);
  const songRows = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE t.file_hash IN (${ph}) AND ${clause}
  `).all(...hashes, ...params);
  const byHash = new Map();
  for (const row of songRows) {
    // Song rows don't expose file_hash in songQueryBase — look it up cheaply.
    const h = db.getDB().prepare('SELECT file_hash FROM tracks WHERE id = ?').get(row.id)?.file_hash;
    if (h) { byHash.set(h, row); }
  }

  sendOk(req, res, {
    bookmarks: {
      bookmark: rows.map(r => bookmarkToPayload(r, byHash.get(r.track_hash))),
    },
  });
}

export function createBookmark(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const position = parseInt(req.query.position, 10);
  if (!Number.isFinite(position) || position < 0) {
    return SubErr.MISSING_PARAM(req, res, 'position');
  }
  const hash = trackFileHash(parsed.id);
  if (!hash) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const comment = req.query.comment ? String(req.query.comment) : null;

  db.getDB().prepare(`
    INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, track_hash) DO UPDATE SET
      position_ms = excluded.position_ms,
      comment     = excluded.comment,
      changed_at  = datetime('now')
  `).run(req.user.id, hash, position, comment);

  sendOk(req, res);
}

export function deleteBookmark(req, res) {
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const hash = trackFileHash(parsed.id);
  if (!hash) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  db.getDB().prepare('DELETE FROM user_bookmarks WHERE user_id = ? AND track_hash = ?')
    .run(req.user.id, hash);
  sendOk(req, res);
}

// ── Phase 3: Play queue ───────────────────────────────────────────────────
//
// One row per user storing their current queue as a JSON array of track
// hashes. Resolves to current track ids at read time so rescans don't break
// pointers.

export function getPlayQueue(req, res) {
  const row = db.getDB().prepare('SELECT * FROM user_play_queue WHERE user_id = ?')
    .get(req.user.id);
  if (!row) { return sendOk(req, res, { playQueue: {} }); }

  const hashes = JSON.parse(row.track_hashes_json || '[]');
  if (!hashes.length) { return sendOk(req, res, { playQueue: {} }); }

  const ph = hashes.map(() => '?').join(',');
  const { clause, params } = libraryScope(req);
  const songRows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, t.genre, t.album_art_file,
           t.created_at, t.library_id, t.file_hash AS _file_hash,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.file_hash IN (${ph}) AND ${clause}
  `).all(...hashes, ...params);

  const byHash = new Map(songRows.map(r => [r._file_hash, r]));
  // Re-order to match the stored sequence, dropping any entries whose tracks
  // were removed since save time.
  const ordered = hashes.map(h => byHash.get(h)).filter(Boolean);

  // Find current (optional) — may have moved to a different id since save.
  let current;
  if (row.current_track_hash && byHash.has(row.current_track_hash)) {
    current = String(byHash.get(row.current_track_hash).id);
  }

  sendOk(req, res, {
    playQueue: {
      current,
      position: row.position_ms || undefined,
      username: req.user.username,
      changed:  isoUtc(row.changed_at),
      changedBy: row.changed_by || undefined,
      entry:    enrichSongsWithUserMeta(req, ordered.map(songFromRow)),
    },
  });
}

export function savePlayQueue(req, res) {
  const songIds = arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  const hashes = songIds.map(trackFileHash).filter(Boolean);
  const currentId = decodeId(req.query.current, 'song')?.id;
  const currentHash = currentId ? trackFileHash(currentId) : null;
  const position = parseInt(req.query.position, 10);
  const posMs = Number.isFinite(position) && position >= 0 ? position : null;
  const changedBy = req.query.c ? String(req.query.c) : null;

  db.getDB().prepare(`
    INSERT INTO user_play_queue
      (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
    VALUES (?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      current_track_hash = excluded.current_track_hash,
      position_ms        = excluded.position_ms,
      changed_at         = datetime('now'),
      changed_by         = excluded.changed_by,
      track_hashes_json  = excluded.track_hashes_json
  `).run(req.user.id, currentHash, posMs, changedBy, JSON.stringify(hashes));

  sendOk(req, res);
}

// ── Phase 3: Tier 3 stubs (explicit decline / empty) ──────────────────────

export function getInternetRadioStations(req, res) {
  sendOk(req, res, { internetRadioStations: { internetRadioStation: [] } });
}
export function getPodcasts(req, res) {
  sendOk(req, res, { podcasts: { channel: [] } });
}
export function getNewestPodcasts(req, res) {
  sendOk(req, res, { newestPodcasts: { episode: [] } });
}
export function getLyrics(req, res) {
  // No lyrics ingestion yet — see docs/subsonic-phase3.md Tier 3.
  sendOk(req, res, { lyrics: { value: '' } });
}
export function getLyricsBySongId(req, res) {
  sendOk(req, res, { lyricsList: { structuredLyrics: [] } });
}
export function jukeboxControl(req, res) {
  // mStream's model is "every client is its own player" — a server-side
  // jukebox doesn't fit. Politely decline.
  return SubErr.GENERIC(req, res, 'Jukebox control is not supported by this server.');
}
