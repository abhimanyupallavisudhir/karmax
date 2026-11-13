import './helpers/isolated-home.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, organizationScope } from '../src/platform/authorization.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ORGANIZATION_COORDINATOR_PROJECT } from '../src/domain/autonomous-projects.js';

/**
 * Autonomous projects and organizations over HTTP (wiki features/autonomy): the
 * flag on New project and New organization, and the project's own route, which
 * the console and agents use alike.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function fixture() {
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => ({}), query: async () => [], signal: async () => undefined }),
    start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, worlds: new WorldRegistry() });
  const h = await stubGateway({ store, tokens, api, authorization, client });
  closers.push(h.close);
  const organization = await store.createOrganization({ name: 'Firm', ownerUserId: 'ana' });
  await authorization.grant('system:test', { principalId: 'user:ana', scopeKey: organizationScope(organization.id), profileId: 'superadmin' });
  // Ana, signed in: this fixture has no sign-in service, so her session is made directly.
  const { token: apiToken } = await tokens.mintPrincipal('user:ana', ['*'], undefined, 60 * 60 * 1000);
  const token = 'session-ana';
  (h.gateway as any).sessions.set(token, { user: 'Ana', userId: 'ana', apiToken });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${h.base}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() as any };
  };
  return { store, organization, call };
}

describe('autonomous projects over HTTP', () => {
  it('New project with autonomous: true answers with the co-ordinator to open; the project route reads and repeats it', async () => {
    const f = await fixture();
    const created = await f.call('POST', `/api/organizations/${f.organization.id}/projects`, { name: 'Shop', config: {}, autonomous: true });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.autonomyError).toBeUndefined();
    expect(created.json.autonomy).toMatchObject({ scope: 'project', wikiPage: { scope: 'project', path: 'autonomy' } });
    const coordinator = (await f.store.getTask(created.json.autonomy.coordinatorTaskId))!;
    expect(coordinator.params).toMatchObject({ draft: true, coordinator: { wakeHours: 24 } });

    const read = await f.call('GET', `/api/projects/${created.json.id}/autonomy`);
    expect(read).toEqual({ status: 200, json: { autonomy: created.json.autonomy } });
    const again = await f.call('POST', `/api/projects/${created.json.id}/autonomy`, {});
    expect(again.json.autonomy.coordinatorTaskId).toBe(coordinator.id);

    // An ordinary project has none until someone makes it autonomous.
    const plain = await f.call('POST', `/api/organizations/${f.organization.id}/projects`, { name: 'Blog', config: {} });
    expect(plain.json.autonomy).toBeUndefined();
    expect((await f.call('GET', `/api/projects/${plain.json.id}/autonomy`)).json).toEqual({ autonomy: null });
    expect((await f.call('POST', `/api/projects/${plain.json.id}/autonomy`, { scope: 'everything' })).status).toBe(400);
    expect((await f.call('POST', `/api/projects/${plain.json.id}/autonomy`, {})).json.autonomy.scope).toBe('project');
  });

  it('New organization with autonomous: true starts with a co-ordinator project holding the organization’s authority', async () => {
    const f = await fixture();
    const created = await f.call('POST', '/api/organizations', { name: 'Holdings', autonomous: true });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.project).toMatchObject({ name: ORGANIZATION_COORDINATOR_PROJECT, organizationId: created.json.id });
    expect(created.json.autonomyError).toBeUndefined();
    expect(created.json.autonomy).toMatchObject({ scope: 'organization', wikiPage: { scope: 'organization', path: 'autonomy' } });
    const avatar = (await f.store.getTask(created.json.autonomy.avatarTaskId))!;
    expect(avatar.params._authorization).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect((await f.store.getTask(created.json.autonomy.coordinatorTaskId))!.projectId).toBe(created.json.project.id);

    const plain = await f.call('POST', '/api/organizations', { name: 'Side' });
    expect(plain.json.autonomy).toBeUndefined();
    expect(await f.store.listOrganizationProjects(plain.json.id)).toEqual([]);
  });
});
