import fs from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Seconds each test file took in CI, keyed by project-relative path. */
export type Durations = Record<string, number>;

/** Where the measured durations live, relative to the project root. Refresh
 *  it with `npm run test:durations` (see TESTING.md). */
export const DURATIONS_FILE = 'tests/durations.json';

export function readDurations(root: string): Durations {
  const file = path.join(root, DURATIONS_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Splits `files` into `count` shards of near-equal total duration: longest
 *  first, each onto the currently lightest shard. A file without a measurement
 *  weighs the median measured file; with no measurements at all every file
 *  weighs the same, which is an even split by count. Ties break on path and
 *  then shard number, so every CI runner computes the same plan. */
export function planShards(files: string[], durations: Durations, count: number): string[][] {
  const measured = Object.values(durations).sort((a, b) => a - b);
  const fallback = measured[Math.floor(measured.length / 2)] ?? 1;
  const weight = (file: string) => durations[file] ?? fallback;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], load: 0 }));
  const longestFirst = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of longestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.files.push(file);
    lightest.load += weight(file);
  }
  return shards.map((shard) => shard.files);
}

/** Vitest's own `--shard` divides files evenly by count. Here a few files take
 *  minutes while most take under a second, so a count split leaves one CI
 *  runner with several times another's work. This keeps Vitest's ordering
 *  within a shard but assigns the shards by measured duration. */
export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const relative = (spec: TestSpecification) => path.relative(root, spec.moduleId).split(path.sep).join('/');
    const plan = planShards([...new Set(files.map(relative))], readDurations(root), shard!.count);
    const mine = new Set(plan[shard!.index - 1]);
    return files.filter((spec) => mine.has(relative(spec)));
  }
}

/** Per-file durations from Vitest's default reporter output, such as a CI log:
 *  ` ✓ tests/example.test.ts (4 tests) 104ms`. Skipped files count as zero; a
 *  file reported twice keeps its longer run. */
export function parseReporterDurations(log: string): Durations {
  const fileResult = /\s[✓↓×❯]\s+(\S+\.test\.ts)\s+\(\d+ tests?[^)]*\)(?:\s+(\d+(?:\.\d+)?)(ms|s)\b)?/u;
  const durations: Durations = {};
  for (const line of log.split('\n')) {
    const match = fileResult.exec(line);
    if (!match) continue;
    const [, file, value, unit] = match as unknown as [string, string, string | undefined, string | undefined];
    const seconds = value ? Number(value) / (unit === 'ms' ? 1000 : 1) : 0;
    durations[file] = Math.max(durations[file] ?? 0, Math.round(seconds * 10) / 10);
  }
  return durations;
}

/** New measurements replace old ones, unmeasured files keep their last
 *  measurement, and files that no longer exist are dropped. Sorted by path so
 *  a refresh diffs cleanly. */
export function mergeDurations(existing: Durations, measured: Durations, exists: (file: string) => boolean): Durations {
  const merged = { ...existing, ...measured };
  return Object.fromEntries(Object.keys(merged).filter(exists).sort().map((file) => [file, merged[file]!]));
}
