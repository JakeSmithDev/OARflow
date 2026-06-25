// Compliance SPA view: chemical/material catalog, applicator licenses, and the
// state-report (pesticide use) CSV export. We never auto-submit to any agency.
const OF = window.OF;

    // Starter catalog of common professional pest-control products. These values
    // are editable suggestions only; teams must verify current labels/SDS before
    // using them for compliance records.
    const PEST_PRODUCTS = [
      { name: 'Termidor SC', epa: '7969-210', ai: 'Fipronil 9.1%', signal: 'Caution', unit: 'oz', rate: '0.8 oz/gal', pests: 'Termites, ants' },
      { name: 'Taurus SC', epa: '53883-279', ai: 'Fipronil 9.1%', signal: 'Caution', unit: 'oz', rate: '0.8 oz/gal', pests: 'Termites, ants' },
      { name: 'Talstar P (Professional)', epa: '279-3206', ai: 'Bifenthrin 7.9%', signal: 'Caution', unit: 'oz', rate: '1 oz/gal', pests: 'Ants, spiders, general pests' },
      { name: 'Suspend SC', epa: '432-763', ai: 'Deltamethrin 4.75%', signal: 'Caution', unit: 'oz', rate: '0.75 oz/gal', pests: 'Crawling & flying insects' },
      { name: 'Demand CS', epa: '100-1066', ai: 'Lambda-cyhalothrin 9.7%', signal: 'Caution', unit: 'oz', rate: '0.4 oz/gal', pests: 'Ants, spiders, fleas, ticks' },
      { name: 'Temprid FX', epa: '432-1544', ai: 'Imidacloprid 21% + Beta-cyfluthrin 10.5%', signal: 'Caution', unit: 'mL', rate: '8 mL/gal', pests: 'Bed bugs, ants, roaches' },
      { name: 'Tempo SC Ultra', epa: '432-1363', ai: 'Beta-cyfluthrin 11.8%', signal: 'Caution', unit: 'mL', rate: '8 mL/gal', pests: '100+ nuisance pests' },
      { name: 'Alpine WSG', epa: '499-561', ai: 'Dinotefuran 40%', signal: 'Caution', unit: 'g', rate: '5 g/gal', pests: 'Ants, roaches, bed bugs' },
      { name: 'Gentrol IGR Concentrate', epa: '2724-351', ai: '(S)-Hydroprene 9%', signal: 'Caution', unit: 'oz', rate: '1 oz/gal', pests: 'Roaches, fleas, stored-product pests (IGR)' },
      { name: 'Maxforce FC Magnum Roach Gel', epa: '432-1460', ai: 'Fipronil 0.05%', signal: 'Caution', unit: 'g', rate: 'bait placements', pests: 'Cockroaches' },
      { name: 'Advion Cockroach Gel Bait', epa: '100-1484', ai: 'Indoxacarb 0.6%', signal: 'Caution', unit: 'g', rate: 'bait placements', pests: 'Cockroaches' },
    ];

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const range = { from: iso(new Date(today.getFullYear(), 0, 1)), to: iso(today) };

    async function refresh() {
      const [pr, techs] = await Promise.all([OF.get('/api/admin/compliance/products?all=1'), OF.get('/api/admin/technicians?all=1')]);
      renderProducts(pr.products);
      renderLicenses(techs.technicians);
    }

    function renderProducts(rows) {
      document.getElementById('products').innerHTML = `<div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Chemical / material catalog</h3><button class="btn btn-secondary btn-sm" id="addProd">${OF.icon('plus', 14)} Add product</button></div>
        ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th>EPA Reg #</th><th>Active ingredient</th><th>Signal</th><th>Default rate</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr class="clickable" data-id="${p.id}"><td class="cell-strong">${OF.escape(p.name)}${p.is_active ? '' : ' <span class="tiny muted">(inactive)</span>'}</td><td class="mono">${OF.escape(p.epa_reg_no || '—')}</td><td>${OF.escape(p.active_ingredient || '—')}</td><td>${OF.escape(p.signal_word || '—')}</td><td>${OF.escape(p.default_rate || '—')}</td><td></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty"><p>No products yet. Add the materials your team applies.</p></div>'}`;
      document.getElementById('addProd').onclick = () => productModal(null);
      document.querySelectorAll('#products tr[data-id]').forEach((r) => r.onclick = () => productModal(r.dataset.id, rows.find((x) => String(x.id) === r.dataset.id)));
    }

    function renderLicenses(techs) {
      document.getElementById('licenses').innerHTML = `<h3 style="margin:0 0 10px">Applicator licenses</h3>
        ${techs.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Technician</th><th>License #</th><th>State</th><th>Expires</th><th></th></tr></thead>
        <tbody>${techs.map((t) => `<tr><td class="cell-strong">${OF.escape(t.name)}</td><td><input class="lic-no" data-id="${t.id}" value="${OF.escape(t.license_no || '')}" style="max-width:150px"></td><td><input class="lic-st" data-id="${t.id}" value="${OF.escape(t.license_state || '')}" style="max-width:70px"></td><td><input type="date" class="lic-exp" data-id="${t.id}" value="${t.license_expires ? String(t.license_expires).slice(0, 10) : ''}"></td><td><button class="btn btn-ghost btn-xs lic-save" data-id="${t.id}">Save</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">Add technicians from a job to manage their licenses here.</p>'}`;
      document.querySelectorAll('.lic-save').forEach((b) => b.onclick = async () => {
        const id = b.dataset.id;
        await OF.patch('/api/admin/technicians/' + id, { licenseNo: document.querySelector(`.lic-no[data-id="${id}"]`).value, licenseState: document.querySelector(`.lic-st[data-id="${id}"]`).value, licenseExpires: document.querySelector(`.lic-exp[data-id="${id}"]`).value || null });
        OF.toast('License saved', 'ok');
      });
    }

    function productModal(id, p = {}) {
      const m = OF.modal(`<div class="modal-head"><h3>${id ? 'Edit' : 'Add'} product</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Name *</label><input id="p_name" list="pestcatalog" autocomplete="off" placeholder="${id ? '' : 'Start typing, e.g. Termidor or Talstar'}" value="${OF.escape(p.name || '')}">
            <datalist id="pestcatalog">${PEST_PRODUCTS.map((x) => `<option value="${OF.escape(x.name)}">${OF.escape(x.ai)}</option>`).join('')}</datalist>
            ${id ? '' : '<div id="p_auto" class="tiny" style="color:var(--brand);margin-top:4px;display:none">Suggested fields filled from catalog. Verify the current label/SDS before saving.</div>'}</div>
          <div class="grid cols-2"><div class="field"><label>EPA Reg #</label><input id="p_epa" value="${OF.escape(p.epa_reg_no || '')}"></div><div class="field"><label>Active ingredient</label><input id="p_ai" value="${OF.escape(p.active_ingredient || '')}"></div></div>
          <div class="grid cols-3"><div class="field"><label>Signal word</label><select id="p_sig"><option value="">—</option>${['Caution', 'Warning', 'Danger'].map((s) => `<option ${p.signal_word === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Unit</label><input id="p_unit" value="${OF.escape(p.unit || 'oz')}"></div><div class="field"><label>Default rate</label><input id="p_rate" value="${OF.escape(p.default_rate || '')}"></div></div>
          <div class="field"><label>Target pests</label><input id="p_pests" value="${OF.escape(p.target_pests || '')}"></div>
          ${id ? `<label class="row" style="gap:8px"><input type="checkbox" id="p_active" ${p.is_active ? 'checked' : ''} style="width:auto"> Active</label>` : ''}
        </div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="p_save">Save</button></div>`);
      // Autofill from the catalog when the typed/selected name matches a known product.
      if (!id) m.q('#p_name').addEventListener('input', (e) => {
        const hit = PEST_PRODUCTS.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
        const note = m.q('#p_auto');
        if (!hit) { if (note) note.style.display = 'none'; return; }
        m.q('#p_epa').value = hit.epa || ''; m.q('#p_ai').value = hit.ai || ''; m.q('#p_sig').value = hit.signal || '';
        m.q('#p_unit').value = hit.unit || 'oz'; m.q('#p_rate').value = hit.rate || ''; m.q('#p_pests').value = hit.pests || '';
        if (note) note.style.display = 'block';
      });
      m.q('#p_save').onclick = async () => {
        const body = { name: m.q('#p_name').value.trim(), epaRegNo: m.q('#p_epa').value, activeIngredient: m.q('#p_ai').value, signalWord: m.q('#p_sig').value, unit: m.q('#p_unit').value, defaultRate: m.q('#p_rate').value, targetPests: m.q('#p_pests').value };
        if (id && m.q('#p_active')) body.isActive = m.q('#p_active').checked;
        if (!body.name) return OF.toast('Name required', 'error');
        try { if (id) await OF.patch('/api/admin/compliance/products/' + id, body); else await OF.post('/api/admin/compliance/products', body); OF.toast('Saved', 'ok'); m.close(); refresh(); } catch (e) { OF.toast(e.message, 'error'); }
      };
    }

    OF.page({ active: 'compliance', title: 'Compliance', subtitle: 'Materials, applicator licenses & state reports', render: async (root, ctx) => {
      root.innerHTML = `<div id="products" class="card card-pad" style="margin-bottom:18px"></div>
        <div id="licenses" class="card card-pad" style="margin-bottom:18px"></div>
        <div class="card card-pad"><h3 style="margin:0 0 10px">State pesticide-use report</h3>
          <div class="row wrap" style="gap:12px;align-items:end">
            <div class="field" style="margin:0"><label>From</label><input type="date" id="c_from" value="${range.from}"></div>
            <div class="field" style="margin:0"><label>To</label><input type="date" id="c_to" value="${range.to}"></div>
            <button class="btn btn-primary btn-sm" id="c_export">Export CSV</button>
          </div>
          <p class="tiny muted" style="margin-top:10px">Exports all chemical applications in the range with EPA #, rate, target pest, area, and applicator. OARFlow never auto-submits to any agency.</p></div>`;
      document.getElementById('c_export').onclick = () => window.open(`/api/admin/compliance/applications.csv?from=${document.getElementById('c_from').value}&to=${document.getElementById('c_to').value}`, '_blank');
      await refresh();
    } });
