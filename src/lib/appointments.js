// Shared helpers for services, customers, and appointment creation/booking.
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { zonedWallTimeToUtc } from './dates.js';

export async function getService(tenantId, id) {
  return queryOne('SELECT * FROM service_types WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
}

export async function listActiveServices(tenantId) {
  const { rows } = await query(
    'SELECT * FROM service_types WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, name',
    [tenantId],
  );
  return rows;
}

/** Resolve the effective booking mode for a service (services may inherit the tenant default). */
export function effectiveBookingMode(tenant, service) {
  const mode = service?.booking_mode;
  if (mode === 'instant' || mode === 'request') return mode;
  return tenant.settings.booking.defaultMode || 'instant';
}

/** Match an existing customer by email (case-insensitive) or create a new one. */
export async function findOrCreateCustomer(tenantId, info) {
  const email = (info.email || '').trim().toLowerCase();
  if (email) {
    const existing = await queryOne(
      'SELECT * FROM customers WHERE tenant_id=$1 AND lower(email)=$2 ORDER BY id LIMIT 1',
      [tenantId, email],
    );
    if (existing) {
      // Backfill any missing contact details.
      await query(
        `UPDATE customers SET
           phone = COALESCE(NULLIF($3,''), phone),
           address = COALESCE(NULLIF($4,''), address),
           updated_at = now()
         WHERE id=$1 AND tenant_id=$2`,
        [existing.id, tenantId, info.phone || '', info.address || ''],
      );
      return existing.id;
    }
  }
  const row = await queryOne(
    `INSERT INTO customers (tenant_id, name, email, phone, address, city, state, postal_code, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, info.name || 'Customer', info.email || null, info.phone || null, info.address || null,
     info.city || null, info.state || null, info.postalCode || null, info.notes || null],
  );
  return row.id;
}

/** Day-scoped conflict data used for availability + booking validation. */
export async function fetchDayConflicts(tenant, dateYmd) {
  const tz = tenant.timezone;
  const dayStart = zonedWallTimeToUtc(dateYmd, '00:00', tz).toISOString();
  const dayEnd = zonedWallTimeToUtc(dateYmd, '00:00', tz);
  const dayEndIso = new Date(dayEnd.getTime() + 86_400_000).toISOString();
  const appts = await query(
    `SELECT scheduled_start, scheduled_end FROM appointments
      WHERE tenant_id=$1 AND status IN ('scheduled','completed')
        AND scheduled_start < $3 AND scheduled_end > $2`,
    [tenant.id, dayStart, dayEndIso],
  );
  const blackouts = await query(
    `SELECT starts_at, ends_at FROM blackouts
      WHERE tenant_id=$1 AND starts_at < $3 AND ends_at > $2`,
    [tenant.id, dayStart, dayEndIso],
  );
  const override = await queryOne(
    'SELECT * FROM schedule_overrides WHERE tenant_id=$1 AND service_date=$2',
    [tenant.id, dateYmd],
  );
  return { appointments: appts.rows, blackouts: blackouts.rows, override };
}

/** Create an appointment row. `data` is already validated by the caller. */
export async function createAppointment(tenantId, data) {
  const row = await queryOne(
    `INSERT INTO appointments
       (tenant_id, customer_id, service_type_id, subscription_id, status, booking_mode, source,
        scheduled_start, scheduled_end, requested_slots, service_address, notes, internal_notes, price_cents, access_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      tenantId, data.customerId, data.serviceTypeId || null, data.subscriptionId || null,
      data.status, data.bookingMode, data.source || 'online',
      data.scheduledStart || null, data.scheduledEnd || null,
      JSON.stringify(data.requestedSlots || []),
      data.serviceAddress || null, data.notes || null, data.internalNotes || null,
      data.priceCents || 0, data.accessToken || randomToken(),
    ],
  );
  return row;
}

export default { getService, listActiveServices, effectiveBookingMode, findOrCreateCustomer, fetchDayConflicts, createAppointment };
