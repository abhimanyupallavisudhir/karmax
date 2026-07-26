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
  /** hosted / imap, domain-free path: the ONE inbound address the service or
   *  mailbox uses (e.g. ab12cd@inbound.postmarkapp.com, you@gmail.com); orgs
   *  ride +tags on it. */
  fixedAddress?: string;
  /** imap: connection details (the password lives in the vault, not here). */
  imap?: { host: string; port: number; user: string; secure: boolean };
  /** agentmail: the domain AgentMail assigns your inboxes (e.g. abc.agentmail.to). */
  agentmailDomain?: string;
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
  /** imap: mailbox connection (apiKey carries the password/app-password). */
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapSecure?: boolean;
  /** imap: the operator's mailbox address (orgs +tag on it). */
  address?: string;
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
  /** The single base local part when addresses ride +tags on one mailbox
   *  (hosted fixed-address, imap); undefined for domain/webhook providers. */
  fixedLocalFor?(config: MailboxConfig): string | undefined;
  /** true ⇒ karmax fetches mail by polling this provider (works on localhost);
   *  false/undefined ⇒ mail is pushed to the webhook (needs a public URL). */
  readonly pull?: boolean;
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
  fixedLocalFor(config: MailboxConfig): string | undefined {
    return config.fixedAddress?.split('@')[0] || undefined;
  }
}

/**
 * IMAP poll (works on localhost — karmax reaches OUT to the mailbox, so no
 * public URL is needed). The operator connects ONE real mailbox (e.g. a Gmail
 * with an app-password, Fastmail, any IMAP account); every organization gets a
 * `you+agent-<token>@domain` sub-address that lands in that one inbox, and the
 * poller routes each message to the owning org. Zero third-party agent-email
 * vendor; the operator owns the whole thing.
 */
export class ImapMailboxProvider implements MailboxProvider {
  readonly name = 'imap';
  readonly pull = true;
  describe(config: MailboxConfig): MailboxProviderInfo {
    const connected = !!(config.imap && config.fixedAddress);
    return {
      name: this.name, label: 'IMAP mailbox (pull)', kind: 'apiKey', connected, domain: config.fixedAddress?.split('@')[1],
      help: connected
        ? `Connected to ${config.fixedAddress}. karmax polls it; organizations get +tagged sub-addresses. Your provider must allow +sub-addressing (Gmail, Fastmail, most do).`
        : 'Works even on localhost. Connect any IMAP mailbox (a spare Gmail with an app-password is easiest): address, IMAP host/port, username, and password. karmax polls it — nothing needs to reach you.',
    };
  }
  connect(input: ConnectInput): ConnectResult {
    const address = input.address?.trim().toLowerCase();
    if (!address || !/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)) return { status: 'unavailable', detail: 'enter the mailbox address, e.g. youragent@gmail.com' };
    if (!input.apiKey?.trim()) return { status: 'unavailable', detail: 'enter the mailbox password (an app-password for Gmail/most providers)' };
    const host = input.imapHost?.trim() || guessImapHost(address);
    if (!host) return { status: 'unavailable', detail: 'enter the IMAP host, e.g. imap.gmail.com' };
    const port = Number(input.imapPort) || 993;
    const secure = input.imapSecure !== false;
    return { status: 'connected', detail: `Connected. karmax will poll ${address} for agent mail.`,
      config: { provider: this.name, fixedAddress: address, imap: { host, port, user: input.imapUser?.trim() || address, secure } } };
  }
  domainFor(config: MailboxConfig): string | undefined {
    return config.fixedAddress?.split('@')[1] || undefined;
  }
  fixedLocalFor(config: MailboxConfig): string | undefined {
    return config.fixedAddress?.split('@')[0] || undefined;
  }
}

/** Best-effort IMAP host from a well-known mail domain, so the operator usually
 *  only types the address + password. */
export function guessImapHost(address: string): string | undefined {
  const domain = address.split('@')[1]?.toLowerCase();
  const known: Record<string, string> = {
    'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com', 'hotmail.com': 'outlook.office365.com', 'live.com': 'outlook.office365.com',
    'fastmail.com': 'imap.fastmail.com', 'yahoo.com': 'imap.mail.yahoo.com', 'icloud.com': 'imap.mail.me.com',
    'proton.me': '127.0.0.1', 'protonmail.com': '127.0.0.1', // Proton needs the local Bridge
  };
  return domain ? (known[domain] ?? `imap.${domain}`) : undefined;
}

/**
 * AgentMail (agentmail.to) — an email service built FOR agents: karmax creates a
 * real inbox per organization via its REST API and pulls messages. Pure pull,
 * so it works on localhost; per-org isolation is real separate inboxes. Connect
 * with one API key (the AgentMail-assigned domain is auto-detected on connect,
 * or you can enter it). Live API calls happen in the poller; the connect surface
 * validates + stores the key like every other credential.
 */
export class AgentMailboxProvider implements MailboxProvider {
  readonly name = 'agentmail';
  readonly pull = true;
  describe(config: MailboxConfig): MailboxProviderInfo {
    const connected = !!(config.apiKeyHandle && config.agentmailDomain);
    return {
      name: this.name, label: 'AgentMail (pull, built for agents)', kind: 'apiKey', connected, domain: config.agentmailDomain,
      help: connected
        ? `Connected. Each organization gets its own real inbox on ${config.agentmailDomain}; karmax pulls messages via the API.`
        : 'Purpose-built for AI agents and works on localhost. Sign up at agentmail.to, paste your API key (and your assigned domain, e.g. yourhandle.agentmail.to). karmax creates one inbox per organization and pulls mail — nothing needs to reach you.',
    };
  }
  connect(input: ConnectInput): ConnectResult {
    if (!input.apiKey?.trim()) return { status: 'unavailable', detail: 'paste your AgentMail API key' };
    // The domain is optional: default to AgentMail's shared domain, and accept a
    // full address (e.g. you@agentmail.to) — we just want the domain part.
    let domain = input.domain?.trim().replace(/^@/, '').toLowerCase() || '';
    if (domain.includes('@')) domain = domain.split('@')[1] ?? '';
    if (!domain) domain = 'agentmail.to';
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { status: 'unavailable', detail: 'that does not look like a valid AgentMail domain' };
    return { status: 'connected', detail: 'Connected. This organization now gets its own AgentMail inbox.', config: { provider: this.name, agentmailDomain: domain } };
  }
  domainFor(config: MailboxConfig): string | undefined {
    return config.agentmailDomain || undefined;
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
  list(config: MailboxConfig): (MailboxProviderInfo & { pull: boolean })[] {
    return [...this.providers.values()].map((p) => ({ ...p.describe(config), pull: !!p.pull }));
  }
  /** The active provider's domain, or undefined if nothing is connected. */
  activeDomain(config: MailboxConfig): string | undefined {
    const active = this.get(config.provider);
    return active?.domainFor(config);
  }
  /** The active provider's fixed base local part (+tag providers), if any. */
  activeFixedLocal(config: MailboxConfig): string | undefined {
    return this.get(config.provider)?.fixedLocalFor?.(config);
  }
  /** Is the active provider pull-based (poller) rather than push (webhook)? */
  activeIsPull(config: MailboxConfig): boolean {
    return !!this.get(config.provider)?.pull;
  }
}

/** The default registry. Pull providers (work on localhost) are listed first;
 *  the push providers need a public URL and are the fallback. */
export function defaultMailboxRegistry(): MailboxRegistry {
  const r = new MailboxRegistry();
  r.register(new AgentMailboxProvider());
  r.register(new ImapMailboxProvider());
  r.register(new SelfManagedDomainProvider());
  r.register(new HostedMailboxProvider());
  return r;
}
