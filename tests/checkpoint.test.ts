import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { provisionGitRepos } from '../src/world/provision-git.js';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { CHECKPOINT_LIMITS } from '../src/world/checkpoint-chunks.js';
import type { WorldCheckpoint } from '../src/domain/types.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { ProjectEnvironment } from '../src/store/project-environment.js';
import { ProjectServices } from '../src/store/project-services.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { RunnerPoolService } from '../src/world/runners.js';

describe('portable world checkpoints', () => {
  it('reuses a clean checkpoint only while its generation, repositories and runtime remain unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-clean-checkpoint-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']);
    const store = await Store.create(':memory:');
    const project = await store.createProject('Clean', { repos: [repo] });
    const task = await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const put = vi.spyOn(objects, 'put');
    let revisionId = 'original';
    const resources = { checkpoint: async () => [{ attachmentId: 'data', revisionId }],
      ignoredInventory: async () => undefined, scrubSecrets: vi.fn(async () => {}) };
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources as any);
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
    const capture = () => checkpoints.checkpoint(world.handle, { reuseClean: true });
    try {
      const initial = await capture();
      expect((await capture()).id).toBe(initial.id);
      expect(put).toHaveBeenCalledTimes(1);
      expect(resources.scrubSecrets).toHaveBeenCalledTimes(2);
      revisionId = 'changed-resource';
      const changedResource = await capture();
      expect(changedResource.id).not.toBe(initial.id);
      expect((await capture()).id).toBe(changedResource.id);
      await world.writeFile('new.txt', 'uncommitted');
      const dirty = await capture();
      expect(dirty.id).not.toBe(initial.id);
      await world.exec('rm', ['new.txt']);
      const cleaned = await capture();
      expect(cleaned.id).not.toBe(dirty.id);
      expect((await capture()).id).toBe(cleaned.id);
      await world.exec('git', ['commit', '--allow-empty', '-qm', 'new head']);
      const committed = await capture();
      expect(committed.id).not.toBe(cleaned.id);
      await new ProjectEnvironment(store).setSpec(project.id, { boot: ['echo new runtime'] });
      const changedRuntime = await capture();
      expect(changedRuntime.id).not.toBe(committed.id);
      expect((await capture()).id).toBe(changedRuntime.id);
      world.handle = await store.registerWorld({ ...(await store.currentWorld(task.id))!, generation: 2 }, project.id) as typeof world.handle;
      expect((await capture()).id).not.toBe(changedRuntime.id);
    } finally { await world.destroy(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('restores an unpublished base checkpoint through cloud provisioning after the base advances', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-unpublished-checkpoint-'));
    const source = path.join(dir, 'source'); fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']); await ensureIdentity(source);
    await gitOrThrow(source, ['commit', '--allow-empty', '-qm', 'base']);
    const baseSha = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
    const remote = path.join(dir, 'remote.git');
    await gitOrThrow(dir, ['clone', '-q', '--bare', source, remote]);
    const ssh = 'git@example:remote.git';
    const store = await Store.create(':memory:');
    const project = await store.createProject('Cloud recovery', { repos: [ssh], defaultBase: 'main' });
    const task = await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
    const worktrees = new WorktreeProvider(path.join(dir, 'unused'));
    const worlds = new WorldRegistry();
    const open = async (handle: any) => {
      const world = await worktrees.open(handle);
      world.destroy = async () => fs.rmSync(handle.root, { recursive: true, force: true });
      return world;
    };
    const target = {
      async run(command: string) {
        try {
          const { stdout, stderr } = await promisify(execFile)('bash', ['-c', command], { env: { ...process.env,
            GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${dir}/.insteadOf`, GIT_CONFIG_VALUE_0: 'git@example:' } });
          return { stdout, stderr, code: 0 };
        } catch (error: any) { return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: 1 }; }
      },
      async writeFile(file: string, bytes: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); },
    };
    worlds.register({ kind: 'checkpoint-cloud', parkable: true, async create(spec) {
      const root = path.join(dir, `cloud-${spec.generation ?? 1}`);
      const provisioned = await provisionGitRepos(target, spec, { root, home: dir, sshUrlError: 'ssh only', copyGlobsWarning: '' });
      return open({ id: task.id, kind: 'checkpoint-cloud', root, base: spec.base,
        branch: provisioned.repos[0]!.branch, repos: provisioned.repos });
    }, open });
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
      new CredentialBroker(new Vault(path.join(dir, 'vault'))));
    try {
      const world = await worlds.create('checkpoint-cloud', { taskId: task.id, repos: [ssh], base: 'main' });
      world.handle.meta = { projectId: project.id };
      world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
      await world.writeFile('draft.txt', 'uncommitted work');
      const checkpoint = await checkpoints.checkpoint(world.handle);
      expect((await git(remote, ['show-ref', '--verify', `refs/heads/${world.handle.branch}`])).code).not.toBe(0);
      await gitOrThrow(source, ['commit', '--allow-empty', '-qm', 'new base']);
      await gitOrThrow(source, ['push', remote, 'main']);
      await world.destroy();
      const handle = await checkpoints.restore(checkpoint.id, 'checkpoint-cloud');
      const restored = await worlds.open(handle);
      expect((await restored.exec('git', ['rev-parse', 'HEAD'])).stdout.trim()).toBe(baseSha);
      expect((await restored.exec('git', ['branch', '--show-current'])).stdout.trim()).toBe(world.handle.branch);
      expect(await restored.readFile('draft.txt')).toBe('uncommitted work');
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('encrypts a dirty binary delta, restores it into a new generation, and fences the stale generation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-checkpoint-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored-data/\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Portable', { repos: [repo], defaultBase: 'main', worldProvider: 'worktree' }));
    const task = (await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id, ephemeralPaths: ['private.bin'] };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    const stale = { ...world.handle };
    await world.writeFileBuffer!('binary.dat', Buffer.from([0, 1, 2, 255]));
    await world.writeFileBuffer!('ignored-data/model.bin', Buffer.alloc(321, 9));
    await world.writeFile('private.bin', 'injected credential material');
    await world.writeFile('tracked.txt', 'after\n');
    expect((await world.exec('git', ['mv', 'tracked.txt', 'renamed.txt'])).code).toBe(0);

    const checkpoint = await checkpoints.checkpoint(world.handle);
    expect(checkpoint.filesystemDelta).toMatchObject({ format: 2 });
    const encrypted = await objects.get(checkpoint.filesystemDelta!.objectKey);
    expect(encrypted.subarray(0, 4).toString()).toBe('KRS1');
    for (const stored of storedObjects(path.join(dir, 'objects'))) expect(stored.toString('latin1')).not.toContain('after');
    expect(checkpoint.ignored?.entries).toContainEqual(expect.objectContaining({ path: 'ignored-data' }));
    expect(checkpoint.ignored!.entries[0]!.bytes).toBeGreaterThanOrEqual(321);
    await world.destroy();

    const restoredHandle = await checkpoints.restore(checkpoint.id, 'worktree');
    expect(restoredHandle.generation).toBe(2);
    const restored = await worlds.open(restoredHandle);
    await expect(restored.readFile('tracked.txt')).rejects.toThrow();
    expect(await restored.readFile('renamed.txt')).toBe('after\n');
    expect([...await restored.readFileBuffer('binary.dat')]).toEqual([0, 1, 2, 255]);
    await expect(restored.readFile('private.bin')).rejects.toThrow();
    await expect((async () => (await store.assertCurrentWorld(stale)))()).rejects.toThrow(/stale world generation/);

    await restored.destroy();
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-provisions a vanished remote sandbox from its checkpoint and carries on (openWorld recovery)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recover-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Recover', { repos: [repo], defaultBase: 'main', worldProvider: 'sandbox-test' }));
    const task = (await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } }));

    // A mock REMOTE provider backed by real worktrees. `vanished` flips on to
    // simulate the provider losing the gen-1 sandbox: open() throws and probe()
    // reports 'missing' for it, while a restored (gen-2) world opens normally.
    const worlds = new WorldRegistry();
    const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
    let vanished = false;
    const gone = (h: { generation?: number }) => vanished && (h.generation ?? 1) < 2;
    worlds.register({
      kind: 'sandbox-test', parkable: true,
      capabilities: { remote: true, pty: false, snapshots: true, ports: false, networkPolicy: false },
      async create(spec) { const w = await worktrees.create(spec); w.handle.kind = 'sandbox-test'; return w; },
      async open(handle) {
        if (gone(handle)) throw new Error('sandbox vanished: 404 not found');
        const w = await worktrees.open(handle); w.handle.kind = 'sandbox-test'; return w;
      },
      async probe(handle) { return gone(handle) ? 'missing' as const : 'ready' as const; },
    });

    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker);

    const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.writeFile('tracked.txt', 'edited in the sandbox\n'); // dirty work, captured by the checkpoint
    await checkpoints.checkpoint(world.handle); // attaches checkpointId onto the current world
    const vanishedHandle = { ...world.handle };
    await world.destroy();
    vanished = true; // the provider now reports this generation as gone

    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), checkpoints });

    // commitWork -> openWorld hits the lost sandbox; recovery restores a fresh
    // generation from the checkpoint and the activity completes as if nothing broke.
    const result = await core.commitWork(vanishedHandle, 'after recovery');
    expect(result.committed).toBe(true);
    // A fresh generation was provisioned from the checkpoint...
    expect(((await store.currentWorld(task.id)) as { generation?: number } | undefined)?.generation).toBe(2);
    // ...and it carries the sandbox's edited files (same work continues).
    const restored = await worlds.open((await store.currentWorld(task.id)) as any);
    expect(await restored.readFile('tracked.txt')).toBe('edited in the sandbox\n');
    await restored.destroy();
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores legacy checkpoints containing a companion checkout that is not project-enrolled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-checkpoint-companion-'));
    const makeRepo = async (name: string, branch = 'main') => {
      const repo = path.join(dir, name);
      fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-q', '-b', branch]);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), `${name}\n`);
      await git(repo, ['add', '-A']);
      await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
      return repo;
    };
    const development = await makeRepo('development');
    const wiki = await makeRepo('wiki', 'project-wiki');

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Companion restore', { repos: [development], defaultBase: 'main' }));
    const task = (await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
    const ledger = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Ledger', driver: 'object-tree@1', target: { kind: 'path', path: 'runs/spend.sqlite' },
      access: 'write', isolation: 'fork', source: { shape: 'file' }, credentialHandles: [], publish: 'review' }));
    const published = await resources.importFiles(ledger.id, [{ path: 'spend.sqlite', data: Buffer.from('original') }]);

    const world = await worlds.create('worktree', { taskId: task.id, repos: [development, wiki], base: 'main',
      repositoryBranches: { [wiki]: { base: 'project-wiki', target: 'project-wiki' } } });
    world.handle.repos![1]!.role = 'project-wiki';
    world.handle.meta = { projectId: project.id };
    // Reproduce the old ordering: resources at the boundary, followed by an
    // agent cwd inside the development checkout. Capture must honor the pinned
    // location, then restore into the new generation's selected cwd.
    world.handle = await resources.materialize(project.id, task.id, world);
    await world.writeFile('runs/spend.sqlite', 'historical ledger');
    world.handle.workdir = world.handle.repos![0]!.root;
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.writeFile('wiki/unpublished.md', 'portable wiki edit\n');
    const checkpoint = await checkpoints.checkpoint(world.handle);
    expect(checkpoint.repos[1]).toMatchObject({ source: wiki, base: 'project-wiki',
      target: 'project-wiki', role: 'project-wiki' });

    // Re-save the manifest without fields introduced by the source-pinning fix,
    // reproducing Task 132's already-durable checkpoint. The project's one-item
    // repo config cannot resolve the companion by array position; recovery must
    // use the persisted generation's checkout identity.
    const legacy = { ...checkpoint, id: 'checkpoint-legacy-companion', repos: checkpoint.repos.map((entry) => {
      const { source: _source, base: _base, target: _target, targetPinned: _targetPinned, role: _role, ...old } = entry;
      return old;
    }) };
    (await store.saveWorldCheckpoint(legacy));
    await world.destroy();

    const restoredHandle = await checkpoints.restore(legacy.id, 'worktree');
    const restoredRepos = restoredHandle.repos!;
    expect(restoredRepos.map((repo) => repo.role)).toEqual([undefined, 'project-wiki']);
    expect(restoredRepos[1]!.base).toBe('project-wiki');
    expect(restoredHandle.workdir).toBe(restoredRepos[0]!.root);
    const restored = await worlds.open(restoredHandle);
    expect(await restored.readFile('wiki/unpublished.md')).toBe('portable wiki edit\n');
    expect(await restored.readFile('development/runs/spend.sqlite')).toBe('historical ledger');
    expect(fs.existsSync(path.join(restoredHandle.root, 'runs/spend.sqlite'))).toBe(false);
    // The edit made before the park is still this task's change to publish:
    // measured from the published version, not from the park's capture.
    expect(await resources.summarize(task.id, ledger.id)).toMatchObject({ baseRevisionId: published.id, added: 0, modified: 1, deleted: 0 });

    await restored.destroy();
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores a remote sandbox under a runner lease, so it is budgeted, attributed and releasable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-lease-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Restore', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { repos: [repo], defaultBase: 'main', worldProvider: 'sandbox-test' },
      organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } }));

    const worlds = new WorldRegistry();
    const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
    const createSpecs: Array<Parameters<WorktreeProvider['create']>[0]> = [];
    worlds.register({
      kind: 'sandbox-test', parkable: true,
      capabilities: { remote: true, pty: false, snapshots: true, ports: false, networkPolicy: false },
      async create(spec: Parameters<WorktreeProvider['create']>[0]) {
        createSpecs.push(spec);
        const w = await worktrees.create(spec);
        w.handle.kind = 'sandbox-test';
        w.handle.provider = 'sandbox-test';
        return w;
      },
      async open(handle: Parameters<WorktreeProvider['open']>[0]) {
        const w = await worktrees.open(handle);
        w.handle.kind = 'sandbox-test';
        return w;
      },
    } as any);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const runners = new RunnerPoolService(store);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, undefined, runners);

    const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
    const originalLease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'sandbox-test' });
    world.handle.meta = { projectId: project.id, worldLeaseId: originalLease.leaseId };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.writeFile('tracked.txt', 'edited in the sandbox\n');
    const checkpoint = await checkpoints.checkpoint(world.handle);
    await world.destroy();

    // Restoring re-provisions a REAL billable sandbox, so it must hold a runner
    // lease exactly like createWorld does — otherwise the sandbox is invisible to
    // the budget and destroyWorld finds no lease to hand its capacity back.
    const restored = await checkpoints.restore(checkpoint.id, 'sandbox-test');
    expect(createSpecs[1]).toMatchObject({ organizationId: organization.id, generation: 2 });
    const leaseId = restored.meta?.worldLeaseId as string | undefined;
    expect(typeof leaseId).toBe('string');
    expect((await store.worldLease(leaseId!))?.state).toBe('active');
    expect((await store.activeWorldLeaseCount(task.id))).toBe(1);

    // …and releasing it produces the `world.active` usage row cost attribution reads.
    (await runners.release(leaseId!, 'sandbox-test'));
    expect((await store.worldLease(leaseId!))?.state).toBe('released');
    expect((await store.usageSummary(organization.id)).byKind['world.active']).toBeGreaterThanOrEqual(0);
    expect(Object.keys((await store.usageSummary(organization.id)).byKind)).toContain('world.active');
    await (await worlds.open(restored)).destroy();

    // The lease is also the budget gate: an exhausted organization budget must
    // stop a silent re-provision instead of billing past it.
    (await store.setOrganizationExecutionPolicy(organization.id, { monthlyBudgetMicros: 0 }));
    await expect(checkpoints.restore(checkpoint.id, 'sandbox-test')).rejects.toThrow(/budget/);

    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aborts a queued runner lease when the restoring activity is cancelled, instead of stranding it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-cancel-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Saturated', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { repos: [repo], defaultBase: 'main', worldProvider: 'sandbox-test' },
      organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } }));
    // A pool with room for exactly one world, so the restore's lease must queue.
    const pool = (await store.createRunnerPool({ id: `${organization.id}:tiny`, organizationId: organization.id,
      name: 'Tiny', provider: 'sandbox-test', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 40, memoryMb: 81_920, gpu: 0 }, enabled: true }));
    (await store.setProjectExecutionPolicy(project.id, { runnerPoolId: pool.id }));

    const worlds = new WorldRegistry();
    const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
    worlds.register({
      kind: 'sandbox-test', parkable: true,
      capabilities: { remote: true, pty: false, snapshots: true, ports: false, networkPolicy: false },
      async create(spec: Parameters<WorktreeProvider['create']>[0]) {
        const w = await worktrees.create(spec);
        w.handle.kind = 'sandbox-test';
        w.handle.provider = 'sandbox-test';
        return w;
      },
      async open(handle: Parameters<WorktreeProvider['open']>[0]) {
        const w = await worktrees.open(handle);
        w.handle.kind = 'sandbox-test';
        return w;
      },
    } as any);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const runners = new RunnerPoolService(store);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, undefined, runners);

    const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await world.writeFile('tracked.txt', 'edited in the sandbox\n');
    const checkpoint = await checkpoints.checkpoint(world.handle);
    await world.destroy();

    // Saturate the pool: the restore below cannot be granted until this is released.
    const other = (await store.createTask({ projectId: project.id, title: 'Other', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'other' } as any }));
    const occupant = await runners.acquire({ project: (await store.getProject(project.id))!, taskId: other.id,
      worldId: other.id, provider: 'sandbox-test' });
    expect((await store.worldLease(occupant.leaseId))?.state).toBe('active');

    // `restore` is reached from an activity, and `RunnerPoolService.acquire` polls
    // a ~1s loop that only gives the queued lease row back when the signal aborts.
    // Without the activity's cancellation signal and heartbeat threaded in, the
    // restore blocks past the heartbeat timeout and the killed activity leaves a
    // `queued` lease row nothing will ever release — pool capacity gone for good.
    const controller = new AbortController();
    const beats: string[] = [];
    const restore = checkpoints.restore(checkpoint.id, 'sandbox-test',
      { signal: controller.signal, heartbeat: () => beats.push('beat') });
    const settled = restore.then(() => 'resolved', (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`);
    const timer = setTimeout(() => controller.abort(new Error('activity cancelled')), 500);
    try {
      const outcome = await Promise.race([settled,
        new Promise((resolve) => setTimeout(() => resolve('still-blocked-after-abort'), 6000))]);
      expect(outcome).toMatch(/^rejected/);
      expect(beats.length).toBeGreaterThan(0); // it heartbeats while it waits
      // Nothing left holding pool capacity except the occupant we created.
      expect((await store.listWorldLeases(pool.id)).map((lease: any) => lease.id)).toEqual([occupant.leaseId]);
    } finally {
      clearTimeout(timer);
      // Free the pool so any still-spinning acquire finishes rather than leaking
      // a poll loop into the rest of the run.
      (await runners.release(occupant.leaseId, 'sandbox-test'));
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5000))]);
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
printf '%s\\n' "$*" >> '${dockerLog}'
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
      const store = (await Store.create(':memory:'));
      const project = (await store.createProject('Runtime restore', { repos: [repo], defaultBase: 'main' }));
      const task = (await store.createTask({ projectId: project.id, title: 'Restore', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'restore' } }));
      const environments = new ProjectEnvironment(store);
      const pinned = (await environments.setSpec(project.id, { boot: ['printf pinned-runtime > runtime-marker'] }));
      (await new ProjectServices(store).save(project.id, { name: 'database', kind: 'per-world',
        image: 'postgres:16', containerPort: 5432, urlEnv: 'DATABASE_URL',
        urlTemplate: 'postgres://app@{host}:{port}/app' }));

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
      world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
      const checkpoint = await checkpoints.checkpoint(world.handle);
      expect(checkpoint.environment).toEqual(pinned);
      expect(checkpoint.services?.[0]?.image).toBe('postgres:16');
      await world.destroy();

      // Later settings edits must not rewrite the topology of this checkpoint.
      (await environments.setSpec(project.id, { boot: ['printf changed-runtime > runtime-marker'] }));
      (await new ProjectServices(store).save(project.id, { name: 'database', kind: 'per-world',
        image: 'redis:7', containerPort: 6379, urlEnv: 'REDIS_URL', urlTemplate: 'redis://{host}:{port}' }));
      const restoredHandle = await checkpoints.restore(checkpoint.id, 'sandbox-test');
      const restored = await worlds.open(restoredHandle);
      expect(await restored.readFile('runtime-marker')).toBe('pinned-runtime');
      const calls = fs.readFileSync(dockerLog, 'utf8');
      expect(calls).toContain('postgres:16');
      expect(calls).not.toContain('redis:7');
      expect(JSON.stringify(restoredHandle)).not.toContain('postgres://app@172.17.0.8');
      const wrapped = (await resources.withEnvironment(restored));
      expect((await wrapped.exec('bash', ['-lc', 'printf %s "$DATABASE_URL"'])).stdout)
        .toBe('postgres://app@172.17.0.8:5432/app');
      const serviceHandle = Object.values(restoredHandle.meta?.serviceEnvironmentHandles as Record<string, string>)[0]!;
      expect(broker.hasHandle(serviceHandle)).toBe(true);
      await resources.release(restoredHandle);
      expect(broker.hasHandle(serviceHandle)).toBe(false);
      await restored.destroy();
      (await store.close());
    } finally {
      process.env.PATH = oldPath;
      if (oldLog === undefined) delete process.env.KARMAX_TEST_DOCKER_LOG;
      else process.env.KARMAX_TEST_DOCKER_LOG = oldLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('refuses files over the checkpoint file limit before reading them, and tells the agent (WD-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-limit-'));
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const project = await store.createProject('Bounded checkpoint');
  const task = await store.createTask({ projectId: project.id, title: 'Large file', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  world.handle = await store.registerWorld(world.handle, project.id) as any;
  // Sparse: the size is real to every reader, but no disk is used.
  const file = path.join(world.handle.root, 'large.bin');
  fs.writeFileSync(file, ''); fs.truncateSync(file, CHECKPOINT_LIMITS.fileBytes + 1);
  const read = vi.spyOn(world, 'readFileBuffer');
  const exec = vi.spyOn(world, 'exec');
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const service = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
    new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  try {
    await expect(service.checkpoint(world.handle)).rejects.toThrow('checkpoint file limit');
    expect(read).not.toHaveBeenCalled();
    expect(exec.mock.calls.filter(([command, args]) => command === 'node' && String(args[1]).includes('readSync'))).toHaveLength(0);
    const notice = await service.takeNotice(task.id);
    expect(notice).toContain('a file exceeds the 16 GiB checkpoint file limit');
    expect(notice).toContain('- large.bin (16 GiB)');
    expect(await service.takeNotice(task.id)).toBeUndefined();
  } finally { vi.restoreAllMocks(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('restores distinct branches of the same repository (WD-11)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-checkouts-'));
  const store = await Store.create(':memory:');
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'file'), 'base');
  fs.writeFileSync(path.join(repo, '-option'), 'delete me');
  await gitOrThrow(repo, ['add', '.']); await gitOrThrow(repo, ['commit', '-qm', 'init']);
  const project = await store.createProject('Checkout checkpoint', { repos: [repo] });
  const task = await store.createTask({ projectId: project.id, title: 'Branches', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main', layout: 'nested', gitIdentity: { name: 'Original', email: 'original@test' } });
  await world.addCheckout!({ name: 'extra', base: 'main', branch: 'extra-branch' });
  world.handle = await store.registerWorld(world.handle, project.id) as any;
  await world.writeFile('extra/file', 'extra edit');
  fs.unlinkSync(path.join(world.handle.root, 'extra', '-option'));
  const service = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
    new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  try {
    const checkpoint = await service.checkpoint(world.handle);
    await world.destroy();
    const restored = await service.restore(checkpoint.id, 'worktree');
    expect(restored.repos?.map(repo => [repo.name, repo.branch])).toEqual(world.handle.repos?.map(repo => [repo.name, repo.branch]));
    const opened = await worlds.open(restored);
    expect(await opened.readFile('extra/file')).toBe('extra edit');
    expect((await opened.exec('git', ['config', 'user.email'], { cwd: restored.repos![0]!.root })).stdout.trim()).toBe('original@test');
    await expect(opened.readFile('extra/-option')).rejects.toThrow();
    const fork = await worlds.create('worktree', { taskId: 'independent-fork', repos: [repo], base: 'main', layout: 'nested' });
    await service.applyFork(checkpoint.id, fork, project.id);
    expect(await fork.readFile('extra/file')).toBe('extra edit');
    expect(fork.handle.repos![1]!.branch).not.toBe('extra-branch');
    await fork.destroy();
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('retires obsolete checkpoints while keeping current recovery and fork pins (WD-4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-retention-'));
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const project = await store.createProject('Retention');
  const task = await store.createTask({ projectId: project.id, title: 'Checkpoint', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  world.handle = await store.registerWorld(world.handle, project.id) as any;
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const service = new WorldCheckpointService(store, worlds, objects, new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  try {
    await world.writeFile('file', 'first');
    const pinned = await service.checkpoint(world.handle);
    await store.kvSet('fork-checkpoint:fork-task', pinned.id);
    const obsolete = await service.checkpoint(world.handle);
    const previous = await service.checkpoint(world.handle);
    const current = await service.checkpoint(world.handle);
    expect(await store.getWorldCheckpoint(obsolete.id)).toBeUndefined();
    await expect(objects.get(obsolete.filesystemDelta!.objectKey)).rejects.toThrow();
    for (const saved of [pinned, previous, current]) {
      expect(await store.getWorldCheckpoint(saved.id)).toBeDefined();
      expect((await objects.get(saved.filesystemDelta!.objectKey)).length).toBeGreaterThan(0);
    }
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('captures small dirty files with one bounded sandbox listing and one read (WD-19, LT-11)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-batch-'));
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const project = await store.createProject('Batch');
  const task = await store.createTask({ projectId: project.id, title: 'Batch', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'test' } });
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  world.handle = await store.registerWorld(world.handle, project.id) as any;
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const reads = vi.spyOn(world, 'readFileBuffer');
  const exec = vi.spyOn(world, 'exec');
  const service = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
    new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  try {
    for (let i = 0; i < 20; i++) await world.writeFile(`file-${i}`, `value ${i}`);
    const checkpoint = await service.checkpoint(world.handle);
    expect(checkpoint.filesystemDelta?.bytes).toBeGreaterThan(0);
    expect(reads).not.toHaveBeenCalled();
    expect(exec.mock.calls.filter(([command]) => command === 'node')).toHaveLength(2);
  } finally { vi.restoreAllMocks(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('symbolic links (WD-33)', () => {
  const SECRET = 'outside-credential-5d1c0a9e';
  const decryptedFiles = async (service: WorldCheckpointService, store: Store, checkpoint: WorldCheckpoint) => {
    const organizationId = (await store.getProject(checkpoint.projectId))!.organizationId!;
    const files: Array<{ path: string; data?: string; symlink?: boolean }> = [];
    for await (const entry of (service as any).chunks.entries(checkpoint, organizationId)) {
      if (entry.link !== undefined) files.push({ path: entry.path, data: entry.link, symlink: true });
      else if (entry.content) {
        const parts: Buffer[] = [];
        for await (const part of entry.content()) parts.push(part);
        files.push({ path: entry.path, data: Buffer.concat(parts).toString('base64') });
      }
    }
    return files;
  };
  const expectNoSecret = (files: Array<{ data?: string }>) => {
    for (const file of files) expect(Buffer.from(file.data ?? '', 'base64').toString('latin1')).not.toContain(SECRET);
  };

  it('captures links without reading through them and recreates them on restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-links-'));
    const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, SECRET);
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
    fs.symlinkSync('tracked.txt', path.join(repo, 'tracked-link'));
    fs.symlinkSync('tracked.txt', path.join(repo, 'gone-link'));
    await gitOrThrow(repo, ['add', '.']); await gitOrThrow(repo, ['commit', '-qm', 'init']);
    const store = await Store.create(':memory:');
    const project = await store.createProject('Links', { repos: [repo], defaultBase: 'main', worldProvider: 'worktree' });
    const task = await store.createTask({ projectId: project.id, title: 'Links', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } });
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const service = new WorldCheckpointService(store, worlds, objects, new CredentialBroker(new Vault(path.join(dir, 'vault'))));
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
    const links: Record<string, string> = { 'link.txt': 'tracked.txt', 'nested/up': '../other.txt',
      'secret-link': secret, dangling: 'missing/file.txt', 'tracked-link': 'other.txt' };
    for (const [link, target] of Object.entries(links)) {
      const file = path.join(world.handle.root, link);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.rmSync(file, { force: true });
      fs.symlinkSync(target, file);
    }
    fs.unlinkSync(path.join(world.handle.root, 'gone-link'));
    try {
      const checkpoint = await service.checkpoint(world.handle);
      const files = await decryptedFiles(service, store, checkpoint);
      expectNoSecret(files);
      expect(files.filter(file => file.symlink).map(file => file.path).sort()).toEqual(Object.keys(links).sort());
      await world.destroy();
      const restored = await service.restore(checkpoint.id, 'worktree');
      expect(restored.generation).toBe(2);
      for (const [link, target] of Object.entries(links)) {
        const file = path.join(restored.root, link);
        expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(file)).toBe(target);
      }
      expect(fs.existsSync(path.join(restored.root, 'gone-link'))).toBe(false);
      expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET);
      await (await worlds.open(restored)).destroy();
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never writes a regular file through a link still present at its path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-unlinked-'));
    const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, SECRET);
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    fs.symlinkSync('tracked.txt', path.join(repo, 'config'));
    fs.symlinkSync(secret, path.join(repo, 'credential'));
    await gitOrThrow(repo, ['add', '.']); await gitOrThrow(repo, ['commit', '-qm', 'init']);
    const store = await Store.create(':memory:');
    const project = await store.createProject('Unlinked', { repos: [repo], defaultBase: 'main', worldProvider: 'worktree' });
    const task = await store.createTask({ projectId: project.id, title: 'Unlinked', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } });
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const service = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
      new CredentialBroker(new Vault(path.join(dir, 'vault'))));
    const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
    for (const file of ['config', 'credential']) {
      fs.unlinkSync(path.join(world.handle.root, file));
      await world.writeFile(file, `regular ${file}`);
    }
    try {
      const checkpoint = await service.checkpoint(world.handle);
      await world.destroy();
      const restored = await service.restore(checkpoint.id, 'worktree');
      expect(restored.generation).toBe(2);
      for (const file of ['config', 'credential']) {
        expect(fs.lstatSync(path.join(restored.root, file)).isFile()).toBe(true);
        expect(fs.readFileSync(path.join(restored.root, file), 'utf8')).toBe(`regular ${file}`);
      }
      expect(fs.readFileSync(path.join(restored.root, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET);
      await (await worlds.open(restored)).destroy();
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('captures links in a repositoryless world', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-plain-links-'));
    const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, SECRET);
    const store = await Store.create(':memory:');
    const project = await store.createProject('Plain links', { worldProvider: 'worktree' });
    const task = await store.createTask({ projectId: project.id, title: 'Links', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'test' } });
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const service = new WorldCheckpointService(store, worlds, objects, new CredentialBroker(new Vault(path.join(dir, 'vault'))));
    const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
    await world.writeFile('out/report.txt', 'report');
    const links: Record<string, string> = { latest: 'out/report.txt', 'secret-link': secret, dangling: 'missing' };
    for (const [link, target] of Object.entries(links)) fs.symlinkSync(target, path.join(world.handle.root, link));
    try {
      const checkpoint = await service.checkpoint(world.handle);
      expectNoSecret(await decryptedFiles(service, store, checkpoint));
      await world.destroy();
      const restored = await service.restore(checkpoint.id, 'worktree');
      for (const [link, target] of Object.entries(links))
        expect(fs.readlinkSync(path.join(restored.root, link))).toBe(target);
      expect(fs.readFileSync(path.join(restored.root, 'out/report.txt'), 'utf8')).toBe('report');
      await (await worlds.open(restored)).destroy();
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

/** Every object the store holds, for "never stored in plaintext" checks. */
function storedObjects(root: string): Buffer[] {
  return (fs.readdirSync(root, { recursive: true }) as string[]).map(name => path.join(root, name))
    .filter(file => fs.statSync(file).isFile()).map(file => fs.readFileSync(file));
}
