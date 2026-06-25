// Devices / traps / bait stations + QR-scannable inspection logging.
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { config } from '../config.js';

export function deviceScanUrl(token) { return `${config.baseUrl}/device?d=${token}`; }

export async function listDevices(tenant, customerId, { includeRemoved = false } = {}) {
  const r = await query(
    `SELECT d.*, (SELECT inspected_at FROM device_inspections di WHERE di.device_id=d.id ORDER BY inspected_at DESC LIMIT 1) AS last_inspected,
            (SELECT status FROM device_inspections di WHERE di.device_id=d.id ORDER BY inspected_at DESC LIMIT 1) AS last_status
       FROM devices d WHERE d.tenant_id=$1 AND d.customer_id=$2 ${includeRemoved ? '' : "AND d.status='active'"} ORDER BY d.label`,
    [tenant.id, customerId],
  );
  return r.rows;
}

export async function createDevice(tenant, b, createdBy) {
  return queryOne(
    `INSERT INTO devices (tenant_id, customer_id, unit_id, label, device_type, serial, qr_token, location_notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenant.id, b.customerId, b.unitId || null, b.label, b.deviceType || 'bait_station', b.serial || null, randomToken(8), b.locationNotes || null, createdBy || null],
  );
}

export async function updateDevice(tenant, id, b) {
  const cols = { label: b.label, device_type: b.deviceType, serial: b.serial, location_notes: b.locationNotes, status: b.status, unit_id: b.unitId };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM devices WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE devices SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

export async function getByQr(token) {
  if (!token) return null;
  return queryOne('SELECT * FROM devices WHERE qr_token=$1', [token]);
}
export async function getDevice(tenant, id) { return queryOne('SELECT * FROM devices WHERE tenant_id=$1 AND id=$2', [tenant.id, id]); }

export async function deviceHistory(tenant, deviceId, limit = 50) {
  const r = await query(
    `SELECT di.*, t.name AS technician_name FROM device_inspections di LEFT JOIN technicians t ON t.id=di.technician_id
      WHERE di.tenant_id=$1 AND di.device_id=$2 ORDER BY di.inspected_at DESC LIMIT $3`,
    [tenant.id, deviceId, limit],
  );
  return r.rows;
}

export async function recordInspection(tenant, device, b) {
  return queryOne(
    `INSERT INTO device_inspections (tenant_id, device_id, appointment_id, technician_id, status, activity_level, action_taken, notes, inspected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenant.id, device.id, b.appointmentId || null, b.technicianId || null, b.status || 'ok', b.activityLevel || null, b.actionTaken || null, b.notes || null, b.inspectedBy || null],
  );
}

export default { deviceScanUrl, listDevices, createDevice, updateDevice, getByQr, getDevice, deviceHistory, recordInspection };
