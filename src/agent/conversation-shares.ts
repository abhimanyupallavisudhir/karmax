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
export type ShareFormat = 'chatgpt-share' | 'claude-share' | 'gemini-share' | 'tavya-share';
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
];

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
