import type { CredentialBroker } from '../autonomy/broker.js';
import type { WorldProviderConnection } from '../domain/types.js';
import type { Store } from '../store/db.js';

export interface ResolvedWorldProviderConnection {
  organizationId?: string;
  provider: string;
  apiKey: string;
  config: WorldProviderConnection['config'];
}

export const worldProviderCredentialHandle = (organizationId: string, provider: string): string =>
  `world-provider:${organizationId}:${provider}:api-key`;

/** Organization-scoped provider onboarding. Metadata is durable and safe to
 * expose; the API key is write-only and remains in the encrypted broker. */
export class WorldProviderConnectionService {
  constructor(private store: Store, private broker: CredentialBroker) {}

  async list(organizationId: string): Promise<Array<WorldProviderConnection & { credentialConfigured: boolean }>> {
    return (await this.store.listWorldProviderConnections(organizationId)).map((value) => ({
      ...value,
      credentialConfigured: this.broker.hasHandle(value.credentialHandle),
    }));
  }

  async get(organizationId: string, provider: string): Promise<(WorldProviderConnection & { credentialConfigured: boolean }) | undefined> {
    const value = (await this.store.getWorldProviderConnection(organizationId, provider));
    return value ? { ...value, credentialConfigured: this.broker.hasHandle(value.credentialHandle) } : undefined;
  }

  async save(input: {
    organizationId: string;
    provider: string;
    apiKey?: string;
    name?: string;
    config?: WorldProviderConnection['config'];
    enabled?: boolean;
  }): Promise<WorldProviderConnection & { credentialConfigured: boolean }> {
    if (!['e2b', 'daytona'].includes(input.provider)) throw new Error(`unsupported world provider: ${input.provider}`);
    const existing = (await this.store.getWorldProviderConnection(input.organizationId, input.provider));
    const handle = existing?.credentialHandle ?? worldProviderCredentialHandle(input.organizationId, input.provider);
    // Validate every non-secret field before rotating the vault handle. A bad
    // endpoint must leave the previous working credential/config untouched.
    const config = cleanConfig({ ...(existing?.config ?? {}), ...(input.config ?? {}) });
    const key = input.apiKey?.trim();
    if (key) (await this.broker.registerHandle(handle, key));
    if (!key && !this.broker.hasHandle(handle)) throw new Error(`${providerName(input.provider)} API key is required`);
    const value = (await this.store.upsertWorldProviderConnection({
      organizationId: input.organizationId,
      provider: input.provider,
      name: input.name,
      credentialHandle: handle,
      config,
      enabled: input.enabled,
    }));
    return { ...value, credentialConfigured: true };
  }

  async resolve(organizationId: string | undefined, provider: string): Promise<ResolvedWorldProviderConnection> {
    const value = organizationId ? (await this.store.getWorldProviderConnection(organizationId, provider)) : undefined;
    if (value?.enabled && this.broker.hasHandle(value.credentialHandle)) {
      return {
        organizationId,
        provider,
        apiKey: this.broker.resolve(value.credentialHandle, { caps: [`use-credential:${value.credentialHandle}`] }),
        config: value.config,
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

  async test(organizationId: string, provider: string): Promise<WorldProviderConnection & { credentialConfigured: boolean }> {
    const connection = (await this.resolve(organizationId, provider));
    try {
      if (provider === 'e2b') {
        const { Sandbox } = await import('e2b');
        const page = Sandbox.list({ apiKey: connection.apiKey, limit: 1 });
        await page.nextItems();
      } else if (provider === 'daytona') {
        const { Daytona } = await import('@daytona/sdk');
        const client = new Daytona({ apiKey: connection.apiKey, apiUrl: connection.config.apiUrl, target: connection.config.target });
        try { await client.list()[Symbol.asyncIterator]().next(); }
        finally { await client[Symbol.asyncDispose]().catch(() => undefined); }
      } else {
        throw new Error(`unsupported world provider: ${provider}`);
      }
      (await this.store.setWorldProviderConnectionStatus(organizationId, provider, 'ready'));
    } catch (error) {
      const unsafe = error instanceof Error ? error.message : String(error);
      const message = unsafe.split(connection.apiKey).join('[redacted]').slice(0, 2_000);
      (await this.store.setWorldProviderConnectionStatus(organizationId, provider, 'error', message));
      throw new Error(`${providerName(provider)} connection failed: ${message}`);
    }
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

function cleanConfig(value: WorldProviderConnection['config']): WorldProviderConnection['config'] {
  const one = (input: unknown, max = 500) => typeof input === 'string' && input.trim() ? input.trim().slice(0, max) : undefined;
  const apiUrl = one(value.apiUrl);
  if (apiUrl) {
    const url = new URL(apiUrl);
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
