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
import { attachFromSetupIntent } from '../lib/payments.js';
import { query, queryOne } from '../lib/db.js';
import { activateSubscriptionFromCheckout, handleStripeInvoicePaid, syncStripeSubscriptionStatus } from '../lib/recurring.js';
import { emitEvent } from '../lib/events.js';

const router = express.Router();
function toIntSafe(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; }

async function emitInvoicePaidIfInserted(tenantId, invoiceId, result) {
  if (!result?.duplicate && result?.invoice?.status === 'paid') {
    await emitEvent('invoice.paid', { tenantId, invoiceId, customerId: result.invoice.customer_id });
  }
}

function tenantWebhookExpected(tenant) {
  const stripe = tenant?.settings?.integrations?.stripe || {};
  return Boolean(stripe.secretKey || stripe.webhookSecret);
}

async function recordVerificationFailure(tenantId, message) {
  // eslint-disable-next-line no-console
  console.error(`stripe webhook verification failed for tenant ${tenantId || 'unknown'}: ${message}`);
  await query(
    'INSERT INTO job_runs (tenant_id, workflow, event_name, status, error) VALUES ($1,$2,$3,$4,$5)',
    [tenantId || null, 'stripe_webhook', 'stripe.webhook', 'error', message],
  ).catch(() => {});
}

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
  let tenantVerifyError = null;
  if (tenant && stripeSecret(tenant)) {
    try { event = constructEvent(tenant, req.body, sig); } catch (err) { tenantVerifyError = err; }
  }
  if (!event) {
    if (!config.stripe.secretKey || !config.stripe.webhookSecret) {
      if (tenantVerifyError || (tenant && tenantWebhookExpected(tenant))) {
        const message = tenantVerifyError?.message || 'Stripe webhook signing secret is not configured.';
        await recordVerificationFailure(tenantId, message);
        return res.status(400).send(`Webhook signature error: ${message}`);
      }
      return res.json({ received: true, ignored: true });
    }
    try { event = constructEvent(null, req.body, sig); }
    catch (err) {
      await recordVerificationFailure(tenantId, err.message);
      return res.status(400).send(`Webhook signature error: ${err.message}`);
    }
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
            const r = await recordPayment(t, invoiceId, {
              amountCents: session.amount_total, method: 'stripe',
              stripeRef: session.payment_intent || session.id, externalRef: event.id, note: 'Paid online via Stripe',
            });
            await emitInvoicePaidIfInserted(t.id, invoiceId, r);
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
      case 'setup_intent.succeeded': {
        // A customer added a card via the hosted save-card page.
        const si = event.data.object;
        const evTenantId = toIntSafe(si.metadata?.tenant_id);
        const custId = toIntSafe(si.metadata?.customer_id);
        if (evTenantId && custId) {
          const t = await getTenantById(evTenantId);
          const cust = t && await queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2', [evTenantId, custId]);
          if (t && cust) await attachFromSetupIntent(t, cust, si.id, { source: 'online', name: cust.name }).catch(() => {});
        }
        break;
      }
      case 'payment_intent.succeeded': {
        // Off-session card-on-file charge. Idempotent: externalRef = PaymentIntent id
        // (the synchronous charge path records with the same ref, so no double count).
        const pi = event.data.object;
        const meta = pi.metadata || {};
        const evTenantId = toIntSafe(meta.tenant_id);
        const invoiceId = toIntSafe(meta.invoice_id);
        if (meta.kind === 'card_on_file' && evTenantId && invoiceId) {
          const t = await getTenantById(evTenantId);
          if (t) {
            const r = await recordPayment(t, invoiceId, { amountCents: pi.amount_received ?? pi.amount, method: 'card_on_file', stripeRef: pi.id, externalRef: pi.id, note: 'Card on file' });
            await emitInvoicePaidIfInserted(t.id, invoiceId, r);
          }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncStripeSubscriptionStatus(event);
        break;
      default: break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('webhook handling error', err.message);
    return res.status(500).json({ error: 'handler_failed' });
  }
  res.json({ received: true });
});

export default router;
