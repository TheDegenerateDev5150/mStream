/**
 * User-album-stars migration on album-id changes.
 *
 * When V17 lands and the scanner reprocesses a compilation, the N
 * fragmented albums rows (one per track-artist) collapse into one
 * canonical row keyed on album_artist_id. Tracks whose album_id
 * previously pointed at a fragment now point at the canonical row.
 *
 * user_album_stars.album_id is an FK to albums. Left untouched, the
 * stale-fragment cleanup at end of scan CASCADE-deletes user stars
 * pointing at fragments — so starred compilations would silently
 * lose their star. This helper re-maps stars from old → new album_id
 * before fragments get swept, preserving user state.
 *
 * Mirrored in rust-parser/src/main.rs (migrate_album_stars). Any
 * behavioural change must land in both places simultaneously.
 */

/**
 * Re-map user_album_stars rows from one album id to another. Idempotent
 * (re-running against the same mapping is a no-op). Handles the case
 * where a user already starred the target album — in that case the
 * earliest starred_at wins (union semantics).
 *
 * @param {object} db  node:sqlite DatabaseSync (or compatible)
 * @param {number} oldAlbumId
 * @param {number} newAlbumId
 * @returns {number}   count of rows migrated
 */
export function migrateAlbumStars(db, oldAlbumId, newAlbumId) {
  if (!Number.isFinite(oldAlbumId) || !Number.isFinite(newAlbumId)) { return 0; }
  if (oldAlbumId === newAlbumId) { return 0; }

  const stars = db.prepare(
    'SELECT user_id, starred_at FROM user_album_stars WHERE album_id = ?'
  ).all(oldAlbumId);

  if (!stars.length) { return 0; }

  // Union the old star into the new (keeping the earlier starred_at).
  const upsert = db.prepare(`
    INSERT INTO user_album_stars (user_id, album_id, starred_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, album_id) DO UPDATE SET
      starred_at = MIN(user_album_stars.starred_at, excluded.starred_at)
  `);
  const deleteOld = db.prepare(
    'DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?'
  );

  let migrated = 0;
  for (const s of stars) {
    upsert.run(s.user_id, newAlbumId, s.starred_at);
    deleteOld.run(s.user_id, oldAlbumId);
    migrated++;
  }
  return migrated;
}
