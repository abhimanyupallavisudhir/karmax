import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { beginOAuth, finishOAuth, connectionHeaders } from '../src/mcp/connections/oauth.js';
import * as network from '../src/mcp/connections/http.js';

afterEach(() => vi.restoreAllMocks());
describe('MCP OAuth authorization', () => {
  it('uses discovery, registration and PKCE; binds single-use state to actor and connection; refreshes without releasing refresh tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-'));
    const store = (await Store.create(':memory:'));
    const service = new McpConnections(store, new CredentialBroker(new Vault(dir)), 'org_personal');
    const c = (await service.save({ label: 'OAuth', transport: { type: 'http', url: 'https://resource.example/mcp' }, auth: 'oauth' }));
    const calls: { url: string; body: string }[] = [];
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); const body = await req.text(); calls.push({ url: req.url, body });
      const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (req.url.includes('oauth-protected-resource')) return response({ resource: 'https://resource.example/mcp', authorization_servers: ['https://auth.example'] });
      if (req.url.includes('.well-known')) return response({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', registration_endpoint: 'https://auth.example/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] });
      if (req.url.endsWith('/register')) return response({ ...JSON.parse(body), client_id: 'test-client' });
      if (req.url.endsWith('/token')) {
        const params = new URLSearchParams(body);
        expect(params.get('resource')).toBe('https://resource.example/mcp');
        if (params.get('grant_type') === 'authorization_code') expect(params.get('code_verifier')?.length).toBeGreaterThan(30);
        else expect(params.get('refresh_token')).toBe('refresh-secret');
        return response({ access_token: 'access-secret', token_type: 'Bearer', refresh_token: 'refresh-secret', expires_in: 3600 });
      }
      throw new Error(`Unexpected request ${req.url}`);
    });
    try {
      const started = await beginOAuth(service, c, 'user:alice', 'https://tavya.example/mcp-callback');
      const url = new URL(started.authorizationUrl), state = url.searchParams.get('state')!;
      expect(url.origin).toBe('https://auth.example');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe('https://tavya.example/mcp-callback');
      await expect(finishOAuth(service, c, 'user:bob', state, 'code')).rejects.toThrow(/another session/);
      await finishOAuth(service, c, 'user:alice', state, 'code');
      await expect(finishOAuth(service, c, 'user:alice', state, 'code')).rejects.toThrow(/expired/);
      expect(await connectionHeaders(service, c, 'task')).toEqual({ Authorization: 'Bearer access-secret' });
      (await service.setSecret(c, { ...service.secret(c), expiresAt: 0 }));
      expect(await connectionHeaders(service, c, 'task')).toEqual({ Authorization: 'Bearer access-secret' });
      expect(calls.filter((r) => r.url.endsWith('/token'))).toHaveLength(2);
      expect(JSON.stringify((await service.list()))).not.toContain('access-secret');
    } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
