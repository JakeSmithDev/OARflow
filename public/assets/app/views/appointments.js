// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let SERVICES = [];
    let TECHS = null;
    const state = { status: 'all', q: '', limit: OF.listLimit, rows: [], total: 0 };

    async function loadServices() { if (!SERVICES.length) SERVICES = (await OF.get('/api/admin/appointments/meta/services')).services; return SERVICES; }
    async function loadTechs() { if (!TECHS) TECHS = (await OF.get('/api/admin/technicians')).technicians; return TECHS; }
    function techChip(t) { const c = OF.color(t.color); return `<span class="badge no-dot" style="background:${c}1a;color:${c}">${t.is_lead ? '★ ' : ''}${OF.escape(t.name)}</span>`; }
    function localInputs(iso) {
      if (!iso) return { date: '', time: '' };
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: OF.tenant?.timezone || 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(iso)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
      return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
    }

    // Run an action; if the slot is at capacity, ask to override and retry with force.
    async function doForce(fn) {
      try { await fn(false); return true; }
      catch (e) {
        if (e.code === 'SCHEDULE_WARN' || e.code === 'SLOT_FULL') {
          if (await OF.confirm({ title: 'Heads up', body: `<p class="muted">${OF.escape(e.message)}</p>`, confirmText: 'Book anyway' })) { try { await fn(true); return true; } catch (e2) { OF.toast(e2.message, 'error'); return false; } }
          return false;
        }
        OF.toast(e.message, 'error'); return false;
      }
    }

    function chip(key, label, n) {
      return `<button class="chip ${state.status===key?'active':''}" data-status="${key}">${label}${n!=null?` <span class="n">${n}</span>`:''}</button>`;
    }

    function listParams(offset = 0) {
      const params = new URLSearchParams({ status: state.status, limit: state.limit, offset });
      if (state.q) params.set('q', state.q);
      return params;
    }

    async function refresh({ append = false } = {}) {
      const d = await OF.get('/api/admin/appointments?' + listParams(append ? state.rows.length : 0));
      state.rows = append ? state.rows.concat(d.appointments || []) : (d.appointments || []);
      state.total = d.total || state.rows.length;
      const c = d.counts;
      document.getElementById('chips').innerHTML =
        chip('all','All',c.all)+chip('requested','Requested',c.requested||0)+chip('scheduled','Scheduled',c.scheduled||0)+chip('completed','Completed',c.completed||0)+chip('no_show','No-show',c.no_show||0)+chip('canceled','Canceled',c.canceled||0);
      document.querySelectorAll('#chips .chip').forEach(b=>b.onclick=()=>{ state.status=b.dataset.status; refresh(); });
      const rows = state.rows;
      const list = document.getElementById('list');
      list.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Status</th><th class="right">Price</th></tr></thead>
        <tbody>${rows.map(a=>`<tr class="clickable" data-id="${a.id}">
          <td class="nowrap">${a.scheduled_start?`<span class="cell-strong">${OF.date(a.scheduled_start)}</span><div class="tiny muted">${OF.time(a.scheduled_start)}</div>`:`<span class="muted">${a.status==='requested'?'Requested':'—'}</span>`}</td>
          <td><div class="cell-strong">${OF.escape(a.customer_name)}</div><div class="tiny muted">${OF.escape(a.service_address||a.customer_email||'')}</div></td>
          <td>${a.service_name?`<span class="badge no-dot" style="background:${OF.color(a.service_color)}1a;color:${OF.color(a.service_color)}">${OF.escape(a.service_name)}</span>`:'—'}</td>
          <td>${OF.statusBadge(a.status)}</td>
          <td class="right mono">${OF.money(a.price_cents)}</td></tr>`).join('')}</tbody></table></div>${OF.listFooter({ shown: rows.length, total: state.total, label: 'appointments' })}`
        : `<div class="empty"><div class="ic">${OF.icon('appointments',22)}</div><p>No appointments found.</p></div>${OF.listFooter({ shown: 0, total: state.total, label: 'appointments' })}`;
      list.querySelectorAll('tr[data-id]').forEach(r=>r.onclick=()=>openDrawer(r.dataset.id));
      list.querySelector('[data-load-more]')?.addEventListener('click', () => refresh({ append: true }));
    }

    function filesHtml(files){ return (files&&files.length)?`<div class="filegrid">${files.map(f=>f.contentType&&f.contentType.startsWith('image/')
        ? `<div class="filecard" data-fid="${f.id}"><a href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" loading="lazy" alt="${OF.escape(f.filename)}"></a><button class="filedel" data-del="${f.id}" title="Delete">✕</button></div>`
        : `<div class="filecard doc" data-fid="${f.id}"><a href="${f.url}" target="_blank" rel="noopener" class="doclink">${OF.icon('invoices',20)}<span>${OF.escape(f.filename)}</span></a><button class="filedel" data-del="${f.id}" title="Delete">✕</button></div>`).join('')}</div>`
      : '<p class="muted small">No photos or files yet.</p>'; }

    async function openDrawer(id) {
      const { appointment: a, invoices, technicians, files } = await OF.get('/api/admin/appointments/'+id);
      const isReq = a.status==='requested';
      const crew = technicians || [];
      let jobFiles = files || [];
      const slots = (a.requested_slots||[]);
      const canDispatch = OF.hasCap('dispatch.manage');
      const rescheduleAt = localInputs(a.scheduled_start);
      const dr = OF.drawer(`
        <div class="modal-head"><h3>${OF.escape(a.customer_name)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="row between" style="margin-bottom:14px">${OF.statusBadge(a.status)}<span class="muted small">${a.service_name?OF.escape(a.service_name):''}</span></div>
          <div class="card card-pad stack" style="gap:8px;margin-bottom:16px">
            ${a.scheduled_start?`<div class="row between"><span class="muted">When</span><b>${OF.dateTime(a.scheduled_start)}</b></div>`:''}
            <div class="row between"><span class="muted">Customer</span><b>${OF.escape(a.customer_name)}</b></div>
            ${a.customer_email?`<div class="row between"><span class="muted">Email</span><span>${OF.escape(a.customer_email)}</span></div>`:''}
            ${a.customer_phone?`<div class="row between"><span class="muted">Phone</span><span>${OF.escape(a.customer_phone)}</span></div>`:''}
            ${a.service_address?`<div class="row between"><span class="muted">Address</span><span>${OF.escape(a.service_address)}</span></div>`:''}
            ${a.notes?`<div><span class="muted small">Customer notes</span><p style="margin:4px 0 0">${OF.escape(a.notes)}</p></div>`:''}
          </div>
          ${isReq?`<div class="card card-pad" style="margin-bottom:16px"><h4 style="margin-bottom:10px">Confirm a time</h4>
            ${slots.length?slots.map((s,i)=>`<label class="row" style="gap:10px;padding:8px 0;cursor:pointer"><input type="radio" name="slot" value="${i}" style="width:auto"><b>${OF.dateTime(s.start)}</b></label>`).join(''):`<p class="muted small">No proposed times.</p><div class="grid cols-2"><div class="field"><label>Date</label><input type="date" id="confirmDate"></div><div class="field"><label>Time</label><input type="time" id="confirmTime"></div></div>`}
            <button class="btn btn-primary btn-block" id="confirmBtn" style="margin-top:10px">Confirm appointment</button></div>`:''}
          ${a.status!=='canceled'?`<div class="card card-pad" style="margin-bottom:16px"><div class="row between" style="margin-bottom:8px"><h4 style="margin:0">Assigned crew</h4>${canDispatch?'<button class="btn btn-ghost btn-xs" id="assignBtn">Assign</button>':''}</div>
            <div id="crewBox" class="row wrap" style="gap:6px">${crew.length?crew.map(techChip).join(''):'<span class="muted small">No one assigned yet.</span>'}</div></div>`:''}
          <div class="card card-pad" style="margin-bottom:16px"><div class="row between" style="margin-bottom:8px"><h4 style="margin:0">Photos &amp; files</h4><label class="btn btn-ghost btn-xs" style="cursor:pointer">Upload<input type="file" id="fileInput" accept="image/*,application/pdf" multiple hidden></label></div>
            <div id="filesBox">${filesHtml(jobFiles)}</div></div>
          <div class="card card-pad" style="margin-bottom:16px"><div class="row between" style="margin-bottom:8px"><h4 style="margin:0">Materials used</h4><div class="row" style="gap:6px"><button class="btn btn-ghost btn-xs" id="reportBtn">Service report</button><button class="btn btn-ghost btn-xs" id="addMat">Add material</button></div></div>
            <div id="matBox"><p class="muted small">Loading…</p></div></div>
          <div class="field"><label>Internal notes</label><textarea id="internalNotes">${OF.escape(a.internal_notes||'')}</textarea></div>
          <button class="btn btn-secondary btn-sm" id="saveNotes">Save notes</button>
          <hr class="divider">
          <div class="stack">
            ${!isReq && a.status!=='canceled'?`<div class="card card-pad"><h4 style="margin-bottom:10px">Reschedule</h4>
              <div class="grid cols-2"><div class="field"><label>Date</label><input type="date" id="rDate" value="${rescheduleAt.date}"></div><div class="field"><label>Time</label><input type="time" id="rTime" value="${rescheduleAt.time}"></div></div>
              <button class="btn btn-secondary btn-sm" id="rescheduleBtn">Update time</button></div>`:''}
            <div class="row wrap" style="gap:8px">
              ${a.status==='scheduled'?`<button class="btn btn-primary btn-sm" data-act="completed">${OF.icon('check',15)} Mark completed</button>`:''}
              ${a.status==='scheduled'?`<button class="btn btn-secondary btn-sm" id="remindBtn">${OF.icon('send',15)} Send reminder</button>`:''}
              ${a.status==='scheduled'?`<button class="btn btn-secondary btn-sm" id="omwBtn">${OF.icon('pin',15)} On my way (text)</button>`:''}
              ${a.status!=='canceled'&&a.status!=='completed'?`<button class="btn btn-secondary btn-sm" data-act="no_show">No-show</button>`:''}
              ${a.status!=='canceled'?`<button class="btn btn-danger-soft btn-sm" data-act="cancel">Cancel</button>`:''}
              <a class="btn btn-secondary btn-sm" href="/admin/invoices?new=1&appointment=${a.id}&customer=${a.customer_id}">${OF.icon('invoices',15)} Create invoice</a>
            </div>
            ${a.reminder_sent_at?`<div class="tiny muted" style="margin-top:8px">${OF.icon('check',12)} Reminder sent ${OF.dateTime(a.reminder_sent_at)}</div>`:''}
            ${invoices.length?`<div><span class="muted small">Invoices</span>${invoices.map(i=>`<div class="row between" style="padding:6px 0"><a href="/admin/invoices?id=${i.id}">${OF.escape(i.number)}</a>${OF.statusBadge(i.status)}<span class="mono">${OF.money(i.total_cents)}</span></div>`).join('')}</div>`:''}
          </div>
        </div>`, { wide:true });

      const reload = () => { dr.close(); refresh(); };
      dr.q('#assignBtn')?.addEventListener('click', ()=>assignModal(id, crew, (updated)=>{ dr.q('#crewBox').innerHTML = updated.length?updated.map(techChip).join(''):'<span class="muted small">No one assigned yet.</span>'; }));
      function bindFiles(){ dr.el.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ if(!(await OF.confirm({title:'Delete this file?',confirmText:'Delete',danger:true})))return; await OF.del(`/api/admin/appointments/${id}/files/${b.dataset.del}`); jobFiles=jobFiles.filter(f=>String(f.id)!==b.dataset.del); dr.q('#filesBox').innerHTML=filesHtml(jobFiles); }); }
      bindFiles();
      function matHtml(apps){ return apps.length? apps.map(a=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><div><div class="cell-strong" style="font-size:14px">${OF.escape(a.product_name)}${a.epa_reg_no?` <span class="tiny muted">EPA ${OF.escape(a.epa_reg_no)}</span>`:''}</div><div class="tiny muted">${[a.target_pest,a.area_treated,a.quantity?`${a.quantity}${a.unit||''}`:'',a.method].filter(Boolean).map(OF.escape).join(' · ')}${a.applicator_name?` · ${OF.escape(a.applicator_name)}`:''}</div></div><button class="link-btn" data-mat="${a.id}" style="color:var(--danger)">✕</button></div>`).join('') : '<p class="muted small">No materials recorded.</p>'; }
      async function loadMats(){ const r=await OF.get(`/api/admin/appointments/${id}/applications`); const box=dr.q('#matBox'); if(box){ box.innerHTML=matHtml(r.applications); box.querySelectorAll('[data-mat]').forEach(b=>b.onclick=async()=>{ if(!(await OF.confirm({title:'Remove this material record?',confirmText:'Remove',danger:true})))return; await OF.del(`/api/admin/appointments/${id}/applications/${b.dataset.mat}`); loadMats(); }); } }
      loadMats();
      dr.q('#addMat')?.addEventListener('click', ()=>materialModal(id, ()=>loadMats()));
      dr.q('#reportBtn')?.addEventListener('click', ()=>serviceReportModal(id));
      dr.q('#fileInput')?.addEventListener('change', async (e)=>{
        const list=[...e.target.files]; if(!list.length) return;
        OF.toast(`Uploading ${list.length} file${list.length>1?'s':''}…`);
        for (const file of list){
          const dataBase64 = await new Promise((res2,rej)=>{ const fr=new FileReader(); fr.onload=()=>res2(fr.result); fr.onerror=rej; fr.readAsDataURL(file); });
          try { const r=await OF.post(`/api/admin/appointments/${id}/files`,{ filename:file.name, contentType:file.type, dataBase64 }); jobFiles.unshift(r.file); }
          catch(err){ OF.toast(err.message,'error'); }
        }
        dr.q('#filesBox').innerHTML=filesHtml(jobFiles); bindFiles(); OF.toast('Uploaded ✓','ok'); e.target.value='';
      });
      dr.q('#saveNotes')?.addEventListener('click', async()=>{ await OF.patch('/api/admin/appointments/'+id,{internalNotes:dr.q('#internalNotes').value}); OF.toast('Notes saved','ok'); });
      dr.q('#confirmBtn')?.addEventListener('click', async()=>{
        const sel=dr.el.querySelector('input[name=slot]:checked');
        const date=dr.q('#confirmDate')?.value;
        const time=dr.q('#confirmTime')?.value;
        if(slots.length&&!sel) return OF.toast('Pick a time first','error');
        if(!slots.length&&(!date||!time)) return OF.toast('Pick date & time','error');
        if(await doForce(force=>OF.post(`/api/admin/appointments/${id}/confirm`,slots.length?{slotIndex:+sel.value,notify:true,force}:{date,time,notify:true,force}))){ OF.toast('Confirmed & customer notified','ok'); reload(); }
      });
      dr.q('#rescheduleBtn')?.addEventListener('click', async()=>{ const date=dr.q('#rDate').value,time=dr.q('#rTime').value; if(!date||!time) return OF.toast('Pick date & time','error'); if(await doForce(force=>OF.patch('/api/admin/appointments/'+id,{date,time,notify:true,force}))){ OF.toast('Rescheduled','ok'); reload(); } });
      dr.q('#remindBtn')?.addEventListener('click', async()=>{ try{ await OF.post(`/api/admin/appointments/${id}/send-reminder`); OF.toast('Reminder sent','ok'); reload(); }catch(e){ OF.toast(e.message,'error'); } });
      dr.q('#omwBtn')?.addEventListener('click', async()=>{ const eta=prompt('Optional ETA (e.g. "in about 20 minutes"):')||''; try{ await OF.post(`/api/admin/appointments/${id}/on-my-way`,{eta}); OF.toast('On-my-way text sent','ok'); }catch(e){ OF.toast(e.message,'error'); } });
      dr.el.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click', async()=>{
        const act=b.dataset.act;
        if(act==='cancel'){ if(!(await OF.confirm({title:'Cancel appointment?',body:'<p class="muted">The customer can be notified by email.</p>',confirmText:'Cancel appointment',danger:true}))) return; await OF.patch('/api/admin/appointments/'+id,{status:'canceled',notify:true}); OF.toast('Canceled','ok'); }
        else { await OF.patch('/api/admin/appointments/'+id,{status:act}); OF.toast(act==='completed'?'Marked completed':'Updated','ok'); }
        reload();
      }));
    }

    async function assignModal(apptId, current, onSaved) {
      await loadTechs();
      const sel = new Set(current.map(t => t.id));
      let lead = (current.find(t => t.is_lead) || {}).id || null;
      const m = OF.modal(`<div class="modal-head"><h3>Assign crew</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div id="techList">${TECHS.length ? '' : '<p class="muted small">No technicians yet. Add one below.</p>'}</div>
          <div class="row" style="gap:8px;margin-top:10px"><input id="newTech" placeholder="Add a technician name…" style="flex:1"><button class="btn btn-secondary btn-sm" id="addTech">Add</button></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="saveAssign">Save</button></div>`);
      function renderList() {
        m.q('#techList').innerHTML = TECHS.map(t => `<label class="row between" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2);cursor:pointer">
          <span class="row" style="gap:10px"><input type="checkbox" class="tk" data-id="${t.id}" ${sel.has(t.id) ? 'checked' : ''} style="width:auto"><span class="badge no-dot" style="background:${OF.color(t.color)}1a;color:${OF.color(t.color)}">${OF.escape(t.name)}</span></span>
          <label class="row tiny muted" style="gap:5px;cursor:pointer"><input type="radio" name="lead" class="ld" data-id="${t.id}" ${lead === t.id ? 'checked' : ''} ${sel.has(t.id) ? '' : 'disabled'} style="width:auto"> lead</label></label>`).join('') || '<p class="muted small">No technicians yet. Add one below.</p>';
        m.el.querySelectorAll('.tk').forEach(c => c.onchange = () => { const id = +c.dataset.id; if (c.checked) sel.add(id); else { sel.delete(id); if (lead === id) lead = null; } renderList(); });
        m.el.querySelectorAll('.ld').forEach(r => r.onchange = () => { lead = +r.dataset.id; });
      }
      renderList();
      m.q('#addTech').onclick = async () => { const name = m.q('#newTech').value.trim(); if (!name) return; try { const r = await OF.post('/api/admin/technicians', { name }); TECHS.push(r.technician); sel.add(r.technician.id); m.q('#newTech').value = ''; renderList(); } catch (e) { OF.toast(e.message, 'error'); } };
      m.q('#saveAssign').onclick = async () => {
        try { const r = await OF.post(`/api/admin/appointments/${apptId}/assign`, { technicianIds: [...sel], leadId: lead }); OF.toast('Crew updated', 'ok'); onSaved && onSaved(r.technicians); m.close(); }
        catch (e) { OF.toast(e.message, 'error'); }
      };
    }

    let PRODUCTS = null;
    async function materialModal(apptId, onSaved) {
      if (!PRODUCTS) PRODUCTS = (await OF.get('/api/admin/compliance/products')).products;
      await loadTechs();
      const m = OF.modal(`<div class="modal-head"><h3>Record material used</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Product</label><select id="mp">${PRODUCTS.length?PRODUCTS.map(p=>`<option value="${p.id}">${OF.escape(p.name)}${p.epa_reg_no?` (EPA ${OF.escape(p.epa_reg_no)})`:''}</option>`).join(''):'<option value="">— add products in Compliance —</option>'}</select></div>
          <div class="grid cols-2"><div class="field"><label>Target pest</label><input id="mpest"></div><div class="field"><label>Area treated</label><input id="marea" placeholder="Perimeter, kitchen…"></div></div>
          <div class="grid cols-3"><div class="field"><label>Quantity</label><input id="mqty" type="number" step="0.01"></div><div class="field"><label>Unit</label><input id="munit" placeholder="oz, gal"></div><div class="field"><label>Method</label><select id="mmethod"><option value="">—</option><option>spray</option><option>granular</option><option>bait</option><option>dust</option><option>fog</option></select></div></div>
          <div class="field"><label>Applicator</label><select id="mtech"><option value="">—</option>${TECHS.map(t=>`<option value="${t.id}">${OF.escape(t.name)}</option>`).join('')}</select></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="msave">Record</button></div>`);
      m.q('#msave').onclick=async()=>{
        const productId=+m.q('#mp').value||null; if(!productId) return OF.toast('Add a product in Compliance first','error');
        try { await OF.post(`/api/admin/appointments/${apptId}/applications`,{ productId, targetPest:m.q('#mpest').value, areaTreated:m.q('#marea').value, quantity:m.q('#mqty').value||null, unit:m.q('#munit').value, method:m.q('#mmethod').value, technicianId:+m.q('#mtech').value||null });
          OF.toast('Material recorded','ok'); m.close(); onSaved&&onSaved(); } catch(e){ OF.toast(e.message,'error'); }
      };
    }

    async function serviceReportModal(apptId) {
      const d = await OF.get(`/api/admin/appointments/${apptId}/service-report`);
      const r = d.report; const a = r.appointment;
      const apps = r.applications.map(x=>`<tr><td>${OF.escape(x.product_name)}</td><td>${OF.escape(x.epa_reg_no||'—')}</td><td>${OF.escape(x.target_pest||'—')}</td><td>${OF.escape(x.area_treated||'—')}</td><td>${x.quantity?OF.escape(`${x.quantity}${x.unit||''}`):'—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No materials recorded.</td></tr>';
      const m = OF.modal(`<div class="modal-head"><h3>Service report</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" id="srBody" style="max-height:74vh;overflow:auto">
          <h2 style="margin:0">${OF.escape(r.company.name)}</h2><p class="muted small" style="margin:2px 0 12px">${OF.escape(r.company.phone||'')}</p>
          <div class="card card-pad" style="margin-bottom:12px"><div><b>${OF.escape(a.customer_name)}</b></div><div class="small muted">${OF.escape([a.customer_address,a.city,a.state].filter(Boolean).join(', '))}</div>
            <div class="small" style="margin-top:6px">${OF.escape(a.service_name||'Service')}${a.scheduled_start?` · ${OF.dateTime(a.scheduled_start)}`:''}</div>
            ${r.crew.length?`<div class="small" style="margin-top:6px">Technician: ${r.crew.map(c=>OF.escape(c.name)+(c.license_no?` (Lic ${OF.escape(c.license_no)})`:'')).join(', ')}</div>`:''}</div>
          <table class="tbl"><thead><tr><th>Product</th><th>EPA #</th><th>Target</th><th>Area</th><th>Qty</th></tr></thead><tbody>${apps}</tbody></table>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="srPrint">Print</button></div>`, { wide:true });
      m.q('#srPrint').onclick=()=>{ const w=window.open('','_blank'); w.document.write(`<html><head><title>Service Report</title><link rel="stylesheet" href="/assets/app/app.css"></head><body style="padding:24px">${m.q('#srBody').innerHTML}</body></html>`); w.document.close(); w.focus(); setTimeout(()=>w.print(),300); };
    }

    async function newAppointment(prefill={}) {
      await loadServices();
      let picked = prefill.customerId ? { id: prefill.customerId, name: prefill.name || '', address: prefill.address || '' } : null;
      const m = OF.modal(`
        <div class="modal-head"><h3>New appointment</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Customer *</label><input id="n_customer" placeholder="Search existing or type a new name…" value="${OF.escape(prefill.name||'')}" autocomplete="off"><div id="n_results" class="card" style="display:none;position:relative;z-index:5"></div><div id="n_selected" class="${picked?'':'hidden'}" style="margin-top:8px"></div><span class="hint">Pick an existing customer to avoid creating a duplicate, or type a new customer name.</span></div>
          <div id="n_newFields" class="${picked?'hidden':''}"><div class="grid cols-2"><div class="field"><label>Email</label><input id="n_email" type="email"></div><div class="field"><label>Phone</label><input id="n_phone" type="tel"></div></div></div>
          <div class="field"><label>Service</label><select id="n_service">${SERVICES.map(s=>`<option value="${s.id}">${OF.escape(s.name)} · ${OF.money(s.base_price_cents)}</option>`).join('')}</select></div>
          <div class="grid cols-2"><div class="field"><label>Date *</label><input id="n_date" type="date"></div><div class="field"><label>Time *</label><input id="n_time" type="time" value="09:00"></div></div>
          <div class="field"><label>Service address</label><input id="n_addr" value="${OF.escape(prefill.address||'')}"></div>
          <div class="field"><label>Notes</label><textarea id="n_notes"></textarea></div>
          <label class="row" style="gap:8px"><input type="checkbox" id="n_notify" checked style="width:auto"> Email confirmation to customer</label>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="n_save">Create appointment</button></div>`);
      const selectedBox = m.q('#n_selected');
      const newFields = m.q('#n_newFields');
      function showPicked(c) {
        picked = c;
        selectedBox.classList.remove('hidden');
        selectedBox.innerHTML = `<span class="badge ok no-dot">Using ${OF.escape(c.name)}</span> <button class="link-btn" id="n_useNew" type="button">Use new customer instead</button>`;
        newFields.classList.add('hidden');
        if (c.address && !m.q('#n_addr').value.trim()) m.q('#n_addr').value = c.address;
        selectedBox.querySelector('#n_useNew').onclick = () => { picked = null; selectedBox.classList.add('hidden'); newFields.classList.remove('hidden'); m.q('#n_customer').focus(); };
      }
      if (picked) showPicked(picked);
      OF.customerPicker({
        input: m.q('#n_customer'),
        results: m.q('#n_results'),
        onSelect: showPicked,
        onType: () => { picked = null; selectedBox.classList.add('hidden'); newFields.classList.remove('hidden'); },
      });
      m.q('#n_save').addEventListener('click', async()=>{
        const name = m.q('#n_customer').value.trim();
        const body={ customerId:picked?.id || null, customer:picked?undefined:{name,email:m.q('#n_email').value.trim(),phone:m.q('#n_phone').value.trim(),address:m.q('#n_addr').value.trim()},
          serviceId:+m.q('#n_service').value, date:m.q('#n_date').value, time:m.q('#n_time').value, serviceAddress:m.q('#n_addr').value.trim(), notes:m.q('#n_notes').value.trim(), notify:m.q('#n_notify').checked };
        if(!picked && !name) return OF.toast('Customer, date and time are required','error');
        if(!body.date||!body.time) return OF.toast('Customer, date and time are required','error');
        if(await doForce(force=>OF.post('/api/admin/appointments',{...body,force}))){ m.close(); OF.toast('Appointment created','ok'); refresh(); }
      });
    }

    function exportAppointments() {
      const p = listParams(0);
      p.delete('limit'); p.delete('offset');
      location.href = '/api/admin/appointments/export.csv?' + p;
    }

    OF.page({ active:'appointments', title:'Appointments', subtitle:'Jobs, requests & history', render: async (root, ctx) => {
      ctx.setActions(`<button class="btn btn-secondary btn-sm" id="exportBtn">Export CSV</button><button class="btn btn-primary btn-sm" id="newBtn">${OF.icon('plus',15)} New appointment</button>`);
      root.innerHTML = `<div class="row between wrap" style="margin-bottom:16px;gap:10px">
        <div class="row wrap" id="chips" style="gap:8px"></div>
        ${OF.searchInput({ placeholder:'Search name or email…', value: state.q })}
      </div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('newBtn').onclick=()=>newAppointment();
      document.getElementById('exportBtn').onclick=exportAppointments;
      document.getElementById('search').addEventListener('input', OF.debounce((e)=>{ state.q=e.target.value.trim(); refresh(); },300));
      await refresh();
      const id = OF.qs('id'); if (id) openDrawer(id);
      if (OF.qs('new')) {
        const cid = OF.qs('customer');
        if (cid) {
          try { const c = (await OF.get('/api/admin/customers/'+cid)).customer; newAppointment({ customerId:+cid, name:c.name, address:c.address||'' }); }
          catch { newAppointment({ name: OF.qs('name') || '' }); }
        } else newAppointment({ name: OF.qs('name') || '' });
      }
    }});
  
