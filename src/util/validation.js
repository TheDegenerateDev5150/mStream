import Joi from 'joi';

export const joiValidate = (joiSchema, validateThis, throwErr) => {
  const { error, value } = joiSchema.validate(validateThis);

  if (error && throwErr !== false) {
    throw error;
  }

  return { error, value };
};

/**
 * Normalize the legacy `lokiid` field to `id` in request bodies.
 * Accepts either `lokiid` or `id` but not both. Returns the resolved
 * integer value. Throws if both are present or neither is present.
 */
export function resolveId(body) {
  const hasLoki = body.lokiid != null;
  const hasId = body.id != null;

  if (hasLoki && hasId) {
    throw new Error('Request must use either `id` or `lokiid`, not both');
  }
  if (!hasLoki && !hasId) {
    throw new Error('Missing required field: `id`');
  }

  return Number(hasLoki ? body.lokiid : body.id);
}

/**
 * Build a response object that includes both `id` and `lokiId` for
 * backward compatibility with the default UI (reads `lokiId`) and
 * the Velvet UI (reads `id`).
 */
export function dualId(id) {
  return { id, lokiId: id };
}

// Function to sanitize filenames
export function sanitizeFilename(filename) {
  // decode an URI params
  const decodedParam = decodeURIComponent(filename);

  const filenameSchema = Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9]{1,7}$/)
    .required();

  // Validate the filename using the schema
  const { value } = joiValidate(filenameSchema, decodedParam);

  return value;
};
