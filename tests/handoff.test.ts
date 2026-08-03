import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldHandoffService } from '../src/world/handoff.js';
import { brokerRefreshBranch } from '../src/world/git-broker.js';
import type { World, WorldHandle } from '../src/world/types.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

describe('hosted/local Git handoff', () => {
  it('opens files directly from a local non-Git task world', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-open-'));
    const file = path.join(dir, 'result.txt');
    fs.writeFileSync(file, 'done\n');
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Scripts', {}, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Run script', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      actions: [], state: {}, messages: [], worldPath: dir, updatedAt: 1 } as any;
    store.saveView(task.id, view);
    store.registerWorld({ kind: 'worktree', id: task.id, root: dir, branch: 'main', base: 'main' }, project.id);

    const opened = await new WorldHandoffService(store, new WorldRegistry(), {} as any).openFile(task.id, view, 'result.txt', 2);
    expect(opened).toEqual({ path: file, command: `code --goto '${file}:2'`, materialized: false });

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('produces a secret-free SSH checkout plan for every attached repository', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Platform', { worldProvider: 'e2b' }, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github', installationId: '42',
      accountLogin: 'acme', accountType: 'Organization' });
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const task = store.createTask({ projectId: project.id, title: 'Fix auth', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'fix auth' } as any });
    const branch = `karmax/${task.id}`;
    store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any);
    store.registerWorld({ kind: 'e2b', id: task.id, root: '/workspace', branch, base: 'main', repo: repository.sshUrl,
      repos: [{ name: 'app', repo: repository.sshUrl, root: '/workspace', branch, base: 'main', target: 'main' }] }, project.id);
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => { throw new Error('unused'); },
      open: async () => { throw new Error('unused'); }, destroy: async () => {} } as any);
    const handoff = new WorldHandoffService(store, worlds, {} as any);
    expect(() => handoff.checkout(task.id)).toThrow(/has not reached GitHub/);
    store.appendEvent({ taskId: task.id, type: 'push.branch', ts: Date.now(), payload: { branch } });
    const plan = handoff.checkout(task.id);
    expect(plan.repositories).toEqual([expect.objectContaining({ name: 'app', sshUrl: repository.sshUrl, branch })]);
    expect(plan.cloneScript).toContain(`git clone --branch '${branch}' --single-branch 'git@github.com:acme/app.git' 'app'`);
    expect(plan.pushScript).toContain(`git -C 'app' push origin '${branch}'`);
    expect(JSON.stringify(plan)).not.toMatch(/token|private.key|credential/i);
    store.close();
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
    const world: World = {
      handle,
      async exec(command, args, options = {}) {
        if (command === 'git') return git(options.cwd ?? cloud, args, { env: options.env, timeoutMs: options.timeoutMs });
        if (command === 'rm') { for (const file of args.filter((arg) => arg !== '-f')) fs.rmSync(path.join(options.cwd ?? cloud, file), { force: true }); return { stdout: '', stderr: '', code: 0 }; }
        return { stdout: '', stderr: `unsupported ${command}`, code: 1 };
      },
      readFile: async () => '', readFileBuffer: async () => Buffer.alloc(0),
      writeFile: async (file, content) => fs.writeFileSync(path.join(cloud, file), content),
      writeFileBuffer: async (file, content) => fs.writeFileSync(path.join(cloud, file), content),
      listFiles: async () => [], startProcess: async () => { throw new Error('unused'); },
      openPty: async () => { throw new Error('unused'); }, destroy: async () => {},
    };
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
    const world: World = {
      handle,
      async exec(command, args, options = {}) {
        if (command === 'git') return git(options.cwd ?? cloud, args, { env: options.env, timeoutMs: options.timeoutMs });
        if (command === 'rm') { for (const file of args.filter((arg) => arg !== '-f')) fs.rmSync(path.join(options.cwd ?? cloud, file), { force: true }); return { stdout: '', stderr: '', code: 0 }; }
        return { stdout: '', stderr: `unsupported ${command}`, code: 1 };
      },
      async readFile(file) { return fs.readFileSync(path.join(cloud, file), 'utf8'); },
      async readFileBuffer(file) { return fs.readFileSync(path.join(cloud, file)); },
      async writeFile(file, content) { fs.writeFileSync(path.join(cloud, file), content); },
      async writeFileBuffer(file, content) { fs.writeFileSync(path.join(cloud, file), content); },
      async listFiles() { return []; }, async startProcess() { throw new Error('unused'); },
      async openPty() { throw new Error('unused'); }, async destroy() {},
    };
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Platform', { worldProvider: 'e2b' }, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github', installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7', owner: 'acme', name: 'app', sshUrl, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const task = store.createTask({ projectId: project.id, title: 'Cloud work', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    handle.id = task.id;
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting', actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any;
    store.saveView(task.id, view); store.registerWorld(handle, project.id);
    // Review is precisely when humans run verification commands or open a
    // terminal. Those processes keep the cloud world alive, but must not block
    // publishing the committed task ref into a separate local checkout.
    store.createExecution({ id: 'review-server', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'review-action', label: 'Preview',
      command: 'npm start', server: true, openUrls: [] });
    store.setExecutionRunning('review-server');
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => world, open: async () => world, destroy: async () => {} } as any);
    const github = { brokerCredentials: async () => ({ env: { GIT_SSH_COMMAND: ssh } }) } as any;
    const result = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .openFile(task.id, view, `${cloud}/cloud.txt`, 7);
    expect(result.path).toBe(path.join(localRoot, task.id, 'app', 'cloud.txt'));
    expect(result.command).toBe(`code --goto '${path.join(localRoot, task.id, 'app', 'cloud.txt')}:7'`);
    expect(result.materialized).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('from E2B\n');
    expect(store.eventsSince(task.id, 0).some((event) => event.type === 'push.branch')).toBe(true);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
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
    const world: World = {
      handle,
      async exec(command, args, options = {}) {
        if (command === 'git') return git(options.cwd ?? cloud, args, { env: options.env, timeoutMs: options.timeoutMs });
        return { stdout: '', stderr: `unsupported ${command}`, code: 1 };
      },
      async readFile(file) { return fs.readFileSync(path.join(cloud, file), 'utf8'); },
      async readFileBuffer(file) { return fs.readFileSync(path.join(cloud, file)); },
      async writeFile(file, content) { fs.writeFileSync(path.join(cloud, file), content); },
      async writeFileBuffer(file, content) { fs.writeFileSync(path.join(cloud, file), content); },
      async listFiles() { return []; }, async startProcess() { throw new Error('unused'); },
      async openPty() { throw new Error('unused'); }, async destroy() {},
    };
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Platform', { worldProvider: 'e2b', repos: [source] }, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Cloud work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    handle.id = task.id;
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      actions: [], state: {}, messages: [], branch, base: 'main', waitingFor: { kind: 'human' }, updatedAt: 1 } as any;
    store.saveView(task.id, view); store.registerWorld(handle, project.id);
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, create: async () => world,
      open: async () => world, destroy: async () => {} } as any);
    const github = { brokerCredentials: async () => { throw new Error('GitHub credentials should not be requested'); } } as any;

    const result = await new WorldHandoffService(store, worlds, github, undefined, undefined, localRoot)
      .materialize(task.id, view);

    expect(result.cwd).toBe(path.join(localRoot, task.id, 'app'));
    expect(fs.readFileSync(path.join(result.cwd, 'cloud.txt'), 'utf8')).toBe('from cloud\n');
    expect((await git(source, ['rev-parse', branch])).stdout.trim()).toBe((await git(cloud, ['rev-parse', 'HEAD'])).stdout.trim());
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
