import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
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
