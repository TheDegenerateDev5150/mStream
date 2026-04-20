/**
 * API key management for the current authenticated user.
 *
 * Mounted after the auth wall: `req.user` is already populated. Users can
 * list / create / revoke their own keys. The key string itself is returned
 * exactly once (at creation); thereafter the UI only sees id/name/metadata.
 *
 * Primary consumer is the Subsonic API (`src/api/subsonic/auth.js`) but the
 * keys can be used by any future endpoint that accepts `apiKey=`.
 */

import Joi from 'joi';
import { joiValidate } from '../util/validation.js';
import { generateApiKey, listApiKeys, revokeApiKey } from './subsonic/auth.js';

export function setup(mstream) {
  // List the current user's API keys — names + timestamps only, no secrets.
  mstream.get('/api/v1/user/api-keys', (req, res) => {
    res.json(listApiKeys(req.user.id));
  });

  // Generate a new API key. The returned `key` field is only shown here —
  // subsequent list calls only return id/name/timestamps.
  mstream.post('/api/v1/user/api-keys', (req, res) => {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(100).required(),
    });
    const { value } = joiValidate(schema, req.body);
    const key = generateApiKey(req.user.id, value.name);
    res.json({ key, name: value.name });
  });

  // Revoke one of the current user's keys. 404 if the key doesn't exist or
  // belongs to a different user (so we don't leak the existence of keys we
  // don't own).
  mstream.delete('/api/v1/user/api-keys/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { return res.status(400).json({ error: 'invalid id' }); }
    const ok = revokeApiKey(req.user.id, id);
    if (!ok) { return res.status(404).json({ error: 'not found' }); }
    res.json({});
  });
}
