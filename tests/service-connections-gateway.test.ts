import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ServiceConnections, type ConnectionBackend } from '../src/integrations/service-connections.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

describe('connection gateway flow', () => {
  let store: Store, tokens: TokenAuthority, home: string, base: string, close: () => Promise<void>;
  let service: ServiceConnections, org: string, project: string, otherOrg: string, taskId: string, otherTask: string;
  let agent: string, forbiddenAgent: string; let live = false;
  const signal = vi.fn(async () => {});
  const execute = vi.fn(async () => ({ successful: true, data: { messages: [{ subject: 'Fixture mail' }] } }));
  const request = (p: string, options: { method?: string; body?: unknown; token?: string; user?: string } = {}) =>
    fetch(base + p, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: `test-user=${options.user ?? 'alice'}` }) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-gateway-'));
    store = new Store(':memory:'); tokens = new TokenAuthority();
    org = store.createOrganization({ name: 'Team', ownerUserId: 'alice' }).id;
    otherOrg = store.createOrganization({ name: 'Other', ownerUserId: 'eve' }).id;
    project = store.createProject('Project', {}, org).id;
    const createTask = () => store.createTask({ projectId: project, title: 'Read mail', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Read mail' }, createdBy: { kind: 'user', userId: 'alice' } });
    taskId = createTask().id; otherTask = createTask().id;
    const mint = (id: string, caps: string[]) => tokens.mint({ taskId: id, profileId: 'developer', role: 'do', executionId: 'measured-turn', executionAttempt: 2, principal: 'user:alice', projectId: project,
      organizationId: org, ceiling: caps, grantorCaps: caps }).token;
    agent = mint(taskId, ['task:read', 'credential:read', 'connection:use']);
    forbiddenAgent = mint(otherTask, ['task:read', 'credential:read', 'connection:use']);
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const backend: ConnectionBackend = { catalog: async () => [{ slug: 'gmail', name: 'Gmail' }],
      authorize: async () => ({ id: 'exact-account', url: 'https://connect.composio.dev/link/private' }),
      active: async () => live, session: async () => 'private-session',
      tools: async () => [{ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch mail', inputParameters: { type: 'object' } }], execute, disconnect: async () => {} };
    service = new ServiceConnections(store, broker, () => backend); await service.configure('secret-api-key');
    const client = { workflow: { getHandle: () => ({ signal, query: async () => ({ status: 'waiting', stage: 'do' }) }) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: home });
    const gateway = new Gateway({ store, tokens, api, client, worlds, broker, serviceConnections: service,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'test' },
      identity: { connectOrganizationNames: () => {}, listUsers: () => [], session: async (headers: Headers) => {
        const user = headers.get('cookie')?.split('=')[1];
        return user ? { user: { id: user, name: user, email: `${user}@test.invalid` }, session: { id: user } } : undefined;
      } } as any,
      authorization: { capabilities: (principal: string) => principal === 'user:alice' ? ['*'] : ['credential:read', 'task:read'], audit: () => {} } as any,
    });
    const running = await gateway.listen(await findFreePortFrom(49_300)); base = running.url; close = running.close;
  });
  afterAll(async () => { await close?.(); store?.close(); fs.rmSync(home, { recursive: true, force: true }); });

  it('renders a durable request, accepts owner sign-in, verifies the account, and resumes the exact task', async () => {
    const res = await request('/api/connections/request', { token: agent, method: 'POST', body: { toolkit: 'gmail', why: 'Read my mail' } });
    expect(res.status).toBe(200); const pending: any = await res.json();
    expect(pending.status).toBe('needs_connection');
    const id = pending.connection.id;
    const listing = await request(`/api/connections?taskId=${taskId}&organizationId=${org}`);
    expect((await listing.json() as any[])[0].id).toBe(id);
    const begin = await request(`/api/connections/connect?organizationId=${org}`, { method: 'POST', body: { id } });
    expect(begin.status).toBe(200); expect(await begin.json()).toMatchObject({ url: 'https://connect.composio.dev/link/private' });
    expect((await request(`/api/connections/${id}/refresh?organizationId=${org}`, { method: 'POST', body: {} })).status).toBe(200);
    expect(signal).not.toHaveBeenCalled();
    live = true;
    const refreshed = await request(`/api/connections/${id}/refresh?organizationId=${org}`, { method: 'POST', body: {} });
    expect(await refreshed.json()).toMatchObject({ status: 'active' });
    await vi.waitFor(() => expect(signal).toHaveBeenCalled());
    expect(signal.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(id) }), 'do']));
    const search = await request(`/api/connections/${id}/tools?search=mail`, { token: agent });
    expect(search.status).toBe(200); expect(await search.json()).toEqual([expect.objectContaining({ slug: 'GMAIL_FETCH_EMAILS' })]);
    const result = await request(`/api/connections/${id}/execute`, { token: agent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ successful: true });
    const timing = store.eventsOfType(taskId, 'timing').map(e => e.payload);
    expect(timing).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'service.execution', phase: 'end', turnId: 'measured-turn', attempt: 2, status: 'ok',
    })]));
    const report = await request(`/api/tasks/${taskId}/timing`);
    expect(report.status).toBe(200);
    expect((await report.json() as any).observations.length).toBeGreaterThan(0);
    expect((await request(`/api/tasks/${taskId}/timing`, { token: agent })).status).toBe(403);
    for (const secret of ['exact-account', 'private-session', 'Fixture mail', 'secret-api-key']) expect(JSON.stringify(timing)).not.toContain(secret);
    const exposed = JSON.stringify(await (await request('/api/connections', { token: agent })).json());
    for (const secret of ['exact-account', 'private-session', 'secret-api-key', '/link/private']) expect(exposed).not.toContain(secret);
  });
  it('enforces task, tenant, owner, and execution capability independently', async () => {
    const id = service.all()[0]!.id;
    expect((await request(`/api/connections/${id}/execute`, { token: forbiddenAgent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(403);
    expect((await request(`/api/connections/${id}/refresh?organizationId=${org}`, { user: 'bob', method: 'POST', body: {} })).status).toBe(403);
    expect((await request(`/api/connections/${id}/refresh?organizationId=${otherOrg}`, { method: 'POST', body: {} })).status).toBe(404);
    expect((await request(`/api/connections/connect`, { token: agent, method: 'POST', body: { id } })).status).toBe(403);
    const readOnly = tokens.mint({ taskId, profileId: 'reader', principal: 'user:alice', projectId: project, organizationId: org,
      ceiling: ['credential:read', 'task:read'], grantorCaps: ['credential:read', 'task:read'] }).token;
    expect((await request(`/api/connections/${id}/execute`, { token: readOnly, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(403);
    expect((await request(`/api/connections/${id}/access?organizationId=${org}`, { method: 'PUT', body: { projectIds: [project] } })).status).toBe(200);
    expect((await request(`/api/connections/${id}/execute`, { token: forbiddenAgent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(200);
  });
  it('declines an unclaimed request without requiring an account', async () => {
    const pending = service.request(org, 'slack', taskId, 'do', 'Read Slack');
    const response = await request(`/api/connections/${pending.id}/disconnect?organizationId=${org}`, { method: 'POST', body: {} });
    expect(response.status).toBe(200);
    expect(service.pending(taskId)).toHaveLength(0);
  });
  it('keeps provider configuration installation-scoped and write-only', async () => {
    expect(routeCapability('PUT', '/api/connections/config')).toBe('settings:write');
    const config = await request('/api/connections/config', { token: agent });
    expect(await config.json()).toEqual({ configured: true, canConfigure: false });
    expect((await request('/api/connections/config', { token: agent, method: 'PUT', body: { apiKey: 'other-key' } })).status).toBe(403);
  });
});
