// Admin home: operational queue plus date-scoped business analytics. Charts are
// native SVG/CSS so the dashboard does not need a client-side chart dependency.
const OF = window.OF;

const today = new Date();
const iso = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: OF.tenant.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const utcYmd = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const shiftYmd = (ymd, days) => {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcYmd(date);
};
const monthStartYmd = (base, monthsBack) => {
  const [year, month] = iso(base).split('-').map(Number);
  return utcYmd(new Date(Date.UTC(year, month - 1 - monthsBack, 1)));
};

function presetDates(key) {
  const to = iso(new Date());
  if (key === '30d') return { from: shiftYmd(to, -29), to };
  if (key === '90d') return { from: shiftYmd(to, -89), to };
  if (key === '12m') return { from: monthStartYmd(new Date(), 11), to };
  if (key === 'ytd') return { from: `${to.slice(0, 4)}-01-01`, to };
  return { from: monthStartYmd(new Date(), 5), to };
}

const initialRange = presetDates('6m');
const state = { preset: '6m', from: initialRange.from, to: initialRange.to };

const STATUS_META = {
  requested: { label: 'Requested', color: '#d97706' },
  scheduled: { label: 'Scheduled', color: '#2563eb' },
  completed: { label: 'Completed', color: '#16a34a' },
  canceled: { label: 'Canceled', color: '#dc2626' },
  no_show: { label: 'No show', color: '#7c3aed' },
  draft: { label: 'Draft', color: '#64748b' },
  sent: { label: 'Sent', color: '#2563eb' },
  accepted: { label: 'Accepted', color: '#16a34a' },
  converted: { label: 'Converted', color: '#0e7c4b' },
  declined: { label: 'Declined', color: '#dc2626' },
  expired: { label: 'Expired', color: '#d97706' },
};

function metaFor(status) {
  return STATUS_META[status] || {
    label: String(status || 'Other').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    color: '#94a3b8',
  };
}

function stat(label, value, icon, sub) {
  return `<div class="stat"><div class="row between"><span class="label">${OF.escape(label)}</span><span class="ic">${OF.icon(icon, 16)}</span></div>
    <div class="value mono">${value}</div>${sub ? `<div class="small muted dashboard-stat-sub">${sub}</div>` : ''}</div>`;
}

function apptRow(a) {
  const addr = a.service_address ? `<div class="tiny muted">${OF.icon('pin', 12)} ${OF.escape(a.service_address)}</div>` : '';
  const color = OF.color(a.service_color);
  return `<tr class="clickable" onclick="OF.go('/admin/appointments?id=${a.id}')">
    <td class="nowrap"><span class="cell-strong">${OF.time(a.scheduled_start)}</span></td>
    <td><div class="cell-strong">${OF.escape(a.customer_name)}</div>${addr}</td>
    <td>${a.service_name ? `<span class="badge no-dot" style="background:${color}1a;color:${color}">${OF.escape(a.service_name)}</span>` : '—'}</td>
    <td class="right">${OF.statusBadge(a.status)}</td></tr>`;
}

function compactMoney(cents) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: OF.tenant.currency || 'USD', notation: 'compact', maximumFractionDigits: 1,
    }).format((Number(cents) || 0) / 100);
  } catch { return OF.money(cents); }
}

function compactNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function bucketLabel(bucket, grain, includeYear = false) {
  const date = new Date(`${bucket}T12:00:00.000Z`);
  if (grain === 'month') return new Intl.DateTimeFormat('en-US', { month: 'short', year: includeYear ? '2-digit' : undefined, timeZone: 'UTC' }).format(date);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function lineChart(rows, series, { grain = 'day', money = false, emptyText = 'No activity in this range.' } = {}) {
  const hasData = rows.some((row) => series.some((item) => Number(row[item.key]) !== 0));
  if (!hasData) return `<div class="dashboard-chart-empty">${OF.icon('reports', 24)}<span>${OF.escape(emptyText)}</span></div>`;

  const width = 720; const height = 236;
  const pad = { left: 66, right: 18, top: 16, bottom: 42 };
  const plotW = width - pad.left - pad.right; const plotH = height - pad.top - pad.bottom;
  const values = rows.flatMap((row) => series.map((item) => Math.max(0, Number(row[item.key]) || 0)));
  const max = Math.max(1, ...values);
  const x = (i) => pad.left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (value) => pad.top + plotH - (Math.max(0, Number(value) || 0) / max) * plotH;
  const fmt = money ? compactMoney : compactNumber;

  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max * (4 - i) / 4; const py = pad.top + (plotH * i / 4);
    return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}" class="dashboard-gridline"/>
      <text x="${pad.left - 10}" y="${py + 4}" text-anchor="end" class="dashboard-axis">${OF.escape(fmt(value))}</text>`;
  }).join('');

  const primaryPoints = rows.map((row, i) => `${x(i)},${y(row[series[0].key])}`).join(' ');
  const area = `<polygon points="${pad.left},${pad.top + plotH} ${primaryPoints} ${width - pad.right},${pad.top + plotH}" fill="${series[0].color}" opacity=".09"/>`;
  const lines = series.map((item) => {
    const points = rows.map((row, i) => `${x(i)},${y(row[item.key])}`).join(' ');
    const dots = rows.length <= 32 ? rows.map((row, i) => `<circle cx="${x(i)}" cy="${y(row[item.key])}" r="2.7" fill="${item.color}"><title>${OF.escape(`${bucketLabel(row.bucket, grain, true)} · ${item.label}: ${money ? OF.money(row[item.key]) : Number(row[item.key]).toLocaleString()}`)}</title></circle>`).join('') : '';
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const labelIndexes = new Set([0, rows.length - 1]);
  const step = Math.max(1, Math.ceil((rows.length - 1) / 5));
  for (let i = 0; i < rows.length; i += step) labelIndexes.add(i);
  const multipleYears = rows[0]?.bucket.slice(0, 4) !== rows.at(-1)?.bucket.slice(0, 4);
  const labels = [...labelIndexes].filter((i) => i >= 0).sort((a, b) => a - b).map((i) =>
    `<text x="${x(i)}" y="${height - 13}" text-anchor="middle" class="dashboard-axis">${OF.escape(bucketLabel(rows[i].bucket, grain, multipleYears))}</text>`).join('');

  return `<svg class="dashboard-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${OF.escape(series.map((item) => item.label).join(' and '))} trend">
    ${grid}${area}${lines}${labels}</svg>`;
}

function chartCard(title, subtitle, rows, series, options) {
  const legend = series.map((item) => `<span><i style="background:${item.color}"></i>${OF.escape(item.label)}</span>`).join('');
  return `<div class="card dashboard-chart-card">
    <div class="card-head dashboard-card-head"><div><h3>${OF.escape(title)}</h3><div class="tiny muted">${OF.escape(subtitle)}</div></div><div class="dashboard-legend">${legend}</div></div>
    <div class="card-pad dashboard-chart-pad">${lineChart(rows, series, options)}</div>
  </div>`;
}

function donut(items, centerValue, centerLabel) {
  const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
  if (!total) return `<div class="dashboard-mix-empty">No data in this range.</div>`;
  let cursor = 0;
  const stops = items.filter((item) => item.value).map((item) => {
    const start = cursor; cursor += Number(item.value) / total * 100;
    return `${item.color} ${start}% ${cursor}%`;
  }).join(',');
  const legend = items.filter((item) => item.value).map((item) => {
    const pct = Math.round(Number(item.value) / total * 100);
    return `<div class="dashboard-mix-row"><span><i style="background:${item.color}"></i>${OF.escape(item.label)}</span><strong class="mono">${Number(item.value).toLocaleString()} <small>${pct}%</small></strong>${item.detail ? `<em>${item.detail}</em>` : ''}</div>`;
  }).join('');
  return `<div class="dashboard-donut-wrap">
    <div class="dashboard-donut" style="background:conic-gradient(${stops})" role="img" aria-label="${OF.escape(items.map((item) => `${item.label}: ${item.value}`).join(', '))}">
      <div><strong class="mono">${centerValue}</strong><span>${OF.escape(centerLabel)}</span></div>
    </div><div class="dashboard-mix-legend">${legend}</div>
  </div>`;
}

function mixCard(title, subtitle, body, href) {
  return `<div class="card dashboard-mix-card"><div class="card-head dashboard-card-head"><div><h3>${OF.escape(title)}</h3><div class="tiny muted">${OF.escape(subtitle)}</div></div>${href ? `<div class="actions"><a class="link-btn" href="${href}">View →</a></div>` : ''}</div><div class="card-pad">${body}</div></div>`;
}

function jobMixCard(analytics) {
  const order = ['completed', 'scheduled', 'requested', 'canceled', 'no_show'];
  const byStatus = new Map(analytics.jobStatus.map((row) => [row.status, row.count]));
  const unknown = analytics.jobStatus.filter((row) => !order.includes(row.status));
  const items = order.filter((status) => byStatus.has(status)).map((status) => ({ ...metaFor(status), value: byStatus.get(status) }));
  items.push(...unknown.map((row) => ({ ...metaFor(row.status), value: row.count })));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return mixCard('Jobs by status', 'Scheduled activity in the selected range', donut(items, total.toLocaleString(), 'jobs'), '/admin/appointments');
}

function agingCard(financial) {
  const meta = [
    ['current', 'Current', '#16a34a'], ['1_30', '1–30 days', '#eab308'], ['31_60', '31–60 days', '#f97316'],
    ['61_90', '61–90 days', '#ef4444'], ['90_plus', '90+ days', '#991b1b'],
  ];
  const byBucket = new Map(financial.invoiceAging.map((row) => [row.bucket, row]));
  const rows = meta.map(([key, label, color]) => ({ key, label, color, ...(byBucket.get(key) || { count: 0, balanceCents: 0 }) }));
  const max = Math.max(1, ...rows.map((row) => row.balanceCents));
  const body = rows.some((row) => row.balanceCents) ? `<div class="dashboard-aging">
    ${rows.map((row) => `<div class="dashboard-aging-row"><div class="row between"><span>${OF.escape(row.label)} <small>${row.count}</small></span><strong class="mono">${OF.money(row.balanceCents)}</strong></div><div class="dashboard-aging-track"><i style="width:${Math.max(row.balanceCents ? 4 : 0, row.balanceCents / max * 100)}%;background:${row.color}"></i></div></div>`).join('')}
    <div class="dashboard-aging-total"><span>Outstanding</span><strong class="mono">${OF.money(financial.outstandingCents)}</strong></div></div>` : '<div class="dashboard-mix-empty">No open invoice balances. Nice work.</div>';
  return mixCard('Invoice aging', 'Current accounts receivable', body, '/admin/invoices');
}

function estimateCard(estimates) {
  const order = ['draft', 'sent', 'accepted', 'converted', 'declined', 'expired'];
  const byStatus = new Map(estimates.mix.map((row) => [row.status, row]));
  const items = order.filter((status) => byStatus.has(status)).map((status) => {
    const row = byStatus.get(status); return { ...metaFor(status), value: row.count, detail: OF.money(row.valueCents) };
  });
  const unknown = estimates.mix.filter((row) => !order.includes(row.status));
  items.push(...unknown.map((row) => ({ ...metaFor(row.status), value: row.count, detail: OF.money(row.valueCents) })));
  const won = estimates.mix.filter((row) => ['accepted', 'converted'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
  const decided = won + estimates.mix.filter((row) => ['declined', 'expired'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
  const rate = decided ? Math.round(won / decided * 100) : 0;
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return mixCard('Estimates', decided ? `${rate}% win rate on decided estimates` : 'Quote pipeline in the selected range', donut(items, total.toLocaleString(), 'estimates'), '/admin/estimates');
}

function dashboardStyles() {
  return `<style>
    .dashboard-range { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:18px; }
    .dashboard-range-copy strong { display:block; font-size:15px; }
    .dashboard-range-fields { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .dashboard-range-fields select { width:170px; }
    .dashboard-range-fields input { width:142px; }
    .dashboard-range-sep { color:var(--muted-2); }
    .dashboard-kpis { grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); margin-bottom:18px; }
    .dashboard-kpis .stat { min-width:0; }
    .dashboard-kpis .stat .value { font-size:25px; }
    .dashboard-stat-sub { margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .dashboard-chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,430px),1fr)); gap:18px; margin-bottom:18px; }
    .dashboard-mix-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,285px),1fr)); gap:18px; margin-bottom:22px; }
    .dashboard-card-head { align-items:flex-start; flex-wrap:wrap; }
    .dashboard-card-head > div:first-child { min-width:150px; }
    .dashboard-chart-pad { padding:12px 18px 14px; }
    .dashboard-line-chart { display:block; width:100%; height:auto; min-height:190px; overflow:visible; }
    .dashboard-gridline { stroke:var(--line-2); stroke-width:1; }
    .dashboard-axis { fill:var(--muted); font:11px var(--font); }
    .dashboard-legend { display:flex; align-items:center; gap:12px; margin-left:auto; flex-wrap:wrap; }
    .dashboard-legend span { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:11px; font-weight:600; }
    .dashboard-legend i, .dashboard-mix-row i { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
    .dashboard-chart-empty { min-height:205px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--muted); font-size:13px; }
    .dashboard-donut-wrap { display:grid; grid-template-columns:116px minmax(0,1fr); align-items:center; gap:18px; min-height:148px; }
    .dashboard-donut { width:116px; aspect-ratio:1; border-radius:50%; display:grid; place-items:center; position:relative; }
    .dashboard-donut::after { content:''; position:absolute; inset:22px; border-radius:50%; background:var(--surface); }
    .dashboard-donut > div { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; line-height:1.1; }
    .dashboard-donut strong { font-size:20px; }
    .dashboard-donut span { margin-top:4px; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
    .dashboard-mix-legend { min-width:0; }
    .dashboard-mix-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 8px; align-items:center; padding:4px 0; }
    .dashboard-mix-row > span { min-width:0; display:flex; align-items:center; gap:7px; color:var(--ink-2); font-size:12px; }
    .dashboard-mix-row strong { font-size:12px; }
    .dashboard-mix-row strong small { color:var(--muted); font-weight:500; }
    .dashboard-mix-row em { grid-column:2; color:var(--muted); font-size:10px; font-style:normal; text-align:right; }
    .dashboard-mix-empty { min-height:148px; display:grid; place-items:center; text-align:center; color:var(--muted); font-size:13px; }
    .dashboard-aging-row { margin-bottom:10px; }
    .dashboard-aging-row .row { font-size:12px; }
    .dashboard-aging-row small { color:var(--muted); }
    .dashboard-aging-track { height:6px; border-radius:999px; overflow:hidden; background:var(--surface-2); margin-top:4px; }
    .dashboard-aging-track i { display:block; height:100%; border-radius:inherit; }
    .dashboard-aging-total { display:flex; align-items:center; justify-content:space-between; padding-top:10px; margin-top:3px; border-top:1px solid var(--line-2); font-size:13px; }
    .dashboard-section-title { display:flex; align-items:baseline; justify-content:space-between; margin:4px 0 12px; }
    .dashboard-section-title h2 { font-size:16px; }
    @media (max-width:760px) {
      .dashboard-range { align-items:stretch; flex-direction:column; }
      .dashboard-range-fields { display:grid; grid-template-columns:1fr 1fr; }
      .dashboard-range-fields select { grid-column:1/-1; width:100%; }
      .dashboard-range-fields input { width:100%; }
      .dashboard-range-sep { display:none; }
      .dashboard-range-fields button { grid-column:1/-1; }
    }
    @media (max-width:430px) { .dashboard-donut-wrap { grid-template-columns:96px minmax(0,1fr); gap:12px; } .dashboard-donut { width:96px; } }
  </style>`;
}

function rangeToolbar(range) {
  return `<div class="card card-pad dashboard-range">
    <div class="dashboard-range-copy"><strong>Performance overview</strong><span class="small muted">Charts use your ${OF.escape(OF.tenant.timezone)} business dates.</span></div>
    <div class="dashboard-range-fields">
      <select id="dashboardPreset" aria-label="Dashboard date range">
        <option value="30d"${state.preset === '30d' ? ' selected' : ''}>Last 30 days</option>
        <option value="90d"${state.preset === '90d' ? ' selected' : ''}>Last 90 days</option>
        <option value="6m"${state.preset === '6m' ? ' selected' : ''}>Last 6 months</option>
        <option value="12m"${state.preset === '12m' ? ' selected' : ''}>Last 12 months</option>
        <option value="ytd"${state.preset === 'ytd' ? ' selected' : ''}>Year to date</option>
        <option value="custom"${state.preset === 'custom' ? ' selected' : ''}>Custom range</option>
      </select>
      <input type="date" id="dashboardFrom" aria-label="Dashboard start date" value="${OF.escape(range.from)}">
      <span class="dashboard-range-sep">—</span>
      <input type="date" id="dashboardTo" aria-label="Dashboard end date" value="${OF.escape(range.to)}">
      <button class="btn btn-primary btn-sm" id="dashboardApply">Apply</button>
    </div></div>`;
}

function renderDashboard(root, d) {
  const m = d.metrics; const a = d.analytics; const financial = a.financial;
  const rangeText = `${OF.dateLong(`${a.range.from}T12:00:00Z`)} – ${OF.dateLong(`${a.range.to}T12:00:00Z`)}`;
  const tileList = [];
  if (financial.visible) {
    tileList.push(stat('Collected', OF.money(financial.collectedCents), 'money', `${OF.money(financial.refundedCents)} refunded · ${rangeText}`));
    tileList.push(stat('Invoiced', OF.money(financial.invoicedCents), 'invoices', `${financial.invoiceCount.toLocaleString()} invoice(s) · ${rangeText}`));
    tileList.push(stat('Outstanding', OF.money(financial.outstandingCents), 'invoices', `${financial.openInvoiceCount.toLocaleString()} open balance(s)`));
    tileList.push(stat('Recurring / mo', OF.money(m.mrrCents), 'recurring', `${OF.money(m.arrCents)} ARR · ${m.activeSubs} active`));
  }
  tileList.push(stat('Jobs booked', a.jobs.bookedCount.toLocaleString(), 'schedule', `${OF.money(a.jobs.bookedValueCents)} booked value`));
  tileList.push(stat('Jobs completed', a.jobs.completedCount.toLocaleString(), 'check', `${OF.money(a.jobs.completedValueCents)} completed value`));
  tileList.push(stat('New customers', a.jobs.newCustomers.toLocaleString(), 'customers', rangeText));
  tileList.push(stat("Today's jobs", m.todayCount.toLocaleString(), 'schedule', `${d.upcoming.length} more this week`));
  const tiles = `<div class="grid dashboard-kpis">${tileList.join('')}</div>`;

  const chartCards = [];
  if (financial.visible) chartCards.push(chartCard('Revenue trend', rangeText, financial.revenueTrend, [
    { key: 'collected', label: 'Collected', color: '#0e7c4b' }, { key: 'invoiced', label: 'Invoiced', color: '#60a5fa' },
  ], { grain: a.range.grain, money: true, emptyText: 'No payments or invoices in this range.' }));
  chartCards.push(chartCard('Job activity', rangeText, a.appointmentTrend, [
    { key: 'booked', label: 'Booked', color: '#2563eb' }, { key: 'completed', label: 'Completed', color: '#16a34a' }, { key: 'canceled', label: 'Canceled', color: '#ef4444' },
  ], { grain: a.range.grain, money: false, emptyText: 'No job activity in this range.' }));
  const charts = `<div class="dashboard-chart-grid">${chartCards.join('')}</div>`;

  const mixCards = [jobMixCard(a)];
  if (financial.visible) mixCards.push(agingCard(financial));
  if (a.estimates.visible) mixCards.push(estimateCard(a.estimates));
  const mixes = `<div class="dashboard-mix-grid">${mixCards.join('')}</div>`;

  const todayCard = `<div class="card">
    <div class="card-head"><h3>Today's schedule</h3><div class="actions"><a class="link-btn" href="/admin/schedule">Open schedule →</a></div></div>
    ${d.today.length ? `<div class="table-wrap"><table class="tbl"><tbody>${d.today.map(apptRow).join('')}</tbody></table></div>`
      : `<div class="empty"><div class="ic">${OF.icon('schedule', 22)}</div><p>No appointments scheduled today.</p></div>`}
  </div>`;

  const upcomingCard = d.upcoming.length ? `<div class="card">
    <div class="card-head"><h3>Upcoming this week</h3></div>
    <div class="table-wrap"><table class="tbl"><tbody>${d.upcoming.map((appt) => `
      <tr class="clickable" onclick="OF.go('/admin/appointments?id=${appt.id}')">
        <td class="nowrap"><span class="cell-strong">${OF.date(appt.scheduled_start)}</span><div class="tiny muted">${OF.time(appt.scheduled_start)}</div></td>
        <td><div class="cell-strong">${OF.escape(appt.customer_name)}</div></td>
        <td>${appt.service_name ? OF.escape(appt.service_name) : '—'}</td>
        <td class="right">${OF.money(appt.price_cents)}</td></tr>`).join('')}</tbody></table></div></div>` : '';

  const requestsCard = `<div class="card">
    <div class="card-head"><h3>Pending requests</h3>${d.requests.length ? `<span class="badge warn no-dot">${d.requests.length}</span>` : ''}<div class="actions"><a class="link-btn" href="/admin/requests">View all →</a></div></div>
    ${d.requests.length ? d.requests.map((appt) => `
      <div class="card-pad" style="border-bottom:1px solid var(--line-2);cursor:pointer" onclick="OF.go('/admin/requests?id=${appt.id}')">
        <div class="row between"><span class="cell-strong">${OF.escape(appt.customer_name)}</span>${OF.statusBadge('requested')}</div>
        <div class="small muted" style="margin-top:3px">${appt.service_name ? OF.escape(appt.service_name) : ''} · ${(appt.requested_slots || []).length} proposed time(s)</div>
      </div>`).join('') : `<div class="empty"><div class="ic">${OF.icon('check', 22)}</div><p>No pending requests.</p></div>`}
  </div>`;

  const outstandingCard = financial.visible ? `<div class="card">
    <div class="card-head"><h3>Outstanding balances</h3><div class="actions"><a class="link-btn" href="/admin/invoices">All invoices →</a></div></div>
    ${d.outstanding.length ? `<div class="table-wrap"><table class="tbl"><tbody>${d.outstanding.map((invoice) => `
      <tr class="clickable" onclick="OF.go('/admin/invoices?id=${invoice.id}')">
        <td><span class="cell-strong">${OF.escape(invoice.customer_name)}</span><div class="tiny muted">${OF.escape(invoice.number)}</div></td>
        <td class="right"><span class="cell-strong">${OF.money(invoice.total_cents - invoice.amount_paid_cents)}</span><div class="tiny">${OF.statusBadge(invoice.status)}</div></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><div class="ic">${OF.icon('money', 22)}</div><p>Nothing outstanding. 🎉</p></div>`}
  </div>` : '';

  const followupsCard = `<div class="card">
    <div class="card-head"><h3>Follow-ups due</h3><div class="actions"><a class="link-btn" href="/admin/follow-ups">Queue →</a></div></div>
    ${d.followups.length ? d.followups.map((followup) => `
      <div class="card-pad" style="border-bottom:1px solid var(--line-2)">
        <div class="row between"><span class="cell-strong">${OF.escape(followup.title)}</span><span class="tiny muted">${OF.date(followup.due_at)}</span></div>
        <div class="small muted" style="margin-top:2px">${OF.escape(followup.customer_name || '')} · ${followup.channel === 'email' ? 'Email' : 'Task'}</div>
      </div>`).join('') : `<div class="empty"><div class="ic">${OF.icon('followups', 22)}</div><p>No follow-ups due.</p></div>`}
  </div>`;

  root.innerHTML = dashboardStyles() + rangeToolbar(a.range) + tiles + charts + mixes +
    '<div class="dashboard-section-title"><h2>Today & upcoming</h2><span class="small muted">Your live operations queue</span></div>' +
    `<div class="grid" style="grid-template-columns:1.55fr 1fr;align-items:start"><div class="stack">${todayCard}${upcomingCard}</div><div class="stack">${requestsCard}${outstandingCard}${followupsCard}</div></div>`;
}

function bindRange(root) {
  const preset = root.querySelector('#dashboardPreset');
  const from = root.querySelector('#dashboardFrom');
  const to = root.querySelector('#dashboardTo');
  const apply = root.querySelector('#dashboardApply');
  const reload = async () => {
    if (!state.from || !state.to) return OF.toast('Choose both dashboard dates.', 'error');
    apply.disabled = true; apply.textContent = 'Loading…';
    try { await loadDashboard(root); } catch (err) { OF.toast(err.message, 'error'); apply.disabled = false; apply.textContent = 'Apply'; }
  };
  preset.onchange = async () => {
    state.preset = preset.value;
    if (state.preset === 'custom') return;
    Object.assign(state, presetDates(state.preset));
    await reload();
  };
  const custom = () => { state.preset = 'custom'; state.from = from.value; state.to = to.value; preset.value = 'custom'; };
  from.onchange = custom; to.onchange = custom;
  apply.onclick = async () => { state.from = from.value; state.to = to.value; await reload(); };
}

async function loadDashboard(root) {
  const qs = new URLSearchParams({ from: state.from, to: state.to });
  const d = await OF.get(`/api/admin/dashboard?${qs}`);
  if (!root.isConnected) return;
  state.from = d.analytics.range.from; state.to = d.analytics.range.to;
  renderDashboard(root, d);
  bindRange(root);
}

OF.page({
  active: 'dashboard', title: 'Dashboard',
  subtitle: new Intl.DateTimeFormat('en-US', { timeZone: OF.tenant.timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()),
  render: async (root, ctx) => {
    ctx.setActions(`${OF.hasCap('reports.view') ? `<a class="btn btn-secondary btn-sm" href="/admin/reports">${OF.icon('reports', 15)} Reports</a>` : ''}
      <a class="btn btn-secondary btn-sm" href="/book" target="_blank">${OF.icon('cal', 15)} View booking page</a>
      <a class="btn btn-primary btn-sm" href="/admin/appointments?new=1">${OF.icon('plus', 15)} New appointment</a>`);
    root.innerHTML = '<div class="loading-page"><span class="spinner"></span></div>';
    await loadDashboard(root);
  },
});
