// Developer view: API keys + outbound webhooks (Zapier/Make) + recent deliveries.
const OF = window.OF;
    let EVENTS = [];

    async function refresh() {
      const d = await OF.get('/api/admin/developer');
      EVENTS = d.events;
      renderSystem();
      renderKeys(d.apiKeys);
      renderHooks(d.endpoints, d.deliveries);
    }

    async function renderSystem() {
      let s; try { s = await OF.get('/api/admin/developer/system'); } catch { return; }
      const pf = s.preflight; const dr = s.drivers;
      const chip = (label, val, ok) => `<span class="badge ${ok ? 'ok' : 'warn'} no-dot" style="margin:0 6px 6px 0">${label}: ${OF.escape(val)}</span>`;
      const items = (arr, color) => arr.map((i) => `<div class="small" style="padding:3px 0"><span style="color:var(--${color})">●</span> ${OF.escape(i.message)} <span class="tiny muted">— ${OF.escape(i.fix)}</span></div>`).join('');
      document.getElementById('system').innerHTML = `<div class="card card-pad" style="margin-bottom:18px;border-left:4px solid var(--${pf.ok ? 'ok' : 'danger'})">
        <div class="row between" style="margin-bottom:8px"><strong>Go-live status</strong>${pf.ok ? '<span class="badge ok no-dot">Ready</span>' : `<span class="badge danger no-dot">${pf.critical.length} blocker${pf.critical.length === 1 ? '' : 's'}</span>`}</div>
        <div class="row wrap">${chip('database', dr.database, dr.database !== 'pglite')}${chip('storage', dr.storage, dr.storage === 's3')}${chip('email', dr.email, dr.email !== 'console')}${chip('jobs', dr.inngest, true)}</div>
        ${pf.critical.length ? `<div style="margin-top:8px">${items(pf.critical, 'danger')}</div>` : ''}
        ${pf.warnings.length ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">${pf.warnings.length} warning(s)</summary>${items(pf.warnings, 'warn')}</details>` : ''}
        <p class="tiny muted" style="margin-top:8px">Run <code>npm run doctor</code> on your server for the full preflight. Each business configures its own Stripe / SMS / email under Settings → Integrations.</p></div>`;
    }

    function renderKeys(keys) {
      document.getElementById('keys').innerHTML = `<div class="row between" style="margin-bottom:10px"><h3 style="margin:0">API keys</h3><button class="btn btn-secondary btn-sm" id="newKey">${OF.icon('plus', 14)} New key</button></div>
        ${keys.length ? keys.map((k) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line-2)"><div><span class="cell-strong">${OF.escape(k.name)}</span> <span class="mono tiny muted">${OF.escape(k.key_prefix)}…</span><div class="tiny muted">${(k.scopes || []).join(', ')}${k.last_used_at ? ` · last used ${OF.date(k.last_used_at)}` : ' · never used'}</div></div><button class="link-btn" data-revoke="${k.id}" style="color:var(--danger)">Revoke</button></div>`).join('') : '<p class="muted small">No API keys yet.</p>'}
        <p class="tiny muted" style="margin-top:10px">Base URL <code>${location.origin}/api/v1</code> · authenticate with <code>Authorization: Bearer &lt;key&gt;</code></p>`;
      document.getElementById('newKey').onclick = keyModal;
      document.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { if (!(await OF.confirm({ title: 'Revoke this key?', body: '<p class="muted">Any integration using it will stop working.</p>', confirmText: 'Revoke', danger: true }))) return; await OF.del('/api/admin/developer/keys/' + b.dataset.revoke); OF.toast('Key revoked', 'ok'); refresh(); });
    }

    function keyModal() {
      const m = OF.modal(`<div class="modal-head"><h3>New API key</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><div class="field"><label>Name</label><input id="k_name" placeholder="e.g. Zapier"></div>
          <label class="row" style="gap:8px"><input type="checkbox" id="k_write" checked style="width:auto"> Allow write (create customers, subscribe webhooks)</label></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="k_save">Create key</button></div>`);
      m.q('#k_save').onclick = async () => {
        const r = await OF.post('/api/admin/developer/keys', { name: m.q('#k_name').value.trim() || 'API key', scopes: m.q('#k_write').checked ? ['read', 'write'] : ['read'] });
        m.close();
        OF.modal(`<div class="modal-head"><h3>Copy your key now</h3><button class="x" data-close>&times;</button></div>
          <div class="modal-body"><p class="muted small">This is the only time the full key is shown.</p><div class="card card-pad mono" style="word-break:break-all;background:var(--surface-2)">${OF.escape(r.key.secret)}</div>
          <button class="btn btn-secondary btn-sm" id="copyKey" style="margin-top:10px">Copy</button></div>
          <div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`).q('#copyKey').onclick = (e) => { navigator.clipboard?.writeText(r.key.secret); e.target.textContent = 'Copied ✓'; };
        refresh();
      };
    }

    function renderHooks(eps, deliveries) {
      document.getElementById('hooks').innerHTML = `<div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Webhook endpoints</h3><button class="btn btn-secondary btn-sm" id="newHook">${OF.icon('plus', 14)} Add endpoint</button></div>
        ${eps.length ? eps.map((e) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line-2)"><div style="min-width:0"><div class="cell-strong" style="word-break:break-all">${OF.escape(e.url)}</div><div class="tiny muted">${(e.events || ['*']).join(', ')}</div></div><button class="link-btn" data-delhook="${e.id}" style="color:var(--danger)">Remove</button></div>`).join('') : '<p class="muted small">No endpoints. Add one to receive events (Zapier/Make catch hook, your server, etc.).</p>'}
        <div class="row between" style="margin:14px 0 8px"><strong class="small">Recent deliveries</strong><button class="btn btn-ghost btn-xs" id="deliverNow">Retry due</button></div>
        ${deliveries.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Event</th><th>Status</th><th>Code</th><th>Attempts</th><th>When</th></tr></thead><tbody>${deliveries.slice(0, 20).map((dv) => `<tr><td>${OF.escape(dv.event)}</td><td>${OF.statusBadge(dv.status === 'delivered' ? 'paid' : dv.status === 'failed' ? 'void' : 'sent')}</td><td class="mono">${dv.response_code || '—'}</td><td>${dv.attempts}</td><td class="tiny muted">${OF.dateTime(dv.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No deliveries yet.</p>'}`;
      document.getElementById('newHook').onclick = hookModal;
      document.getElementById('deliverNow').onclick = async () => { const r = await OF.post('/api/admin/developer/webhooks/deliver'); OF.toast(`Delivered ${r.delivered}/${r.due}`, 'ok'); refresh(); };
      document.querySelectorAll('[data-delhook]').forEach((b) => b.onclick = async () => { if (!(await OF.confirm({ title: 'Remove endpoint?', confirmText: 'Remove', danger: true }))) return; await OF.del('/api/admin/developer/webhooks/' + b.dataset.delhook); OF.toast('Removed', 'ok'); refresh(); });
    }

    function hookModal() {
      const m = OF.modal(`<div class="modal-head"><h3>Add webhook endpoint</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><div class="field"><label>URL</label><input id="h_url" placeholder="https://hooks.zapier.com/…"></div>
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Events</div>
          <label class="row" style="gap:8px;margin-bottom:4px"><input type="checkbox" id="h_all" checked style="width:auto"> All events</label>
          <div id="h_events" class="hidden">${EVENTS.map((e) => `<label class="row" style="gap:8px;margin:3px 0"><input type="checkbox" class="h_ev" value="${e}" style="width:auto"> ${e}</label>`).join('')}</div></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="h_save">Add endpoint</button></div>`);
      m.q('#h_all').onchange = (e) => m.q('#h_events').classList.toggle('hidden', e.target.checked);
      m.q('#h_save').onclick = async () => {
        const url = m.q('#h_url').value.trim(); if (!/^https?:\/\//.test(url)) return OF.toast('Enter a valid URL', 'error');
        const events = m.q('#h_all').checked ? ['*'] : [...m.el.querySelectorAll('.h_ev:checked')].map((x) => x.value);
        const r = await OF.post('/api/admin/developer/webhooks', { url, events });
        m.close();
        OF.modal(`<div class="modal-head"><h3>Signing secret</h3><button class="x" data-close>&times;</button></div><div class="modal-body"><p class="muted small">Verify deliveries with the <code>X-OARFlow-Signature</code> header (HMAC-SHA256). Shown once:</p><div class="card card-pad mono" style="word-break:break-all;background:var(--surface-2)">${OF.escape(r.endpoint.secret)}</div></div><div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`);
        refresh();
      };
    }

    OF.page({ active: 'developer', title: 'Developer', subtitle: 'API keys, webhooks & Zapier', render: async (root) => {
      root.innerHTML = '<div id="system"></div><div id="keys" class="card card-pad" style="margin-bottom:18px"></div><div id="hooks" class="card card-pad"></div>';
      await refresh();
    } });
