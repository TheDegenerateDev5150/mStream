use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue};
use lofty::picture::MimeType;
use rusqlite::Connection;
use serde::Deserialize;
use walkdir::WalkDir;

// ── Config (matches what task-queue.js passes) ──────────────────────────────

#[derive(Deserialize)]
struct ScanConfig {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "libraryId")]
    library_id: i64,
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
    #[serde(rename = "scanBatchSize", default = "default_batch_size")]
    scan_batch_size: u64,
}

fn default_batch_size() -> u64 { 100 }

// ── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;

    let dir_art_cache: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());

    println!("Scanning {}...", config.directory);

    let entries: Vec<walkdir::DirEntry> = WalkDir::new(&config.directory)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .collect();

    let mut file_count = 0u64;
    let mut batch_count = 0u64;
    let batch_size = config.scan_batch_size;

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
                batch_count += 1;
                if batch_count >= batch_size {
                    conn.execute_batch("COMMIT; BEGIN")?;
                    batch_count = 0;
                }
            }
            Ok(false) => {} // skipped (unchanged)
            Err(e) => {
                eprintln!("Warning: failed to process {}: {}", entry.path().display(), e);
            }
        }
    }

    conn.execute_batch("COMMIT")?;

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

    println!("Scan complete: {} files processed, {} stale entries removed", file_count, deleted);
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

    // Check if file exists and is unchanged
    let existing: Option<(i64, i64)> = conn.prepare_cached(
        "SELECT id, modified FROM tracks WHERE filepath = ? AND library_id = ?"
    )?.query_row(rusqlite::params![rel_path, config.library_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    }).ok();

    if let Some((id, existing_mod)) = existing {
        if existing_mod == mod_time {
            // Unchanged — just update scan_id
            conn.execute("UPDATE tracks SET scan_id = ? WHERE id = ?",
                rusqlite::params![config.scan_id, id])?;
            return Ok(false);
        }
        // Modified — delete old record
        conn.execute("DELETE FROM tracks WHERE id = ?", rusqlite::params![id])?;
    }

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

    match Probe::open(filepath).and_then(|p| p.read()) {
        Ok(tagged_file) => {
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

    let hash = calculate_hash(filepath)?;

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
         disc_number, year, format, file_hash, album_art_file, genre, replaygain_track_db,
         modified, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            rel_path, config.library_id, title, artist_id, album_id,
            track_num, disc_num, year, ext, hash,
            aa_file, genre, rg_track_db, mod_time, config.scan_id
        ],
    )?;

    let track_id = conn.last_insert_rowid();
    set_track_genres(conn, track_id, genre.as_deref())?;

    Ok(true)
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

fn calculate_hash(filepath: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let mut file = fs::File::open(filepath)?;
    let mut ctx = md5::Context::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        ctx.consume(&buf[..n]);
    }
    Ok(format!("{:x}", ctx.compute()))
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
