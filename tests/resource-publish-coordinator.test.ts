import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import {
  QRY_RESOURCE_PUBLISH, RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, SIG_CANCEL_RESOURCE_PUBLISH,
  SIG_ENQUEUE_RESOURCE_PUBLISH, SIG_RELEASE_RESOURCE_PUBLISH, resourcePublishCoordinatorId,
} from '../src/coordinators/names.js';
import type { ResourcePublishView } from '../src/coordinators/resource-publish.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

/**
 * The resource publication singleton on a real Temporal worker (CI-38m). The
 * harness builds its ProjectResourceService with the Temporal coordinator, as
 * production does, so promote() here is ordered by `resourcePublishCoordinator`
 * rather than by the in-process lock every other promote() test falls back to.
 */
describe('resource publish coordinator', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    h = await bootHarness('mock');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-publish-'));
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = (attachmentId: string) => h.client.workflow.getHandle(resourcePublishCoordinatorId(attachmentId))
    .query<ResourcePublishView>(QRY_RESOURCE_PUBLISH);

  it('grants one lease at a time in arrival order, ignores duplicates and forgets cancelled waiters', async () => {
    const attachmentId = 'rsrc_protocol';
    const workflowId = resourcePublishCoordinatorId(attachmentId);
    const enqueue = (token: string) => h.client.workflow.signalWithStart(RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, {
      workflowId, taskQueue: TASK_QUEUE, args: [{ attachmentId }], signal: SIG_ENQUEUE_RESOURCE_PUBLISH,
      signalArgs: [{ token, taskId: `task-${token}` }] });
    const handle = h.client.workflow.getHandle(workflowId);
    for (const token of ['a', 'b', 'b', 'c', 'd']) await enqueue(token);
    await expect.poll(() => view(attachmentId), { timeout: 10_000 }).toMatchObject({
      attachmentId, current: { token: 'a', taskId: 'task-a' },
      queue: [{ token: 'b' }, { token: 'c' }, { token: 'd' }] });

    // Re-enqueueing the lease holder does not queue it behind itself.
    await enqueue('a');
    await handle.signal(SIG_CANCEL_RESOURCE_PUBLISH, { token: 'c' });
    // A waiter that gives up before its turn releases its place, not the holder's.
    await handle.signal(SIG_RELEASE_RESOURCE_PUBLISH, { token: 'd' });
    await expect.poll(() => view(attachmentId), { timeout: 10_000 })
      .toMatchObject({ current: { token: 'a' }, queue: [{ token: 'b' }] });

    await handle.signal(SIG_RELEASE_RESOURCE_PUBLISH, { token: 'a' });
    await expect.poll(() => view(attachmentId), { timeout: 10_000 }).toMatchObject({ current: { token: 'b' }, queue: [] });
    // Cancelling the holder frees the lease just as a release does.
    await handle.signal(SIG_CANCEL_RESOURCE_PUBLISH, { token: 'b' });
    await expect.poll(async () => (await view(attachmentId)).current, { timeout: 10_000 }).toBeUndefined();
    await enqueue('e');
    await expect.poll(() => view(attachmentId), { timeout: 10_000 }).toMatchObject({ current: { token: 'e' }, queue: [] });
    await handle.terminate('done');
  });

  it('serializes promote() across tasks and releases the lease after a refused publication', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'resources/\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
    const project = await h.store.createProject('Publish order', { repos: [repo] });
    const attachment = await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Model', driver: 'volume@1', target: { kind: 'path', path: 'resources/model' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
    const baseline = await h.resources.importFiles(attachment.id, [{ path: 'weights.bin', data: Buffer.from('base') }]);
    const fork = async (title: string, content: string) => {
      const task = await h.store.createTask({ projectId: project.id, title, workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: title } });
      const world = await h.worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
      world.handle = await h.resources.materialize(project.id, task.id, world, 1);
      world.handle = (await h.store.registerWorld(world.handle, project.id)) as typeof world.handle;
      await world.writeFileBuffer!('resources/model/weights.bin', Buffer.from(content));
      return { task, world };
    };
    const first = await fork('First tuning', 'first');
    const second = await fork('Second tuning', 'second');

    // Hold the first publication inside its lease.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const cas = h.store.promoteResourceRevision.bind(h.store);
    const promoteRevision = vi.spyOn(h.store, 'promoteResourceRevision').mockImplementation(async (...args) => {
      if (promoteRevision.mock.calls.length === 1) await gate;
      return cas(...args);
    });
    // Promotions still in flight when an assertion fails would keep calling
    // Temporal after the harness closes its client (an unhandled "Channel has
    // been shut down" in whichever test file runs next).
    const pending: Promise<unknown>[] = [];
    try {
      const firstPromotion = h.resources.promote(first.task.id, attachment.id);
      pending.push(firstPromotion);
      await expect.poll(async () => (await view(attachment.id).catch(() => undefined))?.current?.taskId,
        { timeout: 15_000 }).toBe(first.task.id);
      const secondPromotion = h.resources.promote(second.task.id, attachment.id);
      pending.push(secondPromotion);
      const secondOutcome = secondPromotion.then(() => 'promoted', (error: Error) => error.message);
      await expect.poll(async () => (await view(attachment.id)).queue.map((item) => item.taskId), { timeout: 15_000 })
        .toEqual([second.task.id]);
      // The first still snapshots its files between taking the lease and its
      // CAS; on a loaded machine the second is queued before that CAS starts.
      await expect.poll(() => promoteRevision.mock.calls.length, { timeout: 15_000 }).toBe(1);
      // The second task is parked in the queue, not racing the first one's CAS.
      expect(promoteRevision).toHaveBeenCalledTimes(1);

      open();
      const promoted = await firstPromotion;
      expect(promoted.revision.parentRevisionId).toBe(baseline.id);
      // Both forked the same baseline, so the database CAS still refuses the
      // second one after the coordinator lets it through.
      expect(await secondOutcome).toMatch(/baseline changed/);
      expect(promoteRevision).toHaveBeenCalledTimes(2);
      expect((await h.store.getResourceAttachment(attachment.id))?.currentRevisionId).toBe(promoted.revision.id);
      await expect.poll(() => view(attachment.id), { timeout: 10_000 }).toMatchObject({ queue: [] });
      expect((await view(attachment.id)).current).toBeUndefined();

      // The refused publication gave its lease back: a task forked from the new
      // baseline publishes straight away.
      const third = await fork('Third tuning', 'third');
      const next = await h.resources.promote(third.task.id, attachment.id);
      expect(next.revision.parentRevisionId).toBe(promoted.revision.id);
      expect(await third.world.readFileBuffer('resources/model/weights.bin')).toEqual(Buffer.from('third'));
      for (const { world } of [first, second, third]) { await h.resources.release(world.handle); await world.destroy(); }
    } finally {
      promoteRevision.mockRestore();
      open();
      await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 30_000))]);
    }
  }, 120_000);
});
