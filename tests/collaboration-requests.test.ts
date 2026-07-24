import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { KarmaxBus } from '../src/contrib/bus.js';

function fixture() {
  const store = new Store(':memory:');
  const project = store.createProject('Parallel collaboration');
  const requester = store.createTask({
    projectId: project.id, title: 'Requester', workflow: 'software-dev',
    workflowVersion: '1.3.0', params: { prompt: 'assemble the work' },
  });
  const target = store.createTask({
    projectId: project.id, title: 'Publisher', workflow: 'software-dev',
    workflowVersion: '1.3.0', params: { prompt: 'build a part' },
  });
  for (const task of [requester, target]) {
    store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1,
    });
  }
  const tokens = new TokenAuthority();
  const token = tokens.mint({
    taskId: requester.id,
    projectId: project.id,
    organizationId: project.organizationId,
    profileId: 'do',
    principal: `task-agent:${requester.id}:do`,
    ceiling: ['task:conversation:message'],
    grantorCaps: ['task:conversation:message'],
  }).token;
  const signals = new Map<string, unknown[][]>();
  const client = {
    workflow: {
      getHandle(taskId: string) {
        return {
          signal: vi.fn(async (...args: unknown[]) => {
            const calls = signals.get(taskId) ?? [];
            calls.push(args);
            signals.set(taskId, calls);
          }),
        };
      },
    },
  } as any;
  const bus = new KarmaxBus();
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, bus });
  return { store, project, requester, target, token, signals, bus, api };
}

describe('durable background collaboration requests', () => {
  it('returns immediately after registering the requester and nudging the target', async () => {
    const f = fixture();
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
    expect(f.store.getCollaborationRequest(request.id)?.status).toBe('pending');
    expect(f.signals.get(f.requester.id)?.[0]).toEqual(['collaborationRequested', request.id]);
    expect(f.signals.get(f.target.id)?.[0]?.[0]).toBe('followUp');
    expect((f.signals.get(f.target.id)?.[0]?.[1] as any).text)
      .toContain('call publish_task_branch');
  });

  it('settles on push.branch and injects one import-ready update into the requester', async () => {
    const f = fixture();
    const request = await f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    });
    const event = {
      taskId: f.target.id,
      type: 'push.branch',
      ts: Date.now(),
      payload: { branch: `karmax/${f.target.id}`, repos: ['app'] },
    };
    const seq = f.store.appendEvent(event);
    f.bus.emit({ ...event, seq });

    await expect.poll(() => f.store.getCollaborationRequest(request.id)?.status).toBe('completed');
    await expect.poll(() => f.store.getCollaborationRequest(request.id)?.notifiedAt).toEqual(expect.any(Number));
    const requesterSignals = f.signals.get(f.requester.id) ?? [];
    expect(requesterSignals.filter((call) => call[0] === 'collaborationSettled')).toHaveLength(1);
    expect(requesterSignals.filter((call) => call[0] === 'followUp')).toHaveLength(1);
    expect((requesterSignals.find((call) => call[0] === 'collaborationSettled')?.[2] as any).text)
      .toContain(`source_task_id "${f.target.id}"`);
    expect(f.store.eventsSince(f.requester.id, 0).filter((item) => item.type === 'conversation.message'))
      .toHaveLength(1);

    // Duplicate/replayed bus delivery is idempotent.
    f.bus.emit({ ...event, seq });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((f.signals.get(f.requester.id) ?? []).filter((call) => call[0] === 'collaborationSettled'))
      .toHaveLength(1);
  });

  it('reports a target terminal failure without polling', async () => {
    const f = fixture();
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
    const seq = f.store.appendEvent(event);
    f.bus.emit({ ...event, seq });

    await expect.poll(() => f.store.getCollaborationRequest(request.id)?.status).toBe('failed');
    const settled = await vi.waitFor(() => {
      const call = (f.signals.get(f.requester.id) ?? []).find((item) => item[0] === 'collaborationSettled');
      expect(call).toBeTruthy();
      return call!;
    });
    expect((settled[2] as any).text).toContain('target task became failed');
  });

  it('removes collaboration records with their project', () => {
    const f = fixture();
    f.store.createCollaborationRequest({
      requesterTaskId: f.requester.id,
      targetTaskId: f.target.id,
      action: 'publish_branch',
    });
    f.store.deleteProject(f.project.id);
    expect(f.store.listCollaborationRequests()).toEqual([]);
  });

  it('refuses a request after the target has entered its point-of-no-return stages', async () => {
    const f = fixture();
    const view = f.store.getTask(f.target.id)!.lastView!;
    f.store.saveView(f.target.id, { ...view, stage: 'merge', status: 'waiting' });
    await expect(f.api.requestAgentAction(f.token, {
      taskId: f.target.id,
      action: 'publish_branch',
    })).rejects.toThrow(/passed its agent-work stage/);
    expect(f.store.listCollaborationRequests()).toEqual([]);
  });
});
