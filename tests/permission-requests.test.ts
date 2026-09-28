import { describe, expect, it, vi } from 'vitest';
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

  /** PL-8: a decision is claimed in the shared store, not in process memory, so
   *  two gateway replicas cannot apply an approval and a denial at once. */
  it('lets one decision at a time claim a request, across service instances', async () => {
    const store = (await Store.create(':memory:'));
    const replicaA = new PermissionRequests(store, 'org_personal');
    const replicaB = new PermissionRequests(store, 'org_personal');
    const request = (await replicaA.request({ taskId: 'task', projectId: 'home', role: 'do',
      capabilities: ['settings:read'], audience: ['@owners'], recipients: ['owner'],
      reason: 'Inspect settings.', requestedBy: 'task-agent:task:do' }));

    const claim = (await replicaA.claim(request.id));
    expect(claim).toEqual(expect.any(String));
    expect((await replicaB.claim(request.id))).toBeUndefined();
    await expect(replicaB.resolve(request.id, { action: 'deny', by: 'user:owner' })).rejects.toThrow(/in progress/);
    await expect(replicaB.dismiss(request.id, 'user:owner')).rejects.toThrow(/in progress/);
    // Releasing someone else's claim is a no-op.
    (await replicaB.release(request.id, 'not-the-claim'));
    expect((await replicaB.claim(request.id))).toBeUndefined();

    expect((await replicaA.resolve(request.id, { action: 'approve', by: 'user:owner', claim }))).toMatchObject({ status: 'granted' });
    expect((await replicaB.extensionCaps('task', 'do'))).toEqual(['settings:read']);
    // Resolving consumed the claim; the next request is free to be decided.
    const next = (await replicaA.request({ taskId: 'task', projectId: 'home', role: 'do',
      capabilities: ['settings:write'], audience: ['@owners'], recipients: ['owner'],
      reason: 'Change settings.', requestedBy: 'task-agent:task:do' }));
    const held = (await replicaA.claim(next.id));
    (await replicaA.release(next.id, held!));
    expect((await replicaB.claim(next.id))).toEqual(expect.any(String));
  });

  it('lets a claim abandoned by a crashed replica expire', async () => {
    const store = (await Store.create(':memory:'));
    const service = new PermissionRequests(store, 'org_personal');
    const request = (await service.request({ taskId: 'task', projectId: 'home', role: 'do',
      capabilities: ['settings:read'], audience: ['@owners'], recipients: ['owner'],
      reason: 'Inspect settings.', requestedBy: 'task-agent:task:do' }));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect((await service.claim(request.id))).toEqual(expect.any(String));
      clock.mockReturnValue(now + 60_000);
      expect((await service.claim(request.id))).toBeUndefined();
      clock.mockReturnValue(now + 10 * 60_000);
      expect((await service.claim(request.id))).toEqual(expect.any(String));
    } finally { clock.mockRestore(); }
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

  // PL-8: requests lived in one kv blob per organization, rewritten whole by
  // every ask and every decision and never pruned.
  describe('storage', () => {
    const ask = (taskId: string, capability = 'settings:read') => ({ taskId, projectId: 'home', role: 'do',
      capabilities: [capability], audience: ['@owners'], recipients: ['owner'], reason: 'Inspect settings.',
      requestedBy: `task-agent:${taskId}:do` });

    it('writes only the request an ask or a decision is about', async () => {
      const store = (await Store.create(':memory:'));
      const service = new PermissionRequests(store, 'org_personal');
      const first = (await service.request(ask('task_a')));
      (await service.request(ask('task_b')));
      const written: string[] = [];
      const kvSet = store.kvSet.bind(store);
      vi.spyOn(store, 'kvSet').mockImplementation(async (key, value) => { written.push(key); return kvSet(key, value); });
      const third = (await service.request(ask('task_a', 'settings:write')));
      (await service.resolve(first.id, { action: 'deny', by: 'user:owner' }));
      expect(written).toEqual([`permission:request:org_personal:task_a:${third.id}`,
        `permission:request:org_personal:task_a:${first.id}`]);
      expect((await service.requests()).map((request) => request.id)).toHaveLength(3);
      expect((await service.requests({ taskId: 'task_a' })).map((request) => [request.id, request.status]))
        .toEqual([[first.id, 'denied'], [third.id, 'pending']]);
      expect((await new PermissionRequests(store, 'org_other').requests())).toEqual([]);
    });

    it('moves the legacy organization blob into rows on first use', async () => {
      const store = (await Store.create(':memory:'));
      const legacy = [
        { id: 'preq_old', type: 'permission', taskId: 'task_a', projectId: 'home', role: 'do', capabilities: ['settings:read'],
          audience: ['@owners'], recipients: ['owner'], reason: 'Old.', requestedBy: 'task-agent:task_a:do',
          status: 'granted', resolution: { action: 'approve', by: 'user:owner', at: 2 }, createdAt: 1 },
        { id: 'preq_live', type: 'permission', taskId: 'task_b', projectId: 'home', role: 'do', capabilities: ['settings:write'],
          audience: ['@owners'], recipients: ['owner'], reason: 'Live.', requestedBy: 'task-agent:task_b:do',
          status: 'pending', createdAt: 3 },
      ];
      (await store.kvSet('permission:requests:org_personal', JSON.stringify(legacy)));
      const service = new PermissionRequests(store, 'org_personal');
      expect((await service.requests())).toEqual(legacy);
      expect((await store.kvGet('permission:requests:org_personal'))).toBeUndefined();
      expect((await store.kvEntries('permission:request:org_personal:')).map(({ key }) => key))
        .toEqual(['permission:request:org_personal:task_a:preq_old', 'permission:request:org_personal:task_b:preq_live']);
      expect((await service.resolve('preq_live', { action: 'approve', by: 'user:owner' }))).toMatchObject({ status: 'granted' });
    });

    it('prunes decided requests after the event window and keeps pending ones', async () => {
      const store = (await Store.create(':memory:'));
      const service = new PermissionRequests(store, 'org_personal');
      const decided = (await service.request(ask('task_a')));
      (await service.resolve(decided.id, { action: 'deny', by: 'user:owner' }));
      const pending = (await service.request(ask('task_b')));
      const day = 86400_000;
      expect((await store.retentionSweep(Date.now() + 89 * day)).permissionRequests).toBe(0);
      expect((await store.retentionSweep(Date.now() + 91 * day)).permissionRequests).toBe(1);
      expect((await service.requests()).map((request) => request.id)).toEqual([pending.id]);
    });
  });

  // PL-10: a finished task's pending request stayed in its recipients' inbox
  // and approval lists (#400), although nothing could act on a decision.
  describe('when the task settles', () => {
    async function asked() {
      const store = (await Store.create(':memory:'));
      const organization = (await store.createOrganization({ name: 'Settle', ownerUserId: 'owner' }));
      const project = (await store.createProject('P', {}, organization.id));
      const task = (await store.createTask({ projectId: project.id, title: 'Asks', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
      const service = new PermissionRequests(store, organization.id);
      const ask = { taskId: task.id, projectId: project.id, role: 'do', audience: ['@owners'], recipients: ['owner'],
        reason: 'Inspect settings.', requestedBy: `task-agent:${task.id}:do` };
      const granted = (await service.request({ ...ask, capabilities: ['settings:read'] }));
      (await service.resolve(granted.id, { action: 'approve', by: 'user:owner' }));
      const pending = (await service.request({ ...ask, capabilities: ['settings:write'] }));
      (await store.appendEvent({ taskId: task.id, type: 'permission.approval-requested', ts: Date.now(),
        payload: { requestId: pending.id, recipients: ['owner'] } }));
      expect((await store.listInbox('owner', organization.id)).map((item) => item.kind)).toContain('approval-requested');
      const view = (status: 'active' | 'done' | 'failed' | 'cancelled') => ({ taskId: task.id, title: task.title,
        workflow: task.workflow, stage: status === 'active' ? 'do' as const : status, status, messages: [], actions: [],
        state: {}, updatedAt: 1 });
      return { store, organization, task, service, granted, pending, view };
    }

    it.each(['done', 'failed', 'cancelled'] as const)('withdraws its pending requests when it is %s', async (status) => {
      const f = (await asked());
      try {
        (await f.store.saveView(f.task.id, f.view('active')));
        expect((await f.service.requests({ status: 'pending' }))).toHaveLength(1);
        // A status-only save, as a manual Done makes, records no view.updated event.
        (await f.store.saveView(f.task.id, f.view(status)));
        const requests = (await f.service.requests({ taskId: f.task.id }));
        expect(requests.find((request) => request.id === f.pending.id))
          .toMatchObject({ status: 'withdrawn', withdrawn: { at: expect.any(Number), reason: `task ${status}` } });
        expect(requests.find((request) => request.id === f.granted.id)).toMatchObject({ status: 'granted' });
        expect((await f.store.eventsSince(f.task.id, 0)).filter((event) => event.type === 'permission.approval-resolved')
          .map((event) => event.payload)).toEqual([{ requestId: f.pending.id, action: 'withdraw', reason: `task ${status}` }]);
        expect((await f.store.listInbox('owner', f.organization.id)).map((item) => item.kind)).not.toContain('approval-requested');
        await expect(f.service.resolve(f.pending.id, { action: 'approve', by: 'user:owner' })).rejects.toThrow(/already withdrawn/);
      } finally { (await f.store.close()); }
    });

    it('withdraws requests of tasks that settled before withdrawal existed', async () => {
      const f = (await asked());
      try {
        (await f.store.saveView(f.task.id, f.view('done')));
        // As if the task had settled before this change.
        (await f.store.kvSet(`permission:request:${f.organization.id}:${f.task.id}:${f.pending.id}`, JSON.stringify(f.pending)));
        expect((await f.store.retentionSweep()).permissionRequests).toBe(0);
        expect((await f.service.requests({ status: 'pending' }))).toEqual([]);
        expect((await f.service.requests({ taskId: f.task.id })).find((request) => request.id === f.pending.id))
          .toMatchObject({ status: 'withdrawn' });
      } finally { (await f.store.close()); }
    });
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
