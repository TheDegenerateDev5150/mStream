/**
 * LRC (line-timed karaoke) → structured-lines parser.
 *
 * The LRC format is minimal and widely supported:
 *
 *   [ar:Artist Name]          ← metadata (ignored)
 *   [ti:Track Title]
 *   [al:Album]
 *   [length:mm:ss]
 *   [offset:+500]             ← global ms shift (applied to every line)
 *
 *   [00:12.34]First line       ← timestamp + text
 *   [00:15.00][00:45.00]Chorus ← multiple timestamps share one text
 *   [01:30.250]Higher precision OK
 *
 *   [00:17.00]                ← empty line = instrumental break
 *
 * Rules we follow:
 *   - Any line without a valid `[mm:ss(.xx)]` prefix that isn't a
 *     recognised metadata tag is kept as an "unsynced fallback" line
 *     with time=0. (Some taggers mix unsynced + synced in one file.)
 *   - Multi-timestamp lines yield one output row per timestamp, all
 *     with the same text; we sort the final list by time ascending.
 *   - Timestamps with milliseconds (.xxx) or centiseconds (.xx) both
 *     parse — the fractional portion is left-padded and capped at 3
 *     digits (so .5 → 500ms, .50 → 500ms, .500 → 500ms).
 *   - A corrupt individual line is skipped, not fatal. Matches the
 *     "relaxed parsing" stance of the scanner elsewhere.
 *
 * The shared output shape is `{ synced, lines: [{ time_ms, text }] }`:
 *
 *   - synced: true  → every line has a real time_ms (≥ 0)
 *   - synced: false → returned by callers who passed a plain-text
 *     input; each line time_ms is 0 and the `synced` flag in the
 *     caller's response is what signals "not timed"
 *
 * Consumed by:
 *   - src/api/subsonic/handlers.js      (Subsonic getLyricsBySongId)
 *   - src/api/lyrics.js                 (Velvet-compatible /api/v1/lyrics)
 *
 * Both endpoints serve identical data under different envelopes.
 */

// Match an LRC timestamp anchored to the start of a candidate position:
//   [mm:ss]       [mm:ss.xx]   [mm:ss.xxx]
// Group 1: minutes (1+ digits). Group 2: seconds (1–2 digits).
// Group 3: fractional digits (optional, 1–3 digits).
const TIMESTAMP_RE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

// Recognised metadata tags — we strip these from the output so they
// don't show up as garbage "lyric lines" on clients that don't filter.
const META_TAG_RE = /^\[(ar|ti|al|au|by|re|ve|length|offset|lang|tool):[^\]]*\]$/i;

/**
 * Parse LRC text into a sorted, normalised list of `{time_ms, text}`.
 *
 * @param {string} lrc  LRC-format text (Unicode; BOM-safe)
 * @returns {{
 *   synced: boolean,
 *   lines:  Array<{ time_ms: number, text: string }>,
 *   offsetMs: number,
 *   lang:   string | null,
 * }}
 */
export function parseLrc(lrc) {
  if (!lrc || typeof lrc !== 'string') {
    return { synced: false, lines: [], offsetMs: 0, lang: null };
  }

  // Strip BOM — a leading BOM on the first line makes TIMESTAMP_RE miss.
  const text = lrc.charCodeAt(0) === 0xFEFF ? lrc.slice(1) : lrc;

  let offsetMs = 0;
  let lang = null;
  const out = [];
  let sawAnyTimestamp = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { continue; }

    // Metadata-only line — consume if we can extract the offset/lang;
    // otherwise just skip.
    if (META_TAG_RE.test(line)) {
      const offM = line.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
      if (offM) { offsetMs = parseInt(offM[1], 10) || 0; }
      const langM = line.match(/^\[lang:\s*([a-z0-9-]+)\s*\]/i);
      if (langM) { lang = langM[1].toLowerCase(); }
      continue;
    }

    // Peel off one or more leading timestamps. `remaining` walks
    // forward as each stamp is consumed; the final tail is the line's
    // lyric text shared by all the stamps we extracted.
    let remaining = line;
    const stamps = [];
    for (;;) {
      const m = remaining.match(TIMESTAMP_RE);
      if (!m) { break; }
      const minutes  = parseInt(m[1], 10) || 0;
      const seconds  = parseInt(m[2], 10) || 0;
      // Fractional digits → left-pad to 3 (ms). ".5" → 500, ".50" →
      // 500, ".500" → 500, ".1234" → clamped to first 3 digits = 123.
      let frac = 0;
      if (m[3]) {
        const d = m[3].slice(0, 3).padEnd(3, '0');
        frac = parseInt(d, 10) || 0;
      }
      const ms = (minutes * 60 + seconds) * 1000 + frac;
      stamps.push(ms);
      remaining = remaining.slice(m[0].length);
    }

    if (stamps.length === 0) {
      // No leading timestamp. Keep the line as plain text at t=0 so
      // callers serving an unsynced response can still render it. If
      // we later see ANY timestamp in the same file, we'll flip
      // synced=true and these plain lines get time_ms=0 (skipped by
      // karaoke renderers, shown by scrolling-text renderers).
      out.push({ time_ms: 0, text: remaining });
      continue;
    }

    sawAnyTimestamp = true;
    const body = remaining;  // may be '' for instrumental breaks
    for (const ms of stamps) {
      out.push({ time_ms: Math.max(0, ms + offsetMs), text: body });
    }
  }

  // Stable sort by time ascending. Two lines at the same timestamp
  // keep their input order (JavaScript's sort is stable since ES2019).
  out.sort((a, b) => a.time_ms - b.time_ms);

  return { synced: sawAnyTimestamp, lines: out, offsetMs, lang };
}

/**
 * Flatten parsed lines back to newline-separated plain text (strips
 * timestamps). Used by the Subsonic v1 `getLyrics` endpoint which
 * can't express line-level timing.
 */
export function linesToPlainText(lines) {
  if (!Array.isArray(lines)) { return ''; }
  return lines.map(l => l.text || '').filter(Boolean).join('\n');
}

/**
 * Build a `{synced, lines}` payload from a plain-text block (no
 * timestamps). Every line becomes a `{time_ms: 0, text}` entry and
 * synced is false. Useful when the only source is embedded USLT
 * without timings or a `.txt` sidecar.
 */
export function plainTextToLines(text) {
  if (!text || typeof text !== 'string') {
    return { synced: false, lines: [] };
  }
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/)
    .map(s => s.trimEnd())           // preserve intentional leading indent
    .filter((_, i, arr) => {
      // Collapse runs of >1 empty line at start/end but keep internal
      // single blanks as instrumental-break markers.
      return true;
    });
  // Trim leading/trailing empty lines.
  while (lines.length && !lines[0])        { lines.shift(); }
  while (lines.length && !lines[lines.length - 1]) { lines.pop(); }
  return {
    synced: false,
    lines: lines.map(t => ({ time_ms: 0, text: t })),
  };
}
