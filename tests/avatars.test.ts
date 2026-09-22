import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import type { Avatar } from '../src/domain/types.js';
import { applyAvatarProfile, avatarCallableBy, avatarEnabled, avatarForRole } from '../src/platform/avatars.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';

describe('Avatars', () => {
  let store: Store;
  let projectId: string;
  let avatar: Avatar;

  beforeEach(async () => {
    store = (await Store.create(':memory:'));
    const project = (await store.createProject('Avatar project'));
    projectId = project.id;
    (await store.setOrganizationMembership(project.organizationId!, 'owner', 'owner'));
    (await store.setOrganizationMembership(project.organizationId!, 'caller', 'member'));
    (await store.setProjectMembership(projectId, { kind: 'user', userId: 'caller' }, 'member'));
    const now = Date.now();
    avatar = {
      id: 'avatar_atlas', organizationId: project.organizationId!, projectId,
      ownerUserId: 'owner', name: 'Atlas', purpose: 'Trusted delegate',
      prompt: 'Exercise the owner’s judgment.', promptVersion: 1, enabled: true,
      authorityMode: 'full', authorization: {
        level: 'full', profileId: 'full', scope: 'projects', projectIds: [projectId],
        organizationId: project.organizationId, capabilities: ['*'],
      },
      callableBy: ['@project'], roles: [], runtime: { provider: 'codex', model: 'gpt-5' },
      createdAt: now, updatedAt: now,
    };
    (await store.upsertAvatar(avatar));
  });

  it.each([undefined, 'enabled', 'disabled'] as const)('resolves all project overrides with organization %s', async (organization) => {
    if (organization) (await store.kvSet(`avatars:organization:${avatar.organizationId}`, organization));
    for (const project of ['inherit', 'enabled', 'disabled'] as const) {
      (await store.kvSet(`avatars:project:${projectId}`, project));
      const effective = project === 'inherit' ? organization === 'enabled' : project === 'enabled';
      expect((await store.avatarAvailability(projectId))).toEqual({ organization: organization === 'enabled', project, effective });
      expect((await avatarEnabled(store, avatar))).toBe(effective);
      const task = { projectId, agents: { do: { avatarId: avatar.id, provider: 'mock' as const } } };
      if (effective) expect((await avatarForRole(store, task, 'do'))).toMatchObject({ id: avatar.id });
      else await expect((async () => (await avatarForRole(store, task, 'do')))()).rejects.toThrow('disabled');
      expect((await store.getAvatar(avatar.id))).toMatchObject({ name: 'Atlas', enabled: true });
    }
  });

  it('defaults off without changing stored identities', async () => {
    expect((await store.avatarAvailability(projectId))).toEqual({ organization: false, project: 'inherit', effective: false });
    expect((await avatarEnabled(store, avatar))).toBe(false);
    expect((await avatarCallableBy(store, avatar, 'caller'))).toBe(true);
    expect((await store.getAvatar(avatar.id))).toMatchObject({ enabled: true });
  });

  it('uses an Avatar prompt and runtime for a selected workflow role', async () => {
    (await store.kvSet(`avatars:project:${projectId}`, 'enabled'));
    const selected = (await avatarForRole(store, { projectId, agents: {
      do: { avatarId: avatar.id, provider: 'claude' },
    } }, 'do'));
    const profile = applyAvatarProfile({
      id: 'do-default', name: 'Do', role: 'do', provider: 'claude',
      promptTemplate: 'Workflow contract', capabilities: [],
    }, { avatarId: avatar.id, provider: 'claude' }, selected);
    expect(profile).toMatchObject({ id: `avatar:${avatar.id}:do`, name: 'Atlas', provider: 'codex', model: 'gpt-5' });
    expect(profile.promptTemplate).toContain('# Task');
    expect(profile.promptTemplate).toContain('Exercise the owner’s judgment.');
  });

  it('supports an Avatar-only permission route without inventing a human recipient', async () => {
    const service = new PermissionRequests(store, avatar.organizationId);
    const request = (await service.request({
      taskId: 'task_1', projectId, role: 'do', capabilities: ['task:edit'],
      audience: [`avatar:${avatar.id}`], recipients: [], avatarRecipients: [avatar.id],
      reason: 'The task needs its trusted delegate.', requestedBy: 'task-agent:task_1:do',
    }));
    expect(request.recipients).toEqual([]);
    expect(request.avatarRecipients).toEqual([avatar.id]);
    expect((await service.resolve(request.id, { action: 'approve', by: `avatar:${avatar.id}` })).status).toBe('granted');
    expect((await service.extensionCaps('task_1', 'do'))).toContain('task:edit');
  });

  it('preserves Avatar provenance while routing creator responsibilities to its owner', async () => {
    const task = (await store.createTask({ projectId, title: 'Delegated task', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'Do the delegated work.' }, createdBy: { kind: 'avatar', avatarId: avatar.id } }));
    expect(task.createdBy).toEqual({ kind: 'avatar', avatarId: avatar.id });
    expect((await store.taskCreatorUserId(task.id))).toBe('owner');
    expect((await store.humanAudience(task.id, ['@creator']))).toEqual(['owner']);
  });
});
