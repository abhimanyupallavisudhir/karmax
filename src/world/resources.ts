import crypto from 'node:crypto';
import { transferResourceChunk, readResourceChunks } from './resource-transfer.js';
import { forEachConcurrent } from '../util/async-batch.js';
import { timed } from '../timing/index.js';
import fs from 'node:fs';
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
import { worldRelativePath, worldRepos, worldWorkingRelativePath } from './types.js';
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
import { CHUNK_BYTES, chunkId as contentChunkId, chunkObjectKey, fixedChunks, openCompressed, openDeterministic, openRandom,
  organizationKey, organizationKeyHandle, sealCompressed, sealDeterministic, sealRandom, sha256 } from './chunk-store.js';
import { READ_BATCH_BYTES, readCheckpointRanges } from './checkpoint-read.js';
import { DirectCapture, type DirectSource } from './direct-capture.js';
import { DirectTransfer, DirectTransferError } from './direct-transfer.js';

const COPY_GLOB_SECRET_BYTES = 64 * 1024;

/** A file is its own chunks, or (version 2, when small) a slice of a shared pack. */
type SnapshotEntry = { path: string; bytes: number; sha256: string } & ({ chunks: string[] } | { pack: number; offset: number });
type SnapshotFile = SnapshotEntry;
/** Version 3 adds per-capture keys: `keyed` names the key of every object not
 * under the organization key, and `keys` holds those keys, sealed with the
 * manifest under the organization key (wiki planned/direct-resource-uploads). */
interface SnapshotManifest { version: 1 | 2 | 3; attachmentId: string; files: SnapshotEntry[]; packs?: string[];
  keys?: Record<string, CaptureKey>; keyed?: Record<string, string>; rootDigest: string; bytes: number }
/** A key a world held while capturing, and the task it was made for. */
interface CaptureKey { key: string; task?: string }
interface SnapshotRef { objectKey: string; sha256: string; storageLocationId?: string }
/** `data` is consumed only when the file must be read: an input whose
 * `observed` stamp matches the one recorded with the baseline reuses the
 * baseline's chunks. A small file with a `range` is read together with others
 * through its `reader` instead. */
export interface SnapshotInputFile { path: string; data: Buffer | AsyncIterable<Buffer>; bytes?: number; observed?: string; range?: SnapshotRange;
  /** Where the world can read the file itself, for a direct capture. */
  direct?: DirectSource }
/** Reads many whole files in one round trip, yielding each one's bytes in order,
 * or undefined for a file whose `stamp` no longer matches (it changed). */
export interface SnapshotRange {
  reader: (files: Array<{ source: string; stamp: string; bytes: number }>) => AsyncIterable<Buffer | undefined>;
  source: string;
  stamp: string;
}
export interface CaptureOptions {
  baseline?: ResourceRevision;
  observed?: string;
  enforceQuota?: boolean;
  /** Record progress so an interrupted capture's next attempt continues from it
   * instead of reading and uploading everything again ({@link CaptureProgress}). */
  resume?: boolean;
  onProgress?: (done: { files: number; bytes: number }) => void;
  /** Let the world read, encrypt and upload files itself, under a key made for
   * this task's captures of this resource, when the store can presign URLs. */
  direct?: { transfer: DirectTransfer; taskId: string };
}

/** Files smaller than this share compressed packs, as world checkpoints do: a
 * tree of 70,000 small files is a few thousand objects, not 70,000. */
const PACKED_FILE_BYTES = 1024 * 1024;
const PACK_BYTES = CHUNK_BYTES;
/** One batched read returns at most this much (as base64), or this many files. */
const BATCH_READ_BYTES = READ_BATCH_BYTES;
const BATCH_READ_FILES = 128;
const UPLOAD_CONCURRENCY = 4;
/** How often a resumable capture records what it has saved. A record not
 * updated for PROGRESS_STALE_MS belongs to an attempt that died: a worker that
 * stopped heartbeating is retried no sooner than a minute later. */
const PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_STALE_MS = 45_000;
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

export interface RestoreOptions {
  signal?: AbortSignal;
  /** Let the world fetch what it can itself; `path` maps a file to its absolute
   * path there. `started` records that it did, so a failure after that is not
   * mistaken for a world that cannot run the transfer. */
  direct?: { transfer: DirectTransfer; path: (file: string) => string; started?: boolean };
}
const RESTORE_BATCH_OBJECTS = 32;
const RESTORE_CONCURRENCY = 16;
const RESTORE_BATCH_SEGMENTS = 4000;

/** How far staging is through one candidate (`index` of `count`). */
export interface StagingProgress { path: string; index: number; count: number; files: number; totalFiles: number; bytes: number; totalBytes: number }

export interface StagedResourceCandidates {
  staged: string[];
  failed: Array<{ candidateId: string; sourcePath?: string; error: string }>;
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
   * capture resolved to lets the next one skip files whose stamps match.
   * `enforceQuota: false` counts new chunks without refusing them (checkpoints). */
  capture(attachment: ResourceAttachment, files: AsyncIterable<SnapshotInputFile>,
    incremental?: CaptureOptions): Promise<{
    sealedRef: string; rootDigest: string; bytes: number; files: number; storageLocationId?: string; unchanged?: boolean;
    observed?: string;
  }>;
  /** Release what an interrupted resumable capture of this attachment saved. */
  abandonProgress?(attachment: ResourceAttachment): Promise<void>;
  restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options?: RestoreOptions): Promise<void>;
  manifest(revision: ResourceRevision): Promise<SnapshotManifest>;
  verify?(revision: ResourceRevision, offset: number, limit: number): Promise<SnapshotVerification>;
  /** `owner` releases a capture whose attachment row is already gone. */
  delete?(revision: ResourceRevision, owner?: ResourceAttachment): Promise<void>;
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
    incremental?: CaptureOptions) {
    const quota = { enforceQuota: incremental?.enforceQuota !== false };
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
    // Objects known to exist: the baseline's, and whatever this capture (or the
    // interrupted attempt it resumes) has finished uploading.
    const present = new Set(baseline ? manifestObjects(baseline) : []);
    /** References this capture holds: one per distinct object of its manifest once it completes. */
    const held = new Map<string, number>();
    const progress = incremental?.resume && this.progressStore
      ? await CaptureProgress.claim(this.progressStore, key, attachment, storageLocationId) : undefined;
    const resumed = new Map(progress?.files.map((file) => [file.path, file]));
    for (const [id, bytes] of progress?.held ?? []) { held.set(id, bytes); present.add(id); }
    /** Keys of objects not under the organization key: the baseline's, and those an interrupted attempt used. */
    const knownKeys = new Map<string, CaptureKey>([...Object.entries(baseline?.keys ?? {}), ...Object.entries(progress?.keys ?? {})]);
    const baselineKeyOf = (id: string) => baseline?.keyed?.[id];
    const direct = incremental?.direct && objects.presign && objects.head ? incremental.direct : undefined;
    // One key per task and resource: a retry, a resume and a later refresh by
    // the same task reuse it, so they reuse its objects too.
    let directKey: { id: string; secret: Buffer } | undefined;
    if (direct) {
      const own = [...knownKeys].find(([, value]) => value.task === direct.taskId);
      const id = own?.[0] ?? crypto.randomBytes(8).toString('hex');
      if (!own) knownKeys.set(id, { key: crypto.randomBytes(32).toString('base64'), task: direct.taskId });
      directKey = { id, secret: Buffer.from(knownKeys.get(id)!.key, 'base64') };
    }

    /** Every file captured so far, by object id; numbered into a manifest at the end. */
    const captured: ProgressFile[] = [];
    /** Those a later attempt can resume from (stable stamps). */
    const completed: ProgressFile[] = [];
    const observed: Record<string, string> = {};
    let total = 0;
    let wrote = false;
    const report = () => incremental?.onProgress?.({ files: captured.length, bytes: total });
    const add = (entry: ProgressFile) => {
      captured.push(entry);
      if (entry.stamp) completed.push(entry);
      total += entry.bytes;
    };

    const retain = async (chunks: Array<{ id: string; bytes: number }>) => {
      const fresh = [...new Map(chunks.filter((chunk) => !held.has(chunk.id)).map((chunk) => [chunk.id, chunk])).values()];
      if (!fresh.length) return;
      await this.chunkAccounting?.retain(attachment.organizationId, fresh, storageLocationId, quota);
      for (const chunk of fresh) held.set(chunk.id, chunk.bytes);
    };
    // Reusing an unchanged file retains its objects in batches, not per file.
    let reusedPending: Array<{ id: string; bytes: number }> = [];
    const retainReused = async () => { const pending = reusedPending; reusedPending = []; await retain(pending); };
    /** Keep a baseline file as it is: its objects are already stored. */
    const reuse = async (prior: SnapshotEntry, stamp: string | undefined) => {
      const pack = 'pack' in prior ? baseline!.packs![prior.pack]! : undefined;
      if (pack) reusedPending.push({ id: pack, bytes: PACK_BYTES });
      else ('chunks' in prior ? prior.chunks : []).forEach((id, index) =>
        reusedPending.push({ id, bytes: Math.min(CHUNK_BYTES, prior.bytes - index * CHUNK_BYTES) }));
      if (reusedPending.length >= 1024) await retainReused();
      const { pack: _index, ...rest } = prior as SnapshotEntry & { pack?: number };
      const keyId = baselineKeyOf(pack ?? ('chunks' in prior ? prior.chunks[0]! : ''));
      add({ ...rest, ...(pack ? { pack } : {}), ...(keyId ? { key: keyId } : {}), ...(stamp ? { stamp } : {}) });
    };
    const uploads = new BoundedUploads(UPLOAD_CONCURRENCY);
    const uploading = new Set<string>();
    const put = async (id: string, bytes: number, seal: () => Buffer | Promise<Buffer>) => {
      await retain([{ id, bytes }]);
      if (present.has(id) || uploading.has(id)) return;
      uploading.add(id);
      await uploads.add(async () => {
        await objects.put(chunkObjectKey(attachment.organizationId, id), await seal());
        present.add(id);
        wrote = true;
      });
    };

    let pack: Buffer[] = [];
    let packBytes = 0;
    let packed: ProgressFile[] = [];
    const flushPack = async () => {
      if (!packed.length) return;
      const plain = Buffer.concat(pack, packBytes);
      const id = contentChunkId(key, chunkNamespace, plain, 'pack');
      await put(id, plain.length, () => sealCompressed(key, id, plain));
      for (const file of packed) add({ ...file, pack: id });
      pack = []; packBytes = 0; packed = [];
    };
    const addSmall = async (input: { path: string; observed?: string }, data: Buffer) => {
      const digest = sha256(data);
      // Read, but unchanged: packs are not content-addressed per file the way
      // chunks are, so the baseline's slice is kept rather than packed again.
      const prior = previous.get(input.path);
      if (prior && prior.bytes === data.length && prior.sha256 === digest) return reuse(prior, input.observed);
      if (packBytes && packBytes + data.length > PACK_BYTES) await flushPack();
      packed.push({ path: input.path, bytes: data.length, sha256: digest, offset: packBytes,
        ...(input.observed ? { stamp: input.observed } : {}) });
      pack.push(data); packBytes += data.length;
    };

    // Small files a source can read together go out in one round trip per batch.
    let batch: Array<{ input: SnapshotInputFile & { range: SnapshotRange }; path: string }> = [];
    let batchBytes = 0;
    const readBatch = async () => {
      if (!batch.length) return;
      const pending = batch; batch = []; batchBytes = 0;
      let index = 0;
      for await (const data of pending[0]!.input.range.reader(pending.map(({ input }) => ({ ...input.range, bytes: input.bytes! })))) {
        const item = pending[index++];
        if (!item) throw new Error('resource batch read returned too many files');
        if (!data || data.length !== item.input.bytes) throw new Error(`${item.path} changed while it was being saved; save it again once it is settled`);
        await addSmall({ path: item.path, observed: item.input.observed }, data);
      }
      if (index !== pending.length) throw new Error('resource batch read ended early');
      report();
    };

    let lastSaved = Date.now();
    let recorded = 0;
    const saveProgress = async (park = false) => {
      if (!progress) return;
      // A part-filled pack is still a pack: saving it makes the files read so far
      // resumable. A stopping attempt reads nothing more, and keeps what it read
      // unless uploading is what failed.
      if (!park) { await readBatch(); await flushPack(); await uploads.drain(); }
      else {
        if (!uploads.failed) await flushPack().catch(() => undefined);
        await uploads.settle();
      }
      await retainReused();
      // Only what is uploaded and held can be resumed from; each save adds the
      // files completed since the last one.
      const added = completed.slice(recorded).filter((file) => entryObjects(file).every((id) => held.has(id) && present.has(id)));
      await progress.save(added, [...held].filter(([id]) => present.has(id)), park, Object.fromEntries(knownKeys));
      recorded = completed.length;
      lastSaved = Date.now();
    };

    /** Read a file through the worker: batched when small, streamed when large. */
    const relay = async (input: SnapshotInputFile, relative: string) => {
      if (input.range && input.bytes !== undefined && input.bytes < PACKED_FILE_BYTES) {
        if (batch.length && (batch[0]!.input.range.reader !== input.range.reader || batch.length >= BATCH_READ_FILES
          || batchBytes + input.bytes > BATCH_READ_BYTES)) await readBatch();
        batch.push({ input: input as SnapshotInputFile & { range: SnapshotRange }, path: relative });
        batchBytes += input.bytes;
      } else {
        await readBatch();
        if (input.bytes !== undefined && input.bytes < PACKED_FILE_BYTES) {
          const parts: Buffer[] = [];
          for await (const data of fixedChunks(input.data)) parts.push(data);
          const data = Buffer.concat(parts);
          if (data.length !== input.bytes) throw new Error('resource capture size mismatch');
          await addSmall({ path: relative, observed: input.observed }, data);
        } else {
          const chunks: string[] = [];
          const digest = crypto.createHash('sha256');
          let fileBytes = 0;
          for await (const plain of fixedChunks(input.data)) {
            const chunkId = contentChunkId(key, chunkNamespace, plain);
            await put(chunkId, plain.length, () => sealDeterministic(key, chunkId, plain));
            chunks.push(chunkId);
            digest.update(plain);
            fileBytes += plain.length;
            incremental?.onProgress?.({ files: captured.length, bytes: total + fileBytes });
            // A long file keeps its record fresh, and its uploaded chunks are
            // kept for a retry, which re-reads the file but uploads only the rest.
            if (progress && Date.now() - lastSaved >= PROGRESS_INTERVAL_MS) await saveProgress();
          }
          if (input.bytes !== undefined && fileBytes !== input.bytes)
            throw new Error('resource capture size mismatch');
          add({ path: relative, bytes: fileBytes, sha256: digest.digest('hex'), chunks,
            ...(input.observed ? { stamp: input.observed } : {}) });
          report();
        }
      }
    };

    const directCapture = direct && directKey ? new DirectCapture<{ input: SnapshotInputFile; relative: string }>({
      organizationId: attachment.organizationId, key: directKey, namespace: chunkNamespace,
      objects: objects as Required<Pick<ObjectStore, 'presign' | 'head'>>, transfer: direct.transfer,
      baseline: (path) => previous.get(path),
      reuse: (path, stamp) => reuse(previous.get(path)!, stamp),
      retain, present,
      add: (entry) => add(entry),
      uploaded: () => { wrote = true; },
      progress: (inFlight) => incremental?.onProgress?.({ files: captured.length, bytes: total + inFlight }),
      tick: async () => { if (progress && Date.now() - lastSaved >= PROGRESS_INTERVAL_MS) await saveProgress(); },
    }) : undefined;

    try {
      for await (const input of files) {
        const relative = safePath(input.path);
        if (incremental && input.observed) observed[relative] = input.observed;
        const earlier = input.observed ? resumed.get(relative) : undefined;
        if (earlier && earlier.stamp === input.observed && entryObjects(earlier).every((id) => held.has(id))
          && (!earlier.key || knownKeys.has(earlier.key))) {
          add(earlier);
          continue;
        }
        const prior = previous.get(relative);
        if (prior && input.observed && stamps?.[relative] === input.observed) {
          await reuse(prior, input.observed);
          continue;
        }
        if (directCapture && !directCapture.disabled && input.direct) {
          const handed = await directCapture.add({ path: relative, bytes: input.bytes, observed: input.observed, ...input.direct },
            { input, relative });
          for (const item of handed ?? []) await relay(item.input, item.relative);
        } else await relay(input, relative);
        if (progress && Date.now() - lastSaved >= PROGRESS_INTERVAL_MS) await saveProgress();
      }
      for (const item of (await directCapture?.flush()) ?? []) await relay(item.input, item.relative);
      await readBatch();
      await flushPack();
      await retainReused();
      await uploads.drain();
      report();
      // Packs are numbered in path order, so the same files in the same packs
      // make the same manifest however the capture encountered them.
      captured.sort((a, b) => a.path.localeCompare(b.path));
      const packs = [...new Set(captured.flatMap((file) => file.pack ? [file.pack] : []))];
      const packIndex = new Map(packs.map((id, index) => [id, index]));
      const manifestFiles = captured.map(({ stamp: _stamp, key: _key, pack, offset, chunks, ...file }): SnapshotEntry =>
        pack ? { ...file, pack: packIndex.get(pack)!, offset: offset! } : { ...file, chunks: chunks! });
      // Objects under a capture key, and those keys; none means a version-2 manifest.
      const keyed: Record<string, string> = {};
      for (const file of captured) if (file.key) for (const id of entryObjects(file)) keyed[id] = file.key;
      const keys = Object.fromEntries([...new Set(Object.values(keyed))].map((id) => [id, knownKeys.get(id)!]));
      const rootDigest = manifestDigest(manifestFiles, packs, keyed);
      const sealedStamps = Object.keys(observed).length ? sealStamps(key, attachment.id, rootDigest, observed) : undefined;
      const referenced = new Set([...packs, ...manifestFiles.flatMap((file) => 'chunks' in file ? file.chunks : [])]);
      // The progress record is gone before any reference it names is released,
      // so no later attempt can adopt (and release again) what is released here.
      await progress?.clear();
      if (baseline && rootDigest === baseline.rootDigest && !wrote) {
        await this.releaseHeld(attachment.organizationId, objects, [...held.keys()]);
        held.clear();
        return { sealedRef: baselineRevision!.sealedRef, rootDigest, bytes: total, files: manifestFiles.length, storageLocationId,
          unchanged: true, ...(sealedStamps ? { observed: sealedStamps } : {}) };
      }
      // A file that changed after an interrupted attempt saved it leaves objects nothing references.
      const orphans = [...held.keys()].filter((id) => !referenced.has(id));
      if (orphans.length) {
        await this.releaseHeld(attachment.organizationId, objects, orphans);
        for (const id of orphans) held.delete(id);
      }
      const manifest: SnapshotManifest = Object.keys(keyed).length
        ? { version: 3, attachmentId: attachment.id, files: manifestFiles, packs, keys, keyed, rootDigest, bytes: total }
        : { version: 2, attachmentId: attachment.id, files: manifestFiles, packs, rootDigest, bytes: total };
      const encrypted = sealRandom(key, Buffer.from(JSON.stringify(manifest)));
      const objectKey = `resources/${attachment.organizationId}/manifests/${attachment.id}/${newId('snapshot')}.bin`;
      await objects.put(objectKey, encrypted);
      return { sealedRef: JSON.stringify({ objectKey, sha256: sha256(encrypted), storageLocationId } satisfies SnapshotRef),
        rootDigest, bytes: total, files: manifestFiles.length, storageLocationId,
        ...(sealedStamps ? { observed: sealedStamps } : {}) };
    } catch (error) {
      await uploads.settle();
      // Superseded: the references now belong to whoever took the record over.
      if (error instanceof CaptureSuperseded || progress?.lost) throw error;
      if (progress) {
        // Keep what is saved for the next attempt; release only what never made
        // it, which no record names (a record lists only uploaded objects).
        try {
          const unsaved = [...held.keys()].filter((id) => !present.has(id));
          await this.releaseHeld(attachment.organizationId, objects, unsaved);
          for (const id of unsaved) held.delete(id);
          await saveProgress(true);
        } catch { /* unrecorded references leak rather than risk releasing ones a record still names */ }
        throw error;
      }
      await this.releaseHeld(attachment.organizationId, objects, [...held.keys()]);
      throw error;
    }
  }

  /** Give up an interrupted capture's saved progress, releasing what it holds.
   * A capture still running loses its record and stops without releasing. */
  async abandonProgress(attachment: ResourceAttachment): Promise<void> {
    if (!this.progressStore) return;
    const held = await CaptureProgress.take(this.progressStore, await this.key(attachment.organizationId, false)
      .catch(() => undefined), attachment.id);
    if (!held?.ids.length) return;
    const objects = held.storageLocationId && this.storageLocations
      ? (await this.storageLocations.objectStore(held.storageLocationId)) : this.objects;
    await this.releaseHeld(attachment.organizationId, objects, held.ids);
  }

  private async releaseHeld(organizationId: string, objects: ObjectStore, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const zero = (await this.chunkAccounting?.release(organizationId, ids)) ?? [];
    await Promise.allSettled(zero.map((chunkId) => objects.delete(chunkObjectKey(organizationId, chunkId))));
  }

  async restore(revision: ResourceRevision, write: (path: string, data: Buffer, offset: number) => Promise<void>,
    options: RestoreOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const manifest = await this.manifest(revision);
    // Files whose objects are all under capture keys can go straight from the
    // store to the world; anything under the organization key, whose key never
    // leaves the worker, comes through it.
    let relayed = manifest.files;
    if (options.direct && manifest.keyed) {
      const objects = await this.objectsForRevision(revision);
      const direct = manifest.files.filter((file) => entryIds(manifest, file).every((id) => manifest.keyed![id]));
      if (objects.presign && direct.length) {
        try {
          await this.restoreDirect(revision, manifest, direct, objects as Required<Pick<ObjectStore, 'presign'>> & ObjectStore, options.direct, options.signal);
          relayed = manifest.files.filter((file) => !direct.includes(file));
        } catch (error) {
          // A world that cannot run the transfer at all is written through the worker.
          if (!(error instanceof DirectTransferError) || options.direct.started) throw error;
        }
      }
    }
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

  /** Batches of whole files (pack slices) and chunk runs, each object fetched
   * once by the world through its own presigned GET; only the keys of the
   * objects in a batch go with it. */
  private async restoreDirect(revision: ResourceRevision, manifest: SnapshotManifest, files: SnapshotEntry[],
    objects: ObjectStore & Required<Pick<ObjectStore, 'presign'>>, direct: NonNullable<RestoreOptions['direct']>, signal?: AbortSignal): Promise<void> {
    const attachment = await this.attachmentFor(revision);
    const namespace = revision.storageLocationId && this.storageLocations
      && (await this.storageLocations.requireForOrganization(attachment.organizationId, revision.storageLocationId)).kind === 's3'
      ? revision.storageLocationId : undefined;
    type Segment = { path: string; position: number; size: number; object: { id: string; kind: 'pack' | 'chunk' }; slice?: [number, number]; sha256?: string };
    const batches: Segment[][] = [];
    let current: Segment[] = [];
    let objectsInBatch = new Set<string>();
    const push = (segment: Segment) => {
      if (!objectsInBatch.has(segment.object.id) && (objectsInBatch.size >= RESTORE_BATCH_OBJECTS || current.length >= RESTORE_BATCH_SEGMENTS)) {
        batches.push(current); current = []; objectsInBatch = new Set();
      }
      objectsInBatch.add(segment.object.id);
      current.push(segment);
    };
    const hashed: SnapshotEntry[] = [];
    for (const file of files) {
      const target = direct.path(file.path);
      if ('pack' in file) push({ path: target, position: 0, size: file.bytes, object: { id: manifest.packs![file.pack]!, kind: 'pack' },
        slice: [file.offset, file.offset + file.bytes], sha256: file.sha256 });
      else {
        file.chunks.forEach((id, index) => push({ path: target, position: index * CHUNK_BYTES, size: file.bytes, object: { id, kind: 'chunk' },
          ...(file.chunks.length === 1 ? { sha256: file.sha256 } : {}) }));
        if (file.chunks.length > 1) hashed.push(file);
      }
    }
    if (current.length) batches.push(current);
    // Two batches at once, each fetching many objects in parallel: one object
    // at a time pays the store's latency on every 4 MiB.
    await forEachConcurrent(batches, async (batch) => {
      signal?.throwIfAborted();
      const ids = [...new Set(batch.map((segment) => segment.object.id))];
      const urls = new Map(await Promise.all(ids.map(async (id) =>
        [id, await objects.presign('GET', chunkObjectKey(attachment.organizationId, id), 15 * 60)] as const)));
      const keys = Object.fromEntries([...new Set(ids.map((id) => manifest.keyed![id]!))].map((id) => [id, manifest.keys![id]!.key]));
      await direct.transfer.run('restore', { keys, ...(namespace ? { ns: namespace } : {}), concurrency: RESTORE_CONCURRENCY,
        segments: batch.map((segment) => ({ ...segment, object: { ...segment.object, key: manifest.keyed![segment.object.id],
          url: urls.get(segment.object.id) } })) });
      direct.started = true;
    }, 2);
    // A file of several chunks was written a chunk at a time: check it whole.
    for (const file of hashed) {
      signal?.throwIfAborted();
      const result = await direct.transfer.run<{ sha256: string; bytes: number }>('hash', { source: direct.path(file.path), path: file.path });
      if (result.sha256 !== file.sha256 || result.bytes !== file.bytes) throw new Error('resource snapshot integrity mismatch');
    }
  }

  /** One shared streaming integrity check for restore and verification. */
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
  /** Whether a world moves resource bytes to the store itself (sandboxes with
   * their own route to it), rather than through the worker.
   * KARMAX_DIRECT_RESOURCE_TRANSFER=0 turns it off. */
  directTransfer = (handle: WorldHandle): boolean => process.env.KARMAX_DIRECT_RESOURCE_TRANSFER !== '0'
    && (handle.kind === 'e2b' || handle.kind === 'daytona');

  constructor(private store: Store, private worlds: WorldRegistry, private engine: SnapshotEngine,
    private broker: CredentialBroker, private coordinator?: { client: Client; taskQueue: string },
    private storageLocations?: StorageLocationService) {
    if (engine instanceof ObjectSnapshotEngine) engine.setAttachmentResolver(async (id) => (await store.getResourceAttachment(id)));
    if (engine instanceof ObjectSnapshotEngine) engine.setChunkAccounting({
      retain: async (organizationId, chunks, storageLocationId, options) => (await store.retainResourceChunks(organizationId, chunks, storageLocationId, options)),
      release: async (organizationId, chunks) => (await store.releaseResourceChunks(organizationId, chunks)),
    });
    if (engine instanceof ObjectSnapshotEngine) engine.setProgressStore({
      get: (key) => store.kvGet(key),
      set: (key, value) => store.kvSet(key, value),
      compareAndSet: (key, expected, next) => store.kvCompareAndSet(key, expected, next),
      keys: async (prefix) => (await store.kvEntries(prefix)).map((entry) => entry.key),
      delete: (key) => store.kvDelete(key),
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
            const relativeOf = (file: string) => fileShaped(attachment) ? target : target === '.' ? file : `${target}/${file}`;
            // A sandbox with its own route to the store fetches what it can itself.
            const direct = this.directTransfer(world.handle)
              ? { transfer: new DirectTransfer(world), path: (file: string) => path.posix.join(world.handle.root, relativeOf(file)), started: false }
              : undefined;
            try {
              await timed('resource.restore', () => this.engine.restore(revision, async (file, data, offset) => {
                options.signal?.throwIfAborted();
                const sent = await timed('resource.transfer', () => transferResourceChunk(world, relativeOf(file), data, offset,
                  { compress: compression, signal: options.signal }));
                uploadedBytes += sent;
              }, { ...options, ...(direct ? { direct } : {}) }), { itemId: attachment.id });
            } finally { await direct?.transfer.cleanup(); }
            await this.store.appendEvent({ taskId, type: 'world.resource-restored', ts: Date.now(),
              payload: { attachmentId: attachment.id, revisionId, durationMs: Date.now() - startedAt, uploadedBytes,
                ...(direct?.started ? { direct: true } : {}) } });
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
    if (revision) await this.engine.delete?.(revision).catch((error) =>
      console.warn(`resource revision ${revision.id}: objects not deleted: ${error instanceof Error ? error.message : String(error)}`));
    return revision;
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    const attachment = (await this.store.getResourceAttachment(attachmentId));
    if (!attachment) return;
    await this.engine.abandonProgress?.(attachment);
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
      } catch (error) {
        await options.checkContinue?.(); // cancellation is not a staging failure
        if ((await this.store.getResourceCandidate(candidate.id))?.state !== 'pending') continue;
        if (!options.final && !(error instanceof UnstageableCandidate)) { transient.push(error); continue; }
        // A refresh that still fails keeps the snapshot already taken.
        if ((await this.store.getResourceAttachment(candidate.attachmentId))?.currentRevisionId) continue;
        const reason = error instanceof Error ? error.message : String(error);
        await this.discardCandidate(taskId, candidate.id, 'system:resource-stage-failed', reason);
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
    const stampsKey = `resource-candidate-observed:${candidate.id}`;
    let totals = { files: 0, bytes: 0 };
    // Multi-GB output takes minutes and outlives deploys: an interrupted attempt
    // leaves its progress for the next one instead of starting over.
    const transfer = this.directTransfer(handle) ? new DirectTransfer(world) : undefined;
    let capture;
    try {
      capture = await this.engine.capture(attachment,
        filesFromWorld(world, sourcePath, attachment, checkContinue, (listed) => { totals = listed; }),
        { baseline, observed: baseline ? (await this.store.kvGet(stampsKey)) : undefined, resume: true,
          onProgress: (done) => onProgress?.({ ...done, totalFiles: totals.files, totalBytes: totals.bytes }),
          ...(transfer ? { direct: { transfer, taskId } } : {}) });
    } finally { await transfer?.cleanup(); }
    const { unchanged, observed, ...captured } = capture;
    if (unchanged && baseline) {
      if (observed) (await this.store.kvSet(stampsKey, observed));
      return false;
    }
    let revision: ResourceRevision;
    try {
      revision = (await this.store.saveAndPromoteResourceRevision({ attachmentId: attachment.id, parentRevisionId: baseline?.id,
        engine: this.engine.id, ...captured, metadata: { candidate: true, sourcePath }, createdByTaskId: taskId }, baseline?.id));
    } catch (error) {
      // Discarded or staged by someone else meanwhile. Nothing was recorded, so
      // this upload's own references are released, and only these.
      await this.engine.delete?.({ id: 'unsaved', attachmentId: attachment.id, engine: this.engine.id,
        ...captured, createdAt: Date.now() }, attachment).catch(() => undefined);
      throw error;
    }
    if (observed) (await this.store.kvSet(stampsKey, observed));
    (await this.store.recordUsage({ organizationId: project.organizationId!, projectId: project.id, taskId,
      worldId: handle.id, provider: this.engine.id, kind: 'resource.storage', quantity: captured.bytes, unit: 'byte',
      costMicros: 0, fundingSource: (await this.store.getStorageLocation(captured.storageLocationId ?? ''))?.kind === 's3' ? 'byok' : 'managed',
      startedAt: candidate.createdAt, endedAt: Date.now(),
      metadata: { candidateId: candidate.id, attachmentId: attachment.id, revisionId: revision.id, files: captured.files } }));
    (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'resource:candidate-stage',
      scopeKey: `project:${project.id}`, detail: { candidateId: candidate.id, attachmentId: attachment.id,
        sourcePath, worldGeneration: candidate.worldGeneration, bytes: captured.bytes, files: captured.files,
        ...(baseline ? { refreshedFrom: baseline.id } : {}) } }));
    return true;
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
        { baseline: baseline?.attachmentId === attachment.id ? baseline : undefined, observed: sameLease ? recorded.observed : undefined,
          // A park's capture of the task's private copy is work in progress:
          // counted, never refused (see WorldCheckpointService).
          enforceQuota: false });
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
    const baseline = await this.publicationBaseline(taskId, attachment.currentRevisionId, lease.revisionId);
    const revision = (await this.store.saveResourceRevision({ attachmentId, parentRevisionId: baseline,
      engine: this.engine.id, ...captured, metadata: { summary }, createdByTaskId: taskId }));
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
 * its size and stamp; a file's bytes are read only if the consumer reads them,
 * which an unchanged file in an incremental capture never does (LT-11). Small
 * files can be read many to a round trip through their `range`; larger ones
 * stream one at a time. */
async function* filesFromWorld(world: World, target: string, attachment?: ResourceAttachment, checkContinue?: () => Promise<void>,
  onListed?: (totals: { files: number; bytes: number }) => void): AsyncGenerator<SnapshotInputFile> {
  await checkContinue?.();
  const single = Boolean(attachment && fileShaped(attachment));
  // -H follows a symlinked target the way `test -f` did, so a linked
  // single-file resource is captured rather than recorded as empty.
  const prefix = target === '.' ? '' : `${target}/`;
  const listed = await world.exec('bash', ['-lc', `date +%s.%N && pwd && { test ! -e ${quote(target)} || find -H ${quote(target)} ${single ? '-maxdepth 0 ' : ''}-type f -not -path '*/.git/*' -not -path '*/.karmax-injection/*' -printf '%s %T@ %C@ %i %p\\0'; }`],
    { timeoutMs: 30 * 60_000 });
  const [listedAtLine, cwd] = listed.stdout.split('\n', 2);
  const listedAt = Number(listedAtLine);
  const header = `${listedAtLine}\n${cwd}\n`;
  if (listed.code !== 0 || cwd === undefined || !listed.stdout.startsWith(header)) throw new Error(listed.stderr || `could not inspect resource path ${target}`);
  const entries = listed.stdout.slice(header.length).split('\0').filter(Boolean).map((record) => {
    const [size, mtime, ctime, inode, ...name] = record.split(' ');
    return { file: name.join(' '), bytes: Number(size), stamp: `${size}:${mtime}:${ctime}:${inode}`, changedAt: Number(ctime),
      // The batched reader's form of the same stamp: nanoseconds, as Node's bigint stat reports them.
      exact: `${size}:${nanoseconds(mtime!)}:${nanoseconds(ctime!)}:${inode}` };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const names = new Set(entries.map((entry) => entry.file));
  const reader: SnapshotRange['reader'] = async function* (files) {
    for await (const { data } of readCheckpointRanges(world, files.map((file) => ({ path: file.source, stamp: file.stamp,
      offset: 0, length: file.bytes })), checkContinue)) yield data;
  };
  // A single-file target may be a link, which the batched reader never follows.
  const ranged = !single && cwd.startsWith('/');
  onListed?.({ files: entries.length, bytes: entries.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.bytes) ? entry.bytes : 0), 0) });
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
    // With no WAL or rollback journal beside it, a SQLite file is the whole
    // database, so its stamp is trustworthy too.
    const sqlite = /\.(?:sqlite3?|db)$/i.test(entry.file);
    const sidecar = single || names.has(`${entry.file}-wal`) || names.has(`${entry.file}-journal`);
    const stable = (!sqlite || !sidecar) && Number.isFinite(listedAt) && entry.changedAt < listedAt - 2;
    const source = path.posix.resolve(cwd, entry.file);
    // A SQLite database is read from a consistent copy, or in place under a read lock.
    const prepare = async () => {
      const captured = await transactionalSnapshotPath(world, entry.file);
      return { source: path.posix.resolve(cwd, captured.path), renew: captured.renew, verify: captured.verify, cleanup: captured.cleanup };
    };
    yield { path: safePath(relative), ...(sqlite ? {} : { bytes: entry.bytes }), ...(stable ? { observed: entry.stamp } : {}),
      ...(ranged && !sqlite ? { range: { reader, source, stamp: entry.exact } } : {}),
      ...(ranged ? { direct: sqlite ? { source, prepare } : { source, stamp: entry.exact } } : {}),
      data: worldFileChunks(world, entry.file, sqlite ? undefined : entry.bytes, checkContinue) };
  }
}

/** `find -printf %T@` (seconds with a fraction) as integer nanoseconds. */
function nanoseconds(value: string): string {
  const [seconds = '0', fraction = ''] = value.split('.');
  return (BigInt(seconds) * 1_000_000_000n + BigInt((fraction + '000000000').slice(0, 9))).toString();
}

async function* worldFileChunks(world: World, file: string, bytes: number | undefined, checkContinue?: () => Promise<void>): AsyncGenerator<Buffer> {
  const captured = await transactionalSnapshotPath(world, file);
  let size = bytes;
  if (size === undefined) {
    const sized = await world.exec('stat', ['-c', '%s', captured.path]);
    size = sized.code === 0 ? Number(sized.stdout.trim()) : undefined;
  }
  try {
    // A provider that streams files sends one long response instead of a
    // command per 16 MiB, about three times faster out of an E2B sandbox.
    const streamed = world.readFileStream && Number.isFinite(size) ? worldStreamPath(world, captured.path) : undefined;
    if (streamed) {
      let read = 0;
      for await (const piece of world.readFileStream!(streamed)) {
        read += piece.length;
        if (read > size!) throw new Error('resource file changed or was truncated during capture');
        await checkContinue?.();
        yield piece;
        await captured.renew?.();
      }
      if (read !== size) throw new Error('resource file changed or was truncated during capture');
    } else {
      for await (const chunk of readResourceChunks(world, captured.path, Number.isFinite(size) ? size : undefined, checkContinue)) {
        yield chunk;
        await captured.renew?.();
      }
    }
    await captured.verify?.();
  } finally { await captured.cleanup?.(); }
}

/** A command-relative (or absolute) path as the world-root-relative path file APIs take. */
function worldStreamPath(world: World, file: string): string | undefined {
  const handle = world.handle;
  if (!path.posix.isAbsolute(file)) return worldWorkingRelativePath(handle, file);
  const root = (handle.root ?? '').replace(/\/+$/, '');
  return root && file.startsWith(`${root}/`) ? worldRelativePath(file.slice(root.length + 1)) : undefined;
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

async function transactionalSnapshotPath(world: World, file: string): Promise<{ path: string; cleanup?: () => Promise<void>;
  verify?: () => Promise<void>; renew?: () => Promise<void> }> {
  if (!/\.(?:sqlite3?|db)$/i.test(file)) return { path: file };
  const magic = await world.exec('bash', ['-lc', `head -c 16 ${quote(file)} | base64 -w0`]);
  if (magic.code !== 0 || Buffer.from(magic.stdout.trim(), 'base64').toString('binary') !== 'SQLite format 3\0') return { path: file };
  const temporary = `.karmax-injection/sqlite-backup-${crypto.randomBytes(8).toString('hex')}.db`;
  // The consistent copy is as large as the database.
  const space = await world.exec('bash', ['-lc', `mkdir -p .karmax-injection && printf '%s %s' "$(stat -L -c %s ${quote(file)})" "$(df -B1 --output=avail .karmax-injection | tail -1)"`]);
  const [size, free] = space.stdout.trim().split(/\s+/).map(Number);
  if (space.code === 0 && Number.isFinite(size) && Number.isFinite(free) && size! > free!) {
    const locked = await sqliteReadLock(world, file);
    if (locked) return locked;
    throw new Error(`snapshotting SQLite database ${file} consistently needs ${formatGiB(size!)} of free disk in the task world, `
      + `but only ${formatGiB(free!)} is free (or the database must be idle); free up space and propose it again`);
  }
  const script = 'import os,sqlite3,sys; os.makedirs(os.path.dirname(sys.argv[2]),exist_ok=True); s=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()';
  const backup = await world.exec('python3', ['-c', script, file, temporary], { timeoutMs: 30 * 60_000 });
  if (backup.code !== 0) {
    await world.exec('rm', ['-f', temporary]); // a partial copy must not keep the disk full
    throw new Error(`could not transactionally snapshot SQLite database ${file}: ${backup.stderr || backup.stdout}`);
  }
  return { path: temporary, cleanup: async () => { await world.exec('rm', ['-f', temporary]); } };
}

/** Read a database in place, without a copy, while a background process holds
 * a SQLite read transaction on it, so no rollback-journal writer can change the
 * file meanwhile. (In WAL mode a checkpoint still could; the stamp check then
 * rejects the snapshot.) The file's size/mtime/ctime/inode stamp and the holder
 * are checked again before the lock is released. The holder keeps its lock only
 * while the reader renews a short lease, so a reader that dies cannot leave a
 * database locked. Undefined when the lock cannot be taken (a writer is
 * active), the file is a symlink, or the database still has a WAL. */
async function sqliteReadLock(world: World, file: string): Promise<{ path: string; cleanup: () => Promise<void>;
  verify: () => Promise<void>; renew: () => Promise<void> } | undefined> {
  const ready = `.karmax-injection/sqlite-lock-${crypto.randomBytes(8).toString('hex')}`;
  const holder = 'import os,sqlite3,sys,time,urllib.parse\n'
    + 'db,ready=sys.argv[1],sys.argv[2]\n'
    + 'c=sqlite3.connect("file:"+urllib.parse.quote(db)+"?mode=ro",uri=True,timeout=0,isolation_level=None)\n'
    + 'c.execute("BEGIN"); c.execute("SELECT count(*) FROM sqlite_master").fetchone()\n'
    + 'open(ready+".tmp","w").write("locked"); os.rename(ready+".tmp",ready)\n'
    + 'while True:\n'
    + '  try:\n'
    + '    if time.time()-os.path.getmtime(ready)>' + String(SQLITE_LOCK_LEASE_SECONDS) + ': break\n'
    + '  except OSError: break\n'
    + '  time.sleep(0.5)\n';
  const quoted = quote(file);
  const started = await world.exec('bash', ['-lc', `test ! -L ${quoted} && test ! -e ${quote(`${file}-wal`)} && mkdir -p .karmax-injection || exit 1; `
    + `setsid nohup python3 -c ${quote(holder)} ${quoted} ${quote(ready)} </dev/null >/dev/null 2>${quote(`${ready}.err`)} & echo $!; `
    + `for i in $(seq 1 100); do test -s ${quote(ready)} && exit 0; test -s ${quote(`${ready}.err`)} && exit 1; sleep 0.1; done; exit 1`]);
  const pid = Number(started.stdout.trim().split('\n')[0]);
  // The lock is gone once this returns: the holder is stopped, not just told to stop.
  const release = async () => { await world.exec('bash', ['-lc', `rm -f ${quote(ready)} ${quote(`${ready}.err`)} ${quote(`${ready}.tmp`)}`
    + (Number.isInteger(pid) && pid > 1 ? `; kill ${pid} 2>/dev/null; for i in $(seq 1 50); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.1; done` : '')]); };
  if (started.code !== 0 || !Number.isInteger(pid)) { await release(); return undefined; }
  const stamp = async () => (await world.exec('bash', ['-lc',
    `kill -0 ${pid} && test -e ${quote(ready)} && find ${quoted} -maxdepth 0 -printf '%s %T@ %C@ %i'`])).stdout;
  const before = await stamp();
  if (!before) { await release(); return undefined; }
  let renewedAt = Date.now();
  return { path: file, cleanup: release,
    renew: async () => {
      if (Date.now() - renewedAt < SQLITE_LOCK_LEASE_SECONDS * 250) return;
      renewedAt = Date.now();
      await world.exec('touch', ['-c', ready]);
    },
    verify: async () => {
      if ((await stamp()) !== before) throw new Error(`SQLite database ${file} changed while it was being snapshotted`);
    } };
}

/** How long the lock holder outlives its reader's last sign of life. */
const SQLITE_LOCK_LEASE_SECONDS = 120;

function formatGiB(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
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

/** The key an object was sealed with: its capture key, else the organization's. */
function objectKey(manifest: SnapshotManifest, organizationKey: Buffer, id: string): Buffer {
  const keyId = manifest.keyed?.[id];
  return keyId ? Buffer.from(manifest.keys![keyId]!.key, 'base64') : organizationKey;
}

function manifestDigest(files: SnapshotEntry[], packs?: string[], keyed?: Record<string, string>): string {
  return sha256(Buffer.from(JSON.stringify(packs ? (keyed && Object.keys(keyed).length ? { packs, files, keyed } : { packs, files }) : files)));
}
function entryObjects(file: SnapshotEntry | ProgressFile): string[] {
  return 'chunks' in file && file.chunks ? file.chunks : typeof (file as ProgressFile).pack === 'string' ? [(file as ProgressFile).pack!] : [];
}
/** The objects one file is stored in. */
function entryIds(manifest: SnapshotManifest, file: SnapshotEntry): string[] {
  return 'pack' in file ? [manifest.packs![file.pack]!] : file.chunks;
}
/** Every object a manifest references, once each. */
function manifestObjects(manifest: SnapshotManifest): string[] {
  return [...new Set([...manifest.packs ?? [], ...manifest.files.flatMap((file) => 'chunks' in file ? file.chunks : [])])];
}

/** Bounded concurrent uploads. `add` waits for a free slot; the first failure
 * is raised by the next `add` or by `drain`. */
class BoundedUploads {
  private running = new Set<Promise<void>>();
  private failure?: { error: unknown };
  constructor(private limit: number) {}
  async add(task: () => Promise<void>): Promise<void> {
    this.raise();
    while (this.running.size >= this.limit) await Promise.race(this.running);
    this.raise();
    const run: Promise<void> = task().catch((error) => { this.failure ??= { error }; })
      .finally(() => { this.running.delete(run); });
    this.running.add(run);
  }
  get failed(): boolean { return Boolean(this.failure); }
  async drain(): Promise<void> { await this.settle(); this.raise(); }
  async settle(): Promise<void> { while (this.running.size) await Promise.all(this.running); }
  private raise(): void { if (this.failure) throw this.failure.error; }
}

/** A completed file in a progress record: its objects by id, and its stamp. */
interface ProgressFile { path: string; bytes: number; sha256: string; chunks?: string[]; pack?: string; offset?: number; stamp?: string;
  /** The capture key of its objects; absent for the organization key. */
  key?: string }
interface ProgressStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  compareAndSet(key: string, expected: string | undefined, next: string | undefined): Promise<boolean>;
  /** Keys starting with a prefix. */
  keys(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
interface ProgressHead { attachmentId: string; storageLocationId?: string; owner?: string; at: number;
  held: Array<[string, number]>; segments: string[]; keys?: Record<string, CaptureKey> }
/** Another attempt took this capture's progress record over (or it was abandoned). */
class CaptureSuperseded extends Error {
  constructor() { super('resource capture was superseded by another attempt'); }
}

/**
 * What an interrupted resumable capture has saved, and the chunk references it
 * holds, sealed in kv: a small head under `resource-capture:<attachment>` and
 * the completed files in segments beside it, one per save, so a save writes only
 * what it adds. Exactly one capture owns a record: it claims one only when none
 * exists, when its owner stopped recording, or when its owner gave it up, and
 * every later write of the head is a compare-and-set against its own last
 * write, so an attempt that lost the record stops without releasing anything (a
 * leak, never a double release). A record never names an object that is not
 * uploaded, and it is gone before any reference it names is released.
 */
class CaptureProgress {
  lost = false;
  private constructor(private store: ProgressStore, private key: Buffer, private recordKey: string,
    private head: ProgressHead, private value: string | undefined, private owner: string,
    readonly files: ProgressFile[], readonly held: Array<[string, number]>, readonly keys: Record<string, CaptureKey>) {}

  static keyFor(attachmentId: string): string { return `resource-capture:${attachmentId}`; }

  static async claim(store: ProgressStore, key: Buffer, attachment: ResourceAttachment,
    storageLocationId: string | undefined): Promise<CaptureProgress | undefined> {
    const recordKey = CaptureProgress.keyFor(attachment.id);
    const owner = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = await store.get(recordKey);
      const head = value === undefined ? undefined : openSealed<ProgressHead>(key, value);
      // A record that cannot be read is replaced; what it held leaks.
      const usable = head && head.attachmentId === attachment.id && Array.isArray(head.held) && Array.isArray(head.segments)
        && Number.isFinite(head.at) && (head.storageLocationId ?? undefined) === (storageLocationId ?? undefined);
      if (usable && head.owner && Date.now() - head.at < PROGRESS_STALE_MS) return undefined; // a live attempt
      const files: ProgressFile[] = [];
      // A missing segment only means its files are read again; their objects are still held.
      if (usable) for (const segment of head.segments) files.push(...(openSealed<ProgressFile[]>(key, (await store.get(segment)) ?? '') ?? []));
      const next: ProgressHead = { attachmentId: attachment.id, ...(storageLocationId ? { storageLocationId } : {}), owner, at: Date.now(),
        held: usable ? head.held : [], segments: usable ? head.segments : [], ...(usable && head.keys ? { keys: head.keys } : {}) };
      const sealed = sealValue(key, next);
      if (await store.compareAndSet(recordKey, value, sealed))
        return new CaptureProgress(store, key, recordKey, next, sealed, owner, files, next.held, next.keys ?? {});
    }
    return undefined;
  }

  /** Remove a record whatever its state, returning the references it held. */
  static async take(store: ProgressStore, key: Buffer | undefined, attachmentId: string)
    : Promise<{ ids: string[]; storageLocationId?: string } | undefined> {
    const recordKey = CaptureProgress.keyFor(attachmentId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = await store.get(recordKey);
      if (value === undefined) { await CaptureProgress.dropSegments(store, recordKey); return undefined; }
      if (!await store.compareAndSet(recordKey, value, undefined)) continue;
      await CaptureProgress.dropSegments(store, recordKey);
      const head = key ? openSealed<ProgressHead>(key, value) : undefined;
      return head?.attachmentId === attachmentId && Array.isArray(head.held)
        ? { ids: head.held.map(([id]) => id), storageLocationId: head.storageLocationId } : { ids: [] };
    }
    throw new Error('resource capture progress kept changing');
  }

  /** Record `files` completed since the last save. `park`: this attempt is
   * stopping, so the next one may take the record over at once. */
  async save(files: ProgressFile[], held: Array<[string, number]>, park: boolean, keys: Record<string, CaptureKey>): Promise<void> {
    if (this.lost) throw new CaptureSuperseded();
    const segments = [...this.head.segments];
    if (files.length) {
      const segment = `${this.recordKey}:${this.owner}:${segments.length}`;
      await this.store.set(segment, sealValue(this.key, files));
      segments.push(segment);
    }
    const { owner: _owner, ...rest } = this.head;
    await this.write({ ...rest, ...(park ? {} : { owner: this.owner }), at: Date.now(), held, segments,
      ...(Object.keys(keys).length ? { keys } : {}) });
  }

  async clear(): Promise<void> {
    await this.write(undefined);
    await CaptureProgress.dropSegments(this.store, this.recordKey);
  }

  private async write(next: ProgressHead | undefined): Promise<void> {
    if (this.lost) throw new CaptureSuperseded();
    const sealed = next && sealValue(this.key, next);
    if (!await this.store.compareAndSet(this.recordKey, this.value, sealed)) { this.lost = true; throw new CaptureSuperseded(); }
    this.value = sealed;
    if (next) this.head = next;
  }

  /** Segments are written before the head names them, so a lost write can leave one behind. */
  private static async dropSegments(store: ProgressStore, recordKey: string): Promise<void> {
    for (const segment of await store.keys(`${recordKey}:`)) await store.delete(segment);
  }
}

function sealValue(key: Buffer, value: unknown): string {
  return sealRandom(key, Buffer.from(JSON.stringify(value))).toString('base64');
}
function openSealed<T>(key: Buffer, value: string): T | undefined {
  try { return JSON.parse(openRandom(key, Buffer.from(value, 'base64')).toString('utf8')) as T; } catch { return undefined; }
}
