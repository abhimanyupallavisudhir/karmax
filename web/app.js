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
  deleted: new Set(), // ids of drafts deleted this session — tombstones so a stale
  // in-flight list refresh (issued before the DELETE landed) can't resurrect them.
  tab: 'tasks',
  selected: null, // taskId
  view: null, // selected task view
  drawerEvents: [],
  liveOutput: '',
  drawerSeq: 0,
  activity: [],
  search: '',
  schema: [],
  paramDefaults: {},
  sessions: {}, // role -> provider session id, for the "fork in CLI" copy command
  ws: null,
  hostDiagTimer: null, // live-refresh handle for the dashboard host-diagnostics panel
  procTimer: null, // live-refresh handle for the dashboard processes (task manager) panel
  cursorId: null, // the list cursor (roving selection) on the tasks/queue views
  returnRoute: null, // where "close drawer" returns to (the list/queue we opened from)
};

// ── URL routing (SPEC §10.6) ────────────────────────────────────────────────
// Every page is a host-owned route; the browser URL is the single source of truth
// for {project, tab, open task}. Workflows/coordinators never own a URL — a page
// like the merge queue is a first-party route that projects coordinator/task state.
// Projects are addressed by a slug of their name; tasks are numbered per project.
// Scheme:
//   /                                    → home (redirects to a project's tasks)
//   /dashboard                           → global dashboard
//   /settings                            → global settings
//   /projects/:name/tasks                → task list (also /queue, /activity, /settings)
//   /projects/:name/tasks/:num           → task list with task #num open (permalink)
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}
function projectSlug(p) { return p ? slugify(p.name) : ''; }
function projectById(pid) { return (S.projects || []).find((p) => p.id === pid); }
// Resolve a URL slug back to a project. Matches the slugified name (the common,
// human case), falling back to a raw project id for safety. On a slug collision
// the first-created project wins (names are expected distinct).
function projectBySlug(slug) {
  const s = slugify(slug);
  return (S.projects || []).find((p) => slugify(p.name) === s) || (S.projects || []).find((p) => p.id === slug);
}

function parseRoute(pathname) {
  const seg = decodeURI(pathname).replace(/\/+$/, '').split('/').filter(Boolean);
  if (!seg.length) return { name: 'home' };
  if (seg[0] === 'dashboard') return { name: 'global', tab: 'dashboard' };
  if (seg[0] === 'settings') return { name: 'global', tab: 'global' };
  if (seg[0] === 'projects' && seg[1]) {
    const tab = ['tasks', 'queue', 'activity', 'settings'].includes(seg[2]) ? seg[2] : 'tasks';
    const taskKey = seg[2] === 'tasks' && seg[3] ? seg[3] : null;
    return { name: 'project', slug: seg[1], tab, taskKey };
  }
  return { name: 'home' };
}

// The list/tab route for a project (by id), addressed by name-slug.
function projectRoute(pid, tab = 'tasks') {
  const p = projectById(pid);
  return p ? `/projects/${projectSlug(p)}/${tab}` : '/dashboard';
}

// Navigate: update the URL then reconcile app state to it. `replace` swaps the
// current history entry instead of pushing a new one.
function go(path, opts = {}) {
  if (path !== location.pathname) {
    history[opts.replace ? 'replaceState' : 'pushState']({ kx: 1 }, '', path);
  }
  return applyRoute();
}

// Resolve a per-project task URL key (a numeric #num, or a raw task id) → task id.
async function resolveProjectTaskKey(projectId, key) {
  if (/^\d+$/.test(key)) {
    const local = (S.tasks || []).find((t) => t.projectId === projectId && String(t.num) === key);
    if (local) return local.id;
    const r = await api(`/api/projects/${projectId}/tasks/by-num/${key}`).catch(() => null);
    return r?.id ?? null;
  }
  const local = (S.tasks || []).find((t) => t.id === key);
  return local ? local.id : key; // raw-id fallback
}

async function applyRoute() {
  const r = parseRoute(location.pathname);
  if (r.name === 'home') {
    const pid = S.projectId || S.projects[0]?.id;
    return go(pid ? projectRoute(pid) : '/dashboard', { replace: true });
  }
  if (r.name === 'global') {
    closeDrawerDom();
    S.tab = r.tab;
    renderRail();
    renderMain();
    if (r.tab === 'dashboard') renderDashboard();
    return;
  }
  // project / task routes → resolve the project (by name-slug) + optional open task
  const proj = projectBySlug(r.slug);
  if (!proj) { toast('Project not found', true); return go('/', { replace: true }); }
  const pid = proj.id;
  const tab = r.tab || 'tasks';
  if (pid !== S.projectId) { S.projectId = pid; await loadTasks().catch(() => {}); }
  else if (!S.tasks?.length) { await loadTasks().catch(() => {}); }
  S.tab = tab;
  renderRail();
  renderMain();
  if (tab === 'activity') seedActivity();
  if (tab === 'dashboard') renderDashboard();
  // reconcile the open task from the URL (loaded tasks are in hand now)
  let taskId = null;
  if (r.taskKey) {
    taskId = await resolveProjectTaskKey(pid, r.taskKey);
    if (!taskId) toast(`Task #${r.taskKey} not found`, true);
  }
  if (taskId) { if (S.selected !== taskId) await openDrawer(taskId); else highlightRow(); }
  else closeDrawerDom();
}

// Push a task permalink (/projects/:name/tasks/:num) and remember where to return
// on close (so closing lands back on the list/queue we opened from).
function goToTask(id) {
  const rec = (S.tasks || []).find((t) => t.id === id);
  const p = projectById(rec?.projectId || S.projectId);
  const keyPart = rec && rec.num != null ? String(rec.num) : id;
  S.returnRoute = location.pathname;
  return go(p ? `/projects/${projectSlug(p)}/tasks/${keyPart}` : location.pathname);
}

// A short human label for a task id: `#num` when known, else a short id.
function numLabel(taskId) {
  const t = (S.tasks || []).find((x) => x.id === taskId);
  return t && t.num != null ? `#${t.num}` : String(taskId || '').slice(0, 8);
}

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

// Provider → model choices for the agent field (free-text also allowed).
const MODELS = {
  claude: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'],
  codex: ['gpt-5.5', 'gpt-5.4-mini'],
  mock: ['mock'],
};
// Which reasoning-effort levels a given model actually accepts (mirrors the
// server's src/agent/effort.ts gating). Empty = the model has no effort control.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
function effortLevelsFor(provider, model) {
  const m = (model || '').toLowerCase();
  if (provider === 'claude') {
    if (!/opus-4-(5|6|7|8)|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(m)) return [];
    const ok = new Set(['low', 'medium', 'high']);
    if (/opus-4-(7|8)|sonnet-5|fable-5|mythos-5/.test(m)) ok.add('xhigh');
    if (/opus-4-(6|7|8)|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(m)) ok.add('max');
    return EFFORT_ORDER.filter((l) => ok.has(l));
  }
  if (provider === 'codex') {
    // gpt-5.x (5.5, 5.4-mini) accept up to xhigh; older reasoning models top out at high.
    if (/^gpt-5/.test(m)) return ['low', 'medium', 'high', 'xhigh'];
    if (/^(o1|o3|o4|codex)/.test(m) || m.includes('reasoning')) return ['low', 'medium', 'high'];
    return [];
  }
  return [];
}
// A <select> listing only the levels this model supports; disabled (greyed) when none.
function effortSelectHtml(cls, provider, model, current) {
  const levels = effortLevelsFor(provider, model);
  if (!levels.length) {
    return `<select class="${esc(cls)}" disabled title="This model has no reasoning-effort control"><option value="">no effort control</option></select>`;
  }
  const cur = levels.includes(current) ? current : '';
  const opts = ['', ...levels].map((e) => `<option value="${e}" ${e === cur ? 'selected' : ''}>${e || 'provider default'}</option>`).join('');
  return `<select class="${esc(cls)}">${opts}</select>`;
}
// Re-render an effort <select> in place after its provider/model changes.
function refreshEffortSelect(box, providerCls, modelCls, effortCls) {
  const el = box.querySelector('.' + effortCls);
  if (!el) return;
  const provider = box.querySelector('.' + providerCls)?.value;
  const model = box.querySelector('.' + modelCls)?.value.trim();
  el.outerHTML = effortSelectHtml(effortCls, provider, model, el.value || '');
}

function schemaFor(workflow) {
  return (S.schema.find((s) => s.name === workflow)?.params) || [];
}

// ── generic field renderer (SPEC §10.4 / §10.5) ──────────────────────────────
// Controls are PREFILLED with the effective value (own ?? inherited). On submit
// we only store fields the user CHANGED from the inherited value — so untouched
// fields keep inheriting (no checkbox, no "Inherit:" options). The inherited
// value is stashed on the control via data-inherit for that diff.
const eff = (own, inherited) => (own !== undefined && own !== null && own !== '' ? own : inherited);
const inhAttr = (val) => `data-inherit='${esc(JSON.stringify(val ?? null))}'`;

// "Reset to default" button — cleared/hidden until the field holds an override,
// then clicking it drops the override so the field inherits again (SPEC §10.5).
const resetBtn = (name) => `<button type="button" class="field-reset" data-reset="${esc(name)}" hidden title="Drop this override and inherit the default">↺ Reset to default</button>`;
const fieldLabel = (f) =>
  `<div class="label-row"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${f.required ? '' : resetBtn(f.name)}</div>` +
  (f.help ? `<div style="font-size:11px;color:var(--ink-3);margin:-2px 0 4px">${esc(f.help)}</div>` : '');

function renderField(f, own, inherited, withChips) {
  const v = eff(own, inherited) ?? '';
  const label = fieldLabel(f);
  const attrs = `data-field="${esc(f.name)}" data-ftype="${f.type}" ${inhAttr(inherited)}`;
  if (f.type === 'agent') return `<div class="form-row" data-row="${esc(f.name)}">${label}${renderAgentField(f, own, inherited)}</div>`;
  if (f.type === 'confirmer') return `<div class="form-row" data-row="${esc(f.name)}">${label}${renderConfirmerField(f, own, inherited)}</div>`;
  if (f.type === 'text') {
    const ta = `<textarea ${attrs} rows="4" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    // For the prompt field, pasted images render inside the box (below the text),
    // growing it as needed — rather than in a separate "Images" section.
    if (withChips)
      return `<div class="form-row" data-row="${esc(f.name)}">${label}<div class="prompt-field">${ta}<div class="img-chips" id="tf-chips" style="display:none"></div></div></div>`;
    return `<div class="form-row" data-row="${esc(f.name)}">${label}${ta}</div>`;
  }
  if (f.type === 'boolean')
    return `<div class="form-row" data-row="${esc(f.name)}"><div class="switch"><input type="checkbox" ${attrs} ${v ? 'checked' : ''} /><label>${esc(f.label)}</label><span style="flex:1"></span>${resetBtn(f.name)}</div></div>`;
  if (f.type === 'select')
    return `<div class="form-row" data-row="${esc(f.name)}">${label}<select ${attrs}>${(f.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  if (f.type === 'list') {
    const text = Array.isArray(v) ? v.join('\n') : v;
    return `<div class="form-row" data-row="${esc(f.name)}">${label}<textarea ${attrs} rows="2" placeholder="${esc(f.placeholder || 'one per line')}">${esc(text)}</textarea></div>`;
  }
  // string / number / branch / repoPath
  return `<div class="form-row" data-row="${esc(f.name)}">${label}<input ${attrs} type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" /></div>`;
}

function renderAgentField(f, spec, inherited) {
  const inh = inherited || {};
  const e = spec || inh; // prefill with the effective spec
  const provider = e.provider || 'claude';
  const models = MODELS[provider] || MODELS.claude;
  const role = f.role || f.name;
  return `<div class="agent-field" data-agent="${esc(role)}" ${inhAttr(inh)}>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="af-provider">${['claude', 'codex', 'mock'].map((p) => `<option ${p === provider ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <div class="combo af-model-combo" style="flex:1;min-width:140px">
        <input class="af-model" placeholder="model" value="${esc(e.model || '')}" autocomplete="off" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show model choices">▾</button>
        <div class="combo-menu" hidden></div>
      </div>
      ${effortSelectHtml('af-effort', provider, e.model, e.effort || '')}
    </div>
    <details class="af-resume" style="margin-top:6px"><summary style="font-size:12px;color:var(--ink-3);cursor:pointer">Fork a previous agent</summary>
      <input class="af-resume-search" placeholder="Search tasks to fork from…" style="width:100%;margin-top:6px;padding:7px 10px" />
      <div class="af-resume-results" style="max-height:140px;overflow:auto"></div>
      <div class="af-resume-chosen" style="font-size:12px;color:var(--accent);margin-top:4px">${spec?.resumeFrom ? esc(JSON.stringify(spec.resumeFrom)) : ''}</div>
      <input class="af-resume-session" placeholder="…or paste a provider conversation/session id to continue" value="${esc(spec?.resumeFrom?.sessionId || '')}" style="width:100%;margin-top:6px;padding:7px 10px" />
    </details>
  </div>`;
}

// The confirmer field: a mode selector (human / auto / agent) plus the SAME agent
// sub-form as Do/Merge/Resolve, shown only when the mode is "agent". Reuses
// renderAgentField for the agent controls (so provider/model/effort + "Fork a
// previous agent" all work identically), and carries the mode alongside.
const CONFIRM_MODE_LABELS = { human: 'Human (you confirm)', auto: 'Auto-confirm', agent: 'Agent confirms' };
function renderConfirmerField(f, own, inherited) {
  const inh = inherited || {};
  const e = own || inh;
  const mode = e.mode || inh.mode || 'human';
  return `<div class="confirmer-field" data-confirmer="${esc(f.role || f.name)}" data-inherit='${esc(JSON.stringify(inh))}'>
    <select class="cf-mode">${['human', 'auto', 'agent'].map((m) => `<option value="${m}" ${m === mode ? 'selected' : ''}>${esc(CONFIRM_MODE_LABELS[m])}</option>`).join('')}</select>
    <div class="cf-agent" style="margin-top:8px;${mode === 'agent' ? '' : 'display:none'}">${renderAgentField(f, own, inherited)}</div>
  </div>`;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const normSpec = (s) => (s ? { provider: s.provider, model: s.model || '', effort: s.effort || '' } : null);

// Read a form's values back out; only return fields CHANGED from inherited.
function collectForm(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'agent') {
      const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
      const spec = { provider: box.querySelector('.af-provider').value };
      const model = box.querySelector('.af-model').value.trim();
      const effort = box.querySelector('.af-effort').value;
      if (model) spec.model = model;
      if (effort) spec.effort = effort;
      const sessionId = box.querySelector('.af-resume-session').value.trim();
      const chosen = box.querySelector('.af-resume-chosen').textContent.trim();
      let resumeFrom;
      if (chosen) { try { resumeFrom = JSON.parse(chosen); } catch {} }
      if (sessionId) resumeFrom = { ...(resumeFrom || {}), sessionId };
      if (resumeFrom) spec.resumeFrom = resumeFrom;
      // include only if the agent differs from inherited OR a resume was chosen
      if (resumeFrom || !sameJson(normSpec(spec), normSpec(inh))) out[f.name] = spec;
      continue;
    }
    if (f.type === 'confirmer') {
      const box = root.querySelector(`.confirmer-field[data-confirmer="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
      const mode = box.querySelector('.cf-mode').value;
      const spec = { mode };
      let resumeFrom;
      if (mode === 'agent') {
        const ab = box.querySelector('.agent-field');
        spec.provider = ab.querySelector('.af-provider').value;
        const model = ab.querySelector('.af-model').value.trim();
        const effort = ab.querySelector('.af-effort').value;
        if (model) spec.model = model;
        if (effort) spec.effort = effort;
        const sessionId = ab.querySelector('.af-resume-session').value.trim();
        const chosen = ab.querySelector('.af-resume-chosen').textContent.trim();
        if (chosen) { try { resumeFrom = JSON.parse(chosen); } catch {} }
        if (sessionId) resumeFrom = { ...(resumeFrom || {}), sessionId };
        if (resumeFrom) spec.resumeFrom = resumeFrom;
      }
      // Store only when it differs from the inherited default: a different mode, or (in
      // agent mode) a different agent config or a chosen fork.
      const inhMode = inh?.mode || 'human';
      const changed = mode !== inhMode || (mode === 'agent' && (resumeFrom || !sameJson(normSpec(spec), normSpec(inh))));
      if (f.required || changed) out[f.name] = spec;
      continue;
    }
    const el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
    if (!el) continue;
    const inh = JSON.parse(el.getAttribute('data-inherit') || 'null');
    let val;
    if (f.type === 'boolean') val = el.checked;
    else if (f.type === 'list') val = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if (f.type === 'number') val = el.value === '' ? undefined : Number(el.value);
    else val = el.value === '' ? undefined : el.value;
    if (val === undefined) continue;
    // store only when changed from the inherited default (required fields always)
    if (f.required || !sameJson(val, inh)) out[f.name] = val;
  }
  return out;
}

// A lightweight combobox: a real dropdown that opens on focus and on the caret,
// filters as you type, and still accepts free text. Replaces <datalist>, whose
// popup is unreliable (won't open on the caret, flaky while typing).
function wireCombo(combo, getOptions, onChange) {
  const input = combo.querySelector('input');
  const menu = combo.querySelector('.combo-menu');
  const caret = combo.querySelector('.combo-caret');
  if (!input || !menu || !caret) return;
  let open = false;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const opts = (getOptions() || []).filter((o) => !q || o.toLowerCase().includes(q));
    menu.innerHTML = opts.length
      ? opts.map((o) => `<div class="combo-opt" data-v="${esc(o)}">${esc(o)}</div>`).join('')
      : `<div class="combo-empty">No matching presets — free text is allowed</div>`;
  };
  const show = () => { draw(); menu.hidden = false; open = true; };
  const hide = () => { menu.hidden = true; open = false; };
  input.addEventListener('focus', show);
  input.addEventListener('input', () => { show(); onChange && onChange(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); input.blur(); } });
  input.addEventListener('blur', () => setTimeout(hide, 150)); // let a menu click land first
  // mousedown (not click) so it fires before the input's blur closes the menu
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (open) hide();
    else { input.focus(); show(); }
  });
  menu.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    input.value = opt.dataset.v;
    hide();
    onChange && onChange();
  });
}

// Wire agent-field controls: provider→model combobox + fork search (no toggle).
function wireAgentFields(root) {
  root.querySelectorAll('.agent-field').forEach((box) => {
    const combo = box.querySelector('.af-model-combo');
    const providerOf = () => box.querySelector('.af-provider')?.value || 'claude';
    if (combo) wireCombo(combo, () => MODELS[providerOf()] || MODELS.claude, () => refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort'));
    box.querySelector('.af-provider')?.addEventListener('change', () => {
      box.querySelector('.af-model').value = ''; // model choices are provider-specific
      refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort');
    });
    const search = box.querySelector('.af-resume-search');
    const results = box.querySelector('.af-resume-results');
    search?.addEventListener('input', () => resumeSearch(box, search.value, results));
  });
  // Confirmer fields: show the agent sub-form only when mode is "agent".
  root.querySelectorAll('.confirmer-field').forEach((box) => {
    const mode = box.querySelector('.cf-mode');
    const agentBox = box.querySelector('.cf-agent');
    mode?.addEventListener('change', () => {
      if (agentBox) agentBox.style.display = mode.value === 'agent' ? '' : 'none';
    });
  });
}

// Wire per-field "Reset to default" buttons: show the button whenever the field
// diverges from its inherited default, and on click restore the inherited value
// so the field goes back to inheriting (collectForm then stores no override).
function wireFieldResets(root, fields) {
  for (const f of fields) {
    if (f.required) continue; // a required field always stores a value; nothing to inherit
    const btn = root.querySelector(`.field-reset[data-reset="${CSS.escape(f.name)}"]`);
    if (!btn) continue;
    const sync = () => { btn.hidden = !fieldOverridden(root, f); };
    if (f.type === 'agent') {
      const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      box.addEventListener('input', sync);
      box.addEventListener('change', sync);
      btn.addEventListener('click', () => { resetAgentField(box); sync(); });
    } else if (f.type === 'confirmer') {
      const box = root.querySelector(`.confirmer-field[data-confirmer="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      box.addEventListener('input', sync);
      box.addEventListener('change', sync);
      btn.addEventListener('click', () => { resetConfirmerField(box); sync(); });
    } else {
      const el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
      if (!el) continue;
      el.addEventListener('input', sync);
      el.addEventListener('change', sync);
      btn.addEventListener('click', () => { resetPlainField(el, f); sync(); });
    }
    sync();
  }
}

// Does the field currently hold a value that differs from the inherited default?
function fieldOverridden(root, f) {
  if (f.type === 'agent') {
    const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
    if (!box) return false;
    const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
    const spec = { provider: box.querySelector('.af-provider').value };
    const model = box.querySelector('.af-model').value.trim();
    const effort = box.querySelector('.af-effort').value;
    if (model) spec.model = model;
    if (effort) spec.effort = effort;
    return !sameJson(normSpec(spec), normSpec(inh));
  }
  if (f.type === 'confirmer') {
    const box = root.querySelector(`.confirmer-field[data-confirmer="${CSS.escape(f.role || f.name)}"]`);
    if (!box) return false;
    const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
    const mode = box.querySelector('.cf-mode').value;
    if (mode !== (inh?.mode || 'human')) return true;
    if (mode !== 'agent') return false;
    const ab = box.querySelector('.agent-field');
    const spec = { provider: ab.querySelector('.af-provider').value };
    const model = ab.querySelector('.af-model').value.trim();
    const effort = ab.querySelector('.af-effort').value;
    if (model) spec.model = model;
    if (effort) spec.effort = effort;
    return !sameJson(normSpec(spec), normSpec(inh));
  }
  const el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
  if (!el) return false;
  const inh = JSON.parse(el.getAttribute('data-inherit') || 'null');
  let val;
  if (f.type === 'boolean') val = el.checked;
  else if (f.type === 'list') val = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if (f.type === 'number') val = el.value === '' ? undefined : Number(el.value);
  else val = el.value === '' ? undefined : el.value;
  if (val === undefined) return false; // empty ⇒ inheriting
  if (f.type === 'list' && Array.isArray(val) && !val.length) return false;
  return !sameJson(val, inh);
}

function resetPlainField(el, f) {
  const inh = JSON.parse(el.getAttribute('data-inherit') || 'null');
  if (f.type === 'boolean') el.checked = !!inh;
  else if (f.type === 'list') el.value = Array.isArray(inh) ? inh.join('\n') : (inh || '');
  else el.value = inh === undefined || inh === null ? '' : inh;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function resetAgentField(box) {
  const inh = JSON.parse(box.getAttribute('data-inherit') || 'null') || {};
  const prov = box.querySelector('.af-provider');
  prov.value = inh.provider || 'claude';
  box.querySelector('.af-model').value = inh.model || '';
  refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort');
  const eff = box.querySelector('.af-effort');
  if (eff && inh.effort) eff.value = inh.effort;
}

function resetConfirmerField(box) {
  const inh = JSON.parse(box.getAttribute('data-inherit') || 'null') || {};
  const mode = box.querySelector('.cf-mode');
  mode.value = inh.mode || 'human';
  const agentBox = box.querySelector('.cf-agent');
  if (agentBox) agentBox.style.display = mode.value === 'agent' ? '' : 'none';
  const ab = box.querySelector('.agent-field');
  if (ab) resetAgentField(ab);
}

// Full task list (incl. archived) for the fork picker, cached per project.
// Archived tasks are the completed ones you most often want to fork from, so the
// fork search must see them regardless of the "Show archived" toggle. Cached to
// avoid re-fetching (and re-enriching) the whole list on every keystroke;
// loadTasks() clears the cache so newly created/updated tasks show up.
async function forkTaskPool() {
  if (!S.projectId) return S.tasks;
  if (S.forkPool?.projectId === S.projectId) return S.forkPool.tasks;
  const tasks = await api(`/api/projects/${S.projectId}/tasks?includeArchived=1`);
  S.forkPool = { projectId: S.projectId, tasks };
  return tasks;
}

// Fork search: find tasks by title, then list their per-role agent sessions.
async function resumeSearch(box, q, results) {
  const ql = q.toLowerCase().trim();
  if (!ql) { results.innerHTML = ''; return; }
  // The pool includes archived tasks (the ones most often forked from); match by
  // title OR by their `#num` (SPEC §10.6).
  let pool = S.tasks;
  try { pool = await forkTaskPool(); } catch {}
  const matches = pool.filter((t) => !t.params?.draft && taskMatches(t, ql)).slice(0, 6);
  const rows = await Promise.all(
    matches.map(async (t) => {
      let sessions = {};
      try { sessions = await api(`/api/tasks/${t.id}/sessions`); } catch {}
      const roles = Object.keys(sessions);
      if (!roles.length) return '';
      const numTag = t.num != null ? `<span class="task-num">#${t.num}</span> ` : '';
      return roles
        .map((role) => `<div class="pi" data-tid="${t.id}" data-role="${role}" data-sid="${esc(sessions[role]?.id || '')}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--line)">${numTag}${esc(t.title)} <span class="mono" style="color:var(--ink-3);font-size:11px">· ${role}</span></div>`)
        .join('');
    }),
  );
  const html = rows.filter(Boolean).join('') || '<div style="padding:7px 10px;color:var(--ink-3);font-size:12px">No resumable agent sessions in matching tasks.</div>';
  results.innerHTML = html;
  results.querySelectorAll('[data-tid]').forEach((r) =>
    r.addEventListener('click', () => {
      box.querySelector('.af-resume-chosen').textContent = JSON.stringify({ taskId: r.dataset.tid, role: r.dataset.role });
      box.querySelector('.af-resume-search').value = `${r.textContent}`;
      results.innerHTML = '';
    }),
  );
}

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

// ─── Image attachments (paste / drag-drop an image into a prompt field) ───────
// Bytes are uploaded to the content-addressed store immediately, so the task /
// follow-up payloads carry only the returned lightweight { id, mediaType, bytes }
// reference. Thumbnails are served back via /api/attachments/:id?token=… (an
// <img> can't send a Bearer header, so the session token rides in the query).
async function uploadImage(file) {
  const res = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `upload failed (HTTP ${res.status})`);
  return body; // ImageRef
}

function attachmentUrl(id) {
  return `/api/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(S.token || '')}`;
}

function renderImageChips(container, store, onChange) {
  if (!container) return;
  container.innerHTML = (store || [])
    .map(
      (ref, i) =>
        `<span class="img-chip" title="${esc(ref.mediaType)} · ${Math.round((ref.bytes || 0) / 1024)} KB"><img src="${attachmentUrl(ref.id)}" alt="attachment"/><button class="img-chip-x" data-i="${i}" title="Remove">✕</button></span>`,
    )
    .join('');
  container.style.display = (store || []).length ? 'flex' : 'none';
  container.querySelectorAll('.img-chip-x').forEach((b) =>
    b.addEventListener('click', () => {
      store.splice(Number(b.dataset.i), 1);
      renderImageChips(container, store, onChange);
      if (onChange) onChange();
    }),
  );
}

// Wire paste + drag-drop image capture onto a text input. `getStore` returns the
// live ImageRef array; `onChange` re-renders the chips. Idempotent per element.
function wireImagePaste(inputEl, getStore, onChange) {
  if (!inputEl || inputEl._imgWired) return;
  inputEl._imgWired = true;
  const ingest = async (files) => {
    const imgs = [...files].filter((f) => f && f.type && f.type.startsWith('image/'));
    if (!imgs.length) return false;
    for (const file of imgs) {
      try {
        const ref = await uploadImage(file);
        getStore().push(ref);
        onChange();
      } catch (e) {
        toast(e.message, true);
      }
    }
    return true;
  };
  inputEl.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (!files.length) return; // let normal text paste through
    e.preventDefault();
    ingest(files);
  });
  inputEl.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.type && i.type.startsWith('image/'))) e.preventDefault();
  });
  inputEl.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.some((f) => f.type && f.type.startsWith('image/'))) {
      e.preventDefault();
      ingest(files);
    }
  });
}

// Render read-only image thumbnails for a message that carried attachments.
function renderMessageImages(images) {
  if (!images || !images.length) return '';
  return `<div class="msg-images">${images
    .map((ref) => `<a href="${attachmentUrl(ref.id)}" target="_blank" rel="noopener"><img src="${attachmentUrl(ref.id)}" alt="attachment"/></a>`)
    .join('')}</div>`;
}

function toast(msg, err = false, action) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  // An optional action (e.g. Undo) — gives the toast a clickable button and more
  // dwell time. Backward-compatible: existing toast(msg[, err]) calls are unchanged.
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { t.remove(); action.fn(); });
    t.appendChild(btn);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), action ? 6500 : 3200);
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const session = await (await fetch('/api/session')).json();
  if (session.authRequired && !session.token) return renderLogin();
  S.token = session.token;
  S.meta = await api('/api/meta');
  try {
    S.contributions = await api('/api/contributions');
    S.schema = await api('/api/schema');
  } catch {}
  await loadProjects();
  connectWs();
  renderShell();
  bindKeys();
  window.addEventListener('popstate', () => applyRoute());
  await applyRoute(); // honor the initial URL (deep link / bookmark)
}

async function loadProjects() {
  S.projects = await api('/api/projects');
  if (!S.projectId && S.projects[0]) S.projectId = S.projects[0].id;
}

async function loadTasks() {
  if (!S.projectId) return;
  S.forkPool = null; // let the fork picker re-fetch its archived-inclusive pool
  const fetched = await api(`/api/projects/${S.projectId}/tasks${S.showArchived ? '?includeArchived=1' : ''}`);
  // Drop any draft we just deleted: a list request issued before the DELETE landed
  // can still return it and clobber the optimistic removal. Once a fresh fetch no
  // longer contains a tombstoned id, the server has caught up — retire it so the
  // set can't grow without bound (task ids are never reused).
  for (const id of S.deleted) if (!fetched.some((t) => t.id === id)) S.deleted.delete(id);
  S.tasks = fetched.filter((t) => !S.deleted.has(t.id));
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
      if (ev.type === 'agent.output' && ev.payload?.text) {
        S.liveOutput += (S.liveOutput ? '\n' : '') + ev.payload.text;
        updateLiveBubble();
      }
      if (ev.type === 'view.updated' || ev.type.includes('stage') || ev.type === 'merge.result' || ev.type === 'turn.result') {
        S.liveOutput = '';
        refreshDrawer();
      } else if (ev.type === 'session.started') {
        refreshDrawer(); // the session id was just published mid-turn → show the live fork command
      } else renderDrawerEvents();
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
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="mark">◇</span> karmax</div>
      <div class="search"><span>⌕</span><input id="search" placeholder="Search tasks…  ( / )" /></div>
      <div class="spacer"></div>
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
  // The rail/main are painted by applyRoute() (boot calls it right after), so the
  // shell reflects the initial URL instead of a default view.
}

function renderRail() {
  const rail = $('#rail');
  if (!rail) return;
  rail.innerHTML = `
    <div class="label">Projects</div>
    ${S.projects
      .map(
        (p) => `<div class="proj ${p.id === S.projectId ? 'active' : ''}" data-id="${p.id}" tabindex="0">
          <span class="glyph">◇</span> <span>${esc(p.name)}</span>
        </div>`,
      )
      .join('')}
    <div class="proj add" id="new-project" tabindex="0"><span>+</span> <span>New project</span></div>
    <div class="grow"></div>
    <div class="label">Global</div>
    <div class="nav-item ${S.tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard" tabindex="0">▦ Dashboard</div>
    <div class="nav-item ${S.tab === 'global' ? 'active' : ''}" data-tab="global" tabindex="0">⚙ Global settings</div>
    <div class="nav-item" id="rail-palette" tabindex="0" title="Every command, task, and project — searchable">⌘ Command palette<span class="kbd" style="margin-left:auto">${esc(fmtKeys('meta+k'))}</span></div>`;
  rail.querySelectorAll('.proj[data-id]').forEach((e) =>
    e.addEventListener('click', () => go(projectRoute(e.dataset.id))),
  );
  $('#new-project')?.addEventListener('click', newProject);
  rail.querySelectorAll('.nav-item[data-tab]').forEach((e) => e.addEventListener('click', () => switchTab(e.dataset.tab)));
  $('#rail-palette')?.addEventListener('click', openPalette);
}

function switchTab(tab) {
  if (tab === 'dashboard') return go('/dashboard');
  if (tab === 'global') return go('/settings');
  const pid = S.projectId || S.projects[0]?.id;
  return go(pid ? projectRoute(pid, tab) : '/dashboard');
}

// Preserve the focused field (value + caret) across a renderMain() innerHTML
// swap so a background refresh doesn't clear/de-focus what the user is typing.
function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !el.id || !root.contains(el)) return null;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return null;
  const st = { id: el.id, tag, value: el.value };
  if (tag !== 'SELECT' && typeof el.selectionStart === 'number') {
    st.selectionStart = el.selectionStart;
    st.selectionEnd = el.selectionEnd;
  }
  return st;
}

function restoreFocus(root, st) {
  if (!st) return;
  const el = root.querySelector(`#${window.CSS && CSS.escape ? CSS.escape(st.id) : st.id}`);
  if (!el || el.tagName !== st.tag) return;
  // Only carry over the in-progress value for free-text fields; a fresh empty
  // composer input would otherwise be reset by the re-render.
  if (st.tag !== 'SELECT') el.value = st.value;
  el.focus();
  if (typeof st.selectionStart === 'number' && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(st.selectionStart, st.selectionEnd); } catch {}
  }
}

// ── main content ───────────────────────────────────────────────────────────
function renderMain() {
  const main = $('#main');
  if (!main) return;
  const proj = S.projects.find((p) => p.id === S.projectId);
  const tabs = ['tasks', 'queue', 'activity', 'settings'];
  const labels = { tasks: 'Tasks', queue: 'Merge queue', activity: 'Activity', settings: 'Project settings' };
  const projectScoped = ['tasks', 'queue', 'activity', 'settings'].includes(S.tab);
  const tabbar = projectScoped
    ? `<div class="tabs">${tabs
        .map((t) => `<div class="tab ${S.tab === t ? 'active' : ''}" data-tab="${t}">${labels[t]}${t === 'tasks' && S.tasks.length ? `<span class="pill">${S.tasks.length}</span>` : ''}</div>`)
        .join('')}</div>`
    : '';

  let content = '';
  if (S.tab === 'tasks') content = tasksView();
  else if (S.tab === 'queue') content = queueView();
  else if (S.tab === 'activity') content = activityView();
  else if (S.tab === 'dashboard') content = `<div id="dash">Loading…</div>`;
  else if (S.tab === 'settings') content = settingsView(proj);
  else if (S.tab === 'global') content = globalSettingsView();

  // Background refreshes (a WebSocket event fires renderMain while a task runs)
  // must not blow away whatever the user is mid-typing in #main. Snapshot the
  // focused field's value/caret before the innerHTML swap, restore it after.
  const focusState = captureFocus(main);

  main.innerHTML = tabbar + content;
  main.querySelectorAll('.tab[data-tab]').forEach((e) => e.addEventListener('click', () => switchTab(e.dataset.tab)));
  if (S.tab === 'tasks') wireTasksView();
  if (S.tab === 'queue') wireQueueView();
  if (S.tab === 'settings') wireSettingsView(proj);
  if (S.tab === 'global') wireGlobalSettings();
  if (S.tab === 'dashboard') renderDashboard();

  restoreFocus(main, focusState);
  updateBell();
}

// ── tasks ────────────────────────────────────────────────────────────────────
// Match a task against a search query: by title, or by its `#num` (so "42" and
// "#42" both find task #42).
function taskMatches(t, q) {
  if (!q) return true;
  const ql = q.toLowerCase().trim();
  if (t.title.toLowerCase().includes(ql)) return true;
  if (t.num != null && `#${t.num}`.includes(ql.startsWith('#') ? ql : `#${ql}`)) return true;
  return false;
}
function tasksView() {
  const filtered = S.tasks.filter((t) => taskMatches(t, S.search));
  const rows = filtered
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(taskRow)
    .join('');
  const archivedCount = S.tasks.filter((t) => t.params?.archived).length;
  return `
    <div class="composer">
      <input class="title-in" id="new-task" placeholder="Describe a task and press ${esc(fmtKeys('meta+Enter').replace('↵', 'Enter'))}…  ( n )  ·  paste an image to attach" />
      <select id="new-wf">${WORKFLOWS.map((w) => `<option value="${w.id}">${w.label}</option>`).join('')}</select>
      <button class="btn" id="expand-task" title="Full task form ( N or ↵ )">⋯ More</button>
      <button class="btn primary" id="add-task" title="Add directly ( ${esc(fmtKeys('meta+Enter'))} )">Add</button>
    </div>
    <div class="img-chips" id="new-task-chips" style="display:none"></div>
    <div class="switch" style="justify-content:flex-end;margin:4px 0">
      <input type="checkbox" id="show-archived" ${S.showArchived ? 'checked' : ''} />
      <label for="show-archived" style="font-size:12px;color:var(--ink-3)">Show archived${S.showArchived && archivedCount ? ` (${archivedCount})` : ''}</label>
    </div>
    ${rows || `<div class="empty"><div class="big">No tasks yet</div>Describe a task above, or open the full form with “More”.</div>`}`;
}

function taskRow(t) {
  const isDraft = t.params?.draft;
  if (isDraft) {
    return `
    <div class="task-row" data-draft="${t.id}" tabindex="0">
      <span class="status-dot cancelled" title="draft"></span>
      <div class="task-main">
        <div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}</div>
        <div class="task-sub"><span class="wf">${esc(t.workflow)}</span><span class="chip">draft</span></div>
      </div>
      <div class="task-right">
        <button class="btn sm" data-queue="${t.id}">Queue</button>
        <button class="btn sm danger" data-deldraft="${t.id}">Delete</button>
      </div>
    </div>`;
  }
  const v = t.lastView || {};
  const status = v.status || 'active';
  const stage = v.stage || 'setup';
  const archived = t.params?.archived;
  // archivable when not progressing on its own / not awaiting review
  const terminal = !['active', 'waiting'].includes(status);
  const archiveBtn = archived
    ? `<button class="icon-btn" data-unarchive="${t.id}" title="Unarchive — restore to the list"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></button>`
    : terminal
      ? `<button class="icon-btn" data-archive="${t.id}" title="Archive — hide from the list"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg></button>`
      : '';
  return `
    <div class="task-row ${archived ? 'archived' : ''}" data-id="${t.id}" tabindex="0">
      <span class="status-dot ${status}" title="${esc(status)}"></span>
      <div class="task-main">
        <div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}${archived ? ' <span class="chip">archived</span>' : ''}</div>
        <div class="task-sub">
          <span class="wf">${esc(t.workflow)}</span>
          ${customBranch(v, t.id) ? `<span class="branch">${esc(v.branch)}</span>` : ''}
          <span class="chip ${status}">${esc(stageLabel(v))}</span>
        </div>
      </div>
      <div class="task-right">${pipeline(v)}${archiveBtn}</div>
    </div>`;
}

// Every task gets an isolated worktree on an auto-generated `karmax/<taskId>`
// branch — the taskId is a noisy random slug, so echoing it in the byline just
// clutters the list/drawer (it's still reachable via the drawer's terminal +
// fork commands, which carry the world path). Only surface the branch when it's
// a *custom* one the human would recognize — e.g. an existing branch checked out
// by a merge-only workflow.
function customBranch(v, taskId) {
  return v.branch && v.branch !== `karmax/${taskId}`;
}

// Human-facing stage label. In the `merge` stage a task is either waiting for
// its merge-queue slot or actively merging — the merge agent only runs once the
// slot is granted (SPEC §6.1), so `mergeGranted` distinguishes the two. Surface
// "merge queued" for the wait, which the raw `stage` alone hides.
function stageLabel(v) {
  const stage = v.stage || 'setup';
  if (stage === 'merge' && !v.state?.mergeGranted) return 'merge queued';
  return stage;
}

// The workflow's declared stages (SPEC §5), or the software-dev default.
function stagesFor(workflow) {
  const s = (S.schema || []).find((x) => x.name === workflow);
  return s && s.stages && s.stages.length ? s.stages : NODES;
}
function stageIndexOf(stages, stage) {
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].key === stage || (stages[i].aliases || []).includes(stage)) return i;
  }
  if (['done', 'cancelled', 'failed'].includes(stage)) return stages.length - 1; // terminal
  return 0;
}

function pipeline(v) {
  const stages = stagesFor(v.workflow);
  // 'escalated' is a blocked, awaiting-human state — NOT a pipeline position. Don't
  // pin it to a stage (it used to mis-map onto Merge); flag the whole track instead.
  const escalated = v.stage === 'escalated';
  const idx = escalated ? -1 : stageIndexOf(stages, v.stage);
  const done = v.stage === 'done';
  const merged = v.pointOfNoReturnPassed || done;
  const ponrIdx = stages.findIndex((n) => n.ponr);
  let segs = '';
  for (let i = 0; i < stages.length - 1; i++) {
    const n = stages[i];
    let cls = 'seg';
    if (i < idx) cls += ' done';
    if (i === idx && !done) cls += ' current ' + (v.status === 'active' ? 'working' : v.status || '');
    if (merged && ponrIdx >= 0 && i >= ponrIdx) cls += ' merged';
    if (n.ponr) {
      segs += `<span class="ponr ${merged ? 'passed' : i === idx ? 'current' : ''}" title="point of no return"></span>`;
    }
    segs += `<span class="${cls}"></span>`;
  }
  return `<div class="pipeline${escalated ? ' escalated' : ''}" title="${escalated ? 'escalated — awaiting a human' : esc(v.stage || '')}">${segs}</div>`;
}

function pipelineLarge(v) {
  const stages = stagesFor(v.workflow);
  const escalated = v.stage === 'escalated';
  const idx = escalated ? -1 : stageIndexOf(stages, v.stage);
  const done = v.stage === 'done';
  const merged = v.pointOfNoReturnPassed || done;
  return `<div class="pipeline-lg${escalated ? ' escalated' : ''}"${escalated ? ' title="escalated — awaiting a human"' : ''}>${stages.map((n, i) => {
    let cls = 'node';
    if (i < idx || (done && i <= idx)) cls += ' done';
    if (i === idx && !done) cls += ' current';
    if (merged && n.ponr) cls += ' merged';
    if (done && i === stages.length - 1) cls += ' merged';
    return `<div class="${cls}"><div class="bar"></div><div class="name">${n.ponr ? '◆ ' : ''}${esc(n.label)}</div></div>`;
  }).join('')}</div>`;
}

function wireTasksView() {
  $('#main').querySelectorAll('.task-row[data-id]').forEach((e) => e.addEventListener('click', () => goToTask(e.dataset.id)));
  $('#main').querySelectorAll('[data-draft]').forEach((e) =>
    e.addEventListener('click', (ev) => { if (!ev.target.dataset.queue && !ev.target.dataset.deldraft) openTaskForm(undefined, S.tasks.find((t) => t.id === e.dataset.draft)); }),
  );
  $('#main').querySelectorAll('[data-queue]').forEach((b) =>
    b.addEventListener('click', async (ev) => { ev.stopPropagation(); try { await api(`/api/tasks/${b.dataset.queue}/queue`, { method: 'POST', body: '{}' }); toast('Queued'); refreshTasks(); } catch (e) { toast(e.message, true); } }),
  );
  $('#main').querySelectorAll('[data-deldraft]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      // Deleting a draft is a hard delete with no undo, so confirm first.
      const title = S.tasks.find((t) => t.id === b.dataset.deldraft)?.title || 'this draft';
      if (!confirm(`Delete draft "${title}"? This cannot be undone.`)) return;
      await deleteDraft(b.dataset.deldraft);
      toast('Draft removed');
    }),
  );
  const setArchived = async (id, archived) => {
    const title = S.tasks.find((t) => t.id === id)?.title || 'task';
    try {
      await api(`/api/tasks/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) });
      // Archiving only hides — offer an immediate one-click Undo so an accidental
      // click is trivially reversible (it isn't destructive, just filtered out).
      if (archived) toast(`Archived “${title.slice(0, 40)}”`, false, { label: 'Undo', fn: () => setArchived(id, false) });
      else toast('Unarchived');
      refreshTasks();
    } catch (e) { toast(e.message, true); }
  };
  $('#main').querySelectorAll('[data-archive]').forEach((b) =>
    b.addEventListener('click', (ev) => { ev.stopPropagation(); setArchived(b.dataset.archive, true); }),
  );
  $('#main').querySelectorAll('[data-unarchive]').forEach((b) =>
    b.addEventListener('click', (ev) => { ev.stopPropagation(); setArchived(b.dataset.unarchive, false); }),
  );
  $('#show-archived')?.addEventListener('change', (e) => { S.showArchived = e.target.checked; refreshTasks(); });
  const add = async () => {
    const input = $('#new-task');
    const title = input.value.trim();
    const images = S.newTaskImages || [];
    if (!title && !images.length) return;
    const workflow = $('#new-wf').value;
    input.value = '';
    try {
      await api(`/api/projects/${S.projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: firstLine(title || 'Image task'),
          prompt: title,
          command: workflow === 'script-exec' ? title : undefined,
          workflow,
          ...(images.length ? { images } : {}),
        }),
      });
      S.newTaskImages = [];
      renderImageChips($('#new-task-chips'), S.newTaskImages);
      toast('Task created');
      await refreshTasks();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#add-task')?.addEventListener('click', add);
  // Enter opens the FULL form (carrying the typed text into its prompt field) so
  // the default path invites elaboration; ⌘/Ctrl+Enter adds the task directly.
  $('#new-task')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) add();
    else openTaskForm($('#new-wf').value, undefined, $('#new-task').value.trim());
  });
  // Paste / drag-drop an image into the quick-add box to attach it (SPEC — image prompts).
  if (!S.newTaskImages) S.newTaskImages = [];
  wireImagePaste($('#new-task'), () => S.newTaskImages, () => renderImageChips($('#new-task-chips'), S.newTaskImages));
  renderImageChips($('#new-task-chips'), S.newTaskImages);
  // Opening the full form via "More" carries over whatever was typed in the
  // quick-add box into the field that consumes it (Prompt, Command, …).
  $('#expand-task')?.addEventListener('click', () => openTaskForm($('#new-wf').value, undefined, $('#new-task').value.trim()));
  // list cursor: re-apply after the re-render; Tab-focusing a row syncs it
  applyCursor();
  $('#main').querySelectorAll('.task-row').forEach((r) => r.addEventListener('focus', () => { S.cursorId = rowKey(r); applyCursor(); }));
}
const firstLine = (s) => s.split('\n')[0].slice(0, 80);

// The task-scope field that consumes the quick-add "Describe a task" text: the
// workflow's prompt field, else its primary required text/string input (e.g.
// script-exec's Command). Mirrors how add() maps that text to prompt/command.
function consumingField(fields) {
  return (
    fields.find((f) => f.bind === 'prompt') ||
    fields.find((f) => (f.type === 'text' || f.type === 'string') && f.required) ||
    null
  );
}

async function deleteDraft(id) {
  // Drafts never started a workflow, so the record is hard-deleted server-side.
  // A 404 means it's already gone (e.g. a racing double-delete) — treat that as
  // success rather than surfacing a confusing "no such task" error.
  try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); }
  catch (e) { if (!/no such task|HTTP 404/i.test(e.message || '')) return toast(e.message, true); }
  S.deleted.add(id); // tombstone before a debounced refresh can re-fetch the stale list
  S.tasks = S.tasks.filter((t) => t.id !== id);
  renderMain();
}

// ── the expanded task form (SPEC §10.4) ──────────────────────────────────────
async function openTaskForm(workflow, draft, seedText) {
  const wf = workflow || draft?.workflow || 'software-dev';
  const fields = schemaFor(wf).filter((f) => f.scopes.includes('task'));
  // The prompt/consuming field (a textarea) hosts pasted-image chips inside its
  // own box; only fall back to a standalone "Images" section if there isn't one.
  const cf = consumingField(fields);
  const promptField = cf && cf.type === 'text' ? cf : null;
  const values = draft ? { ...draft.params } : {};
  // Carry over the quick-add text (or whatever was typed before switching
  // workflows) into the field that consumes it, without clobbering a real value.
  if (seedText) {
    if (cf && !values[cf.name]) values[cf.name] = seedText;
  }
  let inherited = {};
  try { inherited = (await api(`/api/defaults/${S.projectId}/${wf}`)).task.inherited; } catch {}
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="palette-scrim" id="tf-scrim">
      <div class="palette" style="width:min(640px,94vw);max-height:84vh;overflow:auto">
        <div style="padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px">
          <b>${draft ? 'Edit draft' : 'New task'}</b>
          <select id="tf-wf" ${draft ? 'disabled' : ''}>${WORKFLOWS.map((w) => `<option value="${w.id}" ${w.id === wf ? 'selected' : ''}>${w.label}</option>`).join('')}</select>
          <span style="flex:1"></span><button class="icon-btn" id="tf-close">✕</button>
        </div>
        <div style="padding:14px 16px" id="tf-body">${fields.map((f) => renderField(f, values[f.name], inherited[f.name], f === promptField)).join('')}
          ${promptField ? '' : `<div class="form-row" data-row="__images">
            <div class="label-row"><label>Images</label></div>
            <div class="img-chips" id="tf-chips" style="display:none"></div>
            <span style="color:var(--ink-3);font-size:12px">Paste (⌘/Ctrl-V) or drag an image into a text field above to attach it to the prompt.</span>
          </div>`}
          <div class="form-row" data-row="__notes">
            <div class="label-row"><label>Notes</label></div>
            <textarea id="tf-notes" rows="3" placeholder="Jot down anything for yourself — not sent to the agent" style="width:100%">${esc(draft?.notes || '')}</textarea>
            <span style="color:var(--ink-3);font-size:12px">Only you see this — never sent to the agent.</span>
          </div>
          <details class="advanced" style="margin-top:10px">
            <summary>Credentials — precedence &amp; enable/disable for this task</summary>
            <p class="task-sub" style="color:var(--ink-3);margin-top:0">Overrides the project/global order + enablement, just for this task. Drag to reorder; toggle On/Off.</p>
            <div id="cred-editor-newtask">Loading…</div>
          </details>
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;background:var(--surface-2)">
          <button class="btn" id="tf-draft">Save draft</button>
          <button class="btn primary" id="tf-queue">${draft ? 'Queue' : 'Add task'}</button>
        </div>
      </div>
    </div>`;
  // Reassigned below once auto-save is wired; flushes pending edits before closing.
  let closeForm = () => (root.innerHTML = '');
  $('#tf-wf')?.addEventListener('change', async () => {
    // Re-render for the new workflow, preserving text typed into the current
    // consuming field so it moves to the new workflow's consuming field.
    const cf = consumingField(fields);
    const carried = cf ? $('#tf-body')?.querySelector(`[data-field="${CSS.escape(cf.name)}"]`)?.value : '';
    // Drop any draft auto-created for the previous workflow — its params won't
    // map onto the new workflow's schema, and reopening starts fresh anyway.
    clearTimeout(saveTimer);
    if (localCred && draftId) { const id = draftId; draftId = null; try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); } catch {} }
    openTaskForm($('#tf-wf').value, undefined, (carried || '').trim());
  });
  $('#tf-scrim').addEventListener('click', (e) => { if (e.target.id === 'tf-scrim') closeForm(); });
  $('#tf-close').addEventListener('click', () => closeForm());
  wireAgentFields($('#tf-body'));
  wireFieldResets($('#tf-body'), fields);
  // Image attachments for the full task form: pasting/dropping an image into any
  // text field attaches it to the prompt. State is local to this form instance.
  const formImages = Array.isArray(draft?.params?.images) ? [...draft.params.images] : [];
  // Repaint chips and (unless first paint) auto-save — pasting an image fires no
  // 'input' event, so the debounced auto-save wouldn't otherwise pick it up.
  // `autoSaveSoon` is a hoisted declaration further down this same scope.
  const paintFormChips = (save) => { renderImageChips($('#tf-chips'), formImages, () => autoSaveSoon()); if (save) autoSaveSoon(); };
  $('#tf-body')
    .querySelectorAll('textarea, input[type="text"], input:not([type])')
    .forEach((el) => wireImagePaste(el, () => formImages, () => paintFormChips(true)));
  paintFormChips();
  // Focus the consuming field (prompt/command) with the caret at the end, so
  // Enter-from-quick-add flows straight into elaborating what was typed. `cf`
  // (the consuming field) is resolved once at the top of this function.
  const cfEl = cf && $('#tf-body')?.querySelector(`[data-field="${CSS.escape(cf.name)}"]`);
  if (cfEl) {
    cfEl.focus();
    const end = cfEl.value?.length ?? 0;
    if (typeof cfEl.setSelectionRange === 'function') { try { cfEl.setSelectionRange(end, end); } catch {} }
  }
  // Per-task credential overrides. NOTE: there are TWO task forms that must each carry
  // this control — this NEW-TASK / edit-draft form (#cred-editor-newtask) AND the
  // running-task drawer (renderDrawer's #cred-editor-task). Change one → check the other.
  // A draft has an id → edit its policy directly. A brand-new task has none, so the
  // editor runs in `local` mode: changes are held here and applied on create (below).
  let taskCredPolicy = {};
  const localCred = !draft;
  if (draft) renderCredentialEditor($('#cred-editor-newtask'), 'task', { projectId: S.projectId, taskId: draft.id });
  else renderCredentialEditor($('#cred-editor-newtask'), 'task', { local: true, projectId: S.projectId, policy: taskCredPolicy, onChange: (p) => { taskCredPolicy = p; autoSaveSoon(); } });

  // The id of the draft this form is editing. Starts as the passed-in draft; a
  // brand-new task gets one lazily the first time auto-save persists real content.
  let draftId = draft?.id || null;
  const hasPolicy = () => !!(taskCredPolicy.order?.length || taskCredPolicy.on?.length || taskCredPolicy.off?.length);
  // Prompt image attachments ride inside `params` (references only), so they flow
  // through auto-save, draft, and queue the same way the prompt text does.
  const formState = () => {
    const body = collectForm($('#tf-body'), fields);
    if (formImages.length) body.images = [...formImages];
    return { body, notes: $('#tf-notes')?.value ?? '' };
  };
  // Whether the user has actually put something worth keeping into a NEW task —
  // guards against spawning empty drafts just from opening the form.
  const hasContent = ({ body, notes }) =>
    notes.trim() !== '' ||
    hasPolicy() ||
    formImages.length > 0 ||
    Object.values(body).some((v) =>
      Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null && typeof v !== 'boolean');

  // Persist the current form as a draft without leaving the form. Silent by
  // design — auto-save shouldn't nag; the explicit buttons surface errors.
  let lastSaved = null;
  async function persistDraft(st = formState()) {
    if (!draftId && !hasContent(st)) return; // nothing worth creating a draft for yet
    const sig = JSON.stringify(st) + (localCred ? JSON.stringify(taskCredPolicy) : '');
    if (sig === lastSaved) return; // no change since last write
    try {
      if (!draftId) {
        const created = await api(`/api/projects/${S.projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, draft: true }) });
        draftId = created.id;
      } else {
        await api(`/api/tasks/${draftId}/params`, { method: 'PATCH', body: JSON.stringify({ params: st.body, replace: true }) });
        await api(`/api/tasks/${draftId}/notes`, { method: 'PATCH', body: JSON.stringify({ notes: st.notes }) });
      }
      if (localCred && hasPolicy()) await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: draftId, policy: taskCredPolicy }) });
      lastSaved = sig;
      refreshTasks();
    } catch { /* keep the form open; a later save or explicit button will retry */ }
  }

  // Debounced auto-save while typing.
  let saveTimer = null;
  function autoSaveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persistDraft(), 800); }
  $('#tf-body').addEventListener('input', autoSaveSoon);
  $('#tf-body').addEventListener('change', autoSaveSoon);

  // Flush any pending edits when the form is dismissed, so closing without
  // clicking a button still keeps the draft.
  closeForm = () => { clearTimeout(saveTimer); const st = formState(); root.innerHTML = ''; persistDraft(st); };

  const submit = async (draftMode) => {
    clearTimeout(saveTimer);
    const st = formState();
    try {
      if (draftId) {
        // Auto-save (or a prior edit) already materialised the draft — update it in place.
        await api(`/api/tasks/${draftId}/params`, { method: 'PATCH', body: JSON.stringify({ params: st.body, replace: true }) });
        await api(`/api/tasks/${draftId}/notes`, { method: 'PATCH', body: JSON.stringify({ notes: st.notes }) });
        if (localCred && hasPolicy()) await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: draftId, policy: taskCredPolicy }) });
        if (!draftMode) await api(`/api/tasks/${draftId}/queue`, { method: 'POST', body: '{}' });
      } else if (hasPolicy()) {
        // Custom per-task credential order/enablement: create as a draft first so the
        // override is persisted BEFORE the workflow starts leasing, then queue.
        const created = await api(`/api/projects/${S.projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, draft: true }) });
        draftId = created.id;
        await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: created.id, policy: taskCredPolicy }) });
        if (!draftMode) await api(`/api/tasks/${created.id}/queue`, { method: 'POST', body: '{}' });
      } else {
        await api(`/api/projects/${S.projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, draft: draftMode }) });
      }
      root.innerHTML = '';
      toast(draftMode ? 'Draft saved' : 'Task created');
      refreshTasks();
    } catch (e) { toast(e.message, true); }
  };
  $('#tf-draft').addEventListener('click', () => submit(true));
  $('#tf-queue').addEventListener('click', () => submit(false));
}

// ── drawer ───────────────────────────────────────────────────────────────────
async function openDrawer(taskId) {
  S.selected = taskId;
  S.drawerEvents = [];
  // Reset the live-output accumulator on task switch. It's only cleared by a
  // turn.result/view.updated event for the *selected* task (see the WS handler),
  // so without this a still-streaming previous task's bubble (e.g. a Merge agent's
  // "let me merge master into this branch") bleeds into THIS drawer's live bubble
  // until the next event arrives — a stale cross-task render, never in the store/.jsonl.
  S.liveOutput = '';
  // Drop the previous task's view + per-task derived state up front. `S.view` is
  // re-fetched first below, but the siblings (sessions/widgets/paramDefaults) are
  // fetched a few awaits later — so a render firing in that gap (a WS event, a
  // background refresh) would pair the NEW view with the OLD task's fork command /
  // widgets / param defaults. renderDrawer no-ops while `S.view` is null, and empty
  // siblings render as "no command / no widgets / (default)" — both corrected a beat
  // later by the awaited fetches. Never show another task's data, even for one frame.
  S.view = null;
  S.sessions = {};
  S.widgets = [];
  S.paramDefaults = {};
  highlightRow();
  try {
    S.view = await api(`/api/tasks/${taskId}`);
    S.drawerEvents = await api(`/api/tasks/${taskId}/events?since=0`);
    S.widgets = await api(`/api/tasks/${taskId}/widgets`).catch(() => []);
    S.sessions = await api(`/api/tasks/${taskId}/sessions`).catch(() => ({}));
    S.paramDefaults = await loadParamDefaults(taskId);
  } catch (e) { toast(e.message, true); }
  renderDrawer();
}
async function refreshDrawer() {
  if (!S.selected) return;
  try {
    S.view = await api(`/api/tasks/${S.selected}`);
    S.widgets = await api(`/api/tasks/${S.selected}/widgets`).catch(() => S.widgets);
    S.sessions = await api(`/api/tasks/${S.selected}/sessions`).catch(() => S.sessions);
    S.paramDefaults = await loadParamDefaults(S.selected);
  } catch {}
  renderDrawer();
}
// Close the drawer by navigating back to the underlying list/queue; applyRoute()
// then tears the drawer DOM down. Kept as a navigation so the URL + history stay
// in sync (the ✕ button, the scrim, Esc and the palette all route through here).
function closeDrawer() {
  const pid = (S.view && S.tasks.find((t) => t.id === S.view.taskId)?.projectId) || S.projectId;
  const back = S.returnRoute || (pid ? projectRoute(pid) : '/dashboard');
  S.returnRoute = null;
  return go(back, { replace: true });
}
// Tear down the drawer DOM without navigating (called by applyRoute()).
function closeDrawerDom() {
  if (!S.selected && !S.view) return;
  S.selected = null;
  S.view = null;
  S.liveOutput = ''; // drop any streamed live text so it can't reappear in the next drawer
  S.sessions = {}; S.widgets = []; S.paramDefaults = {}; // per-task derived state — don't carry into the next drawer
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
  // A background refresh (or a just-sent follow-up) re-renders the whole drawer,
  // which would otherwise reset the conversation scroll to the top and drop the
  // caret out of whatever follow-up box the user is composing in. Snapshot the
  // scroll offset + focused field first, then restore them after the swap so the
  // send-message box stays in view and in focus.
  const prevBody = document.getElementById('drawer-body');
  const prevScroll = prevBody ? prevBody.scrollTop : null;
  const focusState = captureFocus(root);
  // The per-agent follow-up textareas carry no id (captureFocus skips them), so
  // snapshot the active one by its agent role to re-focus the matching box after
  // the swap and carry over any half-typed follow-up.
  const fuState = captureFollowupFocus(root);
  root.innerHTML = `
    <div class="scrim open" id="scrim"></div>
    <aside class="drawer open">
      <div class="drawer-head">
        <div class="row1">
          ${v.num != null ? `<span class="task-num" title="Task #${v.num}${(() => { const p = projectById(S.tasks.find((t) => t.id === v.taskId)?.projectId || S.projectId); return p ? ` — permalink /projects/${projectSlug(p)}/tasks/${v.num}` : ''; })()}">#${v.num}</span>` : ''}
          <h2>${esc(v.title)}</h2>
          <span class="chip ${v.status}">${esc(stageLabel(v))}</span>
          <button class="icon-btn" id="drawer-close" title="Close (Esc)">✕</button>
        </div>
        <div class="meta">
          <span>${esc(v.workflow)}${(() => { const rec = S.tasks.find((t) => t.id === v.taskId); return rec?.workflowVersion ? ` <span class="mono" style="color:var(--ink-3)">v${esc(rec.workflowVersion)}</span>` : ''; })()}</span>
          ${customBranch(v, v.taskId) ? `<span>⎇ ${esc(v.branch)}</span>` : ''}
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
  wireFollowups(v);
  wireParams(v);
  wireNotes(v);
  wireTerminal(v.taskId);
  wireReviewActions(v);
  wireCopyButtons();
  renderCredentialEditor($('#cred-editor-task'), 'task', { projectId: S.tasks.find((t) => t.id === v.taskId)?.projectId || S.projectId, taskId: v.taskId });
  renderDrawerEvents();
  // Restore the pre-render scroll offset + focus so the send-message box the user
  // was working in stays put instead of jumping to the top of the conversation.
  const newBody = document.getElementById('drawer-body');
  if (newBody && prevScroll != null) newBody.scrollTop = prevScroll;
  restoreFocus(root, focusState);
  restoreFollowupFocus(root, fuState);
}

// Follow-up textareas live one-per-agent-conversation and are keyed by the agent
// role they address rather than an element id, so captureFocus/restoreFocus can't
// see them. These mirror that pair for the follow-up boxes.
function captureFollowupFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.classList || !el.classList.contains('followup-input')) return null;
  const box = el.closest('.followup-box');
  if (!box) return null;
  const st = { role: box.dataset.role || '', value: el.value };
  if (typeof el.selectionStart === 'number') { st.selectionStart = el.selectionStart; st.selectionEnd = el.selectionEnd; }
  return st;
}

function restoreFollowupFocus(root, st) {
  if (!st) return;
  const box = root.querySelector(`.followup-box[data-role="${window.CSS && CSS.escape ? CSS.escape(st.role) : st.role}"]`);
  const el = box && box.querySelector('.followup-input');
  if (!el || el.disabled) return;
  // Only carry over the value if the box was cleared by the re-render (a sent
  // follow-up empties it); never clobber text the box already holds.
  if (st.value && !el.value) el.value = st.value;
  el.focus();
  if (typeof st.selectionStart === 'number' && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(st.selectionStart, st.selectionEnd); } catch {}
  }
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

// ── review actions: click-to-verify buttons (run in the world / open artifacts) ──
function reviewActionBtn(a, i) {
  const isRun = a.kind === 'run';
  const icon = isRun ? (a.server ? '▶' : '⚡') : '↗';
  const label = `${icon} ${esc(a.label || (isRun ? 'Run' : 'Open'))}`;
  const title = isRun ? esc(a.command || '') : esc(a.target || '');
  return `<button class="btn sm review-action" data-idx="${i}" data-kind="${esc(a.kind)}" title="${title}">${label}</button>`;
}

let reviewActionWs = null;
async function openArtifact(url, external) {
  if (external) { window.open(url, '_blank', 'noopener'); return; }
  // Artifact endpoints need the auth header, so fetch as a blob then open it.
  try {
    const res = await fetch(url, { headers: S.token ? { authorization: `Bearer ${S.token}` } : {} });
    if (!res.ok) { toast('could not open artifact', true); return; }
    const obj = URL.createObjectURL(await res.blob());
    window.open(obj, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(obj), 60_000);
  } catch (e) { toast(e.message, true); }
}
function wireReviewActions(v) {
  const wrap = document.getElementById('review-actions');
  if (!wrap) return;
  const out = document.getElementById('review-action-out');
  wrap.querySelectorAll('.review-action').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-idx'));
      const kind = btn.getAttribute('data-kind');
      try {
        const r = await api(`/api/tasks/${v.taskId}/review-action`, { method: 'POST', body: JSON.stringify({ index: idx }) });
        if (kind === 'open') { openArtifact(r.url, r.external); return; }
        // kind === 'run': stream output; open follow-up URLs; offer Stop.
        if (out) { out.classList.remove('hidden'); out.textContent = `$ (running "${btn.textContent.trim()}")\n`; }
        if (reviewActionWs) { try { reviewActionWs.close(); } catch {} }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws/review-action?procId=${encodeURIComponent(r.procId)}`);
        reviewActionWs = ws;
        ws.onmessage = (m) => {
          try {
            const msg = JSON.parse(m.data);
            if (!out) return;
            if (msg.type === 'data') { out.textContent += stripAnsi(msg.data); out.scrollTop = out.scrollHeight; }
            else if (msg.type === 'exit') { out.textContent += `\n[exited: code ${msg.code}]\n`; setStopBtn(false); }
          } catch {}
        };
        ws.onclose = () => setStopBtn(false);
        setStopBtn(true, r.procId, v.taskId);
        // A server keeps running — open its pages once it's had a moment to boot.
        if (r.server && Array.isArray(r.openUrls)) {
          setTimeout(() => r.openUrls.forEach((u) => window.open(u, '_blank', 'noopener')), 1500);
        } else if (Array.isArray(r.openUrls) && r.openUrls.length) {
          r.openUrls.forEach((u) => window.open(u, '_blank', 'noopener'));
        }
      } catch (e) { toast(e.message, true); }
    });
  });
}
function setStopBtn(running, procId, taskId) {
  const wrap = document.getElementById('review-actions');
  if (!wrap) return;
  let stop = document.getElementById('review-action-stop');
  if (!running) { if (stop) stop.remove(); return; }
  if (!stop) {
    stop = document.createElement('button');
    stop.id = 'review-action-stop';
    stop.className = 'btn sm danger';
    stop.textContent = '■ Stop';
    wrap.appendChild(stop);
  }
  stop.onclick = async () => {
    try { await api(`/api/tasks/${taskId}/review-action/${procId}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, true); }
  };
}

function drawerBody(v) {
  // Show every agent's conversation (Do / Merge / Resolve), collapsed except the
  // one owning the active stage (SPEC §5.5). Falls back to `messages` (Do) for
  // tasks whose workflow predates per-role transcripts.
  const activeRole = roleForStage(v.stage);
  // The follow-up affordance (SPEC §5.6) now lives INSIDE each agent's conversation
  // rather than as one shared box at the bottom of the drawer — so a human can address
  // any agent (Do / Merge / Resolve), not just Do. Enablement follows the workflow's
  // declared `followUp` action.
  const followUp = (v.actions || []).find((a) => a.name === 'followUp');
  const transcripts = (v.transcripts && v.transcripts.length)
    ? v.transcripts
    : [{ role: 'do', label: 'Conversation', messages: v.messages || [] }];
  const liveRole = transcripts.some((t) => t.role === activeRole) ? activeRole : (transcripts[0] && transcripts[0].role);
  const conversations = transcripts
    .map((t) => {
      const body = (t.messages || [])
        .map((m) => `<div class="msg ${m.role}"><div class="role">${esc(m.role)}</div>${esc(m.text)}${renderMessageImages(m.images)}</div>`)
        .join('') || '<div class="msg system">No messages yet</div>';
      // Only the active role gets the #live-bubble (one per drawer, updated by the WS stream).
      const live = t.role === liveRole
        ? `<div class="msg agent ${S.liveOutput && v.status === 'active' ? '' : 'hidden'}" id="live-bubble"><div class="role">agent · live</div>${esc(S.liveOutput)}</div>`
        : '';
      // Only subscription/CLI sessions carry a config home; API-key / stateless
      // sessions can't be forked from a terminal, so no command is shown. The session
      // id is published mid-turn (#3), so this appears WHILE the agent runs.
      const sess = S.sessions && S.sessions[t.role];
      const forkCmd = sess?.id && sess?.home && v.worldPath ? forkCommandFor(sess, v.worldPath) : '';
      const copy = forkCmd
        ? `<button class="btn sm copy-cmd" data-cmd="${esc(forkCmd)}" title="Copy a CLI command to fork this agent into your terminal — a branched copy, safe to open even while it's running">⑂ fork cmd</button>`
        : '';
      // The follow-up affordance lives INSIDE each agent's conversation (SPEC §5.6),
      // so a human can address any agent — Do, Merge or Resolve — not just Do. It
      // appears only when the workflow currently allows follow-ups.
      const agentName = esc(t.label || t.role);
      const fu = followUp
        ? `<div class="followup-box" data-role="${esc(t.role)}">
            <div class="prompt-field">
              <textarea class="followup-input" placeholder="Send a follow-up to ${agentName}…  (paste an image to attach)" ${followUp.enabled ? '' : 'disabled'}></textarea>
              <div class="img-chips followup-chips" style="display:none"></div>
            </div>
            <button class="btn primary followup-send" ${followUp.enabled ? '' : 'disabled'}>Send</button>
          </div>`
        : '';
      return `<details class="conversation" ${t.role === liveRole ? 'open' : ''}>
        <summary class="section-h" style="cursor:pointer;display:flex;align-items:center;gap:8px">
          <span>${agentName} (${(t.messages || []).length})</span>${copy}
        </summary>
        <div class="thread">${body}${live}</div>
        ${fu}
      </details>`;
    })
    .join('');
  const caption = v.reviewInfo?.caption || v.reviewInfo?.summary;
  const review = v.reviewInfo
    ? `<div class="section-h">Review</div>
       <div class="review">
         ${caption ? `<div class="summary">${esc(caption)}</div>` : ''}
         ${v.reviewInfo.actions?.length ? `<div class="review-actions" id="review-actions">${v.reviewInfo.actions.map((a, i) => reviewActionBtn(a, i)).join('')}</div>
         <pre class="raw hidden" id="review-action-out" style="height:180px"></pre>` : ''}
         ${v.reviewInfo.changedFiles?.length ? `<div class="task-sub" style="flex-wrap:wrap;margin:8px 0">${v.reviewInfo.changedFiles.map((f) => `<span class="branch">${esc(f)}</span>`).join('')}</div>` : ''}
         ${v.reviewInfo.links?.length ? `<div class="links">${v.reviewInfo.links.map((l) => `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>` : ''}
         ${v.reviewInfo.html ? `<iframe sandbox="allow-scripts" srcdoc="${esc(v.reviewInfo.html)}"></iframe>` : ''}
       </div>`
    : '';
  const error = v.error ? `<div class="section-h">Error</div><div class="diff del">${esc(v.error)}</div>` : '';
  const waiting = v.waitingFor
    ? `<div class="section-h">Waiting</div><div class="card" style="color:var(--ink-2)">⏳ Waiting for ${esc(waitingLabel(v.waitingFor))}${v.waitingFor.earliestResetAt ? ` · earliest ${esc(fmtReset(v.waitingFor.earliestResetAt))}` : ''}</div>`
    : '';
  const subtasks = v.subTasks?.length
    ? `<div class="section-h">Sub-tasks</div>${v.subTasks.map((id) => `<div class="task-sub"><span class="branch" data-open="${id}" style="cursor:pointer">↳ ${esc(numLabel(id))}</span></div>`).join('')}`
    : '';
  return `
    <div class="section-h">Pipeline</div>
    ${pipelineLarge(v)}
    ${error}
    ${waiting}
    ${drawerNotes(v)}
    ${drawerParams(v)}
    ${review}
    ${renderWidgetGroups(S.widgets)}
    ${subtasks}
    ${conversations}
    <details class="advanced">
      <summary>Credentials — precedence &amp; enable/disable for this task</summary>
      <p class="task-sub" style="color:var(--ink-3);margin-top:0">Overrides the global/project order + enablement, just for this task. Drag to reorder; toggle On/Off. (This is the running-task form — the new-task form has the same control.)</p>
      <div id="cred-editor-task">Loading…</div>
    </details>
    <details class="advanced">
      <summary>Advanced — terminal, live event log, structured state</summary>
      <div class="section-h">Terminal — open a shell in the world (ephemeral)</div>
      <div class="task-sub" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm" id="term-open" ${v.worldPath ? '' : 'disabled'}>${v.worldPath ? 'Open terminal' : 'No world yet'}</button>
        ${v.worldPath ? `<button class="btn sm copy-cmd" data-cmd="${esc(`cd ${v.worldPath} && $SHELL`)}" title="Copy a shell command to open this world in your own terminal">⧉ Copy command</button>` : ''}
      </div>
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

// Human label for a "waiting for" indicator (SPEC §6.2).
function waitingLabel(w) {
  if (!w) return '';
  switch (w.kind) {
    case 'account': return `a ${w.provider || 'compatible'} login (quota refresh)`;
    case 'mergeSlot': return 'a merge slot';
    case 'human': return 'human input';
    case 'subtask': return 'its sub-tasks to finish (or raise)';
    case 'subagent': return w.detail || 'its sub-agents to finish';
    case 'parent': return 'the parent task to respond';
    case 'confirm': return 'the confirm agent to review';
    default: return w.detail || w.kind;
  }
}

// A CLI command to FORK this agent's session into the user's terminal — a branched
// copy that's safe to open even while the agent is running (it never mutates the live
// session). Claude: --resume … --fork-session; Codex: `codex fork <id>` (SPEC §10.5, #3).
function forkCommandFor(sess, worldPath) {
  if (sess.provider === 'codex') return `cd "${worldPath}" && CODEX_HOME="${sess.home}" codex fork ${sess.id}`;
  return `cd "${worldPath}" && CLAUDE_CONFIG_DIR="${sess.home}" claude --resume ${sess.id} --fork-session`;
}

// Credential-policy editor (SPEC §7/§9): order credentials by precedence and
// enable/disable each, at a given scope (global/project/task). Lower scopes override
// higher ones; API keys are off by default when a subscription exists.
async function renderCredentialEditor(el, scope, opts = {}) {
  if (!el) return;
  const q = new URLSearchParams();
  if (opts.projectId) q.set('projectId', opts.projectId);
  if (opts.taskId) q.set('taskId', opts.taskId);
  let data, accounts = { logins: [] };
  try {
    [data, accounts] = await Promise.all([
      api(`/api/credentials?${q.toString()}`),
      api('/api/accounts').catch(() => ({ logins: [] })),
    ]);
  } catch { el.innerHTML = '<div class="task-sub" style="color:var(--ink-3)">Credentials unavailable.</div>'; return; }
  // Effective policy for this scope. Normally the server computes it (global→project→
  // task overlay). In `local` mode — the NEW-task form, which has no taskId yet — we
  // resolve a client-side draft policy over the inherited project/global base and apply
  // it when the task is created, so the reorder/enable-disable UI works inline here too.
  let sd;
  if (opts.local) {
    const base = data[opts.projectId ? 'project' : 'global'] || { enabled: [] };
    const baseEnabled = new Set(base.enabled || []);
    const pol = opts.policy || {};
    const onSet = new Set(pol.on || []), offSet = new Set(pol.off || []);
    const isOn = (k) => (onSet.has(k) ? true : offSet.has(k) ? false : baseEnabled.has(k));
    const seen = new Set(), eff = [];
    for (const k of [...(pol.order || []), ...(base.enabled || []), ...(data.credentials || []).map((c) => c.key)]) {
      if (!seen.has(k) && isOn(k) && !eff.includes(k)) eff.push(k);
    }
    sd = { own: pol, enabled: eff };
  } else {
    sd = data[scope] || { own: {}, enabled: [] };
  }
  const own = sd.own || {};
  const enabled = new Set(sd.enabled || []);
  const byKey = Object.fromEntries((data.credentials || []).map((c) => [c.key, c]));
  // enabled creds in precedence order first, then the disabled ones.
  const ordered = [...(sd.enabled || []).filter((k) => byKey[k]), ...(data.credentials || []).map((c) => c.key).filter((k) => !enabled.has(k))];
  if (!ordered.length) { el.innerHTML = '<div class="task-sub" style="color:var(--ink-3)">No credentials yet — connect a login or add an API key below.</div>'; return; }
  const loginByKey = {};
  for (const l of accounts.logins || []) loginByKey[`login:${l.provider}:${l.account}`] = l;
  const canManage = scope === 'global'; // rename/delete a login only at the global scope
  el.innerHTML = `<div class="cred-list">${ordered
    .map((key) => {
      const c = byKey[key];
      const isOn = enabled.has(key);
      const login = loginByKey[key];
      const warn = login && !login.loggedIn ? ' <span style="color:var(--warn,#e0b15a)">·oauth</span>' : '';
      const acct = canManage && c.kind === 'login';
      // Compact inline chip: the kind is obvious from the label (a login is
      // provider:account; ambient is its home path; a key gets a 🔑), so no chip.
      const label = c.kind === 'ambient' ? (c.provider === 'codex' ? '~/.codex' : '~/.claude') : c.label;
      const icon = c.kind === 'key' ? '🔑 ' : '';
      return `<div class="cred-row${isOn ? '' : ' off'}" draggable="true" data-key="${esc(key)}" title="${esc(c.provider)} ${esc(c.kind)} · drag to set precedence">
        <span class="cred-drag">⠿</span>
        <button class="cred-toggle ${isOn ? 'on' : 'off'}" title="${isOn ? 'Enabled — click to disable' : 'Disabled — click to enable'}">${isOn ? 'on' : 'off'}</button>
        <span class="cred-label mono">${icon}${esc(label)}${warn}</span>
        ${acct ? '<span class="cred-rename" title="Rename login">✎</span><span class="cred-del" title="Delete login">✕</span>' : ''}
      </div>`;
    })
    .join('')}</div>`;
  const save = async (policy) => {
    // Local mode: keep the change client-side (applied when the task is created); else
    // persist immediately, keyed by taskId/projectId scope.
    if (opts.local) { opts.onChange?.(policy); renderCredentialEditor(el, scope, { ...opts, policy }); return; }
    try { await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope, projectId: opts.projectId, taskId: opts.taskId, policy }) }); }
    catch (e) { toast(e.message, true); }
    renderCredentialEditor(el, scope, opts);
  };
  el.querySelectorAll('.cred-row').forEach((row) => {
    const key = row.dataset.key;
    row.querySelector('.cred-toggle').addEventListener('click', () => {
      const on = new Set(own.on || []), off = new Set(own.off || []);
      if (!enabled.has(key)) { on.add(key); off.delete(key); } else { off.add(key); on.delete(key); }
      save({ ...own, on: [...on], off: [...off] });
    });
    const login = loginByKey[key];
    row.querySelector('.cred-rename')?.addEventListener('click', async () => {
      const to = prompt(`Rename login ${login.account} to:`, login.account);
      if (!to || to === login.account) return;
      try { await api(`/api/accounts/logins/${login.provider}/${encodeURIComponent(login.account)}`, { method: 'PATCH', body: JSON.stringify({ account: to }) }); toast('Login renamed'); renderCredentialEditor(el, scope, opts); }
      catch (e) { toast(e.message, true); }
    });
    row.querySelector('.cred-del')?.addEventListener('click', async () => {
      if (!confirm(`Delete login ${login.provider}:${login.account}? Its stored credentials are removed.`)) return;
      try { await api(`/api/accounts/logins/${login.provider}/${encodeURIComponent(login.account)}`, { method: 'DELETE' }); toast('Login deleted'); renderCredentialEditor(el, scope, opts); }
      catch (e) { toast(e.message, true); }
    });
  });
  // Drag-to-reorder → precedence order for this scope.
  wireCredDrag(el.querySelector('.cred-list'), (order) => save({ ...own, order }));
}

// HTML5 drag-and-drop reordering for the credential rows; calls onReorder(keys[]) on drop.
function wireCredDrag(list, onReorder) {
  if (!list) return;
  let dragging = null;
  list.querySelectorAll('.cred-row').forEach((row) => {
    row.addEventListener('dragstart', (e) => { dragging = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.key); } catch {} });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragging = null; });
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragging) return;
    // Reading-order insertion for a wrapping (inline) list: the nearest chip whose
    // center is AFTER the cursor (next row, or further right on the same row).
    let best = null, bestDist = Infinity;
    for (const el of list.querySelectorAll('.cred-row:not(.dragging)')) {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const sameRow = Math.abs(cy - e.clientY) <= b.height / 2;
      const after = cy - e.clientY > b.height / 2 || (sameRow && cx > e.clientX);
      if (!after) continue;
      const d = Math.hypot(cx - e.clientX, cy - e.clientY);
      if (d < bestDist) { bestDist = d; best = el; }
    }
    best ? list.insertBefore(dragging, best) : list.appendChild(dragging);
  });
  list.addEventListener('drop', (e) => { e.preventDefault(); onReorder([...list.querySelectorAll('.cred-row')].map((r) => r.dataset.key)); });
}

// Which agent role "owns" a given stage — drives which transcript opens by default.
function roleForStage(s) {
  if (s === 'resolve') return 'resolve';
  if (s === 'pr' || s === 'merge') return 'merge';
  return 'do';
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  return Promise.resolve();
}

// Copy-command buttons (⧉): copy a shell command to the clipboard without toggling
// any enclosing <details>/<summary>.
function wireCopyButtons() {
  document.querySelectorAll('.copy-cmd').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(btn.dataset.cmd || '').then(() => {
        const prev = btn.textContent;
        btn.textContent = '✓ copied';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      });
    });
  });
}

// ── the host widget library (SPEC §10.2 tier 2): draw server-resolved widget
// descriptors. The host owns NO resolve logic — it just renders what's declared,
// so any conforming workflow gets a richer-than-floor UI with no bespoke code.
function renderWidgetGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return '';
  return groups
    .map((g) => `<div class="section-h">${esc(g.title || g.workflow)}</div>${(g.widgets || []).map(renderWidget).join('')}`)
    .join('');
}
function renderWidget(w) {
  const empty = (s) => `<div class="task-sub" style="color:var(--ink-3)">${esc(s || '—')}</div>`;
  const head = w.title ? `<div class="wk-title" style="font-size:11px;color:var(--ink-3);margin:6px 0 2px">${esc(w.title)}</div>` : '';
  const d = w.data;
  switch (w.type) {
    case 'text':
      return head + (d ? `<div class="wk-text">${esc(d)}</div>` : empty(w.empty));
    case 'badge':
      return head + (d ? `<span class="chip">${esc(d)}</span>` : empty(w.empty));
    case 'keyValue':
      return head + (Array.isArray(d) && d.length
        ? `<div class="wk-kv">${d.map((r) => `<div class="task-sub"><b>${esc(r.label)}</b>: ${esc(r.value)}</div>`).join('')}</div>`
        : empty(w.empty));
    case 'list':
      return head + (Array.isArray(d) && d.length
        ? `<div class="task-sub" style="flex-wrap:wrap">${d.map((x) => `<span class="branch">${esc(x)}</span>`).join('')}</div>`
        : empty(w.empty));
    case 'table':
      return head + (d && d.rows && d.rows.length
        ? `<table class="wk-table"><thead><tr>${d.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
          + `<tbody>${d.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : empty(w.empty));
    case 'thread':
      return head + (Array.isArray(d) && d.length
        ? `<div class="thread">${d.map((m) => `<div class="msg ${esc(m.role)}"><div class="role">${esc(m.role)}</div>${esc(m.text)}</div>`).join('')}</div>`
        : empty(w.empty));
    case 'diff':
      return head + (d ? `<div class="diff">${renderDiff(d)}</div>` : empty(w.empty));
    case 'gauge': {
      const g = d || { value: 0, max: 0, pct: 0 };
      return head + `<div class="wk-gauge" title="${g.value} / ${g.max}">
        <div class="wk-gauge-bar" style="background:var(--surface-2);border-radius:6px;height:10px;overflow:hidden">
          <div style="width:${g.pct}%;height:100%;background:var(--accent,#5b8cff)"></div></div>
        <div class="task-sub" style="color:var(--ink-3)">${g.max ? `${g.value} / ${g.max}` : 'n/a'}</div></div>`;
    }
    default:
      return '';
  }
}

// ── in-flight parameters form (SPEC §5.5 / §10.4) ────────────────────────────
// The task's declared params, editable or frozen per the workflow's lifecycle.
// Editable fields (view.editableParams) get a live control + Save; everything
// else — prompt, base, agents — is shown read-only, because those are baked into
// the task at queue and only a follow-up can redirect the agent afterwards.
const TERMINAL_STAGES = ['done', 'cancelled', 'failed'];
// The resolved inherited defaults for the open task's workflow (task scope),
// same source the New-task / settings forms use, so frozen fields show the real
// effective value (e.g. the actual Do-agent provider·model) not "(default)".
async function loadParamDefaults(taskId) {
  const wf = S.view?.workflow;
  const pid = S.tasks.find((t) => t.id === taskId)?.projectId || S.projectId;
  if (!wf || !pid) return {};
  return api(`/api/defaults/${pid}/${wf}`).then((d) => d?.task?.inherited || {}).catch(() => ({}));
}
// Free-form human notes (cosmetic, UI-only — never sent to any agent). Editable
// at ANY stage (active, done, cancelled, failed, archived) — the endpoint has no
// stage guard. The current value comes from the freshly-fetched view (`v.notes`),
// so it's correct even for a task not in the loaded list.
function drawerNotes(v) {
  const notes = v.notes || '';
  return `<div class="section-h">Notes</div>
    <div id="drawer-notes">
      <textarea id="task-notes" rows="3" placeholder="Jot down anything for yourself — not sent to the agent" style="width:100%">${esc(notes)}</textarea>
      <div class="task-sub" style="margin-top:4px;justify-content:space-between">
        <span style="color:var(--ink-3)">Only you see this — never sent to the agent.</span>
        <button class="btn sm" id="notes-save">Save notes</button>
      </div>
    </div>`;
}

function wireNotes(v) {
  const ta = document.getElementById('task-notes');
  const btn = document.getElementById('notes-save');
  if (!ta || !btn) return;
  const save = async () => {
    const notes = ta.value;
    if ((v.notes || '') === notes) return; // no change
    try {
      await api(`/api/tasks/${v.taskId}/notes`, { method: 'PATCH', body: JSON.stringify({ notes }) });
      v.notes = notes || undefined; // keep the in-memory view in sync
      const rec = S.tasks.find((t) => t.id === v.taskId);
      if (rec) rec.notes = notes || undefined;
      toast('Notes saved');
    } catch (e) {
      toast(e.message, true);
    }
  };
  btn.addEventListener('click', save);
  // Save on blur too, so notes aren't lost when the drawer closes.
  ta.addEventListener('blur', save);
}

function drawerParams(v) {
  const rec = S.tasks.find((t) => t.id === v.taskId);
  // Drafts are composed in the full task form (all fields editable pre-queue).
  if (rec?.params?.draft) {
    return `<div class="section-h">Parameters</div>
      <button class="btn sm" id="edit-draft-params">Edit parameters…</button>`;
  }
  if (TERMINAL_STAGES.includes(v.stage)) return '';
  const fields = schemaFor(v.workflow).filter((f) => f.scopes.includes('task'));
  if (!fields.length) return '';
  const editable = new Set(v.editableParams || []);
  const inheritedAll = S.paramDefaults || {};
  const lock = `<span title="Frozen — this parameter has already been used (send a follow-up to change direction)" style="color:var(--ink-3)">🔒</span>`;
  const rows = fields
    .map((f) => {
      const own = paramCurrentValue(f, v, rec);
      const inherited = inheritedAll[f.name];
      const isEditable = editable.has(f.name);
      // Agent fields show the full control (provider · model · effort · resume),
      // exactly like the task form — interactive when editable, disabled when frozen.
      if (f.type === 'agent') {
        const control = renderField(f, own, inherited); // full control incl. its own label
        if (isEditable) return `<div class="pf-edit-row" data-row="${esc(f.name)}">${control}</div>`;
        // frozen: same control, disabled (read-only), with a lock in the corner
        return `<div class="form-row" data-row="${esc(f.name)}" style="position:relative">
          <span style="position:absolute;right:0;top:0" title="Frozen — this agent has already run (send a follow-up to change direction)">🔒</span>
          <fieldset disabled style="border:none;padding:0;margin:0;min-inline-size:auto;opacity:.65">${control}</fieldset></div>`;
      }
      if (isEditable) return `<div class="pf-edit-row" data-row="${esc(f.name)}">${renderField(f, own, inherited)}</div>`;
      // frozen non-agent: read-only effective value (own override, else inherited default)
      return `<div class="form-row"><div class="label-row"><label>${esc(f.label)}</label>${lock}</div>
        <div class="pf-ro" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere">${esc(displayParam(f, eff(own, inherited)))}</div></div>`;
    })
    .join('');
  const footer = editable.size
    ? `<button class="btn sm primary" id="params-save">Save changes</button>`
    : `<div class="task-sub" style="color:var(--ink-3)">Locked after queue — send a follow-up to change direction.</div>`;
  return `<div class="section-h">Parameters</div><div id="drawer-params">${rows}${footer}</div>`;
}

// Best-known current value of a param for a running task (the view carries a few;
// the task record holds the rest of the user's own overrides).
function paramCurrentValue(f, v, rec) {
  const own = (rec && rec.params) || {};
  if (f.bind === 'prompt') return own.prompt ?? (v.messages || []).find((m) => m.role === 'user')?.text ?? '';
  if (f.name === 'target') return v.targetBranch ?? own.target ?? '';
  if (f.name === 'base') return v.base ?? own.base ?? '';
  return own[f.name];
}
function displayParam(f, val) {
  if (val === undefined || val === null || val === '') return '(default)';
  if (f.type === 'agent') return [val.provider, val.model].filter(Boolean).join(' · ') || '(default)';
  if (Array.isArray(val)) return val.join(', ') || '(none)';
  if (typeof val === 'boolean') return val ? 'on' : 'off';
  return String(val);
}
// Read back the editable param controls as a patch (no inherit-diffing — these
// are concrete live values, not overlay overrides).
function collectParamEdits(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'agent') {
      // Reconstruct the AgentSpec from the composite control (same shape the task
      // form's collectForm produces). Editable agent fields always send a spec.
      const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      const spec = { provider: box.querySelector('.af-provider').value };
      const model = box.querySelector('.af-model').value.trim();
      const effort = box.querySelector('.af-effort')?.value;
      if (model) spec.model = model;
      if (effort) spec.effort = effort;
      const sessionId = box.querySelector('.af-resume-session')?.value.trim();
      const chosen = box.querySelector('.af-resume-chosen')?.textContent.trim();
      let resumeFrom;
      if (chosen) { try { resumeFrom = JSON.parse(chosen); } catch {} }
      if (sessionId) resumeFrom = { ...(resumeFrom || {}), sessionId };
      if (resumeFrom) spec.resumeFrom = resumeFrom;
      out[f.name] = spec;
      continue;
    }
    const el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
    if (!el) continue;
    let val;
    if (f.type === 'boolean') val = el.checked;
    else if (f.type === 'list') val = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if (f.type === 'number') val = el.value === '' ? undefined : Number(el.value);
    else val = el.value.trim() === '' ? undefined : el.value.trim();
    if (val !== undefined) out[f.name] = val;
  }
  return out;
}
function wireParams(v) {
  const editBtn = document.getElementById('edit-draft-params');
  if (editBtn) {
    const rec = S.tasks.find((t) => t.id === v.taskId);
    editBtn.addEventListener('click', () => openTaskForm(v.workflow, rec));
    return;
  }
  const root = document.getElementById('drawer-params');
  if (root) wireAgentFields(root); // make editable agent controls (model combo, effort, resume) work
  const saveBtn = document.getElementById('params-save');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async () => {
    const fields = schemaFor(v.workflow).filter((f) => f.scopes.includes('task') && (v.editableParams || []).includes(f.name));
    const patch = collectParamEdits(root, fields);
    if (!Object.keys(patch).length) return toast('No changes');
    try {
      await api(`/api/tasks/${v.taskId}/params`, { method: 'PATCH', body: JSON.stringify({ params: patch }) });
      toast('Parameters updated');
      setTimeout(refreshDrawer, 250);
      setTimeout(refreshTasks, 400);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// the generic auto-render floor (SPEC §10.2 tier 1): render declared actions
function drawerActions(v) {
  const acts = v.actions || [];
  const simple = acts.filter((a) => !a.args || a.args.length === 0);
  let html = `<div class="actions">`;
  let slot = 0; // digits 1–9 press the Nth ENABLED button (see the command registry)
  for (const a of simple) {
    const cls = a.name === 'confirm' ? 'primary' : a.danger ? 'danger' : '';
    const kbd = a.enabled && slot < 9 ? `<span class="kbd">${++slot}</span>` : '';
    html += `<button class="btn ${cls}" data-act="${a.name}" ${a.enabled ? '' : 'disabled'}>${esc(a.label)}${kbd}</button>`;
  }
  // Target-branch editing now lives in the Parameters form (drawerParams), which
  // renders it editable/frozen per the workflow's window — no separate input here.
  // The follow-up box is no longer here either: it lives inside each agent's
  // conversation (drawerBody), so a human can address any agent (SPEC §5.6).
  html += `</div>`;
  if (!acts.length) html = `<div style="color:var(--ink-3)">No actions available — task is ${esc(v.stage)}.</div>`;
  return html;
}

function wireActions(v) {
  $('#drawer-foot').querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        await api(`/api/tasks/${v.taskId}/signal`, { method: 'POST', body: JSON.stringify({ signal: act }) });
        toast(`${act} sent`);
        setTimeout(refreshDrawer, 250);
        setTimeout(refreshTasks, 400);
      } catch (e) { toast(e.message, true); }
    }),
  );
  $('#drawer-body').querySelectorAll('[data-open]').forEach((e) => e.addEventListener('click', () => goToTask(e.dataset.open)));
}

// Wire the per-conversation follow-up boxes (SPEC §5.6): each box carries the
// agent role it addresses, so a follow-up is delivered to the right agent.
function wireFollowups(v) {
  if (!S.followupImages) S.followupImages = {};
  $('#drawer-body').querySelectorAll('.followup-box').forEach((box) => {
    const role = box.dataset.role;
    const ta = box.querySelector('.followup-input');
    const btn = box.querySelector('.followup-send');
    if (!ta || !btn) return;
    // Per-(task,role) image store, so pasted attachments survive the drawer's
    // frequent WS-driven re-renders (like the textarea text is preserved).
    const key = `${v.taskId}/${role}`;
    const store = (S.followupImages[key] ||= []);
    const chips = box.querySelector('.followup-chips');
    const paint = () => renderImageChips(chips, store);
    wireImagePaste(ta, () => store, paint);
    paint();
    const send = async () => {
      const text = ta.value.trim();
      if (!text && !store.length) return;
      try {
        await api(`/api/tasks/${v.taskId}/signal`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'followUp', text, role, ...(store.length ? { images: [...store] } : {}) }),
        });
        ta.value = '';
        store.length = 0;
        paint();
        toast('Follow-up sent');
        setTimeout(refreshDrawer, 250);
        setTimeout(refreshTasks, 400);
      } catch (e) { toast(e.message, true); }
    };
    btn.addEventListener('click', send);
    // ⌘/Ctrl-Enter sends, matching the rest of the console's compose affordances.
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } });
  });
}

function updateLiveBubble() {
  const b = document.getElementById('live-bubble');
  if (!b) return;
  b.classList.remove('hidden');
  b.innerHTML = `<div class="role">agent · live</div>${esc(S.liveOutput)}`;
  b.scrollIntoView({ block: 'nearest' });
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
      // Holds the slot (merge agent running) only when granted — not merely at
      // position 0 in a queue whose slot is still held by someone else.
      const merging = !!v.state?.mergeGranted;
      return `<div class="queue-item ${merging ? 'current' : ''}" data-id="${t.id}" tabindex="0">
        <span class="pos">${merging ? '▶' : pos > 0 ? `#${pos}` : '–'}</span>
        <div style="flex:1"><div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)} <span class="chip">${merging ? 'merging' : 'queued'}</span></div>
          <div class="task-sub"><span class="branch">${esc(v.branch || '')}</span> → <span class="branch">${esc(v.targetBranch || '')}</span></div></div>
        ${!merging && v.state?.mergeDomain ? `<button class="btn sm" data-prio="${t.id}" data-domain="${esc(v.state.mergeDomain)}">Prioritize</button>` : ''}
      </div>`;
    })
    .join('');
}
function wireQueueView() {
  $('#main').querySelectorAll('.queue-item').forEach((e) => e.addEventListener('click', (ev) => { if (!ev.target.dataset.prio) goToTask(e.dataset.id); }));
  $('#main').querySelectorAll('[data-prio]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await api('/api/queue/prioritize', { method: 'POST', body: JSON.stringify({ domain: b.dataset.domain, taskId: b.dataset.prio }) });
        toast('Prioritized'); setTimeout(refreshTasks, 300);
      } catch (e) { toast(e.message, true); }
    }),
  );
  applyCursor();
  $('#main').querySelectorAll('.queue-item').forEach((r) => r.addEventListener('focus', () => { S.cursorId = rowKey(r); applyCursor(); }));
}

// ── activity ─────────────────────────────────────────────────────────────────
async function seedActivity() {
  try { S.activity = (await api('/api/activity?since=0')).reverse(); renderMain(); } catch {}
}
function activityView() {
  if (!S.activity.length) return `<div class="empty"><div class="big">No activity yet</div>Events stream here as agents work.</div>`;
  return `<div class="card"><div class="events" style="max-height:none">${S.activity
    .slice(0, 300)
    .map((e) => `<div class="ev"><span class="t">${esc(e.type)}</span><span class="mono" style="color:var(--ink-3)">${esc(numLabel(e.taskId))}</span><span>${esc(summarize(e.payload))}</span></div>`)
    .join('')}</div></div>`;
}

// ── dashboard ────────────────────────────────────────────────────────────────
// Host diagnostics + agent-turn admission (GET /api/diagnostics). Reporting only:
// loadavg, free/total RAM, live agent-slot occupancy, and whether either pressure
// gate is currently holding new agent leases back (adaptive admission control).
function hostDiagHtml(diag) {
  if (!diag) return `<div class="card" style="color:var(--ink-3)">Diagnostics unavailable.</div>`;
  const h = diag.host || {};
  const s = diag.agentSlots || {};
  const load = (h.loadavg || []).map((n) => Number(n).toFixed(2)).join('  /  ');
  const loadStyle = s.loadHigh ? ' style="color:var(--danger)"' : '';
  const memStyle = s.memoryTight ? ' style="color:var(--danger)"' : '';
  const freeG = (Number(h.freeMemMb || 0) / 1024).toFixed(1);
  const totG = (Number(h.totalMemMb || 0) / 1024).toFixed(1);
  const gates = [];
  if (s.memoryTight) gates.push(`low free memory (< ${s.minFreeMb}MB)`);
  if (s.loadHigh) gates.push(`load above ${s.maxLoadFactor}× cores`);
  const gate = gates.length
    ? `<span class="chip waiting">⏸ holding new agent leases — ${esc(gates.join(' + '))}</span>`
    : `<span class="chip done">admitting agent turns</span>`;
  return `
    <div class="stat-grid">
      <div class="stat"><div class="n"${loadStyle}>${esc(load || '—')}</div><div class="l">Load avg · 1 / 5 / 15 min</div></div>
      <div class="stat"><div class="n"${loadStyle}>${Number(h.loadPerCore || 0).toFixed(2)}×</div><div class="l">Load per core · ${esc(String(h.cores ?? '?'))} cores</div></div>
      <div class="stat"><div class="n"${memStyle}>${freeG}G</div><div class="l">Free RAM · of ${totG}G (${esc(String(h.usedMemPct ?? '?'))}% used)</div></div>
      <div class="stat"><div class="n">${esc(String(s.inUse ?? '?'))}/${esc(String(s.capacity ?? '?'))}${s.waiting ? ` +${esc(String(s.waiting))}` : ''}</div><div class="l">Agent slots in use${s.waiting ? ` · ${esc(String(s.waiting))} waiting` : ''}</div></div>
    </div>
    <div class="task-sub" style="margin-top:8px">${gate}</div>`;
}

// Live-refresh just the host panel every 5s while the Dashboard is open. Self-
// terminates (no reschedule) once the tab changes or the element is gone.
async function refreshHostDiag() {
  if (S.tab !== 'dashboard' || !$('#host-diag')) return;
  let diag = null;
  try { diag = await api('/api/diagnostics'); } catch {}
  const el = $('#host-diag');
  if (el && S.tab === 'dashboard') el.innerHTML = hostDiagHtml(diag);
  if (S.tab === 'dashboard') { clearTimeout(S.hostDiagTimer); S.hostDiagTimer = setTimeout(refreshHostDiag, 5000); }
}

// ── processes (task manager) ─────────────────────────────────────────────────
// GET /api/processes: every process karmax is responsible for — agent
// subprocesses (and the scripts they run), embedded-terminal PTYs (and what's
// typed into them), the Temporal server, git/exec helpers — grouped by owning
// entity with live CPU% / RSS. Kill via POST /api/processes/kill (SIGTERM;
// shift-click for SIGKILL). Protected infrastructure gets no kill button.
const PROC_KIND_LABEL = { agent: 'agent', terminal: 'terminal', temporal: 'infra', login: 'login', probe: 'probe', app: 'karmax', untracked: 'misc' };

function fmtDur(sec) {
  if (!sec || sec < 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

function procPanelHtml(sample) {
  if (!sample) return `<div class="card" style="color:var(--ink-3)">Process list unavailable.</div>`;
  if (!sample.supported) return `<div class="card" style="color:var(--ink-3)">Process accounting needs Linux procfs — not available on this host.</div>`;
  const t = sample.totals || {};
  // A row is either killable (button) or protected (visible lock, so the kill
  // affordance is discoverable even on an idle instance where only protected
  // infrastructure — karmax itself + Temporal — is running).
  const LOCK = `<span class="proc-lock" title="Protected — karmax can't run without this. Kill buttons appear on agents, terminals, and the scripts they run.">🔒</span>`;
  const killBtn = (pid, label, killable) =>
    killable
      ? `<button class="btn sm danger proc-kill" data-kill="${pid}" data-label="${esc(label)}" title="click: SIGTERM · shift-click: SIGKILL">✕ kill</button>`
      : LOCK;
  const rows = (sample.groups || [])
    .map((g) => {
      const kindChip = `<span class="chip">${esc(PROC_KIND_LABEL[g.kind] || g.kind)}</span>`;
      const taskChip = g.taskId
        ? `<button class="chip proc-task" data-task="${esc(g.taskId)}" title="open task">${esc(numLabel(g.taskId))}</button>`
        : '';
      // A group is killable at the root when it's a registered entity (agents,
      // terminals, logins, probes) — its registered killer escalates properly.
      const rootKillable = !g.protected && g.kind !== 'app' && g.kind !== 'untracked';
      const head = `<tr class="proc-group">
        <td class="cmd">${esc(g.label)} ${kindChip}${taskChip}</td>
        <td class="mono num">${g.procs.length}</td>
        <td class="mono num">${g.cpuPct.toFixed(1)}%</td>
        <td class="mono num">${g.rssMb >= 1024 ? (g.rssMb / 1024).toFixed(2) + 'G' : g.rssMb.toFixed(0) + 'M'}</td>
        <td class="num">${rootKillable ? killBtn(g.key, g.label, true) : g.protected || g.kind === 'app' ? LOCK : ''}</td>
      </tr>`;
      const body = g.procs
        .map((r) => {
          // Never offer to kill karmax itself (the 'app' group's only row); any
          // other row — including a registered root's own line — is fair game.
          const killable = g.kind !== 'app' && !(g.protected && String(r.pid) === g.key);
          return `<tr>
            <td class="cmd mono" title="${esc(r.cmd)}">${esc(r.cmd)}</td>
            <td class="mono num">${r.pid}<span class="proc-age"> · ${fmtDur(r.ageSec)}</span></td>
            <td class="mono num">${r.cpuPct.toFixed(1)}%</td>
            <td class="mono num">${r.rssMb >= 1024 ? (r.rssMb / 1024).toFixed(2) + 'G' : r.rssMb.toFixed(0) + 'M'}</td>
            <td class="num">${killBtn(r.pid, r.cmd.slice(0, 60), killable)}</td>
          </tr>`;
        })
        .join('');
      return head + body;
    })
    .join('');
  return `<div class="card" style="padding:0;overflow:auto">
    <table class="proc-table">
      <thead><tr><th>process</th><th class="num">pid · age</th><th class="num">cpu</th><th class="num">mem</th><th class="num"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="task-sub" style="padding:8px 12px;color:var(--ink-3)">${t.procs ?? 0} processes · ${(t.cpuPct ?? 0).toFixed(1)}% cpu · ${((t.rssMb ?? 0) / 1024).toFixed(2)}G rss — sampled ${new Date(sample.ts).toLocaleTimeString()} · 🔒 protected (karmax core &amp; Temporal); everything else gets a ✕ kill button</div>
  </div>`;
}

function wireProcPanel(el) {
  el.querySelectorAll('.proc-task').forEach((b) => b.addEventListener('click', () => goToTask(b.dataset.task)));
  el.querySelectorAll('.proc-kill').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      const pid = Number(b.dataset.kill);
      const signal = ev.shiftKey ? 'SIGKILL' : 'SIGTERM';
      if (!confirm(`Send ${signal} to pid ${pid}?\n\n${b.dataset.label}`)) return;
      b.disabled = true;
      try {
        await api('/api/processes/kill', { method: 'POST', body: JSON.stringify({ pid, signal }) });
        toast(`${signal} sent to ${pid}`);
      } catch (e) { toast(e.message, true); }
      refreshProcPanel(true);
    }),
  );
}

// Live-refresh the processes panel every 5s while the Dashboard is open; same
// self-terminating pattern as refreshHostDiag. CPU% is a delta between samples,
// so the very first paint shows 0% and settles from the second sample on.
async function refreshProcPanel(now = false) {
  if (S.tab !== 'dashboard' || !$('#proc-panel')) return;
  clearTimeout(S.procTimer);
  let sample = null;
  try { sample = await api('/api/processes'); } catch {}
  const el = $('#proc-panel');
  if (el && S.tab === 'dashboard') {
    el.innerHTML = procPanelHtml(sample);
    wireProcPanel(el);
  }
  if (S.tab === 'dashboard') { clearTimeout(S.procTimer); S.procTimer = setTimeout(refreshProcPanel, now ? 1200 : 5000); }
}

async function renderDashboard() {
  const box = $('#dash');
  if (!box) return;
  try {
    const [d, u, diag] = await Promise.all([
      api('/api/dashboard'),
      api('/api/accounts/usage').catch(() => ({ usage: {}, pollable: [] })),
      api('/api/diagnostics').catch(() => null),
    ]);
    const accounts = d.accounts?.accounts || [];
    const usage = u.usage || {};
    const pollable = new Set(u.pollable || []);
    box.innerHTML = `
      <div class="page-title">Overview</div>
      <div class="stat-grid">
        <div class="stat"><div class="n">${d.projects}</div><div class="l">Projects</div></div>
        <div class="stat"><div class="n">${d.tasks}</div><div class="l">Tasks</div></div>
        ${Object.entries(d.byStage || {}).map(([s, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(s)}</div></div>`).join('')}
      </div>
      <div class="section-h">Host &amp; admission control</div>
      <div id="host-diag">${hostDiagHtml(diag)}</div>
      <div class="section-h">Processes — everything karmax is running</div>
      <div id="proc-panel"><div class="card" style="color:var(--ink-3)">Loading…</div></div>
      <div class="section-h" style="display:flex;align-items:center;justify-content:space-between">
        <span>Agent accounts (login availability &amp; quota)</span>
        ${pollable.size ? `<button class="btn sm usage-recheck-all">↻ Re-check usage</button>` : ''}
      </div>
      ${accounts.length
        ? accounts.map((a) => {
            const status = a.status || 'available';
            const badge = status === 'available'
              ? '🟢 available'
              : status === 'manual-off'
                ? '⏸ off (manual)'
                : `🔴 ${esc(a.window || 'exhausted')}${a.note ? ` (${esc(a.note)})` : ''}${a.resetAt ? ` · resets ${fmtReset(a.resetAt)}` : ''}`;
            const weekly = a.weeklyResetAt ? `<span style="color:var(--ink-3)"> · weekly resets ${fmtReset(a.weeklyResetAt)}</span>` : '';
            return `<div class="card">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <b class="mono">${esc(a.id)}</b>
                <span class="chip">${esc(a.provider || '')}</span>
                <span>${badge}</span>${weekly}
                <span style="color:var(--ink-3)">in use ${a.inUse}/${a.maxConcurrent >= 1000000 ? '∞' : a.maxConcurrent}</span>
              </div>
              ${usageBlock(a.id, usage[a.id], pollable.has(a.id))}
              <div class="task-sub" style="gap:6px;margin-top:6px;align-items:center">
                ${status === 'available'
                  ? `<button class="btn sm acct-avail" data-id="${esc(a.id)}" data-status="manual-off">Mark unavailable</button>`
                  : `<button class="btn sm acct-avail" data-id="${esc(a.id)}" data-status="available">Mark available now</button>`}
                <button class="btn sm acct-reset" data-id="${esc(a.id)}">Set reset time…</button>
                ${pollable.has(a.id) ? `<button class="btn sm usage-recheck" data-id="${esc(a.id)}">↻ Re-check usage</button>` : ''}
                <label style="display:inline-flex;align-items:center;gap:4px;color:var(--ink-3);font-size:12px">max concurrent <input class="acct-conc" data-id="${esc(a.id)}" value="${a.maxConcurrent >= 1000000 ? '' : a.maxConcurrent}" placeholder="∞" title="How many agent turns may run on this login at once; leave empty = unlimited" style="width:52px;padding:2px 6px" /></label>
              </div>
            </div>`;
          }).join('') + (d.accounts.waiting ? `<div class="task-sub" style="color:var(--ink-3);margin-top:6px">${d.accounts.waiting} turn(s) waiting for a login</div>` : '')
        : `<div class="card" style="color:var(--ink-3)">No account coordinator running. Per-turn account leasing activates when accounts are configured.</div>`}`;
    const recheck = async (btn, body) => {
      const label = btn.textContent; btn.disabled = true; btn.textContent = 'checking…';
      try { await api('/api/accounts/usage/recheck', { method: 'POST', body: JSON.stringify(body) }); }
      catch (e) { toast(e.message, true); }
      btn.textContent = label; renderDashboard();
    };
    box.querySelectorAll('.usage-recheck').forEach((b) => b.addEventListener('click', () => recheck(b, { accountId: b.dataset.id })));
    box.querySelectorAll('.usage-recheck-all').forEach((b) => b.addEventListener('click', () => recheck(b, {})));
    box.querySelectorAll('.acct-avail').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/accounts/availability', { method: 'POST', body: JSON.stringify({ accountId: b.dataset.id, status: b.dataset.status }) }).catch((e) => toast(e.message, true));
      renderDashboard();
    }));
    box.querySelectorAll('.acct-conc').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      inp.addEventListener('change', async () => {
        const v = inp.value.trim(); // empty = unlimited
        await api('/api/accounts/concurrency', { method: 'POST', body: JSON.stringify({ accountId: inp.dataset.id, max: v === '' ? null : Number(v) }) })
          .then(() => toast('Concurrency updated')).catch((e) => toast(e.message, true));
        renderDashboard();
      });
    });
    box.querySelectorAll('.acct-reset').forEach((b) => b.addEventListener('click', async () => {
      const ans = prompt('Mark unavailable until — minutes from now (e.g. 300), or a date/time:');
      if (!ans) return;
      const mins = Number(ans);
      const resetAt = isFinite(mins) && ans.trim() !== '' ? Date.now() + mins * 60_000 : Date.parse(ans);
      if (!resetAt || isNaN(resetAt)) { toast('Could not parse a time', true); return; }
      await api('/api/accounts/availability', { method: 'POST', body: JSON.stringify({ accountId: b.dataset.id, status: 'exhausted', resetAt }) }).catch((e) => toast(e.message, true));
      renderDashboard();
    }));
    // Keep the host panel live without re-rendering (and disrupting focus on) the
    // accounts section; single pending timer (cleared here and inside the loop).
    clearTimeout(S.hostDiagTimer);
    S.hostDiagTimer = setTimeout(refreshHostDiag, 5000);
    refreshProcPanel(); // fetches, renders, and self-schedules while the tab is open
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// Real usage % + reset for a login (proactive quota, #6). `snap` is a full snapshot,
// an "unavailable" record, or undefined (never probed). Non-pollable logins (Codex /
// API keys / setup-token) render nothing here — their reactive status is shown above.
function usageBlock(id, snap, isPollable) {
  if (!snap) {
    return isPollable
      ? `<div class="task-sub" style="color:var(--ink-3);margin-top:4px">Usage not checked yet — click “↻ Re-check usage”.</div>`
      : '';
  }
  if (!snap.ok) {
    const why = snap.reason === 'setup-token'
      ? 'Usage % needs a full login (this one uses a setup-token) — tracked reactively.'
      : snap.reason === 'logged-out' ? 'Not logged in.'
      : snap.reason === 'not-subscription' ? 'No subscription usage to report.'
      : `Usage unavailable (${esc(snap.reason || '')}).`;
    return `<div class="task-sub" style="color:var(--ink-3);margin-top:4px">${esc(why)}</div>`;
  }
  const rows = [];
  if (snap.session) rows.push(usageRow('Session', snap.session));
  if (snap.week) rows.push(usageRow('Week', snap.week));
  for (const m of snap.models || []) rows.push(usageRow(m.name || 'model', m));
  return `<div style="margin-top:6px">${rows.join('')}
    <div class="task-sub" style="color:var(--ink-3);font-size:11px">checked ${esc(fmtAgo(snap.at))}</div></div>`;
}

function usageRow(label, win) {
  const pct = Math.max(0, Math.min(100, win.pct || 0));
  const hue = pct >= 90 ? 'var(--bad,#e5484d)' : pct >= 70 ? 'var(--warn,#f5a623)' : 'var(--ok,#30a46c)';
  return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px">
    <span style="width:64px;color:var(--ink-2)">${esc(label)}</span>
    <span style="flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden;max-width:180px">
      <span style="display:block;height:100%;width:${pct}%;background:${hue}"></span>
    </span>
    <span class="mono" style="width:38px;text-align:right">${pct}%</span>
    <span style="color:var(--ink-3)">resets ${esc(fmtUsageReset(win))}</span>
  </div>`;
}

function fmtUsageReset(win) {
  const cd = win.resetAt ? ` · ${fmtCountdown(win.resetAt)}` : '';
  return `${win.resetLabel || ''}${win.tz ? ` (${win.tz})` : ''}${cd}`;
}

function fmtCountdown(epoch) {
  const ms = epoch - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function fmtAgo(epoch) {
  if (!epoch) return 'just now';
  const ms = Date.now() - epoch;
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// Format an absolute reset instant as a local time + relative countdown.
function fmtReset(epoch) {
  const ms = epoch - Date.now();
  const when = new Date(epoch).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  if (ms <= 0) return `${when} (now)`;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return `${when} (in ${h ? `${h}h ` : ''}${m}m)`;
}

// ── settings (schema-driven, SPEC §10.4) ─────────────────────────────────────
// One renderer for both scopes; `scope` decides which fields show + where they save.
function settingsForms(scope, projectId) {
  const wfs = S.schema.filter((s) => WORKFLOWS.some((w) => w.id === s.name));
  return wfs
    .map((s) => {
      const fields = s.params.filter((f) => f.scopes.includes(scope));
      if (!fields.length) return '';
      return `<details class="card" data-wf="${esc(s.name)}" ${s.name === 'software-dev' ? 'open' : ''}>
        <summary style="cursor:pointer;font-weight:600">${esc(s.name)} <span style="color:var(--ink-3);font-weight:400;font-size:12px">— defaults</span></summary>
        <div class="wf-form" style="margin-top:10px">${fields.map((f) => renderField(f, undefined)).join('')}</div>
        <button class="btn primary sm" data-save="${esc(s.name)}">Save ${esc(s.name)} defaults</button>
      </details>`;
    })
    .join('');
}

async function hydrateSettingsForms(scope, projectId) {
  // load saved (own) values + inherited defaults per workflow and fill the inputs
  for (const sec of $('#main').querySelectorAll('[data-wf]')) {
    const wf = sec.dataset.wf;
    let own = {};
    let inherited = {};
    try {
      const d = await api(`/api/defaults/${projectId || 'global'}/${wf}`);
      own = d[scope].own;
      inherited = d[scope].inherited;
    } catch {}
    const fields = schemaFor(wf).filter((f) => f.scopes.includes(scope));
    sec.querySelector('.wf-form').innerHTML = fields.map((f) => renderField(f, own[f.name], inherited[f.name])).join('');
    wireAgentFields(sec);
    wireFieldResets(sec, fields);
  }
}

function settingsView(proj) {
  if (!proj) return `<div class="empty">Select a project.</div>`;
  return `
    <div class="page-title">Project settings — ${esc(proj.name)}</div>
    <p style="color:var(--ink-2);margin-top:-8px">Per-workflow defaults for this project. They override your global defaults and are overridden per-task.</p>
    ${settingsForms('project', proj.id)}
    <div class="card">
      <div class="section-h">Credentials &amp; precedence</div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">Override the global credential order/enablement for this project (e.g. enable an API key here that's off globally).</p>
      <div id="cred-editor-project">Loading…</div>
    </div>
    ${profilesCard('project')}
    ${paymentsCard('project')}
    <div class="card" id="wf-pins-card">
      <div class="section-h">Workflow versions</div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">Pin this project to a specific version of a workflow, or track the latest. A pin only affects <b>new</b> tasks — running ones keep the version they started on.</p>
      <div id="wf-pins-list">Loading…</div>
    </div>
    <div class="card">
      <div class="section-h">Workflow activation</div>
      <p style="color:var(--ink-2);margin-top:0">Activating a workflow resolves its dependencies and may spawn an onActivate preparation task.</p>
      <button class="btn" id="activate-sd">Activate software-dev (runs prep task)</button>
    </div>
    <div class="card" style="border-color:var(--danger-weak)">
      <div class="section-h" style="color:var(--danger)">Danger zone</div>
      <p style="color:var(--ink-2);margin-top:0">Deleting a project permanently removes it and all of its tasks. This cannot be undone.</p>
      <button class="btn danger" id="delete-project">Delete project</button>
    </div>`;
}
async function hydrateWorkflowPins(projectId) {
  const box = $('#wf-pins-list');
  if (!box) return;
  let list = [];
  let pins = {};
  try { [list, pins] = await Promise.all([api('/api/workflows'), api(`/api/projects/${projectId}/workflow-pins`)]); }
  catch { box.innerHTML = '<span style="color:var(--ink-3)">Could not load workflow versions.</span>'; return; }
  box.innerHTML = list.map((w) => {
    const pinned = pins[w.name] ?? 'latest';
    const opts = [`<option value="latest" ${pinned === 'latest' ? 'selected' : ''}>latest (v${esc(w.latest)})</option>`]
      .concat(w.versions.slice().reverse().map((v) => `<option value="${esc(v)}" ${pinned === v ? 'selected' : ''}>v${esc(v)}</option>`))
      .join('');
    return `<div class="queue-item">
      <div style="flex:1"><b>${esc(w.name)}</b> <span class="chip">${w.source === 'bundled' ? 'built-in' : 'installed'}</span></div>
      <select class="wf-pin" data-wf="${esc(w.name)}" ${w.versions.length <= 1 ? 'disabled title="only one version"' : ''}>${opts}</select>
    </div>`;
  }).join('');
  box.querySelectorAll('.wf-pin').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api(`/api/projects/${projectId}/workflow-pins`, { method: 'POST', body: JSON.stringify({ workflow: sel.dataset.wf, version: sel.value }) });
      toast(`${sel.dataset.wf} pinned to ${sel.value}`);
    } catch (e) { toast(e.message, true); }
  }));
}
function wireSettingsView(proj) {
  hydrateSettingsForms('project', proj.id);
  renderCredentialEditor($('#cred-editor-project'), 'project', { projectId: proj.id });
  hydrateProfiles('project', proj.id);
  hydrateWorkflowPins(proj.id);
  $('#main').querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', async () => {
      const wf = b.dataset.save;
      const sec = b.closest('[data-wf]');
      const fields = schemaFor(wf).filter((f) => f.scopes.includes('project'));
      const values = collectForm(sec.querySelector('.wf-form'), fields);
      try { await api(`/api/settings/project/${proj.id}/${wf}`, { method: 'PUT', body: JSON.stringify({ values }) }); await loadProjects(); toast(`${wf} defaults saved`); } catch (e) { toast(e.message, true); }
    }),
  );
  wirePaymentsCard('project', proj.id);
  $('#activate-sd')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/projects/${proj.id}/activate-workflow`, { method: 'POST', body: JSON.stringify({ workflow: 'software-dev' }) });
      toast(`Activated (deps: ${r.requires.join(', ') || 'none'}${r.spawnedTasks.length ? '; prep task spawned' : ''})`);
      refreshTasks();
    } catch (e) { toast(e.message, true); }
  });
  $('#delete-project')?.addEventListener('click', async () => {
    if (!confirm(`Delete project "${proj.name}"? This permanently removes it and all of its tasks. This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${proj.id}`, { method: 'DELETE' });
      toast(`Deleted project "${proj.name}"`);
      if (S.projectId === proj.id) S.projectId = null;
      await loadProjects();
      S.tab = S.projectId ? 'tasks' : 'dashboard';
      if (S.projectId) await loadTasks();
      renderRail();
      renderMain();
    } catch (e) { toast(e.message, true); }
  });
}

// ── global settings (user scope) ─────────────────────────────────────────────
function globalSettingsView() {
  return `
    <div class="page-title">Global settings</div>
    <p style="color:var(--ink-2);margin-top:-8px">Your defaults across all projects. Projects can override these; tasks override both.</p>
    ${settingsForms('global')}
    ${profilesCard('global')}
    ${paymentsCard('global')}
    <div class="card" id="accounts-card">
      <div class="section-h">Accounts &amp; precedence</div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">Every login and API key agents can use, in one list. <b>Drag</b> to set precedence (top = tried first); toggle <b>On/Off</b> to enable/disable. API keys are off by default when a subscription exists. Projects and each task override this order + enablement (a task in its own form).</p>
      <div id="cred-editor-global" style="margin-bottom:14px">Loading…</div>

      <div style="font-weight:600;margin-bottom:4px">Connect a login (subscription)</div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">Connect a Claude or Codex account to use its subscription. Each gets an isolated config home you can switch between (dodges token limits). karmax opens the provider's own login — you complete it; karmax never types your credentials.</p>
      <div class="form-row"><label>Connect a login</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="login-provider"><option>claude</option><option>codex</option></select>
          <input id="login-name" placeholder="account name (e.g. personal)" style="flex:1;min-width:120px" />
          <select id="login-browser" title="Browser MCP baseline for this profile">
            <option value="none">no browser MCP</option>
            <option value="chrome-devtools">+ chrome-devtools MCP</option>
            <option value="playwright">+ playwright MCP</option>
          </select>
          <button class="btn primary" id="login-connect">Connect</button>
        </div>
        <div id="login-result" style="font-size:12px;margin-top:6px"></div>
      </div>

      <div style="font-weight:600;margin:14px 0 4px">Register an API key</div>
      <div class="form-row"><label>Register a key</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="acct-provider"><option>claude</option><option>codex</option></select>
          <input id="acct-name" placeholder="account name (e.g. work)" style="flex:1;min-width:120px" />
          <input id="acct-key" type="password" placeholder="API key" style="flex:1;min-width:160px" />
          <button class="btn" id="acct-add">Register</button>
        </div>
        <div style="font-size:11px;color:var(--ink-3);margin-top:4px">Stored encrypted in the vault; the key is never shown again. (You enter it — karmax never sees it elsewhere.)</div>
      </div>
    </div>
    <div class="card" id="workflows-card">
      <div class="section-h">Workflows</div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">The orchestration recipes tasks run on. Built-ins ship with karmax; you can install more from a git repo. A workflow is version-pinned per task — an upgrade only affects new tasks, never a running one.</p>
      <div id="workflows-list" style="margin-bottom:12px">Loading…</div>
      <div class="form-row"><label>Install from a git repo</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="wf-url" placeholder="git URL or path (e.g. https://github.com/you/my-workflow.git)" style="flex:1;min-width:220px" />
          <input id="wf-ref" placeholder="ref (tag/branch/sha, optional)" style="width:180px" />
          <button class="btn primary" id="wf-install">Install</button>
        </div>
        <div id="wf-install-result" style="font-size:12px;margin-top:6px"></div>
        <div style="font-size:11px;color:var(--ink-3);margin-top:4px">The repo is pinned to an exact commit and its manifest validated before it's loaded. Built-in workflows are edited through the review gate, not overwritten here.</div>
      </div>
    </div>
    <div class="card">
      <div class="section-h">Appearance</div>
      <div class="switch"><button class="btn sm" id="gs-theme">Toggle theme ◐</button></div>
    </div>
    <div class="card">
      <div class="section-h">Resilience</div>
      <div class="switch"><input type="checkbox" id="safe-mode" ${S.meta?.safeMode ? 'checked' : ''} /><label for="safe-mode">Global safe mode (boot vanilla: all overlays off)</label></div>
    </div>`;
}

async function hydrateWorkflows() {
  const box = $('#workflows-list');
  if (!box) return;
  let list = [];
  try { list = await api('/api/workflows'); } catch { box.innerHTML = '<span style="color:var(--ink-3)">Could not load workflows.</span>'; return; }
  if (!list.length) { box.innerHTML = '<span style="color:var(--ink-3)">No workflows registered.</span>'; return; }
  box.innerHTML = list.map((w) => `<div class="queue-item">
      <div style="flex:1"><b>${esc(w.name)}</b>
        <span class="chip">${w.source === 'bundled' ? 'built-in' : 'installed'}</span>
        <span class="chip">v${esc(w.latest)}</span>
        ${w.versions.length > 1 ? `<span class="task-sub" style="color:var(--ink-3)">versions: ${w.versions.map(esc).join(', ')}</span>` : ''}
        <div class="task-sub" style="color:var(--ink-3)">${esc(w.description || '')}</div>
      </div></div>`).join('');
}
// ── payments: budget policy + cards (SPEC §7.6) ──────────────────────────────
function paymentsCard(scope) {
  return `<div class="card" data-payments="${scope}">
    <div class="section-h">Payments — budget & cards</div>
    ${scope === 'global' ? `<div class="pay-providers" style="margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:4px">Funding source</div>
      <p style="color:var(--ink-2);margin:0 0 6px;font-size:12px">How karmax pays. Cards are shared project/global resources; agents spend against them within your budget policy. karmax never stores card numbers.</p>
      <div class="pay-providers-list">Loading…</div>
    </div>` : ''}
    <div class="form-row"><label>Spend allowance per task (USD; blank = unlimited)</label><input class="pay-allow" type="number" step="0.01" /></div>
    <div class="form-row"><label>Review threshold (USD; a single spend above this needs approval)</label><input class="pay-thresh" type="number" step="0.01" /></div>
    <button class="btn sm primary" data-savepolicy="${scope}">Save budget policy</button>
    <div class="section-h" style="margin-top:14px">Cards</div>
    <div class="cards-list" style="margin-bottom:8px"></div>
    <div class="form-row"><label>Add a ${scope} card</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="card-label" placeholder="label (e.g. Ops)" />
        <input class="card-cap" type="number" step="0.01" placeholder="hard cap USD" style="width:140px" />
        <button class="btn" data-addcard="${scope}">Add card</button>
      </div></div>
  </div>`;
}
const usd = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
async function wirePaymentProviders(box) {
  const list = box.querySelector('.pay-providers-list');
  if (!list) return;
  let data = { providers: [], active: null };
  try { data = await api('/api/payments/providers'); } catch {}
  list.innerHTML = data.providers.length
    ? data.providers.map((p) => `<div class="queue-item" data-prov="${esc(p.name)}">
        <div style="flex:1"><b>${esc(p.label)}</b> ${p.name === data.active ? '<span class="chip">active</span>' : ''} ${p.connected ? '<span class="chip" style="color:var(--ok,#4ec9a3)">connected</span>' : ''}
          <div class="task-sub" style="color:var(--ink-3)">${esc(p.help || '')}</div></div>
        ${p.kind === 'oauth' && !p.connected ? `<button class="btn sm" data-connectpay="${esc(p.name)}">Connect</button>` : ''}</div>`).join('')
    : '<span style="color:var(--ink-3)">No payment providers.</span>';
  list.querySelectorAll('[data-connectpay]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/payments/connect', { method: 'POST', body: JSON.stringify({ provider: b.dataset.connectpay }) });
      const row = b.closest('[data-prov]');
      if (r.status === 'awaiting_oauth' && r.url) {
        row.insertAdjacentHTML('beforeend', `<div style="font-size:12px;margin-top:6px;flex-basis:100%">Open to authorize (karmax never sees your card data):<br><a href="${esc(r.url)}" target="_blank" rel="noopener" class="mono">${esc(r.url)}</a></div>`);
      } else if (r.status === 'connected') { toast('Connected'); wirePaymentProviders(box); }
      else { toast(r.detail || 'Not available', true); }
    } catch (e) { toast(e.message, true); }
  }));
}
async function wirePaymentsCard(scope, projectId) {
  const box = $(`[data-payments="${scope}"]`);
  if (!box) return;
  if (scope === 'global') await wirePaymentProviders(box);
  const sUrl = scope === 'global' ? '/api/settings/global/payments' : `/api/settings/project/${projectId}/payments`;
  let policy = {};
  try { policy = await api(sUrl); } catch {}
  if (policy.allowance != null) box.querySelector('.pay-allow').value = (policy.allowance / 100).toFixed(2);
  if (policy.threshold != null) box.querySelector('.pay-thresh').value = (policy.threshold / 100).toFixed(2);
  box.querySelector(`[data-savepolicy]`).addEventListener('click', async () => {
    const a = box.querySelector('.pay-allow').value;
    const t = box.querySelector('.pay-thresh').value;
    const values = { ...policy };
    values.allowance = a === '' ? undefined : Math.round(Number(a) * 100);
    values.threshold = t === '' ? undefined : Math.round(Number(t) * 100);
    try { await api(sUrl, { method: 'PUT', body: JSON.stringify({ values }) }); toast('Budget policy saved'); } catch (e) { toast(e.message, true); }
  });
  const renderCards = async () => {
    let cards = [];
    try { cards = await api(`/api/cards${projectId ? `?projectId=${projectId}` : ''}`); } catch {}
    if (scope === 'global') cards = cards.filter((c) => c.scope === 'global');
    const list = box.querySelector('.cards-list');
    list.innerHTML = cards.length
      ? cards.map((c) => `<div class="queue-item"><div style="flex:1"><b>${esc(c.label)}</b> <span class="mono" style="color:var(--ink-3);font-size:11px">· ${c.scope}</span><div class="task-sub">available ${usd(c.available)} / cap ${usd(c.cap)}</div></div>
        <input class="fund-amt" type="number" step="0.01" placeholder="USD" style="width:90px" /><button class="btn sm" data-fund="${c.id}">Fund</button></div>`).join('')
      : '<span style="color:var(--ink-3)">No cards.</span>';
    list.querySelectorAll('[data-fund]').forEach((b) => b.addEventListener('click', async () => {
      const amt = b.closest('.queue-item').querySelector('.fund-amt').value;
      if (!amt) return;
      try { await api(`/api/cards/${b.dataset.fund}/fund`, { method: 'POST', body: JSON.stringify({ amount: Math.round(Number(amt) * 100) }) }); toast('Card funded'); renderCards(); } catch (e) { toast(e.message, true); }
    }));
  };
  await renderCards();
  box.querySelector(`[data-addcard]`).addEventListener('click', async () => {
    const label = box.querySelector('.card-label').value.trim() || 'Card';
    const cap = box.querySelector('.card-cap').value;
    try {
      await api('/api/cards', { method: 'POST', body: JSON.stringify({ scope, projectId: scope === 'project' ? projectId : undefined, label, cap: Math.round(Number(cap || 0) * 100) }) });
      box.querySelector('.card-label').value = '';
      box.querySelector('.card-cap').value = '';
      toast('Card added');
      renderCards();
    } catch (e) { toast(e.message, true); }
  });
}

// Which accounts an agent may use (SPEC §7.3/§6.2) — a checkbox pool, all checked
// by default. The checked set becomes the agent's credential + lease-rotation pool.
function accountChecks(p, handles, logins) {
  const refs = [...logins.map((l) => `login:${l.provider}:${l.account}`), ...handles.map((h) => `key:${h}`)];
  if (!refs.length) return `<span style="color:var(--ink-3);font-size:12px">No accounts connected — the agent uses the ambient login.</span>`;
  const all = !p.allowedAccounts || !p.allowedAccounts.length; // unset ⇒ all allowed
  const on = (ref) => all || p.allowedAccounts.includes(ref);
  const box = (ref, label, warn) =>
    `<label style="display:inline-flex;gap:5px;align-items:center;font-size:12px;margin:2px 10px 2px 0">
      <input type="checkbox" class="pf-acct" value="${esc(ref)}" ${on(ref) ? 'checked' : ''} /> ${esc(label)}${warn ? ' <span style="color:var(--warn,#e0b15a)">(not signed in)</span>' : ''}</label>`;
  return (
    logins.map((l) => box(`login:${l.provider}:${l.account}`, `${l.provider}:${l.account}`, !l.loggedIn)).join('') +
    handles.map((h) => box(`key:${h}`, `key · ${h}`, false)).join('')
  );
}

function profileRow(p, handles, logins, scope) {
  const inherited = scope === 'project' && p.scope === 'inherited';
  const usedBy = (p.roleWorkflows || []).length ? `<span class="mono" style="color:var(--ink-3);font-size:11px" title="This role's profile is shared across these workflows">· used by ${p.roleWorkflows.map(esc).join(', ')}</span>` : '';
  return `<div class="card" data-profile="${esc(p.id)}" data-role="${esc(p.role)}" style="background:var(--surface-2)">
    <div style="font-weight:600;margin-bottom:6px">${esc(p.name)} <span class="mono" style="color:var(--ink-3);font-size:11px">· ${esc(p.role)}</span> ${usedBy}
      ${inherited ? '<span class="chip" title="Using the global default; edit to create a project override">inherited</span>' : scope === 'project' ? '<span class="chip">project override</span>' : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select class="pf-provider">${['claude', 'codex', 'mock'].map((x) => `<option ${x === p.provider ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <div class="combo pf-model-combo" style="flex:1;min-width:140px">
        <input class="pf-model" placeholder="model" value="${esc(p.model || '')}" autocomplete="off" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show model choices">▾</button>
        <div class="combo-menu" hidden></div>
      </div>
      ${effortSelectHtml('pf-effort', p.provider, p.model, p.effort || '')}
      <input class="pf-maxturns" type="number" min="1" placeholder="turns: ∞" title="Max tool iterations per turn. Blank = unlimited." value="${p.maxTurns ?? ''}" style="width:90px" />
    </div>
    <div class="form-row" style="margin-top:8px"><label>Capabilities (comma-separated)</label><input class="pf-caps" value="${esc((p.capabilities || []).join(', '))}" /></div>
    <div class="form-row"><label>Accounts this agent may use (all by default)</label><div class="pf-accts">${accountChecks(p, handles, logins)}</div></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary sm" data-saveprofile="${esc(p.id)}">Save profile</button>
      ${scope === 'project' && p.scope === 'project' ? `<button class="btn sm" data-resetprofile="${esc(p.id)}">Reset to global</button>` : ''}
    </div>
  </div>`;
}

// Render + wire the agent-profiles editor for a scope (global or a project).
async function hydrateProfiles(scope, projectId) {
  let handles = [], logins = [];
  try { const a = await api('/api/accounts'); handles = a.handles || []; logins = a.logins || []; } catch {}
  let profiles = [];
  try { profiles = await api(`/api/profiles${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`); } catch {}
  const list = $(`#profiles-list-${scope}`);
  if (!list) return;
  list.innerHTML = profiles.length ? profiles.map((p) => profileRow(p, handles, logins, scope)).join('') : '<span style="color:var(--ink-3)">No profiles.</span>';
  list.querySelectorAll('[data-profile]').forEach((card) => {
    const combo = card.querySelector('.pf-model-combo');
    const providerOf = () => card.querySelector('.pf-provider')?.value || 'claude';
    if (combo) wireCombo(combo, () => MODELS[providerOf()] || MODELS.claude, () => refreshEffortSelect(card, 'pf-provider', 'pf-model', 'pf-effort'));
    card.querySelector('.pf-provider')?.addEventListener('change', () => {
      card.querySelector('.pf-model').value = ''; // model choices are provider-specific
      refreshEffortSelect(card, 'pf-provider', 'pf-model', 'pf-effort');
    });
  });
  const allRefs = [...logins.map((l) => `login:${l.provider}:${l.account}`), ...handles.map((h) => `key:${h}`)];
  list.querySelectorAll('[data-saveprofile]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('[data-profile]');
    const orig = profiles.find((p) => p.id === b.dataset.saveprofile) || {};
    const checked = [...card.querySelectorAll('.pf-acct:checked')].map((c) => c.value);
    // all checked ⇒ store nothing (means "all", stays correct as accounts are added)
    const allowedAccounts = allRefs.length && checked.length < allRefs.length ? checked : undefined;
    const profile = {
      role: orig.role, name: orig.name, id: scope === 'global' ? orig.id : undefined, projectId: scope === 'project' ? projectId : undefined,
      provider: card.querySelector('.pf-provider').value,
      model: card.querySelector('.pf-model').value.trim() || undefined,
      effort: card.querySelector('.pf-effort').value || undefined,
      maxTurns: card.querySelector('.pf-maxturns').value ? Number(card.querySelector('.pf-maxturns').value) : undefined,
      capabilities: card.querySelector('.pf-caps').value.split(',').map((s) => s.trim()).filter(Boolean),
      allowedAccounts,
    };
    try { await api('/api/profiles', { method: 'PUT', body: JSON.stringify(profile) }); toast('Profile saved'); hydrateProfiles(scope, projectId); } catch (e) { toast(e.message, true); }
  }));
  list.querySelectorAll('[data-resetprofile]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/profiles/${encodeURIComponent(b.dataset.resetprofile)}`, { method: 'DELETE' }); toast('Reset to global'); hydrateProfiles(scope, projectId); } catch (e) { toast(e.message, true); }
  }));
}

// The logins + API keys now live in the unified credential manager (#cred-editor-global:
// drag to reorder, On/Off to enable/disable, ✎/✕ to rename/delete a login). This just
// refreshes it after a connect/register/delete.
async function hydrateAccounts() {
  await renderCredentialEditor($('#cred-editor-global'), 'global');
}

function profilesCard(scope) {
  return `<div class="card" id="profiles-card-${scope}">
    <div class="section-h">Agent profiles</div>
    <p style="color:var(--ink-2);margin-top:0">Per-role defaults: provider, model, effort, capabilities, turn cap, and which accounts each agent may use.${scope === 'project' ? ' These override your global defaults for this project.' : ''}</p>
    <div id="profiles-list-${scope}">Loading…</div>
  </div>`;
}

function wireGlobalSettings() {
  hydrateSettingsForms('global');
  renderCredentialEditor($('#cred-editor-global'), 'global'); // the merged accounts + precedence list
  hydrateProfiles('global');
  hydrateWorkflows();
  wirePaymentsCard('global');
  $('#wf-install')?.addEventListener('click', async () => {
    const url = $('#wf-url').value.trim();
    const ref = $('#wf-ref').value.trim();
    const out = $('#wf-install-result');
    if (!url) return toast('git URL or path required', true);
    const btn = $('#wf-install'); btn.disabled = true;
    out.textContent = 'Fetching, validating, and loading the workflow…';
    out.style.color = 'var(--ink-2)';
    try {
      const r = await api('/api/workflows/install', { method: 'POST', body: JSON.stringify({ url, ref: ref || undefined }) });
      out.innerHTML = `🟢 Installed <b>${esc(r.name)}</b> v${esc(r.version)} — the worker was rolled to serve it, no restart needed.`;
      out.style.color = 'var(--ok, green)';
      $('#wf-url').value = ''; $('#wf-ref').value = '';
      hydrateWorkflows();
    } catch (e) {
      out.textContent = e.message;
      out.style.color = 'var(--bad, crimson)';
    } finally { btn.disabled = false; }
  });
  $('#acct-add')?.addEventListener('click', async () => {
    const provider = $('#acct-provider').value;
    const account = $('#acct-name').value.trim();
    const apiKey = $('#acct-key').value.trim();
    if (!account || !apiKey) return toast('account name + key required', true);
    try {
      await api('/api/accounts', { method: 'POST', body: JSON.stringify({ provider, account, apiKey }) });
      $('#acct-key').value = '';
      $('#acct-name').value = '';
      toast('Key registered');
      hydrateAccounts();
    } catch (e) { toast(e.message, true); }
  });
  $('#login-connect')?.addEventListener('click', async () => {
    const provider = $('#login-provider').value;
    const account = $('#login-name').value.trim();
    const browserMcp = $('#login-browser').value;
    const out = $('#login-result');
    if (!account) return toast('account name required', true);
    out.textContent = 'Launching provider login…';
    out.style.color = 'var(--ink-2)';
    try {
      const btn = $('#login-connect'); btn.disabled = true;
      const r = await api('/api/accounts/connect', { method: 'POST', body: JSON.stringify({ provider, account, browserMcp }) });
      btn.disabled = false;
      if (r.status === 'logged_in') { out.innerHTML = '🟢 Already signed in.'; out.style.color = 'var(--ok, green)'; }
      else if (r.status === 'awaiting_oauth' && r.loginUrl) {
        out.innerHTML = `Open this URL to finish signing in (karmax won't type your credentials):<br><a href="${esc(r.loginUrl)}" target="_blank" rel="noopener" class="mono">${esc(r.loginUrl)}</a>`;
        out.style.color = 'var(--ink-1)';
      } else { out.textContent = `Could not start login: ${r.detail || r.status}`; out.style.color = 'var(--bad, crimson)'; }
      $('#login-name').value = '';
      hydrateAccounts();
      hydrateProfiles('global');
    } catch (e) { $('#login-connect').disabled = false; out.textContent = e.message; out.style.color = 'var(--bad, crimson)'; }
  });
  $('#main').querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', async () => {
      const wf = b.dataset.save;
      const sec = b.closest('[data-wf]');
      const fields = schemaFor(wf).filter((f) => f.scopes.includes('global'));
      const values = collectForm(sec.querySelector('.wf-form'), fields);
      try { await api(`/api/settings/global/${wf}`, { method: 'PUT', body: JSON.stringify({ values }) }); toast(`${wf} global defaults saved`); } catch (e) { toast(e.message, true); }
    }),
  );
  $('#gs-theme')?.addEventListener('click', toggleTheme);
  $('#safe-mode')?.addEventListener('change', async (e) => {
    try { const r = await api('/api/safe-mode', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }); S.meta.safeMode = r.safeMode; toast(`Safe mode ${r.safeMode ? 'on' : 'off'}`); } catch (err) { toast(err.message, true); }
  });
}

// ── notifications ────────────────────────────────────────────────────────────
function needsAttention() {
  return S.tasks.filter((t) => ['review', 'escalated'].includes(t.lastView?.stage) && t.lastView?.status !== 'done' && !t.parentTaskId && !t.params?.archived);
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
    items.length ? items.map((t) => `<div class="pi" data-id="${t.id}"><b>${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}</b><div class="task-sub"><span class="chip ${t.lastView.status}">${esc(t.lastView.stage)}</span></div></div>`).join('') : '<div class="pi" style="color:var(--ink-3)">All clear ✓</div>'
  }`;
  $('#overlay-root').appendChild(pop);
  pop.querySelectorAll('.pi[data-id]').forEach((e) => e.addEventListener('click', () => { pop.remove(); goToTask(e.dataset.id); }));
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
    // Create with an EMPTY config so branches (and every other field) inherit
    // from global settings. Hardcoding defaultBase/defaultTarget here would bake
    // a project-scope override that shadows the global default (e.g. "master"),
    // which is exactly the inheritance bug this avoids.
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, config: {} }) });
    await loadProjects();
    S.projectId = p.id;
    renderRail();
    renderMain();
  } catch (e) { toast(e.message, true); }
}

// ── keyboard navigation / command registry (SPEC §10.1) ─────────────────────
// ONE registry feeds three views: key dispatch, the ⌘K palette, and the "?"
// help overlay — so they can never drift apart. Commands come from three tiers:
//   1. host commands — the console's own navigation + interaction grammar;
//   2. server-declared commands (GET /api/contributions): workflow packages
//      contribute `task.<action>` commands with default keybindings, and the
//      host maps them GENERICALLY onto the selected task's declared actions —
//      the host never hardcodes a workflow's action vocabulary;
//   3. the declared actions themselves (the auto-render floor, SPEC §10.2): every
//      enabled action of the selected task is a palette entry, and digits 1–9
//      press the drawer's action buttons — so a workflow that declares no
//      keybindings at all is still fully keyboard-operable.

// -- keybinding strings ('meta+k', 'g t', '?', 'J') → step sequences ----------
const KEY_NAMES = { esc: 'escape', return: 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', cmd: 'meta', mod: 'meta' };
function parseKeybinding(binding) {
  return String(binding || '').trim().split(/\s+/).filter(Boolean).map((step) => {
    const parts = step.split('+').filter(Boolean);
    const raw = parts.pop() || '+'; // 'meta++' → the '+' key
    // single chars stay case-sensitive ('J' means shift+j); named keys normalize
    const key = raw.length === 1 ? raw : (KEY_NAMES[raw.toLowerCase()] || raw.toLowerCase());
    const out = { key };
    for (const p of parts) {
      const m = KEY_NAMES[p.toLowerCase()] || p.toLowerCase();
      if (m === 'meta') out.meta = true;
      else if (m === 'ctrl') out.ctrl = true;
      else if (m === 'alt') out.alt = true;
      else if (m === 'shift') out.shift = true;
    }
    return out;
  });
}
// Does a keydown (or a stored snapshot of one) match a binding step? 'meta'
// accepts Ctrl too (Linux/Windows); bare steps refuse held modifiers so Ctrl+C
// (copy) can never trigger a plain-'c' command.
function stepMatches(step, e) {
  const key = e.key.length === 1 ? e.key : e.key.toLowerCase();
  if (key !== step.key) return false;
  if (!!step.alt !== !!e.altKey) return false;
  if (step.meta) return !!(e.metaKey || e.ctrlKey);
  if (step.ctrl) return !!e.ctrlKey && !e.metaKey;
  return !e.metaKey && !e.ctrlKey;
}
// Which commands could still match after `pending` steps, given keystroke `snap`?
// Pure (unit-tested in web/keynav.test.cjs); `cmds` carry parsed `keys`.
function chordCandidates(cmds, pending, snap) {
  return cmds.filter((c) => {
    if (!c.keys || c.keys.length <= pending.length) return false;
    if (!pending.every((p, i) => stepMatches(c.keys[i], p))) return false;
    return stepMatches(c.keys[pending.length], snap);
  });
}
// Human-readable keybinding for chips ('meta+k' → ⌘K / Ctrl+K).
function fmtKeys(binding) {
  const mac = /Mac|iP/.test((typeof navigator !== 'undefined' && navigator.platform) || '');
  const NAME = { escape: 'Esc', enter: '↵', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', ' ': 'Space' };
  return parseKeybinding(binding)
    .map((s) => `${s.ctrl ? 'Ctrl+' : ''}${s.alt ? (mac ? '⌥' : 'Alt+') : ''}${s.meta ? (mac ? '⌘' : 'Ctrl+') : ''}${s.shift ? '⇧' : ''}${NAME[s.key] || s.key}`)
    .join(' ');
}
// Subsequence fuzzy match: score (higher = better), or -1 for no match.
function fuzzyScore(q, s) {
  if (!q) return 0;
  const hay = String(s).toLowerCase();
  let score = 0, at = 0, run = 0;
  for (const ch of String(q).toLowerCase()) {
    const idx = hay.indexOf(ch, at);
    if (idx < 0) return -1;
    run = idx === at && at > 0 ? run + 1 : 1;
    score += run * 2 + (idx === 0 || /[\s\-_./:]/.test(hay[idx - 1]) ? 3 : 0) - Math.min(idx - at, 6) * 0.5;
    at = idx + 1;
  }
  return score;
}

// -- the assembled registry ---------------------------------------------------
// Host commands. `key` is only the fallback — the binding of record comes from
// the server's command registry (S.contributions), so packages can rebind ids.
const HOST_COMMANDS = [
  { id: 'nav.commandPalette', title: 'Command palette', key: 'meta+k', run: () => openPalette() },
  { id: 'help.keyboard', title: 'Keyboard shortcuts', key: '?', run: () => openHelp() },
  { id: 'nav.newTask', title: 'New task (quick add)', key: 'n', run: () => { switchTab('tasks'); setTimeout(() => $('#new-task')?.focus(), 30); } },
  { id: 'nav.newTaskForm', title: 'New task (full form)', key: 'N', run: () => { switchTab('tasks'); openTaskForm($('#new-wf')?.value, undefined, $('#new-task')?.value.trim()); } },
  { id: 'nav.search', title: 'Search', key: '/', run: () => $('#search')?.focus() },
  { id: 'nav.tasks', title: 'Go to tasks', key: 'g t', run: () => switchTab('tasks') },
  { id: 'nav.queue', title: 'Go to merge queue', key: 'g q', run: () => switchTab('queue') },
  { id: 'nav.activity', title: 'Go to activity', key: 'g a', run: () => switchTab('activity') },
  { id: 'nav.dashboard', title: 'Go to dashboard', key: 'g d', run: () => switchTab('dashboard') },
  { id: 'nav.settings', title: 'Go to project settings', key: 'g s', run: () => switchTab('settings') },
  { id: 'nav.global', title: 'Go to global settings', key: 'g g', run: () => switchTab('global') },
  { id: 'nav.projects', title: 'Go to projects', key: 'g p', run: () => focusRail() },
  { id: 'nav.notifications', title: 'Go to notifications', key: 'g n', run: () => toggleNotifications() },
  { id: 'nav.close', title: 'Close panel', key: null, run: () => closeTopOverlay() }, // Esc — handled by the dispatcher
];

function allCommands() {
  const declared = new Map((S.contributions?.commands || []).map((c) => [c.id, c]));
  const out = [];
  const add = (c) => out.push({ available: true, ...c, keys: c.keybinding ? parseKeybinding(c.keybinding) : null });
  for (const h of HOST_COMMANDS) {
    const d = declared.get(h.id);
    add({ id: h.id, title: d?.title || h.title, keybinding: d ? d.keybinding : h.key, group: 'Navigation', run: h.run });
  }
  // Interaction grammar (host-owned, not server-declared): a list cursor on the
  // tasks/queue views; with a drawer open the same keys walk between tasks. When
  // focus sits in the projects rail (g p), the same keys walk the rail instead.
  const rail = inRail();
  const listy = ['tasks', 'queue'].includes(S.tab) && !rail;
  add({ id: 'list.next', title: 'Next task / row', keybinding: 'j', group: 'List', palette: false, available: listy || (!rail && !!S.selected), run: () => (S.selected ? openAdjacentTask(1) : moveCursor(1)) });
  add({ id: 'list.prev', title: 'Previous task / row', keybinding: 'k', group: 'List', palette: false, available: listy || (!rail && !!S.selected), run: () => (S.selected ? openAdjacentTask(-1) : moveCursor(-1)) });
  add({ id: 'list.next.arrow', title: 'Next task / row', keybinding: 'ArrowDown', group: 'List', palette: false, help: false, available: listy && !S.selected, run: () => moveCursor(1) });
  add({ id: 'list.prev.arrow', title: 'Previous task / row', keybinding: 'ArrowUp', group: 'List', palette: false, help: false, available: listy && !S.selected, run: () => moveCursor(-1) });
  add({ id: 'list.open', title: 'Open selected row', keybinding: 'o', group: 'List', palette: false, available: listy && !S.selected && !!S.cursorId, run: openCursorRow });
  add({ id: 'list.open.enter', title: 'Open selected row', keybinding: 'Enter', group: 'List', palette: false, help: false, available: listy && !S.selected && !!S.cursorId, run: openCursorRow });
  add({ id: 'list.archive', title: 'Archive / unarchive selected row', keybinding: 'e', group: 'List', palette: false, available: listy && !S.selected && !!S.cursorId, run: archiveCursorRow });
  // Projects rail (after g p): j/k walk projects + global entries, ↵ selects,
  // Esc returns. Same keys as the list — the two contexts are exclusive.
  add({ id: 'rail.next', title: 'Next project', keybinding: 'j', group: 'Projects', palette: false, available: rail, run: () => moveRail(1) });
  add({ id: 'rail.prev', title: 'Previous project', keybinding: 'k', group: 'Projects', palette: false, available: rail, run: () => moveRail(-1) });
  add({ id: 'rail.next.arrow', title: 'Next project', keybinding: 'ArrowDown', group: 'Projects', palette: false, help: false, available: rail, run: () => moveRail(1) });
  add({ id: 'rail.prev.arrow', title: 'Previous project', keybinding: 'ArrowUp', group: 'Projects', palette: false, help: false, available: rail, run: () => moveRail(-1) });
  add({ id: 'rail.open', title: 'Switch to project / open entry', keybinding: 'Enter', group: 'Projects', palette: false, available: rail, run: () => document.activeElement?.click() });
  add({ id: 'rail.open.o', title: 'Switch to project / open entry', keybinding: 'o', group: 'Projects', palette: false, help: false, available: rail, run: () => document.activeElement?.click() });
  // Workflow-contributed task commands: `task.<action>` binds to the selected
  // task's DECLARED action of that name — available only when the selected
  // task runs the contributing workflow and the action is currently enabled.
  const covered = new Set();
  for (const c of S.contributions?.commands || []) {
    if (c.workflow === 'core' || !c.id.startsWith('task.')) continue;
    const name = c.id.slice(5);
    covered.add(`${c.workflow}:${name}`);
    const action = S.view && S.view.workflow === c.workflow ? (S.view.actions || []).find((a) => a.name === name) : null;
    add({
      id: c.id, title: c.title, keybinding: c.keybinding, group: 'Task', workflow: c.workflow,
      available: !!(S.selected && action && action.enabled), danger: action?.danger,
      run: () => action && runDeclaredAction(action),
    });
  }
  // The declared-actions floor: any enabled action of the selected task not
  // already reachable through a contributed command still gets a palette entry.
  if (S.selected && S.view) {
    for (const a of S.view.actions || []) {
      if (covered.has(`${S.view.workflow}:${a.name}`)) continue;
      add({ id: `task.action.${a.name}`, title: a.label || a.name, group: 'Task', workflow: S.view.workflow, available: !!a.enabled, danger: a.danger, run: () => runDeclaredAction(a) });
    }
    // digits 1–9 press the Nth enabled action button in the drawer footer
    const btns = [...document.querySelectorAll('#drawer-foot [data-act]:not([disabled])')].slice(0, 9);
    btns.forEach((b, i) => add({ id: `task.slot.${i + 1}`, title: `Press “${b.textContent.replace(/\d+$/, '').trim()}”`, keybinding: String(i + 1), group: 'Task', palette: false, help: false, run: () => b.click() }));
  }
  return out;
}

// Run a workflow-declared action generically: plain actions signal straight
// through the generic endpoint; the followUp action's affordance is its compose
// box; any other action with declared args gets an auto-rendered form (§10.2).
async function runDeclaredAction(a) {
  if (!S.selected) return;
  if (a.name === 'followUp') return focusFollowup();
  if (a.args && a.args.length) return openActionForm(a);
  try {
    await api(`/api/tasks/${S.selected}/signal`, { method: 'POST', body: JSON.stringify({ signal: a.name }) });
    toast(`${a.label || a.name} sent`);
    setTimeout(refreshDrawer, 250);
    setTimeout(refreshTasks, 400);
  } catch (e) { toast(e.message, true); }
}

// Auto-rendered argument form for a declared action (ActionArg[] → controls).
function openActionForm(a) {
  const root = $('#overlay-root');
  const control = (arg) => {
    const label = `<div class="label-row"><label>${esc(arg.label || arg.name)}${arg.required ? ' *' : ''}</label></div>`;
    if (arg.type === 'text') return `<div class="form-row">${label}<textarea data-arg="${esc(arg.name)}" rows="3">${esc(arg.default ?? '')}</textarea></div>`;
    if (arg.type === 'boolean') return `<div class="form-row"><div class="switch"><input type="checkbox" data-arg="${esc(arg.name)}" ${arg.default ? 'checked' : ''} /><label>${esc(arg.label || arg.name)}</label></div></div>`;
    if (arg.type === 'select') return `<div class="form-row">${label}<select data-arg="${esc(arg.name)}">${(arg.options || []).map((o) => `<option ${o === arg.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    return `<div class="form-row">${label}<input data-arg="${esc(arg.name)}" type="${arg.type === 'number' ? 'number' : 'text'}" value="${esc(arg.default ?? '')}" /></div>`;
  };
  root.innerHTML = `<div class="palette-scrim" id="act-scrim"><div class="palette" style="width:min(480px,92vw)">
    <div style="padding:14px 16px;border-bottom:1px solid var(--line)"><b>${esc(a.label || a.name)}</b></div>
    <div style="padding:14px 16px">${(a.args || []).map(control).join('')}</div>
    <div style="padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;background:var(--surface-2)">
      <button class="btn" id="act-cancel">Cancel</button>
      <button class="btn ${a.danger ? 'danger' : 'primary'}" id="act-send">${esc(a.label || a.name)}</button>
    </div></div></div>`;
  const close = () => (root.innerHTML = '');
  $('#act-scrim').addEventListener('click', (e) => { if (e.target.id === 'act-scrim') close(); });
  $('#act-cancel').addEventListener('click', close);
  root.querySelector('[data-arg]')?.focus();
  $('#act-send').addEventListener('click', async () => {
    const body = { signal: a.name };
    for (const arg of a.args || []) {
      const el = root.querySelector(`[data-arg="${CSS.escape(arg.name)}"]`);
      if (!el) continue;
      const val = arg.type === 'boolean' ? el.checked : arg.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      if (arg.required && (val === undefined || val === '')) { el.focus(); return toast(`${arg.label || arg.name} is required`, true); }
      if (val !== undefined && val !== '') body[arg.name] = val;
    }
    try {
      await api(`/api/tasks/${S.selected}/signal`, { method: 'POST', body: JSON.stringify(body) });
      close();
      toast(`${a.label || a.name} sent`);
      setTimeout(refreshDrawer, 250);
      setTimeout(refreshTasks, 400);
    } catch (e) { toast(e.message, true); }
  });
}

// Focus the follow-up box of the open (active) conversation, falling back to the
// first available one — the box lives per-agent inside each conversation.
function focusFollowup() {
  const ta = document.querySelector('.conversation[open] .followup-input:not([disabled])')
    || document.querySelector('.followup-input:not([disabled])');
  if (ta) { ta.closest('details')?.setAttribute('open', ''); ta.focus(); }
}

// -- list cursor (roving selection on the tasks / merge-queue views) ----------
function cursorRows() {
  return [...document.querySelectorAll('#main .task-row, #main .queue-item')];
}
function rowKey(r) { return r.dataset.id || r.dataset.draft; }
function applyCursor() {
  cursorRows().forEach((r) => r.classList.toggle('cursor', rowKey(r) === S.cursorId));
}
function moveCursor(delta) {
  const rows = cursorRows();
  if (!rows.length) return;
  let i = rows.findIndex((r) => rowKey(r) === S.cursorId);
  i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + delta));
  S.cursorId = rowKey(rows[i]);
  applyCursor();
  rows[i].scrollIntoView({ block: 'nearest' });
  rows[i].focus?.(); // rows carry tabindex=0, so the cursor and Tab order agree
}
function cursorRow() { return cursorRows().find((r) => rowKey(r) === S.cursorId); }
function openCursorRow() { cursorRow()?.click(); }
function archiveCursorRow() { cursorRow()?.querySelector('[data-archive],[data-unarchive]')?.click(); }
// With the drawer open, j/k walk the same task order the list shows.
function taskOrder() {
  return S.tasks
    .filter((t) => !t.params?.draft && (!S.search || t.title.toLowerCase().includes(S.search.toLowerCase())))
    .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((t) => t.id);
}
function openAdjacentTask(delta) {
  const order = taskOrder();
  const i = order.indexOf(S.selected);
  const next = order[i < 0 ? 0 : i + delta];
  if (next) { S.cursorId = next; goToTask(next); }
}

// -- projects rail focus (g p): walk projects + global entries by keyboard ----
function railRows() { return [...document.querySelectorAll('#rail .proj, #rail .nav-item')]; }
function inRail() { return !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#rail')); }
function focusRail() {
  const rows = railRows();
  (rows.find((r) => r.dataset.id === S.projectId) || rows[0])?.focus();
}
function moveRail(delta) {
  const rows = railRows();
  if (!rows.length) return;
  let i = rows.indexOf(document.activeElement);
  i = i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + delta));
  rows[i].focus();
  rows[i].scrollIntoView({ block: 'nearest' });
}

// -- Escape layering: pop the topmost surface ---------------------------------
function closeTopOverlay() {
  const pop = $('#notif-pop');
  if (pop) return pop.remove();
  const overlay = $('#overlay-root').firstElementChild;
  if (overlay) {
    if (overlay.id === 'tf-scrim') return overlay.click(); // task form: its scrim-close flushes the draft
    return ($('#overlay-root').innerHTML = '');
  }
  if (S.selected) return closeDrawer();
}

// -- the dispatcher ------------------------------------------------------------
const CHORD = { pending: [], timer: 0 };
function resetChord() { CHORD.pending = []; clearTimeout(CHORD.timer); }
function dispatchKey(e) {
  const snap = { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
  const cmds = allCommands().filter((c) => c.keys && c.available);
  const candidates = chordCandidates(cmds, CHORD.pending, snap);
  if (!candidates.length) { resetChord(); return false; }
  e.preventDefault();
  const exact = candidates.find((c) => c.keys.length === CHORD.pending.length + 1);
  const longer = candidates.some((c) => c.keys.length > CHORD.pending.length + 1);
  if (exact && !longer) { resetChord(); exact.run(); return true; }
  CHORD.pending.push(snap); // a chord prefix ('g' …) — wait briefly for the rest
  clearTimeout(CHORD.timer);
  CHORD.timer = setTimeout(resetChord, 900);
  return true;
}
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && t.matches && (t.matches('input, textarea, select') || t.isContentEditable);
    const overlayOpen = $('#overlay-root').childElementCount > 0;
    if (typing) {
      if (e.key === 'Escape') { t.blur(); resetChord(); }
      // modifier-bearing bindings (⌘K) still work while typing outside overlays
      else if ((e.metaKey || e.ctrlKey) && !overlayOpen) dispatchKey(e);
      return;
    }
    if (overlayOpen) { // an overlay owns the keyboard; Esc pops it
      if (e.key === 'Escape') closeTopOverlay();
      return;
    }
    if (e.key === 'Escape') {
      resetChord();
      if (inRail()) return document.activeElement.blur(); // leave the rail, don't close panels
      return closeTopOverlay();
    }
    // Enter on a focused button/link is native activation, not the list cursor.
    if (e.key === 'Enter' && t && t.closest && t.closest('button, a, summary, [role="button"]')) return;
    dispatchKey(e);
  });
}

// -- the ⌘K palette: fuzzy over the registry + jump-to-task/project -----------
function openPalette() {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="palette-scrim" id="pal-scrim"><div class="palette">
    <input id="pal-in" placeholder="Type a command, task, or project…" autocomplete="off" />
    <div id="pal-list"></div>
  </div></div>`;
  const input = $('#pal-in');
  const list = $('#pal-list');
  const close = () => (root.innerHTML = '');
  let items = [];
  let active = 0;
  const GROUP_ORDER = { Task: 0, Navigation: 1, List: 2, Tasks: 3, Projects: 4 };
  const build = () => {
    const q = input.value.trim();
    items = [];
    for (const c of allCommands()) {
      if (c.palette === false || !c.available) continue;
      const score = fuzzyScore(q, c.title);
      if (score < 0) continue;
      items.push({ group: c.group, title: c.title, kbd: c.keybinding, sub: c.workflow, danger: c.danger, score, run: c.run });
    }
    if (q) { // jump-to entries only once there's a query — the empty palette is the command list
      for (const t of S.tasks) {
        if (t.params?.archived) continue;
        const score = fuzzyScore(q, t.title);
        if (score >= 0) items.push({ group: 'Tasks', title: t.title, sub: `${t.workflow}${t.params?.draft ? ' · draft' : t.lastView?.stage ? ` · ${t.lastView.stage}` : ''}`, score, run: () => (t.params?.draft ? openTaskForm(undefined, t) : goToTask(t.id)) });
      }
      for (const p of S.projects) {
        const score = fuzzyScore(q, p.name);
        if (score >= 0) items.push({ group: 'Projects', title: p.name, score, run: () => { S.projectId = p.id; S.tab = 'tasks'; refreshTasks(); renderRail(); renderMain(); } });
      }
    }
    items.sort((a, b) => (GROUP_ORDER[a.group] ?? 9) - (GROUP_ORDER[b.group] ?? 9) || b.score - a.score);
    items = items.slice(0, 14);
    active = 0;
    draw();
  };
  const draw = () => {
    let lastGroup = null;
    list.innerHTML = items.map((it, i) => {
      const head = it.group !== lastGroup ? `<div class="pal-group">${esc(it.group)}</div>` : '';
      lastGroup = it.group;
      return `${head}<div class="opt ${i === active ? 'active' : ''}${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.title)}${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}${it.kbd ? `<span class="key">${esc(fmtKeys(it.kbd))}</span>` : ''}</div>`;
    }).join('') || `<div class="pal-empty">No matches</div>`;
    list.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const it = items[i]; if (!it) return; close(); it.run(); };
  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  list.addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) run(Number(o.dataset.i)); });
  list.addEventListener('mousemove', (e) => { const o = e.target.closest('.opt'); if (o && Number(o.dataset.i) !== active) { active = Number(o.dataset.i); draw(); } });
  $('#pal-scrim').addEventListener('click', (e) => { if (e.target.id === 'pal-scrim') close(); });
  build();
  input.focus();
}

// -- "?" help: the same registry, grouped — includes every workflow's commands -
function openHelp() {
  const root = $('#overlay-root');
  const cmds = allCommands().filter((c) => c.keybinding && c.help !== false);
  const groups = [...new Set(cmds.map((c) => c.group))];
  const row = (k, title, sub) => `<div class="help-row"><span class="key">${k}</span><span>${title}${sub ? ` <span class="pal-sub">${esc(sub)}</span>` : ''}</span></div>`;
  root.innerHTML = `<div class="palette-scrim" id="help-scrim"><div class="palette" style="width:min(560px,92vw);max-height:80vh;overflow:auto">
    <div style="padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center"><b>Keyboard shortcuts</b><span style="flex:1"></span><button class="icon-btn" id="help-close">✕</button></div>
    <div style="padding:6px 16px 16px">
      ${groups.map((g) => `<div class="section-h">${esc(g)}</div>${cmds.filter((c) => c.group === g).map((c) => row(esc(fmtKeys(c.keybinding)), esc(c.title), c.workflow)).join('')}`).join('')}
      <div class="section-h">In the task drawer</div>
      ${row('1–9', 'Press the Nth action button (whatever the workflow declares)')}
      ${row(esc(fmtKeys('meta+Enter')), 'Send follow-up (from inside the compose box)')}
      ${row('Esc', 'Close the topmost panel / leave a text field')}
      <div class="section-h">Quick add</div>
      ${row('↵', 'Open the full task form with what you typed')}
      ${row(esc(fmtKeys('meta+Enter')), 'Add the task directly')}
    </div></div></div>`;
  $('#help-close').addEventListener('click', () => (root.innerHTML = ''));
  $('#help-scrim').addEventListener('click', (e) => { if (e.target.id === 'help-scrim') root.innerHTML = ''; });
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
