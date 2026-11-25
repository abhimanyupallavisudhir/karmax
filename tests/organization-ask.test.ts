import './helpers/isolated-home.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { WorldRegistry } from '../src/world/registry.js';
import { AUTONOMY_KEY } from '../src/domain/autonomous-projects.js';
import { CEO_KEY, CEO_PROJECT_NAME as ORGANIZATION_COORDINATOR_PROJECT, LEGACY_CEO_PROJECT_NAME, ceoTitle } from '../src/domain/coordinator.js';
import { ensureCeo, ensureEveryCeo, projectCeo } from '../src/platform/ceo.js';

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
  // What reached a workflow: started, and signalled.
  const started: string[] = [], signals: Array<{ taskId: string; name: string; payload: any }> = [];
  const client = { workflow: { getHandle: (taskId: string) => ({ executeUpdate: async () => ({}), query: async () => [],
    signal: async (name: string, payload: unknown) => { signals.push({ taskId, name, payload }); } }),
    start: async (_type: unknown, options: { workflowId: string }) => { started.push(options.workflowId); return {}; } } } as any;
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
  const deps = { api, store, tokens };
  return { store, organization, site, call, ask, coordinators, deps, started, signals };
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
    for (const name of [ORGANIZATION_COORDINATOR_PROJECT, 'ceo', LEGACY_CEO_PROJECT_NAME, 'coordinator', 'Work/Co ordinator']) {
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

describe('Ask, set to a quick task', () => {
  it('puts every question, anyone’s, in the co-ordinator project — one an older organization gets then', async () => {
    const f = await fixture();
    await f.call('ana', 'PUT', `/api/organizations/${f.organization.id}/ask-settings`, { target: 'task' });
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

describe('CEOs: a permanent co-ordinator in every project, and the organization’s in its CEO project', () => {
  const ceoOf = async (f: Awaited<ReturnType<typeof fixture>>, projectId: string) => (await projectCeo(f.store, projectId))!;

  it('every new organization and project has one: a draft named for what it is, with nothing else in it', async () => {
    const f = await fixture();
    const organization = await f.call('ana', 'POST', '/api/organizations', { name: 'Side' });
    expect(organization.status, JSON.stringify(organization.json)).toBe(200);
    const [ceoProject] = await f.coordinators(organization.json.id);
    expect(ceoProject!.name).toBe('CEO');
    const ceo = await ceoOf(f, ceoProject!.id);
    expect(ceo).toMatchObject({ title: 'CEO (Organization Co-ordinator)', workflow: 'software-dev', projectId: ceoProject!.id });
    expect(ceo.params).toMatchObject({ draft: true, prompt: '', coordinator: { wakeHours: 24 } });
    expect(ceo.createdBy).toEqual({ kind: 'user', userId: 'ana' });

    const shop = await f.call('ana', 'POST', `/api/organizations/${f.organization.id}/projects`, { name: 'Shop', config: {} });
    expect(shop.status, JSON.stringify(shop.json)).toBe(200);
    expect(await ceoOf(f, shop.json.id)).toMatchObject({ title: 'CEO (Project Co-ordinator)', params: { draft: true, prompt: '' } });
  });

  it('boot gives everything from before its CEO, once; a cancelled one is replaced', async () => {
    const f = await fixture();
    await ensureEveryCeo(f.deps);
    await ensureEveryCeo(f.deps);
    const [ceoProject] = await f.coordinators();
    for (const [project, title] of [[f.site.id, ceoTitle('project')], [ceoProject!.id, ceoTitle('organization')]] as const) {
      const tasks = (await f.store.listTasks(project)).filter((task) => task.params?.coordinator);
      expect(tasks.map((task) => task.title)).toEqual([title]);
      // For the organization's owner, who hears when it fails.
      expect(tasks[0]!.createdBy).toEqual({ kind: 'user', userId: 'ana' });
    }
    const first = await ceoOf(f, f.site.id);
    await f.store.saveView(first.id, { taskId: first.id, title: first.title, stage: 'cancelled', status: 'cancelled', messages: [], state: {}, actions: [], prs: [] } as never);
    const second = await ensureCeo(f.deps, f.site.id);
    expect(second.id).not.toBe(first.id);
    expect(second.params).toMatchObject({ draft: true, coordinator: { wakeHours: 24 } });
    // Made at once from two places, it is still one.
    const other = await f.store.createProject('Docs', {}, f.organization.id);
    const both = await Promise.all([ensureCeo(f.deps, other.id), ensureCeo(f.deps, other.id)]);
    expect(both[0].id).toBe(both[1].id);
  });

  it('For me lists every CEO first, as if each always waited; the sidebar’s numbers count only what came to wait', async () => {
    const f = await fixture();
    await ensureEveryCeo(f.deps);
    const q = encodeURIComponent('for:me -is:archived');
    const listed = await f.call('ana', 'GET', `/api/organizations/${f.organization.id}/search?q=${q}`);
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    const titles = listed.json.tasks.map((task: { title: string }) => task.title);
    expect(titles.slice(0, 2).sort()).toEqual([ceoTitle('organization'), ceoTitle('project')]);
    const counted = await f.call('ana', 'GET', `/api/organizations/${f.organization.id}/search?q=${q}&countBy=project`);
    expect(counted.json).toEqual({ total: 0, counts: {} });
  });

  it('a CEO project still called Co-ordinator is renamed, and an autonomy’s co-ordinator becomes its CEO', async () => {
    const f = await fixture();
    const legacy = await f.store.createProject(LEGACY_CEO_PROJECT_NAME, {}, f.organization.id, { coordinator: true });
    expect((await f.store.ensureOrganizationCoordinatorProject(f.organization.id)).project).toMatchObject({ id: legacy.id, name: 'CEO' });
    expect((await f.store.getProject(legacy.id))!.name).toBe('CEO');

    const coordinator = await f.store.createTask({ projectId: f.site.id, title: LEGACY_CEO_PROJECT_NAME, workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: '', draft: true, coordinator: { wakeHours: 24 } } });
    await f.store.kvSet(AUTONOMY_KEY(f.site.id), JSON.stringify({ scope: 'project', avatarTaskId: 'a', coordinatorTaskId: coordinator.id,
      wikiPage: { scope: 'project', path: 'autonomy' }, at: 1 }));
    const ceo = await ensureCeo(f.deps, f.site.id);
    expect(ceo).toMatchObject({ id: coordinator.id, title: 'CEO (Project Co-ordinator)' });
    expect(await f.store.kvGet(CEO_KEY(f.site.id))).toBe(coordinator.id);
  });
});

describe('Ask to the CEO', () => {
  const settings = (f: Awaited<ReturnType<typeof fixture>>, user: string, body?: unknown) =>
    f.call(user, body ? 'PUT' : 'GET', `/api/organizations/${f.organization.id}/ask-settings`, body);

  it('is the organization’s choice: its CEO unless someone who may edit the organization picks a quick task', async () => {
    const f = await fixture();
    expect(await settings(f, 'ana')).toEqual({ status: 200, json: { target: 'ceo', canManage: true } });
    expect((await settings(f, 'bo')).json).toEqual({ target: 'ceo', canManage: false });
    expect((await settings(f, 'bo', { target: 'task' })).status).toBe(403);
    expect((await settings(f, 'ana', { target: 'boss' })).status).toBe(400);
    expect(await settings(f, 'ana', { target: 'task' })).toEqual({ status: 200, json: { target: 'task', canManage: true } });
    expect((await settings(f, 'bo')).json.target).toBe('task');
    expect((await settings(f, 'ana', { target: 'ceo' })).json.target).toBe('ceo');
    // Nothing else the organization set changed: its tasks' target branch is still its own.
    expect((await f.store.getSettings(`organization:${f.organization.id}`, '__common__'))?.target).toBeUndefined();
  });

  it('the first Ask starts the CEO with what was asked and the asker’s own authority; every later one is a message to it', async () => {
    const f = await fixture();
    // The default: nobody chose anything.
    const first = await f.ask('bo', 'Plan the launch');
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ ceo: true, title: 'CEO (Organization Co-ordinator)', project: { name: 'CEO', coordinator: true } });
    const ceo = (await f.store.getTask(first.json.id))!;
    expect(ceo.params).toMatchObject({ prompt: 'Plan the launch', draft: false, coordinator: { wakeHours: 24 } });
    // Bo's own authority, not the project's default, and no computerless ceiling.
    expect(ceo.params._authorization).toMatchObject({ level: 'developer', scope: 'organization' });
    expect((ceo.params._authorization as { heldBack?: string[] }).heldBack).toBeUndefined();
    expect(f.started).toContain(ceo.id);
    // No quick task was made.
    expect((await f.store.listTasks(first.json.projectId)).map((task) => task.id)).toEqual([ceo.id]);

    // Running, it takes messages.
    await f.store.saveView(ceo.id, { taskId: ceo.id, title: ceo.title, stage: 'do', status: 'active', messages: [], state: {}, prs: [],
      actions: [{ kind: 'signal', name: 'followUp', label: 'Send', enabled: true }] } as never);
    const second = await f.ask('ana', 'Also hire a designer');
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.id).toBe(ceo.id);
    expect(f.signals.some((signal) => signal.taskId === ceo.id && signal.name === 'followUp'
      && JSON.stringify(signal.payload).includes('Also hire a designer'))).toBe(true);
    expect((await f.store.listTasks(first.json.projectId)).length).toBe(1);
  });

  it('nobody steers a CEO that holds more than they do: their Ask is a quick task with their own authority instead', async () => {
    const f = await fixture();
    // Ana, the owner, asks first: the CEO acts with her whole authority.
    const first = await f.ask('ana', 'Run the firm');
    const ceo = (await f.store.getTask(first.json.id))!;
    expect(ceo.params._authorization).toMatchObject({ level: 'superadmin', scope: 'organization' });
    await f.store.saveView(ceo.id, { taskId: ceo.id, title: ceo.title, stage: 'do', status: 'active', messages: [], state: {}, prs: [],
      actions: [{ kind: 'signal', name: 'followUp', label: 'Send', enabled: true }] } as never);
    // Bo, a developer, cannot have it act for him with Ana's authority.
    const asked = await f.ask('bo', 'Delete the old projects');
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json.ceo).toBeUndefined();
    expect(asked.json.id).not.toBe(ceo.id);
    const quick = (await f.store.getTask(asked.json.id))!;
    expect(quick.params).toMatchObject({ prompt: 'Delete the old projects', computer: { provider: 'none' } });
    expect(quick.params._authorization).toMatchObject({ level: 'developer', scope: 'organization' });
    expect(f.signals.some((signal) => signal.taskId === ceo.id && JSON.stringify(signal.payload).includes('Delete the old projects'))).toBe(false);
    // Ana still talks to it.
    expect((await f.ask('ana', 'And the budget?')).json.id).toBe(ceo.id);
    // Nor may someone who holds as much, but may not write to a task that is not theirs: a quick task too.
    await f.store.patchTaskParams(ceo.id, { _authorization: { ...(ceo.params._authorization as object), capabilities: ['task:read'] } });
    const third = await f.ask('bo', 'What is planned?');
    expect(third.status, JSON.stringify(third.json)).toBe(200);
    expect(third.json.id).not.toBe(ceo.id);
  });

  it('a CEO someone already wrote to keeps what they wrote and the authority they chose; the Ask is added to it', async () => {
    const f = await fixture();
    await settings(f, 'ana', { target: 'ceo' });
    const { project } = await f.store.ensureOrganizationCoordinatorProject(f.organization.id);
    const ceo = await ensureCeo(f.deps, project.id);
    await f.store.patchTaskParams(ceo.id, { prompt: 'Run the firm frugally.' });
    const before = (await f.store.getTask(ceo.id))!.params._authorization;
    const asked = await f.ask('ana', 'Start with the website');
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const after = (await f.store.getTask(ceo.id))!;
    expect(after.params.prompt).toBe('Run the firm frugally.\n\nStart with the website');
    expect(after.params._authorization).toMatchObject({ level: (before as { level: string }).level, scope: (before as { scope: string }).scope });
  });
});
