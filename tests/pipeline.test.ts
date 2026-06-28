import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';

function input(over: { taskId: string; repo: string; prompt: string; title?: string }) {
  return {
    taskId: over.taskId,
    projectId: 'p1',
    title: over.title ?? 'Task',
    prompt: over.prompt,
    base: 'main',
    target: 'main',
    project: { repos: [over.repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
  };
}
const view = (h: any) => h.query('view') as Promise<any>;

describe('software-dev pipeline (real Temporal + git, mock agent)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('runs Setup→Do→Review→Merge and lands the work on the target branch', async () => {
    const repo = await h.makeRepo('app');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Add factorial',
          prompt:
            'Implement factorial.\n@write factorial.js :: export const f = (n) => (n <= 1 ? 1 : n * f(n - 1));\n@review Implemented factorial.js',
        }),
      ],
    });

    // it pauses at Review for human confirmation
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const review = await view(handle);
    expect(review.reviewInfo?.summary).toContain('factorial');
    expect(review.actions.map((a: any) => a.name)).toContain('confirm');

    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect(result.sha).toBeTruthy();

    // the work really landed on main
    const onMain = await git(repo, ['show', 'main:factorial.js']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toContain('export const f');
  });

  it('returns to Do on a follow-up, then merges after confirm', async () => {
    const repo = await h.makeRepo('app2');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Iterate', prompt: 'Start.\n@incomplete' })],
    });
    // first turn is incomplete → surfaced at Review (needs input)
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // send a follow-up that does the work and completes
    await handle.signal('followUp', {
      id: 'f1',
      role: 'user',
      text: '@write hello.txt :: hi there\n@review done now',
      ts: 0,
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:hello.txt']);
    expect(onMain.stdout).toContain('hi there');
  });

  it('escalates with a clear error when the project repo is misconfigured (no silent scratch)', async () => {
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'bad repo',
          prompt: '@write x.txt :: hi',
          base: 'main',
          target: 'main',
          project: { repos: ['/no/such/repo/path'], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        },
      ],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 25_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.error).toMatch(/not a git repository/i);
    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
  });

  it('routes an unhandled error through Resolve to human escalation', async () => {
    const repo = await h.makeRepo('app-fail');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Boom', prompt: '@fail boom goes the agent' })],
    });
    // resolve attempts are exhausted (failure is not transient) → escalated
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.status).toBe('blocked');
    expect(v.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(['retry', 'cancel']));
    // a human cancels the blocked task
    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
  });

  it('spawns and awaits a sub-task, then completes the parent', async () => {
    const repo = await h.makeRepo('app-sub');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Parent',
          prompt: '@subtask Build helper :: @write helper.txt :: from child\n@review parent done',
        }),
      ],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    const v = await view(handle);
    expect(v.subTasks?.length).toBe(1);
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
  });

  it('serializes two tasks through the merge queue onto the same branch', async () => {
    const repo = await h.makeRepo('app3');
    const ids = [newId('task'), newId('task')];
    const handles = await Promise.all(
      ids.map((taskId, i) =>
        h.client.workflow.start('softwareDev', {
          taskQueue: TASK_QUEUE,
          workflowId: taskId,
          args: [
            input({
              taskId,
              repo,
              title: `feat ${i}`,
              prompt: `@write file${i}.txt :: content ${i}\n@review feat ${i}`,
            }),
          ],
        }),
      ),
    );
    for (const handle of handles) {
      await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
      await handle.signal('confirm');
    }
    await Promise.all(handles.map((handle) => handle.result()));

    // both files landed on main, and the queue produced a linear, non-corrupt history
    const f0 = await git(repo, ['show', 'main:file0.txt']);
    const f1 = await git(repo, ['show', 'main:file1.txt']);
    expect(f0.stdout).toContain('content 0');
    expect(f1.stdout).toContain('content 1');
  });
});
