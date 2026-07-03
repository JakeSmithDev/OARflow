// Customer self-service portal. Magic-link auth (a long-lived, regenerable
// per-customer token). Aggregates the customer's appointments, invoices,
// estimates, and saved cards — reusing the existing public pay/quote/save-card
// flows by handing back their tokens/URLs.
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { config } from '../config.js';
import { balanceCents } from './invoices.js';
import { listPaymentMethods, cardsStatus } from './payments.js';

export async function ensurePortalToken(tenant, customerId) {
  const c = await queryOne('SELECT id, portal_token FROM customers WHERE tenant_id=$1 AND id=$2', [tenant.id, customerId]);
  if (!c) return null;
  if (c.portal_token) return c.portal_token;
  const token = randomToken();
  await query('UPDATE customers SET portal_token=$3 WHERE tenant_id=$1 AND id=$2', [tenant.id, customerId, token]);
  return token;
}

export async function customerByPortalToken(tenant, token) {
  if (!tenant || !token) return null;
  return queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND portal_token=$2', [tenant.id, token]);
}

export function portalUrl(token, tenant) {
  const slug = tenant?.slug ? `&t=${encodeURIComponent(tenant.slug)}` : '';
  return `${config.baseUrl}/portal?token=${encodeURIComponent(token)}${slug}`;
}

/** Everything the portal page renders for one customer. */
export async function portalData(tenant, customer) {
  const appts = await query(
    `SELECT a.id, a.status, a.scheduled_start, a.service_address, a.access_token, s.name AS service_name, s.color AS service_color
       FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE a.tenant_id=$1 AND a.customer_id=$2 AND a.status <> 'canceled'
      ORDER BY COALESCE(a.scheduled_start, a.created_at) DESC LIMIT 50`,
    [tenant.id, customer.id],
  );
  const now = Date.now();
  const upcoming = []; const past = [];
  const terminalStatuses = new Set(['completed', 'canceled', 'no_show']);
  for (const a of appts.rows) {
    a.manageUrl = a.access_token ? `${config.baseUrl}/book?appt=${encodeURIComponent(a.access_token)}&t=${encodeURIComponent(tenant.slug)}` : null;
    const when = a.scheduled_start ? new Date(a.scheduled_start).getTime() : null;
    ((when && when >= now) || (!when && !terminalStatuses.has(a.status)) ? upcoming : past).push(a);
  }
  upcoming.reverse();

  const invRows = await query(
    `SELECT id, number, status, currency, total_cents, amount_paid_cents, created_at, sent_at, access_token
       FROM invoices WHERE tenant_id=$1 AND customer_id=$2 AND status NOT IN ('void','draft') ORDER BY id DESC LIMIT 50`,
    [tenant.id, customer.id],
  );
  const invoices = invRows.rows.map((i) => ({
    id: i.id, number: i.number, status: i.status, currency: i.currency, totalCents: i.total_cents, balanceCents: balanceCents(i),
    createdAt: i.created_at, sentAt: i.sent_at,
    payUrl: balanceCents(i) > 0 && i.status !== 'draft' ? `${config.baseUrl}/pay?invoice=${i.id}&token=${i.access_token}` : null,
  }));

  let estimates = [];
  try {
    const estRows = await query(
      `SELECT id, number, status, total_cents, valid_until, access_token FROM estimates
        WHERE tenant_id=$1 AND customer_id=$2 AND status IN ('sent') ORDER BY id DESC LIMIT 20`,
      [tenant.id, customer.id],
    );
    estimates = estRows.rows.map((e) => ({ id: e.id, number: e.number, totalCents: e.total_cents, validUntil: e.valid_until, approveUrl: `${config.baseUrl}/quote?estimate=${e.id}&token=${e.access_token}` }));
  } catch { /* estimates table may not exist on very old DBs */ }

  const paymentMethods = await listPaymentMethods(tenant, customer.id);

  return {
    tenant: { name: tenant.name, timezone: tenant.timezone, branding: tenant.settings.branding, bookUrl: `${config.baseUrl}/book?t=${encodeURIComponent(tenant.slug)}` },
    customer: { name: customer.name, email: customer.email, phone: customer.phone },
    upcoming, past, invoices, estimates,
    cards: cardsStatus(tenant), paymentMethods,
    cardLink: customer.card_token ? `${config.baseUrl}/save-card?customer=${customer.id}&token=${customer.card_token}` : null,
  };
}

export default { ensurePortalToken, customerByPortalToken, portalUrl, portalData };
