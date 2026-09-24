import WebSocket from 'ws';
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
    store = (await Store.create(':memory:')); tokens = new TokenAuthority();
    org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
    otherOrg = (await store.createOrganization({ name: 'Other', ownerUserId: 'eve' })).id;
    project = (await store.createProject('Project', {}, org)).id;
    const createTask = async () => (await store.createTask({ projectId: project, title: 'Read mail', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Read mail' }, createdBy: { kind: 'user', userId: 'alice' } }));
    taskId = (await createTask()).id; otherTask = (await createTask()).id;
    const mint = async (id: string, caps: string[]) => (await tokens.mint({ taskId: id, profileId: 'developer', role: 'do', executionId: 'measured-turn', executionAttempt: 2, principal: 'user:alice', projectId: project,
      organizationId: org, ceiling: caps, grantorCaps: caps })).token;
    agent = (await mint(taskId, ['task:read', 'credential:read', 'connection:use']));
    forbiddenAgent = (await mint(otherTask, ['task:read', 'credential:read', 'connection:use']));
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const backend: ConnectionBackend = { catalog: async () => [{ slug: 'gmail', name: 'Gmail' }],
      authorize: async () => ({ id: 'exact-account', url: 'https://connect.composio.dev/link/private' }),
      active: async () => live, session: async () => 'private-session',
      tools: async () => [{ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch mail', inputParameters: { type: 'object' } }], execute, disconnect: async () => {} };
    service = new ServiceConnections(store, broker, () => backend); await service.configure('secret-api-key');
    const client = { workflow: { getHandle: () => ({ signal, query: async () => ({ status: 'waiting', stage: 'do' }) }) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: home });
    const gateway = (await Gateway.create({ store, tokens, api, client, worlds, broker, serviceConnections: service,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'test' },
      identity: { connectOrganizationNames: () => {}, listUsers: () => [], session: async (headers: Headers) => {
        const user = headers.get('cookie')?.split('=')[1];
        return user ? { user: { id: user, name: user, email: `${user}@test.invalid` }, session: { id: user } } : undefined;
      } } as any,
      authorization: { capabilitiesAsync: async (principal: string) => principal === 'user:alice' ? ['*'] : ['credential:read', 'task:read'], audit: () => {} } as any,
    }));
    const running = await gateway.listen(await findFreePortFrom(49_300)); base = running.url; close = running.close;
  });
  afterAll(async () => { await close?.(); (await store?.close()); fs.rmSync(home, { recursive: true, force: true }); });

  it('defaults off and requires installation authority for opt-in', async () => {
    expect(await (await request('/api/settings/global/timing')).json()).toEqual({enabled:false});
    expect((await request('/api/meta').then(r=>r.json()) as any).timingEnabled).toBe(false);
    expect((await request('/api/settings/global/timing', {token:agent, method:'PUT',body:{values:{enabled:true}}})).status).toBe(403);
    expect((await request('/api/settings/global/timing', {method:'PUT',body:{values:{enabled:'true'}}})).status).toBe(400);
    expect((await request('/api/settings/global/timing', {method:'PUT',body:{values:{enabled:true}}})).status).toBe(200);
  });
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
    const timing = (await store.eventsOfType(taskId, 'timing')).map(e => e.payload);
    expect(timing).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'service.execution', phase: 'end', turnId: 'measured-turn', attempt: 2, status: 'ok',
    })]));
    const report = await request(`/api/tasks/${taskId}/timing`);
    expect(report.status).toBe(200);
    expect((await report.json() as any).observations.length).toBeGreaterThan(0);
    expect((await request(`/api/tasks/${taskId}/timing`, { token: agent })).status).toBe(403);
    for (const secret of ['exact-account', 'private-session', 'Fixture mail', 'secret-api-key']) expect(JSON.stringify(timing)).not.toContain(secret);
    await request('/api/settings/global/timing', {method:'PUT',body:{values:{enabled:false}}});
    expect((await request(`/api/tasks/${taskId}/timing`)).status).not.toBe(200);
    expect((await (await request(`/api/tasks/${taskId}/events`)).json() as any[]).some(e=>e.type==='timing')).toBe(false);
    expect((await (await request(`/api/activity?organizationId=${org}`)).json() as any[]).some(e=>e.type==='timing')).toBe(false);
    const count = (await store.eventsOfType(taskId,'timing')).length;
    expect(count).toBeGreaterThan(0);
    expect((await request(`/api/connections/${id}/execute`, { token: agent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(200);
    expect((await store.eventsOfType(taskId,'timing'))).toHaveLength(count);
    await request('/api/settings/global/timing', {method:'PUT',body:{values:{enabled:true}}});
    expect((await request(`/api/tasks/${taskId}/timing`)).status).toBe(200);
    const exposed = JSON.stringify(await (await request('/api/connections', { token: agent })).json());
    for (const secret of ['exact-account', 'private-session', 'secret-api-key', '/link/private']) expect(exposed).not.toContain(secret);
  });
  it('pushes settings to existing sockets and hides timing events while off', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', {headers:{cookie:'test-user=alice'}});
    const messages: any[] = [];
    ws.on('message',data=>messages.push(JSON.parse(String(data))));
    try {
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='timing.setting' && e.enabled===true)).toBe(true));
      (await store.setSettings('global','timing',{enabled:false}));
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='timing.setting' && e.enabled===false)).toBe(true), {timeout:3000});
      (await store.appendEvent({taskId,type:'timing',ts:Date.now(),payload:{name:'hidden'}}));
      (await store.appendEvent({taskId,type:'fixture.visible',ts:Date.now(),payload:{}}));
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='fixture.visible')).toBe(true));
      expect(messages.some(e=>e.type==='timing')).toBe(false);
    } finally {ws.close();}
  });
  it('enforces task, tenant, owner, and execution capability independently', async () => {
    const id = (await service.all())[0]!.id;
    expect((await request(`/api/connections/${id}/execute`, { token: forbiddenAgent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(403);
    expect((await request(`/api/connections/${id}/refresh?organizationId=${org}`, { user: 'bob', method: 'POST', body: {} })).status).toBe(403);
    expect((await request(`/api/connections/${id}/refresh?organizationId=${otherOrg}`, { method: 'POST', body: {} })).status).toBe(404);
    expect((await request(`/api/connections/connect`, { token: agent, method: 'POST', body: { id } })).status).toBe(403);
    const readOnly = (await tokens.mint({ taskId, profileId: 'reader', principal: 'user:alice', projectId: project, organizationId: org,
      ceiling: ['credential:read', 'task:read'], grantorCaps: ['credential:read', 'task:read'] })).token;
    expect((await request(`/api/connections/${id}/execute`, { token: readOnly, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(403);
    expect((await request(`/api/connections/${id}/access?organizationId=${org}`, { method: 'PUT', body: { projectIds: [project] } })).status).toBe(200);
    expect((await request(`/api/connections/${id}/execute`, { token: forbiddenAgent, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(200);
  });
  it('lets the owner allow an existing account for another task without signing in again', async () => {
    const account = (await service.all()).find(c => c.toolkit === 'gmail' && c.status === 'active')!.id;
    const elsewhere = (await store.createProject('Elsewhere', {}, org)).id;
    const task = (await store.createTask({ projectId: elsewhere, title: 'Mail', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Mail' }, createdBy: { kind: 'user', userId: 'alice' } })).id;
    const mint = async (caps: string[]) => (await tokens.mint({ taskId: task, profileId: 'developer', role: 'do', principal: 'user:alice',
      projectId: elsewhere, organizationId: org, ceiling: caps, grantorCaps: caps })).token;
    // A task that could not use the account must not send its owner through sign-in first.
    expect((await request('/api/connections/request', { token: await mint(['task:read', 'credential:read']), method: 'POST', body: { toolkit: 'gmail', why: 'Mail' } })).status).toBe(403);
    const token = await mint(['task:read', 'credential:read', 'connection:use']);
    const pending: any = await (await request('/api/connections/request', { token, method: 'POST', body: { toolkit: 'gmail', why: 'Mail' } })).json();
    expect(pending.status).toBe('needs_connection');
    const rows = await (await request(`/api/connections?taskId=${task}&organizationId=${org}`)).json() as any[];
    expect(rows).toEqual([expect.objectContaining({ id: pending.connection.id, reusable: [{ id: account, label: 'gmail' }] })]);
    expect((await (await request(`/api/connections?taskId=${task}&organizationId=${org}`, { user: 'bob' })).json() as any[])[0]?.reusable ?? []).toEqual([]);
    const allowed = await request(`/api/connections/connect?organizationId=${org}`, { method: 'POST', body: { id: pending.connection.id, useConnectionId: account } });
    expect(await allowed.json()).toEqual({ connection: expect.objectContaining({ status: 'active' }) });
    await vi.waitFor(() => expect(signal.mock.calls.some(call => JSON.stringify(call).includes(pending.connection.id))).toBe(true));
    const result = await request(`/api/connections/${pending.connection.id}/execute`, { token, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } });
    expect(result.status).toBe(200);
    expect((await request(`/api/connections/${account}/execute`, { token, method: 'POST', body: { tool: 'GMAIL_FETCH_EMAILS', arguments: {} } })).status).toBe(403);
  });
  it('declines an unclaimed request without requiring an account', async () => {
    const pending = (await service.request(org, 'slack', taskId, 'do', 'Read Slack'));
    const response = await request(`/api/connections/${pending.id}/disconnect?organizationId=${org}`, { method: 'POST', body: {} });
    expect(response.status).toBe(200);
    expect((await service.pending(taskId))).toHaveLength(0);
  });
  it('keeps provider configuration installation-scoped and write-only', async () => {
    expect(routeCapability('PUT', '/api/connections/config')).toBe('settings:write');
    const config = await request('/api/connections/config', { token: agent });
    expect(await config.json()).toEqual({ configured: true, canConfigure: false });
    expect((await request('/api/connections/config', { token: agent, method: 'PUT', body: { apiKey: 'other-key' } })).status).toBe(403);
  });
  it('includes project-shared accounts in human Tools search without exposing other private accounts', async () => {
    const shared = await service.connect(org, 'bob', { toolkit: 'calendar' });
    await service.share(org, shared.connection.id, 'bob', [project]);
    const privateAccount = await service.connect(org, 'bob', { toolkit: 'drive' });
    const response = await request(`/api/connections?organizationId=${org}&projectId=${project}`);
    expect(response.status).toBe(200);
    const rows = await response.json() as any[];
    expect(rows.some(c => c.id === shared.connection.id)).toBe(true);
    expect(rows.some(c => c.id === privateAccount.connection.id)).toBe(false);
    expect((await request(`/api/connections?organizationId=${otherOrg}&projectId=${project}`)).status).toBe(403);
    expect((await request(`/api/connections/${shared.connection.id}/disconnect?organizationId=${org}`, { method: 'POST', body: {} })).status).toBe(403);
  });

});
