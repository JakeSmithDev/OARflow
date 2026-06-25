// Public pay-invoice API (no auth; guarded by the invoice's access token).
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt } from '../lib/http.js';
import { queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { balanceCents } from '../lib/invoices.js';
import { isConfigured as stripeConfigured, createInvoiceCheckout } from '../lib/stripe.js';
import { config } from '../config.js';

const router = express.Router();

async function loadInvoice(id, token) {
  const inv = await queryOne(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`,
    [id],
  );
  if (!inv || inv.access_token !== token) return null;
  return inv;
}

router.get('/:id', asyncHandler(async (req, res) => {
  const inv = await loadInvoice(toInt(req.params.id), String(req.query.token || ''));
  if (!inv) return notFound(res, 'Invoice not found.');
  const tenant = await getTenantById(inv.tenant_id);
  res.json({
    ok: true,
    invoice: {
      number: inv.number, status: inv.status, currency: inv.currency,
      lineItems: inv.line_items, subtotalCents: inv.subtotal_cents, discountCents: inv.discount_cents,
      taxCents: inv.tax_cents, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents,
      balanceCents: balanceCents(inv), dueDate: inv.due_date, notes: inv.notes, terms: inv.terms,
    },
    tenant: { name: tenant.name, branding: tenant.settings.branding, timezone: tenant.timezone },
    stripeEnabled: stripeConfigured(tenant),
    paid: inv.status === 'paid',
    voided: inv.status === 'void',
  });
}));

router.post('/:id/checkout', asyncHandler(async (req, res) => {
  const inv = await loadInvoice(toInt(req.params.id), String((req.body || {}).token || ''));
  if (!inv) return notFound(res, 'Invoice not found.');
  if (inv.status === 'void') return badRequest(res, 'This invoice is no longer payable.');
  if (inv.status === 'paid') return badRequest(res, 'This invoice is already paid.');
  const tenant = await getTenantById(inv.tenant_id);
  if (!stripeConfigured(tenant)) return res.json({ ok: false, error: 'Online payment is not enabled. Please contact us to pay.' });
  const bal = balanceCents(inv);
  if (bal <= 0) return badRequest(res, 'Nothing due.');
  const base = `${config.baseUrl}/pay?invoice=${inv.id}&token=${inv.access_token}`;
  const session = await createInvoiceCheckout(tenant, inv, {
    balanceCents: bal, customerEmail: inv.customer_email,
    successUrl: `${base}&paid=1`, cancelUrl: base,
  });
  if (!session) return badRequest(res, 'Could not start checkout.');
  await queryOne('UPDATE invoices SET stripe_checkout_session_id=$2 WHERE id=$1 RETURNING id', [inv.id, session.id]);
  res.json({ ok: true, url: session.url });
}));

export default router;
