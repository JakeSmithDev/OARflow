// Reports SPA view. Date range + report picker, KPI tiles, a lightweight inline
// bar chart (no external lib), a table, and CSV / print-to-PDF export.
const OF = window.OF;

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const state = { key: 'revenue_by_month', from: iso(new Date(today.getFullYear(), today.getMonth() - 5, 1)), to: iso(today), reports: [] };

    function money(c) { return OF.money(c); }
    function fmt(v, type) { return type === 'money' ? money(v) : (type === 'number' ? Number(v).toLocaleString() : OF.escape(String(v ?? ''))); }

    function barChart(report) {
      if (!report.chart || !report.rows.length) return '';
      const { x, y } = report.chart;
      const max = Math.max(1, ...report.rows.map((r) => Number(r[y]) || 0));
      const isMoney = (report.columns.find((c) => c.key === y) || {}).type === 'money';
      const bars = report.rows.map((r) => {
        const v = Number(r[y]) || 0; const h = Math.round((v / max) * 120);
        return `<div class="rep-bar" title="${OF.escape(String(r[x]))}: ${isMoney ? money(v) : v}">
          <div class="rep-bar-fill" style="height:${h}px"></div>
          <div class="rep-bar-lbl">${OF.escape(String(r[x]).replace(/^\d{4}-/, ''))}</div></div>`;
      }).join('');
      return `<div class="card card-pad" style="margin-bottom:16px"><div class="rep-chart">${bars}</div></div>`;
    }

    async function run() {
      const qs = new URLSearchParams({ from: state.from, to: state.to });
      const d = await OF.get(`/api/admin/reports/${state.key}?${qs}`);
      const rep = d.report;
      const head = rep.columns.map((c) => `<th class="${c.type === 'money' || c.type === 'number' ? 'right' : ''}">${OF.escape(c.label)}</th>`).join('');
      const body = rep.rows.map((r) => `<tr>${rep.columns.map((c) => `<td class="${c.type === 'money' || c.type === 'number' ? 'right mono' : ''}">${fmt(r[c.key], c.type)}</td>`).join('')}</tr>`).join('');
      const foot = rep.totals ? `<tfoot><tr>${rep.columns.map((c) => `<td class="${c.type === 'money' || c.type === 'number' ? 'right mono' : ''}"><strong>${fmt(rep.totals[c.key], c.type)}</strong></td>`).join('')}</tr></tfoot>` : '';
      document.getElementById('report').innerHTML = `${barChart(rep)}
        <div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${rep.columns.length}" class="muted center" style="padding:20px">No data for this range.</td></tr>`}</tbody>${foot}</table></div>`;
    }

    async function loadAccounting() {
      const qs = new URLSearchParams({ from: state.from, to: state.to });
      let d; try { d = await OF.get(`/api/admin/accounting?${qs}`); } catch { return; }
      const s = d.summary;
      document.getElementById('accounting').innerHTML = `<div class="card card-pad">
        <div class="row between" style="margin-bottom:10px"><strong>Accounting export</strong><span class="tiny muted">${d.provider.supportsSync ? 'Live sync connected' : 'CSV / QuickBooks (IIF) export'}</span></div>
        <div class="row wrap" style="gap:18px;margin-bottom:12px">
          <div><div class="tiny muted">Invoices</div><div class="mono">${s.counts.invoices} · ${money(s.totals.invoicedCents)}</div></div>
          <div><div class="tiny muted">Payments</div><div class="mono">${s.counts.payments} · ${money(s.totals.collectedCents)}</div></div>
          <div><div class="tiny muted">Refunds</div><div class="mono">${s.counts.refunds} · ${money(s.totals.refundedCents)}</div></div>
        </div>
        <div class="row wrap" style="gap:8px">
          <button class="btn btn-secondary btn-sm" id="acctCsv">Export CSV</button>
          <button class="btn btn-secondary btn-sm" id="acctIif">Export for QuickBooks (.iif)</button>
        </div>
        <p class="tiny muted" style="margin-top:10px">Each row ties back to an OARFlow record; exports are date-filtered by the range above. A live QuickBooks Online sync can be added later without changing this workflow.</p></div>`;
      document.getElementById('acctCsv').onclick = () => window.open(`/api/admin/accounting/export.csv?from=${state.from}&to=${state.to}`, '_blank');
      document.getElementById('acctIif').onclick = () => window.open(`/api/admin/accounting/export.iif?from=${state.from}&to=${state.to}`, '_blank');
    }

    async function loadKpis() {
      const qs = new URLSearchParams({ from: state.from, to: state.to });
      const d = await OF.get(`/api/admin/reports?${qs}`);
      state.reports = d.reports;
      const k = d.kpis;
      document.getElementById('kpis').innerHTML = `<div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="label">Collected</div><div class="value">${money(k.collectedCents)}</div></div>
        <div class="stat"><div class="label">Outstanding</div><div class="value">${money(k.outstandingCents)}</div></div>
        <div class="stat"><div class="label">Jobs completed</div><div class="value">${k.jobs}</div></div>
        <div class="stat"><div class="label">New customers</div><div class="value">${k.newCustomers}</div></div></div>`;
      document.getElementById('picker').innerHTML = state.reports.map((r) => `<button class="chip ${state.key === r.key ? 'active' : ''}" data-k="${r.key}" title="${OF.escape(r.description)}">${OF.escape(r.title)}</button>`).join('');
      document.querySelectorAll('#picker .chip').forEach((b) => b.onclick = () => { state.key = b.dataset.k; document.querySelectorAll('#picker .chip').forEach((x) => x.classList.toggle('active', x === b)); run(); });
    }

    OF.page({ active: 'reports', title: 'Reports', subtitle: 'Revenue, A/R, jobs and recurring — with CSV export', render: async (root, ctx) => {
      ctx.setActions(`<button class="btn btn-secondary btn-sm" id="csvBtn">Export CSV</button><button class="btn btn-ghost btn-sm" id="printBtn">Print / PDF</button>`);
      root.innerHTML = `
        <div class="card card-pad" style="margin-bottom:16px"><div class="row wrap" style="gap:12px;align-items:end">
          <div class="field" style="margin:0"><label>From</label><input type="date" id="from" value="${state.from}"></div>
          <div class="field" style="margin:0"><label>To</label><input type="date" id="to" value="${state.to}"></div>
          <button class="btn btn-primary btn-sm" id="applyBtn">Apply</button>
          <div class="row" style="gap:6px;margin-left:auto">${['30d', '90d', '12m', 'YTD'].map((p) => `<button class="chip" data-range="${p}">${p}</button>`).join('')}</div>
        </div></div>
        <div id="kpis"></div>
        <div class="row wrap" id="picker" style="gap:8px;margin-bottom:16px"></div>
        <div id="report"><div class="loading-page"><span class="spinner"></span></div></div>
        <div id="accounting" style="margin-top:18px"></div>`;

      const apply = async () => { state.from = document.getElementById('from').value; state.to = document.getElementById('to').value; await loadKpis(); await run(); await loadAccounting(); };
      document.getElementById('applyBtn').onclick = apply;
      document.querySelectorAll('[data-range]').forEach((b) => b.onclick = () => {
        const now = new Date(); let from = new Date();
        if (b.dataset.range === '30d') from = new Date(now - 30 * 864e5);
        else if (b.dataset.range === '90d') from = new Date(now - 90 * 864e5);
        else if (b.dataset.range === '12m') from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        else if (b.dataset.range === 'YTD') from = new Date(now.getFullYear(), 0, 1);
        document.getElementById('from').value = iso(from); document.getElementById('to').value = iso(now); apply();
      });
      document.getElementById('csvBtn').onclick = () => { window.open(`/api/admin/reports/${state.key}.csv?from=${state.from}&to=${state.to}`, '_blank'); };
      document.getElementById('printBtn').onclick = () => window.print();

      await loadKpis();
      await run();
    } });
