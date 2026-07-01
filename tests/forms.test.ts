import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';
import { httpOps } from '../src/platform/mcp.js';

describe('task forms, drafts, settings, agent resume (end-to-end)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  let projectId: string;
  let repo: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const J = (r: Response) => r.json() as Promise<any>;
  const get = (p: string) => fetch(`${base}${p}`, { headers: auth() }).then(J);
  const post = (p: string, body: any) => fetch(`${base}${p}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then(J);
  const put = (p: string, body: any) => fetch(`${base}${p}`, { method: 'PUT', headers: auth(), body: JSON.stringify(body) }).then(J);
  const poll = async (id: string, stage: string) => {
    for (let i = 0; i < 60; i++) {
      const v = await get(`/api/tasks/${id}`);
      if (v?.stage === stage) return v;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`task ${id} never reached ${stage}`);
  };

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
    repo = await h.makeRepo('forms');
    const project = await post('/api/projects', { name: 'Forms', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
    projectId = project.id;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('serves the parameter schema for each workflow', async () => {
    const schema = await get('/api/schema');
    const sd = schema.find((s: any) => s.name === 'software-dev');
    expect(sd).toBeTruthy();
    const fieldNames = sd.params.map((f: any) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(['prompt', 'agent:do', 'base', 'target', 'repos', 'openGithubPr']));
    expect(sd.params.find((f: any) => f.name === 'agent:do').type).toBe('agent');
    // each workflow serves its own lifecycle stages (drives the pipeline UI)
    expect(sd.stages.map((s: any) => s.key)).toEqual(['setup', 'do', 'review', 'pr', 'merge', 'done']);
    expect(schema.find((s: any) => s.name === 'just-do').stages.map((s: any) => s.key)).toEqual(['setup', 'do', 'review', 'done']);
  });

  it('round-trips global and project settings', async () => {
    await put('/api/settings/global/software-dev', { values: { worldProvider: 'worktree', target: 'main' } });
    expect((await get('/api/settings/global/software-dev')).target).toBe('main');
    await put(`/api/settings/project/${projectId}/software-dev`, { values: { base: 'main', target: 'main', repos: [repo] } });
    const ps = await get(`/api/settings/project/${projectId}/software-dev`);
    expect(ps.base).toBe('main');
    expect(ps.repos).toEqual([repo]);
  });

  it('saves a draft (not queued), then queues it to completion', async () => {
    const draft = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Draft task',
      workflow: 'software-dev',
      draft: true,
      params: { prompt: '@write draft.txt :: from a draft\n@review draft done' },
    });
    expect(draft.id).toMatch(/^task_/);
    // it appears in the list flagged as a draft, and no workflow is running
    const tasks = await get(`/api/projects/${projectId}/tasks`);
    const found = tasks.find((t: any) => t.id === draft.id);
    expect(found.params.draft).toBe(true);
    expect(found.lastView).toBeFalsy(); // never started

    // queue it → workflow starts
    await post(`/api/tasks/${draft.id}/queue`, {});
    await poll(draft.id, 'review');
    await post(`/api/tasks/${draft.id}/signal`, { signal: 'confirm' });
    await poll(draft.id, 'done');
    const onMain = await git(repo, ['show', 'main:draft.txt']);
    expect(onMain.stdout).toContain('from a draft');
  });

  it('hard-deletes a draft (it stays gone on reload) but refuses to delete a running task', async () => {
    const draft = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Disposable draft',
      workflow: 'software-dev',
      draft: true,
      params: { prompt: 'never queued' },
    });
    const del = await fetch(`${base}/api/tasks/${draft.id}`, { method: 'DELETE', headers: auth() });
    expect(del.status).toBe(200);
    // gone from the listing — not a soft flag that reappears
    const tasks = await get(`/api/projects/${projectId}/tasks`);
    expect(tasks.find((t: any) => t.id === draft.id)).toBeUndefined();

    // a queued (running/terminal) task cannot be hard-deleted via this route
    const live = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Live one',
      workflow: 'software-dev',
      params: { prompt: '@write x.txt :: y\n@review ok' },
    });
    const bad = await fetch(`${base}/api/tasks/${live.id}`, { method: 'DELETE', headers: auth() });
    expect(bad.status).toBe(400);
  });

  it('archives terminal tasks (hidden by default, shown on demand) and refuses to archive a running one', async () => {
    const task = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Archive me',
      workflow: 'software-dev',
      params: { prompt: '@write arch.txt :: x\n@review ready' },
    });
    const atReview = await poll(task.id, 'review'); // awaiting review → status waiting
    expect(atReview.status).toBe('waiting');
    // refuse to archive while live (running or awaiting review)
    const refused = await fetch(`${base}/api/tasks/${task.id}/archive`, { method: 'POST', headers: auth(), body: JSON.stringify({ archived: true }) });
    expect(refused.status).toBe(400);

    // finish it, then archive
    await post(`/api/tasks/${task.id}/signal`, { signal: 'confirm' });
    await poll(task.id, 'done');
    const ok = await fetch(`${base}/api/tasks/${task.id}/archive`, { method: 'POST', headers: auth(), body: JSON.stringify({ archived: true }) });
    expect(ok.status).toBe(200);

    // excluded from the default list, present with includeArchived=1
    const def = await get(`/api/projects/${projectId}/tasks`);
    expect(def.find((t: any) => t.id === task.id)).toBeUndefined();
    const withArch = await get(`/api/projects/${projectId}/tasks?includeArchived=1`);
    expect(withArch.find((t: any) => t.id === task.id)?.params.archived).toBe(true);

    // unarchive brings it back
    await fetch(`${base}/api/tasks/${task.id}/archive`, { method: 'POST', headers: auth(), body: JSON.stringify({ archived: false }) });
    const back = await get(`/api/projects/${projectId}/tasks`);
    expect(back.find((t: any) => t.id === task.id)).toBeTruthy();
  });

  it('the platform MCP (httpOps) drives the gateway with a scoped token (SPEC §3.4, task #4)', async () => {
    // This is exactly what the stdio MCP subprocess does for a CLI agent.
    const ops = httpOps(base, token);
    const created = await ops.createTask({ projectId, title: 'via MCP', prompt: 'noop', workflow: 'software-dev' });
    expect(created.id).toMatch(/^task_/);
    const list = await ops.listTasks(projectId);
    expect(list.some((t) => t.id === created.id)).toBe(true);
    const view: any = await ops.getTask(created.id);
    expect(view?.taskId ?? view?.workflow).toBeTruthy();
    await ops.signalTask(created.id, 'cancel'); // clean up the started workflow
  });

  it('paginates the task list with limit/offset', async () => {
    const page = await get(`/api/projects/${projectId}/tasks?limit=2&offset=0`);
    expect(Array.isArray(page.tasks)).toBe(true);
    expect(page.tasks.length).toBeLessThanOrEqual(2);
    expect(typeof page.total).toBe('number');
    expect(page.total).toBeGreaterThanOrEqual(page.tasks.length);
  });

  it('resumes a prior agent session via the agent field', async () => {
    // task A runs and stores its session
    const a = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Session A',
      workflow: 'software-dev',
      params: { prompt: '@write a.txt :: a\n@review a' },
    });
    await poll(a.id, 'review');
    await post(`/api/tasks/${a.id}/signal`, { signal: 'confirm' });
    await poll(a.id, 'done');

    // task B resumes A's do-session via the agent field
    const b = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Session B',
      workflow: 'software-dev',
      params: { prompt: '@write b.txt :: b\n@review b', 'agent:do': { provider: 'mock', resumeFrom: { taskId: a.id } } },
    });
    await poll(b.id, 'review');
    const events = await get(`/api/tasks/${b.id}/events?since=0`);
    expect(events.some((e: any) => e.type === 'session.resumed')).toBe(true);
    await post(`/api/tasks/${b.id}/signal`, { signal: 'confirm' });
    await poll(b.id, 'done');
  });
});
