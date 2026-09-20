import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';

describe('agent permission approval requests', () => {
  it('deduplicates pending requests and extends the task only after approval', async () => {
    const store = (await Store.create(':memory:'));
    const requests = new PermissionRequests(store, 'org_personal');
    const input = {
      taskId: 'task_1',
      projectId: 'project_1',
      role: 'do',
      capabilities: ['settings:read'],
      audience: ['@creator'],
      recipients: ['operator'],
      reason: 'Inspect outbound email configuration.',
      requestedBy: 'task-agent:task_1:do',
    };

    const first = (await requests.request(input));
    const duplicate = (await requests.request(input));
    expect(duplicate.id).toBe(first.id);
    expect((await requests.extensionCaps('task_1', 'do'))).toEqual([]);

    const granted = (await requests.resolve(first.id, { action: 'approve', by: 'user:operator' }));
    expect(granted).toMatchObject({
      status: 'granted',
      resolution: { action: 'approve', by: 'user:operator' },
    });
    expect((await requests.extensionCaps('task_1', 'do'))).toEqual(['settings:read']);
    expect((await requests.extensionCaps('task_1', 'merge'))).toEqual([]);
  });

  it('deduplicates project requests by scope and permits scope-only requests', async () => {
    const service = new PermissionRequests((await Store.create(':memory:')), 'org_personal');
    const input = { taskId: 'task', projectId: 'home', role: 'do', capabilities: [],
      projectIds: ['second'], audience: ['@owners'], recipients: ['owner'],
      reason: 'Read phase work.', requestedBy: 'task-agent:task:do' };
    const first = (await service.request(input));
    expect((await service.request(input)).id).toBe(first.id);
    expect((await service.request({ ...input, projectIds: ['third'] })).id).not.toBe(first.id);
    expect((await service.resolve(first.id, { action: 'deny', by: 'user:owner' })).projectIds).toEqual(['second']);
    expect((await service.extensionCaps('task'))).toEqual([]);
  });

  it('rejects wildcard and unknown capability requests', async () => {
    const requests = new PermissionRequests((await Store.create(':memory:')), 'org_personal');
    const base = {
      taskId: 'task_1',
      projectId: 'project_1',
      role: 'do',
      audience: ['@owners'],
      recipients: ['owner'],
      reason: 'Need more access.',
      requestedBy: 'task-agent:task_1:do',
    };
    await expect((async () => (await requests.request({ ...base, capabilities: ['settings:*'] })))()).rejects.toThrow(/exact capabilities/i);
    await expect((async () => (await requests.request({ ...base, capabilities: ['totally:invented'] })))()).rejects.toThrow(/unknown capability/i);
  });

  it('removes pending requests and approved extensions with their task', async () => {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('owner'));
    const project = (await store.createProject('Cleanup'));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'Temporary',
      workflow: 'just-do',
      workflowVersion: '1.0.0',
      params: { prompt: 'temporary', command: 'true', draft: true },
    }));
    const requests = new PermissionRequests(store, 'org_personal');
    const request = (await requests.request({
      taskId: task.id,
      projectId: project.id,
      role: 'do',
      capabilities: ['settings:read'],
      audience: ['@owners'],
      recipients: ['owner'],
      reason: 'Temporary request.',
      requestedBy: `task-agent:${task.id}:do`,
    }));
    (await requests.resolve(request.id, { action: 'approve', by: 'user:owner' }));

    (await store.deleteTask(task.id));
    expect((await requests.requests({ taskId: task.id }))).toEqual([]);
    expect((await requests.extensionCaps(task.id, 'do'))).toEqual([]);
  });
});
