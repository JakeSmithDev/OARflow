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
  await check('create a technician', async () => {
    const { data } = await call('/api/admin/technicians', { method: 'POST', body: { name: 'Marco Diaz', color: '#2563eb', phone: '410-555-0142' } });
    assert.ok(data.ok); techId = data.technician.id; assert.equal(data.technician.is_active, true);
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
  await check('field rejects a bad token', async () => { assert.equal((await call('/api/field/me?token=nope', { auth: false })).status, 404); });
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

  // --- Route optimization + GPS ---
  await check('routing requires technicianId + date', async () => {
    assert.equal((await call('/api/admin/routing')).status, 400);
  });
  await check('route lists the tech stops + builds a maps link', async () => {
    await call(`/api/admin/appointments/${assignApptId}`, { method: 'PATCH', body: { serviceAddress: '123 Main St, Baltimore, MD' } });
    const { data } = await call(`/api/admin/routing?technicianId=${techId}&date=2026-07-15`);
    assert.ok(data.ok); assert.ok(data.stops.some((s) => s.appointmentId === assignApptId));
    assert.equal(data.geocoder, false); // no geocoder in dev
    assert.ok(data.mapsUrl && data.mapsUrl.includes('google.com/maps/dir'));
  });
  await check('field /me includes a route map link', async () => {
    const { data } = await call(`/api/field/me?token=${fieldToken}&date=2026-07-15`, { auth: false });
    assert.ok(data.routeUrl && data.routeUrl.includes('maps'));
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

  await check('[reminders] due sent + idempotent + out-of-window skipped', async () => {
    const dbm = await import('../src/lib/db.js');
    const { processDueReminders } = await import('../src/lib/reminders.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { notifications: { appointmentReminder: { enabled: true, leadHours: 48 } } } });
    const svc = (await call('/api/admin/appointments/meta/services')).data.services[0];
    const soon = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Remind Soon', email: 'soon@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 86400000)), time: '10:00', force: true } });
    const far = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Remind Far', email: 'far@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 10 * 86400000)), time: '10:00', force: true } });
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
    const a = await call('/api/admin/appointments', { method: 'POST', body: { customer: { name: 'Manual Remind', email: 'mr@example.com' }, serviceId: svc.id, date: ymd(new Date(Date.now() + 3 * 86400000)), time: '09:00', force: true } });
    const r = await call(`/api/admin/appointments/${a.data.appointment.id}/send-reminder`, { method: 'POST' });
    assert.ok(r.data.ok);
    const { processDueReminders } = await import('../src/lib/reminders.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    await call('/api/admin/settings/settings', { method: 'PUT', body: { notifications: { appointmentReminder: { enabled: false, leadHours: 48 } } } });
    const off = await processDueReminders(await getTenantById(1));
    assert.equal(off.disabled, true, 'no reminders when disabled');
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

  await check('[p1a] appointment confirmation SMS + idempotent', async () => {
    const { sendAppointmentSms } = await import('../src/lib/notify_sms.js');
    const { getTenantById } = await import('../src/lib/tenants.js');
    const dbm = await import('../src/lib/db.js');
    const tenant = await getTenantById(1);
    const r1 = await sendAppointmentSms(tenant, 1, 'confirmation');
    assert.ok(r1.ok && r1.status === 'sent');
    const r2 = await sendAppointmentSms(tenant, 1, 'confirmation');
    assert.equal(r2.status, 'duplicate', 'confirmation SMS not double-sent');
    const n = await dbm.queryOne("SELECT count(*)::int n FROM sms_messages WHERE appointment_id=1 AND purpose='transactional'");
    assert.equal(n.n, 1);
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
