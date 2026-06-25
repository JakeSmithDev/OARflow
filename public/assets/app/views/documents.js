// Documents SPA view: template library + sending documents for e-signature.
const OF = window.OF;

    let MERGE = [];
    const state = { tab: 'sent', status: 'all' };

    async function refresh() {
      if (state.tab === 'sent') return refreshSent();
      return refreshTemplates();
    }

    async function refreshSent() {
      const d = await OF.get('/api/admin/documents?status=' + state.status);
      const rows = d.documents;
      document.getElementById('body').innerHTML = `
        <div class="row wrap" id="chips" style="gap:8px;margin-bottom:14px">${['all', 'draft', 'sent', 'signed', 'declined'].map((k) => `<button class="chip ${state.status === k ? 'active' : ''}" data-s="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Document</th><th>Customer</th><th>Status</th><th>Signed by</th><th>When</th></tr></thead>
        <tbody>${rows.map((d2) => `<tr class="clickable" data-id="${d2.id}"><td class="cell-strong">${OF.escape(d2.title)}</td><td>${OF.escape(d2.customer_name)}</td><td>${OF.statusBadge(d2.status)}</td><td>${d2.signed_name ? OF.escape(d2.signed_name) : '<span class="muted">—</span>'}</td><td class="tiny muted">${OF.date(d2.signed_at || d2.sent_at || d2.created_at)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('documents', 22)}</div><p>No documents yet. Send a service agreement or contract for signature.</p></div>`}`;
      document.querySelectorAll('#chips .chip').forEach((b) => b.onclick = () => { state.status = b.dataset.s; refreshSent(); });
      document.querySelectorAll('#body tr[data-id]').forEach((r) => r.onclick = () => openDoc(r.dataset.id));
    }

    async function refreshTemplates() {
      const d = await OF.get('/api/admin/documents/templates?all=1');
      const rows = d.templates;
      document.getElementById('body').innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Template</th><th>Signature</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows.map((t) => `<tr class="clickable" data-id="${t.id}"><td class="cell-strong">${OF.escape(t.name)}</td><td>${t.requires_signature ? 'Required' : 'Acknowledge'}</td><td>${t.is_active ? '<span class="badge ok no-dot">Active</span>' : '<span class="muted">Off</span>'}</td><td></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('documents', 22)}</div><p>No templates yet.</p><button class="btn btn-secondary btn-sm" id="starter" style="margin-top:8px">Load a starter service agreement</button></div>`;
      document.querySelectorAll('#body tr[data-id]').forEach((r) => r.onclick = () => templateModal(r.dataset.id));
      const st = document.getElementById('starter');
      if (st) st.onclick = async () => {
        await OF.post('/api/admin/documents/templates', { name: 'Service Agreement', requiresSignature: true, body: `SERVICE AGREEMENT\n\nThis agreement is between {{COMPANY_NAME}} and {{CUSTOMER_NAME}} ({{CUSTOMER_ADDRESS}}).\n\nService: {{SERVICE_NAME}}\nDate: {{APPOINTMENT_DATE}}\n\n1. {{COMPANY_NAME}} will perform the pest control services described above in a professional manner.\n2. The customer agrees to provide safe access to the property.\n3. Payment is due upon receipt of invoice.\n4. Either party may cancel a recurring plan with reasonable notice.\n\nSigned: {{CUSTOMER_NAME}}\nDate: {{TODAY}}` });
        OF.toast('Starter template added', 'ok'); refreshTemplates();
      };
    }

    async function openDoc(id) {
      const d = await OF.get('/api/admin/documents/' + id);
      const doc = d.document;
      const dr = OF.drawer(`<div class="modal-head"><h3>${OF.escape(doc.title)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="row between" style="margin-bottom:12px">${OF.statusBadge(doc.status)}<span class="muted">${OF.escape(doc.customer_name)}</span></div>
          <div class="card card-pad" style="margin-bottom:14px;white-space:pre-wrap;max-height:320px;overflow:auto">${OF.escape(doc.body)}</div>
          ${doc.status === 'signed' ? `<div class="card card-pad" style="background:var(--ok-tint);margin-bottom:14px"><strong>Signed by ${OF.escape(doc.signed_name || '')}</strong><div class="tiny muted">${OF.dateTime(doc.signed_at)}${doc.signed_ip ? ` · IP ${OF.escape(doc.signed_ip)}` : ''}</div>${d.signatureUrl ? `<img src="${d.signatureUrl}" alt="signature" style="max-height:90px;margin-top:8px;background:#fff;border-radius:8px;padding:4px">` : ''}</div>` : ''}
          <div class="row wrap" style="gap:8px">
            ${doc.status !== 'signed' ? `<button class="btn btn-primary btn-sm" id="sendDoc">${OF.icon('send', 15)} ${doc.sent_at ? 'Resend' : 'Send'} for signature</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="copyDoc">Copy sign link</button>
          </div>
          ${d.signUrl ? `<div class="small muted" style="word-break:break-all;margin-top:10px">Sign link: ${OF.escape(d.signUrl)}</div>` : ''}
        </div>`, { wide: true });
      dr.q('#sendDoc')?.addEventListener('click', async () => { try { const r = await OF.post(`/api/admin/documents/${id}/send`); OF.toast(r.emailed ? 'Sent ✓' : 'Marked sent (email not configured)', 'ok'); dr.close(); refreshSent(); } catch (e) { OF.toast(e.message, 'error'); } });
      dr.q('#copyDoc')?.addEventListener('click', () => { navigator.clipboard?.writeText(d.signUrl); OF.toast('Sign link copied', 'ok'); });
    }

    async function templateModal(id) {
      const t = id ? (await OF.get('/api/admin/documents/templates/' + id)).template : { name: '', body: '', requires_signature: true, is_active: true };
      const m = OF.modal(`<div class="modal-head"><h3>${id ? 'Edit template' : 'New template'}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="max-height:74vh;overflow:auto">
          <div class="field"><label>Name</label><input id="t_name" value="${OF.escape(t.name)}"></div>
          <div class="field"><label>Body</label><textarea id="t_body" rows="12" style="font-family:var(--font-mono,monospace);font-size:13px">${OF.escape(t.body || '')}</textarea></div>
          <p class="tiny muted">Merge fields: ${MERGE.map((f) => `<code>{{${f}}}</code>`).join(' ')}</p>
          <label class="row" style="gap:8px;margin-top:6px"><input type="checkbox" id="t_sig" ${t.requires_signature ? 'checked' : ''} style="width:auto"> Requires signature</label>
          ${id ? `<label class="row" style="gap:8px;margin-top:6px"><input type="checkbox" id="t_active" ${t.is_active ? 'checked' : ''} style="width:auto"> Active</label>` : ''}
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="t_save">Save</button></div>`, { wide: true });
      m.q('#t_save').onclick = async () => {
        const body = { name: m.q('#t_name').value.trim(), body: m.q('#t_body').value, requiresSignature: m.q('#t_sig').checked };
        if (id && m.q('#t_active')) body.isActive = m.q('#t_active').checked;
        if (!body.name) return OF.toast('Name required', 'error');
        try { if (id) await OF.patch('/api/admin/documents/templates/' + id, body); else await OF.post('/api/admin/documents/templates', body); OF.toast('Saved', 'ok'); m.close(); refreshTemplates(); } catch (e) { OF.toast(e.message, 'error'); }
      };
    }

    async function sendModal() {
      const tpls = (await OF.get('/api/admin/documents/templates')).templates;
      let cust = { id: null, name: '' };
      const m = OF.modal(`<div class="modal-head"><h3>Send a document</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Customer *</label><input id="s_cust" placeholder="Search customer…" autocomplete="off"><div id="s_results" class="card" style="display:none;position:relative;z-index:5"></div></div>
          <div class="field"><label>Template *</label><select id="s_tpl">${tpls.length ? tpls.map((t) => `<option value="${t.id}">${OF.escape(t.name)}</option>`).join('') : '<option value="">— create a template first —</option>'}</select></div>
          <div class="field"><label>Title (optional)</label><input id="s_title" placeholder="Defaults to template name"></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-secondary" id="s_create">Create draft</button><button class="btn btn-primary" id="s_send">Create &amp; send</button></div>`);
      const ci = m.q('#s_cust'); const cr = m.q('#s_results');
      ci.addEventListener('input', OF.debounce(async () => { const q = ci.value.trim(); if (q.length < 2) { cr.style.display = 'none'; return; } const dd = await OF.get('/api/admin/customers?q=' + encodeURIComponent(q)); cr.innerHTML = dd.customers.slice(0, 6).map((c) => `<div class="card-pad" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line-2)" data-id="${c.id}" data-name="${OF.escape(c.name)}">${OF.escape(c.name)}</div>`).join('') || '<div class="card-pad small muted">No matches</div>'; cr.style.display = 'block'; cr.querySelectorAll('[data-id]').forEach((x) => x.onclick = () => { cust = { id: +x.dataset.id, name: x.dataset.name }; ci.value = cust.name; cr.style.display = 'none'; }); }, 250));
      async function go(send) {
        if (!cust.id) return OF.toast('Select a customer', 'error');
        const templateId = +m.q('#s_tpl').value; if (!templateId) return OF.toast('Create a template first', 'error');
        try { const r = await OF.post('/api/admin/documents', { customerId: cust.id, templateId, title: m.q('#s_title').value.trim() || undefined }); if (send) await OF.post(`/api/admin/documents/${r.document.id}/send`); OF.toast(send ? 'Document sent' : 'Draft created', 'ok'); m.close(); state.tab = 'sent'; renderTabs(); refreshSent(); } catch (e) { OF.toast(e.message, 'error'); }
      }
      m.q('#s_create').onclick = () => go(false);
      m.q('#s_send').onclick = () => go(true);
    }

    function renderTabs() {
      document.getElementById('tabs').innerHTML = ['sent', 'templates'].map((t) => `<button class="${state.tab === t ? 'active' : ''}" data-t="${t}">${t === 'sent' ? 'Documents' : 'Templates'}</button>`).join('');
      document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => { state.tab = b.dataset.t; renderTabs(); refresh(); });
    }

    OF.page({ active: 'documents', title: 'Documents', subtitle: 'Agreements & forms — sent for e-signature', render: async (root, ctx) => {
      MERGE = (await OF.get('/api/admin/documents/meta')).mergeFields;
      ctx.setActions(`<button class="btn btn-secondary btn-sm" id="newTpl">${OF.icon('plus', 15)} Template</button><button class="btn btn-primary btn-sm" id="sendBtn">${OF.icon('send', 15)} Send document</button>`);
      root.innerHTML = `<div class="tabbar" id="tabs"></div><div id="body"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('sendBtn').onclick = sendModal;
      document.getElementById('newTpl').onclick = () => templateModal(null);
      renderTabs(); await refresh();
    } });
