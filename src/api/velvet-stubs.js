// Stub API endpoints for the Velvet UI
// These return safe empty/default responses for features not yet implemented
// in the core mStream backend. This prevents the Velvet UI from erroring
// when it calls endpoints that don't exist.

export function setup(mstream) {
  // User settings (save/load preferences)
  mstream.get('/api/v1/user/settings', (req, res) => {
    res.json({ prefs: {} });
  });
  mstream.post('/api/v1/user/settings', (req, res) => {
    res.json({ ok: true });
  });

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

  // Album library browse (different from our /db/albums)
  mstream.get('/api/v1/albums/browse', (req, res) => res.json([]));

  // Genre groups and decade browsing
  mstream.get('/api/v1/db/genre-groups', (req, res) => res.json([]));
  mstream.get('/api/v1/db/decades', (req, res) => res.json([]));
  mstream.post('/api/v1/db/genre/albums', (req, res) => res.json([]));
  mstream.post('/api/v1/db/genre/songs', (req, res) => res.json([]));
  mstream.post('/api/v1/db/decade/albums', (req, res) => res.json([]));
  mstream.post('/api/v1/db/decade/songs', (req, res) => res.json([]));

  // Multi-artist album query
  mstream.post('/api/v1/db/artists-albums-multi', (req, res) => res.json([]));

  // Songs by artists (used by Auto-DJ)
  mstream.post('/api/v1/db/songs-by-artists', (req, res) => res.json([]));

  // Play logging
  mstream.post('/api/v1/db/stats/log-play', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/db/stats/reset-play-counts', (req, res) => res.json({ ok: true }));
  mstream.post('/api/v1/db/stats/reset-recently-played', (req, res) => res.json({ ok: true }));

  // File art (different endpoint than our album-art)
  mstream.get('/api/v1/files/art', (req, res) => res.status(404).json({ error: 'not found' }));

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

  // Scan progress
  mstream.get('/api/v1/admin/db/scan/progress', (req, res) => res.json({ scanning: false }));

  // Admin directories (for checking admin status)
  mstream.get('/api/v1/admin/directories', (req, res) => res.json([]));

  // Subsonic password
  mstream.post('/api/v1/admin/users/subsonic-password', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // ID3 tag writing
  mstream.post('/api/v1/admin/tags/write', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // Share list and delete
  mstream.get('/api/v1/share/list', (req, res) => res.json([]));
  mstream.delete('/api/v1/share/:id', (req, res) => res.json({ ok: true }));

  // File delete (recordings)
  mstream.delete('/api/v1/files/recording', (req, res) => res.status(501).json({ error: 'Not implemented' }));

  // Playlist rename
  mstream.post('/api/v1/playlist/rename', (req, res) => res.status(501).json({ error: 'Not implemented' }));
}
