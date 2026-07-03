// Dashboard metrics for the admin home + small counts for nav badges.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler } from '../../lib/http.js';
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
  const fus = await query(
    "SELECT count(*)::int n FROM follow_ups WHERE tenant_id=$1 AND status='pending' AND due_at <= $2",
    [tenantId, dayEnd.toISOString()],
  );
  const sms = await query("SELECT COALESCE(SUM(unread_count),0)::int n FROM sms_conversations WHERE tenant_id=$1", [tenantId]).catch(() => ({ rows: [{ n: 0 }] }));
  return { requests: reqs.rows[0].n, followups: fus.rows[0].n, sms: sms.rows[0].n };
}

router.get('/counts', asyncHandler(async (req, res) => {
  res.json({ ok: true, counts: await navCounts(req.tenant.id, req.tenant.timezone) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const tz = req.tenant.timezone;
  const canViewReports = hasCapability(req.admin, 'reports.view');
  const { dayStart, dayEnd, weekEnd, monthStart } = boundaries(tz);

  const today = await query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status IN ('scheduled','completed')
      AND a.scheduled_start >= $2 AND a.scheduled_start < $3 ORDER BY a.scheduled_start`,
    [tenantId, dayStart.toISOString(), dayEnd.toISOString()],
  );
  const upcoming = await query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status='scheduled'
      AND a.scheduled_start >= $2 AND a.scheduled_start < $3 ORDER BY a.scheduled_start LIMIT 8`,
    [tenantId, dayEnd.toISOString(), weekEnd.toISOString()],
  );
  const requests = await query(
    `${APPT_SELECT} WHERE a.tenant_id=$1 AND a.status='requested' ORDER BY a.created_at LIMIT 6`,
    [tenantId],
  );
  let outstanding = { rows: [] };
  if (canViewReports) {
    outstanding = await query(
      `SELECT i.id, i.number, i.total_cents, i.amount_paid_cents, i.status, i.sent_at, i.due_date,
              c.name AS customer_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.tenant_id=$1 AND i.status IN ('sent','partial')
        ORDER BY i.sent_at NULLS LAST LIMIT 6`,
      [tenantId],
    );
  }
  const followups = await query(
    `SELECT f.id, f.title, f.type, f.channel, f.due_at, f.status, c.name AS customer_name
       FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
      WHERE f.tenant_id=$1 AND f.status='pending' ORDER BY f.due_at LIMIT 6`,
    [tenantId],
  );

  const outstandingTotal = canViewReports
    ? await query(
      "SELECT COALESCE(SUM(total_cents - amount_paid_cents),0)::bigint AS c FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial')",
      [tenantId],
    )
    : { rows: [{ c: 0 }] };
  const revenueMtd = canViewReports
    ? await query(
      "SELECT COALESCE(SUM(amount_cents),0)::bigint AS c FROM financial_events WHERE tenant_id=$1 AND event_type='payment' AND created_at >= $2",
      [tenantId, monthStart.toISOString()],
    )
    : { rows: [{ c: 0 }] };
  const subs = canViewReports
    ? await query(
      "SELECT interval, interval_count, price_cents FROM subscriptions WHERE tenant_id=$1 AND status='active'",
      [tenantId],
    )
    : { rows: [] };
  let mrr = 0;
  for (const s of subs.rows) mrr += monthlyCents(s.interval, s.interval_count, s.price_cents);

  res.json({
    ok: true,
    metrics: {
      revenueMtdCents: Number(revenueMtd.rows[0].c),
      outstandingCents: Number(outstandingTotal.rows[0].c),
      mrrCents: mrr,
      arrCents: mrr * 12,
      activeSubs: subs.rows.length,
      todayCount: today.rows.length,
      financialVisible: canViewReports,
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
