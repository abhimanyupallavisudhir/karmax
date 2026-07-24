import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';

describe('gateway HTTP API (real server end-to-end)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    const session: any = await (await fetch(`${base}/api/session`)).json();
    token = session.token;
    expect(session.authRequired).toBe(false);
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('serves meta with the detected agent provider', async () => {
    const meta: any = await (await fetch(`${base}/api/meta`)).json();
    expect(meta.version).toBeTruthy();
    expect(meta.agent.provider).toBeTruthy();
    expect(meta.resolveAgentEnabled).toBe(false);
  });

  it('keeps untrusted preview hosts outside the app/API origin', async () => {
    const previous = process.env.KARMAX_PREVIEW_ORIGIN;
    process.env.KARMAX_PREVIEW_ORIGIN = 'http://preview.invalid';
    try {
      const target = new URL(base);
      const blocked = await new Promise<number>((resolve, reject) => {
        const request = http.request({ hostname: target.hostname, port: target.port, path: '/api/meta',
          headers: { host: 'p-deadbeef.preview.invalid' } }, (response) => {
          response.resume(); resolve(response.statusCode ?? 0);
        });
        request.on('error', reject); request.end();
      });
      expect(blocked).toBe(404);
      const redirected = await fetch(`${base}/preview/lease-1/`, { redirect: 'manual' });
      expect(redirected.status).toBe(307);
      expect(redirected.headers.get('location')).toMatch(/^http:\/\/p-[a-f0-9]{24}\.preview\.invalid\/preview\/lease-1\/$/);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_PREVIEW_ORIGIN;
      else process.env.KARMAX_PREVIEW_ORIGIN = previous;
    }
  });

  it('exposes contributions (slots, commands, event schemas)', async () => {
    const c: any = await (await fetch(`${base}/api/contributions`, { headers: auth() })).json();
    expect(c.commands.find((x: any) => x.id === 'nav.newTask')).toBeTruthy();
    expect(c.slots.some((s: any) => s.contribution.slot === 'task-detail')).toBe(true);
    expect(c.events.some((e: any) => e.type === 'software-dev.merged')).toBe(true);
    expect(c.slots.some((s: any) => s.workflow === 'agent-queue' && s.contribution.slot === 'queue-panel')).toBe(true);
    const platform: any = await (await fetch(`${base}/api/platform`, { headers: auth() })).json();
    expect(platform.conversations).toContain('GET /api/tasks/:taskId/agents');
    expect(platform.administration).toContain('GET|POST /api/users');
  });

  it('persists host capacity and applies it to the agent-queue workflow', async () => {
    const saved = await fetch(`${base}/api/settings/global/agent-queue`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { capacity: 2 } }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/api/settings/global/agent-queue`, { headers: auth() })).json()).toEqual({ capacity: 2 });
    await expect.poll(async () => {
      const q: any = await (await fetch(`${base}/api/agent-queue`, { headers: auth() })).json();
      return q.capacity;
    }, { timeout: 10_000 }).toBe(2);

    const invalid = await fetch(`${base}/api/settings/global/agent-queue`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { capacity: 0 } }),
    });
    expect(invalid.status).toBe(400);
  });

  it('omits the disabled Resolve agent from schemas and profiles', async () => {
    const schemas = (await (await fetch(`${base}/api/schema`, { headers: auth() })).json()) as any[];
    const softwareDev = schemas.find((s) => s.name === 'software-dev');
    expect(softwareDev.params.some((f: any) => f.role === 'resolve' || f.name === 'agent:resolve')).toBe(false);
    expect(softwareDev.stages.some((s: any) => s.key === 'resolve' || s.aliases?.includes('resolve'))).toBe(false);

    const profiles = (await (await fetch(`${base}/api/profiles`, { headers: auth() })).json()) as any[];
    expect(profiles.some((p) => p.role === 'resolve')).toBe(false);

    const rejected = await fetch(`${base}/api/profiles`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ id: 'resolve-default', role: 'resolve', name: 'Resolve agent', provider: 'mock' }),
    });
    expect(rejected.status).toBe(400);

    // Historical session rows may remain in SQLite, but the disabled role must
    // not leak back into the task UI's session payload.
    h.store.kvSet('session:legacy-task:resolve', 'legacy-session');
    const sessions: any = await (await fetch(`${base}/api/tasks/legacy-task/sessions`, { headers: auth() })).json();
    expect(sessions.resolve).toBeUndefined();
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
  });

  it('deletes provider worlds before committing project deletion', async () => {
    const project: any = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Disposable' }) })).json();
    const task = h.store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x', draft: true } });
    const world = await h.worlds.create('memory', { taskId: task.id, base: 'main' });
    await world.writeFile('private.txt', 'private');
    h.store.registerWorld(world.handle, project.id);
    expect(fs.existsSync(world.handle.root)).toBe(true);

    const deleted = await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers: auth() });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(world.handle.root)).toBe(false);
    expect(h.store.getProject(project.id)).toBeUndefined();
    expect(h.store.getTask(task.id)).toBeUndefined();
  });

  it('drives a full task lifecycle over HTTP and lands work', async () => {
    const repo = await h.makeRepo('gw');
    // create a project pointed at the repo
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'GW', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();

    // create a software-dev task
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          title: 'HTTP task',
          prompt: '@write http.txt :: via the gateway\n@review http task done',
          workflow: 'software-dev',
        }),
      })
    ).json();
    expect(task.id).toMatch(/^task_/);

    // poll the view until Review
    let stage = '';
    for (let i = 0; i < 60 && stage !== 'review'; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      stage = v?.stage;
      if (stage !== 'review') await new Promise((r) => setTimeout(r, 250));
    }
    expect(stage).toBe('review');

    // tier-2 declarative widgets resolve against the live view-model (SPEC §10.2)
    const widgets: any = await (await fetch(`${base}/api/tasks/${task.id}/widgets`, { headers: auth() })).json();
    expect(widgets.length).toBeGreaterThan(0);
    const progress = widgets.find((g: any) => g.title === 'Progress');
    expect(progress).toBeTruthy();
    const byType = Object.fromEntries(progress.widgets.map((w: any) => [w.type, w]));
    expect(byType.badge.data).toBe('review'); // bound to view.stage
    expect(byType.gauge.data).toBeTruthy(); // merge-queue gauge
    expect(Array.isArray(byType.list.data)).toBe(true); // bound to changedFiles
    // the conversation thread is intentionally NOT duplicated here — the drawer's
    // (collapsible) conversation floor already shows it (task 1b).
    expect(byType.thread).toBeUndefined();

    // events endpoint returns a live log
    const events: any = await (await fetch(`${base}/api/tasks/${task.id}/events?since=0`, { headers: auth() })).json();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event: any) => event.type === 'agent.activity' && event.payload?.kind === 'file')).toBe(true);
    const reviewView: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(reviewView.messages[0].role).toBe('user');
    expect(reviewView.messages[0].ts).toBeGreaterThan(1_000_000_000_000);

    // confirm → merges
    await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ signal: 'confirm' }),
    });
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (v?.stage === 'done') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const onMain = await git(repo, ['show', 'main:http.txt']);
    expect(onMain.stdout).toContain('via the gateway');

    // The task drawer can race the workflow's final close. Reproduce a stale
    // non-terminal snapshot left behind after the execution has completed.
    await h.client.workflow.getHandle(task.id).result();
    h.store.saveView(task.id, {
      ...h.store.getTask(task.id)!.lastView!,
      stage: 'resolve',
      status: 'waiting',
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }],
    });
    const lateCancel = await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ signal: 'cancel' }),
    });
    expect(lateCancel.status).toBe(200);
    expect(await lateCancel.json()).toEqual({ ok: true });
    expect(h.store.getTask(task.id)!.lastView).toMatchObject({
      stage: 'cancelled',
      status: 'cancelled',
      actions: [],
      state: { cancelled: true },
    });

    // dashboard reflects the project + task
    const dash: any = await (await fetch(`${base}/api/dashboard`, { headers: auth() })).json();
    expect(dash.projects).toBeGreaterThanOrEqual(1);
    expect(dash.tasks).toBeGreaterThanOrEqual(1);
  });

  it('runs a review "run" action in the world and serves an "open" artifact', async () => {
    const repo = await h.makeRepo('gw-actions');
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'GWA', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          title: 'Action task',
          prompt:
            '@write out.txt :: hello-artifact\n' +
            '@runaction print :: cat out.txt && echo DONE_MARKER\n' +
            '@openaction the file :: out.txt\n' +
            '@review verify the output',
          workflow: 'software-dev',
        }),
      })
    ).json();

    // poll to Review
    let view: any;
    for (let i = 0; i < 60; i++) {
      view = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (view?.stage === 'review') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(view.stage).toBe('review');
    // the terse caption + accumulated actions are on the review info
    expect(view.reviewInfo.caption).toContain('verify');
    expect(view.reviewInfo.actions.map((a: any) => a.kind)).toEqual(['run', 'open']);

    // run action (index 0) → executes `cat out.txt && echo DONE_MARKER` in the world
    const started: any = await (
      await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 0 }) })
    ).json();
    expect(started.kind).toBe('run');
    expect(started.procId).toBeTruthy();
    let status: any;
    for (let i = 0; i < 40; i++) {
      status = await (await fetch(`${base}/api/tasks/${task.id}/review-action/${started.procId}`, { headers: auth() })).json();
      if (status && status.running === false) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain('hello-artifact');
    expect(status.output).toContain('DONE_MARKER');

    // open action (index 1) → resolves to an artifact URL served from the world
    const opened: any = await (
      await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 1 }) })
    ).json();
    expect(opened.kind).toBe('open');
    expect(opened.external).toBe(false);
    const artifact = await fetch(`${base}${opened.url}`, { headers: auth() });
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toContain('hello-artifact');

    // a bad index is rejected; artifact traversal is refused
    const bad = await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 99 }) });
    expect(bad.status).toBe(404);
    const escape = await fetch(`${base}/api/tasks/${task.id}/artifact?path=${encodeURIComponent('../../../etc/passwd')}`, { headers: auth() });
    expect(escape.status).toBe(400);
  });

  it('inherits defaults live: drafts store only overrides and re-resolve when queued', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'Inherit', config: {} }),
      })
    ).json();

    // A draft with only a prompt must persist ONLY its own overrides — never a
    // baked snapshot of the resolved defaults (which would freeze inheritance).
    const draft: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'inherit me', workflow: 'software-dev', draft: true }),
      })
    ).json();
    const stored = h.store.getTask(draft.id)!;
    expect(stored.params.prompt).toBe('inherit me');
    expect(stored.params.draft).toBe(true);
    // none of the inheritable defaults should be baked onto the task
    expect(stored.params.worldProvider).toBeUndefined();
    expect(stored.params.openGithubPr).toBeUndefined();
    expect(stored.params.base).toBeUndefined();
    expect((stored.params._authorization as any)?.profileId).toBe('caller');

    // Form replacement cannot erase or forge platform authorization metadata,
    // while the dedicated pre-start endpoint can safely re-attenuate it.
    await fetch(`${base}/api/tasks/${draft.id}/params`, {
      method: 'PATCH', headers: auth(),
      body: JSON.stringify({ replace: true, params: { prompt: 'inherit me edited', _authorization: { profileId: 'forged', capabilities: ['*'] } } }),
    });
    expect((h.store.getTask(draft.id)!.params._authorization as any)?.profileId).toBe('caller');
    await fetch(`${base}/api/tasks/${draft.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ profileId: 'developer' }),
    });
    expect((h.store.getTask(draft.id)!.params._authorization as any)?.profileId).toBe('developer');

    // Changing a project default now flows into the (still unqueued) task's
    // resolved defaults — the /api/defaults task scope reflects it immediately.
    await fetch(`${base}/api/settings/project/${project.id}/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { base: 'develop' } }),
    });
    const defs: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs.task.inherited.base).toBe('develop');

    // A project override, in turn, still inherits from a global default it does
    // not set (here: copyGlobs), proving the full task→project→global chain.
    await fetch(`${base}/api/settings/global/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { copyGlobs: ['.env'] } }),
    });
    const defs2: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs2.task.inherited.copyGlobs).toEqual(['.env']); // global reaches the task through the project
    expect(defs2.task.inherited.base).toBe('develop'); // project override still wins
  });

  it('stores cosmetic human notes on a task and never mixes them into params/prompt', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'Notes', config: {} }),
      })
    ).json();
    const draft: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'do the thing', workflow: 'software-dev', draft: true }),
      })
    ).json();

    // set notes
    const set: any = await (
      await fetch(`${base}/api/tasks/${draft.id}/notes`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ notes: 'ask design about the empty state' }),
      })
    ).json();
    expect(set.ok).toBe(true);

    // notes land on the record, not in params (so they never reach the prompt)
    const stored = h.store.getTask(draft.id)!;
    expect(stored.notes).toBe('ask design about the empty state');
    expect(stored.params.notes).toBeUndefined();
    expect(stored.params.prompt).toBe('do the thing');

    // the task list surfaces notes for the UI (drafts are edited via the form,
    // which reads the record — the view-mirroring is covered by the terminal test)
    const list: any = await (await fetch(`${base}/api/projects/${project.id}/tasks?includeArchived=1`, { headers: auth() })).json();
    expect(list.find((t: any) => t.id === draft.id)?.notes).toBe('ask design about the empty state');

    // clearing removes them
    await fetch(`${base}/api/tasks/${draft.id}/notes`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ notes: '' }) });
    expect(h.store.getTask(draft.id)!.notes).toBeUndefined();
  });

  it('accepts notes on the create-task form and keeps them off params/prompt', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'FormNotes', config: {} }),
      })
    ).json();
    // The full task form (the "…More" surface) POSTs notes alongside params.
    const created: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ params: { prompt: 'build the thing' }, notes: 'reminder from the form', workflow: 'software-dev', draft: true }),
      })
    ).json();

    // notes are returned on the created record and persisted off params
    expect(created.notes).toBe('reminder from the form');
    const stored = h.store.getTask(created.id)!;
    expect(stored.notes).toBe('reminder from the form');
    expect(stored.params.notes).toBeUndefined();
    expect(stored.params.prompt).toBe('build the thing');
  });

  it('allows editing notes on a task at any stage — including after it is done', async () => {
    const repo = await h.makeRepo('notes-terminal');
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'NotesTerminal', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ title: 'Terminal notes', prompt: '@write t.txt :: hi\n@review done', workflow: 'software-dev' }),
      })
    ).json();
    // drive it to Review, then confirm to a terminal (done) stage
    let stage = '';
    for (let i = 0; i < 60 && stage !== 'review'; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      stage = v?.stage;
      if (stage !== 'review') await new Promise((r) => setTimeout(r, 250));
    }
    await fetch(`${base}/api/tasks/${task.id}/signal`, { method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }) });
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (['done', 'merge', 'pr'].includes(v?.stage) || v?.status === 'done') { stage = v.stage; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    // editing notes must still succeed on the finished task
    const res = await fetch(`${base}/api/tasks/${task.id}/notes`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ notes: 'post-mortem: shipped' }),
    });
    expect(res.status).toBe(200);
    expect(h.store.getTask(task.id)!.notes).toBe('post-mortem: shipped');
    // and the live view mirrors them, so the drawer renders the current value
    const view: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(view.notes).toBe('post-mortem: shipped');
  });

  it('a newly created project inherits the global branch default (no baked "main" override)', async () => {
    // Set a global branch default that differs from the field default ("main").
    await fetch(`${base}/api/settings/global/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { base: 'master', target: 'master' } }),
    });
    // Create a project exactly the way the New Project UI now does: empty config.
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'FreshProject', config: {} }),
      })
    ).json();
    // The project must NOT have baked a defaultBase/defaultTarget of its own.
    expect(project.config.defaultBase).toBeUndefined();
    expect(project.config.defaultTarget).toBeUndefined();

    // Resolved defaults at the task scope must reflect the GLOBAL value, not "main".
    const defs: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs.task.inherited.base).toBe('master');
    expect(defs.task.inherited.target).toBe('master');
    // And the project scope owns nothing for base/target (it purely inherits).
    expect(defs.project.own.base).toBeUndefined();
    expect(defs.project.own.target).toBeUndefined();

    // A task created in this project resolves its branches to the global default too.
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'inherit branch', workflow: 'software-dev', draft: true }),
      })
    ).json();
    // Stored sparsely — no baked branch override.
    expect(h.store.getTask(task.id)!.params.base).toBeUndefined();
    expect(h.store.getTask(task.id)!.params.target).toBeUndefined();
  });

  it('connects an account login and lists it without leaking the config-home path', async () => {
    const r: any = await (
      await fetch(`${base}/api/accounts/connect`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ provider: 'claude', account: 'work', browserMcp: 'chrome-devtools' }),
      })
    ).json();
    expect(r.status).toBe('awaiting_oauth');
    expect(r.loginUrl).toBe('https://example.com/dev?code=TEST');
    expect(r.configHome).toBeUndefined(); // absolute path never crosses the wire

    const accounts: any = await (await fetch(`${base}/api/accounts`, { headers: auth() })).json();
    const login = accounts.logins.find((l: any) => l.provider === 'claude' && l.account === 'work');
    expect(login).toBeTruthy();
    expect(login.path).toBeUndefined(); // listing also hides the path
    expect(typeof login.loggedIn).toBe('boolean');
  });

  it('seeds a brand-new project with the karmax-ready prep task', async () => {
    // A new project's tasks default to software-dev, so creation spawns that
    // workflow's onActivate prep task automatically (SPEC §4.6) — no manual
    // "activate workflow" step. Covers both create-project routes.
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then((r) => r.json());
    const prepTitle = 'Make this project karmax-ready';
    for (const path of ['/api/organizations/org_personal/projects', '/api/projects']) {
      const project: any = await post(path, { name: `Fresh via ${path}` });
      const tasks: any = await fetch(`${base}/api/projects/${project.id}/tasks`, { headers: auth() }).then((r) => r.json());
      const prep = tasks.find((t: any) => t.title === prepTitle);
      expect(prep, `new project via ${path} should get the prep task`).toBeTruthy();
      expect(prep.workflow).toBe('just-do');
    }
  });

  it('drives tags, saved views, and query search over HTTP (a view is a saved query)', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then((r) => r.json());
    const get = (path: string) => fetch(`${base}${path}`, { headers: auth() }).then((r) => r.json());

    const project: any = await post('/api/projects', { name: 'Org', config: { defaultBase: 'main' } });

    // The searchable-field registry drives the UI menus.
    const fields: any = await get('/api/search/fields');
    expect(fields.find((f: any) => f.key === 'status').groupable).toBe(true);
    expect(fields.find((f: any) => f.key === 'tag')).toBeTruthy();

    // Hierarchical tags: frontend/web + a bug label.
    const front: any = await post(`/api/projects/${project.id}/tags`, { name: 'frontend', kind: 'topic' });
    const web: any = await post(`/api/projects/${project.id}/tags`, { name: 'web', parentId: front.id, kind: 'topic' });
    const bug: any = await post(`/api/projects/${project.id}/tags`, { name: 'bug', kind: 'type' });
    expect(web.parentId).toBe(front.id);

    // Two draft tasks (no workflow needed) to organize.
    const mk = (title: string) =>
      post(`/api/projects/${project.id}/tasks`, { title, prompt: title, workflow: 'software-dev', draft: true });
    const t1: any = await mk('Fix web bug');
    const t2: any = await mk('Write docs');

    // Assign tags + priority (organization only — editable while draft).
    await fetch(`${base}/api/tasks/${t1.id}/tags`, { method: 'PUT', headers: auth(), body: JSON.stringify({ tagIds: [web.id, bug.id] }) });
    await fetch(`${base}/api/tasks/${t1.id}/priority`, { method: 'PUT', headers: auth(), body: JSON.stringify({ priority: 4 }) });

    // Search by a parent tag matches the child-tagged task (hierarchy expansion).
    const byParent: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('tag:frontend')}`);
    expect(byParent.tasks.map((t: any) => t.id)).toEqual([t1.id]);

    // Search by label + priority, grouped by tag.
    const byBug: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('tag:bug priority:>=3 group:tag')}`);
    expect(byBug.total).toBe(1);
    expect(byBug.groups.some((g: any) => g.key === bug.id)).toBe(true);

    // A negated/free-text query finds the other task.
    const docs: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('docs -tag:bug')}`);
    expect(docs.tasks.map((t: any) => t.id)).toEqual([t2.id]);

    // Slash path creates (and reuses) a hierarchy in one call — no parent picker.
    const checkout: any = await post(`/api/projects/${project.id}/tags`, { name: 'frontend/web/checkout' });
    expect(checkout.name).toBe('checkout');
    const allTags = (await get(`/api/projects/${project.id}/tags`)) as any[];
    const webParent: any = allTags.find((t: any) => t.id === checkout.parentId);
    expect(webParent.name).toBe('web'); // reused the existing frontend/web, not duplicated
    expect(allTags.filter((t: any) => t.name === 'web')).toHaveLength(1);

    // Workflow params are searchable via param.<key>: both drafts carry prompt=title.
    const byParam: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('param.prompt:docs')}`);
    expect(byParam.tasks.map((t: any) => t.id)).toEqual([t2.id]);

    // The agent-facing add/remove-by-name endpoint (what the platform MCP forwards to).
    const added: any = await post(`/api/tasks/${t2.id}/tag`, { add: ['frontend/web', 'chore'] });
    expect(added.tags.sort()).toEqual(['chore', 'frontend/web']);
    const removed: any = await post(`/api/tasks/${t2.id}/tag`, { remove: ['chore'] });
    expect(removed.tags).toEqual(['frontend/web']);

    // Saved view = persisted query; it round-trips and lists back.
    const view: any = await post(`/api/projects/${project.id}/views`, {
      name: 'Urgent frontend',
      query: { filters: [{ field: 'tag', op: 'is', values: ['frontend'] }], sort: [{ field: 'priority', dir: 'desc' }] },
      icon: '🔥',
    });
    const views: any = await get(`/api/projects/${project.id}/views`);
    expect(views.map((v: any) => v.name)).toContain('Urgent frontend');
    expect(views.find((v: any) => v.id === view.id).query.filters[0].field).toBe('tag');
  });

  // ── vault items + the credential pull model over HTTP (PLAN-passwords.md) ──
  it('vault item lifecycle: add, list without secrets, policy-gated reveal, delete', async () => {
    const created: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'GitHub (test)', domains: 'github.com', username: 'octo',
      policy: { use: 'auto', reveal: 'ask' }, secrets: { password: 'hunter2' },
    }) })).json();
    expect(created.id).toBeTruthy();
    expect(created.fields).toEqual(['password']);
    expect(JSON.stringify(created)).not.toContain('hunter2');
    const items: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(JSON.stringify(items)).not.toContain('hunter2');
    expect(items.map((i: any) => i.id)).toContain(created.id);

    // reveal policy 'ask' gates even an all-capability caller
    const asked: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com' }) })).json();
    expect(asked.status).toBe('needs_approval');
    await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({ id: created.id, type: 'login', label: created.label, domains: created.domains, policy: { reveal: 'auto' } }) });
    const revealed: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com' }) })).json();
    expect(revealed.status).toBe('granted');
    expect(revealed.value).toBe('hunter2');
    expect(revealed.username).toBe('octo');

    // escalation requests are for task agents, not human sessions
    const noTask: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com', why: 'x' }) })).json();
    expect(noTask.error).toMatch(/task-agent/);

    await fetch(`${base}/api/vault/items/${created.id}`, { method: 'DELETE', headers: auth() });
    const after: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(after.map((i: any) => i.id)).not.toContain(created.id);
  });

  it('agent pull model: needs_approval → human grants for the task → retry succeeds', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'api-key', label: 'Service key', policy: { use: 'auto', reveal: 'auto' }, secrets: { secret: 'sk-999' },
    }) })).json();
    // A task-agent bearer whose grant does NOT cover the item (the do-role
    // ceiling admits use-credential:*, but the task grant carries no item cap).
    const minted = h.tokens.mint({ taskId: 'task_vaulttest', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] });
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };

    const first: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(first.status).toBe('needs_approval');
    const req: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id, mode: 'reveal', why: 'need the key' }) })).json();
    expect(req.status).toBe('needs_approval');
    expect(req.requestId).toBeTruthy();
    // the human resolves it for the whole task (durable grant extension)
    const resolved: any = await (await fetch(`${base}/api/vault/requests/${req.requestId}/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ action: 'task' }) })).json();
    expect(resolved.status).toBe('granted');
    const second: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(second.status).toBe('granted');
    expect(second.value).toBe('sk-999');
    // and only for that task — a sibling task with the same shape stays parked
    const other = h.tokens.mint({ taskId: 'task_other', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] });
    const third: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(third.status).toBe('needs_approval');
  });

  it('rotation rides the use-grant: a granted task updates a foreign item\'s secret, nothing else', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'Rotatable', domains: 'rot.example.com', policy: { use: 'auto', reveal: 'auto' }, secrets: { password: 'old' },
    }) })).json();
    const granted = h.tokens.mint({ taskId: 'task_rot', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'vault:store', 'use-credential:*'], grantorCaps: ['credential:read', 'vault:store', `use-credential:item:${item.id}`] });
    const grantedAuth = { authorization: `Bearer ${granted.token}`, 'content-type': 'application/json' };
    // secrets-only update on an item this task did NOT create → allowed by the grant
    const rotated: any = await (await fetch(`${base}/api/vault/store`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ id: item.id, type: 'login', secrets: { password: 'new' } }) })).json();
    expect(rotated.id).toBe(item.id);
    const value: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ itemId: item.id }) })).json();
    expect(value.value).toBe('new');
    // metadata-only update on a foreign item → refused
    const meta = await fetch(`${base}/api/vault/store`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ id: item.id, type: 'login', label: 'hijacked' }) });
    expect(meta.status).toBe(403);
    const listed: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(listed.find((i: any) => i.id === item.id).label).toBe('Rotatable');
    // an UNgranted task cannot rotate
    const ungranted = h.tokens.mint({ taskId: 'task_norot', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'vault:store', 'use-credential:*'], grantorCaps: ['credential:read', 'vault:store'] });
    const denied = await fetch(`${base}/api/vault/store`, { method: 'POST', headers: { authorization: `Bearer ${ungranted.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, type: 'login', secrets: { password: 'evil' } }) });
    expect(denied.status).toBe(403);
    // a reset report parks with its kind for the human
    const reset: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ itemId: item.id, kind: 'reset', why: 'site rejected it' }) })).json();
    expect(reset.status).toBe('needs_approval');
    const reqs: any = await (await fetch(`${base}/api/vault/requests?status=pending`, { headers: auth() })).json();
    expect(reqs.find((r: any) => r.id === reset.requestId).kind).toBe('reset');
  });

  it('lists the external-store connectors (describe, unauthenticated CLIs report not-ready)', async () => {
    const conns: any = await (await fetch(`${base}/api/vault/connectors`, { headers: auth() })).json();
    expect(conns.map((c: any) => c.name).sort()).toEqual(['1password', 'bitwarden', 'pass']);
    // In CI none of the CLIs are configured, so each reports a clear reason.
    for (const c of conns) { expect(typeof c.available).toBe('boolean'); expect(c.detail).toBeTruthy(); }
  });

  it('agent mailbox: per-org address, shared-secret ingest, reads, and tenant isolation', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    expect(orgId).toBeTruthy();
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address).toMatch(/@/);
    // ingest requires the configured shared secret
    const prev = process.env.KARMAX_AGENT_MAIL_SECRET;
    process.env.KARMAX_AGENT_MAIL_SECRET = 'shh';
    try {
      const rejected = await fetch(`${base}/api/agent-mail/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: addr.address, from: 'x@y.com', text: 'code 314159' }) });
      expect(rejected.status).toBe(401);
      const ok: any = await (await fetch(`${base}/api/agent-mail/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shh' }, body: JSON.stringify({ to: addr.address, from: 'noreply@github.com', subject: 'Verify', text: 'Your code is 314159' }) })).json();
      expect(ok.delivered).toBe(true);
      // mail to an address no organization owns is dropped
      const dropped: any = await (await fetch(`${base}/api/agent-mail/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shh' }, body: JSON.stringify({ to: 'stranger@agent.local', from: 'x@y.com', text: 'code 999999' }) })).json();
      expect(dropped.delivered).toBe(false);
      const inbox: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail?match=github`, { headers: auth() })).json();
      expect(inbox.messages[0].code).toBe('314159');
      // an agent token scoped to ANOTHER organization cannot read this inbox
      const foreign = h.tokens.mint({ taskId: 'task_mail', profileId: 'do', principal: 'user:test',
        organizationId: 'org_other', ceiling: ['credential:read'], grantorCaps: ['credential:read'] });
      const denied = await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: { authorization: `Bearer ${foreign.token}` } });
      expect(denied.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.KARMAX_AGENT_MAIL_SECRET; else process.env.KARMAX_AGENT_MAIL_SECRET = prev;
    }
  });

  it('mailbox provider: connect a domain in Settings (no env var) and addresses adopt it', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const providers: any = await (await fetch(`${base}/api/agent-mail/providers`, { headers: auth() })).json();
    expect(providers.providers.map((p: any) => p.name).sort()).toEqual(['hosted', 'self-managed']);
    const connect = await fetch(`${base}/api/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'agents.test.co' }) });
    expect(connect.status).toBe(200);
    // a fresh org now mints its address on the connected domain
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address.endsWith('@agents.test.co')).toBe(true);
    expect(addr.configured).toBe(true);
    // an invalid domain is rejected with a clear reason, not stored
    const bad = await fetch(`${base}/api/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'nonsense' }) });
    expect(bad.status).toBe(400);
  });

  it('cards are organization-scoped: one org never sees or spends another\'s card', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const made: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { method: 'POST', headers: auth(), body: JSON.stringify({ scope: 'organization', label: 'Org card', cap: 100000 }) })).json();
    expect(made.scope).toBe('organization');
    expect(made.scopeId).toBe(orgId);
    const mine: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { headers: auth() })).json();
    expect(mine.map((c: any) => c.id)).toContain(made.id);
    // a different org's card listing does not include it
    const others: any = await (await fetch(`${base}/api/cards?organizationId=org_elsewhere`, { headers: auth() })).json();
    expect(others.map((c: any) => c.id)).not.toContain(made.id);
  });
});
