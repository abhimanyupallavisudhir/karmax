import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceChangedPages, indexNowKey, indexNowKeyFile } from '../src/gateway/indexnow.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * After a deploy, search engines learn which public pages changed from the
 * installation itself (IndexNow), not from their next visit. Before this a new
 * page waited for a crawler to come by; Bing had crawled the site once in a week.
 */
describe('announcing changed public pages to search engines (IndexNow)', () => {
  let store: Store;
  beforeAll(async () => { store = await Store.create(':memory:'); });
  afterAll(async () => store.close());

  const origin = 'https://tavya.example';
  const recorder = (status = 200) => {
    const calls: Array<{ url: string; body: any }> = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status });
    }) as typeof fetch;
    return { calls, send };
  };

  it('submits every page the first time, with the key the installation serves', async () => {
    const { calls, send } = recorder();
    const entries = [{ path: '/' }, { path: '/docs', lastmod: '2026-11-07' }, { path: '/compare', lastmod: '2026-11-14' }];
    expect(await announceChangedPages({ store, origin, entries, fetch: send })).toEqual(['/', '/docs', '/compare']);
    const key = await indexNowKey(store);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(calls).toEqual([{ url: 'https://api.indexnow.org/indexnow', body: { host: 'tavya.example', key,
      keyLocation: `${origin}/${key}.txt`, urlList: [`${origin}/`, `${origin}/docs`, `${origin}/compare`] } }]);
    // The key never changes: engines have verified it.
    expect(await indexNowKey(store)).toBe(key);
  });

  it('then submits only what is new or changed since, and nothing when nothing is', async () => {
    const { calls, send } = recorder();
    const same = [{ path: '/' }, { path: '/docs', lastmod: '2026-11-07' }, { path: '/compare', lastmod: '2026-11-14' }];
    expect(await announceChangedPages({ store, origin, entries: same, fetch: send })).toEqual([]);
    expect(calls).toEqual([]);
    const next = [{ path: '/' }, { path: '/docs', lastmod: '2026-11-20' }, { path: '/compare', lastmod: '2026-11-14' }, { path: '/about', lastmod: '2026-11-20' }];
    expect(await announceChangedPages({ store, origin, entries: next, fetch: send })).toEqual(['/docs', '/about']);
    expect(calls[0]!.body.urlList).toEqual([`${origin}/docs`, `${origin}/about`]);
  });

  it('tries again next time when the engine refuses or cannot be reached', async () => {
    const entries = [{ path: '/' }, { path: '/docs', lastmod: '2026-11-20' }, { path: '/compare', lastmod: '2026-11-14' }, { path: '/about', lastmod: '2026-11-20' }, { path: '/changelog', lastmod: '2026-11-21' }];
    const refused = recorder(403);
    const logged: string[] = [];
    expect(await announceChangedPages({ store, origin, entries, fetch: refused.send, log: (message) => logged.push(message) })).toEqual([]);
    expect(logged).toEqual(['IndexNow refused 1 pages: HTTP 403']);
    const down = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    expect(await announceChangedPages({ store, origin, entries, fetch: down, log: (message) => logged.push(message) })).toEqual([]);
    expect(logged[1]).toBe('IndexNow unreachable: getaddrinfo ENOTFOUND');
    // 202: received, key still to be verified. That counts.
    const accepted = recorder(202);
    expect(await announceChangedPages({ store, origin, entries, fetch: accepted.send })).toEqual(['/changelog']);
    expect(await announceChangedPages({ store, origin, entries, fetch: accepted.send })).toEqual([]);
  });

  it('serves the key file, and only that one', async () => {
    const key = await indexNowKey(store);
    expect(await indexNowKeyFile(store, `/${key}.txt`)).toBe(key);
    expect(await indexNowKeyFile(store, `/${'0'.repeat(32)}.txt`)).toBeUndefined();
    expect(await indexNowKeyFile(store, '/robots.txt')).toBeUndefined();
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens: new TokenAuthority(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, api: {} as any, taskQueue: 'test', staticDir: web,
      agentInfo: { provider: 'mock', reason: 'indexnow test' }, worlds: new WorldRegistry(), githubApp: {} as any,
      identity: { session: async () => null, connectOrganizationNames: () => {} } as any, hosted: true,
    } as any);
    const { url, close } = await gateway.listen(await findFreePortFrom(48_800));
    try {
      const get = (pathname: string) => new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
        http.get(`${url}${pathname}`, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
        }).on('error', reject);
      });
      expect(await get(`/${key}.txt`)).toEqual({ status: 200, type: 'text/plain; charset=utf-8', body: key });
      // Any other name of that shape is the console, as before.
      expect((await get(`/${'0'.repeat(32)}.txt`)).body).toContain('<div id="app">');
    } finally {
      await close();
    }
  });
});
