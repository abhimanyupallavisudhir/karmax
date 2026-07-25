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
  /** hosted, domain-free path: the ONE inbound address the service issued
   *  (e.g. ab12cd@inbound.postmarkapp.com); orgs ride +tags on it. */
  fixedAddress?: string;
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
  /** A domain (self-managed / hosted-with-domain) or, for the hosted
   *  domain-free path, the full inbound address the service issued. */
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
        ? `Agents use addresses on ${domain}. Forward that domain's inbound email to karmax (e.g. Cloudflare Email Routing — free).`
        : 'Use a domain you already own: enter it, then forward its inbound email to karmax.',
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
    const connected = !!domain;
    return {
      name: this.name, label: 'Hosted inbox', kind: 'apiKey', connected, domain,
      help: connected
        ? (config.fixedAddress ? `Connected via ${config.fixedAddress} — organizations get +tagged addresses on it.` : `Connected. Agents get addresses on ${domain}.`)
        : 'No domain needed: an inbound-email service gives you an address or domain on THEIR domain and POSTs incoming mail to a URL. Paste what they gave you, and paste karmax’s webhook URL (shown below) into their settings.',
    };
  }
  connect(input: ConnectInput): ConnectResult {
    const value = input.domain?.trim().replace(/^@/, '').toLowerCase();
    if (!value) return { status: 'unavailable', detail: 'enter the inbound address (e.g. ab12cd@inbound.example.com) or domain the service gave you' };
    // A full address ⇒ the domain-free single-inbox path (orgs ride +tags).
    if (value.includes('@')) {
      const [local, host] = value.split('@');
      if (!local || !host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { status: 'unavailable', detail: 'that does not look like a valid address' };
      return { status: 'connected', detail: 'Connected. Every organization now gets its own +tagged address on that inbox.', config: { provider: this.name, hostedDomain: host, fixedAddress: value } };
    }
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return { status: 'unavailable', detail: 'that does not look like a valid domain' };
    return { status: 'connected', detail: 'Connected. Every organization now gets a working agent address automatically.', config: { provider: this.name, hostedDomain: value, fixedAddress: undefined } };
  }
  domainFor(config: MailboxConfig): string | undefined {
    return config.hostedDomain || undefined;
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
