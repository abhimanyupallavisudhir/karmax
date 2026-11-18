import './helpers/isolated-home.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { WorldRegistry } from '../src/world/registry.js';
import { AUTONOMY_KEY, ORGANIZATION_COORDINATOR_PROJECT } from '../src/domain/autonomous-projects.js';
import { ORGANIZATION_COORDINATOR_KEY } from '../src/platform/organization-coordinator.js';

/**
 * Ask (wiki features/computerless-tasks): a question for the organization goes
 * to its co-ordinator project — made the first time anyone asks, the one an
 * autonomous organization already runs from — never to a project someone picks.
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
  const site = await store.createProject('Site', {}, organization.id);
  // Bo develops across the whole organization (no project:create); Cy only on Site.
  await store.setOrganizationMembership(organization.id, 'bo', 'member');
  await authorization.grant('system:test', { principalId: 'user:bo', scopeKey: organizationScope(organization.id), profileId: 'developer' });
  await store.setOrganizationMembership(organization.id, 'cy', 'member');
  await authorization.grant('system:test', { principalId: 'user:cy', scopeKey: projectScope(site.id), profileId: 'developer' });
  // Each signed in, holding what their grants give them in this organization (as
  // the gateway mints a person's token for an organization's routes).
  for (const user of ['ana', 'bo', 'cy']) {
    const caps = await authorization.capabilitiesAsync(`user:${user}`, undefined, organization.id);
    const { token: apiToken } = await tokens.mintPrincipal(`user:${user}`, user === 'ana' ? ['*'] : caps, undefined, 60 * 60 * 1000,
      user === 'ana' ? undefined : organization.id);
    (h.gateway as any).sessions.set(`session-${user}`, { user, userId: user, apiToken });
  }
  const call = async (user: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${h.base}${path}`, { method,
      headers: { authorization: `Bearer session-${user}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() as any };
  };
  const ask = (user: string, prompt: string, organizationId = organization.id) =>
    call(user, 'POST', `/api/organizations/${organizationId}/ask`, { prompt });
  return { store, organization, site, call, ask };
}

describe('Ask: the organization’s co-ordinator project', () => {
  it('the first question makes the co-ordinator project; every later one, anyone’s, lands in it', async () => {
    const f = await fixture();
    const first = await f.ask('ana', 'What waits on me?');
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.project).toMatchObject({ name: ORGANIZATION_COORDINATOR_PROJECT, organizationId: f.organization.id });
    expect(first.json.projectId).toBe(first.json.project.id);
    const task = (await f.store.getTask(first.json.id))!;
    expect(task.params).toMatchObject({ prompt: 'What waits on me?', computer: { provider: 'none' }, draft: false });
    // With the asker's own authority, minus what a task without a computer holds back.
    expect(task.params._authorization).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect((task.params._authorization as { heldBack?: string[] }).heldBack).toContain('organization:delete');
    expect(await f.store.kvGet(ORGANIZATION_COORDINATOR_KEY(f.organization.id))).toBe(first.json.project.id);

    // Bo acts across the organization without being able to make projects: he asks there too.
    const second = await f.ask('bo', 'Summarise this week');
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.projectId).toBe(first.json.project.id);
    expect((await f.store.getTask(second.json.id))!.params._authorization).toMatchObject({ level: 'developer', scope: 'organization' });
    // It is an ordinary project of the organization, which every member who acts for it reads.
    const listed = await f.call('bo', 'GET', `/api/organizations/${f.organization.id}/projects`);
    expect(listed.json.map((project: { id: string }) => project.id)).toContain(first.json.project.id);
    expect((await f.store.listOrganizationProjects(f.organization.id)).map((project) => project.name).sort())
      .toEqual([ORGANIZATION_COORDINATOR_PROJECT, 'Site']);
  });

  it('questions asked at once make one project', async () => {
    const f = await fixture();
    const answers = await Promise.all(['a', 'b', 'c', 'd'].map((prompt) => f.ask('ana', prompt)));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(answers.map((answer) => answer.json.projectId)).size).toBe(1);
    expect((await f.store.listOrganizationProjects(f.organization.id)).length).toBe(2);
  });

  it('someone whose authority covers only some projects cannot ask the organization (the console asks in their project)', async () => {
    const f = await fixture();
    const refused = await f.ask('cy', 'Hello');
    expect(refused.status).toBe(403);
    expect(await f.store.listOrganizationProjects(f.organization.id)).toHaveLength(1);
  });

  it('an empty question, or an organization that does not exist, is refused', async () => {
    const f = await fixture();
    expect((await f.ask('ana', '   ')).status).toBe(400);
    expect((await f.call('ana', 'POST', `/api/organizations/${f.organization.id}/ask`, {})).status).toBe(400);
    expect(await f.store.listOrganizationProjects(f.organization.id)).toHaveLength(1);
  });

  it('a project already called Co-ordinator is left alone', async () => {
    const f = await fixture();
    const theirs = await f.store.createProject(ORGANIZATION_COORDINATOR_PROJECT, {}, f.organization.id);
    const asked = await f.ask('ana', 'Hi');
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json.projectId).not.toBe(theirs.id);
    expect(asked.json.project.name).toBe(`${ORGANIZATION_COORDINATOR_PROJECT} 2`);
  });

  it('a co-ordinator project that was deleted is made again', async () => {
    const f = await fixture();
    const first = await f.ask('ana', 'one');
    await f.store.deleteProject(first.json.projectId);
    const again = await f.ask('ana', 'two');
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.projectId).not.toBe(first.json.projectId);
    expect(again.json.project.name).toBe(ORGANIZATION_COORDINATOR_PROJECT);
  });

  it('an autonomous organization asks in the project its co-ordinator runs from — also one made before the record', async () => {
    const f = await fixture();
    const created = await f.call('ana', 'POST', '/api/organizations', { name: 'Holdings', autonomous: true });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const asked = await f.ask('ana', 'How is it going?', created.json.id);
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json.projectId).toBe(created.json.project.id);

    // Made autonomous before organizations recorded their co-ordinator project: adopted, not duplicated.
    await f.store.kvDelete(ORGANIZATION_COORDINATOR_KEY(created.json.id));
    expect(JSON.parse((await f.store.kvGet(AUTONOMY_KEY(created.json.project.id)))!).scope).toBe('organization');
    const later = await f.ask('ana', 'And now?', created.json.id);
    expect(later.json.projectId).toBe(created.json.project.id);
    expect(await f.store.kvGet(ORGANIZATION_COORDINATOR_KEY(created.json.id))).toBe(created.json.project.id);
    expect(await f.store.listOrganizationProjects(created.json.id)).toHaveLength(1);
  });
});
