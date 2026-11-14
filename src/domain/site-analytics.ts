/**
 * The pure parts of the public site's web analytics (wiki
 * features/site-analytics): which crawler a User-Agent names, whether a
 * beacon came from a person's browser, and where a visit came from.
 */

/** Counted rows: page views, new visitors (by the page and source they arrived
 * with), people who opened sign-up, and crawler fetches, per UTC day. */
export interface SiteAnalyticsCount { day: string; kind: 'view' | 'visitor' | 'signup' | 'crawl'; path: string; source: string; n: number }
export interface SiteAnalyticsRow { day: string; kind: SiteAnalyticsCount['kind']; path: string; source: string; count: number }
/** A person seen on `day` (by hash), with the page and source of their first view in the batch. */
export interface SiteVisitorMark { day: string; mark: '' | 'signup'; hash: string; path: string; source: string }

/** Crawlers by name; the first that matches wins, so the specific come first. */
const CRAWLERS: Array<[name: string, pattern: RegExp]> = [
  ['OAI-SearchBot', /OAI-SearchBot/i],
  ['ChatGPT-User', /ChatGPT-User/i],
  ['GPTBot', /GPTBot/i],
  ['Claude-SearchBot', /Claude-SearchBot/i],
  ['Claude-User', /Claude-User/i],
  ['ClaudeBot', /ClaudeBot/i],
  ['Perplexity-User', /Perplexity-User/i],
  ['PerplexityBot', /PerplexityBot/i],
  ['Googlebot', /Googlebot|Google-InspectionTool/i],
  ['Bingbot', /bingbot|BingPreview/i],
  ['Applebot', /Applebot/i],
  ['DuckDuckBot', /DuckDuckBot|DuckAssistBot/i],
  ['meta-externalagent', /meta-external(agent|fetcher)/i],
  ['Bytespider', /Bytespider/i],
  ['CCBot', /CCBot/i],
  ['Amazonbot', /Amazonbot/i],
  ['YandexBot', /Yandex(Bot|MobileBot)/i],
  // What fetches a page to draw its card where someone shared the link.
  ['Link previews', /facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|Discordbot|WhatsApp|TelegramBot|redditbot|Iframely|Embedly|Mastodon|Bluesky|Cardyb/i],
];
/** Says it is a bot — except a phone maker called Cubot. */
const OTHER_BOT = /bot|crawl|spider|slurp/i;
const NOT_A_BOT = /cubot/i;
/** Software that loads pages with no person behind it. */
const AUTOMATED = /headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|jsdom|curl\/|wget\/|python|go-http-client|java\/|okhttp|node-fetch|undici|axios|libwww|httpclient|scrapy|postman/i;

/** The crawler `userAgent` names, "Other bots" for one that only says it is one, or undefined for anything else. */
export function crawlerOf(userAgent: string | undefined): string | undefined {
  const ua = userAgent ?? '';
  if (!ua) return undefined;
  const named = CRAWLERS.find(([, pattern]) => pattern.test(ua))?.[0];
  if (named) return named;
  return OTHER_BOT.test(ua.replace(NOT_A_BOT, '')) ? 'Other bots' : undefined;
}

/** Whether a beacon came from a person's browser: every browser says Mozilla/5.0; bots and headless ones don't count. */
export function humanBrowser(userAgent: string | undefined): boolean {
  const ua = userAgent ?? '';
  return ua.startsWith('Mozilla/5.0 ') && !crawlerOf(ua) && !AUTOMATED.test(ua);
}

export type SourceGroup = 'search' | 'ai' | 'social' | 'direct' | 'other';
export const SOURCE_GROUPS: Record<SourceGroup, string> = {
  search: 'Search', ai: 'AI assistants', social: 'Social', direct: 'Direct', other: 'Other',
};

// A host matches a domain when it is that domain or under it. AI before
// Search: gemini.google.com is not Google search.
const AI = ['chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'copilot.cloud.microsoft', 'you.com', 'phind.com', 'chat.deepseek.com', 'grok.com', 'meta.ai',
  'chat.mistral.ai', 'poe.com', 'kimi.com', 'chat.qwen.ai'];
const SEARCH = ['bing.com', 'duckduckgo.com', 'search.yahoo.com', 'yahoo.com', 'baidu.com', 'ecosia.org', 'search.brave.com',
  'startpage.com', 'qwant.com', 'kagi.com', 'naver.com', 'seznam.cz', 'yandex.com'];
const SOCIAL = ['news.ycombinator.com', 'hn.algolia.com', 'reddit.com', 'x.com', 't.co', 'twitter.com', 'linkedin.com', 'lnkd.in',
  'youtube.com', 'youtu.be', 'producthunt.com', 'github.com', 'facebook.com', 'instagram.com', 'threads.net', 'bsky.app',
  'mastodon.social', 'lobste.rs', 'dev.to', 'medium.com', 'substack.com', 'discord.com', 'slack.com', 't.me', 'whatsapp.com',
  'tiktok.com', 'indiehackers.com'];
/** Campaign tags people write by hand for those places. */
const ALIASES: Record<string, string> = { hn: 'news.ycombinator.com', hackernews: 'news.ycombinator.com', ycombinator: 'news.ycombinator.com',
  twitter: 'x.com', x: 'x.com', ph: 'producthunt.com', chatgpt: 'chatgpt.com', openai: 'chatgpt.com', gemini: 'gemini.google.com',
  copilot: 'copilot.microsoft.com', google: 'google.com', fb: 'facebook.com', bluesky: 'bsky.app', lobsters: 'lobste.rs' };

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
/** google.com, google.co.uk, google.de …, and their subdomains. */
const GOOGLE = /(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const YANDEX = /(^|\.)yandex\.[a-z.]+$/;

/** The group of a source: a referring host or a campaign tag; '' is a visit with neither. */
export function sourceGroup(source: string): SourceGroup {
  if (!source) return 'direct';
  // A bare tag ("reddit", "ycombinator") names the domain it is the name of.
  const stem = (domain: string) => domain.split('.').at(-2);
  const host = ALIASES[source] ?? source;
  const bare = !host.includes('.');
  const match = (list: string[]) => list.some((domain) => (bare ? stem(domain) === host : under(host, domain)));
  if (match(AI)) return 'ai';
  if (match(SEARCH) || GOOGLE.test(host) || YANDEX.test(host)) return 'search';
  if (match(SOCIAL)) return 'social';
  return 'other';
}

/** A campaign tag: lower case letters, digits, dots, dashes, underscores; at most 40. */
const tag = (value: string | null) => (value ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

/** Where a beacon's view came from: its `utm_source` or `ref` tag, else
 * the referring host (no `www.`), '' when there is none, and null when the
 * referrer is this site itself (a page leading to another is no source). */
export function beaconSource(pathWithQuery: string, referrer: string, ownHost: string | string[]): string | null {
  let query: URLSearchParams;
  try { query = new URL(pathWithQuery, 'http://site.invalid').searchParams; } catch { query = new URLSearchParams(); }
  const campaign = tag(query.get('utm_source')) || tag(query.get('ref'));
  if (campaign) return campaign;
  let host = '';
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return ''; }
  const bare = (value: string) => value.replace(/^www\./, '');
  const own = (value: string) => bare(value.toLowerCase().replace(/:\d+$/, ''));
  if ([ownHost].flat().some((value) => own(value) === bare(host))) return null;
  return bare(host).slice(0, 253);
}

/** The UTC day of `ms`, as YYYY-MM-DD. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
