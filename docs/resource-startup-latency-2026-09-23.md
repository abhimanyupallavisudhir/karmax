# Resource-heavy E2B setup and cancellation

LegiBench3 task 11 hit createWorld's five-minute StartToClose timeout while
restoring project resources. The first restore continued for approximately 315
seconds, after Temporal had already started another attempt. That retry created
another sandbox and repeated the copies. The prebuilt E2B template and isolated
worker were active; neither removes the cost of copying project data.

The setup activity now has a replay-patched 30-minute timeout with a 60-second
heartbeat deadline. New setup work uses cooperative cancellation through fork
and resource restoration, and checks cancellation before registering/publishing
its world. Failed provisioning releases resources using the actual live world,
not a reopened handle that might resolve to a different generation.

Resource restoration uses four continuously occupied workers for independent files,
so a large file cannot hold three idle slots behind a batch barrier. It
coalesces ordered chunks to at most 8 MiB, and settles active writes before
returning an error. On E2B, large chunks use level-1 gzip if a world-local probe
finds gzip and compression saves at least 25%. Other worlds and incompressible
chunks retain the existing transfer path. Snapshot encryption, content checks,
and chunk ordering are unchanged. The extra buffers are bounded by file
concurrency and chunk size, not total resource size.

`world.resource-restoring` and `world.resource-restored` events identify the
revision, byte/file counts, duration and uploaded payload bytes without content.
Optional timing spans separate object reads, compression, transfer, fork
restoration and total materialization. The Timing setting remains off by default.

Cancellation at Review exposed another gap: follow-ups superseded expensive
waiting-world checkpoints, but a plain cancel signal waited for the checkpoint.
The API now journals `task.cancel-requested` only after Temporal accepts the
signal. Maintenance checks that event at the same safe boundaries used for
follow-ups. A rejected signal does not interrupt maintenance.

## Real tavya.io / E2B evidence

All probes ran on the production gateway and worker with real E2B worlds using
prebuilt template `uj125w982t7wflqad4ig`. They were disposable tasks in LegiBench3;
task 11 was not restarted. No probe changed project files or promoted resources.

| Probe | Setup to world.ready | Outcome |
| --- | ---: | --- |
| Task 12, bounded transfer without compression | 213.1 s | One setup attempt; agent reached Review |
| Task 13, compressed transfer | 147.8 s | One setup attempt; first response 176.1 s; completion 177.4 s |
| Task 14, cancel during 101 MB resource restore | 2.5 s after cancel | Cancelled, no world.ready, sandbox absent, all 7 leases released |
| Task 15, cancel during resource checkpoint | 0.69 s after cancel | Maintenance deferred at its next safe boundary; task cancelled |
| Task 16, compressed transfer with continuous workers | 112.0 s | First response 138.9 s; completion 140.3 s; all 498 hashes match |

Tasks 12, 13 and 16 restored the same 12 resource revisions: **708,437,252 bytes in
498 files**. Compression reduced uploaded payloads to **146,771,792 bytes**
(79.3% fewer bytes). Setup improved by 30.6% between these two single runs. This
is not a statistical latency distribution. Continuous workers reduced the next
run to 112.0 seconds: 24.2% below task 13 and 47.4% below task 12. The unchanged
bytes and revisions were checked, and all 498 hashes were verified again in
task 16. Network and provider variability still apply. Task 11's older pinned revisions and
failure/retry path are not a controlled before/after benchmark.

All 498 files in task 13's real sandbox were independently read and SHA-256
checked against server-verified exact resource revisions: **zero mismatches**.
Task 13's unchanged follow-up reached its first response in 14.8 seconds and
completed in 15.7 seconds while maintenance was in progress. Both actual agent
views reported Codex gpt-6-astra **high**; attempted low-effort task form fields
were not reflected in the effective view, so these are not low-effort results.

The 553 resource-transfer spans totalled about 225 seconds across concurrent
files; that sum must not be confused with elapsed time. Resource materialization
was 139 seconds, object reads totalled 5.3 seconds, and compression 9.5 seconds.
Remote transfer/request overhead remains dominant. A future batched archive
transport may reduce request count; this change does not implement it or claim
that resource-heavy setup is now optimal.

## Deployment and rollout

Production files were hash-checked before each live validation update. The
production-only child-task capability change in core.ts was preserved. Worker
readiness was checked after restart. The unchanged-publication shortcut from
commit a18fe08e had disappeared from the then-current container; it was restored
and its exact hash reverified. Durable installation settings still specify
`KARMAX_WORKER_MODE=process` and `KARMAX_E2B_TEMPLATE=uj125w982t7wflqad4ig`.
New organizations and projects inherit those defaults unless explicitly overridden.

These source updates are **live validation overrides**, not evidence that a
release image contains the changes. They can be lost on container replacement.
The branch/release must carry both the resource fixes and the earlier Git shortcut;
post-release hash verification remains necessary. The final live candidate also
includes the continuous-worker utility and accepted-cancellation journal. A paused orphan belonging to
cancelled task 11 was verified by task metadata and removed. Its other old sandbox
was already absent.

## Regression checks

Typecheck and targeted resource, integrity, binary gzip transfer, cancellation,
fork, teardown, lifecycle and real Temporal tests passed. The binary round-trip
test exercises compressed/incompressible data, appends, empty files, quoted paths
and pre-cancelled calls. A first test run exhausted its worker while deeply
comparing multi-megabyte Buffers; using Buffer.equals for the same byte-for-byte
assertion resolved it, and all 30 tests in that run passed on repetition.
The full 26-test workflow suite and 8 fork tests also passed. Typecheck required
the normal 1536 MiB heap cap; a 1024 MiB attempt exhausted its heap.
The full repository suite was not run.

An exploratory bulk-upload test in a separate real E2B sandbox compared three
rounds of 24 synthetic 128 KiB files, four at a time. Bulk multipart upload was
12–15% faster than four concurrent single-file requests; this was fixed-order,
not randomized, and no bulk-upload implementation was added. That sandbox was
killed in a finally block. Content-free reports are in
`benchmarks/results/resource-*-2026-09-23.*`.

Final cleanup verified that all five task-probe sandboxes and the standalone
upload-benchmark sandbox were absent. Timing was restored **off**. The final
production module hashes match the tested candidate (preserving unrelated
production changes in core.ts and api.ts); see the deployment evidence JSON.

## Subsequent release audit and capture hardening

At the next audit, production was running revision
`242a8d6d0430b4db65e64020990354da055ab013`, with its container started at
2026-09-23 06:47:30 UTC. Deploy run 35828236321 explicitly reported that revision
as completed and healthy. Task 305's reviewed commit
`451b28583b2442e51c4534cf9b1d71661b3292de` is an ancestor of that running checkout.
The process-worker and prebuilt-template installation settings survived.
However, the resource restore, continuous-worker and Git shortcut file hashes
had reverted: PR #336 remained open, so those temporary validation overrides
were **not durably deployed**. The deployment workflow requires a master revision
with successful CI. No candidate-branch deployment or additional application
source override was used during this audit. The branch was merged with master
`7c45692f9eacac84fe0da593474d265ebfe7f728`, preserving both cancellation tests
in the only merge conflict.

Further integrity checks found that checkpoint reads could silently accept a
failed `dd` pipeline or a short read, and the text-only restore fallback decoded
arbitrary bytes as UTF-8. Reads now propagate pipeline failures and reject
unexpected lengths; snapshot capture independently checks supplied byte counts.
The fallback restores base64 through the remote decoder, including the first
chunk, preserving binary data.

A disposable real E2B sandbox was exercised from the production host at
17:45 UTC using the candidate transfer module in an isolated script, without
restarting or replacing the running application. Both binary-write and text-only
paths preserved compressed binary data and appends. Missing files and truncated
reads failed as expected. The sandbox was destroyed. Exact evidence is in
`benchmarks/results/resource-integrity-2026-09-23.json`; the repeatable probe is
`benchmarks/e2b-resource-integrity.ts`. This additional check covers the real
resource data plane, not a new gateway/Temporal task-start benchmark; the full
workflow timings above remain the relevant end-to-end measurements. Installation
timing remains disabled.

Checkpoint capture still reads files serially and uses base64 command output.
This audit does not claim that cost is eliminated or that all latency is optimal.
Task 332 separately proposes avoiding file scans when listing review resources;
its proposal was still waiting for review at this audit, so it was not counted as
an already deployed improvement.

Post-merge validation passed 211 targeted tests: 91 stage-transition/agent-parking,
24 resource/integrity/transfer, and 96 Git publication, queueing, E2B defaults,
deployment, workflow, fork and teardown tests. Typecheck also passed. These are
targeted checks, not a new full-repository CI result.
