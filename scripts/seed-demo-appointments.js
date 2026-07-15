#!/usr/bin/env node
// Populate a rolling, map-ready example schedule for the default demo tenant.
// The 140 appointments are marked by stable source values, so re-running this
// script refreshes only these fixtures instead of creating duplicates.
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { queryOne, withTx, backendKind, closeDb } from '../src/lib/db.js';
import { randomToken } from '../src/lib/crypto.js';
import { ymdInTimeZone, zonedWallTimeToUtc } from '../src/lib/dates.js';

const SOURCE_PREFIX = 'demo.schedule.';
const DEMO_DAYS = 7;
const LEADS_PER_DAY = 20;
const DEMO_APPOINTMENT_COUNT = DEMO_DAYS * LEADS_PER_DAY;
const UNASSIGNED_SLOTS = new Set([3, 7, 11, 15, 19]);
const PREFERRED_SERVICE_NAMES = [
  'General Pest Control',
  'Mosquito & Tick Treatment',
  'Termite Inspection',
];
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

function sourceFor(index) {
  return `${SOURCE_PREFIX}${String(index + 1).padStart(2, '0')}`;
}

function fixtureCustomer(index) {
  const dayIndex = Math.floor(index / LEADS_PER_DAY);
  const leadIndex = index % LEADS_PER_DAY;
  const firstName = CUSTOMERS[leadIndex][0].split(' ')[0];
  const lastName = CUSTOMERS[(leadIndex + dayIndex) % CUSTOMERS.length][0].split(' ').at(-1);
  // Each date visits the same broad service area, but rotates which lead owns
  // each location so all 140 customer records remain distinct and believable.
  const location = CUSTOMERS[(leadIndex + dayIndex * 3) % CUSTOMERS.length];
  return [`${firstName} ${lastName}`, ...location.slice(1)];
}

function validYmd(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function hhmm(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (hour > 23) throw new Error('Demo schedule extends past the end of a calendar day. Add a shorter active service.');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function withinCapacity(candidate, intervals, capacity) {
  const events = [candidate, ...intervals.filter((interval) => overlaps(candidate, interval))]
    .flatMap((interval) => [[interval.start, 1], [interval.end, -1]])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let concurrent = 0;
  for (const [, change] of events) {
    concurrent += change;
    if (concurrent > capacity) return false;
  }
  return true;
}

function capacitySafeWindow(date, durationMinutes, timezone, intervals, capacity) {
  for (let minute = 8 * 60; minute + durationMinutes <= 24 * 60; minute += 15) {
    const start = zonedWallTimeToUtc(date, hhmm(minute), timezone).getTime();
    const candidate = { start, end: start + durationMinutes * 60_000 };
    if (withinCapacity(candidate, intervals, capacity)) return candidate;
  }
  throw new Error(`Could not fit 20 demo appointments on ${date} without exceeding capacity ${capacity}.`);
}

function availableTechnician(technicianIds, technicianIntervals, candidate, preferredIndex) {
  for (let offset = 0; offset < technicianIds.length; offset += 1) {
    const technicianId = technicianIds[(preferredIndex + offset) % technicianIds.length];
    if (!(technicianIntervals.get(technicianId) || []).some((interval) => overlaps(candidate, interval))) return technicianId;
  }
  throw new Error('Could not assign a demo appointment without overlapping a demo rep.');
}

function fullAddress(customer) {
  return `${customer[1]}, ${customer[2]}, ${customer[3]} ${customer[4]}`;
}

async function one(cx, sql, params) {
  return (await cx.query(sql, params)).rows[0] || null;
}

async function ensureCustomers(cx, tenantId) {
  const ids = [];
  for (let index = 0; index < DEMO_APPOINTMENT_COUNT; index += 1) {
    const customer = fixtureCustomer(index);
    const email = `demo.schedule.${String(index + 1).padStart(2, '0')}@example.com`;
    const phone = `(410) 555-${String(2101 + index).padStart(4, '0')}`;
    let row = await one(cx,
      'SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) ORDER BY id LIMIT 1',
      [tenantId, email],
    );
    if (row) {
      await cx.query(
        `UPDATE customers SET name=$3, phone=$4, address=$5, city=$6, state=$7, postal_code=$8,
           notes='Example lead used by the rolling demo schedule.', updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, customer[0], phone, customer[1], customer[2], customer[3], customer[4]],
      );
    } else {
      row = await one(cx,
        `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Example lead used by the rolling demo schedule.') RETURNING id`,
        [tenantId, customer[0], email, phone, customer[1], customer[2], customer[3], customer[4]],
      );
    }
    ids.push(Number(row.id));
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
    ids.push(Number(row.id));
  }
  return ids;
}

export async function seedDemoAppointments(tenantId, { allowProduction = false, now = new Date(), startDate = null } = {}) {
  if (config.isProduction && !allowProduction) {
    throw new Error('Refusing to refresh demo appointments in production. Re-run with --allow-production if this is intentional.');
  }
  const kind = await backendKind();
  return withTx(async (cx) => {
    // PostgreSQL may run two CLI invocations concurrently. Serialize this
    // tenant's fixture refresh so the SELECT-then-INSERT markers stay unique.
    if (kind === 'postgres') await cx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`demo-schedule:${tenantId}`]);

    const tenant = await one(cx, 'SELECT id, timezone, settings FROM tenants WHERE id=$1', [tenantId]);
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

    const shortServices = services.filter((service) => Number(service.duration_minutes || 60) <= 60);
    if (!shortServices.length) throw new Error('The demo schedule needs an active service lasting 60 minutes or less.');

    const customers = await ensureCustomers(cx, tenantId);
    const technicians = await ensureTechnicians(cx, tenant);
    const servicesByName = new Map(services.map((service) => [service.name, service]));
    const preferredServices = PREFERRED_SERVICE_NAMES.map((name) => servicesByName.get(name)).filter((service) => service && Number(service.duration_minutes || 60) <= 60);
    const demoServices = preferredServices.length ? preferredServices : shortServices;
    const timezone = tenant.timezone || 'America/New_York';
    if (startDate != null && !validYmd(startDate)) throw new Error('Demo schedule startDate must be YYYY-MM-DD.');
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('Demo schedule now must be a valid date.');
    const firstDate = startDate || ymdInTimeZone(instant, timezone);

    for (let dayIndex = 0; dayIndex < DEMO_DAYS; dayIndex += 1) {
      const date = addCalendarDays(firstDate, dayIndex);
      const dayStart = zonedWallTimeToUtc(date, '00:00', timezone);
      const dayEnd = zonedWallTimeToUtc(addCalendarDays(date, 1), '00:00', timezone);
      const override = await one(cx, 'SELECT capacity FROM schedule_overrides WHERE tenant_id=$1 AND service_date=$2', [tenantId, date]);
      const defaultCapacity = Number(tenant.settings?.availability?.capacityPerSlot || 1);
      const capacity = override?.capacity != null ? Number(override.capacity) : defaultCapacity;
      if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`Demo schedule capacity must be at least 1 on ${date}.`);

      // Account for non-fixture work before packing the twenty demo leads. This
      // keeps the resulting tenant schedule capacity-safe, not just the fixture
      // considered in isolation.
      const externalAppointments = (await cx.query(
        `SELECT scheduled_start, scheduled_end FROM appointments
          WHERE tenant_id=$1 AND status IN ('scheduled','completed')
            AND scheduled_start < $3 AND scheduled_end > $2 AND source NOT LIKE $4`,
        [tenantId, dayStart, dayEnd, `${SOURCE_PREFIX}%`],
      )).rows.map((row) => ({ start: new Date(row.scheduled_start).getTime(), end: new Date(row.scheduled_end).getTime() }));
      const externalAssignments = (await cx.query(
        `SELECT aa.technician_id, a.scheduled_start, a.scheduled_end
           FROM appointment_assignments aa
           JOIN appointments a ON a.id=aa.appointment_id AND a.tenant_id=aa.tenant_id
          WHERE aa.tenant_id=$1 AND aa.technician_id = ANY($2::bigint[])
            AND a.status IN ('scheduled','completed') AND a.scheduled_start < $4 AND a.scheduled_end > $3
            AND a.source NOT LIKE $5`,
        [tenantId, technicians, dayStart, dayEnd, `${SOURCE_PREFIX}%`],
      )).rows;
      const technicianIntervals = new Map(technicians.map((technicianId) => [technicianId, []]));
      for (const row of externalAssignments) {
        technicianIntervals.get(Number(row.technician_id))?.push({
          start: new Date(row.scheduled_start).getTime(),
          end: new Date(row.scheduled_end).getTime(),
        });
      }
      const scheduledIntervals = [...externalAppointments];

      for (let slotIndex = 0; slotIndex < LEADS_PER_DAY; slotIndex += 1) {
        const index = dayIndex * LEADS_PER_DAY + slotIndex;
        const customer = fixtureCustomer(index);
        const service = demoServices[(dayIndex + slotIndex) % demoServices.length];
        const serviceName = service.name;
        const durationMinutes = Math.max(1, Number(service.duration_minutes || 60));
        const window = capacitySafeWindow(date, durationMinutes, timezone, scheduledIntervals, capacity);
        scheduledIntervals.push(window);
        const start = new Date(window.start);
        const end = new Date(window.end);
        const source = sourceFor(index);
        const internalNotes = UNASSIGNED_SLOTS.has(slotIndex)
          ? 'Example scheduling lead. Assign this job during the daily dispatch walkthrough.'
          : 'Example schedule fixture. Re-running the demo seed restores its date, service, and assignment.';
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
            [tenantId, appointment.id, customers[index], service.id, start, end, fullAddress(customer), SERVICE_NOTES[serviceName] || 'Review the service request and property notes before arrival.',
              internalNotes, service.base_price_cents || 0, customer[5], customer[6]],
          );
        } else {
          appointment = await one(cx,
            `INSERT INTO appointments
               (tenant_id, customer_id, service_type_id, status, booking_mode, source, scheduled_start, scheduled_end,
                service_address, notes, internal_notes, price_cents, service_lat, service_lng, access_token)
             VALUES ($1,$2,$3,'scheduled','instant',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [tenantId, customers[index], service.id, source, start, end, fullAddress(customer), SERVICE_NOTES[serviceName] || 'Review the service request and property notes before arrival.',
              internalNotes, service.base_price_cents || 0, customer[5], customer[6], randomToken()],
          );
        }

        await cx.query('DELETE FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2', [tenantId, appointment.id]);
        if (!UNASSIGNED_SLOTS.has(slotIndex)) {
          const technicianId = availableTechnician(technicians, technicianIntervals, window, slotIndex % technicians.length);
          technicianIntervals.get(technicianId).push(window);
          await cx.query(
            `INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_lead)
             VALUES ($1,$2,$3,TRUE)`,
            [tenantId, appointment.id, technicianId],
          );
        }
      }
    }

    return { count: DEMO_APPOINTMENT_COUNT, firstDate, lastDate: addCalendarDays(firstDate, DEMO_DAYS - 1) };
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
