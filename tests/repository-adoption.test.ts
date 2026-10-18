import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import { forkWorldSource } from '../src/world/fork.js';
import type { WorldHandle } from '../src/world/types.js';

// A repository attached to a project while one of its tasks runs without one
// (andhbhakt/video-explainers #1): the world adopts it at the agent's next
// turn, and a task that never moved its files there loses nothing at the end.
describe('repositories attached to a running task', () => {
  let dir: string;
  let store: Store;
  let worlds: WorldRegistry;
  let checkpoints: WorldCheckpointService;
  let core: ReturnType<typeof makeCoreActivities>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-adoption-'));
    // The repository's SSH address resolves to a local bare repository.
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    await gitOrThrow(origin, ['init', '-q', '-b', 'main']);
    await ensureIdentity(origin);
    fs.writeFileSync(path.join(origin, 'README.md'), '# site\n');
    await gitOrThrow(origin, ['add', '-A']);
    await gitOrThrow(origin, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(dir, ['clone', '-q', '--bare', origin, path.join(dir, 'site.git')]);
    fs.writeFileSync(path.join(dir, 'gitconfig'), `[url "file://${dir}/"]\n\tinsteadOf = git@github.com:andhbhakt/\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig');
    store = await Store.create(':memory:');
    worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    checkpoints = new WorldCheckpointService(store, worlds, objects, new CredentialBroker(new Vault(path.join(dir, 'vault'))));
    core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), checkpoints });
  });
  afterEach(async () => {
    delete process.env.GIT_CONFIG_GLOBAL;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function repoLessTask() {
    const project = await store.createProject('Videos', { worldProvider: 'worktree' });
    const task = await store.createTask({ projectId: project.id, title: 'Render', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'render' } });
    const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = await store.registerWorld(world.handle, project.id) as WorldHandle;
    await world.writeFile('render/video.txt', 'rendered\n');
    return { project, task, world };
  }

  async function attach(projectId: string, organizationId: string) {
    const repository = await store.upsertRepository({ organizationId, provider: 'github', owner: 'andhbhakt',
      name: 'site', sshUrl: 'git@github.com:andhbhakt/site.git', defaultBranch: 'main', private: true });
    await store.attachProjectRepository({ projectId, repositoryId: repository.id });
    return repository;
  }

  it('adopts a repository attached after the world was made, once, and keeps the agent at the world root', async () => {
    const { project, task, world } = await repoLessTask();
    expect(await core.adoptAttachedRepositories(world.handle, task.id)).toBeUndefined();

    await attach(project.id, project.organizationId!);
    const adopted = (await core.adoptAttachedRepositories(world.handle, task.id))!;
    expect(adopted.checkouts).toEqual([expect.objectContaining({ name: 'site', path: 'site', branch: world.handle.branch,
      source: 'git@github.com:andhbhakt/site.git' })]);
    expect(adopted.project).toMatchObject({ repos: ['git@github.com:andhbhakt/site.git'], defaultBase: 'main', defaultTarget: 'main' });
    expect(adopted.world.workdir).toBe(world.handle.root);
    expect(adopted.world.repos?.map((repo) => repo.name)).toEqual(['site']);
    expect(fs.readFileSync(path.join(world.handle.root, 'site/README.md'), 'utf8')).toBe('# site\n');
    expect(fs.readFileSync(path.join(world.handle.root, 'render/video.txt'), 'utf8')).toBe('rendered\n');
    expect((await store.currentWorld(task.id))?.repos?.map((repo) => repo.name)).toEqual(['site']);
    const enrolled = (await store.eventsSince(task.id, 0)).filter((event) => event.type === 'world.repository-enrolled');
    expect(enrolled).toHaveLength(1);

    // The workflow's stale copy of the handle is enough: the store's is current.
    const again = (await core.adoptAttachedRepositories(world.handle, task.id))!;
    expect(again.checkouts.map((checkout) => checkout.name)).toEqual(['site']);
    expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'world.repository-enrolled')).toHaveLength(1);
  });

  it('keeps a final checkpoint of a repo-less world at Confirm, which a continuation restores', async () => {
    const { project, task, world } = await repoLessTask();
    const kept = await core.keepFinalWorkspace(world.handle);
    expect(kept).toMatchObject({ files: 1, destroy: true });
    expect(kept.checkpointId).toBeTruthy();
    expect((await store.currentWorld(task.id))?.checkpointId).toBe(kept.checkpointId);
    await world.destroy();
    await store.setWorldState((await store.currentWorld(task.id))!, 'released');

    const done = { ...(await store.getTask(task.id))!, lastView: { stage: 'done', status: 'done' } as any };
    const plan = forkWorldSource(done, (await store.currentWorld(task.id)) as WorldHandle);
    expect(plan).toMatchObject({ taskId: task.id, unpublished: true, repos: [] });
    const forkTask = await store.createTask({ projectId: project.id, title: 'Continue', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'more' } });
    const fork = await worlds.create('worktree', { taskId: forkTask.id, base: 'main' });
    await checkpoints.applyFork(kept.checkpointId!, fork, project.id);
    expect(fs.readFileSync(path.join(fork.handle.root, 'render/video.txt'), 'utf8')).toBe('rendered\n');
    await fork.destroy();
  });

  it('keeps a world that gained a repository but never moved its files: they are in the final checkpoint', async () => {
    const { project, task, world } = await repoLessTask();
    await attach(project.id, project.organizationId!);
    await core.adoptAttachedRepositories(world.handle, task.id);
    const kept = await core.keepFinalWorkspace(world.handle);
    expect(kept.checkpointId).toBeTruthy();
    const checkpoint = (await store.getWorldCheckpoint(kept.checkpointId!))!;
    expect(checkpoint.repos.map((repo) => repo.checkoutPath)).toEqual(['site']);
    expect(kept.files).toBe(1);
  });

  it('saves a just-do world whose project gained a repository mid-task instead of failing it', async () => {
    const { project, task, world } = await repoLessTask();
    await attach(project.id, project.organizationId!);
    // The task's own snapshot named no repository: the world is what it made.
    expect(await core.checkpointResourceOnlyWork(world.handle, [])).toBe(true);
    expect((await store.currentWorld(task.id))?.checkpointId).toBeTruthy();
    // A repository the task itself was configured with is still never skipped.
    await expect(core.checkpointResourceOnlyWork(world.handle, ['git@github.com:andhbhakt/site.git']))
      .rejects.toThrow(/configured repositories are missing/);
  });

  it('commits a just-do world that adopted a repository, and checkpoints the files it made before', async () => {
    const { project, task, world } = await repoLessTask();
    await attach(project.id, project.organizationId!);
    await core.adoptAttachedRepositories(world.handle, task.id);
    expect(await core.checkpointResourceOnlyWork(world.handle, [])).toBe(false);
    const checkpoint = (await store.getWorldCheckpoint((await store.currentWorld(task.id))!.checkpointId!))!;
    expect(checkpoint.repos.map((repo) => repo.checkoutPath)).toEqual(['site']);
    expect(checkpoint.filesystemDelta?.files).toBe(1);
  });
});
