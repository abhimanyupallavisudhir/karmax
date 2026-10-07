import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appGrantFixture, pkce, type AppGrantFixture } from './helpers/app-grants.js';

/**
 * MCP clients sign in with the authorization code grant and PKCE (S256 only),
 * identified by dynamic registration (RFC 7591) or a client ID metadata
 * document fetched through the outbound SSRF guard (here an injected fetch).
 */
const METADATA_URL = 'https://client.example/oauth/client.json';
let metadata: Record<string, unknown>;
const fetched: string[] = [];
let f: AppGrantFixture;
beforeAll(async () => {
  metadata = { client_id: METADATA_URL, client_name: 'Example MCP', redirect_uris: ['http://127.0.0.1/callback'] };
  f = await appGrantFixture({ oauthMetadataFetch: (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
});
afterAll(async () => { await f.g.close(); });

async function register(body: Record<string, unknown>) {
  const response = await fetch(`${f.g.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

function authorizeUrl(params: Record<string, string>) {
  return `${f.g.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', code_challenge_method: 'S256', ...params })}`;
}

/** Follow /oauth/authorize to the consent page and approve as the signed-in owner. */
async function consent(params: Record<string, string>, limit: Record<string, unknown> = {}) {
  const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, f.g.url);
  expect(location.pathname).toBe('/oauth/consent');
  const id = location.searchParams.get('request')!;
  const view = await f.call('GET', `/api/oauth/authorizations/${id}`);
  const approved = await f.call('POST', `/api/oauth/authorizations/${id}/approve`, { cookie: f.cookie }, limit);
  expect(approved.status).toBe(200);
  return { view: view.body, redirect: new URL(approved.body.redirectUri) };
}

describe('dynamic client registration', () => {
  it('registers public clients only, with safe redirect URIs', async () => {
    const ok = await register({ client_name: 'Inspector', redirect_uris: ['http://127.0.0.1/callback'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: 'Inspector', token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1/callback'] });
    expect(ok.body.client_id).toMatch(/^tvc_/);
    expect((await register({ redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'client_secret_basic' })).body.error)
      .toBe('invalid_client_metadata');
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['cursor.example://callback'] })).status).toBe(201);
    expect((await register({})).status).toBe(400);
  });
});

describe('authorization code with PKCE', () => {
  it('signs a registered client in through consent with a loopback redirect on any port', async () => {
    const client = (await register({ client_name: 'Inspector', redirect_uris: ['http://127.0.0.1/callback'] })).body.client_id;
    const { verifier, challenge } = pkce();
    const redirectUri = 'http://127.0.0.1:53999/callback';
    const { view, redirect } = await consent({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge, state: 'xyz',
      resource: `${f.g.url}/mcp` }, { level: 'viewer' });
    expect(view.client).toMatchObject({ name: 'Inspector', kind: 'registered', verified: false });
    expect(view.redirectHost).toBe('127.0.0.1:53999');
    expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectUri);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(f.g.url);
    const code = redirect.searchParams.get('code')!;
    const exchange = (fields: Record<string, string>) => f.form('/oauth/token',
      { grant_type: 'authorization_code', code, client_id: client, redirect_uri: redirectUri, code_verifier: verifier, ...fields });

    expect((await exchange({ code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    expect((await exchange({ redirect_uri: 'http://127.0.0.1:1/callback' })).body.error).toBe('invalid_grant');
    expect((await exchange({ resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    const tokens = await exchange({});
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', scope: 'level:viewer' });
    expect((await f.call('GET', '/api/user/me', { bearer: tokens.body.access_token })).body.via).toMatchObject({ kind: 'mcp', name: 'Inspector' });
    // A replayed code is refused, and what it bought is revoked.
    expect((await exchange({})).body.error).toBe('invalid_grant');
    expect((await f.call('GET', '/api/user/me', { bearer: tokens.body.access_token })).status).toBe(401);
  });

  it('refuses unknown clients and redirect mismatches without redirecting, and reports other errors to the client', async () => {
    const client = (await register({ redirect_uris: ['http://127.0.0.1/callback', 'https://app.example/cb'] })).body.client_id;
    const { challenge } = pkce();
    const status = async (params: Record<string, string>) => {
      const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
      return { status: response.status, location: response.headers.get('location') };
    };
    expect((await status({ client_id: 'tvc_nope', redirect_uri: 'https://app.example/cb', code_challenge: challenge })).status).toBe(400);
    expect((await status({ client_id: client, redirect_uri: 'https://app.example/cb2', code_challenge: challenge })).status).toBe(400);
    expect((await status({ client_id: client, redirect_uri: 'http://127.0.0.1:9/other', code_challenge: challenge })).status).toBe(400);
    expect((await status({ client_id: client, redirect_uri: 'https://app.example:8443/cb', code_challenge: challenge })).status).toBe(400);
    const noPkce = await status({ client_id: client, redirect_uri: 'https://app.example/cb', code_challenge: '', state: 's' });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.location!).searchParams.get('error')).toBe('invalid_request');
    expect(new URL(noPkce.location!).searchParams.get('state')).toBe('s');
    const plain = await status({ client_id: client, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'plain' });
    expect(new URL(plain.location!).searchParams.get('error')).toBe('invalid_request');
    const resource = await status({ client_id: client, redirect_uri: 'https://app.example/cb', code_challenge: challenge, resource: 'https://other.example/mcp' });
    expect(new URL(resource.location!).searchParams.get('error')).toBe('invalid_target');
  });

  it('sends a denial back to the client', async () => {
    const client = (await register({ redirect_uris: ['https://app.example/cb'] })).body.client_id;
    const response = await fetch(authorizeUrl({ client_id: client, redirect_uri: 'https://app.example/cb', code_challenge: pkce().challenge, state: 'q' }), { redirect: 'manual' });
    const id = new URL(response.headers.get('location')!, f.g.url).searchParams.get('request')!;
    const denied = await f.call('POST', `/api/oauth/authorizations/${id}/deny`, { cookie: f.cookie }, {});
    const redirect = new URL(denied.body.redirectUri);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('q');
    expect((await f.call('POST', `/api/oauth/authorizations/${id}/approve`, { cookie: f.cookie }, {})).status).toBe(404);
  });
});

describe('client ID metadata documents', () => {
  it('fetches the https client_id once, shows its host as verified, and issues tokens', async () => {
    const { verifier, challenge } = pkce();
    const { view, redirect } = await consent({ client_id: METADATA_URL, redirect_uri: 'http://127.0.0.1:41234/callback', code_challenge: challenge });
    expect(view.client).toMatchObject({ name: 'Example MCP', kind: 'metadata', verified: true, host: 'client.example' });
    const tokens = await f.form('/oauth/token', { grant_type: 'authorization_code', code: redirect.searchParams.get('code')!,
      client_id: METADATA_URL, redirect_uri: 'http://127.0.0.1:41234/callback', code_verifier: verifier });
    expect(tokens.status).toBe(200);
    expect(fetched.filter((url) => url === METADATA_URL)).toHaveLength(1); // cached
    // Refresh works for the document-identified client too.
    expect((await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: METADATA_URL })).status).toBe(200);
  });

  it('refuses a document whose client_id is not its own URL', async () => {
    const other = 'https://client.example/oauth/impostor.json';
    metadata = { client_id: 'https://client.example/oauth/client.json', client_name: 'Impostor', redirect_uris: ['http://127.0.0.1/callback'] };
    const response = await fetch(authorizeUrl({ client_id: other, redirect_uri: 'http://127.0.0.1/callback', code_challenge: pkce().challenge }), { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not match/);
  });

  it('never fetches a private address with the real guard', async () => {
    const { OAuthServer } = await import('../src/auth/oauth-server.js');
    const { AppGrants } = await import('../src/auth/app-grants.js');
    const server = new OAuthServer(f.g.store, new AppGrants(f.g.store));
    await expect(server.client('https://127.0.0.1/client.json')).rejects.toThrow(/unusable/);
    await expect(server.client('https://localhost/client.json')).rejects.toThrow(/unusable/);
  });
});

it('answers every method on the OAuth paths', async () => {
  for (const [method, path, status] of [['POST', '/oauth/authorize', 405], ['POST', '/.well-known/oauth-authorization-server', 405],
    ['GET', '/oauth/token', 405], ['GET', '/oauth/device', 405]] as const)
    expect((await fetch(`${f.g.url}${path}`, { method, signal: AbortSignal.timeout(5_000) })).status, `${method} ${path}`).toBe(status);
});
