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
import { ProjectResourceService } from '../src/world/resources.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

describe('portable world checkpoints', () => {
  it('encrypts a dirty binary delta, restores it into a new generation, and fences the stale generation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-checkpoint-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.bin\nstate.sqlite\n');
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
    const resources = new ProjectResourceService(store, objects, broker);
    const mutable = resources.create(project.id, {
      name: 'Ignored mutable input',
      spec: { kind: 'file', inject: { path: 'ignored.bin' }, mutable: true },
    });
    await resources.upload(mutable.id, Buffer.from('initial'));
    resources.create(project.id, {
      name: 'Task database',
      spec: { kind: 'database', driver: 'sqlite', path: 'state.sqlite' },
    });
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
    await resources.materialize(task.id, project.id, world);
    const stale = { ...world.handle };
    await world.writeFileBuffer!('binary.dat', Buffer.from([0, 1, 2, 255]));
    await world.writeFile('tracked.txt', 'after\n');
    await world.writeFileBuffer!('ignored.bin', Buffer.from([9, 8, 7, 6]));
    const sqlite = await world.exec('node', ['-e',
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('state.sqlite');d.exec(\"CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('durable')\");d.close()"]);
    expect(sqlite.code).toBe(0);
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
    expect([...await restored.readFileBuffer('ignored.bin')]).toEqual([9, 8, 7, 6]);
    const query = await restored.exec('node', ['-e',
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('state.sqlite');process.stdout.write(d.prepare('SELECT value FROM notes').get().value);d.close()"]);
    expect(query.code).toBe(0);
    expect(query.stdout).toBe('durable');
    expect(() => store.assertCurrentWorld(stale)).toThrow(/stale world generation/);

    await restored.destroy();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
