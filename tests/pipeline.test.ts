import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';

function input(over: { taskId: string; repo: string; prompt: string; title?: string; subtaskNagMs?: number }) {
  return {
    taskId: over.taskId,
    projectId: 'p1',
    title: over.title ?? 'Task',
    prompt: over.prompt,
    base: 'main',
    target: 'main',
    project: { repos: [over.repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
    ...(over.subtaskNagMs !== undefined ? { subtaskNagMs: over.subtaskNagMs } : {}),
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

  it('multi-repo: passes every configured repo to the agent and lands work in each', async () => {
    // A project with TWO repos → one world with a worktree per repo (each a
    // subdirectory named after the repo). The agent writes into both; the merge
    // lands the work on main in BOTH source repos.
    const fe = await h.makeRepo('frontend');
    const be = await h.makeRepo('backend');
    const feName = path.basename(fe);
    const beName = path.basename(be);
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'Wire frontend to backend',
          prompt:
            `Add a client and a server.\n` +
            `@write ${feName}/client.js :: export const call = () => fetch('/api');\n` +
            `@write ${beName}/server.js :: export const serve = () => 'ok';\n` +
            `@review Added client.js (frontend) and server.js (backend)`,
          base: 'main',
          target: 'main',
          project: { repos: [fe, be], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        },
      ],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // the work really landed on main in EACH source repo
    const feFile = await git(fe, ['show', 'main:client.js']);
    expect(feFile.code).toBe(0);
    expect(feFile.stdout).toContain('fetch');
    const beFile = await git(be, ['show', 'main:server.js']);
    expect(beFile.code).toBe(0);
    expect(beFile.stdout).toContain('serve');
    // and a real merge commit exists in each repo (point of no return, per repo)
    expect((await git(fe, ['log', '--oneline', 'main'])).stdout).toMatch(new RegExp(`merge karmax/${taskId} into main`));
    expect((await git(be, ['log', '--oneline', 'main'])).stdout).toMatch(new RegExp(`merge karmax/${taskId} into main`));
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

  it('retries a transient transport failure in-place — session resumed, Resolve never runs', async () => {
    const repo = await h.makeRepo('app-flaky');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // the exact failure shape a suspend/resume produces (2026-07-07 outage)
      args: [input({ taskId, repo, title: 'Flaky', prompt: '@write ok.txt :: hi\n@failonce API Error: Connection closed mid-response' })],
    });
    // the turn dies once (tagged 'agent-infra' → retryable), Temporal re-runs it
    // (~10s backoff) and the task reaches Review normally
    await expect.poll(async () => (await view(handle)).stage, { timeout: 60_000 }).toBe('review');
    const v = await view(handle);
    // the blip never became a Resolve case…
    const resolve = (v.transcripts ?? []).find((t: any) => t.role === 'resolve');
    expect(resolve?.messages?.length ?? 0).toBe(0);
    // …and the retry RESUMED the interrupted session (heartbeat details) instead
    // of replaying the whole turn from scratch
    const events = h.store.eventsSince(taskId, 0);
    expect(events.some((e) => e.type === 'turn.resumed')).toBe(true);
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
  });

  // Wait until the parent has surfaced a child's raise AND parked afterward (its last
  // message is the agent's turn on that raise). This guarantees the child is in
  // `awaitingResponse` and — since the mock only reads the latest message — that a
  // subsequent @respond follow-up lands on a fresh turn rather than racing the in-flight
  // turn that drained the raise. A real agent answers in the same turn it sees the raise.
  //
  // The raise MUST be a `role: 'user'` message: the real provider adapters strip
  // conversation system messages, so a system-role raise would never reach the parent
  // agent (the "parent not notified" bug). Asserting `role === 'user'` here fails fast
  // if `drainChildEvents` ever regresses to injecting the raise as a system message.
  const parentSawRaise = async (handle: any, needle: string) =>
    expect
      .poll(
        async () => {
          const msgs = (await view(handle)).messages as any[];
          const sawRaise = msgs.some((m) => m.role === 'user' && m.text.includes(needle));
          const parkedAfter = msgs.length > 0 && msgs[msgs.length - 1].role === 'agent';
          return sawRaise && parkedAfter;
        },
        { timeout: 45_000 },
      )
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

  it('an unanswered child raise re-prompts the parent instead of dead-parking it (no deadlock)', async () => {
    // Regression for the observed stall: a child reaches Review and raises to the
    // parent, but the parent's agent does NOT respond that turn. The parent must keep
    // re-entering Do to re-prompt itself (SPEC §5.3 "keep prompting"), not park on a
    // condition that can never fire (a child at Review neither re-raises nor settles).
    const repo = await h.makeRepo('app-sub-nag');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // The mock parent never emits @respond on its own, so the raise stays unanswered
      // until the human follow-up below — exactly the "agent didn't act" case.
      args: [input({ taskId, repo, title: 'Parent', prompt: '@subtask Build helper :: @write helper.txt :: from child', subtaskNagMs: 1500 })],
    });

    await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 30_000 }).toBe(1);
    // the child raises for confirmation and the parent surfaces it, then parks
    await parentSawRaise(handle, 'needs_confirmation');

    const agentTurns = async () => ((await view(handle)).messages as any[]).filter((m) => m.role === 'agent').length;
    const before = await agentTurns();
    // Without ANY human input, the parent must take further Do turns (nagging itself)
    // rather than sitting frozen — proof it is not dead-parked on an unwakeable wait.
    await expect.poll(agentTurns, { timeout: 20_000, interval: 500 }).toBeGreaterThan(before);

    // and it is still fully redirectable: the human (or a real agent) answers, and the
    // parent proceeds normally to its own Review and merges the stacked work.
    await handle.signal('followUp', { id: 'r1', role: 'user', text: '@respond confirm', ts: 0 });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:helper.txt'])).stdout).toContain('from child');
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

  it('async join: the parent does its own work in the spawning turn, and the end-stage barrier holds its completion until the child finishes', async () => {
    const repo = await h.makeRepo('app-sub-async');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // one turn: spawn a child AND do the parent's own work (non-blocking spawn), then
      // signal completion — which must be HELD until the child finishes.
      args: [
        input({
          taskId,
          repo,
          title: 'Parent',
          prompt: '@subtask Child :: @write child.txt :: from child\n@write parent.txt :: from parent',
        }),
      ],
    });

    await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 30_000 }).toBe(1);
    const childId = (await view(handle)).subTasks![0];

    // the child reaches Review and raises to the parent…
    await parentSawRaise(handle, 'needs_confirmation');

    // …and the end-stage barrier holds: the parent COMPLETED its turn but is still in
    // Do managing the child — it has NOT advanced to its own Review/PR/Merge, and
    // nothing (not even its own work) has merged to the top target yet.
    const held = await view(handle);
    expect(held.stage).toBe('do');
    expect((await git(repo, ['show', 'main:parent.txt'])).code).not.toBe(0);

    // approve the child; only now does the parent proceed to its own Review
    await handle.signal('followUp', { id: 'r1', role: 'user', text: '@respond confirm', ts: 0 });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');

    // both the parent's own work and the child's work landed on the top target
    expect((await git(repo, ['show', 'main:parent.txt'])).stdout).toContain('from parent');
    expect((await git(repo, ['show', 'main:child.txt'])).stdout).toContain('from child');
    void childId;
  }, 90_000);

  it('cancels running sub-task agents when the parent is cancelled (SPEC §5.6)', async () => {
    const repo = await h.makeRepo('app-sub-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // The child's Do turn sleeps ~30s and never reaches Review, so the parent
      // is blocked awaiting it. Cancelling the parent must tear the child down —
      // a naive parent would wait out the child's ~30s sleep.
      args: [input({ taskId, repo, title: 'Parent', prompt: '@subtask Slow child :: @sleep 30000' })],
    });

    // wait until the child has been started and the parent is awaiting it
    await expect
      .poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 20_000 })
      .toBe(1);
    const childId = (await view(handle)).subTasks![0] as string;
    const child = h.client.workflow.getHandle(childId);
    // the child's agent turn is actually running (in its ~30s sleep)
    await expect
      .poll(async () => (await (child.query('view') as Promise<any>)).stage, { timeout: 15_000 })
      .toBe('do');

    const t0 = Date.now();
    await handle.signal('cancel');

    // both the parent and the child wind down as cancelled
    const parentResult = await handle.result();
    expect(parentResult.stage).toBe('cancelled');
    const childResult = (await child.result()) as { stage: string };
    expect(childResult.stage).toBe('cancelled');

    // it did NOT wait out the child's ~30s sleep
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('never lands conflict markers: a conflicted merge loops back to the merge agent, then escalates', async () => {
    const repo = await h.makeRepo('app-conflict');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Conflicting change', prompt: '@write index.js :: console.log("attempt")' })],
    });

    // parked at Review — diverge main underneath it, so the merge will conflict
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log("mainline")\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'diverge']);
    await handle.signal('confirm');

    // the mock merge agent can't resolve conflicts → bounded loop-back, then escalate
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.error).toMatch(/merge failed/);
    expect(v.error).toContain('index.js');
    // the merge agent got the conflict context on its retry turns
    const mergeTranscript = v.transcripts.find((t: any) => t.role === 'merge');
    expect(mergeTranscript.messages.map((m: any) => m.text).join('\n')).toContain('rejected');

    // the target never got the markers — main is pristine
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).toContain('mainline');
    expect(onMain.stdout).not.toContain('<<<<<<<');

    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
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

  it('multi-repo merge queue: three pairwise-overlapping tasks drain without deadlock (ordered acquisition)', async () => {
    // The classic circular-wait setup (dining philosophers): three repos, three
    // tasks each touching a different PAIR — A&B, A&C, B&C. A naive "grab a slot
    // in every repo's queue at once" scheme can deadlock (each task holds one
    // repo and waits on another in a cycle). Ordered acquisition (sorted repo
    // order, one at a time) makes a cycle impossible, so all three must finish.
    const A = await h.makeRepo('repoA');
    const B = await h.makeRepo('repoB');
    const C = await h.makeRepo('repoC');
    const nm = (r: string) => path.basename(r);

    const specs = [
      { label: 'AB', repos: [A, B] },
      { label: 'AC', repos: [A, C] },
      { label: 'BC', repos: [B, C] },
    ];
    const started = specs.map((s) => {
      const taskId = newId('task');
      // write a distinct file into each of the task's two repos
      const prompt =
        s.repos.map((r) => `@write ${nm(r)}/from-${s.label}.txt :: ${s.label} in ${nm(r)}`).join('\n') +
        `\n@review ${s.label} touched ${s.repos.map(nm).join(' + ')}`;
      const handle = h.client.workflow.start('softwareDev', {
        taskQueue: TASK_QUEUE,
        workflowId: taskId,
        args: [
          {
            taskId,
            projectId: 'p1',
            title: `task ${s.label}`,
            prompt,
            base: 'main',
            target: 'main',
            project: { repos: s.repos, defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
          },
        ],
      });
      return { s, taskId, handle };
    });
    const runs = await Promise.all(started.map(async (r) => ({ ...r, handle: await r.handle })));

    // Drive every task to Review and confirm — they now all contend at Merge.
    for (const r of runs) {
      await expect.poll(async () => (await view(r.handle)).stage, { timeout: 20_000 }).toBe('review');
    }
    for (const r of runs) await r.handle.signal('confirm');

    // If ordered acquisition were wrong, the shared queues would deadlock and
    // these never resolve — the result() await is the deadlock detector.
    const results = await Promise.all(runs.map((r) => r.handle.result()));
    for (const res of results) expect(res.stage).toBe('done');

    // Every repo received the work from BOTH tasks that touched it, landed on main.
    for (const [repo, labels] of [
      [A, ['AB', 'AC']],
      [B, ['AB', 'BC']],
      [C, ['AC', 'BC']],
    ] as const) {
      for (const label of labels) {
        const shown = await git(repo, ['show', `main:from-${label}.txt`]);
        expect(shown.code, `from-${label}.txt should be on main of ${path.basename(repo)}`).toBe(0);
        expect(shown.stdout).toContain(label);
      }
    }
  });
});
