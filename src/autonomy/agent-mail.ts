import crypto from 'node:crypto';

/**
 * Agent mailbox (PLAN-passwords.md §8). Registration and email-verification
 * flows need somewhere to receive codes and magic links — but never the user's
 * real inbox. karmax mints a dedicated agent address; an inbound mail webhook
 * drops messages here; the `check_agent_mail` tool reads them and pulls out the
 * verification code so an agent can complete "check your email" steps on its
 * own. Existing accounts on the user's personal mail still escalate to a human.
 *
 * Mailboxes are **per organization** — the organization is karmax's tenant
 * boundary, and a shared inbox would let one tenant's agents read another's
 * confirmation mails. Each organization gets its own address with a random,
 * unguessable local part; the ingest webhook routes each message to the
 * organization that owns the recipient address and silently drops mail for
 * unknown recipients (a catch-all domain forwards everything). Reads go through
 * the organization-scoped route, so the token/session machinery enforces that
 * an agent only ever sees its own organization's inbox.
 *
 * Storage is deliberately simple: a bounded, store-backed message list (kv) per
 * organization. The domain is configured once for the installation (an own
 * catch-all domain, or a hosted inbox provider). With no domain configured the
 * mailbox still works for local/dev ingestion under `agent.local`.
 */

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  subject?: string;
  text: string;
  /** Verification code extracted from subject/body, if any. */
  code?: string;
  /** First login/verify link found in the body, if any. */
  link?: string;
  receivedAt: number;
}

export interface AgentMailStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

const kvMessages = (organizationId: string) => `agent-mail:messages:${organizationId}`;
const kvAddress = (organizationId: string) => `agent-mail:address:${organizationId}`;
/** Reverse route: local part → owning organization (what ingest consults). */
const kvOwner = (localPart: string) => `agent-mail:owner:${localPart}`;
const MAX_MESSAGES = 200;

/** Pull a one-time code out of mail text — 4–8 digits, or a 6–8 char
 *  alphanumeric token near a "code"/"verify" cue. Conservative on purpose. */
export function extractCode(subject: string | undefined, body: string): string | undefined {
  const hay = `${subject ?? ''}\n${body}`;
  // A labelled code wins ("your code is 123456", "verification code: AB12CD").
  const labelled = hay.match(/(?:code|otp|passcode|pin)[^0-9a-z]{0,12}([0-9]{4,8}|[0-9A-Z]{6,8})\b/i);
  if (labelled) return labelled[1]!.toUpperCase();
  // Otherwise a standalone 6-digit block is the overwhelmingly common shape.
  const sixDigit = hay.match(/\b(\d{6})\b/);
  if (sixDigit) return sixDigit[1];
  const anyDigits = hay.match(/\b(\d{4,8})\b/);
  return anyDigits?.[1];
}

/** First verification/login URL in the body. */
export function extractLink(body: string): string | undefined {
  const urls = body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return urls.find((u) => /verif|confirm|activate|login|magic|token|auth/i.test(u)) ?? urls[0];
}

export class AgentMail {
  /** `domain` is resolved from the connected mailbox provider (mailbox.ts) and
   *  passed in by the gateway — no env var. Undefined ⇒ the `agent.local`
   *  placeholder (usable for local/test ingestion, not real mail). */
  constructor(private store: AgentMailStore, private domain?: string) {}

  /**
   * The organization's stable agent address; minted (with its reverse-route
   * entry) on first read, with a random unguessable local part. If a real
   * domain gets connected AFTER an org first read a placeholder `@agent.local`
   * address, the address upgrades to the real domain automatically (same local
   * part, so the reverse route is preserved) — connecting a provider "just
   * works" for organizations that already existed.
   */
  address(organizationId: string): string {
    const existing = this.store.kvGet(kvAddress(organizationId));
    const domain = this.domain || 'agent.local';
    if (existing) {
      const [local, host] = existing.split('@');
      if (host === domain || host !== 'agent.local' || !this.domain) return existing;
      const upgraded = `${local}@${this.domain}`;
      this.store.kvSet(kvAddress(organizationId), upgraded);
      this.store.kvSet(kvOwner(local!), organizationId);
      return upgraded;
    }
    const local = `agent-${crypto.randomBytes(6).toString('hex')}`;
    const address = `${local}@${domain}`;
    this.store.kvSet(kvAddress(organizationId), address);
    this.store.kvSet(kvOwner(local), organizationId);
    return address;
  }

  configured(): boolean {
    return !!this.domain;
  }

  /** Which organization owns a recipient address (subaddress tags stripped:
   *  `agent-ab12+github@…` routes like `agent-ab12@…`). */
  ownerOf(to: string): string | undefined {
    const local = to.split('@')[0]?.split('+')[0]?.trim().toLowerCase();
    return local ? this.store.kvGet(kvOwner(local)) : undefined;
  }

  private all(organizationId: string): AgentMessage[] {
    try {
      return JSON.parse(this.store.kvGet(kvMessages(organizationId)) ?? '[]');
    } catch {
      return [];
    }
  }

  /**
   * Ingest an inbound message (the mail webhook), routed to the organization
   * owning the recipient address. Mail for an unknown recipient is dropped —
   * a catch-all domain forwards everything, including strangers' typos.
   */
  ingest(msg: { from: string; to: string; subject?: string; text: string; receivedAt?: number }): { delivered: boolean; message?: AgentMessage } {
    const organizationId = this.ownerOf(msg.to);
    if (!organizationId) return { delivered: false };
    const record: AgentMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(extractCode(msg.subject, msg.text) ? { code: extractCode(msg.subject, msg.text) } : {}),
      ...(extractLink(msg.text) ? { link: extractLink(msg.text) } : {}),
      receivedAt: msg.receivedAt ?? Date.now(),
    };
    const next = [...this.all(organizationId), record].slice(-MAX_MESSAGES);
    this.store.kvSet(kvMessages(organizationId), JSON.stringify(next));
    return { delivered: true, message: record };
  }

  /** Recent messages for one organization, newest first. */
  recent(organizationId: string, opts: { since?: number; limit?: number; match?: string } = {}): AgentMessage[] {
    let msgs = this.all(organizationId).filter((m) => (opts.since ? m.receivedAt > opts.since : true));
    if (opts.match) {
      const needle = opts.match.toLowerCase();
      msgs = msgs.filter((m) => `${m.subject ?? ''} ${m.from} ${m.text}`.toLowerCase().includes(needle));
    }
    return msgs.reverse().slice(0, opts.limit ?? 10);
  }
}
