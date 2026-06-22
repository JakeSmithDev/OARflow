// Recurring plans (templates) + subscriptions (customer enrollments).
import express from 'express';
import { requireAdmin, requireRole } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { enrollSubscription, generateDueCycles, monthsForInterval } from '../../lib/recurring.js';
import { createSubscriptionCheckout, isConfigured as stripeConfigured } from '../../lib/stripe.js';
import { logAudit } from '../../lib/audit.js';
import { ownsId } from '../../lib/ownership.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

function mrrOf(rows) {
  let mrr = 0;
  for (const s of rows) mrr += Math.round(s.price_cents / monthsForInterval(s.interval, s.interval_count));
  return mrr;
}

// --- Plans + subscriptions overview --------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const plans = await query(
    `SELECT p.*, s.name AS service_name,
            (SELECT count(*) FROM subscriptions su WHERE su.plan_id=p.id AND su.status='active')::int AS active_count
       FROM recurring_plans p LEFT JOIN service_types s ON s.id=p.service_type_id
      WHERE p.tenant_id=$1 ORDER BY p.sort_order, p.name`,
    [tenantId],
  );
  const subs = await query(
    `SELECT su.*, c.name AS customer_name, p.name AS plan_name
       FROM subscriptions su JOIN customers c ON c.id=su.customer_id LEFT JOIN recurring_plans p ON p.id=su.plan_id
      WHERE su.tenant_id=$1 ORDER BY su.status, su.next_run_date NULLS LAST`,
    [tenantId],
  );
  const active = subs.rows.filter((s) => s.status === 'active');
  const services = await query('SELECT id, name, duration_minutes FROM service_types WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, name', [tenantId]);
  const mrr = mrrOf(active);
  res.json({ ok: true, plans: plans.rows, subscriptions: subs.rows, services: services.rows, metrics: { mrrCents: mrr, arrCents: mrr * 12, activeSubs: active.length }, stripeEnabled: stripeConfigured(req.tenant) });
}));

// --- Create / update / archive plan (owner-only) -------------------------
router.post('/', requireRole('owner'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'Plan name is required.');
  const row = await queryOne(
    `INSERT INTO recurring_plans (tenant_id, name, description, interval, interval_count, price_cents, service_type_id, auto_schedule, auto_invoice, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.tenant.id, b.name, b.description || null, b.interval || 'quarterly', toInt(b.intervalCount) || 1,
     Math.round(b.priceCents || 0), toInt(b.serviceTypeId) || null, b.autoSchedule !== false, b.autoInvoice !== false, toInt(b.sortOrder) || 0],
  );
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'plan_create', entityType: 'recurring_plan', entityId: row.id });
  res.json({ ok: true, plan: row });
}));

router.patch('/:id', requireRole('owner'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id); const b = req.body || {};
  const cols = { name: b.name, description: b.description, interval: b.interval, interval_count: toInt(b.intervalCount), price_cents: b.priceCents != null ? Math.round(b.priceCents) : undefined, service_type_id: b.serviceTypeId !== undefined ? (toInt(b.serviceTypeId) || null) : undefined, auto_schedule: b.autoSchedule, auto_invoice: b.autoInvoice, is_active: b.isActive };
  const sets = []; const params = [id, req.tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  sets.push('updated_at=now()');
  const row = await queryOne(`UPDATE recurring_plans SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, plan: row });
}));

// --- Subscriptions --------------------------------------------------------
router.post('/subscriptions', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const customerId = toInt(b.customerId); const planId = toInt(b.planId);
  if (!customerId || !planId) return badRequest(res, 'Customer and plan are required.');
  if (!(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  if (!(await ownsId(req.tenant.id, 'recurring_plans', planId))) return badRequest(res, 'Unknown plan.');

  if (b.useStripe) {
    if (!stripeConfigured(req.tenant)) return badRequest(res, 'Stripe is not connected.');
    const plan = await queryOne('SELECT * FROM recurring_plans WHERE tenant_id=$1 AND id=$2', [req.tenant.id, planId]);
    const customer = await queryOne('SELECT name, email FROM customers WHERE id=$1', [customerId]);
    const sess = await createSubscriptionCheckout(req.tenant, {
      plan, customerEmail: customer?.email,
      successUrl: `${config.baseUrl}/admin/plans?enrolled=1`, cancelUrl: `${config.baseUrl}/admin/plans`,
      metadata: { kind: 'subscription', tenant_id: String(req.tenant.id), customer_id: String(customerId), plan_id: String(planId) },
    });
    return res.json({ ok: true, checkoutUrl: sess?.url });
  }

  const sub = await enrollSubscription(req.tenant, { customerId, planId, startDate: b.startDate, notes: b.notes });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'subscription_enroll', entityType: 'subscription', entityId: sub.id });
  res.json({ ok: true, subscription: sub });
}));

router.patch('/subscriptions/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id); const status = req.body?.status;
  if (!['active', 'paused', 'canceled'].includes(status)) return badRequest(res, 'Invalid status.');
  const row = await queryOne(
    `UPDATE subscriptions SET status=$3, canceled_at=CASE WHEN $3='canceled' THEN now() ELSE canceled_at END, updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [req.tenant.id, id, status],
  );
  if (!row) return notFound(res);
  res.json({ ok: true, subscription: row });
}));

// --- Generate due cycles (manual trigger; also runs via cron) ------------
router.post('/generate-due', asyncHandler(async (req, res) => {
  const result = await generateDueCycles(req.tenant);
  res.json({ ok: true, ...result });
}));

export default router;
