import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway/server.js';
import { docPages, LANDING_TAGLINE } from '../src/gateway/public-pages.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * The public pages (landing, Docs, Pricing, Policies) are rendered by the
 * console in the browser. Before this, every URL answered with one title, one
 * description and an empty body, unknown pages were 200s, and there was no
 * sitemap: search engines and link previews saw one page. Boots a real
 * Gateway over the real web/ directory with stub deps; no Temporal.
 */
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

async function boot(hosted: boolean) {
  const store = await Store.create(':memory:');
  const gateway = await Gateway.create({
    store, bus: new KarmaxBus(), tokens: new TokenAuthority(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), client: {} as any, api: {} as any, taskQueue: 'test', staticDir: web,
    agentInfo: { provider: 'mock', reason: 'public pages test' }, worlds: new WorldRegistry(), githubApp: {} as any,
    identity: { session: async () => null, connectOrganizationNames: () => {} } as any, hosted,
  } as any);
  return gateway.listen(await findFreePortFrom(hosted ? 48_700 : 48_750));
}

function raw(base: string, pathname: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get(`${base}${pathname}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

const meta = (html: string, key: string) =>
  html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1];
const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1];
const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];

describe('public pages for search engines and link previews (hosted)', () => {
  let base: string;
  let close: () => Promise<void>;
  const get = (pathname: string) => raw(base, pathname);

  beforeAll(async () => ({ url: base, close } = await boot(true)), 30_000);
  afterAll(async () => close?.());

  it('gives the landing its own title, canonical URL, social card and structured data', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.headers['x-robots-tag']).toBeUndefined();
    expect(title(page.body)).toBe(`tavya — ${LANDING_TAGLINE}`);
    expect(canonical(page.body)).toBe(`${base}/`);
    expect(meta(page.body, 'og:url')).toBe(`${base}/`);
    expect(meta(page.body, 'og:image')).toBe(`${base}/social-card.png`);
    expect(meta(page.body, 'twitter:card')).toBe('summary_large_image');
    expect(meta(page.body, 'description')!.length).toBeLessThanOrEqual(160);
    const data = JSON.parse(page.body.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)![1]!);
    const app = data['@graph'].find((node: { '@type': string }) => node['@type'] === 'SoftwareApplication');
    expect(app.offers.map((offer: { name: string; price: string }) => `${offer.name} ${offer.price}`)).toEqual(['Free 0.00', 'Individual 9.00', 'Team 19.00']);
    // Readers that run no script get the content and a link to every public page.
    expect(page.body).toMatch(/<div id="app"><div class="prerendered">[\s\S]*<h1>The agentic to-do list that finishes itself\.<\/h1>/);
    expect(page.body).toContain('<a href="/media/tavya-launch.mp4">Watch the launch film (0:59)</a>');
    expect(page.body).toContain('<h2>How a task goes</h2>');
    expect(page.body).toContain('<li>You review the result</li>');
    // Inter downloads with the page, so the landing never paints a fallback face first.
    expect(page.body).toContain('<link rel="preload" href="/fonts/inter/InterVariable.woff2" as="font" type="font/woff2" crossorigin />');
    const film = await get('/media/tavya-launch.mp4');
    expect([film.status, film.headers['content-type'], film.headers['accept-ranges']]).toEqual([200, 'video/mp4', 'bytes']);
    for (const href of ['/docs', '/docs/how-it-works', '/docs/cli', '/pricing', '/legal']) expect(page.body).toContain(`<a href="${href}">`);
    expect((await get('/social-card.png')).headers['content-type']).toBe('image/png');
  });

  it('describes each docs page from its Markdown and renders it for readers without script', async () => {
    const page = await get('/docs/how-it-works');
    expect(page.status).toBe(200);
    expect(title(page.body)).toBe('How it works · tavya');
    expect(meta(page.body, 'og:title')).toBe('How it works');
    expect(meta(page.body, 'description')).toMatch(/^The few ideas behind tavya — organizations, projects, tasks/);
    expect(canonical(page.body)).toBe(`${base}/docs/how-it-works`);
    expect(page.body).toContain('Organizations and projects</h2>');
    expect(page.body).not.toContain('application/ld+json');
    expect(title((await get('/docs')).body)).toBe('Getting started · tavya');
    expect(canonical((await get('/docs')).body)).toBe(`${base}/docs`);
  });

  it('describes Pricing by its plans and each policy by its summary', async () => {
    const pricing = await get('/pricing');
    expect(title(pricing.body)).toBe('Pricing · tavya');
    expect(meta(pricing.body, 'description')).toContain('Individual $9/month, Team $19/month');
    expect(pricing.body).toContain('Team: $19 a month + $5 per extra person.');
    const privacy = await get('/legal/privacy');
    expect(privacy.status).toBe(200);
    expect(title(privacy.body)).toMatch(/ · tavya$/);
    expect(canonical(privacy.body)).toBe(`${base}/legal/privacy`);
    expect(title((await get('/legal')).body)).toBe('Policies · tavya');
  });

  it('answers a public URL that names nothing with a 404 the console still renders', async () => {
    for (const pathname of ['/docs/no-such-page', '/legal/no-such-policy', '/legal/%E0%A4%A']) {
      const page = await get(pathname);
      expect(page.status).toBe(404);
      expect(page.headers['x-robots-tag']).toBe('noindex');
      expect(page.body).toContain('<script type="module" src="/app.js">');
      expect(canonical(page.body)).toBeUndefined();
    }
  });

  it('sends other spellings of a public page to its canonical URL', async () => {
    for (const [from, to] of [['/docs/', '/docs'], ['/pricing/', '/pricing'], ['/docs/cli/', '/docs/cli'], ['/docs/getting-started', '/docs']]) {
      const page = await get(from!);
      expect(page.status, from).toBe(301);
      expect(page.headers.location).toBe(to);
    }
  });

  it('keeps the console out of search results', async () => {
    for (const pathname of ['/personal/my-project/tasks/1', '/login', '/signup', '/settings']) {
      const page = await get(pathname);
      expect(page.status).toBe(200);
      expect(page.headers['x-robots-tag'], pathname).toBe('noindex');
      expect(canonical(page.body)).toBeUndefined();
      expect(title(page.body)).toBe('tavya');
      expect(page.body).toContain('<div id="app"></div>');
    }
  });

  it('lists every public page in the sitemap and points robots.txt at it', async () => {
    const robots = await get('/robots.txt');
    expect(robots.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(robots.body).toContain(`Sitemap: ${base}/sitemap.xml`);
    expect(robots.body).not.toMatch(/Disallow: \/$/m);
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!.slice(base.length));
    expect(urls.slice(0, 2)).toEqual(['/', '/docs']);
    for (const doc of docPages(web)) if (doc.slug !== 'getting-started') expect(urls).toContain(`/docs/${doc.slug}`);
    expect(urls).toEqual(expect.arrayContaining(['/pricing', '/legal', '/legal/privacy', '/legal/terms']));
    // Every listed page is a real one.
    for (const url of urls) expect((await get(url)).status, url).toBe(200);
  });

  it('points a docs page’s Markdown source at the page', async () => {
    const source = await get('/docs/cli.md');
    expect(source.status).toBe(200);
    expect(source.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(source.headers.link).toBe(`<${base}/docs/cli>; rel="canonical"`);
    expect((await get('/docs/getting-started.md')).headers.link).toBe(`<${base}/docs>; rel="canonical"`);
    expect((await get('/llms.txt')).headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('titles pages as the console does once booted', () => {
    const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
    expect(app).toContain(`document.title = \`\${siteName()} — ${LANDING_TAGLINE}\`;`);
    // The console's docs sidebar and the server read the same pages under the same names.
    const listed = [...app.match(/const DOC_PAGES = \[([\s\S]*?)\];/)![1]!.matchAll(/slug: '([^']+)', path: '[^']+', title: '([^']+)'/g)]
      .map((match) => `${match[1]}: ${match[2]}`).sort();
    expect(listed).toEqual(docPages(web).map((doc) => `${doc.slug}: ${doc.title}`).sort());
  });
});

describe('public pages on a self-hosted installation', () => {
  let base: string;
  let close: () => Promise<void>;
  beforeAll(async () => ({ url: base, close } = await boot(false)), 30_000);
  afterAll(async () => close?.());

  it('asks search engines to leave a private console alone', async () => {
    expect((await raw(base, '/robots.txt')).body).toBe('User-agent: *\nDisallow: /\n');
    expect((await raw(base, '/sitemap.xml')).status).toBe(404);
    const landing = await raw(base, '/');
    expect(landing.headers['x-robots-tag']).toBe('noindex');
    // Link previews still work for a link someone shares.
    expect(canonical(landing.body)).toBe(`${base}/`);
  });
});
