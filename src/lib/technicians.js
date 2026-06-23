// Technicians (field staff) + per-appointment assignment. Assignment is an
// internal dispatch concern only — never exposed on the public booking side.
import crypto from 'node:crypto';
import { query, queryOne, withTx } from './db.js';
import { randomToken } from './crypto.js';
import { hexColor } from './http.js';

export async function listTechnicians(tenant, { includeInactive = false } = {}) {
  const r = await query(
    `SELECT id, name, email, phone, color, is_active, user_id FROM technicians
      WHERE tenant_id=$1 ${includeInactive ? '' : 'AND is_active=TRUE'} ORDER BY is_active DESC, name`,
    [tenant.id],
  );
  return r.rows;
}

export async function createTechnician(tenant, { name, email, phone, color, userId }) {
  return queryOne(
    `INSERT INTO technicians (tenant_id, name, email, phone, color, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenant.id, name, email || null, phone || null, hexColor(color, '#2563eb'), userId || null],
  );
}

export async function updateTechnician(tenant, id, fields) {
  const cols = { name: fields.name, email: fields.email, phone: fields.phone, color: fields.color === undefined ? undefined : hexColor(fields.color), user_id: fields.userId, is_active: fields.isActive,
    license_no: fields.licenseNo, license_state: fields.licenseState, license_expires: fields.licenseExpires };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM technicians WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE technicians SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

/** Replace an appointment's assignment set. leadId becomes the lead (or first). */
export async function setAssignments(tenant, appointmentId, technicianIds = [], leadId = null) {
  const ids = [...new Set(technicianIds.map(Number).filter(Boolean))];
  return withTx(async (cx) => {
    // appointment must belong to this tenant
    const appt = await cx.query('SELECT id FROM appointments WHERE id=$1 AND tenant_id=$2', [appointmentId, tenant.id]);
    if (!appt.rows.length) return { ok: false, notFound: true };
    // all techs must belong to this tenant
    if (ids.length) {
      const owned = await cx.query('SELECT id FROM technicians WHERE tenant_id=$1 AND id = ANY($2::bigint[])', [tenant.id, ids]);
      if (owned.rows.length !== ids.length) return { ok: false, error: 'Unknown technician.' };
    }
    await cx.query('DELETE FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2', [tenant.id, appointmentId]);
    const lead = leadId && ids.includes(Number(leadId)) ? Number(leadId) : ids[0] || null;
    for (const tid of ids) {
      await cx.query('INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_lead) VALUES ($1,$2,$3,$4)', [tenant.id, appointmentId, tid, tid === lead]);
    }
    return { ok: true, lead };
  });
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
  listTechnicians, createTechnician, updateTechnician, setAssignments, getAssignments,
  assignmentsForAppointments, ensureFieldToken, revokeFieldToken, technicianByFieldToken,
};
