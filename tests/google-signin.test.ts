// "Continue with Google" is a *consumer* identity option, deliberately separate
// from the single generic-OIDC enterprise slot (`KARMAX_OIDC_*`): that slot holds
// exactly one provider, and an installation that points it at Okta must still be
// able to offer Google. Native Better Auth `socialProviders.google` needs no new
// gateway route — `/api/auth/*` is already proxied verbatim — so what actually
// needs pinning is (a) the capability flag the console reads off /api/session,
// (b) the authorize URL Better Auth builds, and (c) the account-linking policy,
// which is the one setting here that can silently create a takeover path.
//
// A cheap file by design: no Temporal server, no worker — an in-memory identity
// plus a directly constructed Gateway (see tests/fixtures/identity-smoke.ts).
import { describe, it, expect, afterAll, vi } from 'vitest';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { GitProfiles, userGitScope } from '../src/autonomy/git-profiles.js';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';

const GOOGLE = { clientId: 'test-google-client-id.apps.googleusercontent.com', clientSecret: 'test-google-client-secret' };
const GITHUB = { clientId: 'test-github-client-id', clientSecret: 'test-github-client-secret' };
const OIDC = {
  providerId: 'enterprise',
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'enterprise-client', clientSecret: 'enterprise-secret',
};

const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of closers) await close().catch(() => {}); await closeConsoleBrowser(); });

/** An identity + a minimally wired gateway on a free loopback port. */
async function boot(opts: Parameters<typeof IdentityService.open>[1] = {}) {
  const port = await findFreePortFrom(47990);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}`, ...opts });
  const store = (await Store.create(':memory:'));
  const tokens = new TokenAuthority();
  const authorization = (await AuthorizationService.create(store));
  const gateway = (await Gateway.create({
    api: {} as any,
    store,
    bus: new KarmaxBus(),
    tokens,
    contributions: new ContributionRegistry(),
    overlays: new Overlays(),
    client: {} as any,
    taskQueue: 'test',
    staticDir: process.cwd(),
    agentInfo: { provider: 'mock', reason: 'google sign-in test' },
    identity,
    authorization,
    worlds: new WorldRegistry(),
  }));
  const running = await gateway.listen(port);
  closers.push(() => running.close());
  return { identity, store, tokens, authorization, base: running.url };
}

/** Delegate the caller's authority; setup users default to God. */
async function delegatedHeaders(tokens: TokenAuthority, userId: string, capabilities: string[] = ['*']): Promise<{ authorization: string }> {
  const human = (await tokens.mintPrincipal(`user:${userId}`, capabilities));
  const delegation = (await tokens.delegateHuman(human.token, { taskId: 'self-service' }))!;
  const agent = (await tokens.mint({ taskId: 'self-service', profileId: 'do', role: 'do',
    principal: `task:self-service`, ceiling: capabilities, grantorCaps: capabilities, delegationId: delegation.id }));
  return { authorization: `Bearer ${agent.token}` };
}

describe('Google sign-in is off unless configured', () => {
  it('reports social providers disabled on /api/session', async () => {
    const { identity, base } = await boot();
    expect(identity.googleEnabled).toBe(false);
    expect(identity.githubEnabled).toBe(false);
    const session = await (await fetch(`${base}/api/session`)).json() as any;
    expect(session.google).toBe(false);
    expect(session.github).toBe(false);
  });
});

describe('user data export', () => {
  it.each(['browser', 'agent'])('%s downloads only the represented person’s readable, secret-free data as formatted JSON', async (actor) => {
    const { identity, store, tokens, base } = await boot();
    const signup = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', password: 'long-enough-password' }),
    });
    const cookie = signup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    const user = (await identity.listUsers()).find((candidate) => candidate.email === 'alice@example.com')!;
    const organization = (await store.listOrganizations(user.id))[0]!;
    (await store.createProject('Alice project', {}, organization.id));

    const headers = actor === 'agent' ? (await delegatedHeaders(tokens, user.id)) : { cookie };
    const response = await fetch(`${base}/api/user/export`, { headers });
    const text = await response.text();
    const exported = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="krmax-alice-export-\d{4}-\d{2}-\d{2}\.json"/);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(text).toContain('\n  "format": "karmax-user-export"');
    expect(exported.profile).toMatchObject({ id: user.id, name: 'Alice', email: 'alice@example.com' });
    expect(exported.authentication.providers).toEqual(['credential']);
    expect(exported.git).toEqual({ defaultProfile: null, profiles: [] });
    expect(JSON.stringify(exported)).not.toMatch(/"(?:passwordHash|sessionToken|accessToken|refreshToken)"\s*:/i);
    expect(exported.security).toMatchObject({ secretsIncluded: false });

    const organizationResponse = await fetch(`${base}/api/organizations/${organization.id}/export`, {
      headers,
    });
    const organizationText = await organizationResponse.text();
    expect(organizationResponse.status).toBe(200);
    expect(organizationResponse.headers.get('content-disposition'))
      .toMatch(/attachment; filename="krmax-personal-export-\d{4}-\d{2}-\d{2}\.json"/);
    expect(organizationText).toContain('\n  "format": "karmax-organization-export"');
    expect(JSON.parse(organizationText)).toMatchObject({
      organization: { id: organization.id },
      security: { secretsIncluded: false },
    });
  });

  it('rejects self-service export without a verified user subject', async () => {
    const { store, tokens, base } = await boot();
    const project = (await store.createProject('Agent project'));
    const token = (await tokens.mintPrincipal('user:somebody', ['*'], project.id)).token;
    const response = await fetch(`${base}/api/user/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'a verified human subject is required' });
  });
});

describe('default organization preference', () => {
  it.each([
    { actor: 'browser', operator: false }, { actor: 'agent', operator: false },
    { actor: 'browser', operator: true }, { actor: 'agent', operator: true },
  ])('$actor (operator: $operator) starts on the personal workspace and selects only accessible defaults', async ({ actor, operator }) => {
    const { identity, store, tokens, authorization, base } = await boot();
    const signup = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', password: 'long-enough-password' }),
    });
    const cookie = signup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    const user = (await identity.listUsers()).find((candidate) => candidate.email === 'alice@example.com')!;
    const personal = (await store.listOrganizations(user.id)).find((organization) => organization.kind === 'personal')!;
    const newest = (await store.createOrganization({ name: 'Newest team', ownerUserId: user.id }));

    // Setup grants God globally. Remove only that grant for the ordinary-member
    // cases, retaining ownership of the personal and newly created organizations.
    if (!operator) (await store.deletePrincipalGrant(`user:${user.id}`, 'global'));
    const capabilities = (await authorization.capabilities(`user:${user.id}`));
    expect(capabilities.includes('*')).toBe(operator);
    const headers = actor === 'agent' ? (await delegatedHeaders(tokens, user.id, capabilities)) : { cookie };
    const initial = await fetch(`${base}/api/user/default-organization`, { headers });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ organizationId: personal.id });

    const changed = await fetch(`${base}/api/user/default-organization`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: newest.id }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ organizationId: newest.id });
    expect((await store.defaultOrganization(user.id))?.id).toBe(newest.id);

    const other = (await store.createOrganization({ name: 'Not mine', ownerUserId: 'someone-else' }));
    // Even public name discovery must not let ordinary nonmembers set a default.
    (await store.setOrganizationNameVisibility(other.id, 'public'));
    const response = await fetch(`${base}/api/user/default-organization`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: other.id }),
    });
    expect(response.status).toBe(operator ? 200 : 400);
    const expected = operator ? other.id : newest.id;
    expect(await (await fetch(`${base}/api/user/default-organization`, { headers })).json())
      .toEqual({ organizationId: expected });
    expect((await store.defaultOrganization(user.id, operator))?.id).toBe(expected);

    const missing = await fetch(`${base}/api/user/default-organization`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_does_not_exist' }),
    });
    expect(missing.status).toBe(400);
    expect((await store.defaultOrganization(user.id, operator))?.id).toBe(expected);
  });

  it('rejects reading or changing a preference without a verified user subject', async () => {
    const { tokens, base } = await boot();
    const token = (await tokens.mintPrincipal('user:alice', ['*'])).token;
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(`${base}/api/user/default-organization`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ organizationId: 'org_personal' }) } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'a verified human subject is required' });
    }
  });
});

describe('GitHub sign-in when configured', () => {
  it('advertises itself and builds a shared GitHub App authorize URL', async () => {
    const { identity, base } = await boot({ github: { ...GITHUB, app: true } });
    expect(identity.githubEnabled).toBe(true);
    const session = await (await fetch(`${base}/api/session`)).json() as any;
    expect(session.github).toBe(true);

    const res = await fetch(`${base}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const url = new URL((await res.json() as any).url);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(GITHUB.clientId);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/github$/);
    expect(url.searchParams.get('scope') ?? '').toBe('');
  });

  it('hands new and refreshed GitHub App tokens to the personal connection', async () => {
    const adopted: any[] = [];
    const { identity } = await boot({ github: { ...GITHUB, app: true,
      onAuthorization: async (authorization) => { adopted.push(authorization); } } });
    const account = {
      id: 'account-row', providerId: 'github', accountId: '42', userId: 'user-1',
      accessToken: 'user-token', refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      refreshTokenExpiresAt: new Date('2030-06-01T00:00:00Z'),
      createdAt: new Date(), updatedAt: new Date(),
    };
    const hooks = identity.auth.options.databaseHooks.account;

    await hooks.create.after(account, null);
    await hooks.update.after({ ...account, accessToken: 'fresh-token' }, null);

    expect(adopted).toEqual([
      expect.objectContaining({ userId: 'user-1', accountId: '42', accessToken: 'user-token', refreshToken: 'refresh-token' }),
      expect.objectContaining({ userId: 'user-1', accountId: '42', accessToken: 'fresh-token' }),
    ]);
  });

  it('trusts GitHub verified email as a link source but still requires a verified local account', async () => {
    const { identity } = await boot({ google: GOOGLE, github: GITHUB });
    const linking = identity.auth.options.account?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toEqual(['google', 'github']);
    expect(linking?.requireLocalEmailVerified).not.toBe(false);
  });

  it('provisions a personal workspace when a social callback creates a user', async () => {
    const { identity, store, base } = await boot({ github: GITHUB });
    // Better Auth's social callback creates its user and session before returning
    // to the SPA. A direct identity signup gives us that same post-callback state
    // without making a live request to GitHub.
    const created = await identity.signUp({
      name: 'Octo Cat', email: 'octo@example.com', password: 'long-enough-password',
    });
    const signedUp = await created.clone().json() as any;
    (await new GitProfiles(store, undefined, undefined, userGitScope(String(signedUp.user.id)))
      .saveGithubIdentity({ id: '42', login: 'octocat', name: 'Octo Cat' }));
    const cookie = created.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie: cookie! } })).json() as any;
    expect(session.authenticated).toBe(true);
    expect(session.gitOnboarding).toBe(true);
    const [personal] = (await store.listOrganizations(session.user.id));
    expect(personal).toBeTruthy();
    expect((await new GitProfiles(store, undefined, undefined, personal!.id).resolve(undefined))).toMatchObject({
      github: { id: '42', login: 'octocat' },
      source: { kind: 'user', userId: session.user.id, profile: 'github' },
    });
  });
});

describe('Google sign-in when configured', () => {
  it('advertises itself on /api/session', async () => {
    const { identity, base } = await boot({ google: GOOGLE });
    expect(identity.googleEnabled).toBe(true);
    const session = await (await fetch(`${base}/api/session`)).json() as any;
    expect(session.google).toBe(true);
  });

  it('builds a Google authorize URL from the proxied Better Auth route', async () => {
    const { base } = await boot({ google: GOOGLE });
    // Better Auth's own endpoint — no karmax route was added for this.
    const res = await fetch(`${base}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.url).toBe('string');
    // Assert on the URL only. Following it would be a live call to Google.
    const url = new URL(body.url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE.clientId);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/);
    // Identity only: no Drive/Calendar scope creep, and no offline access (a
    // refresh token karmax would have to store and never uses).
    const scopes = (url.searchParams.get('scope') ?? '').split(/[+\s]/).filter(Boolean);
    expect(scopes.every((s) => ['openid', 'email', 'profile'].includes(s))).toBe(true);
    expect(url.searchParams.get('access_type')).not.toBe('offline');
  });

  // Linking a Google login onto an existing email+password account is
  // deliberately NOT unconditional, and the reason runs in BOTH directions.
  // Google is trusted as a *source* (it asserts a verified `email_verified`, so
  // the address it hands us is one the signer-in controls) — but the local
  // account is the merge *target*, and karmax's own signup never verified its
  // address. Better Auth's `requireLocalEmailVerified` default (true) is what
  // closes that: without it a stranger could register the victim's address as a
  // karmax password account and then absorb the victim's Google sign-in into it.
  // So this asserts the guard is intact, not that linking always happens.
  it('trusts Google as a link source but still requires the local address to be verified', async () => {
    const { identity } = await boot({ google: GOOGLE });
    const linking = identity.auth.options.account?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toEqual(['google']);
    // Not disabled: an unverified local account must not swallow a Google login.
    expect(linking?.requireLocalEmailVerified).not.toBe(false);

    // And the local half is real: karmax's signup mints a lone `credential` row
    // and never verifies the address, so the collision case above is reachable
    // and has to be explained to the user rather than 500-ing at them.
    await identity.signUp({ name: 'Ada', email: 'ada@example.com', password: 'long-enough-password' });
    const user = (await identity.listUsers()).find((u) => u.email === 'ada@example.com');
    expect(user).toBeTruthy();
    expect((await identity.providersForUser(user!.id))).toEqual(['credential']);
  });

  // Because that collision is reachable, the failure must land back on karmax's
  // own sign-in card. Better Auth's default is its bare `/api/auth/error` page
  // ("CODE: account_not_linked", plus an "Ask AI" button) — a dead end that
  // tells the user nothing about what to do next.
  it('sends Google failures back to the sign-in card instead of Better Auth error page', async () => {
    const signedOut = (call: ApiCall) => call.path === '/api/meta' ? { siteName: 'tavya' } : call.path === '/api/launch' ? {}
      : call.path === '/api/session' ? { authRequired: true, authenticated: false, google: true }
      : call.path === '/api/auth/sign-in/social' ? { status: 400, json: { message: 'provider unavailable' } } : undefined;
    const login = await consolePage({ path: '/login?next=%2Ftasks', api: signedOut });
    try {
      await login.run('boot()');
      await login.page.locator('#google-btn').click();
      await expect.poll(() => login.calls.find((call) => call.path === '/api/auth/sign-in/social')?.body).toEqual({
        provider: 'google', callbackURL: 'http://console.test/login?next=%2Ftasks',
        errorCallbackURL: 'http://console.test/login?next=%2Ftasks&auth_provider=google' });
    } finally { await login.close(); }

    // Better Auth appends `?error=<code>` to that URL; the card says what happened and the URL is cleaned.
    const back = await consolePage({ path: '/login?next=%2Ftasks&auth_provider=google&error=account_not_linked', api: signedOut });
    try {
      await back.run('boot()');
      await expect.poll(() => back.page.locator('#login-err').textContent())
        .toBe('An account already exists for that email address with a password. Sign in with that password instead — social sign-in requires confirming the address first.');
      expect(await back.run<string>('location.pathname + location.search')).toBe('/login?next=%2Ftasks');
    } finally { await back.close(); }
  });
});

describe('Google and enterprise OIDC coexist', () => {
  it('rejects a discovery document whose issuer differs from the configured issuer', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      issuer: 'https://other-idp.example.com',
    }), { status: 200 }));
    try {
      await expect(IdentityService.create(':memory:', { oidc: { ...OIDC, issuer: 'https://idp.example.com' } }))
        .rejects.toThrow(/issuer mismatch/);
    } finally { fetcher.mockRestore(); }
  });

  it('keeps Google, GitHub, and enterprise slots working together', async () => {
    const { identity, base } = await boot({ google: GOOGLE, github: GITHUB, oidc: OIDC });
    expect(identity.googleEnabled).toBe(true);
    expect(identity.githubEnabled).toBe(true);
    expect(identity.oidcProviderId).toBe('enterprise');

    const session = await (await fetch(`${base}/api/session`)).json() as any;
    expect(session.google).toBe(true);
    expect(session.github).toBe(true);
    expect(session.sso).toEqual({ providerId: 'enterprise' });

    // The generic-OAuth plugin is still installed and still owns its own
    // provider id — the native Google provider did not displace it.
    const res = await fetch(`${base}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
    });
    expect(new URL((await res.json() as any).url).hostname).toBe('accounts.google.com');
    // …and it still carries the enterprise client, with PKCE and issuer
    // validation. Checked on the options rather than by calling beginSso(),
    // because that would resolve the IdP's discovery document over the network.
    const generic = (identity.auth.options.plugins as any[]).find((plugin) => plugin?.id === 'generic-oauth');
    expect(generic).toBeTruthy();
    const configured = generic.options?.config ?? generic.config;
    expect(configured).toEqual([expect.objectContaining({
      providerId: 'enterprise', clientId: OIDC.clientId, pkce: true, requireIdTokenVerification: true,
    })]);
  });
});
