import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { roleCeiling } from '../src/contrib/manifests.js';
import type { AuthorizationSelection } from '../src/domain/types.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * PL-12. Organization wiki pages reach every task prompt in the organization,
 * so editing them takes `organization:wiki:write`: Project maintainer or above,
 * granted for the whole organization. A project grant never carries it — for
 * people and for the agents of tasks they authorize alike.
 */
describe('organization wiki edits need organization-scoped maintainer authority', () => {
  let dir: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let organizationId: string;
  let projectId: string;
  const agents: Record<string, string> = {};

  const people = ['owner', 'admin', 'org-maintainer', 'project-maintainer', 'developer'];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-org-wiki-authz-'));
    store = await Store.create(':memory:');
    const tokens = new TokenAuthority();
    const authorization = await AuthorizationService.create(store);
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Web', {}, organization.id);
    organizationId = organization.id;
    projectId = project.id;
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    const member = async (userId: string, role: 'admin' | 'member', selection: AuthorizationSelection) => {
      await store.setOrganizationMembership(organization.id, userId, role);
      await authorization.replacePrincipalAuthorization('user:owner', `user:${userId}`, organization.id, selection);
    };
    await member('admin', 'admin', { level: 'administrator', scope: 'organization' });
    await member('org-maintainer', 'member', { level: 'maintainer', scope: 'organization' });
    await member('project-maintainer', 'member', { level: 'maintainer', scope: 'projects', projectIds: [project.id] });
    // What an invitation without an explicit level grants a plain member.
    await member('developer', 'member', { level: 'developer', scope: 'organization' });

    // Agent tokens exactly as a turn mints them: the task's stored authorization
    // (attenuated to its creator) under the Do role's ceiling.
    const task = await store.createTask({ projectId: project.id, title: 'Task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
    const agentToken = async (selection: AuthorizationSelection) => {
      const grant = await authorization.taskGrant('user:owner', project.id, selection);
      return (await tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', principal: 'user:owner',
        projectIds: grant.scope === 'projects' ? grant.projectIds : undefined, organizationId: organization.id,
        ceiling: roleCeiling('do'), grantorCaps: grant.capabilities })).token;
    };
    agents['project-scoped maintainer task'] = await agentToken({ level: 'maintainer', scope: 'projects', projectIds: [project.id] });
    agents['organization-scoped maintainer task'] = await agentToken({ level: 'maintainer', scope: 'organization' });
    agents['organization-scoped developer task'] = await agentToken({ level: 'developer', scope: 'organization' });
    agents['project-scoped viewer task'] = await agentToken({ level: 'viewer', scope: 'projects', projectIds: [project.id] });

    const client = { workflow: { getHandle: () => ({}), list: async function* () {} } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: dir });
    const users = people.map((id) => ({ id, name: id, email: `${id}@example.test` }));
    const gateway = await Gateway.create({ api, store, tokens, client, worlds, authorization,
      identity: {
        sessionActive: async (id: string) => id.endsWith('-session'),
        connectOrganizationNames: () => {},
        session: async (headers: Headers) => {
          const user = users.find((candidate) => headers.get('cookie') === `fixture=${candidate.id}`);
          return user ? { user, session: { id: `${user.id}-session` } } : null;
        },
        listUsers: async () => users,
      } as any,
      taskQueue: 'test', staticDir: dir, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'organization wiki authority' } });
    const running = await gateway.listen(await findFreePortFrom(49_400));
    base = running.url;
    close = running.close;
    await vi.waitFor(async () => { if (!(await store.projectWiki(project.id))) throw new Error('wiki not ready'); }, { timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const as = (caller: string): Record<string, string> => people.includes(caller)
    ? { cookie: `fixture=${caller}` } : { authorization: `Bearer ${agents[caller]}` };
  const call = async (caller: string, method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, { method, headers: { ...as(caller), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  const writeOrganizationPage = (caller: string, page: string) => call(caller, 'PUT',
    `/api/organizations/${organizationId}/wiki/page`, { path: `notes/${page}`, content: `---\ndescription: ${page}\n---\nBody.` });

  it('refuses a developer member, whose project wiki writes still succeed', async () => {
    const denied = await writeOrganizationPage('developer', 'developer');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/organization wiki/i);
    expect((await call('developer', 'PUT', `/api/projects/${projectId}/wiki/page`,
      { path: 'notes/developer', content: 'Project notes.' })).status).toBe(200);
    expect((await call('developer', 'DELETE', `/api/organizations/${organizationId}/wiki/page?path=notes/owner`)).status).toBe(403);
  });

  it('refuses a Project maintainer granted on projects, not on the organization', async () => {
    expect((await writeOrganizationPage('project-maintainer', 'project-maintainer')).status).toBe(403);
  });

  it.each(['org-maintainer', 'admin', 'owner'])('allows %s', async (caller) => {
    const saved = await writeOrganizationPage(caller, caller);
    expect(saved.status).toBe(200);
    expect(saved.body.path).toBe(`notes/${caller}`);
  });

  it('keeps default-labelled pages behind organization:edit', async () => {
    const promptWide = { path: 'rules/everywhere', content: '---\nlabels: default\n---\nEverywhere.' };
    expect((await call('org-maintainer', 'PUT', `/api/organizations/${organizationId}/wiki/page`, promptWide)).body.error)
      .toMatch(/organization:edit/);
    expect((await call('admin', 'PUT', `/api/organizations/${organizationId}/wiki/page`, promptWide)).status).toBe(200);
  });

  it('follows the task authorization for agents, through the wiki API and save_skill', async () => {
    const projectTask = await writeOrganizationPage('project-scoped maintainer task', 'project-agent');
    expect(projectTask.status).toBe(403);
    expect(projectTask.body.error).toMatch(/organization wiki/i);
    expect((await writeOrganizationPage('organization-scoped developer task', 'developer-agent')).status).toBe(403);
    expect((await writeOrganizationPage('organization-scoped maintainer task', 'org-agent')).status).toBe(200);
    // Project wiki writes keep requiring only skill:write.
    expect((await call('project-scoped maintainer task', 'PUT', `/api/projects/${projectId}/wiki/page`,
      { path: 'notes/project-agent', content: 'Project notes.' })).status).toBe(200);

    // save_skill still lets every agent learn: without organization-wide
    // authority the skill lands in the task's own project.
    const skill = { name: 'resolve/flaky-clone', content: 'Retry the clone.' };
    const local = await call('project-scoped maintainer task', 'POST', '/api/skills', skill);
    expect(local.status).toBe(200);
    expect(local.body.scope).toBe('project');
    expect(local.body.path.replace(/\\/g, '/')).toContain(`/skills/projects/${projectId}/resolve/flaky-clone.md`);
    const saved = await call('organization-scoped maintainer task', 'POST', '/api/skills', skill);
    expect(saved.status).toBe(200);
    expect(saved.body.scope).toBe('organization');
    expect(saved.body.path.replace(/\\/g, '/')).toContain(`/skills/organizations/${organizationId}/resolve/flaky-clone.md`);
    // A Viewer task holds neither skill:write nor organization:wiki:write.
    expect((await call('project-scoped viewer task', 'POST', '/api/skills', skill)).status).toBe(403);
  });

  it('shows edit controls only to readers who may edit', async () => {
    await writeOrganizationPage('owner', 'readable');
    const view = async (caller: string, page = '') =>
      (await call(caller, 'GET', `/api/organizations/${organizationId}/wiki?path=${encodeURIComponent(page)}`)).body;
    expect((await view('developer')).view.writable).toBe(false);
    expect((await view('developer', 'notes/readable')).view.writable).toBe(false);
    expect((await view('org-maintainer')).view.writable).toBe(true);
    expect((await view('org-maintainer', 'notes/readable')).view.writable).toBe(true);
    // Prompt-wide pages additionally need organization:edit.
    expect((await view('org-maintainer', '@builtin/how-to-work')).view.writable).toBe(false);
    expect((await view('org-maintainer')).unconditional.every((entry: any) => entry.writable === false)).toBe(true);
    expect((await view('admin', '@builtin/how-to-work')).view.writable).toBe(true);
    expect((await view('admin')).unconditional.every((entry: any) => entry.writable === true)).toBe(true);
  });

  it('lists the capability in the catalogue and lets administrators grant it in custom roles', async () => {
    const roles = (await call('owner', 'GET', `/api/organizations/${organizationId}/roles`)).body;
    const listed = roles.capabilityGroups.flatMap((group: any) => group.capabilities);
    expect(listed).toContainEqual(expect.objectContaining({ id: 'organization:wiki:write', label: 'Edit organization wiki' }));
    expect(roles.creatableCapabilities).toContain('organization:wiki:write');
    const developerView = (await call('developer', 'GET', `/api/authorization/profiles?projectId=${projectId}`)).body;
    const profiles = new Map(developerView.profiles.map((profile: any) => [profile.id, profile.capabilities]));
    expect(profiles.get('viewer')).not.toContain('organization:wiki:write');
    expect(profiles.get('developer')).not.toContain('organization:wiki:write');
    expect(profiles.get('maintainer')).toContain('organization:wiki:write');
  });
});
