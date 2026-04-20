/**
 * Generates a minimal music library used by the integration tests. Each fixture
 * is a 1-second silent MP3 with embedded ID3 tags so the mStream scanner picks
 * it up as a real track with artist/album/title/year metadata.
 *
 * Fixtures are materialised lazily and cached on disk — the first test run
 * uses ffmpeg to produce them, subsequent runs are instant. The generated
 * files are under `test/fixtures/music/` (gitignored).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MUSIC_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'music');

// Small, deliberately-varied set: multiple artists, an album by two artists
// (exercises compilation/album-artist divergence), multi-disc, unknown genre.
// Keep the list short — the DLNA tests assert counts against it.
const FIXTURES = [
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 1, title: 'Be Somebody' },
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 2, title: 'Rise' },
  { artist: 'Icarus', album: 'Be Somebody',       year: 2019, genre: 'Electronic', disc: 1, track: 3, title: 'Orbit' },
  { artist: 'Icarus', album: 'Later Works',       year: 2021, genre: 'Electronic', disc: 1, track: 1, title: 'Return' },
  { artist: 'Icarus', album: 'Later Works',       year: 2021, genre: 'Electronic', disc: 1, track: 2, title: 'Descent' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 1, title: 'Highway' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 2, title: 'Neon' },
  { artist: 'Vosto',  album: 'Night Drive',       year: 2018, genre: 'Ambient',    disc: 1, track: 3, title: 'Static' },
  { artist: 'Vosto',  album: 'Untitled EP',       year: null, genre: null,         disc: 1, track: 1, title: 'Sketch 1' },
];

const BUNDLED_FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

function relPathFor(f) {
  const trackNum = String(f.track).padStart(2, '0');
  const safe = s => s.replace(/[/\\:*?"<>|]/g, '_');
  return path.join(safe(f.artist), safe(f.album), `${trackNum} - ${safe(f.title)}.mp3`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(BUNDLED_FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)); }
    });
  });
}

async function encode(outPath, f) {
  const meta = ['title', 'artist', 'album', 'date', 'track', 'disc', 'genre'];
  const metaArgs = [];
  const pairs = {
    title:  f.title,
    artist: f.artist,
    album:  f.album,
    date:   f.year ? String(f.year) : null,
    track:  String(f.track),
    disc:   String(f.disc),
    genre:  f.genre,
  };
  for (const key of meta) {
    if (pairs[key] != null) {
      metaArgs.push('-metadata', `${key}=${pairs[key]}`);
    }
  }
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '1',
    '-c:a', 'libmp3lame', '-b:a', '64k',
    ...metaArgs,
    '-id3v2_version', '3',
    outPath,
  ]);
}

// Summary of what the test suite will see. Derived from FIXTURES so assertions
// can reference this instead of hard-coding numbers that drift when the list
// changes.
export const FIXTURE_SUMMARY = {
  trackCount: FIXTURES.length,
  artists:    new Set(FIXTURES.map(f => f.artist)).size,
  albums:     new Set(FIXTURES.map(f => `${f.artist}//${f.album}`)).size,
  // Distinct genres including NULL → 'Unknown Genre'.
  genres:     new Set(FIXTURES.map(f => f.genre ?? '')).size,
  years:      new Set(FIXTURES.map(f => f.year).filter(Boolean)).size,
};

/**
 * Ensures the fixture directory exists and contains every track. Returns the
 * absolute path to the library root.
 *
 * Idempotent — files already on disk are left alone.
 */
export async function ensureFixtures() {
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  for (const f of FIXTURES) {
    const full = path.join(MUSIC_DIR, relPathFor(f));
    try { await fs.access(full); continue; } catch { /* need to generate */ }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await encode(full, f);
  }
  return MUSIC_DIR;
}
