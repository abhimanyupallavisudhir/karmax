import crypto from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { WorldCheckpoint } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { StorageLocationService } from '../store/storage-locations.js';
import type { Store } from '../store/db.js';
import type { World } from './types.js';
import { CHUNK_BYTES, chunkId, chunkObjectKey, openCompressed, openDeterministic, openRandom, organizationKey,
  sealCompressed, sealDeterministic, sealRandom, sha256 } from './chunk-store.js';
import { readCheckpointRanges, statCheckpointFiles, type CheckpointRange, type CheckpointStat } from './checkpoint-read.js';

const deflate = promisify(gzip);
const inflate = promisify(gunzip);

/** Policy, not memory: capture and restore stream one chunk at a time, so
 * these bound how long a park may take and what one task may store. The
 * organization's storage quota is enforced chunk by chunk as bytes are kept. */
export const CHECKPOINT_LIMITS = {
  files: 100_000,
  fileBytes: 16 * 1024 ** 3,
  totalBytes: 64 * 1024 ** 3,
};
/** Smaller files are packed together, so a typical park is one or two objects. */
const PACKED_FILE_BYTES = 1024 * 1024;
const PACK_BYTES = CHUNK_BYTES;
/** A file that keeps changing while it is read is retried this many times. */
const CHANGED_RETRIES = 2;
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

export type FilesystemDelta = NonNullable<WorldCheckpoint['filesystemDelta']>;
type Common = { repo: string; path: string };
type Content = { bytes: number; sha256: string; executable?: true; stamp?: string };
export type ManifestEntry = Common & (
  | { deleted: true }
  | { link: string; stamp?: string }
  | Content & { pack: number; offset: number }
  | Content & { chunks: string[] });
export interface Manifest { version: 2; worldId: string; generation: number; packs: string[]; files: ManifestEntry[] }

export interface CaptureEntry { repo: string; path: string; deleted?: boolean; readPath?: string }

/** Why a checkpoint was refused, with the files the agent can commit, ignore or move. */
export class CheckpointRefusedError extends Error {
  constructor(message: string, readonly files: Array<{ path: string; bytes?: number; reason?: string }>) { super(message); }
}

interface Location { organizationId: string; id?: string; objects: ObjectStore; namespace?: string }

/** Chunked, incremental world checkpoints (wiki features/chunked-world-checkpoints).
 * File bytes stream from the sandbox into tenant-encrypted content-addressed
 * chunks in the organization's storage location, shared and reference-counted
 * with project-resource snapshots; one sealed manifest names them. Small files
 * share compressed packs. A file whose stamp is unchanged since the previous
 * checkpoint of the same sandbox is neither read nor uploaded again. */
export class ChunkedCheckpointStore {
  constructor(private store: Store, private broker: CredentialBroker, private objects: ObjectStore,
    private storageLocations?: StorageLocationService) {}

  async capture(input: { world: World; organizationId: string; worldId: string; generation: number; objectKey: string;
    entries: CaptureEntry[]; baseline?: WorldCheckpoint; checkContinue?: () => Promise<void> }): Promise<{
    delta: FilesystemDelta; uploadedBytes: number; omitted: Array<{ path: string; reason: string }>; rollback: () => Promise<void>;
    /** The largest files captured, for a notice if storage is over its quota. */
    largest: Array<{ path: string; bytes: number }>;
  }> {
    const { world, organizationId, checkContinue } = input;
    const location = await this.location(organizationId);
    const key = await organizationKey(this.broker, organizationId);
    const baseline = input.baseline?.filesystemDelta?.format === 2 && input.baseline.worldId === input.worldId
      && input.baseline.generation === input.generation
      && (input.baseline.filesystemDelta.storageLocationId ?? undefined) === location.id
      ? await this.manifest(input.baseline, organizationId).catch(() => undefined) : undefined;
    const previous = new Map(baseline?.files.flatMap(file => 'stamp' in file && file.stamp ? [[`${file.repo}\0${file.path}`, file] as const] : []));
    // The baseline's references keep these objects alive while this capture runs.
    const uploaded = new Set([...baseline?.packs ?? [], ...baseline?.files.flatMap(file => 'chunks' in file ? file.chunks : []) ?? []]);
    const held = new Map<string, number>();
    let uploadedBytes = 0;
    const retain = async (chunks: Array<{ id: string; bytes: number }>) => {
      const fresh = chunks.filter(chunk => !held.has(chunk.id));
      if (!fresh.length) return;
      // Counted against the quota but never refused (wiki features/managed-storage):
      // a world that cannot checkpoint cannot park, and an over-quota organization
      // is read-only for new data, not for saving work in progress.
      await this.store.retainResourceChunks(organizationId, fresh, location.id, { enforceQuota: false });
      for (const chunk of fresh) held.set(chunk.id, chunk.bytes);
    };
    const put = async (id: string, sealed: () => Buffer | Promise<Buffer>, bytes: number) => {
      await retain([{ id, bytes }]);
      if (uploaded.has(id)) return;
      const value = await sealed();
      await location.objects.put(chunkObjectKey(organizationId, id), value);
      uploaded.add(id);
      uploadedBytes += value.length;
    };
    const rollback = async () => {
      const zero = await this.store.releaseResourceChunks(organizationId, [...held.keys()]);
      held.clear();
      await this.deleteChunks(location, zero);
    };

    const readable = input.entries.filter(entry => !entry.deleted && entry.readPath !== undefined);
    let stats = await statCheckpointFiles(world, readable.map(entry => entry.readPath!), checkContinue);
    try {
      const omitted: Array<{ path: string; reason: string }> = [];
      // Deleted since Git listed it: restore it as a deletion.
      const gone: CaptureEntry[] = [];
      const files: Array<{ entry: CaptureEntry; stat: CheckpointStat }> = [];
      readable.forEach((entry, index) => {
        const stat = stats[index]!;
        if (stat.kind === 'file' || stat.kind === 'link') files.push({ entry, stat });
        else if (stat.kind === 'missing') gone.push(entry);
        // An untracked nested repository or a socket has no portable bytes.
        else omitted.push({ path: entry.readPath!, reason: stat.kind === 'directory' ? 'nested repository' : 'not a regular file' });
      });
      this.enforceLimits(files.map(file => file.stat), input.entries.length);

      const manifest: Manifest = { version: 2, worldId: input.worldId, generation: input.generation, packs: [], files: [] };
      const packIndex = new Map<string, number>();
      const packFor = (id: string) => {
        let index = packIndex.get(id);
        if (index === undefined) { index = manifest.packs.push(id) - 1; packIndex.set(id, index); }
        return index;
      };
      const out = new Map<CaptureEntry, ManifestEntry>();
      for (const entry of [...input.entries.filter(entry => entry.deleted), ...gone])
        out.set(entry, { repo: entry.repo, path: entry.path, deleted: true });

      // Unchanged since the previous checkpoint of this sandbox: keep its chunks.
      const reused: Array<{ id: string; bytes: number }> = [];
      let pending: typeof files = [];
      for (const file of files) {
        const prior = previous.get(`${file.entry.repo}\0${file.entry.path}`);
        if (!prior || !file.stat.stable || !('stamp' in prior) || prior.stamp !== file.stat.stamp) { pending.push(file); continue; }
        if ('link' in prior) out.set(file.entry, prior);
        else if ('pack' in prior) {
          const id = baseline!.packs[prior.pack]!;
          out.set(file.entry, { ...prior, pack: packFor(id) });
          reused.push({ id, bytes: PACK_BYTES });
        } else if ('chunks' in prior) {
          out.set(file.entry, prior);
          prior.chunks.forEach((id, index) => reused.push({ id, bytes: Math.min(CHUNK_BYTES, prior.bytes - index * CHUNK_BYTES) }));
        }
      }
      await retain([...new Map(reused.map(chunk => [chunk.id, chunk])).values()]);

      // Links and small files: batched reads into compressed packs.
      let pack: Buffer[] = [];
      let packBytes = 0;
      let packEntries: Array<{ entry: CaptureEntry; value: ManifestEntry & { pack: number } }> = [];
      const flush = async () => {
        if (!packEntries.length) return;
        const plain = Buffer.concat(pack, packBytes);
        const id = chunkId(key, location.namespace, plain, 'pack');
        await put(id, () => sealCompressed(key, id, plain), plain.length);
        const index = packFor(id);
        for (const { entry, value } of packEntries) out.set(entry, { ...value, pack: index });
        pack = []; packBytes = 0; packEntries = [];
      };
      // Each round reads whatever is pending; a file that changed under its read
      // is stat'ed again (it may have grown past the pack size) and retried.
      for (let attempt = 0; pending.length; attempt++) {
        const changed: typeof pending = [];
        const small = pending.filter(file => file.stat.kind === 'link' || file.stat.bytes < PACKED_FILE_BYTES);
        for await (const { range: { file }, data: bytes } of readCheckpointRanges(world, small.map(range), checkContinue)) {
          if (!bytes) { changed.push(file); continue; }
          const { entry, stat } = file;
          if (stat.kind === 'link') {
            out.set(entry, { repo: entry.repo, path: entry.path, link: bytes.toString('base64'), ...(stat.stable ? { stamp: stat.stamp } : {}) });
            continue;
          }
          if (packBytes && packBytes + bytes.length > PACK_BYTES) await flush();
          packEntries.push({ entry, value: { repo: entry.repo, path: entry.path, bytes: bytes.length, sha256: sha256(bytes),
            ...(stat.executable ? { executable: true as const } : {}), ...(stat.stable ? { stamp: stat.stamp } : {}),
            pack: -1, offset: packBytes } });
          pack.push(bytes); packBytes += bytes.length;
        }
        // Large files: one chunk per round trip, never more than one in memory.
        for (const file of pending.filter(candidate => !small.includes(candidate))) {
          const captured = await this.captureLarge(world, file, key, location, put, checkContinue);
          if (captured) out.set(file.entry, captured);
          else changed.push(file);
        }
        pending = await this.restat(world, changed, attempt, stats,
          entry => out.set(entry, { repo: entry.repo, path: entry.path, deleted: true }), checkContinue);
      }
      await flush();

      manifest.files = input.entries.flatMap(entry => out.get(entry) ?? []);
      const referenced = new Set([...manifest.packs, ...manifest.files.flatMap(file => 'chunks' in file ? file.chunks : [])]);
      // A retried file's discarded chunks are not part of this checkpoint.
      const orphans = [...held.keys()].filter(id => !referenced.has(id));
      if (orphans.length) {
        await this.deleteChunks(location, await this.store.releaseResourceChunks(organizationId, orphans));
        for (const id of orphans) held.delete(id);
      }
      const sealed = sealRandom(key, await deflate(Buffer.from(JSON.stringify(manifest))));
      await checkContinue?.();
      await location.objects.put(input.objectKey, sealed);
      uploadedBytes += sealed.length;
      const contentBytes = manifest.files.reduce((sum, file) => sum + ('bytes' in file ? file.bytes : 0), 0);
      return {
        delta: { format: 2, objectKey: input.objectKey, sha256: sha256(sealed), bytes: sealed.length,
          ...(location.id ? { storageLocationId: location.id } : {}), files: manifest.files.length, contentBytes },
        uploadedBytes, omitted, largest: largest(stats.filter(stat => stat.kind === 'file')),
        rollback: async () => {
          await location.objects.delete(input.objectKey).catch(() => undefined);
          await rollback();
        },
      };
    } catch (error) {
      await rollback().catch(() => undefined);
      throw error;
    }
  }

  /** Open and validate a checkpoint's manifest. */
  async manifest(checkpoint: WorldCheckpoint, organizationId: string): Promise<Manifest> {
    const delta = checkpoint.filesystemDelta;
    if (delta?.format !== 2) throw new Error('checkpoint is not chunked');
    if (delta.bytes > MAX_MANIFEST_BYTES) throw new Error('checkpoint manifest size limit exceeded');
    const location = await this.location(organizationId, delta.storageLocationId);
    const sealed = await location.objects.get(delta.objectKey);
    if (sha256(sealed) !== delta.sha256) throw new Error('checkpoint object hash mismatch');
    const key = await organizationKey(this.broker, organizationId, false);
    const manifest = JSON.parse((await inflate(openRandom(key, sealed), { maxOutputLength: MAX_MANIFEST_BYTES })).toString('utf8')) as Manifest;
    if (manifest.version !== 2 || manifest.worldId !== checkpoint.worldId || !Array.isArray(manifest.files) || !Array.isArray(manifest.packs)
      || manifest.packs.some(id => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error('invalid checkpoint manifest');
    for (const file of manifest.files) {
      if (typeof file.repo !== 'string' || typeof file.path !== 'string') throw new Error('invalid checkpoint manifest');
      if ('chunks' in file && (!Array.isArray(file.chunks) || file.chunks.length !== Math.max(1, Math.ceil(file.bytes / CHUNK_BYTES))
        || file.chunks.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw new Error('invalid checkpoint manifest');
      if ('pack' in file && (!Number.isSafeInteger(file.pack) || !manifest.packs[file.pack])) throw new Error('invalid checkpoint manifest');
    }
    return manifest;
  }

  /** Each entry with a function streaming its verified bytes in order. Packs
   * are fetched once while consecutive files read from them. */
  async *entries(checkpoint: WorldCheckpoint, organizationId: string, opened?: Manifest): AsyncGenerator<ManifestEntry & { content?: () => AsyncIterable<Buffer> }> {
    const manifest = opened ?? await this.manifest(checkpoint, organizationId);
    const location = await this.location(organizationId, checkpoint.filesystemDelta!.storageLocationId);
    const key = await organizationKey(this.broker, organizationId, false);
    let cached: { id: string; plain: Buffer } | undefined;
    const pack = async (id: string) => {
      if (cached?.id !== id) cached = { id, plain: await openCompressed(key, id,
        await location.objects.get(chunkObjectKey(organizationId, id)), PACK_BYTES) };
      return cached.plain;
    };
    for (const file of manifest.files) {
      if ('pack' in file) {
        // Fetched when written; files written in manifest order share each pack.
        yield { ...file, content: async function* () {
          const plain = (await pack(manifest.packs[file.pack]!)).subarray(file.offset, file.offset + file.bytes);
          if (plain.length !== file.bytes || sha256(plain) !== file.sha256) throw new Error('checkpoint integrity mismatch');
          yield plain;
        } };
      } else if ('chunks' in file) {
        yield { ...file, content: async function* () {
          const digest = crypto.createHash('sha256');
          let bytes = 0;
          for (const id of file.chunks) {
            const plain = openDeterministic(key, id, await location.objects.get(chunkObjectKey(organizationId, id)));
            if (plain.length !== Math.min(CHUNK_BYTES, file.bytes - bytes)) throw new Error('checkpoint chunk size mismatch');
            digest.update(plain); bytes += plain.length;
            yield plain;
          }
          if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) throw new Error('checkpoint integrity mismatch');
        } };
      } else yield file;
    }
  }

  /** Drop one checkpoint's references; chunks nothing else holds are deleted.
   * `claim` removes the checkpoint's record and is true for exactly one caller,
   * so a retried or concurrent deletion never releases the same references
   * twice. Interrupted after the claim, it leaks storage rather than data. */
  async release(checkpoint: WorldCheckpoint, organizationId: string, claim: () => Promise<boolean>): Promise<void> {
    const delta = checkpoint.filesystemDelta;
    if (delta?.format !== 2) throw new Error('checkpoint is not chunked');
    const location = await this.location(organizationId, delta.storageLocationId);
    let manifest: Manifest | undefined;
    try { manifest = await this.manifest(checkpoint, organizationId); }
    catch (error) {
      // Gone already, or its organization key is: nothing is left to release.
      if (!/ENOENT|\(404\)|resource key unavailable/.test(String((error as Error)?.message))) throw error;
    }
    if (!await claim()) return;
    await location.objects.delete(delta.objectKey);
    if (!manifest) return;
    const ids = [...new Set([...manifest.packs, ...manifest.files.flatMap(file => 'chunks' in file ? file.chunks : [])])];
    await this.deleteChunks(location, await this.store.releaseResourceChunks(organizationId, ids));
  }

  private async captureLarge(world: World, file: { entry: CaptureEntry; stat: CheckpointStat }, key: Buffer, location: Location,
    put: (id: string, sealed: () => Buffer, bytes: number) => Promise<void>, checkContinue?: () => Promise<void>): Promise<ManifestEntry | undefined> {
    const { entry, stat } = file;
    const digest = crypto.createHash('sha256');
    const chunks: string[] = [];
    for (let offset = 0; offset < stat.bytes; offset += CHUNK_BYTES) {
      let plain: Buffer | undefined;
      for await (const read of readCheckpointRanges(world, [{ path: entry.readPath!, stamp: stat.stamp, offset,
        length: Math.min(CHUNK_BYTES, stat.bytes - offset) }], checkContinue)) plain = read.data;
      if (!plain) return undefined;
      const id = chunkId(key, location.namespace, plain);
      await put(id, () => sealDeterministic(key, id, plain), plain.length);
      digest.update(plain);
      chunks.push(id);
    }
    return { repo: entry.repo, path: entry.path, bytes: stat.bytes, sha256: digest.digest('hex'),
      ...(stat.executable ? { executable: true as const } : {}), ...(stat.stable ? { stamp: stat.stamp } : {}), chunks };
  }

  private async restat<T extends { entry: CaptureEntry; stat: CheckpointStat }>(world: World, changed: T[], attempt: number,
    stats: CheckpointStat[], gone: (entry: CaptureEntry) => void, checkContinue?: () => Promise<void>): Promise<T[]> {
    if (!changed.length) return [];
    if (attempt >= CHANGED_RETRIES)
      throw new CheckpointRefusedError(`${changed.length === 1 ? `${changed[0]!.entry.readPath} keeps` : `${changed.length} files keep`} changing while the world is checkpointed`,
        changed.slice(0, 20).map(file => ({ path: file.entry.readPath!, reason: 'keeps changing' })));
    const fresh = await statCheckpointFiles(world, changed.map(file => file.entry.readPath!), checkContinue);
    const files = changed.map((file, index) => ({ ...file, stat: fresh[index]! }));
    for (const file of files) {
      const index = stats.findIndex(candidate => candidate.path === file.stat.path);
      if (index >= 0) stats[index] = file.stat;
    }
    this.enforceLimits(stats.filter(stat => stat.kind === 'file' || stat.kind === 'link'), stats.length);
    for (const file of files) {
      if (file.stat.kind === 'missing') gone(file.entry);
      else if (file.stat.kind !== 'file' && file.stat.kind !== 'link')
        throw new CheckpointRefusedError(`${file.entry.readPath} stopped being a file while it was checkpointed`, [{ path: file.entry.readPath! }]);
    }
    return files.filter(file => file.stat.kind !== 'missing');
  }

  private enforceLimits(stats: CheckpointStat[], count: number): void {
    if (count > CHECKPOINT_LIMITS.files)
      throw new CheckpointRefusedError(`${count} changed files exceed the checkpoint limit of ${CHECKPOINT_LIMITS.files}`, []);
    const tooLarge = stats.filter(stat => stat.bytes > CHECKPOINT_LIMITS.fileBytes);
    if (tooLarge.length)
      throw new CheckpointRefusedError(`${tooLarge.length === 1 ? 'a file exceeds' : `${tooLarge.length} files exceed`} the ${formatBytes(CHECKPOINT_LIMITS.fileBytes)} checkpoint file limit`,
        largest(tooLarge));
    const total = stats.reduce((sum, stat) => sum + stat.bytes, 0);
    if (total > CHECKPOINT_LIMITS.totalBytes)
      throw new CheckpointRefusedError(`${formatBytes(total)} of uncommitted files exceed the ${formatBytes(CHECKPOINT_LIMITS.totalBytes)} checkpoint limit`,
        largest(stats));
  }

  private async deleteChunks(location: Location, ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map(id => location.objects.delete(chunkObjectKey(location.organizationId, id))));
  }

  private async location(organizationId: string, id?: string): Promise<Location> {
    if (!this.storageLocations) {
      if (id) throw new Error('checkpoint storage location is unavailable');
      return { organizationId, objects: this.objects };
    }
    const location = await this.storageLocations.requireForOrganization(organizationId, id);
    return { organizationId, id: location.id, objects: await this.storageLocations.objectStore(location.id),
      ...(location.kind === 's3' ? { namespace: location.id } : {}) };
  }
}

function range<T extends { entry: CaptureEntry; stat: CheckpointStat }>(file: T): CheckpointRange & { file: T } {
  return { path: file.entry.readPath!, stamp: file.stat.stamp, offset: 0, length: file.stat.bytes, file };
}

function largest(stats: CheckpointStat[]): Array<{ path: string; bytes: number }> {
  return [...stats].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(stat => ({ path: stat.path, bytes: stat.bytes }));
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${bytes} bytes`;
}
