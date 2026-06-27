// karmax — operations console for autonomous agents.
// A dispatch board: tasks advance along the stage pipeline; the operator acts at
// the decision points. Talks only to the gateway (SPEC §3.4).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  token: null,
  meta: null,
  contributions: null,
  projects: [],
  projectId: null,
  tasks: [],
  tab: 'tasks',
  selected: null, // taskId
  view: null, // selected task view
  drawerEvents: [],
  drawerSeq: 0,
  activity: [],
  search: '',
  ws: null,
};

const WORKFLOWS = [
  { id: 'software-dev', label: 'Software dev' },
  { id: 'goal', label: 'Goal (auto-run)' },
  { id: 'just-do', label: 'Just do' },
  { id: 'script-exec', label: 'Script' },
];

const NODES = [
  { key: 'setup', label: 'Setup' },
  { key: 'do', label: 'Do' },
  { key: 'review', label: 'Review' },
  { key: 'pr', label: 'PR' },
  { key: 'merge', label: 'Merge', ponr: true },
  { key: 'done', label: 'End' },
];
const STAGE_INDEX = { setup: 0, do: 1, resolve: 1, review: 2, pr: 3, merge: 4, escalated: 4, done: 5, cancelled: 5, failed: 5 };

// ── api ──────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    S.token = null;
    renderLogin();
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const session = await (await fetch('/api/session')).json();
  if (session.authRequired && !session.token) return renderLogin();
  S.token = session.token;
  S.meta = await api('/api/meta');
  try {
    S.contributions = await api('/api/contributions');
  } catch {}
  await loadProjects();
  connectWs();
  renderShell();
  bindKeys();
}

async function loadProjects() {
  S.projects = await api('/api/projects');
  if (!S.projectId && S.projects[0]) S.projectId = S.projects[0].id;
}

async function loadTasks() {
  if (!S.projectId) return;
  S.tasks = await api(`/api/projects/${S.projectId}/tasks`);
}

// ── websocket live stream ──────────────────────────────────────────────────
let refreshTimer = null;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    S.activity.unshift(ev);
    if (S.activity.length > 400) S.activity.pop();
    if (S.tab === 'activity') renderMain();
    if (S.selected && ev.taskId === S.selected) {
      S.drawerEvents.push(ev);
      if (ev.type === 'view.updated' || ev.type.includes('stage') || ev.type === 'merge.result') refreshDrawer();
      else renderDrawerEvents();
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (S.tab === 'tasks' || S.tab === 'queue') refreshTasks(); }, 350);
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

async function refreshTasks() {
  try { await loadTasks(); if (S.tab === 'tasks' || S.tab === 'queue') renderMain(); renderRail(); } catch {}
}

// ── shell ────────────────────────────────────────────────────────────────────
function renderShell() {
  const app = $('#app');
  const agent = S.meta?.agent || {};
  const isMock = agent.provider === 'mock';
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="mark">◇</span> karmax</div>
      <div class="search"><span>⌕</span><input id="search" placeholder="Search tasks…  ( / )" /></div>
      <div class="spacer"></div>
      <div class="agent-chip ${isMock ? 'mock' : ''}" title="${esc(agent.reason || '')}">
        <span class="dot"></span> ${esc(agent.provider || 'agent')}
      </div>
      <button class="icon-btn has-badge" id="bell" title="Needs attention">🔔<span class="badge hidden" id="bell-badge">0</span></button>
      <button class="icon-btn" id="theme" title="Toggle theme">◐</button>
    </div>
    <div class="body">
      <div class="rail" id="rail"></div>
      <div class="main"><div class="main-inner" id="main"></div></div>
    </div>`;
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; if (S.tab === 'tasks') renderMain(); });
  $('#theme').addEventListener('click', toggleTheme);
  $('#bell').addEventListener('click', toggleNotifications);
  renderRail();
  renderMain();
  refreshTasks();
}

function renderRail() {
  const rail = $('#rail');
  if (!rail) return;
  rail.innerHTML = `
    <div class="label">Projects</div>
    ${S.projects
      .map(
        (p) => `<div class="proj ${p.id === S.projectId ? 'active' : ''}" data-id="${p.id}">
          <span class="glyph">◇</span> <span>${esc(p.name)}</span>
        </div>`,
      )
      .join('')}
    <div class="proj add" id="new-project"><span>+</span> <span>New project</span></div>
    <div class="grow"></div>
    <div class="nav-item ${S.tab === 'settings' ? 'active' : ''}" data-tab="settings">⚙ Settings</div>
    <div class="nav-item ${S.tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">▦ Dashboard</div>`;
  rail.querySelectorAll('.proj[data-id]').forEach((e) =>
    e.addEventListener('click', () => { S.projectId = e.dataset.id; S.tab = 'tasks'; refreshTasks(); renderRail(); renderMain(); }),
  );
  $('#new-project')?.addEventListener('click', newProject);
  rail.querySelectorAll('.nav-item[data-tab]').forEach((e) => e.addEventListener('click', () => switchTab(e.dataset.tab)));
}

function switchTab(tab) {
  S.tab = tab;
  renderRail();
  renderMain();
  if (tab === 'activity') seedActivity();
  if (tab === 'dashboard') renderDashboard();
}

// ── main content ───────────────────────────────────────────────────────────
function renderMain() {
  const main = $('#main');
  if (!main) return;
  const proj = S.projects.find((p) => p.id === S.projectId);
  const tabs = ['tasks', 'queue', 'activity', 'dashboard', 'settings'];
  const labels = { tasks: 'Tasks', queue: 'Merge queue', activity: 'Activity', dashboard: 'Dashboard', settings: 'Settings' };
  const tabbar = `<div class="tabs">${tabs
    .map((t) => `<div class="tab ${S.tab === t ? 'active' : ''}" data-tab="${t}">${labels[t]}${t === 'tasks' && S.tasks.length ? `<span class="pill">${S.tasks.length}</span>` : ''}</div>`)
    .join('')}</div>`;

  let content = '';
  if (S.tab === 'tasks') content = tasksView();
  else if (S.tab === 'queue') content = queueView();
  else if (S.tab === 'activity') content = activityView();
  else if (S.tab === 'dashboard') content = `<div id="dash">Loading…</div>`;
  else if (S.tab === 'settings') content = settingsView(proj);

  main.innerHTML = tabbar + content;
  main.querySelectorAll('.tab[data-tab]').forEach((e) => e.addEventListener('click', () => switchTab(e.dataset.tab)));
  if (S.tab === 'tasks') wireTasksView();
  if (S.tab === 'queue') wireQueueView();
  if (S.tab === 'settings') wireSettingsView(proj);
  if (S.tab === 'dashboard') renderDashboard();
  updateBell();
}

// ── tasks ────────────────────────────────────────────────────────────────────
function tasksView() {
  const filtered = S.tasks.filter((t) => !S.search || t.title.toLowerCase().includes(S.search.toLowerCase()));
  const rows = filtered
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(taskRow)
    .join('');
  return `
    <div class="composer">
      <input class="title-in" id="new-task" placeholder="Describe a task and press Enter…  ( n )" />
      <select id="new-wf">${WORKFLOWS.map((w) => `<option value="${w.id}">${w.label}</option>`).join('')}</select>
      <button class="btn primary" id="add-task">Add</button>
    </div>
    ${rows || `<div class="empty"><div class="big">No tasks yet</div>Describe a task above — an agent will pick it up.</div>`}`;
}

function taskRow(t) {
  const v = t.lastView || {};
  const status = v.status || 'active';
  const stage = v.stage || 'setup';
  return `
    <div class="task-row" data-id="${t.id}">
      <span class="status-dot ${status}" title="${esc(status)}"></span>
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-sub">
          <span class="wf">${esc(t.workflow)}</span>
          ${v.branch ? `<span class="branch">${esc(v.branch)}</span>` : ''}
          <span class="chip ${status}">${esc(stage)}</span>
        </div>
      </div>
      <div class="task-right">${pipeline(v)}</div>
    </div>`;
}

function pipeline(v) {
  const idx = STAGE_INDEX[v.stage] ?? 0;
  const done = v.stage === 'done';
  const merged = v.pointOfNoReturnPassed || done;
  let segs = '';
  for (let i = 0; i < NODES.length - 1; i++) {
    const n = NODES[i];
    let cls = 'seg';
    if (i < idx) cls += ' done';
    if (i === idx && !done) cls += ' current ' + (v.status === 'active' ? 'working' : v.status || '');
    if (merged && i >= 4) cls += ' merged';
    if (n.ponr) {
      segs += `<span class="ponr ${merged ? 'passed' : i === idx ? 'current' : ''}" title="point of no return"></span>`;
    }
    segs += `<span class="${cls}"></span>`;
  }
  return `<div class="pipeline" title="${esc(v.stage || '')}">${segs}</div>`;
}

function pipelineLarge(v) {
  const idx = STAGE_INDEX[v.stage] ?? 0;
  const done = v.stage === 'done';
  const merged = v.pointOfNoReturnPassed || done;
  return `<div class="pipeline-lg">${NODES.map((n, i) => {
    let cls = 'node';
    if (i < idx || (done && i <= idx)) cls += ' done';
    if (i === idx && !done) cls += ' current';
    if (merged && n.key === 'merge') cls += ' merged';
    if (done && n.key === 'done') cls += ' merged';
    return `<div class="${cls}"><div class="bar"></div><div class="name">${n.ponr ? '◆ ' : ''}${n.label}</div></div>`;
  }).join('')}</div>`;
}

function wireTasksView() {
  $('#main').querySelectorAll('.task-row').forEach((e) => e.addEventListener('click', () => openDrawer(e.dataset.id)));
  const add = async () => {
    const input = $('#new-task');
    const title = input.value.trim();
    if (!title) return;
    const workflow = $('#new-wf').value;
    input.value = '';
    try {
      await api(`/api/projects/${S.projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: firstLine(title), prompt: title, command: workflow === 'script-exec' ? title : undefined, workflow }),
      });
      toast('Task created');
      await refreshTasks();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#add-task')?.addEventListener('click', add);
  $('#new-task')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
}
const firstLine = (s) => s.split('\n')[0].slice(0, 80);

// ── drawer ───────────────────────────────────────────────────────────────────
async function openDrawer(taskId) {
  S.selected = taskId;
  S.drawerEvents = [];
  highlightRow();
  try {
    S.view = await api(`/api/tasks/${taskId}`);
    S.drawerEvents = await api(`/api/tasks/${taskId}/events?since=0`);
  } catch (e) { toast(e.message, true); }
  renderDrawer();
}
async function refreshDrawer() {
  if (!S.selected) return;
  try { S.view = await api(`/api/tasks/${S.selected}`); } catch {}
  renderDrawer();
}
function closeDrawer() {
  S.selected = null;
  S.view = null;
  if (termWs) { try { termWs.close(); } catch {} termWs = null; }
  $('#drawer-root').innerHTML = '';
  highlightRow();
}
function highlightRow() {
  document.querySelectorAll('.task-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === S.selected));
}

function renderDrawer() {
  const v = S.view;
  if (!v) return;
  const root = $('#drawer-root');
  root.innerHTML = `
    <div class="scrim open" id="scrim"></div>
    <aside class="drawer open">
      <div class="drawer-head">
        <div class="row1">
          <h2>${esc(v.title)}</h2>
          <span class="chip ${v.status}">${esc(v.stage)}</span>
          <button class="icon-btn" id="drawer-close" title="Close (Esc)">✕</button>
        </div>
        <div class="meta">
          <span>${esc(v.workflow)}</span>
          ${v.branch ? `<span>⎇ ${esc(v.branch)}</span>` : ''}
          ${v.targetBranch ? `<span>→ ${esc(v.targetBranch)}</span>` : ''}
          ${v.mergeQueue ? `<span>queue #${v.mergeQueue.position}/${v.mergeQueue.total}</span>` : ''}
        </div>
      </div>
      <div class="drawer-body" id="drawer-body">${drawerBody(v)}</div>
      <div class="drawer-foot" id="drawer-foot">${drawerActions(v)}</div>
    </aside>`;
  $('#scrim').addEventListener('click', closeDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  wireActions(v);
  wireTerminal(v.taskId);
  renderDrawerEvents();
}

let termWs = null;
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}
function wireTerminal(taskId) {
  const btn = document.getElementById('term-open');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const out = document.getElementById('term-out');
    const inp = document.getElementById('term-in');
    out.classList.remove('hidden');
    inp.classList.remove('hidden');
    inp.focus();
    if (termWs) { try { termWs.close(); } catch {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?taskId=${encodeURIComponent(taskId)}`);
    termWs = ws;
    ws.onmessage = (m) => {
      try { const msg = JSON.parse(m.data); if (msg.type === 'data') { out.textContent += stripAnsi(msg.data); out.scrollTop = out.scrollHeight; } } catch {}
    };
    ws.onclose = () => { out.textContent += '\n[terminal closed]\n'; };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { ws.send(JSON.stringify({ type: 'input', data: inp.value + '\r' })); inp.value = ''; }
    };
  });
}

function drawerBody(v) {
  const msgs = (v.messages || [])
    .map((m) => `<div class="msg ${m.role}"><div class="role">${m.role}</div>${esc(m.text)}</div>`)
    .join('');
  const review = v.reviewInfo
    ? `<div class="section-h">Review</div>
       <div class="review">
         ${v.reviewInfo.summary ? `<div class="summary">${esc(v.reviewInfo.summary)}</div>` : ''}
         ${v.reviewInfo.links?.length ? `<div class="links">${v.reviewInfo.links.map((l) => `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>` : ''}
         ${v.reviewInfo.diff ? `<div class="diff">${renderDiff(v.reviewInfo.diff)}</div>` : ''}
         ${v.reviewInfo.html ? `<iframe sandbox="allow-scripts" srcdoc="${esc(v.reviewInfo.html)}"></iframe>` : ''}
       </div>`
    : '';
  const error = v.error ? `<div class="section-h">Error</div><div class="diff del">${esc(v.error)}</div>` : '';
  const subtasks = v.subTasks?.length
    ? `<div class="section-h">Sub-tasks</div>${v.subTasks.map((id) => `<div class="task-sub"><span class="branch" data-open="${id}" style="cursor:pointer">↳ ${esc(id)}</span></div>`).join('')}`
    : '';
  return `
    <div class="section-h">Pipeline</div>
    ${pipelineLarge(v)}
    ${error}
    ${review}
    ${subtasks}
    <div class="section-h">Conversation</div>
    <div class="thread">${msgs || '<div class="msg system">No messages yet</div>'}</div>
    <details class="advanced">
      <summary>Advanced — terminal, live event log, structured state</summary>
      <div class="section-h">Terminal — open a shell in the world (ephemeral)</div>
      <button class="btn sm" id="term-open" ${v.worldPath ? '' : 'disabled'}>${v.worldPath ? 'Open terminal' : 'No world yet'}</button>
      <pre class="raw hidden" id="term-out" style="height:200px"></pre>
      <input id="term-in" class="title-in hidden" style="width:100%;margin-top:6px;padding:8px 10px" placeholder="command + Enter" />
      <div class="section-h">Live events</div>
      <div class="events" id="drawer-events"></div>
      <div class="section-h">Structured state (the view-model floor)</div>
      <pre class="raw">${esc(JSON.stringify({ stage: v.stage, status: v.status, state: v.state, worldPath: v.worldPath, pr: v.pr }, null, 2))}</pre>
    </details>`;
}

function renderDiff(d) {
  return esc(d)
    .split('\n')
    .map((l) => (l.startsWith('+') ? `<span class="add">${l}</span>` : l.startsWith('-') ? `<span class="del">${l}</span>` : l))
    .join('\n');
}

// the generic auto-render floor (SPEC §10.2 tier 1): render declared actions
function drawerActions(v) {
  const acts = v.actions || [];
  const followUp = acts.find((a) => a.name === 'followUp');
  const setTarget = acts.find((a) => a.name === 'setTarget');
  const simple = acts.filter((a) => !a.args || a.args.length === 0);
  let html = `<div class="actions">`;
  for (const a of simple) {
    const cls = a.name === 'confirm' ? 'primary' : a.danger ? 'danger' : '';
    html += `<button class="btn ${cls}" data-act="${a.name}" ${a.enabled ? '' : 'disabled'}>${esc(a.label)}</button>`;
  }
  if (setTarget) {
    html += `<input id="target-in" class="title-in" style="max-width:160px;padding:8px 10px" placeholder="branch" value="${esc(v.targetBranch || '')}" ${setTarget.enabled ? '' : 'disabled'} />
             <button class="btn sm" data-act="setTarget" ${setTarget.enabled ? '' : 'disabled'}>Set target</button>`;
  }
  html += `</div>`;
  if (followUp) {
    html += `<div class="followup-box">
      <textarea id="followup" placeholder="Send a follow-up to the agent…" ${followUp.enabled ? '' : 'disabled'}></textarea>
      <button class="btn primary" data-act="followUp" ${followUp.enabled ? '' : 'disabled'}>Send</button>
    </div>`;
  }
  if (!acts.length) html = `<div style="color:var(--ink-3)">No actions available — task is ${esc(v.stage)}.</div>`;
  return html;
}

function wireActions(v) {
  $('#drawer-foot').querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'followUp') {
          const text = $('#followup').value.trim();
          if (!text) return;
          await api(`/api/tasks/${v.taskId}/signal`, { method: 'POST', body: JSON.stringify({ signal: 'followUp', text }) });
          $('#followup').value = '';
          toast('Follow-up sent');
        } else if (act === 'setTarget') {
          const branch = $('#target-in').value.trim();
          await api(`/api/tasks/${v.taskId}/target`, { method: 'POST', body: JSON.stringify({ branch }) });
          toast('Target updated');
        } else {
          await api(`/api/tasks/${v.taskId}/signal`, { method: 'POST', body: JSON.stringify({ signal: act }) });
          toast(`${act} sent`);
        }
        setTimeout(refreshDrawer, 250);
        setTimeout(refreshTasks, 400);
      } catch (e) { toast(e.message, true); }
    }),
  );
  $('#drawer-body').querySelectorAll('[data-open]').forEach((e) => e.addEventListener('click', () => openDrawer(e.dataset.open)));
}

function renderDrawerEvents() {
  const box = document.getElementById('drawer-events');
  if (!box) return;
  box.innerHTML = S.drawerEvents
    .slice(-120)
    .map((e) => `<div class="ev"><span class="t">${esc(e.type)}</span><span>${esc(summarize(e.payload))}</span></div>`)
    .join('');
  box.scrollTop = box.scrollHeight;
}
function summarize(p) {
  if (!p) return '';
  if (p.text) return p.text.slice(0, 160);
  return Object.entries(p).map(([k, val]) => `${k}=${typeof val === 'object' ? JSON.stringify(val).slice(0, 40) : val}`).join(' ').slice(0, 160);
}

// ── queue ────────────────────────────────────────────────────────────────────
function queueView() {
  const inMerge = S.tasks.filter((t) => ['merge', 'pr'].includes(t.lastView?.stage));
  if (!inMerge.length) return `<div class="empty"><div class="big">Merge queue is empty</div>Tasks appear here when they reach the merge stage.</div>`;
  inMerge.sort((a, b) => (a.lastView?.mergeQueue?.position ?? 99) - (b.lastView?.mergeQueue?.position ?? 99));
  return inMerge
    .map((t) => {
      const v = t.lastView || {};
      const pos = v.mergeQueue?.position;
      const current = pos === 0;
      return `<div class="queue-item ${current ? 'current' : ''}" data-id="${t.id}">
        <span class="pos">${pos === 0 ? '▶' : pos > 0 ? `#${pos}` : '–'}</span>
        <div style="flex:1"><div class="task-title">${esc(t.title)}</div>
          <div class="task-sub"><span class="branch">${esc(v.branch || '')}</span> → <span class="branch">${esc(v.targetBranch || '')}</span></div></div>
        ${!current && v.state?.mergeDomain ? `<button class="btn sm" data-prio="${t.id}" data-domain="${esc(v.state.mergeDomain)}">Prioritize</button>` : ''}
      </div>`;
    })
    .join('');
}
function wireQueueView() {
  $('#main').querySelectorAll('.queue-item').forEach((e) => e.addEventListener('click', (ev) => { if (!ev.target.dataset.prio) openDrawer(e.dataset.id); }));
  $('#main').querySelectorAll('[data-prio]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await api('/api/queue/prioritize', { method: 'POST', body: JSON.stringify({ domain: b.dataset.domain, taskId: b.dataset.prio }) });
        toast('Prioritized'); setTimeout(refreshTasks, 300);
      } catch (e) { toast(e.message, true); }
    }),
  );
}

// ── activity ─────────────────────────────────────────────────────────────────
async function seedActivity() {
  try { S.activity = (await api('/api/activity?since=0')).reverse(); renderMain(); } catch {}
}
function activityView() {
  if (!S.activity.length) return `<div class="empty"><div class="big">No activity yet</div>Events stream here as agents work.</div>`;
  return `<div class="card"><div class="events" style="max-height:none">${S.activity
    .slice(0, 300)
    .map((e) => `<div class="ev"><span class="t">${esc(e.type)}</span><span style="color:var(--ink-3)">${esc(e.taskId?.slice(0, 14))}</span><span>${esc(summarize(e.payload))}</span></div>`)
    .join('')}</div></div>`;
}

// ── dashboard ────────────────────────────────────────────────────────────────
async function renderDashboard() {
  const box = $('#dash');
  if (!box) return;
  try {
    const d = await api('/api/dashboard');
    const accounts = d.accounts?.accounts || [];
    box.innerHTML = `
      <div class="page-title">Overview</div>
      <div class="stat-grid">
        <div class="stat"><div class="n">${d.projects}</div><div class="l">Projects</div></div>
        <div class="stat"><div class="n">${d.tasks}</div><div class="l">Tasks</div></div>
        ${Object.entries(d.byStage || {}).map(([s, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(s)}</div></div>`).join('')}
      </div>
      <div class="section-h">Agent accounts (token / limit status)</div>
      ${accounts.length
        ? accounts.map((a) => `<div class="card"><b class="mono">${esc(a.id)}</b> — in use ${a.inUse}/${a.maxConcurrent}, window ${a.fiveHourUsed}/${a.fiveHourLimit}${d.accounts.waiting ? ` · ${d.accounts.waiting} waiting` : ''}</div>`).join('')
        : `<div class="card" style="color:var(--ink-3)">No account coordinator running. Per-turn account leasing activates when accounts are configured.</div>`}`;
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ── settings ─────────────────────────────────────────────────────────────────
function settingsView(proj) {
  if (!proj) return `<div class="empty">Select a project.</div>`;
  const c = proj.config || {};
  return `
    <div class="page-title">Project settings — ${esc(proj.name)}</div>
    <div class="card">
      <div class="section-h">Software dev</div>
      <div class="form-row"><label>Repository directory</label><input id="set-repo" value="${esc((c.repos || [])[0] || '')}" placeholder="/path/to/your/repo" /></div>
      <div class="form-row"><label>Base branch</label><input id="set-base" value="${esc(c.defaultBase || 'main')}" /></div>
      <div class="form-row"><label>Merge-to (target) branch</label><input id="set-target" value="${esc(c.defaultTarget || 'main')}" /></div>
      <div class="form-row"><label>Gitignored files to copy into each world (comma-separated)</label><input id="set-copy" value="${esc((c.copyGlobs || []).join(', '))}" placeholder=".env, .env.local" /></div>
      <div class="form-row"><label>World provider</label><select id="set-world"><option value="worktree" ${c.worldProvider !== 'container' ? 'selected' : ''}>Local git worktree</option><option value="container" ${c.worldProvider === 'container' ? 'selected' : ''}>Container (Docker)</option></select></div>
      <div class="form-row switch"><input type="checkbox" id="set-pr" ${c.openGithubPr ? 'checked' : ''} /><label for="set-pr">Open a real GitHub PR on confirm (requires gh auth)</label></div>
      <button class="btn primary" id="save-settings">Save settings</button>
    </div>
    <div class="card">
      <div class="section-h">Workflow activation</div>
      <p style="color:var(--ink-2);margin-top:0">Activating a workflow resolves its dependencies and may spawn an onActivate preparation task (e.g. "make this project karmax-ready").</p>
      <button class="btn" id="activate-sd">Activate software-dev (runs prep task)</button>
    </div>
    <div class="card">
      <div class="section-h">Resilience</div>
      <div class="switch"><input type="checkbox" id="safe-mode" ${S.meta?.safeMode ? 'checked' : ''} /><label for="safe-mode">Global safe mode (boot vanilla: all overlays off)</label></div>
    </div>`;
}
function wireSettingsView(proj) {
  $('#save-settings')?.addEventListener('click', async () => {
    const config = {
      repos: $('#set-repo').value.trim() ? [$('#set-repo').value.trim()] : [],
      defaultBase: $('#set-base').value.trim() || 'main',
      defaultTarget: $('#set-target').value.trim() || 'main',
      copyGlobs: $('#set-copy').value.split(',').map((s) => s.trim()).filter(Boolean),
      worldProvider: $('#set-world').value,
      openGithubPr: $('#set-pr').checked,
    };
    try {
      await api(`/api/projects/${proj.id}`, { method: 'PATCH', body: JSON.stringify({ config }) });
      await loadProjects();
      toast('Settings saved');
    } catch (e) { toast(e.message, true); }
  });
  $('#activate-sd')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/projects/${proj.id}/activate-workflow`, { method: 'POST', body: JSON.stringify({ workflow: 'software-dev' }) });
      toast(`Activated (deps: ${r.requires.join(', ') || 'none'}${r.spawnedTasks.length ? '; prep task spawned' : ''})`);
      refreshTasks();
    } catch (e) { toast(e.message, true); }
  });
  $('#safe-mode')?.addEventListener('change', async (e) => {
    try { const r = await api('/api/safe-mode', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }); S.meta.safeMode = r.safeMode; toast(`Safe mode ${r.safeMode ? 'on' : 'off'}`); } catch (err) { toast(err.message, true); }
  });
}

// ── notifications ────────────────────────────────────────────────────────────
function needsAttention() {
  return S.tasks.filter((t) => ['review', 'escalated'].includes(t.lastView?.stage) && t.lastView?.status !== 'done' && !t.parentTaskId);
}
function updateBell() {
  const badge = $('#bell-badge');
  if (!badge) return;
  const n = needsAttention().length;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}
function toggleNotifications() {
  const existing = $('#notif-pop');
  if (existing) return existing.remove();
  const items = needsAttention();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.id = 'notif-pop';
  pop.innerHTML = `<div class="ph">Needs attention (${items.length})</div>${
    items.length ? items.map((t) => `<div class="pi" data-id="${t.id}"><b>${esc(t.title)}</b><div class="task-sub"><span class="chip ${t.lastView.status}">${esc(t.lastView.stage)}</span></div></div>`).join('') : '<div class="pi" style="color:var(--ink-3)">All clear ✓</div>'
  }`;
  $('#overlay-root').appendChild(pop);
  pop.querySelectorAll('.pi[data-id]').forEach((e) => e.addEventListener('click', () => { pop.remove(); openDrawer(e.dataset.id); }));
  setTimeout(() => document.addEventListener('click', function h(ev) { if (!pop.contains(ev.target) && ev.target.id !== 'bell') { pop.remove(); document.removeEventListener('click', h); } }), 10);
}

// ── theme ────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('karmax-theme', next);
}
(function initTheme() {
  const t = localStorage.getItem('karmax-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
})();

// ── projects ─────────────────────────────────────────────────────────────────
async function newProject() {
  const name = prompt('Project name');
  if (!name) return;
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, config: { defaultBase: 'main', defaultTarget: 'main' } }) });
    await loadProjects();
    S.projectId = p.id;
    renderRail();
    renderMain();
  } catch (e) { toast(e.message, true); }
}

// ── keyboard navigation / command palette (SPEC §10.1 command registry) ──────
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); return openPalette(); }
    if (e.key === 'Escape') return S.selected ? closeDrawer() : $('#notif-pop')?.remove();
    if (e.key === 'n') { e.preventDefault(); switchTab('tasks'); setTimeout(() => $('#new-task')?.focus(), 30); }
    if (e.key === '/') { e.preventDefault(); $('#search')?.focus(); }
    if (e.key === 'g') { S._g = true; setTimeout(() => (S._g = false), 600); return; }
    if (S._g) {
      const map = { t: 'tasks', q: 'queue', d: 'dashboard', s: 'settings', a: 'activity' };
      if (map[e.key]) { switchTab(map[e.key]); S._g = false; }
    }
    if (S.selected) {
      if (e.key === 'c') trigger('confirm');
      if (e.key === 'x') trigger('cancel');
      if (e.key === 'f') $('#followup')?.focus();
    }
  });
}
function trigger(act) {
  $(`#drawer-foot [data-act="${act}"]`)?.click();
}
function openPalette() {
  const cmds = S.contributions?.commands || [];
  const root = $('#overlay-root');
  root.innerHTML = `<div class="palette-scrim" id="pal-scrim"><div class="palette">
    <input id="pal-in" placeholder="Type a command…" />
    <div id="pal-list">${cmds.map((c, i) => `<div class="opt ${i === 0 ? 'active' : ''}" data-id="${c.id}">${esc(c.title)}${c.keybinding ? `<span class="key">${esc(c.keybinding)}</span>` : ''}</div>`).join('')}</div>
  </div></div>`;
  const input = $('#pal-in');
  input.focus();
  const run = (id) => { root.innerHTML = ''; runCommand(id); };
  $('#pal-scrim').addEventListener('click', (e) => { if (e.target.id === 'pal-scrim') root.innerHTML = ''; });
  $('#pal-list').querySelectorAll('.opt').forEach((o) => o.addEventListener('click', () => run(o.dataset.id)));
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    $('#pal-list').querySelectorAll('.opt').forEach((o) => (o.style.display = o.textContent.toLowerCase().includes(q) ? '' : 'none'));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') root.innerHTML = '';
    if (e.key === 'Enter') { const first = $('#pal-list .opt:not([style*="none"])'); if (first) run(first.dataset.id); }
  });
}
function runCommand(id) {
  const map = { 'nav.newTask': () => { switchTab('tasks'); setTimeout(() => $('#new-task')?.focus(), 30); }, 'nav.search': () => $('#search')?.focus(), 'nav.tasks': () => switchTab('tasks'), 'nav.queue': () => switchTab('queue'), 'nav.dashboard': () => switchTab('dashboard'), 'nav.settings': () => switchTab('settings'), 'nav.close': closeDrawer, 'task.confirm': () => trigger('confirm'), 'task.cancel': () => trigger('cancel'), 'task.followUp': () => $('#followup')?.focus() };
  map[id]?.();
}

// ── login ────────────────────────────────────────────────────────────────────
function renderLogin() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand" style="margin-bottom:18px"><span class="mark">◇</span> karmax</div>
    <div class="form-row"><label>Password</label><input type="password" id="pw" /></div>
    <button class="btn primary" id="login-btn" style="width:100%">Sign in</button>
    <div id="login-err" style="color:var(--danger);font-size:12px;margin-top:8px"></div>
  </div></div>`;
  const go = async () => {
    try {
      const r = await (await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) })).json();
      if (r.token) { S.token = r.token; boot(); } else $('#login-err').textContent = 'Invalid password';
    } catch { $('#login-err').textContent = 'Login failed'; }
  };
  $('#login-btn').addEventListener('click', go);
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="empty"><div class="big">Failed to load</div>${esc(e.message)}</div>`; });
