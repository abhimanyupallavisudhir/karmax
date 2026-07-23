import crypto from 'node:crypto';

/**
 * Agent mailbox (PLAN-passwords.md §8). Registration and email-verification
 * flows need somewhere to receive codes and magic links — but never the user's
 * real inbox. karmax mints a dedicated agent address; an inbound mail webhook
 * drops messages here; the `check_agent_mail` tool reads them and pulls out the
 * verification code so an agent can complete "check your email" steps on its
 * own. Existing accounts on the user's personal mail still escalate to a human.
 *
 * Storage is deliberately simple: a bounded, store-backed message list (kv).
 * The address is stable per installation; the domain is configured once (an own
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

const KV_MESSAGES = 'agent-mail:messages';
const KV_ADDRESS = 'agent-mail:address';
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
  constructor(private store: AgentMailStore, private domain = process.env.KARMAX_AGENT_MAIL_DOMAIN) {}

  /** The installation's stable agent address; minted on first read. */
  address(): string {
    const existing = this.store.kvGet(KV_ADDRESS);
    if (existing) return existing;
    const local = `agent-${crypto.randomBytes(4).toString('hex')}`;
    const address = `${local}@${this.domain || 'agent.local'}`;
    this.store.kvSet(KV_ADDRESS, address);
    return address;
  }

  configured(): boolean {
    return !!this.domain;
  }

  private all(): AgentMessage[] {
    try {
      return JSON.parse(this.store.kvGet(KV_MESSAGES) ?? '[]');
    } catch {
      return [];
    }
  }

  /** Ingest an inbound message (the mail webhook). Returns the stored record. */
  ingest(msg: { from: string; to: string; subject?: string; text: string; receivedAt?: number }): AgentMessage {
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
    const next = [...this.all(), record].slice(-MAX_MESSAGES);
    this.store.kvSet(KV_MESSAGES, JSON.stringify(next));
    return record;
  }

  /** Recent messages, newest first — the `check_agent_mail` read. */
  recent(opts: { since?: number; limit?: number; match?: string } = {}): AgentMessage[] {
    let msgs = this.all().filter((m) => (opts.since ? m.receivedAt > opts.since : true));
    if (opts.match) {
      const needle = opts.match.toLowerCase();
      msgs = msgs.filter((m) => `${m.subject ?? ''} ${m.from} ${m.text}`.toLowerCase().includes(needle));
    }
    return msgs.reverse().slice(0, opts.limit ?? 10);
  }
}
