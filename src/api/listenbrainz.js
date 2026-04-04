// ListenBrainz scrobbling integration
// Submits "now playing" and "single listen" events to ListenBrainz API.
// Per-user tokens stored in users.listenbrainz_token DB column.

import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';

const LB_API = 'https://api.listenbrainz.org';

const d = () => db.getDB();

async function lbFetch(path, token, body) {
  const res = await fetch(`${LB_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ListenBrainz ${res.status}: ${text}`);
  }
  return res.json();
}

function getTrackByFilepath(filepath, user) {
  const parts = filepath.split('/');
  const vpathName = parts[0];
  const relPath = parts.slice(1).join('/');
  const lib = db.getLibraryByName(vpathName);
  if (!lib) return null;

  return d().prepare(`
    SELECT t.title, a.name AS artist, al.name AS album, t.file_hash,
           t.track_number, t.duration, a.mbz_artist_id, al.mbz_album_id
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.filepath = ? AND t.library_id = ?
  `).get(relPath, lib.id);
}

function buildListenPayload(track, listenType, listenedAt) {
  const payload = {
    listen_type: listenType,
    payload: [{
      track_metadata: {
        artist_name: track.artist || 'Unknown Artist',
        track_name: track.title || 'Unknown Track',
        release_name: track.album || undefined,
        additional_info: {}
      }
    }]
  };

  if (listenedAt) {
    payload.payload[0].listened_at = listenedAt;
  }

  // Add MusicBrainz IDs if available
  const info = payload.payload[0].track_metadata.additional_info;
  if (track.mbz_artist_id) {
    info.artist_mbids = [track.mbz_artist_id];
  }
  if (track.mbz_album_id) {
    info.release_mbid = track.mbz_album_id;
  }
  if (track.track_number) {
    info.tracknumber = track.track_number;
  }
  if (track.duration) {
    info.duration_ms = Math.round(track.duration * 1000);
  }

  return payload;
}

export function setup(mstream) {

  // ── Status ─────────────────────────────────────────────────
  mstream.get('/api/v1/listenbrainz/status', (req, res) => {
    if (!req.user?.id) return res.json({ serverEnabled: true, linked: false });
    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    res.json({
      serverEnabled: true,
      linked: !!(user?.listenbrainz_token)
    });
  });

  // ── Connect (save token) ───────────────────────────────────
  mstream.post('/api/v1/listenbrainz/connect', async (req, res) => {
    const token = req.body.lbToken;
    if (!token || !req.user?.id) {
      return res.status(400).json({ error: 'Token required' });
    }

    // Validate token by calling LB API
    try {
      const r = await fetch(`${LB_API}/1/validate-token`, {
        headers: { 'Authorization': `Token ${token}` }
      });
      const data = await r.json();
      if (!data.valid) {
        return res.status(400).json({ error: 'Invalid token' });
      }
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach ListenBrainz API' });
    }

    d().prepare('UPDATE users SET listenbrainz_token = ? WHERE id = ?').run(token, req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // ── Disconnect (remove token) ──────────────────────────────
  mstream.post('/api/v1/listenbrainz/disconnect', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });
    d().prepare('UPDATE users SET listenbrainz_token = NULL WHERE id = ?').run(req.user.id);
    db.invalidateCache();
    res.json({ ok: true });
  });

  // ── Now Playing ────────────────────────────────────────────
  mstream.post('/api/v1/listenbrainz/playing-now', async (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });

    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    if (!user?.listenbrainz_token) return res.json({ ok: true });

    const track = getTrackByFilepath(req.body.filePath, req.user);
    if (!track) return res.json({ ok: true });

    try {
      await lbFetch('/1/submit-listens', user.listenbrainz_token,
        buildListenPayload(track, 'playing_now'));
    } catch (e) {
      // Don't fail the request if LB is down
    }
    res.json({ ok: true });
  });

  // ── Scrobble ───────────────────────────────────────────────
  mstream.post('/api/v1/listenbrainz/scrobble-by-filepath', async (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });

    const user = d().prepare('SELECT listenbrainz_token FROM users WHERE id = ?').get(req.user.id);
    if (!user?.listenbrainz_token) return res.json({ ok: true });

    const track = getTrackByFilepath(req.body.filePath, req.user);
    if (!track) return res.json({ ok: true });

    try {
      await lbFetch('/1/submit-listens', user.listenbrainz_token,
        buildListenPayload(track, 'single', Math.floor(Date.now() / 1000)));
    } catch (e) {
      // Don't fail the request if LB is down
    }
    res.json({ ok: true });
  });
}
