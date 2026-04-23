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
use rusqlite::{Connection, OptionalExtension};
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

    // Hidden developer/test subcommand: `rust-parser --extract-lyrics <path>`
    // prints the four lyrics column values as JSON on stdout. Used by
    // test/lyrics-parity.test.mjs to confirm the JS extractor
    // (src/db/lyrics-extraction.js) and the Rust extractor below
    // produce byte-identical results for the same input. Any drift
    // means a track scanned by one scanner looks different from a
    // track scanned by the other — silent divergence on libraries
    // that mix-and-match (dev + prebuilt binary, different versions).
    if args.len() == 3 && args[1] == "--extract-lyrics" {
        let p = Path::new(&args[2]);
        match extract_lyrics_for_cli(p) {
            Ok((embedded, synced, lang, sidecar_mtime)) => {
                // Manual JSON serialisation (same reason as --audio-hash:
                // one-line output, no serde dance). All four fields emit
                // as `null` when absent so the consumer can JSON.parse
                // and compare with ===.
                let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"")
                    .replace('\n', "\\n").replace('\r', "\\r");
                let j = |v: &Option<String>| match v {
                    Some(s) => format!("\"{}\"", esc(s)),
                    None    => "null".to_string(),
                };
                let mtime_json = match sidecar_mtime {
                    Some(n) => format!("{}", n),
                    None    => "null".to_string(),
                };
                println!("{{\"lyricsEmbedded\":{},\"lyricsSyncedLrc\":{},\"lyricsLang\":{},\"lyricsSidecarMtime\":{}}}",
                    j(&embedded), j(&synced), j(&lang), mtime_json);
                return;
            }
            Err(e) => {
                eprintln!("extract_lyrics failed: {}", e);
                std::process::exit(2);
            }
        }
    }

    // Hidden developer/test subcommand: `rust-parser --waveform <path>`
    // prints `{"bars":"<hex of 800 bytes>"}` on success or `{"bars":null}`
    // when no waveform can be produced (e.g. .opus, where symphonia 0.5
    // has no decoder). Used by test/waveform.test.mjs to exercise the
    // decoder across every supported format without standing up a full
    // scan's worth of DB scaffolding.
    if args.len() == 3 && args[1] == "--waveform" {
        let p = Path::new(&args[2]);
        let ext = file_ext(p).to_lowercase();
        match waveform_from_symphonia(p, &ext) {
            Some(bars) => {
                // Hex instead of base64: trivial to produce without extra
                // crates, trivial for the JS test to decode, fixed-length
                // 1600 chars so a bug that truncates or pads shows up
                // immediately.
                let mut hex = String::with_capacity(NUM_BARS * 2);
                for b in bars.iter() { hex.push_str(&format!("{:02x}", b)); }
                println!("{{\"bars\":\"{}\"}}", hex);
            }
            None => {
                println!("{{\"bars\":null}}");
            }
        }
        return;
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

    // Clean up orphaned artists and albums. An artist is kept if ANY of:
    //   - tracks.artist_id references it (primary track artist)
    //   - albums.artist_id references it (primary album artist)
    //   - track_artists M2M references it (featured artists)
    //   - album_artists M2M references it (co-credited album artists)
    // Missing the M2M checks would orphan featured/credited artists whose
    // only reference is via the V17 M2M tables — cascade-deleting their
    // M2M rows and breaking `song.artists` for collabs.
    conn.execute_batch(
        "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
         DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks  WHERE artist_id IS NOT NULL)
                                AND id NOT IN (SELECT DISTINCT artist_id FROM albums  WHERE artist_id IS NOT NULL)
                                AND id NOT IN (SELECT DISTINCT artist_id FROM track_artists)
                                AND id NOT IN (SELECT DISTINCT artist_id FROM album_artists);
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
    // Also captures the existing track's album_id so we can migrate
    // user_album_stars on the V17 compilation-collapse path. lyrics
    // sidecar mtime (V19) lets us re-read a track whose audio file
    // didn't change but whose .lrc / .txt sidecar got edited.
    let existing: Option<(i64, i64, String, String, Option<i64>, Option<i64>)> = conn.prepare_cached(
        "SELECT id, modified, file_hash, audio_hash, album_id, lyrics_sidecar_mtime
           FROM tracks WHERE filepath = ? AND library_id = ?"
    )?.query_row(rusqlite::params![rel_path, config.library_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    }).ok();

    // Probe sidecars BEFORE the fast-path decision so a drift between
    // the stored mtime and what's on disk triggers a re-read.
    let current_sidecar_mtime = sidecar_mtime(filepath);

    // NOTE: we intentionally do NOT DELETE the old tracks row before
    // tag parsing. A mid-parse failure used to leave the DELETE
    // committed without a matching INSERT on the next batch flush,
    // orphaning user_metadata / bookmarks / play-queue rows keyed off
    // the old hash. The INSERT OR REPLACE below handles the row swap
    // atomically — the old row (and its cascaded track_artists /
    // track_genres) only disappears when the new one is ready to take
    // its place.
    let (old_hash, old_audio_hash, old_album_id): (Option<String>, Option<String>, Option<i64>) =
        if let Some((id, existing_mod, old_file, old_audio, old_album, old_sidecar_mtime)) = &existing {
            let audio_unchanged = *existing_mod == mod_time;
            let sidecar_drifted = *old_sidecar_mtime != current_sidecar_mtime;
            if audio_unchanged && !config.force_rescan && !sidecar_drifted {
                // Unchanged — just update scan_id
                conn.execute("UPDATE tracks SET scan_id = ? WHERE id = ?",
                    rusqlite::params![config.scan_id, id])?;
                return Ok(false);
            }
            (
                if old_file.is_empty()  { None } else { Some(old_file.clone())  },
                if old_audio.is_empty() { None } else { Some(old_audio.clone()) },
                *old_album,
            )
        } else {
            (None, None, None)
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
    // V17: multi-artist / compilation extraction. Mirrors the JS helper
    // in src/db/artist-extraction.js — same tag aliases, same delimiter
    // list, same fallback rules.
    let mut album_artist_tag: Option<String> = None;
    let mut album_artists_multi: Vec<String> = Vec::new();
    let mut track_artists_multi: Vec<String> = Vec::new();
    let mut is_compilation = false;

    // V19: lyrics. Populated by the lofty block below from ItemKey::Lyrics
    // + ItemKey::LyricsLanguage (unsynced + language), then overlaid by
    // the sibling `<basename>.lrc` / `.txt` sidecar probe. See
    // src/db/lyrics-extraction.js for the JS mirror — same precedence,
    // same language normalisation.
    let mut lyrics_embedded: Option<String> = None;
    let mut lyrics_synced_lrc: Option<String> = None;
    let mut lyrics_lang: Option<String> = None;

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

                // Album artist (single-value scalar tag, may need splitting).
                album_artist_tag = tag.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string());

                // Multi-value ARTIST / ALBUMARTIST: get every item (each item
                // may be Text or Locator). Honour multi-value natively.
                for item in tag.get_items(&ItemKey::AlbumArtist) {
                    if let ItemValue::Text(s) = item.value() {
                        album_artists_multi.push(s.to_string());
                    }
                }
                for item in tag.get_items(&ItemKey::TrackArtist) {
                    if let ItemValue::Text(s) = item.value() {
                        track_artists_multi.push(s.to_string());
                    }
                }

                // Compilation flag — ID3v2 TCMP, MP4 cpil, Vorbis COMPILATION,
                // WMA WM/IsCompilation. lofty normalises all via FlagCompilation.
                is_compilation = tag.get_string(&ItemKey::FlagCompilation)
                    .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                    .unwrap_or(false);

                // V19: embedded lyrics. lofty exposes USLT / SYLT / Vorbis
                // LYRICS / MP4 ©lyr / APE Lyrics under ItemKey::Lyrics. We
                // have no easy way to pull ID3v2 SYLT structured timings
                // through the unified API (lofty treats it as opaque
                // non-text), so for synced we lean on sidecar .lrc files —
                // which is by far the more common distribution channel
                // anyway. Language comes from ItemKey::Language when
                // present (ID3v2 USLT's 3-char field).
                if let Some(t) = tag.get_string(&ItemKey::Lyrics) {
                    let s = t.trim();
                    if !s.is_empty() {
                        if looks_like_lrc(s) {
                            lyrics_synced_lrc = Some(s.to_string());
                        } else {
                            lyrics_embedded = Some(s.to_string());
                        }
                    }
                }
                if let Some(lang) = tag.get_string(&ItemKey::Language) {
                    lyrics_lang = normalise_lang(lang);
                }
            }
        }
        Err(e) => {
            eprintln!("Warning: metadata parse error on {}: {}", filepath.display(), e);
        }
    }

    // Resolve final artist lists using the shared fallback rules.
    let album_artists = resolve_album_artists(
        album_artist_tag.as_deref(),
        &album_artists_multi,
    );
    let track_artists = resolve_track_artists(
        artist.as_deref(),
        &track_artists_multi,
    );

    // V19: sidecar lyrics — only consulted when we haven't already got a
    // synced variant from the tag. Mirrors the JS extractor's precedence
    // (embedded synced > sidecar .lrc > embedded plain > sidecar .txt).
    if lyrics_synced_lrc.is_none() {
        if let Some((text, lang)) = read_lrc_sidecar(filepath) {
            lyrics_synced_lrc = Some(text);
            if lyrics_lang.is_none() {
                lyrics_lang = lang.and_then(|l| normalise_lang(&l));
            }
        }
    }
    if lyrics_synced_lrc.is_none() && lyrics_embedded.is_none() {
        if let Some(text) = read_txt_sidecar(filepath) {
            if looks_like_lrc(&text) {
                lyrics_synced_lrc = Some(text);
            } else {
                lyrics_embedded = Some(text);
            }
        }
    }
    // sidecar_mtime_val: the probe-time value is what we store, whether
    // or not we ended up reading those bytes. The DB stores "newest
    // sidecar mtime seen" — a tag-only track whose sibling later gains
    // an .lrc still triggers re-read on the next scan.


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

    // Resolve track-artist ids (primary first) and album-artist ids.
    let primary_track_artist_name = track_artists.first().cloned()
        .or_else(|| artist.clone());
    let primary_track_artist_id = match primary_track_artist_name.as_deref() {
        Some(name) if !name.is_empty() => Some(find_or_create_artist(conn, name)?),
        _ => None,
    };
    let mut album_artist_ids: Vec<i64> = Vec::new();
    for name in &album_artists {
        if !name.is_empty() {
            album_artist_ids.push(find_or_create_artist(conn, name)?);
        }
    }

    // Fallback chain for the primary album-artist (what goes in albums.artist_id):
    //   1. First ALBUMARTIST value, if present.
    //   2. Various Artists seed, if compilation flag is set.
    //   3. Primary track artist.
    let primary_album_artist_id = if !album_artist_ids.is_empty() {
        Some(album_artist_ids[0])
    } else if is_compilation {
        find_various_artists(conn).ok().flatten().or(primary_track_artist_id)
    } else {
        primary_track_artist_id
    };

    // Find or create album
    let album_id = match &album {
        Some(name) => {
            let aid = find_or_create_album(
                conn, name, primary_album_artist_id, year, aa_file.as_deref(),
                album_artist_tag.as_deref(), is_compilation,
            )?;
            Some(aid)
        }
        None => None,
    };

    // Insert track
    conn.execute(
        "INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
         disc_number, year, duration, format, file_hash, audio_hash, album_art_file, genre,
         replaygain_track_db, sample_rate, channels, bit_depth,
         lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime,
         modified, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            rel_path, config.library_id, title, primary_track_artist_id, album_id,
            track_num, disc_num, year, duration_sec, ext, hash, audio_hash,
            aa_file, genre, rg_track_db, sample_rate, channels, bit_depth,
            lyrics_embedded, lyrics_synced_lrc, lyrics_lang, current_sidecar_mtime,
            mod_time, config.scan_id
        ],
    )?;

    let track_id = conn.last_insert_rowid();
    set_track_genres(conn, track_id, genre.as_deref())?;

    // V17: populate M2M. Album-artists — INSERT OR IGNORE across multiple
    // tracks sharing the same album. Fall back to the primary album-artist
    // id so the M2M isn't empty for legacy single-artist albums.
    if let Some(aid) = album_id {
        let m2m_ids: Vec<i64> = if !album_artist_ids.is_empty() {
            album_artist_ids.clone()
        } else {
            primary_album_artist_id.into_iter().collect()
        };
        for (i, artist_fk) in m2m_ids.iter().enumerate() {
            conn.execute(
                "INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position)
                 VALUES (?, ?, 'main', ?)",
                rusqlite::params![aid, artist_fk, i as i64],
            )?;
        }
    }

    // Track-artists — clear first (defensive; REPLACE above should have
    // cascaded, but a partial-run rescan could leave orphans). Primary is
    // role='main'; any additional collaborators are 'featured' in tag order.
    conn.execute("DELETE FROM track_artists WHERE track_id = ?",
        rusqlite::params![track_id])?;
    let mut track_artist_ids: Vec<i64> = Vec::new();
    for name in &track_artists {
        if !name.is_empty() {
            track_artist_ids.push(find_or_create_artist(conn, name)?);
        }
    }
    if track_artist_ids.is_empty() {
        if let Some(id) = primary_track_artist_id { track_artist_ids.push(id); }
    }
    for (i, artist_fk) in track_artist_ids.iter().enumerate() {
        let role = if i == 0 { "main" } else { "featured" };
        conn.execute(
            "INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
             VALUES (?, ?, ?, ?)",
            rusqlite::params![track_id, artist_fk, role, i as i64],
        )?;
    }

    // Migrate user_* rows to the new canonical identity. Canonical = audio_hash
    // when present, file_hash otherwise. A tag edit keeps audio_hash stable,
    // so the common case is a no-op; migration only runs on real content
    // change or on the transition from file-hash-only rows to audio_hash rows.
    let new_canon = audio_hash.clone().unwrap_or_else(|| hash.clone());
    let old_canon = old_audio_hash.clone().unwrap_or_else(|| old_hash.clone().unwrap_or_default());
    if !old_canon.is_empty() && old_canon != new_canon {
        migrate_hash_references(conn, &old_canon, &new_canon)?;
    }

    // V17: album-stars migration on compilation-collapse.
    if let (Some(old), Some(new)) = (old_album_id, album_id) {
        if old != new {
            migrate_album_stars(conn, old, new)?;
        }
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
    conn: &Connection, name: &str, artist_id: Option<i64>, year: Option<i64>,
    art: Option<&str>, album_artist_display: Option<&str>, compilation: bool,
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
        // Re-asserting display + compilation keeps them fresh on rescan.
        conn.execute(
            "UPDATE albums SET album_artist = COALESCE(?, album_artist), compilation = ? WHERE id = ?",
            rusqlite::params![album_artist_display, compilation as i64, id],
        )?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO albums (name, artist_id, year, album_art_file, album_artist, compilation)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![name, artist_id, year, art, album_artist_display, compilation as i64],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Return the id of the seeded "Various Artists" row, if any. Used by
/// the album-artist fallback chain when COMPILATION=1 is set but no
/// ALBUMARTIST tag is present.
fn find_various_artists(conn: &Connection) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(
        "SELECT id FROM artists WHERE name = 'Various Artists' LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    ).optional()
}

/// Re-map user_album_stars rows from an old album id to a new one.
/// Used when a compilation collapses from N fragmented rows into a
/// single canonical row on rescan. Mirrors the JS migrateAlbumStars
/// helper in src/db/album-migration.js — same union semantics (earlier
/// starred_at wins when the user already had a star on the target).
fn migrate_album_stars(
    conn: &Connection, old_album_id: i64, new_album_id: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    if old_album_id == new_album_id { return Ok(()); }
    let mut stmt = conn.prepare(
        "SELECT user_id, starred_at FROM user_album_stars WHERE album_id = ?"
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map(rusqlite::params![old_album_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    for (user_id, starred_at) in rows {
        conn.execute(
            "INSERT INTO user_album_stars (user_id, album_id, starred_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id, album_id) DO UPDATE SET
               starred_at = MIN(user_album_stars.starred_at, excluded.starred_at)",
            rusqlite::params![user_id, new_album_id, starred_at],
        )?;
        conn.execute(
            "DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?",
            rusqlite::params![user_id, old_album_id],
        )?;
    }
    Ok(())
}

// ── Artist-list extraction helpers (mirror src/db/artist-extraction.js) ────

const ARTIST_DELIMITERS: &[&str] = &[
    " / ",
    " feat. ",
    " feat ",
    " ft. ",
    " ft ",
    "; ",
];

fn split_artist_string(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = vec![s.to_string()];
    for delim in ARTIST_DELIMITERS {
        let mut next = Vec::new();
        for p in &parts {
            if p.contains(delim) {
                for piece in p.split(delim) { next.push(piece.to_string()); }
            } else {
                next.push(p.clone());
            }
        }
        parts = next;
    }
    parts.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Returns the canonical ordered list of track-artist names. Each
/// value (whether from a multi-value tag or a single scalar) is split
/// on the delimiter list so `"A feat. B"` always becomes `["A", "B"]`
/// regardless of how the user tagged it. Duplicates dedup'd, order
/// preserved (first-seen wins).
fn resolve_artists_list(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    let values: Vec<String> = if !multi.is_empty() {
        multi.to_vec()
    } else {
        scalar.map(|s| vec![s.to_string()]).unwrap_or_default()
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for v in &values {
        for piece in split_artist_string(v) {
            if !seen.contains(&piece) {
                seen.insert(piece.clone());
                out.push(piece);
            }
        }
    }
    out
}

fn resolve_track_artists(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    resolve_artists_list(scalar, multi)
}

fn resolve_album_artists(scalar: Option<&str>, multi: &[String]) -> Vec<String> {
    resolve_artists_list(scalar, multi)
}

// ── Lyrics helpers (V19) ────────────────────────────────────────────────────
//
// Mirrors src/db/lyrics-extraction.js — keep the filename probe order
// and the language normalisation table byte-identical. Any change here
// MUST land on the JS side too.

const LYRICS_LANG_PROBE: &[&str] = &[
    "", "en", "eng", "ja", "jpn", "zh", "zho", "ko", "kor",
    "de", "deu", "fr", "fra", "es", "spa", "it", "ita",
    "pt", "por", "ru", "rus",
];

fn normalise_lang(raw: &str) -> Option<String> {
    let s = raw.trim().to_lowercase();
    if s.is_empty() { return None; }
    if s.len() == 2 { return Some(s); }
    let mapped = match s.as_str() {
        "eng" => "en", "jpn" => "ja", "zho" => "zh", "kor" => "ko",
        "deu" => "de", "fra" => "fr", "spa" => "es", "ita" => "it",
        "por" => "pt", "rus" => "ru", "ara" => "ar", "hin" => "hi",
        _ => return Some(s),
    };
    Some(mapped.to_string())
}

// Quick "is this LRC?" heuristic — matches any line whose first
// non-whitespace run is a `[mm:ss]` or `[mm:ss.xx]` timestamp.
fn looks_like_lrc(text: &str) -> bool {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('[') { continue; }
        // Walk after the '['; we need `digit(s):digit(2)(.digits)?]`.
        let after = &trimmed[1..];
        let colon = match after.find(':') { Some(i) => i, None => continue };
        let mm = &after[..colon];
        if mm.is_empty() || !mm.chars().all(|c| c.is_ascii_digit()) { continue; }
        let rest = &after[colon + 1..];
        let close = match rest.find(']') { Some(i) => i, None => continue };
        let ss = &rest[..close];
        let ss_digits = ss.bytes().take_while(|b| b.is_ascii_digit()).count();
        if ss_digits >= 1 { return true; }
    }
    false
}

// Newest mtime across `<base>.lrc`, `<base>.<lang>.lrc`, `<base>.txt`
// siblings, in ms epoch. None if no sidecar exists. Called by both
// the fast-path drift check (early in scan_file) and the full probe.
fn sidecar_mtime(audio_path: &Path) -> Option<i64> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    let mut newest: Option<i64> = None;
    let push = |candidate: PathBuf, newest: &mut Option<i64>| {
        if let Ok(meta) = fs::metadata(&candidate) {
            if meta.is_file() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        let ms = dur.as_millis() as i64;
                        if newest.map(|n| ms > n).unwrap_or(true) { *newest = Some(ms); }
                    }
                }
            }
        }
    };
    for suffix in LYRICS_LANG_PROBE {
        let name = if suffix.is_empty() {
            format!("{}.lrc", base)
        } else {
            format!("{}.{}.lrc", base, suffix)
        };
        push(dir.join(name), &mut newest);
    }
    push(dir.join(format!("{}.txt", base)), &mut newest);
    newest
}

// Max sidecar size we're willing to read + store. Mirrors the JS
// helper (src/db/lyrics-extraction.js SIDECAR_MAX_BYTES). Real .lrc
// files are under 10KB; oversized sidecars are treated as "no
// sidecar" with a warning.
const SIDECAR_MAX_BYTES: u64 = 256 * 1024;

// Read a file at `path`, bailing on oversized content or read errors
// the same way the JS helper does. Returns the file contents (BOM-
// stripped) or None.
fn read_sidecar(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() { return None; }
    if meta.len() > SIDECAR_MAX_BYTES {
        eprintln!(
            "Warning: ignoring oversized lyrics sidecar ({} bytes, max {}): {}",
            meta.len(), SIDECAR_MAX_BYTES, path.display(),
        );
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let clean = if text.starts_with('\u{FEFF}') { text[3..].to_string() } else { text };
    Some(clean)
}

// Return (contents, inferred-language) for the first matching sidecar.
// BOM is stripped — Windows LRC editors add one and it breaks the first
// line's timestamp parse.
fn read_lrc_sidecar(audio_path: &Path) -> Option<(String, Option<String>)> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    for suffix in LYRICS_LANG_PROBE {
        let (name, lang) = if suffix.is_empty() {
            (format!("{}.lrc", base), None)
        } else {
            (format!("{}.{}.lrc", base, suffix), Some((*suffix).to_string()))
        };
        if let Some(clean) = read_sidecar(&dir.join(&name)) {
            if !clean.trim().is_empty() {
                return Some((clean, lang));
            }
        }
    }
    None
}

fn read_txt_sidecar(audio_path: &Path) -> Option<String> {
    let dir = audio_path.parent()?;
    let base = audio_path.file_stem()?.to_string_lossy().to_string();
    if let Some(clean) = read_sidecar(&dir.join(format!("{}.txt", base))) {
        if !clean.trim().is_empty() { return Some(clean); }
    }
    None
}

// Standalone re-implementation of the scanner's lyrics extraction
// path, used by the `--extract-lyrics` CLI subcommand for the
// JS↔Rust parity test. Returns the four column values without
// touching a DB. MUST stay byte-identical with the scan-path logic
// above; any change to ordering or precedence belongs in both places.
fn extract_lyrics_for_cli(audio_path: &Path)
    -> Result<(Option<String>, Option<String>, Option<String>, Option<i64>), Box<dyn std::error::Error>>
{
    let mut embedded: Option<String> = None;
    let mut synced:   Option<String> = None;
    let mut lang:     Option<String> = None;

    // Pass 1: embedded tags (mirror of the in-scan block). Uses the
    // same lofty ItemKey values so USLT / Vorbis LYRICS / MP4 ©lyr /
    // APE Lyrics all normalise. Relaxed parse so partial-broken tags
    // don't drop the whole file.
    let parse_opts = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    if let Ok(tagged) = Probe::open(audio_path).and_then(|p| p.options(parse_opts).read()) {
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.get_string(&ItemKey::Lyrics) {
                let s = t.trim();
                if !s.is_empty() {
                    if looks_like_lrc(s) { synced   = Some(s.to_string()); }
                    else                 { embedded = Some(s.to_string()); }
                }
            }
            if let Some(l) = tag.get_string(&ItemKey::Language) {
                lang = normalise_lang(l);
            }
        }
    }

    // Pass 2: sidecars — probe only when we don't already have the
    // better variant. Same precedence as the in-scan block.
    let mtime = sidecar_mtime(audio_path);
    if synced.is_none() {
        if let Some((text, suffix_lang)) = read_lrc_sidecar(audio_path) {
            synced = Some(text);
            if lang.is_none() {
                lang = suffix_lang.and_then(|l| normalise_lang(&l));
            }
        }
    }
    if synced.is_none() && embedded.is_none() {
        if let Some(text) = read_txt_sidecar(audio_path) {
            if looks_like_lrc(&text) { synced   = Some(text); }
            else                      { embedded = Some(text); }
        }
    }

    Ok((embedded, synced, lang, mtime))
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
// peak values (u8, 0-255). .opus is skipped because symphonia 0.5 lacks an
// Opus decoder. On any decoder/IO error we fall back to None so the scanner
// continues and the on-demand endpoint can try ffmpeg later.
//
// Two decode strategies:
//   (a) Streaming — when track.codec_params.n_frames is populated, map each
//       decoded frame directly to its bar by index (bar = frame_idx * N / total).
//       Memory: O(1). Used for most formats (MP3, FLAC, Ogg Vorbis, AAC/M4A).
//   (b) Buffered — when n_frames is None (notably WAV, where symphonia's
//       format reader doesn't populate it), collect mono magnitudes into a
//       Vec and bin by the actual count at the end. Memory: O(n_frames).
//       Capped at MAX_BUFFERED_FRAMES to keep worst-case memory bounded on
//       very long WAV files; past that we truncate.
const MAX_BUFFERED_FRAMES: usize = 30 * 1024 * 1024;  // ~10 min at 48 kHz
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
    let n_frames = track.codec_params.n_frames;   // None → buffered path
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    let mut peaks = [0f32; NUM_BARS];
    let mut buffered: Vec<f32> = Vec::new();
    let mut frame_idx: u64 = 0;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut truncated = false;

    'outer: loop {
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

        // Downmix interleaved samples to mono magnitudes. In the streaming
        // case (n_frames known) update the running peak for each bar
        // directly; in the buffered case collect into a Vec for later
        // binning.
        for chunk in buf.samples().chunks(channels) {
            let mut sum = 0f32;
            for &s in chunk { sum += s.abs(); }
            let mag = sum / (channels as f32);

            match n_frames {
                Some(total) if total > 0 => {
                    let bar = (frame_idx.saturating_mul(NUM_BARS as u64) / total) as usize;
                    if bar < NUM_BARS && mag > peaks[bar] {
                        peaks[bar] = mag;
                    }
                }
                _ => {
                    if buffered.len() >= MAX_BUFFERED_FRAMES {
                        truncated = true;
                        break 'outer;
                    }
                    buffered.push(mag);
                }
            }
            frame_idx += 1;
        }
    }

    // Guard against symphonia emitting zero frames (unsupported codec that
    // probed OK but decoded empty). Distinguish from the buffered-truncated
    // path, which does have data.
    if frame_idx == 0 && !truncated { return None; }

    // If we went the buffered route, bin now that we know the true length.
    if n_frames.is_none() || n_frames == Some(0) {
        let total = buffered.len();
        if total == 0 { return None; }
        for i in 0..NUM_BARS {
            let start = i * total / NUM_BARS;
            let end = ((i + 1) * total / NUM_BARS).max(start + 1).min(total);
            let mut peak = 0f32;
            for &m in &buffered[start..end] {
                if m > peak { peak = m; }
            }
            peaks[i] = peak;
        }
    }

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
