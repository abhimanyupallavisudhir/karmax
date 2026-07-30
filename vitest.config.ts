import { defineConfig } from 'vitest/config';

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
    // already inside a git subprocess still runs to completion. That is ~30ms on
    // an idle machine and tens of seconds on a loaded 2-core CI runner, so 60s
    // turned runner contention into a red build (a green suite — 1486 passed —
    // failed on "Hook timed out" in gateway.test.ts's afterAll). Generous, but
    // still bounded, so a genuinely wedged hook fails instead of hanging.
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
    // Coverage is opt-in (`npm run test:coverage`) because instrumenting a run
    // that already boots real Temporal servers is slow. `all: true` is the point
    // of measuring at all here: without it a module with zero tests is simply
    // absent from the report rather than shown at 0%, which is exactly the gap
    // that needs to be visible.
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/scripts/**'],
      reporter: ['text-summary', 'html'],
    },
  },
});
