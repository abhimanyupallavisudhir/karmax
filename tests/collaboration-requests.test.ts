import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { KarmaxBus } from '../src/contrib/bus.js';

async function fixture(onSignal?: (taskId: string, args: unknown[]) => void | Promise<void>) {
  const store = (await Store.create(':memory:'));
  const project = (await store.createProject('Parallel collaboration'));
  const requester = (await store.createTask({
    projectId: project.id, title: 'Requester', workflow: 'software-dev',
    workflowVersion: '1.3.0', params: { prompt: 'assemble the work' },
  }));
  const target = (await store.createTask({
    projectId: project.id, title: 'Publisher', workflow: 'software-dev',
    workflowVersion: '1.3.0', params: { prompt: 'build a part' },
  }));
  for (const task of [requester, target]) {
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1,
    }));
  }
  const tokens = new TokenAuthority();
  const token = (await tokens.mint({
    taskId: requester.id,
    projectId: project.id,
    organizationId: project.organizationId,
    profileId: 'do',
    principal: `task-agent:${requester.id}:do`,
    ceiling: ['task:conversation:message'],
    grantorCaps: ['task:conversation:message'],
  })).token;
  const signals = new Map<string, unknown[][]>();
  const client = {
    workflow: {
      getHandle(taskId: string) {
        return {
          signal: vi.fn(async (...args: unknown[]) => {
            const calls = signals.get(taskId) ?? [];
            calls.push(args);
            signals.set(taskId, calls);
            await onSignal?.(taskId, args);
          }),
        };
      },
    },
  } as any;
  const bus = new KarmaxBus();
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, bus });
  return { store, project, requester, target, token, signals, bus, client, tokens, api };
}

describe('durable background collaboration requests', () => {
  it('routes ordinary view updates from their payload without hydrating the task', async () => {
    const f = await fixture();
    const getTask = vi.spyOn(f.store, 'getTask');
    f.bus.emit({ taskId: f.target.id, type: 'view.updated', ts: Date.now(),
      payload: { stage: 'do', status: 'active' }, seq: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getTask).not.toHaveBeenCalled();
  });

  it('returns immediately after registering the requester and nudging the target', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
      message: 'Publish the parser changes when ready.',
    });

    expect(request).toMatchObject({
      requesterTaskId: f.requester.id,
      targetTaskId: f.target.id,
      action: 'publish_branch',
      status: 'pending',
    });
    expect((await f.store.getCollaborationRequest(request.id))?.status).toBe('pending');
    expect(f.signals.get(f.requester.id)?.[0]).toEqual(['collaborationRequested', request.id]);
    expect(f.signals.get(f.target.id)?.[0]?.[0]).toBe('followUp');
    expect((f.signals.get(f.target.id)?.[0]?.[1] as any).text)
      .toContain('call publish_task_branch');
  });

  it('settles on push.branch and injects one import-ready update into the requester', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const event = {
      taskId: f.target.id,
      type: 'push.branch',
      ts: Date.now(),
      payload: { branch: `tavya/${f.target.id}`, repos: ['app'] },
    };
    const seq = (await f.store.appendEvent(event));
    f.bus.emit({ ...event, seq });

    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))?.status).toBe('completed');
    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))?.notifiedAt).toEqual(expect.any(Number));
    const requesterSignals = f.signals.get(f.requester.id) ?? [];
    expect(requesterSignals.filter((call) => call[0] === 'collaborationSettled')).toHaveLength(1);
    expect(requesterSignals.filter((call) => call[0] === 'followUp')).toHaveLength(1);
    expect((requesterSignals.find((call) => call[0] === 'collaborationSettled')?.[2] as any).text)
      .toContain(`source_task_id "${f.target.id}"`);
    expect((await f.store.eventsSince(f.requester.id, 0)).filter((item) => item.type === 'conversation.message'))
      .toHaveLength(1);

    // Duplicate/replayed bus delivery is idempotent.
    f.bus.emit({ ...event, seq });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((f.signals.get(f.requester.id) ?? []).filter((call) => call[0] === 'collaborationSettled'))
      .toHaveLength(1);
  });

  it('reports a target terminal failure without polling', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const event = {
      taskId: f.target.id,
      type: 'view.updated',
      ts: Date.now(),
      payload: { stage: 'do', status: 'failed' },
    };
    const seq = (await f.store.appendEvent(event));
    f.bus.emit({ ...event, seq });

    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))?.status).toBe('failed');
    const settled = await vi.waitFor(() => {
      const call = (f.signals.get(f.requester.id) ?? []).find((item) => item[0] === 'collaborationSettled');
      expect(call).toBeTruthy();
      return call!;
    });
    expect((settled[2] as any).text).toContain('target task became failed');
  });

  it('reports a target escalation as failed instead of parking the requester forever', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const event = {
      taskId: f.target.id,
      type: 'view.updated',
      ts: Date.now(),
      payload: { stage: 'escalated', status: 'blocked' },
    };
    const seq = (await f.store.appendEvent(event));
    f.bus.emit({ ...event, seq });

    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))?.status).toBe('failed');
    const settled = await vi.waitFor(() => {
      const call = (f.signals.get(f.requester.id) ?? []).find((item) => item[0] === 'collaborationSettled');
      expect(call).toBeTruthy();
      return call!;
    });
    expect((settled[2] as any).text).toContain('became blocked before publishing');
  });

  it('allows an accepted request to cross PR while waiting for its branch publication', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const prEvent = {
      taskId: f.target.id,
      type: 'view.updated',
      ts: Date.now(),
      payload: { stage: 'pr', status: 'active' },
    };
    const prSeq = (await f.store.appendEvent(prEvent));
    f.bus.emit({ ...prEvent, seq: prSeq });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await f.store.getCollaborationRequest(request.id))?.status).toBe('pending');

    const pushEvent = {
      taskId: f.target.id,
      type: 'push.branch',
      ts: Date.now(),
      payload: { branch: `tavya/${f.target.id}`, repos: ['app'] },
    };
    const pushSeq = (await f.store.appendEvent(pushEvent));
    f.bus.emit({ ...pushEvent, seq: pushSeq });
    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))?.status).toBe('completed');
  });

  it('refuses a request when the target is already escalated', async () => {
    const f = (await fixture());
    const view = (await f.store.getTask(f.target.id))!.lastView!;
    (await f.store.saveView(f.target.id, { ...view, stage: 'escalated', status: 'blocked' }));

    await expect(f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    })).rejects.toThrow(/blocked and cannot run its Do agent/);
    expect((await f.store.listCollaborationRequests())).toEqual([]);
  });

  it('settles a delivery race when the target blocks while the request signal is in flight', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = (await fixture(async (taskId, args) => {
      if (taskId !== f.target.id || args[0] !== 'followUp') return;
      const view = (await f.store.getTask(f.target.id))!.lastView!;
      (await f.store.saveView(f.target.id, { ...view, stage: 'escalated', status: 'blocked' }));
    }));

    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });

    expect(request.status).toBe('failed');
    expect(request.result?.reason).toContain('became blocked before publishing');
    expect(request.notifiedAt).toEqual(expect.any(Number));
  });

  it('repairs a pending request whose target was already blocked before startup', async () => {
    const f = (await fixture());
    const request = (await f.store.createCollaborationRequest({
      requesterTaskId: f.requester.id,
      targetTaskId: f.target.id,
      action: 'publish_branch',
    }));
    const view = (await f.store.getTask(f.target.id))!.lastView!;
    (await f.store.saveView(f.target.id, { ...view, stage: 'escalated', status: 'blocked' }));

    // A fresh service instance reconciles durable requests before handling new
    // traffic, which is how an upgrade repairs rows orphaned by the old code.
    new KarmaxApi({
      store: f.store,
      client: f.client,
      taskQueue: 'test',
      tokens: f.tokens,
      bus: f.bus,
    });

    await expect.poll(async () => (await f.store.getCollaborationRequest(request.id))).toMatchObject({
      status: 'failed',
      result: { reason: 'target task became blocked before publishing its branch' },
      notifiedAt: expect.any(Number),
    });
    expect((f.signals.get(f.requester.id) ?? []).some((call) =>
      call[0] === 'collaborationSettled' && call[1] === request.id)).toBe(true);
  });

  it('lets the requester withdraw a collaboration without cancelling the target', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });

    const cancelled = await f.api.cancelAgentAction(f.token, request.id);

    expect(cancelled).toMatchObject({ id: request.id, status: 'failed' });
    expect(cancelled.result?.reason).toMatch(/withdrawn/);
    expect((await f.store.getTask(f.target.id))?.lastView?.status).not.toBe('cancelled');
    await vi.waitFor(() => {
      const call = (f.signals.get(f.requester.id) ?? [])
        .find((item) => item[0] === 'collaborationSettled' && item[1] === request.id);
      expect(call).toBeTruthy();
    });
  });

  it('does not let another task withdraw a collaboration it does not own', async () => {
    const f = (await fixture());
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const other = (await f.store.createTask({
      projectId: f.project.id,
      title: 'Other requester',
      workflow: 'software-dev',
      workflowVersion: '1.3.0',
      params: { prompt: 'Other' },
    }));
    const token = (await f.tokens.mint({
      taskId: other.id,
      projectId: f.project.id,
      organizationId: f.project.organizationId,
      profileId: 'do',
      principal: `task-agent:${other.id}:do`,
      ceiling: ['task:conversation:message'],
      grantorCaps: ['task:conversation:message'],
    })).token;
    await expect(f.api.cancelAgentAction(token, request.id)).rejects.toThrow(/not found/);
    expect((await f.store.getCollaborationRequest(request.id))?.status).toBe('pending');
  });

  it('removes collaboration records with their project', async () => {
    const f = (await fixture());
    (await f.store.createCollaborationRequest({
      requesterTaskId: f.requester.id,
      targetTaskId: f.target.id,
      action: 'publish_branch',
    }));
    (await f.store.deleteProject(f.project.id));
    expect((await f.store.listCollaborationRequests())).toEqual([]);
  });

  it('refuses a request after the target has entered its point-of-no-return stages', async () => {
    const f = (await fixture());
    const view = (await f.store.getTask(f.target.id))!.lastView!;
    (await f.store.saveView(f.target.id, { ...view, stage: 'merge', status: 'waiting' }));
    await expect(f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    })).rejects.toThrow(/passed its agent-work stage/);
    expect((await f.store.listCollaborationRequests())).toEqual([]);
  });
});
