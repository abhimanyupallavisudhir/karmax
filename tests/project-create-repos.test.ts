import { afterEach, describe, expect, it } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';

// The New project form sends the repositories it picked with the project, so
// a project is born with them attached (and its first task sees them), and a
// hosted project still only takes repositories the organization's GitHub reaches.

let nextPort = 49_900;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const store = (await Store.create(':memory:', { hosted: true }));
  const tokens = new TokenAuthority();
  const authorization = (await AuthorizationService.create(store));
  const org = (await store.createOrganization({ name: 'Workspace', ownerUserId: 'editor' }));
  const repository = await store.upsertRepository({ organizationId: org.id, provider: 'github', providerId: '1', owner: 'acme',
    name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main', private: true });
  const client = {} as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = (await Gateway.create({ store, tokens, authorization, api, client, worlds, hosted: true,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'project create test' },
    paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: false }) },
    identity: {
      sessionActive: async (id: string, userId: string) => id === 'editor-session' && userId === 'editor',
      connectOrganizationNames: () => {}, listUsers: () => [],
      session: async (headers: Headers) => headers.get('cookie') === 'test-session=editor'
        ? { user: { id: 'editor', name: 'Editor', email: 'editor@example.com' }, session: { id: 'editor-session' } }
        : undefined,
    },
  } as any));
  const server = await gateway.listen(nextPort += 10);
  cleanups.push(async () => { await server.close(); (await store.close()); });
  await authorization.grant('system:test', { principalId: 'user:editor', scopeKey: `organization:${org.id}`, profileId: 'administrator' });
  const create = (body: unknown) => fetch(`${server.url}/api/organizations/${org.id}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'test-session=editor', origin: server.url },
    body: JSON.stringify(body),
  });
  return { store, org, repository, create };
}

describe('creating a project with its repositories', () => {
  it('attaches the repositories it was created with, like adding them in settings', async () => {
    const f = await setup();
    const response = await f.create({ name: 'Clients/Site', config: {}, repos: ['git@github.com:acme/site.git'] });
    expect(response.status, await response.clone().text()).toBe(200);
    const project = await response.json();
    expect(project.config.repos).toEqual(['git@github.com:acme/site.git']);
    expect((await f.store.listProjectRepositories(project.id)).map(({ repository }) => repository.id)).toEqual([f.repository.id]);
  });

  it('refuses a repository the organization cannot reach, creating nothing', async () => {
    const f = await setup();
    const response = await f.create({ name: 'Elsewhere', config: {}, repos: ['git@github.com:someone/else.git'] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/organization GitHub connection/);
    expect((await f.store.listProjects()).filter((project) => project.organizationId === f.org.id)).toEqual([]);
  });
});
