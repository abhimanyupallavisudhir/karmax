import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publicShareFetch, publicUrl } from '../mcp/connections/http.js';
import { BRAND } from '../domain/brand.js';

/** Thrown with what to do when a share link cannot be read. */
export class ShareLinkError extends Error {}

/**
 * Public conversation share links tavya can import, one provider each: which
 * links are its own, and how a server reads the conversation behind one (its
 * page, or the data its page loads). Every request goes through the guarded
 * public fetch, which follows no redirect and names itself; none answers a
 * human-verification check. A provider is listed only once verified against a
 * real link (wiki features/conversation-imports).
 */
export type ShareFormat = 'chatgpt-share' | 'claude-share' | 'gemini-share' | 'tavya-share' | SiteFormat;
/** Sites whose request panagent knows (vendor/panagent shares.py `SITES`). */
type SiteFormat = 'deepseek-share' | 'grok-share' | 'perplexity-share' | 'poe-share' | 'mistral-share' | 'kimi-share' | 'qwen-share';

/** The apps whose share links tavya reads, for messages and the link field's tooltip. */
export const SHARE_APPS = 'ChatGPT, Claude, Gemini, Grok, Perplexity, DeepSeek, Le Chat, Poe, Kimi, Qwen or ' + BRAND;
export interface ConversationShareLink { url: string; format: ShareFormat; /** A tavya share's id. */ id?: string }
export interface SharedConversation { data: Buffer; name: string }

interface ShareProvider {
  format: ShareFormat;
  /** The link is this provider's (undefined: it is not). */
  matches(url: URL): Omit<ConversationShareLink, 'url' | 'format'> | undefined;
  fetch(share: ConversationShareLink): Promise<SharedConversation>;
}

const notFound = () => new ShareLinkError('Share link not found; it may have been deleted or unshared');

/** A share's page, which carries the conversation. */
async function sharePage(share: ConversationShareLink, name = 'share.html'): Promise<SharedConversation> {
  const response = await publicShareFetch(share.url);
  if (response.status === 404 || response.status === 410) throw notFound();
  if (!response.ok) throw new ShareLinkError(`Share request returned HTTP ${response.status}`);
  return { data: Buffer.from(await response.arrayBuffer()), name };
}

/** tavya (any karmax install) serves shares at an unguessable id below this path. */
const TAVYA_SHARE_PATH = /^\/share\/conversations\/([A-Za-z0-9_-]{43})$/;

/** claude.ai serves a share as an app shell that loads the conversation from
 * this JSON, which keeps tool calls and titles the rendered page drops. */
export function claudeShareSnapshotUrl(share: ConversationShareLink): string | undefined {
  if (share.format !== 'claude-share') return undefined;
  const id = new URL(share.url).pathname.slice('/share/'.length).replace(/\/$/, '');
  return `https://claude.ai/api/chat_snapshots/${encodeURIComponent(id)}?rendering_mode=messages&render_all_tools=true`;
}

/** Cloudflare in front of claude.ai answers a request that looks scripted with
 * a "Verify you are human" page (403). Checked 2026-10-20: from tavya.io's host a
 * request is served once it names itself and says it is a navigation; from E2B
 * it must also offer ALPN, as guardedFetch does. A bare request is refused. */
const CLAUDE_SNAPSHOT_HEADERS = { 'user-agent': BRAND, accept: 'application/json', 'sec-fetch-mode': 'navigate' };

/** Where a Gemini share link may lead: its short links redirect to gemini.google.com/share/<id>. */
const GEMINI_SHARE_HOSTS = new Set(['gemini.google.com', 'share.gemini.google', 'g.co']);

/** The gemini.google.com/share/<id> a Gemini link leads to, following at most
 * three redirects by hand (publicShareFetch follows none) and only between
 * Gemini's own hosts. */
async function geminiShareId(link: string): Promise<string> {
  let url = new URL(link);
  for (let hop = 0; ; hop++) {
    const id = url.hostname === 'gemini.google.com' ? url.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/)?.[1] : undefined;
    if (id) return id;
    if (hop === 3) break;
    const response = await publicShareFetch(url.toString(), { redirect: 'manual', headers: { 'user-agent': BRAND } });
    if (response.status === 404 || response.status === 410) throw notFound();
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    url = new URL(location, url);
    if (url.protocol !== 'https:' || !GEMINI_SHARE_HOSTS.has(url.hostname.toLowerCase()))
      throw new ShareLinkError(`This Gemini link leads outside Gemini (${url.hostname})`);
  }
  throw new ShareLinkError('This Gemini link did not lead to a gemini.google.com/share/ conversation');
}

const VENDORED_PANAGENT = fileURLToPath(new URL('../../vendor/panagent/src', import.meta.url));

/** The request that returns a share's conversation, as panagent knows it
 * (`panagent share-request`), so each site's recipe lives in one place. */
async function panagentShareRequest(link: string): Promise<{ site: string; method: string; url: string;
  headers: Record<string, string>; body: string | null }> {
  const { stdout } = await promisify(execFile)(process.env.KARMAX_PANAGENT_PYTHON || 'python3',
    ['-m', 'panagent', 'share-request', link], { env: { PATH: process.env.PATH, PYTHONPATH: VENDORED_PANAGENT }, timeout: 30_000 });
  return JSON.parse(stdout);
}

/** A share of a panagent site: its request, made through the guarded fetch. An
 * error answer the site gives as data (Grok's, Kimi's, Perplexity's JSON) is
 * the reader's to name; a human-verification check is never answered. */
async function siteShare(share: ConversationShareLink): Promise<SharedConversation> {
  const request = await panagentShareRequest(share.url);
  const response = await publicShareFetch(request.url, { method: request.method, body: request.body ?? undefined,
    headers: { 'user-agent': BRAND, ...request.headers } });
  if (response.status === 404 || response.status === 410) throw notFound();
  if (response.headers.get('cf-mitigated') === 'challenge')
    throw new ShareLinkError(`${request.site} asked for a browser check; paste the link again, or open ${request.url} `
      + 'in your browser, save it (Ctrl+S or ⌘S) and upload that file under Fork a previous agent → Upload conversation');
  const json = /json/i.test(response.headers.get('content-type') ?? '');
  if (!response.ok && !(json && response.status < 500))
    throw new ShareLinkError(`${request.site} returned HTTP ${response.status} for this share`);
  return { data: Buffer.from(await response.arrayBuffer()), name: json ? 'share.json' : 'share.html' };
}

/** A path on one of these hosts (the links panagent's sites match). */
const at = (hosts: string[], path: RegExp) => (url: URL) => hosts.includes(url.hostname) && path.test(url.pathname) ? {} : undefined;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SITES: Array<[SiteFormat, ShareProvider['matches']]> = [
  ['deepseek-share', at(['chat.deepseek.com'], /^\/share\/[A-Za-z0-9]+\/?$/)],
  ['grok-share', at(['grok.com', 'www.grok.com'], /^\/share\/[^/]+\/?$/)],
  ['perplexity-share', at(['perplexity.ai', 'www.perplexity.ai'], /^\/search\/[A-Za-z0-9._-]+\/?$/)],
  ['poe-share', at(['poe.com', 'www.poe.com'], /^\/s\/[A-Za-z0-9]+\/?$/)],
  // A Le Chat chat is shared by making it public; its link is the chat's own.
  ['mistral-share', at(['chat.mistral.ai'], new RegExp(`^/chat/${UUID}/?$`))],
  ['kimi-share', at(['kimi.com', 'www.kimi.com'], /^\/share\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?[a-z0-9]+\/?$/)],
  ['qwen-share', at(['chat.qwen.ai'], new RegExp(`^/s/${UUID}/?$`))],
];

const PROVIDERS: ShareProvider[] = [
  {
    format: 'tavya-share',
    matches: (url) => { const id = url.pathname.match(TAVYA_SHARE_PATH)?.[1]; return id ? { id } : undefined; },
    fetch: (share) => sharePage(share),
  },
  {
    format: 'chatgpt-share',
    matches: (url) => ['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname) && url.pathname.startsWith('/share/') ? {} : undefined,
    fetch: (share) => sharePage(share),
  },
  {
    format: 'claude-share',
    matches: (url) => ['claude.ai', 'www.claude.ai'].includes(url.hostname) && url.pathname.startsWith('/share/') ? {} : undefined,
    async fetch(share) {
      const snapshot = claudeShareSnapshotUrl(share)!;
      const response = await publicShareFetch(snapshot, { headers: CLAUDE_SNAPSHOT_HEADERS });
      if (response.status === 404 || response.status === 410) throw notFound();
      if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? ''))
        throw new ShareLinkError(`claude.ai refused to send this share to ${BRAND} (HTTP ${response.status}). Open ${snapshot} `
          + 'in your browser, save it (Ctrl+S or ⌘S) and upload that file under Fork a previous agent → Upload conversation '
          + '(move a started task back to Draft first).');
      return { data: Buffer.from(await response.arrayBuffer()), name: 'share.json' };
    },
  },
  {
    // The page has no conversation; it asks this RPC, which answers anyone
    // (panagent web.py gemini_share_request makes the same request).
    format: 'gemini-share',
    matches: (url) => (url.hostname === 'gemini.google.com' && /^\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
      || (url.hostname === 'share.gemini.google' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
      || (url.hostname === 'g.co' && /^\/gemini\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) ? {} : undefined,
    async fetch(share) {
      const id = await geminiShareId(share.url);
      const body = new URLSearchParams({ 'f.req': JSON.stringify([[['ujx1Bf', JSON.stringify([null, id, [4]]), null, 'generic']]]) });
      const response = await publicShareFetch(`https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ujx1Bf&source-path=%2Fshare%2F${id}&hl=en-US&rt=c`, {
        method: 'POST', body,
        headers: { 'user-agent': BRAND, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'x-same-domain': '1' },
      });
      if (!response.ok) throw new ShareLinkError(`Gemini returned HTTP ${response.status} for this share`);
      return { data: Buffer.from(await response.arrayBuffer()), name: 'share.txt' };
    },
  },
  ...SITES.map(([format, matches]): ShareProvider => ({ format, matches, fetch: siteShare })),
];

export function isShareFormat(value: string): value is ShareFormat {
  return PROVIDERS.some((provider) => provider.format === value);
}

/** A public HTTPS share link of a provider tavya can import. */
export function publicConversationShare(value: string): ConversationShareLink | undefined {
  let url: URL;
  try { url = publicUrl(value); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  for (const provider of PROVIDERS) {
    const found = provider.matches(url);
    if (found) return { url: url.toString(), format: provider.format, ...found };
  }
  return undefined;
}

/** A share link's conversation, as panagent reads it. */
export async function fetchShare(share: ConversationShareLink): Promise<SharedConversation> {
  return PROVIDERS.find((provider) => provider.format === share.format)!.fetch(share);
}
