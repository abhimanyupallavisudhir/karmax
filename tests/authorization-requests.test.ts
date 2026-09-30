import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { AuthorizationRequests } from '../src/platform/authorization-requests.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { avatarAuthorizationCapabilities } from '../src/platform/avatars.js';
import type { Avatar, AuthorizationSelection } from '../src/domain/types.js';

async function fixture(dbPath = ':memory:') {
  const store = (await Store.create(dbPath));
  (await store.claimPersonalOrganization('requester'));
  (await store.setOrganizationMembership('org_personal', 'approver', 'member'));
  (await store.setOrganizationMembership('org_personal', 'limited', 'member'));
  const project = (await store.createProject('Delegation'));
  const authorization = (await AuthorizationService.create(store));
  (await authorization.grant('system:test', {
    principalId: 'user:requester', scopeKey: projectScope(project.id), profileId: 'developer',
  }));
  (await authorization.grant('system:test', {
    principalId: 'user:limited', scopeKey: projectScope(project.id), profileId: 'developer',
  }));
  (await authorization.grant('system:test', {
    principalId: 'user:approver', scopeKey: projectScope(project.id), profileId: 'maintainer',
  }));
  const team = (await store.createTeam({ organizationId: 'org_personal', projectId: project.id, name: 'Leads' }));
  (await store.setTeamMembership(team.id, 'limited'));
  (await store.setTeamMembership(team.id, 'approver'));
  const tokens = new TokenAuthority(store);
  const tokenFor = async (userId: string) => (await tokens.mintPrincipal(
    `user:${userId}`, (await authorization.capabilities(`user:${userId}`, project.id, 'org_personal')),
    project.id, undefined, 'org_personal',
  )).token;
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const requested: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  return { store, project, authorization, tokens, tokenFor, api, team, requested };
}

describe('initial authorization delegation requests', () => {
  it.each(['approve', 'deny', 'dismiss'] as const)('rejects a second gateway %s while approval is applying', async (action) => {
    const f = await fixture();
    const task = await f.store.createTask({ projectId: f.project.id, title: 'Contended', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { draft: true, prompt: 'work' } });
    const request = await new AuthorizationRequests(f.store, 'org_personal').request({ projectId: f.project.id,
      target: { kind: 'task', taskId: task.id }, authorization: f.requested, capabilities: [],
      missingCapabilities: [], audience: ['user:approver'], recipients: ['approver'], reason: 'Access', requestedBy: 'user:requester' });
    const second = new KarmaxApi({ store: f.store, tokens: f.tokens, authorization: f.authorization,
      client: {} as any, taskQueue: 'test' });
    const token = await f.tokenFor('approver');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = f.api.setTaskAuthorization.bind(f.api);
    vi.spyOn(f.api, 'setTaskAuthorization').mockImplementation(async (...args) => {
      entered();
      await blocked;
      return original(...args);
    });
    const first = f.api.resolveAuthorizationRequest(token, { organizationId: 'org_personal', requestId: request.id, action: 'approve' });
    await started;
    try {
      await expect(second.resolveAuthorizationRequest(token, {
        organizationId: 'org_personal', requestId: request.id, action,
      })).rejects.toThrow(/in progress/);
    } finally {
      release();
      await first;
    }
    expect((await new AuthorizationRequests(f.store, 'org_personal').requests())[0]).toMatchObject({ status: 'granted' });
  });

  it('retains a durable claim across restart and never times out a possibly partial approval', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authorization-claim-'));
    let store: Store | undefined;
    try {
      const f = await fixture(path.join(root, 'store.sqlite'));
      store = f.store;
      const service = new AuthorizationRequests(store, 'org_personal');
      const request = await service.request({ projectId: f.project.id,
        target: { kind: 'avatar', avatarId: 'avatar_pending' }, authorization: f.requested,
        capabilities: [], missingCapabilities: [], audience: ['user:approver'], recipients: ['approver'],
        reason: 'Access', requestedBy: 'user:requester' });
      const claim = await service.claim(request.id, 'approve', 'user:approver');
      await store.close();
      store = await Store.create(path.join(root, 'store.sqlite'));
      const restarted = new AuthorizationRequests(store, 'org_personal');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000);
      try {
        await expect(restarted.claim(request.id, 'approve', 'user:approver')).rejects.toThrow(/in progress/);
        await expect(restarted.resolve(request.id, 'deny', 'user:approver')).rejects.toThrow(/in progress/);
        await expect(restarted.resolve(request.id, 'approve', 'user:other', claim)).rejects.toThrow(/in progress/);
        await expect(restarted.resolve(request.id, 'approve', 'user:approver', 'wrong')).rejects.toThrow(/in progress/);
        await expect(restarted.resolve(request.id, 'approve', 'user:approver', claim)).resolves.toMatchObject({ status: 'granted' });
        await expect(restarted.claim(request.id, 'approve', 'user:approver')).rejects.toThrow(/already granted/);
      } finally { clock.mockRestore(); }
    } finally {
      await store?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dismisses without changing authorization and permits a later denial', async () => {
    const f = (await fixture());
    const task = (await f.store.createTask({ projectId: f.project.id, title: 'Pending', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { draft: true, prompt: 'work' } }));
    const service = new AuthorizationRequests(f.store, 'org_personal');
    const request = (await service.request({ projectId: f.project.id, target: { kind: 'task', taskId: task.id },
      authorization: f.requested, capabilities: [], missingCapabilities: [], audience: ['user:approver'],
      recipients: ['approver'], reason: 'More access', requestedBy: 'user:requester' }));
    await expect(f.api.resolveAuthorizationRequest((await f.tokenFor('limited')), { organizationId: 'org_personal',
      requestId: request.id, action: 'dismiss' })).rejects.toThrow(/not routed/);
    await expect(f.api.resolveAuthorizationRequest((await f.tokenFor('approver')), { organizationId: 'org_personal',
      requestId: request.id, action: 'dismiss' })).resolves.toMatchObject({ status: 'pending', dismissed: { by: 'user:approver' } });
    expect((await f.store.getTask(task.id))?.params).toEqual({ draft: true, prompt: 'work' });
    await expect(f.api.resolveAuthorizationRequest((await f.tokenFor('approver')), { organizationId: 'org_personal',
      requestId: request.id, action: 'deny' })).resolves.toMatchObject({ status: 'denied' });
  });

  it.each(['human', 'delegated-agent'])('%s routes and resolves authorization with the complete granted package', async (kind) => {
    const f = (await fixture());
    const tokenFor = async (userId: string) => {
      const human = (await f.tokenFor(userId));
      if (kind === 'human') return human;
      const taskId = `delegate-${userId}`;
      const delegation = (await f.tokens.delegateHuman(human, { taskId, projectId: f.project.id, organizationId: 'org_personal' }))!;
      const caps = (await f.tokens.verify(human))!.caps;
      return (await f.tokens.mint({ taskId, profileId: 'do', principal: `user:${userId}`, projectId: f.project.id,
        organizationId: 'org_personal', ceiling: caps, grantorCaps: caps, delegationId: delegation.id })).token;
    };
    const task = (await f.store.createTask({
      projectId: f.project.id, title: 'Protected work', workflow: 'just-do', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'requester' },
      params: { prompt: 'work', draft: true, _authorization: {
        ...(await f.authorization.taskGrant('user:requester', f.project.id, f.requested)),
        principal: 'user:requester', attenuationAccepted: false,
      } },
    }));
    const targets = (await f.api.authorizationEscalationTargets((await tokenFor('requester')), {
      projectId: f.project.id, authorization: f.requested,
    }));
    expect(targets.users.map((user) => user.id)).toContain('approver');
    expect(targets.users.map((user) => user.id)).not.toContain('limited');
    expect(targets.teams).toEqual([
      expect.objectContaining({ id: f.team.id, eligibleUserIds: ['approver'] }),
    ]);
    expect(targets.missingCapabilities.length).toBeGreaterThan(0);

    const request = await f.api.requestAuthorization((await tokenFor('requester')), {
      projectId: f.project.id,
      target: { kind: 'task', taskId: task.id },
      authorization: f.requested,
      audience: [`@team:${f.team.slug}`],
      reason: 'The task needs maintainer access.',
    });
    expect(request.recipients).toEqual(['approver']);
    expect((await f.store.listInbox('approver', 'org_personal'))).toEqual([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested' }),
    ]);
    expect((await f.store.listInbox('limited', 'org_personal'))).toEqual([]);

    await f.api.resolveAuthorizationRequest((await tokenFor('approver')), {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect((await f.store.getTask(task.id))?.params._authorization).toMatchObject({
      level: 'maintainer', attenuated: false, principal: 'user:approver',
    });
    expect((await f.store.listInbox('approver', 'org_personal'))).toEqual([]);
  });

  it('applies an approved Avatar delegation without elevating its owner', async () => {
    const f = (await fixture());
    const now = Date.now();
    const limited = (await f.authorization.taskGrant('user:requester', f.project.id, f.requested));
    const avatar: Avatar = {
      id: 'avatar_pending', organizationId: 'org_personal', projectId: f.project.id,
      ownerUserId: 'requester', name: 'Atlas', prompt: 'Act carefully.', promptVersion: 1,
      enabled: false, authorityMode: 'restricted',
      authorization: { ...limited, capabilities: [...limited.capabilities, 'use-credential:item:cred_safe'],
        principal: 'user:requester' }, callableBy: ['user:requester'],
      roles: [], runtime: { provider: 'mock' }, createdAt: now, updatedAt: now,
    };
    (await f.store.upsertAvatar(avatar));
    const request = await f.api.requestAuthorization((await f.tokenFor('requester')), {
      projectId: f.project.id,
      target: { kind: 'avatar', avatarId: avatar.id, enableAfterApproval: true },
      authorization: f.requested,
      audience: ['user:approver'],
    });
    expect((await f.store.listInbox('approver', 'org_personal'))[0]).toMatchObject({
      subject: { kind: 'avatar-authorization', avatarId: avatar.id, requestId: request.id },
    });
    expect((await f.store.claimDelivery())?.inbox).toMatchObject({
      subject: { kind: 'avatar-authorization', avatarId: avatar.id, requestId: request.id },
    });

    await f.api.resolveAuthorizationRequest((await f.tokenFor('approver')), {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect((await f.store.getAvatar(avatar.id))).toMatchObject({
      enabled: true,
      authorization: { level: 'maintainer', attenuated: false, principal: 'user:approver',
        capabilities: expect.arrayContaining(['use-credential:item:cred_safe']) },
    });
    expect((await f.authorization.capabilities('user:requester', f.project.id))).not.toContain('project:edit');
    expect((await f.store.listInbox('approver', 'org_personal'))).toEqual([]);
  });

  it('lets an authorizer Avatar approve a task without retaining the requester human delegation', async () => {
    const f = (await fixture());
    const task = await f.api.createTask((await f.tokenFor('requester')), {
      projectId: f.project.id, workflow: 'just-do', prompt: 'protected work', draft: true,
      authorization: f.requested, allowAttenuation: true,
    });
    expect(task.params._authorization).toMatchObject({
      profileAttenuated: true, attenuationAccepted: false, principal: 'user:requester',
    });
    (await f.store.updateTaskParams(task.id, { ...task.params, _authorization: {
      ...(task.params._authorization as object),
      capabilities: [...(task.params._authorization as { capabilities: string[] }).capabilities,
        'use-credential:item:cred_safe'],
    } }));
    await expect(f.api.queueTask((await f.tokenFor('requester')), task.id)).rejects.toThrow(/cannot grant/i);
    const avatarAuthorization = (await f.authorization.taskGrant('user:approver', f.project.id, f.requested));
    const now = Date.now();
    const authorizer: Avatar = {
      id: 'avatar_authorizer', organizationId: 'org_personal', projectId: f.project.id,
      ownerUserId: 'approver', name: 'Gatekeeper', prompt: 'Approve carefully.', promptVersion: 1,
      enabled: true, authorityMode: 'restricted', roles: ['authorize'], callableBy: ['user:requester'],
      authorization: { ...avatarAuthorization, principal: 'user:approver' },
      runtime: { provider: 'mock' }, createdAt: now, updatedAt: now,
    };
    (await f.store.kvSet(`avatars:project:${f.project.id}`, 'enabled'));
    (await f.store.upsertAvatar(authorizer));
    const request = await f.api.requestAuthorization((await f.tokenFor('requester')), {
      projectId: f.project.id, target: { kind: 'task', taskId: task.id },
      authorization: f.requested, audience: [`avatar:${authorizer.id}`],
    });
    const avatarToken = (await f.tokens.mint({
      taskId: 'authorization-decision-task', profileId: 'authorizer', role: 'do',
      principal: `avatar:${authorizer.id}`, projectIds: [f.project.id], organizationId: 'org_personal',
      ceiling: authorizer.authorization.capabilities, grantorCaps: authorizer.authorization.capabilities,
    })).token;

    await f.api.resolveAuthorizationRequest(avatarToken, {
      organizationId: 'org_personal', requestId: request.id, action: 'approve',
    });
    expect((await f.store.getTask(task.id))?.params._authorization).toMatchObject({
      level: 'maintainer', attenuated: false, principal: `avatar:${authorizer.id}`,
      capabilities: expect.arrayContaining(['use-credential:item:cred_safe']),
    });
    expect(((await f.store.getTask(task.id))?.params._authorization as { delegationId?: string }).delegationId).toBeUndefined();

    const delegatedAvatar: Avatar = {
      ...authorizer, id: 'avatar_delegated', name: 'Delegate',
      authorization: { ...avatarAuthorization, principal: `avatar:${authorizer.id}` },
    };
    (await f.store.upsertAvatar(delegatedAvatar));
    expect((await avatarAuthorizationCapabilities(f.store, f.authorization, delegatedAvatar, f.project.id)))
      .toEqual(expect.arrayContaining(avatarAuthorization.capabilities));
    (await f.store.upsertAvatar({ ...authorizer, enabled: false, updatedAt: Date.now() }));
    expect((await avatarAuthorizationCapabilities(f.store, f.authorization, delegatedAvatar, f.project.id))).toEqual([]);
  });

  it('deduplicates pending requests per target and records a durable decision', async () => {
    const f = (await fixture());
    const service = new AuthorizationRequests(f.store, 'org_personal');
    const input = {
      projectId: f.project.id,
      target: { kind: 'avatar' as const, avatarId: 'avatar_1' },
      authorization: f.requested,
      capabilities: ['project:read', 'project:edit'],
      missingCapabilities: ['project:edit'],
      audience: ['user:approver'], recipients: ['approver'], reason: 'Needed.', requestedBy: 'user:requester',
    };
    const first = (await service.request(input));
    expect((await service.request({ ...input, reason: 'Duplicate.' })).id).toBe(first.id);
    expect((await service.resolve(first.id, 'deny', 'user:approver'))).toMatchObject({
      status: 'denied', resolution: { action: 'deny', by: 'user:approver' },
    });
  });
});
