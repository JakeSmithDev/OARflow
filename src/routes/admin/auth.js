// Admin auth endpoints: login, logout, session check, and TOTP enrollment.
import express from 'express';
import QRCode from 'qrcode';
import { asyncHandler, badRequest, getClientIp } from '../../lib/http.js';
import { consumeRateLimit } from '../../lib/rate_limit.js';
import { getTenantBySlug, getDefaultTenant } from '../../lib/tenants.js';
import {
  attemptLogin, revokeSession, readCookieToken, sessionCookie, clearCookie,
  requireAdmin, newTotpSecret, totpKeyUri, verifyTotpCode,
} from '../../lib/auth.js';
import { query, queryOne } from '../../lib/db.js';
import { capabilitiesFor } from '../../lib/permissions.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();

// Resolve which tenant a request targets. Single-tenant deployments fall back
// to the default tenant; multi-tenant can map a subdomain to a slug.
async function resolveTenant(req) {
  const host = (req.headers.host || '').split(':')[0];
  const sub = host.split('.')[0];
  if (sub && !['www', 'localhost', '127', 'app'].includes(sub)) {
    const t = await getTenantBySlug(sub);
    if (t) return t;
  }
  return getDefaultTenant();
}

router.post('/login', asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const rl = await consumeRateLimit({ ip, endpoint: 'admin_login', windowMinutes: 10, maxCount: 12 });
  if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again shortly.' });

  const { username, password, totpCode } = req.body || {};
  if (!username || !password) return badRequest(res, 'Username and password are required.');

  const tenant = await resolveTenant(req);
  if (!tenant) return badRequest(res, 'No tenant configured.');

  const result = await attemptLogin({ tenantId: tenant.id, username, password, totpCode });
  if (!result.ok) {
    if (result.requiresTotp) return res.json({ ok: false, requiresTotp: true, error: result.error || null });
    return res.status(401).json({ ok: false, error: result.error });
  }
  res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt));
  await logAudit({ tenantId: tenant.id, adminUsername: result.user.username, action: 'login', entityType: 'admin_user', entityId: result.user.id });
  res.json({ ok: true, user: result.user });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  await revokeSession(readCookieToken(req));
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
}));

router.get('/session', requireAdmin(), asyncHandler(async (req, res) => {
  const t = req.tenant;
  res.json({
    ok: true,
    user: { ...req.admin, capabilities: capabilitiesFor(req.admin) }, // resolved set for nav gating
    tenant: {
      id: t.id, slug: t.slug, name: t.name, timezone: t.timezone, currency: t.currency,
      branding: t.settings.branding,
    },
  });
}));

// --- TOTP enrollment (requires an active session) -------------------------
router.post('/totp/start', requireAdmin(), asyncHandler(async (req, res) => {
  const secret = newTotpSecret();
  const otpauth = totpKeyUri(req.admin.username, secret);
  const qr = await QRCode.toDataURL(otpauth);
  // Stash the pending secret on the user row until verified.
  await query('UPDATE admin_users SET totp_secret = $2 WHERE id = $1', [req.admin.userId, secret]);
  res.json({ ok: true, secret, otpauthUrl: otpauth, qr });
}));

router.post('/totp/enable', requireAdmin(), asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const user = await queryOne('SELECT totp_secret FROM admin_users WHERE id = $1', [req.admin.userId]);
  if (!user?.totp_secret || !verifyTotpCode(code, user.totp_secret)) return badRequest(res, 'Invalid code. Try again.');
  await query('UPDATE admin_users SET is_totp_enabled = TRUE, totp_enabled_at = now() WHERE id = $1', [req.admin.userId]);
  await logAudit({ tenantId: req.admin.tenantId, adminUsername: req.admin.username, action: 'totp_enable', entityType: 'admin_user', entityId: req.admin.userId });
  res.json({ ok: true });
}));

router.post('/totp/disable', requireAdmin(), asyncHandler(async (req, res) => {
  await query('UPDATE admin_users SET is_totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [req.admin.userId]);
  await logAudit({ tenantId: req.admin.tenantId, adminUsername: req.admin.username, action: 'totp_disable', entityType: 'admin_user', entityId: req.admin.userId });
  res.json({ ok: true });
}));

export default router;
