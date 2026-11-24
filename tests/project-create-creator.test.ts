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

// Who a new project's owner is. Its creator becomes its owner when they belong
// to its organization. Someone whose authority over the organization is a grant
// from above it (the installation's operator, `god` globally) cannot be a member
// of a project there, and needs no membership to reach it: creating a project
// for them must neither fail (tavya-error 1e83ec34a235c690: `tavya import
// --organization <another person's organization>` answered 500 "user is not a
// member of the project organization") nor leave half a project behind.

let nextPort = 50_400;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const USERS = ['member', 'operator'] as const;

async function setup() {
  const store = (await Store.create(':memory:', { hosted: true }));
  const tokens = new TokenAuthority();
  const authorization = (await AuthorizationService.create(store));
  const org = (await store.createOrganization({ name: 'Someone else', ownerUserId: 'member' }));
  const client = {} as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = (await Gateway.create({ store, tokens, authorization, api, client, worlds, hosted: true,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'project creator test' },
    paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: false }) },
    identity: {
      sessionActive: async (id: string, userId: string) => id === `${userId}-session`,
      connectOrganizationNames: () => {}, listUsers: () => [],
      session: async (headers: Headers) => {
        const user = USERS.find((candidate) => headers.get('cookie') === `test-session=${candidate}`);
        return user ? { user: { id: user, name: user, email: `${user}@example.com` }, session: { id: `${user}-session` } } : undefined;
      },
    },
  } as any));
  const server = await gateway.listen(nextPort += 10);
  cleanups.push(async () => { await server.close(); (await store.close()); });
  await authorization.grant('system:test', { principalId: 'user:member', scopeKey: `organization:${org.id}`, profileId: 'administrator' });
  // The installation's operator: authority everywhere, member of nothing here.
  await authorization.grant('system:test', { principalId: 'user:operator', scopeKey: 'global', profileId: 'god' });
  const request = (user: typeof USERS[number], method: string, path: string, body?: unknown) => fetch(`${server.url}${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: `test-session=${user}`, origin: server.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, org, request };
}

describe('the creator of a new project', () => {
  it('becomes its owner when they belong to its organization', async () => {
    const f = await setup();
    const response = await f.request('member', 'POST', `/api/organizations/${f.org.id}/projects`, { name: 'Site', config: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    const project = await response.json() as { id: string };
    expect((await f.store.listProjectMemberships(project.id)).map(({ principal, role }) => ({ principal, role })))
      .toEqual([{ principal: { kind: 'user', userId: 'member' }, role: 'owner' }]);
  });

  it('creates it for an operator outside the organization, who reaches it through their grant', async () => {
    const f = await setup();
    const response = await f.request('operator', 'POST', `/api/organizations/${f.org.id}/projects`, { name: 'Charts', config: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    const project = await response.json() as { id: string; organizationId: string };
    expect(project.organizationId).toBe(f.org.id);
    // Not a member: the organization keeps its rule that project members belong to it.
    expect(await f.store.listProjectMemberships(project.id)).toEqual([]);
    // Both the operator and the organization's own people can open it.
    for (const user of USERS) {
      const listed = await f.request(user, 'GET', `/api/organizations/${f.org.id}/projects`);
      expect((await listed.json() as Array<{ id: string }>).map(({ id }) => id), user).toContain(project.id);
    }
    // And creating it again by name finds it, as `tavya import` does on a re-run.
    const again = await f.request('operator', 'POST', `/api/organizations/${f.org.id}/projects`, { name: 'Charts', config: {} });
    expect(again.status).toBe(400);
  });

  it('refuses to make someone outside the organization a project member with a 400, not a 500', async () => {
    const f = await setup();
    const project = await f.store.createProject('Site', {}, f.org.id);
    const refused = await f.store.setProjectMembership(project.id, { kind: 'user', userId: 'operator' }, 'owner')
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { status?: number }).status).toBe(400);
  });
});

describe('creating a project with its creator in the store', () => {
  it('writes the project and its owner together', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    cleanups.push(async () => { (await store.close()); });
    const org = (await store.createOrganization({ name: 'Acme', ownerUserId: 'member' }));
    const owned = await store.createProject('Owned', {}, org.id, { creator: 'member' });
    expect((await store.listProjectMemberships(owned.id)).map(({ principal, role }) => ({ principal, role })))
      .toEqual([{ principal: { kind: 'user', userId: 'member' }, role: 'owner' }]);
    const unowned = await store.createProject('Unowned', {}, org.id, { creator: 'operator' });
    expect(await store.listProjectMemberships(unowned.id)).toEqual([]);
    // The other membership refusals are the caller's to resolve too, never a 500.
    const lastOwner = await store.removeProjectMembership(owned.id, { kind: 'user', userId: 'member' })
      .then(() => undefined, (error: unknown) => error);
    expect((lastOwner as { status?: number }).status).toBe(409);
  });
});
