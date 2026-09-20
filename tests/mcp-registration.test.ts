import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { beginOAuth, finishOAuth, connectionHeaders, mcpClientMetadata } from '../src/mcp/connections/oauth.js';
import * as network from '../src/mcp/connections/http.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registration-'));
  const store = await Store.create(':memory:');
  const service = new McpConnections(store, new CredentialBroker(new Vault(home)), 'org_personal');
  const input = { label: 'Server', transport: { type: 'http', url: 'https://resource.example/mcp' }, auth: 'oauth' };
  return { service, input, async close() { (await store.close()); fs.rmSync(home, { recursive: true, force: true }); } };

}

describe('MCP client registration interoperability', () => {
  it.each(['cimd', 'dcr', 'client_secret_basic', 'client_secret_post', 'none'])('authorizes and refreshes with %s', async mode => {
    const f = (await fixture());
    vi.stubEnv('KARMAX_PUBLIC_URL', 'https://tavya.example');
    const manual = !['cimd', 'dcr'].includes(mode);
    const c = (await f.service.save({ ...f.input, ...(manual ? { oauthClient: { clientId: 'registered-client', tokenEndpointAuthMethod: mode,
      ...(mode !== 'none' ? { clientSecret: 'private-client-secret' } : {}) } } : {}) }));
    const calls: Request[] = [];
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); calls.push(req.clone());
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (req.url.includes('oauth-protected-resource')) return json({ resource: f.input.transport.url, authorization_servers: ['https://auth.example'] });
      if (req.url.includes('.well-known')) return json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
        ...(mode === 'cimd' ? { client_id_metadata_document_supported: true } : mode === 'dcr' ? { registration_endpoint: 'https://auth.example/register' } : {}),
        token_endpoint_auth_methods_supported: [manual ? mode : 'none'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      if (req.url.endsWith('/register')) return json({ ...(await req.json() as Record<string, unknown>), client_id: 'dynamic-client' });
      if (req.url.endsWith('/token')) {
        const body = new URLSearchParams(await req.text());
        expect(body.get('resource')).toBe(f.input.transport.url);
        if (mode === 'client_secret_basic') expect(req.headers.get('authorization')).toBe('Basic ' + Buffer.from('registered-client:private-client-secret').toString('base64'));
        else if (mode === 'client_secret_post') expect(body.get('client_secret')).toBe('private-client-secret');
        else expect(body.has('client_secret')).toBe(false);
        if (body.get('grant_type') === 'authorization_code') expect(body.get('code_verifier')!.length).toBeGreaterThan(30);
        return json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      throw new Error('Unexpected URL ' + req.url);
    });
    try {
      const started = await beginOAuth(f.service, c, 'user:alice', 'https://tavya.example/mcp-callback');
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get('client_id')).toBe(manual ? 'registered-client' : mode === 'cimd' ? 'https://tavya.example/api/mcp-client-metadata' : 'dynamic-client');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      await finishOAuth(f.service, c, 'user:alice', url.searchParams.get('state')!, 'code');
      (await f.service.setSecret(c, { ...f.service.secret(c), expiresAt: 0 }));
      expect(await connectionHeaders(f.service, c)).toEqual({ Authorization: 'Bearer access' });
      expect(calls.filter(r => r.url.endsWith('/register'))).toHaveLength(mode === 'dcr' ? 1 : 0);
      expect(JSON.stringify((await f.service.list()))).not.toContain('private-client-secret');
      expect(JSON.stringify((await f.service.list()))).not.toContain('refresh');
    } finally { (await f.close()); }
  });
  it('keeps preregistration secrets on an unchanged edit, clears tokens on replacement, and cannot carry credentials to another server', async () => {
    const f = (await fixture());
    try {
      let c = (await f.service.save({ ...f.input, oauthClient: { clientId: 'id', clientSecret: 'secret', tokenEndpointAuthMethod: 'client_secret_basic' } }));
      (await f.service.setSecret(c, { ...f.service.secret(c), tokens: { access_token: 'old' } }));
      c = (await f.service.save({ ...c, label: 'Renamed' }));
      expect(f.service.secret(c).tokens.access_token).toBe('old');
      c = (await f.service.save({ ...c, oauthClient: { clientId: 'id', tokenEndpointAuthMethod: 'client_secret_basic' } }));
      expect(f.service.secret(c).manualClient.client_secret).toBe('secret');
      expect(f.service.secret(c).tokens.access_token).toBe('old');
      c = (await f.service.save({ ...c, oauthClient: { clientId: 'id', clientSecret: 'replacement', tokenEndpointAuthMethod: 'client_secret_basic' } }));
      expect(f.service.secret(c).tokens).toBeUndefined();
      await expect(f.service.save({ ...c, transport: { type: 'http', url: 'https://other.example/mcp' } })).rejects.toThrow(/secret/);
      c = (await f.service.save({ ...c, oauthClient: null }));
      expect(f.service.secret(c)).toEqual({});
      expect(c.oauthClient).toBeUndefined();
    } finally { (await f.close()); }
  });
  it('does not expose provider errors that could echo client credentials', async () => {
    const f = (await fixture());
    try {
      const c = (await f.service.save({ ...f.input, oauthClient: { clientId: 'id', clientSecret: 'do-not-return', tokenEndpointAuthMethod: 'client_secret_basic' } }));
      vi.spyOn(network, 'publicFetch').mockRejectedValue(new Error('Provider echoed do-not-return'));
      await expect(beginOAuth(f.service, c, 'user:alice', 'https://tavya.example/mcp-callback')).rejects.toThrow(/^MCP authorization failed\./);
    } finally { (await f.close()); }
  });
  it('publishes only configured public HTTPS identity with a fixed callback', () => {
    expect(mcpClientMetadata('http://localhost:3000')).toBeUndefined();
    expect(mcpClientMetadata('https://127.0.0.1')).toBeUndefined();
    expect(mcpClientMetadata('https://tavya.example/path?untrusted=value')).toMatchObject({
      client_id: 'https://tavya.example/api/mcp-client-metadata', redirect_uris: ['https://tavya.example/mcp-callback'], token_endpoint_auth_method: 'none',
    });
  });
});
