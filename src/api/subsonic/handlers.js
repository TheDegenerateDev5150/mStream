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
import * as db from '../../db/manager.js';
import * as config from '../../state/config.js';
import { ffmpegBin } from '../../util/ffmpeg-bootstrap.js';
import { serveAlbumArtFile } from '../album-art.js';
import { sendOk, SubErr } from './response.js';

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

  sendOk(req, res, {
    artist: {
      id: encArtist(artist.id),
      name: artist.name,
      albumCount: albums.length,
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
  res.sendFile(track.absPath, { dotfiles: 'allow' });
}

function streamTranscoded(req, res, track, codec, bitrateK) {
  const spec = TRANSCODE_CODECS[codec];
  const args = [
    '-nostdin', '-i', track.absPath,
    '-vn', ...spec.args, '-b:a', `${bitrateK}k`,
    '-f', spec.format, '-loglevel', 'error',
    '-',
  ];
  let ff;
  try { ff = spawn(ffmpegBin(), args); }
  catch (err) {
    winston.error('[subsonic] stream: ffmpeg spawn failed', { stack: err });
    return res.status(500).end();
  }
  res.status(200).set({
    'Content-Type': spec.mime,
    'transferMode.dlna.org': 'Streaming',
    'Connection': 'close',
  });
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

  const requestedFormat = (req.query.format || '').toLowerCase();
  const maxBitRate = parseInt(req.query.maxBitRate, 10);
  const nativeFormat = (track.row.format || '').toLowerCase();
  const nativeBitRateK = track.row.bitrate ? Math.round(track.row.bitrate / 1000) : null;

  // No transcoding requested, or requested native format at native bitrate.
  const wantsNative =
    !requestedFormat || requestedFormat === 'raw' || requestedFormat === nativeFormat;
  const bitrateOk = !Number.isFinite(maxBitRate) || !nativeBitRateK || nativeBitRateK <= maxBitRate;
  if (wantsNative && bitrateOk) {
    return streamNative(req, res, track);
  }

  // Pick a codec. Prefer the requested one if supported; otherwise fall back
  // to the server default.
  const codec = TRANSCODE_CODECS[requestedFormat]
    ? requestedFormat
    : config.program.transcode.defaultCodec;
  const bitrateK = Number.isFinite(maxBitRate) ? maxBitRate : parseInt(config.program.transcode.defaultBitrate, 10);
  streamTranscoded(req, res, track, codec, bitrateK);
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
  if (!submission) { return sendOk(req, res); }

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

// ── Star / unstar / setRating / getStarred2 ────────────────────────────────

// `star`/`unstar` accept `id` (songs), `albumId`, and `artistId` params, each
// repeatable. Phase 2 tracks star state only for songs; albums/artists are
// accepted silently so clients don't error out, and we record the star by
// flagging *any one* track under that album/artist so the UI reflects a
// star. Proper per-album/artist star tables are a future improvement.

function markStarred(req, trackIds, nowIso) {
  for (const id of trackIds) {
    const hash = trackFileHash(id);
    if (hash) { upsertUserMeta(req.user.id, hash, { starred_at: nowIso }); }
  }
}

function tracksUnderAlbum(albumIds) {
  if (!albumIds.length) { return []; }
  const ph = albumIds.map(() => '?').join(',');
  return db.getDB().prepare(`SELECT id FROM tracks WHERE album_id IN (${ph})`)
    .all(...albumIds).map(r => r.id);
}
function tracksUnderArtist(artistIds) {
  if (!artistIds.length) { return []; }
  const ph = artistIds.map(() => '?').join(',');
  return db.getDB().prepare(`SELECT id FROM tracks WHERE artist_id IN (${ph})`)
    .all(...artistIds).map(r => r.id);
}

function collectStarTargets(req) {
  const songIds = arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  const albumIds = arrayParam(req.query.albumId).map(v => decodeId(v, 'album')?.id).filter(Number.isFinite);
  const artistIds = arrayParam(req.query.artistId).map(v => decodeId(v, 'artist')?.id).filter(Number.isFinite);
  return [...songIds, ...tracksUnderAlbum(albumIds), ...tracksUnderArtist(artistIds)];
}

export function star(req, res) {
  const targets = collectStarTargets(req);
  if (!targets.length) { return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId'); }
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  markStarred(req, targets, nowIso);
  sendOk(req, res);
}

export function unstar(req, res) {
  const targets = collectStarTargets(req);
  if (!targets.length) { return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId'); }
  for (const id of targets) {
    const hash = trackFileHash(id);
    if (hash) { upsertUserMeta(req.user.id, hash, { starred_at: null }); }
  }
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

export function getStarred2(req, res) {
  const { clause, params } = libraryScope(req);
  const rows = db.getDB().prepare(`
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
  const songs = enrichSongsWithUserMeta(req, rows.map(songFromRow));
  sendOk(req, res, {
    starred2: {
      // Phase 2 only stars songs; artist/album arrays are empty but present
      // so clients that look for them don't choke.
      artist: [],
      album:  [],
      song:   songs,
    },
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

  // Base select + join schema used by every type.
  const base = `
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           MIN(t.genre) AS genre, MIN(t.created_at) AS created_at,
           MAX(um.starred_at) AS starred_at,
           MAX(um.rating) AS rating_max,
           SUM(COALESCE(um.play_count, 0)) AS plays,
           MAX(um.last_played) AS last_played
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    LEFT JOIN user_metadata um ON um.track_hash = t.file_hash AND um.user_id = ?
    WHERE ${clause}
  `;
  const tailParams = [req.user.id, ...libParams];

  let where   = '';           // row-level filter (WHERE clause tail)
  let having  = 'songCount > 0'; // group-level filter (HAVING clause)
  let order   = 'al.name COLLATE NOCASE';

  switch (type) {
    case 'newest':    order = 'MIN(t.created_at) DESC'; break;
    case 'recent':    having += ' AND MAX(um.last_played) IS NOT NULL'; order = 'MAX(um.last_played) DESC'; break;
    case 'frequent':  having += ' AND plays > 0';                        order = 'plays DESC'; break;
    case 'highest':   having += ' AND rating_max IS NOT NULL';           order = 'rating_max DESC'; break;
    case 'starred':   having += ' AND starred_at IS NOT NULL';           order = 'starred_at DESC'; break;
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
