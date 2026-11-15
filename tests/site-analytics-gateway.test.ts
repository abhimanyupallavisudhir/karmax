import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { SiteAnalytics } from '../src/platform/site-analytics.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';

/**
 * Web analytics of the public site through the gateway (wiki
 * features/site-analytics): a crawler's fetch of a public page is counted by
 * the gateway itself, a person's page view by the console's beacon — once
 * per visitor per day, only for a real public page, never for a bot — and
 * only an installation operator reads the counts.
 */
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('site analytics through the gateway', () => {
  let base: string;
  let close: () => Promise<void>;
  let store: Store;
  const tokens: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);
  const report = async (token = tokens.operator!) => {
    const response = await fetch(`${base}/api/settings/site-analytics?from=${today}&to=${today}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const beacon = (body: unknown, ua = CHROME, headers: Record<string, string> = {}) => fetch(`${base}/api/site-analytics/view`,
    { method: 'POST', headers: { 'user-agent': ua, 'content-type': 'text/plain;charset=UTF-8', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
  const fetchAs = (pathname: string, ua: string) => fetch(`${base}${pathname}`, { headers: { 'user-agent': ua }, redirect: 'manual' });

  beforeAll(async () => {
    store = await Store.create(':memory:');
    const authority = new TokenAuthority(store);
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens: authority, contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, api: {} as any, taskQueue: 'test', staticDir: web,
      agentInfo: { provider: 'mock', reason: 'site analytics test' }, worlds: new WorldRegistry(), githubApp: {} as any,
      identity: { session: async () => null, connectOrganizationNames: () => {}, listUsers: async () => [],
        userCreationTimes: async () => [Date.now()] } as any,
      hosted: true,
      // A small budget, so the limit is reached in a few requests.
      siteAnalytics: new SiteAnalytics(store, { rateLimit: { max: 30, windowMs: 60_000 } }),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_800));
    base = running.url;
    close = running.close;
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' });
    tokens.operator = (await authority.mintPrincipal('user:op', ['*'])).token;
    tokens.reader = (await authority.mintPrincipal('user:reader', ['settings:read'])).token;
    tokens.tenantOwner = (await authority.mintPrincipal('user:owner', ORGANIZATION_GRANT_CEILING, undefined, undefined, tenant.id)).token;
  }, 30_000);
  afterAll(async () => { await close?.(); await store?.close(); });

  it('counts what crawlers fetch of the public site, and nothing a person or the console fetches', async () => {
    for (const [pathname, ua] of [
      ['/', GPTBOT], ['/docs/how-it-works', GPTBOT], ['/docs/how-it-works.md', GPTBOT], ['/llms.txt', GPTBOT],
      ['/robots.txt', GOOGLEBOT], ['/sitemap.xml', GOOGLEBOT], ['/pricing', GOOGLEBOT],
      // A spelling that redirects, a public URL that names nothing, the console: not pages.
      ['/docs/', GOOGLEBOT], ['/docs/no-such-page', GOOGLEBOT], ['/acme/app', GOOGLEBOT],
      // People.
      ['/', CHROME], ['/docs', FIREFOX],
    ] as const) await (await fetchAs(pathname, ua)).arrayBuffer();
    const { crawlers } = await report();
    expect(crawlers).toEqual([
      { name: 'GPTBot', fetches: 4, pages: [
        { path: '/', fetches: 1 }, { path: '/docs/how-it-works', fetches: 1 }, { path: '/docs/how-it-works.md', fetches: 1 }, { path: '/llms.txt', fetches: 1 }] },
      { name: 'Googlebot', fetches: 3, pages: [{ path: '/pricing', fetches: 1 }, { path: '/robots.txt', fetches: 1 }, { path: '/sitemap.xml', fetches: 1 }] },
    ]);
    // Page loads are not page views: those come from the console's beacon.
    expect((await report()).totals.views).toBe(0);
  });

  it('counts a person\'s page views, and the person once a day, by where they came from', async () => {
    expect((await beacon({ path: '/', referrer: 'https://news.ycombinator.com/item?id=42' })).status).toBe(204);
    expect((await beacon({ path: '/docs', referrer: `${base}/` })).status).toBe(204);
    expect((await beacon({ path: '/pricing?utm_source=newsletter', referrer: `${base}/docs` })).status).toBe(204);
    expect((await beacon({ path: '/signup', referrer: `${base}/pricing` })).status).toBe(204);
    // Someone else, typing the address.
    expect((await beacon({ path: '/docs/how-it-works', referrer: '' }, FIREFOX)).status).toBe(204);
    const data = await report();
    expect(data.totals).toMatchObject({ visitors: 2, views: 5, signups: 1, crawls: 7 });
    expect(data.pages).toEqual(expect.arrayContaining([{ path: '/', views: 1, entries: 1 }, { path: '/docs', views: 1, entries: 0 },
      { path: '/pricing', views: 1, entries: 0 }, { path: '/signup', views: 1, entries: 0 }, { path: '/docs/how-it-works', views: 1, entries: 1 }]));
    expect(data.sources.hosts).toEqual([
      { source: '', group: 'direct', visitors: 1 }, { source: 'news.ycombinator.com', group: 'social', visitors: 1 }]);
    expect(data.funnel.map((step: { count: number }) => step.count)).toEqual([2, 1, 1, 0, 0]);
  });

  it('refuses what is not a view of a public page, and ignores bots', async () => {
    const statuses = async (bodies: unknown[]) => Promise.all(bodies.map(async (body) => (await beacon(body)).status));
    expect(await statuses([
      { path: '/acme/app', referrer: '' }, { path: '/docs/no-such-page', referrer: '' }, { path: '/invite?token=x', referrer: '' },
      { path: 'https://evil.example/', referrer: '' }, { path: 42 }, {}, 'not json',
    ])).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect((await beacon({ path: '/', referrer: 'x'.repeat(3000) })).status).toBe(413);
    expect((await beacon({ path: '/', referrer: '' }, CHROME, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await beacon({ path: '/', referrer: '' }, GOOGLEBOT)).status).toBe(204);
    expect((await beacon({ path: '/', referrer: '' }, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36')).status).toBe(204);
    expect((await report()).totals).toMatchObject({ visitors: 2, views: 5 });
  });

  it('limits beacons from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await beacon({ path: '/', referrer: '' })).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((status) => status === 204).length).toBeLessThan(30);
  });

  it('is read by installation operators only, and listed for agents', async () => {
    expect(routeCapability('GET', '/api/settings/site-analytics')).toBe('settings:read');
    expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith('GET /api/settings/site-analytics'))).toBe(true);
    expect((await report(tokens.reader!)).totals.visitors).toBe(2);
    const as = (token?: string, query = `from=${today}&to=${today}`) => fetch(`${base}/api/settings/site-analytics?${query}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await as(tokens.tenantOwner)).status).toBe(403);
    expect((await as()).status).toBe(401);
    expect((await as(tokens.operator, 'from=yesterday&to=today')).status).toBe(400);
    expect((await as(tokens.operator, 'from=2025-01-01&to=2026-12-31')).status).toBe(400); // over a year at once
  });
});
