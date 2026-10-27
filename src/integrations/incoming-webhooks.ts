import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { organizationScope } from '../autonomy/vault-keys.js';
import { validEventType } from '../domain/project-events.js';
import { newId } from '../util/id.js';
import { CHAT_ADAPTERS, CHAT_CREDENTIALS, ChatPlatformError, type ChatBotIdentity, type ChatCredentials, type ChatDelivery,
  type ChatInbound, type ChatPlatform } from './chat-platforms.js';

/**
 * Incoming webhooks: a project's URL that any outside service can POST to
 * (wiki features/events-and-automations). Each delivery becomes one
 * project event of the hook's `type`; an armed task's event trigger reacts.
 *
 * A hook is project configuration, so it lives in the store (kv, one row per
 * hook, found by id from the public URL) and its secret in the vault under the
 * project's organization. A delivery is authentic when it is signed with the
 * secret (HMAC-SHA256 of the raw body: GitHub's `X-Hub-Signature-256` form, or
 * any `*-Signature*` header holding `sha256=<hex>`, hex or base64) or presents
 * the secret itself (`Authorization: Bearer …` or `?token=…`, for senders that
 * can only be given a URL). Both prove possession of the same secret over TLS;
 * a signature additionally keeps the secret off the wire.
 *
 * A chat bot (`kind`: telegram, slack, discord, whatsapp) is the same kind of
 * hook: its URL is where the platform delivers, the platform's own credentials
 * are its vault secret, and each message that mentions the bot is one
 * `chat.mention` event (src/integrations/chat-platforms.ts).
 *
 * A bot takes requests only from the people its project allows (`allowed`, or
 * `anyone`): a run started by a mention acts with the project's authority, and
 * most bots can be messaged by anyone who finds them. Someone else is listed in
 * `asking`, so the project can let them in with one click.
 */

export interface IncomingWebhook {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  /** The project event type each delivery becomes, e.g. `sentry.alert`. */
  type: string;
  createdAt: number;
  createdBy?: string;
  deliveries: number;
  lastDeliveryAt?: number;
  /** The last refused delivery's reason, cleared by the next accepted one. */
  lastError?: { at: number; message: string };
  /** A chat bot's platform; absent for a plain webhook. */
  kind?: ChatPlatform;
  /** The bot's own name and id on its platform. */
  bot?: ChatBotIdentity;
  /** A chat bot's people whose messages it takes (platform user ids). */
  allowed?: ChatPerson[];
  /** Takes messages from anyone who can reach the bot. */
  anyone?: boolean;
  /** Recent senders it refused, newest first, for the project to allow. */
  asking?: ChatPerson[];
}

/** A person on a chat platform. */
export interface ChatPerson { id: string; name?: string; text?: string; at?: number }

const MAX_ASKING = 20;

const KEY_PREFIX = 'incoming-webhook:';
export const INCOMING_WEBHOOK_SECRET_PREFIX = 'incoming-webhook:';
const secretHandle = (hook: Pick<IncomingWebhook, 'organizationId' | 'id'>) =>
  `${INCOMING_WEBHOOK_SECRET_PREFIX}${hook.organizationId}:${hook.id}`;

export function defaultWebhookType(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `webhook.${slug || 'received'}`;
}

/** Collapse a sender's redeliveries: its own delivery id when it sends one,
 *  otherwise the body itself. */
export function webhookDeliveryKey(headers: Record<string, string | string[] | undefined>, raw: Buffer): string {
  for (const name of ['idempotency-key', 'webhook-id', 'x-github-delivery', 'x-delivery-id', 'x-request-id']) {
    const value = headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (first?.trim()) return first.trim().slice(0, 300);
  }
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Does any signature-looking header carry an HMAC-SHA256 of `raw` under `secret`? */
export function signatureMatches(secret: string, raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const digest = crypto.createHmac('sha256', secret).update(raw).digest();
  for (const [name, value] of Object.entries(headers)) {
    if (!/signature/i.test(name)) continue;
    for (const candidate of (Array.isArray(value) ? value : [value ?? ''])) {
      for (const part of candidate.split(/[ ,]+/)) {
        const token = part.replace(/^(sha256|v1)=/i, '').trim();
        if (!token) continue;
        if (/^[0-9a-f]{64}$/i.test(token) && equal(Buffer.from(token, 'hex'), digest)) return true;
        const base64 = Buffer.from(token, 'base64');
        if (base64.length === 32 && equal(base64, digest)) return true;
      }
    }
  }
  return false;
}

export function tokenMatches(secret: string, presented: string | undefined): boolean {
  if (!presented) return false;
  return equal(crypto.createHash('sha256').update(presented).digest(), crypto.createHash('sha256').update(secret).digest());
}

export class IncomingWebhooks {
  constructor(private store: Store, private broker: CredentialBroker) {}

  async get(id: string): Promise<IncomingWebhook | undefined> {
    const raw = await this.store.kvGet(`${KEY_PREFIX}${id}`);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as IncomingWebhook; } catch { return undefined; }
  }

  async list(projectId: string): Promise<IncomingWebhook[]> {
    const hooks: IncomingWebhook[] = [];
    for (const entry of await this.store.kvEntries(KEY_PREFIX)) {
      try {
        const hook = JSON.parse(entry.value) as IncomingWebhook;
        if (hook.projectId === projectId) hooks.push(hook);
      } catch { /* a malformed row is not a hook */ }
    }
    return hooks.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Create a hook; its secret is returned once and never again. A chat bot is
   *  connected to its platform here (`url` is where the platform will deliver):
   *  a refused connection creates nothing. */
  async create(input: { organizationId: string; projectId: string; name: string; type?: string; createdBy?: string;
    kind?: ChatPlatform; credentials?: ChatCredentials; url?: (id: string) => string; fetcher?: typeof fetch }):
    Promise<{ hook: IncomingWebhook; secret?: string; verifyToken?: string }> {
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new WebhookConfigError('name the webhook');
    const type = input.kind ? 'chat.mention' : input.type?.trim() || defaultWebhookType(name);
    if (!validEventType(type)) throw new WebhookConfigError('event type must be dotted words, e.g. "sentry.alert"');
    const hook: IncomingWebhook = {
      id: newId('hook'), organizationId: input.organizationId, projectId: input.projectId, name, type,
      createdAt: Date.now(), ...(input.createdBy ? { createdBy: input.createdBy } : {}), deliveries: 0,
      ...(input.kind ? { kind: input.kind, allowed: [], anyone: false } : {}),
    };
    if (!input.kind) {
      const secret = newSecret();
      await this.broker.registerHandle(secretHandle(hook), secret, organizationScope(hook.organizationId));
      await this.store.kvSet(`${KEY_PREFIX}${hook.id}`, JSON.stringify(hook));
      return { hook, secret };
    }
    const credentials: ChatCredentials = {};
    for (const field of CHAT_CREDENTIALS[input.kind]) {
      const value = String(input.credentials?.[field.name] ?? '').trim();
      if (!value) throw new WebhookConfigError(`${field.label} is required`);
      credentials[field.name] = value;
    }
    if (!input.url) throw new WebhookConfigError('a public URL is needed to connect a chat bot');
    let connected: Awaited<ReturnType<(typeof CHAT_ADAPTERS)[ChatPlatform]['connect']>>;
    // The platform may check the URL at once (Discord sends a signed PING), so
    // the hook answers before the platform is told about it.
    await this.store.kvSet(`${KEY_PREFIX}${hook.id}`, JSON.stringify(hook));
    await this.broker.registerHandle(secretHandle(hook), JSON.stringify(credentials), organizationScope(hook.organizationId));
    try {
      connected = await CHAT_ADAPTERS[input.kind].connect(credentials, input.url(hook.id), input.fetcher ?? fetch);
    } catch (error) {
      await this.delete(hook.id);
      throw new WebhookConfigError(error instanceof ChatPlatformError ? error.message : `could not connect: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stored = { ...credentials, ...connected.generated };
    await this.broker.registerHandle(secretHandle(hook), JSON.stringify(stored), organizationScope(hook.organizationId));
    const saved: IncomingWebhook = { ...hook, bot: connected.identity };
    await this.store.kvSet(`${KEY_PREFIX}${hook.id}`, JSON.stringify(saved));
    return { hook: saved, ...(connected.generated?.verifyToken ? { verifyToken: connected.generated.verifyToken } : {}) };
  }

  async update(id: string, patch: WebhookPatch): Promise<IncomingWebhook> {
    const hook = await this.require(id);
    const next = { ...hook };
    if ((patch.allowed !== undefined || patch.anyone !== undefined || patch.dismiss !== undefined) && !hook.kind)
      throw new WebhookConfigError('only a chat bot has people');
    if (patch.allowed !== undefined) {
      if (!Array.isArray(patch.allowed)) throw new WebhookConfigError('allowed is a list of {id, name?}');
      const people = new Map<string, ChatPerson>();
      for (const person of patch.allowed) {
        const personId = String(person?.id ?? '').trim().slice(0, 100);
        if (!personId) throw new WebhookConfigError('each allowed person needs an id');
        const name = typeof person.name === 'string' && person.name.trim() ? person.name.trim().slice(0, 100) : undefined;
        people.set(personId, { id: personId, ...(name ? { name } : {}) });
      }
      next.allowed = [...people.values()];
    }
    if (patch.anyone !== undefined) next.anyone = patch.anyone === true;
    const gone = new Set([...(next.allowed ?? []).map((person) => person.id), ...(patch.dismiss ?? []).map(String)]);
    if (hook.kind) next.asking = (next.asking ?? []).filter((person) => !gone.has(person.id));
    if (patch.name !== undefined) {
      next.name = patch.name.trim().slice(0, 100);
      if (!next.name) throw new WebhookConfigError('name the webhook');
    }
    if (patch.type !== undefined) {
      if (!validEventType(patch.type.trim())) throw new WebhookConfigError('event type must be dotted words, e.g. "sentry.alert"');
      next.type = patch.type.trim();
    }
    await this.store.kvSet(`${KEY_PREFIX}${id}`, JSON.stringify(next));
    return next;
  }

  async rotate(id: string): Promise<{ hook: IncomingWebhook; secret: string }> {
    const hook = await this.require(id);
    if (hook.kind) throw new WebhookConfigError('a chat bot keeps its platform credentials; connect it again to change them');
    const secret = newSecret();
    await this.broker.registerHandle(secretHandle(hook), secret, organizationScope(hook.organizationId));
    return { hook, secret };
  }

  async delete(id: string): Promise<void> {
    const hook = await this.get(id);
    if (!hook) return;
    await this.store.kvDelete(`${KEY_PREFIX}${id}`);
    if (await this.broker.hasHandle(secretHandle(hook))) await this.broker.deleteHandle(secretHandle(hook));
  }

  /** May this person ask the bot for something? */
  admits(hook: IncomingWebhook, personId: string): boolean {
    return hook.anyone === true || !!personId && (hook.allowed ?? []).some((person) => person.id === personId);
  }

  /** Someone the bot refused, listed for the project to allow. */
  async noteAsking(id: string, person: ChatPerson): Promise<void> {
    const hook = await this.get(id);
    if (!hook) return;
    const entry: ChatPerson = { id: person.id, ...(person.name ? { name: person.name.slice(0, 100) } : {}),
      ...(person.text ? { text: person.text.slice(0, 200) } : {}), at: Date.now() };
    const asking = [entry, ...(hook.asking ?? []).filter((other) => other.id !== person.id)].slice(0, MAX_ASKING);
    await this.store.kvSet(`${KEY_PREFIX}${id}`, JSON.stringify({ ...hook, asking }));
  }

  /** A chat bot's delivery, read by its platform's adapter. */
  async receiveChat(hook: IncomingWebhook, delivery: ChatDelivery): Promise<ChatInbound | 'refused'> {
    const credentials = await this.credentials(hook);
    return hook.kind && credentials ? CHAT_ADAPTERS[hook.kind].receive(credentials, hook.bot ?? {}, delivery) : 'refused';
  }

  /** Post in a chat bot's channel (a thread's reply when `thread` is set). */
  async reply(hook: IncomingWebhook, to: { channel: string; thread?: string }, text: string, fetcher: typeof fetch = fetch): Promise<{ messageId?: string }> {
    const credentials = await this.credentials(hook);
    if (!hook.kind || !credentials) throw new WebhookConfigError('not a connected chat bot');
    return CHAT_ADAPTERS[hook.kind].reply(credentials, to, text, fetcher);
  }

  private async credentials(hook: IncomingWebhook): Promise<ChatCredentials | undefined> {
    const handle = secretHandle(hook);
    if (!(await this.broker.hasHandle(handle))) return undefined;
    try { return JSON.parse(await this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) as ChatCredentials; } catch { return undefined; }
  }

  /** Is this delivery from someone holding the hook's secret? */
  async verify(hook: IncomingWebhook, raw: Buffer, headers: Record<string, string | string[] | undefined>, query: URLSearchParams): Promise<boolean> {
    const handle = secretHandle(hook);
    if (hook.kind || !(await this.broker.hasHandle(handle))) return false;
    const secret = await this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
    const auth = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return signatureMatches(secret, raw, headers) || tokenMatches(secret, bearer) || tokenMatches(secret, query.get('token') ?? undefined);
  }

  /** Delivery health shown with the hook. */
  async noteDelivery(id: string, error?: string): Promise<void> {
    const hook = await this.get(id);
    if (!hook) return;
    const next: IncomingWebhook = error
      ? { ...hook, lastError: { at: Date.now(), message: error.slice(0, 300) } }
      : { ...hook, deliveries: hook.deliveries + 1, lastDeliveryAt: Date.now() };
    if (!error) delete next.lastError;
    await this.store.kvSet(`${KEY_PREFIX}${id}`, JSON.stringify(next));
  }

  private async require(id: string): Promise<IncomingWebhook> {
    const hook = await this.get(id);
    if (!hook) throw new WebhookConfigError('no such webhook', 404);
    return hook;
  }
}

/** A change to a hook; `allowed`, `anyone` and `dismiss` (ids off `asking`) are a chat bot's. */
export interface WebhookPatch { name?: string; type?: string; allowed?: Array<{ id: string; name?: string }>; anyone?: boolean; dismiss?: string[] }

export class WebhookConfigError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function newSecret(): string {
  return `tvh_${crypto.randomBytes(24).toString('base64url')}`;
}
