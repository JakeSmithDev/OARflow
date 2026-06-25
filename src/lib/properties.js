// Multi-unit properties + units with a simple diagram (annotation markers over
// an optional floorplan image). Units tie to devices (P3b) for per-unit history.
import { query, queryOne } from './db.js';
import { signedUrl, getFile } from './storage.js';

export async function listProperties(tenant, customerId) {
  const r = await query(
    `SELECT p.*, (SELECT count(*) FROM units u WHERE u.property_id=p.id)::int AS unit_count
       FROM properties p WHERE p.tenant_id=$1 AND p.customer_id=$2 ORDER BY p.name`,
    [tenant.id, customerId],
  );
  return r.rows;
}
export async function createProperty(tenant, b) {
  return queryOne(
    `INSERT INTO properties (tenant_id, customer_id, name, address, city, state, postal_code, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenant.id, b.customerId, b.name, b.address || null, b.city || null, b.state || null, b.postalCode || null, b.notes || null],
  );
}
export async function updateProperty(tenant, id, b) {
  const cols = { name: b.name, address: b.address, city: b.city, state: b.state, postal_code: b.postalCode, notes: b.notes };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM properties WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE properties SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}
export async function deleteProperty(tenant, id) { await query('DELETE FROM properties WHERE tenant_id=$1 AND id=$2', [tenant.id, id]); return { ok: true }; }

export async function listUnits(tenant, propertyId) {
  const r = await query(
    `SELECT u.*, (SELECT count(*) FROM devices d WHERE d.unit_id=u.id AND d.status='active')::int AS device_count
       FROM units u WHERE u.tenant_id=$1 AND u.property_id=$2 ORDER BY u.label`,
    [tenant.id, propertyId],
  );
  return r.rows;
}
export async function createUnit(tenant, b) {
  const prop = await queryOne('SELECT id FROM properties WHERE tenant_id=$1 AND id=$2', [tenant.id, b.propertyId]);
  if (!prop) return null;
  return queryOne('INSERT INTO units (tenant_id, property_id, label, floor, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [tenant.id, b.propertyId, b.label, b.floor || null, b.notes || null]);
}
export async function updateUnit(tenant, id, b) {
  const cols = { label: b.label, floor: b.floor, notes: b.notes, status: b.status };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM units WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE units SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}
export async function saveDiagram(tenant, unitId, markers) {
  const clean = Array.isArray(markers) ? markers.slice(0, 200).map((m) => ({ x: Math.max(0, Math.min(1, Number(m.x) || 0)), y: Math.max(0, Math.min(1, Number(m.y) || 0)), label: String(m.label || '').slice(0, 60), deviceId: m.deviceId ? Number(m.deviceId) : null })) : [];
  return queryOne("UPDATE units SET diagram=jsonb_set(diagram,'{markers}',$3::jsonb), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenant.id, unitId, JSON.stringify(clean)]);
}
export async function setFloorplan(tenant, unitId, fileId) {
  return queryOne('UPDATE units SET floorplan_file_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [tenant.id, unitId, fileId]);
}

/** Full unit detail: diagram, floorplan URL, devices placed here, recent history. */
export async function unitDetail(tenant, unitId) {
  const u = await queryOne('SELECT * FROM units WHERE tenant_id=$1 AND id=$2', [tenant.id, unitId]);
  if (!u) return null;
  let floorplanUrl = null;
  if (u.floorplan_file_id) { const f = await getFile(tenant.id, u.floorplan_file_id); if (f) floorplanUrl = await signedUrl(f); }
  const devices = (await query("SELECT id, label, device_type, qr_token, status FROM devices WHERE tenant_id=$1 AND unit_id=$2 AND status='active' ORDER BY label", [tenant.id, unitId])).rows;
  const inspections = (await query(
    `SELECT di.status, di.activity_level, di.inspected_at, d.label AS device_label, t.name AS technician_name
       FROM device_inspections di JOIN devices d ON d.id=di.device_id LEFT JOIN technicians t ON t.id=di.technician_id
      WHERE di.tenant_id=$1 AND d.unit_id=$2 ORDER BY di.inspected_at DESC LIMIT 20`, [tenant.id, unitId])).rows;
  return { unit: u, floorplanUrl, devices, inspections };
}

export default {
  listProperties, createProperty, updateProperty, deleteProperty,
  listUnits, createUnit, updateUnit, saveDiagram, setFloorplan, unitDetail,
};
