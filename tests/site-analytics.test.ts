import { describe, expect, it } from 'vitest';
import { crawlerOf, humanBrowser, sourceGroup, beaconSource, utcDay } from '../src/domain/site-analytics.js';
import { SiteAnalytics, siteAnalyticsReport } from '../src/platform/site-analytics.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * First-party, cookieless web analytics of the public pages (wiki
 * features/site-analytics): which crawler a User-Agent is, where a visit came
 * from, unique visitors per UTC day from a daily salt that is thrown away,
 * batched writes, and the operator's report.
 */

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const CUBOT = 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('crawlerOf: which crawler a User-Agent names', () => {
  const table: Array<[string, string | undefined]> = [
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
    ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
    ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)', 'Googlebot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36', 'Bingbot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'GPTBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', 'OAI-SearchBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT-User'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)', 'Claude-SearchBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'Claude-User'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'PerplexityBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'Perplexity-User'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'Applebot'],
    ['DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', 'DuckDuckBot'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-externalagent'],
    ['Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)', 'Bytespider'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36', 'Amazonbot'],
    ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'YandexBot'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Link previews'],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Link previews'],
    ['Twitterbot/1.0', 'Link previews'],
    ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'Other bots'],
    ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'Other bots'],
    ['some-crawler/0.1', 'Other bots'],
    ['Screaming Frog SEO Spider/20.0', 'Other bots'],
    [CHROME, undefined],
    [FIREFOX, undefined],
    [SAFARI_IPHONE, undefined],
    // A phone maker's name is not a bot.
    [CUBOT, undefined],
    ['', undefined],
  ];
  it.each(table)('%s → %s', (ua, name) => expect(crawlerOf(ua)).toBe(name));
});

describe('humanBrowser: whose beacon counts', () => {
  const table: Array<[string, boolean]> = [
    [CHROME, true], [FIREFOX, true], [SAFARI_IPHONE, true], [CUBOT, true],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', false],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', false],
    ['Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse', false],
    ['Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1', false],
    ['curl/8.5.0', false], ['python-requests/2.32.3', false], ['node', false], ['', false],
  ];
  it.each(table)('%s → %s', (ua, human) => expect(humanBrowser(ua)).toBe(human));
});

describe('sourceGroup: where a visit came from', () => {
  const table: Array<[string, string]> = [
    ['google.com', 'search'], ['google.co.uk', 'search'], ['google.de', 'search'], ['bing.com', 'search'], ['duckduckgo.com', 'search'],
    ['search.brave.com', 'search'], ['yandex.ru', 'search'], ['ecosia.org', 'search'], ['kagi.com', 'search'],
    ['chatgpt.com', 'ai'], ['chat.openai.com', 'ai'], ['perplexity.ai', 'ai'], ['claude.ai', 'ai'], ['gemini.google.com', 'ai'],
    ['copilot.microsoft.com', 'ai'],
    ['news.ycombinator.com', 'social'], ['reddit.com', 'social'], ['old.reddit.com', 'social'], ['x.com', 'social'], ['t.co', 'social'],
    ['linkedin.com', 'social'], ['lnkd.in', 'social'], ['youtube.com', 'social'], ['producthunt.com', 'social'], ['github.com', 'social'],
    ['bsky.app', 'social'], ['lobste.rs', 'social'],
    // Campaign tags people write by hand.
    ['hn', 'social'], ['hackernews', 'social'], ['twitter', 'social'], ['producthunt', 'social'], ['chatgpt', 'ai'],
    ['', 'direct'], ['example.org', 'other'], ['newsletter', 'other'],
    // A look-alike is not the real one.
    ['notgoogle.com', 'other'], ['google.evil.example', 'other'],
  ];
  it.each(table)('%s → %s', (source, group) => expect(sourceGroup(source)).toBe(group));
});

describe('beaconSource: the referrer reduced to a host, or a campaign tag', () => {
  const own = 'tavya.io';
  const table: Array<[string, string, string | null]> = [
    ['/?utm_source=HackerNews&utm_medium=x', 'https://news.ycombinator.com/item?id=1', 'hackernews'],
    ['/pricing?ref=producthunt', '', 'producthunt'],
    ['/?utm_source=chatgpt.com', '', 'chatgpt.com'],
    // Short and sanitised: nothing but a tag survives.
    ['/?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E', '', 'scriptalert1script'],
    [`/?utm_source=${'a'.repeat(200)}`, '', 'a'.repeat(40)],
    ['/', 'https://www.google.com/', 'google.com'],
    ['/docs', 'https://news.ycombinator.com/item?id=4242', 'news.ycombinator.com'],
    ['/', 'android-app://com.google.android.gm/', 'com.google.android.gm'],
    ['/', '', ''],
    ['/', 'not a url', ''],
    // Our own pages (in-place navigation, a link from the landing) are no source.
    ['/docs', 'https://tavya.io/', null],
    ['/docs', 'https://www.tavya.io/pricing', null],
  ];
  it.each(table)('%s from %s → %s', (path, referrer, source) => expect(beaconSource(path, referrer, own)).toBe(source));
});

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-14T23:59:58Z');

function memoryStore() {
  const salts = new Map<string, string>();
  const visitors = new Set<string>();
  const counts = new Map<string, number>();
  const writes: string[] = [];
  return {
    salts, visitors, counts, writes,
    async siteAnalyticsSalt(day: string, candidate: string) {
      writes.push('salt');
      if (!salts.has(day)) salts.set(day, candidate);
      return salts.get(day)!;
    },
    async recordSiteAnalytics(batch: { counts: Array<{ day: string; kind: string; path: string; source: string; n: number }>;
      visitors: Array<{ day: string; mark: string; hash: string; path: string; source: string }> }) {
      writes.push('record');
      for (const v of batch.visitors) {
        const key = `${v.day}|${v.mark}|${v.hash}`;
        if (visitors.has(key)) continue;
        visitors.add(key);
        const k = `${v.day}|${v.mark === 'signup' ? 'signup' : 'visitor'}|${v.path}|${v.source}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      for (const c of batch.counts) {
        const k = `${c.day}|${c.kind}|${c.path}|${c.source}`;
        counts.set(k, (counts.get(k) ?? 0) + c.n);
      }
    },
    async pruneSiteVisitors(beforeDay: string) {
      for (const day of salts.keys()) if (day < beforeDay) salts.delete(day);
      for (const key of visitors) if (key.split('|')[0]! < beforeDay) visitors.delete(key);
    },
  };
}

describe('SiteAnalytics: counting without a cookie', () => {
  it('counts a visitor once per UTC day, and as a new visitor after midnight with a new salt', async () => {
    let now = T0;
    const store = memoryStore();
    const analytics = new SiteAnalytics(store, { now: () => now });
    const view = (path: string, source: string | null, ip = '203.0.113.7', ua = CHROME) => analytics.view({ path, source, ip, userAgent: ua });
    expect(view('/', 'news.ycombinator.com')).toBe('counted');
    expect(view('/docs', null)).toBe('counted');
    expect(view('/', '', '198.51.100.9', FIREFOX)).toBe('counted');
    await analytics.flush();
    expect(store.counts.get('2026-11-14|visitor|/|news.ycombinator.com')).toBe(1);
    expect(store.counts.get('2026-11-14|visitor|/|')).toBe(1);
    expect(store.counts.get('2026-11-14|view|/|')).toBe(2);
    expect(store.counts.get('2026-11-14|view|/docs|')).toBe(1);
    // The same person a second later, then after midnight.
    view('/pricing', null);
    now = T0 + 5_000;
    view('/pricing', null);
    await analytics.flush();
    expect(store.counts.get('2026-11-14|visitor|/|news.ycombinator.com')).toBe(1);
    expect(store.counts.get('2026-11-15|visitor|/pricing|')).toBe(1);
    // Each day has its own salt, so the two days' hashes of the same person differ.
    expect(store.salts.get('2026-11-14')).not.toBe(store.salts.get('2026-11-15'));
    const hashes = [...store.visitors].map((key) => key.split('|')[2]);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Nothing kept names the address or the browser.
    expect(JSON.stringify([...store.visitors, ...store.counts.keys()])).not.toMatch(/203\.0\.113|Chrome/);
  });

  it('counts a person who opens sign-up once a day, apart from their page views', async () => {
    const store = memoryStore();
    const analytics = new SiteAnalytics(store, { now: () => T0 - 3_600_000 });
    analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: CHROME });
    analytics.view({ path: '/signup', source: null, ip: '203.0.113.7', userAgent: CHROME });
    analytics.view({ path: '/login', source: null, ip: '203.0.113.7', userAgent: CHROME });
    await analytics.flush();
    expect(store.counts.get('2026-11-14|signup|/signup|')).toBe(1);
    expect(store.counts.get('2026-11-14|view|/login|')).toBe(1);
    expect(store.counts.get('2026-11-14|visitor|/|')).toBe(1);
  });

  it('throws a day\'s salt and visitor hashes away within 48 hours', async () => {
    let now = T0;
    const store = memoryStore();
    const analytics = new SiteAnalytics(store, { now: () => now });
    analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: CHROME });
    await analytics.flush();
    expect(store.salts.has('2026-11-14')).toBe(true);
    now = T0 + DAY + 5_000; // 2026-11-16, ~24 h after 11-14 ended
    analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: CHROME });
    await analytics.flush();
    expect([...store.salts.keys()]).toEqual(['2026-11-16']);
    expect([...store.visitors].every((key) => key.startsWith('2026-11-16|'))).toBe(true);
    // The counts stay.
    expect(store.counts.get('2026-11-14|visitor|/|')).toBe(1);
  });

  it('limits beacons per address', () => {
    const analytics = new SiteAnalytics(memoryStore(), { now: () => T0, rateLimit: { max: 3, windowMs: 60_000 } });
    expect(Array.from({ length: 5 }, () => analytics.admit('203.0.113.7'))).toEqual([true, true, true, false, false]);
    expect(analytics.admit('198.51.100.9')).toBe(true);
  });

  it('does not count a bot or a headless browser', async () => {
    const store = memoryStore();
    const analytics = new SiteAnalytics(store, { now: () => T0 });
    expect(analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toBe('ignored');
    expect(analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 HeadlessChrome/141.0.0.0' })).toBe('ignored');
    await analytics.flush();
    expect(store.counts.size).toBe(0);
  });

  it('turns a burst into one write per flush, and flushes what is left when it stops', async () => {
    const store = memoryStore();
    const analytics = new SiteAnalytics(store, { now: () => T0 - 3_600_000, flushEveryMs: 60_000 });
    analytics.start();
    // A front page: 50 requests a second for 5 seconds, from 200 people.
    for (let i = 0; i < 250; i++) {
      analytics.view({ path: i % 2 ? '/' : '/docs', source: 'news.ycombinator.com', ip: `203.0.113.${i % 200}`, userAgent: CHROME });
      analytics.crawl('GPTBot', '/llms.txt');
    }
    expect(store.writes).toEqual([]);
    await analytics.stop();
    expect(store.writes.filter((write) => write === 'record')).toHaveLength(1);
    expect(store.counts.get('2026-11-14|view|/|')).toBe(125);
    expect(store.counts.get('2026-11-14|view|/docs|')).toBe(125);
    expect(store.counts.get('2026-11-14|crawl|/llms.txt|GPTBot')).toBe(250);
    const visitors = [...store.counts].filter(([key]) => key.includes('|visitor|')).reduce((sum, [, n]) => sum + n, 0);
    expect(visitors).toBe(200);
  });

  it('keeps a batch whose write failed for the next flush', async () => {
    const store = memoryStore();
    let fail = true;
    const record = store.recordSiteAnalytics.bind(store);
    store.recordSiteAnalytics = async (batch) => { if (fail) throw new Error('database down'); return record(batch); };
    const analytics = new SiteAnalytics(store, { now: () => T0 - 3_600_000 });
    analytics.view({ path: '/', source: '', ip: '203.0.113.7', userAgent: CHROME });
    analytics.crawl('ClaudeBot', '/');
    await analytics.flush();
    fail = false;
    await analytics.flush();
    expect(store.counts.get('2026-11-14|view|/|')).toBe(1);
    expect(store.counts.get('2026-11-14|crawl|/|ClaudeBot')).toBe(1);
    expect(store.counts.get('2026-11-14|visitor|/|')).toBe(1);
  });

  it('names the UTC day', () => expect(utcDay(T0)).toBe('2026-11-14'));
});

describe.each(storeBackends)('site analytics in the store ($name)', ({ open }) => {
  it('adds counts atomically from several gateway processes and counts each visitor once', async () => {
    const store = await open();
    const now = () => Date.parse('2026-11-14T12:00:00Z');
    // Two gateway processes over one database.
    const a = new SiteAnalytics(store, { now });
    const b = new SiteAnalytics(store, { now });
    for (const analytics of [a, b]) {
      analytics.view({ path: '/', source: 'news.ycombinator.com', ip: '203.0.113.7', userAgent: CHROME });
      analytics.view({ path: '/signup', source: null, ip: '203.0.113.7', userAgent: CHROME });
      analytics.view({ path: '/docs', source: 'chatgpt.com', ip: '198.51.100.9', userAgent: FIREFOX });
      analytics.crawl('Googlebot', '/');
    }
    await Promise.all([a.flush(), b.flush()]);
    const rows = await store.siteAnalyticsRows('2026-11-14', '2026-11-14');
    const n = (kind: string, path: string, source = '') => rows.find((row) => row.kind === kind && row.path === path && row.source === source)?.count;
    expect(n('view', '/')).toBe(2);
    expect(n('view', '/signup')).toBe(2);
    expect(n('crawl', '/', 'Googlebot')).toBe(2);
    expect(n('visitor', '/', 'news.ycombinator.com')).toBe(1);
    expect(n('visitor', '/docs', 'chatgpt.com')).toBe(1);
    expect(n('signup', '/signup')).toBe(1);
    // Both processes hashed with the one salt of the day.
    expect(await store.siteAnalyticsSalt('2026-11-14', 'other')).not.toBe('other');
    await store.pruneSiteVisitors('2026-11-15');
    expect(await store.siteAnalyticsSalt('2026-11-14', 'fresh')).toBe('fresh');
  });

  it('reports totals, a daily series, pages, sources, crawlers and the funnel', async () => {
    const store = await open();
    const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
    const at = { now: day('2026-11-13') };
    const analytics = new SiteAnalytics(store, { now: () => at.now });
    for (let i = 0; i < 4; i++) analytics.view({ path: '/', source: i < 3 ? 'news.ycombinator.com' : 'google.com', ip: `203.0.113.${i}`, userAgent: CHROME });
    analytics.view({ path: '/signup', source: null, ip: '203.0.113.0', userAgent: CHROME });
    analytics.crawl('GPTBot', '/llms.txt');
    analytics.crawl('Googlebot', '/');
    analytics.crawl('Googlebot', '/docs');
    await analytics.flush();
    at.now = day('2026-11-14');
    analytics.view({ path: '/pricing', source: 'chatgpt.com', ip: '203.0.113.0', userAgent: CHROME });
    await analytics.flush();
    // Two accounts on the 13th; an organization that started its first task
    // on the 13th and had it confirmed on the 14th; an older one that does not count.
    const fresh = await store.createOrganization({ name: 'Fresh', ownerUserId: 'u1' });
    const project = await store.createProject('fresh-app', {}, fresh.id);
    const task = await store.createTask({ projectId: project.id, title: 'First', workflow: 'software-dev', workflowVersion: '1', params: { prompt: 'x' } });
    const old = await store.createProject('old-app');
    const oldTask = await store.createTask({ projectId: old.id, title: 'Old', workflow: 'software-dev', workflowVersion: '1', params: { prompt: 'x' } });
    const times = (id: string, createdAt: number, completedAt: number) =>
      (store as any).db.prepare('UPDATE tasks SET createdAt=?, completedAt=? WHERE id=?').run(createdAt, completedAt, id);
    await times(task.id, day('2026-11-13'), day('2026-11-14'));
    await times(oldTask.id, day('2026-10-01'), day('2026-10-02'));
    const report = await siteAnalyticsReport(store, { from: '2026-11-13', to: '2026-11-14',
      accountsCreated: async () => [day('2026-11-13'), day('2026-11-13') + 60_000, day('2026-11-01')] });
    expect(report.totals).toEqual({ visitors: 5, views: 6, signups: 1, accounts: 2, crawls: 3 });
    expect(report.daily).toEqual([
      { day: '2026-11-13', visitors: 4, views: 5, signups: 1, accounts: 2, firstTasks: 1, firstConfirmed: 0 },
      { day: '2026-11-14', visitors: 1, views: 1, signups: 0, accounts: 0, firstTasks: 0, firstConfirmed: 1 },
    ]);
    expect(report.pages).toEqual([
      { path: '/', views: 4, entries: 4 }, { path: '/pricing', views: 1, entries: 1 }, { path: '/signup', views: 1, entries: 0 },
    ]);
    expect(report.sources.groups).toEqual([
      { group: 'social', label: 'Social', visitors: 3 }, { group: 'ai', label: 'AI assistants', visitors: 1 }, { group: 'search', label: 'Search', visitors: 1 },
    ]);
    expect(report.sources.hosts).toEqual([
      { source: 'news.ycombinator.com', group: 'social', visitors: 3 }, { source: 'chatgpt.com', group: 'ai', visitors: 1 }, { source: 'google.com', group: 'search', visitors: 1 },
    ]);
    expect(report.crawlers).toEqual([
      { name: 'Googlebot', fetches: 2, pages: [{ path: '/', fetches: 1 }, { path: '/docs', fetches: 1 }] },
      { name: 'GPTBot', fetches: 1, pages: [{ path: '/llms.txt', fetches: 1 }] },
    ]);
    expect(report.funnel).toEqual([
      { step: 'visitors', count: 5 }, { step: 'signups', count: 1 }, { step: 'accounts', count: 2 },
      { step: 'firstTasks', count: 1 }, { step: 'firstConfirmed', count: 1 },
    ]);
  });
});
