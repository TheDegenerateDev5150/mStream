/**
 * Tiny in-memory registry of who's streaming what, for Subsonic's
 * `getNowPlaying` endpoint.
 *
 * mStream has no central streaming coordinator — every `stream` request is
 * independent. This module lets the `stream` handler register the start of a
 * playback and unregister when the socket closes. `getNowPlaying` reads the
 * current map and joins against the tracks table at response time.
 *
 * Process-local only. In a multi-instance deployment each instance would
 * report its own users; that's acceptable for v1 since "now playing" is
 * inherently best-effort information.
 */

// Map<userId, { username, trackId, since }>
const players = new Map();

export function register(userId, username, trackId) {
  if (!Number.isFinite(userId) || !Number.isFinite(trackId)) { return; }
  players.set(userId, { username, trackId, since: Date.now() });
}

export function unregister(userId) {
  players.delete(userId);
}

export function snapshot() {
  // Return a plain array so callers can iterate without touching the Map.
  return [...players.entries()].map(([userId, v]) => ({
    userId,
    username: v.username,
    trackId:  v.trackId,
    since:    v.since,
  }));
}

// Exposed for test cleanup.
export function _clear() { players.clear(); }
