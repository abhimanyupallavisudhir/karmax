import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

let store: Store;
afterEach(async () => { vi.restoreAllMocks(); await store?.close(); });
async function fixture() {
  store = await Store.create(':memory:');
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: 'bounds', base: 'main' });
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  return { core, world };
}

it('RT-9 bounds script output in the activity result and marks truncation', async () => {
  const { core, world } = await fixture();
  vi.spyOn(world, 'exec').mockResolvedValue({ code: 9, stdout: 'x'.repeat(300_000), stderr: 'last diagnostic' });
  const result = await core.runScript({ taskId: 'bounds', worldHandle: world.handle, command: 'fixture' });
  expect(result.code).toBe(9);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024);
  expect(result.output).toContain('truncated');
  expect(result.output).toContain('last diagnostic');
});

it('RT-9/WD-20 bounds repository-free changed files and states the omission', async () => {
  const { core, world } = await fixture();
  vi.spyOn(world, 'listFiles').mockResolvedValue(Array.from({ length: 20_000 }, (_, i) => `${i}-${'x'.repeat(200)}`));
  const result = await core.buildReview(world.handle, 'main');
  expect(result.changedFiles.length).toBeLessThanOrEqual(1000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  expect(result.summary).toContain(`Showing ${result.changedFiles.length};`);
});

it('WD-27 lists in-world review paths verbatim, not C-quoted', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { WorktreeProvider } = await import('../src/world/worktree.js');
  const { ensureIdentity, gitOrThrow } = await import('../src/world/git.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'karmax-review-paths-'));
  try {
    const source = path.join(root, 'source');
    await gitOrThrow(root, ['init', '-qb', 'main', source]);
    await ensureIdentity(source);
    await gitOrThrow(source, ['commit', '--allow-empty', '-qm', 'base']);
    store = await Store.create(':memory:');
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(root, 'worlds')));
    const world = await worlds.create('worktree', { taskId: 'paths', repo: source, base: 'main' });
    // A container/E2B/Daytona world runs plain in-world git, whose default
    // core.quotePath renders these as "caf\303\251.md" and "line\nbreak.txt".
    await writeFile(path.join(world.handle.root, 'café.md'), 'tracked');
    await gitOrThrow(world.handle.root, ['add', '.']);
    await gitOrThrow(world.handle.root, ['commit', '-qm', 'work']);
    await writeFile(path.join(world.handle.root, 'line\nbreak.txt'), 'untracked');
    await writeFile(path.join(world.handle.root, 'naïve "quoted".txt'), 'untracked');
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const review = await core.buildReview(world.handle, 'main');
    expect(review.changedFiles.sort()).toEqual(['café.md', 'line\nbreak.txt (new)', 'naïve "quoted".txt (new)']);
    await world.destroy();
  } finally { await rm(root, { recursive: true, force: true }); }
});
