import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { Store } from '../src/store/db.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { manifest } from '../src/contrib/manifests.js';
import { stubGateway } from './helpers/stub-gateway.js';
import {
  assertRepoBranches, completeRepoBranch, repoBranchRows, resolveRepoBranches,
} from '../src/platform/repo-branches.js';

const common = { base: 'main', target: 'main' };

describe('per-repository branches (pure resolution)', () => {
  it('completes partial entries: a blank target follows the entry base, a blank base the first repository', () => {
    expect(completeRepoBranch({ base: 'master' }, common)).toEqual({ base: 'master', target: 'master' });
    expect(completeRepoBranch({ target: 'release' }, common)).toEqual({ base: 'main', target: 'release' });
    expect(completeRepoBranch({}, { base: 'dev', target: 'main' })).toEqual({ base: 'dev', target: 'main' });
  });

  it('keeps only non-primary repositories that differ, keyed as the project lists them', () => {
    const repos = ['git@github.com:acme/app.git', 'git@github.com:acme/lib.git', 'git@github.com:acme/docs.git'];
    expect(resolveRepoBranches({
      'git@github.com:acme/app.git': { base: 'trunk' }, // the first repository uses base/target
      'https://github.com/Acme/lib': { base: 'master' }, // another spelling of the same repository
      'git@github.com:acme/docs.git': { base: 'main', target: 'main' }, // same as the common pair
      'git@github.com:acme/gone.git': { base: 'x' }, // no longer in the project
    }, repos, common)).toEqual({ 'git@github.com:acme/lib.git': { base: 'master', target: 'master' } });
    expect(resolveRepoBranches({}, repos, common)).toEqual({});
  });

  it('lists every repository for forms, the first being the common pair', () => {
    expect(repoBranchRows(['/a', '/b', '/c'], common, { '/b': { base: 'master', target: 'master' } })).toEqual({
      '/a': common, '/b': { base: 'master', target: 'master' }, '/c': common,
    });
  });

  it('refuses malformed values and unsafe branch names', () => {
    expect(() => assertRepoBranches({ '/a': { base: 'master' } })).not.toThrow();
    expect(() => assertRepoBranches(['master'])).toThrow(/must map/);
    expect(() => assertRepoBranches({ '/a': 'master' })).toThrow(/must be/);
    expect(() => assertRepoBranches({ '/a': { base: '-D' } })).toThrow(/invalid base/);
  });

  it('is a task and project field of the coding workflows, never organization-wide', () => {
    for (const name of ['software-dev', 'goal']) {
      const field = manifest(name)!.params.find((f) => f.name === 'repoBranches');
      expect(field).toMatchObject({ type: 'repoBranches', scopes: ['task', 'project'] });
    }
  });
});

describe('per-repository branches (tasks and worlds)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  async function repo(name: string, branch: string, extra: string[] = []): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-rb-${name}-`)); dirs.push(root);
    await gitOrThrow(root, ['init', '-q', '-b', branch]);
    await ensureIdentity(root);
    fs.writeFileSync(path.join(root, 'README.md'), `${name}\n`);
    await gitOrThrow(root, ['add', '-A']);
    await gitOrThrow(root, ['commit', '-q', '-m', 'init']);
    for (const other of extra) await gitOrThrow(root, ['branch', other]);
    return root;
  }

  async function setup(repos: string[], projectSettings?: Record<string, unknown>) {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('owner'));
    const project = (await store.createProject('Mixed branches', { repos }));
    if (projectSettings) (await store.setSettings(project.id, '__common__', projectSettings));
    const tokens = new TokenAuthority(store);
    const token = (await tokens.mintPrincipal('user:owner', ['task:*'], project.id, 60_000, project.organizationId)).token;
    const started: any[] = [];
    const client = { workflow: {
      start: async (_type: string, options: any) => { started.push(options.args[0]); return { workflowId: options.workflowId }; },
      getHandle: () => ({ executeUpdate: async () => ({ applied: [] }) }),
    } } as any;
    return { store, project, token, started, api: new KarmaxApi({ store, tokens, client, taskQueue: 'test' }) };
  }

  it('gives each repository its own default branch when nobody chose one (main + master)', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'master');
    const { store, project, token, api, started } = await setup([app, lib]);
    try {
      const task = await api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: { prompt: 'work' } });
      expect(task.params).toMatchObject({ base: 'main', target: 'main', repoBranches: { [lib]: { base: 'master', target: 'master' } } });
      expect(started[0].repoBranches).toEqual({ [lib]: { base: 'master', target: 'master' } });
    } finally { (await store.close()); }
  });

  it('stores no per-repository branches when every repository shares them', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'main');
    const { store, project, token, api } = await setup([app, lib]);
    try {
      const task = await api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: { prompt: 'work' } });
      expect(task.params.repoBranches).toBeUndefined();
    } finally { (await store.close()); }
  });

  it('an explicit common branch applies everywhere unless a repository has its own', async () => {
    const app = await repo('app', 'main', ['develop']);
    const lib = await repo('lib', 'master', ['develop']);
    const { store, project, token, api } = await setup([app, lib]);
    try {
      const common = await api.createTask(token, { projectId: project.id, workflow: 'software-dev',
        params: { prompt: 'work', base: 'develop', target: 'develop' } });
      expect(common.params.repoBranches).toBeUndefined();
      // Explicit "same everywhere" overrides detection.
      const same = await api.createTask(token, { projectId: project.id, workflow: 'software-dev',
        params: { prompt: 'work', repoBranches: {} } });
      expect(same.params).toMatchObject({ base: 'main', repoBranches: {} });
    } finally { (await store.close()); }
  });

  it('task overrides beat project defaults, which beat detection', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'master', ['release']);
    const { store, project, token, api } = await setup([app, lib], { repoBranches: { [lib]: { base: 'release' } } });
    try {
      const fromProject = await api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: { prompt: 'work' } });
      expect(fromProject.params.repoBranches).toEqual({ [lib]: { base: 'release', target: 'release' } });
      const fromTask = await api.createTask(token, { projectId: project.id, workflow: 'software-dev',
        params: { prompt: 'work', repoBranches: { [lib]: { base: 'master', target: 'release' } } } });
      expect(fromTask.params.repoBranches).toEqual({ [lib]: { base: 'master', target: 'release' } });
      await expect(api.createTask(token, { projectId: project.id, workflow: 'software-dev',
        params: { prompt: 'work', repoBranches: { [lib]: { base: '--upload-pack=x' } } } })).rejects.toThrow(/invalid base/);
    } finally { (await store.close()); }
  });

  it('resolves a draft at queue time against the defaults of that moment', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'master');
    const { store, project, token, api } = await setup([app, lib]);
    try {
      const draft = await api.createTask(token, { projectId: project.id, workflow: 'software-dev', draft: true, params: { prompt: 'work' } });
      expect(draft.params.repoBranches).toBeUndefined();
      await api.queueTask(token, draft.id);
      expect((await store.getTask(draft.id))?.params.repoBranches).toEqual({ [lib]: { base: 'master', target: 'master' } });
    } finally { (await store.close()); }
  });

  it('provisions every checkout from its own branches, keeping the missing-branch fallback per repository', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'master');
    const tool = await repo('tool', 'master');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rb-worlds-')); dirs.push(home);
    const { store, project, token, api } = await setup([app, lib, tool]);
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    try {
      // lib: its own master. tool: no entry, so the first repository's "main",
      // which it lacks: provisioning falls back to its default branch.
      const task = await api.createTask(token, { projectId: project.id, workflow: 'software-dev',
        params: { prompt: 'work', repoBranches: { [lib]: { base: 'master' } } } });
      expect(task.params.repoBranches).toEqual({ [lib]: { base: 'master', target: 'master' } });
      const handle = await core.createWorld({ taskId: task.id, repos: [app, lib, tool], base: 'main', target: 'main', kind: 'worktree' });
      const [appCheckout, libCheckout, toolCheckout] = handle.repos!;
      expect(appCheckout).toMatchObject({ base: 'main', target: 'main' });
      expect(libCheckout).toMatchObject({ base: 'master', target: 'master', targetPinned: true });
      expect(libCheckout!.branchAdjustment).toBeUndefined();
      expect(toolCheckout).toMatchObject({ base: 'master', target: 'master', targetPinned: true });
      expect(handle.warnings?.join('\n')).toContain('Base and target branch changed to "master" because "main" did not exist');
      for (const [index, source] of [app, lib, tool].entries()) {
        const checkout = handle.repos![index]!;
        const head = await git(checkout.root, ['rev-parse', 'HEAD']);
        const base = await git(source, ['rev-parse', checkout.base]);
        expect(head.stdout.trim()).toBe(base.stdout.trim());
      }
      // The task's own base/target describe the first repository and are unchanged.
      expect((await store.getTask(task.id))?.params).toMatchObject({ base: 'main', target: 'main' });
      await worlds.open(handle).then((world) => world.destroy());
    } finally { (await store.close()); }
  });

  it('serves every repository\'s inherited pair to the task form and Task defaults, and validates saved defaults', async () => {
    const app = await repo('app', 'main');
    const lib = await repo('lib', 'master');
    const docs = await repo('docs', 'main');
    const h = await stubGateway();
    try {
      (await h.store.claimPersonalOrganization('owner'));
      const project = (await h.store.createProject('Mixed branches', { repos: [app, lib, docs] }));
      const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
      const call = async (url: string, init: RequestInit = {}) => fetch(`${h.base}${url}`, { ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
      const defaults = async () => (await call(`/api/defaults/${project.id}/software-dev`)).json();
      let d = await defaults();
      const detected = { [app]: { base: 'main', target: 'main' }, [lib]: { base: 'master', target: 'master' }, [docs]: { base: 'main', target: 'main' } };
      expect(d.task.inherited.repoBranches).toEqual(detected);
      expect(Object.keys(d.task.inherited.repoBranches)).toEqual([app, lib, docs]);
      expect(d.project.inherited.repoBranches).toEqual(detected);
      expect(d.global.inherited.repoBranches).toBeUndefined();

      // Saved project defaults reach the task form; an explicit common base replaces detection.
      const saved = await call(`/api/settings/project/${project.id}/__common__`, { method: 'PUT',
        body: JSON.stringify({ values: { base: 'develop', repoBranches: { [docs]: { base: 'gh-pages' } } } }) });
      expect(saved.status).toBe(200);
      d = await defaults();
      expect(d.project.own.repoBranches).toEqual({ [docs]: { base: 'gh-pages' } });
      expect(d.task.inherited.repoBranches).toEqual({ [app]: { base: 'develop', target: 'main' },
        [lib]: { base: 'develop', target: 'main' }, [docs]: { base: 'gh-pages', target: 'gh-pages' } });

      const refused = await call(`/api/settings/project/${project.id}/__common__`, { method: 'PUT',
        body: JSON.stringify({ values: { repoBranches: { [lib]: { base: 'a b' } } } }) });
      expect(refused.status).toBe(400);
    } finally { await h.close(); }
  });
});
