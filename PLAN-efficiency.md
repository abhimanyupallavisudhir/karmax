Memory/RAM audit — what to implement, in priority order

The short version: the codebase honors the SPEC's core discipline ("RAM is consumed strictly during turns, never during waits") in its architecture, but four things undermine it in practice — no host-wide cap on concurrent agent processes, agent subprocesses that can't be killed, unbounded workflow-history growth, and an append-only events table that gets read whole. The first two are what caused the July 5 OOM (5.7G peak, systemd-oomd kill); the second two are slow-burn and will bite long-running/goal-mode tasks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation status & critical evaluation (2026-07-07)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

I went through every suggestion below, checked it against the current tree, and
kept only what still makes sense for a SINGLE-HOST karmax (the T480-class target).
Several items had already been implemented since this file was written; a couple
are traps that would do more harm than good if applied literally.

DONE already (verified in-tree, no action needed):
  • #3 Docker resource limits — container.ts:18 `containerLimitArgs()` already sets
    --memory/--memory-swap/--cpus/--pids-limit (all env-tunable). Fully covered.
  • #9 reuseV8Context — worker.ts:55 already `true`. Covered.
  • #1 (the hard part) — a host-wide agent-turn cap is owned by the durable
    `agent-queue` coordinator. Its capacity is persisted in Global settings and its
    waiting order is projected on the Queues page. agent-slots.ts retains the live
    memory/load safety gates and the legacy file semaphore for old workflow histories.
  • #2 (graceful half) — claude.ts AbortController + both adapters' heartbeats +
    the 1s bounded shutdown all landed (05f9802 / 30f2a7c), as the file already notes.

IMPLEMENTED NOW (this change):
  • Adaptive admission on LOAD, not just memory (the missing half of #1's parenthetical
    + the user's request). agent-slots.ts now also parks new turns while the 1-minute
    loadavg exceeds `cores × KARMAX_AGENT_MAX_LOAD_FACTOR` (default 1.0 → "load may not
    exceed the core count"). 0 disables; loadavg reads 0 where the OS doesn't report it.
  • Host diagnostics REPORTING (the user's ask). `hostStats()` (loadavg / free / total
    MB / cores / used%) is folded into `agentSlotStats()` and exposed read-only at
    `GET /api/diagnostics` alongside live slot occupancy and which gate is holding
    admission back — so a human/UI can see WHY leases are being deferred.
  • Process-tree custody after SIGKILL (the crash half of #2 — the piece that actually
    would have stopped July-5's orphans). New src/agent/custody.ts: every directly-
    spawned agent is written as a pidfile under KARMAX_HOME/state/agents/<pid>.json;
    codex now spawns DETACHED (own process group) and a mid-turn cancel kills the whole
    GROUP with SIGTERM→SIGKILL escalation (so codex's descendant tool processes die too);
    at BOOT, `reapOrphans()` (wired in main.ts) hard-kills any groups a prior incarnation
    left running and clears the files. A /proc cmdline check guards against PID reuse —
    where it can't verify (non-Linux) it clears the file without killing.
  • Cancellation-delivery gap: the Claude Agent-SDK streaming path never heartbeated
    mid-turn, so Temporal could not deliver a cancel to a long SDK turn (codex/Messages
    already did). Added a 10s heartbeat timer to that path — real parity fix.

DEFERRED with rationale (deliberately NOT implemented):
  • "Add heartbeatTimeout to the 45-minute long-activity proxies" (#2, second bullet).
    This is a TRAP as written. The adapters heartbeat on a TIMER, not on progress, so a
    heartbeatTimeout would not detect a wedged subprocess (the timer keeps beating from
    karmax's own event loop) — and with `retry.maximumAttempts: 1` a heartbeat timeout
    turns a transient worker stall into a HARD task failure. A progress-based heartbeat
    with a short timeout is worse: a coding agent legitimately runs a 10-minute silent
    test suite and would be falsely killed. The real hang mitigation is the OS-process
    custody above (kill the subprocess), which is what this change delivers instead.

Tiers 2–5 below (workflow-history growth, events-table pruning, gateway payloads,
package-bundle retention, housekeeping) remain valid and UNDONE — they are slow-burn,
not the OOM class, and are a separate body of work. Ranked findings preserved as-is.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tier 1 — prevents the OOM class of incident

1. Add a host-wide host.agent-slot lease. Today there is no dedicated cap on concurrent agent subprocesses. The per-credential caps don't help: login accounts default to maxConcurrent: 10 and API keys to 100 (src/coordinators/account.ts:179), and leasing is bypassed entirely when the account pool is empty (src/workflows/software-dev.ts:451). The only real brake is the worker's KARMAX_MAX_ACT default of 8 (src/temporal/worker.ts:50) — which gates all activities (merges, world setup, scripts), not agent turns, and scales up if you ever raise it for throughput or run a second worker. The fix fits your existing pattern exactly: a fixed-capacity lease (capacity ~2–3 on the 15G T480, env-tunable) in the lease coordinator, acquired around every agent turn including the empty-pool path. Optionally gate lease grants on freemem/loadavg so admission control backs off under memory pressure.

2. Fix process custody — the graceful half landed, the crash half hasn't. [Updated 2026-07-06: the first bullet below is DONE — commit 05f9802 wired an AbortController + ctx.signal into the SDK query (claude.ts:173-183) and both adapters now heartbeat, and commit 30f2a7c bounds shutdown so SIGTERM cancels in-flight turns within ~1s, killing their subprocesses. But all of that runs only on a *catchable* signal. The July 5 OOM kill was systemd-oomd — SIGKILL — and on SIGKILL (or a crash, or any future force-kill) no handler runs: the spawned claude/codex subprocesses are reparented to init and keep running with nothing left alive that knows about them.] The Codex path is also still weak on descendants: SIGTERM only, no process-group kill, no SIGKILL escalation (src/agent/codex.ts:165-167), so codex's descendant tool processes survive. Concretely:
- ~~Wire ctx.signal into the SDK query and heartbeat periodically in runAgentSdk.~~ DONE 2026-07-06 (05f9802).
- Add a heartbeatTimeout to the 45-minute long activity proxies (src/workflows/software-dev.ts:40-43 and the same in just-do/merge-only/script-exec) — right now a hung subprocess pins an activity slot for the full 45 minutes and expiry doesn't kill the OS process.
- Track the root pid of every spawned agent, spawn detached, and kill as process-group with SIGTERM→SIGKILL escalation, swept again on session end (the managent pattern from the postmortem).
- Reap orphans at STARTUP: persist each spawned agent's root pid (e.g. pidfiles under KARMAX_HOME/state/agents/), and on boot kill any surviving process groups from a previous incarnation. This is the only custody that works after SIGKILL (systemd-oomd, crashes, force-kills) — graceful-shutdown custody never runs in those deaths, which is exactly how July 5's orphans outlived their host.

3. Put resource limits on Docker worlds. container.ts:45-50 runs docker run with no --memory, --memory-swap, --cpus, or --pids-limit. One runaway process inside a container world can take the whole host. This is a two-line fix and the containers are also sleep infinity long-lived — a periodic reaper for containers/worlds whose task is gone would cover the crash-leak case (destroyWorld failures are silently swallowed at core.ts:415-424).

Tier 2 — unbounded growth over time (heap + Temporal history)

4. Bound what enters workflow state and history. No task workflow ever calls continueAsNew (only the coordinators do), and software-dev.ts appends the full untruncated agent output to msgs/mergeMsgs/resolveMsgs every turn (:537, :832, :382). The 2000-char truncation at core.ts:355 applies only to the journaled event — the full TurnResult.output, plus agent-authored reviewInfo.html and diff, flows through the activity result into workflow history and stays resident in the worker on replay. Goal mode is the worst case: it appends output + a "keep going" message every loop, forever. Recommended: keep full text in the store (it's already persisted via saveView/events) and put only a capped excerpt into workflow state; trim msgs to a tail window; add a history-size-triggered continueAsNew to softwareDev, at minimum for goal mode.

5. Stop journaling the full view on every publish. publish() sends the entire buildView() — all messages, all transcripts, review HTML — as an activity input on essentially every state transition (software-dev.ts:279-281). Activity inputs are recorded in history, so an N-turn task writes O(N) snapshots each of size O(N): quadratic history growth, re-materialized in worker RAM on every cache miss. Publish a delta or just a version stamp and have the activity read state it needs from the store.

6. Tame the events table. It's append-only with no pruning, and agent.output writes one row per streamed chunk (core.ts:315) — the single biggest growth driver in SQLite. Meanwhile /api/activity does allEventsSince(0) and materializes the entire table before slicing the last 300 (server.ts:716-719, db.ts:294), and the per-task drawer does the same. Three fixes: coalesce output chunks (flush per turn or per N KB), add retention (delete a task's agent.output rows on completion, or a global cap), and push the limit into SQL (ORDER BY seq DESC LIMIT 300).

Tier 3 — gateway payloads and backpressure

7. The task-list endpoint returns lastView — full transcripts of every task in the project — in one response, with N parallel Temporal queries (server.ts:230-237). Strip transcripts from list views; fetch them only when a drawer opens.

8. The WebSocket broadcast has no backpressure: no bufferedAmount check, and each event is JSON.stringify'd once per client (server.ts:94-100). A stalled browser tab grows the send buffer in the Node heap without bound. Serialize once, skip/close clients whose buffer exceeds a threshold.

Tier 4 — cheap worker knobs

9. Set reuseV8Context: true in Worker.create (worker.ts:42-51). It's the single biggest untuned memory lever: without it each of the up-to-20 cached workflows holds its own V8 isolate; with it they share one context. Given the file's own "keep one worker small" comment, this looks like an oversight rather than a choice.

10. The external-package bundle only grows: WorkflowManager.external is never pruned and every refresh rebundles every version ever installed (manager.ts:38, :111, :139) — store.retire exists but is never called. During a worker roll, two full bundles are resident at once. Wire retirement in and cache the bundle on disk to avoid re-running webpack per install.

Tier 5 — housekeeping (lower urgency)

- 64 MB maxBuffer on every world/git execFile (worktree.ts:121, git.ts:18, container.ts:14) — bounded but multiplied by concurrency; consider 8–16 MB with streaming for known-large ops.
- Scratch repos home/scratch-<taskId> are never removed on world destroy (worktree.ts:86 vs :145-152) — permanent disk leak per no-repo task.
- The persistent dev-server's SQLite gets no retention config and is never pruned (dev-server.ts:105-128); combined with #5's quadratic histories it grows fast across restarts.
- Codex stderr is concatenated unbounded for a whole turn (codex.ts:216); the Claude API path's messages[] is bounded only by the 1000-iteration backstop.
- Small unbounded maps: gateway sessions (no TTL, server.ts:64), healed set in main.ts:128, memory-provider roots never deleted on destroy; in the UI, drawerEvents and the liveOutput string grow unbounded while a drawer is open.

If you want a suggested order of work: #1 + #2 together are one coherent "host agent capacity + kill custody" change and directly prevent a repeat of the OOM; #9 and #3 are near-free wins you could land the same day; #4–#6 are a second project ("bound the growth paths") worth doing before any long goal-mode task runs for days. I've saved the full ranked findings to memory so we can work through them across sessions. Want me to start on the agent-slot lease + kill custody?
