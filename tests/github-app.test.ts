import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE, GITHUB_APP_CLIENT_SECRET_HANDLE,
  GITHUB_APP_PERMISSIONS, isGithubWorkflowPermissionRejection } from '../src/integrations/github-app.js';

describe('GitHub App integration', () => {
  it('distinguishes an App permission update from installation-owner approval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-workflows-permission-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    let appPermissions: Record<string, string> = { contents: 'write' };
    let installationPermissions: Record<string, string> = { contents: 'write' };
    const fakeFetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/app') return Response.json({ slug: 'krmax-hosted',
        owner: { login: 'acme', type: 'Organization' }, permissions: appPermissions });
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42,
        account: { login: 'acme', type: 'Organization' }, permissions: installationPermissions,
        html_url: 'https://github.com/organizations/acme/settings/installations/42' });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', appSlug: 'krmax-hosted', fetch: fakeFetch as typeof fetch });
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: '7',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });

    await expect(service.workflowPermissionStatus(connection)).resolves.toMatchObject({
      app: 'none', installation: 'none', ready: false,
      appSettingsUrl: 'https://github.com/organizations/acme/settings/apps/krmax-hosted/permissions',
    });
    await expect(service.workflowPermissionGuidance(repository)).resolves.toMatch(/installation operator must grant/i);
    appPermissions.workflows = 'write';
    await expect(service.workflowPermissionGuidance(repository)).resolves.toMatch(/has not approved/i);
    installationPermissions.workflows = 'write';
    await expect(service.workflowPermissionStatus(connection)).resolves.toMatchObject({ app: 'write', installation: 'write', ready: true });
    await expect(service.permissionStatus(connection)).resolves.toMatchObject({
      ready: false,
      missingApp: expect.arrayContaining(['Actions', 'Repository administration', 'Merge queues']),
      missingInstallation: expect.arrayContaining(['Actions', 'Repository administration', 'Merge queues']),
    });
    appPermissions = { ...GITHUB_APP_PERMISSIONS };
    installationPermissions = { ...GITHUB_APP_PERMISSIONS };
    await expect(service.permissionStatus(connection)).resolves.toMatchObject({
      ready: true, missingApp: [], missingInstallation: [],
      permissions: expect.arrayContaining([
        expect.objectContaining({ key: 'actions', required: 'write', app: 'write', installation: 'write', ready: true }),
        expect.objectContaining({ key: 'members', required: 'read', app: 'read', installation: 'read', ready: true }),
      ]),
    });
    expect(isGithubWorkflowPermissionRejection(
      'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission',
    )).toBe(true);
    expect(isGithubWorkflowPermissionRejection('protected branch update failed')).toBe(false);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('observes a user repository role without minting a krmax authorization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-permission-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (url.pathname === '/user') return Response.json({ id: 42, login: 'octocat' });
      if (url.pathname === '/repos/acme/widgets') return Response.json({
        role_name: 'write', permissions: { pull: true, push: true },
        allow_merge_commit: false, allow_squash_merge: true,
      });
      if (url.pathname === '/repos/acme/locked')
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { clientId: 'Iv1.client', fetch: fakeFetch as typeof fetch });
    await service.authorizeUser('owner', 'oauth-code');
    await expect(service.repositoryPermission('owner', 'acme/widgets', '42')).resolves.toMatchObject({
      permission: 'write', roleName: 'write', canMerge: true, mergeMethod: 'squash',
    });
    await expect(service.repositoryPermission('owner', 'acme/locked', '42')).resolves.toMatchObject({
      permission: 'none', canMerge: false,
    });
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps multiple personal accounts, selects an active one, and guards the last connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-accounts-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/login/oauth/access_token') {
        const code = new URLSearchParams(String(init.body)).get('code');
        return Response.json({ access_token: code === 'second' ? 'token-2' : 'token-1' });
      }
      const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
      if (url.pathname === '/user' && auth === 'Bearer token-1') return Response.json({ id: 1, login: 'first' });
      if (url.pathname === '/user' && auth === 'Bearer token-2') return Response.json({ id: 2, login: 'second' });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { clientId: 'Iv1.client', fetch: fakeFetch as typeof fetch });
    const picker = new URL(service.userAuthorizationUrl('state', 'https://karmax.example', { selectAccount: true }));
    expect(picker.searchParams.get('prompt')).toBe('select_account');
    await service.authorizeUser('owner', 'first', undefined, { makeActive: true });
    await service.authorizeUser('owner', 'second', undefined, { makeActive: true });
    expect(await service.listUserAccounts('owner')).toEqual([
      expect.objectContaining({ id: '1', login: 'first', active: false }),
      expect.objectContaining({ id: '2', login: 'second', active: true }),
    ]);
    await service.setActiveUserAccount('owner', '1');
    expect(service.activeUserAccountId('owner')).toBe('1');
    expect(await service.removeUserAccount('owner', '2')).toBe('1');
    await expect(service.removeUserAccount('owner', '1')).rejects.toThrow('Connect a new GitHub account first');
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bootstraps itself through an App manifest and creates a repository without deploy keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-turnkey-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    const calls: Array<{ host: string; path: string; method: string; body?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ host: url.host, path: url.pathname, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
      if (url.pathname === '/app-manifests/setup-code/conversions') return Response.json({ id: 123, slug: 'karmax-acme', pem: privateKey,
        webhook_secret: 'hook-secret', client_id: 'Iv1.client', client_secret: 'client-secret' });
      if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'user-token', expires_in: 28_800,
        refresh_token: 'refresh-token', refresh_token_expires_in: 15_552_000 });
      if (url.pathname === '/user') return Response.json({ id: 42, login: 'octocat', name: 'The Octocat' });
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      if (url.pathname === '/app/installations/42/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [] });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST') return Response.json({ id: 77, name: 'new-app', private: true,
        ssh_url: 'git@github.com:acme/new-app.git', default_branch: 'main', owner: { login: 'acme' } });
      if (url.pathname === '/user/installations/42/repositories/77' && init.method === 'PUT') return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { fetch: fakeFetch as typeof fetch });

    const manifest = service.manifest('https://karmax.example', 'state');
    expect(manifest.action).toBe('https://github.com/settings/apps/new');
    expect(manifest.manifest).toMatchObject({ setup_url: 'https://karmax.example/api/github/callback',
      redirect_url: 'https://karmax.example/api/github/manifest/callback/state',
      setup_on_update: true, callback_urls: [
        'https://karmax.example/api/github/oauth/callback',
        'https://karmax.example/api/auth/callback/github',
      ], default_permissions: { email_addresses: 'read' } });
    expect(manifest.manifest).toHaveProperty('hook_attributes.url', 'https://karmax.example/api/github/webhook');
    // Installation events arrive automatically; the PR lifecycle must be asked for.
    expect(manifest.manifest.default_events).toEqual(['pull_request', 'pull_request_review', 'check_run', 'merge_group', 'workflow_run']);
    expect(manifest.manifest).toHaveProperty('default_permissions.checks', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.actions', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.workflows', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.statuses', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.administration', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.merge_queues', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.secrets', 'write');
    expect(manifest.manifest).toHaveProperty('default_permissions.code_scanning_alerts', 'read');
    expect(manifest.manifest).not.toHaveProperty('redirect_on_update');
    await service.convertManifest('setup-code');
    expect(service.oauthCredentials()).toEqual({ clientId: 'Iv1.client', clientSecret: 'client-secret' });
    expect(service.status('owner')).toMatchObject({ configured: true, appSlug: 'karmax-acme', oauthConfigured: true,
      webhookConfigured: true, userAuthorized: false });
    expect(JSON.stringify(service.status('owner'))).not.toContain('secret');

    const connected = await service.connectInstallation(organization.id, '42');
    const authorize = new URL(service.userAuthorizationUrl('oauth-state', 'https://karmax.example'));
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.client');
    await expect(service.authorizeUser('owner', 'oauth-code', 'https://karmax.example')).resolves.toEqual({
      id: '42', login: 'octocat', name: 'The Octocat',
    });
    expect(service.status('owner').userAuthorized).toBe(true);
    const repository = await service.createRepository(connected.connection.id, 'owner', { name: 'new-app', private: true });
    expect(repository).toMatchObject({ owner: 'acme', name: 'new-app', sshUrl: 'git@github.com:acme/new-app.git' });
    expect(store.repositoryDeployKeys(repository.id)).toBeUndefined();
    expect(calls.some((call) => call.path.endsWith('/keys'))).toBe(false);
    expect(calls.some((call) => call.path === '/user/installations/42/repositories/77' && call.method === 'PUT')).toBe(true);
    expect(calls.find((call) => call.path === '/login/oauth/access_token')?.body).toContain('redirect_uri=');
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adopts a sign-in authorization as a personal GitHub connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-signin-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/user' && String((init.headers as Record<string, string>)?.authorization) === 'Bearer sign-in-token')
        return Response.json({ id: 42, login: 'octocat', name: 'The Octocat' });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { clientId: 'Iv1.client', fetch: fakeFetch as typeof fetch });

    await expect(service.adoptUserAuthorization('user-1', '42', {
      accessToken: 'sign-in-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 28_800_000),
      refreshTokenExpiresAt: new Date(Date.now() + 15_552_000_000),
    })).resolves.toEqual({ id: '42', login: 'octocat', name: 'The Octocat' });
    await expect(service.listUserAccounts('user-1')).resolves.toEqual([
      expect.objectContaining({ id: '42', login: 'octocat', active: true }),
    ]);
    await expect(service.userAccessToken('user-1')).resolves.toBe('sign-in-token');

    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a valid webhook-free manifest for local and private instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-local-manifest-'));
    const store = new Store(':memory:');
    const service = new GitHubAppService(store, new CredentialBroker(new Vault(dir)));
    for (const origin of ['http://localhost:4343', 'https://127.0.0.1:4343', 'https://192.168.1.20']) {
      const manifest = service.manifest(origin, 'state').manifest;
      expect(manifest).not.toHaveProperty('hook_attributes');
      expect(manifest).not.toHaveProperty('default_events');
      expect(manifest.redirect_url).toBe(`${origin}/api/github/manifest/callback/state`);
    }
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a public app manifest for a hosted deployment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-hosted-manifest-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const personal = new GitHubAppService(store, broker);
    const hosted = new GitHubAppService(store, broker, { publicApp: true });

    expect(personal.manifest('https://self-host.example', 'state').manifest.public).toBe(false);
    expect(hosted.manifest('https://krmax.io', 'state').manifest.public).toBe(true);

    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adopts an existing private repository after interrupted provisioning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-adopt-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    broker.registerHandle('github-app:user:owner:authorization', JSON.stringify({ accessToken: 'user-token' }));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const calls: Array<{ path: string; method: string }> = [];
    const payload = { id: 77, name: 'project-wiki', private: true,
      ssh_url: 'git@github.com:acme/project-wiki.git', default_branch: 'main', owner: { login: 'acme' } };
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init.method ?? 'GET' });
      if (url.pathname === '/repos/acme/project-wiki' && init.method !== 'POST') return Response.json(payload);
      if (url.pathname === '/repos/acme/public-wiki' && init.method !== 'POST')
        return Response.json({ ...payload, id: 78, name: 'public-wiki', private: false,
          ssh_url: 'git@github.com:acme/public-wiki.git' });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST')
        return Response.json({ ...payload, id: 79, name: 'all-repos-wiki',
          ssh_url: 'git@github.com:acme/all-repos-wiki.git' });
      if (url.pathname === '/repos/acme/all-repos-wiki' && init.method !== 'POST')
        return Response.json({ ...payload, id: 79, name: 'all-repos-wiki',
          ssh_url: 'git@github.com:acme/all-repos-wiki.git' });
      if (url.pathname === '/user/installations/42/repositories/77' && init.method === 'PUT')
        return new Response(null, { status: 204 });
      if (url.pathname === '/user/installations/42/repositories/79' && init.method === 'PUT')
        return new Response('installation has access to all repositories', { status: 422 });
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', fetch: fakeFetch as typeof fetch });

    const repository = await service.ensureRepository(connection.id, 'owner',
      { name: 'project-wiki', private: true, autoInit: false });
    expect(repository).toMatchObject({ providerId: '77', name: 'project-wiki', private: true });
    expect(store.repositoryDeployKeys(repository.id)).toBeUndefined();
    expect(calls.some((call) => call.path === '/orgs/acme/repos' && call.method === 'POST')).toBe(false);
    expect(calls).toContainEqual({ path: '/user/installations/42/repositories/77', method: 'PUT' });
    await expect(service.ensureRepository(connection.id, 'owner',
      { name: 'public-wiki', private: true })).rejects.toThrow('must be private');
    await expect(service.createRepository(connection.id, 'owner',
      { name: 'all-repos-wiki', private: true })).resolves.toMatchObject({ providerId: '79' });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('self-heals a user token GitHub invalidated before its recorded expiry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-selfheal-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    // A token whose recorded expiry is hours away — karmax's own clock trusts it —
    // but which GitHub has already invalidated (revoked / secret rotation / a
    // refresh chain consumed by a concurrent instance). Its refresh token is live.
    const handle = 'github-app:user:owner:authorization';
    broker.registerHandle(handle, JSON.stringify({ accessToken: 'dead-token',
      expiresAt: Date.now() + 7 * 3600_000, refreshToken: 'refresh-1', refreshExpiresAt: Date.now() + 180 * 86_400_000 }));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    let refreshes = 0;
    const payload = { id: 77, name: 'project-wiki', private: true,
      ssh_url: 'git@github.com:acme/project-wiki.git', default_branch: 'main', owner: { login: 'acme' } };
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
      if (url.pathname === '/login/oauth/access_token') {
        refreshes++;
        return Response.json({ access_token: 'fresh-token', expires_in: 28_800,
          refresh_token: 'refresh-2', refresh_token_expires_in: 15_552_000 });
      }
      // The dead token is rejected on every user-token endpoint until refreshed.
      if (auth === 'Bearer dead-token') return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      if (url.pathname === '/repos/acme/project-wiki' && init.method !== 'POST') return Response.json(payload);
      if (url.pathname === '/user/installations/42/repositories/77' && init.method === 'PUT')
        return new Response(null, { status: 204 });
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', clientId: 'Iv1.client',
      fetch: fakeFetch as typeof fetch });

    // Provisioning must recover instead of surfacing GitHub's "Bad credentials" 401.
    const repository = await service.ensureRepository(connection.id, 'owner',
      { name: 'project-wiki', private: true, autoInit: false });
    expect(repository).toMatchObject({ providerId: '77', name: 'project-wiki', private: true });
    expect(refreshes).toBe(1);
    // The refreshed access + refresh tokens are persisted so the next call reuses them.
    const stored = JSON.parse(broker.resolve(handle, { caps: [`use-credential:${handle}`] }));
    expect(stored).toMatchObject({ accessToken: 'fresh-token', refreshToken: 'refresh-2' });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('clears a revoked user token so the operator is told to reconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-revoked-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    const handle = 'github-app:user:owner:authorization';
    broker.registerHandle(handle, JSON.stringify({ accessToken: 'dead-token',
      expiresAt: Date.now() + 7 * 3600_000, refreshToken: 'dead-refresh', refreshExpiresAt: Date.now() + 180 * 86_400_000 }));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      // The refresh token is dead too — GitHub returns an OAuth error, no token.
      if (url.pathname === '/login/oauth/access_token')
        return Response.json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', clientId: 'Iv1.client', fetch: fakeFetch as typeof fetch });

    expect(service.status('owner').userAuthorized).toBe(true);
    await expect(service.ensureRepository(connection.id, 'owner', { name: 'project-wiki', private: true }))
      .rejects.toThrow(/reconnect/i);
    // The dead credential is cleared so the UI stops showing GitHub as connected
    // and the operator is prompted to reconnect instead of a silent 401 storm.
    expect(service.status('owner').userAuthorized).toBe(false);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports repositories, uses scoped installation tokens for Git, and verifies webhooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-app-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, 'webhook-secret');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    let repositories = [{ id: 7, name: 'app', private: true, ssh_url: 'git@github.com:acme/app.git',
      default_branch: 'main', owner: { login: 'acme' } }];
    const calls: Array<{ path: string; method: string; body?: any; auth?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', body,
        auth: new Headers(init.headers).get('authorization') ?? undefined });
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      if (url.pathname === '/app/installations/42/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', appSlug: 'karmax-test',
      fetch: fakeFetch as typeof fetch });

    const install = new URL(service.installationUrl('one-time-state'));
    expect(install.pathname).toBe('/apps/karmax-test/installations/new');
    expect(install.searchParams.get('state')).toBe('one-time-state');

    const connected = await service.connectInstallation(organization.id, '42');
    expect(connected.repositories).toHaveLength(1);
    const repository = connected.repositories[0]!;
    expect(store.repositoryDeployKeys(repository.id)).toBeUndefined();
    expect(calls.some((call) => call.path.includes('/keys'))).toBe(false);
    expect(calls.find((call) => call.path === '/app/installations/42')?.auth?.split('.')).toHaveLength(3);
    expect(await service.brokerCredentials(repository)).toMatchObject({
      httpsToken: 'installation-token', env: { GH_TOKEN: 'installation-token' },
    });
    expect(await service.repositoryCloneToken(repository)).toBe('installation-token');
    const scopedMints = calls.filter((call) => call.path === '/app/installations/42/access_tokens')
      .map((call) => call.body).filter((body) => body?.repository_ids);
    expect(scopedMints).toContainEqual({ repository_ids: [7], permissions: { contents: 'read' } });
    expect(scopedMints).not.toContainEqual({ repository_ids: [7], permissions: { contents: 'write' } });

    const payload = Buffer.from(JSON.stringify({ installation: { id: 42 }, action: 'added' }));
    const signature = `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    expect((await service.handleWebhook('installation_repositories', 'delivery-1', payload, signature)).accepted).toBe(true);
    expect((await service.handleWebhook('installation_repositories', 'delivery-1', payload, signature)).accepted).toBe(false);
    await expect(service.handleWebhook('installation_repositories', 'delivery-2', payload, 'sha256=bad')).rejects.toThrow(/signature/);

    repositories = [];
    await service.reconcile(connected.connection);
    expect(store.getRepository(repository.id)).toBeUndefined();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns verified pull-request deliveries into karmax task events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-pr-hook-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, 'webhook-secret');
    const organization = store.createOrganization({ name: 'Hooks', ownerUserId: 'owner' });
    store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const project = store.createProject('App', {}, organization.id);
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github',
      providerId: '99', owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git',
      defaultBranch: 'main', private: true });
    store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    const task = store.createTask({ projectId: project.id, title: 'Work', workflow: 'software-dev',
      workflowVersion: '1.8.0', params: { prompt: 'do it' } });
    // A task of a DIFFERENT tenant, whose branch name this installation must not
    // be able to name its way into.
    const other = store.createOrganization({ name: 'Rival', ownerUserId: 'rival' });
    const otherTask = store.createTask({ projectId: store.createProject('Theirs', {}, other.id).id,
      title: 'Theirs', workflow: 'software-dev', workflowVersion: '1.8.0', params: { prompt: 'x' } });
    const service = new GitHubAppService(store, broker, { appId: '123' });
    const deliver = async (event: string, id: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      return service.handleWebhook(event, id, raw,
        `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(raw).digest('hex')}`);
    };
    const pull = (branch: string, over: Record<string, unknown> = {}) => ({
      installation: { id: 42 }, action: 'closed', repository: { full_name: 'acme/app' },
      pull_request: { number: 3, html_url: 'https://github.com/acme/app/pull/3', state: 'closed', merged: true,
        title: 'Work', head: { ref: branch }, base: { ref: 'main' }, ...over },
    });

    const taskPr = { repo: 'app', slug: 'acme/app', number: 3, url: 'https://github.com/acme/app/pull/3',
      state: 'open' as const };
    store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'review', status: 'waiting', messages: [], actions: [], state: {}, updatedAt: Date.now(),
      pr: taskPr, prs: [taskPr],
      checkouts: [{ name: 'app', branch: `karmax/${task.id}`, base: 'main', pr: taskPr }] });

    const merged = await deliver('pull_request', 'pr-1', pull(`karmax/${task.id}`));
    expect(merged.events).toHaveLength(1);
    expect(merged.events![0]).toMatchObject({ taskId: task.id, type: 'github.pr.merged' });
    expect(store.getTask(task.id)?.lastView?.pr).toMatchObject({ state: 'closed', merged: true });
    expect(store.getTask(task.id)?.lastView?.prs?.[0]).toMatchObject({ state: 'closed', merged: true });
    expect(store.getTask(task.id)?.lastView?.checkouts?.[0]?.pr).toMatchObject({ state: 'closed', merged: true });
    const check = await deliver('check_run', 'check-1', {
      installation: { id: 42 }, action: 'completed', repository: { full_name: 'acme/app' },
      check_run: { name: 'CI', status: 'completed', conclusion: 'failure',
        check_suite: { head_branch: `karmax/${task.id}` } },
    });
    expect(check.events).toEqual([expect.objectContaining({ taskId: task.id, type: 'github.check.completed' })]);
    const failedWorkflow = await deliver('workflow_run', 'workflow-1', {
      installation: { id: 42 }, action: 'completed',
      repository: { id: 99, full_name: 'acme/app' },
      workflow_run: { id: 700, name: 'Deploy', run_attempt: 2, conclusion: 'failure',
        head_branch: 'main', head_sha: 'merged-sha', html_url: 'https://github.com/acme/app/actions/runs/700',
        pull_requests: [{ head: { ref: `karmax/${task.id}` } }],
      },
    });
    expect(failedWorkflow.projectEvents).toEqual([expect.objectContaining({
      projectId: project.id, type: 'github.workflow.failed', payload: expect.objectContaining({
        repository: 'acme/app', workflow: 'Deploy', runId: 700, attempt: 2,
        branch: 'main', headSha: 'merged-sha', originatingTaskId: task.id,
      }),
    })]);
    const featureFailure = await deliver('workflow_run', 'workflow-2', {
      installation: { id: 42 }, action: 'completed', repository: { id: 99, full_name: 'acme/app' },
      workflow_run: { id: 701, name: 'CI', conclusion: 'failure', head_branch: 'feature', head_sha: 'x' },
    });
    expect(featureFailure.projectEvents).toBeUndefined();
    // A branch no karmax task owns is accepted and produces nothing to dispatch.
    expect(await deliver('pull_request', 'pr-2', pull('feature/manual'))).toEqual({ accepted: true });
    // Neither does a branch naming a task in an organization that did not install
    // this App — an installation drives only its own tenant's tasks.
    expect(await deliver('pull_request', 'pr-3', pull(`karmax/${otherTask.id}`))).toEqual({ accepted: true });
    // …nor one naming a task that does not exist at all.
    expect(await deliver('pull_request', 'pr-4', pull('karmax/task_ghost'))).toEqual({ accepted: true });
    // Deliveries are still de-duplicated by id.
    expect((await deliver('pull_request', 'pr-1', pull(`karmax/${task.id}`))).accepted).toBe(false);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes deploy keys left by an older karmax version during reconciliation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-key-migration-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    const organization = store.createOrganization({ name: 'Migration', ownerUserId: 'owner' });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '9', accountLogin: 'acme', accountType: 'Organization' });
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github',
      providerId: '8', owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git',
      defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    const cloneHandle = `github:repository:${repository.id}:clone`;
    const writeHandle = `github:repository:${repository.id}:write`;
    broker.registerHandle(cloneHandle, 'OLD-CLONE-KEY');
    broker.registerHandle(writeHandle, 'OLD-WRITE-KEY');
    store.setRepositoryDeployKeys({ repositoryId: repository.id, cloneKeyId: '201',
      writeKeyId: '202', cloneHandle, writeHandle });
    const deleted: string[] = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/app/installations/9') return Response.json({ id: 9, account: { login: 'acme' } });
      if (url.pathname === '/app/installations/9/access_tokens')
        return Response.json({ token: 'token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ id: 8, name: 'app', private: true,
        ssh_url: 'git@github.com:acme/app.git', default_branch: 'main', owner: { login: 'acme' } }] });
      if (url.pathname.startsWith('/repos/acme/app/keys/') && init.method === 'DELETE') {
        deleted.push(url.pathname); return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', fetch: fakeFetch as typeof fetch });
    await expect(service.connectInstallation(organization.id, '9')).resolves.toBeTruthy();
    expect(deleted).toEqual(['/repos/acme/app/keys/201', '/repos/acme/app/keys/202']);
    expect(store.repositoryDeployKeys(repository.id)).toBeUndefined();
    expect(broker.hasHandle(cloneHandle)).toBe(false);
    expect(broker.hasHandle(writeHandle)).toBe(false);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('GitHub App failure and suspension handling', () => {
  const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;

  const harness = (fetcher: (url: URL, init: RequestInit) => Promise<Response>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-fail-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, rsa());
    broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, 'webhook-secret');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const service = new GitHubAppService(store, broker, { appId: '123', appSlug: 'karmax-test',
      fetch: ((input: any, init: RequestInit = {}) => fetcher(new URL(String(input)), init)) as typeof fetch,
      sleep: async () => {} }); // do not actually wait out the 5xx backoff
    const deliver = (event: string, id: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      return service.handleWebhook(event, id, raw,
        `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(raw).digest('hex')}`);
    };
    return { dir, store, broker, organization, service, deliver };
  };

  it('releases the delivery claim when the reconcile fails, so a redelivery is not discarded', async () => {
    let failing = true;
    const h = harness(async (url) => {
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories')
        return failing ? new Response('boom', { status: 500 }) : Response.json({ repositories: [] });
      return new Response('not found', { status: 404 });
    });
    h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });

    const body = { installation: { id: 42 }, action: 'added' };
    // The claim used to be permanent: the exception became a gateway error, GitHub
    // redelivered, and the redelivery short-circuited as a duplicate — losing the
    // reconcile forever.
    await expect(h.deliver('installation_repositories', 'd-1', body)).rejects.toThrow(/500/);
    failing = false;
    const retry = await h.deliver('installation_repositories', 'd-1', body);
    expect(retry).toMatchObject({ accepted: true, reconciled: 0 });
    // A successful delivery IS still deduped.
    expect(await h.deliver('installation_repositories', 'd-1', body)).toMatchObject({ accepted: false });
    h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('un-suspends an installation on the unsuspend webhook', async () => {
    const h = harness(async (url) => {
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [] });
      return new Response('not found', { status: 404 });
    });
    const connection = h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    await h.deliver('installation', 'd-suspend', { installation: { id: 42 }, action: 'suspend' });
    expect(h.store.getGitConnection(connection.id)!.suspendedAt).toBeTruthy();
    // Before the fix this fell through to reconcile() → installationToken() →
    // "installation is suspended", and nothing but a browser reinstall cleared it.
    const resumed = await h.deliver('installation', 'd-unsuspend', { installation: { id: 42 }, action: 'unsuspend' });
    expect(resumed).toMatchObject({ accepted: true });
    expect(h.store.getGitConnection(connection.id)!.suspendedAt).toBeUndefined();
    h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('can still delete an organization whose installation is suspended', async () => {
    const h = harness(async () => new Response('not found', { status: 404 }));
    const connection = h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization', suspendedAt: Date.now() });
    const repository = h.store.upsertRepository({ organizationId: h.organization.id, provider: 'github',
      providerId: '7', owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git',
      defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.broker.registerHandle(`repokey:${repository.id}:clone`, 'CLONE');
    h.broker.registerHandle(`repokey:${repository.id}:write`, 'WRITE');
    h.store.setRepositoryDeployKeys({ repositoryId: repository.id, cloneKeyId: '1', writeKeyId: '2',
      cloneHandle: `repokey:${repository.id}:clone`, writeHandle: `repokey:${repository.id}:write` });

    // installationToken() refuses to mint for a suspended installation, so minting
    // unconditionally made every retry of the org delete fail identically.
    await expect(h.service.disconnectOrganization(h.organization.id)).resolves.toBeUndefined();
    expect(h.broker.hasHandle(`repokey:${repository.id}:clone`)).toBe(false);
    expect(h.broker.hasHandle(`repokey:${repository.id}:write`)).toBe(false);
    h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('honours retry-after and retries 5xx, but never retries a plain 403', async () => {
    const seen: string[] = [];
    const waits: number[] = [];
    let attempt = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-retry-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, rsa());
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const service = new GitHubAppService(store, broker, { appId: '123',
      sleep: async (ms) => { waits.push(ms); },
      fetch: (async (input: any) => {
        const url = new URL(String(input));
        seen.push(url.pathname);
        if (url.pathname === '/app/installations/42/access_tokens')
          return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
        if (url.pathname === '/installation/repositories') {
          attempt++;
          // Secondary rate limit, then a transient 5xx, then success.
          if (attempt === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
          if (attempt === 2) return new Response('bad gateway', { status: 502 });
          return Response.json({ repositories: [] });
        }
        if (url.pathname === '/installation/repositories/forbidden') return new Response('forbidden', { status: 403 });
        return new Response('not found', { status: 404 });
      }) as typeof fetch });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'User' });

    await expect(service.reconcile(connection)).resolves.toEqual([]);
    expect(waits).toEqual([2000, 2000]); // retry-after honoured, then 5xx backoff
    // A 403 with NO rate-limit headers is a permissions error, not a limit —
    // surfaced at once, with no retries and no extra sleeps.
    const waitsBefore = waits.length;
    await expect((service as any).request('/installation/repositories/forbidden', 't')).rejects.toThrow(/403/);
    expect(seen.filter((p) => p === '/installation/repositories/forbidden')).toHaveLength(1);
    expect(waits).toHaveLength(waitsBefore);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never retries a non-idempotent token mint, while legacy key deletion is retryable', async () => {
    let mints = 0;
    let deleteAttempts = 0;
    const h = harness(async (url, init) => {
      if (url.pathname === '/app/installations/42/access_tokens') {
        mints++;
        return new Response('service unavailable', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    });
    const connection = h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const repository = h.store.upsertRepository({ organizationId: h.organization.id, provider: 'github',
      providerId: '8', owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git',
      defaultBranch: 'main', private: true, gitConnectionId: connection.id });

    await expect(h.service.repositoryCloneToken(repository)).rejects.toThrow(/503/);
    expect(mints).toBe(1);

    // DELETE of a specific legacy key id is safe to retry.
    const request = (h.service as any).request.bind(h.service);
    const del = async (u: URL, init: RequestInit) => {
      if (u.pathname === '/repos/acme/app/keys/7' && init.method === 'DELETE')
        return ++deleteAttempts === 1 ? new Response('boom', { status: 502 }) : new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    };
    (h.service as any).fetcher = ((input: any, init: RequestInit = {}) => del(new URL(String(input)), init)) as typeof fetch;
    await expect(request('/repos/acme/app/keys/7', 't', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(deleteAttempts).toBe(2);
    h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('bounds the retry budget on the webhook-serving path', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const h = harness(async (url) => {
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') {
        attempts++;
        // A minute-long backoff is honoured on an ordinary call, but GitHub
        // abandons a webhook delivery after ~10s — sleeping it out holds the HTTP
        // response open for nothing.
        return new Response('unavailable', { status: 503, headers: { 'retry-after': '60' } });
      }
      return new Response('not found', { status: 404 });
    });
    (h.service as any).options.sleep = async (ms: number) => { waits.push(ms); };
    h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });

    await expect(h.deliver('installation_repositories', 'd-slow', { installation: { id: 42 }, action: 'added' }))
      .rejects.toThrow(/503/);
    expect(waits).toEqual([]); // a 60s wait does not fit the webhook budget
    expect(attempts).toBe(1);
    // Off the webhook path the same failure still gets its full retry budget.
    await expect((h.service as any).request('/installation/repositories', 't')).rejects.toThrow(/503/);
    expect(waits).toEqual([60_000, 60_000, 60_000]);
    h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('caches an installation token even when GitHub sends an unparseable expiry', async () => {
    let mints = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-tokcache-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, rsa());
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const service = new GitHubAppService(store, broker, { appId: '123', fetch: (async (input: any) => {
      if (new URL(String(input)).pathname.endsWith('/access_tokens')) {
        mints++;
        return Response.json({ token: `t-${mints}`, expires_at: 'not-a-date' }); // Date.parse ⇒ NaN
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch });
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'User' });

    // NaN > x is always false, so the cache never hit and every call re-minted.
    expect(await service.installationToken(connection)).toBe('t-1');
    expect(await service.installationToken(connection)).toBe('t-1');
    expect(mints).toBe(1);
    // Concurrent callers share one in-flight mint.
    const fresh = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '43', accountLogin: 'acme2', accountType: 'User' });
    const [a, b, c] = await Promise.all([service.installationToken(fresh), service.installationToken(fresh), service.installationToken(fresh)]);
    expect([a, b, c]).toEqual([a, a, a]);
    expect(mints).toBe(2);
    // A permission-upgrade observation drops the old token once, but repeated
    // landing polls inside the cooldown do not create a mint storm.
    expect(service.invalidateInstallationToken(connection.id)).toBe(true);
    expect(service.invalidateInstallationToken(connection.id)).toBe(false);
    expect(await service.installationToken(connection)).toBe('t-3');
    expect(mints).toBe(3);
    // A suspended connection is refused even while a valid token is cached.
    store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'User', suspendedAt: Date.now() });
    await expect(service.installationToken(store.getGitConnection(connection.id)!)).rejects.toThrow(/suspended/);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
