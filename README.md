# karmax

An agent-orchestration platform centered on a todo list. Every unit of work — a
coding change, a script run, a real-world action — is a **task** on a list, run
by a durable **workflow**, carried out by a human or an agent. Built on
[Temporal](https://temporal.io) for crash-proof orchestration, end-to-end
TypeScript.

This is a faithful v1 implementation of the karmax spec, which lives in the project wiki as the `SPEC` page (open the **Wiki** tab in the console, or fetch it with `read_wiki`).

## Quick start

```bash
npm install
npm start          # boots Temporal (SQLite) + worker + gateway, prints a URL
```

Then open the printed `http://127.0.0.1:<port>` (ports are chosen dynamically —
nothing is hardcoded).

### Use Karmax from your phone

For a local installation, install [Tailscale](https://tailscale.com/download) on
the Karmax computer and your phone, then sign in to the same tailnet. In Karmax,
open **Organization settings → Phone Access** and choose **Set up Tailscale**.
Karmax guides you through system authorization, Tailscale login, and private
HTTPS approval, then shows the private `https://….ts.net` address to open on
your phone. It stays bound to localhost; Tailscale Serve supplies private HTTPS
and never exposes it to the public internet. Exact terminal commands remain
available as a fallback.

For hosted Karmax, open its normal `https://karmax.example.com` address on the
phone and sign in. In either case, choose **Add Karmax to this phone** in the
same Access card (or use the browser's **Add to Home Screen**) for a standalone
app-like window. A Karmax-specific iOS or Android app is not required; the
responsive installable web app provides the full task, review, and check-in UI.
The Tailscale mobile app is only needed for a private local installation.

If the private address does not open, first disconnect any other VPN on the
computer and phone, reconnect Tailscale, and retry. Android and iOS allow only
one active VPN. On Android, also make sure the browser is not excluded under
Tailscale's **App-based split tunneling** settings. A browser reporting DNS or
“name not found” may be bypassing Tailscale's private DNS; set Android Private
DNS to **Automatic**, temporarily disable the browser's Secure DNS setting, and
reconnect Tailscale. Keep the Karmax computer awake with Karmax running.

To host the complete HTTPS control plane on a VPS, install Docker and run:

```bash
./deploy/karmax up karmax.example.com
```

It generates and retains all deployment secrets and starts PostgreSQL, Temporal,
Karmax, and Caddy. GitHub, E2B, and Daytona are connected from Organization
settings after the first login—no environment-file editing or SSH-based repo
setup. See [the hosted deployment guide](deploy/README.md) for DNS, backups,
upgrades, remote-world cost policy, and the laptop↔cloud Git handoff.

**Requirements**

- Node ≥ 22 (uses the built-in `node:sqlite`).
- On Linux, `flock` from `util-linux` (included in the Docker image) enforces one app process per data home and releases automatically after a crash or container replacement.
- The [Temporal CLI](https://temporal.io/setup/install-temporal-cli) at
  `~/.temporalio/bin/temporal` (or set `TEMPORAL_CLI`). `npm start` runs the dev
  server for you.
- A coding-agent login or API key for real work. Connect and choose agents in
  **Settings**; each task role can use Claude, Codex, or OpenCode, and a fallback
  provider is used only when a role has not explicitly selected one. OpenCode is
  supported over stable ACP and can run Kimi, Gemini, Grok, and other models,
  including supported subscription logins. With no usable credential, karmax
  runs a **mock agent** and prints a loud warning — it will not do real work.
- Docker (optional) for the container world provider.

To do real work, open **Settings**, point the project at a git repo directory,
then add a task. The agent runs in an isolated git worktree and its work is
merged into your target branch.

Branch existence is checked during workspace setup, before agent work starts.
If the requested base is missing, setup uses the remote's default branch (or
local HEAD's named branch for local worktrees), records the actual base, and
shows a warning in the task conversation. A target matching the missing base
moves with it; a separately selected target is preserved. A missing separate
remote target fails setup with an actionable error.

## What's implemented (SPEC v1)

| Area | Status |
|---|---|
| Durable execution on **Temporal** (activity/workflow split, signals, queries, updates, child workflows, continue-as-new) | ✅ real dev server, dynamic ports |
| Workflows: **software-dev ↔ goal** (switchable in-flight), **merge-only**; legacy just-do/script-exec replay | ✅ |
| Coordinators (lease pattern, crash-safe, continue-as-new): **merge-queue, token/account, budget** | ✅ |
| Per-turn agent loop with session resume; provider adapters: **Claude (Agent SDK + Messages API), Codex (app-server/OpenAI), OpenCode (ACP), mock** | ✅ |
| Worlds: **local git worktree**, **Docker**, **E2B**, and **Daytona**, with checkpoint/park/hibernate lifecycle | ✅ |
| Capability model + attenuation + **workflow-minted scoped tokens**; **platform MCP server** (permission-checked) | ✅ |
| **Credential broker** (vault-backed, AES-GCM at rest, JIT, scoped, audited; handles only) | ✅ |
| **PR-test-approve gate** via merge-only (dogfooded) | ✅ |
| Gateway (HTTP → signal/query/update) + WebSocket live stream + karmax's own auth | ✅ |
| Contribution system: slots, declared event schemas, command/keymap registry; generic auto-render floor + sandboxed iframe | ✅ |
| Core UI: task list, task drawer w/ stage pipeline, merge-queue, settings, insights, notifications, keyboard nav, command palette | ✅ |
| Config homes per (account × profile) + scrubbed env | ✅ |
| Virtual-card **budget lease** (hard cap + review-gate threshold) | ✅ |
| Cheap check-in: **PTY terminal** in the world (WebSocket) + transcript view | ✅ |
| Immutable defaults + overlay resolution + per-workflow fallback | ✅ |
| Hosted control plane: organizations/teams/RBAC, GitHub App onboarding, runner pools, isolated previews, backup/restore, one-command VPS stack | ✅ |

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
npm test          # local Temporal, git and fakes; paid live suites opt in separately
npm run typecheck
```

Integration tests boot a real Temporal dev server + Worker, so the suite runs
**sequentially, one server at a time**, and the Worker is resource-capped — don't
re-enable parallelism on a memory-constrained machine. See **[TESTING.md](./TESTING.md)**
for how to run a subset cheaply, the live-agent/Docker tests, and clearing stray
Temporal processes.

Paid live suites require an explicit opt-in and their provider credentials:

```bash
KARMAX_RUN_LIVE=1 OPENAI_API_KEY=… npx vitest run tests/live-agent.test.ts
```

## Operating notes

- `npm run reset` wipes Temporal's durable state + karmax local state. Run it
  only on a stopped disposable development installation. Worlds/worktrees are preserved.
- First boot asks you to create the administrator account; every later browser
  session uses Better Auth login. **Never** expose local Karmax through Funnel
  or a naked public tunnel; use the built-in private Tailscale Serve setup.
- `KARMAX_HOME` overrides the data home (default `~/.karmax`).
