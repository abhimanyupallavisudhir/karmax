import { BRAND } from '../domain/brand.js';
/**
 * Installation-wide OUTBOUND email (account confirmation, password reset, org
 * invitations). This is the send side; `mailbox.ts` is the inbound agent-mail
 * side. One provider is connected once by the operator (settings:write) and
 * every organization's user-facing mail flows through it.
 *
 * Two providers, both a one-paste setup:
 *  - SMTP     — works with anything (Gmail app-password, Fastmail, SES, a
 *               company relay). Host + port + user + password + a From address.
 *  - Resend   — modern HTTP API, no SMTP host to remember: one API key + a
 *               verified From address. Generous free tier.
 *
 * The secret (SMTP password / API key) lives in the vault behind a handle, never
 * in the stored config or any response.
 */

export interface OutboundEmailConfig {
  provider?: 'smtp' | 'resend';
  /** The From header, e.g. "Karmax <noreply@yourdomain.com>" or a bare address. */
  from?: string;
  /** smtp: connection (the password lives in the vault under secretHandle). */
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  /** Vault handle for the SMTP password / Resend API key. */
  secretHandle?: string;
}

export interface OutboundProviderLink { label: string; url: string; }

export interface OutboundProviderInfo {
  name: 'smtp' | 'resend';
  label: string;
  kind: 'smtp' | 'apiKey';
  connected: boolean;
  help: string;
  links: OutboundProviderLink[];
}

export interface ConnectOutboundInput {
  provider?: string;
  from?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  /** SMTP password or Resend API key. */
  secret?: string;
}

export interface ConnectOutboundResult {
  status: 'connected' | 'unavailable';
  detail: string;
  /** The config patch to persist on success (secretHandle filled in by caller). */
  config?: OutboundEmailConfig;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const EMAIL_RE = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Pull the bare address out of a "Name <addr@host>" or plain "addr@host" From. */
/** Without requireTLS a network attacker can strip STARTTLS from a submission
 * port and read the password in plaintext (AU-30). Only a relay on this
 * machine, which never crosses a network, may speak plain SMTP. */
export function smtpTransportOptions(c: OutboundEmailConfig, password: string) {
  const port = c.port ?? 587;
  const secure = c.secure ?? (port === 465);
  const host = String(c.host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  return { host: c.host, port, secure, requireTLS: !secure && !local,
    auth: { user: c.user ?? fromAddress(c.from), pass: password } };
}

export function fromAddress(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const angle = from.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? from).trim();
  return EMAIL_RE.test(addr) ? addr : undefined;
}

/** Human-readable provider catalogue for the operator's setup card. */
export function describeOutboundProviders(config: OutboundEmailConfig): OutboundProviderInfo[] {
  const active = config.provider;
  const from = config.from;
  return [
    {
      name: 'resend',
      label: 'Resend',
      kind: 'apiKey',
      connected: active === 'resend' && !!config.secretHandle && !!from,
      help: 'Simplest option: no SMTP host to configure. Add & verify your domain in Resend, create an API key, then paste the key and a From address on that domain.',
      links: [
        { label: 'Create a Resend account', url: 'https://resend.com/signup' },
        { label: 'Add a domain', url: 'https://resend.com/domains' },
        { label: 'API keys', url: 'https://resend.com/api-keys' },
      ],
    },
    {
      name: 'smtp',
      label: 'SMTP server',
      kind: 'smtp',
      connected: active === 'smtp' && !!config.host && !!from,
      help: 'Works with any provider or company relay. Enter the SMTP host, port, username, password, and a From address. A Gmail account with an app-password is the quickest for testing.',
      links: [
        { label: 'Gmail app passwords', url: 'https://support.google.com/accounts/answer/185833' },
        { label: 'Fastmail SMTP', url: 'https://www.fastmail.help/hc/en-us/articles/1500000278342' },
        { label: 'Amazon SES SMTP', url: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html' },
      ],
    },
  ];
}

/** Best-effort SMTP host from a well-known From address domain, so the operator
 *  usually only types the address + app-password. */
export function guessSmtpHost(from: string | undefined): { host: string; port: number; secure: boolean } | undefined {
  const domain = fromAddress(from)?.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  const known: Record<string, { host: string; port: number; secure: boolean }> = {
    'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
    'googlemail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
    'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    'fastmail.com': { host: 'smtp.fastmail.com', port: 465, secure: true },
    'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    'icloud.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
  };
  return known[domain];
}

/** Validate a connect request and return the config patch to persist. The caller
 *  registers the secret in the vault and stitches in `secretHandle`. */
export function connectOutboundEmail(input: ConnectOutboundInput): ConnectOutboundResult {
  const from = input.from?.trim();
  if (!from || !fromAddress(from)) return { status: 'unavailable', detail: `enter a valid From address, e.g. ${BRAND} <noreply@yourdomain.com>` };
  const provider = input.provider === 'smtp' ? 'smtp' : input.provider === 'resend' ? 'resend' : undefined;
  if (!provider) return { status: 'unavailable', detail: 'choose a provider: smtp or resend' };

  if (provider === 'resend') {
    if (!input.secret?.trim()) return { status: 'unavailable', detail: 'paste your Resend API key' };
    return { status: 'connected', detail: `Connected. ${BRAND} will send from ${from} via Resend.`, config: { provider, from } };
  }

  // smtp
  const guess = guessSmtpHost(from);
  const host = input.host?.trim() || guess?.host;
  if (!host) return { status: 'unavailable', detail: 'enter the SMTP host, e.g. smtp.yourprovider.com' };
  if (!input.secret?.trim()) return { status: 'unavailable', detail: 'enter the SMTP password (an app-password for Gmail/most providers)' };
  const port = Number(input.port) || guess?.port || 587;
  const secure = input.secure ?? guess?.secure ?? port === 465;
  const user = input.user?.trim() || fromAddress(from);
  return { status: 'connected', detail: `Connected. ${BRAND} will send from ${from} via ${host}.`, config: { provider, from, host, port, secure, user } };
}

/**
 * Sends installation-wide user email. Reads the live config and secret on each
 * send so a provider swap in Settings takes effect immediately.
 */
export class EmailService {
  constructor(
    private readConfig: () => OutboundEmailConfig | Promise<OutboundEmailConfig>,
    private readSecret: (handle: string) => string | undefined,
  ) {}

  /** True when a provider is fully connected (config + resolvable secret). */
  async configured(): Promise<boolean> {
    const c = (await this.readConfig());
    if (!c.from || !fromAddress(c.from)) return false;
    if (c.provider === 'smtp') return !!(c.host && c.secretHandle && this.readSecret(c.secretHandle));
    if (c.provider === 'resend') return !!(c.secretHandle && this.readSecret(c.secretHandle));
    return false;
  }

  async send(msg: EmailMessage): Promise<void> {
    const c = (await this.readConfig());
    if (!(await this.configured())) throw new Error('outbound email is not configured');
    const secret = c.secretHandle ? this.readSecret(c.secretHandle) : undefined;
    if (!secret) throw new Error('outbound email secret is missing');
    if (c.provider === 'resend') return this.sendResend(c, secret, msg);
    return this.sendSmtp(c, secret, msg);
  }

  private async sendResend(c: OutboundEmailConfig, apiKey: string, msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: c.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend rejected the message (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }

  private async sendSmtp(c: OutboundEmailConfig, password: string, msg: EmailMessage): Promise<void> {
    // Imported lazily so installs that never send email don't load nodemailer.
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport(smtpTransportOptions(c, password));
    await transport.sendMail({ from: c.from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
  }
}
