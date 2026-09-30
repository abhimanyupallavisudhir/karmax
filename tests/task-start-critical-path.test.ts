import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';

/**
 * LT-16: starting a task must not wait for work that cannot change whether or
 * how it starts. The GitHub merge preflight is advisory (it only warns), so its
 * live GitHub calls run alongside the start instead of before it.
 */
describe('task start critical path (LT-16)', () => {
  async function fixture(permissionDelayMs: number, canMerge: boolean) {
    const store = await Store.create(':memory:');
    await store.claimPersonalOrganization('creator');
    const project = await store.createProject('Preflight', { remote: 'pr', defaultBase: 'main', defaultTarget: 'main' } as any);
    const connection = await store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'inst', accountLogin: 'acme', accountType: 'Organization' });
    const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: 'repo', owner: 'acme', name: 'widgets', sshUrl: 'git@github.com:acme/widgets.git', defaultBranch: 'main',
      private: true, gitConnectionId: connection.id });
    await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:creator', ['*'], project.id)).token;
    const timeline: string[] = [];
    const client = { workflow: { start: async () => { timeline.push('workflow.start'); } } } as any;
    const githubApp = {
      activeUserAccountId: async () => 'creator-account',
      repositoryPermission: async () => {
        await new Promise((resolve) => setTimeout(resolve, permissionDelayMs));
        timeline.push('github.permission');
        return { slug: 'acme/widgets', permission: canMerge ? 'write' : 'read', canMerge };
      },
    } as any;
    const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test', githubApp });
    return { store, api, token, project, timeline };
  }

  it('starts the workflow without waiting for the advisory GitHub preflight', async () => {
    const f = await fixture(400, false);
    try {
      const task = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'ship it' });
      expect(f.timeline[0]).toBe('workflow.start');
      expect(f.timeline).toContain('github.permission');
      // Still advisory, still reported with the created task and in its log.
      expect((task as any).warnings).toEqual([expect.stringContaining('cannot merge every GitHub repository')]);
      expect((await f.store.eventsOfType(task.id, 'github.merge.preflight-warning'))).toHaveLength(1);
    } finally { await f.store.close(); }
  });

  // #396 review item 10: a hung GitHub made the client time out and retry,
  // which duplicated the task.
  it('returns within a bounded wait when GitHub hangs, and journals the warning when it answers', async () => {
    const f = await fixture(1_500, false); // two sequential permission reads: 3 s
    try {
      const started = Date.now();
      const task = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'ship it' });
      expect(Date.now() - started).toBeLessThan(2_600);
      expect((task as any).warnings).toBeUndefined();
      await vi.waitFor(async () => {
        expect((await f.store.eventsOfType(task.id, 'github.merge.preflight-warning'))).toHaveLength(1);
      }, { timeout: 3_000 });
    } finally { await new Promise((resolve) => setTimeout(resolve, 50)); await f.store.close(); }
  });

  it('never journals a warning for a task whose creation was undone meanwhile', async () => {
    const f = await fixture(2_200, false);
    let answered = false;
    const permission = (f.api as any).deps.githubApp.repositoryPermission;
    (f.api as any).deps.githubApp.repositoryPermission = async (...args: unknown[]) => {
      const result = await permission(...args);
      answered = true;
      return result;
    };
    // The creation is undone just after any read that follows GitHub's answer.
    const getTask = f.store.getTask.bind(f.store);
    let undone = false;
    vi.spyOn(f.store, 'getTask').mockImplementation(async (id: string) => {
      const task = await getTask(id);
      if (answered && !undone && task) { undone = true; await f.store.deleteTask(id); }
      return task;
    });
    try {
      const task = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'ship it' });
      await vi.waitFor(() => { expect(answered).toBe(true); }, { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const warnings = await f.store.eventsOfType(task.id, 'github.merge.preflight-warning');
      const exists = Boolean(await getTask(task.id));
      expect(exists || warnings.length === 0).toBe(true);
    } finally { vi.restoreAllMocks(); await f.store.close(); }
  });

  it('reports no warning when the creator can merge', async () => {
    const f = await fixture(10, true);
    try {
      const task = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'software-dev', prompt: 'ship it' });
      expect((task as any).warnings).toBeUndefined();
      expect((await f.store.eventsOfType(task.id, 'github.merge.preflight-warning'))).toHaveLength(0);
    } finally { await f.store.close(); }
  });
});

describe('gateway task start and the project wiki (LT-16)', () => {
  it('creates a task without re-waiting for a project wiki this gateway already ensured', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { vi } = await import('vitest');
    const { stubGateway } = await import('./helpers/stub-gateway.js');
    const previousHome = process.env.KARMAX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-task-start-'));
    process.env.KARMAX_HOME = home;
    const order: string[] = [];
    const api = { createTask: vi.fn(async (_token: string, args: { projectId: string }) => {
      order.push('createTask');
      return { id: 'task_1', projectId: args.projectId };
    }) };
    const h = await stubGateway({ api: api as any });
    try {
      const project = await h.store.createProject('Docs');
      const unseen = await h.store.createProject('Unseen');
      const token = (await h.tokens.mintPrincipal('user:creator', ['*'])).token;
      const create = (projectId: string) => fetch(`${h.base}/api/projects/${projectId}/tasks`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'just-do', prompt: 'go' }) });
      // The first start ensures the local wiki repository for real.
      expect((await create(project.id)).status).toBe(200);
      expect(fs.existsSync(path.join(home, 'content'))).toBe(true);
      // Later wiki work may queue behind a remote sync in the wiki's Git lane.
      const gateway = h.gateway as any;
      const real = gateway.ensureProjectWiki.bind(gateway);
      vi.spyOn(gateway, 'ensureProjectWiki').mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        order.push(`wiki:${(args[0] as { id: string }).id}`);
        return real(...args);
      });
      order.length = 0;
      expect((await create(project.id)).status).toBe(200);
      expect(order).toEqual(['createTask']);
      await vi.waitFor(() => expect(order).toEqual(['createTask', `wiki:${project.id}`]), { timeout: 2_000 });
      // A project this gateway has not ensured yet still gets its wiki first.
      order.length = 0;
      expect((await create(unseen.id)).status).toBe(200);
      expect(order).toEqual([`wiki:${unseen.id}`, 'createTask']);
    } finally {
      await h.close();
      if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
