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

## Agent MCP connections

Run these sequentially, including separately from typechecking. The ordinary
suite covers scoped CRUD and authorization, selection inheritance, registry
validation, OAuth state/refresh races, SSRF/DNS pinning, HTTP and SSE protocol
exchanges, hostile subprocesses, cancellation, lease revocation, cleanup, and
Claude/Codex API tool loops. The API-loop tests use local model-protocol fixtures;
they do not spend model tokens. `mcp-workflow.test.ts` additionally runs a real
Temporal task through Review and checks secret exclusion from workflow history.

```bash
TEMPORAL_CLI=/path/to/temporal KARMAX_SKIP_LIVE=1 npx vitest run tests/mcp*.test.ts
npm run typecheck
```

Additional checks deliberately require explicit infrastructure:

```bash
# New isolated tab in a test Chrome exposing CDP; real settings UI and gateway.
KARMAX_MCP_BROWSER_CDP=http://127.0.0.1:9222 npx vitest run tests/mcp-browser.test.ts
# Installed native Codex; isolated configuration, no login or model calls.
KARMAX_MCP_CODEX_BINARY=/path/to/codex npx vitest run tests/mcp-native-codex.test.ts
# Live Official Registry import followed by Microsoft Learn tool invocation.
KARMAX_MCP_LIVE_NETWORK=1 npx vitest run tests/mcp-deployment.test.ts
# Creates and destroys a real task environment (cloud providers incur charges).
KARMAX_MCP_LIVE_WORLD=container npx vitest run tests/mcp-deployment.test.ts
KARMAX_MCP_LIVE_WORLD=e2b npx vitest run tests/mcp-deployment.test.ts
KARMAX_MCP_LIVE_WORLD=daytona npx vitest run tests/mcp-deployment.test.ts
```

Cloud checks require their respective `E2B_API_KEY` or `DAYTONA_API_KEY`.
An explicitly requested deployment fails if its infrastructure is missing;
unrequested deployments are skipped. A skipped check is not verification.
OAuth fixtures do not establish compatibility with every real identity provider,
and native tool discovery does not establish successful live model tool use.
These checks reduce risk; they do not certify arbitrary third-party servers or
prove the absence of vulnerabilities.

### Verification recorded 2026-09-16

- MCP checks: **123 passed**, including a real browser, native Codex startup,
  live Registry → Microsoft Learn tool call, and a real Temporal task. The one
  deployment smoke test was skipped: Docker/E2B/Daytona were unavailable.
- Repository regression: the initial single-worker run reached 1,536 passing
  tests before an unexpected worker exit. The remaining files and affected
  tests were run in sequential batches of 20, with targeted reruns afterward.
  The batches recorded 964 passes; final targeted verification recorded 25
  passes. These counts overlap and must not be added as unique coverage.
- Every observed assertion failure was resolved and passed on rerun: missing
  local native dependencies, an existing lineage fixture that modified host
  Node symlinks, and omitted MCP routes in the API discovery catalog.
- No live cloud sandbox, real-account OAuth consent, or paid model invocation
  was verified. OAuth and model API interaction tests use protocol fixtures.

The broad run was not one uninterrupted green suite. Use the commands above to
reproduce the relevant checks; preserve per-run results and explicit skips.
