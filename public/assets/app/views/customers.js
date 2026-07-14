// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let activeRoot = null;
    const state = { q: '', limit: OF.listLimit, rows: [], total: 0 };
    function inRoot(root, selector) {
      return root && root === activeRoot && root.isConnected ? root.querySelector(selector) : null;
    }
    function params(offset = 0) {
      const p = new URLSearchParams({ limit: state.limit, offset });
      if (state.q) p.set('q', state.q);
      return p;
    }
    function downloadName(res, fallback) {
      const header = res.headers.get('content-disposition') || '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
      if (encoded) { try { return decodeURIComponent(encoded); } catch { /* use the ordinary filename */ } }
      return /filename="([^"]+)"/i.exec(header)?.[1] || fallback;
    }
    async function downloadCustomerDocument(customerId, payload, button) {
      const original = button?.innerHTML;
      if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span> Building PDF…'; }
      try {
        const res = await fetch(`/api/admin/documents/customer/${customerId}/generate`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (res.status === 401) {
          location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search);
          return false;
        }
        if (!res.ok) {
          let data = null; try { data = await res.json(); } catch { /* PDF endpoints normally return JSON only on errors */ }
          throw new Error(data?.error || `Could not build the PDF (${res.status}).`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = downloadName(res, payload.type === 'wdii' ? 'WDII Inspection Report.pdf' : 'Pest Control Service Agreement.pdf');
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        OF.toast('PDF ready to download', 'ok');
        return true;
      } catch (error) {
        OF.toast(error.message || 'Could not build the PDF.', 'error');
        return false;
      } finally {
        if (button) { button.disabled = false; button.innerHTML = original; }
      }
    }
    function serviceAgreementModal(customer, subscriptions = []) {
      const active = subscriptions.find((sub) => sub.status === 'active' && ['monthly', 'quarterly'].includes(sub.interval))
        || subscriptions.find((sub) => sub.status === 'active');
      const startingFrequency = ['monthly', 'quarterly'].includes(active?.interval) ? active.interval : 'monthly';
      const startingServiceFee = Number.isFinite(Number(active?.price_cents)) ? Number(active.price_cents) / 100 : 100;
      const startingNotes = active?.notes || customer.notes || '';
      const m = OF.modal(`<div class="modal-head customer-doc-modal-head"><div><span class="customer-doc-kicker">Autofill document</span><h3>Pest Control Service Agreement</h3><p>${OF.escape(customer.name)} · ${OF.escape(OF.serviceAddress(customer))}</p></div><button class="x" data-close>&times;</button></div>
        <div class="modal-body customer-doc-form">
          <div class="field"><label>Service frequency</label><div class="doc-frequency" role="radiogroup" aria-label="Service frequency">
            <label><input type="radio" name="doc_frequency" value="monthly" ${startingFrequency === 'monthly' ? 'checked' : ''}><span>Monthly<small>12 visits / year</small></span></label>
            <label><input type="radio" name="doc_frequency" value="quarterly" ${startingFrequency === 'quarterly' ? 'checked' : ''}><span>Quarterly<small>4 visits / year</small></span></label>
          </div></div>
          <div class="grid cols-2">
            <div class="field"><label for="doc_initial_fee">Initial service fee</label><div class="money-input"><span>$</span><input id="doc_initial_fee" type="number" min="0" max="100000" step="0.01" value="0.00"></div></div>
            <div class="field"><label for="doc_service_fee">Cost per service</label><div class="money-input"><span>$</span><input id="doc_service_fee" type="number" min="0" max="100000" step="0.01" value="${startingServiceFee.toFixed(2)}"></div></div>
          </div>
          <div class="doc-total-preview"><span>12-month agreement total</span><strong id="doc_total">${OF.money(Math.round(startingServiceFee * (startingFrequency === 'monthly' ? 12 : 4) * 100))}</strong></div>
          <div class="field"><label for="doc_pests">Initially covered pests</label><input id="doc_pests" maxlength="300" value="Rodents, Roaches and General Pest"></div>
          <div class="field"><div class="row between"><label for="doc_notes">Additional comments / service notes</label><span class="tiny muted" id="doc_notes_count">${String(startingNotes).slice(0, 500).length}/500</span></div><textarea id="doc_notes" maxlength="500" rows="4" placeholder="Exterior-only service, bait station locations, exclusions, access notes…">${OF.escape(String(startingNotes).slice(0, 500))}</textarea><span class="hint">Customer or plan notes are prefilled. Edit them before generating if needed.</span></div>
          <div class="doc-autofill-note">${OF.icon('documents',16)} Customer contact information, service address, company details, agreement date and term language will be filled automatically.</div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="doc_generate">${OF.icon('documents',16)} Generate PDF</button></div>`, { wide:true });
      m.el.querySelector('.modal')?.classList.add('customer-doc-modal');
      const frequency = () => m.el.querySelector('input[name="doc_frequency"]:checked')?.value || 'monthly';
      const dollars = (selector) => Number(m.q(selector).value);
      const updateTotal = () => {
        const initial = dollars('#doc_initial_fee'); const service = dollars('#doc_service_fee');
        const visits = frequency() === 'quarterly' ? 4 : 12;
        m.q('#doc_total').textContent = OF.money(Math.round(((Number.isFinite(initial) ? initial : 0) + (Number.isFinite(service) ? service : 0) * visits) * 100));
      };
      m.el.querySelectorAll('input[name="doc_frequency"]').forEach((input) => input.addEventListener('change', updateTotal));
      ['#doc_initial_fee', '#doc_service_fee'].forEach((selector) => m.q(selector).addEventListener('input', updateTotal));
      m.q('#doc_notes').addEventListener('input', (event) => { m.q('#doc_notes_count').textContent = `${event.target.value.length}/500`; });
      m.q('#doc_generate').onclick = async () => {
        const initial = dollars('#doc_initial_fee'); const service = dollars('#doc_service_fee');
        if (![initial, service].every((value) => Number.isFinite(value) && value >= 0 && value <= 100000)) return OF.toast('Enter valid service prices.', 'error');
        const coveredPests = m.q('#doc_pests').value.trim();
        if (!coveredPests) return OF.toast('List the pests covered by this agreement.', 'error');
        const ok = await downloadCustomerDocument(customer.id, {
          type: 'service_agreement', frequency: frequency(), notes: m.q('#doc_notes').value.trim(), coveredPests,
          initialServiceFeeCents: Math.round(initial * 100), serviceFeeCents: Math.round(service * 100),
        }, m.q('#doc_generate'));
        if (ok) m.close();
      };
    }
    async function refresh(root, { append = false } = {}) {
      const offset = append ? state.rows.length : 0;
      const d = await OF.get('/api/admin/customers?' + params(offset));
      state.rows = append ? state.rows.concat(d.customers || []) : (d.customers || []);
      state.total = d.total || state.rows.length;
      const list = inRoot(root, '#list');
      if (!list) return;
      list.innerHTML = state.rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Customer</th><th>Contact</th><th class="right">Visits</th><th class="right">Lifetime</th><th class="right">Balance</th></tr></thead>
        <tbody>${state.rows.map(c=>`<tr class="clickable" data-id="${c.id}">
          <td><div class="row" style="gap:10px"><span class="avatar-sm">${OF.initials(c.name)}</span><div><div class="cell-strong">${OF.escape(c.name)}</div><div class="tiny muted">${OF.escape([c.city,c.state].filter(Boolean).join(', '))}</div></div></div></td>
          <td><div class="small">${OF.escape(c.email||'')}</div><div class="tiny muted">${OF.escape(c.phone||'')}</div></td>
          <td class="right mono">${c.appt_count}</td>
          <td class="right mono">${OF.money(c.ltv_cents)}</td>
          <td class="right">${Number(c.balance_cents)>0?`<span class="badge warn no-dot">${OF.money(c.balance_cents)}</span>`:'<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>${OF.listFooter({ shown: state.rows.length, total: state.total, label: 'customers' })}`
        : `<div class="empty"><div class="ic">${OF.icon('customers',22)}</div><p>No customers yet.</p></div>${OF.listFooter({ shown: 0, total: state.total, label: 'customers' })}`;
      list.querySelectorAll('tr[data-id]').forEach(r=>r.onclick=()=>openDrawer(root, r.dataset.id));
      list.querySelector('[data-load-more]')?.addEventListener('click', () => refresh(root, { append: true }));
    }

    async function openDrawer(root, id) {
      window.__custId = id;
      const d = await OF.get('/api/admin/customers/'+id);
      const c = d.customer;
      const canPayments = OF.hasCap('payments.manage');
      const canDocuments = OF.hasCap('documents.manage');
      const dr = OF.drawer(`
        <div class="modal-head"><h3>${OF.escape(c.name)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="grid cols-2" style="margin-bottom:16px">
            <div class="stat"><div class="label">Lifetime value</div><div class="value" style="font-size:22px">${OF.money(d.ltvCents)}</div></div>
            <div class="stat"><div class="label">Open balance</div><div class="value" style="font-size:22px">${OF.money(d.balanceCents)}</div></div>
          </div>
          <div class="row wrap" style="gap:8px;margin-bottom:16px">
            <a class="btn btn-primary btn-sm" href="/admin/appointments?new=1&customer=${c.id}">${OF.icon('plus',15)} Appointment</a>
            <a class="btn btn-secondary btn-sm" href="/admin/invoices?new=1&customer=${c.id}">${OF.icon('invoices',15)} Invoice</a>
            <a class="btn btn-secondary btn-sm" href="/admin/plans?enroll=${c.id}">${OF.icon('recurring',15)} Enroll plan</a>
            <button class="btn btn-ghost btn-sm" id="portalBtn">Portal link</button>
            <button class="btn btn-ghost btn-sm" id="editBtn">Edit</button>
          </div>
          <div id="editForm" class="hidden card card-pad" style="margin-bottom:16px">
            <div class="field"><label>Name</label><input id="e_name" value="${OF.escape(c.name)}"></div>
            <div class="grid cols-2"><div class="field"><label>Email</label><input id="e_email" value="${OF.escape(c.email||'')}"></div><div class="field"><label>Phone</label><input id="e_phone" value="${OF.escape(c.phone||'')}"></div></div>
            <div class="field"><label for="e_addr">Service address *</label><input id="e_addr" value="${OF.escape(c.address||'')}" required autocomplete="street-address" aria-describedby="e_addr_hint"><span class="hint" id="e_addr_hint">A customer must keep a street service address.</span></div>
            <div class="grid cols-3"><div class="field"><label>City</label><input id="e_city" value="${OF.escape(c.city||'')}"></div><div class="field"><label>State</label><input id="e_state" value="${OF.escape(c.state||'')}"></div><div class="field"><label>ZIP</label><input id="e_zip" value="${OF.escape(c.postal_code||'')}"></div></div>
            <div class="field"><label>Notes</label><textarea id="e_notes">${OF.escape(c.notes||'')}</textarea></div>
            <button class="btn btn-primary btn-sm" id="saveCust">Save</button>
          </div>
          <div class="card card-pad stack" style="gap:6px;margin-bottom:16px">
            ${c.email?`<div class="row between"><span class="muted">Email</span><span>${OF.escape(c.email)}</span></div>`:''}
            ${c.phone?`<div class="row between"><span class="muted">Phone</span><span>${OF.escape(c.phone)}</span></div>`:''}
            ${c.address?`<div class="row between"><span class="muted">Service address</span><span>${OF.escape(OF.serviceAddress(c))}</span></div>`:''}
            ${c.notes?`<div><span class="muted small">Notes</span><p style="margin:4px 0 0">${OF.escape(c.notes)}</p></div>`:''}
          </div>
          ${canDocuments ? `<div class="customer-doc-card" style="margin-bottom:16px">
            <div class="customer-doc-card-head"><div><span class="customer-doc-kicker">Customer documents</span><h4>Autofill &amp; download</h4></div><span class="customer-doc-ready">${OF.icon('documents',14)} Ready</span></div>
            <div class="customer-doc-grid">
              <button type="button" class="customer-doc-button" id="wdiiDocBtn"><span class="customer-doc-icon">${OF.icon('documents',20)}</span><span><strong>WDII inspection report</strong><small>Fills the customer, property, license and today’s date. Inspection fields stay editable.</small></span><span class="customer-doc-arrow">&darr;</span></button>
              <button type="button" class="customer-doc-button" id="serviceAgreementBtn"><span class="customer-doc-icon agreement">${OF.icon('recurring',20)}</span><span><strong>Service agreement</strong><small>Choose monthly or quarterly, review pricing and use customer or plan notes.</small></span><span class="customer-doc-arrow">&rarr;</span></button>
            </div>
          </div>` : ''}
          ${section('Appointments', d.appointments.map(a=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><a href="/admin/appointments?id=${a.id}">${a.service_name?OF.escape(a.service_name):'Appointment'}</a><span class="muted small">${a.scheduled_start?OF.date(a.scheduled_start):'—'}</span>${OF.statusBadge(a.status)}</div>`).join(''))}
          ${section('Invoices', d.invoices.map(i=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><a href="/admin/invoices?id=${i.id}">${OF.escape(i.number)}</a>${OF.statusBadge(i.status)}<span class="mono">${OF.money(i.total_cents)}</span></div>`).join(''))}
          ${d.subscriptions.length?section('Subscriptions', d.subscriptions.map(su=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><span>${OF.escape(su.plan_name||'Plan')}</span><span class="mono">${OF.money(su.price_cents)}/${su.interval}</span>${OF.statusBadge(su.status)}</div>`).join('')):''}
          <div style="margin-bottom:16px"><div class="row between" style="margin-bottom:6px"><span class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Cards on file</span>${canPayments&&d.cards.available?`<div class="row" style="gap:6px"><button class="btn btn-ghost btn-xs" id="cardLinkBtn">Send link</button><button class="btn btn-secondary btn-xs" id="addCardBtn">${d.cards.mock?'Add test card':'Add card'}</button></div>`:''}</div>
            <div id="cardsBox"></div>
            ${d.cards.notConfigured?`<p class="tiny muted">Connect Stripe in Settings → Integrations to store cards on file.</p>`:''}
            ${d.cards.mock?`<p class="tiny muted">Demo mode — saved cards are simulated until a live processor is connected.</p>`:''}</div>
          <div style="margin-bottom:16px"><div class="row between" style="margin-bottom:6px"><span class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Devices &amp; stations</span><button class="btn btn-secondary btn-xs" id="addDevBtn">Add device</button></div>
            <div id="devBox"><p class="muted small">Loading…</p></div></div>
          <div style="margin-bottom:16px"><div class="row between" style="margin-bottom:6px"><span class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Properties &amp; units</span><button class="btn btn-secondary btn-xs" id="addPropBtn">Add property</button></div>
            <div id="propBox"><p class="muted small">Loading…</p></div></div>
        </div>`, { wide:true });
      async function loadProps(){ const r=await OF.get('/api/admin/properties?customerId='+id); const box=dr.q('#propBox'); if(!box)return;
        box.innerHTML = r.properties.length? r.properties.map(p=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><div><div class="cell-strong" style="font-size:14px">${OF.escape(p.name)}</div><div class="tiny muted">${OF.escape([p.address,p.city,p.state].filter(Boolean).join(', '))||'—'} · ${p.unit_count} unit${p.unit_count===1?'':'s'}</div></div><button class="link-btn" data-prop="${p.id}" data-name="${OF.escape(p.name)}">Units</button></div>`).join('') : '<p class="muted small">No properties. Add one for multi-unit buildings.</p>';
        box.querySelectorAll('[data-prop]').forEach(b=>b.onclick=()=>propertyModal(b.dataset.prop, b.dataset.name)); }
      dr.q('#addPropBtn')?.addEventListener('click', ()=>propertyAddModal(id, ()=>loadProps()));
      loadProps();
      function devHtml(devs){ return devs.length?devs.map(dv=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><div><div class="cell-strong" style="font-size:14px">${OF.escape(dv.label)}</div><div class="tiny muted">${OF.escape(dv.device_type)}${dv.serial?` · SN ${OF.escape(dv.serial)}`:''}${dv.last_status?` · last: ${OF.escape(dv.last_status)}`:''}</div></div><div class="row" style="gap:8px"><button class="link-btn" data-qr="${dv.qr_token}" data-label="${OF.escape(dv.label)}">QR</button><button class="link-btn" data-dev="${dv.id}">History</button></div></div>`).join(''):'<p class="muted small">No devices placed yet.</p>'; }
      async function loadDevices(){ const r=await OF.get('/api/admin/devices?customerId='+id); const box=dr.q('#devBox'); if(!box)return; box.innerHTML=devHtml(r.devices);
        box.querySelectorAll('[data-qr]').forEach(b=>b.onclick=()=>printQr(b.dataset.qr,b.dataset.label));
        box.querySelectorAll('[data-dev]').forEach(b=>b.onclick=()=>deviceHistoryModal(b.dataset.dev)); }
      dr.q('#addDevBtn')?.addEventListener('click', ()=>deviceModal(id, ()=>loadDevices()));
      loadDevices();
      function cardsHtml(pms){ return pms.length?pms.map(pm=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
        <span>${OF.icon('money',14)} ${OF.escape((pm.brand||'card'))} ••${OF.escape(pm.last4||'')} <span class="tiny muted">exp ${pm.exp_month}/${String(pm.exp_year).slice(-2)}</span>${pm.is_default?' <span class="badge ok no-dot">Default</span>':''}${pm.is_mock?' <span class="tiny muted">(test)</span>':''}</span>
        ${canPayments?`<span class="row" style="gap:8px">${pm.is_default?'':`<button class="link-btn" data-default="${pm.id}">Make default</button>`}<button class="link-btn" data-remove="${pm.id}" style="color:var(--danger)">Remove</button></span>`:''}</div>`).join(''):'<p class="muted small">No cards on file.</p>'; }
      async function reloadCards(){ const r = await OF.get('/api/admin/customers/'+id+'/payment-methods'); const box=dr.q('#cardsBox'); if(box){ box.innerHTML=cardsHtml(r.paymentMethods); bindCards(); } }
      function bindCards(){
        dr.el.querySelectorAll('[data-default]').forEach(b=>b.onclick=async()=>{ await OF.post(`/api/admin/customers/${id}/payment-methods/${b.dataset.default}/default`); OF.toast('Default updated','ok'); reloadCards(); });
        dr.el.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{ if(!(await OF.confirm({title:'Remove this card?',confirmText:'Remove',danger:true})))return; await OF.del(`/api/admin/customers/${id}/payment-methods/${b.dataset.remove}`); OF.toast('Card removed','ok'); reloadCards(); });
      }
      dr.q('#cardsBox').innerHTML = cardsHtml(d.paymentMethods||[]); bindCards();
      dr.q('#addCardBtn')?.addEventListener('click', async()=>{
        if (d.cards.mock) { await OF.post(`/api/admin/customers/${id}/payment-methods`,{}); OF.toast('Test card added','ok'); reloadCards(); }
        else { const r=await OF.post(`/api/admin/customers/${id}/card-link`); navigator.clipboard?.writeText(r.url); window.open(r.url,'_blank'); OF.toast('Secure card link opened & copied','ok'); }
      });
      dr.q('#cardLinkBtn')?.addEventListener('click', async()=>{ const r=await OF.post(`/api/admin/customers/${id}/card-link`); navigator.clipboard?.writeText(r.url); OF.toast('Card link copied — text or email it to the customer','ok'); });
      dr.q('#wdiiDocBtn')?.addEventListener('click', (event) => downloadCustomerDocument(c.id, { type: 'wdii' }, event.currentTarget));
      dr.q('#serviceAgreementBtn')?.addEventListener('click', () => serviceAgreementModal(c, d.subscriptions));
      dr.q('#editBtn').onclick=()=>dr.q('#editForm').classList.toggle('hidden');
      dr.q('#portalBtn').onclick=async()=>{ const r=await OF.post(`/api/admin/customers/${id}/portal-link`); navigator.clipboard?.writeText(r.url); OF.toast('Portal link copied — share it with the customer','ok'); };
      dr.q('#saveCust').onclick=async()=>{
        const address = dr.q('#e_addr').value.trim();
        if (!address) { dr.q('#e_addr').setAttribute('aria-invalid','true'); dr.q('#e_addr').focus(); return OF.toast('Service address is required','error'); }
        try {
          await OF.patch('/api/admin/customers/'+id,{name:dr.q('#e_name').value,email:dr.q('#e_email').value,phone:dr.q('#e_phone').value,address,city:dr.q('#e_city').value,state:dr.q('#e_state').value,postalCode:dr.q('#e_zip').value,notes:dr.q('#e_notes').value});
          OF.toast('Saved','ok'); dr.close(); refresh(root);
        } catch (error) { OF.toast(error.message,'error'); }
      };
      dr.q('#e_addr').addEventListener('input', (event)=>event.target.removeAttribute('aria-invalid'));
    }
    function section(title, inner){ return `<div style="margin-bottom:16px"><div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">${title}</div>${inner||'<p class="muted small">None yet.</p>'}</div>`; }

    function deviceModal(customerId, onSaved) {
      const m = OF.modal(`<div class="modal-head"><h3>Add device / station</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Label *</label><input id="dv_label" placeholder="e.g. Bait Station #1 — NE corner"></div>
          <div class="grid cols-2"><div class="field"><label>Type</label><select id="dv_type"><option value="bait_station">Bait station</option><option value="trap">Trap</option><option value="monitor">Monitor</option><option value="sensor">Sensor</option></select></div><div class="field"><label>Serial</label><input id="dv_serial"></div></div>
          <div class="field"><label>Location notes</label><input id="dv_loc" placeholder="Where it's installed"></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="dv_save">Add device</button></div>`);
      m.q('#dv_save').onclick=async()=>{ if(!m.q('#dv_label').value.trim())return OF.toast('Label required','error');
        try{ await OF.post('/api/admin/devices',{ customerId:+customerId, label:m.q('#dv_label').value.trim(), deviceType:m.q('#dv_type').value, serial:m.q('#dv_serial').value, locationNotes:m.q('#dv_loc').value }); OF.toast('Device added','ok'); m.close(); onSaved&&onSaved(); }catch(e){ OF.toast(e.message,'error'); } };
    }
    async function deviceHistoryModal(deviceId) {
      const d = await OF.get('/api/admin/devices/'+deviceId);
      const h = d.history.map(x=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><div><span class="badge no-dot">${OF.escape(x.status)}</span> ${x.activity_level?`<span class="tiny muted">activity ${OF.escape(x.activity_level)}</span>`:''}<div class="tiny muted">${x.action_taken?OF.escape(x.action_taken)+' · ':''}${x.technician_name?OF.escape(x.technician_name):''}</div></div><span class="tiny muted">${OF.dateTime(x.inspected_at)}</span></div>`).join('')||'<p class="muted small">No inspections yet.</p>';
      OF.modal(`<div class="modal-head"><h3>${OF.escape(d.device.label)}</h3><button class="x" data-close>&times;</button></div><div class="modal-body"><div class="muted small" style="margin-bottom:8px">${OF.escape(d.device.device_type)}${d.device.location_notes?' · '+OF.escape(d.device.location_notes):''}</div>${h}<p class="tiny muted" style="margin-top:10px;word-break:break-all">Scan link: ${OF.escape(d.device.scanUrl)}</p></div><div class="modal-foot"><button class="btn btn-primary" data-close>Close</button></div>`, { wide:true });
    }
    function printQr(token, label) {
      const url = location.origin + '/device?d=' + token;
      const w = window.open('', '_blank');
      if (!w) return;
      const safeLabel = OF.escape(label);
      const safeUrl = OF.escape(url);
      w.document.write(`<html><head><title>${safeLabel}</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
        <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px}#qr{display:inline-block;margin:16px}h2{margin:0}</style></head>
        <body><h2>${safeLabel}</h2><div id="qr"></div><p style="color:#475569;font-size:13px;word-break:break-all">${safeUrl}</p>
        <script>new QRCode(document.getElementById('qr'),{text:${JSON.stringify(url)},width:220,height:220});setTimeout(()=>window.print(),500);<\/script></body></html>`);
      w.document.close();
    }

    function propertyAddModal(customerId, onSaved) {
      const m = OF.modal(`<div class="modal-head"><h3>Add property</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><div class="field"><label>Name *</label><input id="pp_name" placeholder="e.g. Maple Apartments"></div>
          <div class="field"><label>Address</label><input id="pp_addr"></div>
          <div class="grid cols-3"><div class="field"><label>City</label><input id="pp_city"></div><div class="field"><label>State</label><input id="pp_state"></div><div class="field"><label>ZIP</label><input id="pp_zip"></div></div></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pp_save">Add</button></div>`);
      m.q('#pp_save').onclick=async()=>{ if(!m.q('#pp_name').value.trim())return OF.toast('Name required','error');
        await OF.post('/api/admin/properties',{ customerId:+customerId, name:m.q('#pp_name').value.trim(), address:m.q('#pp_addr').value, city:m.q('#pp_city').value, state:m.q('#pp_state').value, postalCode:m.q('#pp_zip').value }); OF.toast('Property added','ok'); m.close(); onSaved&&onSaved(); };
    }
    async function propertyModal(propertyId, propName) {
      const cust = OF.qs('id') || (window.__custId);
      const d = await OF.get('/api/admin/properties/'+propertyId+'/units');
      const m = OF.modal(`<div class="modal-head"><h3>${OF.escape(propName)} — units</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><div id="unitList">${d.units.length? d.units.map(u=>`<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line-2)"><div><span class="cell-strong">${OF.escape(u.label)}</span>${u.floor?` <span class="tiny muted">floor ${OF.escape(u.floor)}</span>`:''}<div class="tiny muted">${u.device_count} device${u.device_count===1?'':'s'}</div></div><button class="link-btn" data-unit="${u.id}">Open</button></div>`).join('') : '<p class="muted small">No units yet.</p>'}</div>
          <div class="row" style="gap:8px;margin-top:10px"><input id="u_label" placeholder="Unit label (e.g. Apt 2B)" style="flex:1"><input id="u_floor" placeholder="Floor" style="max-width:90px"><button class="btn btn-secondary btn-sm" id="u_add">Add</button></div></div>
        <div class="modal-foot"><button class="btn btn-primary" data-close>Close</button></div>`, { wide:true });
      const reload=()=>{ m.close(); propertyModal(propertyId, propName); };
      m.q('#u_add').onclick=async()=>{ if(!m.q('#u_label').value.trim())return; await OF.post('/api/admin/properties/units',{ propertyId:+propertyId, label:m.q('#u_label').value.trim(), floor:m.q('#u_floor').value }); reload(); };
      m.el.querySelectorAll('[data-unit]').forEach(b=>b.onclick=()=>{ m.close(); unitModal(b.dataset.unit); });
    }
    async function unitModal(unitId) {
      const d = await OF.get('/api/admin/properties/units/'+unitId);
      const u = d.unit; const markers = (u.diagram && u.diagram.markers) || [];
      const m = OF.modal(`<div class="modal-head"><h3>${OF.escape(u.label)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="max-height:78vh;overflow:auto">
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Floorplan diagram</div>
          <div id="diagWrap" style="position:relative;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface-2);min-height:120px">
            ${d.floorplanUrl?`<img id="fp" src="${d.floorplanUrl}" style="display:block;width:100%">`:'<div class="center muted small" style="padding:30px">No floorplan yet. Upload one, then tap to place device pins.</div>'}
            <div id="pins"></div>
          </div>
          <div class="row wrap" style="gap:8px;margin:10px 0">
            <label class="btn btn-secondary btn-sm" style="cursor:pointer">Upload floorplan<input type="file" id="fpUp" accept="image/*" hidden></label>
            ${d.floorplanUrl?'<button class="btn btn-primary btn-sm" id="saveDiag">Save pins</button><span class="tiny muted">Tap the plan to add a pin.</span>':''}
          </div>
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:10px 0 6px">Devices in this unit</div>
          <div id="uDevs">${d.devices.length? d.devices.map(dv=>`<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line-2)"><span>${OF.escape(dv.label)} <span class="tiny muted">${OF.escape(dv.device_type)}</span></span></div>`).join('') : '<p class="muted small">No devices here.</p>'}</div>
          <div class="row" style="gap:8px;margin-top:8px"><input id="ud_label" placeholder="Add device label" style="flex:1"><button class="btn btn-secondary btn-sm" id="ud_add">Add device</button></div>
          ${d.inspections.length?`<div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:12px 0 6px">Recent activity</div>${d.inspections.map(h=>`<div class="row between" style="padding:5px 0"><span class="small">${OF.escape(h.device_label)} · ${OF.escape(h.status)}</span><span class="tiny muted">${OF.date(h.inspected_at)}</span></div>`).join('')}`:''}
        </div>
        <div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`, { wide:true });
      const custId = window.__custId;
      let pins = markers.slice();
      function renderPins(){ const box=m.q('#pins'); if(!box)return; box.innerHTML=pins.map((p,i)=>`<span title="${OF.escape(p.label||'')}" style="position:absolute;left:${p.x*100}%;top:${p.y*100}%;transform:translate(-50%,-100%);cursor:pointer" data-pin="${i}">📍</span>`).join(''); box.querySelectorAll('[data-pin]').forEach(s=>s.onclick=(ev)=>{ ev.stopPropagation(); if(confirm('Remove this pin?')){ pins.splice(+s.dataset.pin,1); renderPins(); } }); }
      renderPins();
      const fp=m.q('#fp');
      if(fp) fp.onclick=(ev)=>{ const r=fp.getBoundingClientRect(); const x=(ev.clientX-r.left)/r.width, y=(ev.clientY-r.top)/r.height; const label=prompt('Pin label (e.g. Station 3):')||''; pins.push({x,y,label,deviceId:null}); renderPins(); };
      m.q('#saveDiag')?.addEventListener('click', async()=>{ await OF.post(`/api/admin/properties/units/${unitId}/diagram`,{ markers:pins }); OF.toast('Diagram saved','ok'); });
      m.q('#fpUp').onchange=async(e)=>{ const file=e.target.files[0]; if(!file)return; const dataBase64=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(file);}); await OF.post(`/api/admin/properties/units/${unitId}/floorplan`,{ filename:file.name, contentType:file.type, dataBase64 }); OF.toast('Floorplan uploaded','ok'); m.close(); unitModal(unitId); };
      m.q('#ud_add').onclick=async()=>{ const label=m.q('#ud_label').value.trim(); if(!label)return; if(!custId){ OF.toast('Reopen from the customer to add devices','error'); return; } await OF.post('/api/admin/devices',{ customerId:+custId, label, unitId:+unitId, deviceType:'bait_station' }); OF.toast('Device added','ok'); m.close(); unitModal(unitId); };
    }

    function addCustomer(root) {
      const m = OF.modal(`<div class="modal-head"><h3>Add customer</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label for="c_name">Customer name *</label><input id="c_name" required autocomplete="name" placeholder="Full name or business name"></div>
          <div class="grid cols-2"><div class="field"><label for="c_email">Email</label><input id="c_email" type="email" autocomplete="email" placeholder="name@example.com"></div><div class="field"><label for="c_phone">Phone</label><input id="c_phone" type="tel" autocomplete="tel" placeholder="(410) 555-0123"></div></div>
          <div class="card card-pad" style="padding:16px;background:var(--brand-tint-2);border-color:color-mix(in srgb,var(--brand) 22%,var(--line));box-shadow:none">
            <div class="row" style="gap:10px;margin-bottom:12px"><span style="width:34px;height:34px;border-radius:10px;background:var(--brand-tint);color:var(--brand);display:grid;place-items:center;flex:none">${OF.icon('pin',17)}</span><div><div class="cell-strong">Service location</div><div class="tiny muted">Used for scheduling, dispatch, and route planning.</div></div></div>
            <div class="field"><label for="c_addr">Street address *</label><input id="c_addr" required autocomplete="street-address" placeholder="123 Main Street" aria-describedby="c_addr_hint"><span class="hint" id="c_addr_hint">A street service address is required for every new customer.</span></div>
            <div class="grid cols-3"><div class="field"><label for="c_city">City</label><input id="c_city" autocomplete="address-level2"></div><div class="field"><label for="c_state">State</label><input id="c_state" autocomplete="address-level1" maxlength="40"></div><div class="field"><label for="c_zip">ZIP</label><input id="c_zip" autocomplete="postal-code" inputmode="numeric"></div></div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="c_save">${OF.icon('plus',15)} Add customer</button></div>`);
      const name = m.q('#c_name');
      const address = m.q('#c_addr');
      const requireField = (input, message) => {
        input.removeAttribute('aria-invalid');
        if (input.value.trim()) return true;
        input.setAttribute('aria-invalid', 'true'); input.focus(); OF.toast(message, 'error'); return false;
      };
      [name, address].forEach(input => input.addEventListener('input', () => input.removeAttribute('aria-invalid')));
      m.q('#c_save').onclick=async()=>{
        if(!requireField(name, 'Customer name is required')) return;
        if(!requireField(address, 'Service address is required')) return;
        const email = m.q('#c_email');
        if (!email.checkValidity()) { email.reportValidity(); return; }
        try {
          await OF.post('/api/admin/customers',{name:name.value.trim(),email:email.value.trim(),phone:m.q('#c_phone').value.trim(),address:address.value.trim(),city:m.q('#c_city').value.trim(),state:m.q('#c_state').value.trim(),postalCode:m.q('#c_zip').value.trim()});
          m.close(); OF.toast('Customer added','ok'); refresh(root);
        } catch (error) { OF.toast(error.message, 'error'); }
      };
      name.focus();
    }

    function exportCustomers() {
      const p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      location.href = '/api/admin/customers/export.csv' + (p.toString() ? '?' + p : '');
    }

    function importCustomers(root) {
      let csv = '';
      let preview = null;
      const m = OF.modal(`<div class="modal-head"><h3>Import customers</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <p class="muted small" style="margin-top:0">CSV columns: name, email, phone, address, city, state, postal_code, notes. <b>Name and address are required.</b> Dry-run checks duplicates before anything is created.</p>
          <div class="field"><label>CSV file</label><input type="file" id="ci_file" accept=".csv,text/csv"></div>
          <div id="ci_preview"></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ci_import" disabled>Confirm import</button></div>`, { wide:true });
      function draw(r) {
        preview = r;
        const rows = (r.rows||[]).slice(0, 10);
        m.q('#ci_preview').innerHTML = `<div class="row wrap" style="gap:8px;margin-bottom:10px">
          <span class="badge ok no-dot">${r.summary.valid} valid</span>
          <span class="badge warn no-dot">${r.summary.duplicates} duplicates</span>
          <span class="badge danger no-dot">${r.summary.errors} errors</span>
        </div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Service address</th><th>Status</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.row}</td><td>${OF.escape(x.name)}</td><td>${OF.escape(x.email)}</td><td>${OF.escape(x.address||'—')}</td><td>${x.status==='valid'?'<span class="badge ok no-dot">Valid</span>':`<span class="badge ${x.status==='duplicate'?'warn':'danger'} no-dot">${OF.escape(x.errors.join(' '))}</span>`}</td></tr>`).join('')}</tbody></table></div>
        ${r.rows.length>10?`<p class="tiny muted">Showing first 10 of ${r.rows.length} rows.</p>`:''}`;
        m.q('#ci_import').disabled = !r.summary.valid;
      }
      m.q('#ci_file').onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        csv = await file.text();
        try { draw(await OF.post('/api/admin/customers/import', { csv, dryRun:true })); }
        catch (err) { OF.toast(err.message, 'error'); }
      };
      m.q('#ci_import').onclick = async () => {
        if (!preview || !preview.summary.valid) return;
        try {
          const r = await OF.post('/api/admin/customers/import', { csv, dryRun:false });
          OF.toast(`Imported ${r.inserted} customer${r.inserted===1?'':'s'}`, 'ok');
          m.close(); refresh(root);
        } catch (err) { OF.toast(err.message, 'error'); }
      };
    }

    OF.page({ active:'customers', title:'Customers', subtitle:'Your customer book', render: async (root, ctx) => {
      activeRoot = root;
      ctx.setActions(`<button class="btn btn-secondary btn-sm" id="importBtn">Import CSV</button><button class="btn btn-secondary btn-sm" id="exportBtn">Export CSV</button><button class="btn btn-primary btn-sm" id="addBtn">${OF.icon('plus',15)} Add customer</button>`);
      root.innerHTML = `<div class="row between" style="margin-bottom:16px">${OF.searchInput({ placeholder:'Search customers…', value: state.q })}</div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('addBtn').onclick=()=>addCustomer(root);
      document.getElementById('exportBtn').onclick=exportCustomers;
      document.getElementById('importBtn').onclick=()=>importCustomers(root);
      inRoot(root, '#search')?.addEventListener('input', OF.debounce(e=>{ state.q=e.target.value.trim(); refresh(root); },300));
      await refresh(root);
      if (OF.qs('id')) openDrawer(root, OF.qs('id'));
    }});
  
