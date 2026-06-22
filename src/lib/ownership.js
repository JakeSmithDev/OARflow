// Tenant ownership guard. Admin create endpoints accept foreign-key IDs from
// the client; this verifies each referenced row actually belongs to the caller's
// tenant, preventing cross-tenant linking / data leakage. Table names come from
// a fixed allowlist (never interpolate untrusted table names).
import { queryOne } from './db.js';

const TABLES = new Set(['customers', 'appointments', 'subscriptions', 'recurring_plans', 'service_types', 'invoices']);

/** True if `id` is null/undefined (optional ref) or belongs to the tenant. */
export async function ownsId(tenantId, table, id) {
  if (id === null || id === undefined) return true;
  if (!TABLES.has(table)) throw new Error(`ownsId: table not allowed (${table})`);
  const row = await queryOne(`SELECT 1 AS ok FROM ${table} WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  return !!row;
}

export default { ownsId };
