import { describe, expect, it } from 'vitest';
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
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { ProjectEnvironment } from '../src/store/project-environment.js';
import { ProjectServices } from '../src/store/project-services.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';

describe('portable world checkpoints', () => {
  it('encrypts a dirty binary delta, restores it into a new generation, and fences the stale generation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-checkpoint-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = new Store(':memory:');
    const project = store.createProject('Portable', { repos: [repo], defaultBase: 'main', worldProvider: 'worktree' });
    const task = store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } });
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker);
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id, ephemeralPaths: ['private.bin'] };
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
    const stale = { ...world.handle };
    await world.writeFileBuffer!('binary.dat', Buffer.from([0, 1, 2, 255]));
    await world.writeFile('private.bin', 'injected credential material');
    await world.writeFile('tracked.txt', 'after\n');
    expect((await world.exec('git', ['mv', 'tracked.txt', 'renamed.txt'])).code).toBe(0);

    const checkpoint = await checkpoints.checkpoint(world.handle);
    const encrypted = await objects.get(checkpoint.filesystemDelta!.objectKey);
    expect(encrypted.subarray(0, 4).toString()).toBe('KMX1');
    expect(encrypted.toString()).not.toContain('after');
    await world.destroy();

    const restoredHandle = await checkpoints.restore(checkpoint.id, 'worktree');
    expect(restoredHandle.generation).toBe(2);
    const restored = await worlds.open(restoredHandle);
    await expect(restored.readFile('tracked.txt')).rejects.toThrow();
    expect(await restored.readFile('renamed.txt')).toBe('after\n');
    expect([...await restored.readFileBuffer('binary.dat')]).toEqual([0, 1, 2, 255]);
    await expect(restored.readFile('private.bin')).rejects.toThrow();
    expect(() => store.assertCurrentWorld(stale)).toThrow(/stale world generation/);

    await restored.destroy();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replays checkpoint-pinned boot hooks and service topology with opaque endpoint handles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-checkpoint-runtime-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);

    const oldPath = process.env.PATH, oldLog = process.env.KARMAX_TEST_DOCKER_LOG;
    const bin = path.join(dir, 'bin'), dockerLog = path.join(dir, 'docker.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$KARMAX_TEST_DOCKER_LOG"
case "$1" in
  version) echo 27.0 ;;
  inspect) echo 172.17.0.8 ;;
  *) echo container-id ;;
esac
`);
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.KARMAX_TEST_DOCKER_LOG = dockerLog;
    try {
      const store = new Store(':memory:');
      const project = store.createProject('Runtime restore', { repos: [repo], defaultBase: 'main' });
      const task = store.createTask({ projectId: project.id, title: 'Restore', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'restore' } });
      const environments = new ProjectEnvironment(store);
      const pinned = environments.setSpec(project.id, { boot: ['printf pinned-runtime > runtime-marker'] });
      new ProjectServices(store).save(project.id, { name: 'database', kind: 'per-world',
        image: 'postgres:16', containerPort: 5432, urlEnv: 'DATABASE_URL',
        urlTemplate: 'postgres://app@{host}:{port}/app' });

      const worlds = new WorldRegistry();
      const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
      worlds.register({
        kind: 'sandbox-test', parkable: true,
        async create(spec) {
          const world = await worktrees.create(spec);
          world.handle.kind = 'sandbox-test';
          return world;
        },
        async open(handle) { return worktrees.open(handle); },
      });
      const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
      const objects = new LocalObjectStore(path.join(dir, 'objects'));
      const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
      const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
      const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
      world.handle.meta = { projectId: project.id };
      world.handle.environmentDigest = environments.digest(pinned);
      world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
      const checkpoint = await checkpoints.checkpoint(world.handle);
      expect(checkpoint.environment).toEqual(pinned);
      expect(checkpoint.services?.[0]?.image).toBe('postgres:16');
      await world.destroy();

      // Later settings edits must not rewrite the topology of this checkpoint.
      environments.setSpec(project.id, { boot: ['printf changed-runtime > runtime-marker'] });
      new ProjectServices(store).save(project.id, { name: 'database', kind: 'per-world',
        image: 'redis:7', containerPort: 6379, urlEnv: 'REDIS_URL', urlTemplate: 'redis://{host}:{port}' });
      const restoredHandle = await checkpoints.restore(checkpoint.id, 'sandbox-test');
      const restored = await worlds.open(restoredHandle);
      expect(await restored.readFile('runtime-marker')).toBe('pinned-runtime');
      const calls = fs.readFileSync(dockerLog, 'utf8');
      expect(calls).toContain('postgres:16');
      expect(calls).not.toContain('redis:7');
      expect(JSON.stringify(restoredHandle)).not.toContain('postgres://app@172.17.0.8');
      const wrapped = resources.withEnvironment(restored);
      expect((await wrapped.exec('bash', ['-lc', 'printf %s "$DATABASE_URL"'])).stdout)
        .toBe('postgres://app@172.17.0.8:5432/app');
      const serviceHandle = Object.values(restoredHandle.meta?.serviceEnvironmentHandles as Record<string, string>)[0]!;
      expect(broker.hasHandle(serviceHandle)).toBe(true);
      await resources.release(restoredHandle);
      expect(broker.hasHandle(serviceHandle)).toBe(false);
      await restored.destroy();
      store.close();
    } finally {
      process.env.PATH = oldPath;
      if (oldLog === undefined) delete process.env.KARMAX_TEST_DOCKER_LOG;
      else process.env.KARMAX_TEST_DOCKER_LOG = oldLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
