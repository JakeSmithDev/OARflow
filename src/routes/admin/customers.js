// Admin customers (CRM): list with rollups, detail with full history, create/update.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt, getClientIp } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { logAudit } from '../../lib/audit.js';
import { requireWrite, requirePermission } from '../../lib/permissions.js';
import { randomToken } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { toCsv, parseCsv } from '../../lib/csv.js';
import {
  cardsStatus, createSetupIntent, attachFromSetupIntent, attachMockCard,
  listPaymentMethods, setDefaultPaymentMethod, removePaymentMethod,
} from '../../lib/payments.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('customers.manage')); // reads open to admins; writes gated
// Saving/charging cards is a payments action — stricter than customers.manage.
router.use(['/:id/setup-intent', '/:id/payment-methods', '/:id/payment-methods/:pmId', '/:id/payment-methods/:pmId/default'], (req, res, next) => (req.method === 'GET' ? next() : requirePermission('payments.manage')(req, res, next)));

async function loadCustomer(req) { return queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(req.params.id)]); }
const phoneKey = (s) => String(s || '').replace(/\D/g, '').slice(-10);

router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const q = req.query.q;
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = toInt(req.query.offset) || 0;
  const where = ['c.tenant_id=$1']; const params = [tenantId];
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length})`); }
  params.push(limit); params.push(offset);
  const rows = await query(
    `SELECT c.id, c.name, c.email, c.phone, c.address, c.city, c.state, c.created_at,
            (SELECT count(*) FROM appointments a WHERE a.tenant_id=c.tenant_id AND a.customer_id=c.id)::int AS appt_count,
            (SELECT COALESCE(SUM(amount_cents),0) FROM financial_events fe WHERE fe.tenant_id=c.tenant_id AND fe.customer_id=c.id AND fe.event_type='payment')::bigint AS ltv_cents,
            (SELECT COALESCE(SUM(total_cents-amount_paid_cents),0) FROM invoices i WHERE i.tenant_id=c.tenant_id AND i.customer_id=c.id AND i.status IN ('sent','partial'))::bigint AS balance_cents,
            (SELECT count(*) FROM subscriptions su WHERE su.tenant_id=c.tenant_id AND su.customer_id=c.id AND su.status='active')::int AS active_subs
       FROM customers c WHERE ${where.join(' AND ')}
      ORDER BY c.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await queryOne(`SELECT count(*)::int n FROM customers c WHERE ${where.slice(0, q ? 2 : 1).join(' AND ')}`, params.slice(0, q ? 2 : 1));
  res.json({ ok: true, customers: rows.rows, total: total.n });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const q = req.query.q;
  const where = ['tenant_id=$1']; const params = [req.tenant.id];
  if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
  const rows = await query(
    `SELECT name, email, phone, address, city, state, postal_code, notes, created_at
       FROM customers WHERE ${where.join(' AND ')} ORDER BY name`,
    params,
  );
  const csv = toCsv([
    { key: 'name', label: 'name' }, { key: 'email', label: 'email' }, { key: 'phone', label: 'phone' },
    { key: 'address', label: 'address' }, { key: 'city', label: 'city' }, { key: 'state', label: 'state' },
    { key: 'postal_code', label: 'postal_code' }, { key: 'notes', label: 'notes' }, { key: 'created_at', label: 'created_at' },
  ], rows.rows);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="customers_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

router.post('/import', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const dryRun = b.dryRun !== false;
  const rows = parseCsv(b.csv).slice(0, 1000);
  if (!rows.length) return badRequest(res, 'Upload a CSV with at least one row.');
  const existing = await query('SELECT id, email, phone FROM customers WHERE tenant_id=$1', [req.tenant.id]);
  const emails = new Set(existing.rows.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean));
  const phones = new Set(existing.rows.map((r) => phoneKey(r.phone)).filter(Boolean));
  const batchEmails = new Set(); const batchPhones = new Set();
  const preview = rows.map((r) => {
    const email = String(r.email || '').trim().toLowerCase();
    const phone = String(r.phone || '').trim();
    const pkey = phoneKey(phone);
    const out = {
      row: r.row, name: r.name || '', email, phone, address: r.address || '', city: r.city || '', state: r.state || '',
      postalCode: r.postal_code || r.zip || r.postalcode || '', notes: r.notes || '', status: 'valid', errors: [],
    };
    if (!out.name) out.errors.push('Name is required.');
    if (email && (emails.has(email) || batchEmails.has(email))) out.errors.push('Duplicate email.');
    if (pkey && (phones.has(pkey) || batchPhones.has(pkey))) out.errors.push('Duplicate phone.');
    if (email) batchEmails.add(email);
    if (pkey) batchPhones.add(pkey);
    if (out.errors.length) out.status = out.errors.some((e) => /^Duplicate/.test(e)) ? 'duplicate' : 'error';
    return out;
  });
  if (dryRun) {
    return res.json({ ok: true, dryRun: true, rows: preview, summary: { total: preview.length, valid: preview.filter((r) => r.status === 'valid').length, duplicates: preview.filter((r) => r.status === 'duplicate').length, errors: preview.filter((r) => r.status === 'error').length } });
  }
  const valid = preview.filter((r) => r.status === 'valid');
  const inserted = [];
  for (const r of valid) {
    const row = await queryOne(
      `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.tenant.id, r.name, r.email || null, r.phone || null, r.address || null, r.city || null, r.state || null, r.postalCode || null, r.notes || null],
    );
    inserted.push(row.id);
  }
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'customer_import', entityType: 'customer', details: { inserted: inserted.length, skipped: preview.length - inserted.length } });
  res.json({ ok: true, inserted: inserted.length, skipped: preview.length - inserted.length, rows: preview });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const id = toInt(req.params.id);
  const c = await queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
  if (!c) return notFound(res);
  const appointments = await query(
    `SELECT a.id, a.status, a.scheduled_start, a.price_cents, s.name AS service_name
       FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE a.tenant_id=$1 AND a.customer_id=$2 ORDER BY COALESCE(a.scheduled_start,a.created_at) DESC LIMIT 50`,
    [tenantId, id],
  );
  const invoices = await query(
    'SELECT id, number, status, total_cents, amount_paid_cents, created_at, sent_at FROM invoices WHERE tenant_id=$1 AND customer_id=$2 ORDER BY id DESC LIMIT 50',
    [tenantId, id],
  );
  const subscriptions = await query(
    `SELECT su.*, p.name AS plan_name FROM subscriptions su LEFT JOIN recurring_plans p ON p.id=su.plan_id
      WHERE su.tenant_id=$1 AND su.customer_id=$2 ORDER BY su.id DESC`,
    [tenantId, id],
  );
  const followups = await query(
    "SELECT id, title, due_at, status, channel FROM follow_ups WHERE tenant_id=$1 AND customer_id=$2 AND status='pending' ORDER BY due_at",
    [tenantId, id],
  );
  const ltv = await queryOne("SELECT COALESCE(SUM(amount_cents),0)::bigint c FROM financial_events WHERE tenant_id=$1 AND customer_id=$2 AND event_type='payment'", [tenantId, id]);
  const balance = await queryOne("SELECT COALESCE(SUM(total_cents-amount_paid_cents),0)::bigint c FROM invoices WHERE tenant_id=$1 AND customer_id=$2 AND status IN ('sent','partial')", [tenantId, id]);
  const paymentMethods = await listPaymentMethods(req.tenant, id);
  res.json({
    ok: true, customer: c,
    appointments: appointments.rows, invoices: invoices.rows, subscriptions: subscriptions.rows, followups: followups.rows,
    paymentMethods, cards: cardsStatus(req.tenant),
    ltvCents: Number(ltv.c), balanceCents: Number(balance.c),
  });
}));

// --- Saved cards / charge-on-file ----------------------------------------
router.get('/:id/payment-methods', asyncHandler(async (req, res) => {
  res.json({ ok: true, paymentMethods: await listPaymentMethods(req.tenant, toInt(req.params.id)), cards: cardsStatus(req.tenant) });
}));

// Begin collecting a card (returns a SetupIntent client secret, or mock flag).
router.post('/:id/setup-intent', asyncHandler(async (req, res) => {
  const c = await loadCustomer(req); if (!c) return notFound(res);
  res.json(await createSetupIntent(req.tenant, c));
}));

// Store a card. Real mode: pass { setupIntentId } from completed Stripe Elements.
// Dev/mock mode: pass nothing (or test card fields) to fabricate a saved card.
router.post('/:id/payment-methods', asyncHandler(async (req, res) => {
  const c = await loadCustomer(req); if (!c) return notFound(res);
  const b = req.body || {};
  const consent = { name: b.consentName || c.name, ip: getClientIp(req), userAgent: req.headers['user-agent'], source: b.consentSource || 'in_person', createdBy: req.admin.username };
  let r;
  if (b.setupIntentId) r = await attachFromSetupIntent(req.tenant, c, b.setupIntentId, consent);
  else r = await attachMockCard(req.tenant, c, { last4: b.last4, brand: b.brand, expMonth: b.expMonth, expYear: b.expYear }, consent);
  if (!r.ok) return badRequest(res, r.error || (r.notConfigured ? 'Card payments are not set up.' : 'Could not save the card.'));
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'card_on_file_save', entityType: 'customer', entityId: c.id, details: { last4: r.paymentMethod.last4 } });
  res.json(r);
}));

// Generate (or reuse) the customer's self-service portal link.
router.post('/:id/portal-link', asyncHandler(async (req, res) => {
  const c = await loadCustomer(req); if (!c) return notFound(res);
  const { ensurePortalToken, portalUrl } = await import('../../lib/portal.js');
  const token = await ensurePortalToken(req.tenant, c.id);
  res.json({ ok: true, url: portalUrl(token, req.tenant) });
}));

// Generate (or reuse) a tokenized hosted save-card link to text/email a customer.
router.post('/:id/card-link', asyncHandler(async (req, res) => {
  const c = await loadCustomer(req); if (!c) return notFound(res);
  let token = c.card_token;
  if (!token) { token = randomToken(); await query('UPDATE customers SET card_token=$3 WHERE tenant_id=$1 AND id=$2', [req.tenant.id, c.id, token]); }
  res.json({ ok: true, url: `${config.baseUrl}/save-card?customer=${c.id}&token=${token}` });
}));

router.post('/:id/payment-methods/:pmId/default', asyncHandler(async (req, res) => {
  const pm = await setDefaultPaymentMethod(req.tenant, toInt(req.params.id), toInt(req.params.pmId));
  if (!pm) return notFound(res);
  res.json({ ok: true, paymentMethod: pm });
}));

router.delete('/:id/payment-methods/:pmId', asyncHandler(async (req, res) => {
  const r = await removePaymentMethod(req.tenant, toInt(req.params.id), toInt(req.params.pmId));
  if (!r.ok) return badRequest(res, r.error);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'card_on_file_remove', entityType: 'customer', entityId: toInt(req.params.id) });
  res.json({ ok: true });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'Name is required.');
  const row = await queryOne(
    `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.tenant.id, b.name, b.email || null, b.phone || null, b.address || null, b.city || null, b.state || null, b.postalCode || null, b.notes || null],
  );
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'customer_create', entityType: 'customer', entityId: row.id });
  res.json({ ok: true, customer: row });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const b = req.body || {};
  const cols = { name: b.name, email: b.email, phone: b.phone, address: b.address, city: b.city, state: b.state, postal_code: b.postalCode, notes: b.notes };
  const sets = []; const params = [id, req.tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  sets.push('updated_at=now()');
  const row = await queryOne(`UPDATE customers SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, customer: row });
}));

export default router;
