import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as dlnaApi from '../api/dlna.js';
import { sanitizeFilename } from '../util/validation.js';

let dlnaServer = null;

export function start() {
  if (dlnaServer) { return; }

  const app = express();

  // Serve media files directly from library roots — no auth, no static mount.
  // Reads library list from DB at request time so additions/removals are live.
  app.use('/media', (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 2) { return res.status(404).end(); }
    const [libnameRaw, ...fileParts] = parts;
    const libname = decodeURIComponent(libnameRaw);
    const lib = db.getAllLibraries().find(l => l.name === libname);
    if (!lib) { return res.status(404).end(); }
    const filePath = path.join(lib.root_path, ...fileParts.map(p => decodeURIComponent(p)));
    const resolved = path.resolve(filePath);
    const rootResolved = path.resolve(lib.root_path);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      return res.status(403).end();
    }
    res.sendFile(resolved);
  });

  // Serve album art
  app.get('/album-art/:file', (req, res) => {
    if (!req.params.file) { return res.status(404).end(); }
    const filename = sanitizeFilename(req.params.file);
    const compressedPath = path.join(
      config.program.storage.albumArtDirectory,
      `z${req.query.compress}-${filename}`
    );
    if (req.query.compress && fs.existsSync(compressedPath)) {
      return res.sendFile(path.resolve(compressedPath));
    }
    res.sendFile(path.resolve(path.join(config.program.storage.albumArtDirectory, filename)));
  });

  // All DLNA control/description routes — no mode guard needed on this server
  dlnaApi.setup(app, { checkMode: false });

  dlnaServer = http.createServer(app);

  dlnaServer.listen(config.program.dlna.port, config.program.address, () => {
    winston.info(`[dlna] Separate server listening on port ${config.program.dlna.port}`);
  });

  dlnaServer.on('error', (err) => {
    winston.error(`[dlna] Separate server error: ${err.message}`);
    dlnaServer = null;
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
