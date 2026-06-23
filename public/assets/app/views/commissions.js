// Commissions view: rules, accrued entries, per-tech summary, mark paid, CSV.
const OF = window.OF;
    let TECHS = []; let SERVICES = [];
    const state = { status: 'all', technicianId: '' };

    async function refresh() {
      const p = new URLSearchParams(); if (state.status !== 'all') p.set('status', state.status); if (state.technicianId) p.set('technicianId', state.technicianId);
      const d = await OF.get('/api/admin/commissions?' + p);
      renderSummary(d.summary);
      renderRules(d.rules);
      renderEntries(d.entries);
    }

    function renderSummary(summary) {
      document.getElementById('summary').innerHTML = summary.length ? `<div class="grid cols-3" style="margin-bottom:18px">${summary.map((s) => `<div class="stat"><div class="label">${OF.escape(s.technicianName)}</div><div class="value" style="font-size:20px">${OF.money(s.accruedCents)}</div><div class="tiny muted">unpaid · ${OF.money(s.paidCents)} paid</div>${s.accruedCents > 0 ? `<button class="btn btn-secondary btn-xs" data-paytech="${s.technicianId}" style="margin-top:8px">Mark paid</button>` : ''}</div>`).join('')}</div>` : '';
      document.querySelectorAll('[data-paytech]').forEach((b) => b.onclick = async () => { if (!(await OF.confirm({ title: 'Mark all accrued as paid?', confirmText: 'Mark paid' }))) return; await OF.post('/api/admin/commissions/pay', { technicianId: +b.dataset.paytech }); OF.toast('Marked paid', 'ok'); refresh(); });
    }

    function renderRules(rules) {
      document.getElementById('rules').innerHTML = `<div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Commission rules</h3><button class="btn btn-secondary btn-sm" id="addRule">${OF.icon('plus', 14)} Add rule</button></div>
        ${rules.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Applies to</th><th>Basis</th><th class="right">Rate</th><th>Active</th></tr></thead>
        <tbody>${rules.map((r) => `<tr class="clickable" data-id="${r.id}"><td class="cell-strong">${OF.escape(r.name)}</td><td>${OF.escape(r.technician_name || 'All techs')}${r.service_name ? ` · ${OF.escape(r.service_name)}` : ''}</td><td>${OF.escape(r.basis)}</td><td class="right mono">${r.basis === 'flat' ? OF.money(r.flat_cents) : r.percent + '%'}</td><td>${r.is_active ? '<span class="badge ok no-dot">Active</span>' : '<span class="muted">Off</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No rules yet. Add one to start accruing commissions on completed jobs.</p>'}`;
      document.getElementById('addRule').onclick = () => ruleModal(null);
      document.querySelectorAll('#rules tr[data-id]').forEach((row) => row.onclick = () => ruleModal(row.dataset.id, rules.find((x) => String(x.id) === row.dataset.id)));
    }

    function renderEntries(entries) {
      document.getElementById('entries').innerHTML = `<div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Accrued commissions</h3>
        <div class="row" style="gap:8px"><select id="f_status"><option value="all">All</option><option value="accrued" ${state.status === 'accrued' ? 'selected' : ''}>Unpaid</option><option value="paid" ${state.status === 'paid' ? 'selected' : ''}>Paid</option></select><button class="btn btn-secondary btn-sm" id="csv">Export CSV</button></div></div>
        ${entries.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Technician</th><th>Basis</th><th class="right">On</th><th class="right">Commission</th><th>Status</th></tr></thead>
        <tbody>${entries.map((e) => `<tr><td class="tiny muted">${OF.date(e.accrued_at)}</td><td>${OF.escape(e.technician_name)}</td><td>${OF.escape(e.basis)}</td><td class="right mono">${OF.money(e.basis_cents)}</td><td class="right mono">${OF.money(e.amount_cents)}</td><td>${OF.statusBadge(e.status === 'paid' ? 'paid' : 'sent')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No commissions accrued yet.</p>'}`;
      document.getElementById('f_status').onchange = (e) => { state.status = e.target.value; refresh(); };
      document.getElementById('csv').onclick = () => window.open(`/api/admin/commissions/export.csv?status=${state.status}`, '_blank');
    }

    function ruleModal(id, r = {}) {
      const m = OF.modal(`<div class="modal-head"><h3>${id ? 'Edit' : 'Add'} commission rule</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Name *</label><input id="r_name" value="${OF.escape(r.name || '')}"></div>
          <div class="grid cols-2"><div class="field"><label>Technician</label><select id="r_tech"><option value="">All technicians</option>${TECHS.map((t) => `<option value="${t.id}" ${r.technician_id === t.id ? 'selected' : ''}>${OF.escape(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Service</label><select id="r_svc"><option value="">All services</option>${SERVICES.map((s) => `<option value="${s.id}" ${r.service_type_id === s.id ? 'selected' : ''}>${OF.escape(s.name)}</option>`).join('')}</select></div></div>
          <div class="grid cols-3"><div class="field"><label>Basis</label><select id="r_basis"><option value="revenue" ${r.basis === 'revenue' ? 'selected' : ''}>Revenue (job price)</option><option value="collected" ${r.basis === 'collected' ? 'selected' : ''}>Collected (invoice paid)</option><option value="flat" ${r.basis === 'flat' ? 'selected' : ''}>Flat per job</option></select></div>
          <div class="field"><label>Percent</label><input id="r_pct" type="number" step="0.1" value="${r.percent || 0}"></div>
          <div class="field"><label>Flat ($)</label><input id="r_flat" type="number" step="0.01" value="${((r.flat_cents || 0) / 100).toFixed(2)}"></div></div>
          ${id ? `<label class="row" style="gap:8px"><input type="checkbox" id="r_active" ${r.is_active ? 'checked' : ''} style="width:auto"> Active</label>` : ''}
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="r_save">Save</button></div>`);
      m.q('#r_save').onclick = async () => {
        const body = { name: m.q('#r_name').value.trim(), technicianId: +m.q('#r_tech').value || null, serviceTypeId: +m.q('#r_svc').value || null, basis: m.q('#r_basis').value, percent: +m.q('#r_pct').value || 0, flatCents: Math.round((+m.q('#r_flat').value || 0) * 100) };
        if (id && m.q('#r_active')) body.isActive = m.q('#r_active').checked;
        if (!body.name) return OF.toast('Name required', 'error');
        try { if (id) await OF.patch('/api/admin/commissions/rules/' + id, body); else await OF.post('/api/admin/commissions/rules', body); OF.toast('Saved', 'ok'); m.close(); refresh(); } catch (e) { OF.toast(e.message, 'error'); }
      };
    }

    OF.page({ active: 'commissions', title: 'Commissions', subtitle: 'Rules, accruals & payouts', render: async (root) => {
      [TECHS, SERVICES] = await Promise.all([OF.get('/api/admin/technicians?all=1').then((d) => d.technicians), OF.get('/api/admin/appointments/meta/services').then((d) => d.services)]);
      root.innerHTML = '<div id="summary"></div><div id="rules" class="card card-pad" style="margin-bottom:18px"></div><div id="entries" class="card card-pad"></div>';
      await refresh();
    } });
