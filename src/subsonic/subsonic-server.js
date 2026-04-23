/**
 * Subsonic REST API — separate-port server.
 *
 * When `subsonic.mode = 'separate-port'` the REST API is hosted on its own
 * HTTP server so it can be firewalled, reverse-proxied, or log-filtered
 * independently of the main mStream web UI. Authentication is still handled
 * by the Subsonic layer itself (u/p or apiKey), so this server carries no
 * mStream session cookies.
 */

import express from 'express';
import http from 'node:http';
import winston from 'winston';
import * as config from '../state/config.js';
import * as subsonicApi from '../api/subsonic/index.js';

let server = null;

export function start() {
  if (server) { return; }

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  subsonicApi.setup(app);

  const s = http.createServer(app);
  server = s;

  s.listen(config.program.subsonic.port, config.program.address, () => {
    winston.info(`[subsonic] Separate server listening on port ${config.program.subsonic.port}`);
  });

  s.on('error', (err) => {
    winston.error(`[subsonic] Separate server error: ${err.message}`);
    // Identity check: only clear the module ref if it still points at THIS
    // server. A late error on an already-replaced instance mustn't nullify
    // the new one.
    if (server === s) { server = null; }
  });
}

export function stop() {
  if (!server) { return; }
  const s = server;
  server = null;
  s.close(() => { winston.info('[subsonic] Separate server stopped'); });
}

export function isRunning() { return server !== null; }
