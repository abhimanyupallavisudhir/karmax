import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE, organizationScope } from '../autonomy/vault-keys.js';
import { isAnyProvider, type MachineShape } from '../domain/computer.js';
import { accountFeatures, assertComputerFits, computerLimits, type ComputerFeatures, type ComputerLimits, type EffectiveComputerLimits } from '../domain/computer-limits.js';
import type { WorldProviderConnection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { probeDaytonaLimits, probeE2BLimits } from './provider-limits.js';

import { CLOUD_WORLD_PROVIDERS } from '../domain/computer.js';
import { BRAND } from '../domain/brand.js';

export { CLOUD_WORLD_PROVIDERS };

/** The owner of managed compute connections: the installation's own provider
 * accounts, which every organization without its own account uses and is
 * charged for (wiki features/managed-compute). Passed where an organization id
 * goes, it names those accounts. */
export const MANAGED_COMPUTE = 'installation';

/** The account a world's sealed reference names: a world made on managed
 * compute stays on the installation's account, whatever its organization
 * connects later. */
export function connectionScope(reference: { organizationId?: string; funding?: string }): string | undefined {
  return reference.funding === 'managed' ? MANAGED_COMPUTE : reference.organizationId;
}

/** What the account a world runs on allows a machine to be: the one it was
 * made on (`meta.funding`), whatever the organization connected since. */
export async function worldAccountLimits(store: Store, world: { kind: string; meta?: Record<string, unknown> },
  organizationId: string): Promise<EffectiveComputerLimits> {
  const scope = world.meta?.funding === 'managed' ? MANAGED_COMPUTE : organizationId;
  const connection = await store.getWorldProviderConnection(scope, world.kind)
    ?? (scope === organizationId ? await store.getWorldProviderConnection(MANAGED_COMPUTE, world.kind) : undefined);
  return computerLimits(world.kind, connection?.measuredLimits, connection?.config.limits);
}

/** What a sealed reference records about the account a world was made on. */
export function fundingRef(connection: { managed?: boolean } | undefined): { funding?: 'managed' } {
  return connection?.managed ? { funding: 'managed' } : {};
}
/** Self-hosted fallback keys, imported into the installation owner's connection at boot. */
const ENVIRONMENT_KEYS: Record<string, string> = { e2b: 'E2B_API_KEY', daytona: 'DAYTONA_API_KEY', fly: 'FLY_API_TOKEN', hetzner: 'HCLOUD_TOKEN',
  aws: 'KARMAX_AWS_KEY', gcp: 'KARMAX_GCP_KEY' };

export interface ResolvedWorldProviderConnection {
  organizationId?: string;
  provider: string;
  /** The installation's account (managed compute), not the organization's own. */
  managed?: boolean;
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
  & { credentialConfigured: boolean; limits: EffectiveComputerLimits; features: ComputerFeatures;
    /** Managed compute: the installation's account, offered to an organization
     * without its own (never editable from the organization). */
    managed?: boolean };

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

  private async view(value: WorldProviderConnection): Promise<WorldProviderConnectionView> {
    const { measuredLimits, ...rest } = value;
    return { ...rest, credentialConfigured: await this.broker.hasHandle(value.credentialHandle),
      limits: computerLimits(value.provider, measuredLimits, value.config.limits), features: accountFeatures(value.provider, measuredLimits) };
  }

  /** Every connection, with its limits. One never asked is asked now (briefly
   * waited for), so the Computer form's maximum is the account's own. An
   * organization's list also offers managed compute for every provider it
   * has not connected itself (`managed: true`). */
  async list(organizationId: string): Promise<WorldProviderConnectionView[]> {
    const own = await this.listOwn(organizationId);
    if (organizationId === MANAGED_COMPUTE) return own;
    // A disabled own account takes no new computers, so managed compute is offered beside it.
    const mine = new Set(own.filter((value) => value.enabled).map((value) => value.provider));
    const managed = (await this.managedConnections()).filter((value) => !mine.has(value.provider));
    return [...own, ...managed.map((value) => managedView(value))];
  }

  private async listOwn(organizationId: string): Promise<WorldProviderConnectionView[]> {
    const values = await this.store.listWorldProviderConnections(organizationId);
    const configured = await Promise.all(values.map((value) => this.broker.hasHandle(value.credentialHandle)));
    const unknown = values.filter((value, index) => value.enabled && configured[index] && needsProbe(value));
    if (unknown.length) {
      const probes = unknown.map((value) => this.probeOnce(organizationId, value.provider));
      await Promise.race([Promise.allSettled(probes), new Promise((resolve) => setTimeout(resolve, LIST_PROBE_WAIT_MS).unref())]);
      return Promise.all((await this.store.listWorldProviderConnections(organizationId)).map((value) => this.view(value)));
    }
    return Promise.all(values.map((value) => this.view(value)));
  }

  /** The installation's enabled managed compute accounts that have a key. */
  async managedConnections(): Promise<WorldProviderConnectionView[]> {
    // Asked like an organization's own, so "Any" knows what each one gives.
    return (await this.listOwn(MANAGED_COMPUTE)).filter((value) => value.enabled && value.credentialConfigured);
  }

  /** Whether new `provider` computers for this organization run on managed
   * compute: it has no enabled connection of its own and the installation
   * offers one. (A disabled own connection only keeps the computers made on it.) */
  async funding(organizationId: string | undefined, provider: string): Promise<'managed' | 'own' | undefined> {
    if (!organizationId) return undefined;
    const own = await this.store.getWorldProviderConnection(organizationId, provider);
    if (own?.enabled) return 'own';
    return (await this.managedConnections()).some((value) => value.provider === provider) ? 'managed' : undefined;
  }

  async get(organizationId: string, provider: string): Promise<WorldProviderConnectionView | undefined> {
    const value = (await this.store.getWorldProviderConnection(organizationId, provider));
    return value ? await this.view(value) : undefined;
  }

  /** The cloud accounts this organization can run a computer on: its own
   * connections and the managed compute it may use ("Any" chooses among them). */
  async reachable(organizationId: string): Promise<WorldProviderConnectionView[]> {
    return (await this.list(organizationId)).filter((view) => view.enabled && view.credentialConfigured
      && (CLOUD_WORLD_PROVIDERS as readonly string[]).includes(view.provider));
  }

  /** What a computer on `provider` may be for this organization. Self-hosted
   * computers have none; an unconnected provider has its documented ones.
   * For "Any", each size is the largest some reachable account allows. */
  async limits(organizationId: string | undefined, provider: string): Promise<EffectiveComputerLimits> {
    if (isAnyProvider(provider)) return organizationId ? anyLimits(await this.reachable(organizationId)) : { source: {} };
    let value = organizationId ? await this.store.getWorldProviderConnection(organizationId, provider) : undefined;
    if (!value?.enabled && organizationId && await this.funding(organizationId, provider) === 'managed')
      value = await this.store.getWorldProviderConnection(MANAGED_COMPUTE, provider);
    return computerLimits(provider, value?.measuredLimits, value?.config.limits);
  }

  /** Refuse a size this organization's account cannot give, before any machine is made. */
  async assertFits(organizationId: string | undefined, provider: string | undefined, spec: ComputerFitSpec): Promise<void> {
    if (!provider) return;
    if (isAnyProvider(provider)) return assertSomeFits(spec, organizationId ? await this.reachable(organizationId) : []);
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
    if (!(CLOUD_WORLD_PROVIDERS as readonly string[]).includes(input.provider)) throw new Error(`unsupported world provider: ${input.provider}`);
    const existing = (await this.store.getWorldProviderConnection(input.organizationId, input.provider));
    const handle = existing?.credentialHandle ?? worldProviderCredentialHandle(input.organizationId, input.provider);
    // Validate every non-secret field before rotating the vault handle. A bad
    // endpoint must leave the previous working credential/config untouched.
    const config = cleanConfig({ ...(existing?.config ?? {}), ...(input.config ?? {}) }, this.store.hosted);
    const key = input.apiKey?.trim();
    // A key in the wrong form is refused here, not at the first machine.
    if (key && input.provider === 'aws') (await import('./aws.js')).awsCredentials(key);
    if (key && input.provider === 'gcp') (await import('./gcp.js')).gcpServiceAccount(key);
    if (key) (await this.broker.registerHandle(handle, key, input.organizationId === MANAGED_COMPUTE
      ? INSTALLATION_SCOPE : organizationScope(input.organizationId)));
    if (!key && !await this.broker.hasHandle(handle)) throw new Error(`${providerName(input.provider)} API key is required`);
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

  /** The account a computer runs on: the organization's own connection;
   * else, when it has none, the installation's managed compute account (the
   * world records that, so `MANAGED_COMPUTE` resolves it ever after); else,
   * self-hosted only, an environment key. A disabled own connection still
   * serves the computers made on it, never a `new` one: those go to managed
   * compute as if it were not there, so an organization moves to managed
   * compute without stranding a computer on a key that cannot see it. */
  async resolve(organizationId: string | undefined, provider: string, options: { new?: boolean } = {}): Promise<ResolvedWorldProviderConnection> {
    const value = organizationId ? (await this.store.getWorldProviderConnection(organizationId, provider)) : undefined;
    const serves = value && (value.enabled || (!options.new && organizationId !== MANAGED_COMPUTE));
    if (serves && await this.broker.hasHandle(value.credentialHandle)) {
      return {
        organizationId,
        provider,
        ...(organizationId === MANAGED_COMPUTE ? { managed: true } : {}),
        apiKey: await this.broker.resolve(value.credentialHandle, { caps: [`use-credential:${value.credentialHandle}`] }),
        config: cleanConfig(value.config, this.store.hosted),
        limits: computerLimits(provider, value.measuredLimits, value.config.limits),
        recordLimits: (limits) => this.recordLimits(organizationId!, provider, limits),
      };
    }
    if (organizationId === MANAGED_COMPUTE)
      throw new Error(`${BRAND}'s ${providerName(provider)} computers are not available`);
    // An organization without its own account uses the installation's managed
    // compute account when there is one; usage there is charged to the
    // organization's compute allowance (src/world/managed-compute.ts).
    if ((!value || (!value.enabled && options.new)) && organizationId) {
      const managed = await this.store.getWorldProviderConnection(MANAGED_COMPUTE, provider);
      if (managed?.enabled && await this.broker.hasHandle(managed.credentialHandle))
        return { ...(await this.resolve(MANAGED_COMPUTE, provider)), organizationId, managed: true,
          recordLimits: (limits) => this.recordLimits(MANAGED_COMPUTE, provider, limits) };
    }
    if (value && !value.enabled) throw new Error(`${providerName(provider)} is disabled for this organization`);
    // Hosted organizations otherwise connect their own account: a bootstrap
    // environment key is never a centrally funded rail (importEnvironment()
    // moves it into the installation owner's explicit connection).
    if (this.store.hosted)
      throw new Error(`${providerName(provider)} is not connected for this organization`);
    // Environment credentials remain a self-hosted compatibility fallback.
    const apiKey = ENVIRONMENT_KEYS[provider] ? process.env[ENVIRONMENT_KEYS[provider]!] : undefined;
    if (!apiKey) throw new Error(`${providerName(provider)} is not connected for this organization`);
    return { organizationId, provider, apiKey, config: environmentConfig(provider) };
  }

  async available(organizationId: string | undefined, provider: string): Promise<boolean> {
    // "Any" is always a valid choice: it uses whatever the organization can reach.
    if (isAnyProvider(provider)) return true;
    try { (await this.resolve(organizationId, provider, { new: true })); return true; }
    catch { return false; }
  }

  /** Prove the key works, then ask the account what a computer may be. */
  async test(organizationId: string, provider: string): Promise<WorldProviderConnectionView> {
    const connection = (await this.resolve(organizationId, provider));
    try {
      if (!(CLOUD_WORLD_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`unsupported world provider: ${provider}`);
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
    for (const [provider, variable] of Object.entries(ENVIRONMENT_KEYS)) {
      const apiKey = process.env[variable];
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
    } else if (provider === 'fly') {
      const { FlyDriver } = await import('./fly.js');
      await new FlyDriver().test(connection);
    } else if (provider === 'hetzner') {
      const { HetznerDriver } = await import('./hetzner.js');
      await new HetznerDriver().test(connection);
    } else if (provider === 'aws') {
      const { AwsDriver } = await import('./aws.js');
      await new AwsDriver().test(connection);
    } else if (provider === 'gcp') {
      const { GcpDriver } = await import('./gcp.js');
      await new GcpDriver().test(connection);
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
    // Fly's limits are fixed and documented (computer-limits.ts); Hetzner's
    // largest machine depends on the server types offered at the location.
    if (provider === 'hetzner') {
      const { HetznerDriver } = await import('./hetzner.js');
      return new HetznerDriver().limits(connection);
    }
    // AWS: the largest instance of karmax's families in the region; Google
    // Cloud: E2's largest machine within the region's CPU quota.
    if (provider === 'aws') {
      const { AwsDriver } = await import('./aws.js');
      return new AwsDriver().limits(connection);
    }
    if (provider === 'gcp') {
      const { GcpDriver } = await import('./gcp.js');
      return new GcpDriver().limits(connection);
    }
    return {};
  },
};

/** What `assertFits` judges: the sizes, and the outbound network asked for. */
export type ComputerFitSpec = MachineShape & { network?: { unrestricted?: boolean; basic?: boolean } };

/** An account whose limits were never read, or a Daytona account read before
 * its internet was (Tiers 1 and 2 reach essential services only). */
function needsProbe(value: WorldProviderConnection): boolean {
  return !value.measuredLimits || (value.provider === 'daytona' && !value.measuredLimits.network);
}

/** Each size, the largest any reachable account allows ("Any"'s ceiling). */
export function anyLimits(views: Array<{ limits: ComputerLimits }>): EffectiveComputerLimits {
  const out: EffectiveComputerLimits = { source: {} };
  for (const key of ['cpu', 'memoryMb', 'diskGb'] as const) {
    const values = views.map((view) => view.limits[key]).filter((value): value is number => value != null);
    if (values.length === views.length && values.length) { out[key] = Math.max(...values); out.source[key] = 'provider'; }
  }
  return out;
}

/** Refuse a size no single reachable account can give. Nothing reachable: nothing to judge. */
function assertSomeFits(spec: ComputerFitSpec, all: Array<{ provider: string; limits: ComputerLimits; features?: ComputerFeatures }>): void {
  if (!all.length) return;
  // Only accounts that give the outbound network asked for: an allowlist, or
  // full internet unless basic is enough.
  const views = all.filter((view) => spec.network?.unrestricted === false ? view.features?.allowlist !== false
    : spec.network?.basic || view.features?.internet !== 'basic');
  if (!views.length) throw new Error(spec.network?.unrestricted === false
    ? 'None of the computers this organization can use has an outbound allowlist'
    : 'None of the computers this organization can use has full internet; choose "Basic internet is enough"');
  const failures: string[] = [];
  for (const view of views) {
    try { assertComputerFits(spec, view.limits, view.provider); return; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  const most = anyLimits(views);
  const gb = (mb: number) => (Number.isInteger(mb / 1024) ? String(mb / 1024) : (mb / 1024).toFixed(1));
  if (spec.diskGb != null && most.diskGb != null && spec.diskGb > most.diskGb)
    throw new Error(`Disk can be at most ${most.diskGb} GB on the computers this organization can use`);
  if (spec.memoryMb != null && most.memoryMb != null && spec.memoryMb > most.memoryMb)
    throw new Error(`Memory can be at most ${gb(most.memoryMb)} GB on the computers this organization can use`);
  if (spec.cpu != null && most.cpu != null && spec.cpu > most.cpu)
    throw new Error(`CPU can be at most ${most.cpu} on the computers this organization can use`);
  throw new Error(`No one computer this organization can use is that big: ${failures.join('; ')}`);
}

/** Managed compute as an organization sees it: the provider, its limits and
 * features; never the installation's key, templates or capacity. */
function managedView(value: WorldProviderConnectionView): WorldProviderConnectionView {
  return { id: `managed:${value.provider}`, organizationId: MANAGED_COMPUTE, provider: value.provider, name: providerName(value.provider),
    credentialHandle: '', config: value.config.region ? { region: value.config.region } : {}, enabled: true,
    status: value.status === 'error' ? 'error' : 'ready', createdAt: value.createdAt, updatedAt: value.updatedAt,
    // The installation's budget (its CPUs and machines at once) is its own business.
    credentialConfigured: true, limits: withoutPool(value.limits), features: value.features, managed: true } as WorldProviderConnectionView;
}

function withoutPool(limits: EffectiveComputerLimits): EffectiveComputerLimits {
  const { pool: _pool, ...rest } = limits;
  return rest;
}

function cleanLimits(value: unknown): WorldProviderConnection['config']['limits'] {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const numbers = (input: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys
    .map((key) => [key, Number(input[key])] as const)
    .filter(([, number]) => Number.isInteger(number) && number > 0 && number <= 1_000_000));
  const out: NonNullable<WorldProviderConnection['config']['limits']> = numbers(raw, ['cpu', 'memoryMb', 'diskGb']);
  // The account's budget, where the provider cannot tell it.
  const pool = numbers(raw.pool && typeof raw.pool === 'object' ? raw.pool as Record<string, unknown> : {}, ['cpu', 'machines', 'diskGb']);
  if (Object.keys(pool).length) out.pool = pool;
  return Object.keys(out).length ? out : undefined;
}

/** An organization's most of a managed account's budget while another waits, in percent. */
export const DEFAULT_MANAGED_SHARE = 50;
function share(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? number : undefined;
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
    ...(slug(value.region, 'region') ? { region: slug(value.region, 'region') } : {}),
    ...(slug(value.organization, 'organization') ? { organization: slug(value.organization, 'organization') } : {}),
    ...(limits ? { limits } : {}),
    ...(share(value.share) ? { share: share(value.share) } : {}),
  };
}

/** A Fly region, Hetzner location, AWS region or Google Cloud zone (`fra`,
 * `fsn1`, `eu-central-1`, `europe-west3-a`), a Fly organization slug. */
function slug(input: unknown, label: string): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const value = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error(`${label} must be a short lowercase name like ${label === 'region' ? 'fra' : 'personal'}`);
  return value;
}

function environmentConfig(provider: string): WorldProviderConnection['config'] {
  if (provider === 'fly') return { region: process.env.KARMAX_FLY_REGION, organization: process.env.KARMAX_FLY_ORG,
    image: process.env.KARMAX_FLY_IMAGE };
  if (provider === 'hetzner') return { region: process.env.KARMAX_HETZNER_LOCATION, image: process.env.KARMAX_HETZNER_IMAGE };
  if (provider === 'aws') return { region: process.env.KARMAX_AWS_REGION, image: process.env.KARMAX_AWS_IMAGE };
  if (provider === 'gcp') return { region: process.env.KARMAX_GCP_ZONE, image: process.env.KARMAX_GCP_IMAGE };
  return provider === 'e2b'
    ? { template: process.env.KARMAX_E2B_TEMPLATE,
        desktopTemplate: process.env.KARMAX_E2B_DESKTOP_TEMPLATE }
    : { snapshot: process.env.KARMAX_DAYTONA_SNAPSHOT, image: process.env.KARMAX_DAYTONA_IMAGE,
        desktopSnapshot: process.env.KARMAX_DAYTONA_DESKTOP_SNAPSHOT,
        desktopImage: process.env.KARMAX_DAYTONA_DESKTOP_IMAGE,
        apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET };
}

export function providerName(provider: string): string {
  return ({ e2b: 'E2B', daytona: 'Daytona', fly: 'Fly.io', hetzner: 'Hetzner Cloud', aws: 'AWS', gcp: 'Google Cloud' } as Record<string, string>)[provider] ?? provider;
}
