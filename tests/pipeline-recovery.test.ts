import { timingReport, type TimingRow } from '../src/timing/index.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, input, view } from './helpers/pipeline-harness.js';

describe('software-dev pipeline: follow-ups, confirmation modes and recovery (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

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
    expect((await git(fe, ['log', '--oneline', 'main'])).stdout).toMatch(new RegExp(`merge tavya/${taskId} into main`));
    expect((await git(be, ['log', '--oneline', 'main'])).stdout).toMatch(new RegExp(`merge tavya/${taskId} into main`));
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
    expect(log).toMatch(new RegExp(`merge tavya/${taskId} into main`));
    expect(log).toMatch(new RegExp(`merge tavya/${taskId}-docs into main`));
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
    // Do not let the poll below observe the Review state from before the signal was
    // handled. Wait for proof that the follow-up turn actually ran first.
    await expect
      .poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'agent' && m.text?.includes('wrote hello.txt')), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:hello.txt']);
    expect(onMain.stdout).toContain('hi there');
  }, 60_000);

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
    const followUp = { id: 'mid1', role: 'user' as const, text: '@write mid.txt :: delivered after all', ts: 0 };
    await handle.signal('followUp', followUp);
    // The API journals every accepted follow-up; the running turn asks the
    // workflow for it only then (LT-13).
    await h.store.appendEvent({ taskId, type: 'conversation.message', ts: Date.now(), payload: { role: 'do', message: followUp } });
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
  }, 60_000);

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

  it('agent Responder answers an ordinary input pause and returns control to Do', async () => {
    const repo = await h.makeRepo('responder-agent');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.24.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'AgentResponder', prompt: 'Start the work.\n@write response.txt :: resumed\n@incomplete' }),
          responder: { kind: 'agent', provider: 'mock', prompt: 'Answer the working agent now.' },
          confirm: { layers: [] },
        },
      ],
    });

    // No human follow-up: the responder's output becomes a user message for the
    // existing Do conversation, which resumes and opens the proposal itself.
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:response.txt'])).stdout).toContain('resumed');
    const v = await view(handle);
    const responder = v.transcripts?.find((transcript: any) => transcript.role === 'responder');
    expect(responder?.messages.some((message: any) => message.role === 'user'
      && message.text.includes('Answer the working agent now.'))).toBe(true);
    expect(v.messages.some((message: any) => message.role === 'user'
      && message.text.startsWith('Responder:'))).toBe(true);
  });

  it('agent Responder answers a needs-input pause at once, instead of waiting out its deadline', async () => {
    const repo = await h.makeRepo('responder-pause');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.24.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          ...input({ taskId, repo, title: 'AgentResponderPause', prompt: '@write paused.txt :: answered\n@pause 600 :: input -- Which region?' }),
          responder: { kind: 'agent', provider: 'mock', prompt: 'Answer: {{question}}' },
          confirm: { layers: [] },
        },
      ],
    });
    const result = await handle.result();
    expect(result.stage).toBe('done');
    expect((await git(repo, ['show', 'main:paused.txt'])).stdout).toContain('answered');
    const v = await view(handle);
    const responder = v.transcripts?.find((transcript: any) => transcript.role === 'responder');
    expect(responder?.messages.some((message: any) => message.role === 'user' && message.text.includes('Answer: Which region?'))).toBe(true);
    // It never parked on a person.
    const kinds = (await h.store.eventsOfType(taskId, 'view.updated')).map((e: any) => e.payload.waitingFor);
    expect(kinds).not.toContain('human');
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
    gates.cancellationCleanupFinishedAt = 0;
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
    expect(gates.cancellationCleanupFinishedAt).toBeGreaterThan(0);
    expect((await h.store.eventsSince(taskId, 0)).findLast((event) => event.type === 'view.updated')?.payload)
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
    expect((await h.store.eventsSince(taskId, 0)).some((e) => e.type === 'resolve.auto')).toBe(true);
    expect(v.transcripts?.some((t: any) => t.role === 'resolve')).toBe(false);
    expect(v.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(['retry', 'cancel']));
    // a human cancels the blocked task
    await handle.signal('cancel');
    const result = await handle.result();
    expect(result.stage).toBe('cancelled');
  });

  // legibench3#18: between infrastructure retries nothing runs, yet the task read
  // "working" for 23 minutes. It waits, says until when, and a Retry ends the wait.
  it('waits visibly between infrastructure retries, and a person\'s Retry ends the wait', async () => {
    const repo = await h.makeRepo('app-infra-retry-wait');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Infra', prompt: '@failworld fetch failed', resolveAgentEnabled: false })],
    });
    // Three activity attempts (10 s and 20 s apart), then the first 30 s wait.
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 60_000, interval: 500 }).toBe('retry');
    const waiting = await view(handle);
    expect(waiting).toMatchObject({ stage: 'do', status: 'waiting', waitingFor: { kind: 'retry', detail: 'Retry 1 of 5' } });
    expect(waiting.waitingFor.until).toBeGreaterThan(Date.now());
    expect(waiting.waitingFor.until).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(waiting.error).toMatch(/^infrastructure: .*fetch failed — retrying do in 30s \(1\/5\)$/);
    const lifecycle = (await h.store.eventsSince(taskId, 0)).findLast((event) => event.type === 'view.updated')?.payload;
    expect(lifecycle).toMatchObject({ status: 'waiting', waitingFor: 'retry', waitingUntil: waiting.waitingFor.until });
    await handle.signal('retry');
    // The stage runs again at once: its next attempt is admitted, not parked.
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 15_000, interval: 200 }).not.toBe('retry');
    expect((await view(handle)).error).toBeUndefined();
    await handle.signal('cancel');
    const cancelled = await handle.result();
    expect(cancelled.stage).toBe('cancelled');
    expect(cancelled.waitingFor).toBeUndefined();
  }, 120_000);

  // legibench3#18: a session converted from a 44 MB Codex history was larger than
  // Claude's context, so every retry and follow-up resumed it into the same refusal.
  it('restarts Do on a fresh session when its session outgrew the model\'s context', async () => {
    const repo = await h.makeRepo('app-context-overflow');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [input({ taskId, repo, title: 'Overflow', prompt: 'Start.\n@incomplete', resolveAgentEnabled: false })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('followUp', { id: 'f1', role: 'user', text: '@overflow\n@review carried on', ts: 0 });
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'agent' && m.text?.includes('fresh session')),
      { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    expect((await view(handle)).error).toBeUndefined();
    // Neither Resolve nor an infrastructure retry spent a turn on it.
    expect((await h.store.eventsSince(taskId, 0)).some((e) => e.type === 'resolve.auto')).toBe(false);
    await handle.signal('cancel');
    await handle.result();
  }, 60_000);

  it('asks a person when even a fresh session is larger than the model\'s context', async () => {
    const repo = await h.makeRepo('app-context-overflow-fresh');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [input({ taskId, repo, title: 'Overflow', prompt: 'Start.\n@incomplete', resolveAgentEnabled: false })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('followUp', { id: 'f1', role: 'user', text: '@overflow always', ts: 0 });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    const v = await view(handle);
    expect(v.status).toBe('blocked');
    expect(v.error).toMatch(/prompt is too long.*larger than the model's context window even in a fresh session/);
    expect((await h.store.eventsSince(taskId, 0)).some((e) => e.type === 'resolve.auto')).toBe(false);
    await handle.signal('cancel');
    await handle.result();
  }, 60_000);

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

  it('v1.22 rebuilds restored Review prerequisites and replays the configured layers', async () => {
    const repo = await h.makeRepo('restored-review-layers');
    const taskId = newId('task');
    const existing = await h.worlds.create('worktree', { taskId, repo, base: 'main', target: 'main' });
    await existing.writeFile('reviewed.txt', 'preserved reviewed work');
    await git(existing.handle.workdir!, ['add', 'reviewed.txt']);
    await git(existing.handle.workdir!, ['commit', '-m', 'preserved proposal']);

    const handle = await h.client.workflow.start('softwareDev@1.22.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        ...input({
          taskId,
          repo,
          title: 'Restored layered Review',
          prompt: 'Review the preserved proposal.\n@confirm confirm',
          recovery: {
            world: existing.handle,
            messages: [{ id: 'recover', role: 'user', text: 'Review the preserved proposal.\n@confirm confirm', ts: 0 }],
            seen: 1,
            target: 'main',
            resumeStage: 'review',
          },
        }),
        confirm: { layers: [{ kind: 'agent', provider: 'mock' }, { kind: 'human', audience: ['@creator'] }] },
      }],
    });

    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 20_000 })
      .toBe('confirm layer 2/2');
    expect((await view(handle)).stage).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:reviewed.txt'])).stdout).toContain('preserved reviewed work');
  });

  it('restored approval finishes interrupted resource publication', async () => {
    const repo = await h.makeRepo('restored-resource-publication');
    const project = await h.store.createProject('Restored resources', { repos: [repo] });
    const task = await h.store.createTask({ projectId: project.id, title: 'Restore output', workflow: 'software-dev',
      workflowVersion: '1.22.0', params: { prompt: 'restore' } });
    const existing = await h.worlds.create('worktree', { taskId: task.id, repo, base: 'main', target: 'main' });
    existing.handle = await h.store.registerWorld(existing.handle, project.id) as typeof existing.handle;
    await existing.writeFile('data.bin', 'reviewed dataset');
    const proposed = await h.resources.proposePath(task.id, { path: 'data.bin', name: 'Dataset', target: { kind: 'path', path: 'dataset.bin' } });
    await existing.writeFile('.gitignore', 'data.bin\n');
    await existing.writeFile('reviewed.txt', 'preserved reviewed work');
    await git(existing.handle.workdir ?? existing.handle.root, ['add', '.gitignore', 'reviewed.txt']);
    await git(existing.handle.workdir ?? existing.handle.root, ['commit', '-m', 'preserved proposal']);
    await h.resources.beginReview(task.id, 'prior-review');
    await h.store.resourceReview(task.id, { freeze: true });
    const handle = await h.client.workflow.start('softwareDev@1.22.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, prompt: 'Restore reviewed work', recovery: {
        world: existing.handle, messages: [], seen: 0, target: 'main', resumeStage: 'review', reviewConfirmed: true,
      } })],
    });
    await expect.poll(async () => {
      const state = await view(handle);
      return { stage: state.stage, waiting: state.waitingFor, last: state.messages.at(-1)?.text };
    }, { timeout: 10_000 }).toMatchObject({ stage: 'done' });
    expect((await handle.result()).stage).toBe('done');
    expect((await h.store.getResourceCandidate(proposed.candidate.id))?.state).toBe('adopted');
  });

  it('v1.22 preserves the exact audience and question of a cross-cutting human hold', async () => {
    const repo = await h.makeRepo('restored-human-route');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.22.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Targeted hold',
        prompt: 'preserved work',
        recovery: {
          messages: [{ id: 'recover', role: 'user', text: 'preserved work', ts: 0 }],
          seen: 1,
          target: 'main',
          resumeStage: 'do',
          pausedForHuman: true,
          humanWait: { audience: ['user:release-manager'], detail: 'Choose the deployment window' },
        },
      })],
    });

    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 15_000 })
      .toBe('Choose the deployment window');
    expect((await view(handle)).waitingFor?.audience).toEqual(['user:release-manager']);
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
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
    const autoEvents = (await h.store.eventsSince(taskId, 0)).filter((e) => e.type === 'resolve.auto');
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
    expect((await h.store.eventsSince(taskId, 0)).filter((e) => e.type === 'resolve.auto')).toEqual([
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

  it('semantically classifies novel provider quota wording, marks the credential needs-attention, and waits for a credential', async () => {
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

    // A credential needing a person is a wait, never an escalation with an error.
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 20_000 })
      .toBe('Every allowed credential needs attention — sign in again or add one');
    const v = await view(handle);
    expect(v).toMatchObject({ stage: 'do', status: 'waiting', waitingFor: { kind: 'account' } });
    expect((v.transcripts ?? []).find((t: any) => t.role === 'resolve')?.messages?.length ?? 0).toBe(0);
    const auto = (await h.store.eventsSince(taskId, 0)).filter((e) => e.type === 'resolve.auto');
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

  it('retries a transient transport failure in-place — session resumed, Resolve never runs', async ({ onTestFinished }) => {
    // This case verifies retry timing as well as recovery; other cases keep the installation default.
    const previousTiming = (await h.store.getSettings('global', 'timing'));
    onTestFinished(async () => (await h.store.setSettings('global', 'timing', previousTiming ?? { enabled: false })));
    (await h.store.setSettings('global', 'timing', { enabled: true }));
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
    const events = (await h.store.eventsSince(taskId, 0));
    expect(events.some((e) => e.type === 'turn.resumed')).toBe(true);
    const timing = timingReport(events.filter(e => e.type === 'timing').map(e => e.payload as unknown as TimingRow));
    const measured = timing.attempts.filter(a => a.attempt === 1 || a.attempt === 2);
    expect(measured.map(a => a.status)).toEqual(['failed', 'ok']);
    expect(new Set(measured.map(a => a.turnId)).size).toBe(1);
    expect(measured[1]?.metadata.sessionMode).toBe('resumed');
    expect(timing.completion.count).toBe(1);
    expect(timing.completion.missing).toBe(1);

    // Attempts share one logical turn id, but the UI must not fold the retry's
    // fresh "started" row over the prior failure (task #353). The activity event
    // carries the Temporal attempt so both rows remain independently auditable.
    const turnActivities = events.filter((e) => e.type === 'agent.activity' && e.payload.id === 'turn');
    expect(turnActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: 'failed', attempt: 1 }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: 'started', attempt: 2 }) }),
    ]));
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
  }, 75_000);
});
