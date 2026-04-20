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
      song:      songs.map(songFromRow),
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
  sendOk(req, res, { song: songFromRow(row) });
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
        child:  songs.map(songFromRow),
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
      song: songs.map(songFromRow),
    },
  });
}

// Legacy search + search2 are thin wrappers around search3 for old clients.
export function search(req, res)  { search3(req, res); }
export function search2(req, res) { search3(req, res); }
