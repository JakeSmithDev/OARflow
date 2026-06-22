// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let META = { presets: [], defaults: {}, stripeEnabled: false };
    const state = { status: 'all', q: '' };
    const centsToStr = (c) => ((c||0)/100).toFixed(2);
    const strToCents = (s) => Math.round((parseFloat(String(s).replace(/[^0-9.\-]/g,''))||0)*100);

    async function refresh() {
      const p = new URLSearchParams({ status: state.status }); if (state.q) p.set('q', state.q);
      const d = await OF.get('/api/admin/invoices?'+p);
      const s = d.summary;
      document.getElementById('tiles').innerHTML = `<div class="grid cols-3" style="margin-bottom:18px">
        <div class="stat"><div class="label">Outstanding</div><div class="value">${OF.money(s.outstanding)}</div></div>
        <div class="stat"><div class="label">Collected (all time)</div><div class="value">${OF.money(s.collected)}</div></div>
        <div class="stat"><div class="label">Draft (unsent)</div><div class="value">${OF.money(s.draft)}</div></div></div>`;
      document.getElementById('chips').innerHTML = ['all','draft','sent','partial','paid','void']
        .map(k=>`<button class="chip ${state.status===k?'active':''}" data-s="${k}">${k[0].toUpperCase()+k.slice(1)}</button>`).join('');
      document.querySelectorAll('#chips .chip').forEach(b=>b.onclick=()=>{state.status=b.dataset.s;refresh();});
      const rows = d.invoices;
      document.getElementById('list').innerHTML = rows.length?`<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th class="right">Total</th><th class="right">Balance</th><th></th></tr></thead>
        <tbody>${rows.map(i=>`<tr class="clickable" data-id="${i.id}"><td class="cell-strong">${OF.escape(i.number)}<div class="tiny muted">${OF.date(i.created_at)}</div></td>
          <td>${OF.escape(i.customer_name)}</td><td>${OF.statusBadge(i.status)}</td>
          <td class="right mono">${OF.money(i.total_cents)}</td>
          <td class="right mono">${OF.money(i.total_cents-i.amount_paid_cents)}</td><td></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('invoices',22)}</div><p>No invoices yet.</p></div>`;
      document.querySelectorAll('#list tr[data-id]').forEach(r=>r.onclick=()=>openDrawer(r.dataset.id));
    }

    async function openDrawer(id) {
      const d = await OF.get('/api/admin/invoices/'+id);
      const i = d.invoice;
      const editable = i.status==='draft' || i.status==='sent' || i.status==='partial';
      const liHtml = (i.line_items||[]).map(li=>`<div class="row between" style="padding:5px 0"><span>${OF.escape(li.label)}${li.quantity>1?` ×${li.quantity}`:''}</span><span class="mono">${OF.money(li.amount_cents)}</span></div>`).join('');
      const evHtml = (d.events||[]).map(e=>`<div class="row between" style="padding:5px 0;border-top:1px solid var(--line-2)"><span class="small">${OF.escape(e.event_type)} · ${OF.escape(e.method||'')} ${e.note?`· ${OF.escape(e.note)}`:''}<div class="tiny muted">${OF.dateTime(e.created_at)}</div></span><span class="mono">${OF.money(e.amount_cents)}</span></div>`).join('') || '<p class="muted small">No payments recorded.</p>';
      const dr = OF.drawer(`
        <div class="modal-head"><h3>${OF.escape(i.number)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="row between" style="margin-bottom:12px">${OF.statusBadge(i.status)}<span class="muted">${OF.escape(i.customer_name)}</span></div>
          <div class="card card-pad" style="margin-bottom:14px">
            ${liHtml}
            <hr class="divider">
            <div class="totline"><span class="muted">Subtotal</span><span class="mono">${OF.money(i.subtotal_cents)}</span></div>
            ${i.discount_cents?`<div class="totline"><span class="muted">Discount</span><span class="mono">−${OF.money(i.discount_cents)}</span></div>`:''}
            ${i.tax_cents?`<div class="totline"><span class="muted">Tax (${i.tax_rate_percent}%)</span><span class="mono">${OF.money(i.tax_cents)}</span></div>`:''}
            <div class="totline"><span>Total</span><span class="mono">${OF.money(i.total_cents)}</span></div>
            ${i.amount_paid_cents?`<div class="totline"><span class="muted">Paid</span><span class="mono">−${OF.money(i.amount_paid_cents)}</span></div>`:''}
            <div class="totline grand"><span>Balance due</span><span class="mono">${OF.money(d.balanceCents)}</span></div>
          </div>
          <div class="row wrap" style="gap:8px;margin-bottom:14px">
            ${i.status!=='void'&&i.status!=='paid'?`<button class="btn btn-primary btn-sm" id="sendBtn">${OF.icon('send',15)} ${i.sent_at?'Resend':'Send'} invoice</button>`:''}
            ${d.balanceCents>0&&i.status!=='void'?`<button class="btn btn-secondary btn-sm" id="payBtn">${OF.icon('money',15)} Record payment</button>`:''}
            ${editable?`<button class="btn btn-ghost btn-sm" id="editBtn">Edit</button>`:''}
            <button class="btn btn-ghost btn-sm" id="copyBtn">Copy pay link</button>
            ${i.status!=='paid'&&i.status!=='void'?`<button class="btn btn-danger-soft btn-sm" id="voidBtn">Void</button>`:''}
          </div>
          <div id="payForm" class="hidden card card-pad" style="margin-bottom:12px">
            <div class="grid cols-2"><div class="field"><label>Amount</label><div class="input-prefix"><span>$</span><input id="p_amt" value="${centsToStr(d.balanceCents)}"></div></div>
            <div class="field"><label>Method</label><select id="p_method"><option value="cash">Cash</option><option value="check">Check</option><option value="card">Card (in person)</option><option value="other">Other</option></select></div></div>
            <label class="row" style="gap:8px;margin-bottom:10px"><input type="checkbox" id="p_receipt" style="width:auto"> Email receipt</label>
            <button class="btn btn-primary btn-sm" id="p_save">Record payment</button>
          </div>
          ${d.payUrl?`<div class="small muted" style="word-break:break-all;margin-bottom:8px">Pay link: ${OF.escape(d.payUrl)}</div>`:''}
          ${!d.stripeEnabled?`<p class="tiny muted">Connect Stripe in Settings → Integrations to accept online card payments.</p>`:''}
          <div style="margin-top:8px"><div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:6px">Payments</div>${evHtml}</div>
        </div>`, { wide:true });

      const reload = () => { dr.close(); refresh(); };
      dr.q('#sendBtn')?.addEventListener('click', async()=>{ try{ const r=await OF.post(`/api/admin/invoices/${id}/send`); OF.toast(r.emailed?'Invoice sent ✓':'Marked sent (email not configured)','ok'); reload(); }catch(e){OF.toast(e.message,'error');}});
      dr.q('#payBtn')?.addEventListener('click', ()=>dr.q('#payForm').classList.toggle('hidden'));
      dr.q('#p_save')?.addEventListener('click', async()=>{ await OF.post(`/api/admin/invoices/${id}/payment`,{amountCents:strToCents(dr.q('#p_amt').value),method:dr.q('#p_method').value,sendReceipt:dr.q('#p_receipt').checked}); OF.toast('Payment recorded','ok'); reload(); });
      dr.q('#editBtn')?.addEventListener('click', ()=>{ dr.close(); builder({ editId:id, invoice:i }); });
      dr.q('#voidBtn')?.addEventListener('click', async()=>{ if(!(await OF.confirm({title:'Void invoice?',confirmText:'Void',danger:true}))) return; await OF.post(`/api/admin/invoices/${id}/void`); OF.toast('Voided','ok'); reload(); });
      dr.q('#copyBtn')?.addEventListener('click', ()=>{ navigator.clipboard?.writeText(d.payUrl); OF.toast('Pay link copied','ok'); });
    }

    async function builder({ editId, invoice, customerId, customerName, appointmentId } = {}) {
      const items = invoice ? invoice.line_items.map(li=>({...li})) : [];
      let cust = { id: customerId || invoice?.customer_id || null, name: customerName || invoice?.customer_name || '' };
      let taxRate = invoice ? invoice.tax_rate_percent : META.defaults.taxRatePercent;
      let discount = invoice ? invoice.discount_cents : 0;
      const m = OF.modal(`
        <div class="modal-head"><h3>${editId?'Edit invoice':'New invoice'}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="max-height:72vh;overflow:auto">
          <div class="field"><label>Customer *</label><input id="b_cust" placeholder="Search customer…" value="${OF.escape(cust.name)}" autocomplete="off"><div id="b_results" class="card" style="display:none;position:relative;z-index:5"></div></div>
          <div class="muted tiny" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:6px 0">Line items</div>
          <div id="b_lines"></div>
          <div class="row wrap" style="gap:6px;margin:10px 0">
            <button class="preset-pill" id="b_addcustom">+ Custom line</button>
            ${META.presets.map(p=>`<button class="preset-pill" data-preset="${p.id}">+ ${OF.escape(p.label)}</button>`).join('')}
          </div>
          <div class="grid cols-2">
            <div class="field"><label>Tax rate (%)</label><input id="b_tax" type="number" step="0.01" value="${taxRate}"></div>
            <div class="field"><label>Discount ($)</label><div class="input-prefix"><span>$</span><input id="b_disc" value="${centsToStr(discount)}"></div></div>
          </div>
          <div class="field"><label>Due date</label><input id="b_due" type="date" value="${invoice?.due_date?String(invoice.due_date).slice(0,10):''}"></div>
          <div class="field"><label>Note to customer</label><textarea id="b_notes">${OF.escape(invoice?.notes||META.defaults.footerNote||'')}</textarea></div>
          <div class="card card-pad" id="b_totals" style="background:var(--surface-2)"></div>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button>
          ${editId?'':'<button class="btn btn-secondary" id="b_savesend">Save &amp; send</button>'}
          <button class="btn btn-primary" id="b_save">${editId?'Save changes':'Save draft'}</button></div>`, { wide:true });

      function renderLines() {
        m.q('#b_lines').innerHTML = items.map((li,idx)=>`<div class="li-row" data-i="${idx}">
          <input class="l_label" value="${OF.escape(li.label||'')}" placeholder="Description">
          <input class="l_qty" type="number" min="1" value="${li.quantity||1}" title="Qty">
          <div class="input-prefix"><span>$</span><input class="l_amt" value="${centsToStr(li.unit_amount_cents)}" title="Unit price"></div>
          <label class="tx" title="Taxable"><input type="checkbox" class="l_tax" ${li.taxable!==false?'checked':''}></label>
          <button class="link-btn l_del" style="color:var(--danger)">✕</button></div>`).join('') || '<p class="muted small">No line items yet — add from a preset or a custom line.</p>';
        m.el.querySelectorAll('.li-row').forEach(row=>{
          const i = +row.dataset.i;
          row.querySelector('.l_label').oninput = e=>{ items[i].label=e.target.value; };
          row.querySelector('.l_qty').oninput = e=>{ items[i].quantity=+e.target.value||1; renderTotals(); };
          row.querySelector('.l_amt').oninput = e=>{ items[i].unit_amount_cents=strToCents(e.target.value); renderTotals(); };
          row.querySelector('.l_tax').onchange = e=>{ items[i].taxable=e.target.checked; renderTotals(); };
          row.querySelector('.l_del').onclick = ()=>{ items.splice(i,1); renderLines(); renderTotals(); };
        });
      }
      function renderTotals() {
        taxRate = parseFloat(m.q('#b_tax').value)||0; discount = strToCents(m.q('#b_disc').value);
        const sub = items.reduce((s,li)=>s+Math.round((li.quantity||1)*(li.unit_amount_cents||0)),0);
        const taxable = items.filter(li=>li.taxable!==false).reduce((s,li)=>s+Math.round((li.quantity||1)*(li.unit_amount_cents||0)),0);
        const tax = Math.round(Math.max(0,taxable-discount)*taxRate/100);
        const total = Math.max(0, sub-discount+tax);
        m.q('#b_totals').innerHTML = `<div class="totline"><span class="muted">Subtotal</span><span class="mono">${OF.money(sub)}</span></div>
          ${discount?`<div class="totline"><span class="muted">Discount</span><span class="mono">−${OF.money(discount)}</span></div>`:''}
          ${tax?`<div class="totline"><span class="muted">Tax</span><span class="mono">${OF.money(tax)}</span></div>`:''}
          <div class="totline grand"><span>Total</span><span class="mono">${OF.money(total)}</span></div>`;
      }
      renderLines(); renderTotals();
      m.q('#b_tax').oninput = renderTotals; m.q('#b_disc').oninput = renderTotals;
      m.q('#b_addcustom').onclick = ()=>{ items.push({label:'',quantity:1,unit_amount_cents:0,taxable:true}); renderLines(); };
      m.el.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{ const p=META.presets.find(x=>x.id==b.dataset.preset); items.push({label:p.label,description:p.description,quantity:1,unit_amount_cents:p.default_amount_cents,taxable:p.taxable}); renderLines(); renderTotals(); });

      // customer search
      const ci = m.q('#b_cust'); const cr = m.q('#b_results');
      ci.addEventListener('input', OF.debounce(async()=>{ const q=ci.value.trim(); if(q.length<2){cr.style.display='none';return;} const d=await OF.get('/api/admin/customers?q='+encodeURIComponent(q)); cr.innerHTML=d.customers.slice(0,6).map(c=>`<div class="card-pad" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line-2)" data-id="${c.id}" data-name="${OF.escape(c.name)}">${OF.escape(c.name)} <span class="tiny muted">${OF.escape(c.email||'')}</span></div>`).join('')||'<div class="card-pad small muted">No matches</div>'; cr.style.display='block'; cr.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{ cust={id:+x.dataset.id,name:x.dataset.name}; ci.value=cust.name; cr.style.display='none'; }); },250));

      async function save(send) {
        if (!cust.id) return OF.toast('Select a customer','error');
        if (!items.length) return OF.toast('Add at least one line item','error');
        const payload = { customerId:cust.id, appointmentId, lineItems:items, taxRatePercent:parseFloat(m.q('#b_tax').value)||0, discountCents:strToCents(m.q('#b_disc').value), notes:m.q('#b_notes').value, dueDate:m.q('#b_due').value||null };
        try {
          let inv;
          if (editId) { inv=(await OF.patch('/api/admin/invoices/'+editId,payload)).invoice; }
          else { inv=(await OF.post('/api/admin/invoices',payload)).invoice; }
          if (send) { await OF.post(`/api/admin/invoices/${inv.id}/send`); OF.toast('Invoice saved & sent','ok'); }
          else OF.toast('Invoice saved','ok');
          m.close(); refresh();
        } catch(e){ OF.toast(e.message,'error'); }
      }
      m.q('#b_save').onclick = ()=>save(false);
      m.q('#b_savesend')?.addEventListener('click', ()=>save(true));
    }

    OF.page({ active:'invoices', title:'Invoices', subtitle:'Customizable invoices — sent only when you choose', render: async (root, ctx) => {
      META = await OF.get('/api/admin/invoices/meta');
      ctx.setActions(`<button class="btn btn-primary btn-sm" id="newBtn">${OF.icon('plus',15)} New invoice</button>`);
      root.innerHTML = `<div id="tiles"></div><div class="row wrap" id="chips" style="gap:8px;margin-bottom:14px"></div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('newBtn').onclick=()=>builder({});
      await refresh();
      if (OF.qs('id')) openDrawer(OF.qs('id'));
      if (OF.qs('new')) {
        const cid = OF.qs('customer'); let cname='';
        if (cid) { try { cname=(await OF.get('/api/admin/customers/'+cid)).customer.name; } catch{} }
        builder({ customerId: cid?+cid:null, customerName: cname, appointmentId: OF.qs('appointment')?+OF.qs('appointment'):null });
      }
    }});
  