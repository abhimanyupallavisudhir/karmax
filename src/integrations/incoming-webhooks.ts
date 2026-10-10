import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { organizationScope } from '../autonomy/vault-keys.js';
import { validEventType } from '../domain/project-events.js';
import { newId } from '../util/id.js';

/**
 * Incoming webhooks: a project's URL that any outside service can POST to
 * (wiki planned/external-connectors-and-automations). Each delivery becomes one
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
}

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

  /** Create a hook; the secret is returned once and never again. */
  async create(input: { organizationId: string; projectId: string; name: string; type?: string; createdBy?: string }):
    Promise<{ hook: IncomingWebhook; secret: string }> {
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new WebhookConfigError('name the webhook');
    const type = input.type?.trim() || defaultWebhookType(name);
    if (!validEventType(type)) throw new WebhookConfigError('event type must be dotted words, e.g. "sentry.alert"');
    const hook: IncomingWebhook = {
      id: newId('hook'), organizationId: input.organizationId, projectId: input.projectId, name, type,
      createdAt: Date.now(), ...(input.createdBy ? { createdBy: input.createdBy } : {}), deliveries: 0,
    };
    const secret = newSecret();
    await this.broker.registerHandle(secretHandle(hook), secret, organizationScope(hook.organizationId));
    await this.store.kvSet(`${KEY_PREFIX}${hook.id}`, JSON.stringify(hook));
    return { hook, secret };
  }

  async update(id: string, patch: { name?: string; type?: string }): Promise<IncomingWebhook> {
    const hook = await this.require(id);
    const next = { ...hook };
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
    const secret = newSecret();
    await this.broker.registerHandle(secretHandle(hook), secret, organizationScope(hook.organizationId));
    return { hook, secret };
  }

  async delete(id: string): Promise<void> {
    const hook = await this.get(id);
    if (!hook) return;
    await this.store.kvDelete(`${KEY_PREFIX}${id}`);
    if (this.broker.hasHandle(secretHandle(hook))) await this.broker.deleteHandle(secretHandle(hook));
  }

  /** Is this delivery from someone holding the hook's secret? */
  verify(hook: IncomingWebhook, raw: Buffer, headers: Record<string, string | string[] | undefined>, query: URLSearchParams): boolean {
    const handle = secretHandle(hook);
    if (!this.broker.hasHandle(handle)) return false;
    const secret = this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
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

export class WebhookConfigError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function newSecret(): string {
  return `tvh_${crypto.randomBytes(24).toString('base64url')}`;
}
