import crypto from 'node:crypto';
import { transferResourceChunk, readResourceChunks } from './resource-transfer.js';
import { forEachConcurrent } from '../util/async-batch.js';
import { timed } from '../timing/index.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { IgnoredResourceInventory, Project, ResourceAttachment, ResourceAccess, ResourceCandidate,
  ResourceChangeSummary, ResourcePublishPolicy, ResourceRevision, ResourceTarget } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { StorageLocationService } from '../store/storage-locations.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { ExecOptions, ExecResult, World, WorldHandle, WorldHttpRequest, WorldHttpResponse,
  WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec } from './types.js';
import { worldRelativePath, worldRepos, worldWorkingRelativePath } from './types.js';
import type { WorldRegistry } from './registry.js';
import { QRY_RESOURCE_PUBLISH, RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, SIG_CANCEL_RESOURCE_PUBLISH,
  SIG_ENQUEUE_RESOURCE_PUBLISH, SIG_RELEASE_RESOURCE_PUBLISH,
  resourcePublishCoordinatorId } from '../coordinators/names.js';
import type { ResourcePublishView } from '../coordinators/resource-publish.js';
import { credentialResource, resourceSecretHandle, snapshotResource } from '../domain/resource-drivers.js';
import { VaultItems, itemHandle, type VaultFieldName } from '../autonomy/vault-items.js';
import { ensureWorldExcluded } from './secret-exclude.js';
import { expandPath } from '../util/expand.js';
import { managedRepoPath } from './worktree.js';
import { CHUNK_BYTES, chunkId as contentChunkId, chunkObjectKey, fixedChunks, openDeterministic, openRandom,
  organizationKey, organizationKeyHandle, sealDeterministic, sealRandom, sha256 } from './chunk-store.js';

const COPY_GLOB_SECRET_BYTES = 64 * 1024;

interface SnapshotFile { path: string; bytes: number; sha256: string; chunks: string[] }
interface SnapshotManifest { version: 1; attachmentId: string; files: SnapshotFile[]; rootDigest: string; bytes: number }
interface SnapshotRef { objectKey: string; sha256: string; storageLocationId?: string }
/** `data` is consumed only when the file must be read: an input whose
 * `observed` stamp matches the one recorded with the baseline reuses the
 * baseline's chunks. */
export interface SnapshotInputFile { path: string; data: Buffer | AsyncIterable<Buffer>; bytes?: number; observed?: string }
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

/** Replaceable snapshot data-plane contract (SPEC §11.4). The built-in engine
 * keeps the first release self-contained; production deployments can substitute
 * Kopia without changing resource, lease, or workflow records. */
export interface SnapshotEngine {
  readonly id: string;
  /** An `incremental` capture may reuse its `baseline` revision's chunks, and
   * `unchanged: true` means it equals the baseline, whose sealedRef is returned
   * instead of a new manifest. It also returns `observed`, an opaque sealed
   * record of the file stamps it saw; passing that back with the revision this
   * capture resolved to lets the next one skip files whose stamps match. */
  capture(attachment: ResourceAttachment, files: AsyncIterable<SnapshotInputFile>,
    incremental?: { baseline?: ResourceRevision; observed?: string }): Promise<{
    sealedRef: string; rootDigest: string; bytes: number; files: number; storageLocationId?: string; unchanged?: boolean;
    observed?: string;
  }>;
  restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options?: { signal?: AbortSignal }): Promise<void>;
  manifest(revision: ResourceRevision): Promise<SnapshotManifest>;
  verify?(revision: ResourceRevision, offset: number, limit: number): Promise<SnapshotVerification>;
  delete?(revision: ResourceRevision): Promise<void>;
}

/** Tenant-keyed, encrypted content-addressed engine over the configured object
 * store. Chunks are deliberately behind SnapshotEngine so a Kopia-backed engine
 * can replace this compatibility implementation without changing durable rows. */
export class ObjectSnapshotEngine implements SnapshotEngine {
  readonly id = 'object-snapshot@1';
  constructor(private objects: ObjectStore, private broker: CredentialBroker,
    private storageLocations?: StorageLocationService) {}

  async objectStoreForAttachment(attachment: ResourceAttachment): Promise<ObjectStore> {
    const id = (await this.storageLocations?.requireForOrganization(attachment.organizationId, attachment.storageLocationId))?.id
      ?? attachment.storageLocationId;
    return id && this.storageLocations ? (await this.storageLocations.objectStore(id)) : this.objects;
  }

  async capture(attachment: ResourceAttachment, files: AsyncIterable<SnapshotInputFile>,
    incremental?: { baseline?: ResourceRevision; observed?: string }) {
    const key = await this.key(attachment.organizationId);
    const storageLocationId = this.storageLocations
      ? (await this.storageLocations.requireForOrganization(attachment.organizationId, attachment.storageLocationId)).id
      : attachment.storageLocationId;
    const chunkNamespace = storageLocationId && this.storageLocations
      && (await this.storageLocations.requireForOrganization(attachment.organizationId, storageLocationId)).kind === 's3'
      ? storageLocationId : undefined;
    const objects = storageLocationId && this.storageLocations ? (await this.storageLocations.objectStore(storageLocationId)) : this.objects;
    // Chunks referenced by the baseline already exist in this location, so an
    // unchanged file needs neither a read nor an upload (LT-11). The baseline's
    // revision holds their references until the new one retains its own.
    const baselineRevision = incremental?.baseline;
    const baseline = baselineRevision?.attachmentId === attachment.id && baselineRevision.engine === this.id
      && (baselineRevision.storageLocationId ?? undefined) === (storageLocationId ?? undefined)
      ? await this.manifest(baselineRevision).catch(() => undefined) : undefined;
    const stamps = baseline && incremental?.observed ? openStamps(key, incremental.observed, attachment.id, baseline.rootDigest) : undefined;
    const previous = new Map(baseline?.files.map((file) => [file.path, file]));
    const stored = new Set(baseline?.files.flatMap((file) => file.chunks));
    const manifestFiles: SnapshotFile[] = [];
    const observed: Record<string, string> = {};
    const retained = new Map<string, number>();
    const reused = new Map<string, number>();
    let total = 0;
    try {
      for await (const input of files) {
        const relative = safePath(input.path);
        if (incremental && input.observed) observed[relative] = input.observed;
        const prior = previous.get(relative);
        if (prior && input.observed && stamps?.[relative] === input.observed) {
          prior.chunks.forEach((chunkId, index) => {
            if (!retained.has(chunkId)) reused.set(chunkId, Math.min(CHUNK_BYTES, prior.bytes - index * CHUNK_BYTES));
          });
          total += prior.bytes;
          manifestFiles.push(prior);
          continue;
        }
        const chunks: string[] = [];
        const digest = crypto.createHash('sha256');
        let fileBytes = 0;
        for await (const plain of fixedChunks(input.data)) {
          const chunkId = contentChunkId(key, chunkNamespace, plain);
          if (stored.has(chunkId)) {
            if (!retained.has(chunkId)) reused.set(chunkId, plain.length);
          } else {
            if (!retained.has(chunkId)) {
              await this.chunkAccounting?.retain(attachment.organizationId, [{ id: chunkId, bytes: plain.length }], storageLocationId);
              retained.set(chunkId, plain.length);
            }
            await objects.put(chunkObjectKey(attachment.organizationId, chunkId), sealDeterministic(key, chunkId, plain));
          }
          chunks.push(chunkId);
          digest.update(plain);
          fileBytes += plain.length;
        }
        if (input.bytes !== undefined && fileBytes !== input.bytes)
          throw new Error('resource capture size mismatch');
        total += fileBytes;
        manifestFiles.push({ path: relative, bytes: fileBytes, sha256: digest.digest('hex'), chunks });
      }
      manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
      const rootDigest = sha256(Buffer.from(JSON.stringify(manifestFiles)));
      const sealedStamps = Object.keys(observed).length ? sealStamps(key, attachment.id, rootDigest, observed) : undefined;
      if (baseline && rootDigest === baseline.rootDigest && !retained.size)
        return { sealedRef: baselineRevision!.sealedRef, rootDigest, bytes: total, files: manifestFiles.length, storageLocationId,
          unchanged: true, ...(sealedStamps ? { observed: sealedStamps } : {}) };
      if (reused.size) {
        await this.chunkAccounting?.retain(attachment.organizationId, [...reused].map(([id, bytes]) => ({ id, bytes })), storageLocationId);
        for (const [id, bytes] of reused) retained.set(id, bytes);
      }
      const manifest: SnapshotManifest = { version: 1, attachmentId: attachment.id, files: manifestFiles, rootDigest, bytes: total };
      const encrypted = sealRandom(key, Buffer.from(JSON.stringify(manifest)));
      const objectKey = `resources/${attachment.organizationId}/manifests/${attachment.id}/${newId('snapshot')}.bin`;
      await objects.put(objectKey, encrypted);
      return { sealedRef: JSON.stringify({ objectKey, sha256: sha256(encrypted), storageLocationId } satisfies SnapshotRef),
        rootDigest, bytes: total, files: manifestFiles.length, storageLocationId,
        ...(sealedStamps ? { observed: sealedStamps } : {}) };
    } catch (error) {
      const zero = (await this.chunkAccounting?.release(attachment.organizationId, [...retained.keys()])) ?? [];
      await Promise.allSettled(zero.map((chunkId) => objects.delete(chunkObjectKey(attachment.organizationId, chunkId))));
      throw error;
    }
  }

  async restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const manifest = await this.manifest(revision);
    // Bound memory and request fan-out. Chunks of each file remain ordered;
    // independent files can transfer together. Settle all writes before cleanup.
    await forEachConcurrent(manifest.files, async file => {
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
      for await (const data of this.readFile(revision, file)) {
        options.signal?.throwIfAborted();
        buffered.push(data); bytes += data.length;
        if (bytes >= 2 * CHUNK_BYTES) await flush();
      }
      if (buffered.length) await flush();
    }, 4);
  }

  /** One shared streaming integrity check for restore and verification. */
  private async *readFile(revision: ResourceRevision, file: SnapshotFile): AsyncIterable<Buffer> {
    const attachment = (await this.attachmentFor(revision));
    const key = await this.key(attachment.organizationId, false);
    const objects = (await this.objectsForRevision(revision));
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    for (const chunkId of file.chunks) {
      const encrypted = await timed('resource.chunk-read', () => objects.get(chunkObjectKey(attachment.organizationId, chunkId)));
      const data = openDeterministic(key, chunkId, encrypted);
      if (data.length !== Math.min(CHUNK_BYTES, file.bytes - bytes))
        throw new Error('resource chunk size mismatch');
      digest.update(data);
      bytes += data.length;
      yield data;
    }
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256)
      throw new Error('resource snapshot integrity mismatch');
  }

  async verify(revision: ResourceRevision, offset: number, limit: number): Promise<SnapshotVerification> {
    const result: SnapshotVerification = { status: 'failed', manifestVerified: false, offset,
      verifiedFiles: 0, verifiedBytes: 0, files: [] };
    try {
      const manifest = await this.manifest(revision);
      Object.assign(result, { manifestVerified: true, rootDigest: manifest.rootDigest,
        totalFiles: manifest.files.length, totalBytes: manifest.bytes });
      if (offset > manifest.files.length) return { ...result, issue: 'invalid-offset' };
      for (const file of manifest.files.slice(offset, offset + limit)) {
        if (result.verifiedBytes + file.bytes > VERIFY_MAX_BYTES) {
          result.issue = 'byte-limit';
          break;
        }
        // Do not retain plaintext. Exhaustion also checks empty files and the final hash.
        for await (const _data of this.readFile(revision, file)) { /* checked by engine */ }
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

  async manifest(revision: ResourceRevision): Promise<SnapshotManifest> {
    const attachment = (await this.attachmentFor(revision));
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    if (typeof ref.objectKey !== 'string'
      || !ref.objectKey.startsWith(`resources/${attachment.organizationId}/manifests/${attachment.id}/`)
      || ref.objectKey.includes('..') || (ref.storageLocationId && ref.storageLocationId !== revision.storageLocationId))
      throw new Error('resource reference does not match revision');
    const encrypted = await (await this.objectsForRevision(revision, ref)).get(ref.objectKey);
    if (sha256(encrypted) !== ref.sha256) throw new Error('resource manifest integrity mismatch');
    const manifest = JSON.parse(openRandom(await this.key(attachment.organizationId, false), encrypted).toString('utf8')) as SnapshotManifest;
    if (manifest.version !== 1 || manifest.attachmentId !== attachment.id || manifest.rootDigest !== revision.rootDigest)
      throw new Error('resource manifest does not match its revision');
    if (!Array.isArray(manifest.files) || manifest.files.length !== (revision.files ?? manifest.files.length)
      || manifest.bytes !== revision.bytes || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0)
      throw new Error('invalid resource manifest totals');
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || file.path.length > 4096 || safePath(file.path) !== file.path
        || paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256) || !Array.isArray(file.chunks)
        || file.chunks.length !== Math.max(1, Math.ceil(file.bytes / CHUNK_BYTES))
        || file.chunks.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))
        throw new Error('invalid resource manifest file');
      paths.add(file.path);
      bytes += file.bytes;
    }
    if (bytes !== manifest.bytes || sha256(Buffer.from(JSON.stringify(manifest.files))) !== manifest.rootDigest)
      throw new Error('resource manifest tree integrity mismatch');
    return manifest;
  }

  async delete(revision: ResourceRevision): Promise<void> {
    const attachment = (await this.attachmentFor(revision));
    const manifest = await this.manifest(revision);
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    const objects = (await this.objectsForRevision(revision, ref));
    await objects.delete(ref.objectKey);
    const zero = (await this.chunkAccounting?.release(attachment.organizationId,
      [...new Set(manifest.files.flatMap((file) => file.chunks))])) ?? [];
    for (const chunkId of zero) await objects.delete(chunkObjectKey(attachment.organizationId, chunkId));
  }

  private async attachmentFor(revision: ResourceRevision): Promise<ResourceAttachment> {
    const attachment = (await this.attachmentResolver?.(revision.attachmentId));
    if (!attachment) throw new Error('resource attachment no longer exists');
    return attachment;
  }
  private attachmentResolver?: (id: string) => ResourceAttachment | undefined | Promise<ResourceAttachment | undefined>;
  setAttachmentResolver(resolve: (id: string) => ResourceAttachment | undefined | Promise<ResourceAttachment | undefined>): void { this.attachmentResolver = resolve; }
  private chunkAccounting?: {
    retain(organizationId: string, chunks: Array<{ id: string; bytes: number }>, storageLocationId?: string): void | Promise<void>;
    release(organizationId: string, chunkIds: string[]): string[] | Promise<string[]>;
  };
  setChunkAccounting(value: NonNullable<ObjectSnapshotEngine['chunkAccounting']>): void { this.chunkAccounting = value; }

  private async objectsForRevision(revision: ResourceRevision, ref?: SnapshotRef): Promise<ObjectStore> {
    const locationId = ref?.storageLocationId ?? revision.storageLocationId;
    if (locationId && this.storageLocations)
      (await this.storageLocations.requireForOrganization((await this.attachmentFor(revision)).organizationId, locationId));
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

  constructor(private store: Store, private worlds: WorldRegistry, private engine: SnapshotEngine,
    private broker: CredentialBroker, private coordinator?: { client: Client; taskQueue: string },
    private storageLocations?: StorageLocationService) {
    if (engine instanceof ObjectSnapshotEngine) engine.setAttachmentResolver(async (id) => (await store.getResourceAttachment(id)));
    if (engine instanceof ObjectSnapshotEngine) engine.setChunkAccounting({
      retain: async (organizationId, chunks, storageLocationId) => (await store.retainResourceChunks(organizationId, chunks, storageLocationId)),
      release: async (organizationId, chunks) => (await store.releaseResourceChunks(organizationId, chunks)),
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
    if (!isSnapshotDriver(attachment.driver) || revision.engine !== this.engine.id || !this.engine.verify)
      throw new Error('resource revision verification is unsupported');
    if (revision.storageLocationId && this.storageLocations) {
      try { (await this.storageLocations.requireForOrganization(attachment.organizationId, revision.storageLocationId)); }
      catch { throw new Error('resource revision storage is unavailable'); }
    }
    return { projectId, resourceId: attachment.id, revisionId: revision.id,
      storageLocationId: revision.storageLocationId ?? null,
      ...await this.engine.verify(revision, offset, limit) };
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
            if (compression === undefined) compression = world.handle.kind === 'e2b' &&
              (await world.exec('bash', ['-lc', 'command -v gzip >/dev/null'], { cwd: world.handle.root })).code === 0;
            let uploadedBytes = 0;
            const startedAt = Date.now();
            await this.store.appendEvent({ taskId, type: 'world.resource-restoring', ts: startedAt,
              payload: { attachmentId: attachment.id, revisionId, bytes: revision.bytes, files: revision.files } });
            await timed('resource.restore', () => this.engine.restore(revision, async (file, data, offset) => {
              options.signal?.throwIfAborted();
              const relative = fileShaped(attachment) ? target : target === '.' ? file : `${target}/${file}`;
              const sent = await timed('resource.transfer', () => transferResourceChunk(world, relative, data, offset,
                { compress: compression, signal: options.signal }));
              uploadedBytes += sent;
            }, options), { itemId: attachment.id });
            await this.store.appendEvent({ taskId, type: 'world.resource-restored', ts: Date.now(),
              payload: { attachmentId: attachment.id, revisionId, durationMs: Date.now() - startedAt, uploadedBytes } });
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
  async environmentFor(handle: WorldHandle): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const serviceHandles = handle.meta?.serviceEnvironmentHandles;
    if (serviceHandles && typeof serviceHandles === 'object') {
      for (const [name, secretHandle] of Object.entries(serviceHandles as Record<string, unknown>)) {
        if (typeof secretHandle !== 'string') continue;
        env[name] = this.broker.resolve(secretHandle, {
          taskId: handle.id,
          caps: [`use-credential:${secretHandle}`],
        });
      }
    }
    for (const lease of (await this.store.listResourceLeases(handle.id, handle.generation ?? 1))) {
      if (lease.state !== 'active') continue;
      const attachment = (await this.store.getResourceAttachment(lease.attachmentId));
      if (!attachment?.enabled || !isSecretLike(attachment)) continue;
      if (attachment.target.kind === 'environment' || attachment.target.kind === 'service')
        env[attachment.target.name] = await this.resolveSecret(attachment, lease.taskId);
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
  async registerServiceEnvironment(handle: WorldHandle, values: Record<string, string>): Promise<WorldHandle> {
    const refs: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const ref = `world-service:${handle.id}:${handle.generation ?? 1}:${name}`;
      (await this.broker.registerHandle(ref, value));
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
    const attachment = (await this.requiredAttachment(attachmentId));
    if (!isSnapshotDriver(attachment.driver)) throw new Error('only snapshot-backed resources accept files');
    const captured = await this.engine.capture(attachment, asAsync(files));
    const revision = (await this.store.saveResourceRevision({ attachmentId, parentRevisionId: attachment.currentRevisionId,
      engine: this.engine.id, ...captured, metadata: { imported: true }, createdByTaskId }));
    (await this.store.promoteResourceRevision(attachmentId, revision.id, attachment.currentRevisionId));
    (await this.store.recordUsage({ organizationId: attachment.organizationId, projectId: attachment.projectId,
      taskId: createdByTaskId, provider: this.engine.id, kind: 'resource.storage', quantity: captured.bytes,
      unit: 'byte', costMicros: 0, fundingSource: (await this.store.getStorageLocation(captured.storageLocationId ?? ''))?.kind === 's3' ? 'byok' : 'managed',
      startedAt: revision.createdAt, endedAt: revision.createdAt,
      metadata: { attachmentId, revisionId: revision.id, files: captured.files } }));
    return revision;
  }

  async importDirectory(attachmentId: string, source: string): Promise<ResourceRevision> {
    const root = path.resolve(source);
    const stat = await fs.promises.stat(root);
    if (stat.isDirectory()) return this.importFiles(attachmentId, walkDirectory(root));
    if (stat.isFile()) return this.importFiles(attachmentId,
      [{ path: path.basename(root), data: fs.createReadStream(root) as AsyncIterable<Buffer>, bytes: stat.size }]);
    throw new Error('resource import source must be a regular file or directory');
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
                (await this.broker.registerHandle(handle, value.value));
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
              (await this.broker.registerHandle(handle, data.toString('utf8')));
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
  async deleteAttachment(attachmentId: string): Promise<void> {
    const attachment = (await this.store.getResourceAttachment(attachmentId));
    if (!attachment) return;
    for (const revision of (await this.store.listResourceRevisions(attachmentId))) await this.engine.delete?.(revision);
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

  /** Stage a declared non-secret path from the caller's current generation.
   * The disabled attachment reserves its accepted shape, while the encrypted
   * revision makes the bytes durable before a reviewer decides. */
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
    // Create the task/world-generation ownership record before the potentially
    // long snapshot. If the control plane stops mid-stream, Review can still
    // see and discard the incomplete attachment instead of leaking an orphan.
    const candidate = (await this.store.createResourceCandidate({ organizationId: project.organizationId!, projectId: project.id,
      taskId, worldId: handle.id, worldGeneration: handle.generation ?? 1, attachmentId: attachment.id,
      sourceKind: 'path', sourcePath }));
    try {
      const captured = await this.engine.capture(attachment, filesFromWorld(world, sourcePath, attachment));
      const revision = (await this.store.saveResourceRevision({ attachmentId: attachment.id, engine: this.engine.id,
        ...captured, metadata: { candidate: true, sourcePath }, createdByTaskId: task.id }));
      (await this.store.promoteResourceRevision(attachment.id, revision.id));
      (await this.store.recordUsage({ organizationId: project.organizationId!, projectId: project.id, taskId,
        worldId: handle.id, provider: this.engine.id, kind: 'resource.storage', quantity: captured.bytes, unit: 'byte',
        costMicros: 0, fundingSource: (await this.store.getStorageLocation(captured.storageLocationId ?? ''))?.kind === 's3' ? 'byok' : 'managed',
        startedAt: candidate.createdAt, endedAt: candidate.createdAt,
        metadata: { candidateId: candidate.id, attachmentId: attachment.id, revisionId: revision.id, files: captured.files } }));
      (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:candidate-stage',
        scopeKey: `project:${project.id}`, detail: { candidateId: candidate.id, attachmentId: attachment.id,
          sourcePath, worldGeneration: candidate.worldGeneration, bytes: captured.bytes, files: captured.files } }));
      return { candidate, attachment: (await this.store.getResourceAttachment(attachment.id))!, revision };
    } catch (error) {
      await this.discardCandidate(taskId, candidate.id, 'system:resource-stage-failed').catch(() => undefined);
      throw error;
    }
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
    const revision = adopted.attachment.currentRevisionId
      ? (await this.store.getResourceRevision(adopted.attachment.currentRevisionId)) : undefined;
    (await this.store.appendAudit({ principalId: resolvedBy, action: 'resource:candidate-adopt',
      scopeKey: `project:${candidate.projectId}`, detail: { candidateId, attachmentId: candidate.attachmentId,
        taskId, worldId: candidate.worldId, worldGeneration: candidate.worldGeneration } }));
    return { ...adopted, revision };
  }

  async discardCandidate(taskId: string, candidateId: string, resolvedBy: string): Promise<ResourceCandidate> {
    const existing = (await this.store.getResourceCandidate(candidateId));
    if (!existing || existing.taskId !== taskId) throw new Error('resource candidate does not belong to task');
    if (existing.state === 'discarded') return existing;
    const candidate = (await this.store.beginDiscardResourceCandidate(candidateId, taskId));
    await this.deleteAttachment(candidate.attachmentId);
    const discarded = (await this.store.resolveResourceCandidate(candidate.id, 'discarded', resolvedBy));
    (await this.store.appendAudit({ principalId: resolvedBy, action: 'resource:candidate-discard',
      scopeKey: `project:${candidate.projectId}`, detail: { candidateId, attachmentId: candidate.attachmentId,
        taskId, worldId: candidate.worldId, worldGeneration: candidate.worldGeneration } }));
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
  async settleReview(taskId: string): Promise<void> {
    const selection = await this.store.resourceReview(taskId, { freeze: true });
    const excluded = new Set(selection.excluded);
    const principal = `task:${taskId}:confirmation`;
    const candidates = await this.store.listResourceCandidates(taskId);
    for (const candidate of candidates) {
      if (candidate.state === 'discarding' || (candidate.state === 'pending' && excluded.has(candidate.attachmentId)))
        await this.discardCandidate(taskId, candidate.id, principal);
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
    const base = lease.revisionId ? await this.engine.manifest((await this.store.getResourceRevision(lease.revisionId))!) : emptyManifest(attachment.id);
    const current = await manifestFromWorld(attachment, world, target);
    const summary = compareManifests(attachment.id, lease.revisionId, base, current);
    // Keep the lease's original baseline (and its publication CAS fence), but
    // stop asking for a decision on bytes this task has already published.
    let publishedId = attachment.currentRevisionId;
    const visited = new Set<string>();
    while (publishedId && publishedId !== lease.revisionId && !visited.has(publishedId)) {
      visited.add(publishedId);
      const published = await this.store.getResourceRevision(publishedId);
      if (!published) break;
      if (published.createdByTaskId === taskId) {
        const reviewed = compareManifests(attachment.id, published.id, await this.engine.manifest(published), current);
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
      // The previous park of this lease is the incremental baseline, else the
      // revision the world started from: unchanged files are neither read nor
      // uploaded, and an unchanged resource keeps its existing revision (LT-11).
      // The stamps each park saw are kept with that pointer even when nothing
      // changed, so only the first park after a restore reads every file.
      const baselineKey = `resource-checkpoint:${handle.id}:${attachment.id}`;
      let recorded: { leaseId?: string; revisionId?: string; observed?: string } = {};
      try { recorded = JSON.parse((await this.store.kvGet(baselineKey)) ?? '{}'); } catch {}
      const sameLease = recorded.leaseId === lease.id;
      const baselineId = sameLease ? recorded.revisionId : lease.revisionId;
      const baseline = baselineId ? (await this.store.getResourceRevision(baselineId)) : undefined;
      const { unchanged, observed, ...captured } = await this.engine.capture(attachment,
        filesFromWorld(world, resourceAbsolutePath(handle, attachment), attachment, checkContinue),
        { baseline: baseline?.attachmentId === attachment.id ? baseline : undefined, observed: sameLease ? recorded.observed : undefined });
      const revisionId = unchanged && baseline ? baseline.id : (await this.store.saveResourceRevision({ attachmentId: attachment.id,
        parentRevisionId: lease.revisionId, engine: this.engine.id, ...captured, metadata: { checkpoint: true },
        createdByTaskId: lease.taskId })).id;
      (await this.store.kvSet(baselineKey, JSON.stringify({ leaseId: lease.id, revisionId, ...(observed ? { observed } : {}) })));
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
    // Upload the immutable candidate before entering the singleton. The only
    // serialized operation is the tiny baseline pointer CAS, so a multi-GB model
    // upload cannot block another publication merely while bytes are moving.
    const captured = await this.engine.capture(attachment, filesFromWorld(world, target, attachment));
    const revision = (await this.store.saveResourceRevision({ attachmentId, parentRevisionId: lease.revisionId,
      engine: this.engine.id, ...captured, metadata: { summary }, createdByTaskId: taskId }));
    return this.serializePublish(attachmentId, taskId, async () => {
      const promoted = (await this.store.promoteResourceRevision(attachmentId, revision.id, lease.revisionId));
      (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:promote',
        scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, from: lease.revisionId, to: revision.id, summary } }));
      return { attachment: promoted, revision, summary };
    });
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
  constructor(private inner: World, private env: Record<string, string>) {
    if (inner.readFilePrefix) this.readFilePrefix = (path, maxBytes) => inner.readFilePrefix!(path, maxBytes);
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

async function* walkDirectory(root: string): AsyncGenerator<SnapshotInputFile> {
  const visit = async function* (directory: string): AsyncGenerator<SnapshotInputFile> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* visit(absolute);
      else if (entry.isFile()) yield { path: path.relative(root, absolute).split(path.sep).join('/'),
        data: fs.createReadStream(absolute) as AsyncIterable<Buffer>, bytes: (await fs.promises.stat(absolute)).size };
    }
  };
  yield* visit(root);
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
 * its size and stamp; a file's bytes are read only if the consumer iterates its
 * `data`, which an unchanged file in an incremental capture never does (LT-11). */
async function* filesFromWorld(world: World, target: string, attachment?: ResourceAttachment, checkContinue?: () => Promise<void>): AsyncGenerator<SnapshotInputFile> {
  await checkContinue?.();
  const single = Boolean(attachment && fileShaped(attachment));
  // -H follows a symlinked target the way `test -f` did, so a linked
  // single-file resource is captured rather than recorded as empty.
  const prefix = target === '.' ? '' : `${target}/`;
  const listed = await world.exec('bash', ['-lc', `date +%s.%N && { test ! -e ${quote(target)} || find -H ${quote(target)} ${single ? '-maxdepth 0 ' : ''}-type f -not -path '*/.git/*' -not -path '*/.karmax-injection/*' -printf '%s %T@ %C@ %i %p\\0'; }`],
    { timeoutMs: 30 * 60_000 });
  const newline = listed.stdout.indexOf('\n');
  const listedAt = Number(listed.stdout.slice(0, newline));
  if (listed.code !== 0 || newline < 0) throw new Error(listed.stderr || `could not inspect resource path ${target}`);
  const entries = listed.stdout.slice(newline + 1).split('\0').filter(Boolean).map((record) => {
    const [size, mtime, ctime, inode, ...name] = record.split(' ');
    return { file: name.join(' '), bytes: Number(size), stamp: `${size}:${mtime}:${ctime}:${inode}`, changedAt: Number(ctime) };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  for (const entry of entries) {
    await checkContinue?.();
    const relative = single ? path.posix.basename(target)
      : prefix ? (entry.file.startsWith(prefix) ? entry.file.slice(prefix.length) : undefined) : entry.file;
    if (!relative || (!single && (relative.startsWith('.git/') || relative.startsWith('.karmax-injection/')))) continue;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`could not size resource file ${entry.file}`);
    // Git's racy-clean rule: a write after this capture could reuse a stamp
    // from the listing's last timestamp tick (coarse filesystems tick in 1-2 s),
    // so only an older ctime, which no one can set back, is trusted. SQLite can
    // change through its WAL alone and goes through a transactional copy.
    const sqlite = /\.(?:sqlite3?|db)$/i.test(entry.file);
    const stable = !sqlite && Number.isFinite(listedAt) && entry.changedAt < listedAt - 2;
    yield { path: safePath(relative), ...(sqlite ? {} : { bytes: entry.bytes }), ...(stable ? { observed: entry.stamp } : {}),
      data: worldFileChunks(world, entry.file, sqlite ? undefined : entry.bytes, checkContinue) };
  }
}

async function* worldFileChunks(world: World, file: string, bytes: number | undefined, checkContinue?: () => Promise<void>): AsyncGenerator<Buffer> {
  const captured = await transactionalSnapshotPath(world, file);
  let size = bytes;
  if (size === undefined) {
    const sized = await world.exec('stat', ['-c', '%s', captured.path]);
    size = sized.code === 0 ? Number(sized.stdout.trim()) : undefined;
  }
  yield* cleanupChunks(readResourceChunks(world, captured.path, Number.isFinite(size) ? size : undefined, checkContinue), captured.cleanup);
}

async function manifestFromWorld(attachment: ResourceAttachment, world: World, target: string): Promise<SnapshotManifest> {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  for await (const file of filesFromWorld(world, target, attachment)) {
    const digest = crypto.createHash('sha256');
    let fileBytes = 0;
    for await (const chunk of fixedChunks(file.data)) { digest.update(chunk); fileBytes += chunk.length; }
    bytes += fileBytes;
    files.push({ path: file.path, bytes: fileBytes, sha256: digest.digest('hex'), chunks: [] });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, attachmentId: attachment.id, files, rootDigest: sha256(Buffer.from(JSON.stringify(files))), bytes };
}

function compareManifests(attachmentId: string, baseRevisionId: string | undefined,
  base: SnapshotManifest, current: SnapshotManifest): ResourceChangeSummary {
  const before = new Map(base.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  let added = 0; let modified = 0; let deleted = 0; let bytes = 0;
  const changedPaths: string[] = [];
  for (const [file, value] of after) {
    const prior = before.get(file);
    if (!prior) added++;
    else if (prior.sha256 !== value.sha256) modified++;
    else continue;
    bytes += value.bytes;
    if (changedPaths.length < 100) changedPaths.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) { deleted++; if (changedPaths.length < 100) changedPaths.push(file); }
  return { attachmentId, baseRevisionId, added, modified, deleted, bytes, changedPaths };
}

function emptyManifest(attachmentId: string): SnapshotManifest {
  return { version: 1, attachmentId, files: [], rootDigest: sha256(Buffer.from('[]')), bytes: 0 };
}

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

async function transactionalSnapshotPath(world: World, file: string): Promise<{ path: string; cleanup?: () => Promise<void> }> {
  if (!/\.(?:sqlite3?|db)$/i.test(file)) return { path: file };
  const magic = await world.exec('bash', ['-lc', `head -c 16 ${quote(file)} | base64 -w0`]);
  if (magic.code !== 0 || Buffer.from(magic.stdout.trim(), 'base64').toString('binary') !== 'SQLite format 3\0') return { path: file };
  const temporary = `.karmax-injection/sqlite-backup-${crypto.randomBytes(8).toString('hex')}.db`;
  const script = 'import os,sqlite3,sys; os.makedirs(os.path.dirname(sys.argv[2]),exist_ok=True); s=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()';
  const backup = await world.exec('python3', ['-c', script, file, temporary], { timeoutMs: 30 * 60_000 });
  if (backup.code !== 0) throw new Error(`could not transactionally snapshot SQLite database ${file}: ${backup.stderr || backup.stdout}`);
  return { path: temporary, cleanup: async () => { await world.exec('rm', ['-f', temporary]); } };
}

async function* cleanupChunks(chunks: AsyncIterable<Buffer>, cleanup?: () => Promise<void>): AsyncGenerator<Buffer> {
  try { yield* chunks; }
  finally { await cleanup?.(); }
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
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** File stamps are world-local and never part of a revision: they live with
 * the lease's checkpoint pointer, sealed like a manifest (paths are private)
 * and bound to the content they describe. */
function sealStamps(key: Buffer, attachmentId: string, rootDigest: string, stamps: Record<string, string>): string {
  return sealRandom(key, Buffer.from(JSON.stringify({ attachmentId, rootDigest, stamps }))).toString('base64');
}
function openStamps(key: Buffer, sealed: string, attachmentId: string, rootDigest: string): Record<string, string> | undefined {
  try {
    const value = JSON.parse(openRandom(key, Buffer.from(sealed, 'base64')).toString('utf8'));
    return value?.attachmentId === attachmentId && value.rootDigest === rootDigest && value.stamps && typeof value.stamps === 'object'
      ? value.stamps : undefined;
  } catch { return undefined; }
}
