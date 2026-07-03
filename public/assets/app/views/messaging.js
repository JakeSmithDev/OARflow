// SPA view: two-way SMS inbox. Conversation list + thread + composer.
const OF = window.OF;
let active = null;

function bubble(m) {
  const out = m.direction === 'outbound';
  const sup = m.status === 'suppressed' || m.status === 'failed';
  return `<div style="display:flex;justify-content:${out ? 'flex-end' : 'flex-start'};margin-bottom:8px">
    <div style="max-width:74%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.4;${out ? 'background:var(--brand);color:#fff;border-bottom-right-radius:4px' : 'background:var(--surface-2);color:var(--ink);border-bottom-left-radius:4px'}">
      ${OF.escape(m.body || '')}
      <div style="font-size:10px;opacity:.7;margin-top:3px">${OF.time(m.created_at)}${sup ? ' · ' + OF.escape(m.status) : ''}</div>
    </div></div>`;
}

async function openThread(host, id) {
  active = id;
  const d = await OF.get('/api/admin/messaging/conversations/' + id);
  host.querySelectorAll('[data-convo]').forEach((el) => el.classList.toggle('active', el.dataset.convo == id));
  const pane = host.querySelector('#thread');
  pane.innerHTML = `
    <div class="card-head"><h3>${OF.escape(d.conversation.customer_name || d.conversation.phone_e164)}</h3><span class="muted small" style="margin-left:auto">${OF.escape(d.conversation.phone_e164)}</span></div>
    <div id="msgs" style="flex:1;overflow:auto;padding:16px"></div>
    <div style="padding:12px;border-top:1px solid var(--line-2);display:flex;gap:8px">
      <input id="composer" placeholder="Type a message…" style="flex:1">
      <button class="btn btn-primary" id="sendMsg">${OF.icon('send', 15)}</button>
    </div>`;
  const msgs = pane.querySelector('#msgs');
  msgs.innerHTML = d.messages.map(bubble).join('') || '<p class="muted small center">No messages yet.</p>';
  msgs.scrollTop = msgs.scrollHeight;
  const comp = pane.querySelector('#composer');
  const sendBtn = pane.querySelector('#sendMsg');
  const send = async () => {
    if (comp.disabled) return;
    const body = comp.value.trim(); if (!body) return;
    comp.disabled = true; sendBtn.disabled = true;
    try { await OF.post('/api/admin/messaging/send', { conversationId: id, body }); await openThread(host, id); }
    catch (e) { OF.toast(e.message, 'error'); comp.disabled = false; sendBtn.disabled = false; comp.focus(); }
  };
  sendBtn.onclick = send;
  comp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  comp.focus();
}

async function load(host) {
  const d = await OF.get('/api/admin/messaging/conversations');
  const list = host.querySelector('#convos');
  list.innerHTML = d.conversations.length ? d.conversations.map((c) => `
    <div class="convo-item ${c.id == active ? 'active' : ''}" data-convo="${c.id}" style="padding:12px 14px;border-bottom:1px solid var(--line-2);cursor:pointer">
      <div class="row between"><span class="cell-strong">${OF.escape(c.customer_name || c.phone_e164)}</span>${c.unread_count ? `<span class="badge danger no-dot">${c.unread_count}</span>` : `<span class="tiny muted">${c.last_message_at ? OF.date(c.last_message_at) : ''}</span>`}</div>
      <div class="tiny muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.last_dir === 'outbound' ? 'You: ' : ''}${OF.escape(c.last_body || '')}</div>
    </div>`).join('') : `<div class="empty" style="padding:30px 16px"><p class="muted small">No conversations yet.</p></div>`;
  list.querySelectorAll('[data-convo]').forEach((el) => el.onclick = () => openThread(host, el.dataset.convo));
  if (!d.configured) host.querySelector('#smsnote').style.display = '';
}

OF.page({
  active: 'messaging', title: 'Messages', subtitle: 'Two-way text messaging',
  render: async (root, ctx) => {
    ctx.setActions(`<button class="btn btn-primary btn-sm" id="newMsg">${OF.icon('plus', 15)} New message</button>`);
    root.innerHTML = `
      <div id="smsnote" style="display:none;margin-bottom:14px" class="card card-pad small muted">Texting isn't connected yet — messages are logged to the console in dev. Connect Twilio in <a href="/admin/settings">Settings → Integrations</a> to send for real.</div>
      <div class="card" style="display:grid;grid-template-columns:320px 1fr;min-height:560px;overflow:hidden">
        <div style="border-right:1px solid var(--line-2);overflow:auto" id="convos"></div>
        <div id="thread" style="display:flex;flex-direction:column"><div class="empty" style="margin:auto"><div class="ic">${OF.icon('messaging', 22)}</div><p class="muted">Select a conversation.</p></div></div>
      </div>`;
    document.getElementById('newMsg').onclick = () => {
      const m = OF.modal(`<div class="modal-head"><h3>New message</h3><button class="x" data-close>&times;</button></div>
        <div class="modal-body"><div class="field"><label>To (phone)</label><input id="nm_to" placeholder="+1 555 123 4567"></div><div class="field"><label>Message</label><textarea id="nm_body"></textarea></div></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="nm_send">Send</button></div>`);
      m.q('#nm_send').onclick = async () => {
        if (!m.q('#nm_to').value.trim() || !m.q('#nm_body').value.trim()) return OF.toast('Phone and message required', 'error');
        try { await OF.post('/api/admin/messaging/send', { to: m.q('#nm_to').value.trim(), body: m.q('#nm_body').value.trim() }); m.close(); OF.toast('Sent', 'ok'); load(root); }
        catch (e) { OF.toast(e.message, 'error'); }
      };
    };
    await load(root);
  },
});
