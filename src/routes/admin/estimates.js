// Admin quotes/estimates: build, send (with online accept link), convert to invoice.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requireWrite } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { createEstimate, updateEstimate, convertToInvoice, declineEstimate } from '../../lib/estimates.js';
import { sendTemplated, htmlEscape } from '../../lib/email_templates.js';
import { ownsId } from '../../lib/ownership.js';
import { logAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { formatCents } from '../../lib/money.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('estimates.manage'));

function summaryHtml(tenant, e) {
  const cur = tenant.currency;
  const rows = (e.line_items || []).map((li) => `<tr><td style="padding:4px 0">${htmlEscape(li.label)}${li.quantity > 1 ? ` ×${li.quantity}` : ''}</td><td style="padding:4px 0;text-align:right">${formatCents(li.amount_cents, cur)}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${rows}
    <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;font-weight:700">Total</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:700">${formatCents(e.total_cents, cur)}</td></tr></table>`;
}

router.get('/', asyncHandler(async (req, res) => {
  const { status, q } = req.query;
  const where = ['e.tenant_id=$1']; const params = [req.tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`e.status=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR e.number ILIKE $${params.length})`); }
  const rows = await query(
    `SELECT e.id, e.number, e.status, e.total_cents, e.created_at, e.sent_at, e.valid_until, c.name AS customer_name
       FROM estimates e JOIN customers c ON c.id=e.customer_id WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 200`,
    params,
  );
  const summary = await queryOne(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('sent') THEN total_cents ELSE 0 END),0)::bigint AS outstanding,
            COALESCE(SUM(CASE WHEN status='accepted' THEN total_cents ELSE 0 END),0)::bigint AS accepted,
            COALESCE(SUM(CASE WHEN status='draft' THEN total_cents ELSE 0 END),0)::bigint AS draft FROM estimates WHERE tenant_id=$1`,
    [req.tenant.id],
  );
  res.json({ ok: true, estimates: rows.rows, summary });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const e = await queryOne(
    `SELECT e.*, c.name AS customer_name, c.email AS customer_email FROM estimates e JOIN customers c ON c.id=e.customer_id WHERE e.tenant_id=$1 AND e.id=$2`,
    [req.tenant.id, toInt(req.params.id)],
  );
  if (!e) return notFound(res);
  res.json({ ok: true, estimate: e, acceptUrl: `${config.baseUrl}/quote?estimate=${e.id}&token=${e.access_token}` });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const customerId = toInt(b.customerId);
  if (!customerId) return badRequest(res, 'A customer is required.');
  if (!Array.isArray(b.lineItems) || !b.lineItems.length) return badRequest(res, 'Add at least one line item.');
  if (!(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  const e = await createEstimate(req.tenant, { customerId, serviceTypeId: toInt(b.serviceTypeId), lineItems: b.lineItems, taxRatePercent: b.taxRatePercent, discountCents: b.discountCents, notes: b.notes, terms: b.terms, validUntil: b.validUntil }, req.admin.username);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'estimate_create', entityType: 'estimate', entityId: e.id });
  res.json({ ok: true, estimate: e });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  try { const e = await updateEstimate(req.tenant, toInt(req.params.id), req.body || {}); if (!e) return notFound(res); res.json({ ok: true, estimate: e }); }
  catch (err) { return badRequest(res, err.message); }
}));

router.post('/:id/send', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const e = await queryOne(`SELECT e.*, c.name AS customer_name, c.email AS customer_email FROM estimates e JOIN customers c ON c.id=e.customer_id WHERE e.tenant_id=$1 AND e.id=$2`, [req.tenant.id, id]);
  if (!e) return notFound(res);
  if (!e.customer_email) return badRequest(res, 'This customer has no email on file.');
  await query("UPDATE estimates SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=COALESCE(sent_at, now()), updated_at=now() WHERE id=$1", [id]);
  const acceptUrl = `${config.baseUrl}/quote?estimate=${e.id}&token=${e.access_token}`;
  const r = await sendTemplated(req.tenant, 'estimate', e.customer_email, {
    CUSTOMER_NAME: e.customer_name, COMPANY_NAME: req.tenant.settings.branding.logoText || req.tenant.name,
    ESTIMATE_NUMBER: e.number, ESTIMATE_TOTAL: formatCents(e.total_cents, req.tenant.currency),
    ESTIMATE_SUMMARY: summaryHtml(req.tenant, e), ACCEPT_URL: acceptUrl, TERMS: e.terms || '',
    VALID_UNTIL: e.valid_until ? String(e.valid_until).slice(0, 10) : '',
  }, { type: 'estimate', id });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'estimate_send', entityType: 'estimate', entityId: id });
  emitEvent('estimate.sent', { tenantId: req.tenant.id, estimateId: id, customerId: e.customer_id }).catch(() => {});
  res.json({ ok: true, emailed: r.ok, acceptUrl });
}));

router.post('/:id/convert', asyncHandler(async (req, res) => {
  const r = await convertToInvoice(req.tenant, toInt(req.params.id), req.admin.username);
  if (!r.ok) return badRequest(res, r.error);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'estimate_convert', entityType: 'estimate', entityId: toInt(req.params.id), details: { invoiceId: r.invoiceId } });
  res.json({ ok: true, invoiceId: r.invoiceId });
}));

router.post('/:id/decline', asyncHandler(async (req, res) => {
  await declineEstimate(req.tenant, toInt(req.params.id));
  res.json({ ok: true });
}));

export default router;
