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
    estimates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/>',
    reports: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
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
    messaging: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
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
      ['messaging', 'Messages', '/admin/messaging', 'sms'],
    ]],
    ['Customers & Revenue', [
      ['customers', 'Customers', '/admin/customers'],
      ['estimates', 'Estimates', '/admin/estimates'],
      ['invoices', 'Invoices', '/admin/invoices'],
      ['recurring', 'Recurring', '/admin/plans'],
      ['followups', 'Follow-ups', '/admin/follow-ups', 'followups'],
      ['reports', 'Reports', '/admin/reports'],
    ]],
  ];

  function renderShell(active, counts = {}) {
    const t = OF.tenant || {};
    const brand = (t.branding || {});
    const navHtml = NAV.map(([section, items]) => `
      <div class="nav-section">${section}</div>
      ${items.map(([icon, label, href, countKey]) => `
        <a class="nav-link ${active === icon ? 'active' : ''}" href="${href}" data-view="${icon}">
          ${OF.icon(icon)} <span>${label}</span>
          ${countKey ? `<span class="badge-count" data-count="${countKey}"${counts[countKey] ? '' : ' hidden'}>${counts[countKey] || ''}</span>` : ''}
        </a>`).join('')}
    `).join('');
    const u = OF.session || {};
    return `
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="/admin/" data-view="dashboard" style="text-decoration:none">
          <div class="logo">${OF.escape((brand.logoText || t.name || 'O')[0])}</div>
          <div class="name">${OF.escape(brand.logoText || t.name || 'OARFlow')}<small>OARFlow</small></div>
        </a>
        ${navHtml}
        <div class="spacer"></div>
        ${(OF.session && OF.session.role === 'owner') ? `<a class="nav-link ${active === 'settings' ? 'active' : ''}" href="/admin/settings" data-view="settings">${OF.icon('settings')} <span>Settings</span></a>` : ''}
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

  // Session/tenant/counts are cached per-tab so the shell paints instantly.
  const CACHE_KEY = 'oarflow_admin_cache';
  function readCache() { try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } }
  function writeCache(o) { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(o)); } catch { /* */ } }
  OF.clearCache = () => { try { sessionStorage.removeItem(CACHE_KEY); } catch { /* */ } };

  function applyCounts(counts) {
    document.querySelectorAll('.badge-count[data-count]').forEach((el) => {
      const n = counts[el.dataset.count] || 0;
      if (n) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
    });
  }
  function setActiveNav(view) {
    document.querySelectorAll('.nav-link[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  }
  function bindShell() {
    const lo = document.getElementById('logoutBtn');
    if (lo && !lo._bound) { lo._bound = 1; lo.addEventListener('click', async () => { OF.clearCache(); await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/admin/login'; }); }
    const mt = document.getElementById('menuToggle');
    if (mt && !mt._bound) { mt._bound = 1; mt.addEventListener('click', () => document.getElementById('sidebar')?.classList.toggle('open')); }
  }

  // --- Client-side router (true SPA — no document reloads) -----------------
  OF._views = {};
  // View modules call OF.page({active,title,subtitle,render}) at import time to
  // register themselves; the router renders the registered view into #content.
  OF.page = (cfg) => { OF._views[cfg.active] = cfg; };

  const ROUTES = [
    { path: '/admin/', file: 'dashboard', view: 'dashboard' },
    { path: '/admin/schedule', file: 'schedule', view: 'schedule' },
    { path: '/admin/requests', file: 'requests', view: 'requests' },
    { path: '/admin/appointments', file: 'appointments', view: 'appointments' },
    { path: '/admin/messaging', file: 'messaging', view: 'messaging' },
    { path: '/admin/customers', file: 'customers', view: 'customers' },
    { path: '/admin/estimates', file: 'estimates', view: 'estimates' },
    { path: '/admin/invoices', file: 'invoices', view: 'invoices' },
    { path: '/admin/plans', file: 'plans', view: 'recurring' },
    { path: '/admin/follow-ups', file: 'followups', view: 'followups' },
    { path: '/admin/reports', file: 'reports', view: 'reports' },
    { path: '/admin/settings', file: 'settings', view: 'settings' },
  ];
  function matchRoute(pathname) {
    const p = pathname.replace(/\/+$/, '');
    if (p === '' || p === '/admin') return ROUTES[0];
    return ROUTES.find((r) => r.path.replace(/\/$/, '') === p) || ROUTES[0];
  }

  /** Navigate within the SPA (pushState + render). External paths fall back to a full load. */
  OF.go = (href) => {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/admin') || url.pathname.startsWith('/admin/login')) { location.href = href; return; }
    const target = url.pathname + url.search;
    if (target !== location.pathname + location.search) history.pushState({}, '', target);
    renderRoute();
  };

  let routeSeq = 0;
  async function renderRoute() {
    const route = matchRoute(location.pathname);
    setActiveNav(route.view);
    const content = document.getElementById('content');
    if (!content) return;
    document.getElementById('pageActions').innerHTML = '';
    content.innerHTML = '<div class="loading-page"><span class="spinner"></span></div>';
    const seq = ++routeSeq;
    if (!OF._views[route.view]) {
      try { await import(`/assets/app/views/${route.file}.js`); }
      catch (e) { content.innerHTML = `<div class="empty"><div class="ic">${OF.icon('bell', 22)}</div><p>Couldn't load this page.</p></div>`; return; }
    }
    if (seq !== routeSeq) return; // superseded by a newer navigation
    const cfg = OF._views[route.view];
    if (!cfg) { content.innerHTML = '<div class="empty"><p>View not found.</p></div>'; return; }
    document.getElementById('pageTitle').textContent = cfg.title || '';
    document.getElementById('pageSub').textContent = cfg.subtitle || '';
    document.title = (cfg.title ? cfg.title + ' · ' : '') + (OF.tenant?.name || 'OARFlow');
    window.scrollTo(0, 0);
    document.getElementById('sidebar')?.classList.remove('open');
    try {
      await cfg.render(content, { session: OF.session, tenant: OF.tenant, setActions: OF.setActions });
    } catch (err) {
      content.innerHTML = `<div class="empty"><div class="ic">${OF.icon('bell', 22)}</div><p>${OF.escape(err.message)}</p></div>`;
    }
  }

  function onDocClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.getAttribute('href'), location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/admin') || url.pathname.startsWith('/admin/login')) return;
    e.preventDefault();
    OF.go(url.pathname + url.search);
  }

  OF.setActions = (html) => { const a = document.getElementById('pageActions'); if (a) a.innerHTML = html; };

  /** Boot the admin SPA: render the persistent shell once, validate session,
   *  wire routing, then render the current route. */
  OF.mountSPA = async function () {
    const root = document.getElementById('app') || document.body;
    root.className = 'app';
    const cached = readCache();
    const active = matchRoute(location.pathname).view;
    if (cached && cached.tenant) {
      OF.session = cached.session; OF.tenant = cached.tenant;
      root.innerHTML = renderShell(active, cached.counts || {});
      bindShell();
    }
    let s;
    try { s = await api('/api/admin/auth/session'); }
    catch { OF.clearCache(); location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
    OF.session = s.user; OF.tenant = s.tenant;
    const counts = (cached && cached.counts) || {};
    writeCache({ session: s.user, tenant: s.tenant, counts });
    if (!(cached && cached.tenant)) { root.innerHTML = renderShell(active, counts); bindShell(); }
    api('/api/admin/dashboard/counts').then((r) => { const c = r.counts || {}; applyCounts(c); writeCache({ session: OF.session, tenant: OF.tenant, counts: c }); }).catch(() => {});
    document.addEventListener('click', onDocClick);
    window.addEventListener('popstate', renderRoute);
    await renderRoute();
  };

  window.OF = OF;
})();
