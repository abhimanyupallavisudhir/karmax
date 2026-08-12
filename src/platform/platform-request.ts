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
  '/api/sso/start',
  '/api/agent-mail/ingest', // inbound mail webhook, authenticated by a minted secret
  '/api/integrations/', // external webhooks, authenticated by provider signature or source secret
  '/api/payments/stripe/', // Stripe OAuth callback + signature-verified webhook
  '/api/github/webhook', // GitHub webhook, HMAC-authenticated
  '/api/github/callback',
  '/api/github/oauth/callback',
  '/api/github/manifest/callback',
  '/api/tls/preview-allow', // Caddy on-demand TLS probe
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
      + 'Account creation and sign-in are human operations — ask a human, or use the authorization/user administration routes if you hold user:write.';
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
  });
  return { total: result?.total ?? 0, tasks: (result?.tasks ?? []).map(one) };
}

export function compactTags(tags: any[]): { path: string; kind?: string; description?: string }[] {
  const byId = tagsById(tags);
  return (tags ?? [])
    .map((t) => ({ path: tagPathOf(t.id, byId), kind: t.kind, description: t.description }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
