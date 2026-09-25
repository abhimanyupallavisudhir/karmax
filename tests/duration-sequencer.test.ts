import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import config from '../vitest.config.js';
import {
  DurationSequencer, mergeDurations, parseReporterDurations, planShards, readDurations,
} from './helpers/duration-sequencer.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (plan: string[][], weights: Record<string, number>) =>
  plan.map((shard) => shard.reduce((sum, file) => sum + (weights[file] ?? 0), 0));

describe('duration-balanced test shards', () => {
  it('places every file in exactly one shard, independent of input order', () => {
    const files = Array.from({ length: 23 }, (_, i) => `tests/f${i}.test.ts`);
    const weights = Object.fromEntries(files.map((file, i) => [file, (i * 7) % 11]));
    for (let count = 1; count <= 8; count++) {
      const plan = planShards(files, weights, count);
      expect(plan).toHaveLength(count);
      expect(plan.flat().sort()).toEqual([...files].sort());
      expect(planShards([...files].reverse(), weights, count)).toEqual(plan);
    }
  });

  it('packs the longest files first onto the least-loaded shard', () => {
    // An even split by count would pair the long file with another one.
    const weights = { 'a.test.ts': 9, 'b.test.ts': 5, 'c.test.ts': 4 };
    const plan = planShards(Object.keys(weights), weights, 2);
    expect(plan).toEqual([['a.test.ts'], ['b.test.ts', 'c.test.ts']]);
    expect(load(plan, weights)).toEqual([9, 9]);
  });

  it('charges a file without a measurement the median measured duration', () => {
    // Weighing the new file 6 (not 0) is what pairs it with b rather than c.
    const weights = { 'a.test.ts': 1, 'b.test.ts': 6, 'c.test.ts': 6 };
    const plan = planShards([...Object.keys(weights), 'new.test.ts'], weights, 2);
    expect(plan.map((shard) => [...shard].sort())).toEqual([['b.test.ts', 'new.test.ts'], ['a.test.ts', 'c.test.ts']]);
  });

  it('divides the files evenly by count when nothing has been measured', () => {
    const files = Array.from({ length: 10 }, (_, i) => `tests/f${i}.test.ts`);
    expect(planShards(files, {}, 3).map((shard) => shard.length).sort()).toEqual([3, 3, 4]);
  });

  it('balances the CI shards through the Vitest sequencer and the committed durations', async () => {
    expect(config.test?.sequence?.sequencer).toBe(DurationSequencer);
    const durations = readDurations(repoRoot);
    const files = Object.keys(durations).filter((file) => fs.existsSync(path.join(repoRoot, file)));
    // The measurements must describe the suite as it exists, not a renamed one.
    expect(files.length).toBeGreaterThan(Object.keys(durations).length * 0.9);
    const ci = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const count: number = ci.jobs.test.strategy.matrix.shard.length;
    const picked = await Promise.all(Array.from({ length: count }, async (_, i) => {
      const sequencer = new DurationSequencer({ config: { root: repoRoot, shard: { index: i + 1, count } } } as any);
      const shard = await sequencer.shard(files.map((file) => ({ moduleId: path.join(repoRoot, file) })) as any);
      return shard.map((spec: any) => path.relative(repoRoot, spec.moduleId));
    }));
    expect(picked.flat().sort()).toEqual([...files].sort());
    const loads = load(picked, durations);
    const total = loads.reduce((sum, value) => sum + value, 0);
    const floor = Math.max(total / count, ...Object.values(durations));
    expect(Math.max(...loads)).toBeLessThan(floor * 1.05);
  });
});

describe('recorded test durations', () => {
  it('reads per-file durations from Vitest reporter output in a CI log', () => {
    const log = [
      '2026-09-24T21:15:36.0639705Z  ✓ tests/platform-surface.test.ts (4 tests) 104ms',
      '2026-09-24T21:15:40.9390448Z      ✓ includes every page of task history  3501ms',
      'tests (2/5)\tRun npm test\t2026-09-24T21:15:41.0197738Z  ↓ tests/mcp-deployment.test.ts (2 tests | 2 skipped)',
      ' ❯ src/world/merge.test.ts (12 tests | 1 failed) 2400ms',
      ' ✓ tests/git-pass-interop.test.ts (1 test) 10190ms',
      ' ✓ tests/git-pass-interop.test.ts (1 test) 11067ms',
      'stderr | tests/postgres.test.ts > PostgreSQL cutover > imports',
    ].join('\n');
    expect(parseReporterDurations(log)).toEqual({
      'tests/platform-surface.test.ts': 0.1,
      'tests/mcp-deployment.test.ts': 0,
      'src/world/merge.test.ts': 2.4,
      // The gopass compatibility step runs this file a second time.
      'tests/git-pass-interop.test.ts': 11.1,
    });
  });

  it('updates measured files, keeps the rest, and drops deleted ones', () => {
    const exists = (file: string) => file !== 'tests/deleted.test.ts';
    const merged = mergeDurations(
      { 'tests/kept.test.ts': 4, 'tests/changed.test.ts': 9, 'tests/deleted.test.ts': 2 },
      { 'tests/changed.test.ts': 12.5, 'tests/new.test.ts': 0.3 },
      exists,
    );
    expect(merged).toEqual({ 'tests/changed.test.ts': 12.5, 'tests/kept.test.ts': 4, 'tests/new.test.ts': 0.3 });
    expect(Object.keys(merged)).toEqual([...Object.keys(merged)].sort());
  });
});
