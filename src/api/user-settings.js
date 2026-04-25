// User Settings — persist UI preferences per user.
// Stores key-value pairs in user_settings table.
// Also handles queue save/restore for session continuity.

import * as db from '../db/manager.js';

const d = () => db.getDB();

export function setup(mstream) {

  // ── Get settings ───────────────────────────────────────────
  // In public/no-users mode the row is keyed to the V25 anonymous
  // sentinel — every anon session shares it, which is intentional:
  // dark mode and the saved play queue should survive page reloads
  // for the operator running a single-user public deployment. If the
  // user object is genuinely missing (no auth.js public-mode branch
  // ran), we return empty rather than crash.
  mstream.get('/api/v1/user/settings', (req, res) => {
    if (!req.user?.id) return res.json({ prefs: {} });

    const rows = d().prepare(
      'SELECT key, value FROM user_settings WHERE user_id = ?'
    ).all(req.user.id);

    const prefs = {};
    let queue = null;
    for (const row of rows) {
      if (row.key === '__queue__') {
        try { queue = JSON.parse(row.value); } catch (_) {}
      } else {
        prefs[row.key] = row.value;
      }
    }

    const result = { prefs };
    if (queue) result.queue = queue;
    res.json(result);
  });

  // ── Save settings ──────────────────────────────────────────
  mstream.post('/api/v1/user/settings', (req, res) => {
    if (!req.user?.id) return res.json({ ok: true });

    const { prefs, queue } = req.body;

    const upsert = d().prepare(`
      INSERT INTO user_settings (user_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `);

    // Save preferences (individual upserts — no explicit transaction needed)
    if (prefs && typeof prefs === 'object') {
      for (const [key, value] of Object.entries(prefs)) {
        if (key === '__queue__') continue; // reserved key
        upsert.run(req.user.id, key, value != null ? String(value) : null);
      }
    }

    // Save queue state
    if (queue && typeof queue === 'object') {
      upsert.run(req.user.id, '__queue__', JSON.stringify(queue));
    }

    res.json({ ok: true });
  });
}
