// Recurring revenue: enroll customers in plans and generate the appointment +
// (draft) invoice for each cycle. Stripe-backed subscriptions bill themselves;
// internal subscriptions produce draft invoices staff send on demand.
import { query, queryOne } from './db.js';
import { getTenantById } from './tenants.js';
import { createAppointment, getService } from './appointments.js';
import { createInvoice } from './invoices.js';
import { zonedWallTimeToUtc, ymdInTimeZone } from './dates.js';

export function monthsForInterval(interval, intervalCount = 1) {
  return ({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 })[interval] || (intervalCount || 1);
}

export function addMonthsYmd(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

/** Create a subscription record (internal or Stripe-backed). */
export async function enrollSubscription(tenant, { customerId, planId, startDate, stripeSubscriptionId, notes }) {
  const plan = await queryOne('SELECT * FROM recurring_plans WHERE tenant_id=$1 AND id=$2', [tenant.id, planId]);
  if (!plan) throw new Error('Plan not found.');
  const start = startDate || ymdInTimeZone(new Date(), tenant.timezone);
  const next = addMonthsYmd(start, monthsForInterval(plan.interval, plan.interval_count));
  const row = await queryOne(
    `INSERT INTO subscriptions (tenant_id, customer_id, plan_id, status, interval, interval_count, price_cents, service_type_id, auto_schedule, auto_invoice, stripe_subscription_id, next_run_date, notes)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [tenant.id, customerId, planId, plan.interval, plan.interval_count, plan.price_cents, plan.service_type_id, plan.auto_schedule, plan.auto_invoice, stripeSubscriptionId || null, next, notes || null],
  );
  return row;
}

/** A Stripe renewal invoice was paid → record the revenue locally (idempotent). */
export async function handleStripeInvoicePaid(event) {
  const inv = event.data.object;
  const subId = inv.subscription;
  if (!subId || inv.billing_reason === 'subscription_create') return; // initial handled at checkout
  const sub = await queryOne('SELECT * FROM subscriptions WHERE stripe_subscription_id=$1', [subId]);
  if (!sub) return;
  const dup = await queryOne('SELECT id FROM financial_events WHERE tenant_id=$1 AND external_ref=$2', [sub.tenant_id, event.id]);
  if (dup) return;
  const tenant = await getTenantById(sub.tenant_id);
  const plan = await queryOne('SELECT name FROM recurring_plans WHERE id=$1', [sub.plan_id]);
  const amount = inv.amount_paid || sub.price_cents;
  const created = await createInvoice(tenant, {
    customerId: sub.customer_id, subscriptionId: sub.id,
    lineItems: [{ label: `${plan?.name || 'Recurring plan'} (renewal)`, quantity: 1, unit_amount_cents: amount, taxable: false }],
    taxRatePercent: 0,
  }, 'stripe');
  const { recordPayment } = await import('./invoices.js');
  await recordPayment(tenant, created.id, { amountCents: created.total_cents, method: 'stripe', externalRef: event.id, note: 'Stripe subscription renewal' });
}

/** Keep local subscription status in sync with Stripe (cancel / pause / resume). */
export async function syncStripeSubscriptionStatus(event) {
  const s = event.data.object;
  const subId = s.id;
  const row = await queryOne('SELECT id FROM subscriptions WHERE stripe_subscription_id=$1', [subId]);
  if (!row) return;
  let status = 'active';
  if (event.type === 'customer.subscription.deleted' || s.status === 'canceled') status = 'canceled';
  else if (['unpaid', 'past_due', 'paused'].includes(s.status)) status = 'paused';
  await query(
    'UPDATE subscriptions SET status=$2, canceled_at=CASE WHEN $2=\'canceled\' THEN now() ELSE canceled_at END, updated_at=now() WHERE id=$1',
    [row.id, status],
  );
}

/** Stripe subscription checkout completed → record/activate the subscription. */
export async function activateSubscriptionFromCheckout(event) {
  const session = event.data.object;
  const meta = session.metadata || {};
  const tenantId = Number.parseInt(meta.tenant_id, 10);
  const customerId = Number.parseInt(meta.customer_id, 10);
  const planId = Number.parseInt(meta.plan_id, 10);
  if (!tenantId || !customerId || !planId) return;
  const tenant = await getTenantById(tenantId);
  const existing = await queryOne('SELECT id FROM subscriptions WHERE tenant_id=$1 AND stripe_subscription_id=$2', [tenantId, session.subscription]);
  if (existing) return;
  await enrollSubscription(tenant, { customerId, planId, stripeSubscriptionId: session.subscription });
}

/** Generate the due cycle (appointment + draft invoice) for all due subscriptions. */
export async function generateDueCycles(tenant, { now = new Date() } = {}) {
  const today = ymdInTimeZone(now, tenant.timezone);
  const { rows } = await query(
    "SELECT * FROM subscriptions WHERE tenant_id=$1 AND status='active' AND next_run_date IS NOT NULL AND next_run_date <= $2",
    [tenant.id, today],
  );
  let appts = 0; let invoices = 0;
  for (const sub of rows) {
    const runYmd = ymdInTimeZone(new Date(sub.next_run_date), 'UTC');
    const service = sub.service_type_id ? await getService(tenant.id, sub.service_type_id) : null;
    let appointmentId = null;
    if (sub.auto_schedule) {
      const start = zonedWallTimeToUtc(runYmd, '09:00', tenant.timezone);
      const end = new Date(start.getTime() + (service?.duration_minutes || 60) * 60000);
      const appt = await createAppointment(tenant.id, {
        customerId: sub.customer_id, serviceTypeId: sub.service_type_id, subscriptionId: sub.id,
        status: 'scheduled', bookingMode: 'instant', source: 'recurring',
        scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), priceCents: sub.price_cents,
        internalNotes: 'Auto-generated from recurring plan.',
      });
      appointmentId = appt.id; appts += 1;
    }
    if (sub.auto_invoice && !sub.stripe_subscription_id) {
      const plan = await queryOne('SELECT name FROM recurring_plans WHERE id=$1', [sub.plan_id]);
      await createInvoice(tenant, {
        customerId: sub.customer_id, appointmentId, subscriptionId: sub.id,
        lineItems: [{ label: plan?.name || service?.name || 'Recurring service', quantity: 1, unit_amount_cents: sub.price_cents, taxable: true }],
      }, 'recurring');
      invoices += 1;
    }
    const nextRun = addMonthsYmd(runYmd, monthsForInterval(sub.interval, sub.interval_count));
    await query('UPDATE subscriptions SET last_run_date=$2, next_run_date=$3, updated_at=now() WHERE id=$1', [sub.id, runYmd, nextRun]);
  }
  return { subscriptions: rows.length, appointments: appts, invoices };
}

export default { monthsForInterval, addMonthsYmd, enrollSubscription, activateSubscriptionFromCheckout, generateDueCycles };
