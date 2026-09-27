# Live model latency with fixture services: 2026-09-18

**Local-world baseline:** these are local git worlds inside the collector’s E2B environment. For actual deployed tavya.io E2B task provisioning and follow-ups, see [the SaaS E2B collection](latency-e2b-results.md).

Measured 320 successfully completed turns (272 valid workloads; 48 workload mismatches) through an isolated Karmax gateway, real Temporal worker, SQLite, local git worlds, runtime, production direct API adapters, and managed-service gateway. **Real OpenAI/Anthropic models; simulated read-only services.** This is not tavya.io deployment latency, fully live external-service latency, or a Grok comparison.

The run used the task #286 candidate based on master 8fbdb43c, in its E2B sandbox: Linux x64, Node v22.16.0, 2 available CPUs, approximately 2 GB RAM, Temporal CLI 1.7.2. One turn at a time; provider order alternates by repetition and scenario order rotates. No other tests or builds ran during collection. Local worlds are fresh or reused; worker/gateway remain running. Host memory/load admission gates were disabled only in the isolated harness. Production installation settings were untouched. The workflow uses the harness fixture profile for credential/admission bookkeeping, then dispatches through the real provider adapter. No CLI/SDK startup, cloud-world provisioning, deployment queue contention, or browser paint is measured.

Models are the repository defaults, not an installation-wide profile inventory: OpenAI gpt-5.5 (Responses API, reasoning low) and Anthropic claude-sonnet-4-6 (Messages API, output effort low, no explicit extended-thinking configuration). Low effort is not proof of equivalent reasoning behavior. Prompts are compact deterministic fixture instructions; only search_connection_tools and execute_connection_tool are exposed. Output is capped at 512 tokens per request.

Fresh means a new world and provider conversation. Follow-up reuses the world: OpenAI resumes its response chain; Anthropic's API reconstructs a stateless request. The session conditions have different provider context semantics and do not establish warm caches. Provider-reported token/cache counters below describe actual usage. No browser was attached.

## Request latency

All values are milliseconds: gateway receipt → first published assistant text / successful activity completion. These adapters consume non-streamed responses; first text is **not provider first-token latency**. Same-process monotonic clocks cover gateway/worker request durations. Temporal service-to-worker schedule-to-start values remain separate wall-clock estimates.

The tables below exclude 48 workload mismatches: the observed number of successful service reads differed from the requested count. All raw observations and their billed usage remain in the export. The prompt in this collection repeated the same instruction on a resumed conversation and said not to repeat completed actions. Some OpenAI follow-ups therefore answered from previous work without rereading. This is a benchmark prompt flaw, not evidence of faster service execution. The reusable harness now explicitly requests a new independent run and checks action counts. Valid follow-up sample counts are shown, including zero; small-cohort p95 is often the maximum.

| Provider | Scenario | World | n | First text median / p95 | Completion median / p95 |
|---|---|---|---:|---:|---:|
| OpenAI | conversation | fresh | 20 | 1610.6 / 2395.9 | 1611.9 / 2397.1 |
| OpenAI | conversation | follow-up | 20 | 1413.8 / 1914.8 | 1415.0 / 1916.1 |
| OpenAI | one-action | fresh | 20 | 4741.3 / 5606.8 | 4742.7 / 5608.0 |
| OpenAI | one-action | follow-up | 10 | 6241.1 / 7198.0 | 6242.3 / 7199.2 |
| OpenAI | sequential-actions | fresh | 20 | 7982.5 / 9509.0 | 7983.7 / 9510.3 |
| OpenAI | sequential-actions | follow-up | 0 | unknown / unknown | unknown / unknown |
| OpenAI | parallel-actions | fresh | 20 | 5677.0 / 7419.3 | 5678.4 / 7421.0 |
| OpenAI | parallel-actions | follow-up | 2 | 7397.2 / 8130.4 | 7398.3 / 8131.6 |
| Anthropic | conversation | fresh | 20 | 2392.6 / 5261.4 | 2393.7 / 5262.3 |
| Anthropic | conversation | follow-up | 20 | 1852.2 / 8215.5 | 1853.4 / 8216.5 |
| Anthropic | one-action | fresh | 20 | 3538.4 / 7359.7 | 5768.6 / 10196.7 |
| Anthropic | one-action | follow-up | 20 | 3119.6 / 6513.2 | 5021.3 / 9621.3 |
| Anthropic | sequential-actions | fresh | 20 | 3264.0 / 10371.2 | 13050.8 / 26329.2 |
| Anthropic | sequential-actions | follow-up | 20 | 3337.9 / 9112.2 | 11865.1 / 30168.3 |
| Anthropic | parallel-actions | fresh | 20 | 2628.2 / 9573.2 | 7410.6 / 19085.8 |
| Anthropic | parallel-actions | follow-up | 20 | 2476.4 / 5026.5 | 7592.0 / 20321.4 |

## Stage accounting

The next table pools fresh and follow-up only to describe stages, not to claim equivalent sessions. Intervals overlap: provider time includes network, provider queuing, inference and response buffering. It also includes the benchmark guard’s local response decoding and usage-checkpoint overhead. It is not pure inference. Work sums can exceed elapsed time; coverage uses interval unions and keeps unattributed time visible.

| Provider | Scenario | Turns | Provider calls per turn | Provider work median ms | Service work median ms | Before activity median ms | Request unattributed median ms |
|---|---|---:|---:|---:|---:|---:|---:|
| OpenAI | conversation | 40 | 1.0 | 1259.0 | 0.0 | 189.7 | 175.8 |
| OpenAI | one-action | 30 | 3.0 | 4627.9 | 11.1 | 210.5 | 191.5 |
| OpenAI | sequential-actions | 20 | 5.0 | 7535.3 | 34.1 | 239.9 | 223.1 |
| OpenAI | parallel-actions | 22 | 3.0 | 5328.7 | 33.7 | 219.8 | 200.6 |
| Anthropic | conversation | 40 | 1.0 | 1888.0 | 0.0 | 213.4 | 202.3 |
| Anthropic | one-action | 40 | 2.0 | 4959.2 | 11.3 | 201.8 | 190.1 |
| Anthropic | sequential-actions | 40 | 5.0 | 12060.8 | 34.9 | 195.9 | 191.6 |
| Anthropic | parallel-actions | 40 | 3.0 | 7224.5 | 34.3 | 188.3 | 184.0 |

| Measured interval (valid cohorts) | n | Median / p95 ms |
|---|---:|---:|
| world.prepare | 160 | 23.7 / 33.2 |
| world.open | 272 | 0.4 / 0.6 |
| prompt.prepare | 272 | 2.7 / 5.1 |
| admission.host | 272 | 0.2 / 0.3 |
| provider.roundtrip | 744 | 1875.3 / 5757.0 |
| service.discovery | 192 | 11.0 / 14.1 |
| service.execution | 436 | 11.3 / 14.2 |
| service.lock.wait | 436 | 0.1 / 0.3 |
| service.action.remote | 436 | 10.0 / 12.6 |

| Provider | System prompt characters | Initial message characters | Resolved model identifiers |
|---|---:|---:|---|
| OpenAI | 260–260 | 51–361 | gpt-5.5-2026-04-23 |
| Anthropic | 260–260 | 51–361 | claude-sonnet-4-6 |

Character counts describe the compact initial snapshot, not serialized tool schemas or server-held response history. Per-request input tokens include the provider context actually billed.

## Evidence-backed bottlenecks

- Opaque provider round trips occupy a median 99.0% of valid activity time. Model-facing latency dominates this small read-only fixture; that includes network and provider queuing/buffering, not just inference.
- Request receipt to activity start has median / p95 208.1 / 661.4 ms. This remains a measurable orchestration gap, but the trace does not identify all of it as queue residence. Request coverage/unattributed values keep that uncertainty explicit.
- Batched tool calls are not concurrent service calls on these API rails. Across 62 valid requested-parallel turns, maximum observed service overlap is 0.0 ms. Both production direct API adapters await each returned tool call in a loop. Batching can save model continuations without providing service concurrency.
- First assistant text is delayed until a non-streamed provider response is consumed. Streaming may improve perceived responsiveness, but these measurements cannot quantify that improvement. CLI/SDK paths and browser paint need separate measurements.
- Skipping requested reads makes a resumed turn look artificially fast. Those workload mismatches are excluded rather than counted as a latency improvement. The raw export retains them and their usage for audit.

## Usage and collection limits

Provider-reported usage, summed per real request. Costs are estimates from published standard API prices, not invoices. OpenAI input includes cached tokens; Anthropic input excludes cache reads/writes.

| Provider | Requests | Input tokens | Output tokens | Cache read tokens | Cache write tokens | Estimated USD | Request bytes min–max |
|---|---:|---:|---:|---:|---:|---:|---:|
| OpenAI | 344 | 152116 | 15899 | 0 | not reported | 1.237550 | 1376–1769 |
| Anthropic | 448 | 492725 | 43326 | 0 | 0 | 2.128065 | 1314–3496 |

Pricing checked September 18, 2026: [OpenAI GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) ($5 input / $0.50 cached input / $30 output per million tokens); [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) Sonnet 4.6 ($3 input / $0.30 cache read / $3.75 five-minute cache write / $15 output per million tokens). No cache-control directive was added.

Limits announced before execution: $20 estimated total, 2,000 requests, six model calls per turn, 512 output tokens per request, 32,000 request bytes, and a 60-second request timeout. The first harness start stopped on a normal waiting state before any API call; after correcting that benchmark-only guard, collection restarted. It incurred no model usage.

Raw content-free observations, cohort membership, environment and per-request usage are in [the compressed export](latency-live-2026-09-18.json.gz). Recompute this table with `npx tsx benchmarks/summarize-live.ts benchmarks/results/latency-live-2026-09-18.json.gz`. See [response timing](../../docs/response-timing.md) for scope and measurement semantics.
