# Agent response timing

Karmax records sparse `timing` events alongside the existing task events. Open a
task’s **Timing** tab, load measurements, and export JSON. The equivalent,
permission-checked endpoint is `GET /api/tasks/:id/timing` (`task:event:read`).
Historical turns have no retroactive measurements. No database migration or
provider credentials are required to enable recording after deployment.

## Reading a report

There are two different starting points:

- **Request → first text / completion:** HTTP receipt (before authentication,
  body parsing and project preparation) for task creation and ordinary follow-up
  signals, or service-method receipt for direct platform calls. First text is
  assistant text published by the worker; completion is successful activity
  completion, including final persistence/cleanup. These are not browser paint
  measurements. Failed attempts can contribute partial first text but cannot
  contribute successful completion.
- **Activity → first text / completion:** one Temporal activity attempt. Retries
  remain separate; request completion spans retry backoff. `preActivityMs` exposes
  time before the first activity starts, and request breakdowns expose measured
  spans and the remaining unattributed time.

All summaries include observed sample counts, missing samples, median and
nearest-rank p95. A p95 from fewer than 20 samples is usually just the maximum;
small fixture samples are validation, not a production performance claim.
Provider, configured/resolved model, session mode, world kind and initial/retry
status define comparison cohorts. Unknown model defaults remain unknown.

`sumMs` is accumulated work; concurrent calls can make it exceed elapsed time.
`unionMs` counts overlapping intervals once. Different rows can still overlap
(for example, a CLI turn contains its tools). `coveredMs` unions all measured
child spans within the enclosing interval; `unattributedMs` is the remainder.
Do not add rows to reconstruct total latency. Open spans have unknown duration:
a worker kill does not create a fabricated end timestamp. `incomplete` may mean
still running or interrupted without a terminal observation. Explicit ACP
follow-up interruption is excluded from successful completion even though the
existing workflow treats it as a clean steering boundary.

Each observation has a task ID, optional request/message IDs, stable workflow turn
ID, workflow run ID (separating lifecycle replacements), retry attempt, unique observation/trace/span IDs, a wall timestamp and a
process-incarnation clock ID. Durations use `performance.now()`. Subtraction
across different clock IDs is prohibited: the exact duration is `null`, with a
separately named wall-clock estimate where available. Cross-process wall estimates have separate distributions and never enter
monotonic percentiles. Correlated `externalSpans` retain their own durations but
are excluded from the activity coverage calculation. Wall estimates can be
negative under clock skew and are not included in monotonic percentiles.
`activity.started.scheduleToStartWallEstimateMs` is specifically a Temporal-service
to worker-wall-clock estimate, not an exact queue duration.

## Boundaries and limitations

| Evidence | What it measures |
| --- | --- |
| `request.received`, `workflow.dispatch` | Receipt and Temporal start/signal acceptance. Scheduled/draft activation and special lifecycle-replacement follow-ups currently have no receipt sample. |
| `queue.account.requested`, `queue.slot.requested`, `queue.observed.*`, `account.wait.observed.*` | Existing coordinator activities and durable view publications. Derived waits include scheduling/publication overhead; they are not exact coordinator residence. |
| `world.prepare`, `world.runner.wait`, `world.open` | Initial world preparation, runner acquisition, and opening/restoring a world for an attempt. |
| `admission.host` | Activity-side usage/host admission, including memory/load backpressure. Workflow-side slot waits are separate. |
| `adapter.invoked` | Snapshot character counts, message count, provider/model and fresh/resumed/forked session. Character counts are not tokens or the provider’s full serialized context. Session mode is not proof of a warm process or cache. |
| `process.*`, `provider.session.prepare` | Observable process handshake/setup boundaries. SDK startup ends at its first SDK event and remains opaque internally. |
| `provider.roundtrip` | Each direct API request through full response-body consumption, including continuation calls. It includes network, queueing, inference and buffering, not pure inference. These adapters use non-streamed responses. |
| `provider.cli-roundtrip.opaque`, `provider.acp-roundtrip.opaque` | Exposed CLI/ACP prompt-to-terminal boundary. It can include tools and internal provider retries. SDK-internal model requests, cache details and retry times remain unknown when not exposed. |
| `provider.first-event`, `first.output`, `first.text` | First CLI/SDK protocol event, first runtime-observable activity/output, and first published assistant text. Tool output is excluded from first assistant text. |
| `tool.connection.*`, `tool.discovery.*`, `tool.execution.*` | Selected MCP preparation, native MCP start/catalog retrieval, platform tool execution and native MCP calls on API rails. No arguments or results are copied. |
| `tool.provider-observed` | Provider item start/terminal notifications for CLI-owned tools, commands and searches. Internal discovery or missing lifecycle notifications cannot be reconstructed. |
| `service.*` | Gateway-side managed discovery/execution, per-connection lock wait, account validation and remote action. Correlation comes from the verified task token’s execution ID/attempt, never a caller-supplied trace header. |
| `provider.usage`, `provider.completed` | Provider-reported per-request counters where exposed and complete aggregate counters. Missing usage/cache fields stay absent. Cache inclusion semantics are explicit. |
| `delivery.socket-roundtrip`, `delivery.browser-frame` | First assistant output per turn/attempt per socket: send-to-ack on the server clock, and client-reported receipt-to-two-animation-frames. Only a foreground Check-in tab acknowledges. This is a frame opportunity, not proof of paint or exact one-way network delay. |

Live follow-ups offered to an adapter have separate receipt and offer observations.
An offer is not proof of consumption, nor proof that the next text answers that
message. They do not inherit the already-running turn’s first-text timestamp.
New activity turns that contain that message can be correlated normally.
Platform-generated continuations without a user receipt have activity samples
but no invented request latency. Browser receipts are bounded, once-only and
scoped to the authenticated socket; missing/hidden/disconnected clients remain
unknown. Multiple viewers yield multiple delivery samples. The `browserFrame` summary reports
receipt-to-frame median/p95 with unacknowledged socket offers counted as missing.

Timing payloads contain identifiers, numeric counters, fixed operation names,
provider/model and session/world classifications. They never copy prompts,
commands, credentials, tool arguments/results or error messages. There are no
additional per-token events. Existing conversation events retain their existing
content behavior. Recording is best effort and must not change a tool outcome or
cause an agent retry. Reports should be accessed through the task-scoped API;
the timing export is not a raw conversation export.

## Repeatable isolated benchmark

```sh
npm ci
# Install the Temporal CLI version pinned in .github/workflows/ci.yml.
npm run benchmark:latency -- 10 /tmp/latency-fixture.json
npm run --silent timing:report -- /tmp/latency-fixture.json > /tmp/combined-timing.json
```

Run heavy checks sequentially, especially on 2 GB machines. The harness boots a
real isolated Temporal dev server/worker, gateway, SQLite store, local git worlds,
and the normal runtime and managed-service connection code. It uses a scripted
`mock` adapter and loopback HTTP fixtures: model round trips wait 5 ms;
discovery/action responses wait 8 ms. It never contacts a model, Composio, email,
Slack or user data. Fixture credentials are dummy values in temporary storage.

Each repetition rotates the order of four scenarios: conversation, one action,
three sequential actions with model continuations, and three parallel actions.
Actions use three distinct fixture accounts so the connection lock does not turn
a parallel scenario into a serialized one. Each scenario gets a new local world
and a follow-up in that same world with a scripted session marker. The gateway,
worker and service fixture remain running. “Fresh” does not mean an entirely
cold machine; “resumed” does not measure real provider caches. Memory/load gates
are disabled only for this isolated harness. No browser is attached. There is no
real-provider/model comparison in these results.

The harness returns all raw content-free observations as well as scenario/mode
summaries. Native MCP is separately exercised with real subprocesses and local
HTTP model-protocol fixtures in `tests/mcp-agent-turns.test.ts`.

A measured 80-turn example and its compressed raw export are in
[the fixture results](latency-fixture-results.md). The offline report command
also accepts `.json.gz` exports.

## Production collection and fair comparisons

1. Deploy the measurement change through the normal release process. Open the
   foreground Check-in tab before submitting a test if browser evidence matters.
2. Collect separate sets for conversation, one authorized **read-only** service
   action, sequential actions, and parallel actions. Use equivalent prompts,
   accounts/data sizes, tools, reasoning settings, models and response criteria.
   Do not send messages or mutate external data for benchmarks.
3. Alternate model order and collect at least 20 samples per scenario and session
   condition. Record region, deployment revision, world provider, concurrency/load,
   input sizes, tool count, fixture/live status and failures alongside exports.
   Keep fresh worlds, resumed sessions, retries and live follow-ups distinct.
   A session-mode label alone cannot establish cold/warm provider caching.
4. Export each task’s Timing report or fetch `/api/tasks/:id/timing` using the
   existing authenticated API. Keep exports in separate scenario directories.
   Merge compatible runs offline:

   ```sh
   npm run --silent timing:report -- exports/conversation/*.json > conversation-report.json
   ```

5. Inspect request first-response and completion distributions, cohorts, queue
   observations, world/setup spans, service/provider intervals, and unattributed
   time. Use wall estimates only with independently understood clock sync.
   Investigate missing samples and failures rather than dropping them.

Grok Bot comparison requires equivalent measurements from Grok Bot itself. These
fixtures and Karmax production traces cannot establish how fast Grok Bot is, or
whether models, service orchestration, deployment or UI account for any gap.
