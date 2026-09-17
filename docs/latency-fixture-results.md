# Isolated latency benchmark: 2026-09-17

Measured 80 successful turns: 10 samples in each of four scenarios and two session conditions. No missing first-response or completion samples. Linux x64, Node 22.16.0, 2 available CPUs, approximately 2 GB RAM; Temporal CLI 1.7.2. Benchmark ran sequentially without typechecking or other test suites.

Real gateway, Temporal worker, SQLite, local git worlds, runtime, and managed-service code; **mock model and service responses** over loopback HTTP (5 ms model and 8 ms discovery/action delays). This is instrumentation evidence, not production performance or a Grok comparison.

All values below are milliseconds. First response is gateway receipt to first published assistant text; completion ends at the agent activity. No browser was attached, so browser delivery/render latency is unknown. Gateway and worker share a process in this harness, allowing monotonic request durations.

| Scenario | Session/world | n | First response median / p95 | Completion median / p95 | Activity completion median / p95 |
|---|---|---:|---:|---:|---:|
| conversation | fresh | 10 | 957.8 / 961.1 | 958.9 / 962.2 | 18.6 / 42.6 |
| conversation | reused/resumed fixture | 10 | 662.2 / 663.6 | 663.4 / 664.7 | 18.8 / 22.1 |
| one-action | fresh | 10 | 994.8 / 1002.5 | 996.0 / 1004.1 | 52.9 / 62.9 |
| one-action | reused/resumed fixture | 10 | 686.9 / 698.9 | 688.1 / 700.3 | 53.6 / 59.6 |
| sequential-actions | fresh | 10 | 1051.5 / 1132.9 | 1052.5 / 1134.0 | 104.8 / 164.3 |
| sequential-actions | reused/resumed fixture | 10 | 733.2 / 756.0 | 734.2 / 757.4 | 101.2 / 115.7 |
| parallel-actions | fresh | 10 | 1001.4 / 1010.0 | 1002.4 / 1011.5 | 61.0 / 69.7 |
| parallel-actions | reused/resumed fixture | 10 | 699.2 / 710.7 | 700.4 / 715.0 | 58.6 / 80.9 |

Fresh means a new local world and scripted session. Gateway, worker, and fixture server were already running. Reused means the same world plus a scripted session marker; it establishes no provider-cache behavior. Scenarios rotate order each repetition. Parallel actions use distinct fixture accounts; sequential actions include model continuations. Host memory/load admission gates were disabled for this fixture.

## Duration accounting

The following summaries pool all 80 turns and are not additive: child spans overlap their parents, and tools may overlap one another. The report computes coverage by interval union and retains the remaining time as unattributed.

| Interval | n | Median ms | p95 ms |
|---|---:|---:|---:|
| Receipt to activity start | 80 | 646.9 | 943.6 |
| Request completion: covered union | 80 | 66.9 | 124.3 |
| Request completion: unattributed | 80 | 652.2 | 930.2 |
| world.prepare | 40 | 18.0 | 27.6 |
| prompt.prepare | 80 | 2.3 | 3.2 |
| admission.host | 80 | 0.2 | 0.3 |
| adapter.to-first-output.opaque | 80 | 45.2 | 101.3 |
| service.discovery | 60 | 9.9 | 10.7 |
| service.execution | 140 | 10.9 | 15.2 |
| provider.fixture-roundtrip | 200 | 6.8 | 10.3 |

The gap before activity start is substantial in this fixture. It includes workflow scheduling and work between measured boundaries; it must not be assigned entirely to a queue or model inference. Queue publication intervals and Temporal schedule-to-start wall estimates are separate evidence in the raw report. Unknown time remains visible.

Prompt character counts are observed; token/cache counts are absent because the scripted adapter does not report them. No cloud provisioning, real provider process startup, provider cache, external service latency, or browser rendering was measured here.

## Reproduce and inspect

See [response timing](response-timing.md) for the full measurement contract and live-production collection procedure. The compressed [raw export](../benchmarks/results/latency-fixture-2026-09-17.json.gz) contains content-free observations, environment, scenario groups, and the report. Recompute without contacting any services:

```sh
npx tsx src/scripts/timing-report.ts benchmarks/results/latency-fixture-2026-09-17.json.gz > /tmp/timing-report.json
npm run benchmark:latency -- 10 /tmp/new-fixture-run.json
```

Verification on the final code: focused timing, UI, managed-service gateway and native MCP integration checks passed; adapter, usage and service suites passed 100 tests; the real Temporal retry/resume test passed. The browser-summary regression was first observed failing and then passed after implementation. TypeScript and JavaScript syntax checks passed. The 80-turn benchmark completed successfully, sequentially after those checks. Test durations are not benchmark samples.
