// Google Calendar OAuth2. The admin connects their calendar entirely from the
// settings page: /connect kicks off consent, /callback stores the refresh token.
import express from 'express';
import { asyncHandler } from '../lib/http.js';
import { config } from '../config.js';
import { requireAdmin } from '../lib/auth.js';
import { getSessionContext, readCookieToken } from '../lib/auth.js';
import { updateTenantSettings, getTenantById } from '../lib/tenants.js';
import { signValue, safeEqual } from '../lib/crypto.js';
import { isConnected } from '../lib/google_calendar.js';

const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email'];

function configured() { return Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri); }

// Start consent (browser navigation; uses the admin session to bind tenant).
router.get('/connect', asyncHandler(async (req, res) => {
  const ctx = await getSessionContext(readCookieToken(req));
  if (!ctx) return res.redirect('/admin/login');
  if (!configured()) return res.status(400).send('Google is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.');
  const tenantId = ctx.admin.tenantId;
  const state = `${tenantId}.${signValue('g:' + tenantId)}`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}));

// OAuth redirect target.
router.get('/callback', asyncHandler(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('/admin/settings?google=error');
  const [tenantId, sig] = String(state).split('.');
  if (!safeEqual(sig || '', signValue('g:' + tenantId))) return res.redirect('/admin/settings?google=error');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: config.google.redirectUri, grant_type: 'authorization_code' }),
  });
  if (!tokenRes.ok) return res.redirect('/admin/settings?google=error');
  const tok = await tokenRes.json();
  let email = '';
  try { email = JSON.parse(Buffer.from((tok.id_token || '').split('.')[1] || '', 'base64').toString()).email || ''; } catch { /* */ }
  await updateTenantSettings(Number(tenantId), {
    integrations: { google: {
      connected: true, refreshToken: tok.refresh_token || '', accessToken: tok.access_token || '',
      expiryDate: Date.now() + (tok.expires_in || 3600) * 1000, email, calendarId: 'primary',
    } },
  });
  res.redirect('/admin/settings?google=connected');
}));

router.post('/disconnect', requireAdmin(), asyncHandler(async (req, res) => {
  await updateTenantSettings(req.tenant.id, { integrations: { google: { connected: false, refreshToken: '', accessToken: '', expiryDate: 0, email: '' } } });
  res.json({ ok: true });
}));

router.put('/calendar', requireAdmin(), asyncHandler(async (req, res) => {
  await updateTenantSettings(req.tenant.id, { integrations: { google: { calendarId: req.body?.calendarId || 'primary' } } });
  res.json({ ok: true });
}));

router.get('/status', requireAdmin(), asyncHandler(async (req, res) => {
  const t = await getTenantById(req.tenant.id);
  res.json({ ok: true, connected: isConnected(t), configured: configured(), email: t.settings.integrations.google.email || '', calendarId: t.settings.integrations.google.calendarId || 'primary' });
}));

export default router;
