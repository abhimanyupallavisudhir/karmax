import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';
import { httpOps } from '../src/platform/mcp.js';
import { MANIFESTS } from '../src/contrib/manifests.js';
// Derived, not hard-coded: the pinned type moves every time a workflow ships a
// new replay version, and a literal here just makes an unrelated PR red.
const bundledVersion = (name: string) => MANIFESTS.find((m) => m.name === name)!.version;

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
    expect(fieldNames).toEqual(expect.arrayContaining(['prompt', 'agent:do', 'base', 'target', 'repos', 'remote']));
    expect(fieldNames).not.toContain('agent:merge');
    expect(fieldNames).not.toContain('gitProfile');
    expect(sd.params.find((f: any) => f.name === 'agent:do').type).toBe('agent');
    expect(sd.params.find((f: any) => f.name === 'agent:do').label).toBe('Agent');
    const mergeOnly = schema.find((s: any) => s.name === 'merge-only');
    expect(mergeOnly.params.find((f: any) => f.type === 'agent')).toMatchObject({ name: 'agent:do', role: 'do', label: 'Agent' });
    expect(mergeOnly.params.some((f: any) => f.name === 'agent:merge')).toBe(false);
    // each workflow serves its own lifecycle stages (drives the pipeline UI)
    expect(sd.stages.map((s: any) => s.key)).toEqual(['setup', 'do', 'pr', 'review', 'merge', 'done']);
    // Hidden workflows still need schemas to edit existing drafts. Visibility in
    // the new-task picker is independent of this endpoint.
    const justDo = schema.find((s: any) => s.name === 'just-do');
    expect(justDo.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prompt', type: 'text', bind: 'prompt' }),
      expect.objectContaining({ name: 'agent:do', type: 'agent' }),
    ]));
    const script = schema.find((s: any) => s.name === 'script-exec');
    expect(script.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'command', type: 'text', required: true }),
    ]));
  });

  it('round-trips global and project settings', async () => {
    await put('/api/settings/global/software-dev', { values: { worldProvider: 'worktree', target: 'main' } });
    expect((await get('/api/settings/global/software-dev')).target).toBe('main');
    await put(`/api/settings/project/${projectId}/software-dev`, { values: { base: 'main', target: 'main', repos: [repo] } });
    const ps = await get(`/api/settings/project/${projectId}/software-dev`);
    expect(ps.base).toBe('main');
    expect(ps.repos).toEqual([repo]);
  });

  it('changes a running task from Software Dev to Goal through the task endpoint', async () => {
    const task = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Switchable',
      workflow: 'software-dev',
      params: { prompt: '@write endpoint-switch.txt :: done\n@review waiting' },
    });
    const review = await poll(task.id, 'review');
    expect(review.workflowSwitchable).toBe(true);
    const changed = await fetch(`${base}/api/tasks/${task.id}/workflow`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ workflow: 'goal' }),
    }).then(J);
    expect(changed.workflow).toBe('goal');
    const done = await poll(task.id, 'done');
    expect(done.workflow).toBe('goal');
    // The searchable mode changes, while replay accounting retains the actual
    // Temporal definition that started this run.
    expect((await h.store.getTask(task.id))).toMatchObject({
      workflow: 'goal',
      executionWorkflow: 'software-dev',
      workflowVersion: bundledVersion('software-dev'),
    });
  });

  it('changes an unqueued draft workflow in place', async () => {
    const draft = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Editable workflow',
      workflow: 'goal',
      draft: true,
      notes: 'keep this note',
      params: { prompt: 'prepare the repository', wikiContext: ['[[proj:SPEC.md]]'] },
    });

    const response = await fetch(`${base}/api/tasks/${draft.id}/workflow`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ workflow: 'software-dev' }),
    });
    expect(response.status).toBe(200);
    const changed = await J(response);
    expect(changed).toMatchObject({
      workflow: 'software-dev',
      task: {
        id: draft.id,
        workflow: 'software-dev',
        executionWorkflow: 'software-dev',
        params: { draft: true, prompt: 'prepare the repository', wikiContext: ['[[proj:SPEC.md]]'] },
        notes: 'keep this note',
      },
    });
    expect(changed.task.lastView).toBeFalsy();
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

  it('resets an autosaved partial review route to the inherited confirmer', async () => {
    const draft = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Reset review route',
      workflow: 'software-dev',
      draft: true,
      params: {
        prompt: '@review route reset',
        confirm: { layers: [{ kind: 'human', audience: ['@'] }] },
      },
    });
    expect((await get(`/api/tasks/${draft.id}/attempts`)).confirmer).toEqual({
      layers: [{ kind: 'human', audience: ['@'] }],
    });

    // Reset-to-default makes the browser's replacement payload sparse: confirm is
    // absent, rather than explicitly containing @creator.
    const reset = await fetch(`${base}/api/tasks/${draft.id}/params`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ params: { prompt: '@review route reset' }, replace: true }),
    });
    expect(reset.status).toBe(200);
    expect((await get(`/api/tasks/${draft.id}/attempts`)).confirmer).toEqual({
      layers: [{ kind: 'human', audience: ['@creator'] }],
    });

    const queued = await fetch(`${base}/api/tasks/${draft.id}/queue`, {
      method: 'POST', headers: auth(), body: '{}',
    });
    expect(queued.status).toBe(200);
    await poll(draft.id, 'review');
    await post(`/api/tasks/${draft.id}/signal`, { signal: 'confirm' });
    await poll(draft.id, 'done');
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

  it('archives any task regardless of status (hidden by default, shown on demand) — including a live one', async () => {
    const task = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Archive me',
      workflow: 'software-dev',
      params: { prompt: '@write arch.txt :: x\n@review ready' },
    });
    const atReview = await poll(task.id, 'review'); // awaiting review → status waiting
    expect(atReview.status).toBe('waiting');
    // Add a sibling Draft and archive through that non-principal attempt. Archive
    // belongs to the logical task: the projected principal and every sibling must
    // move together or the task appears in the wrong list section.
    const draftAttempt = await post(`/api/tasks/${task.id}/attempts`, {});
    const liveArchive = await fetch(`${base}/api/tasks/${draftAttempt.id}/archive`, { method: 'POST', headers: auth(), body: JSON.stringify({ archived: true }) });
    expect(liveArchive.status).toBe(200);
    // hidden from the default list while still live
    const hiddenWhileLive = await get(`/api/projects/${projectId}/tasks`);
    expect(hiddenWhileLive.find((t: any) => t.id === task.id)).toBeUndefined();
    const archivedWhileLive = await get(`/api/projects/${projectId}/tasks?includeArchived=1`);
    expect(archivedWhileLive.find((t: any) => t.id === task.id)?.params.archived).toBe(true);
    const activeSearch = await get(`/api/projects/${projectId}/search?q=${encodeURIComponent('-is:archived')}`);
    expect(activeSearch.tasks.find((t: any) => t.id === task.id)).toBeUndefined();
    const archivedSearch = await get(`/api/projects/${projectId}/search?q=${encodeURIComponent('is:archived')}`);
    expect(archivedSearch.tasks.find((t: any) => t.id === task.id)?.params.archived).toBe(true);
    expect((await get(`/api/tasks/${task.id}/attempts`)).attempts.every((attempt: any) => attempt.params.archived === true)).toBe(true);
    // un-archive so we can finish it, then archive the finished task
    await fetch(`${base}/api/tasks/${task.id}/archive`, { method: 'POST', headers: auth(), body: JSON.stringify({ archived: false }) });
    // A sibling now requires the explicit Keep/Cancel choice. Check the HTTP
    // boundary instead of silently ignoring an error and timing out at Done.
    const missingChoice = await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }),
    });
    expect(missingChoice.status).toBe(400);
    expect((await J(missingChoice)).error).toMatch(/keep or cancel/i);
    expect((await get(`/api/tasks/${task.id}`)).stage).toBe('review');
    const confirmed = await post(`/api/tasks/${task.id}/signal`, { signal: 'confirm', otherAttempts: 'cancel' });
    expect(confirmed).toMatchObject({ ok: true });
    await poll(task.id, 'done');
    expect((await get(`/api/tasks/${task.id}/attempts`)).attempts
      .find((attempt: any) => attempt.id === draftAttempt.id)?.lastView?.status).toBe('cancelled');
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

  // Helper: run a source task to done and return it + its stored sessions.
  const runSource = async (title: string, agent?: { provider: 'mock'; model?: string; effort?: 'low' | 'medium' | 'high' }) => {
    const a = await post(`/api/projects/${projectId}/tasks`, {
      title,
      workflow: 'software-dev',
      params: { prompt: '@write a.txt :: a\n@review a', ...(agent ? { 'agent:do': agent } : {}) },
    });
    await poll(a.id, 'review');
    await post(`/api/tasks/${a.id}/signal`, { signal: 'confirm' });
    await poll(a.id, 'done');
    return { a, sessions: await get(`/api/tasks/${a.id}/sessions`) };
  };

  it('FORKS a prior agent session via the agent field, without mutating the source (SPEC §10.5)', async () => {
    const { a, sessions: aBefore } = await runSource('Fork source A', { provider: 'mock', model: 'source-model', effort: 'high' });
    expect(aBefore.do?.id).toBeTruthy(); // A stored a do-session
    // The picker receives the source agent's effective parameters, so choosing
    // this row can prefill the expanded form without guessing from current defaults.
    expect(aBefore.do).toMatchObject({ provider: 'mock', model: 'source-model', effort: 'high' });

    const b = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Fork B',
      workflow: 'software-dev',
      params: { prompt: '@write b.txt :: b\n@review b', 'agent:do': { provider: 'mock', resumeFrom: { taskId: a.id } } },
    });
    await poll(b.id, 'review');
    const events = await get(`/api/tasks/${b.id}/events?since=0`);
    // FORK, not continue: B replays A's conversation into a FRESH session.
    expect(events.some((e: any) => e.type === 'session.forked')).toBe(true);
    expect(events.some((e: any) => e.type === 'session.resumed')).toBe(false);
    expect(events.find((e: any) => e.type === 'session.forked').payload.replayed).toBeGreaterThan(0);
    // Source is untouched: A's stored session is unchanged; B has its own, independent one.
    expect(await get(`/api/tasks/${a.id}/sessions`)).toEqual(aBefore);
    expect((await get(`/api/tasks/${b.id}/sessions`)).do?.id).not.toBe(aBefore.do?.id);
    await post(`/api/tasks/${b.id}/signal`, { signal: 'confirm' });
    await poll(b.id, 'done');
  });

  it('lets MULTIPLE tasks fork the same source independently (no shared-session collision)', async () => {
    const { a, sessions: aBefore } = await runSource('Multi-fork source');
    const mk = (n: string) =>
      post(`/api/projects/${projectId}/tasks`, {
        title: `Resumer ${n}`,
        workflow: 'software-dev',
        params: { prompt: `@write ${n}.txt :: ${n}\n@review ${n}`, 'agent:do': { provider: 'mock', resumeFrom: { taskId: a.id } } },
      });
    const [b, c] = await Promise.all([mk('b'), mk('c')]);
    await Promise.all([poll(b.id, 'review'), poll(c.id, 'review')]);
    for (const t of [b, c]) {
      const ev = await get(`/api/tasks/${t.id}/events?since=0`);
      expect(ev.some((e: any) => e.type === 'session.forked')).toBe(true);
    }
    // Both forked; the source is still untouched after two concurrent resumes.
    expect(await get(`/api/tasks/${a.id}/sessions`)).toEqual(aBefore);
    await Promise.all([post(`/api/tasks/${b.id}/signal`, { signal: 'confirm' }), post(`/api/tasks/${c.id}/signal`, { signal: 'confirm' })]);
    await Promise.all([poll(b.id, 'done'), poll(c.id, 'done')]);
  });

  it('lets the dedicated fork-agent endpoint choose a new agent and retains its source', async () => {
    const { a } = await runSource('Tool fork source', { provider: 'mock', model: 'source-model', effort: 'high' });
    const forked = await post(`/api/tasks/${a.id}/fork-agent`, {
      role: 'do', title: 'Tool fork destination', message: '@write tool-fork.txt :: done\n@review tool fork',
      provider: 'mock', model: 'destination-model', effort: 'low',
    });
    await poll(forked.id, 'review');
    expect((await h.store.getTask(forked.id))?.params['agent:do']).toMatchObject({
      provider: 'mock', model: 'destination-model', effort: 'low', resumeFrom: { taskId: a.id, role: 'do' },
    });
    const events = await get(`/api/tasks/${forked.id}/events?since=0`);
    expect(events.some((event: any) => event.type === 'session.forked')).toBe(true);
    await post(`/api/tasks/${forked.id}/signal`, { signal: 'confirm' });
    await poll(forked.id, 'done');

    // Omitting destination overrides must still preserve resumeFrom while the
    // unified-agent defaults are materialized.
    const inherited = await post(`/api/tasks/${a.id}/fork-agent`, {
      role: 'do', title: 'Tool fork defaults', message: '@write tool-fork-defaults.txt :: done\n@review tool fork defaults',
    });
    await poll(inherited.id, 'review');
    expect((await h.store.getTask(inherited.id))?.params['agent:do']).toMatchObject({
      resumeFrom: { taskId: a.id, role: 'do' },
    });
    await post(`/api/tasks/${inherited.id}/signal`, { signal: 'confirm' });
    await poll(inherited.id, 'done');
  });

  it('CONTINUES (not forks) when a host-local install receives a raw session id', async () => {
    const b = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Raw resume',
      workflow: 'software-dev',
      params: { prompt: '@write r.txt :: r\n@review r', 'agent:do': { provider: 'mock', resumeFrom: { sessionId: 'sess-explicit-123' } } },
    });
    await poll(b.id, 'review');
    const events = await get(`/api/tasks/${b.id}/events?since=0`);
    expect(events.some((e: any) => e.type === 'session.resumed')).toBe(true);
    expect(events.some((e: any) => e.type === 'session.forked')).toBe(false);
    await post(`/api/tasks/${b.id}/signal`, { signal: 'confirm' });
    await poll(b.id, 'done');
  });

  it('rejects raw provider session ids when the console is not host-local', async () => {
    const previous = process.env.KARMAX_HOST_LOCAL;
    process.env.KARMAX_HOST_LOCAL = '0';
    let response: Response;
    try {
      response = await fetch(`${base}/api/projects/${projectId}/tasks`, {
        method: 'POST', headers: auth(), body: JSON.stringify({
          title: 'Remote raw resume',
          workflow: 'software-dev',
          params: { prompt: 'Do not create this task', 'agent:do': { provider: 'mock', resumeFrom: { sessionId: 'sess-explicit-123' } } },
        }),
      });
    } finally {
      if (previous === undefined) delete process.env.KARMAX_HOST_LOCAL;
      else process.env.KARMAX_HOST_LOCAL = previous;
    }
    expect(response.status).toBe(400);
    expect((await J(response)).error).toContain('only on a host-local Karmax');
  });
});
