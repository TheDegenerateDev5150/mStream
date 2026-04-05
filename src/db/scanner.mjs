// mStream File Scanner
// Scans a directory for audio files and writes metadata directly to SQLite.
// Spawned as a child process by task-queue.js.

import { parseFile } from 'music-metadata';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import { Jimp } from 'jimp';
import mime from 'mime-types';

// ── Parse CLI input ─────────────────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  dbPath: Joi.string().required(),
  libraryId: Joi.number().integer().required(),
  vpath: Joi.string().allow('').optional(),
  directory: Joi.string().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  compressImage: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  scanBatchSize: Joi.number().integer().min(1).default(100)
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

// ── Open SQLite database ────────────────────────────────────────────────────

const db = new DatabaseSync(loadJson.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  getTrack: db.prepare(
    'SELECT id, modified FROM tracks WHERE filepath = ? AND library_id = ?'
  ),
  updateScanId: db.prepare(
    'UPDATE tracks SET scan_id = ? WHERE id = ?'
  ),
  findArtist: db.prepare(
    'SELECT id FROM artists WHERE name = ?'
  ),
  insertArtist: db.prepare(
    'INSERT INTO artists (name) VALUES (?)'
  ),
  findAlbum: db.prepare(
    'SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?'
  ),
  insertAlbum: db.prepare(
    'INSERT INTO albums (name, artist_id, year, album_art_file) VALUES (?, ?, ?, ?)'
  ),
  updateAlbumArt: db.prepare(
    'UPDATE albums SET album_art_file = ? WHERE id = ? AND album_art_file IS NULL'
  ),
  insertTrack: db.prepare(
    `INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
     disc_number, year, format, file_hash, album_art_file, genre, replaygain_track_db,
     modified, scan_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  deleteOldTracks: db.prepare(
    'DELETE FROM tracks WHERE library_id = ? AND scan_id != ?'
  ),
  findGenre: db.prepare(
    'SELECT id FROM genres WHERE name = ?'
  ),
  insertGenre: db.prepare(
    'INSERT INTO genres (name) VALUES (?)'
  ),
  insertTrackGenre: db.prepare(
    'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
  ),
};

// ── Artist / Album helpers ──────────────────────────────────────────────────

function findOrCreateArtist(name) {
  if (!name) { return null; }
  const row = stmts.findArtist.get(name);
  if (row) { return row.id; }
  const result = stmts.insertArtist.run(name);
  return Number(result.lastInsertRowid);
}

function findOrCreateAlbum(name, artistId, year, albumArtFile) {
  if (!name) { return null; }
  const row = stmts.findAlbum.get(name, artistId, year);
  if (row) {
    // Update album art if we have it and the album doesn't
    if (albumArtFile) {
      stmts.updateAlbumArt.run(albumArtFile, row.id);
    }
    return row.id;
  }
  const result = stmts.insertAlbum.run(name, artistId, year, albumArtFile || null);
  return Number(result.lastInsertRowid);
}

function setTrackGenres(trackId, genreStr) {
  if (!genreStr) { return; }
  const genres = genreStr.split(/[,;\/]/).map(g => g.trim()).filter(g => g.length > 0);
  for (const name of genres) {
    let row = stmts.findGenre.get(name);
    if (!row) {
      const result = stmts.insertGenre.run(name);
      row = { id: Number(result.lastInsertRowid) };
    }
    stmts.insertTrackGenre.run(trackId, row.id);
  }
}

// ── File hashing ────────────────────────────────────────────────────────────

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5').setEncoding('hex');
      const fileStream = fs.createReadStream(filepath);
      fileStream.on('error', (err) => reject(err));
      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        resolve(hash.read());
      });
      fileStream.pipe(hash);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Album art ───────────────────────────────────────────────────────────────

const mapOfDirectoryAlbumArt = {};

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // Check embedded picture
  if (songInfo.picture && songInfo.picture[0]) {
    const picHashString = crypto.createHash('md5')
      .update(songInfo.picture[0].data.toString('utf-8'))
      .digest('hex');
    songInfo.aaFile = picHashString + '.' + mime.extension(songInfo.picture[0].format);

    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
      originalFileBuffer = songInfo.picture[0].data;
    }
  } else {
    originalFileBuffer = checkDirectoryForAlbumArt(songInfo);
  }

  if (originalFileBuffer) {
    await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }

  const img = await Jimp.fromBuffer(buff);
  await img.scaleToFit({ w: 256, h: 256 }).write(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await img.scaleToFit({ w: 92, h: 92 }).write(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
}

function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return;
  }
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  let files;
  try { files = fs.readdirSync(directory); } catch (_err) { return; }

  const imageArray = [];
  for (const file of files) {
    const filepath = path.join(directory, file);
    let stat;
    try { stat = fs.statSync(filepath); } catch (_e) { continue; }
    if (!stat.isFile()) { continue; }
    if (!['png', 'jpg'].includes(getFileType(file))) { continue; }
    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    mapOfDirectoryAlbumArt[directory] = false;
    return;
  }

  let imageBuffer;
  let picFormat;
  let newFileFlag = false;

  for (let i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (['folder.jpg', 'cover.jpg', 'album.jpg', 'folder.png', 'cover.png', 'album.png'].includes(imgMod)) {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
      picFormat = getFileType(imageArray[i]);
      break;
    }
  }

  if (!imageBuffer) {
    imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
    picFormat = getFileType(imageArray[0]);
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer.toString('utf8')).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;

  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;
  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split('.').pop();
}

// ── Parse a single file ─────────────────────────────────────────────────────

async function parseMyFile(absolutePath, modified) {
  let songInfo;
  try {
    songInfo = (await parseFile(absolutePath, { skipCovers: loadJson.skipImg })).common;
  } catch (err) {
    console.error(`Warning: metadata parse error on ${absolutePath}: ${err.message}`);
    songInfo = { track: { no: null, of: null }, disk: { no: null, of: null } };
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, absolutePath).replace(/\\/g, '/');
  songInfo.format = getFileType(absolutePath);
  songInfo.hash = await calculateHash(absolutePath);
  await getAlbumArt(songInfo);

  return songInfo;
}

// ── Insert a track into the database ────────────────────────────────────────

function insertTrack(song) {
  const artistId = findOrCreateArtist(song.artist ? String(song.artist) : null);
  const albumId = findOrCreateAlbum(
    song.album ? String(song.album) : null,
    artistId,
    song.year || null,
    song.aaFile || null
  );

  const result = stmts.insertTrack.run(
    song.filePath,
    loadJson.libraryId,
    song.title ? String(song.title) : null,
    artistId,
    albumId,
    song.track?.no || null,
    song.disk?.no || null,
    song.year || null,
    song.format,
    song.hash,
    song.aaFile || null,
    song.genre || null,
    song.replaygain_track_gain?.dB || null,
    song.modified,
    loadJson.scanId
  );

  setTrackGenres(Number(result.lastInsertRowid), song.genre);
}

// ── Recursive directory scan ────────────────────────────────────────────────

let fileCount = 0;      // new/modified files parsed
let totalProcessed = 0; // all files touched (including unchanged — for progress)
let batchCount = 0;
const BATCH_SIZE = loadJson.scanBatchSize || 100;
const PROGRESS_INTERVAL = 25;

// ── Fast file counter (no metadata parsing) ────────────────────────────────

function countSupportedFiles(dir) {
  let count = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const file of files) {
    try {
      const fp = path.join(dir, file);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) {
        count += countSupportedFiles(fp);
      } else if (stat.isFile() && loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
        count++;
      }
    } catch (_) {}
  }
  return count;
}

// ── Scan progress tracking ─────────────────────────────────────────────────

const progressStmts = {
  insert: db.prepare(
    'INSERT OR REPLACE INTO scan_progress (scan_id, library_id, vpath, scanned, expected) VALUES (?, ?, ?, 0, ?)'
  ),
  update: db.prepare(
    'UPDATE scan_progress SET scanned = ?, current_file = ? WHERE scan_id = ?'
  ),
  remove: db.prepare(
    'DELETE FROM scan_progress WHERE scan_id = ?'
  ),
};

async function recursiveScan(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_err) { return; }

  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    try { stat = fs.statSync(filepath); } catch (_e) { continue; }

    if (stat.isDirectory()) {
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      try {
        if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
          continue;
        }

        const relativePath = path.relative(loadJson.directory, filepath).replace(/\\/g, '/');
        const existing = stmts.getTrack.get(relativePath, loadJson.libraryId);

        if (existing && existing.modified === stat.mtime.getTime()) {
          // File unchanged — just update the scan ID
          stmts.updateScanId.run(loadJson.scanId, existing.id);
        } else {
          // New or modified file — parse and insert
          if (existing) {
            // Delete old record (will be re-inserted with fresh metadata)
            db.prepare('DELETE FROM tracks WHERE id = ?').run(existing.id);
          }
          const songInfo = await parseMyFile(filepath, stat.mtime.getTime());
          insertTrack(songInfo);
          fileCount++;
          batchCount++;
        }

        // Track all files (including unchanged) for progress
        totalProcessed++;

        // Periodically commit and report progress so the API can
        // see updates between batches. This also serves as the batch
        // commit for insert performance.
        if (batchCount >= BATCH_SIZE || totalProcessed % PROGRESS_INTERVAL === 0) {
          db.exec('COMMIT');
          try { progressStmts.update.run(totalProcessed, relativePath, loadJson.scanId); } catch (_) {}
          db.exec('BEGIN');
          batchCount = 0;
        }
      } catch (err) {
        console.error(`Warning: failed to process ${filepath}: ${err.message}`);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  try {
    console.log(`Scanning ${loadJson.directory}...`);

    // Fast pre-count of audio files for progress reporting
    const expectedFiles = countSupportedFiles(loadJson.directory);
    try {
      progressStmts.insert.run(loadJson.scanId, loadJson.libraryId, loadJson.vpath || '', expectedFiles || null);
    } catch (_) {}

    // Use explicit transactions for batch performance.
    // Without this, SQLite does a disk fsync per INSERT (~50 files/sec).
    // With transactions, it batches fsyncs (~5000+ files/sec).
    db.exec('BEGIN');
    await recursiveScan(loadJson.directory);
    db.exec('COMMIT');

    // Remove tracks that weren't seen in this scan (deleted files)
    const deleted = stmts.deleteOldTracks.run(loadJson.libraryId, loadJson.scanId);
    console.log(`Scan complete: ${fileCount} files processed, ${deleted.changes} stale entries removed`);

    // Clean up orphaned artists, albums, and genres (no tracks reference them)
    db.exec('DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)');
    db.exec('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL)');
    db.exec('DELETE FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM track_genres)');
  } catch (err) {
    console.error('Scan failed');
    console.error(err.stack);
    // Rollback any open transaction to release the write lock
    try { db.exec('ROLLBACK'); } catch (_) {}
  } finally {
    // Always clean up progress row, even on error
    try { progressStmts.remove.run(loadJson.scanId); } catch (_) {}
    db.close();
  }
}

run();
