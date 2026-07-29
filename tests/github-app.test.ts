import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE, GITHUB_APP_CLIENT_SECRET_HANDLE } from '../src/integrations/github-app.js';

describe('GitHub App integration', () => {
  it('bootstraps itself through an App manifest, authorizes a user, and creates plus enrolls a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-turnkey-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    let keyId = 500;
    const calls: Array<{ host: string; path: string; method: string; body?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ host: url.host, path: url.pathname, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
      if (url.pathname === '/app-manifests/setup-code/conversions') return Response.json({ id: 123, slug: 'karmax-acme', pem: privateKey,
        webhook_secret: 'hook-secret', client_id: 'Iv1.client', client_secret: 'client-secret' });
      if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'user-token', expires_in: 28_800,
        refresh_token: 'refresh-token', refresh_token_expires_in: 15_552_000 });
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      if (url.pathname === '/app/installations/42/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [] });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST') return Response.json({ id: 77, name: 'new-app', private: true,
        ssh_url: 'git@github.com:acme/new-app.git', default_branch: 'main', owner: { login: 'acme' } });
      if (url.pathname === '/user/installations/42/repositories/77' && init.method === 'PUT') return new Response(null, { status: 204 });
      if (url.pathname === '/repos/acme/new-app/keys' && init.method === 'POST') return Response.json({ id: ++keyId });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { fetch: fakeFetch as typeof fetch,
      keyPair: async () => ({ privateKey: `PRIVATE-${keyId}`, publicKey: `ssh-ed25519 PUBLIC-${keyId}` }) });

    const manifest = service.manifest('https://karmax.example', 'state');
    expect(manifest.action).toBe('https://github.com/settings/apps/new');
    expect(manifest.manifest).toMatchObject({ setup_url: 'https://karmax.example/api/github/callback',
      redirect_url: 'https://karmax.example/api/github/manifest/callback/state',
      setup_on_update: true, callback_urls: ['https://karmax.example/api/github/oauth/callback'] });
    expect(manifest.manifest).toHaveProperty('hook_attributes.url', 'https://karmax.example/api/github/webhook');
    // Installation events arrive automatically; the PR lifecycle must be asked for.
    expect(manifest.manifest.default_events).toEqual(['pull_request', 'pull_request_review']);
    expect(manifest.manifest).not.toHaveProperty('redirect_on_update');
    await service.convertManifest('setup-code');
    expect(service.status('owner')).toMatchObject({ configured: true, appSlug: 'karmax-acme', oauthConfigured: true,
      webhookConfigured: true, userAuthorized: false });
    expect(JSON.stringify(service.status('owner'))).not.toContain('secret');

    const connected = await service.connectInstallation(organization.id, '42');
    const authorize = new URL(service.userAuthorizationUrl('oauth-state', 'https://karmax.example'));
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.client');
    await service.authorizeUser('owner', 'oauth-code', 'https://karmax.example');
    expect(service.status('owner').userAuthorized).toBe(true);
    const repository = await service.createRepository(connected.connection.id, 'owner', { name: 'new-app', private: true });
    expect(repository).toMatchObject({ owner: 'acme', name: 'new-app', sshUrl: 'git@github.com:acme/new-app.git' });
    expect(store.repositoryDeployKeys(repository.id)).toBeTruthy();
    expect(calls.some((call) => call.path === '/user/installations/42/repositories/77' && call.method === 'PUT')).toBe(true);
    expect(calls.find((call) => call.path === '/login/oauth/access_token')?.body).toContain('redirect_uri=');
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
    let keyId = 700;
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
      if (url.pathname === '/repos/acme/project-wiki/keys' && init.method === 'POST')
        return Response.json({ id: ++keyId });
      if (url.pathname === '/repos/acme/all-repos-wiki/keys' && init.method === 'POST')
        return Response.json({ id: ++keyId });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', fetch: fakeFetch as typeof fetch,
      keyPair: async () => ({ privateKey: `PRIVATE-${keyId}`, publicKey: `ssh-ed25519 PUBLIC-${keyId}` }) });

    const repository = await service.ensureRepository(connection.id, 'owner',
      { name: 'project-wiki', private: true, autoInit: false });
    expect(repository).toMatchObject({ providerId: '77', name: 'project-wiki', private: true });
    expect(store.repositoryDeployKeys(repository.id)).toBeTruthy();
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
    let keyId = 800;
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
      if (url.pathname === '/repos/acme/project-wiki/keys' && init.method === 'POST') return Response.json({ id: ++keyId });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', clientId: 'Iv1.client',
      fetch: fakeFetch as typeof fetch, keyPair: async () => ({ privateKey: `PRIVATE-${keyId}`, publicKey: `ssh-ed25519 PUBLIC-${keyId}` }) });

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

  it('imports installation repositories, creates separate clone/write deploy keys, verifies webhooks, and cleans up removal', async () => {
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
    let keyId = 100;
    const calls: Array<{ path: string; method: string; body?: any; auth?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', body,
        auth: new Headers(init.headers).get('authorization') ?? undefined });
      if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      if (url.pathname === '/app/installations/42/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories });
      if (url.pathname === '/repos/acme/app/keys' && init.method === 'POST') return Response.json({ id: ++keyId });
      if (url.pathname.startsWith('/repos/acme/app/keys/') && init.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    };
    const service = new GitHubAppService(store, broker, { appId: '123', appSlug: 'karmax-test', fetch: fakeFetch as typeof fetch,
      keyPair: async () => ({ privateKey: `PRIVATE-${keyId}`, publicKey: `ssh-ed25519 PUBLIC-${keyId} karmax` }) });

    const install = new URL(service.installationUrl('one-time-state'));
    expect(install.pathname).toBe('/apps/karmax-test/installations/new');
    expect(install.searchParams.get('state')).toBe('one-time-state');

    const connected = await service.connectInstallation(organization.id, '42');
    expect(connected.repositories).toHaveLength(1);
    const repository = connected.repositories[0]!;
    const keys = store.repositoryDeployKeys(repository.id)!;
    expect(keys.cloneKeyId).not.toBe(keys.writeKeyId);
    expect(calls.filter((call) => call.path === '/repos/acme/app/keys').map((call) => call.body.read_only)).toEqual([true, false]);
    expect(calls.find((call) => call.path === '/app/installations/42')?.auth?.split('.')).toHaveLength(3);
    expect(service.repositorySshKey(repository.id, 'clone')).toContain('PRIVATE');
    expect((await service.brokerCredentials(repository)).env.GH_TOKEN).toBe('installation-token');

    const payload = Buffer.from(JSON.stringify({ installation: { id: 42 }, action: 'added' }));
    const signature = `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    expect((await service.handleWebhook('installation_repositories', 'delivery-1', payload, signature)).accepted).toBe(true);
    expect((await service.handleWebhook('installation_repositories', 'delivery-1', payload, signature)).accepted).toBe(false);
    await expect(service.handleWebhook('installation_repositories', 'delivery-2', payload, 'sha256=bad')).rejects.toThrow(/signature/);

    repositories = [];
    await service.reconcile(connected.connection);
    expect(store.getRepository(repository.id)).toBeUndefined();
    expect(broker.hasHandle(keys.cloneHandle)).toBe(false);
    expect(broker.hasHandle(keys.writeHandle)).toBe(false);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2);
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

    const merged = await deliver('pull_request', 'pr-1', pull(`karmax/${task.id}`));
    expect(merged.events).toHaveLength(1);
    expect(merged.events![0]).toMatchObject({ taskId: task.id, type: 'github.pr.merged' });
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

  it('removes both remote keys and local handles when deploy-key enrollment fails after creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-rollback-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    const organization = store.createOrganization({ name: 'Rollback', ownerUserId: 'owner' });
    const deleted: string[] = [];
    let keyId = 200;
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/app/installations/9') return Response.json({ id: 9, account: { login: 'acme' } });
      if (url.pathname === '/app/installations/9/access_tokens')
        return Response.json({ token: 'token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ id: 8, name: 'broken', private: true,
        ssh_url: 'git@github.com:acme/broken.git', default_branch: 'main', owner: { login: 'acme' } }] });
      if (url.pathname === '/repos/acme/broken/keys' && init.method === 'POST') return Response.json({ id: ++keyId });
      if (url.pathname.startsWith('/repos/acme/broken/keys/') && init.method === 'DELETE') {
        deleted.push(url.pathname); return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    };
    const originalSave = store.setRepositoryDeployKeys.bind(store);
    store.setRepositoryDeployKeys = () => { throw new Error('simulated database failure'); };
    const service = new GitHubAppService(store, broker, { appId: '123', fetch: fakeFetch as typeof fetch,
      keyPair: async () => ({ privateKey: `PRIVATE-${keyId}`, publicKey: `ssh-ed25519 PUBLIC-${keyId}` }) });
    await expect(service.connectInstallation(organization.id, '9')).rejects.toThrow('simulated database failure');
    const repository = store.listRepositories(organization.id)[0]!;
    expect(deleted).toHaveLength(2);
    expect(broker.hasHandle(`github:repository:${repository.id}:clone`)).toBe(false);
    expect(broker.hasHandle(`github:repository:${repository.id}:write`)).toBe(false);
    store.setRepositoryDeployKeys = originalSave;
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
      sleep: async () => {}, // do not actually wait out the 5xx backoff
      keyPair: async () => ({ privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 PUBLIC karmax' }) });
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

  it('never retries a non-idempotent write, so a 5xx cannot duplicate a deploy key', async () => {
    const creates: string[] = [];
    let deleteAttempts = 0;
    const h = harness(async (url, init) => {
      if (url.pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.pathname === '/installation/repositories')
        return Response.json({ repositories: [{ id: 8, name: 'app', private: true,
          ssh_url: 'git@github.com:acme/app.git', default_branch: 'main', owner: { login: 'acme' } }] });
      if (url.pathname === '/repos/acme/app/keys' && init.method === 'POST') {
        // The dangerous shape: GitHub PROCESSES the create and only then fails
        // (or the connection drops). A retry enrolls a SECOND write-capable key
        // whose id karmax never records — orphaned at GitHub forever, since
        // `removeOrphanDeployKeys` only sweeps when there is no local record.
        creates.push(String(init.body));
        return new Response('service unavailable', { status: 503 });
      }
      if (url.pathname === '/repos/acme/app/keys') return Response.json([]); // the orphan sweep's GET
      if (url.pathname.startsWith('/repos/acme/app/keys/') && init.method === 'DELETE')
        return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    const connection = h.store.upsertGitConnection({ organizationId: h.organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });

    await expect(h.service.reconcile(connection)).rejects.toThrow(/503/);
    expect(creates).toHaveLength(1);
    const repository = h.store.listRepositories(h.organization.id)[0]!;
    expect(h.store.repositoryDeployKeys(repository.id)).toBeFalsy();

    // DELETE of a specific key id IS retried: the resource is named, so a repeat
    // either deletes it or 404s (which every caller already tolerates).
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
    // A suspended connection is refused even while a valid token is cached.
    store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'User', suspendedAt: Date.now() });
    await expect(service.installationToken(store.getGitConnection(connection.id)!)).rejects.toThrow(/suspended/);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
