# Native asynchronous Store validation — 2026-09-20

Measured in the isolated development sandbox, using migration commit `41b6aff`.
These are synthetic measurements, not production latency or a deployment claim.

## PostgreSQL liveness

Command: `KARMAX_BENCHMARK_POSTGRES_URL=<disposable-loopback-database> node --import tsx benchmarks/native-async-capacity.ts`.
The fixture creates 200 tasks and issues 40 concurrent HTTP requests for compact
Store task pages while a separate transaction runs `pg_sleep(0.5)`. The HTTP
fixture excludes production gateway authentication, Temporal and agent work.
The fixture project is deleted afterward.

| Measurement | Result |
| --- | ---: |
| Requests completed before the stalled transaction finished | 40 / 40 |
| Request p50 | 212.9 ms |
| Request p95 | 242.7 ms |
| Slowest request | 243.0 ms |
| Event-loop delay p99 | 14.9 ms |
| Maximum event-loop delay | 25.7 ms |
| Pool connections | 4 |
| Pending / waiting requests at completion | 0 / 0 |

This demonstrates that a PostgreSQL transaction no longer prevents unrelated
reads or the event loop from progressing. Mutations still serialize through the
Store transaction boundary. Waiting mutations have a five-second admission
deadline; this probe does not measure mutation throughput or overload recovery.

## Existing read-path fixture

Command: `node --import tsx benchmarks/read-capacity.ts`.
SQLite in memory, 1,000 tasks, 200 active, 64 KiB conversation per task, 12 samples.

| Read strategy | p50 | p95 |
| --- | ---: | ---: |
| Hydrate every task, then filter | 243.1 ms | 320.0 ms |
| Read every compact summary, then filter | 11.8 ms | 17.4 ms |
| Read the indexed active page | 3.4 ms | 4.6 ms |

Delivering 1,000 events to 20 subscribers took 15.5 ms. Peak RSS was 565 MB.
The fixture's overall event-loop p99 was 261.8 ms, including the deliberately
expensive full-history reads; asynchronous interfaces do not eliminate the CPU
cost of hydrating and parsing large histories.

## Correctness evidence and limits

Sequential regression coverage spans all 294 test files: 280 passed and 14 were
skipped by their environment/live-service conditions. This is aggregate evidence
across migration commits, with affected suites rerun after repairs, not one full
run of a single candidate. The final repair batch passed 138 tests. Type checking
also includes the TypeScript diagnostic scripts now. Live billable provider
checks were not run.

Gateway/worker process isolation remains separate work. In-process world locks,
secret-file ownership and durable trigger delivery must be addressed before
independent processes can safely share the same application home.

## Integrated upstream validation

The integration at `90e5600235532c1c429da5bfab951fb74ab6e658` includes upstream
`afe32b9e9315303998c75f074a3889d7b30d061b`. All 301 test files were exercised
sequentially against that integration: 287 files passed, 14 were skipped by
environment conditions; 2,944 assertions passed and 33 were skipped. Live agent
and Docker execution were disabled. PostgreSQL tests used a disposable local
database, including independent-pool transaction and ownership-fence cases.

This was a batched run resumed after an interruption, not one uninterrupted
invocation. Batch 8 exited with a worker-process error, leaving four Git-transfer
assertions unfinished. The entire five-test Git-transfer file then passed alone,
including the transfer over 256 MiB; those results replace that file's partial
results in the totals. No test file is missing from the manifest.

Follow-up `00ba79f` adds coalesced maintenance and shutdown draining: 124 focused
tests passed. Follow-up `40458ec` closes worker-refresh admission during shutdown:
15 focused tests passed, including real Temporal worker refresh and workflow
installation. The first version of its unit fixture did not intercept an already
cached module in the shared Vitest process; an instance-level build stub repaired
the fixture. Typechecking passed after that repair.

The actual application entrypoint at `40458ec` was also started with an isolated
temporary application home and the mock agent. Database and Temporal readiness
passed; SIGTERM exited with code zero, recorded `runtime.stopped`, and cleared
the active-runtime marker. This was an idle startup/shutdown smoke test; the
focused tests cover draining accepted work. These follow-ups were not subjected
to a second complete suite, and none of this is evidence of production deployment
or production load capacity. Gateway/activity process separation remains pending.

## Same-host coordination prerequisites

`86aa8ae` adds opt-in shared world transition locks and access pins. Four focused
files passed 45 tests, including real child-process exclusion, owner SIGKILL,
access-pin cleanup, nested transition recovery, and lock admission timeout.
The default registry remains in-process; separate gateway/worker execution is
not enabled by this change. Shared coordination requires same-host Linux kernel
locks and is not a lease protocol for independent hosts or filesystems.

`7dd03f9` serializes Linux vault mutations without changing the secret-map format.
It awaits credential persistence throughout its callers, initializes shared keys
without replacement, and makes rename and conditional token cleanup atomic.
Vault/resource/GitHub regression coverage passed 107 tests; broader gateway,
connector, billing and world coverage passed 268; MCP/OAuth passed 73 with two
environment skips; backup coverage passed 14. The final shared-vault file passed
five tests (four of them reruns of the earlier group), including concurrent
process initialization/writes and observing one key across concurrent creators.
Backup tests also cover excluding temporary key files left by a crash.
Typechecking passed at `7dd03f9`; the asynchronous-call audit found no unawaited
credential mutation call sites in application source.

The actual application entrypoint with these changes passed database and Temporal
readiness and an isolated SIGTERM shutdown: exit zero, a persisted stop record,
and no active-runtime marker. This checks single-process startup/shutdown; it is
not evidence of a deployed split-process runtime. Supervised worker lifecycle and
cross-process event/trigger delivery remain necessary before enabling that split.

## Supervised execution prerequisites and application child

`bab6a62` adds bounded foreign-process event delivery without replaying local
publications. The relay/store/PostgreSQL/trigger group passed 137 tests; the final
four-test relay run includes a real trigger firing once from a child publication.
The cursor remains per running gateway; this is not a durable exactly-once
subscription across gateway restarts.

`adc036d` adds a bounded supervisor protocol and independent parent-lifetime
guardian. Real Temporal tests resume a durable workflow in a second worker process.
The supervisor/Temporal/install/refresh group passed 14 tests, and the final
supervisor file passed nine tests, including frozen-child termination, parent death,
shutdown during startup, and failed drain reporting. These runs overlap.

`8590f0b` shares execution-service construction with the combined bootstrap while
keeping profile/provider/storage bootstrap primary-only. The factory/checkpoint/
provider/storage group passed 19 tests, typechecking passed, and the isolated
combined application passed readiness and clean SIGTERM shutdown.

`3250082` adds same-home worker ownership, shared by the combined runtime and
supervised-child admission. Its admission/instance/supervisor group passed 33
tests. Children need the live registered primary's identity and held application
lock; a stale registration is insufficient. Tests cover graceful release, SIGKILL,
and exclusion in both directions between combined and supervised ownership.

`efc7149` adds the actual activity-worker child entrypoint. Against a unique test
PostgreSQL schema and private Temporal service, a real application activity wrote
an event that the parent relay delivered once. An injected construction failure
after opening the database/client was followed by successful replacement. The
application-child/Temporal/deployment group passed 16 tests. It uses mock provider
configuration and does not contact a model or cloud sandbox. The final typecheck
passed with a 1280 MiB heap. The default compiler heap had exhausted memory during
the ownership check; a subsequent compiler run also caught a missing test-fixture
prompt, which was repaired before the final passing run.
The combined application at `efc7149` also passed an isolated database/Temporal
readiness check and SIGTERM smoke test: exit zero, one persisted stop record,
cleared active-runtime marker, and 0.067 seconds from signal to observed exit.
That idle shutdown timing does not measure draining active agent work.

These are targeted regression results, not a second complete-suite run or a
production capacity result. Main still selects the combined runtime. Selecting the
child requires gateway URL and subscriber startup ordering, shared world lifecycle
review, and full application integration tests. No production deployment of this
split has occurred.
