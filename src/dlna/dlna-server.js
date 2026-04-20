import express from 'express';
import http from 'node:http';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as dlnaApi from '../api/dlna.js';
import { serveAlbumArtFile } from '../api/album-art.js';
import { timeSeekMiddleware } from './time-seek.js';

let dlnaServer = null;

export function start() {
  if (dlnaServer) { return; }

  const app = express();

  // Time-seek (TimeSeekRange.dlna.org) handler runs first; it calls next()
  // when the client is making a plain byte-range request.
  app.use('/media', timeSeekMiddleware);

  // Serve media files directly from library roots — no auth, no static mount.
  // Reads library list from DB at request time so additions/removals are live.
  app.use('/media', (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 2) { return res.status(404).end(); }
    let libname, fileParts;
    try {
      libname = decodeURIComponent(parts[0]);
      fileParts = parts.slice(1).map(p => decodeURIComponent(p));
    } catch (_) {
      return res.status(400).end();
    }
    const lib = db.getAllLibraries().find(l => l.name === libname);
    if (!lib) { return res.status(404).end(); }
    const resolved = path.resolve(path.join(lib.root_path, ...fileParts));
    const rootResolved = path.resolve(lib.root_path);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      return res.status(403).end();
    }
    res.sendFile(resolved, { dotfiles: 'allow' });
  });

  app.get('/album-art/:file', serveAlbumArtFile);

  // All DLNA control/description routes — no mode guard needed on this server
  dlnaApi.setup(app, { checkMode: false });

  const s = http.createServer(app);
  dlnaServer = s;

  s.listen(config.program.dlna.port, config.program.address, () => {
    winston.info(`[dlna] Separate server listening on port ${config.program.dlna.port}`);
  });

  s.on('error', (err) => {
    winston.error(`[dlna] Separate server error: ${err.message}`);
    // Only clear the module-level reference if it still points at THIS server.
    // A late error on an already-replaced server must not nullify the new one.
    if (dlnaServer === s) { dlnaServer = null; }
  });
}

export function stop() {
  if (!dlnaServer) { return; }
  const s = dlnaServer;
  dlnaServer = null;
  s.close(() => { winston.info('[dlna] Separate server stopped'); });
}

export function isRunning() {
  return dlnaServer !== null;
}
