# Testing

```bash
npm test            # full suite (sequential, resource-capped)
npm run typecheck
npm run test:coverage   # same suite, instrumented; coverage dependency is installed by npm ci
```

## Coverage

`npm run test:coverage` is opt-in — instrumenting a run that already boots real
Temporal servers roughly doubles it. The config's `coverage.include` lists every
source module deliberately: a module with no tests at all shows up at 0% rather
than vanishing from the report, which is the gap worth seeing. Report lands in
`coverage/index.html`.

## Why tests are heavy (and how it's kept safe)

Most of karmax's behavior is only meaningful against the **real** durable engine,
so the integration tests don't mock Temporal — each integration test file boots
an actual `temporal server start-dev` process **and** a Temporal Worker (which
bundles the workflow code and runs a reusable-VM pool). Many integration files do this.

If those run **in parallel**, you get multiple Temporal servers and workers with
their thread pools at once, which can peg every core and exhaust RAM — enough to
freeze a laptop. The config prevents that:

- **`vitest.config.ts`** runs files **sequentially in a single process**
  (`fileParallelism: false`, `maxWorkers: 1`, `isolate: false`, `maxConcurrency: 1`), so at most
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
`ports`, `store`, `world`, `worktree-lock`, `merge`, `merge-wait`,
`coordinator-health`, `stage-transitions`, `security`, `mcp`, `overlays`,
`repo-path`, `deploy-edge`, `inbox`, `collaboration`, `web-regressions`.

These boot a Temporal dev server (heavier, one at a time):
`temporal`, `pipeline`, `workflows`, `gateway`, `autonomy`, `live-agent`.

Hosted deployments run on PostgreSQL. Store-level suites that cover tenancy,
billing or core store state run on both databases through
`tests/helpers/store-backends.ts` (`describe.each(storeBackends)`): SQLite
always, and PostgreSQL too when `KARMAX_TEST_POSTGRES_URL` is set, as it is on
every CI shard. Each PostgreSQL store gets a schema of its own, dropped when
its test ends. Locally:

```bash
KARMAX_TEST_POSTGRES_URL=postgres://user:password@127.0.0.1:5432/db npx vitest run tests/store.test.ts
```

Console UI tests exercise the real console: `tests/helpers/console-page.ts`
loads `web/` into Chromium with a scripted `/api`, so a test renders a
component with the console's own functions and then clicks, types and reads
the DOM and the requests made. (Chromium comes from `npx playwright install
chromium`, as in CI.) Do not assert on the text of `web/` or `src/` files:
`tests/source-text-ratchet.test.ts` fails on a new such assertion and lists
the files that still have them.

## CI

CI (`.github/workflows/ci.yml`) splits the suite across parallel runners with
Vitest's `--shard`; each runner still runs its files one at a time. The
required `typecheck + tests` check passes only when the typecheck and every
shard pass. To reproduce a failing shard, run the same slice locally:

```bash
npx vitest run --shard=2/5
```

A few files take minutes while most take under a second, so shards are
balanced by each file's measured duration (`tests/durations.json`, via
`tests/helpers/duration-sequencer.ts`) rather than by file count. A new file
counts as a typical one until measured. After larger test changes, refresh the
measurements from a green CI run:

```bash
gh run view <run-id> --log | npm run test:durations
```

No shard can finish faster than the slowest single file (`pipeline.test.ts`,
about 6.5 minutes in CI). Adding a number to the `test` job's `shard` list helps
only while the shards are well above that; past it, split the slowest file.

## The live-agent test

`tests/live-agent.test.ts`, `tests/cloud-live.test.ts`, and `tests/github-live.test.ts`
require `KARMAX_RUN_LIVE=1` in addition to their credentials. They spend model or
provider credit or write to a GitHub fixture, so ordinary `npm test` never runs them:

```bash
KARMAX_RUN_LIVE=1 OPENAI_API_KEY=… npx vitest run tests/live-agent.test.ts
```

## Docker test

`tests/container.test.ts` and `tests/services-docker.test.ts` use Docker. An
enabled suite fails if Docker is unavailable; explicitly skip them with
`KARMAX_SKIP_DOCKER=1` on a machine without a Docker daemon.

## Cleaning up stray processes

If a run is interrupted (or you `kill` the app by port instead of Ctrl-C), a
Temporal dev server child can be orphaned and keep using RAM. Find and clear them:

```bash
pgrep -af 'temporal server start-dev'    # list any orphans
ps -fp <pid>                             # identify the owning test before stopping it
```

Do not blanket-kill Temporal processes or run `npm run reset` on an active app:
the shared dev server survives normal Ctrl-C shutdown and is reused by the next boot.

## Agent MCP connections

Run these sequentially, including separately from typechecking. The ordinary
suite covers scoped CRUD and authorization, selection inheritance, registry
validation, OAuth state/refresh races, SSRF/DNS pinning, HTTP and SSE protocol
exchanges, hostile subprocesses, cancellation, lease revocation, cleanup, and
Claude/Codex API tool loops. The API-loop tests use local model-protocol fixtures;
they do not spend model tokens. `mcp-workflow.test.ts` additionally runs a real
Temporal task through Review and checks secret exclusion from workflow history.

```bash
TEMPORAL_CLI=/path/to/temporal npx vitest run tests/mcp*.test.ts
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

## Daytona

Unit and SDK-contract regressions (no account or cloud credit required):

```bash
npx vitest run tests/daytona-world.test.ts tests/daytona-sdk.test.ts tests/provision-git.test.ts
```

With `DAYTONA_API_KEY` supplied securely in the environment, run these sequentially:

```bash
npx vitest run tests/daytona-live.test.ts tests/daytona-environment-live.test.ts
KARMAX_DAYTONA_LIVE_BUILD=1 npx vitest run tests/daytona-environment-live.test.ts
KARMAX_DAYTONA_LIVE_WORKFLOW=1 npx vitest run tests/daytona-workflow-live.test.ts
KARMAX_MCP_LIVE_WORLD=daytona npx vitest run tests/mcp-deployment.test.ts
```

These create billable sandboxes and delete their own resources in `finally`.
Use a dedicated `KARMAX_HOME` to isolate their sandbox ownership labels. The
workflow test boots its own real Temporal server and uses a deterministic mock
model; it does not connect to a running Karmax service. The lifecycle suite also
initializes the actual native Codex app-server over a remote PTY, without a model
call. Coverage includes the API-key-only default, repository provisioning and
credential cleanup, files/stdin, background processes, terminals, signed HTTP
previews, desktop viewers, archive/cold restore, MCP credential scope and cleanup,
image sizing, and building/using a setup snapshot.

Daytona snapshots carry their own CPU/memory allocation; overrides apply to OCI
image creation. The adapter reports differing snapshot allocation in world
warnings instead of sending an invalid resource override. Custom network rules
require an eligible Daytona account tier. On lower tiers, the network test checks
an actionable rejection and absence of leaked sandboxes; it does not claim to
have verified allowlist enforcement. The other live tests use unrestricted
sandbox networking, still subject to Daytona account-level restrictions.

The setup-snapshot build test needs `write:snapshots` and `delete:snapshots` on
the Daytona API key and an explicit `KARMAX_DAYTONA_LIVE_BUILD=1`. Sandbox-only
keys can exercise every other live test. Missing snapshot permission is tested
as an actionable error at the SDK boundary.

None of those tests run a real model. To prove a subscription Claude or Codex
turn end to end in a remote sandbox — startup, Karmax platform tools, the
browser MCP and a resumed session — run the smoke script against an existing,
configured installation (it resolves the provider key and subscription login from
that installation's database and vault, and deletes its sandbox afterwards):

```bash
KARMAX_LIVE_TASK_ID=<existing task id> KARMAX_LIVE_WORLD_PROVIDER=daytona \
  KARMAX_LIVE_AGENT_PROVIDER=claude KARMAX_LIVE_BROWSER_URL=https://github.com \
  npx tsx scripts/live-cloud-subscription.ts
```

`KARMAX_LIVE_WORLD_PROVIDER` is `e2b` (default) or `daytona`. Lower Daytona
tiers only reach allowlisted hosts, so point `KARMAX_LIVE_BROWSER_URL` at one
(the default, example.com, is blocked there). Mock-model tests could not catch
tasks 361/362: Daytona typed the ~9 KiB Claude launcher into a terminal whose
kernel line buffer keeps only 4 KiB, and the agent never started.
