import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import type { Project } from '../src/domain/types.js';
import { bootHarness, type Harness } from './helpers/harness.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { newId } from '../src/util/id.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import type { WorldHandle } from '../src/world/types.js';

// Real Temporal, activities, filesystem and encrypted checkpoints. Only the
// cloud transport is replaced; these tests never need AWS or a paid sandbox.
describe('just-do durable finalization', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock', undefined, { checkpoints: true });
    const local = new WorktreeProvider(h.worldsHome);
    const remote = {
      kind: 'sandbox-test', parkable: false,
      capabilities: { remote: true, pty: false, snapshots: false, ports: false, networkPolicy: false },
      async create(spec: import('../src/world/types.js').WorldSpec) { const world = await local.create(spec); world.handle.kind = 'sandbox-test'; return world; },
      async open(handle: WorldHandle) { return local.open(handle); },
    };
    h.worlds.register(remote);
    // Source fixtures provision locally (including their wiki), then expose a
    // remote handle so finalization uses the real cloud publication/release path.
    h.worlds.register({ ...remote, kind: 'worktree', capabilities: { ...remote.capabilities, remote: false } });
  }, 60_000);
  afterAll(async () => { await h?.stop(); });

  async function start(repos: string[] = [], version = '1.7.0', prepare?: (project: Project) => Promise<void>) {
    const project = h.store.createProject(newId('Finalization'), { repos, worldProvider: repos.length ? 'worktree' : 'sandbox-test', defaultBase: 'main' });
    await prepare?.(project);
    const task = h.store.createTask({ projectId: project.id, title: 'Save report', workflow: 'just-do',
      workflowVersion: version, params: { prompt: '' } });
    const handle = await h.client.workflow.start(`justDo@${version}`, {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title: task.title,
        prompt: '@write reports/result.md :: reviewed report', base: 'main', project: project.config }],
    });
    await expect.poll(async () => (await handle.query<any>('view')).waitingFor?.kind,
      { timeout: 15_000 }).toBe('human');
    return { task, handle, world: h.store.currentWorld(task.id) as WorldHandle };
  }

  it('saves remote repositoryless output in a restorable checkpoint before releasing the world', async () => {
    let attachmentId = '';
    let baseRevisionId = '';
    const { task, handle, world } = await start([], '1.7.0', async (project) => {
      const attachment = h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: 'Read-only fixture', driver: 'volume@1', target: { kind: 'path', path: 'data/fixture' },
        access: 'read', isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' });
      attachmentId = attachment.id;
      baseRevisionId = (await h.resources.importFiles(attachment.id,
        [{ path: 'sentinel.txt', data: Buffer.from('unchanged fixture') }])).id;
    });
    expect(world.repos ?? []).toEqual([]);
    expect(fs.existsSync(path.join(world.root, '.git'))).toBe(false);
    await handle.signal('confirm');
    expect(await handle.result()).toEqual({ stage: 'done' });
    const saved = h.store.currentWorld(task.id)!;
    expect(saved.checkpointId).toBeTruthy();
    const checkpoint = h.store.getWorldCheckpoint(saved.checkpointId!)!;
    expect(checkpoint.repos).toEqual([]);
    expect(checkpoint.resources).toContainEqual({ attachmentId, revisionId: baseRevisionId });
    expect(h.store.getResourceAttachment(attachmentId)!.currentRevisionId).toBe(baseRevisionId);
    const history = await handle.fetchHistory();
    const scheduled = history.events!.flatMap(e => e.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    expect(scheduled).not.toContain('commitWork');
    expect(scheduled).not.toContain('publishTaskBranch');
    expect(scheduled.indexOf('checkpointResourceOnlyWork')).toBeLessThan(scheduled.indexOf('destroyWorld'));
    expect(fs.existsSync(world.root)).toBe(false);
    const restored = await h.checkpoints!.restore(saved.checkpointId!, 'sandbox-test');
    const reopened = await h.worlds.open(restored);
    expect(await reopened.readFile('reports/result.md')).toContain('reviewed report');
    expect(fs.existsSync(path.join(restored.root, '.git'))).toBe(false);
    expect(await reopened.readFile('data/fixture/sentinel.txt')).toBe('unchanged fixture');
    await h.resources.release(restored);
    await reopened.destroy();
  });

  it('fails and retains a configured repository when its commit is rejected', async () => {
    const repo = await h.makeRepo('rejected-commit');
    fs.writeFileSync(path.join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { handle, world } = await start([repo]);
    await handle.signal('confirm');
    await expect(handle.result()).rejects.toThrow();
    expect(fs.existsSync(path.join(world.workdir ?? world.root, 'reports/result.md'))).toBe(true);
    const history = await handle.fetchHistory();
    const scheduled = history.events!.flatMap(e => e.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    expect(scheduled).not.toContain('publishTaskBranch');
    expect(scheduled).not.toContain('destroyWorld');
    expect(JSON.stringify(history)).toContain('task work was not committed');
  });

  it('fails and retains a configured repository with no publish remote', async () => {
    const repo = await h.makeRepo('missing-remote');
    const { handle, world } = await start([repo]);
    await handle.signal('confirm');
    await expect(handle.result()).rejects.toThrow();
    expect(fs.existsSync(path.join(world.workdir ?? world.root, 'reports/result.md'))).toBe(true);
    const history = await handle.fetchHistory();
    const failed = history.events!.find(e => e.workflowExecutionFailedEventAttributes);
    expect(JSON.stringify(failed)).toContain('cloud task branch was not persisted');
  });

  it('retains the last checkpoint and live output when final checkpoint storage fails', async () => {
    const { task, handle, world } = await start();
    const prior = await h.checkpoints!.checkpoint(world);
    const failure = vi.spyOn(h.checkpoints!, 'checkpoint').mockRejectedValue(new Error('checkpoint storage unavailable'));
    try {
      await handle.signal('confirm');
      await expect(handle.result()).rejects.toThrow();
      expect(h.store.currentWorld(task.id)!.checkpointId).toBe(prior.id);
      expect(fs.existsSync(path.join(world.root, 'reports/result.md'))).toBe(true);
      expect(JSON.stringify(await handle.fetchHistory())).toContain('checkpoint storage unavailable');
    } finally { failure.mockRestore(); }
  });

  it('does not treat missing configured checkouts as a resource-only world', async () => {
    const { task, handle, world } = await start();
    h.store.updateProjectConfig(task.projectId, { repos: ['/missing/configured/repository'] });
    await handle.signal('confirm');
    await expect(handle.result()).rejects.toThrow();
    expect(fs.existsSync(world.root)).toBe(true);
    expect(JSON.stringify(await handle.fetchHistory())).toContain('configured repositories are missing');
  });

  it.each(['1.0.0', '1.5.0', '1.6.0'])('keeps the legacy %s activity sequence replayable', async (version) => {
    const { handle } = await start([], version);
    await handle.signal('confirm');
    await expect(handle.result()).rejects.toThrow();
    const history = await handle.fetchHistory();
    const scheduled = history.events!.flatMap(e => e.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    expect(scheduled.slice(-2)).toEqual(['commitWork', 'publishTaskBranch']);
    expect(scheduled).not.toContain('checkpointResourceOnlyWork');
    expect(JSON.stringify(history)).toContain('cloud task branch was not persisted because it has no remote repository');
    await Worker.runReplayHistory({
      workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
    }, history);
  });

});
