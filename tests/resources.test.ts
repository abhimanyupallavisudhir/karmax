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
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { resourceSecretHandle } from '../src/domain/resource-drivers.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { ensureWorldExcluded } from '../src/world/secret-exclude.js';
import { itemHandle, VaultItems } from '../src/autonomy/vault-items.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CapabilityError, KarmaxApi } from '../src/platform/api.js';
import { worldWorkingRelativePath } from '../src/world/types.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('project resources', () => {
  it.each(['configured', 'default', 'legacy'] as const)('preserves %s global Git ignores alongside worktree secrets (WD-29)', async source => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secret-inherited-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    const xdg = path.join(dir, 'config'); fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
    const ignores = source !== 'default' ? path.join(dir, 'global-ignore') : path.join(xdg, 'git', 'ignore');
    const config = path.join(dir, 'gitconfig');
    fs.writeFileSync(config, source !== 'default' ? `[core]\nexcludesFile = ${ignores}\n` : '');
    fs.writeFileSync(ignores, '*.cache\n');
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    await gitOrThrow(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const world = await new WorktreeProvider(path.join(dir, 'worlds'))
      .create({ taskId: 'inherited', repo, base: 'main', target: 'main' });
    const exec = world.exec.bind(world);
    world.exec = (command, args, options) => exec(command, args, { ...options,
      env: { ...options?.env, GIT_CONFIG_GLOBAL: config, XDG_CONFIG_HOME: xdg } });
    try {
      if (source === 'legacy') {
        await world.exec('git', ['config', 'extensions.worktreeConfig', 'true']);
        const admin = (await world.exec('git', ['rev-parse', '--absolute-git-dir'])).stdout.trim();
        fs.mkdirSync(path.join(admin, 'info'), { recursive: true });
        fs.writeFileSync(path.join(admin, 'info/exclude'), '/.env.legacy\n');
        await world.exec('git', ['config', '--worktree', 'core.excludesFile', path.join(admin, 'info/exclude')]);
        await world.writeFile('.env.legacy', 'legacy secret');
      }
      await world.writeFile('artifact.cache', 'generated');
      await world.writeFile('.env.local', 'secret');
      await ensureWorldExcluded(world, '.env.local');
      expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
      fs.appendFileSync(ignores, '*.log\n');
      await world.writeFile('output.log', 'generated');
      await world.writeFile('.env.second', 'second secret');
      await ensureWorldExcluded(world, '.env.second');
      expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
      expect(fs.readFileSync(ignores, 'utf8')).toBe('*.cache\n*.log\n');
      expect((await git(repo, ['config', '--local', '--get', 'core.excludesFile'])).code).toBe(1);
    } finally { await world.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([undefined, 'nested'] as const)('Git-excludes file secrets only in their owning worktree (%s layout)', async (layout) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secret-exclude-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const provider = new WorktreeProvider(path.join(dir, 'worlds'));
    const first = await provider.create({ taskId: 'secret-a', repo, base: 'main', target: 'main', layout });
    const target = worldWorkingRelativePath(first.handle, '.env.local');
    await first.writeFile(target, 'TOKEN=secret');
    await ensureWorldExcluded(first, target);
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

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Models', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Tune', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'tune' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);

    const volume = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Model', driver: 'volume@1', target: { kind: 'path', path: 'resources/model' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
    const initial = await resources.importFiles(volume.id, [{ path: 'model.bin', data: Buffer.from('base-model') }]);
    const secretHandle = resourceSecretHandle('resource_training_token');
    (await broker.registerHandle(secretHandle, 'secret-token', INSTALLATION_SCOPE));
    (await store.createResourceAttachment({ id: 'resource_training_token', organizationId: project.organizationId!, projectId: project.id,
      name: 'Training token', driver: 'secret@1', target: { kind: 'environment', name: 'TRAINING_TOKEN' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [secretHandle], publish: 'discard' }));

    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = await resources.registerServiceEnvironment(world.handle,
      { DATABASE_URL: 'postgres://private-per-world-endpoint' }, project.organizationId!);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    expect(await world.readFile('resources/model/model.bin')).toBe('base-model');
    const leasesBeforeVerification = (await store.listResourceLeases(world.handle.id));
    expect(leasesBeforeVerification.length).toBeGreaterThan(0);
    expect((await resources.verifyRevision(project.id, volume.id, initial.id)).status).toBe('complete');
    expect((await store.listResourceLeases(world.handle.id))).toEqual(leasesBeforeVerification);

    expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
    const wrapped = (await resources.withEnvironment(world));
    expect((await wrapped.exec('bash', ['-lc', 'printf %s "$TRAINING_TOKEN"'])).stdout).toBe('secret-token');
    expect((await wrapped.exec('bash', ['-lc', 'printf %s "$DATABASE_URL"'])).stdout)
      .toBe('postgres://private-per-world-endpoint');
    expect(JSON.stringify(world.handle)).not.toContain('secret-token');
    expect(JSON.stringify(world.handle)).not.toContain('private-per-world-endpoint');
    // A sandbox's own failure evidence must survive the wrapper (task 350); a
    // local world has none, which keeps its host-memory classification.
    expect(wrapped.diagnose).toBeUndefined();
    const evidence = { summary: 'sandbox stopped responding', memoryExhausted: false };
    const sandboxWorld = Object.assign(Object.create(world), { diagnose: async () => evidence });
    expect(await (await resources.withEnvironment(sandboxWorld)).diagnose?.({ since: 0 })).toBe(evidence);
    const serviceHandle = Object.values(world.handle.meta?.serviceEnvironmentHandles as Record<string, string>)[0]!;
    expect(broker.hasHandle(serviceHandle)).toBe(true);

    const tunedBytes = Buffer.from('fine-tuned-model');
    await world.writeFileBuffer!('resources/model/model.bin', tunedBytes);
    const summary = await resources.summarize(task.id, volume.id);
    expect(summary).toMatchObject({ added: 0, modified: 1, deleted: 0 });
    await resources.beginReview(task.id);
    await resources.settleReview(task.id);
    const promoted = { revision: (await store.getResourceRevision((await store.getResourceAttachment(volume.id))!.currentRevisionId!))! };
    await resources.settleReview(task.id);
    expect(promoted.revision.parentRevisionId).toBe(initial.id);
    expect((await store.getResourceAttachment(volume.id))?.currentRevisionId).toBe(promoted.revision.id);
    expect((await resources.summarize(task.id, volume.id)).promoted).toBe(true);
    await world.writeFileBuffer!('resources/model/model.bin', Buffer.from('further edits'));
    expect((await resources.summarize(task.id, volume.id)).promoted).not.toBe(true);
    await world.writeFileBuffer!('resources/model/model.bin', tunedBytes);

    const consumer = (await store.createTask({ projectId: project.id, title: 'Use model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'evaluate' } }));
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    consumerWorld.handle = (await store.registerWorld(consumerWorld.handle, project.id)) as typeof consumerWorld.handle;
    expect(await consumerWorld.readFileBuffer('resources/model/model.bin')).toEqual(tunedBytes);
    await consumerWorld.writeFileBuffer!('resources/model/model.bin', Buffer.from('next baseline'));
    await resources.promote(consumer.id, volume.id);
    expect((await resources.summarize(task.id, volume.id)).promoted).toBe(true);

    // This generation is still pinned to its original lease. A second publish
    // cannot overwrite a baseline that moved since the task forked.
    await expect(resources.promote(task.id, volume.id)).rejects.toThrow(/baseline changed/);

    await world.writeFileBuffer!('resources/model/model.bin', Buffer.from('conflicting task edit'));
    await resources.beginReview(task.id, 'second-review');
    await expect(resources.settleReview(task.id)).rejects.toThrow(/baseline changed/);
    await expect(resources.setReviewExcluded(task.id, volume.id, true)).rejects.toThrow(/confirmed/);
    // A revised proposal can exclude the conflict without changing the other task's baseline.
    const headBeforeExclude = (await store.getResourceAttachment(volume.id))!.currentRevisionId;
    await resources.beginReview(task.id, 'third-review');
    await resources.setReviewExcluded(task.id, volume.id, true);
    await resources.settleReview(task.id);
    expect((await store.getResourceAttachment(volume.id))!.currentRevisionId).toBe(headBeforeExclude);

    const storedBytes = allFiles(path.join(dir, 'objects')).map((file) => fs.readFileSync(file)).join('');
    expect(storedBytes).not.toContain('fine-tuned-model');
    await resources.release(consumerWorld.handle);
    await consumerWorld.destroy();
    await resources.release(world.handle);
    expect(broker.hasHandle(serviceHandle)).toBe(false);
    await world.destroy();
    await resources.deleteAttachment(volume.id);
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Task legibench3#10 (2026-10-01): a task that had already published its
  // spend ledger once could never publish it again. Every later confirmation
  // fenced on the lease's original revision, which its own first publication
  // had replaced, so the workflow failed "resource baseline changed".
  it('publishes again on top of the task\'s own earlier publication', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-republish-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'resources/\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Ledger', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Run', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'run' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const ledger = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Ledger', driver: 'volume@1', target: { kind: 'path', path: 'resources/ledger' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
    const initial = await resources.importFiles(ledger.id, [{ path: 'spend.txt', data: Buffer.from('0') }]);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    const current = async () => (await store.getResourceRevision((await store.getResourceAttachment(ledger.id))!.currentRevisionId!))!;

    await world.writeFileBuffer!('resources/ledger/spend.txt', Buffer.from('10'));
    await resources.beginReview(task.id, 'first');
    await resources.settleReview(task.id);
    const first = await current();
    expect(first.parentRevisionId).toBe(initial.id);

    await world.writeFileBuffer!('resources/ledger/spend.txt', Buffer.from('25'));
    expect((await resources.summarize(task.id, ledger.id)).promoted).not.toBe(true);
    await resources.beginReview(task.id, 'second');
    await resources.settleReview(task.id);
    const second = await current();
    expect(second.id).not.toBe(first.id);
    expect(second.parentRevisionId).toBe(first.id);
    expect((await resources.summarize(task.id, ledger.id)).promoted).toBe(true);

    // Another task's publication in between is still a conflict.
    const other = (await store.createTask({ projectId: project.id, title: 'Other', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'other' } }));
    const otherWorld = await worlds.create('worktree', { taskId: other.id, repo, base: 'main' });
    otherWorld.handle = await resources.materialize(project.id, other.id, otherWorld, 1);
    otherWorld.handle = (await store.registerWorld(otherWorld.handle, project.id)) as typeof otherWorld.handle;
    await otherWorld.writeFileBuffer!('resources/ledger/spend.txt', Buffer.from('40'));
    await resources.promote(other.id, ledger.id);
    await world.writeFileBuffer!('resources/ledger/spend.txt', Buffer.from('30'));
    await resources.beginReview(task.id, 'third');
    await expect(resources.settleReview(task.id)).rejects.toThrow(/baseline changed/);

    await resources.release(otherWorld.handle); await otherWorld.destroy();
    await resources.release(world.handle); await world.destroy();
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates unsafe targets and shared-write publication', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Safety'));
    await expect((async () => (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Escape', driver: 'volume@1', target: { kind: 'path', path: '../outside' }, access: 'read',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' })))()).rejects.toThrow(/world-relative/);
    await expect((async () => (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Prod', driver: 'database@1', target: { kind: 'service', name: 'DATABASE_URL' }, access: 'write',
      isolation: 'shared', source: {}, credentialHandles: ['db'], publish: 'review' })))()).rejects.toThrow(/cannot be promoted/);
    (await store.close());
  });

  it('uses an online backup for SQLite volume revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sqlite-resource-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'resources/\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
    const database = path.join(dir, 'state.db');
    const db = new DatabaseSync(database); db.exec('CREATE TABLE values_(value TEXT); INSERT INTO values_ VALUES (\'before\')'); db.close();
    const store = (await Store.create(':memory:')); const project = (await store.createProject('SQLite', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Edit DB', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'edit' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const attachment = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'SQLite', driver: 'volume@1', target: { kind: 'path', path: 'resources/db' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
    await resources.importDirectory(attachment.id, database);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    const update = await world.exec('python3', ['-c',
      "import sqlite3; d=sqlite3.connect('resources/db/state.db'); d.execute(\"INSERT INTO values_ VALUES ('after')\"); d.commit(); d.close()"]);
    expect(update.code).toBe(0);
    await resources.promote(task.id, attachment.id);
    const check = await world.exec('python3', ['-c',
      "import sqlite3; print(','.join(x[0] for x in sqlite3.connect('resources/db/state.db').execute('select value from values_ order by rowid')))"]);
    expect(check.stdout.trim()).toBe('before,after');
    await resources.release(world.handle); await world.destroy(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams snapshots larger than one storage chunk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-stream-'));
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Stream'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    const engine = new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker);
    const resources = new ProjectResourceService(store, worlds, engine, broker);
    const attachment = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Weights', driver: 'volume@1', target: { kind: 'path', path: 'weights' }, access: 'read',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' }));
    for (const expectedBytes of [1, 3]) {
      await expect(engine.capture(attachment, (async function* () {
        yield { path: 'short.bin', bytes: expectedBytes, data: Buffer.from('ab') };
      })())).rejects.toThrow('resource capture size mismatch');
    }
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 19, 0x71);
    const captured = await engine.capture(attachment, (async function* () {
      yield { path: 'model.bin', data: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 700_000) yield bytes.subarray(offset, offset + 700_000);
      })() };
    })());
    const revision = (await store.saveResourceRevision({ attachmentId: attachment.id, engine: engine.id, ...captured, metadata: {} }));
    const restored: Buffer[] = [];
    await engine.restore(revision, async (_path, chunk) => { restored.push(chunk); });
    expect(crypto.createHash('sha256').update(Buffer.concat(restored)).digest('hex'))
      .toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(restored.map(chunk => chunk.length)).toEqual([8 * 1024 * 1024, 1024 * 1024 + 19]);
    const cancellation = new AbortController();
    let writes = 0;
    await expect(engine.restore(revision, async () => {
      writes++; cancellation.abort(new Error('stop restoring'));
    }, { signal: cancellation.signal })).rejects.toThrow('stop restoring');
    expect(writes).toBe(1);
    await resources.deleteAttachment(attachment.id);
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bounds independent restore writes and settles them before returning cancellation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-cancel-'));
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Restore cancellation');
      const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
      const engine = new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker);
      new ProjectResourceService(store, new WorldRegistry(), engine, broker);
      const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: 'Files', driver: 'volume@1', target: { kind: 'path', path: 'files' }, access: 'read',
        isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' });
      const captured = await engine.capture(attachment, (async function* () {
        for (let i = 0; i < 8; i++) yield { path: `${i}.txt`, data: Buffer.from(String(i)) };
      })());
      const revision = await store.saveResourceRevision({ attachmentId: attachment.id, engine: engine.id, ...captured, metadata: {} });
      const cancellation = new AbortController();
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      let writes = 0, settled = 0;
      await expect(engine.restore(revision, async () => {
        writes++;
        if (writes === 4) { cancellation.abort(new Error('cancel batch')); finish(); }
        await gate;
        settled++;
      }, { signal: cancellation.signal })).rejects.toThrow('cancel batch');
      expect(writes).toBe(4);
      expect(settled).toBe(4);
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('stages a task-created ignored dataset and adopts it after the world is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-candidate-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'downloads/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Candidates', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Download model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'download it' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.exec('mkdir', ['-p', 'downloads']);
    await world.writeFileBuffer!('downloads/model.bin', Buffer.from('agent-created-model'));

    const proposed = await resources.proposePath(task.id, {
      path: 'downloads', name: 'Downloaded model', target: { kind: 'path', path: 'models/downloaded' },
      access: 'read', publish: 'discard',
    });
    expect(proposed.candidate).toMatchObject({ taskId: task.id, worldId: world.handle.id,
      worldGeneration: world.handle.generation ?? 1, state: 'pending', sourceKind: 'path', sourcePath: 'downloads' });
    expect(proposed.attachment.enabled).toBe(false);
    // Proposing only validates; the snapshot is taken when the workflow stages
    // it at the end of Do, so it holds the output's final content.
    expect(proposed.revision).toBeUndefined();
    await world.writeFileBuffer!('downloads/model.bin', Buffer.from('agent-created-model, final'));

    await world.writeFile('omitted.bin', 'omitted');
    await world.writeFile('also-omitted.bin', 'also omitted');
    const omitted = await resources.proposePath(task.id, { path: 'omitted.bin', name: 'Omitted', target: { kind: 'path', path: 'models/omitted' } });
    const alsoOmitted = await resources.proposePath(task.id, { path: 'also-omitted.bin', name: 'Also omitted', target: { kind: 'path', path: 'models/also-omitted' } });
    await resources.beginReview(task.id);
    await resources.setReviewExcluded(task.id, proposed.attachment.id, true);
    expect(await resources.reviewExclusions(task.id)).toEqual([proposed.attachment.id]);
    await Promise.all([
      resources.setReviewExcluded(task.id, proposed.attachment.id, false),
      resources.setReviewExcluded(task.id, omitted.attachment.id, true),
      resources.setReviewExcluded(task.id, alsoOmitted.attachment.id, true),
    ]);
    expect((await resources.reviewExclusions(task.id)).sort()).toEqual([omitted.attachment.id, alsoOmitted.attachment.id].sort());
    expect(await resources.stageCandidates(task.id, { final: true })).toEqual({ staged: [proposed.candidate.id,
      omitted.candidate.id, alsoOmitted.candidate.id], failed: [] });
    const staged = (await store.getResourceAttachment(proposed.attachment.id))!;
    expect((await store.getResourceRevision(staged.currentRevisionId!))).toMatchObject({
      bytes: Buffer.byteLength('agent-created-model, final'), files: 1, createdByTaskId: task.id });
    expect(await resources.stageCandidates(task.id)).toEqual({ staged: [], failed: [] }); // a retry keeps them
    await world.destroy(); // staged output remains usable without the producer world
    await resources.settleReview(task.id);
    expect((await store.getResourceCandidate(omitted.candidate.id))?.state).toBe('discarded');
    expect((await store.getResourceCandidate(alsoOmitted.candidate.id))?.state).toBe('discarded');
    await resources.settleReview(task.id); // activity retry does not republish
    await expect(resources.setReviewExcluded(task.id, proposed.attachment.id, true)).rejects.toThrow(/confirmed|resolved/);
    expect((await store.getResourceCandidate(proposed.candidate.id))?.state).toBe('adopted');
    const adopted = await resources.adoptCandidate(task.id, proposed.candidate.id, 'user:reviewer');
    expect(adopted.attachment.enabled).toBe(true);
    expect(adopted.candidate).toMatchObject({ state: 'adopted', resolvedBy: `task:${task.id}:confirmation` });
    const consumer = (await store.createTask({ projectId: project.id, title: 'Use model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'use it' } }));
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    expect(await consumerWorld.readFileBuffer('models/downloaded/model.bin')).toEqual(Buffer.from('agent-created-model, final'));
    await resources.release(consumerWorld.handle); await consumerWorld.destroy();
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  async function candidateFixture(name: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-resource-${name}-`));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\nraw/\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Staging', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Build data', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'build it' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.exec('mkdir', ['-p', 'data', 'raw']);
    await world.writeFile('data/records.json', '{"records":1}');
    await world.writeFile('raw/page.txt', 'scanned page');
    const cleanup = async () => { await world.destroy(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); };
    return { store, task, resources, world, cleanup, objects: path.join(dir, 'objects') };
  }

  it('retries a transient snapshot failure and discards a candidate whose path is gone, with its reason', async () => {
    const { store, task, resources, world, cleanup } = await candidateFixture('stage-failure');
    try {
      const data = await resources.proposePath(task.id, { path: 'data', name: 'Data', target: { kind: 'path', path: 'data' } });
      const raw = await resources.proposePath(task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      // A transient failure is retried with the candidate kept…
      const exec = world.exec.bind(world);
      const flaky = vi.spyOn(world, 'exec').mockImplementation(async (command, args, options) =>
        command === 'bash' && String(args?.[1]).includes("find -H 'data'") ? { code: 1, stdout: '', stderr: 'sandbox unavailable' }
          : exec(command, args, options));
      vi.spyOn(resources['worlds'], 'open').mockResolvedValue(world);
      await expect(resources.stageCandidates(task.id)).rejects.toThrow('sandbox unavailable');
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('pending');
      // …without holding up the other candidates…
      expect((await store.getResourceAttachment(raw.attachment.id))?.currentRevisionId).toBeTruthy();
      flaky.mockRestore();
      // …and so is a sandbox that cannot answer whether the path exists…
      const silent = vi.spyOn(world, 'exec').mockImplementation(async (command, args, options) =>
        command === 'bash' && String(args?.[1]).includes('echo present') ? { code: -1, stdout: '', stderr: 'sandbox paused' }
          : exec(command, args, options));
      await expect(resources.stageCandidates(task.id)).rejects.toThrow('sandbox paused');
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('pending');
      silent.mockRestore();
      // …but a path that is really gone is final at once.
      await world.exec('rm', ['-rf', 'data']);
      const result = await resources.stageCandidates(task.id);
      expect(result.staged).toEqual([]);
      expect(result.failed).toEqual([expect.objectContaining({ candidateId: data.candidate.id, sourcePath: 'data' })]);
      const failed = (await store.getResourceCandidate(data.candidate.id))!;
      expect(failed).toMatchObject({ state: 'discarded', resolvedBy: 'system:resource-stage-failed',
        error: result.failed[0]!.error });
      expect(failed.error).toBeTruthy();
      expect(await store.getResourceAttachment(data.attachment.id)).toBeUndefined();
      expect((await store.getResourceAttachment(raw.attachment.id))?.currentRevisionId).toBeTruthy();
    } finally { vi.restoreAllMocks(); await cleanup(); }
  });

  it('settles a candidate whose snapshot never completed by discarding it, not by failing the confirmation', async () => {
    const { store, task, resources, cleanup } = await candidateFixture('settle-unstaged');
    try {
      const unstaged = await resources.proposePath(task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      const data = await resources.proposePath(task.id, { path: 'data', name: 'Data', target: { kind: 'path', path: 'data' } });
      // Stage only `data`, as if `raw`'s snapshot was cut off by a restart.
      const attachment = (await store.getResourceAttachment(unstaged.attachment.id))!;
      vi.spyOn(store, 'listResourceCandidates').mockImplementationOnce(async () => [data.candidate]);
      await resources.stageCandidates(task.id, { final: true });
      expect(attachment.currentRevisionId).toBeUndefined();
      await resources.beginReview(task.id);
      await resources.settleReview(task.id);
      expect((await store.getResourceCandidate(unstaged.candidate.id))).toMatchObject({ state: 'discarded',
        error: 'its snapshot never completed' });
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('adopted');
      await resources.settleReview(task.id); // an activity retry is a no-op
    } finally { vi.restoreAllMocks(); await cleanup(); }
  });

  it('reads a SQLite database too large to copy in place, under a read lock, and never leaves a partial copy', async () => {
    const { store, task, resources, world, cleanup } = await candidateFixture('stage-sqlite');
    try {
      const root = world.handle.workdir ?? world.handle.root;
      const file = path.join(root, 'data/records.db');
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\')'); db.close();
      const data = await resources.proposePath(task.id, { path: 'data', name: 'Data', target: { kind: 'path', path: 'data' } });
      const exec = world.exec.bind(world);
      vi.spyOn(resources['worlds'], 'open').mockResolvedValue(world);
      const tight = (command: string, args?: string[]) => command === 'bash' && String(args?.[1]).includes('df -B1')
        ? { code: 0, stdout: `${8 * 2 ** 30} ${5 * 2 ** 30}`, stderr: '' } : undefined;
      // A writer holding the database keeps the lock from being taken: say why.
      const writer = new DatabaseSync(file);
      writer.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO t VALUES (\'uncommitted\')');
      const calls = vi.spyOn(world, 'exec').mockImplementation(async (command, args, options) =>
        tight(command, args) ?? exec(command, args, options));
      await expect(resources.stageCandidates(task.id)).rejects.toThrow(
        'needs 8.0 GiB of free disk in the task world, but only 5.0 GiB is free (or the database must be idle)');
      writer.exec('ROLLBACK'); writer.close();
      // Idle, it is read in place: no copy, and a write attempted meanwhile waits for the lock.
      let blocked = false;
      calls.mockImplementation(async (command, args, options) => {
        const answer = tight(command, args);
        if (answer) return answer;
        const result = await exec(command, args, options);
        if (!blocked && command === 'bash' && String(args?.[1]).includes('records.db') && String(args?.[1]).includes('dd ')) {
          const late = new DatabaseSync(file);
          try { late.exec('INSERT INTO t VALUES (\'late\')'); } catch (error) { blocked = /locked/.test(String(error)); }
          late.close();
        }
        return result;
      });
      expect(await resources.stageCandidates(task.id, { final: true })).toMatchObject({ staged: [data.candidate.id], failed: [] });
      expect(blocked).toBe(true);
      expect(calls.mock.calls.some(([command]) => command === 'python3')).toBe(false);
      expect(fs.readdirSync(path.join(root, '.karmax-injection')).filter((name) => name.startsWith('sqlite-'))).toEqual([]);
      const revision = (await store.getResourceRevision((await store.getResourceAttachment(data.attachment.id))!.currentRevisionId!))!;
      const restored = path.join(root, 'restored'); fs.mkdirSync(restored);
      await resources['engine'].restore(revision, async (name: string, bytes: Buffer, offset: number) => {
        fs.mkdirSync(path.dirname(path.join(restored, name)), { recursive: true });
        fs.writeFileSync(path.join(restored, name), bytes, { flag: offset ? 'a' : 'w' });
      });
      const copy = new DatabaseSync(path.join(restored, 'records.db'));
      expect(copy.prepare('SELECT v FROM t ORDER BY rowid').all()).toEqual([{ v: 'kept' }]);
      copy.close();
      // With room to copy, a failed copy (disk full) is removed, not left filling the disk.
      await world.exec('bash', ['-lc', 'echo more > data/more.txt']);
      calls.mockImplementation(async (command, args, options) => {
        if (command !== 'python3') return exec(command, args, options);
        await exec('bash', ['-lc', `head -c 4096 /dev/zero > ${String(args?.[3])}`]);
        return { code: 1, stdout: '', stderr: 'sqlite3.OperationalError: database or disk is full' };
      });
      const writerAgain = new DatabaseSync(file); writerAgain.exec('INSERT INTO t VALUES (\'changed\')'); writerAgain.close();
      await expect(resources.stageCandidates(task.id)).rejects.toThrow('database or disk is full');
      expect(fs.readdirSync(path.join(root, '.karmax-injection')).filter((name) => name.startsWith('sqlite-'))).toEqual([]);
      // The snapshot already taken is kept when a refresh keeps failing.
      await resources.stageCandidates(task.id, { final: true });
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('pending');
      expect((await store.getResourceAttachment(data.attachment.id))?.currentRevisionId).toBe(revision.id);
    } finally { vi.restoreAllMocks(); await cleanup(); }
  }, 30_000);

  it('refreshes a staged candidate that changed, reading only what changed', async () => {
    const { store, task, resources, world, cleanup } = await candidateFixture('stage-refresh');
    try {
      const raw = await resources.proposePath(task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      await world.writeFile('raw/old.txt', 'settled');
      await new Promise((resolve) => setTimeout(resolve, 2_200)); // past the racy-clean window
      await resources.stageCandidates(task.id, { final: true });
      const first = (await store.getResourceAttachment(raw.attachment.id))!.currentRevisionId!;
      expect(await resources.stageCandidates(task.id)).toEqual({ staged: [], failed: [] });
      expect((await store.getResourceAttachment(raw.attachment.id))!.currentRevisionId).toBe(first);
      await world.writeFile('raw/page.txt', 'rescanned page');
      const exec = world.exec.bind(world);
      vi.spyOn(resources['worlds'], 'open').mockResolvedValue(world);
      const reads = vi.spyOn(world, 'exec').mockImplementation(exec);
      expect(await resources.stageCandidates(task.id)).toEqual({ staged: [raw.candidate.id], failed: [] });
      expect(reads.mock.calls.some(([, args]) => String(args?.[1]).includes('dd ') && String(args?.[1]).includes('old.txt'))).toBe(false);
      const second = (await store.getResourceRevision((await store.getResourceAttachment(raw.attachment.id))!.currentRevisionId!))!;
      expect(second).toMatchObject({ parentRevisionId: first, files: 2,
        bytes: Buffer.byteLength('settled') + Buffer.byteLength('rescanned page') });
    } finally { vi.restoreAllMocks(); await cleanup(); }
  }, 30_000);

  it('releases an upload whose candidate was discarded while it ran', async () => {
    const { store, task, resources, cleanup, objects } = await candidateFixture('stage-discard-race');
    try {
      const data = await resources.proposePath(task.id, { path: 'data', name: 'Data', target: { kind: 'path', path: 'data' } });
      const engine = resources['engine'];
      const capture = engine.capture.bind(engine);
      vi.spyOn(engine, 'capture').mockImplementation(async (...args: Parameters<typeof capture>) => {
        const captured = await capture(...args);
        await resources.discardCandidate(task.id, data.candidate.id, 'user:reviewer');
        return captured;
      });
      expect(await resources.stageCandidates(task.id, { final: true })).toEqual({ staged: [], failed: [] });
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('discarded');
      expect(allFiles(objects)).toHaveLength(0);
    } finally { vi.restoreAllMocks(); await cleanup(); }
  });

  it('stages a candidate once when two attempts race', async () => {
    const { store, task, resources, cleanup, objects } = await candidateFixture('stage-race');
    try {
      const data = await resources.proposePath(task.id, { path: 'data', name: 'Data', target: { kind: 'path', path: 'data' } });
      await Promise.allSettled([resources.stageCandidates(task.id), resources.stageCandidates(task.id)]);
      expect((await store.getResourceCandidate(data.candidate.id))?.state).toBe('pending');
      expect((await store.getResourceAttachment(data.attachment.id))?.currentRevisionId).toBeTruthy();
      // The loser recorded nothing, so the candidate still discards cleanly.
      expect(await store.listResourceRevisions(data.attachment.id)).toHaveLength(1);
      await resources.discardCandidate(task.id, data.candidate.id, 'user:reviewer');
      expect(allFiles(objects)).toHaveLength(0);
    } finally { await cleanup(); }
  });

  it('discards staged candidates, preserves vault items, and inventories undeclared ignored paths without content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-candidate-discard-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n.env.local\nscratch.bin\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Candidates', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Generate', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'generate' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.exec('mkdir', ['-p', 'generated']); await world.writeFile('generated/data.bin', 'candidate bytes');
    await world.writeFile('.env.local', 'API_KEY=must-not-be-read'); await world.writeFile('scratch.bin', 'scratch-content');
    const staged = await resources.proposePath(task.id, { path: 'generated', name: 'Generated data',
      target: { kind: 'path', path: 'data/generated' }, access: 'read', publish: 'discard' });

    const inventory = await resources.ignoredInventory(task.id);
    expect(inventory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env.local', likelySecret: true }),
      expect.objectContaining({ path: 'scratch.bin', bytes: Buffer.byteLength('scratch-content') }),
    ]));
    expect(inventory.entries.some((entry) => entry.path.startsWith('generated'))).toBe(false);
    expect(JSON.stringify(inventory)).not.toContain('must-not-be-read');
    expect(JSON.stringify(inventory)).not.toContain('scratch-content');

    await resources.discardCandidate(task.id, staged.candidate.id, 'user:reviewer');
    expect((await store.getResourceCandidate(staged.candidate.id))).toMatchObject({ state: 'discarded' });
    expect((await store.getResourceAttachment(staged.attachment.id))).toBeUndefined();
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);

    const handle = itemHandle('vi_generated', 'secret');
    (await broker.registerHandle(handle, 'generated-api-key', INSTALLATION_SCOPE));
    const credential = await resources.proposeCredential(task.id, {
      itemId: 'vi_generated', field: 'secret', credentialHandle: handle, name: 'Generated API key',
      driver: 'secret@1', target: { kind: 'environment', name: 'GENERATED_API_KEY' }, access: 'read',
    });
    await resources.discardCandidate(task.id, credential.candidate.id, 'user:reviewer');
    expect(broker.hasHandle(handle)).toBe(true);
    await world.destroy(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adopts an agent-created vault item as a secret attachment without revealing it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-vault-candidate-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n'); await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Credentials', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Create key', workflow: 'software-dev',
      workflowVersion: '1.19.0', params: { prompt: 'create it' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    // The item the agent stored, as KarmaxApi finds it before proposing it.
    const item = await new VaultItems(store, broker, dir, project.organizationId).save({ type: 'api-key', label: 'Agent key',
      secrets: { secret: 'sk-agent-created' }, provenance: { source: 'task', taskId: task.id } });
    const handle = itemHandle(item.id, 'secret');
    const proposed = await resources.proposeCredential(task.id, {
      itemId: item.id, field: 'secret', credentialHandle: handle, name: 'Agent API key', driver: 'secret@1',
      target: { kind: 'environment', name: 'AGENT_API_KEY' }, access: 'read',
    });
    expect(JSON.stringify(proposed)).not.toContain('sk-agent-created');
    const adopted = await resources.adoptCandidate(task.id, proposed.candidate.id, 'user:reviewer');
    expect(adopted.attachment.source).toMatchObject({ adoptedFromCandidate: proposed.candidate.id });
    expect(adopted.attachment.source.candidate).toBeUndefined();
    const consumer = (await store.createTask({ projectId: project.id, title: 'Consume', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'consume' } }));
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    const wrapped = (await resources.withEnvironment(consumerWorld));
    expect((await wrapped.exec('bash', ['-lc', 'printf %s "$AGENT_API_KEY"'])).stdout).toBe('sk-agent-created');
    expect(JSON.stringify(consumerWorld.handle)).not.toContain('sk-agent-created');
    await resources.release(consumerWorld.handle); await consumerWorld.destroy(); await world.destroy();
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows resource proposals only for workflow versions with the Review gate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-version-gate-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n'); await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Version gate', { repos: [repo] }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const tokens = new TokenAuthority();
    const api = new KarmaxApi({ store, client: { workflow: {} } as any, taskQueue: 'karmax',
      tokens, worlds, resources, broker });
    const activeWorlds = [];
    const cases = [
      { workflow: 'software-dev', version: '1.18.0', supported: false },
      { workflow: 'goal', version: '1.18.0', supported: false },
      { workflow: 'software-dev', version: '1.19.0', supported: true },
      { workflow: 'goal', version: '1.19.0', supported: true },
    ] as const;
    try {
      for (const [index, value] of cases.entries()) {
        const task = (await store.createTask({ projectId: project.id, title: `${value.workflow} ${value.version}`,
          workflow: value.workflow, workflowVersion: value.version, params: { prompt: 'create data' } }));
        const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
        world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
        activeWorlds.push(world);
        await world.writeFile('generated.bin', `${value.workflow}-${value.version}`);
        const token = (await tokens.mint({ taskId: task.id, profileId: 'developer', role: 'do',
          principal: 'user:creator', projectId: project.id, organizationId: project.organizationId,
          ceiling: ['task:review:write'], grantorCaps: ['task:review:write'],
          worldGeneration: world.handle.generation ?? 1 })).token;
        const proposal = api.proposeProjectResource(token, {
          source: { kind: 'path', path: 'generated.bin' }, name: 'Generated data', driver: 'volume@1',
          target: { kind: 'path', path: `data/generated-${index}.bin` }, access: 'read',
        });
        if (!value.supported) {
          await expect(proposal).rejects.toThrow('workflow version does not support');
        } else {
          const proposed = await proposal;
          expect(proposed.candidate).toMatchObject({ taskId: task.id, state: 'pending' });
          await resources.discardCandidate(task.id, proposed.candidate.id, 'system:test-cleanup');
        }
      }
    } finally {
      for (const world of activeWorlds.reverse()) await world.destroy();
      (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only the calling task’s vault items and current generation through the platform proposal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-proposal-auth-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n'); await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const store = (await Store.create(':memory:')); const project = (await store.createProject('Authorization', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Create key', workflow: 'software-dev',
      workflowVersion: '1.19.0', params: { prompt: 'create it' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault'))); const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    const vault = new VaultItems(store, broker, path.join(dir, 'state'), project.organizationId!);
    const own = (await vault.save({ type: 'api-key', label: 'Own', secrets: { secret: 'own-secret' },
      provenance: { source: `task:${task.id}`, taskId: task.id } }));
    const foreign = (await vault.save({ type: 'api-key', label: 'Foreign', secrets: { secret: 'foreign-secret' },
      provenance: { source: 'manual' } }));
    const tokens = new TokenAuthority();
    const mint = async (generation: number) => (await tokens.mint({ taskId: task.id, profileId: 'developer', role: 'do',
      principal: 'user:creator', projectId: project.id, organizationId: project.organizationId,
      ceiling: ['task:review:write'], grantorCaps: ['task:review:write'], worldGeneration: generation })).token;
    const signals: Array<{ taskId: string; signal: string }> = [];
    const client = { workflow: { getHandle: (taskId: string) => ({
      signal: async (signal: string) => { signals.push({ taskId, signal }); },
    }) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'karmax', tokens, worlds, resources, broker });
    const proposal = (token: string, itemId: string, name = 'API key') => api.proposeProjectResource(token, {
      source: { kind: 'vault-item', itemId }, name, driver: 'secret@1',
      target: { kind: 'environment', name: 'API_KEY' }, access: 'read',
    });
    await expect(proposal((await mint((world.handle.generation ?? 1) + 1)), own.id)).rejects.toBeInstanceOf(CapabilityError);
    await expect(proposal((await mint(world.handle.generation ?? 1)), foreign.id)).rejects.toBeInstanceOf(CapabilityError);
    const ownProposal = await proposal((await mint(world.handle.generation ?? 1)), own.id);
    expect(ownProposal).toMatchObject({
      candidate: { taskId: task.id, vaultItemId: own.id, state: 'pending' },
    });
    const agentReviewer = (await tokens.mint({ taskId: task.id, profileId: 'maintainer', role: 'do',
      principal: 'user:reviewer', projectId: project.id, organizationId: project.organizationId,
      ceiling: ['task:review:execute'], grantorCaps: ['task:review:execute'] })).token;
    await expect(api.adoptProjectResource((await mint(world.handle.generation ?? 1)), task.id, ownProposal.candidate.id))
      .rejects.toBeInstanceOf(CapabilityError);
    await api.adoptProjectResource(agentReviewer, task.id, ownProposal.candidate.id);
    const reviewer = (await tokens.mintPrincipal('user:reviewer', ['task:review:execute'], project.id,
      undefined, project.organizationId)).token;
    await api.adoptProjectResource(reviewer, task.id, ownProposal.candidate.id);
    expect(signals).toContainEqual({ taskId: task.id, signal: 'resourceResolved' });
    const discardable = await proposal((await mint(world.handle.generation ?? 1)), own.id, 'Discardable');
    await expect(api.discardProjectResource((await mint(world.handle.generation ?? 1)), task.id, discardable.candidate.id))
      .rejects.toBeInstanceOf(CapabilityError);
    await api.discardProjectResource(agentReviewer, task.id, discardable.candidate.id);
    expect((await store.listResourceCandidates(task.id)).find((candidate) => candidate.id === discardable.candidate.id)?.state).toBe('discarded');

    await expect(api.proposeProjectResource((await mint(world.handle.generation ?? 1)), {
      source: { kind: 'vault-item', itemId: own.id }, name: 'Writable database', driver: 'database@1',
      target: { kind: 'service', name: 'DATABASE_URL' }, access: 'write',
    })).rejects.toBeInstanceOf(CapabilityError);
    const sharedWrite = (await tokens.mint({ taskId: task.id, profileId: 'maintainer', role: 'do',
      principal: 'user:creator', projectId: project.id, organizationId: project.organizationId,
      ceiling: ['task:review:write', 'project:resource:shared-write'],
      grantorCaps: ['task:review:write', 'project:resource:shared-write'],
      worldGeneration: world.handle.generation ?? 1 })).token;
    await expect(api.proposeProjectResource(sharedWrite, {
      source: { kind: 'vault-item', itemId: own.id }, name: 'Writable database', driver: 'database@1',
      target: { kind: 'service', name: 'DATABASE_URL' }, access: 'write',
    })).resolves.toMatchObject({ attachment: { access: 'write', isolation: 'shared' } });
    await world.destroy(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });
});

function allFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(value) : [value];
  });
}

it('forwards addCheckout through environment wrappers (WD-13)', async () => {
  const service = new ProjectResourceService({} as any, {} as any, {} as any, {} as any);
  service.environmentFor = async () => ({ TOKEN: 'secret' });
  const handle = { id: 'world', root: '/w' } as any;
  let received: unknown;
  const world = { handle, addCheckout: async (spec: unknown) => { received = spec; return handle; } } as any;
  const wrapped = await service.withEnvironment(world);
  expect(wrapped.addCheckout).toBeTypeOf('function');
  expect(await wrapped.addCheckout!({ name: 'branch' })).toBe(handle);
  expect(received).toEqual({ name: 'branch' });
  expect((await service.withEnvironment({ handle } as any)).addCheckout).toBeUndefined();
});

it('LT-20: backs off publish-slot queries while preserving immediate grant and release', async () => {
  vi.useFakeTimers();
  let token: string | undefined;
  let available = false;
  const query = vi.fn(async () => ({ current: available ? { token } : undefined }));
  const signal = vi.fn(async () => undefined);
  const client = { workflow: {
    signalWithStart: vi.fn(async (_name, options) => { token = options.signalArgs[0].token; }),
    getHandle: () => ({ query, signal }),
  } };
  const service = new ProjectResourceService({} as any, {} as any, {} as any, {} as any,
    { client: client as any, taskQueue: 'test' });
  const action = vi.fn(async () => 'published');
  const publication = (service as any).serializeDurably('resource', 'task', action);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query.mock.calls.length).toBeLessThanOrEqual(20);
    expect(action).not.toHaveBeenCalled();
  } finally {
    available = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await publication).toBe('published');
    expect(action).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith('releaseResourcePublish', { token });
    vi.useRealTimers();
  }
});

it('rejects oversized resource JSON before creating or importing a resource (GW-2)', async () => {
  const { stubGateway } = await import('./helpers/stub-gateway.js');
  const h = await stubGateway({ resources: {} as any });
  try {
    const project = await h.store.createProject('Bounded imports');
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    const resource = await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Existing', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'read',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' });
    for (const suffix of ['', `/${resource.id}/import`]) {
      const response = await fetch(`${h.base}/api/projects/${project.id}/resources${suffix}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ path: 'large', data: 'x'.repeat(2 * 1024 * 1024) }] }),
      });
      expect(response.status, await response.text()).toBe(413);
    }
    expect(await h.store.listResourceAttachments(project.id)).toHaveLength(1);
  } finally { await h.close(); }
});
