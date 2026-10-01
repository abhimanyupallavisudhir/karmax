import crypto from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import type { ObjectStore } from '../src/store/objects.js';
import { DeferredDeleteObjectStore, objectDeleteDelayMs } from '../src/store/deferred-delete.js';

const DAY = 24 * 60 * 60_000;

/** An in-memory object store whose deletes can be held open, to interleave a
 *  `put` with a purge that is between its re-check and its commit. */
class MemoryObjects implements ObjectStore {
  objects = new Map<string, Buffer>();
  deletes: string[] = [];
  holdDelete?: Promise<void>;
  onDelete?: () => void;
  async put(key: string, data: Buffer) { this.objects.set(key, data); }
  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) throw new Error(`missing ${key}`);
    return data;
  }
  async delete(key: string) {
    this.onDelete?.();
    await this.holdDelete;
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

const targets = ['sqlite', ...(process.env.KARMAX_TEST_POSTGRES_URL ? ['postgres'] : [])] as const;

describe.each(targets)('delayed deletion of managed objects (%s)', (target) => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  async function openStore(): Promise<Store> {
    if (target === 'sqlite') {
      const store = await Store.create(':memory:');
      cleanup.push(() => store.close());
      return store;
    }
    const schema = `tombstones_${crypto.randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.KARMAX_TEST_POSTGRES_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.KARMAX_TEST_POSTGRES_URL!);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const store = await Store.create(url.href);
    cleanup.push(async () => { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
    cleanup.push(() => store.close());
    return store;
  }

  async function setup(delayMs = 30 * DAY, options: { batchSize?: number } = {}) {
    const store = await openStore();
    const inner = new MemoryObjects();
    let now = 1_000_000;
    const objects = new DeferredDeleteObjectStore(inner, store, { delayMs, now: () => now, ...options });
    return { store, inner, objects, advance: (ms: number) => { now += ms; }, now: () => now };
  }

  it('keeps a deleted object readable until its delay has passed, then purges it', async () => {
    const { store, inner, objects, advance, now } = await setup();
    await objects.put('checkpoints/o/p/w/c1.bin', Buffer.from('state'));
    await objects.delete('checkpoints/o/p/w/c1.bin');
    expect(inner.deletes).toEqual([]);
    expect((await objects.get('checkpoints/o/p/w/c1.bin')).toString()).toBe('state');
    expect(await store.objectTombstone('checkpoints/o/p/w/c1.bin'))
      .toEqual({ key: 'checkpoints/o/p/w/c1.bin', deletedAt: now(), purgeAfter: now() + 30 * DAY });

    advance(30 * DAY - 1);
    expect(await objects.purgeDue()).toEqual({ purged: 0, failed: 0 });
    expect(inner.objects.has('checkpoints/o/p/w/c1.bin')).toBe(true);

    advance(1);
    expect(await objects.purgeDue()).toEqual({ purged: 1, failed: 0 });
    expect(inner.deletes).toEqual(['checkpoints/o/p/w/c1.bin']);
    expect(await store.objectTombstone('checkpoints/o/p/w/c1.bin')).toBeUndefined();
  });

  // Resource chunks are content-addressed: a chunk released to zero references
  // and deleted is legitimately written again under the same key by the next
  // capture that contains the same bytes.
  it('resurrects a deleted key that is written again, so the purge leaves it alone', async () => {
    const { store, inner, objects, advance } = await setup();
    const key = 'resources/org/chunks/abc.bin';
    await objects.put(key, Buffer.from('chunk'));
    await objects.delete(key);
    await objects.put(key, Buffer.from('chunk'));
    expect(await store.objectTombstone(key)).toBeUndefined();
    advance(31 * DAY);
    expect(await objects.purgeDue()).toEqual({ purged: 0, failed: 0 });
    expect(inner.deletes).toEqual([]);
    expect((await objects.get(key)).toString()).toBe('chunk');
  });

  it('never purges an object a concurrent put resurrected', async () => {
    const { inner, objects, advance } = await setup();
    const key = 'resources/org/chunks/race.bin';
    await objects.put(key, Buffer.from('old'));
    await objects.delete(key);
    advance(31 * DAY);

    // Hold the purge inside its transaction, after it re-checked the tombstone
    // and while it is deleting the object; start a put of the same key then.
    let release!: () => void;
    inner.holdDelete = new Promise((resolve) => { release = resolve; });
    let deleting!: () => void;
    const started = new Promise<void>((resolve) => { deleting = resolve; });
    inner.onDelete = deleting;
    const purge = objects.purgeDue();
    await started;
    let written = false;
    const put = objects.put(key, Buffer.from('new')).then(() => { written = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The put waits for the purge's transaction instead of writing underneath it.
    expect(written).toBe(false);
    release();
    await Promise.all([purge, put]);
    inner.holdDelete = undefined;
    inner.onDelete = undefined;
    expect((await objects.get(key)).toString()).toBe('new');

    // …and nothing is left that could purge the resurrected object later.
    advance(365 * DAY);
    expect(await objects.purgeDue()).toEqual({ purged: 0, failed: 0 });
    expect((await objects.get(key)).toString()).toBe('new');
  });

  it('skips a tombstone that a put cleared after the purge selected its batch', async () => {
    const { store, inner, objects, advance } = await setup();
    await objects.put('a', Buffer.from('a'));
    await objects.delete('a');
    advance(31 * DAY);
    const due = store.dueObjectTombstones.bind(store);
    vi.spyOn(store, 'dueObjectTombstones').mockImplementationOnce(async (...args) => {
      const keys = await due(...args);
      await objects.put('a', Buffer.from('again'));
      return keys;
    });
    expect(await objects.purgeDue()).toEqual({ purged: 0, failed: 0 });
    expect(inner.deletes).toEqual([]);
    expect((await objects.get('a')).toString()).toBe('again');
  });

  it('purges in bounded batches, oldest first', async () => {
    const { store, inner, objects, advance } = await setup(30 * DAY, { batchSize: 5 });
    for (let i = 0; i < 12; i++) {
      await objects.put(`k${i}`, Buffer.from(String(i)));
      await objects.delete(`k${i}`);
      advance(1);
    }
    advance(30 * DAY);
    expect(await objects.purgeDue()).toEqual({ purged: 5, failed: 0 });
    expect(inner.deletes).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(await objects.purgeDue()).toEqual({ purged: 5, failed: 0 });
    expect(await objects.purgeDue()).toEqual({ purged: 2, failed: 0 });
    expect(await store.dueObjectTombstones(Number.MAX_SAFE_INTEGER, 100)).toEqual([]);
  });

  it('keeps a tombstone whose delete failed and retries it on the next sweep', async () => {
    const { store, inner, objects, advance } = await setup();
    await objects.put('x', Buffer.from('x'));
    await objects.delete('x');
    advance(31 * DAY);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    inner.onDelete = () => { throw new Error('503 Slow Down'); };
    expect(await objects.purgeDue()).toEqual({ purged: 0, failed: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('503 Slow Down'));
    expect(await store.objectTombstone('x')).toBeDefined();
    inner.onDelete = undefined;
    expect(await objects.purgeDue()).toEqual({ purged: 1, failed: 0 });
    error.mockRestore();
  });

  it('deletes a second time from the latest delete, not the first', async () => {
    const { store, objects, advance, now } = await setup();
    await objects.delete('twice');
    advance(10 * DAY);
    await objects.delete('twice');
    expect((await store.objectTombstone('twice'))!.purgeAfter).toBe(now() + 30 * DAY);
  });

  it('deletes immediately with no delay, exactly as before', async () => {
    const { store, inner, objects } = await setup(0);
    await objects.put('now', Buffer.from('x'));
    await objects.delete('now');
    expect(inner.deletes).toEqual(['now']);
    expect(await store.objectTombstone('now')).toBeUndefined();
    await expect(objects.get('now')).rejects.toThrow('missing');
  });

  // Browser upload parts are scratch: committed into resource chunks, then
  // deleted. Delaying them would hold every uploaded byte twice for the delay.
  it('deletes transient upload parts immediately', async () => {
    const { store, inner, objects } = await setup();
    await objects.put('resource-uploads/org/upload/file/0.bin', Buffer.from('part'));
    await objects.delete('resource-uploads/org/upload/file/0.bin');
    expect(inner.deletes).toEqual(['resource-uploads/org/upload/file/0.bin']);
    expect(await store.objectTombstone('resource-uploads/org/upload/file/0.bin')).toBeUndefined();
  });
});

describe('object delete delay setting', () => {
  it('defaults to 30 days for an S3 store and to immediate for the local one', () => {
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 's3' })).toBe(30 * DAY);
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 'local' })).toBe(0);
    expect(objectDeleteDelayMs({})).toBe(0);
    // Compose passes an unset .turnkey.env value as an empty string.
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 's3', KARMAX_OBJECT_DELETE_DELAY_DAYS: '' })).toBe(30 * DAY);
  });

  it('accepts an explicit delay, including zero and fractions of a day', () => {
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 's3', KARMAX_OBJECT_DELETE_DELAY_DAYS: '0' })).toBe(0);
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 'local', KARMAX_OBJECT_DELETE_DELAY_DAYS: '45' })).toBe(45 * DAY);
    expect(objectDeleteDelayMs({ KARMAX_OBJECT_DELETE_DELAY_DAYS: '0.5' })).toBe(DAY / 2);
  });

  it('refuses a value it cannot read rather than silently deleting at once', () => {
    for (const value of ['-1', 'thirty', 'NaN', 'Infinity'])
      expect(() => objectDeleteDelayMs({ KARMAX_OBJECT_STORE: 's3', KARMAX_OBJECT_DELETE_DELAY_DAYS: value }))
        .toThrow('KARMAX_OBJECT_DELETE_DELAY_DAYS');
  });
});

describe('wiring', () => {
  it('purges due tombstones from the world lifecycle sweep', async () => {
    const { WorldLifecycleManager } = await import('../src/world/runners.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const store = await Store.create(':memory:');
    try {
      const inner = new MemoryObjects();
      const objects = new DeferredDeleteObjectStore(inner, store, { delayMs: DAY });
      await objects.put('gone', Buffer.from('x'));
      await objects.delete('gone');
      const lifecycle = new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, objects);
      await lifecycle.sweep(Date.now());
      expect(inner.deletes).toEqual([]);
      await lifecycle.sweep(Date.now() + DAY + 1);
      expect(inner.deletes).toEqual(['gone']);
    } finally { await store.close(); }
  });
});
