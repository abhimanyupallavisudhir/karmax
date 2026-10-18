import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { allows } from '../src/platform/capabilities.js';
import { baseTaskAuthority, delegationReaching, taskAuthorityNow } from '../src/platform/task-authority.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { resolvePaymentPolicy } from '../src/autonomy/payments.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { TaskView } from '../src/domain/types.js';

/** A sub-task acts with its parent's authority as it is now (SPEC §8.2,
 * src/platform/delegation.ts): it never asks anyone for what its parent holds. */
describe('a sub-task acts with its parent\'s authority', () => {
  async function family() {
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Site', {}, organization.id);
    const other = await store.createProject('Docs', {}, organization.id);
    const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1',
      params: { prompt: '', paymentPolicy: { budget: 500, currency: 'usd' }, _authorization: {
        level: 'developer', scope: 'projects', projectIds: [project.id, other.id], organizationId: organization.id,
        capabilities: ['task:read', 'task:create', 'project:read', 'use-credential:item:vi_site', 'merge-into:parent-branch'] } } });
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const input = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work',
      project: {}, parentBranch: 'parent-branch' });
    const child = (await store.getTask(input.taskId))!;
    return { store, organization, project, other, parent, child, core };
  }

  it('holds its parent\'s scope and what the parent is granted after it started', async () => {
    const f = await family();
    try {
      const before = await baseTaskAuthority(f.store, undefined, f.child);
      expect(before).toMatchObject({ scope: 'projects', projectIds: [f.project.id, f.other.id] });
      expect(allows(before.capabilities, 'use-credential:item:vi_site')).toBe(true);
      expect(allows(before.capabilities, 'merge-into:parent-branch')).toBe(true);
      expect(allows(before.capabilities, 'merge-into:main')).toBe(false);
      // Approved for the parent later: a permission request and a vault credential.
      await f.store.kvSet(`permission:grant:${f.parent.id}`, JSON.stringify({ do: ['task:signal'] }));
      await f.store.kvSet(`vault:grant:${f.parent.id}`, JSON.stringify([{ cap: 'use-credential:item:vi_stripe', grantedBy: 'user:owner', at: 1 }]));
      const after = await baseTaskAuthority(f.store, undefined, (await f.store.getTask(f.child.id))!);
      for (const cap of ['task:signal', 'use-credential:item:vi_stripe']) expect(allows(after.capabilities, cap), cap).toBe(true);
      // A grandchild inherits through its parent.
      const grandchild = await f.core.prepareChildTask({ parentTaskId: f.child.id, projectId: f.project.id, title: 'Grandchild', prompt: 'work', project: {} });
      const deep = await taskAuthorityNow(f.store, undefined, (await f.store.getTask(grandchild.taskId))!);
      expect(allows(deep.capabilities, 'use-credential:item:vi_stripe')).toBe(true);
      expect(deep.projectIds).toEqual([f.project.id, f.other.id]);
    } finally { await f.store.close(); }
  });

  it('loses what its parent loses, and keeps its start grant once the parent is gone', async () => {
    const f = await family();
    try {
      await f.store.updateTaskParams(f.parent.id, { ...f.parent.params, _authorization: { capabilities: ['task:read'] } });
      const narrowed = await baseTaskAuthority(f.store, undefined, f.child);
      expect(allows(narrowed.capabilities, 'use-credential:item:vi_site')).toBe(false);
      expect(allows(narrowed.capabilities, 'merge-into:parent-branch')).toBe(false);
      expect(narrowed.scope).toBeUndefined();
      await f.store.deleteTask(f.parent.id);
      const orphan = await baseTaskAuthority(f.store, undefined, f.child);
      expect(allows(orphan.capabilities, 'use-credential:item:vi_site')).toBe(true);
    } finally { await f.store.close(); }
  });

  it('carries a human delegation that reaches as far as its parent\'s scope', async () => {
    const store = await Store.create(':memory:');
    try {
      const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
      const project = await store.createProject('Site', {}, organization.id);
      const tokens = new TokenAuthority(store);
      const human = (await tokens.mintPrincipal('user:owner', ['*'], undefined, undefined, organization.id)).token;
      const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params: { prompt: '' } });
      const delegation = (await tokens.delegateHuman(human, { taskId: parent.id, organizationId: organization.id }))!;
      await store.updateTaskParams(parent.id, { ...parent.params, _authorization: { level: 'administrator', scope: 'organization',
        organizationId: organization.id, capabilities: ['task:read', 'project:read'], delegationId: delegation.id } });
      const core = makeCoreActivities({ store, tokens, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
      const input = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work', project: {} });
      const orgScope = { organizationId: organization.id };
      expect(await tokens.delegationCovers(input.delegationId!, orgScope)).toBe(true);
      await expect(tokens.mint({ taskId: input.taskId, profileId: 'do', role: 'do', principal: `task:${parent.id}`, ...orgScope,
        delegationId: input.delegationId, ceiling: ['*'], grantorCaps: ['task:read'] })).resolves.toBeDefined();

      // A sub-task made before this, its delegation pinned to its own project, gets one that reaches.
      const child = (await store.getTask(input.taskId))!;
      const pinned = await tokens.deriveHumanDelegation(delegation.id, { taskId: child.id, projectId: project.id, organizationId: organization.id });
      await store.updateTaskParams(child.id, { ...child.params, _authorization: { ...child.params._authorization as object, delegationId: pinned.id } });
      const reached = await delegationReaching(store, tokens, (await store.getTask(child.id))!, { ...orgScope, delegationId: pinned.id });
      expect(reached.delegationId).not.toBe(pinned.id);
      expect(await tokens.delegationCovers(reached.delegationId!, orgScope)).toBe(true);
      expect(((await store.getTask(child.id))!.params._authorization as any).delegationId).toBe(reached.delegationId);
      // Without a parent delegation to derive from, it stays in its own project.
      await store.updateTaskParams(parent.id, { ...(await store.getTask(parent.id))!.params, _authorization: { capabilities: [] } });
      expect(await delegationReaching(store, tokens, (await store.getTask(child.id))!, { ...orgScope, delegationId: pinned.id }))
        .toMatchObject({ projectId: project.id, organizationId: organization.id, delegationId: pinned.id });
    } finally { await store.close(); }
  });

  it('uses its parent\'s vault policy overrides and payment policy', async () => {
    const f = await family();
    try {
      const vault = new VaultItems(f.store, undefined, undefined, f.organization.id);
      await vault.setTaskPolicies(f.parent.id, { vi_site: { use: 'auto' } });
      const item = { id: 'vi_site', policy: { use: 'ask', reveal: 'ask' } } as any;
      expect(await vault.effectivePolicy(f.child.id, item)).toMatchObject({ use: 'auto', reveal: 'ask' });
      await vault.setTaskPolicies(f.child.id, { vi_site: { use: 'ask' } });
      expect((await vault.effectivePolicy(f.child.id, item)).use).toBe('ask');
      expect(await resolvePaymentPolicy(f.store, f.project.id, f.child.id)).toMatchObject({ budget: 500, currency: 'usd' });
    } finally { await f.store.close(); }
  });
});

/** Who a permission request goes to: the nearest who can grant it (SPEC §8.2). */
describe('routing a permission request to the nearest who can grant it', () => {
  async function fixture() {
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Site', {}, organization.id);
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    for (const userId of ['admin', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
    await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
    await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
    const tokens = new TokenAuthority(store);
    const delivered: Array<{ taskId: string; message: any }> = [];
    const client = { workflow: {
      getHandle: (id: string) => ({
        describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }),
        terminate: async () => undefined,
        executeUpdate: async () => undefined,
        query: async (name: string) => {
          const view = name === 'view' ? (await store.getTask(id))?.lastView : undefined;
          if (!view) throw new Error('no live query');
          return view;
        },
        signal: async (_name: string, message: any) => { delivered.push({ taskId: id, message }); },
      }),
      start: async () => ({}),
    } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
    const view = async (taskId: string, status = 'active') => store.saveView(taskId, { taskId, title: 'T', workflow: 'software-dev',
      stage: 'do', status, messages: [], actions: [], state: {}, updatedAt: 1 } as unknown as TaskView);
    const adminCaps = await authorization.capabilities('user:admin', project.id, organization.id);
    // An administrator's task whose agent created a developer-level task.
    const lead = await store.createTask({ projectId: project.id, title: 'Lead', workflow: 'software-dev', workflowVersion: '1.30.0',
      createdBy: { kind: 'user', userId: 'admin' }, params: { prompt: 'lead', _authorization: { level: 'administrator',
        scope: 'organization', organizationId: organization.id, capabilities: adminCaps } } });
    const devCaps = await authorization.capabilities('user:dev', project.id, organization.id);
    const helper = await store.createTask({ projectId: project.id, title: 'Helper', workflow: 'software-dev', workflowVersion: '1.30.0',
      createdBy: { kind: 'task-agent', taskId: lead.id, role: 'do' }, params: { prompt: 'help', _authorization: { level: 'developer',
        scope: 'projects', projectIds: [project.id], capabilities: devCaps } } });
    await view(lead.id); await view(helper.id);
    const agentOf = async (taskId: string, caps: string[]) => (await tokens.mint({ taskId, profileId: 'do', role: 'do',
      principal: `task-agent:${taskId}:do`, projectId: project.id, organizationId: organization.id, ceiling: caps, grantorCaps: caps })).token;
    return { store, organization, project, api, tokens, lead, helper, adminCaps, devCaps, agentOf, view, delivered };
  }

  it('asks the task that created it, which holds it, and lets its agent grant it', async () => {
    const f = await fixture();
    try {
      const asker = await f.agentOf(f.helper.id, [...f.devCaps, 'task:escalate']);
      const grantors = await f.api.permissionGrantorsFor(asker, { capabilities: ['project:settings:write'] });
      expect(grantors.missing).toEqual(['project:settings:write']);
      expect(grantors.tasks.map((task) => task.selector)).toEqual([`task:${f.lead.id}`]);
      expect(grantors.default).toBe(`task:${f.lead.id}`);
      expect(grantors.users.map((user) => user.id).sort()).toEqual(['admin', 'owner']);

      const requested = await f.api.requestPermission(asker, { capabilities: ['project:settings:write'], reason: 'Turn on the preview setting.' });
      expect(requested).toMatchObject({ status: 'needs_approval', audience: [`task:${f.lead.id}`] });
      expect(requested.canGrant?.[0]).toBe(`task:${f.lead.id}`);
      expect(requested.canGrant).toEqual(expect.arrayContaining(['@admins', 'user:admin']));
      // The lead's agent is told, and how to decide.
      const told = f.delivered.find((entry) => entry.taskId === f.lead.id)!;
      expect(told.message).toMatchObject({ author: `task:${f.helper.id}` });
      expect(told.message.text).toContain(`/api/permission-requests/${requested.requestId}/resolve`);

      // The approval list names the task it asks.
      const [listed] = await f.api.listPermissionRequests(await f.agentOf(f.lead.id, f.adminCaps),
        { organizationId: f.organization.id, taskId: f.helper.id });
      expect(listed!.grantorTasks).toEqual([{ id: f.lead.id, title: 'Lead', projectId: f.project.id, ...(f.lead.num != null ? { num: f.lead.num } : {}) }]);
      // Another task's agent cannot decide it; the lead's can.
      const outsider = await f.store.createTask({ projectId: f.project.id, title: 'Outsider', workflow: 'software-dev', workflowVersion: '1.30.0',
        createdBy: { kind: 'user', userId: 'admin' }, params: { prompt: 'x' } });
      await expect(f.api.resolvePermissionRequest(await f.agentOf(outsider.id, f.adminCaps),
        { organizationId: f.organization.id, requestId: requested.requestId!, action: 'approve' })).rejects.toThrow(/routed/);
      const decided = await f.api.resolvePermissionRequest(await f.agentOf(f.lead.id, f.adminCaps),
        { organizationId: f.organization.id, requestId: requested.requestId!, action: 'approve' });
      expect(decided.status).toBe('granted');
      expect(await taskAuthorityNow(f.store, undefined, (await f.store.getTask(f.helper.id))!))
        .toMatchObject({ capabilities: expect.arrayContaining(['project:settings:write']) });
    } finally { await f.store.close(); }
  });

  it('asks people when no task it acts for holds it, or that task has finished', async () => {
    const f = await fixture();
    try {
      const asker = await f.agentOf(f.helper.id, [...f.devCaps, 'task:escalate']);
      expect((await f.api.permissionGrantorsFor(asker, { capabilities: ['credential:reveal'] })))
        .toMatchObject({ tasks: [], default: '@superadmins' });
      await f.view(f.lead.id, 'done');
      const requested = await f.api.requestPermission(asker, { capabilities: ['project:settings:write'], reason: 'Turn on previews.' });
      expect(requested.audience).toEqual(['@admins']);
      await expect(f.api.requestPermission(asker, { capabilities: ['project:edit'], audience: [`task:${f.lead.id}`], reason: 'x' }))
        .rejects.toThrow(/cannot grant/);
    } finally { await f.store.close(); }
  });
});
