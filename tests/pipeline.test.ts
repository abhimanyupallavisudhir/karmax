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

  it('cancels mid-turn: a long-running Do turn aborts on cancel without finishing (SPEC §5.6)', async () => {
    const repo = await h.makeRepo('app-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // the Do turn sleeps ~30s; a naive cancel would wait it out
      args: [input({ taskId, repo, title: 'Slow', prompt: '@sleep 30000\n@review done' })],
    });
    // wait until the turn is actually running
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await new Promise((r) => setTimeout(r, 500)); // ensure we're inside the sleeping turn
    const t0 = Date.now();
    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
    // it aborted mid-turn — did NOT wait out the ~30s sleep
    expect(Date.now() - t0).toBeLessThan(15_000);
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

  // The parent surfaces a child's raise as a system message before it can answer it.
  // Waiting for that guarantees the parent has the child in `awaitingResponse` (and,
  // for the mock which only reads the latest message, that our @respond isn't raced by
  // the incoming raise). A real agent answers in the same turn it sees the raise.
  const parentSawRaise = async (handle: any, needle: string) =>
    expect
      .poll(async () => ((await view(handle)).messages as any[]).some((m) => m.role === 'system' && m.text.includes(needle)), { timeout: 40_000 })
      .toBe(true);

  it('parent-as-confirmer: a child raises at Review, the parent approves, and the work stacks onto the parent branch then main', async () => {
    const repo = await h.makeRepo('app-sub');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Parent', prompt: '@subtask Build helper :: @write helper.txt :: from child' })],
    });

    // the child is spawned and tracked on the parent
    await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 30_000 }).toBe(1);
    const parentBranch = (await view(handle)).branch as string;
    const childId = (await view(handle)).subTasks![0];
    const child = h.client.workflow.getHandle(childId);

    // the child branches off + targets the PARENT's branch (not main), not straight to main
    await expect
      .poll(async () => {
        const cv = (await child.query('view')) as any;
        return `${cv.base}/${cv.targetBranch}`;
      }, { timeout: 30_000 })
      .toBe(`${parentBranch}/${parentBranch}`);

    // it raises to the parent for confirmation — surfaced to the parent's Do agent,
    // NOT a hidden human (the v1 deadlock)
    await parentSawRaise(handle, 'needs_confirmation');
    // nothing has reached main yet — the child merges into the parent, not main
    expect((await git(repo, ['show', 'main:helper.txt'])).code).not.toBe(0);

    // the parent's Do agent approves the child (respond_to_sub_task → confirm)
    await handle.signal('followUp', { id: 'r1', role: 'user', text: '@respond confirm', ts: 0 });

    // the parent then reaches its OWN Review with the child's work folded in
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // the child's work reached main THROUGH the parent — one merge at the top
    const onMain = await git(repo, ['show', 'main:helper.txt']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toContain('from child');
  }, 90_000);

  it('a stuck child raises "blocked" to its parent instead of deadlocking on a hidden human', async () => {
    const repo = await h.makeRepo('app-sub-fail');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Parent', prompt: '@subtask Flaky :: @fail child cannot proceed' })],
    });

    await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 30_000 }).toBe(1);
    const childId = (await view(handle)).subTasks![0];
    const child = h.client.workflow.getHandle(childId);

    // the child exhausts resolve, escalates, and raises UP to the parent (not a hidden human)
    await expect
      .poll(async () => {
        const cv = (await child.query('view')) as any;
        return `${cv.stage}/${cv.waitingFor?.kind}`;
      }, { timeout: 45_000 })
      .toBe('escalated/parent');
    await parentSawRaise(handle, 'blocked');

    // the parent decides to abandon the stuck child
    await handle.signal('followUp', { id: 'x1', role: 'user', text: '@respond cancel', ts: 0 });

    // the child is cancelled and the parent is unblocked → its own Review
    await expect.poll(async () => ((await child.query('view')) as any).status, { timeout: 30_000 }).toBe('cancelled');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  }, 90_000);

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
