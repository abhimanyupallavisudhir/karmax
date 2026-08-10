import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitOrThrow } from '../src/world/git.js';
import { cloudGitSource, sshSource } from '../src/world/cloud-source.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';

describe('cloud repository source resolution', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it('uses a local repository origin and normalizes GitHub HTTPS to SSH', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cloud-source-')); dirs.push(repo);
    await gitOrThrow(repo, ['init', '-q']);
    await gitOrThrow(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app']);
    await expect(cloudGitSource(repo)).resolves.toEqual({ source: 'git@github.com:acme/app.git', localPath: repo });
  });

  it('accepts direct SSH and converts conventional HTTPS remotes', () => {
    expect(sshSource('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git');
    expect(sshSource('ssh://git@example.com/acme/app.git')).toBe('ssh://git@example.com/acme/app.git');
    expect(sshSource('https://gitlab.com/acme/app.git')).toBe('git@gitlab.com:acme/app.git');
    expect(sshSource('/srv/git/app.git')).toBeUndefined();
  });

  it('explains when a local repository has no network remote', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cloud-source-')); dirs.push(repo);
    await gitOrThrow(repo, ['init', '-q']);
    await expect(cloudGitSource(repo)).rejects.toThrow(/has no git remote/);
  });

  it('uses the connected App for an auto-detected local origin without requiring a project attachment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cloud-local-origin-')); dirs.push(root);
    const app = path.join(root, 'app');
    const content = path.join(root, 'content');
    fs.mkdirSync(app);
    await gitOrThrow(app, ['init', '-q', '-b', 'main']);
    await gitOrThrow(app, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);

    const store = new Store(':memory:');
    store.claimPersonalOrganization('owner');
    const project = store.createProject('Local source', {
      repos: [app], worldProvider: 'fake-cloud', defaultBase: 'main', defaultTarget: 'main', remote: 'pr',
    });
    const task = store.createTask({
      projectId: project.id, title: 'Cloud work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work', _repositoryBranchesResolved: true },
    });

    const connection = store.upsertGitConnection({
      organizationId: project.organizationId!, provider: 'github', installationId: '42',
      accountLogin: 'acme', accountType: 'Organization',
    });
    const appRepository = store.upsertRepository({
      organizationId: project.organizationId!, provider: 'github', providerId: '7',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git',
      defaultBranch: 'master', private: true, gitConnectionId: connection.id,
    });
    store.attachProjectRepository({ projectId: project.id, repositoryId: appRepository.id });

    const wikiUrl = 'git@github.com:acme/project-wiki.git';
    const wiki = store.upsertRepository({
      organizationId: project.organizationId!, provider: 'github', owner: 'acme', name: 'project-wiki',
      sshUrl: wikiUrl, defaultBranch: 'main', private: true,
    });
    store.setProjectWikiRepository(project.id, wiki.id);
    const wikiRoot = ensureProjectWikiRepository(content, project.id);
    await gitOrThrow(wikiRoot, ['remote', 'add', 'origin', wikiUrl]);

    let received: any;
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'fake-cloud',
      capabilities: { remote: true },
      async create(spec: any) {
        received = spec;
        const sources: string[] = spec.repos ?? [spec.repo];
        return {
          handle: {
            kind: 'fake-cloud', id: spec.taskId, root: '/workspace', branch: `karmax/${spec.taskId}`, base: spec.base,
            repos: sources.map((repo, index) => ({
              name: index === 0 ? 'app' : 'project-wiki', repo, localPath: spec.copySources?.[index],
              root: `/workspace/${index === 0 ? 'app' : 'project-wiki'}`,
              branch: `karmax/${spec.taskId}`, base: spec.base,
            })),
          },
          async destroy() {},
        } as any;
      },
      async open() { throw new Error('unused'); },
      async destroy() {},
    } as any);
    const tokenRequests: string[] = [];
    const core = makeCoreActivities({
      store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), contentDir: content,
      githubApp: {
        async repositoryCloneToken(repository: { id: string }) {
          tokenRequests.push(repository.id);
          return repository.id === appRepository.id ? 'app clone token' : 'wiki clone token';
        },
      } as any,
    });

    try {
      const handle = await core.createWorld({
        taskId: task.id, repos: [app], base: 'dev', target: 'dev', kind: 'fake-cloud',
      });
      expect(received.repos).toEqual(['git@github.com:acme/app.git', wikiUrl]);
      expect(received.copySources).toEqual([app, wikiRoot]);
      expect(received.gitCredentials.httpsTokens).toEqual({
        'git@github.com:acme/app.git': 'app clone token',
        [wikiUrl]: 'wiki clone token',
      });
      expect(received.repositoryAuthorities).toEqual({
        'git@github.com:acme/app.git': 'origin',
        [wikiUrl]: 'origin',
      });
      // The catalog's default branch is a fallback, not a hidden override of
      // the task/project branch that the workflow already resolved.
      expect(received.repositoryBranches['git@github.com:acme/app.git']).toBeUndefined();
      expect(received.repositoryBranches[wikiUrl]).toEqual({ base: 'main', target: 'main' });
      expect(tokenRequests).toEqual([appRepository.id, wiki.id]);
      expect(handle.repos?.find((repo) => repo.name === 'app')?.localPath).toBe(app);

      // An execution queued before branch resolution was centralized has no
      // marker; retain the catalog fallback so its historical "main" input does
      // not create or target a phantom branch.
      const legacy = store.createTask({ projectId: project.id, title: 'Legacy cloud work',
        workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'work' } });
      await core.createWorld({ taskId: legacy.id, repos: [app], base: 'main', target: 'main', kind: 'fake-cloud' });
      expect(received.repositoryBranches['git@github.com:acme/app.git'])
        .toEqual({ base: 'master', target: 'master' });

      // A deliberately configured per-repository policy is stronger than the
      // common task/project policy.
      store.attachProjectRepository({ projectId: project.id, repositoryId: appRepository.id,
        baseBranch: 'trunk', targetBranch: 'production' });
      await core.createWorld({ taskId: task.id, repos: [app], base: 'dev', target: 'dev', kind: 'fake-cloud' });
      expect(received.repositoryBranches['git@github.com:acme/app.git'])
        .toEqual({ base: 'trunk', target: 'production' });

      // A child stacks on the parent's task branch in every repository. The
      // top-level per-repository policy must not detach this checkout back onto
      // trunk and silently omit the parent's work.
      const child = store.createTask({ projectId: project.id, title: 'Child cloud work',
        workflow: 'software-dev', workflowVersion: '1.0.0', parentTaskId: task.id,
        params: { prompt: 'continue parent work' } });
      await core.createWorld({ taskId: child.id, repos: [app],
        base: `karmax/${task.id}`, target: `karmax/${task.id}`, kind: 'fake-cloud' });
      expect(received.repositoryBranches['git@github.com:acme/app.git'])
        .toEqual({ base: `karmax/${task.id}`, target: `karmax/${task.id}` });
    } finally {
      store.close();
    }
  });

  it('keys PR authority and clone credentials to local worktree sources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-pr-source-')); dirs.push(root);
    const app = path.join(root, 'app');
    const content = path.join(root, 'content');
    fs.mkdirSync(app);
    await gitOrThrow(app, ['init', '-q', '-b', 'main']);
    await gitOrThrow(app, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);

    const store = new Store(':memory:');
    store.claimPersonalOrganization('owner');
    const project = store.createProject('Local PR source', {
      repos: [app], worldProvider: 'fake-local', defaultBase: 'main', defaultTarget: 'main', remote: 'pr',
    });
    const task = store.createTask({
      projectId: project.id, title: 'Local PR work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' },
    });
    const connection = store.upsertGitConnection({
      organizationId: project.organizationId!, provider: 'github', installationId: '42',
      accountLogin: 'acme', accountType: 'Organization',
    });
    const appRepository = store.upsertRepository({
      organizationId: project.organizationId!, provider: 'github', providerId: '7', owner: 'acme', name: 'app',
      sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true, gitConnectionId: connection.id,
    });
    const wikiUrl = 'git@github.com:acme/project-wiki.git';
    const wiki = store.upsertRepository({
      organizationId: project.organizationId!, provider: 'github', owner: 'acme', name: 'project-wiki',
      sshUrl: wikiUrl, defaultBranch: 'main', private: true,
    });
    store.setProjectWikiRepository(project.id, wiki.id);
    const wikiRoot = ensureProjectWikiRepository(content, project.id);
    await gitOrThrow(wikiRoot, ['remote', 'add', 'origin', wikiUrl]);

    let received: any;
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'fake-local', capabilities: { remote: false },
      async create(spec: any) {
        received = spec;
        const sources: string[] = spec.repos ?? [spec.repo];
        return {
          handle: {
            kind: 'fake-local', id: spec.taskId, root: '/workspace', branch: `karmax/${spec.taskId}`, base: spec.base,
            repos: sources.map((repo, index) => ({
              name: index === 0 ? 'app' : 'project-wiki', repo, root: `/workspace/${index}`,
              branch: `karmax/${spec.taskId}`, base: spec.base,
            })),
          },
          async destroy() {},
        } as any;
      },
      async open() { throw new Error('unused'); },
      async destroy() {},
    } as any);
    const core = makeCoreActivities({
      store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), contentDir: content,
      githubApp: {
        async repositoryCloneToken(repository: { id: string }) {
          return repository.id === appRepository.id ? 'app clone token' : 'wiki clone token';
        },
      } as any,
    });

    try {
      await core.createWorld({ taskId: task.id, repos: [app], base: 'main', target: 'main', kind: 'fake-local' as any });
      expect(received.repos).toEqual([app, wikiRoot]);
      expect(received.repositoryAuthorities).toEqual({ [app]: 'origin', [wikiRoot]: 'origin' });
      expect(received.repositoryOrigins).toEqual({ [app]: 'git@github.com:acme/app.git', [wikiRoot]: wikiUrl });
      expect(received.gitCredentials.httpsTokens).toEqual({
        [app]: 'app clone token',
        [wikiRoot]: 'wiki clone token',
      });
    } finally {
      store.close();
    }
  });
});
