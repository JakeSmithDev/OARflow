// Stripe integration. Keys resolve per-tenant (settings.integrations.stripe)
// with a platform-level fallback (env). Everything no-ops cleanly when Stripe
// is not configured, so the app runs fully without it.
import Stripe from 'stripe';
import { config } from '../config.js';
import { decryptSecret } from './crypto.js';

// Fail CLOSED: if a tenant has its own stored secret but decryption fails
// (e.g. ENCRYPTION_KEY changed/missing), return '' rather than falling back to
// the platform key — never route a tenant's payments to the wrong Stripe account.
export function stripeSecret(tenant) {
  const stored = tenant?.settings?.integrations?.stripe?.secretKey || '';
  if (stored) return decryptSecret(stored);
  return config.stripe.secretKey || '';
}
export function publishableKey(tenant) {
  return tenant?.settings?.integrations?.stripe?.publishableKey || config.stripe.publishableKey || '';
}
export function webhookSecret(tenant) {
  const stored = tenant?.settings?.integrations?.stripe?.webhookSecret || '';
  if (stored) return decryptSecret(stored);
  return config.stripe.webhookSecret || '';
}

const cache = new Map();
export function getStripe(tenant) {
  const key = stripeSecret(tenant);
  if (!key) return null;
  if (!cache.has(key)) cache.set(key, new Stripe(key, { apiVersion: '2024-06-20' }));
  return cache.get(key);
}

export function isConfigured(tenant) { return Boolean(stripeSecret(tenant)); }

/** Create a one-off Checkout Session to pay an invoice balance. */
export async function createInvoiceCheckout(tenant, invoice, { balanceCents, customerEmail, successUrl, cancelUrl }) {
  const stripe = getStripe(tenant);
  if (!stripe) return null;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: (invoice.currency || tenant.currency || 'usd').toLowerCase(),
        unit_amount: balanceCents,
        product_data: { name: `${tenant.name} — Invoice ${invoice.number}` },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { kind: 'invoice', invoice_id: String(invoice.id), tenant_id: String(tenant.id) },
    payment_intent_data: { metadata: { kind: 'invoice', invoice_id: String(invoice.id), tenant_id: String(tenant.id) } },
  });
  return { id: session.id, url: session.url };
}

/** Create a Checkout Session to start a recurring subscription. */
export async function createSubscriptionCheckout(tenant, { plan, customerEmail, successUrl, cancelUrl, metadata }) {
  const stripe = getStripe(tenant);
  if (!stripe) return null;
  const intervalMap = { monthly: ['month', 1], quarterly: ['month', 3], semiannual: ['month', 6], annual: ['year', 1], custom: ['month', plan.interval_count || 1] };
  const [interval, count] = intervalMap[plan.interval] || ['month', 1];
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: (tenant.currency || 'usd').toLowerCase(),
        unit_amount: plan.price_cents,
        recurring: { interval, interval_count: count },
        product_data: { name: `${tenant.name} — ${plan.name}` },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: metadata || {},
    // Propagate tenant/customer/plan onto the subscription so renewal invoices
    // and lifecycle events can be attributed without a DB lookup.
    subscription_data: { metadata: metadata || {} },
  });
  return { id: session.id, url: session.url };
}

export function constructEvent(tenant, rawBody, signature) {
  const stripe = getStripe(tenant);
  const secret = webhookSecret(tenant);
  if (!stripe || !secret) return null;
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export default { getStripe, isConfigured, stripeSecret, publishableKey, webhookSecret, createInvoiceCheckout, createSubscriptionCheckout, constructEvent };
