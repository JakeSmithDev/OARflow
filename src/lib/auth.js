// Admin authentication: password login, optional TOTP 2FA, cookie sessions,
// and the requireAdmin middleware that loads tenant + admin context.
import * as cookie from 'cookie';
import { authenticator } from 'otplib';
import { query, queryOne } from './db.js';
import { verifyPassword, randomToken, sha256 } from './crypto.js';
import { getTenantById } from './tenants.js';
import { config } from '../config.js';
import { unauthorized } from './http.js';

authenticator.options = { window: 1 };

// --- Sessions -------------------------------------------------------------
export async function createSession(adminUserId, tenantId) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await query(
    `INSERT INTO admin_sessions (admin_user_id, tenant_id, session_token_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [adminUserId, tenantId, sha256(token), expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export async function getSessionContext(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
            u.id AS user_id, u.username, u.display_name, u.role, u.tenant_id, u.is_active
       FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.session_token_hash = $1`,
    [sha256(token)],
  );
  if (!row || row.revoked_at || !row.is_active) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
  return {
    admin: { userId: row.user_id, username: row.username, displayName: row.display_name, role: row.role, tenantId: row.tenant_id },
  };
}

export async function revokeSession(token) {
  if (!token) return;
  await query('UPDATE admin_sessions SET revoked_at = now() WHERE session_token_hash = $1', [sha256(token)]);
}

export function sessionCookie(token, expiresAt) {
  return cookie.serialize(config.sessionCookieName, token, {
    httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/',
    expires: expiresAt,
  });
}
export function clearCookie() {
  return cookie.serialize(config.sessionCookieName, '', { httpOnly: true, path: '/', maxAge: 0 });
}
export function readCookieToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  return cookie.parse(header)[config.sessionCookieName] || null;
}

// --- Login ----------------------------------------------------------------
/**
 * Attempt a login. Returns one of:
 *   { ok:true, token, expiresAt, user }
 *   { ok:false, requiresTotp:true }
 *   { ok:false, error }
 */
export async function attemptLogin({ tenantId, username, password, totpCode }) {
  const user = await queryOne(
    'SELECT * FROM admin_users WHERE tenant_id = $1 AND lower(username) = lower($2) AND is_active = TRUE',
    [tenantId, username],
  );
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, error: 'Invalid username or password.' };
  }
  if (user.is_totp_enabled) {
    if (!totpCode) return { ok: false, requiresTotp: true };
    if (!authenticator.check(String(totpCode).replace(/\s/g, ''), user.totp_secret)) {
      return { ok: false, error: 'Invalid authentication code.', requiresTotp: true };
    }
  }
  const { token, expiresAt } = await createSession(user.id, tenantId);
  return { ok: true, token, expiresAt, user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name } };
}

// --- TOTP enrollment ------------------------------------------------------
export function newTotpSecret() { return authenticator.generateSecret(); }
export function totpKeyUri(username, secret) {
  return authenticator.keyuri(username, config.totpIssuer, secret);
}
export function verifyTotpCode(code, secret) {
  return authenticator.check(String(code || '').replace(/\s/g, ''), secret);
}

// --- Middleware -----------------------------------------------------------
export function requireAdmin() {
  return async (req, res, next) => {
    try {
      const token = readCookieToken(req);
      const ctx = await getSessionContext(token);
      if (!ctx) return unauthorized(res, 'Please sign in.');
      const tenant = await getTenantById(ctx.admin.tenantId);
      if (!tenant) return unauthorized(res, 'Tenant not found.');
      req.admin = ctx.admin;
      req.tenant = tenant;
      next();
    } catch (err) { next(err); }
  };
}

/** Role gate. Use AFTER requireAdmin. e.g. router.use(requireRole('owner')). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin) return unauthorized(res, 'Please sign in.');
    if (roles.length && !roles.includes(req.admin.role)) {
      return res.status(403).json({ ok: false, error: 'This action requires owner permissions.' });
    }
    next();
  };
}

export default { attemptLogin, createSession, getSessionContext, revokeSession, requireAdmin, sessionCookie, clearCookie, readCookieToken, newTotpSecret, totpKeyUri, verifyTotpCode };
