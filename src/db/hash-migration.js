/**
 * Hash migration for content-change rescans.
 *
 * When the scanner re-parses a file whose bytes changed (typical trigger:
 * an external ID3 tag editor), the file's MD5 changes. User-facing rows
 * that key on track_hash — user_metadata (stars, ratings, play counts),
 * user_bookmarks, user_play_queue (scalar + JSON array of hashes) — still
 * reference the old hash. This helper points them at the new one so the
 * user's state follows the file's new identity.
 *
 * Mirrored in rust-parser/src/main.rs#migrate_hash_references — the Rust
 * scanner inlines the same logic rather than cross-processing into JS.
 * Any behaviour change must be reflected in both places (and covered by
 * the unit test in test/hash-migration.test.mjs).
 */

/**
 * Migrate all user_* rows referring to oldHash over to newHash.
 *
 * @param {object} db  A node:sqlite DatabaseSync or any object exposing
 *                     `.prepare(sql)` returning something with `.run()` /
 *                     `.all()`.
 * @param {string} oldHash
 * @param {string} newHash
 * @returns {{metadata: number, bookmarks: number, queues: number}} counts of
 *          rows migrated per table.
 */
export function migrateHashReferences(db, oldHash, newHash) {
  if (!oldHash || !newHash || oldHash === newHash) {
    return { metadata: 0, bookmarks: 0, queues: 0 };
  }

  const metaResult = db.prepare(
    'UPDATE user_metadata SET track_hash = ? WHERE track_hash = ?'
  ).run(newHash, oldHash);

  const bmResult = db.prepare(
    'UPDATE user_bookmarks SET track_hash = ? WHERE track_hash = ?'
  ).run(newHash, oldHash);

  // user_play_queue stores the queue as a JSON array plus a scalar
  // current_track_hash. Pull affected rows, swap occurrences in both
  // positions, write back. Quoting the hash with "…" in the instr()
  // filter avoids false-positive substring matches across MD5 hex values
  // (MD5s are 32-char; collisions as substrings are astronomically
  // unlikely but cheap to exclude).
  const rows = db.prepare(
    `SELECT user_id, current_track_hash, track_hashes_json
       FROM user_play_queue
      WHERE current_track_hash = ?
         OR instr(track_hashes_json, ?) > 0`
  ).all(oldHash, `"${oldHash}"`);

  let queuesUpdated = 0;
  const updateStmt = db.prepare(
    `UPDATE user_play_queue
        SET current_track_hash = ?, track_hashes_json = ?
      WHERE user_id = ?`
  );
  for (const row of rows) {
    let hashes;
    try { hashes = JSON.parse(row.track_hashes_json || '[]'); }
    catch { continue; }  // corrupt row — skip rather than block the scan
    if (!Array.isArray(hashes)) { continue; }
    const migrated = hashes.map(h => h === oldHash ? newHash : h);
    const newCurrent = row.current_track_hash === oldHash ? newHash : row.current_track_hash;
    updateStmt.run(newCurrent, JSON.stringify(migrated), row.user_id);
    queuesUpdated++;
  }

  return {
    metadata:  metaResult.changes | 0,
    bookmarks: bmResult.changes | 0,
    queues:    queuesUpdated,
  };
}
