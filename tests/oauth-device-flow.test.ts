import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

/**
 * The CLI's sign-in over real HTTP: device authorization (RFC 8628) approved
 * by a signed-in person, the tokens it yields acting as that person on `/api`
 * (and `/ws/terminal`), refresh rotation with reuse detection, revocation,
 * limits ("ceilings") and personal access tokens.
 */
let f: AppGrantFixture;
beforeAll(async () => { f = await appGrantFixture(); });
afterAll(async () => { await f.g.close(); });
afterEach(() => { vi.useRealTimers(); });

const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';

describe('authorization server metadata', () => {
  it('publishes RFC 8414 metadata with the request origin as issuer on a host-local install', async () => {
    const response = await fetch(`${f.g.url}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toMatchObject({
      issuer: f.g.url,
      authorization_endpoint: `${f.g.url}/oauth/authorize`,
      token_endpoint: `${f.g.url}/oauth/token`,
      device_authorization_endpoint: `${f.g.url}/oauth/device`,
      registration_endpoint: `${f.g.url}/oauth/register`,
      revocation_endpoint: `${f.g.url}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token', DEVICE],
    });
  });

  it('names KARMAX_PUBLIC_URL as issuer when configured', async () => {
    vi.stubEnv('KARMAX_PUBLIC_URL', 'https://tavya.example/');
    try {
      const body = await (await fetch(`${f.g.url}/.well-known/oauth-authorization-server`)).json() as any;
      expect(body.issuer).toBe('https://tavya.example');
      expect(body.token_endpoint).toBe('https://tavya.example/oauth/token');
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('device login', () => {
  it('runs pending → slow_down → approve → tokens → /api as the person → refresh rotation → reuse revokes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const start = await f.form('/oauth/device', { client_id: 'tavya-cli', name: 'ada-laptop' });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ verification_uri: `${f.g.url}/device`, expires_in: 900, interval: 5 });
    expect(start.body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(start.body.verification_uri_complete).toBe(`${f.g.url}/device?code=${start.body.user_code}`);
    const poll = () => f.form('/oauth/token', { grant_type: DEVICE, device_code: start.body.device_code, client_id: 'tavya-cli' });
    expect((await poll()).body.error).toBe('authorization_pending');
    expect((await poll()).body.error).toBe('slow_down');
    vi.setSystemTime(Date.now() + 11_000);
    expect((await poll()).body.error).toBe('authorization_pending');
    // Another client cannot redeem it.
    expect((await f.form('/oauth/token', { grant_type: DEVICE, device_code: start.body.device_code, client_id: 'nobody' })).status).toBe(401);

    // The approval page reads what is being approved (typed in any case, without the dash).
    const typed = start.body.user_code.replace('-', '').toLowerCase();
    const lookup = await f.call('GET', `/api/oauth/device?code=${typed}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ deviceName: 'ada-laptop', status: 'pending', client: { id: 'tavya-cli', name: 'tavya CLI', verified: true } });
    expect(lookup.body.levels.map((level: any) => level.id)).toEqual(expect.arrayContaining(['viewer', 'developer', 'maintainer']));
    expect(lookup.body.levels.map((level: any) => level.id)).not.toContain('god');
    // Approving needs a signed-in person.
    expect((await f.call('POST', '/api/oauth/device/approve', {}, { code: typed })).status).toBe(401);
    expect((await f.call('POST', '/api/oauth/device/approve', { cookie: f.cookie }, { code: typed })).status).toBe(200);
    expect((await f.call('POST', '/api/oauth/device/approve', { cookie: f.cookie }, { code: typed })).status).toBe(404);

    vi.setSystemTime(Date.now() + 11_000);
    const tokens = await poll();
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get('cache-control')).toBe('no-store');
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'all' });
    expect(tokens.body.access_token).toMatch(/^tva_/);
    expect(tokens.body.refresh_token).toMatch(/^tvr_grant_/);
    expect((await poll()).body.error).toBe('expired_token'); // one use

    const bearer = { bearer: tokens.body.access_token };
    const projects = await f.call('GET', '/api/projects', bearer);
    expect(projects.status).toBe(200);
    expect(projects.body.map((project: any) => project.id)).toEqual(expect.arrayContaining([f.site.id, f.docs.id]));
    const me = await f.call('GET', '/api/user/me', bearer);
    expect(me.body).toMatchObject({ id: f.user.id, name: 'Ada', email: 'ada@example.test', via: { kind: 'cli', name: 'ada-laptop', scope: 'all' } });
    // Personal (human-subject) routes work: the person operating the CLI is the human.
    expect((await f.call('GET', '/api/user/default-organization', bearer)).status).toBe(200);
    const grants = await f.call('GET', '/api/user/app-grants', bearer);
    const grant = grants.body.grants.find((item: any) => item.name === 'ada-laptop');
    expect(grant).toMatchObject({ kind: 'cli', clientId: 'tavya-cli', scope: 'all', current: true });
    expect(JSON.stringify(grants.body)).not.toContain(tokens.body.refresh_token.split('.')[1]);

    const refreshed = await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: 'tavya-cli' });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);
    expect((await f.call('GET', '/api/user/me', { bearer: refreshed.body.access_token })).status).toBe(200);
    // Reusing the rotated refresh token revokes the whole grant.
    const reuse = await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: 'tavya-cli' });
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await f.call('GET', '/api/projects', { bearer: refreshed.body.access_token })).status).toBe(401);
    expect((await f.call('GET', '/api/projects', bearer)).status).toBe(401);
  });

  it('answers access_denied after a denial and expired_token after 15 minutes', async () => {
    const denied = await f.form('/oauth/device', { client_id: 'tavya-cli', name: 'x' });
    expect((await f.call('POST', '/api/oauth/device/deny', { cookie: f.cookie }, { code: denied.body.user_code })).status).toBe(200);
    expect((await f.form('/oauth/token', { grant_type: DEVICE, device_code: denied.body.device_code, client_id: 'tavya-cli' })).body.error)
      .toBe('access_denied');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const late = await f.form('/oauth/device', { client_id: 'tavya-cli' });
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect((await f.call('GET', `/api/oauth/device?code=${late.body.user_code}`)).status).toBe(404);
    expect((await f.form('/oauth/token', { grant_type: DEVICE, device_code: late.body.device_code, client_id: 'tavya-cli' })).body.error)
      .toBe('expired_token');
    expect((await f.form('/oauth/device', { client_id: 'unknown-client' })).body.error).toBe('invalid_client');
  });

  it('revokes through RFC 7009 and through Account → Apps and tokens', async () => {
    const one = await f.deviceLogin({}, 'revoke-me');
    expect((await f.form('/oauth/revoke', { token: one.refresh_token, client_id: 'tavya-cli' })).status).toBe(200);
    expect((await f.call('GET', '/api/projects', { bearer: one.access_token })).status).toBe(401);
    // Unknown tokens are not an error (RFC 7009 §2.2).
    expect((await f.form('/oauth/revoke', { token: 'tva_unknown', client_id: 'tavya-cli' })).status).toBe(200);

    const two = await f.deviceLogin({}, 'revoke-me-too');
    const listed = (await f.call('GET', '/api/user/app-grants')).body.grants.find((grant: any) => grant.name === 'revoke-me-too');
    expect((await f.call('DELETE', `/api/user/app-grants/${listed.id}`)).status).toBe(200);
    expect((await f.call('GET', '/api/projects', { bearer: two.access_token })).status).toBe(401);
    expect((await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: two.refresh_token, client_id: 'tavya-cli' })).body.error)
      .toBe('invalid_grant');
  });

  it('dies with a closed account', async () => {
    const tokens = await f.deviceLogin({}, 'closing');
    await f.g.store.kvSet(`account-closed:${f.user.id}`, '{}');
    try {
      expect((await f.call('GET', '/api/projects', { bearer: tokens.access_token })).status).toBe(401);
    } finally { await f.g.store.kvDelete(`account-closed:${f.user.id}`); }
  });

  it('opens /ws/terminal with a tva_ bearer and refuses a bad one', async () => {
    const tokens = await f.deviceLogin({}, 'terminal');
    const task = await f.g.store.createTask({ projectId: f.site.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    const connect = (bearer: string) => new Promise<'open' | 'refused'>((resolve) => {
      const ws = new WebSocket(`${f.g.url.replace('http', 'ws')}/ws/terminal?taskId=${task.id}`, { headers: { authorization: `Bearer ${bearer}` } });
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('error', () => resolve('refused'));
      ws.once('unexpected-response', () => resolve('refused'));
    });
    expect(await connect(tokens.access_token)).toBe('open');
    expect(await connect('tva_not-a-token')).toBe('refused');
  });
});

describe('limits (ceilings)', () => {
  it('confines a grant to its level and projects', async () => {
    const tokens = await f.deviceLogin({ level: 'viewer', projectIds: [f.site.id] }, 'viewer-site');
    expect(tokens.scope).toBe(`level:viewer project:${f.site.id}`);
    const bearer = { bearer: tokens.access_token };
    expect((await f.call('GET', '/api/projects', bearer)).body.map((project: any) => project.id)).toEqual([f.site.id]);
    expect((await f.call('GET', `/api/projects/${f.site.id}`, bearer)).status).toBe(200);
    expect((await f.call('GET', `/api/projects/${f.docs.id}`, bearer)).status).toBe(403);
    // Viewer reads; it cannot create work or change settings, though Ada can.
    const create = await f.call('POST', `/api/projects/${f.site.id}/tasks`, bearer, { title: 'x', prompt: 'y' });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatch(/task:create/);
    expect((await f.call('PATCH', `/api/projects/${f.site.id}`, bearer, { name: 'Renamed' })).status).toBe(403);
    expect((await f.call('PATCH', `/api/projects/${f.site.id}`, { cookie: f.cookie }, { name: 'Site' })).status).toBe(200);
    // No organization authority from a project-limited grant.
    expect((await f.call('GET', `/api/organizations/${f.organization.id}/members`, bearer)).status).toBe(403);
    // The search shortcut honours the limit too.
    for (const project of [f.site, f.docs])
      await f.g.store.createTask({ projectId: project.id, title: 'needle', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    expect((await f.call('GET', '/api/search?q=needle')).body.tasks.map((task: any) => task.projectId).sort())
      .toEqual([f.site.id, f.docs.id].sort());
    const search = await f.call('GET', '/api/search?q=needle', bearer);
    expect(search.status).toBe(200);
    expect(search.body.tasks.map((task: any) => task.projectId)).toEqual([f.site.id]);
  });

  it('lists only the organization an organization-limited grant reaches', async () => {
    const other = await f.g.store.createOrganization({ name: 'Side gig', ownerUserId: f.user.id });
    await f.g.authorization.bootstrapOrganizationOwner('system:test', f.user.id, other.id);
    expect((await f.call('GET', '/api/organizations')).body.map((org: any) => org.id)).toEqual(expect.arrayContaining([f.organization.id, other.id]));
    const tokens = await f.deviceLogin({ organizationId: f.organization.id }, 'org-only');
    expect((await f.call('GET', '/api/organizations', { bearer: tokens.access_token })).body.map((org: any) => org.id)).toEqual([f.organization.id]);
    expect((await f.call('GET', `/api/organizations/${other.id}`, { bearer: tokens.access_token })).status).toBe(403);
    expect((await f.call('GET', `/api/organizations/${f.organization.id}`, { bearer: tokens.access_token })).status).toBe(200);
  });

  it('follows the person: a grant never has more than their current authority', async () => {
    const tokens = await f.deviceLogin({ projectIds: [f.docs.id] }, 'follows');
    expect((await f.call('PATCH', `/api/projects/${f.docs.id}`, { bearer: tokens.access_token }, { name: 'Docs' })).status).toBe(200);
    const grants = await f.g.authorization.grants(`user:${f.user.id}`);
    await f.g.authorization.revoke('system:test', `user:${f.user.id}`, grants.find((grant) => grant.scopeKey === `organization:${f.organization.id}`)!.scopeKey);
    try {
      expect((await f.call('GET', `/api/projects/${f.docs.id}`, { bearer: tokens.access_token })).status).toBe(403);
    } finally {
      await f.g.authorization.bootstrapOrganizationOwner('system:test', f.user.id, f.organization.id);
    }
  });
});

describe('personal access tokens', () => {
  it('creates, lists, uses and revokes a tvp_ token shown once', async () => {
    const created = await f.call('POST', '/api/user/tokens', { cookie: f.cookie },
      { name: 'CI deploys', level: 'developer', projectIds: [f.site.id], expiresInDays: 30 });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^tvp_/);
    expect(created.body.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    const listed = (await f.call('GET', '/api/user/app-grants')).body.grants.find((grant: any) => grant.id === created.body.id);
    expect(listed).toMatchObject({ kind: 'token', name: 'CI deploys', scope: `level:developer project:${f.site.id}` });
    expect(JSON.stringify(listed)).not.toContain(created.body.token);
    const bearer = { bearer: created.body.token };
    expect((await f.call('GET', `/api/projects/${f.site.id}`, bearer)).status).toBe(200);
    expect((await f.call('GET', `/api/projects/${f.docs.id}`, bearer)).status).toBe(403);
    expect((await f.call('DELETE', `/api/user/app-grants/${created.body.id}`)).status).toBe(200);
    expect((await f.call('GET', `/api/projects/${f.site.id}`, bearer)).status).toBe(401);
  });

  it('validates input', async () => {
    expect((await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'x', expiresInDays: 0 })).status).toBe(400);
    expect((await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: '', expiresInDays: 7 })).status).toBe(400);
    expect((await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'x', level: 'nonexistent', expiresInDays: 7 })).status).toBe(400);
    expect((await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'x', level: 'god', expiresInDays: 7 })).status).toBe(400);
  });

  it('refuses to exceed the creator: foreign projects, or more than the creating token holds', async () => {
    const stranger = await f.g.owner({ name: 'Bo', email: 'bo@example.test', password: 'long-fixture-password', organization: 'Elsewhere' });
    const foreign = await f.g.store.createProject('Theirs', undefined, stranger.organization.id);
    const refused = await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'x', projectIds: [foreign.id], expiresInDays: 7 });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('authorization_grant_denied');

    // A CLI limited to Viewer on Site may mint tokens only inside that.
    const cli = await f.deviceLogin({ level: 'viewer', projectIds: [f.site.id] }, 'narrow-cli');
    const viaCli = (body: object) => f.call('POST', '/api/user/tokens', { bearer: cli.access_token }, { name: 'from cli', expiresInDays: 7, ...body });
    expect((await viaCli({ level: 'maintainer' })).status).toBe(403);
    expect((await viaCli({ projectIds: [f.docs.id] })).status).toBe(403);
    const inherited = await viaCli({});
    expect(inherited.status).toBe(201);
    expect(inherited.body.scope).toBe(`level:viewer project:${f.site.id}`);
    expect((await f.call('GET', `/api/projects/${f.docs.id}`, { bearer: inherited.body.token })).status).toBe(403);

    // An agent acting for Ada (delegated subject) stays within its own token.
    const task = await f.g.store.createTask({ projectId: f.site.id, title: 'agent', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    const human = await f.g.tokens.mintPrincipal(`user:${f.user.id}`, ['*'], f.site.id, 60_000, f.organization.id);
    const delegation = await f.g.tokens.delegateAuthorizedInteractiveHuman(human.token, { taskId: task.id, projectId: f.site.id, organizationId: f.organization.id });
    const agent = await f.g.tokens.mint({ taskId: task.id, profileId: 'do', principal: `user:${f.user.id}`, projectId: f.site.id,
      organizationId: f.organization.id, ceiling: ['task:read', 'project:read', 'task:create'], grantorCaps: ['*'], delegationId: delegation!.id });
    const viaAgent = (body: object) => f.call('POST', '/api/user/tokens', { bearer: agent.token }, { name: 'from agent', expiresInDays: 7, ...body });
    const tooMuch = await viaAgent({ level: 'maintainer' });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.missingCapabilities?.length).toBeGreaterThan(0);
    expect((await viaAgent({ projectIds: [f.docs.id] })).status).toBe(403);
    const agentToken = await viaAgent({});
    expect(agentToken.status).toBe(201);
    expect((await f.call('GET', `/api/projects/${f.site.id}`, { bearer: agentToken.body.token })).status).toBe(200);
    // Bounded by the agent's own capabilities, not Ada's.
    expect((await f.call('PATCH', `/api/projects/${f.site.id}`, { bearer: agentToken.body.token }, { name: 'Site' })).status).toBe(403);
    const listed = (await f.call('GET', '/api/user/app-grants')).body.grants.find((grant: any) => grant.id === agentToken.body.id);
    expect(listed).toMatchObject({ createdBy: 'agent', limitedByCreator: true });
  });
});

// Last: it exhausts this person's guesses for the rest of the window.
it('limits guesses at user codes', async () => {
  let status = 0, misses = 0;
  for (; misses < 12 && status !== 429; misses++) status = (await f.call('GET', '/api/oauth/device?code=BBBB-BBBB')).status;
  expect(status).toBe(429);
  expect(misses).toBeLessThanOrEqual(11); // ten misses per person (an earlier test spent one)
  // A correct code is refused too while blocked: the limit is on the person, not the code.
  const start = await f.form('/oauth/device', { client_id: 'tavya-cli' });
  expect((await f.call('GET', `/api/oauth/device?code=${start.body.user_code}`)).status).toBe(429);
});
