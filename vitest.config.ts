import { defineConfig } from 'vitest/config';
import { DurationSequencer } from './tests/helpers/duration-sequencer.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests run mock agents inside the Vitest worker. Production
    // host pressure must not park them based on the CI runner's live RAM/load;
    // agent-slots.test.ts enables each gate explicitly when exercising it.
    env: {
      KARMAX_AGENT_MIN_FREE_MB: '0',
      KARMAX_AGENT_MAX_LOAD_FACTOR: '0',
    },
    testTimeout: 30_000,
    // A hook here is not "some setup" — for every integration file it boots or
    // tears down a REAL Temporal dev server, Worker and gateway. Teardown drains
    // the worker, and `shutdownGraceTime` only cancels in-flight activities: one
    // already inside a git subprocess still runs to completion. Measured ~1s
    // idle, ~30s with other Temporal servers competing for the CPU, so the old
    // 60s was tight enough that runner contention alone could fail a suite whose
    // 1486 tests had all passed.
    //
    // It is NOT only contention, though, and this budget is not a fix for the
    // other half: a teardown has also been seen to exceed even 180s, which is a
    // hang rather than slowness. That case is meant to be *identified* rather
    // than absorbed — `stopPhase()` in tests/helpers/harness.ts names the step
    // that is still running, so the CI log says which one instead of only
    // "Hook timed out".
    hookTimeout: 180_000,
    // Each integration test file boots a real Temporal dev server + Worker.
    // Run them ONE AT A TIME in a SINGLE process so we never have several heavy
    // servers/workers alive at once (which can exhaust RAM). See TESTING.md.
    pool: 'forks',
    // Vitest 4 replaces `singleFork` with this equivalent pair.
    maxWorkers: 1,
    isolate: false,
    fileParallelism: false,
    maxConcurrency: 1,
    // Make sure a hung integration test is killed rather than left holding a
    // Temporal server forever.
    teardownTimeout: 20_000,
    // CI divides the files between runners with `--shard`. Balance the shards
    // by each file's measured duration (tests/durations.json), not by count.
    sequence: { sequencer: DurationSequencer },
    // Coverage is opt-in (`npm run test:coverage`) because instrumenting a run
    // that already boots real Temporal servers is slow. `include` is the point
    // of measuring at all here: without it a module with zero tests is simply
    // absent from the report rather than shown at 0%, which is exactly the gap
    // that needs to be visible.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/scripts/**'],
      reporter: ['text-summary', 'html'],
    },
  },
});
