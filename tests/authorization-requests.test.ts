import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { AuthorizationRequests } from '../src/platform/authorization-requests.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { avatarAuthorizationCapabilities } from '../src/platform/avatars.js';
import type { Avatar, AuthorizationSelection } from '../src/domain/types.js';

function fixture() {
  const store = new Store(':memory:');
  store.claimPersonalOrganization('requester');
  store.setOrganizationMembership('org_personal', 'approver', 'member');
  store.setOrganizationMembership('org_personal', 'limited', 'member');
  const project = store.createProject('Delegation');
  const authorization = new AuthorizationService(store);
  authorization.grant('system:test', {
    principalId: 'user:requester', scopeKey: projectScope(project.id), profileId: 'developer',
  });
  authorization.grant('system:test', {
    principalId: 'user:limited', scopeKey: projectScope(project.id), profileId: 'developer',
  });
  authorization.grant('system:test', {
    principalId: 'user:approver', scopeKey: projectScope(project.id), profileId: 'maintainer',
  });
  const team = store.createTeam({ organizationId: 'org_personal', projectId: project.id, name: 'Leads' });
  store.setTeamMembership(team.id, 'limited');
  store.setTeamMembership(team.id, 'approver');
  const tokens = new TokenAuthority(store);
  const tokenFor = (userId: string) => tokens.mintPrincipal(
    `user:${userId}`, authorization.capabilities(`user:${userId}`, project.id, 'org_personal'),
    project.id, undefined, 'org_personal',
  ).token;
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const requested: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  return { store, project, authorization, tokens, tokenFor, api, team, requested };
}

describe('initial authorization delegation requests', () => {
  it.each(['human', 'delegated-agent'])('%s routes and resolves authorization with the complete granted package', async (kind) => {
    const f = fixture();
    const tokenFor = (userId: string) => {
      const human = f.tokenFor(userId);
      if (kind === 'human') return human;
      const taskId = `delegate-${userId}`;
      const delegation = f.tokens.delegateHuman(human, { taskId, projectId: f.project.id, organizationId: 'org_personal' })!;
      const caps = f.tokens.verify(human)!.caps;
      return f.tokens.mint({ taskId, profileId: 'do', principal: `user:${userId}`, projectId: f.project.id,
        organizationId: 'org_personal', ceiling: caps, grantorCaps: caps, delegationId: delegation.id }).token;
    };
    const task = f.store.createTask({
      projectId: f.project.id, title: 'Protected work', workflow: 'just-do', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'requester' },
      params: { prompt: 'work', draft: true, _authorization: {
        ...f.authorization.taskGrant('user:requester', f.project.id, f.requested),
        principal: 'user:requester', attenuationAccepted: false,
      } },
    });
    const targets = f.api.authorizationEscalationTargets(tokenFor('requester'), {
      projectId: f.project.id, authorization: f.requested,
    });
    expect(targets.users.map((user) => user.id)).toContain('approver');
    expect(targets.users.map((user) => user.id)).not.toContain('limited');
    expect(targets.teams).toEqual([
      expect.objectContaining({ id: f.team.id, eligibleUserIds: ['approver'] }),
    ]);
    expect(targets.missingCapabilities.length).toBeGreaterThan(0);

    const request = await f.api.requestAuthorization(tokenFor('requester'), {
      projectId: f.project.id,
      target: { kind: 'task', taskId: task.id },
      authorization: f.requested,
      audience: [`@team:${f.team.slug}`],
      reason: 'The task needs maintainer access.',
    });
    expect(request.recipients).toEqual(['approver']);
    expect(f.store.listInbox('approver', 'org_personal')).toEqual([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested' }),
    ]);
    expect(f.store.listInbox('limited', 'org_personal')).toEqual([]);

    await f.api.resolveAuthorizationRequest(tokenFor('approver'), {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect(f.store.getTask(task.id)?.params._authorization).toMatchObject({
      level: 'maintainer', attenuated: false, principal: 'user:approver',
    });
    expect(f.store.listInbox('approver', 'org_personal')).toEqual([]);
  });

  it('applies an approved Avatar delegation without elevating its owner', async () => {
    const f = fixture();
    const now = Date.now();
    const limited = f.authorization.taskGrant('user:requester', f.project.id, f.requested);
    const avatar: Avatar = {
      id: 'avatar_pending', organizationId: 'org_personal', projectId: f.project.id,
      ownerUserId: 'requester', name: 'Atlas', prompt: 'Act carefully.', promptVersion: 1,
      enabled: false, authorityMode: 'restricted',
      authorization: { ...limited, capabilities: [...limited.capabilities, 'use-credential:item:cred_safe'],
        principal: 'user:requester' }, callableBy: ['user:requester'],
      roles: [], runtime: { provider: 'mock' }, createdAt: now, updatedAt: now,
    };
    f.store.upsertAvatar(avatar);
    const request = await f.api.requestAuthorization(f.tokenFor('requester'), {
      projectId: f.project.id,
      target: { kind: 'avatar', avatarId: avatar.id, enableAfterApproval: true },
      authorization: f.requested,
      audience: ['user:approver'],
    });
    expect(f.store.listInbox('approver', 'org_personal')[0]).toMatchObject({
      subject: { kind: 'avatar-authorization', avatarId: avatar.id, requestId: request.id },
    });
    expect(f.store.claimDelivery()?.inbox).toMatchObject({
      subject: { kind: 'avatar-authorization', avatarId: avatar.id, requestId: request.id },
    });

    await f.api.resolveAuthorizationRequest(f.tokenFor('approver'), {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect(f.store.getAvatar(avatar.id)).toMatchObject({
      enabled: true,
      authorization: { level: 'maintainer', attenuated: false, principal: 'user:approver',
        capabilities: expect.arrayContaining(['use-credential:item:cred_safe']) },
    });
    expect(f.authorization.capabilities('user:requester', f.project.id)).not.toContain('project:edit');
    expect(f.store.listInbox('approver', 'org_personal')).toEqual([]);
  });

  it('lets an authorizer Avatar approve a task without retaining the requester human delegation', async () => {
    const f = fixture();
    const task = await f.api.createTask(f.tokenFor('requester'), {
      projectId: f.project.id, workflow: 'just-do', prompt: 'protected work', draft: true,
      authorization: f.requested, allowAttenuation: true,
    });
    expect(task.params._authorization).toMatchObject({
      profileAttenuated: true, attenuationAccepted: false, principal: 'user:requester',
    });
    f.store.updateTaskParams(task.id, { ...task.params, _authorization: {
      ...(task.params._authorization as object),
      capabilities: [...(task.params._authorization as { capabilities: string[] }).capabilities,
        'use-credential:item:cred_safe'],
    } });
    await expect(f.api.queueTask(f.tokenFor('requester'), task.id)).rejects.toThrow(/cannot grant/i);
    const avatarAuthorization = f.authorization.taskGrant('user:approver', f.project.id, f.requested);
    const now = Date.now();
    const authorizer: Avatar = {
      id: 'avatar_authorizer', organizationId: 'org_personal', projectId: f.project.id,
      ownerUserId: 'approver', name: 'Gatekeeper', prompt: 'Approve carefully.', promptVersion: 1,
      enabled: true, authorityMode: 'restricted', roles: ['authorize'], callableBy: ['user:requester'],
      authorization: { ...avatarAuthorization, principal: 'user:approver' },
      runtime: { provider: 'mock' }, createdAt: now, updatedAt: now,
    };
    f.store.kvSet(`avatars:project:${f.project.id}`, 'enabled');
    f.store.upsertAvatar(authorizer);
    const request = await f.api.requestAuthorization(f.tokenFor('requester'), {
      projectId: f.project.id, target: { kind: 'task', taskId: task.id },
      authorization: f.requested, audience: [`avatar:${authorizer.id}`],
    });
    const avatarToken = f.tokens.mint({
      taskId: 'authorization-decision-task', profileId: 'authorizer', role: 'do',
      principal: `avatar:${authorizer.id}`, projectIds: [f.project.id], organizationId: 'org_personal',
      ceiling: authorizer.authorization.capabilities, grantorCaps: authorizer.authorization.capabilities,
    }).token;

    await f.api.resolveAuthorizationRequest(avatarToken, {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect(f.store.getTask(task.id)?.params._authorization).toMatchObject({
      level: 'maintainer', attenuated: false, principal: `avatar:${authorizer.id}`,
      capabilities: expect.arrayContaining(['use-credential:item:cred_safe']),
    });
    expect((f.store.getTask(task.id)?.params._authorization as { delegationId?: string }).delegationId).toBeUndefined();

    const delegatedAvatar: Avatar = {
      ...authorizer, id: 'avatar_delegated', name: 'Delegate',
      authorization: { ...avatarAuthorization, principal: `avatar:${authorizer.id}` },
    };
    f.store.upsertAvatar(delegatedAvatar);
    expect(avatarAuthorizationCapabilities(f.store, f.authorization, delegatedAvatar, f.project.id))
      .toEqual(expect.arrayContaining(avatarAuthorization.capabilities));
    f.store.upsertAvatar({ ...authorizer, enabled: false, updatedAt: Date.now() });
    expect(avatarAuthorizationCapabilities(f.store, f.authorization, delegatedAvatar, f.project.id)).toEqual([]);
  });

  it('deduplicates pending requests per target and records a durable decision', () => {
    const f = fixture();
    const service = new AuthorizationRequests(f.store, 'org_personal');
    const input = {
      projectId: f.project.id,
      target: { kind: 'avatar' as const, avatarId: 'avatar_1' },
      authorization: f.requested,
      capabilities: ['project:read', 'project:edit'],
      missingCapabilities: ['project:edit'],
      audience: ['user:approver'], recipients: ['approver'], reason: 'Needed.', requestedBy: 'user:requester',
    };
    const first = service.request(input);
    expect(service.request({ ...input, reason: 'Duplicate.' }).id).toBe(first.id);
    expect(service.resolve(first.id, 'deny', 'user:approver')).toMatchObject({
      status: 'denied', resolution: { action: 'deny', by: 'user:approver' },
    });
  });
});
