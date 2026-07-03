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
  OF.val = (id) => document.getElementById(id)?.value;
  // Sanitize a color before interpolating into a style string (XSS guard for any
  // legacy non-hex data; new writes are validated to hex server-side).
  OF.color = (c, fallback = 'var(--brand)') => {
    const v = String(c || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) return '#' + v.slice(1).split('').map((x) => x + x).join('').toLowerCase();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    return fallback;
  };

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
  OF.listLimit = 50;

  OF.searchInput = ({ id = 'search', placeholder = 'Search…', value = '' } = {}) =>
    `<div class="input-prefix" style="max-width:320px">${OF.icon('search', 16).replace('<svg', '<svg style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted)"')}<input id="${OF.escape(id)}" placeholder="${OF.escape(placeholder)}" value="${OF.escape(value)}" style="padding-left:34px"></div>`;

  OF.listFooter = ({ shown = 0, total = 0, label = 'items' } = {}) => {
    const hasMore = Number(total) > Number(shown);
    return `<div class="list-footer">
      <span class="small muted">Showing <b>${Number(shown) || 0}</b> of <b>${Number(total) || 0}</b> ${OF.escape(label)}</span>
      ${hasMore ? `<button class="btn btn-secondary btn-sm" data-load-more>Load more</button>` : ''}
    </div>`;
  };

  OF.customerPicker = ({ input, results, onSelect, onType, limit = 6 } = {}) => {
    if (!input || !results) return;
    let selected = null;
    const close = () => { results.style.display = 'none'; };
    let observer = null;
    let cleaned = false;
    const onDocumentClick = (e) => { if (!results.contains(e.target) && e.target !== input) close(); };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener('click', onDocumentClick);
      observer?.disconnect();
      close();
    };
    const onInput = OF.debounce(async () => {
      selected = null;
      onType && onType(input.value);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      const d = await OF.get('/api/admin/customers?q=' + encodeURIComponent(q));
      results.innerHTML = (d.customers || []).slice(0, limit).map((c) => `
        <div class="picker-row" data-id="${c.id}" data-name="${OF.escape(c.name)}" data-email="${OF.escape(c.email || '')}" data-phone="${OF.escape(c.phone || '')}" data-address="${OF.escape(c.address || '')}">
          <span>${OF.escape(c.name)}</span>
          <small>${OF.escape([c.email, c.phone].filter(Boolean).join(' · ') || c.address || '')}</small>
        </div>`).join('') || '<div class="picker-row muted">No matches</div>';
      results.style.display = 'block';
      results.querySelectorAll('[data-id]').forEach((row) => row.addEventListener('click', () => {
        selected = {
          id: Number(row.dataset.id), name: row.dataset.name, email: row.dataset.email,
          phone: row.dataset.phone, address: row.dataset.address,
        };
        input.value = selected.name;
        close();
        onSelect && onSelect(selected);
      }));
    }, 250);
    input.addEventListener('input', onInput);
    document.addEventListener('click', onDocumentClick);
    if ('MutationObserver' in window) {
      observer = new MutationObserver(() => {
        if (!document.body.contains(input) && !document.body.contains(results)) cleanup();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    OF.onCleanup(cleanup);
    return { get selected() { return selected; }, clear() { selected = null; close(); }, cleanup };
  };

  const STATUS = {
    scheduled: ['info', 'Scheduled'], requested: ['warn', 'Requested'], completed: ['ok', 'Completed'],
    canceled: ['neutral', 'Canceled'], no_show: ['danger', 'No-show'],
    draft: ['neutral', 'Draft'], sent: ['info', 'Sent'], partial: ['warn', 'Partial'], paid: ['ok', 'Paid'], void: ['neutral', 'Void'],
    accepted: ['ok', 'Accepted'], declined: ['danger', 'Declined'], converted: ['purple', 'Converted'], signed: ['ok', 'Signed'], responded: ['ok', 'Responded'],
    active: ['ok', 'Active'], paused: ['warn', 'Paused'], pending: ['warn', 'Pending'], done: ['ok', 'Done'], snoozed: ['neutral', 'Snoozed'], accrued: ['warn', 'Accrued'],
    received: ['info', 'Received'], delivered: ['ok', 'Delivered'], queued: ['neutral', 'Queued'], failed: ['danger', 'Failed'], suppressed: ['warn', 'Suppressed'],
    missed: ['warn', 'Missed'], voicemail: ['warn', 'Voicemail'], transferred: ['purple', 'Transferred'],
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
    reviews: '<path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"/>',
    documents: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h3"/>',
    compliance: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    receptionist: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    developer: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    commissions: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
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

  const closeStack = [];
  function pushClose(close) { closeStack.push(close); }
  function popClose(close) {
    const i = closeStack.lastIndexOf(close);
    if (i >= 0) closeStack.splice(i, 1);
  }

  OF.modal = (innerHtml, { wide, onClose } = {}) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${innerHtml}</div>`;
    document.body.appendChild(ov);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      popClose(close);
      ov.remove();
      onClose && onClose();
    };
    pushClose(close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: ov, close, q: (sel) => ov.querySelector(sel) };
  };

  OF.drawer = (innerHtml, { wide } = {}) => {
    const ov = document.createElement('div'); ov.className = 'drawer-overlay';
    const dr = document.createElement('div'); dr.className = 'drawer ' + (wide ? 'wide' : '');
    dr.innerHTML = innerHtml;
    document.body.appendChild(ov); document.body.appendChild(dr);
    let closed = false;
    const close = () => { if (closed) return; closed = true; popClose(close); ov.remove(); dr.remove(); };
    pushClose(close);
    ov.addEventListener('click', close);
    dr.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: dr, close, q: (s) => dr.querySelector(s) };
  };

  OF.confirm = ({ title = 'Are you sure?', body = '', confirmText = 'Confirm', danger = false }) => new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const m = OF.modal(`
      <div class="modal-head"><h3>${OF.escape(title)}</h3><button class="x" data-close>&times;</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${OF.escape(confirmText)}</button></div>`, { onClose: () => finish(false) });
    m.q('[data-ok]').addEventListener('click', () => finish(true));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const close = closeStack[closeStack.length - 1];
    if (close) { e.preventDefault(); close(); return; }
    const sb = document.getElementById('sidebar');
    if (sb?.classList.contains('open')) { e.preventDefault(); sb.classList.remove('open'); document.getElementById('scrim')?.setAttribute('hidden', ''); }
  });

  // --- App shell + auth guard ---------------------------------------------
  const NAV = [
    ['Operations', [
      ['dashboard', 'Dashboard', '/admin/'],
      ['schedule', 'Schedule', '/admin/schedule'],
      ['requests', 'Requests', '/admin/requests', 'requests'],
      ['appointments', 'Appointments', '/admin/appointments'],
      ['messaging', 'Messages', '/admin/messaging', 'sms'],
      ['receptionist', 'Receptionist', '/admin/receptionist'],
      ['compliance', 'Compliance', '/admin/compliance'],
    ]],
    ['Customers & Revenue', [
      ['customers', 'Customers', '/admin/customers'],
      ['estimates', 'Estimates', '/admin/estimates'],
      ['invoices', 'Invoices', '/admin/invoices'],
      ['recurring', 'Recurring', '/admin/plans'],
      ['followups', 'Follow-ups', '/admin/follow-ups', 'followups'],
      ['reports', 'Reports', '/admin/reports'],
      ['commissions', 'Commissions', '/admin/commissions'],
      ['reviews', 'Reviews', '/admin/reviews'],
      ['documents', 'Documents', '/admin/documents'],
      ['developer', 'Developer', '/admin/developer'],
    ]],
  ];

  // Capability required to SEE each nav item (matches the server-side guards).
  // Missing entry = visible to any admin. '*' = owner only.
  const NAV_CAP = {
    schedule: 'schedule.view', requests: 'requests.manage', appointments: 'appointments.manage',
    messaging: 'messaging.use', receptionist: 'messaging.use', compliance: 'compliance.manage',
    customers: 'customers.manage', estimates: 'estimates.manage', invoices: 'invoices.manage',
    recurring: 'plans.manage', followups: 'followups.manage', reports: 'reports.view',
    commissions: 'commissions.manage', reviews: 'reviews.manage', documents: 'documents.manage',
    developer: '*', settings: '*',
  };
  OF.hasCap = (cap) => { if (!cap) return true; const caps = (OF.session && OF.session.capabilities) || []; return caps.includes('*') || caps.includes(cap); };

  function renderShell(active, counts = {}) {
    const t = OF.tenant || {};
    const brand = (t.branding || {});
    const navHtml = NAV.map(([section, items]) => {
      const visible = items.filter(([icon]) => OF.hasCap(NAV_CAP[icon]));
      if (!visible.length) return ''; // hide a section with no permitted items
      return `<div class="nav-section">${section}</div>
      ${visible.map(([icon, label, href, countKey]) => `
        <a class="nav-link ${active === icon ? 'active' : ''}" href="${href}" data-view="${icon}">
          ${OF.icon(icon)} <span>${label}</span>
          ${countKey ? `<span class="badge-count" data-count="${countKey}"${counts[countKey] ? '' : ' hidden'}>${counts[countKey] || ''}</span>` : ''}
        </a>`).join('')}`;
    }).join('');
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
      <div class="scrim" id="scrim" hidden></div>
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
  function shellSignature(session, tenant) {
    return JSON.stringify({
      user: session ? { id: session.userId, username: session.username, displayName: session.displayName, role: session.role, capabilities: session.capabilities || [] } : null,
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone, currency: tenant.currency, branding: tenant.branding || {} } : null,
    });
  }

  function applyCounts(counts) {
    document.querySelectorAll('.badge-count[data-count]').forEach((el) => {
      const n = counts[el.dataset.count] || 0;
      if (n) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
    });
  }
  OF.applyCounts = applyCounts;
  OF.refreshCounts = () => api('/api/admin/dashboard/counts').then((r) => {
    const c = r.counts || {};
    applyCounts(c);
    writeCache({ session: OF.session, tenant: OF.tenant, counts: c });
    return c;
  }).catch(() => null);

  function setActiveNav(view) {
    document.querySelectorAll('.nav-link[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  }
  function bindShell() {
    const lo = document.getElementById('logoutBtn');
    if (lo && !lo._bound) { lo._bound = 1; lo.addEventListener('click', async () => { OF.clearCache(); await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/admin/login'; }); }
    const mt = document.getElementById('menuToggle');
    const scrim = document.getElementById('scrim');
    const closeMenu = () => { document.getElementById('sidebar')?.classList.remove('open'); scrim?.setAttribute('hidden', ''); };
    if (mt && !mt._bound) {
      mt._bound = 1;
      mt.addEventListener('click', () => {
        const sb = document.getElementById('sidebar');
        const open = !sb?.classList.contains('open');
        sb?.classList.toggle('open', open);
        if (open) scrim?.removeAttribute('hidden'); else scrim?.setAttribute('hidden', '');
      });
    }
    if (scrim && !scrim._bound) { scrim._bound = 1; scrim.addEventListener('click', closeMenu); }
  }

  // --- Client-side router (true SPA — no document reloads) -----------------
  OF._views = {};
  // View modules call OF.page({active,title,subtitle,render}) at import time to
  // register themselves; the router renders the registered view into #content.
  OF.page = (cfg) => { OF._views[cfg.active] = cfg; };
  OF._views.notfound = {
    active: 'notfound',
    title: 'Not found',
    subtitle: 'This admin page does not exist',
    render: async (root) => {
      root.innerHTML = `<div class="empty"><div class="ic">${OF.icon('bell', 22)}</div><p>We couldn't find that admin page.</p><a class="btn btn-primary btn-sm" href="/admin/">Go to Dashboard</a></div>`;
    },
  };

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
    { path: '/admin/commissions', file: 'commissions', view: 'commissions' },
    { path: '/admin/reviews', file: 'reviews', view: 'reviews' },
    { path: '/admin/documents', file: 'documents', view: 'documents' },
    { path: '/admin/compliance', file: 'compliance', view: 'compliance' },
    { path: '/admin/receptionist', file: 'receptionist', view: 'receptionist' },
    { path: '/admin/developer', file: 'developer', view: 'developer' },
    { path: '/admin/settings', file: 'settings', view: 'settings' },
  ];
  function matchRoute(pathname) {
    const p = pathname.replace(/\/+$/, '');
    if (p === '' || p === '/admin') return ROUTES[0];
    return ROUTES.find((r) => r.path.replace(/\/$/, '') === p) || { path: p, file: null, view: 'notfound' };
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
  let cleanups = [];
  OF.onCleanup = (fn) => { if (typeof fn === 'function') cleanups.push(fn); };
  function runCleanups() {
    const fns = cleanups;
    cleanups = [];
    for (const fn of fns) { try { fn(); } catch { /* best-effort */ } }
  }
  async function renderRoute() {
    runCleanups();
    const route = matchRoute(location.pathname);
    setActiveNav(route.view);
    const content = document.getElementById('content');
    if (!content) return;
    document.getElementById('pageActions').innerHTML = '';
    OF.refreshCounts();
    const seq = ++routeSeq;
    const loading = '<div class="loading-page"><span class="spinner"></span></div>';
    content.innerHTML = loading;
    if (!OF._views[route.view] && route.file) {
      try { await import(`/assets/app/views/${route.file}.js`); }
      catch (e) {
        if (seq !== routeSeq) return;
        content.innerHTML = `<div class="empty"><div class="ic">${OF.icon('bell', 22)}</div><p>Couldn't load this page.</p></div>`;
        return;
      }
    }
    if (seq !== routeSeq) return; // superseded by a newer navigation
    const cfg = OF._views[route.view];
    if (!cfg) { content.innerHTML = '<div class="empty"><p>View not found.</p></div>'; return; }
    document.getElementById('pageTitle').textContent = cfg.title || '';
    document.getElementById('pageSub').textContent = cfg.subtitle || '';
    document.title = (cfg.title ? cfg.title + ' · ' : '') + (OF.tenant?.name || 'OARFlow');
    window.scrollTo(0, 0);
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('scrim')?.setAttribute('hidden', '');
    const viewRoot = document.createElement('div');
    viewRoot.className = 'view-root';
    viewRoot.innerHTML = loading;
    content.replaceChildren(viewRoot);
    try {
      await cfg.render(viewRoot, { session: OF.session, tenant: OF.tenant, setActions: OF.setActions });
      if (seq !== routeSeq) { viewRoot.remove(); return; }
      if (viewRoot.parentNode !== content) content.replaceChildren(viewRoot);
    } catch (err) {
      if (seq !== routeSeq) { viewRoot.remove(); return; }
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
    const cachedShell = cached && cached.tenant ? shellSignature(cached.session, cached.tenant) : null;
    OF.session = s.user; OF.tenant = s.tenant;
    const counts = (cached && cached.counts) || {};
    writeCache({ session: s.user, tenant: s.tenant, counts });
    if (!(cached && cached.tenant) || cachedShell !== shellSignature(s.user, s.tenant)) { root.innerHTML = renderShell(active, counts); bindShell(); }
    OF.refreshCounts();
    document.addEventListener('click', onDocClick);
    window.addEventListener('popstate', renderRoute);
    await renderRoute();
  };

  window.OF = OF;
})();
