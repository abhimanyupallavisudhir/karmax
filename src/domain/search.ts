/**
 * Task search + organization engine (PLAN-search-views).
 *
 * A *view* IS a *query*: every task-list surface is the result of evaluating a
 * `TaskQuery` (free text + structured filters + sort + group) against the project's
 * tasks. This module is the single source of truth — the **searchable-field registry**
 * (`FIELDS`) below drives three consumers that would otherwise drift apart:
 *   1. the query-language parser/stringifier (`query-language.ts`),
 *   2. this evaluator (`evaluateQuery`),
 *   3. the UI's filter / sort / group menus (which read `FIELDS` over the wire).
 *
 * Deliberately PURE (no Node imports, no clock/random): `now` is passed in. That keeps
 * it usable from the deterministic-ish gateway path AND unit-testable with a fixed clock
 * (tests/search.test.ts) without booting Temporal.
 */
import { TaskRecord, TaskQuery, FilterClause, Tag, SortClause, PRIORITIES } from './types.js';
import { normalizeTriggers, isRecurring, nextCronFire, TaskTrigger } from './triggers.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';

/** A task as seen by search: the stored record, whose `lastView`/`tags` are hydrated. */
export type SearchTask = TaskRecord;

/**
 * Context threaded through the evaluator. Public callers pass `{ now, tags }`;
 * `evaluateQuery` enriches it with cross-task indices (id→num, reverse dependency
 * edges) so relational + time-based fields (`nextRun`, `dependsOn`, `blocks`) can
 * resolve. `now` is passed in (not read from a clock) to keep this module pure.
 */
export interface EvalContext {
  now: number;
  /** Project tag catalogue, for hierarchy expansion + name/path resolution. */
  tags?: Tag[];
  /** Authenticated user, used only for caller-relative facets such as `is:mine`. */
  userId?: string;
}
export interface FieldContext extends EvalContext {
  /** task id → per-project number, so deps can be shown/matched as `#num`. */
  idToNum?: Map<string, number>;
  /** dep-task-id → the tasks that depend on it (reverse edges, for `blocks:`). */
  blockedBy?: Map<string, SearchTask[]>;
}

export type FieldType = 'text' | 'enum' | 'number' | 'date' | 'tag' | 'facet';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Alternate keys accepted by the parser (e.g. `label` → `tag`). */
  aliases?: string[];
  /** Fixed choices for enum/facet fields (drives the UI menu + validation). */
  options?: FieldOption[];
  /** Can this field be grouped by? */
  groupable?: boolean;
  /** Can this field be sorted by? */
  sortable?: boolean;
  /** Extract the comparable value(s) used for filtering + grouping. `ctx` carries `now`
   *  + cross-task indices for time-based / relational fields; simple fields ignore it. */
  get(t: SearchTask, ctx?: FieldContext): string | number | string[] | undefined;
  /** Extract a sort key (numbers sort numerically; strings lexically). */
  sortKey?(t: SearchTask, ctx?: FieldContext): number | string;
}

// ─── helpers to read live state off the cached view ──────────────────────────
/**
 * A task gated behind an as-yet-unfired trigger (scheduled/dependency/event) is
 * *armed*: stored-not-started, so it has no `lastView` and would otherwise read as
 * `active`. Surface it as its own `armed` state so search/organization sees it.
 */
const isArmed = (t: SearchTask): boolean =>
  normalizeTriggers(t.params).length > 0 && t.params?.triggerState !== 'fired' && !t.lastView;
const status = (t: SearchTask) => t.lastView?.status ?? (isArmed(t) ? 'armed' : 'active');
/** The armed-aware status of a task (exported so compact projections agree with search). */
export function taskStatus(t: SearchTask): string {
  return status(t);
}
const stage = (t: SearchTask) => t.lastView?.stage ?? 'setup';
const lc = (s: unknown) => String(s ?? '').toLowerCase();

const STATUS_OPTIONS: FieldOption[] = [
  { value: 'armed', label: 'Armed (waiting for trigger)' },
  { value: 'active', label: 'Active' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const STAGE_OPTIONS: FieldOption[] = ['setup', 'do', 'review', 'pr', 'merge', 'done', ...(RESOLVE_AGENT_ENABLED ? ['resolve'] : []), 'escalated', 'cancelled', 'failed'].map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }));
const PRIORITY_OPTIONS: FieldOption[] = PRIORITIES.map((p, i) => ({ value: String(i), label: p[0]!.toUpperCase() + p.slice(1) }));

/**
 * The facets a task satisfies right now — powers `is:` queries (`is:draft`, `is:open`, …).
 * A single extensible bucket beats a pseudo-field per boolean.
 */
export const FACET_OPTIONS: FieldOption[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
  { value: 'active', label: 'Running' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'open', label: 'Open (not done/cancelled/failed)' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'subtask', label: 'Sub-task' },
  { value: 'parent', label: 'Has sub-tasks' },
  { value: 'pr', label: 'Has PR' },
  { value: 'tagged', label: 'Tagged' },
  { value: 'untagged', label: 'Untagged' },
  { value: 'prioritized', label: 'Prioritized' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'my-review', label: 'Needs my review' },
  // ── trigger / schedule / series facets (dependencies, cron, repeatable) ──
  { value: 'triggered', label: 'Has a trigger' },
  { value: 'armed', label: 'Armed (waiting for a trigger)' },
  { value: 'scheduled', label: 'Scheduled (cron / one-shot)' },
  { value: 'recurring', label: 'Recurring (cron or repeatable)' },
  { value: 'blocked-on-deps', label: 'Waiting on a dependency' },
  { value: 'series', label: 'Repeatable (template)' },
  { value: 'run', label: 'A run of a repeatable task' },
];

function facetsOf(t: SearchTask, ctx?: FieldContext): string[] {
  const f: string[] = [];
  const st = status(t);
  if (t.params?.draft) f.push('draft');
  if (t.params?.archived) f.push('archived');
  f.push(st);
  if (!['done', 'failed', 'cancelled'].includes(st)) f.push('open');
  if (stage(t) === 'escalated') f.push('escalated');
  if (t.parentTaskId) f.push('subtask');
  if (t.lastView?.subTasks?.length) f.push('parent');
  if (t.lastView?.pr) f.push('pr');
  f.push(t.tags?.length ? 'tagged' : 'untagged');
  if (typeof t.params?.priority === 'number' && t.params.priority > 0) f.push('prioritized');
  if (!t.assignee) f.push('unassigned');
  if (ctx?.userId && t.assignee?.kind === 'user' && t.assignee.userId === ctx.userId) f.push('mine');
  if (ctx?.userId && t.reviewers?.includes(ctx.userId)
    && stage(t) === 'review' && status(t) === 'waiting') f.push('my-review');
  // Trigger/series facets — read straight off params (already loaded on the record).
  const triggers = normalizeTriggers(t.params);
  if (triggers.length) f.push('triggered');
  if (isArmed(t)) f.push('armed');
  if (triggers.some((x) => x.kind === 'schedule')) f.push('scheduled');
  if (triggers.some(isRecurring) || t.params?.repeatable) f.push('recurring');
  if (isArmed(t) && triggers.some((x) => x.kind === 'dependency')) f.push('blocked-on-deps');
  if (t.params?.repeatable) f.push('series');
  if (t.params?.runOf) f.push('run');
  return f;
}

// ─── trigger / schedule / dependency reads (this feature) ────────────────────
const TRIGGER_OPTIONS: FieldOption[] = [
  { value: 'none', label: 'Immediate (no trigger)' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'event', label: 'Event' },
];
/** The task's primary trigger kind — for grouping "by how it starts". */
const primaryTriggerKind = (t: SearchTask): string => normalizeTriggers(t.params)[0]?.kind ?? 'none';
/** The cron expression of the first scheduled trigger, if any (for `schedule:` text search). */
const cronOf = (t: SearchTask): string | undefined => {
  for (const tr of normalizeTriggers(t.params)) if (tr.kind === 'schedule' && tr.cron) return tr.cron;
  return undefined;
};
/** Soonest upcoming fire time across this task's schedule triggers (epoch-ms), or undefined. */
const nextRunOf = (t: SearchTask, now: number): number | undefined => {
  let best: number | undefined;
  for (const tr of normalizeTriggers(t.params)) {
    if (tr.kind !== 'schedule') continue;
    const n = tr.cron ? nextCronFire(tr.cron, now) : typeof tr.at === 'number' && tr.at > now ? tr.at : undefined;
    if (n !== undefined && (best === undefined || n < best)) best = n;
  }
  return best;
};
/** Task ids this task depends on (across its dependency triggers). */
const dependencyIds = (t: SearchTask): string[] =>
  normalizeTriggers(t.params)
    .filter((x): x is Extract<TaskTrigger, { kind: 'dependency' }> => x.kind === 'dependency')
    .flatMap((x) => x.tasks ?? []);
/** A searchable blob of task references (`<id> #<num>` per ref) so `#42` and ids both match. */
const refBlob = (ids: string[], idToNum?: Map<string, number>): string =>
  ids.map((id) => `${id} #${idToNum?.get(id) ?? ''}`).join(' ');

/**
 * All conversation text across every role's transcript — powers the explicit
 * `conversation:` filter. Reads the cached `lastView` (already hydrated on the record),
 * so this is pure in-memory string scanning: what the task page shows, not the full
 * durable history. Deliberately NOT part of bare free-text: transcripts quote error
 * messages, file paths, and each other, so folding them into bare words would collapse
 * search precision — conversation search is opt-in by field key.
 */
const conversationText = (t: SearchTask): string | undefined => {
  const view = t.lastView;
  if (!view) return undefined;
  // `transcripts` carries all roles; the top-level `messages` is the Do transcript
  // kept for back-compat, so only fall back to it when transcripts are absent.
  const perRole = view.transcripts?.length ? view.transcripts.map((x) => x.messages) : [view.messages];
  const chunks: string[] = [];
  for (const msgs of perRole) for (const m of msgs ?? []) if (m?.text) chunks.push(m.text);
  return chunks.length ? chunks.join('\n') : undefined;
};

/** Stable, searchable principal spelling shared by filters, URLs, and audit events. */
const principalValue = (principal: TaskRecord['assignee']): string | undefined => {
  if (!principal) return undefined;
  switch (principal.kind) {
    case 'user': return `user:${principal.userId}`;
    case 'team': return `team:${principal.teamId}`;
    case 'task-agent': return `task-agent:${principal.taskId}:${principal.role}`;
  }
};

// ─── the searchable-field registry ───────────────────────────────────────────
export const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Title', type: 'text', get: (t) => t.title, sortable: true, sortKey: (t) => lc(t.title) },
  { key: 'num', label: 'Number', type: 'number', aliases: ['id', '#'], get: (t) => t.num, sortable: true, sortKey: (t) => t.num ?? 0 },
  { key: 'workflow', label: 'Workflow', type: 'enum', get: (t) => t.workflow, groupable: true, sortable: true, sortKey: (t) => lc(t.workflow) },
  { key: 'status', label: 'Status', type: 'enum', options: STATUS_OPTIONS, get: status, groupable: true, sortable: true, sortKey: (t) => STATUS_OPTIONS.findIndex((o) => o.value === status(t)) },
  { key: 'stage', label: 'Stage', type: 'enum', options: STAGE_OPTIONS, get: stage, groupable: true, sortable: true, sortKey: (t) => STAGE_OPTIONS.findIndex((o) => o.value === stage(t)) },
  { key: 'priority', label: 'Priority', type: 'number', options: PRIORITY_OPTIONS, get: (t) => Number(t.params?.priority ?? 0), groupable: true, sortable: true, sortKey: (t) => Number(t.params?.priority ?? 0) },
  { key: 'tag', label: 'Tag', type: 'tag', aliases: ['label', 'tags'], get: (t) => t.tags ?? [], groupable: true },
  { key: 'created', label: 'Created', type: 'date', get: (t) => t.createdAt, sortable: true, sortKey: (t) => t.createdAt ?? 0 },
  { key: 'updated', label: 'Updated', type: 'date', get: (t) => t.lastView?.updatedAt, sortable: true, sortKey: (t) => t.lastView?.updatedAt ?? t.createdAt ?? 0 },
  { key: 'notes', label: 'Notes', type: 'text', get: (t) => t.notes },
  { key: 'prompt', label: 'Prompt', type: 'text', get: (t) => (t.params?.prompt == null ? undefined : String(t.params.prompt)) },
  { key: 'conversation', label: 'Conversation', type: 'text', aliases: ['says'], get: conversationText },
  { key: 'branch', label: 'Branch', type: 'text', get: (t) => t.lastView?.branch },
  { key: 'target', label: 'Target', type: 'text', aliases: ['targetBranch'], get: (t) => t.lastView?.targetBranch },
  { key: 'parent', label: 'Parent', type: 'text', get: (t) => t.parentTaskId },
  { key: 'creator', label: 'Creator', type: 'text', aliases: ['createdBy'], get: (t) => principalValue(t.createdBy), groupable: true },
  { key: 'assignee', label: 'Assignee', type: 'text', aliases: ['assigned'], get: (t) => principalValue(t.assignee), groupable: true },
  { key: 'delegate', label: 'Delegate', type: 'text', get: (t) => principalValue(t.delegate), groupable: true },
  { key: 'subscriber', label: 'Subscriber', type: 'text', aliases: ['subscribed'], get: (t) => (t.subscribers ?? []).map((p) => principalValue(p)!).filter(Boolean), groupable: true },
  { key: 'reviewer', label: 'Reviewer', type: 'text', aliases: ['reviewers'], get: (t) => (t.reviewers ?? []).map((id) => `user:${id}`), groupable: true },
  { key: 'participant', label: 'Participant', type: 'text', get: (t) => [t.createdBy, t.assignee, t.delegate, ...(t.subscribers ?? [])].map((p) => principalValue(p)).filter((p): p is string => Boolean(p)), groupable: true },
  // ── trigger / schedule / dependency fields (this feature) ──
  { key: 'trigger', label: 'Trigger', type: 'enum', options: TRIGGER_OPTIONS, get: primaryTriggerKind, groupable: true, sortable: true, sortKey: (t) => primaryTriggerKind(t) },
  { key: 'schedule', label: 'Schedule', type: 'text', aliases: ['cron'], get: (t) => cronOf(t) },
  { key: 'nextRun', label: 'Next run', type: 'date', aliases: ['next', 'nextrun'], get: (t, ctx) => nextRunOf(t, ctx?.now ?? 0), sortable: true, sortKey: (t, ctx) => nextRunOf(t, ctx?.now ?? 0) ?? Number.MAX_SAFE_INTEGER },
  { key: 'dependsOn', label: 'Depends on', type: 'text', aliases: ['dependson', 'dep', 'after'], get: (t, ctx) => refBlob(dependencyIds(t), ctx?.idToNum) },
  { key: 'blocks', label: 'Blocks', type: 'text', get: (t, ctx) => refBlob((ctx?.blockedBy?.get(t.id) ?? []).map((d) => d.id), ctx?.idToNum) },
  { key: 'is', label: 'Is', type: 'facet', aliases: ['has', 'needs'], options: FACET_OPTIONS, get: facetsOf },
];

const BY_KEY = new Map<string, FieldDef>();
for (const f of FIELDS) {
  BY_KEY.set(f.key, f);
  for (const a of f.aliases ?? []) BY_KEY.set(a, f);
}

/**
 * Synthetic field for an arbitrary workflow param — `param.<key>` (also `p.<key>`).
 * Workflow params are heterogeneous across workflows, so baking each into the fixed
 * registry would be noisy and workflow-dependent; instead any `param.foo` resolves on
 * demand to a field that reads `params.foo`, coerced to a string. Filterable (contains),
 * groupable, and sortable — so `param.base:main`, `group:param.base`, `sort:param.base`
 * all work without a schema. Values that are objects (e.g. profiles) stringify to JSON.
 */
function paramField(key: string): FieldDef {
  const paramKey = key.replace(/^(param|p)\./, '');
  const read = (t: SearchTask) => {
    const v = t.params?.[paramKey];
    if (v == null) return undefined;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return {
    key,
    label: paramKey,
    type: 'text',
    groupable: true,
    sortable: true,
    get: read,
    sortKey: (t) => lc(read(t)),
  };
}

/**
 * Synthetic field for a per-role agent/model param — `agent_<role>.<sub>` where sub is
 * `agent` (the provider), `model`, or `effort`. Agent specs are stored as an object under
 * the role's param key (e.g. `params.do = { provider, model, effort }`; confirmers add
 * `mode`), so `agent_do.model`, `group:agent_do.agent`, `sort:agent_merge.effort` all
 * resolve. `agent` maps to the stored `provider` field. Kept distinct from `param.<key>`
 * so the UI can label these nicely and expand an agent field into its three sub-fields.
 */
const AGENT_SUB: Record<string, string> = { agent: 'provider', model: 'model', effort: 'effort' };
function agentField(key: string): FieldDef {
  const m = key.match(/^agent_([a-z0-9]+)\.(agent|model|effort)$/i)!;
  const role = m[1]!.toLowerCase();
  const storageKey = AGENT_SUB[m[2]!.toLowerCase()]!;
  const read = (t: SearchTask) => {
    let spec = t.params?.[role] as any;
    // A confirmer stores layers; read the first agent layer's spec.
    if (spec && typeof spec === 'object' && Array.isArray(spec.layers)) spec = spec.layers.find((l: any) => l?.kind === 'agent');
    const v = spec && typeof spec === 'object' ? spec[storageKey] : undefined;
    return v == null ? undefined : String(v);
  };
  return { key, label: `${role} ${m[2]!.toLowerCase()}`, type: 'text', groupable: true, sortable: true, get: read, sortKey: (t) => lc(read(t)) };
}

export function fieldByKey(key: string): FieldDef | undefined {
  const hit = BY_KEY.get(key) ?? BY_KEY.get(key.toLowerCase());
  if (hit) return hit;
  if (/^agent_[a-z0-9]+\.(agent|model|effort)$/i.test(key)) return agentField(key.toLowerCase());
  if (/^(param|p)\.[^.\s]+$/i.test(key)) return paramField(key.toLowerCase());
  return undefined;
}

// ─── tag hierarchy resolution ────────────────────────────────────────────────
/** Build id→children adjacency once so descendant expansion is cheap. */
function childIndex(tags: Tag[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const t of tags) if (t.parentId) (idx.get(t.parentId) ?? idx.set(t.parentId, []).get(t.parentId)!).push(t.id);
  return idx;
}

/** The full `a/b/c` path of a tag, walking parents. */
export function tagPath(tag: Tag, byId: Map<string, Tag>): string {
  const parts: string[] = [];
  let cur: Tag | undefined = tag;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join('/');
}

/**
 * Resolve a tag filter value (an id, a leaf name, or an `a/b` path) to the set of tag ids
 * it selects — the matched tag PLUS all its descendants (parent selection includes
 * children, the Linear label-group behaviour).
 */
export function resolveTagValue(value: string, tags: Tag[]): Set<string> {
  const out = new Set<string>();
  if (!tags.length) {
    out.add(value); // no catalogue → treat the value as a raw id
    return out;
  }
  const byId = new Map(tags.map((t) => [t.id, t]));
  const kids = childIndex(tags);
  const v = value.toLowerCase();
  const roots = tags.filter((t) => t.id === value || t.name.toLowerCase() === v || tagPath(t, byId).toLowerCase() === v);
  const stack = roots.map((r) => r.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of kids.get(id) ?? []) stack.push(c);
  }
  return out;
}

// ─── date value parsing ──────────────────────────────────────────────────────
type DateVal = { kind: 'instant'; ts: number } | { kind: 'age'; ms: number };
const DUR_MS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 };
function parseDateValue(value: string, now: number): DateVal | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'today') return { kind: 'age', ms: DUR_MS.d! };
  const dur = v.match(/^(\d+)\s*([hdwm])$/);
  if (dur) return { kind: 'age', ms: Number(dur[1]) * DUR_MS[dur[2]!]! };
  const abs = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (abs) return { kind: 'instant', ts: Date.UTC(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])) };
  const n = Number(v);
  if (Number.isFinite(n)) return { kind: 'instant', ts: n };
  return undefined;
}

// ─── clause matching ─────────────────────────────────────────────────────────
function matchClause(t: SearchTask, clause: FilterClause, ctx: FieldContext): boolean {
  const field = fieldByKey(clause.field);
  if (!field) return true; // unknown field ⇒ inert (don't silently drop everything)
  const raw = field.get(t, ctx);
  let ok: boolean;
  switch (field.type) {
    case 'tag': {
      const have = new Set((raw as string[]) ?? []);
      ok = clause.values.some((val) => {
        for (const id of resolveTagValue(val, ctx.tags ?? [])) if (have.has(id)) return true;
        return false;
      });
      break;
    }
    case 'facet': {
      const have = new Set((raw as string[]) ?? []);
      ok = clause.values.some((v) => have.has(v.toLowerCase()));
      break;
    }
    case 'number': {
      const nv = typeof raw === 'number' ? raw : Number(raw);
      ok = clause.values.some((v) => {
        const target = priorityNumber(field.key, v);
        if (!Number.isFinite(nv) || !Number.isFinite(target)) return false;
        return compareNum(nv, clause.op, target);
      });
      break;
    }
    case 'date': {
      const dv = typeof raw === 'number' ? raw : Number(raw);
      ok = clause.values.some((v) => {
        const parsed = parseDateValue(v, ctx.now);
        if (!parsed || !Number.isFinite(dv)) return false;
        return matchDate(dv, clause.op, parsed, ctx.now);
      });
      break;
    }
    case 'enum': {
      const sv = lc(raw);
      ok = clause.values.some((v) => (clause.op === 'contains' ? sv.includes(v.toLowerCase()) : sv === v.toLowerCase()));
      break;
    }
    default: {
      // text
      const sv = lc(raw);
      ok = clause.values.some((v) => sv.includes(v.toLowerCase()));
    }
  }
  return clause.negate ? !ok : ok;
}

function priorityNumber(fieldKey: string, v: string): number {
  if (fieldKey === 'priority') {
    const named = PRIORITIES.indexOf(v.toLowerCase() as (typeof PRIORITIES)[number]);
    if (named >= 0) return named;
  }
  return Number(v);
}

function compareNum(a: number, op: FilterClause['op'], b: number): boolean {
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return a === b;
  }
}

function matchDate(ts: number, op: FilterClause['op'], val: DateVal, now: number): boolean {
  if (val.kind === 'age') {
    const threshold = now - val.ms;
    // lt/lte ("<7d") = newer than the threshold; gt/gte = older; is = within the window.
    if (op === 'gt' || op === 'gte') return ts <= threshold;
    return ts >= threshold;
  }
  const day = 86400e3;
  switch (op) {
    case 'gt': case 'gte': return ts >= val.ts;
    case 'lt': case 'lte': return ts < val.ts;
    default: return ts >= val.ts && ts < val.ts + day; // same calendar day
  }
}

// ─── full-text ───────────────────────────────────────────────────────────────
// This is the AUTHORITATIVE free-text matcher (the server search path runs it). The web
// console has a client-side twin, `taskMatches` in web/app.js, used as the pre-server
// fallback AND by the fork-from picker — keep the two behaviours in sync when editing.
// Semantics: token-AND — every whitespace-separated term must appear somewhere in the
// task's title, notes, prompt, or `#num` (order-independent), so "login fix" matches
// "fix login". The prompt is included because titles are just the prompt's first line —
// a task whose prompt opens with a boilerplate preamble is otherwise unfindable.
function matchText(t: SearchTask, q: string): boolean {
  const needle = q.toLowerCase().trim();
  if (!needle) return true;
  const hay = `${lc(t.title)} ${lc(t.notes)} ${lc(t.params?.prompt)} ${t.num != null ? '#' + t.num : ''}`;
  return needle.split(/\s+/).every((term) => !term || hay.includes(term));
}

// ─── the evaluator ───────────────────────────────────────────────────────────
export interface TaskGroup {
  key: string;
  label: string;
  count: number;
  tasks: SearchTask[];
}

export interface EvalResult {
  /** The flat, filtered + sorted list (always present). */
  tasks: SearchTask[];
  /** When the query groups, the tasks bucketed (a task may appear in several tag groups). */
  groups?: TaskGroup[];
  total: number;
}

const DEFAULT_SORT: SortClause[] = [{ field: 'created', dir: 'desc' }];

/**
 * Enrich the caller's `{ now, tags }` with cross-task indices so relational/time fields
 * can resolve: id→num (render deps as `#num`) and the reverse dependency map (`blocks:`).
 * O(n) over the candidate set — cheap at todo-list scale.
 */
function enrichContext(tasks: SearchTask[], ctx: EvalContext): FieldContext {
  const idToNum = new Map<string, number>();
  for (const t of tasks) if (t.num != null) idToNum.set(t.id, t.num);
  const blockedBy = new Map<string, SearchTask[]>();
  for (const t of tasks) {
    for (const dep of dependencyIds(t)) {
      const arr = blockedBy.get(dep) ?? blockedBy.set(dep, []).get(dep)!;
      arr.push(t);
    }
  }
  return { ...ctx, idToNum, blockedBy };
}

export function evaluateQuery(tasks: SearchTask[], query: TaskQuery, ctx: EvalContext): EvalResult {
  const ectx = enrichContext(tasks, ctx);
  const filters = query.filters ?? [];
  let out = tasks.filter((t) => matchText(t, query.text ?? '') && filters.every((c) => matchClause(t, c, ectx)));

  const sort = query.sort?.length ? query.sort : DEFAULT_SORT;
  out = sortTasks(out, sort, ectx);

  let groups: TaskGroup[] | undefined;
  if (query.group) groups = groupTasks(out, query.group, ectx);

  return { tasks: out, groups, total: out.length };
}

function sortTasks(tasks: SearchTask[], sort: SortClause[], ctx: FieldContext): SearchTask[] {
  const withIdx = tasks.map((t, i) => ({ t, i }));
  withIdx.sort((A, B) => {
    for (const s of sort) {
      const f = fieldByKey(s.field);
      if (!f?.sortKey) continue;
      const ka = f.sortKey(A.t, ctx);
      const kb = f.sortKey(B.t, ctx);
      let c = ka < kb ? -1 : ka > kb ? 1 : 0;
      if (s.dir === 'desc') c = -c;
      if (c) return c;
    }
    return A.i - B.i; // stable
  });
  return withIdx.map((x) => x.t);
}

function groupTasks(tasks: SearchTask[], groupKey: string, ctx: FieldContext): TaskGroup[] {
  const field = fieldByKey(groupKey);
  if (!field) return [{ key: '', label: 'All', count: tasks.length, tasks }];
  const byId = new Map((ctx.tags ?? []).map((t) => [t.id, t]));
  const buckets = new Map<string, SearchTask[]>();
  const order: string[] = [];
  const push = (key: string, t: SearchTask) => {
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key)!.push(t);
  };
  for (const t of tasks) {
    if (field.type === 'tag') {
      const ids = (field.get(t, ctx) as string[]) ?? [];
      if (!ids.length) push('__untagged__', t);
      else for (const id of ids) push(id, t);
    } else {
      const v = field.get(t, ctx);
      push(v === undefined || v === '' ? '__none__' : String(v), t);
    }
  }
  const labelFor = (key: string): string => {
    if (key === '__untagged__') return 'Untagged';
    if (key === '__none__') return 'None';
    if (field.type === 'tag') return byId.get(key) ? tagPath(byId.get(key)!, byId) : key;
    if (field.options) return field.options.find((o) => o.value === key)?.label ?? key;
    return key;
  };
  const groups = order.map((key) => ({ key, label: labelFor(key), count: buckets.get(key)!.length, tasks: buckets.get(key)! }));
  // Order groups by the field's natural option order where one exists; else by label.
  if (field.options) {
    const rank = (k: string) => { const i = field.options!.findIndex((o) => o.value === k); return i < 0 ? 1e9 : i; };
    groups.sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
  } else {
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }
  return groups;
}

/** A compact descriptor of the field registry the UI consumes to build its menus. */
export function fieldCatalogue() {
  return FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, aliases: f.aliases, options: f.options, groupable: !!f.groupable, sortable: !!f.sortable }));
}
