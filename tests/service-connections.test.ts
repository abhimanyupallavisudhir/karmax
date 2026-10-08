import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ServiceConnections, ComposioBackend, type ConnectionBackend } from '../src/integrations/service-connections.js';
import * as network from '../src/mcp/connections/http.js';

describe('service connections', () => {
  let home: string, store: Store, broker: CredentialBroker, service: ServiceConnections;
  let backend: ConnectionBackend; let org: string, project: string;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'service-connections-'));
    store = (await Store.create(':memory:')); broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
    project = (await store.createProject('Project', {}, org)).id;
    backend = { catalog: vi.fn(async () => [{ slug: 'gmail', name: 'Gmail' }]),
      authorize: vi.fn(async () => ({ id: 'ca_exact', url: 'https://connect.composio.dev/link/secret' })),
      active: vi.fn(async () => false), session: vi.fn(async () => 'session-private'),
      tools: vi.fn(async () => [{ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', inputParameters: { type: 'object' } }]),
      execute: vi.fn(async () => ({ successful: true, data: { messages: [] } })), disconnect: vi.fn(async () => {}) };
    service = new ServiceConnections(store, broker, () => backend);
    await service.configure('project-key-private');
  });
  afterEach(async () => { (await store.close()); fs.rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function connected(taskId = 'task_a') {
    const request = (await service.request(org, 'gmail', taskId, 'do', 'Read the requested mail'));
    const result = await service.connect(org, 'alice', { id: request.id });
    vi.mocked(backend.active).mockResolvedValue(true);
    await service.refresh(org, request.id);
    return result.connection.id;
  }
  it('deduplicates requests and links; never puts link secrets or session IDs in views', async () => {
    const request = (await service.request(org, 'gmail', 'task_a', 'do', 'Read mail'));
    const duplicates = await Promise.all([
      service.request(org, 'gmail', 'task_a', 'do', 'Read mail'),
      service.request(org, 'gmail', 'task_a', 'do', 'Read mail'),
    ]);
    expect(duplicates.map(value => value.id)).toEqual([request.id, request.id]);
    const [a, b] = await Promise.all([service.connect(org, 'alice', { id: request.id }), service.connect(org, 'alice', { id: request.id })]);
    expect(a.url).toBe(b.url); expect(backend.authorize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await store.kvEntries('service-connection:')))).not.toContain('/link/secret');
    vi.mocked(backend.active).mockResolvedValue(true); await service.refresh(org, request.id);
    const view = JSON.stringify((await service.list(org, { taskId: 'task_a', projectId: project })));
    for (const value of ['project-key-private', 'session-private', 'ca_exact', '/link/secret']) expect(view).not.toContain(value);
  });
  it('shares one durable provider identity across concurrent connection requests', async () => {
    const [gmail, slack] = await Promise.all([
      service.request(org, 'gmail', 'task_a', 'do', 'Read mail'),
      service.request(org, 'slack', 'task_a', 'do', 'Read chat'),
    ]);
    await Promise.all([
      service.connect(org, 'alice', { id: gmail.id }),
      service.connect(org, 'alice', { id: slack.id }),
    ]);
    const identities = vi.mocked(backend.authorize).mock.calls.map(call => call[0]);
    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
  });
  it('replaces an invalid sign-in link immediately on explicit restart', async () => {
    const c = (await service.request(org, 'gmail', 'task_a', 'do', 'Read mail'));
    await service.connect(org, 'alice', { id: c.id });
    vi.mocked(backend.authorize).mockResolvedValueOnce({ id: 'ca_fresh', url: 'https://connect.composio.dev/link/fresh' });
    const fresh = await service.connect(org, 'alice', { id: c.id, restart: true });
    expect(fresh.url).toBe('https://connect.composio.dev/link/fresh');
    expect(backend.disconnect).toHaveBeenCalledWith('ca_exact');
    expect((await service.get(org, c.id)).accountId).toBe('ca_fresh');
  });
  it('preserves a completed sign-in when restart races with provider consent', async () => {
    const c = (await service.request(org, 'gmail', 'task_a', 'do', 'Read mail'));
    await service.connect(org, 'alice', { id: c.id });
    vi.mocked(backend.active).mockResolvedValue(true);
    const result = await service.connect(org, 'alice', { id: c.id, restart: true });
    expect(result.connection.status).toBe('active');
    expect(result.url).toBeUndefined();
    expect(backend.disconnect).not.toHaveBeenCalled();
    expect(backend.authorize).toHaveBeenCalledTimes(1);
  });
  it('isolates people, organizations and projects; requires explicit sharing', async () => {
    const id = await connected();
    expect((await service.list(org, { ownerId: 'bob' }))).toEqual([]);
    expect((await service.list(org, { taskId: 'task_b', projectId: project }))).toEqual([]);
    await expect(service.execute(org, id, 'task_b', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('not been shared');
    await expect(service.connect(org, 'bob', { id })).rejects.toThrow('another person');
    await expect(service.share(org, id, 'bob', [project])).rejects.toThrow('Only the connection owner');
    await expect(service.share(org, id, 'alice', ['foreign-project'])).rejects.toThrow('this organization');
    await expect((async () => (await service.get('another-tenant', id)))()).rejects.toThrow('not found');
    await service.share(org, id, 'alice', [project]);
    expect(await service.execute(org, id, 'task_b', project, 'GMAIL_FETCH_EMAILS', {})).toMatchObject({ successful: true });
    expect(backend.execute).toHaveBeenCalledWith('session-private', 'GMAIL_FETCH_EMAILS', {});
    await service.share(org, id, 'alice', []);
    await expect(service.tools(org, id, 'task_b', project, 'mail')).rejects.toThrow('not been shared');
  });
  it('pins the authorized account and blocks other toolkits and execution escape hatches', async () => {
    const id = await connected();
    expect(backend.session).toHaveBeenCalledWith(expect.stringMatching(/^karmax_[a-f0-9]{64}$/), 'gmail', 'ca_exact');
    for (const tool of ['SLACK_SEND_MESSAGE', 'COMPOSIO_REMOTE_BASH_TOOL', 'COMPOSIO_MULTI_EXECUTE_TOOL', '../execute'])
      await expect(service.execute(org, id, 'task_a', project, tool, {})).rejects.toThrow('does not belong');
    expect(backend.execute).not.toHaveBeenCalled();
  });
  it('does not mistake a browser visit for completed authorization', async () => {
    const request = (await service.request(org, 'gmail', 'task_a', 'do', 'Read mail'));
    await service.connect(org, 'alice', { id: request.id });
    expect((await service.refresh(org, request.id)).status).toBe('connecting');
    expect(backend.session).not.toHaveBeenCalled();
    const resume = vi.fn(async () => true); await service.reconcile(resume); expect(resume).not.toHaveBeenCalled();
  });
  it('recovers pending connections and retries failed notification delivery after restart', async () => {
    const request = (await service.request(org, 'gmail', 'task_a', 'confirm', 'Read mail'));
    await service.connect(org, 'alice', { id: request.id });
    const restarted = new ServiceConnections(store, broker, () => backend);
    vi.mocked(backend.active).mockResolvedValue(true);
    const resume = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await restarted.reconcile(resume); await restarted.reconcile(resume); await restarted.reconcile(resume);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]![0]).toMatchObject({ taskId: 'task_a', role: 'confirm', status: 'active' });
    expect((await restarted.pending('task_a'))).toEqual([]);
  });
  it('revokes locally even if upstream deletion fails, and permits retrying deletion', async () => {
    const id = await connected(); vi.mocked(backend.disconnect).mockRejectedValueOnce(new Error('secret diagnostic'));
    await expect(service.disconnect(org, id, 'alice')).rejects.toThrow('provider could not complete');
    await expect(service.execute(org, id, 'task_a', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('Reconnect');
    await service.disconnect(org, id, 'alice'); expect(backend.disconnect).toHaveBeenCalledTimes(2);
  });
  it('resumes a disconnected task even while remote cleanup remains unavailable', async () => {
    const id = await connected();
    vi.mocked(backend.disconnect).mockRejectedValue(new Error('unavailable'));
    await expect(service.disconnect(org, id, 'alice')).rejects.toThrow();
    const resume = vi.fn(async () => true);
    await service.reconcile(resume);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ status: 'disconnected' }));
    expect(service.view((await service.get(org, id)))).toMatchObject({ disconnectPending: true });
    vi.mocked(backend.disconnect).mockResolvedValue();
    await service.reconcile(resume);
    expect((await service.get(org, id)).accountId).toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('removes access when the connection owner leaves the organization', async () => {
    const id = await connected();
    (await store.setOrganizationMembership(org, 'bob', 'owner'));
    (await store.removeOrganizationMembership(org, 'alice'));
    await expect(service.execute(org, id, 'task_a', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('no longer a member');
    expect(backend.execute).not.toHaveBeenCalled();
  });
  it('rejects a key rotation that cannot address existing connected accounts', async () => {
    await connected();
    vi.mocked(backend.active).mockRejectedValueOnce(new Error('account not found'));
    await expect(service.configure('wrong-project-key')).rejects.toThrow('provider could not complete');
    expect(await broker.resolve('service-connections:composio:api-key', { caps: ['use-credential:*'] })).toBe('project-key-private');
  });
  it('allows a later task to use an existing account without signing in again', async () => {
    const account = await connected('task_a');
    const request = (await service.request(org, 'gmail', 'task_b', 'do', 'Read more mail'));
    expect((await service.reusable(org, 'alice', 'gmail')).map(c => c.id)).toEqual([account]);
    expect((await service.reusable(org, 'bob', 'gmail'))).toEqual([]);
    await expect(service.connect(org, 'bob', { id: request.id, useConnectionId: account })).rejects.toThrow('another person');
    const result = await service.connect(org, 'alice', { id: request.id, useConnectionId: account });
    expect(result).toEqual({ connection: expect.objectContaining({ id: request.id, status: 'active', ownerId: 'alice' }) });
    expect(backend.authorize).toHaveBeenCalledTimes(1);
    // A grant is not an account: it is never offered for reuse or granted onward.
    expect((await service.reusable(org, 'alice', 'gmail')).map(c => c.id)).toEqual([account]);
    expect(await service.execute(org, request.id, 'task_b', project, 'GMAIL_FETCH_EMAILS', {})).toMatchObject({ successful: true });
    expect(backend.execute).toHaveBeenLastCalledWith('session-private', 'GMAIL_FETCH_EMAILS', {});
    await expect(service.execute(org, account, 'task_b', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('not been shared');
    await expect(service.execute(org, request.id, 'task_a', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('not been shared');
    const resumed: string[] = [];
    await service.reconcile(async c => { resumed.push(`${c.taskId}:${c.id}:${c.status}`); return true; });
    expect(resumed).toContain(`task_b:${request.id}:active`);

    // Revoking the grant leaves the account and its other users intact.
    await service.disconnect(org, request.id, 'alice');
    expect(backend.disconnect).not.toHaveBeenCalled();
    await expect(service.execute(org, request.id, 'task_b', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('Reconnect');
    expect(await service.execute(org, account, 'task_a', project, 'GMAIL_FETCH_EMAILS', {})).toMatchObject({ successful: true });

    // Disconnecting the account ends every grant made from it.
    const later = (await service.request(org, 'gmail', 'task_c', 'do', 'Read mail'));
    await service.connect(org, 'alice', { id: later.id, useConnectionId: account });
    await service.disconnect(org, account, 'alice');
    expect((await service.get(org, later.id)).status).toBe('disconnected');
    await expect(service.execute(org, later.id, 'task_c', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('Reconnect');
    await expect(service.connect(org, 'alice', { id: (await service.request(org, 'gmail', 'task_d', 'do', 'x')).id, useConnectionId: account }))
      .rejects.toThrow('not connected');
  });
  it('offers reusable accounts newest first, with when each was connected', async () => {
    const day = 86_400_000, then = Date.UTC(2026, 8, 12);
    vi.spyOn(Date, 'now').mockReturnValue(then);
    const older = await connected('task_a');
    vi.mocked(backend.authorize).mockResolvedValueOnce({ id: 'ca_second', url: 'https://connect.composio.dev/link/second' });
    vi.mocked(Date.now).mockReturnValue(then + day);
    const newer = await connected('task_b');
    expect((await service.reusable(org, 'alice', 'gmail')).map(({ id, createdAt }) => ({ id, createdAt })))
      .toEqual([{ id: newer, createdAt: then + day }, { id: older, createdAt: then }]);
  });
  it('detects revoked access before execution; reconnects without widening grants', async () => {
    const id = await connected(); vi.mocked(backend.active).mockResolvedValue(false);
    await expect(service.execute(org, id, 'task_a', project, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow('expired');
    expect(backend.execute).not.toHaveBeenCalled();
    await service.connect(org, 'alice', { id });
    expect(backend.disconnect).toHaveBeenCalledWith('ca_exact');
    vi.mocked(backend.active).mockResolvedValue(true); await service.refresh(org, id);
    expect((await service.get(org, id)).projectIds).toEqual([]);
    expect((await service.get(org, id)).taskId).toBe('task_a');
  });
  it('expires abandoned sign-ins and resumes the task with an honest failure state', async () => {
    const request = (await service.request(org, 'gmail', 'task_a', 'do', 'Read mail'));
    await service.connect(org, 'alice', { id: request.id });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    const resume = vi.fn(async () => true); await service.reconcile(resume);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });
  it('rejects an unexpected authorization host without saving the link', async () => {
    vi.mocked(backend.authorize).mockResolvedValue({ id: 'ca_bad', url: 'https://attacker.example/login' });
    await expect(service.connect(org, 'alice', { toolkit: 'gmail' })).rejects.toThrow('invalid connection URL');
    expect((await service.list(org, { ownerId: 'alice' }))).toEqual([]);
  });
  it('does not expose provider error bodies and never retries a failed execute', async () => {
    const id = await connected(); vi.mocked(backend.execute).mockRejectedValue(new Error('x-api-key=private'));
    await expect(service.execute(org, id, 'task_a', project, 'GMAIL_SEND_EMAIL', {})).rejects.toThrow('provider could not complete');
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });
});

it('uses Composio v3.1 with pinned accounts, disabled workbench, and no automatic write retries', async () => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/execute')) return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 500 });
    if (url.endsWith('/link')) return Response.json({ connected_account_id: 'ca_one', redirect_url: 'https://connect.composio.dev/link/one' });
    if (url.endsWith('/session')) return Response.json({ session_id: 'session_one' });
    return Response.json({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const backend = new ComposioBackend('key');
    await backend.authorize('tenant-user', 'gmail'); await backend.session('tenant-user', 'gmail', 'ca_one');
    await expect(backend.execute('session_one', 'GMAIL_SEND_EMAIL', { to: 'test@example.com' })).rejects.toThrow();
    expect(calls.every(c => c.url.startsWith('https://backend.composio.dev/api/v3.1/'))).toBe(true);
    expect(calls.filter(c => c.url.endsWith('/execute'))).toHaveLength(1);
    expect(calls[2]!.body).toMatchObject({ user_id: 'tenant-user', connected_accounts: { gmail: ['ca_one'] },
      manage_connections: { enable: false }, workbench: { enable: false }, toolkits: { enable: ['gmail'] } });
  } finally { vi.unstubAllGlobals(); }
});

describe('native MCP connections', () => {
  let home: string, store: Store, service: ServiceConnections, org: string, project: string;
  const listTools = vi.fn(async () => ({ tools: [
    { name: 'search_emails', description: 'Search Gmail messages', inputSchema: { type: 'object' } },
    { name: 'list_labels', description: 'List labels', inputSchema: { type: 'object' } }] }));
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'Fixture mail' }] }));
  const open = vi.fn(async () => ({ listTools, callTool, close: async () => {} }) as any);
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-service-connections-'));
    store = (await Store.create(':memory:'));
    org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
    project = (await store.createProject('Project', {}, org)).id;
    // No Composio key: native MCP connections must not depend on it.
    service = new ServiceConnections(store, new CredentialBroker(new Vault(path.join(home, 'vault'))), () => { throw new Error('Composio used'); }, open);
    vi.spyOn(network, 'publicStreamFetch').mockResolvedValue(new Response('', { status: 401 }));
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); const body = await req.text();
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (req.url.includes('oauth-protected-resource')) return json({ resource: 'https://mail.example/mcp', authorization_servers: ['https://auth.example'] });
      if (req.url.includes('.well-known')) return json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      if (req.url.endsWith('/register')) return json({ ...JSON.parse(body), client_id: 'client' });
      if (req.url.endsWith('/token')) return json({ access_token: 'access-secret', token_type: 'Bearer', refresh_token: 'refresh-secret', expires_in: 3600 });
      if (req.url.startsWith('https://registry.modelcontextprotocol.io/')) return json({ servers: [
        { server: { name: 'com.example/keyed', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://keyed.example/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
        { server: { name: 'com.example/local', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'local-mcp', version: '1.0.0', transport: { type: 'stdio' } }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
        { server: { name: 'com.example/gmail', title: 'Example Gmail', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://mail.example/mcp' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
      ] });
      throw new Error(`Unexpected request ${req.url}`);
    });
  });
  afterEach(async () => { (await store.close()); fs.rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); open.mockClear(); callTool.mockClear(); });

  it('resolves registry servers the user can sign in to, and explains the rest', async () => {
    expect(await service.resolveMcp('com.example/gmail')).toEqual({ transport: { type: 'http', url: 'https://mail.example/mcp' },
      label: 'Example Gmail', registry: { name: 'com.example/gmail', version: '2.0.0' } });
    await expect(service.resolveMcp('com.example/keyed')).rejects.toThrow('needs an API key');
    await expect(service.resolveMcp('com.example/local')).rejects.toThrow('local process');
    await expect(service.resolveMcp('com.example/missing')).rejects.toThrow('No MCP Registry server');
    expect((await service.resolveMcp('https://mail.example/mcp')).label).toBe('mail.example');
    await expect(service.resolveMcp('https://127.0.0.1/mcp')).rejects.toThrow('Private');
  });

  it('signs the owner in, calls tools for the task, and reuses the account for later tasks', async () => {
    const server = await service.resolveMcp('com.example/gmail');
    const request = (await service.requestMcp(org, server, 'task_a', 'do', 'Read my mail'));
    expect(request).toMatchObject({ status: 'requested', label: 'Example Gmail', mcp: { url: 'https://mail.example/mcp', auth: 'oauth' } });
    expect((await service.requestMcp(org, server, 'task_a', 'do', 'Read my mail')).id).toBe(request.id);
    await expect(service.connect(org, 'alice', { id: request.id })).rejects.toThrow('public Tavya URL');
    const started = await service.connect(org, 'alice', { id: request.id, redirect: 'https://tavya.example/mcp-callback' });
    expect(started).toMatchObject({ callback: 'mcp', connection: { status: 'connecting' } });
    const state = new URL(started.url!).searchParams.get('state')!;
    expect(new URL(started.url!).origin).toBe('https://auth.example');
    await expect(service.finishMcp(org, request.id, 'bob', state, 'code')).rejects.toThrow('owner');
    await expect(service.execute(org, request.id, 'task_a', project, 'search_emails', {})).rejects.toThrow('Reconnect');
    expect(await service.finishMcp(org, request.id, 'alice', state, 'code')).toMatchObject({ status: 'active' });

    expect((await service.tools(org, request.id, 'task_a', project, 'search mail')).map(t => t.slug)).toEqual(['search_emails']);
    expect(open).toHaveBeenLastCalledWith({ type: 'http', url: 'https://mail.example/mcp' }, { Authorization: 'Bearer access-secret' });
    expect(await service.execute(org, request.id, 'task_a', project, 'search_emails', { query: 'invoice' })).toEqual({ content: [{ type: 'text', text: 'Fixture mail' }] });
    expect(callTool).toHaveBeenCalledWith({ name: 'search_emails', arguments: { query: 'invoice' } }, undefined, { timeout: 60_000 });
    await expect(service.execute(org, request.id, 'task_b', project, 'search_emails', {})).rejects.toThrow('not been shared');
    const views = JSON.stringify([await service.list(org, { ownerId: 'alice' }), await service.list(org, { taskId: 'task_a', projectId: project })]);
    for (const secret of ['access-secret', 'refresh-secret', state]) expect(views).not.toContain(secret);

    const later = (await service.requestMcp(org, server, 'task_b', 'do', 'Read more mail'));
    expect((await service.reusable(org, 'alice', later)).map(c => c.id)).toEqual([request.id]);
    expect((await service.reusable(org, 'alice', 'gmail'))).toEqual([]);
    await service.connect(org, 'alice', { id: later.id, useConnectionId: request.id });
    expect(await service.execute(org, later.id, 'task_b', project, 'search_emails', {})).toMatchObject({ content: expect.any(Array) });

    await service.disconnect(org, request.id, 'alice');
    await expect(service.execute(org, later.id, 'task_b', project, 'search_emails', {})).rejects.toThrow('Reconnect');
    await expect(service.execute(org, request.id, 'task_a', project, 'search_emails', {})).rejects.toThrow('Reconnect');
  });

  it('connects servers without authentication immediately and expires abandoned sign-ins', async () => {
    vi.mocked(network.publicStreamFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const open = (await service.requestMcp(org, await service.resolveMcp('https://open.example/mcp'), 'task_a', 'do', 'Public data'));
    expect(open.mcp!.auth).toBe('none');
    expect(await service.connect(org, 'alice', { id: open.id })).toEqual({ connection: expect.objectContaining({ status: 'active' }) });
    const oauth = (await service.requestMcp(org, await service.resolveMcp('https://mail.example/mcp'), 'task_a', 'do', 'Mail'));
    await service.connect(org, 'alice', { id: oauth.id, redirect: 'https://tavya.example/mcp-callback' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    expect((await service.refresh(org, oauth.id)).status).toBe('expired');
  });
});
