#!/usr/bin/env node
// Populate a rolling, map-ready example schedule for the default demo tenant.
// The 20 appointments are marked by a stable source value, so re-running this
// script refreshes only these fixtures instead of creating duplicates.
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { queryOne, withTx, backendKind, closeDb } from '../src/lib/db.js';
import { randomToken } from '../src/lib/crypto.js';
import { ymdInTimeZone, zonedWallTimeToUtc } from '../src/lib/dates.js';

const SOURCE_PREFIX = 'demo.schedule.';
const DEMO_ROUTE_START = {
  address: '124 Bayview Ave, Annapolis, MD 21403',
  lat: 38.9784,
  lng: -76.4922,
};

const TECHNICIANS = [
  { name: 'Maya Chen', email: 'demo.rep.maya@example.com', phone: '(410) 555-0301', color: '#2563eb' },
  { name: 'Luis Martinez', email: 'demo.rep.luis@example.com', phone: '(410) 555-0302', color: '#16a34a' },
  { name: 'Jordan Brooks', email: 'demo.rep.jordan@example.com', phone: '(410) 555-0303', color: '#f59e0b' },
];

// Coordinates are intentionally stored with the fixture. Development installs
// generally have no geocoding provider configured, but the dispatch map should
// still be useful immediately after setup.
const CUSTOMERS = [
  ['Avery Morgan', '18 Harbor View Ct', 'Annapolis', 'MD', '21401', 38.9848, -76.4812],
  ['Noah Williams', '204 Chester Ave', 'Annapolis', 'MD', '21403', 38.9663, -76.4789],
  ['Sofia Patel', '71 Murray Hill Rd', 'Annapolis', 'MD', '21401', 38.9730, -76.5018],
  ['Ethan Kim', '315 Bay Ridge Ave', 'Annapolis', 'MD', '21403', 38.9437, -76.4725],
  ['Olivia Ramirez', '42 Maple Dr', 'Annapolis', 'MD', '21403', 38.9365, -76.4960],
  ['Liam Johnson', '890 Bestgate Rd', 'Annapolis', 'MD', '21401', 38.9865, -76.5480],
  ['Mia Thompson', '133 Melvin Ave', 'Annapolis', 'MD', '21401', 38.9870, -76.5080],
  ['Lucas Bennett', '57 Ridgely Ave', 'Annapolis', 'MD', '21401', 38.9910, -76.5135],
  ['Isabella Clark', '416 Severn Rd', 'Arnold', 'MD', '21012', 39.0320, -76.5020],
  ['Mateo Rivera', '129 Cape St Claire Rd', 'Annapolis', 'MD', '21409', 39.0430, -76.4430],
  ['Charlotte Davis', '33 Cypress Creek Rd', 'Severna Park', 'MD', '21146', 39.0700, -76.5450],
  ['James Wilson', '722 Generals Hwy', 'Crownsville', 'MD', '21032', 39.0200, -76.5950],
  ['Amelia Walker', '14 Mayo Rd', 'Edgewater', 'MD', '21037', 38.9380, -76.5580],
  ['Benjamin Scott', '901 Riva Rd', 'Riva', 'MD', '21140', 38.9530, -76.5780],
  ['Harper Lewis', '108 Central Ave', 'Davidsonville', 'MD', '21035', 38.9220, -76.6280],
  ['Henry Young', '240 Waugh Chapel Rd', 'Gambrills', 'MD', '21054', 39.0650, -76.6650],
  ['Evelyn Hall', '1665 Crofton Pkwy', 'Crofton', 'MD', '21114', 39.0010, -76.6870],
  ['Alexander Allen', '615 Veterans Hwy', 'Millersville', 'MD', '21108', 39.0550, -76.6350],
  ['Camila King', '847 Mountain Rd', 'Pasadena', 'MD', '21122', 39.1050, -76.5700],
  ['Daniel Wright', '7200 Ritchie Hwy', 'Glen Burnie', 'MD', '21061', 39.1550, -76.6200],
];

const DAILY_TIMES = ['08:00', '09:30', '11:30', '14:00'];
const SERVICE_SCHEDULE = [
  ['General Pest Control', 'Mosquito & Tick Treatment', 'Rodent Control', 'Bed Bug Treatment'],
  ['Termite Inspection', 'General Pest Control', 'Rodent Control', 'Mosquito & Tick Treatment'],
  ['Mosquito & Tick Treatment', 'Termite Inspection', 'General Pest Control', 'Bed Bug Treatment'],
  ['Rodent Control', 'General Pest Control', 'Mosquito & Tick Treatment', 'Termite Inspection'],
  ['General Pest Control', 'Rodent Control', 'Termite Inspection', 'Bed Bug Treatment'],
];
const SERVICE_NOTES = {
  'General Pest Control': 'Customer reported activity near the kitchen entry.',
  'Mosquito & Tick Treatment': 'Treat the backyard and check the gate before entering.',
  'Rodent Control': 'Inspect the garage and exterior foundation for entry points.',
  'Termite Inspection': 'Inspect the crawlspace and provide a written summary.',
  'Bed Bug Treatment': 'Call on arrival; customer will meet the rep at the front door.',
};

function addCalendarDays(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function nextMonday(today) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const daysAhead = ((8 - weekday) % 7) || 7;
  return addCalendarDays(today, daysAhead);
}

function sourceFor(index) {
  return `${SOURCE_PREFIX}${String(index + 1).padStart(2, '0')}`;
}

function fullAddress(customer) {
  return `${customer[1]}, ${customer[2]}, ${customer[3]} ${customer[4]}`;
}

async function one(cx, sql, params) {
  return (await cx.query(sql, params)).rows[0] || null;
}

async function ensureCustomers(cx, tenantId) {
  const ids = [];
  for (let index = 0; index < CUSTOMERS.length; index += 1) {
    const customer = CUSTOMERS[index];
    const email = `demo.schedule.${String(index + 1).padStart(2, '0')}@example.com`;
    const phone = `(410) 555-${String(2101 + index).padStart(4, '0')}`;
    let row = await one(cx,
      'SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) ORDER BY id LIMIT 1',
      [tenantId, email],
    );
    if (row) {
      await cx.query(
        `UPDATE customers SET name=$3, phone=$4, address=$5, city=$6, state=$7, postal_code=$8,
           notes='Example customer used by the rolling demo schedule.', updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, customer[0], phone, customer[1], customer[2], customer[3], customer[4]],
      );
    } else {
      row = await one(cx,
        `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Example customer used by the rolling demo schedule.') RETURNING id`,
        [tenantId, customer[0], email, phone, customer[1], customer[2], customer[3], customer[4]],
      );
    }
    ids.push(row.id);
  }
  return ids;
}

async function ensureTechnicians(cx, tenant) {
  const ids = [];
  for (const technician of TECHNICIANS) {
    let row = await one(cx,
      'SELECT id FROM technicians WHERE tenant_id=$1 AND lower(email)=lower($2) ORDER BY id LIMIT 1',
      [tenant.id, technician.email],
    );
    if (row) {
      await cx.query(
        `UPDATE technicians SET name=$3, phone=$4, color=$5, is_active=TRUE,
           route_start_address=$6, route_start_lat=$7, route_start_lng=$8, updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenant.id, row.id, technician.name, technician.phone, technician.color,
          DEMO_ROUTE_START.address, DEMO_ROUTE_START.lat, DEMO_ROUTE_START.lng],
      );
    } else {
      row = await one(cx,
        `INSERT INTO technicians
           (tenant_id, name, email, phone, color, route_start_address, route_start_lat, route_start_lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [tenant.id, technician.name, technician.email, technician.phone, technician.color,
          DEMO_ROUTE_START.address, DEMO_ROUTE_START.lat, DEMO_ROUTE_START.lng],
      );
    }
    ids.push(row.id);
  }
  return ids;
}

export async function seedDemoAppointments(tenantId, { allowProduction = false } = {}) {
  if (config.isProduction && !allowProduction) {
    throw new Error('Refusing to refresh demo appointments in production. Re-run with --allow-production if this is intentional.');
  }
  const kind = await backendKind();
  return withTx(async (cx) => {
    // PostgreSQL may run two CLI invocations concurrently. Serialize this
    // tenant's fixture refresh so the SELECT-then-INSERT markers stay unique.
    if (kind === 'postgres') await cx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`demo-schedule:${tenantId}`]);

    const tenant = await one(cx, 'SELECT id, timezone FROM tenants WHERE id=$1', [tenantId]);
    if (!tenant) throw new Error(`Tenant ${tenantId} was not found.`);

    const synced = await one(cx,
      `SELECT id FROM appointments
        WHERE tenant_id=$1 AND source LIKE $2 AND google_event_id IS NOT NULL LIMIT 1`,
      [tenantId, `${SOURCE_PREFIX}%`],
    );
    if (synced) {
      throw new Error('A demo appointment is linked to Google Calendar. Remove that calendar link before refreshing the rolling fixture.');
    }

    const services = (await cx.query(
      `SELECT id, name, duration_minutes, base_price_cents
         FROM service_types WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, id`,
      [tenantId],
    )).rows;
    if (!services.length) throw new Error('Seed services before adding demo appointments.');

    const customers = await ensureCustomers(cx, tenantId);
    const technicians = await ensureTechnicians(cx, tenant);
    const servicesByName = new Map(services.map((service) => [service.name, service]));
    const timezone = tenant.timezone || 'America/New_York';
    const firstDate = nextMonday(ymdInTimeZone(new Date(), timezone));

    for (let index = 0; index < 20; index += 1) {
      const dayIndex = Math.floor(index / DAILY_TIMES.length);
      const slotIndex = index % DAILY_TIMES.length;
      const serviceName = SERVICE_SCHEDULE[dayIndex][slotIndex];
      const customer = CUSTOMERS[index];
      const service = servicesByName.get(serviceName) || services[index % services.length];
      const date = addCalendarDays(firstDate, dayIndex);
      const start = zonedWallTimeToUtc(date, DAILY_TIMES[slotIndex], timezone);
      const end = new Date(start.getTime() + Number(service.duration_minutes || 60) * 60_000);
      const source = sourceFor(index);
      const internalNotes = 'Example schedule fixture. Re-running the demo seed restores its date, service, and assignment.';
      let appointment = await one(cx,
        'SELECT id FROM appointments WHERE tenant_id=$1 AND source=$2 ORDER BY id LIMIT 1',
        [tenantId, source],
      );

      if (appointment) {
        await cx.query(
          `UPDATE appointments SET customer_id=$3, service_type_id=$4, status='scheduled', booking_mode='instant',
             scheduled_start=$5, scheduled_end=$6, requested_slots='[]'::jsonb, service_address=$7,
             notes=$8, internal_notes=$9, price_cents=$10, service_lat=$11, service_lng=$12,
             completed_at=NULL, canceled_at=NULL, canceled_reason=NULL, updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId, appointment.id, customers[index], service.id, start, end, fullAddress(customer), SERVICE_NOTES[serviceName],
            internalNotes, service.base_price_cents || 0, customer[5], customer[6]],
        );
      } else {
        appointment = await one(cx,
          `INSERT INTO appointments
             (tenant_id, customer_id, service_type_id, status, booking_mode, source, scheduled_start, scheduled_end,
              service_address, notes, internal_notes, price_cents, service_lat, service_lng, access_token)
           VALUES ($1,$2,$3,'scheduled','instant',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [tenantId, customers[index], service.id, source, start, end, fullAddress(customer), SERVICE_NOTES[serviceName],
            internalNotes, service.base_price_cents || 0, customer[5], customer[6], randomToken()],
        );
      }

      const technicianId = technicians[index % technicians.length];
      await cx.query('DELETE FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2', [tenantId, appointment.id]);
      await cx.query(
        `INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_lead)
         VALUES ($1,$2,$3,TRUE)`,
        [tenantId, appointment.id, technicianId],
      );
    }

    return { count: 20, firstDate, lastDate: addCalendarDays(firstDate, 4) };
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const runCli = async () => {
    const allowProduction = process.argv.includes('--allow-production');
    if (config.isProduction && !allowProduction) {
      throw new Error('Refusing to refresh demo appointments in production. Re-run with --allow-production if this is intentional.');
    }
    const tenant = await queryOne('SELECT id FROM tenants WHERE slug=$1', [config.defaultTenantSlug]);
    if (!tenant) throw new Error(`Default tenant "${config.defaultTenantSlug}" was not found. Run npm run setup first.`);
    return seedDemoAppointments(tenant.id, { allowProduction });
  };
  runCli()
    .then(async (result) => {
      console.log(`✓ ${result.count} demo appointments ready (${result.firstDate} through ${result.lastDate}).`);
      await closeDb();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exit(1);
    });
}
