# Isolated latency benchmark: 2026-09-17

Measured 80 successful turns: 10 samples in each of four scenarios and two session conditions. No missing first-response or completion samples. Linux x64, Node 22.16.0, 2 available CPUs, approximately 2 GB RAM; Temporal CLI 1.7.2. Benchmark ran sequentially without typechecking or other test suites.

Real gateway, Temporal worker, SQLite, local git worlds, runtime, and managed-service code; **mock model and service responses** over loopback HTTP (5 ms model and 8 ms discovery/action delays). This is instrumentation evidence, not production performance or a Grok comparison.

All values below are milliseconds. First response is gateway receipt to first published assistant text; completion ends at the agent activity. No browser was attached, so browser delivery/render latency is unknown. Gateway and worker share a process in this harness, allowing monotonic request durations.

| Scenario | Session/world | n | First response median / p95 | Completion median / p95 | Activity completion median / p95 |
|---|---|---:|---:|---:|---:|
| conversation | fresh | 10 | 960.6 / 971.0 | 962.1 / 973.9 | 20.9 / 38.2 |
| conversation | reused/resumed fixture | 10 | 663.2 / 665.8 | 664.3 / 667.9 | 19.1 / 26.0 |
| one-action | fresh | 10 | 992.5 / 1034.3 | 993.7 / 1035.7 | 51.2 / 67.0 |
| one-action | reused/resumed fixture | 10 | 694.6 / 724.7 | 695.7 / 726.2 | 52.1 / 73.7 |
| sequential-actions | fresh | 10 | 1048.5 / 1088.2 | 1049.6 / 1089.5 | 106.6 / 125.3 |
| sequential-actions | reused/resumed fixture | 10 | 737.9 / 756.6 | 739.0 / 757.8 | 104.9 / 118.6 |
| parallel-actions | fresh | 10 | 1001.0 / 1006.8 | 1002.6 / 1007.9 | 62.9 / 65.8 |
| parallel-actions | reused/resumed fixture | 10 | 695.6 / 705.0 | 697.7 / 706.1 | 63.4 / 66.3 |

Fresh means a new local world and scripted session. Gateway, worker, and fixture server were already running. Reused means the same world plus a scripted session marker; it establishes no provider-cache behavior. Scenarios rotate order each repetition. Parallel actions use distinct fixture accounts; sequential actions include model continuations. Host memory/load admission gates were disabled for this fixture.

## Duration accounting

The following summaries pool all 80 turns and are not additive: child spans overlap their parents, and tools may overlap one another. The report computes coverage by interval union and retains the remaining time as unattributed.

| Interval | n | Median ms | p95 ms |
|---|---:|---:|---:|
| Receipt to activity start | 80 | 650.4 | 943.2 |
| Request completion: covered union | 80 | 63.8 | 132.1 |
| Request completion: unattributed | 80 | 659.5 | 930.1 |
| world.prepare | 40 | 18.5 | 26.6 |
| prompt.prepare | 80 | 2.3 | 4.8 |
| admission.host | 80 | 0.2 | 0.3 |
| adapter.to-first-output.opaque | 80 | 47.6 | 99.5 |
| service.discovery | 60 | 9.9 | 11.1 |
| service.execution | 140 | 11.2 | 16.5 |
| provider.fixture-roundtrip | 200 | 6.8 | 9.6 |

The gap before activity start is substantial in this fixture. It includes workflow scheduling and work between measured boundaries; it must not be assigned entirely to a queue or model inference. Queue publication intervals and Temporal schedule-to-start wall estimates are separate evidence in the raw report. Unknown time remains visible.

Prompt character counts are observed; token/cache counts are absent because the scripted adapter does not report them. No cloud provisioning, real provider process startup, provider cache, external service latency, or browser rendering was measured here.

## Reproduce and inspect

See [response timing](response-timing.md) for the full measurement contract and live-production collection procedure. The compressed [raw export](../benchmarks/results/latency-fixture-2026-09-17.json.gz) contains content-free observations, environment, scenario groups, and the report. Recompute without contacting any services:

```sh
npx tsx src/scripts/timing-report.ts benchmarks/results/latency-fixture-2026-09-17.json.gz > /tmp/timing-report.json
npm run benchmark:latency -- 10 /tmp/new-fixture-run.json
```

Verification: relevant integration/unit suite passed 92 tests across 13 files; targeted real Temporal retry/resume test passed. After report refinements, timing/UI unit tests passed 14 tests. TypeScript checking and JavaScript syntax checking were also run. An earlier retry test run overlapped typechecking on the 2 GB host and timed out under memory pressure; it was discarded and rerun sequentially. These test durations are not benchmark samples.
