import { describe, expect, it } from 'vitest';
import { routeCapability } from '../src/gateway/server.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';

/** Expand a catalog entry like `GET|POST /api/tasks/:taskId/params|notes` into
 * concrete (method, path, url) probes. WS entries have no HTTP capability. */
function expandEntry(entry: string): Array<{ method: string; path: string; url: URL }> {
  const [methods, spec] = entry.split(' ');
  if (!methods || !spec || methods === 'WS') return [];
  const [rawPath, rawQuery] = spec.split('?');
  return methods.split('|').flatMap((method) => expandAlternatives(rawPath!).map((path) => {
    const concrete = path.replace(/:[A-Za-z]+/g, 'x');
    const url = new URL(`http://gateway.invalid${concrete}`);
    for (const key of (rawQuery ?? '').split(/[&|]/).map((value) => value.split('=')[0]).filter(Boolean))
      url.searchParams.set(key!, 'x');
    return { method, path: concrete, url };
  }));
}

/** `/api/a/b|c/d` alternates the suffix after the last `/` before the first `|`. */
function expandAlternatives(path: string): string[] {
  const pipe = path.indexOf('|');
  if (pipe < 0) return [path];
  const cut = path.lastIndexOf('/', pipe) + 1;
  return path.slice(cut).split('|').map((alternative) => `${path.slice(0, cut)}${alternative}`);
}

const cap = (method: string, p: string) => routeCapability(method, p, new URL(`http://gateway.invalid${p}`));

describe('gateway route capability binding', () => {
  /**
   * `routeCapability` tested `p.startsWith('/api/queue')`, which does NOT match
   * `/api/agent-queue`. Both routes fell through to the conservative fallback
   * (`project:read` / `settings:write`), so `POST /api/agent-queue/move` demanded
   * `settings:write` at the gateway while the service layer asked for
   * `queue:write` — a maintainer (who holds `queue:*` but no `settings:*`) was
   * wrongly refused. The catalog test could not see it because the route was not
   * in PLATFORM_API_CATALOG either.
   */
  it('binds the host agent queue to the queue capabilities, not the settings fallback', () => {
    expect(cap('GET', '/api/agent-queue')).toBe('queue:read');
    expect(cap('POST', '/api/agent-queue/move')).toBe('queue:write');
    // The merge queue keeps its existing binding.
    expect(cap('GET', '/api/queue')).toBe('queue:read');
    expect(cap('POST', '/api/queue/prioritize')).toBe('queue:write');
  });

  /**
   * `Store.exportOrganization` dumps every project, the whole tasks table
   * (prompts and results included), memberships, teams, settings and executions.
   * `organization:read` is inside PROJECT_GRANT_CEILING *and* the developer
   * profile, so gating the export on it let a deliberately project-ceilinged
   * agent read every sibling project in the tenant.
   */
  it('gates the full-organization export above the project-grant ceiling', () => {
    expect(cap('GET', '/api/organizations/o1/export')).toBe('organization:edit');
    // The ordinary organization read is unchanged.
    expect(cap('GET', '/api/organizations/o1')).toBe('organization:read');
  });

  it('exposes plan entitlements as organization-scoped read data', () => {
    expect(cap('GET', '/api/organizations/o1/entitlements')).toBe('organization:read');
  });

  it('gates a password-manager export import as a credential write', () => {
    expect(cap('POST', '/api/vault/import/bitwarden')).toBe('credential:write');
    expect(cap('POST', '/api/vault/items/vi_1/reveal')).toBe('credential:write');
  });

  it('scopes the settings access summary to the page being viewed', () => {
    expect(routeCapability('GET', '/api/settings/access', new URL('http://x/api/settings/access?organizationId=o1')))
      .toBe('organization:read');
    expect(routeCapability('GET', '/api/settings/access', new URL('http://x/api/settings/access?projectId=p1')))
      .toBe('project:read');
  });

  it('binds installation surfaces to installation settings capabilities', () => {
    expect(cap('GET', '/api/settings/installation')).toBe('settings:read');
    expect(cap('GET', '/api/settings/paid-launch')).toBe('settings:read');
    expect(cap('PUT', '/api/settings/paid-launch')).toBe('settings:write');
    expect(cap('PUT', '/api/organizations/o1/payments/stripe/platform')).toBe('settings:write');
    expect(cap('POST', '/api/organizations/o1/github/app-manifest')).toBe('settings:write');
    expect(cap('PUT', '/api/organizations/o1/github/app')).toBe('settings:write');
    // Tenant-owned connections stay tenant capabilities.
    expect(cap('POST', '/api/organizations/o1/payments/connect')).toBe('payment:write');
    expect(cap('POST', '/api/organizations/o1/github/install-url')).toBe('repository:write');
  });

  it('separates hosted subscription billing from agent payment cards', () => {
    expect(cap('GET', '/api/organizations/o1/subscription/status')).toBe('organization:read');
    expect(cap('POST', '/api/organizations/o1/subscription/checkout')).toBe('payment:write');
    expect(cap('POST', '/api/organizations/o1/subscription/cancel')).toBe('payment:write');
    expect(cap('POST', '/api/subscriptions/webhook')).toBe('none');
    expect(cap('POST', '/api/payments/stripe/webhook')).toBe('none');
  });

  it('requires repository writes for both delegated creation and project attachment', () => {
    expect(cap('POST', '/api/organizations/o1/repositories/create')).toBe('repository:write');
    expect(cap('POST', '/api/projects/p1/repositories')).toBe('repository:write');
    expect(cap('GET', '/api/projects/p1/repositories')).toBe('repository:read');
    expect(cap('GET', '/api/projects/p1/checkout')).toBe('repository:read');
  });

  it('gates sidebar folder renames as project edits', () => {
    expect(cap('PATCH', '/api/projects/p1/folder')).toBe('project:edit');
  });

  it('protects native conversation downloads as conversation reads', () => {
    expect(cap('GET', '/api/tasks/t1/conversation.jsonl')).toBe('task:conversation:read');
  });

  it('treats a person’s Git identity as authenticated self-service, not an organization credential grant', () => {
    expect(cap('GET', '/api/user/export')).toBe('none');
    expect(cap('GET', '/api/user/default-organization')).toBe('none');
    expect(cap('PUT', '/api/user/default-organization')).toBe('none');
    expect(cap('GET', '/api/user/git-profiles')).toBe('none');
    expect(cap('POST', '/api/user/git-profiles')).toBe('none');
    expect(cap('DELETE', '/api/user/git-profiles/main')).toBe('none');
    expect(cap('GET', '/api/user/github-accounts')).toBe('none');
    expect(cap('PUT', '/api/user/github-accounts/42/identity')).toBe('none');
  });
});

describe('gateway route capability catalog', () => {
  it('binds every documented platform route to an explicit capability rule', () => {
    // The fallback in capabilityForRequest exists for safety, not coverage: a
    // documented route that only matches the fallback means the catalog and the
    // capability map have drifted apart.
    for (const entries of Object.values(PLATFORM_API_CATALOG)) {
      if (!Array.isArray(entries)) continue; // the `note` field
      for (const entry of entries) {
        for (const { method, path, url } of expandEntry(entry)) {
          expect(routeCapability(method, path, url), `${method} ${path} has no explicit capability rule`).toBeDefined();
        }
      }
    }
  });
});

/**
 * The reverse direction. The test above walks the catalog FORWARD (every documented
 * route must have a capability rule) — so a route added to the gateway and never
 * added to the catalog is invisible to it. `PLATFORM_API_CATALOG` is the only
 * discovery mechanism an agent has for the administrative API, so an omission makes
 * a real capability undiscoverable: nine routes had drifted out this way, including
 * `POST /api/organizations/:organizationId/projects`, which is the ONLY project
 * create that works on a hosted deployment.
 */
describe('platform catalog covers the gateway route table', () => {
  const documented = () => {
    const paths = new Set<string>();
    for (const entries of Object.values(PLATFORM_API_CATALOG)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const spec = entry.split(' ')[1];
        if (!spec) continue;
        for (const alt of expandAlternatives(spec.split('?')[0]!)) paths.add(normalize(alt));
      }
    }
    return paths;
  };
  /** Collapse params/ids so a catalog `:projectId` matches a server `([^/]+)`. */
  const normalize = (p: string) => p.replace(/:[A-Za-z]+/g, '*').replace(/\/+$/, '');

  /**
   * Routes answered BEFORE the session/capability gate, so they are deliberately
   * outside the agent-callable surface (see PLATFORM_REQUEST_EXCLUDED_PATHS):
   * auth handshakes, provider webhooks, and static/asset paths.
   */
  const PRE_GATE = [
    /^\/api\/(login|logout|signup|setup|session|sso|auth)/,
    /^\/api\/(launch|legal)/,
    // Provider webhooks/ingest: authenticated by signature or a minted secret,
    // answered before the session gate, and excluded from platform_request.
    /\/(webhooks?|ingest)$/,
    // OAuth/app-install redirect landings — the provider's browser redirect target,
    // authenticated by the flow's own state parameter, not a karmax token.
    /\/(oauth\/)?callback$/,
    // Host TLS bootstrap for port previews; not part of the tenant API.
    /^\/api\/tls\//,
  ];

  /**
   * Legacy un-namespaced spellings that `server.ts` rewrites onto the org-scoped
   * route (see the tenant-guard comment at the rewrite). The canonical form IS
   * documented; documenting the alias too would just invite agents to use it.
   */
  const LEGACY_ALIASES = new Set([
    '/api/credentials/policy', '/api/payments/providers', '/api/payments/connect',
    '/api/workflows', '/api/accounts', '/api/git-profiles', '/api/credentials',
  ]);

  it('documents every /api route the gateway serves', async () => {
    const fs = await import('node:fs');
    const url = new URL('../src/gateway/server.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    // Both spellings the router uses: `p === '/api/x'` and `p.match(/^\/api\/x\/...$/)`.
    const found = new Set<string>();
    for (const m of source.matchAll(/p === '(\/api\/[^']*)'/g)) found.add(normalize(m[1]!));
    for (const m of source.matchAll(/p\.match\(\/\^\\\/api\\\/([^/]*(?:\\\/[^/]*)*)\$\//g)) {
      const literal = `/api/${m[1]!}`
        .replace(/\\\//g, '/')
        .replace(/\(\[\^\/\]\+\)/g, '*')
        .replace(/\(\.\*\)/g, '*');
      if (!/[[\](){}|+?]/.test(literal)) found.add(normalize(literal));
    }
    const docs = documented();
    const missing = [...found]
      .filter((p) => !docs.has(p))
      .filter((p) => !PRE_GATE.some((re) => re.test(p)) && !LEGACY_ALIASES.has(p));
    expect(missing, `these gateway routes are not in PLATFORM_API_CATALOG, so no agent can discover them:\n${missing.join('\n')}`)
      .toEqual([]);
  });
});
