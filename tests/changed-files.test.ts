// tavya's own files (.karmax-injection) are never a task's changed files, and
// every view shows one count (wiki incidents/lessons: "Changed files listed
// .karmax-injection", the organization CEO task: 645 in the summary, 327 in
// the rail, almost all of them Chrome's profile).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import { resolveWidgets } from '../src/contrib/widgets.js';
import { manifest } from '../src/contrib/manifests.js';
import {
  cleanedReviewFiles, isGitDerivedReviewSummary, isPlatformPath, withChangedFiles, withoutPlatformPaths,
} from '../src/domain/changed-files.js';

/** What tavya puts in a world without a repository (the CEO task's ~800 files). */
async function writePlatformFiles(world: { writeFile(p: string, c: string): Promise<void> }, prefix = '') {
  for (let i = 0; i < 40; i++) await world.writeFile(`${prefix}.karmax-injection/agent/browser-profile/Default/Cache/f_${i}`, 'x');
  await world.writeFile(`${prefix}.karmax-injection/agent/claude/projects/memory/MEMORY.md`, '# memory');
  await world.writeFile(`${prefix}.karmax-injection/ballast`, 'b');
  await world.writeFile(`${prefix}.karmax-injection/work-env`, 'env');
  await world.writeFile(`${prefix}.karmax-injection/jobs/j1/log`, 'log');
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function memoryFixture(taskId: string) {
  const store = await Store.create(':memory:');
  cleanup.push(() => store.close());
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId, base: 'main' });
  cleanup.push(() => world.destroy());
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  return { core, world };
}

/** The rail's "Changed files" group, as the console draws it from the widget
 * descriptors the gateway resolves (the same code as web/app.js). */
function railCount(view: unknown): number | null {
  const contribution = manifest('software-dev')!.ui!
    .find((slot) => slot.title === 'Changed files')!;
  const groups = [{ workflow: 'software-dev', title: 'Changed files', widgets: resolveWidgets(contribution.widgets, view) }];
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const start = src.indexOf('function renderWidgetGroups(');
  const code = src.slice(start, src.indexOf('\n}\n', start) + 3);
  const context = vm.createContext({ S: {}, esc: String, renderWidget: () => '' });
  vm.runInContext(code, context);
  const html = (context.renderWidgetGroups as (groups: unknown) => string)(groups);
  if (!html) return null;
  return Number(/<span class="rail-count">(\d+)<\/span>/.exec(html)?.[1]);
}

/** The count a summary states, if it is one buildReview wrote. */
const summaryCount = (summary: string) => Number(/^(\d+) file\(s\)/.exec(summary)?.[1] ?? (summary === 'No file changes detected.' ? 0 : NaN));

describe('platform paths', () => {
  it('are .karmax-injection at the root and in any checkout, with or without the (new) marker', () => {
    expect(isPlatformPath('.karmax-injection/ballast')).toBe(true);
    expect(isPlatformPath('.karmax-injection/agent/browser-profile/Default/Cookies (new)')).toBe(true);
    expect(isPlatformPath('karmax/.karmax-injection/work-env (new)')).toBe(true);
    expect(isPlatformPath('src/karmax-injection.ts')).toBe(false);
    expect(isPlatformPath('.karmax-injection-notes.md (new)')).toBe(false);
    expect(withoutPlatformPaths(['a.md (new)', '.karmax-injection/x (new)'])).toEqual(['a.md (new)']);
  });
});

describe('a world with no repository', () => {
  it('shows 0 changed files when only tavya wrote there', async () => {
    const { core, world } = await memoryFixture('repo-less-empty');
    await writePlatformFiles(world);
    const review = await core.buildReview(world.handle, 'main');
    expect(review).toEqual({ summary: 'No file changes detected.', changedFiles: [], changedFileCount: 0 });
    // Nothing for the rail to show either.
    expect(railCount({ reviewInfo: withChangedFiles(undefined, review) })).toBeNull();
  });

  it('lists only the agent\'s own files beside tavya\'s', async () => {
    const { core, world } = await memoryFixture('repo-less-real');
    await writePlatformFiles(world);
    await world.writeFile('report.md', '# report');
    await world.writeFile('out/chart.png', 'png');
    const review = await core.buildReview(world.handle, 'main');
    expect(review.changedFiles.sort()).toEqual(['out/chart.png (new)', 'report.md (new)']);
    expect(review.changedFileCount).toBe(2);
    expect(review.summary).toBe('2 file(s) in the task workspace.');
  });

  it('filters a provider that still lists .karmax-injection (one source for every view)', async () => {
    const { core, world } = await memoryFixture('repo-less-provider');
    vi.spyOn(world, 'listFiles').mockResolvedValue(['notes.md', '.karmax-injection/ballast', '.karmax-injection/agent/browser-profile/Local State']);
    const review = await core.buildReview(world.handle, 'main');
    expect(review.changedFiles).toEqual(['notes.md (new)']);
    expect(review.changedFileCount).toBe(1);
  });
});

describe('one count', () => {
  it('the summary and the rail agree when the list is shortened', async () => {
    const { core, world } = await memoryFixture('count-agree');
    // Long names, like Chrome's profile paths: the 64 KiB list budget keeps
    // fewer than all of them (the CEO task: 645 counted, 327 listed).
    const files = Array.from({ length: 645 }, (_, i) => `renders/${'scene-'.repeat(20)}${i}.mp4`);
    vi.spyOn(world, 'listFiles').mockResolvedValue([...files, '.karmax-injection/ballast']);
    const review = await core.buildReview(world.handle, 'main');
    expect(review.changedFiles.length).toBeLessThan(645);
    expect(review.changedFileCount).toBe(645);
    const reviewInfo = withChangedFiles(undefined, review);
    expect(summaryCount(reviewInfo.summary!)).toBe(645);
    expect(railCount({ reviewInfo })).toBe(645);
  });

  it('a rebuilt list replaces a summary that only counted files, never one the agent wrote', () => {
    const first = withChangedFiles(undefined, { summary: '645 file(s) in the task workspace. Showing 327; inspect the workspace for the full list.', changedFiles: ['a'], changedFileCount: 645 });
    const rebuilt = withChangedFiles(first, { summary: '3 file(s) changed.', changedFiles: ['a', 'b', 'c'], changedFileCount: 3 });
    expect(rebuilt).toMatchObject({ summary: '3 file(s) changed.', changedFileCount: 3 });
    expect(railCount({ reviewInfo: rebuilt })).toBe(summaryCount(rebuilt.summary!));
    const written = withChangedFiles({ summary: 'Blocked: needs a key.' }, { summary: '1 file(s) changed.', changedFiles: ['a'], changedFileCount: 1 });
    expect(written.summary).toBe('Blocked: needs a key.');
  });

  it('a stored view from before the fix loses its platform paths and its stale count', () => {
    const stored = {
      summary: '645 file(s) in the task workspace. Showing 327; inspect the workspace for the full list.',
      changedFiles: ['.karmax-injection/ballast (new)', '.karmax-injection/agent/browser-profile/Cookies (new)'],
    };
    const cleaned = cleanedReviewFiles(stored)!;
    expect(cleaned.changedFiles).toEqual([]);
    expect(cleaned.summary).toBeUndefined();
    expect(railCount({ reviewInfo: cleaned })).toBeNull();
    const clean = { summary: 'Done.', changedFiles: ['a.md'] };
    expect(cleanedReviewFiles(clean)).toBe(clean);
  });

  it('the conversation leaves a count-only summary to the rail, and the console agrees with the server on which those are', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const literal = /const COUNT_ONLY_SUMMARY = (\/.*\/);\n/.exec(src)![1]!;
    const countOnly = vm.runInNewContext(literal) as RegExp;
    for (const summary of ['3 file(s) changed.', '645 file(s) in the task workspace. Showing 327; inspect the workspace for the full list.',
      '1200 file(s) changed. Showing 1000; inspect the checkouts for the full list.'])
      expect([countOnly.test(summary), isGitDerivedReviewSummary(summary)]).toEqual([true, true]);
    for (const summary of ['Blocked: needs a key.', '3 file(s) changed.\n\nCompleted; no repository merge required.'])
      expect([countOnly.test(summary), isGitDerivedReviewSummary(summary)]).toEqual([false, false]);
  });
});

describe('a world with checkouts', () => {
  it('never lists a checkout\'s .karmax-injection, even when Git does not ignore it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-changed-files-'));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    await gitOrThrow(root, ['init', '-qb', 'main', source]);
    await ensureIdentity(source);
    await gitOrThrow(source, ['commit', '--allow-empty', '-qm', 'base']);
    const store = await Store.create(':memory:');
    cleanup.push(() => store.close());
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(root, 'worlds')));
    const world = await worlds.create('worktree', { taskId: 'checkout', repo: source, base: 'main' });
    cleanup.push(() => world.destroy());
    // A restored world has lost .git/info/exclude: Git would report these.
    fs.rmSync(path.join(world.handle.root, '.karmax-injection'), { recursive: true, force: true });
    await writePlatformFiles(world);
    await world.writeFile('src/feature.ts', 'export {}\n');
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const review = await core.buildReview(world.handle, 'main');
    expect(review.changedFiles).toEqual(['src/feature.ts (new)']);
    expect(review.changedFileCount).toBe(1);
    expect(await world.listFiles()).not.toContainEqual(expect.stringContaining('.karmax-injection'));
  });
});
