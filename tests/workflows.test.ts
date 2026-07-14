import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';

const view = (h: any) => h.query('view') as Promise<any>;
const baseInput = (taskId: string, repo: string, over: any = {}) => ({
  taskId,
  projectId: 'p1',
  title: over.title ?? 'Task',
  prompt: over.prompt ?? '',
  base: 'main',
  target: 'main',
  project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
  ...over,
});

describe('the v1 workflow family (real Temporal + git, mock agent)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('just-do: a single agent call, work committed to the branch (no merge)', async () => {
    const repo = await h.makeRepo('jd');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('justDo', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'note', prompt: '@write note.txt :: a quick note' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    // committed to the task branch, NOT merged to main
    const onBranch = await git(repo, ['show', `karmax/${taskId}:note.txt`]);
    expect(onBranch.stdout).toContain('a quick note');
    const onMain = await git(repo, ['cat-file', '-e', 'main:note.txt']);
    expect(onMain.code).not.toBe(0);
  });

  it('just-do: injects a follow-up sent mid-turn into the live turn (SPEC §5.6)', async () => {
    const repo = await h.makeRepo('jd-mid');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('justDo', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // A ~3s turn — a window to send a follow-up while the single Do turn runs.
      args: [baseInput(taskId, repo, { title: 'mid', prompt: '@sleep 3000\n@write base.txt :: base' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await new Promise((r) => setTimeout(r, 700));
    await handle.signal('followUp', { id: 'm1', role: 'user', text: '@write injected.txt :: from a live follow-up', ts: 0 });
    // The follow-up is executed in the SAME turn (in-flight), so the turn reaches Review
    // with BOTH files written and no second Do turn.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const injected = await git(repo, ['show', `karmax/${taskId}:injected.txt`]);
    expect(injected.stdout).toContain('from a live follow-up');
    const base = await git(repo, ['show', `karmax/${taskId}:base.txt`]);
    expect(base.stdout).toContain('base');
  });

  it('script-exec: runs a command and captures its output', async () => {
    const repo = await h.makeRepo('se');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('scriptExec', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'echo', command: 'echo karmax-rocks' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const v = await view(handle);
    expect(JSON.stringify(v.messages)).toContain('karmax-rocks');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    expect(res.code).toBe(0);
  });

  it('goal: completes and merges without a human review gate', async () => {
    const repo = await h.makeRepo('goal');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('goal', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'reach goal', prompt: '@write goal.txt :: achieved\n@review goal done' })],
    });
    // no confirm sent — goal auto-confirms and merges
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:goal.txt']);
    expect(onMain.stdout).toContain('achieved');
  });

  it('merge-only: reviews and merges an existing branch (the dogfooded gate)', async () => {
    const repo = await h.makeRepo('mo');
    // build an existing feature branch with work
    await git(repo, ['checkout', '-q', '-b', 'feature']);
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature work\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'feat']);
    await git(repo, ['checkout', '-q', 'main']);

    const taskId = newId('task');
    const handle = await h.client.workflow.start('mergeOnly', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'merge feature', branch: 'feature', target: 'main' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:feat.txt']);
    expect(onMain.stdout).toContain('feature work');
  });

  it('account coordinator: leases account capacity and frees it on return', async () => {
    // a grantee workflow that simply exists to receive the grant signal
    const grantee = newId('task');
    const ping = await h.client.workflow.start('pingWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: grantee,
      args: ['x'],
    });
    const coord = await h.client.workflow.start('accountCoordinator', {
      taskQueue: TASK_QUEUE,
      workflowId: accountCoordinatorId(),
      args: [{ state: { accounts: [{ id: 'acct1', configHome: '/tmp/ch', provider: 'claude', maxConcurrent: 1, inUse: 0, status: 'available' }], queue: [], processed: 0 } }],
    });
    await coord.signal('leaseAccount', { taskId: grantee, turnId: 't1', provider: 'claude' });
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(1);
    const used = ((await coord.query('accounts')) as any).accounts[0];
    expect(used.status).toBe('available');
    expect(used.provider).toBe('claude');
    await coord.signal('returnAccount', { accountId: 'acct1' });
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(0);

    await ping.signal('finish');
    await ping.result();
    await coord.terminate('test done');
  });

  it('leases an account per turn when a pool is registered, then returns it', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coordClient = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    // Register a pool (creates the singleton coordinator via the new signal path).
    await coordClient.registerAccounts([{ id: 'mock:work', configHome: '/tmp/karmax-ch-work', provider: 'mock', maxConcurrent: 2 }]);
    const coord = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);

    const repo = await h.makeRepo('leased');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'Leased', prompt: 'Do it.\n@write a.txt :: hi\n@review done' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // The do-turn leased the account and returned it (inUse back to 0, still available).
    const acct = ((await coord.query('accounts')) as any).accounts[0];
    expect(acct.provider).toBe('mock');
    expect(acct.status).toBe('available');
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(0);
    await coord.terminate('test done');
  });

  it('merge queue reorders: prioritize (top), move-to-bottom, and drag (insert-before)', async () => {
    const { mergeQueueId } = await import('../src/coordinators/names.js');
    const domain = 'repo:main';
    // Seed with a held slot so the coordinator parks instead of draining the queue.
    const wf = await h.client.workflow.start('mergeQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: mergeQueueId(domain),
      args: [{ domain, state: { domain, queue: ['t1', 't2', 't3'], current: 'held', processed: 0 } }],
    });
    const q = async () => ((await wf.query('queue')) as any).queue as string[];
    expect(await q()).toEqual(['t1', 't2', 't3']);

    // Move to top (the old "Prioritize").
    await wf.signal('prioritize', { taskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t3', 't1', 't2']);

    // Move to bottom (reorder with no anchor).
    await wf.signal('reorderQueue', { taskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t1', 't2', 't3']);

    // Drag: place t1 immediately before t3.
    await wf.signal('reorderQueue', { taskId: 't1', beforeTaskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t2', 't1', 't3']);

    // Unknown anchor → falls to the bottom.
    await wf.signal('reorderQueue', { taskId: 't2', beforeTaskId: 'gone' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t1', 't3', 't2']);

    await wf.terminate('test done');
  });

  it('agent queue owns capacity and supports durable waiting-order changes', async () => {
    const { agentQueueId } = await import('../src/coordinators/names.js');
    const held = [
      { taskId: 'running-1', turnId: 'running-1#0', role: 'do' },
      { taskId: 'running-2', turnId: 'running-2#0', role: 'confirm' },
    ];
    const waiting = [
      { taskId: 't1', turnId: 't1#0', role: 'do' },
      { taskId: 't2', turnId: 't2#0', role: 'merge' },
      { taskId: 't3', turnId: 't3#0', role: 'resolve' },
    ];
    const wf = await h.client.workflow.start('agentQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: `${agentQueueId()}:reorder-test`,
      args: [{ capacity: 2, state: { capacity: 2, current: held, queue: waiting, processed: 0 } }],
    });
    const q = async () => await wf.query('agentQueue') as any;
    expect((await q()).queue.map((x: any) => x.turnId)).toEqual(['t1#0', 't2#0', 't3#0']);

    await wf.signal('reorderQueue', { turnId: 't3#0', beforeTurnId: 't1#0' });
    await expect.poll(async () => (await q()).queue.map((x: any) => x.turnId), { timeout: 10_000 }).toEqual(['t3#0', 't1#0', 't2#0']);

    await wf.signal('setAgentCapacity', { capacity: 1 });
    await expect.poll(async () => (await q()).capacity, { timeout: 10_000 }).toBe(1);
    expect((await q()).current).toHaveLength(2); // shrinking never kills running turns
    await wf.terminate('test done');
  });
});
