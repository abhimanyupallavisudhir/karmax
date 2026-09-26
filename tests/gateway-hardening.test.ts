import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { stubGateway } from './helpers/stub-gateway.js';

it('sandboxes proxied HTML on the console origin, including public self-hosts (#16)', async () => {
  const h = await stubGateway({ hostLocal: false });
  try {
    vi.spyOn(h.store, 'getTask').mockResolvedValue({ projectId: 'p', lastView: {
      world: { id: 'w', kind: 'e2b', root: '/app', branch: 'task', base: 'main' },
    } } as any);
    vi.spyOn(h.store, 'effectiveProjectConfig').mockResolvedValue({} as any);
    const world = { fetchPort: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<script>fetch("/api/projects")</script>') }) };
    (h.gateway as any).deps.worlds.open = async () => world;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await (h.gateway as any).servePreview({ method: 'GET', headers: {} }, res, 't', 3000, '/', '/api/tasks/t/preview/3000');
    expect(res.writeHead.mock.calls[0]?.[1]['content-security-policy']).toMatch(/sandbox/);
    expect(res.writeHead.mock.calls[0]?.[1]['content-security-policy']).not.toMatch(/allow-same-origin/);
  } finally { await h.close(); }
});

it('rejects cross-site mutations and cross-site side-effecting navigations (GW-3)', async () => {
  const h = await stubGateway();
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await fetch(`${h.base}/api/settings/global/test-settings`, { method: 'PUT',
        headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' } as any, body: '{}' });
      expect(response.status).toBe(403);
    }
    for (const route of ['desktop', 'preview/3000']) {
      expect((await fetch(`${h.base}/api/tasks/task/` + route, {
        headers: { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' },
      })).status).toBe(403);
    }
    expect((await fetch(`${h.base}/api/tasks/task/desktop`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await fetch(`${h.base}/api/tasks/task/preview/3000`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await fetch(`${h.base}/api/settings/global/test-settings`, { method: 'PUT',
      headers: { authorization: `Bearer ${token}`, origin: h.base, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  } finally { await h.close(); }
});

it('blocks preview scripts from reading console credentials and changing settings in Chromium (#16)', async () => {
  const { chromium } = await import('playwright');
  const h = await stubGateway({ hostLocal: false });
  const browser = await chromium.launch({ headless: true });
  try {
    const handle = { id: 'w', kind: 'e2b', root: '/app', branch: 'task', base: 'main', generation: 1 };
    vi.spyOn(h.store, 'previewLease').mockResolvedValue({ id: 'lease', worldId: 'w', taskId: 't', projectId: 'p',
      organizationId: 'org_personal', generation: 1, port: 3000, expiresAt: Date.now() + 60_000 } as any);
    vi.spyOn(h.store, 'currentWorld').mockResolvedValue(handle as any);
    vi.spyOn(h.store, 'getTask').mockResolvedValue({ projectId: 'p', lastView: { world: handle } } as any);
    vi.spyOn(h.store, 'effectiveProjectConfig').mockResolvedValue({} as any);
    await h.store.setSettings('global', 'test-settings', { siteName: 'Protected' });
    (h.gateway as any).deps.worlds.open = async () => ({ fetchPort: async () => ({ status: 200,
      headers: { 'content-type': 'text/html' }, body: Buffer.from(`<script>
        window.probe = (async () => {
          let cookieBlocked = false, storageBlocked = false, readBlocked = false;
          try { document.cookie; } catch { cookieBlocked = true; }
          try { localStorage.getItem('token'); } catch { storageBlocked = true; }
          try { await (await fetch('/api/projects', { credentials: 'include' })).text(); } catch { readBlocked = true; }
          await fetch('/api/settings/global/test-settings', { method: 'PUT', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { siteName: 'Changed' } }) }).catch(() => {});
          return { cookieBlocked, storageBlocked, readBlocked };
        })();
      </script>`) }) });
    const context = await browser.newContext();
    expect((await context.request.get(`${h.base}/api/session`)).status()).toBe(200);
    expect((await context.request.get(`${h.base}/api/projects`)).status()).toBe(200);
    const page = await context.newPage();
    expect((await page.goto(`${h.base}/preview/lease/`))?.status()).toBe(200);
    expect(await page.evaluate(() => (globalThis as any).probe)).toEqual({
      cookieBlocked: true, storageBlocked: true, readBlocked: true,
    });
    expect(await h.store.getSettings('global', 'test-settings')).toEqual({ siteName: 'Protected' });
  } finally { await browser.close(); await h.close(); }
});
