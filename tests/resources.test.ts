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
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { ensureWorldExcluded } from '../src/world/secret-exclude.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('project resources', () => {
  it('Git-excludes file secrets only in the task worktree that owns them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secret-exclude-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const provider = new WorktreeProvider(path.join(dir, 'worlds'));
    const first = await provider.create({ taskId: 'secret-a', repo, base: 'main', target: 'main' });
    await first.writeFile('.env.local', 'TOKEN=secret');
    await ensureWorldExcluded(first, '.env.local');
    expect((await first.exec('git', ['status', '--porcelain'])).stdout).not.toContain('.env.local');
    await first.exec('git', ['add', '-A']);
    expect((await first.exec('git', ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');

    const second = await provider.create({ taskId: 'secret-b', repo, base: 'main', target: 'main' });
    await second.writeFile('.env.local', 'ordinary task file');
    expect((await second.exec('git', ['status', '--porcelain'])).stdout).toContain('.env.local');
    await first.destroy(); await second.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forks encrypted volume revisions, injects secrets, and promotes with a CAS fence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resources-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), '# project-local ignores\n');
    fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = new Store(':memory:');
    const project = store.createProject('Models', { repos: [repo] });
    const task = store.createTask({ projectId: project.id, title: 'Tune', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'tune' } });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);

    const volume = store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Model', driver: 'volume@1', target: { kind: 'path', path: 'resources/model' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
    const initial = await resources.importFiles(volume.id, [{ path: 'model.bin', data: Buffer.from('base-model') }]);
    const secretHandle = `resource:test:token`;
    broker.registerHandle(secretHandle, 'secret-token');
    store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Training token', driver: 'secret@1', target: { kind: 'environment', name: 'TRAINING_TOKEN' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [secretHandle], publish: 'discard' });

    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = resources.registerServiceEnvironment(world.handle,
      { DATABASE_URL: 'postgres://private-per-world-endpoint' });
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
    expect(await world.readFile('resources/model/model.bin')).toBe('base-model');
    expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
    const wrapped = resources.withEnvironment(world);
    expect((await wrapped.exec('bash', ['-lc', 'printf %s "$TRAINING_TOKEN"'])).stdout).toBe('secret-token');
    expect((await wrapped.exec('bash', ['-lc', 'printf %s "$DATABASE_URL"'])).stdout)
      .toBe('postgres://private-per-world-endpoint');
    expect(JSON.stringify(world.handle)).not.toContain('secret-token');
    expect(JSON.stringify(world.handle)).not.toContain('private-per-world-endpoint');
    const serviceHandle = Object.values(world.handle.meta?.serviceEnvironmentHandles as Record<string, string>)[0]!;
    expect(broker.hasHandle(serviceHandle)).toBe(true);

    const tunedBytes = Buffer.from('fine-tuned-model');
    await world.writeFileBuffer!('resources/model/model.bin', tunedBytes);
    const summary = await resources.summarize(task.id, volume.id);
    expect(summary).toMatchObject({ added: 0, modified: 1, deleted: 0 });
    const promoted = await resources.promote(task.id, volume.id);
    expect(promoted.revision.parentRevisionId).toBe(initial.id);
    expect(store.getResourceAttachment(volume.id)?.currentRevisionId).toBe(promoted.revision.id);

    const consumer = store.createTask({ projectId: project.id, title: 'Use model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'evaluate' } });
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    consumerWorld.handle = store.registerWorld(consumerWorld.handle, project.id) as typeof consumerWorld.handle;
    expect(await consumerWorld.readFileBuffer('resources/model/model.bin')).toEqual(tunedBytes);

    // This generation is still pinned to its original lease. A second publish
    // cannot overwrite a baseline that moved since the task forked.
    await expect(resources.promote(task.id, volume.id)).rejects.toThrow(/baseline changed/);

    const storedBytes = allFiles(path.join(dir, 'objects')).map((file) => fs.readFileSync(file)).join('');
    expect(storedBytes).not.toContain('fine-tuned-model');
    await resources.release(consumerWorld.handle);
    await consumerWorld.destroy();
    await resources.release(world.handle);
    expect(broker.hasHandle(serviceHandle)).toBe(false);
    await world.destroy();
    await resources.deleteAttachment(volume.id);
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates unsafe targets and shared-write publication', () => {
    const store = new Store(':memory:');
    const project = store.createProject('Safety');
    expect(() => store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Escape', driver: 'volume@1', target: { kind: 'path', path: '../outside' }, access: 'read',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' })).toThrow(/world-relative/);
    expect(() => store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Prod', driver: 'database@1', target: { kind: 'service', name: 'DATABASE_URL' }, access: 'write',
      isolation: 'shared', source: {}, credentialHandles: ['db'], publish: 'review' })).toThrow(/cannot be promoted/);
    store.close();
  });

  it('uses an online backup for SQLite volume revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sqlite-resource-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'resources/\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
    const database = path.join(dir, 'state.db');
    const db = new DatabaseSync(database); db.exec('CREATE TABLE values_(value TEXT); INSERT INTO values_ VALUES (\'before\')'); db.close();
    const store = new Store(':memory:'); const project = store.createProject('SQLite', { repos: [repo] });
    const task = store.createTask({ projectId: project.id, title: 'Edit DB', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'edit' } });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const attachment = store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'SQLite', driver: 'volume@1', target: { kind: 'path', path: 'resources/db' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
    await resources.importDirectory(attachment.id, database);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
    const update = await world.exec('python3', ['-c',
      "import sqlite3; d=sqlite3.connect('resources/db/state.db'); d.execute(\"INSERT INTO values_ VALUES ('after')\"); d.commit(); d.close()"]);
    expect(update.code).toBe(0);
    await resources.promote(task.id, attachment.id);
    const check = await world.exec('python3', ['-c',
      "import sqlite3; print(','.join(x[0] for x in sqlite3.connect('resources/db/state.db').execute('select value from values_ order by rowid')))"]);
    expect(check.stdout.trim()).toBe('before,after');
    await resources.release(world.handle); await world.destroy(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams snapshots larger than one storage chunk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-stream-'));
    const store = new Store(':memory:'); const project = store.createProject('Stream');
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    const engine = new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker);
    const resources = new ProjectResourceService(store, worlds, engine, broker);
    const attachment = store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Weights', driver: 'volume@1', target: { kind: 'path', path: 'weights' }, access: 'read',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' });
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 19, 0x71);
    const captured = await engine.capture(attachment, (async function* () {
      yield { path: 'model.bin', data: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 700_000) yield bytes.subarray(offset, offset + 700_000);
      })() };
    })());
    const revision = store.saveResourceRevision({ attachmentId: attachment.id, engine: engine.id, ...captured, metadata: {} });
    const restored: Buffer[] = [];
    await engine.restore(revision, async (_path, chunk) => { restored.push(chunk); });
    expect(crypto.createHash('sha256').update(Buffer.concat(restored)).digest('hex'))
      .toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    await resources.deleteAttachment(attachment.id);
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

function allFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(value) : [value];
  });
}
