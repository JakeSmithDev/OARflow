// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let S = null; let tab = OF.qs('tab') || 'business';
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dollars = c => ((c||0)/100).toFixed(2);
    const toCents = v => Math.round((parseFloat(String(v).replace(/[^0-9.\-]/g,''))||0)*100);
    const TABS = [['business','Business'],['booking','Booking & Availability'],['services','Services'],['invoicing','Invoicing'],['integrations','Integrations'],['email','Email templates'],['team','Team']];

    function field(label, inner, hint){ return `<div class="field"><label>${label}</label>${inner}${hint?`<span class="hint">${hint}</span>`:''}</div>`; }
    function card(title, inner, actions){ return `<div class="card" style="margin-bottom:18px"><div class="card-head"><h3>${title}</h3>${actions?`<div class="actions">${actions}</div>`:''}</div><div class="card-pad">${inner}</div></div>`; }

    // ---- Business ----
    function businessTab(root){
      const p = S.profile, b = S.settings.branding;
      root.innerHTML = card('Business profile', `
        ${field('Business name', `<input id="p_name" value="${OF.escape(p.name)}">`)}
        <div class="grid cols-2">${field('Contact email', `<input id="p_email" value="${OF.escape(p.contactEmail||'')}">`)}${field('Contact phone', `<input id="p_phone" value="${OF.escape(p.contactPhone||'')}">`)}</div>
        ${field('Address', `<input id="p_addr" value="${OF.escape(p.address||'')}">`)}
        <div class="grid cols-2">${field('Timezone', `<input id="p_tz" value="${OF.escape(p.timezone)}">`,'IANA name e.g. America/New_York')}${field('Currency', `<input id="p_cur" value="${OF.escape(p.currency)}">`)}</div>
        <button class="btn btn-primary" id="saveProfile">Save profile</button>`)
        + card('Branding', `
        ${field('Display name (header & emails)', `<input id="b_logo" value="${OF.escape(b.logoText||'')}">`)}
        ${field('Tagline', `<input id="b_tag" value="${OF.escape(b.tagline||'')}">`)}
        <div class="grid cols-2">${field('Brand color', `<input id="b_color" type="color" value="${b.primaryColor||'#0e7c4b'}" style="height:42px;padding:4px">`)}${field('Support phone (public)', `<input id="b_phone" value="${OF.escape(b.supportPhone||'')}">`)}</div>
        <button class="btn btn-primary" id="saveBrand">Save branding</button>`);
      root.querySelector('#saveProfile').onclick=async()=>{await OF.patch('/api/admin/settings/profile',{name:root.querySelector('#p_name').value,contactEmail:root.querySelector('#p_email').value,contactPhone:root.querySelector('#p_phone').value,address:root.querySelector('#p_addr').value,timezone:root.querySelector('#p_tz').value,currency:root.querySelector('#p_cur').value});OF.toast('Saved','ok');};
      root.querySelector('#saveBrand').onclick=async()=>{await OF.put('/api/admin/settings/settings',{branding:{logoText:root.querySelector('#b_logo').value,tagline:root.querySelector('#b_tag').value,primaryColor:root.querySelector('#b_color').value,supportPhone:root.querySelector('#b_phone').value}});OF.toast('Saved','ok');};
    }

    // ---- Booking & availability ----
    function bookingTab(root){
      const bk = S.settings.booking, av = S.settings.availability;
      const rem = (S.settings.notifications && S.settings.notifications.appointmentReminder) || { enabled:true, leadHours:24 };
      const wins = JSON.parse(JSON.stringify(av.windows || []));
      const hoursRows = DAYS.map((d,i)=>{ const w=(av.hours[i]||av.hours[String(i)]||[])[0]; const closed=!w;
        return `<div class="daygrid"><span style="font-weight:600">${d}</span>
          <input type="time" class="h_start" data-d="${i}" value="${w?w.start:'08:00'}" ${closed?'disabled':''}>
          <input type="time" class="h_end" data-d="${i}" value="${w?w.end:'17:00'}" ${closed?'disabled':''}>
          <label class="row" style="gap:6px"><input type="checkbox" class="h_closed" data-d="${i}" ${closed?'checked':''} style="width:auto"> Closed</label></div>`;}).join('');
      root.innerHTML = card('Booking', `
        <div class="grid cols-2">
          ${field('Default booking mode', `<select id="bk_mode"><option value="instant" ${bk.defaultMode==='instant'?'selected':''}>Instant — book the slot</option><option value="request" ${bk.defaultMode==='request'?'selected':''}>Request — customer proposes times</option></select>`,'Per-service modes override this.')}
          ${field('Proposed times to request', `<input id="bk_count" type="number" min="1" max="6" value="${bk.requestSlotCount}">`)}
        </div>
        <div class="grid cols-2">${field('Lead time (hours)', `<input id="bk_lead" type="number" min="0" value="${bk.leadTimeHours}">`,'Earliest a customer can book from now.')}${field('Book up to (days out)', `<input id="bk_max" type="number" min="1" value="${bk.maxDaysOut}">`)}</div>
        <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="bk_addr" ${bk.collectAddress?'checked':''} style="width:auto"> Require a service address at booking</label>
        ${field('Confirmation message', `<textarea id="bk_msg">${OF.escape(bk.confirmationMessage||'')}</textarea>`)}
        <button class="btn btn-primary" id="saveBooking">Save booking settings</button>
        <p class="hint" style="margin-top:10px">Individual services can override this default. <button class="link-btn" type="button" id="applyDefaultMode">Make all services use this default →</button></p>`)
        + card('Appointment reminders', `
        <p class="muted small" style="margin-top:0">Automatically email customers a reminder before their visit. This is separate from invoicing — reminders never mention a balance.</p>
        <label class="row" style="gap:8px;margin-bottom:12px"><input type="checkbox" id="rem_on" ${rem.enabled?'checked':''} style="width:auto"> Send appointment reminder emails</label>
        ${field('Send how many hours before', `<input id="rem_lead" type="number" min="1" max="168" value="${rem.leadHours||24}">`,'e.g. 24 = the day before. Sent by the daily job.')}
        <button class="btn btn-primary" id="saveReminders">Save reminders</button>`)
        + card('Availability', `
        ${field('How customers choose a time', `<select id="av_gran"><option value="slots" ${av.granularity!=='windows'?'selected':''}>Precise time slots (e.g. 10:00 AM)</option><option value="windows" ${av.granularity==='windows'?'selected':''}>Arrival windows (e.g. Morning 8–12)</option></select>`,'Applies to both instant and request bookings.')}
        <div id="winEditor" style="${av.granularity==='windows'?'':'display:none'};margin-bottom:12px">
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:4px 0 8px">Arrival windows</div>
          <div id="winRows"></div>
          <button class="btn btn-secondary btn-sm" type="button" id="addWin">${OF.icon('plus',14)} Add window</button>
        </div>
        <div class="grid cols-2">${field('Slot length (minutes)', `<input id="av_slot" type="number" min="15" step="15" value="${av.slotMinutes}">`,'Used for precise time slots when a service has no duration.')}${field('Crews / capacity', `<input id="av_cap" type="number" min="1" value="${av.capacityPerSlot}">`,'How many jobs can run in the same slot/window.')}</div>
        <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:10px 0 8px">Weekly hours</div>
        ${hoursRows}
        <button class="btn btn-primary" id="saveAvail" style="margin-top:8px">Save availability</button>`);
      root.querySelectorAll('.h_closed').forEach(c=>c.onchange=e=>{const d=e.target.dataset.d;root.querySelector(`.h_start[data-d="${d}"]`).disabled=e.target.checked;root.querySelector(`.h_end[data-d="${d}"]`).disabled=e.target.checked;});
      root.querySelector('#saveBooking').onclick=async()=>{await OF.put('/api/admin/settings/settings',{booking:{defaultMode:root.querySelector('#bk_mode').value,requestSlotCount:+root.querySelector('#bk_count').value,leadTimeHours:+root.querySelector('#bk_lead').value,maxDaysOut:+root.querySelector('#bk_max').value,collectAddress:root.querySelector('#bk_addr').checked,confirmationMessage:root.querySelector('#bk_msg').value}});OF.toast('Saved','ok');};
      root.querySelector('#applyDefaultMode').onclick=async()=>{ if(!(await OF.confirm({title:'Use default for all services?',body:'<p class="muted">Every service will follow the default booking mode above. You can still override individual services afterward.</p>',confirmText:'Apply to all'}))) return; const r=await OF.post('/api/admin/settings/services/use-default-mode'); OF.toast(`Updated ${r.updated} service(s)`,'ok'); };
      root.querySelector('#saveReminders').onclick=async()=>{await OF.put('/api/admin/settings/settings',{notifications:{appointmentReminder:{enabled:root.querySelector('#rem_on').checked,leadHours:+root.querySelector('#rem_lead').value||24}}});OF.toast('Saved','ok');};
      // Arrival-windows editor
      function drawWins(){
        const box=root.querySelector('#winRows'); if(!box) return;
        box.innerHTML = wins.map((w,i)=>`<div class="row" style="gap:8px;margin-bottom:8px;align-items:center">
          <input class="w_label" data-i="${i}" value="${OF.escape(w.label||'')}" placeholder="Label (e.g. Morning)" style="flex:1">
          <input class="w_start" data-i="${i}" type="time" value="${w.start||'08:00'}" style="width:130px">
          <span class="muted">to</span>
          <input class="w_end" data-i="${i}" type="time" value="${w.end||'12:00'}" style="width:130px">
          <button class="link-btn w_del" data-i="${i}" type="button" style="color:var(--danger)">Remove</button></div>`).join('') || '<p class="muted small">No windows yet — add one.</p>';
        box.querySelectorAll('.w_label').forEach(el=>el.oninput=e=>wins[+e.target.dataset.i].label=e.target.value);
        box.querySelectorAll('.w_start').forEach(el=>el.oninput=e=>wins[+e.target.dataset.i].start=e.target.value);
        box.querySelectorAll('.w_end').forEach(el=>el.oninput=e=>wins[+e.target.dataset.i].end=e.target.value);
        box.querySelectorAll('.w_del').forEach(el=>el.onclick=e=>{wins.splice(+e.target.dataset.i,1);drawWins();});
      }
      drawWins();
      root.querySelector('#addWin').onclick=()=>{wins.push({label:'',start:'09:00',end:'12:00'});drawWins();};
      root.querySelector('#av_gran').onchange=e=>{root.querySelector('#winEditor').style.display=e.target.value==='windows'?'':'none';};
      root.querySelector('#saveAvail').onclick=async()=>{const hours={};DAYS.forEach((_,i)=>{const closed=root.querySelector(`.h_closed[data-d="${i}"]`).checked;hours[i]=closed?[]:[{start:root.querySelector(`.h_start[data-d="${i}"]`).value,end:root.querySelector(`.h_end[data-d="${i}"]`).value}];});const windows=wins.filter(w=>w.label&&w.start&&w.end);await OF.put('/api/admin/settings/settings',{availability:{slotMinutes:+root.querySelector('#av_slot').value,capacityPerSlot:+root.querySelector('#av_cap').value,granularity:root.querySelector('#av_gran').value,windows,hours}});OF.toast('Saved','ok');};
      root.insertAdjacentHTML('beforeend','<div id="exceptions"><div class="loading-page"><span class="spinner"></span></div></div>');
      loadExceptions(root);
    }

    async function loadExceptions(root){
      const box = root.querySelector('#exceptions'); if(!box) return;
      const d = await OF.get('/api/admin/settings/availability-exceptions');
      const bkList = d.blackouts.map(b=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><span>${OF.dateLong(b.starts_at)}${(new Date(b.ends_at)-new Date(b.starts_at))>90000000?` – ${OF.dateLong(new Date(new Date(b.ends_at).getTime()-86400000))}`:''}${b.reason?` · ${OF.escape(b.reason)}`:''}</span><button class="link-btn" style="color:var(--danger)" data-bk="${b.id}">Remove</button></div>`).join('')||'<p class="muted small">No days off.</p>';
      const ovList = d.overrides.map(o=>`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-2)"><span>${OF.dateLong(o.service_date)} · ${o.is_closed?'<b>Closed</b>':(o.hours_json&&o.hours_json[0]?`${o.hours_json[0].start}–${o.hours_json[0].end}`:'Custom')}${o.capacity!=null?` · cap ${o.capacity}`:''}</span><button class="link-btn" style="color:var(--danger)" data-ov="${o.id}">Remove</button></div>`).join('')||'<p class="muted small">No special days.</p>';
      box.innerHTML = card('Days off &amp; holidays', `${bkList}<div class="row wrap" style="gap:8px;margin-top:10px;align-items:end"><div class="field" style="margin:0"><label>Date</label><input type="date" id="bk_date"></div><div class="field" style="margin:0"><label>Through (optional)</label><input type="date" id="bk_end"></div><div class="field" style="margin:0;flex:1"><label>Reason</label><input id="bk_reason" placeholder="Holiday, vacation…"></div><button class="btn btn-secondary" id="addBk">Add</button></div>`)
        + card('Special hours &amp; capacity', `${ovList}<div class="row wrap" style="gap:8px;margin-top:10px;align-items:end"><div class="field" style="margin:0"><label>Date</label><input type="date" id="ov_date"></div><label class="row" style="gap:6px"><input type="checkbox" id="ov_closed" style="width:auto"> Closed</label><div class="field" style="margin:0"><label>Open</label><input type="time" id="ov_start" value="09:00"></div><div class="field" style="margin:0"><label>Close</label><input type="time" id="ov_end" value="17:00"></div><div class="field" style="margin:0"><label>Capacity</label><input type="number" id="ov_cap" min="0" style="width:80px"></div><button class="btn btn-secondary" id="addOv">Add</button></div>`);
      box.querySelector('#addBk').onclick=async()=>{ const date=box.querySelector('#bk_date').value; if(!date) return OF.toast('Pick a date','error'); await OF.post('/api/admin/settings/blackouts',{date,endDate:box.querySelector('#bk_end').value||null,reason:box.querySelector('#bk_reason').value}); OF.toast('Day off added','ok'); loadExceptions(root); };
      box.querySelector('#addOv').onclick=async()=>{ const serviceDate=box.querySelector('#ov_date').value; if(!serviceDate) return OF.toast('Pick a date','error'); const closed=box.querySelector('#ov_closed').checked; await OF.post('/api/admin/settings/overrides',{serviceDate,isClosed:closed,hoursJson:closed?null:[{start:box.querySelector('#ov_start').value,end:box.querySelector('#ov_end').value}],capacity:box.querySelector('#ov_cap').value!==''?+box.querySelector('#ov_cap').value:null}); OF.toast('Special day saved','ok'); loadExceptions(root); };
      box.querySelectorAll('[data-bk]').forEach(b=>b.onclick=async()=>{ await OF.del('/api/admin/settings/blackouts/'+b.dataset.bk); OF.toast('Removed','ok'); loadExceptions(root); });
      box.querySelectorAll('[data-ov]').forEach(b=>b.onclick=async()=>{ await OF.del('/api/admin/settings/overrides/'+b.dataset.ov); OF.toast('Removed','ok'); loadExceptions(root); });
    }

    // ---- Services ----
    async function servicesTab(root){
      const { services } = await OF.get('/api/admin/settings/services');
      root.innerHTML = card('Services', services.map(s=>`<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div><span class="cell-strong">${OF.escape(s.name)}</span> ${s.is_active?'':'<span class="badge neutral no-dot">Inactive</span>'}<div class="tiny muted">${s.duration_minutes} min · ${OF.money(s.base_price_cents)} · ${s.booking_mode==='default'?'Default mode':s.booking_mode}</div></div>
        <div class="row" style="gap:6px"><span style="width:18px;height:18px;border-radius:5px;background:${s.color}"></span><button class="btn btn-secondary btn-sm" data-svc="${s.id}">Edit</button></div></div>`).join('') || '<p class="muted small">No services.</p>',
        `<button class="btn btn-primary btn-sm" id="addSvc">${OF.icon('plus',15)} Add service</button>`);
      root.querySelector('#addSvc').onclick=()=>svcModal();
      root.querySelectorAll('[data-svc]').forEach(b=>b.onclick=()=>svcModal(services.find(s=>s.id==b.dataset.svc)));
    }
    function svcModal(s){
      const m=OF.modal(`<div class="modal-head"><h3>${s?'Edit service':'New service'}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">${field('Name *',`<input id="s_name" value="${OF.escape(s?.name||'')}">`)}${field('Description',`<textarea id="s_desc">${OF.escape(s?.description||'')}</textarea>`)}
        <div class="grid cols-2">${field('Duration (min)',`<input id="s_dur" type="number" value="${s?.duration_minutes||60}">`)}${field('Base price',`<div class="input-prefix"><span>$</span><input id="s_price" value="${s?dollars(s.base_price_cents):'0.00'}"></div>`)}</div>
        <div class="grid cols-2">${field('Booking mode',`<select id="s_mode"><option value="default" ${!s||s.booking_mode==='default'?'selected':''}>Use default</option><option value="instant" ${s?.booking_mode==='instant'?'selected':''}>Instant</option><option value="request" ${s?.booking_mode==='request'?'selected':''}>Request times</option></select>`)}${field('Color',`<input id="s_color" type="color" value="${s?.color||'#2563eb'}" style="height:42px">`)}</div></div>
        <div class="modal-foot">${s?`<button class="btn btn-danger-soft" id="s_del">${s.is_active?'Deactivate':'Reactivate'}</button>`:''}<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="s_save">Save</button></div>`);
      m.q('#s_save').onclick=async()=>{const payload={name:m.q('#s_name').value,description:m.q('#s_desc').value,durationMinutes:+m.q('#s_dur').value,basePriceCents:toCents(m.q('#s_price').value),bookingMode:m.q('#s_mode').value,color:m.q('#s_color').value};if(!payload.name)return OF.toast('Name required','error');if(s)await OF.patch('/api/admin/settings/services/'+s.id,payload);else await OF.post('/api/admin/settings/services',payload);m.close();OF.toast('Saved','ok');servicesTab(document.getElementById('content'));};
      m.q('#s_del')?.addEventListener('click',async()=>{await OF.patch('/api/admin/settings/services/'+s.id,{isActive:!s.is_active});m.close();OF.toast('Updated','ok');servicesTab(document.getElementById('content'));});
    }

    // ---- Invoicing ----
    async function invoicingTab(root){
      const inv = S.settings.invoicing; const { presets } = await OF.get('/api/admin/settings/presets');
      root.innerHTML = card('Invoice defaults', `<div class="grid cols-2">${field('Tax rate (%)',`<input id="i_tax" type="number" step="0.01" value="${inv.taxRatePercent}">`)}${field('Due in (days)',`<input id="i_due" type="number" value="${inv.dueDays}">`)}</div>
        ${field('Terms',`<input id="i_terms" value="${OF.escape(inv.terms||'')}">`)}${field('Footer note',`<input id="i_foot" value="${OF.escape(inv.footerNote||'')}">`)}
        <button class="btn btn-primary" id="saveInv">Save invoice defaults</button>`)
        + card('Line-item presets', presets.map(p=>`<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--line-2)"><div><span class="cell-strong">${OF.escape(p.label)}</span> ${p.is_active?'':'<span class="badge neutral no-dot">off</span>'}<div class="tiny muted">${p.category||''} ${p.taxable?'· taxable':''}</div></div><div class="row" style="gap:8px"><span class="mono">${OF.money(p.default_amount_cents)}</span><button class="btn btn-secondary btn-sm" data-preset="${p.id}">Edit</button></div></div>`).join('')||'<p class="muted small">No presets.</p>',
        `<button class="btn btn-primary btn-sm" id="addPreset">${OF.icon('plus',15)} Add preset</button>`);
      root.querySelector('#saveInv').onclick=async()=>{await OF.put('/api/admin/settings/settings',{invoicing:{taxRatePercent:parseFloat(root.querySelector('#i_tax').value)||0,dueDays:+root.querySelector('#i_due').value,terms:root.querySelector('#i_terms').value,footerNote:root.querySelector('#i_foot').value}});OF.toast('Saved','ok');};
      root.querySelector('#addPreset').onclick=()=>presetModal();
      root.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>presetModal(presets.find(p=>p.id==b.dataset.preset)));
    }
    function presetModal(p){
      const m=OF.modal(`<div class="modal-head"><h3>${p?'Edit preset':'New preset'}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">${field('Label *',`<input id="pr_label" value="${OF.escape(p?.label||'')}">`)}${field('Description',`<input id="pr_desc" value="${OF.escape(p?.description||'')}">`)}
        <div class="grid cols-2">${field('Default amount',`<div class="input-prefix"><span>$</span><input id="pr_amt" value="${p?dollars(p.default_amount_cents):'0.00'}"></div>`)}${field('Category',`<input id="pr_cat" value="${OF.escape(p?.category||'')}">`)}</div>
        <label class="row" style="gap:8px"><input type="checkbox" id="pr_tax" ${!p||p.taxable?'checked':''} style="width:auto"> Taxable</label></div>
        <div class="modal-foot">${p?`<button class="btn btn-danger-soft" id="pr_del">Delete</button>`:''}<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pr_save">Save</button></div>`);
      m.q('#pr_save').onclick=async()=>{const payload={label:m.q('#pr_label').value,description:m.q('#pr_desc').value,defaultAmountCents:toCents(m.q('#pr_amt').value),category:m.q('#pr_cat').value,taxable:m.q('#pr_tax').checked};if(!payload.label)return OF.toast('Label required','error');if(p)await OF.patch('/api/admin/settings/presets/'+p.id,payload);else await OF.post('/api/admin/settings/presets',payload);m.close();OF.toast('Saved','ok');invoicingTab(document.getElementById('content'));};
      m.q('#pr_del')?.addEventListener('click',async()=>{if(!(await OF.confirm({title:'Delete preset?',danger:true,confirmText:'Delete'})))return;await OF.del('/api/admin/settings/presets/'+p.id);m.close();OF.toast('Deleted','ok');invoicingTab(document.getElementById('content'));});
    }

    // ---- Integrations ----
    function integrationsTab(root){
      const ig = S.integrations;
      root.innerHTML = card('Stripe payments', `<p class="muted small" style="margin-top:0">Accept card payments on invoices and bill recurring plans. ${ig.stripeEnabled?'<span class="badge ok no-dot">Connected</span>':'<span class="badge neutral no-dot">Not connected</span>'}</p>
        ${field('Secret key',`<input id="st_secret" type="password" placeholder="${ig.stripeEnabled?'•••••••• (set)':'sk_live_…'}">`)}
        ${field('Publishable key',`<input id="st_pub" value="${OF.escape(ig.stripePublishable||'')}" placeholder="pk_live_…">`)}
        ${field('Webhook signing secret',`<input id="st_wh" type="password" placeholder="whsec_…">`,'Point a Stripe webhook at /api/stripe/webhook.')}
        <button class="btn btn-primary" id="saveStripe">Save Stripe keys</button>`)
        + card('Google Calendar', `<p class="muted small" style="margin-top:0">Sync confirmed appointments to a Google Calendar. ${ig.googleConnected?`<span class="badge ok no-dot">Connected${ig.googleEmail?' · '+OF.escape(ig.googleEmail):''}</span>`:'<span class="badge neutral no-dot">Not connected</span>'}</p>
        ${ig.googleConnected
          ? `${field('Calendar ID',`<input id="g_cal" value="${OF.escape(ig.googleCalendarId||'primary')}">`,'Use "primary" or a specific calendar ID.')}<div class="row" style="gap:8px"><button class="btn btn-secondary" id="saveCal">Save calendar</button><button class="btn btn-danger-soft" id="discG">Disconnect</button></div>`
          : `<a class="btn btn-primary" href="/api/integrations/google/connect">${OF.icon('cal',15)} Connect Google Calendar</a>`}`)
        + card('Text messaging (SMS)', `<p class="muted small" style="margin-top:0">Send confirmations, reminders, On-My-Way texts, and two-way messages. ${ig.smsEnabled?'<span class="badge ok no-dot">Connected</span>':'<span class="badge neutral no-dot">Not connected — texts log to console in dev</span>'}</p>
        ${field('Provider',`<select id="sm_provider"><option value="twilio" ${ig.smsProvider==='twilio'?'selected':''}>Twilio</option></select>`,'Telnyx/Bandwidth can be added later.')}
        <div class="grid cols-2">${field('Account SID',`<input id="sm_sid" placeholder="AC…">`)}${field('Auth token',`<input id="sm_token" type="password" placeholder="${ig.smsEnabled?'•••••••• (set)':'token'}">`)}</div>
        <div class="grid cols-2">${field('From number',`<input id="sm_from" value="${OF.escape(ig.smsFrom||'')}" placeholder="+15551234567">`)}${field('Messaging Service SID (optional)',`<input id="sm_mss" value="${OF.escape(ig.smsMessagingServiceSid||'')}" placeholder="MG…">`)}</div>
        ${field('10DLC brand/campaign status',`<select id="sm_brand"><option value="not_started" ${ig.smsBrandStatus==='not_started'?'selected':''}>Not started</option><option value="pending" ${ig.smsBrandStatus==='pending'?'selected':''}>Pending</option><option value="approved" ${ig.smsBrandStatus==='approved'?'selected':''}>Approved</option></select>`,'US A2P texting requires brand/campaign registration with your provider.')}
        <button class="btn btn-primary" id="saveSms">Save SMS settings</button>
        <p class="tiny muted" style="margin-top:8px">Inbound webhook: point your number's messaging webhook at <code>/api/webhooks/sms/twilio</code>.</p>`)
        + card('Email delivery', `<p class="muted small" style="margin-top:0">Provider in use: <b>${OF.escape(ig.emailProvider)}</b>${ig.emailProvider==='console'?' (dev — emails are logged, not sent)':''}. Set MAILGUN_* or SMTP_* env vars to send for real.</p>
        ${field('From address',`<input id="em_from" value="${OF.escape(ig.emailFrom||'')}" placeholder="Pasternack Pest <office@…>">`)}
        ${field('Reply-to address',`<input id="em_reply" value="${OF.escape(ig.emailReplyTo||'')}" placeholder="office@example.com">`)}
        <button class="btn btn-primary" id="saveEmail">Save email settings</button>`);
      root.querySelector('#saveSms').onclick=async()=>{const body={provider:root.querySelector('#sm_provider').value,fromNumber:root.querySelector('#sm_from').value.trim(),messagingServiceSid:root.querySelector('#sm_mss').value.trim(),brandStatus:root.querySelector('#sm_brand').value};const sid=root.querySelector('#sm_sid').value.trim();const tok=root.querySelector('#sm_token').value.trim();if(sid)body.accountSid=sid;if(tok)body.authToken=tok;const r=await OF.put('/api/admin/settings/integrations/sms',body);OF.toast(r.smsEnabled?'SMS connected ✓':'Saved','ok');reload();};
      root.querySelector('#saveStripe').onclick=async()=>{const body={};const s=root.querySelector('#st_secret').value.trim();const p=root.querySelector('#st_pub').value.trim();const w=root.querySelector('#st_wh').value.trim();if(s)body.secretKey=s;body.publishableKey=p;if(w)body.webhookSecret=w;const r=await OF.put('/api/admin/settings/integrations/stripe',body);OF.toast(r.stripeEnabled?'Stripe connected ✓':'Saved','ok');reload();};
      root.querySelector('#saveCal')?.addEventListener('click',async()=>{await OF.put('/api/integrations/google/calendar',{calendarId:root.querySelector('#g_cal').value});OF.toast('Saved','ok');});
      root.querySelector('#discG')?.addEventListener('click',async()=>{await OF.post('/api/integrations/google/disconnect');OF.toast('Disconnected','ok');reload();});
      root.querySelector('#saveEmail').onclick=async()=>{await OF.put('/api/admin/settings/integrations/email',{from:root.querySelector('#em_from').value,replyTo:root.querySelector('#em_reply').value});OF.toast('Saved','ok');};
    }

    // ---- Email templates ----
    async function emailTab(root){
      const { templates } = await OF.get('/api/admin/settings/email-templates');
      root.innerHTML = card('Email templates', templates.map(t=>`<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line-2)"><div><span class="cell-strong">${t.type.replace(/_/g,' ')}</span> ${t.customized?'<span class="badge info no-dot">Customized</span>':''}<div class="tiny muted">${OF.escape(t.subject)}</div></div><button class="btn btn-secondary btn-sm" data-tpl="${t.type}">Edit</button></div>`).join(''));
      root.querySelectorAll('[data-tpl]').forEach(b=>b.onclick=()=>{const t=templates.find(x=>x.type==b.dataset.tpl);const m=OF.modal(`<div class="modal-head"><h3>${t.type.replace(/_/g,' ')}</h3><button class="x" data-close>&times;</button></div><div class="modal-body">${field('Subject',`<input id="t_sub" value="${OF.escape(t.subject)}">`)}${field('HTML body',`<textarea id="t_html" style="min-height:160px;font-family:monospace;font-size:13px">${OF.escape(t.html)}</textarea>`,'Use {{PLACEHOLDERS}} like {{CUSTOMER_NAME}}, {{COMPANY_NAME}}, {{PAY_URL}}.')}${field('Plain text',`<textarea id="t_text">${OF.escape(t.text)}</textarea>`)}</div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="t_save">Save template</button></div>`,{wide:true});m.q('#t_save').onclick=async()=>{await OF.api('/api/admin/settings/email-templates/'+t.type,{method:'PUT',body:{subject:m.q('#t_sub').value,html:m.q('#t_html').value,text:m.q('#t_text').value}});m.close();OF.toast('Template saved','ok');emailTab(document.getElementById('content'));};});
    }

    // ---- Team ----
    async function teamTab(root){
      const { users } = await OF.get('/api/admin/settings/users');
      root.innerHTML = card('Team members', users.map(u=>`<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div class="row" style="gap:10px"><span class="avatar-sm">${OF.initials(u.display_name||u.username)}</span><div><span class="cell-strong">${OF.escape(u.display_name||u.username)}</span> ${u.is_active?'':'<span class="badge neutral no-dot">Inactive</span>'}${u.is_totp_enabled?'<span class="badge ok no-dot">2FA</span>':''}<div class="tiny muted">@${OF.escape(u.username)} · ${u.role}</div></div></div>
        <div class="row" style="gap:6px">${u.id===OF.session.userId?`<button class="btn btn-secondary btn-sm" id="totpBtn">${u.is_totp_enabled?'Manage 2FA':'Enable 2FA'}</button>`:`<button class="btn btn-ghost btn-sm" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active?'Deactivate':'Activate'}</button>`}</div></div>`).join(''),
        `<button class="btn btn-primary btn-sm" id="addUser">${OF.icon('plus',15)} Add member</button>`);
      root.querySelector('#addUser').onclick=()=>{const m=OF.modal(`<div class="modal-head"><h3>Add team member</h3><button class="x" data-close>&times;</button></div><div class="modal-body">${field('Display name',`<input id="u_name">`)}${field('Username *',`<input id="u_user">`)}${field('Temporary password *',`<input id="u_pass" type="text">`)}${field('Role',`<select id="u_role"><option value="staff">Staff</option><option value="owner">Owner</option></select>`)}</div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="u_save">Add</button></div>`);m.q('#u_save').onclick=async()=>{try{await OF.post('/api/admin/settings/users',{displayName:m.q('#u_name').value,username:m.q('#u_user').value.trim(),password:m.q('#u_pass').value,role:m.q('#u_role').value});m.close();OF.toast('Member added','ok');teamTab(document.getElementById('content'));}catch(e){OF.toast(e.message,'error');}};};
      root.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{await OF.patch('/api/admin/settings/users/'+b.dataset.toggle,{isActive:b.dataset.active!=='true'});OF.toast('Updated','ok');teamTab(document.getElementById('content'));});
      root.querySelector('#totpBtn')?.addEventListener('click',totpFlow);
    }
    async function totpFlow(){
      const me = (await OF.get('/api/admin/settings/users')).users.find(u=>u.id===OF.session.userId);
      if(me.is_totp_enabled){ if(await OF.confirm({title:'Disable 2FA?',danger:true,confirmText:'Disable'})){await OF.post('/api/admin/auth/totp/disable');OF.toast('2FA disabled','ok');teamTab(document.getElementById('content'));} return; }
      const start = await OF.post('/api/admin/auth/totp/start');
      const m=OF.modal(`<div class="modal-head"><h3>Enable two-factor auth</h3><button class="x" data-close>&times;</button></div><div class="modal-body center"><p class="muted small">Scan with Google Authenticator, 1Password, or Authy, then enter the 6-digit code.</p><img src="${start.qr}" style="width:180px;height:180px;margin:10px auto"><div class="tiny muted" style="word-break:break-all">${start.secret}</div>${field('Code',`<input id="code" inputmode="numeric" placeholder="123456" style="text-align:center;font-size:20px;letter-spacing:4px">`)}</div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="verify">Verify & enable</button></div>`);
      m.q('#verify').onclick=async()=>{try{await OF.post('/api/admin/auth/totp/enable',{code:m.q('#code').value});m.close();OF.toast('2FA enabled ✓','ok');teamTab(document.getElementById('content'));}catch(e){OF.toast(e.message,'error');}};
    }

    function renderTab(root){
      const body = document.getElementById('tabbody');
      ({business:businessTab,booking:bookingTab,services:servicesTab,invoicing:invoicingTab,integrations:integrationsTab,email:emailTab,team:teamTab})[tab](body);
    }
    async function reload(){ S = await OF.get('/api/admin/settings'); renderTab(); }

    OF.page({ active:'settings', title:'Settings', subtitle:'Configure everything about your business', render: async (root) => {
      S = await OF.get('/api/admin/settings');
      root.innerHTML = `<div class="tabbar" id="tabbar">${TABS.map(([k,l])=>`<button data-tab="${k}" class="${tab===k?'active':''}">${l}</button>`).join('')}</div><div id="tabbody"></div>`;
      root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;root.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));renderTab(root);});
      renderTab(root);
      if (OF.qs('google')==='connected') OF.toast('Google Calendar connected ✓','ok');
    }});
  
