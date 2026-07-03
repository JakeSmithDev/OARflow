// Customer self-service portal API (public; magic-link token auth).
import express from 'express';
import { asyncHandler, badRequest, notFound, getClientIp } from '../lib/http.js';
import { consumeRateLimit } from '../lib/rate_limit.js';
import { query, queryOne } from '../lib/db.js';
import { getDefaultTenant, getTenantBySlug } from '../lib/tenants.js';
import { ensurePortalToken, customerByPortalToken, portalUrl, portalData } from '../lib/portal.js';
import { randomToken } from '../lib/crypto.js';
import { sendTemplated } from '../lib/email_templates.js';
import { config } from '../config.js';

const router = express.Router();

async function resolveTenant(slug) {
  if (!slug || slug === 'default' || slug === '_') return getDefaultTenant();
  return getTenantBySlug(slug);
}

// Request a magic link by email. Always returns ok (never leaks whether an email
// exists). In dev we include the link directly so the flow is testable.
router.post('/request-link', asyncHandler(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) return badRequest(res, 'Enter your email.');
  const rl = await consumeRateLimit({ ip: getClientIp(req), endpoint: 'portal_link', windowMinutes: 10, maxCount: 8 });
  if (!rl.allowed) return res.json({ ok: true }); // soft-limit, never leak existence
  const tenant = await resolveTenant((req.body || {}).t || req.query.t);
  const customer = tenant && await queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND lower(email)=$2', [tenant.id, email]);
  if (!tenant || !customer) return res.json({ ok: true });
  const token = await ensurePortalToken(tenant, customer.id);
  const url = portalUrl(token, tenant);
  await sendTemplated(tenant, 'portal_link', customer.email, {
    CUSTOMER_NAME: customer.name, COMPANY_NAME: tenant.settings.branding.logoText || tenant.name, PORTAL_URL: url,
  }, { type: 'customer', id: customer.id }).catch(() => {});
  res.json({ ok: true, ...(config.isProduction ? {} : { devLink: url }) });
}));

async function loadCustomer(req) {
  const token = String(req.query.token || (req.body || {}).token || '');
  const tenant = await resolveTenant(req.query.t || (req.body || {}).t);
  if (!tenant) return null;
  const customer = await customerByPortalToken(tenant, token);
  return customer ? { tenant, customer } : null;
}

router.get('/me', asyncHandler(async (req, res) => {
  const ctx = await loadCustomer(req);
  if (!ctx) return notFound(res, 'This link is no longer valid.');
  res.json({ ok: true, ...(await portalData(ctx.tenant, ctx.customer)) });
}));

// Ensure (and return) a save-card link for the signed-in customer.
router.post('/card-link', asyncHandler(async (req, res) => {
  const ctx = await loadCustomer(req);
  if (!ctx) return notFound(res, 'This link is no longer valid.');
  let token = ctx.customer.card_token;
  if (!token) { token = randomToken(); await query('UPDATE customers SET card_token=$3 WHERE tenant_id=$1 AND id=$2', [ctx.tenant.id, ctx.customer.id, token]); }
  res.json({ ok: true, url: `${config.baseUrl}/save-card?customer=${ctx.customer.id}&token=${token}` });
}));

export default router;
