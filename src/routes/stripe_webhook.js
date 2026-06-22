// Stripe webhook. Multi-tenant aware: a single endpoint receives events from
// the platform Stripe account AND any tenant that configured its own keys.
//
// We peek the (unverified) payload to find the tenant (via metadata.tenant_id,
// or by looking up the subscription id), load that tenant, then verify the
// signature with the tenant's webhook secret (falling back to the platform
// secret). We only act on a verified event.
import express from 'express';
import { config } from '../config.js';
import { getTenantById } from '../lib/tenants.js';
import { constructEvent, stripeSecret } from '../lib/stripe.js';
import { recordPayment } from '../lib/invoices.js';
import { queryOne } from '../lib/db.js';
import { activateSubscriptionFromCheckout, handleStripeInvoicePaid, syncStripeSubscriptionStatus } from '../lib/recurring.js';

const router = express.Router();
function toIntSafe(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; }

async function resolveTenantId(obj) {
  let tenantId = toIntSafe(obj?.metadata?.tenant_id);
  if (tenantId) return tenantId;
  const subId = obj?.object === 'subscription' ? obj.id : obj?.subscription;
  if (subId) {
    const row = await queryOne('SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id=$1', [subId]);
    if (row) return row.tenant_id;
  }
  return null;
}

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing signature');

  let obj = null;
  try { obj = JSON.parse(req.body.toString('utf8'))?.data?.object || null; } catch { /* not JSON */ }
  const tenantId = obj ? await resolveTenantId(obj) : null;
  const tenant = tenantId ? await getTenantById(tenantId).catch(() => null) : null;

  let event = null;
  if (tenant && stripeSecret(tenant)) {
    try { event = constructEvent(tenant, req.body, sig); } catch { event = null; }
  }
  if (!event) {
    if (!config.stripe.secretKey || !config.stripe.webhookSecret) return res.json({ received: true, ignored: true });
    try { event = constructEvent(null, req.body, sig); }
    catch (err) { return res.status(400).send(`Webhook signature error: ${err.message}`); }
  }
  if (!event) return res.status(400).send('Unverified webhook');

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const meta = session.metadata || {};
        const evTenantId = toIntSafe(meta.tenant_id);
        if (session.mode === 'payment' && meta.kind === 'invoice' && evTenantId) {
          const t = await getTenantById(evTenantId);
          const invoiceId = toIntSafe(meta.invoice_id);
          if (t && invoiceId) {
            await recordPayment(t, invoiceId, {
              amountCents: session.amount_total, method: 'stripe',
              stripeRef: session.payment_intent || session.id, externalRef: event.id, note: 'Paid online via Stripe',
            });
          }
        } else if (session.mode === 'subscription') {
          await activateSubscriptionFromCheckout(event);
        }
        break;
      }
      case 'invoice.payment_succeeded':
      case 'invoice.paid':
        await handleStripeInvoicePaid(event);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncStripeSubscriptionStatus(event);
        break;
      default: break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('webhook handling error', err.message);
  }
  res.json({ received: true });
});

export default router;
