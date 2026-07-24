# karmax

An agent-orchestration platform centered on a todo list. Every unit of work — a
coding change, a script run, a real-world action — is a **task** on a list, run
by a durable **workflow**, carried out by a human or an agent. Built on
[Temporal](https://temporal.io) for crash-proof orchestration, end-to-end
TypeScript.

This is a faithful v1 implementation of [`SPEC.md`](./SPEC.md).

## Quick start

```bash
npm install
npm start          # boots Temporal (SQLite) + worker + gateway, prints a URL
```

Then open the printed `http://127.0.0.1:<port>` (ports are chosen dynamically —
nothing is hardcoded).

**Requirements**

- Node ≥ 22 (uses the built-in `node:sqlite`).
- The [Temporal CLI](https://temporal.io/setup/install-temporal-cli) at
  `~/.temporalio/bin/temporal` (or set `TEMPORAL_CLI`). `npm start` runs the dev
  server for you.
- A coding-agent credential for real work (auto-detected, in order):
  `ANTHROPIC_API_KEY` → a Claude Code login (`~/.claude/.credentials.json`, via
  the Claude Agent SDK) → `OPENAI_API_KEY` (Codex) → an OpenCode login or
  `KIMI_API_KEY` (OpenCode with its default Kimi model). OpenCode is supported
  over stable ACP; Kimi, Gemini, and Grok models are available through it, and
  its isolated homes can connect supported SuperGrok subscriptions.
  With none, karmax runs a
  **mock agent** and prints a loud warning — it will not do real work.
- Docker (optional) for the container world provider.

To do real work, open **Settings**, point the project at a git repo directory,
then add a task. The agent runs in an isolated git worktree and its work is
merged into your target branch.

## What's implemented (SPEC v1)

| Area | Status |
|---|---|
| Durable execution on **Temporal** (activity/workflow split, signals, queries, updates, child workflows, continue-as-new) | ✅ real dev server, dynamic ports |
| Workflows: **software-dev, just-do, script-exec, goal, merge-only** | ✅ |
| Coordinators (lease pattern, crash-safe, continue-as-new): **merge-queue, token/account, budget** | ✅ |
| Per-turn agent loop with session resume; provider adapters: **Claude (Agent SDK), Codex (app-server), OpenCode (ACP), mock** | ✅ |
| Worlds: **local git worktree** + **Docker container**, swappable provider interface | ✅ |
| Capability model + attenuation + **workflow-minted scoped tokens**; **platform MCP server** (permission-checked) | ✅ |
| **Credential broker** (vault-backed, AES-GCM at rest, JIT, scoped, audited; handles only) | ✅ |
| **PR-test-approve gate** via merge-only (dogfooded) | ✅ |
| Gateway (HTTP → signal/query/update) + WebSocket live stream + karmax's own auth | ✅ |
| Contribution system: slots, declared event schemas, command/keymap registry; generic auto-render floor + sandboxed iframe | ✅ |
| Core UI: task list, task drawer w/ stage pipeline, merge-queue, settings, dashboard, notifications, keyboard nav, command palette | ✅ |
| Config homes per (account × profile) + scrubbed env | ✅ |
| Virtual-card **budget lease** (hard cap + review-gate threshold) | ✅ |
| Cheap check-in: **PTY terminal** in the world (WebSocket) + transcript view | ✅ |
| Immutable defaults + overlay resolution + **global safe mode** + per-workflow fallback | ✅ |
| Remote access guidance (Tailscale / Cloudflare Tunnel) | ✅ |

## Architecture

- `src/temporal/` — dev-server boot (dynamic ports), worker, client. Workflows
  are bundled into Temporal's deterministic sandbox.
- `src/workflows/` — deterministic orchestration (the **definitions**). Only
  `await` engine primitives here; every side effect is an activity.
- `src/coordinators/` — singleton lease coordinators (merge-queue, account, budget).
- `src/activities/` — the side-effecting work (worlds, agent turns, merges, …).
- `src/agent/` — provider adapters + the per-turn runtime + prompt assembly.
- `src/world/` — the world provider interface + worktree/container/memory backends.
- `src/platform/` — capabilities, scoped tokens, the `KarmaxApi` service layer, the MCP server.
- `src/autonomy/` — credential broker + vault, config homes.
- `src/gateway/` — HTTP/WebSocket gateway (the only thing the UI talks to).
- `src/store/` — SQLite metadata index + safe-mode overlays.
- `web/` — the single-page console (no build step).

## Testing

```bash
npm test          # 55 tests: real Temporal, real git, mock agent (hermetic)
npm run typecheck
```

Integration tests boot a real Temporal dev server + Worker, so the suite runs
**sequentially, one server at a time**, and the Worker is resource-capped — don't
re-enable parallelism on a memory-constrained machine. See **[TESTING.md](./TESTING.md)**
for how to run a subset cheaply, the live-agent/Docker tests, and clearing stray
Temporal processes.

The live-agent test runs only when an API key is present:

```bash
OPENAI_API_KEY=… npx vitest run tests/live-agent.test.ts
```

## Operating notes

- `npm run reset` wipes Temporal's durable state + karmax local state. Use it if
  the dev server wedges after you edit workflow code (running singletons replay
  old history against new code). Worlds/worktrees are preserved.
- First boot asks you to create the administrator account; every later browser
  session uses Better Auth login. **Never** expose karmax on a naked public
  tunnel — keep it behind Tailscale or Cloudflare Access as defense in depth.
- `KARMAX_HOME` overrides the data home (default `~/.karmax`).
