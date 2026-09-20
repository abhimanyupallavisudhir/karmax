import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';

describe('multiple task attempts', () => {
  it('selects and preserves a principal until it fails or a winner commits', async () => {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('test'));
    const project = (await store.createProject('Acme'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = (await store.createTask({ projectId: project.id, title: 'X', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'test' } }));
    const second = await api.addAttempt(token, first.id);
    const readOnly = (await tokens.mintPrincipal('user:reader', ['task:read'], project.id)).token;
    await expect((async () => (await api.setPrincipalAttempt(readOnly, second.id)))()).rejects.toThrow();
    (await api.setPrincipalAttempt(token, second.id));
    expect((await store.listTasks(project.id))[0]!.id).toBe(second.id);
    expect((await store.getTaskByNum(project.id, first.num!))!.id).toBe(second.id);
    const third = await api.addAttempt(token, first.id);
    const failed = (id: string) => ({ taskId: id, title: 'X', workflow: 'script-exec', stage: 'do' as const,
      status: 'failed' as const, messages: [], actions: [], state: {}, updatedAt: 1 });
    (await store.saveView(third.id, failed(third.id)));
    expect((await store.attemptGroup(first.id))!.principalAttemptId).toBe(second.id);
    await expect((async () => (await api.setPrincipalAttempt(token, third.id)))()).rejects.toThrow();
    (await store.saveView(second.id, failed(second.id)));
    expect((await store.attemptGroup(first.id))!.principalAttemptId).toBe(first.id);
    (await store.claimAttempt(first.id));
    await expect((async () => (await api.setPrincipalAttempt(token, first.id)))()).rejects.toThrow(/commitment/);
    expect((await store.attemptGroup(first.id))!.committedAttemptId).toBe(first.id);
    (await store.close());
  });

  it('creates and queues every up-front attempt', async () => {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('test'));
    const project = (await store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' }));
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const starts: any[] = [];
    const client = { workflow: { start: async (...args: any[]) => { starts.push(args); } } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const principal = await api.createTask(token, {
      projectId: project.id,
      workflow: 'script-exec',
      params: { command: 'echo hi', confirm: { mode: 'agent' } },
      attempts: 3,
    });
    const group = (await api.attemptGroup(token, principal.id))!;
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
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('test'));
    const project = (await store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' }));
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = (await store.createTask({ projectId: project.id, title: 'X', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: '', command: 'one' } }));
    (await store.saveView(first.id, { taskId: first.id, title: 'X', workflow: 'script-exec', stage: 'cancelled', status: 'cancelled', messages: [], actions: [], state: {}, updatedAt: 1 }));
    const retry = await api.addAttempt(token, first.id);
    expect(retry.params).toMatchObject({ command: 'one', draft: true });
    expect((await store.attemptGroup(first.id))!.principalAttemptId).toBe(retry.id);
    (await store.claimAttempt(retry.id));
    await expect(api.addAttempt(token, retry.id)).rejects.toThrow(/no more attempts/i);
  });

  it('projects an unqueued attempt as a selectable draft view', async () => {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('test'));
    const project = (await store.createProject('Acme'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
    const first = (await store.createTask({ projectId: project.id, title: 'Original', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'hello', command: 'one' } }));
    const draft = await api.addAttempt(token, first.id);

    expect((await api.getDraftView(token, draft.id))).toMatchObject({
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
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('test'));
    const project = (await store.createProject('Acme', { repos: ['/tmp'], defaultBase: 'main' }));
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
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

    const group = (await api.attemptGroup(token, principal.id))!;
    expect(starts).toHaveLength(0);
    expect(armed).toHaveLength(3);
    expect(group.attempts.map((a) => a.params.triggerState)).toEqual(['armed', 'armed', 'armed']);
    expect(group.attempts.map((a) => a.params.draft)).toEqual([false, false, false]);
  });

  async function choiceFixture() {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Attempts', { defaultBase: 'main', defaultTarget: 'main' }));
    const tokens = new TokenAuthority();
    const maintainer = (await tokens.mintPrincipal('user:maintainer', ['*'], project.id)).token;
    const developer = (await tokens.mintPrincipal('user:developer', ['task:*', 'project:read'], project.id)).token;
    const signals: string[] = [];
    const client = { workflow: { start: async () => {}, getHandle: (id: string) => ({ signal: async () => { signals.push(id); } }) } } as any;
    const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test' });
    const first = (await store.createTask({ projectId: project.id, title: 'A', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'a' } }));
    const second = (await store.createTask({ projectId: project.id, title: 'B', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'b' }, intentId: first.intentId }));
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), client });
    const mergeView = (id: string) => ({ taskId: id, title: 'T', workflow: 'software-dev', stage: 'merge' as const, status: 'active' as const, messages: [], actions: [], state: {}, updatedAt: 1 });
    return { store, project, api, maintainer, developer, signals, first, second, core, mergeView };
  }

  it('requires a choice, then allows both kept proposals through Merge admission', async () => {
    const f = (await choiceFixture());
    await expect(f.api.signalTask(f.developer, f.first.id, 'confirm')).rejects.toThrow(/keep or cancel/);
    expect(f.signals).toEqual([]);
    await f.api.signalTask(f.developer, f.first.id, 'confirm', undefined, undefined, undefined, undefined, { otherAttempts: 'keep' });
    f.signals.length = 0;
    await f.core.publishView(f.first.id, f.mergeView(f.first.id));
    // A later conflicting decision cannot reverse Keep or cancel an admitted sibling.
    (await f.store.kvSet(`attempt-choice:${f.second.id}`, 'cancel'));
    await f.core.publishView(f.second.id, f.mergeView(f.second.id));
    expect(f.signals).toEqual([]);
    expect((await f.store.attemptGroup(f.first.id))).toMatchObject({ otherAttempts: 'keep', principalAttemptId: f.first.id });
    (await f.store.close());
  });

  it('cancels alternatives and prevents the losing workflow from passing the awaited admission', async () => {
    const f = (await choiceFixture());
    (await f.store.setSettings(f.project.id, '__common__', { otherAttempts: 'cancel' }));
    await f.core.publishView(f.first.id, f.mergeView(f.first.id));
    expect(f.signals).toEqual([f.second.id]);
    await expect(f.core.publishView(f.second.id, f.mergeView(f.second.id))).rejects.toThrow(/cancelled this proposal/);
    (await f.store.close());
  });

  it('keeps by default without a reviewer and preserves historical exclusive reservations', async () => {
    const f = (await choiceFixture());
    expect((await f.store.claimAttempt(f.first.id))).toEqual({ accepted: true, cancel: [] });
    expect((await f.store.claimAttempt(f.second.id))).toEqual({ accepted: true, cancel: [] });
    (await f.store.kvDelete(`attempt-policy:${f.first.intentId}`));
    expect((await f.store.claimAttempt(f.second.id))).toEqual({ accepted: false, cancel: [f.second.id] });
    (await f.store.close());
  });

  it('only project maintainers can save the choice, preserving unrelated defaults', async () => {
    const f = (await choiceFixture());
    const choice = { otherAttempts: 'keep' as const, saveOtherAttemptsDefault: true };
    expect((await f.api.attemptGroup(f.developer, f.first.id))?.canSaveOtherAttemptsDefault).toBe(false);
    expect((await f.api.attemptGroup(f.maintainer, f.first.id))?.canSaveOtherAttemptsDefault).toBe(true);
    await expect(f.api.signalTask(f.developer, f.first.id, 'confirm', undefined, undefined, undefined, undefined, choice)).rejects.toThrow(/project:settings:write/);
    expect((await f.store.kvGet(`attempt-choice:${f.first.id}`))).toBeUndefined();
    (await f.store.setSettings(f.project.id, '__common__', { target: 'main' }));
    await f.api.signalTask(f.maintainer, f.first.id, 'confirm', undefined, undefined, undefined, undefined, choice);
    expect((await f.store.getSettings(f.project.id, '__common__'))).toEqual({ target: 'main', otherAttempts: 'keep' });
    expect((await f.api.attemptGroup(f.developer, f.second.id))?.otherAttemptsDefault).toBe('keep');
    (await f.store.close());
  });

  it('snapshots an inherited choice at confirmation and permits kept drafts to queue', async () => {
    const f = (await choiceFixture());
    (await f.store.setSettings(f.project.id, '__common__', { otherAttempts: 'keep' }));
    await f.api.signalTask(f.developer, f.first.id, 'confirm');
    (await f.store.setSettings(f.project.id, '__common__', { otherAttempts: 'cancel' }));
    expect((await f.store.claimAttempt(f.first.id))).toEqual({ accepted: true, cancel: [] });
    (await f.store.updateTaskParams(f.second.id, { prompt: 'b', draft: true }));
    await f.api.queueTask(f.maintainer, f.second.id);
    expect((await f.store.getTask(f.second.id))?.params.draft).toBe(false);
    (await f.store.close());
  });

  it('does not ask for a Merge policy on workflows without a Merge stage', async () => {
    const f = (await choiceFixture());
    const task = (await f.store.createTask({ projectId: f.project.id, title: 'Command', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: '', command: 'true' } }));
    (await f.store.createTask({ projectId: f.project.id, title: 'Alternate', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: '', command: 'true' }, intentId: task.intentId }));
    expect((await f.api.attemptGroup(f.developer, task.id))?.otherAttemptsChoiceAvailable).toBe(false);
    await f.api.signalTask(f.developer, task.id, 'confirm');
    (await f.store.close());
  });

  it.each(['cancelled', 'failed'] as const)('keeps the task list on a surviving alternative when its first admitted attempt is %s', async (status) => {
    const f = (await choiceFixture());
    (await f.store.claimAttempt(f.first.id));
    (await f.store.saveView(f.first.id, { ...f.mergeView(f.first.id), stage: status === 'failed' ? 'merge' : 'cancelled', status }));
    expect((await f.store.attemptGroup(f.first.id))).toMatchObject({
      committedAttemptId: f.first.id, principalAttemptId: f.second.id, otherAttempts: 'keep',
    });
    expect((await f.store.listTasks(f.project.id)).map((task) => task.id)).toEqual([f.second.id]);
    expect((await f.store.claimAttempt(f.second.id))).toEqual({ accepted: true, cancel: [] });
    (await f.store.close());
  });

  it('applies cancellation to drafts but leaves finished attempts alone', async () => {
    const f = (await choiceFixture());
    (await f.store.updateTaskParams(f.second.id, { prompt: 'b', draft: true }));
    const done = (await f.store.createTask({ projectId: f.project.id, title: 'Done', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: '' }, intentId: f.first.intentId }));
    (await f.store.saveView(done.id, { ...f.mergeView(done.id), stage: 'done', status: 'done' }));
    (await f.store.kvSet(`attempt-choice:${f.first.id}`, 'cancel'));
    await f.core.publishView(f.first.id, f.mergeView(f.first.id));
    expect((await f.store.getTask(f.second.id))?.lastView?.status).toBe('cancelled');
    expect((await f.store.getTask(done.id))?.lastView?.status).toBe('done');
    expect(f.signals).toEqual([]);
    (await f.store.close());
  });

  it('serializes agent confirmation for siblings into one intent transcript', async () => {
    const store = (await Store.create(':memory:'));
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
        ctx.confirmDecision({ action: 'confirm', otherAttempts: 'keep' });
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
    expect((await store.kvGet('attempt-choice:attempt-a'))).toBe('keep');
    expect((await store.kvGet('attempt-choice:attempt-b'))).toBe('keep');
    expect(maxActive).toBe(1);
    expect(seen).toEqual([['review A'], ['review A', 'review B']]);
    expect(results.map((result) => result.finalActivity)).toEqual([
      { turnId: 'attempt-a#0', id: 'final-1', attempt: 1 },
      { turnId: 'attempt-b#0', id: 'final-2', attempt: 1 },
    ]);
    expect(JSON.parse((await store.kvGet('confirm-transcript:intent-1'))!)).toHaveLength(6); // request/output/verdict × 2
    await world.destroy();
  });
});
