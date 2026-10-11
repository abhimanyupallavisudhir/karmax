# Control-plane load test after removing the 64-tenant wall (October 2026)

Follow-up to [load-report-2026-10.md](load-report-2026-10.md), on the same harness
([`benchmarks/load`](../load/README.md): c7i.xlarge system under test, synthetic tenants through
the HTTPS edge, mock agents, E2B stand-in with 50 ms added per round trip, tenants doubling every
5 minutes until a limit breaks). Three runs, each compared with the integrated branch
(`1460e39c`, [load-integrated-2026-10-09](load-integrated-2026-10-09/report.md)).

| run | revision | what it adds | first wall | cost |
| --- | --- | --- | --- | ---: |
| [scoped-authority](load-scoped-authority-2026-10-10/report.md) | `4fefbc31` | scoped authority changes, organization-routed fan-out, one-query capabilities, event-driven follow-up reads | 96 tenants | $0.428 |
| [pool8](load-pool8-2026-10-10/report.md) | `d6e4102e` | store pool 8 per process; CPU profiles in the probe | 96 tenants | $0.429 |
| [no-fork-locks](load-no-fork-locks-2026-10-10/report.md) | `237f4bf2` | world-access checks without forking `flock`; memoized `attenuate`; async wiki provisioning | **128 tenants** | $0.493 |

Total **$1.35**. Every run ended with a describe call showing no instance, volume, security group or
key pair tagged `Project=tavya-loadtest` (`logs/leftovers.txt`); each VM also had its shutdown timer.

## The 64-tenant wall is gone

| at 64 tenants (96 people, ~265 open tasks) | integrated | scoped-authority | no-fork-locks |
| --- | ---: | ---: | ---: |
| API p50 / p95 / p99 | 1,042 / 3,623 / 5,329 ms | 32 / 184 / 746 ms | 22 / 146 / 676 ms |
| event lag p95 | 21.6 s | 0.28 s | 0.05 s |
| turn overhead p50 / p95 | 13.4 / 38.9 s | 5.7 / 16.0 s | 3.3 / 5.5 s |
| karmax commits/s | 5,454 | 1,808 | 1,777 |
| gateway CPU (one core = 100 %) | 89 % | 38 % | 30 % |
| host CPU mean | 88 % | 78 % | 64 % |

The three permission lookups that were 62 % of all statements left the top of `pg_stat_statements`.
Authority changes ran at 0.3–0.8 per second, all of them scoped (`karmax_authority_changes_total`,
none installation-wide). In a local measurement (stub gateway on PostgreSQL, two person sockets per
tenant, an agent turn per tenant), store reads per event went from 50, 176 and 306 at 8, 32 and
64 tenants to 3.5 at all three: they no longer grow with tenants.

## The new wall: 128 tenants, the activity worker and one 4-vCPU host

At 128 concurrently active tenants (192 people, 670 open tasks) turn overhead p50 reaches 176 s.
The API is still fast (p95 315 ms, 0.12 % errors) and events still arrive (lag p95 0.2 s), but
turns wait:

- **Temporal workflow tasks back up.** Workflow schedule-to-start p50 8.4 s and p95 at least 10 s
  (the histogram's top bucket), with 215 tasks in backlog, the oldest 26 s. Activities still start
  in under 50 ms. Workflow code runs in the activity worker process
  (`KARMAX_MAX_WFT` = 8 concurrent workflow tasks), and that process used 113 % CPU.
- **The worker's main thread still forks.** 24 % of it is `child_process.spawn`: exclusive
  world-operation locks (`flock` per world open or transition, ~10 %), the first access pin of each
  world (~8 %) and project-wiki `git` during world provisioning (~5 %). Forking a process with an
  ~850 MB heap costs milliseconds of CPU each time.
- **The host is nearly full.** CPU mean 90 %: app 205 %, PostgreSQL 95 %, Temporal 54 % of 400 %.
  The store pool had 29 requests waiting behind its 8 connections.

At 96 tenants the run passed (turn overhead p50 40 s against the 60 s limit, no failed tasks). Before
`no-fork-locks`, 27 and then 8 tasks failed at that step with `DatabaseCapacityError` (the worker's
store admission bound of 256), and 35 % of the worker's main thread was forking: `flock` for
world-access probes (~15 %), pins and transitions, and a synchronous `git`.

## What to do next, by expected effect

1. **Take world locks without forking.** One long-lived lock helper per process, or PostgreSQL-held
   leases for transitions, would remove the remaining ~24 % of the worker's main thread.
2. **Give workflow tasks more room.** Raise `KARMAX_MAX_WFT`, or run workflow tasks and activities in
   separate worker processes, so 680 running workflows don't share one process with every activity.
3. **Then the per-request reads.** `SELECT v FROM kv WHERE k = $1` is 20 % of statements (a token
   verification reads `account-closed:` up to three times per request, a capability check
   `project-transfer-history:` per capability), and a person's socket checks its session every 5 s
   (`session` 8 %). A request-scoped memo and one shared session check per person would halve them.
4. **Then hardware.** At 128 tenants the 4-vCPU host is at 90 %, so beyond the fixes above, the next
   step is a larger VPS or a second app host.

## Fidelity

As in the [October report](load-report-2026-10.md#fidelity): EC2 vCPUs, the mock agent, the E2B
stand-in. The probe's CPU profiles (`raw/probe.tgz`, one every 2 minutes per process, summarised by
module in each `report.md`) cover the main thread only; the worker's workflow thread is not profiled.
