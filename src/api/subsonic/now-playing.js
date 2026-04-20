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
 *
 * Race-handling: a user can have multiple overlapping streams (two tabs,
 * phone + desktop, quick skip-next). `register` overwrites the map entry
 * and returns an opaque handle; `unregister(handle)` only deletes if the
 * current entry is still the one the caller registered — so a slow close
 * from an old stream can't wipe the entry of a newer one.
 *
 * Entries that haven't been touched in DEFAULT_MAX_AGE_MS (30 min) are
 * filtered out of `snapshot()` so a client that never cleanly closed its
 * socket doesn't show up forever.
 */

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

// Map<userId, { username, trackId, since, token }>
//   token is a monotonically-increasing counter per registration, used to
//   tell whether an unregister() call refers to the current entry or an
//   already-superseded one.
const players = new Map();
let nextToken = 1;

/**
 * Record that `userId` is now playing `trackId`. Returns an opaque handle
 * that must be passed to `unregister` to clear this specific registration.
 * @returns {{userId: number, token: number}}
 */
export function register(userId, username, trackId) {
  if (!Number.isFinite(userId) || !Number.isFinite(trackId)) { return null; }
  const token = nextToken++;
  players.set(userId, { username, trackId, since: Date.now(), token });
  return { userId, token };
}

/**
 * Clear a registration. If the current entry's token doesn't match the one
 * in the handle, the entry was replaced by a newer stream — leave it alone.
 */
export function unregister(handle) {
  if (!handle) { return; }
  const current = players.get(handle.userId);
  if (!current) { return; }
  if (current.token !== handle.token) { return; }  // superseded — no-op
  players.delete(handle.userId);
}

/**
 * Return a copy of the active-players list, filtered by age. Entries that
 * haven't been refreshed within `maxAgeMs` are considered stale and hidden
 * from the result (but remain in the map — callers that want to see them
 * can raise the threshold).
 */
export function snapshot(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  return [...players.entries()]
    .filter(([, v]) => v.since >= cutoff)
    .map(([userId, v]) => ({
      userId,
      username: v.username,
      trackId:  v.trackId,
      since:    v.since,
    }));
}

// Exposed for test cleanup.
export function _clear() { players.clear(); nextToken = 1; }
