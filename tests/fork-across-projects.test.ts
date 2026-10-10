import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AppGrants, sessionCapabilities } from '../src/auth/app-grants.js';
import { stubGateway } from './helpers/stub-gateway.js';

/**
 * A person's API token is narrowed to the project of the route they called
 * (`/api/projects/<B>/tasks`). Forking an agent whose conversation lives in
 * another project A must be judged by what the person may read in A, not
 * refused because the route token names only B.
 */
async function fixture() {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  (await store.setOrganizationMembership('org_personal', 'dev', 'member'));
  const source = (await store.createProject('Pramana'));
  const target = (await store.createProject('Indike'));
  const authorization = (await AuthorizationService.create(store));
  for (const project of [source, target])
    (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(target.id), profileId: 'developer' }));
  const tokens = new TokenAuthority(store);
  // As the gateway wires it: a token minted for an app grant lives as long as the grant.
  tokens.connectIdentitySessions(async (sessionId, userId) => !sessionId.startsWith('grant_') || (await new AppGrants(store).live(sessionId, userId)));
  // What the gateway mints for a browser session on a route in `projectId`.
  // An app grant (CLI login, MCP client, personal token) mints the same token,
  // bound to the grant and attenuated by its ceiling.
  const routeToken = async (userId: string, projectId: string, grantId?: string) => {
    const grant = grantId ? (await new AppGrants(store).get(grantId)) : undefined;
    return (await tokens.mintPrincipal(`user:${userId}`, (await sessionCapabilities(authorization, userId, grant?.ceiling,
      { projectId, organizationId: 'org_personal' })), projectId, undefined, 'org_personal', grantId)).token;
  };
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const task = (await store.createTask({ projectId: source.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.26.0',
    createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'source' } }));
  (await store.kvSet(`session:${task.id}:do`, 'source-session'));
  return { store, source, target, api, routeToken, task, authorization, tokens };
}

describe('forking an agent from another project', () => {
  it('lets a person who can read the source conversation fork it into another project', async () => {
    const f = (await fixture());
    const fork = await f.api.createTask((await f.routeToken('owner', f.target.id)), { projectId: f.target.id, draft: true,
      params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: f.task.id, role: 'do' } } } });
    expect(fork.projectId).toBe(f.target.id);
    expect((fork.params['agent:do'] as any).resumeFrom).toEqual({ taskId: f.task.id, role: 'do' });
    (await f.store.close());
  });

  it("still refuses a person who cannot read the source project's conversations", async () => {
    const f = (await fixture());
    await expect(f.api.createTask((await f.routeToken('dev', f.target.id)), { projectId: f.target.id, draft: true,
      params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: f.task.id, role: 'do' } } } }))
      .rejects.toThrow(/missing capability task:conversation:read in project "Pramana"/);
    (await f.store.close());
  });

  it('keeps a CLI or personal token limited to its projects', async () => {
    const f = (await fixture());
    const grants = new AppGrants(f.store);
    const fork = { projectId: f.target.id, draft: true,
      params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: f.task.id, role: 'do' } } } };
    const limited = (await grants.create({ userId: 'owner', kind: 'cli', clientId: 'tavya-cli', name: 'laptop',
      ceiling: { projectIds: [f.target.id] } }));
    await expect(f.api.createTask((await f.routeToken('owner', f.target.id, limited.id)), fork))
      .rejects.toThrow(/missing capability task:conversation:read in project "Pramana"/);
    const signedIn = (await grants.create({ userId: 'owner', kind: 'cli', clientId: 'tavya-cli', name: 'desktop' }));
    expect((await f.api.createTask((await f.routeToken('owner', f.target.id, signedIn.id)), fork)).projectId).toBe(f.target.id);
    (await f.store.close());
  });

  it('does not reach into another organization through a person\'s grants', async () => {
    const f = (await fixture());
    const other = (await f.store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' }));
    const outside = (await f.store.createProject('Outside', {}, other.id));
    (await f.authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(outside.id), profileId: 'maintainer' }));
    const foreign = (await f.store.createTask({ projectId: outside.id, title: 'Foreign', workflow: 'software-dev', workflowVersion: '1.26.0',
      createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'foreign' } }));
    await expect(f.api.createTask((await f.routeToken('owner', f.target.id)), { projectId: f.target.id, draft: true,
      params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: foreign.id, role: 'do' } } } }))
      .rejects.toThrow(/belongs to another organization|scoped to/);
    (await f.store.close());
  });

  it("runs the fork when the task's authorization reaches the source project", async () => {
    const f = (await fixture());
    const create = async (projectIds: string[]) => f.api.createTask((await f.routeToken('owner', f.target.id)), {
      projectId: f.target.id, draft: true, authorization: { level: 'developer', scope: 'projects', projectIds },
      params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: f.task.id, role: 'do' } } } });
    // What the agent's turn mints from the stored grant, and the check it makes
    // before resuming the source conversation (activities/core.ts).
    const agentReads = async (task: Awaited<ReturnType<typeof create>>) => {
      const stored = task.params._authorization as { scope?: string; projectIds?: string[]; capabilities: string[]; delegationId?: string };
      const { token } = (await f.tokens.mint({ taskId: task.id, profileId: 'developer', role: 'do', principal: 'user:owner',
        projectIds: stored.scope === 'projects' ? stored.projectIds : undefined, organizationId: 'org_personal',
        audience: 'karmax-platform', delegationId: stored.delegationId, ceiling: stored.capabilities, grantorCaps: stored.capabilities } as any));
      return (await f.tokens.check(token, 'task:conversation:read', { taskId: f.task.id })).ok;
    };
    expect(await agentReads(await create([f.target.id]))).toBe(false);
    expect(await agentReads(await create([f.target.id, f.source.id]))).toBe(true);
    (await f.store.close());
  });
});

describe('forking an agent from another project over HTTP', () => {
  it('starts the fork from a signed-in browser session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-http-'));
    const previousHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = home;
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority(store);
    const authorization = (await AuthorizationService.create(store));
    (await store.claimPersonalOrganization('owner'));
    const source = (await store.createProject('Pramana'));
    const target = (await store.createProject('Indike'));
    for (const project of [source, target])
      (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
    const task = (await store.createTask({ projectId: source.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.26.0',
      createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'source' } }));
    (await store.kvSet(`session:${task.id}:do`, 'source-session'));
    const identity = { connectOrganizationNames() {}, connectAccountClosure() {}, listUsers: async () => [],
      session: async () => ({ user: { id: 'owner', name: 'Owner', email: 'owner@example.com' },
        session: { id: 'browser-session', expiresAt: new Date(Date.now() + 60_000) } }),
      sessionActive: async () => true, userById: async () => undefined };
    const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
    const h = await stubGateway({ store, tokens, api, authorization, identity: identity as any });
    try {
      const response = await fetch(`${h.base}/api/projects/${target.id}/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'krmax_session=browser' },
        body: JSON.stringify({ draft: true, params: { prompt: 'continue here', 'agent:do': { resumeFrom: { taskId: task.id, role: 'do' } } } }) });
      const body = await response.json() as any;
      expect(body.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(body.projectId).toBe(target.id);
    } finally {
      await h.close();
      if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
