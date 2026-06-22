// Admin invoicing. Build a customizable invoice (presets + custom lines), send
// the balance ON DEMAND (never automatically), record payments, void.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { createInvoice, updateInvoice, recordPayment, balanceCents } from '../../lib/invoices.js';
import { sendTemplated, htmlEscape } from '../../lib/email_templates.js';
import { ownsId } from '../../lib/ownership.js';
import { emitEvent } from '../../lib/events.js';
import { isConfigured as stripeConfigured } from '../../lib/stripe.js';
import { listPaymentMethods, chargeInvoiceOnFile, cardsStatus } from '../../lib/payments.js';
import { logAudit } from '../../lib/audit.js';
import { formatCents } from '../../lib/money.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

function summaryHtml(tenant, inv) {
  const cur = tenant.currency;
  const rows = (inv.line_items || []).map((li) =>
    `<tr><td style="padding:4px 0">${htmlEscape(li.label)}${li.quantity > 1 ? ` ×${li.quantity}` : ''}</td><td style="padding:4px 0;text-align:right">${formatCents(li.amount_cents, cur)}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
    ${rows}
    <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">Subtotal</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right">${formatCents(inv.subtotal_cents, cur)}</td></tr>
    ${inv.discount_cents ? `<tr><td style="color:#64748b">Discount</td><td style="text-align:right">−${formatCents(inv.discount_cents, cur)}</td></tr>` : ''}
    ${inv.tax_cents ? `<tr><td style="color:#64748b">Tax</td><td style="text-align:right">${formatCents(inv.tax_cents, cur)}</td></tr>` : ''}
    <tr><td style="padding:6px 0;font-weight:700">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${formatCents(inv.total_cents, cur)}</td></tr>
    ${inv.amount_paid_cents ? `<tr><td style="color:#64748b">Paid</td><td style="text-align:right">−${formatCents(inv.amount_paid_cents, cur)}</td></tr><tr><td style="font-weight:700">Balance due</td><td style="text-align:right;font-weight:700">${formatCents(inv.total_cents - inv.amount_paid_cents, cur)}</td></tr>` : ''}
  </table>`;
}

// --- Meta: presets + defaults for the builder ----------------------------
router.get('/meta', asyncHandler(async (req, res) => {
  const presets = await query(
    'SELECT id, label, description, default_amount_cents, taxable, category FROM line_item_presets WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, label',
    [req.tenant.id],
  );
  res.json({
    ok: true,
    presets: presets.rows,
    defaults: { taxRatePercent: req.tenant.settings.invoicing.taxRatePercent, terms: req.tenant.settings.invoicing.terms, footerNote: req.tenant.settings.invoicing.footerNote, dueDays: req.tenant.settings.invoicing.dueDays },
    stripeEnabled: stripeConfigured(req.tenant),
  });
}));

// --- List + summary -------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const { status, q } = req.query;
  const customerId = toInt(req.query.customerId);
  const where = ['i.tenant_id=$1']; const params = [tenantId];
  if (status && status !== 'all') { params.push(status); where.push(`i.status=$${params.length}`); }
  if (customerId) { params.push(customerId); where.push(`i.customer_id=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR i.number ILIKE $${params.length})`); }
  const rows = await query(
    `SELECT i.id, i.number, i.status, i.total_cents, i.amount_paid_cents, i.created_at, i.sent_at, i.due_date,
            c.name AS customer_name
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 200`,
    params,
  );
  const summary = await query(
    `SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent','partial') THEN total_cents-amount_paid_cents ELSE 0 END),0)::bigint AS outstanding,
        COALESCE(SUM(CASE WHEN status='draft' THEN total_cents ELSE 0 END),0)::bigint AS draft,
        COALESCE(SUM(amount_paid_cents),0)::bigint AS collected
       FROM invoices WHERE tenant_id=$1`,
    [tenantId],
  );
  res.json({ ok: true, invoices: rows.rows, summary: summary.rows[0] });
}));

// --- Detail ---------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = await queryOne(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.address AS customer_address
       FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.tenant_id=$1 AND i.id=$2`,
    [req.tenant.id, id],
  );
  if (!inv) return notFound(res);
  const events = await query(
    'SELECT id, event_type, amount_cents, method, note, created_at, created_by FROM financial_events WHERE invoice_id=$1 ORDER BY created_at',
    [id],
  );
  const savedCards = await listPaymentMethods(req.tenant, inv.customer_id);
  res.json({ ok: true, invoice: inv, events: events.rows, balanceCents: balanceCents(inv), payUrl: `${config.baseUrl}/pay?invoice=${inv.id}&token=${inv.access_token}`, stripeEnabled: stripeConfigured(req.tenant), savedCards, cards: cardsStatus(req.tenant) });
}));

// --- Charge a saved card on file -----------------------------------------
router.post('/:id/charge-on-file', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = await queryOne('SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2', [req.tenant.id, id]);
  if (!inv) return notFound(res);
  const b = req.body || {};
  const r = await chargeInvoiceOnFile(req.tenant, inv, { paymentMethodId: toInt(b.paymentMethodId), amountCents: b.amountCents != null ? Math.round(Number(b.amountCents)) : undefined, createdBy: req.admin.username });
  if (!r.ok) return badRequest(res, r.error || (r.notConfigured ? 'Card payments are not set up.' : 'The charge could not be completed.'));
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'invoice_charge_on_file', entityType: 'invoice', entityId: id, details: { amount: r.amountCents, mock: r.mock } });
  if (r.invoice?.status === 'paid') emitEvent('invoice.paid', { tenantId: req.tenant.id, invoiceId: id, customerId: r.invoice.customer_id }).catch(() => {});
  res.json({ ok: true, invoice: r.invoice, mock: r.mock, amountCents: r.amountCents });
}));

// --- Create ---------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const customerId = toInt(b.customerId);
  if (!customerId) return badRequest(res, 'A customer is required.');
  if (!Array.isArray(b.lineItems) || !b.lineItems.length) return badRequest(res, 'Add at least one line item.');
  const appointmentId = toInt(b.appointmentId);
  const subscriptionId = toInt(b.subscriptionId);
  if (!(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  if (!(await ownsId(req.tenant.id, 'appointments', appointmentId))) return badRequest(res, 'Unknown appointment.');
  if (!(await ownsId(req.tenant.id, 'subscriptions', subscriptionId))) return badRequest(res, 'Unknown subscription.');
  const inv = await createInvoice(req.tenant, {
    customerId, appointmentId, subscriptionId,
    lineItems: b.lineItems, taxRatePercent: b.taxRatePercent, discountCents: b.discountCents,
    notes: b.notes, terms: b.terms, dueDate: b.dueDate,
  }, req.admin.username);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'invoice_create', entityType: 'invoice', entityId: inv.id });
  res.json({ ok: true, invoice: inv });
}));

// --- Update (drafts / unpaid) --------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  try {
    const inv = await updateInvoice(req.tenant, toInt(req.params.id), req.body || {});
    if (!inv) return notFound(res);
    res.json({ ok: true, invoice: inv });
  } catch (err) { return badRequest(res, err.message); }
}));

// --- Send (on demand) -----------------------------------------------------
router.post('/:id/send', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = await queryOne(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.tenant_id=$1 AND i.id=$2`,
    [req.tenant.id, id],
  );
  if (!inv) return notFound(res);
  if (!inv.customer_email) return badRequest(res, 'This customer has no email on file.');
  if (inv.status === 'void') return badRequest(res, 'This invoice is void.');

  await query("UPDATE invoices SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=COALESCE(sent_at, now()), updated_at=now() WHERE id=$1", [id]);
  const company = req.tenant.settings.branding.logoText || req.tenant.name;
  const payUrl = `${config.baseUrl}/pay?invoice=${inv.id}&token=${inv.access_token}`;
  const r = await sendTemplated(req.tenant, 'invoice', inv.customer_email, {
    CUSTOMER_NAME: inv.customer_name, COMPANY_NAME: company, INVOICE_NUMBER: inv.number,
    BALANCE_DUE: formatCents(balanceCents(inv), req.tenant.currency), INVOICE_SUMMARY: summaryHtml(req.tenant, inv),
    PAY_URL: payUrl, TERMS: inv.terms || '',
  }, { type: 'invoice', id });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'invoice_send', entityType: 'invoice', entityId: id });
  emitEvent('invoice.sent', { tenantId: req.tenant.id, invoiceId: id, customerId: inv.customer_id }).catch(() => {});
  res.json({ ok: true, emailed: r.ok, payUrl });
}));

// --- Record a manual payment ---------------------------------------------
router.post('/:id/payment', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const b = req.body || {};
  const amount = Math.round(Number(b.amountCents) || 0);
  if (!amount) return badRequest(res, 'Enter a payment amount.');
  const current = await queryOne('SELECT status, total_cents, amount_paid_cents FROM invoices WHERE tenant_id=$1 AND id=$2', [req.tenant.id, id]);
  if (!current) return notFound(res);
  if (current.status === 'void') return badRequest(res, 'This invoice is void and cannot take payments.');
  if (current.status === 'paid' && amount > 0) return badRequest(res, 'This invoice is already paid in full.');
  const balance = current.total_cents - current.amount_paid_cents;
  // Don't let a payment exceed the balance (no silent overpayment), and don't
  // let a refund exceed what's been collected.
  if (amount > 0 && amount > balance) return badRequest(res, `Payment exceeds the balance due (${formatCents(balance, req.tenant.currency)}). Enter ${formatCents(balance, req.tenant.currency)} or less.`);
  if (amount < 0 && (current.amount_paid_cents + amount) < 0) return badRequest(res, `Refund exceeds the amount collected (${formatCents(current.amount_paid_cents, req.tenant.currency)}).`);
  const { invoice } = await recordPayment(req.tenant, id, {
    amountCents: amount, eventType: amount < 0 ? 'refund' : 'payment',
    method: b.method || 'cash', note: b.note, createdBy: req.admin.username,
  });
  if (b.sendReceipt && invoice) {
    const c = await queryOne('SELECT name, email FROM customers WHERE id=$1', [invoice.customer_id]);
    if (c?.email) {
      await sendTemplated(req.tenant, 'receipt', c.email, {
        CUSTOMER_NAME: c.name, COMPANY_NAME: req.tenant.settings.branding.logoText || req.tenant.name,
        INVOICE_NUMBER: invoice.number, AMOUNT_PAID: formatCents(amount, req.tenant.currency),
        INVOICE_SUMMARY: summaryHtml(req.tenant, invoice),
      }, { type: 'invoice', id }).catch(() => {});
    }
  }
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'invoice_payment', entityType: 'invoice', entityId: id, details: { amount } });
  if (invoice?.status === 'paid') emitEvent('invoice.paid', { tenantId: req.tenant.id, invoiceId: id, customerId: invoice.customer_id }).catch(() => {});
  res.json({ ok: true, invoice });
}));

// --- Void -----------------------------------------------------------------
router.post('/:id/void', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const row = await queryOne("UPDATE invoices SET status='void', voided_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status<>'paid' RETURNING id", [req.tenant.id, id]);
  if (!row) return badRequest(res, 'Only unpaid invoices can be voided.');
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'invoice_void', entityType: 'invoice', entityId: id });
  res.json({ ok: true });
}));

export default router;
