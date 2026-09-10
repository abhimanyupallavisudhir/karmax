import { describe, expect, it, vi } from 'vitest';
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
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { forkWorldSource } from '../src/world/fork.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import type { WorldHandle } from '../src/world/types.js';

describe('fork world initialization', () => {
  it('restores exact unlanded commits, dirty files and private resources independently; changing base uses normal state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-world-'));
    const store = new Store(':memory:');
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'main');
    await gitOrThrow(repo, ['add', '.']);
    await gitOrThrow(repo, ['commit', '-qm', 'initial']);
    const project = store.createProject('Fork', { repos: [repo], defaultBase: 'main' });
    const sourceTask = store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
    const volume = store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
    await resources.importFiles(volume.id, [{ path: 'value.txt', data: Buffer.from('promoted') }]);
    const source = await worlds.create('worktree', { taskId: sourceTask.id, repo, base: 'main', target: 'main' });
    source.handle = await resources.materialize(project.id, sourceTask.id, source);
    source.handle = store.registerWorld(source.handle, project.id) as WorldHandle;
    const created: WorldHandle[] = [];
    try {
      await source.writeFile('committed.txt', 'unlanded commit');
      await source.exec('git', ['add', 'committed.txt']);
      await source.exec('git', ['commit', '-qm', 'unlanded']);
      const head = (await source.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
      await source.writeFile('file.txt', 'dirty');
      await source.writeFile('nested/new.txt', 'untracked nested file');
      await source.writeFile('data/value.txt', 'unpublished resource');
      const checkpoint = await checkpoints.checkpoint(source.handle, { scrubSecrets: false });
      await source.writeFile('later.txt', 'source moved after the checkpoint');
      await source.exec('git', ['add', 'later.txt']);
      await source.exec('git', ['commit', '-qm', 'later work']);
      const plan = forkWorldSource(sourceTask, source.handle)!;
      const capture = vi.spyOn(checkpoints, 'checkpoint');
      const status = worlds.status.bind(worlds);
      vi.spyOn(worlds, 'status').mockImplementation((handle) => handle.id === sourceTask.id
        ? Promise.resolve('parked') : status(handle));
      const core = makeCoreActivities({ store, worlds, adapters: new Map(), resources, checkpoints,
        profiles: new ProfileResolver(store, 'mock'), contentDir: path.join(dir, 'content') });
      const create = async (base: string, reuse: boolean) => {
        const task = store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
          workflowVersion: '1.0.0', params: { prompt: 'fork', base, _forkWorld: plan } });
        const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo,
          base, target: 'main', kind: 'worktree' });
        created.push(handle);
        if (reuse) expect(store.kvGet(`fork-checkpoint:${task.id}`)).toBe(checkpoint.id);
        return worlds.open(handle);
      };
      const fork = await create(plan.base, true);
      const forkRepo = fork.handle.repos!.find((entry) => entry.role !== 'project-wiki')!;
      const prefix = `${forkRepo.name}/`;
      expect(forkRepo.branch).not.toBe(source.handle.branch);
      expect((await fork.exec('git', ['rev-parse', 'HEAD'], { cwd: forkRepo.root })).stdout.trim()).toBe(head);
      expect(await fork.readFile(`${prefix}file.txt`)).toBe('dirty');
      expect(await fork.readFile(`${prefix}committed.txt`)).toBe('unlanded commit');
      expect(await fork.readFile(`${prefix}nested/new.txt`)).toBe('untracked nested file');
      await expect(fork.readFile(`${prefix}later.txt`)).rejects.toThrow();
      expect(await fork.readFile('data/value.txt')).toBe('unpublished resource');
      await fork.writeFile('data/value.txt', 'fork changed');
      expect(await source.readFile('data/value.txt')).toBe('unpublished resource');
      expect(store.currentWorld(sourceTask.id)?.generation).toBe(source.handle.generation);
      expect(capture).not.toHaveBeenCalled();

      const fresh = await create('main', false);
      const freshRepo = fresh.handle.repos!.find((entry) => entry.role !== 'project-wiki')!;
      expect(await fresh.readFile(`${freshRepo.name}/file.txt`)).toBe('main');
      await expect(fresh.readFile(`${freshRepo.name}/committed.txt`)).rejects.toThrow();
      expect(await fresh.readFile('data/value.txt')).toBe('promoted');
      expect(capture).not.toHaveBeenCalled();
    } finally {
      for (const handle of created) await (await worlds.open(handle)).destroy();
      await source.destroy();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies repositoryless output files without copying injected secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-plain-'));
    const store = new Store(':memory:');
    const project = store.createProject('Documents');
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')), broker);
    const source = await worlds.create('worktree', { taskId: 'source', base: 'main' });
    source.handle.meta = { ephemeralPaths: ['credential.txt'] };
    source.handle = store.registerWorld(source.handle, project.id) as WorldHandle;
    const fork = await worlds.create('worktree', { taskId: 'fork', base: 'main' });
    try {
      await source.writeFile('reports/result.txt', 'saved output');
      await source.writeFile('credential.txt', 'private');
      await source.writeFile('.env', 'private');
      await source.writeFile('.karmax-injection/session.json', 'private');
      const checkpoint = await checkpoints.checkpoint(source.handle);
      await checkpoints.applyFork(checkpoint.id, fork, project.id);
      expect(await fork.readFile('reports/result.txt')).toBe('saved output');
      for (const file of ['credential.txt', '.env', '.karmax-injection/session.json'])
        await expect(fork.readFile(file)).rejects.toThrow();
      await expect(checkpoints.applyFork(checkpoint.id, fork, 'another-project')).rejects.toThrow(/unavailable/);
      await expect(checkpoints.applyFork(checkpoint.id, source, project.id)).rejects.toThrow(/independent/);
    } finally {
      await fork.destroy();
      await source.destroy();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves separate repository branches and commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-repos-'));
    const store = new Store(':memory:');
    const repositories = ['one', 'two'].map((name) => path.join(dir, name));
    for (const repo of repositories) {
      fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'file'), 'initial');
      await gitOrThrow(repo, ['add', '.']);
      await gitOrThrow(repo, ['commit', '-qm', 'initial']);
    }
    const project = store.createProject('Repos', { repos: repositories });
    const task = store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } });
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')), broker);
    const source = await worlds.create('worktree', { taskId: task.id, repos: repositories, base: 'main', target: 'main' });
    source.handle = store.registerWorld(source.handle, project.id) as WorldHandle;
    const fork = await worlds.create('worktree', { taskId: 'fork', repos: repositories, base: 'main' });
    try {
      for (const repo of source.handle.repos!) {
        await source.writeFile(`${repo.name}/file`, `committed ${repo.name}`);
        await source.exec('git', ['commit', '-am', 'source work'], { cwd: repo.root });
        await source.writeFile(`${repo.name}/dirty`, `dirty ${repo.name}`);
      }
      const checkpoint = await checkpoints.checkpoint(source.handle);
      await checkpoints.applyFork(checkpoint.id, fork, project.id);
      for (const repo of fork.handle.repos!) {
        expect(await fork.readFile(`${repo.name}/file`)).toBe(`committed ${repo.name}`);
        expect(await fork.readFile(`${repo.name}/dirty`)).toBe(`dirty ${repo.name}`);
        expect(repo.baseSha).toBe(checkpoint.repos.find((entry) => entry.checkoutPath === repo.name)?.headSha);
      }
      store.saveView(task.id, { status: 'done', targetBranch: 'main' } as any);
      expect(forkWorldSource(store.getTask(task.id)!, source.handle)?.repos.map((repo) => repo.base)).toEqual(['main', 'main']);
    } finally {
      await fork.destroy();
      await source.destroy();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
