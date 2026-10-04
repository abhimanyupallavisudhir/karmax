import type { ObjectStore } from '../store/objects.js';
import { CHUNK_BYTES, chunkObjectKey } from './chunk-store.js';
import { DirectTransferError, type DirectTransfer } from './direct-transfer.js';

/** Where a file's bytes are in the world, for a direct capture. `prepare`
 * makes a consistent copy (a SQLite database) and is then used instead. */
export interface DirectSource {
  source: string;
  stamp?: string;
  prepare?: () => Promise<{ source: string; renew?: () => Promise<void>; verify?: () => Promise<void>; cleanup?: () => Promise<void> }>;
}
export interface DirectInput extends DirectSource { path: string; bytes?: number; observed?: string }

/** A file as the engine records it: its objects by id, under one key. */
export interface DirectEntry { path: string; bytes: number; sha256: string; chunks?: string[]; pack?: string; offset?: number;
  key: string; stamp?: string }
interface BaselineFile { bytes: number; sha256: string }

/** What a direct capture needs from the engine; the engine keeps every decision. */
export interface DirectContext {
  organizationId: string;
  key: { id: string; secret: Buffer };
  namespace?: string;
  objects: Required<Pick<ObjectStore, 'presign' | 'head'>>;
  transfer: DirectTransfer;
  baseline(path: string): BaselineFile | undefined;
  reuse(path: string, observed: string | undefined): Promise<void>;
  /** References before upload, counted at the bytes actually stored. */
  retain(objects: Array<{ id: string; bytes: number }>): Promise<void>;
  present: Set<string>;
  add(entry: DirectEntry): void;
  uploaded(): void;
  progress(inFlight: number): void;
  tick(): Promise<void>;
  checkContinue?(): Promise<void>;
}

interface Staged { id: string; file: string; bytes: number; size: number }

const PACK_BYTES = CHUNK_BYTES;
/** Below a pack's size a file goes into packs: one round trip reads thousands
 * of them, where a file of its own costs several (pramana#1: 1-5 MB files). */
const SMALL_BYTES = PACK_BYTES;
/** One `pack` run reads at most this much, or this many files. */
const SMALL_BATCH_BYTES = 128 * 1024 * 1024;
const SMALL_BATCH_FILES = 8000;
/** One `chunks` run stages this many 4 MiB chunks of a large file. */
const CHUNK_BATCH = 32;
/** Many objects at once: each PUT pays the store's request latency, so a
 * single stream of 4 MiB objects runs at a fraction of the link. */
const UPLOAD_CONCURRENCY = 32;
const URL_SECONDS = 15 * 60;
/** Encryption overhead of a stored object: chunks are KRC1 + tag; packs are
 * KRZ1 + nonce + tag around gzip, which can grow incompressible data slightly. */
const CHUNK_OVERHEAD = 20;
const packBound = (plain: number) => plain + 64 + Math.ceil(plain / 16_384) * 5;

/**
 * Captures files by having the world read, encrypt and upload them itself
 * (wiki planned/direct-resource-uploads). The world only ever gets this
 * capture's key and a presigned URL per object the worker chose to upload; the
 * worker retains every reference first, counts each object at the size the
 * store reports, and records the files. Until the first upload succeeds, a
 * world that cannot do this (no Node, no route to the store) hands its files
 * back for the worker to read instead.
 */
export class DirectCapture<T> {
  disabled = false;
  private pending: Array<{ input: DirectInput; original: T }> = [];
  private pendingBytes = 0;
  private succeeded = false;
  /** The upload in flight: the next batch is prepared while it runs. */
  private inflight: Promise<void> = Promise.resolve();
  /** Inputs whose objects are not confirmed stored yet. */
  private unconfirmed = new Set<T>();

  constructor(private ctx: DirectContext) {}

  /** Undefined when queued or done; otherwise the inputs the caller must capture itself. */
  async add(input: DirectInput, original: T): Promise<T[] | undefined> {
    if (!input.prepare && input.bytes !== undefined && input.bytes < SMALL_BYTES) {
      this.pending.push({ input, original });
      this.pendingBytes += input.bytes;
      if (this.pending.length >= SMALL_BATCH_FILES || this.pendingBytes >= SMALL_BATCH_BYTES) return this.flushPending();
      return undefined;
    }
    const handed = await this.flushPending();
    if (handed) return [...handed, original];
    return this.guard(() => this.large(input, original), [original]);
  }

  /** Capture whatever is queued and wait for every upload; same contract as `add`. */
  async flush(): Promise<T[] | undefined> {
    const handed = await this.flushPending();
    if (handed) return handed;
    return this.guard(() => this.inflight, []);
  }

  private async flushPending(): Promise<T[] | undefined> {
    if (!this.pending.length) return undefined;
    const batch = this.pending;
    this.pending = []; this.pendingBytes = 0;
    return this.guard(() => this.small(batch), batch.map(({ original }) => original));
  }

  private async guard(run: () => Promise<void>, originals: T[]): Promise<T[] | undefined> {
    try { await run(); return undefined; }
    catch (error) {
      if (this.succeeded || !isUnavailable(error)) throw error;
      this.disabled = true;
      await this.inflight.catch(() => undefined);
      await this.ctx.transfer.cleanup();
      const handed = new Set([...this.unconfirmed, ...this.pending.map(({ original }) => original), ...originals]);
      this.unconfirmed.clear(); this.pending = [];
      return [...handed];
    }
  }

  /** Upload once the previous upload is done, then record; returns as soon as it starts. */
  private async enqueue(staged: Staged[], originals: T[], recorded: () => Promise<void> | void): Promise<void> {
    await this.inflight;
    for (const original of originals) this.unconfirmed.add(original);
    const run = (async () => {
      await this.upload(staged);
      await recorded();
      for (const original of originals) this.unconfirmed.delete(original);
    })();
    this.inflight = run;
    run.catch(() => undefined); // raised by the next enqueue or flush
  }

  /** Run once every upload so far is done, without waiting for it here. */
  private after(recorded: () => void): void {
    const run = this.inflight.then(recorded);
    this.inflight = run;
    run.catch(() => undefined); // raised by the next enqueue or flush
  }

  private async small(batch: Array<{ input: DirectInput; original: T }>): Promise<void> {
    await this.ctx.checkContinue?.();
    const files = batch.map(({ input }) => input);
    const result = await this.ctx.transfer.run<{ packs: Staged[]; files: Array<{ path: string; changed?: true; same?: true;
      bytes?: number; sha256?: string; pack?: string; offset?: number }> }>('pack', {
      key: this.ctx.key.secret.toString('base64'), ...(this.ctx.namespace ? { ns: this.ctx.namespace } : {}), packBytes: PACK_BYTES,
      files: files.map((file) => {
        const prior = this.ctx.baseline(file.path);
        return { source: file.source, stamp: file.stamp, bytes: file.bytes, path: file.path,
          ...(prior && prior.bytes === file.bytes ? { base: prior.sha256 } : {}) };
      }) });
    if (result.files.length !== files.length) throw new Error('direct capture returned the wrong files');
    for (const pack of result.packs)
      if (pack.size > packBound(pack.bytes)) throw new Error('direct capture staged an object larger than its contents');
    const byPath = new Map(batch.map((item) => [item.input.path, item]));
    const packed: Array<{ entry: DirectEntry; original: T }> = [];
    for (const file of result.files) {
      const item = byPath.get(file.path);
      if (!item) throw new Error('direct capture returned the wrong files');
      if (file.changed) throw new Error(`${file.path} changed while it was being saved; save it again once it is settled`);
      const stamp = item.input.observed;
      if (file.same) { await this.ctx.reuse(file.path, stamp); continue; }
      if (!result.packs.some((pack) => pack.id === file.pack)) throw new Error('direct capture returned a file outside its packs');
      packed.push({ original: item.original, entry: { path: file.path, bytes: file.bytes!, sha256: file.sha256!, pack: file.pack!,
        offset: file.offset!, key: this.ctx.key.id, ...(stamp ? { stamp } : {}) } });
    }
    await this.enqueue(result.packs, packed.map(({ original }) => original), () => {
      for (const { entry } of packed) this.ctx.add(entry);
      this.ctx.progress(0);
    });
  }

  private async large(input: DirectInput, original: T): Promise<void> {
    const prepared = input.prepare ? await input.prepare() : { source: input.source };
    try {
      const stamp = input.prepare ? undefined : input.stamp;
      const base = { source: prepared.source, path: input.path, ...(stamp ? { stamp } : {}) };
      const prior = this.ctx.baseline(input.path);
      // An unchanged large file keeps its baseline objects: hashing in place is
      // far cheaper than uploading it again.
      if (prior && (input.bytes === undefined || input.bytes === prior.bytes)) {
        const hashed = await this.ctx.transfer.run<{ sha256: string; bytes: number }>('hash', base);
        if (hashed.sha256 === prior.sha256 && hashed.bytes === prior.bytes) {
          await prepared.verify?.();
          await this.ctx.reuse(input.path, input.observed);
          return;
        }
      }
      const chunks: string[] = [];
      let offset = 0;
      let sha256: string | undefined;
      this.unconfirmed.add(original);
      for (let eof = false; !eof;) {
        await this.ctx.checkContinue?.();
        const result = await this.ctx.transfer.run<{ chunks: Staged[]; next: number; eof: boolean; sha256?: string }>('chunks', {
          ...base, key: this.ctx.key.secret.toString('base64'), ...(this.ctx.namespace ? { ns: this.ctx.namespace } : {}),
          offset, count: CHUNK_BATCH, chunkBytes: CHUNK_BYTES });
        for (const chunk of result.chunks)
          if (chunk.size !== chunk.bytes + CHUNK_OVERHEAD || chunk.bytes > CHUNK_BYTES)
            throw new Error('direct capture staged an object larger than its contents');
        chunks.push(...result.chunks.map((chunk) => chunk.id));
        offset = result.next; eof = result.eof; sha256 = result.sha256;
        const through = offset;
        await this.enqueue(result.chunks, [], () => this.ctx.progress(through));
        await prepared.renew?.();
        await this.ctx.tick();
      }
      // A file read in several runs is hashed whole, while its last upload runs.
      if (!sha256) {
        const hashed = await this.ctx.transfer.run<{ sha256: string; bytes: number }>('hash', base);
        if (hashed.bytes !== offset) throw new Error(`${input.path} changed while it was being saved; save it again once it is settled`);
        sha256 = hashed.sha256;
      }
      if (input.bytes !== undefined && offset !== input.bytes)
        throw new Error(`${input.path} changed while it was being saved; save it again once it is settled`);
      await prepared.verify?.();
      const entry: DirectEntry = { path: input.path, bytes: offset, sha256, chunks, key: this.ctx.key.id,
        ...(input.observed ? { stamp: input.observed } : {}) };
      // Recorded once its objects are stored; the next file is read meanwhile.
      this.after(() => { this.ctx.add(entry); this.unconfirmed.delete(original); });
    } finally { await prepared.cleanup?.(); }
  }

  /** Retain, then upload only what the store does not hold yet, then check
   * the store holds exactly what was staged. */
  private async upload(staged: Staged[]): Promise<void> {
    if (!staged.length) return;
    await this.ctx.retain(staged.map((object) => ({ id: object.id, bytes: object.size })));
    const fresh = [...new Map(staged.filter((object) => !this.ctx.present.has(object.id)).map((object) => [object.id, object])).values()];
    const items = await Promise.all(fresh.map(async (object) => ({ file: object.file,
      url: await this.ctx.objects.presign('PUT', chunkObjectKey(this.ctx.organizationId, object.id), URL_SECONDS) })));
    const discard = staged.filter((object) => !items.some((item) => item.file === object.file)).map((object) => object.file);
    await this.ctx.transfer.run('upload', { items, discard, concurrency: UPLOAD_CONCURRENCY });
    await Promise.all(fresh.map(async (object) => {
      const stored = await this.ctx.objects.head(chunkObjectKey(this.ctx.organizationId, object.id));
      if (stored?.bytes !== object.size) throw new Error('the object store does not hold what the world reported uploading');
      this.ctx.present.add(object.id);
    }));
    if (fresh.length) { this.succeeded = true; this.ctx.uploaded(); }
  }
}

/** The world could not take part at all, as opposed to a file or upload failing. */
function isUnavailable(error: unknown): boolean {
  return error instanceof DirectTransferError;
}
