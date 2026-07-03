// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    async function load(root) {
      const d = await OF.get('/api/admin/appointments?status=requested&limit=100');
      const fu = await OF.get('/api/admin/follow-ups?status=pending').catch(() => ({ followUps: [] }));
      const reschedules = (fu.followUps || []).filter(f => f.created_by === 'public_reschedule' || /^Reschedule request/i.test(f.title || ''));
      const rows = d.appointments;
      if (!rows.length && !reschedules.length) { root.innerHTML = `<div class="card"><div class="empty"><div class="ic">${OF.icon('check',22)}</div><p>No pending requests. You're all caught up.</p></div></div>`; return; }
      const rescheduleHtml = reschedules.length ? `<div class="card card-pad">
        <div class="row between" style="margin-bottom:8px"><h3 style="font-size:16px">Reschedule requests</h3><span class="badge warn no-dot">${reschedules.length}</span></div>
        ${reschedules.map(f=>`<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--line-2)">
          <div><div class="cell-strong">${OF.escape(f.customer_name||'Customer')}</div><div class="small muted" style="white-space:pre-wrap">${OF.escape(f.note||f.title||'')}</div></div>
          <div class="row" style="gap:8px"><a class="btn btn-secondary btn-sm" href="/admin/appointments?id=${f.appointment_id}">Appointment</a><button class="btn btn-primary btn-sm" data-fu-done="${f.id}">Done</button></div>
        </div>`).join('')}
      </div>` : '';
      root.innerHTML = `<div class="stack">${rescheduleHtml}` + rows.map(a => {
        const slots = (a.requested_slots||[]);
        const color = OF.color(a.service_color);
        return `<div class="card card-pad" data-id="${a.id}">
          <div class="row between" style="margin-bottom:6px"><div><span class="cell-strong" style="font-size:16px">${OF.escape(a.customer_name)}</span>
            <span class="badge no-dot" style="margin-left:8px;background:${color}1a;color:${color}">${OF.escape(a.service_name||'Service')}</span></div>
            <span class="tiny muted">Requested ${OF.date(a.created_at)}</span></div>
          <div class="small muted" style="margin-bottom:10px">${OF.escape(a.service_address||'')}${a.customer_phone?` · ${OF.escape(a.customer_phone)}`:''}${a.customer_email?` · ${OF.escape(a.customer_email)}`:''}</div>
          ${a.notes?`<p class="small" style="background:var(--surface-2);padding:8px 12px;border-radius:8px;margin:0 0 12px">${OF.escape(a.notes)}</p>`:''}
          <div class="muted tiny" style="margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;font-weight:700">Proposed times — pick one to confirm</div>
          <div class="row wrap" style="gap:8px">
            ${slots.map((s,i)=>`<button class="chip slotpick" data-id="${a.id}" data-i="${i}">${OF.date(s.start)} · ${OF.time(s.start)}</button>`).join('')}
          </div>
          ${slots.length?'':`<div class="grid cols-2" style="margin-top:10px"><div class="field" style="margin:0"><label>Date</label><input type="date" class="manual_date" data-id="${a.id}"></div><div class="field" style="margin:0"><label>Time</label><input type="time" class="manual_time" data-id="${a.id}"></div></div>`}
          <div class="row" style="margin-top:14px;gap:8px">
            <button class="btn btn-primary btn-sm confirmBtn" data-id="${a.id}" data-label="${slots.length?'Confirm selected':'Confirm time'}" disabled>${OF.icon('check',15)} ${slots.length?'Confirm selected':'Confirm time'}</button>
            <button class="btn btn-danger-soft btn-sm declineBtn" data-id="${a.id}">Decline</button>
            <a class="btn btn-ghost btn-sm" href="/admin/appointments?id=${a.id}">Details</a>
          </div></div>`;
      }).join('') + `</div>`;

      const picks = {};
      root.querySelectorAll('.slotpick').forEach(b=>b.onclick=()=>{
        const id=b.dataset.id;
        root.querySelectorAll(`.slotpick[data-id="${id}"]`).forEach(x=>x.classList.remove('active'));
        b.classList.add('active'); picks[id]=+b.dataset.i;
        root.querySelector(`.confirmBtn[data-id="${id}"]`).disabled=false;
      });
      root.querySelectorAll('.manual_date,.manual_time').forEach(inp=>inp.oninput=()=>{
        const id=inp.dataset.id;
        const date=root.querySelector(`.manual_date[data-id="${id}"]`).value;
        const time=root.querySelector(`.manual_time[data-id="${id}"]`).value;
        root.querySelector(`.confirmBtn[data-id="${id}"]`).disabled=!(date&&time);
      });
      root.querySelectorAll('.confirmBtn').forEach(b=>b.onclick=async()=>{
        const id=b.dataset.id;
        const date=root.querySelector(`.manual_date[data-id="${id}"]`)?.value;
        const time=root.querySelector(`.manual_time[data-id="${id}"]`)?.value;
        const hasManual=date&&time;
        if(picks[id]==null && !hasManual) return;
        b.disabled=true; b.textContent='Confirming…';
        const send=(force)=>OF.post(`/api/admin/appointments/${id}/confirm`,picks[id]!=null?{slotIndex:picks[id],notify:true,force}:{date,time,notify:true,force});
        try { await send(false); OF.toast('Confirmed & customer notified','ok'); load(root); }
        catch(e){
          const warn = e.code==='SCHEDULE_WARN' || e.code==='SLOT_FULL';
          if(warn && await OF.confirm({title:'Heads up',body:`<p class="muted">${OF.escape(e.message)}</p>`,confirmText:'Confirm anyway'})){
            try{ await send(true); OF.toast('Confirmed & customer notified','ok'); load(root); return; }catch(e2){ OF.toast(e2.message,'error'); }
          } else if(!warn){ OF.toast(e.message,'error'); }
          b.disabled=false; b.textContent=b.dataset.label||'Confirm selected';
        }
      });
      root.querySelectorAll('.declineBtn').forEach(b=>b.onclick=async()=>{
        const id=b.dataset.id;
        if(!(await OF.confirm({title:'Decline request?',body:'<p class="muted">This cancels the request. The customer can be notified.</p>',confirmText:'Decline',danger:true}))) return;
        await OF.patch('/api/admin/appointments/'+id,{status:'canceled',notify:true}); OF.toast('Request declined','ok'); load(root);
      });
      root.querySelectorAll('[data-fu-done]').forEach(b=>b.onclick=async()=>{ await OF.patch('/api/admin/follow-ups/'+b.dataset.fuDone,{status:'done'}); OF.toast('Request completed','ok'); load(root); });
    }

    OF.page({ active:'requests', title:'Requests', subtitle:'Booking requests awaiting your confirmation',
      render: async (root) => { await load(root); } });
  
