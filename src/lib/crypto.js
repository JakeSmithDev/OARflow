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

export default { hashPassword, verifyPassword, randomToken, sha256, signValue, safeEqual };
