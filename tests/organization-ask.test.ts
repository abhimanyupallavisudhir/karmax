import './helpers/isolated-home.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { WorldRegistry } from '../src/world/registry.js';
import { AUTONOMY_KEY, ORGANIZATION_COORDINATOR_PROJECT } from '../src/domain/autonomous-projects.js';

/**
 * Every organization's co-ordinator project (wiki features/computerless-tasks,
 * "Ask"): made with the organization, never deleted, renamed or moved, its name
 * reserved; and Ask, which puts a question there instead of asking which project.
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
  // An organization from before co-ordinator projects: it has none yet.
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
  const coordinators = async (organizationId = organization.id) =>
    (await store.listOrganizationProjects(organizationId)).filter((project) => project.coordinator);
  return { store, organization, site, call, ask, coordinators };
}

describe('the organization’s co-ordinator project', () => {
  it('comes with every new organization, autonomous or not', async () => {
    const f = await fixture();
    const plain = await f.call('ana', 'POST', '/api/organizations', { name: 'Side' });
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    expect((await f.store.listOrganizationProjects(plain.json.id)).map(({ name, coordinator }) => ({ name, coordinator })))
      .toEqual([{ name: ORGANIZATION_COORDINATOR_PROJECT, coordinator: true }]);

    const autonomous = await f.call('ana', 'POST', '/api/organizations', { name: 'Holdings', autonomous: true });
    expect(autonomous.status, JSON.stringify(autonomous.json)).toBe(200);
    expect(autonomous.json.project).toMatchObject({ name: ORGANIZATION_COORDINATOR_PROJECT, coordinator: true });
    expect((await f.store.getTask(autonomous.json.autonomy.coordinatorTaskId))!.projectId).toBe(autonomous.json.project.id);
    expect(await f.coordinators(autonomous.json.id)).toHaveLength(1);
  });

  it('is one per organization, however many ask for it at once', async () => {
    const f = await fixture();
    const made = await Promise.all([1, 2, 3, 4].map(() => f.store.ensureOrganizationCoordinatorProject(f.organization.id)));
    expect(new Set(made.map(({ project }) => project.id)).size).toBe(1);
    expect(made.filter(({ created }) => created)).toHaveLength(1);
    expect(await f.coordinators()).toHaveLength(1);
  });

  it('cannot be deleted, renamed or moved to another organization', async () => {
    const f = await fixture();
    const { project } = await f.store.ensureOrganizationCoordinatorProject(f.organization.id);
    const deleted = await f.call('ana', 'DELETE', `/api/projects/${project.id}`, { confirmName: project.name });
    expect(deleted.status).toBe(400);
    expect(deleted.json.error).toMatch(/cannot be deleted/);
    await expect(f.store.deleteProject(project.id)).rejects.toThrow(/cannot be deleted/);
    await expect(f.store.renameProject(project.id, 'HQ')).rejects.toThrow(/keeps its name/);
    // A folder is only where it shows in the sidebar.
    expect((await f.store.renameProject(project.id, `Admin/${ORGANIZATION_COORDINATOR_PROJECT}`)).folder).toBe('Admin');
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'ana' });
    const transfers = new ProjectTransfers(f.store, { principal: 'user:ana', authorize: () => undefined, workflowClosed: async () => true });
    await expect(transfers.preview(project.id, other.id)).rejects.toThrow(/cannot be moved/);
    expect((await f.store.getProject(project.id))).toMatchObject({ organizationId: f.organization.id, coordinator: true });
    // Deleting the organization still deletes it.
    const theirs = (await f.store.ensureOrganizationCoordinatorProject(other.id)).project;
    await f.store.deleteOrganization(other.id);
    expect(await f.store.getProject(theirs.id)).toBeUndefined();
  });

  it('its name is reserved: no other project may take it, with or without the hyphen', async () => {
    const f = await fixture();
    for (const name of [ORGANIZATION_COORDINATOR_PROJECT, 'coordinator', 'Work/Co ordinator']) {
      await expect(f.store.createProject(name, {}, f.organization.id)).rejects.toThrow(/reserved/);
      await expect(f.store.renameProject(f.site.id, name)).rejects.toThrow(/reserved/);
    }
    const refused = await f.call('ana', 'POST', `/api/organizations/${f.organization.id}/projects`, { name: 'Coordinator', config: {} });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/reserved/);
    expect((await f.store.createProject('Co-ordination', {}, f.organization.id)).name).toBe('Co-ordination');
  });

  it('an organization from before takes the project its autonomy runs from, or one already called Co-ordinator, rather than a second', async () => {
    const f = await fixture();
    // As an autonomous organization's project was made before it was marked.
    const runs = await f.store.createProject('Head office', {}, f.organization.id);
    await f.store.kvSet(AUTONOMY_KEY(runs.id), JSON.stringify({ scope: 'organization', avatarTaskId: 'a', coordinatorTaskId: 'c', wikiPage: { scope: 'organization', path: 'autonomy' }, at: 1 }));
    expect(await f.store.ensureOrganizationCoordinatorProject(f.organization.id)).toEqual({ project: { ...runs, coordinator: true }, created: false });

    const other = await f.store.createOrganization({ name: 'Older', ownerUserId: 'ana' });
    // Written as it was before the name was reserved.
    await f.store.createProject(ORGANIZATION_COORDINATOR_PROJECT, {}, other.id, { coordinator: true });
    await (f.store as any).db.prepare('UPDATE projects SET coordinator=0 WHERE organizationId=?').run(other.id);
    const adopted = await f.store.ensureOrganizationCoordinatorProject(other.id);
    expect(adopted).toMatchObject({ project: { name: ORGANIZATION_COORDINATOR_PROJECT, coordinator: true }, created: false });
    expect(await f.store.listOrganizationProjects(other.id)).toHaveLength(1);
  });
});

describe('Ask', () => {
  it('puts every question, anyone’s, in the co-ordinator project — one an older organization gets then', async () => {
    const f = await fixture();
    expect(await f.coordinators()).toEqual([]);
    const first = await f.ask('ana', 'What waits on me?');
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.project).toMatchObject({ name: ORGANIZATION_COORDINATOR_PROJECT, organizationId: f.organization.id, coordinator: true });
    expect(first.json.projectId).toBe(first.json.project.id);
    const task = (await f.store.getTask(first.json.id))!;
    expect(task.params).toMatchObject({ prompt: 'What waits on me?', computer: { provider: 'none' }, draft: false });
    // With the asker's own authority, minus what a task without a computer holds back.
    expect(task.params._authorization).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect((task.params._authorization as { heldBack?: string[] }).heldBack).toContain('organization:delete');

    // Bo acts across the organization without being able to make projects: he asks there too.
    const second = await f.ask('bo', 'Summarise this week');
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.projectId).toBe(first.json.project.id);
    expect((await f.store.getTask(second.json.id))!.params._authorization).toMatchObject({ level: 'developer', scope: 'organization' });
    const listed = await f.call('bo', 'GET', `/api/organizations/${f.organization.id}/projects`);
    expect(listed.json.map((project: { id: string }) => project.id)).toContain(first.json.project.id);
    expect(await f.coordinators()).toHaveLength(1);
  });

  it('someone whose authority covers only some projects cannot ask the organization (the console asks in their project)', async () => {
    const f = await fixture();
    expect((await f.ask('cy', 'Hello')).status).toBe(403);
    expect(await f.coordinators()).toEqual([]);
  });

  it('an empty question, or an organization that does not exist, is refused', async () => {
    const f = await fixture();
    expect((await f.ask('ana', '   ')).status).toBe(400);
    expect((await f.call('ana', 'POST', `/api/organizations/${f.organization.id}/ask`, {})).status).toBe(400);
    expect((await f.ask('ana', 'Hi', 'org_nope')).status).toBe(404);
  });
});
