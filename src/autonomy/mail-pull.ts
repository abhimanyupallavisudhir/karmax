import { AsyncInterval } from '../util/async-interval.js';
import { MailboxConfig, defaultMailboxRegistry } from './mailbox.js';
import { extractMimeText, cleanAddress, htmlToText } from './agent-mail.js';

/** A fetched message with the fields ingest needs (recipient/sender resolved). */
export interface PulledMessage { to: string; from: string; subject?: string; text: string; sourceId?: string }

/**
 * Pull-based mail intake (PLAN-passwords.md §8). Unlike the webhook (push) path,
 * karmax reaches OUT to the mail service and fetches — so it works on a
 * locally-hosted karmax behind NAT, with no public URL. Two backends:
 *
 *   • imap      — poll the organization's configured mailbox (Gmail
 *                 app-password, Fastmail, …).
 *   • agentmail — pull the organization's existing AgentMail inbox via REST.
 *
 * Both funnel into the SAME per-org store via `AgentMail.ingest` (which routes
 * by the recipient address through `ownerOf`), so tenancy, code/link extraction,
 * and reads are identical to the push path.
 */

export interface PullStore {
  kvGet(k: string): (string | undefined) | Promise<string | undefined>;
  kvSet(k: string, v: string): (void) | Promise<void>;
  appendAudit?(e: { principalId: string; action: string; detail?: Record<string, unknown> }): (number) | Promise<number>;
}

export interface PullDeps {
  store: PullStore;
  /** Organization whose provider account is being polled. */
  organizationId?: string;
  /** Resolve a vault handle to its secret (IMAP password / AgentMail key). */
  resolveSecret(handle: string): string | undefined;
  /** Inject a fetched message into the per-org inbox (routes by recipient). */
  ingest(msg: PulledMessage): { delivered: boolean } | Promise<{ delivered: boolean }>;
  /** Override the network clients in tests. */
  fetchFn?: typeof fetch;
  openImap?: (opts: ImapOpts) => Promise<ImapConn>;
}

export interface Puller {
  /** Fetch new mail and ingest it; returns how many messages were delivered. */
  poll(): Promise<number>;
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

export interface ImapOpts { host: string; port: number; secure: boolean; user: string; pass: string }
export interface ImapMessage { uid: number; source: string }
export interface ImapConn {
  fetchSince(lastUid: number): Promise<ImapMessage[]>;
  close(): Promise<void>;
}

export class ImapPuller implements Puller {
  constructor(private config: MailboxConfig, private deps: PullDeps) {}
  async poll(): Promise<number> {
    const imap = this.config.imap;
    const passHandle = this.config.apiKeyHandle;
    if (!passHandle) return 0;
    const pass = this.deps.resolveSecret(passHandle);
    if (!imap || !pass) return 0;
    const open = this.deps.openImap ?? defaultOpenImap;
    const conn = await open({ host: imap.host, port: imap.port, secure: imap.secure, user: imap.user, pass });
    let delivered = 0;
    const uidKey = `agent-mail:imap-uid:${this.deps.organizationId ?? 'legacy'}`;
    let maxUid = Number((await this.deps.store.kvGet(uidKey)) ?? 0);
    try {
      const messages = await conn.fetchSince(maxUid);
      for (const m of messages.sort((a, b) => a.uid - b.uid)) {
        const to = firstDeliveredTo(m.source) ?? firstHeader(m.source, 'to');
        const from = firstHeader(m.source, 'from');
        if (to) {
          const { delivered: ok } = (await this.deps.ingest({
            to: cleanAddress(to), from: cleanAddress(from ?? 'unknown@unknown'),
            subject: firstHeader(m.source, 'subject'), text: extractMimeText(m.source),
          }));
          if (ok) delivered++;
        }
        if (m.uid > maxUid) maxUid = m.uid;
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
    (await this.deps.store.kvSet(uidKey, String(maxUid)));
    return delivered;
  }
}

/** The real IMAP client (imapflow), loaded lazily so the package is optional. */
async function defaultOpenImap(opts: ImapOpts): Promise<ImapConn> {
  let ImapFlow: any;
  try {
    ({ ImapFlow } = await import('imapflow'));
  } catch {
    throw new Error('IMAP support needs the "imapflow" package — run `npm install imapflow`.');
  }
  const client = new ImapFlow({ host: opts.host, port: opts.port, secure: opts.secure, auth: { user: opts.user, pass: opts.pass }, logger: false });
  await client.connect();
  return {
    async fetchSince(lastUid: number): Promise<ImapMessage[]> {
      const out: ImapMessage[] = [];
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch({ uid: `${lastUid + 1}:*` }, { uid: true, source: true })) {
          if (msg.uid > lastUid && msg.source) out.push({ uid: msg.uid, source: msg.source.toString('utf8') });
        }
      } finally {
        lock.release();
      }
      return out;
    },
    async close() {
      await client.logout().catch(() => client.close?.());
    },
  };
}

function firstHeader(raw: string, name: string): string | undefined {
  const headerBlock = raw.slice(0, raw.search(/\r?\n\r?\n/) < 0 ? raw.length : raw.search(/\r?\n\r?\n/));
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im');
  return re.exec(headerBlock)?.[1]?.replace(/\r?\n[ \t]/g, ' ').trim();
}
function firstDeliveredTo(raw: string): string | undefined {
  return firstHeader(raw, 'delivered-to') ?? firstHeader(raw, 'x-original-to');
}

// ── AgentMail (agentmail.to REST) ─────────────────────────────────────────────

const AGENTMAIL_BASE = process.env.KARMAX_AGENTMAIL_BASE || 'https://api.agentmail.to/v0';
export async function verifyAgentMailInbox(key: string, address: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`${AGENTMAIL_BASE}/inboxes/${encodeURIComponent(address)}`, {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('AgentMail key cannot access this inbox');
  const inbox = await response.json() as { inbox_id?: string };
  if (cleanAddress(inbox.inbox_id ?? '') !== cleanAddress(address)) throw new Error('AgentMail returned a different inbox');
}

const amCursorKey = (address: string) => `agent-mail:am-cursor:${address}`;

export class AgentMailPuller implements Puller {
  constructor(private config: MailboxConfig, private deps: PullDeps) {}
  private key(): string | undefined {
    return this.config.apiKeyHandle ? this.deps.resolveSecret(this.config.apiKeyHandle) : undefined;
  }
  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const key = this.key();
    const doFetch = this.deps.fetchFn ?? fetch;
    const res = await doFetch(`${AGENTMAIL_BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (res.status === 404) return undefined;
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const message = typeof body === 'object'
        ? (body as any)?.message ?? (body as any)?.error?.message ?? (body as any)?.error ?? (body as any)?.detail
        : body;
      throw new Error(typeof message === 'string' && message ? message : `AgentMail HTTP ${res.status}`);
    }
    return body;
  }

  async poll(): Promise<number> {
    const address = this.config.agentmailAddress;
    if (!this.key() || !address) return 0;
    let delivered = 0;
    const cursor = (await this.deps.store.kvGet(amCursorKey(address)));
    const list = await this.api(`/inboxes/${encodeURIComponent(address)}/messages?limit=50&ascending=true${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
    if (!list) throw new Error(`AgentMail inbox ${address} was not found`);
    const messages: any[] = list?.messages ?? list?.data ?? (Array.isArray(list) ? list : []);
    let newest = cursor;
    for (const summary of messages) {
      const messageId = summary.message_id ?? summary.id;
      const m = (!summary.text && messageId)
        ? (await this.api(`/inboxes/${encodeURIComponent(address)}/messages/${encodeURIComponent(String(messageId))}`) ?? summary)
        : summary;
      const to = Array.isArray(m.to) ? m.to[0] : (m.to ?? address);
      const from = m.from ?? m.sender ?? 'unknown@unknown';
      const text = m.text ?? m.extracted_text ?? m.plain ?? m.preview ?? (m.html ? htmlToText(m.html) : '');
      const { delivered: ok } = (await this.deps.ingest({
        ...(messageId ? { sourceId: `agentmail:${address}:${messageId}` } : {}),
        to: cleanAddress(to),
        from: cleanAddress(from),
        subject: m.subject,
        text: String(text),
      }));
      if (ok) delivered++;
      newest = m.timestamp ?? m.created_at ?? newest;
    }
    if (newest && newest !== cursor) (await this.deps.store.kvSet(amCursorKey(address), String(newest)));
    return delivered;
  }
}

/** The puller for the active provider, or undefined for push providers. */
export function createPuller(config: MailboxConfig, deps: PullDeps): Puller | undefined {
  if (!defaultMailboxRegistry().activeIsPull(config)) return undefined;
  if (config.provider === 'imap') return new ImapPuller(config, deps);
  if (config.provider === 'agentmail') return new AgentMailPuller(config, deps);
  return undefined;
}

// ── the poll loop (mirrors WorldLifecycleManager) ─────────────────────────────

export class MailPoller {
  private timer?: AsyncInterval;
  private active?: Promise<number>;
  constructor(
    private deps: {
      readConfigs(): { organizationId: string; config: MailboxConfig }[] | Promise<{ organizationId: string; config: MailboxConfig }[]>;
      resolveSecret(handle: string): string | undefined;
      store: PullStore;
      makeIngest(organizationId: string, config: MailboxConfig): (msg: PulledMessage) => { delivered: boolean } | Promise<{ delivered: boolean }>;
    },
    private intervalMs = Number(process.env.KARMAX_MAIL_POLL_MS) || 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = new AsyncInterval(() => this.sweep(), this.intervalMs, error => {
      console.error('[mail] poll failed:', error instanceof Error ? error.message : String(error));
    });
    this.timer.unref();
  }
  async stop(): Promise<void> {
    const timer = this.timer;
    this.timer = undefined;
    await timer?.stop();
    await this.active?.catch(() => {});
  }

  /** Provider failures are audited and retried next tick. Database failures
   * propagate to the caller (the periodic runner observes and reports them). */
  sweep(): Promise<number> {
    if (this.active) return Promise.resolve(0);
    return this.active = this.sweepOnce().finally(() => { this.active = undefined; });
  }

  private async sweepOnce(): Promise<number> {
    let delivered = 0;
    for (const { organizationId, config } of (await this.deps.readConfigs())) {
      try {
        const puller = createPuller(config, {
          store: this.deps.store,
          organizationId,
          resolveSecret: this.deps.resolveSecret,
          ingest: this.deps.makeIngest(organizationId, config),
        });
        if (puller) delivered += await puller.poll();
      } catch (e) {
        (await this.deps.store.appendAudit?.({
          principalId: 'system:mail-poller',
          action: 'agent-mail.poll.failed',
          detail: { organizationId, error: e instanceof Error ? e.message : String(e) },
        }));
      }
    }
    return delivered;
  }
}
