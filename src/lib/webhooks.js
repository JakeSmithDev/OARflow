// Outbound webhooks. Endpoints subscribe to event names (or "*"); each domain
// event enqueues a delivery per matching endpoint. Payloads are signed with
// HMAC-SHA256 (X-OARFlow-Signature: sha256=...). Failed deliveries retry with
// exponential backoff (driven by daily maintenance).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { query, queryOne } from './db.js';
import { config } from '../config.js';

// --- SSRF guard ------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:169.254');
}

/**
 * Validate an outbound webhook target. Always rejects non-http(s) schemes. In
 * production additionally requires https and blocks localhost / private /
 * link-local / cloud-metadata addresses (after DNS resolution) to prevent SSRF.
 * Dev allows localhost so you can test against a local sink.
 */
export async function assertSafeWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'Invalid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'URL must be http(s).' };
  if (config.isProduction && u.protocol !== 'https:') return { ok: false, error: 'Webhook URLs must use https.' };
  if (!config.isProduction) return { ok: true }; // dev: allow localhost sinks
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, error: 'Internal hosts are not allowed.' };
  if (net.isIP(host)) { if (isPrivateIp(host)) return { ok: false, error: 'Private/loopback addresses are not allowed.' }; return { ok: true }; }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) return { ok: false, error: 'Host resolves to a private address.' };
  } catch { return { ok: false, error: 'Host could not be resolved.' }; }
  return { ok: true };
}

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
  // Re-validate at delivery time (DNS can change after creation — TOCTOU).
  const safe = await assertSafeWebhookUrl(endpoint.url);
  if (!safe.ok) {
    await query("UPDATE webhook_deliveries SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1", [delivery.id, `blocked: ${safe.error}`]);
    return false;
  }
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
