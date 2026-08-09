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
  let base: string;
  let close: () => Promise<void>;
  let mine: string;
  let theirs: string;
  let acmeId: string;
  let token: string;
  let liveView: any;
  /** What the stub GitHub webhook handler throws on the next delivery. */
  let webhookFailure: Error | undefined;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-scope-'));
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    const acme = store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'b' });
    acmeId = acme.id;
    mine = store.createProject('Mine', {}, acme.id).id;
    theirs = store.createProject('Theirs', {}, other.id).id;
    // Permission approval now parks by starting a replacement at the exact
    // stage, so this software-dev fixture needs the repository its manifest
    // requires even though the Temporal client below is a stub.
    store.updateProjectConfig(mine, { repos: [home] });
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
    const gateway = new Gateway({
      api, store, tokens,
      bus: new KarmaxBus(),
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      authorization: new AuthorizationService(store),
      client,
      taskQueue: 'test',
      staticDir: home,
      agentInfo: { provider: 'mock', reason: 'scope test' },
      worlds: new WorldRegistry(),
      githubApp: {
        status: () => ({ userAuthorized: false }),
        handleWebhook: async () => {
          if (webhookFailure) throw webhookFailure;
          return { ok: true, events: [] };
        },
      },
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    // Exactly the developer profile's task authority, scoped to one project of
    // one organization — the shape a workflow mints for an agent.
    token = tokens.mintPrincipal('user:a', ['task:*', 'project:read'], mine, 60_000, acme.id).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses PATCH/DELETE /api/tags/:id across a project and tenant boundary', async () => {
    const foreign = store.createTag({ projectId: theirs, name: 'security' });
    const own = store.createTag({ projectId: mine, name: 'bug' });

    const renamed = await fetch(`${base}/api/tags/${foreign.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'pwned' }),
    });
    expect(renamed.status).toBe(403);
    const removed = await fetch(`${base}/api/tags/${foreign.id}`, { method: 'DELETE', headers: auth() });
    expect(removed.status).toBe(403);
    expect(store.getTag(foreign.id)?.name).toBe('security');

    // The same call inside the token's own project is untouched.
    const ok = await fetch(`${base}/api/tags/${own.id}`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'defect' }),
    });
    expect(ok.status).toBe(200);
    expect(store.getTag(own.id)?.name).toBe('defect');
  });

  it('reports Advanced access from the scoped token without exposing unauthorized controls', async () => {
    const readOnly = await fetch(`${base}/api/settings/access?projectId=${mine}`, { headers: auth() });
    expect(readOnly.status).toBe(200);
    expect(await readOnly.json()).toMatchObject({ project: false, organization: false });

    const maintainer = tokens.mintPrincipal('user:a', ['project:read', 'project:delete'], mine, 60_000).token;
    const allowed = await fetch(`${base}/api/settings/access?projectId=${mine}`, {
      headers: { authorization: `Bearer ${maintainer}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ project: false, projectDelete: true });

    const editor = tokens.mintPrincipal('user:a', ['project:read', 'project:edit'], mine, 60_000).token;
    const editable = await fetch(`${base}/api/settings/access?projectId=${mine}`, {
      headers: { authorization: `Bearer ${editor}` },
    });
    expect(editable.status).toBe(200);
    expect(await editable.json()).toMatchObject({ project: true, projectDelete: false });

    const foreign = await fetch(`${base}/api/settings/access?projectId=${theirs}`, { headers: auth() });
    expect(foreign.status).toBe(403);
  });

  it('renames only with edit authority in the matching project or organization', async () => {
    const projectEditor = tokens.mintPrincipal('user:a', ['project:read', 'project:edit'], mine, 60_000, acmeId).token;
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

    const organizationEditor = tokens.mintPrincipal('user:a', ['organization:read', 'organization:edit'],
      undefined, 60_000, acmeId).token;
    const slug = store.getOrganization(acmeId)!.slug;
    const renamedOrganization = await fetch(`${base}/api/organizations/${acmeId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${organizationEditor}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Labs' }),
    });
    expect(renamedOrganization.status).toBe(200);
    expect(await renamedOrganization.json()).toMatchObject({ id: acmeId, name: 'Acme Labs', slug });
    expect(store.getOrganization(acmeId)?.slug).toBe(slug);
  });

  it('serves routed permission requests in Approval Requests and enforces the approver capability', async () => {
    const task = store.createTask({
      projectId: mine,
      title: 'Configure email',
      workflow: 'software-dev',
      workflowVersion: '1.9.0',
      params: { prompt: 'inspect email' },
      createdBy: { kind: 'user', userId: 'a' },
    });
    store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: task.workflow,
      stage: 'do',
      status: 'active',
      messages: [],
      actions: [],
      state: {},
      updatedAt: Date.now(),
    });
    liveView = store.getTask(task.id)!.lastView;
    const agent = tokens.mint({
      taskId: task.id,
      profileId: 'do-default',
      role: 'do',
      principal: 'user:a',
      projectId: mine,
      organizationId: store.getProject(mine)!.organizationId,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    }).token;
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

    const approver = tokens.mintPrincipal(
      'user:a',
      ['task:read', 'settings:read'],
      mine,
      60_000,
      store.getProject(mine)!.organizationId,
    ).token;
    const listed: any = await (await fetch(
      `${base}/api/permission-requests?taskId=${task.id}&organizationId=${store.getProject(mine)!.organizationId}`,
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

    const resolved = await fetch(
      `${base}/api/permission-requests/${requested.requestId}/resolve?organizationId=${store.getProject(mine)!.organizationId}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${approver}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(new PermissionRequests(store, store.getProject(mine)!.organizationId!).extensionCaps(task.id, 'do'))
      .toEqual(['settings:read']);
  });

  it('refuses PATCH/DELETE/reorder /api/views/:id across a project and tenant boundary', async () => {
    const foreign = store.createView({ projectId: theirs, name: 'Theirs', query: {} as any });
    const own = store.createView({ projectId: mine, name: 'Mine', query: {} as any });

    for (const [method, suffix, body] of [
      ['PATCH', '', JSON.stringify({ name: 'pwned' })],
      ['POST', '/reorder', JSON.stringify({ ord: 0 })],
      ['DELETE', '', undefined],
    ] as const) {
      const response = await fetch(`${base}/api/views/${foreign.id}${suffix}`, { method, headers: auth(), body });
      expect(response.status, `${method} /api/views/:id${suffix}`).toBe(403);
    }
    expect(store.getView(foreign.id)?.name).toBe('Theirs');

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
  it('answers a missing identifier with 404 rather than 500', async () => {
    const missing = await fetch(`${base}/api/tasks/task_missing/tag`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ add: ['bug'] }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toMatch(/no such task/i);
  });

  /**
   * The webhook handler turned ANY exception into a 401, which makes GitHub
   * redeliver — but `handleWebhook` has already inserted the delivery dedupe row
   * by then, so the redelivery short-circuits as a duplicate and the reconcile is
   * lost forever. Only a real signature failure may answer 401.
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
});
