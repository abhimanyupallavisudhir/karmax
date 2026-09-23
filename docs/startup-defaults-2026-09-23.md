# Inherited defaults and Task 305 rollout audit

This follows `startup-rollout-2026-09-22.md`. Its organization-only activation
did not cover new organizations. The changes here make the fast headless E2B
template the release default, with project and organization overrides preserved.
Each organization still supplies its own provider connection and key.

## Gaps found and closed

1. The fallback in `src/world/e2b.ts` was still `codex`. It now selects public
   template `uj125w982t7wflqad4ig`. Separate organization keys, new projects,
   organization overrides and project overrides are covered by provider tests.
2. The template was private. Its package-only build was published through E2B
   and GET verification returned `public: true`, ready build
   `e4bc3d17-ac69-479e-b041-2eec8fa71c02`. Publication contains no account homes
   or task data. Cross-organization selection is tested with independent fake
   keys; a second customer's live account was not created for this test.
3. Task 305's code was in deployed revision
   `09bc148a2108985d8120059bac8d0243ffbecae7`, but worker mode was `combined`.
   Both production Compose profiles omitted `KARMAX_WORKER_MODE`. They now
   forward it and default to `process`; they also forward the template override.
   PostgreSQL's async Store was already active. Worker isolation was not.

Production was activated using the durable `/var/lib/karmax/karmax.env` with
`KARMAX_WORKER_MODE=process` and `KARMAX_E2B_TEMPLATE=uj125w982t7wflqad4ig`,
followed by one app restart. Readiness passed and `/proc` confirmed a separate
`src/temporal/activity-worker-main.ts` child. The organization template override
was then cleared and the provider connection revalidated. A real workflow and
browser follow-up below verify more than health readiness. API calls resumed
normally after the restart; an interrupted tool call was not evidence of an
ongoing server outage.

These live settings apply to new worlds now. The committed release/Compose
defaults make them reproducible on future deployments. They do not replace
existing worlds, override explicit customer images, or change desktop defaults.

## Production end-to-end check

Task **325**, `task_mudi1utke0880cae0c`, ran through tavya.io and the isolated
worker in a real E2B world with no organization template override. It used
Codex gpt-6-astra, low effort, the browser MCP and inherited project wiki context.
The initial reply was `DEFAULTS_READY`; the follow-up successfully opened and
inspected a local data URL through browser tools and returned `BROWSER_READY`.

| Measurement | Time |
| --- | ---: |
| Initial receipt to first text | 47.99 s |
| Initial receipt to completed reply | 49.56 s |
| Follow-up receipt to first text | 19.42 s |
| Follow-up receipt to completed reply | 30.14 s |
| Initial world preparation | 14.03 s |
| Initial tool preparation | 6.75 s |
| Initial agent-home preparation | 6.64 s |
| Initial MCP configuration | 3.75 s |
| Initial MCP readiness | 6.45 s |
| Initial native CLI roundtrip | 3.50 s |

Gateway and worker now have distinct monotonic clocks. Receipt-to-response
numbers are explicitly **wall-clock estimates**, not cross-process monotonic
durations. Phase durations use their owning process's monotonic clock and may
overlap. Evidence: `benchmarks/results/startup-inherited-worker-2026-09-23.json.gz`.
The previous stock probe took 80.05 seconds to first text; this is not a controlled
measurement of worker-isolation speedup (wiki context and runtime mode differ).
Isolation protects HTTP responsiveness; it does not remove E2B/bootstrap work.

Task 325 was intentionally cancelled after successful validation and emitted
`world.destroyed`. Timing collection/display was restored to **disabled**.

## Remaining latency and Task 305 limits

Task 305 separates status persistence from world maintenance, but
`publishTaskView` still awaits `parkWaitingWorld`. It is not fully asynchronous
checkpointing. The first reply triggered 12.56 seconds of branch publication
across three repositories, including broker clones/imports/operations. A
follow-up arriving during that operation deferred subsequent parking, as the
`world.park-deferred` event confirms, but did not interrupt the ongoing Git work.
The second waiting publication took 11.67 seconds, including 8.96 seconds of
branch publication, 2.17 seconds checkpointing, and 0.30 seconds parking.

The next substantial optimizations should target avoiding repeated publication
when the committed repository state is unchanged, bulk transfer of native-home
files (5.09 seconds inside this probe), and retaining/reusing safe MCP/native
process state between turns. These require generation/account fencing and
checkpoint recovery checks; this change does not claim to implement them.
Simply moving maintenance into an unawaited promise would allow it to race the
next turn's filesystem writes and is not a safe latency fix.

## Validation and rollback

Typecheck passed. The E2B, provider-connection, deployment and worker-controller
tests passed: 45 tests across four files. The real Temporal worker replacement
test passed separately in 10.93 seconds. Its first attempt lacked the Temporal
CLI; a subsequent attempt timed out with a transport timeout. After resuming
the session, the unchanged test passed with Temporal CLI 1.7.2. The transient
timeout's cause was not established; it is not counted as successful evidence.
The full repository suite was not run.

Operator rollback: explicitly select `codex` to restore stock headless worlds;
clearing a selector now restores inheritance. Set `KARMAX_WORKER_MODE=combined`
and restart to restore combined mode. Docker environment values take precedence
over the durable env file, so use the Compose input once the new Compose files
are deployed. The pre-activation env-file backup is
`/var/lib/karmax/karmax.env.before-startup-320` (the file was originally absent).
