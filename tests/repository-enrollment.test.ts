import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

describe('live project repository enrollment', () => {
  const cleanups: string[] = [];
  afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('atomically attaches into the parent world, publishes every checkout, and imports it in a child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-enrollment-'));
    cleanups.push(root);
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Enrollment test' }));
    const project = (await store.createProject('Dynamic repository project', {}, organization.id));
    const makeSource = async (name: string) => {
      const source = path.join(root, name);
      fs.mkdirSync(source);
      await gitOrThrow(source, ['init', '-q', '-b', 'main']);
      await ensureIdentity(source);
      fs.writeFileSync(path.join(source, 'README.md'), `# ${name}\n`);
      await gitOrThrow(source, ['add', '-A']);
      await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
      return source;
    };
    const [first, second] = [await makeSource('first'), await makeSource('second')];
    const empty = path.join(root, 'empty.git');
    await gitOrThrow(root, ['init', '-q', '--bare', empty]);
    const sshUrl = 'git@github.com:example/empty.git';
    const repository = (await store.upsertRepository({
      organizationId: organization.id, provider: 'github', providerId: '77', owner: 'example', name: 'empty',
      sshUrl, defaultBranch: 'main', private: true, gitConnectionId: 'connection',
    }));
    const parentTask = (await store.createTask({
      projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'create and attach a repository' },
    }));
    const childTask = (await store.createTask({
      projectId: project.id, title: 'Child', workflow: 'software-dev', workflowVersion: '1.0.0',
      parentTaskId: parentTask.id, params: { prompt: 'implement in the repository' },
    }));
    const provider = new WorktreeProvider(path.join(root, 'worlds'));
    const parent = await provider.create({ taskId: parentTask.id, repos: [first, second], base: 'main' });
    const child = await provider.create({ taskId: childTask.id, repos: [first, second], base: 'main' });
    parent.handle = (await store.registerWorld(parent.handle, project.id)) as typeof parent.handle;
    child.handle = (await store.registerWorld(child.handle, project.id)) as typeof child.handle;

    const worlds = new Map<string, World>([[parentTask.id, parent], [childTask.id, child]]);
    const worldAccess = {
      async open(taskId: string) {
        const world = worlds.get(taskId)!;
        return { world, handle: world.handle, release: async () => {} };
      },
    } as any;
    const secret = 'installation-token-never-written-to-world';
    const credentialEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@github.com:example/',
      KARMAX_TEST_INSTALLATION_TOKEN: secret,
    };
    const githubApp = { brokerCredentials: async () => ({ env: credentialEnv }) } as any;
    const tokens = new TokenAuthority(store);
    const mint = async (taskId: string, caps: string[]) => (await tokens.mint({
      taskId, projectId: project.id, organizationId: organization.id, profileId: 'do', role: 'do',
      principal: `task-agent:${taskId}:do`, ceiling: caps, grantorCaps: caps,
    })).token;
    const parentToken = (await mint(parentTask.id, ['repository:write', 'task:git:publish']));
    const childToken = (await mint(childTask.id, ['task:git:import']));
    const api = new KarmaxApi({
      store, tokens, client: {} as any, taskQueue: 'test', worldAccess, githubApp,
    });

    const attached = await api.attachProjectRepository(parentToken, {
      projectId: project.id, repositoryId: repository.id,
    });
    expect(attached).toMatchObject({
      projectId: project.id, repositoryId: repository.id,
      enrollment: { taskId: parentTask.id, checkouts: ['empty'] },
    });
    const parentRepo = parent.handle.repos!.find((candidate) => candidate.name === 'empty')!;
    expect(fs.existsSync(parentRepo.root)).toBe(true);
    expect(fs.readFileSync(path.join(parentRepo.root, '.git', 'config'), 'utf8')).not.toContain(secret);

    fs.writeFileSync(path.join(parentRepo.root, 'implementation.txt'), 'from parent\n');
    await gitOrThrow(parentRepo.root, ['add', '-A']);
    await gitOrThrow(parentRepo.root, ['commit', '-q', '-m', 'implementation']);
    const published = await api.publishTaskBranch(parentToken);
    expect(published.pushed).toEqual(['first', 'second', 'empty']);
    expect((await git(empty, ['rev-parse', '--verify', `refs/heads/${parent.handle.branch}`])).code).toBe(0);

    // A collaboration publication can be amended before the first PR exists.
    fs.writeFileSync(path.join(parentRepo.root, 'implementation.txt'), 'from parent, amended\n');
    await gitOrThrow(parentRepo.root, ['add', '-A']);
    await gitOrThrow(parentRepo.root, ['commit', '--amend', '--no-edit', '-q']);
    const amendedHead = (await git(parentRepo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    expect((await api.publishTaskBranch(parentToken)).pushed).toEqual(published.pushed);
    expect((await git(empty, ['rev-parse', `refs/heads/${parent.handle.branch}`])).stdout.trim()).toBe(amendedHead);
    expect((await store.eventsOfType(parentTask.id, 'push.head')).at(-1)?.payload.headSha).toBe(amendedHead);

    const imported = await api.importTaskBranch(childToken, parentTask.id);
    expect(imported.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'empty', branch: parent.handle.branch }),
    ]));
    const childRepo = child.handle.repos!.find((candidate) => candidate.name === 'empty')!;
    expect((await git(childRepo.root, ['show', `refs/karmax/tasks/${parentTask.id}/empty:implementation.txt`])).stdout)
      .toContain('from parent');
    expect((await store.eventsSince(parentTask.id, 0)).find((event) => event.type === 'push.branch')?.payload)
      .toMatchObject({ repos: ['first', 'second', 'empty'] });
    (await store.close());
  });

  it('rolls back attachment metadata when a running world cannot be dynamically enrolled', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Enrollment rollback' }));
    const project = (await store.createProject('Flat world', {}, organization.id));
    const repository = (await store.upsertRepository({
      organizationId: organization.id, provider: 'github', providerId: '88', owner: 'example', name: 'new',
      sshUrl: 'git@github.com:example/new.git', defaultBranch: 'main', private: true, gitConnectionId: 'connection',
    }));
    const task = (await store.createTask({
      projectId: project.id, title: 'Running', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'attach it' },
    }));
    const flat = { kind: 'e2b', id: task.id, root: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      repos: [{ name: 'existing', repo: 'git@github.com:example/existing.git', root: '/workspace',
        branch: `karmax/${task.id}`, base: 'main' }] } as any;
    (await store.registerWorld(flat, project.id));
    const world = { handle: flat, exec: async () => ({ code: 1, stdout: '', stderr: '' }) } as any;
    const tokens = new TokenAuthority(store);
    const token = (await tokens.mint({
      taskId: task.id, projectId: project.id, organizationId: organization.id, profileId: 'do', role: 'do',
      principal: `task-agent:${task.id}:do`, ceiling: ['repository:write'], grantorCaps: ['repository:write'],
    })).token;
    const api = new KarmaxApi({
      store, tokens, client: {} as any, taskQueue: 'test', githubApp: { brokerCredentials: async () => ({ env: {} }) } as any,
      worldAccess: { open: async () => ({ world, handle: flat, release: async () => {} }) } as any,
    });
    await expect(api.attachProjectRepository(token, { projectId: project.id, repositoryId: repository.id }))
      .rejects.toThrow(/rolled back.*flat repository layout.*retry the task/i);
    expect((await store.listProjectRepositories(project.id))).toEqual([]);
    (await store.close());
  });
});
