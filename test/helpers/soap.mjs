/**
 * SOAP/DIDL client helpers for DLNA tests. Each helper returns parsed data
 * (status + text, or extracted fields) so tests read as assertions against
 * structured values rather than raw XML.
 */

export const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1';
export const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';

export function makeClient(baseUrl) {
  async function soapCall(controlPath, actionNs, actionName, bodyFields = {}) {
    const fieldsXml = Object.entries(bodyFields)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('\n        ');
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${actionName} xmlns:u="${actionNs}">
        ${fieldsXml}
    </u:${actionName}>
  </s:Body>
</s:Envelope>`;
    const r = await fetch(`${baseUrl}${controlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${actionNs}#${actionName}"`,
      },
      body,
    });
    return { status: r.status, text: await r.text() };
  }

  function browse(objectId, browseFlag = 'BrowseDirectChildren', opts = {}) {
    const { start = 0, count = 0, sort = '' } = opts;
    return soapCall('/dlna/control/content-directory', CDS, 'Browse', {
      ObjectID: objectId,
      BrowseFlag: browseFlag,
      Filter: '*',
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: sort,
    });
  }

  function search(containerId, criteria, opts = {}) {
    const { start = 0, count = 0, sort = '' } = opts;
    return soapCall('/dlna/control/content-directory', CDS, 'Search', {
      ContainerID: containerId,
      SearchCriteria: criteria,
      Filter: '*',
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: sort,
    });
  }

  function httpGet(urlPath, init = {}) {
    return fetch(`${baseUrl}${urlPath}`, init);
  }

  async function apiPost(urlPath, body) {
    const r = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  }

  return {
    baseUrl,
    soap: soapCall,
    browse,
    search,
    httpGet,
    apiPost,
  };
}

/** Extract content of the first `<field>…</field>` (with optional namespace). */
export function extractField(xml, field) {
  const m = xml.match(
    new RegExp(`<(?:[^:>]+:)?${field}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${field}>`, 'i'),
  );
  return m ? m[1].trim() : null;
}

/** Extract the DIDL-Lite payload from a SOAP Browse/Search response. */
export function decodeResult(xml) {
  const raw = extractField(xml, 'Result');
  if (!raw) return null;
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Count opening tags (`<item `, `<container `, etc.) in a DIDL fragment. */
export function countTag(xml, tag) {
  return (xml.match(new RegExp(`<${tag}[^/]`, 'g')) || []).length;
}
