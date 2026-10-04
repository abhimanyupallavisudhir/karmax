import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { httpOps } from '../src/platform/mcp.js';
import { mergeQueueId } from '../src/coordinators/names.js';
import { mergeQueueDomains } from '../src/domain/types.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, input, view } from './helpers/pipeline-harness.js';

describe('software-dev pipeline: landing, review and the merge queue (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

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

  it('a landed task keeps its work summary and branch after its world is released', async () => {
    // Remote sandboxes are released on completion; the overview of the finished
    // task must still say what the work was and which branch carried it.
    const worktree = h.worlds.get('worktree');
    const create = worktree.create;
    worktree.create = async (spec) => {
      const world = await create.call(worktree, spec);
      world.handle.meta = { ...world.handle.meta, releaseOnCompletion: true };
      return world;
    };
    try {
      const repo = await h.makeRepo('released');
      const project = (await h.store.createProject('Released world', { repos: [repo] }));
      const { id: taskId } = (await h.store.createTask({ projectId: project.id, title: 'Release', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'land it' } }));
      const handle = await h.client.workflow.start('softwareDev', {
        taskQueue: TASK_QUEUE,
        workflowId: taskId,
        args: [input({ taskId, projectId: project.id, repo, prompt: '@write released.txt :: landed' })],
      });
      await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
      const review = await view(handle);
      expect(review.reviewInfo?.summary).toBe('wrote released.txt');
      await handle.signal('confirm');
      const result = await handle.result();
      expect(result.stage).toBe('done');

      const done = await view(handle);
      expect(done.world).toBeUndefined();
      expect(done.branch).toBe(review.branch);
      expect(done.reviewInfo?.summary).toBe(`wrote released.txt\n\nMerged into main as ${result.sha.slice(0, 8)}.`);
      expect((await h.store.getTask(taskId))?.lastView).toMatchObject({ branch: review.branch, reviewInfo: { summary: done.reviewInfo.summary } });
    } finally {
      worktree.create = create;
    }
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
    gates.gatedAttemptIds.add(first.id);
    gates.gatedAttemptIds.add(second.id);
    gates.attemptMergeGate = new Promise<void>((resolve) => { gates.releaseAttemptMerge = resolve; });
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
      gates.releaseAttemptMerge!();
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
      gates.releaseAttemptMerge?.();
      gates.attemptMergeGate = undefined;
      gates.gatedAttemptIds.clear();
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
    gates.resourceCandidateTurnReleased = false;
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
    await expect.poll(() => Boolean(gates.releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    const taskWorld = (await h.store.currentWorld(task.id))!;
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'model.bin'), Buffer.alloc(1024, 7));
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'weights/weights.bin'), Buffer.from('updated weights'));
    const proposed = await h.resources.proposePath(task.id, { path: 'model.bin', name: 'Installed model',
      target: { kind: 'path', path: 'data/model.bin' }, access: 'read' });
    // The snapshot is taken at the end of Do, so later writes in the turn count.
    expect(proposed.revision).toBeUndefined();
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'model.bin'), Buffer.alloc(2048, 9));
    await expect.poll(() => Boolean(gates.releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    gates.resourceCandidateTurnReleased = true;
    gates.releaseResourceCandidateTurn!();
    gates.releaseResourceCandidateTurn = undefined;

    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.waitingFor?.kind}`;
    }, { timeout: 30_000 }).toBe('review/human');
    expect((await view(handle)).actions.map((action: any) => action.name)).toContain('confirm');
    expect((await view(handle)).state.stagingResources).toBeUndefined();
    const stagedAttachment = (await h.store.getResourceAttachment(proposed.attachment.id))!;
    expect(stagedAttachment.enabled).toBe(false);
    expect((await h.store.getResourceRevision(stagedAttachment.currentRevisionId!))?.bytes).toBe(2048);
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

  it('a proposed output that cannot be snapshotted is reported in Review and never fails the task', async () => {
    gates.resourceCandidateTurnReleased = false;
    const repo = await h.makeRepo('resource-candidate-stage-failure');
    const project = (await h.store.createProject('Resource staging failure', { repos: [repo] }));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Build data', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'build it' } }));
    const handle = await h.client.workflow.start('softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, title: task.title,
        prompt: '@resource-candidate-regression\n@write .gitignore ::data/\n'
          + '@write build.js :: export const built = true;\n'
          + '@run git add .gitignore build.js && git commit -q -m "build"\n@review Built data' })],
    });
    await expect.poll(() => Boolean(gates.releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    const taskWorld = (await h.store.currentWorld(task.id))!;
    const dataDir = path.join(taskWorld.workdir ?? taskWorld.root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'records.json'), '{}');
    const proposed = await h.resources.proposePath(task.id, { path: 'data', name: 'Built data',
      target: { kind: 'path', path: 'data' }, access: 'write', publish: 'review' });
    fs.rmSync(dataDir, { recursive: true, force: true }); // gone before the turn ends
    gates.resourceCandidateTurnReleased = true;
    gates.releaseResourceCandidateTurn!();
    gates.releaseResourceCandidateTurn = undefined;

    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.waitingFor?.kind}`;
    }, { timeout: 60_000 }).toBe('review/human');
    const failed = (await h.store.getResourceCandidate(proposed.candidate.id))!;
    expect(failed).toMatchObject({ state: 'discarded', resolvedBy: 'system:resource-stage-failed' });
    expect(failed.error).toMatch(/no longer exists/);
    const gateway = await h.startGateway();
    const session: any = await fetch(`${gateway.url}/api/session`).then((r) => r.json());
    const rows: any = await fetch(`${gateway.url}/api/tasks/${task.id}/resources?summary=metadata`,
      { headers: { authorization: `Bearer ${session.token}` } }).then((r) => r.json());
    expect(rows).toContainEqual(expect.objectContaining({
      candidate: expect.objectContaining({ id: proposed.candidate.id, sourcePath: 'data', error: failed.error }) }));
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
  }, 120_000);

  it.each(['saves', 'is excluded'] as const)('output that will not save escalates, keeps its world, and continues once it %s', async (outcome) => {
    gates.resourceCandidateTurnReleased = false;
    const repo = await h.makeRepo(`resource-unsaved-${outcome.replace(' ', '-')}`);
    const project = (await h.store.createProject(`Unsaved output ${outcome}`, { repos: [repo] }));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Build data', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'build it' } }));
    const handle = await h.client.workflow.start('softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, title: task.title,
        prompt: '@resource-candidate-regression\n@write .gitignore ::data/\n'
          + '@write build.js :: export const built = true;\n'
          + '@run git add .gitignore build.js && git commit -q -m "build"\n@review Built data' })],
    });
    await expect.poll(() => Boolean(gates.releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    const taskWorld = (await h.store.currentWorld(task.id))!;
    fs.mkdirSync(path.join(taskWorld.workdir ?? taskWorld.root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'data/records.json'), '{}');
    const proposed = await h.resources.proposePath(task.id, { path: 'data', name: 'Built data', target: { kind: 'path', path: 'data' } });
    // Every save fails the way a paused sandbox made it fail, through all of its retries.
    const stage = h.resources.stageCandidates.bind(h.resources);
    let failing = true;
    h.resources.stageCandidates = async (taskId, options = {}) => {
      if (!failing) return stage(taskId, options);
      await h.store.recordResourceCandidateError(proposed.candidate.id, 'the sandbox paused');
      return { staged: [], failed: [{ candidateId: proposed.candidate.id, sourcePath: 'data', error: 'the sandbox paused' }] };
    };
    const at = (expected: string) => expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.status}`;
    }, { timeout: 60_000 }).toBe(expected);
    try {
      gates.resourceCandidateTurnReleased = true;
      gates.releaseResourceCandidateTurn!();
      gates.releaseResourceCandidateTurn = undefined;
      // An infrastructure failure escalates, like a provider error; nobody is asked to review unsaved output.
      await at('escalated/blocked');
      expect((await view(handle)).error).toBe('Could not save data: the sandbox paused. Nothing was deleted; Retry saves it again.');
      expect(await h.store.getResourceCandidate(proposed.candidate.id)).toMatchObject({ state: 'pending', error: 'the sandbox paused' });
      expect(await h.store.worldState(task.id)).not.toBe('released');
      // Retrying while it still fails escalates again.
      await handle.signal('retry');
      await at('escalated/blocked');
      if (outcome === 'saves') failing = false;
      else await h.resources.setReviewExcluded(task.id, proposed.attachment.id, true);
      await handle.signal('retry');
      await at('review/waiting');
      await handle.signal('confirm');
      expect(await handle.result()).toMatchObject({ stage: 'done' });
      expect((await h.store.getResourceCandidate(proposed.candidate.id))?.state).toBe(outcome === 'saves' ? 'adopted' : 'discarded');
    } finally { h.resources.stageCandidates = stage; }
  }, 180_000);

  it.each(['confirm', 'cancel', 'cancel after confirm'] as const)('staging resources: %s while it runs', async (scenario) => {
    gates.resourceCandidateTurnReleased = false;
    const repo = await h.makeRepo(`resource-candidate-stage-${scenario.replaceAll(' ', '-')}`);
    const project = (await h.store.createProject(`Resource staging ${scenario}`, { repos: [repo] }));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Build data', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'build it' } }));
    const handle = await h.client.workflow.start('softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [input({ taskId: task.id, projectId: project.id, repo, title: task.title,
        prompt: '@resource-candidate-regression\n@write .gitignore ::data/\n'
          + '@write build.js :: export const built = true;\n'
          + '@run git add .gitignore build.js && git commit -q -m "build"\n@review Built data' })],
    });
    await expect.poll(() => Boolean(gates.releaseResourceCandidateTurn), { timeout: 30_000 }).toBe(true);
    const taskWorld = (await h.store.currentWorld(task.id))!;
    fs.mkdirSync(path.join(taskWorld.workdir ?? taskWorld.root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(taskWorld.workdir ?? taskWorld.root, 'data/records.json'), '{}');
    const proposed = await h.resources.proposePath(task.id, { path: 'data', name: 'Built data', target: { kind: 'path', path: 'data' } });
    // Hold a staging call open the way a multi-GB upload would.
    const stage = h.resources.stageCandidates.bind(h.resources);
    let hold = scenario !== 'cancel after confirm';
    let running = false;
    let stopped = false;
    h.resources.stageCandidates = async (taskId, options = {}) => {
      running = hold;
      while (hold) {
        try { await options.checkContinue?.(); } catch (error) { stopped = true; throw error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return stage(taskId, options);
    };
    const reviewWaits = () => expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.waitingFor?.kind}`;
    }, { timeout: 60_000 }).toBe('review/human');
    try {
      gates.resourceCandidateTurnReleased = true;
      gates.releaseResourceCandidateTurn!();
      gates.releaseResourceCandidateTurn = undefined;
      if (scenario === 'cancel after confirm') {
        await reviewWaits();
        hold = true; // the refresh before applying
        await handle.signal('confirm');
      }
      await expect.poll(() => running, { timeout: 60_000 }).toBe(true);
      expect((await view(handle)).state.stagingResources).toBe(true);
      expect((await view(handle)).actions).toEqual([]);
      if (scenario === 'confirm') {
        // A click that raced the button away still counts once the snapshot exists.
        await handle.signal('confirm');
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        hold = false;
        expect(await handle.result()).toMatchObject({ stage: 'done' });
        expect((await h.store.getResourceCandidate(proposed.candidate.id))?.state).toBe('adopted');
      } else {
        await handle.signal('cancel');
        // The run ends only once the upload has stopped (a heartbeat delivers the cancel).
        expect(await handle.result()).toMatchObject({ stage: 'cancelled' });
        expect(stopped).toBe(true); // the workflow waited for staging to stop
        expect((await h.store.getResourceCandidate(proposed.candidate.id))?.state).toBe('pending');
        expect((await h.store.getResourceAttachment(proposed.attachment.id))?.enabled).toBe(false);
      }
    } finally { hold = false; h.resources.stageCandidates = stage; }
  }, 180_000);

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

  it('a needs-input pause in Do still offers Open PR, which ends the pause', async () => {
    const repo = await h.makeRepo('explicit-open-pr-pause');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({
        taskId,
        repo,
        title: 'Explicit proposal',
        prompt: 'Prepare it.\n@write proposal.js :: export const ready = true;\n'
          + '@run git add -A && git commit -q -m "prepare proposal"\n@pause 600 :: input -- Ship as is?',
      })],
    });
    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.status}/${current.waitingFor?.kind}/${current.waitingFor?.detail}`;
    }, { timeout: 30_000 }).toBe('do/waiting/human/Ship as is?');
    expect((await view(handle)).actions.map((action: any) => action.name)).toContain('openPr');
    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
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
    // The Error section reports the refusal; the work summary still describes the work.
    expect(v.reviewInfo?.summary).toBe('wrote index.js');
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
    const summaries = new Map<string, string>();
    for (const r of runs) {
      await expect.poll(async () => (await view(r.handle)).stage, { timeout: 20_000 }).toBe('review');
      summaries.set(r.taskId, (await view(r.handle)).reviewInfo?.summary);
    }
    for (const r of runs) await r.handle.signal('confirm');

    // If ordered acquisition were wrong, the shared queues would deadlock and
    // these never resolve — the result() await is the deadlock detector.
    const results = await Promise.all(runs.map((r) => r.handle.result()));
    for (const res of results) expect(res.stage).toBe('done');
    // The landing adds to the work summary; its commit is the primary repo's, so it names that repo.
    for (const [i, r] of runs.entries()) expect((await view(r.handle)).reviewInfo?.summary)
      .toBe(`${summaries.get(r.taskId)}\n\nMerged into main as ${results[i]!.sha!.slice(0, 8)} (${nm(r.s.repos[0]!)}).`);

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
