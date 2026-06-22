// Reviews / NPS. Ask every customer after a completed job; never gate the public
// review links by score (we show Google/Yelp/Facebook to everyone). The private
// rating + comment are captured for the business's own insight.
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { config } from '../config.js';
import { sendTemplated, fillPlaceholders } from './email_templates.js';

function reviewUrl(tenant, token) { return `${config.baseUrl}/review?token=${token}`; }

/** Create a (pending) review request. Idempotent per appointment. */
export async function createReviewRequest(tenant, { customerId, appointmentId = null, channel, sendAfter = null }) {
  const ch = channel || tenant.settings.reviews.channel || 'email';
  if (appointmentId) {
    const existing = await queryOne('SELECT * FROM review_requests WHERE tenant_id=$1 AND appointment_id=$2', [tenant.id, appointmentId]);
    if (existing) return existing;
  }
  return queryOne(
    `INSERT INTO review_requests (tenant_id, customer_id, appointment_id, channel, access_token, send_after)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING *`,
    [tenant.id, customerId, appointmentId, ch, randomToken(), sendAfter],
  );
}

/** Automatically enqueue a review request after a completed appointment. */
export async function maybeAutoRequest(tenant, appointment) {
  const cfg = tenant.settings.reviews;
  if (!cfg?.enabled || !cfg.autoRequest) return null;
  const sendAfter = new Date(Date.now() + (Number(cfg.delayHours) || 0) * 3600 * 1000);
  return createReviewRequest(tenant, { customerId: appointment.customer_id, appointmentId: appointment.id, channel: cfg.channel, sendAfter });
}

/** Send one request via its channel and mark it sent. */
export async function sendReviewRequest(tenant, request) {
  const cust = await queryOne('SELECT name, email, phone FROM customers WHERE id=$1', [request.customer_id]);
  if (!cust) return { ok: false, error: 'No customer.' };
  const company = tenant.settings.branding.logoText || tenant.name;
  const url = reviewUrl(tenant, request.access_token);
  let svc = '';
  if (request.appointment_id) {
    const a = await queryOne('SELECT s.name FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id WHERE a.id=$1', [request.appointment_id]);
    svc = a?.name || '';
  }
  let ok = false;
  if (request.channel === 'sms') {
    const { sendSms, isSmsConfigured } = await import('./sms.js');
    if (cust.phone && (isSmsConfigured(tenant) || !config.isProduction)) {
      const body = fillPlaceholders(tenant.settings.reviews.smsTemplate, { CUSTOMER_NAME: cust.name, COMPANY_NAME: company, REVIEW_URL: url });
      const r = await sendSms(tenant, { to: cust.phone, body, customerId: request.customer_id, purpose: 'review', idempotencyKey: `review:${request.id}` });
      ok = r.ok !== false;
    }
  } else if (cust.email) {
    const r = await sendTemplated(tenant, 'review_request', cust.email, {
      CUSTOMER_NAME: cust.name, COMPANY_NAME: company, SERVICE_NAME: svc, REVIEW_URL: url,
    }, { type: 'review', id: request.id });
    ok = r.ok;
  }
  await query("UPDATE review_requests SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1", [request.id]);
  return { ok };
}

/** Send all pending requests whose delay has elapsed. Called by daily maintenance. */
export async function processDueReviews(tenant) {
  if (!tenant.settings.reviews?.enabled) return { sent: 0 };
  const due = await query("SELECT * FROM review_requests WHERE tenant_id=$1 AND status='pending' AND send_after <= now() ORDER BY id LIMIT 200", [tenant.id]);
  let sent = 0;
  for (const r of due.rows) { const res = await sendReviewRequest(tenant, r).catch(() => ({ ok: false })); if (res.ok) sent += 1; }
  return { sent, due: due.rows.length };
}

export async function getByToken(token) {
  return queryOne('SELECT * FROM review_requests WHERE access_token=$1', [token]);
}

/** Record the customer's response (rating + comment + which platform they used). */
export async function recordResponse(request, { rating, comment, platform }) {
  const r = Math.max(1, Math.min(5, Math.round(Number(rating) || 0))) || null;
  return queryOne(
    `UPDATE review_requests SET status='responded', rating=COALESCE($2,rating), comment=COALESCE($3,comment),
       platform_clicked=COALESCE($4,platform_clicked), responded_at=COALESCE(responded_at, now()), updated_at=now()
     WHERE id=$1 RETURNING *`,
    [request.id, r, comment || null, platform || null],
  );
}

export async function listReviews(tenant, { status } = {}) {
  const where = ['r.tenant_id=$1']; const params = [tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`r.status=$${params.length}`); }
  const rows = await query(
    `SELECT r.id, r.status, r.channel, r.rating, r.comment, r.platform_clicked, r.sent_at, r.responded_at, r.created_at, c.name AS customer_name
       FROM review_requests r JOIN customers c ON c.id=r.customer_id WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 200`,
    params,
  );
  return rows.rows;
}

export async function reviewMetrics(tenant) {
  const m = await queryOne(
    `SELECT COUNT(*)::int AS requests,
            COUNT(*) FILTER (WHERE status='responded')::int AS responses,
            COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
            COALESCE(AVG(rating) FILTER (WHERE rating IS NOT NULL),0)::numeric(4,2) AS avg_rating,
            COUNT(*) FILTER (WHERE rating=5)::int AS five_star,
            COUNT(*) FILTER (WHERE rating<=3 AND rating IS NOT NULL)::int AS detractors
       FROM review_requests WHERE tenant_id=$1`,
    [tenant.id],
  );
  const rated = m.rated || 0;
  const nps = rated ? Math.round(((m.five_star - m.detractors) / rated) * 100) : 0;
  return { requests: m.requests, responses: m.responses, rated, avgRating: Number(m.avg_rating), fiveStar: m.five_star, nps };
}

export default { createReviewRequest, maybeAutoRequest, sendReviewRequest, processDueReviews, getByToken, recordResponse, listReviews, reviewMetrics };
