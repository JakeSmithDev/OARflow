// Quotes/estimates SPA view. Build an estimate, send a customer an online
// approve link (clickwrap), and convert accepted estimates to invoices.
const OF = window.OF;

    let META = { presets: [], defaults: {} };
    const state = { status: 'all', q: '', limit: OF.listLimit, rows: [], total: 0 };
    const centsToStr = (c) => ((c||0)/100).toFixed(2);
    const strToCents = (s) => Math.round((parseFloat(String(s).replace(/[^0-9.\-]/g,''))||0)*100);

    function listParams(offset = 0) {
      const p = new URLSearchParams({ status: state.status, limit: state.limit, offset }); if (state.q) p.set('q', state.q);
      return p;
    }
    async function refresh({ append = false } = {}) {
      const p = listParams(append ? state.rows.length : 0);
      const d = await OF.get('/api/admin/estimates?'+p);
      state.rows = append ? state.rows.concat(d.estimates || []) : (d.estimates || []);
      state.total = d.total || state.rows.length;
      const s = d.summary;
      document.getElementById('tiles').innerHTML = `<div class="grid cols-3" style="margin-bottom:18px">
        <div class="stat"><div class="label">Awaiting approval</div><div class="value">${OF.money(s.outstanding)}</div></div>
        <div class="stat"><div class="label">Approved</div><div class="value">${OF.money(s.accepted)}</div></div>
        <div class="stat"><div class="label">Draft</div><div class="value">${OF.money(s.draft)}</div></div></div>`;
      document.getElementById('chips').innerHTML = ['all','draft','sent','accepted','declined','converted']
        .map(k=>`<button class="chip ${state.status===k?'active':''}" data-s="${k}">${k[0].toUpperCase()+k.slice(1)}</button>`).join('');
      document.querySelectorAll('#chips .chip').forEach(b=>b.onclick=()=>{state.status=b.dataset.s;refresh();});
      const rows = state.rows;
      const list = document.getElementById('list');
      list.innerHTML = rows.length?`<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Estimate</th><th>Customer</th><th>Status</th><th class="right">Total</th><th>Good through</th><th></th></tr></thead>
        <tbody>${rows.map(e=>`<tr class="clickable" data-id="${e.id}"><td class="cell-strong">${OF.escape(e.number)}<div class="tiny muted">${OF.date(e.created_at)}</div></td>
          <td>${OF.escape(e.customer_name)}</td><td>${OF.statusBadge(e.status)}</td>
          <td class="right mono">${OF.money(e.total_cents)}</td>
          <td class="small muted">${e.valid_until?OF.date(e.valid_until):'—'}</td><td></td></tr>`).join('')}</tbody></table></div>${OF.listFooter({ shown: rows.length, total: state.total, label: 'estimates' })}`
        : `<div class="empty"><div class="ic">${OF.icon('estimates',22)}</div><p>No estimates yet. Create one to send a customer an online approval link.</p></div>${OF.listFooter({ shown: 0, total: state.total, label: 'estimates' })}`;
      list.querySelectorAll('tr[data-id]').forEach(r=>r.onclick=()=>openDrawer(r.dataset.id));
      list.querySelector('[data-load-more]')?.addEventListener('click', () => refresh({ append: true }));
    }

    async function openDrawer(id) {
      const d = await OF.get('/api/admin/estimates/'+id);
      const e = d.estimate;
      const editable = e.status==='draft' || e.status==='sent';
      const liHtml = (e.line_items||[]).map(li=>`<div class="row between" style="padding:5px 0"><span>${OF.escape(li.label)}${li.quantity>1?` ×${li.quantity}`:''}</span><span class="mono">${OF.money(li.amount_cents)}</span></div>`).join('');
      const accepted = e.status==='accepted' || e.status==='converted';
      const dr = OF.drawer(`
        <div class="modal-head"><h3>${OF.escape(e.number)}</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body" style="overflow:auto">
          <div class="row between" style="margin-bottom:12px">${OF.statusBadge(e.status)}<span class="muted">${OF.escape(e.customer_name)}</span></div>
          <div class="card card-pad" style="margin-bottom:14px">
            ${liHtml}
            <hr class="divider">
            <div class="totline"><span class="muted">Subtotal</span><span class="mono">${OF.money(e.subtotal_cents)}</span></div>
            ${e.discount_cents?`<div class="totline"><span class="muted">Discount</span><span class="mono">−${OF.money(e.discount_cents)}</span></div>`:''}
            ${e.tax_cents?`<div class="totline"><span class="muted">Tax (${e.tax_rate_percent}%)</span><span class="mono">${OF.money(e.tax_cents)}</span></div>`:''}
            <div class="totline grand"><span>Total</span><span class="mono">${OF.money(e.total_cents)}</span></div>
          </div>
          ${accepted&&e.accepted_name?`<div class="card card-pad" style="margin-bottom:14px;background:var(--ok-tint)"><div class="small"><strong>Approved by ${OF.escape(e.accepted_name)}</strong></div><div class="tiny muted">${OF.dateTime(e.accepted_at)}${e.accepted_ip?` · IP ${OF.escape(e.accepted_ip)}`:''}</div>${e.converted_invoice_id?`<div class="tiny" style="margin-top:6px">Converted to invoice <a href="/admin/invoices?id=${e.converted_invoice_id}" data-link>#${e.converted_invoice_id}</a></div>`:''}</div>`:''}
          <div class="row wrap" style="gap:8px;margin-bottom:14px">
            ${e.status!=='converted'?`<button class="btn btn-primary btn-sm" id="sendBtn">${OF.icon('send',15)} ${e.sent_at?'Resend':'Send'} for approval</button>`:''}
            ${accepted&&!e.converted_invoice_id?`<button class="btn btn-secondary btn-sm" id="convBtn">${OF.icon('invoices',15)} Convert to invoice</button>`:''}
            ${editable?`<button class="btn btn-ghost btn-sm" id="editBtn">Edit</button>`:''}
            <button class="btn btn-ghost btn-sm" id="copyBtn">Copy approve link</button>
            ${!accepted&&e.status!=='declined'?`<button class="btn btn-danger-soft btn-sm" id="declineBtn">Mark declined</button>`:''}
          </div>
          ${d.acceptUrl?`<div class="small muted" style="word-break:break-all">Approve link: ${OF.escape(d.acceptUrl)}</div>`:''}
        </div>`, { wide:true });

      const reload = () => { dr.close(); refresh(); };
      dr.q('#sendBtn')?.addEventListener('click', async()=>{ try{ const r=await OF.post(`/api/admin/estimates/${id}/send`); OF.toast(r.emailed?'Estimate sent ✓':'Marked sent (email not configured)','ok'); reload(); }catch(err){OF.toast(err.message,'error');}});
      dr.q('#convBtn')?.addEventListener('click', async()=>{ try{ const r=await OF.post(`/api/admin/estimates/${id}/convert`); OF.toast('Converted to invoice','ok'); dr.close(); OF.go('/admin/invoices?id='+r.invoiceId); }catch(err){OF.toast(err.message,'error');}});
      dr.q('#editBtn')?.addEventListener('click', ()=>{ dr.close(); builder({ editId:id, estimate:e }); });
      dr.q('#declineBtn')?.addEventListener('click', async()=>{ if(!(await OF.confirm({title:'Mark this estimate declined?',confirmText:'Mark declined',danger:true}))) return; await OF.post(`/api/admin/estimates/${id}/decline`); OF.toast('Marked declined','ok'); reload(); });
      dr.q('#copyBtn')?.addEventListener('click', ()=>{ navigator.clipboard?.writeText(d.acceptUrl); OF.toast('Approve link copied','ok'); });
    }

    async function builder({ editId, estimate, customerId, customerName } = {}) {
      const items = estimate ? estimate.line_items.map(li=>({...li})) : [];
      let cust = { id: customerId || estimate?.customer_id || null, name: customerName || estimate?.customer_name || '' };
      let taxRate = estimate ? estimate.tax_rate_percent : META.defaults.taxRatePercent;
      let discount = estimate ? estimate.discount_cents : 0;
      const m = OF.modal(`
        <div class="modal-head"><h3>${editId?'Edit estimate':'New estimate'}</h3><button class="x" data-close>&times;</button></div>
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
          <div class="field"><label>Good through</label><input id="b_valid" type="date" value="${estimate?.valid_until?String(estimate.valid_until).slice(0,10):''}"></div>
          <div class="field"><label>Note to customer</label><textarea id="b_notes">${OF.escape(estimate?.notes||'')}</textarea></div>
          <div class="field"><label>Terms (shown above the signature)</label><textarea id="b_terms">${OF.escape(estimate?.terms||META.defaults.terms||'')}</textarea></div>
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
          row.querySelector('.l_label').oninput = ev=>{ items[i].label=ev.target.value; };
          row.querySelector('.l_qty').oninput = ev=>{ items[i].quantity=+ev.target.value||1; renderTotals(); };
          row.querySelector('.l_amt').oninput = ev=>{ items[i].unit_amount_cents=strToCents(ev.target.value); renderTotals(); };
          row.querySelector('.l_tax').onchange = ev=>{ items[i].taxable=ev.target.checked; renderTotals(); };
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

      const ci = m.q('#b_cust'); const cr = m.q('#b_results');
      ci.addEventListener('input', OF.debounce(async()=>{ const q=ci.value.trim(); if(q.length<2){cr.style.display='none';return;} const dd=await OF.get('/api/admin/customers?q='+encodeURIComponent(q)); cr.innerHTML=dd.customers.slice(0,6).map(c=>`<div class="card-pad" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line-2)" data-id="${c.id}" data-name="${OF.escape(c.name)}">${OF.escape(c.name)} <span class="tiny muted">${OF.escape(c.email||'')}</span></div>`).join('')||'<div class="card-pad small muted">No matches</div>'; cr.style.display='block'; cr.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{ cust={id:+x.dataset.id,name:x.dataset.name}; ci.value=cust.name; cr.style.display='none'; }); },250));

      async function save(send) {
        if (!cust.id) return OF.toast('Select a customer','error');
        if (!items.length) return OF.toast('Add at least one line item','error');
        const payload = { customerId:cust.id, lineItems:items, taxRatePercent:parseFloat(m.q('#b_tax').value)||0, discountCents:strToCents(m.q('#b_disc').value), notes:m.q('#b_notes').value, terms:m.q('#b_terms').value, validUntil:m.q('#b_valid').value||null };
        try {
          let est;
          if (editId) { est=(await OF.patch('/api/admin/estimates/'+editId,payload)).estimate; }
          else { est=(await OF.post('/api/admin/estimates',payload)).estimate; }
          if (send) {
            try { await OF.post(`/api/admin/estimates/${est.id}/send`); OF.toast('Estimate saved & sent','ok'); }
            catch (sendErr) {
              if (!editId) {
                m.close(); await refresh(); openDrawer(est.id);
                OF.toast(`Saved as draft — send failed: ${sendErr.message}`,'error');
                return;
              }
              throw sendErr;
            }
          }
          else OF.toast('Estimate saved','ok');
          m.close(); refresh();
        } catch(err){ OF.toast(err.message,'error'); }
      }
      m.q('#b_save').onclick = ()=>save(false);
      m.q('#b_savesend')?.addEventListener('click', ()=>save(true));
    }

    OF.page({ active:'estimates', title:'Estimates', subtitle:'Quotes customers can approve online — then convert to invoices', render: async (root, ctx) => {
      META = await OF.get('/api/admin/invoices/meta');
      ctx.setActions(`<button class="btn btn-primary btn-sm" id="newBtn">${OF.icon('plus',15)} New estimate</button>`);
      root.innerHTML = `<div id="tiles"></div><div class="row between wrap" style="gap:10px;margin-bottom:14px"><div class="row wrap" id="chips" style="gap:8px"></div>${OF.searchInput({ placeholder:'Search estimate or customer…', value: state.q })}</div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div>`;
      document.getElementById('newBtn').onclick=()=>builder({});
      document.getElementById('search').addEventListener('input', OF.debounce((e)=>{ state.q=e.target.value.trim(); refresh(); },300));
      await refresh();
      if (OF.qs('id')) openDrawer(OF.qs('id'));
      if (OF.qs('new')) {
        const cid = OF.qs('customer'); let cname='';
        if (cid) { try { cname=(await OF.get('/api/admin/customers/'+cid)).customer.name; } catch{} }
        builder({ customerId: cid?+cid:null, customerName: cname });
      }
    }});
