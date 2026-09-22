import { expect, it } from 'vitest';
import { chromium } from 'playwright';
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

it('connects an already-installed GitHub account from settings and survives reload without a setup callback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-existing-browser-'));
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
  await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'test-secret');
  let visible = true;
  let listingFails = false;
  const fakeFetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
    if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
    if (url.pathname === '/user/installations') return Response.json({ installations: visible ? [
      { id: 42, account: { login: 'owner', type: 'User' } },
      { id: 43, account: { login: 'someone-else', type: 'User' } },
      { id: 44, account: { login: 'member-only', type: 'Organization' } },
      { id: 45, account: { login: 'suspended', type: 'User' }, suspended_at: new Date().toISOString() },
    ] : [] });
    if (url.pathname === '/user/memberships/orgs/member-only') return Response.json({ state: 'active', role: 'member' });
    if (url.pathname === '/app') return Response.json({ slug: 'test-app', permissions: GITHUB_APP_PERMISSIONS });
    if (url.pathname === '/app/installations/42') return Response.json({ id: 42,
      account: { login: 'owner', type: 'User' }, permissions: GITHUB_APP_PERMISSIONS });
    if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.pathname === '/installation/repositories') {
      if (listingFails) return Response.json({ message: 'Repository listing forbidden' }, { status: 403 });
      return Response.json({ repositories: [{ id: 7, name: 'repo', owner: { login: 'owner' }, private: true,
        ssh_url: 'git@github.com:owner/repo.git', default_branch: 'main' }] });
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };
  const githubApp = await GitHubAppService.create(store, broker, { appId: '123', appSlug: 'test-app', clientId: 'test-client', fetch: fakeFetch as typeof fetch });
  await githubApp.adoptUserAuthorization('me', '1', { accessToken: 'user-token' });
  await store.claimPersonalOrganization('me');
  const solab = await store.createOrganization({ name: 'Solab', ownerUserId: 'me' });
  const original = await githubApp.connectExistingInstallation('org_personal', 'me', '42');
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, broker, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, githubApp,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'browser test' } });
  const server = await gateway.listen(await findFreePortFrom(48820));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/solab/settings#settings-code`);
    await page.locator('#connect-github').click();
    await page.locator('#github-existing-installation').waitFor();
    expect(await page.locator('#github-existing-installation option').allTextContents()).toEqual(['owner']);
    // A permission change while the picker is open must be checked on submit.
    visible = false;
    await page.locator('#github-connect-existing').click();
    await page.getByText('This GitHub installation is not available to this account', { exact: true }).waitFor();
    expect(await store.listGitConnections(solab.id)).toEqual([]);
    visible = true;
    listingFails = true;
    await page.locator('#github-connect-existing').click();
    await page.locator('#github-connect-error').filter({ hasText: 'Repository listing forbidden' }).waitFor();
    listingFails = false;
    await page.locator('#github-connect-existing').click();
    await page.locator('#org-github .github-account-row').waitFor();
    await page.reload();
    await page.locator('#org-github .github-account-row').waitFor();
    expect(await page.locator('#org-github .github-account-label').innerText()).toContain('owner');
    const linked = (await store.listGitConnections(solab.id))[0]!;
    expect(linked.installationId).toBe('42');
    expect(linked.id).not.toBe(original.connection.id);
    expect((await store.listRepositories(solab.id)).map(repo => repo.name)).toEqual(['repo']);
    expect(await store.getGitConnection(original.connection.id)).toEqual(original.connection);
    expect(page.url()).toContain('/solab/settings');
    await expect(githubApp.connectExistingInstallation(solab.id, 'me', '43')).rejects.toThrow('not available');
    await expect(githubApp.connectExistingInstallation(solab.id, 'me', '44')).rejects.toThrow('not available');
    // No eligible installation preserves the new-installation path.
    visible = false;
    const session = await (await page.request.get(`${server.url}/api/session`)).json();
    const response = await page.request.post(`${server.url}/api/organizations/${solab.id}/github/install-url`, {
      headers: { Authorization: `Bearer ${session.token}` }, data: {},
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ installations: [], url: expect.stringContaining('/apps/test-app/installations/new?state=') });
    // Repository writes and tenant membership are both required at the new route.
    const reader = await tokens.mintPrincipal('user:me', ['repository:read'], undefined, 60_000, solab.id);
    const denied = await fetch(`${server.url}/api/organizations/${solab.id}/github/connect-existing`, {
      method: 'POST', headers: { Authorization: `Bearer ${reader.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: '42' }),
    });
    expect(denied.status).toBe(403);
    const outsider = await tokens.mintPrincipal('user:outsider', ['repository:write'], undefined, 60_000, solab.id);
    (gateway as any).sessions.set('test-outsider-session', { user: 'outsider', userId: 'outsider', apiToken: outsider.token });
    const noMembership = await fetch(`${server.url}/api/organizations/${solab.id}/github/connect-existing`, {
      method: 'POST', headers: { Authorization: 'Bearer test-outsider-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: '42' }),
    });
    expect(noMembership.status).toBe(403);
    await store.setOrganizationMembership(solab.id, 'outsider', 'member');
    const needsOAuth = await fetch(`${server.url}/api/organizations/${solab.id}/github/install-url`, {
      method: 'POST', headers: { Authorization: 'Bearer test-outsider-session', 'Content-Type': 'application/json' }, body: '{}',
    });
    const oauthResult = await needsOAuth.json() as { url: string };
    expect(needsOAuth.status, JSON.stringify(oauthResult)).toBe(200);
    const oauthUrl = new URL(oauthResult.url);
    expect(oauthUrl.pathname).toBe('/login/oauth/authorize');
    const state = oauthUrl.searchParams.get('state')!;
    expect(await store.consumeGithubInstallState(state, 'me')).toBeUndefined();
    expect(await store.consumeGithubInstallState(state, 'outsider')).toMatchObject({ organizationId: solab.id, returnTo: 'installation' });
    expect(await store.consumeGithubInstallState(state, 'outsider')).toBeUndefined();
    visible = true;
    await page.goto(`${server.url}/solab/settings?github=choose-installation#settings-code`);
    await page.locator('#github-existing-installation').waitFor();
    expect(page.url()).not.toContain('choose-installation');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.reload();
    await page.locator('#org-github .github-account-row').waitFor();
    expect(await page.locator('#github-existing-installation').count()).toBe(0);
    visible = false;
    await page.locator('#connect-github').click();
    await page.getByText('No existing installations are available for this GitHub account.', { exact: false }).waitFor();
    expect(await page.locator('#github-connect-existing').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'Install on another GitHub account' }).getAttribute('href'))
      .toContain('/apps/test-app/installations/new?state=');
    await page.route('https://github.com/login/oauth/authorize**', route => route.fulfill({ body: 'GitHub account selector' }));
    await page.locator('#github-switch-account').click();
    await page.waitForURL('https://github.com/login/oauth/authorize**');
    const switchUrl = new URL(page.url());
    expect(switchUrl.searchParams.get('prompt')).toBe('select_account');
    expect(await store.consumeGithubInstallState(switchUrl.searchParams.get('state')!, 'me'))
      .toMatchObject({ returnTo: 'installation', selectAccount: true, organizationId: solab.id });
    // Exercise the actual OAuth callback, not just the stored continuation.
    (gateway as any).deps.identity = { session: async () => ({ user: { id: 'me' } }) };
    const callbackState = await store.createGithubInstallState(solab.id, 'me', { returnTo: 'installation' });
    const callbackUrl = `${server.url}/api/github/oauth/callback?code=test-code&state=${callbackState}`;
    const callback = await fetch(callbackUrl, { redirect: 'manual' });
    expect(callback.status, await callback.clone().text()).toBe(303);
    expect(callback.headers.get('location')).toBe(`/solab/settings?github=choose-installation&organizationId=${solab.id}#settings-code`);
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(400);
  } finally { await browser.close(); await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
