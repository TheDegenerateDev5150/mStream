import fs from 'fs/promises';
import path from 'path';
import child from 'child_process';
import express from 'express';
import * as auth from './auth.js';
import * as config from '../state/config.js';
import * as mStreamServer from '../server.js';
import * as dbQueue from '../db/task-queue.js';
import * as logger from '../logger.js';
import * as db from '../db/manager.js';
import * as syncthing from '../state/syncthing.js';
import * as dlnaSsdp from '../dlna/ssdp.js';
import * as dlnaServer from '../dlna/dlna-server.js';
import { getDirname } from './esm-helpers.js';

const __dirname = getDirname(import.meta.url);

// ── Config file helpers (for server-level settings) ─────────────────────────

export async function loadFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export function saveFile(saveData, file) {
  return fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8');
}

// ── Directory / Library management (now in SQLite) ──────────────────────────

export async function addDirectory(directory, vpath, autoAccess, isAudioBooks, mstream) {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw new Error(`${directory} is not a directory`); }

  const existing = db.getLibraryByName(vpath);
  if (existing) { throw new Error(`'${vpath}' already exists`); }

  const d = db.getDB();
  const type = isAudioBooks ? 'audio-books' : 'music';
  const result = d.prepare(
    'INSERT INTO libraries (name, root_path, type) VALUES (?, ?, ?)'
  ).run(vpath, directory, type);
  const libraryId = Number(result.lastInsertRowid);

  if (autoAccess === true) {
    const users = db.getAllUsers();
    const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
    for (const user of users) {
      insertUL.run(user.id, libraryId);
    }
  }

  db.invalidateCache();

  // Add to express routing
  mstream.use(`/media/${vpath}/`, express.static(directory));
}

export async function removeDirectory(vpath) {
  const library = db.getLibraryByName(vpath);
  if (!library) { throw new Error(`'${vpath}' not found`); }

  const d = db.getDB();
  // CASCADE will delete tracks and user_libraries entries
  d.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);

  // Clean up orphaned artists/albums
  d.exec('DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)');
  d.exec('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL)');

  db.invalidateCache();

  // Reboot to remove the static route
  mStreamServer.reboot();
}

// ── User management (now in SQLite) ─────────────────────────────────────────

export async function addUser(username, password, admin, vpaths, allowMkdir, allowUpload) {
  const existing = db.getUserByUsername(username);
  if (existing) { throw new Error(`'${username}' already exists`); }

  const hash = await auth.hashPassword(password);
  const d = db.getDB();

  const result = d.prepare(
    `INSERT INTO users (username, password, salt, is_admin, allow_upload, allow_mkdir)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, hash.hashPassword, hash.salt, admin ? 1 : 0, allowUpload ? 1 : 0, allowMkdir ? 1 : 0);

  const userId = Number(result.lastInsertRowid);

  // Link vpaths
  if (vpaths && vpaths.length > 0) {
    const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
    for (const vpathName of vpaths) {
      const lib = db.getLibraryByName(vpathName);
      if (lib) { insertUL.run(userId, lib.id); }
    }
  }

  db.invalidateCache();
}

export async function deleteUser(username) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const d = db.getDB();
  // CASCADE will delete user_metadata, playlists, playlist_tracks, user_libraries
  d.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  db.invalidateCache();
}

export async function editUserPassword(username, password) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const hash = await auth.hashPassword(password);
  db.getDB().prepare(
    'UPDATE users SET password = ?, salt = ? WHERE id = ?'
  ).run(hash.hashPassword, hash.salt, user.id);

  db.invalidateCache();
}

export async function editUserVPaths(username, vpaths) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  const d = db.getDB();
  // Clear existing and re-add
  d.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(user.id);
  const insertUL = d.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
  for (const vpathName of vpaths) {
    const lib = db.getLibraryByName(vpathName);
    if (lib) { insertUL.run(user.id, lib.id); }
  }

  db.invalidateCache();
}

export async function editUserAccess(username, admin, allowMkdir, allowUpload, allowFileModify = true) {
  const user = db.getUserByUsername(username);
  if (!user) { throw new Error(`'${username}' does not exist`); }

  db.getDB().prepare(
    'UPDATE users SET is_admin = ?, allow_mkdir = ?, allow_upload = ?, allow_file_modify = ? WHERE id = ?'
  ).run(admin ? 1 : 0, allowMkdir ? 1 : 0, allowUpload ? 1 : 0, allowFileModify ? 1 : 0, user.id);

  db.invalidateCache();
}

// ── Config file settings (server-level, stay in JSON) ───────────────────────

export async function editUI(ui) {
  if (config.program.ui === ui) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ui = ui;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editPort(port) {
  if (config.program.port === port) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.port = port;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editMaxRequestSize(maxRequestSize) {
  if (config.program.maxRequestSize === maxRequestSize) { return; }
  const loadConfig = await loadFile(config.configFile);
  loadConfig.maxRequestSize = maxRequestSize;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editUpload(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noUpload = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noUpload = val;
}

export async function editMkdir(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noMkdir = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noMkdir = val;
}

export async function editFileModify(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noFileModify = val;
  await saveFile(loadConfig, config.configFile);
  config.program.noFileModify = val;
}

export async function editAddress(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.address = val;
  await saveFile(loadConfig, config.configFile);
  mStreamServer.reboot();
}

export async function editSecret(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.secret = val;
  await saveFile(loadConfig, config.configFile);
  config.program.secret = val;
}

export async function editScanInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanInterval = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.scanInterval = val;
  dbQueue.resetScanInterval();
}

export async function editSkipImg(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.skipImg = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.skipImg = val;
}

export async function editBootScanDelay(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanDelay = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.bootScanDelay = val;
}

export async function editMaxConcurrentTasks(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxConcurrentTasks = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.maxConcurrentTasks = val;
}

export async function editCompressImages(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.compressImage = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.compressImage = val;
}

export async function editScanBatchSize(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanBatchSize = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.scanBatchSize = val;
}

export async function editAutoAlbumArt(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.autoAlbumArt = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.autoAlbumArt = val;
}

export async function editAlbumArtWriteToFolder(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtWriteToFolder = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtWriteToFolder = val;
}

export async function editAlbumArtWriteToFile(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtWriteToFile = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtWriteToFile = val;
}

export async function editAlbumArtServices(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.albumArtServices = val;
  await saveFile(loadConfig, config.configFile);
  config.program.scanOptions.albumArtServices = val;
}

export async function editWriteLogs(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await saveFile(loadConfig, config.configFile);
  config.program.writeLogs = val;
  if (val === false) { logger.reset(); }
  else { logger.addFileLogger(config.program.storage.logsDirectory); }
}

export async function editDefaultCodec(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultCodec = val;
  await saveFile(loadConfig, config.configFile);
  config.program.transcode.defaultCodec = val;
}

export async function editDefaultBitrate(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultBitrate = val;
  await saveFile(loadConfig, config.configFile);
  config.program.transcode.defaultBitrate = val;
}

export async function lockAdminApi(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.lockAdmin = val;
  await saveFile(loadConfig, config.configFile);
  config.program.lockAdmin = val;
}

export async function enableDlna(mode, port) {
  const effectivePort = port !== undefined ? port : config.program.dlna.port;
  if (mode === config.program.dlna.mode && effectivePort === config.program.dlna.port) { return; }

  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.dlna) { loadConfig.dlna = {}; }
  loadConfig.dlna.mode = mode;
  if (port !== undefined) { loadConfig.dlna.port = port; }
  await saveFile(loadConfig, config.configFile);
  config.program.dlna.mode = mode;
  if (port !== undefined) { config.program.dlna.port = port; }

  // Stop everything, then start what the new mode requires
  dlnaSsdp.stop();
  dlnaServer.stop();
  if (mode !== 'disabled') { dlnaSsdp.start(); }
  if (mode === 'separate-port') { dlnaServer.start(); }
}

export async function enableFederation(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.federation) { loadConfig.federation = {}; }
  loadConfig.federation.enabled = val;
  await saveFile(loadConfig, config.configFile);
  config.program.federation.enabled = val;
  syncthing.setup();
}

export async function removeSSL() {
  const loadConfig = await loadFile(config.configFile);
  delete loadConfig.ssl;
  await saveFile(loadConfig, config.configFile);
  delete config.program.ssl;
  mStreamServer.reboot();
}

function testSSL(jsonLoad) {
  return new Promise((resolve, reject) => {
    child.fork(path.join(__dirname, './ssl-test.js'), [JSON.stringify(jsonLoad)], { silent: true }).on('close', (code) => {
      if (code !== 0) { return reject('SSL Failure'); }
      resolve();
    });
  });
}

export async function setSSL(cert, key) {
  const sslObj = { key, cert };
  await testSSL(sslObj);
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ssl = sslObj;
  await saveFile(loadConfig, config.configFile);
  config.program.ssl = sslObj;
  mStreamServer.reboot();
}

export async function editAutoBootServerAudio(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.autoBootServerAudio = val;
  await saveFile(loadConfig, config.configFile);
  config.program.autoBootServerAudio = val;
}

export async function editRustPlayerPort(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.rustPlayerPort = val;
  await saveFile(loadConfig, config.configFile);
  config.program.rustPlayerPort = val;
}
