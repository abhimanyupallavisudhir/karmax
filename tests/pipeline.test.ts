import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';

function input(over: { taskId: string; repo: string; prompt: string; title?: string; subtaskNagMs?: number; subagentWaitMs?: number; recovery?: any; resolveAgentEnabled?: boolean }) {
  return {
    taskId: over.taskId,
    projectId: 'p1',
    title: over.title ?? 'Task',
    prompt: over.prompt,
    base: 'main',
    target: 'main',
    project: { repos: [over.repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
    ...(over.subtaskNagMs !== undefined ? { subtaskNagMs: over.subtaskNagMs } : {}),
    ...(over.subagentWaitMs !== undefined ? { subagentWaitMs: over.subagentWaitMs } : {}),
    ...(over.resolveAgentEnabled !== undefined ? { resolveAgentEnabled: over.resolveAgentEnabled } : {}),
    ...(over.recovery ? { recovery: over.recovery } : {}),
  };
}
const view = (h: any) => h.query('view') as Promise<any>;

describe('software-dev pipeline (real Temporal + git, mock agent)', () => {
  let h: Harness;
  let cancellationCleanupFinishedAt = 0;
  beforeAll(async () => {
    const mock = new MockAdapter();
    const restartSession = 'restart-regression-session';
    // Model the real Claude/Codex shutdown behaviour: provider cleanup consumes the
    // AbortError and returns partial output. The runtime boundary must still reject
    // that result so Temporal retries the activity after the worker comes back.
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.messages.some((m) => m.text.includes('@cancel-cleanup-regression'))) {
          const pulse = setInterval(() => {
            try { ctx.heartbeat?.(); } catch { /* cancellation is delivered through the signal */ }
          }, 50);
          await new Promise<void>((resolve) => {
            if (ctx.signal?.aborted) return resolve();
            ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          clearInterval(pulse);
          // Model provider cleanup/reaping that continues after it observes abort.
          await new Promise((resolve) => setTimeout(resolve, 300));
          cancellationCleanupFinishedAt = Date.now();
          return { termination: { kind: 'success', status: 'mock.completed' }, output: 'cancelled partial output' };
        }
        const restartCase = input.session === restartSession || input.messages.some((m) => m.text.includes('@restart-regression'));
        if (!restartCase) return mock.runTurn(input, ctx);
        if (input.session === restartSession) {
          ctx.signalCompletion('resumed after restart');
          return { termination: { kind: 'success', status: 'mock.completed' }, session: restartSession, output: 'resumed and completed' };
        }
        ctx.onSession?.(restartSession);
        ctx.heartbeat?.();
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve();
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { termination: { kind: 'success', status: 'mock.completed' }, session: restartSession, output: 'partial output from interrupted turn' };
      },
    };
    h = await bootHarness('mock', adapter);
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
    // @review sets the terse caption; the git-derived summary/changedFiles are added automatically.
    expect(review.reviewInfo?.caption).toContain('factorial');
    expect(review.actions.map((a: any) => a.name)).toContain('confirm');
    // The agent called signal_completion (mock default), so the gate marks it as an
    // asserted finish rather than a silent stall.
    expect(review.reviewInfo?.completion).toBe('signalled');

    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect(result.sha).toBeTruthy();

    // the work really landed on main
    const onMain = await git(repo, ['show', 'main:factorial.js']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toContain('export const f');
  });

  it('restarts an interrupted turn in Do instead of accepting partial output as Review (Task 162)', async () => {
    const repo = await h.makeRepo('restart-do-stage');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Restart in Do', prompt: '@restart-regression' })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await expect.poll(() => h.store.kvGet(`session:${taskId}:do`), { timeout: 15_000 }).toBe('restart-regression-session');

    await h.restartWorker();

    // The swallowed provider abort is an interrupted activity, not a turn boundary.
    // Durable replay therefore restores the originating stage until the retry runs.
    expect((await view(handle)).stage).toBe('do');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const resumed = await view(handle);
    expect(resumed.reviewInfo?.completion).toBe('signalled');
    expect(resumed.messages.some((m: any) => m.text === 'partial output from interrupted turn')).toBe(false);

    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  });

  it('marks a Review reached without signal_completion as a stall, so the reviewer is warned', async () => {
    const repo = await h.makeRepo('app');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Half-finished change',
          // The agent writes a file but does NOT signal completion (@incomplete) — it went
          // quiet mid-task. It still surfaces at Review (needsInput), but flagged as a stall.
          prompt: 'Start the work.\n@write half.js :: export const x = 1;\n@incomplete',
        }),
      ],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const review = await view(handle);
    expect(review.reviewInfo?.completion).toBe('stalled');
    // The distinction is real, not cosmetic: a stall is never auto-confirmed, so the task
    // waits at the human gate rather than advancing.
    expect(review.actions.map((a: any) => a.name)).toContain('confirm');
  });

  it('v1.2 treats verified provider completion as finished without requiring signal_completion', async () => {
    const repo = await h.makeRepo('provider-completion');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.2.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Provider-completed change',
          prompt: 'Implement the change.\n@write finished.js :: export const finished = true;\n@incomplete',
        }),
      ],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const review = await view(handle);
    expect(review.reviewInfo?.completion).toBe('finished');
    expect(review.reviewInfo?.completion).not.toBe('stalled');
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
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

  it('multi-PR: the agent adds a second branch, and BOTH land as their own merges', async () => {
    // Multi-PR (SPEC §11.1): one task, one Do agent, one Review, one Merge — but
    // the change is partitioned across two branches, each landing as its own pull
    // request. The world nests its checkouts so the branch added mid-turn has
    // somewhere to live, and `@branch` takes effect immediately, so the very same
    // turn writes into it.
    const repo = await h.makeRepo('app');
    const name = path.basename(repo);
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.9.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'Split the change',
          prompt:
            `Refactor, then build on it.\n` +
            // The agent's cwd IS its checkout, so the second branch is a sibling
            // directory — exactly how a real agent reaches it.
            `@write core.js :: export const core = 1;\n` +
            `@branch docs\n` +
            `@run echo '# docs' > ../docs/README.md\n` +
            `@review core.js in the main branch, README.md in a second one`,
          base: 'main',
          target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true },
        },
      ],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const review = await view(handle);
    // Review sees both branches, each with its head, and neither approved yet.
    expect(review.checkouts?.map((c: any) => c.name)).toEqual([name, 'docs']);
    expect(review.checkouts.every((c: any) => c.head)).toBe(true);
    expect(review.checkouts.some((c: any) => c.approved)).toBe(false);

    // Approving ONE branch marks it without passing the gate — only confirm does
    // that, so the authorization/quorum rules around confirm cannot be routed past.
    await handle.signal('approveCheckout', { name: 'docs' });
    await expect.poll(async () => (await view(handle)).checkouts.find((c: any) => c.name === 'docs')?.approved,
      { timeout: 5_000 }).toBe(true);
    expect((await view(handle)).stage).toBe('review');

    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // Both branches really landed on main, each through its OWN merge commit —
    // two reviewable units, not one squashed blob.
    expect((await git(repo, ['show', 'main:core.js'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:README.md'])).code).toBe(0);
    const log = (await git(repo, ['log', '--oneline', 'main'])).stdout;
    expect(log).toMatch(new RegExp(`merge karmax/${taskId} into main`));
    expect(log).toMatch(new RegExp(`merge karmax/${taskId}-docs into main`));
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

  it('injects a follow-up sent WHILE a turn is running INTO that live turn (SPEC §5.6)', async () => {
    // A follow-up that arrives mid-turn is polled from the workflow (pendingMessages
    // query) and injected into the LIVE agent session — it is executed in the SAME
    // turn, not deferred to the next one, and never dropped nor re-concatenated.
    const repo = await h.makeRepo('app-midturn');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // Turn one sleeps ~3s — a window to send a follow-up while the turn is running.
      // The mock polls for follow-ups between sleep steps and processes them in-flight.
      args: [input({ taskId, repo, title: 'Mid-turn', prompt: '@sleep 3000\n@review turn one' })],
    });
    // wait until the Do turn is actually running, then send the follow-up MID-turn
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await new Promise((r) => setTimeout(r, 700)); // ensure we're inside the sleeping turn
    await handle.signal('followUp', {
      id: 'mid1',
      role: 'user',
      text: '@write mid.txt :: delivered after all',
      ts: 0,
    });
    // The single Do turn folds the follow-up in: its reply proves the directive was
    // injected + executed in-flight.
    await expect
      .poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'agent' && m.text?.includes('wrote mid.txt')), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    // In-flight, NOT next-turn: exactly one Do turn ran, so there is exactly one agent
    // reply in the transcript — the follow-up did not spawn a second turn.
    const agentReplies = (await view(handle)).messages.filter((m: any) => m.role === 'agent');
    expect(agentReplies.length).toBe(1);
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    // the follow-up's work really landed on main
    const onMain = await git(repo, ['show', 'main:mid.txt']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toContain('delivered after all');
  });

  it('confirm=auto: lands the work without any human confirmation', async () => {
    const repo = await h.makeRepo('auto');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'Auto', prompt: 'Do it.\n@write a.txt :: auto\n@review done' }),
          confirm: { mode: 'auto' },
        },
      ],
    });
    // No `confirm` signal is ever sent — auto mode confirms itself and merges.
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:a.txt'])).stdout).toContain('auto');
  });

  it('confirm=agent: a Confirm agent reviews and confirms, no human in the loop', async () => {
    const repo = await h.makeRepo('confirmer');
    const taskId = newId('task');
    // The per-Review request message (rendered from the default confirm prompt
    // template) embeds the original task prompt, so the mock confirm agent sees
    // `@confirm confirm` on its own line and returns that verdict.
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'AgentConfirm', prompt: 'Ship it.\n@write b.txt :: reviewed\n@review please review\n@confirm confirm' }),
          confirm: { mode: 'agent', provider: 'mock' },
        },
      ],
    });
    // No human `confirm` signal — the Confirm agent's verdict drives it to done.
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:b.txt'])).stdout).toContain('reviewed');
    // The Confirm agent's transcript is surfaced as its own role, as a conversation:
    // the review-request (user), the agent's reply, and the recorded verdict.
    const v = await view(handle).catch(() => undefined);
    const confirmT = v?.transcripts?.find((t: any) => t.role === 'confirm');
    if (v?.transcripts) {
      expect(confirmT).toBeTruthy();
      expect(confirmT.messages.some((m: any) => m.role === 'user' && m.text.includes('Ship it.'))).toBe(true);
      expect(confirmT.messages.some((m: any) => m.role === 'system' && m.text.includes('confirm_decision: confirm'))).toBe(true);
    }
  });

  it('confirm=agent with a custom prompt: the per-task template reaches the Confirm agent', async () => {
    const repo = await h.makeRepo('confirmer-prompt');
    const taskId = newId('task');
    // The task prompt carries NO @confirm directive — the verdict can only come from
    // the custom review-request template, proving the override is what gets sent.
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'CustomConfirmPrompt', prompt: 'Ship it.\n@write c.txt :: custom\n@review please review' }),
          confirm: { mode: 'agent', provider: 'mock', prompt: 'Ensure the work is complete.\n@confirm confirm' },
        },
      ],
    });
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:c.txt'])).stdout).toContain('custom');
  });

  it('confirm layers: an agent review layer, then a final human confirmation (SPEC §5.2)', async () => {
    const repo = await h.makeRepo('confirm-layers');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'LayeredConfirm', prompt: 'Ship it.\n@write d.txt :: layered\n@review please review\n@confirm confirm' }),
          confirm: { layers: [{ kind: 'agent', provider: 'mock' }, { kind: 'human' }] },
        },
      ],
    });
    // The agent layer approves (the @confirm directive), then the gate WAITS on the
    // human layer — the agent's approval alone must not merge the work.
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 20_000 }).toBe('confirm layer 2/2');
    const v = await view(handle);
    expect(v.stage).toBe('review');
    expect(v.transcripts?.find((t: any) => t.role === 'confirm')?.messages.some((m: any) => m.text.includes('confirm_decision: confirm'))).toBe(true);
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:d.txt'])).stdout).toContain('layered');
  });

  it('confirm layers: zero layers auto-confirm a completed turn', async () => {
    const repo = await h.makeRepo('confirm-zero-layers');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'ZeroLayers', prompt: 'Ship it.\n@write z.txt :: hands-off\n@review done' }),
          confirm: { layers: [] },
        },
      ],
    });
    // No signals at all — an empty layer list is auto-confirm.
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:z.txt'])).stdout).toContain('hands-off');
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
    const handle = await h.client.workflow.start('softwareDev@1.6.0', {
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

  it('does not settle cancellation until the provider turn has actually stopped', async () => {
    const repo = await h.makeRepo('app-cancel-acknowledged');
    const taskId = newId('task');
    cancellationCleanupFinishedAt = 0;
    const handle = await h.client.workflow.start('softwareDev@1.6.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Wait for provider cancellation',
        prompt: '@cancel-cleanup-regression',
      })],
    });

    await expect.poll(async () => (await view(handle)).agentTurn?.state, { timeout: 15_000 }).toBe('running');
    await handle.signal('cancel');
    const result = await handle.result();

    expect(result.stage).toBe('cancelled');
    expect(cancellationCleanupFinishedAt).toBeGreaterThan(0);
    expect(h.store.eventsSince(taskId, 0).findLast((event) => event.type === 'view.updated')?.payload)
      .toMatchObject({ stage: 'cancelled', status: 'cancelled' });
  });

  it('routes an unhandled error directly to human escalation when Resolve is disabled', async () => {
    const repo = await h.makeRepo('app-fail');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Boom', prompt: '@fail boom goes the agent', resolveAgentEnabled: false })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.status).toBe('blocked');
    expect(v.error).toContain('boom goes the agent');
    expect(h.store.eventsSince(taskId, 0).some((e) => e.type === 'resolve.auto')).toBe(true);
    expect(v.transcripts?.some((t: any) => t.role === 'resolve')).toBe(false);
    expect(v.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(['retry', 'cancel']));
    // a human cancels the blocked task
    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
  });

  it('restores the failed stage as soon as an escalated task is retried', async () => {
    const repo = await h.makeRepo('app-escalation-retry-stage');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Retry stage',
        // First invocation escalates. On the human retry, failonce has cleared and
        // the sleep keeps the replacement agent turn observable in the live view.
        prompt: '@failonce novel agent failure\n@sleep 3000\n@write retry.txt :: resumed\n@review retry worked',
        resolveAgentEnabled: false,
      })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    await handle.signal('retry');
    await expect.poll(async () => (await view(handle)).agentTurn?.state, { timeout: 15_000 }).toBe('running');
    const running = await view(handle);
    expect(running.stage).toBe('do');
    expect(running.status).toBe('active');
    expect(running.error).toBeUndefined();

    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('escalates when the Resolve agent itself fails instead of failing the workflow', async () => {
    const repo = await h.makeRepo('app-resolver-fail');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Resolver failure', prompt: '@fail resolve-agent-failure-test' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.status).toBe('blocked');
    expect(v.error).toMatch(/Resolve agent failed.*resolve agent itself failed/i);
    // The execution is still alive and accepts the same controls as any other
    // escalation; before the fix it was terminally FAILED here.
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  });

  it('opens a recovery checkpoint without recreating its dirty worktree', async () => {
    const repo = await h.makeRepo('app-recovery-world');
    const taskId = newId('task');
    const existing = await h.worlds.create('worktree', { taskId, repo, base: 'main', target: 'main' });
    await existing.writeFile('preserved.txt', 'work from the failed run');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Recovered execution',
          prompt: 'original prompt',
          recovery: {
            world: existing.handle,
            messages: [{ id: 'recover', role: 'user', text: '@write continued.txt ::resumed\n@review recovered safely', ts: 0 }],
            seen: 0,
            target: 'main',
          },
        }),
      ],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    // createWorld would have force-removed this worktree; opening the checkpoint
    // keeps both the old dirty file and the newly continued work.
    expect(await existing.readFile('preserved.txt')).toBe('work from the failed run');
    expect(await existing.readFile('continued.txt')).toBe('resumed');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:preserved.txt'])).stdout).toContain('failed run');
    expect((await git(repo, ['show', 'main:continued.txt'])).stdout).toContain('resumed');
  });

  it('auto-resolves hard provider credit exhaustion without spawning a quota-bound Resolve agent', async () => {
    const repo = await h.makeRepo('app-usage-limit');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // Exact provider error from task #151. This used to miss classifyLimitError,
      // so autoResolve returned false and spent another turn on the Resolve agent.
      args: [
        input({
          taskId,
          repo,
          title: 'Quota',
          prompt:
            "@fail Claude Code returned an error result: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
        }),
      ],
    });
    // The scripted handler retries the originating stage. With no alternate
    // credential configured those bounded retries eventually require a human,
    // but another agent must never be started using the exhausted credential.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    const v = await view(handle);
    const resolve = (v.transcripts ?? []).find((t: any) => t.role === 'resolve');
    expect(resolve?.messages?.length ?? 0).toBe(0);
    const autoEvents = h.store.eventsSince(taskId, 0).filter((e) => e.type === 'resolve.auto');
    expect(autoEvents.length).toBeGreaterThan(0);
    expect(autoEvents.every((e) => e.payload.resolved === true)).toBe(true);
    expect(autoEvents.every((e) => e.payload.source === 'provider-metadata')).toBe(true);
    expect(v.error).toMatch(/out of usage credits/i);
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  });

  it('rotates on a transient session limit instead of escalating', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coord.registerAccounts([
      { id: 'mock:limited', configHome: '/tmp/mock-limited', provider: 'mock', maxConcurrent: 1 },
      { id: 'mock:fallback', configHome: '/tmp/mock-fallback', provider: 'mock', maxConcurrent: 1 },
    ]);
    const accounts = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await accounts.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(2);

    const repo = await h.makeRepo('app-session-limit');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Session limit',
        prompt: "@write ok.txt :: hi\n@failonce You've hit your session limit · resets 3:45pm",
      })],
    });

    // The limited login is marked unavailable, the same stage is retried on the
    // fallback login, and no Resolve/human escalation is involved.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const v = await view(handle);
    expect((v.transcripts ?? []).find((t: any) => t.role === 'resolve')?.messages?.length ?? 0).toBe(0);
    expect(h.store.eventsSince(taskId, 0).filter((e) => e.type === 'resolve.auto')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ resolved: true, source: 'provider-metadata' }) }),
    ]);
    await expect.poll(async () => {
      const state = (await accounts.query('accounts')) as any;
      return state.accounts.find((a: any) => a.id === 'mock:limited')?.status;
    }, { timeout: 10_000 }).toBe('exhausted');

    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    await accounts.terminate('test complete').catch(() => {});
  });

  it('semantically classifies novel provider quota wording and marks the credential needs-attention', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coord.registerAccounts([
      { id: 'mock:depleted', configHome: '/tmp/mock-depleted', provider: 'mock', maxConcurrent: 1 },
    ]);
    const accounts = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await accounts.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);

    const repo = await h.makeRepo('app-novel-quota-wording');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        input({
          taskId,
          repo,
          title: 'Novel quota wording',
          prompt: '@fail Your prepaid balance has now been fully consumed.',
        }),
      ],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('escalated');
    const v = await view(handle);
    expect((v.transcripts ?? []).find((t: any) => t.role === 'resolve')?.messages?.length ?? 0).toBe(0);
    const auto = h.store.eventsSince(taskId, 0).filter((e) => e.type === 'resolve.auto');
    expect(auto).toHaveLength(1);
    expect(auto[0]?.payload).toMatchObject({ resolved: true, source: 'provider-metadata' });
    await expect.poll(async () => {
      const state = (await accounts.query('accounts')) as any;
      return state.accounts.find((a: any) => a.id === 'mock:depleted')?.status;
    }, { timeout: 10_000 }).toBe('needs-attention');

    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
    await accounts.terminate('test complete').catch(() => {});
  });

  it('retries a transient transport failure in-place — session resumed, Resolve never runs', async () => {
    const repo = await h.makeRepo('app-flaky');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // Exact terminal shape from task #225: Codex had already tried reconnecting,
      // then its model-refresh child timed out while the internet was down.
      args: [input({ taskId, repo, title: 'Flaky', prompt: '@write ok.txt :: hi\n@failonce codex app-server turn failed: Reconnecting... 1/5 · failed to refresh available models: timeout waiting for child process to exit' })],
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
  }, 75_000);

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
