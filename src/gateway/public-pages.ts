import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { publicLaunchInfo, policyDocument } from '../launch/legal.js';

/**
 * What search engines, link previews and agents that do not run JavaScript
 * see of the public pages (landing, Docs, Pricing, Policies). The console
 * renders those pages client-side, so without this every URL answered with
 * the same title, the same description and an empty body.
 *
 * Each public page gets its own title, description, canonical URL and social
 * tags in the HTML shell, plus a plain rendering of its content inside #app
 * that the console replaces as it boots (and that CSS hides from browsers
 * running script, so nobody sees it flash). Every other path is the console:
 * not for indexing.
 */

type LaunchInfo = ReturnType<typeof publicLaunchInfo>;
type Policy = NonNullable<ReturnType<typeof policyDocument>>;

export interface PublicPageContext {
  staticDir: string;
  siteName: string;
  /** This installation's public origin, e.g. https://tavya.io. */
  origin: string;
  launch: LaunchInfo;
  policy: (slug: string) => Policy | undefined;
}

export interface PublicPage {
  /** Canonical path. */
  path: string;
  /** The document title, as the console sets it once booted. */
  title: string;
  /** The page's own name, without the site's (og:title). */
  name: string;
  description: string;
  /** Plain semantic HTML of the page's content. */
  body: string;
  /** schema.org data, for the landing. */
  structuredData?: unknown;
}

export type PublicRoute =
  | { kind: 'page'; page: PublicPage }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' }
  | { kind: 'console' };

/** The landing's chapters, as the launch film and web/app.js (LANDING_CHAPTERS, LANDING_CARDS) tell them. */
const LANDING_CHAPTERS = ['Every project. One list.', 'Say what needs doing.', 'Agents work on their own computers.', 'Big jobs fan out.',
  'Review the result, not the process.', 'Not just code.', 'Give agents accounts, keys and a card.', 'Work that starts itself.',
  'Any model. Your subscription.', 'In your pocket, too.'];

/** The tagline the landing and its title share. */
export const LANDING_TAGLINE = 'the agentic to-do list that finishes itself';

const DEFAULT_DOC = 'getting-started';

const esc = (value: unknown) => String(value ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Whether `pathname` may be a public page (or a spelling of one); every other path is the console. */
export const publicPath = (pathname: string) => pathname === '/' || /^\/(docs|pricing|legal)(\/|$)/.test(pathname);

/** The policy a /legal/<slug> URL names, if it is one. */
export function policySlugOf(pathname: string): string | undefined {
  const raw = pathname.match(/^\/legal\/([^/]+)\/?$/)?.[1];
  try { return raw === undefined ? undefined : decodeURIComponent(raw); } catch { return undefined; }
}

/** A docs page's URL: Getting started is the docs' front page. */
export const docPath = (slug: string) => (slug === DEFAULT_DOC ? '/docs' : `/docs/${slug}`);

/** Plain text of a line of Markdown, for a meta description. */
const plainText = (markdown: string) => markdown
  .replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

/** Search results show about this many characters of a description. */
function clip(text: string, max = 160) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '')}…`;
}

// The console's own Markdown renderer (web/markdown.js), so the plain
// rendering of a docs page is the same HTML the console shows.
let markdown: { file: string; mtimeMs: number; render: (src: string) => string } | undefined;
function renderMarkdown(staticDir: string, source: string): string {
  const file = path.join(staticDir, 'markdown.js');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (markdown?.file !== file || markdown.mtimeMs !== mtimeMs) {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    const render = (context as { KarmaxMarkdown: { renderMarkdown: (src: string) => string } }).KarmaxMarkdown.renderMarkdown;
    markdown = { file, mtimeMs, render };
  }
  return markdown.render(source);
}

interface DocFile { slug: string; title: string; lede: string; source: string }

/** The docs pages, from web/docs/<slug>.md: the `# heading` is the title, the
 * first paragraph the description. */
export function docPages(staticDir: string): DocFile[] {
  const dir = path.join(staticDir, 'docs');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith('.md')).sort().map((name) => {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const title = source.match(/^# (.+)$/m)?.[1]?.trim() ?? name.slice(0, -3);
    const lede = source.replace(/^# .+$/m, '').trim().split(/\n\s*\n/)[0] ?? '';
    return { slug: name.slice(0, -3), title, lede: plainText(lede), source };
  }).sort((a, b) => Number(b.slug === DEFAULT_DOC) - Number(a.slug === DEFAULT_DOC));
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const gigabytes = (bytes: number) => `${Math.round(bytes / 2 ** 30)} GB`;

function planLine(plan: LaunchInfo['pricingCatalog'][number]) {
  const price = plan.monthlyBasePriceCents
    ? `${money(plan.monthlyBasePriceCents)} a month${plan.monthlyAdditionalActiveUserPriceCents ? ` + ${money(plan.monthlyAdditionalActiveUserPriceCents)} per extra person` : ''}`
    : 'free';
  const people = plan.maxMembers === 1 ? '1 person' : 'any number of people';
  return `${plan.name}: ${price}. ${people}, ${plan.maxActiveAgentRuns} agents at once, ${gigabytes(plan.storageBytes)} storage, unlimited projects.`;
}

/** The public pages, in the order the sitemap lists them. */
export function publicPaths(ctx: Pick<PublicPageContext, 'staticDir' | 'launch'>): string[] {
  return ['/', ...docPages(ctx.staticDir).map((doc) => docPath(doc.slug)), '/pricing', '/legal',
    ...ctx.launch.policies.map((policy) => `/legal/${policy.slug}`)];
}

function page(ctx: PublicPageContext, pathname: string): PublicPage | 'not-found' | undefined {
  const site = ctx.siteName;
  if (pathname === '/') {
    const description = `${site} is ${LANDING_TAGLINE}: agents work in parallel on their own computers; you review the result. Use your Claude or ChatGPT plan.`;
    const offers = ctx.launch.pricingCatalog.map((plan) => ({ '@type': 'Offer', name: plan.name,
      price: (plan.monthlyBasePriceCents / 100).toFixed(2), priceCurrency: plan.currency.toUpperCase(), url: `${ctx.origin}/pricing` }));
    return {
      path: '/', title: `${site} — ${LANDING_TAGLINE}`, name: `${site} — ${LANDING_TAGLINE}`, description,
      body: `<h1>The agentic to-do list that finishes itself.</h1>
<p>${esc(description)}</p>
<p><a href="/media/tavya-launch.mp4">Watch the launch film (0:59)</a></p>
<ul>${LANDING_CHAPTERS.map((chapter) => `<li>${esc(chapter)}</li>`).join('')}</ul>
<p><a href="/signup">Get started</a> · <a href="/login">Sign in</a></p>`,
      structuredData: { '@context': 'https://schema.org', '@graph': [
        { '@type': 'Organization', '@id': `${ctx.origin}/#organization`, name: site, url: `${ctx.origin}/`, logo: `${ctx.origin}/brand/icon-512.png` },
        { '@type': 'WebSite', '@id': `${ctx.origin}/#website`, name: site, url: `${ctx.origin}/`, publisher: { '@id': `${ctx.origin}/#organization` } },
        { '@type': 'SoftwareApplication', name: site, url: `${ctx.origin}/`, description, applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Web', publisher: { '@id': `${ctx.origin}/#organization` }, offers },
      ] },
    };
  }
  if (pathname === '/pricing') {
    const plans = ctx.launch.pricingCatalog;
    const description = clip(`${site} pricing: ${plans.map((plan) => `${plan.name} ${plan.monthlyBasePriceCents ? `${money(plan.monthlyBasePriceCents)}/month` : `(${money(0)})`}`).join(', ')}. Every plan has unlimited projects; plans differ in people, agents at once, storage and compute.`);
    return { path: '/pricing', title: `Pricing · ${site}`, name: 'Pricing', description,
      body: `<h1>Pricing</h1><ul>${plans.map((plan) => `<li>${esc(planLine(plan))}</li>`).join('')}</ul>` };
  }
  if (pathname === '/legal') {
    return { path: '/legal', title: `Policies · ${site}`, name: 'Policies', description: `${site}'s terms, privacy, billing, security and acceptable-use policies, with their current versions.`,
      body: `<h1>Policies &amp; trust</h1><ul>${ctx.launch.policies.map((policy) => `<li><a href="/legal/${esc(policy.slug)}">${esc(policy.title)}</a>: ${esc(policy.summary)}</li>`).join('')}</ul>` };
  }
  const slug = pathname.endsWith('/') ? undefined : policySlugOf(pathname);
  if (slug !== undefined || /^\/legal\/[^/]+$/.test(pathname)) {
    const policy = slug === undefined ? undefined : ctx.policy(slug);
    if (!policy) return 'not-found';
    return { path: `/legal/${policy.slug}`, title: `${policy.title} · ${site}`, name: policy.title, description: clip(policy.summary),
      body: `<h1>${esc(policy.title)}</h1><p>Version ${esc(policy.version)} · Effective ${esc(policy.effectiveDate)}</p><p>${esc(policy.summary)}</p>${policy.sections.map((section) => `<h2>${esc(section.heading)}</h2>${section.paragraphs.map((text) => `<p>${esc(text)}</p>`).join('')}${section.bullets?.length ? `<ul>${section.bullets.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}`).join('')}` };
  }
  const docs = pathname.match(/^\/docs(?:\/([^/]+))?$/);
  if (docs) {
    const slug = docs[1] ?? DEFAULT_DOC;
    const doc = docPages(ctx.staticDir).find((candidate) => candidate.slug === slug);
    if (!doc) return 'not-found';
    return { path: docPath(slug), title: `${doc.title} · ${site}`, name: doc.title, description: clip(doc.lede),
      body: renderMarkdown(ctx.staticDir, doc.source.replaceAll('{{origin}}', ctx.origin)) };
  }
  return undefined;
}

/** What `pathname` is: a public page, a non-canonical spelling of one, a
 * public URL that names nothing, or the console. */
export function resolvePublicRoute(ctx: PublicPageContext, pathname: string): PublicRoute {
  if (pathname === `/docs/${DEFAULT_DOC}`) return { kind: 'redirect', location: '/docs' };
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const bare = pathname.replace(/\/+$/, '') || '/';
    const target = page(ctx, bare);
    return target && target !== 'not-found' ? { kind: 'redirect', location: target.path } : { kind: 'console' };
  }
  const found = page(ctx, pathname);
  if (found === 'not-found') return { kind: 'not-found' };
  return found ? { kind: 'page', page: found } : { kind: 'console' };
}

/** The tags a public page adds to the shell's <head>. */
export function publicHead(ctx: PublicPageContext, target: PublicPage, socialImage?: { path: string; alt: string }): string {
  const url = `${ctx.origin}${target.path}`;
  const tags = [
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(ctx.siteName)}" />`,
    `<meta property="og:title" content="${esc(target.name)}" />`,
    `<meta property="og:description" content="${esc(target.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:card" content="${socialImage ? 'summary_large_image' : 'summary'}" />`,
    ...(socialImage ? [
      `<meta property="og:image" content="${esc(`${ctx.origin}${socialImage.path}`)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${esc(socialImage.alt)}" />`,
    ] : []),
    // A data block, never executed, so the console's script policy allows it.
    ...(target.structuredData ? [`<script type="application/ld+json">${JSON.stringify(target.structuredData).replace(/</g, '\\u003c')}</script>`] : []),
  ];
  return tags.join('\n    ');
}

/** The plain rendering placed inside #app: the page, and links to every other
 * public page so a crawler that reads no script still finds them all. */
export function publicBody(ctx: PublicPageContext, target: PublicPage): string {
  const docs = docPages(ctx.staticDir);
  return `<div class="prerendered"><header><a href="/">${esc(ctx.siteName)}</a></header>
<main>${target.body}</main>
<nav aria-label="Site"><ul>${docs.map((doc) => `<li><a href="${docPath(doc.slug)}">${esc(doc.title)}</a></li>`).join('')}<li><a href="/pricing">Pricing</a></li><li><a href="/legal">Policies</a></li></ul></nav></div>`;
}

export function sitemapXml(origin: string, paths: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(`${origin}${p}`)}</loc></url>`).join('\n')}
</urlset>
`;
}

/** Hosted installations invite indexing of their public pages; a self-hosted
 * one is somebody's private console, so it asks to be left out. */
export function robotsTxt(origin: string, indexable: boolean): string {
  return indexable ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
}
