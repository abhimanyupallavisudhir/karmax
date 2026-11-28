import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { OAuthApps } from '../src/mcp/connections/oauth-apps.js';
import { beginOAuth, finishOAuth, connectionHeaders } from '../src/mcp/connections/oauth.js';
import { remoteMcpAuth } from '../src/mcp/connections/remote.js';
import * as network from '../src/mcp/connections/http.js';

// Google's Workspace MCP servers (gmailmcp.googleapis.com…) name accounts.google.com,
// which registers no client on demand (no DCR, no client ID metadata documents):
// an installation operator registers one OAuth app for it, and every MCP sign-in
// through that authorization server uses it.
const GOOGLE = 'https://accounts.google.com/';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic'];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('installation OAuth apps for MCP servers that register no clients', () => {
  let dir: string, store: Store, broker: CredentialBroker, apps: OAuthApps;
  let calls: { url: string; body: string; authorization: string | null }[];
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-apps-'));
    store = await Store.create(':memory:'); broker = new CredentialBroker(new Vault(dir)); apps = new OAuthApps(store, broker);
    calls = [];
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init); const body = await req.text();
      calls.push({ url: req.url, body, authorization: req.headers.get('authorization') });
      if (req.url.includes('oauth-protected-resource'))
        return json({ resource: 'https://gmailmcp.example/mcp/v1', authorization_servers: [GOOGLE], scopes_supported: SCOPES });
      if (req.url.startsWith('https://accounts.google.com/.well-known/'))
        return json({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token', response_types_supported: ['code'], code_challenge_methods_supported: ['plain', 'S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] });
      if (req.url === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(body);
        // Google sends a refresh token on the first exchange only; refreshing returns none.
        return json(params.get('grant_type') === 'authorization_code'
          ? { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-secret', expires_in: 3599 }
          : { access_token: 'access-2', token_type: 'Bearer', expires_in: 3599 });
      }
      return json({ error: 'not found' }, 404);
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps apps per authorization server, the secret write-only', async () => {
    expect(await apps.list()).toEqual([]);
    expect(await apps.save('https://accounts.google.com', { clientId: 'gid.apps.googleusercontent.com', clientSecret: 'g-secret' }))
      .toEqual({ server: 'accounts.google.com', clientId: 'gid.apps.googleusercontent.com', hasSecret: true });
    // The same server however it is written.
    expect(await apps.client(GOOGLE)).toEqual({ client_id: 'gid.apps.googleusercontent.com', client_secret: 'g-secret' });
    expect(await apps.client('https://accounts.google.com')).toEqual({ client_id: 'gid.apps.googleusercontent.com', client_secret: 'g-secret' });
    expect(await apps.client('https://auth.example/')).toBeUndefined();
    expect(JSON.stringify(await apps.list())).not.toContain('g-secret');
    // A new client ID without a secret forgets the old secret; the same ID keeps it.
    await apps.save('accounts.google.com', { clientId: 'gid.apps.googleusercontent.com' });
    expect((await apps.client(GOOGLE))?.client_secret).toBe('g-secret');
    await apps.save('accounts.google.com', { clientId: 'public-client' });
    expect(await apps.client(GOOGLE)).toEqual({ client_id: 'public-client' });
    await expect(apps.save('http://accounts.google.com', { clientId: 'x' })).rejects.toThrow(/https/);
    await expect(apps.save('accounts.google.com', { clientId: '' })).rejects.toThrow(/client ID/);
    await apps.remove('accounts.google.com');
    expect(await apps.list()).toEqual([]);
    expect(await apps.client(GOOGLE)).toBeUndefined();
  });

  it('signs in with the registered app, asks Google for offline access, and refreshes with its secret', async () => {
    await apps.save('accounts.google.com', { clientId: 'gid.apps.googleusercontent.com', clientSecret: 'g-secret' });
    const service = new McpConnections(store, broker, 'org_personal');
    const c = await service.save({ label: 'Gmail', transport: { type: 'http', url: 'https://gmailmcp.example/mcp/v1' }, auth: 'oauth' });
    const started = await beginOAuth(service, c, 'user:alice', 'https://tavya.example/mcp-callback');
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gid.apps.googleusercontent.com');
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '));
    // Without these Google issues no refresh token, and the account would need signing in every hour.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(calls.some((call) => call.url.includes('/register'))).toBe(false);

    await finishOAuth(service, c, 'user:alice', url.searchParams.get('state')!, 'code');
    const exchange = calls.find((call) => call.url.endsWith('/token'))!;
    const basic = `Basic ${Buffer.from('gid.apps.googleusercontent.com:g-secret').toString('base64')}`;
    expect(exchange.authorization).toBe(basic);
    expect(await connectionHeaders(service, c, 'task')).toEqual({ Authorization: 'Bearer access-1' });
    // The installation's secret is never copied into the connection's credentials.
    expect(JSON.stringify(await service.secret(c))).not.toContain('g-secret');

    await service.setSecret(c, { ...(await service.secret(c)), expiresAt: 0 });
    expect(await connectionHeaders(service, c, 'task')).toEqual({ Authorization: 'Bearer access-2' });
    const refresh = calls.filter((call) => call.url.endsWith('/token')).at(-1)!;
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('refresh-secret');
    expect(refresh.authorization).toBe(basic);
    // Google returned no new refresh token: the first one is kept for the next hour.
    expect((await service.secret(c)).tokens.refresh_token).toBe('refresh-secret');
  });

  it('without a registered app, says where an operator adds one', async () => {
    const service = new McpConnections(store, broker, 'org_personal');
    const c = await service.save({ label: 'Gmail', transport: { type: 'http', url: 'https://gmailmcp.example/mcp/v1' }, auth: 'oauth' });
    await expect(beginOAuth(service, c, 'user:alice', 'https://tavya.example/mcp-callback')).rejects.toThrow(/Sign-in apps/);
  });
});

describe('detecting a server that needs sign-in', () => {
  afterEach(() => vi.restoreAllMocks());
  const transport = { type: 'http' as const, url: 'https://gmailmcp.example/mcp/v1' };
  function serve(protectedResource: boolean) {
    // Google's servers answer initialize (and tools/list) without a token, and refuse only tool calls.
    vi.spyOn(network, 'publicStreamFetch').mockImplementation(async () => json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x', version: '1' } } }));
    vi.spyOn(network, 'publicFetch').mockImplementation(async (input) => {
      const req = new Request(input);
      return protectedResource && req.url.includes('oauth-protected-resource')
        ? json({ resource: transport.url, authorization_servers: [GOOGLE], scopes_supported: SCOPES })
        : json({ error: 'not found' }, 404);
    });
  }
  it('treats a server publishing protected-resource metadata as needing sign-in, even when initialize works without', async () => {
    serve(true);
    expect(await remoteMcpAuth(transport)).toBe('oauth');
  });
  it('treats a server with neither a 401 nor protected-resource metadata as open', async () => {
    serve(false);
    expect(await remoteMcpAuth(transport)).toBe('none');
  });
});
