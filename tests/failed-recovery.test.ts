import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { MANIFESTS } from '../src/contrib/manifests.js';
// Derived, not hard-coded: the pinned type moves every time a workflow ships a
// new replay version, and a literal here just makes an unrelated PR red.
const bundledVersion = (name: string) => MANIFESTS.find((m) => m.name === name)!.version;

describe('failed software-dev recovery', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('offers Retry while a live infrastructure backoff can be woken early', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const token = tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    }).token;
    const project = store.createProject('Infrastructure recovery');
    const task = store.createTask({
      projectId: project.id, title: 'Transient outage', workflow: 'software-dev',
      workflowVersion: bundledVersion('software-dev'), params: { prompt: 'keep going' },
    });
    const actions = [
      {
        name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true,
        args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
      },
      { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true },
    ] as any;
    const backoff = {
      taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'do', status: 'active',
      messages: [], actions, state: {}, updatedAt: 1,
      error: 'infrastructure: E2B request handshake timed out — retrying do in 30s (1/5)',
    } as any;
    store.saveView(task.id, backoff);

    const signals: string[] = [];
    const client = { workflow: { getHandle: () => ({ signal: async (name: string) => void signals.push(name) }) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const retryable = await api.getTaskView(token, task.id);
    expect(retryable?.actions.map((action) => action.name)).toEqual(['retry', 'followUp', 'cancel']);
    await api.signalTask(token, task.id, 'retry');
    expect(signals).toEqual(['retry']);

    // Retry is a control for the workflow's parked timer, not a generic Do
    // action: an ordinary running/error snapshot must retain its original set.
    store.saveView(task.id, { ...backoff, error: 'ordinary agent failure', updatedAt: 2 });
    const ordinary = await api.getTaskView(token, task.id);
    expect(ordinary?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
  });

  /**
   * Regression: both recovery gates were bare `workflow === 'software-dev'`
   * string tests, so a Goal task — which delegates to the very same
   * `softwareDevImpl` and fully supports `input.recovery` — was a dead end with
   * no Retry, no follow-up, and a `recoverFailedTask` that threw. The same gate
   * also caught a software-dev task switched to Goal in flight.
   */
  it('offers the same recovery to a failed Goal task (it delegates to software-dev)', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const token = tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    }).token;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-goal-recovery-repo-'));
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-goal-recovery-world-'));
    dirs.push(repo, world);
    const project = store.createProject('Goal recovery', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' });
    const task = store.createTask({
      projectId: project.id, title: 'Autonomous work', workflow: 'goal',
      workflowVersion: bundledVersion('goal'),
      params: { prompt: 'keep going', base: 'main', target: 'main' },
    });
    store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: 'goal', stage: 'failed', status: 'failed',
      messages: [{ id: 'm0', role: 'user', text: 'keep going', ts: 0 }],
      transcripts: [], actions: [], state: {},
      branch: `karmax/${task.id}`, base: 'main', targetBranch: 'main', worldPath: world,
      error: 'provider transport died', updatedAt: 1,
    } as any);

    const starts: [string, any][] = [];
    const client = {
      workflow: {
        getHandle: () => ({ query: async () => { throw new Error('not running'); } }),
        start: async (type: string, options: any) => { starts.push([type, options]); return { workflowId: options.workflowId }; },
      },
    } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const failed = await api.getTaskView(token, task.id);
    expect(failed?.actions.map((a) => a.name)).toEqual(['retry', 'followUp', 'cancel']);

    await api.signalTask(token, task.id, 'retry');
    expect(starts).toHaveLength(1);
    expect(starts[0]![0]).toBe(`goal@${bundledVersion('goal')}`);
  });

  it('offers escalation controls and restarts from the existing dirty world', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const token = tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task', 'signal-task'],
      grantorCaps: ['read-task', 'signal-task'],
    }).token;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recovery-repo-'));
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recovery-world-'));
    dirs.push(repo, world);
    fs.writeFileSync(path.join(world, 'dirty-work.txt'), 'must survive');
    const project = store.createProject('Recovery', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' });
    const task = store.createTask({
      projectId: project.id,
      title: 'Interrupted work',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'finish it', base: 'main', target: 'main' },
    });
    store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: 'software-dev',
      stage: 'failed',
      status: 'failed',
      messages: [
        { id: 'm0', role: 'user', text: 'finish it', ts: 0 },
        { id: 'a1', role: 'agent', text: 'work is partly implemented', ts: 1 },
      ],
      transcripts: [{ role: 'do', label: 'Do agent', messages: [{ id: 'm0', role: 'user', text: 'finish it', ts: 0 }] }],
      actions: [],
      state: { turnsSeen: 2 },
      branch: `karmax/${task.id}`,
      base: 'main',
      targetBranch: 'main',
      worldPath: world,
      error: 'Resolve agent failed',
      updatedAt: 1,
    });
    store.kvSet(`session:${task.id}:do`, 'session-123');
    store.kvSet(`sessionmeta:${task.id}:do`, JSON.stringify({ home: '' }));

    const starts: any[] = [];
    const client = { workflow: { start: async (...args: any[]) => void starts.push(args), getHandle: () => { throw new Error('closed workflow must not be signalled'); } } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const failed = await api.getTaskView(token, task.id);
    expect(failed?.actions.map((a) => a.name)).toEqual(['retry', 'followUp', 'cancel']);
    await api.signalTask(token, task.id, 'followUp', 'Also keep the compatibility layer.');
    await api.signalTask(token, task.id, 'retry');

    expect(starts).toHaveLength(1);
    expect(starts[0]![0]).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    const options = starts[0]![1];
    expect(options.workflowId).toBe(task.id);
    expect(options.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE_FAILED_ONLY');
    expect(options.args[0].recovery).toMatchObject({
      world: { root: world, branch: `karmax/${task.id}`, repo },
      session: 'session-123',
      sessionHome: '(profile)',
      seen: 2,
    });
    expect(options.args[0].recovery.messages.map((m: any) => m.text)).toEqual(
      expect.arrayContaining(['Also keep the compatibility layer.', expect.stringMatching(/recovered this task/i)]),
    );
    expect(fs.readFileSync(path.join(world, 'dirty-work.txt'), 'utf8')).toBe('must survive');
    expect(store.getTask(task.id)?.lastView).toMatchObject({ stage: 'do', status: 'active' });
    expect(store.getTask(task.id)?.workflowVersion).toBe(bundledVersion('software-dev'));
  });

  it('queries through a stale v1 account-wait snapshot but keeps current snapshots fast', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const token = tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task'],
      grantorCaps: ['read-task'],
    }).token;
    const project = store.createProject('Legacy view');
    const task = store.createTask({
      projectId: project.id,
      title: 'Old run',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'continue' },
    });
    const stale = {
      taskId: task.id,
      title: task.title,
      workflow: 'software-dev',
      stage: 'do' as const,
      status: 'waiting' as const,
      waitingFor: { kind: 'account' as const, provider: 'codex' as const },
      messages: [],
      actions: [],
      state: {},
      updatedAt: 1,
    };
    store.saveView(task.id, stale);
    let queries = 0;
    const live = { ...stale, status: 'active' as const, waitingFor: undefined, updatedAt: 2 };
    const client = {
      workflow: { getHandle: () => ({ query: async () => (queries++, live) }) },
    } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    expect(await api.getTaskView(token, task.id)).toMatchObject({ status: 'active', updatedAt: 2 });
    expect(queries).toBe(1);

    store.setTaskWorkflowVersion(task.id, '1.1.0');
    store.saveView(task.id, stale);
    expect(await api.getTaskView(token, task.id)).toMatchObject({ status: 'waiting', updatedAt: 1 });
    expect(queries).toBe(1);
  });
});
