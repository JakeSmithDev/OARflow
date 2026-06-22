// Auto-generated SPA view module. Registers itself via OF.page() on import.
const OF = window.OF;

    let DATA = null; let tab = 'queue'; let qStatus = 'pending';

    async function load() { DATA = await OF.get('/api/admin/follow-ups?status='+qStatus); }

    function renderQueue(root) {
      const f = DATA.followUps;
      const now = Date.now();
      root.querySelector('#tabbody').innerHTML = `
        <div class="row between" style="margin-bottom:14px">
          <div class="row" style="gap:8px">${['pending','done','all'].map(s=>`<button class="chip ${qStatus===s?'active':''}" data-st="${s}">${s[0].toUpperCase()+s.slice(1)}${DATA.counts[s]!=null&&s!=='all'?` <span class="n">${DATA.counts[s]||0}</span>`:''}</button>`).join('')}</div>
          <button class="btn btn-secondary btn-sm" id="runDue">${OF.icon('send',15)} Send due emails now</button>
        </div>
        <div class="card">${f.length?`<div class="table-wrap"><table class="tbl"><thead><tr><th>Follow-up</th><th>Customer</th><th>Due</th><th>Type</th><th></th></tr></thead>
        <tbody>${f.map(x=>{const overdue=x.status==='pending'&&new Date(x.due_at).getTime()<now;return `<tr>
          <td class="cell-strong">${OF.escape(x.title)}${x.note?`<div class="tiny muted">${OF.escape(x.note)}</div>`:''}</td>
          <td>${OF.escape(x.customer_name||'—')}</td>
          <td><span class="${overdue?'badge danger no-dot':''}">${OF.dateLong(x.due_at)}</span></td>
          <td><span class="row" style="gap:6px">${x.channel==='email'?OF.icon('send',14)+' Email':OF.icon('check',14)+' Task'}</span></td>
          <td class="right">${x.status==='pending'?`<button class="link-btn" data-done="${x.id}">Complete</button> · <button class="link-btn" data-snooze="${x.id}">Snooze 7d</button>`:OF.statusBadge(x.status)}</td>
        </tr>`;}).join('')}</tbody></table></div>`:`<div class="empty"><div class="ic">${OF.icon('followups',22)}</div><p>Nothing here.</p></div>`}</div>`;
      root.querySelectorAll('[data-st]').forEach(b=>b.onclick=async()=>{qStatus=b.dataset.st;await load();renderQueue(root);});
      root.querySelector('#runDue').onclick=async()=>{const r=await OF.post('/api/admin/follow-ups/run-due');OF.toast(`Sent ${r.sent} follow-up email(s)`,'ok');await load();renderQueue(root);};
      root.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{await OF.patch('/api/admin/follow-ups/'+b.dataset.done,{status:'done'});OF.toast('Completed','ok');await load();renderQueue(root);});
      root.querySelectorAll('[data-snooze]').forEach(b=>b.onclick=async()=>{await OF.patch('/api/admin/follow-ups/'+b.dataset.snooze,{snoozeDays:7});OF.toast('Snoozed 7 days','ok');await load();renderQueue(root);});
    }

    function renderRules(root) {
      const rules = JSON.parse(JSON.stringify(DATA.rules||[]));
      const body = root.querySelector('#tabbody');
      function draw(){
        body.innerHTML = `<div class="card"><div class="card-head"><h3>Automations</h3><div class="actions"><button class="btn btn-secondary btn-sm" id="addRule">${OF.icon('plus',15)} Add rule</button></div></div>
          <div class="card-pad"><p class="muted small" style="margin-top:0">Follow-ups are created automatically when a job is marked completed. Email rules can auto-send; task rules appear in your queue.</p>
          <div id="rulesList"></div><button class="btn btn-primary" id="saveRules" style="margin-top:14px">Save automations</button></div></div>`;
        body.querySelector('#rulesList').innerHTML = rules.map((r,i)=>`<div class="card card-pad" style="margin-bottom:10px;background:var(--surface-2)"><div class="grid" style="grid-template-columns:1.4fr .8fr .8fr 1fr auto;gap:10px;align-items:end">
          <div class="field" style="margin:0"><label>Name</label><input class="r_name" data-i="${i}" value="${OF.escape(r.name)}"></div>
          <div class="field" style="margin:0"><label>After (days)</label><input class="r_off" data-i="${i}" type="number" min="0" value="${r.offsetDays}"></div>
          <div class="field" style="margin:0"><label>Channel</label><select class="r_ch" data-i="${i}"><option value="task" ${r.channel==='task'?'selected':''}>Task</option><option value="email" ${r.channel==='email'?'selected':''}>Email</option></select></div>
          <div class="field" style="margin:0"><label>Email template</label><input class="r_tpl" data-i="${i}" value="${OF.escape(r.templateType||'follow_up')}" ${r.channel==='email'?'':'disabled'}></div>
          <label class="switch" title="Active"><input type="checkbox" class="r_act" data-i="${i}" ${r.active?'checked':''}><span class="track"></span></label>
        </div><button class="link-btn r_del" data-i="${i}" style="color:var(--danger);margin-top:8px">Remove</button></div>`).join('') || '<p class="muted small">No rules yet.</p>';
        body.querySelectorAll('.r_name').forEach(el=>el.oninput=e=>rules[+e.target.dataset.i].name=e.target.value);
        body.querySelectorAll('.r_off').forEach(el=>el.oninput=e=>rules[+e.target.dataset.i].offsetDays=+e.target.value);
        body.querySelectorAll('.r_ch').forEach(el=>el.onchange=e=>{rules[+e.target.dataset.i].channel=e.target.value;draw();});
        body.querySelectorAll('.r_tpl').forEach(el=>el.oninput=e=>rules[+e.target.dataset.i].templateType=e.target.value);
        body.querySelectorAll('.r_act').forEach(el=>el.onchange=e=>rules[+e.target.dataset.i].active=e.target.checked);
        body.querySelectorAll('.r_del').forEach(el=>el.onclick=e=>{rules.splice(+e.target.dataset.i,1);draw();});
        body.querySelector('#addRule').onclick=()=>{rules.push({name:'New follow-up',offsetDays:7,channel:'task',templateType:null,active:true});draw();};
        body.querySelector('#saveRules').onclick=async()=>{await OF.put('/api/admin/follow-ups/rules',{rules});OF.toast('Automations saved','ok');};
      }
      draw();
    }

    function renderTabs(root){
      root.innerHTML = `<div class="tabbar"><button data-tab="queue" class="${tab==='queue'?'active':''}">Queue</button><button data-tab="rules" class="${tab==='rules'?'active':''}">Automations</button></div><div id="tabbody"></div>`;
      root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=async()=>{tab=b.dataset.tab;renderTabs(root);tab==='queue'?renderQueue(root):renderRules(root);});
      tab==='queue'?renderQueue(root):renderRules(root);
    }

    OF.page({ active:'followups', title:'Follow-ups', subtitle:'Stay in touch — and win repeat business', render: async (root, ctx) => {
      ctx.setActions(`<button class="btn btn-primary btn-sm" id="newFu">${OF.icon('plus',15)} New follow-up</button>`);
      await load(); renderTabs(root);
      document.getElementById('newFu').onclick=()=>{
        const m=OF.modal(`<div class="modal-head"><h3>New follow-up</h3><button class="x" data-close>&times;</button></div>
          <div class="modal-body"><div class="field"><label>Title *</label><input id="t"></div>
          <div class="field"><label>Customer (optional)</label><input id="cust" placeholder="Search…" autocomplete="off"><div id="res" class="card" style="display:none"></div></div>
          <div class="grid cols-2"><div class="field"><label>Due date *</label><input id="dd" type="date"></div><div class="field"><label>Channel</label><select id="ch"><option value="task">Task</option><option value="email">Email</option></select></div></div>
          <div class="field"><label>Note</label><textarea id="note"></textarea></div></div>
          <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="save">Create</button></div>`);
        let cid=null; const ci=m.q('#cust'),cr=m.q('#res');
        ci.addEventListener('input',OF.debounce(async()=>{const q=ci.value.trim();if(q.length<2){cr.style.display='none';return;}const d=await OF.get('/api/admin/customers?q='+encodeURIComponent(q));cr.innerHTML=d.customers.slice(0,5).map(c=>`<div class="card-pad" style="padding:8px 12px;cursor:pointer" data-id="${c.id}" data-n="${OF.escape(c.name)}">${OF.escape(c.name)}</div>`).join('');cr.style.display='block';cr.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{cid=+x.dataset.id;ci.value=x.dataset.n;cr.style.display='none';});},250));
        m.q('#save').onclick=async()=>{if(!m.q('#t').value.trim()||!m.q('#dd').value)return OF.toast('Title and due date required','error');await OF.post('/api/admin/follow-ups',{title:m.q('#t').value.trim(),customerId:cid,dueDate:m.q('#dd').value,channel:m.q('#ch').value,note:m.q('#note').value.trim()});m.close();OF.toast('Follow-up created','ok');await load();renderTabs(document.getElementById('content'));};
      };
    }});
  