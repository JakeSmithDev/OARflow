// Public quote view + clickwrap acceptance (no auth; guarded by access token).
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt, getClientIp } from '../lib/http.js';
import { queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { acceptEstimate, convertToInvoice, estimateExpired } from '../lib/estimates.js';
import { emitEvent } from '../lib/events.js';

const router = express.Router();

async function load(id, token) {
  const e = await queryOne('SELECT * FROM estimates WHERE id=$1', [id]);
  if (!e || e.access_token !== token) return null;
  return e;
}

router.get('/:id', asyncHandler(async (req, res) => {
  const e = await load(toInt(req.params.id), String(req.query.token || ''));
  if (!e) return notFound(res, 'Estimate not found.');
  const tenant = await getTenantById(e.tenant_id);
  res.json({
    ok: true,
    estimate: {
      number: e.number, status: e.status, currency: e.currency, lineItems: e.line_items,
      subtotalCents: e.subtotal_cents, discountCents: e.discount_cents, taxCents: e.tax_cents, totalCents: e.total_cents,
      notes: e.notes, terms: e.terms, validUntil: e.valid_until, expired: estimateExpired(tenant, e), acceptedAt: e.accepted_at, acceptedName: e.accepted_name,
    },
    tenant: { name: tenant.name, branding: tenant.settings.branding },
  });
}));

router.post('/:id/accept', asyncHandler(async (req, res) => {
  const e = await load(toInt(req.params.id), String((req.body || {}).token || ''));
  if (!e) return notFound(res, 'Estimate not found.');
  const name = (req.body || {}).name;
  if (!name) return badRequest(res, 'Please type your name to accept.');
  const tenant = await getTenantById(e.tenant_id);
  const r = await acceptEstimate(tenant, e.id, { name, ip: getClientIp(req), userAgent: req.headers['user-agent'] });
  if (!r.ok) return badRequest(res, r.error, { code: r.code, expired: r.expired, validUntil: r.validUntil });
  // Auto-create a draft invoice so staff can send it; idempotent.
  const conv = await convertToInvoice(tenant, e.id, 'accepted').catch(() => ({}));
  emitEvent('estimate.accepted', { tenantId: tenant.id, estimateId: e.id, customerId: e.customer_id, invoiceId: conv.invoiceId }).catch(() => {});
  res.json({ ok: true });
}));

router.post('/:id/decline', asyncHandler(async (req, res) => {
  const e = await load(toInt(req.params.id), String((req.body || {}).token || ''));
  if (!e) return notFound(res, 'Estimate not found.');
  const tenant = await getTenantById(e.tenant_id);
  const { declineEstimate } = await import('../lib/estimates.js');
  await declineEstimate(tenant, e.id);
  res.json({ ok: true });
}));

export default router;
