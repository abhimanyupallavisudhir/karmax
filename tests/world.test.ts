import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { World } from '../src/world/types.js';
import { git, gitOrThrow, currentBranch, ensureIdentity } from '../src/world/git.js';
import { withWorktreeLock } from '../src/world/worktree-lock.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Store } from '../src/store/db.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { ApplicationFailure } from '@temporalio/common';
import { lifecycleReplacementKey } from '../src/platform/lifecycle-replacement.js';
import { forkWorldSource } from '../src/world/fork.js';
import { ProjectResourceService, ObjectSnapshotEngine } from '../src/world/resources.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';

describe('WorktreeProvider (real git)', () => {
  let home: string;
  let repo: string;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates an isolated worktree on a karmax branch off the base', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'abc', repo, base: 'main', target: 'main' });
    expect(world.handle.branch).toBe('karmax/abc');
    expect(fs.existsSync(world.handle.root)).toBe(true);
    expect(await currentBranch(world.handle.root)).toBe('karmax/abc');
    // base file is present in the worktree
    expect(await world.readFile('index.js')).toContain('console.log');
    await world.destroy();
    expect(fs.existsSync(world.handle.root)).toBe(false);
    // branch is preserved after destroy
    expect((await git(repo, ['rev-parse', '--verify', 'karmax/abc'])).code).toBe(0);
  });

  it('tags remote sandbox transport failures for outage-tolerant workflow backoff', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'fake-remote',
      capabilities: { remote: true },
      async create() {
        throw Object.assign(new Error('E2B sandbox creation failed'), { code: 'ETIMEDOUT' });
      },
      async open() { throw new Error('unused'); },
      async destroy() {},
    } as any);
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    try {
      const failure = await core.createWorld({ taskId: 'transport-timeout', base: 'main',
        target: 'main', kind: 'fake-remote' as any }).catch((error) => error);
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ type: 'world-infra', nonRetryable: false });
    } finally {
      (await store.close());
    }
  });

  it('parks a remote world when its task escalates as blocked', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Blocked remote', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'Blocked', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id,
      generation: 1, root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`,
      base: 'main', meta: { projectId: project.id } }, project.id)) as any;
    let parked = false;
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'e2b', capabilities: { remote: true }, parkable: true,
      async status() { return parked ? 'parked' : 'ready'; },
      async park() { parked = true; return handle; },
    } as any);
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    try {
      await core.publishView(task.id, {
        taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'escalated', status: 'blocked',
        messages: [], actions: [], state: { recoveryWorld: handle }, world: handle,
        pointOfNoReturnPassed: false, editableParams: [], updatedAt: 1,
      } as any);
      expect(parked).toBe(true);
      expect((await store.worldState(task.id))).toBe('parked');
    } finally {
      (await store.close());
    }
  });

  it('does not publish the old run as cancelled during a lifecycle replacement', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Replacement', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'Still alive', workflow: 'software-dev',
      workflowVersion: '1.22.0', params: { prompt: 'x' } as any }));
    const active = {
      taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: 1,
    } as any;
    (await store.saveView(task.id, active));
    (await store.appendEvent({ taskId: task.id, type: 'agent.output', ts: 1, payload: { text: 'preserve me' } }));
    (await store.kvSet(lifecycleReplacementKey(task.id), JSON.stringify({ requestedAt: Date.now() })));
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });

    try {
      await core.publishView(task.id, {
        ...active, stage: 'cancelled', status: 'cancelled',
        state: { cancelled: true, cancelledFrom: 'do' }, updatedAt: 2,
      });

      expect((await store.getTask(task.id))?.lastView).toMatchObject({ stage: 'do', status: 'active' });
      expect((await store.getTask(task.id))?.params.archived).not.toBe(true);
      expect((await store.eventsSince(task.id, 0))).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent.output', payload: { text: 'preserve me' } }),
      ]));
      expect((await store.eventsSince(task.id, 0)).some((event) =>
        event.type === 'view.updated' && event.payload.status === 'cancelled')).toBe(false);

      // A real cancellation has no replacement marker and remains terminal.
      (await store.kvDelete(lifecycleReplacementKey(task.id)));
      await core.publishView(task.id, {
        ...active, stage: 'cancelled', status: 'cancelled',
        state: { cancelled: true, cancelledFrom: 'do' }, updatedAt: 3,
      });
      expect((await store.getTask(task.id))?.lastView).toMatchObject({ stage: 'cancelled', status: 'cancelled' });
    } finally {
      (await store.close());
    }
  });

  it('forks a PR-policy task from origin without moving a stale local base', async () => {
    const remote = path.join(home, 'origin.git');
    const writer = path.join(home, 'writer');
    await gitOrThrow(home, ['clone', '-q', '--bare', repo, remote]);
    await gitOrThrow(repo, ['remote', 'add', 'origin', remote]);
    const localBase = (await git(repo, ['rev-parse', 'main'])).stdout.trim();

    await gitOrThrow(home, ['clone', '-q', remote, writer]);
    await ensureIdentity(writer);
    fs.writeFileSync(path.join(writer, 'remote-only.txt'), 'new target state\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'advance remote']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    const remoteBase = (await git(writer, ['rev-parse', 'main'])).stdout.trim();

    const provider = new WorktreeProvider(home);
    const world = await provider.create({
      taskId: 'pr-origin', repo, base: 'main', target: 'main',
      repositoryAuthorities: { [repo]: 'origin' },
      repositoryOrigins: { [repo]: remote },
    });
    try {
      expect((await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(remoteBase);
      expect((await git(repo, ['rev-parse', 'main'])).stdout.trim()).toBe(localBase);
      expect(world.handle.repos?.[0]).toMatchObject({ source: remote, sourceAuthority: 'origin', baseSha: remoteBase });
      expect(world.handle.warnings?.join('\n')).toMatch(/local main differs from origin\/main.*forked off origin/i);
      expect(fs.readFileSync(path.join(world.handle.root, 'remote-only.txt'), 'utf8')).toContain('new target state');
    } finally {
      await world.destroy();
    }

    await gitOrThrow(writer, ['switch', '-q', '-c', 'review']);
    fs.writeFileSync(path.join(writer, 'review-only.txt'), 'existing proposal\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'review branch']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'review']);
    const reviewBase = (await git(writer, ['rev-parse', 'review'])).stdout.trim();
    const reviewWorld = await provider.create({
      taskId: 'pr-review', repo, base: 'main', branch: 'review',
      repositoryAuthorities: { [repo]: 'origin' },
      repositoryOrigins: { [repo]: remote },
    });
    try {
      expect((await git(reviewWorld.handle.root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(reviewBase);
      expect(fs.readFileSync(path.join(reviewWorld.handle.root, 'review-only.txt'), 'utf8')).toContain('existing proposal');
    } finally {
      await reviewWorld.destroy();
    }
  });

  it('feeds ExecOptions.input to a command over stdin (secret channel for in-world fill)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'stdin', repo, base: 'main', target: 'main' });
    try {
      // `cat` echoes stdin; the payload must NOT appear in argv.
      const res = await world.exec('cat', [], { input: 'sup3r-secret\n' });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('sup3r-secret\n');
      // a reader that only sees argv (no stdin) gets nothing
      const argvOnly = await world.exec('bash', ['-lc', 'echo "$@"', '--'], {});
      expect(argvOnly.stdout).not.toContain('sup3r-secret');
    } finally {
      await world.destroy();
    }
  });

  it.each([false, true])('restores resources beside the agent with a companion wiki (multiple development repos: %s)', async (multiple) => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    const store = (await Store.create(':memory:'));
    const sources = [repo];
    if (multiple) {
      const extra = path.join(contentDir, 'extra'); fs.mkdirSync(extra);
      await gitOrThrow(extra, ['init', '-q', '-b', 'main']); await ensureIdentity(extra);
      await gitOrThrow(extra, ['commit', '--allow-empty', '-q', '-m', 'init']);
      sources.push(extra);
    }
    const project = (await store.createProject('Wiki world', { repos: sources, defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({ projectId: project.id, title: 'Edit both', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const broker = new CredentialBroker(new Vault(path.join(contentDir, 'vault')));
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(contentDir, 'objects')), broker), broker);
    const ledger = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Ledger', driver: 'object-tree@1', target: { kind: 'path', path: 'runs/spend.sqlite' },
      access: 'write', isolation: 'fork', source: { shape: 'file' }, credentialHandles: [], publish: 'review' }));
    // Larger than a snapshot chunk exercises append as well as the initial write.
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0x71);
    await resources.importFiles(ledger.id, [{ path: 'spend.sqlite', data: bytes }]);
    const dataset = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Dataset', driver: 'volume@1', target: { kind: 'path', path: 'data' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' }));
    await resources.importFiles(dataset.id, [{ path: 'packets.jsonl', data: Buffer.from('dataset') }]);
    (await broker.registerHandle('resource:wiki-test', 'private-token'));
    (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'File secret', driver: 'secret@1', target: { kind: 'path', path: '.env.local' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: ['resource:wiki-test'], publish: 'discard' }));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), contentDir, resources });
    try {
      const handle = await core.createWorld({ taskId: task.id, repos: sources, base: 'main', target: 'main', kind: 'worktree' });
      expect(handle.repos).toHaveLength(multiple ? 3 : 2);
      expect(handle.repos!.find((candidate) => candidate.role === 'project-wiki')).toMatchObject({
        branch: `karmax/${task.id}`, base: 'main', target: 'main',
      });
      const cwd = handle.workdir ?? handle.root;
      expect(cwd).toBe(multiple ? handle.root : handle.repos!.find((candidate) => candidate.role !== 'project-wiki')!.root);
      expect(fs.readFileSync(path.join(cwd, 'runs/spend.sqlite')).equals(bytes)).toBe(true);
      if (!multiple) expect(fs.existsSync(path.join(handle.root, 'runs/spend.sqlite'))).toBe(false);
      const datasetFile = path.join(cwd, 'data/packets.jsonl');
      expect(fs.readFileSync(datasetFile, 'utf8')).toBe('dataset');
      expect(fs.statSync(datasetFile).mode & 0o222).toBe(0);
      const world = await worlds.open(handle);
      for (const checkout of handle.repos!) {
        const status = await world.exec('git', ['status', '--porcelain'], { cwd: checkout.root });
        expect(status.code).toBe(0);
        expect(status.stdout.trim()).toBe('');
      }
      expect(fs.statSync(path.join(cwd, '.env.local')).mode & 0o777).toBe(0o600);
      await resources.scrubSecrets(handle);
      expect(fs.existsSync(path.join(cwd, '.env.local'))).toBe(false);
      await resources.prepare(world);
      expect(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')).toBe('private-token');
      fs.writeFileSync(path.join(cwd, 'runs/spend.sqlite'), 'updated');
      expect(await resources.summarize(task.id, ledger.id)).toMatchObject({ modified: 1, deleted: 0 });
      const refs = await resources.checkpoint(handle);
      expect((await resources.verifyRevision(project.id, ledger.id, refs[0]!.revisionId)).verifiedBytes).toBe(7);
      expect((await resources.promote(task.id, ledger.id)).revision.bytes).toBe(7);
      await expect(resources.proposePath(task.id, { path: 'runs/spend.sqlite', name: 'Duplicate',
        target: { kind: 'path', path: 'other.sqlite' } })).rejects.toThrow(/already belongs/);
      await resources.release(handle);
      expect(fs.statSync(datasetFile).mode & 0o200).toBe(0o200);
      await worlds.open(handle).then((world) => world.destroy());
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
      (await store.close());
    }
  });

  it('preserves the wiki destination when a fork inherits a different task target', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-target-'));
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Fork targets', { repos: [repo], defaultBase: 'main' }));
    const source = (await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x', target: 'master' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), contentDir });
    const handles: Awaited<ReturnType<typeof core.createWorld>>[] = [];
    try {
      await gitOrThrow(repo, ['branch', 'master']);
      const original = await core.createWorld({ taskId: source.id, repos: [repo], base: 'main', target: 'master', kind: 'worktree' });
      handles.push(original);
      const plan = forkWorldSource(source, original)!;
      // Published Git state is sufficient for this branch-policy regression.
      plan.unpublished = false;
      const task = (await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'x', base: plan.base, target: 'master', _forkWorld: plan } }));
      const fork = await core.createWorld({ taskId: task.id, repos: [repo], base: plan.base, target: 'master', kind: 'worktree' });
      handles.push(fork);
      expect(fork.repos!.find((r) => r.role === 'project-wiki')).toMatchObject({
        base: original.branch, target: 'main', targetPinned: true,
      });
      expect(fork.repos!.find((r) => r.role !== 'project-wiki')).toMatchObject({
        base: original.branch, target: 'master',
      });
    } finally {
      for (const handle of handles.reverse()) await worlds.open(handle).then((world) => world.destroy());
      fs.rmSync(contentDir, { recursive: true, force: true });
      (await store.close());
    }
  });

  it('keeps repository-less project work outside Git even when the project has a wiki', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Wiki scratch', { repos: [], defaultBase: 'main', defaultTarget: 'main' }));
    const task = (await store.createTask({ projectId: project.id, title: 'Scratch task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), contentDir });
    try {
      const handle = await core.createWorld({ taskId: task.id, base: 'main', target: 'main', kind: 'worktree' });
      expect(handle.repos).toEqual([]);
      expect(handle.repo).toBeUndefined();
      expect(fs.existsSync(path.join(handle.root, '.git'))).toBe(false);
      const opened = await worlds.open(handle);
      expect((await opened.exec('pwd', [])).stdout.trim()).toBe(handle.root);
      await opened.destroy();
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
      (await store.close());
    }
  });

  it('reports only this branch\'s changes when the base branch advances mid-task', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    try {
      const handle = await core.createWorld({ taskId: 'drift', repos: [repo], base: 'main', target: 'main', kind: 'worktree' });

      // Another task merges into the base branch while this world is open.
      fs.writeFileSync(path.join(repo, 'other-task.js'), 'console.log("theirs")\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'someone else’s merge']);

      // The base moving must not be attributed to this task.
      expect((await core.buildReview(handle, 'main')).changedFiles).toEqual([]);

      // ...but this branch's own work — committed and not — still is.
      const workdir = handle.workdir ?? handle.root;
      fs.writeFileSync(path.join(workdir, 'index.js'), 'console.log(2)\n');
      fs.writeFileSync(path.join(workdir, 'scratch.txt'), 'wip\n');
      const review = await core.buildReview(handle, 'main');
      expect(review.changedFiles).toContain('index.js');
      expect(review.changedFiles).toContain('scratch.txt (new)');
      expect(review.changedFiles).not.toContain('other-task.js');

      await worlds.open(handle).then((world) => world.destroy());
    } finally {
      (await store.close());
    }
  });

  it('warns (but still forks off HEAD) when the configured base branch does not exist', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'nobase', repo, base: 'develop', target: 'main' });
    // The world is still usable — it forked off HEAD.
    expect(await currentBranch(world.handle.root)).toBe('karmax/nobase');
    expect(await world.readFile('index.js')).toContain('console.log');
    // …but the ignored base is surfaced, not swallowed.
    expect(world.handle.warnings).toBeTruthy();
    expect(world.handle.warnings!.join('\n')).toMatch(/Base branch changed to "main" because "develop" did not exist/);
    await world.destroy();
  });

  it('records both branch names when a missing base and target fall back to HEAD', async () => {
    const world = await new WorktreeProvider(home).create({ taskId: 'fallback', repo, base: 'master', target: 'master' });
    try {
      expect(world.handle).toMatchObject({ base: 'main', target: 'main' });
      expect(world.handle.repos![0]).toMatchObject({ base: 'main', target: 'main' });
      expect(world.handle.warnings!.join('\n')).toContain('Base and target branch changed to "main" because "master" did not exist');
    } finally { await world.destroy(); }
  });

  it('does not warn when the configured base branch exists', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'okbase', repo, base: 'main', target: 'main' });
    expect(world.handle.warnings).toBeUndefined();
    await world.destroy();
  });

  it('creates a plain workspace when no repo is given', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'scratch1', base: 'main' });
    expect(fs.existsSync(world.handle.root)).toBe(true);
    expect(world.handle.repo).toBeUndefined();
    expect(world.handle.repos).toEqual([]);
    expect(fs.existsSync(path.join(world.handle.root, '.git'))).toBe(false);
    await world.writeFile('hello.txt', 'hi');
    expect(await world.readFile('hello.txt')).toBe('hi');
    const files = await world.listFiles();
    expect(files).toContain('hello.txt');
    await world.destroy();
  });

  it('exec runs commands in the world root', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'exec1', repo, base: 'main' });
    const r = await world.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('karmax/exec1');
    await world.destroy();
  });

  it('links the origin node_modules into the world so the checkout can run itself', async () => {
    // Simulate an installed dependency in the origin repo.
    const dep = path.join(repo, 'node_modules', 'left-pad');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1\n');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'deps1', repo, base: 'main' });
    // The world can resolve the origin's installed deps without a per-world install.
    const linked = path.join(world.handle.root, 'node_modules', 'left-pad', 'index.js');
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toContain('module.exports');
    // The link must be git-ignored — a `node_modules/` rule matches dirs only,
    // not a symlink, so without an explicit exclude an agent could commit it.
    const others = await git(world.handle.root, ['ls-files', '--others', '--exclude-standard']);
    expect(others.stdout).not.toContain('node_modules');
    await world.destroy();
  });

  it('does not link node_modules when the origin has none (scratch/non-Node repo)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'deps2', repo, base: 'main' });
    expect(fs.existsSync(path.join(world.handle.root, 'node_modules'))).toBe(false);
    await world.destroy();
  });

  it('copies named gitignored files into the world', async () => {
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'copy1', repo, base: 'main', copyGlobs: ['.env'] });
    expect(await world.readFile('.env')).toContain('SECRET=1');
    expect(world.handle.meta?.ephemeralPaths).toEqual(['.env']);
    // The copied secret must be git-excluded so an agent's `git add -A` can't
    // stage and commit it (the .gitignore that hid it in the origin isn't copied).
    const others = await git(world.handle.root, ['ls-files', '--others', '--exclude-standard']);
    expect(others.stdout).not.toContain('.env');
    await world.destroy();
  });

  /**
   * Releasing a world must not take an arriving world's git plumbing with it.
   * Every task in a project branches off the SAME origin repo, so every world
   * contends for one recycled `<origin>/.git/worktrees/<basename><n>` name
   * sequence — see src/world/worktree-lock.ts for how a release then deletes a
   * newcomer's admin dir, silently leaving it unable to commit or merge.
   * Both halves must therefore hold the repo's worktree lock.
   */
  it('creates a world only while holding the repo\'s worktree lock', async () => {
    const provider = new WorktreeProvider(home);
    let created = false;
    let creating!: Promise<World>;
    await withWorktreeLock(repo, async () => {
      creating = provider.create({ taskId: 'arriving', repo, base: 'main', target: 'main' })
        .then((world) => { created = true; return world; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(created, 'world creation ran its `worktree add` while another holder had the lock').toBe(false);
    });
    await (await creating).destroy();
  });

  it('releases a world only while holding the repo\'s worktree lock', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'leaving', repo, base: 'main', target: 'main' });
    let released = false;
    await withWorktreeLock(repo, async () => {
      void world.destroy().then(() => { released = true; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(released, 'world release ran its `worktree remove` while another holder had the lock').toBe(false);
    });
    await vi.waitFor(() => expect(released).toBe(true));
  });
});
