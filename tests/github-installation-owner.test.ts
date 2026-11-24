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

// 2026-11-24: a person whose tavya profile is linked to one GitHub account
// (@abhimanyupallavisudhir) installed the App on another GitHub account of
// theirs (@tshangdas, a User) and got "GitHub could not be connected: This
// GitHub installation is not available to this account". Only @tshangdas can
// administer that installation, so tavya must learn the person controls it:
// it asks GitHub (the account picker), links the account and connects the
// installation in one go. It never says whose an installation is: anyone may
// put any installation id in the callback URL.

type Installation = { id: number; account: { login: string; type: string } };
const GITHUB_USERS: Record<string, { token: string; id: number; login: string }> = {
  'code-main': { token: 'token-main', id: 1, login: 'main' },
  'code-other': { token: 'token-other', id: 2, login: 'other' },
};
const main: Installation = { id: 42, account: { login: 'main', type: 'User' } };
const other: Installation = { id: 43, account: { login: 'other', type: 'User' } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-installation-owner-'));
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
  await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'test-secret', INSTALLATION_SCOPE);
  const installations = [main, other];
  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/login/oauth/access_token') {
      const user = GITHUB_USERS[new URLSearchParams(String(init.body)).get('code') ?? ''];
      return Response.json(user ? { access_token: user.token } : { error: 'bad_verification_code' });
    }
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
    const user = Object.values(GITHUB_USERS).find((candidate) => auth === `Bearer ${candidate.token}`);
    if (url.pathname === '/user' && user) return Response.json({ id: user.id, login: user.login });
    // A personal installation is listed only to the account it is installed on.
    if (url.pathname === '/user/installations' && user)
      return Response.json({ installations: installations.filter((item) => item.account.login === user.login) });
    if (url.pathname === '/app') return Response.json({ slug: 'test-app', permissions: GITHUB_APP_PERMISSIONS });
    const installation = url.pathname.match(/^\/app\/installations\/(\d+)$/);
    if (installation) {
      const found = installations.find((item) => String(item.id) === installation[1]);
      return found ? Response.json({ ...found, permissions: GITHUB_APP_PERMISSIONS })
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.pathname === '/installation/repositories') return Response.json({ repositories: [] });
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
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'installation owner test' } });
  (gateway as any).deps.identity = { session: async () => ({ user: { id: 'me' } }) };
  const server = await gateway.listen(await findFreePortFrom(48880));
  cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async (pathname: string) => {
    const response = await fetch(`${server.url}${pathname}`, { redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') ?? '', text: await response.text() };
  };
  /** GitHub's OAuth return for a state tavya issued. */
  const authorized = (state: string, code: string) => get(`/api/github/oauth/callback?code=${code}&state=${state}`);
  /** GitHub's installation return for an installation tavya asked for. */
  const installed = async (installationId: number) => {
    const state = await store.createGithubInstallState(team.id, 'me');
    return get(`/api/github/callback?installation_id=${installationId}&setup_action=install&state=${state}`);
  };
  // The person's tavya profile is linked to @main.
  expect((await authorized(await store.createGithubInstallState(team.id, 'me', { returnTo: 'installation' }), 'code-main')).status).toBe(303);
  return { store, githubApp, team, authorized, installed };
}

it('connects an installation on another GitHub account of the person after GitHub confirms they are signed in to it', async () => {
  const f = await fixture();
  const detour = await f.installed(43);
  expect(detour.status, detour.text).toBe(303);
  const picker = new URL(detour.location);
  expect(`${picker.origin}${picker.pathname}`).toBe('https://github.com/login/oauth/authorize');
  expect(picker.searchParams.get('login')).toBeNull();
  expect(picker.searchParams.get('prompt')).toBe('select_account');
  expect(await f.store.listGitConnections(f.team.id)).toEqual([]);

  const back = await f.authorized(picker.searchParams.get('state')!, 'code-other');
  expect(back.status, back.text).toBe(303);
  expect(back.location).toContain('github=connected');
  expect((await f.store.listGitConnections(f.team.id)).map((connection) => connection.installationId)).toEqual(['43']);
  // @other is linked too, without taking over as the account the person works as.
  expect(await f.githubApp.listUserAccounts('me')).toEqual([
    expect.objectContaining({ login: 'main', active: true }),
    expect.objectContaining({ login: 'other', active: false }),
  ]);
});

it('says what to do, without naming the installation\'s account, when GitHub confirms a different one', async () => {
  const f = await fixture();
  const picker = new URL((await f.installed(43)).location);
  const back = await f.authorized(picker.searchParams.get('state')!, 'code-main');
  expect(back.status).toBe(502);
  expect(back.text).toContain('The App was installed on a GitHub account that @main does not administer');
  expect(back.text).not.toContain('other');
  expect(await f.store.listGitConnections(f.team.id)).toEqual([]);
});

it('connects an installation any linked GitHub account administers, not only the active one', async () => {
  const f = await fixture();
  await f.authorized((new URL((await f.installed(43)).location)).searchParams.get('state')!, 'code-other');
  // @main is still the active account; @other's installation connects directly.
  const team2 = await f.store.createOrganization({ name: 'Second team', ownerUserId: 'me' });
  expect((await f.githubApp.connectExistingInstallation(team2.id, 'me', '43')).connection)
    .toMatchObject({ installationId: '43', accountLogin: 'other' });
});

it('refuses an installation that does not exist for the App without a detour to GitHub', async () => {
  const f = await fixture();
  const forged = await f.installed(99);
  expect(forged.status).toBe(502);
  expect(forged.text).toContain('This GitHub installation is not available to this account');
});
