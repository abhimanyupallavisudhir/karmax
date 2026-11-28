import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import { organizationPath, taskPath } from '../domain/console-links.js';
import type { InboxItem, NativePushDevice } from '../domain/types.js';
import type { NativePush } from './native-push.js';
import type { Store } from '../store/db.js';
import type { DeliveryAdapter, DeliveryEnvelope } from './delivery.js';
import { generateVapidKeys, sendPush, vapidKeyPair, type PushUrgency, type VapidKeyPair } from './web-push.js';

/** The installation's VAPID private key (wiki features/push-and-voice). */
export const VAPID_KEY_HANDLE = 'web-push:vapid-key';

/**
 * The installation's VAPID key pair, made once and kept in the vault under the
 * installation's scope. Every browser subscription is bound to its public key,
 * so it must never change: a concurrent first use keeps whichever was written
 * first (`ensureHandle`). Losing it (a vault restored without it) silently
 * orphans every subscription until each device turns push on again.
 */
export function vaultVapidKeys(broker: CredentialBroker): () => Promise<VapidKeyPair> {
  let loading: Promise<VapidKeyPair> | undefined;
  return () => loading ??= (async () => {
    if (!await broker.hasHandle(VAPID_KEY_HANDLE))
      await broker.ensureHandle(VAPID_KEY_HANDLE, generateVapidKeys().privateKey, INSTALLATION_SCOPE);
    return vapidKeyPair(await broker.resolve(VAPID_KEY_HANDLE, { caps: [`use-credential:${VAPID_KEY_HANDLE}`] }));
  })().catch((error) => { loading = undefined; throw error; });
}

/** What a device shows: short, and opening where the console's inbox row would. */
export interface PushMessage { title: string; body: string; url: string; tag: string; urgency: InboxItem['urgency'] }

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The inbox row's own words (web/app.js inboxRowLabel), for a device. */
function label(item: InboxItem, status?: string, ask?: string): string {
  if (ask) return ask;
  const subject = item.subject as Record<string, any> | undefined;
  if (subject?.kind === 'service-limit') return subject.level === 'failed' ? `Can’t read ${subject.serviceName} usage`
    : `${subject.serviceName} at ${Math.floor((subject.used / subject.limit) * 100)}% of its limit${subject.level === 95 ? ' — upgrade now' : ''}`;
  if (subject?.kind === 'compute') {
    const n = Number(subject.computers || 0), computers = `${n} parked computer${n === 1 ? '' : 's'}`;
    if (subject.stage === 'hibernated') return `Out of credits — ${computers} hibernated`;
    if (subject.hibernateAt) return `Out of credits — ${computers} hibernate ${day(subject.hibernateAt)}`;
    return subject.trial ? 'Free trial over — choose a plan' : 'Out of credits — add more';
  }
  if (subject?.kind === 'storage') return subject.stage === 'deleted' ? 'Stored data deleted to fit the limit'
    : `Over the storage limit — free space by ${day(subject.deleteAt)}`;
  if (subject?.kind === 'credential') {
    if (subject.reason === 'signed-out') return 'Signed out — sign in again';
    const days = Math.max(0, Math.ceil((subject.expiresAt - Date.now()) / 86_400_000));
    return `Sign-in expires ${days ? `in ${days} day${days === 1 ? '' : 's'}` : 'today'} — renew it`;
  }
  return item.kind === 'update' ? (status || 'update') : item.kind.replaceAll('-', ' ');
}

function title(item: InboxItem, task: DeliveryEnvelope['task'], siteName: string): string {
  const subject = item.subject as Record<string, any> | undefined;
  if (subject?.kind === 'credential') return `${subject.provider}:${subject.account}`;
  if (subject?.kind === 'storage') return 'Storage';
  if (subject?.kind === 'compute') return 'Compute';
  if (subject?.kind === 'service-limit') return String(subject.serviceName);
  return task?.title || siteName;
}

/** Where it opens (web/app.js inboxItemRoute): a same-origin path. */
function route(item: InboxItem, task: DeliveryEnvelope['task'],
  organization?: { name: string; slug?: string }, project?: { name: string }): string {
  const kind = (item.subject as { kind?: string } | undefined)?.kind;
  if (kind === 'service-limit') return '/installation#installation-limits';
  const org = organization ? organizationPath(organization) : '';
  const settings = { credential: 'settings-agents', storage: 'settings-storage', compute: 'settings-plan' }[kind ?? ''];
  if (settings) return org ? `${org}/settings#${settings}` : '/inbox';
  if (!task || !project || !org) return '/inbox';
  return `${taskPath(task, project, organization)}${
    item.kind === 'approval-requested' ? '/checkin' : ''}`;
}

export function pushMessage(envelope: DeliveryEnvelope, context: {
  organization?: { name: string; slug?: string }; project?: { name: string }; siteName: string;
}): PushMessage {
  const { inbox, task } = envelope;
  const number = task?.num != null ? `#${task.num} · ` : '';
  return {
    title: clip(title(inbox, task, context.siteName), 120),
    body: clip(`${number}${label(inbox, task?.status, envelope.ask)}`, 240),
    url: route(inbox, task, context.organization, context.project),
    // The console's own popup for this ask has the same tag, so one replaces the other.
    tag: inbox.id,
    urgency: inbox.urgency,
  };
}

const PUSH_URGENCY: Record<InboxItem['urgency'], PushUrgency> = { low: 'low', normal: 'normal', high: 'high', critical: 'high' };
/** An ask a day old is still in the inbox; a device that was off that long need not ring for it. */
const PUSH_TTL_SECONDS = 24 * 3600;

/**
 * The inbox's `push` channel: one message to each of the person's devices —
 * encrypted Web Push to a browser, FCM to a phone app (`native-push.ts`).
 * A device its push service no longer knows (404/410, FCM UNREGISTERED) is
 * forgotten. The delivery is retried only when no device took it and one
 * might later (429, 5xx, a network error) — retrying after a partial success
 * would ring the devices that already showed it. Phones are skipped while the
 * installation has no Firebase account; they stay listed for when it does.
 */
export class PushDeliveryAdapter implements DeliveryAdapter {
  constructor(private options: {
    store: Store;
    keys: () => Promise<VapidKeyPair>;
    siteName: () => Promise<string>;
    /** The console's origin; an https one names this installation to push services (VAPID `sub`). */
    publicUrl?: string;
    /** The phone apps' sender; without one, phones are skipped. */
    native?: NativePush;
    fetcher?: typeof fetch;
    log?: (line: string) => void;
  }) {}

  /** RFC 8292 §2.1: a contact for the push service's operator. */
  private subject(): string {
    try {
      const url = new URL(this.options.publicUrl ?? '');
      if (url.protocol === 'https:') return url.origin;
      return `mailto:webpush@${url.hostname || 'localhost'}`;
    } catch { return 'mailto:webpush@localhost'; }
  }

  async deliver(envelope: DeliveryEnvelope): Promise<void> {
    const { store, native } = this.options;
    const all = await store.listPushSubscriptions(envelope.inbox.userId);
    const phones = all.filter((device): device is NativePushDevice => device.kind === 'fcm');
    const devices = [...all.filter((device) => device.kind === 'web'), ...(phones.length && native && await native.available() ? phones : [])];
    if (!devices.length) return;
    const organization = await store.getOrganization(envelope.inbox.organizationId);
    const project = envelope.task?.projectId ? await store.getProject(envelope.task.projectId) : undefined;
    const message = pushMessage(envelope, { organization, project, siteName: await this.options.siteName() });
    const payload = JSON.stringify(message);
    const vapid = devices.some((device) => device.kind === 'web') ? await this.options.keys() : undefined;
    // A Topic lets a push service replace a message it still holds for an offline device.
    const topic = crypto.createHash('sha256').update(envelope.inbox.id).digest('base64url').slice(0, 32);
    let delivered = 0;
    const retryable: string[] = [];
    await Promise.all(devices.map(async (device) => {
      try {
        if (device.kind === 'fcm') {
          const { outcome, detail } = await native!.send(device.token, message, PUSH_TTL_SECONDS);
          if (outcome === 'sent') { delivered++; await store.markPushed(device.id); }
          else if (outcome === 'gone') await store.expirePushSubscription(device.id);
          else if (outcome === 'retry') retryable.push(`${device.id}: ${detail}`);
          return;
        }
        const status = await sendPush(device, payload, { vapid: vapid!, subject: this.subject(), urgency: PUSH_URGENCY[envelope.inbox.urgency],
          ttlSeconds: PUSH_TTL_SECONDS, topic, fetcher: this.options.fetcher });
        if (status >= 200 && status < 300) { delivered++; await store.markPushed(device.id); return; }
        if (status === 404 || status === 410) { await store.expirePushSubscription(device.id); return; }
        if (status === 429 || status >= 500) { retryable.push(`${device.id}: ${status}`); return; }
        // 400/403/413: this request will not succeed by repeating it (a key mismatch after a lost VAPID key, a malformed subscription).
        this.options.log?.(`push to ${device.id} refused with ${status}`);
      } catch (error) {
        retryable.push(`${device.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    if (!delivered && retryable.length) throw new Error(`push delivery failed: ${retryable.join('; ')}`);
  }
}
