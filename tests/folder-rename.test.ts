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
  const store = new Store(':memory:', { hosted: true });
  const tokens = new TokenAuthority();
  const authorization = new AuthorizationService(store);
  const org = store.createOrganization({ name: 'Workspace', ownerUserId: 'owner' });
  const foreignOrg = store.createOrganization({ name: 'Other', ownerUserId: 'other' });
  const first = store.createProject('Work/First', {}, org.id);
  const nested = store.createProject('Work/Nested/Second', {}, org.id);
  const foreign = store.createProject('Work/Foreign', {}, foreignOrg.id);
  const client = {} as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = new Gateway({ store, tokens, authorization, api, client, worlds,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'folder rename test' },
    paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: false }) },
    identity: {
      connectOrganizationNames: () => {}, listUsers: () => [],
      session: async (headers: Headers) => headers.get('cookie') === 'test-session=editor'
        ? { user: { id: 'editor', name: 'Editor', email: 'editor@example.com' }, session: { id: 'editor-session' } }
        : undefined,
    },
  } as any);
  const server = await gateway.listen(nextPort += 10);
  cleanups.push(async () => { await server.close(); store.close(); });
  const grant = (projectId: string, profileId = 'maintainer') => authorization.grant('system:test', {
    principalId: 'user:editor', scopeKey: `project:${projectId}`, profileId,
  });
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
    if (scope === 'projects') { f.grant(f.first.id); f.grant(f.nested.id); }
    else f.authorization.grant('system:test', { principalId: 'user:editor', scopeKey: `organization:${f.org.id}`, profileId: 'administrator' });
    const response = await f.rename();
    expect(response.status, await response.text()).toBe(200);
    expect(f.store.getProject(f.first.id)?.folder).toBe('Renamed');
    expect(f.store.getProject(f.nested.id)?.folder).toBe('Renamed/Nested');
    expect(f.store.getProject(f.foreign.id)?.folder).toBe('Work');
  });

  it.each(['viewer', undefined])('rejects a nested project with %s access without partial writes', async (profile) => {
    const f = await setup();
    f.grant(f.first.id);
    if (profile) f.grant(f.nested.id, profile);
    expect((await f.rename()).status).toBe(403);
    expect(f.store.getProject(f.first.id)?.folder).toBe('Work');
    expect(f.store.getProject(f.nested.id)?.folder).toBe('Work/Nested');
    f.grant(f.nested.id);
    expect((await f.rename()).status).toBe(200);
  });

  it('keeps delegated agents inside their token scope even with an authorized browser cookie', async () => {
    const f = await setup();
    f.grant(f.first.id); f.grant(f.nested.id);
    const human = f.tokens.mintPrincipal('user:editor', ['project:edit'], undefined, 60_000, f.org.id);
    const delegation = f.tokens.delegateHuman(human.token, { taskId: 'rename', organizationId: f.org.id })!;
    const mint = (projectIds: string[]) => f.tokens.mint({ taskId: 'rename', principal: 'user:editor',
      profileId: 'maintainer', organizationId: f.org.id, projectIds, delegationId: delegation.id,
      ceiling: ['project:edit'], grantorCaps: ['project:edit'] }).token;
    expect((await f.rename(mint([f.first.id]))).status).toBe(403);
    expect(f.store.getProject(f.first.id)?.folder).toBe('Work');
    expect(f.store.getProject(f.nested.id)?.folder).toBe('Work/Nested');
    expect((await f.rename(mint([f.first.id, f.nested.id]))).status).toBe(200);
  });
});
