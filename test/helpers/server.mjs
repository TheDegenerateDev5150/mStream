/**
 * Spawns an mStream server in a child process for integration tests.
 *
 * Each test run gets a fresh temp directory (config, DB, logs, image cache)
 * and a free TCP port — so tests don't collide with a dev server running on
 * the default 3000, and don't leave state behind between runs.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) { return; }
    } catch (err) { lastErr = err; }
    await sleep(200);
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

async function waitForScanComplete(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/db/status`);
      if (r.ok) {
        const j = await r.json();
        if (!j.locked && j.totalFileCount > 0) { return j.totalFileCount; }
      }
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('initial scan did not complete within timeout');
}

/**
 * Start an mStream instance. Returns { baseUrl, port, stop }.
 *
 * @param {Object} opts
 * @param {string} [opts.dlnaMode='same-port']  DLNA mode to configure
 * @param {string} [opts.browseMode='dirs']     `dlna.browse` default-view setting
 * @param {boolean} [opts.waitForScan=true]     Block until the initial scan finishes
 * @param {boolean} [opts.captureLogs=false]    Pipe stdout/stderr to the test process
 */
export async function startServer(opts = {}) {
  const {
    dlnaMode     = 'same-port',
    browseMode   = 'dirs',
    waitForScan  = true,
    captureLogs  = false,
  } = opts;

  const musicDir = await ensureFixtures();
  const tmpDir   = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-test-'));
  const port     = await findFreePort();

  const config = {
    port,
    address: '127.0.0.1',
    dlna: {
      mode: dlnaMode,
      name: 'mStream Test',
      browse: browseMode,
    },
    folders: { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
  };

  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  // Make the storage dirs up front so config.js doesn't log about them.
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    {
      cwd: REPO_ROOT,
      stdio: captureLogs ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    },
  );

  // Drain output so the buffer doesn't back up even when not captured.
  if (!captureLogs) {
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  let exitedEarly = null;
  proc.once('exit', code => {
    if (!exitedEarly) { exitedEarly = `server exited with code ${code}`; }
  });

  try {
    await waitForReady(baseUrl);
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw exitedEarly ? new Error(exitedEarly) : err;
  }

  if (waitForScan) {
    await waitForScanComplete(baseUrl);
  }

  async function stop() {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGKILL');
      await new Promise(r => proc.once('exit', r));
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { baseUrl, port, tmpDir, musicDir, stop };
}
