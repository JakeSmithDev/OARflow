// Public API keys. The full secret is shown ONCE at creation; we store only a
// SHA-256 hash. Auth resolves the tenant from the key on each request.
import crypto from 'node:crypto';
import { query, queryOne } from './db.js';

function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

export async function createApiKey(tenant, { name, scopes }, createdBy) {
  const secret = `oarf_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = secret.slice(0, 9);
  const row = await queryOne(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, name, key_prefix, scopes, created_at`,
    [tenant.id, name || 'API key', prefix, hashKey(secret), JSON.stringify(scopes || ['read', 'write']), createdBy || null],
  );
  return { ...row, secret }; // secret returned only here
}

export async function listApiKeys(tenant) {
  const r = await query('SELECT id, name, key_prefix, scopes, last_used_at, created_at FROM api_keys WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY id DESC', [tenant.id]);
  return r.rows;
}

export async function revokeApiKey(tenant, id) {
  await query('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  return { ok: true };
}

/** Resolve a key to its api_keys row (or null). Updates last_used_at. */
export async function resolveApiKey(rawKey) {
  if (!rawKey || !/^oarf_/.test(rawKey)) return null;
  const row = await queryOne('SELECT * FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL', [hashKey(rawKey)]);
  if (!row) return null;
  query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.id]).catch(() => {});
  return row;
}

export function keyHasScope(keyRow, scope) {
  const scopes = keyRow.scopes || [];
  return scopes.includes('*') || scopes.includes(scope);
}

export default { createApiKey, listApiKeys, revokeApiKey, resolveApiKey, keyHasScope };
