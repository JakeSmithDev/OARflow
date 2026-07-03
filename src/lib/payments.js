// Saved cards / charge-on-file. Provider-abstracted so it works three ways:
//   • Stripe configured  → real SetupIntents + off_session PaymentIntents
//   • dev, not configured → MOCK: simulate a saved card + a successful charge
//   • prod, not configured → returns { notConfigured:true } (UI shows "not set up")
// We never store a PAN — only Stripe's tokenized payment_method id + last4/brand,
// plus an immutable authorization snapshot for card-on-file compliance.
import crypto from 'node:crypto';
import { query, queryOne, withTx } from './db.js';
import { getStripe, isConfigured, publishableKey } from './stripe.js';
import { recordPayment, balanceCents } from './invoices.js';
import { logAudit } from './audit.js';
import { config } from '../config.js';

export function cardsConfigured(tenant) { return isConfigured(tenant); }
/** Mock only when not configured AND not production — keeps dev fully usable. */
export function cardsMock(tenant) { return !isConfigured(tenant) && !config.isProduction; }
/** True when the feature can do *something* (real or simulated). */
export function cardsAvailable(tenant) { return cardsConfigured(tenant) || cardsMock(tenant); }

export function cardsStatus(tenant) {
  if (cardsConfigured(tenant)) return { available: true, mock: false };
  if (cardsMock(tenant)) return { available: true, mock: true };
  return { available: false, mock: false, notConfigured: true };
}

/** Ensure the customer has a provider customer id; returns it (or a mock one). */
export async function ensureProviderCustomer(tenant, customer) {
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  let id;
  if (cardsConfigured(tenant)) {
    const stripe = getStripe(tenant);
    const c = await stripe.customers.create({
      name: customer.name, email: customer.email || undefined, phone: customer.phone || undefined,
      metadata: { tenant_id: String(tenant.id), customer_id: String(customer.id) },
    });
    id = c.id;
  } else if (cardsMock(tenant)) {
    id = `mock_cus_${customer.id}`;
  } else {
    return null;
  }
  await query('UPDATE customers SET stripe_customer_id=$3 WHERE tenant_id=$1 AND id=$2', [tenant.id, customer.id, id]);
  return id;
}

/**
 * Begin collecting a card. Real: returns a SetupIntent client secret for Stripe
 * Elements. Mock: returns { mock:true } so the UI shows a simulated card form.
 */
export async function createSetupIntent(tenant, customer) {
  const st = cardsStatus(tenant);
  if (!st.available) return { ok: false, notConfigured: true };
  const providerCustomer = await ensureProviderCustomer(tenant, customer);
  if (st.mock) return { ok: true, mock: true, providerCustomer };
  const stripe = getStripe(tenant);
  const si = await stripe.setupIntents.create({
    customer: providerCustomer, usage: 'off_session',
    metadata: { tenant_id: String(tenant.id), customer_id: String(customer.id) },
  });
  return { ok: true, mock: false, clientSecret: si.client_secret, publishableKey: publishableKey(tenant), providerCustomer };
}

/** Store a payment method row (idempotent on provider_pm_id) + handle default. */
export async function recordPaymentMethod(tenant, customer, pm, consent = {}) {
  const providerCustomer = pm.providerCustomerId || customer.stripe_customer_id || null;
  const existing = await queryOne('SELECT count(*)::int n FROM payment_methods WHERE tenant_id=$1 AND customer_id=$2 AND status=$3', [tenant.id, customer.id, 'active']);
  const makeDefault = pm.isDefault ?? existing.n === 0;
  if (makeDefault) await query("UPDATE payment_methods SET is_default=FALSE WHERE tenant_id=$1 AND customer_id=$2 AND status='active'", [tenant.id, customer.id]);
  const row = await queryOne(
    `INSERT INTO payment_methods (tenant_id, customer_id, provider, provider_pm_id, provider_customer_id, brand, last4, exp_month, exp_year, is_default, is_mock, consent_name, consent_ip, consent_user_agent, consent_source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, provider_pm_id) DO UPDATE SET status='active', brand=EXCLUDED.brand, last4=EXCLUDED.last4, exp_month=EXCLUDED.exp_month, exp_year=EXCLUDED.exp_year, updated_at=now()
     RETURNING *`,
    [tenant.id, customer.id, pm.provider || 'stripe', pm.providerPmId, providerCustomer, pm.brand || null, pm.last4 || null,
     pm.expMonth || null, pm.expYear || null, makeDefault, Boolean(pm.isMock), consent.name || null, consent.ip || null,
     consent.userAgent || null, consent.source || 'in_person', consent.createdBy || null],
  );
  return row;
}

/** Confirm + store a card from a completed SetupIntent (real mode). */
export async function attachFromSetupIntent(tenant, customer, setupIntentId, consent = {}) {
  if (!cardsConfigured(tenant)) return { ok: false, notConfigured: true };
  const stripe = getStripe(tenant);
  const si = await stripe.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
  if (!si || si.status !== 'succeeded' || !si.payment_method) return { ok: false, error: 'Card setup was not completed.' };
  const pm = typeof si.payment_method === 'string' ? await stripe.paymentMethods.retrieve(si.payment_method) : si.payment_method;
  const card = pm.card || {};
  const row = await recordPaymentMethod(tenant, customer, {
    providerPmId: pm.id, providerCustomerId: si.customer, brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year,
  }, { ...consent, source: consent.source || 'online' });
  return { ok: true, paymentMethod: row };
}

/** Dev-only: fabricate a saved card so the whole flow is testable without Stripe. */
export async function attachMockCard(tenant, customer, { last4 = '4242', brand = 'visa', expMonth = 12, expYear = 2030 } = {}, consent = {}) {
  if (!cardsMock(tenant)) return { ok: false, error: 'Mock cards are only available in dev.' };
  const providerCustomer = await ensureProviderCustomer(tenant, customer);
  const row = await recordPaymentMethod(tenant, customer, {
    providerPmId: `mock_pm_${crypto.randomUUID()}`, providerCustomerId: providerCustomer, brand, last4, expMonth, expYear, isMock: true,
  }, consent);
  return { ok: true, paymentMethod: row };
}

export async function listPaymentMethods(tenant, customerId) {
  const r = await query("SELECT id, brand, last4, exp_month, exp_year, is_default, is_mock, consent_at, consent_name, consent_source, status FROM payment_methods WHERE tenant_id=$1 AND customer_id=$2 AND status='active' ORDER BY is_default DESC, id DESC", [tenant.id, customerId]);
  return r.rows;
}

export async function setDefaultPaymentMethod(tenant, customerId, pmId) {
  return withTx(async (cx) => {
    const current = await cx.query(
      "SELECT * FROM payment_methods WHERE tenant_id=$1 AND customer_id=$2 AND id=$3 AND status='active' FOR UPDATE",
      [tenant.id, customerId, pmId],
    );
    if (!current.rows.length) return null;
    await cx.query("UPDATE payment_methods SET is_default=FALSE WHERE tenant_id=$1 AND customer_id=$2 AND status='active'", [tenant.id, customerId]);
    const updated = await cx.query(
      "UPDATE payment_methods SET is_default=TRUE, updated_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND id=$3 AND status='active' RETURNING *",
      [tenant.id, customerId, pmId],
    );
    return updated.rows[0] || null;
  });
}

export async function removePaymentMethod(tenant, customerId, pmId) {
  const pm = await queryOne('SELECT * FROM payment_methods WHERE tenant_id=$1 AND customer_id=$2 AND id=$3', [tenant.id, customerId, pmId]);
  if (!pm) return { ok: false, error: 'Not found.' };
  if (cardsConfigured(tenant) && !pm.is_mock) { try { await getStripe(tenant).paymentMethods.detach(pm.provider_pm_id); } catch { /* already gone */ } }
  await query("UPDATE payment_methods SET status='removed', is_default=FALSE, updated_at=now() WHERE id=$1", [pm.id]);
  return { ok: true };
}

async function lockedChargeAmount(tenant, invoiceId, requestedAmountCents) {
  return withTx(async (cx) => {
    const invRow = await cx.query('SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenant.id, invoiceId]);
    if (!invRow.rows.length) return { ok: false, notFound: true, error: 'Invoice not found.' };
    const fresh = invRow.rows[0];
    if (fresh.status === 'void') return { ok: false, invoice: fresh, error: 'This invoice is void.' };
    const bal = balanceCents(fresh);
    if (bal <= 0) return { ok: false, invoice: fresh, error: 'This invoice has no balance due.' };
    const requested = requestedAmountCents == null ? bal : Math.round(Number(requestedAmountCents));
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, invoice: fresh, error: 'Enter a positive charge amount.' };
    return { ok: true, invoice: fresh, amountCents: Math.min(requested, bal), balanceCents: bal };
  });
}

async function refundCapturedPaymentIntent(stripe, tenant, pi, { invoiceId, createdBy, reason }) {
  try {
    const refund = await stripe.refunds.create({ payment_intent: pi.id });
    await logAudit({
      tenantId: tenant.id, adminUsername: createdBy, action: 'card_on_file_refund_after_recording_failure',
      entityType: 'invoice', entityId: invoiceId,
      details: { paymentIntent: pi.id, refundId: refund.id, amount: pi.amount_received ?? pi.amount, reason },
    });
    return { ok: true, refund };
  } catch (err) {
    await logAudit({
      tenantId: tenant.id, adminUsername: createdBy, action: 'card_on_file_refund_failed_after_recording_failure',
      entityType: 'invoice', entityId: invoiceId,
      details: { paymentIntent: pi.id, amount: pi.amount_received ?? pi.amount, reason, error: err?.raw?.message || err.message },
    });
    return { ok: false, error: err?.raw?.message || err.message || 'refund_failed' };
  }
}

/**
 * Charge an invoice to a saved card. Requires a stored authorization. Records
 * the payment in the same ledger as every other payment (idempotent on the
 * PaymentIntent id). Mock mode simulates a successful capture.
 */
export async function chargeInvoiceOnFile(tenant, invoice, { paymentMethodId, amountCents, createdBy, idempotencyKey }) {
  const st = cardsStatus(tenant);
  if (!st.available) return { ok: false, notConfigured: true };
  if (invoice.status === 'void') return { ok: false, error: 'This invoice is void.' };
  const locked = await lockedChargeAmount(tenant, invoice.id, amountCents);
  if (!locked.ok) return { ok: false, notFound: locked.notFound, error: locked.error };
  const amount = locked.amountCents;
  const pm = await queryOne("SELECT * FROM payment_methods WHERE tenant_id=$1 AND customer_id=$2 AND id=$3 AND status='active'", [tenant.id, locked.invoice.customer_id, paymentMethodId]);
  if (!pm) return { ok: false, error: 'No saved card found for this customer.' };
  if (!pm.consent_at) return { ok: false, error: 'This card has no stored authorization.' };

  if (st.mock || pm.is_mock) {
    const ref = idempotencyKey ? `mock_pi_${idempotencyKey}` : `mock_pi_${crypto.randomUUID()}`;
    const r = await recordPayment(tenant, invoice.id, { amountCents: amount, method: 'card_on_file', stripeRef: ref, externalRef: ref, note: `Card on file ••${pm.last4 || ''} (simulated)`, createdBy });
    if (r.duplicate) return { ok: true, duplicate: true, mock: true, invoice: r.invoice, amountCents: amount };
    if (r.rejected) return { ok: false, error: r.rejected === 'overpay' ? 'This invoice was already paid by a concurrent charge.' : 'The invoice could not be charged.' };
    return { ok: true, mock: true, invoice: r.invoice, amountCents: amount };
  }

  const stripe = getStripe(tenant);
  let pi;
  try {
    const params = {
      amount, currency: (tenant.currency || 'usd').toLowerCase(), customer: pm.provider_customer_id || undefined,
      payment_method: pm.provider_pm_id, off_session: true, confirm: true,
      metadata: { kind: 'card_on_file', tenant_id: String(tenant.id), invoice_id: String(invoice.id) },
    };
    pi = await stripe.paymentIntents.create(params, idempotencyKey ? { idempotencyKey } : undefined);
  } catch (err) {
    return { ok: false, error: err?.raw?.message || err.message || 'The card was declined.' };
  }
  if (pi.status !== 'succeeded') return { ok: false, error: `Charge ${pi.status}. The customer may need to authorize this card.`, requiresAction: pi.status === 'requires_action' };
  // externalRef = PaymentIntent id so the webhook can't double-count.
  let r;
  try {
    r = await recordPayment(tenant, invoice.id, { amountCents: pi.amount_received ?? amount, method: 'card_on_file', stripeRef: pi.id, externalRef: pi.id, note: `Card on file ••${pm.last4 || ''}`, createdBy });
  } catch (err) {
    const refund = await refundCapturedPaymentIntent(stripe, tenant, pi, { invoiceId: invoice.id, createdBy, reason: err.message || 'record_payment_failed' });
    return {
      ok: false,
      paymentIntentId: pi.id,
      refunded: refund.ok,
      error: refund.ok
        ? 'The charge could not be recorded on the invoice. The Stripe charge was refunded.'
        : `The charge could not be recorded on the invoice. Automatic refund failed: ${refund.error}`,
    };
  }
  if (r.duplicate) return { ok: true, duplicate: true, mock: false, invoice: r.invoice, amountCents: pi.amount_received ?? amount };
  if (r.rejected || r.notFound) {
    const refund = await refundCapturedPaymentIntent(stripe, tenant, pi, { invoiceId: invoice.id, createdBy, reason: r.rejected || 'not_found' });
    const message = r.rejected === 'overpay'
      ? 'The invoice was paid before this charge could be recorded.'
      : 'The charge could not be recorded on the invoice.';
    return {
      ok: false,
      paymentIntentId: pi.id,
      refunded: refund.ok,
      error: refund.ok ? `${message} The Stripe charge was refunded.` : `${message} Automatic refund failed: ${refund.error}`,
    };
  }
  return { ok: true, mock: false, invoice: r.invoice, amountCents: pi.amount_received ?? amount };
}

export default {
  cardsConfigured, cardsMock, cardsAvailable, cardsStatus, ensureProviderCustomer, createSetupIntent,
  recordPaymentMethod, attachFromSetupIntent, attachMockCard, listPaymentMethods, setDefaultPaymentMethod,
  removePaymentMethod, chargeInvoiceOnFile,
};
