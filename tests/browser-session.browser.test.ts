// Saved browser sessions: a site signed into once (by any method, including
// "Sign in with Google") is captured from one task's browser and restored into
// another's. Driven against a real Chromium whose *.test hosts resolve to a
// local HTTPS server, on both paths the gateway uses: its own CDP connection
// and the bridge that relays a remote world's browser over a terminal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPage } from '../src/autonomy/cdp.js';
import { openWorldPage } from '../src/autonomy/world-fill.js';
import {
  captureSession, restoreSession, refreshSession, sessionState, sessionDomainError, cookieBelongs, parseSavedSession, type SavedSession,
} from '../src/autonomy/browser-session.js';
import { openSpawnedPty } from '../src/world/local-execution.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { launchChromium } from './helpers/browser.js';
import type { World } from '../src/world/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-session-'));
let browser: Browser, devtools: string, port: number, server: https.Server;

// app.example.test signs in by setting a host-only session cookie and a
// parent-domain preference cookie, and keeps a token in localStorage; the
// identity provider (idp.test) has a session cookie of its own.
function serve(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  const url = new URL(req.url ?? '/', 'https://local');
  const cookies = String(req.headers.cookie ?? '');
  const html = (body: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(`<!doctype html><title>${host}</title>${body}`);
  };
  if (host === 'app.example.test' && url.pathname === '/login') return html(
    '<script>localStorage.setItem("token", "T1")</script>signed in',
    { 'set-cookie': ['sid=S1; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600', 'pref=dark; Domain=example.test; Secure; Path=/; Max-Age=3600'] });
  if (host === 'app.example.test') return html(
    `<div id="who">${/(?:^|; )sid=S1(?:;|$)/.test(cookies) ? 'alice' : 'signed out'}</div>
     <script>document.title = localStorage.getItem('token') || 'none'</script>`);
  if (host === 'idp.test' && url.pathname === '/login') return html('idp', { 'set-cookie': 'gsid=G1; Secure; HttpOnly; Path=/; Max-Age=3600' });
  // A Firebase-style app: its sign-in lives in IndexedDB, behind a connection
  // the page keeps open, plus a per-tab marker in sessionStorage. A second
  // database holds a non-extractable CryptoKey, which no copy can carry.
  if (host === 'fire.example.test') return html(`<div id="who">loading</div><script>
    const open = indexedDB.open('firebaseLocalStorageDb', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
    open.onsuccess = async () => {
      const db = window.db = open.result;
      const who = document.getElementById('who');
      if (location.pathname === '/login') {
        const tx = db.transaction('firebaseLocalStorage', 'readwrite');
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'firebase:authUser', value: { email: 'alice@example.test', at: new Date(1000), key: new Uint8Array([1, 2, 3]), $t: 'literal' } });
        sessionStorage.setItem('tab', 'T');
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
        const keys = indexedDB.open('device-keys', 1);
        keys.onupgradeneeded = () => keys.result.createObjectStore('keys');
        keys.onsuccess = () => { const t = keys.result.transaction('keys', 'readwrite'); t.objectStore('keys').put(key, 'k'); t.oncomplete = () => { tx.oncomplete = null; who.textContent = 'stored'; }; };
        return;
      }
      const read = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').get('firebase:authUser');
      read.onsuccess = () => {
        const user = read.result && read.result.value;
        who.textContent = user ? [user.email, user.at instanceof Date && user.at.getTime(), user.key instanceof Uint8Array && user.key.join(','), user.$t, sessionStorage.getItem('tab')].join('|') : 'signed out';
      };
    };</script>`);
  return html('a page');
}

beforeAll(async () => {
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=example.test',
    '-keyout', path.join(dir, 'tls.key'), '-out', path.join(dir, 'tls.crt')], { stdio: 'ignore' });
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls.key')), cert: fs.readFileSync(path.join(dir, 'tls.crt')) }, serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const cdpPort = await findFreePortFrom(49500);
  devtools = `http://127.0.0.1:${cdpPort}`;
  browser = await launchChromium({ args: [`--remote-debugging-port=${cdpPort}`, '--host-resolver-rules=MAP *.test 127.0.0.1', '--ignore-certificate-errors'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (host: string, pathname = '/') => `https://${host}:${port}${pathname}`;

/** A fresh browser state with one page open on `url`. */
async function open(url: string): Promise<Page> {
  const context = browser.contexts()[0] ?? await browser.newContext();
  for (const page of context.pages()) await page.close();
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function signIn(): Promise<Page> {
  const page = await open(at('idp.test', '/login'));
  await page.goto(at('app.example.test', '/login'));
  await page.goto(at('app.example.test'));
  expect(await page.textContent('#who')).toBe('alice');
  return page;
}

async function signOut(page: Page) {
  await page.evaluate(() => localStorage.clear());
  await page.context().clearCookies();
  await page.reload();
  expect(await page.textContent('#who')).toBe('signed out');
}

// A remote world: the bridge runs in a real terminal, as in E2B or Daytona.
const world = (root: string): World => ({
  handle: { kind: 'e2b', id: 'task', root, branch: 'b', base: 'main' },
  writeFile: async (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); },
  openPty: async (spec: any) => openSpawnedPty('bash', ['-lc', spec.command]),
}) as any;

const paths = {
  gateway: (domains: string[]) => openPage(devtools, { expectDomains: domains }),
  world: (domains: string[]) => openWorldPage(world(dir), { expectDomains: domains, cdpUrl: devtools }),
};

describe.each(Object.keys(paths) as Array<keyof typeof paths>)('the %s browser path', (name) => {
  const pageOn = paths[name];

  it('captures the site\'s own cookies and storage, and signs a signed-out browser back in', async () => {
    const page = await signIn();
    const capture = await pageOn(['example.test']);
    let saved: SavedSession;
    try { ({ saved } = await captureSession(capture.session, ['example.test'])); } finally { await capture.session.close(); }
    expect(saved.cookies.map((c) => c.name).sort()).toEqual(['pref', 'sid']);
    expect(saved.cookies.find((c) => c.name === 'sid')).toMatchObject({ domain: 'app.example.test', httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(saved.storage).toEqual([{ origin: at('app.example.test').replace(/\/$/, ''), localStorage: [['token', 'T1']] }]);
    expect(JSON.stringify(saved)).not.toContain('G1');

    await signOut(page);
    const restore = await pageOn(['example.test']);
    try {
      expect(await restoreSession(restore.session, ['example.test'], parseSavedSession(JSON.stringify(saved))))
        .toEqual({ cookies: 2, expired: 0, localStorage: true, sessionStorage: false, indexedDB: [] });
    } finally { await restore.session.close(); }
    await page.waitForFunction("document.getElementById('who')?.textContent === 'alice'");
    expect(await page.title()).toBe('T1');
    // The host-only cookie stays host-only.
    const sid = (await page.context().cookies()).find((c) => c.name === 'sid');
    expect(sid?.domain).toBe('app.example.test');
    expect(sid?.httpOnly).toBe(true);
  });
});

describe('apps that sign in through web storage', () => {
  it('carries IndexedDB and sessionStorage across, even while the page holds the database open', async () => {
    const page = await open(at('fire.example.test', '/login'));
    await page.waitForFunction("document.getElementById('who')?.textContent === 'stored'");
    await page.goto(at('fire.example.test'));
    const signedIn = 'alice@example.test|1000|1,2,3|literal|T';
    await page.waitForFunction(`document.getElementById('who')?.textContent === ${JSON.stringify(signedIn)}`);
    const capture = await openPage(devtools, { expectDomains: ['example.test'] });
    let captured: Awaited<ReturnType<typeof captureSession>>;
    try { captured = await captureSession(capture.session, ['example.test']); } finally { await capture.session.close(); }
    expect(captured.saved.storage[0]!.indexedDB?.map((db) => db.name)).toEqual(['firebaseLocalStorageDb']);
    expect(captured.saved.storage[0]!.sessionStorage).toEqual([['tab', 'T']]);
    expect(captured.omitted).toEqual(['IndexedDB "device-keys" (holds values that cannot be copied)']);

    // Signed out: the app's database emptied and the tab marker gone.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Storage.clearDataForOrigin', { origin: at('fire.example.test').replace(/\/$/, ''), storageTypes: 'indexeddb' });
    await page.evaluate('sessionStorage.clear()');
    await page.reload();
    await page.waitForFunction("document.getElementById('who')?.textContent === 'signed out'");

    const restore = await openPage(devtools, { expectDomains: ['example.test'] });
    try {
      expect(await restoreSession(restore.session, ['example.test'], parseSavedSession(JSON.stringify(captured.saved))))
        .toMatchObject({ indexedDB: ['firebaseLocalStorageDb'], sessionStorage: true });
    } finally { await restore.session.close(); }
    await page.waitForFunction(`document.getElementById('who')?.textContent === ${JSON.stringify(signedIn)}`);
  });
});

describe('refreshing', () => {
  const stored = (cookies: SavedSession['cookies']): SavedSession => ({ version: 1, capturedAt: 1, cookies, storage: [] });
  const cookie = (name: string, value: string) => ({ name, value, domain: 'app.example.test', path: '/', secure: true, httpOnly: true });

  it('takes what the site rotated or added, and never what it dropped', async () => {
    const page = await open(at('app.example.test'));
    await page.context().addCookies([
      { name: 'sid', value: 'S2', domain: 'app.example.test', path: '/', secure: true, httpOnly: true },
      { name: 'csrf', value: 'C1', domain: 'app.example.test', path: '/', secure: true, httpOnly: false },
      { name: 'gsid', value: 'G1', domain: 'idp.test', path: '/', secure: true, httpOnly: true },
    ]);
    const target = await openPage(devtools, {});
    try {
      const { saved, changed } = await refreshSession(target.session, ['example.test'],
        stored([cookie('sid', 'S1'), cookie('remember', 'R1')]), 5_000);
      expect(changed).toBe(true);
      expect(saved.capturedAt).toBe(5_000);
      expect(Object.fromEntries(saved.cookies.map((c) => [c.name, c.value]))).toEqual({ sid: 'S2', remember: 'R1', csrf: 'C1' });
      // A browser that lost the session changes nothing.
      await page.context().clearCookies();
      const empty = await refreshSession(target.session, ['example.test'], saved);
      expect(empty).toEqual({ saved, changed: false });
    } finally { await target.session.close(); }
  });

  it('knows when nothing is left to sign in with', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(sessionState(stored([{ ...cookie('sid', 'S1'), expires: past }]), ['example.test'])).toMatchObject({ usable: false, expired: 1 });
    expect(sessionState(stored([cookie('sid', 'S1')]), ['example.test'])).toMatchObject({ usable: true, expired: 0 });
  });
});

describe('restoring', () => {
  const session = (cookies: SavedSession['cookies'], storage: SavedSession['storage'] = []): SavedSession =>
    ({ version: 1, capturedAt: Date.now(), cookies, storage });
  const cookie = (name: string, domain: string, extra: Partial<SavedSession['cookies'][number]> = {}) =>
    ({ name, value: `${name}-value`, domain, path: '/', secure: true, httpOnly: true, ...extra });

  it('sets no cookie outside the item\'s domains and drops expired ones', async () => {
    const page = await open(at('app.example.test'));
    const target = await openPage(devtools, { expectDomains: ['example.test'] });
    try {
      const result = await restoreSession(target.session, ['example.test'], session([
        cookie('sid', 'app.example.test', { value: 'S1' }),
        cookie('gsid', 'idp.test'),
        cookie('stale', '.example.test', { expires: Math.floor(Date.now() / 1000) - 60 }),
      ]));
      expect(result).toMatchObject({ cookies: 1, expired: 1, localStorage: false });
    } finally { await target.session.close(); }
    await page.waitForFunction("document.getElementById('who')?.textContent === 'alice'");
    expect((await page.context().cookies()).map((c) => c.name)).toEqual(['sid']);
  });

  it('refuses a page of another site and sets nothing', async () => {
    const page = await open(at('other.test'));
    const target = await openPage(devtools, {});
    try {
      await expect(restoreSession(target.session, ['example.test'], session([cookie('sid', 'app.example.test')])))
        .rejects.toThrow(/does not match/);
      await expect(captureSession(target.session, ['example.test'])).rejects.toThrow(/does not match/);
    } finally { await target.session.close(); }
    expect(await page.context().cookies()).toEqual([]);
  });

  it('writes localStorage only into the origin it came from', async () => {
    const page = await open(at('www.example.test'));
    const target = await openPage(devtools, { expectDomains: ['example.test'] });
    try {
      const result = await restoreSession(target.session, ['example.test'],
        session([], [{ origin: at('app.example.test').replace(/\/$/, ''), localStorage: [['token', 'T1']] }]));
      expect(result.localStorage).toBe(false);
    } finally { await target.session.close(); }
    await expect.poll(() => page.evaluate(() => localStorage.length).catch(() => -1)).toBe(0);
  });
});

describe('session scope', () => {
  it('names a site, never a public suffix', () => {
    for (const domain of ['com', 'co.uk', 'github.io', '*.com', '', 'exa mple.com']) expect(sessionDomainError(domain)).toBeTruthy();
    for (const domain of ['github.com', 'app.example.test', 'alice.github.io', 'example.co.uk']) expect(sessionDomainError(domain)).toBeUndefined();
  });

  it('keeps cookies a site\'s hosts receive and nothing else', () => {
    expect(cookieBelongs('app.example.com', ['example.com'])).toBe(true);
    expect(cookieBelongs('.example.com', ['app.example.com'])).toBe(true);
    expect(cookieBelongs('example.com', ['app.example.com'])).toBe(false);
    expect(cookieBelongs('.google.com', ['example.com'])).toBe(false);
    expect(cookieBelongs('accounts.google.com', ['example.com'])).toBe(false);
    expect(cookieBelongs('notexample.com', ['example.com'])).toBe(false);
  });

  it('refuses a malformed stored session', () => {
    for (const raw of ['nope', '{}', JSON.stringify({ version: 1, capturedAt: 1, cookies: [{ name: 'a' }], storage: [] }),
      JSON.stringify({ version: 1, capturedAt: 1, cookies: [], storage: [{ origin: 'x', localStorage: [[1, 2]] }] })])
      expect(() => parseSavedSession(raw)).toThrow();
  });
});
