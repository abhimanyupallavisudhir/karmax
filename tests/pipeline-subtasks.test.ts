import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, input, view } from './helpers/pipeline-harness.js';

describe('software-dev pipeline: sub-tasks and in-harness sub-agents (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

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

  // #396 review item 8: a running child's follow-up gate asks its workflow only
  // after a journal entry. The parent's answer is pushed by the parent workflow,
  // so without one it waited for the 30 s backstop instead of the next poll.
  it('a parent comment reaches its running child mid-turn within the follow-up latency', async () => {
    const repo = await h.makeRepo('app-sub-comment');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Parent', prompt: '@subtask Long child :: @sleep 60000' })],
    });
    try {
      await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 30_000 }).toBe(1);
      const childId = (await view(handle)).subTasks![0];
      const child = h.client.workflow.getHandle(childId);
      await expect.poll(async () => ((await child.query('view')) as any).agentTurn?.state, { timeout: 30_000 }).toBe('running');
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // past the turn's first, unconditional query
      const sent = Date.now();
      await handle.signal('followUp', { id: 'c1', role: 'user', text: `@respond comment ${childId} :: @run echo parent-says-hello`, ts: 0 });
      await expect.poll(async () => (await h.store.eventsOfType(childId, 'agent.output'))
        .some((event) => String(event.payload.text).includes('parent-says-hello')), { timeout: 40_000, interval: 200 }).toBe(true);
      expect(Date.now() - sent).toBeLessThan(12_000);
    } finally {
      await handle.signal('cancel');
      await handle.result();
    }
  }, 120_000);

  it('spawns more than 50 children without per-parent concurrent or lifetime caps', async () => {
    const repo = await h.makeRepo('app-sub-unlimited');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId, repo, title: 'Parent',
        prompt: Array.from({ length: 51 }, (_, i) => `@subtask Child ${i} :: @incomplete`).join('\n'),
      })],
    });
    try {
      // Children cannot complete without input, so all 51 remain outstanding.
      // This crosses both former limits (8 concurrent and 50 over the task's life).
      await expect.poll(async () => (await view(handle)).subTasks?.length, { timeout: 120_000 }).toBe(51);
      expect((await view(handle)).messages.some((m: any) => m.text.includes('was NOT spawned'))).toBe(false);
    } finally {
      await handle.signal('cancel');
      expect((await handle.result()).stage).toBe('cancelled');
      const children = (await view(handle)).subTasks ?? [];
      for (const childId of children) {
        expect((await h.client.workflow.getHandle(childId).result() as any).stage).toBe('cancelled');
      }
    }
  }, 180_000);

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

  it('holds Do→Review while the agent is still waiting on its own in-harness sub-agents (Task tool)', async () => {
    const repo = await h.makeRepo('app-subagents');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // The agent does its work and signals completion in turn one, but reports that
      // several in-harness sub-agents (Claude Agent SDK Task tool) are still running.
      // Completion is "done AND not waiting on any sub-agents", so it must NOT advance
      // to Review — it is held in Do (waitingFor 'subagent') until the count drains.
      args: [input({ taskId, repo, title: 'Subagents', prompt: '@write out.txt :: hi\n@review Implemented out.txt\n@subagents 3', subagentWaitMs: 1500 })],
    });

    // It surfaces as held-in-Do, waiting on its sub-agents — NOT advanced to Review.
    await expect
      .poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind ?? '-'}`; }, { timeout: 20_000 })
      .toBe('do/subagent');
    // …and nothing has advanced to Review/Merge while it waits.
    expect((await git(repo, ['show', 'main:out.txt'])).code).not.toBe(0);

    // Once the sub-agents drain (count → 0), it advances to Review on its own.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    // the work landed only after the sub-agents were done
    expect((await git(repo, ['show', 'main:out.txt'])).stdout).toContain('hi');
  }, 60_000);

  it('gives up on a wedged sub-agent after the nudge budget, and surfaces a Review note', async () => {
    const repo = await h.makeRepo('app-subagents-wedged');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // 8 sub-agents drain by one per turn — more than MAX_SUBAGENT_NUDGES (5), so the
      // count is still > 0 when the budget is spent. The task must then proceed to
      // Review (liveness, never park forever) with a note that a sub-agent may be wedged.
      args: [input({ taskId, repo, title: 'Wedged', prompt: '@write out.txt :: hi\n@review Implemented out.txt\n@subagents 8', subagentWaitMs: 300 })],
    });

    // It advances to Review despite sub-agents still being reported as running…
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const review = await view(handle);
    // …and the reviewer is told why (a sub-agent may be wedged and its output missing).
    expect(review.reviewInfo?.summary).toContain('sub-agent(s) still reported running');
    expect(review.reviewInfo?.summary).toContain('may be wedged');

    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:out.txt'])).stdout).toContain('hi');
  }, 60_000);

  it('holds Do→Review while the agent left a run_in_background shell running (task 130)', async () => {
    const repo = await h.makeRepo('app-shells');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // The agent did its work but ended the turn WITHOUT signalling completion, leaving a
      // backgrounded shell (e.g. `npm test`) running — the exact task-130 shape. It must NOT
      // fall straight through to Review: held in Do (waitingFor 'shell') until the shell drains.
      //
      // `subagentWaitMs` sets how long the hold lasts (2 shells drain one per turn). It is
      // deliberately generous: the assertion below polls for a TRANSIENT state, and on a
      // loaded host the first query can land seconds after the workflow starts. A short hold
      // let the window close before the first sample and the test flaked as `review/human`.
      args: [input({ taskId, repo, title: 'Shells', prompt: '@write out.txt :: hi\n@review Implemented out.txt\n@shells 2\n@incomplete', subagentWaitMs: 5000 })],
    });

    await expect
      .poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind ?? '-'}`; }, { timeout: 20_000 })
      .toBe('do/shell');
    // nothing landed while it waits
    expect((await git(repo, ['show', 'main:out.txt'])).code).not.toBe(0);

    // Once the shell settles (count → 0) it advances to Review on its own.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:out.txt'])).stdout).toContain('hi');
  }, 60_000);

  it('gives up on a long-lived background shell after a small budget, with a Review note', async () => {
    const repo = await h.makeRepo('app-shells-devserver');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // 6 drains > MAX_SHELL_NUDGES (3): the shell is still reported running when the budget
      // is spent (models a dev server left running on purpose). It must proceed to Review
      // (never park forever) with a note that a background job's result may be missing.
      args: [input({ taskId, repo, title: 'DevServer', prompt: '@write out.txt :: hi\n@review Implemented out.txt\n@shells 6\n@incomplete', subagentWaitMs: 300 })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const review = await view(handle);
    expect(review.reviewInfo?.summary).toContain('background job(s) still running');

    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:out.txt'])).stdout).toContain('hi');
  }, 60_000);

  // videos #1: a render the agent ran from its own shell died with its turn. A durable
  // job outlives the turn, and `pause` resumes the agent with the job's result. The job
  // prints a mock directive, so the resumed agent acting on it proves the job's output
  // reached the agent's next turn.
  it('resumes the agent with a durable job\'s result once the job finishes', async () => {
    const repo = await h.makeRepo('app-job-wait');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Render', prompt: '@namedjob render :: sleep 3; echo "@write out.txt :: rendered"\n@pause 30 :: last' })],
    });

    // Parked on the job, shown by its name, with the latest resume time.
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 20_000 }).toBe('job');
    const parked = await view(handle);
    expect(parked.stage).toBe('do');
    expect(parked.waitingFor.detail).toMatch(/^Waiting for job-[a-f0-9]{8}$/);
    expect(parked.waitingFor.summary).toBe('render');
    expect(parked.waitingFor.jobs).toEqual([parked.waitingFor.detail.slice('Waiting for '.length)]);
    expect(parked.waitingFor.until).toBeGreaterThan(Date.now() + 25 * 60_000);

    // The job finishes; the agent is resumed with its output and acts on it.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:out.txt'])).stdout).toContain('rendered');
  }, 60_000);

  it('asks the agent once about a job it left running, instead of waiting on it silently', async () => {
    const repo = await h.makeRepo('app-job-unattended');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // The agent starts a job and ends its turn without pause or open_pr — the
      // videos #1 mistake, or a job that is simply runaway. The task must not sit on
      // it: the agent decides (pause for it, or stop it), and is asked exactly once.
      args: [input({ taskId, repo, title: 'Unattended', prompt: '@write out.txt :: hi\n@job sleep 120\n@incomplete' })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const reviewed = await view(handle);
    const reminders = reviewed.messages.filter((m: any) => /still running/.test(m.text) && /stop_job/.test(m.text));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].text).toMatch(/job-[a-f0-9]{8}/);
    expect(reminders[0].text).toContain('pause');
    // The task never parked on the job.
    const kinds = (await h.store.eventsOfType(taskId, 'view.updated')).map((e: any) => e.payload.waitingFor);
    expect(kinds).not.toContain('job');
    await handle.signal('cancel');
    await handle.result();
  }, 60_000);

  it('a timed pause resumes the agent when it elapses, or earlier on a message', async () => {
    const repo = await h.makeRepo('app-pause');
    const elapsesId = newId('task');
    const elapses = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: elapsesId,
      // One "minute" is 1.5 s here; the pause alone must bring the agent back.
      args: [input({ taskId: elapsesId, repo, title: 'Pause', prompt: '@write out.txt :: paused\n@pause 2', waitMinuteMs: 1500 })],
    });
    await expect.poll(async () => (await view(elapses)).waitingFor?.kind, { timeout: 20_000 }).toBe('timer');
    await expect.poll(async () => (await view(elapses)).stage, { timeout: 30_000 }).toBe('review');
    await elapses.signal('cancel');
    await elapses.result();

    const earlyId = newId('task');
    const early = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: earlyId,
      args: [input({ taskId: earlyId, repo, title: 'Pause', prompt: '@pause 600' })],
    });
    await expect.poll(async () => (await view(early)).waitingFor?.kind, { timeout: 20_000 }).toBe('timer');
    const until = (await view(early)).waitingFor.until;
    expect(until).toBeGreaterThan(Date.now() + 9 * 60 * 60_000);
    await early.signal('followUp', { id: 'wake', role: 'user', text: '@write early.txt :: woke', ts: 0 });
    await expect.poll(async () => (await view(early)).stage, { timeout: 30_000 }).toBe('review');
    await early.signal('confirm');
    expect((await early.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:early.txt'])).stdout).toContain('woke');
  }, 90_000);

  // An agent that needed an answer but paused (to carry on if none came) read
  // "Paused" and notified nobody. needs_input parks the same pause as an ask.
  it('a needs-input pause asks for an answer, and carries on without one when the time is up', async () => {
    const repo = await h.makeRepo('app-pause-input');
    const unansweredId = newId('task');
    const unanswered = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: unansweredId,
      args: [input({ taskId: unansweredId, repo, title: 'Ask', prompt: '@write out.txt :: asked\n@pause 2 :: input high -- Which region?', waitMinuteMs: 1500 })],
    });
    await expect.poll(async () => (await view(unanswered)).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    const asking = await view(unanswered);
    expect(asking).toMatchObject({ stage: 'do', status: 'waiting' });
    expect(asking.waitingFor).toMatchObject({ detail: 'Which region?', audience: ['@creator'], urgency: 'high' });
    expect(asking.waitingFor.until).toBeGreaterThan(Date.now());
    // The published lifecycle tick is the ask the inbox notifies on.
    const ticks = (await h.store.eventsOfType(unansweredId, 'view.updated')).map((e: any) => e.payload);
    expect(ticks).toContainEqual(expect.objectContaining({ waitingFor: 'human', waitingDetail: 'Which region?', urgency: 'high' }));
    // Nobody answers: the agent is told so and carries on.
    await expect.poll(async () => (await view(unanswered)).stage, { timeout: 30_000 }).toBe('review');
    expect((await view(unanswered)).messages.some((m: any) => m.role === 'user' && /nobody answered within your 2-minute limit/.test(m.text))).toBe(true);
    await unanswered.signal('cancel');
    await unanswered.result();

    // An answer resumes it at once, with the answer.
    const answeredId = newId('task');
    const answered = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: answeredId,
      args: [input({ taskId: answeredId, repo, title: 'Ask', prompt: '@pause 600 :: input' })],
    });
    await expect.poll(async () => (await view(answered)).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    const waiting = (await view(answered)).waitingFor;
    expect(waiting.detail).toBeTruthy();
    expect(waiting.urgency).toBeUndefined();
    expect(waiting.until).toBeGreaterThan(Date.now() + 9 * 60 * 60_000);
    await answered.signal('followUp', { id: 'answer', role: 'user', text: '@write region.txt :: eu-west', ts: 0 });
    await expect.poll(async () => (await view(answered)).stage, { timeout: 30_000 }).toBe('review');
    await answered.signal('confirm');
    expect((await answered.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:region.txt'])).stdout).toContain('eu-west');
  }, 90_000);

  it('cancelling a task stops its durable jobs', async () => {
    const repo = await h.makeRepo('app-job-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Cancel', prompt: '@job sleep 300\n@pause 30 :: last' })],
    });
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 20_000 }).toBe('job');
    const root = (await view(handle)).world.root as string;
    const jobs = fs.readdirSync(path.join(root, '.karmax-injection/jobs'));
    const pid = Number(fs.readFileSync(path.join(root, '.karmax-injection/jobs', jobs[0]!, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await handle.signal('cancel');
    await handle.result();
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; } }, { timeout: 15_000 }).toBe('gone');
  }, 60_000);

  it('cancels running sub-task agents when the parent is cancelled (SPEC §5.6)', async () => {
    const repo = await h.makeRepo('app-sub-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.6.0', {
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
    // `stage: do` is published before host admission and activity startup, so it
    // is not proof that the child's ~30s provider turn is in flight. Synchronize
    // on the cancellation-aware activity state to exercise the intended case and
    // avoid racing cancellation against startup on a loaded CI runner.
    await expect
      .poll(async () => (await (child.query('view') as Promise<any>)).agentTurn?.state, { timeout: 20_000 })
      .toBe('running');

    const t0 = Date.now();
    await handle.signal('cancel');

    // both the parent and the child wind down as cancelled
    const parentResult = await handle.result();
    expect(parentResult.stage).toBe('cancelled');
    const childResult = (await child.result()) as { stage: string };
    expect(childResult.stage).toBe('cancelled');

    // it did NOT wait out the child's ~30s sleep
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
});
