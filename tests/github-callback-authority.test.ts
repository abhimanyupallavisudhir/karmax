import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_CLIENT_SECRET_HANDLE, GITHUB_APP_PRIVATE_KEY_HANDLE } from '../src/integrations/github-app.js';

/**
 * The GitHub callbacks are reached by URLs anyone can forge: a state proves only
 * which karmax user started *some* GitHub flow, and an installation id is a
 * public number. On a hosted cell the App and its installations are shared by
 * every tenant, so neither may be trusted on its own.
 */
describe('GitHub callbacks trust only what they can verify', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  // A fresh port per gateway: fetch pools keep-alive sockets per origin, and a
  // socket to the previous test's closed server fails as "other side closed".
  let boots = 0;
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function boot(options: { hosted?: boolean; configured?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-callback-authority-'));
    const store = await Store.create(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    const conversions: string[] = [];
    const service = await GitHubAppService.create(store, broker, {
      ...(options.configured === false ? {} : { appId: '123', appSlug: 'tavya' }),
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const conversion = url.pathname.match(/^\/app-manifests\/([^/]+)\/conversions$/);
        if (conversion) {
          conversions.push(conversion[1]!);
          return Response.json({ id: 999, slug: 'attacker-app', pem: privateKey, webhook_secret: 'attacker-hook',
            client_id: 'attacker-client', client_secret: 'attacker-secret' });
        }
        if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'victim', type: 'Organization' } });
        if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
        if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ id: 7, name: 'secrets',
          private: true, ssh_url: 'git@github.com:victim/secrets.git', default_branch: 'main', owner: { login: 'victim' } }] });
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });
    if (options.configured !== false) await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    const organization = await store.createOrganization({ name: 'Attacker', ownerUserId: 'attacker' });
    const gateway = await Gateway.create({ store, githubApp: service, broker, hosted: options.hosted,
      identity: { session: async () => ({ user: { id: 'attacker' } }),
        connectOrganizationNames: () => {}, listUsers: () => [] } as any,
      api: {} as any, client: {} as any, tokens: new TokenAuthority(),
      taskQueue: 'test', staticDir: dir, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'github callbacks' } } as any);
    const server = await gateway.listen(await findFreePortFrom(48_900 + 10 * ++boots));
    cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { store, service, broker, organization, base: server.url, conversions };
  }

  it('lets only a manifest flow replace the shared App, and never once one is configured', async () => {
    const { store, service, organization, base, conversions } = await boot();
    // An ordinary GitHub sign-in state (any member can mint one) is not a manifest flow.
    const state = await store.createGithubInstallState(organization.id, 'attacker');
    const response = await fetch(`${base}/api/github/manifest/callback/${state}?code=attacker-code`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(conversions).toEqual([]);
    expect((await service.status()).appId).toBe('123');

    const manifestState = await store.createGithubInstallState(organization.id, 'attacker', { purpose: 'manifest' });
    const configured = await fetch(`${base}/api/github/manifest/callback/${manifestState}?code=attacker-code`, { redirect: 'manual' });
    expect(configured.status).toBe(409);
    expect(conversions).toEqual([]);
    expect((await service.status()).appId).toBe('123');
  });

  it('still completes the manifest flow that creates the first App', async () => {
    const { store, service, organization, base, conversions } = await boot({ configured: false });
    const state = await store.createGithubInstallState(organization.id, 'attacker', { purpose: 'manifest' });
    const response = await fetch(`${base}/api/github/manifest/callback/${state}?code=first-code`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(conversions).toEqual(['first-code']);
    expect((await service.status()).appId).toBe('999');
  });

  it('does not link an installation the signed-in person cannot administer on GitHub', async () => {
    const { store, service, organization, base } = await boot({ hosted: true });
    // Signed in to GitHub, but installation 42 belongs to someone else.
    (service as any).status = async () => ({ configured: true, oauthConfigured: true, userAuthorized: true,
      webhookConfigured: false, syncMode: 'on-demand' });
    (service as any).connectableInstallations = async () => [{ id: '7', accountLogin: 'attacker', accountType: 'User' }];
    const state = await store.createGithubInstallState(organization.id, 'attacker');
    const response = await fetch(`${base}/api/github/callback?installation_id=42&state=${state}`, { redirect: 'manual' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await store.listGitConnections(organization.id)).toEqual([]);
    expect(await store.listRepositories(organization.id)).toEqual([]);
  });

  it('verifies through GitHub before linking when the person has not authorized it yet', async () => {
    const { store, service, broker, organization, base } = await boot({ hosted: true });
    (service as any).status = async () => ({ configured: true, oauthConfigured: true, userAuthorized: false,
      webhookConfigured: false, syncMode: 'on-demand' });
    (service as any).options.clientId = 'client';
    await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret');
    const state = await store.createGithubInstallState(organization.id, 'attacker');
    const response = await fetch(`${base}/api/github/callback?installation_id=42&state=${state}`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(await store.listGitConnections(organization.id)).toEqual([]);
  });

  it('links an installation the person administers', async () => {
    const { store, service, organization, base } = await boot({ hosted: true });
    (service as any).status = async () => ({ configured: true, oauthConfigured: true, userAuthorized: true,
      webhookConfigured: false, syncMode: 'on-demand' });
    (service as any).connectableInstallations = async () => [{ id: '42', accountLogin: 'victim', accountType: 'Organization' }];
    const state = await store.createGithubInstallState(organization.id, 'attacker');
    const response = await fetch(`${base}/api/github/callback?installation_id=42&state=${state}`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(await store.listGitConnections(organization.id)).toHaveLength(1);
  });

  it('has no unverified API for linking an installation by id', async () => {
    const { store, organization, base } = await boot({ hosted: true });
    const response = await fetch(`${base}/api/organizations/${organization.id}/git-connections`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId: '42' }),
    });
    expect(response.status).not.toBe(200);
    expect(await store.listGitConnections(organization.id)).toEqual([]);
  });
});
