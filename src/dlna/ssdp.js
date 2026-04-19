import dgram from 'node:dgram';
import os from 'node:os';
import winston from 'winston';
import * as config from '../state/config.js';

const MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const NOTIFY_INTERVAL_MS = 30 * 60 * 1000;

let socket = null;
let notifyTimer = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getLocalIp() {
  const addr = config.program.address;
  if (addr && addr !== '::' && addr !== '0.0.0.0') { return addr; }
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { return iface.address; }
    }
  }
  return '127.0.0.1';
}

export function getBaseUrl() {
  if (config.program.dlna.mode === 'separate-port') {
    return `http://${getLocalIp()}:${config.program.dlna.port}`;
  }
  const proto = config.getIsHttps() ? 'https' : 'http';
  return `${proto}://${getLocalIp()}:${config.program.port}`;
}

function deviceUrl() {
  return `${getBaseUrl()}/dlna/device.xml`;
}

function uuid() {
  return config.program.dlna.uuid;
}

// ── Message builders ─────────────────────────────────────────────────────────

const SERVER_STRING = `Node/${process.version} UPnP/1.0 mStream/1.0`;

function notifyMsg(nt, usn) {
  return [
    'NOTIFY * HTTP/1.1',
    `HOST: ${MULTICAST_ADDR}:${SSDP_PORT}`,
    'CACHE-CONTROL: max-age=1800',
    `LOCATION: ${deviceUrl()}`,
    `NT: ${nt}`,
    'NTS: ssdp:alive',
    `SERVER: ${SERVER_STRING}`,
    `USN: ${usn}`,
    '',
    '',
  ].join('\r\n');
}

function byebyeMsg(nt, usn) {
  return [
    'NOTIFY * HTTP/1.1',
    `HOST: ${MULTICAST_ADDR}:${SSDP_PORT}`,
    `NT: ${nt}`,
    'NTS: ssdp:byebye',
    `USN: ${usn}`,
    '',
    '',
  ].join('\r\n');
}

function searchResponseMsg(st, usn) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    `DATE: ${new Date().toUTCString()}`,
    `LOCATION: ${deviceUrl()}`,
    `SERVER: ${SERVER_STRING}`,
    `ST: ${st}`,
    `USN: ${usn}`,
    'EXT:',
    '',
    '',
  ].join('\r\n');
}

// ── Announce / byebye ────────────────────────────────────────────────────────

function buildAliveMessages() {
  const id = uuid();
  return [
    notifyMsg('upnp:rootdevice',                                              `uuid:${id}::upnp:rootdevice`),
    notifyMsg(`uuid:${id}`,                                                   `uuid:${id}`),
    notifyMsg('urn:schemas-upnp-org:device:MediaServer:1',                   `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`),
    notifyMsg('urn:schemas-upnp-org:service:ContentDirectory:1',             `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`),
    notifyMsg('urn:schemas-upnp-org:service:ConnectionManager:1',            `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`),
  ];
}

function buildByebyeMessages() {
  const id = uuid();
  return [
    byebyeMsg('upnp:rootdevice',                                              `uuid:${id}::upnp:rootdevice`),
    byebyeMsg(`uuid:${id}`,                                                   `uuid:${id}`),
    byebyeMsg('urn:schemas-upnp-org:device:MediaServer:1',                   `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`),
    byebyeMsg('urn:schemas-upnp-org:service:ContentDirectory:1',             `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`),
    byebyeMsg('urn:schemas-upnp-org:service:ConnectionManager:1',            `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`),
  ];
}

function sendMessages(messages) {
  if (!socket) { return; }
  for (const msg of messages) {
    const buf = Buffer.from(msg, 'utf8');
    socket.send(buf, 0, buf.length, SSDP_PORT, MULTICAST_ADDR, (err) => {
      if (err) { winston.debug(`[dlna-ssdp] send error: ${err.message}`); }
    });
  }
}

function sendAlive() {
  sendMessages(buildAliveMessages());
}

// ── M-SEARCH response ────────────────────────────────────────────────────────

function handleSearch(msgStr, rinfo) {
  const stMatch = msgStr.match(/^ST:\s*(.+)$/im);
  if (!stMatch) { return; }
  const st = stMatch[1].trim();
  const id = uuid();

  const matches = {
    'ssdp:all':                                             [
      ['upnp:rootdevice',                                `uuid:${id}::upnp:rootdevice`],
      [`uuid:${id}`,                                     `uuid:${id}`],
      ['urn:schemas-upnp-org:device:MediaServer:1',     `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`],
      ['urn:schemas-upnp-org:service:ContentDirectory:1',  `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`],
      ['urn:schemas-upnp-org:service:ConnectionManager:1', `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`],
    ],
    'upnp:rootdevice':                                      [['upnp:rootdevice', `uuid:${id}::upnp:rootdevice`]],
    [`uuid:${id}`]:                                         [[`uuid:${id}`, `uuid:${id}`]],
    'urn:schemas-upnp-org:device:MediaServer:1':           [['urn:schemas-upnp-org:device:MediaServer:1', `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`]],
    'urn:schemas-upnp-org:service:ContentDirectory:1':     [['urn:schemas-upnp-org:service:ContentDirectory:1', `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`]],
    'urn:schemas-upnp-org:service:ConnectionManager:1':    [['urn:schemas-upnp-org:service:ConnectionManager:1', `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`]],
  };

  const pairs = matches[st];
  if (!pairs) { return; }

  // Honor MX: delay responses by a random 0..MX seconds, then stagger by 50ms each
  const mxMatch = msgStr.match(/^MX:\s*(\d+)/im);
  const mx = Math.max(1, parseInt(mxMatch ? mxMatch[1] : '1', 10));
  let delay = Math.floor(Math.random() * mx * 1000);
  for (const [respSt, respUsn] of pairs) {
    const msg = searchResponseMsg(respSt, respUsn);
    const buf = Buffer.from(msg, 'utf8');
    setTimeout(() => {
      if (!socket) { return; }
      socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
        if (err) { winston.debug(`[dlna-ssdp] search response error: ${err.message}`); }
      });
    }, delay);
    delay += 50;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function start() {
  if (socket) { return; }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket = sock;

  sock.on('error', (err) => {
    winston.error(`[dlna-ssdp] Socket error: ${err.message}`);
    stop();
  });

  sock.on('message', (msg, rinfo) => {
    const str = msg.toString('utf8');
    if (str.startsWith('M-SEARCH')) { handleSearch(str, rinfo); }
  });

  sock.bind(SSDP_PORT, () => {
    // Guard: if stop() was called before bind completed, don't proceed
    if (socket !== sock) { return; }
    try {
      sock.addMembership(MULTICAST_ADDR);
      sock.setMulticastTTL(4);
    } catch (err) {
      winston.warn(`[dlna-ssdp] Multicast setup: ${err.message}`);
    }
    sendAlive();
    winston.info(`[dlna-ssdp] Listening on ${getLocalIp()}:${SSDP_PORT}`);
  });

  notifyTimer = setInterval(sendAlive, NOTIFY_INTERVAL_MS);
}

export function stop() {
  if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
  if (!socket) { return; }

  const sock = socket;
  socket = null; // prevent any new sends from start() or timers

  const messages = buildByebyeMessages();
  let remaining = messages.length;

  function closeWhenDone() {
    if (--remaining === 0) {
      try { sock.close(); } catch (_) {}
      winston.info('[dlna-ssdp] Stopped');
    }
  }

  for (const msg of messages) {
    const buf = Buffer.from(msg, 'utf8');
    sock.send(buf, 0, buf.length, SSDP_PORT, MULTICAST_ADDR, () => closeWhenDone());
  }
}
