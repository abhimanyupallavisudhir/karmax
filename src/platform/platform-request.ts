import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { taskStatus } from '../domain/search.js';

/**
 * The pieces of the agent-facing platform surface that BOTH tool definitions
 * must share: the MCP server in `src/platform/mcp.ts` and the provider-neutral
 * schemas in `src/agent/tools.ts` (what Codex and remote-world agents see).
 *
 * This is a deliberate leaf module — no imports beyond a feature flag — because
 * `mcp.ts` → `api.ts` → `agent/adapters.ts` → `agent/claude.ts` → `agent/tools.ts`
 * is already an import chain; having `tools.ts` reach back into `mcp.ts` would
 * close that into a cycle whose top-level constants could evaluate as
 * `undefined`. `mcp.ts` re-exports everything here, so importing from either
 * module gets the same single definition and the two surfaces cannot drift.
 */

/** Ordinal priority names (index = stored value); shared so agents can pass a level name. */
export const PRIORITY_NAMES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

/** How an agent gives a task it creates what it needs (create_task, both tool surfaces). */
export const CREATE_TASK_GRANTS = 'Grant it what it needs: `authorization` {level, scope, projectIds?} and vault credentials '
  + '(`use-credential:item:<id>` | `:tag:<tag>` | `:domain:<domain>`), up to what you hold yourself. '
  + 'What you cannot grant is not refused: the task waits for approval, the request goes at once to the lowest level that can grant it '
  + '(or `authorization_audience`, with your `authorization_reason`), and approval starts it — nothing else to do. '
  + 'A `draft` is only held: ask with request_permission and its task id when it should run.';

/** Whom request_permission asks (KarmaxApi.permissionGrantors), shared by both tool surfaces. */
export const PERMISSION_ROUTING = 'Audience selectors: task:<id>, avatar:<task id>, user:<id>, @team:<slug>, @creator, @maintainers, @admins, @superadmins, @owners, @project, or @all. '
  + 'Omit audience to ask the nearest who can grant it: a task you act for that holds it (your parent, or the task whose agent created yours; its agent decides), '
  + 'else the lowest of @maintainers, @admins and @superadmins that can. platform_request(GET, "/api/agent/escalation-targets?capabilities=<a,b>") lists '
  + 'everyone who can, nearest first; the result names them too (canGrant). A sub-task already holds everything its parent does. ';

/** queue_task (both tool surfaces): start a draft. */
export const QUEUE_TASK_DESCRIPTION = 'Start a draft task (one saved with create_task or create_sub_task `draft: true`). '
  + 'A draft sub-task of yours starts when your current turn ends, branching off your work as it is then; '
  + 'one of another task starts when that task\'s agent ends its turn. A draft with triggers is armed instead.';

/** What queue_task answers for the task POST /api/tasks/:id/queue returned. */
export function queuedTaskReply(task: { id?: string; parentTaskId?: string; params?: Record<string, unknown> } | undefined, fallbackId: string): string {
  const id = task?.id ?? fallbackId;
  if (task?.params?.triggerState === 'armed') return `armed ${id}: it starts when its triggers fire`;
  return task?.parentTaskId && task.params?.draft
    ? `queued ${id}: it starts when its parent task's agent ends its turn` : `started ${id}`;
}

/** request_permission's other use: asking for what a task you created is held for. */
export const REQUEST_FOR_TASK = 'Pass a task id instead to ask for the authorization and credentials a draft you created '
  + 'asked for but you could not grant; you keep working, and it starts once they are granted.';

/**
 * The agent roles a task can carry a conversation for. One list so the three
 * role-taking tools agree: `get_conversation` used to advertise `confirm` while
 * `signal_task` refused it and `message_agent` took any string at all, which
 * left agents guessing which spelling a given tool would accept.
 */
export const AGENT_ROLE_NAMES = (RESOLVE_AGENT_ENABLED
  ? ['do', 'merge', 'resolve', 'confirm']
  : ['do', 'merge', 'confirm']) as [string, ...string[]];

/**
 * Accept a `platform_request` body as either a structured value or a JSON string.
 * The string form is the escape hatch for clients that cannot express a free-form
 * object; a string that is not valid JSON is forwarded verbatim, so an endpoint
 * genuinely expecting a JSON string still receives one.
 */
export function normalizeRequestBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * The JSON-Schema shape advertised for a `platform_request` body.
 *
 * `body` must describe a concrete shape. Declared as `z.unknown()` it serialized
 * to an *empty* JSON Schema (`{}`), and clients dropped the argument before it
 * ever reached the gateway — every write silently became a no-op against an
 * empty body (a POST reached createTag as `{}` and threw on `name.trim()`).
 * `src/agent/tools.ts` declared `{ type: 'object' }` with no properties, which
 * is the same hazard one quirk away and additionally cannot express an array or
 * string body. The string arm is a deliberate escape hatch for clients that
 * cannot marshal a free-form object; `normalizeRequestBody` parses it.
 */
export const PLATFORM_REQUEST_BODY_SCHEMA = {
  description:
    'Request payload: a JSON object (the usual case), a JSON array, or a JSON string that will be parsed. '
    + 'Omit for GET/DELETE.',
  anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }],
} as const;

/** `fields`: the parts of a response to return, as dotted paths. */
export const FIELDS_PARAMETER = {
  type: 'array',
  items: { type: 'string' },
  description: 'Only these parts of the response, as dotted paths (e.g. ["stage", "waitingFor.detail"]); an array keeps them of each item. '
    + 'A response over 60000 characters is otherwise described (each field\'s size) rather than returned.',
} as const;

/**
 * Routes the gateway answers **before** its session/capability gate. They are
 * unauthenticated by construction — the sign-in/sign-up surface, webhooks that
 * verify their own shared secret or signature, and OAuth callbacks — so nothing
 * about the caller's scoped token is checked on them.
 *
 * `platform_request` must therefore refuse every one of them. The live hole this
 * closes: `/api/auth/*` is forwarded to Better Auth (with `emailAndPassword`
 * enabled) ahead of the gate, so `POST /api/auth/sign-up/email` let an agent mint
 * itself a human login with no `user:write`; and `POST /api/signup` additionally
 * runs `provisionPersonalWorkspace` → `bootstrapOrganizationOwner`, handing that
 * new identity `administrator` at organization scope.
 *
 * Both agent-facing surfaces consult this one list. They had already drifted, and
 * the in-agent copy (Codex + remote-world agents) was the weaker one — it denied
 * only `/api/login` and `/api/setup`.
 */
export const PLATFORM_REQUEST_EXCLUDED_PATHS = [
  '/api/auth/', // Better Auth: sign-up/sign-in/session, forwarded before the gate
  '/api/login',
  '/api/setup',
  '/api/signup',
  '/api/session',
  '/api/launch', // public policy/version + central hosted-plan catalog
  '/api/legal/', // public policy documents and pre-OAuth acceptance handoff
  '/api/sso/start',
  '/api/agent-mail/ingest', // inbound mail webhook, authenticated by a minted secret
  '/api/payments/stripe/', // Stripe OAuth callback + signature-verified webhook
  '/api/github/webhook', // GitHub webhook, HMAC-authenticated
  '/api/hooks/', // incoming webhooks, each authenticated by its hook's secret
  '/api/github/callback',
  '/api/github/oauth/callback',
  '/api/github/manifest/callback',
  '/api/tls/preview-allow', // Caddy on-demand TLS probe
  '/api/subscriptions/webhook', // Stripe subscription webhook, signature-verified
  '/api/meta',
  '/api/health/',
] as const;

/**
 * Resolve a path the way the transport will, *before* it is screened.
 *
 * Both dispatchers build a URL by concatenation — `fetch(`${base}${path}`)` in
 * `src/activities/core.ts` and `src/platform/mcp.ts` — and the gateway then
 * re-parses what arrives with `new URL(req.url, …)`. Every one of those hops
 * runs the WHATWG URL parser, which **resolves `.` and `..` segments**. So
 * `/api/tasks/../auth/sign-up/email` is screened as an innocuous `/api/tasks/…`
 * string and *arrives* at `/api/auth/sign-up/email` — the precise route the
 * exclusion list exists to refuse, and the privilege escalation it was added to
 * close. Duplicate slashes are collapsed for the same reason: a path must not be
 * spellable so that it reads as allowed here and routes as excluded there.
 *
 * Screen the normalized form, and dispatch the normalized form, so the string
 * that was checked is always the string that is sent.
 */
export function normalizePlatformPath(path: string): string {
  let url: URL;
  try {
    // Mirror the dispatchers exactly: concatenation onto an origin, not
    // `new URL(path, base)` — the latter reads a leading `//` as protocol-
    // relative and would resolve a different path than the one that is sent.
    url = new URL(`http://platform.invalid${path}`);
  } catch {
    return path; // unparseable — the caller's `startsWith` checks still refuse it
  }
  return `${url.pathname.replace(/\/{2,}/g, '/')}${url.search}${url.hash}`;
}

/**
 * Validate a `platform_request` path. Returns an explanatory message when the
 * path may not be called, or `undefined` when it is allowed. The message names
 * the actual reason — the old text ("platform path must be an authenticated
 * /api/* endpoint") wrongly implied the caller had asked for something outside
 * `/api/`.
 *
 * Callers must dispatch `normalizePlatformPath(path)`, not the raw path.
 */
export function platformRequestPathError(path: string): string | undefined {
  if (!path.startsWith('/api/')) return `platform path must start with /api/ (got ${path || '""'})`;
  const normalized = normalizePlatformPath(path);
  const bare = normalized.split(/[?#]/)[0]!;
  // `..` can also climb straight out of the API surface (`/api/../admin`).
  if (!bare.startsWith('/api/'))
    return `platform path must start with /api/ (got ${path}, which resolves to ${bare})`;
  const excluded = PLATFORM_REQUEST_EXCLUDED_PATHS.some((prefix) =>
    prefix.endsWith('/') ? bare.startsWith(prefix) : bare === prefix || bare.startsWith(`${prefix}/`));
  if (excluded)
    return `${bare} is excluded from platform_request: the gateway answers it before the session gate, so it performs no capability check. `
      + 'Use the authenticated authorization/user administration routes with user:write for account administration; authentication callbacks retain their own protocol checks.';
  return undefined;
}

// ─── shared projections (tag id → `a/b/c` path; full record → compact) ─────────
// Both agent surfaces return these compact shapes rather than raw store records:
// a raw search result carries every task's full `lastView`, transcripts included,
// which is megabytes of an agent's context for a list of titles.

/** The compact task projection agents get back from search (ids + the human-facing bits). */
export interface CompactTask {
  num?: number;
  id: string;
  title: string;
  workflow: string;
  status: string;
  stage?: string;
  priority: number;
  draft: boolean;
  tags: string[];
  /** On an organization search: the task's project. */
  projectId?: string;
  /** On a `for:` search: why it waits on the people named (inbox kinds, `draft`). */
  for?: string[];
}

function tagPathOf(id: string, byId: Map<string, any>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return parts.join('/') || id;
}

function tagsById(tags: any[]): Map<string, any> {
  return new Map((tags ?? []).map((t) => [t.id, t]));
}

export function compactSearch(result: any, tags: any[]): { total: number; tasks: CompactTask[] } {
  const byId = tagsById(tags);
  const one = (t: any): CompactTask => ({
    num: t.num,
    id: t.id,
    title: t.title,
    workflow: t.workflow,
    status: t.lastView?.status ?? (t.params?.draft ? 'draft' : taskStatus(t)),
    stage: t.lastView?.stage,
    priority: Number(t.params?.priority ?? 0),
    draft: !!t.params?.draft,
    tags: (t.tags ?? []).map((id: string) => tagPathOf(id, byId)),
    ...(t.projectId && result?.projects ? { projectId: t.projectId } : {}),
    ...(result?.reasons?.[t.id] ? { for: result.reasons[t.id] } : {}),
  });
  return { total: result?.total ?? 0, tasks: (result?.tasks ?? []).map(one) };
}

/** An organization search carries its own tag catalogue (every project's). */
export function compactOrganizationSearch(result: { tags?: unknown[] } | undefined): { total: number; tasks: CompactTask[] } {
  return compactSearch(result, result?.tags ?? []);
}

export function compactTags(tags: any[]): { path: string; kind?: string; description?: string }[] {
  const byId = tagsById(tags);
  return (tags ?? [])
    .map((t) => ({ path: tagPathOf(t.id, byId), kind: t.kind, description: t.description }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ─── response size: compact by default, chosen fields on request ───────────────
// A task's full view repeats its conversation (messages, and each transcript),
// so get_task, a PATCH reply or a search through platform_request ran to
// 100–350k characters and overflowed an agent's context. Agents get compact
// projections, and may name the fields they want.

/** Above this, a response is described rather than returned (pass `fields`). */
export const RESPONSE_CHARACTER_LIMIT = 60_000;

/** Keep only `fields` of a value: dotted paths into an object ("waitingFor.detail");
 * an array keeps them of each of its items. Unknown paths are left out. */
export function selectFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => selectFields(item, fields));
  if (!value || typeof value !== 'object') return value;
  const groups = new Map<string, string[]>();
  for (const field of fields) {
    const [head, ...rest] = String(field).split('.');
    if (!head) continue;
    const group = groups.get(head) ?? [];
    if (rest.length) group.push(rest.join('.')); else group.push('');
    groups.set(head, group);
  }
  const out: Record<string, unknown> = {};
  for (const [head, rests] of groups) {
    if (!Object.prototype.hasOwnProperty.call(value, head)) continue;
    const inner = (value as Record<string, unknown>)[head];
    out[head] = rests.includes('') ? inner : selectFields(inner, rests);
  }
  return out;
}

/** JSON of a response, or — over `limit` characters — what it holds and how to
 * ask for part of it: each top-level field's size, or an array's length and
 * its items' fields. */
export function boundedJson(value: unknown, limit = RESPONSE_CHARACTER_LIMIT): string {
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= limit) return text;
  const sizes = (object: Record<string, unknown>) => Object.fromEntries(Object.entries(object)
    .map(([key, field]) => [key, (JSON.stringify(field) ?? '').length]));
  const items = Array.isArray(value) ? value : undefined;
  const shape = items
    ? { items: items.length, itemFields: items[0] && typeof items[0] === 'object' ? sizes(items[0] as Record<string, unknown>) : undefined }
    : value && typeof value === 'object' ? { fieldSizes: sizes(value as Record<string, unknown>) } : undefined;
  return JSON.stringify({
    truncated: true, characters: text.length,
    note: `This response is ${text.length} characters, more than ${limit}. Ask again with fields: the dotted paths you need`
      + ` (e.g. ["stage", "status", "waitingFor"]; an array keeps them of each item).`,
    ...shape,
  });
}

/** A task view without its conversation: how many messages there are and the
 * last one (shortened), and every other field as it is. get_task returns this
 * unless asked for fields; ask for "messages" to get the conversation. */
export function compactTaskView<T extends Record<string, unknown> | undefined>(view: T): T {
  if (!view) return view;
  const { messages, transcripts, reviewInfo, ...rest } = view as Record<string, unknown>;
  const list = Array.isArray(messages) ? messages as Array<Record<string, unknown>> : [];
  const last = list.at(-1);
  const text = typeof last?.text === 'string' ? last.text : '';
  const info = reviewInfo && typeof reviewInfo === 'object' ? (() => {
    const { html: _html, ...kept } = reviewInfo as Record<string, unknown>;
    return kept;
  })() : reviewInfo;
  return {
    ...rest,
    ...(info !== undefined ? { reviewInfo: info } : {}),
    messageCount: list.length,
    ...(last ? { lastMessage: { role: last.role, ...(last.author ? { author: last.author } : {}),
      text: text.length > 2_000 ? `${text.slice(0, 2_000)}… (${text.length} characters; fields: ["messages"] for all)` : text, ts: last.ts } } : {}),
    ...(Array.isArray(transcripts) && transcripts.length ? { transcriptRoles: transcripts.map((transcript: any) => transcript?.role) } : {}),
  } as unknown as T;
}

/** What an agent's get_task returns: the compact view, or the fields it named. */
export function agentTaskView(view: unknown, fields?: unknown): string {
  const wanted = Array.isArray(fields) ? fields.map(String).filter(Boolean)
    : typeof fields === 'string' && fields.trim() ? fields.split(',').map((field) => field.trim()).filter(Boolean) : [];
  return boundedJson(wanted.length ? selectFields(view, wanted) : compactTaskView(view as Record<string, unknown> | undefined));
}

/** What an agent's platform_request returns: the fields it named, if any, within the size limit. */
export function agentPlatformResponse(value: unknown, fields?: unknown): string {
  const wanted = Array.isArray(fields) ? fields.map(String).filter(Boolean) : [];
  return boundedJson(wanted.length ? selectFields(value, wanted) : value);
}
