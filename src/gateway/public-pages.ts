import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { BRAND } from '../domain/brand.js';
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
  /** The providers the installation runs computers on for its customers (none: it offers no managed compute). */
  managedCompute: string[];
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

/** The tagline the landing and its title share. */
export const LANDING_TAGLINE = 'do anything with agents';

const DEFAULT_DOC = 'getting-started';

const esc = (value: unknown) => String(value ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Whether `pathname` may be a public page (or a spelling of one); every other path is the console.
 * The first segments are reserved for organizations in src/store/db.ts (RESERVED_ORGANIZATION_SLUGS). */
export const publicPath = (pathname: string) => pathname === '/' || /^\/(docs|pricing|legal|compare|about|changelog)(\/|$)/.test(pathname);

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

/** A cell of the comparison: the product does it, does not, or does in part (said in a few words). */
type Compared = 'yes' | 'no' | string;
type LandingPart = [shot: string, title: string, line: string, alt: string];

/** web/site.js: the pages beside the console and the landing's words, shared with web/app.js. */
export interface Site {
  /** `label` is a page's name in the console's sidebar. */
  pages: Array<{ path: string; file: string; title: string; group: string; updated?: string; label: string }>;
  landing: {
    steps: [string, LandingPart[]];
    autonomy: [string, string, LandingPart[]];
    automations: Array<[string, string]>;
    features: [string, LandingPart[]];
    quotes: Array<[string, string]>;
    answers: [string, Array<[string, string]>];
  };
  /** `rows` are the landing's; `more` is what the comparison in full adds. */
  compare: { title: string; asOf: string; products: Array<{ id: string; name: string; path?: string }>;
    rows: Array<[string, Record<string, Compared>]>; more: Array<[string, Record<string, Compared>]> };
  source: string;
  sameAs: string[];
}

interface SiteScript extends Site {
  /** The comparison as a Markdown table: a page's `{{comparison}}`. */
  comparisonTable(): string;
  /** The landing's questions with an installation's numbers; one that lacks a number is left out. */
  answers(values?: Record<string, string>): Array<[string, string]>;
}

let siteFile: { file: string; mtimeMs: number; script: SiteScript; site: Site } | undefined;
function siteScript(staticDir: string) {
  const file = path.join(staticDir, 'site.js');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (siteFile?.file !== file || siteFile.mtimeMs !== mtimeMs) {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    const script = (context as { KarmaxSite: SiteScript }).KarmaxSite;
    // Through JSON, so the data are this realm's own arrays and objects.
    siteFile = { file, mtimeMs, script, site: JSON.parse(JSON.stringify(script)) as Site };
  }
  return siteFile;
}
export const publicSite = (staticDir: string): Site => siteScript(staticDir).site;

interface MarkdownPage { path: string; file: string; title: string; group: string; updated?: string; lede: string; source: string }
interface DocFile extends MarkdownPage { slug: string }

/** The Markdown pages web/site.js lists: the `# heading` is the title, the first
 * paragraph the description. One whose file is missing is no page. */
export function markdownPages(staticDir: string): MarkdownPage[] {
  const site = publicSite(staticDir);
  return site.pages.flatMap((entry) => {
    let source: string;
    try { source = fs.readFileSync(path.join(staticDir, entry.file), 'utf8'); } catch { return []; }
    const title = source.match(/^# (.+)$/m)?.[1]?.trim() ?? entry.title;
    const lede = source.replace(/^# .+$/m, '').trim().split(/\n\s*\n/)[0] ?? '';
    return [{ ...entry, title, lede: plainText(lede), source: source.replaceAll('{{comparison}}', () => siteScript(staticDir).script.comparisonTable()) }];
  });
}

/** The docs pages (/docs and /docs/<slug>). */
export function docPages(staticDir: string): DocFile[] {
  return markdownPages(staticDir).filter((doc) => doc.path === '/docs' || doc.path.startsWith('/docs/'))
    .map((doc) => ({ ...doc, slug: doc.path === '/docs' ? DEFAULT_DOC : doc.path.slice('/docs/'.length) }));
}

/** The page a Markdown file under web/ is the source of, if it is one. */
export function markdownSourcePage(staticDir: string, pathname: string): string | undefined {
  return publicSite(staticDir).pages.find((entry) => `/${entry.file}` === pathname)?.path;
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const gigabytes = (bytes: number) => `${Math.round(bytes / 2 ** 30)} GB`;

function planLine(plan: LaunchInfo['pricingCatalog'][number], launch: LaunchInfo, compute: boolean) {
  const price = plan.monthlyBasePriceCents
    ? `${money(plan.monthlyBasePriceCents)} a month${plan.monthlyAdditionalActiveUserPriceCents ? ` + ${money(plan.monthlyAdditionalActiveUserPriceCents)} per extra person` : ''}`
    : 'free';
  const people = plan.maxMembers === 1 ? '1 person' : 'any number of people';
  const credit = (micros: number) => money(Math.round(micros / 10_000));
  const included = !compute ? ''
    : plan.computeCreditMicros ? `, ${credit(plan.computeCreditMicros)} of compute a month`
    : plan.monthlyBasePriceCents === 0 && launch.trial ? `, ${credit(launch.trial.creditMicros)} of compute free for ${launch.trial.days} days` : '';
  return `${plan.name}: ${price}. ${people}, ${plan.maxActiveAgentRuns} agents at once, ${gigabytes(plan.storageBytes)} storage${included}, unlimited projects.`;
}

/** The public pages, in the order the sitemap lists them, each with the day it last changed where that is known. */
export function publicEntries(ctx: Pick<PublicPageContext, 'staticDir' | 'launch'>): Array<{ path: string; lastmod?: string }> {
  const pages = markdownPages(ctx.staticDir).map((doc) => ({ path: doc.path, lastmod: doc.updated }));
  const inSection = (prefix: string) => pages.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`));
  // A policy's version starts with the day it took effect.
  const policyDay = (version: string) => version.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return [{ path: '/' }, ...inSection('/docs'), ...inSection('/compare'), { path: '/pricing' },
    ...pages.filter((entry) => !/^\/(docs|compare)(\/|$)/.test(entry.path)),
    { path: '/legal', lastmod: policyDay(ctx.launch.policyVersion) },
    ...ctx.launch.policies.map((policy) => ({ path: `/legal/${policy.slug}`, lastmod: policyDay(policy.version) }))];
}

export const publicPaths = (ctx: Pick<PublicPageContext, 'staticDir' | 'launch'>) => publicEntries(ctx).map((entry) => entry.path);

/** The landing for readers that run no script: what web/app.js (renderLanding) draws, in the same words. */
function landingBody(ctx: PublicPageContext, description: string): string {
  const { landing, compare } = publicSite(ctx.staticDir);
  const emphasis = (text: string) => esc(text).replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const parts = (list: LandingPart[]) => `<ul>${list.map(([, title, line]) => `<li><b>${esc(title)}</b>: ${esc(line)}</li>`).join('')}</ul>`;
  const [stepsTitle, steps] = landing.steps;
  const [autonomyTitle, autonomyLine, autonomy] = landing.autonomy;
  const [featuresTitle, features] = landing.features;
  const [answersTitle] = landing.answers;
  const cell = (value: string | undefined) => (value === 'yes' ? 'yes' : !value || value === 'no' ? 'no' : esc(value));
  const comparison = compare.rows.length ? `<h2>${esc(compare.title)}</h2>
<table><thead><tr><th></th>${compare.products.map((product) => `<th>${product.path ? `<a href="${esc(product.path)}">${esc(product.name)}</a>` : esc(product.name)}</th>`).join('')}</tr></thead>
<tbody>${compare.rows.map(([label, values]) => `<tr><th>${esc(label)}</th>${compare.products.map((product) => `<td>${cell(values[product.id])}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>As of ${esc(compare.asOf)}. <a href="/compare">The comparison in full</a></p>` : '';
  const answers = landingAnswers(ctx);
  return `<h1>Do anything with agents.</h1>
<p>${esc(description)}</p>
<p><a href="/media/tavya-launch.mp4">Watch the launch film (1:02)</a></p>
<h2>${esc(stepsTitle)}</h2>
${parts(steps)}
<h2>${esc(autonomyTitle)}</h2>
<p>${esc(autonomyLine)}</p>
${parts(autonomy)}
<ul>${landing.automations.map(([title, when]) => `<li>${esc(title)}, ${esc(when)}</li>`).join('')}</ul>
<h2>${esc(featuresTitle)}</h2>
${parts(features)}
${comparison}
${landing.quotes.map(([quote, who]) => `<blockquote>${emphasis(quote)} — ${esc(who)}</blockquote>`).join('\n')}
${answers.length ? `<h2>${esc(answersTitle)}</h2>\n${answers.map(([question, answer]) => `<h3>${esc(question)}</h3>\n${renderMarkdown(ctx.staticDir, answer)}`).join('\n')}` : ''}
<p><a href="/signup">Get started</a> · <a href="/login">Sign in</a></p>`;
}

/** The landing's questions with this installation's numbers. */
function landingAnswers(ctx: PublicPageContext): Array<[string, string]> {
  const trial = ctx.launch.trial;
  const answers = siteScript(ctx.staticDir).script.answers(trial && ctx.managedCompute.length
    ? { trialCredit: money(Math.round(trial.creditMicros / 10_000)), trialDays: String(trial.days) } : {});
  return answers.map(([question, answer]) => [String(question), String(answer)]);
}

function page(ctx: PublicPageContext, pathname: string): PublicPage | 'not-found' | undefined {
  const site = ctx.siteName;
  if (pathname === '/') {
    const description = `Do anything with agents. ${site} gives each task its own agent and computer, with your accounts and card; you approve. Use your Claude or ChatGPT plan.`;
    const offers = ctx.launch.pricingCatalog.map((plan) => ({ '@type': 'Offer', name: plan.name,
      price: (plan.monthlyBasePriceCents / 100).toFixed(2), priceCurrency: plan.currency.toUpperCase(), url: `${ctx.origin}/pricing` }));
    // Who makes it and where else it lives: what tells this tavya from the other things of that name.
    const founder = ctx.launch.operator?.name ? { founder: { '@type': 'Person', name: ctx.launch.operator.name } } : {};
    const sameAs = site === BRAND ? { sameAs: publicSite(ctx.staticDir).sameAs } : {};
    return {
      path: '/', title: `${site} — ${LANDING_TAGLINE}`, name: `${site} — ${LANDING_TAGLINE}`, description,
      body: landingBody(ctx, description),
      structuredData: { '@context': 'https://schema.org', '@graph': [
        { '@type': 'Organization', '@id': `${ctx.origin}/#organization`, name: site, url: `${ctx.origin}/`, logo: `${ctx.origin}/brand/icon-512.png`,
          description, ...founder, ...sameAs },
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
      body: `<h1>Pricing</h1><ul>${plans.map((plan) => `<li>${esc(planLine(plan, ctx.launch, ctx.managedCompute.length > 0))}</li>`).join('')}</ul>${ctx.managedCompute.length
        ? `<p>Compute is the cloud computers agents work on, charged at ${ctx.launch.packs.computePriceMultiplier}× the provider’s list price. Computers on your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account cost nothing extra. Agents can run on your own Claude or ChatGPT plan or API key, billed by their providers.</p>` : ''}` };
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
  // A page of Markdown: a docs page, a comparison, About, the changelog.
  const doc = markdownPages(ctx.staticDir).find((candidate) => candidate.path === pathname);
  if (doc) return { path: doc.path, title: `${doc.title} · ${site}`, name: doc.title, description: clip(doc.lede),
    body: renderMarkdown(ctx.staticDir, doc.source.replaceAll('{{origin}}', ctx.origin)) };
  if (/^\/(docs|compare)\/[^/]+$/.test(pathname)) return 'not-found';
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
  const pages = markdownPages(ctx.staticDir);
  return `<div class="prerendered"><header><a href="/">${esc(ctx.siteName)}</a></header>
<main>${target.body}</main>
<nav aria-label="Site"><ul>${pages.map((doc) => `<li><a href="${doc.path}">${esc(doc.title)}</a></li>`).join('')}<li><a href="/pricing">Pricing</a></li><li><a href="/legal">Policies</a></li></ul></nav></div>`;
}

export function sitemapXml(origin: string, entries: Array<{ path: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => `  <url><loc>${esc(`${origin}${entry.path}`)}</loc>${entry.lastmod ? `<lastmod>${esc(entry.lastmod)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

/** llms.txt's `{{pages}}`: every Markdown page by kind, with what it covers and where its source is. */
export function llmsPageList(staticDir: string, origin: string): string {
  const headings: Record<string, string> = { Site: 'About' };
  const groups = new Map<string, string[]>();
  for (const doc of markdownPages(staticDir)) {
    const lines = groups.get(doc.group) ?? [];
    lines.push(`- [${doc.title}](${origin}${doc.path}): ${doc.lede} (Markdown: ${origin}/${doc.file})`);
    groups.set(doc.group, lines);
  }
  return [...groups].map(([group, lines]) => `## ${headings[group] ?? group}\n\n${lines.join('\n')}`).join('\n\n');
}

/** Every Markdown page in one file, for a reader that wants the whole site at once (llms-full.txt). */
export function llmsFullText(staticDir: string, siteName: string, origin: string): string {
  return `# ${siteName}\n\n${markdownPages(staticDir).map((doc) =>
    `${doc.source.replaceAll('{{origin}}', origin).trim()}\n\nSource: ${origin}${doc.path}`).join('\n\n---\n\n')}\n`;
}

/** Hosted installations invite indexing of their public pages; a self-hosted
 * one is somebody's private console, so it asks to be left out. */
export function robotsTxt(origin: string, indexable: boolean): string {
  return indexable ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
}
