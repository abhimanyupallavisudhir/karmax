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
import * as network from '../src/mcp/connections/http.js';

describe('connection gateway flow', () => {
  let store: Store, tokens: TokenAuthority, home: string, base: string, close: () => Promise<void>;
  let service: ServiceConnections, org: string, project: string, otherOrg: string, taskId: string, otherTask: string;
  let agent: string, forbiddenAgent: string; let live = false;
  const signal = vi.fn(async () => {});
  const execute = vi.fn(async () => ({ successful: true, data: { messages: [{ subject: 'Fixture mail' }] } }));
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'MCP fixture mail' }] }));
  const openMcp = vi.fn(async () => ({ listTools: async () => ({ tools: [{ name: 'search_emails', description: 'Search mail', inputSchema: { type: 'object' } }] }),
    callTool, close: async () => {} }) as any);
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
    service = new ServiceConnections(store, broker, () => backend, openMcp); await service.configure('secret-api-key');
    const client = { workflow: { getHandle: () => ({ signal, query: async () => ({ status: 'waiting', stage: 'do', actions: [] }) }) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: home });
    const gateway = (await Gateway.create({ store, tokens, api, client, worlds, broker, serviceConnections: service,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'test' },
      identity: { sessionActive: async (id: string, userId: string) => id === userId, connectOrganizationNames: () => {}, listUsers: () => [], session: async (headers: Headers) => {
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
    // Events recorded while timing is on reach a live socket; only events
    // recorded while it is off must stay hidden. The "on" event is recorded once
    // the socket is live: one recorded before it connects may or may not be
    // replayed, and asserting it was is what made this test flaky.
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', {headers:{cookie:'test-user=alice'}});
    const messages: any[] = [];
    ws.on('message',data=>messages.push(JSON.parse(String(data))));
    const timing = (name: string) => messages.some(e=>e.type==='timing' && e.payload?.name===name);
    try {
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='timing.setting' && e.enabled===true)).toBe(true));
      (await store.appendEvent({taskId,type:'timing',ts:Date.now(),payload:{name:'recorded-while-on'}}));
      await vi.waitFor(()=>expect(timing('recorded-while-on')).toBe(true), {timeout:3000});
      (await store.setSettings('global','timing',{enabled:false}));
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='timing.setting' && e.enabled===false)).toBe(true), {timeout:3000});
      (await store.appendEvent({taskId,type:'timing',ts:Date.now(),payload:{name:'hidden'}}));
      (await store.appendEvent({taskId,type:'fixture.visible',ts:Date.now(),payload:{}}));
      await vi.waitFor(()=>expect(messages.some(e=>e.type==='fixture.visible')).toBe(true));
      expect(timing('hidden')).toBe(false);
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
  it('requests a native MCP server, finishes the owner sign-in callback, resumes the task, and calls its tools', async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    vi.spyOn(network, 'publicStreamFetch').mockResolvedValue(new Response('', { status: 401 }));
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); const body = await req.text();
      if (req.url.includes('oauth-protected-resource')) return json({ resource: 'https://mail.example/mcp', authorization_servers: ['https://auth.example'] });
      if (req.url.includes('.well-known')) return json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      if (req.url.endsWith('/register')) return json({ ...JSON.parse(body), client_id: 'client' });
      if (req.url.endsWith('/token')) return json({ access_token: 'mcp-access-secret', token_type: 'Bearer', refresh_token: 'mcp-refresh-secret', expires_in: 3600 });
      throw new Error(`Unexpected request ${req.url}`);
    });
    expect((await request('/api/connections/request', { token: agent, method: 'POST', body: { why: 'Read mail' } })).status).toBe(400);
    const pending: any = await (await request('/api/connections/request', { token: agent, method: 'POST', body: { mcp: 'https://mail.example/mcp', why: 'Read mail' } })).json();
    expect(pending).toMatchObject({ status: 'needs_connection', connection: { label: 'mail.example', mcp: { auth: 'oauth' } } });
    const id = pending.connection.id;
    const begin: any = await (await request(`/api/connections/connect?organizationId=${org}`, { method: 'POST', body: { id } })).json();
    expect(begin).toMatchObject({ callback: 'mcp', connection: { status: 'connecting' } });
    const authorization = new URL(begin.url);
    expect(authorization.searchParams.get('redirect_uri')).toMatch(/\/mcp-callback$/);
    const state = authorization.searchParams.get('state');
    expect((await request(`/api/connections/${id}/callback?organizationId=${org}`, { user: 'bob', method: 'POST', body: { state, code: 'code' } })).status).toBe(403);
    signal.mockClear();
    const finished = await request(`/api/connections/${id}/callback?organizationId=${org}`, { method: 'POST', body: { state, code: 'code' } });
    expect(await finished.json()).toMatchObject({ status: 'active' });
    await vi.waitFor(() => expect(signal.mock.calls.some(call => JSON.stringify(call).includes(id))).toBe(true));
    const tools: any = await (await request(`/api/connections/${id}/tools?search=mail`, { token: agent })).json();
    expect(tools).toEqual([expect.objectContaining({ slug: 'search_emails' })]);
    const result = await request(`/api/connections/${id}/execute`, { token: agent, method: 'POST', body: { tool: 'search_emails', arguments: { query: 'invoice' } } });
    expect(await result.json()).toEqual({ content: [{ type: 'text', text: 'MCP fixture mail' }] });
    expect(openMcp).toHaveBeenLastCalledWith({ type: 'http', url: 'https://mail.example/mcp' }, { Authorization: 'Bearer mcp-access-secret' });
    const exposed = JSON.stringify([await (await request('/api/connections', { token: agent })).json(), await (await request(`/api/connections?organizationId=${org}`)).json()]);
    for (const secret of ['mcp-access-secret', 'mcp-refresh-secret', String(state)]) expect(exposed).not.toContain(secret);
    vi.restoreAllMocks();
  });
  it('declines an unclaimed request without requiring an account', async () => {
    const pending = (await service.request(org, 'slack', taskId, 'do', 'Read Slack'));
    const response = await request(`/api/connections/${pending.id}/disconnect?organizationId=${org}`, { method: 'POST', body: {} });
    expect(response.status).toBe(200);
    expect((await service.pending(taskId))).toHaveLength(0);
  });
  it.each(['connection', 'credential'])('dismisses a %s request without notifying the agent, leaving it answerable', async (kind) => {
    const task = (await store.createTask({ projectId: project, title: `Dismiss ${kind}`, workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'alice' } }));
    const token = (await tokens.mint({ taskId: task.id, profileId: 'developer', role: 'do', principal: 'user:alice', projectId: project,
      organizationId: org, ceiling: ['task:read', 'credential:read', 'connection:use'], grantorCaps: ['task:read', 'credential:read', 'connection:use'] })).token;
    let id: string; let resolve: (action: string) => Promise<Response>;
    if (kind === 'connection') {
      id = (await (await request('/api/connections/request', { token, method: 'POST', body: { toolkit: 'notion', why: 'Read notes' } })).json() as any).connection.id;
      resolve = (action) => request(`/api/connections/${id}/${action}?organizationId=${org}`, { method: 'POST', body: {} });
    } else {
      const item: any = await (await request(`/api/vault/items?organizationId=${org}`, { method: 'POST', body: {
        type: 'login', label: 'Dismissable', domains: 'dismiss.example.com', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } } })).json();
      const asked: any = await (await request('/api/vault/requests', { token, method: 'POST', body: { itemId: item.id, why: 'Sign in' } })).json();
      expect(asked.status).toBe('needs_approval');
      id = asked.requestId;
      resolve = (action) => request(`/api/vault/requests/${id}/resolve?organizationId=${org}`, { method: 'POST', body: { action } });
    }
    const view = async () => (await (await request(`/api/tasks/${task.id}`)).json()) as any;
    expect(await view()).toMatchObject({ approvalRequests: 1, pendingDecisions: 1 });
    const signals = signal.mock.calls.length;
    const dismissed = await resolve('dismiss');
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ dismissed: { by: expect.stringContaining('alice') } });
    expect(await view()).toMatchObject({ pendingDecisions: 1 });
    expect(await view()).not.toHaveProperty('approvalRequests');
    const events = (await store.eventsSince(task.id, 0)).map((event) => event.type);
    expect(events).toContain(kind === 'connection' ? 'connection.dismissed' : 'credential.approval-dismissed');
    expect(events).not.toContain('conversation.message');
    expect(signal.mock.calls.length).toBe(signals);
    // Dismissal only silences the ask: it can still be answered later.
    expect((await resolve(kind === 'connection' ? 'disconnect' : 'deny')).status).toBe(200);
    expect(await view()).not.toHaveProperty('pendingDecisions');
  });
  it('lets only the owner or a task editor dismiss a connection request', async () => {
    const pending = (await service.request(org, 'linear', otherTask, 'do', 'Read issues'));
    expect((await request(`/api/connections/${pending.id}/dismiss?organizationId=${org}`, { token: agent, method: 'POST', body: {} })).status).toBe(403);
    expect((await request(`/api/connections/${pending.id}/dismiss?organizationId=${org}`, { user: 'eve', method: 'POST', body: {} })).status).toBe(403);
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
