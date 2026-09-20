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

let nextPort = 49_700;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const store = (await Store.create(':memory:', { hosted: true }));
  const tokens = new TokenAuthority();
  const authorization = (await AuthorizationService.create(store));
  const org = (await store.createOrganization({ name: 'Workspace', ownerUserId: 'owner' }));
  const foreignOrg = (await store.createOrganization({ name: 'Other', ownerUserId: 'other' }));
  const first = (await store.createProject('Work/First', {}, org.id));
  const nested = (await store.createProject('Work/Nested/Second', {}, org.id));
  const foreign = (await store.createProject('Work/Foreign', {}, foreignOrg.id));
  const client = {} as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = (await Gateway.create({ store, tokens, authorization, api, client, worlds,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'folder rename test' },
    paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: false }) },
    identity: {
      connectOrganizationNames: () => {}, listUsers: () => [],
      session: async (headers: Headers) => headers.get('cookie') === 'test-session=editor'
        ? { user: { id: 'editor', name: 'Editor', email: 'editor@example.com' }, session: { id: 'editor-session' } }
        : undefined,
    },
  } as any));
  const server = await gateway.listen(nextPort += 10);
  cleanups.push(async () => { await server.close(); (await store.close()); });
  const grant = async (projectId: string, profileId = 'maintainer') => (await authorization.grant('system:test', {
    principalId: 'user:editor', scopeKey: `project:${projectId}`, profileId,
  }));
  const rename = (bearer?: string) => fetch(`${server.url}/api/projects/${first.id}/folder`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: 'test-session=editor',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ folder: 'Work', name: 'Renamed' }),
  });
  return { store, tokens, authorization, org, first, nested, foreign, grant, rename };
}

describe('folder rename authorization over HTTP', () => {
  it.each(['projects', 'organization'] as const)('renames the whole subtree with %s browser grants', async (scope) => {
    const f = await setup();
    if (scope === 'projects') { (await f.grant(f.first.id)); (await f.grant(f.nested.id)); }
    else (await f.authorization.grant('system:test', { principalId: 'user:editor', scopeKey: `organization:${f.org.id}`, profileId: 'administrator' }));
    const response = await f.rename();
    expect(response.status, await response.text()).toBe(200);
    expect((await f.store.getProject(f.first.id))?.folder).toBe('Renamed');
    expect((await f.store.getProject(f.nested.id))?.folder).toBe('Renamed/Nested');
    expect((await f.store.getProject(f.foreign.id))?.folder).toBe('Work');
  });

  it.each(['viewer', undefined])('rejects a nested project with %s access without partial writes', async (profile) => {
    const f = await setup();
    (await f.grant(f.first.id));
    if (profile) (await f.grant(f.nested.id, profile));
    expect((await f.rename()).status).toBe(403);
    expect((await f.store.getProject(f.first.id))?.folder).toBe('Work');
    expect((await f.store.getProject(f.nested.id))?.folder).toBe('Work/Nested');
    (await f.grant(f.nested.id));
    expect((await f.rename()).status).toBe(200);
  });

  it('keeps delegated agents inside their token scope even with an authorized browser cookie', async () => {
    const f = await setup();
    (await f.grant(f.first.id)); (await f.grant(f.nested.id));
    const human = (await f.tokens.mintPrincipal('user:editor', ['project:edit'], undefined, 60_000, f.org.id));
    const delegation = (await f.tokens.delegateHuman(human.token, { taskId: 'rename', organizationId: f.org.id }))!;
    const mint = async (projectIds: string[]) => (await f.tokens.mint({ taskId: 'rename', principal: 'user:editor',
      profileId: 'maintainer', organizationId: f.org.id, projectIds, delegationId: delegation.id,
      ceiling: ['project:edit'], grantorCaps: ['project:edit'] })).token;
    expect((await f.rename((await mint([f.first.id])))).status).toBe(403);
    expect((await f.store.getProject(f.first.id))?.folder).toBe('Work');
    expect((await f.store.getProject(f.nested.id))?.folder).toBe('Work/Nested');
    expect((await f.rename((await mint([f.first.id, f.nested.id])))).status).toBe(200);
  });
});
