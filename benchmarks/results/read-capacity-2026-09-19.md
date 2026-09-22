# Read-path capacity fixture — 2026-09-19

Run `npx tsx benchmarks/read-capacity.ts`. The fixture uses an isolated, in-memory
SQLite Store: 1,000 tasks, 200 active, 64 KiB of conversation per task, 12 reads
per strategy. No production database, credentials, agent tokens or billable
sandboxes are used. Measured on the task's 2 GiB sandbox.

| Read strategy | Median | Worst of 12 |
| --- | ---: | ---: |
| Full task/conversation hydration, then archive filtering | 205.3 ms | 311.9 ms |
| Existing compact summaries of the entire project, then filtering | 9.2 ms | 15.7 ms |
| SQL-filtered active page (200 rows) | 2.9 ms | 3.8 ms |

The burst delivered 1,000 events to 20 in-process subscribers (20,000 deliveries)
in 5.2 ms. Separate regression tests assert one ownership lookup per 500-event
page, ordered delivery, and event-loop yields between pages.

These are comparisons of read strategies in the changed checkout, not an old
release/new release comparison. They exclude HTTP authentication, authorization,
WebSocket serialization, network latency, PostgreSQL locks, and sandbox/provider
operations. The whole-run peak RSS was 416 MiB and event-loop p99 was 231 ms;
these include the deliberately blocking full-hydration control and must not be
presented as measurements of the paginated path alone.

PostgreSQL integration tests separately verify that an outstanding `pg_sleep`
query leaves timers and a second pooled query responsive, transaction isolation,
rollback/error propagation, bounded admission, pagination and archive filtering.
