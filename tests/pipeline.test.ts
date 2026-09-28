import { timingReport, type TimingRow } from '../src/timing/index.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { httpOps } from '../src/platform/mcp.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { mergeQueueId, accountCoordinatorId } from '../src/coordinators/names.js';
import { mergeQueueDomains } from '../src/domain/types.js';

function input(over: { taskId: string; projectId?: string; repo: string; prompt: string; title?: string; subtaskNagMs?: number; subagentWaitMs?: number; recovery?: any; resolveAgentEnabled?: boolean }) {
  return {
    taskId: over.taskId,
    projectId: over.projectId ?? 'p1',
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
  let releaseAttemptMerge: (() => void) | undefined;
  let attemptMergeGate: Promise<void> | undefined;
  const gatedAttemptIds = new Set<string>();
  let releaseResourceCandidateTurn: (() => void) | undefined;
  let resourceCandidateTurnReleased = false;
  beforeAll(async () => {
    const mock = new MockAdapter();
    const restartSession = 'restart-regression-session';
    // Model the real Claude/Codex shutdown behaviour: provider cleanup consumes the
    // AbortError and returns partial output. The runtime boundary must still reject
    // that result so Temporal retries the activity after the worker comes back.
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.role === 'merge' && gatedAttemptIds.has(input.world.handle.id)) await attemptMergeGate;
        const latestUser = input.messages.filter((message) => message.role === 'user').at(-1);
        if (!resourceCandidateTurnReleased
          && latestUser?.text.includes('@resource-candidate-regression')) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              releaseResourceCandidateTurn = undefined;
              reject(new Error('aborted'));
            };
            releaseResourceCandidateTurn = () => {
              ctx.signal?.removeEventListener('abort', onAbort);
              resolve();
            };
            if (ctx.signal?.aborted) onAbort();
            else ctx.signal?.addEventListener('abort', onAbort, { once: true });
          });
          return mock.runTurn(input, ctx);
        }
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
    releaseAttemptMerge?.();
    releaseResourceCandidateTurn?.();
    releaseResourceCandidateTurn = undefined;
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
    const { runId } = await handle.describe();
    expect(review.messages.find((message: any) => message.role === 'agent')?.sourceActivity).toMatchObject({
      turnId: `${taskId}:${runId}#0`,
      id: 'message-1',
      attempt: 1,
    });
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

  it.each(['keep', 'cancel'] as const)('%s other attempts at first Merge admission', async (choice) => {
    const repo = await h.makeRepo(`attempts-${choice}`);
    const project = (await h.store.createProject(`Attempts ${choice}`, { repos: [repo], defaultBase: 'main', defaultTarget: 'main' }));
    const first = (await h.store.createTask({ projectId: project.id, title: 'First', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write first.txt :: first' } }));
    const second = (await h.store.createTask({ projectId: project.id, title: 'Second', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write second.txt :: second' }, intentId: first.intentId }));
    const handles = await Promise.all([first, second].map((task) => h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ ...input({ taskId: task.id, projectId: project.id, repo, prompt: task.params.prompt }), intentId: first.intentId }],
    })));
    for (const handle of handles) await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    (await h.store.kvSet(`attempt-choice:${first.id}`, choice));
    await handles[0]!.signal('confirm');
    expect((await handles[0]!.result() as any).stage).toBe('done');
    if (choice === 'keep') {
      expect((await view(handles[1])).stage).toBe('review');
      await handles[1]!.signal('confirm');
      expect((await handles[1]!.result() as any).stage).toBe('done');
      expect((await git(repo, ['show', 'main:second.txt'])).stdout).toContain('second');
    } else {
      expect((await handles[1]!.result() as any).stage).toBe('cancelled');
      expect((await git(repo, ['show', 'main:second.txt'])).code).not.toBe(0);
    }
    expect((await git(repo, ['show', 'main:first.txt'])).stdout).toContain('first');
  });

  it('kept siblings confirmed together own separate, serialized merge queue leases', async () => {
    const repo = await h.makeRepo('kept-sibling-queue');
    const project = (await h.store.createProject('Kept queue', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' }));
    const first = (await h.store.createTask({ projectId: project.id, title: 'Queue sibling admission A', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write queued-a.txt :: A' } }));
    const second = (await h.store.createTask({ projectId: project.id, title: 'Queue sibling admission B', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write queued-b.txt :: B' }, intentId: first.intentId }));
    (await h.store.setSettings(project.id, '__common__', { otherAttempts: 'keep' }));
    gatedAttemptIds.add(first.id);
    gatedAttemptIds.add(second.id);
    attemptMergeGate = new Promise<void>((resolve) => { releaseAttemptMerge = resolve; });
    const handles = await Promise.all([first, second].map((task) => h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ ...input({ taskId: task.id, projectId: project.id, repo, title: task.title, prompt: task.params.prompt }), intentId: first.intentId }],
    })));
    try {
      for (const handle of handles) await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
      await Promise.all(handles.map((handle) => handle.signal('confirm')));
      // The automatically attached project wiki is also a merge domain. The
      // second attempt waits on the first sorted domain, not necessarily the code repo.
      const domains = mergeQueueDomains((await view(handles[0])).state.recoveryWorld, 'main', project.id);
      const queueHandle = h.client.workflow.getHandle(mergeQueueId(domains[0]!));
      await expect.poll(async () => {
        try { return await queueHandle.query('queue'); } catch { return undefined; }
      }, { timeout: 20_000 }).toMatchObject({ current: expect.any(String), queue: [expect.any(String)] });
      const queued = await queueHandle.query('queue') as { current: string; queue: string[] };
      expect(new Set([queued.current, ...queued.queue])).toEqual(new Set([first.id, second.id]));
      releaseAttemptMerge!();
      expect(await Promise.all(handles.map((handle) => handle.result()))).toEqual([
        expect.objectContaining({ stage: 'done' }), expect.objectContaining({ stage: 'done' }),
      ]);
      for (const domain of domains) await expect.poll(async () => {
        const queue = await h.client.workflow.getHandle(mergeQueueId(domain)).query('queue') as { current?: string; queue: string[] };
        return { current: queue.current ?? null, queue: queue.queue };
      }).toEqual({ current: null, queue: [] });
      expect((await git(repo, ['show', 'main:queued-a.txt'])).stdout).toContain('A');
      expect((await git(repo, ['show', 'main:queued-b.txt'])).stdout).toContain('B');
    } finally {
      releaseAttemptMerge?.();
      attemptMergeGate = undefined;
      gatedAttemptIds.clear();
      await Promise.all(handles.map((handle) => handle.signal('cancel').catch(() => undefined)));
    }
  }, 60_000);

  it('kept sibling conflicts do not overwrite the first landed attempt or retain a queue lease', async () => {
    const repo = await h.makeRepo('kept-sibling-conflict');
    const project = (await h.store.createProject('Kept conflict', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' }));
    const first = (await h.store.createTask({ projectId: project.id, title: 'First edit', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write index.js :: console.log("first")' } }));
    const second = (await h.store.createTask({ projectId: project.id, title: 'Conflicting edit', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: '@write index.js :: console.log("second")' }, intentId: first.intentId }));
    (await h.store.setSettings(project.id, '__common__', { otherAttempts: 'keep' }));
    const handles = await Promise.all([first, second].map((task) => h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ ...input({ taskId: task.id, projectId: project.id, repo, prompt: task.params.prompt }), intentId: first.intentId }],
    })));
    try {
      for (const handle of handles) await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
      await handles[0]!.signal('confirm');
      expect(await handles[0]!.result()).toMatchObject({ stage: 'done' });
      await handles[1]!.signal('confirm');
      // The mock agent cannot resolve this conflict. The workflow must stop safely.
      await expect.poll(async () => (await view(handles[1])).stage, { timeout: 30_000 }).toBe('escalated');
      const target = await git(repo, ['show', 'main:index.js']);
      expect(target.stdout).toContain('first');
      expect(target.stdout).not.toMatch(/second|<<<<<<<|>>>>>>>/);
      const queueHandle = h.client.workflow.getHandle(mergeQueueId(`${repo}:main`));
      await expect.poll(async () => {
        const queue = await queueHandle.query('queue') as { current?: string; queue: string[] };
        return { current: queue.current ?? null, queue: queue.queue };
      }).toEqual({ current: null, queue: [] });
      expect((await h.store.attemptGroup(first.id))?.otherAttempts).toBe('keep');
    } finally {
      await handles[1]!.signal('cancel').catch(() => undefined);
      await handles[1]!.result();
    }
  }, 60_000);

  it.each(['1.15.0', '1.20.0'])('v%s runs repository-less work through Do and Review without Git or Merge', async (version) => {
    const taskId = newId('task');
    const handle = await h.client.workflow.start(`softwareDev@${version}`, {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'State-only task',
        prompt: '@run test ! -e .git\n@review State action completed',
        base: 'main',
        target: 'main',
        project: { repos: [], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const review = await view(handle);
    expect(review.branch).toBeUndefined();
    expect(review.base).toBeUndefined();
    expect(review.targetBranch).toBeUndefined();
    expect(review.state.mergeDomain).toBeUndefined();
    expect(review.actions.map((action: any) => action.label)).toContain('Confirm');
    expect(review.actions.map((action: any) => action.label)).not.toContain('Confirm PR');
    expect(review.messages.map((message: any) => message.text).join('\n')).toContain('ran: test ! -e .git (exit 0)');

    await handle.signal('confirm');
    const result = await handle.result();
    expect(result).toEqual({ stage: 'done' });
    const final = await view(handle);
    expect(final.reviewInfo.summary).toMatch(/no repository merge required/i);
    expect((await h.store.eventsSince(taskId, 0)).some((event) => event.type === 'merge.completed')).toBe(false);
  }, 120_000);

  it.each([false, true])('confirmation applies resource choices (excluded: %s)', async (excluded) => {
    resourceCandidateTurnReleased = false;
    const repo = await h.makeRepo(`resource-candidate-review-${excluded}`);
    const project = (await h.store.createProject(`Resource candidate review ${excluded}`, { repos: [repo] }));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Install model', workflow: 'software-dev',
      workflowVersion: '1.19.0', params: { prompt: 'install it' } }));
    const volume = await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Weights', driver: 'volume@1', target: { kind: 'path', path: 'weights' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
    const baseline = await h.resources.importFiles(volume.id, [{ path: 'weights.bin', data: Buffer.from('base') }]);
    const handle = await h.client.workflow.start('softwareDev@1.19.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, title: task.title,
        prompt: '@resource-candidate-regression\n@write .gitignore ::model.bin\n'
          + '@write model.js :: export const installed = true;\n'
          + '@run git add .gitignore model.js && git commit -q -m "install model"\n@review Installed model' })],
    });

    await expect.poll(async () => (await h.store.currentWorld(task.id)), { timeout: 30_000 }).toBeTruthy();
    await expect.poll(() => Boolean(releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    const taskWorld = (await h.store.currentWorld(task.id))!;
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'model.bin'), Buffer.alloc(1024, 7));
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'weights/weights.bin'), Buffer.from('updated weights'));
    const proposed = await h.resources.proposePath(task.id, { path: 'model.bin', name: 'Installed model',
      target: { kind: 'path', path: 'data/model.bin' }, access: 'read' });
    await expect.poll(() => Boolean(releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    resourceCandidateTurnReleased = true;
    releaseResourceCandidateTurn!();
    releaseResourceCandidateTurn = undefined;

    await expect.poll(async () => (await view(handle)).actions.map((action: any) => action.name), { timeout: 30_000 })
      .toContain('confirm');
    expect((await view(handle)).stage).toBe('review');
    expect((await h.store.getResourceAttachment(proposed.attachment.id))?.enabled).toBe(false);
    await expect.poll(async () => (await h.store.getTask(task.id))?.lastView?.stage).toBe('review');
    const gateway = await h.startGateway();
    const session: any = await fetch(`${gateway.url}/api/session`).then((r) => r.json());
    const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
    const summarize = h.resources.summarize;
    h.resources.summarize = async () => { throw new Error('metadata list must not scan files'); };
    try {
      const rows: any = await fetch(`${gateway.url}/api/tasks/${task.id}/resources?summary=metadata`, { headers }).then((r) => r.json());
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ automaticReview: true, excluded: false, candidate: expect.any(Object) }),
        expect.objectContaining({ pendingInspection: true, resource: expect.objectContaining({ id: volume.id }) }),
      ]));
      expect(rows.some((r: any) => r.error)).toBe(false);
    } finally { h.resources.summarize = summarize; }
    const reviewer = await h.tokens.mint({ taskId: task.id, profileId: 'maintainer', principal: `task:${task.id}`,
      projectId: project.id, organizationId: project.organizationId, ceiling: ['task:review:execute'], grantorCaps: ['task:review:execute'] });
    const denied = await h.tokens.mint({ taskId: task.id, profileId: 'do', principal: `task:${task.id}`,
      projectId: project.id, organizationId: project.organizationId, ceiling: ['task:read'], grantorCaps: ['task:read'] });
    const route = `${gateway.url}/api/tasks/${task.id}/resources/${proposed.attachment.id}/selection`;
    expect((await fetch(route, { method: 'PUT', headers: { ...headers, authorization: `Bearer ${denied.token}` }, body: JSON.stringify({ excluded }) })).status).toBe(403);
    const choices = await Promise.all([
      fetch(route, { method: 'PUT', headers, body: JSON.stringify({ excluded }) }),
      httpOps(gateway.url, reviewer.token).platformRequest('PUT', `/api/tasks/${task.id}/resources/${volume.id}/selection`, { excluded }),
    ]);
    const humanChoice = choices[0] as Response;
    expect(humanChoice.status, await humanChoice.text()).toBe(200);
    expect(choices[1]).toEqual({ resourceId: volume.id, excluded });
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
    expect((await h.store.getResourceCandidate(proposed.candidate.id))?.state).toBe(excluded ? 'discarded' : 'adopted');
    const current = (await h.store.getResourceAttachment(volume.id))!.currentRevisionId;
    if (excluded) expect(current).toBe(baseline.id);
    else expect((await h.store.getResourceRevision(current!))?.bytes).toBe(Buffer.byteLength('updated weights'));
    if (!excluded) expect((await h.store.getResourceAttachment(proposed.attachment.id))).toMatchObject({ enabled: true });
  }, 120_000);

  it('v1.13 waits for input until Open PR is explicitly requested', async () => {
    const repo = await h.makeRepo('explicit-open-pr');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Explicit proposal',
        prompt: 'Prepare it.\n@write proposal.js :: export const ready = true;\n'
          + '@run git add -A && git commit -q -m "prepare proposal"\n@incomplete',
      })],
    });

    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.status}/${current.waitingFor?.kind}`;
    }, { timeout: 30_000 }).toBe('do/waiting/human');
    const waiting = await view(handle);
    expect(waiting.actions.map((action: any) => [action.name, action.label])).toContainEqual(['openPr', 'Open PR']);
    expect(waiting.actions.map((action: any) => action.name)).not.toContain('confirm');
    expect(waiting.transcripts.some((transcript: any) => transcript.role === 'merge')).toBe(false);

    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    const review = await view(handle);
    expect(review.actions.map((action: any) => [action.name, action.label])).toContainEqual(['confirm', 'Confirm PR']);
    expect(review.transcripts.some((transcript: any) => transcript.role === 'merge')).toBe(false);

    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
    expect((await git(repo, ['show', 'main:proposal.js'])).stdout).toContain('ready = true');
  }, 120_000);

  it.each([{ authorized: true, failed: true }, { authorized: false, failed: true },
    { authorized: true, failed: false }, { authorized: false, failed: false }])('manual opening confirms only an authorized reviewer ($authorized, failed: $failed)', async ({ authorized, failed }) => {
    const repo = await h.makeRepo(`manual-confirm-${authorized}-${failed}`);
    (await h.store.claimPersonalOrganization('manual-owner'));
    const project = (await h.store.createProject(`Manual confirmation ${authorized} ${failed}`));
    const task = (await h.store.createTask({
      projectId: project.id, title: 'Manual confirmation', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' },
      createdBy: { kind: 'user', userId: 'manual-owner' },
    }));
    const handle = await h.client.workflow.start('softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, resolveAgentEnabled: false,
        prompt: '@write preserved.txt :: completed proposal\n'
          + (failed ? '@fail provider crashed' : '@run git add -A && git commit -qm proposal\n@incomplete'),
      })],
    });
    await expect.poll(async () => {
      const current = await view(handle);
      return failed ? current.stage === 'escalated' : current.stage === 'do' && current.waitingFor?.kind === 'human';
    }, { timeout: 30_000 }).toBe(true);
    await handle.signal('openPr', { userId: authorized ? 'manual-owner' : 'other-user' });
    if (!authorized) {
      await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
      await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
      expect((await h.store.eventsSince(task.id, 0)).some((e) => e.type === 'task.confirmation-voted')).toBe(false);
      expect((await view(handle)).stage).toBe('review');
      await handle.signal('confirm');
    }
    expect(await handle.result()).toMatchObject({ stage: 'done' });
    expect((await h.store.eventsSince(task.id, 0)).filter((e) => e.type === 'task.confirmation-voted'))
      .toHaveLength(authorized ? 1 : 0);
  }, 120_000);

  it.each([false, true])('manually opens preserved work after Do fails (committed: %s)', async (committed) => {
    const repo = await h.makeRepo(`manual-error-pr-${committed}`);
    const taskId = newId('task');
    const handle = await h.client.workflow.start(committed ? 'softwareDev@1.13.0' : 'softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [input({ taskId, repo, resolveAgentEnabled: false,
        prompt: '@write preserved.txt :: completed before failure\n'
          + (committed ? '@run git add -A && git commit -qm proposal\n' : '')
          + '@fail provider crashed',
      })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    const failed = await view(handle);
    expect(failed.actions.map((a: any) => a.name)).toContain('openPr');
    expect(failed.reviewInfo.changedFiles).toContain(committed ? 'preserved.txt' : 'preserved.txt (new)');
    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    expect((await git(failed.worldPath, ['status', '--porcelain'])).stdout.trim()).toBe('');
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
    expect((await git(repo, ['show', 'main:preserved.txt'])).stdout).toContain('completed before failure');
  }, 120_000);

  it('keeps conflicted work escalated when manual publication is refused', async () => {
    const repo = await h.makeRepo('manual-error-conflict');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [input({ taskId, repo, resolveAgentEnabled: false,
        prompt: '@write conflict.txt :: task version\n@fail provider crashed',
      })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    const failed = await view(handle);
    await git(failed.worldPath, ['add', '-A']);
    await git(failed.worldPath, ['commit', '-qm', 'task version']);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'target version');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-qm', 'target version']);
    expect((await git(failed.worldPath, ['merge', 'main'])).code).not.toBe(0);
    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).error, { timeout: 30_000 })
      .toContain('Manual recovery failed');
    expect((await view(handle)).stage).toBe('escalated');
    expect((await git(failed.worldPath, ['diff', '--name-only', '--diff-filter=U'])).stdout)
      .toContain('conflict.txt');
    await handle.signal('cancel');
    expect(await handle.result()).toMatchObject({ stage: 'cancelled' });
  }, 120_000);

  it('does not offer manual publication when a failed Do turn left no changes', async () => {
    const repo = await h.makeRepo('manual-error-empty');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [input({ taskId, repo, resolveAgentEnabled: false, prompt: '@fail no work' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    expect((await view(handle)).actions.map((a: any) => a.name)).not.toContain('openPr');
    await handle.signal('openPr');
    expect((await view(handle)).stage).toBe('escalated');
    await handle.signal('cancel');
    expect(await handle.result()).toMatchObject({ stage: 'cancelled' });
  }, 120_000);

  it('manually confirms a failed reviewer while preserving subsequent review layers', async () => {
    const repo = await h.makeRepo('manual-error-confirm');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [{ ...input({ taskId, repo, resolveAgentEnabled: false,
        prompt: '@write reviewed.txt :: completed\n@run git add -A && git commit -qm proposal',
      }), confirm: { layers: [
        { kind: 'agent', provider: 'mock', prompt: '@fail reviewer crashed' },
        { kind: 'human', audience: ['@creator'] },
      ] } }],
    });
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');
    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('escalated');
    expect((await view(handle)).actions.map((a: any) => a.name)).toContain('confirm');
    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 30_000 })
      .toBe('confirm layer 2/2');
    expect((await view(handle)).stage).toBe('review');
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
  }, 120_000);

  it('v1.13 returns a raced landing to Do and reviews the repaired proposal again', async () => {
    const repo = await h.makeRepo('explicit-pr-race');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Repair raced proposal',
        prompt: '@write index.js :: console.log("proposal")',
      })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log("target moved")\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'move target']);
    await handle.signal('confirm');

    // The deterministic landing aborts its conflict, returns the exact context
    // to Do, and the competent mock reopens the unchanged/repaired proposal. A
    // real Do agent would resolve it in that same conversation first.
    await expect.poll(async () => {
      const current = await view(handle);
      const returned = current.messages.some((message: any) => /Landing the reviewed PR was refused/.test(message.text));
      return `${current.stage}/${returned}`;
    }, { timeout: 30_000 }).toBe('review/true');
    const replayed = await view(handle);
    expect(replayed.transcripts.some((transcript: any) => transcript.role === 'merge')).toBe(false);
    expect(replayed.actions.map((action: any) => action.label)).toContain('Confirm PR');

    await handle.signal('cancel');
    expect(await handle.result()).toMatchObject({ stage: 'cancelled' });
  }, 120_000);

  it('restarts an interrupted turn in Do instead of accepting partial output as Review (Task 162)', async () => {
    const repo = await h.makeRepo('restart-do-stage');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, title: 'Restart in Do', prompt: '@restart-regression' })],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await expect.poll(async () => (await h.store.kvGet(`session:${taskId}:do`)), { timeout: 15_000 }).toBe('restart-regression-session');

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
