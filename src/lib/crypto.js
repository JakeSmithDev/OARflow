// Password hashing + token helpers. Uses Node's built-in crypto only.
import crypto from 'node:crypto';
import { config } from '../config.js';

const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltB64, hashB64] = stored.split('$');
  const iterations = Number(iterStr);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.pbkdf2Sync(password, salt, iterations, expected.length, PBKDF2_DIGEST);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A URL-safe random token (for sessions, invoice pay links, etc.). */
export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex of a value (used to store session tokens without the plaintext). */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Short HMAC signature appended to public tokens for tamper resistance. */
export function signValue(value) {
  return crypto.createHmac('sha256', config.tokenSecret).update(String(value)).digest('base64url').slice(0, 16);
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- Secret encryption at rest (AES-256-GCM) -----------------------------
// Used for sensitive tenant-stored credentials (e.g. Stripe secret + webhook
// secret). Key derives from ENCRYPTION_KEY (recommended) or TOKEN_SECRET.
function encKey() {
  return crypto.createHash('sha256').update(config.encryptionKey || config.tokenSecret).digest();
}
const ENC_PREFIX = 'enc:v1:';

/** Encrypt a secret for storage. Returns 'enc:v1:<base64>' (or '' for empty). */
export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a stored secret. Plaintext (non-prefixed) values pass through. */
export function decryptSecret(stored) {
  if (!stored) return '';
  const s = String(stored);
  if (!s.startsWith(ENC_PREFIX)) return s;
  try {
    const raw = Buffer.from(s.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12); const tag = raw.subarray(12, 28); const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function isEncrypted(v) { return typeof v === 'string' && v.startsWith(ENC_PREFIX); }

export default { hashPassword, verifyPassword, randomToken, sha256, signValue, safeEqual, encryptSecret, decryptSecret, isEncrypted };
