// Admin invoicing. Build a customizable invoice (presets + custom lines), send
// the balance ON DEMAND (never automatically), record payments, void.
import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { createInvoice, updateInvoice, recordPayment, balanceCents } from '../../lib/invoices.js';
import { sendTemplated, htmlEscape } from '../../lib/email_templates.js';
import { ownsId } from '../../lib/ownership.js';
import { emitEvent } from '../../lib/events.js';
import { isConfigured as stripeConfigured } from '../../lib/stripe.js';
import { listPaymentMethods, chargeInvoiceOnFile, cardsStatus } from '../../lib/payments.js';
import { requireWrite, requirePermission } from '../../lib/permissions.js';
import { logAudit } from '../../lib/audit.js';
import { formatCents } from '../../lib/money.js';
import { config } from '../../config.js';
import { toCsv } from '../../lib/csv.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('invoices.manage')); // create/update/send gated; reads open
// Money movement is a stricter capability than building invoices.
router.use(['/:id/payment', '/:id/charge-on-file', '/:id/void'], requirePermission('payments.manage'));

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
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = toInt(req.query.offset) || 0;
  const where = ['i.tenant_id=$1']; const params = [tenantId];
  if (status && status !== 'all') { params.push(status); where.push(`i.status=$${params.length}`); }
  if (customerId) { params.push(customerId); where.push(`i.customer_id=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR i.number ILIKE $${params.length})`); }
  const countParams = params.slice();
  params.push(limit); params.push(offset);
  const rows = await query(
    `SELECT i.id, i.number, i.status, i.total_cents, i.amount_paid_cents, i.created_at, i.sent_at, i.due_date,
            c.name AS customer_name
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await queryOne(`SELECT count(*)::int n FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE ${where.join(' AND ')}`, countParams);
  const summary = await query(
    `SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent','partial') THEN total_cents-amount_paid_cents ELSE 0 END),0)::bigint AS outstanding,
        COALESCE(SUM(CASE WHEN status='draft' THEN total_cents ELSE 0 END),0)::bigint AS draft,
        COALESCE(SUM(amount_paid_cents),0)::bigint AS collected
       FROM invoices WHERE tenant_id=$1`,
    [tenantId],
  );
  res.json({ ok: true, invoices: rows.rows, summary: summary.rows[0], total: total.n });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const { status, q } = req.query;
  const customerId = toInt(req.query.customerId);
  const where = ['i.tenant_id=$1']; const params = [req.tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`i.status=$${params.length}`); }
  if (customerId) { params.push(customerId); where.push(`i.customer_id=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR i.number ILIKE $${params.length})`); }
  const rows = await query(
    `SELECT i.number, i.status, i.currency, i.total_cents, i.amount_paid_cents,
            (i.total_cents-i.amount_paid_cents) AS balance_cents, i.created_at, i.sent_at, i.due_date,
            c.name AS customer_name, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC`,
    params,
  );
  const csv = toCsv([
    { key: 'number', label: 'number' }, { key: 'status', label: 'status' }, { key: 'customer_name', label: 'customer_name' },
    { key: 'customer_email', label: 'customer_email' }, { key: 'currency', label: 'currency' }, { key: 'total_cents', label: 'total_cents' },
    { key: 'amount_paid_cents', label: 'amount_paid_cents' }, { key: 'balance_cents', label: 'balance_cents' },
    { key: 'created_at', label: 'created_at' }, { key: 'sent_at', label: 'sent_at' }, { key: 'due_date', label: 'due_date' },
  ], rows.rows);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="invoices_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const inv = await queryOne(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city, c.state AS customer_state, c.postal_code AS customer_postal
       FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.tenant_id=$1 AND i.id=$2`,
    [req.tenant.id, id],
  );
  if (!inv) return notFound(res);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brand = req.tenant.settings.branding || {};
  const draw = (text, x, y, size = 10, f = font, color = rgb(0.08, 0.12, 0.2)) => page.drawText(String(text ?? ''), { x, y, size, font: f, color });
  const line = (y) => page.drawLine({ start: { x: 48, y }, end: { x: 564, y }, thickness: 1, color: rgb(0.88, 0.9, 0.94) });
  let y = 736;
  draw(brand.logoText || req.tenant.name, 48, y, 18, bold, rgb(0.04, 0.15, 0.25));
  draw('INVOICE', 468, y + 2, 16, bold);
  y -= 22;
  draw(req.tenant.address || '', 48, y, 9);
  draw(inv.number, 468, y, 11, bold);
  y -= 16;
  draw(req.tenant.contact_phone || brand.supportPhone || '', 48, y, 9);
  draw(`Status: ${inv.status}`, 468, y, 9);
  y -= 34;
  line(y + 16);
  draw('Bill to', 48, y, 10, bold);
  draw(inv.customer_name, 48, y - 16, 11, bold);
  draw([inv.customer_address, inv.customer_city, inv.customer_state, inv.customer_postal].filter(Boolean).join(', '), 48, y - 31, 9);
  draw('Created', 380, y, 9, bold); draw(String(inv.created_at).slice(0, 10), 468, y, 9);
  if (inv.due_date) { draw('Due', 380, y - 15, 9, bold); draw(String(inv.due_date).slice(0, 10), 468, y - 15, 9); }
  y -= 72;
  line(y + 24);
  draw('Description', 48, y, 10, bold);
  draw('Qty', 360, y, 10, bold);
  draw('Amount', 480, y, 10, bold);
  line(y - 8);
  y -= 28;
  for (const li of inv.line_items || []) {
    if (y < 170) break;
    draw(li.label || 'Item', 48, y, 10);
    draw(li.quantity || 1, 365, y, 10);
    draw(formatCents(li.amount_cents || 0, inv.currency), 480, y, 10);
    y -= 18;
  }
  y -= 8;
  line(y);
  y -= 20;
  const totals = [
    ['Subtotal', inv.subtotal_cents],
    inv.discount_cents ? ['Discount', -inv.discount_cents] : null,
    inv.tax_cents ? ['Tax', inv.tax_cents] : null,
    ['Total', inv.total_cents],
    inv.amount_paid_cents ? ['Paid', -inv.amount_paid_cents] : null,
    ['Balance due', balanceCents(inv)],
  ].filter(Boolean);
  for (const [label, amount] of totals) {
    draw(label, 380, y, label === 'Balance due' ? 12 : 10, label === 'Balance due' ? bold : font);
    draw(formatCents(amount, inv.currency), 480, y, label === 'Balance due' ? 12 : 10, label === 'Balance due' ? bold : font);
    y -= 17;
  }
  if (inv.terms || inv.notes) {
    y -= 20; line(y + 12);
    draw('Notes', 48, y, 10, bold);
    draw([inv.terms, inv.notes].filter(Boolean).join('  '), 48, y - 16, 9);
  }
  const bytes = await pdf.save();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
  res.send(Buffer.from(bytes));
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
    'SELECT id, event_type, amount_cents, method, note, created_at, created_by FROM financial_events WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY created_at',
    [req.tenant.id, id],
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
  const result = await recordPayment(req.tenant, id, {
    amountCents: amount, eventType: amount < 0 ? 'refund' : 'payment',
    method: b.method || 'cash', note: b.note, createdBy: req.admin.username,
  });
  if (result.rejected === 'overpay') return badRequest(res, `Payment exceeds the balance due (${formatCents(result.balanceCents, req.tenant.currency)}).`);
  if (result.rejected === 'void') return badRequest(res, 'This invoice is void and cannot take payments.');
  if (result.rejected === 'over_refund') return badRequest(res, `Refund exceeds the amount collected (${formatCents(result.balanceCents, req.tenant.currency)}).`);
  const { invoice } = result;
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
