import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_CLIENT_SECRET_HANDLE, GITHUB_APP_PERMISSIONS } from '../src/integrations/github-app.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';

type Installation = { id: number; account: { login: string; type: string }; suspended_at?: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(installations: Installation[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-personal-'));
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
  await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'test-secret', INSTALLATION_SCOPE);
  const github = { installations, listingFails: false, repositoriesFail: false };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
    if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
    if (url.pathname === '/user/installations') {
      if (github.listingFails) return Response.json({ message: 'unavailable' }, { status: 502 });
      return Response.json({ installations: github.installations });
    }
    if (url.pathname.startsWith('/user/memberships/orgs/')) return Response.json({ state: 'active', role: 'admin' });
    if (url.pathname === '/app') return Response.json({ slug: 'test-app', permissions: GITHUB_APP_PERMISSIONS });
    const installation = url.pathname.match(/^\/app\/installations\/(\d+)$/);
    if (installation) return Response.json({ ...github.installations.find(item => String(item.id) === installation[1]),
      permissions: GITHUB_APP_PERMISSIONS });
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.pathname === '/installation/repositories' && github.repositoriesFail) return Response.json({ message: 'forbidden' }, { status: 403 });
    if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ id: 7, name: 'pass', owner: { login: 'owner' },
      private: true, ssh_url: 'git@github.com:owner/pass.git', default_branch: 'main' }] });
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };
  const githubApp = await GitHubAppService.create(store, broker, { appId: '123', appSlug: 'test-app', clientId: 'test-client', fetch: fakeFetch as typeof fetch });
  await store.claimPersonalOrganization('me');
  const team = await store.createOrganization({ name: 'Team', ownerUserId: 'me' });
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, broker, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, githubApp,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'personal installation test' } });
  (gateway as any).deps.identity = { session: async () => ({ user: { id: 'me' } }) };
  const server = await gateway.listen(await findFreePortFrom(48860));
  cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const callback = async (organizationId: string, returnTo?: 'profile' | 'installation') => {
    const state = await store.createGithubInstallState(organizationId, 'me', returnTo ? { returnTo } : {});
    const response = await fetch(`${server.url}/api/github/oauth/callback?code=test-code&state=${state}`, { redirect: 'manual' });
    expect(response.status, await response.clone().text()).toBe(303);
    return response.headers.get('location')!;
  };
  const installed = async (state: string, installationId: number) => {
    const response = await fetch(`${server.url}/api/github/callback?installation_id=${installationId}&setup_action=install&state=${state}`, { redirect: 'manual' });
    expect(response.status, await response.clone().text()).toBe(303);
    return response.headers.get('location')!;
  };
  return { store, githubApp, team, github, callback, installed };
}

const own: Installation = { id: 42, account: { login: 'owner', type: 'User' } };
const githubOrganization: Installation = { id: 44, account: { login: 'owner-org', type: 'Organization' } };

it('links the installation on the user\'s own GitHub account to their personal organization', async () => {
  const f = await fixture([githubOrganization, own]);
  // Starting from a team organization still only links the personal organization.
  const location = await f.callback(f.team.id, 'profile');
  expect(location).toContain('github=ready');
  const [connection, ...others] = await f.store.listGitConnections('org_personal');
  expect(others).toEqual([]);
  expect(connection).toMatchObject({ installationId: '42', accountLogin: 'owner' });
  expect((await f.store.listRepositories('org_personal')).map(repo => repo.sshUrl)).toEqual(['git@github.com:owner/pass.git']);
  expect(await f.store.listGitConnections(f.team.id)).toEqual([]);
  // Reconnecting leaves an existing connection alone.
  await f.callback('org_personal', 'profile');
  expect(await f.store.listGitConnections('org_personal')).toEqual([connection]);
});

it('continues to GitHub installation for the personal organization when the App is not installed on the account', async () => {
  const f = await fixture([githubOrganization]);
  const location = new URL(await f.callback('org_personal', 'profile'));
  expect(`${location.origin}${location.pathname}`).toBe('https://github.com/apps/test-app/installations/new');
  const state = location.searchParams.get('state')!;
  expect(await f.store.listGitConnections('org_personal')).toEqual([]);
  // Returning from GitHub lands on the profile: the account is already authorized.
  f.github.installations = [githubOrganization, own];
  const returned = await f.installed(state, 42);
  expect(returned).not.toContain('github.com');
  expect(returned).toContain('github=connected');
  expect((await f.store.listGitConnections('org_personal')).map(item => item.installationId)).toEqual(['42']);
  expect(await f.store.consumeGithubInstallState(state, 'me')).toBeUndefined();
});

it('still authorizes after installation when the GitHub account is not yet authorized', async () => {
  const f = await fixture([own]);
  // App creation from the profile installs before any user authorization exists.
  const state = await f.store.createGithubInstallState('org_personal', 'me', { returnTo: 'profile', selectAccount: true });
  const setup = new URL(await f.installed(state, 42));
  expect(`${setup.origin}${setup.pathname}`).toBe('https://github.com/login/oauth/authorize');
  // So does an installation for an account whose authorization was removed.
  await f.callback('org_personal', 'profile');
  const other = await f.store.createGithubInstallState('org_personal', 'me', { returnTo: 'profile', githubAccountId: '2', githubLogin: 'second' });
  expect(new URL(await f.installed(other, 42)).pathname).toBe('/login/oauth/authorize');
});

it('leaves explicit installation choice and other authorization flows unchanged', async () => {
  const f = await fixture([own]);
  expect(await f.callback('org_personal', 'installation')).toContain('github=choose-installation');
  expect(await f.store.listGitConnections('org_personal')).toEqual([]);
  // Non-profile authorization links an available installation but never detours to GitHub.
  f.github.installations = [];
  expect(await f.callback(f.team.id)).toContain('github=ready');
  f.github.installations = [own];
  expect(await f.callback(f.team.id)).toContain('github=ready');
  expect((await f.store.listGitConnections('org_personal')).map(item => item.installationId)).toEqual(['42']);
});

it('completes GitHub sign-in when installation discovery or linking fails', async () => {
  const f = await fixture([own]);
  f.github.listingFails = true;
  expect(await f.callback('org_personal', 'profile')).toContain('github=ready');
  expect(await f.store.listGitConnections('org_personal')).toEqual([]);
  f.github.listingFails = false;
  f.github.repositoriesFail = true;
  expect(await f.callback('org_personal', 'profile')).toContain('github=ready');
});
