// Velvet UI API endpoints
// Real implementations where the data exists in our SQLite DB,
// stubs for features that aren't implemented yet.

import * as db from '../db/manager.js';
import { renderMetadataObj, libraryFilter, trackQuery } from './db.js';

const d = () => db.getDB();

export function setup(mstream) {

  // ══════════════════════════════════════════════════════════════
  // REAL IMPLEMENTATIONS — backed by our SQLite DB
  // ══════════════════════════════════════════════════════════════

  // ── Decade browsing ──────────────────────────────────────────
  mstream.get('/api/v1/db/decades', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT
        CAST(t.year / 10 * 10 AS INTEGER) AS decade,
        COUNT(*) AS cnt,
        COUNT(DISTINCT t.album_id) AS albums
      FROM tracks t
      WHERE t.year IS NOT NULL AND t.year > 0 AND ${f.clause}
      GROUP BY decade
      ORDER BY decade DESC
    `).all(...f.params);
    res.json({ decades: rows });
  });

  mstream.post('/api/v1/db/decade/albums', (req, res) => {
    const decade = parseInt(req.body.decade);
    if (isNaN(decade)) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE t.year >= ? AND t.year < ? AND ${f.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(decade, decade + 10, ...f.params);
    res.json({ albums: rows });
  });

  mstream.post('/api/v1/db/decade/songs', (req, res) => {
    const decade = parseInt(req.body.decade);
    if (isNaN(decade)) return res.json([]);
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE t.year >= ? AND t.year < ? AND ${f.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number
    `).all(...(req.user?.id ? [req.user.id] : []), decade, decade + 10, ...f.params);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Genre groups ─────────────────────────────────────────────
  mstream.get('/api/v1/db/genre-groups', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT g.name AS genre, COUNT(DISTINCT tg.track_id) AS count
      FROM genres g
      JOIN track_genres tg ON tg.genre_id = g.id
      JOIN tracks t ON t.id = tg.track_id
      WHERE ${f.clause}
      GROUP BY g.id
      ORDER BY g.name COLLATE NOCASE
    `).all(...f.params);
    res.json({ genres: rows, groups: null });
  });

  mstream.post('/api/v1/db/genre/albums', (req, res) => {
    const genre = req.body.genre;
    if (!genre) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE g.name = ? AND ${f.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(genre, ...f.params);
    res.json({ albums: rows });
  });

  mstream.post('/api/v1/db/genre/songs', (req, res) => {
    const genre = req.body.genre;
    if (!genre) return res.json([]);
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      WHERE g.name = ? AND ${f.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.track_number
    `).all(...(req.user?.id ? [req.user.id] : []), genre, ...f.params);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Album library browse ─────────────────────────────────────
  mstream.get('/api/v1/albums/browse', (req, res) => {
    const f = libraryFilter(req.user);
    const rows = d().prepare(`
      SELECT al.id, al.name, a.name AS artist, al.year, al.album_art_file,
             COUNT(t.id) AS track_count
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE ${f.clause}
      GROUP BY al.id
      ORDER BY al.name COLLATE NOCASE
    `).all(...f.params);
    // Velvet expects displayName (from its Albums Only folder mode)
    const albums = rows.map(r => ({
      ...r,
      displayName: r.name + (r.artist ? ` — ${r.artist}` : ''),
    }));
    res.json({ albums, series: [] });
  });

  // ── Multi-artist album query ─────────────────────────────────
  mstream.post('/api/v1/db/artists-albums-multi', (req, res) => {
    const artists = req.body.artists;
    if (!Array.isArray(artists) || !artists.length) return res.json({ albums: [] });
    const f = libraryFilter(req.user);
    const placeholders = artists.map(() => '?').join(',');
    const rows = d().prepare(`
      SELECT DISTINCT al.name, a.name AS artist, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN artists a ON al.artist_id = a.id
      WHERE a.name COLLATE NOCASE IN (${placeholders}) AND ${f.clause}
      ORDER BY al.year DESC, al.name COLLATE NOCASE
    `).all(...artists, ...f.params);
    res.json({ albums: rows });
  });

  // ── Songs by artists (Auto-DJ) ──────────────────────────────
  mstream.post('/api/v1/db/songs-by-artists', (req, res) => {
    const artists = req.body.artists;
    const limit = Math.min(parseInt(req.body.limit) || 50, 200);
    if (!Array.isArray(artists) || !artists.length) return res.json([]);
    const f = libraryFilter(req.user);
    const placeholders = artists.map(() => '?').join(',');
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE a.name COLLATE NOCASE IN (${placeholders}) AND ${f.clause}
      ORDER BY RANDOM()
      LIMIT ?
    `).all(...(req.user?.id ? [req.user.id] : []), ...artists, ...f.params, limit);
    res.json(rows.map(renderMetadataObj));
  });

  // ── Play logging ─────────────────────────────────────────────
  mstream.post('/api/v1/db/stats/log-play', (req, res) => {
    const filePath = req.body.filePath;
    if (!filePath || !req.user?.id) return res.json({ ok: true });

    // Parse vpath/filepath from the full path
    const parts = filePath.split('/');
    const vpathName = parts[0];
    const relPath = parts.slice(1).join('/');
    const lib = db.getLibraryByName(vpathName);
    if (!lib) return res.json({ ok: true });

    const track = d().prepare(
      'SELECT file_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(relPath, lib.id);
    if (!track) return res.json({ ok: true });

    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, play_count, last_played)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, track_hash) DO UPDATE SET
        play_count = play_count + 1,
        last_played = datetime('now')
    `).run(req.user.id, track.file_hash);

    res.json({ ok: true });
  });

  mstream.post('/api/v1/db/stats/reset-play-counts', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE user_metadata SET play_count = 0 WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  mstream.post('/api/v1/db/stats/reset-recently-played', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE user_metadata SET last_played = NULL WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  // ── File art (by filepath) ──────────────────────────────────
  mstream.get('/api/v1/files/art', (req, res) => {
    const fp = req.query.fp;
    if (!fp) return res.status(404).json({ error: 'missing filepath' });

    const parts = fp.split('/');
    const vpathName = parts[0];
    const relPath = parts.slice(1).join('/');
    const lib = db.getLibraryByName(vpathName);
    if (!lib) return res.status(404).json({ error: 'not found' });

    const row = d().prepare(`
      SELECT t.album_art_file, al.album_art_file AS album_album_art_file
      FROM tracks t
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.filepath = ? AND t.library_id = ?
    `).get(relPath, lib.id);

    const artFile = row?.album_art_file || row?.album_album_art_file;
    if (!artFile) return res.status(404).json({ error: 'no art' });
    res.json({ file: artFile });
  });

  // ── Share list and delete ────────────────────────────────────
  mstream.get('/api/v1/share/list', (req, res) => {
    if (!req.user?.id) return res.json([]);
    const rows = d().prepare(
      'SELECT share_id, playlist_json, expires, created_at FROM shared_playlists WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
    res.json(rows.map(r => {
      let songCount = 0;
      try { songCount = JSON.parse(r.playlist_json).length; } catch (_) {}
      return {
        playlistId: r.share_id,
        songCount,
        expires: r.expires || null,
        createdAt: r.created_at
      };
    }));
  });

  mstream.delete('/api/v1/share/:id', (req, res) => {
    if (!req.user?.id) return res.status(403).json({ error: 'unauthorized' });
    d().prepare('DELETE FROM shared_playlists WHERE share_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ── Admin directories (for checking admin status) ────────────
  mstream.get('/api/v1/admin/directories', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'not admin' });
    const libs = db.getAllLibraries();
    res.json(libs.map(l => ({ name: l.name, root: l.root_path, type: l.type })));
  });

  // ── Scan progress ────────────────────────────────────────────
  mstream.get('/api/v1/admin/db/scan/progress', (req, res) => {
    // TODO: wire to actual task-queue status
    res.json({ scanning: false });
  });

  // ══════════════════════════════════════════════════════════════
  // STUBS — features not yet implemented, return safe defaults
  // ══════════════════════════════════════════════════════════════

  // User settings (save/load preferences)
  mstream.get('/api/v1/user/settings', (req, res) => res.json({ prefs: {} }));
  mstream.post('/api/v1/user/settings', (req, res) => res.json({ ok: true }));

  // Wrapped / stats tracking
  mstream.post('/api/v1/wrapped/play-start', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/play-stop', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/play-end', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/play-skip', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/pause', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/radio-start', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/radio-stop', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/podcast-start', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/wrapped/podcast-end', (req, res) => res.json({ ok: true }));
  mstream.get('/api/v1/user/wrapped', (req, res) => res.json({ stats: {} }));
  mstream.get('/api/v1/user/wrapped/periods', (req, res) => res.json([]));

  // Radio
  mstream.get('/api/v1/radio/stations', (req, res) => res.json([]));
  mstream.get('/api/v1/radio/enabled', (req, res) => res.json({ enabled: false }));
  mstream.get('/api/v1/radio/schedules', (req, res) => res.json([]));

  // Podcasts
  mstream.get('/api/v1/podcast/feeds', (req, res) => res.json([]));

  // Smart playlists
  mstream.get('/api/v1/smart-playlists', (req, res) => res.json({ playlists: [] }));
  mstream.post('/api/v1/smart-playlists/run', (req, res) => res.json([]));
  mstream.post('/api/v1/smart-playlists/count', (req, res) => res.json({ count: 0 }));

  // Waveform
  mstream.get('/api/v1/db/waveform', (req, res) => res.status(404).json({ error: 'not available' }));

  // ListenBrainz
  mstream.get('/api/v1/listenbrainz/status', (req, res) => res.json({ serverEnabled: false, linked: false }));
  mstream.post('/api/v1/listenbrainz/playing-now', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/listenbrainz/scrobble-by-filepath', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/listenbrainz/connect', (req, res) => res.status(501).json({ error: 'Not implemented' }));
  mstream.post('/api/v1/listenbrainz/disconnect', (req, res) => res.json({ ok: true }));

  // Last.fm status (extends existing scrobbler)
  mstream.get('/api/v1/lastfm/status', (req, res) => res.json({ serverEnabled: false, hasApiKey: false }));
  mstream.get('/api/v1/lastfm/similar-artists', (req, res) => res.json({ artists: [] }));
  mstream.post('/api/v1/lastfm/connect', (req, res) => res.status(501).json({ error: 'Not implemented' }));
  mstream.post('/api/v1/lastfm/disconnect', (req, res) => res.json({ ok: true }));

  // Discogs
  mstream.get('/api/v1/admin/discogs/config', (req, res) => res.json({ enabled: false }));
  mstream.get('/api/v1/deezer/search', (req, res) => res.json({ data: [] }));
  mstream.get('/api/v1/discogs/coverart', (req, res) => res.json({}));

  // Subsonic password
  mstream.post('/api/v1/admin/users/subsonic-password', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // ID3 tag writing
  mstream.post('/api/v1/admin/tags/write', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // File delete (recordings)
  mstream.delete('/api/v1/files/recording', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // Playlist rename
  mstream.post('/api/v1/playlist/rename', (req, res) => res.status(501).json({ error: 'Not implemented' }));
}
