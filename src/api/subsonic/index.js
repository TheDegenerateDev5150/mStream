/**
 * Subsonic REST API — Phase 1.
 *
 * Mounts `/rest/<method>` routes on the main Express app with Subsonic-style
 * authentication (see `./auth.js`) and envelope responses (see `./response.js`).
 *
 * All routes sit *before* the main mStream auth wall — they do their own
 * auth via Subsonic credentials and populate `req.user` on success. Routes
 * that fall through to query-string username + plaintext password, or to an
 * API key, never see mStream's JWT cookie.
 *
 * Clients dispatch by method name, either as the path (`/rest/ping`) or with
 * Subsonic's historical `.view` suffix (`/rest/ping.view`). Both are accepted.
 */

import { subsonicAuth } from './auth.js';
import { SubErr } from './response.js';
import * as H from './handlers.js';

// Map Subsonic method names to handler functions. Keep this flat — adding a
// new endpoint is a one-line change.
const METHODS = {
  // System
  ping:              H.ping,
  getLicense:        H.getLicense,
  getMusicFolders:   H.getMusicFolders,

  // Browsing
  getIndexes:        H.getIndexes,
  getMusicDirectory: H.getMusicDirectory,
  getArtists:        H.getArtists,
  getArtist:         H.getArtist,
  getAlbum:          H.getAlbum,
  getSong:           H.getSong,
  getGenres:         H.getGenres,

  // Media
  getCoverArt:       H.getCoverArt,
  stream:            H.stream,
  download:          H.download,

  // Search
  search:            H.search,
  search2:           H.search2,
  search3:           H.search3,

  // Phase 2 — scrobble / favourites
  scrobble:          H.scrobble,
  star:              H.star,
  unstar:            H.unstar,
  setRating:         H.setRating,
  getStarred2:       H.getStarred2,

  // Phase 2 — album/song lists
  getAlbumList:      H.getAlbumList,
  getAlbumList2:     H.getAlbumList2,
  getRandomSongs:    H.getRandomSongs,
  getSongsByGenre:   H.getSongsByGenre,

  // Phase 2 — playlists
  getPlaylists:      H.getPlaylists,
  getPlaylist:       H.getPlaylist,
  createPlaylist:    H.createPlaylist,
  updatePlaylist:    H.updatePlaylist,
  deletePlaylist:    H.deletePlaylist,
};

export function setup(mstream) {
  // Single handler for both `/rest/:method` and `/rest/:method.view`. We
  // normalise the method name (stripping any ".view"), look it up in the
  // METHODS table, authenticate, and dispatch.
  const handle = async (req, res) => {
    const raw = String(req.params.method || '').replace(/\.view$/i, '');
    const fn = METHODS[raw];
    if (!fn) { return SubErr.GENERIC(req, res, `Unknown Subsonic method: ${raw}`); }
    try {
      await subsonicAuth(req, res, () => fn(req, res));
    } catch (err) {
      // Authoritative error path — should be rare; subsonicAuth handles its
      // own failures. If a handler throws synchronously we surface it here.
      req.app?.get?.('logger')?.error?.('[subsonic] unhandled', { stack: err });
      if (!res.headersSent) { SubErr.GENERIC(req, res, 'Internal server error.'); }
    }
  };

  // Subsonic supports both GET and POST on every endpoint; clients pick
  // based on whether they're sending a large `songId` list etc.
  mstream.get( '/rest/:method', handle);
  mstream.post('/rest/:method', handle);
}
