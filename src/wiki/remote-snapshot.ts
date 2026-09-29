import fs from 'node:fs';
import path from 'node:path';
import type { World } from '../world/types.js';
import { forEachConcurrent } from '../util/async-batch.js';

/**
 * Host-side read copies of remote task worlds' project-wiki checkouts.
 *
 * A remote world's wiki lives in a sandbox, so reading it means resuming the
 * sandbox (often parked), copying every page over the provider API, and parking
 * it again. Doing that per request made browsing a task's wiki branch take many
 * seconds per click: the index and the page each paid the full round trip. One
 * copy now serves every read of the same world for a short window, and a
 * slightly older copy is served while a fresh one is fetched in the background,
 * so navigation is instant and the view still converges on the live checkout.
 * Writes never go through this cache; they snapshot fresh and invalidate it.
 */
export class RemoteWikiSnapshots {
  private readonly entries = new Map<string, {
    worldKey: string; root?: string; fetchedAt: number; pending?: Promise<string>;
  }>();
  private dir?: string;

  constructor(private readonly parent: string, private readonly options: {
    /** Served as-is, with no refresh. */
    freshMs?: number;
    /** Served while a refresh runs in the background; older copies block. */
    staleMs?: number;
    now?: () => number;
  } = {}) {}

  private get freshMs() { return this.options.freshMs ?? 15_000; }
  private get staleMs() { return this.options.staleMs ?? 10 * 60_000; }
  private now() { return (this.options.now ?? Date.now)(); }

  /** The host root of a readable copy of `taskId`'s wiki in world `worldKey`
   * (world id + generation: a recreated world never serves its predecessor's
   * copy). `copy` fills an empty directory from the live checkout. */
  async read(taskId: string, worldKey: string, copy: (root: string) => Promise<void>): Promise<string> {
    this.sweep();
    let entry = this.entries.get(taskId);
    if (entry && (entry.worldKey !== worldKey || (entry.root && !fs.existsSync(entry.root)))) {
      this.invalidate(taskId);
      entry = undefined;
    }
    const age = entry?.root ? this.now() - entry.fetchedAt : Infinity;
    if (entry?.root && age < this.freshMs) return entry.root;
    const refresh = entry?.pending ?? this.refresh(taskId, worldKey, copy);
    if (entry?.root && age < this.staleMs) {
      refresh.catch(() => { /* keep serving the older copy; the next blocking read reports it */ });
      return entry.root;
    }
    return refresh;
  }

  /** Forget a task's copy (after a write, or when its world changes). */
  invalidate(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    if (entry.root) this.retire(entry.root);
  }

  /** Delete a deleted task's copy now: nothing may read it any more. */
  remove(taskId: string): void {
    const entry = this.entries.get(taskId);
    this.entries.delete(taskId);
    if (entry?.root) fs.rmSync(entry.root, { recursive: true, force: true });
  }

  private refresh(taskId: string, worldKey: string, copy: (root: string) => Promise<void>): Promise<string> {
    const entry = this.entries.get(taskId) ?? { worldKey, fetchedAt: 0 };
    this.entries.set(taskId, entry);
    const startedAt = this.now();
    const pending = (async () => {
      const root = fs.mkdtempSync(path.join(this.directory(), 'w-'));
      try { await copy(root); }
      catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
      // Invalidated mid-copy (a write landed): answer this read, cache nothing.
      if (this.entries.get(taskId) !== entry) { this.retire(root); return root; }
      if (entry.root) this.retire(entry.root);
      entry.root = root;
      entry.fetchedAt = startedAt;
      return root;
    })();
    entry.pending = pending;
    pending.then(() => undefined, () => undefined).then(() => {
      if (entry.pending === pending) entry.pending = undefined;
      if (!entry.root && this.entries.get(taskId) === entry) this.entries.delete(taskId);
    });
    return pending;
  }

  private sweep(): void {
    const now = this.now();
    for (const [taskId, entry] of this.entries)
      if (entry.root && !entry.pending && now - entry.fetchedAt >= this.staleMs) this.invalidate(taskId);
  }

  /** A superseded copy may still be mid-read by a request that resolved it a
   * moment ago; remove it once any such read has long finished. */
  private retire(root: string): void {
    const timer = setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 60_000);
    timer.unref?.();
  }

  private directory(): string {
    if (this.dir && fs.existsSync(this.dir)) return this.dir;
    fs.mkdirSync(this.parent, { recursive: true });
    // Copies left by a previous process that crashed; nothing reads them.
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const name of fs.readdirSync(this.parent)) {
      const stale = path.join(this.parent, name);
      try { if (fs.statSync(stale).mtimeMs < dayAgo) fs.rmSync(stale, { recursive: true, force: true }); }
      catch { /* raced another cleanup */ }
    }
    this.dir = fs.mkdtempSync(path.join(this.parent, `${process.pid}-`));
    return this.dir;
  }
}

/** Copy the wiki checkout at `prefix` (relative to the world root; '' when the
 * wiki is the root) into `root`, without Git internals. Returns the relative
 * paths copied. Reads run concurrently: one sandbox round trip per file,
 * sequentially, was most of a remote wiki view's latency. */
export async function copyRemoteWiki(world: World, prefix: string, root: string): Promise<string[]> {
  const relative = (file: string) => prefix ? file.slice(prefix.length).replace(/^\/+/, '') : file;
  const files = (await world.listFiles())
    .filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}/`))
    .filter((file) => { const rel = relative(file); return rel && rel !== '.git' && !rel.startsWith('.git/'); });
  const base = path.resolve(root);
  await forEachConcurrent(files, async (file) => {
    const target = path.resolve(base, relative(file));
    if (!target.startsWith(`${base}${path.sep}`)) throw new Error('invalid file path in project wiki checkout');
    const content = await world.readFileBuffer(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }, 8);
  return files.map(relative);
}
