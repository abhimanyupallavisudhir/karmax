# Control-plane load test

Finds where tavya's control plane breaks as customers are added. It boots a
disposable copy of a revision on a cloud VM sized like tavya.io, ramps synthetic
tenants against it through the public HTTPS edge until a limit is crossed, and
tears everything down. **It never touches production**, which orchestrates
every task, including the one running this.

```bash
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=eu-central-1
benchmarks/load/run.sh --ref origin/master --label baseline        # ~1.5–2.5 h, a few dollars
node --experimental-strip-types benchmarks/load/report.ts benchmarks/results/load-<label>-<date> \
  --compare benchmarks/results/load-<other>-<date>                  # side by side
benchmarks/load/cloud.sh list                                       # anything left running?
benchmarks/load/cloud.sh sweep [RUN_ID]                             # delete it
```

Run it as a durable job (`start_job`) from a task: it outlives a turn. Results
(one directory per run) go to `benchmarks/results/load-<label>-<date>/`:
`report.md` (per-step table and the first wall), `summary.json`, `steps.jsonl`
(the driver), `raw/samples.jsonl.gz` (the collector), `raw/probe.tgz` (process
heap), `raw/app.log.gz`, `logs/`, `cost.json`. Findings are summarised in the
wiki (`ops/performance-history`, risks in `planned/managed-infrastructure`).

## What runs where

| VM | Size | Runs |
| --- | --- | --- |
| system under test | c7i.xlarge, 4 vCPU / 8 GB (tavya.io: 4 vCPU / 8 GB VPS) | the revision's own `deploy/karmax up`: hosted mode, PostgreSQL, Temporal, the app with its process-mode worker, Caddy, with the compose file's memory caps (app 4 GB, Temporal 2 GB, PostgreSQL 768 MB, Caddy 512 MB); `collector.ts` |
| world | c7i.2xlarge, 8 vCPU / 16 GB | the E2B stand-in (`scripts/rehearsal/fake-e2b.ts`, real `envd` per sandbox container), `driver.ts` |

Nothing that is not tavya shares the system under test's CPU or memory except
the collector (one sample every 5 s). The harness (this directory and
`scripts/rehearsal/`) always comes from the checkout running `run.sh`, so an
older revision is measured exactly like a newer one.

What the system under test gets beyond `deploy/karmax up`, all in
`sut-setup.sh`:

- **Edge certificate**: a self-signed certificate for `loadtest.invalid` seeded
  into Caddy's storage, as the upgrade rehearsal does; the load generator trusts it.
- **Per-tenant edge budgets**: the Caddyfile's rate-limit keys become
  `{remote.host}-{header.X-Load-Client}`. Every synthetic tenant arrives from one
  address; real customers arrive from their own, so each tenant gets one
  customer's budget (600 requests/min, 10 signups/h, 30 sign-ins/min). The
  limiter still runs for every request. 429s are counted separately, never as
  errors.
- `compose.override.yml`: `E2B_API_URL`/`E2B_SANDBOX_URL` point the E2B SDK at
  the stand-in; `NODE_OPTIONS=--import=/loadtest/probe.mjs` (appended to whatever
  the release sets) makes the gateway and the worker write their own heap,
  event-loop delay and GC time every 5 s; the Temporal server exports Prometheus
  metrics on `127.0.0.1:8000`.

## The synthetic tenants (`driver.ts`)

A tenant is one organization: a person who signs up through `/api/signup` and
uses their personal organization; every 4th tenant is a team (the installation
grants it the Team plan, two more people sign up and are added as developers).
Each organization connects E2B (the stand-in), makes the mock agent its Do
agent, and gets two projects: `App`, where tasks run, and `Data`, holding a
`volume@1` resource. (Resources stay out of `App` because tasks there would
restore them into every world, which production does through the Cloudflare
resource edge, not through the VPS.)

Every person keeps two websockets open (one for everything, one watching the
`App` project) and acts every ~20 s (exponential think time):

- 40 % browse: session, organizations, the task list, one task, its conversation and events;
- 50 % work: create a task (if they have fewer than 2 in progress), else act on
  one at Review: follow up (50 %, back to Do), approve (30 %) or cancel (20 %);
- 10 % save a resource revision (3 × 48 KiB, owners only — it needs project maintainer).

A task's turn is a mock-agent script that does what an agent does through the
world: a shell command in the sandbox, a file write, a 10–40 s wait, another
command, review info. 20 % of tasks are abandoned at Review and stay open, so
open workflows accumulate with time as they do in production (RT-35: ~127
running workflows from one person). A tenant here is a **concurrently active**
customer; real customers are idle most of the day, so N tenants here stand for
many more signed-up ones.

Tenants are added in steps (default 4, 8, 16, 32, 64, 96, 128, 192, 256, 384,
512); each step first sets up its new tenants, then holds everyone for
`--hold` seconds (default 300). The steady window of the step is what is
judged. The driver stops after the first step that crosses a limit:

| limit | default |
| --- | --- |
| errors (5xx, network errors, timeouts) | > 1 % of requests |
| API latency, all routes | p95 > 2 s |
| event lag (event's `ts` → received on the websocket) | p95 > 5 s |
| turn overhead (Review reached − created − scripted agent time) | p50 > 60 s |
| tasks failed or stuck > 10 min | > 2 % |
| websocket refusals and drops | > 1 % of opens |
| tenant setup failures | > 5 % of the step's new tenants |
| readiness check | any failure |

Override any of them with `-- --max-api-p95 3000` etc. (see `driver.ts`).

## What is recorded per step

| measure | source |
| --- | --- |
| API latency p50/p95/p99 overall and per route, errors, 429s | driver |
| event-stream lag p50/p95/p99, websocket connects/drops | driver |
| turn total and control-plane overhead, approve→done, cancel→cancelled | driver (from `view.updated` events) |
| gateway and worker heap used / limit, RSS, event-loop delay, GC share | `probe.mjs` in each process |
| container CPU and memory, restarts, OOM kills; host CPU (incl. steal), memory | collector: `docker stats`, `/proc` |
| PostgreSQL connections by database/role/state, lock waiters, waiters on the global Store lock (`pg_advisory_xact_lock`) and the longest wait, commit rate | collector: `pg_stat_activity`, `pg_locks` |
| the app's own `/api/metrics` (pool gauges, any lock-wait metric the release exports) | collector |
| Temporal task-queue backlog count and age, running workflows, server matching/persistence latency histograms | collector: `temporal task-queue describe`, `workflow count`, server Prometheus |
| sandboxes by state | driver, from the stand-in |

## Fidelity, and what it does not measure

- **Worlds**: the stand-in creates a container per sandbox and runs E2B's own
  `envd` in it, so the worker does the same file and process round trips it
  does against E2B, plus `--rtt` (default 50 ms) of `tc netem` delay on every
  answer. Pausing stops the container (`--pause-mode stop`), so files survive and
  processes do not; resuming a real E2B sandbox keeps its processes. Creation
  takes ~1 s against E2B's ~0.6 s.
- **Agents**: the mock agent runs in the worker; real Claude/Codex turns run in
  the sandbox and stream far more output through the worker. Turn overhead here
  is the control plane's own share, not a real turn's.
- **CPU**: an EC2 c7i vCPU is a hyperthread of a recent Xeon; the one.com VPS's
  vCPUs are of unknown generation and may be shared. Treat absolute numbers as
  ±30 %; compare revisions on the same harness.
- Not covered: GitHub (no repositories), previews, payments, email, the
  Cloudflare resource edge, backups running during load.

## AWS account

A dedicated IAM user (`tavya-loadtest`, no console access) whose only
permission is the inline policy [`iam-policy.json`](iam-policy.json): EC2 in
eu-central-1, where it may launch, change and delete **only resources tagged
`Project=tavya-loadtest`**. It can read but not touch anything else in the
account, so it is safe in an account that runs other things. Its access key
lives in the vault as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

Safety: before creating anything `run.sh` probes the key (`cloud.sh
verify-scope`: a tagged dry-run launch in the region must be allowed; an
untagged one, EC2 in another region, IAM, S3 and Lambda must be refused) and
stops if it is broader. Every
resource is tagged `Project=tavya-loadtest` and `RunId`; the EXIT trap
terminates and deletes them even on failure or Ctrl-C (`--keep` skips that,
for debugging); each VM runs `shutdown -h +180` at boot (`--max-minutes`) with
shutdown behaviour *terminate*, so it disappears even if the operator's machine
does, and the driver is stopped 25 minutes before that to collect results. SSH
is open only to the operator's address(es). Cost at eu-central-1 list
prices: ~$0.62/h for the pair plus disks, written to `cost.json`.
