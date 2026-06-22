/* OARFlow admin framework — shared client runtime for every admin page.
   Exposes a global `OF` with: API client, auth guard + app shell, and UI
   primitives (toast/modal/drawer/confirm) and formatting helpers. */
(function () {
  const OF = {};
  OF.session = null;
  OF.tenant = null;

  // --- API ----------------------------------------------------------------
  async function api(path, { method = 'GET', body, raw } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.endsWith('/auth/session')) {
      location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search);
      throw new Error('unauthorized');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (raw) return { res, data };
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.code = data && data.code; err.status = res.status;
      throw err;
    }
    return data;
  }
  OF.api = api;
  OF.get = (p) => api(p);
  OF.post = (p, body) => api(p, { method: 'POST', body });
  OF.put = (p, body) => api(p, { method: 'PUT', body });
  OF.patch = (p, body) => api(p, { method: 'PATCH', body });
  OF.del = (p, body) => api(p, { method: 'DELETE', body });

  // --- Formatting ---------------------------------------------------------
  OF.money = (cents, opts = {}) => {
    const cur = (OF.tenant && OF.tenant.currency) || 'USD';
    const v = (Number(cents) || 0) / 100;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, ...opts }).format(v); }
    catch { return '$' + v.toFixed(2); }
  };
  const tz = () => (OF.tenant && OF.tenant.timezone) || 'America/New_York';
  OF.date = (iso) => iso ? new Intl.DateTimeFormat('en-US', { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso)) : '—';
  OF.dateLong = (iso) => iso ? new Intl.DateTimeFormat('en-US', { timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso)) : '—';
  OF.time = (iso) => iso ? new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
  OF.dateTime = (iso) => iso ? `${OF.date(iso)} · ${OF.time(iso)}` : '—';
  OF.escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  OF.initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  OF.debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  OF.qs = (k) => new URLSearchParams(location.search).get(k);

  const STATUS = {
    scheduled: ['info', 'Scheduled'], requested: ['warn', 'Requested'], completed: ['ok', 'Completed'],
    canceled: ['neutral', 'Canceled'], no_show: ['danger', 'No-show'],
    draft: ['neutral', 'Draft'], sent: ['info', 'Sent'], partial: ['warn', 'Partial'], paid: ['ok', 'Paid'], void: ['neutral', 'Void'],
    active: ['ok', 'Active'], paused: ['warn', 'Paused'], pending: ['warn', 'Pending'], done: ['ok', 'Done'], snoozed: ['neutral', 'Snoozed'],
  };
  OF.statusBadge = (status) => {
    const [cls, label] = STATUS[status] || ['neutral', status];
    return `<span class="badge ${cls}">${OF.escape(label)}</span>`;
  };

  // --- Icons --------------------------------------------------------------
  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"/>',
    schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    requests: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    appointments: '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    customers: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    invoices: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
    recurring: '<path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>',
    followups: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', check: '<path d="M20 6L9 17l-5-5"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  };
  OF.icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

  // --- Toast / modal / drawer / confirm -----------------------------------
  OF.toast = (msg, type = '') => {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'error' ? 'err' : type === 'ok' ? 'ok' : '');
    el.innerHTML = (type === 'ok' ? OF.icon('check', 16) : '') + `<span>${OF.escape(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3200);
  };

  OF.modal = (innerHtml, { wide } = {}) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${innerHtml}</div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: ov, close, q: (sel) => ov.querySelector(sel) };
  };

  OF.drawer = (innerHtml, { wide } = {}) => {
    const ov = document.createElement('div'); ov.className = 'drawer-overlay';
    const dr = document.createElement('div'); dr.className = 'drawer ' + (wide ? 'wide' : '');
    dr.innerHTML = innerHtml;
    document.body.appendChild(ov); document.body.appendChild(dr);
    const close = () => { ov.remove(); dr.remove(); };
    ov.addEventListener('click', close);
    dr.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: dr, close, q: (s) => dr.querySelector(s) };
  };

  OF.confirm = ({ title = 'Are you sure?', body = '', confirmText = 'Confirm', danger = false }) => new Promise((resolve) => {
    const m = OF.modal(`
      <div class="modal-head"><h3>${OF.escape(title)}</h3><button class="x" data-close>&times;</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${OF.escape(confirmText)}</button></div>`);
    m.q('[data-ok]').addEventListener('click', () => { m.close(); resolve(true); });
    m.el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });

  // --- App shell + auth guard ---------------------------------------------
  const NAV = [
    ['Operations', [
      ['dashboard', 'Dashboard', '/admin/'],
      ['schedule', 'Schedule', '/admin/schedule'],
      ['requests', 'Requests', '/admin/requests', 'requests'],
      ['appointments', 'Appointments', '/admin/appointments'],
    ]],
    ['Customers & Revenue', [
      ['customers', 'Customers', '/admin/customers'],
      ['invoices', 'Invoices', '/admin/invoices'],
      ['recurring', 'Recurring', '/admin/plans'],
      ['followups', 'Follow-ups', '/admin/follow-ups', 'followups'],
    ]],
  ];

  function renderShell(active, counts = {}) {
    const t = OF.tenant || {};
    const brand = (t.branding || {});
    const navHtml = NAV.map(([section, items]) => `
      <div class="nav-section">${section}</div>
      ${items.map(([icon, label, href, countKey]) => `
        <a class="nav-link ${active === icon ? 'active' : ''}" href="${href}">
          ${OF.icon(icon)} <span>${label}</span>
          ${countKey && counts[countKey] ? `<span class="badge-count">${counts[countKey]}</span>` : ''}
        </a>`).join('')}
    `).join('');
    const u = OF.session || {};
    return `
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="logo">${OF.escape((brand.logoText || t.name || 'O')[0])}</div>
          <div class="name">${OF.escape(brand.logoText || t.name || 'OARFlow')}<small>OARFlow</small></div>
        </div>
        ${navHtml}
        <div class="spacer"></div>
        ${(OF.session && OF.session.role === 'owner') ? `<a class="nav-link ${active === 'settings' ? 'active' : ''}" href="/admin/settings">${OF.icon('settings')} <span>Settings</span></a>` : ''}
        <div class="user">
          <div class="avatar">${OF.initials(u.displayName || u.username)}</div>
          <div class="meta">${OF.escape(u.displayName || u.username || 'Admin')}<br><small>${OF.escape(u.role || '')}</small></div>
          <button class="link-btn" id="logoutBtn" style="margin-left:auto;color:#7c8aa0">Log out</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <button class="menu-toggle" id="menuToggle" aria-label="Open menu">${OF.icon('menu', 20)}</button>
          <div><h1 id="pageTitle">…</h1><div class="sub" id="pageSub"></div></div>
          <div class="actions" id="pageActions"></div>
        </div>
        <div class="content" id="content"><div class="loading-page"><span class="spinner"></span></div></div>
      </main>`;
  }

  /** Boot an admin page: guard auth, render shell, then call cfg.render(contentEl, ctx). */
  OF.page = async function (cfg) {
    const root = document.getElementById('app') || document.body;
    try {
      const s = await api('/api/admin/auth/session');
      OF.session = s.user; OF.tenant = s.tenant;
    } catch {
      location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    document.title = (cfg.title ? cfg.title + ' · ' : '') + (OF.tenant.name || 'OARFlow');
    root.className = 'app';
    let counts = {};
    try { counts = (await api('/api/admin/dashboard/counts')).counts || {}; } catch { /* optional */ }
    root.innerHTML = renderShell(cfg.active, counts);
    document.getElementById('pageTitle').textContent = cfg.title || '';
    document.getElementById('pageSub').textContent = cfg.subtitle || '';
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/admin/login';
    });
    document.getElementById('menuToggle')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('open');
    });
    const content = document.getElementById('content');
    try {
      await cfg.render(content, { session: OF.session, tenant: OF.tenant, setActions: (html) => { document.getElementById('pageActions').innerHTML = html; } });
    } catch (err) {
      content.innerHTML = `<div class="empty"><div class="ic">${OF.icon('bell', 22)}</div><p>${OF.escape(err.message)}</p></div>`;
    }
  };

  OF.setActions = (html) => { const a = document.getElementById('pageActions'); if (a) a.innerHTML = html; };

  window.OF = OF;
})();
