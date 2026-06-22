// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    const TZ = () => OF.tenant.timezone;
    let view = OF.qs('view') || 'week';
    let techFilter = '';
    let TECHS = null;
    let cursor = OF.qs('date') || new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

    const ymdUTC = (d) => new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
    const addYmd = (ymd,n) => ymdUTC(new Date(new Date(ymd+'T00:00:00Z').getTime()+n*86400000));
    const dowOf = (ymd) => new Date(ymd+'T00:00:00Z').getUTCDay();
    const tzYmd = (iso) => new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
    const tzHm = (iso) => new Intl.DateTimeFormat('en-GB',{timeZone:TZ(),hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
    const labelYmd = (ymd,opts) => new Intl.DateTimeFormat('en-US',{timeZone:'UTC',...opts}).format(new Date(ymd+'T12:00:00Z'));
    const todayYmd = () => new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

    function rangeFor() {
      if (view==='day') return { from: addYmd(cursor,-1), to: addYmd(cursor,2), cells:[cursor] };
      if (view==='week') { const start = addYmd(cursor,-dowOf(cursor)); const cells=[...Array(7)].map((_,i)=>addYmd(start,i)); return { from: addYmd(start,-1), to: addYmd(start,8), cells }; }
      // month
      const first = cursor.slice(0,8)+'01'; const gridStart = addYmd(first,-dowOf(first));
      const cells=[...Array(42)].map((_,i)=>addYmd(gridStart,i)); return { from: addYmd(gridStart,-1), to: addYmd(gridStart,43), cells };
    }

    function normYmd(v){ return typeof v==='string' ? v.slice(0,10) : ymdUTC(new Date(v)); }
    function dayMeta(d, data) {
      const ov = (data.overrides||[]).find(o=>normYmd(o.service_date)===d);
      const cap = ov && Number.isInteger(ov.capacity) ? ov.capacity : data.capacity;
      let closed = !!(ov && ov.is_closed);
      // any blackout overlapping this calendar day
      const ds = new Date(d+'T00:00:00Z').getTime(); const de = ds+86400000;
      if ((data.blackouts||[]).some(b=> new Date(b.starts_at).getTime() < de && new Date(b.ends_at).getTime() > ds)) closed = true;
      return { capacity: cap, closed };
    }
    // max concurrent appointments in a day (sweep line)
    function loadOf(appts) {
      const ev=[]; appts.forEach(a=>{ ev.push([new Date(a.scheduled_start).getTime(),1]); ev.push([new Date(a.scheduled_end).getTime(),-1]); });
      ev.sort((x,y)=>x[0]-y[0]||x[1]-y[1]); let c=0,max=0; for(const [,k] of ev){ c+=k; if(c>max)max=c; } return max;
    }
    function capPill(jobs, max, cap, closed) {
      if (closed) return `<span class="cap-pill" style="background:var(--surface-2);color:var(--muted)">Closed</span>`;
      if (!jobs) return `<span class="cap-pill" style="background:var(--surface-2);color:var(--muted)">Open</span>`;
      if (max>cap) return `<span class="cap-pill" style="background:var(--danger-tint);color:var(--danger)">Over capacity</span>`;
      if (max>=cap) return `<span class="cap-pill" style="background:var(--warn-tint);color:var(--warn)">Full</span>`;
      return `<span class="cap-pill" style="background:var(--ok-tint);color:#15803d">${jobs} job${jobs>1?'s':''}</span>`;
    }

    async function routeModal() {
      if (!TECHS || !TECHS.length) { OF.toast('Add a technician first', 'error'); return; }
      let techId = techFilter || (TECHS[0] && TECHS[0].id);
      const day = view === 'day' ? cursor : (view === 'week' ? cursor : cursor);
      const m = OF.modal(`<div class="modal-head"><h3>Optimize route</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="min-height:120px">
          <div class="grid cols-2"><div class="field"><label>Technician</label><select id="rt_tech">${TECHS.map(t=>`<option value="${t.id}" ${String(t.id)===String(techId)?'selected':''}>${OF.escape(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input type="date" id="rt_date" value="${day}"></div></div>
          <div id="rt_out"><p class="muted small">Choose a technician and date, then optimize.</p></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="rt_go">Optimize</button></div>`, { wide:true });
      async function run() {
        const t = m.q('#rt_tech').value; const dt = m.q('#rt_date').value;
        m.q('#rt_out').innerHTML = '<div class="loading-page" style="min-height:80px"><span class="spinner"></span></div>';
        const d = await OF.get(`/api/admin/routing?technicianId=${t}&date=${dt}`);
        if (!d.stops.length) { m.q('#rt_out').innerHTML = '<p class="muted small">No stops for this technician on this day.</p>'; return; }
        m.q('#rt_out').innerHTML = `${d.optimized?`<div class="badge ok no-dot" style="margin-bottom:8px">Optimized · ${d.totalMiles} mi</div>`:`<p class="tiny muted">${OF.escape(d.reason||'')}</p>`}
          <ol style="padding-left:18px;margin:8px 0">${d.stops.map(s=>`<li style="padding:5px 0"><b>${s.time?OF.time(s.time):''}</b> ${OF.escape(s.customerName)}<div class="tiny muted">${OF.escape(s.address||'No address')}</div></li>`).join('')}</ol>
          ${d.mapsUrl?`<a class="btn btn-primary btn-block" href="${d.mapsUrl}" target="_blank" rel="noopener">${OF.icon('pin',15)} Open route in Google Maps</a>`:''}`;
      }
      m.q('#rt_go').onclick = run;
      run();
    }

    let currentRoot;
    async function render(root) {
      currentRoot = root;
      const r = rangeFor();
      let title = '';
      if (view==='day') title = labelYmd(cursor,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
      else if (view==='week') title = `${labelYmd(r.cells[0],{month:'short',day:'numeric'})} – ${labelYmd(r.cells[6],{month:'short',day:'numeric',year:'numeric'})}`;
      else title = labelYmd(cursor,{month:'long',year:'numeric'});

      root.innerHTML = `
        <div class="sched-toolbar">
          <button class="arrow" id="prev">‹</button><button class="arrow" id="next">›</button>
          <button class="btn btn-secondary btn-sm" id="today">Today</button>
          <button class="btn btn-secondary btn-sm" id="routeBtn" title="Optimize the selected technician's route">${OF.icon('pin',14)} Route</button>
          <span class="sched-title">${title}</span>
          <select id="techfilter" style="margin-left:auto;max-width:190px"><option value="">All technicians</option></select>
          <div class="segmented" id="viewseg">
            ${['day','week','month'].map(v=>`<button data-v="${v}" class="${view===v?'active':''}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}
          </div>
        </div>
        <div id="body"><div class="loading-page"><span class="spinner"></span></div></div>`;
      if (!TECHS) { try { TECHS = (await OF.get('/api/admin/technicians')).technicians; } catch { TECHS = []; } }
      const tf = document.getElementById('techfilter');
      if (tf) { tf.innerHTML = `<option value="">All technicians</option>` + TECHS.map(t=>`<option value="${t.id}" ${String(techFilter)===String(t.id)?'selected':''}>${t.name}</option>`).join(''); tf.onchange=()=>{ techFilter=tf.value; render(root); }; }
      const step = view==='day'?1:view==='week'?7:0;
      document.getElementById('prev').onclick=()=>{ cursor = view==='month'? addMonth(-1): addYmd(cursor,-step); render(root); };
      document.getElementById('next').onclick=()=>{ cursor = view==='month'? addMonth(1): addYmd(cursor,step); render(root); };
      document.getElementById('today').onclick=()=>{ cursor=todayYmd(); render(root); };
      document.getElementById('routeBtn').onclick=()=>routeModal();
      document.querySelectorAll('#viewseg [data-v]').forEach(b=>b.onclick=()=>{ view=b.dataset.v; render(root); });

      const data = await OF.get(`/api/admin/appointments/calendar?from=${r.from}T00:00:00.000Z&to=${r.to}T00:00:00.000Z`);
      if (techFilter) data.appointments = data.appointments.filter(a=>(a.technicians||[]).some(t=>String(t.id)===String(techFilter)));
      const byDay = {}; data.appointments.forEach(a=>{ const k=tzYmd(a.scheduled_start); (byDay[k]=byDay[k]||[]).push(a); });
      const body = document.getElementById('body');
      if (view==='day') renderDay(body, byDay[cursor]||[], dayMeta(cursor,data));
      else if (view==='week') renderWeek(body, r.cells, byDay, data);
      else renderMonth(body, r.cells, byDay, data, cursor.slice(0,7));
    }
    function addMonth(n){ const [y,m]=cursor.split('-').map(Number); const d=new Date(Date.UTC(y,m-1+n,1)); return ymdUTC(d); }

    function techTag(a){ const lead=(a.technicians||[]).find(t=>t.is_lead)||(a.technicians||[])[0]; if(!lead) return ''; const extra=(a.technicians||[]).length-1; return `<div style="font-size:11px;margin-top:2px"><span class="m-dot" style="background:${lead.color};display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px"></span>${OF.escape(lead.name)}${extra>0?` +${extra}`:''}</div>`; }
    function jobRowSmall(a){ const movable = a.status!=='completed' && a.status!=='canceled'; return `<div class="wc-job${movable?' movable':''}" ${movable?`draggable="true" data-id="${a.id}" data-time="${tzHm(a.scheduled_start)}"`:''} style="border-left-color:${(((a.technicians||[]).find(t=>t.is_lead)||{}).color)||a.service_color||'var(--brand)'}" onclick="OF.go('/admin/appointments?id=${a.id}')"><b>${OF.time(a.scheduled_start)}</b> ${OF.escape(a.customer_name)}<div class="muted" style="font-size:11px">${OF.escape(a.service_name||'')}</div>${techTag(a)}</div>`; }

    function renderDay(body, appts, meta) {
      const max = loadOf(appts);
      const head = `<div class="card-head"><h3>${appts.length} appointment${appts.length===1?'':'s'}</h3><span style="margin-left:auto">${capPill(appts.length,max,meta.capacity,meta.closed)}</span></div>`;
      if (!appts.length) { body.innerHTML = `<div class="card">${head}<div class="empty"><div class="ic">${OF.icon('schedule',22)}</div><p>${meta.closed?'This day is marked closed.':'Nothing scheduled.'} <a href="/admin/appointments?new=1">Add a job</a>.</p></div></div>`; return; }
      body.innerHTML = `<div class="card">${head}<div class="card-pad agenda">` + appts.sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start)).map(a=>`
        <div class="slot-row"><div class="time">${OF.time(a.scheduled_start)}</div>
        <div class="job" style="border-left-color:${a.service_color||'var(--brand)'}" onclick="OF.go('/admin/appointments?id=${a.id}')">
          <div class="row between"><span class="cell-strong">${OF.escape(a.customer_name)}</span>${OF.statusBadge(a.status)}</div>
          <div class="small muted" style="margin-top:3px">${a.service_name?OF.escape(a.service_name):''}${a.service_address?` · ${OF.escape(a.service_address)}`:''}</div>
        </div></div>`).join('') + `</div></div>`;
    }

    function renderWeek(body, cells, byDay, data) {
      body.innerHTML = `<div class="tiny muted" style="margin:-2px 0 8px">Tip: drag a job to another day to reschedule.</div><div class="week-grid">` + cells.map(d=>{
        const appts=(byDay[d]||[]).sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start));
        const meta=dayMeta(d,data); const max=loadOf(appts); const isToday=d===todayYmd();
        return `<div class="week-col ${meta.closed?'closed':''} ${isToday?'today':''}" data-ymd="${d}">
          <div class="wc-head" style="cursor:pointer" onclick="window.__schedGo('${d}')"><span>${labelYmd(d,{weekday:'short'})}</span><span>${labelYmd(d,{day:'numeric'})}</span></div>
          <div class="wc-body">${appts.map(jobRowSmall).join('')||'<span class="muted" style="font-size:11px;padding:4px">—</span>'}</div>
          <div class="wc-foot">${capPill(appts.length,max,meta.capacity,meta.closed)}<span class="muted">cap ${meta.capacity}</span></div>
        </div>`;
      }).join('') + `</div>`;
      bindDragDrop(body);
    }

    // Drag a job onto another day to reschedule (keeps the original time of day).
    async function moveAppt(id, ymd, time) {
      const attempt = (force) => OF.patch(`/api/admin/appointments/${id}`, { date: ymd, time, force });
      try { await attempt(false); OF.toast('Appointment moved ✓', 'ok'); render(currentRoot); }
      catch (e) {
        if (e.code === 'SCHEDULE_WARN' || e.code === 'SLOT_FULL') {
          if (await OF.confirm({ title: 'Heads up', body: `<p class="muted">${OF.escape(e.message)}</p>`, confirmText: 'Move anyway' })) {
            try { await attempt(true); OF.toast('Appointment moved ✓', 'ok'); render(currentRoot); } catch (e2) { OF.toast(e2.message, 'error'); }
          }
        } else OF.toast(e.message, 'error');
      }
    }
    function bindDragDrop(body) {
      let dragId = null; let dragTime = null;
      body.querySelectorAll('.wc-job.movable').forEach((el) => {
        el.addEventListener('dragstart', (e) => { dragId = el.dataset.id; dragTime = el.dataset.time; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', el.dataset.id); });
        el.addEventListener('dragend', () => { el.classList.remove('dragging'); body.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target')); });
      });
      body.querySelectorAll('.week-col').forEach((col) => {
        col.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); col.classList.add('drop-target'); });
        col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
        col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop-target'); const id = dragId; const time = dragTime; const ymd = col.dataset.ymd; dragId = null; dragTime = null; if (id && ymd) moveAppt(id, ymd, time); });
      });
    }

    function renderMonth(body, cells, byDay, data, ymPrefix) {
      const dows=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      body.innerHTML = `<div class="month-grid" style="margin-bottom:6px">${dows.map(d=>`<div class="month-dow">${d}</div>`).join('')}</div>
        <div class="month-grid">` + cells.map(d=>{
        const appts=byDay[d]||[]; const meta=dayMeta(d,data); const out=!d.startsWith(ymPrefix); const isToday=d===todayYmd(); const max=loadOf(appts);
        const dots = appts.slice(0,5).map(a=>`<span class="m-dot" style="background:${a.service_color||'var(--brand)'}"></span>`).join('');
        return `<div class="m-cell ${out?'out':''} ${meta.closed?'closed':''} ${isToday?'today':''}" onclick="window.__schedGo('${d}')">
          <div class="row between"><span class="m-num">${labelYmd(d,{day:'numeric'})}</span>${appts.length?(max>meta.capacity?`<span class="cap-pill" style="background:var(--danger-tint);color:var(--danger)">${appts.length}</span>`:`<span class="cap-pill" style="background:var(--brand-tint);color:var(--brand-700)">${appts.length}</span>`):''}</div>
          <div class="m-dots">${dots}</div>
        </div>`;
      }).join('') + `</div>`;
    }

    OF.page({ active:'schedule', title:'Schedule', subtitle:'Day, week & month — with capacity at a glance', render: async (root, ctx) => {
      ctx.setActions(`<a class="btn btn-primary btn-sm" href="/admin/appointments?new=1">${OF.icon('plus',15)} New appointment</a>`);
      window.render = render; // allow inline onclick handlers to re-render
      await render(root);
    }});
  
    window.__schedGo = (d) => { view = 'day'; cursor = d; render(document.getElementById('content')); };
