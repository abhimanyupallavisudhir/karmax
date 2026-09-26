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
