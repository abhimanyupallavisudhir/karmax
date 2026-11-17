import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { ChatPlatform } from './chat-platforms.js';

/**
 * Chat accounts linked to people (wiki planned/assistant §3,
 * features/events-and-automations "Who may ask").
 *
 * A chat bot cannot tell which tavya account is asking. Someone it does not
 * know is sent a link (`/link/chat?t=…`); signed in, they confirm it, and from
 * then on the runs their messages start act as them. A link belongs to one bot
 * (hook), never to the platform: one organization's bot cannot speak for
 * anyone in another's.
 *
 * The link token is bound to (hook, platform user, display name), single-use,
 * valid for {@link CHAT_LINK_TTL_MS}, and stored only as its SHA-256 digest
 * (like app grants and device codes, src/auth/). Each person has at most one
 * open offer per bot: a new one replaces it.
 *
 * kv rows (each carries projectId and organizationId, so deleting a project or
 * an organization deletes them, src/store/db.ts):
 * - `chat-link:<hook>:<platform user>` — the link
 * - `chat-link-token:<digest>` — an open offer
 * - `chat-link-offer:<hook>:<platform user>` — that person's open offer
 */

export const CHAT_LINK_TTL_MS = 15 * 60_000;

export interface ChatLink {
  id: string;
  hookId: string;
  projectId: string;
  organizationId: string;
  platform?: ChatPlatform;
  /** The person's id on the chat platform. */
  platformUserId: string;
  /** Their name there when the link was made. */
  platformName?: string;
  /** The tavya person the chat account acts as. */
  userId: string;
  createdAt: number;
}

/** What following a link token would link. */
export interface ChatLinkOffer {
  hookId: string;
  projectId: string;
  organizationId: string;
  platform?: ChatPlatform;
  platformUserId: string;
  platformName?: string;
  expiresAt: number;
}

interface OpenOffer { digest: string; expiresAt: number; projectId: string; organizationId: string }

const linkKey = (hookId: string, platformUserId: string) => `chat-link:${hookId}:${platformUserId}`;
const tokenKey = (digest: string) => `chat-link-token:${digest}`;
const offerKey = (hookId: string, platformUserId: string) => `chat-link-offer:${hookId}:${platformUserId}`;
const digestOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class ChatLinkError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class ChatLinks {
  constructor(private store: Store, private now: () => number = Date.now) {}

  /** The tavya person a bot's chat user is linked to. */
  async find(hookId: string, platformUserId: string): Promise<ChatLink | undefined> {
    return parse<ChatLink>(await this.store.kvGet(linkKey(hookId, platformUserId)));
  }

  /** A fresh link token for someone the bot does not know; their older one stops working. */
  async offer(hook: { id: string; projectId: string; organizationId: string; kind?: ChatPlatform },
    person: { id: string; name?: string }): Promise<{ token: string; expiresAt: number }> {
    const token = `tvl_${crypto.randomBytes(24).toString('base64url')}`;
    const digest = digestOf(token);
    const expiresAt = this.now() + CHAT_LINK_TTL_MS;
    const offer: ChatLinkOffer = { hookId: hook.id, projectId: hook.projectId, organizationId: hook.organizationId,
      ...(hook.kind ? { platform: hook.kind } : {}), platformUserId: person.id,
      ...(person.name ? { platformName: person.name.slice(0, 100) } : {}), expiresAt };
    const previous = parse<OpenOffer>(await this.store.kvGet(offerKey(hook.id, person.id)));
    if (previous) await this.store.kvDelete(tokenKey(previous.digest));
    await this.store.kvSet(tokenKey(digest), JSON.stringify(offer));
    await this.store.kvSet(offerKey(hook.id, person.id), JSON.stringify({ digest, expiresAt,
      projectId: hook.projectId, organizationId: hook.organizationId } satisfies OpenOffer));
    return { token, expiresAt };
  }

  /** Does this person hold a link token that still works? */
  async offered(hookId: string, platformUserId: string): Promise<boolean> {
    const open = parse<OpenOffer>(await this.store.kvGet(offerKey(hookId, platformUserId)));
    return !!open && open.expiresAt > this.now();
  }

  /** What a token would link, while it works. */
  async pending(token: string): Promise<ChatLinkOffer | undefined> {
    if (!token) return undefined;
    const offer = parse<ChatLinkOffer>(await this.store.kvGet(tokenKey(digestOf(token))));
    return offer && offer.expiresAt > this.now() ? offer : undefined;
  }

  /** Link the token's chat user to `userId`. The token works once. A chat user
   *  linked to someone else before is linked to `userId` instead. */
  async redeem(token: string, userId: string): Promise<ChatLink> {
    const key = tokenKey(digestOf(token || ''));
    const raw = await this.store.kvGet(key);
    const offer = parse<ChatLinkOffer>(raw);
    // Taken exactly once, even by two tabs at the same moment.
    if (!raw || !offer || !(await this.store.kvCompareAndSet(key, raw, undefined)))
      throw new ChatLinkError('This link was used already or is not valid. Message the bot again for a new one.', 404);
    if (offer.expiresAt <= this.now()) throw new ChatLinkError('This link has expired. Message the bot again for a new one.', 410);
    const open = parse<OpenOffer>(await this.store.kvGet(offerKey(offer.hookId, offer.platformUserId)));
    if (open?.digest === digestOf(token)) await this.store.kvDelete(offerKey(offer.hookId, offer.platformUserId));
    const link: ChatLink = { id: newId('clk'), hookId: offer.hookId, projectId: offer.projectId, organizationId: offer.organizationId,
      ...(offer.platform ? { platform: offer.platform } : {}), platformUserId: offer.platformUserId,
      ...(offer.platformName ? { platformName: offer.platformName } : {}), userId, createdAt: this.now() };
    await this.store.kvSet(linkKey(link.hookId, link.platformUserId), JSON.stringify(link));
    return link;
  }

  /** Everyone linked through one bot. */
  async forHook(hookId: string): Promise<ChatLink[]> {
    return rows<ChatLink>(await this.store.kvEntries(`chat-link:${hookId}:`)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A person's links, on every bot. */
  async forUser(userId: string): Promise<ChatLink[]> {
    return rows<ChatLink>(await this.store.kvEntries('chat-link:')).filter((link) => link.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Remove a link (unless the chat user was linked anew since). */
  async remove(link: ChatLink): Promise<void> {
    const current = await this.find(link.hookId, link.platformUserId);
    if (current?.id === link.id) await this.store.kvDelete(linkKey(link.hookId, link.platformUserId));
  }

  /** A deleted bot takes its links and open offers with it. */
  async removeHook(hookId: string): Promise<void> {
    for (const { key } of await this.store.kvEntries(`chat-link:${hookId}:`)) await this.store.kvDelete(key);
    for (const { key, value } of await this.store.kvEntries(`chat-link-offer:${hookId}:`)) {
      const open = parse<OpenOffer>(value);
      if (open) await this.store.kvDelete(tokenKey(open.digest));
      await this.store.kvDelete(key);
    }
  }

  /** A closed account's links. */
  async removeUser(userId: string): Promise<void> {
    for (const link of await this.forUser(userId)) await this.store.kvDelete(linkKey(link.hookId, link.platformUserId));
  }
}

function parse<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function rows<T>(entries: Array<{ value: string }>): T[] {
  return entries.map((entry) => parse<T>(entry.value)).filter((value): value is T => !!value);
}
