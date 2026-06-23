// Outbound webhooks. Endpoints subscribe to event names (or "*"); each domain
// event enqueues a delivery per matching endpoint. Payloads are signed with
// HMAC-SHA256 (X-OARFlow-Signature: sha256=...). Failed deliveries retry with
// exponential backoff (driven by daily maintenance).
import crypto from 'node:crypto';
import { query, queryOne } from './db.js';

export const WEBHOOK_EVENTS = [
  'appointment.scheduled', 'appointment.completed', 'appointment.canceled',
  'invoice.sent', 'invoice.paid', 'estimate.accepted', 'review.responded',
  'customer.created', 'call.received',
];

export function sign(secret, body) { return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex'); }

export async function listEndpoints(tenant) {
  const r = await query('SELECT id, url, events, is_active, created_at FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY id DESC', [tenant.id]);
  return r.rows;
}
export async function createEndpoint(tenant, { url, events }, createdBy) {
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const row = await queryOne(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret, events, created_by) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id, url, events, is_active, created_at`,
    [tenant.id, url, secret, JSON.stringify(events && events.length ? events : ['*']), createdBy || null],
  );
  return { ...row, secret };
}
export async function deleteEndpoint(tenant, id) {
  await query('DELETE FROM webhook_endpoints WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  return { ok: true };
}
export async function recentDeliveries(tenant, limit = 50) {
  const r = await query('SELECT id, endpoint_id, event, status, attempts, response_code, error, created_at, delivered_at FROM webhook_deliveries WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2', [tenant.id, limit]);
  return r.rows;
}

function matches(events, event) { return events.includes('*') || events.includes(event); }

/** Enqueue a delivery for every active endpoint subscribed to this event. */
export async function enqueue(tenantId, event, data) {
  const eps = await query('SELECT * FROM webhook_endpoints WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]);
  const payload = { event, created_at: new Date().toISOString(), data };
  const ids = [];
  for (const ep of eps.rows) {
    if (!matches(ep.events || ['*'], event)) continue;
    const row = await queryOne(
      'INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id',
      [tenantId, ep.id, event, JSON.stringify(payload)],
    );
    ids.push(row.id);
  }
  // Best-effort immediate attempt (retries happen via the queue).
  if (ids.length) deliverDue(tenantId).catch(() => {});
  return ids;
}

async function attempt(delivery, endpoint) {
  const body = JSON.stringify(delivery.payload);
  let code = 0; let error = null;
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OARFlow-Event': delivery.event, 'X-OARFlow-Signature': sign(endpoint.secret, body) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) { error = e.message; }
  const ok = code >= 200 && code < 300;
  const attempts = delivery.attempts + 1;
  if (ok) {
    await query("UPDATE webhook_deliveries SET status='delivered', attempts=$2, response_code=$3, delivered_at=now(), error=NULL WHERE id=$1", [delivery.id, attempts, code]);
  } else {
    const backoffMin = Math.min(60, 2 ** attempts); // 2,4,8,…,60 minutes
    const status = attempts >= 6 ? 'failed' : 'pending';
    await query("UPDATE webhook_deliveries SET status=$2, attempts=$3, response_code=$4, error=$5, next_attempt_at=now() + ($6 || ' minutes')::interval WHERE id=$1",
      [delivery.id, status, attempts, code || null, error, String(backoffMin)]);
  }
  return ok;
}

/** Deliver all due deliveries for a tenant (pending/failed with next_attempt due). */
export async function deliverDue(tenantId, max = 50) {
  const due = await query(
    "SELECT * FROM webhook_deliveries WHERE tenant_id=$1 AND status IN ('pending','failed') AND next_attempt_at <= now() ORDER BY id LIMIT $2",
    [tenantId, max],
  );
  let delivered = 0;
  for (const d of due.rows) {
    const ep = await queryOne('SELECT * FROM webhook_endpoints WHERE id=$1', [d.endpoint_id]);
    if (!ep || !ep.is_active) { await query("UPDATE webhook_deliveries SET status='failed', error='endpoint removed' WHERE id=$1", [d.id]); continue; }
    if (await attempt(d, ep)) delivered += 1;
  }
  return { due: due.rows.length, delivered };
}

export async function processWebhooks(tenant) { return deliverDue(tenant.id); }

export default { WEBHOOK_EVENTS, sign, listEndpoints, createEndpoint, deleteEndpoint, recentDeliveries, enqueue, deliverDue, processWebhooks };
