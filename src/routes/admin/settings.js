// Settings & configuration — everything is customizable in the admin suite:
// business profile, booking + availability, services, invoicing presets, email
// templates, team members, and integration credentials (Stripe, email).
import express from 'express';
import { requireAdmin, requireRole } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { updateTenantProfile, updateTenantSettings, getTenantById } from '../../lib/tenants.js';
import { hashPassword, encryptSecret } from '../../lib/crypto.js';
import { defaultEmailTemplates } from '../../lib/defaults.js';
import { isConfigured as stripeConfigured } from '../../lib/stripe.js';
import { isConnected as googleConnected } from '../../lib/google_calendar.js';
import { emailProviderName } from '../../config.js';
import { logAudit } from '../../lib/audit.js';
import { zonedWallTimeToUtc } from '../../lib/dates.js';

const router = express.Router();
// Settings (services, availability, invoicing, integrations, team) is owner-only.
router.use(requireAdmin());
router.use(requireRole('owner'));

// Strip all sensitive integration material (Stripe secret/webhook ciphertext,
// Google OAuth tokens) before sending settings to the client. The client only
// needs the safe `integrations` summary built separately below.
function redactSettings(settings) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  delete clone.integrations;
  return clone;
}

// --- Overview -------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const t = req.tenant;
  res.json({
    ok: true,
    profile: { name: t.name, slug: t.slug, timezone: t.timezone, currency: t.currency, contactEmail: t.contact_email, contactPhone: t.contact_phone, address: t.address },
    settings: redactSettings(t.settings),
    integrations: {
      stripeEnabled: stripeConfigured(t),
      stripePublishable: t.settings.integrations.stripe.publishableKey || '',
      googleConnected: googleConnected(t),
      googleCalendarId: t.settings.integrations.google.calendarId || 'primary',
      googleEmail: t.settings.integrations.google.email || '',
      emailProvider: emailProviderName(),
      emailFrom: t.settings.integrations.email.from || '',
    },
  });
}));

router.patch('/profile', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const t = await updateTenantProfile(req.tenant.id, {
    name: b.name, timezone: b.timezone, currency: b.currency,
    contact_email: b.contactEmail, contact_phone: b.contactPhone, address: b.address,
  });
  res.json({ ok: true, profile: { name: t.name, timezone: t.timezone, currency: t.currency, contactEmail: t.contact_email, contactPhone: t.contact_phone, address: t.address } });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const patch = req.body || {};
  // only allow known top-level config sections
  const allowed = ['branding', 'booking', 'availability', 'invoicing'];
  const clean = {};
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
  const t = await updateTenantSettings(req.tenant.id, clean);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'settings_update', details: { sections: Object.keys(clean) } });
  res.json({ ok: true, settings: redactSettings(t.settings) });
}));

// --- Services -------------------------------------------------------------
router.get('/services', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM service_types WHERE tenant_id=$1 ORDER BY sort_order, name', [req.tenant.id]);
  res.json({ ok: true, services: rows });
}));
router.post('/services', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'Service name is required.');
  const row = await queryOne(
    `INSERT INTO service_types (tenant_id, name, description, duration_minutes, base_price_cents, deposit_cents, booking_mode, color, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.tenant.id, b.name, b.description || null, toInt(b.durationMinutes) || 60, Math.round(b.basePriceCents || 0),
     Math.round(b.depositCents || 0), b.bookingMode || 'default', b.color || '#2563eb', toInt(b.sortOrder) || 0],
  );
  res.json({ ok: true, service: row });
}));
router.patch('/services/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cols = { name: b.name, description: b.description, duration_minutes: toInt(b.durationMinutes), base_price_cents: b.basePriceCents != null ? Math.round(b.basePriceCents) : undefined, deposit_cents: b.depositCents != null ? Math.round(b.depositCents) : undefined, booking_mode: b.bookingMode, color: b.color, is_active: b.isActive, sort_order: toInt(b.sortOrder) };
  const sets = []; const params = [toInt(req.params.id), req.tenant.id];
  for (const [k, v] of Object.entries(cols)) if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  sets.push('updated_at=now()');
  const row = await queryOne(`UPDATE service_types SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, service: row });
}));
router.delete('/services/:id', asyncHandler(async (req, res) => {
  await query('UPDATE service_types SET is_active=FALSE WHERE id=$1 AND tenant_id=$2', [toInt(req.params.id), req.tenant.id]);
  res.json({ ok: true });
}));

// --- Invoice line-item presets -------------------------------------------
router.get('/presets', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM line_item_presets WHERE tenant_id=$1 ORDER BY sort_order, label', [req.tenant.id]);
  res.json({ ok: true, presets: rows });
}));
router.post('/presets', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.label) return badRequest(res, 'Label is required.');
  const row = await queryOne(
    `INSERT INTO line_item_presets (tenant_id, label, description, default_amount_cents, taxable, category, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.tenant.id, b.label, b.description || null, Math.round(b.defaultAmountCents || 0), b.taxable !== false, b.category || null, toInt(b.sortOrder) || 0],
  );
  res.json({ ok: true, preset: row });
}));
router.patch('/presets/:id', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cols = { label: b.label, description: b.description, default_amount_cents: b.defaultAmountCents != null ? Math.round(b.defaultAmountCents) : undefined, taxable: b.taxable, category: b.category, is_active: b.isActive };
  const sets = []; const params = [toInt(req.params.id), req.tenant.id];
  for (const [k, v] of Object.entries(cols)) if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  const row = await queryOne(`UPDATE line_item_presets SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, preset: row });
}));
router.delete('/presets/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM line_item_presets WHERE id=$1 AND tenant_id=$2', [toInt(req.params.id), req.tenant.id]);
  res.json({ ok: true });
}));

// --- Email templates ------------------------------------------------------
router.get('/email-templates', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT type, subject, html, text, is_active FROM email_templates WHERE tenant_id=$1', [req.tenant.id]);
  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  const templates = defaultEmailTemplates().map((d) => ({
    type: d.type,
    subject: byType[d.type]?.subject ?? d.subject,
    html: byType[d.type]?.html ?? d.html,
    text: byType[d.type]?.text ?? d.text,
    customized: Boolean(byType[d.type]),
  }));
  res.json({ ok: true, templates });
}));
router.put('/email-templates/:type', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const type = req.params.type;
  await query(
    `INSERT INTO email_templates (tenant_id, type, subject, html, text)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, type) DO UPDATE SET subject=$3, html=$4, text=$5, updated_at=now()`,
    [req.tenant.id, type, b.subject || '', b.html || '', b.text || ''],
  );
  res.json({ ok: true });
}));

// --- Team / users ---------------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, username, display_name, role, is_active, is_totp_enabled, created_at FROM admin_users WHERE tenant_id=$1 ORDER BY id', [req.tenant.id]);
  res.json({ ok: true, users: rows });
}));
router.post('/users', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return badRequest(res, 'Username and password are required.');
  const exists = await queryOne('SELECT id FROM admin_users WHERE tenant_id=$1 AND lower(username)=lower($2)', [req.tenant.id, b.username]);
  if (exists) return badRequest(res, 'That username is taken.');
  const row = await queryOne(
    `INSERT INTO admin_users (tenant_id, username, password_hash, display_name, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, role, is_active`,
    [req.tenant.id, b.username, hashPassword(b.password), b.displayName || null, b.role || 'staff'],
  );
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'user_create', entityType: 'admin_user', entityId: row.id });
  res.json({ ok: true, user: row });
}));
router.patch('/users/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id); const b = req.body || {};
  const sets = []; const params = [id, req.tenant.id];
  if (b.isActive !== undefined) { params.push(b.isActive); sets.push(`is_active=$${params.length}`); }
  if (b.displayName !== undefined) { params.push(b.displayName); sets.push(`display_name=$${params.length}`); }
  if (b.role !== undefined) { params.push(b.role); sets.push(`role=$${params.length}`); }
  if (b.password) { params.push(hashPassword(b.password)); sets.push(`password_hash=$${params.length}`); }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  sets.push('updated_at=now()');
  const row = await queryOne(`UPDATE admin_users SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING id, username, display_name, role, is_active, is_totp_enabled`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, user: row });
}));

// --- Availability exceptions: blackouts (days off) + per-date overrides ---
router.get('/availability-exceptions', asyncHandler(async (req, res) => {
  const blackouts = await query('SELECT id, starts_at, ends_at, reason FROM blackouts WHERE tenant_id=$1 AND ends_at > now() ORDER BY starts_at LIMIT 100', [req.tenant.id]);
  const overrides = await query('SELECT id, service_date, is_closed, hours_json, capacity, note FROM schedule_overrides WHERE tenant_id=$1 ORDER BY service_date LIMIT 100', [req.tenant.id]);
  res.json({ ok: true, blackouts: blackouts.rows, overrides: overrides.rows });
}));

router.post('/blackouts', asyncHandler(async (req, res) => {
  const b = req.body || {};
  let startsAt; let endsAt;
  if (b.date) { // all-day (or range of days) closure in the tenant timezone
    startsAt = zonedWallTimeToUtc(b.date, '00:00', req.tenant.timezone);
    endsAt = zonedWallTimeToUtc(b.endDate || b.date, '00:00', req.tenant.timezone);
    endsAt = new Date(endsAt.getTime() + 86_400_000); // inclusive end day
  } else if (b.startsAt && b.endsAt) { startsAt = new Date(b.startsAt); endsAt = new Date(b.endsAt); }
  else return badRequest(res, 'A date is required.');
  if (!(endsAt > startsAt)) return badRequest(res, 'End must be after start.');
  const row = await queryOne(
    'INSERT INTO blackouts (tenant_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING id, starts_at, ends_at, reason',
    [req.tenant.id, startsAt.toISOString(), endsAt.toISOString(), b.reason || null],
  );
  res.json({ ok: true, blackout: row });
}));
router.delete('/blackouts/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM blackouts WHERE id=$1 AND tenant_id=$2', [toInt(req.params.id), req.tenant.id]);
  res.json({ ok: true });
}));

router.post('/overrides', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.serviceDate) return badRequest(res, 'A date is required.');
  const hours = Array.isArray(b.hoursJson) ? JSON.stringify(b.hoursJson) : null;
  const row = await queryOne(
    `INSERT INTO schedule_overrides (tenant_id, service_date, is_closed, hours_json, capacity, note)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (tenant_id, service_date) DO UPDATE SET is_closed=$3, hours_json=$4::jsonb, capacity=$5, note=$6
     RETURNING id, service_date, is_closed, hours_json, capacity, note`,
    [req.tenant.id, b.serviceDate, !!b.isClosed, hours, b.capacity != null ? toInt(b.capacity) : null, b.note || null],
  );
  res.json({ ok: true, override: row });
}));
router.delete('/overrides/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM schedule_overrides WHERE id=$1 AND tenant_id=$2', [toInt(req.params.id), req.tenant.id]);
  res.json({ ok: true });
}));

// --- Integration credentials ---------------------------------------------
router.put('/integrations/stripe', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = { integrations: { stripe: {} } };
  // Secret + webhook secret are encrypted at rest; publishable key is public.
  if (b.secretKey !== undefined) patch.integrations.stripe.secretKey = b.secretKey ? encryptSecret(b.secretKey) : '';
  if (b.publishableKey !== undefined) patch.integrations.stripe.publishableKey = b.publishableKey;
  if (b.webhookSecret !== undefined) patch.integrations.stripe.webhookSecret = b.webhookSecret ? encryptSecret(b.webhookSecret) : '';
  await updateTenantSettings(req.tenant.id, patch);
  const t = await getTenantById(req.tenant.id);
  res.json({ ok: true, stripeEnabled: stripeConfigured(t) });
}));
router.put('/integrations/email', asyncHandler(async (req, res) => {
  const b = req.body || {};
  await updateTenantSettings(req.tenant.id, { integrations: { email: { from: b.from || '', replyTo: b.replyTo || '' } } });
  res.json({ ok: true });
}));

export default router;
