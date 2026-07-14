// Dashboard metrics for the admin home + small counts for nav badges.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { query } from '../../lib/db.js';
import { zonedWallTimeToUtc, todayYmd, addDays, ymdInTimeZone } from '../../lib/dates.js';
import { hasCapability } from '../../lib/permissions.js';

const router = express.Router();
router.use(requireAdmin());

// Normalize a plan's price to a monthly figure (cents) for MRR.
function monthlyCents(interval, intervalCount, priceCents) {
  switch (interval) {
    case 'monthly': return priceCents;
    case 'quarterly': return Math.round(priceCents / 3);
    case 'semiannual': return Math.round(priceCents / 6);
    case 'annual': return Math.round(priceCents / 12);
    case 'custom': return Math.round(priceCents / Math.max(1, intervalCount || 1));
    default: return priceCents;
  }
}

function boundaries(tz) {
  const ymd = todayYmd(tz);
  const dayStart = zonedWallTimeToUtc(ymd, '00:00', tz);
  const dayEnd = addDays(dayStart, 1);
  const weekEnd = addDays(dayStart, 7);
  const monthStart = zonedWallTimeToUtc(ymd.slice(0, 8) + '01', '00:00', tz);
  return { dayStart, dayEnd, weekEnd, monthStart };
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(value) {
  if (!YMD_RE.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftYmd(ymd, days) {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Dashboard analytics are deliberately bounded. Besides keeping queries quick,
// this prevents an accidental all-time chart from returning thousands of daily
// points for an established tenant.
function analyticsRange(queryParams, tz) {
  const to = queryParams.to || todayYmd(tz);
  const from = queryParams.from || shiftYmd(to, -179);
  if (!isYmd(from) || !isYmd(to)) return { error: 'Use YYYY-MM-DD dates for the dashboard range.' };
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days < 1) return { error: 'The dashboard start date must be before the end date.' };
  if (days > 1096) return { error: 'Dashboard ranges are limited to three years.' };
  const grain = days > 240 ? 'month' : days > 60 ? 'week' : 'day';
  return {
    from,
    to,
    days,
    grain,
    start: zonedWallTimeToUtc(from, '00:00', tz),
    end: zonedWallTimeToUtc(shiftYmd(to, 1), '00:00', tz),
  };
}

function bucketStart(ymd, grain) {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  if (grain === 'month') date.setUTCDate(1);
  if (grain === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function nextBucket(ymd, grain) {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + 1, 1);
  else date.setUTCDate(date.getUTCDate() + (grain === 'week' ? 7 : 1));
  return date.toISOString().slice(0, 10);
}

function fillTrend(rows, range, fields) {
  const byBucket = new Map(rows.map((row) => [String(row.bucket).slice(0, 10), row]));
  const out = [];
  for (let bucket = bucketStart(range.from, range.grain), n = 0;
    bucket <= range.to && n < 550;
    bucket = nextBucket(bucket, range.grain), n += 1) {
    const row = byBucket.get(bucket) || {};
    out.push(Object.fromEntries([['bucket', bucket], ...fields.map((field) => [field, Number(row[field] || 0)])]));
  }
  return out;
}

const APPT_SELECT = `
  SELECT a.id, a.status, a.booking_mode, a.scheduled_start, a.scheduled_end, a.service_address,
         a.price_cents, a.requested_slots, a.notes,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         s.name AS service_name, s.color AS service_color
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN service_types s ON s.id = a.service_type_id`;

async function navCounts(tenantId, tz) {
  const { dayEnd } = boundaries(tz);
  const reqs = await query("SELECT count(*)::int n FROM appointments WHERE tenant_id=$1 AND status='requested'", [tenantId]);
  const reschedules = await query(
    "SELECT count(*)::int n FROM follow_ups WHERE tenant_id=$1 AND status='pending' AND created_by='public_reschedule'",
    [tenantId],
  );
  const fus = await query(
    "SELECT count(*)::int n FROM follow_ups WHERE tenant_id=$1 AND status='pending' AND due_at <= $2",
    [tenantId, dayEnd.toISOString()],
  );
  const sms = await query("SELECT COALESCE(SUM(unread_count),0)::int n FROM sms_conversations WHERE tenant_id=$1", [tenantId]).catch(() => ({ rows: [{ n: 0 }] }));
  return { requests: reqs.rows[0].n + reschedules.rows[0].n, followups: fus.rows[0].n, sms: sms.rows[0].n };
}

router.get('/counts', asyncHandler(async (req, res) => {
  res.json({ ok: true, counts: await navCounts(req.tenant.id, req.tenant.timezone) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const tz = req.tenant.timezone;
  const canViewReports = hasCapability(req.admin, 'reports.view');
  const canViewEstimates = hasCapability(req.admin, 'estimates.manage');
  const { dayStart, dayEnd, weekEnd, monthStart } = boundaries(tz);
  const range = analyticsRange(req.query, tz);
  if (range.error) return badRequest(res, range.error);

  const todayPromise = query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status IN ('scheduled','completed')
      AND a.scheduled_start >= $2 AND a.scheduled_start < $3 ORDER BY a.scheduled_start`,
    [tenantId, dayStart.toISOString(), dayEnd.toISOString()],
  );
  const upcomingPromise = query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status='scheduled'
      AND a.scheduled_start >= $2 AND a.scheduled_start < $3 ORDER BY a.scheduled_start LIMIT 8`,
    [tenantId, dayEnd.toISOString(), weekEnd.toISOString()],
  );
  const requestsPromise = query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status='requested' ORDER BY a.created_at LIMIT 6`,
    [tenantId],
  );
  const outstandingPromise = canViewReports
    ? query(
      `SELECT i.id, i.number, i.total_cents, i.amount_paid_cents, i.status, i.sent_at, i.due_date,
              c.name AS customer_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.tenant_id=$1 AND i.status IN ('sent','partial')
        ORDER BY i.sent_at NULLS LAST LIMIT 6`,
      [tenantId],
    )
    : Promise.resolve({ rows: [] });
  const followupsPromise = query(
    `SELECT f.id, f.title, f.type, f.channel, f.due_at, f.status, c.name AS customer_name
       FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
      WHERE f.tenant_id=$1 AND f.status='pending' ORDER BY f.due_at LIMIT 6`,
    [tenantId],
  );

  const jobSummaryPromise = query(
    `SELECT
       (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3)::int AS booked_count,
       COALESCE((SELECT SUM(price_cents) FROM appointments WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3),0)::bigint AS booked_value,
       (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND status='completed' AND COALESCE(completed_at, scheduled_start, created_at) >= $2 AND COALESCE(completed_at, scheduled_start, created_at) < $3)::int AS completed_count,
       COALESCE((SELECT SUM(price_cents) FROM appointments WHERE tenant_id=$1 AND status='completed' AND COALESCE(completed_at, scheduled_start, created_at) >= $2 AND COALESCE(completed_at, scheduled_start, created_at) < $3),0)::bigint AS completed_value,
       (SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3)::int AS new_customers`,
    [tenantId, range.start.toISOString(), range.end.toISOString()],
  );

  const appointmentTrendPromise = query(
    `WITH activity AS (
       SELECT to_char(date_trunc('${range.grain}', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket,
              COUNT(*)::int AS booked, 0::int AS completed, 0::int AS canceled
         FROM appointments WHERE tenant_id=$1 AND created_at >= $3 AND created_at < $4 GROUP BY 1
       UNION ALL
       SELECT to_char(date_trunc('${range.grain}', completed_at AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket,
              0::int, COUNT(*)::int, 0::int
         FROM appointments WHERE tenant_id=$1 AND status='completed' AND completed_at >= $3 AND completed_at < $4 GROUP BY 1
       UNION ALL
       SELECT to_char(date_trunc('${range.grain}', canceled_at AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket,
              0::int, 0::int, COUNT(*)::int
         FROM appointments WHERE tenant_id=$1 AND status='canceled' AND canceled_at >= $3 AND canceled_at < $4 GROUP BY 1)
     SELECT bucket, SUM(booked)::int AS booked, SUM(completed)::int AS completed, SUM(canceled)::int AS canceled
       FROM activity GROUP BY bucket ORDER BY bucket`,
    [tenantId, tz, range.start.toISOString(), range.end.toISOString()],
  );

  const jobStatusPromise = query(
    `SELECT status, COUNT(*)::int AS count
       FROM appointments
      WHERE tenant_id=$1 AND COALESCE(scheduled_start, created_at) >= $2 AND COALESCE(scheduled_start, created_at) < $3
      GROUP BY status`,
    [tenantId, range.start.toISOString(), range.end.toISOString()],
  );

  const financialSummaryPromise = canViewReports
    ? query(
      `SELECT
         COALESCE((SELECT SUM(amount_cents) FROM financial_events WHERE tenant_id=$1 AND event_type='payment' AND created_at >= $2),0)::bigint AS revenue_mtd,
         COALESCE((SELECT SUM(amount_cents) FROM financial_events WHERE tenant_id=$1 AND event_type='payment' AND created_at >= $3 AND created_at < $4),0)::bigint AS collected,
         COALESCE((SELECT SUM(ABS(amount_cents)) FROM financial_events WHERE tenant_id=$1 AND event_type='refund' AND created_at >= $3 AND created_at < $4),0)::bigint AS refunded,
         COALESCE((SELECT SUM(total_cents) FROM invoices WHERE tenant_id=$1 AND status<>'void' AND COALESCE(sent_at, created_at) >= $3 AND COALESCE(sent_at, created_at) < $4),0)::bigint AS invoiced,
         (SELECT COUNT(*) FROM invoices WHERE tenant_id=$1 AND status<>'void' AND COALESCE(sent_at, created_at) >= $3 AND COALESCE(sent_at, created_at) < $4)::int AS invoice_count,
         (SELECT COUNT(*) FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial'))::int AS open_invoice_count,
         COALESCE((SELECT SUM(total_cents-amount_paid_cents) FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial')),0)::bigint AS outstanding`,
      [tenantId, monthStart.toISOString(), range.start.toISOString(), range.end.toISOString()],
    )
    : Promise.resolve({ rows: [{ revenue_mtd: 0, collected: 0, refunded: 0, invoiced: 0, invoice_count: 0, open_invoice_count: 0, outstanding: 0 }] });

  const financialTrendPromise = canViewReports
    ? query(
      `WITH ledger AS (
         SELECT to_char(date_trunc('${range.grain}', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket,
                COALESCE(SUM(CASE WHEN event_type='payment' THEN amount_cents ELSE 0 END),0)::bigint AS collected,
                COALESCE(SUM(CASE WHEN event_type='refund' THEN ABS(amount_cents) ELSE 0 END),0)::bigint AS refunded
           FROM financial_events WHERE tenant_id=$1 AND created_at >= $3 AND created_at < $4 GROUP BY 1),
       issued AS (
         SELECT to_char(date_trunc('${range.grain}', COALESCE(sent_at, created_at) AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket,
                COALESCE(SUM(total_cents),0)::bigint AS invoiced
           FROM invoices WHERE tenant_id=$1 AND status<>'void' AND COALESCE(sent_at, created_at) >= $3 AND COALESCE(sent_at, created_at) < $4 GROUP BY 1)
       SELECT COALESCE(ledger.bucket, issued.bucket) AS bucket,
              COALESCE(ledger.collected,0)::bigint AS collected,
              COALESCE(ledger.refunded,0)::bigint AS refunded,
              COALESCE(issued.invoiced,0)::bigint AS invoiced
         FROM ledger FULL OUTER JOIN issued ON issued.bucket=ledger.bucket ORDER BY bucket`,
      [tenantId, tz, range.start.toISOString(), range.end.toISOString()],
    )
    : Promise.resolve({ rows: [] });

  const invoiceAgingPromise = canViewReports
    ? query(
      `WITH open_invoices AS (
         SELECT (total_cents-amount_paid_cents) AS balance,
                GREATEST(0, CURRENT_DATE-COALESCE(due_date, sent_at::date, created_at::date)) AS age_days
           FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial') AND total_cents>amount_paid_cents)
       SELECT CASE WHEN age_days=0 THEN 'current' WHEN age_days<=30 THEN '1_30'
                   WHEN age_days<=60 THEN '31_60' WHEN age_days<=90 THEN '61_90' ELSE '90_plus' END AS bucket,
              COUNT(*)::int AS count, COALESCE(SUM(balance),0)::bigint AS balance
         FROM open_invoices GROUP BY 1`,
      [tenantId],
    )
    : Promise.resolve({ rows: [] });

  const estimateMixPromise = canViewEstimates
    ? query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_cents),0)::bigint AS value
         FROM estimates WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY status`,
      [tenantId, range.start.toISOString(), range.end.toISOString()],
    )
    : Promise.resolve({ rows: [] });

  const subscriptionsPromise = canViewReports
    ? query(
      "SELECT interval, interval_count, price_cents FROM subscriptions WHERE tenant_id=$1 AND status='active'",
      [tenantId],
    )
    : Promise.resolve({ rows: [] });

  const [
    today, upcoming, requests, outstanding, followups,
    jobSummaryResult, appointmentTrendResult, jobStatusResult,
    financialSummaryResult, financialTrendResult, invoiceAgingResult,
    estimateMixResult, subs,
  ] = await Promise.all([
    todayPromise, upcomingPromise, requestsPromise, outstandingPromise, followupsPromise,
    jobSummaryPromise, appointmentTrendPromise, jobStatusPromise,
    financialSummaryPromise, financialTrendPromise, invoiceAgingPromise,
    estimateMixPromise, subscriptionsPromise,
  ]);

  const jobSummary = jobSummaryResult.rows[0];
  const financialSummary = financialSummaryResult.rows[0];
  let mrr = 0;
  for (const s of subs.rows) mrr += monthlyCents(s.interval, s.interval_count, s.price_cents);

  res.json({
    ok: true,
    metrics: {
      revenueMtdCents: Number(financialSummary.revenue_mtd),
      outstandingCents: Number(financialSummary.outstanding),
      mrrCents: mrr,
      arrCents: mrr * 12,
      activeSubs: subs.rows.length,
      todayCount: today.rows.length,
      financialVisible: canViewReports,
    },
    analytics: {
      range: { from: range.from, to: range.to, days: range.days, grain: range.grain },
      jobs: {
        bookedCount: Number(jobSummary.booked_count),
        bookedValueCents: Number(jobSummary.booked_value),
        completedCount: Number(jobSummary.completed_count),
        completedValueCents: Number(jobSummary.completed_value),
        newCustomers: Number(jobSummary.new_customers),
      },
      appointmentTrend: fillTrend(appointmentTrendResult.rows, range, ['booked', 'completed', 'canceled']),
      jobStatus: jobStatusResult.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
      financial: {
        visible: canViewReports,
        collectedCents: Number(financialSummary.collected),
        refundedCents: Number(financialSummary.refunded),
        invoicedCents: Number(financialSummary.invoiced),
        invoiceCount: Number(financialSummary.invoice_count),
        openInvoiceCount: Number(financialSummary.open_invoice_count),
        outstandingCents: Number(financialSummary.outstanding),
        revenueTrend: fillTrend(financialTrendResult.rows, range, ['collected', 'refunded', 'invoiced']),
        invoiceAging: invoiceAgingResult.rows.map((row) => ({ bucket: row.bucket, count: Number(row.count), balanceCents: Number(row.balance) })),
      },
      estimates: {
        visible: canViewEstimates,
        mix: estimateMixResult.rows.map((row) => ({ status: row.status, count: Number(row.count), valueCents: Number(row.value) })),
      },
    },
    counts: await navCounts(tenantId, tz),
    today: today.rows,
    upcoming: upcoming.rows,
    requests: requests.rows,
    outstanding: outstanding.rows,
    followups: followups.rows,
    todayLabel: ymdInTimeZone(new Date(), tz),
  });
}));

export default router;
