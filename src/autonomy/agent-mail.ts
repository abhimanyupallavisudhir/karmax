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

/** "Display Name <addr@host>" / "addr@host" / comma lists → the first address. */
export function cleanAddress(value: string): string {
  const m = String(value).match(/[A-Za-z0-9._%+=-]+@[A-Za-z0-9.-]+/);
  return (m?.[0] ?? String(value).trim()).toLowerCase();
}

// ── inbound payload normalization (§8): meet providers where they are ─────────
// Forwarding services each POST their own shape; the webhook accepts them all
// rather than demanding a custom adapter from the operator.

export interface InboundFields {
  to?: string;
  from?: string;
  subject?: string;
  text?: string;
}

/** Map one inbound POST body (already parsed to a flat object) to our fields.
 *  Recognizes: karmax's own shape, Postmark, CloudMailin, Mailgun routes,
 *  SendGrid Inbound Parse, and a Cloudflare Email Worker's raw-MIME payload. */
export function normalizeInbound(b: Record<string, any>): InboundFields {
  // Postmark: {To, From, Subject, TextBody, HtmlBody, ToFull:[{Email}]}
  if (b.TextBody !== undefined || b.HtmlBody !== undefined || b.ToFull || b.FromFull) {
    return { to: b.ToFull?.[0]?.Email ?? b.To, from: b.FromFull?.Email ?? b.From, subject: b.Subject, text: b.TextBody || stripHtml(b.HtmlBody) };
  }
  // CloudMailin: {envelope:{to,from}, headers:{subject}, plain, html}
  if (b.envelope?.to || b.plain !== undefined) {
    return { to: b.envelope?.to, from: b.envelope?.from ?? b.headers?.from, subject: b.headers?.subject, text: b.plain || stripHtml(b.html) };
  }
  // Mailgun routes: {recipient, sender|from, subject, 'body-plain'|'stripped-text'}
  if (b.recipient || b['body-plain'] !== undefined) {
    return { to: b.recipient, from: b.sender ?? b.from, subject: b.subject, text: b['stripped-text'] || b['body-plain'] || stripHtml(b['body-html']) };
  }
  // SendGrid Inbound Parse / our own JSON / a raw-MIME forward: {to, from, subject, text|email|raw}
  const text = b.text ?? b.email ?? b.raw ?? '';
  return { to: b.to, from: b.from, subject: b.subject, text: looksLikeMime(text) ? extractMimeText(text) : String(text) };
}

export function htmlToText(html?: string): string {
  return String(html ?? '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
const stripHtml = htmlToText;

function looksLikeMime(text: unknown): text is string {
  return typeof text === 'string' && /^(?:[A-Za-z-]+:[^\n]*\r?\n)+\r?\n/.test(text) && /content-type:/i.test(text.slice(0, 4000));
}

export function decodeQuotedPrintable(input: string): string {
  return input.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => {
    try {
      return Buffer.from(h, 'hex').toString('latin1');
    } catch {
      return _;
    }
  });
}

/**
 * Minimal raw-MIME → readable text: split multipart bodies, prefer text/plain
 * (else stripped text/html), honor base64/quoted-printable transfer encodings.
 * Not a full MIME implementation — enough that verification codes and links in
 * real signup mail survive intact (tested against the common shapes).
 */
export function extractMimeText(raw: string): string {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return raw;
  const headers = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
  const contentType = /content-type:\s*([^\r\n;]+)(;[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)?/i.exec(headers);
  const type = contentType?.[1]?.trim().toLowerCase() ?? 'text/plain';
  const params = (contentType?.[2] ?? '').replace(/\r?\n[ \t]/g, ' ');
  if (type.startsWith('multipart/')) {
    const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(params)?.[1];
    if (!boundary) return body;
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${'{'}}()|[\\]\\\\]/g, '\\$&')}(?:--)?\r?\n?`)).filter((p) => p.trim());
    const scored = parts.map((p) => ({ text: extractMimeText(p.replace(/^\r?\n/, '')), plain: /content-type:\s*text\/plain/i.test(p) || !/content-type:/i.test(p) }));
    return (scored.find((s) => s.plain && s.text.trim()) ?? scored.find((s) => s.text.trim()))?.text ?? '';
  }
  const encoding = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
  let decoded = body;
  if (encoding === 'base64') {
    try {
      decoded = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      /* keep raw */
    }
  } else if (encoding === 'quoted-printable') {
    decoded = decodeQuotedPrintable(body);
  }
  return type === 'text/html' ? stripHtml(decoded) : decoded;
}

/**
 * The ready-to-paste Cloudflare Email Worker (§8 "Your own domain"): Cloudflare
 * Email Routing cannot POST to arbitrary URLs — it forwards to addresses or to
 * an Email Worker — so karmax hands the operator this worker verbatim. It
 * relays each message (raw MIME; the webhook extracts the text) with the
 * shared secret.
 */
/** The installation's webhook secret, minted on first use and stored in the
 *  store — the operator copies a complete URL, never sets an env var. The
 *  legacy KARMAX_AGENT_MAIL_SECRET env remains accepted for old setups. */
export function ingestSecret(store: AgentMailStore): string {
  const existing = store.kvGet('agent-mail:secret');
  if (existing) return existing;
  const secret = crypto.randomBytes(18).toString('base64url');
  store.kvSet('agent-mail:secret', secret);
  return secret;
}

/** application/x-www-form-urlencoded → flat object (Mailgun test posts etc.). */
export function parseUrlEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** Minimal multipart/form-data → flat object of text fields (what Mailgun
 *  routes and SendGrid Inbound Parse actually POST). Files are ignored. */
export function parseMultipart(body: string, contentType: string): Record<string, string> {
  const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1];
  const out: Record<string, string> = {};
  if (!boundary) return out;
  for (const part of body.split(`--${boundary}`)) {
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (/filename\s*=/.test(headers)) continue; // attachments are not fields
    const name = /name\s*=\s*"?([^";\r\n]+)"?/i.exec(headers)?.[1];
    if (!name) continue;
    out[name] = part.slice(headerEnd).replace(/^\r?\n\r?\n?/, '').replace(/\r?\n(?:--)?\s*$/, '');
  }
  return out;
}

export function cloudflareWorkerScript(ingestUrl: string): string {
  return `export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    await fetch(${JSON.stringify(ingestUrl)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: message.to,
        from: message.from,
        subject: message.headers.get("subject") || "",
        text: raw,
      }),
    });
  },
};`;
}

export class AgentMail {
  /**
   * `domain` is resolved from the connected mailbox provider (mailbox.ts) and
   * passed in by the gateway — no env var. Undefined ⇒ the `agent.local`
   * placeholder (usable for local/test ingestion, not real mail).
   *
   * `fixedLocal` covers the domain-free path (§8): a provider that issues ONE
   * inbound address (e.g. `ab12cd@inbound.postmarkapp.com`) rather than a whole
   * domain. Org addresses then ride plus-addressing on that single mailbox —
   * `ab12cd+agent-<hex>@…` — which such services deliver to the same inbox
   * while karmax routes on the tag.
   */
  constructor(private store: AgentMailStore, private domain?: string, private fixedLocal?: string) {}

  /**
   * The organization's stable agent address; minted (with its reverse-route
   * entry) on first read, with a random unguessable local part. If a real
   * domain gets connected AFTER an org first read a placeholder `@agent.local`
   * address, the address upgrades automatically (the org's random token is
   * preserved, so inbound routing keeps working) — connecting a provider
   * "just works" for organizations that already existed.
   */
  address(organizationId: string): string {
    const existing = this.store.kvGet(kvAddress(organizationId));
    if (existing && !this.domain) return existing; // never downgrade to the placeholder
    const token = existing?.match(/(agent-[0-9a-f]+)/)?.[1] ?? `agent-${crypto.randomBytes(6).toString('hex')}`;
    const local = this.fixedLocal ? `${this.fixedLocal}+${token}` : token;
    const address = `${local}@${this.domain || 'agent.local'}`;
    if (existing === address) return existing;
    // First mint, placeholder upgrade, or provider switch: the org's random
    // token is preserved and old reverse-routes stay in kv, so nothing breaks.
    this.store.kvSet(kvAddress(organizationId), address);
    this.store.kvSet(kvOwner(local.toLowerCase()), organizationId);
    this.store.kvSet(kvOwner(token), organizationId); // tag-only route survives providers that rewrite the base
    return address;
  }

  configured(): boolean {
    return !!this.domain;
  }

  /** Which organization owns a recipient address. Tries the exact local part
   *  (covers fixed-address `base+agent-x` mailboxes), then the plus-tag alone,
   *  then the base local with tags stripped (`agent-ab12+github@…`). */
  ownerOf(to: string): string | undefined {
    const local = to.split('@')[0]?.trim().toLowerCase();
    if (!local) return undefined;
    const [base, tag] = local.split('+', 2);
    return this.store.kvGet(kvOwner(local))
      ?? (tag ? this.store.kvGet(kvOwner(tag)) : undefined)
      ?? (base ? this.store.kvGet(kvOwner(base)) : undefined);
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
