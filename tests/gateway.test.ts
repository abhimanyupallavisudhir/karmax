import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  });

  it('exposes contributions (slots, commands, event schemas)', async () => {
    const c: any = await (await fetch(`${base}/api/contributions`, { headers: auth() })).json();
    expect(c.commands.find((x: any) => x.id === 'nav.newTask')).toBeTruthy();
    expect(c.slots.some((s: any) => s.contribution.slot === 'task-detail')).toBe(true);
    expect(c.events.some((e: any) => e.type === 'software-dev.merged')).toBe(true);
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
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

    // dashboard reflects the project + task
    const dash: any = await (await fetch(`${base}/api/dashboard`, { headers: auth() })).json();
    expect(dash.projects).toBeGreaterThanOrEqual(1);
    expect(dash.tasks).toBeGreaterThanOrEqual(1);
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

    // Changing a project default now flows into the (still unqueued) task's
    // resolved defaults — the /api/defaults task scope reflects it immediately.
    await fetch(`${base}/api/settings/project/${project.id}/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { worldProvider: 'container', base: 'develop' } }),
    });
    const defs: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs.task.inherited.worldProvider).toBe('container');
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
    expect(defs2.task.inherited.worldProvider).toBe('container'); // project override still wins
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
});
