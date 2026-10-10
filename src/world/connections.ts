import type { CredentialBroker } from '../autonomy/broker.js';
import { organizationScope } from '../autonomy/vault-keys.js';
import type { MachineShape } from '../domain/computer.js';
import { assertComputerFits, computerLimits, type ComputerLimits, type EffectiveComputerLimits } from '../domain/computer-limits.js';
import type { WorldProviderConnection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { probeDaytonaLimits, probeE2BLimits } from './provider-limits.js';

export interface ResolvedWorldProviderConnection {
  organizationId?: string;
  provider: string;
  apiKey: string;
  config: WorldProviderConnection['config'];
  /** What a computer on this account may be (wiki features/computers). */
  limits?: EffectiveComputerLimits;
  /** Remember a limit the provider stated while making a machine. */
  recordLimits?(limits: ComputerLimits): Promise<void>;
}

/** A connection as the API shows it: the key stays write-only, and `limits`
 * is what a computer on this account may be. */
export type WorldProviderConnectionView = Omit<WorldProviderConnection, 'measuredLimits'>
  & { credentialConfigured: boolean; limits: EffectiveComputerLimits };

/** How a connection reaches its provider; tests replace these. */
export interface ProviderProbes {
  /** Prove the key works (a cheap authenticated read). */
  check(provider: string, connection: ResolvedWorldProviderConnection): Promise<void>;
  /** Ask the account what a computer may be, making nothing. */
  limits(provider: string, connection: ResolvedWorldProviderConnection): Promise<ComputerLimits>;
}

/** How long a listing waits for a connection's first probe before answering
 * with the documented defaults (the probe still finishes and is stored). */
const LIST_PROBE_WAIT_MS = 3_000;
/** A failed probe is not repeated by listings more often than this. */
const PROBE_RETRY_MS = 60 * 60_000;

export const worldProviderCredentialHandle = (organizationId: string, provider: string): string =>
  `world-provider:${organizationId}:${provider}:api-key`;

/** Organization-scoped provider onboarding. Metadata is durable and safe to
 * expose; the API key is write-only and remains in the encrypted broker. */
export class WorldProviderConnectionService {
  private probing = new Map<string, { at: number; done: Promise<unknown> }>();

  constructor(private store: Store, private broker: CredentialBroker, private probes: ProviderProbes = defaultProbes) {}

  private view(value: WorldProviderConnection): WorldProviderConnectionView {
    const { measuredLimits, ...rest } = value;
    return { ...rest, credentialConfigured: this.broker.hasHandle(value.credentialHandle),
      limits: computerLimits(value.provider, measuredLimits, value.config.limits) };
  }

  /** Every connection, with its limits. One never asked is asked now (briefly
   * waited for), so the Computer form's maximum is the account's own. */
  async list(organizationId: string): Promise<WorldProviderConnectionView[]> {
    const values = await this.store.listWorldProviderConnections(organizationId);
    const unknown = values.filter((value) => !value.measuredLimits && value.enabled && this.broker.hasHandle(value.credentialHandle));
    if (unknown.length) {
      const probes = unknown.map((value) => this.probeOnce(organizationId, value.provider));
      await Promise.race([Promise.allSettled(probes), new Promise((resolve) => setTimeout(resolve, LIST_PROBE_WAIT_MS).unref())]);
      return (await this.store.listWorldProviderConnections(organizationId)).map((value) => this.view(value));
    }
    return values.map((value) => this.view(value));
  }

  async get(organizationId: string, provider: string): Promise<WorldProviderConnectionView | undefined> {
    const value = (await this.store.getWorldProviderConnection(organizationId, provider));
    return value ? this.view(value) : undefined;
  }

  /** What a computer on `provider` may be for this organization. Self-hosted
   * computers have none; an unconnected provider has its documented ones. */
  async limits(organizationId: string | undefined, provider: string): Promise<EffectiveComputerLimits> {
    const value = organizationId ? await this.store.getWorldProviderConnection(organizationId, provider) : undefined;
    return computerLimits(provider, value?.measuredLimits, value?.config.limits);
  }

  /** Refuse a size this organization's account cannot give, before any machine is made. */
  async assertFits(organizationId: string | undefined, provider: string | undefined, spec: MachineShape): Promise<void> {
    if (!provider) return;
    assertComputerFits(spec, await this.limits(organizationId, provider), provider);
  }

  /** Merge what the provider said into what is known about this account. */
  async recordLimits(organizationId: string, provider: string, limits: ComputerLimits, replace = false): Promise<void> {
    const current = replace ? undefined : (await this.store.getWorldProviderConnection(organizationId, provider))?.measuredLimits;
    await this.store.setWorldProviderConnectionLimits(organizationId, provider, { ...current, ...limits, checkedAt: limits.checkedAt ?? Date.now() });
  }

  /** Ask the account for its limits and store them. A failure keeps what was known. */
  async probeLimits(organizationId: string, provider: string): Promise<ComputerLimits | undefined> {
    const connection = await this.resolve(organizationId, provider);
    const limits = await this.probes.limits(provider, connection);
    if (!limits || !Object.keys(limits).some((key) => key !== 'checkedAt')) return undefined;
    await this.recordLimits(organizationId, provider, limits, true);
    return limits;
  }

  private probeOnce(organizationId: string, provider: string): Promise<unknown> {
    const key = `${organizationId}:${provider}`;
    const previous = this.probing.get(key);
    if (previous && Date.now() - previous.at < PROBE_RETRY_MS) return previous.done;
    const done = this.probeLimits(organizationId, provider).catch(() => undefined);
    this.probing.set(key, { at: Date.now(), done });
    return done;
  }

  async save(input: {
    organizationId: string;
    provider: string;
    apiKey?: string;
    name?: string;
    config?: WorldProviderConnection['config'];
    enabled?: boolean;
  }): Promise<WorldProviderConnectionView> {
    if (!['e2b', 'daytona'].includes(input.provider)) throw new Error(`unsupported world provider: ${input.provider}`);
    const existing = (await this.store.getWorldProviderConnection(input.organizationId, input.provider));
    const handle = existing?.credentialHandle ?? worldProviderCredentialHandle(input.organizationId, input.provider);
    // Validate every non-secret field before rotating the vault handle. A bad
    // endpoint must leave the previous working credential/config untouched.
    const config = cleanConfig({ ...(existing?.config ?? {}), ...(input.config ?? {}) }, this.store.hosted);
    const key = input.apiKey?.trim();
    if (key) (await this.broker.registerHandle(handle, key, organizationScope(input.organizationId)));
    if (!key && !this.broker.hasHandle(handle)) throw new Error(`${providerName(input.provider)} API key is required`);
    (await this.store.upsertWorldProviderConnection({
      organizationId: input.organizationId,
      provider: input.provider,
      name: input.name,
      credentialHandle: handle,
      config,
      enabled: input.enabled,
    }));
    // Another key may be another account: what was learned about the old one goes.
    if (key) {
      (await this.store.setWorldProviderConnectionLimits(input.organizationId, input.provider, null));
      this.probing.delete(`${input.organizationId}:${input.provider}`);
    }
    return (await this.get(input.organizationId, input.provider))!;
  }

  async resolve(organizationId: string | undefined, provider: string): Promise<ResolvedWorldProviderConnection> {
    const value = organizationId ? (await this.store.getWorldProviderConnection(organizationId, provider)) : undefined;
    if (value?.enabled && this.broker.hasHandle(value.credentialHandle)) {
      return {
        organizationId,
        provider,
        apiKey: this.broker.resolve(value.credentialHandle, { caps: [`use-credential:${value.credentialHandle}`] }),
        config: cleanConfig(value.config, this.store.hosted),
        limits: computerLimits(provider, value.measuredLimits, value.config.limits),
        recordLimits: (limits) => this.recordLimits(organizationId!, provider, limits),
      };
    }
    if (value && !value.enabled) throw new Error(`${providerName(provider)} is disabled for this organization`);
    // Hosted launches must never turn an installation credential into a
    // centrally resold organization rail. importEnvironment() migrates a
    // bootstrap key into the installation owner's explicit connection; every
    // other hosted organization must connect its own account.
    if (this.store.hosted)
      throw new Error(`${providerName(provider)} is not connected for this organization`);
    // Environment credentials remain a self-hosted compatibility fallback.
    const apiKey = provider === 'e2b' ? process.env.E2B_API_KEY : provider === 'daytona' ? process.env.DAYTONA_API_KEY : undefined;
    if (!apiKey) throw new Error(`${providerName(provider)} is not connected for this organization`);
    return { organizationId, provider, apiKey, config: environmentConfig(provider) };
  }

  async available(organizationId: string | undefined, provider: string): Promise<boolean> {
    try { (await this.resolve(organizationId, provider)); return true; }
    catch { return false; }
  }

  /** Prove the key works, then ask the account what a computer may be. */
  async test(organizationId: string, provider: string): Promise<WorldProviderConnectionView> {
    const connection = (await this.resolve(organizationId, provider));
    try {
      if (provider !== 'e2b' && provider !== 'daytona') throw new Error(`unsupported world provider: ${provider}`);
      await this.probes.check(provider, connection);
      (await this.store.setWorldProviderConnectionStatus(organizationId, provider, 'ready'));
    } catch (error) {
      const unsafe = error instanceof Error ? error.message : String(error);
      const message = unsafe.split(connection.apiKey).join('[redacted]').slice(0, 2_000);
      (await this.store.setWorldProviderConnectionStatus(organizationId, provider, 'error', message));
      throw new Error(`${providerName(provider)} connection failed: ${message}`);
    }
    // A working key whose limits could not be read keeps the ones known before.
    (await this.probeLimits(organizationId, provider).catch(() => undefined));
    return (await this.get(organizationId, provider))!;
  }

  async delete(organizationId: string, provider: string): Promise<WorldProviderConnection | undefined> {
    const value = (await this.store.deleteWorldProviderConnection(organizationId, provider));
    if (value) (await this.broker.deleteHandle(value.credentialHandle));
    return value;
  }

  /** Move legacy boot-time credentials into the installation owner's encrypted
   * connection exactly once. It keeps upgraded installs working while making
   * subsequent rotation possible from the UI. */
  async importEnvironment(organizationId = 'org_personal'): Promise<void> {
    for (const [provider, apiKey] of [['e2b', process.env.E2B_API_KEY], ['daytona', process.env.DAYTONA_API_KEY]] as const) {
      if (!apiKey || (await this.store.getWorldProviderConnection(organizationId, provider))) continue;
      (await this.save({ organizationId, provider, apiKey, config: environmentConfig(provider) }));
    }
  }
}

const defaultProbes: ProviderProbes = {
  async check(provider, connection) {
    if (provider === 'e2b') {
      const { Sandbox } = await import('e2b');
      const page = Sandbox.list({ apiKey: connection.apiKey, limit: 1 });
      await page.nextItems();
    } else {
      const { Daytona } = await import('@daytona/sdk');
      const client = new Daytona({ apiKey: connection.apiKey, apiUrl: connection.config.apiUrl, target: connection.config.target });
      try { await client.list()[Symbol.asyncIterator]().next(); }
      finally { await client[Symbol.asyncDispose]().catch(() => undefined); }
    }
  },
  async limits(provider, connection) {
    if (provider === 'e2b') return probeE2BLimits(connection.apiKey);
    if (provider === 'daytona') return probeDaytonaLimits(connection.apiKey, { apiUrl: connection.config.apiUrl, target: connection.config.target });
    return {};
  },
};

function cleanLimits(value: unknown): WorldProviderConnection['config']['limits'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const out = Object.fromEntries((['cpu', 'memoryMb', 'diskGb'] as const)
    .map((key) => [key, Number(raw[key])] as const)
    .filter(([, number]) => Number.isInteger(number) && number > 0 && number <= 1_000_000));
  return Object.keys(out).length ? out : undefined;
}

function cleanConfig(value: WorldProviderConnection['config'], hosted = false): WorldProviderConnection['config'] {
  const one = (input: unknown, max = 500) => typeof input === 'string' && input.trim() ? input.trim().slice(0, max) : undefined;
  const limits = cleanLimits(value.limits);
  const apiUrl = one(value.apiUrl);
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (hosted && (url.origin !== 'https://app.daytona.io' || !['/api', '/api/'].includes(url.pathname)
      || url.search || url.hash)) throw new Error('hosted Daytona connections must use https://app.daytona.io/api');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('provider API URL must use HTTPS');
    if (url.username || url.password) throw new Error('provider API URL must not contain credentials');
  }
  return {
    ...(one(value.template) ? { template: one(value.template) } : {}),
    ...(one(value.snapshot) ? { snapshot: one(value.snapshot) } : {}),
    ...(one(value.image) ? { image: one(value.image) } : {}),
    ...(one(value.desktopTemplate) ? { desktopTemplate: one(value.desktopTemplate) } : {}),
    ...(one(value.desktopSnapshot) ? { desktopSnapshot: one(value.desktopSnapshot) } : {}),
    ...(one(value.desktopImage) ? { desktopImage: one(value.desktopImage) } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(one(value.target, 100) ? { target: one(value.target, 100) } : {}),
    ...(limits ? { limits } : {}),
  };
}

function environmentConfig(provider: string): WorldProviderConnection['config'] {
  return provider === 'e2b'
    ? { template: process.env.KARMAX_E2B_TEMPLATE,
        desktopTemplate: process.env.KARMAX_E2B_DESKTOP_TEMPLATE }
    : { snapshot: process.env.KARMAX_DAYTONA_SNAPSHOT, image: process.env.KARMAX_DAYTONA_IMAGE,
        desktopSnapshot: process.env.KARMAX_DAYTONA_DESKTOP_SNAPSHOT,
        desktopImage: process.env.KARMAX_DAYTONA_DESKTOP_IMAGE,
        apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET };
}

function providerName(provider: string): string {
  return provider === 'e2b' ? 'E2B' : provider === 'daytona' ? 'Daytona' : provider;
}
