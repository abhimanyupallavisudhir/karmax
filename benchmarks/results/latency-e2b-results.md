# Deployed tavya.io E2B latency: 2026-09-19

This collection runs tasks through the **deployed tavya.io gateway and Temporal worker into actual E2B task worlds**. It supersedes the local-world report for conclusions about SaaS startup and follow-ups. The earlier [local-world collection](latency-live-results.md) remains useful for its distinct direct-API model/tool workloads; its 24 ms world preparation and 99% provider fraction do not describe this deployment.

## Environment and method

Production container `karmax-app-1` started at `2026-09-19T00:04:25.164694878Z`, image `sha256:9e047083b248c06fcb6fc9a284918899ae3b8e9506417fd541852bd6fec3d8db`, Node 22.23.2. Runtime file SHA-256 evidence:

- `src/activities/core.ts`: `883a7be2513e32b34ec4372b214055ac4291800726966c9dd4634d9d90e3c796`
- `src/agent/codex.ts`: `8fce84ad3a13f757fac84ac5c7667922a96d6738ef27309d7648a2852d4eaf31`
- `src/world/e2b.ts`: `7aa3ab10b67c397feaa152b69a77d1708861902ecde74a2e40a9171ef7a99c6a`

The deployed version still has the previous timing implementation; PR #308's default-off toggle is not deployed. No production installation setting, executable, provider connection, or template was changed for this collection. Only the benchmark tasks were created/signalled/cancelled. Model keys were checked for presence, never printed. The account policy selected native Codex app-server / Claude Agent SDK paths with configured logins, rather than the earlier direct-API harness. Project API secrets are also available to task processes; the final billing source was not independently verified. Native runtime selection does not prove which provider billing account was charged.

Tasks use the `just-do@1.7.0` workflow, real project repository/resource setup, production host admission, full runtime prompt assembly and native agent startup. This exercises the shared task/agent path but does not measure software-development PR/merge stages. Wiki selection is empty. The Codex model is the production catalog default `gpt-6-astra`, effort `low`. Its native app-server runs inside E2B. Optional MCP browser connections are inherited for the first pilot and explicitly empty for the subsequent controlled run. Core tools and provider-owned integrations still exist when optional connections are empty.

The collector is another E2B task calling the production task API through authorized platform tools. Timings start at server receipt, not at a browser click. Repeated cohorts alternate between waiting for an observed `world.parked` event and sending as soon as Review is observed. The observer polls at approximately one second; report construction/polling is additional load, and this was an active deployment, not an isolated performance host. A host snapshot during collection showed load averages 0.56 / 0.68 / 0.65 and app container memory 1.325 GiB of 7.75 GiB. These snapshots do not establish load throughout the run.

## Initial pilots

- **Default optional browser tools, task #300:** E2B world preparation 12.54 s; receipt to activity start 29.56 s; prompt preparation 3.58 s. `tool.connection.prepare` remained open until the two-minute activity deadline. No model invocation was recorded. The task was cancelled and reported its world released. This is a censored startup failure, not a successful response sample. Code inspection identifies this phase as optional connection preparation, including remote Node/browser setup; the existing span does not isolate which installation/probe substep stalled.
- **No optional browser tools, task #301:** first text 74.22 s and activity completion 75.15 s after receipt. Activity start was 28.66 s after receipt. Within the activity, prompt preparation took 3.53 s, optional connection preparation 0.012 s, adapter-to-first-output 35.09 s, process startup 0.98 s, provider session preparation 0.42 s, and the CLI roundtrip 5.45 s. These intervals overlap; they are not additive. Same-clock marks place **34.08 s between adapter invocation and the start of process startup**. In the deployed Codex path this interval precedes spawning the app-server and includes remote home/runtime/session preparation and MCP configuration. It cannot be attributed to model inference. The corresponding interval on the first resumed turn was 4.79 s.
- **First follow-up after an observed parked world:** first text 17.97 s; completion 18.99 s; receipt to activity start 0.744 s. World open was 0.350 s, prompt preparation 6.65 s, adapter-to-first-output 5.77 s, and CLI roundtrip 3.12 s.
- **Live input during a turn:** the model ran one harmless `sleep 8` command. A follow-up asking for `ACTIVE_ACK` was offered to the running adapter 1.117 s after server receipt (same-clock monotonic interval). The matching `ACTIVE_ACK` activity was published 6.263 s after receipt (wall-clock estimate), including the remaining intentional sleep. It belongs to the same native turn; the generic request report correctly leaves its first-text/completion fields unknown rather than borrowing the original turn's first text. One sample does not establish a distribution or universal steering delay.

## Repeated Codex follow-ups

Twenty additional marker-only follow-ups in the same E2B world/session, alternating modes: ten per cohort. All returned the requested marker without invoking tools. These are repeated observations from one world, not twenty independently provisioned worlds. With n=10, p95 is the maximum and is not a stable population-tail estimate.

| Cohort | n | Receipt → first text median / p95 s | Receipt → completion median / p95 s | Before activity median / p95 s |
|---|---:|---:|---:|---:|
| parked | 10 | 17.34 / 26.60 | 18.26 / 27.74 | 0.93 / 1.17 |
| immediate-review | 10 | 29.09 / 44.58 | 31.38 / 45.60 | 11.08 / 16.70 |

Intervals below overlap and must not be added. Values are seconds.

| Cohort | World open median | Prompt preparation median | Adapter → process-start boundary median | CLI roundtrip median |
|---|---:|---:|---:|---:|
| parked | 0.40 | 4.38 | 4.93 | 3.50 |
| immediate-review | 0.56 | 4.42 | 4.99 | 5.61 |

| Cohort | Review published → receipt median s (wall estimate) | Receipt → prior park completion median s (wall estimate) |
|---|---:|---:|
| parked | 13.24 | 0.00 |
| immediate-review | 2.14 | 10.10 |

The “immediate” cohort reached the server a median 2.14 s after Review publication because the observer must detect and validate the preceding completion. The previous park completed a median 10.10 s after that new request arrived. All ten parked-cohort requests arrived after a confirmed park; all ten immediate-cohort requests arrived before it.

## Observed orchestration behavior

The no-browser fresh task's world became ready 13.917 s after task creation. At 14.305 s the published state changed to `waiting / agentSlot / Starting agent`. A checkpoint finished at 27.964 s, the world parked at 28.325 s, and a new runner lease was acquired at 28.674 s. This is direct evidence of a roughly 14-second checkpoint-and-park detour between world readiness and the first turn. It is not E2B provisioning time or model inference time.

`publishView` stores the visible Review/waiting state and then synchronously checkpoints, publishes the branch, and parks a parkable world. The workflow awaits that activity. Consequently, sending a follow-up immediately after the UI/API announces Review can still leave the request waiting for the previous publication's lifecycle work. The alternating cohorts above measure this effect rather than treating every pre-activity interval as an admission queue.

## Priorities supported by these measurements

1. Avoid checkpointing/parking solely because a ready-to-run turn briefly publishes “Starting agent.” The observed fresh task paid this lifecycle cost before it could begin.
2. Decouple the visible Review transition from blocking checkpoint/parking work, or let a newly arrived follow-up cancel/defer idle parking safely. Immediate follow-ups currently wait behind that work.
3. Reduce repeated remote agent bootstrap and prompt preparation. Resuming a conversation still starts a new native agent process and prepares its home/session; it does not retain an already-running agent.
4. Make browser/runtime readiness predictable, preferably with validated prebuilt environments. The default-browser cold pilot never reached the model within its limit. A single timeout cannot establish its frequency.

These are optimization candidates, not changes deployed by this measurement task. No predicted speedup is claimed without an implementation and repeat measurement.

## Interpretation boundaries

World open includes the resource preparation boundary; secret materialization has no separate span in this deployed version. The current data therefore cannot assign an independent secret-delivery duration. Native agent bootstrap, config/session copying and protocol startup are also only partly separated. Provider/CLI spans include orchestration, transport, queuing, reasoning, streaming and possibly tools; they are not pure inference.

A headless Chromium observer was attached to the Anthropic pilot using the collector task’s own scoped bearer token, which the production API and WebSocket authenticate normally. A client-only module bootstrap hook opens the deployed Check-in renderer; it does not forge a human session or change server code. This measures delivery to Chromium in an E2B collector, not the user’s physical device or the ordinary cookie-login journey. Existing task #286 traces had no acknowledged frames. Server socket-to-ack and receipt-to-frame opportunity are distinct from one-way transport and proof of painted pixels. The observer verifies marker text in the DOM; the completed message event can arrive after streaming has already displayed that text.

The initial limit was two worlds/eight short turns and two minutes per turn. After the default-browser pilot timed out and the no-browser pilot succeeded, the announced extension permitted one additional world, at most 24 additional turns and 25 minutes total, keeping the two-minute turn limit. Tiny marker responses and one eight-second sleep are read-only workloads. No Slack/email messages or external user-data mutations were requested. Application-managed repository checkpoints and task bookkeeping still occur as part of the real workflow.


## Anthropic and browser pilot

Task #302 used the deployed Claude Agent SDK with catalog-listed `claude-sonnet-4-6`, effort `low`, and no optional MCP connections. It is a small path-validation pilot, not a matched provider ranking.

| Scenario | n | Receipt → first text s | Receipt → completion s | Before activity s |
|---|---:|---:|---:|---:|
| Fresh E2B world/session | 1 | 60.30 | 61.74 | 37.38 |
| Follow-up after parked world | 1 | 11.48 | 13.20 | 1.83 |

Fresh prompt preparation took 4.10 s; adapter-to-first-output was 18.23 s. The opaque SDK startup span was 6.58 s fresh and 2.07 s resumed. Its boundaries differ from Codex's process-spawn span, so those startup numbers are not directly comparable. The attempted active-follow-up injection arrived after the sleep command and original turn had completed. Its 20.89 s first-text / 22.12 s completion is retained as a **post-completion follow-up**, excluded from in-flight steering claims.

Three acknowledged browser observations gave a median server socket-to-ack roundtrip of **189.86 ms** (maximum 198.42 ms) and receipt-to-frame opportunity of **26.5 ms** (maximum 27.5 ms). Four other delivery observations lacked acknowledgements and remain unknown. The independent marker observer saw the completed FOLLOWUP and ACTIVE_ACK messages in the DOM at receipt and reached a double-animation-frame callback about 18.1 / 18.9 ms later. These markers may already have streamed into the DOM; these are not first-visible-text measurements. On this small sample, browser delivery is much smaller than the multi-second orchestration intervals.

## Context, usage, cost and cleanup

Codex adapter metadata records a 14,436-character system prompt and 279-character initial transcript; Claude records 14,437 and 276 characters respectively. These counts omit native runtime/tool framing and are not token counts. Codex's native per-request input counters ranged from 26,464 to 28,701 tokens as the session grew. Short marker outputs therefore still exercised substantial production context.

Codex's 25 native usage events report cumulative **702,560 input tokens, including 663,168 cached input tokens; 329 output tokens, including 70 reasoning tokens**. Claude's four completed attempts report **13 non-cache input tokens, 101,327 cache-read tokens, 25,552 cache-write tokens and 92 output tokens**. Anthropic's input counter excludes cache; Codex's includes cache. Do not add Codex cached tokens to its input total. These counters cover the benchmark worlds' recorded native calls, including the sleep fixture, rather than only the repeated cohorts. No provider invoice or E2B charge was available, and the effective billing source is unverified; an actual dollar cost is therefore unavailable. The older local-API cost estimate must not be presented as this E2B run's cost.

All three benchmark tasks were cancelled after collection and emitted `world.destroyed`: #300 at epoch-ms 1789777527850, #301 at 1789778595413, and #302 at 1789778985293. The production container image and start timestamp were unchanged when checked after collection. No installation-wide timing opt-in was performed; the deployed version already recorded timing. The new default-off behavior remains a reviewable code change in PR #308, not a production deployment.

## Evidence and reproduction

- [Codex observations, request reports, cohorts and native usage](e2b-codex-2026-09-19.json.gz)
- [Claude observations and excluded late steering attempt](e2b-claude-2026-09-19.json.gz)
- [Censored default-browser pilot](e2b-pilot-default-tools-2026-09-19.json)
- [Browser observer data](e2b-browser-2026-09-19.json) and [deployed console screenshot](e2b-browser-2026-09-19.png)
- [Earlier traces from this authorized task](e2b-existing-task-2026-09-19.json), retained separately because real-task context/retries are not comparable marker workloads.

Regenerate the Codex tables offline with `npx tsx benchmarks/summarize-e2b.ts benchmarks/results/e2b-codex-2026-09-19.json.gz`. The [browser observer](../e2b-browser-observer.cjs) documents the deployed-console attachment and clock boundaries; it expects the scoped task token in the environment and never writes it to artifacts. Observation exports preserve incomplete and overlapping spans. Same-clock monotonic differences are used for stage durations; lifecycle-event and matching-message differences explicitly labelled wall estimates are not clock-synchronization guarantees. Stage medians cannot be added into an end-to-end median, and residual time is not silently assigned to inference.

The deployed extension measured conversations, startup, and a harmless command fixture. The single/sequential/parallel simulated-service comparisons remain in the earlier local-world report; they were **not rerun in production E2B**, and no fully live external service or Grok comparison is claimed. There were no shared external service accounts available. Twenty repeated Codex observations are split into two ten-sample cohorts; independent fresh-world, Anthropic and browser samples remain deliberately small under the announced execution limits.
