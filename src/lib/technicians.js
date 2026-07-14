// Technicians (field staff) + per-appointment assignment. Assignment is an
// internal dispatch concern only — never exposed on the public booking side.
import crypto from 'node:crypto';
import { query, queryOne, withTx } from './db.js';
import { randomToken } from './crypto.js';
import { hexColor } from './http.js';

const MAX_ROUTE_START_ADDRESS_LENGTH = 500;

function validationError(message, code = 'TECHNICIAN_VALIDATION') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

/** Empty means "use the business address"; coordinates are never client-set. */
export function normalizeRouteStartAddress(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw validationError('Route starting point must be an address.');
  const address = value.trim();
  if (address.length > MAX_ROUTE_START_ADDRESS_LENGTH) {
    throw validationError(`Route starting point must be ${MAX_ROUTE_START_ADDRESS_LENGTH} characters or fewer.`);
  }
  return address || null;
}

async function requireOwnedAdminUser(tenant, userId) {
  if (!userId) return;
  const user = await queryOne('SELECT id FROM admin_users WHERE tenant_id=$1 AND id=$2', [tenant.id, userId]);
  if (!user) throw validationError('Selected login does not belong to this business.', 'TECHNICIAN_USER_NOT_OWNED');
}

export async function listTechnicians(tenant, { includeInactive = false, includeRouteOrigins = false } = {}) {
  const routeOriginColumns = includeRouteOrigins
    ? ', route_start_address, route_start_lat, route_start_lng'
    : '';
  const r = await query(
    `SELECT id, name, email, phone, color, is_active, user_id${routeOriginColumns}
       FROM technicians
      WHERE tenant_id=$1 ${includeInactive ? '' : 'AND is_active=TRUE'} ORDER BY is_active DESC, name`,
    [tenant.id],
  );
  return r.rows;
}

export async function createTechnician(tenant, { name, email, phone, color, userId, routeStartAddress }) {
  await requireOwnedAdminUser(tenant, userId);
  const startAddress = normalizeRouteStartAddress(routeStartAddress);
  return queryOne(
    `INSERT INTO technicians (tenant_id, name, email, phone, color, user_id, route_start_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenant.id, name, email || null, phone || null, hexColor(color, '#2563eb'), userId || null, startAddress],
  );
}

export async function updateTechnician(tenant, id, fields) {
  if (fields.userId !== undefined) await requireOwnedAdminUser(tenant, fields.userId);
  const cols = { name: fields.name, email: fields.email, phone: fields.phone, color: fields.color === undefined ? undefined : hexColor(fields.color), user_id: fields.userId, is_active: fields.isActive,
    license_no: fields.licenseNo, license_state: fields.licenseState, license_expires: fields.licenseExpires };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (fields.routeStartAddress !== undefined) {
    const address = normalizeRouteStartAddress(fields.routeStartAddress);
    params.push(address);
    const value = `$${params.length}`;
    // Keep a valid cache for an idempotent save, but clear it atomically when
    // the effective custom address changes (including switching to business).
    sets.push(`route_start_lat=CASE WHEN route_start_address IS NOT DISTINCT FROM ${value} THEN route_start_lat ELSE NULL END`);
    sets.push(`route_start_lng=CASE WHEN route_start_address IS NOT DISTINCT FROM ${value} THEN route_start_lng ELSE NULL END`);
    sets.push(`route_start_address=${value}`);
  }
  if (!sets.length) return queryOne('SELECT * FROM technicians WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE technicians SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

/** Return the first scheduled job that would overlap one of the selected reps. */
export async function findTechnicianConflict(tenant, { appointmentId, technicianIds = [], start, end }, cx = null) {
  const ids = [...new Set(technicianIds.map(Number).filter(Boolean))];
  if (!ids.length || !start || !end) return null;
  const run = cx ? (sql, params) => cx.query(sql, params) : query;
  const result = await run(
    `SELECT aa.technician_id, t.name AS technician_name, other.id AS appointment_id,
            other.scheduled_start, other.scheduled_end
       FROM appointment_assignments aa
       JOIN appointments other ON other.id=aa.appointment_id AND other.tenant_id=aa.tenant_id
       JOIN technicians t ON t.id=aa.technician_id AND t.tenant_id=aa.tenant_id
      WHERE aa.tenant_id=$1 AND aa.technician_id = ANY($2::bigint[])
        AND aa.appointment_id <> $3 AND other.status IN ('scheduled','completed')
        AND other.scheduled_start < $4 AND other.scheduled_end > $5
      ORDER BY other.scheduled_start, other.id
      LIMIT 1`,
    [tenant.id, ids, appointmentId, end, start],
  );
  return result.rows[0] || null;
}

function normalizedAssignmentIds(rows) {
  return rows.map((row) => Number(row.technician_id)).filter(Boolean).sort((a, b) => a - b);
}

function sameAssignmentIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Lock an appointment together with its current crew using the same lock order
 * as assignment writes (technicians first, appointment second). Retry when the
 * crew changes between the optimistic read and the locked re-read.
 */
export async function withLockedAppointmentSchedule(tenant, appointmentId, fn, { maxAttempts = 4 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await query(
      'SELECT technician_id FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY technician_id',
      [tenant.id, appointmentId],
    );
    const expectedIds = normalizedAssignmentIds(snapshot.rows);
    try {
      return await withTx(async (cx) => {
        if (expectedIds.length) {
          await cx.query(
            'SELECT id FROM technicians WHERE tenant_id=$1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE',
            [tenant.id, expectedIds],
          );
        }
        const appointment = await cx.query(
          `SELECT id, status, scheduled_start, scheduled_end, requested_slots
             FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenant.id, appointmentId],
        );
        if (!appointment.rows.length) return { notFound: true };
        const currentAssignments = await cx.query(
          'SELECT technician_id FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY technician_id',
          [tenant.id, appointmentId],
        );
        const currentIds = normalizedAssignmentIds(currentAssignments.rows);
        if (!sameAssignmentIds(expectedIds, currentIds)) {
          const error = new Error('Appointment crew changed while locking the schedule.');
          error.code = 'APPOINTMENT_CREW_CHANGED';
          throw error;
        }
        return fn({ cx, appointment: appointment.rows[0], technicianIds: currentIds });
      });
    } catch (error) {
      if (error.code !== 'APPOINTMENT_CREW_CHANGED') throw error;
    }
  }
  return { scheduleBusy: true };
}

/** Replace an appointment's assignment set. leadId becomes the lead (or first). */
export async function setAssignments(tenant, appointmentId, technicianIds = [], leadId = null, { cx = null } = {}) {
  const ids = [...new Set(technicianIds.map(Number).filter(Boolean))];
  const run = async (tx) => {
    // appointment must belong to this tenant
    let appt = await tx.query(
      'SELECT id, status, scheduled_start, scheduled_end FROM appointments WHERE id=$1 AND tenant_id=$2',
      [appointmentId, tenant.id],
    );
    if (!appt.rows.length) return { ok: false, notFound: true };
    // all techs must belong to this tenant
    if (ids.length) {
      // Lock selected reps so concurrent manual/automatic assignments cannot
      // both pass the overlap check and double-book the same person.
      const owned = await tx.query(
        'SELECT id FROM technicians WHERE tenant_id=$1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE',
        [tenant.id, ids],
      );
      if (owned.rows.length !== ids.length) return { ok: false, error: 'Unknown technician.' };
    }
    // Re-read under lock after the rep locks so every assignment path uses the
    // same lock order (technicians, then appointments).
    appt = await tx.query(
      'SELECT id, status, scheduled_start, scheduled_end FROM appointments WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [appointmentId, tenant.id],
    );
    if (!appt.rows.length) return { ok: false, notFound: true };
    const current = appt.rows[0];
    if (ids.length && current.status === 'scheduled' && current.scheduled_start && current.scheduled_end) {
      const conflict = await findTechnicianConflict(tenant, {
        appointmentId, technicianIds: ids, start: current.scheduled_start, end: current.scheduled_end,
      }, tx);
      if (conflict) return { ok: false, conflict: true, error: `${conflict.technician_name} already has an overlapping appointment.` };
    }
    await tx.query('DELETE FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2', [tenant.id, appointmentId]);
    const lead = leadId && ids.includes(Number(leadId)) ? Number(leadId) : ids[0] || null;
    for (const tid of ids) {
      await tx.query('INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_lead) VALUES ($1,$2,$3,$4)', [tenant.id, appointmentId, tid, tid === lead]);
    }
    return { ok: true, lead };
  };
  return cx ? run(cx) : withTx(run);
}

export async function getAssignments(tenant, appointmentId) {
  const r = await query(
    `SELECT t.id, t.name, t.color, a.is_lead FROM appointment_assignments a JOIN technicians t ON t.id=a.technician_id
      WHERE a.tenant_id=$1 AND a.appointment_id=$2 ORDER BY a.is_lead DESC, t.name`,
    [tenant.id, appointmentId],
  );
  return r.rows;
}

/** Map of appointmentId -> [{id,name,color,is_lead}] for a set of appointments. */
export async function assignmentsForAppointments(tenant, appointmentIds = []) {
  const ids = appointmentIds.map(Number).filter(Boolean);
  if (!ids.length) return {};
  const r = await query(
    `SELECT a.appointment_id, t.id, t.name, t.color, a.is_lead FROM appointment_assignments a JOIN technicians t ON t.id=a.technician_id
      WHERE a.tenant_id=$1 AND a.appointment_id = ANY($2::bigint[]) ORDER BY a.is_lead DESC, t.name`,
    [tenant.id, ids],
  );
  const map = {};
  for (const row of r.rows) { (map[row.appointment_id] = map[row.appointment_id] || []).push({ id: row.id, name: row.name, color: row.color, is_lead: row.is_lead }); }
  return map;
}

const FIELD_TOKEN_TTL_DAYS = 180;
function hashFieldToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

/**
 * Issue a fresh field-app token (rotates — invalidates any prior token). We store
 * only the SHA-256 hash + an expiry; the plaintext is returned once for the link.
 */
export async function ensureFieldToken(tenant, technicianId) {
  const t = await queryOne('SELECT id FROM technicians WHERE tenant_id=$1 AND id=$2', [tenant.id, technicianId]);
  if (!t) return null;
  const token = randomToken();
  const expires = new Date(Date.now() + FIELD_TOKEN_TTL_DAYS * 86400000);
  await query('UPDATE technicians SET field_token_hash=$3, field_token_expires=$4, field_token=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenant.id, technicianId, hashFieldToken(token), expires.toISOString()]);
  return token;
}

/** Revoke a technician's field-app access. */
export async function revokeFieldToken(tenant, technicianId) {
  await query('UPDATE technicians SET field_token_hash=NULL, field_token_expires=NULL, field_token=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenant.id, technicianId]);
  return { ok: true };
}

export async function technicianByFieldToken(token) {
  if (!token) return null;
  return queryOne('SELECT * FROM technicians WHERE field_token_hash=$1 AND is_active=TRUE AND (field_token_expires IS NULL OR field_token_expires > now())', [hashFieldToken(token)]);
}

export async function isAssigned(tenant, technicianId, appointmentId) {
  const r = await queryOne('SELECT 1 FROM appointment_assignments WHERE tenant_id=$1 AND technician_id=$2 AND appointment_id=$3', [tenant.id, technicianId, appointmentId]);
  return Boolean(r);
}

/** A technician's jobs in a date range (their route), with customer + crew. */
export async function technicianJobs(tenant, technicianId, { from, to }) {
  const r = await query(
    `SELECT a.id, a.status, a.scheduled_start, a.scheduled_end, a.service_address, a.notes, a.internal_notes,
            c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            s.name AS service_name, s.color AS service_color, aa.is_lead
       FROM appointment_assignments aa
       JOIN appointments a ON a.id=aa.appointment_id
       JOIN customers c ON c.id=a.customer_id
       LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE aa.tenant_id=$1 AND aa.technician_id=$2
        AND a.scheduled_start >= $3 AND a.scheduled_start < $4
      ORDER BY a.scheduled_start`,
    [tenant.id, technicianId, from, to],
  );
  return r.rows;
}

export default {
  normalizeRouteStartAddress, listTechnicians, createTechnician, updateTechnician, setAssignments, getAssignments,
  assignmentsForAppointments, findTechnicianConflict, withLockedAppointmentSchedule,
  ensureFieldToken, revokeFieldToken, technicianByFieldToken,
};
