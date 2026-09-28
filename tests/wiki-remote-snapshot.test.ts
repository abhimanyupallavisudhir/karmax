import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteWikiSnapshots } from '../src/wiki/remote-snapshot.js';

// A remote task's wiki is copied out of its sandbox. Browsing one used to pay
// that copy (resume, N file reads, park) on every request; these pin the cache
// that makes the index and every page after it read from one copy.
describe('remote wiki snapshot cache', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-snapshots-'));
    dirs.push(parent);
    let now = 1_000_000;
    let version = 'v1';
    let copies = 0;
    let gate: Promise<void> | undefined;
    const cache = new RemoteWikiSnapshots(parent, { freshMs: 1_000, staleMs: 10_000, now: () => now });
    const copy = async (root: string) => {
      copies++;
      const content = version;
      await gate;
      fs.writeFileSync(path.join(root, 'page.md'), content);
    };
    const read = async (world = 'w:1') => fs.readFileSync(path.join(await cache.read('task', world, copy), 'page.md'), 'utf8');
    return {
      cache, read,
      advance: (ms: number) => { now += ms; },
      setVersion: (value: string) => { version = value; },
      hold: () => { let open!: () => void; gate = new Promise((resolve) => { open = resolve; }); return () => { gate = undefined; open(); }; },
      copies: () => copies,
    };
  };

  it('serves every read inside the freshness window from one copy', async () => {
    const t = setup();
    expect(await Promise.all([t.read(), t.read(), t.read()])).toEqual(['v1', 'v1', 'v1']);
    expect(t.copies()).toBe(1); // concurrent first reads share the in-flight copy
    t.setVersion('v2');
    t.advance(500);
    expect(await t.read()).toBe('v1');
    expect(t.copies()).toBe(1);
  });

  it('answers a stale read at once and refreshes behind it', async () => {
    const t = setup();
    await t.read();
    t.setVersion('v2');
    t.advance(2_000);
    const release = t.hold();
    expect(await t.read()).toBe('v1'); // not blocked behind the held copy
    expect(t.copies()).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await t.read()).toBe('v2');
    expect(t.copies()).toBe(2);
  });

  it('blocks once a copy is too old to show, and recopies a replaced world', async () => {
    const t = setup();
    await t.read();
    t.setVersion('v2');
    t.advance(20_000);
    expect(await t.read()).toBe('v2');
    t.setVersion('v3');
    expect(await t.read('w:2')).toBe('v3'); // a new world generation never sees its predecessor
    expect(t.copies()).toBe(3);
  });

  it('forgets a copy when invalidated (a write landed)', async () => {
    const t = setup();
    await t.read();
    t.setVersion('v2');
    t.cache.invalidate('task');
    expect(await t.read()).toBe('v2');
  });

  it('does not cache a copy that raced a write', async () => {
    const t = setup();
    const release = t.hold();
    const racing = t.read();
    t.cache.invalidate('task');
    t.setVersion('v2');
    release();
    expect(await racing).toBe('v1');
    expect(await t.read()).toBe('v2');
  });

  it('reports a failed first copy and retries on the next read', async () => {
    const t = setup();
    let fail = true;
    const copy = async (root: string) => {
      if (fail) throw new Error('sandbox unavailable');
      fs.writeFileSync(path.join(root, 'page.md'), 'ok');
    };
    await expect(t.cache.read('other', 'w:1', copy)).rejects.toThrow('sandbox unavailable');
    fail = false;
    expect(fs.readFileSync(path.join(await t.cache.read('other', 'w:1', copy), 'page.md'), 'utf8')).toBe('ok');
  });
});
