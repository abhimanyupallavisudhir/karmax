import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import type { Avatar } from '../src/domain/types.js';
import { applyAvatarProfile, avatarCallableBy, avatarEnabled, avatarForRole } from '../src/platform/avatars.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';

describe('Avatars', () => {
  let store: Store;
  let projectId: string;
  let avatar: Avatar;

  beforeEach(() => {
    store = new Store(':memory:');
    const project = store.createProject('Avatar project');
    projectId = project.id;
    store.setOrganizationMembership(project.organizationId!, 'owner', 'owner');
    store.setOrganizationMembership(project.organizationId!, 'caller', 'member');
    store.setProjectMembership(projectId, { kind: 'user', userId: 'caller' }, 'member');
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
    store.upsertAvatar(avatar);
  });

  it('persists owner-controlled identities and applies both kill switches', () => {
    expect(store.getAvatar(avatar.id)).toMatchObject({ name: 'Atlas', ownerUserId: 'owner' });
    expect(avatarCallableBy(store, avatar, 'caller')).toBe(true);
    expect(avatarEnabled(store, avatar)).toBe(true);

    store.kvSet(`avatars:project:${projectId}`, 'disabled');
    expect(store.avatarAvailability(projectId)).toMatchObject({ project: 'disabled', effective: false });
    expect(avatarEnabled(store, avatar)).toBe(false);

    store.kvSet(`avatars:project:${projectId}`, 'enabled');
    store.kvSet(`avatars:organization:${avatar.organizationId}`, 'disabled');
    expect(store.avatarAvailability(projectId)).toMatchObject({ organization: false, effective: false });
  });

  it('uses an Avatar prompt and runtime for a selected workflow role', () => {
    const selected = avatarForRole(store, { projectId, agents: {
      do: { avatarId: avatar.id, provider: 'claude' },
    } }, 'do');
    const profile = applyAvatarProfile({
      id: 'do-default', name: 'Do', role: 'do', provider: 'claude',
      promptTemplate: 'Workflow contract', capabilities: [],
    }, { avatarId: avatar.id, provider: 'claude' }, selected);
    expect(profile).toMatchObject({ id: `avatar:${avatar.id}:do`, name: 'Atlas', provider: 'codex', model: 'gpt-5' });
    expect(profile.promptTemplate).toContain('# Task');
    expect(profile.promptTemplate).toContain('Exercise the owner’s judgment.');
  });

  it('supports an Avatar-only permission route without inventing a human recipient', () => {
    const service = new PermissionRequests(store, avatar.organizationId);
    const request = service.request({
      taskId: 'task_1', projectId, role: 'do', capabilities: ['task:edit'],
      audience: [`avatar:${avatar.id}`], recipients: [], avatarRecipients: [avatar.id],
      reason: 'The task needs its trusted delegate.', requestedBy: 'task-agent:task_1:do',
    });
    expect(request.recipients).toEqual([]);
    expect(request.avatarRecipients).toEqual([avatar.id]);
    expect(service.resolve(request.id, { action: 'approve', by: `avatar:${avatar.id}` }).status).toBe('granted');
    expect(service.extensionCaps('task_1', 'do')).toContain('task:edit');
  });

  it('preserves Avatar provenance while routing creator responsibilities to its owner', () => {
    const task = store.createTask({ projectId, title: 'Delegated task', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'Do the delegated work.' }, createdBy: { kind: 'avatar', avatarId: avatar.id } });
    expect(task.createdBy).toEqual({ kind: 'avatar', avatarId: avatar.id });
    expect(store.taskCreatorUserId(task.id)).toBe('owner');
    expect(store.humanAudience(task.id, ['@creator'])).toEqual(['owner']);
  });
});
