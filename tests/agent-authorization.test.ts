import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { summarizeCapabilities } from '../src/platform/authorization-summary.js';
import { TOOL_SCHEMAS } from '../src/agent/tools.js';

/**
 * Agents used to learn what they may do only by trying: nothing told them
 * their level, scope or capabilities, so they either attempted an operation
 * and hit a 403, or asked a person to do something they could have done
 * themselves. `GET /api/authorization/me` (and the `my_authorization` tool on
 * top of it) answers "what may I do here?" and "may I make this request?" from
 * the same capability binding and token check the gateway enforces.
 */
const caps = (id: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === id)!.capabilities;

describe('summarizeCapabilities', () => {
  it('folds whole namespaces the caller holds and lists what it lacks exactly', () => {
    const { held, missing } = summarizeCapabilities(caps('maintainer'));
    expect(held).toContain('task:*');
    expect(held).toContain('project:settings:write');
    expect(held).not.toContain('task:read');
    // Missing capabilities are requestable, so they are never wildcards.
    expect(missing).toContain('organization:edit');
    expect(missing).toContain('credential:write');
    expect(missing.some((cap) => cap.includes('*'))).toBe(false);
    expect(missing).not.toContain('project:settings:write');
  });

  it('does not let credential:* stand for vault read access', () => {
    const { held, missing } = summarizeCapabilities(['credential:*']);
    expect(held).toContain('credential:*');
    expect(missing).toContain('credential:reveal');
  });

  it('keeps grants outside the catalogue once, without repeating expanded wildcards', () => {
    const { held } = summarizeCapabilities(['task:read', 'use-card:card_1', 'merge-into:/repo:main', 'use-credential:*', 'project:settings:*']);
    expect(held).toEqual(['task:read', 'project:settings:read', 'project:settings:write', 'use-card:card_1', 'merge-into:/repo:main', 'use-credential:*']);
    expect(summarizeCapabilities(['use-card:*', 'use-card:card_1']).held).toEqual(['use-card:*']);
  });

  it('summarizes God as everything', () => {
    expect(summarizeCapabilities(['*'])).toEqual({ held: ['*'], missing: [] });
  });
});

describe('GET /api/authorization/me', () => {
  let home: string;
  let store: Store;
  let tokens: TokenAuthority;
  let close: () => Promise<void>;
  let base: string;
  let site: string;
  let docs: string;
  let theirs: string;
  let acmeId: string;
  let maintainerToken: string;
  let developerToken: string;
  let humanToken: string;
  let calledAgentToken: string;

  const get = async (token: string, query = '') => {
    const res = await fetch(`${base}/api/authorization/me${query}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() as any };
  };
  const check = (token: string, method: string, target: string) =>
    get(token, `?method=${method}&path=${encodeURIComponent(target)}`);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-authz-me-'));
    store = (await Store.create(':memory:', { hosted: true }));
    tokens = new TokenAuthority();
    const acme = (await store.createOrganization({ name: 'Acme', ownerUserId: 'a' }));
    const other = (await store.createOrganization({ name: 'Other', ownerUserId: 'b' }));
    acmeId = acme.id;
    site = (await store.createProject('Site', {}, acme.id)).id;
    docs = (await store.createProject('Docs', {}, acme.id)).id;
    theirs = (await store.createProject('Theirs', {}, other.id)).id;
    const client = { workflow: { getHandle: () => ({ signal: async () => {}, query: async () => undefined }) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, contentDir: home, worlds: new WorldRegistry() });
    const running = await (await Gateway.create({
      api, store, tokens, client,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      authorization: (await AuthorizationService.create(store)),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'authorization test' },
      worlds: new WorldRegistry(),
    } as any)).listen(await findFreePortFrom(48_700));
    base = running.url;
    close = running.close;

    // The token shape a workflow mints for a task agent authorized at a level
    // across the selected projects of one organization (src/activities/core.ts).
    const agent = async (level: string) => {
      const task = await store.createTask({ projectId: site, title: level, workflow: 'just-do', workflowVersion: '1.0.0',
        params: { prompt: 'x', _authorization: { level, scope: 'projects', projectIds: [site], organizationId: acme.id, capabilities: caps(level) } } as any });
      return (await tokens.mint({ taskId: task.id, profileId: 'claude', role: 'do', principal: 'user:a', projectIds: [site],
        organizationId: acme.id, ceiling: ['*'], grantorCaps: [...caps(level), 'task:escalate'] })).token;
    };
    // An agent called in with `@` may hold its own, narrower authority.
    const shared = await store.createTask({ projectId: site, title: 'shared', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'x',
        _authorization: { level: 'maintainer', scope: 'projects', projectIds: [site], organizationId: acme.id, capabilities: caps('maintainer') },
        _agentAuthorization: { 'agent-1': { level: 'developer', scope: 'projects', projectIds: [site], organizationId: acme.id, capabilities: caps('developer') } },
      } as any });
    calledAgentToken = (await tokens.mint({ taskId: shared.id, profileId: 'claude', role: 'do', participant: 'agent-1', principal: 'user:a',
      projectIds: [site], organizationId: acme.id, ceiling: ['*'], grantorCaps: [...caps('developer'), 'task:escalate'] })).token;
    maintainerToken = await agent('maintainer');
    developerToken = await agent('developer');
    humanToken = (await tokens.mintPrincipal('user:a', caps('maintainer'), site, 60_000, acme.id)).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses anonymous callers', async () => {
    expect((await fetch(`${base}/api/authorization/me`)).status).toBe(401);
  });

  it('tells an agent its level, scope, and capabilities', async () => {
    const { status, body } = await get(maintainerToken);
    expect(status).toBe(200);
    expect(body.actor).toBe('agent');
    expect(body.level).toMatchObject({ id: 'maintainer', name: 'Project maintainer' });
    expect(body.scope).toEqual({ kind: 'projects', organization: { id: acmeId, name: 'Acme' }, projects: [{ id: site, name: 'Site' }] });
    expect(body.capabilities).toContain('project:settings:write');
    expect(body.missing).toContain('organization:edit');
    expect(body.missing).not.toContain('project:settings:write');
  });

  it('reports an @-called agent\'s own level, not the task\'s', async () => {
    const { body } = await get(calledAgentToken);
    expect(body.level).toMatchObject({ id: 'developer' });
    expect(body.missing).toContain('project:settings:write');
  });

  it('answers whether a request would be allowed, without making it', async () => {
    const settings = `/api/settings/project/${site}/software-dev`;
    const allowed = await check(maintainerToken, 'PUT', settings);
    expect(allowed.body.check).toMatchObject({ method: 'PUT', path: settings, capability: 'project:settings:write', allowed: true });
    expect(allowed.body.check.request).toBeUndefined();

    const refused = await check(developerToken, 'PUT', settings);
    expect(refused.body.check).toMatchObject({ capability: 'project:settings:write', allowed: false,
      request: { capabilities: ['project:settings:write'] } });
    expect(refused.body.check.reason).toMatch(/Project maintainer and above/);
  });

  it('names the project to request when only the scope is missing', async () => {
    const refused = await check(maintainerToken, 'GET', `/api/projects/${docs}`);
    expect(refused.body.check).toMatchObject({ capability: 'project:read', allowed: false, request: { capabilities: [], projectIds: [docs] } });
    // Another organization's project cannot be requested at all.
    const foreign = await check(maintainerToken, 'GET', `/api/projects/${theirs}`);
    expect(foreign.body.check.allowed).toBe(false);
    expect(foreign.body.check.request).toBeUndefined();
  });

  it('treats routes that need no capability as allowed', async () => {
    const { body } = await check(developerToken, 'GET', '/api/search?q=ab');
    expect(body.check).toMatchObject({ allowed: true, capability: null });
    // Routes platform_request cannot reach are refused with the reason.
    const unreachable = await check(developerToken, 'GET', '/api/meta');
    expect(unreachable.body.check).toMatchObject({ allowed: false, reason: expect.stringMatching(/excluded from platform_request/) });
  });

  it('rejects a malformed check', async () => {
    expect((await check(maintainerToken, 'GET', 'https://example.com/')).status).toBe(400);
    expect((await check(maintainerToken, 'BREW', '/api/meta')).status).toBe(400);
  });

  it('answers people the same way', async () => {
    const { status, body } = await get(humanToken, `?projectId=${site}`);
    expect(status).toBe(200);
    expect(body.actor).toBe('human');
    expect(body.capabilities).toContain('project:settings:write');
    expect((await check(humanToken, 'PUT', `/api/settings/project/${site}/software-dev`)).body.check.allowed).toBe(true);
  });

  it('points a refused agent at request_permission', async () => {
    const res = await fetch(`${base}/api/settings/project/${site}/software-dev`, {
      method: 'PUT', headers: { authorization: `Bearer ${developerToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toMatch(/request_permission.*project:settings:write/);
  });
});

describe('my_authorization tool', () => {
  it('is offered to every agent next to request_permission', () => {
    const tool = TOOL_SCHEMAS.find((schema) => schema.name === 'my_authorization');
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.parameters as any).properties)).toEqual(['method', 'path']);
  });
});
