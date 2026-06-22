// Decode a base64 JSON upload (no multipart dependency). Used by job photos, the
// field PWA, e-signatures, and the customer portal. Enforces a size cap + an
// allow-list of content types.
const DEFAULT_MAX = 15 * 1024 * 1024; // 15 MB
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
export const DOC_TYPES = ['application/pdf', ...IMAGE_TYPES];

export function decodeUpload(body = {}, { maxBytes = DEFAULT_MAX, allow = DOC_TYPES } = {}) {
  let { dataBase64, contentType, filename } = body;
  if (!dataBase64) return { error: 'No file data.' };
  // Accept data URLs (data:<type>;base64,<data>) or raw base64.
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataBase64);
  if (m) { contentType = contentType || m[1]; dataBase64 = m[2]; }
  let buffer;
  try { buffer = Buffer.from(dataBase64, 'base64'); } catch { return { error: 'Invalid file data.' }; }
  if (!buffer.length) return { error: 'Empty file.' };
  if (buffer.length > maxBytes) return { error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).` };
  contentType = (contentType || 'application/octet-stream').toLowerCase();
  if (allow && !allow.includes(contentType)) return { error: `Unsupported file type (${contentType}).` };
  return { buffer, contentType, filename: filename || 'upload' };
}

export default { decodeUpload, IMAGE_TYPES, DOC_TYPES };
