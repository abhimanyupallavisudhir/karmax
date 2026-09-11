import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';

describe('agent permission approval requests', () => {
  it('deduplicates pending requests and extends the task only after approval', () => {
    const store = new Store(':memory:');
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

    const first = requests.request(input);
    const duplicate = requests.request(input);
    expect(duplicate.id).toBe(first.id);
    expect(requests.extensionCaps('task_1', 'do')).toEqual([]);

    const granted = requests.resolve(first.id, { action: 'approve', by: 'user:operator' });
    expect(granted).toMatchObject({
      status: 'granted',
      resolution: { action: 'approve', by: 'user:operator' },
    });
    expect(requests.extensionCaps('task_1', 'do')).toEqual(['settings:read']);
    expect(requests.extensionCaps('task_1', 'merge')).toEqual([]);
  });

  it('deduplicates project requests by scope and permits scope-only requests', () => {
    const service = new PermissionRequests(new Store(':memory:'), 'org_personal');
    const input = { taskId: 'task', projectId: 'home', role: 'do', capabilities: [],
      projectIds: ['second'], audience: ['@owners'], recipients: ['owner'],
      reason: 'Read phase work.', requestedBy: 'task-agent:task:do' };
    const first = service.request(input);
    expect(service.request(input).id).toBe(first.id);
    expect(service.request({ ...input, projectIds: ['third'] }).id).not.toBe(first.id);
    expect(service.resolve(first.id, { action: 'deny', by: 'user:owner' }).projectIds).toEqual(['second']);
    expect(service.extensionCaps('task')).toEqual([]);
  });

  it('rejects wildcard and unknown capability requests', () => {
    const requests = new PermissionRequests(new Store(':memory:'), 'org_personal');
    const base = {
      taskId: 'task_1',
      projectId: 'project_1',
      role: 'do',
      audience: ['@owners'],
      recipients: ['owner'],
      reason: 'Need more access.',
      requestedBy: 'task-agent:task_1:do',
    };
    expect(() => requests.request({ ...base, capabilities: ['settings:*'] })).toThrow(/exact capabilities/i);
    expect(() => requests.request({ ...base, capabilities: ['totally:invented'] })).toThrow(/unknown capability/i);
  });

  it('removes pending requests and approved extensions with their task', () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('owner');
    const project = store.createProject('Cleanup');
    const task = store.createTask({
      projectId: project.id,
      title: 'Temporary',
      workflow: 'just-do',
      workflowVersion: '1.0.0',
      params: { prompt: 'temporary', command: 'true', draft: true },
    });
    const requests = new PermissionRequests(store, 'org_personal');
    const request = requests.request({
      taskId: task.id,
      projectId: project.id,
      role: 'do',
      capabilities: ['settings:read'],
      audience: ['@owners'],
      recipients: ['owner'],
      reason: 'Temporary request.',
      requestedBy: `task-agent:${task.id}:do`,
    });
    requests.resolve(request.id, { action: 'approve', by: 'user:owner' });

    store.deleteTask(task.id);
    expect(requests.requests({ taskId: task.id })).toEqual([]);
    expect(requests.extensionCaps(task.id, 'do')).toEqual([]);
  });
});
