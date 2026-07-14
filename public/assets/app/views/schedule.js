// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

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
    let renderSequence = 0;
    let technicianLoadError = '';
    let pendingDispatchFocus = '';

    const ymdUTC = (d) => new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
    const addYmd = (ymd,n) => ymdUTC(new Date(new Date(ymd+'T00:00:00Z').getTime()+n*86400000));
    const dowOf = (ymd) => new Date(ymd+'T00:00:00Z').getUTCDay();
    const tzYmd = (iso) => new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
    const tzHm = (iso) => new Intl.DateTimeFormat('en-GB',{timeZone:TZ(),hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
    const labelYmd = (ymd,opts) => new Intl.DateTimeFormat('en-US',{timeZone:'UTC',...opts}).format(new Date(ymd+'T12:00:00Z'));
    const todayYmd = tenantYmd;

    function rangeFor() {
      if (view==='day' || view==='dispatch') return { from: addYmd(cursor,-1), to: addYmd(cursor,2), cells:[cursor] };
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
      if (!summary.stops) return '<span class="dispatch-metric-quality unavailable">No route metrics</span><span class="dispatch-metric"><b>0</b> stops</span>';
      const qualityClass=quality.includes('partial')?'partial':quality.includes('unavailable')?'unavailable':'';
      const qualityLabel=quality.includes('partial')?'Partial per-rep estimates':quality.includes('unavailable')?'Connect coordinates for estimates':'Per-rep route estimates';
      return `<span class="dispatch-metric-quality ${qualityClass}">${qualityLabel}</span>
        <span class="dispatch-metric"><b>${summary.stops}</b> stops</span>
        <span class="dispatch-metric"><b>${summary.miles==null?'—':summary.miles.toFixed(1)}</b> mi</span>
        <span class="dispatch-metric"><b>${summary.drive==null?'—':driveLabel(summary.drive)}</b> drive</span>
        <span class="dispatch-metric"><b>${summary.fuel==null?'—':`$${summary.fuel.toFixed(2)}`}</b> fuel</span>`;
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
    function mapProjection(stops) {
      const valid = stops.filter((stop) => coord(stop.lat,-85,85)!=null && coord(stop.lng,-180,180)!=null);
      if (!valid.length) return null;
      let west=Math.min(...valid.map((stop)=>Number(stop.lng))); let east=Math.max(...valid.map((stop)=>Number(stop.lng)));
      let south=Math.min(...valid.map((stop)=>Number(stop.lat))); let north=Math.max(...valid.map((stop)=>Number(stop.lat)));
      const lngPad=Math.max((east-west)*.14,.012); const latPad=Math.max((north-south)*.14,.009);
      west=Math.max(-180,west-lngPad); east=Math.min(180,east+lngPad); south=Math.max(-85,south-latPad); north=Math.min(85,north+latPad);
      const mercatorY=(lat)=>Math.log(Math.tan(Math.PI/4+(lat*Math.PI/180)/2));
      const northY=mercatorY(north); const southY=mercatorY(south);
      const point=(stop)=>({
        x:((Number(stop.lng)-west)/(east-west))*1000,
        y:((northY-mercatorY(Number(stop.lat)))/(northY-southY))*620,
      });
      const bbox=[west,south,east,north].map((value)=>value.toFixed(6)).join(',');
      const params=new URLSearchParams({bbox,layer:'mapnik'});
      return { valid, point, src:`https://www.openstreetmap.org/export/embed.html?${params.toString()}` };
    }
    function geometryPoints(route) {
      const geometry=route?.geometry;
      const lines=geometry?.type==='MultiLineString' ? geometry.coordinates : geometry?.type==='LineString' ? [geometry.coordinates] : [];
      return lines.map((line)=>(line||[]).map((pair)=>({lng:coord(pair?.[0],-180,180),lat:coord(pair?.[1],-85,85)})).filter((point)=>point.lng!=null&&point.lat!=null)).filter((line)=>line.length>=2);
    }
    function dispatchMap(plan) {
      const routes=plan?.routes||[];
      const allStops=routes.flatMap((route)=>(route.stops||[]).map((stop)=>({...stop,_route:route})));
      const origin=coord(plan?.origin?.lat,-85,85)!=null&&coord(plan?.origin?.lng,-180,180)!=null?{lat:Number(plan.origin.lat),lng:Number(plan.origin.lng)}:null;
      const routeLines=routes.map((route)=>({route,lines:geometryPoints(route)}));
      const mapPoints=[...allStops,...routeLines.flatMap((item)=>item.lines.flat()),...(origin?[origin]:[])];
      const projection=mapProjection(mapPoints);
      const missing=new Set(allStops.filter((stop)=>coord(stop.lat,-85,85)==null||coord(stop.lng,-180,180)==null).map((stop)=>String(stop.appointmentId))).size;
      const planError=plan?._error;
      let mapBody='';
      if(planError){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('pin',22)}</div><h3>Route preview unavailable</h3><p>${OF.escape(planError)}</p><button class="btn btn-secondary btn-sm" type="button" data-dispatch-retry>Retry routes</button></div>`;
      } else if(!dispatchSelection.size){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('user',22)}</div><h3>Select a rep</h3><p>Choose one or more reps above to draw their routes.</p></div>`;
      } else if(!allStops.length){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('schedule',22)}</div><h3>No routed stops</h3><p>There are no assigned or suggested stops for this day.</p></div>`;
      } else if(!projection){
        mapBody=`<div class="dispatch-map-empty"><div class="ic">${OF.icon('pin',22)}</div><h3>Connect geocoding to map routes</h3><p>These stops have addresses but no coordinates yet. Connect Google or Mapbox in Settings → Integrations.</p><a class="btn btn-secondary btn-sm" href="/admin/settings?tab=integrations">Open integrations</a></div>`;
      } else {
        const lines=routeLines.map(({route,lines:geometryLines})=>{
          // A partial backend geometry intentionally contains only adjacent,
          // measurable legs. Never rebuild it by filtering missing stops: that
          // would draw a false hop across an address with no coordinates.
          const fallback=route.quality==='partial'?[]:(route.stops||[]).filter((stop)=>coord(stop.lat,-85,85)!=null&&coord(stop.lng,-180,180)!=null);
          const source=geometryLines.length?geometryLines:(fallback.length>=2?[fallback]:[]);
          return source.map((line)=>{const points=line.map(projection.point);return `<polyline points="${points.map((point)=>`${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${OF.color(route.technician?.color)}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="11 8" vector-effect="non-scaling-stroke"/>`;}).join('');
        }).join('');
        const markers=routes.flatMap((route)=>(route.stops||[]).map((stop,index)=>({route,stop,index})))
          .filter(({stop})=>coord(stop.lat,-85,85)!=null&&coord(stop.lng,-180,180)!=null)
          .map(({route,stop,index})=>{const point=projection.point(stop);const left=(point.x/10).toFixed(3);const top=(point.y/6.2).toFixed(3);const lane=String(route.technician?.id||stop.technicianId||'unassigned');return `<a class="dispatch-map-marker${stop.assignment==='proposed'?' proposed':''}" style="--marker:${OF.color(route.technician?.color)};left:${left}%;top:${top}%" href="#dispatch-job-${encodeURIComponent(String(stop.appointmentId))}-${encodeURIComponent(lane)}" aria-label="Find stop ${index+1}, ${OF.escape(stop.customerName||'customer')}, in ${OF.escape(route.technician?.name||'rep')}'s timeline"><span>${index+1}</span></a>`;}).join('');
        const base=origin?(()=>{const point=projection.point(origin);return `<span class="dispatch-map-marker base" style="left:${(point.x/10).toFixed(3)}%;top:${(point.y/6.2).toFixed(3)}%" role="img" aria-label="Business base"><span>B</span></span>`;})():'';
        mapBody=`<iframe class="dispatch-map-frame" title="Static route map for ${OF.escape(labelYmd(cursor,{month:'long',day:'numeric'}))}" src="${OF.escape(projection.src)}" loading="lazy" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true"></iframe><svg class="dispatch-map-lines" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>${base}${markers}`;
      }
      const routeRows=routes.map((route)=>{
        const maps=safeHttpsUrl(route.mapsUrl); const bits=routeMetricBits(route);
        return `<div class="dispatch-route-row"><span class="dispatch-route-color" style="background:${OF.color(route.technician?.color)}"></span><div><b>${OF.escape(route.technician?.name||'Rep')}</b><span>${OF.escape(bits.join(' · '))}</span></div>${maps?`<a href="${OF.escape(maps)}" target="_blank" rel="noopener" aria-label="Open ${OF.escape(route.technician?.name||'rep')} route in Google Maps">${OF.icon('pin',14)} Maps</a>`:''}</div>`;
      }).join('');
      const routeList=planError
        ? '<p class="tiny muted">Route summaries could not load. <button class="link-btn" type="button" data-dispatch-retry>Retry</button></p>'
        : (routeRows||(dispatchSelection.size
          ? '<p class="tiny muted">No route summaries are available for the selected reps.</p>'
          : '<p class="tiny muted">Select reps to see route summaries.</p>'));
      return `<section class="dispatch-map-panel card" aria-label="Route map">
        <div class="dispatch-panel-head"><div><span class="dispatch-eyebrow">Route overview</span><h3>${OF.escape(labelYmd(cursor,{weekday:'long',month:'short',day:'numeric'}))}</h3></div><div class="dispatch-map-metrics">${metricChips(plan)}</div></div>
        <div class="dispatch-map-stage">${mapBody}</div>
        ${missing?`<div class="dispatch-map-warning">${OF.icon('bell',14)} ${missing} stop${missing===1?' is':'s are'} missing coordinates; its route line may be incomplete.</div>`:''}
        <div class="dispatch-route-list">${routeList}</div>
        <div class="dispatch-map-credit">Static map © OpenStreetMap contributors · Dashed lines show estimated stop order, not turn-by-turn roads.</div>
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
          return `<a class="dispatch-job status-${OF.escape(status)}${suggested?' suggested':''}" id="dispatch-job-${encodeURIComponent(String(appointment.id))}-${encodeURIComponent(lane.id)}" href="/admin/appointments?id=${encodeURIComponent(String(appointment.id))}" style="top:${top.toFixed(1)}px;height:${cardHeight.toFixed(1)}px;--job-color:${color}${packed}" title="${OF.escape(`${OF.time(appointment.scheduled_start)} · ${appointment.customer_name||'Customer'} · ${appointment.service_address||''}`)}">
            <span class="dispatch-job-time">${continues?'Continues':OF.time(appointment.scheduled_start)}${suggested?'<em>Suggested</em>':''}</span><b>${OF.escape(appointment.customer_name||'Customer')}</b><small>${OF.escape(appointment.service_name||appointment.service_address||'Service')}</small></a>`;
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
      const allSelected=Boolean((TECHS||[]).length)&&dispatchSelection.size===(TECHS||[]).length;
      const proposed=(plan?.routes||[]).reduce((count,route)=>count+(Number(route.proposedCount)||0),0);
      const canDispatch=OF.hasCap('dispatch.manage'); const summary=planSummary(plan);
      body.innerHTML=`<div class="dispatch-board">
        <span class="dispatch-sr-only" role="status" aria-live="polite">${plan?._error?'Route preview failed.':`${summary.stops} scheduled stop${summary.stops===1?'':'s'} shown for ${dispatchSelection.size} rep${dispatchSelection.size===1?'':'s'}.`}</span>
        <div class="dispatch-filterbar card"><div><span class="dispatch-eyebrow">Show routes for</span><div class="dispatch-rep-chips" role="group" aria-label="Filter dispatch board by rep">
          <button type="button" class="dispatch-rep-chip all${allSelected?' active':''}" id="dispatchAll" aria-pressed="${allSelected}">All reps</button>
          ${(TECHS||[]).map((tech)=>`<button type="button" class="dispatch-rep-chip${dispatchSelection.has(Number(tech.id))?' active':''}" data-dispatch-tech="${tech.id}" aria-pressed="${dispatchSelection.has(Number(tech.id))}"><span style="background:${OF.color(tech.color)}"></span>${OF.escape(tech.name)}</button>`).join('')}
          ${(TECHS||[]).length?'<button type="button" class="dispatch-clear" id="dispatchClear">Clear</button>':''}
        </div></div><div class="dispatch-filter-note">${proposed?`<span class="badge ok no-dot">${proposed} nearby suggestion${proposed===1?'':'s'}</span><button class="btn btn-secondary btn-sm" type="button" id="dispatchReview">${canDispatch?'Review &amp; apply':'Review routes'}</button>`:''}<span>Striped cards = suggestions · Dashed map lines = estimated stop order</span></div></div>
        <div class="dispatch-workspace">${dispatchMap(plan)}${dispatchTimeline(appts,plan)}</div>
      </div>`;
      body.querySelector('#dispatchAll')?.addEventListener('click',()=>{pendingDispatchFocus='#dispatchAll';dispatchSelection=new Set((TECHS||[]).map((tech)=>Number(tech.id)));render(currentRoot);});
      body.querySelector('#dispatchClear')?.addEventListener('click',()=>{pendingDispatchFocus='#dispatchClear';dispatchSelection.clear();render(currentRoot);});
      body.querySelectorAll('[data-dispatch-tech]').forEach((button)=>button.addEventListener('click',()=>{const id=Number(button.dataset.dispatchTech);pendingDispatchFocus=`[data-dispatch-tech="${id}"]`;if(dispatchSelection.has(id))dispatchSelection.delete(id);else dispatchSelection.add(id);render(currentRoot);}));
      body.querySelector('#dispatchReview')?.addEventListener('click',()=>routeModal());
      body.querySelectorAll('[data-dispatch-retry]').forEach((button)=>button.addEventListener('click',()=>render(currentRoot)));
      if(pendingDispatchFocus){const selector=pendingDispatchFocus;pendingDispatchFocus='';requestAnimationFrame(()=>body.querySelector(selector)?.focus());}
    }

    async function routeModal() {
      const canDispatch = OF.hasCap('dispatch.manage');
      const selected = new Set(view==='dispatch' ? dispatchSelection : (techFilter ? [+techFilter] : (TECHS||[]).map(t=>+t.id)));
      const m = OF.modal(`<div class="modal-head"><h3>Plan routes</h3><button class="x" data-close aria-label="Close route planner">&times;</button></div>
        <div class="modal-body" style="min-height:220px">
          <div class="grid cols-2">
            <div class="field"><div class="row between"><span id="rt_techs_label" style="margin:0">Reps / technicians</span><span><button type="button" class="link-btn tiny" id="rt_all">All</button> <button type="button" class="link-btn tiny" id="rt_none">None</button></span></div><div id="rt_techs" class="card" role="group" aria-labelledby="rt_techs_label" style="padding:4px 10px;max-height:150px;overflow:auto"></div></div>
            <div><div class="field"><label for="rt_date">Date</label><select id="rt_date">${OF.dateSelectOptions(cursor)}</select></div>
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
      history.replaceState({}, '', url.pathname + `?${url.searchParams}`);
    }
    function setScheduleView(next, root) {
      if (next !== 'dispatch') lastCalendarView = next;
      view = next;
      render(root);
    }
    async function render(root) {
      const sequence = ++renderSequence;
      currentRoot = root;
      const r = rangeFor();
      let title = '';
      if (view==='day' || view==='dispatch') title = labelYmd(cursor,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
      else if (view==='week') title = `${labelYmd(r.cells[0],{month:'short',day:'numeric'})} – ${labelYmd(r.cells[6],{month:'short',day:'numeric',year:'numeric'})}`;
      else title = labelYmd(cursor,{month:'long',year:'numeric'});

      root.innerHTML = `
        <div class="sched-toolbar">
          <div class="sched-mode segmented" id="modeseg" aria-label="Schedule mode">
            <button data-mode="calendar" class="${view!=='dispatch'?'active':''}" aria-pressed="${view!=='dispatch'}">${OF.icon('cal',14)} Calendar</button>
            <button data-mode="dispatch" class="dispatch-mode-button ${view==='dispatch'?'active':''}" aria-pressed="${view==='dispatch'}">${OF.icon('pin',14)} Dispatch</button>
          </div>
          <button class="arrow" id="prev" aria-label="Previous ${view==='month'?'month':view==='week'?'week':'day'}">‹</button><button class="arrow" id="next" aria-label="Next ${view==='month'?'month':view==='week'?'week':'day'}">›</button>
          <button class="btn btn-secondary btn-sm" id="today">Today</button>
          <input class="sched-date-jump" id="dateJump" type="date" value="${OF.escape(cursor)}" aria-label="Jump to schedule date">
          <button class="btn btn-secondary btn-sm" id="routeBtn" title="Plan routes${OF.hasCap('dispatch.manage')?' and assign nearby stops':''}">${OF.icon('pin',14)} ${OF.hasCap('dispatch.manage')?'Plan &amp; assign':'Plan routes'}</button>
          <span class="sched-title">${title}</span>
          ${view==='dispatch'?'':`<select id="techfilter" aria-label="Filter calendar by technician" style="margin-left:auto;max-width:190px"><option value="">All technicians</option></select>`}
          <div class="segmented ${view==='dispatch'?'hidden':''}" id="viewseg" role="group" aria-label="Calendar view">
            ${['day','week','month'].map(v=>`<button data-v="${v}" class="${view===v?'active':''}" aria-pressed="${view===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}
          </div>
        </div>
        <div id="body"><div class="loading-page" role="status" aria-label="Loading schedule"><span class="spinner"></span></div></div>`;
      if (!TECHS) {
        try { TECHS = (await OF.get('/api/admin/technicians')).technicians; technicianLoadError=''; }
        catch(error) { TECHS=[]; technicianLoadError=error.message||'Could not load reps.'; }
      }
      if (sequence !== renderSequence) return;
      if (!dispatchSelectionReady) {
        const params = new URL(location.href).searchParams;
        const hasRequestedReps = params.has('reps');
        const requested = String(params.get('reps') || '').split(',').map(Number).filter(Boolean);
        const available = new Set((TECHS||[]).map((tech)=>Number(tech.id)));
        dispatchSelection = new Set(hasRequestedReps ? requested.filter((id)=>available.has(id)) : available);
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
      document.getElementById('routeBtn').onclick=()=>routeModal();
      document.querySelectorAll('#modeseg [data-mode]').forEach((button)=>button.onclick=()=>setScheduleView(button.dataset.mode==='dispatch'?'dispatch':lastCalendarView,root));
      document.querySelectorAll('#viewseg [data-v]').forEach(b=>b.onclick=()=>setScheduleView(b.dataset.v,root));

      const body = document.getElementById('body');
      if(technicianLoadError){
        body.innerHTML=`<div class="empty card" role="alert"><div class="ic">${OF.icon('user',22)}</div><h3>Reps could not load</h3><p>${OF.escape(technicianLoadError)}</p><button class="btn btn-secondary btn-sm" id="scheduleRetryTech" type="button">Retry</button></div>`;
        body.querySelector('#scheduleRetryTech').onclick=()=>{TECHS=null;technicianLoadError='';dispatchSelectionReady=false;render(root);};
        return;
      }
      let data;
      try { data = await OF.get(`/api/admin/appointments/calendar?from=${r.from}T00:00:00.000Z&to=${r.to}T00:00:00.000Z`); }
      catch(error){
        if(sequence!==renderSequence)return;
        body.innerHTML=`<div class="empty card" role="alert"><div class="ic">${OF.icon('schedule',22)}</div><h3>Schedule could not load</h3><p>${OF.escape(error.message||'Try again in a moment.')}</p><button class="btn btn-secondary btn-sm" id="scheduleRetry" type="button">Retry</button></div>`;
        body.querySelector('#scheduleRetry').onclick=()=>render(root);
        return;
      }
      if (sequence !== renderSequence) return;
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
    function jobRowSmall(a){ const movable = a.status!=='completed' && a.status!=='canceled'; return `<div class="wc-job${movable?' movable':''}" ${movable?`draggable="true" data-id="${a.id}" data-time="${tzHm(a.scheduled_start)}"`:''} style="border-left-color:${OF.color((((a.technicians||[]).find(t=>t.is_lead)||{}).color)||a.service_color)}" onclick="OF.go('/admin/appointments?id=${a.id}')"><b>${OF.time(a.scheduled_start)}</b> ${OF.escape(a.customer_name)}<div class="muted" style="font-size:11px">${OF.escape(a.service_name||'')}</div>${techTag(a)}</div>`; }

    async function assignModal(appointmentId) {
      if(!OF.hasCap('dispatch.manage'))return;
      const appt=CURRENT_APPTS.find(a=>String(a.id)===String(appointmentId)); if(!appt)return;
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
      const head = `<div class="card-head"><h3>${appts.length} appointment${appts.length===1?'':'s'}</h3><span style="margin-left:auto">${capPill(appts.length,max,meta.capacity,meta.closed)}</span></div>`;
      if (!appts.length) { body.innerHTML = `<div class="card schedule-day-card">${head}<div class="empty"><div class="ic">${OF.icon('schedule',22)}</div><p>${meta.closed?'This day is marked closed.':'Nothing scheduled.'} <a href="/admin/appointments?new=1">Add a job</a>.</p></div></div>`; return; }
      body.innerHTML = `<div class="card schedule-day-card">${head}<div class="card-pad agenda">` + appts.sort((a,b)=>new Date(a.scheduled_start)-new Date(b.scheduled_start)).map(a=>`
        <div class="slot-row"><div class="time">${OF.time(a.scheduled_start)}</div>
        <div class="job" style="border-left-color:${OF.color(a.service_color)}" onclick="OF.go('/admin/appointments?id=${a.id}')">
          <div class="row between"><span class="cell-strong">${OF.escape(a.customer_name)}</span>${OF.statusBadge(a.status)}</div>
          <div class="small muted" style="margin-top:3px">${a.service_name?OF.escape(a.service_name):''}${a.service_address?` · ${OF.escape(a.service_address)}`:''}</div>
          ${techTag(a)}
        </div></div>`).join('') + `</div></div>`;
      bindAssignButtons(body);
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
        return `<div class="m-cell ${out?'out':''} ${meta.closed?'closed':''} ${isToday?'today':''}" onclick="window.__schedGo('${d}')">
          <div class="row between"><span class="m-num">${labelYmd(d,{day:'numeric'})}</span>${appts.length?(max>meta.capacity?`<span class="cap-pill" style="background:var(--danger-tint);color:var(--danger)">${appts.length}</span>`:`<span class="cap-pill" style="background:var(--brand-tint);color:var(--brand-700)">${appts.length}</span>`):''}</div>
          <div class="m-dots">${dots}</div>
        </div>`;
      }).join('') + `</div>`;
    }

    OF.page({ active:'schedule', title:'Schedule', subtitle:'Calendar, dispatch routes & capacity at a glance', render: async (root, ctx) => {
      const content = root.closest('.content');
      content?.classList.add('schedule-content-wide');
      root.classList.add('schedule-view-root');
      OF.onCleanup(()=>content?.classList.remove('schedule-content-wide'));
      ctx.setActions(`<a class="btn btn-primary btn-sm" href="/admin/appointments?new=1">${OF.icon('plus',15)} New appointment</a>`);
      window.render = render; // allow inline onclick handlers to re-render
      await render(root);
    }});
  
    window.__schedGo = (d) => { view = 'day'; lastCalendarView = 'day'; cursor = d; render(document.getElementById('content')); };
