#!/usr/bin/env node
// Provision a new white-label business tenant (the resale model). Each tenant is
// fully isolated and brings its own integration credentials via Admin → Settings
// (encrypted per tenant). Email templates fall back to platform defaults, so a
// new tenant is functional immediately.
//
//   npm run new-tenant -- --slug=acme --name="Acme Pest Control" \
//     --email=office@acme.com --phone="(555) 010-1234" --tz=America/New_York \
//     --admin-user=owner [--admin-pass=...] [--with-demo]
//
// If --admin-pass is omitted a strong password is generated and printed once.
import crypto from 'node:crypto';
import { query, queryOne, closeDb } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import { defaultTenantSettings } from '../src/lib/defaults.js';

function args() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a); if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const DEMO_SERVICES = [
  ['Standard Service', 'A standard service visit.', 60, 12900, '#0e7c4b', 1],
  ['Inspection', 'Inspection with a written report.', 45, 0, '#7c3aed', 2],
  ['Follow-up Visit', 'A follow-up or re-treatment visit.', 45, 8900, '#0891b2', 3],
];
const DEMO_PRESETS = [
  ['Standard Service', 'Standard service visit', 12900, 1],
  ['Trip Charge', 'Travel / trip charge', 4500, 2],
  ['Materials', 'Materials & supplies', 2500, 3],
];

(async () => {
  const a = args();
  const name = a.name; const slug = slugify(a.slug || a.name || '');
  if (!name || !slug) { console.error('Usage: npm run new-tenant -- --slug=acme --name="Acme Pest Control" [--email= --phone= --tz= --admin-user= --admin-pass= --with-demo]'); process.exit(1); }

  const exists = await queryOne('SELECT id FROM tenants WHERE slug=$1', [slug]);
  if (exists) { console.error(`✗ A tenant with slug "${slug}" already exists (id=${exists.id}).`); await closeDb(); process.exit(1); }

  const settings = defaultTenantSettings();
  settings.branding = { ...settings.branding, logoText: name, supportEmail: a.email || '', supportPhone: a.phone || '' };

  const tenant = await queryOne(
    `INSERT INTO tenants (slug, name, timezone, currency, contact_email, contact_phone, address, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
    [slug, name, a.tz || 'America/New_York', (a.currency || 'USD').toUpperCase(), a.email || null, a.phone || null, a.address || null, JSON.stringify(settings)],
  );

  const adminUser = a['admin-user'] || 'owner';
  const adminPass = a['admin-pass'] || crypto.randomBytes(9).toString('base64url');
  await query(
    `INSERT INTO admin_users (tenant_id, username, password_hash, display_name, role) VALUES ($1,$2,$3,$4,'owner')`,
    [tenant.id, adminUser, hashPassword(adminPass), 'Owner'],
  );

  if (a['with-demo']) {
    let sort = 1;
    for (const [n, d, dur, price, color, so] of DEMO_SERVICES) {
      await query('INSERT INTO service_types (tenant_id, name, description, duration_minutes, base_price_cents, booking_mode, color, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tenant.id, n, d, dur, price, 'default', color, so]); sort += 1;
    }
    for (const [label, desc, cents, so] of DEMO_PRESETS) {
      await query('INSERT INTO line_item_presets (tenant_id, label, description, default_amount_cents, taxable, sort_order) VALUES ($1,$2,$3,$4,TRUE,$5)', [tenant.id, label, desc, cents, so]).catch(() => {});
    }
  }

  console.log(`\n✓ Tenant created: ${name}  (slug=${slug}, id=${tenant.id})`);
  console.log(`  Admin login → username: ${adminUser}   password: ${adminPass}`);
  console.log(`  Public site: set DEFAULT_TENANT_SLUG=${slug} (or route this tenant's domain to it).`);
  console.log('  Next: sign in → Settings → Integrations to add this business\'s own Stripe / SMS / email credentials.\n');
  await closeDb();
  process.exit(0);
})().catch(async (e) => { console.error('✗ Failed:', e.message); try { await closeDb(); } catch { /* */ } process.exit(1); });
