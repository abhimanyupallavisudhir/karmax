import { describe, it, expect } from 'vitest';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { apiOps } from '../src/platform/mcp.js';

/**
 * The organization home is one task list over every project of the organization
 * the caller can read — the same per-project authorization as global search, for
 * people and agents alike — with `for:me` and `project:` like any project list.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  const authorization = await AuthorizationService.create(store);
  const tokens = new TokenAuthority(store);
  const api = new KarmaxApi({ store, tokens, authorization, client: {} as any, taskQueue: 'test' });
  const org = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const other = await store.createOrganization({ name: 'Other', ownerUserId: 'owner' });
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', org.id);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', other.id);
  const web = await store.createProject('Website Redesign', {}, org.id);
  const app = await store.createProject('App', {}, org.id);
  const secret = await store.createProject('Secret', {}, org.id);
  const elsewhere = await store.createProject('Elsewhere', {}, other.id);
  // Ana reads two of Acme's three projects.
  await store.setOrganizationMembership(org.id, 'ana', 'member');
  for (const project of [web, app])
    await authorization.grant('system:test', { principalId: 'user:ana', scopeKey: projectScope(project.id), profileId: 'viewer' });
  store.connectUserNames(() => [{ id: 'owner', name: 'Olu', email: 'olu@example.com' }, { id: 'ana', name: 'Ana Lima', email: 'ana@example.com' }]);
  const make = async (projectId: string, title: string, params: Record<string, unknown> = {}, createdBy = 'owner') =>
    store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1', params: { prompt: title, ...params },
      createdBy: { kind: 'user', userId: createdBy } });
  const t1 = await make(web.id, 'redesign header');
  const t2 = await make(app.id, 'review the app');
  const t3 = await make(secret.id, 'secret work');
  const t4 = await make(app.id, 'ana draft', { draft: true }, 'ana');
  const t5 = await make(elsewhere.id, 'other org');
  // The app task waits on Ana's review.
  await store.saveView(t2.id, { taskId: t2.id, title: t2.title, workflow: 'software-dev', stage: 'review', status: 'waiting',
    waitingFor: { kind: 'human' }, messages: [], actions: [], state: {}, updatedAt: Date.now() } as any, undefined, undefined, undefined, { lifecycleEvent: false });
  await store.appendEvent({ taskId: t2.id, type: 'task.mentioned', ts: Date.now(), payload: { principal: { kind: 'user', userId: 'ana' } } });
  const gateway = Object.create(Gateway.prototype) as any;
  gateway.deps = { store, tokens, authorization, api, identity: { providersForUserAsync: async () => [] } };
  const call = async (session: any, orgId: string, query = '') => {
    let status = 0, body = '';
    const res = { destroyed: false, writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
    await gateway.searchOrganization(res, session, orgId, new URL(`http://gateway.invalid/api/organizations/${orgId}/search?${query}`));
    return { status, body: JSON.parse(body) };
  };
  const everywhere = async (session: any, query = '') => {
    let status = 0, body = '';
    const res = { destroyed: false, writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } };
    await gateway.searchEverywhere(res, session, new URL(`http://gateway.invalid/api/search?${query}`));
    return { status, body: JSON.parse(body) };
  };
  const ana = { user: 'Ana', userId: 'ana', email: 'ana@example.com', apiToken: 'session' };
  return { store, tokens, authorization, api, org, other, web, app, secret, elsewhere, t1, t2, t3, t4, t5, call, everywhere, ana };
}

const titles = (body: any) => body.tasks.map((task: any) => task.title).sort();

describe('organization task list', () => {
  it('is a read route authorized per project, for agents too', () => {
    expect(routeCapability('GET', '/api/organizations/org_x/search')).toBe('none');
  });

  it('lists every readable project of the organization, labelled with its project', async () => {
    const f = await fixture();
    try {
      const { status, body } = await f.call(f.ana, f.org.id, 'q=');
      expect(status).toBe(200);
      expect(titles(body)).toEqual(['ana draft', 'redesign header', 'review the app']);
      expect(body.tasks.every((task: any) => [f.web.id, f.app.id].includes(task.projectId))).toBe(true);
      expect(body.projects.map((project: any) => project.slug).sort()).toEqual(['app', 'website-redesign']);
    } finally { await f.store.close(); }
  });

  it('answers for:me from the inbox plus own drafts, and says why', async () => {
    const f = await fixture();
    try {
      const { body } = await f.call(f.ana, f.org.id, 'q=for:me');
      expect(titles(body)).toEqual(['ana draft', 'review the app']);
      expect(body.reasons[f.t2.id]).toEqual(['mentioned']);
      expect(body.reasons[f.t4.id]).toEqual(['draft']);
      // A person by name or email; an unknown name matches nobody.
      expect(titles((await f.call(f.ana, f.org.id, 'q=for:"ana lima"')).body)).toEqual(['ana draft', 'review the app']);
      expect(titles((await f.call(f.ana, f.org.id, 'q=for:ANA@example.com')).body)).toEqual(['ana draft', 'review the app']);
      expect(titles((await f.call(f.ana, f.org.id, 'q=for:nobody')).body)).toEqual([]);
      expect(titles((await f.call(f.ana, f.org.id, 'q=-for:me')).body)).toEqual(['redesign header']);
    } finally { await f.store.close(); }
  });

  it('filters by project id, slug or name and pages across projects', async () => {
    const f = await fixture();
    try {
      expect(titles((await f.call(f.ana, f.org.id, 'q=project:website-redesign')).body)).toEqual(['redesign header']);
      expect(titles((await f.call(f.ana, f.org.id, `q=project:${f.app.id}`)).body)).toEqual(['ana draft', 'review the app']);
      const first = (await f.call(f.ana, f.org.id, 'q=sort:title-asc&limit=2')).body;
      expect(first.tasks.map((task: any) => task.title)).toEqual(['ana draft', 'redesign header']);
      expect(first.total).toBe(3);
      const second = (await f.call(f.ana, f.org.id, 'q=sort:title-asc&limit=2&offset=2')).body;
      expect(second.tasks.map((task: any) => task.title)).toEqual(['review the app']);
    } finally { await f.store.close(); }
  });

  it('gives an agent token the same list through its own scope (and MCP search_tasks)', async () => {
    const f = await fixture();
    try {
      const { token } = await f.tokens.mintPrincipal('user:owner', ['project:read', 'task:read'], f.app.id, undefined, f.org.id);
      const agent = { user: 'agent', apiToken: token };
      expect(titles((await f.call(agent, f.org.id, 'q=')).body)).toEqual(['ana draft', 'review the app']);
      const ops = apiOps(f.api, () => token);
      const compact = await ops.searchOrganizationTasks(f.org.id, '');
      expect(compact.tasks.map((task) => task.projectId)).toEqual([f.app.id, f.app.id]);
      // A token of another organization reads nothing here.
      const { token: foreign } = await f.tokens.mintPrincipal('user:owner', ['project:read', 'task:read'], f.elsewhere.id, undefined, f.other.id);
      await expect(f.call({ user: 'agent', apiToken: foreign }, f.org.id, 'q=')).rejects.toThrow(/denied: task:read/);
    } finally { await f.store.close(); }
  });

  it('refuses an outsider and is not found for an unknown organization', async () => {
    const f = await fixture();
    try {
      expect((await f.call({ user: 'Sam', userId: 'sam', email: 'sam@example.com', apiToken: 'session' }, f.org.id, 'q=')).status).toBe(403);
      expect((await f.call(f.ana, 'org_missing', 'q=')).status).toBe(404);
    } finally { await f.store.close(); }
  });
});

/**
 * The bell's page: one list over every organization the person belongs to —
 * `for:me` across all of them by default — sorted together, each row naming its
 * organization and project.
 */
describe('search across every organization', () => {
  it('is a read route authorized per project', () => {
    expect(routeCapability('GET', '/api/search')).toBe('none');
  });

  it('answers for:me over every organization, rows carrying their organization', async () => {
    const f = await fixture();
    try {
      // Ana also belongs to Other, where a task waits on her.
      await f.store.setOrganizationMembership(f.other.id, 'ana', 'member');
      await f.authorization.grant('system:test', { principalId: 'user:ana', scopeKey: projectScope(f.elsewhere.id), profileId: 'viewer' });
      await f.store.appendEvent({ taskId: f.t5.id, type: 'task.mentioned', ts: Date.now(), payload: { principal: { kind: 'user', userId: 'ana' } } });
      const { status, body } = await f.everywhere(f.ana, 'q=for:me');
      expect(status).toBe(200);
      expect(titles(body)).toEqual(['ana draft', 'other org', 'review the app']);
      expect(body.reasons[f.t5.id]).toEqual(['mentioned']);
      expect(body.projects.find((project: any) => project.id === f.elsewhere.id)).toMatchObject({ slug: 'elsewhere', organizationId: f.other.id });
      expect(body.projects.find((project: any) => project.id === f.app.id)).toMatchObject({ organizationId: f.org.id });
      // Every query works, an empty one included; still nothing she cannot read.
      expect(titles((await f.everywhere(f.ana, 'q=')).body)).toEqual(['ana draft', 'other org', 'redesign header', 'review the app']);
      expect(titles((await f.everywhere(f.ana, 'q=sort:title-asc&limit=1')).body)).toEqual(['ana draft']);
    } finally { await f.store.close(); }
  });

  it('gives an agent token the projects of its own scope', async () => {
    const f = await fixture();
    try {
      const { token } = await f.tokens.mintPrincipal('user:owner', ['project:read', 'task:read'], f.app.id, undefined, f.org.id);
      expect(titles((await f.everywhere({ user: 'agent', apiToken: token }, 'q=')).body)).toEqual(['ana draft', 'review the app']);
    } finally { await f.store.close(); }
  });
});
