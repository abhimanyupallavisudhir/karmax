import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections, type McpConnection } from '../src/mcp/connections/store.js';
import { beginOAuth, finishOAuth, connectionHeaders } from '../src/mcp/connections/oauth.js';
import * as network from '../src/mcp/connections/http.js';

describe('MCP OAuth hostile inputs and concurrency', () => {
  let dir: string, store: Store, service: McpConnections, connection: McpConnection, state: string;
  let exchanges: URLSearchParams[];
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-hostile-')); store = new Store(':memory:');
    service = new McpConnections(store, new CredentialBroker(new Vault(dir)), 'org_personal'); exchanges = [];
    connection = service.save({ label: 'OAuth', transport: { type: 'http', url: 'https://resource.example/mcp' }, auth: 'oauth' });
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); const body = await req.text();
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (req.url.includes('oauth-protected-resource')) return json({ resource: 'https://resource.example/mcp', authorization_servers: ['https://auth.example'] });
      if (req.url.includes('.well-known')) return json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', registration_endpoint: 'https://auth.example/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] });
      if (req.url.endsWith('/register')) return json({ ...JSON.parse(body), client_id: 'registered-client' });
      if (req.url.endsWith('/token')) { exchanges.push(new URLSearchParams(body)); return json({ access_token: 'scoped-access', token_type: 'Bearer', refresh_token: 'vault-only-refresh', expires_in: 3600 }); }
      throw new Error('Unexpected OAuth request');
    });
    state = new URL((await beginOAuth(service, connection, 'user:alice', 'https://tavya.example/mcp-callback')).authorizationUrl).searchParams.get('state')!;
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  it.each(['expired', 'changed', 'deleted', 'wrong-user', 'wrong-state', 'unicode-state', 'missing-code', 'object-code'])('rejects %s before token exchange', async (scenario) => {
    let actor = 'user:alice', suppliedState = state, code: any = 'code';
    if (scenario === 'expired') { const data = service.secret(connection); data.pending.expires = 0; service.setSecret(connection, data); }
    if (scenario === 'changed') connection = service.save({ ...connection, label: 'Edited' });
    if (scenario === 'deleted') service.remove(connection.id);
    if (scenario === 'wrong-user') actor = 'user:mallory';
    if (scenario === 'wrong-state') suppliedState = '0'.repeat(64);
    if (scenario === 'unicode-state') suppliedState = 'é'.repeat(64);
    if (scenario === 'missing-code') code = '';
    if (scenario === 'object-code') code = { malicious: true };
    await expect(finishOAuth(service, connection, actor, suppliedState, code)).rejects.toThrow(/Authorization|authorization|Connection/);
    expect(exchanges).toHaveLength(0);
  });
  it('allows only one token exchange for concurrent callbacks', async () => {
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => finishOAuth(service, connection, 'user:alice', state, 'code')));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(exchanges).toHaveLength(1);
    expect(service.secret(connection).pending).toBeUndefined();
  });
  it('coalesces concurrent refreshes and never projects refresh tokens or client credentials', async () => {
    await finishOAuth(service, connection, 'user:alice', state, 'code');
    service.setSecret(connection, { ...service.secret(connection), expiresAt: 0 });
    const headers = await Promise.all([1, 2, 3, 4].map(() => connectionHeaders(service, connection, 'task')));
    expect(headers).toEqual(Array(4).fill({ Authorization: 'Bearer scoped-access' }));
    expect(exchanges.filter((e) => e.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(JSON.stringify(service.list())).not.toMatch(/scoped-access|vault-only-refresh|registered-client/);
  });
  it('a second authorization invalidates the previous state', async () => {
    await beginOAuth(service, connection, 'user:alice', 'https://tavya.example/mcp-callback');
    await expect(finishOAuth(service, connection, 'user:alice', state, 'code')).rejects.toThrow(/Authorization/);
    expect(exchanges).toHaveLength(0);
  });
});
