import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE } from '../src/integrations/github-app.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));

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
    // The console needs to know whether host-machine affordances are worth showing.
    expect(meta.hostLocal).toBe(true);
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
    expect(c.commands.find((x: any) => x.id === 'nav.notifications')?.keybinding).toBe('g N');
    expect(c.commands.find((x: any) => x.id === 'nav.activity')).toBeUndefined();
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

  it('serves brand assets resolved against the instance-wide icon setting', async () => {
    const asset = (p: string) => fetch(`${base}${p}`); // deliberately unauthenticated: the sign-in screen needs these
    const bytes = async (p: string) => Buffer.from(await (await asset(p)).arrayBuffer());
    const variant = (icon: string) =>
      fs.readFileSync(path.join(webDir, 'brand', icon, 'icon-192.png'));

    // Unset → the diamond, and its vector art is available.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('diamond'));
    const svg = await asset('/brand/icon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    const saved = await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: 'knot' } }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/api/settings/global/appearance`, { headers: auth() })).json()).toEqual({ icon: 'knot' });

    // The same URLs now serve the new artwork — that is what reskins the favicon.
    const png = await asset('/brand/icon-192.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('no-cache');
    expect(Buffer.from(await png.arrayBuffer())).toEqual(variant('knot'));
    expect(await bytes('/brand/apple-touch-icon.png'))
      .toEqual(fs.readFileSync(path.join(webDir, 'brand', 'knot', 'apple-touch-icon.png')));
    // The knot ships no SVG, so the browser falls through to the PNG <link>.
    expect((await asset('/brand/icon.svg')).status).toBe(404);

    // Per-variant paths stay addressable, so the settings picker can preview them.
    expect(await bytes('/brand/diamond/icon-192.png')).toEqual(variant('diamond'));

    const invalid = await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: '../diamond' } }),
    });
    expect(invalid.status).toBe(400);
    // A rejected write leaves the previous choice intact.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('knot'));

    // The mark is instance-wide, so changing it is the operator's alone: a
    // developer holds neither settings:read nor settings:write, which is also
    // what makes the settings card hide itself below that level.
    const dev = h.tokens.mintPrincipal('user:dev', ['task:*', 'project:read']).token;
    const devAuth = { authorization: `Bearer ${dev}`, 'content-type': 'application/json' };
    expect((await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: devAuth, body: JSON.stringify({ values: { icon: 'clover' } }),
    })).status).toBe(403);
    expect((await fetch(`${base}/api/settings/global/appearance`, { headers: devAuth })).status).toBe(403);
    // …and the unauthorized attempt changed nothing.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('knot'));

    await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: 'diamond' } }),
    });
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

  it('enforces capability, delegated-subject, interactive-presence, scope, and audit independently', async () => {
    const organization = h.store.createOrganization({ name: 'Delegated identity' });
    const project = h.store.createProject('Delegated project', {}, organization.id);
    const human = h.tokens.mintPrincipal('user:delegator', ['project:read', 'repository:read', 'repository:write'],
      project.id, 60_000, organization.id);
    const delegation = h.tokens.delegateHuman(human.token, {
      taskId: 'task-delegated', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: 'acct-42' },
    })!;
    const delegated = h.tokens.mint({
      taskId: 'task-delegated', profileId: 'maintainer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id,
      ceiling: ['project:read', 'repository:read', 'repository:write'],
      grantorCaps: ['project:read', 'repository:read', 'repository:write'], delegationId: delegation.id,
    });
    const delegatedAuth = { authorization: `Bearer ${delegated.token}`, 'content-type': 'application/json' };

    // The subject check passes. This test gateway has no GitHub App, so the
    // request reaches integration availability instead of the old browser-only gate.
    const create = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ gitConnectionId: 'missing', name: 'delegated-repo' }),
    });
    expect(create.status).toBe(503);
    expect(await create.json()).toMatchObject({ error: expect.stringMatching(/GitHub App/i) });

    const repository = h.store.upsertRepository({ organizationId: organization.id, provider: 'github',
      owner: 'acme', name: 'delegated-repo', sshUrl: 'git@github.com:acme/delegated-repo.git',
      defaultBranch: 'main', private: true });
    const attach = await fetch(`${base}/api/projects/${project.id}/repositories`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ repositoryId: repository.id }),
    });
    expect(attach.status).toBe(200);
    expect(((await attach.json()) as any).repositoryId).toBe(repository.id);

    const capabilityDenied = h.tokens.mint({
      taskId: 'task-capability-denied', profileId: 'developer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id, ceiling: ['project:read'], grantorCaps: ['project:read'],
      delegationId: h.tokens.deriveHumanDelegation(delegation.id, {
        taskId: 'task-capability-denied', projectId: project.id, organizationId: organization.id,
      }).id,
    });
    expect((await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${capabilityDenied.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).status).toBe(403);

    const noSubject = h.tokens.mint({ taskId: 'task-autonomous', profileId: 'maintainer', role: 'do',
      principal: 'autonomous:worker', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'] });
    const noSubjectResponse = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${noSubject.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noSubjectResponse.status).toBe(403);
    expect(await noSubjectResponse.json()).toMatchObject({ error: expect.stringMatching(/verified human subject/i) });

    const interactiveOnly = await fetch(`${base}/api/user/export`, { headers: delegatedAuth });
    expect(interactiveOnly.status).toBe(401);
    expect(await interactiveOnly.json()).toMatchObject({ error: expect.stringMatching(/interactive human/i) });

    const audit = h.store.auditSince(0, 2000).find((event) =>
      event.action === 'http.post.repository:write' && event.detail.path.endsWith('/repositories/create')
      && event.principalId === 'task-agent:task-delegated:do');
    expect(audit).toMatchObject({
      detail: { actor: { kind: 'task-agent', taskId: 'task-delegated' },
        humanSubject: { kind: 'user', userId: 'delegator', presence: 'delegated' } },
    });
  });

  it('creates and attaches a repository for a delegated task with its authority-pinned GitHub account', async () => {
    const organization = h.store.createOrganization({ name: 'Delegated repository creation' });
    const project = h.store.createProject('Delegated repository project', {}, organization.id);
    const calls: Array<{ path: string; method: string; authorization?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const authorization = new Headers(init.headers).get('authorization') ?? undefined;
      calls.push({ path: url.pathname, method: init.method ?? 'GET', authorization });
      if (url.pathname === '/user' && authorization === 'Bearer pinned-token')
        return Response.json({ id: 42, login: 'pinned-user' });
      if (url.pathname === '/user' && authorization === 'Bearer active-token')
        return Response.json({ id: 99, login: 'active-user' });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST' && authorization === 'Bearer pinned-token')
        return Response.json({ id: 77, name: 'delegated-repo', private: true,
          ssh_url: 'git@github.com:acme/delegated-repo.git', default_branch: 'main', owner: { login: 'acme' } });
      if (url.pathname === '/user/installations/123/repositories/77' && init.method === 'PUT'
        && authorization === 'Bearer pinned-token') return new Response(null, { status: 204 });
      if (url.pathname === '/app/installations/123/access_tokens' && init.method === 'POST')
        return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    };
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    h.broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    const githubApp = new GitHubAppService(h.store, h.broker,
      { appId: '1', fetch: fakeFetch as typeof fetch });
    await githubApp.adoptUserAuthorization('delegator', '42', { accessToken: 'pinned-token' });
    await githubApp.adoptUserAuthorization('delegator', '99', { accessToken: 'active-token' });
    await githubApp.setActiveUserAccount('delegator', '99');
    const connection = h.store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '123', accountLogin: 'acme', accountType: 'Organization' });
    const githubGateway = await h.startGateway({ githubApp });

    const capabilities = ['project:read', 'repository:read', 'repository:write'] as const;
    const human = h.tokens.mintPrincipal('user:delegator', [...capabilities], project.id, 60_000, organization.id);
    const delegation = h.tokens.delegateHuman(human.token, {
      taskId: 'task-create-repository', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: '42' },
    })!;
    const delegated = h.tokens.mint({
      taskId: 'task-create-repository', profileId: 'maintainer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id, ceiling: [...capabilities],
      grantorCaps: [...capabilities], delegationId: delegation.id,
    });

    const delegatedAuth = { authorization: `Bearer ${delegated.token}`, 'content-type': 'application/json' };
    const createdResponse = await fetch(
      `${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
        method: 'POST', headers: delegatedAuth, body: JSON.stringify({
          gitConnectionId: connection.id, name: 'delegated-repo', description: 'Created by a delegated task', private: true,
        }),
      });
    const repository = await createdResponse.json() as any;
    expect({ status: createdResponse.status, error: repository.error }).toEqual({ status: 200, error: undefined });
    expect(repository).toMatchObject({ owner: 'acme', name: 'delegated-repo', private: true,
      gitConnectionId: connection.id });
    expect(calls).toContainEqual({ path: '/orgs/acme/repos', method: 'POST', authorization: 'Bearer pinned-token' });
    expect(calls.some((call) => call.authorization === 'Bearer active-token' && call.method === 'POST')).toBe(false);

    const attachedResponse = await fetch(`${base}/api/projects/${project.id}/repositories`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ repositoryId: repository.id }),
    });
    expect(attachedResponse.status).toBe(200);
    expect(await attachedResponse.json()).toMatchObject({ projectId: project.id, repositoryId: repository.id });
    expect(h.store.listProjectRepositories(project.id)).toEqual([
      expect.objectContaining({ projectId: project.id, repositoryId: repository.id,
        repository: expect.objectContaining({ name: 'delegated-repo' }) }),
    ]);

    const denied = h.tokens.mint({ taskId: 'task-repository-denied', profileId: 'developer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['project:read'], grantorCaps: ['project:read'] });
    expect((await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${denied.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'denied-repo' }),
    })).status).toBe(403);

    const unpinnedDelegation = h.tokens.delegateHuman(human.token, {
      taskId: 'task-repository-unpinned', projectId: project.id, organizationId: organization.id,
    })!;
    const unpinned = h.tokens.mint({ taskId: 'task-repository-unpinned', profileId: 'maintainer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: unpinnedDelegation.id });
    const unpinnedResponse = await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${unpinned.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'unpinned-repo' }),
    });
    expect(unpinnedResponse.status).toBe(403);
    expect(await unpinnedResponse.json()).toMatchObject({ error: expect.stringMatching(/no pinned GitHub account/i) });

    const substitutedDelegation = h.tokens.delegateHuman(human.token, {
      taskId: 'task-repository-substituted', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: '404' },
    })!;
    const substituted = h.tokens.mint({ taskId: 'task-repository-substituted', profileId: 'maintainer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: substitutedDelegation.id });
    const substitutedResponse = await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${substituted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'substituted-repo' }),
    });
    expect(substitutedResponse.status).toBe(400);
    expect(await substitutedResponse.json()).toMatchObject({ error: expect.stringMatching(/pinned GitHub account is not connected/i) });
    expect(calls.filter((call) => call.path === '/orgs/acme/repos' && call.method === 'POST')).toHaveLength(1);

    const audits = h.store.auditSince(0, 5000).filter((event) =>
      event.principalId === 'task-agent:task-create-repository:do');
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'http.post.repository:write', scopeKey: `organization:${organization.id}`,
        detail: expect.objectContaining({ path: `/api/organizations/${organization.id}/repositories/create`,
          actor: expect.objectContaining({ kind: 'task-agent', taskId: 'task-create-repository' }),
          humanSubject: { kind: 'user', userId: 'delegator', presence: 'delegated' } }) }),
      expect.objectContaining({ action: 'http.post.repository:write', scopeKey: `project:${project.id}`,
        detail: expect.objectContaining({ path: `/api/projects/${project.id}/repositories`,
          actor: expect.objectContaining({ kind: 'task-agent', taskId: 'task-create-repository' }) }) }),
    ]));
  });

  it('reorders projects for the sidebar', async () => {
    const make = async (name: string) => (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name }) })).json()) as any;
    const [one, two, three] = [await make('Ord one'), await make('Ord two'), await make('Ord three')];
    const listed = async () => ((await (await fetch(`${base}/api/projects`, { headers: auth() })).json()) as any[])
      .map((p) => p.name).filter((n: string) => n.startsWith('Ord '));
    expect(await listed()).toEqual(['Ord one', 'Ord two', 'Ord three']);

    // The drop names the project the dragged one now sits above.
    const moved = await fetch(`${base}/api/projects/${three.id}/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ before: one.id }) });
    expect(moved.status).toBe(200);
    expect(await listed()).toEqual(['Ord three', 'Ord one', 'Ord two']);

    // Omitting `before` drops it past the last project, and the new order sticks.
    await fetch(`${base}/api/projects/${three.id}/reorder`, { method: 'POST', headers: auth(), body: JSON.stringify({}) });
    expect(await listed()).toEqual(['Ord one', 'Ord two', 'Ord three']);
    await fetch(`${base}/api/projects/${two.id}/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ before: one.id }) });
    expect(await listed()).toEqual(['Ord two', 'Ord one', 'Ord three']);

    const missing = await fetch(`${base}/api/projects/proj_nope/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    expect((await fetch(`${base}/api/projects/${one.id}/reorder`, { method: 'POST' })).status).toBe(401);
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

    // Agent-authored absolute paths are resolved back into this task's world by
    // the conversation file endpoint; source files open inline as text.
    const file = await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent(`${view.worldPath}/out.txt`)}`, { headers: auth() });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/plain');
    expect(await file.text()).toContain('hello-artifact');

    // Conversation clicks never navigate to the absolute world path. The host
    // resolves it to its checkout and returns a pasteable editor command.
    const openCommand = await fetch(`${base}/api/tasks/${task.id}/open-command`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ path: `${view.worldPath}/out.txt`, line: 1 }),
    });
    expect(openCommand.status).toBe(200);
    expect(await openCommand.json()).toMatchObject({
      path: `${view.worldPath}/out.txt`,
      command: `code --goto '${view.worldPath}/out.txt:1'`,
      materialized: false,
    });

    // A bad index is rejected; neither artifact nor conversation-file paths may
    // traverse outside the task world.
    const bad = await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 99 }) });
    expect(bad.status).toBe(404);
    const escape = await fetch(`${base}/api/tasks/${task.id}/artifact?path=${encodeURIComponent('../../../etc/passwd')}`, { headers: auth() });
    expect(escape.status).toBe(400);
    const fileEscape = await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent('/etc/passwd')}`, { headers: auth() });
    expect(fileEscape.status).toBe(400);
    const commandEscape = await fetch(`${base}/api/tasks/${task.id}/open-command`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ path: '/etc/passwd' }),
    });
    expect(commandEscape.status).toBe(409);
    await fs.promises.symlink('/etc/passwd', `${view.worldPath}/escape-link`);
    const symlinkEscape = await fetch(`${base}/api/tasks/${task.id}/file?path=escape-link`, { headers: auth() });
    expect(symlinkEscape.status).toBe(400);
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

  it('attaches redacted resources and completes a resumable binary upload', async () => {
    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Resource API' }) }).then((response) => response.json());
    const secretResponse = await fetch(`${base}/api/projects/${project.id}/resources`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Token', driver: 'secret@1', target: { kind: 'environment', name: 'MODEL_TOKEN' },
        access: 'read', isolation: 'fork', publish: 'discard', secret: 'never-return-this' }) });
    expect(secretResponse.status).toBe(200);
    const secret: any = await secretResponse.json();
    expect(secret.credentialConfigured).toBe(true);
    expect(JSON.stringify(secret)).not.toContain('never-return-this');
    expect(secret.credentialHandles).toBeUndefined();

    const volume: any = await fetch(`${base}/api/projects/${project.id}/resources`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Model', driver: 'volume@1', target: { kind: 'path', path: 'resources/model' },
        access: 'write', isolation: 'fork', publish: 'review' }) }).then((response) => response.json());
    const upload: any = await fetch(`${base}/api/projects/${project.id}/resources/${volume.id}/uploads`,
      { method: 'POST', headers: auth() }).then((response) => response.json());
    const bytes = Buffer.from('fine-tuned-model-weights');
    const part = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}&path=model.bin&part=0`,
      { method: 'PUT', headers: { ...auth(), 'content-type': 'application/octet-stream' }, body: bytes });
    expect(part.status).toBe(200);
    const complete = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}`,
      { method: 'POST', headers: auth() });
    expect(complete.status).toBe(200);
    const revision: any = await complete.json();
    expect(revision.bytes).toBe(bytes.length);
    expect(revision.sealedRef).toBeUndefined();
    const listed = await fetch(`${base}/api/projects/${project.id}/resources`, { headers: auth() }).then((response) => response.json()) as any[];
    expect(listed.find((resource) => resource.id === volume.id).revision.bytes).toBe(bytes.length);
    expect(JSON.stringify(listed)).not.toContain('sealedRef');
  });

  it('offers proposal-driven secrets, environment, and per-world services over typed resources', async () => {
    const repo = await h.makeRepo('project-onboarding');
    fs.mkdirSync(`${repo}/.devcontainer`);
    fs.writeFileSync(`${repo}/.env.example`, 'DATABASE_URL=\nMODEL_TOKEN=\n');
    fs.writeFileSync(`${repo}/package-lock.json`, '{}');
    fs.writeFileSync(`${repo}/.devcontainer/devcontainer.json`, JSON.stringify({
      image: 'node:22-slim',
      postCreateCommand: 'npm run setup',
      dockerComposeFile: '../compose.yaml',
    }));
    fs.writeFileSync(`${repo}/compose.yaml`, `services:
  database:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: local
      POSTGRES_DB: app
`);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add project declarations']);

    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Onboarding API', config: { repos: [repo], worldProvider: 'container' } }) })
      .then((response) => response.json());

    const suggested: any = await fetch(`${base}/api/projects/${project.id}/secrets`, { headers: auth() })
      .then((response) => response.json());
    expect(suggested.suggestions).toEqual(['DATABASE_URL', 'MODEL_TOKEN']);
    const imported = await fetch(`${base}/api/projects/${project.id}/secrets`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ env: 'MODEL_TOKEN=private-value\nDATABASE_URL=postgres://external' }) });
    expect(imported.status).toBe(200);
    expect(JSON.stringify(await imported.json())).not.toContain('private-value');

    const proposal: any = await fetch(`${base}/api/projects/${project.id}/environment/proposal`, { headers: auth() })
      .then((response) => response.json());
    expect(proposal.spec).toMatchObject({ image: 'node:22-slim', setup: ['npm run setup', 'npm ci'] });
    const savedEnvironment = await fetch(`${base}/api/projects/${project.id}/environment`, {
      method: 'PUT', headers: auth(), body: JSON.stringify(proposal.spec),
    });
    expect(savedEnvironment.status).toBe(200);

    const compose: any = await fetch(`${base}/api/projects/${project.id}/services/compose-import`, { headers: auth() })
      .then((response) => response.json());
    expect(compose.proposals[0]).toMatchObject({
      name: 'database', kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL',
    });
    const service = await fetch(`${base}/api/projects/${project.id}/services`, {
      method: 'POST', headers: auth(), body: JSON.stringify(compose.proposals[0]),
    });
    expect(service.status).toBe(200);

    const secrets: any = await fetch(`${base}/api/projects/${project.id}/secrets`, { headers: auth() })
      .then((response) => response.json());
    expect(secrets.suggestions).toEqual([]);
    expect(secrets.secrets.every((secret: any) => secret.credentialConfigured)).toBe(true);
    expect(JSON.stringify(secrets)).not.toContain('postgres://external');
  });

  it('migrates copyGlobs through the typed resource API and returns no secret values', async () => {
    const repo = await h.makeRepo('copyglobs-api');
    fs.writeFileSync(`${repo}/.env.local`, 'LEGACY_TOKEN=private-legacy-value\n');
    fs.writeFileSync(`${repo}/model.bin`, Buffer.from([0, 1, 2, 255]));
    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'copyGlobs migration', config: {
        repos: [repo], copyGlobs: ['.env*', '*.bin'],
      } }) }).then((response) => response.json());
    const migrated = await fetch(`${base}/api/projects/${project.id}/resources/import-copyglobs`, {
      method: 'POST', headers: auth(), body: '{}',
    });
    expect(migrated.status).toBe(200);
    const result: any = await migrated.json();
    expect(result).toMatchObject({ environmentSecrets: ['LEGACY_TOKEN'], data: ['model.bin'], skipped: [] });
    expect(JSON.stringify(result)).not.toContain('private-legacy-value');
    expect(h.store.getProject(project.id)?.config.copyGlobs).toEqual([]);
    const attachments = await fetch(`${base}/api/projects/${project.id}/resources`, { headers: auth() })
      .then((response) => response.json()) as any[];
    expect(attachments.some((attachment) => attachment.target?.name === 'LEGACY_TOKEN')).toBe(true);
    expect(attachments.some((attachment) => attachment.target?.path === 'model.bin'
      && attachment.revision?.bytes === 4)).toBe(true);
    expect(JSON.stringify(attachments)).not.toContain('private-legacy-value');
  });

  it('seeds a brand-new project with the krmax-ready prep task', async () => {
    // A new project's tasks default to software-dev, so creation spawns that
    // workflow's current onActivate prep task automatically (SPEC §4.6) —
    // no manual "activate workflow" step. Covers both create-project routes.
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then((r) => r.json());
    const prepTitle = 'Make this project krmax-ready';
    for (const path of ['/api/organizations/org_personal/projects', '/api/projects']) {
      const project: any = await post(path, { name: `Fresh via ${path}` });
      const tasks: any = await fetch(`${base}/api/projects/${project.id}/tasks`, { headers: auth() }).then((r) => r.json());
      const prep = tasks.find((t: any) => t.title === prepTitle);
      expect(prep, `new project via ${path} should get the prep task`).toBeTruthy();
      expect(prep.workflow).toBe('software-dev');
      expect(prep.params.prompt).toContain('Migrate AGENTS.md, CLAUDE.md');
      expect(prep.params.prompt).toContain('hardcoded resources (e.g. ports)');
      expect(prep.params.prompt).not.toContain('Ensure git is initialized');
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
    const front: any = await post(`/api/projects/${project.id}/tags`, { name: 'frontend', kind: 'topic', description: 'All client work.' });
    const web: any = await post(`/api/projects/${project.id}/tags`, { name: 'web', parentId: front.id, kind: 'topic', description: 'Browser client work.' });
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
    const byHierarchy: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('group:tag')}`);
    const frontendGroup = byHierarchy.groups.find((g: any) => g.key === front.id);
    expect(byHierarchy.hierarchical).toBe(true);
    expect(frontendGroup).toMatchObject({ label: 'frontend', description: 'All client work.', count: 1 });
    expect(frontendGroup.children[0]).toMatchObject({ key: web.id, label: 'web', description: 'Browser client work.', count: 1 });

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
  it('persists task credential policies and applies edits to agent access', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'Task-specific policy', domains: 'policy.example.com',
        policy: { use: 'ask', reveal: 'never' }, secrets: { password: 'task-secret' },
      }),
    })).json();
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ name: 'Vault policy project' }),
    })).json();
    const cap = `use-credential:item:${item.id}`;
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        workflow: 'just-do', command: 'later', draft: true,
        credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'ask' } },
      }),
    })).json();
    expect(task.params._authorization.credentialPolicies[item.id]).toEqual({ use: 'auto', reveal: 'ask' });

    const minted = h.tokens.mint({
      taskId: task.id, profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read', cap],
    });
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
    const asked: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }),
    })).json();
    expect(asked.status).toBe('needs_approval'); // task "ask" overrides global "never"

    const patched: any = await (await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({
        profileId: 'developer', credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'auto' } },
      }),
    })).json();
    expect(patched.params._authorization.credentialPolicies[item.id].reveal).toBe('auto');
    const revealed: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }),
    })).json();
    expect(revealed).toMatchObject({ status: 'granted', value: 'task-secret' });
  });

  it('changes a running task authorization + vault grants in-flight, freezes once terminal', async () => {
    const repo = await h.makeRepo('auth-inflight-gw');
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'In-flight auth', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
    })).json();
    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'In-flight grant', domains: 'inflight.example.com',
        policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'inflight-secret' },
      }),
    })).json();
    const cap = `use-credential:item:${item.id}`;
    // A running task (paused at Review) — no longer a draft, so previously frozen.
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        title: 'in-flight authorization', prompt: '@write auth.txt :: ok\n@review authorization edit', workflow: 'software-dev',
      }),
    })).json();
    await expect.poll(async () => ((await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json()) as any)?.stage,
      { timeout: 15_000 }).toBe('review');

    // Attach a vault credential + raise the policy in-flight — the same PATCH the
    // task form uses, now accepted while the task runs.
    const patched: any = await (await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({
        profileId: 'developer', credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'auto' } },
      }),
    })).json();
    expect(patched.params._authorization.profileId).toBe('developer');
    expect(patched.params._authorization.capabilities).toContain(cap);
    expect(patched.params._authorization.credentialPolicies[item.id].reveal).toBe('auto');

    // Drive to terminal, then the same edit is frozen (no live grant to re-point).
    await fetch(`${base}/api/tasks/${task.id}/signal`, { method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }) });
    await expect.poll(async () => ((await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json()) as any)?.stage,
      { timeout: 15_000 }).toBe('done');
    const frozen = await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ profileId: 'reader', credentialGrants: [] }),
    });
    expect(frozen.status).toBe(409);
  });

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

    // A vault administrator may explicitly inspect a stored field without
    // weakening the independent "agent sees" policy. The inspection is still
    // a plaintext reveal, so it is audited.
    const inspectedResponse = await fetch(`${base}/api/vault/items/${created.id}/reveal`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ field: 'password' }),
    });
    expect(inspectedResponse.headers.get('cache-control')).toBe('private, no-store');
    const inspected: any = await inspectedResponse.json();
    expect(inspected).toMatchObject({ itemId: created.id, field: 'password', value: 'hunter2' });
    expect(h.store.auditSince().some((entry: any) => entry.action === 'vault.revealed'
      && entry.detail.itemId === created.id && entry.detail.field === 'password')).toBe(true);

    // This administrative endpoint must never become a shortcut around the
    // item grant/policy checks for a task-agent, even if its role happens to
    // carry credential:write.
    const taskAgent = h.tokens.mint({
      taskId: 'task_admin_reveal', profileId: 'do', principal: 'user:test', organizationId: 'org_personal',
      ceiling: ['credential:write'], grantorCaps: ['credential:write'],
    });
    const agentInspection = await fetch(`${base}/api/vault/items/${created.id}/reveal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${taskAgent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'password' }),
    });
    expect(agentInspection.status).toBe(403);
    const agentInspectionBody: any = await agentInspection.json();
    expect(agentInspectionBody.error).toMatch(/human vault administrator/);

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
    // The blocked reveal auto-raises the request — no separate request_credential
    // call is needed for it to surface to the human.
    expect(first.requestId).toBeTruthy();
    // An explicit request_credential dedupes onto that same pending request.
    const req: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id, mode: 'reveal', why: 'need the key' }) })).json();
    expect(req.status).toBe('needs_approval');
    expect(req.requestId).toBe(first.requestId);
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

  it('projects credential approvals onto the task, notifies its human, and resumes it after resolution', async () => {
    const repo = await h.makeRepo('gw-credential-approval');
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        name: 'Credential approval lifecycle',
        config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
      }),
    })).json();
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        workflow: 'software-dev', title: 'Use an approval-gated credential',
        prompt: '@review waiting for a credential decision',
      }),
    })).json();
    await expect.poll(async () => {
      const view: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      return view?.stage;
    }, { timeout: 15_000 }).toBe('review');

    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'Approval lifecycle login', domains: 'approval.example.com',
        policy: { use: 'auto', reveal: 'auto' }, secrets: { password: 'secret' },
      }),
    })).json();
    const minted = h.tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] });
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
    const requested: any = await (await fetch(`${base}/api/vault/requests`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({ itemId: item.id, mode: 'reveal', why: 'verify the approval lifecycle' }),
    })).json();
    expect(requested).toMatchObject({ status: 'needs_approval', itemId: item.id });

    const requests: any = await (await fetch(
      `${base}/api/vault/requests?taskId=${task.id}&organizationId=org_personal`,
      { headers: auth() },
    )).json();
    expect(requests.find((request: any) => request.id === requested.requestId)).toMatchObject({
      task: { id: task.id, num: task.num, title: 'Use an approval-gated credential', projectId: project.id },
    });
    const taskView: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(taskView.approvalRequests).toBe(1);
    const listed: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, { headers: auth() })).json();
    expect(listed.find((candidate: any) => candidate.id === task.id).lastView.approvalRequests).toBe(1);
    const inbox = h.store.listOrganizationMemberships(project.organizationId)
      .flatMap((membership) => h.store.listInbox(membership.userId, project.organizationId));
    expect(inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested', actionable: true, unread: true }),
    ]));

    const resolved: any = await (await fetch(`${base}/api/vault/requests/${requested.requestId}/resolve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ action: 'task' }),
    })).json();
    expect(resolved).toMatchObject({ status: 'granted', resume: { resumed: true } });
    expect(h.store.eventsSince(task.id, 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.message',
        payload: expect.objectContaining({ message: expect.objectContaining({ text: expect.stringContaining('Retry the blocked reveal operation now') }) }),
      }),
      expect.objectContaining({ type: 'credential.approval-resolved', payload: expect.objectContaining({ resumed: true }) }),
    ]));
    const after: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(after.approvalRequests).toBeUndefined();
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

  it('propagates an agent-created item rotation to its write-back entry without clobbering notes', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fake-pass-'));
    const fakePass = path.join(fakeHome, 'pass');
    const entryFile = path.join(fakeHome, 'entry');
    fs.writeFileSync(fakePass, `#!/bin/sh
case "$1" in
  show) cat "$KARMAX_TEST_PASS_ENTRY" ;;
  insert) cat > "$KARMAX_TEST_PASS_ENTRY" ;;
  *) exit 1 ;;
esac
`);
    fs.chmodSync(fakePass, 0o755);
    const previousPath = process.env.PATH;
    const previousEntry = process.env.KARMAX_TEST_PASS_ENTRY;
    process.env.PATH = `${fakeHome}${path.delimiter}${previousPath ?? ''}`;
    process.env.KARMAX_TEST_PASS_ENTRY = entryFile;
    try {
      const configured = await fetch(`${base}/api/vault/connectors/pass/config`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ writeBack: true }),
      });
      expect(configured.status).toBe(200);
      const agent = h.tokens.mint({
        taskId: 'task_agent_writeback_rotation',
        profileId: 'do',
        principal: 'user:test',
        ceiling: ['credential:read', 'vault:store'],
        grantorCaps: ['credential:read', 'vault:store'],
      });
      const agentAuth = { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' };
      const created: any = await (await fetch(`${base}/api/vault/store`, {
        method: 'POST',
        headers: agentAuth,
        body: JSON.stringify({
          type: 'login',
          label: 'Agent-created pass rotation',
          domains: ['rotation.example.com'],
          username: 'agent@example.com',
          secrets: { password: 'initial' },
        }),
      })).json();
      expect(created.writeBack).toEqual([
        { connector: 'pass', externalId: 'karmax/Agent-created-pass-rotation' },
      ]);
      expect(fs.readFileSync(entryFile, 'utf8')).toBe('initial\n');

      // Real pass entries often contain notes below line 1. Rotation must use
      // updateSecret, not push, so those lines survive.
      fs.writeFileSync(entryFile, 'initial\nusername: agent@example.com\nkeep this note\n');
      const rotated: any = await (await fetch(`${base}/api/vault/store`, {
        method: 'POST',
        headers: agentAuth,
        body: JSON.stringify({
          id: created.id,
          type: 'login',
          label: 'Agent-created pass rotation',
          secrets: { password: 'rotated' },
        }),
      })).json();
      expect(rotated.propagated).toEqual({ connector: 'pass', fields: ['password'] });
      expect(fs.readFileSync(entryFile, 'utf8')).toBe(
        'rotated\nusername: agent@example.com\nkeep this note\n',
      );
    } finally {
      await fetch(`${base}/api/vault/connectors/pass/config`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ writeBack: false }),
      }).catch(() => {});
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEntry === undefined) delete process.env.KARMAX_TEST_PASS_ENTRY;
      else process.env.KARMAX_TEST_PASS_ENTRY = previousEntry;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('lists the external-store connectors (describe, unauthenticated CLIs report not-ready)', async () => {
    const conns: any = await (await fetch(`${base}/api/vault/connectors`, { headers: auth() })).json();
    expect(conns.map((c: any) => c.name).sort()).toEqual(['1password', 'bitwarden', 'pass', 'pass-git']);
    // In CI none of the CLIs are configured, so each reports a clear reason.
    for (const c of conns) { expect(typeof c.available).toBe('boolean'); expect(c.detail).toBeTruthy(); }
  });

  it('agent mailbox: per-org address, shared-secret ingest, reads, and tenant isolation', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    expect(orgId).toBeTruthy();
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address).toMatch(/@/);
    // the webhook secret is MINTED by karmax and rides in the copy-pasted URL
    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail/providers`, { headers: auth() })).json();
    expect(providers.webhookUrl).toContain('/api/agent-mail/ingest?secret=');
    expect(providers.cloudflareWorker).toContain('async email(message');
    const hook = new URL(providers.webhookUrl);
    const ingest = `${base}${hook.pathname}${hook.search}`;
    const rejected = await fetch(`${base}/api/agent-mail/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: addr.address, from: 'x@y.com', text: 'code 314159' }) });
    expect(rejected.status).toBe(401);
    const ok: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: addr.address, from: 'noreply@github.com', subject: 'Verify', text: 'Your code is 314159' }) })).json();
    expect(ok.delivered).toBe(true);
    // provider-shaped payloads normalize too (Mailgun urlencoded)
    const mg: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: addr.address, sender: 'no-reply@stripe.com', subject: 'Code', 'body-plain': 'Your code is 271828' }).toString() })).json();
    expect(mg.delivered).toBe(true);
    // mail to an address no organization owns is dropped
    const dropped: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'stranger@agent.local', from: 'x@y.com', text: 'code 999999' }) })).json();
    expect(dropped.delivered).toBe(false);
    const inbox: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail?match=github`, { headers: auth() })).json();
    expect(inbox.messages[0].code).toBe('314159');
    const inbox2: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail?match=stripe`, { headers: auth() })).json();
    expect(inbox2.messages[0].code).toBe('271828');
    // an agent token scoped to ANOTHER organization cannot read this inbox
    const foreign = h.tokens.mint({ taskId: 'task_mail', profileId: 'do', principal: 'user:test',
      organizationId: 'org_other', ceiling: ['credential:read'], grantorCaps: ['credential:read'] });
    const denied = await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: { authorization: `Bearer ${foreign.token}` } });
    expect(denied.status).toBe(403);
  });

  it('mailbox provider: connect a domain in Settings (no env var) and addresses adopt it', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail/providers`, { headers: auth() })).json();
    expect(providers.providers.map((p: any) => p.name).sort()).toEqual(['agentmail', 'hosted', 'imap', 'self-managed']);
    const connect = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'agents.test.co' }) });
    expect(connect.status).toBe(200);
    // a fresh org now mints its address on the connected domain
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address.endsWith('@agents.test.co')).toBe(true);
    expect(addr.configured).toBe(true);
    // an invalid domain is rejected with a clear reason, not stored
    const bad = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'nonsense' }) });
    expect(bad.status).toBe(400);
    // pull providers are flagged so the UI can group them (work on localhost)
    expect(providers.providers.find((p: any) => p.name === 'imap').pull).toBe(true);
    expect(providers.providers.find((p: any) => p.name === 'self-managed').pull).toBe(false);
    // connect a pull provider (IMAP): addresses ride +tags on the mailbox
    const imapOk = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'imap', address: 'agentbox@gmail.com', apiKey: 'app-pass' }) });
    expect(imapOk.status).toBe(200);
    const imapAddr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(imapAddr.address).toMatch(/^agentbox\+agent-[0-9a-f]+@gmail\.com$/);
  });

  it('connects an existing AgentMail inbox for only that organization', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const connect = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: 'agentmail', domain: 'MyInbox@agentmail.to', apiKey: 'am-test-key' }),
    });
    expect(connect.status).toBe(200);
    const mailbox: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(mailbox.address).toBe('myinbox@agentmail.to');
    expect(mailbox.configured).toBe(true);
    expect(h.store.kvGet(`agent-mail:provider:${orgId}`)).toContain('mailbox:agentmail:');
    expect(h.store.kvGet('agent-mail:provider')).toBeUndefined();
  });

  it('configures the shared Stripe Connect application from the operator API without returning secrets', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const endpoint = `${base}/api/organizations/${orgId}/payments/stripe/platform`;
    const before: any = await (await fetch(endpoint, { headers: auth() })).json();
    expect(before).toMatchObject({
      canManage: true,
      callbackUrl: `${base}/api/payments/stripe/callback`,
      webhookUrl: `${base}/api/payments/stripe/webhook`,
    });
    const organizationPaymentAdmin = h.tokens.mint({
      taskId: 'task_payment_admin',
      profileId: 'operator',
      principal: 'user:organization-payment-admin',
      organizationId: orgId,
      ceiling: ['payment:read', 'payment:write'],
      grantorCaps: ['payment:read', 'payment:write'],
    });
    const forbidden = await fetch(endpoint, {
      method: 'PUT',
      headers: { authorization: `Bearer ${organizationPaymentAdmin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'ca_forbidden', secretKey: 'sk_test_forbidden' }),
    });
    expect(forbidden.status).toBe(403);

    const saved = await fetch(endpoint, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        clientId: 'ca_gateway_managed',
        secretKey: 'sk_test_gateway_managed',
        webhookSecret: 'whsec_gateway_managed',
      }),
    });
    expect(saved.status).toBe(200);
    const status: any = await saved.json();
    expect(status).toMatchObject({
      configured: true, clientId: 'ca_gateway_managed', secretKeyConfigured: true,
      webhookConfigured: true, source: 'ui',
    });
    expect(JSON.stringify(status)).not.toContain('sk_test_gateway_managed');
    expect(JSON.stringify(status)).not.toContain('whsec_gateway_managed');
    expect(JSON.stringify(h.store.exportOrganization(orgId))).not.toContain('sk_test_gateway_managed');

    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/payments/providers`,
      { headers: auth() })).json();
    expect(providers.providers.find((provider: any) => provider.name === 'stripe'))
      .toMatchObject({ available: true, connected: false });
  });

  it('cards are organization-scoped: one org never sees or spends another\'s card', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const other = h.store.createOrganization({ name: 'Other payments org' });
    const made: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { method: 'POST', headers: auth(), body: JSON.stringify({ scope: 'organization', label: 'Org card', cap: 100000 }) })).json();
    expect(made.scope).toBe('organization');
    expect(made.scopeId).toBe(orgId);
    const mine: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { headers: auth() })).json();
    expect(mine.map((c: any) => c.id)).toContain(made.id);
    // a different org's card listing does not include it
    const others: any = await (await fetch(`${base}/api/cards?organizationId=${other.id}`, { headers: auth() })).json();
    expect(others.map((c: any) => c.id)).not.toContain(made.id);
    const crossFund = await fetch(`${base}/api/cards/${made.id}/fund?organizationId=${other.id}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ amount: 100 }),
    });
    expect(crossFund.status).toBe(404);
    expect(h.store.getCard(made.id).available).toBe(0);
    const invalidFund = await fetch(`${base}/api/cards/${made.id}/fund?organizationId=${orgId}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ amount: -100 }),
    });
    expect(invalidFund.status).toBe(400);
  });

  it('registers a vault card without ever handing the number back out', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const register = (details: unknown) => fetch(`${base}/api/cards?organizationId=${orgId}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        scope: 'organization', label: 'Household', cap: 50_000, provider: 'vault-card', details }),
    });
    const bad = await register({ number: '4242424242424241', cvc: '123', expMonth: 12, expYear: 2031 });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error).toMatch(/card number/i);

    const response = await register({ number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031,
      billing: { line1: '1 High St', city: 'London', postalCode: 'SW1A 1AA', country: 'GB' } });
    expect(response.status).toBe(200);
    const card: any = await response.json();
    expect(card).toMatchObject({ provider: 'vault-card', last4: '4242', available: 50_000 });
    // The secret half lives only in the vault — not the response, not the index.
    expect(JSON.stringify(card)).not.toContain('4242424242424242');
    const listed = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { headers: auth() })).text();
    expect(listed).not.toContain('4242424242424242');
    expect(h.broker.hasHandle(`payment:card:${card.id}`)).toBe(true);

    // Revoking destroys the secret rather than merely hiding the row.
    expect((await fetch(`${base}/api/cards/${card.id}?organizationId=${orgId}`,
      { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(h.broker.hasHandle(`payment:card:${card.id}`)).toBe(false);
  });
});
