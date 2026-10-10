import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRepoBranches } from '../src/platform/branch-defaults.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { worldRepoTarget } from '../src/world/types.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';

/**
 * Different branches per repo: a multi-repository task (or project default) may
 * give each repository its own base and target — one repository on main, another
 * on master — while a repository whose named base is missing still falls back
 * to its real default branch.
 */
describe('per-repository branches', () => {
  describe('resolution', () => {
    const repos = ['/src/app', '/src/lib'];
    const map = { '/src/app': { base: 'main', target: 'main' }, '/src/lib': { base: 'master', target: 'master' } };

    it('applies an inherited map and sets the common pair to the first repository', () => {
      const resolved: Record<string, unknown> = { base: 'develop', target: 'develop' };
      applyRepoBranches(resolved, [{}, { repoBranches: map }, {}], repos);
      expect(resolved).toEqual({ base: 'main', target: 'main', repoBranches: map });
    });

    it('lets a more specific common base override a less specific map', () => {
      const resolved: Record<string, unknown> = { base: 'feature', target: 'main' };
      applyRepoBranches(resolved, [{ base: 'feature' }, { repoBranches: map }, {}], repos);
      expect(resolved).toEqual({ base: 'feature', target: 'main' });
    });

    it('turns an inherited map off with an empty one', () => {
      const resolved: Record<string, unknown> = { base: 'main', target: 'main', repoBranches: map };
      applyRepoBranches(resolved, [{ repoBranches: {} }, { repoBranches: map }], repos);
      expect(resolved).toEqual({ base: 'main', target: 'main' });
    });

    it('keys the map to the task repositories, dropping removed ones and matching spellings', () => {
      const resolved: Record<string, unknown> = {};
      applyRepoBranches(resolved, [{ repoBranches: {
        'git@github.com:Acme/App.git': { base: 'trunk' }, '/src/gone': { base: 'x' }, '/src/lib/': { target: ' release ' },
      } }], ['https://github.com/acme/app', '/src/lib']);
      expect(resolved).toEqual({ base: 'trunk', repoBranches: {
        'https://github.com/acme/app': { base: 'trunk' }, '/src/lib': { target: 'release' } } });
    });
  });

  describe('tasks and worlds', () => {
    let home: string, app: string, lib: string, content: string, store: Store;
    const commit = async (repo: string, branch: string) => {
      await gitOrThrow(repo, ['init', '-q', '-b', branch]);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'README.md'), `${branch}\n`);
      await gitOrThrow(repo, ['add', '-A']);
      await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
    };
    beforeEach(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-branches-'));
      app = path.join(home, 'app'); lib = path.join(home, 'lib'); content = path.join(home, 'content');
      fs.mkdirSync(app); fs.mkdirSync(lib);
      await commit(app, 'main');
      await commit(lib, 'master');
      store = await Store.create(':memory:');
      await store.claimPersonalOrganization('owner');
    });
    afterEach(async () => {
      await store.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    async function apiFor(projectId: string, organizationId: string) {
      const tokens = new TokenAuthority(store);
      const token = (await tokens.mintPrincipal('user:owner', ['task:*'], projectId, 60_000, organizationId)).token;
      const client = { workflow: {
        start: async (_type: string, options: any) => ({ workflowId: options.workflowId }),
        getHandle: () => ({ executeUpdate: async () => ({ applied: ['target'] }) }),
      } } as any;
      return { token, api: new KarmaxApi({ store, tokens, client, taskQueue: 'test' }) };
    }

    it('persists a project default map when the task is queued and lets a retarget move the shared target', async () => {
      const project = await store.createProject('Mixed branches', { repos: [app, lib] });
      const map = { [app]: { base: 'main', target: 'main' }, [lib]: { base: 'master', target: 'master' } };
      await store.setSettings(project.id, '__common__', { repoBranches: map });
      const { token, api } = await apiFor(project.id, project.organizationId!);

      const task = await api.createTask(token, { projectId: project.id, title: 'Both repos', prompt: 'work' });
      expect((await store.getTask(task.id))?.params).toMatchObject({ base: 'main', target: 'main', repoBranches: map });

      await api.updateParams(token, task.id, { target: 'release' });
      expect((await store.getTask(task.id))?.params).toMatchObject({ target: 'release',
        repoBranches: { [app]: { base: 'main', target: 'release' }, [lib]: { base: 'master', target: 'master' } } });

      // A task that turns the list off uses the common pair everywhere.
      const common = await api.createTask(token, { projectId: project.id, title: 'One branch', prompt: 'work',
        params: { prompt: 'work', repoBranches: {} } });
      expect((await store.getTask(common.id))?.params.repoBranches).toEqual({});
      expect((await store.getTask(common.id))?.params).toMatchObject({ base: 'main', target: 'main' });

      // A draft resolves the map when it is queued, not when it is saved.
      const draft = await api.createTask(token, { projectId: project.id, title: 'Later', prompt: 'work', draft: true });
      expect((await store.getTask(draft.id))?.params.repoBranches).toBeUndefined();
      await api.queueTask(token, draft.id);
      expect((await store.getTask(draft.id))?.params).toMatchObject({ base: 'main', repoBranches: map });
    });

    it('checks each repository out on its own branches, and still falls back from a mislabelled one', async () => {
      const project = await store.createProject('Mixed worlds', { repos: [app, lib] });
      const worlds = new WorldRegistry();
      worlds.register(new WorktreeProvider(path.join(home, 'worlds')));
      const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), contentDir: content });
      const create = async (params: Record<string, unknown>, base: string, target: string) => {
        const task = await store.createTask({ projectId: project.id, title: 'World', workflow: 'software-dev',
          workflowVersion: '1.27.0', params: { prompt: 'x', base, target, _repositoryBranchesResolved: true, ...params } });
        const handle = await core.createWorld({ taskId: task.id, repos: [app, lib], base, target, kind: 'worktree' });
        const development = handle.repos!.filter((repo) => repo.role !== 'project-wiki');
        return { handle, development, destroy: () => worlds.open(handle).then((world) => world.destroy()) };
      };

      // Each repository on its own branches: nothing to correct, no warnings.
      await gitOrThrow(app, ['branch', 'release']);
      const own = await create({ repoBranches: { [app]: { base: 'main', target: 'release' }, [lib]: { base: 'master', target: 'master' } } },
        'main', 'release');
      try {
        expect(own.development.map((repo) => [repo.base, worldRepoTarget(repo, 'next')])).toEqual([['main', 'next'], ['master', 'master']]);
        expect(own.development.map((repo) => repo.branchAdjustment)).toEqual([undefined, undefined]);
        expect(own.handle.warnings ?? []).toEqual([]);
        expect((await git(own.development[1]!.root, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('init');
      } finally { await own.destroy(); }

      // One common branch across a main repository and a master repository:
      // the master repository falls back to its real default, as before.
      const common = await create({}, 'main', 'main');
      try {
        expect(common.development.map((repo) => [repo.base, worldRepoTarget(repo, 'main')])).toEqual([['main', 'main'], ['master', 'master']]);
        expect(common.handle.warnings!.join('\n')).toContain('Base and target branch changed to "master" because "main" did not exist');
      } finally { await common.destroy(); }

      // A per-repository entry that names a branch the repository lacks is
      // corrected the same way, and its target follows its base.
      const mislabelled = await create({ repoBranches: { [app]: { base: 'main', target: 'main' }, [lib]: { base: 'main', target: 'main' } } },
        'main', 'main');
      try {
        expect(mislabelled.development.map((repo) => [repo.base, worldRepoTarget(repo, 'main')])).toEqual([['main', 'main'], ['master', 'master']]);
        expect(mislabelled.handle.warnings!.join('\n')).toContain('Base and target branch changed to "master" because "main" did not exist');
      } finally { await mislabelled.destroy(); }

      // The first repository mislabelled: the task's common pair is corrected
      // to the branch that exists, so views and pull requests agree with it.
      const first = await create({ repoBranches: { [app]: { base: 'master', target: 'master' }, [lib]: { base: 'master', target: 'master' } } },
        'master', 'master');
      try {
        expect(first.development.map((repo) => repo.base)).toEqual(['main', 'master']);
        expect(first.handle).toMatchObject({ base: 'main', target: 'main' });
      } finally { await first.destroy(); }
    });

    it('hands a cloud world each repository\'s branches, pinning only a target of its own', async () => {
      const appUrl = 'git@github.com:acme/app.git', libUrl = 'git@github.com:acme/lib.git', wikiUrl = 'git@github.com:acme/wiki.git';
      const project = await store.createProject('Cloud mix', { repos: [appUrl, libUrl], worldProvider: 'fake-cloud', remote: 'pr' });
      const connection = await store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
        installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
      for (const [name, sshUrl, defaultBranch] of [['app', appUrl, 'main'], ['lib', libUrl, 'master']] as const) {
        const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: name,
          owner: 'acme', name, sshUrl, defaultBranch, private: true, gitConnectionId: connection.id });
        await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
      }
      const wiki = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', owner: 'acme',
        name: 'wiki', sshUrl: wikiUrl, defaultBranch: 'main', private: true });
      await store.setProjectWikiRepository(project.id, wiki.id);
      await gitOrThrow(ensureProjectWikiRepository(content, project.id), ['remote', 'add', 'origin', wikiUrl]);
      let received: any;
      const worlds = new WorldRegistry();
      worlds.register({ kind: 'fake-cloud', capabilities: { remote: true },
        async create(spec: any) {
          received = spec;
          return { handle: { kind: 'fake-cloud', id: spec.taskId, root: '/workspace', branch: `tavya/${spec.taskId}`, base: spec.base,
            repos: spec.repos.map((repo: string, index: number) => ({ name: `r${index}`, repo, root: `/workspace/r${index}`,
              branch: `tavya/${spec.taskId}`, base: spec.repositoryBranches?.[repo]?.base ?? spec.base })) }, async destroy() {} } as any;
        },
        async open() { throw new Error('unused'); }, async destroy() {} } as any);
      const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), contentDir: content,
        githubApp: { async repositoryCloneToken() { return 'token'; } } as any });
      const task = await store.createTask({ projectId: project.id, title: 'Cloud', workflow: 'software-dev', workflowVersion: '1.27.0',
        params: { prompt: 'x', base: 'main', target: 'main', _repositoryBranchesResolved: true,
          repoBranches: { [appUrl]: { base: 'main', target: 'main' }, [libUrl]: { base: 'master', target: 'master' } } } });
      await core.createWorld({ taskId: task.id, repos: [appUrl, libUrl], base: 'main', target: 'main', kind: 'fake-cloud' });
      expect(received.repositoryBranches).toEqual({ [appUrl]: { base: 'main' }, [libUrl]: { base: 'master', target: 'master' },
        [wikiUrl]: { base: 'main', target: 'main' } });

      // A sub-task stacks on its parent's branch in every repository instead.
      const child = await store.createTask({ projectId: project.id, title: 'Child', workflow: 'software-dev', workflowVersion: '1.27.0',
        parentTaskId: task.id, params: { prompt: 'x', repoBranches: { [libUrl]: { base: 'master' } } } });
      await core.createWorld({ taskId: child.id, repos: [appUrl, libUrl], base: `tavya/${task.id}`, target: `tavya/${task.id}`, kind: 'fake-cloud' });
      expect(received.repositoryBranches[libUrl]).toEqual({ base: `tavya/${task.id}`, target: `tavya/${task.id}` });
    });
  });
});
