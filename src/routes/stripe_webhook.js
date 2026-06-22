// Stripe webhook. Verifies the signature with the platform webhook secret,
// then records invoice payments and activates subscriptions idempotently.
import express from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { getTenantById } from '../lib/tenants.js';
import { recordPayment } from '../lib/invoices.js';
import { activateSubscriptionFromCheckout } from '../lib/recurring.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = config.stripe.webhookSecret;
  if (!config.stripe.secretKey || !secret) {
    // Stripe not configured in this environment — acknowledge and ignore.
    return res.json({ received: true, ignored: true });
  }
  let event;
  try {
    const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2024-06-20' });
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};
      const tenantId = toIntSafe(meta.tenant_id);
      if (session.mode === 'payment' && meta.kind === 'invoice' && tenantId) {
        const tenant = await getTenantById(tenantId);
        const invoiceId = toIntSafe(meta.invoice_id);
        if (tenant && invoiceId) {
          await recordPayment(tenant, invoiceId, {
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

function toIntSafe(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; }

export default router;
