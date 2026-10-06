import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationGrantError, AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { AuthorizationSelection, TaskView } from '../src/domain/types.js';

/** Asking for more authorization than you have: who is summoned, and how an
 * agent is told to proceed (SPEC §8.2). Humans and agents get the same answer. */
async function fixture() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Site', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  for (const userId of ['admin', 'maint', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
  await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
  await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const terminated: string[] = [];
  const client = { workflow: {
    getHandle: (id: string) => ({
      describe: async () => ({ runId: 'run', status: { name: 'COMPLETED' } }),
      terminate: async (reason: string) => { terminated.push(reason); },
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
  /** The Do agent of a developer's task: only its own token, no human subject. */
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
  const agentOf = async (taskId: string, caps?: string[]) => {
    const held = caps ?? await authorization.capabilities('user:dev', project.id, organization.id);
    return (await tokens.mint({ taskId, profileId: 'do', role: 'do', principal: `task-agent:${taskId}:do`,
      projectId: project.id, organizationId: organization.id, ceiling: held, grantorCaps: held })).token;
  };
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  return { store, organization, project, authorization, tokens, api, human, agentOf, parent, maintainer, terminated };
}

describe('summoning someone who can grant it', () => {
  it.each([
    [{ level: 'maintainer', scope: 'projects' }, '@maintainers', ['admin', 'maint', 'owner']],
    [{ level: 'administrator', scope: 'organization' }, '@admins', ['admin', 'owner']],
    [{ level: 'superadmin', scope: 'organization' }, '@superadmins', ['owner']],
  ] as const)('asks for %o from %s', async (selection, summon, eligible) => {
    const f = await fixture();
    const authorization = { ...selection, ...(selection.scope === 'projects' ? { projectIds: [f.project.id] } : {}) } as AuthorizationSelection;
    const targets = await f.api.authorizationEscalationTargets(await f.human('dev'), { projectId: f.project.id, authorization });
    expect(targets.summon).toBe(summon);
    const special = targets.special.find((item) => item.selector === summon)!;
    expect([...special.eligibleUserIds].sort()).toEqual(eligible);
    // A level below the summoned one is never offered as a group.
    const order = ['@maintainers', '@admins', '@superadmins'];
    for (const below of order.slice(0, order.indexOf(summon)))
      expect(targets.special.some((item) => item.selector === below)).toBe(false);
    // People stay individually selectable.
    expect(targets.users.map((user) => user.id).sort()).toEqual(eligible);
  });

  it('summons nobody when no one in the organization can grant it', async () => {
    const f = await fixture();
    const targets = await f.api.authorizationEscalationTargets(await f.human('owner'),
      { projectId: f.project.id, authorization: { level: 'god', scope: 'global' } });
    expect(targets.summon).toBeUndefined();
    expect(targets.special).toEqual([]);
  });

  it('routes a summons only to the members who can grant the complete package', async () => {
    const f = await fixture();
    const task = await f.store.createTask({ projectId: f.project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'dev' }, params: { draft: true, prompt: 'work' } });
    const request = await f.api.requestAuthorization(await f.human('dev'), { projectId: f.project.id,
      target: { kind: 'task', taskId: task.id }, authorization: { level: 'administrator', scope: 'organization' }, audience: ['@admins'] });
    expect([...request.recipients].sort()).toEqual(['admin', 'owner']);
    expect(request.audience).toEqual(['@admins']);
  });
});

describe('an agent granting more than it has', () => {
  it('is refused with what is missing, whom to summon and how to proceed', async () => {
    const f = await fixture();
    const agent = await f.agentOf(f.parent.id);
    const refusal = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'child',
      authorization: f.maintainer }).catch((error) => error);
    expect(refusal).toBeInstanceOf(AuthorizationGrantError);
    expect(refusal).toMatchObject({ status: 403, code: 'authorization_grant_denied',
      gap: { summon: '@maintainers', missingCapabilities: expect.arrayContaining(['project:edit']) } });
    expect(refusal.message).toMatch(/@maintainers/);
    expect(refusal.message).toMatch(/acceptAttenuation/);
    expect(refusal.message).toMatch(/\/api\/authorization-requests/);

    // Cut back to size…
    const limited = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'child',
      authorization: f.maintainer, draft: true, acceptAttenuation: true });
    expect(limited.params._authorization).toMatchObject({ profileAttenuated: true, attenuationAccepted: true });
    // …or summon: save it unaccepted and route the request it created.
    const draft = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'child',
      authorization: f.maintainer, draft: true, allowAttenuation: true });
    const request = await f.api.requestAuthorization(agent, { projectId: f.project.id,
      target: { kind: 'task', taskId: draft.id, queueAfterApproval: true }, authorization: f.maintainer, audience: ['@maintainers'] });
    expect([...request.recipients].sort()).toEqual(['admin', 'maint', 'owner']);
    expect(request.requestedBy).toBe(`task-agent:${f.parent.id}:do`);

    // Only the task's creator routes its request; another task's agent cannot.
    const stranger = await f.store.createTask({ projectId: f.project.id, title: 'Other', workflow: 'software-dev',
      workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'other' } });
    await expect(f.api.requestAuthorization(await f.agentOf(stranger.id), { projectId: f.project.id,
      target: { kind: 'task', taskId: draft.id }, authorization: f.maintainer, audience: ['@maintainers'] }))
      .rejects.toThrow(/only the task creator/);
  });

  it('is refused the same way when it edits a task authorization', async () => {
    const f = await fixture();
    const agent = await f.agentOf(f.parent.id);
    const draft = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'child', draft: true });
    const refusal = await f.api.setTaskAuthorization(agent, draft.id, f.maintainer).catch((error) => error);
    expect(refusal).toBeInstanceOf(AuthorizationGrantError);
    expect(refusal.gap).toMatchObject({ summon: '@maintainers' });
    expect(refusal.message).toMatch(/acceptAttenuation/);
  });

  it('asks the summoned level when request_permission names no audience', async () => {
    const f = await fixture();
    await f.store.saveView(f.parent.id, { taskId: f.parent.id, title: 'Parent', workflow: 'software-dev', stage: 'do',
      status: 'active', messages: [], actions: [], state: {}, updatedAt: 1 } as TaskView);
    const requested = await f.api.requestPermission(await f.agentOf(f.parent.id, ['task:escalate', 'task:read']), {
      capabilities: ['organization:member:write'], reason: 'Invite the new contractor.' });
    expect(requested).toMatchObject({ status: 'needs_approval', audience: ['@admins'] });
    expect((await f.store.getTask(f.parent.id))!.lastView).toMatchObject({ waitingFor: { kind: 'human', audience: ['@admins'] } });
  });

  it('lists the level audiences among its escalation targets', async () => {
    const f = await fixture();
    const targets = await f.api.humanEscalationTargets(await f.agentOf(f.parent.id, ['task:escalate']));
    expect(targets.special).toEqual(expect.arrayContaining([
      { selector: '@maintainers', description: expect.stringMatching(/Project maintainer/) },
      { selector: '@admins', description: expect.stringMatching(/Administrator/) },
      { selector: '@superadmins', description: expect.stringMatching(/Super-administrator/) },
    ]));
  });
});
