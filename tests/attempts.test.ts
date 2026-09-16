import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';

describe('multiple task attempts', () => {
  it('selects and preserves a principal until it fails or a winner commits', async () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('test');
    const project = store.createProject('Acme');
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = store.createTask({ projectId: project.id, title: 'X', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'test' } });
    const second = await api.addAttempt(token, first.id);
    const readOnly = tokens.mintPrincipal('user:reader', ['task:read'], project.id).token;
    expect(() => api.setPrincipalAttempt(readOnly, second.id)).toThrow();
    api.setPrincipalAttempt(token, second.id);
    expect(store.listTasks(project.id)[0]!.id).toBe(second.id);
    expect(store.getTaskByNum(project.id, first.num!)!.id).toBe(second.id);
    const third = await api.addAttempt(token, first.id);
    const failed = (id: string) => ({ taskId: id, title: 'X', workflow: 'script-exec', stage: 'do' as const,
      status: 'failed' as const, messages: [], actions: [], state: {}, updatedAt: 1 });
    store.saveView(third.id, failed(third.id));
    expect(store.attemptGroup(first.id)!.principalAttemptId).toBe(second.id);
    expect(() => api.setPrincipalAttempt(token, third.id)).toThrow();
    store.saveView(second.id, failed(second.id));
    expect(store.attemptGroup(first.id)!.principalAttemptId).toBe(first.id);
    store.claimAttempt(first.id);
    expect(() => api.setPrincipalAttempt(token, first.id)).toThrow(/commitment/);
    expect(store.attemptGroup(first.id)!.committedAttemptId).toBe(first.id);
    store.close();
  });

  it('creates and queues every up-front attempt', async () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('test');
    const project = store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' });
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
    const starts: any[] = [];
    const client = { workflow: { start: async (...args: any[]) => { starts.push(args); } } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const principal = await api.createTask(token, {
      projectId: project.id,
      workflow: 'script-exec',
      params: { command: 'echo hi', confirm: { mode: 'agent' } },
      attempts: 3,
    });
    const group = api.attemptGroup(token, principal.id)!;
    expect(starts).toHaveLength(3);
    expect(group.attempts).toHaveLength(3);
    expect(group.attempts.map((a) => a.params.draft)).toEqual([false, false, false]);
    expect(group.attempts.map((a) => a.params.command)).toEqual(['echo hi', 'echo hi', 'echo hi']);
    expect(group.attempts.map((a) => a.params.confirm)).toEqual([
      { mode: 'agent' }, { mode: 'agent' }, { mode: 'agent' },
    ]);
    expect(await api.listTasks(token, project.id)).toHaveLength(1);
  });

  it('allows another draft after cancellation but rejects one after commitment', async () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('test');
    const project = store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' });
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = store.createTask({ projectId: project.id, title: 'X', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: '', command: 'one' } });
    store.saveView(first.id, { taskId: first.id, title: 'X', workflow: 'script-exec', stage: 'cancelled', status: 'cancelled', messages: [], actions: [], state: {}, updatedAt: 1 });
    const retry = await api.addAttempt(token, first.id);
    expect(retry.params).toMatchObject({ command: 'one', draft: true });
    expect(store.attemptGroup(first.id)!.principalAttemptId).toBe(retry.id);
    store.claimAttempt(retry.id);
    await expect(api.addAttempt(token, retry.id)).rejects.toThrow(/no more attempts/i);
  });

  it('projects an unqueued attempt as a selectable draft view', async () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('test');
    const project = store.createProject('Acme');
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = store.createTask({ projectId: project.id, title: 'Original', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'hello', command: 'one' } });
    const draft = await api.addAttempt(token, first.id);

    expect(api.getDraftView(token, draft.id)).toMatchObject({
      taskId: draft.id,
      title: 'Original',
      stage: 'setup',
      status: 'waiting',
      state: { draft: true },
      messages: [{ role: 'user', text: 'hello' }],
    });
    await expect(api.getTaskView(token, draft.id)).resolves.toBeUndefined();
  });

  it('arms every up-front attempt together when creation is trigger-gated', async () => {
    const store = new Store(':memory:');
    store.claimPersonalOrganization('test');
    const project = store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' });
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
    const starts: unknown[] = [];
    const api = new KarmaxApi({ store, client: { workflow: { start: async (...a: unknown[]) => starts.push(a) } } as any, taskQueue: 'test', tokens });
    const armed: string[] = [];
    api.setTriggerArmer({ arm: (task) => armed.push(task.id), disarm: () => {} });

    const principal = await api.createTask(token, {
      projectId: project.id,
      workflow: 'just-do',
      params: { prompt: 'later', triggers: [{ kind: 'event', type: 'work.ready' }] },
      attempts: 3,
    });

    const group = api.attemptGroup(token, principal.id)!;
    expect(starts).toHaveLength(0);
    expect(armed).toHaveLength(3);
    expect(group.attempts.map((a) => a.params.triggerState)).toEqual(['armed', 'armed', 'armed']);
    expect(group.attempts.map((a) => a.params.draft)).toEqual([false, false, false]);
  });

  it('serializes agent confirmation for siblings into one intent transcript', async () => {
    const store = new Store(':memory:');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: 'attempt-a', base: 'main' });
    const seen: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const adapter = {
      provider: 'mock' as const,
      async runTurn(input: any, ctx: any) {
        active++;
        maxActive = Math.max(maxActive, active);
        seen.push(input.messages.filter((m: any) => m.role === 'user').map((m: any) => m.text));
        await new Promise((r) => setTimeout(r, 15));
        ctx.emitActivity({ id: `final-${seen.length}`, kind: 'message', phase: 'completed', title: `reviewed ${seen.length}` });
        ctx.confirmDecision({ action: 'confirm' });
        active--;
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: `reviewed ${seen.length}` };
      },
    };
    const core = makeCoreActivities({ store, worlds, adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
    const task = { intentId: 'intent-1', projectId: 'p', title: 'X', prompt: 'x', project: {}, workflow: 'software-dev' } as any;
    const results = await Promise.all([
      core.runAgentTurn({ taskId: 'attempt-a', role: 'confirm', agentTurnId: 'attempt-a#0', worldHandle: world.handle, messages: [{ id: 'c-in-0', role: 'user', text: 'review A', ts: 0 }], task }),
      core.runAgentTurn({ taskId: 'attempt-b', role: 'confirm', agentTurnId: 'attempt-b#0', worldHandle: world.handle, messages: [{ id: 'c-in-0', role: 'user', text: 'review B', ts: 0 }], task }),
    ]);
    expect(maxActive).toBe(1);
    expect(seen).toEqual([['review A'], ['review A', 'review B']]);
    expect(results.map((result) => result.finalActivity)).toEqual([
      { turnId: 'attempt-a#0', id: 'final-1', attempt: 1 },
      { turnId: 'attempt-b#0', id: 'final-2', attempt: 1 },
    ]);
    expect(JSON.parse(store.kvGet('confirm-transcript:intent-1')!)).toHaveLength(6); // request/output/verdict × 2
    await world.destroy();
  });
});
