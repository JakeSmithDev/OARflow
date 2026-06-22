// End-to-end smoke test. Runs migrations + seed + the app against a single
// in-memory Postgres (PGlite) in ONE process, then exercises the real HTTP
// surface with assertions. Deterministic; used by `npm run smoke`.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = 'memory://';
process.env.PORT = process.env.SMOKE_PORT || '4555';
process.env.BASE_URL = `http://localhost:${process.env.PORT}`;

const http = await import('node:http');
const assert = (await import('node:assert')).strict;
const { runMigrations } = await import('./migrate.js');
const { runSeed } = await import('./seed.js');
const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/lib/db.js');

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

async function main() {
  console.log('Setting up in-memory DB…');
  await runMigrations({ quiet: true });
  await runSeed();
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(Number(process.env.PORT), r));
  console.log(`\nRunning smoke tests against ${base}\n`);

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

  // --- Dashboard ---
  await check('dashboard returns metrics', async () => { const { data } = await call('/api/admin/dashboard'); assert.ok(data.ok && data.metrics && Array.isArray(data.today)); });

  // --- Appointments ---
  let reqId;
  await check('appointments list + counts', async () => { const { data } = await call('/api/admin/appointments'); assert.ok(data.counts.all >= 4); reqId = data.appointments.find((a) => a.status === 'requested')?.id; });
  await check('confirm a request -> scheduled', async () => { assert.ok(reqId); const { data } = await call(`/api/admin/appointments/${reqId}/confirm`, { method: 'POST', body: { slotIndex: 0, notify: false } }); assert.equal(data.appointment.status, 'scheduled'); });
  let apptId;
  await check('create + complete an appointment', async () => {
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const c = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Manual Job', email: 'manual@example.com' }, serviceId: svc.id, date, time: '15:30' } });
    apptId = c.data.appointment.id;
    const done = await call(`/api/admin/appointments/${apptId}`, { method: 'PATCH', body: { status: 'completed' } });
    assert.equal(done.data.appointment.status, 'completed');
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
  await check('settings overview', async () => { const { data } = await call('/api/admin/settings'); assert.ok(data.profile && data.settings.booking && data.integrations); });
  await check('update business profile', async () => { const { data } = await call('/api/admin/settings/profile', { method: 'PATCH', body: { contactPhone: '(410) 555-9999' } }); assert.equal(data.profile.contactPhone, '(410) 555-9999'); });
  await check('update availability settings', async () => { const { data } = await call('/api/admin/settings/settings', { method: 'PUT', body: { availability: { capacityPerSlot: 3 } } }); assert.equal(data.settings.availability.capacityPerSlot, 3); });
  await check('create a service', async () => { const { data } = await call('/api/admin/settings/services', { method: 'POST', body: { name: 'Wasp Removal', durationMinutes: 45, basePriceCents: 11900, bookingMode: 'instant' } }); assert.ok(data.service.id); });
  await check('create an invoice preset', async () => { const { data } = await call('/api/admin/settings/presets', { method: 'POST', body: { label: 'Attic Treatment', defaultAmountCents: 30000 } }); assert.ok(data.preset.id); });
  await check('list + edit email template', async () => { const list = await call('/api/admin/settings/email-templates'); assert.ok(list.data.templates.length >= 7); const put = await call('/api/admin/settings/email-templates/follow_up', { method: 'PUT', body: { subject: 'Checking in!', html: '<p>Hi {{CUSTOMER_NAME}}</p>', text: 'Hi' } }); assert.ok(put.data.ok); });
  await check('add a team member', async () => { const { data } = await call('/api/admin/settings/users', { method: 'POST', body: { username: 'tech1', password: 'temp12345', displayName: 'Tech One', role: 'staff' } }); assert.ok(data.user.id); });
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
  await check('[fix] closed-day scheduling blocked unless forced', async () => {
    const d = ymd(new Date(Date.now() + 40 * 86400000));
    await call('/api/admin/settings/blackouts', { method: 'POST', body: { date: d, reason: 'Closed' } });
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const blocked = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Closed Test', email: 'ct@example.com' }, serviceId: svc.id, date: d, time: '10:00' } });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.code, 'SCHEDULE_WARN');
    const forced = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Closed Test', email: 'ct@example.com' }, serviceId: svc.id, date: d, time: '10:00', force: true } });
    assert.equal(forced.status, 200);
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

  server.close();
  await closeDb();
  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.error(`\n✗ ${f.name}\n`, f.err); process.exit(1); }
  console.log('✅ All smoke tests passed.');
  process.exit(0);
}

main().catch(async (err) => { console.error(err); await closeDb().catch(() => {}); process.exit(1); });
