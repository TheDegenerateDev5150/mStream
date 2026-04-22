/**
 * Per-file artist tag extraction for the scanner.
 *
 * Parses the metadata output of music-metadata into a structured
 * {trackArtists, albumArtists, isCompilation, displays} shape consumed
 * by src/db/scanner.mjs. A byte-identical Rust mirror lives in
 * rust-parser/src/main.rs (see extract_artists there). Any change to
 * the fallback rules or the delimiter list MUST land in both.
 *
 * Tag alias sources are taken verbatim from Navidrome's `mappings.yaml`
 * so mStream's behaviour matches a widely-deployed reference. Split
 * delimiters are likewise Navidrome's defaults — the order matters
 * (longest / most-specific first) because we do a sequential replace.
 */

// Delimiters used to split a single-valued ARTIST tag into multiple
// entries. Applied only to scalar values — multi-valued tags (Vorbis
// plural ARTIST, ID3v2.4) are honoured natively.
const ARTIST_DELIMITERS = [
  ' / ',
  ' feat. ',
  ' feat ',
  ' ft. ',
  ' ft ',
  '; ',
];

// Split a single scalar artist string on the Navidrome-default list.
// Returns a clean array (trimmed, empties dropped).
function splitArtistString(s) {
  if (!s) { return []; }
  let parts = [String(s)];
  for (const delim of ARTIST_DELIMITERS) {
    const next = [];
    for (const p of parts) {
      if (p.includes(delim)) {
        for (const piece of p.split(delim)) { next.push(piece); }
      } else {
        next.push(p);
      }
    }
    parts = next;
  }
  return parts.map(p => p.trim()).filter(Boolean);
}

// Normalise a multi-value tag (array) or scalar to a trimmed array.
// For each element — whether it arrived as an array entry or as a
// scalar — run splitArtistString so "A feat. B" always becomes ["A",
// "B"] regardless of whether it was tagged as one long string or as
// a single multi-value entry. Matches Navidrome's tag-aliases-plus-
// delimiter-split behaviour (mappings.yaml).
function normaliseArtistTag(raw) {
  if (raw == null) { return []; }
  const values = Array.isArray(raw)
    ? raw.map(v => (v == null ? '' : String(v)))
    : [String(raw)];
  const out = [];
  for (const v of values) {
    for (const piece of splitArtistString(v)) { out.push(piece); }
  }
  // Deduplicate while preserving order (first-seen wins).
  const seen = new Set();
  return out.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}

/**
 * Extract structured artist info from a music-metadata `common` object.
 *
 * @param {object} common  parsed.common from music-metadata.parseFile
 * @returns {{
 *   trackArtists:       string[],   // primary first, featured after
 *   albumArtists:       string[],   // ALBUMARTIST values or []
 *   isCompilation:      boolean,    // TCMP / cpil / compilation tag truthy
 *   trackArtistDisplay: string,     // raw single-valued tag as string
 *   albumArtistDisplay: string,     // raw single-valued tag (or null)
 * }}
 */
export function extractArtists(common) {
  // music-metadata exposes:
  //   common.artist       — scalar display string (joined)
  //   common.artists      — array, multi-value when present
  //   common.albumartist  — scalar display string
  //   common.albumartists — array, multi-value when present
  //   common.compilation  — boolean normalised from TCMP/cpil/etc.
  const trackArtists = common.artists && common.artists.length
    ? normaliseArtistTag(common.artists)
    : normaliseArtistTag(common.artist);

  const albumArtists = common.albumartists && common.albumartists.length
    ? normaliseArtistTag(common.albumartists)
    : normaliseArtistTag(common.albumartist);

  return {
    trackArtists,
    albumArtists,
    isCompilation:      !!common.compilation,
    trackArtistDisplay: common.artist      ? String(common.artist)      : (trackArtists[0] || ''),
    albumArtistDisplay: common.albumartist ? String(common.albumartist) : (albumArtists[0] || null),
  };
}

/**
 * Pick the canonical album-artist id for an album, applying the
 * fallback rules:
 *
 *   1. ALBUMARTIST tag present        → use it (first value)
 *   2. COMPILATION flag set, no AA    → "Various Artists"
 *   3. neither                        → primary track artist
 *
 * This is the policy that populates `albums.artist_id`. The full
 * album_artists M2M list comes from the raw `albumArtists` array.
 *
 * @param {object} args
 * @param {number[]} args.albumArtistIds   artist ids from ALBUMARTIST, or []
 * @param {boolean}  args.isCompilation    COMPILATION tag truthy
 * @param {number|null} args.variousArtistsId  id of the seeded VA row
 * @param {number|null} args.primaryTrackArtistId  fallback id
 * @returns {number|null}
 */
export function chooseAlbumArtistId({
  albumArtistIds, isCompilation, variousArtistsId, primaryTrackArtistId,
}) {
  if (albumArtistIds && albumArtistIds.length) { return albumArtistIds[0]; }
  if (isCompilation && variousArtistsId)       { return variousArtistsId; }
  return primaryTrackArtistId;
}
