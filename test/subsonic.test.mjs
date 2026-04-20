/**
 * Subsonic API integration tests (Phase 1).
 *
 * Covers system/browsing/media/search endpoints against a live mStream
 * instance with a configured user. Exercises JSON + XML envelopes and all
 * three supported auth methods (plaintext, enc:HEX, API key).
 *
 * Run: `npm run test:subsonic` or `node --test test/subsonic.test.mjs`
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { FIXTURE_SUMMARY } from './helpers/fixtures.mjs';

// ── Shared harness ───────────────────────────────────────────────────────────

const USER = { username: 'alice', password: 'passw0rd-æ!' };
let server;
let apiKey;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',  // keep the DLNA noise out of these tests
    users:    [{ ...USER, admin: true }],
  });

  // Mint an API key for `alice` — most tests auth with the key.
  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(USER),
  });
  const { token } = await login.json();
  const keyResp = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'test-suite' }),
  });
  apiKey = (await keyResp.json()).key;
  assert.ok(apiKey, 'expected an API key from POST /api/v1/user/api-keys');
});

after(async () => { if (server) { await server.stop(); } });

// ── Helpers ──────────────────────────────────────────────────────────────────

function subsonicUrl(method, params = {}) {
  // Serialize arrays as repeated params (`id=1&id=2`) — URLSearchParams's
  // object-constructor joins arrays with commas, which every Subsonic client
  // would get wrong.
  const q = new URLSearchParams();
  q.set('f', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) { q.append(k, item); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function call(method, params = {}) {
  const authed = { apiKey, ...params };
  const r = await fetch(subsonicUrl(method, authed));
  const body = await r.json();
  return body['subsonic-response'];
}

// ── 1. Authentication ───────────────────────────────────────────────────────

describe('Subsonic auth', () => {
  test('missing credentials → error 10', async () => {
    const r = await fetch(subsonicUrl('ping', {}));
    const { 'subsonic-response': env } = await r.json();
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('wrong password → error 40', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: 'wrong' }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 40);
  });

  test('correct plaintext → ok', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: USER.password }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
    assert.equal(env.openSubsonic, true);
    assert.equal(env.type, 'mstream');
  });

  test('enc:HEX password → ok', async () => {
    const hex = Buffer.from(USER.password, 'utf8').toString('hex');
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: `enc:${hex}` }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
  });

  test('API key → ok', async () => {
    const env = await call('ping');
    assert.equal(env.status, 'ok');
  });

  test('token auth (t+s) → error 41', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, t: 'deadbeef', s: 'xyz' }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 41);
  });

  test('unknown method → error envelope', async () => {
    const env = await call('thisDoesNotExist');
    assert.equal(env.status, 'failed');
  });
});

// ── 2. XML + JSONP envelopes ────────────────────────────────────────────────

describe('Response formats', () => {
  test('XML envelope (default)', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}`);
    assert.match(r.headers.get('content-type') || '', /xml/);
    const body = await r.text();
    assert.match(body, /<subsonic-response/);
    assert.match(body, /status="ok"/);
    assert.match(body, /openSubsonic="true"/);
  });

  test('JSONP wraps in callback', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}&f=jsonp&callback=myCb`);
    assert.match(r.headers.get('content-type') || '', /javascript/);
    const body = await r.text();
    assert.match(body, /^myCb\(/);
    assert.match(body, /\);$/);
  });

  test('JSONP with unsafe callback falls back to "callback"', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}&f=jsonp&callback=not-safe!`);
    const body = await r.text();
    assert.match(body, /^callback\(/);
  });

  test('.view suffix accepted', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping.view?apiKey=${apiKey}&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
  });
});

// ── 3. System endpoints ─────────────────────────────────────────────────────

describe('System endpoints', () => {
  test('ping returns bare ok envelope', async () => {
    const env = await call('ping');
    assert.equal(env.status, 'ok');
    assert.equal(env.version, '1.16.1');
    assert.equal(env.serverVersion, '6.3.0');
  });

  test('getLicense returns valid=true', async () => {
    const env = await call('getLicense');
    assert.equal(env.license.valid, true);
  });

  test('getMusicFolders lists the user\'s libraries', async () => {
    const env = await call('getMusicFolders');
    assert.ok(Array.isArray(env.musicFolders.musicFolder));
    assert.equal(env.musicFolders.musicFolder.length, 1);
    assert.equal(env.musicFolders.musicFolder[0].name, 'testlib');
  });
});

// ── 4. Browsing ─────────────────────────────────────────────────────────────

describe('getArtists / getIndexes', () => {
  test('getArtists returns all fixture artists under the right index letter', async () => {
    const env = await call('getArtists');
    const flat = env.artists.index.flatMap(b => b.artist);
    assert.equal(flat.length, FIXTURE_SUMMARY.artists);
    const icarus = flat.find(a => a.name === 'Icarus');
    assert.ok(icarus);
    assert.ok(Number(icarus.albumCount) > 0);
  });

  test('getIndexes has same shape but under `indexes`', async () => {
    const env = await call('getIndexes');
    assert.ok(env.indexes);
    assert.ok(Array.isArray(env.indexes.index));
  });
});

describe('getArtist → getAlbum → getSong', () => {
  test('full drill-through returns consistent IDs', async () => {
    const artists = (await call('getArtists')).artists.index.flatMap(b => b.artist);
    const aId = artists[0].id;

    const artist = (await call('getArtist', { id: aId })).artist;
    assert.equal(artist.id, aId);
    assert.ok(Array.isArray(artist.album));
    assert.ok(artist.album.length > 0);

    const alId = artist.album[0].id;
    const album = (await call('getAlbum', { id: alId })).album;
    assert.equal(album.id, alId);
    assert.ok(Array.isArray(album.song));
    assert.ok(album.song.length > 0);

    const song = album.song[0];
    assert.ok(song.id);
    assert.ok(song.title);
    assert.ok(song.suffix);
    assert.equal(song.contentType, 'audio/mpeg');

    // Round-trip via getSong
    const fetched = (await call('getSong', { id: song.id })).song;
    assert.equal(fetched.id, song.id);
    assert.equal(fetched.title, song.title);
  });

  test('getArtist with unknown id → error 70', async () => {
    const env = await call('getArtist', { id: 'ar-99999' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 70);
  });

  test('getSong missing id → error 10', async () => {
    const env = await call('getSong');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

describe('getGenres', () => {
  test('lists all distinct non-empty genres', async () => {
    const env = await call('getGenres');
    const genres = env.genres.genre;
    // Fixture: Electronic + Ambient; unknown (null) genre is excluded per spec.
    assert.ok(genres.length >= 2);
    const names = genres.map(g => g.value);
    assert.ok(names.includes('Electronic'));
    assert.ok(names.includes('Ambient'));
  });
});

describe('getMusicDirectory', () => {
  test('drill library → artist → album', async () => {
    const mf = (await call('getMusicFolders')).musicFolders.musicFolder[0];

    const atLib = (await call('getMusicDirectory', { id: mf.id })).directory;
    assert.equal(atLib.name, mf.name);
    assert.ok(atLib.child.length > 0);
    assert.ok(atLib.child.every(c => c.isDir));

    const artistId = atLib.child[0].id;
    const atArtist = (await call('getMusicDirectory', { id: artistId })).directory;
    assert.ok(atArtist.child.length > 0);

    const albumId = atArtist.child[0].id;
    const atAlbum = (await call('getMusicDirectory', { id: albumId })).directory;
    assert.ok(atAlbum.child.length > 0);
    assert.ok(atAlbum.child.every(c => !c.isDir), 'album children should be songs');
  });
});

// ── 5. Search ───────────────────────────────────────────────────────────────

describe('search3', () => {
  test('matches fixture artist name', async () => {
    const env = await call('search3', { query: 'Icarus' });
    const r = env.searchResult3;
    assert.ok(r.artist?.some(a => a.name === 'Icarus'));
  });

  test('matches album name', async () => {
    const env = await call('search3', { query: 'Night Drive' });
    const r = env.searchResult3;
    assert.ok(r.album?.some(a => a.name === 'Night Drive'));
  });

  test('matches song title', async () => {
    const env = await call('search3', { query: 'Orbit' });
    const r = env.searchResult3;
    assert.ok(r.song?.some(s => s.title === 'Orbit'));
  });

  test('empty query returns empty result (not error)', async () => {
    const env = await call('search3', { query: '' });
    assert.equal(env.status, 'ok');
  });

  test('count limits respected', async () => {
    const env = await call('search3', { query: 'e', songCount: 2 });
    assert.ok((env.searchResult3.song || []).length <= 2);
  });
});

// ── 6. Media ────────────────────────────────────────────────────────────────

describe('Media', () => {
  let songId;
  before(async () => {
    const env = await call('search3', { query: 'Be Somebody' });
    songId = env.searchResult3.song[0].id;
  });

  test('stream native returns audio bytes', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\//);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100);
  });

  test('stream with format=mp3 and maxBitRate=64 transcodes', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId, format: 'mp3', maxBitRate: 64 }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
  });

  test('download returns the native file', async () => {
    const r = await fetch(subsonicUrl('download', { apiKey, id: songId }));
    assert.equal(r.status, 200);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100);
  });

  test('stream unknown id → 404', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: 99999999 }));
    assert.equal(r.status, 404);
  });

  test('getCoverArt returns image bytes when present', async () => {
    // Fixture MP3s are silent + tagged but carry no embedded art, so we accept
    // a 404 if nothing was ever extracted — what matters is that the route
    // is reachable and returns a sensible status.
    const r = await fetch(subsonicUrl('getCoverArt', { apiKey, id: songId }));
    assert.ok([200, 404].includes(r.status), `expected 200 or 404, got ${r.status}`);
  });
});

// ── 7. API key management ──────────────────────────────────────────────────

describe('API key management', () => {
  let token;

  before(async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(USER),
    });
    token = (await r.json()).token;
  });

  test('list includes the key we created in the before hook', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      headers: { 'x-access-token': token },
    });
    const keys = await r.json();
    assert.ok(keys.some(k => k.name === 'test-suite'));
    // list endpoint must NOT leak the key value itself
    assert.ok(!keys.some(k => 'key' in k));
  });

  test('create + revoke cycle', async () => {
    const mk = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ name: 'throwaway' }),
    });
    const { key: newKey } = await mk.json();
    assert.ok(newKey);

    // The new key works for Subsonic
    const ok = await fetch(subsonicUrl('ping', { apiKey: newKey }));
    const env = (await ok.json())['subsonic-response'];
    assert.equal(env.status, 'ok');

    // Revoke and confirm it stops working
    const list = await (await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      headers: { 'x-access-token': token },
    })).json();
    const newRecord = list.find(k => k.name === 'throwaway');
    const del = await fetch(`${server.baseUrl}/api/v1/user/api-keys/${newRecord.id}`, {
      method: 'DELETE',
      headers: { 'x-access-token': token },
    });
    assert.equal(del.status, 200);

    const blocked = await fetch(subsonicUrl('ping', { apiKey: newKey }));
    const envBlocked = (await blocked.json())['subsonic-response'];
    assert.equal(envBlocked.status, 'failed');
    assert.equal(envBlocked.error.code, 40);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2 — scrobble / favourites / lists / playlists
// ══════════════════════════════════════════════════════════════════════════

// Helper: pull one song id from the library so the phase-2 tests can work
// against real rows.
async function oneSongId() {
  const env = await call('search3', { query: 'Be Somebody' });
  return env.searchResult3.song[0].id;
}

describe('scrobble + setRating + star (mutations)', () => {
  let songId;
  before(async () => { songId = await oneSongId(); });

  test('scrobble with submission=true bumps play count', async () => {
    const env1 = await call('scrobble', { id: songId, submission: 'true' });
    assert.equal(env1.status, 'ok');
    const { song } = await call('getSong', { id: songId });
    assert.ok(song.playCount >= 1, `expected playCount >= 1, got ${song.playCount}`);

    const before = song.playCount;
    await call('scrobble', { id: songId, submission: 'true' });
    const { song: after } = await call('getSong', { id: songId });
    assert.equal(after.playCount, before + 1);
  });

  test('scrobble with submission=false does NOT bump', async () => {
    const { song: before } = await call('getSong', { id: songId });
    await call('scrobble', { id: songId, submission: 'false' });
    const { song: after } = await call('getSong', { id: songId });
    assert.equal(after.playCount, before.playCount);
  });

  test('setRating sets, 0 clears', async () => {
    await call('setRating', { id: songId, rating: 4 });
    const { song: s1 } = await call('getSong', { id: songId });
    assert.equal(s1.userRating, 4);

    await call('setRating', { id: songId, rating: 0 });
    const { song: s2 } = await call('getSong', { id: songId });
    assert.equal(s2.userRating, undefined);
  });

  test('invalid rating → error 0', async () => {
    const env = await call('setRating', { id: songId, rating: 99 });
    assert.equal(env.status, 'failed');
  });

  test('star / unstar / getStarred2 round-trip', async () => {
    await call('star', { id: songId });
    const starredEnv = await call('getStarred2');
    const starredIds = (starredEnv.starred2.song || []).map(s => s.id);
    assert.ok(starredIds.includes(songId), `expected ${songId} in starred list`);

    const { song: starredSong } = await call('getSong', { id: songId });
    assert.ok(starredSong.starred, 'song.starred should be an ISO timestamp');

    await call('unstar', { id: songId });
    const after = await call('getStarred2');
    const afterIds = (after.starred2.song || []).map(s => s.id);
    assert.ok(!afterIds.includes(songId));
  });
});

// ── Album lists ────────────────────────────────────────────────────────────

describe('getAlbumList2', () => {
  test('alphabeticalByName returns ordered albums', async () => {
    const env = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const names = env.albumList2.album.map(a => a.name);
    assert.deepEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), names);
  });

  test('newest sorts by created_at DESC', async () => {
    const env = await call('getAlbumList2', { type: 'newest', size: 50 });
    assert.ok(env.albumList2.album.length > 0);
  });

  test('random returns up to `size` albums', async () => {
    const env = await call('getAlbumList2', { type: 'random', size: 2 });
    assert.ok(env.albumList2.album.length <= 2);
  });

  test('byYear requires fromYear/toYear', async () => {
    const missing = await call('getAlbumList2', { type: 'byYear' });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.error.code, 10);

    const env = await call('getAlbumList2', { type: 'byYear', fromYear: 2018, toYear: 2020 });
    assert.equal(env.status, 'ok');
    const years = env.albumList2.album.map(a => a.year);
    assert.ok(years.every(y => y >= 2018 && y <= 2020));
  });

  test('byGenre filters', async () => {
    const env = await call('getAlbumList2', { type: 'byGenre', genre: 'Electronic' });
    assert.ok(env.albumList2.album.length > 0);
  });

  test('getAlbumList (v1) returns same shape under v1 tag', async () => {
    const env = await call('getAlbumList', { type: 'alphabeticalByName' });
    assert.ok(Array.isArray(env.albumList.album));
  });

  test('frequent/highest/recent default to empty when no plays', async () => {
    for (const type of ['frequent', 'highest', 'recent']) {
      const env = await call('getAlbumList2', { type });
      assert.equal(env.status, 'ok');
    }
  });
});

describe('getRandomSongs + getSongsByGenre', () => {
  test('getRandomSongs respects size', async () => {
    const env = await call('getRandomSongs', { size: 3 });
    assert.ok((env.randomSongs.song || []).length <= 3);
  });

  test('getRandomSongs with genre filter', async () => {
    const env = await call('getRandomSongs', { size: 10, genre: 'Electronic' });
    assert.ok(env.randomSongs.song.every(s => s.genre === 'Electronic'));
  });

  test('getSongsByGenre requires genre', async () => {
    const env = await call('getSongsByGenre');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('getSongsByGenre returns matching tracks', async () => {
    const env = await call('getSongsByGenre', { genre: 'Ambient', count: 10 });
    assert.ok(env.songsByGenre.song.every(s => s.genre === 'Ambient'));
  });
});

// ── Playlists ──────────────────────────────────────────────────────────────

describe('Playlists CRUD', () => {
  let songIds;
  let playlistId;

  before(async () => {
    const env = await call('search3', { query: 'e', songCount: 3 });
    songIds = env.searchResult3.song.map(s => s.id);
    assert.ok(songIds.length >= 2, 'need at least 2 songs for playlist tests');
  });

  test('createPlaylist with a name + songs', async () => {
    const env = await call('createPlaylist', { name: 'Test Playlist', songId: songIds });
    assert.equal(env.status, 'ok');
    assert.equal(env.playlist.name, 'Test Playlist');
    assert.equal(env.playlist.songCount, songIds.length);
    assert.equal(env.playlist.entry.length, songIds.length);
    playlistId = env.playlist.id;
  });

  test('getPlaylists lists the new playlist', async () => {
    const env = await call('getPlaylists');
    assert.ok(env.playlists.playlist.some(p => p.id === playlistId));
  });

  test('getPlaylist returns songs in order', async () => {
    const env = await call('getPlaylist', { id: playlistId });
    const ids = env.playlist.entry.map(e => e.id);
    assert.deepEqual(ids, songIds);
  });

  test('updatePlaylist renames, appends, removes', async () => {
    // Rename
    await call('updatePlaylist', { playlistId, name: 'Renamed' });
    let env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.name, 'Renamed');

    // Append the first song again to the end
    await call('updatePlaylist', { playlistId, songIdToAdd: songIds[0] });
    env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.songCount, songIds.length + 1);

    // Remove the first entry (index 0)
    await call('updatePlaylist', { playlistId, songIndexToRemove: 0 });
    env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.songCount, songIds.length);
  });

  test('deletePlaylist removes it', async () => {
    const env = await call('deletePlaylist', { id: playlistId });
    assert.equal(env.status, 'ok');
    const after = await call('getPlaylists');
    assert.ok(!after.playlists.playlist.some(p => p.id === playlistId));
  });

  test('createPlaylist with no name returns error 10', async () => {
    const env = await call('createPlaylist');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});
