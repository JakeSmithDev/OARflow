// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    function stat(label, value, icon, sub) {
      return `<div class="stat"><div class="row between"><span class="label">${label}</span><span class="ic">${OF.icon(icon,16)}</span></div>
        <div class="value">${value}</div>${sub ? `<div class="small muted" style="margin-top:4px">${sub}</div>` : ''}</div>`;
    }
    function apptRow(a) {
      const addr = a.service_address ? `<div class="tiny muted">${OF.icon('pin',12)} ${OF.escape(a.service_address)}</div>` : '';
      const color = OF.color(a.service_color);
      return `<tr class="clickable" onclick="OF.go('/admin/appointments?id=${a.id}')">
        <td class="nowrap"><span class="cell-strong">${OF.time(a.scheduled_start)}</span></td>
        <td><div class="cell-strong">${OF.escape(a.customer_name)}</div>${addr}</td>
        <td>${a.service_name ? `<span class="badge no-dot" style="background:${color}1a;color:${color}">${OF.escape(a.service_name)}</span>` : '—'}</td>
        <td class="right">${OF.statusBadge(a.status)}</td></tr>`;
    }

    OF.page({
      active: 'dashboard', title: 'Dashboard',
      subtitle: new Intl.DateTimeFormat('en-US', { timeZone: OF.tenant.timezone, weekday:'long', month:'long', day:'numeric' }).format(new Date()),
      render: async (root, ctx) => {
        ctx.setActions(`<a class="btn btn-secondary btn-sm" href="/book" target="_blank">${OF.icon('cal',15)} View booking page</a>
          <a class="btn btn-primary btn-sm" href="/admin/appointments?new=1">${OF.icon('plus',15)} New appointment</a>`);
        const d = await OF.get('/api/admin/dashboard');
        const m = d.metrics;

        const tiles = `<div class="grid cols-4" style="margin-bottom:20px">
          ${stat('Revenue (MTD)', OF.money(m.revenueMtdCents), 'money')}
          ${stat('Outstanding', OF.money(m.outstandingCents), 'invoices', `${d.outstanding.length} open invoice(s)`)}
          ${stat('Recurring / mo', OF.money(m.mrrCents), 'recurring', `${OF.money(m.arrCents)} ARR · ${m.activeSubs} active`)}
          ${stat("Today's jobs", m.todayCount, 'schedule', `${d.upcoming.length} more this week`)}
        </div>`;

        const todayCard = `<div class="card">
          <div class="card-head"><h3>Today's schedule</h3><div class="actions"><a class="link-btn" href="/admin/schedule">Open schedule →</a></div></div>
          ${d.today.length ? `<div class="table-wrap"><table class="tbl"><tbody>${d.today.map(apptRow).join('')}</tbody></table></div>`
            : `<div class="empty"><div class="ic">${OF.icon('schedule',22)}</div><p>No appointments scheduled today.</p></div>`}
        </div>`;

        const upcomingCard = d.upcoming.length ? `<div class="card">
          <div class="card-head"><h3>Upcoming this week</h3></div>
          <div class="table-wrap"><table class="tbl"><tbody>${d.upcoming.map((a)=>`
            <tr class="clickable" onclick="OF.go('/admin/appointments?id=${a.id}')">
              <td class="nowrap"><span class="cell-strong">${OF.date(a.scheduled_start)}</span><div class="tiny muted">${OF.time(a.scheduled_start)}</div></td>
              <td><div class="cell-strong">${OF.escape(a.customer_name)}</div></td>
              <td>${a.service_name?OF.escape(a.service_name):'—'}</td>
              <td class="right">${OF.money(a.price_cents)}</td></tr>`).join('')}</tbody></table></div></div>` : '';

        const requestsCard = `<div class="card">
          <div class="card-head"><h3>Pending requests</h3>${d.requests.length?`<span class="badge warn no-dot">${d.requests.length}</span>`:''}<div class="actions"><a class="link-btn" href="/admin/requests">View all →</a></div></div>
          ${d.requests.length ? d.requests.map((a)=>`
            <div class="card-pad" style="border-bottom:1px solid var(--line-2);cursor:pointer" onclick="OF.go('/admin/requests?id=${a.id}')">
              <div class="row between"><span class="cell-strong">${OF.escape(a.customer_name)}</span>${OF.statusBadge('requested')}</div>
              <div class="small muted" style="margin-top:3px">${a.service_name?OF.escape(a.service_name):''} · ${(a.requested_slots||[]).length} proposed time(s)</div>
            </div>`).join('') : `<div class="empty"><div class="ic">${OF.icon('check',22)}</div><p>No pending requests.</p></div>`}
        </div>`;

        const outstandingCard = `<div class="card">
          <div class="card-head"><h3>Outstanding balances</h3><div class="actions"><a class="link-btn" href="/admin/invoices">All invoices →</a></div></div>
          ${d.outstanding.length ? `<div class="table-wrap"><table class="tbl"><tbody>${d.outstanding.map((i)=>`
            <tr class="clickable" onclick="OF.go('/admin/invoices?id=${i.id}')">
              <td><span class="cell-strong">${OF.escape(i.customer_name)}</span><div class="tiny muted">${OF.escape(i.number)}</div></td>
              <td class="right"><span class="cell-strong">${OF.money(i.total_cents - i.amount_paid_cents)}</span><div class="tiny">${OF.statusBadge(i.status)}</div></td></tr>`).join('')}</tbody></table></div>`
            : `<div class="empty"><div class="ic">${OF.icon('money',22)}</div><p>Nothing outstanding. 🎉</p></div>`}
        </div>`;

        const followupsCard = `<div class="card">
          <div class="card-head"><h3>Follow-ups due</h3><div class="actions"><a class="link-btn" href="/admin/follow-ups">Queue →</a></div></div>
          ${d.followups.length ? d.followups.map((f)=>`
            <div class="card-pad" style="border-bottom:1px solid var(--line-2)">
              <div class="row between"><span class="cell-strong">${OF.escape(f.title)}</span><span class="tiny muted">${OF.date(f.due_at)}</span></div>
              <div class="small muted" style="margin-top:2px">${OF.escape(f.customer_name||'')} · ${f.channel==='email'?'Email':'Task'}</div>
            </div>`).join('') : `<div class="empty"><div class="ic">${OF.icon('followups',22)}</div><p>No follow-ups due.</p></div>`}
        </div>`;

        root.innerHTML = tiles + `<div class="grid" style="grid-template-columns:1.55fr 1fr;align-items:start">
          <div class="stack">${todayCard}${upcomingCard}</div>
          <div class="stack">${requestsCard}${outstandingCard}${followupsCard}</div>
        </div>`;
      },
    });
  
