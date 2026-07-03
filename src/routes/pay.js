// Public pay-invoice API (no auth; guarded by the invoice's access token).
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt } from '../lib/http.js';
import { queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { balanceCents } from '../lib/invoices.js';
import { isConfigured as stripeConfigured, createInvoiceCheckout } from '../lib/stripe.js';
import { cardsStatus, listPaymentMethods, chargeInvoiceOnFile } from '../lib/payments.js';
import { rateLimit } from '../lib/rate_limit.js';
import { safeEqual } from '../lib/crypto.js';
import { config } from '../config.js';
import { logAudit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

const router = express.Router();
const limitView = rateLimit({ endpoint: 'pay_get', windowMinutes: 10, maxCount: 60 });
const limitCheckout = rateLimit({ endpoint: 'pay_checkout', windowMinutes: 10, maxCount: 10 });

async function loadInvoice(id, token) {
  const inv = await queryOne(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`,
    [id],
  );
  if (!inv || !safeEqual(inv.access_token, token)) return null;
  return inv;
}

router.get('/:id', limitView, asyncHandler(async (req, res) => {
  const inv = await loadInvoice(toInt(req.params.id), String(req.query.token || ''));
  if (!inv) return notFound(res, 'Invoice not found.');
  const tenant = await getTenantById(inv.tenant_id);
  const cards = cardsStatus(tenant);
  const savedCards = cards.available ? await listPaymentMethods(tenant, inv.customer_id) : [];
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
    cards,
    savedCards: savedCards.map((pm) => ({ id: pm.id, brand: pm.brand, last4: pm.last4, expMonth: pm.exp_month, expYear: pm.exp_year, isDefault: pm.is_default, isMock: pm.is_mock })),
    paid: inv.status === 'paid',
    voided: inv.status === 'void',
  });
}));

router.post('/:id/charge-saved', limitCheckout, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const inv = await loadInvoice(toInt(req.params.id), String(body.token || ''));
  if (!inv) return notFound(res, 'Invoice not found.');
  if (inv.status === 'void') return badRequest(res, 'This invoice is no longer payable.');
  if (inv.status === 'paid') return res.json({ ok: true, paid: true });
  const tenant = await getTenantById(inv.tenant_id);
  const paymentMethodId = toInt(body.paymentMethodId);
  if (!paymentMethodId) return badRequest(res, 'Choose a saved card.');
  const idempotencyKey = `pay_saved_${tenant.id}_${inv.id}_${paymentMethodId}`;
  const r = await chargeInvoiceOnFile(tenant, inv, { paymentMethodId, createdBy: 'public_pay', idempotencyKey });
  if (!r.ok) return badRequest(res, r.error || (r.notConfigured ? 'Card payments are not set up.' : 'The charge could not be completed.'));
  await logAudit({ tenantId: tenant.id, action: 'public_invoice_charge_saved', entityType: 'invoice', entityId: inv.id, details: { paymentMethodId, amount: r.amountCents, mock: r.mock, duplicate: r.duplicate } });
  if (r.invoice?.status === 'paid') emitEvent('invoice.paid', { tenantId: tenant.id, invoiceId: inv.id, customerId: r.invoice.customer_id }).catch(() => {});
  res.json({ ok: true, paid: r.invoice?.status === 'paid', mock: r.mock, duplicate: r.duplicate, invoice: { status: r.invoice?.status, balanceCents: r.invoice ? balanceCents(r.invoice) : 0 } });
}));

router.post('/:id/checkout', limitCheckout, asyncHandler(async (req, res) => {
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
