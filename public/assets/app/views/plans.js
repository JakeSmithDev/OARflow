// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let DATA = null;
    const INTERVALS = [['monthly','Monthly'],['quarterly','Quarterly'],['semiannual','Every 6 months'],['annual','Annual'],['custom','Custom (months)']];
    const intervalLabel = (i,c)=>({monthly:'mo',quarterly:'quarter',semiannual:'6 mo',annual:'yr',custom:`${c} mo`}[i]||i);

    async function refresh(root) {
      DATA = await OF.get('/api/admin/plans');
      const canOwner = OF.hasCap('*');
      const m = DATA.metrics;
      root.innerHTML = `
        <div class="grid cols-3" style="margin-bottom:20px">
          <div class="stat"><div class="label">Recurring / month</div><div class="value">${OF.money(m.mrrCents)}</div></div>
          <div class="stat"><div class="label">Annual run-rate</div><div class="value">${OF.money(m.arrCents)}</div></div>
          <div class="stat"><div class="label">Active subscriptions</div><div class="value">${m.activeSubs}</div></div>
        </div>
        <div class="card-head" style="padding:0 0 12px;border:none"><h3>Plans</h3></div>
        <div class="grid cols-3" id="plans" style="margin-bottom:24px"></div>
        <div class="card"><div class="card-head"><h3>Subscriptions</h3><div class="actions"><button class="btn btn-secondary btn-sm" id="runDue">Generate due visits</button></div></div>
          <div id="subs"></div></div>`;
      document.getElementById('plans').innerHTML = DATA.plans.map(p=>`
        <div class="plan-card">
          <div class="row between"><b>${OF.escape(p.name)}</b>${p.is_active?'':'<span class="badge neutral no-dot">Archived</span>'}</div>
          <div style="margin:8px 0"><span class="price">${OF.money(p.price_cents)}</span> <span class="per">/ ${intervalLabel(p.interval,p.interval_count)}</span></div>
          <p class="small muted" style="min-height:34px">${OF.escape(p.description||'')}</p>
          <div class="tiny muted">${p.service_name?`Includes: ${OF.escape(p.service_name)} · `:''}${p.active_count} active</div>
          <div class="row" style="gap:8px;margin-top:12px">${canOwner?`<button class="btn btn-secondary btn-sm" data-edit="${p.id}">Edit</button>`:''}<button class="btn btn-ghost btn-sm" data-enroll="${p.id}">Enroll customer</button></div>
        </div>`).join('') + (canOwner ? `<button class="plan-card" id="addPlan" style="border-style:dashed;cursor:pointer;display:grid;place-items:center;color:var(--muted)">${OF.icon('plus',22)}<span style="margin-top:6px;font-weight:600">New plan</span></button>` : '');

      const subs = DATA.subscriptions;
      document.getElementById('subs').innerHTML = subs.length?`<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Customer</th><th>Plan</th><th class="right">Price</th><th>Next visit</th><th>Status</th><th></th></tr></thead>
        <tbody>${subs.map(s=>`<tr><td class="cell-strong">${OF.escape(s.customer_name)}</td><td>${OF.escape(s.plan_name||'—')}</td>
          <td class="right mono">${OF.money(s.price_cents)}/${intervalLabel(s.interval,s.interval_count)}</td>
          <td>${s.next_run_date?OF.dateLong(s.next_run_date):'—'}</td><td>${OF.statusBadge(s.status)}</td>
          <td class="right">${s.status==='active'?`<button class="link-btn" data-sub="${s.id}" data-act="paused">Pause</button> · <button class="link-btn" style="color:var(--danger)" data-sub="${s.id}" data-act="canceled">Cancel</button>`:s.status==='paused'?`<button class="link-btn" data-sub="${s.id}" data-act="active">Resume</button>`:''}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('recurring',22)}</div><p>No subscriptions yet. Enroll a customer in a plan to build recurring revenue.</p></div>`;

      document.getElementById('addPlan')?.addEventListener('click',()=>planModal());
      document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>planModal(DATA.plans.find(p=>p.id==b.dataset.edit)));
      document.querySelectorAll('[data-enroll]').forEach(b=>b.onclick=()=>enrollModal(+b.dataset.enroll));
      document.getElementById('runDue').onclick=async()=>{ const r=await OF.post('/api/admin/plans/generate-due'); OF.toast(`Generated ${r.appointments} visit(s), ${r.invoices} invoice(s)`,'ok'); refresh(root); };
      document.querySelectorAll('[data-sub]').forEach(b=>b.onclick=async()=>{
        if(b.dataset.act==='canceled' && !(await OF.confirm({title:'Cancel subscription?',body:'<p class="muted">This stops future recurring visits and billing for this plan.</p>',confirmText:'Cancel subscription',danger:true}))) return;
        await OF.patch('/api/admin/plans/subscriptions/'+b.dataset.sub,{status:b.dataset.act}); OF.toast('Updated','ok'); refresh(root);
      });
    }

    function planModal(plan) {
      const m = OF.modal(`<div class="modal-head"><h3>${plan?'Edit plan':'New plan'}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Name *</label><input id="p_name" value="${OF.escape(plan?.name||'')}"></div>
          <div class="field"><label>Description</label><textarea id="p_desc">${OF.escape(plan?.description||'')}</textarea></div>
          <div class="grid cols-2">
            <div class="field"><label>Billing interval</label><select id="p_int">${INTERVALS.map(([v,l])=>`<option value="${v}" ${plan?.interval===v?'selected':''}>${l}</option>`).join('')}</select></div>
            <div class="field"><label>Price</label><div class="input-prefix"><span>$</span><input id="p_price" value="${plan?((plan.price_cents)/100).toFixed(2):''}"></div></div>
          </div>
          <div class="grid cols-2">
            <div class="field" id="p_countWrap" style="${plan?.interval==='custom'?'':'display:none'}"><label>Every N months</label><input id="p_count" type="number" min="1" value="${plan?.interval_count||1}"></div>
            <div class="field"><label>Service performed</label><select id="p_svc"><option value="">—</option>${DATA.services.map(s=>`<option value="${s.id}" ${plan?.service_type_id==s.id?'selected':''}>${OF.escape(s.name)}</option>`).join('')}</select></div>
          </div>
          <label class="row" style="gap:8px;margin-bottom:8px"><input type="checkbox" id="p_sched" ${plan?(plan.auto_schedule?'checked':''):'checked'} style="width:auto"> Auto-create the appointment each cycle</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="p_inv" ${plan?(plan.auto_invoice?'checked':''):'checked'} style="width:auto"> Auto-create a draft invoice each cycle</label>
        </div>
        <div class="modal-foot">${plan?`<button class="btn btn-danger-soft" id="p_archive">${plan.is_active?'Archive':'Unarchive'}</button>`:''}<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="p_save">Save</button></div>`);
      m.q('#p_int').onchange=e=>{ m.q('#p_countWrap').style.display=e.target.value==='custom'?'':'none'; };
      m.q('#p_save').onclick=async()=>{
        const payload={name:m.q('#p_name').value.trim(),description:m.q('#p_desc').value.trim(),interval:m.q('#p_int').value,intervalCount:+m.q('#p_count').value||1,priceCents:Math.round((parseFloat(m.q('#p_price').value)||0)*100),serviceTypeId:m.q('#p_svc').value||null,autoSchedule:m.q('#p_sched').checked,autoInvoice:m.q('#p_inv').checked};
        if(!payload.name) return OF.toast('Name required','error');
        if(plan) await OF.patch('/api/admin/plans/'+plan.id,payload); else await OF.post('/api/admin/plans',payload);
        m.close(); OF.toast('Saved','ok'); refresh(document.getElementById('content'));
      };
      m.q('#p_archive')?.addEventListener('click',async()=>{ await OF.patch('/api/admin/plans/'+plan.id,{isActive:!plan.is_active}); m.close(); OF.toast('Updated','ok'); refresh(document.getElementById('content')); });
    }

    async function enrollModal(planId, customerId, customerName) {
      const m = OF.modal(`<div class="modal-head"><h3>Enroll in plan</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Customer *</label><input id="e_cust" placeholder="Search customer…" value="${OF.escape(customerName||'')}" autocomplete="off"><div id="e_res" class="card" style="display:none"></div></div>
          <div class="field"><label>Plan *</label><select id="e_plan">${DATA.plans.filter(p=>p.is_active).map(p=>`<option value="${p.id}" ${p.id==planId?'selected':''}>${OF.escape(p.name)} · ${OF.money(p.price_cents)}</option>`).join('')}</select></div>
          <div class="field"><label>Start date</label><input id="e_start" type="date"></div>
          ${DATA.stripeEnabled?`<label class="row" style="gap:8px"><input type="checkbox" id="e_stripe" style="width:auto"> Collect payment via Stripe (auto-bill)</label>`:''}
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="e_save">Enroll</button></div>`);
      let cust = { id: customerId || null };
      const ci=m.q('#e_cust'), cr=m.q('#e_res');
      ci.addEventListener('input', OF.debounce(async()=>{ const q=ci.value.trim(); if(q.length<2){cr.style.display='none';return;} const d=await OF.get('/api/admin/customers?q='+encodeURIComponent(q)); cr.innerHTML=d.customers.slice(0,6).map(c=>`<div class="card-pad" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line-2)" data-id="${c.id}" data-name="${OF.escape(c.name)}">${OF.escape(c.name)}</div>`).join(''); cr.style.display='block'; cr.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{cust={id:+x.dataset.id};ci.value=x.dataset.name;cr.style.display='none';}); },250));
      m.q('#e_save').onclick=async()=>{
        if(!cust.id) return OF.toast('Select a customer','error');
        const useStripe=m.q('#e_stripe')?.checked;
        const r=await OF.post('/api/admin/plans/subscriptions',{customerId:cust.id,planId:+m.q('#e_plan').value,startDate:m.q('#e_start').value||null,useStripe});
        if(r.checkoutUrl){ window.open(r.checkoutUrl,'_blank'); OF.toast('Stripe checkout opened','ok'); }
        else OF.toast('Customer enrolled','ok');
        m.close(); refresh(document.getElementById('content'));
      };
    }

    OF.page({ active:'recurring', title:'Recurring revenue', subtitle:'Plans & subscriptions', render: async (root) => {
      await refresh(root);
      const enroll=OF.qs('enroll');
      if(enroll){ try{ const c=await OF.get('/api/admin/customers/'+enroll); enrollModal(null,+enroll,c.customer.name); }catch{} }
    }});
  
