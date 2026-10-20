import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { chromium, type Browser } from 'playwright';
import { hashPreviewToken, newPreviewToken, previewLeaseUrl } from '../src/gateway/previews.js';
import { stubGateway } from './helpers/stub-gateway.js';

// indike-org #12 (2026-10-20): a site whose pages link `/assets/style.css`,
// as most sites do, opened from Review "Preview locally" without any CSS. The
// page was proxied under /preview/<lease>/ on the lease's own host, so the
// browser asked the host's root for the stylesheet, which served nothing. A
// lease has a host of its own: the application belongs at its root.
const PAGE = '<!doctype html><link rel="stylesheet" href="/assets/style.css"><script src="/diet/app.js" defer></script><h1>Diet</h1>';
const FILES: Record<string, { type: string; body: string }> = {
  '/diet/': { type: 'text/html', body: PAGE },
  '/assets/style.css': { type: 'text/css', body: 'body { background: rgb(1, 2, 3); }' },
  // A dev server's live-reload socket, at a root path like Vite's or Next's.
  '/diet/app.js': { type: 'text/javascript', body: `document.body.dataset.ran = "yes";
    const socket = new WebSocket(\`ws://\${location.host}/_hmr\`);
    socket.onmessage = (event) => { document.body.dataset.socket = event.data; };` },
};

let h: Awaited<ReturnType<typeof stubGateway>>;
let browser: Browser;
let origin = '';
let token = '';
let lease: { id: string; hostname?: string };
let upstream: WebSocketServer;
const requested: string[] = [];
const socketPaths: string[] = [];
const saved = process.env.KARMAX_PREVIEW_ORIGIN;

beforeAll(async () => {
  h = await stubGateway({ hostLocal: false } as any);
  origin = `http://usercontent.test:${new URL(h.base).port}`;
  process.env.KARMAX_PREVIEW_ORIGIN = origin;
  const handle = { id: 'w', kind: 'e2b', root: '/app', branch: 'task', base: 'main', generation: 1 };
  vi.spyOn(h.store, 'currentWorld').mockResolvedValue(handle as any);
  vi.spyOn(h.store, 'getTask').mockResolvedValue({ projectId: 'p', lastView: { world: handle } } as any);
  vi.spyOn(h.store, 'effectiveProjectConfig').mockResolvedValue({} as any);
  upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  upstream.on('connection', (socket, req) => { socketPaths.push(req.url ?? ''); socket.send('live'); });
  await new Promise((resolve) => upstream.once('listening', resolve));
  (h.gateway as any).deps.worlds.open = async () => ({ fetchPort: async (_port: number, path: string) => {
    requested.push(path);
    const file = FILES[path];
    return file ? { status: 200, headers: { 'content-type': file.type }, body: Buffer.from(file.body) }
      : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
  }, previewSocketTarget: async (_port: number, path: string) =>
    ({ url: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}${path}` }) });
  token = newPreviewToken();
  lease = await h.store.createPreviewLease({ id: 'preview_diet', organizationId: 'org_personal', projectId: 'p', taskId: 't',
    worldId: 'w', generation: 1, port: 8765, public: false, tokenHash: hashPreviewToken(token), provider: 'e2b',
    createdBy: 'system:review-action', createdAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 });
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.usercontent.test 127.0.0.1'] });
});

afterAll(async () => {
  await browser?.close();
  upstream?.close();
  await h?.close();
  if (saved === undefined) delete process.env.KARMAX_PREVIEW_ORIGIN; else process.env.KARMAX_PREVIEW_ORIGIN = saved;
});

/** One request to the gateway with an explicit Host, as Caddy forwards it. */
const status = (path: string, host: string) => new Promise<number>((resolve, reject) => {
  const target = new URL(h.base);
  http.get({ host: target.hostname, port: target.port, path, headers: { host } }, (response) => {
    response.resume(); resolve(response.statusCode ?? 0);
  }).on('error', reject);
});

/** Open a link in a fresh browser; what the page then looks like. */
async function open(link: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const response = await page.goto(link);
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.body.dataset.socket, undefined, { timeout: 5_000 }).catch(() => {});
    return { status: response?.status(), url: page.url(),
      background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      ran: await page.evaluate(() => document.body.dataset.ran ?? ''),
      socket: await page.evaluate(() => document.body.dataset.socket ?? '') };
  } finally { await context.close(); }
}

it('serves a preview at its own host\'s root, so root-relative stylesheets and scripts load', async () => {
  const link = previewLeaseUrl(lease, '/diet/', token);
  expect(link).toBe(`http://${lease.hostname}:${new URL(origin).port}/diet/?token=${encodeURIComponent(token)}`);
  requested.length = 0;
  const shown = await open(link);
  // The token became a cookie and left the address bar.
  expect(shown).toEqual({ status: 200, url: `http://${lease.hostname}:${new URL(origin).port}/diet/`, background: 'rgb(1, 2, 3)',
    ran: 'yes', socket: 'live' });
  expect(requested).toEqual(expect.arrayContaining(['/diet/', '/assets/style.css', '/diet/app.js']));
  expect(socketPaths).toContain('/_hmr');
});

it('moves a link issued under /preview/<lease>/ to the root of the lease\'s host', async () => {
  const shown = await open(`http://${lease.hostname}:${new URL(origin).port}/preview/${lease.id}/diet/?token=${encodeURIComponent(token)}`);
  expect(shown).toMatchObject({ status: 200, url: `http://${lease.hostname}:${new URL(origin).port}/diet/`, background: 'rgb(1, 2, 3)' });
});

it('still asks for the lease\'s token on every path of its host', async () => {
  const port = new URL(origin).port;
  expect(await status('/assets/style.css', `${lease.hostname}:${port}`)).toBe(401);
  // Another preview host, or the bare preview domain, has no application.
  expect(await status('/diet/', `p-000000000000000000000000.usercontent.test:${port}`)).toBe(404);
  expect(await status('/api/session', `usercontent.test:${port}`)).toBe(404);
});

it('sends a console link to the root of the lease\'s host', async () => {
  const response = await fetch(`${h.base}/preview/${lease.id}/diet/?x=1`, { redirect: 'manual' });
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe(`http://${lease.hostname}:${new URL(origin).port}/diet/?x=1`);
});
