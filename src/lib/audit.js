// Lightweight audit logging for admin actions.
import { query } from './db.js';

export async function logAudit({ tenantId, adminUsername, action, entityType, entityId, details }) {
  try {
    await query(
      `INSERT INTO audit_log (tenant_id, admin_username, action, entity_type, entity_id, details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [tenantId || null, adminUsername || null, action, entityType || null, entityId || null, JSON.stringify(details || {})],
    );
  } catch (err) {
    // Auditing must never break the request.
    // eslint-disable-next-line no-console
    console.error('audit log failed', err.message);
  }
}

export default { logAudit };
