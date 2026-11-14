import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway/server.js';
import { docPages, LANDING_TAGLINE, markdownPages, publicSite } from '../src/gateway/public-pages.js';
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
    expect(page.body).toMatch(/<div id="app"><div class="prerendered">[\s\S]*<h1>Do anything with agents\.<\/h1>/);
    expect(page.body).toContain('<a href="/media/tavya-launch.mp4">Watch the launch film (1:02)</a>');
    expect(page.body).toContain('<h2>How a task goes</h2>');
    expect(page.body).toContain('<li><b>Review and approve</b>: Or leave the review to an agent.</li>');
    expect(page.body).toContain('<h2>Build the autonomous company</h2>');
    expect(page.body).toContain('<li>Dream, every night at 3:00</li>');
    expect(page.body).toContain('<blockquote>Every man a CEO, and no one has a moat. — N.H.</blockquote>');
    // Who makes it and where else it lives tell this tavya from the others of that name.
    const organization = data['@graph'].find((node: { '@type': string }) => node['@type'] === 'Organization');
    expect(organization.sameAs).toEqual(expect.arrayContaining(['https://github.com/abhimanyupallavisudhir/karmax', 'https://www.npmjs.com/package/@tavya/cli']));
    expect(organization.description).toContain('gives each task its own agent and computer');
    // Inter downloads with the page, so the landing never paints a fallback face first.
    expect(page.body).toContain('<link rel="preload" href="/fonts/inter/InterVariable.woff2" as="font" type="font/woff2" crossorigin />');
    const film = await get('/media/tavya-launch.mp4');
    expect([film.status, film.headers['content-type'], film.headers['accept-ranges']]).toEqual([200, 'video/mp4', 'bytes']);
    for (const href of ['/docs', '/docs/how-it-works', '/docs/cli', '/pricing', '/legal']) expect(page.body).toContain(`<a href="${href}">`);
    expect((await get('/social-card.png')).headers['content-type']).toBe('image/png');
  });

  it('gives readers without script the landing\'s comparison and its questions, as the console draws them', async () => {
    const page = await get('/');
    const { landing, compare } = publicSite(web);
    expect(page.body).toContain(`<h2>${compare.title}</h2>`);
    expect(page.body).toContain('<th><a href="/compare/claude-code">Claude Code</a></th>');
    expect(page.body).toContain('<tr><th>Open source</th><td>yes</td><td>no</td><td>CLI only</td>');
    expect(page.body).toContain('<a href="/compare">The comparison in full</a>');
    expect(page.body).toContain(`<h2>${landing.answers[0]}</h2>`);
    expect(page.body).toMatch(/<h3>What about files Git ignores\?<\/h3>\n<p[^>]*>They come along\. <code[^>]*>\.env<\/code> values are kept as project secrets/);
    expect(page.body).toContain('<a href="/docs/ignored-files"');
    // This installation offers no managed compute, so it promises no free trial of it.
    expect(page.body).not.toContain('What does it cost to try?');
    expect(page.body).not.toMatch(/\{\{\w+\}\}/);
    // Every row compares every product, and every product compared has its page.
    for (const [label, values] of [...compare.rows, ...compare.more])
      expect(Object.keys(values).sort(), label).toEqual(compare.products.map((product) => product.id).sort());
    for (const product of compare.products) if (product.path) expect((await get(product.path)).status, product.path).toBe(200);
  });

  it('serves the comparisons, About and the changelog as pages of their own', async () => {
    const hub = await get('/compare');
    expect(hub.status).toBe(200);
    expect(title(hub.body)).toBe('tavya compared · tavya');
    expect(canonical(hub.body)).toBe(`${base}/compare`);
    expect(meta(hub.body, 'description')).toMatch(/^How tavya compares with Claude Code on the web, Codex cloud, Devin/);
    // The table is the landing's, with the rows only the full comparison has.
    expect(hub.body).not.toContain('{{comparison}}');
    expect(hub.body).toMatch(/<th[^>]*><a href="\/compare\/devin"[^>]*>Devin<\/a><\/th>/);
    expect(hub.body).toContain('Git hosts');
    const devin = await get('/compare/devin');
    expect([devin.status, title(devin.body), canonical(devin.body)]).toEqual([200, 'tavya vs Devin · tavya', `${base}/compare/devin`]);
    expect(title((await get('/about')).body)).toBe('About tavya · tavya');
    expect((await get('/about')).body).toContain(`<code class="md-inline">${base}/mcp</code>`);
    expect(title((await get('/changelog')).body)).toBe('Changelog · tavya');
    const missing = await get('/compare/no-such-product');
    expect([missing.status, missing.headers['x-robots-tag']]).toEqual([404, 'noindex']);
    expect((await get('/compare/')).headers.location).toBe('/compare');
    // Each has its Markdown source, pointing at the page.
    for (const [source, of] of [['/compare/devin.md', '/compare/devin'], ['/compare/index.md', '/compare'], ['/about.md', '/about'], ['/changelog.md', '/changelog']]) {
      const file = await get(source!);
      expect([file.status, file.headers['content-type'], file.headers.link], source).toEqual([200, 'text/markdown; charset=utf-8', `<${base}${of}>; rel="canonical"`]);
    }
  });

  it('lists every page for agents in llms.txt, and offers them all in one file', async () => {
    const llms = (await get('/llms.txt')).body;
    expect(llms).not.toContain('{{pages}}');
    for (const doc of markdownPages(web)) expect(llms).toContain(`- [${doc.title}](${base}${doc.path}): `);
    expect(llms).toContain(`(Markdown: ${base}/docs/cli.md)`);
    expect(llms).toMatch(/^## Guides$/m);
    expect(llms).toContain(`${base}/mcp`);
    expect(llms).toContain('npm install -g @tavya/cli');
    const full = await get('/llms-full.txt');
    expect([full.status, full.headers['content-type']]).toEqual([200, 'text/plain; charset=utf-8']);
    for (const doc of markdownPages(web)) expect(full.body).toContain(`# ${doc.title}\n`);
    expect(full.body).not.toMatch(/\{\{(origin|comparison)\}\}/);
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
    for (const [from, to] of [['/docs/', '/docs'], ['/pricing/', '/pricing'], ['/docs/cli/', '/docs/cli'], ['/docs/getting-started', '/docs'], ['/about/', '/about']]) {
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
    expect(urls).toEqual(expect.arrayContaining(['/pricing', '/legal', '/legal/privacy', '/legal/terms', '/compare', '/compare/devin', '/about', '/changelog']));
    // A page says when it last changed, where that is known: a Markdown page from the site's list, a policy from its version.
    expect(sitemap.body).toMatch(new RegExp(`<loc>${base}/docs/cli</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    expect(sitemap.body).toMatch(new RegExp(`<loc>${base}/legal/privacy</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    expect(sitemap.body).toContain(`<url><loc>${base}/</loc></url>`);
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
    // The console's sidebar and the server read the same pages from web/site.js, each
    // under its file's own heading; no page of Markdown is left unlisted.
    expect(app).toContain("const sitePages = () => globalThis.KarmaxSite?.pages || [];");
    const site = publicSite(web);
    for (const entry of site.pages) {
      const source = fs.readFileSync(path.join(web, entry.file), 'utf8');
      expect(source.match(/^# (.+)$/m)?.[1], entry.file).toBe(entry.title);
      expect(entry.updated, entry.file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The first paragraph is the search description: it says what the page covers.
      expect(source.replace(/^# .+$/m, '').trim().split(/\n\s*\n/)[0]!.length, entry.file).toBeGreaterThan(60);
    }
    const listed = site.pages.map((entry) => entry.file).sort();
    const files = ['docs', 'compare'].flatMap((dir) => fs.readdirSync(path.join(web, dir)).filter((name) => name.endsWith('.md')).map((name) => `${dir}/${name}`));
    expect(listed).toEqual([...files, 'about.md', 'changelog.md'].sort());
    expect(new Set(site.pages.map((entry) => entry.path)).size).toBe(site.pages.length);
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
