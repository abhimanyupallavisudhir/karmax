import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldHandoffService } from '../src/world/handoff.js';
import { brokerRefreshBranch } from '../src/world/git-broker.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import type { WorldHandle } from '../src/world/types.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

describe('hosted/local Git handoff', () => {
  it('opens files directly from a local non-Git task world', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-open-'));
    const file = path.join(dir, 'result.txt');
    fs.writeFileSync(file, 'done\n');
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Scripts', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Run script', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      actions: [], state: {}, messages: [], worldPath: dir, updatedAt: 1 } as any;
    (await store.saveView(task.id, view));
    (await store.registerWorld({ kind: 'worktree', id: task.id, root: dir, branch: 'main', base: 'main' }, project.id));

    const opened = await new WorldHandoffService(store, new WorldRegistry(), {} as any).openFile(task.id, view, 'result.txt', 2);
    expect(opened).toEqual({ path: file, command: `code --goto '${file}:2'`, materialized: false });

    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The project wiki is never part of a development checkout, so a wiki
  // citation used to fail with "local checkout does not contain the requested
  // repository" (task 367). It names a wiki entry and opens in the wiki view.
  it('resolves a citation inside the project-wiki checkout to its wiki entry', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Platform', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Review', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'review' } as any }));
    const branch = `karmax/${task.id}`;
    // The agent works inside the development checkout; its prompt lists the
    // wiki beside it, at the world root.
    (await store.registerWorld({ kind: 'e2b', id: task.id, root: '/home/user/acme', workdir: '/home/user/acme/app', branch, base: 'main',
      repos: [
        { name: 'app', repo: 'git@github.com:acme/app.git', root: '/home/user/acme/app', branch, base: 'main', target: 'main' },
        { name: 'acme-wiki', role: 'project-wiki', repo: 'git@github.com:acme/acme-wiki.git', root: '/home/user/acme/acme-wiki',
          branch, base: 'main', target: 'main' },
      ] }, project.id));
    const handoff = new WorldHandoffService(store, new WorldRegistry(), {} as any);
    expect(await handoff.wikiCitation(task.id, 'acme-wiki/reviews/2026-09-26/SKILL.md'))
      .toEqual({ wiki: { path: 'reviews/2026-09-26' } });
    expect(await handoff.wikiCitation(task.id, '/home/user/acme/acme-wiki/notes/MEMORY.md'))
      .toEqual({ wiki: { path: 'notes' } });
    expect(await handoff.wikiCitation(task.id, 'acme-wiki/reviews/2026-09-26/diagram.png'))
      .toEqual({ wiki: { path: 'reviews/2026-09-26' } });
    expect(await handoff.wikiCitation(task.id, 'acme-wiki/reviews')).toEqual({ wiki: { path: 'reviews' } });
    expect(await handoff.wikiCitation(task.id, '../acme-wiki/notes/SKILL.md')).toEqual({ wiki: { path: 'notes' } });
    expect(await handoff.wikiCitation(task.id, 'src/index.ts')).toBeUndefined();
    expect(await handoff.wikiCitation(task.id, '/home/user/acme/app/src/index.ts')).toBeUndefined();
    expect(await handoff.wikiCitation(task.id, '/etc/passwd')).toBeUndefined();
    (await store.close());
  });

  it('produces a secret-free SSH checkout plan for every attached repository', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Platform', { worldProvider: 'e2b' }, organization.id));
    const connection = (await store.upsertGitConnection({ organizationId: organization.id, provider: 'github', installationId: '42',
      accountLogin: 'acme', accountType: 'Organization' }));
    const repository = (await store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id }));
    const task = (await store.createTask({ projectId: project.id, title: 'Fix auth', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'fix auth' } as any }));
    const branch = `karmax/${task.id}`;
    (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any));
    (await store.registerWorld({ kind: 'e2b', id: task.id, root: '/workspace', branch, base: 'main', repo: repository.sshUrl,
      repos: [{ name: 'app', repo: repository.sshUrl, root: '/workspace', branch, base: 'main', target: 'main' }] }, project.id));
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => { throw new Error('unused'); },
      open: async () => { throw new Error('unused'); }, destroy: async () => {} } as any);
    const handoff = new WorldHandoffService(store, worlds, {} as any);
    await expect((async () => (await handoff.checkout(task.id)))()).rejects.toThrow(/has not reached GitHub/);
    (await store.appendEvent({ taskId: task.id, type: 'push.branch', ts: Date.now(), payload: { branch } }));
    const plan = (await handoff.checkout(task.id));
    expect(plan.repositories).toEqual([expect.objectContaining({ name: 'app', sshUrl: repository.sshUrl, branch })]);
    expect(plan.cloneScript).toContain(`git clone --branch '${branch}' --single-branch 'git@github.com:acme/app.git' 'app'`);
    expect(plan.pushScript).toContain(`git -C 'app' push origin '${branch}'`);
    expect(JSON.stringify(plan)).not.toMatch(/token|private.key|credential/i);
    (await store.close());
  });

  it('produces a default-branch checkout plan for a hosted project', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Platform Tools', { worldProvider: 'e2b' }, organization.id));
    const repository = (await store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'trunk', private: true }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id, baseBranch: 'release' }));

    const plan = (await new WorldHandoffService(store, new WorldRegistry(), {} as any).projectCheckout(project.id));

    expect(plan.workspace).toBe('karmax-platform-tools');
    expect(plan.repositories).toEqual([expect.objectContaining({ name: 'app', branch: 'trunk' })]);
    expect(plan.cloneScript).toContain("git clone --branch 'trunk' --single-branch 'git@github.com:acme/app.git' 'app'");
    expect(plan.updateScript).toContain("git -C 'app' merge --ff-only 'origin/trunk'");
    expect(JSON.stringify(plan)).not.toMatch(/token|private.key|credential/i);
    (await store.close());
  });

  it('imports a pushed branch through a credential-free bundle and only fast-forwards the cloud checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-handoff-'));
    const remote = path.join(dir, 'remote.git');
    const seed = path.join(dir, 'seed');
    const cloud = path.join(dir, 'cloud');
    const laptop = path.join(dir, 'laptop');
    const branch = 'karmax/task-7';
    fs.mkdirSync(seed);
    await gitOrThrow(dir, ['init', '--bare', '-q', remote]);
    await gitOrThrow(seed, ['init', '-q', '-b', 'main']);
    await ensureIdentity(seed);
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
    await gitOrThrow(seed, ['add', '.']); await gitOrThrow(seed, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(seed, ['switch', '-q', '-c', branch]);
    await gitOrThrow(seed, ['remote', 'add', 'origin', remote]);
    await gitOrThrow(seed, ['push', '-q', '-u', 'origin', branch]);
    await gitOrThrow(dir, ['clone', '-q', '--branch', branch, remote, cloud]);
    await gitOrThrow(dir, ['clone', '-q', '--branch', branch, remote, laptop]);
    await ensureIdentity(laptop);
    fs.writeFileSync(path.join(laptop, 'README.md'), 'edited locally\n');
    await gitOrThrow(laptop, ['add', '.']); await gitOrThrow(laptop, ['commit', '-q', '-m', 'local change']);
    await gitOrThrow(laptop, ['push', '-q', 'origin', branch]);
    const laptopHead = (await git(laptop, ['rev-parse', 'HEAD'])).stdout.trim();

    // Git sees an SSH URL, while this test-only command transports to the local
    // bare repository. Production resolves an App deploy key instead.
    const ssh = path.join(dir, 'test-ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\ncase "$*" in *git-upload-pack*) exec git-upload-pack '${remote}' ;; *git-receive-pack*) exec git-receive-pack '${remote}' ;; esac\nexit 1\n`, { mode: 0o700 });
    const sshUrl = 'git@github.com:acme/app.git';
    const handle: WorldHandle = { kind: 'fake-remote', id: 'task-7', root: cloud, branch, base: 'main', repo: sshUrl,
      repos: [{ name: 'app', repo: sshUrl, root: cloud, branch, base: 'main' }] };
    // Use real filesystem/process operations while retaining the remote kind:
    // handoff must exercise the broker, including bounded binary transfers.
    const world = await new WorktreeProvider().open(handle);
    const result = await brokerRefreshBranch(world, async () => ({ env: { GIT_SSH_COMMAND: ssh } }));
    expect(result.updated).toEqual([{ repo: 'app', branch, sha: laptopHead }]);
    expect((await git(cloud, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(laptopHead);
    expect(fs.readFileSync(path.join(cloud, 'README.md'), 'utf8')).toBe('edited locally\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('materializes a committed cloud branch into a durable host checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-materialize-'));
    const remote = path.join(dir, 'remote.git');
    const seed = path.join(dir, 'seed');
    const cloud = path.join(dir, 'cloud');
    const localRoot = path.join(dir, 'local');
    const branch = 'karmax/task-cloud';
    fs.mkdirSync(seed);
    await gitOrThrow(dir, ['init', '--bare', '-q', remote]);
    await gitOrThrow(seed, ['init', '-q', '-b', 'main']);
    await ensureIdentity(seed);
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
    await gitOrThrow(seed, ['add', '.']); await gitOrThrow(seed, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(seed, ['switch', '-q', '-c', branch]);
    fs.writeFileSync(path.join(seed, 'cloud.txt'), 'from E2B\n');
    await gitOrThrow(seed, ['add', '.']); await gitOrThrow(seed, ['commit', '-q', '-m', 'cloud work']);
    await gitOrThrow(seed, ['remote', 'add', 'origin', remote]);
    await gitOrThrow(seed, ['push', '-q', '-u', 'origin', 'main']);
    await gitOrThrow(seed, ['push', '-q', '-u', 'origin', branch]);
    await gitOrThrow(dir, ['clone', '-q', '--branch', branch, remote, cloud]);
    const ssh = path.join(dir, 'test-ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\ncase "$*" in *git-upload-pack*) exec git-upload-pack '${remote}' ;; *git-receive-pack*) exec git-receive-pack '${remote}' ;; esac\nexit 1\n`, { mode: 0o700 });
    const sshUrl = 'git@github.com:acme/app.git';
    const handle: WorldHandle = { kind: 'e2b', id: 'task-cloud', root: cloud, branch, base: 'main', repo: sshUrl,
      repos: [{ name: 'app', repo: sshUrl, root: cloud, branch, base: 'main' }] };
    // Use real filesystem/process operations while retaining the remote kind:
    // handoff must exercise the broker, including bounded binary transfers.
    const world = await new WorktreeProvider().open(handle);
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Platform', { worldProvider: 'e2b' }, organization.id));
    const connection = (await store.upsertGitConnection({ organizationId: organization.id, provider: 'github', installationId: '42', accountLogin: 'acme', accountType: 'Organization' }));
    const repository = (await store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7', owner: 'acme', name: 'app', sshUrl, defaultBranch: 'main', private: true, gitConnectionId: connection.id }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id }));
    const task = (await store.createTask({ projectId: project.id, title: 'Cloud work', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    handle.id = task.id;
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting', actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any;
    (await store.saveView(task.id, view)); (await store.registerWorld(handle, project.id));
    // Review is precisely when humans run verification commands or open a
    // terminal. Those processes keep the cloud world alive, but must not block
    // publishing the committed task ref into a separate local checkout.
    (await store.createExecution({ id: 'review-server', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'review-action', label: 'Preview',
      command: 'npm start', server: true, openUrls: [] }));
    (await store.setExecutionRunning('review-server'));
    const worlds = new WorldRegistry();
    let worldOpens = 0;
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => world,
      open: async () => { worldOpens++; return world; }, destroy: async () => {} } as any);
    const github = { brokerCredentials: async () => ({ env: { GIT_SSH_COMMAND: ssh } }) } as any;
    const result = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .openFile(task.id, view, `${cloud}/cloud.txt`, 7);
    expect(result.path).toBe(path.join(localRoot, task.id, 'app', 'cloud.txt'));
    expect(result.command).toBe(`code --goto '${path.join(localRoot, task.id, 'app', 'cloud.txt')}:7'`);
    expect(result.materialized).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('from E2B\n');
    expect((await store.eventsOfType(task.id, 'push.head')).at(-1)?.payload.headSha)
      .toBe((await git(cloud, ['rev-parse', 'HEAD'])).stdout.trim());
    expect((await store.eventsSince(task.id, 0)).some((event) => event.type === 'push.branch')).toBe(true);

    const portable = (await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .fileCheckout(task.id, view, `${cloud}/cloud.txt`, 7));
    expect(portable.file).toEqual({ repository: 'app', relativePath: 'cloud.txt', line: 7 });
    expect(portable.openScript).toContain(`if [ -d 'app/.git' ]; then`);
    expect(portable.openScript).toContain(`git -C 'app' merge --ff-only 'origin/${branch}'`);
    expect(portable.openScript).toContain(`code --goto 'app/cloud.txt:7'`);
    await expect((async () => (await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .fileCheckout(task.id, { ...view, status: 'active' }, `${cloud}/cloud.txt`, 7)))()).rejects.toThrow(/reach a checkpoint/);
    await expect((async () => (await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .fileCheckout(task.id, view, '/etc/passwd')))()).rejects.toThrow(/outside the task repositories/);

    const materialized = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .materialize(task.id, view);
    expect(materialized.cwd).toBe(path.join(localRoot, task.id, 'app'));
    expect(materialized.repositories).toEqual([
      expect.objectContaining({ name: 'app', path: path.join(localRoot, task.id, 'app'), branch }),
    ]);
    expect(worldOpens).toBe(1);
    expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'push.branch')).toHaveLength(1);

    await ensureIdentity(cloud);
    fs.writeFileSync(path.join(cloud, 'after-review.txt'), 'new task work\n');
    await gitOrThrow(cloud, ['add', '.']);
    await gitOrThrow(cloud, ['commit', '-q', '-m', 'more cloud work']);
    const refreshed = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .materialize(task.id, { ...view, updatedAt: 2 });
    expect(worldOpens).toBe(2);
    expect(fs.readFileSync(path.join(refreshed.cwd, 'after-review.txt'), 'utf8')).toBe('new task work\n');
    expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'push.branch')).toHaveLength(2);

    // The final task view no longer advertises a live world, and provider
    // compute has been released. Its published checkpoint still materializes
    // without attempting to reopen the destroyed sandbox.
    (await store.setWorldState(handle, 'released'));
    const releasedRoot = path.join(dir, 'released-local');
    const released = await new WorldHandoffService(store, worlds, github, undefined, undefined, releasedRoot)
      .openFile(task.id, { ...view, stage: 'done', status: 'done', updatedAt: 3 }, `${cloud}/after-review.txt`, 9);
    expect(released.path).toBe(path.join(releasedRoot, task.id, 'app', 'after-review.txt'));
    expect(released.command).toBe(`code --goto '${path.join(releasedRoot, task.id, 'app', 'after-review.txt')}:9'`);
    expect(fs.readFileSync(released.path, 'utf8')).toBe('new task work\n');
    expect(worldOpens).toBe(2);
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('materializes a cloud branch backed by a local repository without a project GitHub attachment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-authority-materialize-'));
    const remote = path.join(dir, 'remote.git');
    const source = path.join(dir, 'source');
    const cloud = path.join(dir, 'cloud');
    const localRoot = path.join(dir, 'local');
    const branch = 'karmax/task-local-source';
    fs.mkdirSync(source);
    await gitOrThrow(dir, ['init', '--bare', '-q', remote]);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), 'base\n');
    await gitOrThrow(source, ['add', '.']); await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(source, ['remote', 'add', 'origin', remote]);
    await gitOrThrow(source, ['push', '-q', '-u', 'origin', 'main']);
    await gitOrThrow(dir, ['clone', '-q', remote, cloud]);
    await ensureIdentity(cloud);
    await gitOrThrow(cloud, ['switch', '-q', '-c', branch]);
    fs.writeFileSync(path.join(cloud, 'cloud.txt'), 'from cloud\n');
    await gitOrThrow(cloud, ['add', '.']); await gitOrThrow(cloud, ['commit', '-q', '-m', 'cloud work']);

    const sshUrl = 'git@github.com:acme/app.git';
    const handle: WorldHandle = { kind: 'e2b', id: 'task-local-source', root: cloud, branch, base: 'main', repo: sshUrl,
      repos: [{ name: 'app', repo: sshUrl, localPath: source, root: cloud, branch, base: 'main' }] };
    // Use real filesystem/process operations while retaining the remote kind:
    // handoff must exercise the broker, including bounded binary transfers.
    const world = await new WorktreeProvider().open(handle);
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('Platform', { worldProvider: 'e2b', repos: [source] }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Cloud work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    handle.id = task.id;
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any;
    (await store.saveView(task.id, view)); (await store.registerWorld(handle, project.id));
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => world,
      open: async () => world, destroy: async () => {} } as any);
    const github = { brokerCredentials: async () => { throw new Error('GitHub credentials should not be requested'); } } as any;

    const result = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .materialize(task.id, view);

    expect(result.cwd).toBe(path.join(localRoot, task.id, 'app'));
    expect(fs.readFileSync(path.join(result.cwd, 'cloud.txt'), 'utf8')).toBe('from cloud\n');
    expect((await git(source, ['rev-parse', branch])).stdout.trim()).toBe((await git(cloud, ['rev-parse', 'HEAD'])).stdout.trim());
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });
});
