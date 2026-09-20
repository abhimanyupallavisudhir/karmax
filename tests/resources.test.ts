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
import { itemHandle, VaultItems } from '../src/autonomy/vault-items.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CapabilityError, KarmaxApi } from '../src/platform/api.js';
import { worldWorkingRelativePath } from '../src/world/types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('project resources', () => {
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
    const secretHandle = `resource:test:token`;
    broker.registerHandle(secretHandle, 'secret-token');
    (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Training token', driver: 'secret@1', target: { kind: 'environment', name: 'TRAINING_TOKEN' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [secretHandle], publish: 'discard' }));

    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = resources.registerServiceEnvironment(world.handle,
      { DATABASE_URL: 'postgres://private-per-world-endpoint' });
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
    const serviceHandle = Object.values(world.handle.meta?.serviceEnvironmentHandles as Record<string, string>)[0]!;
    expect(broker.hasHandle(serviceHandle)).toBe(true);

    const tunedBytes = Buffer.from('fine-tuned-model');
    await world.writeFileBuffer!('resources/model/model.bin', tunedBytes);
    const summary = await resources.summarize(task.id, volume.id);
    expect(summary).toMatchObject({ added: 0, modified: 1, deleted: 0 });
    const promoted = await resources.promote(task.id, volume.id);
    expect(promoted.revision.parentRevisionId).toBe(initial.id);
    expect((await store.getResourceAttachment(volume.id))?.currentRevisionId).toBe(promoted.revision.id);

    const consumer = (await store.createTask({ projectId: project.id, title: 'Use model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'evaluate' } }));
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    consumerWorld.handle = (await store.registerWorld(consumerWorld.handle, project.id)) as typeof consumerWorld.handle;
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
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
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
    await resources.deleteAttachment(attachment.id);
    expect(allFiles(path.join(dir, 'objects'))).toHaveLength(0);
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
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
    expect(proposed.revision).toMatchObject({ bytes: Buffer.byteLength('agent-created-model'), files: 1,
      createdByTaskId: task.id });

    await world.destroy();
    const adopted = await resources.adoptCandidate(task.id, proposed.candidate.id, 'user:reviewer');
    expect(adopted.attachment.enabled).toBe(true);
    expect(adopted.candidate).toMatchObject({ state: 'adopted', resolvedBy: 'user:reviewer' });
    const consumer = (await store.createTask({ projectId: project.id, title: 'Use model', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'use it' } }));
    const consumerWorld = await worlds.create('worktree', { taskId: consumer.id, repo, base: 'main' });
    consumerWorld.handle = await resources.materialize(project.id, consumer.id, consumerWorld, 1);
    expect(await consumerWorld.readFileBuffer('models/downloaded/model.bin')).toEqual(Buffer.from('agent-created-model'));
    await resources.release(consumerWorld.handle); await consumerWorld.destroy();
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
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
    broker.registerHandle(handle, 'generated-api-key');
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
    const handle = itemHandle('vi_agent_key', 'secret'); broker.registerHandle(handle, 'sk-agent-created');
    const proposed = await resources.proposeCredential(task.id, {
      itemId: 'vi_agent_key', field: 'secret', credentialHandle: handle, name: 'Agent API key', driver: 'secret@1',
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
