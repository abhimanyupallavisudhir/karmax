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
import { forkRecordedAuthority, forkWorldSource } from '../src/world/fork.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import type { WorldHandle } from '../src/world/types.js';

describe('fork world initialization', () => {
  it.each(['parked', 'done', 'cancelled', 'failed'] as const)('restores exact commits, dirty files and private resources from a %s source; changing base uses normal state', async (state) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-world-'));
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'main');
    await gitOrThrow(repo, ['add', '.']);
    await gitOrThrow(repo, ['commit', '-qm', 'initial']);
    const project = (await store.createProject('Fork', { repos: [repo], defaultBase: 'main' }));
    const sourceTask = (await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
    const volume = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write',
      isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
    await resources.importFiles(volume.id, [{ path: 'value.txt', data: Buffer.from('promoted') }]);
    const source = await worlds.create('worktree', { taskId: sourceTask.id, repo, base: 'main', target: 'main' });
    source.handle = await resources.materialize(project.id, sourceTask.id, source);
    source.handle = (await store.registerWorld(source.handle, project.id)) as WorldHandle;
    const created: WorldHandle[] = [];
    try {
      const olderCheckpoint = await checkpoints.checkpoint(source.handle, { scrubSecrets: false });
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
      // The fork was requested before the source finished. Its sandbox can be
      // destroyed before setup runs, and a fresh provider can still report ready.
      const finished = state !== 'parked';
      if (finished) {
        (await store.saveView(sourceTask.id, { status: state } as any));
        await source.destroy();
        (await store.setWorldState(source.handle, 'released'));
        // A stale durable handle must not make us restore an older snapshot.
        (await store.attachWorldCheckpoint(source.handle, olderCheckpoint.id));
      }
      const capture = vi.spyOn(checkpoints, 'checkpoint');
      const open = worlds.open.bind(worlds);
      const opened = vi.spyOn(worlds, 'open').mockImplementation((handle) => {
        if (finished && handle.id === sourceTask.id) throw new Error('Sandbox is probably not running anymore');
        return open(handle);
      });
      const status = worlds.status.bind(worlds);
      vi.spyOn(worlds, 'status').mockImplementation((handle) => handle.id === sourceTask.id
        ? Promise.resolve(finished ? 'ready' : 'parked') : status(handle));
      const core = makeCoreActivities({ store, worlds, adapters: new Map(), resources, checkpoints,
        profiles: new ProfileResolver(store, 'mock'), contentDir: path.join(dir, 'content') });
      const create = async (base: string, reuse: boolean) => {
        const task = (await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
          workflowVersion: '1.0.0', params: { prompt: 'fork', base, _forkWorld: plan } }));
        const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo,
          base, target: 'main', kind: 'worktree' });
        created.push(handle);
        if (reuse) expect((await store.kvGet(`fork-checkpoint:${task.id}`))).toBe(checkpoint.id);
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
      // File APIs are world-root-relative; resources belong beside the agent
      // in the development checkout, including when setup adds a companion wiki.
      expect(fork.handle.workdir).toBe(forkRepo.root);
      expect(await fork.readFile(`${prefix}data/value.txt`)).toBe('unpublished resource');
      await expect(fork.readFile('data/value.txt')).rejects.toThrow(/ENOENT/);
      const agentRead = await fork.exec('cat', ['data/value.txt']);
      expect(agentRead.code).toBe(0);
      expect(agentRead.stdout).toBe('unpublished resource');
      await fork.writeFile(`${prefix}data/value.txt`, 'fork changed');
      expect(await resources.summarize(fork.handle.id, volume.id)).toMatchObject({ added: 0, modified: 1, deleted: 0 });
      if (!finished) expect(await source.readFile('data/value.txt')).toBe('unpublished resource');
      if (finished) expect(opened.mock.calls.some(([handle]) => handle.id === sourceTask.id)).toBe(false);
      expect((await store.currentWorld(sourceTask.id))?.generation).toBe(source.handle.generation);
      expect(capture).not.toHaveBeenCalled();

      const fresh = await create('main', false);
      const freshRepo = fresh.handle.repos!.find((entry) => entry.role !== 'project-wiki')!;
      expect(await fresh.readFile(`${freshRepo.name}/file.txt`)).toBe('main');
      await expect(fresh.readFile(`${freshRepo.name}/committed.txt`)).rejects.toThrow();
      expect(await fresh.readFile(`${freshRepo.name}/data/value.txt`)).toBe('promoted');
      const freshAgentRead = await fresh.exec('cat', ['data/value.txt']);
      expect(freshAgentRead.code).toBe(0);
      expect(freshAgentRead.stdout).toBe('promoted');
      expect(capture).not.toHaveBeenCalled();
    } finally {
      for (const handle of created) await (await worlds.open(handle)).destroy();
      if (state === 'parked') await source.destroy();
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'older-generation'] as const)('refuses a finished source with a %s checkpoint instead of opening it or dropping files', async (scenario) => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    const project = (await store.createProject('Fork'));
    const source = (await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } }));
    const handle = (await store.registerWorld({ id: source.id, kind: 'worktree', root: '/unavailable',
      branch: 'tavya/source', base: 'main', target: 'main' }, project.id)) as WorldHandle;
    const plan = forkWorldSource(source, handle)!;
    (await store.saveView(source.id, { status: 'done' } as any));
    const task = (await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'fork', _forkWorld: plan } }));
    if (scenario === 'older-generation') vi.spyOn(store, 'latestWorldCheckpoint').mockReturnValue({
      id: 'old', worldId: source.id, projectId: project.id, generation: 0,
    } as any);
    const opened = vi.spyOn(worlds, 'open');
    // Failure must happen before any checkpoint I/O or destination provisioning.
    const checkpoints = { checkpoint: vi.fn(), applyFork: vi.fn() } as unknown as WorldCheckpointService;
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), checkpoints,
      profiles: new ProfileResolver(store, 'mock') });
    try {
      await expect(core.createWorld({ taskId: task.id, projectId: project.id, base: plan.base,
        target: 'main', kind: 'worktree' })).rejects.toThrow('without a checkpoint for its current generation');
      expect(opened).not.toHaveBeenCalled();
      expect((await store.currentWorld(task.id))).toBeUndefined();
    } finally { (await store.close()); }
  });

  it('copies repositoryless output files without copying injected secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-plain-'));
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Documents'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')), broker);
    const source = await worlds.create('worktree', { taskId: 'source', base: 'main' });
    source.handle.meta = { ephemeralPaths: ['credential.txt'] };
    source.handle = (await store.registerWorld(source.handle, project.id)) as WorldHandle;
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
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provisions the repositories and authority its checkpoint recorded, not newer project defaults (WD-11)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-recorded-'));
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const [original, replacement] = ['original', 'replacement'].map((name) => path.join(dir, name));
    for (const repo of [original!, replacement!]) {
      fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'file.txt'), path.basename(repo));
      await gitOrThrow(repo, ['add', '.']);
      await gitOrThrow(repo, ['commit', '-qm', 'initial']);
    }
    const project = (await store.createProject('Fork', { repos: [original!], defaultBase: 'main' }));
    const sourceTask = (await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')), broker);
    const source = await worlds.create('worktree', { taskId: sourceTask.id, repo: original, base: 'main', target: 'main' });
    source.handle = (await store.registerWorld(source.handle, project.id)) as WorldHandle;
    const created: WorldHandle[] = [];
    try {
      await source.writeFile('file.txt', 'unpublished source work');
      await checkpoints.checkpoint(source.handle, { scrubSecrets: false });
      const plan = forkWorldSource(sourceTask, source.handle)!;
      // The project moved on to another repository after the source started;
      // the workflow passes today's project repositories to createWorld.
      (await store.updateProjectConfig(project.id, { ...project.config, repos: [replacement!] }));
      const core = makeCoreActivities({ store, worlds, adapters: new Map(), checkpoints,
        profiles: new ProfileResolver(store, 'mock') });
      const task = (await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'fork', base: plan.base, _forkWorld: plan } }));
      const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repos: [replacement!],
        base: plan.base, target: 'main', kind: 'worktree' });
      created.push(handle);
      const fork = await worlds.open(handle);
      const recorded = fork.handle.repos!.find((repo) => repo.repo === original)!;
      expect(recorded).toBeDefined();
      expect(await fork.readFile(`${recorded.name}/file.txt`)).toBe('unpublished source work');
      expect(fork.handle.repos!.some((repo) => repo.repo === replacement)).toBe(true);

      // A checkout whose base history GitHub owned must be provisioned from
      // origin again, even if the project has since switched to local policy.
      const prTask = (await store.createTask({ projectId: project.id, title: 'PR source', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'source' } }));
      const prSource = await worlds.create('worktree', { taskId: prTask.id, repo: original, base: 'main', target: 'main' });
      prSource.handle.repos![0]!.sourceAuthority = 'origin';
      prSource.handle = (await store.registerWorld(prSource.handle, project.id)) as WorldHandle;
      created.push(prSource.handle);
      const originCheckpoint = await checkpoints.checkpoint(prSource.handle, { scrubSecrets: false });
      expect(originCheckpoint.repos[0]!.sourceAuthority).toBe('origin');
      const prPlan = forkWorldSource(prTask, prSource.handle)!;
      const again = (await store.createTask({ projectId: project.id, title: 'Fork again', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'fork', base: prPlan.base, _forkWorld: prPlan } }));
      const spec = vi.spyOn(worlds, 'create').mockRejectedValueOnce(new Error('spec captured'));
      await expect(core.createWorld({ taskId: again.id, projectId: project.id, repos: [replacement!],
        base: prPlan.base, target: 'main', kind: 'worktree' })).rejects.toThrow('spec captured');
      expect(spec.mock.calls[0]![1]).toMatchObject({ repositoryAuthorities: { [original!]: 'origin' } });
      expect(spec.mock.calls[0]![1].repositoryAuthorities?.[replacement!]).toBeUndefined();
    } finally {
      for (const handle of created) await (await worlds.open(handle)).destroy();
      await source.destroy();
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the authority of a checkpoint that predates recording it to the current policy (WD-11)', () => {
    const entry = { repositoryId: 'r', source: 'git@github.com:acme/app.git', checkoutPath: '.', baseSha: 'a', branch: 'karmax/source' };
    const checkpoint = (repo: Record<string, unknown>) => ({ repos: [{ ...entry, ...repo }] }) as any;
    // Before authorities were recorded an 'origin' checkout looked exactly like
    // a 'project' one, so neither may be forced to 'project'.
    expect(forkRecordedAuthority(checkpoint({}), [entry.source])).toEqual([undefined]);
    // Entries that record authorities omit only 'project'; they also carry the
    // commit identity (and a local checkout's path).
    const identity = { gitIdentity: { name: 'Agent', email: 'agent@example.com' } };
    expect(forkRecordedAuthority(checkpoint(identity), [entry.source])).toEqual(['project']);
    expect(forkRecordedAuthority(checkpoint({ localPath: '/srv/app' }), [entry.source])).toEqual(['project']);
    expect(forkRecordedAuthority(checkpoint({ ...identity, sourceAuthority: 'origin' }), [entry.source])).toEqual(['origin']);
  });

  it('preserves separate repository branches and commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-repos-'));
    const store = (await Store.create(':memory:'));
    const repositories = ['one', 'two'].map((name) => path.join(dir, name));
    for (const repo of repositories) {
      fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'file'), 'initial');
      await gitOrThrow(repo, ['add', '.']);
      await gitOrThrow(repo, ['commit', '-qm', 'initial']);
    }
    const project = (await store.createProject('Repos', { repos: repositories }));
    const task = (await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'source' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')), broker);
    const source = await worlds.create('worktree', { taskId: task.id, repos: repositories, base: 'main', target: 'main' });
    source.handle = (await store.registerWorld(source.handle, project.id)) as WorldHandle;
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
      (await store.saveView(task.id, { status: 'done', targetBranch: 'main' } as any));
      expect(forkWorldSource((await store.getTask(task.id))!, source.handle)?.repos.map((repo) => repo.base)).toEqual(['main', 'main']);
    } finally {
      await fork.destroy();
      await source.destroy();
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
