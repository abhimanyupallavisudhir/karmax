# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

karmax is an agent-orchestration platform centered on a todo list, built on Temporal for durable execution, TypeScript end-to-end. **The karmax spec — the `SPEC` page in the project wiki (open the Wiki tab, or `read_wiki`) — is the source of truth** for design decisions and rationale; the `PLAN*` wiki pages are feature design plans layered on top of it. Both live **only** in the wiki — there are deliberately no `SPEC.md`/`PLAN-*.md` copies in the repo, because duplicates drift (they did, and contradicted each other). Edit the wiki page; never reintroduce a repo copy. Runs on Node ≥ 22 (uses built-in `node:sqlite`) and needs the Temporal CLI at `~/.temporalio/bin/temporal` (or `TEMPORAL_CLI`).

## Philosophy

karmax is built on three convictions (from the spec's §0):

- **Everything is a todo list.** The development environment of the AI era is a fancy todo list. Every unit of work — a coding change, a script run, a real-world action, even setting up the system itself — is a **task** on a list, assignable to a human or an agent. There is no second organizing abstraction competing with the task list.
- **Self-healing infrastructure.** Agents can repair task code, propose platform changes through ordinary release review, and save skills. Built-in workflows change only with platform releases. External workflow code is a trusted self-hosted extension requiring explicit installation; hosted deployments must never load it into the shared worker. The system is designed to get more reliable through use.
- **Whatever can be automated, should be.** Human attention is the scarcest resource. Errors are resolved automatically before a human is asked. Agents register accounts, log in, drive browsers, and pay for services within bounded budgets. A human is pulled in only at genuine decision points (review gates, irreversible actions, spending above a threshold) — never for mechanical work the system could do itself.

## Commands

```bash
npm start                                     # boot Temporal (SQLite) + worker + gateway, prints UI URL
npm run dev                                   # same, with tsx watch
npm test                                      # full suite — sequential by design, see below
npm run typecheck
npx vitest run tests/store.test.ts            # one file
npx vitest run tests/pipeline.test.ts -t "merge queue"   # one test
npm run reset                                 # wipe Temporal durable state + karmax local state (worlds/worktrees preserved)
```

## Testing rules (important)

Integration test files each boot a **real** Temporal dev server + Worker (via `tests/helpers/harness.ts` — real Temporal, real git, mock agent). `vitest.config.ts` forces sequential single-process execution (`singleFork`, `fileParallelism: false`, `maxConcurrency: 1`) and the Worker is resource-capped in `src/temporal/worker.ts`. **Do not re-enable parallelism** — several concurrent Temporal servers + workers can exhaust RAM and freeze the machine. CI parallelizes across machines instead: it splits the files between runners with Vitest's `--shard`, each still sequential (see TESTING.md).

- Cheap files (no Temporal server, iterate freely): `ports`, `store`, `world`, `merge`, `security`, `mcp`, `overlays`, `repo-path`.
- Heavy files (boot a Temporal server, one at a time): `temporal`, `pipeline`, `workflows`, `gateway`, `autonomy`, `live-agent`.
- `tests/live-agent.test.ts` runs only with a real API key and spends real tokens; force-skip with `KARMAX_SKIP_LIVE=1`.
- `tests/container.test.ts` needs Docker (`node:22-slim`); self-skips, or force with `KARMAX_SKIP_DOCKER=1`.

If a test run is interrupted, an ephemeral Temporal dev-server child may be orphaned: `pgrep -af 'temporal server start-dev'`. Careful with `pkill -f 'temporal server start-dev'` — it also kills the app's shared long-lived dev server (a systemd user unit `karmax-temporal-*` when available; a running app auto-respawns it at the same address). Stop the app with Ctrl-C — the shared Temporal server intentionally stays up for the next boot (`npm run reset` stops and wipes it) — never by killing the port.

## Architecture

The load-bearing constraint: **workflows are deterministic, activities do the side effects.**

- `src/workflows/` + `src/coordinators/` run inside Temporal's deterministic sandbox. They may only await engine primitives (activities, timers, signals, queries, updates, child workflows) and do pure computation. No Node-only imports — workflow code imports types only through `src/workflows/contract.ts` (pure type re-exports of `src/domain/types.ts`). Every side effect (LLM calls, git, I/O, clocks, randomness) goes through an activity in `src/activities/`.
- `src/workflows/index.ts` is the worker's bundle entry. Workflows are also exported under version-qualified names (`export { softwareDev as 'softwareDev@1.0.0' }`) — an execution records its type at start and replays it forever; that string export is the per-execution version pin. Bare names remain for back-compat.
- Editing workflow code can break replay for in-flight executions (running singletons replay old history against new code) — if the dev server wedges after workflow edits, `npm run reset`.

Layers around that core:

- `src/temporal/` — dev-server boot (dynamic ports, one long-lived server **reused** across restarts — spawning a fresh one per reload against the same SQLite file wedges Temporal; spawned as a transient systemd user unit so closing the terminal that booted it can't kill it, health-watched and auto-respawned at the same address if it dies mid-run), worker, client, `worker-pool.ts` (managed worker that can be rolled to pick up newly installed workflow packages without a restart).
- `src/coordinators/` — singleton lease coordinators (merge-queue, account/token, budget): the pattern for all resource contention; crash-safe via continue-as-new.
- `src/agent/` — provider adapters (Claude Agent SDK + Messages API, Codex/OpenAI, mock) + the per-turn runtime with session resume + prompt assembly. With no credentials, karmax runs the mock agent (auto-detect order: `ANTHROPIC_API_KEY` → Claude Code login → `OPENAI_API_KEY`).
- `src/world/` — world provider interface; worktree (isolated git worktree per task), container (Docker), memory backends. Merges land through `src/world/merge.ts` and the merge-queue coordinator.
- `src/platform/` — capability model, workflow-minted scoped tokens, the `KarmaxApi` service layer, and the permission-checked platform MCP server (the single API agents use to act on the system).
- `src/packages/` — trusted self-hosted workflow packages: git repo → data-only `manifest.json` → code bundled into the worker; installed versions are pinned by commit SHA. Installation is global authority, not organization authority. Hosted install and restore are disabled; merging an edit never activates code automatically.
- `src/autonomy/` — credential broker + AES-GCM vault (secrets move as handles, never plaintext), config homes per (account × profile), logins, payments.
- `src/gateway/` — HTTP/WebSocket gateway translating requests into Temporal signal/query/update calls; the **only** thing the UI talks to.
- `src/store/` — SQLite metadata index + safe-mode overlays.
- `web/` — single-page console with **no build step**; edit `app.js`/`index.html`/`styles.css` directly.

## Environment variables

`KARMAX_HOME` (data home, default `~/.karmax`), `KARMAX_PASSWORD` (require login), `KARMAX_SAFE_MODE`, `KARMAX_TEMPORAL_LOG=debug` (worker logs), worker caps `KARMAX_MAX_CACHED_WORKFLOWS` / `KARMAX_MAX_WFT` / `KARMAX_MAX_ACT`, provider overrides `KARMAX_AGENT_PROVIDER` / `KARMAX_CLAUDE_MODEL` / `KARMAX_OPENAI_MODEL`. The test harness isolates all state in `mkdtemp` dirs (worlds, vault, config homes) — never touches the real `~/.karmax`.

**Host admission control for agent turns** (memory-based backpressure, karmax#4 — prevents the OOM killer from SIGKILLing an agent under memory pressure; see `src/activities/agent-slots.ts`):

- **Global settings → Host capacity → Concurrent agent turns** (default `3`) — max concurrent agent-turn model subprocesses, enforced by the durable/reorderable `agent-queue` coordinator. This is a dedicated cap *distinct* from the worker's `KARMAX_MAX_ACT` (which gates all activities together and scales with cores) and per-login concurrency. `KARMAX_MAX_AGENT_SLOTS` is retained only for replay-compatible admission of historical workflow executions that predate stable turn IDs.
- `KARMAX_AGENT_MIN_FREE_MB` (default `512`) — admission backs off (a new turn waits, heartbeating) while free host memory is below this floor. `0` disables the check.
- `KARMAX_AGENT_MAX_LOAD_FACTOR` (default `1.0`) — admission also backs off while the 1-minute load average exceeds `cores × factor`. `0` disables the check (and it is naturally inert on platforms that report loadavg `0`, e.g. Windows).

A signal-9/SIGKILL agent kill is classified as a retryable environmental failure (`agent-infra`) that retries and resumes the session, with an actionable message *branched on live host memory* rather than the raw signal string: if RAM is genuinely tight it names the OOM killer and says to reduce Concurrent agent turns / free RAM (the gated retry then waits for RAM to recover); if memory is healthy it says the kill was NOT OOM — most likely a karmax restart/reload teardown (`src/agent/custody.ts`) or an external kill. The message deliberately does not hard-code an OOM cause: the confirmed sender in the 2026-07 incident was `reapOrphans()` after a `tsx watch` reload (journalctl/oomd logged zero kernel kills), not the OOM killer — so `npm start` (no watcher) avoids the self-merge→reload→orphan-sweep loop that `npm run dev` creates. A second confirmed sender (2026-07-12, after the karmax#3 world-boot guard was disabled): an agent booted a dogfooding karmax from its task world against the prod `KARMAX_HOME`, and that boot's `reapOrphans()` SIGKILLed prod's live agents — including the agent that booted it. Fixed: `reapOrphans()` treats a record as an orphan only if its recorded `owner` process is dead. Booting a second `src/main.ts` against the same `KARMAX_HOME` is refused: concurrent workers can steal activities under divergent code, duplicate agent fan-out, and break workflow coherence.
