import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';
import type { GitHubAppService } from '../src/integrations/github-app.js';

/**
 * The gateway half of the tag/view scope hole.
 *
 * `requestScope` derived a `projectId` only from `/api/projects/…`,
 * `/api/defaults/…`, `/api/settings/(quick/)?project/…`, a resolvable `taskId`,
 * or an explicit `?projectId=`. `/api/tags/:id` and `/api/views/:id` matched
 * none of them, so `TokenAuthority.check` was handed no project and its tenant
 * guard never fired — a `task:edit` token from any project of any organization
 * could rename or delete another tenant's tag or saved view, and
 * `describe_platform` advertises both routes.
 *
 * Boots a real Gateway + KarmaxApi with stub deps — no Temporal, no worker.
 */
describe('gateway request scope for bare-id routes', () => {
  let home: string;
  let store: Store;
  let tokens: TokenAuthority;
  let gateway: Gateway;
  let base: string;
  let close: () => Promise<void>;
  let mine: string;
  let theirs: string;
  let acmeId: string;
  let token: string;
  let liveView: any;
  /** What the stub GitHub webhook handler throws on the next delivery. */
  let webhookFailure: Error | undefined;
  let webhookProjectEvents: any[] = [];

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-scope-'));
    store = (await Store.create(':memory:', { hosted: true }));
    tokens = new TokenAuthority();
    const acme = (await store.createOrganization({ name: 'Acme', ownerUserId: 'a' }));
    const other = (await store.createOrganization({ name: 'Other', ownerUserId: 'b' }));
    acmeId = acme.id;
    mine = (await store.createProject('Mine', {}, acme.id)).id;
    theirs = (await store.createProject('Theirs', {}, other.id)).id;
    // Permission approval now parks by starting a replacement at the exact
    // stage, so this software-dev fixture needs the repository its manifest
    // requires even though the Temporal client below is a stub.
    (await store.updateProjectConfig(mine, { repos: [home] }));
    const client = {
      workflow: {
        getHandle: () => ({
          terminate: async () => {},
          signal: async () => {},
          query: async (name: string) => name === 'view' ? liveView : [],
        }),
        signalWithStart: async () => {},
        start: async () => ({}),
      },
    } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, contentDir: home, worlds: new WorldRegistry() });
    gateway = (await Gateway.create({
      api, store, tokens,
      bus: new KarmaxBus(),
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      authorization: (await AuthorizationService.create(store)),
      client,
      taskQueue: 'test',
      staticDir: home,
      agentInfo: { provider: 'mock', reason: 'scope test' },
      worlds: new WorldRegistry(),
      githubApp: {
        status: () => ({ userAuthorized: false }),
        deliverWebhook: async (...args: Parameters<GitHubAppService['deliverWebhook']>) => {
          if (webhookFailure) throw webhookFailure;
          const result = { accepted: true, events: [], projectEvents: webhookProjectEvents };
          await args[4](result);
          return result;
        },
      },
    } as any));
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    // Exactly the developer profile's task authority, scoped to one project of
    // one organization — the shape a workflow mints for an agent.
    token = (await tokens.mintPrincipal('user:a', ['task:*', 'project:read'], mine, 60_000, acme.id)).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('audits denied reads but omits successful read traffic', async () => {
    const count = async () => Number(((await store.db.prepare('SELECT COUNT(*) n FROM audit_log').get()) as any).n);
    const before = await count();
    expect((await fetch(`${base}/api/projects/${mine}`, { headers: auth() })).status).toBe(200);
    expect(await count()).toBe(before);
    expect((await fetch(`${base}/api/projects/${theirs}`, { headers: auth() })).status).toBe(403);
    expect(await count()).toBe(before + 1);
  });

  it('refuses PATCH/DELETE /api/tags/:id across a project and tenant boundary', async () => {
    const foreign = (await store.createTag({ projectId: theirs, name: 'security' }));
    const own = (await store.createTag({ projectId: mine, name: 'bug' }));

    const renamed = await fetch(`${base}/api/tags/${foreign.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'pwned' }),
    });
    expect(renamed.status).toBe(403);
    const removed = await fetch(`${base}/api/tags/${foreign.id}`, { method: 'DELETE', headers: auth() });
    expect(removed.status).toBe(403);
    expect((await store.getTag(foreign.id))?.name).toBe('security');

    // The same call inside the token's own project is untouched.
    const ok = await fetch(`${base}/api/tags/${own.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'defect' }),
    });
    expect(ok.status).toBe(200);
    expect((await store.getTag(own.id))?.name).toBe('defect');
  });

  it('reports Advanced access from the scoped token without exposing unauthorized controls', async () => {
    const readOnly = await fetch(`${base}/api/settings/access?projectId=${mine}`, { headers: auth() });
    expect(readOnly.status).toBe(200);
    expect(await readOnly.json()).toMatchObject({ project: false, organization: false });

    const maintainer = (await tokens.mintPrincipal('user:a', ['project:read', 'project:delete'], mine, 60_000)).token;
    const allowed = await fetch(`${base}/api/settings/access?projectId=${mine}`, {
      headers: { authorization: `Bearer ${maintainer}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ project: false, projectDelete: true });

    const editor = (await tokens.mintPrincipal('user:a', ['project:read', 'project:edit'], mine, 60_000)).token;
    const editable = await fetch(`${base}/api/settings/access?projectId=${mine}`, {
      headers: { authorization: `Bearer ${editor}` },
    });
    expect(editable.status).toBe(200);
    expect(await editable.json()).toMatchObject({ project: true, projectDelete: false });

    const foreign = await fetch(`${base}/api/settings/access?projectId=${theirs}`, { headers: auth() });
    expect(foreign.status).toBe(403);
  });

  it('exposes a hosted over-member downgrade as an explicit blocked entitlement state', async () => {
    (await store.setOrganizationPlan(acmeId, 'team'));
    (await store.setOrganizationMembership(acmeId, 'extra-1', 'member'));
    (await store.setOrganizationMembership(acmeId, 'extra-2', 'member'));
    (await store.setOrganizationPlan(acmeId, 'free'));
    const organizationReader = (await tokens.mintPrincipal('user:a', ['organization:read'], undefined, 60_000, acmeId)).token;

    const response = await fetch(`${base}/api/organizations/${acmeId}/entitlements`, {
      headers: { authorization: `Bearer ${organizationReader}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deployment: 'hosted', plan: 'free', currentMemberCount: 3, maxMembers: 1,
      overMemberLimit: true, memberAdmissionAllowed: false, agentRunAdmissionAllowed: false,
    });

    (await store.removeOrganizationMembership(acmeId, 'extra-1'));
    (await store.removeOrganizationMembership(acmeId, 'extra-2'));
    (await store.setOrganizationPlan(acmeId, 'team'));
  });

  it('lets only an organization owner change managed funding while admins may edit ordinary guardrails', async () => {
    (await store.setOrganizationPlan(acmeId, 'team'));
    (await store.setOrganizationMembership(acmeId, 'b', 'admin'));
    const ownerToken = (await tokens.mintPrincipal('user:a', ['organization:read', 'organization:edit'], undefined, 60_000, acmeId)).token;
    const adminToken = (await tokens.mintPrincipal('user:b', ['organization:read', 'organization:edit'], undefined, 60_000, acmeId)).token;
    (gateway as any).sessions.set('owner-usage-session', { user: 'a', userId: 'a', apiToken: ownerToken });
    (gateway as any).sessions.set('admin-usage-session', { user: 'b', userId: 'b', apiToken: adminToken });
    const endpoint = `${base}/api/organizations/${acmeId}/usage-policy`;
    const put = (bearer: string, policy: Record<string, unknown>) => fetch(endpoint, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ policy }),
    });

    const denied = await put('admin-usage-session', { managedSpendCapMicros: 1_000_000 });
    expect({ status: denied.status, body: await denied.json() }).toEqual({ status: 403,
      body: { error: 'only an organization owner can change managed funding or agent concurrency guardrails' } });
    const deniedConcurrency = await put('admin-usage-session', { maxActiveAgentTurns: 3 });
    expect({ status: deniedConcurrency.status, body: await deniedConcurrency.json() }).toEqual({ status: 403,
      body: { error: 'only an organization owner can change managed funding or agent concurrency guardrails' } });
    const deniedManagedAdd = await put('admin-usage-session', { managedModelProviders: ['openai'] });
    expect({ status: deniedManagedAdd.status, body: await deniedManagedAdd.json() }).toEqual({ status: 403,
      body: { error: 'only an organization owner can change managed funding or agent concurrency guardrails' } });
    expect((await put('owner-usage-session', { managedSpendCapMicros: 1_000_000,
      managedModelProviders: ['openai'], maxActiveAgentTurns: 3 })).status).toBe(200);
    const deniedManagedRemove = await put('admin-usage-session', { managedModelProviders: [] });
    expect({ status: deniedManagedRemove.status, body: await deniedManagedRemove.json() }).toEqual({ status: 403,
      body: { error: 'only an organization owner can change managed funding or agent concurrency guardrails' } });
    expect((await put('admin-usage-session', { allowedModelProviders: ['openai'],
      allowedModels: ['openai/gpt-5'], maxAgentStartsPerMinute: 12,
      maxRemoteStartsPerMinute: 6 })).status).toBe(200);
    const read = await fetch(endpoint, { headers: { authorization: 'Bearer owner-usage-session' } });
    expect(await read.json()).toMatchObject({ managedSpendCapMicros: 1_000_000,
      managedModelProviders: ['openai'], allowedModelProviders: ['openai'], allowedModels: ['openai/gpt-5'],
      maxAgentStartsPerMinute: 12, maxRemoteStartsPerMinute: 6, maxActiveAgentTurns: 3 });
  });

  it('renames only with edit authority in the matching project or organization', async () => {
    const projectEditor = (await tokens.mintPrincipal('user:a', ['project:read', 'project:edit'], mine, 60_000, acmeId)).token;
    const renamedProject = await fetch(`${base}/api/projects/${mine}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${projectEditor}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Customer portal' }),
    });
    expect(renamedProject.status).toBe(200);
    expect(await renamedProject.json()).toMatchObject({ id: mine, name: 'Customer portal' });

    const denied = await fetch(`${base}/api/projects/${theirs}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${projectEditor}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Not mine' }),
    });
    expect(denied.status).toBe(403);

    const organizationEditor = (await tokens.mintPrincipal('user:a', ['organization:read', 'organization:edit'],
      undefined, 60_000, acmeId)).token;
    const slug = (await store.getOrganization(acmeId))!.slug;
    const renamedOrganization = await fetch(`${base}/api/organizations/${acmeId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${organizationEditor}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Labs' }),
    });
    expect(renamedOrganization.status).toBe(200);
    expect(await renamedOrganization.json()).toMatchObject({ id: acmeId, name: 'Acme Labs', slug });
    expect((await store.getOrganization(acmeId))?.slug).toBe(slug);
  });

  it('accepts a scope-only request through HTTP and exposes the added projects for review', async () => {
    const second = (await store.createProject('Phase', {}, acmeId));
    const task = (await store.createTask({ projectId: mine, title: 'Cross-project work', workflow: 'software-dev',
      workflowVersion: '1.9.0', createdBy: { kind: 'user', userId: 'a' },
      params: { prompt: 'read phase', _authorization: {
        level: 'developer', scope: 'projects', projectIds: [mine], capabilities: ['task:read'],
      } } }));
    (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do',
      status: 'active', messages: [], actions: [], state: {}, updatedAt: Date.now() }));
    liveView = (await store.getTask(task.id))!.lastView;
    const agent = (await tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', principal: 'user:a',
      projectId: mine, organizationId: acmeId, ceiling: ['task:escalate'], grantorCaps: ['task:escalate'] })).token;
    const post = (projectIds: unknown) => fetch(`${base}/api/agent/permission-requests`, { method: 'POST',
      headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: [], projectIds, audience: ['@creator'], reason: 'Read phase work.' }) });
    expect((await post([theirs])).status).toBe(400);
    expect((await post('invalid')).status).toBe(400);
    const response = await post([second.id]);
    expect(response.status).toBe(200);
    const requested: any = await response.json();
    expect(requested).toMatchObject({ status: 'needs_approval', capabilities: [], projectIds: [second.id] });
    const persisted = (await new PermissionRequests(store, acmeId).requests({ taskId: task.id }));
    expect(persisted).toEqual([expect.objectContaining({ projectIds: [second.id],
      baseAuthorization: { level: 'developer', scope: 'projects', projectIds: [mine] } })]);
    const denial = await fetch(`${base}/api/permission-requests/${requested.requestId}/resolve?organizationId=${acmeId}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ action: 'deny' }),
    });
    expect(denial.status).toBe(200);
    expect(((await store.getTask(task.id))!.params._authorization as any).projectIds).toEqual([mine]);
  });

  it('serves routed permission requests in Approval Requests and enforces the approver capability', async () => {
    const task = (await store.createTask({
      projectId: mine,
      title: 'Configure email',
      workflow: 'software-dev',
      workflowVersion: '1.9.0',
      params: { prompt: 'inspect email' },
      createdBy: { kind: 'user', userId: 'a' },
    }));
    (await store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: task.workflow,
      stage: 'do',
      status: 'active',
      messages: [],
      actions: [],
      state: {},
      updatedAt: Date.now(),
    }));
    liveView = (await store.getTask(task.id))!.lastView;
    const agent = (await tokens.mint({
      taskId: task.id,
      profileId: 'do-default',
      role: 'do',
      principal: 'user:a',
      projectId: mine,
      organizationId: (await store.getProject(mine))!.organizationId,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    })).token;
    const requested: any = await (await fetch(`${base}/api/agent/permission-requests`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: ['settings:read'],
        audience: ['@creator'],
        reason: 'Inspect outbound email configuration.',
      }),
    })).json();
    expect(requested).toMatchObject({ status: 'needs_approval', capabilities: ['settings:read'] });

    const approver = (await tokens.mintPrincipal(
      'user:a',
      ['task:read', 'settings:read'],
      mine,
      60_000,
      (await store.getProject(mine))!.organizationId,
    )).token;
    const listed: any = await (await fetch(
      `${base}/api/permission-requests?taskId=${task.id}&organizationId=${(await store.getProject(mine))!.organizationId}`,
      { headers: { authorization: `Bearer ${approver}` } },
    )).json();
    expect(listed).toEqual([
      expect.objectContaining({
        id: requested.requestId,
        type: 'permission',
        role: 'do',
        task: expect.objectContaining({ id: task.id, title: task.title }),
      }),
    ]);

    const viewUrl = `${base}/api/tasks/${task.id}`;
    const headers = { authorization: `Bearer ${approver}`, 'content-type': 'application/json' };
    expect(await (await fetch(viewUrl, { headers })).json()).toMatchObject({ approvalRequests: 1 });
    const dismissed = await fetch(
      `${base}/api/permission-requests/${requested.requestId}/resolve?organizationId=${(await store.getProject(mine))!.organizationId}`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss' }) },
    );
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ status: 'pending', dismissed: { by: 'user:a' } });
    expect(await (await fetch(viewUrl, { headers })).json()).not.toHaveProperty('approvalRequests');
    expect((await new PermissionRequests(store, (await store.getProject(mine))!.organizationId!).requests({ taskId: task.id })))
      .toEqual([expect.objectContaining({ status: 'pending', dismissed: expect.any(Object) })]);

    const resolved = await fetch(
      `${base}/api/permission-requests/${requested.requestId}/resolve?organizationId=${(await store.getProject(mine))!.organizationId}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${approver}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      },
    );
    expect(resolved.status).toBe(200);
    expect((await new PermissionRequests(store, (await store.getProject(mine))!.organizationId!).extensionCaps(task.id, 'do')))
      .toEqual(['settings:read']);
  });

  it('refuses PATCH/DELETE/reorder /api/views/:id across a project and tenant boundary', async () => {
    const foreign = (await store.createView({ projectId: theirs, name: 'Theirs', query: {} as any }));
    const own = (await store.createView({ projectId: mine, name: 'Mine', query: {} as any }));

    for (const [method, suffix, body] of [
      ['PATCH', '', JSON.stringify({ name: 'pwned' })],
      ['POST', '/reorder', JSON.stringify({ ord: 0 })],
      ['DELETE', '', undefined],
    ] as const) {
      const response = await fetch(`${base}/api/views/${foreign.id}${suffix}`, { method, headers: auth(), body });
      expect(response.status, `${method} /api/views/:id${suffix}`).toBe(403);
    }
    expect((await store.getView(foreign.id))?.name).toBe('Theirs');

    const ok = await fetch(`${base}/api/views/${own.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(ok.status).toBe(200);
  });

  /**
   * `Gateway.fail` used to flatten every non-CapabilityError to a 500, so
   * `no such task <id>` reached an agent looking like a server fault ("back
   * off") rather than a bad identifier ("retry with another id").
   */
  /** PL-6: POST /api/tasks/:id/messages is message_agent's route, authorized as
   *  task:conversation:message — and it stays inside the token's tenant. */
  it('delivers message_agent under task:conversation:message, within the tenant', async () => {
    const acmeTask = (await store.createTask({ projectId: mine, title: 'Fork', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const otherTask = (await store.createTask({ projectId: theirs, title: 'Theirs', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    for (const t of [acmeTask, otherTask]) (await store.saveView(t.id, {
      taskId: t.id, title: t.title, workflow: t.workflow, stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1,
    }));
    const messenger = (await tokens.mintPrincipal('user:a', ['task:read', 'task:conversation:message'], mine, 60_000, acmeId)).token;
    const send = (taskId: string, bearer: string) => fetch(`${base}/api/tasks/${taskId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'do', text: 'rebase please' }),
    });
    const ok = await send(acmeTask.id, messenger);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).message).toMatchObject({ role: 'user', text: 'rebase please' });
    expect((await send(otherTask.id, messenger)).status).toBe(403);
    const signaller = (await tokens.mintPrincipal('user:a', ['task:read', 'task:signal'], mine, 60_000, acmeId)).token;
    expect((await send(acmeTask.id, signaller)).status).toBe(403);
  });

  // `?projectId=` used to outrank the addressed task's own project, so a token
  // for one project could read, and run review actions in, any tenant's task
  // just by naming its own project. The record decides; a contradiction is refused.
  it('refuses a projectId or organizationId that contradicts the addressed task', async () => {
    const foreign = (await store.createTask({ projectId: theirs, title: 'Theirs', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const own = (await store.createTask({ projectId: mine, title: 'Mine', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    for (const t of [foreign, own]) (await store.saveView(t.id, {
      taskId: t.id, title: t.title, workflow: t.workflow, stage: 'review', status: 'waiting', messages: [], actions: [], state: {}, updatedAt: 1,
      reviewInfo: { summary: 'Check it', actions: [{ kind: 'open', label: 'Report', path: 'report.md' }] },
    } as any));
    const request = (taskId: string, route: string, query: string, init: RequestInit = {}) =>
      fetch(`${base}/api/tasks/${taskId}/${route}${route.includes('?') ? '&' : '?'}${query}`, { headers: auth(), ...init });
    const routes: Array<[string, RequestInit]> = [
      ['responsibility', {}], ['subscribers', {}], ['widgets', {}], ['artifact?path=.env', {}],
      ['review-action', { method: 'POST', body: JSON.stringify({ index: 0 }) }],
      ['checkout', { method: 'POST', body: '{}' }], ['desktop', { method: 'POST', body: '{}' }],
    ];
    for (const [route, init] of routes) {
      expect((await request(foreign.id, route, `projectId=${mine}`, init)).status, `${route} with a spoofed project`).toBe(403);
      expect((await request(foreign.id, route, `organizationId=${acmeId}`, init)).status, `${route} with a spoofed organization`).toBe(403);
    }
    // The task's own project may still be named, and a contradiction is refused
    // even for the caller's own task.
    expect((await request(own.id, 'subscribers', `projectId=${mine}`)).status).toBe(200);
    expect((await request(own.id, 'subscribers', `projectId=${theirs}`)).status).toBe(403);
    // Bare-id records resolve the same way.
    const foreignTag = (await store.createTag({ projectId: theirs, name: 'internal' }));
    expect((await fetch(`${base}/api/tags/${foreignTag.id}?projectId=${mine}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'pwned' }) })).status).toBe(403);
    expect((await store.getTag(foreignTag.id))?.name).toBe('internal');
  });

  // Routes that fall back to the stored view when the live one is unavailable
  // must not take that path when the live read was refused.
  it('never serves a stored view to a caller refused the live one', async () => {
    const task = (await store.createTask({ projectId: mine, title: 'Actions', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting', messages: [], actions: [], state: {}, updatedAt: 1,
      reviewInfo: { summary: 'Check it', actions: [{ kind: 'open', label: 'Report', path: 'report.md' }] },
    } as any));
    const executor = (await tokens.mintPrincipal('user:a', ['task:review:execute'], mine, 60_000, acmeId)).token;
    const response = await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST',
      headers: { authorization: `Bearer ${executor}`, 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }) });
    expect(response.status).toBe(403);
  });

  it('answers a missing identifier with 404 rather than 500', async () => {
    const missing = await fetch(`${base}/api/tasks/task_missing/tag`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ add: ['bug'] }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toMatch(/no such task/i);
  });

  /**
   * Only signature failures are authentication errors. Processing failures
   * return 500 and remain eligible for the durable inbox's local retries.
   */
  it('answers a GitHub webhook processing fault with 500, and a bad signature with 401', async () => {
    const deliver = () => fetch(`${base}/api/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
      body: JSON.stringify({ action: 'closed' }),
    });

    webhookFailure = new Error('invalid GitHub webhook signature');
    expect((await deliver()).status).toBe(401);

    webhookFailure = new Error('SQLITE_BUSY: database is locked');
    expect((await deliver()).status).toBe(500);

    webhookFailure = undefined;
    expect((await deliver()).status).toBe(200);
  });

  it('creates one durable recovery task for a post-merge workflow failure', async () => {
    webhookProjectEvents = [{
      projectId: mine,
      type: 'github.workflow.failed',
      payload: {
        repository: 'acme/app', repositoryId: 'repo-1', workflow: 'Deploy', runId: 700,
        attempt: 1, conclusion: 'failure', headSha: 'abc123', branch: 'main',
        url: 'https://github.com/acme/app/actions/runs/700', source: 'workflow_run',
      },
    }];
    const deliver = async (delivery: string) => fetch(`${base}/api/github/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-github-event': 'workflow_run', 'x-github-delivery': delivery },
      body: JSON.stringify({ action: 'completed' }),
    });
    const first = await deliver('workflow-recovery-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: true, recoveries: 1 });
    const recovery = (await store.listTasks(mine)).find((task) => task.title === 'Repair failed GitHub workflow: Deploy');
    expect(recovery?.params.prompt).toContain('Exact revision: abc123');
    expect((await store.eventsSince(recovery!.id, 0))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'github.workflow.failed' }),
    ]));

    // check_run and workflow_run can both describe the same Actions run; the
    // repository/run key prevents duplicate recovery work across deliveries.
    const duplicate = await deliver('workflow-recovery-2');
    expect(duplicate.status).toBe(200);
    expect((await store.listTasks(mine)).filter((task) => task.title === recovery!.title)).toHaveLength(1);
    webhookProjectEvents = [];
  });

  it('routes a missing deployment run through the same idempotent recovery rail', async () => {
    webhookProjectEvents = [{
      projectId: mine,
      type: 'github.workflow.failed',
      payload: {
        repository: 'acme/app', repositoryId: 'repo-1', workflow: 'Deploy', runId: 701,
        attempt: 1, conclusion: 'missing', headSha: 'def456', branch: 'main',
        url: 'https://github.com/acme/app/actions/runs/701', source: 'deployment_monitor',
        incidentKey: 'missing:def456:.github/workflows/deploy.yml',
        evidence: {
          kind: 'missing_deployment_run',
          workflowFile: { status: 'present', bytes: 100 },
          actionsQuery: { status: 'ok', runsChecked: 0 },
        },
      },
    }];
    const deliver = (delivery: string) => fetch(`${base}/api/github/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-github-event': 'workflow_run', 'x-github-delivery': delivery },
      body: JSON.stringify({ action: 'completed' }),
    });

    expect(await (await deliver('missing-recovery-1')).json()).toMatchObject({ recoveries: 1 });
    const recovery = (await store.listTasks(mine))
      .find((task) => task.title === 'Repair missing GitHub workflow: Deploy');
    expect(recovery?.params.prompt).toContain('was not created');
    expect(recovery?.params.prompt).toContain('Durable monitor evidence');
    expect(recovery?.params.prompt).toContain('workflow schema/registration');

    await deliver('missing-recovery-2');
    expect((await store.listTasks(mine)).filter((task) => task.title === recovery!.title)).toHaveLength(1);
    // Simulate a restart after createTask persisted but before the pending claim
    // was acknowledged with the task id. The stale claim adopts that task.
    const recoveryKey = 'github:workflow-recovery:' + mine
      + ':repo-1:missing:def456:.github/workflows/deploy.yml';
    (await store.kvSet(recoveryKey, `pending:${Date.now() - 11 * 60_000}`));
    await deliver('missing-recovery-after-restart');
    expect((await store.listTasks(mine)).filter((task) => task.title === recovery!.title)).toHaveLength(1);
    expect((await store.kvGet(recoveryKey))).toBe(recovery!.id);
    webhookProjectEvents = [];
  });
});
