// Dedicated team management. Field reps come from the same technician records
// used by appointments and dispatch; admin users control back-office access.
const OF = window.OF;

let technicians = [];
let users = [];
let businessAddress = '';
const canManageAdminAccess = OF.session?.role === 'owner';

function field(label, inner, hint = '') {
  const id = inner.match(/\bid="([^"]+)"/)?.[1];
  const hintId = id && hint ? `${id}_hint` : '';
  const control = hintId && !/\baria-describedby=/.test(inner)
    ? inner.replace(`id="${id}"`, `id="${id}" aria-describedby="${hintId}"`)
    : inner;
  return `<div class="field"><label${id ? ` for="${id}"` : ''}>${label}</label>${control}${hint ? `<span class="hint"${hintId ? ` id="${hintId}"` : ''}>${hint}</span>` : ''}</div>`;
}

function card(title, description, body, actions = '') {
  return `<section class="card" style="margin-bottom:18px">
    <div class="card-head" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div style="min-width:200px;flex:1"><h3 style="margin:0">${title}</h3>${description ? `<p class="muted small" style="margin:4px 0 0">${description}</p>` : ''}</div>
      ${actions ? `<div class="actions" style="margin-left:auto">${actions}</div>` : ''}
    </div>
    <div class="card-pad">${body}</div>
  </section>`;
}

function linkedUser(technician) {
  return users.find((user) => String(user.id) === String(technician.user_id));
}

function startingPoint(technician) {
  if (technician.route_start_address) return technician.route_start_address;
  return businessAddress || 'Business address not set';
}

function renderTechnicians(root) {
  const rows = technicians.map((technician) => {
    const account = linkedUser(technician);
    const customStart = Boolean(technician.route_start_address);
    const hasPin = technician.route_start_lat != null && technician.route_start_lat !== '' && technician.route_start_lng != null && technician.route_start_lng !== ''
      && Number.isFinite(Number(technician.route_start_lat)) && Number.isFinite(Number(technician.route_start_lng));
    return `<div class="row wrap" style="gap:18px;align-items:center;padding:15px 0;border-bottom:1px solid var(--line-2)">
      <div class="row" style="gap:11px;min-width:210px;flex:1 1 220px">
        <span class="avatar-sm" style="background:${OF.color(technician.color)};color:#fff;flex:0 0 auto">${OF.initials(technician.name)}</span>
        <div style="min-width:0"><div class="cell-strong">${OF.escape(technician.name)}</div>
          <div class="tiny muted" style="overflow:hidden;text-overflow:ellipsis">${OF.escape([technician.email, technician.phone].filter(Boolean).join(' · ') || 'No contact information')}</div>
          ${canManageAdminAccess ? `<div class="tiny muted">${account ? `Login: @${OF.escape(account.username)}` : 'No admin login linked'}</div>` : ''}
        </div>
      </div>
      <div class="row" style="align-items:flex-start;gap:8px;min-width:230px;flex:1.5 1 280px;color:var(--ink)">
        <span style="color:var(--brand);margin-top:1px;flex:0 0 auto">${OF.icon('pin',16)}</span>
        <div style="min-width:0"><div class="tiny muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.04em">${customStart ? 'Custom starting point' : 'Business starting point'}</div>
          <div class="small" style="overflow-wrap:anywhere">${OF.escape(startingPoint(technician))}</div>
          ${hasPin ? '<span class="badge ok no-dot" style="margin-top:5px">Map pin ready</span>' : '<span class="tiny muted">Coordinates update when routes are planned</span>'}
        </div>
      </div>
      <div class="row wrap" style="gap:7px;justify-content:flex-end;margin-left:auto">
        ${technician.is_active ? '' : '<span class="badge neutral no-dot">Inactive</span>'}
        <button class="btn btn-secondary btn-sm" type="button" data-edit-rep="${technician.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" type="button" data-toggle-rep="${technician.id}" data-active="${technician.is_active}">${technician.is_active ? 'Deactivate' : 'Activate'}</button>
      </div>
    </div>`;
  }).join('');

  const body = rows || `<div class="empty" style="padding:28px 12px"><div class="ic">${OF.icon('team',22)}</div><h3>No reps yet</h3><p>Add your first rep to schedule appointments and build routes.</p><button class="btn btn-primary btn-sm" id="emptyAddRep" type="button">${OF.icon('plus',15)} Add rep</button></div>`;
  root.querySelector('#repCard').innerHTML = card(
    'Field reps & technicians',
    'Everyone shown here is available to appointments and the dispatch route planner.',
    body,
    `<button class="btn btn-primary btn-sm" id="addRep" type="button">${OF.icon('plus',15)} Add rep</button>`,
  );

  root.querySelector('#addRep')?.addEventListener('click', () => openRepEditor(root));
  root.querySelector('#emptyAddRep')?.addEventListener('click', () => openRepEditor(root));
  root.querySelectorAll('[data-edit-rep]').forEach((button) => button.addEventListener('click', () => {
    openRepEditor(root, technicians.find((item) => String(item.id) === button.dataset.editRep));
  }));
  root.querySelectorAll('[data-toggle-rep]').forEach((button) => button.addEventListener('click', async () => {
    const technician = technicians.find((item) => String(item.id) === button.dataset.toggleRep);
    if (!technician) return;
    const activating = button.dataset.active !== 'true';
    if (!activating && !(await OF.confirm({
      title: `Deactivate ${technician.name}?`,
      body: '<p class="muted">They will no longer appear as an available rep for new assignments. Existing appointments remain unchanged.</p>',
      confirmText: 'Deactivate',
      danger: true,
    }))) return;
    try {
      await OF.patch(`/api/admin/technicians/${technician.id}`, { isActive: activating });
      OF.toast(activating ? 'Rep activated' : 'Rep deactivated', 'ok');
      await reload(root);
    } catch (error) { OF.toast(error.message, 'error'); }
  }));
}

function openRepEditor(root, technician = null) {
  const usingCustomStart = Boolean(technician?.route_start_address);
  const accountOptions = users.map((user) => `<option value="${user.id}" ${String(technician?.user_id || '') === String(user.id) ? 'selected' : ''}>${OF.escape(user.display_name || user.username)} (@${OF.escape(user.username)})</option>`).join('');
  const accountField = canManageAdminAccess
    ? field('Admin login (optional)', `<select id="repUser"><option value="">No linked login</option>${accountOptions}</select>`, 'Linking is optional. Rep scheduling and login access are managed separately.')
    : '';
  const modal = OF.modal(`<div class="modal-head"><h3>${technician ? 'Edit rep' : 'Add rep'}</h3><button class="x" data-close aria-label="Close">&times;</button></div>
    <div class="modal-body">
      ${field('Name *', `<input id="repName" autocomplete="name" value="${OF.escape(technician?.name || '')}">`)}
      <div class="grid cols-2">
        ${field('Email', `<input id="repEmail" type="email" autocomplete="email" value="${OF.escape(technician?.email || '')}">`)}
        ${field('Phone', `<input id="repPhone" type="tel" autocomplete="tel" value="${OF.escape(technician?.phone || '')}">`)}
      </div>
      <div class="grid cols-2">
        ${field('Route color', `<input id="repColor" type="color" value="${OF.color(technician?.color || '#2563eb')}" style="height:42px;padding:4px">`)}
        ${accountField}
      </div>
      <div style="border-top:1px solid var(--line-2);margin:4px 0 16px"></div>
      ${field('Route starting point', `<select id="repStartMode"><option value="business" ${usingCustomStart ? '' : 'selected'}>Use business address</option><option value="custom" ${usingCustomStart ? 'selected' : ''}>Use a custom address</option></select>`, 'Dispatch estimates begin here for this rep. Their first appointment is still scheduled normally.')}
      <div id="customStartWrap" ${usingCustomStart ? '' : 'hidden'}>
        ${field('Custom start address *', `<input id="repStartAddress" autocomplete="street-address" value="${OF.escape(technician?.route_start_address || '')}" placeholder="Street, city, state, ZIP">`, 'For example, the rep’s home, storage unit, or assigned territory hub.')}
      </div>
      <div id="businessStartNote" class="row" style="gap:9px;padding:10px 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface-2);${usingCustomStart ? 'display:none' : ''}">
        <span style="color:var(--brand)">${OF.icon('pin',16)}</span><div class="small"><b>Business address</b><div class="muted">${OF.escape(businessAddress || 'Not set — add it in Settings → Business.')}</div></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" data-close type="button">Cancel</button><button class="btn btn-primary" id="saveRep" type="button">${technician ? 'Save changes' : 'Add rep'}</button></div>`, { wide: true });

  const mode = modal.q('#repStartMode');
  mode.addEventListener('change', () => {
    const custom = mode.value === 'custom';
    modal.q('#customStartWrap').hidden = !custom;
    modal.q('#businessStartNote').style.display = custom ? 'none' : '';
    if (custom) modal.q('#repStartAddress').focus();
  });
  modal.q('#saveRep').addEventListener('click', async () => {
    const name = modal.q('#repName').value.trim();
    const routeStartAddress = mode.value === 'custom' ? modal.q('#repStartAddress').value.trim() : '';
    if (!name) { modal.q('#repName').focus(); return OF.toast('Rep name is required.', 'error'); }
    if (mode.value === 'custom' && !routeStartAddress) { modal.q('#repStartAddress').focus(); return OF.toast('Enter the custom starting address.', 'error'); }
    const payload = {
      name,
      email: modal.q('#repEmail').value.trim(),
      phone: modal.q('#repPhone').value.trim(),
      color: modal.q('#repColor').value,
      routeStartAddress,
    };
    if (canManageAdminAccess) payload.userId = modal.q('#repUser').value ? Number(modal.q('#repUser').value) : null;
    const save = modal.q('#saveRep');
    save.disabled = true;
    try {
      if (technician) await OF.patch(`/api/admin/technicians/${technician.id}`, payload);
      else await OF.post('/api/admin/technicians', payload);
      modal.close();
      OF.toast(technician ? 'Rep updated' : 'Rep added', 'ok');
      await reload(root);
    } catch (error) { OF.toast(error.message, 'error'); save.disabled = false; }
  });
  modal.q('#repName').focus();
}

function renderUsers(root) {
  const rows = users.map((user) => `<div class="row between" style="gap:14px;padding:12px 0;border-bottom:1px solid var(--line-2)">
    <div class="row" style="gap:10px;min-width:0"><span class="avatar-sm">${OF.initials(user.display_name || user.username)}</span><div style="min-width:0"><span class="cell-strong">${OF.escape(user.display_name || user.username)}</span> ${user.is_active ? '' : '<span class="badge neutral no-dot">Inactive</span>'}${user.is_totp_enabled ? '<span class="badge ok no-dot">2FA</span>' : ''}<div class="tiny muted">@${OF.escape(user.username)} · ${OF.escape(user.role)}</div></div></div>
    <div class="row" style="gap:6px">${String(user.id) === String(OF.session.userId)
      ? `<button class="btn btn-secondary btn-sm" id="totpBtn" type="button">${user.is_totp_enabled ? 'Manage 2FA' : 'Enable 2FA'}</button>`
      : `<button class="btn btn-ghost btn-sm" data-toggle-user="${user.id}" data-active="${user.is_active}" type="button">${user.is_active ? 'Deactivate' : 'Activate'}</button>`}</div>
  </div>`).join('');
  root.querySelector('#accessCard').innerHTML = card(
    'Admin access',
    'Login accounts for the OARFlow office. A field rep does not need an admin login.',
    rows || '<p class="muted small">No admin users.</p>',
    `<button class="btn btn-secondary btn-sm" id="addUser" type="button">${OF.icon('plus',15)} Add login</button>`,
  );
  root.querySelector('#addUser').addEventListener('click', () => openUserEditor(root));
  root.querySelectorAll('[data-toggle-user]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await OF.patch(`/api/admin/settings/users/${button.dataset.toggleUser}`, { isActive: button.dataset.active !== 'true' });
      OF.toast('Login access updated', 'ok');
      await reload(root);
    } catch (error) { OF.toast(error.message, 'error'); }
  }));
  root.querySelector('#totpBtn')?.addEventListener('click', () => totpFlow(root));
}

function openUserEditor(root) {
  const modal = OF.modal(`<div class="modal-head"><h3>Add admin login</h3><button class="x" data-close aria-label="Close">&times;</button></div>
    <div class="modal-body">
      ${field('Display name', '<input id="userName" autocomplete="name">')}
      ${field('Username *', '<input id="userUsername" autocomplete="username">')}
      ${field('Temporary password *', '<input id="userPassword" type="text" autocomplete="new-password">', 'Share this securely and ask the user to change it after signing in.')}
      ${field('Role', '<select id="userRole"><option value="staff">Office staff</option><option value="manager">Manager</option><option value="tech">Technician</option><option value="owner">Owner</option></select>')}
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" data-close type="button">Cancel</button><button class="btn btn-primary" id="saveUser" type="button">Add login</button></div>`);
  modal.q('#saveUser').addEventListener('click', async () => {
    const username = modal.q('#userUsername').value.trim();
    const password = modal.q('#userPassword').value;
    if (!username || !password) return OF.toast('Username and temporary password are required.', 'error');
    const button = modal.q('#saveUser'); button.disabled = true;
    try {
      await OF.post('/api/admin/settings/users', { displayName: modal.q('#userName').value.trim(), username, password, role: modal.q('#userRole').value });
      modal.close(); OF.toast('Admin login added', 'ok'); await reload(root);
    } catch (error) { OF.toast(error.message, 'error'); button.disabled = false; }
  });
  modal.q('#userName').focus();
}

async function totpFlow(root) {
  const me = users.find((user) => String(user.id) === String(OF.session.userId));
  if (!me) return;
  if (me.is_totp_enabled) {
    if (await OF.confirm({ title:'Disable 2FA?', danger:true, confirmText:'Disable' })) {
      await OF.post('/api/admin/auth/totp/disable'); OF.toast('2FA disabled', 'ok'); await reload(root);
    }
    return;
  }
  const start = await OF.post('/api/admin/auth/totp/start');
  const modal = OF.modal(`<div class="modal-head"><h3>Enable two-factor auth</h3><button class="x" data-close aria-label="Close">&times;</button></div><div class="modal-body center"><p class="muted small">Scan with Google Authenticator, 1Password, or Authy, then enter the 6-digit code.</p><img src="${start.qr}" alt="Two-factor setup QR code" style="width:180px;height:180px;margin:10px auto"><div class="tiny muted" style="word-break:break-all">${OF.escape(start.secret)}</div>${field('Code', '<input id="totpCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" style="text-align:center;font-size:20px;letter-spacing:4px">')}</div><div class="modal-foot"><button class="btn btn-secondary" data-close type="button">Cancel</button><button class="btn btn-primary" id="verifyTotp" type="button">Verify & enable</button></div>`);
  modal.q('#verifyTotp').addEventListener('click', async () => {
    try { await OF.post('/api/admin/auth/totp/enable', { code:modal.q('#totpCode').value }); modal.close(); OF.toast('2FA enabled ✓', 'ok'); await reload(root); }
    catch (error) { OF.toast(error.message, 'error'); }
  });
}

async function reload(root) {
  const [technicianData, userData] = await Promise.all([
    OF.get('/api/admin/technicians?all=1&origins=1'),
    canManageAdminAccess ? OF.get('/api/admin/settings/users') : Promise.resolve({ users: [] }),
  ]);
  technicians = technicianData.technicians || [];
  users = userData.users || [];
  businessAddress = technicianData.businessAddress || '';
  renderTechnicians(root);
  if (canManageAdminAccess) renderUsers(root);
  else root.querySelector('#accessCard')?.remove();
}

OF.page({
  active: 'team',
  title: 'Manage Team',
  subtitle: canManageAdminAccess ? 'Reps, route starting points, and account access' : 'Field reps and route starting points',
  render: async (root, ctx) => {
    ctx.setActions(`<button class="btn btn-primary btn-sm" id="topAddRep" type="button">${OF.icon('plus',15)} Add rep</button>`);
    root.innerHTML = `<div id="repCard"><div class="loading-page"><span class="spinner"></span></div></div><div id="accessCard"></div>`;
    document.getElementById('topAddRep')?.addEventListener('click', () => openRepEditor(root));
    await reload(root);
  },
});
