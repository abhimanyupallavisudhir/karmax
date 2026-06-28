import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';

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
