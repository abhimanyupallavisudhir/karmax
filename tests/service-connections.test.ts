import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ServiceConnections, ComposioBackend, type ConnectionBackend } from '../src/integrations/service-connections.js';

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
    expect(broker.resolve('service-connections:composio:api-key', { caps: ['use-credential:*'] })).toBe('project-key-private');
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
