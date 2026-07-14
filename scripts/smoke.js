// End-to-end smoke test. Runs migrations + seed + the app against a single
// in-memory Postgres (PGlite) in ONE process, then exercises the real HTTP
// surface with assertions. Deterministic; used by `npm run smoke`.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = 'memory://';
process.env.PORT = process.env.SMOKE_PORT || '4555';
process.env.BASE_URL = `http://localhost:${process.env.PORT}`;

const http = await import('node:http');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const assert = (await import('node:assert')).strict;
const { fileURLToPath } = await import('node:url');
const { runMigrations } = await import('./migrate.js');
const { runSeed } = await import('./seed.js');
const { createApp } = await import('../src/app.js');
const { closeDb, query } = await import('../src/lib/db.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.BASE_URL;
let cookie = '';
let passed = 0; const failures = [];

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie?.();
  if (sc && sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name} — ${err.message}`); }
}
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function collectFiles(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // OS junk (.DS_Store etc.) isn't mirrored
    const rel = path.posix.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(full, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

async function checkRootMirrors() {
  const mirrors = new Set([
    'index.html',
    'about.html',
    'contact.html',
    'services.html',
    'privacy.html',
    'robots.txt',
    'sitemap.xml',
    'assets/img/apple-touch-icon.png',
  ]);
  // Compare git-tracked assets only: local-only files (brand source PDFs, OS
  // junk) live at the repo root but are gitignored and never deployed.
  let assetFiles = null;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)('git', ['ls-files', 'assets'], { cwd: repoRoot });
    assetFiles = out.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* no git available — fall back to walking the directory */ }
  if (!assetFiles) assetFiles = (await collectFiles(path.join(repoRoot, 'assets'))).map((f) => path.posix.join('assets', f));
  for (const file of assetFiles) mirrors.add(file);
  for (const rel of mirrors) {
    const parts = rel.split('/');
    const [rootBytes, publicBytes] = await Promise.all([
      fs.readFile(path.join(repoRoot, ...parts)),
      fs.readFile(path.join(repoRoot, 'public', ...parts)),
    ]);
    assert.equal(Buffer.compare(rootBytes, publicBytes), 0, `${rel} differs from public/${rel}`);
  }
}

async function main() {
  console.log('Setting up in-memory DB…');
  await runMigrations({ quiet: true });
  await runSeed();
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(Number(process.env.PORT), r));
  console.log(`\nRunning smoke tests against ${base}\n`);

  await check('root/public mirrored files match', checkRootMirrors);
  await check('admin app assets revalidate after deployments', async () => {
    const response = await fetch(base + '/assets/app/app.css');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });
  await check('dispatch map vendor assets are served locally', async () => {
    const [moduleResponse, stylesheetResponse] = await Promise.all([
      fetch(base + '/assets/vendor/leaflet/leaflet-src.esm.js'),
      fetch(base + '/assets/vendor/leaflet/leaflet.css'),
    ]);
    assert.equal(moduleResponse.status, 200);
    assert.equal(stylesheetResponse.status, 200);
    assert.match(await moduleResponse.text(), /Leaflet 1\.9\.4/);
    assert.match(await stylesheetResponse.text(), /leaflet-container/);
  });

  // --- Public booking ---
  let svcInstant; let svcRequest; let token;
  await check('public bootstrap lists services', async () => {
    const { data } = await call('/api/public/default/bootstrap', { auth: false });
    assert.ok(data.ok && data.services.length >= 5);
    svcInstant = data.services.find((s) => s.mode === 'instant');
    svcRequest = data.services.find((s) => s.mode === 'request');
    assert.ok(svcInstant && svcRequest);
  });
  const date = ymd(new Date(Date.now() + 4 * 86400000));
  let openSlot;
  await check('availability returns bookable slots', async () => {
    const { data } = await call(`/api/public/default/availability?serviceId=${svcInstant.id}&date=${date}`, { auth: false });
    assert.ok(data.ok); openSlot = data.slots.find((s) => s.available); assert.ok(openSlot, 'has an open slot');
  });
  await check('month availability returns detailed service days', async () => {
    const [year, month] = date.split('-').map(Number);
    const { data } = await call(`/api/public/default/month?year=${year}&month=${month}&serviceId=${svcInstant.id}`, { auth: false });
    assert.ok(data.ok);
    assert.equal(typeof data.days[date].open, 'boolean');
    assert.equal(typeof data.days[date].available, 'boolean');
    assert.equal(typeof data.days[date].full, 'boolean');
  });
  await check('instant booking confirms immediately', async () => {
    const { data } = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svcInstant.id, slot: { start: openSlot.start, end: openSlot.end }, customer: { name: 'Smoke Tester', email: 'smoke@example.com', phone: '4105550000', address: '1 Test St' } } });
    assert.equal(data.status, 'scheduled'); assert.ok(data.token);
  });
  await check('booked slot loses capacity', async () => {
    const { data } = await call(`/api/public/default/availability?serviceId=${svcInstant.id}&date=${date}`, { auth: false });
    const s = data.slots.find((x) => x.start === openSlot.start);
    assert.ok(s.remaining < (svcInstant ? 2 : 2));
  });
  await check('request-mode booking creates a pending request', async () => {
    const av = (await call(`/api/public/default/availability?serviceId=${svcRequest.id}&date=${date}`, { auth: false })).data;
    const picks = av.slots.filter((s) => s.available).slice(0, 3).map((s) => ({ start: s.start, end: s.end }));
    const { data } = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svcRequest.id, requestedSlots: picks, customer: { name: 'Req Tester', email: 'req@example.com', address: '2 Req Rd' } } });
    assert.equal(data.status, 'requested'); token = data.token;
  });
  await check('appointment lookup by token works', async () => {
    const { data } = await call(`/api/public/default/appointment/${token}`, { auth: false });
    assert.equal(data.appointment.status, 'requested');
  });

  // --- Admin auth ---
  await check('bad login is rejected', async () => { const { status } = await call('/api/admin/auth/login', { auth: false, method: 'POST', body: { username: 'admin', password: 'nope' } }); assert.equal(status, 401); });
  await check('good login sets a session', async () => { const { data } = await call('/api/admin/auth/login', { auth: false, method: 'POST', body: { username: 'admin', password: 'changeme123' } }); assert.ok(data.ok); });
  await check('auth gate blocks without cookie', async () => { const { status } = await call('/api/admin/dashboard', { auth: false }); assert.equal(status, 401); });

  // --- Customer address requirements ---
  let addressedCustomerId;
  await check('admin customer creation requires a street service address', async () => {
    const missing = await call('/api/admin/customers', { method: 'POST', body: { name: 'No Address', address: '   ' } });
    assert.equal(missing.status, 400); assert.match(missing.data.error, /service address is required/i);
    const created = await call('/api/admin/customers', { method: 'POST', body: { name: 'Addressed Customer', email: 'addressed@example.com', phone: '410-555-0100', address: '  123 Route Lane  ', city: 'Annapolis', state: 'MD', postalCode: '21401' } });
    assert.equal(created.status, 200); assert.equal(created.data.customer.address, '123 Route Lane');
    addressedCustomerId = created.data.customer.id;
    const listed = await call('/api/admin/customers?q=Addressed%20Customer');
    assert.equal(listed.data.customers[0].postal_code, '21401', 'picker metadata includes the complete service address');
  });
  await check('customer service addresses cannot be explicitly cleared', async () => {
    const cleared = await call(`/api/admin/customers/${addressedCustomerId}`, { method: 'PATCH', body: { address: '  ' } });
    assert.equal(cleared.status, 400); assert.match(cleared.data.error, /service address is required/i);
  });
  await check('customer CSV import marks rows without addresses invalid', async () => {
    const csv = 'name,email,address\nMissing Address,missing-address@example.com,\nReady Customer,ready@example.com,44 Service Road';
    const preview = await call('/api/admin/customers/import', { method: 'POST', body: { csv, dryRun: true } });
    assert.equal(preview.status, 200); assert.equal(preview.data.summary.valid, 1); assert.equal(preview.data.summary.errors, 1);
    assert.match(preview.data.rows[0].errors.join(' '), /service address is required/i);
    const imported = await call('/api/admin/customers/import', { method: 'POST', body: { csv, dryRun: false } });
    assert.equal(imported.status, 200); assert.equal(imported.data.inserted, 1); assert.equal(imported.data.skipped, 1);
  });
  await check('legacy customers without addresses can still be edited', async () => {
    const legacy = (await query("INSERT INTO customers (tenant_id,name) VALUES (1,'Legacy Customer') RETURNING id")).rows[0];
    const edited = await call(`/api/admin/customers/${legacy.id}`, { method: 'PATCH', body: { notes: 'Follow up for address' } });
    assert.equal(edited.status, 200); assert.equal(edited.data.customer.notes, 'Follow up for address');
  });
  await check('public booking cannot disable the service-address requirement', async () => {
    await call('/api/admin/settings/settings', { method: 'PUT', body: { booking: { collectAddress: false } } });
    const bootstrap = await call('/api/public/default/bootstrap', { auth: false });
    assert.equal(bootstrap.data.booking.collectAddress, true);
    const missing = await call('/api/public/default/book', { auth: false, method: 'POST', body: {
      serviceId: svcInstant.id, customer: { name: 'Addressless Booker', email: 'addressless@example.com' },
    } });
    assert.equal(missing.status, 400); assert.match(missing.data.error, /service address is required/i);
    await call('/api/admin/settings/settings', { method: 'PUT', body: { booking: { collectAddress: true } } });
  });
  await check('addressless public leads do not create customer records', async () => {
    const before = (await query('SELECT count(*)::int n FROM customers WHERE tenant_id=1')).rows[0].n;
    const missing = await call('/api/public/default/lead', { auth: false, method: 'POST', body: {
      name: 'Addressless Lead', phone: '410-555-0199', email: 'addressless-lead@example.com', notes: 'Need help with ants',
    } });
    assert.equal(missing.status, 400); assert.match(missing.data.error, /service address is required/i);
    const after = (await query('SELECT count(*)::int n FROM customers WHERE tenant_id=1')).rows[0].n;
    assert.equal(after, before);
  });
  await check('duplicate-email public leads preserve an existing address tuple', async () => {
    const lead = await call('/api/public/default/lead', { auth: false, method: 'POST', body: {
      name: 'Addressed Customer', phone: '410-555-9999', email: 'ADDRESSed@example.com',
      address: '999 Replacement Road', city: 'Baltimore', state: 'MD', postalCode: '21201', notes: 'Need a termite inspection',
    } });
    assert.equal(lead.status, 201); assert.equal(lead.data.customerId, addressedCustomerId);
    const customer = (await query('SELECT phone,address,city,state,postal_code FROM customers WHERE id=$1', [addressedCustomerId])).rows[0];
    assert.deepEqual(customer, { phone: '410-555-0100', address: '123 Route Lane', city: 'Annapolis', state: 'MD', postal_code: '21401' });
  });
  await check('duplicate-email leads atomically backfill a missing address tuple', async () => {
    const legacy = (await query(
      `INSERT INTO customers (tenant_id,name,email,city,state,postal_code)
       VALUES (1,'Stale Tuple','stale-tuple@example.com','Old City','VA','00000') RETURNING id`,
    )).rows[0];
    const lead = await call('/api/public/default/lead', { auth: false, method: 'POST', body: {
      name: 'Stale Tuple', phone: '410-555-0188', email: 'stale-tuple@example.com',
      address: '88 Backfill Street', city: 'Frederick', postalCode: '21701', notes: 'Need recurring service',
    } });
    assert.equal(lead.status, 201); assert.equal(lead.data.customerId, legacy.id);
    const customer = (await query('SELECT address,city,state,postal_code FROM customers WHERE id=$1', [legacy.id])).rows[0];
    assert.deepEqual(customer, { address: '88 Backfill Street', city: 'Frederick', state: null, postal_code: '21701' });
  });

  // --- Dashboard ---
  await check('dashboard returns metrics', async () => { const { data } = await call('/api/admin/dashboard'); assert.ok(data.ok && data.metrics && Array.isArray(data.today)); });

  // --- Appointments ---
  let reqId;
  await check('appointments list + counts', async () => { const { data } = await call('/api/admin/appointments'); assert.ok(data.counts.all >= 4); reqId = data.appointments.find((a) => a.status === 'requested')?.id; });
  await check('confirm rejects malformed or impossible manual times', async () => {
    assert.ok(reqId);
    for (const body of [
      { date: '2026-02-31', time: '10:00' },
      { date: '2026-08-10', time: '25:00' },
      { start: 'not-an-iso-date' },
    ]) {
      const result = await call(`/api/admin/appointments/${reqId}/confirm`, { method: 'POST', body });
      assert.equal(result.status, 400, JSON.stringify(result.data));
    }
    const unchanged = await call(`/api/admin/appointments/${reqId}`);
    assert.equal(unchanged.data.appointment.status, 'requested');
  });
  await check('confirm a request -> scheduled', async () => { assert.ok(reqId); const { data } = await call(`/api/admin/appointments/${reqId}/confirm`, { method: 'POST', body: { slotIndex: 0, notify: false } }); assert.equal(data.appointment.status, 'scheduled'); });
  let apptId;
  await check('create + complete an appointment', async () => {
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const c = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Manual Job', email: 'manual@example.com' }, serviceId: svc.id, date, time: '15:30', serviceAddress: '15 Manual Lane, Annapolis, MD' } });
    apptId = c.data.appointment.id;
    const done = await call(`/api/admin/appointments/${apptId}`, { method: 'PATCH', body: { status: 'completed' } });
    assert.equal(done.data.appointment.status, 'completed');
  });
  await check('manual appointment creation requires a service address', async () => {
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const missing = await call('/api/admin/appointments', { method: 'POST', body: { customerId: 1, serviceId: svc.id, date, time: '16:30' } });
    assert.equal(missing.status, 400); assert.match(missing.data.error, /service address is required/i);
  });
  await check('admin create and reschedule reject invalid date/time values', async () => {
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const baseBody = { customerId:1, serviceId:svc.id, serviceAddress:'400 Validation Way, Baltimore, MD' };
    const invalidCreates = [
      { ...baseBody, date:'2026-02-31', time:'10:00' },
      { ...baseBody, date:'2026-08-10', time:'24:01' },
      { ...baseBody, date:'2027-03-14', time:'02:30' },
      { ...baseBody, start:'tomorrow morning' },
      { ...baseBody, start:'2026-08-10T15:00:00.000Z', end:'2026-08-10T14:00:00.000Z' },
    ];
    for (const body of invalidCreates) {
      const result = await call('/api/admin/appointments', { method:'POST', body });
      assert.equal(result.status, 400, JSON.stringify(result.data));
    }
    const before = (await call(`/api/admin/appointments/${apptId}`)).data.appointment.scheduled_start;
    const badReschedule = await call(`/api/admin/appointments/${apptId}`, { method:'PATCH', body:{ date:'2026-04-31', time:'09:00' } });
    assert.equal(badReschedule.status, 400, JSON.stringify(badReschedule.data));
    const after = (await call(`/api/admin/appointments/${apptId}`)).data.appointment.scheduled_start;
    assert.equal(after, before, 'invalid reschedule must not mutate the appointment');
  });
  await check('completion scheduled a follow-up', async () => {
    const { data } = await call('/api/admin/customers?q=manual@example.com');
    const cust = data.customers[0]; assert.ok(cust);
    const det = await call('/api/admin/customers/' + cust.id);
    assert.ok(det.data.followups.length >= 1, 'a follow-up exists');
  });

  // --- Invoicing ---
  let invId; let invToken; let balance;
  await check('create a customizable invoice (preset + custom, tax, discount)', async () => {
    const { data } = await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'General Pest Treatment', unit_amount_cents: 12900, taxable: true }, { label: 'Trip Charge', unit_amount_cents: 4500, taxable: true }], taxRatePercent: 6, discountCents: 1000 } });
    invId = data.invoice.id; invToken = data.invoice.access_token;
    assert.equal(data.invoice.total_cents, 17384); assert.equal(data.invoice.status, 'draft');
  });
  await check('send invoice on demand', async () => { const { status, data } = await call(`/api/admin/invoices/${invId}/send`, { method: 'POST' }); assert.ok(data && data.ok, `status=${status} body=${JSON.stringify(data)}`); assert.ok(data.payUrl.includes('/pay?invoice=')); });
  await check('partial payment -> partial', async () => { const { data } = await call(`/api/admin/invoices/${invId}/payment`, { method: 'POST', body: { amountCents: 5000, method: 'cash' } }); assert.equal(data.invoice.status, 'partial'); balance = data.invoice.total_cents - data.invoice.amount_paid_cents; });
  await check('final payment -> paid', async () => { const { data } = await call(`/api/admin/invoices/${invId}/payment`, { method: 'POST', body: { amountCents: balance, method: 'card' } }); assert.equal(data.invoice.status, 'paid'); });
  await check('duplicate-safe ledger keeps total correct', async () => { const { data } = await call('/api/admin/invoices/' + invId); assert.equal(data.invoice.amount_paid_cents, data.invoice.total_cents); });
  await check('public pay view reflects paid', async () => { const { data } = await call(`/api/pay/${invId}?token=${invToken}`, { auth: false }); assert.equal(data.paid, true); });

  // --- Quotes / estimates (clickwrap accept -> convert) ---
  let estId; let estToken;
  await check('create an estimate (tax + discount totals)', async () => {
    const { data } = await call('/api/admin/estimates', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'Termite Inspection', unit_amount_cents: 9900, taxable: true }, { label: 'Treatment', unit_amount_cents: 45000, taxable: true }], taxRatePercent: 6, discountCents: 5000 } });
    estId = data.estimate.id; estToken = data.estimate.access_token;
    assert.equal(data.estimate.status, 'draft'); assert.ok(/^EST-/.test(data.estimate.number));
    assert.equal(data.estimate.total_cents, Math.round((9900 + 45000 - 5000) * 1.06)); // 52894
  });
  await check('send estimate produces a /quote approve link', async () => { const { data } = await call(`/api/admin/estimates/${estId}/send`, { method: 'POST' }); assert.ok(data.ok); assert.ok(data.acceptUrl.includes('/quote?estimate=')); });
  await check('public quote view is token-guarded', async () => {
    const bad = await call(`/api/quotes/${estId}?token=wrong`, { auth: false }); assert.equal(bad.status, 404);
    const ok = await call(`/api/quotes/${estId}?token=${estToken}`, { auth: false }); assert.equal(ok.data.estimate.status, 'sent');
  });
  await check('clickwrap accept records signature snapshot', async () => {
    const r = await call(`/api/quotes/${estId}/accept`, { method: 'POST', auth: false, body: { token: estToken, name: 'Dana Whitfield' } });
    assert.ok(r.data.ok, JSON.stringify(r.data));
    const { data } = await call('/api/admin/estimates/' + estId);
    assert.equal(data.estimate.status, 'converted'); // auto-converts to draft invoice on accept
    assert.equal(data.estimate.accepted_name, 'Dana Whitfield'); assert.ok(data.estimate.accepted_at);
    assert.ok(data.estimate.converted_invoice_id, 'should have spawned an invoice');
  });
  await check('accepted estimate cannot be edited', async () => { const { status } = await call('/api/admin/estimates/' + estId, { method: 'PATCH', body: { discountCents: 0 } }); assert.equal(status, 400); });
  await check('estimate valid_until round-trips as the exact calendar date (DATE parser regression)', async () => {
    // Regression guard: DATE columns must come back as raw 'YYYY-MM-DD' strings,
    // not driver-midnight Date objects that shift a day depending on process TZ.
    const validUntil = ymd(new Date(Date.now() + 10 * 86400000));
    const { data } = await call('/api/admin/estimates', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'Date check', unit_amount_cents: 100 }], validUntil } });
    const raw = data.estimate.valid_until;
    assert.equal(String(raw).slice(0, 10), validUntil, `valid_until mismatch: wrote ${validUntil}, read ${raw}`);
    // A valid-through-today estimate must NOT be expired, and it must be accepted server-side.
    const today = ymd(new Date());
    const edge = await call('/api/admin/estimates', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'Edge', unit_amount_cents: 100 }], validUntil: today } });
    const pub = await call(`/api/quotes/${edge.data.estimate.id}?token=${edge.data.estimate.access_token}`, { auth: false });
    assert.equal(pub.data.estimate.expired, false, `estimate valid through today (${today}) reported expired`);
  });
  await check('convert is idempotent (same invoice id)', async () => {
    const before = (await call('/api/admin/estimates/' + estId)).data.estimate.converted_invoice_id;
    const { data } = await call(`/api/admin/estimates/${estId}/convert`, { method: 'POST' });
    assert.equal(data.invoiceId, before);
  });

  // --- Saved cards / charge-on-file (mock provider in dev) ---
  let pmId;
  await check('add a (mock) card on file + auto-default', async () => {
    const { data } = await call('/api/admin/customers/1/payment-methods', { method: 'POST', body: { consentSource: 'in_person' } });
    assert.ok(data.ok, JSON.stringify(data)); assert.ok(data.paymentMethod.is_default); assert.ok(data.paymentMethod.last4);
    pmId = data.paymentMethod.id;
  });
  await check('card shows on customer detail with consent snapshot', async () => {
    const { data } = await call('/api/admin/customers/1');
    assert.ok(data.paymentMethods.length >= 1); assert.equal(data.cards.available, true); assert.equal(data.cards.mock, true);
    assert.equal(data.paymentMethods.find((p) => p.id === pmId).consent_source, 'in_person');
  });
  await check('[fix] invalid default card does not clear current default', async () => {
    const bad = await call('/api/admin/customers/1/payment-methods/999999/default', { method: 'POST' });
    assert.equal(bad.status, 404);
    const { data } = await call('/api/admin/customers/1/payment-methods');
    assert.equal(data.paymentMethods.find((p) => p.id === pmId)?.is_default, true);
  });
  let cofInv;
  await check('charge invoice to card on file marks it paid', async () => {
    cofInv = (await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'Quarterly Service', unit_amount_cents: 8900 }] } })).data.invoice;
    await call(`/api/admin/invoices/${cofInv.id}/send`, { method: 'POST' });
    const { data } = await call(`/api/admin/invoices/${cofInv.id}/charge-on-file`, { method: 'POST', body: { paymentMethodId: pmId } });
    assert.ok(data.ok, JSON.stringify(data)); assert.equal(data.invoice.status, 'paid'); assert.equal(data.mock, true);
  });
  await check('cannot charge an already-paid invoice', async () => {
    const { status } = await call(`/api/admin/invoices/${cofInv.id}/charge-on-file`, { method: 'POST', body: { paymentMethodId: pmId } });
    assert.equal(status, 400);
  });
  await check('hosted save-card link is token-guarded + stores a card', async () => {
    const { data: link } = await call('/api/admin/customers/2/card-link', { method: 'POST' });
    const token = new URL(link.url).searchParams.get('token'); assert.ok(token);
    const bad = await call('/api/save-card/2?token=nope', { auth: false }); assert.equal(bad.status, 404);
    const good = await call('/api/save-card/2?token=' + token, { auth: false }); assert.equal(good.data.ok, true);
    const saved = await call('/api/save-card/2', { method: 'POST', auth: false, body: { token, last4: '1111', brand: 'visa', expMonth: 4, expYear: 2031 } });
    assert.ok(saved.data.ok); assert.equal(saved.data.last4, '1111');
  });
  await check('remove a card on file', async () => {
    const { status } = await call(`/api/admin/customers/1/payment-methods/${pmId}`, { method: 'DELETE' });
    assert.equal(status, 200);
    const { data } = await call('/api/admin/customers/1');
    assert.ok(!data.paymentMethods.some((p) => p.id === pmId));
  });

  // --- Reporting v1 ---
  await check('reports index returns catalog + KPIs', async () => {
    const { data } = await call('/api/admin/reports?from=2026-01-01&to=2026-12-31');
    assert.ok(data.reports.length >= 7); assert.ok(typeof data.kpis.collectedCents === 'number'); assert.ok('outstandingCents' in data.kpis);
  });
  await check('revenue_by_month report runs (date_trunc + totals)', async () => {
    const { data } = await call('/api/admin/reports/revenue_by_month?from=2026-01-01&to=2026-12-31');
    assert.equal(data.report.key, 'revenue_by_month');
    assert.ok(data.report.columns.some((c) => c.key === 'net' && c.type === 'money'));
    assert.ok(data.report.totals && typeof data.report.totals.net === 'number');
  });
  await check('ar_aging report buckets outstanding balances', async () => {
    const { data } = await call('/api/admin/reports/ar_aging');
    assert.equal(data.report.rows.length, 5); assert.equal(data.report.rows[0].bucket, 'Current');
  });
  await check('sales_by_service + recurring_snapshot run', async () => {
    assert.ok((await call('/api/admin/reports/sales_by_service?from=2026-01-01&to=2026-12-31')).data.report);
    const rec = (await call('/api/admin/reports/recurring_snapshot')).data.report;
    assert.ok(rec.columns.some((c) => c.key === 'mrr'));
  });
  await check('unknown report 400s', async () => { const { status } = await call('/api/admin/reports/nope'); assert.equal(status, 400); });
  await check('CSV export returns text/csv with header row', async () => {
    const res = await fetch(base + '/api/admin/reports/revenue_by_month.csv?from=2026-01-01&to=2026-12-31', { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/csv');
    const text = await res.text();
    assert.ok(text.split('\n')[0].includes('Month'), 'csv header present');
  });

  // --- Technicians + assignment (internal dispatch; never on public booking) ---
  let techId;
  const marcoRouteStart = '410 Technician Lane, Baltimore, MD 21201';
  await check('create a technician with a custom route starting point', async () => {
    const { data } = await call('/api/admin/technicians', { method: 'POST', body: {
      name: 'Marco Diaz', color: '#2563eb', phone: '410-555-0142',
      routeStartAddress: `  ${marcoRouteStart}  `,
    } });
    assert.ok(data.ok); techId = data.technician.id; assert.equal(data.technician.is_active, true);
    assert.equal(data.technician.route_start_address, marcoRouteStart);
    assert.equal(data.technician.route_start_lat, null); assert.equal(data.technician.route_start_lng, null);
    const picker = (await call('/api/admin/technicians')).data.technicians.find((tech) => tech.id === techId);
    assert.equal(Object.prototype.hasOwnProperty.call(picker, 'route_start_address'), false, 'picker responses omit private route origins');
    const listed = (await call('/api/admin/technicians?all=1&origins=1')).data.technicians.find((tech) => tech.id === techId);
    assert.equal(listed.route_start_address, marcoRouteStart, 'starting point is exposed by the team list');
  });
  await check('technician route starting points validate and invalidate only changed coordinate caches', async () => {
    for (const routeStartAddress of [123, 'x'.repeat(501)]) {
      const rejected = await call(`/api/admin/technicians/${techId}`, { method: 'PATCH', body: { routeStartAddress } });
      assert.equal(rejected.status, 400); assert.match(rejected.data.error, /route starting point/i);
    }
    await query('UPDATE technicians SET route_start_lat=39.1, route_start_lng=-76.1 WHERE id=$1', [techId]);
    const unchanged = await call(`/api/admin/technicians/${techId}`, { method: 'PATCH', body: { routeStartAddress: marcoRouteStart } });
    assert.equal(Number(unchanged.data.technician.route_start_lat), 39.1, 'idempotent saves preserve the cache');
    const changed = await call(`/api/admin/technicians/${techId}`, { method: 'PATCH', body: { routeStartAddress: '500 New Start Road' } });
    assert.equal(changed.data.technician.route_start_lat, null); assert.equal(changed.data.technician.route_start_lng, null);
    const business = await call(`/api/admin/technicians/${techId}`, { method: 'PATCH', body: { routeStartAddress: '   ' } });
    assert.equal(business.data.technician.route_start_address, null, 'blank selects the tenant business address');
    const restored = await call(`/api/admin/technicians/${techId}`, { method: 'PATCH', body: { routeStartAddress: marcoRouteStart } });
    assert.equal(restored.data.technician.route_start_address, marcoRouteStart);
  });
  await check('technicians cannot link a login owned by another tenant', async () => {
    const foreignTenant = (await query("INSERT INTO tenants (slug,name) VALUES ('route-origin-rival','Route Origin Rival') RETURNING id")).rows[0];
    const foreignUser = (await query(
      "INSERT INTO admin_users (tenant_id,username,password_hash,role) VALUES ($1,'foreign-route-user','unused','owner') RETURNING id",
      [foreignTenant.id],
    )).rows[0];
    const rejected = await call('/api/admin/technicians', { method: 'POST', body: { name: 'Wrong Tenant Rep', userId: foreignUser.id } });
    assert.equal(rejected.status, 400); assert.match(rejected.data.error, /does not belong/i);
  });
  let assignApptId;
  await check('assign a technician to an appointment (lead)', async () => {
    assignApptId = (await call('/api/admin/appointments')).data.appointments.find((a) => a.scheduled_start).id;
    const { data } = await call(`/api/admin/appointments/${assignApptId}/assign`, { method: 'POST', body: { technicianIds: [techId], leadId: techId } });
    assert.ok(data.ok); assert.equal(data.technicians.length, 1); assert.equal(data.technicians[0].is_lead, true);
  });
  await check('assignment shows on appointment detail + calendar', async () => {
    const detail = (await call('/api/admin/appointments/' + assignApptId)).data;
    assert.equal(detail.technicians[0].name, 'Marco Diaz');
    const cal = (await call('/api/admin/appointments/calendar?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z')).data;
    const appt = cal.appointments.find((a) => a.id === assignApptId);
    assert.ok(appt.technicians.some((t) => t.id === techId));
  });
  await check('reassigning replaces the set (idempotent)', async () => {
    await call(`/api/admin/appointments/${assignApptId}/assign`, { method: 'POST', body: { technicianIds: [techId], leadId: techId } });
    const { data } = await call('/api/admin/appointments/' + assignApptId);
    assert.equal(data.technicians.length, 1);
  });
  await check('assigning an unknown technician is rejected', async () => {
    const { status } = await call(`/api/admin/appointments/${assignApptId}/assign`, { method: 'POST', body: { technicianIds: [999999] } });
    assert.equal(status, 400);
  });
  await check('rep assignment blocks overlapping appointments', async () => {
    const detail = (await call('/api/admin/appointments/' + assignApptId)).data.appointment;
    const created = await call('/api/admin/appointments', { method: 'POST', body: {
      customerId: detail.customer_id, serviceId: detail.service_type_id, start: detail.scheduled_start,
      end: detail.scheduled_end, serviceAddress: 'Overlap test', force: true,
    } });
    assert.ok(created.data.ok, JSON.stringify(created.data));
    const blocked = await call(`/api/admin/appointments/${created.data.appointment.id}/assign`, { method: 'POST', body: { technicianIds: [techId], leadId: techId } });
    assert.equal(blocked.status, 400); assert.match(blocked.data.error, /overlapping appointment/i);
    await call(`/api/admin/appointments/${created.data.appointment.id}`, { method: 'PATCH', body: { status: 'canceled' } });
  });
  await check('manual create + rep assignment is atomic on conflict', async () => {
    const detail = (await call('/api/admin/appointments/' + assignApptId)).data.appointment;
    const before = (await call('/api/admin/appointments')).data.total;
    const customersBefore = (await query('SELECT count(*)::int n FROM customers WHERE tenant_id=1')).rows[0].n;
    const blocked = await call('/api/admin/appointments', { method: 'POST', body: {
      customer: { name: 'Atomic Rollback Customer', email: 'atomic.rollback@example.com' },
      serviceId: detail.service_type_id, start: detail.scheduled_start,
      end: detail.scheduled_end, serviceAddress: 'Atomic overlap test', technicianId: techId, force: true,
    } });
    assert.equal(blocked.status, 400); assert.match(blocked.data.error, /overlapping appointment/i);
    const after = (await call('/api/admin/appointments')).data.total;
    assert.equal(after, before, 'failed assignment must roll back appointment creation');
    const customersAfter = (await query('SELECT count(*)::int n FROM customers WHERE tenant_id=1')).rows[0].n;
    assert.equal(customersAfter, customersBefore, 'failed assignment must roll back new customer creation');
  });
  await check('confirming a preassigned request checks rep conflicts atomically', async () => {
    const detail = (await call('/api/admin/appointments/' + assignApptId)).data.appointment;
    const requestedSlots = [{ start: detail.scheduled_start, end: detail.scheduled_end }];
    const requested = (await query(
      `INSERT INTO appointments
         (tenant_id, customer_id, service_type_id, status, booking_mode, source, requested_slots, service_address)
       VALUES ($1,$2,$3,'requested','request','admin',$4::jsonb,$5) RETURNING id`,
      [1, detail.customer_id, detail.service_type_id, JSON.stringify(requestedSlots), 'Preassigned request test'],
    )).rows[0];
    const assigned = await call(`/api/admin/appointments/${requested.id}/assign`, {
      method: 'POST', body: { technicianIds: [techId], leadId: techId },
    });
    assert.ok(assigned.data.ok, JSON.stringify(assigned.data));
    const blocked = await call(`/api/admin/appointments/${requested.id}/confirm`, {
      method: 'POST', body: { slotIndex: 0, notify: false },
    });
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /overlapping appointment/i);
    const stillRequested = (await call(`/api/admin/appointments/${requested.id}`)).data.appointment;
    assert.equal(stillRequested.status, 'requested', 'conflicting confirmation must not partially update');
    const forced = await call(`/api/admin/appointments/${requested.id}/confirm`, {
      method: 'POST', body: { slotIndex: 0, notify: false, force: true },
    });
    assert.equal(forced.data.appointment.status, 'scheduled', 'explicit force remains supported');
    await call(`/api/admin/appointments/${requested.id}`, { method: 'PATCH', body: { status: 'canceled' } });
    await call(`/api/admin/appointments/${requested.id}/assign`, { method: 'POST', body: { technicianIds: [] } });
  });
  await check('rescheduling an assigned job checks rep conflicts under lock', async () => {
    const detail = (await call('/api/admin/appointments/' + assignApptId)).data.appointment;
    const laterStart = new Date(new Date(detail.scheduled_start).getTime() + 86_400_000).toISOString();
    const laterEnd = new Date(new Date(detail.scheduled_end).getTime() + 86_400_000).toISOString();
    const created = await call('/api/admin/appointments', { method: 'POST', body: {
      customerId: detail.customer_id, serviceId: detail.service_type_id,
      start: laterStart, end: laterEnd, serviceAddress: 'Reschedule lock test', technicianId: techId, force: true,
    } });
    assert.ok(created.data.ok, JSON.stringify(created.data));
    const blocked = await call(`/api/admin/appointments/${created.data.appointment.id}`, { method: 'PATCH', body: {
      start: detail.scheduled_start, end: detail.scheduled_end,
    } });
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /overlapping appointment/i);
    const forced = await call(`/api/admin/appointments/${created.data.appointment.id}`, { method: 'PATCH', body: {
      start: detail.scheduled_start, end: detail.scheduled_end, force: true,
    } });
    assert.equal(forced.data.appointment.scheduled_start, detail.scheduled_start, 'explicit force remains supported');
    await call(`/api/admin/appointments/${created.data.appointment.id}`, { method: 'PATCH', body: { status: 'canceled' } });
    await call(`/api/admin/appointments/${created.data.appointment.id}/assign`, { method: 'POST', body: { technicianIds: [] } });
  });
  await check('technician field-app link is generated', async () => {
    const { data } = await call(`/api/admin/technicians/${techId}/field-link`, { method: 'POST' });
    assert.ok(data.url.includes('/field?token='));
  });

  // --- Job photos / files (base64 upload, reused storage layer) ---
  // 1x1 transparent PNG
  const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let jobFileId;
  await check('upload a job photo (base64)', async () => {
    const { data } = await call(`/api/admin/appointments/${assignApptId}/files`, { method: 'POST', body: { filename: 'before.png', contentType: 'image/png', dataBase64: PNG1x1 } });
    assert.ok(data.ok, JSON.stringify(data)); jobFileId = data.file.id; assert.equal(data.file.kind, 'photo'); assert.ok(data.file.url.includes('/api/files/'));
  });
  await check('job files appear on appointment detail', async () => {
    const { data } = await call('/api/admin/appointments/' + assignApptId);
    assert.ok(data.files.some((f) => f.id === jobFileId));
  });
  await check('uploaded file is fetchable via its token URL', async () => {
    const url = (await call('/api/admin/appointments/' + assignApptId)).data.files.find((f) => f.id === jobFileId).url;
    const res = await fetch(base + url.replace(/^https?:\/\/[^/]+/, ''));
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
  });
  await check('reject an unsupported file type', async () => {
    const { status } = await call(`/api/admin/appointments/${assignApptId}/files`, { method: 'POST', body: { filename: 'x.exe', contentType: 'application/x-msdownload', dataBase64: PNG1x1 } });
    assert.equal(status, 400);
  });
  await check('delete a job file', async () => {
    assert.equal((await call(`/api/admin/appointments/${assignApptId}/files/${jobFileId}`, { method: 'DELETE' })).status, 200);
    const { data } = await call('/api/admin/appointments/' + assignApptId);
    assert.ok(!data.files.some((f) => f.id === jobFileId));
  });

  // --- Drag-and-drop reschedule (date+time PATCH used by the calendar) ---
  await check('reschedule appointment by date+time (DnD path)', async () => {
    const appt = (await call('/api/admin/appointments')).data.appointments.find((a) => a.scheduled_start);
    assert.ok(appt, 'need a scheduled appointment');
    const newYmd = '2026-07-15';
    const { data } = await call(`/api/admin/appointments/${appt.id}`, { method: 'PATCH', body: { date: newYmd, time: '09:00', force: true } });
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(String(data.appointment.scheduled_start).startsWith('2026-07-15'), `moved to ${data.appointment.scheduled_start}`);
    assert.equal(data.appointment.status, 'scheduled');
  });

  // --- Customer self-service portal (magic-link) ---
  let portalToken;
  await check('admin can mint a customer portal link', async () => {
    const { data } = await call('/api/admin/customers/1/portal-link', { method: 'POST' });
    assert.ok(data.url.includes('/portal?token=')); portalToken = new URL(data.url).searchParams.get('token');
  });
  await check('portal /me returns the customer dashboard', async () => {
    const { data } = await call('/api/portal/me?token=' + portalToken, { auth: false });
    assert.ok(data.ok); assert.ok(data.customer.name); assert.ok(Array.isArray(data.invoices)); assert.ok(Array.isArray(data.upcoming));
    assert.ok(data.tenant.bookUrl.includes('/book'));
  });
  await check('portal rejects a bad token', async () => {
    assert.equal((await call('/api/portal/me?token=nope', { auth: false })).status, 404);
  });
  await check('request-link never leaks existence (+dev link)', async () => {
    const hit = await call('/api/portal/request-link', { method: 'POST', auth: false, body: { email: (await call('/api/admin/customers/1')).data.customer.email } });
    assert.ok(hit.data.ok); assert.ok(hit.data.devLink, 'dev link returned outside production');
    const miss = await call('/api/portal/request-link', { method: 'POST', auth: false, body: { email: 'nobody-xyz@example.com' } });
    assert.ok(miss.data.ok); assert.ok(!miss.data.devLink, 'no link for unknown email');
  });
  await check('portal can mint its own save-card link', async () => {
    const { data } = await call('/api/portal/card-link', { method: 'POST', auth: false, body: { token: portalToken } });
    assert.ok(data.url.includes('/save-card?customer='));
  });

  // --- Accounting export (CSV + QuickBooks IIF) ---
  await check('accounting summary reflects invoices + payments', async () => {
    const { data } = await call('/api/admin/accounting?from=2026-01-01&to=2026-12-31');
    assert.ok(data.summary.counts.invoices >= 1); assert.ok(data.summary.totals.collectedCents >= 0);
    assert.equal(data.provider.supportsSync, false);
  });
  await check('accounting CSV export has header + ties rows to OARFlow refs', async () => {
    const res = await fetch(base + '/api/admin/accounting/export.csv?from=2026-01-01&to=2026-12-31', { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/csv');
    const text = await res.text();
    assert.ok(text.split('\n')[0].includes('OARFlow Ref'));
    assert.ok(/\binv:\d+\b/.test(text), 'invoice ref present');
  });
  await check('QuickBooks IIF export is balanced double-entry', async () => {
    const res = await fetch(base + '/api/admin/accounting/export.iif?from=2026-01-01&to=2026-12-31', { headers: { Cookie: cookie } });
    const text = await res.text();
    assert.ok(text.startsWith('!TRNS\t'), 'IIF header');
    assert.ok(text.includes('ENDTRNS'));
    // every TRNS has a matching ENDTRNS
    const trns = (text.match(/^TRNS\t/gm) || []).length; const ends = (text.match(/^ENDTRNS$/gm) || []).length;
    assert.equal(trns, ends);
  });

  // --- Technician field PWA (per-tech field_token auth) ---
  let fieldToken;
  await check('mint technician field token', async () => {
    const { data } = await call(`/api/admin/technicians/${techId}/field-link`, { method: 'POST' });
    fieldToken = new URL(data.url).searchParams.get('token'); assert.ok(fieldToken);
  });
  await check("field /me lists the tech's jobs for a day", async () => {
    const { data } = await call(`/api/field/me?token=${fieldToken}&date=2026-07-15`, { auth: false });
    assert.ok(data.ok); assert.equal(data.technician.name, 'Marco Diaz');
    assert.ok(data.jobs.some((j) => j.id === assignApptId), 'assigned job appears on that day');
  });
  await check('field rejects a bad token', async () => { assert.equal((await call('/api/field/me?token=nope', { auth: false })).status, 401); });
  await check('field tech uploads a photo + captures signature', async () => {
    const up = await call(`/api/field/jobs/${assignApptId}/photos`, { method: 'POST', auth: false, body: { token: fieldToken, filename: 'site.png', contentType: 'image/png', dataBase64: PNG1x1 } });
    assert.ok(up.data.ok, JSON.stringify(up.data));
    const sig = await call(`/api/field/jobs/${assignApptId}/signature`, { method: 'POST', auth: false, body: { token: fieldToken, name: 'Dana W.', dataBase64: 'data:image/png;base64,' + PNG1x1 } });
    assert.ok(sig.data.ok);
  });
  await check('field tech cannot touch an unassigned job', async () => {
    const other = (await call('/api/admin/appointments')).data.appointments.find((a) => a.id !== assignApptId);
    if (!other) return; // skip if only one appointment seeded
    const r = await call(`/api/field/jobs/${other.id}/status`, { method: 'POST', auth: false, body: { token: fieldToken, status: 'completed' } });
    assert.equal(r.status, 404);
  });
  await check('field tech marks the job complete', async () => {
    const { data } = await call(`/api/field/jobs/${assignApptId}/status`, { method: 'POST', auth: false, body: { token: fieldToken, status: 'completed' } });
    assert.ok(data.ok); assert.equal(data.status, 'completed');
  });

  // --- Documents + e-signature ---
  let tplId; let docId; let docToken;
  await check('create a document template with merge fields', async () => {
    const { data } = await call('/api/admin/documents/templates', { method: 'POST', body: { name: 'Service Agreement', requiresSignature: true, body: 'Agreement between {{COMPANY_NAME}} and {{CUSTOMER_NAME}}. Signed {{TODAY}}.' } });
    assert.ok(data.ok); tplId = data.template.id;
  });
  await check('create a document renders the merge snapshot', async () => {
    const { data } = await call('/api/admin/documents', { method: 'POST', body: { customerId: 1, templateId: tplId } });
    assert.ok(data.ok, JSON.stringify(data)); docId = data.document.id; docToken = data.document.access_token;
    assert.ok(data.document.body.includes('Pasternack'), 'company merged');
    assert.ok(!data.document.body.includes('{{'), 'no unrendered placeholders');
  });
  await check('send document marks it sent + returns a sign link', async () => {
    const { data } = await call(`/api/admin/documents/${docId}/send`, { method: 'POST' });
    assert.ok(data.signUrl.includes('/document?token='));
  });
  await check('public document view is token-guarded', async () => {
    assert.equal((await call('/api/documents?token=bad', { auth: false })).status, 404);
    const { data } = await call('/api/documents?token=' + docToken, { auth: false });
    assert.ok(data.ok); assert.equal(data.document.requiresSignature, true);
  });
  await check('clickwrap + drawn signature binds the document', async () => {
    const r = await call('/api/documents/sign', { method: 'POST', auth: false, body: { token: docToken, name: 'Dana Whitfield', signatureDataUrl: 'data:image/png;base64,' + PNG1x1 } });
    assert.ok(r.data.ok, JSON.stringify(r.data));
    const { data } = await call('/api/admin/documents/' + docId);
    assert.equal(data.document.status, 'signed'); assert.equal(data.document.signed_name, 'Dana Whitfield');
    assert.ok(data.document.signed_ip); assert.ok(data.signatureUrl, 'drawn signature saved as a file');
  });
  await check('signing requires a typed name', async () => {
    const d2 = (await call('/api/admin/documents', { method: 'POST', body: { customerId: 1, templateId: tplId } })).data.document;
    const r = await call('/api/documents/sign', { method: 'POST', auth: false, body: { token: d2.access_token } });
    assert.equal(r.status, 400);
  });
  await check('[codex] document rejects appointment from another customer', async () => {
    // assignApptId belongs to customer 1; pairing it with customer 2 must be rejected.
    const r = await call('/api/admin/documents', { method: 'POST', body: { customerId: 2, templateId: tplId, appointmentId: assignApptId } });
    assert.equal(r.status, 400);
  });
  await check('customer WDII PDF autofills known fields and stays editable', async () => {
    const customer = (await call('/api/admin/customers/1')).data.customer;
    const res = await fetch(base + '/api/admin/documents/customer/1/generate', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'wdii' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /WDII_Inspection_Report\.pdf/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 100_000 && bytes.length < 4_500_000, `unexpected WDII size ${bytes.length}`);
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 2);
    const form = pdf.getForm();
    assert.equal(form.getTextField('lic_no').getText(), '33560');
    assert.match(form.getTextField('address_inspected').getText(), new RegExp(customer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(form.getTextField('seller_print_name').getText(), customer.name);
    assert.ok(form.getFields().length >= 48, 'inspection fields remain editable');
  });
  await check('customer service agreement generates a clean cadence-specific PDF', async () => {
    const customer = (await call('/api/admin/customers/1')).data.customer;
    const res = await fetch(base + '/api/admin/documents/customer/1/generate', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'service_agreement', frequency: 'quarterly', notes: 'Exterior service and bait station maintenance.', initialServiceFeeCents: 0, serviceFeeCents: 12_500 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /Pest_Control_Service_Agreement\.pdf/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(Buffer.from(bytes.slice(0, 4)).toString(), '%PDF');
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.match(pdf.getTitle(), new RegExp(customer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(pdf.getSubject(), /Quarterly/);
    assert.ok(!Buffer.from(bytes).toString('latin1').includes('Thomas Park Management'), 'prior customer PII is absent');
  });
  await check('customer PDF generation validates cadence and tenant-scoped customer', async () => {
    const invalid = await call('/api/admin/documents/customer/1/generate', { method: 'POST', body: { type: 'service_agreement', frequency: 'weekly' } });
    assert.equal(invalid.status, 400);
    const missing = await call('/api/admin/documents/customer/999999/generate', { method: 'POST', body: { type: 'wdii' } });
    assert.equal(missing.status, 404);
  });
  await check('customer PDF downloads are audited without storing note contents', async () => {
    const row = await query("SELECT details FROM audit_log WHERE tenant_id=1 AND action='customer_pdf_generate' ORDER BY id DESC LIMIT 1");
    assert.equal(row.rows.length, 1);
    assert.ok(['wdii', 'service_agreement'].includes(row.rows[0].details.type));
    assert.equal(JSON.stringify(row.rows[0].details).includes('bait station'), false);
  });

  // --- Route optimization + GPS ---
  await check('keyless route estimates expose geometry, legs, drive time, and fuel cost', async () => {
    const { assignNearbyStops, buildEstimatedRoute, geocode, haversine, mapsUrl, routingAssumptions, summarizeEstimatedRoutes } = await import('../src/lib/routing.js');
    const assumptions = {
      averageSpeedMph: 28, roadDistanceFactor: 1.22, vehicleMpg: 22,
      fuelPricePerGallon: 3.50, includeReturnToBase: true,
    };
    const origin = { address: 'Base', lat: 39, lng: -76 };
    const stops = [
      { appointmentId: 10, address: 'North', lat: 39.1, lng: -76 },
      { appointmentId: 11, address: 'West', lat: 39.1, lng: -76.1 },
    ];
    const estimate = buildEstimatedRoute(stops, origin, assumptions);
    assert.equal(estimate.quality, 'estimate');
    assert.deepEqual(estimate.geometry.coordinates, [[-76, 39], [-76, 39.1], [-76.1, 39.1], [-76, 39]]);
    assert.equal(estimate.legs.length, 3);
    assert.ok(estimate.legs.every((leg) => leg.quality === 'estimate'));
    const straight = haversine(origin, stops[0]) + haversine(stops[0], stops[1]) + haversine(stops[1], origin);
    const road = straight * assumptions.roadDistanceFactor;
    assert.equal(estimate.metrics.estimatedRoadMiles, Math.round(road * 10) / 10);
    assert.equal(estimate.metrics.estimatedDriveMinutes, Math.round(road / assumptions.averageSpeedMph * 60));
    assert.equal(estimate.metrics.estimatedFuelCostCents, Math.round(road / assumptions.vehicleMpg * 350));

    const partial = buildEstimatedRoute([...stops, { appointmentId: 12, address: 'Missing coordinates' }], origin, assumptions);
    assert.equal(partial.quality, 'partial');
    assert.equal(partial.metrics.measuredLegCount, 2);
    assert.equal(partial.metrics.totalLegCount, 4);
    assert.equal(partial.legs.at(-1).quality, 'unavailable');
    assert.equal(partial.geometry.type, 'MultiLineString');
    assert.deepEqual(partial.geometry.coordinates, [
      [[-76, 39], [-76, 39.1]],
      [[-76, 39.1], [-76.1, 39.1]],
    ], 'partial geometry includes only adjacent measured legs');
    const crewSummary = summarizeEstimatedRoutes([
      { stops:[{ appointmentId:10 }], metrics:estimate.metrics },
      { stops:[{ appointmentId:10 }], metrics:estimate.metrics },
    ]);
    assert.equal(crewSummary.stopCount, 1, 'a crew visit is counted once in the board total');
    assert.equal(crewSummary.routedStopCount, 2, 'per-rep route stops remain visible');
    const loopUrl = new URL(mapsUrl(stops, 'Base', true));
    assert.equal(loopUrl.searchParams.get('origin'), 'Base');
    assert.equal(loopUrl.searchParams.get('destination'), 'Base');
    assert.equal(loopUrl.searchParams.get('waypoints'), 'North|West');
    const originAware = assignNearbyStops([
      { technician: { id: 1 }, index: 0, origin: { address: 'North base', lat: 40, lng: -76 }, stops: [] },
      { technician: { id: 2 }, index: 1, origin: { address: 'South base', lat: 38, lng: -76 }, stops: [] },
    ], [{ appointmentId: 20, address: 'Near south', lat: 38.1, lng: -76, time: '2026-07-15T14:00:00Z', end: '2026-07-15T15:00:00Z' }]);
    assert.equal(originAware.proposals[0].technicianId, 2, 'empty routes are seeded from the nearest rep start');

    const geoTenant = { id:99, settings:{ integrations:{ geocoding:{ provider:'google', apiKey:'test-key' } } } };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok:true, json:async()=>({ results:[{ geometry:{ location:{ lat:999, lng:-76 } } }] }) });
      assert.equal(await geocode(geoTenant, 'Invalid coordinate'), null, 'provider coordinates are range-checked');
      globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once:true });
      });
      const timeoutStarted = Date.now();
      assert.equal(await geocode(geoTenant, 'Slow provider', { timeoutMs:20 }), null);
      assert.ok(Date.now() - timeoutStarted < 1_000, 'provider timeout is bounded');
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(routingAssumptions({ averageSpeedMph: 0 }).averageSpeedMph, 28, 'invalid stored assumptions fail safe');
  });
  await check('routing requires technicianId + date', async () => {
    assert.equal((await call('/api/admin/routing')).status, 400);
    assert.equal((await call('/api/admin/routing?technicianId=99999999&date=2026-07-15')).status, 400);
  });
  await check('route lists the tech stops + builds a maps link', async () => {
    await query('UPDATE appointments SET service_lat=39.0000, service_lng=-76.0000 WHERE id=$1', [assignApptId]);
    await call(`/api/admin/appointments/${assignApptId}`, { method: 'PATCH', body: { serviceAddress: '123 Main St, Baltimore, MD' } });
    const changed = (await call('/api/admin/appointments/' + assignApptId)).data.appointment;
    assert.equal(changed.service_lat, null); assert.equal(changed.service_lng, null);
    const { data } = await call(`/api/admin/routing?technicianId=${techId}&date=2026-07-15`);
    assert.ok(data.ok); assert.ok(data.stops.some((s) => s.appointmentId === assignApptId));
    assert.equal(data.geocoder, false); // no geocoder in dev
    assert.ok(data.mapsUrl && data.mapsUrl.includes('google.com/maps/dir'));
    assert.equal(data.origin.address, marcoRouteStart);
    assert.equal(data.origin.source, 'technician');
    assert.equal(new URL(data.mapsUrl).searchParams.get('origin'), marcoRouteStart);
    assert.equal(data.assumptions.averageSpeedMph, 28);
    assert.ok(['estimate', 'partial', 'unavailable'].includes(data.quality));
    assert.ok(Array.isArray(data.legs)); assert.ok(data.metrics);
    assert.ok(Object.prototype.hasOwnProperty.call(data, 'geometry'));
    assert.ok(Object.prototype.hasOwnProperty.call(data, 'totalMiles'));
  });
  await check('route planning geocodes, persists, and returns each rep starting point', async () => {
    const { planRoutes } = await import('../src/lib/routing.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const fallback = (await query(
      "INSERT INTO technicians (tenant_id,name,color) VALUES (1,'Business Start Rep','#16a34a') RETURNING id",
    )).rows[0];
    const tenant = await getTenantById(1);
    tenant.config_version = 900027;
    tenant.settings.integrations.geocoding = { provider: 'google', apiKey: 'route-origin-test-key' };
    tenant.settings.routing.includeReturnToBase = true;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => {
        const address = new URL(String(input)).searchParams.get('address');
        const location = address === marcoRouteStart
          ? { lat: 39.2904, lng: -76.6122 }
          : address === tenant.address
            ? { lat: 38.9784, lng: -76.4922 }
            : { lat: 39.1100, lng: -76.7000 };
        return { ok: true, json: async () => ({ results: [{ geometry: { location } }] }) };
      };
      const plan = await planRoutes(tenant, {
        date: '2026-07-15', technicianIds: [techId, Number(fallback.id)], includeUnassigned: false,
      });
      const customRoute = plan.routes.find((route) => route.technician.id === Number(techId));
      const fallbackRoute = plan.routes.find((route) => route.technician.id === Number(fallback.id));
      assert.equal(customRoute.origin.address, marcoRouteStart);
      assert.equal(customRoute.origin.source, 'technician');
      assert.equal(customRoute.origin.lat, 39.2904); assert.equal(customRoute.origin.lng, -76.6122);
      assert.equal(fallbackRoute.origin.address, tenant.address);
      assert.equal(fallbackRoute.origin.source, 'business');
      assert.equal(fallbackRoute.origin.lat, 38.9784); assert.equal(fallbackRoute.origin.lng, -76.4922);
      assert.ok(customRoute.stops.length, 'custom-origin rep has a route stop');
      const directions = new URL(customRoute.mapsUrl);
      assert.equal(directions.searchParams.get('origin'), marcoRouteStart);
      assert.equal(directions.searchParams.get('destination'), marcoRouteStart, 'return route ends at the rep start');
      assert.equal(customRoute.legs[0].from.address, marcoRouteStart);
      assert.equal(customRoute.legs.at(-1).to.address, marcoRouteStart);
      const cached = (await query(
        'SELECT route_start_lat, route_start_lng FROM technicians WHERE tenant_id=1 AND id=$1',
        [techId],
      )).rows[0];
      assert.equal(Number(cached.route_start_lat), 39.2904); assert.equal(Number(cached.route_start_lng), -76.6122);
      const fallbackCache = (await query(
        'SELECT route_start_lat, route_start_lng FROM technicians WHERE tenant_id=1 AND id=$1',
        [fallback.id],
      )).rows[0];
      assert.equal(fallbackCache.route_start_lat, null); assert.equal(fallbackCache.route_start_lng, null);
    } finally {
      globalThis.fetch = originalFetch;
      await query('DELETE FROM technicians WHERE tenant_id=1 AND id=$1', [fallback.id]);
    }
  });
  await check('appointment address PATCH rejects blank values but permits legacy unrelated edits', async () => {
    const legacy = (await query(
      `INSERT INTO appointments (tenant_id, customer_id, status, booking_mode, source, service_address, requested_slots)
       VALUES (1,1,'requested','request','admin',NULL,'[]'::jsonb) RETURNING id`,
    )).rows[0];
    for (const serviceAddress of [null, '', '   ', 123]) {
      const rejected = await call(`/api/admin/appointments/${legacy.id}`, { method:'PATCH', body:{ serviceAddress } });
      assert.equal(rejected.status, 400); assert.match(rejected.data.error, /service address is required/i);
    }
    const notes = await call(`/api/admin/appointments/${legacy.id}`, { method:'PATCH', body:{ internalNotes:'Collect address on follow-up' } });
    assert.equal(notes.status, 200); assert.equal(notes.data.appointment.internal_notes, 'Collect address on follow-up');
    await call(`/api/admin/appointments/${legacy.id}`, { method:'PATCH', body:{ status:'canceled' } });
  });
  await check('customer address edits clear only fallback appointment coordinates', async () => {
    const customer = (await call('/api/admin/customers', { method: 'POST', body: {
      name: 'Coordinate Cache Customer', address: '1 Old Address', city: 'Annapolis', state: 'MD', postalCode: '21401',
    } })).data.customer;
    const fallback = (await query(
      `INSERT INTO appointments
         (tenant_id, customer_id, status, booking_mode, source, scheduled_start, scheduled_end, service_lat, service_lng)
       VALUES (1,$1,'canceled','instant','admin','2026-09-01T13:00:00Z','2026-09-01T14:00:00Z',39.0,-76.0) RETURNING id`,
      [customer.id],
    )).rows[0];
    const explicit = (await query(
      `INSERT INTO appointments
         (tenant_id, customer_id, status, booking_mode, source, scheduled_start, scheduled_end, service_address, service_lat, service_lng)
       VALUES (1,$1,'canceled','instant','admin','2026-09-01T15:00:00Z','2026-09-01T16:00:00Z','99 Explicit Site',38.0,-77.0) RETURNING id`,
      [customer.id],
    )).rows[0];
    const changed = await call(`/api/admin/customers/${customer.id}`, { method: 'PATCH', body: {
      address: '2 New Address', city: 'Baltimore', postalCode: '21201',
    } });
    assert.ok(changed.data.ok, JSON.stringify(changed.data));
    const rows = (await query(
      'SELECT id, service_lat, service_lng FROM appointments WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[fallback.id, explicit.id]],
    )).rows;
    const fallbackAfter = rows.find((row) => row.id === fallback.id);
    const explicitAfter = rows.find((row) => row.id === explicit.id);
    assert.equal(fallbackAfter.service_lat, null); assert.equal(fallbackAfter.service_lng, null);
    assert.equal(Number(explicitAfter.service_lat), 38); assert.equal(Number(explicitAfter.service_lng), -77);
  });
  await check('route overlap anchors include prior-day cross-midnight jobs', async () => {
    const anchor = (await call('/api/admin/appointments', { method: 'POST', body: {
      customerId: 1, serviceId: 1, start: '2026-07-14T03:30:00.000Z', end: '2026-07-14T04:30:00.000Z',
      serviceAddress: '1 Midnight Way, Annapolis, MD', technicianId: techId, force: true,
    } })).data.appointment;
    const candidate = (await call('/api/admin/appointments', { method: 'POST', body: {
      customerId: 1, serviceId: 1, start: '2026-07-14T04:00:00.000Z', end: '2026-07-14T05:00:00.000Z',
      serviceAddress: '2 Midnight Way, Annapolis, MD', force: true,
    } })).data.appointment;
    const plan = (await call(`/api/admin/routing/plan?date=2026-07-14&technicianIds=${techId}&includeUnassigned=1`)).data;
    assert.ok(plan.routes[0].stops.some((stop) => stop.appointmentId === anchor.id), 'cross-midnight anchor included');
    assert.ok(plan.unplaced.some((stop) => stop.appointmentId === candidate.id), 'overlapping candidate left unassigned');
    assert.deepEqual(plan.assumptions, {
      averageSpeedMph: 28, roadDistanceFactor: 1.22, vehicleMpg: 22,
      fuelPricePerGallon: 3.5, includeReturnToBase: false,
    });
    assert.ok(plan.summary); assert.equal(plan.summary.routeCount, 1);
    assert.ok(['estimate', 'partial', 'unavailable'].includes(plan.summary.quality));
    assert.ok(plan.routes[0].metrics); assert.ok(Object.prototype.hasOwnProperty.call(plan.routes[0], 'geometry'));
    await call(`/api/admin/appointments/${anchor.id}`, { method: 'PATCH', body: { status: 'canceled' } });
    await call(`/api/admin/appointments/${candidate.id}`, { method: 'PATCH', body: { status: 'canceled' } });
  });
  await check('field /me includes a route map link', async () => {
    const { data } = await call(`/api/field/me?token=${fieldToken}&date=2026-07-15`, { auth: false });
    assert.ok(data.routeUrl && data.routeUrl.includes('maps'));
    assert.equal(new URL(data.routeUrl).searchParams.get('origin'), marcoRouteStart);
  });

  // --- Pest compliance (chemical records + state export) ---
  let productId;
  await check('create a chemical product (catalog)', async () => {
    const { data } = await call('/api/admin/compliance/products', { method: 'POST', body: { name: 'Termidor SC', epaRegNo: '7969-210', activeIngredient: 'Fipronil', signalWord: 'Caution', unit: 'oz', defaultRate: '0.8 oz/gal', targetPests: 'Ants, Termites' } });
    assert.ok(data.ok); productId = data.product.id;
  });
  let applId;
  await check('record an application (snapshots EPA + applicator)', async () => {
    const { data } = await call(`/api/admin/appointments/${assignApptId}/applications`, { method: 'POST', body: { productId, technicianId: techId, targetPest: 'Ants', areaTreated: 'Perimeter', quantity: 1.5, unit: 'gal', method: 'spray' } });
    assert.ok(data.ok, JSON.stringify(data)); applId = data.application.id;
    assert.equal(data.application.epa_reg_no, '7969-210'); assert.equal(data.application.product_name, 'Termidor SC');
    assert.equal(data.application.applicator_name, 'Marco Diaz');
  });
  await check('service report includes applications + crew', async () => {
    const { data } = await call(`/api/admin/appointments/${assignApptId}/service-report`);
    assert.ok(data.report.applications.some((a) => a.id === applId));
    assert.ok(data.report.crew.some((c) => c.name === 'Marco Diaz'));
  });
  await check('state-report CSV export includes the application', async () => {
    const res = await fetch(base + '/api/admin/compliance/applications.csv?from=2026-01-01&to=2026-12-31', { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/csv');
    const text = await res.text();
    assert.ok(text.split('\n')[0].includes('EPA Reg #')); assert.ok(text.includes('Termidor SC'));
  });
  await check('field tech can log a material application', async () => {
    const { data } = await call(`/api/field/jobs/${assignApptId}/applications`, { method: 'POST', auth: false, body: { token: fieldToken, productId, targetPest: 'Spiders' } });
    assert.ok(data.ok); assert.equal(data.application.applicator_name, 'Marco Diaz');
  });

  // --- Devices / traps + QR inspections ---
  let deviceId; let deviceQr;
  await check('create a device with a QR scan link', async () => {
    const { data } = await call('/api/admin/devices', { method: 'POST', body: { customerId: 1, label: 'Bait Station #1', deviceType: 'bait_station', locationNotes: 'NE corner' } });
    assert.ok(data.ok); deviceId = data.device.id; deviceQr = data.device.qr_token;
    assert.ok(data.device.scanUrl.includes('/device?d='));
  });
  await check('list devices for a customer', async () => {
    const { data } = await call('/api/admin/devices?customerId=1');
    assert.ok(data.devices.some((d) => d.id === deviceId));
  });
  await check('public QR endpoint returns device + history', async () => {
    assert.equal((await call('/api/devices/nope', { auth: false })).status, 404);
    const { data } = await call('/api/devices/' + deviceQr, { auth: false });
    assert.ok(data.ok); assert.equal(data.device.label, 'Bait Station #1');
  });
  await check('inspection requires a valid technician field token', async () => {
    const bad = await call(`/api/devices/${deviceQr}/inspect`, { method: 'POST', auth: false, body: { status: 'ok' } });
    assert.equal(bad.status, 400);
    const ok = await call(`/api/devices/${deviceQr}/inspect`, { method: 'POST', auth: false, body: { fieldToken, status: 'activity', activityLevel: 'low', actionTaken: 'Rebaited' } });
    assert.ok(ok.data.ok);
  });
  await check('device history reflects the inspection', async () => {
    const { data } = await call('/api/admin/devices/' + deviceId);
    assert.ok(data.history.length >= 1); assert.equal(data.history[0].status, 'activity');
    assert.equal(data.history[0].technician_name, 'Marco Diaz');
  });

  // --- AI receptionist SCAFFOLD (no live voice) ---
  await check('receptionist reports scaffold (not live)', async () => {
    const { data } = await call('/api/admin/voice');
    assert.equal(data.status.live, false); assert.equal(data.status.scaffold, true);
    assert.ok(!('authToken' in data.settings), 'secrets never returned');
  });
  await check('simulate a booking call captures intent', async () => {
    const { data } = await call('/api/admin/voice/simulate', { method: 'POST', body: { scenario: 'booking' } });
    assert.ok(data.ok); assert.equal(data.call.intent.type, 'book'); assert.equal(data.call.status, 'completed');
  });
  await check('urgent call triggers handoff', async () => {
    const { data } = await call('/api/admin/voice/simulate', { method: 'POST', body: { scenario: 'transfer' } });
    assert.equal(data.call.handoff, true); assert.equal(data.call.status, 'transferred'); assert.ok(data.call.handoff_reason);
  });
  await check('missed call runs the text-back workflow', async () => {
    const { data } = await call('/api/admin/voice/simulate', { method: 'POST', body: { scenario: 'missed' } });
    assert.equal(data.call.status, 'missed'); assert.ok(data.missed.ran);
  });
  await check('voice webhook records + dedupes by external id', async () => {
    const body = { id: 'ext_call_777', from: '+14105550123', to: '+14105551169', status: 'completed', transcript: 'I want to schedule a service' };
    const a = await call('/api/webhooks/voice/mock', { method: 'POST', auth: false, body });
    assert.ok(a.data.ok); const id1 = a.data.callId;
    const b = await call('/api/webhooks/voice/mock', { method: 'POST', auth: false, body });
    assert.equal(b.data.callId, id1, 'idempotent on external id');
  });
  await check('receptionist settings encrypt the auth token', async () => {
    const r = await call('/api/admin/voice/settings', { method: 'PUT', body: { provider: 'vapi', enabled: true, authToken: 'super-secret-key', greeting: 'Hello' } });
    assert.ok(r.data.ok);
    const back = await call('/api/admin/voice');
    assert.ok(!JSON.stringify(back.data.settings).includes('super-secret-key'), 'token not exposed');
    assert.equal(back.data.settings.hasCredentials, true);
  });

  // --- Public API v1 + outbound webhooks (Zapier/Make) ---
  let apiKey;
  await check('owner can mint an API key (secret shown once)', async () => {
    const { data } = await call('/api/admin/developer/keys', { method: 'POST', body: { name: 'Zapier', scopes: ['read', 'write'] } });
    assert.ok(data.key.secret.startsWith('oarf_')); apiKey = data.key.secret;
    const back = await call('/api/admin/developer');
    assert.ok(!JSON.stringify(back.data.apiKeys).includes(apiKey), 'full secret never returned again');
  });
  await check('API rejects requests without a key', async () => {
    const res = await fetch(base + '/api/v1/customers');
    assert.equal(res.status, 401);
  });
  await check('API key authenticates + scopes the tenant', async () => {
    const res = await fetch(base + '/api/v1/customers', { headers: { Authorization: 'Bearer ' + apiKey } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data) && body.data.length >= 1);
    const me = await (await fetch(base + '/api/v1/me', { headers: { Authorization: 'Bearer ' + apiKey } })).json();
    assert.ok(me.tenant.name); assert.ok(me.events.includes('invoice.paid'));
  });
  await check('API customer creation requires a street service address', async () => {
    const res = await fetch(base + '/api/v1/customers', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API Missing Address' }) });
    const body = await res.json(); assert.equal(res.status, 400); assert.match(body.error, /service address is required/i);
  });
  await check('API can create a customer (write scope)', async () => {
    const res = await fetch(base + '/api/v1/customers', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API Created', email: 'api.created@example.com', address: '500 API Avenue' }) });
    const body = await res.json(); assert.ok(body.ok); assert.ok(body.data.id); assert.equal(body.data.address, '500 API Avenue');
  });
  let hookEpId;
  await check('subscribe a webhook endpoint (HMAC secret once)', async () => {
    const { data } = await call('/api/admin/developer/webhooks', { method: 'POST', body: { url: base + '/api/v1/ping', events: ['*'] } });
    assert.ok(data.endpoint.secret.startsWith('whsec_')); hookEpId = data.endpoint.id;
  });
  await check('emitting an event enqueues + delivers a signed webhook', async () => {
    // create+pay an invoice in full -> invoice.paid event fans out to the endpoint
    const inv = (await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, taxRatePercent: 0, lineItems: [{ label: 'Hook test', unit_amount_cents: 1000, taxable: false }] } })).data.invoice;
    await call(`/api/admin/invoices/${inv.id}/send`, { method: 'POST' });
    await call(`/api/admin/invoices/${inv.id}/payment`, { method: 'POST', body: { amountCents: inv.total_cents, method: 'cash' } });
    await new Promise((r) => setTimeout(r, 600)); // let the async webhook fan-out settle
    await call('/api/admin/developer/webhooks/deliver', { method: 'POST' });
    const back = await call('/api/admin/developer');
    const dlv = back.data.deliveries.filter((d) => d.event === 'invoice.paid');
    assert.ok(dlv.length, 'invoice.paid delivery enqueued');
    assert.ok(dlv.some((d) => d.status === 'delivered' && d.response_code === 200), 'signed delivery succeeded to the sink');
  });

  // --- Commission tracking ---
  let commAppt;
  await check('create a commission rule (10% of revenue)', async () => {
    const { data } = await call('/api/admin/commissions/rules', { method: 'POST', body: { name: 'Tech 10%', technicianId: techId, basis: 'revenue', percent: 10 } });
    assert.ok(data.ok);
  });
  await check('completing an assigned job accrues commission', async () => {
    const services = (await call('/api/admin/appointments/meta/services')).data.services;
    const created = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Commission Test' }, serviceId: services[0].id, date: '2026-08-10', time: '10:00', serviceAddress: '77 Commission Court, Baltimore, MD', force: true } });
    commAppt = created.data.appointment.id;
    await call(`/api/admin/appointments/${commAppt}/assign`, { method: 'POST', body: { technicianIds: [techId], leadId: techId } });
    await call(`/api/admin/appointments/${commAppt}`, { method: 'PATCH', body: { status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));
    const d = await call('/api/admin/commissions');
    const e = d.data.entries.find((x) => x.appointment_id === commAppt && x.technician_id === techId);
    assert.ok(e, 'commission accrued for the assigned tech'); assert.equal(e.basis, 'revenue'); assert.ok(e.amount_cents > 0);
  });
  await check('completion accrual is idempotent', async () => {
    await call(`/api/admin/appointments/${commAppt}`, { method: 'PATCH', body: { status: 'completed' } });
    await new Promise((r) => setTimeout(r, 350));
    const d = await call('/api/admin/commissions');
    assert.equal(d.data.entries.filter((x) => x.appointment_id === commAppt && x.technician_id === techId).length, 1);
  });
  await check('per-tech summary + mark paid', async () => {
    const before = (await call('/api/admin/commissions')).data.summary.find((s) => s.technicianId === techId);
    assert.ok(before && before.accruedCents > 0);
    await call('/api/admin/commissions/pay', { method: 'POST', body: { technicianId: techId } });
    const after = await call('/api/admin/commissions?status=accrued');
    assert.ok(!after.data.entries.some((x) => x.technician_id === techId));
  });
  await check('commission CSV export', async () => {
    const res = await fetch(base + '/api/admin/commissions/export.csv', { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/csv');
    assert.ok((await res.text()).split('\n')[0].includes('Commission'));
  });

  // --- Multi-unit properties + units + diagrams ---
  let propId; let unitId;
  await check('create a property for a customer', async () => {
    const { data } = await call('/api/admin/properties', { method: 'POST', body: { customerId: 1, name: 'Maple Apartments', address: '500 Maple Ave', city: 'Baltimore', state: 'MD' } });
    assert.ok(data.ok); propId = data.property.id;
  });
  await check('add units to the property', async () => {
    unitId = (await call('/api/admin/properties/units', { method: 'POST', body: { propertyId: propId, label: 'Apt 2B', floor: '2' } })).data.unit.id;
    await call('/api/admin/properties/units', { method: 'POST', body: { propertyId: propId, label: 'Apt 3A', floor: '3' } });
    const { data } = await call('/api/admin/properties/' + propId + '/units');
    assert.equal(data.units.length, 2);
    const props = (await call('/api/admin/properties?customerId=1')).data.properties;
    assert.equal(props.find((p) => p.id === propId).unit_count, 2);
  });
  await check('tie a device to a unit + see it in unit detail', async () => {
    await call('/api/admin/devices', { method: 'POST', body: { customerId: 1, label: 'Station 2B-1', unitId, deviceType: 'bait_station' } });
    const { data } = await call('/api/admin/properties/units/' + unitId);
    assert.ok(data.devices.some((d) => d.label === 'Station 2B-1'));
  });
  await check('save a unit diagram (clamped markers)', async () => {
    const { data } = await call(`/api/admin/properties/units/${unitId}/diagram`, { method: 'POST', body: { markers: [{ x: 0.25, y: 0.4, label: 'Kitchen' }, { x: 2, y: -1, label: 'clamp me' }] } });
    assert.ok(data.ok);
    const detail = (await call('/api/admin/properties/units/' + unitId)).data;
    assert.equal(detail.unit.diagram.markers.length, 2);
    assert.equal(detail.unit.diagram.markers[1].x, 1); // clamped to [0,1]
    assert.equal(detail.unit.diagram.markers[1].y, 0);
  });
  await check('upload a unit floorplan (image)', async () => {
    const { data } = await call(`/api/admin/properties/units/${unitId}/floorplan`, { method: 'POST', body: { filename: 'plan.png', contentType: 'image/png', dataBase64: PNG1x1 } });
    assert.ok(data.floorplanUrl.includes('/api/files/'));
  });

  // --- Reviews / NPS (no rating gating) ---
  await check('set a public review platform URL', async () => {
    const { data } = await call('/api/admin/reviews/settings', { method: 'PUT', body: { platforms: { google: 'https://g.page/r/demo/review' } } });
    assert.ok(data.ok);
  });
  let revToken;
  await check('request a review (email) returns a token', async () => {
    const { data } = await call('/api/admin/reviews/request', { method: 'POST', body: { customerId: 1, channel: 'email' } });
    assert.ok(data.ok); revToken = data.request.access_token; assert.ok(revToken);
  });
  await check('public review page is token-guarded + shows links', async () => {
    assert.equal((await call('/api/reviews?token=bad', { auth: false })).status, 404);
    const { data } = await call('/api/reviews?token=' + revToken, { auth: false });
    assert.ok(data.ok); assert.ok(data.platforms.google);
  });
  await check('5-star response records + returns public links', async () => {
    const { data } = await call('/api/reviews/respond', { method: 'POST', auth: false, body: { token: revToken, rating: 5, comment: 'Great!' } });
    assert.ok(data.ok); assert.ok(data.platforms.google);
  });
  await check('LOW rating still gets public links (no gating)', async () => {
    const r = (await call('/api/admin/reviews/request', { method: 'POST', body: { customerId: 2, channel: 'email' } })).data.request;
    const { data } = await call('/api/reviews/respond', { method: 'POST', auth: false, body: { token: r.access_token, rating: 1, comment: 'unhappy' } });
    assert.ok(data.platforms.google, 'public links must show even for 1-star');
  });
  await check('review metrics reflect responses', async () => {
    const { data } = await call('/api/admin/reviews');
    assert.ok(data.metrics.responses >= 2); assert.ok(data.metrics.avgRating > 0);
  });
  await check('review request is idempotent per appointment', async () => {
    const appt = (await call('/api/admin/appointments')).data.appointments[0];
    assert.ok(appt, 'need a seeded appointment');
    const a1 = (await call('/api/admin/reviews/request', { method: 'POST', body: { customerId: appt.customer_id, appointmentId: appt.id } })).data.request;
    const a2 = (await call('/api/admin/reviews/request', { method: 'POST', body: { customerId: appt.customer_id, appointmentId: appt.id } })).data.request;
    assert.equal(a1.id, a2.id);
  });
  await check('[codex] review request rejects mismatched customer/appointment', async () => {
    const appt = (await call('/api/admin/appointments')).data.appointments.find((a) => a.customer_id === 1);
    const otherCustomer = appt.customer_id === 2 ? 1 : 2;
    const r = await call('/api/admin/reviews/request', { method: 'POST', body: { customerId: otherCustomer, appointmentId: appt.id } });
    assert.equal(r.status, 400);
  });

  // --- Recurring plans + subscriptions ---
  await check('plans overview returns MRR + plans', async () => { const { data } = await call('/api/admin/plans'); assert.ok(data.plans.length >= 4); assert.ok(data.metrics.mrrCents > 0); });
  let newPlanId;
  await check('create a plan', async () => { const { data } = await call('/api/admin/plans', { method: 'POST', body: { name: 'Smoke Monthly', interval: 'monthly', priceCents: 4900 } }); newPlanId = data.plan.id; assert.ok(newPlanId); });
  let subId;
  await check('enroll a customer (internal)', async () => { const { data } = await call('/api/admin/plans/subscriptions', { method: 'POST', body: { customerId: 2, planId: newPlanId } }); subId = data.subscription.id; assert.equal(data.subscription.status, 'active'); assert.ok(data.subscription.next_run_date); });
  await check('generate due cycles makes a backdated visit', async () => {
    // backdate next_run so it's due, then generate
    const { closeDb: _c } = {}; void _c;
    await (await import('../src/lib/db.js')).query("UPDATE subscriptions SET next_run_date = (now() - interval '1 day') WHERE id=$1", [subId]);
    const { data } = await call('/api/admin/plans/generate-due', { method: 'POST' });
    assert.ok(data.appointments >= 1 || data.invoices >= 1);
  });
  await check('pause a subscription', async () => { const { data } = await call(`/api/admin/plans/subscriptions/${subId}`, { method: 'PATCH', body: { status: 'paused' } }); assert.equal(data.subscription.status, 'paused'); });

  // --- Follow-ups ---
  await check('follow-ups queue lists items', async () => { const { data } = await call('/api/admin/follow-ups'); assert.ok(Array.isArray(data.followUps)); assert.ok(Array.isArray(data.rules)); });
  await check('create + complete a follow-up', async () => {
    const c = await call('/api/admin/follow-ups', { method: 'POST', body: { title: 'Smoke follow-up', dueDate: ymd(new Date()), channel: 'task' } });
    const fid = c.data.followUp.id;
    const u = await call('/api/admin/follow-ups/' + fid, { method: 'PATCH', body: { status: 'done' } });
    assert.equal(u.data.followUp.status, 'done');
  });
  await check('save automation rules', async () => { const { data } = await call('/api/admin/follow-ups/rules', { method: 'PUT', body: { rules: [{ name: 'Check-in', offsetDays: 5, channel: 'email', templateType: 'follow_up', active: true }] } }); assert.equal(data.rules.length, 1); });
  await check('run due follow-up emails', async () => { const { data } = await call('/api/admin/follow-ups/run-due', { method: 'POST' }); assert.ok(data.ok); });

  // --- Settings + integrations ---
  await check('settings overview', async () => {
    const { data } = await call('/api/admin/settings');
    assert.ok(data.profile && data.settings.booking && data.integrations);
    assert.deepEqual(data.settings.routing, {
      averageSpeedMph: 28, roadDistanceFactor: 1.22, vehicleMpg: 22,
      fuelPricePerGallon: 3.5, includeReturnToBase: false,
    });
    assert.equal(data.integrations.geocodingProvider, 'none');
    assert.equal(data.integrations.geocodingEnabled, false);
  });
  await check('update business profile', async () => { const { data } = await call('/api/admin/settings/profile', { method: 'PATCH', body: { contactPhone: '(410) 555-9999' } }); assert.equal(data.profile.contactPhone, '(410) 555-9999'); });
  await check('update availability settings', async () => { const { data } = await call('/api/admin/settings/settings', { method: 'PUT', body: { availability: { capacityPerSlot: 3, startTimeIntervalMinutes: 45 } } }); assert.equal(data.settings.availability.capacityPerSlot, 3); assert.equal(data.settings.availability.startTimeIntervalMinutes, 45); });
  await check('appointment form metadata exposes start-time settings', async () => {
    const { data } = await call('/api/admin/appointments/meta/services');
    assert.equal(data.scheduling.startTimeIntervalMinutes, 45);
    assert.ok(Array.isArray(data.scheduling.hours['1']));
  });
  await check('settings reject unsupported suggested-time intervals', async () => {
    const invalid = await call('/api/admin/settings/settings', { method:'PUT', body:{ availability:{ startTimeIntervalMinutes:20 } } });
    assert.equal(invalid.status, 400); assert.match(invalid.data.error, /15, 30, 45, 60, 90, or 120/);
    const unchanged = await call('/api/admin/settings');
    assert.equal(unchanged.data.settings.availability.startTimeIntervalMinutes, 45);
  });
  await check('routing assumptions update with strict range and type validation', async () => {
    const desired = {
      averageSpeedMph: 32, roadDistanceFactor: 1.3, vehicleMpg: 19.5,
      fuelPricePerGallon: 3.79, includeReturnToBase: true,
    };
    const saved = await call('/api/admin/settings/settings', { method:'PUT', body:{ routing:desired } });
    assert.equal(saved.status, 200); assert.deepEqual(saved.data.settings.routing, desired);
    const invalid = [
      { averageSpeedMph:0 }, { roadDistanceFactor:0.9 }, { vehicleMpg:'many' },
      { fuelPricePerGallon:-1 }, { includeReturnToBase:'yes' }, { typoSetting:1 },
    ];
    for (const routing of invalid) {
      const rejected = await call('/api/admin/settings/settings', { method:'PUT', body:{ routing } });
      assert.equal(rejected.status, 400, JSON.stringify(routing));
    }
    const unchanged = await call('/api/admin/settings');
    assert.deepEqual(unchanged.data.settings.routing, desired);
  });
  await check('concurrent settings writes preserve unrelated sections', async () => {
    const [branding, notifications] = await Promise.all([
      call('/api/admin/settings/settings', { method:'PUT', body:{ branding:{ concurrencyProbe:'branding' } } }),
      call('/api/admin/settings/settings', { method:'PUT', body:{ notifications:{ concurrencyProbe:'notifications' } } }),
    ]);
    assert.equal(branding.status, 200); assert.equal(notifications.status, 200);
    const overview = await call('/api/admin/settings');
    assert.equal(overview.data.settings.branding.concurrencyProbe, 'branding');
    assert.equal(overview.data.settings.notifications.concurrencyProbe, 'notifications');
  });
  await check('admin suggested times honor hours, overrides, capacity, and blackouts', async () => {
    const services = (await call('/api/admin/appointments/meta/services')).data.services;
    const service = services.find((row) => row.name === 'General Pest Control');
    assert.ok(service); assert.equal(service.duration_minutes, 60);

    const weekly = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=2026-09-28`);
    assert.equal(weekly.status, 200); assert.equal(weekly.data.startTimeIntervalMinutes, 45);
    assert.deepEqual(weekly.data.slots.slice(0, 3).map((slot) => slot.time), ['08:00', '08:45', '09:30']);

    const specialDate = '2026-09-21';
    const override = await call('/api/admin/settings/overrides', { method:'POST', body:{ serviceDate:specialDate, hoursJson:[{ start:'09:00', end:'12:00' }], capacity:1 } });
    assert.equal(override.status, 200);
    const open = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${specialDate}`);
    assert.deepEqual(open.data.slots.map((slot) => slot.time), ['09:00', '09:45', '10:30']);
    assert.equal(open.data.specialHours, true);

    const appointment = await call('/api/admin/appointments', { method:'POST', body:{ customerId:1, serviceId:service.id, date:specialDate, time:'09:00', serviceAddress:'900 Capacity Court, Baltimore, MD', force:true } });
    assert.equal(appointment.status, 200, JSON.stringify(appointment.data));
    const atCapacity = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${specialDate}`);
    assert.equal(atCapacity.data.slots.find((slot) => slot.time === '09:00').available, false);
    assert.equal(atCapacity.data.slots.find((slot) => slot.time === '09:45').available, false);
    assert.equal(atCapacity.data.slots.find((slot) => slot.time === '10:30').available, true);

    const blackout = await call('/api/admin/settings/blackouts', { method:'POST', body:{ startsAt:'2026-09-21T14:30:00.000Z', endsAt:'2026-09-21T16:00:00.000Z', reason:'Team meeting' } });
    assert.equal(blackout.status, 200);
    const blocked = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${specialDate}`);
    assert.equal(blocked.data.availableSlots.length, 0);
    assert.match(blocked.data.message, /unavailable|capacity/i);

    await call(`/api/admin/appointments/${appointment.data.appointment.id}`, { method:'PATCH', body:{ status:'canceled' } });
    await call(`/api/admin/settings/blackouts/${blackout.data.blackout.id}`, { method:'DELETE' });
    await call(`/api/admin/settings/overrides/${override.data.override.id}`, { method:'DELETE' });
  });
  await check('admin suggested times filter a selected technician and validate ownership', async () => {
    const service = (await call('/api/admin/appointments/meta/services')).data.services.find((row) => row.name === 'General Pest Control');
    const date = '2026-09-28';
    const appointment = await call('/api/admin/appointments', { method:'POST', body:{
      customerId:1, serviceId:service.id, date, time:'08:00', technicianId:techId,
      serviceAddress:'901 Technician Trail, Baltimore, MD', force:true,
    } });
    assert.equal(appointment.status, 200, JSON.stringify(appointment.data));
    const global = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${date}`);
    const filtered = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${date}&technicianId=${techId}`);
    assert.equal(global.data.slots.find((slot) => slot.time === '08:00').available, true, 'global capacity remains');
    assert.equal(filtered.data.slots.find((slot) => slot.time === '08:00').unavailableReason, 'technician');
    assert.equal(filtered.data.slots.find((slot) => slot.time === '08:45').unavailableReason, 'technician');
    assert.equal(filtered.data.slots.find((slot) => slot.time === '09:30').available, true);
    const foreign = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${date}&technicianId=999999`);
    assert.equal(foreign.status, 400); assert.match(foreign.data.error, /unknown technician/i);
    await call(`/api/admin/appointments/${appointment.data.appointment.id}`, { method:'PATCH', body:{ status:'canceled' } });
  });
  await check('admin DST suggestions skip nonexistent, reversed, and duplicate slots', async () => {
    const service = (await call('/api/admin/appointments/meta/services')).data.services.find((row) => row.name === 'General Pest Control');
    const springDate = '2027-03-14';
    const springOverride = await call('/api/admin/settings/overrides', { method:'POST', body:{ serviceDate:springDate, hoursJson:[{ start:'01:00', end:'04:00' }], capacity:3 } });
    const spring = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${springDate}`);
    assert.equal(spring.status, 200);
    assert.deepEqual(spring.data.slots.map((slot) => slot.time), ['01:00', '01:45']);
    assert.ok(spring.data.slots.every((slot) => new Date(slot.end) > new Date(slot.start)));
    assert.equal(new Set(spring.data.slots.map((slot) => slot.start)).size, spring.data.slots.length);
    await call(`/api/admin/settings/overrides/${springOverride.data.override.id}`, { method:'DELETE' });

    const fallDate = '2026-11-01';
    let fallOverride = await call('/api/admin/settings/overrides', { method:'POST', body:{ serviceDate:fallDate, hoursJson:[{ start:'00:30', end:'03:30' }], capacity:3 } });
    const repeated = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${fallDate}`);
    assert.ok(repeated.data.slots.every((slot) => new Date(slot.end) > new Date(slot.start)));
    assert.equal(new Set(repeated.data.slots.map((slot) => slot.start)).size, repeated.data.slots.length);

    fallOverride = await call('/api/admin/settings/overrides', { method:'POST', body:{ serviceDate:fallDate, hoursJson:[{ start:'22:00', end:'23:59' }], capacity:1 } });
    const late = await call('/api/admin/appointments', { method:'POST', body:{ customerId:1, serviceId:service.id, date:fallDate, time:'23:15', serviceAddress:'902 DST Drive, Baltimore, MD', force:true } });
    assert.equal(late.status, 200, JSON.stringify(late.data));
    const lateSlots = await call(`/api/admin/appointments/meta/availability?serviceId=${service.id}&date=${fallDate}`);
    assert.equal(lateSlots.data.slots.find((slot) => slot.time === '22:00').available, true);
    assert.equal(lateSlots.data.slots.find((slot) => slot.time === '22:45').available, false, 'late conflict survives the 25-hour day bound');
    await call(`/api/admin/appointments/${late.data.appointment.id}`, { method:'PATCH', body:{ status:'canceled' } });
    await call(`/api/admin/settings/overrides/${fallOverride.data.override.id}`, { method:'DELETE' });
  });
  await check('concurrent admin creates cannot exceed capacity', async () => {
    const service = (await call('/api/admin/appointments/meta/services')).data.services.find((row) => row.name === 'General Pest Control');
    const date = '2026-10-05';
    const override = await call('/api/admin/settings/overrides', { method:'POST', body:{ serviceDate:date, hoursJson:[{ start:'08:00', end:'10:00' }], capacity:1 } });
    const baseBody = { customerId:1, serviceId:service.id, date, time:'08:00' };
    const results = await Promise.all([
      call('/api/admin/appointments', { method:'POST', body:{ ...baseBody, serviceAddress:'903 Concurrency Court, Baltimore, MD' } }),
      call('/api/admin/appointments', { method:'POST', body:{ ...baseBody, serviceAddress:'904 Concurrency Court, Baltimore, MD' } }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results.find((result) => result.status === 200);
    const loser = results.find((result) => result.status === 409);
    assert.equal(loser.data.code, 'SCHEDULE_WARN');
    const stored = await query("SELECT count(*)::int n FROM appointments WHERE tenant_id=1 AND status='scheduled' AND service_address IN ('903 Concurrency Court, Baltimore, MD','904 Concurrency Court, Baltimore, MD')");
    assert.equal(stored.rows[0].n, 1);
    await call(`/api/admin/appointments/${winner.data.appointment.id}`, { method:'PATCH', body:{ status:'canceled' } });
    await call(`/api/admin/settings/overrides/${override.data.override.id}`, { method:'DELETE' });
  });
  await check('create a service', async () => { const { data } = await call('/api/admin/settings/services', { method: 'POST', body: { name: 'Wasp Removal', durationMinutes: 45, basePriceCents: 11900, bookingMode: 'instant' } }); assert.ok(data.service.id); });
  await check('create an invoice preset', async () => { const { data } = await call('/api/admin/settings/presets', { method: 'POST', body: { label: 'Attic Treatment', defaultAmountCents: 30000 } }); assert.ok(data.preset.id); });
  await check('list + edit email template', async () => { const list = await call('/api/admin/settings/email-templates'); assert.ok(list.data.templates.length >= 7); const put = await call('/api/admin/settings/email-templates/follow_up', { method: 'PUT', body: { subject: 'Checking in!', html: '<p>Hi {{CUSTOMER_NAME}}</p>', text: 'Hi' } }); assert.ok(put.data.ok); });
  await check('add a team member', async () => { const { data } = await call('/api/admin/settings/users', { method: 'POST', body: { username: 'tech1', password: 'temp12345', displayName: 'Tech One', role: 'staff' } }); assert.ok(data.user.id); });
  await check('[booking] global default applies after use-default-mode', async () => {
    await call('/api/admin/settings/settings', { method: 'PUT', body: { booking: { defaultMode: 'request' } } });
    await call('/api/admin/settings/services/use-default-mode', { method: 'POST' });
    const boot = await call('/api/public/default/bootstrap', { auth: false });
    const gp = boot.data.services.find((s) => /General Pest/.test(s.name));
    assert.equal(gp.mode, 'request', 'default-mode service follows the global default');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { booking: { defaultMode: 'instant' } } }); // reset
  });
  await check('[booking] arrival windows: availability + booking', async () => {
    await call('/api/admin/settings/settings', { method: 'PUT', body: { booking: { defaultMode: 'instant' }, availability: { granularity: 'windows', windows: [{ label: 'Morning', start: '08:00', end: '12:00' }, { label: 'Afternoon', start: '12:00', end: '16:00' }] } } });
    const svc = (await call('/api/admin/appointments/meta/services')).data.services.find((s) => /General Pest/.test(s.name));
    let date; let av;
    for (const off of [3, 4, 5, 6, 7, 8]) { date = ymd(new Date(Date.now() + off * 86400000)); av = await call(`/api/public/default/availability?serviceId=${svc.id}&date=${date}`, { auth: false }); if (av.data.slots.length) break; }
    assert.equal(av.data.granularity, 'windows');
    const w = av.data.slots.find((s) => s.kind === 'window' && s.available);
    assert.ok(w && w.rangeLabel && w.label, 'window option has a label + time range');
    const r = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svc.id, slot: { start: w.start, end: w.end }, customer: { name: 'Window Booker', email: 'win@example.com', address: '1 st' } } });
    assert.equal(r.data.status, 'scheduled', 'booked an arrival window');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { availability: { granularity: 'slots' } } }); // reset
  });
  await check('save stripe keys (test placeholders)', async () => { const { data } = await call('/api/admin/settings/integrations/stripe', { method: 'PUT', body: { publishableKey: 'pk_test_x' } }); assert.ok(data.ok); });
  await check('[fix] stripe secret encrypted at rest + decrypts', async () => {
    await call('/api/admin/settings/integrations/stripe', { method: 'PUT', body: { secretKey: 'sk_test_supersecret', webhookSecret: 'whsec_topsecret' } });
    const dbmod = await import('../src/lib/db.js');
    const row = await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'");
    const stored = row.settings.integrations.stripe.secretKey;
    assert.ok(stored.startsWith('enc:v1:'), 'secret stored encrypted');
    const { decryptSecret } = await import('../src/lib/crypto.js');
    assert.equal(decryptSecret(stored), 'sk_test_supersecret');
  });
  await check('geocoding integration validates, encrypts, preserves, redacts, and clears its key', async () => {
    assert.equal((await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'other' } })).status, 400);
    assert.equal((await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'google', apiKey:123 } })).status, 400);

    const atomicRouting = {
      averageSpeedMph: 31, roadDistanceFactor: 1.25, vehicleMpg: 21,
      fuelPricePerGallon: 3.65, includeReturnToBase: false,
    };
    const saved = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'google', apiKey:'maps-super-secret', routing:atomicRouting } });
    assert.equal(saved.status, 200); assert.equal(saved.data.geocodingProvider, 'google'); assert.equal(saved.data.geocodingEnabled, true);
    assert.deepEqual(saved.data.routing, atomicRouting);
    const dbmod = await import('../src/lib/db.js');
    const { decryptSecret } = await import('../src/lib/crypto.js');
    let raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.ok(raw.apiKey.startsWith('enc:v1:')); assert.equal(decryptSecret(raw.apiKey), 'maps-super-secret');
    let encrypted = raw.apiKey;

    const overview = await call('/api/admin/settings');
    assert.equal(overview.data.integrations.geocodingProvider, 'google'); assert.equal(overview.data.integrations.geocodingEnabled, true);
    assert.ok(!JSON.stringify(overview.data).includes('maps-super-secret'));
    assert.ok(!JSON.stringify(overview.data).includes(encrypted));

    const preserved = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'google', apiKey:'   ' } });
    assert.equal(preserved.data.geocodingEnabled, true);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.equal(raw.apiKey, encrypted, 'blank input for the same provider preserves the encrypted key');

    const [disabledRace, blankRace] = await Promise.all([
      call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'none' } }),
      call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'google', apiKey:'' } }),
    ]);
    assert.equal(disabledRace.status, 200);
    assert.ok([200, 400].includes(blankRace.status), `unexpected concurrent save status ${blankRace.status}`);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.equal(raw.provider, 'none'); assert.equal(raw.apiKey, '', 'a stale blank save cannot resurrect a disabled key');

    const restored = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'google', apiKey:'maps-super-secret' } });
    assert.equal(restored.status, 200);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    encrypted = raw.apiKey;

    const switchedWithoutKey = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'mapbox', routing:{ averageSpeedMph:45 } } });
    assert.equal(switchedWithoutKey.status, 400);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.equal(raw.provider, 'google'); assert.equal(raw.apiKey, encrypted, 'a failed provider change preserves the existing credential');
    let overviewAfterFailure = await call('/api/admin/settings');
    assert.equal(overviewAfterFailure.data.settings.routing.averageSpeedMph, atomicRouting.averageSpeedMph, 'atomic save prevents a partial routing update');

    const switched = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'mapbox', apiKey:'mapbox-super-secret' } });
    assert.equal(switched.data.geocodingProvider, 'mapbox'); assert.equal(switched.data.geocodingEnabled, true);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.equal(decryptSecret(raw.apiKey), 'mapbox-super-secret');
    const cleared = await call('/api/admin/settings/integrations/geocoding', { method:'PUT', body:{ provider:'none', apiKey:'ignored' } });
    assert.equal(cleared.data.geocodingProvider, 'none'); assert.equal(cleared.data.geocodingEnabled, false);
    raw = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings.integrations.geocoding;
    assert.equal(raw.apiKey, '');
  });
  await check('[fix] settings response leaks NO secrets or tokens', async () => {
    // Plant a Google refresh token (plaintext in settings) to prove it is redacted.
    const dbmod = await import('../src/lib/db.js');
    const cur = (await dbmod.queryOne("SELECT settings FROM tenants WHERE slug='pasternack'")).settings;
    cur.integrations.google = { ...(cur.integrations.google || {}), connected: true, refreshToken: 'rtok_LEAKME', accessToken: 'atok_LEAKME' };
    await dbmod.query("UPDATE tenants SET settings=$1::jsonb WHERE slug='pasternack'", [JSON.stringify(cur)]);
    const overview = await call('/api/admin/settings');
    const blob = JSON.stringify(overview.data);
    assert.ok(!blob.includes('enc:v1:'), 'no encrypted secret in response');
    assert.ok(!blob.includes('rtok_LEAKME') && !blob.includes('atok_LEAKME'), 'no google tokens in response');
    assert.ok(!blob.includes('whsec_'), 'no webhook secret in response');
    assert.equal(overview.data.settings.integrations, undefined, 'settings.integrations stripped');
  });
  await check('[fix] stripe fails closed when a tenant secret cannot be decrypted', async () => {
    const { stripeSecret } = await import('../src/lib/stripe.js');
    const tenant = { settings: { integrations: { stripe: { secretKey: 'enc:v1:not-real-ciphertext' } } } };
    assert.equal(stripeSecret(tenant), '', 'undecryptable tenant secret yields empty (no platform fallback)');
  });
  await check('cron daily runs without auth fails; with key passes', async () => {
    const noauth = await call('/api/cron/daily', { auth: false });
    assert.equal(noauth.status, 401);
    const ok = await fetch(`${base}/api/cron/daily?key=dev-cron-key`);
    const okd = await ok.json(); assert.ok(okd.ok);
  });

  // --- Regression checks for the code-review findings ---
  await check('[fix] void invoice cannot be paid or revived', async () => {
    const inv = (await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'X', unit_amount_cents: 5000 }] } })).data.invoice;
    await call(`/api/admin/invoices/${inv.id}/void`, { method: 'POST' });
    const pay = await call(`/api/admin/invoices/${inv.id}/payment`, { method: 'POST', body: { amountCents: 5000, method: 'cash' } });
    assert.equal(pay.status, 400);
    const det = await call('/api/admin/invoices/' + inv.id);
    assert.equal(det.data.invoice.status, 'void');
  });
  await check('[fix] new invoice gets a due date from dueDays', async () => {
    const inv = (await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'X', unit_amount_cents: 5000 }] } })).data.invoice;
    assert.ok(inv.due_date, 'due_date populated from invoicing.dueDays');
  });
  await check('[fix] request-mode rejects impossible times', async () => {
    const r = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svcRequest.id, requestedSlots: [{ start: '2020-01-01T09:00:00.000Z', end: '2020-01-01T09:45:00.000Z' }], customer: { name: 'X', email: 'x@example.com', address: '1 st' } } });
    assert.equal(r.status, 400);
  });
  await check('[fix] blackout removes availability for a day', async () => {
    const d = ymd(new Date(Date.now() + 18 * 86400000));
    await call('/api/admin/settings/blackouts', { method: 'POST', body: { date: d, reason: 'Holiday' } });
    const av = await call(`/api/public/default/availability?serviceId=${svcInstant.id}&date=${d}`, { auth: false });
    assert.ok(av.data.slots.every((s) => !s.available), 'no slots bookable on a blackout day');
  });
  await check('[fix] capacity guard blocks overbooking', async () => {
    await call('/api/admin/settings/settings', { method: 'PUT', body: { availability: { capacityPerSlot: 1 } } });
    const d = ymd(new Date(Date.now() + 25 * 86400000));
    const slot = (await call(`/api/public/default/availability?serviceId=${svcInstant.id}&date=${d}`, { auth: false })).data.slots.find((s) => s.available);
    const b1 = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svcInstant.id, slot: { start: slot.start, end: slot.end }, customer: { name: 'Cap One', email: 'cap1@example.com', address: '1 st' } } });
    assert.equal(b1.data.status, 'scheduled');
    const b2 = await call('/api/public/default/book', { auth: false, method: 'POST', body: { serviceId: svcInstant.id, slot: { start: slot.start, end: slot.end }, customer: { name: 'Cap Two', email: 'cap2@example.com', address: '2 st' } } });
    assert.equal(b2.status, 409);
  });
  const db = await import('../src/lib/db.js');
  await check('[fix] requests badge includes public reschedules', async () => {
    const before = (await call('/api/admin/dashboard/counts')).data.counts.requests;
    await db.query(
      "INSERT INTO follow_ups (tenant_id, customer_id, type, title, channel, due_at, status, created_by) VALUES (1,1,'task','Reschedule request smoke','task',now(),'pending','public_reschedule')",
    );
    const after = (await call('/api/admin/dashboard/counts')).data.counts.requests;
    assert.equal(after, before + 1);
  });
  await check('[fix] cross-tenant: foreign customer rejected on invoice create', async () => {
    const t2 = await db.queryOne("INSERT INTO tenants (slug,name) VALUES ('rival','Rival Co') RETURNING id");
    const c2 = await db.queryOne('INSERT INTO customers (tenant_id,name) VALUES ($1,\'Rival Cust\') RETURNING id', [t2.id]);
    globalThis.__t2 = { tenant: t2.id, cust: c2.id };
    const r = await call('/api/admin/invoices', { method: 'POST', body: { customerId: c2.id, lineItems: [{ label: 'X', unit_amount_cents: 1000 }] } });
    assert.equal(r.status, 400);
  });
  await check('[fix] cross-tenant: cannot pay another tenant\'s invoice', async () => {
    const inv2 = await db.queryOne("INSERT INTO invoices (tenant_id,customer_id,number,status,total_cents,access_token) VALUES ($1,$2,'INV-R1','sent',5000,'tok') RETURNING id", [globalThis.__t2.tenant, globalThis.__t2.cust]);
    const r = await call(`/api/admin/invoices/${inv2.id}/payment`, { method: 'POST', body: { amountCents: 5000, method: 'cash' } });
    assert.equal(r.status, 404);
    const still = await db.queryOne('SELECT status, amount_paid_cents FROM invoices WHERE id=$1', [inv2.id]);
    assert.equal(still.status, 'sent'); assert.equal(Number(still.amount_paid_cents), 0);
  });
  await check('[fix] overpayment is rejected', async () => {
    const inv = (await call('/api/admin/invoices', { method: 'POST', body: { customerId: 1, lineItems: [{ label: 'X', unit_amount_cents: 5000, taxable: false }] } })).data.invoice;
    const r = await call(`/api/admin/invoices/${inv.id}/payment`, { method: 'POST', body: { amountCents: 999999, method: 'cash' } });
    assert.equal(r.status, 400);
  });
  await check('[fix] overpay-rejected webhook does not emit invoice.paid', async () => {
    const { emitInvoicePaidIfInserted } = await import('../src/routes/stripe_webhook.js');
    const before = await db.queryOne("SELECT count(*)::int n FROM event_log WHERE name='invoice.paid'");
    await emitInvoicePaidIfInserted(1, invId, { invoice: { id: invId, customer_id: 1, status: 'paid' }, rejected: 'overpay' });
    const after = await db.queryOne("SELECT count(*)::int n FROM event_log WHERE name='invoice.paid'");
    assert.equal(after.n, before.n);
  });
  await check('[fix] closed-day scheduling blocked unless forced', async () => {
    const d = ymd(new Date(Date.now() + 40 * 86400000));
    await call('/api/admin/settings/blackouts', { method: 'POST', body: { date: d, reason: 'Closed' } });
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const blocked = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Closed Test', email: 'ct@example.com' }, serviceId: svc.id, date: d, time: '10:00', serviceAddress: '1 Holiday Road, Baltimore, MD' } });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.code, 'SCHEDULE_WARN');
    const forced = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Closed Test', email: 'ct@example.com' }, serviceId: svc.id, date: d, time: '10:00', serviceAddress: '1 Holiday Road, Baltimore, MD', force: true } });
    assert.equal(forced.status, 200);
  });

  await check('[reminders] due sent + idempotent + out-of-window skipped', async () => {
    const dbm = await import('../src/lib/db.js');
    const { processDueReminders } = await import('../src/lib/reminders.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { notifications: { appointmentReminder: { enabled: true, leadHours: 48 } } } });
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const soon = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Remind Soon', email: 'soon@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 86400000)), time: '10:00', serviceAddress: '10 Reminder Way, Baltimore, MD', force: true } });
    const far = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Remind Far', email: 'far@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 10 * 86400000)), time: '10:00', serviceAddress: '20 Reminder Way, Baltimore, MD', force: true } });
    const tenant = await getTenantById(1);
    const r1 = await processDueReminders(tenant);
    assert.ok(r1.sent >= 1, 'sent the in-window reminder');
    const r2 = await processDueReminders(tenant);
    assert.equal(r2.sent, 0, 'idempotent — no double send');
    const farRow = await dbm.queryOne('SELECT reminder_sent_at FROM appointments WHERE id=$1', [far.data.appointment.id]);
    assert.equal(farRow.reminder_sent_at, null, 'out-of-window appointment not reminded');
    const soonRow = await dbm.queryOne('SELECT reminder_sent_at FROM appointments WHERE id=$1', [soon.data.appointment.id]);
    assert.ok(soonRow.reminder_sent_at, 'in-window appointment stamped');
  });
  await check('[reminders] manual send-reminder endpoint + disabled toggle', async () => {
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const a = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Manual Remind', email: 'mr@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 3 * 86400000)), time: '09:00', serviceAddress: '30 Reminder Way, Baltimore, MD', force: true } });
    const r = await call(`/api/admin/appointments/${a.data.appointment.id}/send-reminder`, { method: 'POST' });
    assert.ok(r.data.ok);
    const { processDueReminders } = await import('../src/lib/reminders.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { notifications: { appointmentReminder: { enabled: false, leadHours: 48 } } } });
    const off = await processDueReminders(await getTenantById(1));
    assert.equal(off.disabled, true, 'no reminders when disabled');
  });

  await check('[codex] service color validated to hex (stored-XSS guard)', async () => {
    const { data } = await call('/api/admin/settings/services', { method: 'POST', body: { name: 'Color Test', color: 'red" onload=alert(1)//', basePriceCents: 1000 } });
    assert.ok(data.service); assert.match(data.service.color, /^#[0-9a-f]{3,6}$/); assert.doesNotMatch(data.service.color, /onload|"/);
  });
  await check('[codex] field token rotates + old link invalidated', async () => {
    const t1 = new URL((await call(`/api/admin/technicians/${techId}/field-link`, { method: 'POST' })).data.url).searchParams.get('token');
    const t2 = new URL((await call(`/api/admin/technicians/${techId}/field-link`, { method: 'POST' })).data.url).searchParams.get('token');
    assert.notEqual(t1, t2);
    assert.equal((await call('/api/field/me?token=' + t1, { auth: false })).status, 401, 'old token invalidated');
    assert.equal((await call('/api/field/me?token=' + t2, { auth: false })).status, 200, 'new token valid');
  });
  await check('[codex] webhook rejects non-http scheme (SSRF guard)', async () => {
    assert.equal((await call('/api/admin/developer/webhooks', { method: 'POST', body: { url: 'javascript:alert(1)', events: ['*'] } })).status, 400);
    assert.equal((await call('/api/admin/developer/webhooks', { method: 'POST', body: { url: 'ftp://example.com/x', events: ['*'] } })).status, 400);
  });

  await check('[fix] staff role blocked from settings, allowed for ops', async () => {
    await call('/api/admin/auth/logout', { method: 'POST' });
    cookie = '';
    const login = await call('/api/admin/auth/login', { auth: false, method: 'POST', body: { username: 'tech1', password: 'temp12345' } });
    assert.ok(login.data.ok, 'staff can log in');
    const s = await call('/api/admin/settings');
    assert.equal(s.status, 403, 'staff blocked from settings');
    const appts = await call('/api/admin/appointments');
    assert.equal(appts.status, 200, 'staff can still run the day');
  });
  await check('[codex] staff cannot move money or use developer API', async () => {
    // (staff session still active) — reads allowed, payment/charge/developer denied
    assert.equal((await call('/api/admin/invoices')).status, 200, 'staff can read invoices');
    assert.equal((await call(`/api/admin/invoices/${invId}/payment`, { method: 'POST', body: { amountCents: 100, method: 'cash' } })).status, 403, 'staff blocked from recording payments');
    assert.equal((await call(`/api/admin/invoices/${invId}/void`, { method: 'POST' })).status, 403, 'staff blocked from voiding');
    assert.equal((await call('/api/admin/developer')).status, 403, 'staff blocked from developer/API keys');
    assert.equal((await call('/api/admin/customers/1/payment-methods', { method: 'POST', body: {} })).status, 403, 'staff blocked from saving cards');
  });

  await check('[p1a] appointment confirmation SMS + idempotent', async () => {
    const { sendAppointmentSms } = await import('../src/lib/notify_sms.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const dbm = await import('../src/lib/db.js');
    const tenant = await getTenantById(1);
    const r1 = await sendAppointmentSms(tenant, 1, 'confirmation');
    assert.ok(r1.ok && r1.status === 'sent');
    const r2 = await sendAppointmentSms(tenant, 1, 'confirmation');
    assert.equal(r2.status, 'duplicate', 'confirmation SMS not double-sent');
    // Exactly one CONFIRMATION row for this appointment (a separate reminder may
    // also exist — we're asserting the confirmation specifically isn't doubled).
    const n = await dbm.queryOne("SELECT count(*)::int n FROM sms_messages WHERE appointment_id=1 AND purpose='transactional' AND body LIKE '%is set for%'");
    assert.equal(n.n, 1, 'confirmation SMS must not be double-sent');
  });
  await check('[p1a] booking captured SMS consent (opted_in)', async () => {
    const dbm = await import('../src/lib/db.js');
    const c = await dbm.queryOne("SELECT status FROM customer_contact_consents WHERE tenant_id=1 AND address='+14105550000' AND source='booking_form' ORDER BY captured_at DESC LIMIT 1");
    assert.ok(c && c.status === 'opted_in');
  });
  await check('[p1a] on-my-way text endpoint', async () => {
    const r = await call('/api/admin/appointments/1/on-my-way', { method: 'POST', body: { eta: 'in 20 minutes' } });
    assert.ok(r.data.ok);
  });
  await check('[substrate] emitEvent runs local handler + logs (keyless)', async () => {
    const { emitEvent } = await import('../src/lib/events.js');
    await import('../src/inngest/index.js');
    const dbm = await import('../src/lib/db.js');
    await emitEvent('appointment.completed', { tenantId: 1, appointmentId: 999, customerId: 1 });
    const ev = await dbm.queryOne("SELECT count(*)::int n FROM event_log WHERE name='appointment.completed'");
    assert.ok(ev.n >= 1, 'event logged');
    const jr = await dbm.queryOne("SELECT count(*)::int n FROM job_runs WHERE workflow='appointment.completed'");
    assert.ok(jr.n >= 1, 'local handler ran (job_run recorded)');
  });
  await check('[sms] dev send records message + conversation', async () => {
    const { sendSms } = await import('../src/lib/sms.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const dbm = await import('../src/lib/db.js');
    const tenant = await getTenantById(1);
    const r = await sendSms(tenant, { to: '4105551234', body: 'Test from OARFlow', customerId: 1, purpose: 'transactional' });
    assert.ok(r.ok && r.status === 'sent');
    const m = await dbm.queryOne("SELECT count(*)::int n FROM sms_messages WHERE tenant_id=1 AND direction='outbound'");
    assert.ok(m.n >= 1);
    const c = await dbm.queryOne("SELECT count(*)::int n FROM sms_conversations WHERE tenant_id=1 AND phone_e164='+14105551234'");
    assert.equal(c.n, 1);
  });
  await check('[sms] opt-out suppresses sends', async () => {
    const { sendSms, setConsent } = await import('../src/lib/sms.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const tenant = await getTenantById(1);
    await setConsent(1, { phone: '+14105559999', status: 'opted_out', source: 'admin' });
    const r = await sendSms(tenant, { to: '4105559999', body: 'should not send', purpose: 'marketing' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'opted_out');
  });
  await check('[sms] inbound webhook records msg + STOP opts out', async () => {
    const dbm = await import('../src/lib/db.js');
    await dbm.query("UPDATE tenants SET settings = jsonb_set(settings::jsonb, '{integrations,sms,fromNumber}', '\"+15005550006\"') WHERE id=1");
    const params = new URLSearchParams({ From: '+14105557777', To: '+15005550006', Body: 'STOP', MessageSid: 'SM_test_1', NumMedia: '0' });
    const res = await fetch(base + '/api/webhooks/sms/twilio', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    assert.equal(res.status, 200);
    const inb = await dbm.queryOne("SELECT count(*)::int n FROM sms_messages WHERE direction='inbound' AND provider_message_id='SM_test_1'");
    assert.equal(inb.n, 1);
    const consent = await dbm.queryOne("SELECT status FROM customer_contact_consents WHERE tenant_id=1 AND address='+14105557777' ORDER BY captured_at DESC LIMIT 1");
    assert.equal(consent.status, 'opted_out');
  });
  await check('[storage] save + serve a file (local driver)', async () => {
    const { saveFile, signedUrl } = await import('../src/lib/storage.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const tenant = await getTenantById(1);
    const f = await saveFile(tenant, { buffer: Buffer.from('hello oarflow'), filename: 'note.txt', contentType: 'text/plain', kind: 'attachment', ownerType: 'customer', ownerId: 1 });
    assert.ok(f.id && f.storage_key);
    const url = await signedUrl(f);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello oarflow');
    const bad = await fetch(`${base}/api/files/${f.id}?token=wrong`);
    assert.equal(bad.status, 404);
  });
  await check('[permissions] role capabilities resolve correctly', async () => {
    const { hasCapability } = await import('../src/lib/permissions.js');
    assert.equal(hasCapability({ role: 'owner', capabilities: [] }, 'settings.manage'), true);
    assert.equal(hasCapability({ role: 'staff', capabilities: [] }, 'settings.manage'), false);
    assert.equal(hasCapability({ role: 'staff', capabilities: [] }, 'appointments.manage'), true);
    assert.equal(hasCapability({ role: 'staff', capabilities: ['reports.view'] }, 'reports.view'), true);
  });
  await check('[substrate] oncePerKey is idempotent', async () => {
    const { oncePerKey } = await import('../src/lib/events.js');
    let runs = 0;
    const a = await oncePerKey(1, 'smoke-key-xyz', async () => { runs += 1; return 'ok'; });
    const b = await oncePerKey(1, 'smoke-key-xyz', async () => { runs += 1; return 'ok'; });
    assert.equal(a.ran, true); assert.equal(b.ran, false); assert.equal(runs, 1);
  });

  server.close();
  await closeDb();
  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.error(`\n✗ ${f.name}\n`, f.err); process.exit(1); }
  console.log('✅ All smoke tests passed.');
  process.exit(0);
}

main().catch(async (err) => { console.error(err); await closeDb().catch(() => {}); process.exit(1); });
