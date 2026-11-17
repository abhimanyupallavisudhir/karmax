import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { allows, heldBackCapabilities, IRREVERSIBLE_CAPABILITIES, withoutCapabilities } from '../src/platform/capabilities.js';
import { exactCapability } from '../src/platform/permission-requests.js';
import { baseTaskAuthority, taskAuthorityNow } from '../src/platform/task-authority.js';
import { summarizeCapabilities } from '../src/platform/authorization-summary.js';
import type { AuthorizationSelection, TaskRecord } from '../src/domain/types.js';

/**
 * A task without a computer acts with a person's authority while reading text
 * it did not write, so it holds back the irreversible capabilities unless its
 * creator keeps one; its agent asks for one with request_permission, and the
 * person approves as for any other request (wiki features/computerless-tasks).
 */
async function fixture() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Assistant', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  await store.setOrganizationMembership(organization.id, 'dev', 'member');
  // Changing authorization and users is installation authority: only God holds it.
  await store.setOrganizationMembership(organization.id, 'root', 'member');
  await authorization.grant('system:test', { principalId: 'user:root', scopeKey: 'global', profileId: 'god' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const client = { workflow: {
    getHandle: (id: string) => ({
      describe: async () => ({ runId: 'run', status: { name: 'COMPLETED' } }),
      terminate: async () => undefined,
      executeUpdate: async () => undefined,
      query: async (name: string) => {
        const view = name === 'view' ? (await store.getTask(id))?.lastView : undefined;
        if (!view) throw new Error('no live query');
        return view;
      },
      signal: async () => undefined,
    }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const human = async (userId: string) => (await tokens.mintPrincipal(`user:${userId}`,
    await authorization.capabilities(`user:${userId}`, project.id, organization.id), project.id, undefined, organization.id)).token;
  /** The task's Do agent, as a turn mints it: the task's authority now. */
  const agentOf = async (task: TaskRecord) => {
    const now = await taskAuthorityNow(store, authorization, (await store.getTask(task.id))!);
    return (await tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', principal: `task-agent:${task.id}:do`,
      projectId: project.id, organizationId: organization.id, ceiling: now.capabilities, grantorCaps: now.capabilities })).token;
  };
  const administrator: AuthorizationSelection = { level: 'superadmin', scope: 'organization' };
  return { store, organization, project, authorization, api, human, agentOf, administrator };
}

const capsOf = (task: { params: Record<string, unknown> }) => (task.params._authorization as { capabilities: string[] }).capabilities;

describe('holding back the irreversible capabilities', () => {
  it('removes them through wildcards, keeping everything else', () => {
    const everything = withoutCapabilities(['*'], IRREVERSIBLE_CAPABILITIES);
    for (const capability of IRREVERSIBLE_CAPABILITIES) expect(allows(everything, capability)).toBe(false);
    expect(allows(everything, 'use-card:card_1')).toBe(false);
    for (const capability of ['task:read', 'task:create', 'project:edit', 'payment:read', 'credential:read', 'merge-into:/repo:main', 'use-credential:item:x'])
      expect(allows(everything, capability)).toBe(true);
    const narrow = withoutCapabilities(['task:*', 'payment:*', 'use-card:card_1', 'merge-into:/r:main', 'use-credential:item:y', 'create-sub-task'], IRREVERSIBLE_CAPABILITIES);
    expect(allows(narrow, 'task:delete')).toBe(false);
    expect(allows(narrow, 'task:signal')).toBe(true);
    expect(allows(narrow, 'payment:write')).toBe(false);
    expect(allows(narrow, 'payment:read')).toBe(true);
    expect(allows(narrow, 'use-card:card_1')).toBe(false);
    expect(narrow).toEqual(expect.arrayContaining(['merge-into:/r:main', 'use-credential:item:y', 'create-sub-task']));
  });

  it('keeps only the irreversible capabilities a creator names, and refuses others', () => {
    expect(heldBackCapabilities(['payment:write', 'use-card:*'])).toEqual(IRREVERSIBLE_CAPABILITIES.filter((c) => c !== 'payment:write' && c !== 'use-card:*'));
    expect(() => heldBackCapabilities(['task:read'])).toThrow(/only irreversible capabilities/);
  });

  it('a computerless task holds them back from its creator\'s grant; a task with a computer does not', async () => {
    const f = await fixture();
    const owner = await f.human('owner');
    const assistant = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'help me',
      authorization: f.administrator, params: { computer: { provider: 'none' } } });
    expect((assistant.params._authorization as { heldBack: string[] }).heldBack).toEqual(IRREVERSIBLE_CAPABILITIES);
    for (const capability of IRREVERSIBLE_CAPABILITIES) expect(allows(capsOf(assistant), capability)).toBe(false);
    expect(allows(capsOf(assistant), 'project:edit')).toBe(true);
    // It shows in the task's authorization as what it lacks.
    expect(summarizeCapabilities(capsOf(assistant)).missing).toEqual(expect.arrayContaining(['task:delete', 'organization:delete', 'credential:reveal']));

    const worker = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'code',
      authorization: f.administrator, params: {} });
    expect(worker.params._authorization).not.toHaveProperty('heldBack');
    expect(allows(capsOf(worker), 'project:delete')).toBe(true);

    const kept = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'pay my bills',
      authorization: f.administrator, params: { computer: { provider: 'none' } }, keepIrreversible: ['payment:write'] });
    expect(allows(capsOf(kept), 'payment:write')).toBe(true);
    expect(allows(capsOf(kept), 'task:delete')).toBe(false);
  });

  it('a project whose tasks default to no computer holds them back too', async () => {
    const f = await fixture();
    await f.store.setProjectExecutionPolicy(f.project.id, { worldProvider: 'none' });
    const task = await f.api.createTask(await f.human('owner'), { projectId: f.project.id, workflow: 'software-dev', prompt: 'x',
      authorization: f.administrator });
    expect(allows(capsOf(task), 'project:delete')).toBe(false);
  });

  it('"own authority" gives the task its creator\'s own level and scope', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.human('owner'), { projectId: f.project.id, workflow: 'software-dev', prompt: 'x',
      ownAuthority: true, params: { computer: { provider: 'none' } } });
    expect(task.params._authorization).toMatchObject({ level: 'superadmin', scope: 'organization' });
    expect(allows(capsOf(task), 'organization:edit')).toBe(true);
    expect(allows(capsOf(task), 'organization:delete')).toBe(false);
  });

  it('request_permission gets each one back, exactly, from the person who created the task', async () => {
    const f = await fixture();
    const owner = await f.human('owner');
    const task = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'help me',
      authorization: f.administrator, params: { computer: { provider: 'none' } } });
    expect(() => exactCapability('use-card:*')).toThrow(/wildcards are not allowed/);
    await f.store.saveView(task.id, { taskId: task.id, stage: 'do', status: 'active', messages: [], state: {}, actions: [], prs: [] } as never);
    const asked = IRREVERSIBLE_CAPABILITIES.map((capability) => capability === 'use-card:*' ? 'use-card:card_42' : capability);
    for (const capability of asked) {
      const agent = await f.agentOf(task);
      const request = await f.api.requestPermission(agent, { capabilities: [capability], reason: `I need ${capability}.` });
      expect(request.status).toBe('needs_approval');
      // Its person approves what they hold; what only the installation holds goes to who holds it.
      const installation = ['authorization:write', 'user:write'].includes(capability);
      if (!installation) expect(request.audience).toEqual(['@creator']);
      await f.api.resolvePermissionRequest(installation ? await f.human('root') : owner,
        { organizationId: f.organization.id, requestId: request.requestId!, action: 'approve' });
      const now = await taskAuthorityNow(f.store, f.authorization, (await f.store.getTask(task.id))!);
      expect(allows(now.capabilities, capability)).toBe(true);
    }
    // Granted once, it holds for the rest of the task; nothing else came back with it.
    const now = await taskAuthorityNow(f.store, f.authorization, (await f.store.getTask(task.id))!);
    expect(allows(now.capabilities, 'use-card:card_7')).toBe(false);
    expect((await f.api.requestPermission(await f.agentOf(task), { capabilities: ['task:delete'], reason: 'again' })).status).toBe('granted');
  });

  it('a sub-task without a computer holds them back from its parent\'s authority', async () => {
    const f = await fixture();
    const owner = await f.human('owner');
    const parent = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'code',
      authorization: f.administrator, params: {} });
    const child = await f.store.createTask({ projectId: f.project.id, title: 'Ask', workflow: 'software-dev', workflowVersion: '1.30.0',
      parentTaskId: parent.id, createdBy: { kind: 'task-agent', taskId: parent.id, role: 'do' },
      params: { prompt: 'x', computer: { provider: 'none' }, _authorization: { profileId: 'inherited-child', principal: `task:${parent.id}`,
        capabilities: ['task:read'], heldBack: IRREVERSIBLE_CAPABILITIES } } });
    const base = await baseTaskAuthority(f.store, f.authorization, child);
    expect(allows(base.capabilities, 'project:edit')).toBe(true);
    for (const capability of IRREVERSIBLE_CAPABILITIES) expect(allows(base.capabilities, capability)).toBe(false);
  });
});

describe('scope of the ceiling', () => {
  it('names the organization owner\'s grant as the source the hold-back attenuates', async () => {
    const f = await fixture();
    expect(allows(await f.authorization.capabilities('user:owner', f.project.id, f.organization.id), 'organization:delete')).toBe(true);
    expect(organizationScope(f.organization.id)).toContain(f.organization.id);
  });
});
