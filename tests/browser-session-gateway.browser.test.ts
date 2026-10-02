// End to end through the gateway: one task saves the session of a site
// signed into in its browser (reached through an identity provider, as with
// "Sign in with Google"), and another task, once approved, starts signed in.
// Real HTTP gateway, vault and Chromium; only "which browser is this task's"
// is pinned, as the custody lookup needs a running agent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import * as taskBrowser from '../src/autonomy/task-browser.js';
import { launchChromium } from './helpers/browser.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-session-gateway-'));
let browser: Browser, devtools: string, sitePort: number, site: https.Server;

beforeAll(async () => {
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=notes.test',
    '-keyout', path.join(dir, 'tls.key'), '-out', path.join(dir, 'tls.crt')], { stdio: 'ignore' });
  site = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls.key')), cert: fs.readFileSync(path.join(dir, 'tls.crt')) }, (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'https://local');
    res.setHeader('content-type', 'text/html');
    // The identity provider signs the person in and sends them back to the site.
    if (host === 'accounts.idp.test') {
      res.setHeader('set-cookie', 'idp_sid=IDP-SECRET; Secure; HttpOnly; Path=/; Max-Age=3600');
      res.writeHead(302, { location: `https://app.notes.test:${sitePort}/oauth/callback?code=ok` }).end();
      return;
    }
    if (url.pathname === '/oauth/callback') {
      res.setHeader('set-cookie', 'notes_sid=NOTES-SECRET; Secure; HttpOnly; Path=/; Max-Age=3600');
      res.writeHead(302, { location: '/' }).end();
      return;
    }
    const signedIn = /(?:^|; )notes_sid=NOTES-SECRET(?:;|$)/.test(String(req.headers.cookie ?? ''));
    res.end(`<!doctype html><div id="who">${signedIn ? 'alice' : 'signed out'}</div>`);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  sitePort = (site.address() as AddressInfo).port;
  const cdpPort = await findFreePortFrom(49600);
  devtools = `http://127.0.0.1:${cdpPort}`;
  browser = await launchChromium({ args: [`--remote-debugging-port=${cdpPort}`, '--host-resolver-rules=MAP *.test 127.0.0.1', '--ignore-certificate-errors'] });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await browser?.close();
  site?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function freshPage(url: string): Promise<Page> {
  const context = browser.contexts()[0] ?? await browser.newContext();
  for (const page of context.pages()) await page.close();
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

it('saves a site\'s session from one task and signs another task in after approval', async () => {
  const store = await Store.create(':memory:');
  let close: (() => Promise<void>) | undefined;
  try {
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const vault = new VaultItems(store, broker, dir);
    const project = await store.createProject('Sessions');
    const task = async (title: string) => {
      const created = await store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
      await store.saveView(created.id, { taskId: created.id, title, workflow: 'just-do', stage: 'do', status: 'active', worldPath: path.join(dir, title), branch: `karmax/${title}` } as any);
      return created;
    };
    const saver = await task('saver');
    const user = await task('user');
    vi.spyOn(taskBrowser, 'localTaskBrowserUrl').mockImplementation(() => devtools);
    const tokens = new TokenAuthority();
    const gateway = await Gateway.create({ store, broker, bus: new KarmaxBus(), tokens,
      contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
      taskQueue: 'test', staticDir: dir, agentInfo: { provider: 'mock', reason: 'session test' }, worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_600));
    close = running.close;
    const mint = async (taskId: string, ceiling: string[]) => (await tokens.mint({ taskId, projectId: project.id, organizationId: 'org_personal',
      principal: `task:${taskId}`, profileId: 'test', ceiling, grantorCaps: ceiling })).token;
    const saverToken = await mint(saver.id, ['credential:read', 'vault:store']);
    // Using a saved session needs no right to store credentials.
    const userToken = await mint(user.id, ['credential:read']);
    const call = async (token: string, route: string, body: unknown) => {
      const response = await fetch(`${running.url}/api/vault/session/${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };

    // The person signs in through the identity provider, in the saver's browser.
    const page = await freshPage(`https://accounts.idp.test:${sitePort}/signin`);
    expect(await page.textContent('#who')).toBe('alice');

    expect((await call(saverToken, 'save', { domain: 'com' })).body.error).toMatch(/public suffix/);
    expect((await call(userToken, 'save', { domain: 'notes.test' })).status).toBe(403);
    const saved = await call(saverToken, 'save', { domain: 'notes.test', username: 'alice' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ domains: ['notes.test'], cookies: 1, localStorage: false, sessionStorage: false, indexedDB: [] });
    expect(JSON.stringify(saved.body)).not.toContain('SECRET');
    const item = (await vault.get(saved.body.itemId))!;
    expect(item).toMatchObject({ type: 'session', label: 'notes.test (signed in)', username: 'alice', policy: { use: 'auto', reveal: 'never' } });
    const stored = vault.readSecret(item, 'session')!;
    expect(stored).toContain('NOTES-SECRET');
    expect(stored).not.toContain('IDP-SECRET');

    // An agent never sees the value, and a lookup by site still finds logins first.
    const reveal = await fetch(`${running.url}/api/vault/resolve`, { method: 'POST',
      headers: { authorization: `Bearer ${saverToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ itemId: item.id }) });
    expect(await reveal.json()).toMatchObject({ status: 'denied' });
    const login = await vault.save({ type: 'login', label: 'Notes login', domains: ['notes.test'], secrets: { password: 'pw' } });
    expect((await vault.findByDomain('app.notes.test')).map((i) => i.id)).toContain(item.id);
    const lookup = await fetch(`${running.url}/api/vault/fill`, { method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'notes.test', selector: '#pw' }) });
    expect(await lookup.json()).toMatchObject({ itemId: login.id });

    // Another task's browser, signed out and on the site.
    const other = await freshPage(`https://app.notes.test:${sitePort}/`);
    expect(await other.textContent('#who')).toBe('signed out');
    const asked = await call(userToken, 'use', { domain: 'notes.test', why: 'edit the shared notes' });
    expect(asked.body).toMatchObject({ status: 'needs_approval', itemId: item.id });
    expect((await vault.requests({ taskId: user.id, status: 'pending' })).filter((r) => r.itemId === item.id).map((r) => r.id)).toEqual([asked.body.requestId]);
    expect(await other.textContent('#who')).toBe('signed out');

    await vault.resolve(asked.body.requestId, { action: 'once', by: 'user:test' });
    const used = await call(userToken, 'use', { domain: 'notes.test' });
    expect(used.body).toMatchObject({ status: 'granted', itemId: item.id, cookies: 1, expired: 0,
      fallback: [{ itemId: login.id, type: 'login', tool: 'fill_credential' }] });
    // Both browsers now hold it, so it is refreshed from them after each turn.
    for (const holder of [saver, user]) expect(await store.kvGet(`vault:session-holds:${holder.id}`)).toContain(item.id);
    expect(JSON.stringify(used.body)).not.toContain('SECRET');
    await other.waitForFunction("document.getElementById('who')?.textContent === 'alice'");
    expect((await other.context().cookies()).map((c) => c.name)).toEqual(['notes_sid']);
    // A one-time approval is spent.
    expect((await call(userToken, 'use', { itemId: item.id })).body.status).toBe('needs_approval');

    // The saver refreshes its own session in place.
    const refreshed = await call(saverToken, 'save', { itemId: item.id });
    expect(refreshed.body.itemId).toBe(item.id);
    expect((await vault.list()).filter((i) => i.type === 'session')).toHaveLength(1);

    // A restore runs only on the site itself.
    await freshPage(`https://elsewhere.test:${sitePort}/`);
    await vault.resolve((await call(userToken, 'use', { itemId: item.id })).body.requestId, { action: 'once', by: 'user:test' });
    expect((await call(userToken, 'use', { itemId: item.id })).body.error).toMatch(/no open page matches notes.test/);
    // …and a restore that could not run did not spend the approval.
    expect((await vault.access([], user.id, item, 'use')).status).toBe('granted');
    expect(await browser.contexts()[0]!.cookies()).toEqual([]);
    expect((await call(userToken, 'use', { domain: 'missing.test' })).body).toMatchObject({ status: 'not_in_vault' });

    // An expired session says so, names the site's own sign-in, and spends no approval.
    const working = vault.readSecret(item, 'session')!;
    const expiredSession = JSON.parse(working);
    for (const cookie of expiredSession.cookies) cookie.expires = Math.floor(Date.now() / 1000) - 60;
    await vault.save({ id: item.id, type: 'session', secrets: { session: JSON.stringify(expiredSession) } });
    await freshPage(`https://app.notes.test:${sitePort}/`);
    expect((await call(userToken, 'use', { itemId: item.id })).body).toMatchObject({ status: 'expired',
      fallback: [{ itemId: login.id, tool: 'fill_credential' }], next: expect.stringContaining(`fill_credential (itemId ${login.id}`) });
    expect((await vault.access([], user.id, item, 'use')).status).toBe('granted');

    // One task at a time: a second task waits until the holder lets go.
    await vault.save({ id: item.id, type: 'session', exclusive: true, secrets: { session: working } });
    expect((await call(userToken, 'use', { itemId: item.id })).body).toMatchObject({ status: 'granted' });
    const third = await task('third');
    const thirdToken = await mint(third.id, ['credential:read']);
    await vault.resolve((await call(thirdToken, 'use', { itemId: item.id })).body.requestId, { action: 'once', by: 'user:test' });
    const waiting = await call(thirdToken, 'use', { itemId: item.id });
    expect(waiting.body).toMatchObject({ status: 'busy', heldBy: { taskId: user.id, title: 'user' } });
    expect((await vault.access([], third.id, item, 'use')).status).toBe('granted');
    await store.saveView(user.id, { taskId: user.id, title: 'user', workflow: 'just-do', stage: 'done', status: 'done' } as any);
    expect((await call(thirdToken, 'use', { itemId: item.id })).body).toMatchObject({ status: 'granted' });
  } finally {
    await close?.();
    await store.close();
  }
}, 60_000);
