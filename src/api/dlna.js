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

function libraryContainer(lib, parentId, trackCount) {
  return `
  <container id="lib-${lib.id}" parentID="${parentId}" restricted="1" childCount="${trackCount}">
    <dc:title>${xmlEscape(lib.name)}</dc:title>
    <upnp:class>object.container.storageFolder</upnp:class>
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

    // BrowseDirectChildren — list libraries with pagination
    const total = libraries.length;
    const slice = reqCount > 0 ? libraries.slice(startIdx, startIdx + reqCount) : libraries.slice(startIdx);
    const items = slice.map(lib => libraryContainer(lib, '0', getLibraryTrackCount(lib.id))).join('');
    return sendBrowseResponse(res, didlWrapper(items), slice.length, total);
  }

  // ── Library container ─────────────────────────────────────────────────────
  const libMatch = objectId.match(/^lib-(\d+)$/);
  if (libMatch) {
    const libId = parseInt(libMatch[1], 10);
    const lib = libraries.find(l => l.id === libId);
    if (!lib) {
      return sendXml(res, soapError('701', 'No Such Object'), 500);
    }

    if (browseFlag === 'BrowseMetadata') {
      const count = getLibraryTrackCount(libId);
      const didl = didlWrapper(libraryContainer(lib, '0', count));
      return sendBrowseResponse(res, didl, 1, 1);
    }

    const total = getLibraryTrackCount(libId);
    const tracks = getLibraryTracks(libId, startIdx, reqCount);
    const items = tracks.map(t => trackItem(t, lib.name, objectId)).join('');
    return sendBrowseResponse(res, didlWrapper(items), tracks.length, total);
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
    const didl = didlWrapper(trackItem(row, lib.name, `lib-${lib.id}`));
    return sendBrowseResponse(res, didl, 1, 1);
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
