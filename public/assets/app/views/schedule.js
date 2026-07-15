// Auto-generated SPA view module. Registers itself via OF.page() on import.
import * as L from '/assets/vendor/leaflet/leaflet-src.esm.js';

const OF = window.OF;

    if (!document.querySelector('link[data-oarflow-leaflet]')) {
      const stylesheet=document.createElement('link');
      stylesheet.rel='stylesheet';
      stylesheet.href='/assets/vendor/leaflet/leaflet.css';
      stylesheet.dataset.oarflowLeaflet='';
      document.head.appendChild(stylesheet);
    }

    const TZ = () => OF.tenant.timezone;
    const tenantYmd = () => new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    let view = OF.qs('view') || 'week';
    if (!['day','week','month','dispatch'].includes(view)) view = 'week';
    let lastCalendarView = view === 'dispatch' ? 'week' : view;
    let techFilter = '';
    let TECHS = null;
    let CURRENT_APPTS = [];
    let cursor = OF.qs('date') || tenantYmd();
    let dispatchSelection = new Set();
    let dispatchSelectionReady = false;
    let selectAllRepsAfterReload = false;
    let renderSequence = 0;
    let technicianLoadError = '';
    let pendingDispatchFocus = '';
    let dispatchLeafletMap = null;
    let dispatchMapGeneration = 0;
    let dispatchSurface = 'map';
    let planningOpen = false;
    let planningStep = 0;
    let planningDate = '';
    let planningReview = null;
    let HORIZON_APPTS = [];
    let scrollToDispatchAfterRender = false;

    async function loadAdminSurface(name, method) {
      const path = `/assets/app/views/${name}.js`;
      if (typeof OF[method] !== 'function') await import(typeof OF.adminAssetUrl === 'function' ? OF.adminAssetUrl(path) : path);
      if (typeof OF[method] !== 'function') throw new Error('That detail panel is unavailable.');
      return OF[method];
    }
    async function openCustomerDetails(customerId) {
      if (!customerId) return;
      try {
        if (!OF.hasCap('customers.manage')) {
          openScheduleCustomerSummary(customerId);
          return;
        }
        const open = await loadAdminSurface('customers', 'openCustomerDrawer');
        await open(customerId, { onSaved: () => render(currentRoot) });
      } catch (error) { OF.toast(error.message || 'Could not open customer details.', 'error'); }
    }
    async function openAppointmentDetails(appointmentId) {
      if (!appointmentId) return;
      try {
        const open = await loadAdminSurface('appointments', 'openAppointmentDrawer');
        await open(appointmentId, { onChanged: () => {
          selectAllRepsAfterReload ||= Array.isArray(TECHS)
            && dispatchSelection.size === TECHS.length
            && TECHS.every((tech) => dispatchSelection.has(Number(tech.id)));
          TECHS = null;
          return render(currentRoot);
        } });
      } catch (error) { OF.toast(error.message || 'Could not open appointment details.', 'error'); }
    }
    async function newAppointmentFor(date = cursor) {
      try {
        const open = await loadAdminSurface('appointments', 'openNewAppointment');
        await open({ date }, { onSaved: () => render(currentRoot) });
      } catch (error) { OF.toast(error.message || 'Could not open the appointment form.', 'error'); }
    }

    const ymdUTC = (d) => new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
    const addYmd = (ymd,n) => ymdUTC(new Date(new Date(ymd+'T00:00:00Z').getTime()+n*86400000));
    const dowOf = (ymd) => new Date(ymd+'T00:00:00Z').getUTCDay();
    const tzYmd = (iso) => new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
    const tzHm = (iso) => new Intl.DateTimeFormat('en-GB',{timeZone:TZ(),hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
    const labelYmd = (ymd,opts) => new Intl.DateTimeFormat('en-US',{timeZone:'UTC',...opts}).format(new Date(ymd+'T12:00:00Z'));
    const todayYmd = tenantYmd;

    function rangeFor() {
      if (view==='day' || view==='dispatch') return { from: addYmd(cursor,-1), to: addYmd(cursor,2), cells:[cursor] };
      if (view==='week') { const start = cursor; const cells=[...Array(7)].map((_,i)=>addYmd(start,i)); return { from: addYmd(start,-1), to: addYmd(start,8), cells }; }
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
      if (max>cap) return `<span class="cap-pill" style="background:var(--danger-tint);color:var(--danger)" title="Peak concurrent appointments: ${max}; configured capacity: ${cap}">Over capacity · ${max}/${cap}</span>`;
      if (max>=cap) return `<span class="cap-pill" style="background:var(--warn-tint);color:var(--warn)" title="Peak concurrent appointments: ${max}; configured capacity: ${cap}">Capacity reached · ${max}/${cap}</span>`;
      return `<span class="cap-pill" style="background:var(--ok-tint);color:#15803d">${jobs} job${jobs>1?'s':''}</span>`;
    }

    function planningWindow() {
      const start=todayYmd(); const end=addYmd(start,6);
      const dates=[...Array(7)].map((_,index)=>addYmd(start,index));
      if(!planningDate||planningDate<start||planningDate>end)planningDate=dates[1]||start;
      return {start,end,to:addYmd(end,1),dates};
    }
    function appointmentsByDay(appointments) {
      const byDay={};
      for(const appointment of appointments||[]){const date=tzYmd(appointment.scheduled_start);(byDay[date]=byDay[date]||[]).push(appointment);}
      return byDay;
    }
    function isUnassigned(appointment){return !(appointment.technicians||[]).length;}
    function hasMapPoint(appointment){return coord(appointment?.service_lat,-85,85)!=null&&coord(appointment?.service_lng,-180,180)!=null;}
    function planningIssueCounts(data,requestsData) {
      const window=planningWindow(); const byDay=appointmentsByDay(data?.appointments||[]);
      const pendingRequests=Number(requestsData?.total??requestsData?.appointments?.length)||0;
      const unassigned=(data?.appointments||[]).filter(isUnassigned).length;
      const missingCoordinates=(data?.appointments||[]).filter((appointment)=>!hasMapPoint(appointment)).length;
      const overCapacityDays=window.dates.filter((date)=>{const jobs=byDay[date]||[];const meta=dayMeta(date,data||{});return meta.closed||loadOf(jobs)>meta.capacity;}).length;
      return {pendingRequests,unassigned,missingCoordinates,overCapacityDays};
    }
    function plannerCheck(ok,label,detail) {
      return `<div class="daily-plan-check ${ok?'is-ready':'needs-work'}"><span>${OF.icon(ok?'check':'bell',16)}</span><div><b>${OF.escape(label)}</b><small>${OF.escape(detail)}</small></div></div>`;
    }
    function renderSchedulePlanning(host,data,requestsData) {
      if(!host)return;
      const window=planningWindow(); const byDay=appointmentsByDay(data?.appointments||[]); const issues=planningIssueCounts(data,requestsData);
      const total=(data?.appointments||[]).length; const selectedJobs=(byDay[planningDate]||[]).sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start));
      const selectedUnassigned=selectedJobs.filter(isUnassigned); const selectedMissing=selectedJobs.filter((appointment)=>!hasMapPoint(appointment));
      const selectedMeta=dayMeta(planningDate,data||{}); const selectedPeak=loadOf(selectedJobs);
      const selectedOver=selectedMeta.closed||selectedPeak>selectedMeta.capacity;
      const review=planningReview?.review||planningReview;
      const reviewCopy=review?.reviewedAt
        ? `Last reviewed ${OF.dateTime(review.reviewedAt)} by ${review.reviewedBy||'your team'}`
        : 'No daily review has been completed yet';
      const dayRail=window.dates.map((date)=>{
        const jobs=byDay[date]||[]; const unassigned=jobs.filter(isUnassigned).length; const meta=dayMeta(date,data||{}); const attention=unassigned||meta.closed||loadOf(jobs)>meta.capacity;
        return `<button type="button" class="schedule-horizon-day${date===planningDate?' active':''}${attention?' needs-work':' is-ready'}" data-planning-date="${date}" aria-pressed="${date===planningDate}">
          <span>${labelYmd(date,{weekday:'short'})}</span><strong>${labelYmd(date,{month:'short',day:'numeric'})}</strong><em>${jobs.length} job${jobs.length===1?'':'s'}</em><small>${unassigned?`${unassigned} unassigned`:jobs.length?'Ready to route':'Open day'}</small>
        </button>`;
      }).join('');
      const compactRail=window.dates.map((date)=>{
        const jobs=byDay[date]||[]; const unassigned=jobs.filter(isUnassigned).length;
        return `<button type="button" class="schedule-week-day${date===cursor?' active':''}" data-horizon-date="${date}"><span>${labelYmd(date,{weekday:'narrow'})}</span><b>${labelYmd(date,{day:'numeric'})}</b><em>${jobs.length}</em>${unassigned?`<i title="${unassigned} unassigned">${unassigned}</i>`:''}</button>`;
      }).join('');

      let plannerBody='';
      if(planningOpen){
        const steps=['Review intake','Balance week','Assign & route','Finish'];
        const stepper=steps.map((label,index)=>`<button type="button" class="daily-plan-step${index===planningStep?' active':''}${index<planningStep?' complete':''}" data-planning-step="${index}" aria-current="${index===planningStep?'step':'false'}"><span>${index<planningStep?OF.icon('check',13):index+1}</span>${label}</button>`).join('');
        if(planningStep===0){
          plannerBody=`<div class="daily-plan-copy"><span class="dispatch-eyebrow">Step 1 · Review intake</span><h3>Start with anything still waiting on your team</h3><p>Clear new requests first, then use the seven-day outlook to see where work needs attention.</p></div>
            <div class="daily-plan-status-grid">
              <a class="daily-plan-status ${issues.pendingRequests?'needs-work':'is-ready'}" href="/admin/requests"><span>${OF.icon('requests',19)}</span><div><b>${issues.pendingRequests}</b><small>pending request${issues.pendingRequests===1?'':'s'}</small></div><em>Review →</em></a>
              <div class="daily-plan-status ${issues.unassigned?'needs-work':'is-ready'}"><span>${OF.icon('user',19)}</span><div><b>${issues.unassigned}</b><small>unassigned job${issues.unassigned===1?'':'s'}</small></div></div>
              <div class="daily-plan-status ${issues.overCapacityDays?'needs-work':'is-ready'}"><span>${OF.icon('schedule',19)}</span><div><b>${issues.overCapacityDays}</b><small>capacity alert${issues.overCapacityDays===1?'':'s'}</small></div></div>
            </div>`;
        } else if(planningStep===1){
          const techLoads=(TECHS||[]).map((tech)=>{const count=selectedJobs.filter((appointment)=>(appointment.technicians||[]).some((item)=>String(item.id)===String(tech.id))).length;return `<span class="daily-plan-load"><i style="background:${OF.color(tech.color)}"></i>${OF.escape(tech.name)}<b>${count}</b></span>`;}).join('');
          plannerBody=`<div class="daily-plan-copy"><span class="dispatch-eyebrow">Step 2 · Balance the week</span><h3>Choose a day and scan its workload</h3><p>Every date stays visible. Select a day to check demand, crew balance, and capacity before routing.</p></div>
            <div class="schedule-horizon-rail daily-plan-day-rail">${dayRail}</div>
            <div class="daily-plan-selected"><div><span class="dispatch-eyebrow">Selected day</span><h3>${OF.escape(labelYmd(planningDate,{weekday:'long',month:'long',day:'numeric'}))}</h3><p>${selectedJobs.length} jobs · ${selectedUnassigned.length} unassigned · peak ${selectedPeak}/${selectedMeta.capacity} crews</p></div><div class="daily-plan-loads">${techLoads||'<span class="muted small">No active reps</span>'}</div></div>`;
        } else if(planningStep===2){
          const queue=selectedUnassigned.slice(0,8).map((appointment)=>`<div class="daily-plan-job"><span style="background:${OF.color(appointment.service_color)}"></span><div><b>${OF.escape(appointment.customer_name||'Customer')}</b><small>${OF.time(appointment.scheduled_start)} · ${OF.escape(appointment.service_name||appointment.service_address||'Service')}</small></div>${OF.hasCap('dispatch.manage')?`<button type="button" class="btn btn-secondary btn-xs" data-planner-assign="${appointment.id}">Assign</button>`:''}</div>`).join('');
          plannerBody=`<div class="daily-plan-copy"><span class="dispatch-eyebrow">Step 3 · Assign and route</span><h3>Turn the day into a clear run sheet</h3><p>Assign open jobs, then use the interactive map to review numbered stops. Colors identify reps; striped items are suggestions.</p></div>
            <div class="daily-plan-route-grid"><div class="daily-plan-queue"><div class="row between"><b>${selectedUnassigned.length} unassigned</b>${selectedUnassigned.length>8?`<span class="tiny muted">Showing first 8</span>`:''}</div>${queue||`<div class="daily-plan-empty">${OF.icon('check',18)} Every job has a rep.</div>`}</div>
              <div class="daily-plan-route-actions"><div class="daily-plan-map-key"><span><i class="solid"></i>Color = rep</span><span><i class="number">1</i>Number = stop order</span><span><i class="striped"></i>Stripe = suggestion</span></div>${OF.hasCap('dispatch.manage')?`<button type="button" class="btn btn-secondary" id="plannerRoute">Preview smart assignments</button>`:''}<button type="button" class="btn btn-primary" id="plannerDispatch">Open map for this day</button></div></div>`;
        } else {
          const allClear=!issues.pendingRequests&&!selectedUnassigned.length&&!selectedMissing.length&&!selectedOver;
          plannerBody=`<div class="daily-plan-copy"><span class="dispatch-eyebrow">Step 4 · Finish</span><h3>${allClear?'The selected day is ready for a final review':'A few items still need attention'}</h3><p>This records that the schedule was reviewed today. It does not lock the schedule, so later edits remain possible.</p></div>
            <div class="daily-plan-checklist">${plannerCheck(!issues.pendingRequests,'Request inbox',issues.pendingRequests?`${issues.pendingRequests} request${issues.pendingRequests===1?'':'s'} waiting`:'No requests waiting')}${plannerCheck(!selectedUnassigned.length,'Crew assignments',selectedUnassigned.length?`${selectedUnassigned.length} job${selectedUnassigned.length===1?'':'s'} need a rep`:'Every job has a rep')}${plannerCheck(!selectedMissing.length,'Map coverage',selectedMissing.length?`${selectedMissing.length} address${selectedMissing.length===1?' is':'es are'} missing coordinates`:'Every stop can appear on the map')}${plannerCheck(!selectedOver,'Capacity',selectedOver?'Peak load is over capacity or the day is closed':`Peak load ${selectedPeak}/${selectedMeta.capacity}`)}</div>`;
        }
        const nextLabels=['Balance the week','Assign & route','Final check'];
        plannerBody=`<div class="daily-plan-head"><div><span class="daily-plan-kicker">Daily closeout</span><h2>Plan the next seven days</h2><p>${OF.escape(reviewCopy)}</p></div><button type="button" class="daily-plan-close" id="dailyPlannerClose" aria-label="Close daily planning guide">&times;</button></div><div class="daily-plan-stepper">${stepper}</div><div class="daily-plan-content">${plannerBody}</div><div class="daily-plan-footer"><button type="button" class="btn btn-ghost" id="planningBack" ${planningStep===0?'disabled':''}>Back</button><span>Day ${planningStep+1} of 4</span>${planningStep<3?`<button type="button" class="btn btn-primary" id="planningNext">${nextLabels[planningStep]} →</button>`:OF.hasCap('dispatch.manage')?`<button type="button" class="btn btn-primary" id="planningFinish">Mark reviewed &amp; finish</button>`:'<button type="button" class="btn btn-primary" id="dailyPlannerDone">Close guide</button>'}</div>`;
      } else {
        plannerBody=`<div class="daily-plan-launch"><div class="daily-plan-launch-icon">${OF.icon('check',22)}</div><div><span class="daily-plan-kicker">End-of-day routine</span><h2>Set tomorrow up before you log off</h2><p>Review intake, balance seven days, assign reps, and check every route in one guided flow.</p><small>${OF.escape(reviewCopy)}</small></div><div class="daily-plan-launch-stats"><span><b>${total}</b> jobs / 7 days</span><span class="${issues.unassigned?'needs-work':''}"><b>${issues.unassigned}</b> unassigned</span><button type="button" class="btn btn-primary" id="dailyPlannerStart">Start daily plan</button></div></div>`;
      }
      host.innerHTML=`<section class="daily-planner card${planningOpen?' is-open':''}" aria-label="Daily schedule planning guide">${plannerBody}</section>
        <section class="schedule-week-ribbon card" aria-label="Seven-day schedule outlook"><div class="schedule-week-ribbon-copy"><span class="dispatch-eyebrow">Seven-day outlook</span><b>${labelYmd(window.start,{month:'short',day:'numeric'})} – ${labelYmd(window.end,{month:'short',day:'numeric'})}</b><small>Jobs · unassigned alerts</small></div><div class="schedule-week-ribbon-days">${compactRail}</div></section>`;

      host.querySelector('#dailyPlannerStart')?.addEventListener('click',()=>{planningOpen=true;planningStep=0;render(currentRoot);});
      const closePlanner=()=>{planningOpen=false;render(currentRoot);};
      host.querySelector('#dailyPlannerClose')?.addEventListener('click',closePlanner);
      host.querySelector('#dailyPlannerDone')?.addEventListener('click',closePlanner);
      host.querySelectorAll('[data-planning-step]').forEach((button)=>button.addEventListener('click',()=>{planningStep=Number(button.dataset.planningStep)||0;render(currentRoot);}));
      host.querySelectorAll('[data-planning-date]').forEach((button)=>button.addEventListener('click',()=>{planningDate=button.dataset.planningDate;if(view==='dispatch')cursor=planningDate;render(currentRoot);}));
      host.querySelectorAll('[data-horizon-date]').forEach((button)=>button.addEventListener('click',()=>{cursor=button.dataset.horizonDate;if(view!=='dispatch'){view='day';lastCalendarView='day';}render(currentRoot);}));
      host.querySelector('#planningBack')?.addEventListener('click',()=>{planningStep=Math.max(0,planningStep-1);render(currentRoot);});
      host.querySelector('#planningNext')?.addEventListener('click',()=>{planningStep=Math.min(3,planningStep+1);render(currentRoot);});
      host.querySelector('#plannerRoute')?.addEventListener('click',()=>routeModal(planningDate));
      host.querySelector('#plannerDispatch')?.addEventListener('click',()=>{
        cursor=planningDate;
        view='dispatch';
        dispatchSurface='map';
        scrollToDispatchAfterRender=true;
        render(currentRoot);
      });
      host.querySelectorAll('[data-planner-assign]').forEach((button)=>button.addEventListener('click',()=>assignModal(button.dataset.plannerAssign)));
      host.querySelector('#planningFinish')?.addEventListener('click',async()=>{
        const button=host.querySelector('#planningFinish');button.disabled=true;button.textContent='Saving review…';
        try{const result=await OF.post('/api/admin/routing/review',{startDate:window.start,endDate:window.end,issueCounts:issues});planningReview=result.review;planningOpen=false;OF.toast('Daily schedule review saved','ok');render(currentRoot);}
        catch(error){button.disabled=false;button.textContent='Mark reviewed & finish';OF.toast(error.message||'Could not save the review.','error');}
      });
    }

    function openScheduleCustomerSummary(customerId) {
      const appointments = CURRENT_APPTS
        .filter((appointment) => String(appointment.customer_id) === String(customerId))
        .sort((a,b) => new Date(a.scheduled_start) - new Date(b.scheduled_start));
      const customer = appointments[0];
      if (!customer) throw new Error('Customer details are unavailable for this schedule.');
      const contactRows = [
        customer.customer_email ? `<div class="row between"><span class="muted">Email</span><span>${OF.escape(customer.customer_email)}</span></div>` : '',
        customer.customer_phone ? `<div class="row between"><span class="muted">Phone</span><span>${OF.escape(customer.customer_phone)}</span></div>` : '',
        customer.service_address ? `<div class="row between"><span class="muted">Service address</span><span>${OF.escape(customer.service_address)}</span></div>` : '',
      ].filter(Boolean).join('');
      const scheduled = appointments.map((appointment) => `<div class="row between" style="gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2)"><span>${OF.escape(appointment.service_name||'Appointment')}</span><span class="muted small">${OF.dateTime(appointment.scheduled_start)}</span>${OF.statusBadge(appointment.status)}</div>`).join('');
      OF.drawer(`<div class="modal-head"><h3>${OF.escape(customer.customer_name||'Customer')}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="card card-pad stack" style="gap:8px;margin-bottom:16px">${contactRows||'<p class="muted small">No contact details are on file.</p>'}</div>
          <div><div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Appointments in this view</div>${scheduled||'<p class="muted small">None in the current schedule.</p>'}</div>
        </div>`, { wide:true });
    }

    const finiteNumber = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const coord = (value, min, max) => {
      const number = finiteNumber(value);
      return number != null && number >= min && number <= max ? number : null;
    };
    function safeHttpsUrl(value) {
      try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' ? url.href : '';
      } catch { return ''; }
    }
    function routeDistance(route) {
      return finiteNumber(route?.metrics?.estimatedRoadMiles ?? route?.metrics?.distanceMiles ?? route?.estimatedRoadMiles ?? route?.totalMiles);
    }
    function routeDriveMinutes(route) {
      return finiteNumber(route?.metrics?.estimatedDriveMinutes ?? route?.metrics?.driveMinutes ?? route?.estimatedDriveMinutes ?? route?.totalDriveMinutes);
    }
    function routeFuelDollars(route) {
      const cents = finiteNumber(route?.metrics?.estimatedFuelCostCents ?? route?.estimatedFuelCostCents ?? route?.metrics?.fuelCostCents ?? route?.totalFuelCostCents);
      if (cents != null) return cents / 100;
      return finiteNumber(route?.metrics?.fuelCost);
    }
    function driveLabel(minutes) {
      if (minutes == null) return '';
      const rounded = Math.max(0, Math.round(minutes));
      const hours = Math.floor(rounded / 60); const mins = rounded % 60;
      return hours ? `${hours}h${mins ? ` ${mins}m` : ''}` : `${mins}m`;
    }
    function routeMetricBits(route) {
      const stops = Array.isArray(route?.stops) ? route.stops.length : finiteNumber(route?.metrics?.stopCount) || 0;
      const miles = routeDistance(route); const drive = routeDriveMinutes(route); const fuel = routeFuelDollars(route);
      const bits = [`${stops} stop${stops===1?'':'s'}`];
      if (miles != null) bits.push(`${miles.toFixed(1)} mi`);
      if (drive != null) bits.push(`${driveLabel(drive)} drive`);
      if (fuel != null) bits.push(`$${fuel.toFixed(2)} fuel`);
      return bits;
    }
    function planSummary(plan) {
      const routes = plan?.routes || []; const summary = plan?.summary || {};
      const stops = finiteNumber(summary.stopCount ?? summary.stops)
        ?? routes.reduce((total, route) => total + (route.stops || []).length, 0);
      const sumKnown = (getter) => {
        const values = routes.map(getter).filter((value) => value != null);
        return values.length ? values.reduce((total, value) => total + value, 0) : null;
      };
      const miles = finiteNumber(summary.estimatedRoadMiles ?? summary.distanceMiles ?? summary.totalMiles) ?? sumKnown(routeDistance);
      const drive = finiteNumber(summary.estimatedDriveMinutes ?? summary.driveMinutes ?? summary.totalDriveMinutes) ?? sumKnown(routeDriveMinutes);
      const summaryFuelCents = finiteNumber(summary.estimatedFuelCostCents ?? summary.fuelCostCents ?? summary.totalFuelCostCents);
      const fuel = summaryFuelCents != null
        ? summaryFuelCents / 100
        : finiteNumber(summary.fuelCost) ?? sumKnown(routeFuelDollars);
      return { stops, miles, drive, fuel };
    }
    function metricChips(plan) {
      const summary = planSummary(plan);
      if (plan?._error) return '<span class="dispatch-metric-quality unavailable">Route metrics unavailable</span>';
      if (!dispatchSelection.size) return '<span class="dispatch-metric-quality unavailable">Select reps to calculate routes</span>';
      const quality=String(plan?.summary?.quality||'').toLowerCase();
      if (!summary.stops) return '<span class="dispatch-route-summary"><b>0 stops</b><span>No route to review yet</span></span>';
      const qualityClass=quality.includes('partial')?'partial':quality.includes('unavailable')?'unavailable':'';
      const qualityLabel=quality.includes('partial')?'Partial estimates':quality.includes('unavailable')?'Coordinates needed':'Planning estimate';
      const detail=[summary.miles==null?null:`${summary.miles.toFixed(1)} mi`,summary.drive==null?null:`${driveLabel(summary.drive)} drive`,summary.fuel==null?null:`est. $${summary.fuel.toFixed(2)} fuel`].filter(Boolean).join(' · ');
      return `<span class="dispatch-route-summary"><b>${summary.stops} stop${summary.stops===1?'':'s'}</b><span>${OF.escape(detail||'Route details unavailable')}</span></span><span class="dispatch-metric-quality ${qualityClass}">${qualityLabel}</span>`;
    }
    function minutesInTenantDay(iso) {
      const hm = tzHm(iso).split(':').map(Number);
      return (hm[0] === 24 ? 0 : hm[0]) * 60 + hm[1];
    }
    function appointmentWindowInDay(appointment, ymd) {
      const startMs=new Date(appointment?.scheduled_start).getTime(); const endMs=new Date(appointment?.scheduled_end).getTime();
      if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)return null;
      const startDay=tzYmd(appointment.scheduled_start);
      const endInclusiveDay=tzYmd(new Date(endMs-1).toISOString());
      if(startDay>ymd||endInclusiveDay<ymd)return null;
      const endWallDay=tzYmd(appointment.scheduled_end);
      const start=startDay<ymd?0:minutesInTenantDay(appointment.scheduled_start);
      const end=endWallDay>ymd?1440:minutesInTenantDay(appointment.scheduled_end);
      return {start,duration:Math.max(15,end-start),continues:startDay<ymd};
    }
    function packLaneItems(laneItems) {
      const sorted=[...laneItems].sort((a,b)=>a.start-b.start||a.duration-b.duration);
      let cluster=[]; let clusterEnd=-1;
      const flush=()=>{
        if(!cluster.length)return;
        const columnEnds=[];
        for(const item of cluster){
          let column=columnEnds.findIndex((end)=>end<=item.start);
          if(column<0){column=columnEnds.length;columnEnds.push(0);}
          columnEnds[column]=item.start+item.duration; item.dispatchColumn=column;
        }
        for(const item of cluster)item.dispatchColumnCount=columnEnds.length;
        cluster=[]; clusterEnd=-1;
      };
      for(const item of sorted){
        if(cluster.length&&item.start>=clusterEnd)flush();
        cluster.push(item); clusterEnd=Math.max(clusterEnd,item.start+item.duration);
      }
      flush();
    }
    function hourLabel(hour) {
      const normalized = ((hour % 24) + 24) % 24;
      return `${normalized===0?12:normalized>12?normalized-12:normalized}${normalized<12?' AM':' PM'}`;
    }
    function proposalMap(plan) {
      const proposed = new Map();
      for (const route of plan?.routes || []) {
        for (const stop of route.stops || []) {
          if (stop.assignment === 'proposed') proposed.set(String(stop.appointmentId), Number(route.technician?.id || stop.technicianId));
        }
      }
      for (const item of plan?.proposals || []) proposed.set(String(item.appointmentId), Number(item.technicianId));
      return proposed;
    }
    function routeForTechnician(plan, technicianId) {
      return (plan?.routes || []).find((route) => String(route.technician?.id) === String(technicianId));
    }
    function coordinatePoint(value) {
      const coordinates=Array.isArray(value)
        ? value
        : Array.isArray(value?.coordinates)
          ? value.coordinates
          : Array.isArray(value?.geometry?.coordinates)
            ? value.geometry.coordinates
            : null;
      const lat=coord(value?.lat ?? value?.latitude ?? coordinates?.[1],-85,85);
      const lng=coord(value?.lng ?? value?.lon ?? value?.longitude ?? coordinates?.[0],-180,180);
      return lat!=null&&lng!=null?{lat,lng}:null;
    }
    function routeOriginPoint(route, plan) {
      // Newer routing responses can return a rep-specific route.origin. Older
      // responses expose one shared plan.origin, which remains the fallback.
      return coordinatePoint(route?.origin)||coordinatePoint(plan?.origin);
    }
    function geometryPoints(route) {
      const geometry=route?.geometry;
      const lines=geometry?.type==='MultiLineString' ? geometry.coordinates : geometry?.type==='LineString' ? [geometry.coordinates] : [];
      return lines.map((line)=>(line||[]).map((pair)=>({lng:coord(pair?.[0],-180,180),lat:coord(pair?.[1],-85,85)})).filter((point)=>point.lng!=null&&point.lat!=null)).filter((line)=>line.length>=2);
    }
    function routeLinePoints(route, plan) {
      const geometry=geometryPoints(route);
      if(geometry.length)return geometry;
      // Do not join across an ungeocoded stop in a partial route. The backend
      // sends each measurable segment in geometry when that is safe to draw.
      if(route?.quality==='partial')return [];
      const stops=(route?.stops||[]).map(coordinatePoint).filter(Boolean);
      const origin=routeOriginPoint(route,plan);
      const line=[...(origin?[origin]:[]),...stops];
      return line.length>=2?[line]:[];
    }
    function routeStartGroups(plan) {
      const groups=new Map();
      for(const route of plan?.routes||[]){
        const origin=routeOriginPoint(route,plan); if(!origin)continue;
        // About one metre of precision. This prevents several reps sharing the
        // office from producing a stack of impossible-to-click start markers.
        const key=`${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}`;
        const group=groups.get(key)||{origin,routes:[]}; group.routes.push(route); groups.set(key,group);
      }
      return [...groups.values()];
    }
    function destroyDispatchMap() {
      dispatchMapGeneration+=1;
      if(!dispatchLeafletMap)return;
      if(dispatchLeafletMap._dispatchLoadTimer)clearTimeout(dispatchLeafletMap._dispatchLoadTimer);
      dispatchLeafletMap.remove();
      dispatchLeafletMap=null;
    }
    function timelineStopId(stop, route) {
      const lane=String(route?.technician?.id||stop?.technicianId||'unassigned');
      return `dispatch-job-${encodeURIComponent(String(stop?.appointmentId))}-${encodeURIComponent(lane)}`;
    }
    function timelineStopElement(stop, route) {
      return document.getElementById(timelineStopId(stop,route));
    }
    function focusTimelineStop(stop, route) {
      const job=timelineStopElement(stop,route);
      if(!job){dispatchSurface='timeline';pendingDispatchFocus=`#${timelineStopId(stop,route)}`;render(currentRoot);return;}
      const scroller=job.closest('.dispatch-timeline-scroll');
      if(scroller){
        const laneElement=job.closest('.dispatch-lane');
        scroller.scrollTo({
          top:Math.max(0,job.offsetTop-scroller.clientHeight/2+job.offsetHeight/2),
          left:Math.max(0,(laneElement?.offsetLeft||0)-70),
          behavior:'smooth',
        });
      }
      if(window.matchMedia?.('(max-width: 1250px)').matches){
        // In the stacked layout the map and timeline cannot both be visible.
        // Bring the timeline panel into view before drawing attention to the job.
        job.closest('.dispatch-calendar-panel')?.scrollIntoView({behavior:'smooth',block:'start'});
      }
      job.focus({preventScroll:true});
      job.classList.remove('map-focus');
      // Restart the highlight without depending on an animation frame, which
      // may be throttled while a tab is regaining focus.
      void job.offsetWidth;
      job.classList.add('map-focus');
      setTimeout(()=>job.classList.remove('map-focus'),1400);
    }
    function focusMapStop(stop,route) {
      const appointmentId=String(stop?.appointmentId||''); const technicianId=String(route?.technician?.id||stop?.technicianId||'');
      let match=null;
      dispatchLeafletMap?.eachLayer((layer)=>{if(String(layer?._oarflowAppointmentId||'')===appointmentId&&String(layer?._oarflowTechnicianId||'')===technicianId)match=layer;});
      if(match){match.openPopup();dispatchLeafletMap.panTo(match.getLatLng(),{animate:true});}
    }
    function mountDispatchMap(host, plan) {
      const mapNode=host.querySelector('[data-dispatch-leaflet]');
      if(!mapNode){destroyDispatchMap();return;}
      destroyDispatchMap();
      const generation=dispatchMapGeneration;
      const stage=mapNode.closest('.dispatch-map-stage');
      const status=stage?.querySelector('[data-dispatch-map-status]');
      const fitButton=stage?.querySelector('[data-dispatch-map-fit]');
      const routes=plan?.routes||[];
      let resizeObserver=null; let tileLayer=null; let tileSourceIndex=0; let tileErrors=0;

      const setStatus=(state,message)=>{
        if(!status||generation!==dispatchMapGeneration)return;
        status.className=`dispatch-map-status is-${state}`;
        if(state==='ready'){status.hidden=true;status.innerHTML='';return;}
        status.hidden=false;
        status.innerHTML=state==='loading'
          ? `<span class="spinner"></span><span>${OF.escape(message)}</span>`
          : `<span>${OF.icon('bell',15)}</span><span>${OF.escape(message)}</span><button type="button" data-dispatch-map-retry>Retry</button>`;
      };

      try{
        const map=L.map(mapNode,{
          zoomControl:false,
          attributionControl:true,
          scrollWheelZoom:false,
          preferCanvas:false,
        });
        dispatchLeafletMap=map;
        L.control.zoom({position:'topright'}).addTo(map);
        map.attributionControl.setPrefix(false);

        const tileSources=[
          {
            url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
            options:{subdomains:'abcd',maxZoom:20,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'},
          },
          {
            url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options:{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'},
          },
        ];
        const activateTiles=(index)=>{
          if(generation!==dispatchMapGeneration)return;
          tileSourceIndex=index; tileErrors=0;
          if(tileLayer)map.removeLayer(tileLayer);
          if(map._dispatchLoadTimer)clearTimeout(map._dispatchLoadTimer);
          setStatus('loading',index?'Loading backup map…':'Loading map…');
          const source=tileSources[index];
          const nextLayer=L.tileLayer(source.url,{...source.options,crossOrigin:true});
          tileLayer=nextLayer;
          nextLayer.on('tileerror',()=>{
            if(tileLayer!==nextLayer)return;
            tileErrors+=1;
            if(tileErrors===4){
              if(tileSourceIndex<tileSources.length-1)activateTiles(tileSourceIndex+1);
              else setStatus('error','Basemap unavailable. Route pins and lines are still usable.');
            }
          });
          nextLayer.on('load',()=>{
            if(tileLayer!==nextLayer||generation!==dispatchMapGeneration||tileErrors>=4)return;
            if(map._dispatchLoadTimer)clearTimeout(map._dispatchLoadTimer);
            setStatus('ready','');
          });
          nextLayer.addTo(map);
          map._dispatchLoadTimer=setTimeout(()=>{
            if(generation!==dispatchMapGeneration)return;
            if(tileSourceIndex<tileSources.length-1)activateTiles(tileSourceIndex+1);
            else setStatus('error','Basemap is taking too long. Route pins and lines are still usable.');
          },7000);
        };
        activateTiles(0);

        const bounds=L.latLngBounds([]);
        for(const route of routes){
          const color=OF.color(route?.technician?.color);
          const name=route?.technician?.name||'Rep';
          for(const line of routeLinePoints(route,plan)){
            const latLngs=line.map((point)=>[point.lat,point.lng]);
            latLngs.forEach((point)=>bounds.extend(point));
            L.polyline(latLngs,{color:'#fff',weight:8,opacity:.82,lineCap:'round',lineJoin:'round',interactive:false}).addTo(map);
            L.polyline(latLngs,{color,weight:4,opacity:.92,dashArray:'9 8',lineCap:'round',lineJoin:'round'})
              .bindTooltip(`${OF.escape(name)} · estimated stop order`,{sticky:true,className:'dispatch-map-tooltip compact'})
              .addTo(map);
          }
        }

        for(const group of routeStartGroups(plan)){
          const names=group.routes.map((route)=>route?.technician?.name||'Rep');
          const colors=group.routes.map((route)=>OF.color(route?.technician?.color));
          const sources=new Set(group.routes.map((route)=>route?.origin?.source||plan?.origin?.source||'business'));
          const startKind=sources.size>1?'mixed':sources.has('technician')?'custom':'business';
          const startKindLabel=startKind==='custom'?'custom start':startKind==='business'?'business base':'shared start';
          const visibleColors=colors.slice(0,3);
          const swatches=visibleColors.map((color)=>`<i style="background:${color}"></i>`).join('');
          const overflow=colors.length>3?`<b>+${colors.length-3}</b>`:'';
          const icon=L.divIcon({
            className:'dispatch-map-div-icon',
            html:`<div class="dispatch-map-start ${startKind}" style="--start-color:${colors[0]}"><span>${startKind==='business'?'<b>B</b>':OF.icon('pin',14)}</span><em>${swatches}${overflow}</em></div>`,
            iconSize:[52,42],
            iconAnchor:[26,37],
          });
          const marker=L.marker([group.origin.lat,group.origin.lng],{
            icon,keyboard:true,title:`${names.join(', ')} ${startKindLabel}`,alt:`${names.join(', ')} ${startKindLabel}`,zIndexOffset:50,
          });
          const label=names.length===1?`${names[0]} · ${startKindLabel}`:`${names.length} reps · ${startKindLabel}`;
          const address=group.routes.map((route)=>route?.origin?.address||plan?.origin?.address).find(Boolean);
          marker.bindTooltip(`<div class="dispatch-map-tooltip"><strong>${OF.escape(label)}</strong><span>${OF.escape(names.join(' · '))}</span>${address?`<span>${OF.escape(address)}</span>`:''}</div>`,{direction:'top',offset:[0,-28]});
          marker.addTo(map); bounds.extend([group.origin.lat,group.origin.lng]);
        }

        for(const route of routes){
          const color=OF.color(route?.technician?.color);
          const repName=route?.technician?.name||'Rep';
          (route?.stops||[]).forEach((stop,index)=>{
            const point=coordinatePoint(stop); if(!point)return;
            const number=index+1;
            const proposed=stop.assignment==='proposed';
            const icon=L.divIcon({
              className:'dispatch-map-div-icon',
              html:`<div class="dispatch-map-pin${proposed?' proposed':''}" style="--marker:${color}"><span>${number}</span></div>`,
              iconSize:[36,44],
              iconAnchor:[18,39],
            });
            const customer=stop.customerName||'Customer';
            const marker=L.marker([point.lat,point.lng],{
              icon,keyboard:true,title:`Stop ${number}: ${customer}. Open stop details.`,alt:`Stop ${number}: ${customer}. Open stop details.`,zIndexOffset:100+number,
            });
            marker._oarflowAppointmentId=String(stop.appointmentId||'');
            marker._oarflowTechnicianId=String(route?.technician?.id||stop?.technicianId||'');
            const stopListButton=()=>[...host.querySelectorAll('[data-dispatch-stop]')].find((button)=>String(button.dataset.dispatchStop)===marker._oarflowAppointmentId&&String(button.dataset.dispatchStopTech)===marker._oarflowTechnicianId);
            const time=stop.time?OF.time(stop.time):'';
            const stopMeta=OF.escape([time,repName].filter(Boolean).join(' · '));
            marker.bindTooltip(`<div class="dispatch-map-tooltip"><strong>${number}. ${OF.escape(customer)}</strong><span>${stopMeta}</span>${stop.address?`<span>${OF.escape(stop.address)}</span>`:''}<small>Select for stop actions</small></div>`,{direction:'top',offset:[0,-28]});
            marker.bindPopup(`<div class="dispatch-map-popup">
              <div class="dispatch-map-popup-title"><span style="--marker:${color}">${number}</span><div><strong>${OF.escape(customer)}</strong><small>${OF.escape(repName)}${proposed?' · Suggested stop':''}</small></div></div>
              ${time?`<span class="dispatch-map-popup-meta">${OF.icon('clock',13)} ${OF.escape(time)}</span>`:''}
              ${stop.address?`<span class="dispatch-map-popup-address">${OF.escape(stop.address)}</span>`:''}
              <div class="dispatch-map-popup-actions"><button type="button" class="btn btn-primary btn-sm" data-dispatch-map-open>Open details</button><button type="button" class="btn btn-secondary btn-sm" data-dispatch-map-find>Find on timeline</button></div>
            </div>`,{className:'dispatch-map-stop-popup',offset:[0,-30],minWidth:250,maxWidth:280,autoPan:true,keepInView:true});
            marker.on('popupopen',(event)=>{
              marker.closeTooltip();
              stage?.classList.add('has-stop-popup');
              const markerElement=marker.getElement();
              markerElement?.setAttribute('aria-expanded','true');
              markerElement?.querySelector('.dispatch-map-pin')?.classList.add('is-selected');
              stopListButton()?.classList.add('is-selected');
              const job=timelineStopElement(stop,route);
              job?.classList.add('map-selected');
              const popupElement=event.popup.getElement();
              popupElement?.setAttribute('role','dialog');
              popupElement?.setAttribute('aria-label',`Stop ${number} details for ${customer}`);
              const openButton=popupElement?.querySelector('[data-dispatch-map-open]');
              const findButton=popupElement?.querySelector('[data-dispatch-map-find]');
              if(openButton)openButton.onclick=(clickEvent)=>{
                clickEvent.preventDefault(); clickEvent.stopPropagation();
                openAppointmentDetails(stop.appointmentId);
              };
              if(findButton)findButton.onclick=(clickEvent)=>{
                clickEvent.preventDefault(); clickEvent.stopPropagation();
                focusTimelineStop(stop,route);
              };
              requestAnimationFrame(()=>openButton?.focus({preventScroll:true}));
            });
            marker.on('popupclose',()=>{
              stage?.classList.remove('has-stop-popup');
              const markerElement=marker.getElement();
              markerElement?.setAttribute('aria-expanded','false');
              markerElement?.querySelector('.dispatch-map-pin')?.classList.remove('is-selected');
              stopListButton()?.classList.remove('is-selected');
              timelineStopElement(stop,route)?.classList.remove('map-selected');
            });
            marker.addTo(map);
            marker.getElement()?.setAttribute('aria-haspopup','dialog');
            marker.getElement()?.setAttribute('aria-expanded','false');
            bounds.extend([point.lat,point.lng]);
          });
        }

        const fitRoutes=()=>{
          if(!bounds.isValid())return;
          map.invalidateSize({pan:false});
          const northEast=bounds.getNorthEast(); const southWest=bounds.getSouthWest();
          if(northEast.equals(southWest))map.setView(bounds.getCenter(),14,{animate:false});
          else map.fitBounds(bounds,{paddingTopLeft:[28,36],paddingBottomRight:[28,36],maxZoom:15,animate:false});
        };
        fitButton?.addEventListener('click',fitRoutes);
        status?.addEventListener('click',(event)=>{if(event.target.closest('[data-dispatch-map-retry]'))activateTiles(0);});
        if(typeof ResizeObserver==='function'){
          resizeObserver=new ResizeObserver(()=>map.invalidateSize({pan:false}));
          resizeObserver.observe(mapNode);
        }
        map.on('unload',()=>resizeObserver?.disconnect());
        // Establish a view immediately so layers initialize even when a tab
        // opens in the background and animation frames are throttled.
        fitRoutes();
        setTimeout(()=>{if(generation===dispatchMapGeneration)fitRoutes();},0);
      }catch(error){
        console.warn('[dispatch-map] Could not initialize interactive map',error);
        setStatus('error','Interactive map could not load. Try refreshing the page.');
      }
    }
    function dispatchMap(plan) {
      const routes=plan?.routes||[];
      const allStops=routes.flatMap((route)=>(route.stops||[]).map((stop)=>({...stop,_route:route})));
      const mappableStops=allStops.filter((stop)=>coordinatePoint(stop));
      const missing=new Set(allStops.filter((stop)=>!coordinatePoint(stop)).map((stop)=>String(stop.appointmentId))).size;
      const planError=plan?._error;
      let mapBody='';
      if(planError){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('pin',22)}</div><h3>Route preview unavailable</h3><p>${OF.escape(planError)}</p><button class="btn btn-secondary btn-sm" type="button" data-dispatch-retry>Retry routes</button></div>`;
      } else if(!dispatchSelection.size){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('user',22)}</div><h3>Select a rep</h3><p>Choose one or more reps above to draw their routes.</p></div>`;
      } else if(!allStops.length){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('schedule',22)}</div><h3>No routed stops</h3><p>There are no assigned or suggested stops for this day.</p></div>`;
      } else if(!mappableStops.length){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('pin',22)}</div><h3>Connect geocoding to map routes</h3><p>These stops have addresses but no coordinates yet. Connect Google or Mapbox in Settings → Integrations.</p><a class="btn btn-secondary btn-sm" href="/admin/settings?tab=integrations">Open integrations</a></div>`;
      } else {
        mapBody=`<div class="dispatch-leaflet-map" data-dispatch-leaflet role="region" aria-label="Interactive route map for ${OF.escape(labelYmd(cursor,{month:'long',day:'numeric'}))}"></div>
          <div class="dispatch-map-status is-loading" data-dispatch-map-status role="status"><span class="spinner"></span><span>Loading map…</span></div>
          <button class="dispatch-map-fit" data-dispatch-map-fit type="button" title="Fit all routes on the map" aria-label="Fit all routes on the map">${OF.icon('pin',15)} <span>Fit routes</span></button>`;
      }
      const stopGroups=routes.map((route)=>{
        const maps=safeHttpsUrl(route.mapsUrl); const color=OF.color(route.technician?.color); const technicianId=route.technician?.id||'';
        const stops=(route.stops||[]).map((stop,index)=>{
          const proposed=stop.assignment==='proposed'; const time=stop.time?OF.time(stop.time):'';
          return `<button type="button" class="dispatch-stop-row${proposed?' proposed':''}" data-dispatch-stop="${stop.appointmentId}" data-dispatch-stop-tech="${technicianId}"><span class="dispatch-stop-number" style="--stop-color:${color}">${index+1}</span><span class="dispatch-stop-copy"><b>${OF.escape(stop.customerName||'Customer')}</b><small>${OF.escape([time,stop.address].filter(Boolean).join(' · '))}</small></span>${proposed?'<em>Suggested</em>':OF.icon('appointments',14)}</button>`;
        }).join('');
        return `<div class="dispatch-stop-group"><div class="dispatch-stop-group-head"><span style="background:${color}"></span><div><b>${OF.escape(route.technician?.name||'Rep')}</b><small>${OF.escape(routeMetricBits(route).join(' · '))}</small></div>${maps?`<a href="${OF.escape(maps)}" target="_blank" rel="noopener">Google Maps ↗</a>`:''}</div>${stops||'<p class="muted small">No stops for this rep.</p>'}</div>`;
      }).join('');
      const stopList=planError
        ? '<div class="dispatch-stop-empty"><b>Stops could not load</b><button class="link-btn" type="button" data-dispatch-retry>Retry route preview</button></div>'
        : stopGroups||'<div class="dispatch-stop-empty"><b>No stops to show</b><span>Select a rep or choose another day.</span></div>';
      return `<section class="dispatch-map-panel card" aria-label="Route map">
        <div class="dispatch-panel-head"><div><span class="dispatch-eyebrow">Route overview</span><h3>${OF.escape(labelYmd(cursor,{weekday:'long',month:'short',day:'numeric'}))}</h3></div><div class="dispatch-map-metrics">${metricChips(plan)}</div></div>
        <div class="dispatch-map-guide"><span><b>1</b> Choose a rep</span><span><b>2</b> Follow numbered stops</span><span><b>3</b> Open the route when it looks right</span><em>Dashed lines show estimated sequence, not road directions.</em></div>
        <div class="dispatch-map-layout"><div class="dispatch-map-stage">${mapBody}</div><aside class="dispatch-stop-panel" aria-label="Ordered route stops"><div class="dispatch-stop-panel-head"><div><span class="dispatch-eyebrow">Run sheet</span><b>Ordered stops</b></div><small>Select a stop to find it on the map</small></div><div class="dispatch-stop-list">${stopList}</div></aside></div>
        ${missing?`<div class="dispatch-map-warning">${OF.icon('bell',14)} ${missing} stop${missing===1?' is':'s are'} missing coordinates; ${missing===1?'its':'their'} route ${missing===1?'line':'lines'} may be incomplete.</div>`:''}
      </section>`;
    }
    function dispatchTimeline(appts, plan) {
      const selectedTechs=(TECHS||[]).filter((tech)=>dispatchSelection.has(Number(tech.id)));
      const proposed=proposalMap(plan); const selectedIds=new Set(selectedTechs.map((tech)=>Number(tech.id)));
      const items=[];
      for(const appointment of appts){
        const dayWindow=appointmentWindowInDay(appointment,cursor); if(!dayWindow)continue;
        const crew=appointment.technicians||[];
        const selectedCrew=crew.filter((tech)=>selectedIds.has(Number(tech.id)));
        if(selectedCrew.length){
          // A crew appointment appears in every selected rep's lane, matching
          // the per-rep routes and vehicle estimates returned by the backend.
          for(const tech of selectedCrew)items.push({appointment,laneId:String(tech.id),suggested:false,...dayWindow});
        } else if(crew.length){continue;}
        else if(proposed.has(String(appointment.id))&&selectedIds.has(proposed.get(String(appointment.id)))){
          items.push({appointment,laneId:String(proposed.get(String(appointment.id))),suggested:true,...dayWindow});
        } else items.push({appointment,laneId:'unassigned',suggested:false,...dayWindow});
      }
      const earliest=items.length?Math.min(...items.map((item)=>item.start)):8*60;
      const latest=items.length?Math.max(...items.map((item)=>Math.min(1440,item.start+item.duration))):18*60;
      const startHour=Math.max(0,Math.min(8,Math.floor(earliest/60)));
      const endHour=Math.min(24,Math.max(18,Math.ceil(latest/60)));
      const pxPerHour=72; const height=(endHour-startHour)*pxPerHour;
      const lanes=[...selectedTechs.map((tech)=>({id:String(tech.id),name:tech.name,color:OF.color(tech.color),route:routeForTechnician(plan,tech.id)})),{id:'unassigned',name:'Unassigned',color:'#94a3b8',route:null}];
      for(const lane of lanes)packLaneItems(items.filter((item)=>item.laneId===lane.id));
      const headers=lanes.map((lane)=>{const count=items.filter((item)=>item.laneId===lane.id).length;const bits=lane.route?routeMetricBits(lane.route):[`${count} job${count===1?'':'s'}`];return `<div class="dispatch-lane-head"><span class="dispatch-lane-dot" style="background:${lane.color}"></span><div><b>${OF.escape(lane.name)}</b><span>${OF.escape(bits.join(' · '))}</span></div></div>`;}).join('');
      const axisLabels=[...Array(endHour-startHour+1)].map((_,index)=>`<span style="top:${index*pxPerHour}px">${hourLabel(startHour+index)}</span>`).join('');
      const laneBodies=lanes.map((lane)=>{
        const cards=items.filter((item)=>item.laneId===lane.id).map(({appointment,suggested,start,duration,continues,dispatchColumn=0,dispatchColumnCount=1})=>{
          const top=Math.max(0,((start-startHour*60)/60)*pxPerHour); const cardHeight=Math.max(32,(duration/60)*pxPerHour-4);
          const color=lane.id==='unassigned'?OF.color(appointment.service_color):lane.color;
          const status=String(appointment.status||'scheduled');
          const packed=dispatchColumnCount>1?`;left:calc(${(dispatchColumn/dispatchColumnCount*100).toFixed(3)}% + 4px);right:auto;width:calc(${(100/dispatchColumnCount).toFixed(3)}% - 8px)`:'';
          return `<div class="dispatch-job status-${OF.escape(status)}${suggested?' suggested':''}" id="dispatch-job-${encodeURIComponent(String(appointment.id))}-${encodeURIComponent(lane.id)}" data-appointment-id="${appointment.id}" tabindex="-1" style="top:${top.toFixed(1)}px;height:${cardHeight.toFixed(1)}px;--job-color:${color}${packed}" title="Open appointment details for ${OF.escape(appointment.customer_name||'Customer')}">
            <span class="dispatch-job-time"><span>${continues?'Continues':OF.time(appointment.scheduled_start)}</span><span class="schedule-job-actions">${suggested?'<em>Suggested</em>':''}${detailsButton(appointment)}</span></span><button type="button" class="schedule-customer-link" data-customer-id="${appointment.customer_id}" draggable="false" title="Open ${OF.escape(appointment.customer_name||'customer')} profile">${OF.escape(appointment.customer_name||'Customer')}</button><small>${OF.escape(appointment.service_name||appointment.service_address||'Service')}</small></div>`;
        }).join('');
        return `<div class="dispatch-lane" style="--lane-color:${lane.color};height:${height}px">${cards||'<span class="dispatch-lane-empty">No jobs</span>'}</div>`;
      }).join('');
      return `<section class="dispatch-calendar-panel card" aria-label="Rep dispatch timeline">
        <div class="dispatch-panel-head"><div><span class="dispatch-eyebrow">Day timeline</span><h3>Rep schedule</h3></div><span class="tiny muted">Unassigned jobs stay visible</span></div>
        <div class="dispatch-timeline-scroll"><div class="dispatch-timeline" style="--lane-count:${lanes.length};--timeline-height:${height}px;min-width:${62+lanes.length*174}px">
          <div class="dispatch-time-head">Time</div>${headers}<div class="dispatch-time-axis" style="height:${height}px">${axisLabels}</div>${laneBodies}
        </div></div>
      </section>`;
    }
    function renderDispatch(body, appts, plan) {
      destroyDispatchMap();
      const allSelected=Boolean((TECHS||[]).length)&&dispatchSelection.size===(TECHS||[]).length;
      const proposed=(plan?.routes||[]).reduce((count,route)=>count+(Number(route.proposedCount)||0),0);
      const canDispatch=OF.hasCap('dispatch.manage'); const summary=planSummary(plan);
      body.innerHTML=`<div class="dispatch-board">
        <span class="dispatch-sr-only" role="status" aria-live="polite">${plan?._error?'Route preview failed.':`${summary.stops} scheduled stop${summary.stops===1?'':'s'} shown for ${dispatchSelection.size} rep${dispatchSelection.size===1?'':'s'}.`}</span>
        <div class="dispatch-filterbar card"><div><span class="dispatch-eyebrow">Show routes for</span><div class="dispatch-rep-chips" role="group" aria-label="Filter dispatch board by rep">
          <button type="button" class="dispatch-rep-chip all${allSelected?' active':''}" id="dispatchAll" aria-pressed="${allSelected}">All routes</button>
          ${(TECHS||[]).map((tech)=>`<button type="button" class="dispatch-rep-chip${dispatchSelection.has(Number(tech.id))?' active':''}" data-dispatch-tech="${tech.id}" aria-pressed="${dispatchSelection.has(Number(tech.id))}"><span style="background:${OF.color(tech.color)}"></span>${OF.escape(tech.name)}</button>`).join('')}
          ${(TECHS||[]).length?'<button type="button" class="dispatch-clear" id="dispatchClear">Clear</button>':''}
        </div></div><div class="dispatch-filter-note">${proposed?`<span class="badge ok no-dot">${proposed} smart suggestion${proposed===1?'':'s'}</span><button class="btn btn-secondary btn-sm" type="button" id="dispatchReview">${canDispatch?'Review &amp; apply':'Review suggestions'}</button>`:'<span>Select one rep for the clearest route, or compare all routes.</span>'}</div></div>
        <div class="dispatch-surfacebar card"><div><span class="dispatch-eyebrow">Workspace</span><b>${dispatchSurface==='map'?'Map & ordered stops':'Rep timeline'}</b></div><div class="segmented" role="group" aria-label="Dispatch workspace"><button type="button" data-dispatch-surface="map" class="${dispatchSurface==='map'?'active':''}" aria-pressed="${dispatchSurface==='map'}">${OF.icon('pin',14)} Map & stops</button><button type="button" data-dispatch-surface="timeline" class="${dispatchSurface==='timeline'?'active':''}" aria-pressed="${dispatchSurface==='timeline'}">${OF.icon('clock',14)} Timeline</button></div></div>
        <div class="dispatch-workspace is-${dispatchSurface}">${dispatchSurface==='map'?dispatchMap(plan):dispatchTimeline(appts,plan)}</div>
      </div>`;
      body.querySelector('#dispatchAll')?.addEventListener('click',()=>{pendingDispatchFocus='#dispatchAll';dispatchSelection=new Set((TECHS||[]).map((tech)=>Number(tech.id)));render(currentRoot);});
      body.querySelector('#dispatchClear')?.addEventListener('click',()=>{pendingDispatchFocus='#dispatchClear';dispatchSelection.clear();render(currentRoot);});
      body.querySelectorAll('[data-dispatch-tech]').forEach((button)=>button.addEventListener('click',()=>{const id=Number(button.dataset.dispatchTech);pendingDispatchFocus=`[data-dispatch-tech="${id}"]`;if(dispatchSelection.has(id))dispatchSelection.delete(id);else dispatchSelection.add(id);render(currentRoot);}));
      body.querySelector('#dispatchReview')?.addEventListener('click',()=>routeModal());
      body.querySelectorAll('[data-dispatch-retry]').forEach((button)=>button.addEventListener('click',()=>render(currentRoot)));
      body.querySelectorAll('[data-dispatch-surface]').forEach((button)=>button.addEventListener('click',()=>{dispatchSurface=button.dataset.dispatchSurface;renderDispatch(body,appts,plan);}));
      body.querySelectorAll('[data-dispatch-stop]').forEach((button)=>button.addEventListener('click',()=>{
        const route=(plan?.routes||[]).find((item)=>String(item.technician?.id)===String(button.dataset.dispatchStopTech));
        const stop=(route?.stops||[]).find((item)=>String(item.appointmentId)===String(button.dataset.dispatchStop));
        if(stop&&route)focusMapStop(stop,route);
      }));
      bindScheduleInteractions(body);
      mountDispatchMap(body,plan);
      if(pendingDispatchFocus){const selector=pendingDispatchFocus;pendingDispatchFocus='';requestAnimationFrame(()=>{const target=body.querySelector(selector);target?.focus();if(target?.classList.contains('dispatch-job')){target.scrollIntoView({block:'center',inline:'center'});target.classList.add('map-focus');setTimeout(()=>target.classList.remove('map-focus'),1400);}});}
    }

    async function routeModal(routeDate = cursor) {
      const canDispatch = OF.hasCap('dispatch.manage');
      const selected = new Set(view==='dispatch' ? dispatchSelection : (techFilter ? [+techFilter] : (TECHS||[]).map(t=>+t.id)));
      const m = OF.modal(`<div class="modal-head"><h3>Plan routes</h3><button class="x" data-close aria-label="Close route planner">&times;</button></div>
        <div class="modal-body" style="min-height:220px">
          <div class="grid cols-2">
            <div class="field"><div class="row between"><span id="rt_techs_label" style="margin:0">Reps / technicians</span><span><button type="button" class="link-btn tiny" id="rt_all">All</button> <button type="button" class="link-btn tiny" id="rt_none">None</button></span></div><div id="rt_techs" class="card" role="group" aria-labelledby="rt_techs_label" style="padding:4px 10px;max-height:150px;overflow:auto"></div></div>
            <div><div class="field"><label for="rt_date">Date</label><select id="rt_date">${OF.dateSelectOptions(routeDate)}</select></div>
              <label class="row small" style="gap:8px;cursor:pointer"><input type="checkbox" id="rt_suggest" checked style="width:auto"> Suggest nearby reps for unassigned jobs</label>
              <p class="tiny muted" style="margin:7px 0 0">Existing assignments stay fixed. Suggestions avoid overlapping jobs.</p></div>
          </div>
          ${canDispatch?`<div class="row" style="gap:8px;margin:-2px 0 14px"><input id="rt_newtech" aria-label="New rep or technician name" placeholder="New rep / technician name" style="max-width:280px"><button class="btn btn-secondary btn-sm" id="rt_addtech" type="button">Add rep</button></div>`:''}
          <div id="rt_out" aria-live="polite"><p class="muted small">Select reps and a date to preview drive order and nearby assignment suggestions.</p></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button>${canDispatch?'<button class="btn btn-secondary hidden" id="rt_apply">Apply assignments</button>':''}<button class="btn btn-primary" id="rt_go">Preview routes</button></div>`, { wide:true });

      let previewKey = '';
      function selectedIds(){ return [...selected]; }
      function controlsKey(){
        return JSON.stringify({
          date:m.q('#rt_date').value,
          technicianIds:selectedIds().sort((a,b)=>a-b),
          includeUnassigned:m.q('#rt_suggest').checked,
        });
      }
      function invalidatePlan(){
        previewKey='';
        const apply=m.q('#rt_apply');
        if(apply){ apply.classList.add('hidden'); apply.dataset.count='0'; }
        m.q('#rt_out').innerHTML='<p class="muted small">Controls changed. Preview routes to review the updated plan.</p>';
      }
      function renderTechs() {
        const box = m.q('#rt_techs');
        box.innerHTML = (TECHS||[]).map(t=>`<label class="row" style="gap:9px;padding:7px 0;border-bottom:1px solid var(--line-2);cursor:pointer"><input class="rt-tech" type="checkbox" value="${t.id}" ${selected.has(+t.id)?'checked':''} style="width:auto"><span class="m-dot" style="background:${OF.color(t.color)};width:9px;height:9px;border-radius:50%"></span><span>${OF.escape(t.name)}</span></label>`).join('') || '<p class="muted small" style="margin:8px 0">No reps yet. Add the first one below.</p>';
        box.querySelectorAll('.rt-tech').forEach(c=>c.onchange=()=>{ if(c.checked)selected.add(+c.value);else selected.delete(+c.value); invalidatePlan(); });
      }
      renderTechs();
      m.q('#rt_all').onclick=()=>{ (TECHS||[]).forEach(t=>selected.add(+t.id)); renderTechs(); invalidatePlan(); };
      m.q('#rt_none').onclick=()=>{ selected.clear(); renderTechs(); invalidatePlan(); };
      m.q('#rt_addtech')?.addEventListener('click', async()=>{
        const input=m.q('#rt_newtech'); const name=input.value.trim(); if(!name)return OF.toast('Enter a rep name','error');
        try { const r=await OF.post('/api/admin/technicians',{name}); TECHS.push(r.technician); selected.add(+r.technician.id); input.value=''; renderTechs(); invalidatePlan(); OF.toast('Rep added','ok'); }
        catch(e){ OF.toast(e.message,'error'); }
      });
      m.q('#rt_date').addEventListener('change',invalidatePlan);
      m.q('#rt_suggest').addEventListener('change',invalidatePlan);

      function renderPlan(d, key) {
        previewKey=key;
        const proposed=(d.routes||[]).reduce((n,r)=>n+(r.proposedCount||0),0);
        const hasStops=(d.routes||[]).some(r=>r.stops.length);
        const methodNote=d.method==='coordinates'
          ? 'All stops have coordinates. Mileage, drive time, and fuel are estimates based on your planning assumptions.'
          : d.method==='mixed'
            ? 'Some stops have coordinates; route metrics are partial estimates and remaining stops use address similarity.'
            : 'Stops are grouped by ZIP, city, and address similarity. Connect geocoding for map and drive estimates.';
        m.q('#rt_out').innerHTML = `<div class="row between wrap" style="gap:8px;margin-bottom:8px"><p class="tiny muted" style="margin:0">${OF.escape(methodNote)} Drive order follows scheduled appointment times.</p>${proposed?`<span class="badge ok no-dot">${proposed} suggested assignment${proposed===1?'':'s'}</span>`:''}</div>
          ${hasStops?(d.routes||[]).map(r=>{const estimates=routeMetricBits(r).slice(1);return `<div class="card" style="margin-bottom:10px;overflow:hidden"><div class="card-head" style="min-height:auto;padding:10px 12px"><span class="m-dot" style="background:${OF.color(r.technician.color)};width:10px;height:10px;border-radius:50%"></span><h4 style="margin:0">${OF.escape(r.technician.name)}</h4><span class="tiny muted" style="margin-left:auto">${r.stops.length} stop${r.stops.length===1?'':'s'}${estimates.length?` · Est. ${OF.escape(estimates.join(' · '))}`:''}</span></div>
            <div style="padding:4px 12px 10px"><ol style="padding-left:20px;margin:4px 0 8px">${r.stops.map(s=>`<li style="padding:5px 0"><div><b>${s.time?OF.time(s.time):''}</b> ${OF.escape(s.customerName)} ${s.assignment==='proposed'?'<span class="badge ok no-dot" style="font-size:9px;padding:1px 5px">suggested</span>':''}</div><div class="tiny muted">${OF.escape(s.address||'No service address')}</div></li>`).join('')}</ol>
            ${r.mapsUrl?`<a class="btn btn-secondary btn-sm" href="${OF.escape(r.mapsUrl)}" target="_blank" rel="noopener">${OF.icon('pin',14)} Open in Google Maps</a>`:''}</div></div>`;}).join(''):'<div class="empty" style="min-height:100px"><p>No scheduled stops for these reps on this date.</p></div>'}
          ${(d.unplaced||[]).length?`<div class="card card-pad" style="background:var(--warn-tint)"><b class="small">Needs manual assignment</b>${d.unplaced.map(x=>`<div class="tiny" style="margin-top:4px">${OF.escape(x.customerName)} · ${OF.time(x.time)} — ${OF.escape(x.reason)}</div>`).join('')}</div>`:''}`;
        const apply=m.q('#rt_apply'); if(apply){ apply.classList.toggle('hidden',!proposed); apply.dataset.count=proposed; }
      }
      async function run(apply=false) {
        const ids=selectedIds(); const date=m.q('#rt_date').value;
        if(!ids.length)return OF.toast('Select at least one rep','error');
        if(!date)return OF.toast('Choose a date','error');
        const key=controlsKey();
        if(apply && previewKey!==key)return OF.toast('Preview the current route plan before applying assignments.','error');
        const previewButton=m.q('#rt_go'); const applyButton=m.q('#rt_apply');
        previewButton.disabled=true; if(applyButton)applyButton.disabled=true;
        m.q('#rt_out').innerHTML='<div class="loading-page" role="status" aria-label="Loading route preview" style="min-height:100px"><span class="spinner"></span></div>';
        try {
          const d=apply
            ? await OF.post('/api/admin/routing/auto-assign',{date,technicianIds:ids})
            : await OF.get(`/api/admin/routing/plan?date=${encodeURIComponent(date)}&technicianIds=${ids.join(',')}&includeUnassigned=${m.q('#rt_suggest').checked?'1':'0'}`);
          if(key!==controlsKey()){ invalidatePlan(); return; }
          renderPlan(d,key);
          if(apply){ OF.toast(`${d.appliedCount} appointment${d.appliedCount===1?'':'s'} assigned`,'ok'); render(currentRoot); }
        } catch(e){ m.q('#rt_out').innerHTML=`<p class="muted small" role="alert">${OF.escape(e.message)}</p>`; }
        finally { previewButton.disabled=false; if(applyButton)applyButton.disabled=false; }
      }
      m.q('#rt_go').onclick=()=>run(false);
      m.q('#rt_apply')?.addEventListener('click',async()=>{
        const count=+m.q('#rt_apply').dataset.count||0;
        if(!count)return;
        if(await OF.confirm({title:`Assign ${count} appointment${count===1?'':'s'}?`,body:'<p class="muted">Existing assignments will not be changed. The plan is checked again before saving.</p>',confirmText:'Apply assignments'}))run(true);
      });
      if (selected.size) run(false);
    }

    let currentRoot;
    function syncScheduleUrl() {
      const url = new URL(location.href);
      if (view === 'week') url.searchParams.delete('view'); else url.searchParams.set('view', view);
      url.searchParams.set('date', cursor);
      if (view === 'dispatch' && dispatchSelectionReady) url.searchParams.set('reps', [...dispatchSelection].sort((a,b)=>a-b).join(','));
      else url.searchParams.delete('reps');
      if(planningOpen)url.searchParams.set('plan','1');else url.searchParams.delete('plan');
      history.replaceState({}, '', url.pathname + `?${url.searchParams}`);
    }
    function setScheduleView(next, root) {
      if (next !== 'dispatch') lastCalendarView = next;
      view = next;
      render(root);
    }
    async function render(root) {
      const sequence = ++renderSequence;
      destroyDispatchMap();
      currentRoot = root;
      const r = rangeFor();
      let title = '';
      if (view==='day' || view==='dispatch') title = labelYmd(cursor,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
      else if (view==='week') title = `${labelYmd(r.cells[0],{month:'short',day:'numeric'})} – ${labelYmd(r.cells[6],{month:'short',day:'numeric',year:'numeric'})}`;
      else title = labelYmd(cursor,{month:'long',year:'numeric'});
      const interactionHelp = view==='month'
        ? 'Select a date to open its day schedule.'
        : view==='week'
          ? `Customer names open profiles. Details opens the appointment${OF.hasCap('appointments.manage')?'; drag a job to move it to another day.':'.'}`
          : view==='dispatch'
            ? 'Choose a rep, follow the numbered stop list, then open Timeline when you need to check overlaps.'
            : 'Customer names open profiles. Details opens the appointment without leaving Schedule.';

      root.innerHTML = `
        <div class="sched-toolbar card">
          <div class="sched-nav">
            <div class="sched-nav-buttons">
              <button class="arrow" id="prev" aria-label="Previous ${view==='month'?'month':view==='week'?'week':'day'}">‹</button>
              <button class="btn btn-secondary btn-sm" id="today">Today</button>
              <button class="arrow" id="next" aria-label="Next ${view==='month'?'month':view==='week'?'week':'day'}">›</button>
            </div>
            <span class="sched-title">${title}</span>
            <label class="sched-jump" for="dateJump"><span>Jump to</span><input class="sched-date-jump" id="dateJump" type="date" value="${OF.escape(cursor)}"></label>
          </div>
          <div class="sched-controls">
            <div class="sched-control"><span class="sched-control-label">Workspace</span><div class="sched-mode segmented" id="modeseg" aria-label="Schedule workspace">
              <button data-mode="calendar" class="${view!=='dispatch'?'active':''}" aria-pressed="${view!=='dispatch'}">${OF.icon('cal',14)} Calendar</button>
              <button data-mode="dispatch" class="dispatch-mode-button ${view==='dispatch'?'active':''}" aria-pressed="${view==='dispatch'}">${OF.icon('pin',14)} Dispatch</button>
            </div></div>
            ${view==='dispatch'?'':`<div class="sched-control"><span class="sched-control-label">View</span><div class="segmented" id="viewseg" role="group" aria-label="Calendar view">
              ${['day','week','month'].map(v=>`<button data-v="${v}" class="${view===v?'active':''}" aria-pressed="${view===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}
            </div></div>
            <label class="sched-control sched-tech-control" for="techfilter"><span class="sched-control-label">Rep</span><select id="techfilter" aria-label="Filter calendar by technician"><option value="">All technicians</option></select></label>
            <button class="btn btn-secondary btn-sm sched-route-button" id="routeBtn" title="Preview smart crew assignments">${OF.icon('pin',14)} Smart assign</button>`}
          </div>
        </div>
        <div id="schedulePlanning"></div>
        <div class="sched-help" role="note">${OF.icon('user',14)} <span>${interactionHelp}</span></div>
        <div id="body"><div class="loading-page" role="status" aria-label="Loading schedule"><span class="spinner"></span></div></div>`;
      if (!TECHS) {
        try { TECHS = (await OF.get('/api/admin/technicians')).technicians; technicianLoadError=''; }
        catch(error) { TECHS=[]; technicianLoadError=error.message||'Could not load reps.'; }
      }
      if (sequence !== renderSequence) return;
      if (selectAllRepsAfterReload && !technicianLoadError) {
        dispatchSelection = new Set((TECHS||[]).map((tech)=>Number(tech.id)));
        dispatchSelectionReady = true;
        selectAllRepsAfterReload = false;
      } else if (!dispatchSelectionReady) {
        const params = new URL(location.href).searchParams;
        const hasRequestedReps = params.has('reps');
        const requested = String(params.get('reps') || '').split(',').map(Number).filter(Boolean);
        const availableIds=(TECHS||[]).map((tech)=>Number(tech.id)); const available = new Set(availableIds);
        dispatchSelection = new Set(hasRequestedReps ? requested.filter((id)=>available.has(id)) : availableIds.slice(0,1));
        dispatchSelectionReady = true;
      }
      syncScheduleUrl();
      const tf = document.getElementById('techfilter');
      if (tf) { tf.innerHTML = `<option value="">All technicians</option>` + TECHS.map(t=>`<option value="${t.id}" ${String(techFilter)===String(t.id)?'selected':''}>${OF.escape(t.name)}</option>`).join(''); tf.onchange=()=>{ techFilter=tf.value; render(root); }; }
      const step = view==='day'||view==='dispatch'?1:view==='week'?7:0;
      document.getElementById('prev').onclick=()=>{ cursor = view==='month'? addMonth(-1): addYmd(cursor,-step); render(root); };
      document.getElementById('next').onclick=()=>{ cursor = view==='month'? addMonth(1): addYmd(cursor,step); render(root); };
      document.getElementById('today').onclick=()=>{ cursor=todayYmd(); render(root); };
      document.getElementById('dateJump').onchange=(event)=>{if(/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)){cursor=event.target.value;render(root);}};
      document.getElementById('routeBtn')?.addEventListener('click',()=>routeModal());
      document.querySelectorAll('#modeseg [data-mode]').forEach((button)=>button.onclick=()=>setScheduleView(button.dataset.mode==='dispatch'?'dispatch':lastCalendarView,root));
      document.querySelectorAll('#viewseg [data-v]').forEach(b=>b.onclick=()=>setScheduleView(b.dataset.v,root));

      const body = document.getElementById('body');
      if(technicianLoadError){
        body.innerHTML=`<div class="empty card" role="alert"><div class="ic">${OF.icon('user',22)}</div><h3>Reps could not load</h3><p>${OF.escape(technicianLoadError)}</p><button class="btn btn-secondary btn-sm" id="scheduleRetryTech" type="button">Retry</button></div>`;
        body.querySelector('#scheduleRetryTech').onclick=()=>{TECHS=null;technicianLoadError='';dispatchSelectionReady=false;render(root);};
        return;
      }
      const planningRange=planningWindow();
      const horizonPromise=OF.get(`/api/admin/appointments/calendar?from=${addYmd(planningRange.start,-1)}T00:00:00.000Z&to=${addYmd(planningRange.end,2)}T00:00:00.000Z`).catch(()=>null);
      const requestsPromise=OF.get('/api/admin/appointments?status=requested&limit=200').catch(()=>({appointments:[],total:0}));
      const reviewPromise=OF.get('/api/admin/routing/review').catch(()=>({review:null}));
      let data;
      try { data = await OF.get(`/api/admin/appointments/calendar?from=${r.from}T00:00:00.000Z&to=${r.to}T00:00:00.000Z`); }
      catch(error){
        if(sequence!==renderSequence)return;
        body.innerHTML=`<div class="empty card" role="alert"><div class="ic">${OF.icon('schedule',22)}</div><h3>Schedule could not load</h3><p>${OF.escape(error.message||'Try again in a moment.')}</p><button class="btn btn-secondary btn-sm" id="scheduleRetry" type="button">Retry</button></div>`;
        body.querySelector('#scheduleRetry').onclick=()=>render(root);
        return;
      }
      if (sequence !== renderSequence) return;
      const [loadedHorizon,requestsData,reviewData]=await Promise.all([horizonPromise,requestsPromise,reviewPromise]);
      if(sequence!==renderSequence)return;
      const horizonData=loadedHorizon||{...data,appointments:[...(data.appointments||[])]};
      horizonData.appointments=(horizonData.appointments||[]).filter((appointment)=>{const date=tzYmd(appointment.scheduled_start);return date>=planningRange.start&&date<=planningRange.end;});
      HORIZON_APPTS=horizonData.appointments;
      planningReview=reviewData?.review||null;
      renderSchedulePlanning(document.getElementById('schedulePlanning'),horizonData,requestsData);
      if (view!=='dispatch' && techFilter) data.appointments = data.appointments.filter(a=>(a.technicians||[]).some(t=>String(t.id)===String(techFilter)));
      CURRENT_APPTS = data.appointments;
      const byDay = {}; data.appointments.forEach(a=>{ const k=tzYmd(a.scheduled_start); (byDay[k]=byDay[k]||[]).push(a); });
      if (view==='dispatch') {
        let plan={ routes:[], proposals:[], summary:null };
        if(dispatchSelection.size){
          const ids=[...dispatchSelection].sort((a,b)=>a-b);
          try{plan=await OF.get(`/api/admin/routing/plan?date=${encodeURIComponent(cursor)}&technicianIds=${ids.join(',')}&includeUnassigned=1`);}
          catch(error){plan={routes:[],proposals:[],summary:null,_error:error.message||'Could not load routes.'};}
        }
        if (sequence !== renderSequence) return;
        renderDispatch(body,data.appointments.filter((appointment)=>appointmentWindowInDay(appointment,cursor)),plan);
        if(scrollToDispatchAfterRender){
          scrollToDispatchAfterRender=false;
          requestAnimationFrame(()=>requestAnimationFrame(()=>body.querySelector('.dispatch-surfacebar')?.scrollIntoView({
            behavior:typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',
            block:'start',
          })));
        }
      }
      else if (view==='day') renderDay(body, byDay[cursor]||[], dayMeta(cursor,data));
      else if (view==='week') renderWeek(body, r.cells, byDay, data);
      else renderMonth(body, r.cells, byDay, data, cursor.slice(0,7));
    }
    function addMonth(n){ const [y,m]=cursor.split('-').map(Number); const d=new Date(Date.UTC(y,m-1+n,1)); return ymdUTC(d); }

    function techTag(a){
      const lead=(a.technicians||[]).find(t=>t.is_lead)||(a.technicians||[])[0]; const extra=(a.technicians||[]).length-1;
      const assigned=lead?`<span><span class="m-dot" style="background:${OF.color(lead.color)};display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px"></span>${OF.escape(lead.name)}${extra>0?` +${extra}`:''}</span>`:'<span class="muted">Unassigned</span>';
      const action=OF.hasCap('dispatch.manage')?`<button type="button" class="link-btn sched-assign" data-assign="${a.id}" draggable="false" style="font-size:10px">${lead?'Change':'Assign'}</button>`:'';
      return `<div class="row between" style="font-size:11px;margin-top:3px;gap:5px">${assigned}${action}</div>`;
    }
    function customerButton(a) {
      return `<button type="button" class="schedule-customer-link" data-customer-id="${a.customer_id}" draggable="false" title="Open ${OF.escape(a.customer_name||'customer')} profile">${OF.escape(a.customer_name||'Customer')}</button>`;
    }
    function detailsButton(a) {
      return `<button type="button" class="schedule-details-button" data-open-appointment="${a.id}" draggable="false" aria-label="Open appointment details for ${OF.escape(a.customer_name||'Customer')}" title="Appointment details">${OF.icon('appointments',11)}<span>Details</span></button>`;
    }
    function jobRowSmall(a){
      const movable = OF.hasCap('appointments.manage') && a.status!=='completed' && a.status!=='canceled';
      return `<div class="wc-job${movable?' movable':''}" data-appointment-id="${a.id}" ${movable?`draggable="true" data-id="${a.id}" data-time="${tzHm(a.scheduled_start)}"`:''} style="border-left-color:${OF.color(a.service_color)}" title="Open appointment details for ${OF.escape(a.customer_name||'Customer')}"><div class="wc-job-top"><b>${OF.time(a.scheduled_start)}</b><span class="schedule-job-actions">${movable?'<span class="schedule-drag-hint" aria-hidden="true">Drag</span>':''}${detailsButton(a)}</span></div>${customerButton(a)}<div class="muted" style="font-size:11px">${OF.escape(a.service_name||'')}</div>${techTag(a)}</div>`;
    }

    function bindScheduleInteractions(body) {
      body.querySelectorAll('.schedule-customer-link').forEach((button)=>{
        button.addEventListener('pointerdown',(event)=>event.stopPropagation());
        button.addEventListener('dragstart',(event)=>{event.preventDefault();event.stopPropagation();});
        button.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();openCustomerDetails(button.dataset.customerId);});
      });
      body.querySelectorAll('[data-appointment-id]').forEach((card)=>{
        card.addEventListener('click',(event)=>{
          if(event.target.closest('button,a,input,select,textarea,label'))return;
          openAppointmentDetails(card.dataset.appointmentId);
        });
      });
      body.querySelectorAll('[data-open-appointment]').forEach((button)=>button.addEventListener('click',(event)=>{
        event.preventDefault();event.stopPropagation();openAppointmentDetails(button.dataset.openAppointment);
      }));
      body.querySelectorAll('[data-new-appointment-date]').forEach((button)=>button.addEventListener('click',(event)=>{
        event.stopPropagation();newAppointmentFor(button.dataset.newAppointmentDate);
      }));
      body.querySelectorAll('[data-day-open]').forEach((button)=>button.addEventListener('click',()=>{
        view = 'day';
        lastCalendarView = 'day';
        cursor = button.dataset.dayOpen;
        render(currentRoot);
      }));
    }

    async function assignModal(appointmentId) {
      if(!OF.hasCap('dispatch.manage'))return;
      const appt=CURRENT_APPTS.find(a=>String(a.id)===String(appointmentId))||HORIZON_APPTS.find(a=>String(a.id)===String(appointmentId)); if(!appt)return;
      const selected=new Set((appt.technicians||[]).map(t=>+t.id));
      let lead=+(((appt.technicians||[]).find(t=>t.is_lead)||{}).id||0)||null;
      const m=OF.modal(`<div class="modal-head"><h3>Assign ${OF.escape(appt.customer_name)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><p class="tiny muted" style="margin-top:0">${OF.escape(appt.service_address||'No service address')}</p><div id="sa_list"></div>
          <div class="row" style="gap:8px;margin-top:10px"><input id="sa_new" placeholder="New rep / technician name" style="flex:1"><button class="btn btn-secondary btn-sm" id="sa_add" type="button">Add rep</button></div></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sa_save">Save assignment</button></div>`);
      function draw(){
        m.q('#sa_list').innerHTML=(TECHS||[]).map(t=>`<div class="row between" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2)"><label class="row" style="gap:9px;cursor:pointer"><input class="sa-tech" type="checkbox" value="${t.id}" ${selected.has(+t.id)?'checked':''} style="width:auto"><span class="badge no-dot" style="background:${OF.color(t.color)}1a;color:${OF.color(t.color)}">${OF.escape(t.name)}</span></label><label class="row tiny muted" style="gap:5px;cursor:pointer"><input class="sa-lead" name="sa_lead" type="radio" value="${t.id}" ${lead===+t.id?'checked':''} ${selected.has(+t.id)?'':'disabled'} style="width:auto"> lead</label></div>`).join('')||'<p class="muted small">No reps yet. Add one below.</p>';
        m.el.querySelectorAll('.sa-tech').forEach(c=>c.onchange=()=>{ const id=+c.value;if(c.checked)selected.add(id);else{selected.delete(id);if(lead===id)lead=null;}draw(); });
        m.el.querySelectorAll('.sa-lead').forEach(r=>r.onchange=()=>{lead=+r.value;});
      }
      draw();
      m.q('#sa_add').onclick=async()=>{const input=m.q('#sa_new');const name=input.value.trim();if(!name)return OF.toast('Enter a rep name','error');try{const r=await OF.post('/api/admin/technicians',{name});TECHS.push(r.technician);selected.add(+r.technician.id);lead=lead||+r.technician.id;input.value='';draw();}catch(e){OF.toast(e.message,'error');}};
      m.q('#sa_save').onclick=async()=>{try{await OF.post(`/api/admin/appointments/${appt.id}/assign`,{technicianIds:[...selected],leadId:lead});m.close();OF.toast('Assignment saved','ok');render(currentRoot);}catch(e){OF.toast(e.message,'error');}};
    }

    function bindAssignButtons(body){
      body.querySelectorAll('.sched-assign').forEach(btn=>{
        btn.addEventListener('mousedown',e=>e.stopPropagation());
        btn.addEventListener('dragstart',e=>{e.preventDefault();e.stopPropagation();});
        btn.onclick=e=>{e.preventDefault();e.stopPropagation();assignModal(btn.dataset.assign);};
      });
    }

    function renderDay(body, appts, meta) {
      const max = loadOf(appts);
      const canAdd=OF.hasCap('appointments.manage');
      const head = `<div class="card-head"><h3>${appts.length} appointment${appts.length===1?'':'s'}</h3><div class="actions"><span>${capPill(appts.length,max,meta.capacity,meta.closed)}</span>${canAdd?`<button class="btn btn-primary btn-sm" type="button" data-new-appointment-date="${cursor}">${OF.icon('plus',14)} Add appointment</button>`:''}</div></div>`;
      if (!appts.length) { body.innerHTML = `<div class="card schedule-day-card">${head}<div class="empty"><div class="ic">${OF.icon('schedule',22)}</div><p>${meta.closed?'This day is marked closed.':'Nothing scheduled yet.'}</p>${canAdd?`<button class="btn btn-secondary btn-sm" type="button" data-new-appointment-date="${cursor}">${OF.icon('plus',14)} Add appointment</button>`:''}</div></div>`; bindScheduleInteractions(body); return; }
      body.innerHTML = `<div class="card schedule-day-card">${head}<div class="card-pad agenda">` + appts.sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start)).map(a=>`
        <div class="slot-row"><div class="time">${OF.time(a.scheduled_start)}</div>
        <div class="job" style="border-left-color:${OF.color(a.service_color)}" data-appointment-id="${a.id}" title="Open appointment details for ${OF.escape(a.customer_name||'Customer')}">
          <div class="row between">${customerButton(a)}<span class="schedule-job-actions">${OF.statusBadge(a.status)}${detailsButton(a)}</span></div>
          <div class="small muted" style="margin-top:3px">${a.service_name?OF.escape(a.service_name):''}${a.service_address?` · ${OF.escape(a.service_address)}`:''}</div>
          ${techTag(a)}
        </div></div>`).join('') + `</div></div>`;
      bindScheduleInteractions(body);
      bindAssignButtons(body);
    }

    function renderWeek(body, cells, byDay, data) {
      body.innerHTML = `${OF.hasCap('appointments.manage')?'<div class="tiny muted" style="margin:-2px 0 8px">Tip: drag a visible job to another day, or open a day to see the full run sheet.</div>':''}<div class="week-grid">` + cells.map(d=>{
        const appts=(byDay[d]||[]).sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start));
        const meta=dayMeta(d,data); const max=loadOf(appts); const isToday=d===todayYmd(); const preview=appts.slice(0,5); const more=Math.max(0,appts.length-preview.length); const unassigned=appts.filter(isUnassigned).length;
        return `<div class="week-col ${meta.closed?'closed':''} ${isToday?'today':''}" data-ymd="${d}">
          <div class="wc-head"><button class="wc-day-button" type="button" data-day-open="${d}" aria-label="Open ${OF.escape(labelYmd(d,{weekday:'long',month:'long',day:'numeric'}))} day schedule"><span>${labelYmd(d,{weekday:'short',month:'short',day:'numeric'})}</span><strong>${appts.length}</strong></button>${OF.hasCap('appointments.manage')?`<button class="wc-add-button" type="button" data-new-appointment-date="${d}" aria-label="Add appointment on ${OF.escape(labelYmd(d,{weekday:'long',month:'long',day:'numeric'}))}">${OF.icon('plus',13)}</button>`:''}</div>
          <div class="wc-body">${preview.map(jobRowSmall).join('')||'<span class="muted" style="font-size:11px;padding:4px">Nothing scheduled</span>'}${more?`<button type="button" class="wc-more" data-day-open="${d}">+${more} more · Open full day</button>`:''}</div>
          <div class="wc-foot">${capPill(appts.length,max,meta.capacity,meta.closed)}${unassigned?`<span class="wc-unassigned">${unassigned} unassigned</span>`:'<span class="wc-ready">Assigned</span>'}</div>
        </div>`;
      }).join('') + `</div>`;
      bindScheduleInteractions(body);
      bindAssignButtons(body);
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
        const dots = appts.slice(0,5).map(a=>`<span class="m-dot" style="background:${OF.color(a.service_color)}"></span>`).join('');
        return `<button type="button" class="m-cell ${out?'out':''} ${meta.closed?'closed':''} ${isToday?'today':''}" data-day-open="${d}" aria-label="Open ${OF.escape(labelYmd(d,{weekday:'long',month:'long',day:'numeric'}))}, ${appts.length} appointment${appts.length===1?'':'s'}">
          <span class="row between"><span class="m-num">${labelYmd(d,{day:'numeric'})}</span>${appts.length?(max>meta.capacity?`<span class="cap-pill" style="background:var(--danger-tint);color:var(--danger)">${appts.length}</span>`:`<span class="cap-pill" style="background:var(--brand-tint);color:var(--brand-700)">${appts.length}</span>`):''}</span>
          <span class="m-dots">${dots}</span>
        </button>`;
      }).join('') + `</div>`;
      bindScheduleInteractions(body);
    }

    OF.page({ active:'schedule', title:'Schedule', subtitle:'Calendar, dispatch routes & capacity at a glance', render: async (root, ctx) => {
      const content = root.closest('.content');
      if(new URL(location.href).searchParams.get('plan')==='1'){planningOpen=true;planningStep=0;}
      content?.classList.add('schedule-content-wide');
      root.classList.add('schedule-view-root');
      OF.onCleanup(()=>{content?.classList.remove('schedule-content-wide');destroyDispatchMap();});
      ctx.setActions(OF.hasCap('appointments.manage')?`<button class="btn btn-primary btn-sm" id="scheduleNewAppointment" data-new-appointment type="button">${OF.icon('plus',15)} New appointment</button>`:'');
      document.getElementById('scheduleNewAppointment')?.addEventListener('click',()=>newAppointmentFor(cursor));
      await render(root);
    }});
