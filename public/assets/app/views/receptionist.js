// AI receptionist (SCAFFOLD) view: status, settings, call logs + transcripts,
// and a mock call simulator. No live telephony is wired yet.
const OF = window.OF;

    const intentBadge = (i) => { const t = (i && i.type) || 'unknown'; const c = { book: 'ok', reschedule: 'info', question: 'purple', message: 'warn', unknown: '' }[t] || ''; return `<span class="badge ${c} no-dot">${t}</span>`; };

    async function refresh() {
      const d = await OF.get('/api/admin/voice');
      const s = d.status;
      document.getElementById('status').innerHTML = `<div class="card card-pad" style="margin-bottom:18px;border-left:4px solid var(--warn)">
        <div class="row between"><strong>AI receptionist — scaffold</strong><span class="badge warn no-dot">Not live</span></div>
        <p class="muted small" style="margin:8px 0 0">The data model, webhooks, missed-call workflow and handoff rules are in place. Connect a voice provider (Vapi, Retell, or Twilio) to go live. Use “Simulate a call” to see the pipeline end-to-end.</p></div>`;

      const v = d.settings;
      document.getElementById('settings').innerHTML = `<div class="card card-pad" style="margin-bottom:18px">
        <h3 style="margin:0 0 10px">Receptionist settings</h3>
        <div class="grid cols-2"><div class="field"><label>Provider</label><select id="v_provider">${['none', 'vapi', 'retell', 'twilio'].map((p) => `<option ${v.provider === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
          <div class="field"><label>Forward / transfer to</label><input id="v_transfer" value="${OF.escape((v.handoff && v.handoff.transferTo) || '')}" placeholder="(410) 555-0100"></div></div>
        <div class="field"><label>Greeting</label><textarea id="v_greeting">${OF.escape(v.greeting || '')}</textarea></div>
        <div class="field"><label>Missed-call text-back</label><input id="v_missed" value="${OF.escape((v.missedCall && v.missedCall.message) || '')}"></div>
        <div class="row wrap" style="gap:14px;margin:6px 0">
          <label class="row" style="gap:8px"><input type="checkbox" id="v_enabled" ${v.enabled ? 'checked' : ''} style="width:auto"> Enabled</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="v_textback" ${v.missedCall && v.missedCall.textBack ? 'checked' : ''} style="width:auto"> Text back missed calls</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="v_urgent" ${v.handoff && v.handoff.onUrgent ? 'checked' : ''} style="width:auto"> Transfer urgent calls</label>
        </div>
        <button class="btn btn-primary btn-sm" id="v_save">Save settings</button>
        <span class="tiny muted" style="margin-left:10px">${v.hasCredentials ? 'Provider credentials on file (encrypted).' : 'No provider credentials yet.'}</span></div>`;
      document.getElementById('v_save').onclick = async () => {
        await OF.put('/api/admin/voice/settings', {
          provider: OF.val('v_provider'), enabled: document.getElementById('v_enabled').checked, greeting: OF.val('v_greeting'),
          handoff: { transferTo: OF.val('v_transfer'), onUrgent: document.getElementById('v_urgent').checked, onRequest: true },
          missedCall: { message: OF.val('v_missed'), textBack: document.getElementById('v_textback').checked, createFollowUp: true },
        });
        OF.toast('Receptionist settings saved', 'ok');
      };

      const rows = d.calls;
      document.getElementById('calls').innerHTML = `<div class="card card-pad"><div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Recent calls</h3>
        <div class="row" style="gap:6px"><button class="btn btn-secondary btn-xs" data-sim="booking">Simulate booking</button><button class="btn btn-secondary btn-xs" data-sim="missed">Missed</button><button class="btn btn-secondary btn-xs" data-sim="transfer">Urgent</button></div></div>
        ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>From</th><th>Status</th><th>Intent</th><th>Handoff</th><th>When</th></tr></thead>
        <tbody>${rows.map((c) => `<tr class="clickable" data-id="${c.id}"><td class="mono">${OF.escape(c.from_number || '—')}</td><td>${OF.statusBadge(c.status)}</td><td>${intentBadge(c.intent)}</td><td>${c.handoff ? `<span class="badge danger no-dot">${OF.escape(c.handoff_reason || 'yes')}</span>` : '—'}</td><td class="tiny muted">${OF.dateTime(c.started_at)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">No calls yet. Simulate one to see the pipeline.</p>'}</div>`;
      document.querySelectorAll('[data-sim]').forEach((b) => b.onclick = async () => { b.disabled = true; const r = await OF.post('/api/admin/voice/simulate', { scenario: b.dataset.sim }); OF.toast(`Simulated ${b.dataset.sim} call${r.missed && r.missed.texted ? ' · texted back' : ''}`, 'ok'); refresh(); });
      document.querySelectorAll('#calls tr[data-id]').forEach((r) => r.onclick = () => callModal(r.dataset.id));
    }

    async function callModal(id) {
      const { call } = await OF.get('/api/admin/voice/calls/' + id);
      const i = call.intent || {};
      OF.modal(`<div class="modal-head"><h3>Call from ${OF.escape(call.from_number || 'unknown')}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="row between" style="margin-bottom:10px">${OF.statusBadge(call.status)}<span class="muted small">${OF.dateTime(call.started_at)}${call.duration_seconds ? ` · ${call.duration_seconds}s` : ''}</span></div>
          ${call.handoff ? `<div class="card card-pad" style="background:var(--danger-tint);margin-bottom:10px"><strong>Handed off to a person</strong><div class="tiny muted">${OF.escape(call.handoff_reason || '')}</div></div>` : ''}
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Booking intent</div>
          <div class="card card-pad" style="margin-bottom:12px"><div class="small"><b>Type:</b> ${OF.escape(i.type || 'unknown')} · <b>Urgency:</b> ${OF.escape(i.urgency || 'normal')}</div>
            ${i.serviceRequested ? `<div class="small"><b>Service:</b> ${OF.escape(i.serviceRequested)}</div>` : ''}
            ${i.preferredTimes && i.preferredTimes.length ? `<div class="small"><b>Preferred:</b> ${OF.escape(i.preferredTimes.join(', '))}</div>` : ''}
            ${i.customerName ? `<div class="small"><b>Caller:</b> ${OF.escape(i.customerName)}</div>` : ''}</div>
          ${call.transcript ? `<div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Transcript</div><div class="card card-pad small" style="white-space:pre-wrap">${OF.escape(call.transcript)}</div>` : '<p class="muted small">No transcript.</p>'}
        </div>
        <div class="modal-foot">${i.type === 'book' ? `<a class="btn btn-primary" href="/admin/appointments?new=1${i.customerName ? `&name=${encodeURIComponent(i.customerName)}` : ''}">Create appointment</a>` : ''}<button class="btn btn-secondary" data-close>Close</button></div>`, { wide: true });
    }

    OF.page({ active: 'receptionist', title: 'Receptionist', subtitle: 'AI call handling — scaffold (not live)', render: async (root) => {
      root.innerHTML = '<div id="status"></div><div id="settings"></div><div id="calls"></div>';
      await refresh();
    } });
