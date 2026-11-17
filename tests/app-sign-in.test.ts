import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appGrantFixture, pkce, type AppGrantFixture } from './helpers/app-grants.js';

/**
 * The phone apps sign in through the system browser (wiki features/phone-apps):
 * the first-party client `tavya-app` runs the authorization code grant with
 * PKCE to `io.tavya.app://signed-in`, then trades the code inside its WebView
 * for an ordinary console session cookie. The session is an app grant in
 * Profile → Apps and tokens: revoking it there signs the phone out, and
 * signing out in the app removes it.
 */
const APP = 'tavya-app', REDIRECT = 'io.tavya.app://signed-in';
let f: AppGrantFixture;
beforeAll(async () => { f = await appGrantFixture(); });
afterAll(async () => { await f.g.close(); });
afterEach(() => { vi.restoreAllMocks(); });

/** The browser part: authorize, consent as the signed-in owner, and the redirect back to the app. */
async function signInInBrowser(limit: Record<string, unknown> = {}) {
  const { verifier, challenge } = pkce();
  const authorize = await fetch(`${f.g.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: APP,
    redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })}`, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const id = new URL(authorize.headers.get('location')!, f.g.url).searchParams.get('request')!;
  const view = await f.call('GET', `/api/oauth/authorizations/${id}`);
  const approved = await f.call('POST', `/api/oauth/authorizations/${id}/approve`, { cookie: f.cookie }, limit);
  return { verifier, view: view.body, approved, redirect: approved.status === 200 ? new URL(approved.body.redirectUri) : undefined };
}

/** The WebView part: POST the code and verifier from the console's own origin. */
async function exchange(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${f.g.url}/oauth/app-session`, { method: 'POST', redirect: 'manual',
    headers: { origin: f.g.url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(fields) });
  const cookie = response.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0];
  return { status: response.status, body: await response.json().catch(() => null) as any, cookie };
}

async function signedInApp(name = 'tavya on Android') {
  const { verifier, redirect } = await signInInBrowser();
  const result = await exchange({ code: redirect!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, name });
  expect(result.status).toBe(200);
  return result.cookie!;
}

const me = (cookie: string) => f.call('GET', '/api/user/me', { cookie });
const grants = async (cookie = f.cookie) => (await f.call('GET', '/api/user/app-grants', { cookie })).body.grants as any[];

describe('signing the phone app in', () => {
  it('goes through consent to io.tavya.app and gives the WebView a console session listed as the phone', async () => {
    const { verifier, view, redirect } = await signInInBrowser();
    expect(view.client).toMatchObject({ id: APP, kind: 'first-party', verified: true });
    expect(`${redirect!.protocol}//${redirect!.host}`).toBe(REDIRECT);
    expect(redirect!.searchParams.get('state')).toBe('st8');
    expect(redirect!.searchParams.get('iss')).toBe(f.g.url);

    const signedIn = await exchange({ code: redirect!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, name: 'tavya on Pixel' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toBeTruthy();
    // The console runs unchanged: its ordinary session routes see the person.
    const session = await (await fetch(`${f.g.url}/api/session`, { headers: { cookie: signedIn.cookie! } })).json() as any;
    expect(session).toMatchObject({ authenticated: true });
    expect((await me(signedIn.cookie!)).body).toMatchObject({ id: f.user.id, via: { kind: 'browser' } });

    const listed = (await grants(signedIn.cookie!)).find((grant) => grant.kind === 'app');
    expect(listed).toMatchObject({ name: 'tavya on Pixel', clientId: APP, scope: 'all', current: true });
    expect(listed.expiresAt).toBeGreaterThan(Date.now() + 13 * 24 * 3600_000);
    // From the laptop it is listed, but is not "this one".
    expect((await grants()).find((grant) => grant.id === listed.id).current).toBeUndefined();
  });

  it('refuses a wrong verifier, another redirect, a code for another client, and an expired code', async () => {
    const { verifier, redirect } = await signInInBrowser();
    const code = redirect!.searchParams.get('code')!;
    for (const fields of [{ code, code_verifier: pkce().verifier, redirect_uri: REDIRECT },
      { code, code_verifier: verifier, redirect_uri: 'io.tavya.app://elsewhere' },
      { code: 'not-a-code', code_verifier: verifier, redirect_uri: REDIRECT }]) {
      const refused = await exchange(fields);
      expect(refused, JSON.stringify(fields)).toMatchObject({ status: 400, body: { error: 'invalid_grant' }, cookie: undefined });
    }
    // The code is single-use and lives a minute.
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(await exchange({ code, code_verifier: verifier, redirect_uri: REDIRECT })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('revokes what a replayed code bought', async () => {
    const { verifier, redirect } = await signInInBrowser();
    const fields = { code: redirect!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT };
    const first = await exchange(fields);
    expect((await me(first.cookie!)).status).toBe(200);
    const replay = await exchange(fields);
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' }, cookie: undefined });
    expect((await me(first.cookie!)).status).toBe(401);
  });

  it('keeps the app\'s code to the app: the token endpoint refuses it, and the app session refuses an MCP client\'s', async () => {
    const { verifier, redirect } = await signInInBrowser();
    const token = await f.form('/oauth/token', { grant_type: 'authorization_code', client_id: APP, code: redirect!.searchParams.get('code')!,
      redirect_uri: REDIRECT, code_verifier: verifier });
    expect(token.body.error).toBe('unauthorized_client');
    const client = (await (await fetch(`${f.g.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }) })).json() as any).client_id;
    const mcp = pkce();
    const authorize = await fetch(`${f.g.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client,
      redirect_uri: 'http://127.0.0.1/callback', code_challenge: mcp.challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    const id = new URL(authorize.headers.get('location')!, f.g.url).searchParams.get('request')!;
    const approved = await f.call('POST', `/api/oauth/authorizations/${id}/approve`, { cookie: f.cookie }, {});
    const code = new URL(approved.body.redirectUri).searchParams.get('code')!;
    expect(await exchange({ code, code_verifier: mcp.verifier, redirect_uri: 'http://127.0.0.1/callback' }))
      .toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('is the whole person or nothing: a limit is refused', async () => {
    const { approved } = await signInInBrowser({ level: 'viewer' });
    expect(approved.status).toBe(400);
    expect(approved.body.error).toMatch(/phone app/i);
  });

  it('takes the code only from the console\'s own page, as JSON', async () => {
    const { verifier, redirect } = await signInInBrowser();
    const fields = { code: redirect!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT };
    expect((await exchange(fields, { origin: 'https://evil.example' })).status).toBe(403);
    const form = await fetch(`${f.g.url}/oauth/app-session`, { method: 'POST',
      headers: { origin: f.g.url, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    expect(form.status).toBe(415);
    // Neither attempt spent the code.
    expect((await exchange(fields)).status).toBe(200);
  });
});

describe('the phone\'s session in Profile → Apps and tokens', () => {
  it('is signed out at once when revoked there', async () => {
    const phone = await signedInApp('Phone to revoke');
    const grant = (await grants()).find((entry) => entry.name === 'Phone to revoke');
    expect((await f.call('DELETE', `/api/user/app-grants/${grant.id}`, { cookie: f.cookie })).status).toBe(200);
    expect((await me(phone)).status).toBe(401);
    expect((await grants()).some((entry) => entry.id === grant.id)).toBe(false);
  });

  it('disappears when the app signs out', async () => {
    const phone = await signedInApp('Phone signing out');
    expect((await grants()).some((entry) => entry.name === 'Phone signing out')).toBe(true);
    const out = await fetch(`${f.g.url}/api/auth/sign-out`, { method: 'POST', headers: { origin: f.g.url, cookie: phone, 'content-type': 'application/json' }, body: '{}' });
    expect(out.status).toBe(200);
    expect((await me(phone)).status).toBe(401);
    expect((await grants()).some((entry) => entry.name === 'Phone signing out')).toBe(false);
    // The laptop is still signed in.
    expect((await me(f.cookie)).status).toBe(200);
  });
});
