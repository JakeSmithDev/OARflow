// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let SERVICES = [];
    let TECHS = null;
    const state = { status: 'all', q: '' };

    async function loadServices() { if (!SERVICES.length) SERVICES = (await OF.get('/api/admin/appointments/meta/services')).services; return SERVICES; }
    async function loadTechs() { if (!TECHS) TECHS = (await OF.get('/api/admin/technicians')).technicians; return TECHS; }
    function techChip(t) { return `<span class="badge no-dot" style="background:${t.color}1a;color:${t.color}">${t.is_lead ? '★ ' : ''}${OF.escape(t.name)}</span>`; }

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

    async function refresh() {
      const params = new URLSearchParams({ status: state.status });
      if (state.q) params.set('q', state.q);
      const d = await OF.get('/api/admin/appointments?' + params);
      const c = d.counts;
      document.getElementById('chips').innerHTML =
        chip('all','All',c.all)+chip('requested','Requested',c.requested||0)+chip('scheduled','Scheduled',c.scheduled||0)+chip('completed','Completed',c.completed||0)+chip('canceled','Canceled',c.canceled||0);
      document.querySelectorAll('#chips .chip').forEach(b=>b.onclick=()=>{ state.status=b.dataset.status; refresh(); });
      const rows = d.appointments;
      document.getElementById('list').innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Status</th><th class="right">Price</th></tr></thead>
        <tbody>${rows.map(a=>`<tr class="clickable" data-id="${a.id}">
          <td class="nowrap">${a.scheduled_start?`<span class="cell-strong">${OF.date(a.scheduled_start)}</span><div class="tiny muted">${OF.time(a.scheduled_start)}</div>`:`<span class="muted">${a.status==='requested'?'Requested':'—'}</span>`}</td>
          <td><div class="cell-strong">${OF.escape(a.customer_name)}</div><div class="tiny muted">${OF.escape(a.service_address||a.customer_email||'')}</div></td>
          <td>${a.service_name?`<span class="badge no-dot" style="background:${a.service_color}1a;color:${a.service_color}">${OF.escape(a.service_name)}</span>`:'—'}</td>
          <td>${OF.statusBadge(a.status)}</td>
          <td class="right mono">${OF.money(a.price_cents)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('appointments',22)}</div><p>No appointments found.</p></div>`;
      document.querySelectorAll('#list tr[data-id]').forEach(r=>r.onclick=()=>openDrawer(r.dataset.id));
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
            ${slots.length?slots.map((s,i)=>`<label class="row" style="gap:10px;padding:8px 0;cursor:pointer"><input type="radio" name="slot" value="${i}" style="width:auto"><b>${OF.dateTime(s.start)}</b></label>`).join(''):'<p class="muted small">No proposed times.</p>'}
            <button class="btn btn-primary btn-block" id="confirmBtn" style="margin-top:10px">Confirm appointment</button></div>`:''}
          ${a.status!=='canceled'?`<div class="card card-pad" style="margin-bottom:16px"><div class="row between" style="margin-bottom:8px"><h4 style="margin:0">Assigned crew</h4><button class="btn btn-ghost btn-xs" id="assignBtn">Assign</button></div>
            <div id="crewBox" class="row wrap" style="gap:6px">${crew.length?crew.map(techChip).join(''):'<span class="muted small">No one assigned yet.</span>'}</div></div>`:''}
          <div class="card card-pad" style="margin-bottom:16px"><div class="row between" style="margin-bottom:8px"><h4 style="margin:0">Photos &amp; files</h4><label class="btn btn-ghost btn-xs" style="cursor:pointer">Upload<input type="file" id="fileInput" accept="image/*,application/pdf" multiple hidden></label></div>
            <div id="filesBox">${filesHtml(jobFiles)}</div></div>
          <div class="field"><label>Internal notes</label><textarea id="internalNotes">${OF.escape(a.internal_notes||'')}</textarea></div>
          <button class="btn btn-secondary btn-sm" id="saveNotes">Save notes</button>
          <hr class="divider">
          <div class="stack">
            ${!isReq && a.status!=='canceled'?`<div class="card card-pad"><h4 style="margin-bottom:10px">Reschedule</h4>
              <div class="grid cols-2"><div class="field"><label>Date</label><input type="date" id="rDate"></div><div class="field"><label>Time</label><input type="time" id="rTime"></div></div>
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
      dr.q('#confirmBtn')?.addEventListener('click', async()=>{ const sel=dr.el.querySelector('input[name=slot]:checked'); if(!sel) return OF.toast('Pick a time first','error'); if(await doForce(force=>OF.post(`/api/admin/appointments/${id}/confirm`,{slotIndex:+sel.value,notify:true,force}))){ OF.toast('Confirmed & customer notified','ok'); reload(); } });
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
          <span class="row" style="gap:10px"><input type="checkbox" class="tk" data-id="${t.id}" ${sel.has(t.id) ? 'checked' : ''} style="width:auto"><span class="badge no-dot" style="background:${t.color}1a;color:${t.color}">${OF.escape(t.name)}</span></span>
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

    async function newAppointment(prefill={}) {
      await loadServices();
      const m = OF.modal(`
        <div class="modal-head"><h3>New appointment</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Customer name *</label><input id="n_name" value="${OF.escape(prefill.name||'')}"></div>
          <div class="grid cols-2"><div class="field"><label>Email</label><input id="n_email" type="email"></div><div class="field"><label>Phone</label><input id="n_phone" type="tel"></div></div>
          <div class="field"><label>Service</label><select id="n_service">${SERVICES.map(s=>`<option value="${s.id}">${OF.escape(s.name)} · ${OF.money(s.base_price_cents)}</option>`).join('')}</select></div>
          <div class="grid cols-2"><div class="field"><label>Date *</label><input id="n_date" type="date"></div><div class="field"><label>Time *</label><input id="n_time" type="time" value="09:00"></div></div>
          <div class="field"><label>Service address</label><input id="n_addr"></div>
          <div class="field"><label>Notes</label><textarea id="n_notes"></textarea></div>
          <label class="row" style="gap:8px"><input type="checkbox" id="n_notify" checked style="width:auto"> Email confirmation to customer</label>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="n_save">Create appointment</button></div>`);
      m.q('#n_save').addEventListener('click', async()=>{
        const body={ customer:{name:m.q('#n_name').value.trim(),email:m.q('#n_email').value.trim(),phone:m.q('#n_phone').value.trim(),address:m.q('#n_addr').value.trim()},
          serviceId:+m.q('#n_service').value, date:m.q('#n_date').value, time:m.q('#n_time').value, serviceAddress:m.q('#n_addr').value.trim(), notes:m.q('#n_notes').value.trim(), notify:m.q('#n_notify').checked };
        if(!body.customer.name||!body.date||!body.time) return OF.toast('Name, date and time are required','error');
        if(await doForce(force=>OF.post('/api/admin/appointments',{...body,force}))){ m.close(); OF.toast('Appointment created','ok'); refresh(); }
      });
    }

    OF.page({ active:'appointments', title:'Appointments', subtitle:'Jobs, requests & history', render: async (root, ctx) => {
      ctx.setActions(`<button class="btn btn-primary btn-sm" id="newBtn">${OF.icon('plus',15)} New appointment</button>`);
      root.innerHTML = `<div class="row between wrap" style="margin-bottom:16px;gap:10px">
        <div class="row wrap" id="chips" style="gap:8px"></div>
        <div class="input-prefix" style="max-width:280px">${OF.icon('search',16).replace('<svg','<svg style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted)"')}<input id="search" placeholder="Search name or email…" style="padding-left:34px"></div>
      </div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('newBtn').onclick=()=>newAppointment();
      document.getElementById('search').addEventListener('input', OF.debounce((e)=>{ state.q=e.target.value.trim(); refresh(); },300));
      await refresh();
      const id = OF.qs('id'); if (id) openDrawer(id);
      if (OF.qs('new')) newAppointment();
    }});
  