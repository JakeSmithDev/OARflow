// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    const PAGE_SIZE = 200;
    const MAX_LOADED = 1000;

    function localYmd(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: OF.tenant?.timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function firstSlotAt(appointment) {
      const starts = (appointment.requested_slots || []).map((slot) => Date.parse(slot.start)).filter(Number.isFinite);
      return starts.length ? Math.min(...starts) : null;
    }

    async function loadAppointments() {
      const params = `status=requested&limit=${PAGE_SIZE}&includeAssignments=1`;
      const first = await OF.get(`/api/admin/appointments?${params}`);
      const total = Number(first.total) || (first.appointments || []).length;
      const loadCount = Math.min(total, MAX_LOADED);
      const offsets = [];
      for (let offset = PAGE_SIZE; offset < loadCount; offset += PAGE_SIZE) offsets.push(offset);
      const pages = await Promise.all(offsets.map((offset) => OF.get(`/api/admin/appointments?${params}&offset=${offset}`)));
      return { ...first, appointments: [first, ...pages].flatMap((page) => page.appointments || []), total };
    }

    function requestItems(appointments, reschedules) {
      const bookings = appointments.map((appointment) => {
        const technicians = appointment.technicians || [];
        const slots = appointment.requested_slots || [];
        return {
          type: 'booking', status: slots.length ? 'proposed' : 'needs_time', data: appointment,
          createdAt: appointment.created_at, submittedDate: localYmd(appointment.created_at), appointmentAt: firstSlotAt(appointment),
          customer: appointment.customer_name || '', address: appointment.service_address || '', technicians,
          haystack: [appointment.customer_name, appointment.customer_email, appointment.customer_phone, appointment.service_address,
            appointment.service_name, appointment.notes, ...technicians.map((tech) => tech.name)].filter(Boolean).join(' ').toLowerCase(),
        };
      });
      const changes = reschedules.map((followUp) => ({
        type: 'reschedule', status: 'reschedule', data: followUp,
        createdAt: followUp.created_at || followUp.due_at, submittedDate: localYmd(followUp.created_at || followUp.due_at), appointmentAt: null,
        customer: followUp.customer_name || 'Customer', address: '', technicians: followUp.technicians || [],
        haystack: [followUp.customer_name, followUp.customer_email, followUp.title, followUp.note,
          ...(followUp.technicians || []).map((tech) => tech.name)].filter(Boolean).join(' ').toLowerCase(),
      }));
      return [...bookings, ...changes];
    }

    function isFiltered(state) {
      return Boolean(state.q || state.status !== 'all' || state.date || state.rep !== 'all' || state.sort !== 'newest');
    }

    function filteredItems(items, state) {
      const query = state.q.trim().toLowerCase();
      const visible = items.filter((item) => {
        if (query && !item.haystack.includes(query)) return false;
        if (state.status !== 'all' && item.status !== state.status) return false;
        if (state.date && item.submittedDate !== state.date) return false;
        if (state.rep !== 'all') {
          if (state.rep === 'unassigned') return item.technicians.length === 0;
          if (!item.technicians.some((tech) => String(tech.id) === state.rep)) return false;
        }
        return true;
      });
      const byCreated = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      visible.sort((a, b) => {
        if (state.sort === 'oldest') return -byCreated(a, b);
        if (state.sort === 'customer') return a.customer.localeCompare(b.customer, undefined, { sensitivity: 'base' }) || byCreated(a, b);
        if (state.sort === 'address') return a.address.localeCompare(b.address, undefined, { sensitivity: 'base' }) || byCreated(a, b);
        if (state.sort === 'appointment') {
          const aHasTime = Number.isFinite(a.appointmentAt); const bHasTime = Number.isFinite(b.appointmentAt);
          if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
          if (aHasTime && a.appointmentAt !== b.appointmentAt) return a.appointmentAt - b.appointmentAt;
        }
        return byCreated(a, b);
      });
      return visible;
    }

    function crewHtml(technicians) {
      if (!technicians.length) return '<span class="rq-unassigned">Unassigned</span>';
      return technicians.map((tech) => {
        const color = OF.color(tech.color);
        return `<span class="badge no-dot" style="background:${color}1a;color:${color}">${tech.is_lead ? '★ ' : ''}${OF.escape(tech.name)}</span>`;
      }).join('');
    }

    function bookingCard(appointment, picks, manual) {
      const slots = appointment.requested_slots || [];
      const color = OF.color(appointment.service_color);
      const picked = picks[appointment.id];
      const manualValue = manual[appointment.id] || { date: '', time: '' };
      const canConfirm = slots.length ? picked != null : Boolean(manualValue.date && manualValue.time);
      const contact = [appointment.customer_phone, appointment.customer_email].filter(Boolean).map(OF.escape).join(' · ');
      return `<article class="card card-pad rq-card" data-id="${appointment.id}">
        <div class="rq-card-head">
          <div class="rq-title-line"><span class="cell-strong rq-customer">${OF.escape(appointment.customer_name || 'Customer')}</span>
            <span class="badge no-dot" style="background:${color}1a;color:${color}">${OF.escape(appointment.service_name || 'Service')}</span>
            <span class="badge ${slots.length ? 'info' : 'warn'} no-dot">${slots.length ? 'Times proposed' : 'Needs a time'}</span></div>
          <span class="tiny muted nowrap">Requested ${OF.date(appointment.created_at)}</span>
        </div>
        <div class="rq-details">
          ${appointment.service_address ? `<span>${OF.icon('pin',14)} ${OF.escape(appointment.service_address)}</span>` : ''}
          ${contact ? `<span>${OF.icon('user',14)} ${contact}</span>` : ''}
          <span class="rq-crew">${OF.icon('appointments',14)} ${crewHtml(appointment.technicians || [])}</span>
        </div>
        ${appointment.notes ? `<p class="rq-note">${OF.escape(appointment.notes)}</p>` : ''}
        ${slots.length ? `<div class="rq-section-label">Proposed times — choose one to confirm</div>
          <div class="row wrap rq-slots">${slots.map((slot, index) => `<button type="button" class="chip slotpick ${picked === index ? 'active' : ''}" aria-pressed="${picked === index ? 'true' : 'false'}" data-id="${appointment.id}" data-i="${index}">${OF.date(slot.start)} · ${OF.time(slot.start)}</button>`).join('')}</div>`
          : `<div class="rq-section-label">Choose an appointment time</div><div class="rq-manual-grid">
              <label><span>Date</span><select class="manual_date" data-id="${appointment.id}">${OF.dateSelectOptions(manualValue.date)}</select></label>
              <label><span>Time</span><select class="manual_time" data-id="${appointment.id}"><option value="">Choose a time…</option>${OF.timeSelectOptions(manualValue.time)}</select></label>
            </div>`}
        <div class="row wrap rq-actions">
          <button type="button" class="btn btn-primary btn-sm confirmBtn" data-id="${appointment.id}" data-label="${slots.length ? 'Confirm selected' : 'Confirm time'}" ${canConfirm ? '' : 'disabled'}>${OF.icon('check',15)} ${slots.length ? 'Confirm selected' : 'Confirm time'}</button>
          <button type="button" class="btn btn-danger-soft btn-sm declineBtn" data-id="${appointment.id}">Decline</button>
          <a class="btn btn-ghost btn-sm" href="/admin/appointments?id=${appointment.id}">Details</a>
        </div>
      </article>`;
    }

    function rescheduleCard(followUp) {
      const appointmentLink = followUp.appointment_id
        ? `<a class="btn btn-secondary btn-sm" href="/admin/appointments?id=${followUp.appointment_id}">Appointment</a>` : '';
      return `<article class="card card-pad rq-card rq-reschedule-card" data-follow-up-id="${followUp.id}">
        <div class="rq-card-head">
          <div class="rq-title-line"><span class="cell-strong rq-customer">${OF.escape(followUp.customer_name || 'Customer')}</span><span class="badge warn no-dot">Reschedule</span></div>
          <span class="tiny muted nowrap">Requested ${OF.date(followUp.created_at || followUp.due_at)}</span>
        </div>
        <div class="rq-details"><span class="rq-crew">${OF.icon('appointments',14)} ${crewHtml(followUp.technicians || [])}</span></div>
        <p class="rq-note rq-reschedule-note">${OF.escape(followUp.note || followUp.title || 'Customer requested a schedule change.')}</p>
        <div class="row wrap rq-actions">${appointmentLink}<button type="button" class="btn btn-primary btn-sm" data-fu-done="${followUp.id}">${OF.icon('check',15)} Done</button></div>
      </article>`;
    }

    async function load(root, state) {
      const [appointmentsData, followUpData, technicianData] = await Promise.all([
        loadAppointments(),
        OF.get('/api/admin/follow-ups?status=pending&includeAssignments=1').catch(() => ({ followUps: [] })),
        OF.get('/api/admin/technicians?all=1').catch(() => ({ technicians: [] })),
      ]);
      const appointments = appointmentsData.appointments || [];
      const reschedules = (followUpData.followUps || []).filter((followUp) => followUp.created_by === 'public_reschedule' || /^Reschedule request/i.test(followUp.title || ''));
      const technicians = technicianData.technicians || [];
      const items = requestItems(appointments, reschedules);
      const statusCounts = {
        all: items.length,
        proposed: items.filter((item) => item.status === 'proposed').length,
        needs_time: items.filter((item) => item.status === 'needs_time').length,
        reschedule: items.filter((item) => item.status === 'reschedule').length,
      };
      const picks = {};
      const manual = {};
      const techOptions = technicians.map((tech) => `<option value="${tech.id}">${OF.escape(tech.name)}${tech.is_active === false ? ' (inactive)' : ''}</option>`).join('');

      root.innerHTML = `<style>
        .requests-view{display:flex;flex-direction:column;gap:16px}.rq-filter-panel{padding:16px 18px}.rq-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:16px}.rq-overview button{display:flex;align-items:baseline;gap:7px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);color:var(--muted);font:inherit;cursor:pointer;text-align:left}.rq-overview button:hover{border-color:#cbd5e1;background:var(--surface)}.rq-overview button.active{border-color:color-mix(in srgb,var(--brand) 35%,var(--line));background:var(--brand-tint);color:var(--brand-700)}.rq-overview strong{font-size:18px;color:var(--ink);line-height:1}.rq-overview span{font-size:12px;font-weight:600}.rq-filter-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.rq-filter-head h3{font-size:15px}.rq-filter-grid{display:grid;grid-template-columns:minmax(240px,2fr) repeat(4,minmax(130px,1fr));gap:10px;align-items:end}.rq-control{display:flex;flex-direction:column;gap:5px;min-width:0}.rq-control>label{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}.rq-search-box{position:relative}.rq-search-box svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}.rq-search-box input{padding-left:38px}.rq-filter-grid input,.rq-filter-grid select{height:42px;padding-top:9px;padding-bottom:9px}.rq-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;color:var(--muted);font-size:12px}.rq-summary strong{color:var(--ink)}.rq-summary .rq-limit-note{color:var(--warn)}.rq-results{display:flex;flex-direction:column;gap:12px}.rq-card{padding:18px 20px}.rq-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:8px}.rq-title-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.rq-customer{font-size:16px}.rq-details{display:flex;align-items:center;gap:9px 18px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:12px}.rq-details>span{display:inline-flex;align-items:center;gap:6px}.rq-details svg{flex:none}.rq-crew{display:inline-flex!important;flex-wrap:wrap}.rq-unassigned{color:var(--muted);font-style:italic}.rq-note{background:var(--surface-2);padding:9px 12px;border-radius:9px;margin:0 0 13px;font-size:13px;white-space:pre-wrap}.rq-section-label{margin:0 0 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:700}.rq-slots{gap:8px}.rq-manual-grid{display:grid;grid-template-columns:repeat(2,minmax(0,220px));gap:10px}.rq-manual-grid label{display:flex;flex-direction:column;gap:5px;color:var(--ink-2);font-size:12px;font-weight:600}.rq-actions{margin-top:14px;gap:8px}.rq-reschedule-card{border-left:3px solid var(--warn)}.rq-reschedule-note{margin-bottom:0}.rq-empty{padding:44px 22px}.rq-empty h3{font-size:16px;margin:8px 0 4px}.rq-empty p{margin:0 0 14px}.rq-empty .ic{margin:auto}.rq-limit-note.hidden{display:none!important}
        @media(max-width:1100px){.rq-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.rq-search-control{grid-column:1/-1}}
        @media(max-width:650px){.rq-overview{grid-template-columns:repeat(2,minmax(0,1fr))}.rq-filter-grid{grid-template-columns:1fr}.rq-search-control{grid-column:auto}.rq-card-head{flex-direction:column;gap:4px}.rq-manual-grid{grid-template-columns:1fr}.rq-card{padding:16px}.rq-actions .btn{flex:1}.rq-filter-head{align-items:flex-start}}
      </style>
      <div class="requests-view">
        <section class="card rq-filter-panel" aria-label="Request filters">
          <div class="rq-overview">
            <button type="button" data-status-jump="all" aria-pressed="${state.status === 'all' ? 'true' : 'false'}"><strong>${statusCounts.all}</strong><span>Pending</span></button>
            <button type="button" data-status-jump="proposed" aria-pressed="${state.status === 'proposed' ? 'true' : 'false'}"><strong>${statusCounts.proposed}</strong><span>Ready to confirm</span></button>
            <button type="button" data-status-jump="needs_time" aria-pressed="${state.status === 'needs_time' ? 'true' : 'false'}"><strong>${statusCounts.needs_time}</strong><span>Need a time</span></button>
            <button type="button" data-status-jump="reschedule" aria-pressed="${state.status === 'reschedule' ? 'true' : 'false'}"><strong>${statusCounts.reschedule}</strong><span>Reschedules</span></button>
          </div>
          <div class="rq-filter-head"><h3>Filter requests</h3><button type="button" class="btn btn-ghost btn-xs hidden" id="rqClear">Clear filters</button></div>
          <div class="rq-filter-grid">
            <div class="rq-control rq-search-control"><label for="rqSearch">Search</label><div class="rq-search-box">${OF.icon('search',17)}<input id="rqSearch" type="text" autocomplete="off" placeholder="Customer, address, service, phone or email" value="${OF.escape(state.q)}"></div></div>
            <div class="rq-control"><label for="rqStatus">Status</label><select id="rqStatus">
              <option value="all">All pending (${statusCounts.all})</option><option value="proposed">Ready to confirm (${statusCounts.proposed})</option>
              <option value="needs_time">Needs a time (${statusCounts.needs_time})</option><option value="reschedule">Reschedules (${statusCounts.reschedule})</option>
            </select></div>
            <div class="rq-control"><label for="rqDate">Submitted on</label><input id="rqDate" type="date" value="${OF.escape(state.date)}"></div>
            <div class="rq-control"><label for="rqRep">Assigned rep</label><select id="rqRep"><option value="all">Any rep</option><option value="unassigned">Unassigned requests</option>${techOptions}</select></div>
            <div class="rq-control"><label for="rqSort">Sort by</label><select id="rqSort"><option value="newest">Newest request</option><option value="oldest">Oldest request</option><option value="appointment">Next proposed time</option><option value="customer">Customer A–Z</option><option value="address">Address A–Z</option></select></div>
          </div>
          <div class="rq-summary"><span id="rqCount"></span><span class="rq-limit-note ${appointmentsData.total > appointments.length ? '' : 'hidden'}">Only the first ${appointments.length} booking requests are loaded; narrow the queue as requests are handled.</span></div>
        </section>
        <div class="rq-results" id="rqResults"></div>
      </div>`;

      const controls = {
        q: root.querySelector('#rqSearch'), status: root.querySelector('#rqStatus'), date: root.querySelector('#rqDate'),
        rep: root.querySelector('#rqRep'), sort: root.querySelector('#rqSort'), clear: root.querySelector('#rqClear'),
      };
      controls.status.value = state.status;
      controls.rep.value = state.rep;
      controls.sort.value = state.sort;

      function resetFilters() {
        Object.assign(state, { q: '', status: 'all', date: '', rep: 'all', sort: 'newest' });
        controls.q.value = ''; controls.status.value = 'all'; controls.date.value = ''; controls.rep.value = 'all'; controls.sort.value = 'newest';
        renderResults();
      }

      function bindRequestActions() {
        const results = root.querySelector('#rqResults');
        results.querySelectorAll('.slotpick').forEach((button) => button.addEventListener('click', () => {
          const id = button.dataset.id;
          results.querySelectorAll(`.slotpick[data-id="${id}"]`).forEach((other) => { other.classList.remove('active'); other.setAttribute('aria-pressed','false'); });
          button.classList.add('active'); button.setAttribute('aria-pressed','true'); picks[id] = Number(button.dataset.i);
          const confirm = results.querySelector(`.confirmBtn[data-id="${id}"]`); if (confirm) confirm.disabled = false;
        }));
        results.querySelectorAll('.manual_date,.manual_time').forEach((input) => input.addEventListener('change', () => {
          const id = input.dataset.id;
          manual[id] = manual[id] || { date: '', time: '' };
          if (input.classList.contains('manual_date')) manual[id].date = input.value; else manual[id].time = input.value;
          const confirm = results.querySelector(`.confirmBtn[data-id="${id}"]`);
          if (confirm) confirm.disabled = !(manual[id].date && manual[id].time);
        }));
        results.querySelectorAll('.confirmBtn').forEach((button) => button.addEventListener('click', async () => {
          const id = button.dataset.id;
          const appointment = appointments.find((row) => String(row.id) === id);
          if (!appointment) return;
          const chosen = picks[id]; const manualValue = manual[id] || {};
          if (chosen == null && !(manualValue.date && manualValue.time)) return;
          const original = button.innerHTML;
          button.disabled = true; button.textContent = 'Confirming…';
          const send = (force) => OF.post(`/api/admin/appointments/${id}/confirm`, chosen != null
            ? { slotIndex: chosen, notify: true, force }
            : { date: manualValue.date, time: manualValue.time, notify: true, force });
          try {
            await send(false); OF.toast('Confirmed & customer notified', 'ok'); await load(root, state); return;
          } catch (error) {
            const warning = error.code === 'SCHEDULE_WARN' || error.code === 'SLOT_FULL';
            if (warning && await OF.confirm({ title: 'Heads up', body: `<p class="muted">${OF.escape(error.message)}</p>`, confirmText: 'Confirm anyway' })) {
              try { await send(true); OF.toast('Confirmed & customer notified', 'ok'); await load(root, state); return; }
              catch (forcedError) { OF.toast(forcedError.message, 'error'); }
            } else if (!warning) OF.toast(error.message, 'error');
          }
          button.disabled = false; button.innerHTML = original;
        }));
        results.querySelectorAll('.declineBtn').forEach((button) => button.addEventListener('click', async () => {
          const id = button.dataset.id;
          if (!(await OF.confirm({ title: 'Decline request?', body: '<p class="muted">This cancels the request. The customer can be notified.</p>', confirmText: 'Decline', danger: true }))) return;
          button.disabled = true;
          try { await OF.patch(`/api/admin/appointments/${id}`, { status: 'canceled', notify: true }); OF.toast('Request declined', 'ok'); await load(root, state); }
          catch (error) { OF.toast(error.message, 'error'); button.disabled = false; }
        }));
        results.querySelectorAll('[data-fu-done]').forEach((button) => button.addEventListener('click', async () => {
          button.disabled = true;
          try { await OF.patch(`/api/admin/follow-ups/${button.dataset.fuDone}`, { status: 'done' }); OF.toast('Request completed', 'ok'); await load(root, state); }
          catch (error) { OF.toast(error.message, 'error'); button.disabled = false; }
        }));
        results.querySelector('[data-clear-results]')?.addEventListener('click', resetFilters);
      }

      function renderResults() {
        const visible = filteredItems(items, state);
        const results = root.querySelector('#rqResults');
        const count = root.querySelector('#rqCount');
        count.innerHTML = `<strong>${visible.length}</strong> of <strong>${items.length}</strong> pending request${items.length === 1 ? '' : 's'}`;
        controls.clear.classList.toggle('hidden', !isFiltered(state));
        root.querySelectorAll('[data-status-jump]').forEach((button) => {
          const active = button.dataset.statusJump === state.status;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        if (visible.length) results.innerHTML = visible.map((item) => item.type === 'booking' ? bookingCard(item.data, picks, manual) : rescheduleCard(item.data)).join('');
        else if (items.length && isFiltered(state)) results.innerHTML = `<div class="card empty rq-empty"><div class="ic">${OF.icon('search',22)}</div><h3>No matching requests</h3><p>Try another search or clear the filters to see the full queue.</p><button type="button" class="btn btn-secondary btn-sm" data-clear-results>Clear filters</button></div>`;
        else results.innerHTML = `<div class="card empty rq-empty"><div class="ic">${OF.icon('check',22)}</div><h3>All caught up</h3><p>No pending appointment requests need attention.</p></div>`;
        bindRequestActions();
      }

      controls.q.addEventListener('input', OF.debounce(() => {
        if (!controls.q.isConnected) return;
        state.q = controls.q.value;
        renderResults();
      }, 180));
      controls.status.addEventListener('change', () => { state.status = controls.status.value; renderResults(); });
      controls.date.addEventListener('change', () => { state.date = controls.date.value; renderResults(); });
      controls.rep.addEventListener('change', () => { state.rep = controls.rep.value; renderResults(); });
      controls.sort.addEventListener('change', () => { state.sort = controls.sort.value; renderResults(); });
      controls.clear.addEventListener('click', resetFilters);
      root.querySelectorAll('[data-status-jump]').forEach((button) => button.addEventListener('click', () => {
        state.status = button.dataset.statusJump; controls.status.value = state.status; renderResults();
      }));
      renderResults();
    }

    OF.page({ active: 'requests', title: 'Requests', subtitle: 'Booking requests awaiting your confirmation',
      render: async (root) => { await load(root, { q: '', status: 'all', date: '', rep: 'all', sort: 'newest' }); } });
