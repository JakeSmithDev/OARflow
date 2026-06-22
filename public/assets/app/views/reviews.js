// Reviews / NPS SPA view. Metrics, response feed, public-platform links, and a
// "request a review" action. No rating gating — links go to every customer.
const OF = window.OF;

    const state = { status: 'all' };
    const stars = (n) => n ? '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n) : '—';

    async function refresh() {
      const d = await OF.get('/api/admin/reviews?status=' + state.status);
      const m = d.metrics;
      document.getElementById('tiles').innerHTML = `<div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="label">Avg rating</div><div class="value">${m.avgRating ? m.avgRating.toFixed(2) : '—'} <span style="color:#f5b301;font-size:18px">★</span></div></div>
        <div class="stat"><div class="label">Responses</div><div class="value">${m.responses}/${m.requests}</div></div>
        <div class="stat"><div class="label">5-star</div><div class="value">${m.fiveStar}</div></div>
        <div class="stat"><div class="label">NPS</div><div class="value">${m.nps}</div></div></div>`;

      document.getElementById('chips').innerHTML = ['all', 'responded', 'sent', 'pending'].map(k => `<button class="chip ${state.status === k ? 'active' : ''}" data-s="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
      document.querySelectorAll('#chips .chip').forEach(b => b.onclick = () => { state.status = b.dataset.s; refresh(); });

      const rows = d.reviews;
      document.getElementById('list').innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Customer</th><th>Rating</th><th>Comment</th><th>Channel</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td class="cell-strong">${OF.escape(r.customer_name)}</td>
          <td style="color:#f5b301;letter-spacing:2px">${r.rating ? stars(r.rating) : '<span class="muted">—</span>'}</td>
          <td class="small">${r.comment ? OF.escape(r.comment) : '<span class="muted">—</span>'}${r.platform_clicked ? ` <span class="badge info no-dot">${OF.escape(r.platform_clicked)}</span>` : ''}</td>
          <td class="small muted">${OF.escape(r.channel)}</td><td>${OF.statusBadge(r.status)}</td>
          <td class="tiny muted">${OF.date(r.responded_at || r.sent_at || r.created_at)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="ic">${OF.icon('reviews', 22)}</div><p>No review requests yet. They send automatically after completed jobs.</p></div>`;

      // platform settings
      const p = d.platforms || {};
      document.getElementById('platforms').innerHTML = `<div class="card card-pad" style="margin-top:18px">
        <div class="row between" style="margin-bottom:10px"><strong>Public review links</strong><span class="tiny muted">Shown to every customer after they rate you</span></div>
        <div class="field"><label>Google review URL</label><input id="pf_google" placeholder="https://g.page/r/…/review" value="${OF.escape(p.google || '')}"></div>
        <div class="field"><label>Yelp URL</label><input id="pf_yelp" placeholder="https://yelp.com/biz/…" value="${OF.escape(p.yelp || '')}"></div>
        <div class="field"><label>Facebook URL</label><input id="pf_facebook" placeholder="https://facebook.com/…/reviews" value="${OF.escape(p.facebook || '')}"></div>
        <div class="row wrap" style="gap:14px;align-items:center;margin:10px 0">
          <label class="row" style="gap:8px"><input type="checkbox" id="pf_auto" style="width:auto" ${d.settings.autoRequest ? 'checked' : ''}> Auto-request after completed jobs</label>
          <div class="field" style="margin:0"><label>Delay (hours)</label><input id="pf_delay" type="number" min="0" style="max-width:90px" value="${d.settings.delayHours}"></div>
          <div class="field" style="margin:0"><label>Channel</label><select id="pf_channel"><option value="email" ${d.settings.channel === 'email' ? 'selected' : ''}>Email</option><option value="sms" ${d.settings.channel === 'sms' ? 'selected' : ''}>SMS</option></select></div>
        </div>
        <button class="btn btn-primary btn-sm" id="savePf">Save review settings</button></div>`;
      document.getElementById('savePf').onclick = async () => {
        await OF.put('/api/admin/reviews/settings', { platforms: { google: OF.val('pf_google'), yelp: OF.val('pf_yelp'), facebook: OF.val('pf_facebook') }, autoRequest: document.getElementById('pf_auto').checked, delayHours: +OF.val('pf_delay') || 0, channel: OF.val('pf_channel') });
        OF.toast('Review settings saved', 'ok');
      };
    }

    function requestModal() {
      let cust = { id: null, name: '' };
      const m = OF.modal(`<div class="modal-head"><h3>Request a review</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Customer *</label><input id="r_cust" placeholder="Search customer…" autocomplete="off"><div id="r_results" class="card" style="display:none;position:relative;z-index:5"></div></div>
          <div class="field"><label>Channel</label><select id="r_channel"><option value="email">Email</option><option value="sms">SMS</option></select></div>
          <p class="tiny muted">Sends a friendly request with a link to rate you and post publicly.</p>
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="r_send">Send request</button></div>`);
      const ci = m.q('#r_cust'); const cr = m.q('#r_results');
      ci.addEventListener('input', OF.debounce(async () => { const q = ci.value.trim(); if (q.length < 2) { cr.style.display = 'none'; return; } const d = await OF.get('/api/admin/customers?q=' + encodeURIComponent(q)); cr.innerHTML = d.customers.slice(0, 6).map(c => `<div class="card-pad" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line-2)" data-id="${c.id}" data-name="${OF.escape(c.name)}">${OF.escape(c.name)}</div>`).join('') || '<div class="card-pad small muted">No matches</div>'; cr.style.display = 'block'; cr.querySelectorAll('[data-id]').forEach(x => x.onclick = () => { cust = { id: +x.dataset.id, name: x.dataset.name }; ci.value = cust.name; cr.style.display = 'none'; }); }, 250));
      m.q('#r_send').onclick = async () => {
        if (!cust.id) return OF.toast('Select a customer', 'error');
        try { const r = await OF.post('/api/admin/reviews/request', { customerId: cust.id, channel: m.q('#r_channel').value }); OF.toast(r.sent ? 'Review request sent ✓' : 'Queued (notifications not configured)', 'ok'); m.close(); refresh(); }
        catch (e) { OF.toast(e.message, 'error'); }
      };
    }

    OF.page({ active: 'reviews', title: 'Reviews', subtitle: 'Reputation — request reviews and track ratings', render: async (root, ctx) => {
      ctx.setActions(`<button class="btn btn-primary btn-sm" id="reqBtn">${OF.icon('plus', 15)} Request a review</button>`);
      root.innerHTML = `<div id="tiles"></div><div class="row wrap" id="chips" style="gap:8px;margin-bottom:14px"></div><div id="list"><div class="loading-page"><span class="spinner"></span></div></div><div id="platforms"></div>`;
      document.getElementById('reqBtn').onclick = requestModal;
      await refresh();
    } });
