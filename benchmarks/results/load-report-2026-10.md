# Control-plane load test, October 2026: where tavya breaks as customers are added

Three runs of [`benchmarks/load`](../load/README.md) on disposable EC2 copies of tavya
(eu-central-1). The system under test was a c7i.xlarge (4 vCPU / 8 GB, like the tavya.io VPS),
running the revision's own `deploy/karmax up` with the compose memory caps. Synthetic tenants used
the public HTTPS edge only: they signed up, created and followed up tasks, approved and cancelled
them at Review, saved resources, and kept two websockets open per person. Worlds came from the E2B
stand-in (real `envd`, 50 ms added per round trip), and agents were the mock. Tenants doubled every
5 minutes until a limit broke. Production was never touched.

| run | revision | result | cost |
| --- | --- | --- | ---: |
| [baseline](load-baseline-2026-10-09/report.md) | master `45522f01`, which the integrated branch contains | wall at step 5 | $0.372 |
| [integrated](load-integrated-2026-10-09/report.md) | parent branch `1460e39c`: Store lock removed, memory budget, edge limits, vault in PostgreSQL | wall at step 5 | $0.382 |
| [integrated + statements](load-integrated-statements-2026-10-10/report.md) | `1460e39c` with `pg_stat_statements`, steps 8 → 32 → 64 | wall at step 3 | $0.265 |

The total spend was **$1.16**, including $0.15 of aborted attempts and a debug pass. Every run ended
with a describe call showing no instance, volume, security group or key pair tagged
`Project=tavya-loadtest` (`logs/leftovers.txt`).

## The first wall

**At 64 concurrently active tenants (96 people, ~240 open tasks, 192 websockets), tavya stops
answering in time.** All three runs broke at the same step. Every run passed 32 tenants (48 people,
~110 open tasks) with API p95 at 104–134 ms.

| at 64 tenants | baseline | integrated | integrated + statements |
| --- | ---: | ---: | ---: |
| API p50 / p95 / p99 | 1.08 / 3.43 / 5.38 s | 1.04 / 3.62 / 5.33 s | 1.38 / 4.07 / 6.39 s |
| event lag p95 (event written → received) | 17.6 s | 21.6 s | 22.8 s |
| turn overhead p50 / p95 (control plane's share of a turn) | 16.7 / 102 s | 13.4 / 38.9 s | 24.4 / 110 s |
| websockets dropped as "fell behind" (1013) | all | all | all |
| store transactions waiting for one of **4** pool connections | 237 | 232 | 234 |
| karmax database commits/s (rows written/s) | 6,005 (161) | 5,454 (152) | 5,207 (~150) |
| host CPU mean; app / PostgreSQL / Temporal container CPU | 87 %; 188 / 107 / 44 % | 88 %; 196 / 108 / 43 % | 89 %; 199 / 107 / ~43 % |
| gateway / worker CPU (one core = 100 %) | not measured | 89 / 77 % | 90 / 80 % |

The app's store pool has 4 connections and refuses work beyond 256 waiting
(`src/store/async-sql.ts`). At the wall it had about 235 waiting, so every request, event delivery
and activity queued behind them. The gateway, a single Node process, was also at 90 % of a core.
Nothing errored (0 % 5xx) and no process restarted; one task in the integrated run failed, out of
398 turns. The installation just became too slow to use.

## Cause: every socket re-derives permissions on every authorization change

`pg_stat_statements` at the wall (run 3, karmax database):

| calls/s | share | statement |
| ---: | ---: | --- |
| 1,783 | 31 % | `SELECT "organizationId" FROM projects WHERE id=$1` |
| 884 | 15 % | `SELECT … FROM principal_grants WHERE "principalId" = $1` |
| 878 | 15 % | `SELECT … FROM project_memberships WHERE "projectId"=$1` |
| 273 + 237 | 9 % | the running turns' follow-up poll (`karmax_seq_watermark`, `events WHERE "taskId" = $1 AND type IN …`) |
| 270 | 5 % | `SELECT v FROM kv WHERE k = $1` |

The three permission lookups make up 62 % of all calls. They grow quadratically: 39, then 500, then
1,783 calls/s at 8, 32 and 64 tenants. Writes stay near 150 rows/s. The mechanism, in the code of
both revisions:

1. **Every agent turn ends with an authorization change.** The turn's scoped token is revoked
   (`src/activities/core.ts`, `tokens.revoke(token)` after each turn). The Store treats every
   `UPDATE scoped_tokens` as an authority write and moves the installation-wide authorization epoch
   (`src/store/authorization-epoch.ts`).
2. **Every open socket re-checks its owner's access on every epoch move,** at most once a second, and
   every 5 s regardless (`keepAuthorized` in `src/gateway/socket-lifetime.ts`). Each check resolves the
   person's grants and memberships from the database. A person's access never depends on an agent's
   turn token, yet all of tavya's sockets re-check whenever any tenant's turn ends.
3. **Every socket is offered every tenant's events** (`DurableEventFanout` delivers each event to
   all subscribers). After each epoch move its cached decision is stale, so it resolves the event's
   project (`projects.organizationId`) and the person's capabilities there again, even for events it
   will then drop.

Permission lookups therefore scale as $\text{sockets} \times \text{authorization changes per second}$,
and both grow with tenants. At 64 tenants: $192 \text{ sockets} \times \sim1.3$ turn ends/s, at 3–4
queries per decision, plus a re-resolution of each foreign event. Each query takes 0.01–0.02 ms
inside PostgreSQL. The cost is the round trips, serialized through 4 connections and one gateway
event loop.

The other two contributors are linear and much smaller. They're measured on a local
PostgreSQL-backed installation (`benchmarks/load/fanout-check.ts`, `pg_stat_statements`):
- **Each running turn polls for mid-turn follow-ups about 4 times a second,** about 16 commits/s per
  running turn even when nothing changed. On the integrated branch each poll adds a visibility
  watermark check (`karmax_seq_watermark`, a sequence read and a `pg_locks` scan).
- **Read endpoints make dozens of sequential store calls:** about 50 for one task view, 52 for its
  conversation, 34 for a project's task list and 17 for `/api/organizations`.

An idle installation is cheap: 20 tasks parked at Review cost about 20 commits/s, mostly the event
fan-out's own 500 ms poll.

## What did not cause it

- **Temporal:** schedule-to-start stayed around 10 ms mean (p95 under 50 ms, the bucket bound), with
  no backlog, at every step.
- **The global Store lock:** at most one advisory-lock waiter (15 ms) on the baseline. The integrated
  branch's `karmax_store_global_lock_wait_seconds` stayed at 0, with 8.2 s of per-entity lock waits
  in total since boot. Removing the lock was right, but it was not this wall.
- **Memory:** at the wall the gateway's heap was 231 MB of 662 MB and the worker's 181 MB of
  1,276 MB on the integrated branch, and the app container used 1.3 of 4 GB. The RT-35 heap
  exhaustion did not recur in these runs (mock agents, ~240 workflows).
- **The edge:** Caddy used 2 % CPU, with no 429s (each tenant had its own budget, as each customer
  has its own address).

## What the sibling fixes changed

At the same 64-tenant wall, the integrated branch:
- **halved the gateway's heap** (581 → 226 MB);
- **cut turn overhead p95 from 102 s to 39 s;**
- **removed the two `invalid or expired token` 403s** that the baseline gave live sessions under load.

It did not move the wall, because the wall is in the authorization fan-out, not in the code they
changed.

## Fixes, by expected effect

1. **Stop re-deriving people's access on agent-token churn.** Revoking a turn's own token can't
   narrow any person's access. Move the epoch only for writes that can (grants, memberships,
   delegations, project moves), or keep a separate epoch for tokens that people's sockets ignore.
   This removes nearly all of the quadratic term at a stroke.
2. **Route events by organization.** Index fan-out subscribers by the organizations whose events they
   may read, so a socket is never asked about another tenant's events. This makes delivery cost
   linear in the event's own audience.
3. **Invalidate decisions per principal or project,** not installation-wide, and batch a socket's
   re-check into one query.
4. **Then the linear costs:** wake turn follow-up polls from the event bus instead of polling 4 times a
   second; give read endpoints a few batched queries instead of ~50 sequential ones; raise the store
   pool above 4 once the round-trip count is down (PostgreSQL had 37 spare connections of 100).

Fix 1 alone should move the wall well past 64 tenants. Re-run `benchmarks/load/run.sh` (about $0.40,
two hours) to find the next one.

## How to read "64 tenants"

A tenant here is a **concurrently active** customer. Each person acts every ~20 s, keeps two tabs
open, and runs 10–40 s scripted turns. Real turns last minutes, so they end less often per running
task, while real people keep more tabs open. The invariant to watch is the product
$\text{open sockets} \times \text{turn ends per second}$: about 250 per second at the wall here.
tavya.io today has one heavy user and a few small ones, far below it. A launch that brings ~100
people online at once would cross it.

## Fidelity

- EC2 c7i vCPUs are not the one.com VPS's; treat absolute numbers as ±30 %.
- The mock agent runs in the worker and streams far less output than Claude or Codex.
- The E2B stand-in stops parked containers, where E2B keeps their processes.
- Not covered: GitHub, previews, payments, email, the Cloudflare resource edge, backups under load.
- Run 3 used a shorter ramp (8 → 32 → 64), so fewer abandoned tasks had piled up by 64 tenants. It
  broke at the same point.

Per-step data are in each run's `report.md`, `summary.json` and `steps.jsonl`. Raw samples are in
`raw/samples.jsonl.gz` (collector), `raw/probe.tgz` (process heap and CPU) and `raw/app.log.gz`.
