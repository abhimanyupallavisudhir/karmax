import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { Gateway } from '../src/gateway/server.js';
import { SiteAnalytics } from '../src/platform/site-analytics.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

/**
 * Web analytics of the public site end to end (wiki features/site-analytics):
 * a real browser opens the landing from Hacker News, moves to /docs and
 * /pricing in place, opens sign-up, and those four views — one visitor, from
 * news.ycombinator.com, who opened sign-up — are what the API reports and
 * what Installation → Site traffic shows. A signed-out console URL counts
 * nothing. SITE_TRAFFIC_SCREENSHOTS=<dir> also saves the view with seeded
 * data, light, dark and phone.
 */
const require = createRequire(import.meta.url);
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('site analytics in a real browser', () => {
  let base: string;
  let close: () => Promise<void>;
  let store: Store;
  let operator: string;
  let browser: Browser;
  const today = new Date().toISOString().slice(0, 10);
  const report = async () => (await (await fetch(`${base}/api/settings/site-analytics?from=${today}&to=${today}`,
    { headers: { authorization: `Bearer ${operator}` } })).json()) as any;

  beforeAll(async () => {
    store = await Store.create(':memory:');
    const tokens = new TokenAuthority(store);
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(),
      client: {} as any, api: {} as any, taskQueue: 'test', staticDir: web,
      agentInfo: { provider: 'mock', reason: 'site analytics browser test' }, worlds: new WorldRegistry(), githubApp: {} as any,
      identity: { session: async () => null, connectOrganizationNames: () => {}, listUsers: async () => [],
        googleEnabled: false, githubEnabled: false, hasUsers: async () => true, canSendEmail: async () => false } as any,
      hosted: true,
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_850));
    base = running.url;
    close = running.close;
    operator = (await tokens.mintPrincipal('user:op', ['*'])).token;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await closeConsoleBrowser();
    await close?.();
    await store?.close();
  });

  it('counts the landing, /docs and /pricing in place, and sign-up — once each, for one visitor from Hacker News', async () => {
    // A person's browser: headless Chromium says so in its User-Agent, and is not counted.
    const context = await browser.newContext({ userAgent: CHROME, serviceWorkers: 'block' });
    const page = await context.newPage();
    const beacons: string[] = [];
    page.on('request', (request) => { if (request.url().endsWith('/api/site-analytics/view')) beacons.push(request.postData() ?? ''); });
    await page.goto(`${base}/`, { referer: 'https://news.ycombinator.com/item?id=4242' });
    await page.locator('.landing-footer').waitFor();
    // In place, as the landing's own `data-public` links do.
    await page.evaluate(`(() => {
      const link = Object.assign(document.createElement('a'), { href: '/docs', textContent: 'Docs' });
      link.dataset.public = '';
      document.body.append(link);
      link.click();
    })()`);
    await page.locator('.docs-nav').waitFor();
    expect(page.url()).toBe(`${base}/docs`);
    await page.locator('.docs-nav a[href="/pricing"]').click();
    await page.waitForURL(`${base}/pricing`);
    await page.locator('.docs-nav a[href="/pricing"][aria-current="page"]').waitFor();
    await page.goto(`${base}/signup`);
    await page.locator('form').first().waitFor();
    // A console URL, signed out, shows the landing but is no public page.
    await page.goto(`${base}/acme/app`);
    await page.locator('.landing-footer').waitFor();
    await expect.poll(async () => (await report()).totals.views, { timeout: 10_000 }).toBe(4);
    await page.waitForTimeout(300);
    expect(beacons.map((body) => JSON.parse(body).path)).toEqual(['/', '/docs', '/pricing', '/signup']);

    const data = await report();
    expect(data.totals).toMatchObject({ visitors: 1, views: 4, signups: 1 });
    expect(data.pages.map((entry: any) => [entry.path, entry.views])).toEqual([['/', 1], ['/docs', 1], ['/pricing', 1], ['/signup', 1]]);
    expect(data.sources.hosts).toEqual([{ source: 'news.ycombinator.com', group: 'social', visitors: 1 }]);
    // Nothing on the device that tells this browser apart: no cookie, and in
    // storage only the console's own cache of the site's look.
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate('[Object.keys(localStorage).sort(), sessionStorage.length]'))
      .toEqual([['karmax-skin', 'karmax-task-list'], 0]);
    await context.close();

    // Installation → Site traffic, from the same API.
    const ui = await consolePage({ api: async ({ method, path: route }) => {
      if (method === 'GET' && route.startsWith('/api/settings/site-analytics'))
        return (await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${operator}` } })).json();
      return undefined;
    } });
    await ui.run(`S.meta = { hosted: true, siteName: 'tavya' }; S.tab = 'installation';
      document.getElementById('main').innerHTML = installationView(); wireSiteTrafficCard(7);`);
    const card = ui.page.locator('#site-traffic-card');
    await card.locator('.traffic-stat[data-stat="visitors"] b').waitFor();
    const stat = (key: string) => card.locator(`.traffic-stat[data-stat="${key}"] b`).textContent();
    expect([await stat('visitors'), await stat('views'), await stat('signups')]).toEqual(['1', '4', '1']);
    expect(await ui.page.locator('.settings-nav a[href="#installation-traffic"]').textContent()).toBe('Site traffic');
    const pages = await card.locator('.traffic-part').nth(1).locator('tbody tr .traffic-label').allTextContents();
    expect(pages).toEqual(['/', '/docs', '/pricing', '/signup']);
    const sources = await card.locator('.traffic-part').first().locator('tbody tr .traffic-label').allTextContents();
    expect(sources).toEqual(['Social', 'news.ycombinator.com']);
    expect(await card.locator('.ins-plot svg[aria-label="Visitors per day, last 7 days"]').count()).toBe(1);
    // Hovering a day tells its numbers.
    const box = (await card.locator('.ins-plot svg').boundingBox())!;
    await ui.page.mouse.move(box.x + box.width - 10, box.y + 80);
    await expect.poll(() => card.locator('.ins-tip').textContent()).toContain('Page views4');
    expect(ui.errors).toEqual([]);
    await ui.close();
  }, 60_000);

  it('says so when nothing is counted, and switches the period', async () => {
    const asked: string[] = [];
    const empty = (from: string, to: string) => ({ from, to, totals: { visitors: 0, views: 0, signups: 0, accounts: 0, crawls: 0 },
      daily: [], pages: [], sources: { groups: [], hosts: [] }, crawlers: [], funnel: [] });
    const ui = await consolePage({ api: ({ method, path: route }) => {
      if (method !== 'GET' || !route.startsWith('/api/settings/site-analytics')) return undefined;
      asked.push(route);
      const query = new URL(route, 'http://x').searchParams;
      return empty(query.get('from')!, query.get('to')!);
    } });
    await ui.run(`document.getElementById('main').innerHTML = '<div class="card site-traffic" id="site-traffic-card"></div>'; wireSiteTrafficCard(30);`);
    await expect.poll(() => ui.page.locator('#site-traffic-card .queue-empty').textContent()).toBe('Nothing counted in the last 30 days');
    await ui.page.getByRole('radio', { name: '90d' }).click();
    await expect.poll(() => ui.page.locator('#site-traffic-card .queue-empty').textContent()).toBe('Nothing counted in the last 90 days');
    const span = (route: string) => {
      const query = new URL(route, 'http://x').searchParams;
      return Math.round((Date.parse(query.get('to')!) - Date.parse(query.get('from')!)) / 86_400_000) + 1;
    };
    expect(asked.map(span)).toEqual([30, 90]);
    await ui.close();
  }, 30_000);

  it('draws seeded traffic on a computer and a phone, light and dark', async () => {
    const seeded = await Store.create(':memory:');
    const now = Date.now();
    const DAY = 86_400_000;
    const sources = ['news.ycombinator.com', 'google.com', 'chatgpt.com', '', 'reddit.com', 'x.com', 'perplexity.ai', 'bing.com', 'claude.ai', 'github.com', 'newsletter'];
    const paths = ['/', '/docs', '/pricing', '/docs/how-it-works', '/compare', '/docs/claude-code-in-the-cloud', '/about', '/legal/privacy'];
    const crawlers: Array<[string, string, number]> = [['Googlebot', '/', 3], ['GPTBot', '/llms.txt', 2], ['ClaudeBot', '/docs', 2], ['Bingbot', '/sitemap.xml', 1],
      ['OAI-SearchBot', '/pricing', 1], ['PerplexityBot', '/docs/how-it-works.md', 1], ['Claude-User', '/compare', 1], ['Other bots', '/robots.txt', 4]];
    for (let d = 29; d >= 0; d--) {
      const at = { now: now - d * DAY };
      const analytics = new SiteAnalytics(seeded, { now: () => at.now });
      // A launch on day 22: a front page, then a long tail.
      const people = Math.round(18 + 9 * Math.sin(d) + (d === 7 ? 420 : d === 6 ? 190 : d < 7 ? 70 - d * 6 : 0));
      for (let i = 0; i < people; i++) {
        const ip = `10.${d}.${i >> 8}.${i & 255}`;
        const source = d === 7 && i % 3 ? 'news.ycombinator.com' : sources[(i * 7 + d) % sources.length]!;
        analytics.view({ path: paths[i % 3 ? 0 : (i >> 2) % paths.length]!, source, ip, userAgent: CHROME });
        if (i % 2) analytics.view({ path: paths[(i + d) % paths.length]!, source: null, ip, userAgent: CHROME });
        if (i % 9 === 0) analytics.view({ path: '/signup', source: null, ip, userAgent: CHROME });
      }
      for (const [name, crawled, n] of crawlers) for (let i = 0; i < n + (d % 3); i++) analytics.crawl(name, crawled);
      await analytics.flush();
    }
    const { siteAnalyticsReport } = await import('../src/platform/site-analytics.js');
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const accounts = Array.from({ length: 41 }, (_, i) => now - (i % 9) * DAY);
    const data = await siteAnalyticsReport(seeded, { from: day(now - 29 * DAY), to: day(now), accountsCreated: async () => accounts });
    await seeded.close();
    const funnel = data.funnel.map((step) => (step.step === 'firstTasks' ? { ...step, count: 23 } : step.step === 'firstConfirmed' ? { ...step, count: 11 } : step));
    const reply = { ...data, funnel };
    const dir = process.env.SITE_TRAFFIC_SCREENSHOTS;
    for (const [name, viewport, theme] of [['light', { width: 1280, height: 2600 }, 'light'], ['dark', { width: 1280, height: 2600 }, 'dark'],
      ['phone', { width: 390, height: 4200 }, 'light']] as const) {
      const ui = await consolePage({ viewport, api: ({ method, path: route }) =>
        method === 'GET' && route.startsWith('/api/settings/site-analytics') ? reply : undefined });
      await ui.run(`document.documentElement.setAttribute('data-theme', '${theme}'); S.meta = { hosted: true, siteName: 'tavya' }; S.tab = 'installation';
        document.getElementById('main').innerHTML = '<div class="main-inner">' + installationView() + '</div>'; wireSiteTrafficCard(30);`);
      const section = ui.page.locator('#site-traffic-card');
      await section.locator('.ins-plot svg').waitFor();
      // Nothing spills out of the card at this width.
      const overflow = await section.evaluate((card) => [...card.querySelectorAll('*')].filter((el) =>
        el.getBoundingClientRect().right > card.getBoundingClientRect().right + 1 && !el.closest('.ins-tip')).length);
      expect(overflow).toBe(0);
      expect(await section.locator('.traffic-stat[data-stat="visitors"] b').textContent()).toBe(data.totals.visitors.toLocaleString('en-US'));
      // The accessibility gate's checks (tests/accessibility-check.cjs), on this section.
      await ui.page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const violations = await ui.run<Array<{ id: string; nodes: unknown[] }>>(`axe.run({ include: [['#installation-traffic'], ['#site-traffic-card']] },
        { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }).then((result) => result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))`);
      expect(violations, `${name}: ${JSON.stringify(violations)}`).toEqual([]);
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        // The section title and its card, in page coordinates.
        const clip = await ui.run<{ x: number; y: number; width: number; height: number }>(`(() => {
          const title = document.getElementById('installation-traffic').getBoundingClientRect();
          const card = document.getElementById('site-traffic-card').getBoundingClientRect();
          const x = Math.max(0, card.left - 16);
          return { x, y: title.top + scrollY - 16, width: Math.min(innerWidth - x, card.width + 32), height: card.bottom - title.top + 32 };
        })()`);
        await ui.page.screenshot({ path: path.join(dir, `site-traffic-${name}.png`), fullPage: true, clip });
      }
      expect(ui.errors).toEqual([]);
      await ui.close();
    }
  }, 120_000);
});
