# Testing

```bash
npm test            # full suite (sequential, resource-capped)
npm run typecheck
npm run test:coverage   # same suite, instrumented (needs `npm i` once for @vitest/coverage-v8)
```

## Coverage

`npm run test:coverage` is opt-in — instrumenting a run that already boots real
Temporal servers roughly doubles it. The config sets `all: true` deliberately: a
module with no tests at all shows up at 0% rather than vanishing from the report,
which is the gap worth seeing. Report lands in `coverage/index.html`.

## Why tests are heavy (and how it's kept safe)

Most of karmax's behavior is only meaningful against the **real** durable engine,
so the integration tests don't mock Temporal — each integration test file boots
an actual `temporal server start-dev` process **and** a Temporal Worker (which
bundles the workflow code and runs a reusable-VM pool). Six test files do this.

If those run **in parallel**, you get six full Temporal servers + six workers +
their thread pools at once, which can peg every core and exhaust RAM — enough to
freeze a laptop. The config prevents that:

- **`vitest.config.ts`** runs files **sequentially in a single process**
  (`fileParallelism: false`, `singleFork: true`, `maxConcurrency: 1`), so at most
  **one** Temporal server + worker is alive at a time.
- **The Worker is resource-capped** (`src/temporal/worker.ts`):
  `maxCachedWorkflows`, `maxConcurrentWorkflowTaskExecutions`, and
  `maxConcurrentActivityTaskExecutions` are kept small so a single worker stays
  light. Override with `KARMAX_MAX_CACHED_WORKFLOWS`, `KARMAX_MAX_WFT`,
  `KARMAX_MAX_ACT` if you want more throughput on a big machine.

**Do not** re-enable parallelism for the integration tests (don't pass
`--no-file-parallelism=false`, `--pool=threads`, or raise `maxConcurrency`) on a
memory-constrained machine — that is what makes the suite overwhelm a laptop.

## Running a subset (lightest option)

To iterate without booting many servers, run one file or one test:

```bash
npx vitest run tests/store.test.ts            # pure unit tests, no Temporal
npx vitest run tests/pipeline.test.ts         # one Temporal server for that file
npx vitest run tests/pipeline.test.ts -t "merge queue"
```

These files need **no** Temporal server (fast, cheap, run them freely):
`ports`, `store`, `world`, `merge`, `security`, `mcp`, `overlays`, `repo-path`.

These boot a Temporal dev server (heavier, one at a time):
`temporal`, `pipeline`, `workflows`, `gateway`, `autonomy`, `live-agent`.

## The live-agent test

`tests/live-agent.test.ts` is **skipped unless** a real key is present. It spends
real tokens, so it stays off by default:

```bash
OPENAI_API_KEY=…  npx vitest run tests/live-agent.test.ts
KARMAX_SKIP_LIVE=1 npm test     # force-skip even if a key is set
```

## Docker test

`tests/container.test.ts` uses Docker (image `node:22-slim`). It self-skips if
Docker isn't running; force-skip with `KARMAX_SKIP_DOCKER=1`.

## Cleaning up stray processes

If a run is interrupted (or you `kill` the app by port instead of Ctrl-C), a
Temporal dev server child can be orphaned and keep using RAM. Find and clear them:

```bash
pgrep -af 'temporal server start-dev'    # list any orphans
pkill -f 'temporal server start-dev'     # kill them
npm run reset                            # also wipes karmax's Temporal + local state
```

When stopping the app, prefer **Ctrl-C** (runs graceful shutdown, which kills the
Temporal child) over `fuser -k <port>` / `kill -9` (leaves the child orphaned).
