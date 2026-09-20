import * as __asyncCollections from '../util/async-collections.js';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { StorageLocation, StorageLocationUsage } from '../domain/types.js';
import type { Store } from './db.js';
import { S3ObjectStore, type ObjectStore } from './objects.js';
import { newId } from '../util/id.js';

export function managedStorageLocationId(organizationId: string): string {
  return `storage-managed-${organizationId}`;
}

/** Organization storage control plane. The operator store remains the bounded,
 * zero-configuration default; customer S3 credentials never enter SQLite. */
export class StorageLocationService {
  private stores = new Map<string, ObjectStore>();

  constructor(private store: Store, private managed: ObjectStore, private broker: CredentialBroker,
    private managedQuotaBytes?: number, private allowPrivateEndpoints = true) {}

  async ensureManaged(organizationId: string): Promise<StorageLocation> {
    const id = managedStorageLocationId(organizationId);
    const existing = (await this.store.getStorageLocation(id));
    if (existing) {
      (await this.store.backfillManagedStorageLocation(organizationId, id));
      if (existing.quotaBytes !== this.managedQuotaBytes)
        return (await this.store.saveStorageLocation({ ...existing, quotaBytes: this.managedQuotaBytes, updatedAt: Date.now() }));
      return existing;
    }
    const created = (await this.store.saveStorageLocation({ id, organizationId, name: 'Managed storage', kind: 'managed',
      config: {}, isDefault: (await this.store.listStorageLocations(organizationId)).length === 0,
      status: 'ready', quotaBytes: this.managedQuotaBytes, createdAt: Date.now(), updatedAt: Date.now() }));
    (await this.store.backfillManagedStorageLocation(organizationId, id));
    return created;
  }

  async list(organizationId: string): Promise<Array<Omit<StorageLocation, 'credentialHandle'> & { credentialConfigured: boolean; usage: StorageLocationUsage }>> {
    (await this.ensureManaged(organizationId));
    return (await __asyncCollections.map((await this.store.listStorageLocations(organizationId)), async ({ credentialHandle, ...location }) => ({
      ...location, credentialConfigured: Boolean(credentialHandle && this.broker.hasHandle(credentialHandle)),
      usage: (await this.store.storageLocationUsage(location.id)),
    })));
  }

  async view(organizationId: string, id: string): Promise<Omit<StorageLocation, 'credentialHandle'>
    & { credentialConfigured: boolean; usage: StorageLocationUsage }> {
    const { credentialHandle, ...location } = (await this.ownedLocation(organizationId, id));
    return { ...location, credentialConfigured: Boolean(credentialHandle && this.broker.hasHandle(credentialHandle)),
      usage: (await this.store.storageLocationUsage(id)) };
  }

  async defaultLocation(organizationId: string): Promise<StorageLocation> {
    (await this.ensureManaged(organizationId));
    return (await this.store.listStorageLocations(organizationId)).find((candidate) => candidate.isDefault)
      ?? (await this.ensureManaged(organizationId));
  }

  async requireForOrganization(organizationId: string, id?: string): Promise<StorageLocation> {
    const location = (await this.ownedLocation(organizationId, id));
    if (location.kind === 's3' && location.status !== 'ready')
      throw new Error(location.status === 'error'
        ? `storage location is unavailable: ${location.lastError ?? 'connection failed'}`
        : 'storage location must be tested before use');
    return location;
  }

  async connectS3(organizationId: string, input: { id?: string; name: string; endpoint: string; bucket: string;
    region?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string;
  }): Promise<StorageLocation> {
    (await this.ensureManaged(organizationId));
    const endpoint = normalizedEndpoint(input.endpoint, this.allowPrivateEndpoints);
    const bucket = input.bucket.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,254}$/.test(bucket)) throw new Error('invalid S3 bucket');
    const prefix = normalizedPrefix(input.prefix ?? `karmax/${organizationId}`);
    const existing = input.id ? (await this.store.getStorageLocation(input.id)) : undefined;
    if (existing && (existing.organizationId !== organizationId || existing.kind !== 's3'))
      throw new Error('storage location does not belong to organization');
    const id = existing?.id ?? newId('storage');
    const handle = existing?.credentialHandle ?? `storage:${id}:s3`;
    if (input.accessKeyId || input.secretAccessKey) {
      if (!input.accessKeyId || !input.secretAccessKey) throw new Error('both S3 access key fields are required');
      (await this.broker.registerHandle(handle, JSON.stringify({ accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey, sessionToken: input.sessionToken })));
    } else if (!this.broker.hasHandle(handle)) throw new Error('S3 access key is required');
    const value = (await this.store.saveStorageLocation({ id, organizationId, name: input.name.trim() || 'Customer S3', kind: 's3',
      config: { endpoint, bucket, region: input.region?.trim() || 'us-east-1', prefix }, credentialHandle: handle,
      // A customer bucket cannot become a data-plane default until the explicit
      // write/read/delete probe succeeds. Preserve an existing default while it
      // is being rotated, but runtime use pauses until the re-test passes.
      isDefault: existing?.isDefault ?? false, status: 'untested',
      createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() }));
    this.stores.delete(id);
    return value;
  }

  async setDefault(organizationId: string, id: string): Promise<StorageLocation> {
    const location = (await this.requireForOrganization(organizationId, id));
    if (location.status !== 'ready') throw new Error('test the storage location before making it the default');
    return (await this.store.saveStorageLocation({ ...location, isDefault: true, updatedAt: Date.now() }));
  }

  async test(organizationId: string, id: string): Promise<StorageLocation> {
    const location = (await this.ownedLocation(organizationId, id));
    if (location.kind === 'managed') return location;
    const key = `.karmax-connection-test/${crypto.randomBytes(12).toString('hex')}`;
    try {
      const objects = (await this.objectStore(location.id));
      const expected = Buffer.from('karmax storage connection test');
      await objects.put(key, expected);
      try {
        const actual = await objects.get(key);
        if (!actual.equals(expected)) throw new Error('S3 read-back did not match the test object');
      } catch (error) {
        // A failed read must not strand the successfully written probe. Keep
        // the original failure if cleanup fails too; a retry probes a new key.
        await objects.delete(key).catch(() => {});
        throw error;
      }
      await objects.delete(key);
      return (await this.store.saveStorageLocation({ ...location, status: 'ready', lastCheckedAt: Date.now(),
        lastError: undefined, updatedAt: Date.now() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (await this.store.saveStorageLocation({ ...location, status: 'error', lastCheckedAt: Date.now(),
        lastError: message.slice(0, 500), updatedAt: Date.now() }));
      throw new Error(`could not use customer S3 storage: ${message}`);
    }
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const location = (await this.ownedLocation(organizationId, id));
    if (location.kind === 'managed') throw new Error('managed storage cannot be removed');
    (await this.store.deleteStorageLocation(id));
    if (location.credentialHandle) (await this.broker.deleteHandle(location.credentialHandle));
    this.stores.delete(id);
  }

  async objectStore(id: string): Promise<ObjectStore> {
    const location = (await this.store.getStorageLocation(id));
    if (!location) throw new Error('storage location not found');
    if (location.kind === 'managed') return this.managed;
    const cached = this.stores.get(id);
    if (cached) return cached;
    if (!location.credentialHandle) throw new Error('customer storage credential is missing');
    const secret = JSON.parse(this.broker.resolve(location.credentialHandle, { caps: [`use-credential:${location.credentialHandle}`] }));
    const objects = new PrefixedObjectStore(new S3ObjectStore({ endpoint: location.config.endpoint!, bucket: location.config.bucket!,
      region: location.config.region ?? 'us-east-1', accessKeyId: String(secret.accessKeyId),
      secretAccessKey: String(secret.secretAccessKey), sessionToken: secret.sessionToken ? String(secret.sessionToken) : undefined }),
      location.config.prefix ?? '');
    this.stores.set(id, objects);
    return objects;
  }

  async reserveUpload(uploadId: string, organizationId: string, locationId: string, bytes: number, expiresAt: number): Promise<void> {
    (await this.ownedLocation(organizationId, locationId));
    (await this.store.reserveStorageUpload(uploadId, organizationId, locationId, bytes, expiresAt));
  }

  async releaseUpload(uploadId: string): Promise<void> { (await this.store.releaseStorageUpload(uploadId)); }

  private async ownedLocation(organizationId: string, id?: string): Promise<StorageLocation> {
    const location = id ? (await this.store.getStorageLocation(id)) : (await this.defaultLocation(organizationId));
    if (!location || location.organizationId !== organizationId) throw new Error('storage location does not belong to organization');
    return location;
  }
}

class PrefixedObjectStore implements ObjectStore {
  constructor(private inner: ObjectStore, private prefix: string) {}
  put(key: string, data: Buffer, contentType?: string): Promise<void> { return this.inner.put(this.key(key), data, contentType); }
  get(key: string): Promise<Buffer> { return this.inner.get(this.key(key)); }
  delete(key: string): Promise<void> { return this.inner.delete(this.key(key)); }
  private key(key: string): string { return this.prefix ? `${this.prefix}/${key}` : key; }
}

function normalizedEndpoint(value: string, allowPrivate: boolean): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('S3 endpoint must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('S3 endpoint must not contain credentials, query, or fragment');
  if (!allowPrivate) {
    if (url.protocol !== 'https:') throw new Error('hosted customer S3 endpoints must use https');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || privateAddress(host)) throw new Error('hosted customer S3 endpoints must use a public address');
  }
  return url.toString().replace(/\/$/, '');
}

function privateAddress(host: string): boolean {
  if (!isIP(host)) return false;
  if (host.includes(':')) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')
    || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  const octets = host.split('.').map(Number);
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 0;
}

function normalizedPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (prefix.includes('..') || prefix.includes('\\')) throw new Error('invalid S3 prefix');
  return prefix;
}
