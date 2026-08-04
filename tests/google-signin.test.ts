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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
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

const GOOGLE = { clientId: 'test-google-client-id.apps.googleusercontent.com', clientSecret: 'test-google-client-secret' };
const GITHUB = { clientId: 'test-github-client-id', clientSecret: 'test-github-client-secret' };
const OIDC = {
  providerId: 'enterprise',
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'enterprise-client', clientSecret: 'enterprise-secret',
};

const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

/** An identity + a minimally wired gateway on a free loopback port. */
async function boot(opts: Parameters<typeof IdentityService.open>[1] = {}) {
  const port = await findFreePortFrom(47990);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}`, ...opts });
  const store = new Store(':memory:');
  const tokens = new TokenAuthority();
  const gateway = new Gateway({
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
    authorization: new AuthorizationService(store),
    worlds: new WorldRegistry(),
  });
  const running = await gateway.listen(port);
  closers.push(() => running.close());
  return { identity, store, tokens, base: running.url };
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
  it('downloads only the signed-in person’s readable, secret-free data as formatted JSON', async () => {
    const { identity, store, base } = await boot();
    const signup = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', password: 'long-enough-password' }),
    });
    const cookie = signup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    const user = identity.listUsers().find((candidate) => candidate.email === 'alice@example.com')!;
    const organization = store.listOrganizations(user.id)[0]!;
    store.createProject('Alice project', {}, organization.id);

    const response = await fetch(`${base}/api/user/export`, { headers: { cookie } });
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
      headers: { cookie },
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

  it('does not allow an agent bearer token to use the self-service export', async () => {
    const { store, tokens, base } = await boot();
    const project = store.createProject('Agent project');
    const token = tokens.mintPrincipal('user:somebody', ['*'], project.id).token;
    const response = await fetch(`${base}/api/user/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('GitHub sign-in when configured', () => {
  it('advertises itself and builds an identity-only GitHub authorize URL', async () => {
    const { identity, base } = await boot({ github: GITHUB });
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
    expect(new Set((url.searchParams.get('scope') ?? '').split(/[+\s]/).filter(Boolean)))
      .toEqual(new Set(['read:user', 'user:email']));
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
    const cookie = created.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie: cookie! } })).json() as any;
    expect(session.authenticated).toBe(true);
    expect(session.gitOnboarding).toBe(true);
    expect(store.listOrganizations(session.user.id)).toHaveLength(1);
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
    const user = identity.listUsers().find((u) => u.email === 'ada@example.com');
    expect(user).toBeTruthy();
    expect(identity.providersForUser(user!.id)).toEqual(['credential']);
  });

  // Because that collision is reachable, the failure must land back on karmax's
  // own sign-in card. Better Auth's default is its bare `/api/auth/error` page
  // ("CODE: account_not_linked", plus an "Ask AI" button) — a dead end that
  // tells the user nothing about what to do next.
  it('sends Google failures back to the sign-in card instead of Better Auth error page', () => {
    const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
    expect(app).toMatch(/errorCallbackURL/);
    // …and the card actually says what happened, naming the recoverable case.
    expect(app).toMatch(/account_not_linked/);
  });
});

describe('Google and enterprise OIDC coexist', () => {
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
      providerId: 'enterprise', clientId: OIDC.clientId, pkce: true, requireIssuerValidation: true,
    })]);
  });
});
