// Public REST API v1. Tenant-scoped via an API key (Authorization: Bearer oarf_…
// or X-API-Key). Read + a useful create subset; pairs with outbound webhooks for
// Zapier/Make (webhooks = triggers, these endpoints = actions/polling).
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt } from '../lib/http.js';
import { query, queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { resolveApiKey, keyHasScope } from '../lib/api_keys.js';
import { createEndpoint, assertSafeWebhookUrl } from '../lib/webhooks.js';
import { WEBHOOK_EVENTS } from '../lib/webhooks.js';
import { findOrCreateCustomer } from '../lib/appointments.js';

const router = express.Router();

// Health/echo sink (no auth) — handy for webhook delivery tests + uptime checks.
router.all('/ping', (req, res) => res.json({ ok: true, pong: true }));

// --- API key auth ---------------------------------------------------------
router.use(asyncHandler(async (req, res, next) => {
  const hdr = req.headers.authorization || '';
  const raw = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-api-key'] || '');
  const keyRow = await resolveApiKey(String(raw));
  if (!keyRow) return res.status(401).json({ ok: false, error: 'Invalid or missing API key.' });
  req.apiKey = keyRow;
  req.tenant = await getTenantById(keyRow.tenant_id);
  if (!req.tenant) return res.status(401).json({ ok: false, error: 'Tenant not found.' });
  next();
}));
function requireWrite(req, res) { if (!keyHasScope(req.apiKey, 'write')) { res.status(403).json({ ok: false, error: 'This key is read-only.' }); return false; } return true; }

router.get('/me', asyncHandler(async (req, res) => {
  res.json({ ok: true, tenant: { id: req.tenant.id, name: req.tenant.name, timezone: req.tenant.timezone, currency: req.tenant.currency }, events: WEBHOOK_EVENTS });
}));

// --- Customers ------------------------------------------------------------
router.get('/customers', asyncHandler(async (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const params = [req.tenant.id]; let where = 'tenant_id=$1';
  if (req.query.since) { params.push(req.query.since); where += ` AND created_at >= $${params.length}`; }
  params.push(limit);
  const r = await query(`SELECT id, name, email, phone, address, city, state, created_at FROM customers WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  res.json({ ok: true, data: r.rows });
}));
router.get('/customers/:id', asyncHandler(async (req, res) => {
  const c = await queryOne('SELECT id, name, email, phone, address, city, state, created_at FROM customers WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(req.params.id)]);
  if (!c) return notFound(res); res.json({ ok: true, data: c });
}));
router.post('/customers', asyncHandler(async (req, res) => {
  if (!requireWrite(req, res)) return;
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!name) return badRequest(res, 'name is required.');
  if (!address) return badRequest(res, 'service address is required.');
  const id = await findOrCreateCustomer(req.tenant.id, { name, email: b.email, phone: b.phone, address, city: b.city, state: b.state, postalCode: b.postalCode });
  const c = await queryOne('SELECT id, name, email, phone, address, city, state, postal_code FROM customers WHERE tenant_id=$1 AND id=$2', [req.tenant.id, id]);
  res.json({ ok: true, data: c });
}));

// --- Appointments (read; supports ?since= polling for Zapier) -------------
router.get('/appointments', asyncHandler(async (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const params = [req.tenant.id]; let where = 'a.tenant_id=$1';
  if (req.query.status) { params.push(req.query.status); where += ` AND a.status=$${params.length}`; }
  if (req.query.since) { params.push(req.query.since); where += ` AND a.created_at >= $${params.length}`; }
  params.push(limit);
  const r = await query(
    `SELECT a.id, a.status, a.scheduled_start, a.scheduled_end, a.price_cents, a.service_address, a.created_at,
            c.name AS customer_name, s.name AS service_name
       FROM appointments a JOIN customers c ON c.id=a.customer_id LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`,
    params,
  );
  res.json({ ok: true, data: r.rows });
}));

// --- Invoices (read) ------------------------------------------------------
router.get('/invoices', asyncHandler(async (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const params = [req.tenant.id]; let where = 'tenant_id=$1';
  if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
  params.push(limit);
  const r = await query(`SELECT id, number, status, total_cents, amount_paid_cents, created_at, sent_at, paid_at FROM invoices WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  res.json({ ok: true, data: r.rows });
}));

router.get('/services', asyncHandler(async (req, res) => {
  const r = await query('SELECT id, name, duration_minutes, base_price_cents FROM service_types WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, name', [req.tenant.id]);
  res.json({ ok: true, data: r.rows });
}));

// --- Webhook subscription (Zapier "subscribe" action) ---------------------
router.post('/webhooks', asyncHandler(async (req, res) => {
  if (!requireWrite(req, res)) return;
  const b = req.body || {};
  if (!b.url || !/^https?:\/\//.test(b.url)) return badRequest(res, 'A valid https url is required.');
  const safe = await assertSafeWebhookUrl(b.url);
  if (!safe.ok) return badRequest(res, safe.error);
  const ep = await createEndpoint(req.tenant, { url: b.url, events: b.events }, `apikey:${req.apiKey.id}`);
  res.json({ ok: true, data: { id: ep.id, url: ep.url, events: ep.events, secret: ep.secret } });
}));

export default router;
