/**
 * Parity test: src/db/audio-hash.js (JS) and rust-parser/src/main.rs (Rust)
 * MUST produce byte-identical hashes for the same input file. If they ever
 * drift — even by one byte in the audio-region selection — users lose
 * their user_metadata / user_bookmarks / user_play_queue state whenever the
 * scanner path changes (bin/rust-parser missing → falls back to JS, etc.),
 * which is catastrophic silent data loss.
 *
 * This test generates a fixture in every supported format, runs both
 * implementations over each, and asserts:
 *
 *   - file_hash equal (always — both just MD5 the whole file)
 *   - audio_hash equal (for MP3 + FLAC the extractor covers; for others
 *     both must agree on null — audio_hash isn't supported)
 *
 * The Rust side is invoked via a hidden CLI subcommand `rust-parser
 * --audio-hash <file>` that prints the dual-hash result as JSON. If the
 * binary is missing the test is skipped (CI environments without rust
 * toolchain still see JS-only coverage via hash-migration.test.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeHashes } from '../src/db/audio-hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FFMPEG =
  process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
                               : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// Prefer the freshly-built dev binary if present; fall back to the prebuilt
// shipped under bin/rust-parser/. Either must be the version that has the
// `--audio-hash` subcommand (added in this same commit), so the dev binary
// is the source of truth during development.
function findRustParser() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const libc = process.platform === 'linux' ? '-musl' : '';
  const candidates = [
    path.join(REPO_ROOT, 'rust-parser', 'target', 'release', `rust-parser${ext}`),
    path.join(REPO_ROOT, 'bin', 'rust-parser',
      `rust-parser-${process.platform}-${process.arch}${libc}${ext}`),
  ];
  return candidates.find(p => fsSync.existsSync(p));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)); }
    });
  });
}

function runRustHash(rustBin, filepath) {
  return new Promise((resolve, reject) => {
    const p = spawn(rustBin, ['--audio-hash', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code !== 0) { return reject(new Error(`rust-parser --audio-hash exit ${code}: ${stderr}`)); }
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`bad rust JSON: ${stdout}: ${err.message}`)); }
    });
  });
}

// Each format gets the simplest possible ffmpeg recipe that produces a
// valid file — we don't care about audio content, just about what shape
// the scanner will see in the real world.
const FORMATS = [
  // MP3 with ID3v2 tags — the mainstream case, audio_hash extractor active.
  { ext: 'mp3',  audioHashSupported: true,
    ffArgs: ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3',
             '-metadata', 'title=MP3 Fixture', '-metadata', 'artist=Tester'] },

  // FLAC — lossless container, audio_hash extractor active.
  { ext: 'flac', audioHashSupported: true,
    ffArgs: ['-c:a', 'flac',
             '-metadata', 'title=FLAC Fixture', '-metadata', 'artist=Tester'] },

  // Formats the extractor does NOT yet handle — both sides must return null
  // for audio_hash, and file_hash must still match.
  { ext: 'wav',  audioHashSupported: false, ffArgs: ['-c:a', 'pcm_s16le'] },
  { ext: 'ogg',  audioHashSupported: false,
    ffArgs: ['-c:a', 'libvorbis', '-metadata', 'title=OGG Fixture'] },
  { ext: 'opus', audioHashSupported: false,
    ffArgs: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'opus'] },
  { ext: 'm4a',  audioHashSupported: false,
    ffArgs: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
             '-metadata', 'title=M4A Fixture'] },
];

let tmpDir;
let rustBin;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-hash-parity-'));
  rustBin = findRustParser();
});

after(async () => {
  if (tmpDir) { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('JS ↔ Rust audio-hash parity across all supported formats', () => {
  for (const fmt of FORMATS) {
    test(`${fmt.ext}: file_hash and audio_hash match between JS and Rust`, async (t) => {
      if (!fsSync.existsSync(FFMPEG)) { return t.skip(`no bundled ffmpeg at ${FFMPEG}`); }
      if (!rustBin)                   { return t.skip('no rust-parser binary available'); }

      // Build a fresh fixture in tmpDir for this format.
      const fixturePath = path.join(tmpDir, `fixture.${fmt.ext}`);
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', '1',
        ...fmt.ffArgs,
        fixturePath,
      ]);

      const js   = await computeHashes(fixturePath);
      const rust = await runRustHash(rustBin, fixturePath);

      assert.equal(js.fileHash, rust.fileHash,
        `${fmt.ext}: file_hash diverged between JS and Rust (js=${js.fileHash}, rust=${rust.fileHash})`);

      if (fmt.audioHashSupported) {
        assert.ok(js.audioHash,   `${fmt.ext}: JS audio_hash should be set`);
        assert.ok(rust.audioHash, `${fmt.ext}: Rust audio_hash should be set`);
        assert.equal(js.audioHash, rust.audioHash,
          `${fmt.ext}: audio_hash diverged (js=${js.audioHash}, rust=${rust.audioHash})`);
        // And audio_hash must differ from file_hash — otherwise the extractor
        // silently matched the whole file (e.g. returned the full range), which
        // would defeat the purpose.
        assert.notEqual(js.audioHash, js.fileHash,
          `${fmt.ext}: audio_hash equals file_hash — extractor didn't strip any region`);
      } else {
        assert.equal(js.audioHash, null,
          `${fmt.ext}: JS audio_hash should be null (extractor not implemented)`);
        assert.equal(rust.audioHash, null,
          `${fmt.ext}: Rust audio_hash should be null (extractor not implemented)`);
      }
    });
  }

  test('MP3 audio_hash survives a tag rewrite (same audio bytes → same audio_hash)', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip(); }
    if (!rustBin)                   { return t.skip(); }

    // Generate two MP3s from the same audio source but with different ID3
    // tags. file_hash must differ; audio_hash must be identical.
    const a = path.join(tmpDir, 'tagA.mp3');
    const b = path.join(tmpDir, 'tagB.mp3');
    const common = ['-nostdin', '-y', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
                    '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
    await runFfmpeg([...common,
      '-metadata', 'title=Original', '-metadata', 'artist=Artist A',
      '-metadata', 'album=Album A', a]);
    await runFfmpeg([...common,
      '-metadata', 'title=Edited Title', '-metadata', 'artist=Artist B',
      '-metadata', 'album=Album B Long Name That Makes The Tag Bigger',
      b]);

    const jsA = await computeHashes(a);
    const jsB = await computeHashes(b);
    const rustA = await runRustHash(rustBin, a);
    const rustB = await runRustHash(rustBin, b);

    assert.notEqual(jsA.fileHash, jsB.fileHash, 'file_hash should differ — tag bytes differ');
    assert.equal(jsA.audioHash, jsB.audioHash, 'audio_hash should match — audio payload is identical');
    assert.equal(rustA.audioHash, rustB.audioHash, 'Rust also sees identical audio_hash');
    assert.equal(jsA.audioHash, rustA.audioHash, 'JS and Rust agree');
  });

  test('FLAC audio_hash survives a metadata-block rewrite', async (t) => {
    if (!fsSync.existsSync(FFMPEG)) { return t.skip(); }
    if (!rustBin)                   { return t.skip(); }

    const a = path.join(tmpDir, 'flacA.flac');
    const b = path.join(tmpDir, 'flacB.flac');
    const common = ['-nostdin', '-y', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
                    '-c:a', 'flac'];
    await runFfmpeg([...common, '-metadata', 'title=First',  a]);
    await runFfmpeg([...common, '-metadata', 'title=Second — with a much longer Vorbis comment', b]);

    const jsA = await computeHashes(a);
    const jsB = await computeHashes(b);
    const rustA = await runRustHash(rustBin, a);
    const rustB = await runRustHash(rustBin, b);

    assert.notEqual(jsA.fileHash, jsB.fileHash);
    assert.equal(jsA.audioHash, jsB.audioHash);
    assert.equal(rustA.audioHash, rustB.audioHash);
    assert.equal(jsA.audioHash, rustA.audioHash);
  });
});
