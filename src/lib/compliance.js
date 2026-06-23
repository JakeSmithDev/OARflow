// Pest-control compliance: chemical/material catalog, per-service application
// records, and state-report exports. Application rows SNAPSHOT product +
// applicator fields so historical records never drift when the catalog changes.
import { query, queryOne } from './db.js';
import { toCsv } from './csv.js';

// --- Product catalog ---
export async function listProducts(tenant, { includeInactive = false } = {}) {
  const r = await query(
    `SELECT * FROM chemical_products WHERE tenant_id=$1 ${includeInactive ? '' : 'AND is_active=TRUE'} ORDER BY name`,
    [tenant.id],
  );
  return r.rows;
}
export async function createProduct(tenant, b) {
  return queryOne(
    `INSERT INTO chemical_products (tenant_id, name, epa_reg_no, active_ingredient, signal_word, unit, default_rate, target_pests)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenant.id, b.name, b.epaRegNo || null, b.activeIngredient || null, b.signalWord || null, b.unit || 'oz', b.defaultRate || null, b.targetPests || null],
  );
}
export async function updateProduct(tenant, id, b) {
  const cols = { name: b.name, epa_reg_no: b.epaRegNo, active_ingredient: b.activeIngredient, signal_word: b.signalWord, unit: b.unit, default_rate: b.defaultRate, target_pests: b.targetPests, is_active: b.isActive };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM chemical_products WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE chemical_products SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

// --- Application records ---
export async function recordApplication(tenant, appointmentId, b, createdBy) {
  const appt = await queryOne('SELECT id FROM appointments WHERE id=$1 AND tenant_id=$2', [appointmentId, tenant.id]);
  if (!appt) return { ok: false, error: 'Unknown appointment.' };
  let product = null;
  if (b.productId) product = await queryOne('SELECT * FROM chemical_products WHERE tenant_id=$1 AND id=$2', [tenant.id, b.productId]);
  let tech = null;
  if (b.technicianId) tech = await queryOne('SELECT * FROM technicians WHERE tenant_id=$1 AND id=$2', [tenant.id, b.technicianId]);
  const row = await queryOne(
    `INSERT INTO chemical_applications
       (tenant_id, appointment_id, product_id, technician_id, product_name, epa_reg_no, active_ingredient, target_pest, area_treated, rate, quantity, unit, method, location_notes, applicator_name, applicator_license, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [tenant.id, appointmentId, b.productId || null, b.technicianId || null,
     b.productName || product?.name || 'Material', b.epaRegNo || product?.epa_reg_no || null, b.activeIngredient || product?.active_ingredient || null,
     b.targetPest || null, b.areaTreated || null, b.rate || product?.default_rate || null,
     b.quantity != null ? Number(b.quantity) : null, b.unit || product?.unit || null, b.method || null, b.locationNotes || null,
     b.applicatorName || tech?.name || null, b.applicatorLicense || tech?.license_no || null, createdBy || null],
  );
  return { ok: true, application: row };
}
export async function listApplications(tenant, appointmentId) {
  const r = await query('SELECT * FROM chemical_applications WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY id DESC', [tenant.id, appointmentId]);
  return r.rows;
}
export async function deleteApplication(tenant, id) {
  await query('DELETE FROM chemical_applications WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  return { ok: true };
}

// --- Service report (per appointment) ---
export async function serviceReport(tenant, appointmentId) {
  const a = await queryOne(
    `SELECT a.*, c.name AS customer_name, c.address AS customer_address, c.city, c.state, s.name AS service_name
       FROM appointments a JOIN customers c ON c.id=a.customer_id LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE a.tenant_id=$1 AND a.id=$2`, [tenant.id, appointmentId]);
  if (!a) return null;
  const applications = await listApplications(tenant, appointmentId);
  const crew = await query('SELECT t.name, t.license_no, t.license_state FROM appointment_assignments aa JOIN technicians t ON t.id=aa.technician_id WHERE aa.tenant_id=$1 AND aa.appointment_id=$2', [tenant.id, appointmentId]);
  return { appointment: a, applications, crew: crew.rows, company: { name: tenant.settings.branding.logoText || tenant.name, phone: tenant.contact_phone, address: tenant.address } };
}

// --- State-report export (date range) ---
export async function applicationsCsv(tenant, { from, to }) {
  const fromD = from || '1970-01-01'; const toD = to || new Date().toISOString().slice(0, 10);
  const r = await query(
    `SELECT ca.applied_at, ca.product_name, ca.epa_reg_no, ca.active_ingredient, ca.target_pest, ca.area_treated,
            ca.rate, ca.quantity, ca.unit, ca.method, ca.applicator_name, ca.applicator_license,
            c.name AS customer_name, COALESCE(c.address,'') AS address, COALESCE(c.city,'') AS city, COALESCE(c.state,'') AS state
       FROM chemical_applications ca JOIN appointments a ON a.id=ca.appointment_id JOIN customers c ON c.id=a.customer_id
      WHERE ca.tenant_id=$1 AND ca.applied_at >= $2::date AND ca.applied_at < ($3::date + INTERVAL '1 day')
      ORDER BY ca.applied_at`,
    [tenant.id, fromD, toD],
  );
  const columns = [
    { key: 'date', label: 'Date' }, { key: 'customer', label: 'Customer' }, { key: 'address', label: 'Address' },
    { key: 'product', label: 'Product' }, { key: 'epa', label: 'EPA Reg #' }, { key: 'ai', label: 'Active Ingredient' },
    { key: 'pest', label: 'Target Pest' }, { key: 'area', label: 'Area Treated' }, { key: 'rate', label: 'Rate' },
    { key: 'qty', label: 'Quantity' }, { key: 'unit', label: 'Unit' }, { key: 'method', label: 'Method' },
    { key: 'applicator', label: 'Applicator' }, { key: 'license', label: 'License #' },
  ];
  const rows = r.rows.map((x) => ({
    date: new Date(x.applied_at).toISOString().slice(0, 10), customer: x.customer_name,
    address: [x.address, x.city, x.state].filter(Boolean).join(', '), product: x.product_name, epa: x.epa_reg_no || '',
    ai: x.active_ingredient || '', pest: x.target_pest || '', area: x.area_treated || '', rate: x.rate || '',
    qty: x.quantity ?? '', unit: x.unit || '', method: x.method || '', applicator: x.applicator_name || '', license: x.applicator_license || '',
  }));
  return { csv: toCsv(columns, rows), count: rows.length };
}

export default {
  listProducts, createProduct, updateProduct, recordApplication, listApplications, deleteApplication, serviceReport, applicationsCsv,
};
