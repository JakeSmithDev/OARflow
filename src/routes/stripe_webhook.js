// Stripe webhook. Multi-tenant aware: a single endpoint receives events from
// the platform Stripe account AND any tenant that configured its own keys.
//
// We peek the (unverified) payload to find tenant_id, load that tenant, then
// verify the signature with the tenant's webhook secret (falling back to the
// platform secret). We only act on a verified event.
import express from 'express';
import { config } from '../config.js';
import { getTenantById } from '../lib/tenants.js';
import { constructEvent, stripeSecret } from '../lib/stripe.js';
import { recordPayment } from '../lib/invoices.js';
import { activateSubscriptionFromCheckout } from '../lib/recurring.js';

const router = express.Router();

function toIntSafe(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; }

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing signature');

  // Peek tenant_id from the raw body (not yet trusted) to pick the right secret.
  let tenantId = null;
  try {
    const peek = JSON.parse(req.body.toString('utf8'));
    tenantId = toIntSafe(peek?.data?.object?.metadata?.tenant_id);
  } catch { /* not JSON */ }

  const tenant = tenantId ? await getTenantById(tenantId).catch(() => null) : null;

  // Verify with the tenant's secret if it has its own Stripe keys, else platform.
  let event = null;
  if (tenant && stripeSecret(tenant)) {
    try { event = constructEvent(tenant, req.body, sig); } catch { event = null; }
  }
  if (!event) {
    if (!config.stripe.secretKey || !config.stripe.webhookSecret) {
      return res.json({ received: true, ignored: true });
    }
    try { event = constructEvent(null, req.body, sig); }
    catch (err) { return res.status(400).send(`Webhook signature error: ${err.message}`); }
  }
  if (!event) return res.status(400).send('Unverified webhook');

  try {
    if (event.type === 'checkout.session.completed') {
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
        await activateSubscriptionFromCheckout(event).catch(() => {});
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('webhook handling error', err.message);
  }
  res.json({ received: true });
});

export default router;
