use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use lofty::config::{ParseOptions, ParsingMode};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue};
use lofty::picture::MimeType;
use rusqlite::Connection;
use serde::Deserialize;
use walkdir::WalkDir;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// Number of bars in a waveform — matches NUM_BARS in src/db/waveform-lib.js.
// Cache files are exactly this many bytes (one u8 per bar).
const NUM_BARS: usize = 800;

// ── Config (matches what task-queue.js passes) ──────────────────────────────

#[derive(Deserialize)]
struct ScanConfig {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "libraryId")]
    library_id: i64,
    #[serde(default)]
    vpath: String,
    directory: String,
    #[serde(rename = "skipImg")]
    skip_img: bool,
    #[serde(rename = "albumArtDirectory")]
    album_art_directory: String,
    #[serde(rename = "scanId")]
    scan_id: String,
    #[serde(rename = "compressImage")]
    compress_image: bool,
    #[serde(rename = "supportedFiles")]
    supported_files: HashMap<String, bool>,
    #[serde(rename = "scanCommitInterval", default = "default_commit_interval")]
    scan_commit_interval: u64,
    #[serde(rename = "forceRescan", default)]
    force_rescan: bool,
    #[serde(rename = "waveformCacheDir", default)]
    waveform_cache_dir: String,
}

fn default_commit_interval() -> u64 { 25 }

// ── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Hidden developer/test subcommand: `rust-parser --audio-hash <path>`
    // prints the dual-hash result as JSON on stdout and exits. Used by
    // test/audio-hash-parity.test.mjs to compare against the JS impl.
    if args.len() == 3 && args[1] == "--audio-hash" {
        let p = Path::new(&args[2]);
        let ext = file_ext(p).to_lowercase();
        match compute_hashes(p, &ext) {
            Ok((fh, ah)) => {
                // Null-safe JSON serialization without pulling in serde for a
                // one-line output: quote strings, use "null" for None.
                let ah_json = match ah {
                    Some(s) => format!("\"{}\"", s),
                    None => "null".to_string(),
                };
                println!("{{\"fileHash\":\"{}\",\"audioHash\":{},\"format\":\"{}\"}}", fh, ah_json, ext);
                return;
            }
            Err(e) => {
                eprintln!("compute_hashes failed: {}", e);
                std::process::exit(2);
            }
        }
    }

    let json_str = match args.last() {
        Some(s) if args.len() > 1 => s.clone(),
        _ => {
            eprintln!("Warning: failed to parse JSON input");
            std::process::exit(1);
        }
    };

    let config: ScanConfig = match serde_json::from_str(&json_str) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Invalid JSON Input: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = run_scan(&config) {
        eprintln!("Scan Failed\n{}", e);
        std::process::exit(1);
    }
}

// ── Main scan ───────────────────────────────────────────────────────────────

fn run_scan(config: &ScanConfig) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::open(&config.db_path)?;
    // Wait up to 5s when another connection holds the write lock (e.g. the
    // main server's shared-playlist cleanup or any API-triggered write).
    // Without this, the scanner fails immediately with "database is locked".
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;

    let dir_art_cache: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());

    println!("Scanning {}...", config.directory);

    let entries: Vec<walkdir::DirEntry> = WalkDir::new(&config.directory)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .collect();

    // Count expected audio files for progress reporting
    let expected_files: u64 = entries.iter()
        .filter(|e| {
            let ext = file_ext(e.path()).to_lowercase();
            config.supported_files.get(&ext).copied().unwrap_or(false)
        })
        .count() as u64;

    // Insert initial progress row
    let _ = conn.execute(
        "INSERT OR REPLACE INTO scan_progress (scan_id, library_id, vpath, scanned, expected) VALUES (?1, ?2, ?3, 0, ?4)",
        rusqlite::params![config.scan_id, config.library_id, config.vpath, expected_files],
    );

    let mut file_count = 0u64;      // new/modified files parsed
    let mut total_processed = 0u64; // all files touched (including unchanged — for progress)
    // Commit cadence: doubles as progress-update cadence and write-lock release.
    // Lower = more responsive API writes during scans but more COMMIT/BEGIN overhead.
    // Admin-configurable via scanCommitInterval; default (25) is a balanced starting point.
    let commit_interval = config.scan_commit_interval;

    // Use explicit transactions for batch performance.
    // Without this, SQLite does a disk fsync per INSERT (~50 files/sec).
    // With transactions, it batches fsyncs (~5000+ files/sec).
    conn.execute_batch("BEGIN")?;

    for entry in &entries {
        let ext = file_ext(entry.path()).to_lowercase();
        if !config.supported_files.get(&ext).copied().unwrap_or(false) {
            continue;
        }

        match process_one(entry, &ext, config, &conn, &dir_art_cache) {
            Ok(true) => {
                file_count += 1;
            }
            Ok(false) => {} // skipped (unchanged)
            Err(e) => {
                eprintln!("Warning: failed to process {}: {}", entry.path().display(), e);
            }
        }

        // Track all files (including unchanged) for progress
        total_processed += 1;

        // Periodically commit and report progress so the API can see
        // updates between batches. Also serves as the batch commit.
        if total_processed % commit_interval == 0 {
            let rel = entry.path().strip_prefix(&config.directory)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            conn.execute_batch("COMMIT")?;
            let _ = conn.execute(
                "UPDATE scan_progress SET scanned = ?1, current_file = ?2 WHERE scan_id = ?3",
                rusqlite::params![total_processed, rel, config.scan_id],
            );
            conn.execute_batch("BEGIN")?;
        }
    }

    conn.execute_batch("COMMIT")?;

    // Remove progress row — scan is done
    let _ = conn.execute("DELETE FROM scan_progress WHERE scan_id = ?1", rusqlite::params![config.scan_id]);

    // Remove tracks not seen in this scan (deleted files)
    let deleted = conn.execute(
        "DELETE FROM tracks WHERE library_id = ? AND scan_id != ?",
        rusqlite::params![config.library_id, config.scan_id],
    )?;

    // Clean up orphaned artists and albums
    conn.execute_batch(
        "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
         DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
         DELETE FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM track_genres);"
    )?;

    // Structured end-of-scan event — parsed by task-queue.js to decide whether
    // to run the waveform post-processor. Integer fields only; no escaping needed.
    println!(
        "{{\"event\":\"scanComplete\",\"filesProcessed\":{},\"staleEntriesRemoved\":{}}}",
        file_count, deleted
    );
    Ok(())
}

// ── Per-file processing ─────────────────────────────────────────────────────

fn process_one(
    entry: &walkdir::DirEntry,
    ext: &str,
    config: &ScanConfig,
    conn: &Connection,
    dir_art_cache: &Mutex<HashMap<String, Option<String>>>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let filepath = entry.path();
    let mod_time = entry.metadata()?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;

    let rel_path = filepath
        .strip_prefix(&config.directory)?
        .to_string_lossy()
        .replace('\\', "/");

    // Check if the file is already in the table. Keep a snapshot of both
    // hashes so we can migrate user-facing rows (stars, ratings, play
    // counts, bookmarks, play queue) if the track's canonical identity
    // changed on re-parse — typical trigger is an external ID3 tag editor.
    let existing: Option<(i64, i64, String, String)> = conn.prepare_cached(
        "SELECT id, modified, file_hash, audio_hash FROM tracks WHERE filepath = ? AND library_id = ?"
    )?.query_row(rusqlite::params![rel_path, config.library_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    }).ok();

    let (old_hash, old_audio_hash): (Option<String>, Option<String>) =
        if let Some((id, existing_mod, old_file, old_audio)) = &existing {
            if *existing_mod == mod_time && !config.force_rescan {
                // Unchanged — just update scan_id
                conn.execute("UPDATE tracks SET scan_id = ? WHERE id = ?",
                    rusqlite::params![config.scan_id, id])?;
                return Ok(false);
            }
            conn.execute("DELETE FROM tracks WHERE id = ?", rusqlite::params![id])?;
            (
                if old_file.is_empty()  { None } else { Some(old_file.clone())  },
                if old_audio.is_empty() { None } else { Some(old_audio.clone()) },
            )
        } else {
            (None, None)
        };

    // Parse metadata
    let mut title = None;
    let mut artist = None;
    let mut album = None;
    let mut year: Option<i64> = None;
    let mut track_num: Option<i64> = None;
    let mut disc_num: Option<i64> = None;
    let mut genre = None;
    let mut rg_track_db: Option<f64> = None;
    let mut aa_file: Option<String> = None;
    let mut duration_sec: Option<f64> = None;
    // OpenSubsonic extended audio-format fields. Populated from lofty's
    // audio properties below; NULL when unavailable.
    let mut sample_rate: Option<i64> = None;
    let mut channels: Option<i64> = None;
    let mut bit_depth: Option<i64> = None;

    // Use Relaxed parsing so malformed frames (e.g. odd-length UTF-16 strings,
    // invalid year lengths) get dropped individually instead of failing the
    // whole file. Bulk rips with a broken tagger can otherwise lose all
    // metadata for hundreds of tracks from one bad frame each.
    let parse_opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    match Probe::open(filepath).and_then(|p| p.options(parse_opts).read()) {
        Ok(tagged_file) => {
            // Get duration + extended audio properties.
            let props = tagged_file.properties();
            let dur = props.duration();
            if !dur.is_zero() {
                duration_sec = Some(dur.as_secs_f64());
            }
            if let Some(sr) = props.sample_rate() { sample_rate = Some(sr as i64); }
            if let Some(ch) = props.channels() {
                if ch > 0 { channels = Some(ch as i64); }
            }
            if let Some(bd) = props.bit_depth() { bit_depth = Some(bd as i64); }

            let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
            if let Some(tag) = tag {
                title = tag.title().map(|s| s.to_string());
                artist = tag.artist().map(|s| s.to_string());
                album = tag.album().map(|s| s.to_string());
                year = tag.year().map(|y| y as i64);
                track_num = tag.track().map(|t| t as i64);
                disc_num = tag.disk().map(|d| d as i64);
                genre = tag.genre().map(|s| s.to_string());

                rg_track_db = tag.get(&ItemKey::ReplayGainTrackGain).and_then(|item| {
                    if let ItemValue::Text(s) = item.value() {
                        parse_replaygain_db(s)
                    } else { None }
                });

                if !config.skip_img {
                    if let Some(pic) = tag.pictures().first() {
                        aa_file = save_embedded_art(pic, config);
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("Warning: metadata parse error on {}: {}", filepath.display(), e);
        }
    }

    if aa_file.is_none() && !config.skip_img {
        aa_file = check_directory_for_album_art(filepath, config, dir_art_cache);
    }

    let (hash, audio_hash) = compute_hashes(filepath, ext)?;

    // Best-effort waveform generation — uses audio_hash as the cache key so
    // waveforms survive tag edits (same pattern as user_* rows). Falls back
    // to file_hash when the format has no audio_hash. Skipped for .opus
    // (symphonia 0.5 doesn't decode Opus yet; on-demand endpoint handles it
    // via ffmpeg lazily) and for tracks whose .bin file already exists.
    if !config.waveform_cache_dir.is_empty() {
        let wf_key = audio_hash.as_deref().unwrap_or(&hash);
        let wf_path = PathBuf::from(&config.waveform_cache_dir).join(format!("{}.bin", wf_key));
        if !wf_path.exists() {
            if let Some(bars) = waveform_from_symphonia(filepath, ext) {
                if let Some(dir) = wf_path.parent() {
                    let _ = fs::create_dir_all(dir);
                }
                // Write atomically — partial writes (process killed mid-I/O)
                // would otherwise leave a truncated .bin that looks valid to
                // the existence check and serves garbage to players. Rename
                // on the same filesystem is atomic on POSIX and on Windows
                // when the target doesn't exist.
                let tmp_path = PathBuf::from(&config.waveform_cache_dir)
                    .join(format!("{}.bin.tmp", wf_key));
                if fs::write(&tmp_path, &bars).is_ok() {
                    let _ = fs::rename(&tmp_path, &wf_path);
                }
            }
        }
    }

    // Find or create artist
    let artist_id = match &artist {
        Some(name) => Some(find_or_create_artist(conn, name)?),
        None => None,
    };

    // Find or create album
    let album_id = match &album {
        Some(name) => {
            let aid = find_or_create_album(conn, name, artist_id, year, aa_file.as_deref())?;
            Some(aid)
        }
        None => None,
    };

    // Insert track
    conn.execute(
        "INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
         disc_number, year, duration, format, file_hash, audio_hash, album_art_file, genre,
         replaygain_track_db, sample_rate, channels, bit_depth, modified, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            rel_path, config.library_id, title, artist_id, album_id,
            track_num, disc_num, year, duration_sec, ext, hash, audio_hash,
            aa_file, genre, rg_track_db, sample_rate, channels, bit_depth,
            mod_time, config.scan_id
        ],
    )?;

    let track_id = conn.last_insert_rowid();
    set_track_genres(conn, track_id, genre.as_deref())?;

    // Migrate user_* rows to the new canonical identity. Canonical = audio_hash
    // when present, file_hash otherwise. A tag edit keeps audio_hash stable,
    // so the common case is a no-op; migration only runs on real content
    // change or on the transition from file-hash-only rows to audio_hash rows.
    let new_canon = audio_hash.clone().unwrap_or_else(|| hash.clone());
    let old_canon = old_audio_hash.clone().unwrap_or_else(|| old_hash.clone().unwrap_or_default());
    if !old_canon.is_empty() && old_canon != new_canon {
        migrate_hash_references(conn, &old_canon, &new_canon)?;
    }

    Ok(true)
}

/// Update user-facing rows that key off `file_hash` when a file's content
/// hash changes without a path change. Mirrors `migrateHashReferences` in
/// src/db/scanner.mjs — see the comment there for the rationale.
fn migrate_hash_references(
    conn: &Connection, old_hash: &str, new_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "UPDATE user_metadata SET track_hash = ? WHERE track_hash = ?",
        rusqlite::params![new_hash, old_hash],
    )?;
    conn.execute(
        "UPDATE user_bookmarks SET track_hash = ? WHERE track_hash = ?",
        rusqlite::params![new_hash, old_hash],
    )?;

    // user_play_queue stores the queue as a JSON array of hashes. Pull
    // affected rows, rewrite in place, write back. Quoted match on the
    // JSON text prevents false positives from substring overlap between
    // MD5 hex values.
    let quoted = format!("\"{}\"", old_hash);
    let mut stmt = conn.prepare_cached(
        "SELECT user_id, current_track_hash, track_hashes_json
           FROM user_play_queue
          WHERE current_track_hash = ?
             OR instr(track_hashes_json, ?) > 0",
    )?;
    let rows: Vec<(i64, Option<String>, String)> = stmt
        .query_map(rusqlite::params![old_hash, quoted], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (user_id, current_hash, queue_json) in rows {
        // Parse the JSON array, swap occurrences, serialize back. If the
        // row's JSON is corrupt we skip it rather than blowing up a scan.
        let hashes: Vec<String> = match serde_json::from_str(&queue_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let migrated: Vec<String> = hashes.into_iter()
            .map(|h| if h == old_hash { new_hash.to_string() } else { h })
            .collect();
        let new_json = serde_json::to_string(&migrated)?;
        let new_current = match current_hash {
            Some(c) if c == old_hash => Some(new_hash.to_string()),
            other => other,
        };
        conn.execute(
            "UPDATE user_play_queue
                SET current_track_hash = ?, track_hashes_json = ?
              WHERE user_id = ?",
            rusqlite::params![new_current, new_json, user_id],
        )?;
    }

    Ok(())
}

// ── Artist / Album helpers ──────────────────────────────────────────────────

fn find_or_create_artist(conn: &Connection, name: &str) -> Result<i64, rusqlite::Error> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM artists WHERE name = ?", [name], |row| row.get(0)
    ) {
        return Ok(id);
    }
    conn.execute("INSERT INTO artists (name) VALUES (?)", [name])?;
    Ok(conn.last_insert_rowid())
}

fn find_or_create_album(
    conn: &Connection, name: &str, artist_id: Option<i64>, year: Option<i64>, art: Option<&str>
) -> Result<i64, rusqlite::Error> {
    let existing: Result<i64, _> = conn.query_row(
        "SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?",
        rusqlite::params![name, artist_id, year],
        |row| row.get(0),
    );
    if let Ok(id) = existing {
        if let Some(art_file) = art {
            conn.execute(
                "UPDATE albums SET album_art_file = ? WHERE id = ? AND album_art_file IS NULL",
                rusqlite::params![art_file, id],
            )?;
        }
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO albums (name, artist_id, year, album_art_file) VALUES (?, ?, ?, ?)",
        rusqlite::params![name, artist_id, year, art],
    )?;
    Ok(conn.last_insert_rowid())
}

// ── Genre helpers ────────────────────────────────────────────────────────────

fn find_or_create_genre(conn: &Connection, name: &str) -> Result<i64, rusqlite::Error> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM genres WHERE name = ?", [name], |row| row.get(0)
    ) {
        return Ok(id);
    }
    conn.execute("INSERT INTO genres (name) VALUES (?)", [name])?;
    Ok(conn.last_insert_rowid())
}

fn set_track_genres(conn: &Connection, track_id: i64, genre_str: Option<&str>) -> Result<(), rusqlite::Error> {
    let genre_str = match genre_str {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(()),
    };

    for part in genre_str.split(&[',', ';', '/'][..]) {
        let name = part.trim();
        if name.is_empty() { continue; }
        let genre_id = find_or_create_genre(conn, name)?;
        conn.execute(
            "INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)",
            rusqlite::params![track_id, genre_id],
        )?;
    }
    Ok(())
}

// ── MD5 hash ────────────────────────────────────────────────────────────────

// ── Dual-hash: file_hash (whole file) + audio_hash (audio payload only) ────
//
// audio_hash strips tag regions so user-facing state (stars, play counts,
// bookmarks, play queue) survives tag-only edits. MUST produce the same
// output as src/db/audio-hash.js `computeHashes` — parity is enforced by
// test/audio-hash-parity.test.mjs. Any change to the byte-range logic must
// land in both implementations simultaneously.

// Feed a single [start, end) byte range into an existing md5 context.
fn feed_range(
    ctx: &mut md5::Context, file: &mut fs::File, start: u64, end: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    if end <= start { return Ok(()); }
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = end - start;
    let mut buf = [0u8; 65536];
    while remaining > 0 {
        let chunk = buf.len().min(remaining as usize);
        let n = file.read(&mut buf[..chunk])?;
        if n == 0 { break; }
        ctx.consume(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

// Hash the concatenation of a list of byte ranges. For single-range formats
// the slice has one element; for Ogg we pass one entry per audio page payload.
fn hash_ranges(
    file: &mut fs::File, ranges: &[(u64, u64)],
) -> Result<String, Box<dyn std::error::Error>> {
    let mut ctx = md5::Context::new();
    for &(start, end) in ranges {
        feed_range(&mut ctx, file, start, end)?;
    }
    Ok(format!("{:x}", ctx.compute()))
}

// MP3 & AAC (ADTS): strip ID3v2 prefix + ID3v1 suffix + APEv2 suffix.
// See src/db/audio-hash.js for the spec references — this impl mirrors
// `mp3OrAacAudioRange` byte-for-byte.
fn mp3_or_aac_audio_range(file: &mut fs::File, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 10 { return None; }

    let mut head = [0u8; 10];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut head).ok()?;

    let mut start: u64 = 0;
    if head[0] == b'I' && head[1] == b'D' && head[2] == b'3' {
        let tag_size: u64 =
            ((head[6] & 0x7f) as u64) << 21 |
            ((head[7] & 0x7f) as u64) << 14 |
            ((head[8] & 0x7f) as u64) << 7  |
             (head[9] & 0x7f) as u64;
        start = 10 + tag_size;
        if head[5] & 0x10 != 0 { start += 10; }
    }

    let mut end: u64 = file_size;
    if file_size >= 128 {
        let mut trailer = [0u8; 3];
        file.seek(SeekFrom::Start(file_size - 128)).ok()?;
        file.read_exact(&mut trailer).ok()?;
        if trailer == *b"TAG" { end = file_size - 128; }
    }

    if end >= 32 {
        let footer_at = end - 32;
        let mut full = [0u8; 32];
        file.seek(SeekFrom::Start(footer_at)).ok()?;
        if file.read_exact(&mut full).is_ok() && &full[..8] == b"APETAGEX" {
            let sz = u32::from_le_bytes([full[12], full[13], full[14], full[15]]) as u64;
            let flags = u32::from_le_bytes([full[20], full[21], full[22], full[23]]);
            let has_header = (flags & 0x8000_0000) != 0;
            let ape_total = sz + if has_header { 32 } else { 0 };
            if end >= ape_total { end -= ape_total; }
        }
    }

    if start >= end { return None; }
    Some(vec![(start, end)])
}

// FLAC: walk metadata blocks until last_flag set, then audio follows.
fn flac_audio_range(file: &mut fs::File, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 4 { return None; }
    let mut magic = [0u8; 4];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut magic).ok()?;
    if &magic != b"fLaC" { return None; }

    let mut cursor: u64 = 4;
    let mut hdr = [0u8; 4];
    loop {
        if cursor + 4 > file_size { return None; }
        file.seek(SeekFrom::Start(cursor)).ok()?;
        file.read_exact(&mut hdr).ok()?;
        let last = (hdr[0] & 0x80) != 0;
        let len: u64 = ((hdr[1] as u64) << 16) | ((hdr[2] as u64) << 8) | (hdr[3] as u64);
        cursor += 4 + len;
        if last { break; }
        if cursor > file_size { return None; }
    }
    if cursor >= file_size { return None; }
    Some(vec![(cursor, file_size)])
}

// WAV (RIFF/WAVE): walk chunks, return the `data` chunk payload. Other
// chunks (LIST/INFO, ID3, bext, iXML) are skipped.
fn wav_audio_range(file: &mut fs::File, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 12 { return None; }
    let mut hdr = [0u8; 12];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" { return None; }

    let mut cursor: u64 = 12;
    let mut chunk_hdr = [0u8; 8];
    while cursor + 8 <= file_size {
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read_exact(&mut chunk_hdr).is_err() { return None; }
        let id = &chunk_hdr[0..4];
        let size = u32::from_le_bytes([chunk_hdr[4], chunk_hdr[5], chunk_hdr[6], chunk_hdr[7]]) as u64;
        let payload_start = cursor + 8;
        let payload_end = (payload_start + size).min(file_size);
        if id == b"data" { return Some(vec![(payload_start, payload_end)]); }
        // WAV chunks are word-aligned; odd-length payloads pad with one byte.
        cursor = payload_start + size + (size & 1);
    }
    None
}

// Ogg: walk pages; hash payloads of audio pages (from first page with
// granule_position > 0 onwards). Page headers are NOT hashed — their
// page_sequence_number drifts when header pages change size.
fn ogg_audio_range(file: &mut fs::File, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 27 { return None; }
    let mut ranges = Vec::new();
    let mut audio_started = false;
    let mut cursor: u64 = 0;
    let mut page_hdr = [0u8; 27];

    while cursor + 27 <= file_size {
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read_exact(&mut page_hdr).is_err() { break; }
        if &page_hdr[0..4] != b"OggS" { break; }
        let granule = i64::from_le_bytes([
            page_hdr[6], page_hdr[7], page_hdr[8], page_hdr[9],
            page_hdr[10], page_hdr[11], page_hdr[12], page_hdr[13],
        ]);
        let page_segments = page_hdr[26] as usize;
        let mut seg_table = vec![0u8; page_segments];
        if file.read_exact(&mut seg_table).is_err() { return None; }
        let payload_size: u64 = seg_table.iter().map(|&b| b as u64).sum();
        let payload_start = cursor + 27 + page_segments as u64;
        let payload_end = payload_start + payload_size;
        if payload_end > file_size { return None; }  // truncated

        if audio_started {
            ranges.push((payload_start, payload_end));
        } else if granule > 0 {
            audio_started = true;
            ranges.push((payload_start, payload_end));
        }
        // granule == 0 or -1: pre-audio header region, skip.

        cursor = payload_end;
    }

    if ranges.is_empty() { None } else { Some(ranges) }
}

// MP4 / M4A / M4B: walk atom tree, hash `mdat` payload(s). `moov` (where
// metadata lives) is skipped automatically. Supports 64-bit extended
// sizes (size == 1) and extends-to-EOF (size == 0).
fn mp4_audio_range(file: &mut fs::File, file_size: u64) -> Option<Vec<(u64, u64)>> {
    if file_size < 8 { return None; }
    let mut ranges = Vec::new();
    let mut cursor: u64 = 0;
    let mut atom_hdr = [0u8; 16];

    while cursor + 8 <= file_size {
        let to_read = 16usize.min((file_size - cursor) as usize);
        file.seek(SeekFrom::Start(cursor)).ok()?;
        if file.read(&mut atom_hdr[..to_read]).ok()? < 8 { break; }
        let sz32 = u32::from_be_bytes([atom_hdr[0], atom_hdr[1], atom_hdr[2], atom_hdr[3]]);
        let type_bytes = &atom_hdr[4..8];

        let (header_len, atom_end): (u64, u64) = if sz32 == 1 {
            // 64-bit extended size follows at bytes 8..16.
            if to_read < 16 { break; }
            let sz64 = u64::from_be_bytes([
                atom_hdr[8], atom_hdr[9], atom_hdr[10], atom_hdr[11],
                atom_hdr[12], atom_hdr[13], atom_hdr[14], atom_hdr[15],
            ]);
            (16, cursor + sz64)
        } else if sz32 == 0 {
            (8, file_size)
        } else {
            (8, cursor + sz32 as u64)
        };
        if atom_end > file_size || atom_end < cursor + header_len { break; }

        if type_bytes == b"mdat" && atom_end > cursor + header_len {
            ranges.push((cursor + header_len, atom_end));
        }
        cursor = atom_end;
    }

    if ranges.is_empty() { None } else { Some(ranges) }
}

fn audio_ranges_for_ext(
    file: &mut fs::File, ext: &str, file_size: u64,
) -> Option<Vec<(u64, u64)>> {
    match ext {
        "mp3" | "aac"            => mp3_or_aac_audio_range(file, file_size),
        "flac"                   => flac_audio_range(file, file_size),
        "wav"                    => wav_audio_range(file, file_size),
        "ogg" | "opus"           => ogg_audio_range(file, file_size),
        "m4a" | "m4b" | "mp4"    => mp4_audio_range(file, file_size),
        _ => None,
    }
}

// ── Waveform generation (symphonia-powered) ───────────────────────────────
//
// Decodes the audio stream, downmixes to mono magnitudes, and emits NUM_BARS
// peak values (u8, 0-255). Bar i covers the frame range
// [i * n_frames / NUM_BARS, (i+1) * n_frames / NUM_BARS). Missing or zero-frame
// tracks return None; .opus is skipped because symphonia 0.5 lacks an Opus
// decoder. On any decoder/IO error we fall back to None so the scanner
// continues and the on-demand endpoint can try ffmpeg later.
fn waveform_from_symphonia(path: &Path, ext: &str) -> Option<[u8; NUM_BARS]> {
    // Symphonia doesn't ship an Opus decoder in 0.5. We want to keep the
    // binary pure-Rust (no libopus), so skip .opus here and let the
    // on-demand endpoint handle it via ffmpeg on first playback.
    if ext == "opus" { return None; }

    let file = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension(ext);

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;

    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = track.id;
    let n_frames = track.codec_params.n_frames?;
    if n_frames == 0 { return None; }
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    let mut peaks = [0f32; NUM_BARS];
    let mut frame_idx: u64 = 0;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,   // EOF or unrecoverable — whatever we have is what we get
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,   // skip corrupt packet, keep going
        };

        if sample_buf.is_none() {
            let spec = *decoded.spec();
            let capacity = decoded.capacity() as u64;
            sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
        }
        let buf = sample_buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);

        // Downmix interleaved samples to mono magnitudes and update the
        // running peak for whichever bar the current frame falls into.
        for chunk in buf.samples().chunks(channels) {
            let mut sum = 0f32;
            for &s in chunk { sum += s.abs(); }
            let mag = sum / (channels as f32);

            let bar = (frame_idx.saturating_mul(NUM_BARS as u64) / n_frames) as usize;
            if bar < NUM_BARS && mag > peaks[bar] {
                peaks[bar] = mag;
            }
            frame_idx += 1;
        }
    }

    if frame_idx == 0 { return None; }

    let mut bars = [0u8; NUM_BARS];
    for i in 0..NUM_BARS {
        bars[i] = (peaks[i].clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    Some(bars)
}

fn compute_hashes(
    filepath: &Path, ext: &str,
) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    let mut file = fs::File::open(filepath)?;
    let file_size = file.metadata()?.len();

    file.seek(SeekFrom::Start(0))?;
    let file_hash = {
        let mut ctx = md5::Context::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 { break; }
            ctx.consume(&buf[..n]);
        }
        format!("{:x}", ctx.compute())
    };

    let audio_hash = match audio_ranges_for_ext(&mut file, ext, file_size) {
        Some(ranges) if !ranges.is_empty() => Some(hash_ranges(&mut file, &ranges)?),
        _ => None,
    };

    Ok((file_hash, audio_hash))
}

// ── Album art: embedded ─────────────────────────────────────────────────────

fn save_embedded_art(pic: &lofty::picture::Picture, config: &ScanConfig) -> Option<String> {
    let data = pic.data();
    let ext = pic.mime_type().map(mime_to_ext).unwrap_or("jpeg");
    let hash = format!("{:x}", md5::compute(data));
    let filename = format!("{}.{}", hash, ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);

    if !art_path.exists() {
        fs::write(&art_path, data).ok()?;
        if config.compress_image {
            compress_album_art(data, &filename, &config.album_art_directory);
        }
    }

    Some(filename)
}

// ── Album art: directory fallback ───────────────────────────────────────────

fn check_directory_for_album_art(
    filepath: &Path,
    config: &ScanConfig,
    cache: &Mutex<HashMap<String, Option<String>>>,
) -> Option<String> {
    let dir = filepath.parent()?;
    let dir_key = dir.to_string_lossy().to_string();

    {
        let guard = cache.lock().unwrap();
        if let Some(cached) = guard.get(&dir_key) {
            return cached.clone();
        }
    }

    let mut images: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let e = file_ext(&p).to_lowercase();
                if e == "jpg" || e == "png" {
                    images.push(p);
                }
            }
        }
    }

    if images.is_empty() {
        cache.lock().unwrap().insert(dir_key, None);
        return None;
    }

    let priority = ["folder.jpg", "cover.jpg", "album.jpg", "folder.png", "cover.png", "album.png"];
    let chosen = images
        .iter()
        .find(|p| {
            p.file_name()
                .map(|n| priority.contains(&n.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .unwrap_or(&images[0]);

    let data = fs::read(chosen).ok()?;
    let pic_ext = file_ext(chosen);
    let hash = format!("{:x}", md5::compute(&data));
    let filename = format!("{}.{}", hash, pic_ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);

    let is_new = !art_path.exists();
    if is_new {
        fs::write(&art_path, &data).ok()?;
    }

    cache.lock().unwrap().insert(dir_key, Some(filename.clone()));

    if is_new && config.compress_image {
        compress_album_art(&data, &filename, &config.album_art_directory);
    }

    Some(filename)
}

// ── Image compression ───────────────────────────────────────────────────────

fn compress_album_art(data: &[u8], name: &str, art_dir: &str) {
    if let Ok(img) = image::load_from_memory(data) {
        let large = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
        let _ = large.save(Path::new(art_dir).join(format!("zl-{}", name)));
        let small = img.resize(92, 92, image::imageops::FilterType::Lanczos3);
        let _ = small.save(Path::new(art_dir).join(format!("zs-{}", name)));
    }
}

// ── Utilities ───────────────────────────────────────────────────────────────

fn file_ext(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string()
}

fn mime_to_ext(mime: &MimeType) -> &'static str {
    match mime {
        MimeType::Png => "png",
        MimeType::Jpeg => "jpeg",
        MimeType::Tiff => "tiff",
        MimeType::Bmp => "bmp",
        MimeType::Gif => "gif",
        _ => "jpeg",
    }
}

fn parse_replaygain_db(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches("dB").trim_end_matches("db").trim();
    s.parse::<f64>().ok()
}
