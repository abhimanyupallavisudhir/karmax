import crypto from 'node:crypto';
import { transferResourceChunk } from './resource-transfer.js';
import { forEachConcurrent } from '../util/async-batch.js';
import { timed } from '../timing/index.js';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import type { CredentialBroker } from '../autonomy/broker.js';
import { organizationScope } from '../autonomy/vault-keys.js';
import type { IgnoredResourceInventory, Project, ResourceAttachment, ResourceAccess, ResourceCandidate,
  ResourceChangeSummary, ResourcePublishPolicy, ResourceRevision, ResourceTarget } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { StorageLocationService } from '../store/storage-locations.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { ExecOptions, ExecResult, World, WorldHandle, WorldHttpRequest, WorldHttpResponse,
  WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec } from './types.js';
import { worldRelativePath, worldRepos, worldWorkingDirectory, worldWorkingRelativePath } from './types.js';
import type { WorldRegistry } from './registry.js';
import { QRY_RESOURCE_PUBLISH, RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, SIG_CANCEL_RESOURCE_PUBLISH,
  SIG_ENQUEUE_RESOURCE_PUBLISH, SIG_RELEASE_RESOURCE_PUBLISH,
  resourcePublishCoordinatorId } from '../coordinators/names.js';
import type { ResourcePublishView } from '../coordinators/resource-publish.js';
import { credentialResource, resourceSecretHandle, snapshotResource } from '../domain/resource-drivers.js';
import { VaultItems, itemHandle, type VaultFieldName } from '../autonomy/vault-items.js';
import { handleRef, recordSecretRefs } from '../autonomy/task-secrets.js';
import { ensureWorldExcluded } from './secret-exclude.js';
import { expandPath } from '../util/expand.js';
import { managedRepoPath } from './worktree.js';
import { screenEnvironment, type SkippedEnv } from '../util/work-env.js';
import { CHUNK_BYTES, chunkObjectKey, openCompressed, openDeterministic, openRandom,
  organizationKey, organizationKeyHandle, sha256 } from './chunk-store.js';
import { REPOSITORY_ROUTE, RepositoryTokens, ResourceRepositoryServer, parseRepositoryName } from './resource-repository.js';
import { RESTIC_ENGINE, ResticResources, resticRef, type Repository, type ResticCapture, type ResticPlace } from './restic-engine.js';

const COPY_GLOB_SECRET_BYTES = 64 * 1024;
const PACK_BYTES = CHUNK_BYTES;

/** A file is its own chunks, or (version 2, when small) a slice of a shared pack. */
type SnapshotEntry = { path: string; bytes: number; sha256: string } & ({ chunks: string[] } | { pack: number; offset: number });
/** Version 3 adds per-capture keys: `keyed` names the key of every object not
 * under the organization key, and `keys` holds those keys, sealed with the
 * manifest under the organization key (wiki planned/direct-resource-uploads). */
interface SnapshotManifest { version: 1 | 2 | 3; attachmentId: string; files: SnapshotEntry[]; packs?: string[];
  keys?: Record<string, CaptureKey>; keyed?: Record<string, string>; rootDigest: string; bytes: number }
/** A key a world held while capturing, and the task it was made for. */
interface CaptureKey { key: string; task?: string }
interface SnapshotRef { objectKey: string; sha256: string; storageLocationId?: string }
/** A file for an import: an upload or a copied-over setting. */
export interface SnapshotInputFile { path: string; data: Buffer | AsyncIterable<Buffer>; bytes?: number }
export interface SnapshotVerification {
  status: 'complete' | 'partial' | 'failed';
  manifestVerified: boolean;
  rootDigest?: string;
  totalFiles?: number;
  totalBytes?: number;
  offset: number;
  nextOffset?: number;
  verifiedFiles: number;
  verifiedBytes: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  issue?: 'unreadable-or-corrupt' | 'byte-limit' | 'invalid-offset';
}
const VERIFY_MAX_BYTES = 256 * 1024 * 1024;

export interface CopyGlobsMigrationResult {
  environmentSecrets: string[];
  fileSecrets: string[];
  data: string[];
  reused: string[];
  skipped: string[];
}

export interface ProposedResourceCandidate {
  candidate: ResourceCandidate;
  attachment: ResourceAttachment;
  revision?: ResourceRevision;
}

/** A candidate that no retry can stage: its world or path is gone. */
class UnstageableCandidate extends Error {}

export interface RestoreOptions { signal?: AbortSignal }

/** How far staging is through one candidate (`index` of `count`). */
export interface StagingProgress { path: string; index: number; count: number; files: number; totalFiles: number; bytes: number; totalBytes: number }

export interface StagedResourceCandidates {
  staged: string[];
  failed: Array<{ candidateId: string; sourcePath?: string; error: string }>;
}

/** Resource versions saved before restic (`object-snapshot@1`): read,
 * verified and deleted here until convertLegacyRevisions has moved them into
 * restic repositories; nothing writes them any more. */
export interface SnapshotEngine {
  readonly id: string;
  /** Release what an interrupted pre-restic capture of this attachment saved. */
  abandonProgress?(attachment: ResourceAttachment): Promise<void>;
  restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options?: RestoreOptions): Promise<void>;
  manifest(revision: ResourceRevision): Promise<SnapshotManifest>;
  verify?(revision: ResourceRevision, offset: number, limit: number): Promise<SnapshotVerification>;
  /** `owner` releases a capture whose attachment row is already gone. */
  delete?(revision: ResourceRevision, owner?: ResourceAttachment): Promise<void>;
}

/** The pre-restic engine: tenant-keyed, encrypted content-addressed chunks over
 * the configured object store, described by a sealed manifest per revision. */
export class ObjectSnapshotEngine implements SnapshotEngine {
  readonly id = 'object-snapshot@1';
  constructor(private objects: ObjectStore, private broker: CredentialBroker,
    private storageLocations?: StorageLocationService) {}

  async objectStoreForAttachment(attachment: ResourceAttachment): Promise<ObjectStore> {
    const id = (await this.storageLocations?.requireForOrganization(attachment.organizationId, attachment.storageLocationId))?.id
      ?? attachment.storageLocationId;
    return id && this.storageLocations ? (await this.storageLocations.objectStore(id)) : this.objects;
  }

  /** Release what a capture interrupted before restic held (its kv progress record). */
  async abandonProgress(attachment: ResourceAttachment): Promise<void> {
    if (!this.progressStore) return;
    const held = await takeProgress(this.progressStore, await this.key(attachment.organizationId, false)
      .catch(() => undefined), attachment.id);
    if (!held?.ids.length) return;
    const objects = held.storageLocationId && this.storageLocations
      ? (await this.storageLocations.objectStore(held.storageLocationId)) : this.objects;
    const zero = (await this.chunkAccounting?.release(attachment.organizationId, held.ids)) ?? [];
    await Promise.allSettled(zero.map((chunkId) => objects.delete(chunkObjectKey(attachment.organizationId, chunkId))));
  }

  async restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options: RestoreOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const manifest = await this.manifest(revision);
    const relayed = manifest.files;
    // Bound memory and request fan-out. Chunks of each file remain ordered;
    // independent files can transfer together. Settle all writes before cleanup.
    const packs = await this.packReader(revision, manifest);
    await forEachConcurrent(relayed, async file => {
      options.signal?.throwIfAborted();
      let offset = 0;
      let buffered: Buffer[] = [];
      let bytes = 0;
      const flush = async () => {
        options.signal?.throwIfAborted();
        await write(file.path, Buffer.concat(buffered, bytes), offset);
        options.signal?.throwIfAborted();
        offset += bytes; buffered = []; bytes = 0;
      };
      for await (const data of this.readFile(revision, manifest, file, packs)) {
        options.signal?.throwIfAborted();
        buffered.push(data); bytes += data.length;
        if (bytes >= 2 * CHUNK_BYTES) await flush();
      }
      if (buffered.length) await flush();
    }, 4);
  }

  private async *readFile(revision: ResourceRevision, manifest: SnapshotManifest, file: SnapshotEntry,
    packs: (index: number) => Promise<Buffer>): AsyncIterable<Buffer> {
    if ('pack' in file) {
      const data = (await packs(file.pack)).subarray(file.offset, file.offset + file.bytes);
      if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error('resource snapshot integrity mismatch');
      yield data;
      return;
    }
    const attachment = (await this.attachmentFor(revision));
    const key = await this.key(attachment.organizationId, false);
    const objects = (await this.objectsForRevision(revision));
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    for (const chunkId of file.chunks) {
      const encrypted = await timed('resource.chunk-read', () => objects.get(chunkObjectKey(attachment.organizationId, chunkId)));
      const data = openDeterministic(objectKey(manifest, key, chunkId), chunkId, encrypted);
      if (data.length !== Math.min(CHUNK_BYTES, file.bytes - bytes))
        throw new Error('resource chunk size mismatch');
      digest.update(data);
      bytes += data.length;
      yield data;
    }
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256)
      throw new Error('resource snapshot integrity mismatch');
  }

  /** Opens a manifest's packs on demand. Files are in path order and packs were
   * filled in path order, so a few recent packs serve every concurrent reader. */
  private async packReader(revision: ResourceRevision, manifest: SnapshotManifest): Promise<(index: number) => Promise<Buffer>> {
    if (!manifest.packs?.length) return async () => { throw new Error('resource manifest has no packs'); };
    const attachment = (await this.attachmentFor(revision));
    const key = await this.key(attachment.organizationId, false);
    const objects = (await this.objectsForRevision(revision));
    const cached = new Map<string, Promise<Buffer>>();
    return async (index) => {
      const id = manifest.packs![index]!;
      let plain = cached.get(id);
      if (!plain) {
        plain = timed('resource.chunk-read', () => objects.get(chunkObjectKey(attachment.organizationId, id)))
          .then((sealed) => openCompressed(objectKey(manifest, key, id), id, sealed, PACK_BYTES));
        cached.set(id, plain);
        plain.catch(() => cached.delete(id));
        while (cached.size > 8) cached.delete(cached.keys().next().value!);
      }
      return plain;
    };
  }

  async verify(revision: ResourceRevision, offset: number, limit: number): Promise<SnapshotVerification> {
    const result: SnapshotVerification = { status: 'failed', manifestVerified: false, offset,
      verifiedFiles: 0, verifiedBytes: 0, files: [] };
    try {
      const manifest = await this.manifest(revision);
      Object.assign(result, { manifestVerified: true, rootDigest: manifest.rootDigest,
        totalFiles: manifest.files.length, totalBytes: manifest.bytes });
      if (offset > manifest.files.length) return { ...result, issue: 'invalid-offset' };
      const packs = await this.packReader(revision, manifest);
      for (const file of manifest.files.slice(offset, offset + limit)) {
        if (result.verifiedBytes + file.bytes > VERIFY_MAX_BYTES) {
          result.issue = 'byte-limit';
          break;
        }
        // Do not retain plaintext. Exhaustion also checks empty files and the final hash.
        for await (const _data of this.readFile(revision, manifest, file, packs)) { /* checked by engine */ }
        result.files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
        result.verifiedFiles++;
        result.verifiedBytes += file.bytes;
      }
      const end = offset + result.verifiedFiles;
      result.status = offset === 0 && end === manifest.files.length ? 'complete' : 'partial';
      if (end < manifest.files.length) result.nextOffset = end;
    } catch {
      // Object-store exceptions may contain signed URLs, paths or provider response bodies.
      result.status = 'failed';
      result.issue = 'unreadable-or-corrupt';
    }
    return result;
  }

  async manifest(revision: ResourceRevision, owner?: ResourceAttachment): Promise<SnapshotManifest> {
    const attachment = (await this.attachmentFor(revision, owner));
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    if (typeof ref.objectKey !== 'string'
      || !ref.objectKey.startsWith(`resources/${attachment.organizationId}/manifests/${attachment.id}/`)
      || ref.objectKey.includes('..') || (ref.storageLocationId && ref.storageLocationId !== revision.storageLocationId))
      throw new Error('resource reference does not match revision');
    const encrypted = await (await this.objectsForRevision(revision, ref, owner)).get(ref.objectKey);
    if (sha256(encrypted) !== ref.sha256) throw new Error('resource manifest integrity mismatch');
    const manifest = JSON.parse(openRandom(await this.key(attachment.organizationId, false), encrypted).toString('utf8')) as SnapshotManifest;
    if (![1, 2, 3].includes(manifest.version) || manifest.attachmentId !== attachment.id || manifest.rootDigest !== revision.rootDigest)
      throw new Error('resource manifest does not match its revision');
    if (!Array.isArray(manifest.files) || manifest.files.length !== (revision.files ?? manifest.files.length)
      || manifest.bytes !== revision.bytes || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0)
      throw new Error('invalid resource manifest totals');
    const packs = manifest.version >= 2 ? manifest.packs : [];
    const keys = manifest.version === 3 ? manifest.keys : undefined;
    const keyed = manifest.version === 3 ? manifest.keyed : undefined;
    if (manifest.version === 3 && (!keys || typeof keys !== 'object' || !keyed || typeof keyed !== 'object'
      || Object.values(keys).some((value) => typeof value?.key !== 'string' || Buffer.from(value.key, 'base64').length !== 32)
      || Object.entries(keyed).some(([id, keyId]) => !/^[a-f0-9]{64}$/.test(id) || !Object.hasOwn(keys, keyId))))
      throw new Error('invalid resource manifest keys');
    if (!Array.isArray(packs) || packs.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))
      throw new Error('invalid resource manifest packs');
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || file.path.length > 4096 || safePath(file.path) !== file.path
        || paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new Error('invalid resource manifest file');
      if ('pack' in file ? !Number.isSafeInteger(file.pack) || !packs[file.pack] || !Number.isSafeInteger(file.offset)
          || file.offset < 0 || file.offset + file.bytes > PACK_BYTES
        : !Array.isArray(file.chunks) || file.chunks.length !== Math.max(1, Math.ceil(file.bytes / CHUNK_BYTES))
          || file.chunks.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))
        throw new Error('invalid resource manifest file');
      paths.add(file.path);
      bytes += file.bytes;
    }
    if (bytes !== manifest.bytes || manifestDigest(manifest.files, manifest.version >= 2 ? packs : undefined, keyed) !== manifest.rootDigest)
      throw new Error('resource manifest tree integrity mismatch');
    return manifest;
  }

  async delete(revision: ResourceRevision, owner?: ResourceAttachment): Promise<void> {
    const attachment = (await this.attachmentFor(revision, owner));
    const manifest = await this.manifest(revision, owner);
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    const objects = (await this.objectsForRevision(revision, ref, owner));
    await objects.delete(ref.objectKey);
    const zero = (await this.chunkAccounting?.release(attachment.organizationId, manifestObjects(manifest))) ?? [];
    for (const chunkId of zero) await objects.delete(chunkObjectKey(attachment.organizationId, chunkId));
  }

  private async attachmentFor(revision: ResourceRevision, owner?: ResourceAttachment): Promise<ResourceAttachment> {
    if (owner?.id === revision.attachmentId) return owner;
    const attachment = (await this.attachmentResolver?.(revision.attachmentId));
    if (!attachment) throw new Error('resource attachment no longer exists');
    return attachment;
  }
  private attachmentResolver?: (id: string) => ResourceAttachment | undefined | Promise<ResourceAttachment | undefined>;
  setAttachmentResolver(resolve: (id: string) => ResourceAttachment | undefined | Promise<ResourceAttachment | undefined>): void { this.attachmentResolver = resolve; }
  private chunkAccounting?: {
    retain(organizationId: string, chunks: Array<{ id: string; bytes: number }>, storageLocationId?: string,
      options?: { enforceQuota?: boolean }): void | Promise<void>;
    release(organizationId: string, chunkIds: string[]): string[] | Promise<string[]>;
  };
  setChunkAccounting(value: NonNullable<ObjectSnapshotEngine['chunkAccounting']>): void { this.chunkAccounting = value; }
  private progressStore?: ProgressStore;
  setProgressStore(value: ProgressStore): void { this.progressStore = value; }

  private async objectsForRevision(revision: ResourceRevision, ref?: SnapshotRef, owner?: ResourceAttachment): Promise<ObjectStore> {
    const locationId = ref?.storageLocationId ?? revision.storageLocationId;
    if (locationId && this.storageLocations)
      (await this.storageLocations.requireForOrganization((await this.attachmentFor(revision, owner)).organizationId, locationId));
    return locationId && this.storageLocations ? (await this.storageLocations.objectStore(locationId)) : this.objects;
  }

  private async key(organizationId: string, create = true): Promise<Buffer> {
    return organizationKey(this.broker, organizationId, create);
  }
}

/** Control-plane resource orchestrator. Workflows carry no credentials and no
 * snapshot refs: create/open activities resolve them immediately around the
 * live provider-owned World. */
export class ProjectResourceService {
  private publishLocks = new Map<string, Promise<void>>();
  /** The restic repositories resources are saved in, and the server restic reaches them at. */
  readonly restic: ResticResources;
  readonly repositoryServer: ResourceRepositoryServer;
  private loopback?: Promise<string>;

  /** `repositories.world` is where a remote sandbox reaches the repositories
   * (the public URL); this host's own restic uses a loopback port. */
  constructor(private store: Store, private worlds: WorldRegistry, private engine: SnapshotEngine,
    private broker: CredentialBroker, private coordinator?: { client: Client; taskQueue: string },
    private storageLocations?: StorageLocationService,
    repositories: { objects?: ObjectStore; world?: (handle: WorldHandle) => string | undefined; cacheDir?: string;
      proxyReads?: boolean } = {}) {
    // A location must be the organization's own, whatever a row or URL names.
    const locationOf = async (attachment: ResourceAttachment) => (await this.storageLocations?.requireForOrganization(
      attachment.organizationId, attachment.storageLocationId))?.id ?? attachment.storageLocationId;
    const objects = async (attachment: ResourceAttachment, storageLocationId: string | undefined) => {
      if (storageLocationId && this.storageLocations) {
        await this.storageLocations.requireForOrganization(attachment.organizationId, storageLocationId);
        return this.storageLocations.objectStore(storageLocationId);
      }
      const fallback = repositories.objects ?? (engine instanceof ObjectSnapshotEngine ? await engine.objectStoreForAttachment(attachment) : undefined);
      if (!fallback) throw new Error('resource storage is not configured');
      return fallback;
    };
    const tokens = new RepositoryTokens(broker);
    this.repositoryServer = new ResourceRepositoryServer({ store, tokens, objects, ...(repositories.proxyReads ? { proxyReads: true } : {}) });
    this.restic = new ResticResources({ store, broker, tokens, locationOf, objects,
      endpoints: { host: () => this.loopbackUrl(), world: repositories.world ?? (() => undefined) },
      ...(repositories.cacheDir ? { cacheDir: repositories.cacheDir } : {}) });
    if (engine instanceof ObjectSnapshotEngine) engine.setAttachmentResolver(async (id) => (await store.getResourceAttachment(id)));
    if (engine instanceof ObjectSnapshotEngine) engine.setChunkAccounting({
      retain: async (organizationId, chunks, storageLocationId, options) => (await store.retainResourceChunks(organizationId, chunks, storageLocationId, options)),
      release: async (organizationId, chunks) => (await store.releaseResourceChunks(organizationId, chunks)),
    });
    if (engine instanceof ObjectSnapshotEngine) engine.setProgressStore({
      get: (key) => store.kvGet(key),
      compareAndSet: (key, expected, next) => store.kvCompareAndSet(key, expected, next),
      keys: async (prefix) => (await store.kvEntries(prefix)).map((entry) => entry.key),
      delete: (key) => store.kvDelete(key),
    });
  }

  /** The repositories on a loopback port, for restic run by this process (and
   * by test worlds that only claim to be remote). */
  loopbackUrl(): Promise<string> {
    return this.loopback ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith(REPOSITORY_ROUTE)) { res.writeHead(404).end(); return; }
        void this.repositoryServer.handle(req, res, url.pathname.slice(REPOSITORY_ROUTE.length) + url.search);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); });
    });
  }

  /** Caller must authorize project:settings:read for this exact project before calling. */
  async verifyRevision(projectId: string, attachmentId: string, revisionId: string, offset = 0, limit = 100) {
    const project = (await this.store.getProject(projectId));
    const attachment = (await this.store.getResourceAttachment(attachmentId));
    const revision = (await this.store.getResourceRevision(revisionId));
    if (!project || !attachment || attachment.projectId !== project.id
      || attachment.organizationId !== project.organizationId || !revision || revision.attachmentId !== attachment.id)
      throw new Error('resource revision not found');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('offset must be a nonnegative integer; limit must be 1–1000');
    if (!isSnapshotDriver(attachment.driver) || (revision.engine !== RESTIC_ENGINE && (revision.engine !== this.engine.id || !this.engine.verify)))
      throw new Error('resource revision verification is unsupported');
    if (revision.storageLocationId && this.storageLocations) {
      try { (await this.storageLocations.requireForOrganization(attachment.organizationId, revision.storageLocationId)); }
      catch { throw new Error('resource revision storage is unavailable'); }
    }
    return { projectId, resourceId: attachment.id, revisionId: revision.id,
      storageLocationId: revision.storageLocationId ?? null,
      ...(revision.engine === RESTIC_ENGINE
        ? await this.restic.verify(this.restic.of(attachment, revision), resticRef(revision).snapshot, offset, limit)
        : await this.engine.verify!(revision, offset, limit)) };
  }

  async storageLocationFor(organizationId: string, requested?: string): Promise<string | undefined> {
    return (await this.storageLocations?.requireForOrganization(organizationId, requested))?.id ?? requested;
  }

  storageLocationService(): StorageLocationService | undefined { return this.storageLocations; }

  async objectStoreFor(attachment: ResourceAttachment): Promise<ObjectStore> {
    if (!(this.engine instanceof ObjectSnapshotEngine)) throw new Error('resource uploads require an object-backed snapshot engine');
    return (await this.engine.objectStoreForAttachment(attachment));
  }

  /** Materialize all enabled project defaults into a newly-created generation.
   * The caller must select the agent workdir before resolving path targets. */
  async materialize(projectId: string, taskId: string, world: World, generation = world.handle.generation ?? 1,
    revisions: Record<string, string | undefined> = {}, options: { signal?: AbortSignal } = {}): Promise<WorldHandle> {
    const ephemeralPaths = new Set<string>(Array.isArray(world.handle.meta?.ephemeralPaths)
      ? world.handle.meta!.ephemeralPaths as string[] : []);
    const projections: Record<string, { target: string; revisionId?: string; access: string }> = {};
    let compression: boolean | undefined;
    for (const attachment of (await this.store.listResourceAttachments(projectId))) {
      options.signal?.throwIfAborted();
      const revisionId = Object.prototype.hasOwnProperty.call(revisions, attachment.id)
        ? revisions[attachment.id] : attachment.currentRevisionId;
      const lease = (await this.store.createResourceLease({ attachmentId: attachment.id, revisionId,
        taskId, worldId: world.handle.id, worldGeneration: generation, access: attachment.access }));
      try {
        if (isSecretLike(attachment)) {
          if (!attachment.credentialHandles[0]) throw new Error(`resource "${attachment.name}" has no configured credential`);
          const value = await this.resolveSecret(attachment, taskId);
          if (attachment.target.kind === 'path') {
            const target = worldWorkingRelativePath(world.handle, attachment.target.path);
            await world.writeFile(target, value);
            await world.exec('chmod', ['600', target], { cwd: world.handle.root });
            await ensureWorldExcluded(world, target);
            ephemeralPaths.add(target);
            projections[attachment.id] = { target, revisionId, access: attachment.access };
          }
        } else if (isSnapshotDriver(attachment.driver)) {
          const target = attachment.target.kind === 'path'
            ? worldWorkingRelativePath(world.handle, attachment.target.path) : undefined;
          if (!target) throw new Error(`resource "${attachment.name}" requires a path target`);
          if (target !== '.') await ensureWorldExcluded(world, target);
          if (revisionId) {
            const revision = (await this.store.getResourceRevision(revisionId));
            if (!revision) throw new Error(`resource "${attachment.name}" revision is missing`);
            const startedAt = Date.now();
            await this.store.appendEvent({ taskId, type: 'world.resource-restoring', ts: startedAt,
              payload: { attachmentId: attachment.id, revisionId, bytes: revision.bytes, files: revision.files } });
            const checkContinue = async () => { options.signal?.throwIfAborted(); };
            if (revision.engine === RESTIC_ENGINE) {
              await timed('resource.restore', () => this.restic.restore({ world, path: path.posix.join(world.handle.root, target),
                file: fileShaped(attachment) }, this.restic.of(attachment, revision), resticRef(revision).snapshot, { key: `restore:${lease.id}`, checkContinue }),
              { itemId: attachment.id });
            } else {
              // A version saved before restic, until it is converted (convertLegacyRevisions).
              if (compression === undefined) compression = world.handle.kind === 'e2b' &&
                (await world.exec('bash', ['-lc', 'command -v gzip >/dev/null'], { cwd: world.handle.root })).code === 0;
              const relativeOf = (file: string) => fileShaped(attachment) ? target : target === '.' ? file : `${target}/${file}`;
              await timed('resource.restore', () => this.engine.restore(revision, async (file, data, offset) => {
                options.signal?.throwIfAborted();
                await timed('resource.transfer', () => transferResourceChunk(world, relativeOf(file), data, offset,
                  { compress: compression, signal: options.signal }));
              }, options), { itemId: attachment.id });
            }
            await this.store.appendEvent({ taskId, type: 'world.resource-restored', ts: Date.now(),
              payload: { attachmentId: attachment.id, revisionId, durationMs: Date.now() - startedAt } });
          }
          if (attachment.access === 'read')
            await world.exec('bash', ['-lc', `test ! -e ${quote(target)} || chmod -R a-w ${quote(target)}`], { cwd: world.handle.root });
          projections[attachment.id] = { target, revisionId, access: attachment.access };
        } else throw new Error(`no resource driver registered for ${attachment.driver}`);
        options.signal?.throwIfAborted();
        (await this.store.updateResourceLease(lease.id, 'active', JSON.stringify({ driver: attachment.driver })));
        (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:lease',
          scopeKey: `project:${projectId}`, detail: { attachmentId: attachment.id, leaseId: lease.id,
            revisionId, access: attachment.access, worldGeneration: generation } }));
      } catch (error) {
        (await this.store.updateResourceLease(lease.id, 'failed'));
        throw error;
      }
    }
    world.handle = { ...world.handle, generation, meta: { ...world.handle.meta,
      ...(ephemeralPaths.size ? { ephemeralPaths: [...ephemeralPaths] } : {}),
      ...(Object.keys(projections).length ? { resourceProjections: projections } : {}) } };
    return world.handle;
  }

  /** Resolve environment/service projections each time a world is opened. Raw
   * values live only in this wrapper and disappear with the activity. */
  async environmentFor(handle: WorldHandle, skipped?: SkippedEnv[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const serviceHandles = handle.meta?.serviceEnvironmentHandles;
    if (serviceHandles && typeof serviceHandles === 'object') {
      const services: Record<string, string> = {};
      for (const [name, secretHandle] of Object.entries(serviceHandles as Record<string, unknown>)) {
        if (typeof secretHandle !== 'string') continue;
        (await recordSecretRefs(this.store, handle.id, [handleRef(secretHandle)]));
        services[name] = this.broker.resolve(secretHandle, {
          taskId: handle.id,
          caps: [`use-credential:${secretHandle}`],
        });
      }
      Object.assign(env, screenEnvironment(services, () => 'a world service', skipped));
    }
    for (const lease of (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))) {
      if (lease.state !== 'active') continue;
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      if (!attachment?.enabled || !isSecretLike(attachment)) continue;
      // Every world command carries these (EnvironmentWorld), so a value the OS
      // refuses would fail them all, the platform's own git included.
      if (attachment.target.kind === 'environment' || attachment.target.kind === 'service')
        Object.assign(env, screenEnvironment({ [attachment.target.name]: await this.resolveSecret(attachment, lease.taskId) },
          () => `project secret "${attachment.name}"`, skipped));
    }
    return env;
  }

  /** Resolve environment/service projections each time a world is opened. Raw
   * values live only in this wrapper and disappear with the activity. */
  async withEnvironment(world: World): Promise<World> {
    const env = (await this.environmentFor(world.handle));
    return Object.keys(env).length ? new EnvironmentWorld(world, env) : world;
  }

  /** Store generated per-world service endpoints behind opaque vault handles.
   * World metadata may be durable; connection strings and tokens may not be. */
  async registerServiceEnvironment(handle: WorldHandle, values: Record<string, string>, organizationId: string): Promise<WorldHandle> {
    const refs: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const ref = `world-service:${handle.id}:${handle.generation ?? 1}:${name}`;
      (await this.broker.registerHandle(ref, value, organizationScope(organizationId)));
      refs[name] = ref;
    }
    return { ...handle, meta: { ...handle.meta,
      ...(Object.keys(refs).length ? { serviceEnvironmentHandles: refs } : {}) } };
  }

  /** Project secrets reach worlds created before them: at the next open, and
   * mid-turn through refresh(). A late file secret is recorded as a projection
   * before it is written, so checkpoints and forks never capture it as output.
   * Never rematerialize snapshots here, and never revive a previously
   * released/failed lease. */
  private async refreshSecretLeases(world: World): Promise<void> {
    const handle = world.handle;
    const task = (await this.store.getTask(handle.id));
    const current = (await this.store.currentWorld(handle.id));
    const generation = handle.generation ?? 1;
    if (!task || !current || (current.generation ?? 1) !== generation
      || (await this.store.worldState(handle.id)) === 'released'
      || current.meta?.projectId !== task.projectId || handle.meta?.projectId !== task.projectId) return;
    const project = (await this.store.getProject(task.projectId));
    if (!project) return;
    const existing = new Set((await this.store.listResourceLeases(handle.id, generation)).map((lease) => lease.attachmentId));
    const late = (await this.store.listResourceAttachments(project.id)).filter((attachment) =>
      attachment.organizationId === project.organizationId && isSecretLike(attachment) && !existing.has(attachment.id));
    // Resolve before recording anything: a transient broker failure must fail
    // this open, but remain retryable on the next one.
    for (const attachment of late) await this.resolveSecret(attachment, task.id);
    const projections = Object.fromEntries(late.flatMap((attachment) => attachment.target.kind === 'path'
      ? [[attachment.id, { target: worldWorkingRelativePath(handle, attachment.target.path), access: attachment.access }]] : []));
    if (Object.keys(projections).length)
      world.handle = (await this.store.updateWorldMeta(handle, { resourceProjections: {
        ...(current.meta?.resourceProjections as Record<string, unknown> | undefined), ...projections } })) as WorldHandle;
    for (const attachment of late) {
      const lease = (await this.store.createResourceLease({ attachmentId: attachment.id, taskId: task.id,
        worldId: handle.id, worldGeneration: generation, access: attachment.access, state: 'active',
        sealedDriverRef: JSON.stringify({ driver: attachment.driver }) }));
      (await this.store.appendAudit({ principalId: `task:${task.id}`, action: 'resource:lease',
        scopeKey: `project:${project.id}`, detail: { attachmentId: attachment.id, leaseId: lease.id,
          access: attachment.access, worldGeneration: generation } }));
    }
  }

  /** Write every leased file secret (`changedOnly`: only those whose target or
   * value differs from what this process last wrote, so a running agent's own
   * edits survive until the project value actually changes). The cache is this
   * process's alone: a file another process scrubbed, or the agent deleted, is
   * written again (audit R-9). */
  private async writeSecretFiles(world: World, changedOnly: boolean): Promise<void> {
    for (const lease of (await this.store.listResourceLeases(world.handle.id, world.handle.generation ?? 1))) {
      if (lease.state !== 'active') continue;
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      if (!attachment?.enabled || !isSecretLike(attachment) || attachment.target.kind !== 'path') continue;
      const target = resourcePath(world.handle, attachment);
      const value = await this.resolveSecret(attachment, lease.taskId);
      const key = `${writtenPrefix(world.handle)}${attachment.id}`;
      const digest = sha256(Buffer.from(`${target}\0${value}`));
      if (changedOnly && this.writtenSecrets.get(key) === digest
        && (await world.exec('test', ['-e', target], { cwd: world.handle.root }).catch(() => undefined))?.code === 0) continue;
      await world.writeFile(target, value);
      await world.exec('chmod', ['600', target], { cwd: world.handle.root });
      await ensureWorldExcluded(world, target);
      this.writtenSecrets.set(key, digest);
    }
  }
  private writtenSecrets = new Map<string, string>();

  /** Rehydrate path credentials after a park/resume and wrap environment
   * credentials for this one access. Provider snapshots are scrubbed first. */
  async prepare(world: World): Promise<World> {
    (await this.refreshSecretLeases(world));
    (await this.writeSecretFiles(world, true));
    return (await this.withEnvironment(world));
  }

  /** Keep an already-running agent current with project settings: enroll
   * secrets added since the world was opened, rewrite changed files, and
   * return the work-command environment as it stands now. */
  async refresh(world: World): Promise<Record<string, string>> {
    (await this.refreshSecretLeases(world));
    (await this.writeSecretFiles(world, true));
    return (await this.environmentFor(world.handle));
  }

  async scrubSecrets(handle: WorldHandle, liveWorld?: World): Promise<void> {
    const world = liveWorld ?? await this.worlds.open(handle).catch(() => undefined);
    if (!world) return;
    for (const key of this.writtenSecrets.keys()) if (key.startsWith(writtenPrefix(handle))) this.writtenSecrets.delete(key);
    for (const lease of (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))) {
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      if (attachment?.target.kind === 'path' && isSecretLike(attachment))
        await world.exec('rm', ['-f', resourcePath(handle, attachment)], { cwd: handle.root }).catch(() => undefined);
    }
  }

  async release(handle: WorldHandle, liveWorld?: World): Promise<void> {
    await this.scrubSecrets(handle, liveWorld);
    const world = liveWorld ?? await this.worlds.open(handle).catch(() => undefined);
    const serviceHandles = handle.meta?.serviceEnvironmentHandles;
    if (serviceHandles && typeof serviceHandles === 'object')
      for (const value of Object.values(serviceHandles as Record<string, unknown>))
        if (typeof value === 'string') (await this.broker.deleteHandle(value));
    for (const lease of (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))) {
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      // Read-only projections remove write permission recursively. Restore owner
      // write permission before a local/provider cleanup tries to unlink them;
      // otherwise a perfectly released resource can make world destruction fail.
      if (world && attachment?.access === 'read' && attachment.target.kind === 'path')
        await world.exec('chmod', ['-R', 'u+w', resourcePath(handle, attachment)], { cwd: handle.root }).catch(() => undefined);
      (await this.store.updateResourceLease(lease.id, 'released'));
      if (attachment) (await this.store.appendAudit({ principalId: `task:${lease.taskId}`, action: 'resource:release',
        scopeKey: `project:${attachment.projectId}`, detail: { attachmentId: attachment.id, leaseId: lease.id } }));
    }
  }

  async importFiles(attachmentId: string, files: Iterable<SnapshotInputFile> | AsyncIterable<SnapshotInputFile>, createdByTaskId?: string): Promise<ResourceRevision> {
    const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'karmax-import-'));
    try {
      for await (const file of asAsync(files)) {
        const destination = path.join(scratch, ...safePath(file.path).split('/'));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.writeFile(destination, file.data as Buffer | AsyncIterable<Buffer>);
      }
      return await this.importPath(attachmentId, scratch, '.', createdByTaskId);
    } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
  }

  async importDirectory(attachmentId: string, source: string): Promise<ResourceRevision> {
    const root = path.resolve(source);
    const stat = await fs.promises.stat(root);
    if (stat.isDirectory()) return this.importPath(attachmentId, root, '.');
    if (stat.isFile()) return this.importPath(attachmentId, path.dirname(root), path.basename(root));
    throw new Error('resource import source must be a regular file or directory');
  }

  /** Save `entry` of a directory on this host as the resource's new current version. */
  private async importPath(attachmentId: string, directory: string, entry: string, createdByTaskId?: string): Promise<ResourceRevision> {
    const attachment = (await this.requiredAttachment(attachmentId));
    if (!isSnapshotDriver(attachment.driver)) throw new Error('only snapshot-backed resources accept files');
    const restic = this.restic;
    const repository = await restic.current(attachment);
    const current = attachment.currentRevisionId ? await this.store.getResourceRevision(attachment.currentRevisionId) : undefined;
    const parent = this.parentIn(repository, current);
    const capture = await restic.backupDirectory(directory, repository, { quota: true, entry, ...(parent ? { parent } : {}) });
    const fields = restic.revisionFields(capture, repository);
    const revision = (await this.store.saveResourceRevision({ attachmentId, parentRevisionId: attachment.currentRevisionId,
      ...fields, metadata: { imported: true }, createdByTaskId }));
    (await this.store.promoteResourceRevision(attachmentId, revision.id, attachment.currentRevisionId));
    (await this.store.recordUsage({ organizationId: attachment.organizationId, projectId: attachment.projectId,
      taskId: createdByTaskId, provider: RESTIC_ENGINE, kind: 'resource.storage', quantity: capture.added,
      unit: 'byte', costMicros: 0, fundingSource: (await this.store.getStorageLocation(fields.storageLocationId ?? ''))?.kind === 's3' ? 'byok' : 'managed',
      startedAt: revision.createdAt, endedAt: revision.createdAt,
      metadata: { attachmentId, revisionId: revision.id, files: capture.files } }));
    return revision;
  }

  /** One-time exit ramp for the deprecated host-only copyGlobs setting. The
   * accepted files become ordinary typed attachments at their original world
   * locations; no compatibility KV/object plane is introduced. */
  async migrateCopyGlobs(project: Project): Promise<CopyGlobsMigrationResult> {
    const globs = project.config.copyGlobs ?? [];
    const result: CopyGlobsMigrationResult = {
      environmentSecrets: [], fileSecrets: [], data: [], reused: [], skipped: [],
    };
    if (!globs.length) return result;
    const sources = project.config.repos ?? [];
    const repoNames = copyGlobRepoNames(sources);
    const created: string[] = [];
    try {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]!;
        const local = expandPath(source);
        const managed = managedRepoPath(source);
        const root = fs.existsSync(local) ? local : fs.existsSync(managed) ? managed : undefined;
        if (!root) throw new Error(`cannot migrate copyGlobs because repository "${source}" has no local checkout`);
        const entries = fs.readdirSync(root, { withFileTypes: true });
        const seen = new Set<string>();
        for (const glob of globs) {
          const pattern = copyGlobRegExp(glob);
          for (const entry of entries) {
            if (!entry.isFile() || !pattern.test(entry.name) || seen.has(entry.name)) continue;
            seen.add(entry.name);
            const absolute = path.join(root, entry.name);
            let data: Buffer | undefined;
            try { data = await readSmallFile(absolute, COPY_GLOB_SECRET_BYTES); }
            catch (error) {
              throw new Error(`could not read copyGlobs match "${source}:${entry.name}": ${
                error instanceof Error ? error.message : String(error)}`);
            }
            const target = sources.length > 1 ? `${repoNames[index]}/${entry.name}` : entry.name;
            const sourceRecord = { migratedFrom: 'copyGlobs', repository: source, path: entry.name };
            const env = data && /^\.env(?:\.|$)/i.test(entry.name) ? parseCopyEnv(data.toString('utf8')) : [];
            if (env.length) {
              for (const value of env) {
                const existing = (await this.store.listResourceAttachments(project.id, true)).find((attachment) =>
                  attachment.driver === 'secret@1' && attachment.target.kind === 'environment'
                  && attachment.target.name === value.name);
                if (existing) { result.reused.push(value.name); continue; }
                const id = newId('resource'), handle = `resource:${id}:credential`;
                (await this.broker.registerHandle(handle, value.value, organizationScope(project.organizationId!)));
                try {
                  (await this.store.createResourceAttachment({ id, organizationId: project.organizationId!,
                    projectId: project.id, name: value.name, driver: 'secret@1',
                    target: { kind: 'environment', name: value.name }, access: 'read', isolation: 'fork',
                    source: sourceRecord, credentialHandles: [handle], publish: 'discard' }));
                } catch (error) { (await this.broker.deleteHandle(handle)); throw error; }
                created.push(id); result.environmentSecrets.push(value.name);
              }
              continue;
            }
            const existing = (await this.store.listResourceAttachments(project.id, true)).find((attachment) =>
              attachment.target.kind === 'path' && attachment.target.path === target);
            if (existing) { result.reused.push(target); continue; }
            if (data && !data.includes(0)) {
              const id = newId('resource'), handle = `resource:${id}:credential`;
              (await this.broker.registerHandle(handle, data.toString('utf8'), organizationScope(project.organizationId!)));
              try {
                (await this.store.createResourceAttachment({ id, organizationId: project.organizationId!,
                  projectId: project.id, name: copyGlobSecretName(entry.name), driver: 'secret@1',
                  target: { kind: 'path', path: target }, access: 'read', isolation: 'fork',
                  source: sourceRecord, credentialHandles: [handle], publish: 'discard' }));
              } catch (error) { (await this.broker.deleteHandle(handle)); throw error; }
              created.push(id); result.fileSecrets.push(target);
            } else {
              const attachment = (await this.store.createResourceAttachment({ organizationId: project.organizationId!,
                projectId: project.id, name: `Imported ${entry.name}`, driver: 'volume@1',
                target: { kind: 'path', path: target }, access: 'read', isolation: 'fork',
                source: { ...sourceRecord, shape: 'file' }, credentialHandles: [], publish: 'discard' }));
              created.push(attachment.id);
              const stat = await fs.promises.stat(absolute);
              await this.importFiles(attachment.id,
                [{ path: entry.name, data: data ?? fs.createReadStream(absolute) as AsyncIterable<Buffer>,
                  bytes: stat.size }]);
              result.data.push(target);
            }
          }
        }
      }
      (await this.store.updateProjectConfig(project.id, { copyGlobs: [] }));
      (await this.store.appendAudit({ principalId: 'system:copyglobs-migration', action: 'resource:migrate-copyglobs',
        scopeKey: `project:${project.id}`, detail: {
          environmentSecrets: result.environmentSecrets, fileSecrets: result.fileSecrets,
          data: result.data, reused: result.reused, skipped: result.skipped,
        } }));
      return result;
    } catch (error) {
      for (const id of created.reverse()) await this.deleteAttachment(id).catch(() => undefined);
      throw error;
    }
  }

  /** Remove control-plane records, credentials, and revision manifests. Shared
   * content chunks are left for the snapshot engine's mark-and-sweep policy. */
  /** Delete a revision only if nothing references it, then its objects. A
   * failure deleting objects leaks bytes rather than leaving a dangling row. */
  async deleteRevision(revisionId: string, options: { allowCurrent?: boolean } = {}): Promise<ResourceRevision | undefined> {
    const revision = (await this.store.deleteResourceRevisionIfUnreferenced(revisionId, options));
    if (revision) await this.deleteRevisionData(revision).catch((error) =>
      console.warn(`resource revision ${revision.id}: objects not deleted: ${error instanceof Error ? error.message : String(error)}`));
    return revision;
  }

  /** A deleted revision's snapshot is forgotten (its data goes with the next
   * prune); a legacy one releases its chunks. */
  private async deleteRevisionData(revision: ResourceRevision, owner?: ResourceAttachment): Promise<void> {
    if (revision.engine !== RESTIC_ENGINE) return this.engine.delete?.(revision, owner);
    const attachment = owner ?? await this.store.getResourceAttachment(revision.attachmentId);
    if (attachment) await this.restic.forget(this.restic.of(attachment, revision), [resticRef(revision).snapshot]);
  }

  /** Hourly upkeep of the resource repositories: forget snapshots no version
   * names (after a day, so a save in progress is never touched), prune what
   * that freed, and move a batch of versions saved before restic into it
   * (10 GiB a run: the bytes pass through this host). */
  async maintainRepositories(now = Date.now(), options: { convertBytes?: number } = {}): Promise<{ forgotten: number; pruned: number; converted: number }> {
    let forgotten = 0;
    const byRepository = new Map<string, string[]>();
    for (const snapshot of await this.store.unreferencedRepositorySnapshots(now - 24 * 3_600_000))
      byRepository.set(snapshot.repository, [...byRepository.get(snapshot.repository) ?? [], snapshot.name]);
    for (const [name, snapshots] of byRepository) {
      const repository = await this.repositoryNamed(name);
      if (!repository) continue;
      try { await this.restic.forget(repository, snapshots); forgotten += snapshots.length; }
      catch (error) { console.warn(`resource repository ${name}: could not forget unused versions: ${message(error)}`); }
    }
    const converted = await this.convertLegacyRevisions(options.convertBytes ?? 10 * 2 ** 30);
    return { forgotten, pruned: await this.pruneRepositories(), converted };
  }

  /** Delete the data of forgotten versions now, in every repository that has some. */
  async pruneRepositories(): Promise<number> {
    let pruned = 0;
    for (const { key } of await this.store.kvEntries('restic-prune:')) {
      const repository = await this.repositoryNamed(key.slice('restic-prune:'.length));
      if (!repository) { await this.store.kvDelete(key); continue; }
      // A save holding the repository makes this wait for the next run.
      try { await this.restic.prune(repository); pruned++; }
      catch (error) { console.warn(`resource repository ${repository.name}: prune deferred: ${message(error)}`); }
    }
    return pruned;
  }

  private async repositoryNamed(name: string): Promise<Repository | undefined> {
    const parsed = parseRepositoryName(name);
    const attachment = parsed && await this.store.getResourceAttachment(parsed.attachmentId);
    return attachment ? this.restic.repository(attachment, parsed.storageLocationId) : undefined;
  }

  /** A revision's snapshot as the parent of a save into `repository`: only a
   * snapshot in that same repository can be one. */
  private parentIn(repository: Repository, revision: ResourceRevision | undefined): string | undefined {
    return revision?.engine === RESTIC_ENGINE && revision.attachmentId === repository.attachment.id
      && this.restic.of(repository.attachment, revision).name === repository.name ? resticRef(revision).snapshot : undefined;
  }

  /** Move versions saved before restic into their resource's repository, in
   * place (the revision keeps its id), then release their old chunks. Current
   * versions go first. Bytes pass through this host once, in a scratch directory. */
  async convertLegacyRevisions(maxBytes: number): Promise<number> {
    const restic = this.restic;
    let converted = 0;
    let bytes = 0;
    for (const revision of await this.store.legacyResourceRevisions(1000)) {
      if (bytes >= maxBytes) break;
      const attachment = await this.store.getResourceAttachment(revision.attachmentId);
      if (!attachment) continue;
      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'karmax-convert-'));
      try {
        await this.engine.restore(revision, async (file, data, offset) => {
          const destination = path.join(scratch, ...safePath(file).split('/'));
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          const handle = await fs.promises.open(destination, offset ? 'r+' : 'w');
          try { await handle.write(data, 0, data.length, offset); } finally { await handle.close(); }
        });
        // Converted into the location the version was saved in.
        const repository = restic.repository(attachment, revision.storageLocationId);
        const capture = await restic.backupDirectory(scratch, repository, { quota: false });
        const fields = restic.revisionFields(capture, repository);
        if (await this.store.convertResourceRevision(revision.id, revision.sealedRef, fields)) {
          await this.engine.delete?.(revision, attachment);
          converted++; bytes += revision.bytes;
        } else await restic.forget(repository, [capture.snapshot]);
      } catch (error) {
        console.warn(`resource revision ${revision.id}: not converted to restic yet: ${message(error)}`);
      } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
    }
    return converted;
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    const attachment = (await this.store.getResourceAttachment(attachmentId));
    if (!attachment) return;
    await this.engine.abandonProgress?.(attachment);
    for (const revision of (await this.store.listResourceRevisions(attachmentId)))
      if (revision.engine !== RESTIC_ENGINE) await this.engine.delete?.(revision);
    await this.restic.removeRepositories(attachment);
    // Only the resource's own secret is its to delete. A vault item it projects
    // may control a live external account or serve another project, and any
    // other handle belongs to someone else (AU-40).
    const own = resourceSecretHandle(attachment.id);
    if (attachment.credentialHandles.includes(own)) (await this.broker.deleteHandle(own));
    (await this.store.deleteResourceAttachment(attachmentId));
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const attachment of (await this.store.listResourceAttachments(projectId, true))) await this.deleteAttachment(attachment.id);
    (await this.store.kvDelete(`project-environment:${projectId}`));
    (await this.store.kvDelete(`project-environment-builds:${projectId}`));
    (await this.store.kvDelete(`project-services:${projectId}`));
  }

  async deleteOrganizationKey(organizationId: string): Promise<void> {
    (await this.broker.deleteHandle(organizationKeyHandle(organizationId)));
  }

  /** Declare a non-secret path from the caller's current generation. The
   * disabled attachment reserves its accepted shape; the bytes are snapshotted
   * later by {@link stageCandidates}, which the workflow runs as a durable
   * activity at the end of Do. A multi-GB snapshot must not depend on the
   * agent's HTTP call, its turn, or the gateway process staying up. */
  async proposePath(taskId: string, input: { path: string; name: string; target: ResourceTarget;
    access?: ResourceAccess; publish?: ResourcePublishPolicy; driver?: 'volume@1' | 'object-tree@1' }): Promise<ProposedResourceCandidate> {
    const { task, project, handle, world } = await this.currentTaskWorld(taskId);
    const sourcePath = safePath(input.path);
    if (sourcePath === '.' || sourcePath === '.env' || sourcePath === '.git' || sourcePath.startsWith('.git/')
      || sourcePath.startsWith('.karmax-injection/'))
      throw new Error('candidate path must name declared non-secret task output, not the world root or an injection path');
    const projections = Object.values((handle.meta?.resourceProjections ?? {}) as Record<string, { target?: string }>);
    if (projections.some((projection) => projection.target
      && pathsOverlap(projection.target, worldWorkingRelativePath(handle, sourcePath))))
      throw new Error('path already belongs to an attached resource; promote that resource instead');
    if ((await this.store.listResourceCandidates(taskId, false)).some((candidate) => candidate.sourcePath
      && pathsOverlap(candidate.sourcePath, sourcePath)))
      throw new Error('path is already staged as a resource candidate');
    const kind = await world.exec('bash', ['-lc', `if test -f ${quote(sourcePath)}; then printf file; elif test -d ${quote(sourcePath)}; then printf directory; else exit 1; fi`]);
    if (kind.code !== 0) throw new Error('candidate path must be an existing regular file or directory in this task world');
    const links = await world.exec('bash', ['-lc',
      `test ! -L ${quote(sourcePath)} && test -z "$(find ${quote(sourcePath)} -type l -print -quit)"`]);
    if (links.code !== 0) throw new Error('candidate paths cannot contain symbolic links');
    const access = input.access ?? 'read';
    const publish = access === 'write' ? (input.publish ?? 'review') : 'discard';
    const attachment = (await this.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: input.name, driver: input.driver ?? 'volume@1', target: input.target, access, isolation: 'fork',
      source: { candidate: true, createdByTaskId: task.id, sourcePath, shape: kind.stdout === 'file' ? 'file' : 'directory' },
      credentialHandles: [], publish, enabled: false }));
    try {
      const candidate = (await this.store.createResourceCandidate({ organizationId: project.organizationId!, projectId: project.id,
        taskId, worldId: handle.id, worldGeneration: handle.generation ?? 1, attachmentId: attachment.id,
        sourceKind: 'path', sourcePath }));
      return { candidate, attachment };
    } catch (error) {
      (await this.store.deleteResourceAttachment(attachment.id));
      throw error;
    }
  }

  /** Snapshot every pending path candidate from the world generation that
   * proposed it, so Review shows, and Confirm adopts, the output as it is now.
   * A staged candidate is refreshed incrementally: unchanged files are neither
   * read nor uploaded. A transient failure is retried by the activity with the
   * other candidates still staged; a candidate with no snapshot whose world or
   * path is gone, or that still fails on the `final` attempt, is discarded with
   * its reason, which Review shows. An earlier snapshot is never thrown away. */
  async stageCandidates(taskId: string, options: { final?: boolean; checkContinue?: () => Promise<void>;
    onProgress?: (progress: StagingProgress) => void } = {}): Promise<StagedResourceCandidates> {
    const result: StagedResourceCandidates = { staged: [], failed: [] };
    const transient: unknown[] = [];
    const candidates = (await this.store.listResourceCandidates(taskId, false)).filter((candidate) => candidate.sourceKind === 'path');
    for (const [index, candidate] of candidates.entries()) {
      await options.checkContinue?.();
      try {
        const progress = options.onProgress && ((done: Omit<StagingProgress, 'path' | 'index' | 'count'>) =>
          options.onProgress!({ path: candidate.sourcePath!, index, count: candidates.length, ...done }));
        if (await this.stageCandidate(taskId, candidate, options.checkContinue, progress)) result.staged.push(candidate.id);
        if (candidate.error) await this.store.recordResourceCandidateError(candidate.id, null);
      } catch (error) {
        await options.checkContinue?.(); // cancellation is not a staging failure
        if ((await this.store.getResourceCandidate(candidate.id))?.state !== 'pending') continue;
        const reason = error instanceof Error ? error.message : String(error);
        const staged = Boolean((await this.store.getResourceAttachment(candidate.attachmentId))?.currentRevisionId);
        if (!staged && !(error instanceof UnstageableCandidate)) await this.store.recordResourceCandidateError(candidate.id, reason);
        if (!options.final && !(error instanceof UnstageableCandidate)) { transient.push(error); continue; }
        // A refresh that still fails keeps the snapshot already taken.
        if (staged) continue;
        if (error instanceof UnstageableCandidate) {
          // Its world or path is gone: nothing could ever save it.
          await this.discardCandidate(taskId, candidate.id, 'system:resource-stage-failed', reason);
          result.failed.push({ candidateId: candidate.id, sourcePath: candidate.sourcePath, error: reason });
          continue;
        }
        // Anything else may yet save: the output stays in its world, pending, with
        // the reason shown at Review, and Confirm tries again. Only an explicit
        // Exclude gives it up (pramana#1 lost raw_data to an automatic discard).
        result.failed.push({ candidateId: candidate.id, sourcePath: candidate.sourcePath, error: reason });
      }
    }
    if (transient.length) throw transient[0];
    return result;
  }

  /** True when a new revision was promoted. */
  private async stageCandidate(taskId: string, candidate: ResourceCandidate, checkContinue?: () => Promise<void>,
    onProgress?: (done: Omit<StagingProgress, 'path' | 'index' | 'count'>) => void): Promise<boolean> {
    const attachment = await this.store.getResourceAttachment(candidate.attachmentId);
    if (!attachment) throw new UnstageableCandidate('resource candidate attachment is unavailable');
    const baseline = attachment.currentRevisionId ? await this.store.getResourceRevision(attachment.currentRevisionId) : undefined;
    const current = (await this.store.currentWorld(taskId)) as WorldHandle | undefined;
    if (!current || candidate.worldId !== current.id || candidate.worldGeneration !== (current.generation ?? 1)) {
      if (baseline) return false; // keep the snapshot taken while the world lived
      throw new UnstageableCandidate('the task world that produced this output no longer exists');
    }
    const { project, handle, world } = await this.currentTaskWorld(taskId);
    const sourcePath = candidate.sourcePath!;
    // A vanished path would otherwise capture as an empty, "successful" snapshot.
    const present = await world.exec('bash', ['-lc', `if test -e ${quote(sourcePath)}; then echo present; else echo absent; fi`]);
    if (present.code !== 0 || !['present', 'absent'].includes(present.stdout.trim()))
      throw new Error(`could not inspect ${sourcePath}: ${present.stderr || present.stdout || `exit ${present.code}`}`);
    if (present.stdout.trim() === 'absent') {
      if (baseline) return false;
      throw new UnstageableCandidate(`${sourcePath} no longer exists in the task world`);
    }
    // restic resumes an interrupted save from what it already stored, and a
    // retried activity finds the save still running in the world.
    const place = { world, path: path.posix.resolve(worldWorkingDirectory(handle), sourcePath), file: fileShaped(attachment) };
    const captured = await this.capture(place, attachment, baseline, { key: `candidate:${candidate.id}`, quota: true, checkContinue,
      onProgress: (progress) => onProgress?.(progress) });
    if (!captured) return false;
    // Discarded or staged by someone else meanwhile, this throws; the snapshot
    // no revision names goes with the next sweep (collectRepositoryGarbage).
    const revision = (await this.store.saveAndPromoteResourceRevision({ attachmentId: attachment.id, parentRevisionId: baseline?.id,
      ...captured.fields, metadata: { candidate: true, sourcePath }, createdByTaskId: taskId }, baseline?.id));
    (await this.store.recordUsage({ organizationId: project.organizationId!, projectId: project.id, taskId,
      worldId: handle.id, provider: RESTIC_ENGINE, kind: 'resource.storage', quantity: captured.capture.added, unit: 'byte',
      costMicros: 0, fundingSource: (await this.store.getStorageLocation(captured.fields.storageLocationId ?? ''))?.kind === 's3' ? 'byok' : 'managed',
      startedAt: candidate.createdAt, endedAt: Date.now(),
      metadata: { candidateId: candidate.id, attachmentId: attachment.id, revisionId: revision.id, files: captured.fields.files } }));
    (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:candidate-stage',
      scopeKey: `project:${project.id}`, detail: { candidateId: candidate.id, attachmentId: attachment.id,
        sourcePath, worldGeneration: candidate.worldGeneration, bytes: captured.fields.bytes, files: captured.fields.files,
        ...(baseline ? { refreshedFrom: baseline.id } : {}) } }));
    return true;
  }

  /** Save a resource from a world as a new snapshot, deduplicated against
   * `baseline` (the version the world started from). Undefined when nothing
   * changed since `baseline`: then there is no new version to record. */
  private async capture(place: ResticPlace, attachment: ResourceAttachment, baseline: ResourceRevision | undefined,
    options: { key: string; quota: boolean; checkContinue?: () => Promise<void>; onProgress?: (progress: { files: number;
      totalFiles: number; bytes: number; totalBytes: number }) => void }): Promise<{ capture: ResticCapture;
      fields: ReturnType<ResticResources['revisionFields']> } | undefined> {
    const restic = this.restic;
    const repository = await restic.current(attachment);
    const parent = this.parentIn(repository, baseline);
    const capture = await restic.backup(place, repository, { ...options, ...(parent ? { parent } : {}) });
    if (parent) {
      const changes = await restic.diff(repository, parent, capture.snapshot);
      if (changes.added + changes.modified + changes.deleted === 0) {
        await restic.forget(repository, [capture.snapshot]);
        return undefined;
      }
    }
    return { capture, fields: restic.revisionFields(capture, repository) };
  }


  /** Create a reviewable projection of a vault item without resolving its
   * plaintext. Authorization/provenance of the item is checked by KarmaxApi. */
  async proposeCredential(taskId: string, input: { itemId: string; field: string; credentialHandle: string;
    name: string; driver: 'secret@1' | 'service@1' | 'database@1'; target: ResourceTarget;
    access?: ResourceAccess; source?: Record<string, unknown> }): Promise<ProposedResourceCandidate> {
    const { task, project, handle } = await this.currentTaskWorld(taskId);
    if (!this.broker.hasHandle(input.credentialHandle)) throw new Error('vault item field is not stored');
    const shared = input.driver === 'service@1' || input.driver === 'database@1';
    const attachment = (await this.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: input.name, driver: input.driver, target: input.target, access: input.access ?? 'read',
      isolation: shared ? 'shared' : 'fork', source: { ...input.source, candidate: true,
        createdByTaskId: task.id, vaultItemId: input.itemId, vaultField: input.field },
      credentialHandles: [input.credentialHandle], publish: 'discard', enabled: false }));
    try {
      const candidate = (await this.store.createResourceCandidate({ organizationId: project.organizationId!, projectId: project.id,
        taskId, worldId: handle.id, worldGeneration: handle.generation ?? 1, attachmentId: attachment.id,
        sourceKind: 'vault-item', vaultItemId: input.itemId, vaultField: input.field }));
      (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:candidate-stage',
        scopeKey: `project:${project.id}`, detail: { candidateId: candidate.id, attachmentId: attachment.id,
          vaultItemId: input.itemId, vaultField: input.field, worldGeneration: candidate.worldGeneration } }));
      return { candidate, attachment };
    } catch (error) {
      (await this.store.deleteResourceAttachment(attachment.id));
      throw error;
    }
  }

  async adoptCandidate(taskId: string, candidateId: string, resolvedBy: string): Promise<ProposedResourceCandidate> {
    const candidate = (await this.requiredCandidate(taskId, candidateId));
    if (candidate.state === 'adopted') {
      const attachment = (await this.store.getResourceAttachment(candidate.attachmentId));
      if (!attachment?.enabled) throw new Error('adopted resource candidate attachment is unavailable');
      const revision = attachment.currentRevisionId
        ? (await this.store.getResourceRevision(attachment.currentRevisionId)) : undefined;
      return { candidate, attachment, revision };
    }
    const adopted = (await this.store.adoptResourceCandidate(candidate.id, taskId, resolvedBy));
    (await this.store.kvDelete(`resource-candidate-observed:${candidate.id}`));
    // An interrupted refresh's saved progress is not part of what was adopted.
    await this.engine.abandonProgress?.(adopted.attachment);
    const revision = adopted.attachment.currentRevisionId
      ? (await this.store.getResourceRevision(adopted.attachment.currentRevisionId)) : undefined;
    (await this.store.appendAudit({ principalId: resolvedBy, action: 'resource:candidate-adopt',
      scopeKey: `project:${candidate.projectId}`, detail: { candidateId, attachmentId: candidate.attachmentId,
        taskId, worldId: candidate.worldId, worldGeneration: candidate.worldGeneration } }));
    return { ...adopted, revision };
  }

  async discardCandidate(taskId: string, candidateId: string, resolvedBy: string, error?: string): Promise<ResourceCandidate> {
    const existing = (await this.store.getResourceCandidate(candidateId));
    if (!existing || existing.taskId !== taskId) throw new Error('resource candidate does not belong to task');
    if (existing.state === 'discarded') return existing;
    const candidate = (await this.store.beginDiscardResourceCandidate(candidateId, taskId));
    await this.deleteAttachment(candidate.attachmentId);
    const discarded = (await this.store.resolveResourceCandidate(candidate.id, 'discarded', resolvedBy, error));
    (await this.store.kvDelete(`resource-candidate-observed:${candidate.id}`));
    (await this.store.appendAudit({ principalId: resolvedBy, action: 'resource:candidate-discard',
      scopeKey: `project:${candidate.projectId}`, detail: { candidateId, attachmentId: candidate.attachmentId,
        taskId, worldId: candidate.worldId, worldGeneration: candidate.worldGeneration, ...(error ? { error } : {}) } }));
    return discarded;
  }

  async discardTaskCandidates(taskId: string, resolvedBy: string): Promise<void> {
    for (const candidate of (await this.store.listResourceCandidates(taskId))
      .filter((value) => value.state === 'pending' || value.state === 'discarding'))
      await this.discardCandidate(taskId, candidate.id, resolvedBy);
  }

  /** Metadata-only safety net for ignored output that has neither an attachment
   * nor a staged candidate. No bytes are read and the bounded result is safe to
   * show at checkpoint/Review. */
  async ignoredInventory(taskId: string, limit = 100, checkContinue?: () => Promise<void>): Promise<IgnoredResourceInventory> {
    const { handle, world } = await this.currentTaskWorld(taskId);
    const excluded = [
      ...Object.values((handle.meta?.resourceProjections ?? {}) as Record<string, { target?: string }>)
        .map((projection) => projection.target).filter((value): value is string => Boolean(value)),
      ...(await this.store.listResourceCandidates(taskId, false)).map((candidate) => candidate.sourcePath)
        .filter((value): value is string => Boolean(value)).map((value) => worldWorkingRelativePath(handle, value)),
    ];
    const found: IgnoredResourceInventory['entries'] = [];
    let truncated = false;
    const repos = worldRepos(handle);
    for (const repo of repos) {
      await checkContinue?.();
      const listed = await world.exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: repo.root });
      if (listed.code !== 0) continue;
      for (const raw of listed.stdout.split('\0').filter(Boolean)) {
        const local = raw.replace(/\/$/, '');
        const relative = repos.length > 1 ? `${repo.name}/${local}` : local;
        if (excluded.some((root) => pathsOverlap(root, relative))) continue;
        if (found.length >= Math.max(1, Math.min(limit, 500))) { truncated = true; break; }
        await checkContinue?.();
        const sized = await world.exec('du', ['-sb', '--', local], { cwd: repo.root });
        const bytes = sized.code === 0 ? Number(sized.stdout.trim().split(/\s+/)[0]) : 0;
        found.push({ ...(repos.length > 1 ? { checkout: repo.name } : {}), path: relative,
          bytes: Number.isFinite(bytes) ? bytes : 0, likelySecret: likelySecretPath(relative) });
      }
      if (truncated) break;
    }
    return { entries: found, truncated };
  }

  private async currentTaskWorld(taskId: string) {
    const task = (await this.store.getTask(taskId));
    if (!task) throw new Error('calling task not found');
    const project = (await this.store.getProject(task.projectId));
    if (!project?.organizationId) throw new Error('calling task project is unavailable');
    const handle = (await this.store.currentWorld(taskId)) as WorldHandle | undefined;
    if (!handle) throw new Error('calling task has no active world');
    (await this.store.assertCurrentWorld(handle));
    return { task, project, handle, world: await this.worlds.open(handle) };
  }

  private async requiredCandidate(taskId: string, candidateId: string): Promise<ResourceCandidate> {
    const candidate = (await this.store.getResourceCandidate(candidateId));
    if (!candidate || candidate.taskId !== taskId) throw new Error('resource candidate does not belong to task');
    return candidate;
  }

  async beginReview(taskId: string, reviewId = 'manual'): Promise<void> {
    await this.store.resourceReview(taskId, { begin: reviewId });
  }

  async reviewExclusions(taskId: string): Promise<string[]> {
    return (await this.store.resourceReview(taskId)).excluded;
  }

  async setReviewExcluded(taskId: string, resourceId: string, excluded: boolean) {
    const task = await this.store.getTask(taskId);
    const resource = await this.store.getResourceAttachment(resourceId);
    if (!task || !resource || resource.projectId !== task.projectId) throw new Error('resource does not belong to task project');
    const candidates = await this.store.listResourceCandidates(taskId);
    const candidate = candidates.find((c) => c.attachmentId === resourceId);
    if (candidate) {
      if (candidate.state !== 'pending') throw new Error('resource candidate is already resolved');
    } else {
      const world = await this.store.currentWorld(taskId) as WorldHandle | undefined;
      const leases = world ? await this.store.listResourceLeases(world.id, world.generation ?? 1) : [];
      if (resource.publish !== 'review' || resource.access !== 'write' || resource.isolation !== 'fork'
        || !leases.some((lease) => lease.attachmentId === resourceId && lease.state === 'active'))
        throw new Error('task has no reviewable fork for resource');
    }
    const state = await this.store.resourceReview(taskId, { resourceId, excluded });
    return { resourceId, excluded: state.excluded.includes(resourceId) };
  }

  /** Runs once all confirmation layers approve, inside a retriable workflow activity.
   * Freeze all choices together; individual publication CAS fences remain authoritative. */
  /** Output the task proposed that has no snapshot yet and was not excluded:
   * completing now would lose it with the task's world. Its path, and why the
   * last save failed. */
  async unsavedCandidates(taskId: string): Promise<Array<{ path: string; error?: string }>> {
    const excluded = new Set((await this.store.resourceReview(taskId)).excluded);
    const unsaved: Array<{ path: string; error?: string }> = [];
    for (const candidate of await this.store.listResourceCandidates(taskId, false)) {
      if (candidate.state !== 'pending' || candidate.sourceKind !== 'path' || excluded.has(candidate.attachmentId)) continue;
      if (!(await this.store.getResourceAttachment(candidate.attachmentId))?.currentRevisionId)
        unsaved.push({ path: candidate.sourcePath ?? candidate.attachmentId, ...(candidate.error ? { error: candidate.error } : {}) });
    }
    return unsaved;
  }

  async settleReview(taskId: string): Promise<void> {
    const selection = await this.store.resourceReview(taskId, { freeze: true });
    const excluded = new Set(selection.excluded);
    const principal = `task:${taskId}:confirmation`;
    const candidates = await this.store.listResourceCandidates(taskId);
    for (const candidate of candidates) {
      if (candidate.state === 'discarding' || (candidate.state === 'pending' && excluded.has(candidate.attachmentId)))
        await this.discardCandidate(taskId, candidate.id, principal);
      else if (candidate.state === 'pending' && candidate.sourceKind === 'path'
        && !(await this.store.getResourceAttachment(candidate.attachmentId))?.currentRevisionId)
        // Staging never finished (or a pre-staging workflow lost it). There are
        // no bytes to adopt; failing the confirmed task over it helps no one.
        await this.discardCandidate(taskId, candidate.id, 'system:resource-stage-failed',
          'its snapshot never completed');
      else if (candidate.state === 'pending') await this.adoptCandidate(taskId, candidate.id, principal);
    }
    const world = await this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!world) return;
    const candidateIds = new Set(candidates.map((c) => c.attachmentId));
    for (const lease of await this.store.listResourceLeases(world.id, world.generation ?? 1)) {
      if (lease.state !== 'active' || candidateIds.has(lease.attachmentId)) continue;
      const resource = await this.store.getResourceAttachment(lease.attachmentId);
      if (!resource || resource.publish !== 'review' || resource.access !== 'write' || resource.isolation !== 'fork' || resource.target.kind !== 'path') continue;
      if (excluded.has(resource.id)) { await this.discard(taskId, resource.id); continue; }
      const summary = await this.summarize(taskId, resource.id);
      if (!summary.promoted && summary.added + summary.modified + summary.deleted > 0)
        await this.promoteReviewed(taskId, resource.id, summary);
    }
  }

  async summarize(taskId: string, attachmentId: string): Promise<ResourceChangeSummary> {
    const { attachment, world, lease, target } = await this.worldResource(taskId, attachmentId);
    const started = lease.revisionId ? await this.store.getResourceRevision(lease.revisionId) : undefined;
    // What the world holds now, saved: deduplicated against the version it
    // started from, so mostly a scan, and its publication finds it all stored.
    const repository = await this.restic.current(attachment);
    const parent = this.parentIn(repository, started);
    const inspected = await this.restic.backup({ world, path: target, file: fileShaped(attachment) }, repository, {
      key: `inspect:${lease.id}`, quota: true, ...(parent ? { parent } : {}) });
    const summary: ResourceChangeSummary = { attachmentId: attachment.id, baseRevisionId: lease.revisionId,
      ...await this.changes(repository, started, inspected.snapshot) };
    // Keep the lease's original baseline (and its publication CAS fence), but
    // stop asking for a decision on bytes this task has already published.
    let publishedId = attachment.currentRevisionId;
    const visited = new Set<string>();
    while (publishedId && publishedId !== lease.revisionId && !visited.has(publishedId)) {
      visited.add(publishedId);
      const published = await this.store.getResourceRevision(publishedId);
      if (!published) break;
      if (published.createdByTaskId === taskId) {
        const reviewed = await this.changes(repository, published, inspected.snapshot);
        summary.promoted = reviewed.added + reviewed.modified + reviewed.deleted === 0;
        break;
      }
      // Follow only published ancestry: failed CAS captures and checkpoints do
      // not count. Later promotions by other tasks must not revive this card.
      publishedId = published.parentRevisionId;
    }
    (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:inspect',
      scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, summary } }));
    return summary;
  }

  /** What a snapshot changes relative to a revision (none: everything is new). */
  private async changes(repository: Repository, base: ResourceRevision | undefined, snapshot: string)
    : Promise<Omit<ResourceChangeSummary, 'attachmentId' | 'baseRevisionId'>> {
    const restic = this.restic;
    const parent = this.parentIn(repository, base);
    if (parent) return restic.diff(repository, parent, snapshot);
    // A version in another repository (another location, or saved before
    // restic) is compared by its listing: a file whose size is unchanged
    // counts as unchanged.
    const before = new Map((!base ? [] : base.engine === RESTIC_ENGINE
      ? await restic.files(restic.of(repository.attachment, base), resticRef(base).snapshot)
      : (await this.engine.manifest(base)).files).map((file) => [file.path, file.bytes]));
    const after = await restic.files(repository, snapshot);
    let added = 0; let modified = 0; let bytes = 0;
    const changedPaths: string[] = [];
    for (const file of after) {
      const prior = before.get(file.path);
      before.delete(file.path);
      if (prior === undefined) added++;
      else if (prior !== file.bytes) modified++;
      else continue;
      bytes += file.bytes;
      if (changedPaths.length < 100) changedPaths.push(file.path);
    }
    for (const file of before.keys()) if (changedPaths.length < 100) changedPaths.push(file);
    return { added, modified, deleted: before.size, bytes, changedPaths };
  }

  /** Capture writable task forks for portable hibernation without promoting
   * them to the project's current baseline. */
  async checkpoint(handle: WorldHandle, checkContinue?: () => Promise<void>): Promise<Array<{ attachmentId: string; revisionId: string }>> {
    const world = await this.worlds.open(handle);
    const refs: Array<{ attachmentId: string; revisionId: string }> = [];
    for (const lease of (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))) {
      await checkContinue?.();
      if (lease.state !== 'active') continue;
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      if (!attachment || !isSnapshotDriver(attachment.driver) || attachment.target.kind !== 'path') continue;
      if (attachment.access === 'read' && lease.revisionId) {
        refs.push({ attachmentId: attachment.id, revisionId: lease.revisionId });
        continue;
      }
      // The previous park of this lease is the baseline, else the revision the
      // world started from: an unchanged resource keeps its existing revision (LT-11).
      const baselineKey = `resource-checkpoint:${handle.id}:${attachment.id}`;
      let recorded: { leaseId?: string; revisionId?: string } = {};
      try { recorded = JSON.parse((await this.store.kvGet(baselineKey)) ?? '{}'); } catch {}
      const baselineId = recorded.leaseId === lease.id ? recorded.revisionId : lease.revisionId;
      const found = baselineId ? (await this.store.getResourceRevision(baselineId)) : undefined;
      const baseline = found?.attachmentId === attachment.id ? found : undefined;
      // A park's capture of the task's private copy is work in progress:
      // counted, never refused (see WorldCheckpointService).
      const captured = await this.capture({ world, path: resourceAbsolutePath(handle, attachment), file: fileShaped(attachment) },
        attachment, baseline, { key: `checkpoint:${lease.id}`, quota: false, checkContinue });
      const revisionId = !captured && baseline ? baseline.id : (await this.store.saveResourceRevision({ attachmentId: attachment.id,
        parentRevisionId: lease.revisionId, ...captured!.fields, metadata: { checkpoint: true }, createdByTaskId: lease.taskId })).id;
      (await this.store.kvSet(baselineKey, JSON.stringify({ leaseId: lease.id, revisionId })));
      refs.push({ attachmentId: attachment.id, revisionId });
    }
    return refs;
  }

  async promote(taskId: string, attachmentId: string): Promise<{ attachment: ResourceAttachment; revision: ResourceRevision; summary: ResourceChangeSummary }> {
    return this.promoteReviewed(taskId, attachmentId);
  }

  private async promoteReviewed(taskId: string, attachmentId: string, inspected?: ResourceChangeSummary): Promise<{ attachment: ResourceAttachment; revision: ResourceRevision; summary: ResourceChangeSummary }> {
    const { attachment, world, lease, target } = await this.worldResource(taskId, attachmentId);
    if (attachment.publish !== 'review' || attachment.access !== 'write' || attachment.isolation !== 'fork')
      throw new Error('resource is not configured for reviewed promotion');
    const summary = inspected ?? await this.summarize(taskId, attachmentId);
    // Save the immutable candidate before entering the singleton. The only
    // serialized operation is the tiny baseline pointer CAS, so a multi-GB
    // upload cannot block another publication merely while bytes are moving.
    const started = lease.revisionId ? await this.store.getResourceRevision(lease.revisionId) : undefined;
    const captured = await this.capture({ world, path: target, file: fileShaped(attachment) },
      attachment, started?.attachmentId === attachment.id ? started : undefined, { key: `publish:${lease.id}`, quota: true });
    // Identical to what the world started from: there is nothing to publish.
    if (!captured && started) return { attachment, revision: started, summary };
    const baseline = await this.publicationBaseline(taskId, attachment.currentRevisionId, lease.revisionId);
    const revision = (await this.store.saveResourceRevision({ attachmentId, parentRevisionId: baseline,
      ...captured!.fields, metadata: { summary }, createdByTaskId: taskId }));
    return this.serializePublish(attachmentId, taskId, async () => {
      const promoted = (await this.store.promoteResourceRevision(attachmentId, revision.id, baseline));
      (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:promote',
        scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, from: baseline, to: revision.id, summary } }));
      return { attachment: promoted, revision, summary };
    });
  }

  /** The revision a publication must replace. A task that already published
   * since it forked fast-forwards over its own publications; anything another
   * task published in between keeps the fork's revision, so the CAS fails. */
  private async publicationBaseline(taskId: string, currentId: string | undefined, forkedId: string | undefined) {
    const visited = new Set<string>();
    let id = currentId;
    while (id && id !== forkedId && !visited.has(id)) {
      visited.add(id);
      const published = await this.store.getResourceRevision(id);
      if (published?.createdByTaskId !== taskId) return forkedId;
      id = published.parentRevisionId;
    }
    return id === forkedId ? currentId : forkedId;
  }

  async discard(taskId: string, attachmentId: string): Promise<void> {
    const { attachment, lease } = await this.worldResource(taskId, attachmentId);
    (await this.store.updateResourceLease(lease.id, 'released'));
    (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:discard',
      scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, revisionId: lease.revisionId, leaseId: lease.id } }));
  }

  private async worldResource(taskId: string, attachmentId: string) {
    const handle = (await this.store.currentWorld(taskId)) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no active world');
    (await this.store.assertCurrentWorld(handle));
    const attachment = (await this.requiredAttachment(attachmentId));
    const task = (await this.store.getTask(taskId));
    if (!task || task.projectId !== attachment.projectId) throw new Error('resource does not belong to task project');
    const lease = (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))
      .find((candidate) => candidate.attachmentId === attachmentId && candidate.state === 'active');
    if (!lease) throw new Error('task has no active lease for resource');
    if (attachment.target.kind !== 'path') throw new Error('resource has no filesystem state to publish');
    return { attachment, lease, target: resourceAbsolutePath(handle, attachment), world: await this.worlds.open(handle) };
  }

  private async requiredAttachment(id: string): Promise<ResourceAttachment> {
    const value = (await this.store.getResourceAttachment(id));
    if (!value) throw new Error('resource attachment not found');
    return value;
  }

  private async resolveSecret(attachment: ResourceAttachment, taskId: string): Promise<string> {
    const handle = await this.ownedCredentialHandle(attachment);
    // The world receives this value; scrub it from what tavya keeps of the task (SS-3).
    (await recordSecretRefs(this.store, taskId, [handleRef(handle)]));
    return this.broker.resolve(handle, { taskId, caps: [`use-credential:${handle}`] });
  }

  /** A resource grants itself the use of one credential, so it may name only
   * its own secret or a field of a vault item of its own organization. The
   * vault also holds other tenants' credentials and the installation's own
   * keys (the GitHub App's under a fixed name); a stored handle naming any of
   * those is refused, never resolved (AU-40). */
  private async ownedCredentialHandle(attachment: ResourceAttachment): Promise<string> {
    const handle = attachment.credentialHandles[0];
    if (handle && handle === resourceSecretHandle(attachment.id)) return handle;
    const { vaultItemId, vaultField } = attachment.source;
    if (handle && typeof vaultItemId === 'string' && typeof vaultField === 'string'
      && handle === itemHandle(vaultItemId, vaultField as VaultFieldName)) {
      const item = await new VaultItems(this.store, this.broker, undefined, attachment.organizationId).get(vaultItemId);
      if (item?.fields.includes(vaultField as VaultFieldName)) return handle;
    }
    throw new Error(`resource "${attachment.name}" names a credential it does not own`);
  }

  private async serializePublish<T>(key: string, taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.coordinator) return this.serializeDurably(key, taskId, action);
    const previous = this.publishLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.publishLocks.set(key, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.publishLocks.get(key) === tail) this.publishLocks.delete(key);
    }
  }

  private async serializeDurably<T>(attachmentId: string, taskId: string, action: () => Promise<T>): Promise<T> {
    const { client, taskQueue } = this.coordinator!;
    const workflowId = resourcePublishCoordinatorId(attachmentId);
    const token = newId('publish');
    let granted = false;
    try {
      await client.workflow.signalWithStart(RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, {
        workflowId, taskQueue, args: [{ attachmentId }], signal: SIG_ENQUEUE_RESOURCE_PUBLISH,
        signalArgs: [{ token, taskId }],
      });
      const handle = client.workflow.getHandle(workflowId);
      const deadline = Date.now() + 30 * 60_000;
      let pollMs = 100;
      while (Date.now() < deadline) {
        const view = await handle.query<ResourcePublishView>(QRY_RESOURCE_PUBLISH);
        if (view.current?.token === token) { granted = true; break; }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        pollMs = Math.min(pollMs * 2, 5000);
      }
      if (!granted) throw new Error('timed out waiting to publish resource');
      return await action();
    } finally {
      await client.workflow.getHandle(workflowId).signal(granted ? SIG_RELEASE_RESOURCE_PUBLISH : SIG_CANCEL_RESOURCE_PUBLISH,
        { token }).catch(() => undefined);
    }
  }
}

class EnvironmentWorld implements World {
  /** Present only when the inner world has it: its absence marks a local world. */
  readonly diagnose?: World['diagnose'];
  readonly addCheckout?: World['addCheckout'];
  readonly readFilePrefix?: World['readFilePrefix'];
  readonly readFileStream?: World['readFileStream'];
  constructor(private inner: World, private env: Record<string, string>) {
    if (inner.readFilePrefix) this.readFilePrefix = (path, maxBytes) => inner.readFilePrefix!(path, maxBytes);
    if (inner.readFileStream) this.readFileStream = (path) => inner.readFileStream!(path);
    if (inner.addCheckout) this.addCheckout = spec => inner.addCheckout!(spec);
    if (inner.diagnose) this.diagnose = (window) => inner.diagnose!(window);
  }
  withoutProjectEnvironment(): World { return this.inner.withoutProjectEnvironment?.() ?? this.inner; }
  get handle() { return this.inner.handle; }
  set handle(value: WorldHandle) { this.inner.handle = value; }
  exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.inner.exec(cmd, args, { ...opts, env: { ...this.env, ...opts.env } });
  }
  readFile(path: string) { return this.inner.readFile(path); }
  readFileBuffer(path: string) { return this.inner.readFileBuffer(path); }
  writeFile(path: string, value: string) { return this.inner.writeFile(path, value); }
  writeFileBuffer(path: string, value: Buffer) { return this.inner.writeFileBuffer
    ? this.inner.writeFileBuffer(path, value) : this.inner.writeFile(path, value.toString('utf8')); }
  listFiles() { return this.inner.listFiles(); }
  startProcess(spec: WorldProcessSpec): Promise<WorldProcess> { return this.inner.startProcess({ ...spec, env: { ...this.env, ...spec.env } }); }
  openPty(spec: WorldPtySpec = {}): Promise<WorldPty> { return this.inner.openPty({ ...spec, env: { ...this.env, ...spec.env } }); }
  fetchPort(port: number, requestPath: string, request?: WorldHttpRequest): Promise<WorldHttpResponse> {
    if (!this.inner.fetchPort) throw new Error('world does not support ports');
    return this.inner.fetchPort(port, requestPath, request);
  }
  previewSocketTarget(port: number, requestPath: string) { return this.inner.previewSocketTarget?.(port, requestPath)
    ?? Promise.reject(new Error('world does not support preview sockets')); }
  desktopSession() { return this.inner.desktopSession?.() ?? Promise.reject(new Error('world does not support desktop sessions')); }
  destroy() { return this.inner.destroy(); }
}


/** Read only files small enough to become credential-backed resources. The
 * extra byte closes the stat/read race: a file that grows while migration runs
 * is classified as a streamed snapshot instead of being buffered without bound. */
async function readSmallFile(file: string, maximumBytes: number): Promise<Buffer | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset > maximumBytes ? undefined : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** Stream a resource's files out of a world. One command lists every file with
 * its size and stamp; a file's bytes are read only if the consumer reads them,
 * which an unchanged file in an incremental capture never does (LT-11). Small
 * files can be read many to a round trip through their `range`; larger ones
 * stream one at a time. */
function pathContains(root: string, value: string): boolean {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedValue = value.replace(/\\/g, '/').replace(/\/$/, '');
  return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function likelySecretPath(value: string): boolean {
  const base = path.posix.basename(value).toLowerCase();
  return /^\.env(?:\.|$)/.test(base) || /(?:secret|credential|token|private[-_.]?key|\.pem$|\.p12$|\.key$)/i.test(base);
}

async function* asAsync(values: Iterable<SnapshotInputFile> | AsyncIterable<SnapshotInputFile>): AsyncGenerator<SnapshotInputFile> {
  for await (const value of values as AsyncIterable<SnapshotInputFile>) yield value;
}

function isSecretLike(value: ResourceAttachment): boolean { return credentialResource(value); }
/** Projections are physical, world-root-relative paths, pinned for the lifetime
 * of a generation. Honor historical root projections even if the agent cwd has
 * since changed; never capture an unrelated file from the new cwd. */
function resourcePath(handle: WorldHandle, attachment: ResourceAttachment): string {
  const projections = handle.meta?.resourceProjections as Record<string, { target?: string }> | undefined;
  const pinned = projections?.[attachment.id]?.target;
  if (pinned) return safePath(pinned);
  if (attachment.target.kind !== 'path') throw new Error('resource has no filesystem target');
  // Historical file secrets were root-relative and recorded only as ephemeral.
  if (Array.isArray(handle.meta?.ephemeralPaths) && handle.meta.ephemeralPaths.includes(attachment.target.path))
    return safePath(attachment.target.path);
  return worldWorkingRelativePath(handle, attachment.target.path);
}
function resourceAbsolutePath(handle: WorldHandle, attachment: ResourceAttachment): string {
  return path.posix.join(handle.root, resourcePath(handle, attachment));
}
function isSnapshotDriver(value: string): boolean { return snapshotResource(value); }
function fileShaped(value: ResourceAttachment): boolean { return value.source.shape === 'file'; }
function parseCopyEnv(value: string): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const raw of value.split('\n')) {
    const match = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let secret = match[2]!.trim();
    if ((secret.startsWith('"') && secret.endsWith('"')) || (secret.startsWith("'") && secret.endsWith("'")))
      secret = secret.slice(1, -1);
    else secret = secret.replace(/\s+#.*$/, '');
    if (secret) entries.push({ name: match[1]!, value: secret });
  }
  return entries;
}
function copyGlobSecretName(file: string): string {
  const value = file.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'FILE';
  return /^[A-Z_]/.test(value) ? value : `FILE_${value}`;
}
function copyGlobRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
function copyGlobRepoNames(sources: string[]): string[] {
  const used = new Set<string>();
  return sources.map((source) => {
    const base = (source.split(/[/:]/).filter(Boolean).pop() ?? 'repo').replace(/\.git$/i, '')
      .replace(/[^a-zA-Z0-9_.-]/g, '-') || 'repo';
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
    used.add(name);
    return name;
  });
}
function safePath(value: string): string { return worldRelativePath(value); }
function writtenPrefix(handle: WorldHandle): string { return `${handle.id}\0${handle.generation ?? 1}\0`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** The key an object was sealed with: its capture key, else the organization's. */
function objectKey(manifest: SnapshotManifest, organizationKey: Buffer, id: string): Buffer {
  const keyId = manifest.keyed?.[id];
  return keyId ? Buffer.from(manifest.keys![keyId]!.key, 'base64') : organizationKey;
}

function manifestDigest(files: SnapshotEntry[], packs?: string[], keyed?: Record<string, string>): string {
  return sha256(Buffer.from(JSON.stringify(packs ? (keyed && Object.keys(keyed).length ? { packs, files, keyed } : { packs, files }) : files)));
}
/** Every object a manifest references, once each. */
function manifestObjects(manifest: SnapshotManifest): string[] {
  return [...new Set([...manifest.packs ?? [], ...manifest.files.flatMap((file) => 'chunks' in file ? file.chunks : [])])];
}

interface ProgressStore {
  get(key: string): Promise<string | undefined>;
  compareAndSet(key: string, expected: string | undefined, next: string | undefined): Promise<boolean>;
  /** Keys starting with a prefix. */
  keys(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** Remove the progress record (`resource-capture:<attachment>`, a sealed head
 * and its segments) a capture interrupted before restic left behind, returning
 * the chunk references it held. */
async function takeProgress(store: ProgressStore, key: Buffer | undefined, attachmentId: string)
  : Promise<{ ids: string[]; storageLocationId?: string } | undefined> {
  const recordKey = `resource-capture:${attachmentId}`;
  const dropSegments = async () => { for (const segment of await store.keys(`${recordKey}:`)) await store.delete(segment); };
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await store.get(recordKey);
    if (value === undefined) { await dropSegments(); return undefined; }
    if (!await store.compareAndSet(recordKey, value, undefined)) continue;
    await dropSegments();
    let head: { attachmentId?: string; held?: Array<[string, number]>; storageLocationId?: string } | undefined;
    try { head = key ? JSON.parse(openRandom(key, Buffer.from(value, 'base64')).toString('utf8')) : undefined; } catch { head = undefined; }
    return head?.attachmentId === attachmentId && Array.isArray(head.held)
      ? { ids: head.held.map(([id]) => id), storageLocationId: head.storageLocationId } : { ids: [] };
  }
  throw new Error('resource capture progress kept changing');
}
