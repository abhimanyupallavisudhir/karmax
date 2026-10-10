import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { MANIFESTS } from '../src/contrib/manifests.js';
import { reconcileTasks } from '../src/platform/reconcile.js';
import { mergeQueueDomains } from '../src/domain/types.js';
import { mergeQueueId, SIG_CANCEL_MERGE } from '../src/coordinators/names.js';
import { WorkflowFailedError } from '@temporalio/client';
import { TerminatedFailure } from '@temporalio/common';
// Derived, not hard-coded: the pinned type moves every time a workflow ships a
// new replay version, and a literal here just makes an unrelated PR red.
const bundledVersion = (name: string) => MANIFESTS.find((m) => m.name === name)!.version;

/** A Temporal client for a task whose run already closed: starts are
 * recorded, the coordinators answer, and the closed run itself is never
 * signalled. */
const closedRunClient = (taskId: string, starts: any[], withdrawals: string[] = []) => ({ workflow: {
  start: async (...args: any[]) => void starts.push(args),
  signalWithStart: async (_type: string, options: any) => void withdrawals.push(`${options.signal}:${options.workflowId}`),
  getHandle: (id: string) => {
    if (id === taskId) throw new Error('a closed workflow must not be signalled');
    return { query: async () => undefined, signal: async (name: string) => void withdrawals.push(`${name}:${id}`) };
  },
} }) as any;

describe('failed software-dev recovery', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('offers Retry while a live infrastructure backoff can be woken early', async () => {
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const project = (await store.createProject('Infrastructure recovery'));
    const task = (await store.createTask({
      projectId: project.id, title: 'Transient outage', workflow: 'software-dev',
      workflowVersion: bundledVersion('software-dev'), params: { prompt: 'keep going' },
    }));
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
    (await store.saveView(task.id, backoff));

    const signals: string[] = [];
    const client = { workflow: { getHandle: () => ({ signal: async (name: string) => void signals.push(name) }) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    const retryable = await api.getTaskView(token, task.id);
    expect(retryable?.actions.map((action) => action.name)).toEqual(['retry', 'followUp', 'cancel']);
    await api.signalTask(token, task.id, 'retry');
    expect(signals).toEqual(['retry']);

    // Retry is a control for the workflow's parked timer, not a generic Do
    // action: an ordinary running/error snapshot must retain its original set.
    (await store.saveView(task.id, { ...backoff, error: 'ordinary agent failure', updatedAt: 2 }));
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
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-goal-recovery-repo-'));
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-goal-recovery-world-'));
    dirs.push(repo, world);
    const project = (await store.createProject('Goal recovery', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({
      projectId: project.id, title: 'Autonomous work', workflow: 'goal',
      workflowVersion: bundledVersion('goal'),
      params: { prompt: 'keep going', base: 'main', target: 'main' },
    }));
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: 'goal', stage: 'failed', status: 'failed',
      messages: [{ id: 'm0', role: 'user', text: 'keep going', ts: 0 }],
      transcripts: [], actions: [], state: {},
      branch: `tavya/${task.id}`, base: 'main', targetBranch: 'main', worldPath: world,
      error: 'provider transport died', updatedAt: 1,
    } as any));

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
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task', 'signal-task'],
      grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recovery-repo-'));
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recovery-world-'));
    dirs.push(repo, world);
    fs.writeFileSync(path.join(world, 'dirty-work.txt'), 'must survive');
    const project = (await store.createProject('Recovery', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'Interrupted work',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'finish it', base: 'main', target: 'main' },
    }));
    (await store.saveView(task.id, {
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
      branch: `tavya/${task.id}`,
      base: 'main',
      targetBranch: 'main',
      worldPath: world,
      error: 'Resolve agent failed',
      updatedAt: 1,
    }));
    (await store.kvSet(`session:${task.id}:do`, 'session-123'));
    (await store.kvSet(`sessionmeta:${task.id}:do`, JSON.stringify({ home: '' })));

    const starts: any[] = [];
    const client = closedRunClient(task.id, starts);
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
      world: { root: world, branch: `tavya/${task.id}`, repo },
      session: 'session-123',
      sessionHome: '(profile)',
      seen: 2,
    });
    expect(options.args[0].recovery.messages.map((m: any) => m.text)).toEqual(
      expect.arrayContaining(['Also keep the compatibility layer.', expect.stringMatching(/recovered this task/i)]),
    );
    expect(fs.readFileSync(path.join(world, 'dirty-work.txt'), 'utf8')).toBe('must survive');
    expect((await store.getTask(task.id))?.lastView).toMatchObject({ stage: 'do', status: 'active' });
    expect((await store.getTask(task.id))?.workflowVersion).toBe(bundledVersion('software-dev'));
  });

  // Task #367: Temporal terminated the run for its history size while Landing
  // verified the last candidate. One PR of its set had already merged, so the
  // point of no return had passed, and Done was the only way out even though
  // its sandbox, branches and open PRs were intact.
  it('retries a run terminated mid-Landing after one of its PRs merged', async () => {
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const project = (await store.createProject('Partial landing', { defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({
      projectId: project.id, title: 'Review everything', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'review', base: 'main', target: 'main' },
    }));
    const branch = `tavya/${task.id}`;
    const world = {
      kind: 'e2b', id: task.id, root: '/home/user/work', workdir: '/home/user/work/app', branch, base: 'main', target: 'main',
      repos: ['app', 'wiki'].map((name) => ({ name, repo: `git@github.com:acme/${name}.git`, root: `/home/user/work/${name}`, branch, base: 'main' })),
      meta: { sandboxId: 'sbx-367' },
    };
    const prs = [
      { repo: 'wiki', slug: 'acme/wiki', number: 57, url: 'https://github.com/acme/wiki/pull/57', state: 'merged', merged: true, headSha: 'w1' },
      { repo: 'app', slug: 'acme/app', number: 392, url: 'https://github.com/acme/app/pull/392', state: 'open', merged: false, headSha: 'a1' },
    ] as any[];
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'merge', status: 'active',
      messages: [{ id: 'm0', role: 'user', text: 'review', ts: 0 }, { id: 'a1', role: 'agent', text: 'proposal ready', ts: 1 }],
      transcripts: [], actions: [], state: { recoveryWorld: world, turnsSeen: 2 },
      world, branch, base: 'main', targetBranch: 'main', pr: prs[0], prs, pointOfNoReturnPassed: true,
      landing: { authorization: 'authorized', validation: 'pending', provider: 'validating',
        authorizedHeads: { 'acme/wiki#57': 'w1', 'acme/app#392': 'a1' } },
      waitingFor: { kind: 'agentSlot', provider: 'claude', detail: 'Starting agent' }, updatedAt: 1,
    } as any));

    const terminated = { workflow: { getHandle: () => ({
      describe: async () => ({ status: { name: 'TERMINATED' }, runId: 'run-367' }),
      result: async () => { throw new WorkflowFailedError('Workflow execution failed',
        new TerminatedFailure('Workflow history size exceeds limit.'), 'NON_RETRYABLE_FAILURE'); },
    }) } } as any;
    (await reconcileTasks(store, terminated));
    // The failure keeps the stage it interrupted; nothing else in the view says so.
    expect((await store.getTask(task.id))?.lastView).toMatchObject({
      stage: 'failed', status: 'failed', pointOfNoReturnPassed: true, state: { failedFrom: 'merge' },
    });

    const starts: any[] = [];
    const withdrawals: string[] = [];
    const client = closedRunClient(task.id, starts, withdrawals);
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });
    const failed = await api.getTaskView(token, task.id);
    // Retry and follow-up stay available; discarding or cancelling a partly
    // landed task does not.
    expect(failed?.stageTransitions?.map((move) => move.target)).toEqual(['do', 'done']);
    expect(failed?.actions.map((action) => action.name)).toEqual(['retry', 'followUp']);
    await expect(api.signalTask(token, task.id, 'cancel')).rejects.toThrow(/point of no return/);
    await expect(api.moveTaskStage(token, task.id, 'draft')).rejects.toThrow(/cannot move/);

    // The header's Retry and the action's retry are one recovery.
    await api.moveTaskStage(token, task.id, 'do');
    expect(starts).toHaveLength(1);
    const options = starts[0]![1];
    expect(options.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE_FAILED_ONLY');
    const recovery = options.args[0].recovery;
    expect(recovery).toMatchObject({
      world, prs, resumeStage: 'do', pointOfNoReturnPassed: true, seen: 2,
      // An authorized landing that failed becomes an integration repair: the
      // human's authorization holds, and the repaired head is reviewed again.
      repairValidationPending: true,
      landing: { authorization: 'authorized', provider: 'ejected', authorizedHeads: { 'acme/app#392': 'a1' } },
    });
    expect(recovery.messages.at(-1).text).toMatch(/recovered this task.*Workflow history size exceeds limit/s);
    // The terminated run never released its merge-queue place, and the queue
    // cannot tell it from the replacement, which shares its id.
    expect(withdrawals).toEqual(mergeQueueDomains(world as any, 'main', project.id)
      .map((domain) => `${SIG_CANCEL_MERGE}:${mergeQueueId(domain)}`));
    const resumed = (await store.getTask(task.id))?.lastView;
    expect(resumed).toMatchObject({ stage: 'do', status: 'active', pointOfNoReturnPassed: true });
    expect(resumed?.state.failedFrom).toBeUndefined();
  });

  it('sends a retried failure through human Review when the stage it failed in is unknown', async () => {
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test',
      ceiling: ['read-task', 'signal-task'], grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const project = (await store.createProject('Legacy failure', { defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({
      projectId: project.id, title: 'Failed before failedFrom', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x', base: 'main', target: 'main' },
    }));
    const world = { kind: 'e2b', id: task.id, root: '/w', branch: `tavya/${task.id}`, base: 'main', target: 'main' };
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'failed', status: 'failed',
      messages: [{ id: 'm0', role: 'user', text: 'x', ts: 0 }], transcripts: [], actions: [],
      state: { recoveryWorld: world }, pointOfNoReturnPassed: true, error: 'workflow terminated: Workflow history size exceeds limit.',
      landing: { authorization: 'authorized', validation: 'pending', provider: 'validating', authorizedHeads: {} },
      updatedAt: 1,
    } as any));
    const starts: any[] = [];
    const client = closedRunClient(task.id, starts);
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    await api.signalTask(token, task.id, 'retry');
    expect(starts[0]![1].args[0].recovery.repairValidationPending).toBeUndefined();
    expect(starts[0]![1].args[0].recovery).toMatchObject({ pointOfNoReturnPassed: true, landing: { authorization: 'authorized' } });
  });

  it('queries through a stale v1 account-wait snapshot but keeps current snapshots fast', async () => {
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task'],
      grantorCaps: ['read-task'],
    })).token;
    const project = (await store.createProject('Legacy view'));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'Old run',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'continue' },
    }));
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
    (await store.saveView(task.id, stale));
    let queries = 0;
    const live = { ...stale, status: 'active' as const, waitingFor: undefined, updatedAt: 2 };
    const client = {
      workflow: { getHandle: (id: string) => ({ query: async () => id === 'account-coordinator'
        ? { waiting: true, earliestResetAt: 123_000, detail: 'Provider usage limit reached' }
        : (queries++, live) }) },
    } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });

    expect(await api.getTaskView(token, task.id)).toMatchObject({ status: 'active', updatedAt: 2 });
    expect(queries).toBe(1);

    (await store.setTaskWorkflowVersion(task.id, '1.1.0'));
    (await store.saveView(task.id, stale));
    expect(await api.getTaskView(token, task.id)).toMatchObject({ status: 'waiting', updatedAt: 1,
      waitingFor: { kind: 'account', earliestResetAt: 123_000, detail: 'Provider usage limit reached' } });
    expect(queries).toBe(1);
  });
});
