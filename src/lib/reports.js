// Reporting v1. Each report is tenant-scoped and (where time-based) bounded by a
// {from,to} date range. Returns { columns, rows, totals } so the same shape can
// drive both the on-screen table and the CSV export. Money stays in integer
// cents; the column `type:'money'` tells the UI/CSV how to format.
import { query, queryOne } from './db.js';

function range(opts = {}) {
  const to = opts.to || new Date().toISOString().slice(0, 10);
  const from = opts.from || new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  return { from, to };
}

export const REPORTS = {
  revenue_by_month: {
    title: 'Revenue by month',
    description: 'Payments collected, refunds, and net — grouped by month.',
    timeBound: true,
    async run(tenant, opts) {
      const { from, to } = range(opts);
      const r = await query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                COALESCE(SUM(CASE WHEN event_type='payment' THEN amount_cents ELSE 0 END),0)::bigint AS payments,
                COALESCE(SUM(CASE WHEN event_type='refund'  THEN amount_cents ELSE 0 END),0)::bigint AS refunds,
                COALESCE(SUM(amount_cents),0)::bigint AS net
           FROM financial_events
          WHERE tenant_id=$1 AND created_at >= $2::date AND created_at < ($3::date + INTERVAL '1 day')
          GROUP BY 1 ORDER BY 1`,
        [tenant.id, from, to],
      );
      const rows = r.rows.map((x) => ({ month: x.month, payments: Number(x.payments), refunds: Number(x.refunds), net: Number(x.net) }));
      const totals = { month: 'Total', payments: rows.reduce((s, x) => s + x.payments, 0), refunds: rows.reduce((s, x) => s + x.refunds, 0), net: rows.reduce((s, x) => s + x.net, 0) };
      return {
        columns: [{ key: 'month', label: 'Month' }, { key: 'payments', label: 'Payments', type: 'money' }, { key: 'refunds', label: 'Refunds', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }],
        rows, totals, chart: { x: 'month', y: 'net' },
      };
    },
  },

  sales_by_service: {
    title: 'Sales by service',
    description: 'Completed jobs and revenue by service type.',
    timeBound: true,
    async run(tenant, opts) {
      const { from, to } = range(opts);
      const r = await query(
        `SELECT COALESCE(s.name,'(unspecified)') AS service,
                COUNT(*)::int AS jobs,
                COALESCE(SUM(a.price_cents),0)::bigint AS revenue
           FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id
          WHERE a.tenant_id=$1 AND a.status='completed'
            AND COALESCE(a.scheduled_start, a.created_at) >= $2::date
            AND COALESCE(a.scheduled_start, a.created_at) < ($3::date + INTERVAL '1 day')
          GROUP BY 1 ORDER BY revenue DESC`,
        [tenant.id, from, to],
      );
      const rows = r.rows.map((x) => ({ service: x.service, jobs: x.jobs, revenue: Number(x.revenue) }));
      const totals = { service: 'Total', jobs: rows.reduce((s, x) => s + x.jobs, 0), revenue: rows.reduce((s, x) => s + x.revenue, 0) };
      return {
        columns: [{ key: 'service', label: 'Service' }, { key: 'jobs', label: 'Jobs', type: 'number' }, { key: 'revenue', label: 'Revenue', type: 'money' }],
        rows, totals, chart: { x: 'service', y: 'revenue' },
      };
    },
  },

  ar_aging: {
    title: 'A/R aging',
    description: 'Outstanding invoice balances bucketed by age.',
    timeBound: false,
    async run(tenant) {
      const r = await query(
        `WITH open_inv AS (
           SELECT (total_cents-amount_paid_cents) AS bal,
                  GREATEST(0, (CURRENT_DATE - COALESCE(due_date, sent_at::date, created_at::date))) AS age_days
             FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial') AND total_cents>amount_paid_cents)
         SELECT bucket, COUNT(*)::int AS invoices, COALESCE(SUM(bal),0)::bigint AS outstanding FROM (
           SELECT bal, CASE
             WHEN age_days <= 0 THEN 'Current'
             WHEN age_days <= 30 THEN '1–30 days'
             WHEN age_days <= 60 THEN '31–60 days'
             WHEN age_days <= 90 THEN '61–90 days'
             ELSE '90+ days' END AS bucket FROM open_inv) t
         GROUP BY bucket`,
        [tenant.id],
      );
      const order = ['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'];
      const byBucket = Object.fromEntries(r.rows.map((x) => [x.bucket, x]));
      const rows = order.map((b) => ({ bucket: b, invoices: byBucket[b]?.invoices || 0, outstanding: Number(byBucket[b]?.outstanding || 0) }));
      const totals = { bucket: 'Total', invoices: rows.reduce((s, x) => s + x.invoices, 0), outstanding: rows.reduce((s, x) => s + x.outstanding, 0) };
      return {
        columns: [{ key: 'bucket', label: 'Age' }, { key: 'invoices', label: 'Invoices', type: 'number' }, { key: 'outstanding', label: 'Outstanding', type: 'money' }],
        rows, totals, chart: { x: 'bucket', y: 'outstanding' },
      };
    },
  },

  top_customers: {
    title: 'Top customers',
    description: 'Customers ranked by lifetime payments.',
    timeBound: false,
    async run(tenant) {
      const r = await query(
        `SELECT c.name,
                (SELECT COUNT(*) FROM appointments a WHERE a.customer_id=c.id)::int AS jobs,
                COALESCE((SELECT SUM(amount_cents) FROM financial_events fe WHERE fe.customer_id=c.id AND fe.event_type='payment'),0)::bigint AS lifetime,
                COALESCE((SELECT SUM(total_cents-amount_paid_cents) FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('sent','partial')),0)::bigint AS open_balance
           FROM customers c WHERE c.tenant_id=$1
          ORDER BY lifetime DESC LIMIT 25`,
        [tenant.id],
      );
      const rows = r.rows.map((x) => ({ name: x.name, jobs: x.jobs, lifetime: Number(x.lifetime), open_balance: Number(x.open_balance) }));
      const totals = { name: 'Total', jobs: rows.reduce((s, x) => s + x.jobs, 0), lifetime: rows.reduce((s, x) => s + x.lifetime, 0), open_balance: rows.reduce((s, x) => s + x.open_balance, 0) };
      return {
        columns: [{ key: 'name', label: 'Customer' }, { key: 'jobs', label: 'Jobs', type: 'number' }, { key: 'lifetime', label: 'Lifetime', type: 'money' }, { key: 'open_balance', label: 'Open balance', type: 'money' }],
        rows, totals,
      };
    },
  },

  new_customers_by_month: {
    title: 'New customers by month',
    description: 'Customer acquisition over time.',
    timeBound: true,
    async run(tenant, opts) {
      const { from, to } = range(opts);
      const r = await query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS new_customers
           FROM customers WHERE tenant_id=$1 AND created_at >= $2::date AND created_at < ($3::date + INTERVAL '1 day')
          GROUP BY 1 ORDER BY 1`,
        [tenant.id, from, to],
      );
      const rows = r.rows.map((x) => ({ month: x.month, new_customers: x.new_customers }));
      const totals = { month: 'Total', new_customers: rows.reduce((s, x) => s + x.new_customers, 0) };
      return { columns: [{ key: 'month', label: 'Month' }, { key: 'new_customers', label: 'New customers', type: 'number' }], rows, totals, chart: { x: 'month', y: 'new_customers' } };
    },
  },

  appointments_by_month: {
    title: 'Appointments by month',
    description: 'Booked, completed, and canceled jobs by month.',
    timeBound: true,
    async run(tenant, opts) {
      const { from, to } = range(opts);
      const r = await query(
        `SELECT to_char(date_trunc('month', COALESCE(scheduled_start, created_at)), 'YYYY-MM') AS month,
                COUNT(*)::int AS booked,
                COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                COUNT(*) FILTER (WHERE status='canceled')::int AS canceled
           FROM appointments WHERE tenant_id=$1
             AND COALESCE(scheduled_start, created_at) >= $2::date
             AND COALESCE(scheduled_start, created_at) < ($3::date + INTERVAL '1 day')
          GROUP BY 1 ORDER BY 1`,
        [tenant.id, from, to],
      );
      const rows = r.rows.map((x) => ({ month: x.month, booked: x.booked, completed: x.completed, canceled: x.canceled }));
      const totals = { month: 'Total', booked: rows.reduce((s, x) => s + x.booked, 0), completed: rows.reduce((s, x) => s + x.completed, 0), canceled: rows.reduce((s, x) => s + x.canceled, 0) };
      return { columns: [{ key: 'month', label: 'Month' }, { key: 'booked', label: 'Booked', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' }, { key: 'canceled', label: 'Canceled', type: 'number' }], rows, totals, chart: { x: 'month', y: 'booked' } };
    },
  },

  recurring_snapshot: {
    title: 'Recurring revenue',
    description: 'Active subscriptions and normalized MRR by interval.',
    timeBound: false,
    async run(tenant) {
      const r = await query(
        `SELECT interval, COUNT(*)::int AS active,
                COALESCE(SUM(price_cents),0)::bigint AS billed_per_cycle
           FROM subscriptions WHERE tenant_id=$1 AND status='active' GROUP BY interval`,
        [tenant.id],
      );
      const mrrFactor = { monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, annual: 1 / 12, custom: 1 };
      const rows = r.rows.map((x) => ({ interval: x.interval, active: x.active, billed_per_cycle: Number(x.billed_per_cycle), mrr: Math.round(Number(x.billed_per_cycle) * (mrrFactor[x.interval] ?? 1)) }));
      const totals = { interval: 'Total', active: rows.reduce((s, x) => s + x.active, 0), billed_per_cycle: rows.reduce((s, x) => s + x.billed_per_cycle, 0), mrr: rows.reduce((s, x) => s + x.mrr, 0) };
      return { columns: [{ key: 'interval', label: 'Interval' }, { key: 'active', label: 'Active', type: 'number' }, { key: 'billed_per_cycle', label: 'Billed / cycle', type: 'money' }, { key: 'mrr', label: 'MRR', type: 'money' }], rows, totals, chart: { x: 'interval', y: 'mrr' } };
    },
  },
};

export function listReports() {
  return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description, timeBound: Boolean(r.timeBound) }));
}

export async function runReport(tenant, key, opts) {
  const def = REPORTS[key];
  if (!def) return null;
  const out = await def.run(tenant, opts || {});
  return { key, title: def.title, ...out };
}

/** A few headline KPIs for the top of the Reports page. */
export async function reportKpis(tenant, opts) {
  const { from, to } = range(opts);
  const k = await queryOne(
    `SELECT
       COALESCE((SELECT SUM(amount_cents) FROM financial_events WHERE tenant_id=$1 AND event_type='payment' AND created_at >= $2::date AND created_at < ($3::date + INTERVAL '1 day')),0)::bigint AS collected,
       COALESCE((SELECT SUM(total_cents-amount_paid_cents) FROM invoices WHERE tenant_id=$1 AND status IN ('sent','partial')),0)::bigint AS outstanding,
       COALESCE((SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND status='completed' AND COALESCE(scheduled_start,created_at) >= $2::date AND COALESCE(scheduled_start,created_at) < ($3::date + INTERVAL '1 day')),0)::int AS jobs,
       COALESCE((SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND created_at >= $2::date AND created_at < ($3::date + INTERVAL '1 day')),0)::int AS new_customers`,
    [tenant.id, from, to],
  );
  return { collectedCents: Number(k.collected), outstandingCents: Number(k.outstanding), jobs: k.jobs, newCustomers: k.new_customers, from, to };
}

export default { REPORTS, listReports, runReport, reportKpis };
