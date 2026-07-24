import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ResourceAttachment, ResourceChangeSummary, ResourceRevision } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { ExecOptions, ExecResult, World, WorldHandle, WorldHttpRequest, WorldHttpResponse,
  WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec } from './types.js';
import { worldRelativePath } from './types.js';
import { ensureWorldExcluded } from './secrets.js';
import type { WorldRegistry } from './registry.js';
import { QRY_RESOURCE_PUBLISH, RESOURCE_PUBLISH_COORDINATOR_WORKFLOW, SIG_CANCEL_RESOURCE_PUBLISH,
  SIG_ENQUEUE_RESOURCE_PUBLISH, SIG_RELEASE_RESOURCE_PUBLISH,
  resourcePublishCoordinatorId } from '../coordinators/names.js';
import type { ResourcePublishView } from '../coordinators/resource-publish.js';
import { credentialResource, snapshotResource } from '../domain/resource-drivers.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const WORLD_READ_BYTES = 16 * 1024 * 1024;
const RESOURCE_KEY_PREFIX = 'resource-store:key:';

interface SnapshotFile { path: string; bytes: number; sha256: string; chunks: string[] }
interface SnapshotManifest { version: 1; attachmentId: string; files: SnapshotFile[]; rootDigest: string; bytes: number }
interface SnapshotRef { objectKey: string; sha256: string }
export interface SnapshotInputFile { path: string; data: Buffer | AsyncIterable<Buffer>; bytes?: number }

/** Replaceable snapshot data-plane contract (SPEC §11.4). The built-in engine
 * keeps the first release self-contained; production deployments can substitute
 * Kopia without changing resource, lease, or workflow records. */
export interface SnapshotEngine {
  readonly id: string;
  capture(attachment: ResourceAttachment, files: AsyncIterable<SnapshotInputFile>): Promise<{
    sealedRef: string; rootDigest: string; bytes: number; files: number;
  }>;
  restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>): Promise<void>;
  manifest(revision: ResourceRevision): Promise<SnapshotManifest>;
  delete?(revision: ResourceRevision): Promise<void>;
}

/** Tenant-keyed, encrypted content-addressed engine over the configured object
 * store. Chunks are deliberately behind SnapshotEngine so a Kopia-backed engine
 * can replace this compatibility implementation without changing durable rows. */
export class ObjectSnapshotEngine implements SnapshotEngine {
  readonly id = 'object-snapshot@1';
  constructor(private objects: ObjectStore, private broker: CredentialBroker) {}

  async capture(attachment: ResourceAttachment, files: AsyncIterable<SnapshotInputFile>) {
    const key = this.key(attachment.organizationId);
    const manifestFiles: SnapshotFile[] = [];
    const retained = new Map<string, number>();
    let total = 0;
    for await (const input of files) {
      const relative = safePath(input.path);
      const chunks: string[] = [];
      const digest = crypto.createHash('sha256');
      let fileBytes = 0;
      for await (const plain of fixedChunks(input.data)) {
        const plainHash = sha256(plain);
        // HMAC-scoped names deduplicate within a tenant without leaking a global
        // plaintext hash to the object-store operator.
        const chunkId = crypto.createHmac('sha256', key).update(plainHash).digest('hex');
        await this.objects.put(`resources/${attachment.organizationId}/chunks/${chunkId}.bin`, sealDeterministic(key, chunkId, plain));
        chunks.push(chunkId);
        retained.set(chunkId, plain.length);
        digest.update(plain);
        fileBytes += plain.length;
      }
      total += fileBytes;
      manifestFiles.push({ path: relative, bytes: fileBytes, sha256: digest.digest('hex'), chunks });
    }
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
    const rootDigest = sha256(Buffer.from(JSON.stringify(manifestFiles)));
    const manifest: SnapshotManifest = { version: 1, attachmentId: attachment.id, files: manifestFiles, rootDigest, bytes: total };
    const encrypted = sealRandom(key, Buffer.from(JSON.stringify(manifest)));
    const objectKey = `resources/${attachment.organizationId}/manifests/${attachment.id}/${newId('snapshot')}.bin`;
    await this.objects.put(objectKey, encrypted);
    this.chunkAccounting?.retain(attachment.organizationId, [...retained].map(([id, bytes]) => ({ id, bytes })));
    return { sealedRef: JSON.stringify({ objectKey, sha256: sha256(encrypted) } satisfies SnapshotRef),
      rootDigest, bytes: total, files: manifestFiles.length };
  }

  async restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>): Promise<void> {
    const manifest = await this.manifest(revision);
    const attachment = this.attachmentFor(revision);
    const key = this.key(attachment.organizationId);
    for (const file of manifest.files) {
      const digest = crypto.createHash('sha256');
      let offset = 0;
      for (const chunkId of file.chunks) {
        const encrypted = await this.objects.get(`resources/${attachment.organizationId}/chunks/${chunkId}.bin`);
        const data = openDeterministic(key, chunkId, encrypted);
        digest.update(data);
        await write(file.path, data, offset);
        offset += data.length;
      }
      if (offset !== file.bytes || digest.digest('hex') !== file.sha256)
        throw new Error(`resource snapshot integrity mismatch: ${file.path}`);
    }
  }

  async manifest(revision: ResourceRevision): Promise<SnapshotManifest> {
    const attachment = this.attachmentFor(revision);
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    const encrypted = await this.objects.get(ref.objectKey);
    if (sha256(encrypted) !== ref.sha256) throw new Error('resource manifest integrity mismatch');
    const manifest = JSON.parse(openRandom(this.key(attachment.organizationId), encrypted).toString('utf8')) as SnapshotManifest;
    if (manifest.version !== 1 || manifest.attachmentId !== attachment.id || manifest.rootDigest !== revision.rootDigest)
      throw new Error('resource manifest does not match its revision');
    return manifest;
  }

  async delete(revision: ResourceRevision): Promise<void> {
    const attachment = this.attachmentFor(revision);
    const manifest = await this.manifest(revision);
    const ref = JSON.parse(revision.sealedRef) as SnapshotRef;
    await this.objects.delete(ref.objectKey);
    const zero = this.chunkAccounting?.release(attachment.organizationId,
      [...new Set(manifest.files.flatMap((file) => file.chunks))]) ?? [];
    for (const chunkId of zero) await this.objects.delete(`resources/${attachment.organizationId}/chunks/${chunkId}.bin`);
  }

  private attachmentFor(revision: ResourceRevision): ResourceAttachment {
    const attachment = this.attachmentResolver?.(revision.attachmentId);
    if (!attachment) throw new Error('resource attachment no longer exists');
    return attachment;
  }
  private attachmentResolver?: (id: string) => ResourceAttachment | undefined;
  setAttachmentResolver(resolve: (id: string) => ResourceAttachment | undefined): void { this.attachmentResolver = resolve; }
  private chunkAccounting?: {
    retain(organizationId: string, chunks: Array<{ id: string; bytes: number }>): void;
    release(organizationId: string, chunkIds: string[]): string[];
  };
  setChunkAccounting(value: NonNullable<ObjectSnapshotEngine['chunkAccounting']>): void { this.chunkAccounting = value; }

  private key(organizationId: string): Buffer {
    const handle = `${RESOURCE_KEY_PREFIX}${organizationId}`;
    if (!this.broker.hasHandle(handle)) this.broker.registerHandle(handle, crypto.randomBytes(32).toString('base64'));
    return Buffer.from(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
  }
}

/** Control-plane resource orchestrator. Workflows carry no credentials and no
 * snapshot refs: create/open activities resolve them immediately around the
 * live provider-owned World. */
export class ProjectResourceService {
  private publishLocks = new Map<string, Promise<void>>();

  constructor(private store: Store, private worlds: WorldRegistry, private engine: SnapshotEngine,
    private broker: CredentialBroker, private coordinator?: { client: Client; taskQueue: string }) {
    if (engine instanceof ObjectSnapshotEngine) engine.setAttachmentResolver((id) => store.getResourceAttachment(id));
    if (engine instanceof ObjectSnapshotEngine) engine.setChunkAccounting({
      retain: (organizationId, chunks) => store.retainResourceChunks(organizationId, chunks),
      release: (organizationId, chunks) => store.releaseResourceChunks(organizationId, chunks),
    });
  }

  /** Materialize all enabled project defaults into a newly-created generation. */
  async materialize(projectId: string, taskId: string, world: World, generation = world.handle.generation ?? 1,
    revisions: Record<string, string | undefined> = {}): Promise<WorldHandle> {
    const ephemeralPaths = new Set<string>(Array.isArray(world.handle.meta?.ephemeralPaths)
      ? world.handle.meta!.ephemeralPaths as string[] : []);
    const projections: Record<string, { target: string; revisionId?: string; access: string }> = {};
    for (const attachment of this.store.listResourceAttachments(projectId)) {
      const revisionId = Object.prototype.hasOwnProperty.call(revisions, attachment.id)
        ? revisions[attachment.id] : attachment.currentRevisionId;
      const lease = this.store.createResourceLease({ attachmentId: attachment.id, revisionId,
        taskId, worldId: world.handle.id, worldGeneration: generation, access: attachment.access });
      try {
        if (isSecretLike(attachment)) {
          if (!attachment.credentialHandles[0]) throw new Error(`resource "${attachment.name}" has no configured credential`);
          const value = this.resolveSecret(attachment, taskId);
          if (attachment.target.kind === 'path') {
            const target = safePath(attachment.target.path);
            await world.writeFile(target, value);
            await world.exec('chmod', ['600', target]);
            // Worktree-scoped git exclusion: without it, prepare() leaves the
            // re-materialized secret visible to `git add -A` at merge time.
            await ensureWorldExcluded(world, target);
            ephemeralPaths.add(target);
          }
        } else if (isSnapshotDriver(attachment.driver)) {
          const target = attachment.target.kind === 'path' ? safePath(attachment.target.path) : undefined;
          if (!target) throw new Error(`resource "${attachment.name}" requires a path target`);
          if (revisionId) {
            const revision = this.store.getResourceRevision(revisionId);
            if (!revision) throw new Error(`resource "${attachment.name}" revision is missing`);
            await this.engine.restore(revision, async (file, data, offset) => {
              const relative = target === '.' ? file : `${target}/${file}`;
              if (offset === 0) {
                if (world.writeFileBuffer) await world.writeFileBuffer(relative, data);
                else await world.writeFile(relative, data.toString('utf8'));
              } else {
                const temporary = `.karmax-injection/resource-chunk-${crypto.randomBytes(8).toString('hex')}`;
                if (world.writeFileBuffer) await world.writeFileBuffer(temporary, data);
                else await world.writeFile(temporary, data.toString('base64'));
                const appended = world.writeFileBuffer
                  ? await world.exec('bash', ['-lc', `cat ${quote(temporary)} >> ${quote(relative)} && rm -f ${quote(temporary)}`])
                  : await world.exec('bash', ['-lc', `base64 -d ${quote(temporary)} >> ${quote(relative)} && rm -f ${quote(temporary)}`]);
                if (appended.code !== 0) throw new Error(appended.stderr || `could not restore ${relative}`);
              }
            });
          }
          if (attachment.access === 'read')
            await world.exec('bash', ['-lc', `test ! -e ${quote(target)} || chmod -R a-w ${quote(target)}`]);
          projections[attachment.id] = { target, revisionId, access: attachment.access };
        } else throw new Error(`no resource driver registered for ${attachment.driver}`);
        this.store.updateResourceLease(lease.id, 'active', JSON.stringify({ driver: attachment.driver }));
        this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:lease',
          scopeKey: `project:${projectId}`, detail: { attachmentId: attachment.id, leaseId: lease.id,
            revisionId, access: attachment.access, worldGeneration: generation } });
      } catch (error) {
        this.store.updateResourceLease(lease.id, 'failed');
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
  withEnvironment(world: World): World {
    const env: Record<string, string> = {};
    for (const lease of this.store.listResourceLeases(world.handle.id, world.handle.generation ?? 1)) {
      if (lease.state !== 'active') continue;
      const attachment = this.store.getResourceAttachment(lease.attachmentId);
      if (!attachment || !isSecretLike(attachment)) continue;
      if (attachment.target.kind === 'environment' || attachment.target.kind === 'service')
        env[attachment.target.name] = this.resolveSecret(attachment, lease.taskId);
    }
    return Object.keys(env).length ? new EnvironmentWorld(world, env) : world;
  }

  /** Rehydrate path credentials after a park/resume and wrap environment
   * credentials for this one access. Provider snapshots are scrubbed first. */
  async prepare(world: World): Promise<World> {
    for (const lease of this.store.listResourceLeases(world.handle.id, world.handle.generation ?? 1)) {
      if (lease.state !== 'active') continue;
      const attachment = this.store.getResourceAttachment(lease.attachmentId);
      if (!attachment || !isSecretLike(attachment) || attachment.target.kind !== 'path') continue;
      const target = safePath(attachment.target.path);
      await world.writeFile(target, this.resolveSecret(attachment, lease.taskId));
      await world.exec('chmod', ['600', target]);
      // Same exclusion on the re-materialization path — an agent's blanket
      // `git add -A` before merge must never be able to stage a secret.
      await ensureWorldExcluded(world, target);
    }
    return this.withEnvironment(world);
  }

  async scrubSecrets(handle: WorldHandle): Promise<void> {
    const world = await this.worlds.open(handle).catch(() => undefined);
    if (!world) return;
    for (const lease of this.store.listResourceLeases(handle.id, handle.generation ?? 1)) {
      const attachment = this.store.getResourceAttachment(lease.attachmentId);
      if (attachment?.target.kind === 'path' && isSecretLike(attachment))
        await world.exec('rm', ['-f', safePath(attachment.target.path)]).catch(() => undefined);
    }
  }

  async release(handle: WorldHandle): Promise<void> {
    await this.scrubSecrets(handle);
    for (const lease of this.store.listResourceLeases(handle.id, handle.generation ?? 1)) {
      const attachment = this.store.getResourceAttachment(lease.attachmentId);
      this.store.updateResourceLease(lease.id, 'released');
      if (attachment) this.store.appendAudit({ principalId: `task:${lease.taskId}`, action: 'resource:release',
        scopeKey: `project:${attachment.projectId}`, detail: { attachmentId: attachment.id, leaseId: lease.id } });
    }
  }

  async importFiles(attachmentId: string, files: Iterable<SnapshotInputFile> | AsyncIterable<SnapshotInputFile>, createdByTaskId?: string): Promise<ResourceRevision> {
    const attachment = this.requiredAttachment(attachmentId);
    if (!isSnapshotDriver(attachment.driver)) throw new Error('only snapshot-backed resources accept files');
    const captured = await this.engine.capture(attachment, asAsync(files));
    const revision = this.store.saveResourceRevision({ attachmentId, parentRevisionId: attachment.currentRevisionId,
      engine: this.engine.id, ...captured, metadata: { imported: true }, createdByTaskId });
    this.store.promoteResourceRevision(attachmentId, revision.id, attachment.currentRevisionId);
    this.store.recordUsage({ organizationId: attachment.organizationId, projectId: attachment.projectId,
      taskId: createdByTaskId, provider: this.engine.id, kind: 'resource.storage', quantity: captured.bytes,
      unit: 'byte', costMicros: 0, startedAt: revision.createdAt, endedAt: revision.createdAt,
      metadata: { attachmentId, revisionId: revision.id, files: captured.files } });
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

  /** Remove control-plane records, credentials, and revision manifests. Shared
   * content chunks are left for the snapshot engine's mark-and-sweep policy. */
  async deleteAttachment(attachmentId: string): Promise<void> {
    const attachment = this.store.getResourceAttachment(attachmentId);
    if (!attachment) return;
    for (const revision of this.store.listResourceRevisions(attachmentId)) await this.engine.delete?.(revision);
    for (const handle of attachment.credentialHandles) this.broker.deleteHandle(handle);
    this.store.deleteResourceAttachment(attachmentId);
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const attachment of this.store.listResourceAttachments(projectId, true)) await this.deleteAttachment(attachment.id);
  }

  deleteOrganizationKey(organizationId: string): void {
    this.broker.deleteHandle(`${RESOURCE_KEY_PREFIX}${organizationId}`);
  }

  async summarize(taskId: string, attachmentId: string): Promise<ResourceChangeSummary> {
    const { attachment, world, lease, target } = await this.worldResource(taskId, attachmentId);
    const base = lease.revisionId ? await this.engine.manifest(this.store.getResourceRevision(lease.revisionId)!) : emptyManifest(attachment.id);
    const current = await manifestFromWorld(attachment, world, target);
    const summary = compareManifests(attachment.id, lease.revisionId, base, current);
    this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:inspect',
      scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, summary } });
    return summary;
  }

  /** Capture writable task forks for portable hibernation without promoting
   * them to the project's current baseline. */
  async checkpoint(handle: WorldHandle): Promise<Array<{ attachmentId: string; revisionId: string }>> {
    const world = await this.worlds.open(handle);
    const refs: Array<{ attachmentId: string; revisionId: string }> = [];
    for (const lease of this.store.listResourceLeases(handle.id, handle.generation ?? 1)) {
      if (lease.state !== 'active') continue;
      const attachment = this.store.getResourceAttachment(lease.attachmentId);
      if (!attachment || !isSnapshotDriver(attachment.driver) || attachment.target.kind !== 'path') continue;
      if (attachment.access === 'read' && lease.revisionId) {
        refs.push({ attachmentId: attachment.id, revisionId: lease.revisionId });
        continue;
      }
      const captured = await this.engine.capture(attachment, filesFromWorld(world, safePath(attachment.target.path)));
      const revision = this.store.saveResourceRevision({ attachmentId: attachment.id, parentRevisionId: lease.revisionId,
        engine: this.engine.id, ...captured, metadata: { checkpoint: true }, createdByTaskId: lease.taskId });
      refs.push({ attachmentId: attachment.id, revisionId: revision.id });
    }
    return refs;
  }

  async promote(taskId: string, attachmentId: string): Promise<{ attachment: ResourceAttachment; revision: ResourceRevision; summary: ResourceChangeSummary }> {
    const { attachment, world, lease, target } = await this.worldResource(taskId, attachmentId);
    if (attachment.publish !== 'review' || attachment.access !== 'write' || attachment.isolation !== 'fork')
      throw new Error('resource is not configured for reviewed promotion');
    const summary = await this.summarize(taskId, attachmentId);
    // Upload the immutable candidate before entering the singleton. The only
    // serialized operation is the tiny baseline pointer CAS, so a multi-GB model
    // upload cannot block another publication merely while bytes are moving.
    const captured = await this.engine.capture(attachment, filesFromWorld(world, target));
    const revision = this.store.saveResourceRevision({ attachmentId, parentRevisionId: lease.revisionId,
      engine: this.engine.id, ...captured, metadata: { summary }, createdByTaskId: taskId });
    return this.serializePublish(attachmentId, taskId, async () => {
      const promoted = this.store.promoteResourceRevision(attachmentId, revision.id, lease.revisionId);
      this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:promote',
        scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, from: lease.revisionId, to: revision.id, summary } });
      return { attachment: promoted, revision, summary };
    });
  }

  async discard(taskId: string, attachmentId: string): Promise<void> {
    const { attachment, lease } = await this.worldResource(taskId, attachmentId);
    this.store.updateResourceLease(lease.id, 'released');
    this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:discard',
      scopeKey: `project:${attachment.projectId}`, detail: { attachmentId, revisionId: lease.revisionId, leaseId: lease.id } });
  }

  private async worldResource(taskId: string, attachmentId: string) {
    const handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no active world');
    this.store.assertCurrentWorld(handle);
    const attachment = this.requiredAttachment(attachmentId);
    const task = this.store.getTask(taskId);
    if (!task || task.projectId !== attachment.projectId) throw new Error('resource does not belong to task project');
    const lease = this.store.listResourceLeases(handle.id, handle.generation ?? 1)
      .find((candidate) => candidate.attachmentId === attachmentId && candidate.state === 'active');
    if (!lease) throw new Error('task has no active lease for resource');
    if (attachment.target.kind !== 'path') throw new Error('resource has no filesystem state to publish');
    return { attachment, lease, target: safePath(attachment.target.path), world: await this.worlds.open(handle) };
  }

  private requiredAttachment(id: string): ResourceAttachment {
    const value = this.store.getResourceAttachment(id);
    if (!value) throw new Error('resource attachment not found');
    return value;
  }

  private resolveSecret(attachment: ResourceAttachment, taskId: string): string {
    const handle = attachment.credentialHandles[0]!;
    return this.broker.resolve(handle, { taskId, caps: [`use-credential:${handle}`] });
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
      while (Date.now() < deadline) {
        const view = await handle.query<ResourcePublishView>(QRY_RESOURCE_PUBLISH);
        if (view.current?.token === token) { granted = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
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
  constructor(private inner: World, private env: Record<string, string>) {}
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

async function* filesFromWorld(world: World, target: string): AsyncGenerator<SnapshotInputFile> {
  const prefix = target === '.' ? '' : `${target}/`;
  const listed = await world.exec('bash', ['-lc', `test ! -e ${quote(target)} || find ${quote(target)} -type f -not -path '*/.git/*' -not -path '*/.karmax-injection/*' -print0`],
    { timeoutMs: 30 * 60_000 });
  if (listed.code !== 0) throw new Error(listed.stderr || `could not inspect resource path ${target}`);
  const all = listed.stdout.split('\0').filter(Boolean);
  for (const file of all.sort()) {
    const relative = prefix ? (file.startsWith(prefix) ? file.slice(prefix.length) : undefined) : file;
    if (!relative || relative.startsWith('.git/') || relative.startsWith('.karmax-injection/')) continue;
    const captured = await transactionalSnapshotPath(world, file);
    const sized = await world.exec('stat', ['-c', '%s', captured.path]);
    const bytes = sized.code === 0 ? Number(sized.stdout.trim()) : undefined;
    yield { path: safePath(relative), bytes,
      data: cleanupChunks(chunksFromWorldFile(world, captured.path, Number.isFinite(bytes) ? bytes : undefined), captured.cleanup) };
  }
}

async function manifestFromWorld(attachment: ResourceAttachment, world: World, target: string): Promise<SnapshotManifest> {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  for await (const file of filesFromWorld(world, target)) {
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

async function* asAsync(values: Iterable<SnapshotInputFile> | AsyncIterable<SnapshotInputFile>): AsyncGenerator<SnapshotInputFile> {
  for await (const value of values as AsyncIterable<SnapshotInputFile>) yield value;
}

async function* fixedChunks(value: Buffer | AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const source = Buffer.isBuffer(value) ? (async function* () { yield value; })() : value;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let emitted = false;
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= CHUNK_BYTES) {
      emitted = true;
      yield pending.subarray(0, CHUNK_BYTES);
      pending = pending.subarray(CHUNK_BYTES);
    }
  }
  if (pending.length || !emitted) yield pending;
}

async function* chunksFromWorldFile(world: World, file: string, bytes?: number): AsyncGenerator<Buffer> {
  for (let offset = 0; bytes === undefined || offset < bytes; offset += WORLD_READ_BYTES) {
    const result = await world.exec('bash', ['-lc',
      `dd if=${quote(file)} bs=${WORLD_READ_BYTES} skip=${Math.floor(offset / WORLD_READ_BYTES)} count=1 status=none | base64 -w0`],
    { timeoutMs: 30 * 60_000 });
    if (result.code !== 0) throw new Error(result.stderr || `could not read resource file ${file}`);
    const chunk = Buffer.from(result.stdout.trim(), 'base64');
    if (!chunk.length) break;
    yield chunk;
    if (chunk.length < WORLD_READ_BYTES) break;
  }
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
function isSnapshotDriver(value: string): boolean { return snapshotResource(value); }
function safePath(value: string): string { return worldRelativePath(value); }
function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

function sealRandom(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('KRS1'), iv, cipher.getAuthTag(), body]);
}
function openRandom(key: Buffer, blob: Buffer): Buffer {
  if (blob.subarray(0, 4).toString() !== 'KRS1') throw new Error('invalid resource snapshot envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}
function sealDeterministic(key: Buffer, id: string, plain: Buffer): Buffer {
  const iv = crypto.createHmac('sha256', key).update(`iv:${id}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('KRC1'), cipher.getAuthTag(), body]);
}
function openDeterministic(key: Buffer, id: string, blob: Buffer): Buffer {
  if (blob.subarray(0, 4).toString() !== 'KRC1') throw new Error('invalid resource chunk envelope');
  const iv = crypto.createHmac('sha256', key).update(`iv:${id}`).digest().subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(blob.subarray(4, 20));
  return Buffer.concat([decipher.update(blob.subarray(20)), decipher.final()]);
}
