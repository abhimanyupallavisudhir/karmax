import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { ProjectObjects, sha256 } from '../src/store/project-objects.js';
import { materializeObjectMounts, objectMountManifest, enclosingRepo } from '../src/world/mounts.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

function memoryKv() {
  const kv = new Map<string, string>();
  return { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) };
}

describe('ProjectObjects', () => {
  let dir: string;
  let objects: ProjectObjects;
  const projectId = 'proj_test';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-objects-'));
    objects = new ProjectObjects(memoryKv(), new LocalObjectStore(dir));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores content-addressed versions with a history chain', async () => {
    const v1 = await objects.put(projectId, { path: 'fixtures/dev.sqlite', mode: 'writeback', data: Buffer.from('v1') });
    expect(v1.object).toBe(sha256(Buffer.from('v1')));
    expect(v1.history).toBeUndefined();
    const v2 = await objects.put(projectId, { path: 'fixtures/dev.sqlite', data: Buffer.from('v2') });
    expect(v2.mode).toBe('writeback'); // mode survives content-only updates
    expect(v2.history).toEqual([expect.objectContaining({ object: v1.object, bytes: 2 })]);
    expect((await objects.data(projectId, v1.object)).toString()).toBe('v1'); // old versions remain fetchable
    expect((await objects.data(projectId, v2.object)).toString()).toBe('v2');
  });

  it('promotes only declared, non-readonly mounts', async () => {
    await objects.put(projectId, { path: 'weights.bin', mode: 'readonly', data: Buffer.from('w') });
    await expect(objects.promote(projectId, 'weights.bin', Buffer.from('w2'))).rejects.toThrow(/readonly/);
    await expect(objects.promote(projectId, 'undeclared.bin', Buffer.from('x'))).rejects.toThrow(/no declared/);
    await objects.put(projectId, { path: 'db.sqlite', mode: 'seed', data: Buffer.from('s1') });
    const promoted = await objects.promote(projectId, 'db.sqlite', Buffer.from('s2'));
    expect(promoted.object).toBe(sha256(Buffer.from('s2')));
    expect(promoted.history!.length).toBe(1);
  });

  it('removes mounts but keeps blobs for history', async () => {
    const mount = await objects.put(projectId, { path: 'a.bin', data: Buffer.from('a') });
    objects.remove(projectId, 'a.bin');
    expect(objects.list(projectId)).toEqual([]);
    expect((await objects.data(projectId, mount.object)).toString()).toBe('a');
  });

  it('validates paths and object ids', async () => {
    await expect(objects.put(projectId, { path: '../escape', data: Buffer.from('x') })).rejects.toThrow(/escapes/);
    await expect(objects.data(projectId, 'not-a-sha')).rejects.toThrow(/sha256/);
  });
});

describe('object mounts in worlds (real worktree + checkpoint)', () => {
  let home: string;
  let repo: string;
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-state-'));
    store = new Store(':memory:');
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'fixtures/\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    for (const p of [home, repo, dir]) fs.rmSync(p, { recursive: true, force: true });
  });

  it('materializes modes and checkpoints gitignored mount drift', async () => {
    const objectStore = new LocalObjectStore(path.join(dir, 'objects'));
    const projects = new ProjectObjects(store, objectStore);
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, objectStore, broker);
    const project = store.createProject('P', { repos: [repo] });

    await projects.put(project.id, { path: 'fixtures/dev.sqlite', mode: 'seed', data: Buffer.from('seed-v1') });
    await projects.put(project.id, { path: 'weights.bin', mode: 'readonly', data: Buffer.from('weights') });

    const world = await worlds.create('worktree', { taskId: 'obj1', repo, base: 'main', target: 'main' });
    const manifest = await materializeObjectMounts(world, await projects.resolved(project.id));
    world.handle.meta = { ...world.handle.meta, objectMounts: manifest };
    store.registerWorld(world.handle, project.id);
    expect(await world.readFile('fixtures/dev.sqlite')).toBe('seed-v1');
    expect(fs.statSync(path.join(world.handle.root, 'weights.bin')).mode & 0o222).toBe(0); // readonly
    expect(objectMountManifest(world.handle.meta).length).toBe(2);

    // The seed file is gitignored, so git status cannot see the task's change —
    // the checkpoint captures it anyway via the mount manifest (sha drift).
    await world.writeFile('fixtures/dev.sqlite', 'task-local change');
    const checkpoint = await checkpoints.checkpoint(world.handle as any);
    const encrypted = await objectStore.get(checkpoint.filesystemDelta!.objectKey);
    expect(encrypted.length).toBeGreaterThan(0);

    // Restore: mounts come back at current project versions, then the delta
    // reapplies the task-local change on top.
    const restored = await checkpoints.restore(checkpoint.id);
    const restoredWorld = await worlds.open(restored);
    expect(await restoredWorld.readFile('fixtures/dev.sqlite')).toBe('task-local change');
    expect(await restoredWorld.readFile('weights.bin')).toBe('weights');
    await restoredWorld.destroy();
    await world.destroy();
  });

  it('maps world-relative paths to their enclosing repo', async () => {
    const world = await new WorktreeProvider(home).create({ taskId: 'obj2', repo, base: 'main', target: 'main' });
    const enclosing = enclosingRepo(world.handle, 'fixtures/dev.sqlite');
    expect(enclosing?.inRepo).toBe('fixtures/dev.sqlite');
    await world.destroy();
  });
});
