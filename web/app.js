// karmax — operations console for autonomous agents.
// A dispatch board: tasks advance along the stage pipeline; the operator acts at
// the decision points. Talks only to the gateway (SPEC §3.4).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Small, code-native icons used by icon-only controls. Keeping them inline makes
// the no-build-step console self-contained while still giving every button a
// proper text alternative through its aria-label/title.
const ICON = {
  draft: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 17 1.5-.3 5.2-5.2a1.4 1.4 0 0 0-2-2l-5.2 5.2L8 17z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

const S = {
  token: null,
  meta: null,
  contributions: null,
  projects: [],
  organizations: [],
  organizationId: null,
  organizationMembers: [],
  teams: [],
  users: [],
  inbox: [],
  deliveryPreferences: null,
  projectId: null,
  tasks: [],
  attemptGroup: null, // logical-task group for the open task page
  deleted: new Set(), // ids of drafts deleted this session — tombstones so a stale
  // in-flight list refresh (issued before the DELETE landed) can't resurrect them.
  tab: 'tasks',
  selected: null, // taskId of the open task page (null when a list view is showing)
  viewingAttempt: null, // explicit attempt selection; prevents principal auto-redirection
  view: null, // selected task view
  taskTab: null, // open tab on the task page ('overview'|'checkin'|'parameters'|'advanced'; null → auto)
  checkinSel: null, // selected check-in pane: an agent role, or 'terminal' (null → the stage's agent)
  taskEvents: [],
  liveOutput: '',
  followupDrafts: {}, // (taskId/role) -> half-typed follow-up text, so it survives re-renders and pane switches
  activity: [],
  search: '', // the working query string (Linear-style tokens + free text)
  // Task organization (PLAN-search-views): a view IS a saved query.
  tags: [], // project tag catalogue (labels + topics, hierarchical)
  views: [], // saved views (named queries)
  fields: [], // searchable-field registry (drives the filter/sort/group menus)
  activeView: null, // id of the selected saved view, or null for the ad-hoc/default view
  searchResult: null, // { tasks, groups, total } from the last server evaluation
  orgProjectId: null, // which project S.tags/S.views were loaded for (staleness guard)
  schema: [],
  paramDefaults: {},
  sessions: {}, // role -> provider session id, for the "fork in CLI" copy command
  ws: null,
  hostDiagTimer: null, // live-refresh handle for the dashboard host-diagnostics panel
  procTimer: null, // live-refresh handle for the dashboard processes (task manager) panel
  cursorId: null, // the list cursor (roving selection) on the tasks/queue views
  returnRoute: null, // where closing the task page returns to (the list/queue we opened from)
  queueOrders: {}, // merge domain -> { queue: taskId[], current? } authoritative order from the coordinator
  agentQueue: { capacity: 3, queue: [], current: [] }, // workflow-owned host admission queue
  modelCatalog: null, // provider-native model metadata loaded from the gateway
  worldProviderConnections: [], // org's connected remote sandbox providers → Agent-environment options
  inviteNotice: null,
};

// Non-principal attempts are intentionally absent from S.tasks because the list
// has one row per logical task. Page lookups must also consult the loaded group.
function taskRecord(id) {
  return (S.attemptGroup?.attempts || []).find((t) => t.id === id) || (S.tasks || []).find((t) => t.id === id);
}

// ── URL routing (SPEC §10.6) ────────────────────────────────────────────────
// Every page is a host-owned route; the browser URL is the single source of truth
// for {organization, project, tab, open task}. Workflows/coordinators never own a
// URL — a page like the merge queue is a first-party route that projects
// coordinator/task state. Every page lives under its organization's slug; projects
// are addressed by a slug of their name; tasks are numbered per project.
// Scheme:
//   /                                    → home (redirects into the current org)
//   /<org>                               → org home (redirects to a project or dashboard)
//   /<org>/dashboard                     → organization dashboard
//   /<org>/settings                      → organization settings
//   /<org>/inbox                         → inbox
//   /<org>/wiki                          → organization wiki
//   /<org>/<project>                     → task list (also /queue, /activity, /wiki, /settings)
//   /<org>/<project>/tasks/:num          → the task's own page (permalink)
//   /<org>/<project>/tasks/:num/:tab     → the task page pinned to one of its tabs
// Pre-organization URLs (/dashboard, /organization, /projects/:name/…) are still
// parsed and then canonicalised to the org form.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}
function projectSlug(p) { return p ? slugify(p.name) : ''; }
function projectById(pid) { return (S.projects || []).find((p) => p.id === pid); }
// Resolve a URL slug back to a project, optionally scoped to one organization
// (project slugs need only be unique within their org). Matches the slugified name
// (the common, human case), falling back to a raw project id for safety. On a slug
// collision the first-created project wins (names are expected distinct).
function projectBySlug(slug, organizationId) {
  const s = slugify(slug);
  const pool = (S.projects || []).filter((p) => !organizationId || p.organizationId === organizationId);
  return pool.find((p) => slugify(p.name) === s) || pool.find((p) => p.id === slug)
    || (S.projects || []).find((p) => p.id === slug);
}

// Organizations own the top path segment. They carry a persisted slug; fall back
// to a slug of the name for older records that predate it.
function orgSlug(o) { return o ? (o.slug || slugify(o.name)) : ''; }
function organizationById(id) { return (S.organizations || []).find((o) => o.id === id); }
function organizationBySlug(slug) {
  const s = slugify(slug);
  return (S.organizations || []).find((o) => orgSlug(o) === s) || (S.organizations || []).find((o) => o.id === slug);
}
// The organization whose slug prefixes every URL — the one selected in the
// switcher, else the org owning the current project, else the first known org.
function currentOrg() {
  return organizationById(S.organizationId)
    || organizationById(projectById(S.projectId)?.organizationId)
    || (S.organizations || [])[0];
}
// `/<org>` prefix for the current (or a given) organization; '' when none is known.
function orgBase(org = currentOrg()) { return org ? `/${orgSlug(org)}` : ''; }

// Second-segment words that name an organization-level view rather than a project.
const ORG_VIEWS = { dashboard: 'dashboard', settings: 'organization', inbox: 'inbox', wiki: 'orgwiki', profile: 'profile' };

function parseRoute(pathname) {
  const seg = decodeURI(pathname).replace(/\/+$/, '').split('/').filter(Boolean);
  if (!seg.length) return { name: 'home' };
  if (seg[0] === 'invite') return { name: 'invite' };
  // Pre-organization URLs — resolved, then canonicalised to the org form.
  if (seg[0] === 'dashboard') return { name: 'global', tab: 'dashboard', legacy: true };
  if (seg[0] === 'settings' || seg[0] === 'organization') return { name: 'global', tab: 'organization', legacy: true };
  if (seg[0] === 'inbox') return { name: 'global', tab: 'inbox', legacy: true };
  if (seg[0] === 'projects' && seg[1]) {
    const tab = ['tasks', 'queue', 'activity', 'wiki', 'settings'].includes(seg[2]) ? seg[2] : 'tasks';
    const taskKey = seg[2] === 'tasks' && seg[3] ? seg[3] : null;
    const taskTab = taskKey && TASK_TABS.some((t) => t.key === seg[4]) ? seg[4] : null;
    return { name: 'project', slug: seg[1], tab, taskKey, taskTab, legacy: true };
  }
  // New scheme: /<org>/… — everything is namespaced under the organization slug.
  const org = seg[0];
  if (!seg[1]) return { name: 'global', org, tab: null };            // /<org> → org home
  if (ORG_VIEWS[seg[1]]) return { name: 'global', org, tab: ORG_VIEWS[seg[1]] };
  const tab = ['tasks', 'queue', 'activity', 'wiki', 'settings'].includes(seg[2]) ? seg[2] : 'tasks';
  const taskKey = seg[2] === 'tasks' && seg[3] ? seg[3] : null;
  const taskTab = taskKey && TASK_TABS.some((t) => t.key === seg[4]) ? seg[4] : null;
  return { name: 'project', org, slug: seg[1], tab, taskKey, taskTab };
}

// The list/tab route for a project (by id): /<org>/<project> for the default
// tasks tab, with the tab appended for the others.
function projectRoute(pid, tab = 'tasks') {
  const p = projectById(pid);
  if (!p) return globalRoute('dashboard');
  const base = `${orgBase(organizationById(p.organizationId)) || orgBase()}/${projectSlug(p)}`;
  return tab === 'tasks' ? base : `${base}/${tab}`;
}

// An organization-level route (dashboard / settings / inbox) under the current
// (or a given) org's slug. Internal tab key 'organization' → URL segment 'settings'.
function globalRoute(tab, org = currentOrg()) {
  const seg = tab === 'organization' ? 'settings' : tab === 'orgwiki' ? 'wiki' : tab;
  return `${orgBase(org)}/${seg}`;
}

// Navigate: update the URL then reconcile app state to it. `replace` swaps the
// current history entry instead of pushing a new one.
function go(path, opts = {}) {
  closeTaskFormPage();
  if (path !== location.pathname) {
    history[opts.replace ? 'replaceState' : 'pushState']({ kx: 1 }, '', path);
  }
  return applyRoute();
}

// The task form page floats over #main with the shell (topbar/rail) still live
// behind it, so the user can navigate mid-edit. Any navigation closes it like
// leaving any other page — via its close button, which flushes the draft.
function closeTaskFormPage() {
  if ($('#tf-page')) $('#tf-close')?.click();
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
    return go(pid ? projectRoute(pid) : globalRoute('dashboard'), { replace: true });
  }
  if (r.name === 'global') {
    // Select the organization named in the URL (if any) before painting.
    if (r.org) {
      const org = organizationBySlug(r.org);
      if (org && org.id !== S.organizationId) {
        S.organizationId = org.id;
        S.projectId = S.projects.find((p) => p.organizationId === org.id)?.id || null;
        await loadCollaboration().catch(() => {});
      }
    }
    // Bare /<org> → that org's default project (or its dashboard); pre-org URLs
    // (/dashboard, /organization, …) → rewrite to the org-prefixed form. Only
    // redirect when the canonical path actually differs, so an unresolvable slug
    // (or a workspace with no organizations yet) renders instead of looping.
    if (!r.tab) {
      const pid = S.projectId || S.projects.find((p) => p.organizationId === S.organizationId)?.id;
      const dest = pid ? projectRoute(pid) : globalRoute('dashboard');
      if (dest !== location.pathname) return go(dest, { replace: true });
      r.tab = 'dashboard'; // fall through to a real page
    }
    if (r.legacy) {
      const dest = globalRoute(r.tab);
      if (dest !== location.pathname) return go(dest, { replace: true });
    }
    closeTaskDom();
    S.tab = r.tab;
    renderRail();
    renderMain();
    if (r.tab === 'dashboard') renderDashboard();
    if (r.tab === 'organization') hydrateOrganizationView();
    return;
  }
  // project / task routes → resolve the org + project (by name-slug) + optional open task
  if (r.org) {
    const org = organizationBySlug(r.org);
    if (org) S.organizationId = org.id;
  }
  const proj = projectBySlug(r.slug, S.organizationId) || projectBySlug(r.slug);
  if (!proj) { toast('Project not found', true); return go('/', { replace: true }); }
  // Pre-organization /projects/:name/… → rewrite to the org-prefixed permalink.
  if (r.legacy) {
    const dest = r.taskKey
      ? `${projectRoute(proj.id)}/tasks/${r.taskKey}${r.taskTab ? `/${r.taskTab}` : ''}`
      : projectRoute(proj.id, r.tab);
    return go(dest, { replace: true });
  }
  const pid = proj.id;
  S.organizationId = proj.organizationId || S.organizationId;
  const tab = r.tab || 'tasks';
  if (pid !== S.projectId) {
    // Switching projects: drop the previous project's per-project view state so
    // its query/selected-view/roving-cursor/search-result can't bleed into the
    // new project (they'd otherwise re-run the old query against new data and
    // highlight a view/cursor that doesn't exist here).
    S.projectId = pid;
    S.search = '';
    S.activeView = null;
    S.searchResult = null;
    S.cursorId = null;
    await loadTasks().catch(() => {});
  }
  else if (!S.tasks?.length) { await loadTasks().catch(() => {}); }
  await loadOrg().catch(() => {}); // tags / saved views / field registry for this project
  // Resolve the open task from the URL BEFORE painting, so a permalink paints once
  // (its task page), not the list with a page swapped in a beat later.
  let taskId = null;
  if (r.taskKey) {
    taskId = await resolveProjectTaskKey(pid, r.taskKey);
    if (!taskId) toast(`Task #${r.taskKey} not found`, true);
  }
  S.tab = tab;
  if (!taskId) closeTaskDom();
  if (tab === 'tasks' && !taskId) await runSearch().catch(() => {});
  renderRail();
  if (taskId) {
    if (S.selected !== taskId) return openTask(taskId, r.taskTab);
    if (r.taskTab) S.taskTab = r.taskTab;
    return renderTaskPage();
  }
  renderMain();
  if (tab === 'activity') seedActivity();
  if (tab === 'queue') seedQueue();
  if (tab === 'dashboard') renderDashboard();
}

// The permalink for a task (/<org>/<project>/tasks/:num) — used for in-place
// navigation and for "open in a new tab" (Ctrl/⌘-click, middle-click).
function taskUrl(id) {
  const rec = taskRecord(id);
  const p = projectById(rec?.projectId || S.projectId);
  const keyPart = rec && rec.num != null ? String(rec.num) : id;
  return p ? `${projectRoute(p.id)}/tasks/${keyPart}` : location.pathname;
}

// True when a click means "open in a new tab/window" by browser convention: any
// modifier key, or a non-primary mouse button. Real <a> elements honour this
// natively — we only consult it so JS handlers never hijack such a click.
function isNewTabClick(ev) {
  return ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey;
}

// Navigate to an in-app path, remembering the list to return to when opening a
// task from a non-task page (so Esc / j-k walking returns to the list, not the
// previous task). Generalises the old goToTask logic to any SPA link.
function spaNavigate(href) {
  const to = parseRoute(href);
  if (to && to.taskKey && !parseRoute(location.pathname).taskKey) S.returnRoute = location.pathname;
  return go(href);
}

// Every in-app link is a real `<a data-spa href="/…">` anchor, so the browser
// hands us every native "open in a new tab/window" affordance for free:
// Ctrl/⌘-click, middle-click, Shift-click, right-click → "Open link in new tab",
// drag-to-bookmark and the hover URL preview. This single delegated handler is
// the *only* thing that keeps a plain left-click fast — it cancels the full-page
// navigation and routes in place. Every modified or non-primary click falls
// through untouched, so the browser opens it exactly as it would any web link.
function installLinkRouter() {
  document.addEventListener('click', (ev) => {
    if (isNewTabClick(ev) || ev.defaultPrevented) return;
    const a = ev.target.closest('a[data-spa]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href[0] !== '/') return; // only same-origin app routes route in place
    ev.preventDefault();
    spaNavigate(href);
  });
}

// Push a task permalink (in place), remembering where to return on close.
function goToTask(id) { return spaNavigate(taskUrl(id)); }

// Make a whole row open its task like a real link. Rather than fake it in JS
// (which can't offer the right-click "Open in new tab" menu, Shift-click, or a
// hover preview), we lay a real `<a>` across the row: an absolutely-positioned
// overlay that the browser treats as an ordinary link for every "new tab"
// gesture, while installLinkRouter() catches its plain left-click and routes in
// place — so normal clicking stays exactly as fast as before, with no reload.
// Inner buttons/handles sit above the overlay (see the .has-row-link CSS) and
// keep working; the overlay is non-draggable so it never shadows a row's own
// drag-to-reorder. `getId()` returns the task id (falsy → leave the row inert).
function wireTaskNav(el, getId) {
  const id = getId();
  if (!id) return;
  el.classList.add('has-row-link');
  const a = document.createElement('a');
  a.className = 'row-link';
  a.href = taskUrl(id);
  a.dataset.spa = '';
  a.draggable = false;
  a.tabIndex = -1;
  a.setAttribute('aria-hidden', 'true');
  el.appendChild(a);
}

// A short human label for a task id: `#num` when known, else a short id.
function numLabel(taskId) {
  const t = (S.tasks || []).find((x) => x.id === taskId);
  return t && t.num != null ? `#${t.num}` : String(taskId || '').slice(0, 8);
}

function principalLabel(principal) {
  if (!principal) return 'Unassigned';
  if (principal.kind === 'user') return S.users.find((u) => u.id === principal.userId)?.name || principal.userId;
  if (principal.kind === 'team') return S.teams.find((t) => t.id === principal.teamId)?.name || principal.teamId;
  return `Task agent · ${principal.role}`;
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
function modelOptions(provider) {
  const live = S.modelCatalog?.[provider];
  return live?.length ? live.map((m) => m.id) : (MODELS[provider] || MODELS.claude);
}
// Which reasoning-effort levels a given model actually accepts (mirrors the
// server's src/agent/effort.ts gating). Empty = the model has no effort control.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
function effortLevelsFor(provider, model) {
  const m = (model || '').toLowerCase();
  const advertised = S.modelCatalog?.[provider]?.find((x) => x.id === model)?.effort;
  if (advertised) return advertised;
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

// The "Agent environment" (worldProvider) choices depend on the deployment and
// which remote sandbox providers the organization has connected — so the manifest
// ships an empty option list and the client fills it in. An empty first option ⇒
// inherit the project / organization default.
function agentEnvOptions() {
  const local = S.meta?.hosted ? [] : ['worktree', 'container'];
  const connected = (S.worldProviderConnections || [])
    .filter((c) => c.enabled && c.credentialConfigured)
    .map((c) => c.provider);
  return ['', ...new Set([...local, ...connected])];
}

function schemaFor(workflow) {
  const params = S.schema.find((s) => s.name === workflow)?.params || [];
  // Fill the Agent-environment select's options from the live provider catalog.
  return params.map((f) => (f.name === 'worldProvider' ? { ...f, options: agentEnvOptions() } : f));
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
// `kind` distinguishes the primary inherited value from an optional alternate
// source used by fields that explicitly offer one.
const resetBtn = (name, label = 'Reset to default', kind = 'primary') =>
  `<button type="button" class="field-reset" data-reset="${esc(name)}" data-reset-kind="${esc(kind)}" hidden title="Drop this override and inherit the default">↺ ${esc(label)}</button>`;
// `alt` (optional): { primaryLabel, altLabel } — when present, render two reset
// buttons (primary → data-inherit, alt → data-inherit-alt).
const resetBtns = (name, alt) =>
  alt ? resetBtn(name, alt.primaryLabel, 'primary') + resetBtn(name, alt.altLabel, 'alt') : resetBtn(name);
const fieldLabel = (f, alt) =>
  `<div class="label-row"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${f.required ? '' : resetBtns(f.name, alt)}</div>` +
  (f.help ? `<div style="font-size:11px;color:var(--ink-3);margin:-2px 0 4px">${esc(f.help)}</div>` : '');

function renderField(f, own, inherited, withChips, alt) {
  const v = eff(own, inherited) ?? '';
  const label = fieldLabel(f, alt);
  const altAttr = alt ? ` data-inherit-alt='${esc(JSON.stringify(alt.value ?? null))}'` : '';
  const attrs = `data-field="${esc(f.name)}" data-ftype="${f.type}" ${inhAttr(inherited)}${altAttr}`;
  if (f.type === 'agent') return `<div class="form-row" data-row="${esc(f.name)}">${label}${renderAgentField(f, own, inherited)}</div>`;
  if (f.type === 'confirmer') return `<div class="form-row" data-row="${esc(f.name)}">${label}${renderConfirmerField(f, own, inherited, alt)}</div>`;
  if (f.type === 'text') {
    // The prompt field (withChips) also carries the @-mention affordance, so its
    // placeholder advertises both image paste and wiki tagging.
    const placeholder = withChips ? 'Describe the task (paste an image to attach, type @ to add context from the wiki)' : (f.placeholder || '');
    const ta = `<textarea ${attrs} rows="4" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
    // For the prompt field, pasted images render inside the box (below the text),
    // growing it as needed — rather than in a separate "Images" section.
    if (withChips)
      // The prompt box's clean bottom row: a borderless "wiki context" field,
      // seeded elsewhere with the default @proj:tag:default / @org:tag:default so
      // the user sees (and can backspace away) what's inlined by default.
      return `<div class="form-row" data-row="${esc(f.name)}">${label}<div class="prompt-field">${ta}<div class="img-chips" id="tf-chips" style="display:none"></div>
        <div class="prompt-context-row"><span class="pc-prefix" title="Wiki pages, labels (@…:tag:…), or folders (@…/*) inlined into this task's context. Type @ to add; backspace to remove.">context</span><textarea id="tf-context" class="prompt-context" rows="1" spellcheck="false" placeholder="type @ to attach a wiki page, label, or folder"></textarea></div></div></div>`;
    return `<div class="form-row" data-row="${esc(f.name)}">${label}${ta}</div>`;
  }
  if (f.type === 'boolean')
    return `<div class="form-row" data-row="${esc(f.name)}"><div class="switch"><input type="checkbox" ${attrs} ${v ? 'checked' : ''} /><label>${esc(f.label)}</label><span style="flex:1"></span>${f.required ? '' : resetBtns(f.name, alt)}</div></div>`;
  if (f.type === 'select') {
    // Keep the effective value selectable even if it isn't in the (possibly
    // dynamic) option list — e.g. an inherited provider not connected locally.
    const opts = [...(f.options || [])];
    if (v !== '' && !opts.includes(v)) opts.push(v);
    return `<div class="form-row" data-row="${esc(f.name)}">${label}<select ${attrs}>${opts.map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${o === '' ? 'Inherit default' : esc(o)}</option>`).join('')}</select></div>`;
  }
  if (f.type === 'list') {
    const text = Array.isArray(v) ? v.join('\n') : v;
    return `<div class="form-row" data-row="${esc(f.name)}">${label}<textarea ${attrs} rows="2" placeholder="${esc(f.placeholder || 'one per line')}">${esc(text)}</textarea></div>`;
  }
  // string / number / branch / repoPath
  return `<div class="form-row" data-row="${esc(f.name)}">${label}<input ${attrs} type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" /></div>`;
}

const agentGroupFields = (fields) => ['do', 'merge', ...(fields.some((f) => f.type === 'agent' && f.role === 'resolve') ? ['resolve'] : [])]
  .map((role) => fields.find((f) => f.type === 'agent' && f.role === role));
const inferredSeparateAgents = (values = {}, roles = ['do', 'merge']) => values.separateAgents === true ||
  (values.separateAgents === undefined && roles.some((role) => values[`agent:${role}`] !== undefined));

// Software-dev's operational roles usually share one identity. Keep the
// manifest's role fields (the workflow still consumes those)
// while presenting a compact virtual `agent:unified` field by default.
function renderAgentGroup(fields, own = {}, inherited = {}, altFor) {
  const [doField, mergeField, ...optionalFields] = agentGroupFields(fields);
  if (!doField || !mergeField) return null;
  const roleFields = [doField, mergeField, ...optionalFields].filter(Boolean);
  const separate = inferredSeparateAgents(own, roleFields.map((f) => f.role));
  const unifiedField = { ...doField, name: 'agent:unified', role: 'unified', label: 'Agent' };
  const unifiedOwn = own['agent:unified'] ?? (!separate ? own['agent:do'] : undefined);
  const unifiedInherited = inherited['agent:do'] ?? inherited['agent:unified'];
  return `<div class="agent-group" data-agent-group>
    <label class="agent-separate-toggle"><input type="checkbox" class="agent-separate" ${separate ? 'checked' : ''}> Separate ${roleFields.map((f) => f.label.replace(/ agent$/, '')).join(', ').replace(/, ([^,]+)$/, ' and $1')} agent configurations</label>
    <div class="agent-unified-panel" ${separate ? 'hidden' : ''}>${renderField(unifiedField, unifiedOwn, unifiedInherited, false, altFor?.(doField))}</div>
    <div class="agent-separated-panel" ${separate ? '' : 'hidden'}>
      ${roleFields.map((f) => renderField(f, own[f.name], inherited[f.name], false, altFor?.(f))).join('')}
    </div>
  </div>`;
}

function renderFields(fields, own = {}, inherited = {}, withPromptChips = false, altFor) {
  const group = renderAgentGroup(fields, own, inherited, altFor);
  const grouped = new Set(group ? agentGroupFields(fields).map((f) => f.name) : []);
  let groupDrawn = false;
  // Base, target, and the Agent environment share one row (rendered at the first
  // of them present, in this order); the rest are skipped where they'd fall.
  const inlineRow = ['base', 'target', 'worldProvider'].map((n) => fields.find((x) => x.name === n)).filter(Boolean);
  const inlineNames = new Set(inlineRow.map((f) => f.name));
  let inlineDrawn = false;
  const html = [];
  for (const f of fields) {
    if (grouped.has(f.name)) {
      if (!groupDrawn) { html.push(group); groupDrawn = true; }
      continue;
    }
    if (inlineNames.has(f.name) && inlineRow.length > 1) {
      if (!inlineDrawn) {
        inlineDrawn = true;
        html.push(`<div class="branch-pair${inlineRow.length === 3 ? ' cols-3' : ''}">${inlineRow.map((g) => renderField(g, own[g.name], inherited[g.name], false, altFor?.(g))).join('')}</div>`);
      }
      continue;
    }
    html.push(renderField(f, own[f.name], inherited[f.name], withPromptChips && f.name === 'prompt', altFor?.(f)));
  }
  return html.join('');
}

function renderAgentField(f, spec, inherited) {
  const inh = inherited || {};
  const e = spec || inh; // prefill with the effective spec
  const provider = e.provider || 'claude';
  const role = f.role || f.name;
  const resumeEnabled = !!(spec?.resumeFrom?.taskId || spec?.resumeFrom?.sessionId);
  return `<div class="agent-field" data-agent="${esc(role)}" ${inhAttr(inh)}>
    <div class="agent-controls">
      <select class="af-provider">${['claude', 'codex', 'mock'].map((p) => `<option ${p === provider ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <div class="combo af-model-combo" style="flex:1;min-width:140px">
        <input class="af-model" placeholder="model" value="${esc(e.model || '')}" autocomplete="off" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show model choices">▾</button>
        <div class="combo-menu" hidden></div>
      </div>
      ${effortSelectHtml('af-effort', provider, e.model, e.effort || '')}
    </div>
    <label class="af-resume-toggle"><input type="checkbox" class="af-resume-enabled" ${resumeEnabled ? 'checked' : ''}> ${role === 'unified' ? 'Fork Do agent from a previous agent' : 'Fork a previous agent'}</label>
    <div class="af-resume-panel" ${resumeEnabled ? '' : 'hidden'}>
      <button type="button" class="btn sm af-resume-pick">⌕ Search tasks to fork from…</button>
      <div class="af-resume-chosen" data-resume="${esc(JSON.stringify(spec?.resumeFrom?.taskId ? { taskId: spec.resumeFrom.taskId, role: spec.resumeFrom.role } : null))}">${spec?.resumeFrom?.taskId ? resumeChosenInner(spec.resumeFrom) : ''}</div>
      <input class="af-resume-session" placeholder="…or paste a provider conversation/session id to continue" value="${esc(spec?.resumeFrom?.sessionId || '')}" />
    </div>
  </div>`;
}

// The chosen fork source as a friendly chip (the {taskId, role} JSON rides in the
// container's data-resume; collectForm/collectParamEdits read it via readResume).
function resumeChosenInner(rf, task) {
  const t = task || (S.tasks || []).find((x) => x.id === rf.taskId);
  const label = `⑂ forking ${rf.role || 'do'} agent of ${t?.num != null ? `#${t.num} ` : ''}${t ? t.title : rf.taskId}`;
  return `${esc(label)}<button type="button" class="af-resume-clear" title="Clear">✕</button>`;
}

// Read an agent box's fork/resume choice back out: the picker's {taskId, role}
// from data-resume, with a pasted provider session id merged on top.
function readResume(box) {
  if (!box.querySelector('.af-resume-enabled')?.checked) return undefined;
  let resumeFrom;
  try { resumeFrom = JSON.parse(box.querySelector('.af-resume-chosen')?.dataset.resume || 'null') || undefined; } catch {}
  const sessionId = box.querySelector('.af-resume-session')?.value.trim();
  if (sessionId) resumeFrom = { ...(resumeFrom || {}), sessionId };
  return resumeFrom;
}

// The confirmer field: an ordered LIST of confirm layers, played sequentially at
// the Review gate — each layer is a human confirmation or a review agent; zero
// layers ⇒ auto-confirm. Layers can be added, removed and reordered; an agent
// layer reuses the SAME agent sub-form as Do/Merge/Resolve (renderAgentField, so
// provider/model/effort + "Fork a previous agent" all work identically) plus the
// review-request prompt template — pre-filled with the built-in default
// (f.promptDefault) and stored only when edited, so it keeps inheriting otherwise.
// Legacy single-gate values ({mode:…}) are normalized to layers on read.
function cfLayersOf(v) {
  if (Array.isArray(v?.layers)) return v.layers;
  const mode = v?.mode || 'human';
  if (mode === 'auto') return [];
  if (mode === 'agent') { const { mode: _m, layers: _l, agentDefault: _d, ...rest } = v || {}; return [{ kind: 'agent', ...rest }]; }
  return [{ kind: 'human', audience: ['@creator'] }];
}
function humanAudienceOptions() {
  return [
    ['@creator', 'Task creator'], ['@all', 'Everyone in the organization'],
    ['@owners', 'Organization owners'], ['@project', 'Everyone with project access'],
    ...S.organizationMembers.map((m) => [`user:${m.userId}`, `Person · ${principalLabel({ kind: 'user', userId: m.userId })}`]),
    ...S.teams.map((t) => [`@team:${t.slug}`, `Team · ${t.name}`]),
  ];
}
function cfLayerHtml(f, layer, agentDefault) {
  const isAgent = layer.kind === 'agent';
  const promptVal = (isAgent ? layer.prompt ?? f.promptDefault : f.promptDefault) || '';
  const audience = (layer.audience?.length ? layer.audience : ['@creator']).join(', ');
  return `<div class="cf-layer" data-kind="${esc(layer.kind)}">
    <div class="cf-layer-head" style="display:flex;gap:8px;align-items:center">
      <span class="cf-layer-num" style="font-size:11px;color:var(--ink-3);min-width:14px;text-align:right"></span>
      <select class="cf-kind">${[['human', 'Human confirms'], ['agent', 'Agent reviews']].map(([k, l]) => `<option value="${k}" ${k === layer.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <span style="flex:1"></span>
      <button type="button" class="btn sm cf-move" data-dir="-1" title="Move layer up">↑</button>
      <button type="button" class="btn sm cf-move" data-dir="1" title="Move layer down">↓</button>
      <button type="button" class="btn sm cf-del" title="Remove this layer">✕</button>
    </div>
    <div class="cf-human" style="margin:8px 0 0 22px;${isAgent ? 'display:none' : ''}">
      <label class="form-row">Who confirms
        <input class="cf-audience" list="human-audience-options" value="${esc(audience)}" placeholder="@creator, @team:leaders, or search for a person" />
      </label>
      <datalist id="human-audience-options">${humanAudienceOptions().map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</datalist>
      <div class="task-sub">Comma-separated. Teams use readable routes such as @team:leaders. Add sequential human steps when different people must confirm in order.</div>
    </div>
    <div class="cf-agent" style="margin-top:8px;${isAgent ? '' : 'display:none'}">${renderAgentField(f, isAgent ? layer : agentDefault, isAgent ? {} : agentDefault)}
      <div style="font-size:11px;color:var(--ink-3);margin:8px 0 4px">Review-request prompt — sent to this agent at each Review. Placeholders: {{prompt}} (the task prompt), {{response}} (the agent's latest response); also {{reviewInfo}}, {{changedFiles}}, {{transcript}}.</div>
      <textarea class="cf-prompt" rows="6" style="width:100%;resize:vertical">${esc(promptVal)}</textarea>
    </div>
  </div>`;
}
function cfListHtml(f, layers, agentDefault) {
  return layers.map((l) => cfLayerHtml(f, l, agentDefault)).join('');
}
function renderConfirmerField(f, own, inherited, alt) {
  const inh = inherited || {};
  const layers = cfLayersOf(own || inh);
  const agentDefault = inh.agentDefault || {};
  const altAttr = alt ? ` data-inherit-alt='${esc(JSON.stringify(alt.value ?? null))}'` : '';
  return `<div class="confirmer-field" data-confirmer="${esc(f.role || f.name)}" data-inherit='${esc(JSON.stringify(inh))}'${altAttr} data-prompt-default='${esc(JSON.stringify(f.promptDefault ?? ''))}' data-agent-default='${esc(JSON.stringify(agentDefault))}'>
    <div class="cf-layers">${cfListHtml(f, layers, agentDefault)}</div>
    <div class="cf-empty" style="font-size:12px;color:var(--ink-3);padding:2px 0;${layers.length ? 'display:none' : ''}">No layers — the task auto-confirms at Review.</div>
    <button type="button" class="btn sm cf-add" style="margin-top:6px">+ Add layer</button>
  </div>`;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const normSpec = (s) => (s ? { provider: s.provider, model: s.model || '', effort: s.effort || '' } : null);
// Canonical shape of a confirm layer for changed-vs-inherited comparison.
const normLayers = (ls) =>
  (ls || []).map((l) =>
    l.kind === 'agent'
      ? { kind: 'agent', provider: l.provider || '', model: l.model || '', effort: l.effort || '', prompt: l.prompt || '', resume: l.resumeFrom || null }
      : { kind: 'human', audience: l.audience?.length ? [...l.audience] : ['@creator'] },
  );

// Read a confirmer box's layer list back out of the DOM (the stored value shape).
function readConfirmerLayers(box) {
  const promptDefault = JSON.parse(box.getAttribute('data-prompt-default') || '""');
  return [...box.querySelectorAll('.cf-layer')].map((row) => {
    if (row.querySelector('.cf-kind')?.value !== 'agent') {
      const audience = (row.querySelector('.cf-audience')?.value || '').split(',').map((value) => value.trim()).filter(Boolean);
      return { kind: 'human', audience: audience.length ? audience : ['@creator'] };
    }
    const ab = row.querySelector('.agent-field');
    const spec = { kind: 'agent', provider: ab.querySelector('.af-provider').value };
    const model = ab.querySelector('.af-model').value.trim();
    const effort = ab.querySelector('.af-effort').value;
    if (model) spec.model = model;
    if (effort) spec.effort = effort;
    const resumeFrom = readResume(ab);
    if (resumeFrom) spec.resumeFrom = resumeFrom;
    // Store the review-request prompt only when it diverges from the built-in
    // default; the pre-filled default itself is never persisted.
    const prompt = row.querySelector('.cf-prompt')?.value ?? '';
    if (prompt.trim() !== '' && prompt !== promptDefault) spec.prompt = prompt;
    return spec;
  });
}

// Read a form's values back out; only return fields CHANGED from inherited.
function collectForm(root, fields) {
  const out = {};
  const group = root.querySelector('[data-agent-group]');
  const groupedRoles = group ? new Set(agentGroupFields(fields).map((f) => f.role)) : new Set();
  if (group) {
    const separate = group.querySelector('.agent-separate').checked;
    out.separateAgents = separate;
    const panels = separate ? [group.querySelector('.agent-separated-panel')] : [group.querySelector('.agent-unified-panel')];
    const selectedFields = separate
      ? fields.filter((f) => f.type === 'agent' && groupedRoles.has(f.role))
      : [{ ...fields.find((f) => f.type === 'agent' && f.role === 'do'), name: 'agent:unified', role: 'unified' }];
    Object.assign(out, collectForm(panels[0], selectedFields));
  }
  for (const f of fields) {
    if (f.type === 'agent' && groupedRoles.has(f.role)) continue;
    if (f.type === 'agent') {
      const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
      const spec = { provider: box.querySelector('.af-provider').value };
      const model = box.querySelector('.af-model').value.trim();
      const effort = box.querySelector('.af-effort').value;
      if (model) spec.model = model;
      if (effort) spec.effort = effort;
      const resumeFrom = readResume(box);
      if (resumeFrom) spec.resumeFrom = resumeFrom;
      // include only if the agent differs from inherited OR a resume was chosen
      if (resumeFrom || !sameJson(normSpec(spec), normSpec(inh))) out[f.name] = spec;
      continue;
    }
    if (f.type === 'confirmer') {
      const box = root.querySelector(`.confirmer-field[data-confirmer="${CSS.escape(f.role || f.name)}"]`);
      if (!box) continue;
      const inh = JSON.parse(box.getAttribute('data-inherit') || 'null');
      const layers = readConfirmerLayers(box);
      // Store only when the layer list differs from the inherited default (layers
      // are stored atomically — inherited prompts/specs are carried by value).
      if (f.required || !sameJson(normLayers(layers), normLayers(cfLayersOf(inh)))) out[f.name] = { layers };
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
  let active = -1; // index of the arrow-key-highlighted option (-1 = none)
  const optEls = () => [...menu.querySelectorAll('.combo-opt')];
  const paint = () => {
    // Reflect the active index onto the DOM and keep it in view.
    optEls().forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const opts = (getOptions() || []).filter((o) => !q || o.toLowerCase().includes(q));
    menu.innerHTML = opts.length
      ? opts.map((o) => `<div class="combo-opt" data-v="${esc(o)}">${esc(o)}</div>`).join('')
      : `<div class="combo-empty">No matching presets — free text is allowed</div>`;
    active = -1; // filtering changes the list; start with nothing highlighted
  };
  const show = () => { draw(); menu.hidden = false; open = true; };
  const hide = () => { menu.hidden = true; open = false; active = -1; };
  const choose = (opt) => { input.value = opt.dataset.v; hide(); onChange && onChange(); };
  input.addEventListener('focus', show);
  input.addEventListener('input', () => { show(); onChange && onChange(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); input.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const els = optEls();
      if (!els.length) { if (!open) show(); return; }
      if (!open) show();
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // From no selection, ArrowDown lands on the first option and ArrowUp on the
      // last; thereafter it wraps around the ends.
      active = active === -1 ? (step === 1 ? 0 : els.length - 1) : (active + step + els.length) % els.length;
      paint();
    } else if (e.key === 'Enter') {
      const els = optEls();
      if (open && active >= 0 && els[active]) { e.preventDefault(); choose(els[active]); }
    }
  });
  input.addEventListener('blur', () => setTimeout(hide, 150)); // let a menu click land first
  // mousedown (not click) so it fires before the input's blur closes the menu
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (open) hide();
    else { input.focus(); show(); }
  });
  menu.addEventListener('mousemove', (e) => {
    // Pointer takes over the highlight so it never fights the arrow-key cursor.
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    const i = optEls().indexOf(opt);
    if (i !== active) { active = i; paint(); }
  });
  menu.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    choose(opt);
  });
}

// Wire one agent box's controls: provider→model combobox + opt-in fork search.
function wireAgentBox(box) {
  const combo = box.querySelector('.af-model-combo');
  const providerOf = () => box.querySelector('.af-provider')?.value || 'claude';
  if (combo) wireCombo(combo, () => modelOptions(providerOf()), () => refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort'));
  box.querySelector('.af-provider')?.addEventListener('change', () => {
    box.querySelector('.af-model').value = ''; // model choices are provider-specific
    refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort');
  });
  // Fork-from search: the full task-picker overlay in agent mode (archived tasks
  // included — the completed ones are the ones you most often fork from).
  const chosen = box.querySelector('.af-resume-chosen');
  const enabled = box.querySelector('.af-resume-enabled');
  const panel = box.querySelector('.af-resume-panel');
  const provider = box.querySelector('.af-provider');
  const syncForkState = () => {
    if (panel) panel.hidden = !enabled?.checked;
    let taskFork;
    try { taskFork = enabled?.checked && !!JSON.parse(chosen?.dataset.resume || 'null')?.taskId; } catch { taskFork = false; }
    // Provider/session identity must match for a native fork. Model and effort are
    // intentionally left editable: both adapters support retuning those knobs.
    if (provider) provider.disabled = !!taskFork;
    box.classList.toggle('af-has-task-fork', !!taskFork);
  };
  const applySourceAgent = (session) => {
    if (!session) return;
    if (session.provider && provider) provider.value = session.provider;
    if (session.model !== undefined) box.querySelector('.af-model').value = session.model || '';
    refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort');
    const effort = box.querySelector('.af-effort');
    if (effort && session.effort && [...effort.options].some((o) => o.value === session.effort)) effort.value = session.effort;
  };
  const setResume = (rf, task, session) => {
    if (!chosen) return;
    chosen.dataset.resume = JSON.stringify(rf ?? null);
    chosen.innerHTML = rf ? resumeChosenInner(rf, task) : '';
    if (rf) applySourceAgent(session);
    syncForkState();
    box.dispatchEvent(new Event('change', { bubbles: true })); // the form's auto-save listens for change
  };
  chosen?.addEventListener('click', (e) => { if (e.target.closest('.af-resume-clear')) setResume(null); });
  enabled?.addEventListener('change', () => {
    if (!enabled.checked) {
      // Turning the feature off is also a real parameter change. Clear the
      // dormant source so checking it again cannot silently re-lock a provider
      // the user customized while the fork was off.
      if (chosen) { chosen.dataset.resume = 'null'; chosen.innerHTML = ''; }
      const session = box.querySelector('.af-resume-session');
      if (session) session.value = '';
    }
    syncForkState();
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  box.querySelector('.af-resume-pick')?.addEventListener('click', () =>
    openTaskPicker({
      title: 'Fork a previous agent',
      hint: 'Archived tasks are included — click a task to list its agents, then pick the one to fork.',
      mode: 'agent',
      defaults: ['draft', 'series'],
      onPick: ({ task, role, session }) => setResume({ taskId: task.id, role }, task, session),
    }),
  );
  syncForkState();
}
function wireAgentFields(root) {
  root.querySelectorAll('[data-agent-group]').forEach((group) => {
    const toggle = group.querySelector('.agent-separate');
    toggle?.addEventListener('change', () => {
      group.querySelector('.agent-unified-panel').hidden = toggle.checked;
      group.querySelector('.agent-separated-panel').hidden = !toggle.checked;
      group.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const unifiedBox = group.querySelector('.agent-unified-panel .agent-field');
    const reset = group.querySelector('.agent-unified-panel .field-reset');
    if (unifiedBox && reset) {
      const sync = () => {
        const inh = JSON.parse(unifiedBox.getAttribute('data-inherit') || 'null');
        const cur = { provider: unifiedBox.querySelector('.af-provider').value };
        const model = unifiedBox.querySelector('.af-model').value.trim();
        const effort = unifiedBox.querySelector('.af-effort').value;
        if (model) cur.model = model;
        if (effort) cur.effort = effort;
        reset.hidden = sameJson(normSpec(cur), normSpec(inh));
      };
      unifiedBox.addEventListener('input', sync);
      unifiedBox.addEventListener('change', sync);
      reset.addEventListener('click', () => { resetAgentField(unifiedBox); sync(); });
      sync();
    }
  });
  root.querySelectorAll('.agent-field').forEach(wireAgentBox);
  root.querySelectorAll('.confirmer-field').forEach(wireConfirmerField);
}

// Renumber the layer rows and toggle the "auto-confirm" empty state.
function cfSync(box) {
  const rows = [...box.querySelectorAll('.cf-layer')];
  rows.forEach((r, i) => { const n = r.querySelector('.cf-layer-num'); if (n) n.textContent = `${i + 1}.`; });
  const empty = box.querySelector('.cf-empty');
  if (empty) empty.style.display = rows.length ? 'none' : '';
}

// Confirmer fields: an editable layer list. Row controls are delegated to the box
// so a reset (which re-renders the rows) needs no re-wiring; only dynamically
// added agent sub-forms are wired as they appear.
function wireConfirmerField(box) {
  const f = { role: box.getAttribute('data-confirmer'), name: box.getAttribute('data-confirmer'), promptDefault: JSON.parse(box.getAttribute('data-prompt-default') || '""') };
  const agentDefault = JSON.parse(box.getAttribute('data-agent-default') || '{}');
  const list = box.querySelector('.cf-layers');
  const changed = () => box.dispatchEvent(new Event('change', { bubbles: true }));
  box.addEventListener('click', (e) => {
    const del = e.target.closest('.cf-del');
    const move = e.target.closest('.cf-move');
    const add = e.target.closest('.cf-add');
    if (del) {
      del.closest('.cf-layer').remove();
      cfSync(box); changed();
    } else if (move) {
      const row = move.closest('.cf-layer');
      const sib = Number(move.dataset.dir) < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sib) return;
      if (Number(move.dataset.dir) < 0) list.insertBefore(row, sib);
      else list.insertBefore(sib, row);
      cfSync(box); changed();
    } else if (add) {
      // An empty list gets its human confirmation back; otherwise the added layer
      // is an agent review, slotted BEFORE the first human layer (the common
      // shape: agent review(s), then a final human confirmation).
      const rows = [...list.querySelectorAll('.cf-layer')];
      const firstHuman = rows.find((r) => r.getAttribute('data-kind') === 'human');
      const kind = rows.length ? 'agent' : 'human';
      const tpl = document.createElement('template');
      tpl.innerHTML = cfLayerHtml(f, kind === 'agent' ? { kind, ...agentDefault } : { kind }, agentDefault);
      const row = tpl.content.firstElementChild;
      if (kind === 'agent' && firstHuman) list.insertBefore(row, firstHuman);
      else list.appendChild(row);
      row.querySelectorAll('.agent-field').forEach(wireAgentBox);
      cfSync(box); changed();
    }
  });
  // Kind flip: show the agent sub-form only for agent layers.
  box.addEventListener('change', (e) => {
    if (!e.target.classList?.contains('cf-kind')) return;
    const row = e.target.closest('.cf-layer');
    row.setAttribute('data-kind', e.target.value);
    const ab = row.querySelector('.cf-agent');
    if (ab) ab.style.display = e.target.value === 'agent' ? '' : 'none';
    const hb = row.querySelector('.cf-human');
    if (hb) hb.style.display = e.target.value === 'human' ? '' : 'none';
  });
  cfSync(box);
}

// Wire per-field "Reset to default" buttons: show the button whenever the field
// diverges from its inherited default, and on click restore the inherited value
// so the field goes back to inheriting (collectForm then stores no override).
function wireFieldResets(root, fields) {
  for (const f of fields) {
    if (f.required) continue; // a required field always stores a value; nothing to inherit
    // Some inherited fields can expose more than one reset source. Each button
    // compares and restores against the source named by its data attribute.
    const btns = [...root.querySelectorAll(`.field-reset[data-reset="${CSS.escape(f.name)}"]`)];
    if (!btns.length) continue;
    let box = null;
    let el = null;
    if (f.type === 'agent') box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
    else if (f.type === 'confirmer') box = root.querySelector(`.confirmer-field[data-confirmer="${CSS.escape(f.role || f.name)}"]`);
    else el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
    const target = box || el;
    if (!target) continue;
    const attrFor = (btn) => (btn.dataset.resetKind === 'alt' ? 'data-inherit-alt' : 'data-inherit');
    const sync = () => { for (const btn of btns) btn.hidden = !fieldDiffers(root, f, attrFor(btn)); };
    target.addEventListener('input', sync);
    target.addEventListener('change', sync);
    for (const btn of btns) {
      const attr = attrFor(btn);
      btn.addEventListener('click', () => {
        if (f.type === 'agent') resetAgentField(box, attr);
        else if (f.type === 'confirmer') resetConfirmerField(box, attr);
        else resetPlainField(el, f, attr);
        sync();
      });
    }
    sync();
  }
}

// Does the field currently hold a value that differs from the value stored in
// `attr` (the inherited default, or an alternate inherited source)?
function fieldDiffers(root, f, attr = 'data-inherit') {
  if (f.type === 'agent') {
    const box = root.querySelector(`.agent-field[data-agent="${CSS.escape(f.role || f.name)}"]`);
    if (!box) return false;
    const inh = JSON.parse(box.getAttribute(attr) || 'null');
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
    const inh = JSON.parse(box.getAttribute(attr) || 'null');
    return !sameJson(normLayers(readConfirmerLayers(box)), normLayers(cfLayersOf(inh)));
  }
  const el = root.querySelector(`[data-field="${CSS.escape(f.name)}"]`);
  if (!el) return false;
  const inh = JSON.parse(el.getAttribute(attr) || 'null');
  let val;
  if (f.type === 'boolean') val = el.checked;
  else if (f.type === 'list') val = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if (f.type === 'number') val = el.value === '' ? undefined : Number(el.value);
  else val = el.value === '' ? undefined : el.value;
  if (val === undefined) return false; // empty ⇒ inheriting
  if (f.type === 'list' && Array.isArray(val) && !val.length) return false;
  return !sameJson(val, inh);
}

function resetPlainField(el, f, attr = 'data-inherit') {
  const inh = JSON.parse(el.getAttribute(attr) || 'null');
  if (f.type === 'boolean') el.checked = !!inh;
  else if (f.type === 'list') el.value = Array.isArray(inh) ? inh.join('\n') : (inh || '');
  else el.value = inh === undefined || inh === null ? '' : inh;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function resetAgentField(box, attr = 'data-inherit') {
  const inh = JSON.parse(box.getAttribute(attr) || 'null') || {};
  const prov = box.querySelector('.af-provider');
  prov.value = inh.provider || 'claude';
  box.querySelector('.af-model').value = inh.model || '';
  refreshEffortSelect(box, 'af-provider', 'af-model', 'af-effort');
  const eff = box.querySelector('.af-effort');
  if (eff && inh.effort) eff.value = inh.effort;
}

function resetConfirmerField(box, attr = 'data-inherit') {
  const inh = JSON.parse(box.getAttribute(attr) || 'null') || {};
  const f = { role: box.getAttribute('data-confirmer'), name: box.getAttribute('data-confirmer'), promptDefault: JSON.parse(box.getAttribute('data-prompt-default') || '""') };
  const agentDefault = JSON.parse(box.getAttribute('data-agent-default') || '{}');
  const list = box.querySelector('.cf-layers');
  // Re-render the rows from the inherited layers; row controls are delegated to
  // the box, so only the fresh agent sub-forms need wiring.
  list.innerHTML = cfListHtml(f, cfLayersOf(inh), agentDefault);
  list.querySelectorAll('.agent-field').forEach(wireAgentBox);
  cfSync(box);
  // This composite control is rebuilt rather than assigned through an input.
  // Emit the same event as a user edit so draft auto-save persists the reset;
  // otherwise the UI can show @creator while the last partial value remains saved.
  box.dispatchEvent(new Event('change', { bubbles: true }));
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
  if (!res.ok) {
    const error = new Error(body?.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return body;
}

// ─── Image attachments (paste / drag-drop an image into a prompt field) ───────
// Bytes are uploaded to the content-addressed store immediately, so the task /
// follow-up payloads carry only the returned lightweight { id, mediaType, bytes }
// reference. Thumbnails are served back via /api/attachments/:id?token=… (an
// <img> can't send a Bearer header, so the session token rides in the query).
async function uploadImage(file) {
  const res = await fetch(`/api/attachments?projectId=${encodeURIComponent(S.projectId)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `upload failed (HTTP ${res.status})`);
  return body; // ImageRef
}

function attachmentUrl(id) {
  return `/api/attachments/${encodeURIComponent(id)}?projectId=${encodeURIComponent(S.projectId)}&token=${encodeURIComponent(S.token || '')}`;
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

// ── conversation rendering: markdown + math ──────────────────────────────────
// Messages render as Markdown (with optional MathJax) by default; both can be
// turned off on the Profile page → Appearance. The flags live in
// localStorage (a per-browser display choice, like the theme toggle), and every
// reader is defensive about a missing localStorage so the same functions run
// under the plain-node conversation tests.
function renderFlag(key, dflt) {
  try { const v = localStorage.getItem(key); return v == null ? dflt : v === '1'; } catch { return dflt; }
}
const markdownEnabled = () => renderFlag('karmax-md-render', true);
const mathjaxEnabled = () => renderFlag('karmax-mathjax', true);

// A message body: Markdown when enabled, otherwise the previous plain-escaped
// text (the .msg-text pre-wrap handles its newlines). The caller adds the `md`
// class so the two whitespace models don't collide.
function renderMessageBody(text) {
  return markdownEnabled() ? renderMarkdown(text, { math: mathjaxEnabled() }) : esc(text);
}

// A little copy control for a message bubble — copies the raw source text (the
// attribute round-trips it: the browser decodes the entities back on read).
function messageCopyButton(text) {
  if (!text) return '';
  return `<button class="msg-copy" data-copy-msg="${esc(text)}" title="Copy message" aria-label="Copy message">${ICON.copy}</button>`;
}

function wireMessageCopies(root = document) {
  root.querySelectorAll('.msg-copy').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(btn.dataset.copyMsg || '').then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1200);
      });
    });
  });
}

// A compact, dependency-free Markdown renderer. It escapes first (untrusted
// agent/user text), then applies a small, common subset: fenced + inline code,
// headings, lists, blockquotes, rules, bold/italic/strike, links, and — when
// math is on — $…$ / $$…$$ spans left intact for MathJax to typeset. Code and
// math are stashed up front so inline formatting can't corrupt their contents;
// the single stash is restored once at the end (nested blocks recurse through
// mdBlocks, never renderMarkdown, so indices never clash).
function renderMarkdown(src, opts = {}) {
  const withMath = !!opts.math;
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(src ?? '').replace(/\r\n?/g, '\n');
  // Fenced code blocks first (a blank line around the placeholder keeps it its
  // own block).
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) =>
    `\n${keep(`<pre class="md-code"><code>${esc(body.replace(/\n$/, ''))}</code></pre>`)}\n`);
  if (withMath) s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => keep(`<span class="md-math">$$${esc(body)}$$</span>`));
  s = s.replace(/`([^`\n]+)`/g, (_, body) => keep(`<code class="md-inline">${esc(body)}</code>`));
  if (withMath) s = s.replace(/\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (_, body) => keep(`<span class="md-math">$${esc(body)}$</span>`));
  let html = mdBlocks(s, stash);
  return html.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] ?? '');
}

function mdBlocks(s, stash) {
  const lines = s.split('\n');
  const out = [];
  const bullet = /^\s*([-*+]|\d+[.)])\s+/;
  const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
  // A GFM pipe table: a header row followed by a |---|:--:| delimiter row.
  const isTableStart = (idx) => idx + 1 < lines.length && lines[idx].includes('|')
    && mdIsDelimiterRow(lines[idx + 1]) && mdSplitRow(lines[idx]).length > 1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      out.push(`<h${m[1].length} class="md-h">${mdInline(m[2].trim())}</h${m[1].length}>`);
      i++; continue;
    }
    if (rule.test(line)) { out.push('<hr class="md-hr"/>'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote class="md-quote">${mdBlocks(buf.join('\n'), stash)}</blockquote>`);
      continue;
    }
    if (bullet.test(line)) {
      const { html, next } = mdParseList(lines, i, stash);
      out.push(html);
      i = next;
      continue;
    }
    if (isTableStart(i)) {
      const headers = mdSplitRow(lines[i]);
      const aligns = mdSplitRow(lines[i + 1]).map(mdCellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes('|') && !mdIsDelimiterRow(lines[i])) {
        rows.push(mdSplitRow(lines[i])); i++;
      }
      const al = (x) => (aligns[x] ? ` style="text-align:${aligns[x]}"` : '');
      const head = `<thead><tr>${headers.map((h, x) => `<th${al(x)}>${mdInline(h)}</th>`).join('')}</tr></thead>`;
      const body = rows.length
        ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, x) => `<td${al(x)}>${mdInline(r[x] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<table class="md-table">${head}${body}</table>`);
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i])
      && !bullet.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !rule.test(lines[i]) && !isTableStart(i)) {
      buf.push(lines[i]); i++;
    }
    const joined = buf.join('\n');
    const sole = /^\u0000(\d+)\u0000$/.exec(joined.trim());
    if (sole) { out.push(joined.trim()); continue; } // a lone code/display-math block: no wrapping <p>
    out.push(`<p class="md-p">${mdInline(joined).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

// One list-item line: leading indent, the marker (bullet or `N.`/`N)`), the gap
// after it, and the item's first-line content.
const MD_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const mdListKind = (marker) => (/^\d/.test(marker) ? 'ol' : 'ul');
// Leading-whitespace width of a line (a tab counts as 4 columns).
function mdIndent(line) {
  let w = 0;
  for (const c of line) { if (c === ' ') w++; else if (c === '\t') w += 4; else break; }
  return w;
}

// Parse a bullet/number list starting at lines[start]; returns { html, next }.
// This is deliberately thorough because loose lists are where naive renderers
// break: blank lines between items must NOT split one list into many one-item
// lists (that is the classic bug where every ordered item shows "1."). It also
// honours an arbitrary ordered start value (start=N), nested sublists by
// indentation, and multi-line / multi-paragraph item bodies.
function mdParseList(lines, start, stash) {
  const first = MD_ITEM.exec(lines[start]);
  const baseIndent = mdIndent(lines[start]);
  const kind = mdListKind(first[2]);
  const startNum = kind === 'ol' ? parseInt(first[2], 10) : 1;

  // Extent of the whole list block: sibling markers at this indent, their more-
  // indented continuation/nested lines, and interior blank lines (a blank counts
  // as interior only when a later line resumes the list).
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*$/.test(line)) {
      let j = end;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      if (j >= lines.length) break;
      const nm = MD_ITEM.exec(lines[j]);
      const sameList = nm && mdIndent(lines[j]) === baseIndent && mdListKind(nm[2]) === kind;
      const deeper = mdIndent(lines[j]) > baseIndent;
      if (sameList || deeper) { end = j; continue; }
      break;
    }
    const m = MD_ITEM.exec(line);
    if (m && mdIndent(line) === baseIndent) {
      if (mdListKind(m[2]) !== kind) break; // a switch of marker type starts a new list
      end++; continue;
    }
    if (mdIndent(line) > baseIndent) { end++; continue; } // continuation / nested
    break; // a dedented, non-item line ends the list
  }

  // A list is "loose" if any blank line falls inside its extent — CommonMark then
  // wraps each item's text in a paragraph; we mirror that with extra spacing.
  let loose = false;
  for (let k = start; k < end - 1; k++) { if (/^\s*$/.test(lines[k])) { loose = true; break; } }

  // Split the extent into items at each sibling marker; dedent each item's body
  // by its own content indent so nested markup parses at the right level.
  const items = [];
  let k = start;
  while (k < end) {
    const m = MD_ITEM.exec(lines[k]);
    if (!(m && mdIndent(lines[k]) === baseIndent && mdListKind(m[2]) === kind)) { k++; continue; }
    const contentIndent = m[1].length + m[2].length + m[3].length;
    const body = [m[4]];
    k++;
    while (k < end) {
      const sib = MD_ITEM.exec(lines[k]);
      if (sib && mdIndent(lines[k]) === baseIndent && mdListKind(sib[2]) === kind) break;
      body.push(/^\s*$/.test(lines[k]) ? '' : lines[k].slice(contentIndent));
      k++;
    }
    items.push(body.join('\n').replace(/\s+$/, ''));
  }

  // Render each item. A loose list wraps every item body in paragraphs (via
  // mdBlocks). In a tight list, a plain item renders inline; one that carries a
  // nested sublist keeps its lead text inline and parses only the sublist as a
  // block, so tight lists don't sprout stray paragraph margins.
  const li = items.map((text) => {
    const rows = text.split('\n');
    if (loose) return `<li>${mdBlocks(text, stash)}</li>`;
    const cut = rows.findIndex((l, x) => x > 0 && MD_ITEM.test(l));
    if (cut > 0) {
      const lead = rows.slice(0, cut).join('\n').trim();
      const rest = rows.slice(cut).join('\n');
      const leadHtml = lead ? mdInline(lead).replace(/\n/g, '<br>') : '';
      return `<li>${leadHtml}${leadHtml ? '\n' : ''}${mdBlocks(rest, stash)}</li>`;
    }
    return `<li>${mdInline(text).replace(/\n/g, '<br>')}</li>`;
  }).join('');

  const attr = kind === 'ol' && startNum !== 1 ? ` start="${startNum}"` : '';
  return { html: `<${kind} class="md-list${loose ? ' md-loose' : ''}"${attr}>${li}</${kind}>`, next: end };
}

// Split one pipe-table row into trimmed cells, tolerating optional leading and
// trailing pipes and backslash-escaped `\|` inside a cell.
function mdSplitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

// The row under a table header: every cell is dashes with optional alignment
// colons (`---`, `:--`, `--:`, `:-:`). The pipe requirement keeps a bare `---`
// (a horizontal rule) from being mistaken for a one-column delimiter.
function mdIsDelimiterRow(line) {
  if (!line.includes('|') || !line.includes('-')) return false;
  const cells = mdSplitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function mdCellAlign(cell) {
  const s = cell.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
}

// Inline formatting over already-block-split text. Escaping happens here so the
// stash placeholders (bare digits) survive untouched.
function mdInline(t) {
  let x = esc(t);
  // Backslash escapes: stash the escaped punctuation (as \u0001N\u0001) so the
  // emphasis/link passes treat it as a literal, then restore it at the very end.
  const lit = [];
  x = x.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, ch) => `\u0001${lit.push(ch) - 1}\u0001`);
  // Inline links [text](url "optional title") — safe schemes only; the title is
  // dropped. Runs before autolinking so a bare URL inside a link is left alone.
  x = x.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (_, txt, href) => {
    const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  // Autolink bare http(s) URLs not already part of a link/attribute (only when
  // preceded by start-of-string, whitespace or an opening paren). Trailing
  // sentence punctuation is left outside the link.
  x = x.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (whole, pre, url) => {
    const tail = (url.match(/[.,;:!?]+$/) || [''])[0];
    const bare = url.slice(0, url.length - tail.length);
    return `${pre}<a href="${bare}" target="_blank" rel="noopener noreferrer">${bare}</a>${tail}`;
  });
  x = x.replace(/\*\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*\*/g, '<strong><em>$1</em></strong>');
  x = x.replace(/___([^\s](?:[\s\S]*?[^\s])?)___/g, '<strong><em>$1</em></strong>');
  x = x.replace(/\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*/g, '<strong>$1</strong>');
  x = x.replace(/__([^\s](?:[\s\S]*?[^\s])?)__/g, '<strong>$1</strong>');
  x = x.replace(/(^|[^*])\*([^\s*][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  x = x.replace(/(^|[^_\w])_([^\s_][^_]*?)_(?![_\w])/g, '$1<em>$2</em>');
  x = x.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
  x = x.replace(/\u0001(\d+)\u0001/g, (_, n) => lit[Number(n)]);
  return x;
}

// MathJax is loaded lazily from a CDN the first time a rendered message actually
// contains math, and only while the flag is on. If it can't load (offline), the
// raw $…$ simply stays visible — a graceful, non-fatal degradation.
let mathjaxLoad = null;
function ensureMathJax() {
  if (mathjaxLoad) return mathjaxLoad;
  mathjaxLoad = new Promise((resolve) => {
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
      options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
      startup: { typeset: false, ready: () => { window.MathJax.startup.defaultReady(); resolve(true); } },
    };
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
    script.async = true;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return mathjaxLoad;
}
function typesetMath(root) {
  if (!mathjaxEnabled()) return;
  const scope = root || document.getElementById('ck-thread');
  if (!scope || !scope.querySelector('.md-math')) return;
  ensureMathJax().then(() => {
    if (!window.MathJax || !window.MathJax.typesetPromise) return;
    try { window.MathJax.typesetClear?.([scope]); } catch {}
    window.MathJax.typesetPromise([scope]).catch(() => {});
  });
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
  S.sso = session.sso || null;
  if (session.setupRequired) return renderSetup();
  if (session.authRequired && !session.authenticated && !session.token) return renderLogin();
  S.token = session.token || null; // Better Auth uses an HttpOnly same-origin cookie.
  S.user = session.user || null;
  const route = parseRoute(location.pathname);
  if (route.name === 'invite') {
    const invitationToken = new URLSearchParams(location.search).get('token');
    if (invitationToken) {
      try {
        const membership = await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: invitationToken }) });
        S.organizationId = membership.organizationId;
        S.inviteNotice = 'Invitation accepted. A project administrator can now add you to a project.';
        history.replaceState({ kx: 1 }, '', '/organization');
      } catch (error) {
        S.inviteNotice = error.message;
        history.replaceState({ kx: 1 }, '', '/organization');
      }
    }
  }
  S.meta = await api('/api/meta');
  await loadOrganizations().catch(() => {});
  try { await loadProjects(); }
  catch (e) {
    // A self-registered identity is real but intentionally starts with no
    // project grants. Give it an honest waiting room instead of a generic boot
    // failure (and do not mistake authentication for project access).
    if (e.status === 403) return renderAccessPending();
    throw e;
  }
  if (!S.organizationId) S.organizationId = S.projects.find((p) => p.organizationId)?.organizationId || S.organizations[0]?.id || null;
  await loadCollaboration().catch(() => {});
  const projectScope = S.projectId ? `?projectId=${encodeURIComponent(S.projectId)}` : '';
  try {
    S.contributions = await api(`/api/contributions${projectScope}`);
    S.schema = await api(`/api/schema${projectScope}`);
    S.modelCatalog = (await api(`/api/models${projectScope}`)).providers;
    if (S.organizationId) S.worldProviderConnections = await api(`/api/organizations/${encodeURIComponent(S.organizationId)}/world-providers`).catch(() => []);
  } catch {}
  connectWs();
  renderShell();
  bindKeys();
  installLinkRouter();
  // A background repaint deferred to protect an open menu / text-selection gets
  // flushed once that interaction releases (setTimeout lets focus + selection
  // settle first). selectionchange fires constantly, so it only pokes the flush
  // when something is actually waiting.
  document.addEventListener('focusout', () => setTimeout(flushBgRender, 0));
  document.addEventListener('mouseup', () => setTimeout(flushBgRender, 0));
  document.addEventListener('selectionchange', () => { if (bgRenderQueued) setTimeout(flushBgRender, 0); });
  window.addEventListener('popstate', () => { closeTaskFormPage(); applyRoute(); });
  await applyRoute(); // honor the initial URL (deep link / bookmark)
}

async function loadProjects() {
  S.projects = await api('/api/projects');
  if (!S.projectId && S.projects[0]) S.projectId = S.projects[0].id;
  if (S.projectId) S.organizationId = projectById(S.projectId)?.organizationId || S.organizationId;
}

async function loadOrganizations() {
  S.organizations = await api('/api/organizations').catch(() => []);
  if (!S.organizationId) S.organizationId = S.organizations[0]?.id || null;
}

async function loadCollaboration() {
  if (!S.organizationId) return;
  const q = `?organizationId=${encodeURIComponent(S.organizationId)}`;
  const [members, teams, users, inbox, prefs] = await Promise.all([
    api(`/api/organizations/${S.organizationId}/members`).catch(() => []),
    api(`/api/organizations/${S.organizationId}/teams`).catch(() => []),
    api('/api/users').catch(() => []),
    api(`/api/inbox${q}`).catch(() => []),
    api(`/api/inbox/preferences${q}`).catch(() => null),
  ]);
  S.organizationMembers = members || [];
  S.teams = teams || [];
  S.users = users || [];
  S.inbox = inbox || [];
  S.deliveryPreferences = prefs;
  updateBell();
}

async function loadTasks() {
  if (!S.projectId) return;
  // Always fetch the full set incl. archived; the task list decides visibility via the
  // query (default -is:archived). S.tasks is the shared pool for the task page, counts, etc.
  const fetched = await api(`/api/projects/${S.projectId}/tasks?includeArchived=1`);
  // Drop any draft we just deleted: a list request issued before the DELETE landed
  // can still return it and clobber the optimistic removal. Once a fresh fetch no
  // longer contains a tombstoned id, the server has caught up — retire it so the
  // set can't grow without bound (task ids are never reused).
  for (const id of S.deleted) if (!fetched.some((t) => t.id === id)) S.deleted.delete(id);
  S.tasks = fetched.filter((t) => !S.deleted.has(t.id));
}

// ── task organization: tags, saved views, query search ──────────────────────
// A view IS a saved query: `S.search` holds the working query string (Linear-style
// tokens + free text), which the server evaluates via /search into `S.searchResult`.
// The field registry (`S.fields`) drives the filter/sort/group menus.
async function loadOrg() {
  if (!S.projectId) return;
  const pid = S.projectId;
  const [tags, views, fields] = await Promise.all([
    api(`/api/projects/${pid}/tags`).catch(() => []),
    api(`/api/projects/${pid}/views`).catch(() => []),
    S.fields.length ? Promise.resolve(S.fields) : api(`/api/search/fields?projectId=${encodeURIComponent(pid)}`).catch(() => []),
  ]);
  S.tags = tags || [];
  S.views = views || [];
  S.fields = fields || [];
  S.orgProjectId = pid;
}

// The map id→tag for quick lookups + hierarchy path rendering.
function tagById(id) { return S.tags.find((t) => t.id === id); }
function tagPathStr(id) {
  const parts = [];
  const seen = new Set();
  let cur = tagById(id);
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.name); cur = cur.parentId ? tagById(cur.parentId) : null; }
  return parts.join('/');
}
const PRIORITY_NAMES = ['none', 'low', 'medium', 'high', 'urgent'];

// Evaluate the working query on the server and stash the result. The default list
// (empty query) is just an evaluation too. We overlay each result's freshest live
// `lastView` from S.tasks so status chips reflect the latest transition.
async function runSearch() {
  if (!S.projectId) return;
  const q = effectiveQuery(S.search); // adds the default -is:archived unless overridden
  try {
    const r = await api(`/api/projects/${S.projectId}/search?q=${encodeURIComponent(q)}`);
    const live = new Map(S.tasks.map((t) => [t.id, t]));
    const overlay = (t) => ({ ...t, lastView: live.get(t.id)?.lastView ?? t.lastView });
    r.tasks = (r.tasks || []).map(overlay);
    if (r.groups) r.groups = r.groups.map((g) => ({ ...g, tasks: (g.tasks || []).map(overlay) }));
    S.searchResult = r;
  } catch { S.searchResult = null; }
}

let searchDebounce = null;
function scheduleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => { await runSearch(); if (S.tab === 'tasks') renderMain(); }, 180);
}

// Programmatically set the working query (view selection, filter/sort/group menus).
// Updates the topbar box (which renderMain doesn't own), re-evaluates, re-renders.
async function setQuery(q) {
  S.search = q || '';
  const box = $('#task-search');
  if (box) box.value = S.search;
  await runSearch();
  if (S.tab === 'tasks') renderMain();
}

// Replace a directive token (group:/sort:) in the query string, or remove it when
// `value` is empty. Keeps everything else intact so it composes with typed tokens.
function setDirective(q, key, value) {
  const re = new RegExp(`(?:^|\\s)${key}:\\S+`, 'g');
  let out = (q || '').replace(re, '').replace(/\s+/g, ' ').trim();
  if (value) out = (out + ` ${key}:${value}`).trim();
  return out;
}
// Append a filter clause `field:value` (value may already carry an op prefix).
function addClause(q, field, value) {
  const tok = value.includes(' ') ? `${field}:"${value}"` : `${field}:${value}`;
  return ((q || '') + ' ' + tok).trim();
}

// Browser-side query stringifier — mirrors src/domain/query-language.ts so a saved
// view's structured query round-trips into the one search box.
function stringifyQuery(q) {
  const parts = [];
  for (const c of q.filters || []) {
    const prefix = c.negate ? '-' : '';
    const op = c.op === 'gt' ? '>' : c.op === 'gte' ? '>=' : c.op === 'lt' ? '<' : c.op === 'lte' ? '<=' : '';
    const vals = (c.values || []).map((v) => (String(v).includes(' ') ? `"${v}"` : v)).join(',');
    parts.push(`${prefix}${c.field}:${op}${vals}`);
  }
  for (const s of q.sort || []) parts.push(`sort:${s.field}-${s.dir}`);
  if (q.group) parts.push(`group:${q.group}`);
  if (q.text) parts.push(String(q.text).includes(' ') ? `"${q.text}"` : q.text);
  return parts.join(' ');
}

// ── websocket live stream ──────────────────────────────────────────────────
let refreshTimer = null;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws${S.token ? `?token=${encodeURIComponent(S.token)}` : ''}`);
  S.ws = ws;
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    S.activity.unshift(ev);
    if (S.activity.length > 400) S.activity.pop();
    if (S.tab === 'activity') bgRenderMain();
    if (S.selected && ev.taskId === S.selected) {
      S.taskEvents.push(ev);
      if (ev.type === 'agent.output' && ev.payload?.text) {
        // Provider adapters emit the current complete block, not a token delta.
        // Replacing avoids the old "H / He / Hello" cumulative transcript.
        S.liveOutput = ev.payload.text;
        updateLiveBubble();
      } else if (ev.type === 'agent.activity' || ev.type === 'conversation.message') {
        if (S.taskTab === 'checkin') renderTaskPage();
        else renderTaskEvents();
      }
      if (ev.type === 'view.updated' || ev.type.includes('stage') || ev.type === 'merge.result' || ev.type === 'turn.result') {
        S.liveOutput = '';
        refreshTask();
      } else if (ev.type === 'session.started') {
        refreshTask(); // the session id was just published mid-turn → show the live fork command
      } else renderTaskEvents();
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (S.tab === 'tasks' || S.tab === 'queue') refreshTasks(); }, 350);
    if (S.organizationId && ['view.updated', 'task.responsibility-changed', 'task.mentioned'].includes(ev.type))
      setTimeout(() => loadCollaboration().catch(() => {}), 450);
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

async function refreshTasks() {
  try {
    await loadTasks();
    if (S.tab === 'tasks' && !S.selected) await runSearch(); // the list re-runs its query on return anyway
    if (S.tab === 'tasks' || S.tab === 'queue') bgRenderMain();
    renderRail();
    if (S.tab === 'queue' && !S.selected) seedQueue();
  } catch {}
}

// ── shell ────────────────────────────────────────────────────────────────────
function renderShell() {
  const app = $('#app');
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="mark">◇</span> karmax</div>
      <select class="org-switcher" id="org-switcher" title="Organization">
        ${S.organizations.map((o) => `<option value="${esc(o.id)}" ${o.id === S.organizationId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        <option value="__new">＋ New organization</option>
      </select>
      <div class="spacer"></div>
      <button class="global-search-trigger" id="topbar-search" title="Search tasks and projects across your workspace" aria-haspopup="dialog">
        <span aria-hidden="true">⌕</span><span class="global-search-label">Search everything</span><span class="kbd">${esc(fmtKeys('meta+shift+F'))}</span>
      </button>
      <button class="icon-btn" id="topbar-palette" title="Command palette (${esc(fmtKeys('meta+k'))})" aria-haspopup="dialog">⌘</button>
      <button class="icon-btn" id="topbar-help" title="Keyboard shortcuts (?)" aria-haspopup="dialog">?</button>
      <a class="topbar-user" id="topbar-user" data-spa href="${globalRoute('profile')}" title="Your profile">${esc(userDisplayName())}</a>
      <a class="icon-btn has-badge" id="bell" data-spa href="${globalRoute('inbox')}" title="Inbox" role="button" aria-label="Inbox">🔔<span class="badge hidden" id="bell-badge">0</span></a>
    </div>
    <div class="body">
      <div class="rail" id="rail"></div>
      <div class="main"><div class="main-inner" id="main"></div></div>
    </div>`;
  // Project-scoped query/filtering lives in the task list. The topbar finder is
  // deliberately separate from the action-oriented command palette (Cmd/Ctrl+K).
  $('#topbar-search').addEventListener('click', openGlobalSearch);
  $('#topbar-palette').addEventListener('click', openPalette);
  $('#topbar-help').addEventListener('click', openHelp);
  // #topbar-user and #bell are real <a> links (open profile / inbox, incl. in a new tab); installLinkRouter() handles them.
  $('#org-switcher')?.addEventListener('change', async (e) => {
    if (e.target.value === '__new') return createOrganization();
    S.organizationId = e.target.value;
    const project = S.projects.find((p) => p.organizationId === S.organizationId);
    S.projectId = project?.id || null;
    await loadCollaboration().catch(() => {});
    return go(project ? projectRoute(project.id) : globalRoute('organization'));
  });
  // The rail/main are painted by applyRoute() (boot calls it right after), so the
  // shell reflects the initial URL instead of a default view.
}

function renderRail() {
  const rail = $('#rail');
  if (!rail) return;
  rail.innerHTML = `
    <div class="label">Projects</div>
    ${S.projects.filter((p) => !S.organizationId || p.organizationId === S.organizationId)
      .map(
        (p) => `<a class="proj ${p.id === S.projectId ? 'active' : ''}" data-spa href="${projectRoute(p.id)}" data-id="${p.id}" tabindex="0">
          <span class="glyph">◇</span> <span>${esc(p.name)}</span>
        </a>`,
      )
      .join('')}
    <div class="proj add" id="new-project" tabindex="0"><span>+</span> <span>New project</span></div>
    <div class="grow"></div>
    <div class="label">Organization</div>
    <a class="nav-item ${S.tab === 'dashboard' ? 'active' : ''}" data-spa href="${globalRoute('dashboard')}" data-tab="dashboard" tabindex="0">▦ Dashboard</a>
    <a class="nav-item ${S.tab === 'orgwiki' ? 'active' : ''}" data-spa href="${globalRoute('orgwiki')}" id="rail-wiki" tabindex="0" title="Organization-wide skills, memories, and the general agent prompt">🕮 Wiki</a>
    <a class="nav-item ${S.tab === 'organization' || S.tab === 'global' ? 'active' : ''}" data-spa href="${globalRoute('organization')}" id="rail-organization" tabindex="0">⚙ Settings</a>`;
  // Your profile lives in the top bar (#topbar-user), not the rail. Project +
  // Dashboard/Wiki/Settings entries are real <a> links — installLinkRouter()
  // routes their plain click in place and the browser handles new-tab gestures.
  $('#new-project')?.addEventListener('click', newProject);
}

function switchTab(tab) {
  if (tab === 'dashboard') return go(globalRoute('dashboard'));
  if (tab === 'global' || tab === 'organization') return go(globalRoute('organization'));
  if (tab === 'inbox') return go(globalRoute('inbox'));
  const pid = S.projectId || S.projects[0]?.id;
  return go(pid ? projectRoute(pid, tab) : globalRoute('dashboard'));
}

// Preserve the focused field (value + caret) across a renderMain() innerHTML
// swap so a background refresh doesn't clear/de-focus what the user is typing.
function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !el.id || !root.contains(el)) return null;
  const tag = el.tagName;
  // The terminal screen is a focusable <pre> the user types straight into —
  // keep it focused across re-renders so keystrokes keep reaching the shell.
  if (tag === 'PRE' && el.classList.contains('term-screen')) return { id: el.id, tag };
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return null;
  const st = { id: el.id, tag, value: el.value };
  if (tag !== 'SELECT' && typeof el.selectionStart === 'number') {
    st.selectionStart = el.selectionStart;
    st.selectionEnd = el.selectionEnd;
    // A multi-line field scrolls its own content; a fresh element resets to the
    // top, so snapshot the internal scroll and put it back with the caret.
    st.scrollTop = el.scrollTop;
  }
  return st;
}

function restoreFocus(root, st) {
  if (!st) return;
  const el = root.querySelector(`#${window.CSS && CSS.escape ? CSS.escape(st.id) : st.id}`);
  if (!el || el.tagName !== st.tag) return;
  if (st.tag === 'PRE') { el.focus({ preventScroll: true }); return; } // terminal screen: just re-focus (no value to restore)
  // Only carry over the in-progress value for free-text fields; a fresh empty
  // composer input would otherwise be reset by the re-render.
  if (st.tag !== 'SELECT') el.value = st.value;
  // preventScroll: re-focusing must not yank the page's scroll container to the
  // field — the surrounding restore logic owns scroll position.
  el.focus({ preventScroll: true });
  if (typeof st.selectionStart === 'number' && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(st.selectionStart, st.selectionEnd); } catch {}
  }
  if (typeof st.scrollTop === 'number') el.scrollTop = st.scrollTop;
}

// A background (WebSocket-driven) refresh repaints #main by swapping its
// innerHTML, which tears down transient UI the user is mid-interaction with — an
// open native <select> dropdown (e.g. the ＋ Filter… menu) or a live mouse
// text-selection. A steady agent event stream would otherwise keep yanking the
// menu shut / clearing the selection every few hundred ms. Detect an in-flight
// interaction, defer the repaint, and flush it once the interaction releases
// (blur / mouse-up / the next background event).
let bgRenderQueued = false;
function interactionInFlight(root) {
  const el = document.activeElement;
  if (el && el.tagName === 'SELECT' && root.contains(el)) return true; // dropdown may be open
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const node = sel.anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentNode);
    if (host && root.contains(host)) return true; // an active text selection
  }
  return false;
}
function bgRenderMain() {
  const main = $('#main');
  if (main && interactionInFlight(main)) { bgRenderQueued = true; return; }
  bgRenderQueued = false;
  renderMain();
}
function flushBgRender() {
  if (!bgRenderQueued) return;
  const main = $('#main');
  if (main && interactionInFlight(main)) return; // still busy — wait for the next release
  bgRenderQueued = false;
  renderMain();
}

// ── main content ───────────────────────────────────────────────────────────
function renderMain() {
  const main = $('#main');
  if (!main) return;
  // A task page owns #main while a task is open. Background list refreshes land
  // here (WS-driven refreshTasks) — repaint the page from the freshest state
  // instead of the list. S.view is null for a repeatable series (its config page
  // holds an editable form and manages its own renders — never clobber it) and
  // during the openTask fetch (the page paints when the fetch lands).
  if (S.selected) {
    if (S.view) renderTaskPage();
    return;
  }
  // An open wiki editor likewise manages its own renders: a background refresh
  // must not clobber in-progress edits (only the focused field would survive
  // the async rehydrate). Navigation still repaints — it changes S.tab or
  // clears S.wikiEditing first.
  if ((S.tab === 'wiki' || S.tab === 'orgwiki') && S.wikiEditing && $('#wiki-path')) return;
  const proj = S.projects.find((p) => p.id === S.projectId);
  const tabs = ['tasks', 'queue', 'activity', 'wiki', 'settings'];
  const labels = { tasks: 'Tasks', queue: 'Queues', activity: 'Activity', wiki: 'Wiki', settings: 'Project settings' };
  const projectScoped = ['tasks', 'queue', 'activity', 'wiki', 'settings'].includes(S.tab);
  const tabbar = projectScoped
    ? `<div class="tabs">${tabs
        .map((t) => `<a class="tab ${S.tab === t ? 'active' : ''}" data-spa href="${projectRoute(proj?.id, t)}" data-tab="${t}">${labels[t]}${t === 'tasks' && S.tasks.length ? `<span class="pill">${S.tasks.length}</span>` : ''}</a>`)
        .join('')}</div>`
    : '';

  let content = '';
  if (S.tab === 'tasks') content = tasksView();
  else if (S.tab === 'queue') content = queuesView();
  else if (S.tab === 'activity') content = activityView();
  else if (S.tab === 'dashboard') content = `<div id="dash">Loading…</div>`;
  else if (S.tab === 'inbox') content = inboxView();
  else if (S.tab === 'organization') content = organizationView();
  else if (S.tab === 'wiki') content = wikiView(proj);
  else if (S.tab === 'orgwiki') content = wikiView(null);
  else if (S.tab === 'profile') content = profileView();
  else if (S.tab === 'settings') content = settingsView(proj);
  else if (S.tab === 'global') content = globalSettingsView();

  // Background refreshes (a WebSocket event fires renderMain while a task runs)
  // must not blow away whatever the user is mid-typing in #main. Snapshot the
  // focused field's value/caret before the innerHTML swap, restore it after.
  const focusState = captureFocus(main);

  main.innerHTML = tabbar + content;
  // Project tabs are real <a> links; installLinkRouter() handles the plain click.
  if (S.tab === 'tasks') wireTasksView();
  if (S.tab === 'queue') wireQueueView();
  if (S.tab === 'wiki') wireWikiView(proj);
  if (S.tab === 'orgwiki') wireWikiView(null);
  if (S.tab === 'settings') wireSettingsView(proj);
  if (S.tab === 'global') wireGlobalSettings();
  if (S.tab === 'dashboard') renderDashboard();
  if (S.tab === 'inbox') wireInboxView();
  if (S.tab === 'profile') wireProfileView();
  if (S.tab === 'organization') { hydrateOrganizationView(); wireGlobalSettings(S.organizationId); }

  restoreFocus(main, focusState);
  updateBell();
}

// ── tasks ────────────────────────────────────────────────────────────────────
// Client-side twin of the authoritative `matchText` in src/domain/search.ts — the
// pre-server fallback while the first evaluation is in flight. Keep the two in
// sync: token-AND over title / notes / prompt / #num, so "login fix" matches "fix login".
function taskMatches(t, q) {
  const s = (q || '').toLowerCase().trim();
  if (!s) return true;
  const hay = `${(t.title || '').toLowerCase()} ${(t.notes || '').toLowerCase()} ${(t.params?.prompt || '').toLowerCase()} ${t.num != null ? '#' + t.num : ''}`;
  return s.split(/\s+/).every((term) => !term || hay.includes(term));
}

// The default list transparently hides two kinds of noise unless the query opts in:
// archived tasks (`-is:archived`) and the auto-spawned *runs* of a repeatable series
// (`-is:run`), so a cron series doesn't flood the list — its template still shows, and
// you drill into runs with `is:run` (or the Repeatable/Archived views). Archived and runs
// are therefore just facets, not toggles. The clean `S.search` stays in the box; only the
// evaluated query carries the defaults. If the query already mentions a facet, we leave it.
// The task-picker overlay passes its own facet list (e.g. the fork search keeps archived).
function queryMentionsFacet(q, facet) { return new RegExp(`(^|\\s)-?(is|has):[^\\s]*${facet}`, 'i').test(q || ''); }
function effectiveQuery(q, facets = ['archived', 'run']) {
  let s = (q || '').trim();
  for (const facet of facets) if (!queryMentionsFacet(s, facet)) s = `${s} -is:${facet}`.trim();
  return s;
}

// Built-in starter views that make the new task shapes (schedules, dependency-blocked,
// repeatable series) first-class instead of buried. Each is just a query string; they
// can't be deleted (no ✕). Keep the queries in step with the facets in src/domain/search.ts.
const BUILTIN_VIEWS = [
  { id: 'builtin:scheduled', name: 'Scheduled', icon: '⏰', query: 'is:scheduled sort:nextRun-asc' },
  { id: 'builtin:blocked', name: 'Blocked on deps', icon: '⛔', query: 'is:blocked-on-deps' },
  { id: 'builtin:series', name: 'Repeatable', icon: '🔁', query: 'is:series' },
  { id: 'builtin:archived', name: 'Archived', icon: '🗄', query: 'is:archived' },
];

// The saved-views switcher — every chip is a query. "All" is the default; then the
// built-in starter views, then the user's saved views (each with a ✕ to delete).
function viewsBar() {
  const builtins = BUILTIN_VIEWS
    .map((v) => `<div class="view-chip builtin ${S.activeView === v.id ? 'active' : ''}" data-view="${v.id}" tabindex="0" title="${esc(v.query)}">${esc(v.icon)} ${esc(v.name)}</div>`)
    .join('');
  const saved = S.views
    .map(
      (v) => `<div class="view-chip ${S.activeView === v.id ? 'active' : ''}" data-view="${v.id}" tabindex="0">${v.icon ? esc(v.icon) + ' ' : ''}${esc(v.name)}<span class="view-x" data-delview="${v.id}" title="Delete view">✕</span></div>`,
    )
    .join('');
  return `<div class="views-bar">
    <div class="view-chip ${!S.activeView ? 'active' : ''}" data-view="__all__" tabindex="0">≡ All</div>
    ${builtins}
    ${saved}
    <div class="view-chip add" id="save-view" tabindex="0" title="Save the current query as a view">＋ Save view</div>
  </div>`;
}

// Workflow params are searchable/organizable too, via synthetic fields the server
// resolves on demand (src/domain/search.ts — keep this list of skipped types in step
// with what fieldByKey understands). Scalar params become `param.<name>`; agent/confirmer
// params expand into three model sub-fields each — `agent_<role>.agent` (provider),
// `.model`, `.effort` — so you can filter/group/sort by the model an agent ran on.
const PARAM_SCALAR_SKIP = new Set(['agent', 'confirmer', 'prompt', 'list']);
const PARAM_NAME_SKIP = new Set(['repos', 'prompt']);
const AGENT_SUBFIELDS = [
  { sub: 'agent', label: 'agent' },
  { sub: 'model', label: 'model' },
  { sub: 'effort', label: 'effort' },
];
function paramMenuFields() {
  const seen = new Map();
  for (const s of S.schema || []) {
    for (const p of s.params || []) {
      if (PARAM_NAME_SKIP.has(p.name)) continue;
      if (p.type === 'agent' || p.type === 'confirmer') {
        for (const { sub, label } of AGENT_SUBFIELDS) {
          const key = `agent_${p.name}.${sub}`;
          if (!seen.has(key)) seen.set(key, { key, label: `${p.label || p.name} · ${label}`, type: 'text', param: true });
        }
        continue;
      }
      if (PARAM_SCALAR_SKIP.has(p.type) || seen.has(p.name)) continue;
      seen.set(p.name, {
        key: 'param.' + p.name,
        label: p.label || p.name,
        type: 'text',
        param: true,
        options: p.type === 'select' && p.options ? p.options.map((o) => ({ value: o, label: o })) : undefined,
      });
    }
  }
  return [...seen.values()];
}
// The base registry + the project's param fields — what all the menus draw from.
function allMenuFields() { return [...(S.fields || []), ...paramMenuFields()]; }
function menuFieldByKey(key) { return allMenuFields().find((f) => f.key === key); }

// The query toolbar: the field-driven quick filters + group + sort selectors. It
// reads the searchable-field registry (+ workflow params) so it never drifts from
// the parser. Shared by the task list (prefix 'q') and the task-picker overlay
// (prefix 'pk') — each instance edits its own query via wireQueryToolbar.
function queryToolbarHtml(q, prefix, trailing = '') {
  const fields = allMenuFields();
  const params = paramMenuFields();
  // Filter menu: everything with discrete-ish values (skip free-text title/notes),
  // but always include param fields even though they're text-typed.
  const filterFields = fields.filter((f) => f.type !== 'text' && !f.param);
  const grpFields = fields.filter((f) => f.groupable || f.param);
  const sortFields = fields.filter((f) => f.sortable || f.param);
  const curGroup = (q.match(/(?:^|\s)group:(\S+)/) || [])[1] || '';
  const curSort = (q.match(/(?:^|\s)sort:(\S+)/) || [])[1] || '';
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const grp = (label, inner) => (inner ? `<optgroup label="${esc(label)}">${inner}</optgroup>` : '');
  return `<div class="query-bar">
    <select id="${prefix}-filter-field" class="q-sel" title="Add a filter"><option value="">＋ Filter…</option>
      ${filterFields.map((f) => opt(f.key, f.label)).join('')}
      ${grp('Workflow params', params.map((f) => opt(f.key, f.label)).join(''))}</select>
    <select id="${prefix}-group" class="q-sel" title="Group by">
      ${opt('', 'No grouping', !curGroup)}${grpFields.filter((f) => !f.param).map((f) => opt(f.key, 'Group: ' + f.label, curGroup === f.key)).join('')}
      ${grp('Workflow params', params.map((f) => opt(f.key, 'Group: ' + f.label, curGroup === f.key)).join(''))}</select>
    <select id="${prefix}-sort" class="q-sel" title="Sort by">
      ${opt('', 'Sort: default', !curSort)}${sortFields.filter((f) => !f.param).map((f) => opt(f.key + '-desc', 'Sort: ' + f.label + ' ↓', curSort === f.key + '-desc') + opt(f.key + '-asc', 'Sort: ' + f.label + ' ↑', curSort === f.key + '-asc')).join('')}
      ${grp('Workflow params', params.map((f) => opt(f.key + '-asc', 'Sort: ' + f.label + ' ↑', curSort === f.key + '-asc') + opt(f.key + '-desc', 'Sort: ' + f.label + ' ↓', curSort === f.key + '-desc')).join(''))}</select>
    ${trailing}
  </div>`;
}

// Wire a toolbar instance's group/sort/filter controls onto a query holder:
// `get()` returns the instance's working query string, `set(q)` applies a new one.
function wireQueryToolbar(root, prefix, { get, set }) {
  $(`#${prefix}-group`, root)?.addEventListener('change', (e) => set(setDirective(get(), 'group', e.target.value)));
  $(`#${prefix}-sort`, root)?.addEventListener('change', (e) => set(setDirective(get(), 'sort', e.target.value)));
  $(`#${prefix}-filter-field`, root)?.addEventListener('change', (e) => {
    const key = e.target.value;
    e.target.value = '';
    if (key) openFilterPicker(key, (fieldTok, value) => set(addClause(get(), fieldTok, value)));
  });
}

function tasksView() {
  const r = S.searchResult;
  // Runs (spawned from a repeatable series) are grouped under their series row,
  // not shown at the top level. Build the lookup once for taskRow/seriesRow, and
  // hide runs from every list surface (flat + grouped) below.
  S._runsBySeries = {};
  for (const t of S.tasks) if (t.params?.runOf) (S._runsBySeries[t.params.runOf] ||= []).push(t);
  const notRun = (t) => !t.params?.runOf;
  // The server already applied the query (incl. the default -is:archived from effectiveQuery).
  // Fallback (before the first result lands) filters client-side and drops archived to match.
  const flat = (r
    ? r.tasks
    : S.tasks.filter((t) => taskMatches(t, S.search) && !t.params?.archived).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  ).filter(notRun);
  const groups = r && r.groups ? r.groups : null;
  const count = flat.length;
  let body;
  if (groups) {
    body = groups
      .map((g) => {
        const gt = g.tasks.filter(notRun);
        return `<div class="group-h">${esc(g.label)} <span class="pill">${gt.length}</span></div>${gt.map(taskRow).join('')}`;
      })
      .join('');
  } else {
    body = flat.map(taskRow).join('');
  }
  const empty = S.search
    ? `<div class="empty"><div class="big">No matching tasks</div>Nothing matches <code>${esc(S.search)}</code>. Edit the query or clear it.</div>`
    : `<div class="empty"><div class="big">No tasks yet</div>Describe a task above, or open the full form with “More”.</div>`;
  return `
    <div class="composer">
      <input class="title-in" id="new-task" placeholder="Describe a task and press ${esc(fmtKeys('meta+Enter').replace('↵', 'Enter'))}…  ( n )  ·  paste an image to attach" />
      <select id="new-wf">${WORKFLOWS.map((w) => `<option value="${w.id}">${w.label}</option>`).join('')}</select>
      <button class="btn icon-only" id="draft-task" title="Save as draft ( Alt+Enter )" aria-label="Save as draft (Alt+Enter)">${ICON.draft}</button>
      <button class="btn icon-only" id="expand-task" title="More fields ( N or ↵ )" aria-label="More fields">${ICON.more}</button>
      <button class="btn primary icon-only" id="add-task" title="Add directly ( ${esc(fmtKeys('meta+Enter'))} )" aria-label="Add task">${ICON.send}</button>
    </div>
    <div class="img-chips" id="new-task-chips" style="display:none"></div>
    <div class="organizer">
      <div class="search-box">
        <span class="search-ic">⌕</span>
        <input id="task-search" class="task-search" spellcheck="false" autocomplete="off" value="${esc(S.search)}"
          placeholder="Search &amp; filter…  e.g.  status:active -tag:bug priority:>=2  ( / )" />
        ${S.search ? `<button class="search-x" id="q-clear" title="Clear (Esc)">✕</button>` : ''}
      </div>
      ${viewsBar()}
      ${queryToolbarHtml(S.search || '', 'q', `<div class="q-spacer"></div><button class="btn sm" id="manage-tags" title="Manage the project's tags">🏷 Tags</button>`)}
    </div>
    <div class="switch" style="justify-content:space-between;margin:6px 2px 4px">
      <span style="font-size:12px;color:var(--ink-3)">${count} task${count === 1 ? '' : 's'}${S.search ? ' · filtered' : ''}</span>
    </div>
    ${body || empty}`;
}

// Small colored tag chip + priority flag shown on a task row.
function tagChips(t) {
  if (!t.tags || !t.tags.length) return '';
  return t.tags
    .map((id) => { const tag = tagById(id); if (!tag) return ''; const c = tag.color ? ` style="--tag:${esc(tag.color)}"` : ''; return `<span class="tag-chip ${tag.kind || ''}"${c}>${esc(tagPathStr(id))}</span>`; })
    .join('');
}
function priorityFlag(t) {
  const p = Number(t.params?.priority || 0);
  if (!p) return '';
  return `<span class="prio p${p}" title="Priority: ${PRIORITY_NAMES[p]}">${'▲'}${p >= 3 ? '' : ''} ${PRIORITY_NAMES[p]}</span>`;
}

// A one-line human summary of a task's triggers (armed-row subtitle).
function triggerSummary(triggers) {
  const arr = Array.isArray(triggers) ? triggers : [];
  return arr
    .map((t) => {
      if (t.kind === 'dependency') {
        const n = (t.tasks || []).length;
        return `after ${n} task${n === 1 ? '' : 's'}`;
      }
      if (t.kind === 'schedule') return t.cron ? `cron ${t.cron}` : t.at ? `at ${new Date(t.at).toLocaleString()}` : 'schedule';
      if (t.kind === 'event') return `on ${t.type}`;
      return t.kind;
    })
    .join('  ·  ');
}

// A repeatable series (Model A): one row that owns its runs. Shows a repeatable
// badge, the schedule/next-trigger summary, the run count + latest status, and
// expands to list the individual runs.
function seriesRow(t) {
  const runs = (S._runsBySeries?.[t.id] || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const expanded = S.expandedSeries?.has(t.id);
  const latest = runs[0]?.lastView;
  const dot = latest ? latest.status || 'active' : 'waiting';
  const bits = [];
  if (t.params?.triggers?.length) bits.push(triggerSummary(t.params.triggers));
  bits.push(`${runs.length} run${runs.length === 1 ? '' : 's'}`);
  const runsHtml = expanded ? runs.map(runSubRow).join('') : '';
  return `
    <div class="task-row series-row" data-series="${t.id}">
      <button class="icon-btn series-caret" data-expand="${t.id}" title="Show runs">${expanded ? '▾' : '▸'}</button>
      <span class="status-dot ${dot}" title="repeatable series"></span>
      <div class="task-main">
        <div class="task-title">${esc(t.title)} <span class="chip">repeatable</span></div>
        <div class="task-sub"><span class="wf">${esc(t.workflow)}</span><span style="color:var(--ink-3)">${esc(bits.join('  ·  '))}</span></div>
      </div>
      <div class="task-right">
        <button class="btn sm" data-runagain="${t.id}">Run again</button>
        <button class="btn sm danger" data-delseries="${t.id}">Delete</button>
      </div>
    </div>${runsHtml}`;
}

function runSubRow(r) {
  const v = r.lastView || {};
  const status = v.status || 'active';
  const stage = v.stage || 'setup';
  return `
    <div class="task-row run-row" data-id="${r.id}">
      <span class="status-dot ${status}" title="${esc(status)}"></span>
      <div class="task-main">
        <div class="task-title">${esc(r.title)} <span class="chip ${status}">${esc(stage)}</span></div>
        <div class="task-sub"><span style="color:var(--ink-3)">${new Date(r.createdAt).toLocaleString()}</span></div>
      </div>
      <div class="task-right">${pipeline(v)}</div>
    </div>`;
}

function taskRow(t) {
  const isDraft = t.params?.draft;
  if (t.params?.repeatable) return seriesRow(t);
  if (t.params?.triggerState === 'armed') {
    return `
    <div class="task-row" data-armed="${t.id}">
      <span class="status-dot waiting" title="waiting for trigger"></span>
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-sub"><span class="wf">${esc(t.workflow)}</span><span class="chip">waiting for trigger</span><span style="color:var(--ink-3)">${esc(triggerSummary(t.params.triggers))}</span></div>
      </div>
      <div class="task-right">
        <button class="btn sm" data-runnow="${t.id}">Run now</button>
        <button class="btn sm danger" data-canceltrig="${t.id}">Cancel</button>
      </div>
    </div>`;
  }
  if (isDraft) {
    return `
    <div class="task-row" data-draft="${t.id}" tabindex="0">
      <span class="status-dot cancelled" title="draft"></span>
      <div class="task-main">
        <div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}</div>
        <div class="task-sub"><span class="wf">${esc(t.workflow)}</span><span class="chip">draft</span>${priorityFlag(t)}${tagChips(t)}</div>
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
  // Any task can be archived/un-archived — archiving only hides it from the list,
  // it never affects a running task's execution.
  const archiveBtn = archived
    ? `<button class="icon-btn" data-unarchive="${t.id}" title="Unarchive — restore to the list"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></button>`
    : `<button class="icon-btn" data-archive="${t.id}" title="Archive — hide from the list"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg></button>`;
  return `
    <div class="task-row ${archived ? 'archived' : ''}" data-id="${t.id}" tabindex="0">
      <span class="status-dot ${status}" title="${esc(status)}"></span>
      <div class="task-main">
        <div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}${archived ? ' <span class="chip">archived</span>' : ''}</div>
        <div class="task-sub">
          <span class="wf">${esc(t.workflow)}</span>
          ${customBranch(v, t.id) ? `<span class="branch">${esc(v.branch)}</span>` : ''}
          <span class="chip ${status}">${esc(stageLabel(v))}</span>
          ${priorityFlag(t)}${tagChips(t)}
        </div>
      </div>
      <div class="task-right">${pipeline(v)}${archiveBtn}</div>
    </div>`;
}

// Every task gets an isolated worktree on an auto-generated `karmax/<taskId>`
// branch — the taskId is a noisy random slug, so echoing it in the byline just
// clutters the list/page (it's still reachable via the check-in terminal +
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
  if (v.state?.draft) return 'draft';
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

// ── task-organization control wiring (views bar + query toolbar + modals) ─────
function wireOrgControls() {
  const main = $('#main');
  // Saved-view chips: each selects a query; "All" is the default (empty) view.
  main.querySelectorAll('.view-chip[data-view]').forEach((el) =>
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-delview]')) return; // the ✕ handles itself
      const id = el.dataset.view;
      if (id === '__all__') { S.activeView = null; setQuery(''); return; }
      const builtin = BUILTIN_VIEWS.find((x) => x.id === id);
      if (builtin) { S.activeView = id; setQuery(builtin.query); return; }
      const v = S.views.find((x) => x.id === id);
      if (!v) return;
      S.activeView = id;
      setQuery(stringifyQuery(v.query || {}));
    }),
  );
  // Delete a saved view (with confirmation) — the API/gateway already support it.
  main.querySelectorAll('[data-delview]').forEach((x) =>
    x.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = x.dataset.delview;
      const v = S.views.find((y) => y.id === id);
      if (!confirm(`Delete the view “${v?.name || 'this view'}”? This can't be undone.`)) return;
      try {
        await api(`/api/views/${id}`, { method: 'DELETE' });
        S.views = S.views.filter((y) => y.id !== id);
        if (S.activeView === id) { S.activeView = null; setQuery(''); } else renderMain();
        toast('View deleted');
      } catch (e) { toast(e.message, true); }
    }),
  );
  $('#save-view')?.addEventListener('click', saveCurrentView);
  $('#manage-tags')?.addEventListener('click', openTagsManager);
  $('#q-clear')?.addEventListener('click', () => { S.activeView = null; setQuery(''); $('#task-search')?.focus(); });

  // The in-list search box drives the working query. Debounced re-evaluation keeps
  // typing smooth; the focus/caret survive the re-render via captureFocus/restoreFocus.
  const search = $('#task-search');
  if (search) {
    search.addEventListener('input', (e) => { S.search = e.target.value; S.activeView = null; scheduleSearch(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.search) { e.stopPropagation(); S.activeView = null; setQuery(''); } });
  }

  wireQueryToolbar(main, 'q', { get: () => S.search, set: (q) => { S.activeView = null; setQuery(q); } });
}

// Persist the current working query as a named view (Save-view button).
async function saveCurrentView() {
  const name = prompt('Name this view:', S.search ? S.search.slice(0, 40) : 'My view');
  if (!name) return;
  try {
    // The API persists a structured TaskQuery, so parse the working string into one
    // (parseQueryClient mirrors the server grammar; it round-trips back through it).
    const v = await api(`/api/projects/${S.projectId}/views`, {
      method: 'POST',
      body: JSON.stringify({ name, query: parseQueryClient(S.search) }),
    });
    S.views.push(v);
    S.activeView = v.id;
    renderMain();
    toast(`Saved view “${name}”`);
  } catch (err) { toast(err.message, true); }
}

// A minimal browser-side parser sufficient to persist a saved view's structured
// query (the authoritative parser is server-side; this mirrors its token grammar so
// what we store round-trips through it). Unknown tokens fold into free text.
function parseQueryClient(input) {
  const q = { filters: [], sort: [] };
  const text = [];
  // Mirrors the server tokenizer: a `key:` prefix binds to its value even when the
  // value carries quotes, so `conversation:"merge conflict"` stays one clause.
  const re = /([-!]{0,2}[A-Za-z_#][\w.#-]*):((?:"[^"]*"|[^\s"])*)|"([^"]*)"|(\S+)/g; let m;
  const OPS = [['>=', 'gte'], ['<=', 'lte'], ['>', 'gt'], ['<', 'lt'], ['=', 'is']];
  const splitVals = (raw) => {
    const vals = []; const vre = /"([^"]*)"|([^,]+)/g; let vm;
    while ((vm = vre.exec(raw))) { const v = (vm[1] !== undefined ? vm[1] : vm[2]).trim(); if (v) vals.push(v); }
    return vals;
  };
  while ((m = re.exec(input))) {
    if (m[1] === undefined) { const tok = m[3] !== undefined ? m[3] : m[4]; if (tok) text.push(tok); continue; }
    let key = m[1]; let rest = m[2] || ''; let negate = false;
    if (key[0] === '-' || key[0] === '!') { negate = true; key = key.slice(1); }
    if (key === 'sort') { let dir = 'asc'; let k = rest; if (k[0] === '-') { dir = 'desc'; k = k.slice(1); } const dm = k.match(/^(.*)[-:](asc|desc)$/i); if (dm) { k = dm[1]; dir = dm[2].toLowerCase(); } q.sort.push({ field: k, dir }); continue; }
    if (key === 'group') { q.group = rest; continue; }
    // `param.<key>` / `p.<key>` are synthetic workflow-param fields (text-typed).
    // `param.<key>` / `p.<key>` and `agent_<role>.<sub>` are synthetic (text) fields.
    const isParam = /^(param|p)\.[^.\s]+$/i.test(key) || /^agent_[a-z0-9]+\.(agent|model|effort)$/i.test(key);
    const fld = isParam ? { key, type: 'text' } : S.fields.find((f) => f.key === key || (f.aliases || []).includes(key));
    if (!fld) { text.push(m[0]); continue; }
    let op = fld.type === 'text' ? 'contains' : 'is';
    if (rest[0] !== '"') for (const [p, o] of OPS) if (rest.startsWith(p)) { op = o; rest = rest.slice(p.length); break; }
    const values = splitVals(rest);
    if (values.length) q.filters.push(negate ? { field: fld.key, op, values, negate: true } : { field: fld.key, op, values });
  }
  if (!q.filters.length) delete q.filters;
  if (!q.sort.length) delete q.sort;
  const t = text.join(' ').trim(); if (t) q.text = t;
  return q;
}

// A value picker for the chosen filter field — options for enum/facet/tag, a typed
// value (with comparison ops) for number/date/text. `onAdd(fieldTok, value)` appends
// the clause to whichever query the caller owns (the task list's or the picker's).
// Appended (not innerHTML-replaced) into #modal-root so it can stack on the
// task-picker overlay, which also lives there.
function openFilterPicker(fieldKey, onAdd) {
  const field = menuFieldByKey(fieldKey);
  if (!field) return;
  const host = document.createElement('div');
  $('#modal-root').appendChild(host);
  const apply = (value, negate) => { host.remove(); if (value === '' || value == null) return; onAdd((negate ? '-' : '') + field.key, value); };

  let inner = '';
  if (field.type === 'tag') {
    // Show the hierarchy as indented paths; picking one adds tag:<path>.
    const rows = S.tags.length
      ? S.tags.map((t) => `<div class="opt" data-val="${esc(tagPathStr(t.id))}">${esc(tagPathStr(t.id))}${t.kind ? ` <span class="pal-sub">${esc(t.kind)}</span>` : ''}</div>`).join('')
      : `<div class="pal-empty">No tags yet — add some via 🏷 Tags.</div>`;
    inner = rows;
  } else if (field.options) {
    inner = field.options.map((o) => `<div class="opt" data-val="${esc(o.value)}">${esc(o.label)}</div>`).join('');
  } else {
    const ops = field.type === 'number' || field.type === 'date'
      ? `<select id="fp-op" class="q-sel"><option value="">is</option><option value=">=">≥</option><option value="<=">≤</option><option value=">">&gt;</option><option value="<">&lt;</option></select>`
      : '';
    const ph = field.type === 'date' ? 'e.g. 7d, today, 2026-01-01' : 'value';
    inner = `<div class="fp-row">${ops}<input id="fp-val" class="title-in" placeholder="${ph}" /></div><button class="btn primary" id="fp-add">Add filter</button>`;
  }
  host.innerHTML = `<div class="palette-scrim" id="fp-scrim"><div class="palette fp">
    <div class="fp-head">Filter by ${esc(field.label)} <label class="fp-neg"><input type="checkbox" id="fp-negate" /> exclude</label></div>
    <div id="fp-list">${inner}</div>
  </div></div>`;
  const neg = () => $('#fp-negate', host)?.checked;
  $('#fp-scrim', host).addEventListener('click', (e) => { if (e.target.id === 'fp-scrim') host.remove(); });
  host.querySelectorAll('.opt[data-val]').forEach((o) => o.addEventListener('click', () => apply(o.dataset.val, neg())));
  $('#fp-add', host)?.addEventListener('click', () => { const op = $('#fp-op', host)?.value || ''; const val = $('#fp-val', host)?.value.trim(); if (val) apply(op + val, neg()); });
  $('#fp-val', host)?.focus();
  $('#fp-val', host)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const op = $('#fp-op', host)?.value || ''; const val = e.target.value.trim(); if (val) apply(op + val, neg()); } });
}

// ── overlay task picker (dependency search + fork-from search) ───────────────
// One full-featured task finder shared by every "pick a task" control: the same
// query language, view chips and filter/group/sort toolbar as the task list, in
// a modal with its OWN query state (the list's search is untouched). mode 'task'
// picks a task row; mode 'agent' expands a clicked task into its resumable
// per-role agent sessions and picks one → onPick({ task, role, session }).
// `defaults` are the facets hidden unless the query mentions them (the list's
// transparent -is:archived -is:run treatment, parameterized per caller — the
// fork search deliberately keeps archived tasks in).
function openTaskPicker({ title, hint, mode = 'task', defaults = ['archived', 'run'], exclude, onPick }) {
  const root = $('#modal-root');
  const host = document.createElement('div');
  root.appendChild(host);
  host.innerHTML = `<div class="palette-scrim" id="pk-scrim"><div class="palette picker">
    <div class="fp-head">${esc(title || 'Pick a task')}<span class="q-spacer"></span><button type="button" class="icon-btn" id="pk-close" title="Close (Esc)">✕</button></div>
    <div class="organizer">
      <div class="search-box">
        <span class="search-ic">⌕</span>
        <input id="pk-search" class="task-search" spellcheck="false" autocomplete="off"
          placeholder="Search &amp; filter…  e.g.  status:done tag:frontend priority:>=2" />
      </div>
      <div class="views-bar" id="pk-views"></div>
      <div id="pk-toolbar"></div>
    </div>
    ${hint ? `<div class="pk-hint">${esc(hint)}</div>` : ''}
    <div id="pk-list"></div>
  </div></div>`;
  const search = $('#pk-search', host);
  const list = $('#pk-list', host);
  const close = () => host.remove();
  let q = '';
  let activeView = null;
  let result = null; // last server evaluation
  let hi = 0; // roving highlight over pickable rows
  const sessions = new Map(); // taskId → role→session (agent mode, fetched on expand)
  const expanded = new Set(); // taskIds whose sessions are shown

  // View chips (All + built-ins + saved) and the toolbar re-render on every query
  // change so their selected state tracks the picker's own query, not the list's.
  const paintControls = () => {
    $('#pk-views', host).innerHTML = [
      `<div class="view-chip ${!activeView ? 'active' : ''}" data-pkview="__all__">≡ All</div>`,
      ...BUILTIN_VIEWS.map((v) => `<div class="view-chip builtin ${activeView === v.id ? 'active' : ''}" data-pkview="${v.id}" title="${esc(v.query)}">${esc(v.icon)} ${esc(v.name)}</div>`),
      ...S.views.map((v) => `<div class="view-chip ${activeView === v.id ? 'active' : ''}" data-pkview="${v.id}">${v.icon ? esc(v.icon) + ' ' : ''}${esc(v.name)}</div>`),
    ].join('');
    host.querySelectorAll('[data-pkview]').forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.dataset.pkview;
        activeView = id === '__all__' ? null : id;
        const bv = BUILTIN_VIEWS.find((x) => x.id === id);
        const sv = S.views.find((x) => x.id === id);
        setQ(id === '__all__' ? '' : bv ? bv.query : sv ? stringifyQuery(sv.query || {}) : '');
      }),
    );
    $('#pk-toolbar', host).innerHTML = queryToolbarHtml(q, 'pk');
    wireQueryToolbar(host, 'pk', { get: () => q, set: (nq) => { activeView = null; setQ(nq); } });
  };

  let deb = null;
  const setQ = (nq, typing) => {
    q = nq || '';
    if (search.value !== q) search.value = q;
    paintControls();
    clearTimeout(deb);
    deb = setTimeout(run, typing ? 180 : 0); // keystrokes coalesce; clicks apply at once
  };
  async function run() {
    try {
      const r = await api(`/api/projects/${S.projectId}/search?q=${encodeURIComponent(effectiveQuery(q, defaults))}`);
      result = r;
    } catch { result = { tasks: [] }; }
    hi = 0;
    paintList();
  }

  const rowHtml = (t) => {
    const v = t.lastView || {};
    const status = v.status || (t.params?.draft ? 'cancelled' : t.params?.triggerState === 'armed' ? 'waiting' : 'active');
    const chipLabel = t.params?.draft ? 'draft' : t.params?.triggerState === 'armed' ? 'waiting for trigger' : stageLabel(v);
    const open = expanded.has(t.id);
    return `<div class="pick-row" data-nav data-task="${t.id}">
      <span class="status-dot ${status}"></span>
      <div class="task-main">
        <div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)}${t.params?.archived ? ' <span class="chip">archived</span>' : ''}${t.params?.repeatable ? ' <span class="chip">repeatable</span>' : ''}</div>
        <div class="task-sub"><span class="wf">${esc(t.workflow)}</span><span class="chip ${status}">${esc(chipLabel)}</span>${priorityFlag(t)}${tagChips(t)}</div>
      </div>
      ${mode === 'agent' ? `<span class="pk-caret">${open ? '▾' : '▸'}</span>` : ''}
    </div>${open ? `<div class="pk-sessions">${sessionsHtml(t)}</div>` : ''}`;
  };

  const sessionsHtml = (t) => {
    const s = sessions.get(t.id);
    if (!s) return `<div class="pk-empty">Loading agent sessions…</div>`;
    const roles = Object.keys(s);
    if (!roles.length) return `<div class="pk-empty">No resumable agent sessions.</div>`;
    return roles
      .map((role) => `<div class="pick-row pk-session" data-nav data-task="${t.id}" data-role="${esc(role)}">
        <span class="pk-fork">⑂</span>
        <div class="task-main">
          <div class="task-title">${esc(role)} agent</div>
          <div class="task-sub">${s[role].provider ? `<span class="wf">${esc(s[role].provider)}</span>` : ''}<span class="mono">${esc(String(s[role].id || '').slice(0, 20))}…</span></div>
        </div>
      </div>`)
      .join('');
  };

  const navRows = () => [...list.querySelectorAll('[data-nav]')];
  const paintHi = () => navRows().forEach((el, i) => { el.classList.toggle('hi', i === hi); if (i === hi) el.scrollIntoView({ block: 'nearest' }); });

  const paintList = () => {
    if (!result) { list.innerHTML = `<div class="pk-empty">Searching…</div>`; return; }
    const keep = (t) => !(exclude && exclude(t));
    let body;
    if (result.groups) {
      body = result.groups
        .map((g) => {
          const gt = g.tasks.filter(keep);
          return gt.length ? `<div class="group-h">${esc(g.label)} <span class="pill">${gt.length}</span></div>${gt.map(rowHtml).join('')}` : '';
        })
        .join('');
    } else {
      body = (result.tasks || []).filter(keep).map(rowHtml).join('');
    }
    list.innerHTML = body || `<div class="pk-empty">No matching tasks${q ? ` for <code>${esc(q)}</code>` : ''}.</div>`;
    list.querySelectorAll('.pick-row').forEach((el) => el.addEventListener('click', () => activate(el)));
    paintHi();
  };

  const activate = async (el) => {
    const tid = el.dataset.task;
    const task = (result?.tasks || []).find((t) => t.id === tid);
    if (el.dataset.role !== undefined) { // a session sub-row → the actual pick
      onPick({ task, role: el.dataset.role, session: sessions.get(tid)?.[el.dataset.role] });
      return close();
    }
    if (mode === 'task') { onPick(task); return close(); }
    // agent mode: a task row toggles its session list (fetched once, then cached)
    if (expanded.has(tid)) { expanded.delete(tid); return paintList(); }
    expanded.add(tid);
    if (!sessions.has(tid)) {
      paintList(); // shows "Loading…" while the fetch is in flight
      sessions.set(tid, await api(`/api/tasks/${tid}/sessions`).catch(() => ({})));
    }
    paintList();
  };

  search.addEventListener('input', () => { activeView = null; setQ(search.value, true); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, navRows().length - 1); paintHi(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, 0); paintHi(); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = navRows()[hi]; if (r) activate(r); }
  });
  $('#pk-scrim', host).addEventListener('click', (e) => { if (e.target.id === 'pk-scrim') close(); });
  $('#pk-close', host).addEventListener('click', close);

  paintControls();
  run();
  search.focus();
}

// Project tag catalogue manager — create/rename/recolor/reparent/delete tags.
function openTagsManager() {
  const root = $('#modal-root');
  const draw = () => {
    const rows = S.tags.length
      ? S.tags.map((t) => `<div class="tagm-row">
          <span class="tag-chip ${t.kind || ''}" ${t.color ? `style="--tag:${esc(t.color)}"` : ''}>${esc(tagPathStr(t.id))}</span>
          <span class="pal-sub">${esc(t.kind || '')}</span>
          <span class="q-spacer"></span>
          <button class="btn sm" data-rename="${t.id}">Rename</button>
          <button class="btn sm danger" data-deltag="${t.id}">Delete</button>
        </div>`).join('')
      : `<div class="pal-empty">No tags yet.</div>`;
    root.innerHTML = `<div class="palette-scrim" id="tagm-scrim"><div class="palette tagm">
      <div class="fp-head">Tags</div>
      <div id="tagm-list">${rows}</div>
      <div class="tagm-new">
        <input id="tagm-name" class="title-in" placeholder="new tag  ·  use / for nesting (e.g. frontend/web)" />
        <select id="tagm-kind" class="q-sel"><option value="topic">topic</option><option value="type">type</option></select>
        <input id="tagm-color" type="color" value="#6b7fd7" title="color" />
        <button class="btn primary" id="tagm-add">Add tag</button>
      </div>
      <div class="tagm-hint">Type a <b>/</b>-separated path to nest — missing parents are created automatically. <b>type</b> = kind of work (bug, feature); <b>topic</b> = area (frontend, auth).</div>
    </div></div>`;
    $('#tagm-scrim').addEventListener('click', (e) => { if (e.target.id === 'tagm-scrim') root.innerHTML = ''; });
    const addTag = async () => {
      const name = $('#tagm-name').value.trim(); if (!name) return;
      try {
        await api(`/api/projects/${S.projectId}/tags`, { method: 'POST', body: JSON.stringify({ name, kind: $('#tagm-kind').value, color: $('#tagm-color').value }) });
        await loadOrg(); draw();
      } catch (e) { toast(e.message, true); }
    };
    $('#tagm-add').addEventListener('click', addTag);
    $('#tagm-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTag(); });
    root.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', async () => {
      const t = tagById(b.dataset.rename); const name = prompt('Rename tag:', t?.name); if (!name) return;
      try { await api(`/api/tags/${b.dataset.rename}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await loadOrg(); draw(); if (S.tab === 'tasks') renderMain(); } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll('[data-deltag]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this tag? Its children are promoted to its parent and it is removed from all tasks.')) return;
      try { await api(`/api/tags/${b.dataset.deltag}`, { method: 'DELETE' }); await loadOrg(); draw(); if (S.tab === 'tasks') { await runSearch(); renderMain(); } } catch (e) { toast(e.message, true); }
    }));
  };
  draw();
}

function wireTasksView() {
  wireOrgControls();
  $('#main').querySelectorAll('.task-row[data-id]').forEach((e) => wireTaskNav(e, () => e.dataset.id));
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
  $('#main').querySelectorAll('[data-runnow]').forEach((b) =>
    b.addEventListener('click', async (ev) => { ev.stopPropagation(); try { await api(`/api/tasks/${b.dataset.runnow}/run-now`, { method: 'POST', body: '{}' }); toast('Started'); refreshTasks(); } catch (e) { toast(e.message, true); } }),
  );
  $('#main').querySelectorAll('[data-canceltrig]').forEach((b) =>
    b.addEventListener('click', async (ev) => { ev.stopPropagation(); try { await api(`/api/tasks/${b.dataset.canceltrig}/cancel-trigger`, { method: 'POST', body: '{}' }); toast('Triggers cancelled — saved as a draft'); refreshTasks(); } catch (e) { toast(e.message, true); } }),
  );
  // Clicking a waiting task's body opens the same form as a draft — fully editable, triggers included.
  $('#main').querySelectorAll('[data-armed]').forEach((e) =>
    e.addEventListener('click', (ev) => { if (!ev.target.dataset.runnow && !ev.target.dataset.canceltrig) openTaskForm(undefined, S.tasks.find((t) => t.id === e.dataset.armed)); }),
  );
  // Repeatable series: run again, expand/collapse its runs, edit (body click), delete.
  $('#main').querySelectorAll('[data-runagain]').forEach((b) =>
    b.addEventListener('click', async (ev) => { ev.stopPropagation(); try { await api(`/api/tasks/${b.dataset.runagain}/run-again`, { method: 'POST', body: '{}' }); toast('New run started'); refreshTasks(); } catch (e) { toast(e.message, true); } }),
  );
  $('#main').querySelectorAll('[data-expand]').forEach((b) =>
    b.addEventListener('click', (ev) => { ev.stopPropagation(); S.expandedSeries ||= new Set(); const id = b.dataset.expand; S.expandedSeries.has(id) ? S.expandedSeries.delete(id) : S.expandedSeries.add(id); renderMain(); }),
  );
  $('#main').querySelectorAll('[data-delseries]').forEach((b) =>
    b.addEventListener('click', async (ev) => { ev.stopPropagation(); if (!confirm('Delete this repeatable task? Its past runs are kept.')) return; try { await api(`/api/tasks/${b.dataset.delseries}`, { method: 'DELETE' }); toast('Repeatable task deleted'); refreshTasks(); } catch (e) { toast(e.message, true); } }),
  );
  $('#main').querySelectorAll('[data-series]').forEach((e) => wireTaskNav(e, () => e.dataset.series));
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
  const add = async (draft = false) => {
    const input = $('#new-task');
    const title = input.value.trim();
    const images = S.newTaskImages || [];
    if (!title && !images.length) return;
    const workflow = $('#new-wf').value;
    try {
      await api(`/api/projects/${S.projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(quickTaskPayload(title, workflow, images, draft)),
      });
      input.value = '';
      S.newTaskImages = [];
      renderImageChips($('#new-task-chips'), S.newTaskImages);
      toast(draft ? 'Draft saved' : 'Task created');
      await refreshTasks();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#draft-task')?.addEventListener('click', () => add(true));
  $('#add-task')?.addEventListener('click', () => add(false));
  // Enter opens the FULL form (carrying the typed text into its prompt field) so
  // the default path invites elaboration; ⌘/Ctrl+Enter adds the task directly;
  // Alt+Enter saves it as an editable draft.
  $('#new-task')?.addEventListener('keydown', (e) => {
    const mode = quickTaskSubmitMode(e);
    if (!mode) return;
    e.preventDefault();
    if (mode === 'draft') add(true);
    else if (mode === 'add') add(false);
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

// Keyboard modes for the quick composer. Keep this separate from the event
// listener so the shortcut behavior stays easy to verify without a browser.
function quickTaskSubmitMode(e) {
  if (e.key !== 'Enter') return null;
  if (e.altKey) return 'draft';
  if (e.metaKey || e.ctrlKey) return 'add';
  return 'form';
}

// The quick composer has two submission modes (start now / save draft), but both
// must use the exact same sparse quick-defaults payload.
function quickTaskPayload(title, workflow, images, draft = false) {
  return {
    title: firstLine(title || 'Image task'),
    prompt: title,
    command: workflow === 'script-exec' ? title : undefined,
    workflow,
    quick: true,
    ...(draft ? { draft: true } : {}),
    ...(images.length ? { images } : {}),
  };
}

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

// ── triggers section of the task form (generic, workflow-agnostic) ───────────
const CRON_FIELDS = [
  { id: 'cron-min', label: 'Minute', hint: '0–59' },
  { id: 'cron-hour', label: 'Hour', hint: '0–23' },
  { id: 'cron-dom', label: 'Day', hint: '1–31' },
  { id: 'cron-mon', label: 'Month', hint: '1–12' },
  { id: 'cron-dow', label: 'Day of week', hint: '0–6 (Sun–Sat)' },
];

function triggersSection(values, selfId) {
  const existing = Array.isArray(values.triggers) ? values.triggers : [];
  const sched = existing.find((t) => t.kind === 'schedule' && t.cron);
  const at = existing.find((t) => t.kind === 'schedule' && t.at !== undefined);
  const cronParts = (sched?.cron || '').trim().split(/\s+/);
  const cronVal = (i) => (cronParts.length === 5 ? cronParts[i] : '');
  let atVal = '';
  if (at?.at) {
    const d = new Date(at.at);
    const p = (n) => String(n).padStart(2, '0');
    atVal = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const gridCells = CRON_FIELDS.map(
    (f, i) => `<label class="cron-cell">${f.label}<input id="${f.id}" placeholder="*" value="${esc(cronVal(i))}"><small>${f.hint}</small></label>`,
  ).join('');
  return `
    <details class="advanced" style="margin-top:10px" ${existing.length ? 'open' : ''}>
      <summary>Triggers — start this task on a dependency or a schedule</summary>
      <p class="task-sub" style="color:var(--ink-3);margin-top:0">Leave empty to start immediately.</p>
      <div class="form-row">
        <div class="label-row"><label>Task dependencies</label></div>
        <div class="chip-input" id="dep-box">
          <span class="chips" id="dep-chips"></span>
          <button type="button" class="btn sm" id="dep-add">＋ Add a task…</button>
        </div>
      </div>
      <div class="form-row">
        <div class="label-row"><label>On a schedule <span class="hint" title="Cron, in UTC. Each field: * = every, */5 = every 5, 1-5 = range, 1,3 = list.">cron, UTC ⓘ</span></div>
        <div class="cron-grid">${gridCells}</div>
      </div>
      <div class="form-row">
        <div class="label-row"><label>Or run once at</label></div>
        <input id="trig-at" type="datetime-local" value="${atVal}" style="width:100%">
      </div>
    </details>`;
}

// A prominent, always-visible task-level toggle (repeatable is a lifecycle choice,
// not a trigger — so it lives outside the collapsible Triggers section).
function repeatableToggleHtml(values) {
  return `
    <div class="form-row repeat-row">
      <label class="repeat-toggle"><input type="checkbox" id="trig-repeatable" ${values.repeatable ? 'checked' : ''}>
        <span><b>Repeatable</b> — each run is kept; a trigger (or “Run again”) spawns a fresh run instead of running once.</span>
      </label>
    </div>`;
}

// ── schedule: the 5 labelled cron cells ──────────────────────────────────────
function readCronCells() {
  return CRON_FIELDS.map((f) => ($('#' + f.id)?.value || '').trim() || '*');
}

// A schedule forces "repeatable" on (a cron fires forever) and locks the box.
function wireScheduleBuilder() {
  const syncRepeatable = () => {
    const cb = $('#trig-repeatable');
    if (!cb) return;
    const cronSet = readCronCells().join(' ') !== '* * * * *';
    if (cronSet) { cb.checked = true; cb.disabled = true; } else { cb.disabled = false; }
  };
  CRON_FIELDS.forEach((f) => $('#' + f.id)?.addEventListener('input', syncRepeatable));
  syncRepeatable();
}

// The dependency task ids currently chipped into the picker (state lives in the DOM).
function selectedDepIds() {
  return [...document.querySelectorAll('#dep-chips [data-depid]')].map((e) => e.dataset.depid);
}

// Read the triggers section back into a TaskTrigger[] (empty ⇒ starts immediately).
// Dependencies default to mode:'all' (AND) and on:'success' server-side, so we
// only carry the task ids. `existing` is the task's stored triggers: event triggers
// have no form UI (only agents create them, via the API), so any there are passed
// through untouched — editing a task in the form must not silently drop them.
function collectTriggers(existing) {
  const trigs = [];
  const deps = selectedDepIds();
  if (deps.length) trigs.push({ kind: 'dependency', tasks: deps });
  const cron = readCronCells().join(' ');
  if (cron !== '* * * * *') trigs.push({ kind: 'schedule', cron }); // all-* ⇒ no schedule set
  const at = $('#trig-at')?.value;
  if (at) {
    const ms = Date.parse(at);
    if (!isNaN(ms)) trigs.push({ kind: 'schedule', at: ms });
  }
  for (const t of Array.isArray(existing) ? existing : []) if (t.kind === 'event') trigs.push(t);
  return trigs;
}

// Wire the dependency chips: ✕ removes; "＋ Add a task…" opens the full task-picker
// overlay (the task list's search surface). Seeded from an existing dependency trigger.
function wireDepPicker(values, selfId) {
  const box = $('#dep-chips');
  const btn = $('#dep-add');
  if (!box || !btn) return;
  const known = new Map(); // tasks picked from the overlay that S.tasks may not hold yet
  const taskById = (id) => known.get(id) || (S.tasks || []).find((t) => t.id === id) || { id, title: id };
  const chip = (t) => `<span class="dep-chip" data-depid="${t.id}">${esc(t.title)}<button type="button" class="dep-x" data-depx="${t.id}" title="Remove">✕</button></span>`;
  const paint = (ids, changed) => {
    box.innerHTML = ids.map((id) => chip(taskById(id))).join('');
    box.querySelectorAll('[data-depx]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); paint(selectedDepIds().filter((x) => x !== b.dataset.depx), true); }));
    if (changed) box.dispatchEvent(new Event('change', { bubbles: true })); // the form's auto-save listens for change
  };
  btn.addEventListener('click', () =>
    openTaskPicker({
      title: 'Add a dependency',
      defaults: ['archived', 'run', 'series', 'draft'],
      exclude: (t) => t.id === selfId || selectedDepIds().includes(t.id),
      onPick: (t) => { known.set(t.id, t); paint([...selectedDepIds(), t.id], true); },
    }),
  );
  const existing = (Array.isArray(values.triggers) ? values.triggers : []).find((t) => t.kind === 'dependency');
  paint(existing?.tasks || []);
}

// ── the expanded task form (SPEC §10.4) ──────────────────────────────────────
// Identity of the task form currently mounted in the overlay. Opening a new form
// bumps this, so a still-pending debounced auto-save from a PRIOR form instance can
// tell it has been superseded and bail — otherwise its timer fires against the new
// form's (possibly empty) DOM and `replace:true`-wipes the draft it was editing.
let activeFormToken = null;
async function openTaskForm(workflow, draft, seedText) {
  const formToken = (activeFormToken = {});
  // The shell (topbar/rail) stays live behind the page, so the user can navigate
  // mid-edit. Pin the project NOW: every later write (auto-save flush, submit)
  // must land in the project the form was opened in, not wherever S.projectId
  // points by the time the async chain runs.
  const projectId = S.projectId;
  const wf = workflow || draft?.workflow || 'software-dev';
  const fields = schemaFor(wf).filter((f) => f.scopes.includes('task'));
  // The prompt/consuming field (a textarea) hosts pasted-image chips inside its
  // own box; only fall back to a standalone "Images" section if there isn't one.
  const cf = consumingField(fields);
  const promptField = cf && cf.type === 'text' ? cf : null;
  const values = draft ? { ...draft.params } : {};
  const armed = draft?.params?.triggerState === 'armed'; // a "waiting for trigger" task
  const series = !!draft?.params?.repeatable; // a repeatable template
  const editInPlace = armed || series; // neither has a running workflow — edit its stored params
  // Carry over the quick-add text (or whatever was typed before switching
  // workflows) into the field that consumes it, without clobbering a real value.
  if (seedText) {
    if (cf && !values[cf.name]) values[cf.name] = seedText;
  }
  let inherited = {};
  try { inherited = (await api(`/api/defaults/${projectId}/${wf}`)).task.inherited; } catch {}
  let authorization = { profiles: [], defaultProfile: 'developer' };
  try { authorization = await api(`/api/authorization/profiles?projectId=${encodeURIComponent(projectId)}`); } catch {}
  const selectedAuthorization = draft?.params?._authorization?.profileId || authorization.defaultProfile;
  const authorizationOptions = (authorization.profiles || []).map((p) =>
    `<option value="${esc(p.id)}" ${p.id === selectedAuthorization ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  // A draft can open directly from the list, without its task page having loaded
  // the intent. Fetch the group so the shared confirmer freezes after any sibling
  // queues, while remaining editable (and propagated) when every sibling is a draft.
  let formAttemptGroup = draft?.id && S.attemptGroup?.intentId === draft.intentId ? S.attemptGroup : null;
  if (draft?.id && !formAttemptGroup) {
    try { formAttemptGroup = await api(`/api/tasks/${draft.id}/attempts`); } catch {}
  }
  const root = $('#overlay-root');
  // Rendered as a full PAGE (GitHub-issue-creation style), not a dialog: the big
  // prompt editor + workflow parameters fill the main column; organization
  // metadata (priority/tags, authorization, attempts, notes) lives in a sidebar.
  // Everything stays inside #tf-body so collect/auto-save wiring sees one form.
  const proj = S.projects.find((p) => p.id === projectId);
  const restFields = promptField ? fields.filter((f) => f.name !== promptField.name) : fields;
  root.innerHTML = `
    <div class="task-form-page" id="tf-page" tabindex="-1">
      <div class="tf-head">
        <div class="tf-head-inner">
          <button class="icon-btn" id="tf-close" title="Back (Esc)">←</button>
          <h2>${draft ? (editInPlace ? 'Edit task' : 'Edit draft') : 'New task'}</h2>
          ${proj ? `<span class="tf-crumb">in ${esc(proj.name)}</span>` : ''}
          <span class="tf-savestate" id="tf-savestate" aria-live="polite"></span>
          <select id="tf-wf" title="Workflow" ${draft ? 'disabled' : ''}>${WORKFLOWS.map((w) => `<option value="${w.id}" ${w.id === wf ? 'selected' : ''}>${w.label}</option>`).join('')}</select>
        </div>
      </div>
      <div class="tf-scroll">
        <div class="tf-columns parameter-fields" id="tf-body">
          <div class="tf-main">
            ${promptField ? renderField(promptField, values[promptField.name], inherited[promptField.name], true) : ''}
            ${restFields.length ? `<div class="section-h">Parameters</div>${renderFields(restFields, values, inherited)}` : ''}
            ${promptField ? '' : `<div class="form-row" data-row="__images">
              <div class="label-row"><label>Images</label></div>
              <div class="img-chips" id="tf-chips" style="display:none"></div>
              <span style="color:var(--ink-3);font-size:12px">Paste (⌘/Ctrl-V) or drag an image into a text field above to attach it to the prompt.</span>
            </div>`}
            ${triggersSection(values, draft?.id)}
            ${repeatableToggleHtml(values)}
          </div>
          <aside class="tf-side">
            <div class="form-row" data-row="__org">
              <div class="label-row"><label>Priority &amp; tags</label></div>
              ${orgEditorHtml(draft || { id: null, params: {}, tags: [] })}
            </div>
            ${authorizationOptions ? `<div class="form-row" data-row="__authorization">
              <div class="label-row"><label title="Applies to every agent and retry in this workflow, capped by your own permissions.">Agent authorization</label></div>
              <select id="tf-authorization">${authorizationOptions}</select>
            </div>` : ''}
            ${!draft ? `<div class="form-row tf-inline" data-row="__attempts" title="Attempts created here are queued together. Attempts added later start as editable drafts.">
              <label for="tf-attempt-count">Attempts</label>
              <input id="tf-attempt-count" type="number" min="1" max="8" value="1">
            </div>` : ''}
            <div class="form-row" data-row="__vault">
              <div class="label-row"><label title="Which vault credentials (site logins, API keys, SSH keys, .env bags) this task's agents may use. Agents can request more mid-task; you approve each request.">Vault credentials</label></div>
              <div id="tf-vault-grants" style="font-size:12px">Loading…</div>
            </div>
            <div class="form-row" data-row="__creds">
              <div class="label-row"><label title="Precedence + enable/disable for this task, overriding the organization/project order. Drag to reorder; toggle On/Off.">Credentials</label></div>
              <div id="cred-editor-newtask">Loading…</div>
            </div>
            <div class="form-row" data-row="__notes">
              <div class="label-row"><label>Notes</label></div>
              <textarea id="tf-notes" rows="4" placeholder="Jot down anything for yourself — not sent to the agent" style="width:100%">${esc(draft?.notes || '')}</textarea>
            </div>
          </aside>
        </div>
      </div>
      <div class="tf-foot">
        <div class="tf-foot-inner">
          <span class="tf-hint">Closing keeps your work as a draft</span>
          <button class="btn" id="tf-draft">${editInPlace ? 'Save as draft' : 'Save draft'}</button>
          <button class="btn primary" id="tf-queue">${draft ? (editInPlace ? 'Save' : 'Queue') : 'Add task'}<span class="kbd">${esc(fmtKeys('meta+Enter'))}</span></button>
        </div>
      </footer>
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
    // Let any in-flight save settle first so a create still mid-flight can't
    // materialise its draft AFTER this delete and orphan it.
    clearTimeout(saveTimer);
    await saveChain;
    if (localCred && draftId) { const id = draftId; draftId = null; try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); } catch {} }
    openTaskForm($('#tf-wf').value, undefined, (carried || '').trim());
  });
  $('#tf-close').addEventListener('click', () => closeForm());
  wireAgentFields($('#tf-body'));
  wireFieldResets($('#tf-body'), fields);
  const confirmerFrozen = !!draft?.id
    && !!formAttemptGroup?.attempts?.some((a) => !a.params?.draft);
  if (confirmerFrozen) {
    const confirmer = fields.find((f) => f.type === 'confirmer');
    const row = confirmer && $('#tf-body')?.querySelector(`[data-row="${CSS.escape(confirmer.name)}"]`);
    if (row) {
      row.querySelectorAll('input,select,textarea,button').forEach((el) => { el.disabled = true; });
      row.insertAdjacentHTML('beforeend', '<span style="color:var(--ink-3);font-size:12px">Shared with every attempt and frozen once one is queued.</span>');
    }
  }
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
  // Typing "@" in the prompt tags wiki pages/labels/folders into the task's context.
  const promptTa = $('#tf-body')?.querySelector('textarea[data-field="prompt"]');
  if (promptTa) wireWikiMention(promptTa, projectId);
  // The prompt's "wiki context" bottom row: seed with the task's tokens, or the
  // defaults so the user can see (and backspace away) what's inlined by default.
  const contextTa = $('#tf-context');
  if (contextTa) {
    const wc = draft?.params?.wikiContext;
    contextTa.value = Array.isArray(wc) ? wc.join(' ') : '@proj:tag:default @org:tag:default';
    const growContext = () => { contextTa.style.height = 'auto'; contextTa.style.height = `${contextTa.scrollHeight}px`; };
    growContext();
    contextTa.addEventListener('input', growContext);
    wireWikiMention(contextTa, projectId);
  }
  paintFormChips();
  // Focus the consuming field (prompt/command) with the caret at the end, so
  // Enter-from-quick-add flows straight into elaborating what was typed. `cf`
  // (the consuming field) is resolved once at the top of this function.
  const cfEl = cf && $('#tf-body')?.querySelector(`[data-field="${CSS.escape(cf.name)}"]`);
  if (cfEl) {
    cfEl.focus();
    const end = cfEl.value?.length ?? 0;
    if (typeof cfEl.setSelectionRange === 'function') { try { cfEl.setSelectionRange(end, end); } catch {} }
  } else $('#tf-page')?.focus(); // keep focus inside the page so Esc reaches its handler
  // Per-task credential overrides. NOTE: there are TWO task forms that must each carry
  // this control — this NEW-TASK / edit-draft form (#cred-editor-newtask) AND the task
  // page's Parameters tab (#cred-editor-task). Change one → check the other.
  // A draft has an id → edit its policy directly. A brand-new task has none, so the
  // editor runs in `local` mode: changes are held here and applied on create (below).
  let taskCredPolicy = {};
  const localCred = !draft;
  if (draft) renderCredentialEditor($('#cred-editor-newtask'), 'task', { projectId, taskId: draft.id });
  else renderCredentialEditor($('#cred-editor-newtask'), 'task', { local: true, projectId, policy: taskCredPolicy, onChange: (p) => { taskCredPolicy = p; autoSaveSoon(); } });
  // The vault credential picker (PLAN-passwords.md §6): item grants layered onto
  // the authorization package. Checkbox changes ride the #tf-body change
  // listener into auto-save; grants persist via createTask/PATCH authorization.
  (async () => {
    const box = $('#tf-vault-grants');
    if (!box) return;
    // Vault items are organization-scoped — read the project's org's vault.
    const vaultOrg = S.projects.find((p) => p.id === projectId)?.organizationId;
    let items = [];
    try { items = await api(`/api/vault/items${vaultOrg ? `?organizationId=${encodeURIComponent(vaultOrg)}` : ''}`); } catch { box.closest('[data-row="__vault"]')?.remove(); return; }
    if (!items.length) {
      box.closest('[data-row="__vault"]')?.remove();
      return;
    }
    const granted = new Set((draft?.params?._authorization?.capabilities || [])
      .filter((c) => c.startsWith('use-credential:item:')).map((c) => c.slice('use-credential:item:'.length)));
    box.innerHTML = items.map((i) => `<label style="display:flex;gap:6px;align-items:center;margin:2px 0;cursor:pointer">
      <input type="checkbox" class="tf-vault-grant" value="use-credential:item:${esc(i.id)}" ${granted.has(i.id) ? 'checked' : ''} />
      <span>${esc(i.label)}</span> <span class="mono" style="color:var(--ink-3);font-size:11px">${esc(i.type)}${i.domains?.length ? ' · ' + esc(i.domains.join(', ')) : ''}</span></label>`).join('');
  })();
  wireDepPicker(values, draft?.id);
  wireScheduleBuilder(values);

  // The priority+tags editor is wired further down, once `draftId`/`ensureDraft` exist
  // (a brand-new task needs a draft persisted before tags/priority can attach).

  // The id of the draft this form is editing. Starts as the passed-in draft; a
  // brand-new task gets one lazily the first time auto-save persists real content.
  let draftId = draft?.id || null;
  const hasPolicy = () => !!(taskCredPolicy.order?.length || taskCredPolicy.on?.length || taskCredPolicy.off?.length);
  // Prompt image attachments ride inside `params` (references only), so they flow
  // through auto-save, draft, and queue the same way the prompt text does.
  const formState = () => {
    const body = collectForm($('#tf-body'), fields);
    if (formImages.length) body.images = [...formImages];
    // Triggers + repeatable are generic (workflow-agnostic) params, not part of the
    // manifest schema, so they're collected separately and merged onto params —
    // this way they ride through auto-save, draft, and queue like the prompt does.
    // (Critical: formState feeds the `replace:true` auto-save, so omitting them here
    // would silently drop an armed/series task's triggers mid-edit.)
    const triggers = collectTriggers(values.triggers);
    if (triggers.length) body.triggers = triggers;
    if ($('#trig-repeatable')?.checked) body.repeatable = true;
    // The "wiki context" row (@proj:…/@org:… tokens). Always sent — even empty,
    // which is a deliberate opt-out of the default `default`-labelled pages — so
    // the replace:true auto-save preserves the user's choice.
    const ctx = $('#tf-context');
    if (ctx) body.wikiContext = String(ctx.value).split(/\s+/).map((t) => t.trim()).filter((t) => /^@(proj|org):\S/i.test(t));
    return {
      body, notes: $('#tf-notes')?.value ?? '',
      authorizationProfile: $('#tf-authorization')?.value || selectedAuthorization,
      // Per-task vault item grants (PLAN-passwords.md §6) — the credential picker.
      credentialGrants: [...document.querySelectorAll('.tf-vault-grant:checked')].map((b) => b.value),
    };
  };
  // Whether the user has actually put something worth keeping into a NEW task —
  // guards against spawning empty drafts just from opening the form.
  const hasContent = ({ body, notes }) => {
    // Wiki context alone (default or edited) isn't "content" worth a draft — it
    // rides along once there's a real prompt/command. Exclude it from the scan.
    const { wikiContext: _wc, ...rest } = body;
    return notes.trim() !== '' ||
      hasPolicy() ||
      formImages.length > 0 ||
      Object.values(rest).some((v) =>
        Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null && typeof v !== 'boolean');
  };

  // Persist the current form as a draft without leaving the form. Silent by
  // design — auto-save shouldn't nag; the explicit buttons surface errors.
  const stateSig = (st) => JSON.stringify(st) + (localCred ? JSON.stringify(taskCredPolicy) : '');
  // Seed the baseline with the freshly-loaded form's own signature so simply OPENING
  // and dismissing a draft never re-writes it. Without this `lastSaved` starts null,
  // so an *untouched* form still flushes a full `replace:true` on close — and a passive
  // copy left open in another karmax tab clobbers a newer edit made elsewhere, or a
  // stale snapshot reverts it. That is the "saved draft contents disappear" bug: only a
  // real change in THIS form (its signature diverging from the seed) now triggers a write.
  let lastSaved = stateSig(formState());
  // Saves are SERIALIZED through this chain. Overlapping writes otherwise race:
  // if a debounced create is still in flight when the user types more or closes the
  // form (which flushes), `draftId` is still null, so the next save POSTs a *second*
  // draft instead of PATCHing the first — you end up with duplicate drafts, one
  // holding only the pre-close text (looks like the last edit was dropped). Even for
  // an existing draft, two in-flight PATCHes can land out of order and clobber the
  // newer edit. Chaining guarantees each save sees the previous one's `draftId`/
  // `lastSaved` and lands in order, so the most recent edit always wins.
  let saveChain = Promise.resolve();
  function persistDraft(st = formState()) {
    // Snapshot the signature at CALL time (the DOM may be gone by the time this link
    // in the chain runs — e.g. closeForm clears the form right after queuing the flush).
    const sig = stateSig(st);
    saveChain = saveChain.then(async () => {
      if (!draftId && !hasContent(st)) return; // nothing worth creating a draft for yet
      if (sig === lastSaved) return; // no change since the last write landed
      try {
        if (!draftId) {
          const created = await api(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, authorizationProfile: st.authorizationProfile, credentialGrants: st.credentialGrants, draft: true }) });
          draftId = created.id;
        } else {
          await api(`/api/tasks/${draftId}/params`, { method: 'PATCH', body: JSON.stringify({ params: st.body, replace: true }) });
          await api(`/api/tasks/${draftId}/notes`, { method: 'PATCH', body: JSON.stringify({ notes: st.notes }) });
          await api(`/api/tasks/${draftId}/authorization`, { method: 'PATCH', body: JSON.stringify({ profileId: st.authorizationProfile, credentialGrants: st.credentialGrants }) });
        }
        if (localCred && hasPolicy()) await api(`/api/credentials/policy?taskId=${encodeURIComponent(draftId)}`, { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: draftId, policy: taskCredPolicy }) });
        lastSaved = sig;
        // Quiet auto-save indicator in the page head. Guard on the form token: this
        // chain link can land after a NEWER form instance has mounted its own head.
        if (activeFormToken === formToken) { const ss = $('#tf-savestate'); if (ss) ss.textContent = 'Draft saved'; }
        refreshTasks();
      } catch { /* keep the form open; a later save or explicit button will retry */ }
    });
    return saveChain;
  }

  // Debounced auto-save while typing.
  let saveTimer = null;
  function autoSaveSoon() {
    const ss = $('#tf-savestate');
    if (ss) ss.textContent = ''; // edits in flight — clear "Draft saved" until it lands
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (activeFormToken !== formToken) return; persistDraft(); }, 800);
  }
  $('#tf-body').addEventListener('input', autoSaveSoon);
  $('#tf-body').addEventListener('change', autoSaveSoon);

  // ── Priority + tags editor (organization; never sent to the agent) ──────────
  // IMPORTANT: this is ONE of TWO places the tag/priority editor lives — here in the full
  // task form (new + draft), and on the task page's Parameters tab (wireTaskOrg).
  // Both go through orgEditorHtml/wireOrgEditor. If you change one, check the other.
  // Tags/priority need a taskId to attach to; a brand-new task has none until it's saved,
  // so `ensureDraft` persists (or force-creates) a draft on the first tag/priority edit.
  async function ensureDraft() {
    if (draftId) return draftId;
    await persistDraft();
    if (draftId) return draftId;
    // Empty form, but the user is organizing it — mint a bare draft to hold the tags.
    const state = formState();
    const created = await api(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: state.body, authorizationProfile: state.authorizationProfile, credentialGrants: state.credentialGrants, draft: true }) });
    draftId = created.id;
    refreshTasks();
    return draftId;
  }
  const orgRec = draft
    ? { id: draft.id, params: { priority: draft.params?.priority || 0 }, tags: (draft.tags || []).slice() }
    : { id: null, params: {}, tags: [] };
  const refreshOrg = () => {
    const box = root.querySelector('[data-row="__org"] .org-editor');
    if (box) { box.outerHTML = orgEditorHtml(orgRec); wireOrgEditor(root, orgRec, { ensureId: ensureDraft, afterChange: refreshOrg }); }
    if (S.tab === 'tasks') renderMain();
  };
  wireOrgEditor(root, orgRec, { ensureId: ensureDraft, afterChange: refreshOrg });

  // Flush any pending edits when the form is dismissed, so closing without
  // clicking a button still keeps the draft.
  closeForm = () => { clearTimeout(saveTimer); const st = formState(); root.innerHTML = ''; persistDraft(st); };

  const submit = async (draftMode) => {
    clearTimeout(saveTimer);
    const st = formState();
    // Drain any in-flight auto-save first: it may still be creating the draft (setting
    // draftId) or PATCHing older text. Waiting lets the branches below see the right
    // draftId and land last, so the explicit save/queue reflects the final form state.
    await saveChain.catch(() => {});
    try {
      let primaryId = draftId || draft?.id || null;
      const attemptCount = Math.max(1, Math.min(8, Number($('#tf-attempt-count')?.value || 1)));
      let createdWithAttempts = false;
      if (editInPlace) {
        // A waiting (armed) task or a repeatable series edits in place (incl. its
        // triggers) — it has no running workflow to queue. "Save" re-arms / keeps
        // the series; "Save as draft" (draftMode) disarms it back to a draft.
        await api(`/api/tasks/${draft.id}/params`, { method: 'PATCH', body: JSON.stringify({ params: st.body, replace: true, keepArmed: !draftMode }) });
        await api(`/api/tasks/${draft.id}/notes`, { method: 'PATCH', body: JSON.stringify({ notes: st.notes }) });
        await api(`/api/tasks/${draft.id}/authorization`, { method: 'PATCH', body: JSON.stringify({ profileId: st.authorizationProfile, credentialGrants: st.credentialGrants }) });
      } else if (draftId) {
        // Auto-save (or a prior edit) already materialised the draft — update it in place.
        await api(`/api/tasks/${draftId}/params`, { method: 'PATCH', body: JSON.stringify({ params: st.body, replace: true }) });
        await api(`/api/tasks/${draftId}/notes`, { method: 'PATCH', body: JSON.stringify({ notes: st.notes }) });
        await api(`/api/tasks/${draftId}/authorization`, { method: 'PATCH', body: JSON.stringify({ profileId: st.authorizationProfile, credentialGrants: st.credentialGrants }) });
        if (localCred && hasPolicy()) await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: draftId, policy: taskCredPolicy }) });
        // An explicitly-opened later attempt queues only itself. A draft created
        // while composing a brand-new task is queued as a group below, after all
        // requested siblings have been materialised.
        if (!draftMode && draft) await api(`/api/tasks/${draftId}/queue`, { method: 'POST', body: '{}' });
        primaryId = draftId;
      } else if (hasPolicy()) {
        // Custom per-task credential order/enablement: create as a draft first so the
        // override is persisted BEFORE the workflow starts leasing, then queue.
        const created = await api(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, authorizationProfile: st.authorizationProfile, credentialGrants: st.credentialGrants, draft: true, attempts: attemptCount }) });
        draftId = created.id;
        createdWithAttempts = true;
        await api('/api/credentials/policy', { method: 'POST', body: JSON.stringify({ scope: 'task', taskId: created.id, policy: taskCredPolicy }) });
        primaryId = created.id;
      } else {
        const created = await api(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify({ workflow: wf, params: st.body, notes: st.notes, authorizationProfile: st.authorizationProfile, credentialGrants: st.credentialGrants, draft: draftMode, attempts: attemptCount }) });
        primaryId = created.id;
        createdWithAttempts = true;
      }
      // Auto-save may have created the principal before Submit knew the count.
      // Create every sibling before starting any of them.
      if (!draft && primaryId && !createdWithAttempts) {
        for (let i = 1; i < attemptCount; i++) await api(`/api/tasks/${primaryId}/attempts`, { method: 'POST', body: '{}' });
      }
      if (!draft && primaryId && !draftMode) {
        const group = await api(`/api/tasks/${primaryId}/attempts`);
        for (const attempt of group?.attempts || []) {
          if (attempt.params?.draft) await api(`/api/tasks/${attempt.id}/queue`, { method: 'POST', body: '{}' });
      }
      }
      root.innerHTML = '';
      toast(editInPlace ? (draftMode ? 'Moved to drafts' : 'Saved') : draftMode ? 'Draft saved' : 'Task created');
      refreshTasks();
    } catch (e) { toast(e.message, true); }
  };
  $('#tf-draft').addEventListener('click', () => submit(true));
  $('#tf-queue').addEventListener('click', () => submit(false));
  // Keyboard on the expanded form (fires before the global handler, which would
  // otherwise only blur the focused field on Escape). ⌘/Ctrl-Enter = Add task /
  // Queue; Escape closes — and closeForm() flushes the draft on the way out, so
  // dismissing with the keyboard saves just like clicking away does.
  $('#tf-page').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(false); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm(); }
  });
}

// ── task page ─────────────────────────────────────────────────────────────────
// A task opens as a PAGE of its own (route /<org>/<project>/tasks/:num), rendered
// into #main with four tabs — Overview (pipeline, review, widgets, sub-tasks,
// notes), Check-in (agent conversations + the ephemeral terminal), Parameters
// (priority/tags, workflow params, credentials) and Advanced (event log,
// structured state). The workflow still owns everything shown — actions, stages,
// params, widgets and transcripts all come off the declared view; the host only
// lays them out. Declared actions (Confirm/Cancel/…) live in a footer bar that
// stays visible on every tab.
const TASK_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'checkin', label: 'Check-in' },
  { key: 'parameters', label: 'Parameters' },
  { key: 'advanced', label: 'Advanced' },
];

// The tab a task page opens on when the URL doesn't pin one: while the workflow
// is asking the human to decide (an enabled `confirm` action — the Review gate),
// the conversation that led here is the thing to read, so open Check-in on the
// stage's agent. Otherwise Overview.
function defaultTaskTab(v) {
  return (v.actions || []).some((a) => a.name === 'confirm' && a.enabled) ? 'checkin' : 'overview';
}

// The config page for a repeatable series: edit its parameters + triggers, see
// its runs, and Run again. Saved via the same in-place path as a waiting task
// (updateArmedParams) — the series never runs its own workflow, so there is no
// pipeline/conversation to tab through; it's a single editable form.
async function renderSeriesPage(rec) {
  const wf = rec.workflow;
  const fields = schemaFor(wf).filter((f) => f.scopes.includes('task'));
  const values = { ...rec.params };
  let inherited = {};
  try { inherited = (await api(`/api/defaults/${rec.projectId}/${wf}`)).task.inherited; } catch {}
  const runs = await api(`/api/tasks/${rec.id}/runs`).catch(() => []);
  const main = $('#main');
  if (!main || S.selected !== rec.id) return; // navigated away while fetching
  main.innerHTML = `
    <div class="task-page">
      <div class="tp-head">
        <div class="row1">
          <button class="icon-btn" id="tp-back" title="Back (Esc)">←</button>
          ${rec.num != null ? `<span class="task-num">#${rec.num}</span>` : ''}
          <h2>${esc(rec.title)}</h2>
          <span class="chip">repeatable</span>
        </div>
        <div class="meta">
          <span>${esc(wf)}</span>
          ${rec.params?.triggers?.length ? `<span>${esc(triggerSummary(rec.params.triggers))}</span>` : ''}
          <span>${runs.length} run${runs.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div class="tp-body" id="tp-body" tabindex="-1"><div class="tp-content">
        <div id="tf-body">
          ${renderFields(fields, values, inherited)}
          <div class="form-row" data-row="__notes">
            <div class="label-row"><label>Notes</label></div>
            <textarea id="tf-notes" rows="3" placeholder="Only you see this — never sent to the agent" style="width:100%">${esc(rec.notes || '')}</textarea>
          </div>
          <details class="advanced" style="margin-top:10px">
            <summary>Credentials — precedence &amp; enable/disable</summary>
            <div id="cred-editor-newtask">Loading…</div>
          </details>
          ${triggersSection(values, rec.id)}
          ${repeatableToggleHtml(values)}
        </div>
        <div class="series-runs">
          <div class="series-runs-h">Runs</div>
          ${runs.length ? runs.map(runPageRow).join('') : '<p class="task-sub" style="color:var(--ink-3);margin:2px 0">No runs yet.</p>'}
        </div>
      </div></div>
      <div class="tp-foot" id="tp-foot"><div class="tp-foot-inner">
        <button class="btn" id="sd-runagain">Run again</button>
        <span style="flex:1"></span>
        <button class="btn primary" id="sd-save">Save changes</button>
      </div></div>
    </div>`;
  $('#tp-back').addEventListener('click', closeTask);
  wireAgentFields($('#tf-body'));
  wireFieldResets($('#tf-body'), fields);
  renderCredentialEditor($('#cred-editor-newtask'), 'task', { projectId: rec.projectId, taskId: rec.id });
  wireDepPicker(values, rec.id);
  wireScheduleBuilder(values);
  $('#tp-body').querySelectorAll('[data-runopen]').forEach((el) => wireTaskNav(el, () => el.dataset.runopen));
  $('#sd-runagain').addEventListener('click', async () => {
    try { await api(`/api/tasks/${rec.id}/run-again`, { method: 'POST', body: '{}' }); toast('New run started'); closeTask(); refreshTasks(); }
    catch (e) { toast(e.message, true); }
  });
  $('#sd-save').addEventListener('click', async () => {
    const body = collectForm($('#tf-body'), fields);
    const triggers = collectTriggers(values.triggers);
    if (triggers.length) body.triggers = triggers;
    body.repeatable = !!$('#trig-repeatable')?.checked;
    const notes = $('#tf-notes')?.value ?? '';
    try {
      await api(`/api/tasks/${rec.id}/params`, { method: 'PATCH', body: JSON.stringify({ params: body, replace: true, keepArmed: true }) });
      if ((rec.notes || '') !== notes) await api(`/api/tasks/${rec.id}/notes`, { method: 'PATCH', body: JSON.stringify({ notes }) });
      toast('Saved'); closeTask(); refreshTasks();
    } catch (e) { toast(e.message, true); }
  });
}

function runPageRow(r) {
  const v = r.lastView || {};
  const status = v.status || 'active';
  return `<div class="run-row" data-runopen="${r.id}"><span class="status-dot ${status}"></span><span class="chip ${status}">${esc(v.stage || 'setup')}</span><span class="run-when">${new Date(r.createdAt).toLocaleString()}</span></div>`;
}

// One compact selectable row per execution. The list remains one row per intent;
// switching here replaces the entire task-page projection with that attempt.
function taskAttempts(v) {
  const g = S.attemptGroup;
  if (!g?.attempts?.length) return '';
  const rows = g.attempts.map((a) => {
    const av = a.lastView || {};
    const principal = a.id === g.principalAttemptId;
    const committed = a.id === g.committedAttemptId;
    const selected = a.id === v.taskId;
    const status = av.status || (a.params?.draft ? 'waiting' : 'active');
    return `<button type="button" class="attempt-card${principal ? ' principal' : ''}${selected ? ' selected' : ''}" data-attempt-select="${a.id}" ${selected ? 'aria-current="true"' : ''}>
      <span class="attempt-check">${selected ? '✓' : ''}</span>
      <span class="status-dot ${esc(status)}"></span>
      <b>Attempt ${a.attemptNumber || 1}</b>
      ${principal ? '<span class="chip">principal</span>' : ''}
      ${committed ? '<span class="chip done" title="Attempt has been irrevocably selected as the winner; sibling attempts will not be allowed to pass">jayadratha</span>' : ''}
      <span class="attempt-stage">${esc(a.params?.draft ? 'draft' : stageLabel(av))}</span>
    </button>`;
  }).join('');
  return `<div class="attempts"><div class="attempts-head"><span>${g.attempts.length} attempt${g.attempts.length === 1 ? '' : 's'}</span><button class="btn sm" id="add-attempt" ${g.committedAttemptId ? 'disabled title="An attempt has entered Merge"' : ''}>＋ New attempt</button></div>${rows}</div>`;
}

function wireAttempts(v) {
  document.getElementById('add-attempt')?.addEventListener('click', async () => {
    try {
      const draft = await api(`/api/tasks/${v.taskId}/attempts`, { method: 'POST', body: '{}' });
      await refreshTasks();
      await openTask(draft.id, 'parameters', true);
      openTaskForm(draft.workflow, draft);
    } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('[data-attempt-select]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.attemptSelect !== v.taskId) openTask(button.dataset.attemptSelect, S.taskTab, true);
  }));
}

async function openTask(taskId, wantTab, explicitAttempt = false) {
  // Leaving another task's page kills its check-in shell (same as closing does).
  if (term && term.taskId !== taskId) { try { term.ws.close(); } catch {} term = null; }
  // Per-task page state starts fresh: the tab comes from the URL when pinned
  // there, else it's auto-picked from the fetched view (defaultTaskTab); the
  // check-in pane re-resolves to the stage's agent.
  S.taskTab = wantTab || null;
  S.checkinSel = null;
  // A repeatable series has no running workflow — open the config page instead
  // (edit its parameters + triggers, see its runs, run again).
  const rec = taskRecord(taskId);
  if (rec?.params?.repeatable) {
    S.selected = taskId;
    S.view = null;
    await renderSeriesPage(rec);
    return;
  }
  S.selected = taskId;
  S.viewingAttempt = explicitAttempt ? taskId : null;
  S.taskEvents = [];
  // Reset the live-output accumulator on task switch. It's only cleared by a
  // turn.result/view.updated event for the *selected* task (see the WS handler),
  // so without this a still-streaming previous task's bubble (e.g. a Merge agent's
  // "let me merge master into this branch") bleeds into THIS page's live bubble
  // until the next event arrives — a stale cross-task render, never in the store/.jsonl.
  S.liveOutput = '';
  // Drop the previous task's view + per-task derived state up front. `S.view` is
  // re-fetched first below, but the siblings (sessions/widgets/paramDefaults) are
  // fetched a few awaits later — so a render firing in that gap (a WS event, a
  // background refresh) would pair the NEW view with the OLD task's fork command /
  // widgets / param defaults. renderTaskPage no-ops while `S.view` is null, and empty
  // siblings render as "no command / no widgets / (default)" — both corrected a beat
  // later by the awaited fetches. Never show another task's data, even for one frame.
  S.view = null;
  S.sessions = {};
  S.widgets = [];
  S.paramDefaults = {};
  S.attemptGroup = null;
  try {
    // Fetch the four independent resources in parallel — they used to be four serial
    // round-trips, which stacked latency (each page open paid the sum, not the max).
    // `renderTaskPage` no-ops while `S.view` is null, so assigning them together (rather
    // than one-at-a-time) also avoids rendering a half-populated page mid-fetch.
    const draft = !!rec?.params?.draft;
    const [view, events, widgets, sessions, attempts] = await Promise.all([
      api(`/api/tasks/${taskId}`),
      draft ? Promise.resolve([]) : api(`/api/tasks/${taskId}/events?since=0`),
      draft ? Promise.resolve([]) : api(`/api/tasks/${taskId}/widgets`).catch(() => []),
      draft ? Promise.resolve({}) : api(`/api/tasks/${taskId}/sessions`).catch(() => ({})),
      api(`/api/tasks/${taskId}/attempts`).catch(() => null),
    ]);
    S.view = view;
    S.taskEvents = events;
    S.widgets = widgets;
    S.sessions = sessions;
    S.attemptGroup = attempts;
    // paramDefaults keys off the fetched view's workflow, so it follows the batch.
    S.paramDefaults = await loadParamDefaults(taskId);
    // The auto tab is resolved ONCE, now that the view is in hand — in the Confirm/
    // Review gate that's Check-in (the conversation that led here is the thing to
    // read); later refreshes never switch tabs under the user.
    if (!S.taskTab) S.taskTab = defaultTaskTab(view);
  } catch (e) { toast(e.message, true); }
  renderTaskPage();
}
async function refreshTask() {
  if (!S.selected) return;
  // The series config page holds an editable form — don't live-refresh it (that
  // would clobber in-progress edits); it re-renders only on open / explicit save.
  if (taskRecord(S.selected)?.params?.repeatable) return;
  try {
    // Parallel refetch (was three serial round-trips). This runs on every `view.updated`
    // WS push for the open task, so keeping it to a single round-trip's latency matters.
    const id = S.selected;
    const [view, widgets, sessions, attempts] = await Promise.all([
      api(`/api/tasks/${id}`),
      api(`/api/tasks/${id}/widgets`).catch(() => S.widgets),
      api(`/api/tasks/${id}/sessions`).catch(() => S.sessions),
      api(`/api/tasks/${id}/attempts`).catch(() => S.attemptGroup),
    ]);
    if (attempts?.principalAttemptId && attempts.principalAttemptId !== id && S.viewingAttempt !== id) {
      await openTask(attempts.principalAttemptId, S.taskTab);
      return;
    }
    S.view = view;
    S.widgets = widgets;
    S.sessions = sessions;
    S.attemptGroup = attempts;
    S.paramDefaults = await loadParamDefaults(id);
  } catch {}
  renderTaskPage();
}
// Close the task page by navigating back to the underlying list/queue; applyRoute()
// then repaints the list. Kept as a navigation so the URL + history stay in sync
// (the ← button, Esc and the palette all route through here).
function closeTask() {
  const pid = (S.view && taskRecord(S.view.taskId)?.projectId) || S.projectId;
  const back = S.returnRoute || (pid ? projectRoute(pid) : globalRoute('dashboard'));
  S.returnRoute = null;
  return go(back, { replace: true });
}
// Drop the open task's page state without navigating (called by applyRoute()).
function closeTaskDom() {
  if (!S.selected && !S.view) return;
  S.selected = null;
  S.viewingAttempt = null;
  S.view = null;
  S.attemptGroup = null;
  S.taskTab = null;
  S.checkinSel = null;
  S.liveOutput = ''; // drop any streamed live text so it can't reappear on the next task page
  S.sessions = {}; S.widgets = []; S.paramDefaults = {}; // per-task derived state — don't carry into the next page
  if (term && term.ws) { try { term.ws.close(); } catch {} term = null; } // leaving the page kills the check-in shell
}

// A task's organizational metadata (priority + tags). Both are purely for
// search/organization and never reach the agent, so they're editable at any
// lifecycle stage (draft included) — unlike workflow params. Shared by the task
// page's Parameters tab (running tasks) and the task form (drafts).
function orgEditorHtml(rec) {
  const prio = Number(rec?.params?.priority || 0);
  const tags = (rec?.tags || []).map((id) => { const t = tagById(id); if (!t) return ''; return `<span class="tag-chip ${t.kind || ''}" ${t.color ? `style="--tag:${esc(t.color)}"` : ''} data-untag="${id}" title="Remove">${esc(tagPathStr(id))} ✕</span>`; }).join('');
  const prioOpts = PRIORITY_NAMES.map((n, i) => `<option value="${i}" ${i === prio ? 'selected' : ''}>${i ? '▲ ' : ''}${n[0].toUpperCase() + n.slice(1)}</option>`).join('');
  return `<div class="org-editor">
    <label class="org-prio">Priority
      <select class="q-sel org-priority">${prioOpts}</select>
    </label>
    <div class="org-tags">${tags || '<span class="pal-sub">no tags</span>'}
      <button class="btn sm org-add-tag" title="Add a tag">＋ tag</button>
    </div>
  </div>`;
}

// Wire the priority/tags editor rooted at `rootEl` over a mutable `rec` ({id, params, tags}).
// `opts.ensureId()` resolves the task id (task page/existing draft: identity; NEW task form:
// persists a draft first so tags/priority have somewhere to attach), and `opts.afterChange`
// re-renders the surrounding surface. There is exactly one `.org-editor` per surface.
// Callers: renderTaskPage (running tasks) and openTaskForm (new + draft) — keep both in mind.
function wireOrgEditor(rootEl, rec, opts) {
  const box = rootEl.querySelector('.org-editor');
  if (!box) return;
  const ensureId = opts.ensureId || (async () => rec.id);
  const afterChange = opts.afterChange || (() => {});
  box.querySelector('.org-priority')?.addEventListener('change', async (e) => {
    const priority = Number(e.target.value);
    try {
      const id = await ensureId(); if (!id) return;
      rec.id = id;
      await api(`/api/tasks/${id}/priority`, { method: 'PUT', body: JSON.stringify({ priority }) });
      rec.params = { ...(rec.params || {}), priority };
      if (S.tab === 'tasks') await runSearch();
      afterChange();
      toast('Priority updated');
    } catch (err) { toast(err.message, true); }
  });
  const setTags = async (ids) => {
    const id = await ensureId(); if (!id) return;
    rec.id = id;
    const r = await api(`/api/tasks/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tagIds: ids }) });
    rec.tags = r.tags;
    if (S.tab === 'tasks') await runSearch();
    afterChange();
  };
  box.querySelectorAll('[data-untag]').forEach((el) => el.addEventListener('click', () => {
    setTags((rec.tags || []).filter((id) => id !== el.dataset.untag)).catch((e) => toast(e.message, true));
  }));
  box.querySelector('.org-add-tag')?.addEventListener('click', () => openTagPicker(rec, setTags));
}

// The task page's copy of the priority/tags editor (Parameters tab). NOTE: the task
// FORM (openTaskForm) has the other copy — both share orgEditorHtml/wireOrgEditor;
// change one, check the other.
function wireTaskOrg(v) {
  const rec = taskRecord(v.taskId);
  if (!rec) return;
  wireOrgEditor($('#main'), rec, { ensureId: async () => v.taskId, afterChange: renderTaskPage });
}

// Type-to-add tag combobox: filter existing tags as you type; a non-matching entry
// offers "Create …". Supports slash paths (frontend/web) — the server builds the
// hierarchy. Arrow keys navigate, Enter picks the highlighted row.
function openTagPicker(rec, setTags) {
  const root = $('#modal-root');
  const current = new Set(rec?.tags || []);
  let items = [];
  let active = 0;
  root.innerHTML = `<div class="palette-scrim" id="tp-scrim"><div class="palette fp">
    <input id="tp-in" placeholder="Type a tag…  use / for nesting (e.g. frontend/web)" autocomplete="off" spellcheck="false" />
    <div id="tp-list"></div>
  </div></div>`;
  const input = $('#tp-in');
  const list = $('#tp-list');
  const close = () => (root.innerHTML = '');
  const add = async (item) => {
    if (!item) return;
    try {
      let id = item.id;
      if (item.create) {
        const t = await api(`/api/projects/${S.projectId}/tags`, { method: 'POST', body: JSON.stringify({ name: item.name }) });
        await loadOrg();
        id = t.id;
      }
      close();
      await setTags([...(rec?.tags || []), id]);
    } catch (e) { toast(e.message, true); }
  };
  const build = () => {
    const q = input.value.trim();
    const ql = q.toLowerCase();
    const avail = S.tags.filter((t) => !current.has(t.id));
    items = avail
      .map((t) => ({ id: t.id, name: t.name, path: tagPathStr(t.id), kind: t.kind }))
      .filter((it) => !ql || it.path.toLowerCase().includes(ql))
      .sort((a, b) => a.path.localeCompare(b.path));
    // Offer creation when the typed text doesn't already exist verbatim as a path.
    const exists = q && S.tags.some((t) => tagPathStr(t.id).toLowerCase() === ql);
    if (q && !exists) items.unshift({ create: true, name: q, path: q });
    active = 0;
    draw();
  };
  const draw = () => {
    list.innerHTML = items.length
      ? items.map((it, i) => `<div class="opt ${i === active ? 'active' : ''}" data-i="${i}">${it.create ? `＋ Create <b>${esc(it.path)}</b>` : esc(it.path)}${!it.create && it.kind ? ` <span class="pal-sub">${esc(it.kind)}</span>` : ''}</div>`).join('')
      : `<div class="pal-empty">Start typing to create a tag.</div>`;
    list.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' });
  };
  $('#tp-scrim').addEventListener('click', (e) => { if (e.target.id === 'tp-scrim') close(); });
  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); add(items[active]); }
  });
  list.addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) add(items[Number(o.dataset.i)]); });
  build();
  input.focus();
}

function renderTaskPage() {
  const v = S.view;
  const main = $('#main');
  if (!v || !main) return;
  if (!S.taskTab) S.taskTab = defaultTaskTab(v); // resolved once at open; never auto-switches under the user
  const tab = S.taskTab;
  // A background refresh (or a just-sent follow-up) re-renders the whole page,
  // which would otherwise reset the scroll and drop the caret out of whatever
  // follow-up box the user is composing in. Snapshot the scroll offsets + focused
  // field first, then restore them after the swap — but only when the SAME tab is
  // being repainted (switching tabs should land at a fresh top/bottom).
  const prevBody = document.getElementById('tp-body');
  const sameTab = !!(prevBody && prevBody.dataset.tab === tab);
  const prevScroll = sameTab ? prevBody.scrollTop : null;
  const prevThread = sameTab ? document.getElementById('ck-thread') : null;
  // A conversation pins to the bottom (latest message) — keep it pinned across
  // re-renders unless the user has scrolled up to read history.
  const threadScroll = prevThread
    ? { top: prevThread.scrollTop, atBottom: prevThread.scrollHeight - prevThread.scrollTop - prevThread.clientHeight < 40 }
    : null;
  // A background re-render (WS event while an agent streams) rebuilds the whole
  // pane, which would drop any text the user has selected in the transcript.
  // Snapshot the selection as character offsets and re-apply it after the swap —
  // the same treatment scroll/focus already get.
  const threadSel = prevThread ? captureThreadSelection(prevThread) : null;
  const focusState = captureFocus(main);
  // The per-agent follow-up textareas carry no id (captureFocus skips them), so
  // snapshot the active one by its agent role to re-focus the matching box after
  // the swap and carry over any half-typed follow-up.
  const fuState = captureFollowupFocus(main);
  const rec = taskRecord(v.taskId);
  const currentAttempt = S.attemptGroup?.attempts?.find((a) => a.id === v.taskId);
  const base = taskUrl(v.taskId);
  main.innerHTML = `
    <div class="task-page">
      <div class="tp-head">
        <div class="row1">
          <button class="icon-btn" id="tp-back" title="Back to the list (Esc)">←</button>
          ${v.num != null ? `<span class="task-num" title="Task #${v.num} — permalink ${esc(base)}">#${v.num}</span>` : ''}
          <h2>${esc(v.title)}</h2>
          ${currentAttempt ? `<span class="chip attempt-current">Attempt ${currentAttempt.attemptNumber || 1} of ${S.attemptGroup.attempts.length}</span>` : ''}
          <span class="chip ${v.status}">${esc(stageLabel(v))}</span>
        </div>
        <div class="meta">
          <span>${esc(v.workflow)}${rec?.workflowVersion ? ` <span class="mono" style="color:var(--ink-3)">v${esc(rec.workflowVersion)}</span>` : ''}</span>
          ${customBranch(v, v.taskId) ? `<span>⎇ ${esc(v.branch)}</span>` : ''}
          ${v.targetBranch ? `<span>→ ${esc(v.targetBranch)}</span>` : ''}
          ${v.mergeQueue ? `<span>queue #${v.mergeQueue.position}/${v.mergeQueue.total}</span>` : ''}
          ${rec ? orgEditorHtml(rec) : ''}
        </div>
        ${taskAttempts(v)}
        <div class="tabs tp-tabs">
          ${TASK_TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" data-tasktab="${t.key}" href="${esc(base)}/${t.key}">${t.label}</a>`).join('')}
        </div>
      </div>
      <div class="tp-body" id="tp-body" data-tab="${tab}" tabindex="-1"><div class="tp-content">${taskTabBody(v, tab)}</div></div>
      <div class="tp-foot" id="tp-foot"><div class="tp-foot-inner">${taskActions(v)}</div></div>
    </div>`;
  $('#tp-back').addEventListener('click', closeTask);
  // The tabs are real links (Ctrl/⌘-click or middle-click opens the pinned tab in
  // a new browser tab); a plain click switches in place without a refetch.
  main.querySelectorAll('[data-tasktab]').forEach((a) =>
    a.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return; // the browser handles new-tab/new-window opens
      e.preventDefault();
      setTaskTab(a.dataset.tasktab);
    }),
  );
  wireAttempts(v);
  wireActions(v); // the footer action bar lives on every tab
  wireTaskOrg(v); // priority/tags editor lives in the header now — present on every tab
  if (tab === 'overview') {
    wireNotes(v);
    wireReviewActions(v);
  } else if (tab === 'checkin') {
    wireCheckinSidebar(v);
    wireFollowups(v);
    wireTerminal(v.taskId);
  } else if (tab === 'parameters') {
    wireParams(v);
    renderCredentialEditor($('#cred-editor-task'), 'task', { projectId: rec?.projectId || S.projectId, taskId: v.taskId });
  } else if (tab === 'advanced') {
    renderTaskEvents();
  }
  wireCopyButtons();
  // Restore the pre-render scroll offsets + focus so the box the user was working
  // in stays put instead of jumping away.
  const newBody = document.getElementById('tp-body');
  if (newBody && prevScroll != null) newBody.scrollTop = prevScroll;
  const thread = document.getElementById('ck-thread');
  if (thread) thread.scrollTop = threadScroll && !threadScroll.atBottom ? threadScroll.top : thread.scrollHeight;
  if (thread) {
    restoreThreadSelection(thread, threadSel);
    wireMessageCopies(thread);
    typesetMath(thread);
  }
  restoreFocus(main, focusState);
  restoreFollowupFocus(main, fuState);
  // The scrollable body is the page's own scroll container (the app shell is
  // overflow:hidden), so PgUp/PgDn/Home/End/space/arrows only scroll it while it
  // holds focus. Focus it on open — and keep it focused across the background
  // re-renders — so the page is keyboard-scrollable the moment it appears. On the
  // Check-in tab the conversation thread is the scroller, not the (fixed) body.
  const scroller = thread || newBody;
  const overlayOpen = $('#overlay-root')?.childElementCount > 0 || $('#modal-root')?.childElementCount > 0;
  if (scroller && shouldFocusTaskBody(main, document.activeElement, overlayOpen)) scroller.focus({ preventScroll: true });
}

// A text walker over the thread that ignores math (its raw `$…$` is replaced by
// MathJax SVG + hidden MathML asynchronously, so counting it would make the
// before/after offsets disagree). Skipping it keeps the character map stable
// regardless of typeset state.
function threadTextWalker(thread) {
  return document.createTreeWalker(thread, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement && node.parentElement.closest('.md-math, mjx-container'))
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  });
}

// The transcript's text selection, captured as absolute character offsets into
// the thread's concatenated text so it can survive a full innerHTML rebuild
// (the new nodes are different objects; offsets aren't). Returns null when there
// is no live selection inside the thread.
function captureThreadSelection(thread) {
  const sel = window.getSelection && window.getSelection();
  if (!thread || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!thread.contains(range.startContainer) || !thread.contains(range.endContainer)) return null;
  const offsetOf = (node, off) => {
    const walker = threadTextWalker(thread);
    let total = 0, n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + off;
      total += n.nodeValue.length;
    }
    return total;
  };
  return { start: offsetOf(range.startContainer, range.startOffset), end: offsetOf(range.endContainer, range.endOffset) };
}

function restoreThreadSelection(thread, snap) {
  if (!thread || !snap) return;
  const locate = (target) => {
    const walker = threadTextWalker(thread);
    let total = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (total + len >= target) return { node: n, offset: target - total };
      total += len;
    }
    return n ? { node: n, offset: n.nodeValue.length } : null;
  };
  const a = locate(snap.start);
  const b = locate(snap.end);
  if (!a || !b) return;
  try {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}

// Switch the open task page to another of its tabs, pinning the tab in the URL
// (replace, not push — Back should leave the task, not walk through its tabs).
function setTaskTab(key) {
  if (!TASK_TABS.some((t) => t.key === key) || S.taskTab === key) return;
  S.taskTab = key;
  if (S.selected) history.replaceState({}, '', `${taskUrl(S.selected)}/${key}`);
  renderTaskPage();
}

// Cycle the open task page's tabs ([ and ]), wrapping at the ends.
function cycleTaskTab(delta) {
  const i = Math.max(0, TASK_TABS.findIndex((t) => t.key === S.taskTab));
  setTaskTab(TASK_TABS[(i + delta + TASK_TABS.length) % TASK_TABS.length].key);
}

function taskTabBody(v, tab) {
  if (tab === 'checkin') return checkinTab(v);
  if (tab === 'parameters') return parametersTab(v);
  if (tab === 'advanced') return advancedTab(v);
  return overviewTab(v);
}

// Whether renderTaskPage should hand keyboard focus to the scrollable page body.
// Yes on a fresh open (focus on <body> / nowhere) and to keep it across re-renders;
// never steal it from a field the user is in (composer/notes/params/terminal) or
// from an overlay/modal stacked above the page.
function shouldFocusTaskBody(root, active, overlayOpen) {
  if (overlayOpen) return false;
  if (!active || active === document.body) return true; // fresh open: nothing focused
  if (!root.contains(active)) return false; // focus lives outside the page (e.g. an overlay)
  if (active.matches?.('input, textarea, select') || active.isContentEditable || active.classList?.contains('term-screen')) return false;
  return true; // focus is the page body itself (or a non-field) — keep/take it
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
  // The compose box scrolls internally once the draft spills past its height; a
  // fresh textarea starts at the top, so snapshot the scroll offset to restore.
  st.scrollTop = el.scrollTop;
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
  // preventScroll: re-focusing the box must never scroll the conversation — that
  // caused the box to jump to the top of the thread on every background refresh.
  el.focus({ preventScroll: true });
  if (typeof st.selectionStart === 'number' && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(st.selectionStart, st.selectionEnd); } catch {}
  }
  // Put the caret's line back into view inside the textarea (focus + selection
  // alone don't restore a multi-line box's own scroll in every browser).
  if (typeof st.scrollTop === 'number') el.scrollTop = st.scrollTop;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

// ── check-in terminal: a real PTY streamed over a WebSocket ──────────────────
// The session outlives page re-renders and tab/pane switches (which rebuild the
// DOM), so it lives in module state and rebinds to the freshly-rendered <pre>
// each time. `makeTermScreen` is a tiny terminal emulator that turns the PTY byte
// stream — echo, backspace, cursor moves, line erases — into displayable text,
// so the user can type STRAIGHT into the terminal (Ctrl-C and friends included)
// without pulling in a heavyweight emulator like xterm.js (which would break the
// no-build-step, offline console this app is built around).
let term = null; // { taskId, ws, screen } while a session is live; null otherwise

function termIsOpenFor(taskId) {
  return !!(term && term.taskId === taskId && term.ws && term.ws.readyState <= 1);
}

// Minimal line-oriented emulator: enough to render an interactive shell's echo,
// backspace, history recall and Ctrl-C cleanly. Full-screen TUIs (vim, htop) use
// absolute cursor positioning we intentionally ignore — those genuinely need a
// full emulator; a line-mode check-in terminal doesn't.
function makeTermScreen(maxLines = 2000) {
  let lines = [''];
  let row = 0, col = 0;
  const ensureRow = () => { while (lines.length <= row) lines.push(''); };
  const put = (i, ch) => {
    let line = lines[row];
    if (line.length < i) line += ' '.repeat(i - line.length);
    lines[row] = line.slice(0, i) + ch + line.slice(i + 1);
  };
  function csi(final, params) {
    const n = parseInt(params, 10);
    const num = Number.isNaN(n) ? (final === 'K' || final === 'J' ? 0 : 1) : n;
    ensureRow();
    const line = lines[row];
    switch (final) {
      case 'C': col += num; break;                                      // cursor right
      case 'D': col = Math.max(0, col - num); break;                    // cursor left
      case 'G': col = Math.max(0, num - 1); break;                      // cursor to column
      case 'K':                                                          // erase in line
        lines[row] = num === 1 ? ' '.repeat(col) + line.slice(col) : num === 2 ? '' : line.slice(0, col);
        break;
      case 'P': lines[row] = line.slice(0, col) + line.slice(col + num); break; // delete chars
      case 'J':                                                          // erase display
        if (num >= 2) { lines = ['']; row = 0; col = 0; }
        else { lines[row] = line.slice(0, col); lines = lines.slice(0, row + 1); }
        break;
      default: break;                                                    // ignore the rest (cursor up/down, SGR colors, …)
    }
  }
  function write(data) {
    for (let k = 0; k < data.length; k++) {
      const ch = data[k];
      if (ch === '\x1b') {
        if (data[k + 1] === '[') {                                       // CSI — read params until the final byte
          let j = k + 2, params = '';
          while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) params += data[j++];
          csi(data[j], params);
          k = j;
        } else if (data[k + 1] === ']') {                               // OSC — skip to BEL or ST
          let j = k + 2;
          while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++;
          k = data[j] === '\x1b' ? j + 1 : j;
        } else { k++; }                                                  // 2-char escape — skip the pair
        continue;
      }
      if (ch === '\r') { col = 0; continue; }
      if (ch === '\n') { row++; ensureRow(); continue; }
      if (ch === '\b') { if (col > 0) col--; continue; }
      const code = data.charCodeAt(k);
      if (code < 32 || code === 127) continue;                          // drop other control chars (bell, etc.)
      ensureRow();
      put(col, ch);
      col++;
    }
    if (lines.length > maxLines) {                                       // bound scrollback memory
      const drop = lines.length - maxLines;
      lines.splice(0, drop);
      row = Math.max(0, row - drop);
    }
  }
  // render() joins the authoritative buffer; an optional `pending` string is the
  // predicted (locally-echoed, not-yet-confirmed) tail — overlaid at the cursor
  // without mutating the buffer, so the next server byte reconciles cleanly.
  return {
    write,
    cursor: () => ({ row, col }),
    render: (pending = '') => {
      if (!pending) return lines.join('\n');
      const out = lines.slice();
      let line = out[row] ?? '';
      if (line.length < col) line += ' '.repeat(col - line.length);
      out[row] = line.slice(0, col) + pending + line.slice(col + pending.length);
      return out.join('\n');
    },
  };
}

// Predictive local echo (mosh-style, conservative). Typing into a cloud world's
// PTY costs a full network round-trip before the remote shell echoes the char
// back, so without prediction every keystroke feels laggy. We optimistically
// render printable characters the instant they're typed (`term.pending`), then
// reconcile against the authoritative server stream: each echoed printable byte
// confirms and drops one predicted char; anything unexpected (an escape sequence,
// a mismatch — completion, prompt redraw, program output) discards the whole
// prediction and lets the server drive. Non-printable keys (Enter, arrows, Tab,
// Ctrl-*) can't be predicted safely, so they clear pending and defer to the shell.
function predictInput(bytes, ctrl) {
  if (!term) return;
  if (!ctrl && bytes.length === 1 && bytes >= ' ' && bytes !== '\x7f') {
    term.pending += bytes;                       // printable → echo locally now
  } else if (bytes === '\x7f' && term.pending) {
    term.pending = term.pending.slice(0, -1);    // backspace an unconfirmed char
  } else {
    term.pending = '';                           // Enter/arrows/Tab/Ctrl-* → server drives
  }
}

// Consume the server's echo of characters we already predicted, so they don't
// render twice. Stops (and discards remaining predictions) on the first byte that
// doesn't match — the server is authoritative from that point on.
function reconcilePrediction(data) {
  if (!term || !term.pending) return;
  for (let i = 0; i < data.length && term.pending; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === '\x1b') { term.pending = ''; return; }   // escape/redraw → drop predictions
    if (code < 32 || code === 127) continue;            // ignore CR/LF/other controls
    if (ch === term.pending[0]) term.pending = term.pending.slice(1); // confirmed
    else { term.pending = ''; return; }                 // mismatch → server wins
  }
}

// Translate a browser keydown into the bytes a PTY expects. Returns null to let
// the browser keep the event (copy/paste shortcuts, unhandled combos).
function keyToPtyBytes(e) {
  if (e.altKey || e.metaKey) return null;
  const k = e.key;
  if (e.ctrlKey) {
    if (e.shiftKey) return null;                                        // Ctrl+Shift+C/V → let the browser copy/paste
    if (/^[a-zA-Z]$/.test(k)) return String.fromCharCode(k.toLowerCase().charCodeAt(0) - 96); // ^A..^Z, incl. Ctrl-C (^C = \x03)
    if (k === ' ') return '\x00';
    return null;
  }
  switch (k) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Tab': return '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'Delete': return '\x1b[3~';
    default: return k.length === 1 ? k : null;                          // a printable char, else ignore
  }
}

// Point the (freshly rendered) <pre> at the live session: repaint the buffer,
// stream new bytes into it, and forward keystrokes/paste straight to the PTY.
function bindTermScreen(out) {
  if (!term || !out) return;
  out.classList.remove('hidden');
  const repaint = () => { out.textContent = term.screen.render(term.pending); out.scrollTop = out.scrollHeight; };
  repaint();
  const ws = term.ws;
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.type === 'data') { reconcilePrediction(msg.data); term.screen.write(msg.data); repaint(); }
    } catch {}
  };
  const send = (data) => { if (term && term.ws && term.ws.readyState === 1) term.ws.send(JSON.stringify({ type: 'input', data })); };
  out.onkeydown = (e) => {
    // Esc leaves the terminal (blurs it) so app keyboard shortcuts work again —
    // like tabbing out of a textarea. It is NOT forwarded to the shell.
    if (e.key === 'Escape') { e.preventDefault(); out.blur(); return; }
    const bytes = keyToPtyBytes(e);
    if (bytes == null) return;                                          // leave copy/paste, F-keys, etc. to the browser
    e.preventDefault();
    e.stopPropagation();                                                // consumed by the shell — never let it trigger an app shortcut
    send(bytes);
    predictInput(bytes, e.ctrlKey);                                     // optimistic local echo — hides the round-trip on cloud worlds
    repaint();
  };
  out.onpaste = (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text) return;
    e.preventDefault();
    send(text);
    term.pending = '';                                                  // multi-line paste: let the shell echo authoritatively
    repaint();
  };
}

function openTerminal(taskId) {
  if (term && term.ws) { try { term.ws.close(); } catch {} }           // one check-in shell at a time
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?taskId=${encodeURIComponent(taskId)}${S.token ? `&token=${encodeURIComponent(S.token)}` : ''}`);
  term = { taskId, ws, screen: makeTermScreen(), pending: '' };
  ws.onclose = () => {
    if (!term || term.ws !== ws) return;                               // superseded by a newer session
    term.pending = '';
    term.screen.write('\r\n[terminal closed]\r\n');
    const out = document.getElementById('term-out');
    if (out) out.textContent = term.screen.render();
    term = null;
    syncTermButton();
  };
  bindTermScreen(document.getElementById('term-out'));
  const out = document.getElementById('term-out');
  if (out) out.focus();
  syncTermButton();
}

// Killing the terminal is just closing the socket: the gateway's ws-close handler
// kills the PTY's whole session — the shell AND every process running in it (see
// killPtySession in src/gateway/server.ts).
function killTerminal() {
  if (term && term.ws) { try { term.ws.close(); } catch {} }
}

function syncTermButton() {
  const live = !!(term && term.ws && term.ws.readyState <= 1);
  // The check-in sidebar's Terminal entry carries a live dot mirroring the session.
  document.querySelector('#ck-term-item .ck-live')?.classList.toggle('hidden', !live);
  const btn = document.getElementById('term-open');
  if (!btn) return;
  const hasWorld = btn.dataset.hasWorld === '1';
  if (live) {
    btn.textContent = 'Kill terminal';
    btn.classList.add('danger');
    btn.disabled = false;
  } else {
    btn.classList.remove('danger');
    btn.textContent = hasWorld ? 'Open terminal' : 'No world yet';
    btn.disabled = !hasWorld;
  }
}

function wireTerminal(taskId) {
  const btn = document.getElementById('term-open');
  if (!btn) return;
  btn.dataset.hasWorld = btn.disabled ? '0' : '1';                     // capture world presence before we mutate the label
  if (termIsOpenFor(taskId)) bindTermScreen(document.getElementById('term-out'));  // reattach a session that outlived the re-render
  else if (term && term.taskId !== taskId) { try { term.ws.close(); } catch {} term = null; } // switched tasks → drop the old shell
  syncTermButton();
  btn.addEventListener('click', () => {
    if (termIsOpenFor(taskId)) killTerminal();
    else { document.getElementById('ck-term-hint')?.remove(); openTerminal(taskId); }
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
        const ws = new WebSocket(`${proto}://${location.host}/ws/review-action?procId=${encodeURIComponent(r.procId)}${S.token ? `&token=${encodeURIComponent(S.token)}` : ''}`);
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

// ── the four task-page tabs ───────────────────────────────────────────────────
// Overview: what the task IS and where it stands — pipeline, review, widgets,
// sub-tasks, notes. Everything shown comes off the workflow's declared view.
function overviewTab(v) {
  const caption = v.reviewInfo?.caption || v.reviewInfo?.summary;
  // How the agent's turn reached Review. Current workflows use `finished` only after a
  // verified successful provider terminal event. `stalled` remains for legacy histories.
  const completionBadge = v.reviewInfo?.completion === 'stalled'
    ? `<div class="summary" style="color:var(--warn,#c60);font-weight:600">⚠ Agent stopped without signalling completion — work may be incomplete; verify before confirming.</div>`
    : v.reviewInfo?.completion === 'signalled'
      ? `<div class="task-sub" style="color:var(--ink-3);margin:0 0 6px">✓ Agent signalled completion</div>`
      : v.reviewInfo?.completion === 'finished'
        ? `<div class="task-sub" style="color:var(--ink-3);margin:0 0 6px">✓ Agent turn completed successfully</div>`
      : v.reviewInfo?.completion === 'raised'
        ? `<div class="task-sub" style="color:var(--ink-3);margin:0 0 6px">↑ Agent raised for a decision</div>`
        : '';
  const review = v.reviewInfo
    ? `<div class="section-h">Review</div>
       <div class="review">
         ${completionBadge}
         ${caption ? `<div class="summary">${esc(caption)}</div>` : ''}
         ${v.reviewInfo.actions?.length ? `<div class="review-actions" id="review-actions">${v.reviewInfo.actions.map((a, i) => reviewActionBtn(a, i)).join('')}</div>
         <pre class="raw hidden" id="review-action-out" style="height:180px"></pre>` : ''}
         ${v.reviewInfo.links?.length ? `<div class="links">${v.reviewInfo.links.map((l) => `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>` : ''}
         ${v.reviewInfo.html ? `<iframe sandbox="allow-scripts" srcdoc="${esc(v.reviewInfo.html)}"></iframe>` : ''}
       </div>`
    : '';
  const error = v.error ? `<div class="section-h">Error</div><div class="diff del">${esc(v.error)}</div>` : '';
  const waiting = v.waitingFor
    ? `<div class="section-h">Waiting</div><div class="card" style="color:var(--ink-2)">⏳ Waiting for ${esc(waitingLabel(v.waitingFor))}${v.waitingFor.earliestResetAt ? ` · earliest ${esc(fmtReset(v.waitingFor.earliestResetAt))}` : ''}</div>`
    : '';
  const agentTurn = v.agentTurn
    ? `<div class="section-h">Agent turn</div><div class="card" style="color:var(--ink-2)">${v.agentTurn.state === 'running' ? '▶' : '⏳'} ${esc(v.agentTurn.role)} agent · ${v.agentTurn.state === 'running' ? 'running' : 'waiting for a host slot'}${v.agentTurn.provider ? ` · ${esc(v.agentTurn.provider)}` : ''}</div>`
    : '';
  const subtasks = v.subTasks?.length
    ? `<div class="section-h">Sub-tasks</div>${v.subTasks.map((id) => `<div class="task-sub"><a class="branch sub-open" data-spa href="${taskUrl(id)}" style="cursor:pointer">↳ ${esc(numLabel(id))}</a></div>`).join('')}`
    : '';
  return `
    <div class="section-h">Pipeline</div>
    ${pipelineLarge(v)}
    ${error}
    ${waiting}
    ${agentTurn}
    ${review}
    ${renderWidgetGroups(S.widgets)}
    ${subtasks}
    ${notesSection(v)}`;
}

// Check-in: talking to the task — every agent's conversation (Do / Merge /
// Merge, SPEC §5.5/§5.6) plus the ephemeral terminal, behind a small sidebar.
// Falls back to `messages` (Do) for workflows that predate per-role transcripts.
function taskTranscripts(v) {
  return (v.transcripts && v.transcripts.length)
    ? v.transcripts.filter((t) => S.meta?.resolveAgentEnabled || t.role !== 'resolve')
    : [{ role: 'do', label: 'Conversation', messages: v.messages || [] }];
}
// The conversation owning the active stage — it gets the live bubble and is the
// default pane (in Review that's the agent whose work is being reviewed).
function liveRoleFor(v) {
  const transcripts = taskTranscripts(v);
  const activeRole = roleForStage(v.stage);
  return transcripts.some((t) => t.role === activeRole) ? activeRole : transcripts[0]?.role;
}
// The selected check-in pane: the user's explicit choice while it still exists,
// else the stage's own conversation.
function checkinSelection(v) {
  if (S.checkinSel === 'terminal') return 'terminal';
  if (S.checkinSel && taskTranscripts(v).some((t) => t.role === S.checkinSel)) return S.checkinSel;
  return liveRoleFor(v);
}

// Return the adjacent sidebar key with wraparound. Kept pure so the keyboard
// navigation behavior is easy to verify independently of rendering.
function adjacentCheckinPane(panes, current, delta) {
  if (!panes.length) return null;
  const i = panes.indexOf(current);
  const at = i < 0 ? (delta > 0 ? -1 : 0) : i;
  return panes[(at + delta + panes.length) % panes.length];
}

function selectCheckinPane(v, key, openShell = false) {
  if (!key) return;
  const changed = key !== checkinSelection(v);
  S.checkinSel = key;
  if (changed) renderTaskPage();
  // Selecting the sidebar's "Open terminal" action is deliberately enough to
  // start the PTY; no second click inside the terminal pane is required.
  if (openShell && key === 'terminal' && (v.worldAvailable || v.worldPath) && !termIsOpenFor(v.taskId)) {
    document.getElementById('ck-term-hint')?.remove();
    openTerminal(v.taskId);
  }
}

function cycleCheckinPane(delta) {
  const v = S.view;
  if (!v || S.taskTab !== 'checkin') return;
  const panes = [...taskTranscripts(v).map((t) => t.role), 'terminal'];
  const key = adjacentCheckinPane(panes, checkinSelection(v), delta);
  selectCheckinPane(v, key, key === 'terminal');
}

function checkinTab(v) {
  const transcripts = taskTranscripts(v);
  const sel = checkinSelection(v);
  const liveRole = liveRoleFor(v);
  const items = transcripts
    .map((t) => `<div class="ck-item ${sel === t.role ? 'sel' : ''}" data-checkin="${esc(t.role)}">
        <span class="ck-name">${esc(t.label || t.role)}</span>
        ${t.role === liveRole && v.status === 'active' ? '<span class="ck-live" title="agent working"></span>' : ''}
        <span class="ck-count">${conversationEntries(t).length}</span>
      </div>`)
    .join('');
  const hasWorld = !!(v.worldAvailable || v.worldPath);
  return `<div class="ck-layout">
    <div class="ck-side">
      <div class="ck-side-h">Agents</div>
      ${items}
      <div class="ck-side-h">Shell</div>
      <div class="ck-item ck-terminal-item ${sel === 'terminal' ? 'sel' : ''}" id="ck-term-item">
        <button class="ck-terminal-open" data-checkin="terminal" data-open-terminal="1" ${hasWorld ? '' : 'disabled'} title="${hasWorld ? 'Open a terminal in this task world' : 'No world yet'}">
          <span class="ck-name">${hasWorld ? 'Open terminal' : 'No world yet'}</span>
          <span class="ck-live ${termIsOpenFor(v.taskId) ? '' : 'hidden'}" title="shell running"></span>
        </button>
        ${v.worldPath ? `<button class="ck-terminal-copy copy-cmd" data-cmd="${esc(`cd ${v.worldPath} && $SHELL`)}" data-copy-icon="1" title="Copy terminal command" aria-label="Copy terminal command">${ICON.copy}</button>` : ''}
      </div>
    </div>
    <div class="ck-pane">${sel === 'terminal' ? terminalPane(v) : conversationPane(v, transcripts.find((t) => t.role === sel))}</div>
  </div>`;
}

function conversationPane(v, t) {
  if (!t) return '<div class="empty"><div class="big">No conversations yet</div>Agents appear here once the workflow starts one.</div>';
  const entries = conversationEntries(t);
  const msgs = entries.map(renderConversationEntry).join('') || '<div class="msg system">No messages yet</div>';
  // Only the stage's own conversation gets the #live-bubble (one per page,
  // updated by the WS stream).
  const hasStructuredMessages = entries.some((entry) => entry.type === 'activity' && entry.activity.kind === 'message');
  const live = t.role === liveRoleFor(v) && !hasStructuredMessages
    ? `<div class="msg agent ${S.liveOutput && v.status === 'active' ? '' : 'hidden'}" id="live-bubble"><div class="role">agent · live</div>${esc(S.liveOutput)}</div>`
    : '';
  // Only subscription/CLI sessions carry a config home; API-key / stateless
  // sessions can't be forked from a terminal, so no command is shown. The session
  // id is published mid-turn (#3), so this appears WHILE the agent runs.
  const sess = S.sessions && S.sessions[t.role];
  const forkCmd = sess?.id && sess?.home && v.worldPath ? forkCommandFor(sess, v.worldPath) : '';
  const remoteFork = sess?.id && sess?.home && v.worldAvailable && !v.worldPath && !v.agentTurn && !S.meta?.hosted;
  const copy = forkCmd
    ? `<button class="btn sm copy-cmd" data-cmd="${esc(forkCmd)}" title="Copy a CLI command to fork this agent into your terminal — a branched copy, safe to open even while it's running">⑂ fork cmd</button>`
    : remoteFork
      ? `<button class="btn sm fork-local" data-provider="${esc(sess.provider)}" data-session="${esc(sess.id)}" data-home="${esc(sess.home)}" title="Materialize the cloud branch locally, then copy a native session-fork command">⑂ fork locally</button>`
      : '';
  // The follow-up affordance (SPEC §5.6) lives inside each agent's conversation,
  // so a human can address any agent — Do, Merge, or Confirm — not just Do. It
  // appears only when the workflow currently allows follow-ups.
  const agentName = esc(t.label || t.role);
  const presence = conversationPresence(v, t);
  const followUp = (v.actions || []).find((a) => a.name === 'followUp');
  const draft = (S.followupDrafts || {})[`${v.taskId}/${t.role}`] || '';
  const fu = followUp
    ? `<div class="ck-compose"><div class="followup-box" data-role="${esc(t.role)}">
        <div class="prompt-field">
          <textarea class="followup-input" placeholder="Send a follow-up to ${agentName} (paste an image to attach, type @ to add context from the wiki)" ${followUp.enabled ? '' : 'disabled'}>${esc(draft)}</textarea>
          <div class="img-chips followup-chips" style="display:none"></div>
        </div>
        <button class="btn primary followup-send" ${followUp.enabled ? '' : 'disabled'}>Send</button>
      </div></div>`
    : '';
  return `
    <div class="ck-pane-head">
      <b>${agentName}</b>
      <span class="conversation-presence ${presence.tone}"><span class="presence-dot"></span>${esc(presence.label)}</span>
      <span class="pal-sub">${entries.length} item${entries.length === 1 ? '' : 's'}</span>
      <span style="flex:1"></span>
      ${copy}
    </div>
    <div class="ck-thread" id="ck-thread" tabindex="-1"><div class="thread">${msgs}${live}</div></div>
    ${fu}`;
}

// The provider stream is an ordered item timeline (Codex ThreadItems / Claude
// SDK messages), while `messages` remains the clean model-input transcript. Merge
// the two only for presentation. Activity updates with the same provider item id
// replace in place, so a command is one row that moves running → completed rather
// than two noisy rows.
function conversationEntries(t) {
  const updates = (S.taskEvents || []).filter((event) => event.type === 'agent.activity' && event.payload?.role === t.role);
  const activities = new Map();
  for (const event of updates) {
    const activity = event.payload || {};
    const turn = activity.turnId || `legacy-${event.seq || event.ts}`;
    const key = `${turn}/${activity.id || event.seq || event.ts}`;
    const prior = activities.get(key);
    activities.set(key, {
      type: 'activity',
      activity: { ...(prior?.activity || {}), ...activity },
      ts: prior?.ts || event.ts,
      order: prior?.order ?? event.seq ?? event.ts,
    });
  }

  // The workflow stores the final assistant reply for provider resume. The same
  // reply also arrives as a structured provider message; suppress that exact
  // duplicate while retaining intermediate assistant messages around tool calls.
  const providerTexts = new Set(
    [...activities.values()]
      .filter((entry) => entry.activity.kind === 'message')
      .map((entry) => String(entry.activity.title || '').trim()),
  );
  const messages = (t.messages || [])
    .filter((message) => message.role !== 'agent' || !providerTexts.has(String(message.text || '').trim()))
    .map((message, index) => ({ type: 'message', message, ts: message.ts, order: index }));
  // Follow-ups are journaled as soon as Temporal accepts their signal, while the
  // workflow's cached transcript may not be republished until the turn ends.
  // Merge those durable events into the presentation timeline, keyed by message
  // id so the later transcript publish (and an optimistic + WS duplicate) cannot
  // show the same user message twice.
  const storedIds = new Set((t.messages || []).map((message) => message.id));
  const posted = new Map();
  for (const event of (S.taskEvents || [])) {
    if (event.type !== 'conversation.message' || event.payload?.role !== t.role) continue;
    const message = event.payload?.message;
    if (!message?.id || storedIds.has(message.id)) continue;
    posted.set(message.id, { type: 'message', message, ts: message.ts ?? event.ts, order: event.seq ?? event.ts });
  }
  const combined = [...messages, ...posted.values(), ...activities.values()];
  return combined.sort((a, b) => {
    const at = Number(a.ts) > 100000000000 ? Number(a.ts) : -1000000000000 + Number(a.order || 0);
    const bt = Number(b.ts) > 100000000000 ? Number(b.ts) : -1000000000000 + Number(b.order || 0);
    return at - bt || Number(a.order || 0) - Number(b.order || 0);
  });
}

function conversationTime(ts) {
  if (Number(ts) < 100000000000) return '';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function conversationTimeHtml(ts) {
  const label = conversationTime(ts);
  if (!label) return '';
  return `<time datetime="${new Date(Number(ts)).toISOString()}" title="${esc(new Date(Number(ts)).toLocaleString())}">${esc(label)}</time>`;
}

function renderConversationEntry(entry) {
  const md = markdownEnabled() ? ' md' : '';
  if (entry.type === 'message') {
    const m = entry.message;
    const role = m.role === 'user' ? 'You' : m.role === 'agent' ? 'Agent' : 'System';
    return `<div class="msg ${m.role}"><div class="msg-meta"><span class="role">${role}</span>${conversationTimeHtml(m.ts)}<span class="msg-meta-gap"></span>${messageCopyButton(m.text)}</div><div class="msg-text${md}">${renderMessageBody(m.text)}</div>${renderMessageImages(m.images)}</div>`;
  }
  const a = entry.activity;
  if (a.kind === 'message') {
    return `<div class="msg agent"><div class="msg-meta"><span class="role">Agent</span>${conversationTimeHtml(entry.ts)}<span class="msg-meta-gap"></span>${messageCopyButton(a.title)}</div><div class="msg-text${md}">${renderMessageBody(a.title)}</div></div>`;
  }
  const icons = { reasoning: '◇', command: '›_', file: '±', tool: '⚙', search: '⌕', subagent: '⑂', status: '·', turn: '●', error: '!' };
  const detail = a.detail
    ? `<details class="activity-detail"><summary>Details</summary><pre>${esc(a.detail)}</pre></details>`
    : '';
  return `<div class="agent-activity ${esc(a.kind)} ${esc(a.phase)}">
    <span class="activity-icon" aria-hidden="true">${icons[a.kind] || '·'}</span>
    <div class="activity-body"><div class="activity-head"><span class="activity-title">${esc(a.title)}</span><span class="activity-state">${esc(a.phase)}</span>${conversationTimeHtml(entry.ts)}</div>${detail}</div>
  </div>`;
}

function conversationPresence(v, t) {
  if (v.agentTurn?.role === t.role) {
    return v.agentTurn.state === 'running'
      ? { label: 'Working now', tone: 'working' }
      : { label: 'Waiting for an agent slot', tone: 'waiting' };
  }
  if (t.role === liveRoleFor(v) && v.waitingFor) return { label: v.waitingFor.detail || `Waiting for ${v.waitingFor.kind}`, tone: 'waiting' };
  if (v.status === 'failed') return { label: 'Failed', tone: 'failed' };
  if (v.status === 'done') return { label: 'Finished', tone: 'done' };
  return { label: 'Idle', tone: 'idle' };
}

// The ephemeral terminal: a real PTY in the task's world; type straight into it
// (Ctrl-C and friends land in the shell). "Open terminal" flips to "Kill
// terminal" while a session is live — that closes the socket, which kills the
// shell and every process running in it. The session survives tab/pane switches
// (module state) and dies when you leave the task.
function terminalPane(v) {
  const open = termIsOpenFor(v.taskId);
  const hasWorld = !!(v.worldAvailable || v.worldPath);
  return `
    <div class="ck-pane-head">
      <b>Ephemeral terminal</b>
      <span class="pal-sub">a shell in the task's world — killed when you leave the task</span>
      <span style="flex:1"></span>
      ${v.worldPath ? `<button class="btn sm copy-cmd" data-cmd="${esc(`cd ${v.worldPath} && $SHELL`)}" title="Copy a shell command to open this world in your own terminal">⧉ Copy command</button>` : ''}
      ${v.worldAvailable && !v.worldPath ? '<button class="btn sm" id="terminal-native">Copy attach cmd</button>' : ''}
      ${v.worldProvider && !['worktree', 'container', 'memory'].includes(v.worldProvider) ? '<button class="btn sm" id="local-checkout">Work locally</button>' : ''}
      ${v.worldDesktop ? '<button class="btn sm" id="desktop-open">Open desktop</button>' : ''}
      <button class="btn sm" id="term-open" ${hasWorld ? '' : 'disabled'}>${hasWorld ? 'Open terminal' : 'No world yet'}</button>
    </div>
    <div class="ck-term">
      <pre class="raw ${open ? '' : 'hidden'} term-screen" id="term-out" tabindex="0" title="Click to focus, then type directly — keystrokes (incl. Ctrl-C) go straight to the shell"></pre>
      ${open ? '' : `<div class="empty" id="ck-term-hint"><div class="big">No shell running</div>${hasWorld ? '“Open terminal” starts one in the task\'s world.' : 'This task has no world yet.'}</div>`}
    </div>`;
}

function wireCheckinSidebar(v) {
  $('#main').querySelectorAll('[data-checkin]').forEach((el) =>
    el.addEventListener('click', () => {
      selectCheckinPane(v, el.dataset.checkin, el.dataset.openTerminal === '1');
    }),
  );
  $('#local-checkout')?.addEventListener('click', () => openLocalCheckout(v));
  $('#terminal-native')?.addEventListener('click', () => copyNativeAttachCommand(v));
  $('#main').querySelectorAll('.fork-local').forEach((button) => button.addEventListener('click', () => forkCloudSessionLocally(v, button)));
  $('#desktop-open')?.addEventListener('click', async () => {
    try { const session = await api(`/api/tasks/${encodeURIComponent(v.taskId)}/desktop`); window.open(session.url, '_blank', 'noopener'); }
    catch (error) { toast(error.message, true); }
  });
}

async function openLocalCheckout(v) {
  if (!S.meta?.hosted) return materializeLocalCheckout(v);
  let plan;
  try { plan = await api(`/api/tasks/${encodeURIComponent(v.taskId)}/checkout`); }
  catch (error) { return toast(error.message, true); }
  const host = document.createElement('div'); $('#modal-root').appendChild(host);
  const canRefresh = v.status === 'waiting' && !v.agentTurn && ['human', 'confirm'].includes(v.waitingFor?.kind);
  host.innerHTML = `<div class="palette-scrim local-handoff-scrim"><div class="palette picker" style="max-width:760px">
    <div class="fp-head">Work locally <span class="q-spacer"></span><button class="icon-btn local-handoff-close">✕</button></div>
    <p class="task-sub">The task branch is the handoff boundary. Karmax never connects to your laptop and your GitHub credentials never enter the cloud sandbox.</p>
    <div class="section-h">1. First checkout</div><pre class="raw">${esc(plan.cloneScript)}</pre><button class="btn sm local-copy" data-value="${esc(plan.cloneScript)}">Copy checkout commands</button>
    <div class="section-h" style="margin-top:14px">Already checked out?</div><pre class="raw">${esc(plan.updateScript)}</pre><button class="btn sm local-copy" data-value="${esc(plan.updateScript)}">Copy update commands</button>
    <div class="section-h" style="margin-top:14px">2. Test, commit, and push</div><pre class="raw">${esc(plan.pushScript)}</pre><button class="btn sm local-copy" data-value="${esc(plan.pushScript)}">Copy push commands</button>
    <div class="section-h" style="margin-top:14px">3. Bring the pushed commits back</div>
    <p class="task-sub">Karmax accepts only a clean fast-forward, then parks the world again so the handoff does not leave metered compute running.</p>
    <div class="inline-form"><button class="btn sm primary" id="local-refresh" ${canRefresh ? '' : 'disabled'}>Refresh cloud world from GitHub</button><span class="task-sub" id="local-refresh-result">${canRefresh ? '' : 'Available while the task is waiting for human review.'}</span></div>
  </div></div>`;
  host.querySelector('.local-handoff-close').addEventListener('click', () => host.remove());
  host.querySelector('.local-handoff-scrim').addEventListener('click', (event) => { if (event.target === event.currentTarget) host.remove(); });
  host.querySelectorAll('.local-copy').forEach((button) => button.addEventListener('click', () => copyToClipboard(button.dataset.value || '').then(() => {
    const label = button.textContent; button.textContent = '✓ copied'; setTimeout(() => { button.textContent = label; }, 1200);
  })));
  $('#local-refresh', host)?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const result = $('#local-refresh-result', host); button.disabled = true; result.textContent = 'Importing the pushed branch…';
    try {
      const refreshed = await api(`/api/tasks/${encodeURIComponent(v.taskId)}/refresh-from-github`, { method: 'POST', body: '{}' });
      result.textContent = `${refreshed.updated.length} repositor${refreshed.updated.length === 1 ? 'y' : 'ies'} refreshed${refreshed.parked ? ' and world parked' : ''}.${refreshed.warning ? ` ${refreshed.warning}` : ''}`;
      await refreshTask();
    } catch (error) { result.textContent = error.message; button.disabled = false; }
  });
}

async function materializeLocalCheckout(v, session) {
  let checkout;
  try {
    checkout = await api(`/api/tasks/${encodeURIComponent(v.taskId)}/materialize-local`, { method: 'POST', body: '{}' });
  } catch (error) { toast(error.message, true); return null; }
  const fork = session ? forkCommandFor(session, checkout.cwd) : '';
  const host = document.createElement('div'); $('#modal-root').appendChild(host);
  host.innerHTML = `<div class="palette-scrim local-handoff-scrim"><div class="palette picker" style="max-width:760px">
    <div class="fp-head">Ready locally <span class="q-spacer"></span><button class="icon-btn local-handoff-close">✕</button></div>
    <p class="task-sub">Karmax published the committed cloud branch through its Git broker and materialized a separate checkout on this machine. The cloud world stays isolated and is parked when no terminal or review process is using it.</p>
    <div class="section-h">Local checkout</div><pre class="raw">${esc(checkout.cwd)}</pre>
    <button class="btn sm local-copy" data-value="${esc(`cd ${JSON.stringify(checkout.cwd)} && $SHELL`)}">Copy shell command</button>
    ${fork ? `<div class="section-h" style="margin-top:14px">Fork this agent locally</div><pre class="raw">${esc(fork)}</pre><button class="btn sm local-copy" data-value="${esc(fork)}">Copy fork command</button>` : ''}
    <div class="section-h" style="margin-top:14px">Repositories</div>
    <pre class="raw">${esc(checkout.repositories.map((repo) => `${repo.name}  ${repo.branch}  ${repo.head}\n${repo.path}`).join('\n\n'))}</pre>
  </div></div>`;
  host.querySelector('.local-handoff-close').addEventListener('click', () => host.remove());
  host.querySelector('.local-handoff-scrim').addEventListener('click', (event) => { if (event.target === event.currentTarget) host.remove(); });
  host.querySelectorAll('.local-copy').forEach((button) => button.addEventListener('click', () => copyToClipboard(button.dataset.value || '').then(() => {
    const label = button.textContent; button.textContent = '✓ copied'; setTimeout(() => { button.textContent = label; }, 1200);
  })));
  return checkout;
}

async function forkCloudSessionLocally(v, button) {
  button.disabled = true;
  button.textContent = 'Materializing…';
  const session = { provider: button.dataset.provider, id: button.dataset.session, home: button.dataset.home };
  const checkout = await materializeLocalCheckout(v, session);
  if (checkout) await copyToClipboard(forkCommandFor(session, checkout.cwd)).then(() => toast('Fork command copied'));
  button.disabled = false;
  button.textContent = '⑂ fork locally';
}

async function copyNativeAttachCommand(v) {
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(v.taskId)}/terminal-ticket`, { method: 'POST', body: '{}' });
    const command = [...(result.attachArgv || ['karmax']), 'attach', v.taskId, '--url', result.gatewayUrl, '--ticket', result.ticket]
      .map((part) => JSON.stringify(String(part))).join(' ');
    await copyToClipboard(command);
    toast('One-time attach command copied');
  } catch (error) { toast(error.message, true); }
}

// Parameters: everything the human configured on this task, in one place —
// priority + tags (organization), the workflow's declared params (editable or
// frozen per its lifecycle), and the per-task credential policy.
function parametersTab(v) {
  // Priority + tags (organization metadata) now live in the page header, above the
  // tabs, so they're visible/editable on every tab — not just here (see renderTaskPage).
  return `
    ${paramsSection(v)}
    <div class="section-h">Credentials</div>
    <p class="task-sub" style="color:var(--ink-3);margin-top:0">Precedence + enable/disable, just for this task — overrides the organization/project order. Drag to reorder; toggle On/Off. (The new-task form has the same control.)</p>
    <div id="cred-editor-task">Loading…</div>`;
}

// Advanced: the raw feeds — the live event stream and the structured view-model.
function advancedTab(v) {
  return `
    <div class="section-h">Live events</div>
    <div class="events" id="tp-events"></div>
    <div class="section-h">Structured state (the view-model floor)</div>
    <pre class="raw">${esc(JSON.stringify({ stage: v.stage, status: v.status, state: v.state, waitingFor: v.waitingFor, agentTurn: v.agentTurn, world: { available: v.worldAvailable, provider: v.worldProvider, localPath: v.worldPath }, pr: v.pr }, null, 2))}</pre>`;
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
    // Only claim "quota refresh" when a reset instant is actually known — this
    // wait also covers plain lease contention (another task holds the login) and
    // grant latency, where asserting a quota cause sends the user to check a
    // dashboard that rightly shows nothing wrong.
    case 'account': return `a ${w.provider || 'compatible'} login${w.earliestResetAt ? ' (quota refresh)' : ' to become available'}`;
    case 'agentSlot': return w.detail || 'a host agent slot';
    case 'mergeSlot': return 'a merge slot';
    case 'human': return w.detail ? `human input (${w.detail})` : 'human input';
    case 'subtask': return 'its sub-tasks to finish (or raise)';
    case 'subagent': return w.detail || 'its sub-agents to finish';
    case 'shell': return w.detail || 'a background job to finish';
    case 'parent': return 'the parent task to respond';
    case 'confirm': return w.detail ? `the confirm agent to review (${w.detail})` : 'the confirm agent to review';
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
    const authScope = opts.taskId ? `?taskId=${encodeURIComponent(opts.taskId)}` : opts.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : '';
    try { await api(`/api/credentials/policy${authScope}`, { method: 'POST', body: JSON.stringify({ scope, projectId: opts.projectId, taskId: opts.taskId, policy }) }); }
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
  if (S.meta?.resolveAgentEnabled && s === 'resolve') return 'resolve';
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
        const prev = btn.innerHTML;
        btn.textContent = btn.dataset.copyIcon === '1' ? '✓' : '✓ copied';
        setTimeout(() => { btn.innerHTML = prev; }, 1200);
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
  const pid = taskRecord(taskId)?.projectId || S.projectId;
  if (!wf || !pid) return {};
  return api(`/api/defaults/${pid}/${wf}`).then((d) => d?.task?.inherited || {}).catch(() => ({}));
}
// Free-form human notes (cosmetic, UI-only — never sent to any agent). Editable
// at ANY stage (active, done, cancelled, failed, archived) — the endpoint has no
// stage guard. The current value comes from the freshly-fetched view (`v.notes`),
// so it's correct even for a task not in the loaded list.
function notesSection(v) {
  const notes = v.notes || '';
  return `<div class="section-h">Notes</div>
    <div id="task-notes-box">
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
      const rec = taskRecord(v.taskId);
      if (rec) rec.notes = notes || undefined;
      toast('Notes saved');
    } catch (e) {
      toast(e.message, true);
    }
  };
  btn.addEventListener('click', save);
  // Save on blur too, so notes aren't lost when the page closes.
  ta.addEventListener('blur', save);
}

function paramsSection(v) {
  const rec = taskRecord(v.taskId);
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
  return `<div class="section-h">Parameters</div><div id="tp-params" class="parameter-fields">${rows}${footer}</div>`;
}

// Best-known current value of a param for a running task (the view carries a few;
// the task record holds the rest of the user's own overrides).
function paramCurrentValue(f, v, rec) {
  const own = (rec && rec.params) || {};
  if (f.bind === 'prompt') return own.prompt ?? (v.messages || []).find((m) => m.role === 'user')?.text ?? '';
  if (f.name === 'target') return v.targetBranch ?? own.target ?? '';
  if (f.name === 'base') return v.base ?? own.base ?? '';
  if (f.type === 'agent' && f.role) {
    // Queued tasks carry the platform's durable queue-time snapshot: this is the
    // exact effective provider/model the runtime selected, even if defaults later
    // change. Legacy tasks predate that snapshot; for those, correctly fan the
    // compact agent:unified form value back out instead of falling through to an
    // unrelated role default (the old Claude-label-on-a-Codex-task bug).
    if (v.agents?.[f.role]) return v.agents[f.role];
    const unified = own['agent:unified'];
    if (own.separateAgents === false && unified) {
      if (f.role === 'do') return unified;
      const { resumeFrom: _resumeFrom, ...shared } = unified;
      return shared;
    }
  }
  return own[f.name];
}
function displayParam(f, val) {
  if (val === undefined || val === null || val === '') return '(default)';
  if (f.type === 'agent') return [val.provider, val.model].filter(Boolean).join(' · ') || '(default)';
  if (f.type === 'confirmer') {
    const layers = cfLayersOf(val);
    if (!layers.length) return 'auto-confirm';
    return layers.map((l) => (l.kind === 'agent' ? `agent (${[l.provider, l.model].filter(Boolean).join(' · ') || 'default'})` : 'human')).join(' → ');
  }
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
      const resumeFrom = readResume(box);
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
    const rec = taskRecord(v.taskId);
    editBtn.addEventListener('click', () => openTaskForm(v.workflow, rec));
    return;
  }
  const root = document.getElementById('tp-params');
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
      setTimeout(refreshTask, 250);
      setTimeout(refreshTasks, 400);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// the generic auto-render floor (SPEC §10.2 tier 1): render declared actions.
// This is the footer bar that stays visible on every task-page tab, so
// Confirm/Cancel are always one click (or one digit) away.
function taskActions(v) {
  const acts = v.actions || [];
  const simple = acts.filter((a) => !a.args || a.args.length === 0);
  let html = `<div class="actions">`;
  let slot = 0; // digits 1–9 press the Nth ENABLED button (see the command registry)
  for (const a of simple) {
    const cls = a.name === 'confirm' ? 'primary' : a.danger ? 'danger' : '';
    const kbd = a.enabled && slot < 9 ? `<span class="kbd">${++slot}</span>` : '';
    html += `<button class="btn ${cls}" data-act="${a.name}" ${a.enabled ? '' : 'disabled'}>${esc(a.label)}${kbd}</button>`;
  }
  // Target-branch editing lives in the Parameters tab (paramsSection), which
  // renders it editable/frozen per the workflow's window — no separate input here.
  // The follow-up box lives inside each agent's conversation on the Check-in tab,
  // so a human can address any agent (SPEC §5.6).
  html += `</div>`;
  if (!acts.length) html = `<div style="color:var(--ink-3)">No actions available — task is ${esc(v.stage)}.</div>`;
  return html;
}

function wireActions(v) {
  $('#tp-foot').querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        await api(`/api/tasks/${v.taskId}/signal`, { method: 'POST', body: JSON.stringify({ signal: act }) });
        toast(`${act} sent`);
        setTimeout(refreshTask, 250);
        setTimeout(refreshTasks, 400);
      } catch (e) { toast(e.message, true); }
    }),
  );
  // Sub-task references are real <a> permalinks; installLinkRouter() handles them.
}

// Wire the per-conversation follow-up boxes (SPEC §5.6): each box carries the
// agent role it addresses, so a follow-up is delivered to the right agent.
function wireFollowups(v) {
  if (!S.followupImages) S.followupImages = {};
  $('#main').querySelectorAll('.followup-box').forEach((box) => {
    const role = box.dataset.role;
    const ta = box.querySelector('.followup-input');
    const btn = box.querySelector('.followup-send');
    if (!ta || !btn) return;
    // Per-(task,role) stores for pasted images AND half-typed text, so a draft
    // follow-up survives the page's frequent WS-driven re-renders and switching
    // between check-in panes (which destroys the textarea's DOM).
    const key = `${v.taskId}/${role}`;
    const store = (S.followupImages[key] ||= []);
    ta.addEventListener('input', () => { S.followupDrafts[key] = ta.value; });
    const chips = box.querySelector('.followup-chips');
    const paint = () => renderImageChips(chips, store);
    wireImagePaste(ta, () => store, paint);
    // Typing "@" tags wiki pages/labels/folders into the follow-up, same as the
    // task prompt — the backend scans follow-up messages for `@proj:…`/`@org:…`.
    wireWikiMention(ta, taskRecord(v.taskId)?.projectId || S.projectId);
    paint();
    const send = async () => {
      const text = ta.value.trim();
      if (!text && !store.length) return;
      try {
        const result = await api(`/api/tasks/${v.taskId}/signal`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'followUp', text, role, ...(store.length ? { images: [...store] } : {}) }),
        });
        // Render immediately even if this browser's event WebSocket is reconnecting.
        // The durable WS copy is de-duplicated by conversationEntries once it lands.
        if (result?.message && !S.taskEvents.some((event) => event.type === 'conversation.message' && event.payload?.message?.id === result.message.id)) {
          S.taskEvents.push({ type: 'conversation.message', taskId: v.taskId, ts: result.message.ts, payload: { role: result.role || role, message: result.message } });
        }
        // Clear the persisted draft + image store FIRST, so neither the re-render
        // below nor a background refresh can repopulate the box from them. The box
        // content is sourced from S.followupDrafts on every render, so this — not
        // touching the DOM — is what actually empties it.
        delete S.followupDrafts[key];
        store.length = 0;
        // The captured `ta`/`chips` may be detached if a background WS refresh
        // swapped the page during the await above, in which case clearing `ta`
        // would leave the *live* box untouched. Clear the current DOM textarea by
        // a fresh lookup so the box is cleared even in that race.
        const sel = window.CSS && CSS.escape ? CSS.escape(role) : role;
        const liveTa = $('#main').querySelector(`.followup-box[data-role="${sel}"] .followup-input`);
        if (liveTa) liveTa.value = '';
        else if (ta) ta.value = '';
        paint();
        toast('Follow-up sent');
        renderTaskPage();
        setTimeout(refreshTask, 250);
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
  // Follow the stream only when the reader is already parked at the bottom; if
  // they've scrolled up to read history, hold their view fixed as text streams in.
  const thread = document.getElementById('ck-thread');
  const atBottom = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  b.classList.remove('hidden');
  b.innerHTML = `<div class="role">agent · live</div>${esc(S.liveOutput)}`;
  if (atBottom) b.scrollIntoView({ block: 'nearest' });
}

function renderTaskEvents() {
  const box = document.getElementById('tp-events');
  if (!box) return;
  box.innerHTML = S.taskEvents
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
// Fetch the coordinator's authoritative queue order for every domain currently in
// the merge stage, so the view reflects reorders immediately (the per-task polled
// position lags up to a workflow poll interval). Re-renders the queue tab on arrival.
async function seedQueue() {
  const inMerge = S.tasks.filter((t) => ['merge', 'pr'].includes(t.lastView?.stage));
  const domains = [...new Set(inMerge.map((t) => t.lastView?.state?.mergeDomain).filter(Boolean))];
  const orders = {};
  await Promise.all(
    domains.map(async (d) => {
      try {
        const v = await api(`/api/queue?domain=${encodeURIComponent(d)}&projectId=${encodeURIComponent(S.projectId)}`);
        orders[d] = { queue: v.queue || [], current: v.current };
      } catch {}
    }),
  );
  try { S.agentQueue = await api('/api/agent-queue'); } catch {}
  S.queueOrders = orders;
  if (S.tab === 'queue') renderMain();
}

// Rank a task within its domain: the leased (merging) task pins to the top, then the
// coordinator's queue order when known, else the task's last-published position.
function queueRank(t) {
  const v = t.lastView || {};
  if (v.state?.mergeGranted) return -1;
  const ord = S.queueOrders[v.state?.mergeDomain];
  if (ord) { const i = ord.queue.indexOf(t.id); return i < 0 ? 1e6 : i; }
  const p = v.mergeQueue?.position;
  return p > 0 ? p : 1e6 - 1;
}

function mergeQueuePanel() {
  const inMerge = S.tasks.filter((t) => ['merge', 'pr'].includes(t.lastView?.stage));
  if (!inMerge.length) return `<div class="card"><div class="empty"><div class="big">Merge queue is empty</div>Tasks appear here when they reach the merge stage.</div></div>`;
  // Group by merge domain — reordering is only meaningful within a single serialization
  // domain. With one domain (the common case) this renders as a single list.
  const groups = new Map();
  for (const t of inMerge) {
    const d = t.lastView?.state?.mergeDomain || '';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(t);
  }
  const multi = groups.size > 1;
  return [...groups.entries()]
    .map(([domain, tasks]) => {
      tasks.sort((a, b) => queueRank(a) - queueRank(b));
      const rows = tasks
        .map((t) => {
          const v = t.lastView || {};
          const pos = v.mergeQueue?.position;
          const merging = !!v.state?.mergeGranted;
          const canMove = !merging && !!v.state?.mergeDomain;
          return `<div class="queue-item ${merging ? 'current' : ''}" data-id="${t.id}" data-domain="${esc(domain)}" tabindex="0" ${canMove ? 'draggable="true"' : ''}>
        ${canMove ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : '<span class="drag-handle placeholder"></span>'}
        <span class="pos">${merging ? '▶' : pos > 0 ? `#${pos}` : '–'}</span>
        <div style="flex:1"><div class="task-title">${t.num != null ? `<span class="task-num">#${t.num}</span> ` : ''}${esc(t.title)} <span class="chip">${merging ? 'merging' : 'queued'}</span></div>
          <div class="task-sub"><span class="branch">${esc(v.branch || '')}</span> → <span class="branch">${esc(v.targetBranch || '')}</span></div></div>
        ${canMove ? `<div class="queue-actions"><button class="btn sm" data-move="top" data-id="${t.id}" data-domain="${esc(domain)}">Move to top</button><button class="btn sm" data-move="bottom" data-id="${t.id}" data-domain="${esc(domain)}">Move to bottom</button></div>` : ''}
      </div>`;
        })
        .join('');
      const label = multi && domain ? `<div class="queue-domain">${esc(domain)}</div>` : '';
      return `${label}<div class="queue-list" data-domain="${esc(domain)}">${rows}</div>`;
    })
    .join('');
}

function agentQueuePanel() {
  const q = S.agentQueue || { capacity: 3, queue: [], current: [] };
  const active = q.current || [];
  const waiting = q.queue || [];
  const rows = [...active.map((x) => ({ ...x, active: true })), ...waiting.map((x) => ({ ...x, active: false }))]
    .map((x, i) => {
      const task = taskRecord(x.taskId);
      const title = x.title || task?.title || `Task ${String(x.taskId || '').slice(0, 8)}`;
      const num = task?.num != null ? `<span class="task-num">#${task.num}</span> ` : '';
      return `<div class="queue-item ${x.active ? 'current' : ''}" data-agent-turn="${esc(x.turnId)}" data-id="${esc(x.taskId)}" tabindex="0" ${x.active ? '' : 'draggable="true"'}>
        ${x.active ? '<span class="drag-handle placeholder"></span>' : '<span class="drag-handle" title="Drag to reorder">⠿</span>'}
        <span class="pos">${x.active ? '▶' : `#${i - active.length + 1}`}</span>
        <div style="flex:1"><div class="task-title">${num}${esc(title)} <span class="chip">${x.active ? 'active lease' : 'queued'}</span></div>
          <div class="task-sub">${esc(x.role || 'agent')} agent${x.provider ? ` · ${esc(x.provider)}` : ''}</div></div>
        ${x.active ? '' : `<div class="queue-actions"><button class="btn sm" data-agent-move="top" data-turn="${esc(x.turnId)}">Move to top</button><button class="btn sm" data-agent-move="bottom" data-turn="${esc(x.turnId)}">Move to bottom</button></div>`}
      </div>`;
    }).join('');
  return rows
    ? `<div class="queue-list agent-queue-list">${rows}</div>`
    : `<div class="card"><div class="empty"><div class="big">Agent queue is empty</div>Agent turns appear here while running or waiting for host capacity.</div></div>`;
}

function queuesView() {
  const contributions = (S.contributions?.slots || []).filter((x) => ['queue-panel', 'merge-queue-panel'].includes(x.contribution?.slot));
  const renderers = { 'merge-queue': mergeQueuePanel, 'agent-queue': agentQueuePanel };
  return contributions.map((x) => {
    const component = x.contribution?.component;
    const render = renderers[component];
    if (!render) return '';
    const suffix = component === 'agent-queue' ? ` <span class="pill">${(S.agentQueue?.current || []).length}/${S.agentQueue?.capacity ?? 3}</span>` : '';
    return `<div class="section-h">${esc(x.contribution.title || x.workflow)}${suffix}</div>${render()}`;
  }).join('') || `<div class="empty">No workflows contribute a queue.</div>`;
}

// Optimistically mutate the cached order for a domain so the reorder shows instantly,
// before the coordinator signal round-trips. Missing orders are seeded from the
// current DOM/rank so a move still animates while the first fetch is in flight.
function localQueue(domain) {
  const ord = S.queueOrders[domain];
  if (ord) return ord;
  const ids = S.tasks
    .filter((t) => (t.lastView?.state?.mergeDomain || '') === domain && !t.lastView?.state?.mergeGranted && ['merge', 'pr'].includes(t.lastView?.stage))
    .sort((a, b) => queueRank(a) - queueRank(b))
    .map((t) => t.id);
  const seeded = { queue: ids };
  S.queueOrders[domain] = seeded;
  return seeded;
}

function wireQueueView() {
  $('#main').querySelectorAll('.queue-item').forEach((e) => {
    if (taskRecord(e.dataset.id)) wireTaskNav(e, () => e.dataset.id);
  });
  $('#main').querySelectorAll('[data-move]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const { domain, id } = b.dataset;
      const q = localQueue(domain);
      const rest = q.queue.filter((t) => t !== id);
      q.queue = b.dataset.move === 'top' ? [id, ...rest] : [...rest, id];
      renderMain();
      try {
        if (b.dataset.move === 'top') {
          await api(`/api/queue/prioritize?projectId=${encodeURIComponent(S.projectId)}`, { method: 'POST', body: JSON.stringify({ domain, taskId: id }) });
        } else {
          await api(`/api/queue/move?projectId=${encodeURIComponent(S.projectId)}`, { method: 'POST', body: JSON.stringify({ domain, taskId: id }) });
        }
        toast(b.dataset.move === 'top' ? 'Moved to top' : 'Moved to bottom');
        setTimeout(seedQueue, 300);
      } catch (e) { toast(e.message, true); seedQueue(); }
    }),
  );
  $('#main').querySelectorAll('[data-agent-move]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const turnId = b.dataset.turn;
      const rest = (S.agentQueue.queue || []).filter((x) => x.turnId !== turnId);
      const item = (S.agentQueue.queue || []).find((x) => x.turnId === turnId);
      if (!item) return;
      S.agentQueue.queue = b.dataset.agentMove === 'top' ? [item, ...rest] : [...rest, item];
      renderMain();
      const beforeTurnId = b.dataset.agentMove === 'top' ? rest[0]?.turnId : undefined;
      try {
        await api('/api/agent-queue/move', { method: 'POST', body: JSON.stringify({ turnId, beforeTurnId }) });
        toast(b.dataset.agentMove === 'top' ? 'Moved to top' : 'Moved to bottom');
        setTimeout(seedQueue, 300);
      } catch (e) { toast(e.message, true); seedQueue(); }
    }),
  );
  $('#main').querySelectorAll('.queue-list:not(.agent-queue-list)').forEach(wireQueueDrag);
  wireAgentQueueDrag($('#main').querySelector('.agent-queue-list'));
  applyCursor();
  $('#main').querySelectorAll('.queue-item').forEach((r) => r.addEventListener('focus', () => { S.cursorId = rowKey(r); applyCursor(); }));
}

function wireAgentQueueDrag(list) {
  if (!list) return;
  let dragging = null;
  list.querySelectorAll('.queue-item[draggable="true"]').forEach((row) => {
    row.addEventListener('dragstart', (e) => { dragging = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragging = null; });
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    let before = null;
    for (const row of list.querySelectorAll('.queue-item[draggable="true"]:not(.dragging)')) {
      const box = row.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) { before = row; break; }
    }
    before ? list.insertBefore(dragging, before) : list.appendChild(dragging);
  });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragging) return;
    const turnId = dragging.dataset.agentTurn;
    const rows = [...list.querySelectorAll('.queue-item[draggable="true"]')];
    const at = rows.findIndex((r) => r.dataset.agentTurn === turnId);
    const beforeTurnId = at >= 0 ? rows[at + 1]?.dataset.agentTurn : undefined;
    const byId = new Map((S.agentQueue.queue || []).map((x) => [x.turnId, x]));
    S.agentQueue.queue = rows.map((r) => byId.get(r.dataset.agentTurn)).filter(Boolean);
    try {
      await api('/api/agent-queue/move', { method: 'POST', body: JSON.stringify({ turnId, beforeTurnId }) });
      setTimeout(seedQueue, 300);
    } catch (err) { toast(err.message, true); seedQueue(); }
  });
}

// HTML5 drag-and-drop reordering within one domain's queue list. On drop we send the
// single moved task with the id it now sits before (or none → bottom).
function wireQueueDrag(list) {
  if (!list) return;
  const domain = list.dataset.domain;
  let dragging = null;
  list.querySelectorAll('.queue-item[draggable="true"]').forEach((row) => {
    row.addEventListener('dragstart', (e) => { dragging = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch {} });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragging = null; });
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    // Insert before the nearest movable row whose vertical center is below the cursor;
    // past the last one → append. The merging row (not draggable) stays pinned on top.
    let best = null, bestDist = Infinity;
    for (const el of list.querySelectorAll('.queue-item[draggable="true"]:not(.dragging)')) {
      const b = el.getBoundingClientRect();
      const cy = b.top + b.height / 2;
      if (cy < e.clientY) continue;
      const d = cy - e.clientY;
      if (d < bestDist) { bestDist = d; best = el; }
    }
    best ? list.insertBefore(dragging, best) : list.appendChild(dragging);
  });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragging) return;
    const id = dragging.dataset.id;
    const rows = [...list.querySelectorAll('.queue-item[draggable="true"]')];
    const order = rows.map((r) => r.dataset.id);
    const q = localQueue(domain);
    q.queue = order;
    const at = order.indexOf(id);
    const beforeTaskId = at >= 0 && at < order.length - 1 ? order[at + 1] : '';
    try {
      await api(`/api/queue/move?projectId=${encodeURIComponent(S.projectId)}`, { method: 'POST', body: JSON.stringify({ domain, taskId: id, beforeTaskId }) });
      setTimeout(seedQueue, 300);
    } catch (err) { toast(err.message, true); seedQueue(); }
  });
}

// ── activity ─────────────────────────────────────────────────────────────────
async function seedActivity() {
  try { S.activity = (await api(`/api/activity?since=0&projectId=${encodeURIComponent(S.projectId)}`)).reverse(); renderMain(); } catch {}
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
        ? `<a class="chip proc-task" data-spa href="${esc(taskUrl(g.taskId))}" data-task="${esc(g.taskId)}" title="open task">${esc(numLabel(g.taskId))}</a>`
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
  // .proc-task chips are real <a> permalinks handled by installLinkRouter().
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
    // Auto-refresh stale usage: a snapshot whose window has already reset (server
    // marks it `stale`) or a pollable login never probed. Without this the % froze
    // at whenever ↻ was last clicked and a week-old 15% read as current. Guarded to
    // one attempt a minute so a failing probe can't loop the dashboard.
    if ([...pollable].some((id) => !usage[id] || usage[id].stale) && Date.now() - (S.usageAutoAt || 0) > 60_000) {
      S.usageAutoAt = Date.now();
      api('/api/accounts/usage/recheck', { method: 'POST', body: JSON.stringify({}) }).then(() => {
        // Skip the re-render if the user is mid-edit in the panel (e.g. concurrency).
        const el = document.activeElement;
        if (S.tab === 'dashboard' && !(box.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || ''))) renderDashboard();
      }).catch(() => {});
    }
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
// an "unavailable" record, or undefined (never probed). Non-pollable logins (API
// keys / setup-token) render nothing here — their reactive status is shown above.
function usageBlock(id, snap, isPollable) {
  if (!snap) {
    return isPollable
      ? `<div class="task-sub" style="color:var(--ink-3);margin-top:4px">Usage not checked yet — checking…</div>`
      : '';
  }
  if (!snap.ok) {
    const why = snap.reason === 'setup-token'
      ? 'Usage % needs a full login (this one uses a setup-token) — tracked reactively.'
      : snap.reason === 'logged-out' ? 'Not logged in.'
      : snap.reason === 'not-subscription' ? 'No subscription usage to report.'
      : snap.reason === 'no-rate-limits' ? 'No subscription rate limits to report.'
      : `Usage unavailable (${esc(snap.reason || '')}).`;
    return `<div class="task-sub" style="color:var(--ink-3);margin-top:4px">${esc(why)}</div>`;
  }
  const rows = [];
  if (snap.session) rows.push(usageRow('Session', snap.session));
  if (snap.week) rows.push(usageRow('Week', snap.week));
  for (const m of snap.models || []) rows.push(usageRow(m.name || 'model', m));
  const freshness = snap.stale
    ? `<span style="color:var(--warn,#f5a623)">stale — checked ${esc(fmtAgo(snap.at))}, re-checking…</span>`
    : `checked ${esc(fmtAgo(snap.at))}`;
  return `<div style="margin-top:6px">${rows.join('')}
    <div class="task-sub" style="color:var(--ink-3);font-size:11px">${freshness}</div></div>`;
}

function usageRow(label, win) {
  const pct = Math.max(0, Math.min(100, win.pct || 0));
  // A window whose reset instant has passed no longer exists — its % is history,
  // not the current window. Dim it and say so rather than showing "resets … · now".
  const expired = win.resetAt && win.resetAt < Date.now();
  const hue = expired ? 'var(--ink-3)' : pct >= 90 ? 'var(--bad,#e5484d)' : pct >= 70 ? 'var(--warn,#f5a623)' : 'var(--ok,#30a46c)';
  const reset = expired
    ? `window reset ${esc(usageResetLabel(win))}${win.tz ? ` (${esc(win.tz)})` : ''} — % is from the previous window`
    : `resets ${esc(fmtUsageReset(win))}`;
  return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px${expired ? ';opacity:.55' : ''}">
    <span style="width:64px;color:var(--ink-2)">${esc(label)}</span>
    <span style="flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden;max-width:180px">
      <span style="display:block;height:100%;width:${pct}%;background:${hue}"></span>
    </span>
    <span class="mono" style="width:38px;text-align:right">${pct}%</span>
    <span style="color:var(--ink-3)">${reset}</span>
  </div>`;
}

function usageResetLabel(win) {
  if (win.resetLabel) return win.resetLabel;
  return win.resetAt
    ? new Date(win.resetAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
    : '';
}

function fmtUsageReset(win) {
  const cd = win.resetAt ? ` · ${fmtCountdown(win.resetAt)}` : '';
  return `${usageResetLabel(win)}${win.tz ? ` (${win.tz})` : ''}${cd}`;
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
  if (m < 60) return `${m}m ago`;
  return m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
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
// Confirmation happens where the eye already is: the pressed button itself says
// Saved for a moment, instead of a toast in the far corner naming wire ids.
function flashSaved(button) {
  if (!button || button.dataset.flashing) return;
  button.dataset.flashing = '1';
  const label = button.textContent;
  button.textContent = 'Saved ✓';
  button.classList.add('saved');
  setTimeout(() => { button.textContent = label; button.classList.remove('saved'); delete button.dataset.flashing; }, 1400);
}
// One renderer for both scopes; `scope` decides which fields show + where they save.
const settingsFields = (workflow, scope) => schemaFor(workflow)
  .filter((field) => field.scopes.includes(scope) && !['repos', 'gitProfile'].includes(field.name));
const COMMON_DEFAULT_NAMES = new Set(['base', 'target', 'worldProvider', 'copyGlobs', 'remote', 'agent:do', 'agent:merge', 'agent:resolve', 'confirm']);
// `confirm` (the Review route) stays a shared/common value on the wire, but it is
// edited in the Agents card beside the Do/Merge agents it gates — not here.
const commonSettingsFields = (scope) => settingsFields('software-dev', scope).filter((field) => COMMON_DEFAULT_NAMES.has(field.name) && field.name !== 'confirm');
// The stored `__common__` row is shared by several forms (task defaults here; the
// Review route and Git profile elsewhere) and a settings PUT replaces the whole
// row — so every save read-merge-writes: fetch the raw row, drop exactly the keys
// this form owns, and lay the collected values on top.
async function saveCommonSettings(scope, projectId, organizationId, ownNames, collected) {
  const url = scope === 'project' ? `/api/settings/project/${encodeURIComponent(projectId)}/__common__`
    : organizationId ? `/api/organizations/${encodeURIComponent(organizationId)}/settings/__common__`
    : '/api/settings/global/__common__';
  const values = await api(url).catch(() => ({}));
  for (const name of ownNames) delete values[name];
  Object.assign(values, collected);
  await api(url, { method: 'PUT', body: JSON.stringify({ values }) });
}
// Agent defaults live in the profile editor, so manifests correctly declare
// these controls as task-scoped. Quick tasks still need the same Do/Merge picker:
// read those task fields directly rather than hiding them behind settings scopes.
const quickAgentFields = () => schemaFor('software-dev').filter((field) => field.type === 'agent');
function settingsForms(scope, projectId) {
  const wfs = S.schema
    .filter((s) => WORKFLOWS.some((w) => w.id === s.name) || (scope === 'global' && s.name === 'agent-queue'))
    .sort((a, b) => Number(b.name === 'agent-queue') - Number(a.name === 'agent-queue'));
  const common = `<div class="card" data-wf="__common__" data-schema-wf="software-dev">
      <div class="wf-form parameter-fields">${renderFields(commonSettingsFields(scope))}</div>
      <button class="btn primary sm" data-save="__common__">Save task defaults</button>
    </div>`;
  const unique = wfs
    .map((s) => {
      const fields = settingsFields(s.name, scope).filter((field) => !COMMON_DEFAULT_NAMES.has(field.name));
      if (!fields.length) return '';
      const label = s.name === 'agent-queue' ? 'Host capacity' : s.name;
      const suffix = s.name === 'agent-queue' ? '' : '— workflow-specific';
      return `<details class="card" data-wf="${esc(s.name)}" ${s.name === 'software-dev' || s.name === 'agent-queue' ? 'open' : ''}>
        <summary style="cursor:pointer;font-weight:600">${esc(label)} <span style="color:var(--ink-3);font-weight:400;font-size:12px">${suffix}</span></summary>
        <div class="wf-form parameter-fields" style="margin-top:10px">${renderFields(fields)}</div>
        <button class="btn primary sm" data-save="${esc(s.name)}">${s.name === 'agent-queue' ? 'Save host capacity' : `Save ${esc(s.name)} defaults`}</button>
      </details>`;
    })
    .join('');
  return common + unique;
}

async function hydrateSettingsForms(scope, projectId, organizationId) {
  // load saved (own) values + inherited defaults per workflow and fill the inputs
  for (const sec of $('#main').querySelectorAll('[data-wf]')) {
    const wf = sec.dataset.wf;
    const schemaWf = sec.dataset.schemaWf || wf;
    let own = {};
    let inherited = {};
    try {
      const orgQuery = organizationId && wf !== 'agent-queue' ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
      const d = await api(`/api/defaults/${projectId || 'global'}/${schemaWf}${orgQuery}`);
      own = d[scope].own;
      inherited = d[scope].inherited;
    } catch {}
    const fields = wf === '__common__' ? commonSettingsFields(scope)
      : settingsFields(wf, scope).filter((field) => !COMMON_DEFAULT_NAMES.has(field.name));
    sec.querySelector('.wf-form').innerHTML = renderFields(fields, own, inherited);
    wireAgentFields(sec);
    wireFieldResets(sec, fields);
  }
}

// ── Quick task defaults (SPEC §10.4) ─────────────────────────────────────────
// An agent-only overlay applied to tasks added from the quick-task box (not the
// full "⋯ More" form). All non-agent task defaults continue to use the regular
// organization/project chain.
function quickSettingsForms(scope, projectId) {
  return `<div class="card" data-qwf="__common__" data-schema-wf="software-dev">
    <label class="switch"><input type="checkbox" class="quick-defaults-enabled"> Different agents for Quick tasks?</label>
    <div class="quick-defaults-body" hidden><div class="wf-form parameter-fields" style="margin-top:12px"></div>
      <button class="btn primary sm" data-qsave="__common__">Save Quick agent defaults</button></div>
  </div>`;
}

async function hydrateQuickSettingsForms(scope, projectId, organizationId) {
  const key = scope === 'global' ? 'globalQuick' : 'projectQuick';
  for (const sec of $('#main').querySelectorAll('[data-qwf]')) {
    const wf = sec.dataset.qwf;
    const schemaWf = sec.dataset.schemaWf || wf;
    let d = null;
    try { d = await api(`/api/defaults/${projectId || 'global'}/${schemaWf}${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`); } catch {}
    const own = d?.[key]?.own || {};
    const inherited = d?.[key]?.inherited || {};
    const fields = quickAgentFields();
    const enabled = own._enabled === true || (own._enabled !== false && fields.some((field) => own[field.name] !== undefined));
    sec.querySelector('.quick-defaults-enabled').checked = enabled;
    sec.querySelector('.quick-defaults-body').hidden = !enabled;
    sec.querySelector('.quick-defaults-enabled').addEventListener('change', (event) => { sec.querySelector('.quick-defaults-body').hidden = !event.target.checked; });
    sec.querySelector('.wf-form').innerHTML = renderFields(fields, own, inherited);
    wireAgentFields(sec);
    wireFieldResets(sec, fields);
  }
}

// Save handlers for the quick-defaults forms (shared by global + project scopes).
function wireQuickSettingsSave(scope, projectId, organizationId) {
  $('#main').querySelectorAll('[data-qsave]').forEach((b) =>
    b.addEventListener('click', async () => {
      const wf = b.dataset.qsave;
      const sec = b.closest('[data-qwf]');
      const fields = quickAgentFields();
      const values = { ...collectForm(sec.querySelector('.wf-form'), fields), _enabled: sec.querySelector('.quick-defaults-enabled').checked };
      const url = scope === 'global' && organizationId ? `/api/organizations/${organizationId}/quick-settings/${wf}`
        : scope === 'global' ? `/api/settings/quick/global/${wf}` : `/api/settings/quick/project/${projectId}/${wf}`;
      try { await api(url, { method: 'PUT', body: JSON.stringify({ values }) }); flashSaved(b); } catch (e) { toast(e.message, true); }
    }),
  );
}

const quickDefaultsHeader = () => '';

// ── wiki (org/project skills, memories, and prompts — one content system) ─────
// One view serves both scopes: /<org>/wiki (proj = null) and /<org>/<project>/wiki.
// The left rail lists the wiki tree; the pane shows the Index (every `default`-
// labelled entry rendered in full, plus the table of contents — exactly what
// agents get with each prompt) or the selected entry. The open entry rides in
// the URL hash so wiki pages deep-link like settings panes.
function wikiScopeInfo(proj) {
  if (proj) return { scope: 'project', id: proj.id, title: proj.name, base: `/api/projects/${encodeURIComponent(proj.id)}/wiki` };
  const org = currentOrg();
  if (!org) return null;
  return { scope: 'organization', id: org.id, title: org.name, base: `/api/organizations/${encodeURIComponent(org.id)}/wiki` };
}

function wikiView(proj) {
  const info = wikiScopeInfo(proj);
  if (!info) return `<div class="empty">No organization yet.</div>`;
  return `<div class="organization-settings wiki-page"><div class="settings-header"><div>
      <h1 class="page-title">${esc(info.title)} — wiki</h1>
    </div></div>
    <div class="settings-layout"><nav class="settings-nav wiki-nav" id="wiki-nav" aria-label="Wiki entries"></nav>
    <div class="settings-content" id="wiki-pane"></div></div></div>`;
}

const wikiIsDefault = (e) => (e.labels || []).includes('default');
const wikiGlyph = (e) => (wikiIsDefault(e) ? '✦' : e.kind === 'memory' ? '✎' : '⚡');

function wikiTreeHtml(entries, sel, depth = 0) {
  return (entries || []).map((e) => e.kind === 'section'
    ? `<span class="wiki-sec" style="padding-left:${10 + depth * 12}px">${esc(e.name)}/</span>${wikiTreeHtml(e.children, sel, depth + 1)}`
    : `<a href="#${encodeURIComponent(e.path)}" class="${sel === e.path ? 'active' : ''}" data-wiki-path="${esc(e.path)}"
         style="padding-left:${10 + depth * 12}px" title="${esc(e.description || '')}">${wikiGlyph(e)} ${esc(e.name)}</a>`,
  ).join('');
}

async function wireWikiView(proj) {
  const info = wikiScopeInfo(proj);
  const nav = $('#wiki-nav');
  const pane = $('#wiki-pane');
  if (!info || !nav || !pane) return;
  const key = `${info.scope}:${info.id}`;
  let data;
  try { data = await api(info.base); }
  catch (e) { pane.innerHTML = `<span class="task-sub">${esc(e.message)}</span>`; nav.textContent = ''; return; }
  const sel = decodeURIComponent((location.hash || '').slice(1));

  nav.innerHTML = `<span>${info.scope === 'project' ? 'Project wiki' : 'Organization wiki'}</span>
    <a href="#" class="${sel ? '' : 'active'}" data-wiki-home>◈ Index</a>
    ${wikiTreeHtml(data.toc?.children, sel)}
    <button class="btn sm" id="wiki-new" style="margin:10px 10px 0">＋ New entry</button>`;
  const open = (path) => {
    S.wikiEditing = null;
    history.replaceState({ kx: 1 }, '', location.pathname + (path ? `#${encodeURIComponent(path)}` : ''));
    wireWikiView(proj);
  };
  nav.querySelector('[data-wiki-home]')?.addEventListener('click', (ev) => { ev.preventDefault(); open(''); });
  nav.querySelectorAll('[data-wiki-path]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); open(a.dataset.wikiPath); }));
  $('#wiki-new')?.addEventListener('click', () => renderWikiEditor(info, proj, pane, null));

  // A page fetch goes through the base route so built-ins resolve (a virtual
  // built-in has no on-disk page for /page to find).
  const fetchPage = async (p) => (await api(`${info.base}?path=${encodeURIComponent(p)}`)).page;
  // A background re-render (WS task event) must not blow away an in-progress
  // editor: restore it for the same scope before painting the read view.
  if (S.wikiEditing?.wikiKey === key) {
    if (!S.wikiEditing.path) return renderWikiEditor(info, proj, pane, null);
    try {
      const editing = await fetchPage(S.wikiEditing.path);
      if (editing) return renderWikiEditor(info, proj, pane, editing);
    } catch { /* fall through */ }
    S.wikiEditing = null;
  }
  if (!sel) return renderWikiHome(info, proj, pane, data);
  let page;
  try { page = await fetchPage(sel); } catch { page = null; }
  if (!page) return renderWikiHome(info, proj, pane, data); // stale hash → fall back
  renderWikiPage(info, proj, pane, page);
}

// Everything above the frontmatter fence is metadata; render only the body.
function wikiBody(content) {
  return String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// ── frontmatter ⇄ form (the editor's two faces) ──────────────────────────────
// Mirrors src/wiki/wiki.ts parseFrontmatter, plus strictness: toggling the raw
// YAML view back to the form requires every line to be a valid known scalar.
function parseWikiFm(text) {
  const s = String(text ?? '');
  if (!/^---\r?\n/.test(s)) return { ok: true, fields: {}, body: s };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return { ok: false, error: 'Unterminated frontmatter — missing the closing “---”.' };
  const fields = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) return { ok: false, error: `Invalid frontmatter line: “${line.trim()}”` };
    fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  // Back-compat: an older `delivery: unconditional` folds into the `default` label.
  if (fields.delivery === 'unconditional')
    fields.labels = [...new Set([...parseWikiLabels(fields.labels), 'default'])].join(', ');
  delete fields.delivery;
  if (fields.importance && !Number.isFinite(Number(fields.importance)))
    return { ok: false, error: 'importance must be a number.' };
  return { ok: true, fields, body: s.slice(m[0].length) };
}

// Split a comma-separated (optionally `[a, b]`) labels string into clean tokens.
function parseWikiLabels(raw) {
  return String(raw ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function buildWikiContent(fields, body) {
  const lines = [];
  if (fields.name) lines.push(`name: ${fields.name}`);
  if (fields.description) lines.push(`description: ${fields.description}`);
  const labels = parseWikiLabels(fields.labels);
  if (labels.length) lines.push(`labels: ${labels.join(', ')}`);
  if (fields.importance && Number(fields.importance) !== 0) lines.push(`importance: ${fields.importance}`);
  const text = String(body ?? '').replace(/^\n+/, '');
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${text}` : text;
}

// ── @-mention: tag wiki context into a task prompt ───────────────────────────
// Typing "@" in a prompt opens a dropdown that searches BOTH the project and
// the organization wiki. Picking a result inserts a `@proj:…` / `@org:…` token
// that inlines that page — or a whole label (`@proj:tag:…`) or folder
// (`@proj:…/*`) — into the task's context at run time. Enter picks the top
// (or highlighted) result; ↑/↓ navigate; Esc dismisses; a click picks directly.

// Viewport-relative pixel position of a caret offset inside a textarea, via a
// mirror div that copies the textarea's text metrics (the standard technique).
function textareaCaretXY(ta, pos) {
  const rect = ta.getBoundingClientRect();
  const style = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform',
    'wordSpacing', 'lineHeight', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'])
    mirror.style[p] = style[p];
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word',
    overflow: 'hidden', width: `${ta.clientWidth}px`, top: '0', left: '0',
  });
  mirror.textContent = ta.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = ta.value.slice(pos) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const xy = {
    top: rect.top + marker.offsetTop - ta.scrollTop + lineH,
    left: rect.left + marker.offsetLeft - ta.scrollLeft,
  };
  mirror.remove();
  return xy;
}

function wireWikiMention(ta, projectId) {
  if (!ta || !projectId || ta.dataset.wmWired) return;
  ta.dataset.wmWired = '1';
  const orgId = projectById(projectId)?.organizationId;
  let menu = null, items = [], active = 0, token = null, seq = 0;

  const close = () => { menu?.remove(); menu = null; items = []; token = null; };
  // The @-token immediately before the caret — only at the start or right after
  // whitespace (so `b@`, `\@`, `(@` don't trigger), and never inside an inline
  // code span (odd count of backticks before the @). Mirrors parseWikiRefs.
  const tokenAt = () => {
    const pos = ta.selectionStart;
    if (pos == null || pos !== ta.selectionEnd) return null;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(ta.value.slice(0, pos));
    if (!m) return null;
    const at = pos - m[1].length - 1;
    if ((ta.value.slice(0, at).match(/`/g) || []).length % 2 === 1) return null;
    return { start: at, end: pos, query: m[1] };
  };
  const parseQuery = (q) => /^proj:/i.test(q) ? { scopes: ['project'], q: q.slice(5) }
    : /^org:/i.test(q) ? { scopes: ['organization'], q: q.slice(4) }
    : { scopes: ['project', 'organization'], q };
  const tokenFor = (s) => `@${s.scope === 'project' ? 'proj' : 'org'}:${s.ref}`;
  const glyph = (s) => s.kind === 'label' ? '🏷' : s.kind === 'folder' ? '🗀' : s.scope === 'project' ? '⚡' : '✦';

  const fetchSuggestions = async (q) => {
    const { scopes, q: search } = parseQuery(q);
    const per = await Promise.all(scopes.map((scope) => {
      const id = scope === 'project' ? projectId : orgId;
      if (!id) return Promise.resolve([]);
      const base = scope === 'project' ? `/api/projects/${encodeURIComponent(id)}/wiki` : `/api/organizations/${encodeURIComponent(id)}/wiki`;
      return api(`${base}/suggest?q=${encodeURIComponent(search)}`).then((r) => (r.suggestions || []).map((s) => ({ ...s, scope }))).catch(() => []);
    }));
    // Interleave the scopes so both surface near the top, then cap the list.
    const merged = [], max = Math.max(0, ...per.map((r) => r.length));
    for (let i = 0; i < max; i++) for (const r of per) if (r[i]) merged.push(r[i]);
    return merged.slice(0, 8);
  };

  const highlight = () => menu?.querySelectorAll('.wm-opt').forEach((el, i) => el.classList.toggle('active', i === active));
  const choose = (s) => {
    if (!s || !token) return close();
    const insert = `${tokenFor(s)} `;
    ta.value = ta.value.slice(0, token.start) + insert + ta.value.slice(token.end);
    const caret = token.start + insert.length;
    close();
    ta.setSelectionRange(caret, caret);
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const render = () => {
    if (!menu) { menu = document.createElement('div'); menu.className = 'wiki-mention-menu'; document.body.appendChild(menu); }
    menu.innerHTML = items.length ? items.map((s, i) => `
      <div class="wm-opt ${i === active ? 'active' : ''}" data-i="${i}">
        <span class="wm-glyph">${glyph(s)}</span>
        <span class="wm-main"><span class="wm-ref">${esc(tokenFor(s))}</span>${
          s.description ? `<span class="wm-desc">${esc(s.description)}</span>`
          : s.count != null ? `<span class="wm-desc">${s.count} page${s.count === 1 ? '' : 's'}</span>` : ''
        }</span>
        <span class="wm-scope">${s.scope === 'project' ? 'project' : 'org'}</span>
      </div>`).join('') : `<div class="wm-empty">No matching wiki pages</div>`;
    menu.querySelectorAll('.wm-opt').forEach((el) => {
      el.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(items[+el.dataset.i]); });
      el.addEventListener('mouseenter', () => { active = +el.dataset.i; highlight(); });
    });
    const xy = textareaCaretXY(ta, token.start);
    menu.style.left = `${Math.min(xy.left, window.innerWidth - 380)}px`;
    menu.style.top = `${xy.top}px`;
  };
  const update = async () => {
    token = tokenAt();
    if (!token) return close();
    const my = ++seq;
    const found = await fetchSuggestions(token.query);
    if (my !== seq) return;               // superseded by a newer keystroke
    token = tokenAt();
    if (!token) return close();           // caret moved off the token meanwhile
    items = found; active = 0;
    render();
  };

  ta.addEventListener('input', update);
  ta.addEventListener('click', () => { if (!tokenAt()) close(); });
  // Registered before the box's own send/submit keydown, so while the menu is
  // open these keys drive it and stopImmediatePropagation keeps them from ALSO
  // reaching the ⌘/Ctrl-Enter send/submit or Esc-close-form handlers.
  ta.addEventListener('keydown', (ev) => {
    if (!menu) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(); }
    else if (!items.length) return;
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopImmediatePropagation(); active = (active + 1) % items.length; highlight(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopImmediatePropagation(); active = (active - 1 + items.length) % items.length; highlight(); }
    else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); ev.stopImmediatePropagation(); choose(items[active]); }
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('resize', close);
}

// ── the path-as-title control ────────────────────────────────────────────────
// A single-line contenteditable where the stem (after the last slash) is the
// large title and any parent sections shrink into a prefix.
function caretOffsetIn(el) {
  const s = window.getSelection();
  if (!s?.rangeCount || !el.contains(s.anchorNode)) return null;
  const pre = s.getRangeAt(0).cloneRange();
  const end = s.getRangeAt(0);
  pre.selectNodeContents(el);
  pre.setEnd(end.endContainer, end.endOffset);
  return pre.toString().length;
}
function setCaretIn(el, offset) {
  if (offset == null) return;
  const sel = window.getSelection();
  const range = document.createRange();
  let left = offset;
  let placed = false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (left <= node.textContent.length) { range.setStart(node, left); range.collapse(true); placed = true; break; }
    left -= node.textContent.length;
  }
  if (!placed) { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
}
function wikiPathValue(el) {
  return el.textContent.replace(/\s+/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
function wireWikiPathEditor(el, warnEl, kindOf) {
  const restyle = () => {
    const text = el.textContent.replace(/[\r\n]/g, '');
    const caret = caretOffsetIn(el);
    const cut = text.lastIndexOf('/') + 1;
    el.innerHTML = (cut ? `<span class="wiki-path-prefix">${esc(text.slice(0, cut))}</span>` : '') +
      `<span class="wiki-path-stem">${esc(text.slice(cut))}</span>`;
    setCaretIn(el, caret);
    const ext = /\.[A-Za-z0-9]{1,6}$/.test(wikiPathValue(el));
    warnEl.hidden = !ext;
    if (ext) warnEl.textContent = `That looks like a file extension — this is the entry's folder path; the file itself will be ${kindOf() === 'memory' ? 'MEMORY.md' : 'SKILL.md'}.`;
  };
  el.addEventListener('input', restyle);
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });
  el.addEventListener('paste', (ev) => {
    ev.preventDefault();
    document.execCommand('insertText', false, (ev.clipboardData?.getData('text/plain') || '').replace(/\s+/g, ''));
  });
  restyle();
}

// ── panes ────────────────────────────────────────────────────────────────────
// Index: exactly what agents receive each turn — every unconditional entry in
// full, then the rendered table of contents (importance order, [more…] folds).
function renderWikiHome(info, proj, pane, data) {
  pane.innerHTML = (data.unconditional || []).map((u) => `
    <div class="card wiki-uncond">
      <div class="wiki-uncond-head"><b>${esc(u.name)}</b>${u.builtin ? '<span class="chip">built-in</span>' : ''}<span class="grow"></span>
        <button class="btn sm wiki-uncond-edit" data-path="${esc(u.path)}">Edit</button></div>
      <div class="msg-text md wiki-md">${renderMessageBody(u.body || '')}</div>
    </div>`).join('') + (data.tocText ? `
    <div class="card wiki-uncond">
      <div class="wiki-uncond-head"><b>Table of contents</b><span class="chip" title="Sent to agents as names and descriptions only; they open entries with read_wiki">titles only</span></div>
      <div class="msg-text md wiki-md">${renderMessageBody(data.tocText)}</div>
    </div>` : '');
  typesetMath(pane);
  pane.querySelectorAll('.wiki-uncond-edit').forEach((b) => b.addEventListener('click', async () => {
    try {
      const read = await api(`${info.base}?path=${encodeURIComponent(b.dataset.path)}`);
      if (!read.page) return toast('Entry not found', true);
      history.replaceState({ kx: 1 }, '', `${location.pathname}#${encodeURIComponent(read.page.path)}`);
      renderWikiEditor(info, proj, pane, read.page);
    } catch (e) { toast(e.message, true); }
  }));
}

function renderWikiPage(info, proj, pane, page) {
  // A built-in is always editable (the edit shadows the bundled default); its
  // delete button appears only once customized, and restores that default.
  const remove = page.builtin
    ? (page.overridden ? '<button class="btn sm danger" id="wiki-page-delete">Restore default</button>' : '')
    : '<button class="btn sm danger" id="wiki-page-delete">Delete</button>';
  pane.innerHTML = `<div class="settings-section-title"><div>${esc(page.name)}
      <span class="chip">${page.kind}</span><span class="chip">${esc(page.path)}</span>
      ${wikiIsDefault(page) ? '<span class="chip active" title="Labelled “default” — inlined into every task’s prompt">always in prompt</span>' : ''}
      ${(page.labels || []).filter((l) => l !== 'default').map((l) => `<span class="chip">${esc(l)}</span>`).join('')}
      ${page.builtin ? '<span class="chip">built-in</span>' : ''}
      ${page.overridden ? '<span class="chip">customized</span>' : ''}
      ${page.description ? `<small>${esc(page.description)}</small>` : ''}</div></div>
    <div class="card">
      <div class="msg-text md wiki-md">${renderMessageBody(wikiBody(page.content))}</div>
      ${page.files?.length ? `<div class="settings-divider"></div><div class="task-sub">${page.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
      <div class="inline-form" style="margin-top:10px"><button class="btn sm" id="wiki-page-edit">Edit</button>${remove}</div>
    </div>`;
  typesetMath(pane);
  $('#wiki-page-delete')?.addEventListener('click', async () => {
    const q = page.builtin
      ? `Restore the built-in default for “${page.name}”? Your customized text is discarded.`
      : `Delete “${page.name}” (${page.path})? Its folder and attached files go with it.`;
    if (!confirm(q)) return;
    try {
      await api(`${info.base}/page?path=${encodeURIComponent(page.path)}`, { method: 'DELETE' });
      if (!page.builtin) history.replaceState({ kx: 1 }, '', location.pathname);
      wireWikiView(proj);
    } catch (e) { toast(e.message, true); }
  });
  $('#wiki-page-edit')?.addEventListener('click', () => renderWikiEditor(info, proj, pane, page));
}

// Create (page = null) and edit share one editor: the path-as-title control, the
// frontmatter as a form (raw YAML behind a toggle), and a Write/Preview body.
function renderWikiEditor(info, proj, pane, page) {
  const isNew = !page;
  S.wikiEditing = { wikiKey: `${info.scope}:${info.id}`, path: page?.path ?? null };
  const fm = parseWikiFm(page?.content ?? '');
  // A pristine built-in has no frontmatter of its own — seed the form from its
  // resolved metadata so the first save writes an override that keeps its
  // labels/importance instead of silently dropping them.
  const fields = fm.ok
    ? (page?.builtin
      ? { name: page.name, description: page.description, labels: (page.labels || []).join(', '), importance: page.importance, ...Object.fromEntries(Object.entries(fm.fields).filter(([, v]) => v !== undefined && v !== '')) }
      : fm.fields)
    : {};
  const body = fm.ok ? fm.body : (page?.content ?? '');
  pane.innerHTML = `
    <div class="wiki-title-row">
      <div class="wiki-path-edit" id="wiki-path" contenteditable="${page?.builtin ? 'false' : 'true'}" spellcheck="false"></div>
      ${isNew
        ? `<select id="wiki-kind"><option value="skill">Skill</option><option value="memory">Memory</option></select>`
        : `<span class="chip">${page.kind}</span>${page.builtin ? '<span class="chip">built-in</span>' : ''}`}
    </div>
    <div class="wiki-warn" id="wiki-path-warn" hidden></div>
    <div class="card wiki-editor">
      <div class="wiki-fields" id="wiki-form">
        <label>Name<input id="wf-name" value="${esc(fields.name || '')}" placeholder="defaults to the folder name"></label>
        <label>Description<input id="wf-desc" value="${esc(fields.description || '')}" placeholder="one line for the table of contents"></label>
        <label title="Comma-separated. Every entry is always in the table of contents; a task inlines an entry in full by tagging its label with @proj:tag:… (or @org:tag:…). Add “default” to inline it into every task.">Labels<input id="wf-labels" value="${esc(fields.labels || '')}" placeholder="e.g. default, security"></label>
        <label>Importance<input id="wf-importance" type="number" step="any" value="${esc(fields.importance ?? '')}" placeholder="0"></label>
      </div>
      <div class="wiki-body-bar">
        <button class="wiki-body-tab active" id="wiki-tab-write" type="button">Write</button>
        <button class="wiki-body-tab" id="wiki-tab-preview" type="button">Preview</button>
        <span class="grow"></span>
        <label class="switch"><input type="checkbox" id="wiki-yaml"><span>YAML</span></label>
      </div>
      <textarea id="wiki-body" rows="16">${esc(body)}</textarea>
      <div id="wiki-preview" class="msg-text md wiki-md wiki-preview" hidden></div>
      <textarea id="wiki-raw" rows="20" hidden></textarea>
      <div class="inline-form" style="margin-top:10px"><button class="btn sm primary" id="wiki-save">${isNew ? 'Create' : 'Save'}</button><button class="btn sm" id="wiki-cancel">Cancel</button></div>
    </div>`;
  const pathEl = $('#wiki-path');
  pathEl.textContent = page?.path ?? '';
  const kindOf = () => (isNew ? $('#wiki-kind').value : page.kind);
  wireWikiPathEditor(pathEl, $('#wiki-path-warn'), kindOf);
  $('#wiki-kind')?.addEventListener('change', () => pathEl.dispatchEvent(new Event('input')));
  if (isNew) pathEl.focus();

  const formFields = () => ({
    name: $('#wf-name').value.trim(),
    description: $('#wf-desc').value.trim(),
    labels: $('#wf-labels').value.trim(),
    importance: $('#wf-importance').value.trim(),
  });
  const yamlToggle = $('#wiki-yaml');
  const inYaml = () => yamlToggle.checked;
  yamlToggle.addEventListener('change', () => {
    if (yamlToggle.checked) {
      $('#wiki-raw').value = buildWikiContent(formFields(), $('#wiki-body').value);
      $('#wiki-form').hidden = true;
      $('.wiki-body-bar', pane).hidden = true;
      $('#wiki-body').hidden = true;
      $('#wiki-preview').hidden = true;
      $('#wiki-raw').hidden = false;
      $('#wiki-raw').focus();
    } else {
      const parsed = parseWikiFm($('#wiki-raw').value);
      if (!parsed.ok) { toast(parsed.error, true); yamlToggle.checked = true; return; }
      $('#wf-name').value = parsed.fields.name || '';
      $('#wf-desc').value = parsed.fields.description || '';
      $('#wf-labels').value = parseWikiLabels(parsed.fields.labels).join(', ');
      $('#wf-importance').value = parsed.fields.importance ?? '';
      $('#wiki-body').value = parsed.body;
      $('#wiki-form').hidden = false;
      $('.wiki-body-bar', pane).hidden = false;
      $('#wiki-raw').hidden = true;
      showWrite();
    }
  });
  const showWrite = () => {
    $('#wiki-tab-write').classList.add('active');
    $('#wiki-tab-preview').classList.remove('active');
    $('#wiki-body').hidden = false;
    $('#wiki-preview').hidden = true;
  };
  $('#wiki-tab-write').addEventListener('click', showWrite);
  $('#wiki-tab-preview').addEventListener('click', () => {
    $('#wiki-tab-preview').classList.add('active');
    $('#wiki-tab-write').classList.remove('active');
    const preview = $('#wiki-preview');
    preview.innerHTML = renderMessageBody($('#wiki-body').value) || '<span class="task-sub">Nothing to preview.</span>';
    $('#wiki-body').hidden = true;
    preview.hidden = false;
    typesetMath(preview);
  });

  $('#wiki-cancel').addEventListener('click', () => { S.wikiEditing = null; wireWikiView(proj); });
  $('#wiki-save').addEventListener('click', async () => {
    const path = wikiPathValue(pathEl);
    if (!path) return toast('The entry needs a path', true);
    const body = { path, kind: kindOf(), content: inYaml() ? $('#wiki-raw').value : buildWikiContent(formFields(), $('#wiki-body').value) };
    if (isNew) body.create = true;
    else if (path !== page.path) body.prevPath = page.path;
    try {
      await api(`${info.base}/page`, { method: 'PUT', body: JSON.stringify(body) });
      S.wikiEditing = null;
      history.replaceState({ kx: 1 }, '', `${location.pathname}#${encodeURIComponent(path)}`);
      wireWikiView(proj);
    } catch (e) { toast(e.message, true); }
  });
}
function settingsView(proj) {
  if (!proj) return `<div class="empty">Select a project.</div>`;
  return `<div class="organization-settings"><div class="settings-header"><div><h1 class="page-title">${esc(proj.name)}</h1><p class="settings-intro">Project settings</p></div></div><div class="settings-layout">
    <nav class="settings-nav" aria-label="Project settings sections"><span>Project</span><a href="#project-git">Git &amp; GitHub</a><a href="#project-compute">Compute</a><a href="#project-agents">Agent logins</a><a href="#project-defaults">Task defaults</a><a href="#project-payments">Payments</a><a href="#project-people">People &amp; authorization</a><a href="#project-workflows">Workflows</a><a href="#project-advanced">Advanced</a></nav><div class="settings-content">
    <div class="settings-section-title" id="project-git"><div>Git &amp; GitHub<small>The repositories this project works on, and the identity it commits with</small></div></div>
    <div class="card"><div id="project-repositories">Loading…</div><div class="settings-divider"></div><div id="project-git-profile">Loading Git profiles…</div><a class="btn sm organization-settings-link" href="${globalRoute('organization', organizationById(proj.organizationId))}#settings-code">Organization GitHub connection and Git accounts</a><div id="git-preflight-card" style="margin-top:12px"><button class="btn sm" id="git-preflight-run">Check Git setup</button><div id="git-preflight-result" style="margin-top:8px;font-size:12px"></div></div></div>
    <div class="settings-section-title" id="project-compute"><div>Compute<small>Where this project's tasks run</small></div></div>${cloudEnvironmentCard(proj)}
    <div class="settings-section-title" id="project-agents"><div>Agent logins<small>Which accounts do this project's work, in what order</small></div></div>
    <div class="card"><a class="btn sm organization-settings-link" href="${globalRoute('organization', organizationById(proj.organizationId))}#settings-agents">Manage organization agent logins</a><div class="settings-divider"></div><div class="section-h">Credential order for this project</div><div id="cred-editor-project">Loading…</div></div>
    <div class="settings-section-title" id="project-defaults"><div>Task defaults<small>How new tasks begin, unless a task says otherwise</small></div></div>
    ${settingsForms('project', proj.id)}
    ${profilesCard('project')}
    ${quickSettingsForms('project', proj.id)}
    <div class="settings-section-title" id="project-payments"><div>Payments<small>What this project's tasks may spend</small></div></div>${paymentsCard('project')}
    <div class="settings-section-title" id="project-people"><div>People &amp; authorization<small>Who can work here, and what they may do</small></div></div>
    <div class="card"><div id="project-access">Loading…</div></div>
    ${authorizationCard('project')}
    <div class="settings-section-title" id="project-workflows"><div>Workflows<small>The recipes this project's tasks run on</small></div></div>
    <div class="card" id="wf-pins-card">
      <div class="section-h">Workflow versions</div>
      <div id="wf-pins-list">Loading…</div></div>
    <div class="settings-section-title" id="project-advanced"><div>Advanced<small>Rarely needed — and hard to undo</small></div></div>
    <div class="card" style="border-color:var(--danger-weak)">
      <div class="section-h" style="color:var(--danger)">Danger zone</div>
      <button class="btn danger" id="delete-project">Delete project</button>
    </div></div></div></div>`;
}
function cloudEnvironmentCard(proj) {
  return `<div class="card"><div class="section-h">Where tasks run</div>
    <p class="task-sub">Agent environments (worktree / container / E2B / Daytona), remote-provider connections, runner pools, and the organization budget are set up in <a class="organization-settings-link" href="${globalRoute('organization', organizationById(proj.organizationId))}#settings-compute">Organization → Compute</a>. This section only tightens them for this project.</p>
    <div id="project-execution">Loading organization execution policy…</div>
  </div>`;
}
async function hydrateProjectGitProfile(proj) {
  const box = $('#project-git-profile'); if (!box) return;
  try {
    const [profiles, defaults] = await Promise.all([
      api('/api/git-profiles'),
      api(`/api/settings/project/${encodeURIComponent(proj.id)}/__common__`).catch(() => ({})),
    ]);
    box.innerHTML = `<div class="inline-form"><label>Git profile <select id="project-git-profile-select"><option value="">Organization default${profiles.defaultProfile ? ` — ${esc(profiles.defaultProfile)}` : ''}</option>${profiles.profiles.map((profile) => `<option value="${esc(profile.name)}" ${defaults.gitProfile === profile.name ? 'selected' : ''}>${esc(profile.name)} · ${esc(profile.userName)}</option>`).join('')}</select></label><button class="btn sm" id="project-git-profile-save">Save</button></div>`;
    $('#project-git-profile-save').addEventListener('click', async () => {
      const current = await api(`/api/settings/project/${encodeURIComponent(proj.id)}/__common__`).catch(() => ({}));
      const selected = $('#project-git-profile-select').value;
      if (selected) current.gitProfile = selected; else delete current.gitProfile;
      await api(`/api/settings/project/${encodeURIComponent(proj.id)}/__common__`, { method: 'PUT', body: JSON.stringify({ values: current }) });
      toast('Git profile saved');
    });
  } catch (error) { box.textContent = error.message; }
}
async function hydrateProjectAccess(proj) {
  const accessBox = $('#project-access');
  const repositoryBox = $('#project-repositories');
  if (!accessBox || !repositoryBox) return;
  try {
    const [repositories, members, gitConnections, githubApp] = await Promise.all([
      api(`/api/organizations/${encodeURIComponent(proj.organizationId)}/repositories`),
      api(`/api/projects/${encodeURIComponent(proj.id)}/members`),
      api(`/api/organizations/${encodeURIComponent(proj.organizationId)}/git-connections`).catch(() => []),
      api(`/api/organizations/${encodeURIComponent(proj.organizationId)}/github/app`).catch(() => ({ configured: false })),
    ]);
    const userRecord = (id) => S.organizationMembers.find((member) => member.userId === id)?.user || S.users.find((user) => user.id === id);
    const userName = (id) => userRecord(id)?.name || userRecord(id)?.email?.split('@')[0] || 'Unnamed member';
    const principalName = (principal) => principal.kind === 'user' ? userName(principal.userId)
      : principal.kind === 'organization' ? '@all'
      : `@team:${S.teams.find((team) => team.id === principal.teamId)?.slug || principal.teamId}`;
    const candidates = [
      { value: '@all', aliases: ['@all'], principal: { kind: 'organization', organizationId: proj.organizationId } },
      ...S.teams.map((team) => ({ value: `@team:${team.slug}`, aliases: [`@team:${team.slug}`, team.name], principal: { kind: 'team', teamId: team.id } })),
      ...S.organizationMembers.map((member) => { const record = userRecord(member.userId); const name = userName(member.userId); const value = record?.email ? `${name} — ${record.email}` : name; return { value, aliases: [value, name, record?.email, `user:${member.userId}`].filter(Boolean), principal: { kind: 'user', userId: member.userId } }; }),
    ];
    accessBox.innerHTML = `<div class="section-h">Project access</div>
      ${members.map((member) => { const id = member.principal.userId || member.principal.teamId || member.principal.organizationId; return `<div class="member-row" data-project-member data-kind="${esc(member.principal.kind)}" data-id="${esc(id)}"><span>${esc(principalName(member.principal))}</span>${member.protectedOwner ? '<span class="chip">project creator</span>' : ''}<span class="chip">${esc(member.profileId || 'developer')}</span><button class="btn sm project-member-remove">Remove</button></div>`; }).join('') || '<p class="task-sub">No project access overrides.</p>'}
      <datalist id="project-principal-options">${candidates.map((candidate) => `<option value="${esc(candidate.value)}"></option>`).join('')}</datalist>
      <div class="inline-form"><input id="project-member-principal" list="project-principal-options" placeholder="Type a person, @team:…, or @all"><select id="project-member-profile"><option value="developer">Developer</option><option value="maintainer">Project maintainer</option><option value="operator">Automation operator</option><option value="administrator">Administrator</option></select><button class="btn sm" id="project-member-add">Add</button></div>`;
    repositoryBox.innerHTML = `<div class="section-h">Repositories</div>
      <datalist id="project-repository-options">${repositories.map((repository) => `<option value="${esc(repository.sshUrl)}">${esc(repository.owner)}/${esc(repository.name)}</option>`).join('')}</datalist>
      <div id="project-repository-fields">${((proj.config.repos || []).length ? proj.config.repos : ['']).map((source) => `<div class="inline-form project-repository-field"><input list="project-repository-options" value="${esc(source)}" placeholder="git@github.com:org/repo.git${S.meta?.hosted ? '' : ' or /local/path'}"><button class="btn sm project-repository-remove" aria-label="Remove repository">−</button></div>`).join('')}</div>
      <div class="inline-form"><button class="btn sm" id="project-repository-add">＋ Repository</button><button class="btn sm primary" id="project-repositories-save">Save repositories</button></div>
      ${!githubApp.configured ? '<div class="inline-form"><button class="btn sm primary" id="project-setup-github">Connect GitHub</button></div>'
        : !gitConnections.length ? '<div class="inline-form"><button class="btn sm primary" id="project-connect-github">Choose GitHub repositories</button></div>'
        : `<div class="inline-form"><button class="btn sm" id="project-refresh-github">Refresh from GitHub</button>${githubApp.oauthConfigured && !githubApp.userAuthorized ? '<button class="btn sm" id="project-authorize-github">Authorize repository creation</button>' : ''}</div>
          ${githubApp.userAuthorized ? `<details class="settings-disclosure compact"><summary><b>Create a new GitHub repository</b></summary><div class="inline-form"><select id="project-new-repo-connection">${gitConnections.map((connection) => `<option value="${esc(connection.id)}">${esc(connection.accountLogin)}</option>`).join('')}</select><input id="project-new-repo-name" placeholder="new-repository"><input id="project-new-repo-description" placeholder="Description (optional)"><label class="switch"><input id="project-new-repo-private" type="checkbox" checked><span>Private</span></label><button class="btn sm primary" id="project-new-repo-create">Create and attach</button></div></details>` : ''}`}`;
    $('#project-member-add')?.addEventListener('click', async () => {
      const entered = $('#project-member-principal')?.value.trim().toLowerCase();
      const candidate = candidates.find((item) => item.aliases.some((alias) => alias.toLowerCase() === entered));
      if (!candidate) return toast('Choose a person, @team:…, or @all', true);
      try { await api(`/api/projects/${proj.id}/members`, { method: 'POST', body: JSON.stringify({ principal: candidate.principal, profileId: $('#project-member-profile').value }) }); await hydrateProjectAccess(proj); }
      catch (error) { toast(error.message, true); }
    });
    accessBox.querySelectorAll('[data-project-member]').forEach((row) => row.querySelector('.project-member-remove')?.addEventListener('click', async () => {
      try { await api(`/api/projects/${proj.id}/members/${row.dataset.kind}/${encodeURIComponent(row.dataset.id)}`, { method: 'DELETE' }); await hydrateProjectAccess(proj); }
      catch (error) { toast(error.message, true); }
    }));
    const wireRepositoryRemoves = () => repositoryBox.querySelectorAll('.project-repository-remove').forEach((button) => button.onclick = () => { button.closest('.project-repository-field').remove(); if (!$('#project-repository-fields').children.length) $('#project-repository-add').click(); });
    wireRepositoryRemoves();
    $('#project-repository-add')?.addEventListener('click', () => { $('#project-repository-fields').insertAdjacentHTML('beforeend', `<div class="inline-form project-repository-field"><input list="project-repository-options" placeholder="git@github.com:org/repo.git${S.meta?.hosted ? '' : ' or /local/path'}"><button class="btn sm project-repository-remove" aria-label="Remove repository">−</button></div>`); wireRepositoryRemoves(); });
    $('#project-repositories-save')?.addEventListener('click', async () => { const repos = [...repositoryBox.querySelectorAll('.project-repository-field input')].map((input) => input.value.trim()).filter(Boolean); try { await api(`/api/projects/${proj.id}/repository-sources`, { method: 'PUT', body: JSON.stringify({ repos }) }); await loadProjects(); toast('Repositories saved'); await hydrateProjectAccess(projectById(proj.id)); } catch (error) { toast(error.message, true); } });
    $('#project-setup-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${proj.organizationId}/github/app-manifest`, { method: 'POST', body: JSON.stringify({ publicUrl: location.origin }) }); const form = document.createElement('form'); form.method = 'POST'; form.action = result.action; const manifest = document.createElement('input'); manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest); form.appendChild(manifest); document.body.appendChild(form); form.submit(); } catch (error) { toast(error.message, true); } });
    $('#project-connect-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${proj.organizationId}/github/install-url`, { method: 'POST', body: '{}' }); location.assign(result.url); } catch (error) { toast(error.message, true); } });
    $('#project-authorize-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${proj.organizationId}/github/authorize`, { method: 'POST', body: '{}' }); location.assign(result.url); } catch (error) { toast(error.message, true); } });
    $('#project-refresh-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${proj.organizationId}/github/refresh`, { method: 'POST', body: '{}' }); toast(`Found ${result.count} ${result.count === 1 ? 'repository' : 'repositories'}`); await hydrateProjectAccess(proj); } catch (error) { toast(error.message, true); } });
    $('#project-new-repo-create')?.addEventListener('click', async () => { const name = $('#project-new-repo-name')?.value.trim(); if (!name) return toast('Repository name is required', true); try { const repository = await api(`/api/organizations/${proj.organizationId}/repositories/create`, { method: 'POST', body: JSON.stringify({ gitConnectionId: $('#project-new-repo-connection').value, name, description: $('#project-new-repo-description').value, private: $('#project-new-repo-private').checked }) }); await api(`/api/projects/${proj.id}/repositories`, { method: 'POST', body: JSON.stringify({ repositoryId: repository.id }) }); toast('Repository created and attached'); await loadProjects(); await hydrateProjectAccess(proj); } catch (error) { toast(error.message, true); } });
  } catch (error) { accessBox.innerHTML = repositoryBox.innerHTML = `<span class="task-sub">${esc(error.message)}</span>`; }
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
  wireSettingsNavigation();
  $('#main').querySelectorAll('.organization-settings-link').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    go(link.getAttribute('href'));
  }));
  hydrateProjectAccess(proj);
  hydrateExecutionProviders(proj);
  hydrateProjectGitProfile(proj);
  hydrateSettingsForms('project', proj.id);
  hydrateQuickSettingsForms('project', proj.id);
  wireQuickSettingsSave('project', proj.id);
  renderCredentialEditor($('#cred-editor-project'), 'project', { projectId: proj.id });
  hydrateProfiles('project', proj.id);
  hydrateReviewRoute('project', proj.id);
  hydrateAuthorization('project', proj.id);
  hydrateWorkflowPins(proj.id);
  $('#main').querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', async () => {
      const wf = b.dataset.save;
      const sec = b.closest('[data-wf]');
      const fields = wf === '__common__' ? commonSettingsFields('project')
        : settingsFields(wf, 'project').filter((field) => !COMMON_DEFAULT_NAMES.has(field.name));
      const values = collectForm(sec.querySelector('.wf-form'), fields);
      try {
        if (wf === '__common__') await saveCommonSettings('project', proj.id, undefined, fields.map((f) => f.name), values);
        else await api(`/api/settings/project/${proj.id}/${wf}`, { method: 'PUT', body: JSON.stringify({ values }) });
        await loadProjects(); flashSaved(b);
      } catch (e) { toast(e.message, true); }
    }),
  );
  wirePaymentsCard('project', proj.id, proj.organizationId);
  $('#git-preflight-run')?.addEventListener('click', async () => {
    const out = $('#git-preflight-result');
    const btn = $('#git-preflight-run');
    btn.disabled = true;
    out.innerHTML = 'Checking identity, credentials and remote reachability…';
    try {
      const r = await api(`/api/git-profiles/preflight?projectId=${encodeURIComponent(proj.id)}`);
      out.innerHTML = `<div style="margin-bottom:4px">Tier: <b>${r.tier === 'profile' ? `git profile “${esc(r.profile)}”` : 'host fallback (no profile configured)'}</b></div>` +
        r.checks.map((c) => `<div>${c.ok ? '🟢' : '🔴'} <b>${esc(c.label)}</b> — ${esc(c.detail || (c.ok ? 'ok' : 'failed'))}</div>`).join('');
    } catch (e) {
      out.textContent = e.message;
      out.style.color = 'var(--bad, crimson)';
    } finally { btn.disabled = false; }
  });
  $('#delete-project')?.addEventListener('click', async () => {
    if (!confirm(`Delete project "${proj.name}"? This permanently removes it and all of its tasks. This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${proj.id}`, { method: 'DELETE' });
      toast(`Deleted project "${proj.name}"`);
      const wasCurrent = S.projectId === proj.id;
      await loadProjects();
      if (wasCurrent) {
        // Route into the next remaining project (or the dashboard) so its
        // tasks/tags/views/search all load fresh and the URL stops pointing at
        // the now-deleted project. S.projectId still holds the deleted id here,
        // which keeps applyRoute's switch-guard armed so the old project's view
        // state (query/selected view/cursor) gets cleared.
        const next = S.projects[0];
        if (next) return go(projectRoute(next.id));
        S.projectId = null;
        return go(globalRoute('dashboard'));
      }
      renderRail();
      renderMain();
    } catch (e) { toast(e.message, true); }
  });
}
async function hydrateExecutionProviders(proj) {
  const box = $('#project-execution'); if (!box) return;
  try {
    const [policy, connections, pools] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(proj.id)}/execution-policy`),
      api(`/api/organizations/${encodeURIComponent(proj.organizationId)}/world-providers`),
      api(`/api/organizations/${encodeURIComponent(proj.organizationId)}/runner-pools`),
    ]);
    S.worldProviderConnections = connections;
    // The Agent environment (worktree / container / E2B / Daytona) now lives in
    // Task defaults — and can be overridden per task. Compute keeps the runner
    // pool, network policy, world flavor, and budget, so the pool list is filtered
    // by the effective environment (shown read-only here).
    const environment = policy.effective.worldProvider || 'worktree';
    const networkOverride = policy.override.network;
    const networkMode = networkOverride ? (networkOverride.unrestricted ? 'unrestricted' : 'restricted') : '';
    box.innerHTML = `<div class="settings-grid">
      <label class="form-row">Runner pool<select id="project-execution-pool"></select></label>
      <label class="form-row">World experience<select id="project-execution-flavor"><option value="">Organization default — ${esc(policy.organization.environment?.flavor || 'headless')}</option><option value="headless" ${policy.override.environment?.flavor === 'headless' ? 'selected' : ''}>Headless · coding + browser MCP</option><option value="desktop" ${policy.override.environment?.flavor === 'desktop' ? 'selected' : ''}>Desktop · adds GUI + noVNC</option></select></label>
      <label class="form-row">Outbound network<select id="project-execution-network"><option value="" ${networkMode === '' ? 'selected' : ''}>Organization default — ${policy.organization.network?.unrestricted !== false ? 'normal internet' : 'restricted'}</option><option value="unrestricted" ${networkMode === 'unrestricted' ? 'selected' : ''}>Normal internet access (recommended)</option><option value="restricted" ${networkMode === 'restricted' ? 'selected' : ''}>Restricted allowlist</option></select></label>
      <label class="form-row">Optional tighter project budget (USD/month)<input id="project-execution-budget" type="number" min="0" step="0.01" value="${policy.override.monthlyBudgetMicros == null ? '' : esc(policy.override.monthlyBudgetMicros / 1e6)}" placeholder="Use organization budget" /></label>
    </div>
    <details id="project-network-restrictions" ${networkMode === 'restricted' ? 'open' : ''}><summary class="task-sub">Project restricted-network allowlist</summary><label class="form-row">Allowed domains<input id="project-execution-domains" value="${esc((networkOverride?.allowDomains || []).join(', '))}" placeholder="registry.npmjs.org, pypi.org" /></label><label class="form-row">Allowed CIDRs<input id="project-execution-cidrs" value="${esc((networkOverride?.allowCidrs || []).join(', '))}" placeholder="10.20.0.0/16" /></label></details>
    <div class="task-sub">Agent environment: <b>${esc(environment)}</b> — change it in <a href="#project-defaults">Task defaults</a> (or per task). Effective: ${esc(policy.effective.environment?.flavor || 'headless')} · ${policy.effective.resources?.cpu || 2} CPU · ${policy.effective.resources?.memoryMb || 2048} MiB · ${policy.effective.network?.unrestricted ? 'normal outbound internet' : 'restricted outbound'}</div>
    <button class="btn sm primary" id="project-execution-save">Save compute override</button>`;
    const matching = pools.filter((pool) => pool.provider === environment && pool.enabled);
    $('#project-execution-pool').innerHTML = `<option value="">${environment === policy.organization.worldProvider ? 'Organization/default pool' : 'Provider-managed default'}</option>${matching.map((pool) => `<option value="${esc(pool.id)}" ${pool.id === (policy.override.runnerPoolId || '') ? 'selected' : ''}>${esc(pool.name)}</option>`).join('')}`;
    $('#project-execution-network')?.addEventListener('change', (event) => {
      $('#project-network-restrictions').open = event.target.value === 'restricted';
    });
    $('#project-execution-save')?.addEventListener('click', async () => {
      const pool = $('#project-execution-pool').value;
      const budget = $('#project-execution-budget').value.trim();
      const selectedNetwork = $('#project-execution-network').value;
      const split = (selector) => $(selector).value.split(',').map((value) => value.trim()).filter(Boolean);
      try {
        await api(`/api/projects/${proj.id}/execution-policy`, { method: 'PUT', body: JSON.stringify({ override: {
          runnerPoolId: pool || null,
          environment: $('#project-execution-flavor').value ? { flavor: $('#project-execution-flavor').value } : null,
          network: selectedNetwork === '' ? null : selectedNetwork === 'unrestricted' ? { unrestricted: true }
            : { unrestricted: false, allowDomains: split('#project-execution-domains'), allowCidrs: split('#project-execution-cidrs') },
          monthlyBudgetMicros: budget === '' ? null : Math.round(Number(budget) * 1e6),
        } }) });
        await loadProjects(); toast('Project compute override saved'); await hydrateExecutionProviders(proj);
      } catch (error) { toast(error.message, true); }
    });
  } catch (error) { toast(`Could not load compute providers: ${error.message}`, true); }
}

// ── organization defaults (legacy APIs still call this global scope) ─────────
function globalSettingsView(embedded = false) {
  return `
    ${embedded ? '<div class="settings-section-title" id="settings-defaults"><div>Task defaults<small>How new tasks begin, unless a project or task says otherwise</small></div></div>' : '<div class="page-title">Organization settings</div><p style="color:var(--ink-2);margin-top:-8px">How new tasks behave unless a project or task deliberately changes something.</p>'}
    ${settingsForms('global')}
    ${profilesCard('global')}
    ${quickDefaultsHeader(`Applied to tasks added straight from the quick-task box (not the full “⋯ More” form). Each field inherits from the organization's general defaults above until you set it here.`)}
    ${quickSettingsForms('global')}
    ${authorizationCard('global')}
    <div class="settings-section-title" id="settings-payments"><div>Passwords &amp; payments<small>Credentials agents may use on your behalf, and what tasks may spend</small></div></div>
    ${vaultCard()}
    ${connectorsCard()}
    ${vaultRequestsCard()}
    ${mailboxProviderCard()}
    ${agentMailCard()}
    ${paymentsCard('global')}
    <div class="settings-section-title" id="settings-agents"><div>Agent logins<small>The Claude and Codex accounts that do the work</small></div></div>
    <div class="card" id="accounts-card">
      <div class="section-h">Agent accounts <span class="chip">installation resource</span></div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">The installation's logins and API keys, with organization defaults controlling how tasks use them. <b>Drag</b> to set precedence; toggle <b>On/Off</b>. Projects and tasks can narrow or reorder the pool.</p>
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
    <div class="card" id="git-accounts-card">
      <div class="section-h">Git accounts <span class="chip">installation resource</span></div>
      <p style="color:var(--ink-2);margin-top:0;font-size:12px">Named commit identities and SSH credentials for repository work. Secrets go straight to the encrypted vault and are injected only into the git subprocess that needs them.</p>
      <div id="git-profiles-list" style="margin-bottom:12px">Loading…</div>
      <div class="form-row"><label>Add / update a profile</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="gitp-name" placeholder="profile name (e.g. personal)" style="width:160px" />
          <input id="gitp-username" placeholder="git user.name" style="flex:1;min-width:130px" />
          <input id="gitp-email" placeholder="git user.email" style="flex:1;min-width:160px" />
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">
          <input id="gitp-token" type="password" placeholder="GitHub token (optional)" style="flex:1;min-width:160px" />
          <textarea id="gitp-ssh" placeholder="SSH private key for push/fetch (optional)" rows="1" style="flex:1;min-width:160px"></textarea>
          <textarea id="gitp-signing" placeholder="SSH signing key (optional)" rows="1" style="flex:1;min-width:160px"></textarea>
          <button class="btn primary" id="gitp-save">Save</button>
        </div>
        <div id="gitp-result" style="font-size:12px;margin-top:6px"></div>
        <div style="font-size:11px;color:var(--ink-3);margin-top:4px">Re-saving a profile with a blank secret keeps the stored one. Interactive auth (password prompts at push) is never supported — configure a profile, or pre-authorize the host non-interactively.</div>
      </div>
    </div>
    <div class="settings-section-title" id="settings-installation"><div>Workflows<small>The orchestration recipes tasks run on</small></div></div>
    <div class="card" id="workflows-card">
      <div class="section-h">Workflows <span class="chip">installation resource</span></div>
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
    <div class="card" id="resilience-card">
      <div class="section-h">Resilience</div>
      <div class="switch"><input type="checkbox" id="safe-mode" ${S.meta?.safeMode ? 'checked' : ''} /><label for="safe-mode">Installation safe mode (boot vanilla: all overlays off)</label></div>
    </div>`;
}

async function hydrateGitProfiles() {
  const box = $('#git-profiles-list');
  if (!box) return;
  let data = { profiles: [], defaultProfile: null };
  try { data = await api('/api/git-profiles'); } catch { box.innerHTML = '<span style="color:var(--ink-3)">Could not load git profiles.</span>'; return; }
  if (!data.profiles.length) { box.innerHTML = '<span style="color:var(--ink-3)">No git profiles yet — worlds use the host’s own git setup.</span>'; return; }
  box.innerHTML = data.profiles.map((p) => `<div class="queue-item" data-gitp="${esc(p.name)}">
      <div style="flex:1"><b>${esc(p.name)}</b>
        ${data.defaultProfile === p.name ? '<span class="chip">default</span>' : `<button class="btn sm" data-gitp-default="${esc(p.name)}">make default</button>`}
        <span class="task-sub" style="color:var(--ink-3)">${esc(p.userName)} &lt;${esc(p.userEmail)}&gt;</span>
        <div class="task-sub" style="color:var(--ink-3)">${[p.sshKey ? 'ssh key' : null, p.signingKey ? 'signing key' : null, p.githubToken ? 'github token' : null].filter(Boolean).join(' · ') || 'identity only'}</div>
      </div>
      <button class="btn sm danger" data-gitp-del="${esc(p.name)}">Delete</button>
    </div>`).join('');
  box.querySelectorAll('[data-gitp-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete git profile "${b.dataset.gitpDel}" (and its stored secrets)?`)) return;
    try { await api(`/api/git-profiles/${encodeURIComponent(b.dataset.gitpDel)}`, { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
    hydrateGitProfiles();
  }));
  box.querySelectorAll('[data-gitp-default]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/git-profiles/default', { method: 'POST', body: JSON.stringify({ name: b.dataset.gitpDefault }) }); } catch (e) { toast(e.message, true); }
    hydrateGitProfiles();
  }));
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
      <p style="color:var(--ink-2);margin:0 0 6px;font-size:12px">How this installation pays. Projects can have narrower cards and policies; karmax never stores card numbers.</p>
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
async function wirePaymentsCard(scope, projectId, organizationId) {
  const box = $(`[data-payments="${scope}"]`);
  if (!box) return;
  // Non-project cards belong to the organization (tenant boundary), not the
  // whole installation. `scope==='global'` here is the org-settings surface.
  const orgQ = organizationId ? `organizationId=${encodeURIComponent(organizationId)}` : '';
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
    const q = [projectId ? `projectId=${projectId}` : '', orgQ].filter(Boolean).join('&');
    try { cards = await api(`/api/cards${q ? `?${q}` : ''}`); } catch {}
    // The org-settings surface shows the org's own cards (+ legacy global);
    // the project surface shows project cards (its org's cards appear too).
    if (scope === 'global') cards = cards.filter((c) => c.scope === 'organization' || c.scope === 'global');
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
      await api(`/api/cards${orgQ ? `?${orgQ}` : ''}`, { method: 'POST', body: JSON.stringify({ scope: scope === 'project' ? 'project' : 'organization', projectId: scope === 'project' ? projectId : undefined, label, cap: Math.round(Number(cap || 0) * 100) }) });
      box.querySelector('.card-label').value = '';
      box.querySelector('.card-cap').value = '';
      toast('Card added');
      renderCards();
    } catch (e) { toast(e.message, true); }
  });
}

// ── vault items + credential access requests (PLAN-passwords.md §§4–10) ──────
const VAULT_SECRET_LABELS = {
  login: [['password', 'password'], ['totp', 'TOTP seed (base32 or otpauth:// URI)']],
  'api-key': [['secret', 'API key']],
  'ssh-key': [['privateKey', 'private key (PEM)']],
  env: [['env', '.env contents (KEY=VALUE per line)']],
  note: [['note', 'note']],
};
function vaultCard() {
  return `<div class="card" id="vault-card">
    <div class="section-h">Credential vault <span class="chip">installation resource</span></div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">Site logins, API keys, SSH keys, and .env bags agents may use on your behalf. Secrets are encrypted at rest and <b>write-only</b> here; agents use them through grants you attach per task (or approve when an agent asks). Policy <b>use</b> covers browser fill and env injection (the agent never sees the secret); <b>reveal</b> is plaintext to the agent.</p>
    <div class="vault-items-list" style="margin-bottom:12px">Loading…</div>
    <div style="font-weight:600;margin-bottom:4px">Add an item</div>
    <div class="form-row"><div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="vi-type">${Object.keys(VAULT_SECRET_LABELS).map((t) => `<option>${t}</option>`).join('')}</select>
      <input class="vi-label" placeholder="label (e.g. GitHub — alice)" style="flex:1;min-width:140px" />
      <input class="vi-domains" placeholder="domains (e.g. github.com)" style="flex:1;min-width:140px" />
      <input class="vi-username" placeholder="username" style="min-width:120px" />
      <input class="vi-envvar" placeholder="env var (api/ssh keys)" style="min-width:140px;display:none" />
    </div></div>
    <div class="vault-secret-rows"></div>
    <div class="form-row"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label style="font-size:12px">use <select class="vi-use"><option>auto</option><option>ask</option></select></label>
      <label style="font-size:12px">reveal <select class="vi-reveal"><option>ask</option><option>auto</option><option>never</option></select></label>
      <button class="btn primary vi-add">Add to vault</button>
    </div></div>
  </div>`;
}
function vaultRequestsCard() {
  return `<div class="card" id="vault-requests-card">
    <div class="section-h">Credential access requests</div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">Agents escalate here when a task needs a credential it wasn't granted (or one that isn't in the vault yet — add it above, then approve, or tell the agent to create the account itself). <b>Once</b> allows a single use; <b>this task</b> extends the task's grant; <b>always</b> also flips the item's policy to auto.</p>
    <div class="vault-requests-list">Loading…</div>
  </div>`;
}
async function wireVaultCards(organizationId) {
  const box = $('#vault-card');
  if (!box) return;
  // Vault items + requests are organization-scoped; every call carries the org.
  const oq = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
  const secretRows = () => {
    const type = box.querySelector('.vi-type').value;
    box.querySelector('.vi-envvar').style.display = type === 'api-key' || type === 'ssh-key' ? '' : 'none';
    box.querySelector('.vault-secret-rows').innerHTML = VAULT_SECRET_LABELS[type].map(([field, label]) =>
      `<div class="form-row"><label>${esc(label)}</label>${field === 'env' || field === 'privateKey' || field === 'note'
        ? `<textarea class="vi-secret" data-field="${field}" rows="3" style="width:100%"></textarea>`
        : `<input class="vi-secret" data-field="${field}" type="password" autocomplete="off" />`}</div>`).join('');
  };
  secretRows();
  box.querySelector('.vi-type').addEventListener('change', secretRows);
  const renderItems = async () => {
    let items = [];
    try { items = await api(`/api/vault/items${oq}`); } catch {}
    const list = box.querySelector('.vault-items-list');
    list.innerHTML = items.length
      ? items.map((i) => `<div class="queue-item" data-vi="${esc(i.id)}">
          <div style="flex:1"><b>${esc(i.label)}</b> <span class="chip">${esc(i.type)}</span>
            ${i.username ? `<span class="mono" style="color:var(--ink-3);font-size:11px">${esc(i.username)}</span>` : ''}
            <div class="task-sub" style="color:var(--ink-3)">${esc((i.domains || []).join(', '))}${i.tags?.length ? ` · tags: ${esc(i.tags.join(', '))}` : ''}${i.provenance?.source?.startsWith('task:') ? ' · created by an agent' : ''} · secrets: ${esc((i.fields || []).join(', ') || 'none')}</div></div>
          <label style="font-size:11px">use <select class="vi-pol-use">${['auto', 'ask'].map((v) => `<option ${i.policy?.use === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label style="font-size:11px">reveal <select class="vi-pol-reveal">${['auto', 'ask', 'never'].map((v) => `<option ${i.policy?.reveal === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <button class="btn sm" data-vi-del="${esc(i.id)}">Delete</button></div>`).join('')
      : '<span style="color:var(--ink-3)">No vault items yet.</span>';
    list.querySelectorAll('[data-vi]').forEach((row) => {
      const item = items.find((x) => x.id === row.dataset.vi);
      const savePolicy = async () => {
        try {
          await api(`/api/vault/items${oq}`, { method: 'POST', body: JSON.stringify({ id: item.id, type: item.type, label: item.label, domains: item.domains, username: item.username, tags: item.tags, envVar: item.envVar, policy: { use: row.querySelector('.vi-pol-use').value, reveal: row.querySelector('.vi-pol-reveal').value } }) });
          toast('Policy saved');
        } catch (e) { toast(e.message, true); }
      };
      row.querySelector('.vi-pol-use').addEventListener('change', savePolicy);
      row.querySelector('.vi-pol-reveal').addEventListener('change', savePolicy);
    });
    list.querySelectorAll('[data-vi-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this vault item (and its secrets)?')) return;
      try { await api(`/api/vault/items/${b.dataset.viDel}${oq}`, { method: 'DELETE' }); renderItems(); } catch (e) { toast(e.message, true); }
    }));
    return items;
  };
  box.querySelector('.vi-add').addEventListener('click', async () => {
    const secrets = {};
    box.querySelectorAll('.vi-secret').forEach((el) => { if (el.value) secrets[el.dataset.field] = el.value; });
    try {
      await api(`/api/vault/items${oq}`, { method: 'POST', body: JSON.stringify({
        type: box.querySelector('.vi-type').value,
        label: box.querySelector('.vi-label').value,
        domains: box.querySelector('.vi-domains').value,
        username: box.querySelector('.vi-username').value || undefined,
        envVar: box.querySelector('.vi-envvar').value || undefined,
        policy: { use: box.querySelector('.vi-use').value, reveal: box.querySelector('.vi-reveal').value },
        secrets,
      }) });
      box.querySelectorAll('.vi-label,.vi-domains,.vi-username,.vi-envvar,.vi-secret').forEach((el) => (el.value = ''));
      toast('Added to the vault');
      await renderItems();
      renderRequests();
    } catch (e) { toast(e.message, true); }
  });
  const renderRequests = async () => {
    const rbox = $('#vault-requests-card .vault-requests-list');
    if (!rbox) return;
    let requests = [];
    let items = [];
    try { [requests, items] = await Promise.all([api(`/api/vault/requests${oq}`), api(`/api/vault/items${oq}`)]); } catch {}
    const pending = requests.filter((r) => r.status === 'pending');
    const recent = requests.filter((r) => r.status !== 'pending').slice(-5).reverse();
    const itemLabel = (id) => items.find((i) => i.id === id)?.label || id;
    rbox.innerHTML = (pending.length
      ? pending.map((r) => `<div class="queue-item" data-vreq="${esc(r.id)}">
          <div style="flex:1"><b>${r.itemId ? esc(itemLabel(r.itemId)) : `${esc(r.domain || '?')} <span class="chip" style="color:var(--warn,#e0b15a)">not in vault</span>`}</b>
            <span class="chip">${esc(r.mode)}</span>
            <div class="task-sub" style="color:var(--ink-3)">task <a data-spa href="#" onclick="return false">${esc(r.taskId)}</a>${r.why ? ` — ${esc(r.why)}` : ''}</div></div>
          ${r.itemId ? '' : `<select class="vreq-bind"><option value="">bind to item…</option>${items.map((i) => `<option value="${esc(i.id)}">${esc(i.label)}</option>`).join('')}</select>`}
          <button class="btn sm" data-vreq-act="once">Once</button>
          <button class="btn sm" data-vreq-act="task">This task</button>
          <button class="btn sm" data-vreq-act="always">Always</button>
          <button class="btn sm" data-vreq-act="deny">Deny</button></div>`).join('')
      : '<span style="color:var(--ink-3)">No pending requests.</span>')
      + (recent.length ? `<div class="task-sub" style="color:var(--ink-3);margin-top:8px">${recent.map((r) => `${r.status} · ${r.itemId ? esc(itemLabel(r.itemId)) : esc(r.domain || '?')} (${esc(r.resolution?.action || '')})`).join('<br>')}</div>` : '');
    rbox.querySelectorAll('[data-vreq]').forEach((row) => row.querySelectorAll('[data-vreq-act]').forEach((b) => b.addEventListener('click', async () => {
      const itemId = row.querySelector('.vreq-bind')?.value || undefined;
      try {
        await api(`/api/vault/requests/${row.dataset.vreq}/resolve${oq}`, { method: 'POST', body: JSON.stringify({ action: b.dataset.vreqAct, itemId }) });
        toast(b.dataset.vreqAct === 'deny' ? 'Denied' : 'Granted — tell the task to retry (or it will pick it up next turn)');
        renderRequests();
      } catch (e) { toast(e.message, true); }
    })));
  };
  await renderItems();
  await renderRequests();
}

// ── connectors: mirror an external password store into the vault (§9) ─────────
function connectorsCard() {
  return `<div class="card" id="connectors-card">
    <div class="section-h">Password-store connectors</div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">Mirror selected items from Bitwarden, 1Password, or unix <code>pass</code> into the vault above. This is a <b>selective mirror</b>, not a live proxy — agents always resolve credentials from the karmax vault, so a store being down never blocks them. Connect the store's CLI (installed on this host), pick items, and sync.</p>
    <div class="connectors-list">Loading…</div>
  </div>`;
}
async function wireConnectorsCard(organizationId) {
  const box = $('#connectors-card');
  if (!box) return;
  const oq = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
  const list = box.querySelector('.connectors-list');
  let conns = [];
  try { conns = await api(`/api/vault/connectors${oq}`); } catch { list.innerHTML = '<span style="color:var(--ink-3)">Connectors need a credential broker.</span>'; return; }
  list.innerHTML = conns.map((c) => `<div class="queue-item" data-conn="${esc(c.name)}" style="flex-wrap:wrap">
    <div style="flex:1;min-width:180px"><b>${esc(c.label)}</b> ${c.available ? '<span class="chip" style="color:var(--ok,#4ec9a3)">ready</span>' : '<span class="chip">not ready</span>'}
      <div class="task-sub" style="color:var(--ink-3)">${esc(c.detail)}${c.config?.lastSync ? ` · last sync: ${c.config.lastSync.count} item(s)` : ''}</div></div>
    ${c.name === 'pass' ? '' : `<input class="conn-secret" type="password" placeholder="${c.name === 'bitwarden' ? 'bw session key' : 'op service-account token'}" style="min-width:160px" /><button class="btn sm" data-conn-connect>Connect</button>`}
    ${c.canPush ? `<label style="font-size:11px" title="Let agents push accounts they create back to this store"><input type="checkbox" class="conn-writeback" ${c.config?.writeBack ? 'checked' : ''}/> write-back</label>` : ''}
    <button class="btn sm" data-conn-list ${c.available ? '' : 'disabled'}>Browse &amp; sync</button>
    <div class="conn-items" style="flex-basis:100%;margin-top:6px"></div></div>`).join('')
    || '<span style="color:var(--ink-3)">No connectors.</span>';
  list.querySelectorAll('[data-conn]').forEach((row) => {
    const name = row.dataset.conn;
    row.querySelector('[data-conn-connect]')?.addEventListener('click', async () => {
      const secret = row.querySelector('.conn-secret').value;
      try { await api(`/api/vault/connectors/${name}/connect${oq}`, { method: 'POST', body: JSON.stringify({ secret }) }); toast('Connected'); wireConnectorsCard(organizationId); } catch (e) { toast(e.message, true); }
    });
    row.querySelector('.conn-writeback')?.addEventListener('change', async (e) => {
      try { await api(`/api/vault/connectors/${name}/config${oq}`, { method: 'POST', body: JSON.stringify({ writeBack: e.target.checked }) }); toast('Saved'); } catch (err) { toast(err.message, true); }
    });
    row.querySelector('[data-conn-list]')?.addEventListener('click', async () => {
      const target = row.querySelector('.conn-items');
      target.innerHTML = 'Loading…';
      try {
        const items = await api(`/api/vault/connectors/${name}/list${oq}`, { method: 'POST', body: '{}' });
        target.innerHTML = items.length
          ? `<div style="max-height:200px;overflow:auto;border:1px solid var(--line,#333);border-radius:6px;padding:6px">${items.map((i) => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;margin:1px 0"><input type="checkbox" class="conn-pick" value="${esc(i.externalId)}"/> ${esc(i.label)} <span class="mono" style="color:var(--ink-3);font-size:11px">${esc(i.type)}${i.domains?.length ? ' · ' + esc(i.domains.join(',')) : ''}</span></label>`).join('')}</div>
            <button class="btn sm primary" data-conn-sync style="margin-top:6px">Sync selected</button>`
          : '<span style="color:var(--ink-3)">No mirrorable items.</span>';
        target.querySelector('[data-conn-sync]')?.addEventListener('click', async () => {
          const externalIds = [...target.querySelectorAll('.conn-pick:checked')].map((b) => b.value);
          if (!externalIds.length) { toast('Select items first', true); return; }
          try { const r = await api(`/api/vault/connectors/${name}/sync${oq}`, { method: 'POST', body: JSON.stringify({ externalIds }) }); toast(`Mirrored ${r.count} item(s)`); wireVaultCards(organizationId); wireConnectorsCard(organizationId); } catch (e) { toast(e.message, true); }
        });
      } catch (e) { target.innerHTML = `<span style="color:var(--warn,#e0b15a)">${esc(e.message)}</span>`; }
    });
  });
}

// ── mailbox provider: connect an email backend once for the whole install ─────
function mailboxProviderCard() {
  return `<div class="card" id="mailbox-provider-card">
    <div class="section-h">Agent email service <span class="chip">installation-wide</span></div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">Connect an email backend <b>once</b> and every organization automatically gets a working agent address — no per-user setup. <b>Your own domain</b>: enter a domain you control and forward its mail to karmax. <b>Hosted mailbox</b>: connect a managed service with one key, zero DNS.</p>
    <div class="mailbox-providers">Loading…</div>
  </div>`;
}
async function wireMailboxProviderCard() {
  const box = $('#mailbox-provider-card');
  if (!box) return;
  const list = box.querySelector('.mailbox-providers');
  let data = { providers: [], active: null, domain: null };
  try { data = await api('/api/agent-mail/providers'); } catch { box.remove(); return; } // no settings:write ⇒ hidden
  list.innerHTML = data.providers.map((p) => `<div class="queue-item" data-mp="${esc(p.name)}" style="flex-wrap:wrap">
    <div style="flex:1;min-width:180px"><b>${esc(p.label)}</b> ${p.name === data.active && p.connected ? '<span class="chip" style="color:var(--ok,#4ec9a3)">active</span>' : p.connected ? '<span class="chip">connected</span>' : ''}
      <div class="task-sub" style="color:var(--ink-3)">${esc(p.help || '')}</div></div>
    ${p.kind === 'domain'
      ? `<input class="mp-input" placeholder="agents.yourcompany.com" style="min-width:180px" /><button class="btn sm" data-mp-connect>Use this domain</button>`
      : `<input class="mp-input" type="password" placeholder="managed inbound-email API key" style="min-width:180px" /><button class="btn sm" data-mp-connect>Connect</button>`}
    </div>`).join('') || '<span style="color:var(--ink-3)">No mailbox providers.</span>';
  list.querySelectorAll('[data-mp]').forEach((row) => {
    row.querySelector('[data-mp-connect]')?.addEventListener('click', async () => {
      const name = row.dataset.mp;
      const val = row.querySelector('.mp-input').value.trim();
      const body = { provider: name, ...(name === 'self-managed' ? { domain: val } : { apiKey: val }) };
      try {
        const r = await api('/api/agent-mail/connect', { method: 'POST', body: JSON.stringify(body) });
        if (r.status === 'connected') { toast(r.detail || 'Connected'); wireMailboxProviderCard(); }
        else { toast(r.detail || 'Not available', true); }
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ── agent mailbox: dedicated inbox for accounts agents register (§8) ──────────
function agentMailCard() {
  return `<div class="card" id="agent-mail-card">
    <div class="section-h">Agent mailbox</div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">This organization's dedicated inbox for accounts its agents register — never your personal email, and never readable by other organizations. The address is provisioned automatically from the connected email service above. Agents read codes and links with <code>check_agent_mail</code>.</p>
    <div class="agent-mail-body">Loading…</div>
  </div>`;
}
async function wireAgentMailCard(organizationId) {
  const box = $('#agent-mail-card');
  if (!box) return;
  const body = box.querySelector('.agent-mail-body');
  let data = { address: '', configured: false, messages: [] };
  try { data = await api(`/api/organizations/${encodeURIComponent(organizationId || 'org_personal')}/agent-mail`); } catch {}
  body.innerHTML = `<div class="form-row"><label>Agent address</label><input value="${esc(data.address)}" readonly class="mono" style="width:100%" /></div>
    ${data.configured ? '' : '<div class="task-sub" style="color:var(--warn,#e0b15a);margin-bottom:6px">No email service connected yet — connect one in <b>Agent email service</b> above and this address activates automatically. Until then it accepts test ingestion only.</div>'}
    <div style="font-weight:600;margin:6px 0 4px">Recent messages</div>
    ${data.messages.length ? data.messages.map((m) => `<div class="queue-item"><div style="flex:1"><b>${esc(m.subject || '(no subject)')}</b> ${m.code ? `<span class="chip" style="color:var(--ok,#4ec9a3)">code ${esc(m.code)}</span>` : ''}<div class="task-sub" style="color:var(--ink-3)">from ${esc(m.from)}${m.link ? ` · <a href="${esc(m.link)}" target="_blank" rel="noopener">link</a>` : ''}</div></div></div>`).join('') : '<span style="color:var(--ink-3)">No messages yet.</span>'}`;
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
      ${inherited ? '<span class="chip" title="Using the organization/installation default; edit to create a project override">inherited</span>' : scope === 'project' ? '<span class="chip">project override</span>' : ''}</div>
    <div class="agent-profile-controls">
      <select class="pf-provider">${['claude', 'codex', 'mock'].map((x) => `<option ${x === p.provider ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <div class="combo pf-model-combo" style="flex:1;min-width:140px">
        <input class="pf-model" placeholder="model" value="${esc(p.model || '')}" autocomplete="off" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show model choices">▾</button>
        <div class="combo-menu" hidden></div>
      </div>
      ${effortSelectHtml('pf-effort', p.provider, p.model, p.effort || '')}
      <input class="pf-maxturns" type="number" min="1" placeholder="turns: ∞" title="Max tool iterations per turn. Blank = unlimited." value="${p.maxTurns ?? ''}" style="width:90px" />
    </div>
    <div class="form-row"><label>Accounts this agent may use (all by default)</label><div class="pf-accts">${accountChecks(p, handles, logins)}</div></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary sm" data-saveprofile="${esc(p.id)}">${p.id === '__unified__' ? 'Save agent' : 'Save profile'}</button>
      ${scope === 'project' && p.scope === 'project' ? `<button class="btn sm" data-resetprofile="${esc(p.id)}">Reset to inherited</button>` : ''}
    </div>
  </div>`;
}

// Render + wire the agents editor for a scope (global or a project). One agent
// runs both Do and Merge unless deliberately separated — the same unified shape
// the task form and Quick defaults present — so the common case is one choice.
// The standing Confirm-agent profile is not shown: review agents are configured
// per layer in the Review route, right below the agents they gate.
async function hydrateProfiles(scope, projectId, organizationId) {
  let handles = [], logins = [];
  try { const a = await api('/api/accounts'); handles = a.handles || []; logins = a.logins || []; } catch {}
  let profiles = [];
  try { profiles = await api(`/api/profiles${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`); } catch {}
  profiles = profiles.filter((p) => p.role !== 'confirm');
  const list = $(`#profiles-list-${scope}`);
  if (!list) return;
  const doP = profiles.find((p) => p.role === 'do');
  const mergeP = profiles.find((p) => p.role === 'merge');
  const rest = profiles.filter((p) => p !== doP && p !== mergeP);
  const allRefs = [...logins.map((l) => `login:${l.provider}:${l.account}`), ...handles.map((h) => `key:${h}`)];
  // unset/empty allowedAccounts ⇒ all allowed — normalize before comparing roles
  const normAllowed = (p) => (p.allowedAccounts?.length ? [...p.allowedAccounts].sort() : [...allRefs].sort());
  const essence = (p) => JSON.stringify({ provider: p.provider, model: p.model || '', effort: p.effort || '', maxTurns: p.maxTurns ?? null, accounts: normAllowed(p) });
  const separate = !!(doP && mergeP && essence(doP) !== essence(mergeP));
  const unified = doP && mergeP
    ? { ...doP, id: '__unified__', name: 'Agent', role: 'do + merge', scope: doP.scope === 'project' || mergeP.scope === 'project' ? 'project' : doP.scope }
    : null;
  list.innerHTML = !profiles.length ? '<span style="color:var(--ink-3)">No profiles.</span>'
    : unified
      ? `<div class="profiles-group">
          <div class="profiles-unified" ${separate ? 'hidden' : ''}>${profileRow(unified, handles, logins, scope)}</div>
          <label class="agent-separate-toggle"><input type="checkbox" class="profiles-separate" ${separate ? 'checked' : ''}> Separate Do and Merge agent configurations</label>
          <div class="profiles-separated" ${separate ? '' : 'hidden'}>${[doP, mergeP].map((p) => profileRow(p, handles, logins, scope)).join('')}</div>
        </div>${rest.map((p) => profileRow(p, handles, logins, scope)).join('')}`
      : profiles.map((p) => profileRow(p, handles, logins, scope)).join('');
  list.querySelector('.profiles-separate')?.addEventListener('change', (e) => {
    list.querySelector('.profiles-unified').hidden = e.target.checked;
    list.querySelector('.profiles-separated').hidden = !e.target.checked;
  });
  list.querySelectorAll('[data-profile]').forEach((card) => {
    const combo = card.querySelector('.pf-model-combo');
    const providerOf = () => card.querySelector('.pf-provider')?.value || 'claude';
    if (combo) wireCombo(combo, () => modelOptions(providerOf()), () => refreshEffortSelect(card, 'pf-provider', 'pf-model', 'pf-effort'));
    card.querySelector('.pf-provider')?.addEventListener('change', () => {
      card.querySelector('.pf-model').value = ''; // model choices are provider-specific
      refreshEffortSelect(card, 'pf-provider', 'pf-model', 'pf-effort');
    });
  });
  list.querySelectorAll('[data-saveprofile]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('[data-profile]');
    const checked = [...card.querySelectorAll('.pf-acct:checked')].map((c) => c.value);
    // all checked ⇒ store nothing (means "all", stays correct as accounts are added)
    const allowedAccounts = allRefs.length && checked.length < allRefs.length ? checked : undefined;
    const knobs = {
      provider: card.querySelector('.pf-provider').value,
      model: card.querySelector('.pf-model').value.trim() || undefined,
      effort: card.querySelector('.pf-effort').value || undefined,
      maxTurns: card.querySelector('.pf-maxturns').value ? Number(card.querySelector('.pf-maxturns').value) : undefined,
      allowedAccounts,
    };
    // The unified row IS the Do and Merge defaults: one Save writes both roles.
    const targets = b.dataset.saveprofile === '__unified__' ? [doP, mergeP] : [profiles.find((p) => p.id === b.dataset.saveprofile)].filter(Boolean);
    try {
      for (const orig of targets) {
        await api('/api/profiles', { method: 'PUT', body: JSON.stringify({
          role: orig.role, name: orig.name, id: scope === 'global' ? orig.id : undefined,
          projectId: scope === 'project' ? projectId : undefined, capabilities: orig.capabilities, ...knobs,
        }) });
      }
      await hydrateProfiles(scope, projectId, organizationId);
      flashSaved($(`#profiles-list-${scope}`)?.querySelector(`[data-saveprofile="${b.dataset.saveprofile}"]`));
    } catch (e) { toast(e.message, true); }
  }));
  list.querySelectorAll('[data-resetprofile]').forEach((b) => b.addEventListener('click', async () => {
    const ids = b.dataset.resetprofile === '__unified__' ? [doP.id, mergeP.id] : [b.dataset.resetprofile];
    try {
      for (const id of ids) await api(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Reset to inherited');
      hydrateProfiles(scope, projectId, organizationId);
    } catch (e) { toast(e.message, true); }
  }));
}

// The Review route — who checks the work at Review: human layers, agent layers,
// or none (auto-confirm). Stored with the shared task defaults (__common__/
// confirm) but edited here, beside the Do/Merge agents it gates.
async function hydrateReviewRoute(scope, projectId, organizationId) {
  const box = $(`#review-route-${scope}`);
  if (!box) return;
  const field = schemaFor('software-dev').find((f) => f.name === 'confirm');
  if (!field) { box.innerHTML = ''; return; }
  let own = {};
  let inherited = {};
  try {
    const orgQuery = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
    const d = await api(`/api/defaults/${projectId || 'global'}/software-dev${orgQuery}`);
    own = d[scope].own;
    inherited = d[scope].inherited;
  } catch {}
  box.innerHTML = `<div class="wf-form parameter-fields">${renderFields([field], own, inherited)}</div>
    <button class="btn primary sm" data-save-review-route>Save review route</button>`;
  wireAgentFields(box);
  wireFieldResets(box, [field]);
  const saveButton = box.querySelector('[data-save-review-route]');
  saveButton.addEventListener('click', async () => {
    const values = collectForm(box.querySelector('.wf-form'), [field]);
    try {
      await saveCommonSettings(scope, projectId, organizationId, ['confirm'], values);
      flashSaved(saveButton);
    } catch (err) { toast(err.message, true); }
  });
}

// The logins + API keys now live in the unified credential manager (#cred-editor-global:
// drag to reorder, On/Off to enable/disable, ✎/✕ to rename/delete a login). This just
// refreshes it after a connect/register/delete.
async function hydrateAccounts() {
  await renderCredentialEditor($('#cred-editor-global'), 'global');
}

function profilesCard(scope) {
  return `<div class="card agent-profile-settings" id="profiles-card-${scope}">
    <div class="section-h">Agents</div>
    <p style="color:var(--ink-2);margin-top:0">Who does the work: model, turn cap, and account pool.${scope === 'project' ? ' Overrides the organization defaults for this project.' : ''}</p>
    <div id="profiles-list-${scope}">Loading…</div>
    <div class="settings-divider"></div>
    <div id="review-route-${scope}">Loading…</div>
  </div>`;
}

function authorizationCard(scope) {
  return `<div class="card" id="authorization-card-${scope}">
    <div class="section-h">Authorization profiles</div>
    <p style="color:var(--ink-2);margin-top:0;font-size:12px">The same job-shaped profiles authorize people and task agents. Agents remain capped by their creator.</p>
    <div id="authorization-${scope}">Loading…</div>
  </div>`;
}

function capabilityPatternAllows(pattern, capability) {
  if (pattern === '*' || pattern === capability) return true;
  if (pattern.endsWith(':*')) return capability.startsWith(pattern.slice(0, -1));
  const p = pattern.split(':');
  const c = capability.split(':');
  return p.length === c.length && p.every((part, i) => part === '*' || part === c[i]);
}

function capabilityChecklist(profile, groups) {
  const granted = profile.capabilities || [];
  const has = (cap) => granted.some((pattern) => capabilityPatternAllows(pattern, cap));
  const known = new Set(groups.flatMap((group) => group.capabilities.map((cap) => cap.id)));
  // Concrete target-scoped grants cannot be enumerated in a finite checklist.
  // Preserve those in a clearly secondary expert field; ordinary users only
  // ever need the complete checklist above it.
  const scoped = granted.filter((cap) => cap !== '*' && !known.has(cap) && !cap.endsWith(':*'));
  return `<label class="authz-all"><input type="checkbox" class="authz-all-future" ${granted.includes('*') ? 'checked' : ''}> <span><b>All current and future capabilities</b><small>Administrator wildcard — automatically includes capabilities added in later releases.</small></span></label>
    <div class="authz-checklist">${groups.map((group, index) => `<details class="authz-cap-group" ${index < 2 ? 'open' : ''}>
      <summary><input type="checkbox" class="authz-group-toggle" tabindex="-1"> <span><b>${esc(group.label)}</b><small>${esc(group.description)}</small></span></summary>
      <div class="authz-cap-items">${group.capabilities.map((cap) => `<label class="authz-cap-item"><input type="checkbox" class="authz-capability" value="${esc(cap.id)}" ${has(cap.id) ? 'checked' : ''}> <span><b>${esc(cap.label)}</b><code>${esc(cap.id)}</code><small>${esc(cap.description)}</small></span></label>`).join('')}</div>
    </details>`).join('')}</div>
    <details class="advanced authz-scoped"><summary>Advanced target-scoped capabilities</summary>
      <p class="task-sub">Only capabilities tied to a concrete dynamic resource belong here. Most profiles should leave this empty.</p>
      <textarea class="authz-scoped-capabilities mono" rows="2" placeholder="merge-into:/repo:branch">${esc(scoped.join('\n'))}</textarea>
    </details>`;
}

function wireCapabilityChecklist(row) {
  const all = row.querySelector('.authz-all-future');
  const caps = [...row.querySelectorAll('.authz-capability')];
  const syncGroup = (group) => {
    const toggle = group.querySelector('.authz-group-toggle');
    const members = [...group.querySelectorAll('.authz-capability')];
    const n = members.filter((cap) => cap.checked).length;
    toggle.checked = n === members.length;
    toggle.indeterminate = n > 0 && n < members.length;
  };
  row.querySelectorAll('.authz-cap-group').forEach((group) => {
    syncGroup(group);
    const toggle = group.querySelector('.authz-group-toggle');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      group.querySelectorAll('.authz-capability').forEach((cap) => { cap.checked = toggle.checked; });
      all.checked = false;
      syncGroup(group);
    });
  });
  caps.forEach((cap) => cap.addEventListener('change', () => {
    all.checked = false;
    syncGroup(cap.closest('.authz-cap-group'));
  }));
  all.addEventListener('change', () => {
    if (all.checked) caps.forEach((cap) => { cap.checked = true; });
    row.querySelectorAll('.authz-cap-group').forEach(syncGroup);
  });
}

async function hydrateAuthorization(scope, projectId) {
  const box = $(`#authorization-${scope}`);
  if (!box) return;
  try {
    const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const data = await api(`/api/authorization/profiles${suffix}`);
    const options = data.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === data.defaultProfile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    box.innerHTML = `<p class="task-sub">These profiles limit what task agents may do. Human membership and project access are managed in People and each project's Access section.</p>
      <div class="form-row"><label>Default for new task agents</label><select class="authz-default">${options}</select></div>
      <div style="display:grid;gap:6px">${data.profiles.map((p) => `<details class="advanced authz-profile" data-profile-id="${esc(p.id)}">
        <summary><b>${esc(p.name)}</b> — ${esc(p.description)}</summary>
        <div class="form-row"><label>Description</label><input class="authz-description" value="${esc(p.description)}"></div>
        ${capabilityChecklist(p, data.capabilityGroups || [])}
        <button class="btn sm authz-save-profile">Save ${scope === 'project' ? 'project override' : 'profile'}</button>
      </details>`).join('')}</div>`;
    box.querySelector('.authz-default')?.addEventListener('change', async (e) => {
      await api('/api/authorization/default', { method: 'PUT', body: JSON.stringify({ profileId: e.target.value, ...(projectId ? { projectId } : {}) }) });
      toast('Authorization default saved');
    });
    box.querySelectorAll('.authz-profile').forEach(wireCapabilityChecklist);
    box.querySelectorAll('.authz-save-profile').forEach((button) => button.addEventListener('click', async () => {
      const row = button.closest('.authz-profile');
      const original = data.profiles.find((p) => p.id === row.dataset.profileId);
      try {
        const capabilities = row.querySelector('.authz-all-future').checked
          ? ['*']
          : [...row.querySelectorAll('.authz-capability:checked')].map((cap) => cap.value)
              .concat(row.querySelector('.authz-scoped-capabilities').value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean));
        await api('/api/authorization/profiles', { method: 'PUT', body: JSON.stringify({
          ...(projectId ? { projectId } : {}),
          profile: {
            ...original,
            description: row.querySelector('.authz-description').value.trim(),
            capabilities,
          },
        }) });
        toast('Authorization profile saved');
        hydrateAuthorization(scope, projectId);
      } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { box.innerHTML = `<span class="task-sub">${esc(e.message)}</span>`; }
}

function wireGlobalSettings(organizationId) {
  hydrateSettingsForms('global', undefined, organizationId);
  hydrateQuickSettingsForms('global', undefined, organizationId);
  wireQuickSettingsSave('global', undefined, organizationId);
  renderCredentialEditor($('#cred-editor-global'), 'global'); // the merged accounts + precedence list
  hydrateProfiles('global', undefined, organizationId);
  hydrateReviewRoute('global', undefined, organizationId);
  hydrateAuthorization('global');
  hydrateWorkflows();
  hydrateGitProfiles();
  wireVaultCards(organizationId);
  wireConnectorsCard(organizationId);
  wireMailboxProviderCard();
  wireAgentMailCard(organizationId);
  wirePaymentsCard('global', undefined, organizationId);
  $('#gitp-save')?.addEventListener('click', async () => {
    const name = $('#gitp-name').value.trim();
    const userName = $('#gitp-username').value.trim();
    const userEmail = $('#gitp-email').value.trim();
    const out = $('#gitp-result');
    if (!name || !userName || !userEmail) return toast('profile name, user.name and user.email required', true);
    const btn = $('#gitp-save'); btn.disabled = true;
    try {
      await api('/api/git-profiles', { method: 'POST', body: JSON.stringify({
        name, userName, userEmail,
        githubToken: $('#gitp-token').value.trim() || undefined,
        sshKey: $('#gitp-ssh').value.trim() || undefined,
        signingKey: $('#gitp-signing').value.trim() || undefined,
      }) });
      out.innerHTML = `🟢 Saved <b>${esc(name)}</b>. Secrets went to the vault and are never shown again.`;
      out.style.color = 'var(--ok, green)';
      for (const id of ['#gitp-token', '#gitp-ssh', '#gitp-signing']) $(id).value = '';
      hydrateGitProfiles();
    } catch (e) {
      out.textContent = e.message;
      out.style.color = 'var(--bad, crimson)';
    } finally { btn.disabled = false; }
  });
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
      hydrateProfiles('global', undefined, organizationId);
    } catch (e) { $('#login-connect').disabled = false; out.textContent = e.message; out.style.color = 'var(--bad, crimson)'; }
  });
  $('#main').querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', async () => {
      const wf = b.dataset.save;
      const sec = b.closest('[data-wf]');
      const fields = wf === '__common__' ? commonSettingsFields('global')
        : settingsFields(wf, 'global').filter((field) => !COMMON_DEFAULT_NAMES.has(field.name));
      const values = collectForm(sec.querySelector('.wf-form'), fields);
      try {
        if (wf === '__common__') {
          await saveCommonSettings('global', undefined, organizationId, fields.map((f) => f.name), values);
        } else {
          const endpoint = organizationId && wf !== 'agent-queue'
            ? `/api/organizations/${organizationId}/settings/${wf}` : `/api/settings/global/${wf}`;
          await api(endpoint, { method: 'PUT', body: JSON.stringify({ values }) });
        }
        flashSaved(b);
      } catch (e) { toast(e.message, true); }
    }),
  );
  $('#safe-mode')?.addEventListener('change', async (e) => {
    try { const r = await api('/api/safe-mode', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }); S.meta.safeMode = r.safeMode; toast(`Safe mode ${r.safeMode ? 'on' : 'off'}`); } catch (err) { toast(err.message, true); }
  });
}

// ── inbox + collaboration ───────────────────────────────────────────────────
function updateBell() {
  const badge = $('#bell-badge');
  if (!badge) return;
  const n = S.inbox.filter((item) => item.unread).length;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}
function inboxView() {
  const prefs = S.deliveryPreferences || { browser: true, email: false, slack: false, routine: true };
  return `<h1 class="page-title">Inbox</h1>
    <div class="inbox-toolbar"><span>${S.inbox.filter((x) => x.unread).length} unread</span><button class="btn sm" id="inbox-read-all">Mark all read</button></div>
    <div class="inbox-list">${S.inbox.length ? S.inbox.map((item) => `<div class="inbox-row ${item.unread ? 'unread' : ''}" data-inbox="${item.id}">
      <span class="inbox-kind">${item.actionable ? '●' : '○'}</span><div><b>${esc(item.task?.title || item.kind)}</b>
      <div class="task-sub">${item.task?.num != null ? `#${item.task.num} · ` : ''}${esc(item.kind.replaceAll('-', ' '))} · ${new Date(item.createdAt).toLocaleString()}</div></div>
      <button class="btn sm" data-inbox-toggle="${item.id}">${item.unread ? 'Read' : 'Unread'}</button></div>`).join('') : '<div class="empty"><div class="big">Inbox zero</div>Only updates meant for you appear here.</div>'}</div>
    <div class="card delivery-card"><div class="section-h">Delivery</div>
      ${['browser', 'email', 'slack'].map((key) => `<label class="switch"><input type="checkbox" data-delivery="${key}" ${prefs[key] ? 'checked' : ''}/><span>${key[0].toUpperCase() + key.slice(1)}</span></label>`).join('')}
      <button class="btn sm primary" id="save-delivery">Save preferences</button></div>`;
}

function wireInboxView() {
  $('#main').querySelectorAll('[data-inbox]').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('[data-inbox-toggle]')) return;
    openInboxItem(S.inbox.find((item) => item.id === row.dataset.inbox));
  }));
  $('#main').querySelectorAll('[data-inbox-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const item = S.inbox.find((candidate) => candidate.id === button.dataset.inboxToggle); if (!item) return;
    await api(`/api/inbox/${item.id}?organizationId=${encodeURIComponent(S.organizationId)}`, { method: 'PATCH', body: JSON.stringify({ unread: !item.unread }) });
    item.unread = !item.unread; renderMain(); renderRail();
  }));
  $('#inbox-read-all')?.addEventListener('click', async () => {
    await Promise.all(S.inbox.filter((x) => x.unread).map((item) => api(`/api/inbox/${item.id}?organizationId=${encodeURIComponent(S.organizationId)}`, { method: 'PATCH', body: JSON.stringify({ unread: false }) })));
    await loadCollaboration(); renderMain(); renderRail();
  });
  $('#save-delivery')?.addEventListener('click', async () => {
    const values = Object.fromEntries([...$('#main').querySelectorAll('[data-delivery]')].map((el) => [el.dataset.delivery, el.checked]));
    S.deliveryPreferences = await api(`/api/inbox/preferences?organizationId=${encodeURIComponent(S.organizationId)}`, { method: 'PUT', body: JSON.stringify(values) });
    toast('Delivery preferences saved');
  });
}

async function openInboxItem(item) {
  if (!item?.task) return;
  if (item.unread) await api(`/api/inbox/${item.id}?organizationId=${encodeURIComponent(S.organizationId)}`, { method: 'PATCH', body: JSON.stringify({ unread: false }) }).catch(() => {});
  const project = projectById(item.task.projectId); if (!project) return;
  S.projectId = project.id; S.organizationId = project.organizationId || S.organizationId;
  await loadTasks().catch(() => {});
  return go(`${projectRoute(project.id)}/tasks/${item.task.num ?? item.task.id}`);
}

// The signed-in person's display name for the topbar/rail. The legacy single-user
// session is the string 'me'; real identity sessions carry a Better Auth user.
function userDisplayName() {
  const u = S.user;
  if (u && typeof u === 'object') return u.name || u.email || 'Account';
  return 'Account';
}

// A clean profile page: identity, the browser display preference (theme), and the
// one place to end the session. Sign out lives here rather than in the top bar.
function profileView() {
  const u = S.user && typeof S.user === 'object' ? S.user : null;
  const name = userDisplayName();
  const email = u?.email || '';
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const orgCount = (S.organizations || []).length;
  const row = (label, value) => value
    ? `<div class="profile-row"><span class="profile-row-label">${esc(label)}</span><span class="profile-row-value">${esc(value)}</span></div>`
    : '';
  return `<div class="profile-page">
    <h1 class="page-title">Profile</h1>
    <div class="card profile-card">
      <div class="profile-identity">
        <div class="profile-avatar">${u?.image ? `<img src="${esc(u.image)}" alt="">` : esc(initial)}</div>
        <div class="profile-meta">
          <div class="profile-name">${esc(name)}</div>
          ${email ? `<div class="profile-email">${esc(email)}</div>` : ''}
        </div>
      </div>
      <div class="profile-rows">
        ${row('Name', u?.name || '')}
        ${row('Email', email)}
        ${row('Account', u?.id || '')}
        ${row('Organizations', orgCount ? String(orgCount) : '')}
      </div>
    </div>
    <div class="card">
      <div class="section-h">Appearance</div>
      <div class="switch"><button class="btn sm" id="profile-theme">Toggle theme ◐</button></div>
      <div class="switch"><input type="checkbox" id="profile-md-render" ${markdownEnabled() ? 'checked' : ''} /><label for="profile-md-render">Render conversation messages as Markdown</label></div>
      <div class="switch"><input type="checkbox" id="profile-mathjax" ${mathjaxEnabled() ? 'checked' : ''} /><label for="profile-mathjax">Typeset math with MathJax (needs Markdown; loads MathJax from a CDN)</label></div>
      <p style="color:var(--ink-3);margin:2px 0 0;font-size:11px">These are per-browser display choices, applied the next time a conversation renders.</p>
    </div>
    <div class="card">
      <div class="section-h">Session</div>
      <p class="task-sub">End this browser session${email ? ` for ${esc(email)}` : ''}.</p>
      <button class="btn danger" id="profile-logout">Sign out</button>
    </div>
  </div>`;
}

function wireProfileView() {
  $('#profile-theme')?.addEventListener('click', toggleTheme);
  $('#profile-md-render')?.addEventListener('change', (e) => {
    try { localStorage.setItem('karmax-md-render', e.target.checked ? '1' : '0'); } catch {}
    if (S.taskTab === 'checkin') renderTaskPage();
    toast(`Markdown rendering ${e.target.checked ? 'on' : 'off'}`);
  });
  $('#profile-mathjax')?.addEventListener('change', (e) => {
    try { localStorage.setItem('karmax-mathjax', e.target.checked ? '1' : '0'); } catch {}
    if (S.taskTab === 'checkin') renderTaskPage();
    toast(`MathJax ${e.target.checked ? 'on' : 'off'}`);
  });
  $('#profile-logout')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    location.reload();
  });
}

// The settings rail is real navigation, not a scroll-spy: exactly one section is
// visible at a time, so each pane reads as a page with a single purpose instead
// of a position in one endless scroll. The URL hash names the open pane (via
// replaceState, so browsing sections doesn't pollute history) — a deep link like
// /organization#settings-agents lands on its pane, and background renderMain
// refreshes restore the same pane because the URL, not DOM state, holds it.
function wireSettingsNavigation() {
  const layout = document.querySelector('.settings-layout');
  if (!layout) return;
  const content = layout.querySelector('.settings-content');
  const links = [...layout.querySelectorAll('.settings-nav a[href^="#"]')];
  if (!links.length || !content) return;
  if (!content.querySelector('.settings-pane')) {
    // Group each section title + the cards under it, then wrap the groups into
    // panes in nav order (nav order is the canonical SPEC order; the templates
    // may declare sections in any order).
    const groups = new Map();
    let current;
    for (const child of [...content.children]) {
      if (child.classList.contains('settings-section-title')) current = child.id;
      if (!current) continue;
      if (!groups.has(current)) groups.set(current, []);
      groups.get(current).push(child);
    }
    for (const link of links) {
      const id = link.getAttribute('href').slice(1);
      const pane = document.createElement('section');
      pane.className = 'settings-pane';
      pane.dataset.pane = id;
      for (const node of groups.get(id) || []) pane.append(node);
      content.append(pane);
    }
  }
  const panes = [...content.querySelectorAll('.settings-pane')];
  const activate = (id) => {
    const target = panes.some((pane) => pane.dataset.pane === id) ? id : links[0].getAttribute('href').slice(1);
    panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === target));
    links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${target}`));
  };
  links.forEach((link) => {
    // onclick assignment (not addEventListener) keeps re-wiring idempotent —
    // renderMain and hydrateOrganizationView can both land here on one paint.
    link.onclick = (event) => {
      event.preventDefault();
      history.replaceState(history.state, '', location.pathname + link.getAttribute('href'));
      activate(link.getAttribute('href').slice(1));
      $('#main')?.scrollTo?.(0, 0);
      window.scrollTo(0, 0);
    };
  });
  activate(location.hash.slice(1));
}

// { / } walk the settings rail's panes, mirroring the Check-in page's pane
// navigation. Clicking the nav link reuses wireSettingsNavigation's handler,
// so the URL hash and active pane stay in sync.
function cycleSettingsPane(delta) {
  const layout = document.querySelector('.settings-layout');
  if (!layout) return;
  const links = [...layout.querySelectorAll('.settings-nav a[href^="#"]')];
  if (!links.length) return;
  const i = links.findIndex((l) => l.classList.contains('active'));
  const at = i < 0 ? (delta > 0 ? -1 : 0) : i;
  links[(at + delta + links.length) % links.length]?.click();
}

function organizationView() {
  const org = S.organizations.find((o) => o.id === S.organizationId);
  return `<div class="organization-settings"><div class="settings-header"><div><h1 class="page-title">Settings</h1>
    <p class="settings-intro">${esc(org?.name || 'Organization')}</p></div><button class="btn sm" id="create-organization">＋ New organization</button></div>
    ${S.inviteNotice ? `<div class="card"><b>${esc(S.inviteNotice)}</b></div>` : ''}
    <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections"><span>Organization</span><a href="#settings-code">Git &amp; GitHub</a><a href="#settings-compute">Compute</a><a href="#settings-agents">Agent logins</a><a href="#settings-defaults">Task defaults</a><a href="#settings-payments">Passwords &amp; payments</a><a href="#settings-people">People &amp; authorization</a><a href="#settings-installation">Workflows</a><a href="#settings-advanced">Advanced</a></nav>
    <div class="settings-content">

    <div class="settings-section-title" id="settings-people"><div>People &amp; authorization<small>Who is in this organization, and what each person may do</small></div></div>
    <div class="card"><div class="section-h">People</div><div id="org-members">Loading…</div>
      <div class="inline-form"><input id="invite-email" placeholder="teammate@company.com"><select id="invite-profile"><option value="developer">Developer</option><option value="maintainer">Project maintainer</option><option value="operator">Automation operator</option><option value="administrator">Administrator</option></select><button class="btn sm" id="invite-member">Invite</button></div><div id="invite-result" class="task-sub"></div>
      <div class="settings-divider"></div><div class="section-h">Teams</div><p class="task-sub">Teams are reusable review routes. A team named Leaders is available to workflows as <span class="mono">@team:leaders</span>.</p><div id="org-teams">Loading…</div><datalist id="org-people-options"></datalist><div class="inline-form"><input id="team-name" placeholder="Leaders"><button class="btn sm" id="create-team">Create team</button></div><div id="org-authorization-slot"></div></div>

    <div class="settings-section-title" id="settings-code"><div>Git &amp; GitHub<small>The GitHub connection and commit identities your projects share</small></div></div>
    <div class="card"><div class="section-h">GitHub connection</div><div id="org-github">Loading…</div><div id="org-git-accounts-slot"></div></div>

    <div class="settings-section-title" id="settings-compute"><div>Compute<small>Where tasks run, how large each world is, and the monthly ceiling</small></div></div>
    <div class="card"><div class="section-h">Task execution</div><p class="task-sub">Choose where tasks run, how large each world is, when idle worlds pause, and the monthly cost ceiling. Provider credentials and templates are configured directly below the policy that uses them.</p><div id="org-execution">Loading…</div><div class="section-h" style="margin-top:22px">Cloud providers</div><div id="org-providers">Loading…</div><div class="section-h" style="margin-top:22px">Capacity &amp; usage</div><div id="org-usage">Loading…</div><div id="org-runners"></div></div>

    ${globalSettingsView(true)}

    <div class="settings-section-title" id="settings-advanced"><div>Advanced<small>Rarely needed — appearance, identity, safe mode, export</small></div></div><div id="org-misc-slot"></div>
    <details class="card settings-disclosure"><summary><b>Single sign-on &amp; directory sync</b><span>For organizations that already use an identity provider</span></summary><p class="task-sub">OIDC makes employees sign in through your company. SCIM automatically adds, removes, and groups them. Leave this untouched unless your identity administrator gives you these values.</p><div id="org-identity">Loading…</div></details>
    <details class="card settings-disclosure"><summary><b>Export or delete organization</b><span>Data portability and permanent removal</span></summary><p class="task-sub">Export this organization's durable metadata, or permanently delete the tenant and its worlds, objects, and repository keys.</p><div class="inline-form"><button class="btn sm" id="export-organization">Export</button>${org?.kind === 'team' ? '<button class="btn sm danger" id="delete-organization">Delete organization</button>' : ''}</div></details>
    </div></div></div>`;
}

async function hydrateOrganizationView() {
  if (!$('#org-members') || !S.organizationId) return;
  const gitAccounts = $('#git-accounts-card');
  if (gitAccounts && $('#org-git-accounts-slot')) $('#org-git-accounts-slot').append(gitAccounts);
  const authorization = $('#authorization-card-global');
  if (authorization && $('#org-authorization-slot')) $('#org-authorization-slot').append(authorization);
  for (const card of [$('#main [data-wf="agent-queue"]'), $('#resilience-card')])
    if (card && $('#org-misc-slot')) $('#org-misc-slot').append(card);
  wireSettingsNavigation();
  await loadCollaboration().catch(() => {});
  const userRecord = (id, embedded) => embedded || S.organizationMembers.find((member) => member.userId === id)?.user || S.users.find((user) => user.id === id);
  const userName = (id, embedded) => userRecord(id, embedded)?.name?.trim() || userRecord(id, embedded)?.email?.split('@')[0] || 'Unnamed member';
  const personChoice = (member) => { const user = userRecord(member.userId, member.user); const name = userName(member.userId, member.user); return user?.email ? `${name} — ${user.email}` : name; };
  const personMarkup = (id, embedded) => { const user = userRecord(id, embedded); return `<span class="person-name"><b>${esc(userName(id, embedded))}</b>${user?.email ? `<small>${esc(user.email)}</small>` : ''}</span>`; };
  const memberRoles = [['developer', 'Developer'], ['maintainer', 'Project maintainer'], ['operator', 'Automation operator'], ['administrator', 'Administrator']];
  $('#org-members').innerHTML = S.organizationMembers.length ? S.organizationMembers.map((m) => {
    const current = m.profileId || 'developer';
    return `<div class="member-row" data-org-member="${esc(m.userId)}">${personMarkup(m.userId, m.user)}${m.protectedOwner ? '<span class="chip" title="Recovery ownership is protected; permissions still come from the selected profile">protected owner</span>' : ''}<select class="q-sel org-member-profile">${memberRoles.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="btn sm org-member-remove">Remove</button></div>`;
  }).join('') : '<span class="task-sub">No members.</span>';
  const [gitConnections, githubApp, runners, providerConnections, executionPolicy, usage, identityPolicy, invitations, teamMembers] = await Promise.all([
    api(`/api/organizations/${S.organizationId}/git-connections`).catch(() => []),
    api(`/api/organizations/${S.organizationId}/github/app`).catch(() => ({ configured: false })),
    api(`/api/organizations/${S.organizationId}/runner-pools`).catch(() => []),
    api(`/api/organizations/${S.organizationId}/world-providers`).catch(() => []),
    api(`/api/organizations/${S.organizationId}/execution-policy`).catch(() => ({ worldProvider: S.meta?.hosted ? 'e2b' : 'worktree', resources: { cpu: 2, memoryMb: 2048 }, network: { unrestricted: true }, hibernateAfterMs: 604800000 })),
    api(`/api/organizations/${S.organizationId}/usage`).catch(() => null),
    api(`/api/organizations/${S.organizationId}/identity-policy`).catch(() => null),
    api(`/api/organizations/${S.organizationId}/invitations`).catch(() => []),
    Promise.all(S.teams.map((team) => api(`/api/organizations/${S.organizationId}/teams/${team.id}/members`).catch(() => []).then((members) => ({ team, members })))),
  ]);
  if (invitations.some((invitation) => !invitation.acceptedAt)) $('#org-members').insertAdjacentHTML('beforeend', `<div class="section-h" style="margin-top:12px">Pending invitations</div>${invitations.filter((invitation) => !invitation.acceptedAt).map((invitation) => `<div class="member-row"><span>${esc(invitation.email)}</span><span class="chip">${esc(invitation.profileId || 'developer')}</span></div>`).join('')}`);
  $('#org-people-options').innerHTML = S.organizationMembers.map((member) => `<option value="${esc(personChoice(member))}"></option>`).join('');
  $('#org-teams').innerHTML = teamMembers.length ? teamMembers.map(({ team, members }) => `<div class="team-block" data-team="${esc(team.id)}"><div class="team-heading"><span><b>${esc(team.name)}</b><span class="task-sub mono">@team:${esc(team.slug)}</span></span><span class="team-actions"><span class="chip">${members.length} member${members.length === 1 ? '' : 's'}</span><button class="btn sm team-rename">Rename</button><button class="btn sm danger team-delete">Delete</button></span></div><div class="inline-form team-rename-form" hidden><input class="team-name-edit" value="${esc(team.name)}" aria-label="Team name"><button class="btn sm primary team-rename-save">Save name</button><button class="btn sm team-rename-cancel">Cancel</button></div>${members.map((m) => `<div class="member-row">${personMarkup(m.userId, m.user)}<button class="btn sm team-member-remove" data-user="${esc(m.userId)}">Remove</button></div>`).join('')}<div class="inline-form"><input class="team-user" list="org-people-options" autocomplete="off" placeholder="Type a name or email"><button class="btn sm team-member-add">Add person</button></div></div>`).join('') : '<span class="task-sub">No teams yet.</span>';
  $('#org-github').innerHTML = githubApp.configured ? `
    <div class="member-row"><span><b>${esc(githubApp.appSlug || 'GitHub App')}</b></span><span class="chip">App ready</span></div>
    ${gitConnections.map((connection) => `<div class="member-row"><span>${esc(connection.accountLogin)}</span><span class="chip">${esc(connection.accountType || 'account')}</span></div>`).join('') || '<p class="task-sub">The App is ready but not installed on a GitHub account yet.</p>'}
    <p class="task-sub">${githubApp.syncMode === 'webhook' ? 'Repository access stays current automatically through GitHub webhooks.' : 'This instance is not publicly reachable, so Karmax refreshes repository access when you ask instead of using webhooks.'}</p>
    <div class="inline-form"><button class="btn sm primary" id="connect-github">${gitConnections.length ? 'Install on another account' : 'Install GitHub App'}</button>${gitConnections.length ? '<button class="btn sm" id="refresh-github">Refresh repositories</button>' : ''}${githubApp.oauthConfigured && !githubApp.userAuthorized ? '<button class="btn sm" id="authorize-github">Authorize repository creation</button>' : ''}</div>` : `
    <p class="task-sub">This creates a private GitHub App for this Karmax installation, then lets you choose exactly which repositories it may access. On localhost, setup works without a webhook and repository access is refreshed on demand.</p>
    <button class="btn sm primary" id="setup-github-app">Set up GitHub</button>
    <details style="margin-top:12px"><summary class="task-sub">Use an existing GitHub App</summary><div class="settings-grid" style="margin-top:8px"><label class="form-row">App ID<input id="github-app-id"></label><label class="form-row">App slug<input id="github-app-slug"></label><label class="form-row">Client ID<input id="github-client-id"></label><label class="form-row">Client secret<input id="github-client-secret" type="password"></label></div><label class="form-row">Private key (PEM)<textarea id="github-private-key" rows="4"></textarea></label><label class="form-row">Webhook secret<input id="github-webhook-secret" type="password"></label><button class="btn sm" id="save-github-app">Save App</button></details>`;
  const connectionFor = (provider) => providerConnections.find((connection) => connection.provider === provider);
  S.worldProviderConnections = providerConnections;
  // The default Agent environment moved to Task defaults (below) and can be
  // overridden per project/task. Compute keeps the runner pool + budget; the pool
  // list is scoped to the effective environment, shown read-only here.
  const orgEnvironment = executionPolicy.worldProvider || (S.meta?.hosted ? 'e2b' : 'worktree');
  $('#org-execution').innerHTML = `<div class="settings-grid">
    <label class="form-row">Agent environment<input value="${esc(orgEnvironment)}" disabled title="Set the default in Task defaults; override it per project or task" /></label>
    <label class="form-row">Default runner pool<select id="org-execution-pool"></select></label>
    <label class="form-row">World experience<select id="org-execution-flavor"><option value="headless" ${(executionPolicy.environment?.flavor || 'headless') === 'headless' ? 'selected' : ''}>Headless · coding + browser MCP</option><option value="desktop" ${executionPolicy.environment?.flavor === 'desktop' ? 'selected' : ''}>Desktop · adds GUI + noVNC</option></select></label>
    <label class="form-row">CPU per world<input id="org-execution-cpu" type="number" min="1" value="${esc(executionPolicy.resources?.cpu || 2)}" /></label>
    <label class="form-row">Memory per world (MiB)<input id="org-execution-memory" type="number" min="128" step="128" value="${esc(executionPolicy.resources?.memoryMb || 2048)}" /></label>
    <label class="form-row">Cloud budget (USD/month)<input id="org-execution-budget" type="number" min="0" step="0.01" value="${executionPolicy.monthlyBudgetMicros == null ? '' : esc(executionPolicy.monthlyBudgetMicros / 1e6)}" placeholder="Unlimited" /></label>
    <label class="form-row">Hibernate parked worlds after (days)<input id="org-execution-hibernate" type="number" min="1" value="${esc(Math.round((executionPolicy.hibernateAfterMs || 604800000) / 86400000))}" /></label>
    <label class="form-row">Outbound network<select id="org-execution-network"><option value="unrestricted" ${executionPolicy.network?.unrestricted !== false ? 'selected' : ''}>Normal internet access (recommended)</option><option value="restricted" ${executionPolicy.network?.unrestricted === false ? 'selected' : ''}>Restricted allowlist</option></select></label>
  </div>
  <p class="task-sub">Coding agents normally need arbitrary package registries, documentation, web search, and APIs. Restricted mode is for organizations with a maintained egress policy.</p>
  <details id="org-network-restrictions" ${executionPolicy.network?.unrestricted === false ? 'open' : ''}><summary class="task-sub">Restricted-network allowlist</summary><label class="form-row">Allowed domains<input id="org-execution-domains" value="${esc((executionPolicy.network?.allowDomains || []).join(', '))}" placeholder="registry.npmjs.org, pypi.org" /></label><label class="form-row">Allowed CIDRs<input id="org-execution-cidrs" value="${esc((executionPolicy.network?.allowCidrs || []).join(', '))}" placeholder="10.20.0.0/16" /></label></details>
  <button class="btn sm primary" id="org-execution-save">Save execution policy</button>`;
  const providerInfo = {
    e2b: { name: 'E2B', site: 'https://e2b.dev', keys: 'https://e2b.dev/dashboard?tab=keys' },
    daytona: { name: 'Daytona', site: 'https://www.daytona.io', keys: 'https://app.daytona.io' },
  };
  $('#org-providers').innerHTML = ['e2b', 'daytona'].map((provider) => {
    const connection = connectionFor(provider); const config = connection?.config || {};
    const state = connection ? `${connection.status}${connection.enabled ? '' : ' · disabled'}` : 'not connected';
    const info = providerInfo[provider];
    return `<div class="team-block provider-connection" data-provider="${provider}">
      <div class="member-row"><b>${info.name}</b><span class="chip">${esc(state)}</span>${connection ? '<button class="btn sm provider-test">Test</button><button class="btn sm provider-disconnect">Disconnect</button>' : ''}</div>
      <p class="task-sub">No account yet? Create one at <a href="${info.site}" target="_blank" rel="noopener noreferrer">${esc(info.site.replace(/^https?:\/\//, ''))}</a>, then paste an <a href="${info.keys}" target="_blank" rel="noopener noreferrer">API key</a> below.</p>
      ${connection?.lastError ? `<p class="task-sub" style="color:var(--danger)">${esc(connection.lastError)}</p>` : ''}
      <div class="settings-grid"><label class="form-row">API key<input class="provider-key" type="password" autocomplete="new-password" placeholder="${connection ? 'Leave blank to keep current key' : 'Required'}" /></label>
      ${provider === 'e2b' ? `<label class="form-row">Headless template<input class="provider-template" value="${esc(config.template || '')}" placeholder="karmax-browser-v1" /></label><label class="form-row">Desktop template<input class="provider-desktop-template" value="${esc(config.desktopTemplate || '')}" placeholder="desktop" /></label>`
        : `<label class="form-row">Headless snapshot<input class="provider-snapshot" value="${esc(config.snapshot || '')}" placeholder="recommended" /></label><label class="form-row">Headless image<input class="provider-image" value="${esc(config.image || '')}" placeholder="used only when snapshot is blank" /></label><label class="form-row">Desktop snapshot<input class="provider-desktop-snapshot" value="${esc(config.desktopSnapshot || '')}" placeholder="Daytona default when blank" /></label><label class="form-row">Desktop image<input class="provider-desktop-image" value="${esc(config.desktopImage || '')}" placeholder="used only when desktop snapshot is blank" /></label><label class="form-row">API URL<input class="provider-api-url" value="${esc(config.apiUrl || '')}" placeholder="https://app.daytona.io/api" /></label><label class="form-row">Target<input class="provider-target" value="${esc(config.target || '')}" placeholder="provider default" /></label>`}
      </div><button class="btn sm primary provider-save">${connection ? 'Save & verify' : 'Connect & verify'}</button></div>`;
  }).join('');
  $('#org-runners').innerHTML = `${runners.map((r) => `<div class="member-row" data-runner="${esc(r.id)}"><span>${esc(r.name)}</span><span class="chip">${esc(r.provider)} · ${r.capacity.activeWorlds} worlds</span>${r.id.includes(':managed-') ? '' : '<button class="btn sm runner-delete">Delete</button>'}</div>`).join('')}
    <div class="inline-form"><input id="runner-name" placeholder="Dedicated pool"><select id="runner-provider"><option value="e2b">E2B</option><option value="daytona">Daytona</option></select><input id="runner-worlds" type="number" min="1" value="20" title="Concurrent worlds"><button class="btn sm" id="runner-create">Add pool</button></div>`;
  $('#org-usage').innerHTML = usage ? `<div class="stat"><div class="n">$${(usage.costMicros / 1e6).toFixed(2)}</div><div class="l">This query period · ${usage.events} metered events</div></div>` : 'Usage unavailable.';
  if (identityPolicy) $('#org-identity').innerHTML = `<label class="form-row">OIDC provider ID<input id="oidc-provider" value="${esc(identityPolicy.oidcProviderId || S.sso?.providerId || '')}" /></label>
    <label class="form-row">Verified email domains<input id="identity-domains" value="${esc((identityPolicy.verifiedDomains || []).join(', '))}" placeholder="company.com" /></label>
    <label class="switch"><input id="enforce-sso" type="checkbox" ${identityPolicy.enforceSso ? 'checked' : ''}/>Require SSO for this organization</label>
    <div class="inline-form"><button class="btn sm primary" id="save-identity">Save policy</button><button class="btn sm" id="rotate-scim">Rotate SCIM token</button></div>
    <div id="scim-result" class="task-sub">SCIM base URL: <span class="mono">${esc(location.origin)}/scim/v2/${esc(S.organizationId)}</span></div>`;
  $('#invite-member')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${S.organizationId}/invitations`, { method: 'POST', body: JSON.stringify({ email: $('#invite-email').value, profileId: $('#invite-profile').value }) }); const link = `${location.origin}/invite?token=${encodeURIComponent(result.token)}`; $('#invite-result').innerHTML = `Copy this one-time invitation link:<br><span class="mono">${esc(link)}</span>`; } catch (e) { toast(e.message, true); } });
  $('#create-team')?.addEventListener('click', async () => { try { await api(`/api/organizations/${S.organizationId}/teams`, { method: 'POST', body: JSON.stringify({ name: $('#team-name').value }) }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } });
  $('#setup-github-app')?.addEventListener('click', async () => {
    try {
      const result = await api(`/api/organizations/${S.organizationId}/github/app-manifest`, { method: 'POST', body: JSON.stringify({ publicUrl: location.origin }) });
      const form = document.createElement('form'); form.method = 'POST'; form.action = result.action;
      const manifest = document.createElement('input'); manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest);
      form.appendChild(manifest); document.body.appendChild(form); form.submit();
    } catch (e) { toast(e.message, true); }
  });
  $('#save-github-app')?.addEventListener('click', async () => {
    try {
      await api(`/api/organizations/${S.organizationId}/github/app`, { method: 'PUT', body: JSON.stringify({
        appId: $('#github-app-id').value, appSlug: $('#github-app-slug').value, privateKey: $('#github-private-key').value,
        webhookSecret: $('#github-webhook-secret').value, clientId: $('#github-client-id').value, clientSecret: $('#github-client-secret').value,
      }) }); toast('GitHub App saved'); await hydrateOrganizationView();
    } catch (e) { toast(e.message, true); }
  });
  $('#connect-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${S.organizationId}/github/install-url`, { method: 'POST', body: '{}' }); location.assign(result.url); } catch (e) { toast(e.message, true); } });
  $('#authorize-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${S.organizationId}/github/authorize`, { method: 'POST', body: '{}' }); location.assign(result.url); } catch (e) { toast(e.message, true); } });
  $('#refresh-github')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${S.organizationId}/github/refresh`, { method: 'POST', body: '{}' }); toast(`Found ${result.count} ${result.count === 1 ? 'repository' : 'repositories'}`); } catch (e) { toast(e.message, true); } });
  $('#org-providers').querySelectorAll('.provider-connection').forEach((row) => {
    const provider = row.dataset.provider;
    row.querySelector('.provider-save')?.addEventListener('click', async () => {
      const body = { apiKey: row.querySelector('.provider-key').value || undefined, config: provider === 'e2b'
        ? { template: row.querySelector('.provider-template').value, desktopTemplate: row.querySelector('.provider-desktop-template').value }
        : { snapshot: row.querySelector('.provider-snapshot').value, image: row.querySelector('.provider-image').value,
            desktopSnapshot: row.querySelector('.provider-desktop-snapshot').value, desktopImage: row.querySelector('.provider-desktop-image').value,
            apiUrl: row.querySelector('.provider-api-url').value, target: row.querySelector('.provider-target').value } };
      try { await api(`/api/organizations/${S.organizationId}/world-providers/${provider}`, { method: 'PUT', body: JSON.stringify(body) }); await api(`/api/organizations/${S.organizationId}/world-providers/${provider}/test`, { method: 'POST', body: '{}' }); toast(`${provider === 'e2b' ? 'E2B' : 'Daytona'} connected`); await hydrateOrganizationView(); }
      catch (e) { toast(e.message, true); await hydrateOrganizationView(); }
    });
    row.querySelector('.provider-test')?.addEventListener('click', async () => { try { await api(`/api/organizations/${S.organizationId}/world-providers/${provider}/test`, { method: 'POST', body: '{}' }); toast('Connection verified'); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); await hydrateOrganizationView(); } });
    row.querySelector('.provider-disconnect')?.addEventListener('click', async () => { if (!confirm(`Disconnect ${provider}? Existing task worlds must be removed first.`)) return; try { await api(`/api/organizations/${S.organizationId}/world-providers/${provider}`, { method: 'DELETE' }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } });
  });
  $('#runner-create')?.addEventListener('click', async () => { try { await api(`/api/organizations/${S.organizationId}/runner-pools`, { method: 'POST', body: JSON.stringify({ name: $('#runner-name').value, provider: $('#runner-provider').value, capacity: { activeWorlds: Number($('#runner-worlds').value) } }) }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } });
  const matchingOrgPools = runners.filter((pool) => pool.provider === orgEnvironment && pool.enabled);
  $('#org-execution-pool').innerHTML = `<option value="">Provider-managed default</option>${matchingOrgPools.map((pool) => `<option value="${esc(pool.id)}" ${pool.id === (executionPolicy.runnerPoolId || '') ? 'selected' : ''}>${esc(pool.name)}</option>`).join('')}`;
  $('#org-execution-network')?.addEventListener('change', (event) => { $('#org-network-restrictions').open = event.target.value === 'restricted'; });
  $('#org-execution-save')?.addEventListener('click', async () => {
    const split = (selector) => $(selector).value.split(',').map((value) => value.trim()).filter(Boolean);
    const restricted = $('#org-execution-network').value === 'restricted'; const budget = $('#org-execution-budget').value.trim();
    try {
      await api(`/api/organizations/${S.organizationId}/execution-policy`, { method: 'PUT', body: JSON.stringify({ policy: {
        runnerPoolId: $('#org-execution-pool').value || undefined,
        environment: { flavor: $('#org-execution-flavor').value },
        resources: { cpu: Number($('#org-execution-cpu').value), memoryMb: Number($('#org-execution-memory').value) },
        network: restricted ? { unrestricted: false, allowDomains: split('#org-execution-domains'), allowCidrs: split('#org-execution-cidrs') } : { unrestricted: true },
        monthlyBudgetMicros: budget === '' ? null : Math.round(Number(budget) * 1e6),
        hibernateAfterMs: Math.round(Number($('#org-execution-hibernate').value) * 86400000),
      } }) }); toast('Organization execution policy saved'); await hydrateOrganizationView();
    } catch (error) { toast(error.message, true); }
  });
  $('#org-runners').querySelectorAll('[data-runner]').forEach((row) => row.querySelector('.runner-delete')?.addEventListener('click', async () => { if (!confirm('Delete this runner pool?')) return; try { await api(`/api/organizations/${S.organizationId}/runner-pools/${encodeURIComponent(row.dataset.runner)}`, { method: 'DELETE' }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } }));
  $('#save-identity')?.addEventListener('click', async () => { try { await api(`/api/organizations/${S.organizationId}/identity-policy`, { method: 'PUT', body: JSON.stringify({ oidcProviderId: $('#oidc-provider').value.trim(), verifiedDomains: $('#identity-domains').value.split(',').map((x) => x.trim()).filter(Boolean), enforceSso: $('#enforce-sso').checked }) }); toast('Identity policy saved'); } catch (e) { toast(e.message, true); } });
  $('#rotate-scim')?.addEventListener('click', async () => { try { const result = await api(`/api/organizations/${S.organizationId}/scim-token`, { method: 'POST', body: '{}' }); $('#scim-result').innerHTML = `Copy this token now; it is stored only as a hash:<br><span class="mono">${esc(result.token)}</span>`; } catch (e) { toast(e.message, true); } });
  $('#create-organization')?.addEventListener('click', createOrganization);
  $('#org-members')?.querySelectorAll('[data-org-member]').forEach((row) => {
    row.querySelector('.org-member-profile')?.addEventListener('change', async (event) => { try { await api(`/api/organizations/${S.organizationId}/members`, { method: 'POST', body: JSON.stringify({ userId: row.dataset.orgMember, profileId: event.target.value }) }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } });
    row.querySelector('.org-member-remove')?.addEventListener('click', async () => { if (!confirm('Remove this member from the organization?')) return; try { await api(`/api/organizations/${S.organizationId}/members/${encodeURIComponent(row.dataset.orgMember)}`, { method: 'DELETE' }); await loadCollaboration(); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } });
  });
  $('#org-teams')?.querySelectorAll('[data-team]').forEach((block) => {
    block.querySelector('.team-member-add')?.addEventListener('click', async () => {
      const entered = block.querySelector('.team-user')?.value.trim();
      const member = S.organizationMembers.find((candidate) => personChoice(candidate).toLowerCase() === entered?.toLowerCase()
        || userName(candidate.userId, candidate.user).toLowerCase() === entered?.toLowerCase()
        || userRecord(candidate.userId, candidate.user)?.email?.toLowerCase() === entered?.toLowerCase());
      if (!member) return toast('Choose a person in this organization', true);
      try { await api(`/api/organizations/${S.organizationId}/teams/${block.dataset.team}/members`, { method: 'POST', body: JSON.stringify({ userId: member.userId }) }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); }
    });
    block.querySelector('.team-rename')?.addEventListener('click', () => { const form = block.querySelector('.team-rename-form'); form.hidden = false; form.querySelector('.team-name-edit').focus(); form.querySelector('.team-name-edit').select(); });
    block.querySelector('.team-rename-cancel')?.addEventListener('click', () => { block.querySelector('.team-rename-form').hidden = true; });
    block.querySelector('.team-rename-save')?.addEventListener('click', async () => {
      const name = block.querySelector('.team-name-edit')?.value.trim(); if (!name) return toast('Team name is required', true);
      try { await api(`/api/organizations/${S.organizationId}/teams/${block.dataset.team}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await loadCollaboration(); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); }
    });
    block.querySelector('.team-name-edit')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); block.querySelector('.team-rename-save').click(); } if (event.key === 'Escape') block.querySelector('.team-rename-cancel').click(); });
    block.querySelector('.team-delete')?.addEventListener('click', async () => {
      const team = S.teams.find((candidate) => candidate.id === block.dataset.team);
      if (!confirm(`Delete “${team?.name || 'this team'}”? This is only allowed when no project or workflow still uses it.`)) return;
      try { await api(`/api/organizations/${S.organizationId}/teams/${block.dataset.team}`, { method: 'DELETE' }); await loadCollaboration(); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); }
    });
    block.querySelectorAll('.team-member-remove').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/organizations/${S.organizationId}/teams/${block.dataset.team}/members/${encodeURIComponent(button.dataset.user)}`, { method: 'DELETE' }); await hydrateOrganizationView(); } catch (e) { toast(e.message, true); } }));
  });
  $('#export-organization')?.addEventListener('click', () => location.assign(`/api/organizations/${encodeURIComponent(S.organizationId)}/export`));
  $('#delete-organization')?.addEventListener('click', async () => { const org = S.organizations.find((o) => o.id === S.organizationId); const slug = prompt(`Type ${org?.slug} to permanently delete this organization`); if (!slug) return; try { await api(`/api/organizations/${S.organizationId}`, { method: 'DELETE', body: JSON.stringify({ confirmSlug: slug }) }); location.href = '/'; } catch (e) { toast(e.message, true); } });
}

async function createOrganization() {
  const name = prompt('Organization name');
  if (!name) { if ($('#org-switcher')) $('#org-switcher').value = S.organizationId; return; }
  try {
    const organization = await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name }) });
    await loadOrganizations();
    S.organizationId = organization.id;
    S.projectId = null;
    await loadCollaboration().catch(() => {});
    renderShell();
    await go(globalRoute('organization'));
  } catch (error) { toast(error.message, true); if ($('#org-switcher')) $('#org-switcher').value = S.organizationId; }
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
    const endpoint = S.organizationId ? `/api/organizations/${encodeURIComponent(S.organizationId)}/projects` : '/api/projects';
    const p = await api(endpoint, { method: 'POST', body: JSON.stringify({ name, config: {} }) });
    await loadProjects();
    // Route into the new project so its tasks, tags, saved views and search all
    // load fresh — setting S.projectId + re-rendering alone leaves the previous
    // project's tasks/views on screen (applyRoute does the loading on switch).
    // Land on Project settings: a freshly created project has no tasks yet, and
    // configuring it (branches, agent, budget…) is the first thing to do.
    await go(projectRoute(p.id, 'settings'));
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
//      press the task page's action buttons — so a workflow that declares no
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
  { id: 'nav.globalSearch', title: 'Search everything', key: 'meta+shift+F', run: () => openGlobalSearch() },
  { id: 'help.keyboard', title: 'Keyboard shortcuts', key: '?', run: () => openHelp() },
  { id: 'nav.newTask', title: 'New task (quick add)', key: 'n', run: () => { switchTab('tasks'); setTimeout(() => $('#new-task')?.focus(), 30); } },
  { id: 'nav.newTaskForm', title: 'New task (full form)', key: 'N', run: () => { switchTab('tasks'); openTaskForm($('#new-wf')?.value, undefined, $('#new-task')?.value.trim()); } },
  { id: 'nav.search', title: 'Search tasks', key: '/', run: () => { if (S.tab !== 'tasks') switchTab('tasks'); setTimeout(() => $('#task-search')?.focus(), 0); } },
  { id: 'nav.tasks', title: 'Go to tasks', key: 'g t', run: () => switchTab('tasks') },
  { id: 'nav.queue', title: 'Go to queues', key: 'g q', run: () => switchTab('queue') },
  { id: 'nav.activity', title: 'Go to activity', key: 'g a', run: () => switchTab('activity') },
  { id: 'nav.dashboard', title: 'Go to dashboard', key: 'g D', run: () => switchTab('dashboard') },
  { id: 'nav.settings', title: 'Go to project settings', key: 'g s', run: () => switchTab('settings') },
  { id: 'nav.wiki', title: 'Go to project wiki', key: 'g w', run: () => switchTab('wiki') },
  { id: 'nav.orgwiki', title: 'Go to organization wiki', key: 'g W', run: () => go(globalRoute('orgwiki')) },
  { id: 'nav.global', title: 'Go to organization settings', key: 'g S', run: () => switchTab('global') },
  { id: 'nav.projects', title: 'Go to projects', key: 'g P', run: () => focusRail() },
  { id: 'nav.profile', title: 'Go to your profile', key: 'g A', run: () => go(globalRoute('profile')) },
  { id: 'nav.notifications', title: 'Go to inbox', key: 'g N', run: () => go(globalRoute('inbox')) },
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
  // tasks/queue views; with a task page open the same keys walk between tasks. When
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
  // Task-page navigation (host grammar, like j/k): u goes back to the list
  // (Gmail-style — Esc does too, once overlays are popped), [ / ] cycle the
  // page's tabs. Documented in the help panel's static "On a task page" section
  // (help: false here) so they're discoverable before a page is open.
  add({ id: 'task.back', title: 'Back to the list', keybinding: 'u', group: 'Task', help: false, available: !!S.selected, run: () => closeTask() });
  add({ id: 'task.tab.prev', title: 'Previous tab', keybinding: '[', group: 'Task', help: false, available: !!(S.selected && S.view), run: () => cycleTaskTab(-1) });
  add({ id: 'task.tab.next', title: 'Next tab', keybinding: ']', group: 'Task', help: false, available: !!(S.selected && S.view), run: () => cycleTaskTab(1) });
  add({ id: 'task.checkin.prev', title: 'Previous Check-in pane', keybinding: '{', group: 'Task', help: false, available: !!(S.selected && S.view && S.taskTab === 'checkin'), run: () => cycleCheckinPane(-1) });
  add({ id: 'task.checkin.next', title: 'Next Check-in pane', keybinding: '}', group: 'Task', help: false, available: !!(S.selected && S.view && S.taskTab === 'checkin'), run: () => cycleCheckinPane(1) });
  // { / } also walk the settings rail's panes (project or organization settings).
  const onSettings = ['settings', 'organization', 'global'].includes(S.tab) && !S.selected;
  add({ id: 'settings.pane.prev', title: 'Previous settings section', keybinding: '{', group: 'Navigation', help: false, available: onSettings, run: () => cycleSettingsPane(-1) });
  add({ id: 'settings.pane.next', title: 'Next settings section', keybinding: '}', group: 'Navigation', help: false, available: onSettings, run: () => cycleSettingsPane(1) });
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
    // digits 1–9 press the Nth enabled action button in the task page's footer
    const btns = [...document.querySelectorAll('#tp-foot [data-act]:not([disabled])')].slice(0, 9);
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
    setTimeout(refreshTask, 250);
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
      setTimeout(refreshTask, 250);
      setTimeout(refreshTasks, 400);
    } catch (e) { toast(e.message, true); }
  });
}

// Focus the selected conversation's follow-up box — the box lives per-agent on
// the Check-in tab, so switch there first if another tab is showing.
function focusFollowup() {
  if (S.taskTab !== 'checkin') setTaskTab('checkin');
  document.querySelector('.followup-input:not([disabled])')?.focus();
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
// A data-id row navigates through its .row-link `<a>` overlay (the delegated
// link router only fires for anchors), so click that; draft rows carry their
// own click handler on the div, so fall back to the row itself.
function openCursorRow() { const r = cursorRow(); if (r) (r.querySelector('a.row-link') || r).click(); }
function archiveCursorRow() { cursorRow()?.querySelector('[data-archive],[data-unarchive]')?.click(); }
// With a task page open, j/k walk the same task order the list shows.
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
  // Secondary modals (task picker, filter picker, tags manager, tag picker) stack
  // above the form/page in #modal-root — pop the topmost one first (a filter
  // picker can itself sit on the task-picker overlay).
  if ($('#modal-root').lastElementChild) return $('#modal-root').lastElementChild.remove();
  const overlay = $('#overlay-root').firstElementChild;
  if (overlay) {
    if (overlay.id === 'tf-page') return overlay.querySelector('#tf-close')?.click(); // task form page: its close flushes the draft
    return ($('#overlay-root').innerHTML = '');
  }
  if (S.selected) return closeTask();
}

// -- the dispatcher ------------------------------------------------------------
const CHORD = { pending: [], timer: 0 };
function resetChord() { CHORD.pending = []; clearTimeout(CHORD.timer); }
// A bare modifier keydown (Shift/Ctrl/Alt/Meta) fires on its own before the key
// it modifies. It must be transparent to the chord buffer — otherwise pressing
// Shift for the second step of a shifted chord (`g P`, `g W`, `g D`, `g S`, …)
// would land here between the two steps, match nothing, and reset the pending
// `g` before `P` ever arrives.
function isBareModifier(key) { return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta'; }
function dispatchKey(e) {
  if (isBareModifier(e.key)) return false;
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
    // The check-in terminal is a focusable <pre> that behaves like a text field:
    // keystrokes go to the shell, not to app shortcuts. Treat it as "typing".
    const typing = t && t.matches && (t.matches('input, textarea, select, .term-screen') || t.isContentEditable);
    const overlayOpen = $('#overlay-root').childElementCount > 0 || $('#modal-root').childElementCount > 0;
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
    if (dispatchKey(e)) return;
    // Fallback: Enter activates whatever custom control has keyboard focus. A div
    // made Tab-focusable with tabindex="0" (view chips, nav items, task rows, …)
    // carries a click handler but has no native Enter activation — so synthesize the
    // click. Native controls returned above; list/rail cursors have their own Enter
    // commands, which dispatchKey matched first.
    if (e.key === 'Enter' && t && t.matches && t.matches('[tabindex="0"]')) { e.preventDefault(); t.click(); }
  });
}

// -- global search: read-only discovery across every accessible project -------
// Keep this separate from the command palette: search finds durable things;
// the palette invokes actions. The per-project search endpoint gives this the
// same free-text + field-filter semantics as the task list without loading every
// project's task collection into browser state.
function assembleGlobalSearchResults(query, projects, responses, limit = 40) {
  const q = String(query || '').trim();
  const hasFilterSyntax = /(?:^|\s)[!-]?[\w.-]+:/.test(q);
  const textTerms = (q.match(/"[^"]+"|\S+/g) || [])
    .filter((term) => !/^[!-]?[\w.-]+:/.test(term))
    .map((term) => term.replace(/^"|"$/g, ''));
  const projectHits = hasFilterSyntax ? [] : (projects || [])
    .map((project) => ({ project, score: fuzzyScore(q, project.name) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .slice(0, 8);

  const allTasks = (responses || []).flatMap(({ project, result }) =>
    (result?.tasks || []).map((task) => ({
      task,
      project,
      // Text hits in the title should lead notes-only matches. Structured
      // queries have no text terms, so their cross-project order falls back to
      // recency. Score terms independently because task free text is intentionally
      // order-independent ("login fix" also matches "Fix login redirect").
      score: textTerms.length
        ? textTerms.reduce((total, term) => {
          const termScore = fuzzyScore(term, task.title);
          return total < 0 || termScore < 0 ? -1 : total + termScore;
        }, 0)
        : 0,
    })),
  );
  allTasks.sort((a, b) => b.score - a.score || (b.task.createdAt || 0) - (a.task.createdAt || 0));
  return { projectHits, taskHits: allTasks.slice(0, limit), totalTasks: allTasks.length };
}

function openGlobalSearch() {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="palette-scrim" id="gs-scrim"><div class="palette global-search" role="dialog" aria-modal="true" aria-labelledby="gs-title">
    <div class="global-search-head">
      <span aria-hidden="true">⌕</span>
      <input id="gs-in" aria-label="Search everything" aria-controls="gs-list" aria-autocomplete="list" placeholder="Search tasks and projects…" autocomplete="off" spellcheck="false" />
      <button class="icon-btn" id="gs-close" title="Close" aria-label="Close search">✕</button>
    </div>
    <div class="global-search-context" id="gs-title">Every accessible project · title, notes, task number, status, tags, and more</div>
    <div id="gs-list" role="listbox" aria-label="Search results" aria-live="polite"></div>
    <div class="global-search-foot">Filter tasks with queries like <code>status:active</code>, <code>tag:frontend</code>, or <code>#42</code>.</div>
  </div></div>`;
  const input = $('#gs-in');
  const list = $('#gs-list');
  let items = [];
  let active = 0;
  let timer = 0;
  let request = 0;
  let state = 'prompt';
  let summary = '';
  const close = () => { clearTimeout(timer); request++; root.innerHTML = ''; };

  const draw = () => {
    if (state === 'prompt') {
      input.removeAttribute('aria-activedescendant');
      list.innerHTML = `<div class="global-search-empty"><b>Find work anywhere</b><span>Enter words, a task number, or a task filter. Results include archived work.</span></div>`;
      return;
    }
    if (state === 'loading') {
      input.removeAttribute('aria-activedescendant');
      list.innerHTML = `<div class="global-search-empty"><span class="global-search-loading">Searching ${S.projects.length} project${S.projects.length === 1 ? '' : 's'}…</span></div>`;
      return;
    }
    if (!items.length) {
      input.removeAttribute('aria-activedescendant');
      list.innerHTML = `<div class="global-search-empty"><b>No results</b><span>No accessible task or project matched this search.</span></div>`;
      return;
    }
    let lastGroup = null;
    list.innerHTML = items.map((item, i) => {
      const head = item.group !== lastGroup ? `<div class="pal-group">${esc(item.group)}</div>` : '';
      lastGroup = item.group;
      // Each result is a real permalink, so it opens in a new tab with any native
      // gesture (Ctrl/⌘-click, middle-click, right-click → Open in new tab); a plain
      // click below still opens it in place and dismisses the palette.
      return `${head}<a class="opt global-search-result ${i === active ? 'active' : ''}" id="gs-result-${i}" role="option" aria-selected="${i === active}" data-i="${i}"${item.href ? ` data-spa href="${esc(item.href)}"` : ''}>
        <span class="global-search-kind" aria-hidden="true">${item.group === 'Projects' ? '◇' : '□'}</span>
        <span class="global-search-copy"><b>${esc(item.title)}</b><span>${esc(item.sub || '')}</span></span>
      </a>`;
    }).join('');
    input.setAttribute('aria-activedescendant', `gs-result-${active}`);
    if (summary) list.insertAdjacentHTML('beforeend', `<div class="global-search-summary">${esc(summary)}</div>`);
    list.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' });
  };

  const search = async () => {
    const q = input.value.trim();
    const ownRequest = ++request;
    if (!q) { state = 'prompt'; items = []; summary = ''; active = 0; return draw(); }
    state = 'loading';
    draw();
    const responses = (await Promise.all(S.projects.map(async (project) => {
      try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/search?q=${encodeURIComponent(q)}`);
        return { project, result };
      } catch { return null; } // project discovery and task-read grants can differ
    }))).filter(Boolean);
    if (ownRequest !== request || !root.contains(input)) return;
    const found = assembleGlobalSearchResults(q, S.projects, responses);
    items = [
      ...found.projectHits.map(({ project }) => {
        const href = projectRoute(project.id);
        return { group: 'Projects', title: project.name, sub: 'Open project', href, run: () => spaNavigate(href) };
      }),
      ...found.taskHits.map(({ project, task }) => {
        const stateLabel = task.params?.draft ? 'draft' : task.params?.archived ? 'archived' : task.lastView?.stage || task.lastView?.status || task.workflow;
        const number = task.num != null ? `#${task.num} · ` : '';
        const href = `${projectRoute(project.id)}/tasks/${task.num != null ? task.num : encodeURIComponent(task.id)}`;
        return {
          group: 'Tasks', title: task.title,
          sub: `${number}${project.name} · ${stateLabel}`,
          href, run: () => spaNavigate(href),
        };
      }),
    ];
    summary = found.totalTasks > found.taskHits.length ? `Showing ${found.taskHits.length} of ${found.totalTasks} matching tasks` : '';
    active = 0;
    state = 'done';
    draw();
  };
  const schedule = () => { request++; clearTimeout(timer); timer = setTimeout(search, 160); };
  const run = (i) => { const item = items[i]; if (!item) return; close(); item.run(); };

  input.addEventListener('input', schedule);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.opt'); if (!row) return;
    if (isNewTabClick(e)) return; // real <a> result → let the browser open it in a new tab (palette stays open)
    e.preventDefault();
    run(Number(row.dataset.i));
  });
  list.addEventListener('mousemove', (e) => { const row = e.target.closest('.opt'); if (row && Number(row.dataset.i) !== active) { active = Number(row.dataset.i); draw(); } });
  $('#gs-close').addEventListener('click', close);
  $('#gs-scrim').addEventListener('click', (e) => { if (e.target.id === 'gs-scrim') close(); });
  draw();
  input.focus();
}

// -- the ⌘K palette: fuzzy command/action invocation --------------------------
function openPalette() {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="palette-scrim" id="pal-scrim"><div class="palette">
    <input id="pal-in" placeholder="Type a command…" autocomplete="off" />
    <div id="pal-list"></div>
  </div></div>`;
  const input = $('#pal-in');
  const list = $('#pal-list');
  const close = () => (root.innerHTML = '');
  let items = [];
  let active = 0;
  const GROUP_ORDER = { Task: 0, Navigation: 1, List: 2 };
  const build = () => {
    const q = input.value.trim();
    items = [];
    for (const c of allCommands()) {
      if (c.palette === false || !c.available) continue;
      const score = fuzzyScore(q, c.title);
      if (score < 0) continue;
      items.push({ group: c.group, title: c.title, kbd: c.keybinding, sub: c.workflow, danger: c.danger, score, run: c.run });
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
      <div class="section-h">On a task page</div>
      ${row('1–9', 'Press the Nth action button (whatever the workflow declares)')}
      ${row('[ / ]', 'Previous / next tab')}
      ${row('{ / }', 'Previous / next Check-in pane')}
      ${row('u', 'Back to the list')}
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
    <div class="form-row"><label>Email</label><input type="email" id="email" autocomplete="username" /></div>
    <div class="form-row"><label>Password</label><input type="password" id="pw" /></div>
    <button class="btn primary" id="login-btn" style="width:100%">Sign in</button>
    ${S.sso ? '<button class="btn" id="sso-btn" style="width:100%;margin-top:8px">Continue with company SSO</button>' : ''}
    <button class="btn" id="signup-open" style="width:100%;margin-top:8px">Create account</button>
    <div id="login-err" style="color:var(--danger);font-size:12px;margin-top:8px"></div>
  </div></div>`;
  const go = async () => {
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#email').value, password: $('#pw').value }) });
      if (res.ok) boot(); else $('#login-err').textContent = 'Invalid email or password';
    } catch { $('#login-err').textContent = 'Login failed'; }
  };
  $('#login-btn').addEventListener('click', go);
  $('#sso-btn')?.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/sso/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackURL: location.href }) });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || 'SSO unavailable');
      location.href = result.url;
    } catch (error) { $('#login-err').textContent = error.message; }
  });
  $('#signup-open').addEventListener('click', renderSignup);
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function renderSignup() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand" style="margin-bottom:12px"><span class="mark">◇</span> Create account</div>
    <p class="task-sub">Your account starts with no project access. An administrator can grant the right profile after you join.</p>
    <div class="form-row"><label>Name</label><input id="signup-name" autocomplete="name" /></div>
    <div class="form-row"><label>Email</label><input type="email" id="signup-email" autocomplete="username" /></div>
    <div class="form-row"><label>Password (10+ characters)</label><input type="password" id="signup-pw" autocomplete="new-password" /></div>
    <button class="btn primary" id="signup-btn" style="width:100%">Create account</button>
    <button class="btn" id="signup-back" style="width:100%;margin-top:8px">Back to sign in</button>
    <div id="signup-err" style="color:var(--danger);font-size:12px;margin-top:8px"></div>
  </div></div>`;
  const go = async () => {
    const res = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: $('#signup-name').value, email: $('#signup-email').value, password: $('#signup-pw').value,
    }) });
    if (res.ok) boot();
    else $('#signup-err').textContent = (await res.json().catch(() => ({}))).error || 'Could not create account';
  };
  $('#signup-btn').addEventListener('click', go);
  $('#signup-back').addEventListener('click', renderLogin);
  $('#signup-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function renderAccessPending() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand" style="margin-bottom:12px"><span class="mark">◇</span> Account created</div>
    ${S.inviteNotice ? `<p><b>${esc(S.inviteNotice)}</b></p>` : ''}
    <p>Your identity is active, but it does not have access to a project yet.</p>
    <p class="task-sub">Ask a karmax administrator to grant this account a global or project authorization profile. Signing in again will pick up the grant immediately.</p>
    <button class="btn primary" id="pending-retry" style="width:100%">Check again</button>
    <button class="btn" id="pending-workspace" style="width:100%;margin-top:8px">Create my own organization</button>
    <button class="btn" id="pending-logout" style="width:100%;margin-top:8px">Sign out</button>
  </div></div>`;
  $('#pending-retry').addEventListener('click', () => boot());
  $('#pending-workspace').addEventListener('click', async () => {
    const organizationName = prompt('Organization name'); if (!organizationName) return;
    const projectName = prompt('First project name', 'My project'); if (!projectName) return;
    try {
      const organization = await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name: organizationName }) });
      await api(`/api/organizations/${organization.id}/projects`, { method: 'POST', body: JSON.stringify({ name: projectName, config: {} }) });
      location.href = '/';
    } catch (error) { alert(error.message); }
  });
  $('#pending-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    location.reload();
  });
}

function renderSetup() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand" style="margin-bottom:12px"><span class="mark">◇</span> Set up karmax</div>
    <p class="task-sub">Create the first administrator. Additional accounts are managed from Organization settings.</p>
    <div class="form-row"><label>Name</label><input id="setup-name" autocomplete="name" /></div>
    <div class="form-row"><label>Email</label><input type="email" id="setup-email" autocomplete="username" /></div>
    <div class="form-row"><label>Password (10+ characters)</label><input type="password" id="setup-pw" autocomplete="new-password" /></div>
    <button class="btn primary" id="setup-btn" style="width:100%">Create administrator</button>
    <div id="setup-err" style="color:var(--danger);font-size:12px;margin-top:8px"></div>
  </div></div>`;
  const go = async () => {
    const res = await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: $('#setup-name').value, email: $('#setup-email').value, password: $('#setup-pw').value,
    }) });
    if (res.ok) boot(); else $('#setup-err').textContent = (await res.json().catch(() => ({}))).error || 'Setup failed';
  };
  $('#setup-btn').addEventListener('click', go);
  $('#setup-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="empty"><div class="big">Failed to load</div>${esc(e.message)}</div>`; });
