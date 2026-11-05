import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { RunnerPoolService } from '../src/world/runners.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import type { WorldHandle } from '../src/world/types.js';

// Task #817 (2026-11-04): a hibernated world's restore failed after its new
// sandbox started. Its cleanup opened the world it was replacing, which was
// gone, so the registry's recovery handler restored it again, inside the
// failing restore: one more nested restore, one more machine lease, every
// ~10 s, until the organization's 25 machines were taken and every one of its
// tasks waited for a computer for 12 hours.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { materialize?: () => Promise<never> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-recovery-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Restore', ownerUserId: 'owner' });
  const project = await store.createProject('Cloud', { repos: [repo], defaultBase: 'main', worldProvider: 'sandbox-test' },
    organization.id);
  const task = await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });

  const worlds = new WorldRegistry();
  const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
  const gone = new Set<number>();
  worlds.register({
    kind: 'sandbox-test', parkable: true,
    capabilities: { remote: true, pty: false, snapshots: true, ports: false, networkPolicy: false },
    async create(spec: Parameters<WorktreeProvider['create']>[0]) {
      const world = await worktrees.create(spec);
      world.handle.kind = 'sandbox-test';
      world.handle.provider = 'sandbox-test';
      world.handle.generation = spec.generation ?? 1;
      return world;
    },
    async open(handle: WorldHandle) {
      if (gone.has(handle.generation ?? 1)) throw new Error('sandbox not found');
      const world = await worktrees.open(handle);
      world.handle.kind = 'sandbox-test';
      return world;
    },
    async probe(handle: WorldHandle) { return gone.has(handle.generation ?? 1) ? 'missing' : 'ready'; },
  } as any);
  // As production wires it (runtime/execution-services.ts).
  worlds.setHandleResolver(async (handle) => (await store.currentWorld(handle.id)) as WorldHandle | undefined);
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const runners = new RunnerPoolService(store);
  // A resource service whose cleanup, like the real one, opens the world it
  // is given when it is not handed the live one.
  const resources = {
    checkpoint: async () => [], ignoredInventory: async () => undefined, scrubSecrets: async () => {},
    materialize: options.materialize ?? (async (_project: string, _world: string, world: { handle: WorldHandle }) => world.handle),
    release: vi.fn(async (handle: WorldHandle, live?: unknown) => { if (!live) await worlds.open(handle).catch(() => undefined); }),
  };
  const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources as any, runners);
  const recoveries: string[] = [];
  worlds.setRecoveryHandler(async (handle) => {
    recoveries.push(handle.id);
    if (recoveries.length > 3) return undefined; // bounded, so a regression fails instead of hanging
    const checkpoint = await store.latestWorldCheckpoint(handle.id);
    if (!checkpoint || (await worlds.probe(handle)) !== 'missing') return undefined;
    return checkpoints.restoreWhereTaskRuns(checkpoint.id, handle);
  });

  const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
  world.handle.meta = { projectId: project.id };
  world.handle = (await store.registerWorld(world.handle, project.id)) as WorldHandle;
  return { dir, repo, store, project, task, worlds, world, gone, runners, checkpoints, recoveries, resources };
}

it('fails a restore once, with one lease, without restoring again from its own cleanup', async () => {
  const f = await fixture({ materialize: async () => { throw new Error('project data could not be restored'); } });
  await f.world.writeFile('tracked.txt', 'edited in the sandbox\n');
  const checkpoint = await f.checkpoints.checkpoint(f.world.handle);
  await f.world.destroy();
  f.gone.add(1);
  await f.store.setWorldState(f.world.handle, 'hibernated');

  const acquire = vi.spyOn(f.runners, 'acquire');
  await expect(f.checkpoints.restoreWhereTaskRuns(checkpoint.id, f.world.handle)).rejects.toThrow(/project data could not be restored/);
  expect(f.recoveries).toEqual([]);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(0);
  // Its cleanup was handed the new machine, not the one it replaces.
  expect(f.resources.release.mock.calls[0]?.[1]).toBeDefined();
});

it('restores a world whose checkpoint names a commit its remote never received', async () => {
  const f = await fixture();
  await gitOrThrow(f.world.handle.root, ['checkout', '-q', '-b', 'tavya/task']);
  await f.world.writeFile('tracked.txt', 'edited in the sandbox\n');
  const saved = await f.checkpoints.checkpoint(f.world.handle);
  // The commit lived only in the deleted sandbox.
  const lost = 'f'.repeat(40);
  const checkpoint = { ...saved, id: 'checkpoint-lost-commit',
    repos: saved.repos.map((repo) => ({ ...repo, branch: 'tavya/task', headSha: lost })) };
  await f.store.saveWorldCheckpoint(checkpoint);
  await f.world.destroy();
  f.gone.add(1);
  await f.store.setWorldState(f.world.handle, 'hibernated');

  const restored = await f.checkpoints.restoreWhereTaskRuns(checkpoint.id, f.world.handle);
  expect(restored.generation).toBe(2);
  expect(fs.readFileSync(path.join(restored.root, 'tracked.txt'), 'utf8')).toBe('edited in the sandbox\n');
  expect((await git(restored.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('tavya/task');
  const warnings = await f.store.eventsOfType(f.task.id, 'world.warning');
  expect(warnings.map((event: any) => event.payload.warning).join('\n')).toMatch(/ffffffffffff .*never saved to its remote/);
  expect(await f.checkpoints.takeNotice(f.task.id)).toMatch(/Commits made after its last successful push are lost/);
  expect(f.recoveries).toEqual([]);
  await (await f.worlds.open(restored)).destroy();
});
