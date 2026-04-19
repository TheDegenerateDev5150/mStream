import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getBaseUrl } from '../dlna/ssdp.js';

// ── XML / SOAP helpers ───────────────────────────────────────────────────────

function xmlEscape(str) {
  if (str == null) { return ''; }
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractSoapField(body, field) {
  const m = body.match(new RegExp(`<(?:[^:>]+:)?${field}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${field}>`, 'i'));
  return m ? m[1].trim() : '';
}

function soapEnvelope(serviceNs, actionName, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${actionName} xmlns:u="${serviceNs}">
      ${innerXml}
    </u:${actionName}>
  </s:Body>
</s:Envelope>`;
}

function soapError(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>${code}</errorCode>
          <errorDescription>${xmlEscape(description)}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

function sendXml(res, body, status = 200) {
  res.status(status).set('Content-Type', 'text/xml; charset="utf-8"').send(body);
}

// ── Duration / MIME helpers ──────────────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) { return undefined; }
  // Work in integer milliseconds to avoid floating-point carry (e.g. 59.9996s rounding to "60.000")
  const totalMs = Math.round(secs * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = (totalMs % 60000) / 1000;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// filepath segments → URL path (forward slashes, percent-encoded)
function filePathToUrlPath(fp) {
  return fp
    .split(/[\\/]/)
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

const MIME_MAP = {
  mp3:  { mime: 'audio/mpeg', dlnaProfile: 'MP3' },
  flac: { mime: 'audio/flac', dlnaProfile: 'FLAC' },
  wav:  { mime: 'audio/wav',  dlnaProfile: 'WAV' },
  ogg:  { mime: 'audio/ogg',  dlnaProfile: null },
  aac:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  m4a:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  m4b:  { mime: 'audio/mp4',  dlnaProfile: 'AAC_ISO' },
  opus: { mime: 'audio/opus', dlnaProfile: null },
};
const DEFAULT_MIME = { mime: 'application/octet-stream', dlnaProfile: null };
const DLNA_FLAGS = '01500000000000000000000000000000';

function protocolInfo(format) {
  const info = MIME_MAP[(format || '').toLowerCase()] || DEFAULT_MIME;
  const parts = ['DLNA.ORG_OP=01', 'DLNA.ORG_CI=0', `DLNA.ORG_FLAGS=${DLNA_FLAGS}`];
  if (info.dlnaProfile) { parts.unshift(`DLNA.ORG_PN=${info.dlnaProfile}`); }
  return `http-get:*:${info.mime}:${parts.join(';')}`;
}

// ── DIDL-Lite builders ───────────────────────────────────────────────────────

function didlWrapper(items) {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"
  xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${items}</DIDL-Lite>`;
}

function libraryContainer(lib, parentId, childCount) {
  return `
  <container id="lib-${lib.id}" parentID="${parentId}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(lib.name)}</dc:title>
    <upnp:class>object.container.storageFolder</upnp:class>
  </container>`;
}

function dirContainer(libId, relPath, parentId, childCount) {
  const name = relPath.split('/').pop();
  return `
  <container id="dir-${libId}-${encodeRelPath(relPath)}" parentID="${parentId}" restricted="1" childCount="${childCount}">
    <dc:title>${xmlEscape(name)}</dc:title>
    <upnp:class>object.container.storageFolder</upnp:class>
  </container>`;
}

function artistContainer(libId, artist, parentId) {
  return `
  <container id="artist-${libId}-${artist.id}" parentID="${parentId}" restricted="1" childCount="${artist.album_count}">
    <dc:title>${xmlEscape(artist.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`;
}

function albumContainer(libId, album, parentId) {
  return `
  <container id="album-${libId}-${album.id}" parentID="${parentId}" restricted="1" childCount="${album.track_count}">
    <dc:title>${xmlEscape(album.name)}</dc:title>
    <upnp:class>object.container.album.musicAlbum</upnp:class>
  </container>`;
}

function genreContainer(libId, genre, parentId) {
  return `
  <container id="genre-${libId}-${encodeRelPath(genre.name)}" parentID="${parentId}" restricted="1" childCount="${genre.artist_count}">
    <dc:title>${xmlEscape(genre.name)}</dc:title>
    <upnp:class>object.container.genre.musicGenre</upnp:class>
  </container>`;
}

function genreArtistContainer(libId, artist, parentId, genre) {
  return `
  <container id="gartist-${libId}-${artist.id}-${encodeRelPath(genre)}" parentID="${parentId}" restricted="1" childCount="${artist.album_count}">
    <dc:title>${xmlEscape(artist.name)}</dc:title>
    <upnp:class>object.container.person.musicArtist</upnp:class>
  </container>`;
}

function trackItem(track, libName, parentId) {
  const base = getBaseUrl();
  const mediaUrl = `${base}/media/${encodeURIComponent(libName)}/${filePathToUrlPath(track.filepath)}`;

  let artXml = '';
  if (track.album_art_file) {
    artXml = `\n    <upnp:albumArtURI dlna:profileID="JPEG_TN">${xmlEscape(`${base}/album-art/${encodeURIComponent(track.album_art_file)}`)}</upnp:albumArtURI>`;
  }

  const duration = formatDuration(track.duration);
  const durationAttr = duration ? ` duration="${duration}"` : '';
  const sizeAttr = track.file_size ? ` size="${track.file_size}"` : '';

  return `
  <item id="track-${track.id}" parentID="${parentId}" restricted="1">
    <dc:title>${xmlEscape(track.title || path.basename(track.filepath))}</dc:title>
    <dc:creator>${xmlEscape(track.artist_name)}</dc:creator>
    <upnp:artist>${xmlEscape(track.artist_name)}</upnp:artist>
    <upnp:album>${xmlEscape(track.album_name)}</upnp:album>${track.track_number ? `\n    <upnp:originalTrackNumber>${track.track_number}</upnp:originalTrackNumber>` : ''}${track.genre ? `\n    <upnp:genre>${xmlEscape(track.genre)}</upnp:genre>` : ''}${artXml}
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res protocolInfo="${xmlEscape(protocolInfo(track.format))}"${durationAttr}${sizeAttr}>${xmlEscape(mediaUrl)}</res>
  </item>`;
}

// ── DB queries ───────────────────────────────────────────────────────────────

function getLibraryTrackCount(libraryId) {
  const row = db.getDB()
    .prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?')
    .get(libraryId);
  return row ? row.n : 0;
}

function getLibraryTracks(libraryId, start, count) {
  const limit = count > 0 ? count : -1; // SQLite: -1 = no limit
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file,
           a.name AS artist_name,
           al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums al  ON t.album_id  = al.id
    WHERE t.library_id = ?
    ORDER BY al.name, t.disc_number, t.track_number, t.title
    LIMIT ? OFFSET ?
  `).all(libraryId, limit, start);
}

function getAllLibraryTracks(libraryId) {
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file,
           a.name AS artist_name,
           al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums al  ON t.album_id  = al.id
    WHERE t.library_id = ?
    ORDER BY t.filepath
  `).all(libraryId);
}

function getLibraryArtists(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ?
    GROUP BY COALESCE(t.artist_id, 0)
    ORDER BY COALESCE(a.name, '') COLLATE NOCASE
  `).all(libraryId);
}

function getArtistAlbums(libraryId, artistId) {
  if (artistId === 0) {
    return db.getDB().prepare(`
      SELECT COALESCE(t.album_id, 0) AS id,
             COALESCE(al.name, 'Unknown Album') AS name,
             COUNT(*) AS track_count
      FROM tracks t
      LEFT JOIN albums al ON t.album_id = al.id
      WHERE t.library_id = ? AND t.artist_id IS NULL
      GROUP BY COALESCE(t.album_id, 0)
      ORDER BY COALESCE(al.name, '') COLLATE NOCASE
    `).all(libraryId);
  }
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ? AND t.artist_id = ?
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(libraryId, artistId);
}

function getAlbumTracks(libraryId, albumId) {
  if (albumId === 0) {
    return db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
             t.file_size, t.genre, t.album_art_file,
             a.name AS artist_name, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a  ON t.artist_id = a.id
      LEFT JOIN albums  al ON t.album_id  = al.id
      WHERE t.library_id = ? AND t.album_id IS NULL
      ORDER BY t.disc_number, t.track_number, t.title
    `).all(libraryId);
  }
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
           t.file_size, t.genre, t.album_art_file,
           a.name AS artist_name, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON t.artist_id = a.id
    LEFT JOIN albums  al ON t.album_id  = al.id
    WHERE t.library_id = ? AND t.album_id = ?
    ORDER BY t.disc_number, t.track_number, t.title
  `).all(libraryId, albumId);
}

function getLibraryAlbums(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ?
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(libraryId);
}

function getLibraryGenres(libraryId) {
  return db.getDB().prepare(`
    SELECT COALESCE(genre, 'Unknown Genre') AS name,
           COUNT(DISTINCT COALESCE(t.artist_id, 0)) AS artist_count
    FROM tracks t
    WHERE library_id = ?
    GROUP BY COALESCE(genre, 'Unknown Genre')
    ORDER BY COALESCE(genre, '') COLLATE NOCASE
  `).all(libraryId);
}

function getGenreArtists(libraryId, genre) {
  const isUnknown = genre === 'Unknown Genre';
  return db.getDB().prepare(`
    SELECT COALESCE(t.artist_id, 0) AS id,
           COALESCE(a.name, 'Unknown Artist') AS name,
           COUNT(DISTINCT COALESCE(t.album_id, 0)) AS album_count
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.library_id = ? AND ${isUnknown ? 't.genre IS NULL' : 't.genre = ?'}
    GROUP BY COALESCE(t.artist_id, 0)
    ORDER BY COALESCE(a.name, '') COLLATE NOCASE
  `).all(...(isUnknown ? [libraryId] : [libraryId, genre]));
}

function getGenreArtistAlbums(libraryId, genre, artistId) {
  const genreCond  = genre === 'Unknown Genre' ? 't.genre IS NULL'    : 't.genre = ?';
  const artistCond = artistId === 0            ? 't.artist_id IS NULL' : 't.artist_id = ?';
  const params = [libraryId];
  if (genre !== 'Unknown Genre') params.push(genre);
  if (artistId !== 0)            params.push(artistId);
  return db.getDB().prepare(`
    SELECT COALESCE(t.album_id, 0) AS id,
           COALESCE(al.name, 'Unknown Album') AS name,
           COUNT(*) AS track_count
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    WHERE t.library_id = ? AND ${genreCond} AND ${artistCond}
    GROUP BY COALESCE(t.album_id, 0)
    ORDER BY COALESCE(al.name, '') COLLATE NOCASE
  `).all(...params);
}

// ── Directory-tree helpers ───────────────────────────────────────────────────
// filepath in DB is already relative to library root, forward-slash separated.

function encodeRelPath(p) { return Buffer.from(p).toString('base64url'); }
function decodeRelPath(s) { return Buffer.from(s, 'base64url').toString('utf8'); }

// Returns immediate subdirectory names and direct-child track items for a given prefix.
function dirChildren(tracks, prefix) {
  const prefixSlash = prefix ? prefix + '/' : '';
  const dirSet = new Set();
  const items = [];
  for (const t of tracks) {
    if (prefixSlash && !t.filepath.startsWith(prefixSlash)) continue;
    const remainder = t.filepath.slice(prefixSlash.length);
    if (!remainder) continue;
    const slash = remainder.indexOf('/');
    if (slash === -1) items.push(t);
    else dirSet.add(remainder.slice(0, slash));
  }
  return { dirs: [...dirSet].sort(), items };
}

function dirChildCount(tracks, prefix) {
  const { dirs, items } = dirChildren(tracks, prefix);
  return dirs.length + items.length;
}

function paginate(arr, start, count) {
  return count > 0 ? arr.slice(start, start + count) : arr.slice(start);
}

// ── Browse handler ───────────────────────────────────────────────────────────

const CDS_NS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

function handleBrowse(body, res) {
  const objectId   = extractSoapField(body, 'ObjectID');
  const browseFlag = extractSoapField(body, 'BrowseFlag');
  const startIdx   = Math.max(0, parseInt(extractSoapField(body, 'StartingIndex') || '0', 10) || 0);
  const reqCount   = Math.max(0, parseInt(extractSoapField(body, 'RequestedCount') || '0', 10) || 0);

  const libraries = db.getAllLibraries();

  // ── Root container ────────────────────────────────────────────────────────
  if (objectId === '0') {
    if (browseFlag === 'BrowseMetadata') {
      const didl = didlWrapper(`
  <container id="0" parentID="-1" restricted="1" childCount="${libraries.length}">
    <dc:title>${xmlEscape(config.program.dlna.name)}</dc:title>
    <upnp:class>object.container</upnp:class>
  </container>`);
      return sendBrowseResponse(res, didl, 1, 1);
    }
    const total = libraries.length;
    const slice = paginate(libraries, startIdx, reqCount);
    const items = slice.map(lib => libraryContainer(lib, '0', getLibraryTrackCount(lib.id))).join('');
    return sendBrowseResponse(res, didlWrapper(items), slice.length, total);
  }

  // ── Library container ─────────────────────────────────────────────────────
  const libMatch = objectId.match(/^lib-(\d+)$/);
  if (libMatch) {
    const libId = parseInt(libMatch[1], 10);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const count = getLibraryTrackCount(libId);
      return sendBrowseResponse(res, didlWrapper(libraryContainer(lib, '0', count)), 1, 1);
    }

    const browse = config.program.dlna.browse;
    if (browse === 'dirs') {
      const allTracks = getAllLibraryTracks(libId);
      const { dirs, items } = dirChildren(allTracks, '');
      const children = [
        ...dirs.map(d => dirContainer(libId, d, objectId, dirChildCount(allTracks, d))),
        ...items.map(t => trackItem(t, lib.name, objectId)),
      ];
      const slice = paginate(children, startIdx, reqCount);
      return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, children.length);
    }
    if (browse === 'artist') {
      const artists = getLibraryArtists(libId);
      const slice = paginate(artists, startIdx, reqCount);
      return sendBrowseResponse(res, didlWrapper(slice.map(a => artistContainer(libId, a, objectId)).join('')), slice.length, artists.length);
    }
    if (browse === 'album') {
      const albums = getLibraryAlbums(libId);
      const slice = paginate(albums, startIdx, reqCount);
      return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
    }
    if (browse === 'genre') {
      const genres = getLibraryGenres(libId);
      const slice = paginate(genres, startIdx, reqCount);
      return sendBrowseResponse(res, didlWrapper(slice.map(g => genreContainer(libId, g, objectId)).join('')), slice.length, genres.length);
    }
    // flat (default)
    const total = getLibraryTrackCount(libId);
    const tracks = getLibraryTracks(libId, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(tracks.map(t => trackItem(t, lib.name, objectId)).join('')), tracks.length, total);
  }

  // ── Directory container (dirs mode) ──────────────────────────────────────
  const dirMatch = objectId.match(/^dir-(\d+)-(.+)$/);
  if (dirMatch) {
    const libId = parseInt(dirMatch[1], 10);
    const relPath = decodeRelPath(dirMatch[2]);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const allTracks = getAllLibraryTracks(libId);
    const { dirs, items } = dirChildren(allTracks, relPath);

    if (browseFlag === 'BrowseMetadata') {
      const lastSlash = relPath.lastIndexOf('/');
      const parentRel = lastSlash === -1 ? '' : relPath.slice(0, lastSlash);
      const parentId  = parentRel ? `dir-${libId}-${encodeRelPath(parentRel)}` : `lib-${libId}`;
      return sendBrowseResponse(res, didlWrapper(dirContainer(libId, relPath, parentId, dirs.length + items.length)), 1, 1);
    }

    const children = [
      ...dirs.map(d => {
        const full = relPath + '/' + d;
        return dirContainer(libId, full, objectId, dirChildCount(allTracks, full));
      }),
      ...items.map(t => trackItem(t, lib.name, objectId)),
    ];
    const slice = paginate(children, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.join('')), slice.length, children.length);
  }

  // ── Artist container (artist mode) ────────────────────────────────────────
  const artistMatch = objectId.match(/^artist-(\d+)-(\d+)$/);
  if (artistMatch) {
    const libId    = parseInt(artistMatch[1], 10);
    const artistId = parseInt(artistMatch[2], 10);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const artist = getLibraryArtists(libId).find(a => a.id === artistId);
      if (!artist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(artistContainer(libId, artist, `lib-${libId}`)), 1, 1);
    }

    const albums = getArtistAlbums(libId, artistId);
    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Album container (artist mode) ─────────────────────────────────────────
  const albumMatch = objectId.match(/^album-(\d+)-(\d+)$/);
  if (albumMatch) {
    const libId   = parseInt(albumMatch[1], 10);
    const albumId = parseInt(albumMatch[2], 10);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const tracks = getAlbumTracks(libId, albumId);

    if (browseFlag === 'BrowseMetadata') {
      if (!tracks.length) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      const album = { id: albumId, name: tracks[0].album_name || 'Unknown Album', track_count: tracks.length };
      return sendBrowseResponse(res, didlWrapper(albumContainer(libId, album, `lib-${libId}`)), 1, 1);
    }

    const slice = paginate(tracks, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(t => trackItem(t, lib.name, objectId)).join('')), slice.length, tracks.length);
  }

  // ── Genre container (genre mode) ─────────────────────────────────────────
  const genreMatch = objectId.match(/^genre-(\d+)-(.+)$/);
  if (genreMatch) {
    const libId = parseInt(genreMatch[1], 10);
    const genre = decodeRelPath(genreMatch[2]);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const genres = getLibraryGenres(libId);
      const g = genres.find(x => x.name === genre);
      if (!g) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(genreContainer(libId, g, `lib-${libId}`)), 1, 1);
    }

    const artists = getGenreArtists(libId, genre);
    const slice = paginate(artists, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(a => genreArtistContainer(libId, a, objectId, genre)).join('')), slice.length, artists.length);
  }

  // ── Genre-scoped artist container (genre mode) ────────────────────────────
  const gartistMatch = objectId.match(/^gartist-(\d+)-(\d+)-(.+)$/);
  if (gartistMatch) {
    const libId    = parseInt(gartistMatch[1], 10);
    const artistId = parseInt(gartistMatch[2], 10);
    const genre    = decodeRelPath(gartistMatch[3]);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseMetadata') {
      const artist = getGenreArtists(libId, genre).find(a => a.id === artistId);
      if (!artist) { return sendXml(res, soapError('701', 'No Such Object'), 500); }
      return sendBrowseResponse(res, didlWrapper(genreArtistContainer(libId, artist, `genre-${libId}-${encodeRelPath(genre)}`, genre)), 1, 1);
    }

    const albums = getGenreArtistAlbums(libId, genre, artistId);
    const slice = paginate(albums, startIdx, reqCount);
    return sendBrowseResponse(res, didlWrapper(slice.map(al => albumContainer(libId, al, objectId)).join('')), slice.length, albums.length);
  }

  // ── Track item ────────────────────────────────────────────────────────────
  const trackMatch = objectId.match(/^track-(\d+)$/);
  if (trackMatch) {
    const trackId = parseInt(trackMatch[1], 10);
    const row = db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.duration, t.format,
             t.file_size, t.genre, t.album_art_file, t.library_id,
             a.name AS artist_name, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a  ON t.artist_id = a.id
      LEFT JOIN albums al  ON t.album_id  = al.id
      WHERE t.id = ?
    `).get(trackId);
    if (!row) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    const lib = libraries.find(l => l.id === row.library_id);
    if (!lib) { return sendXml(res, soapError('701', 'No Such Object'), 500); }

    if (browseFlag === 'BrowseDirectChildren') {
      return sendBrowseResponse(res, didlWrapper(''), 0, 0);
    }
    return sendBrowseResponse(res, didlWrapper(trackItem(row, lib.name, `lib-${lib.id}`)), 1, 1);
  }

  sendXml(res, soapError('701', 'No Such Object'), 500);
}

function sendBrowseResponse(res, didlXml, numberReturned, totalMatches) {
  const escapedDidl = xmlEscape(didlXml);
  const inner = `<Result>${escapedDidl}</Result>
      <NumberReturned>${numberReturned}</NumberReturned>
      <TotalMatches>${totalMatches}</TotalMatches>
      <UpdateID>1</UpdateID>`;
  sendXml(res, soapEnvelope(CDS_NS, 'BrowseResponse', inner));
}

// ── Static XML documents ─────────────────────────────────────────────────────

function deviceXml() {
  const d = config.program.dlna;
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"
      xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${xmlEscape(d.name)}</friendlyName>
    <manufacturer>mStream</manufacturer>
    <manufacturerURL>https://mstream.io</manufacturerURL>
    <modelName>mStream</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>uuid:${xmlEscape(d.uuid)}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/content-directory-scpd.xml</SCPDURL>
        <controlURL>/dlna/control/content-directory</controlURL>
        <eventSubURL>/dlna/event/content-directory</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/connection-manager-scpd.xml</SCPDURL>
        <controlURL>/dlna/control/connection-manager</controlURL>
        <eventSubURL>/dlna/event/connection-manager</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

const CONTENT_DIRECTORY_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSearchCapabilities</name>
      <argumentList>
        <argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSortCapabilities</name>
      <argumentList>
        <argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>BrowseMetadata</allowedValue>
        <allowedValue>BrowseDirectChildren</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const CONNECTION_MANAGER_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>GetProtocolInfo</name>
      <argumentList>
        <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
        <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetCurrentConnectionIDs</name>
      <argumentList>
        <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetCurrentConnectionInfo</name>
      <argumentList>
        <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
        <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
        <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
        <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
        <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
        <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
        <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// ── Source protocol info list for ConnectionManager ──────────────────────────

const SOURCE_PROTOCOL_INFO = [
  `http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/wav:DLNA.ORG_PN=WAV;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/ogg:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
  `http-get:*:audio/opus:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`,
].join(',');

// ── Route setup ──────────────────────────────────────────────────────────────

export function setup(mstream, { checkMode = true } = {}) {
  function modeOk() { return !checkMode || config.program.dlna.mode === 'same-port'; }

  // All DLNA routes check mode inline — they're registered unconditionally
  // so they sit before the auth wall but silently 503 when disabled/wrong-mode.

  // Device description
  mstream.get('/dlna/device.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, deviceXml());
  });

  // Service descriptions
  mstream.get('/dlna/content-directory-scpd.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, CONTENT_DIRECTORY_SCPD);
  });

  mstream.get('/dlna/connection-manager-scpd.xml', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    sendXml(res, CONNECTION_MANAGER_SCPD);
  });

  // ContentDirectory control (SOAP) — parse XML body inline
  mstream.post('/dlna/control/content-directory',
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml', 'text/*'] }),
    (req, res) => {
      if (!modeOk()) { return res.status(503).end(); }

      const body = typeof req.body === 'string' ? req.body : '';
      const soapAction = ((req.headers['soapaction'] || '')).replace(/"/g, '');
      const action = soapAction.split('#')[1] || '';

      winston.debug(`[dlna] ContentDirectory action: ${action}`);

      try {
        switch (action) {
          case 'Browse':
            return handleBrowse(body, res);

          case 'GetSearchCapabilities':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSearchCapabilitiesResponse',
              '<SearchCaps></SearchCaps>'));

          case 'GetSortCapabilities':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSortCapabilitiesResponse',
              '<SortCaps></SortCaps>'));

          case 'GetSystemUpdateID':
            return sendXml(res, soapEnvelope(CDS_NS, 'GetSystemUpdateIDResponse',
              '<Id>1</Id>'));

          default:
            return sendXml(res, soapError('401', 'Invalid Action'), 500);
        }
      } catch (err) {
        winston.error('[dlna] ContentDirectory error', { stack: err });
        sendXml(res, soapError('501', 'Action Failed'), 500);
      }
    }
  );

  // ConnectionManager control (SOAP)
  const CM_NS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
  mstream.post('/dlna/control/connection-manager',
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml', 'text/*'] }),
    (req, res) => {
      if (!modeOk()) { return res.status(503).end(); }
      const soapAction = ((req.headers['soapaction'] || '')).replace(/"/g, '');
      const action = soapAction.split('#')[1] || '';

      try {
        switch (action) {
          case 'GetProtocolInfo':
            return sendXml(res, soapEnvelope(CM_NS, 'GetProtocolInfoResponse',
              `<Source>${xmlEscape(SOURCE_PROTOCOL_INFO)}</Source><Sink></Sink>`));
          case 'GetCurrentConnectionIDs':
            return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionIDsResponse',
              '<ConnectionIDs>0</ConnectionIDs>'));
          case 'GetCurrentConnectionInfo':
            return sendXml(res, soapEnvelope(CM_NS, 'GetCurrentConnectionInfoResponse',
              '<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo><PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>OK</Status>'));
          default:
            return sendXml(res, soapError('401', 'Invalid Action'), 500);
        }
      } catch (err) {
        winston.error('[dlna] ConnectionManager error', { stack: err });
        sendXml(res, soapError('501', 'Action Failed'), 500);
      }
    }
  );

  // Event subscription stubs — return a minimal valid response
  const stubSid = `uuid:${crypto.randomUUID()}`;
  mstream.all('/dlna/event/content-directory', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    res.set({ 'SID': stubSid, 'TIMEOUT': 'Second-1800', 'Content-Length': '0' }).status(200).end();
  });

  mstream.all('/dlna/event/connection-manager', (req, res) => {
    if (!modeOk()) { return res.status(503).end(); }
    res.set({ 'SID': stubSid, 'TIMEOUT': 'Second-1800', 'Content-Length': '0' }).status(200).end();
  });
}
