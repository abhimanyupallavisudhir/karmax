import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE } from '../src/integrations/github-app.js';

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
    expect(manifest.manifest).not.toHaveProperty('default_events');
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
