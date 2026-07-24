/**
 * Mailbox providers (PLAN-passwords.md §8) — how an installation gets a working
 * agent-email backend, connected once in Settings (not an env var). Mirrors the
 * PaymentProvider pattern: a small registry of pluggable providers, each with a
 * `describe`/`connect` surface, so "give agents an email address" is a one-time
 * operator action rather than a DNS/webhook chore for every user.
 *
 * The split that makes this clean:
 *   • The PROVIDER is connected once per installation (the operator running the
 *     karmax deployment). On the public hosted site, that's the site owner —
 *     done once, ever.
 *   • ADDRESSES are minted per organization automatically (agent-mail.ts). A
 *     tenant signing up sees a working address with zero setup; they never touch
 *     domains or webhooks.
 *
 * Two providers ship:
 *   • self-managed — you enter your own domain (the Settings field) and point
 *     its inbound mail at the webhook. The DIY / self-host path.
 *   • hosted — connect a managed inbound-email service with one API key; it owns
 *     the domain and forwards mail to the webhook. The zero-DNS path. Its live
 *     API is wired per deployment (like StripeIssuingProvider), but the connect
 *     surface + address formation are real now.
 */

export interface MailboxConfig {
  /** Which provider is active for this installation. */
  provider?: string;
  /** self-managed: the domain the operator owns and forwards to the webhook. */
  domain?: string;
  /** hosted: the vault handle holding the provider API key (never the key). */
  apiKeyHandle?: string;
  /** hosted: the domain the managed provider assigns. */
  hostedDomain?: string;
}

export interface MailboxProviderInfo {
  name: string;
  label: string;
  /** How you connect: enter a domain, paste an API key, or an OAuth flow. */
  kind: 'domain' | 'apiKey' | 'oauth';
  connected: boolean;
  /** The domain agent addresses form on once connected (for display). */
  domain?: string;
  help?: string;
}

export interface ConnectInput {
  domain?: string;
  apiKey?: string;
}
export interface ConnectResult {
  status: 'connected' | 'awaiting_oauth' | 'unavailable';
  url?: string;
  detail?: string;
  /** The config patch to persist on success. */
  config?: Partial<MailboxConfig>;
}

export interface MailboxProvider {
  readonly name: string;
  describe(config: MailboxConfig): MailboxProviderInfo;
  /** Validate + return the config patch to store (or an unavailable reason). */
  connect(input: ConnectInput): ConnectResult;
  /** The domain to mint agent addresses on, or undefined if not connected. */
  domainFor(config: MailboxConfig): string | undefined;
}

/** Self-managed: you own the domain and forward its mail to the webhook. */
export class SelfManagedDomainProvider implements MailboxProvider {
  readonly name = 'self-managed';
  /** Env var kept only as a migration default for installs that set it before
   *  the domain became a Settings field. */
  private envDefault = process.env.KARMAX_AGENT_MAIL_DOMAIN;
  describe(config: MailboxConfig): MailboxProviderInfo {
    const domain = this.domainFor(config);
    return {
      name: this.name, label: 'Your own domain', kind: 'domain', connected: !!domain, domain,
      help: domain
        ? `Agents use addresses on ${domain}. Point that domain's inbound mail at POST /api/agent-mail/ingest (set KARMAX_AGENT_MAIL_SECRET) — e.g. Cloudflare Email Routing (free), Mailgun, or SES.`
        : 'Enter a domain you control and forward its inbound mail to the webhook. Best if you already run a domain; otherwise use a hosted provider for zero DNS setup.',
    };
  }
  connect(input: ConnectInput): ConnectResult {
    const domain = input.domain?.trim().replace(/^@/, '').toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { status: 'unavailable', detail: 'enter a valid domain, e.g. agents.yourcompany.com' };
    return { status: 'connected', detail: `Agent addresses will use @${domain}. Configure inbound forwarding to the webhook.`, config: { provider: this.name, domain } };
  }
  domainFor(config: MailboxConfig): string | undefined {
    return config.domain || this.envDefault || undefined;
  }
}

/**
 * Hosted managed inbound-email (zero DNS). Connect with one API key; the service
 * owns the domain and posts inbound mail to the webhook. The live vendor call is
 * wired per deployment via KARMAX_HOSTED_MAIL_DOMAIN (the operator's managed
 * subdomain); until then the connect surface stores the key and reports clearly.
 */
export class HostedMailboxProvider implements MailboxProvider {
  readonly name = 'hosted';
  describe(config: MailboxConfig): MailboxProviderInfo {
    const domain = this.domainFor(config);
    const connected = !!config.apiKeyHandle && !!domain;
    return {
      name: this.name, label: 'Hosted mailbox (managed)', kind: 'apiKey', connected, domain,
      help: connected
        ? `Connected — agents get addresses on ${domain} automatically, no DNS. Inbound mail is forwarded to karmax for you.`
        : process.env.KARMAX_HOSTED_MAIL_DOMAIN
          ? 'Paste your managed inbound-email API key to connect — one field, once, for the whole installation. Every organization then gets an address automatically.'
          : 'A hosted mailbox is not enabled on this deployment yet — the operator sets KARMAX_HOSTED_MAIL_DOMAIN once. Until then use your own domain, or the local test address.',
    };
  }
  connect(input: ConnectInput): ConnectResult {
    if (!process.env.KARMAX_HOSTED_MAIL_DOMAIN) return { status: 'unavailable', detail: 'hosted mailbox is not enabled on this deployment (operator sets KARMAX_HOSTED_MAIL_DOMAIN)' };
    if (!input.apiKey?.trim()) return { status: 'unavailable', detail: 'paste the managed inbound-email API key' };
    // The key is stored in the vault by the caller; here we just record that it
    // exists and the domain to mint on.
    return { status: 'connected', detail: 'Connected. Every organization now gets a working agent address automatically.', config: { provider: this.name, hostedDomain: process.env.KARMAX_HOSTED_MAIL_DOMAIN } };
  }
  domainFor(config: MailboxConfig): string | undefined {
    return config.hostedDomain || process.env.KARMAX_HOSTED_MAIL_DOMAIN || undefined;
  }
}

export class MailboxRegistry {
  private providers = new Map<string, MailboxProvider>();
  register(p: MailboxProvider) {
    this.providers.set(p.name, p);
  }
  get(name?: string): MailboxProvider | undefined {
    return name ? this.providers.get(name) : undefined;
  }
  list(config: MailboxConfig): MailboxProviderInfo[] {
    return [...this.providers.values()].map((p) => p.describe(config));
  }
  /** The active provider's domain, or undefined if nothing is connected. */
  activeDomain(config: MailboxConfig): string | undefined {
    const active = this.get(config.provider);
    return active?.domainFor(config);
  }
}

/** The default registry: self-managed domain + hosted managed mailbox. */
export function defaultMailboxRegistry(): MailboxRegistry {
  const r = new MailboxRegistry();
  r.register(new SelfManagedDomainProvider());
  r.register(new HostedMailboxProvider());
  return r;
}
