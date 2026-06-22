// Tenant resolution + settings. Settings are stored as JSONB on the tenant row
// and deep-merged over defaults so older tenants automatically gain new config
// keys. config_version bumps on every settings write (cache-busting hook).
import { query, queryOne } from './db.js';
import { defaultTenantSettings } from './defaults.js';
import { config } from '../config.js';

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, override) {
  if (!isObj(base)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function hydrate(row) {
  if (!row) return null;
  const stored = row.settings || {};
  row.settings = deepMerge(defaultTenantSettings(), stored);
  return row;
}

export async function getTenantById(id) {
  return hydrate(await queryOne('SELECT * FROM tenants WHERE id = $1', [id]));
}

export async function getTenantBySlug(slug) {
  return hydrate(await queryOne('SELECT * FROM tenants WHERE slug = $1 AND is_active = TRUE', [slug]));
}

export async function getDefaultTenant() {
  return getTenantBySlug(config.defaultTenantSlug);
}

/** Merge a partial settings patch into the stored settings and bump the version. */
export async function updateTenantSettings(tenantId, patch) {
  const current = await queryOne('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const merged = deepMerge(current?.settings || {}, patch);
  const row = await queryOne(
    `UPDATE tenants SET settings = $2::jsonb, config_version = config_version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [tenantId, JSON.stringify(merged)],
  );
  return hydrate(row);
}

/** Update top-level tenant columns (name, contact info, timezone, etc.). */
export async function updateTenantProfile(tenantId, fields) {
  const allowed = ['name', 'timezone', 'currency', 'contact_email', 'contact_phone', 'address'];
  const sets = [];
  const params = [tenantId];
  for (const key of allowed) {
    if (fields[key] !== undefined) { params.push(fields[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return getTenantById(tenantId);
  sets.push('updated_at = now()');
  const row = await queryOne(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return hydrate(row);
}

/** Atomically allocate the next invoice number for a tenant (e.g. INV-1001). */
export async function nextInvoiceNumber(tenantId) {
  const row = await queryOne(
    'UPDATE tenants SET invoice_seq = invoice_seq + 1 WHERE id = $1 RETURNING invoice_seq',
    [tenantId],
  );
  return `INV-${row.invoice_seq}`;
}

export default { getTenantById, getTenantBySlug, getDefaultTenant, updateTenantSettings, updateTenantProfile, nextInvoiceNumber, deepMerge };
