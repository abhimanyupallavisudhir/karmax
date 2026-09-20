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
