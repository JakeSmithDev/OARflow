// Seed the default tenant (Pasternack Pest Management) with services, invoice
// presets, recurring plans, email templates, and a handful of demo records so
// the admin dashboard is alive on first run. Idempotent: safe to re-run.
import { pathToFileURL } from 'node:url';
import { query, queryOne, closeDb, backendKind } from '../src/lib/db.js';
import { hashPassword, randomToken } from '../src/lib/crypto.js';
import { defaultTenantSettings, defaultEmailTemplates } from '../src/lib/defaults.js';
import { config } from '../src/config.js';
import { zonedWallTimeToUtc, ymdInTimeZone, addDays } from '../src/lib/dates.js';
import { seedDemoAppointments } from './seed-demo-appointments.js';

const TZ = 'America/New_York';
const j = (v) => JSON.stringify(v);

async function ensureTenant() {
  const existing = await queryOne('SELECT id FROM tenants WHERE slug = $1', [config.defaultTenantSlug]);
  if (existing) return { id: existing.id, fresh: false };
  const row = await queryOne(
    `INSERT INTO tenants (slug, name, timezone, currency, contact_email, contact_phone, address, settings)
     VALUES ($1,$2,$3,'USD',$4,$5,$6,$7::jsonb) RETURNING id`,
    [
      config.defaultTenantSlug,
      'Pasternack Pest Management',
      TZ,
      'office@pasternackpest.com',
      '(410) 555-0142',
      '124 Bayview Ave, Annapolis, MD 21403',
      j(defaultTenantSettings()),
    ],
  );
  return { id: row.id, fresh: true };
}

async function ensureAdmin(tenantId) {
  const exists = await queryOne(
    'SELECT id FROM admin_users WHERE tenant_id = $1 AND lower(username) = lower($2)',
    [tenantId, config.bootstrap.username],
  );
  if (exists) return;
  await query(
    `INSERT INTO admin_users (tenant_id, username, password_hash, display_name, role)
     VALUES ($1,$2,$3,$4,'owner')`,
    [tenantId, config.bootstrap.username, hashPassword(config.bootstrap.password), 'Owner'],
  );
}

async function seedServices(tenantId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM service_types WHERE tenant_id = $1', [tenantId]);
  if (rows[0].n > 0) return;
  // Most services inherit the tenant's default booking mode ('default'); Termite
  // Inspection is pinned to 'request' to demonstrate per-service override.
  const services = [
    ['General Pest Control', 'Interior + exterior treatment for ants, roaches, spiders, and common pests.', 60, 12900, 'default', '#0e7c4b', 1],
    ['Mosquito & Tick Treatment', 'Yard barrier treatment that knocks down mosquitoes and ticks for weeks.', 60, 8900, 'default', '#0891b2', 2],
    ['Rodent Control', 'Inspection, trapping, and exclusion to stop mice and rats.', 90, 24900, 'default', '#b45309', 3],
    ['Termite Inspection', 'Thorough inspection with a written report. Free, by appointment.', 45, 0, 'request', '#7c3aed', 4],
    ['Bed Bug Treatment', 'Multi-room heat/chemical treatment. Scheduled after a quick assessment.', 180, 45000, 'default', '#be123c', 5],
  ];
  for (const [name, desc, dur, price, mode, color, sort] of services) {
    await query(
      `INSERT INTO service_types (tenant_id, name, description, duration_minutes, base_price_cents, booking_mode, color, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, name, desc, dur, price, mode, color, sort],
    );
  }
}

async function seedPresets(tenantId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM line_item_presets WHERE tenant_id = $1', [tenantId]);
  if (rows[0].n > 0) return;
  const presets = [
    ['General Pest Treatment', 'Standard interior + exterior service', 12900, true, 'Service', 1],
    ['Mosquito Barrier Treatment', 'Per application', 8900, true, 'Service', 2],
    ['Rodent Exclusion', 'Sealing entry points', 25000, true, 'Service', 3],
    ['Bed Bug Treatment (per room)', '', 15000, true, 'Service', 4],
    ['Trip / Service Charge', '', 4500, true, 'Fee', 5],
    ['Re-treatment (warranty)', 'Covered under active plan', 0, false, 'Warranty', 6],
    ['Materials', '', 0, true, 'Materials', 7],
  ];
  for (const [label, desc, amt, taxable, cat, sort] of presets) {
    await query(
      `INSERT INTO line_item_presets (tenant_id, label, description, default_amount_cents, taxable, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, label, desc, amt, taxable, cat, sort],
    );
  }
}

async function seedPlans(tenantId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM recurring_plans WHERE tenant_id = $1', [tenantId]);
  if (rows[0].n > 0) return;
  const gp = await queryOne(`SELECT id FROM service_types WHERE tenant_id=$1 AND name='General Pest Control'`, [tenantId]);
  const mq = await queryOne(`SELECT id FROM service_types WHERE tenant_id=$1 AND name='Mosquito & Tick Treatment'`, [tenantId]);
  const plans = [
    ['Quarterly Pest Control', 'Four visits a year — our most popular plan. Covered re-treatments anytime.', 'quarterly', 1, 12900, gp?.id, 1],
    ['Monthly Mosquito (Seasonal)', 'Monthly mosquito & tick barrier, April–October.', 'monthly', 1, 5900, mq?.id, 2],
    ['Annual Protection Plan', 'One prepaid year of quarterly service at a discount.', 'annual', 1, 39900, gp?.id, 3],
    ['Bi-Monthly Premium', 'Every two months for high-pressure properties.', 'custom', 2, 9900, gp?.id, 4],
  ];
  for (const [name, desc, interval, count, price, svc, sort] of plans) {
    await query(
      `INSERT INTO recurring_plans (tenant_id, name, description, interval, interval_count, price_cents, service_type_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, name, desc, interval, count, price, svc || null, sort],
    );
  }
}

async function seedTemplates(tenantId) {
  for (const t of defaultEmailTemplates()) {
    await query(
      `INSERT INTO email_templates (tenant_id, type, subject, html, text)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, type) DO NOTHING`,
      [tenantId, t.type, t.subject, t.html, t.text],
    );
  }
}

async function seedDemoData(tenantId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1', [tenantId]);
  if (rows[0].n > 0) return;

  const svc = await queryOne(`SELECT id, duration_minutes, base_price_cents FROM service_types WHERE tenant_id=$1 AND name='General Pest Control'`, [tenantId]);
  const termite = await queryOne(`SELECT id, duration_minutes FROM service_types WHERE tenant_id=$1 AND name='Termite Inspection'`, [tenantId]);
  const plan = await queryOne(`SELECT id, interval, interval_count, price_cents, service_type_id FROM recurring_plans WHERE tenant_id=$1 AND name='Quarterly Pest Control'`, [tenantId]);

  const customers = [
    ['Dana Whitfield', 'dana.whitfield@example.com', '(410) 555-0188', '88 Magnolia Ct', 'Annapolis', 'MD', '21401'],
    ['Marcus Lee', 'marcus.lee@example.com', '(443) 555-0121', '12 Spa Creek Dr', 'Annapolis', 'MD', '21403'],
    ['The Alvarez Family', 'alvarez.home@example.com', '(410) 555-0177', '305 Bay Ridge Ave', 'Annapolis', 'MD', '21403'],
    ['Priya Natarajan', 'priya.n@example.com', '(301) 555-0144', '47 Forest Glen', 'Severna Park', 'MD', '21146'],
  ];
  const customerIds = [];
  for (const [name, email, phone, addr, city, state, zip] of customers) {
    const c = await queryOne(
      `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tenantId, name, email, phone, addr, city, state, zip],
    );
    customerIds.push(c.id);
  }

  const today = ymdInTimeZone(new Date(), TZ);
  const mkUtc = (ymd, hhmm) => zonedWallTimeToUtc(ymd, hhmm, TZ);
  const ymdPlus = (days) => ymdInTimeZone(addDays(new Date(), days), TZ);

  // 1) Scheduled today
  await query(
    `INSERT INTO appointments (tenant_id, customer_id, service_type_id, status, booking_mode, source, scheduled_start, scheduled_end, service_address, price_cents, access_token)
     VALUES ($1,$2,$3,'scheduled','instant','online',$4,$5,$6,$7,$8)`,
    [tenantId, customerIds[0], svc.id, mkUtc(today, '10:00'), mkUtc(today, '11:00'), '88 Magnolia Ct, Annapolis, MD', svc.base_price_cents, randomToken()],
  );
  // 2) Scheduled in 2 days
  await query(
    `INSERT INTO appointments (tenant_id, customer_id, service_type_id, status, booking_mode, source, scheduled_start, scheduled_end, service_address, price_cents, access_token)
     VALUES ($1,$2,$3,'scheduled','instant','online',$4,$5,$6,$7,$8)`,
    [tenantId, customerIds[1], svc.id, mkUtc(ymdPlus(2), '14:00'), mkUtc(ymdPlus(2), '15:00'), '12 Spa Creek Dr, Annapolis, MD', svc.base_price_cents, randomToken()],
  );
  // 3) A pending REQUEST (3 proposed slots) — needs staff confirmation
  await query(
    `INSERT INTO appointments (tenant_id, customer_id, service_type_id, status, booking_mode, source, requested_slots, service_address, price_cents, access_token)
     VALUES ($1,$2,$3,'requested','request','online',$4::jsonb,$5,$6,$7)`,
    [tenantId, customerIds[3], termite.id, j([
      { start: mkUtc(ymdPlus(3), '09:00').toISOString(), end: mkUtc(ymdPlus(3), '09:45').toISOString() },
      { start: mkUtc(ymdPlus(4), '13:00').toISOString(), end: mkUtc(ymdPlus(4), '13:45').toISOString() },
      { start: mkUtc(ymdPlus(5), '11:00').toISOString(), end: mkUtc(ymdPlus(5), '11:45').toISOString() },
    ]), '47 Forest Glen, Severna Park, MD', 0, randomToken()],
  );
  // 4) Completed last week (will get an invoice)
  const completed = await queryOne(
    `INSERT INTO appointments (tenant_id, customer_id, service_type_id, status, booking_mode, source, scheduled_start, scheduled_end, service_address, price_cents, access_token, completed_at)
     VALUES ($1,$2,$3,'completed','instant','admin',$4,$5,$6,$7,$8,$5) RETURNING id`,
    [tenantId, customerIds[2], svc.id, mkUtc(ymdPlus(-6), '09:00'), mkUtc(ymdPlus(-6), '10:00'), '305 Bay Ridge Ave, Annapolis, MD', svc.base_price_cents, randomToken()],
  );

  // Invoices: one SENT (unpaid) for the completed job, one PAID.
  let seq = 1000;
  const nextNum = () => `INV-${++seq}`;
  const lineItems = [{ label: 'General Pest Treatment', description: 'Interior + exterior', quantity: 1, unit_amount_cents: 12900, amount_cents: 12900, taxable: true }];
  const subtotal = 12900; const tax = Math.round(subtotal * 0.06); const total = subtotal + tax;
  const sent = await queryOne(
    `INSERT INTO invoices (tenant_id, customer_id, appointment_id, number, status, line_items, subtotal_cents, tax_rate_percent, tax_cents, total_cents, access_token, sent_at, created_by, due_date)
     VALUES ($1,$2,$3,$4,'sent',$5::jsonb,$6,6.0,$7,$8,$9, now(),'system', $10) RETURNING id`,
    [tenantId, customerIds[2], completed.id, nextNum(), j(lineItems), subtotal, tax, total, randomToken(), ymdPlus(1)],
  );
  void sent;
  const paid = await queryOne(
    `INSERT INTO invoices (tenant_id, customer_id, number, status, line_items, subtotal_cents, tax_rate_percent, tax_cents, total_cents, amount_paid_cents, access_token, sent_at, paid_at, created_by)
     VALUES ($1,$2,$3,'paid',$4::jsonb,$5,6.0,$6,$7,$7,$8, now(), now(),'system') RETURNING id`,
    [tenantId, customerIds[0], nextNum(), j(lineItems), subtotal, tax, total, randomToken()],
  );
  await query(
    `INSERT INTO financial_events (tenant_id, invoice_id, customer_id, event_type, amount_cents, method, note, created_by)
     VALUES ($1,$2,$3,'payment',$4,'card','Paid online','system')`,
    [tenantId, paid.id, customerIds[0], total],
  );
  await query('UPDATE tenants SET invoice_seq = $1 WHERE id = $2', [seq, tenantId]);

  // An active subscription (recurring revenue)
  if (plan) {
    await query(
      `INSERT INTO subscriptions (tenant_id, customer_id, plan_id, status, interval, interval_count, price_cents, service_type_id, next_run_date)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)`,
      [tenantId, customerIds[0], plan.id, plan.interval, plan.interval_count, plan.price_cents, plan.service_type_id, ymdPlus(75)],
    );
  }

  // A pending follow-up due soon (post-service check-in)
  await query(
    `INSERT INTO follow_ups (tenant_id, customer_id, appointment_id, rule_id, type, title, channel, template_type, due_at, status)
     VALUES ($1,$2,$3,'post_service','email','Post-service check-in','email','follow_up',$4,'pending')`,
    [tenantId, customerIds[2], completed.id, mkUtc(ymdPlus(1), '09:00')],
  );
}

export async function runSeed() {
  console.log(`Seeding (backend: ${await backendKind()})…`);
  const { id: tenantId, fresh } = await ensureTenant();
  await ensureAdmin(tenantId);
  await seedServices(tenantId);
  await seedPresets(tenantId);
  await seedPlans(tenantId);
  await seedTemplates(tenantId);
  await seedDemoData(tenantId);
  // Keep production/Postgres bootstrap clean. Developers using a configured
  // Postgres database can opt in explicitly with `npm run seed:appointments`.
  if (!config.isProduction && !config.databaseUrl) {
    const demoSchedule = await seedDemoAppointments(tenantId);
    console.log(`✓ ${demoSchedule.count} demo appointments ready (${demoSchedule.firstDate} through ${demoSchedule.lastDate}).`);
  }
  console.log(`✓ Tenant "${config.defaultTenantSlug}" ready (id=${tenantId}, ${fresh ? 'created' : 'existing'}).`);
  console.log(`  Admin login: ${config.bootstrap.username} / ${config.bootstrap.password}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed()
    .then(async () => { await closeDb(); process.exit(0); })
    .catch(async (err) => { console.error(err); await closeDb(); process.exit(1); });
}
